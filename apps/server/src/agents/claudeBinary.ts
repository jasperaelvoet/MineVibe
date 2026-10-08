import { execFile } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';

/** Haiku 5.5 effort control needs at least this Claude Code version (PLAN §2). */
export const MIN_CLAUDE_VERSION = '2.1.293';

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Locates the user's own `claude`: `~/.local/bin/claude` (the native installer's location), then the
 * given PATH. Returns an absolute path or null. Nothing relies on the LaunchServices PATH in release.
 */
export function findClaudeBinary(options: { home?: string; path?: string | undefined } = {}): string | null {
  const home = options.home ?? homedir();
  const candidates = [join(home, '.local', 'bin', 'claude')];
  for (const dir of (options.path ?? process.env.PATH ?? '').split(delimiter)) {
    if (dir.startsWith('/')) candidates.push(join(dir, 'claude'));
  }
  return candidates.find(isExecutable) ?? null;
}

/** Extracts `x.y.z` from `claude --version` output such as "2.1.293 (Claude Code)". */
export function parseClaudeVersion(output: string): string | null {
  return /(\d+\.\d+\.\d+)/.exec(output)?.[1] ?? null;
}

/** Numeric semver-core comparison: negative, zero or positive. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** Runs `<bin> --version` with the given (allowlisted) env. Resolves null on failure or timeout. */
export function readClaudeVersion(
  bin: string,
  env: Record<string, string>,
  timeoutMs = 5000,
): Promise<string | null> {
  return new Promise((resolvePromise) => {
    execFile(bin, ['--version'], { env, timeout: timeoutMs, windowsHide: true }, (err, stdout) => {
      resolvePromise(err ? null : parseClaudeVersion(String(stdout)));
    });
  });
}
