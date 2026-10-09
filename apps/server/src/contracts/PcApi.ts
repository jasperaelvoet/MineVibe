/**
 * PcApi: the guest operations the `pc` MCP tool server (T3, `mcp__pc__*`) needs from the PC manager (spacesd clients,
 * PLAN §6.2, §8). All file and shell work runs inside the guest; the host never opens a path an agent controls.
 *
 * The agent-facing semantics (Read's numbered lines, Edit's exact-string replace, Grep's output modes, the 30k
 * character cap, the `__MV_PWD__` cwd tracking, `agentId:seatEpoch` tags, screenshot scaling, accessibility refs) are
 * the tool server's job; this interface is the raw guest capability under it. Coordinates here are always guest
 * (screen) pixels. Failures reject with {@link ApiError} and one of {@link PC_ERROR_CODES}.
 */

import type { PcStatus, PcType, VaultMount } from '@minevibe/protocol';

/** PcApi error codes (module-local; never sent to the mod as such). */
export const PC_ERROR_CODES = {
  /** No such PC. */
  PC_UNKNOWN: 'PC_UNKNOWN',
  /** The PC is not `running` (or spacesd is not SERVING). */
  PC_DOWN: 'PC_DOWN',
  /** The guest path does not exist. */
  NOT_FOUND: 'NOT_FOUND',
  /** The guest path is a directory where a file was expected (or the reverse). */
  NOT_A_FILE: 'NOT_A_FILE',
  /** edit: `oldString` does not occur in the file. */
  EDIT_NOT_FOUND: 'EDIT_NOT_FOUND',
  /** edit: `oldString` occurs more than once and `replaceAll` is false. */
  EDIT_AMBIGUOUS: 'EDIT_AMBIGUOUS',
  /** A foreground command or call exceeded its timeout (the process was killed). */
  TIMEOUT: 'TIMEOUT',
  /** No such background job. */
  UNKNOWN_JOB: 'UNKNOWN_JOB',
  /** The guest refused (permissions, read-only mount). */
  DENIED: 'DENIED',
  /** spacesd failed. */
  GUEST_ERROR: 'GUEST_ERROR',
  /** A coordinate outside the screen. */
  OUT_OF_BOUNDS: 'OUT_OF_BOUNDS',
  /** An accessibility snapshot (or element) that is gone: the window changed since it was read. */
  STALE_REF: 'STALE_REF',
  /** The PC (or the app) exposes no accessibility tree. */
  A11Y_UNAVAILABLE: 'A11Y_UNAVAILABLE',
  /** No such window (closed, or never there). */
  WINDOW_NOT_FOUND: 'WINDOW_NOT_FOUND',
  /** Nothing opened the target. */
  OPEN_FAILED: 'OPEN_FAILED',
  /** write/edit: the file changed since it was read. */
  STALE_FILE: 'STALE_FILE',
  /** write/edit: an existing file that was never read. */
  NOT_READ: 'NOT_READ',
} as const;
export type PcErrorCode = (typeof PC_ERROR_CODES)[keyof typeof PC_ERROR_CODES];

/** Limits shared by the tool server and the implementation (PLAN §6.2). */
export const PC_LIMITS = {
  /** Default foreground timeout. */
  defaultTimeoutMs: 120_000,
  /** Largest foreground timeout. */
  maxTimeoutMs: 600_000,
  /** Output cap per call, in characters. */
  maxOutputChars: 30_000,
  /** How long a background job may run by default (Claude Code 2.x: 30 min). */
  defaultJobLifetimeMs: 1_800_000,
  /** Longest background job lifetime (2 h). */
  maxJobLifetimeMs: 7_200_000,
  /**
   * Largest text of any one `pc` tool result (PC tools V2, D7). Above Claude Code's MCP output limit the CLI saves a
   * result to a host file and tells the model to Read it, which the aliased Read cannot reach, so results stay below.
   */
  maxResultChars: 60_000,
} as const;

