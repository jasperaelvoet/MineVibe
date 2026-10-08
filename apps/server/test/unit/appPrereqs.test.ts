import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ClaudeBinaryError, type ResolvedClaude } from '../../src/agents/claudeBinary.js';
import {
  bundledClaudePath,
  type ClaudeAuthStatus,
  checkPrerequisites,
  describePrerequisites,
  isAppleSilicon,
  macosMajor,
  type PrereqOptions,
  parseAuthStatus,
  readClaudeAuthStatus,
  readMacosVersion,
} from '../../src/app/prerequisites.js';

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'mv-prereq-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A fake `claude` that prints `version` for --version and `auth` for `auth status --json`, exiting `code`. */
function fakeClaude(version: string, auth: string, authCode = 0): string {
  const bin = join(tmp(), 'claude');
  writeFileSync(
    bin,
    `#!/bin/sh
if [ "$1" = "--version" ]; then echo "${version} (Claude Code)"; exit 0; fi
if [ "$1" = "auth" ] && [ "$2" = "status" ]; then printf '%s\\n' '${auth}'; exit ${authCode}; fi
exit 2
`,
  );
  chmodSync(bin, 0o755);
  return bin;
}

const user = (version = '2.1.293'): ResolvedClaude => ({ source: 'user', path: '/x/claude', version });
const loggedIn: ClaudeAuthStatus = { loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty' };

function opts(patch: Partial<PrereqOptions> = {}): PrereqOptions {
  return {
    env: {},
    allowBundled: false,
    platform: 'darwin',
    appleSilicon: async () => true,
    macosVersion: async () => '26.1',
    resolveClaude: async () => user(),
    authStatus: async () => loggedIn,
    ...patch,
  };
}

describe('auth status and versions', () => {
  it('keeps only loggedIn, authMethod and apiProvider', () => {
    const parsed = parseAuthStatus(
      JSON.stringify({
        loggedIn: true,
        authMethod: 'claude.ai',
        apiProvider: 'firstParty',
        email: 'a@b.c',
        orgId: 'o',
      }),
    );
    expect(parsed).toEqual({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty' });
    expect(parseAuthStatus('noise\n{"loggedIn":false}')).toEqual({
      loggedIn: false,
      authMethod: null,
      apiProvider: null,
    });
    expect(parseAuthStatus('')).toBeNull();
    expect(parseAuthStatus('{"loggedIn":"yes"}')).toBeNull();
    expect(parseAuthStatus('{broken')).toBeNull();
  });

  it('reads `claude auth status --json`, also from a logged-out claude that exits non-zero', async () => {
    const out = fakeClaude('2.1.293', '{"loggedIn":false,"authMethod":"none"}', 1);
    expect(await readClaudeAuthStatus(out, { PATH: '/usr/bin:/bin' })).toEqual({
      loggedIn: false,
      authMethod: 'none',
      apiProvider: null,
    });
    const garbage = fakeClaude('2.1.293', 'Unknown command', 1);
    expect(await readClaudeAuthStatus(garbage, { PATH: '/usr/bin:/bin' })).toBeNull();
  });

  it('parses the macOS major version', () => {
    expect(macosMajor('27.0.1')).toBe(27);
    expect(macosMajor('26')).toBe(26);
    expect(macosMajor(null)).toBeNull();
    expect(macosMajor('beta')).toBeNull();
  });

  it.runIf(process.platform === 'darwin')('reads this Mac', async () => {
    expect(macosMajor(await readMacosVersion())).toBeGreaterThanOrEqual(11);
    if (process.arch === 'arm64') expect(await isAppleSilicon()).toBe(true);
    expect(await isAppleSilicon('linux', 'arm64')).toBe(false);
  });

  it('finds the SDK claude of this checkout (a dev build bundles it too)', () => {
    const path = bundledClaudePath();
    if (process.platform === 'darwin' && process.arch === 'arm64') {
      expect(path).toMatch(/@anthropic-ai\/claude-agent-sdk-darwin-arm64\/claude$/);
    }
    expect(bundledClaudePath('file:///nowhere/at/all.mjs')).toBeNull();
  });
});

describe('checkPrerequisites', () => {
  it('passes on Apple silicon, macOS 26+, claude 2.1.293+ logged in', async () => {
    const report = await checkPrerequisites(opts());
    expect(report).toMatchObject({ ok: true, problems: [], macos: '26.1', loggedIn: true });
    expect(report.claude?.version).toBe('2.1.293');
  });

  it('names an Intel Mac and an old macOS with one-line instructions', async () => {
    const report = await checkPrerequisites(
      opts({ appleSilicon: async () => false, macosVersion: async () => '15.6' }),
    );
    expect(report.ok).toBe(false);
    expect(report.problems.map((p) => p.id)).toEqual(['apple_silicon', 'macos']);
    expect(report.problems[1]?.message).toBe('MineVibe needs macOS 26 or later (this Mac runs 15.6)');
    for (const p of report.problems) expect(p.instruction).not.toContain('\n');
  });

  it('tells the player to run `claude update` for an old claude, and to log in when logged out', async () => {
    const old = await checkPrerequisites(
      opts({
        resolveClaude: async () => {
          throw new ClaudeBinaryError('too_old', 'old', '/x/claude', '2.1.284');
        },
      }),
    );
    expect(old.problems).toEqual([
      {
        id: 'claude',
        message: 'Claude Code 2.1.284 is too old',
        instruction:
          'Run `claude update` in Terminal (MineVibe needs 2.1.293 or newer), then open MineVibe again.',
      },
    ]);
    expect(old.loggedIn).toBeNull(); // no login check without a usable claude

    const missing = await checkPrerequisites(
      opts({
        resolveClaude: async () => {
          throw new ClaudeBinaryError('missing', 'x', null, null);
        },
      }),
    );
    expect(missing.problems[0]?.instruction).toMatch(/Install Claude Code from claude\.ai\/code/);

    const out = await checkPrerequisites(
      opts({ authStatus: async () => ({ ...loggedIn, loggedIn: false }) }),
    );
    expect(out.problems.map((p) => p.id)).toEqual(['claude_login']);
    expect(out.problems[0]?.instruction).toMatch(/^Run `claude` in Terminal and log in/);
  });

  it('does not block when the login state cannot be told', async () => {
    const report = await checkPrerequisites(opts({ authStatus: async () => null }));
    expect(report).toMatchObject({ ok: true, loggedIn: null });
  });

  it('with the real resolver: MINEVIBE_CLAUDE=bundled only where allowed, logged in through the SDK claude', async () => {
    const sdk = fakeClaude('2.1.293', '{"loggedIn":true}');
    const base = opts({ resolveClaude: undefined, authStatus: undefined, bundledClaude: () => sdk });
    delete (base as { resolveClaude?: unknown }).resolveClaude;
    delete (base as { authStatus?: unknown }).authStatus;
    const release = await checkPrerequisites({
      ...base,
      env: { MINEVIBE_CLAUDE: 'bundled' },
      allowBundled: false,
    });
    expect(release.problems.map((p) => p.message)).toEqual([
      'MINEVIBE_CLAUDE=bundled works only in development builds',
    ]);
    const dev = await checkPrerequisites({
      ...base,
      env: { MINEVIBE_CLAUDE: 'bundled' },
      allowBundled: true,
    });
    expect(dev).toMatchObject({ ok: true, loggedIn: true });
    expect(dev.claude?.source).toBe('bundled');
    const pruned = await checkPrerequisites({
      ...base,
      env: { MINEVIBE_CLAUDE: 'bundled' },
      allowBundled: true,
      bundledClaude: () => null,
    });
    expect(pruned.problems[0]?.message).toMatch(/no SDK claude/);
  });

  it('with the real resolver: an override path that is too old', async () => {
    const old = fakeClaude('2.1.284', '{"loggedIn":true}');
    const base = opts();
    delete (base as { resolveClaude?: unknown }).resolveClaude;
    const report = await checkPrerequisites({ ...base, env: { MINEVIBE_CLAUDE: old } });
    expect(report.problems.map((p) => p.message)).toEqual(['Claude Code 2.1.284 is too old']);
  });

  it('describes the problems for the stub dialog: a headline and one instruction per line', () => {
    const d = describePrerequisites({
      ok: false,
      macos: '26.0',
      claude: null,
      loggedIn: null,
      problems: [
        { id: 'claude', message: 'Claude Code 2.1.284 is too old', instruction: 'Run `claude update`.' },
        { id: 'claude_login', message: 'Claude Code is not logged in', instruction: 'Log in.' },
      ],
    });
    expect(d.message).toBe('Claude Code 2.1.284 is too old');
    expect(d.detail).toBe('Run `claude update`.\nLog in.\n\nAlso: Claude Code is not logged in.');
    expect(
      describePrerequisites({ ok: true, macos: null, claude: null, loggedIn: null, problems: [] }).detail,
    ).toBe('');
  });

  it('a home without ~/.local/bin/claude and an empty PATH means not installed', async () => {
    const home = tmp();
    mkdirSync(join(home, '.local', 'bin'), { recursive: true });
    const base = opts({ home, env: { PATH: '' } });
    delete (base as { resolveClaude?: unknown }).resolveClaude;
    const report = await checkPrerequisites(base);
    expect(report.problems.map((p) => p.message)).toEqual(['Claude Code is not installed']);
  });
});
