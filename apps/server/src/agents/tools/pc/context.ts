/**
 * The state one agent's `pc` tool server shares between its tools: the seat a call may use, the working directory
 * and guest facts per PC, the screenshot geometry, the batch book, read-state, element refs, the last image the
 * agent saw (so an unchanged screen costs a line, not 1,334 image tokens) and the windows it last knew.
 */

import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { isApiError } from '../../../contracts/common.js';
import {
  type GuestWindow,
  PC_ERROR_CODES,
  PC_LIMITS,
  type PcGuestInfo,
  type Screenshot,
} from '../../../contracts/PcApi.js';
import type { PcToolName } from '../catalog.js';
import { type CallToolResult, errorFrom, errorResult } from '../results.js';
import { BatchBook } from './batch.js';
import { BATCH_HALT, MIRROR_KEEP, NOT_SEATED, playerTookOver, redactHostPaths } from './formats.js';
import { geometryFor, type ScreenGeometry } from './geometry.js';
import { PcJobBook } from './jobs.js';
import { ReadState } from './readState.js';
import { RefBook } from './refs.js';
import type { PcHost } from './types.js';

/** Where MineVibe's own host paths live (its home and temp folders): PC errors never show them (DEBT, P1). */
const HOST_ROOTS: readonly string[] = (() => {
  // Application Support has a space: named whole, so a MineVibe folder in it is redacted whole.
  const roots = new Set([homedir(), join(homedir(), 'Library', 'Application Support'), tmpdir()]);
  try {
    roots.add(realpathSync(tmpdir()));
  } catch {
    // the temp folder's real path is a nicety (macOS /private/var)
  }
  return [...roots].filter((r) => r.length > 1);
})();

export interface Seat {
  readonly pcId: string;
  readonly epoch: number;
  /** The tool_use id of this call, when known (`_meta`, else the gate's). */
  readonly toolUseId: string | undefined;
}

/** How a screen is waited on before it is looked at (PC tools V2 §4.3). */
export interface SettleTiming {
  /** A screen is settled only within this long after a mutating action (default 1.5 s). */
  readonly windowMs: number;
  /** Thumbnail poll interval (default 120 ms). */
  readonly pollMs: number;
  /** At least this long of quiet (default 150 ms). */
  readonly minMs: number;
  /** At most this long in all (default 1.5 s). */
  readonly maxMs: number;
  /** How long a computer action waits for its message to end to know if it is the last (default 1 s). */
  readonly batchWaitMs: number;
}

