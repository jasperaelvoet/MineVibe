import { createHash, randomBytes } from 'node:crypto';
import type { SpacesdClientLike, SpacesdProcessLike } from '@trycua/cua';
import type { Logger } from 'pino';
import { ApiError, isApiError } from '../contracts/common.js';
import {
  type EditRequest,
  type ExecRequest,
  type ExecResult,
  type FileStat,
  type GlobRequest,
  type GlobResult,
  type GrepRequest,
  type GrepResult,
  type GuestWindow,
  type JobEndReason,
  type JobExit,
  type JobOutput,
  type KeyboardAction,
  type OpenRequest,
  type OpenResult,
  PC_ERROR_CODES,
  PC_LIMITS,
  type PcApi,
  type PcGuestCapabilities,
  type PcGuestInfo,
  type PointerAction,
  type ReadRequest,
  type ReadResult,
  type Screenshot,
  type ScreenshotOptions,
  type UiAction,
  type UiFindRequest,
  type UiSnapshot,
  type UiTreeRequest,
  type WindowOp,
} from '../contracts/PcApi.js';
import { DeadlineError, delay as delayMs, withDeadline } from './deadline.js';
import {
  absolutePaths,
  anchorGlob,
  applyEdit,
  CAPS_SCRIPT,
  EDIT_MAX_BYTES,
  EDIT_READ_SCRIPT,
  EDIT_WRITE_SCRIPT,
  EXEC_PREFIX,
  exitCodeOf,
  formatRgJson,
  GLOB_COUNT_CAP,
  GLOB_LIMIT,
  GLOB_SCRIPT,
  GREP_SCRIPT,
  GUEST_DISPLAY,
  GUEST_HOME,
  GUEST_USER,
  type GuestCapsProbe,
  grepArgs,
  JOB_FILE_MAX_BYTES,
  JOBS_DIR,
  JobBuffer,
  mirrorPrompt,
  OPEN_SCRIPT,
  OutputCapture,
  parseCapsProbe,
  parseRgCount,
  READ_MAX_BYTES,
  READ_SCRIPT,
  SCRIPT_EXIT,
  STAT_TARGET_SCRIPT,
  SWEEP_LAUNCH,
  SWEEP_SCRIPT,
  splitGlob,
  TRIM_JOB_SCRIPT,
  WRITE_MAX_BYTES,
  WRITE_SCRIPT,
  ZOOM_SCRIPT,
} from './guest.js';
import {
  InputError,
  type InputRouter,
  MODIFIER_KEYS,
  normalizeKeyName,
  type RouterEvent,
} from './InputRouter.js';
import type { PcCapabilities, PcRecord, PcStatusInfo } from './PcManager.js';
import { PC_TYPE_SPECS } from './PcTypes.js';
import {
  parseUiSnapshot,
  parseWindows,
  type RawWindow,
  rpc,
  rpcError,
  uiActionEnum,
  windowRef,
} from './rpc.js';
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
    /** Where the PC sees the read-only Codex export (`/mnt/codex`), or null (PcManager.codexPathOf). */
    codexPathOf?(id: string): string | null;
    /** A Linux PC's capabilities: nested virtualization and its Android phone (PcManager.capabilitiesOf). */
    capabilitiesOf?(id: string): PcCapabilities;
  };
  /** The connected spacesd client of a running PC (SpacesdPool.client). */
  readonly client: (pcId: string) => Promise<SpacesdClientLike>;
  readonly router: InputRouter;
  readonly seats: SeatBook;
  /** `ImageFormat.Jpeg` of the loaded cua module. */
  readonly jpegFormat: () => number;
  /** `ImageFormat.Png` of the loaded cua module (default: JPEG is used for everything). */
  readonly pngFormat?: () => number;
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
  /** The guest file the output is teed to, when there is one. */
  readonly outputPath: string | undefined;
  /** Why it ended (set by whoever kills it before the pump stops). */
  endReason: JobEndReason | null;
  /** The lifetime and file-size timers. */
  timers: NodeJS.Timeout[];
  notified: boolean;
}

/** A job id the tool server may choose (it names the output file). */
const JOB_ID_RE = /^[a-z0-9]{4,24}$/;
/** How often a running job's output file is checked against {@link JOB_FILE_MAX_BYTES}. */
const JOB_FILE_CHECK_MS = 60_000;
/** Default wait for the window of an `open`. */
const OPEN_WAIT_MS = 15_000;

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

/** Modifier names as cua names (an unknown one stays as it is and the router refuses it). */
function modifierKeys(mods: readonly string[]): string[] {
  return mods.map((m) => normalizeKeyName(m) ?? m);
}

/**
 * One chord as router events: modifiers plus one key is a spacesd `press` (with its own repeat, a letter lowercased
 * so ctrl+S stays ctrl+s); a lone key likewise; anything else is a hotkey, sent once per repeat.
 */
