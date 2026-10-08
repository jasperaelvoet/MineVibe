import { createHash, randomBytes } from 'node:crypto';
import type { SpacesdClientLike, SpacesdProcessLike } from '@trycua/cua';
import type { Logger } from 'pino';
import { ApiError, isApiError } from '../contracts/common.js';
import {
  type EditRequest,
  type ExecRequest,
  type ExecResult,
  type GlobRequest,
  type GrepRequest,
  type GrepResult,
  type JobOutput,
  type KeyboardAction,
  PC_ERROR_CODES,
  PC_LIMITS,
  type PcApi,
  type PcGuestInfo,
  type PointerAction,
  type ReadRequest,
  type ReadResult,
  type Screenshot,
} from '../contracts/PcApi.js';
import { DeadlineError, withDeadline } from './deadline.js';
import {
  absolutePaths,
  anchorGlob,
  applyEdit,
  EDIT_MAX_BYTES,
  EDIT_READ_SCRIPT,
  EDIT_WRITE_SCRIPT,
  EXEC_PREFIX,
  exitCodeOf,
  formatRgJson,
  GLOB_LIMIT,
  GLOB_SCRIPT,
  GREP_SCRIPT,
  GUEST_DISPLAY,
  GUEST_HOME,
  GUEST_USER,
  grepArgs,
  JobBuffer,
  mirrorPrompt,
  OutputCapture,
  parseRgCount,
  READ_MAX_BYTES,
  READ_SCRIPT,
  SCRIPT_EXIT,
  SWEEP_LAUNCH,
  SWEEP_SCRIPT,
  splitGlob,
  WRITE_MAX_BYTES,
  WRITE_SCRIPT,
} from './guest.js';
import { InputError, type InputRouter, type RouterEvent } from './InputRouter.js';
import type { PcRecord, PcStatusInfo } from './PcManager.js';
import { PC_TYPE_SPECS } from './PcTypes.js';
import { type SeatBook, seatTag, tagAgent } from './SeatBook.js';

/**
 * PcApi on real PCs (PLAN §6.2, §8): the guest capability under the `pc` MCP tool server. Every file and shell
 * operation runs inside the guest through spacesd as the unprivileged `cua` user; the host never opens a path an
 * agent controls. Paths and patterns reach the guest scripts as arguments, never spliced into a script.
 *
 * - Input (pointer, keyboard, type) goes through the PC's InputRouter queue as the seated agent, so the player's
 *   occupancy wins and held keys are released on every occupant change. Mutating calls (input, clipboard set, exec,
 *   write, edit) need an agent in the chair; `exec` needs the agent of its `agentId:seatEpoch` tag.
 * - `exec` spawns `bash -lc` with `MV_TAG` (the tag) and `MV_CALL` in the environment: processes a command leaves
 *   behind inherit them, so a kill by tag or a timeout sweeps them too. Output keeps head and tail within 30 000
 *   characters. Background jobs belong to their `agentId:seatEpoch`: another occupant (or the same agent after a
 *   new sit) cannot read or kill them.
 */

export interface PcGuestApiOptions {
  /** PC records and statuses (PcManager). */
  readonly pcs: {
    get(id: string): PcRecord | undefined;
    status(id: string): PcStatusInfo;
  };
  /** The connected spacesd client of a running PC (SpacesdPool.client). */
  readonly client: (pcId: string) => Promise<SpacesdClientLike>;
  readonly router: InputRouter;
  readonly seats: SeatBook;
  /** `ImageFormat.Jpeg` of the loaded cua module. */
  readonly jpegFormat: () => number;
  readonly logger?: Logger;
  /** Deadline of one guest script (file ops; default 60 s). */
  readonly scriptTimeoutMs?: number;
  /** Deadline of a screenshot, clipboard or display call (default 8 s). */
  readonly callTimeoutMs?: number;
  /** Characters of output kept per background job (default 1 000 000). */
  readonly jobBufferChars?: number;
}

interface Job {
  readonly id: string;
  readonly pcId: string;
  readonly tag: string;
  readonly callId: string;
  readonly buffer: JobBuffer;
  readonly abort: AbortController;
  proc: SpacesdProcessLike | null;
  running: boolean;
  exitCode: number | null;
  readonly startedAt: number;
  endedAt: number | null;
}

interface Foreground {
  readonly pcId: string;
  readonly tag: string;
  readonly proc: SpacesdProcessLike;
}

interface ScriptResult {
  code: number;
  stdout: Buffer;
  stderr: string;
  timedOut: boolean;
}

const MAX_JOBS_PER_PC = 32;
/** Bytes per `writeStdin` call. */
const STDIN_CHUNK = 512 * 1024;
const TAG_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}:\d{1,12}$/;
const enc = new TextEncoder();

function err(code: string, message: string): ApiError {
  return new ApiError(code, message);
}

