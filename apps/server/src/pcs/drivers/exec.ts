import { spawn } from 'node:child_process';

/** Outcome of one CLI call. Never thrown; callers decide what a failure means. */
export interface ExecResult {
  /** Exit code, or null when the process was killed by a signal or failed to spawn. */
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  /** Wall time in ms. */
  ms: number;
  /** True when the Node-side timeout fired and the process was SIGKILLed. */
  timedOut: boolean;
  /** Spawn error (ENOENT and friends). */
  error?: string;
}

export interface ExecOptions {
  /** Hard Node-side timeout; the child's process group is SIGKILLed when it overruns (apple/container#2275). Required. */
  timeoutMs: number;
  /** Full child environment (callers merge `process.env` themselves). */
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  /** Written to stdin, which is then closed. Without it stdin is closed immediately. */
  input?: string;
  /** Streaming stdout/stderr callbacks (progress). */
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
  /** Cap on captured output per stream (default 16 MiB); excess is dropped. */
  maxBuffer?: number;
  signal?: AbortSignal;
  /**
   * After the child exits (or is killed), how long to wait for its stdout/stderr to close before resolving
   * anyway (default 2 s). A grandchild that inherited the pipes would otherwise hold the call open.
   */
  exitGraceMs?: number;
}

/** Runs one command with a hard timeout. The promise always resolves. */
export type ExecFn = (file: string, args: readonly string[], options: ExecOptions) => Promise<ExecResult>;

/**
 * Spawns the command in its own process group, so a timeout or abort kills the whole group (the CLI and
 * any helper it forked), and resolves at the latest `exitGraceMs` after the child exits or is killed
 * (L2), even when a grandchild still holds the output pipes.
 */
export const execWithTimeout: ExecFn = (file, args, options) =>
  new Promise((resolvePromise) => {
    const t0 = performance.now();
    const maxBuffer = options.maxBuffer ?? 16 * 1024 * 1024;
    const graceMs = options.exitGraceMs ?? 2000;
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let graceTimer: NodeJS.Timeout | undefined;
    const finish = (r: Omit<ExecResult, 'ms' | 'stdout' | 'stderr' | 'timedOut'>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (graceTimer) clearTimeout(graceTimer);
      options.signal?.removeEventListener('abort', onAbort);
      // Stop reading pipes a lingering grandchild may still hold, so they don't keep the loop alive.
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolvePromise({ ...r, stdout, stderr, timedOut, ms: Math.round(performance.now() - t0) });
    };
    const child = spawn(file, [...args], {
      env: options.env ?? process.env,
      cwd: options.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    });
    const killGroup = () => {
      const pid = child.pid;
      try {
        if (pid) process.kill(-pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {
        try {
          child.kill('SIGKILL');
        } catch {}
      }
      // Whatever happens next, resolve within the grace period.
      graceTimer ??= setTimeout(() => finish({ code: null, signal: 'SIGKILL' }), graceMs);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup();
    }, options.timeoutMs);
    const onAbort = () => killGroup();
    options.signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d: string) => {
      if (stdout.length < maxBuffer) stdout += d;
      options.onStdout?.(d);
    });
    child.stderr.on('data', (d: string) => {
      if (stderr.length < maxBuffer) stderr += d;
      options.onStderr?.(d);
    });
    child.stdout.on('error', () => {});
    child.stderr.on('error', () => {});
    child.stdin.on('error', () => {});
    if (options.input !== undefined) child.stdin.end(options.input);
    else child.stdin.end();
    child.on('error', (err) => finish({ code: null, signal: null, error: String(err) }));
    child.on('exit', (code, signal) => {
      // 'close' normally follows once the pipes drain; don't wait forever for it.
      if (graceTimer) clearTimeout(graceTimer);
      graceTimer = setTimeout(() => finish({ code, signal }), graceMs);
    });
    child.on('close', (code, signal) => finish({ code, signal }));
  });

/**
 * Parses CLI JSON output without ever echoing it: V8's `JSON.parse` errors quote the input, and
 * `container inspect`/`list` output holds `CUA_ENV_TOKEN` in plaintext (L5).
 */
export function parseCliJson<T>(what: string, text: string): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`${what}: unparsable JSON output (${text.length} bytes)`);
  }
}

/** Matches `NAME=value` for env names that carry secrets, wherever they appear in CLI output. */
const SECRET_ENV_RE = /\b(CUA_ENV_TOKEN|[A-Z0-9_]*TOKEN|[A-Z0-9_]*SECRET|[A-Z0-9_]*API_KEY)=([^\s"',\]]+)/g;

/**
 * Removes secrets from text before it reaches a log or an error message: every literal in `secrets`
 * and every `*TOKEN=…`/`*SECRET=…`/`*API_KEY=…` assignment.
 */
export function redact(text: string, secrets: readonly string[] = []): string {
  let out = text.replace(SECRET_ENV_RE, '$1=<redacted>');
  for (const s of secrets) {
    if (s && s.length >= 6) out = out.split(s).join('<redacted>');
  }
  return out;
}

/** Thrown for a failed CLI call; the message carries redacted, truncated stderr. */
export class CliError extends Error {
  readonly code: number | null;
  readonly timedOut: boolean;
  readonly stderr: string;

  constructor(what: string, r: ExecResult, secrets: readonly string[] = []) {
    const stderr = redact((r.stderr || r.error || r.stdout).trim(), secrets).slice(0, 2000);
    const why = r.timedOut ? `timed out after ${r.ms} ms` : `exit ${r.code ?? r.signal ?? 'spawn error'}`;
    super(`${what}: ${why}${stderr ? `: ${stderr}` : ''}`);
    this.name = 'CliError';
    this.code = r.code;
    this.timedOut = r.timedOut;
    this.stderr = stderr;
  }
}
