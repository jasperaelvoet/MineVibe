import { spawn } from 'node:child_process';

export interface RunOptions {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  /** Kill (SIGKILL) and fail after this long. Default 10 minutes. */
  readonly timeoutMs?: number;
  /** Stream the child's output to ours, prefixed (long steps such as Gradle). */
  readonly echo?: string;
}

export interface RunResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export class CommandError extends Error {
  readonly result: RunResult | null;

  constructor(message: string, result: RunResult | null) {
    super(message);
    this.name = 'CommandError';
    this.result = result;
  }
}

/** Runs a command without a shell; resolves with its output whatever the exit code. */
export function runCommand(
  command: string,
  args: readonly string[],
  options: RunOptions = {},
): Promise<RunResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const prefix = options.echo ? `[${options.echo}] ` : null;
    const echo = (chunk: string) => {
      if (prefix === null) return;
      for (const line of chunk.split('\n'))
        if (line.trim() !== '') process.stderr.write(`${prefix}${line}\n`);
    };
    child.stdout.setEncoding('utf8').on('data', (d: string) => {
      stdout += d;
      echo(d);
    });
    child.stderr.setEncoding('utf8').on('data', (d: string) => {
      stderr += d;
      echo(d);
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, options.timeoutMs ?? 600_000);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new CommandError(`cannot run ${command}: ${err.message}`, null));
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const result = { code: code ?? (signal ? 128 : 1), stdout, stderr };
      if (timedOut) reject(new CommandError(`${command} ${args.join(' ')} timed out`, result));
      else resolvePromise(result);
    });
  });
}

/** Like {@link runCommand}, but a non-zero exit is an error carrying the last lines of output. */
export async function run(
  command: string,
  args: readonly string[],
  options: RunOptions = {},
): Promise<RunResult> {
  const result = await runCommand(command, args, options);
  if (result.code !== 0) {
    const tail = `${result.stderr}\n${result.stdout}`.trim().split('\n').slice(-15).join('\n');
    throw new CommandError(`${command} ${args.join(' ')} exited with ${result.code}\n${tail}`, result);
  }
  return result;
}