function bytesOf(b: ArrayBuffer | Uint8Array): Buffer {
  return Buffer.from(b instanceof Uint8Array ? b : new Uint8Array(b));
}

function tail(s: string, n = 300): string {
  // bash prefixes its own errors with the script name and line ("guest: line 5: /x: Read-only file system").
  const t = s.replace(/^guest: line \d+: /gm, '').trim();
  return t.length > n ? `…${t.slice(t.length - n)}` : t;
}

/** Maps a guest script's exit to a PcApi error (null: not an error code of the scripts). */
function scriptError(r: ScriptResult, path: string): ApiError | null {
  switch (r.code) {
    case SCRIPT_EXIT.NOT_FOUND:
      return err(PC_ERROR_CODES.NOT_FOUND, `no such file or directory: ${path}`);
    case SCRIPT_EXIT.NOT_A_FILE:
      return err(PC_ERROR_CODES.NOT_A_FILE, `${path} is a directory`);
    case SCRIPT_EXIT.DENIED: {
      const why = tail(r.stderr) || 'permission denied (or a read-only folder)';
      // The shell's own message usually names the path already.
      return err(PC_ERROR_CODES.DENIED, why.includes(path) ? why : `${path}: ${why}`);
    }
    case SCRIPT_EXIT.BINARY:
      return err(PC_ERROR_CODES.NOT_A_FILE, `${path} is a binary file; inspect it with bash (file, xxd, …)`);
    case SCRIPT_EXIT.TOO_LARGE:
      return err(
        PC_ERROR_CODES.DENIED,
        `${path} is larger than ${EDIT_MAX_BYTES / 1024 / 1024} MB; change it with bash instead`,
      );
    case SCRIPT_EXIT.CHANGED:
      return err(
        PC_ERROR_CODES.GUEST_ERROR,
        `${path} changed while it was being edited; read it again and retry`,
      );
    default:
      return null;
  }
}

export class PcGuestApi implements PcApi {
  readonly #o: PcGuestApiOptions;
  readonly #log: Logger | undefined;
  readonly #jobs = new Map<string, Job>();
  readonly #foreground = new Map<string, Foreground>();
  readonly #screens = new Map<string, { w: number; h: number }>();
  readonly #osVersions = new Map<string, string>();
  readonly #scriptTimeoutMs: number;
  readonly #callTimeoutMs: number;
  #disposed = false;

  constructor(options: PcGuestApiOptions) {
    this.#o = options;
    this.#log = options.logger;
    this.#scriptTimeoutMs = options.scriptTimeoutMs ?? 60_000;
    this.#callTimeoutMs = options.callTimeoutMs ?? 8_000;
  }

  // ------------------------------------------------------------------------------------------- PC state

