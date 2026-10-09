import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  GLOB_SCRIPT,
  guestProfile,
  LINUX_GUEST,
  MAC_EDIT_READ_SCRIPT,
  MAC_EDIT_WRITE_SCRIPT,
  MAC_OPEN_SCRIPT,
  MAC_SHARE_ROOT,
  MAC_STAT_TARGET_SCRIPT,
  MAC_SWEEP_SCRIPT,
  MAC_TRIM_JOB_SCRIPT,
  MACOS_GUEST,
  mirrorPrompt,
  SCRIPT_EXIT,
  SWEEP_LAUNCH,
} from '../../src/pcs/guest.js';
import {
  MAC_REFRESH_SCRIPT,
  macSetupArgs,
  macShares,
  parseSetupOutput,
  shareNameOf,
} from '../../src/pcs/macGuest.js';
import { macMirrorScript, macMirrorTerminal } from '../../src/pcs/ShellMirror.js';

describe('macOS shares', () => {
  it('names shares after the folder, unique, never setup or codex', () => {
    expect(shareNameOf('/Users/j/Code/web-app')).toBe('web-app');
    expect(shareNameOf('/Users/j/Code/.hidden')).toBe('hidden');
    expect(shareNameOf('/Users/j/Code/naïve proj')).toBe('na-ve proj');
    expect(shareNameOf('/x/---')).toBe('vault');
    const links = macShares(
      [
        { host: '/a/app', ro: false },
        { host: '/b/app', ro: true },
        { host: '/c/setup', ro: false },
        { host: '/d/codex', ro: false },
        { host: '/e/App', ro: false },
      ],
      '/x/codex-export',
    );
    expect(links.map((l) => [l.share.name, l.share.readOnly, l.guestPath])).toEqual([
      ['app', false, '/a/app'],
      ['app-2', true, '/b/app'],
      ['setup-2', false, '/c/setup'],
      ['codex-2', false, '/d/codex'],
      // Share names are compared case-insensitively (APFS).
      ['App-3', false, '/e/App'],
      ['codex', true, null],
    ]);
    expect(macSetupArgs(links)).toEqual([
      'app',
      '/a/app',
      'app-2',
      '/b/app',
      'setup-2',
      '/c/setup',
      'codex-2',
      '/d/codex',
      'App-3',
      '/e/App',
    ]);
    expect(macShares([], null)).toEqual([]);
  });

  it('reads what the setup script printed', () => {
    expect(parseSetupOutput('MVWARN taken /a\nMVWARN ripgrep not installed\nMVOK\n')).toEqual({
      ok: true,
      warnings: ['taken /a', 'ripgrep not installed'],
      error: null,
    });
    expect(parseSetupOutput('MVERR sudo needs a password\n')).toEqual({
      ok: false,
      warnings: [],
      error: 'sudo needs a password',
    });
  });
});

describe('the guest view refresh', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mv-refresh-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  /**
   * MAC_REFRESH_SCRIPT with the share root in a temp folder and stand-ins for sudo, purge, mount, umount and
   * mount_virtiofs: `state/mounted` says whether the shares are mounted, `state/busy` makes umount fail, and
   * `state/mountfails` makes mount_virtiofs fail.
   */
  const refresh = (state: { mounted: boolean; busy?: boolean; mountFails?: boolean }) => {
    const M = join(dir, 'My Shared Files');
    const bin = join(dir, 'bin');
    const st = join(dir, 'state');
    execFileSync('/bin/mkdir', ['-p', bin, st, M]);
    const stub = (name: string, body: string) => {
      writeFileSync(join(bin, name), `#!/bin/bash\n${body}\n`);
      execFileSync('/bin/chmod', ['+x', join(bin, name)]);
    };
    stub('sudo', '[ "$1" = -n ] && shift; exec "$@"');
    stub('purge', 'exit 0');
    stub(
      'mount',
      `[ -f "${st}/mounted" ] && echo "com.apple.virtio-fs.automount on ${M} (virtiofs, local)"; exit 0`,
    );
    // Like umount(8): a path that is not mounted fails, and so does a busy one.
    stub(
      'umount',
      `[ -f "${st}/mounted" ] || exit 1; [ -f "${st}/busy" ] && exit 16; rm -f "${st}/mounted"; rmdir "$1/setup" 2>/dev/null; exit 0`,
    );
    stub(
      'mount_virtiofs',
      `[ -f "${st}/mountfails" ] && exit 1; touch "${st}/mounted"; mkdir -p "${M}/setup"; echo "$@" >> "${st}/mounts"`,
    );
    for (const [f, on] of [
      ['mounted', state.mounted],
      ['busy', state.busy],
      ['mountfails', state.mountFails],
    ] as const) {
      if (on) writeFileSync(join(st, f), '');
      else rmSync(join(st, f), { force: true });
    }
    if (state.mounted) execFileSync('/bin/mkdir', ['-p', join(M, 'setup')]);
    else rmSync(join(M, 'setup'), { recursive: true, force: true });
    const script = MAC_REFRESH_SCRIPT.replace(JSON.stringify(MAC_SHARE_ROOT), JSON.stringify(M));
    return execFileSync('/bin/bash', ['-c', script], {
      encoding: 'utf8',
      env: { PATH: `${bin}:/usr/bin:/bin`, HOME: dir },
    }).trim();
  };

  it('remounts when it can, only purges while the share is busy, and mounts shares a failed remount left gone', () => {
    expect(refresh({ mounted: true })).toBe('remounted');
    expect(refresh({ mounted: true, busy: true })).toBe('purged');
    // The remount failed: the shares are gone until a refresh mounts them again.
    expect(refresh({ mounted: true, mountFails: true })).toBe('MVERR the shares did not come back');
    expect(refresh({ mounted: false })).toBe('remounted');
    expect(readFileSync(join(dir, 'state', 'mounts'), 'utf8')).toContain('com.apple.virtio-fs.automount');
  }, 20_000);
});