export interface PcGuestInfo {
  readonly pcId: string;
  readonly type: PcType;
  readonly status: PcStatus;
  readonly os: 'linux' | 'macos';
  /** Guest screen size in pixels. */
  readonly screen: { readonly w: number; readonly h: number };
  /** The unprivileged guest user (`cua`) and its home. */
  readonly user: string;
  readonly home: string;
  /** Vault folders, mounted at the identical path. */
  readonly mounts: readonly VaultMount[];
  /** Read-only Codex export (`/mnt/codex`). */
  readonly codexPath: string | null;
  /** Allocated vCPUs and memory, when known. */
  readonly cpus?: number;
  readonly memoryMiB?: number;
  /** The guest OS ("Ubuntu 24.04"), when the PC runs. */
  readonly osVersion?: string;
}

/** A rectangle in guest pixels. */
export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export interface ScreenshotOptions {
  /** Longest image edge in pixels (the image is scaled down to it; never up). */
  readonly maxDim?: number | undefined;
  /** Capture only this part of the screen (guest pixels), at full resolution unless `maxDim` is smaller. */
  readonly region?: Rect | undefined;
  /**
   * With `region`: scale the region (up or down, aspect kept) to fit inside this size (zoom: small text becomes
   * legible). Best effort: a guest that cannot scale returns the region at full resolution.
   */
  readonly fit?: { readonly w: number; readonly h: number } | undefined;
  /** JPEG quality (default 80). */
  readonly quality?: number | undefined;
  /** Draw the pointer into the image (default true). */
  readonly includeCursor?: boolean | undefined;
  /** Image format (default JPEG). */
  readonly format?: 'jpeg' | 'png' | undefined;
}

export interface Screenshot {
  readonly mime: 'image/jpeg' | 'image/png';
  readonly data: Uint8Array;
  readonly w: number;
  readonly h: number;
  /** The guest screen in pixels (pointer coordinates), when known. */
  readonly screen?: { readonly w: number; readonly h: number };
  /** Image pixels per guest pixel (below 1 when the image was scaled down to `maxDim`). */
  readonly scale?: number;
}

/** Modifier and key names are cua names (`KEY_CONTROL`) or the aliases InputRouter understands (`ctrl`). */
export type PointerAction =
  | { readonly action: 'move'; readonly x: number; readonly y: number }
  | {
      readonly action: 'click' | 'double_click' | 'right_click';
      /** Guest pixels; both omitted: at the pointer. */
      readonly x?: number | undefined;
      readonly y?: number | undefined;
      readonly button?: 'left' | 'right' | 'middle' | undefined;
      /** 1-3 (a triple click selects a line); `double_click` is 2. */
      readonly count?: number | undefined;
      /** Keys held during the click. */
      readonly modifiers?: readonly string[] | undefined;
    }
  | {
      readonly action: 'down' | 'up';
      /** Both omitted: at the pointer. */
      readonly x?: number | undefined;
      readonly y?: number | undefined;
      readonly button?: 'left' | 'right' | 'middle' | undefined;
    }
  | {
      readonly action: 'drag';
      readonly x: number;
      readonly y: number;
      readonly toX: number;
      readonly toY: number;
      readonly modifiers?: readonly string[] | undefined;
    }
  | {
      readonly action: 'scroll';
      /** Both omitted: at the pointer. */
      readonly x?: number | undefined;
      readonly y?: number | undefined;
      /** Wheel notches: dy > 0 scrolls down, dx > 0 right. */
      readonly dx: number;
      readonly dy: number;
      readonly modifiers?: readonly string[] | undefined;
    };

/**
 * Keys are cua key names (`KEY_ENTER`), single characters or InputRouter aliases (`ctrl`, `Page_Down`).
 * - `press`: the keys together (a chord), `repeat` times.
 * - `down` / `up`: key down or up events (held keys are released on every occupant change).
 * - `sequence`: chords one after the other (`ctrl+a Delete`).
 * - `hold`: the keys down for `ms`, then up in reverse order.
 */
export type KeyboardAction =
  | { readonly action: 'press'; readonly keys: readonly string[]; readonly repeat?: number | undefined }
  | { readonly action: 'down' | 'up'; readonly keys: readonly string[] }
  | {
      readonly action: 'sequence';
      readonly chords: readonly (readonly string[])[];
      readonly repeat?: number | undefined;
    }
  | { readonly action: 'hold'; readonly keys: readonly string[]; readonly ms: number };

