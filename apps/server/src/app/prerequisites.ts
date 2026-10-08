import { execFile } from 'node:child_process';
import { accessSync, constants, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { agentEnv } from '../agents/agentEnv.js';
import {
  ClaudeBinaryError,
  MIN_CLAUDE_VERSION,
  type ResolvedClaude,
  resolveClaudeBinary,
} from '../agents/claudeBinary.js';
import { SERVER_VERSION } from '../version.js';

/**
 * First-run prerequisites of MineVibe.app (PLAN §9.3 step 1): Apple Silicon, macOS 26 or later, and the user's own
 * `claude` installed, logged in and at least {@link MIN_CLAUDE_VERSION}. Every problem carries a one-line
 * instruction for the stub's dialog ("run `claude update`"). Dev builds may run the SDK-bundled claude instead
 * (`MINEVIBE_CLAUDE=bundled`, PLAN §9.4).
 */

/** The oldest macOS MineVibe runs on (Info.plist's LSMinimumSystemVersion is 26.0 too). */
export const MIN_MACOS_MAJOR = 26;

export type PrereqId = 'apple_silicon' | 'macos' | 'claude' | 'claude_login';

export interface PrereqProblem {
  readonly id: PrereqId;
  /** The dialog's headline. */
  readonly message: string;
  /** One line: what the player does about it. */
  readonly instruction: string;
}

export interface PrereqReport {
  readonly ok: boolean;
  readonly problems: readonly PrereqProblem[];
  /** `sw_vers -productVersion`, or null when it could not be read. */
  readonly macos: string | null;
  /** The claude agents will run (null when none passed). */
  readonly claude: ResolvedClaude | null;
  /** `claude auth status`: true/false, or null when it could not be told (never fatal). */
  readonly loggedIn: boolean | null;
}

/** What `claude auth status --json` says, reduced to what MineVibe needs (never the account's email or org). */
export interface ClaudeAuthStatus {
  readonly loggedIn: boolean;
  readonly authMethod: string | null;
  readonly apiProvider: string | null;
}

export interface PrereqOptions {
  /** Where `MINEVIBE_CLAUDE` and `PATH` are read (default `process.env`). */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Dev builds may use the SDK-bundled claude (`MINEVIBE_CLAUDE=bundled`). */
  readonly allowBundled: boolean;
  readonly home?: string;
  /** Test seams. */
  readonly platform?: NodeJS.Platform;
  readonly appleSilicon?: () => Promise<boolean>;
  readonly macosVersion?: () => Promise<string | null>;
  readonly resolveClaude?: typeof resolveClaudeBinary;
  readonly readVersion?: (bin: string, env: Record<string, string>) => Promise<string | null>;
  readonly authStatus?: (bin: string, env: Record<string, string>) => Promise<ClaudeAuthStatus | null>;
  readonly bundledClaude?: () => string | null;
}

function run(file: string, args: readonly string[], env: NodeJS.ProcessEnv, timeoutMs: number) {
  return new Promise<{ ok: boolean; stdout: string }>((resolvePromise) => {
    execFile(file, [...args], { env, timeout: timeoutMs, windowsHide: true }, (err, stdout) => {
      resolvePromise({ ok: !err, stdout: String(stdout ?? '') });
    });
  });
}

/** True on an Apple Silicon Mac (also when this Node itself runs translated). */
export async function isAppleSilicon(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): Promise<boolean> {
  if (platform !== 'darwin') return false;
  if (arch === 'arm64') return true;
  const r = await run('/usr/sbin/sysctl', ['-n', 'hw.optional.arm64'], { LC_ALL: 'C' }, 3000);
  return r.ok && r.stdout.trim() === '1';
}

/**
 * The macOS product version (`26.0.1`): `sw_vers -productVersion`, else `SystemVersion.plist`. The compat shim
 * (`SYSTEM_VERSION_COMPAT`) is kept out, so an old-style 10.16/16.0 never hides the real version.
 */
export async function readMacosVersion(): Promise<string | null> {
  const r = await run('/usr/bin/sw_vers', ['-productVersion'], { LC_ALL: 'C' }, 3000);
  const version = r.ok ? r.stdout.trim() : '';
  if (/^\d+(\.\d+)*$/.test(version)) return version;
  try {
    const plist = readFileSync('/System/Library/CoreServices/SystemVersion.plist', 'utf8');
    return /<key>ProductVersion<\/key>\s*<string>([\d.]+)<\/string>/.exec(plist)?.[1] ?? null;
  } catch {
    return null;
  }
}

/** `macOS 27.0.1` → 27; null for anything unparsable. */
export function macosMajor(version: string | null): number | null {
  const m = /^(\d+)/.exec(version ?? '');
  return m ? Number(m[1]) : null;
}

/**
 * Parses `claude auth status --json`. Only `loggedIn`, `authMethod` and `apiProvider` are kept: the rest (email,
 * organisation) is the user's business, and none of it is ever logged.
 */
export function parseAuthStatus(stdout: string): ClaudeAuthStatus | null {
  const text = stdout.trim();
  const start = text.indexOf('{');
  if (start < 0) return null;
  try {
    const v = JSON.parse(text.slice(start)) as Record<string, unknown>;
    if (typeof v.loggedIn !== 'boolean') return null;
    return {
      loggedIn: v.loggedIn,
      authMethod: typeof v.authMethod === 'string' ? v.authMethod : null,
      apiProvider: typeof v.apiProvider === 'string' ? v.apiProvider : null,
    };
  } catch {
    return null;
  }
}

/** Runs `<bin> auth status --json` with the agents' allowlisted env. Null when it fails to answer. */
export async function readClaudeAuthStatus(
  bin: string,
  env: Record<string, string>,
  timeoutMs = 10_000,
): Promise<ClaudeAuthStatus | null> {
  // A logged-out claude exits non-zero but still prints the JSON.
  const r = await run(bin, ['auth', 'status', '--json'], env, timeoutMs);
  return parseAuthStatus(r.stdout);
}

/** The SDK's own claude binary (`@anthropic-ai/claude-agent-sdk-<platform>-<arch>/claude`), when this build has it. */
export function bundledClaudePath(from: string = import.meta.url): string | null {
  try {
    const pkg = createRequire(from).resolve(
      `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/package.json`,
    );
    const bin = join(dirname(pkg), 'claude');
    accessSync(bin, constants.X_OK);
    return bin;
  } catch {
    return null;
  }
}

function claudeProblem(err: ClaudeBinaryError): PrereqProblem {
  switch (err.problem) {
    case 'missing':
      return err.found
        ? {
            id: 'claude',
            message: 'MINEVIBE_CLAUDE points at no claude',
            instruction: `Fix or unset MINEVIBE_CLAUDE (${err.found} is not an executable claude).`,
          }
        : {
            id: 'claude',
            message: 'Claude Code is not installed',
            instruction:
              'Install Claude Code from claude.ai/code, then run `claude` once in Terminal to log in.',
          };
    case 'too_old':
      return {
        id: 'claude',
        message: err.version ? `Claude Code ${err.version} is too old` : 'Claude Code is too old',
        instruction: `Run \`claude update\` in Terminal (MineVibe needs ${MIN_CLAUDE_VERSION} or newer), then open MineVibe again.`,
      };
    case 'bundled_unavailable':
      return {
        id: 'claude',
        message: 'MINEVIBE_CLAUDE=bundled works only in development builds',
        instruction: `Unset MINEVIBE_CLAUDE and install Claude Code ${MIN_CLAUDE_VERSION} or newer from claude.ai/code.`,
      };
    default:
      return {
        id: 'claude',
        message: 'Claude Code does not start',
        instruction: 'Run `claude --version` in Terminal to see why, or reinstall it from claude.ai/code.',
      };
  }
}

/**
 * Checks everything a launch needs before anything is installed or started. Never throws: problems come back
 * in the report, the platform ones first. The login check runs only once a usable claude was found; when it cannot
 * tell (no answer, unparsable output) it does not block the launch, since the agents' own startup check
 * (T3 `checkStartup`) still guards the sessions.
 */
export async function checkPrerequisites(options: PrereqOptions): Promise<PrereqReport> {
  const env = options.env ?? process.env;
  const problems: PrereqProblem[] = [];
  const platform = options.platform ?? process.platform;

  const [silicon, macos] = await Promise.all([
    (options.appleSilicon ?? (() => isAppleSilicon(platform)))(),
    platform === 'darwin' ? (options.macosVersion ?? readMacosVersion)() : Promise.resolve(null),
  ]);
  if (!silicon) {
    problems.push({
      id: 'apple_silicon',
      message: 'MineVibe needs a Mac with Apple silicon',
      instruction: 'Run MineVibe on a Mac with an M-series chip (Apple silicon).',
    });
  }
  const major = macosMajor(macos);
  if (platform !== 'darwin' || (major !== null && major < MIN_MACOS_MAJOR)) {
    problems.push({
      id: 'macos',
      message: `MineVibe needs macOS ${MIN_MACOS_MAJOR} or later${macos ? ` (this Mac runs ${macos})` : ''}`,
      instruction: `Update macOS to ${MIN_MACOS_MAJOR} or later in System Settings → General → Software Update.`,
    });
  }

  const versionEnv = agentEnv({ version: SERVER_VERSION, source: env });
  let claude: ResolvedClaude | null = null;
  try {
    claude = await (options.resolveClaude ?? resolveClaudeBinary)({
      env,
      versionEnv,
      allowBundled: options.allowBundled,
      ...(options.home ? { home: options.home } : {}),
      ...(options.readVersion ? { readVersion: options.readVersion } : {}),
    });
  } catch (err) {
    if (err instanceof ClaudeBinaryError) problems.push(claudeProblem(err));
    else
      problems.push({
        id: 'claude',
        message: 'Claude Code could not be checked',
        instruction: `Run \`claude --version\` in Terminal (${err instanceof Error ? err.message : String(err)}).`,
      });
  }

  let loggedIn: boolean | null = null;
  if (claude) {
    const bin = claude.path ?? (options.bundledClaude ?? bundledClaudePath)();
    if (!bin && claude.source === 'bundled') {
      claude = null;
      problems.push({
        id: 'claude',
        message: 'This build has no SDK claude (MINEVIBE_CLAUDE=bundled)',
        instruction: `Unset MINEVIBE_CLAUDE and install Claude Code ${MIN_CLAUDE_VERSION} or newer from claude.ai/code.`,
      });
    } else if (bin) {
      const status = await (options.authStatus ?? readClaudeAuthStatus)(bin, versionEnv);
      loggedIn = status?.loggedIn ?? null;
      if (status && !status.loggedIn) {
        problems.push({
          id: 'claude_login',
          message: 'Claude Code is not logged in',
          instruction:
            'Run `claude` in Terminal and log in with your Claude account, then open MineVibe again.',
        });
      }
    }
  }
  return { ok: problems.length === 0, problems, macos, claude, loggedIn };
}

/** The stub dialog for a failed check: the first problem's headline, and every instruction, one per line. */
export function describePrerequisites(report: PrereqReport): { message: string; detail: string } {
  const first = report.problems[0];
  if (!first) return { message: 'MineVibe is ready', detail: '' };
  const lines = [...new Set(report.problems.map((p) => p.instruction))];
  const more = report.problems.slice(1).map((p) => p.message);
  return {
    message: first.message,
    detail: [...lines, ...(more.length ? ['', `Also: ${more.join('; ')}.`] : [])].join('\n'),
  };
}