describe('guest profiles', () => {
  it('Linux is cua in /home/cua on :1; macOS is lume in /Users/lume with BSD scripts', () => {
    expect(guestProfile('linux')).toBe(LINUX_GUEST);
    expect(guestProfile('macos')).toBe(MACOS_GUEST);
    expect(MACOS_GUEST).toMatchObject({ os: 'macos', user: 'lume', home: '/Users/lume', display: null });
    expect(MACOS_GUEST.jobsDir).toBe('/Users/lume/.mv/jobs');
    expect(MACOS_GUEST.execPrefix.startsWith('umask 022\n')).toBe(true);
    expect(MACOS_GUEST.path).toContain('/usr/local/bin');
    expect(MACOS_GUEST.scripts.editRead).toContain('stat -f %z');
    expect(MACOS_GUEST.scripts.editRead).not.toContain('stat -c');
    expect(MACOS_GUEST.scripts.trimJob).toContain('stat -f %z');
    expect(LINUX_GUEST.execEnv).toMatchObject({ DISPLAY: ':1' });
    expect(MACOS_GUEST.execEnv).not.toHaveProperty('DISPLAY');
  });

  it('the mirror prompt shortens the guest home of either OS', () => {
    const cmd =
      'mkdir -p ~/.mv\nexec > >(tee -a ~/.mv/shell.log) 2>&1\ncd "$MV_CWD" 2>/dev/null || cd ~\nls\nec=$?';
    const p = mirrorPrompt(cmd, {
      agentId: 'ada',
      pcId: 'mac-1',
      cwd: '/Users/lume/app',
      home: '/Users/lume',
    });
    const plain = (s: string | null) => s?.replaceAll(String.fromCharCode(27), '').replace(/\[[0-9;]*m/g, '');
    expect(plain(p)).toBe('ada@mac-1:~/app$ ls');
    const l = mirrorPrompt(cmd, { agentId: 'ada', pcId: 'linux-1', cwd: '/home/cuaish' });
    expect(plain(l)).toBe('ada@linux-1:/home/cuaish$ ls');
  });

  it('the Terminal mirror document runs the tail with MV_MIRROR, titled, and escapes the label', () => {
    const doc = macMirrorTerminal('Ada & "Bram" <x>', 'mac-1');
    expect(doc).toContain('<key>shellExitAction</key><integer>0</integer>');
    expect(doc).toContain(
      '<key>WindowTitle</key><string>Shell: Ada &amp; &quot;Bram&quot; &lt;x&gt;</string>',
    );
    // Terminal splits the command on spaces and takes no quotes: plain words only, the label lives in the script.
    expect(doc).toContain(
      '<key>CommandString</key><string>/usr/bin/env MV_MIRROR=mac-1 /bin/bash /Users/lume/.mv/mirror.sh</string>',
    );
    expect(() => macMirrorTerminal('Ada', 'mac 1')).toThrow(/invalid PC id/);
    const script = macMirrorScript('Ada\'s "crew"', 'mac-1');
    expect(script.split('\n')[0]).toBe(`set -- 'Ada'\\''s "crew"' 'mac-1'`);
    expect(script).toContain('stat -f %z');
    expect(script).not.toContain('stat -c');
  });
});

/** The macOS guest scripts run on this Mac's own BSD userland (bash 3.2 or newer), the way a macOS guest runs them. */
describe.skipIf(process.platform !== 'darwin')('macOS guest scripts on a BSD userland', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mv-macscripts-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const run = (script: string, args: string[], input?: string) => {
    try {
      const stdout = execFileSync('/bin/bash', ['-c', script, 'guest', ...args], {
        input,
        encoding: 'utf8',
        env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LC_ALL: 'C.UTF-8', HOME: dir },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return { code: 0, stdout };
    } catch (e) {
      const err = e as { status: number; stdout: string };
      return { code: err.status, stdout: err.stdout };
    }
  };

  it('edit reads with BSD stat and writes back only when unchanged', () => {
    const f = join(dir, 'a.txt');
    writeFileSync(f, 'hello\n');
    expect(run(MAC_EDIT_READ_SCRIPT, [f, '1000'])).toEqual({ code: 0, stdout: 'hello\n' });
    expect(run(MAC_EDIT_READ_SCRIPT, [f, '3']).code).toBe(SCRIPT_EXIT.TOO_LARGE);
    expect(run(MAC_EDIT_READ_SCRIPT, [join(dir, 'nope'), '9']).code).toBe(SCRIPT_EXIT.NOT_FOUND);
    const sha = createHash('sha256').update('hello\n').digest('hex');
    expect(run(MAC_EDIT_WRITE_SCRIPT, [f, sha], 'bye\n').code).toBe(0);
    expect(readFileSync(f, 'utf8')).toBe('bye\n');
    expect(run(MAC_EDIT_WRITE_SCRIPT, [f, sha], 'again\n').code).toBe(SCRIPT_EXIT.CHANGED);
    expect(readFileSync(f, 'utf8')).toBe('bye\n');
  });

  it('stat of a link target and the job file trim', () => {
    const f = join(dir, 'big.txt');
    writeFileSync(f, 'x'.repeat(1000));
    symlinkSync(f, join(dir, 'link'));
    const s = run(MAC_STAT_TARGET_SCRIPT, [join(dir, 'link')]);
    expect(s.stdout.trim()).toMatch(/^Regular File\|1000\|\d+$/);
    expect(run(MAC_STAT_TARGET_SCRIPT, [join(dir, 'gone')]).code).toBe(SCRIPT_EXIT.NOT_FOUND);
    expect(run(MAC_TRIM_JOB_SCRIPT, [f, '400']).code).toBe(0);
    const trimmed = readFileSync(f, 'utf8');
    expect(trimmed.startsWith('[… earlier output was dropped …]\n')).toBe(true);
    expect(trimmed.endsWith('x'.repeat(200))).toBe(true);
  });

  it('the sweep finds processes by an environment variable (ps -E) and their children, and kills them', async (ctx) => {
    const tag = `t${Date.now().toString(36)}`;
    const child = spawn('/bin/bash', ['-c', 'sleep 60 & sleep 61 & wait'], {
      env: { PATH: '/usr/bin:/bin', MV_PROBE_TAG: tag },
      stdio: 'ignore',
      detached: true,
    });
    await new Promise((r) => setTimeout(r, 400));
    // macOS 26 (the guests) shows a process's environment with `ps -E`; macOS 27 hosts no longer do. The guest side is
    // covered by `npm run test:pcs` (macPc.int.ts: a kill by seat tag).
    const ps = execFileSync('/bin/ps', ['-wwE', '-o', 'command=', '-p', String(child.pid)], {
      encoding: 'utf8',
    });
    if (!ps.includes(`MV_PROBE_TAG=${tag}`)) {
      process.kill(-(child.pid as number), 'SIGKILL');
      ctx.skip();
    }
    const found = run(MAC_SWEEP_SCRIPT, ['MV_PROBE_TAG', tag]).stdout.trim().split('\n').filter(Boolean);
    expect(found).toContain(String(child.pid));
    expect(found.length).toBeGreaterThanOrEqual(3);
    // The launcher kills as this user (no passwordless sudo here: `sudo -n true` fails, and that is fine).
    const killed = run(SWEEP_LAUNCH, ['MV_PROBE_TAG', tag, MAC_SWEEP_SCRIPT]);
    expect(Number(killed.stdout.trim().split('\n').pop())).toBeGreaterThanOrEqual(3);
    await new Promise((r) => setTimeout(r, 200));
    expect(run(MAC_SWEEP_SCRIPT, ['MV_PROBE_TAG', tag]).stdout.trim()).toBe('');
  });

  it('open: a missing path, and an unknown target lists apps', () => {
    expect(run(MAC_OPEN_SCRIPT, [join(dir, 'missing.txt')]).code).toBe(SCRIPT_EXIT.NOT_FOUND);
    const r = run(MAC_OPEN_SCRIPT, ['no-such-app-mv']);
    expect(r.code).toBe(2);
    expect(r.stdout).toMatch(/^apps: /m);
  });

  it('glob is the shared ripgrep script (rg comes from the setup share in a guest)', () => {
    expect(MACOS_GUEST.scripts.glob).toBe(GLOB_SCRIPT);
  });
});
