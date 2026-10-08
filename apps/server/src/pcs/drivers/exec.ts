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
  /** Hard Node-side timeout; the child is SIGKILLed when it overruns (apple/container#2275). Required. */
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
}

/** Runs one command with a hard timeout. The promise always resolves. */
export type ExecFn = (file: string, args: readonly string[], options: ExecOptions) => Promise<ExecResult>;

export const execWithTimeout: ExecFn = (file, args, options) =>
  new Promise((resolvePromise) => {
    const t0 = performance.now();
    const maxBuffer = options.maxBuffer ?? 16 * 1024 * 1024;
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const finish = (r: Omit<ExecResult, 'ms' | 'stdout' | 'stderr' | 'timedOut'>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      resolvePromise({ ...r, stdout, stderr, timedOut, ms: Math.round(performance.now() - t0) });
    };
    const child = spawn(file, [...args], {
      env: options.env ?? process.env,
      cwd: options.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, options.timeoutMs);
    const onAbort = () => child.kill('SIGKILL');
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
    child.stdin.on('error', () => {});
    if (options.input !== undefined) child.stdin.end(options.input);
    else child.stdin.end();
    child.on('error', (err) => finish({ code: null, signal: null, error: String(err) }));
    child.on('close', (code, signal) => finish({ code, signal }));
  });

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
