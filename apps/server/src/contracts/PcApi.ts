/**
 * PcApi: the guest operations the `pc` MCP tool server (T3, `mcp__pc__*`) needs from the PC manager (spacesd clients,
 * PLAN §6.2, §8). All file and shell work runs inside the guest; the host never opens a path an agent controls.
 *
 * The agent-facing semantics (Read's `cat -n` output, Edit's exact-string replace, Grep's output modes, the 30k
 * character cap, the `__MV_PWD__` cwd tracking, `agentId:seatEpoch` tags) are the tool server's job; this interface
 * is the raw guest capability under it. Failures reject with {@link ApiError} and one of {@link PC_ERROR_CODES}.
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

/** Pointer actions in guest pixels. */
export type PointerAction =
  | { readonly action: 'move'; readonly x: number; readonly y: number }
  | {
      readonly action: 'click' | 'double_click' | 'right_click' | 'down' | 'up';
      readonly x: number;
      readonly y: number;
      readonly button?: 'left' | 'right' | 'middle' | undefined;
    }
  | {
      readonly action: 'drag';
      readonly x: number;
      readonly y: number;
      readonly toX: number;
      readonly toY: number;
    }
  | {
      readonly action: 'scroll';
      readonly x: number;
      readonly y: number;
      readonly dx: number;
      readonly dy: number;
    };

/** Keys are cua key names (`KEY_ENTER`, `ctrl`, `a`). `press` with several keys is a chord (hotkey). */
export interface KeyboardAction {
  readonly action: 'press' | 'down' | 'up';
  readonly keys: readonly string[];
}

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
  | { readonly kind: 'background'; readonly jobId: string };

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
  readonly headLimit?: number | undefined;
}

export interface GrepResult {
  /** ripgrep's output for the mode (`path:line:text`, file paths, or `path:count`). */
  readonly output: string;
  /** Matching lines (content), files (files_with_matches) or the total count (count). */
  readonly matches: number;
  readonly truncated: boolean;
}

export interface PcApi {
  info(pcId: string): Promise<PcGuestInfo>;
  screenshot(pcId: string, options?: { maxDim?: number | undefined }): Promise<Screenshot>;
  pointer(pcId: string, action: PointerAction): Promise<void>;
  keyboard(pcId: string, action: KeyboardAction): Promise<void>;
  /** Types text (layout-independent). */
  type(pcId: string, text: string): Promise<void>;
  clipboardGet(pcId: string): Promise<string>;
  clipboardSet(pcId: string, text: string): Promise<void>;

  /** Runs a command; rejects with `TIMEOUT` when a foreground command overruns (it is killed). */
  exec(pcId: string, request: ExecRequest): Promise<ExecResult>;
  jobOutput(pcId: string, jobId: string, fromOffset?: number): Promise<JobOutput>;
  /** Kills one background job, or every process with `tag` (kick, stand-up). Returns how many were killed. */
  kill(pcId: string, target: { readonly jobId: string } | { readonly tag: string }): Promise<number>;

  readFile(pcId: string, request: ReadRequest): Promise<ReadResult>;
  /** Creates parent directories. Returns the bytes written. */
  writeFile(pcId: string, path: string, content: string): Promise<number>;
  /** Exact-string replace with Edit's semantics. Returns the number of replacements. */
  editFile(pcId: string, request: EditRequest): Promise<number>;
  /** Matching paths, newest first. */
  glob(
    pcId: string,
    request: GlobRequest,
  ): Promise<{ readonly paths: readonly string[]; readonly truncated: boolean }>;
  grep(pcId: string, request: GrepRequest): Promise<GrepResult>;
}