function chordEvents(keys: readonly string[], repeat: number): RouterEvent[] {
  if (keys.length === 0) throw err(PC_ERROR_CODES.GUEST_ERROR, 'no keys given');
  const names = keys.map((k) => normalizeKeyName(k) ?? k);
  const mods = names.filter((n) => MODIFIER_KEYS.has(n));
  const rest = names.filter((n) => !MODIFIER_KEYS.has(n));
  const n = Math.max(1, Math.min(100, Math.round(repeat)));
  if (rest.length === 1) {
    const key = rest[0] as string;
    const lowered = mods.length > 0 && /^[A-Z]$/.test(key) ? key.toLowerCase() : key;
    return [{ k: 'press', key: lowered, modifiers: mods, repeat: n }];
  }
  if (rest.length === 0 && mods.length === 1) {
    return [{ k: 'press', key: mods[0] as string, modifiers: [], repeat: n }];
  }
  return Array.from({ length: n }, () => ({ k: 'chord' as const, keys: [...keys] }));
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
  /** The guest's capability probe per PC, with when it was taken (toolchains change, so it is redone after a minute). */
  readonly #probes = new Map<string, { at: number; probe: GuestCapsProbe }>();
  /** spacesd's supported features per PC (`a11y`, `windows`, …), measured once per boot. */
  readonly #features = new Map<string, ReadonlySet<string>>();
  readonly #jobListeners = new Set<(exit: JobExit) => void>();
  /**
   * Output files of a seat's commands (`pcId\ntag` → paths): a foreground command's file is normally deleted by its
   * own exit trap, but one that replaced its shell (`exec`) leaves it, so the seat's end deletes them all.
   */
  readonly #seatFiles = new Map<string, Set<string>>();
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
      codexPath: this.#o.pcs.codexPathOf?.(pcId) ?? null,
      cpus: rec.cpus,
      memoryMiB: rec.memMiB,
      ...(osVersion ? { osVersion } : {}),
      ...(family === 'linux' ? { capabilities: await this.#capabilitiesOf(pcId, status === 'running') } : {}),
    };
  }

  /** What a Linux PC can run (PLAN §8.7): the PC manager's settings plus a probe of the guest when it runs. */
  async #capabilitiesOf(pcId: string, running: boolean): Promise<PcGuestCapabilities> {
    const settings = this.#o.pcs.capabilitiesOf?.(pcId);
    const probe = running ? await this.#probe(pcId) : null;
    const phone = settings?.android.phone;
    return {
      arch: probe?.arch ?? null,
      kernel: probe?.kernel ?? null,
      kvm: probe?.kvm ?? null,
      cpus: probe?.cpus ?? null,
      memoryMiB: probe?.memoryMiB ?? null,
      diskFreeGiB: probe?.diskFreeGiB ?? null,
      network: { internet: true, hostAndLan: false },
      toolchains: probe?.toolchains ?? [],
      // Without the PC manager's settings (tests, an old host), neither can be told: say so rather than "available".
      virtualization: {
        enabled: settings?.virtualization.enabled ?? false,
        unavailable: settings ? settings.virtualization.unavailable : 'unknown on this PC',
      },
      android: {
        enabled: settings?.android.enabled ?? false,
        unavailable: settings ? settings.android.unavailable : 'unknown on this PC',
        status: phone?.status ?? 'off',
        detail: phone?.detail ?? null,
        host: phone?.status === 'running' ? (probe?.phoneHost ?? 'android-phone') : null,
      },
    };
  }

  /** The guest probe of a running PC, at most a minute old; null when the guest cannot be asked. Never throws. */
  async #probe(pcId: string): Promise<GuestCapsProbe | null> {
    const known = this.#probes.get(pcId);
    if (known && Date.now() - known.at < 60_000) return known.probe;
    try {
      const r = await this.#script(pcId, CAPS_SCRIPT, [], { timeoutMs: 10_000 });
      const probe = parseCapsProbe(r.stdout.toString('utf8'));
      this.#probes.set(pcId, { at: Date.now(), probe });
      return probe;
    } catch (e) {
      this.#log?.debug({ pcId, err: String(e) }, 'capability probe failed');
      return known?.probe ?? null;
    }
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
    await this.#capabilities(pcId);
    return this.#osVersions.get(pcId) ?? null;
  }

  /** Reads spacesd's capabilities once per boot (OS version and supported features). Never throws. */
  async #capabilities(pcId: string): Promise<void> {
    try {
      const c = await this.#o.client(pcId);
      const caps = await withDeadline(this.#callTimeoutMs, 'capabilities', (signal) =>
        c.capabilities({ signal }),
      );
      const v = `${caps.osName ?? ''} ${caps.osVersion ?? ''}`.trim();
      if (v) this.#osVersions.set(pcId, v);
      const features = (caps as { features?: { name?: string; supported?: boolean }[] }).features;
      if (Array.isArray(features)) {
        this.#features.set(
          pcId,
          new Set(features.filter((f) => f.supported === true && f.name).map((f) => f.name as string)),
        );
      }
    } catch {
      // unknown: the next call asks again
    }
  }

  /**
   * spacesd's supported features of a running PC (`a11y`, `windows`, `launch_app`, …). Unknown (an old spacesd that
   * lists none) counts as everything supported: the call itself then says what is missing.
   */
  async features(pcId: string): Promise<ReadonlySet<string> | null> {
    if (!this.#features.has(pcId)) await this.#capabilities(pcId);
    return this.#features.get(pcId) ?? null;
  }

  async #need(pcId: string, feature: 'a11y' | 'windows'): Promise<void> {
    const f = await this.features(pcId);
    if (f && !f.has(feature)) {
      throw err(
        feature === 'a11y' ? PC_ERROR_CODES.A11Y_UNAVAILABLE : PC_ERROR_CODES.GUEST_ERROR,
        `${pcId} has no ${feature === 'a11y' ? 'accessibility service' : 'window service'}`,
      );
    }
  }

  /** Forgets what was measured about a PC's guest (it stopped, was recreated or reimaged). */
  forgetGuest(pcId: string): void {
    this.#screens.delete(pcId);
    this.#osVersions.delete(pcId);
    this.#features.delete(pcId);
    this.#probes.delete(pcId);
  }

  // ------------------------------------------------------------------------------------------- screen and input

  async screenshot(pcId: string, options: ScreenshotOptions = {}): Promise<Screenshot> {
    const c = await this.#running(pcId);
    const screen = await this.#screen(pcId, true);
    const png = options.format === 'png' && this.#o.pngFormat !== undefined;
    const quality = Math.round(Math.min(100, Math.max(10, options.quality ?? 80)));
    const includeCursor = options.includeCursor !== false;
    if (options.region) return this.#regionShot(c, pcId, screen, options, png, quality, includeCursor);
    const maxDim = Math.round(Math.min(2560, Math.max(160, options.maxDim ?? Math.max(screen.w, screen.h))));
    let shot: Awaited<ReturnType<SpacesdClientLike['screenshot']>>;
    try {
      shot = await withDeadline(this.#callTimeoutMs, 'screenshot', (signal) =>
        c.screenshot(
          {
            format: png ? (this.#o.pngFormat?.() ?? this.#o.jpegFormat()) : this.#o.jpegFormat(),
            quality,
            maxDimension: maxDim,
            includeCursor,
          },
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
      mime: png ? 'image/png' : 'image/jpeg',
      data: new Uint8Array(shot.image),
      w: shot.width,
      h: shot.height,
      screen,
      scale: screen.w > 0 ? shot.width / screen.w : 1,
    };
  }

  /** A part of the screen (`ComputerService/Screenshot{region}`), at full resolution unless `maxDim` is smaller. */
  async #regionShot(
    c: SpacesdClientLike,
    pcId: string,
    screen: { w: number; h: number },
    options: ScreenshotOptions,
    png: boolean,
    quality: number,
    includeCursor: boolean,
  ): Promise<Screenshot> {
    const r = options.region as NonNullable<ScreenshotOptions['region']>;
    const x = Math.max(0, Math.min(screen.w - 1, Math.round(r.x)));
    const y = Math.max(0, Math.min(screen.h - 1, Math.round(r.y)));
    const w = Math.max(1, Math.min(screen.w - x, Math.round(r.w)));
    const h = Math.max(1, Math.min(screen.h - y, Math.round(r.h)));
    if (options.fit && !png) {
      // spacesd never scales a region up: the guest's ImageMagick captures and scales it (Lanczos) in one go.
      const s = Math.min(options.fit.w / w, options.fit.h / h);
      const fw = Math.max(1, Math.round(w * s));
      const fh = Math.max(1, Math.round(h * s));
      const z = await this.#script(
        pcId,
        ZOOM_SCRIPT,
        [`${w}x${h}+${x}+${y}`, `${fw}x${fh}!`, String(quality)],
        { env: { DISPLAY: GUEST_DISPLAY }, timeoutMs: 15_000 },
      ).catch(() => null);
      if (z && z.code === 0 && z.stdout.byteLength > 0) {
        return { mime: 'image/jpeg', data: new Uint8Array(z.stdout), w: fw, h: fh, screen, scale: fw / w };
      }
    }
    const answer = await rpc<{ image?: string; imageSize?: { width?: number; height?: number } }>(
      c,
      'ComputerService/Screenshot',
      {
        region: { x, y, width: w, height: h },
        format: png ? 'IMAGE_FORMAT_PNG' : 'IMAGE_FORMAT_JPEG',
        quality,
        includeCursor,
        ...(options.maxDim ? { maxDimension: Math.round(options.maxDim) } : {}),
      },
      this.#callTimeoutMs,
    );
    if (typeof answer.image !== 'string' || answer.image.length === 0) {
      throw err(PC_ERROR_CODES.GUEST_ERROR, `${pcId} returned no image for the region`);
    }
    const iw = answer.imageSize?.width ?? w;
    return {
      mime: png ? 'image/png' : 'image/jpeg',
      data: new Uint8Array(Buffer.from(answer.image, 'base64')),
      w: iw,
      h: answer.imageSize?.height ?? h,
      screen,
      scale: iw / w,
    };
  }

  async pointer(pcId: string, action: PointerAction): Promise<void> {
    const events: RouterEvent[] = [];
    const at = (a: { x?: number | undefined; y?: number | undefined }) =>
      a.x !== undefined && a.y !== undefined ? { x: a.x, y: a.y } : {};
    switch (action.action) {
      case 'move':
        events.push({ k: 'move', x: action.x, y: action.y });
        break;
      case 'click':
      case 'double_click':
      case 'right_click': {
        const count = action.action === 'double_click' ? 2 : Math.max(1, Math.min(3, action.count ?? 1));
        events.push({
          k: 'click',
          ...at(action),
          button: action.action === 'right_click' ? 'right' : (action.button ?? 'left'),
          count,
          ...(action.modifiers?.length ? { modifiers: modifierKeys(action.modifiers) } : {}),
        });
        break;
      }
      case 'down':
      case 'up':
        if (action.x !== undefined && action.y !== undefined) {
          events.push({
            k: 'button',
            button: action.button ?? 'left',
            down: action.action === 'down',
            x: action.x,
            y: action.y,
          });
        } else {
          events.push({ k: 'mouse', button: action.button ?? 'left', down: action.action === 'down' });
        }
        break;
      case 'drag':
        events.push({
          k: 'drag',
          x: action.x,
          y: action.y,
          toX: action.toX,
          toY: action.toY,
          ...(action.modifiers?.length ? { modifiers: modifierKeys(action.modifiers) } : {}),
        });
        break;
      case 'scroll': {
        // spacesd's scroll has no modifiers: they are held around it (and released by any release).
        const mods = action.modifiers?.length ? modifierKeys(action.modifiers) : [];
        for (const key of mods) events.push({ k: 'key', key, down: true });
        events.push({ k: 'wheel', dx: action.dx, dy: action.dy, ...at(action) });
        for (const key of [...mods].reverse()) events.push({ k: 'key', key, down: false });
        break;
      }
    }
    await this.#input(pcId, events);
  }

  async keyboard(pcId: string, action: KeyboardAction): Promise<void> {
    const events: RouterEvent[] = [];
    switch (action.action) {
      case 'press':
        events.push(...chordEvents(action.keys, action.repeat ?? 1));
        break;
      case 'sequence': {
        if (action.chords.length === 0) throw err(PC_ERROR_CODES.GUEST_ERROR, 'no keys given');
        const once = action.chords.flatMap((chord) => chordEvents(chord, 1));
        for (let i = 0; i < Math.max(1, action.repeat ?? 1); i++) events.push(...once);
        break;
      }
      case 'hold':
        if (action.keys.length === 0) throw err(PC_ERROR_CODES.GUEST_ERROR, 'no keys given');
        events.push({ k: 'hold', keys: [...action.keys], ms: action.ms });
        break;
      case 'down':
      case 'up':
        if (action.keys.length === 0) throw err(PC_ERROR_CODES.GUEST_ERROR, 'no keys given');
        for (const key of action.keys) events.push({ k: 'key', key, down: action.action === 'down' });
        break;
    }
    await this.#input(pcId, events);
  }

  async cursor(pcId: string): Promise<{ x: number; y: number }> {
    const c = await this.#running(pcId);
    const a = await rpc<{ position?: { x?: number; y?: number } }>(
      c,
      'ComputerService/GetCursorPosition',
      {},
      this.#callTimeoutMs,
    );
    return { x: Math.round(a.position?.x ?? 0), y: Math.round(a.position?.y ?? 0) };
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

  // ------------------------------------------------------------------------------------------- windows

  async windows(pcId: string): Promise<GuestWindow[]> {
    const c = await this.#running(pcId);
    await this.#need(pcId, 'windows');
    const a = await rpc<{ windows?: RawWindow[] }>(c, 'WindowsService/ListWindows', {}, this.#callTimeoutMs);
    return parseWindows(a);
  }

  async window(pcId: string, windowId: string, op: WindowOp): Promise<void> {
    const c = await this.#running(pcId);
    this.#seatedAgent(pcId);
    await this.#need(pcId, 'windows');
    const method = {
      activate: 'WindowsService/ActivateWindow',
      maximize: 'WindowsService/MaximizeWindow',
      minimize: 'WindowsService/MinimizeWindow',
      restore: 'WindowsService/RestoreWindow',
      close: 'WindowsService/CloseWindow',
    }[op];
    await rpc(c, method, { window: windowRef(windowId) }, this.#callTimeoutMs);
  }

  /**
   * Opens a URL (Firefox when installed: its pages have an accessibility tree), a file (its default app, a text
   * editor or the browser), a folder (Thunar) or an app, as the seat's tagged process (killed with the seat), and
   * waits for a window that is new, or a known one whose title changed and that has the focus (a tab in a running
   * browser). That window is activated.
   */
  async open(pcId: string, request: OpenRequest): Promise<OpenResult> {
    await this.#running(pcId);
    this.#checkTag(pcId, request.tag);
    const before = await this.windows(pcId).catch(() => [] as GuestWindow[]);
    const callId = randomBytes(6).toString('hex');
    const r = await this.#script(pcId, OPEN_SCRIPT, [request.target, ...(request.args ?? [])], {
      env: {
        DISPLAY: GUEST_DISPLAY,
        USER: GUEST_USER,
        MV_TAG: request.tag,
        MV_CALL: callId,
        PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
      },
      timeoutMs: 20_000,
    });
    const out = r.stdout.toString('utf8');
    if (r.code !== 0) {
      const installed = /^apps: (.*)$/m.exec(out)?.[1]?.trim() ?? '';
      if (r.code === SCRIPT_EXIT.NOT_FOUND)
        throw err(PC_ERROR_CODES.NOT_FOUND, `no such file or directory: ${request.target}`);
      throw err(
        PC_ERROR_CODES.OPEN_FAILED,
        `nothing opens ${request.target}${installed ? `. Installed apps include: ${installed}` : ''}`,
      );
    }
    const via = /^via (.*)$/m.exec(out)?.[1]?.trim() ?? 'xdg-open';
    if (!this.#seatOwns(pcId, request.tag)) {
      void this.sweep(pcId, 'MV_CALL', callId).catch(() => 0);
      throw err(PC_ERROR_CODES.DENIED, `the seat ${request.tag} ended while ${request.target} opened`);
    }
    const known = new Map(before.map((w) => [w.id, w.title]));
    const deadline = Date.now() + (request.waitMs ?? OPEN_WAIT_MS);
    for (;;) {
      await delayMs(250);
      const now = await this.windows(pcId).catch(() => [] as GuestWindow[]);
      const fresh = now.filter((w) => !known.has(w.id) && w.title !== '');
      const changed = now.find((w) => w.focused && known.has(w.id) && known.get(w.id) !== w.title);
      const win = fresh.find((w) => w.focused) ?? fresh[0] ?? changed ?? null;
      if (win) {
        if (!win.focused) {
          await this.window(pcId, win.id, 'activate').catch(() => {});
        }
        return { window: { ...win, focused: true }, newWindow: fresh.includes(win), via };
      }
      if (Date.now() >= deadline) return { window: null, newWindow: false, via };
    }
  }

  // ------------------------------------------------------------------------------------------- accessibility

  async uiFind(pcId: string, request: UiFindRequest): Promise<UiSnapshot> {
    const c = await this.#running(pcId);
    await this.#need(pcId, 'a11y');
    const query = {
      ...(request.nameContains ? { nameContains: request.nameContains } : {}),
      ...(request.valueContains ? { valueContains: request.valueContains } : {}),
      ...(request.role ? { role: request.role } : {}),
    };
    const a = await rpc<Parameters<typeof parseUiSnapshot>[0]>(
      c,
      'AccessibilityService/Find',
      {
        ...(request.windowId ? { window: windowRef(request.windowId) } : {}),
        query,
        maxResults: Math.max(1, Math.min(500, request.maxResults ?? 50)),
      },
      this.#callTimeoutMs,
    );
    return parseUiSnapshot(a);
  }

  async uiTree(pcId: string, request: UiTreeRequest): Promise<UiSnapshot> {
    const c = await this.#running(pcId);
    await this.#need(pcId, 'a11y');
    const a = await rpc<Parameters<typeof parseUiSnapshot>[0]>(
      c,
      'AccessibilityService/GetTree',
      {
        ...(request.windowId ? { window: windowRef(request.windowId) } : {}),
        maxDepth: Math.max(1, Math.min(64, request.maxDepth ?? 40)),
        maxNodes: Math.max(1, Math.min(5_000, request.maxNodes ?? 600)),
        ...(request.includeHidden ? { includeHidden: true } : {}),
      },
      this.#callTimeoutMs,
    );
    return parseUiSnapshot(a);
  }

  async uiAct(
    pcId: string,
    request: { snapshotId: string; elementId: string; action: UiAction; value?: string | undefined },
  ): Promise<void> {
    const c = await this.#running(pcId);
    this.#seatedAgent(pcId);
    await this.#need(pcId, 'a11y');
    await rpc(
      c,
      'AccessibilityService/Act',
      {
        element: { snapshotId: request.snapshotId, elementId: request.elementId },
        action: uiActionEnum(request.action),
        ...(request.value !== undefined ? { value: request.value } : {}),
      },
      this.#callTimeoutMs,
    );
  }

  // ------------------------------------------------------------------------------------------- shell

  /**
   * The agent of `tag` sits at the PC under that very seat: DENIED otherwise. A call from an earlier seat of the same
   * agent (its kill sweep may already have run) never starts: its processes would carry a tag nobody kills any more,
   * and its job would belong to no current seat. Returns the seated agent.
   */
  #checkTag(pcId: string, tag: string): { agentId: string; seatEpoch: number | null } {
    if (!TAG_RE.test(tag)) throw err(PC_ERROR_CODES.DENIED, 'exec needs an agentId:seatEpoch tag');
    const agent = this.#seatedAgent(pcId);
    if (tagAgent(tag) !== agent.agentId) {
      throw err(PC_ERROR_CODES.DENIED, `${agent.agentId} sits at ${pcId}, not ${tagAgent(tag)}`);
    }
    if (agent.seatEpoch !== null && tag !== seatTag(agent.agentId, agent.seatEpoch)) {
      throw err(
        PC_ERROR_CODES.DENIED,
        `the seat ${tag} has ended; ${agent.agentId} sits at ${pcId} as ${seatTag(agent.agentId, agent.seatEpoch)}`,
      );
    }
    return agent;
  }

  async exec(pcId: string, request: ExecRequest): Promise<ExecResult> {
    if (!TAG_RE.test(request.tag)) throw err(PC_ERROR_CODES.DENIED, 'exec needs an agentId:seatEpoch tag');
    const c = await this.#running(pcId);
    const agent = this.#checkTag(pcId, request.tag);
    if (request.jobId !== undefined && !JOB_ID_RE.test(request.jobId)) {
      throw err(PC_ERROR_CODES.GUEST_ERROR, `invalid job id ${request.jobId}`);
    }
    if (request.jobId !== undefined && this.#jobs.has(request.jobId)) {
      throw err(PC_ERROR_CODES.GUEST_ERROR, `job id ${request.jobId} is taken`);
    }
    const timeoutMs = Math.round(
      Math.min(PC_LIMITS.maxTimeoutMs, Math.max(1_000, request.timeoutMs ?? PC_LIMITS.defaultTimeoutMs)),
    );
    const lifetimeMs = Math.round(
      Math.min(
        PC_LIMITS.maxJobLifetimeMs,
        Math.max(1_000, request.lifetimeMs ?? PC_LIMITS.defaultJobLifetimeMs),
      ),
    );
    const callId = randomBytes(6).toString('hex');
    const jobId = request.jobId ?? `bg${randomBytes(4).toString('hex')}`;
    const outputPath = request.outputFile ? `${JOBS_DIR}/${jobId}.out` : undefined;
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
      ...(outputPath ? { MV_OUT: outputPath } : {}),
      ...(outputPath && request.background ? { MV_KEEP: '1' } : {}),
    })) {
      env.set(k, v);
    }
    const script = `${EXEC_PREFIX}\n${request.command}`;
    const preserve = 'HOME,DISPLAY,MV_TAG,MV_CALL,MV_CWD,MV_EXEC_CWD,MV_PROMPT,MV_OUT,MV_KEEP';
    const program = request.root ? 'sudo' : 'bash';
    const args = request.root ? ['-n', `--preserve-env=${preserve}`, 'bash', '-lc', script] : ['-lc', script];
    const toBackground = request.onTimeout === 'background';
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
            // A backstop: Node's own timeout (and sweep) normally ends a foreground command first. A command that
            // may move to the background gets none: its job lifetime ends it.
            timeoutMs: request.background || toBackground ? undefined : timeoutMs + 15_000,
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
    const job = { jobId, outputPath, lifetimeMs };
    if (outputPath) {
      const key = `${pcId}\n${request.tag}`;
      const files = this.#seatFiles.get(key) ?? new Set<string>();
      if (files.size < 1_000) files.add(outputPath);
      this.#seatFiles.set(key, files);
    }
    if (request.background) return this.#startJob(pcId, request.tag, callId, proc, job, null);
    return this.#runForeground(pcId, request.tag, callId, proc, timeoutMs, toBackground ? job : null);
  }

  async #runForeground(
    pcId: string,
    tag: string,
    callId: string,
    proc: SpacesdProcessLike,
    timeoutMs: number,
    background: { jobId: string; outputPath: string | undefined; lifetimeMs: number } | null,
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
        if (background && this.#seatOwns(pcId, tag)) {
          // Claude Code 2.x: an overrun is moved to the background, not lost. Its output so far starts the job's.
          if (background.outputPath) await this.#keepJobFile(pcId, background.outputPath);
          return this.#startJob(pcId, tag, callId, proc, background, {
            output: capture.text(),
            startedAt: started,
            timedOutAfterMs: timeoutMs,
          });
        }
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

  /** Marks a job's output file as kept (the command's exit trap deletes it otherwise). Best effort. */
  async #keepJobFile(pcId: string, outputPath: string): Promise<void> {
    await this.#script(pcId, ': > "$1.keep"', [outputPath], { timeoutMs: 10_000 }).catch(() => null);
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

  #startJob(
    pcId: string,
    tag: string,
    callId: string,
    proc: SpacesdProcessLike,
    spec: { jobId: string; outputPath: string | undefined; lifetimeMs: number },
    moved: { output: string; startedAt: number; timedOutAfterMs: number } | null,
  ): ExecResult {
    this.#pruneJobs(pcId);
    const job: Job = {
      id: spec.jobId,
      pcId,
      tag,
      callId,
      buffer: new JobBuffer(this.#o.jobBufferChars ?? 1_000_000),
      abort: new AbortController(),
      proc,
      running: true,
      exitCode: null,
      startedAt: moved?.startedAt ?? Date.now(),
      endedAt: null,
      outputPath: spec.outputPath,
      endReason: null,
      timers: [],
      notified: false,
    };
    if (moved) job.buffer.append(moved.output);
    this.#jobs.set(job.id, job);
    const lifetime = setTimeout(() => {
      if (!job.running) return;
      job.endReason = 'lifetime';
      void this.#stopJob(
        job,
        `\n[stopped: it ran longer than ${Math.round(spec.lifetimeMs / 60_000)} min]\n`,
      );
    }, spec.lifetimeMs);
    lifetime.unref?.();
    job.timers.push(lifetime);
    if (spec.outputPath) {
      const check = setInterval(() => {
        if (job.running && spec.outputPath)
          void this.#script(pcId, TRIM_JOB_SCRIPT, [spec.outputPath, String(JOB_FILE_MAX_BYTES)], {
            timeoutMs: 20_000,
          }).catch(() => null);
      }, JOB_FILE_CHECK_MS);
      check.unref?.();
      job.timers.push(check);
    }
    void this.#pumpJob(job);
    return {
      kind: 'background',
      jobId: job.id,
      ...(spec.outputPath ? { outputPath: spec.outputPath } : {}),
      ...(moved ? { timedOutAfterMs: moved.timedOutAfterMs } : {}),
      lifetimeMs: spec.lifetimeMs,
    };
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
        job.endReason ??= 'lost';
        job.buffer.append(
          `\n[MineVibe lost track of this job: ${e instanceof Error ? e.message : String(e)}]\n`,
        );
      }
    } finally {
      job.running = false;
      job.endedAt = Date.now();
      job.proc = null;
      this.#jobEnded(job);
    }
  }

  /** Clears a job's timers and tells the listeners once. */
  #jobEnded(job: Job): void {
    for (const t of job.timers) clearTimeout(t);
    job.timers = [];
    if (job.notified || this.#disposed) return;
    job.notified = true;
    const exit: JobExit = {
      pcId: job.pcId,
      jobId: job.id,
      tag: job.tag,
      exitCode: job.exitCode,
      reason: job.endReason ?? (job.exitCode !== null ? 'exited' : 'lost'),
      ...(job.outputPath ? { outputPath: job.outputPath } : {}),
      durationMs: (job.endedAt ?? Date.now()) - job.startedAt,
    };
    for (const listener of [...this.#jobListeners]) {
      try {
        listener(exit);
      } catch (e) {
        this.#log?.warn({ err: String(e) }, 'a job exit listener failed');
      }
    }
  }

  onJobExit(listener: (exit: JobExit) => void): () => void {
    this.#jobListeners.add(listener);
    return () => {
      this.#jobListeners.delete(listener);
    };
  }

  /** Kills a running job and everything it started; its pump ends and the listeners hear `job.endReason`. */
  async #stopJob(job: Job, note: string): Promise<number> {
    if (!job.running) return 0;
    const proc = job.proc;
    // Settled before the pump stops: its end reports this exit.
    job.running = false;
    job.exitCode = job.exitCode ?? 137;
    job.buffer.append(note);
    job.abort.abort();
    const n = await this.#killCall(job.pcId, job.callId, proc);
    job.endedAt ??= Date.now();
    this.#jobEnded(job);
    return Math.max(1, n);
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
      job.endReason = 'stopped';
      return this.#stopJob(job, '\n[killed]\n');
    }
    return this.killTag(pcId, target.tag);
  }

  /**
   * Kills everything a seat started on a PC: its background jobs, its foreground commands and every guest process
   * that carries its tag or descends from one (kick, stand-up, any unseat), and deletes its jobs' output files. The
   * sweep goes first, while the process tree is intact; the job and command handles are killed afterwards as a
   * backstop. Never throws; returns how many processes died.
   */
  async killTag(pcId: string, tag: string): Promise<number> {
    const procs: SpacesdProcessLike[] = [];
    const seatKey = `${pcId}\n${tag}`;
    const files: string[] = [...(this.#seatFiles.get(seatKey) ?? [])].flatMap((f) => [f, `${f}.keep`]);
    this.#seatFiles.delete(seatKey);
    const ended: Job[] = [];
    for (const job of this.#jobs.values()) {
      if (job.pcId !== pcId || job.tag !== tag) continue;
      if (job.outputPath && !files.includes(job.outputPath))
        files.push(job.outputPath, `${job.outputPath}.keep`);
      if (!job.running) continue;
      if (job.proc) procs.push(job.proc);
      job.endReason = 'seat';
      job.abort.abort();
      job.running = false;
      job.exitCode = job.exitCode ?? 137;
      job.buffer.append('\n[killed: the seat ended]\n');
      ended.push(job);
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
      if (files.length > 0) {
        await this.#script(pcId, 'rm -f -- "$@"', files, { timeoutMs: 10_000 }).catch(() => null);
      }
    }
    let byHandle = 0;
    for (const proc of procs) byHandle += await this.#killHandle(proc);
    for (const job of ended) {
      job.endedAt ??= Date.now();
      this.#jobEnded(job);
    }
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
    const trailer = /(\d+) (\d+) (\d+)(?: (\d))?\s*$/.exec(r.stderr);
    const records = trailer ? Number(trailer[1]) : 0;
    let printed = trailer ? Number(trailer[2]) : 0;
    const cut = trailer ? trailer[3] === '1' : false;
    // Like Claude Code's Read, a final newline ends in one more (empty) line.
    const finalNewline = trailer?.[4] === '1';
    const total = records + (finalNewline ? 1 : 0);
    let content = r.stdout.toString('utf8');
    if (content.endsWith('\n')) content = content.slice(0, -1);
    if (finalNewline && !cut && offset - 1 + printed === records && printed < limit && offset <= total) {
      content = printed > 0 ? `${content}\n` : '';
      printed++;
    }
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

  async glob(pcId: string, request: GlobRequest): Promise<GlobResult> {
    const base = request.path ?? GUEST_HOME;
    const split = splitGlob(request.pattern, base);
    if (split.pattern.length === 0) return { paths: [], truncated: false, total: 0, countIsComplete: true };
    const r = await this.#script(pcId, GLOB_SCRIPT, [
      split.dir,
      anchorGlob(split.pattern),
      String(GLOB_LIMIT),
      String(GLOB_COUNT_CAP),
    ]);
    if (r.code === SCRIPT_EXIT.NOT_FOUND)
      throw err(PC_ERROR_CODES.NOT_FOUND, `no such directory: ${split.dir}`);
    const known = scriptError(r, split.dir);
    if (known) throw known;
    const text = r.stdout.toString('utf8');
    // The script prints the newest paths, then a last line `__MV_TOTAL__<n>` (all matches, capped).
    const totalMatch = /\n?__MV_TOTAL__(\d+)\s*$/.exec(text);
    const total = totalMatch ? Number(totalMatch[1]) : undefined;
    const paths = absolutePaths(totalMatch ? text.slice(0, totalMatch.index) : text, split.dir).slice(
      0,
      GLOB_LIMIT,
    );
    const truncated = total !== undefined ? total > paths.length : paths.length >= GLOB_LIMIT;
    return {
      paths,
      truncated,
      ...(total !== undefined ? { total, countIsComplete: total < GLOB_COUNT_CAP } : {}),
    };
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
    let files: number | undefined;
    let truncated = r.code === 141;
    if (request.outputMode === 'content') {
      const f = formatRgJson(stdout, {
        lineNumbers: request.lineNumbers !== false,
        context: (request.before ?? 0) > 0 || (request.after ?? 0) > 0,
        onlyMatching: request.onlyMatching === true,
      });
      lines = f.lines;
      matches = f.matches;
      truncated ||= f.incomplete;
    } else if (request.outputMode === 'count') {
      ({ lines, matches } = parseRgCount(stdout));
      files = lines.length;
    } else {
      lines = stdout.split('\n').filter((l) => l.length > 0);
      matches = lines.length;
    }
    // Offset first, then the head limit (Claude Code's Grep: "| tail -n +N | head -N").
    const offset = Math.max(0, Math.floor(request.offset ?? 0));
    const after = lines.slice(offset);
    const limit = request.headLimit !== undefined && request.headLimit > 0 ? request.headLimit : undefined;
    const shown = limit !== undefined ? after.slice(0, limit) : after;
    return {
      output: shown.join('\n'),
      matches,
      total: lines.length,
      ...(files !== undefined ? { files } : {}),
      truncated: truncated || shown.length < after.length,
    };
  }

  async stat(pcId: string, path: string): Promise<FileStat> {
    const c = await this.#running(pcId);
    try {
      const e = await withDeadline(this.#callTimeoutMs, 'stat', (signal) => c.stat(path, { signal }));
      // A symlink is described by what it points at: read-state compares the file the agent reads and edits.
      if (/link/i.test(e.kind)) return await this.#statTarget(pcId, path);
      const kind = /dir/i.test(e.kind) ? 'dir' : /file|regular/i.test(e.kind) ? 'file' : 'other';
      return {
        exists: true,
        kind,
        size: Number(e.size),
        mtimeMs: e.modifiedMs !== undefined ? Number(e.modifiedMs) : 0,
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/NotFound|not found|No such file/i.test(msg)) return { exists: false, size: 0, mtimeMs: 0 };
      if (/PermissionDenied|permission denied/i.test(msg))
        throw err(PC_ERROR_CODES.DENIED, `${path}: permission denied`);
      if (e instanceof DeadlineError) throw err(PC_ERROR_CODES.TIMEOUT, `stat ${path} timed out`);
      throw err(PC_ERROR_CODES.GUEST_ERROR, `stat ${path} failed: ${msg.slice(0, 200)}`);
    }
  }

  /** {@link stat} of a symlink's target (a dangling link does not exist). */
  async #statTarget(pcId: string, path: string): Promise<FileStat> {
    const r = await this.#script(pcId, STAT_TARGET_SCRIPT, [path], { timeoutMs: 10_000 });
    if (r.code === SCRIPT_EXIT.NOT_FOUND) return { exists: false, size: 0, mtimeMs: 0 };
    if (r.code !== 0) throw err(PC_ERROR_CODES.GUEST_ERROR, `stat ${path} failed: ${tail(r.stderr)}`);
    const [type = '', size = '0', mtime = '0'] = r.stdout.toString('utf8').trim().split('|');
    return {
      exists: true,
      kind: /directory/i.test(type) ? 'dir' : /regular/i.test(type) ? 'file' : 'other',
      size: Number(size) || 0,
      mtimeMs: (Number(mtime) || 0) * 1000,
    };
  }

  async readBytes(pcId: string, path: string, maxBytes: number): Promise<Uint8Array> {
    const st = await this.stat(pcId, path);
    if (!st.exists) throw err(PC_ERROR_CODES.NOT_FOUND, `no such file or directory: ${path}`);
    if (st.kind === 'dir') throw err(PC_ERROR_CODES.NOT_A_FILE, `${path} is a directory`);
    if (st.size > maxBytes) {
      throw err(PC_ERROR_CODES.DENIED, `${path} is ${st.size} bytes, more than ${maxBytes}`);
    }
    const c = await this.#running(pcId);
    try {
      const data = await withDeadline(this.#scriptTimeoutMs, 'download', (signal) =>
        c.download(path, { signal }),
      );
      return new Uint8Array(data);
    } catch (e) {
      throw rpcError('download', e);
    }
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
    options: { timeoutMs?: number; stdin?: Uint8Array; env?: Readonly<Record<string, string>> } = {},
  ): Promise<ScriptResult> {
    const c = await this.#running(pcId);
    const timeoutMs = options.timeoutMs ?? this.#scriptTimeoutMs;
    const env = new Map<string, string>([
      ['HOME', GUEST_HOME],
      ['LC_ALL', 'C.UTF-8'],
      ...Object.entries(options.env ?? {}),
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
      if (job.running) {
        job.endReason ??= 'lost';
        job.running = false;
        job.buffer.append('\n[the PC stopped]\n');
      }
      job.abort.abort();
      job.endedAt ??= Date.now();
      this.#jobEnded(job);
    }
    for (const key of [...this.#seatFiles.keys()])
      if (key.startsWith(`${pcId}\n`)) this.#seatFiles.delete(key);
    this.forgetGuest(pcId);
  }

  /** Stops following every job (shutdown). */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const job of this.#jobs.values()) {
      for (const t of job.timers) clearTimeout(t);
      job.abort.abort();
    }
    this.#jobListeners.clear();
    this.#jobs.clear();
    this.#foreground.clear();
  }
}
