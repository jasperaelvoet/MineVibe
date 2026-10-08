import { homedir } from 'node:os';

/**
 * Environment variables copied from the parent process (PLAN §6.1). Everything else is dropped: every
 * `ANTHROPIC_*`, `CLAUDE_CODE_*`, `CLAUDECODE`, `CLAUDE_EFFORT`, `MCP_*`, `DISABLE_MICROCOMPACT`,
 * `CLAUDE_CONFIG_DIR`, proxies, `NODE_OPTIONS`, loader injection, and whatever else the shell holds.
 */
export const AGENT_ENV_PASSTHROUGH = ['HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'TMPDIR', 'TERM'] as const;

/**
 * The fixed PATH tail. `/usr/bin` must be present because claude calls `/usr/bin/security` for the
 * keychain login. The parent's PATH is never inherited.
 */
export const AGENT_SYSTEM_PATH = ['/usr/bin', '/bin', '/usr/sbin', '/sbin'] as const;

/** Value of `CLAUDE_AGENT_SDK_CLIENT_APP`. */
export function clientAppId(version: string): string {
  return `minevibe/${version}`;
}

export interface AgentEnvOptions {
  /** MineVibe version, for `CLAUDE_AGENT_SDK_CLIENT_APP=minevibe/<version>`. */
  version: string;
  /**
   * API-key mode (a user setting): injected as `ANTHROPIC_API_KEY` into the agent env only. Any
   * `ANTHROPIC_API_KEY` in the parent environment is ignored either way.
   */
  apiKey?: string | undefined;
  /** Environment to copy the allowlisted variables from (defaults to `process.env`). */
  source?: Readonly<Record<string, string | undefined>>;
  /** Absolute directories prepended to the fixed PATH (e.g. a bundled tool dir). */
  extraPath?: readonly string[];
}

/**
 * Builds the environment for a `claude` agent process as an allowlist (PLAN §6.1 "Environment hygiene").
 * The result contains only {@link AGENT_ENV_PASSTHROUGH}, an explicit `PATH`, the MineVibe-set flags and,
 * in API-key mode, `ANTHROPIC_API_KEY`. `CLAUDE_CONFIG_DIR` is never set.
 */
export function agentEnv(options: AgentEnvOptions): Record<string, string> {
  const source = options.source ?? process.env;
  const env: Record<string, string> = {};

  for (const name of AGENT_ENV_PASSTHROUGH) {
    const value = source[name];
    if (typeof value === 'string' && value.length > 0 && !value.includes('\0')) env[name] = value;
  }
  // claude needs HOME for its keychain login and ~/.claude; LANG keeps output UTF-8 when launched from Finder.
  env.HOME ??= homedir();
  env.LANG ??= 'en_US.UTF-8';

  const extra = (options.extraPath ?? []).filter((dir) => dir.startsWith('/') && !dir.includes(':'));
  env.PATH = [...new Set([...extra, ...AGENT_SYSTEM_PATH])].join(':');

  env.DISABLE_AUTOUPDATER = '1';
  env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = '1';
  env.DO_NOT_TRACK = '1';
  env.CLAUDE_AGENT_SDK_CLIENT_APP = clientAppId(options.version);

  if (options.apiKey !== undefined) {
    const key = options.apiKey.trim();
    if (key.length === 0) throw new Error('agentEnv: apiKey is empty');
    env.ANTHROPIC_API_KEY = key;
  }
  return env;
}

/** Names `agentEnv` may ever emit; anything else in its output is a bug. */
export const AGENT_ENV_ALLOWED_OUTPUT: ReadonlySet<string> = new Set([
  ...AGENT_ENV_PASSTHROUGH,
  'PATH',
  'DISABLE_AUTOUPDATER',
  'CLAUDE_CODE_DISABLE_AUTO_MEMORY',
  'DO_NOT_TRACK',
  'CLAUDE_AGENT_SDK_CLIENT_APP',
  'ANTHROPIC_API_KEY',
]);