export interface ExecRequest {
  /** Run through `bash -lc` as the guest user. */
  readonly command: string;
  /** Working directory in the guest; default the user's home. */
  readonly cwd?: string | undefined;
  /** Foreground timeout, default {@link PC_LIMITS.defaultTimeoutMs}, at most {@link PC_LIMITS.maxTimeoutMs}. */
  readonly timeoutMs?: number | undefined;
  /** Start as a background job and return its id at once. */
  readonly background?: boolean | undefined;
  readonly env?: Readonly<Record<string, string>> | undefined;
  /** Tag for later kills, `agentId:seatEpoch` (PLAN §6.2). */
  readonly tag: string;
  /** `sudo -n` in the guest (PLAN §8.6 "Users"); default false. */
  readonly root?: boolean | undefined;
  /**
   * What an overrunning foreground command becomes: `kill` (default; rejects with TIMEOUT) or `background` (it keeps
   * running as a background job, Claude Code 2.x).
   */
  readonly onTimeout?: 'kill' | 'background' | undefined;
  /** How long a background job may run before it is killed (default and cap in {@link PC_LIMITS}). */
  readonly lifetimeMs?: number | undefined;
  /** The job id to use when the command runs (or ends up) in the background (`[a-z0-9]{4,24}`); default random. */
  readonly jobId?: string | undefined;
  /** Tee the output to `~/.mv/jobs/<jobId>.out` in the guest (kept only when the command runs in the background). */
  readonly outputFile?: boolean | undefined;
}

export type ExecResult =
  | {
      readonly kind: 'done';
      readonly exitCode: number;
      /** stdout and stderr interleaved, capped at {@link PC_LIMITS.maxOutputChars}. */
      readonly output: string;
      readonly truncated: boolean;
      readonly durationMs: number;
    }
  | {
      readonly kind: 'background';
      readonly jobId: string;
      /** The guest file the output is teed to (with `outputFile`). */
      readonly outputPath?: string | undefined;
      /** Set when a foreground command overran its timeout and was moved to the background. */
      readonly timedOutAfterMs?: number | undefined;
      /** When the job is killed unless it ends first. */
      readonly lifetimeMs?: number | undefined;
    };

export interface JobOutput {
  readonly jobId: string;
  readonly running: boolean;
  readonly exitCode: number | null;
  /** Output since `fromOffset`. */
  readonly output: string;
  /** Pass as `fromOffset` next time. */
  readonly nextOffset: number;
  readonly truncated: boolean;
}

/** Why a background job ended. */
export type JobEndReason =
  /** It exited on its own. */
  | 'exited'
  /** Killed by id (`task_stop`). */
  | 'stopped'
  /** Killed at the end of its lifetime. */
  | 'lifetime'
  /** Killed because its seat ended (stand-up, kick). */
  | 'seat'
  /** The PC stopped, or MineVibe lost track of it. */
  | 'lost';

export interface JobExit {
  readonly pcId: string;
  readonly jobId: string;
  /** `agentId:seatEpoch`. */
  readonly tag: string;
  readonly exitCode: number | null;
  readonly reason: JobEndReason;
  readonly outputPath?: string | undefined;
  readonly durationMs: number;
}

export interface ReadRequest {
  readonly path: string;
  /** 1-based first line. */
  readonly offset?: number | undefined;
  readonly limit?: number | undefined;
}

export interface ReadResult {
  /** The raw text of the selected lines (no line numbers). */
  readonly content: string;
  /** Line number of the first returned line. */
  readonly startLine: number;
  readonly totalLines: number;
  readonly truncated: boolean;
}

export interface EditRequest {
  readonly path: string;
  readonly oldString: string;
  readonly newString: string;
  readonly replaceAll?: boolean | undefined;
}

export interface GlobRequest {
  readonly pattern: string;
  /** Directory to search; default the cwd / home. */
  readonly path?: string | undefined;
}

export interface GlobResult {
  readonly paths: readonly string[];
  readonly truncated: boolean;
  /** How many paths matched in all (a floor when `countIsComplete` is false), when known. */
  readonly total?: number | undefined;
  readonly countIsComplete?: boolean | undefined;
}

