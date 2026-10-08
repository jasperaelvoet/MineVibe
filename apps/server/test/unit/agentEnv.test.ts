import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  AGENT_ENV_ALLOWED_OUTPUT,
  AGENT_ENV_PASSTHROUGH,
  AGENT_SYSTEM_PATH,
  agentEnv,
  clientAppId,
} from '../../src/agents/agentEnv.js';

const fixture = JSON.parse(
  readFileSync(new URL('../fixtures/hostile-env.json', import.meta.url), 'utf8'),
) as { names: string[] };

const HOSTILE = 'hostile-value';

/** A parent environment holding every hostile name plus sane values for the allowlisted ones. */
function hostileSource(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of fixture.names) env[name] = HOSTILE;
  Object.assign(env, {
    HOME: '/Users/tester',
    USER: 'tester',
    LOGNAME: 'tester',
    SHELL: '/bin/zsh',
    LANG: 'nl_BE.UTF-8',
    TMPDIR: '/var/folders/xy/T/',
    TERM: 'xterm-256color',
    PATH: '/evil/bin:/opt/homebrew/bin:/usr/bin',
    SSH_AUTH_SOCK: '/tmp/agent.sock',
    AWS_SECRET_ACCESS_KEY: HOSTILE,
    GITHUB_TOKEN: HOSTILE,
  });
  return env;
}

describe('agentEnv', () => {
  it('fixture lists the ~35 hostile names from the dev shell', () => {
    expect(fixture.names.length).toBeGreaterThanOrEqual(35);
    expect(fixture.names).toEqual(
      expect.arrayContaining([
        'ANTHROPIC_BASE_URL',
        'ANTHROPIC_API_KEY',
        'CLAUDECODE',
        'CLAUDE_EFFORT',
        'CLAUDE_CODE_EFFORT_LEVEL',
        'DISABLE_MICROCOMPACT',
        'CLAUDE_CONFIG_DIR',
        'MCP_TIMEOUT',
      ]),
    );
  });

  it('lets no hostile value survive', () => {
    const env = agentEnv({ version: '1.2.3', source: hostileSource() });
    for (const [name, value] of Object.entries(env)) {
      expect(value, name).not.toBe(HOSTILE);
    }
    for (const name of fixture.names) {
      const allowedToExist = AGENT_ENV_ALLOWED_OUTPUT.has(name) && name !== 'ANTHROPIC_API_KEY';
      if (!allowedToExist) expect(env, name).not.toHaveProperty(name);
    }
  });

  it('drops whole families: ANTHROPIC_*, CLAUDE_CODE_* (except its own flag), MCP_*, CLAUDE_CONFIG_DIR', () => {
    const env = agentEnv({ version: '1.2.3', source: hostileSource() });
    const names = Object.keys(env);
    expect(names.filter((n) => n.startsWith('ANTHROPIC_'))).toEqual([]);
    expect(names.filter((n) => n.startsWith('MCP_'))).toEqual([]);
    expect(names.filter((n) => n.startsWith('CLAUDE_CODE_'))).toEqual(['CLAUDE_CODE_DISABLE_AUTO_MEMORY']);
    expect(names).not.toContain('CLAUDECODE');
    expect(names).not.toContain('CLAUDE_EFFORT');
    expect(names).not.toContain('CLAUDE_CONFIG_DIR');
    expect(names).not.toContain('NODE_OPTIONS');
    expect(names).not.toContain('DYLD_INSERT_LIBRARIES');
    expect(names).not.toContain('SSH_AUTH_SOCK');
    expect(names).not.toContain('GITHUB_TOKEN');
  });

  it('emits only allowlisted names', () => {
    const env = agentEnv({ version: '1.2.3', source: hostileSource(), apiKey: 'sk-test-placeholder' });
    for (const name of Object.keys(env)) expect(AGENT_ENV_ALLOWED_OUTPUT.has(name), name).toBe(true);
  });

  it('passes the allowlisted variables through unchanged', () => {
    const source = hostileSource();
    const env = agentEnv({ version: '1.2.3', source });
    for (const name of AGENT_ENV_PASSTHROUGH) expect(env[name], name).toBe(source[name]);
  });

  it('uses an explicit PATH with the system dirs, never the parent PATH', () => {
    const env = agentEnv({ version: '1.2.3', source: hostileSource() });
    expect(env.PATH).toBe('/usr/bin:/bin:/usr/sbin:/sbin');
    expect(env.PATH?.split(':')).toEqual([...AGENT_SYSTEM_PATH]);
    expect(env.PATH).not.toContain('/evil');
  });

  it('prepends absolute extra PATH dirs only', () => {
    const env = agentEnv({
      version: '1',
      source: {},
      extraPath: ['/Applications/MineVibe.app/Contents/MacOS', 'relative/bin', '/a:/b', '/usr/bin'],
    });
    expect(env.PATH).toBe('/Applications/MineVibe.app/Contents/MacOS:/usr/bin:/bin:/usr/sbin:/sbin');
  });

  it('sets MineVibe flags with its own values even when the parent set them', () => {
    const env = agentEnv({ version: '0.4.0', source: hostileSource() });
    expect(env.DISABLE_AUTOUPDATER).toBe('1');
    expect(env.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe('1');
    expect(env.CLAUDE_AGENT_SDK_CLIENT_APP).toBe('minevibe/0.4.0');
    expect(clientAppId('0.4.0')).toBe('minevibe/0.4.0');
  });

  it('never forwards the parent ANTHROPIC_API_KEY', () => {
    expect(agentEnv({ version: '1', source: hostileSource() })).not.toHaveProperty('ANTHROPIC_API_KEY');
  });

  it('injects ANTHROPIC_API_KEY only in API-key mode', () => {
    const env = agentEnv({ version: '1', source: hostileSource(), apiKey: '  sk-test-placeholder ' });
    expect(env.ANTHROPIC_API_KEY).toBe('sk-test-placeholder');
    expect(() => agentEnv({ version: '1', source: {}, apiKey: '   ' })).toThrow(/empty/);
  });

  it('fills HOME and LANG when the parent lacks them (Finder launch)', () => {
    const env = agentEnv({ version: '1', source: {} });
    expect(env.HOME).toBeTruthy();
    expect(env.LANG).toBe('en_US.UTF-8');
    expect(env).not.toHaveProperty('USER');
    expect(env).not.toHaveProperty('TERM');
  });

  it('skips empty values and values containing NUL', () => {
    const env = agentEnv({ version: '1', source: { USER: '', SHELL: '/bin/zsh\0evil', TERM: 'dumb' } });
    expect(env).not.toHaveProperty('USER');
    expect(env).not.toHaveProperty('SHELL');
    expect(env.TERM).toBe('dumb');
  });

  it('defaults to process.env without leaking it', () => {
    const env = agentEnv({ version: '1' });
    for (const name of Object.keys(env)) expect(AGENT_ENV_ALLOWED_OUTPUT.has(name), name).toBe(true);
    expect(env).not.toHaveProperty('ANTHROPIC_API_KEY');
  });
});
