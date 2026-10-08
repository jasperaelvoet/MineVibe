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

/** `MINEVIBE_CLAUDE`: `bundled` (dev only: the SDK's own binary) or an absolute path to a `claude`. */
export const CLAUDE_ENV = 'MINEVIBE_CLAUDE';

/** Which `claude` the agent sessions run. `path` undefined means the SDK's bundled binary. */
export interface ResolvedClaude {
  readonly source: 'user' | 'bundled' | 'override';
  readonly path: string | undefined;
  /** `claude --version`; null for the bundled binary (the SDK pins it). */
  readonly version: string | null;
}

export type ClaudeBinaryProblem = 'missing' | 'too_old' | 'unreadable' | 'bundled_unavailable';

/** Why no usable `claude` was found; `message` is the one-line instruction for the player. */
export class ClaudeBinaryError extends Error {
  readonly problem: ClaudeBinaryProblem;
  readonly found: string | null;
  readonly version: string | null;

  constructor(problem: ClaudeBinaryProblem, message: string, found: string | null, version: string | null) {
    super(message);
    this.name = 'ClaudeBinaryError';
    this.problem = problem;
    this.found = found;
    this.version = version;
  }
}

export interface ResolveClaudeOptions {
  /** Where `MINEVIBE_CLAUDE` and `PATH` are read (default `process.env`). */
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly home?: string;
  /** The allowlisted env `claude --version` runs with. */
  readonly versionEnv: Record<string, string>;
  /** Dev builds may use the SDK-bundled binary (release builds prune it). Default false. */
  readonly allowBundled?: boolean;
  /** Test seam for `claude --version`. */
  readonly readVersion?: (bin: string, env: Record<string, string>) => Promise<string | null>;
}

/**
 * Picks the `claude` binary for agent sessions (PLAN §2, §9.4):
 * 1. `MINEVIBE_CLAUDE=bundled` in dev: the SDK's own binary (`pathToClaudeCodeExecutable` unset).
 * 2. `MINEVIBE_CLAUDE=/abs/path`: that binary, if it is at least {@link MIN_CLAUDE_VERSION}.
 * 3. The user's own `claude` (`~/.local/bin/claude`, then PATH), at least {@link MIN_CLAUDE_VERSION}.
 * Anything else rejects with a {@link ClaudeBinaryError} whose message tells the player what to do.
 */
export async function resolveClaudeBinary(options: ResolveClaudeOptions): Promise<ResolvedClaude> {
  const env = options.env ?? process.env;
  const readVersion = options.readVersion ?? ((bin, e) => readClaudeVersion(bin, e));
  const choice = env[CLAUDE_ENV]?.trim() ?? '';

  if (choice === 'bundled') {
    if (!options.allowBundled) {
      throw new ClaudeBinaryError(
        'bundled_unavailable',
        `${CLAUDE_ENV}=bundled works only in development builds; install claude ${MIN_CLAUDE_VERSION} or newer`,
        null,
        null,
      );
    }
    return { source: 'bundled', path: undefined, version: null };
  }

  let bin: string | null;
  let source: ResolvedClaude['source'];
  if (choice.startsWith('/')) {
    source = 'override';
    bin = isExecutable(choice) ? choice : null;
    if (!bin)
      throw new ClaudeBinaryError('missing', `${CLAUDE_ENV} points at no executable claude`, choice, null);
  } else {
    source = 'user';
    bin = findClaudeBinary({ ...(options.home ? { home: options.home } : {}), path: env.PATH });
    if (!bin) {
      throw new ClaudeBinaryError(
        'missing',
        'Claude Code is not installed: install it from claude.ai/code, then run `claude` once to log in',
        null,
        null,
      );
    }
  }
  const version = await readVersion(bin, options.versionEnv);
  if (version === null) {
    throw new ClaudeBinaryError('unreadable', `could not run \`${bin} --version\``, bin, null);
  }
  if (compareVersions(version, MIN_CLAUDE_VERSION) < 0) {
    throw new ClaudeBinaryError(
      'too_old',
      `claude ${version} is too old (need ${MIN_CLAUDE_VERSION}): run \`claude update\``,
      bin,
      version,
    );
  }
  return { source, path: bin, version };
}