export interface GrepRequest {
  /** A ripgrep regex. */
  readonly pattern: string;
  readonly path?: string | undefined;
  readonly glob?: string | undefined;
  /** ripgrep file type (`ts`, `py`). */
  readonly type?: string | undefined;
  readonly outputMode: 'content' | 'files_with_matches' | 'count';
  readonly caseInsensitive?: boolean | undefined;
  readonly lineNumbers?: boolean | undefined;
  readonly before?: number | undefined;
  readonly after?: number | undefined;
  readonly multiline?: boolean | undefined;
  /** content mode: print only the matched parts (`rg -o`). */
  readonly onlyMatching?: boolean | undefined;
  /** Lines (or entries) skipped before `headLimit` applies. */
  readonly offset?: number | undefined;
  /** At most this many lines (or entries) after `offset`; 0 or undefined: all. */
  readonly headLimit?: number | undefined;
}

export interface GrepResult {
  /** ripgrep's output for the mode (`path:line:text`, file paths, or `path:count`), after offset and head limit. */
  readonly output: string;
  /** Matching lines (content), files (files_with_matches) or the total count (count), over all results. */
  readonly matches: number;
  /** Lines (or entries) before offset and head limit. */
  readonly total?: number | undefined;
  /** count mode: files with at least one match. */
  readonly files?: number | undefined;
  readonly truncated: boolean;
}

export interface FileStat {
  readonly exists: boolean;
  readonly kind?: 'file' | 'dir' | 'other' | undefined;
  readonly size: number;
  /** Modification time in milliseconds (0 when unknown). */
  readonly mtimeMs: number;
}

/** A top-level window of the guest desktop. */
export interface GuestWindow {
  /** spacesd's window id (stable while the window lives). */
  readonly id: string;
  readonly title: string;
  readonly app: string;
  readonly pid?: number | undefined;
  /** Guest pixels. */
  readonly bounds?: Rect | undefined;
  readonly focused: boolean;
  /** NORMAL, MINIMIZED, MAXIMIZED, FULLSCREEN (spacesd's state without its prefix). */
  readonly state?: string | undefined;
  readonly onScreen: boolean;
  /** Stacking order: lower is closer to the front. */
  readonly z?: number | undefined;
}

export type WindowOp = 'activate' | 'maximize' | 'minimize' | 'restore' | 'close';

/** One accessibility element of a snapshot (spacesd `AccessibilityService`). */
export interface UiNode {
  readonly elementId: string;
  readonly parentId?: string | undefined;
  readonly depth: number;
  /** Normalized role (`button`, `text_field`, `menu_item`, `paragraph`). */
  readonly role: string;
  /** The toolkit's own role (`push button`, `text`). */
  readonly nativeRole?: string | undefined;
  readonly name?: string | undefined;
  readonly value?: string | undefined;
  readonly description?: string | undefined;
  /** Guest pixels; absent when the element has no on-screen box. */
  readonly bounds?: Rect | undefined;
  readonly states: readonly string[];
  /** `press`, `focus`, `set_value`, … (lowercase, without the enum prefix). */
  readonly actions: readonly string[];
}

export interface UiSnapshot {
  /** Pass to {@link PcApi.uiAct}; expires when the window changes enough. */
  readonly snapshotId: string;
  /** The window the snapshot is of, when spacesd says. */
  readonly windowId: string | null;
  readonly nodes: readonly UiNode[];
}

export type UiAction =
  | 'press'
  | 'focus'
  | 'set_value'
  | 'increment'
  | 'decrement'
  | 'show_menu'
  | 'expand'
  | 'collapse'
  | 'select'
  | 'scroll_into_view';

export interface UiFindRequest {
  /** Default the focused window. */
  readonly windowId?: string | undefined;
  readonly nameContains?: string | undefined;
  readonly valueContains?: string | undefined;
  /** spacesd's normalized role. */
  readonly role?: string | undefined;
  readonly maxResults?: number | undefined;
}

export interface UiTreeRequest {
  /** Default the focused window. */
  readonly windowId?: string | undefined;
  readonly maxDepth?: number | undefined;
  readonly maxNodes?: number | undefined;
  readonly includeHidden?: boolean | undefined;
}