  #record(pcId: string): PcRecord {
    const rec = this.#o.pcs.get(pcId);
    if (!rec || rec.type === 'windows') throw err(PC_ERROR_CODES.PC_UNKNOWN, `there is no PC called ${pcId}`);
    return rec;
  }

  /** The client of a running PC; PC_UNKNOWN / PC_DOWN otherwise. */
  async #running(pcId: string): Promise<SpacesdClientLike> {
    this.#record(pcId);
    const st = this.#o.pcs.status(pcId);
    if (st.status !== 'running') {
      throw err(PC_ERROR_CODES.PC_DOWN, `${pcId} is ${st.status}${st.detail ? ` (${st.detail})` : ''}`);
    }
    try {
      return await this.#o.client(pcId);
    } catch (e) {
      throw err(
        PC_ERROR_CODES.PC_DOWN,
        `${pcId} does not answer: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  /** The agent sitting at the PC; DENIED when the player or nobody sits there. */
  #seatedAgent(pcId: string): { agentId: string; seatEpoch: number | null } {
    const agent = this.#o.seats.agentAt(pcId);
    if (agent) return agent;
    if (this.#o.seats.playerAt(pcId)) {
      throw err(PC_ERROR_CODES.DENIED, `the player sits at ${pcId}; wait until they stand up`);
    }
    throw err(PC_ERROR_CODES.DENIED, `nobody sits at ${pcId}; sit down first`);
  }

  /** The owner tag of the PC's current seat (`agentId:seatEpoch`), or null. */
  #ownerTag(pcId: string): string | null {
    const a = this.#o.seats.agentAt(pcId);
    return a ? seatTag(a.agentId, a.seatEpoch) : null;
  }

  /**
   * Whether the seat `tag` still holds the PC: its agent sits there with that epoch (or an unknown one), or is away
   * from the chair asking the player (the seat and its processes live on).
   */
  #seatOwns(pcId: string, tag: string): boolean {
    const agentId = tagAgent(tag);
    const s = this.#o.seats.get(pcId);
    if (s.occupant?.kind === 'agent' && s.occupant.agentId === agentId) {
      return s.occupant.seatEpoch === null || seatTag(agentId, s.occupant.seatEpoch) === tag;
    }
    return s.occupant === null && s.reservation?.kind === 'away' && s.reservation.agentId === agentId;
  }

  // ------------------------------------------------------------------------------------------- info

  async info(pcId: string): Promise<PcGuestInfo> {
    const rec = this.#record(pcId);
    const status = this.#o.pcs.status(pcId).status;
    const family = PC_TYPE_SPECS[rec.type].family;
    const screen = await this.#screen(pcId, status === 'running');
    const osVersion = status === 'running' ? await this.#osVersion(pcId) : null;
    return {
      pcId,
      type: rec.type as PcGuestInfo['type'],
      status,
      os: family === 'macos' ? 'macos' : 'linux',
      screen,
      user: GUEST_USER,
      home: GUEST_HOME,
      mounts: rec.mounts.map((m) => ({ hostPath: m.host, mode: m.ro ? ('ro' as const) : ('rw' as const) })),
      codexPath: null,
      cpus: rec.cpus,
      memoryMiB: rec.memMiB,
      ...(osVersion ? { osVersion } : {}),
    };
  }

  /** The guest display size: measured once per boot (spacesd `displays`), else the type's default. */
  async #screen(pcId: string, ask: boolean): Promise<{ w: number; h: number }> {
    const known = this.#screens.get(pcId);
    if (known) return known;
    const rec = this.#record(pcId);
    const [w, h] = PC_TYPE_SPECS[rec.type].display;
    if (!ask) return { w, h };
    try {
      const c = await this.#o.client(pcId);
      const json = await withDeadline(this.#callTimeoutMs, 'displays', (signal) => c.displays({ signal }));
      const list = JSON.parse(json) as { primary?: boolean; bounds?: { width?: number; height?: number } }[];
      const d = list.find((x) => x.primary) ?? list[0];
      const bw = Math.round(d?.bounds?.width ?? 0);
      const bh = Math.round(d?.bounds?.height ?? 0);
      if (bw > 0 && bh > 0) {
        const s = { w: bw, h: bh };
        this.#screens.set(pcId, s);
        this.#o.router.setDisplay(pcId, bw, bh);
        return s;
      }
    } catch (e) {
      this.#log?.debug({ pcId, err: String(e) }, 'display query failed; using the default size');
    }
    return { w, h };
  }

  async #osVersion(pcId: string): Promise<string | null> {
    const known = this.#osVersions.get(pcId);
    if (known) return known;
    try {
      const c = await this.#o.client(pcId);
      const caps = await withDeadline(this.#callTimeoutMs, 'capabilities', (signal) =>
        c.capabilities({ signal }),
      );
      const v = `${caps.osName} ${caps.osVersion}`.trim();
      if (v) this.#osVersions.set(pcId, v);
      return v || null;
    } catch {
      return null;
    }
  }

  /** Forgets what was measured about a PC's guest (it stopped, was recreated or reimaged). */
  forgetGuest(pcId: string): void {
    this.#screens.delete(pcId);
    this.#osVersions.delete(pcId);
  }

  // ------------------------------------------------------------------------------------------- screen and input

  async screenshot(pcId: string, options: { maxDim?: number | undefined } = {}): Promise<Screenshot> {
    const c = await this.#running(pcId);
    const screen = await this.#screen(pcId, true);
    const maxDim = Math.round(Math.min(2560, Math.max(320, options.maxDim ?? Math.max(screen.w, screen.h))));
    let shot: Awaited<ReturnType<SpacesdClientLike['screenshot']>>;
    try {
      shot = await withDeadline(this.#callTimeoutMs, 'screenshot', (signal) =>
        c.screenshot(
          { format: this.#o.jpegFormat(), quality: 80, maxDimension: maxDim, includeCursor: true },
          { signal },
        ),
      );
    } catch (e) {
      throw err(
        PC_ERROR_CODES.GUEST_ERROR,
        `screenshot failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    return {
      mime: 'image/jpeg',
      data: new Uint8Array(shot.image),
      w: shot.width,
      h: shot.height,
      screen,
      scale: screen.w > 0 ? shot.width / screen.w : 1,
    };
  }

  async pointer(pcId: string, action: PointerAction): Promise<void> {
    const events: RouterEvent[] = [];
    switch (action.action) {
      case 'move':
        events.push({ k: 'move', x: action.x, y: action.y });
        break;
      case 'click':
      case 'double_click':
      case 'right_click':
        events.push({
          k: 'click',
          x: action.x,
          y: action.y,
          button: action.action === 'right_click' ? 'right' : (action.button ?? 'left'),
          count: action.action === 'double_click' ? 2 : 1,
        });
        break;
      case 'down':
      case 'up':
        events.push({
          k: 'button',
          button: action.button ?? 'left',
          down: action.action === 'down',
          x: action.x,
          y: action.y,
        });
        break;
      case 'drag':
        events.push({ k: 'drag', x: action.x, y: action.y, toX: action.toX, toY: action.toY });
        break;
      case 'scroll':
        events.push({ k: 'scroll', dx: action.dx, dy: action.dy, x: action.x, y: action.y });
        break;
    }
    await this.#input(pcId, events);
  }

  async keyboard(pcId: string, action: KeyboardAction): Promise<void> {
    if (action.keys.length === 0) throw err(PC_ERROR_CODES.GUEST_ERROR, 'no keys given');
    const events: RouterEvent[] =
      action.action === 'press'
        ? [{ k: 'chord', keys: [...action.keys] }]
        : action.keys.map((key) => ({ k: 'key' as const, key, down: action.action === 'down' }));
    await this.#input(pcId, events);
  }

  async type(pcId: string, text: string): Promise<void> {
    if (text.length === 0) return;
    const events: RouterEvent[] = [];
    const cps = [...text];
    for (let i = 0; i < cps.length; i += 4096)
      events.push({ k: 'text', text: cps.slice(i, i + 4096).join('') });
    await this.#input(pcId, events);
  }

  async #input(pcId: string, events: RouterEvent[]): Promise<void> {
    await this.#running(pcId);
    const agent = this.#seatedAgent(pcId);
    try {
      await this.#o.router.perform(pcId, { kind: 'agent', id: agent.agentId }, events);
    } catch (e) {
      if (e instanceof InputError) {
        if (e.code === 'NOT_OCCUPANT')
          throw err(PC_ERROR_CODES.DENIED, `${agent.agentId} no longer sits at ${pcId}`);
        if (e.code === 'INVALID') throw err(PC_ERROR_CODES.GUEST_ERROR, e.message);
        throw err(PC_ERROR_CODES.GUEST_ERROR, `input failed: ${e.message}`);
      }
      throw e;
    }
  }

  async clipboardGet(pcId: string): Promise<string> {
    const c = await this.#running(pcId);
    try {
      return (
        (await withDeadline(this.#callTimeoutMs, 'clipboard', (signal) => c.getClipboard({ signal }))) ?? ''
      );
    } catch (e) {
      throw err(PC_ERROR_CODES.GUEST_ERROR, `reading the clipboard failed: ${String(e)}`);
    }
  }

  async clipboardSet(pcId: string, text: string): Promise<void> {
    const c = await this.#running(pcId);
    this.#seatedAgent(pcId);
    try {
      await withDeadline(this.#callTimeoutMs, 'clipboard', (signal) => c.setClipboard(text, { signal }));
    } catch (e) {
      throw err(PC_ERROR_CODES.GUEST_ERROR, `setting the clipboard failed: ${String(e)}`);
    }
  }

  // ------------------------------------------------------------------------------------------- shell

  async exec(pcId: string, request: ExecRequest): Promise<ExecResult> {
    if (!TAG_RE.test(request.tag)) throw err(PC_ERROR_CODES.DENIED, 'exec needs an agentId:seatEpoch tag');
    const c = await this.#running(pcId);
    const agent = this.#seatedAgent(pcId);
    if (tagAgent(request.tag) !== agent.agentId) {
      throw err(PC_ERROR_CODES.DENIED, `${agent.agentId} sits at ${pcId}, not ${tagAgent(request.tag)}`);
    }
    // A call from an earlier seat of the same agent (its kill sweep may already have run) never starts: its
    // processes would carry a tag nobody kills any more, and its job would belong to no current seat.
    if (agent.seatEpoch !== null && request.tag !== seatTag(agent.agentId, agent.seatEpoch)) {
      throw err(
        PC_ERROR_CODES.DENIED,
        `the seat ${request.tag} has ended; ${agent.agentId} sits at ${pcId} as ${seatTag(agent.agentId, agent.seatEpoch)}`,
      );
    }
    const timeoutMs = Math.round(
      Math.min(PC_LIMITS.maxTimeoutMs, Math.max(1_000, request.timeoutMs ?? PC_LIMITS.defaultTimeoutMs)),
    );
    const callId = randomBytes(6).toString('hex');
    const env = new Map<string, string>(Object.entries(request.env ?? {}));
    const cwd = request.cwd ?? GUEST_HOME;
    const prompt = mirrorPrompt(request.command, {
      agentId: agent.agentId,
      pcId,
      cwd: env.get('MV_CWD') ?? cwd,
    });
    for (const [k, v] of Object.entries({
      HOME: GUEST_HOME,
      USER: GUEST_USER,
      LOGNAME: GUEST_USER,
      SHELL: '/bin/bash',
      DISPLAY: GUEST_DISPLAY,
      TERM: 'dumb',
      PAGER: 'cat',
      GIT_PAGER: 'cat',
      DEBIAN_FRONTEND: 'noninteractive',
      MV_TAG: request.tag,
      MV_CALL: callId,
      MV_EXEC_CWD: cwd,
      ...(prompt ? { MV_PROMPT: prompt } : {}),
    })) {
      env.set(k, v);
    }
    const script = `${EXEC_PREFIX}\n${request.command}`;
    const preserve = 'HOME,DISPLAY,MV_TAG,MV_CALL,MV_CWD,MV_EXEC_CWD,MV_PROMPT';
    const program = request.root ? 'sudo' : 'bash';
    const args = request.root ? ['-n', `--preserve-env=${preserve}`, 'bash', '-lc', script] : ['-lc', script];
    let proc: SpacesdProcessLike;
    try {
      proc = await withDeadline(this.#callTimeoutMs, 'spawn', (signal) =>
        c.spawn(
          {
            program,
            args,
            env,
            user: GUEST_USER,
            stdin: false,
            // A backstop: Node's own timeout (and sweep) normally ends a foreground command first.
            timeoutMs: request.background ? undefined : timeoutMs + 15_000,
            tag: `mv-${callId}`,
          },
          { signal },
        ),
      );
    } catch (e) {
      // The spawn may still land after its deadline: whatever runs with this call id is swept (best effort).
      void this.sweep(pcId, 'MV_CALL', callId).catch(() => 0);
      throw err(
        PC_ERROR_CODES.GUEST_ERROR,
        `starting the command failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    if (!this.#seatOwns(pcId, request.tag)) {
      // The seat ended while the command was starting (its kill sweep may have run before the process existed).
      await this.#killCall(pcId, callId, proc);
      throw err(
        PC_ERROR_CODES.DENIED,
        `the seat ${request.tag} ended while the command started; it was killed`,
      );
    }
    if (request.background) return this.#startJob(pcId, request.tag, callId, proc);
    return this.#runForeground(pcId, request.tag, callId, proc, timeoutMs);
  }

  async #runForeground(
    pcId: string,
    tag: string,
    callId: string,
    proc: SpacesdProcessLike,
    timeoutMs: number,
  ): Promise<ExecResult> {
    const started = Date.now();
    const deadline = started + timeoutMs;
    const capture = new OutputCapture(PC_LIMITS.maxOutputChars);
    const decoder = new TextDecoder('utf-8');
    this.#foreground.set(callId, { pcId, tag, proc });
    try {
      for (;;) {
        const left = deadline - Date.now();
        if (left <= 0) throw new DeadlineError('exec', timeoutMs);
        const ev = await withDeadline(left, 'exec', (signal) => proc.nextEvent({ signal }));
        if (!ev) break;
        if (ev.exit) {
          capture.append(decoder.decode());
          if (ev.exit.error && ev.exit.code === undefined && !ev.exit.signal) {
            throw err(PC_ERROR_CODES.GUEST_ERROR, `the command could not run: ${ev.exit.error}`);
          }
          if (ev.exit.timedOut) throw new DeadlineError('exec', timeoutMs);
          return {
            kind: 'done',
            exitCode: exitCodeOf(ev.exit),
            output: capture.text(),
            truncated: capture.truncated,
            durationMs: Date.now() - started,
          };
        }
        capture.append(decoder.decode(new Uint8Array(ev.data), { stream: true }));
      }
      capture.append(decoder.decode());
      return {
        kind: 'done',
        exitCode: 0,
        output: capture.text(),
        truncated: capture.truncated,
        durationMs: Date.now() - started,
      };
    } catch (e) {
      if (e instanceof DeadlineError) {
        await this.#killCall(pcId, callId, proc);
        throw err(
          PC_ERROR_CODES.TIMEOUT,
          `timed out after ${Math.round(timeoutMs / 1000)} s; the command was killed`,
        );
      }
      if (isApiError(e)) throw e;
      await this.#killCall(pcId, callId, proc);
      throw err(
        PC_ERROR_CODES.GUEST_ERROR,
        `the command failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      this.#foreground.delete(callId);
    }
  }

  /**
   * Kills a call's process and everything it left behind (`MV_CALL`). The sweep goes first: killing the call's
   * shell first would reparent its children (a `sudo` among them) away from it before the sweep could find them by
   * parent. The process handle is killed afterwards as a backstop (counted only when the sweep could not run).
   */
  async #killCall(pcId: string, callId: string, proc: SpacesdProcessLike | null): Promise<number> {
    const swept = await this.sweep(pcId, 'MV_CALL', callId).catch(() => null);
    const byHandle = proc ? await this.#killHandle(proc) : 0;
    return swept ?? byHandle;
  }

  /** SIGKILL through spacesd; 1 when spacesd accepted it, 0 when the process was gone or the call failed. */
  async #killHandle(proc: SpacesdProcessLike): Promise<number> {
    try {
      await withDeadline(this.#callTimeoutMs, 'kill', (signal) => proc.kill({ signal }));
      return 1;
    } catch {
      return 0;
    }
  }

  #startJob(pcId: string, tag: string, callId: string, proc: SpacesdProcessLike): ExecResult {
    this.#pruneJobs(pcId);
    const id = `bg-${randomBytes(4).toString('hex')}`;
    const job: Job = {
      id,
      pcId,
      tag,
      callId,
      buffer: new JobBuffer(this.#o.jobBufferChars ?? 1_000_000),
      abort: new AbortController(),
      proc,
      running: true,
      exitCode: null,
      startedAt: Date.now(),
      endedAt: null,
    };
    this.#jobs.set(id, job);
    void this.#pumpJob(job);
    return { kind: 'background', jobId: id };
  }

  async #pumpJob(job: Job): Promise<void> {
    const decoder = new TextDecoder('utf-8');
    try {
      for (;;) {
        const proc = job.proc;
        if (!proc || job.abort.signal.aborted) break;
        const ev = await proc.nextEvent({ signal: job.abort.signal });
        if (!ev) break;
        if (ev.exit) {
          job.buffer.append(decoder.decode());
          job.exitCode = exitCodeOf(ev.exit);
          break;
        }
        job.buffer.append(decoder.decode(new Uint8Array(ev.data), { stream: true }));
      }
    } catch (e) {
      if (!job.abort.signal.aborted) {
        job.buffer.append(
          `\n[MineVibe lost track of this job: ${e instanceof Error ? e.message : String(e)}]\n`,
        );
      }
    } finally {
      job.running = false;
      job.endedAt = Date.now();
      job.proc = null;
    }
  }

  /** Drops the oldest finished jobs of a PC beyond the per-PC cap. */
  #pruneJobs(pcId: string): void {
    const done = [...this.#jobs.values()]
      .filter((j) => j.pcId === pcId && !j.running)
      .sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0));
    const count = [...this.#jobs.values()].filter((j) => j.pcId === pcId).length;
    for (let i = 0; i < count - MAX_JOBS_PER_PC + 1 && i < done.length; i++) {
      this.#jobs.delete((done[i] as Job).id);
    }
  }

  /** A job of this PC that the current seat owns; UNKNOWN_JOB for anyone else's (they are not even named). */
  #ownJob(pcId: string, jobId: string): Job {
    const job = this.#jobs.get(jobId);
    const owner = this.#ownerTag(pcId);
    if (!job || job.pcId !== pcId || owner === null || job.tag !== owner) {
      throw err(PC_ERROR_CODES.UNKNOWN_JOB, `no background job ${jobId} of yours on ${pcId}`);
    }
    return job;
  }

  async jobOutput(pcId: string, jobId: string, fromOffset = 0): Promise<JobOutput> {
    this.#record(pcId);
    const job = this.#ownJob(pcId, jobId);
    const r = job.buffer.read(Math.max(0, fromOffset), PC_LIMITS.maxOutputChars);
    const output = r.skipped ? `[… earlier output was dropped …]\n${r.text}` : r.text;
    return {
      jobId,
      running: job.running,
      exitCode: job.exitCode,
      output,
      nextOffset: r.next,
      truncated: r.more || r.skipped,
    };
  }

  async kill(pcId: string, target: { readonly jobId: string } | { readonly tag: string }): Promise<number> {
    this.#record(pcId);
    if ('jobId' in target) {
      const job = this.#ownJob(pcId, target.jobId);
      if (!job.running) return 0;
      const proc = job.proc;
      job.abort.abort();
      const n = await this.#killCall(pcId, job.callId, proc);
      job.running = false;
      job.exitCode = job.exitCode ?? 137;
      job.buffer.append('\n[killed]\n');
      return Math.max(1, n);
    }
    return this.killTag(pcId, target.tag);
  }

  /**
   * Kills everything a seat started on a PC: its background jobs, its foreground commands and every guest process
   * that carries its tag or descends from one (kick, stand-up, any unseat). The sweep goes first, while the process
   * tree is intact; the job and command handles are killed afterwards as a backstop. Never throws; returns how many
   * processes died.
   */
  async killTag(pcId: string, tag: string): Promise<number> {
    const procs: SpacesdProcessLike[] = [];
    for (const job of this.#jobs.values()) {
      if (job.pcId !== pcId || job.tag !== tag || !job.running) continue;
      if (job.proc) procs.push(job.proc);
      job.abort.abort();
      job.running = false;
      job.exitCode = job.exitCode ?? 137;
      job.buffer.append('\n[killed: the seat ended]\n');
    }
    for (const fg of this.#foreground.values()) {
      if (fg.pcId === pcId && fg.tag === tag) procs.push(fg.proc);
    }
    let swept: number | null = null;
    if (this.#o.pcs.status(pcId).status === 'running') {
      swept = await this.sweep(pcId, 'MV_TAG', tag).catch((e: unknown) => {
        this.#log?.warn({ pcId, err: String(e) }, 'guest process sweep failed');
        return null;
      });
    }
    let byHandle = 0;
    for (const proc of procs) byHandle += await this.#killHandle(proc);
    return swept ?? byHandle;
  }

  /** Kills every guest process whose environment holds `name=value`, and their descendants; returns how many. */
  async sweep(pcId: string, name: string, value: string): Promise<number> {
    const r = await this.#script(pcId, SWEEP_LAUNCH, [name, value, SWEEP_SCRIPT], { timeoutMs: 30_000 });
    const n = Number.parseInt(r.stdout.toString('utf8').trim().split('\n').at(-1) ?? '', 10);
    return Number.isFinite(n) ? n : 0;
  }

  // ------------------------------------------------------------------------------------------- files

  async readFile(pcId: string, request: ReadRequest): Promise<ReadResult> {
    const offset = Math.max(1, Math.floor(request.offset ?? 1));
    const limit = Math.max(1, Math.min(100_000, Math.floor(request.limit ?? 2000)));
    const r = await this.#script(pcId, READ_SCRIPT, [
      request.path,
      String(offset),
      String(limit),
      String(READ_MAX_BYTES),
    ]);
    const known = scriptError(r, request.path);
    if (known) throw known;
    if (r.code !== 0)
      throw err(PC_ERROR_CODES.GUEST_ERROR, `reading ${request.path} failed: ${tail(r.stderr)}`);
    const trailer = /(\d+) (\d+) (\d+)\s*$/.exec(r.stderr);
    const total = trailer ? Number(trailer[1]) : 0;
    const printed = trailer ? Number(trailer[2]) : 0;
    const cut = trailer ? trailer[3] === '1' : false;
    let content = r.stdout.toString('utf8');
    if (content.endsWith('\n')) content = content.slice(0, -1);
    return {
      content,
      startLine: offset,
      totalLines: total,
      truncated: cut || offset - 1 + printed < total,
    };
  }

  async writeFile(pcId: string, path: string, content: string): Promise<number> {
    const data = enc.encode(content);
    if (data.byteLength > WRITE_MAX_BYTES) {
      throw err(
        PC_ERROR_CODES.DENIED,
        `content over ${WRITE_MAX_BYTES / 1024 / 1024} MB; write it in parts with bash`,
      );
    }
    await this.#running(pcId);
    this.#seatedAgent(pcId);
    const r = await this.#script(pcId, WRITE_SCRIPT, [path], { stdin: data });
    const known = scriptError(r, path);
    if (known) throw known;
    if (r.code !== 0) throw err(PC_ERROR_CODES.GUEST_ERROR, `writing ${path} failed: ${tail(r.stderr)}`);
    return data.byteLength;
  }

  async editFile(pcId: string, request: EditRequest): Promise<number> {
    await this.#running(pcId);
    this.#seatedAgent(pcId);
    const read = await this.#script(pcId, EDIT_READ_SCRIPT, [request.path, String(EDIT_MAX_BYTES)]);
    const knownRead = scriptError(read, request.path);
    if (knownRead) throw knownRead;
    if (read.code !== 0)
      throw err(PC_ERROR_CODES.GUEST_ERROR, `reading ${request.path} failed: ${tail(read.stderr)}`);
    let text: string;
    try {
      if (read.stdout.includes(0)) throw new Error('NUL');
      // ignoreBOM keeps a leading byte-order mark in the text, so the write-back keeps it too.
      text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(read.stdout);
    } catch {
      throw err(PC_ERROR_CODES.NOT_A_FILE, `${request.path} is not a UTF-8 text file; change it with bash`);
    }
    const { content, count } = applyEdit(
      text,
      request.oldString,
      request.newString,
      request.replaceAll === true,
    );
    const sha = createHash('sha256').update(read.stdout).digest('hex');
    const write = await this.#script(pcId, EDIT_WRITE_SCRIPT, [request.path, sha], {
      stdin: enc.encode(content),
    });
    const knownWrite = scriptError(write, request.path);
    if (knownWrite) throw knownWrite;
    if (write.code !== 0) {
      throw err(PC_ERROR_CODES.GUEST_ERROR, `writing ${request.path} failed: ${tail(write.stderr)}`);
    }
    return count;
  }

  async glob(pcId: string, request: GlobRequest): Promise<{ paths: string[]; truncated: boolean }> {
    const base = request.path ?? GUEST_HOME;
    const split = splitGlob(request.pattern, base);
    if (split.pattern.length === 0) return { paths: [], truncated: false };
    const r = await this.#script(pcId, GLOB_SCRIPT, [
      split.dir,
      anchorGlob(split.pattern),
      String(GLOB_LIMIT + 1),
    ]);
    if (r.code === SCRIPT_EXIT.NOT_FOUND)
      throw err(PC_ERROR_CODES.NOT_FOUND, `no such directory: ${split.dir}`);
    const known = scriptError(r, split.dir);
    if (known) throw known;
    const paths = absolutePaths(r.stdout.toString('utf8'), split.dir);
    return { paths: paths.slice(0, GLOB_LIMIT), truncated: paths.length > GLOB_LIMIT };
  }

  async grep(pcId: string, request: GrepRequest): Promise<GrepResult> {
    const path = request.path ?? GUEST_HOME;
    const args = grepArgs({ ...request, path });
    const r = await this.#script(pcId, GREP_SCRIPT, args);
    const stdout = r.stdout.toString('utf8');
    // ripgrep: 0 = matches, 1 = none, 2 = an error (also when some files could not be read: keep what it found).
    if (r.code === 2 && stdout.trim().length === 0) {
      if (/No such file or directory/i.test(r.stderr))
        throw err(PC_ERROR_CODES.NOT_FOUND, `no such path: ${path}`);
      throw err(PC_ERROR_CODES.GUEST_ERROR, `rg: ${tail(r.stderr) || 'failed'}`);
    }
    if (r.code !== 0 && r.code !== 1 && r.code !== 2 && r.code !== 141) {
      throw err(PC_ERROR_CODES.GUEST_ERROR, `rg exited with ${r.code}: ${tail(r.stderr)}`);
    }
    let lines: string[];
    let matches: number;
    let truncated = r.code === 141;
    if (request.outputMode === 'content') {
      const f = formatRgJson(stdout, {
        lineNumbers: request.lineNumbers !== false,
        context: (request.before ?? 0) > 0 || (request.after ?? 0) > 0,
      });
      lines = f.lines;
      matches = f.matches;
      truncated ||= f.incomplete;
    } else if (request.outputMode === 'count') {
      ({ lines, matches } = parseRgCount(stdout));
    } else {
      lines = stdout.split('\n').filter((l) => l.length > 0);
      matches = lines.length;
    }
    const limit = request.headLimit !== undefined && request.headLimit > 0 ? request.headLimit : undefined;
    const shown = limit !== undefined ? lines.slice(0, limit) : lines;
    return { output: shown.join('\n'), matches, truncated: truncated || shown.length < lines.length };
  }

  // ------------------------------------------------------------------------------------------- scripts

  /**
   * Runs a guest bash script as `cua` with `args` as `$1…`; `stdin` is written to it. Rejects with PC_DOWN,
   * TIMEOUT or GUEST_ERROR; the script's own exit code is the caller's to read.
   */
  async #script(
    pcId: string,
    script: string,
    args: readonly string[],
    options: { timeoutMs?: number; stdin?: Uint8Array } = {},
  ): Promise<ScriptResult> {
    const c = await this.#running(pcId);
    const timeoutMs = options.timeoutMs ?? this.#scriptTimeoutMs;
    const env = new Map<string, string>([
      ['HOME', GUEST_HOME],
      ['LC_ALL', 'C.UTF-8'],
    ]);
    const command = {
      program: 'bash',
      args: ['-c', script, 'guest', ...args],
      env,
      user: GUEST_USER,
      stdin: options.stdin !== undefined,
      timeoutMs,
    };
    try {
      const out = await withDeadline(timeoutMs + 5_000, 'guest script', async (signal) => {
        if (options.stdin === undefined) return c.run(command, { signal });
        const p = await c.spawn(command, { signal });
        const data = options.stdin;
        try {
          for (let i = 0; i < data.byteLength; i += STDIN_CHUNK) {
            const chunk = data.slice(i, i + STDIN_CHUNK);
            await p.writeStdin(chunk.buffer as ArrayBuffer, { signal });
          }
          await p.closeStdin({ signal });
        } catch {
          // The script may already have exited (a refused write into a read-only folder): its exit code says why.
        }
        return p.wait({ signal });
      });
      if (out.exit.timedOut)
        throw err(PC_ERROR_CODES.TIMEOUT, `a guest command timed out after ${timeoutMs} ms`);
      if (out.exit.error && out.exit.code === undefined && !out.exit.signal) {
        throw err(PC_ERROR_CODES.GUEST_ERROR, `a guest command could not run: ${out.exit.error}`);
      }
      return {
        code: exitCodeOf(out.exit),
        stdout: bytesOf(out.stdout),
        stderr: bytesOf(out.stderr).toString('utf8'),
        timedOut: false,
      };
    } catch (e) {
      if (isApiError(e)) throw e;
      if (e instanceof DeadlineError)
        throw err(PC_ERROR_CODES.TIMEOUT, `a guest command timed out after ${timeoutMs} ms`);
      throw err(
        PC_ERROR_CODES.GUEST_ERROR,
        `guest call failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  // ------------------------------------------------------------------------------------------- lifecycle

  /** Forgets a PC's jobs (the PC stopped or is gone: its processes died with it). */
  forgetPc(pcId: string): void {
    for (const job of [...this.#jobs.values()]) {
      if (job.pcId !== pcId) continue;
      job.abort.abort();
      if (job.running) {
        job.running = false;
        job.buffer.append('\n[the PC stopped]\n');
      }
    }
    this.forgetGuest(pcId);
  }

  /** Stops following every job (shutdown). */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const job of this.#jobs.values()) job.abort.abort();
    this.#jobs.clear();
    this.#foreground.clear();
  }
}