export const DEFAULT_SETTLE: SettleTiming = {
  windowMs: 1_500,
  pollMs: 120,
  minMs: 150,
  maxMs: 1_500,
  batchWaitMs: 1_000,
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The tool_use id Claude Code puts into every MCP call's `_meta` (2.1.293: `claudecode/toolUseId`). */
export function toolUseIdOf(extra: unknown): string | undefined {
  const meta = (extra as { _meta?: Record<string, unknown> } | null | undefined)?._meta;
  const id = meta?.['claudecode/toolUseId'];
  return typeof id === 'string' && id.length > 0 ? id : undefined;
}

/** The title of a window as the agent sees it (the shell mirror is marked). */
export function windowLabel(w: GuestWindow): string {
  return w.title || w.app || w.id;
}

export function isMirror(w: GuestWindow): boolean {
  return /^Shell: /.test(w.title);
}

/** Keeps every text of a result within {@link PC_LIMITS.maxResultChars} (D7): the middle of the longest is cut. */
export function guardResult(result: CallToolResult): CallToolResult {
  const max = PC_LIMITS.maxResultChars;
  let total = 0;
  for (const c of result.content) if (c.type === 'text') total += c.text.length;
  if (total <= max) return result;
  const content = result.content.map((c) => {
    if (c.type !== 'text' || c.text.length <= max / 4) return c;
    const keep = Math.max(1_000, c.text.length - (total - max) - 200);
    const head = c.text.slice(0, Math.floor(keep * 0.4));
    const tail = c.text.slice(c.text.length - Math.floor(keep * 0.6));
    return {
      ...c,
      text: `${head}\n\n... [${c.text.length - head.length - tail.length} characters cut] ...\n\n${tail}`,
    };
  });
  return { ...result, content };
}

export class PcToolContext {
  readonly host: PcHost;
  readonly batch: BatchBook;
  readonly jobs: PcJobBook;
  readonly readState = new ReadState();
  readonly refs = new RefBook();
  readonly settleTiming: SettleTiming;
  readonly #cwds = new Map<string, string>();
  readonly #infos = new Map<string, PcGuestInfo>();
  readonly #lastImage = new Map<string, string>();
  readonly #lastWindows = new Map<string, readonly GuestWindow[]>();
  readonly #lastMutation = new Map<string, number>();
  #seat: { pcId: string; epoch: number } | null = null;

  constructor(host: PcHost) {
    this.host = host;
    this.batch = host.batch ?? new BatchBook();
    this.jobs = host.jobs ?? new PcJobBook();
    this.settleTiming = { ...DEFAULT_SETTLE, ...(host.settle ?? {}) };
    host.onCompaction?.(() => this.forgetContext());
  }

  /** The model no longer has what it read or saw (compaction): it must read and look again. */
  forgetContext(): void {
    this.readState.clear();
    this.#lastImage.clear();
  }

  #onSeat(pcId: string, epoch: number): void {
    if (this.#seat?.pcId === pcId && this.#seat.epoch === epoch) return;
    this.#seat = { pcId, epoch };
    this.refs.clear();
    this.readState.clear();
    this.#lastImage.clear();
    this.#lastWindows.clear();
    this.#infos.delete(pcId);
  }

  /**
   * Runs a tool body with the seat checked (fail closed: no seat, or a seat newer than the one the gate allowed the
   * call under, is NOT_SEATED). Computer actions (`gui`) follow the batch rules: one after a failed action of the same
   * message does not run, and a failing one stops those after it.
   */
  async run(
    name: PcToolName,
    extra: unknown,
    body: (seat: Seat) => Promise<CallToolResult>,
    options: { gui?: boolean } = {},
  ): Promise<CallToolResult> {
    // Always asked first: the host pairs each call with the gate's decision for it (one per allowed call).
    const access = this.host.access(name);
    const toolUseId = toolUseIdOf(extra) ?? access?.toolUseId;
    if (options.gui && this.batch.halted(toolUseId)) return errorResult(BATCH_HALT);
    if (!access) {
      if (options.gui) this.batch.fail(toolUseId);
      return errorResult(NOT_SEATED);
    }
    this.#onSeat(access.pcId, access.epoch);
    let result: CallToolResult;
    try {
      result = await body({ pcId: access.pcId, epoch: access.epoch, toolUseId });
    } catch (err) {
      result = this.errorOf(access.pcId, err);
    }
    if (options.gui && result.isError) this.batch.fail(toolUseId);
    return guardResult(result);
  }

  /**
   * An error of the PC layer as the agent should read it. A failure on MineVibe's side (the PC is down, or an
   * unexpected host error: a socket, a temp file) names no host path; the guest's own errors keep theirs (its paths,
   * and the Vault folders, which have the same path in the guest).
   */
  errorOf(pcId: string, err: unknown): CallToolResult {
    const keep = this.#infos.get(pcId)?.mounts.map((m) => m.hostPath) ?? [];
    const clean = (text: string) => redactHostPaths(text, HOST_ROOTS, keep);
    if (isApiError(err, PC_ERROR_CODES.PC_DOWN)) return errorResult(clean(`${pcId} is down: ${err.message}`));
    if (isApiError(err, PC_ERROR_CODES.DENIED) && /player sits|no longer sits|took over/i.test(err.message)) {
      return errorResult(playerTookOver(this.host.playerName?.() ?? 'The player', pcId));
    }
    if (isApiError(err)) return errorFrom(err);
    return errorResult(clean(`Error: ${err instanceof Error ? err.message : String(err)}`));
  }

  // ------------------------------------------------------------------------------------------- guest facts

  async info(pcId: string): Promise<PcGuestInfo> {
    const cached = this.#infos.get(pcId);
    if (cached) return cached;
    const fresh = await this.host.pcs.info(pcId);
    this.#infos.set(pcId, fresh);
    return fresh;
  }

  async freshInfo(pcId: string): Promise<PcGuestInfo> {
    this.#infos.delete(pcId);
    return this.info(pcId);
  }

  async geometry(pcId: string): Promise<ScreenGeometry> {
    return geometryFor((await this.info(pcId)).screen);
  }

  async cwdOf(pcId: string): Promise<string> {
    const known = this.#cwds.get(pcId);
    if (known) return known;
    const i = await this.info(pcId);
    return i.mounts.find((m) => m.mode === 'rw')?.hostPath ?? i.mounts[0]?.hostPath ?? i.home;
  }

  setCwd(pcId: string, cwd: string): void {
    this.#cwds.set(pcId, cwd);
  }

  /** An absolute guest path: `~` is the PC user's home, anything else relative is under the working directory. */
  async absolute(pcId: string, path: string): Promise<string> {
    if (path.startsWith('/')) return path;
    if (path === '~' || path.startsWith('~/')) {
      return `${(await this.info(pcId)).home.replace(/\/+$/, '')}${path.slice(1)}`;
    }
    return `${(await this.cwdOf(pcId)).replace(/\/+$/, '')}/${path}`;
  }

  /** A path relative to the working directory when it is inside it (Claude Code shows search results so). */
  async relative(pcId: string, path: string): Promise<string> {
    const cwd = (await this.cwdOf(pcId)).replace(/\/+$/, '');
    return path.startsWith(`${cwd}/`) ? path.slice(cwd.length + 1) : path;
  }

  // ------------------------------------------------------------------------------------------- screen

  /** A mutating computer action just ran: the next look waits for the screen to settle. */
  noteMutation(pcId: string): void {
    this.#lastMutation.set(pcId, Date.now());
  }

  async #thumbHash(pcId: string): Promise<string> {
    const s = await this.host.pcs.screenshot(pcId, { maxDim: 320, quality: 50, includeCursor: false });
    return createHash('sha1').update(s.data).digest('hex');
  }

  /**
   * Waits for the screen to stop changing when a mutating action ran recently: two equal 320 px thumbnails in a row,
   * after at least `minMs`, at most `maxMs`. Never throws.
   */
  async settle(pcId: string): Promise<void> {
    const t = this.settleTiming;
    const at = this.#lastMutation.get(pcId);
    if (at === undefined || Date.now() - at > t.windowMs) return;
    const start = Date.now();
    try {
      let prev = await this.#thumbHash(pcId);
      for (;;) {
        await sleep(t.pollMs);
        const cur = await this.#thumbHash(pcId);
        const elapsed = Date.now() - start;
        if ((cur === prev && elapsed >= t.minMs) || elapsed >= t.maxMs) return;
        prev = cur;
      }
    } catch {
      // a failed thumbnail: look anyway
    } finally {
      this.#lastMutation.delete(pcId);
    }
  }

  /** A full screenshot at the agent's geometry. */
  async capture(pcId: string): Promise<Screenshot> {
    const g = await this.geometry(pcId);
    return this.host.pcs.screenshot(pcId, { maxDim: Math.max(g.imgW, g.imgH), quality: 80 });
  }

  /**
   * The screen after an action: settled, and deduplicated against the last image this agent saw (`auto`), or always
   * an image (an explicit screenshot). Remembers what was sent.
   */
  async look(
    pcId: string,
    options: { auto: boolean },
  ): Promise<{ shot: Screenshot | null; unchanged: boolean }> {
    await this.settle(pcId);
    const shot = await this.capture(pcId);
    const hash = createHash('sha1').update(shot.data).digest('hex');
    if (options.auto && this.#lastImage.get(pcId) === hash) return { shot: null, unchanged: true };
    this.#lastImage.set(pcId, hash);
    return { shot, unchanged: false };
  }

  /** The windows now, and what changed since the agent last knew them (focus, new and closed windows). */
  async windowChange(pcId: string): Promise<{ windows: readonly GuestWindow[]; note: string }> {
    let now: readonly GuestWindow[];
    try {
      now = await this.host.pcs.windows(pcId);
    } catch {
      return { windows: [], note: '' };
    }
    const before = this.#lastWindows.get(pcId);
    this.#lastWindows.set(pcId, now);
    const focused = now.find((w) => w.focused);
    const parts: string[] = [];
    if (before) {
      const old = new Map(before.map((w) => [w.id, w]));
      const nowIds = new Set(now.map((w) => w.id));
      const wasFocused = before.find((w) => w.focused);
      if (focused && (focused.id !== wasFocused?.id || focused.title !== wasFocused.title)) {
        parts.push(`focused: "${windowLabel(focused)}"${old.has(focused.id) ? '' : ' (new window)'}`);
      }
      const opened = now.filter((w) => !old.has(w.id) && w.id !== focused?.id);
      for (const w of opened.slice(0, 3)) parts.push(`opened: "${windowLabel(w)}"`);
      const closed = before.filter((w) => !nowIds.has(w.id));
      for (const w of closed) this.refs.dropWindow(w.id);
      for (const w of closed.slice(0, 3)) parts.push(`closed: "${windowLabel(w)}"`);
    } else if (focused) {
      parts.push(`focused: "${windowLabel(focused)}"`);
    }
    return { windows: now, note: parts.join(' · ') };
  }

  /** Remembers a window list the agent was shown (so the next change note is relative to it). */
  knowWindows(pcId: string, windows: readonly GuestWindow[]): void {
    this.#lastWindows.set(pcId, windows);
  }

  /** One window line for listings. */
  describeWindow(w: GuestWindow, g: ScreenGeometry): string {
    const parts = [`"${windowLabel(w)}"`];
    if (w.app) parts.push(`(${w.app})`);
    if (w.focused) parts.push('focused');
    if (w.state && w.state !== 'NORMAL') parts.push(w.state.toLowerCase());
    if (!w.onScreen) parts.push('hidden');
    if (w.bounds) {
      const x = Math.round(w.bounds.x * g.scale);
      const y = Math.round(w.bounds.y * g.scale);
      parts.push(`${Math.round(w.bounds.w * g.scale)}x${Math.round(w.bounds.h * g.scale)} at (${x},${y})`);
    }
    if (isMirror(w)) parts.push(MIRROR_KEEP);
    return parts.join(' ');
  }
}