export interface OpenRequest {
  /** An http(s)/file URL, an absolute guest path, or an app (executable or `.desktop` id). */
  readonly target: string;
  readonly args?: readonly string[] | undefined;
  /** `agentId:seatEpoch`: what the open starts is killed with the seat. */
  readonly tag: string;
  /** How long to wait for a window (default 15 s). */
  readonly waitMs?: number | undefined;
}

export interface OpenResult {
  /** The window that appeared (or changed its title and took the focus), or null when none did in time. */
  readonly window: GuestWindow | null;
  /** True when the window is new (not a reused one whose title changed). */
  readonly newWindow: boolean;
  /** How it was opened (`firefox`, `xdg-open`, `xfce4-terminal`). */
  readonly via: string;
}

export interface PcApi {
  info(pcId: string): Promise<PcGuestInfo>;
  screenshot(pcId: string, options?: ScreenshotOptions): Promise<Screenshot>;
  pointer(pcId: string, action: PointerAction): Promise<void>;
  keyboard(pcId: string, action: KeyboardAction): Promise<void>;
  /** Types text (layout-independent; "\n" presses Enter). */
  type(pcId: string, text: string): Promise<void>;
  /** The pointer position in guest pixels. */
  cursor(pcId: string): Promise<{ readonly x: number; readonly y: number }>;
  clipboardGet(pcId: string): Promise<string>;
  clipboardSet(pcId: string, text: string): Promise<void>;

  /** The desktop's top-level windows, front first. */
  windows(pcId: string): Promise<readonly GuestWindow[]>;
  /** Activates, maximizes, minimizes, restores or closes a window (needs the seated agent). */
  window(pcId: string, windowId: string, op: WindowOp): Promise<void>;
  /** Opens a URL, file or app and waits for its window (needs the seated agent; started under `tag`). */
  open(pcId: string, request: OpenRequest): Promise<OpenResult>;
  /** Accessibility elements matching a query (A11Y_UNAVAILABLE when the PC has no accessibility service). */
  uiFind(pcId: string, request: UiFindRequest): Promise<UiSnapshot>;
  /** A window's accessibility tree, as a flat list in document order with depths. */
  uiTree(pcId: string, request: UiTreeRequest): Promise<UiSnapshot>;
  /** Acts on one element of a snapshot (needs the seated agent); STALE_REF when the snapshot expired. */
  uiAct(
    pcId: string,
    request: {
      readonly snapshotId: string;
      readonly elementId: string;
      readonly action: UiAction;
      readonly value?: string | undefined;
    },
  ): Promise<void>;

  /** Runs a command; rejects with `TIMEOUT` when a foreground command overruns (unless `onTimeout: 'background'`). */
  exec(pcId: string, request: ExecRequest): Promise<ExecResult>;
  jobOutput(pcId: string, jobId: string, fromOffset?: number): Promise<JobOutput>;
  /** Kills one background job, or every process with `tag` (kick, stand-up). Returns how many were killed. */
  kill(pcId: string, target: { readonly jobId: string } | { readonly tag: string }): Promise<number>;
  /** Called once per background job when it ends (exit, kill, lifetime, seat end). Returns the unsubscribe. */
  onJobExit(listener: (exit: JobExit) => void): () => void;

  readFile(pcId: string, request: ReadRequest): Promise<ReadResult>;
  /** The raw bytes of a file (images), at most `maxBytes` (DENIED when larger). */
  readBytes(pcId: string, path: string, maxBytes: number): Promise<Uint8Array>;
  /** Size and modification time; `exists: false` for a missing path. */
  stat(pcId: string, path: string): Promise<FileStat>;
  /** Creates parent directories. Returns the bytes written. */
  writeFile(pcId: string, path: string, content: string): Promise<number>;
  /** Exact-string replace with Edit's semantics. Returns the number of replacements. */
  editFile(pcId: string, request: EditRequest): Promise<number>;
  /** Matching paths, newest first. */
  glob(pcId: string, request: GlobRequest): Promise<GlobResult>;
  grep(pcId: string, request: GrepRequest): Promise<GrepResult>;
}
