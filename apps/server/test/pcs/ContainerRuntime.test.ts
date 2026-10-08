import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type ContainerLock,
  ContainerRuntime,
  classifyStatus,
  devContainerRoots,
  EngineError,
  normalizeRoot,
  parseLaunchctlProgram,
  resolveContainerRoots,
  tccProtectedReason,
} from '../../src/pcs/drivers/ContainerRuntime.js';
import {
  CliError,
  type ExecFn,
  type ExecResult,
  execWithTimeout,
  parseCliJson,
  redact,
} from '../../src/pcs/drivers/exec.js';

const ok = (stdout = '', code = 0): ExecResult => ({
  code,
  signal: null,
  stdout,
  stderr: '',
  ms: 1,
  timedOut: false,
});

let dir: string;
let roots: { appRoot: string; installRoot: string };
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'mv-ctrt-')));
  roots = { appRoot: join(dir, 'app'), installRoot: join(dir, 'root') };
  mkdirSync(join(roots.installRoot, 'bin'), { recursive: true });
  writeFileSync(join(roots.installRoot, 'bin', 'container'), '#!/bin/sh\n');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const lock: ContainerLock = {
  version: '1.5.0',
  pkg: { name: 'container.pkg', url: 'https://invalid.example/container.pkg', sha256: 'a'.repeat(64) },
};

function statusJson(appRoot: string, installRoot: string, status = 'running', version = '1.5.0'): string {
  return JSON.stringify({
    status,
    paths: { appRoot: `${appRoot}/`, installRoot: `${installRoot}/` },
    server: { version },
  });
}

/** A fake exec that answers by argv and records every call. */
function fakeExec(answer: (file: string, args: readonly string[]) => ExecResult | undefined) {
  const calls: { file: string; args: readonly string[] }[] = [];
  const exec: ExecFn = async (file, args) => {
    calls.push({ file, args });
    return answer(file, args) ?? ok();
  };
  return { exec, calls };
}

describe('ownership classification (PLAN §8.1)', () => {
  it('normalizes trailing slashes and /tmp → /private/tmp before comparing', () => {
    expect(normalizeRoot('/tmp/x/')).toBe(join(realpathSync('/tmp'), 'x'));
    const s = classifyStatus(ok(statusJson(roots.appRoot, roots.installRoot)), roots);
    expect(s.ownership).toBe('ours');
    expect(s.serverVersion).toBe('1.5.0');
  });

  it('our app root with another install root is ours but stale', () => {
    expect(classifyStatus(ok(statusJson(roots.appRoot, '/Applications/Old.app/x')), roots).ownership).toBe(
      'ours_stale_install',
    );
  });

  it('anything else is foreign', () => {
    const brew = statusJson(join(homedir(), 'Library/Application Support/com.apple.container'), '/usr/local');
    expect(classifyStatus(ok(brew), roots).ownership).toBe('foreign');
  });

  it('M5: ours with another server version than the lock is stale', () => {
    expect(
      classifyStatus(ok(statusJson(roots.appRoot, roots.installRoot, 'running', '1.4.0')), roots, '1.5.0'),
    ).toMatchObject({
      ownership: 'ours_stale_install',
      detail: expect.stringMatching(/1\.4\.0 != locked 1\.5\.0/),
    });
    expect(classifyStatus(ok(statusJson(roots.appRoot, roots.installRoot)), roots, '1.5.0').ownership).toBe(
      'ours',
    );
  });

  it('reads "unregistered" and timeouts', () => {
    expect(classifyStatus(ok('{"status":"unregistered"}', 1), roots).ownership).toBe('not_running');
    expect(classifyStatus({ ...ok(), timedOut: true }, roots)).toMatchObject({
      ownership: 'unknown',
      timedOut: true,
    });
  });

  it('parses the launchd program path', () => {
    const text =
      'gui/501/com.apple.container.apiserver = {\n\tactive count = 1\n\tpath = /x.plist\n\tprogram = /Users/me/Library/Application Support/MineVibe-dev/container-root/bin/container-apiserver\n}';
    expect(parseLaunchctlProgram(text)).toBe(
      '/Users/me/Library/Application Support/MineVibe-dev/container-root/bin/container-apiserver',
    );
    expect(parseLaunchctlProgram('arguments = {\n\t\t/opt/x/bin/container-apiserver\n\t\tstart\n}')).toBe(
      '/opt/x/bin/container-apiserver',
    );
  });
});

describe('TCC placement (PLAN §8.6)', () => {
  it('flags ~/Documents, ~/Desktop, ~/Downloads and iCloud', () => {
    const h = '/Users/me';
    expect(tccProtectedReason('/Users/me/Documents/MineVibe/.minevibe-dev/container', h)).toMatch(
      /Documents/,
    );
    expect(tccProtectedReason('/Users/me/Desktop/x', h)).toMatch(/Desktop/);
    expect(tccProtectedReason('/Users/me/Library/Mobile Documents/x', h)).toMatch(/Mobile/);
    expect(tccProtectedReason('/Users/me/Library/Application Support/MineVibe-dev/container', h)).toBeNull();
    expect(tccProtectedReason('/Applications/MineVibe.app/Contents/Helpers/container', h)).toBeNull();
  });

  it('moves dev roots out of the repo when MINEVIBE_HOME is in ~/Documents', () => {
    const h = '/Users/me';
    const r = resolveContainerRoots({
      appSupportContainer: '/Users/me/Documents/MineVibe/.minevibe-dev/container',
      env: {},
      home: h,
    });
    expect(r).toEqual(devContainerRoots(h));
    expect(r.appRoot).toBe('/Users/me/Library/Application Support/MineVibe-dev/container');
    expect(r.installRoot).toBe('/Users/me/Library/Application Support/MineVibe-dev/container-root');
  });

  it('refuses to start with a protected root', async () => {
    const rt = new ContainerRuntime({
      appRoot: join(homedir(), 'Documents', 'mv-test-never-created'),
      installRoot: roots.installRoot,
      lock,
      cacheDir: dir,
      exec: fakeExec(() => undefined).exec,
    });
    await expect(rt.ensureStarted()).rejects.toMatchObject({ code: 'TCC_PROTECTED' });
  });
});

describe('start/stop never touch a foreign apiserver', () => {
  function runtime(answer: Parameters<typeof fakeExec>[0]) {
    const f = fakeExec(answer);
    const rt = new ContainerRuntime({ ...roots, lock, cacheDir: dir, exec: f.exec, uid: 501 });
    return { rt, calls: f.calls };
  }
  const isCall = (c: { args: readonly string[] }, ...prefix: string[]) =>
    prefix.every((p, i) => c.args[i] === p);

  it('foreign: ensureStarted throws ENGINE_FOREIGN and never stops or starts', async () => {
    const { rt, calls } = runtime((_f, a) =>
      a[0] === 'system' && a[1] === 'status' ? ok(statusJson('/other/app', '/usr/local')) : undefined,
    );
    await expect(rt.ensureStarted()).rejects.toBeInstanceOf(EngineError);
    await expect(rt.ensureStarted()).rejects.toMatchObject({ code: 'ENGINE_FOREIGN' });
    expect(calls.some((c) => isCall(c, 'system', 'stop') || isCall(c, 'system', 'start'))).toBe(false);
    expect(await rt.stopIfOurs()).toBe(false);
    expect(calls.some((c) => isCall(c, 'system', 'stop'))).toBe(false);
  });

  it('not running: starts with --app-root/--install-root/--enable-kernel-install/--timeout', async () => {
    let started = false;
    const { rt, calls } = runtime((_f, a) => {
      if (isCall({ args: a }, 'system', 'status')) {
        return started
          ? ok(statusJson(roots.appRoot, roots.installRoot))
          : ok('{"status":"unregistered"}', 1);
      }
      if (isCall({ args: a }, 'system', 'start')) started = true;
      return undefined;
    });
    const st = await rt.ensureStarted();
    expect(st.ownership).toBe('ours');
    const start = calls.find((c) => isCall(c, 'system', 'start'));
    expect(start?.args).toEqual([
      'system',
      'start',
      '--app-root',
      roots.appRoot,
      '--install-root',
      roots.installRoot,
      '--enable-kernel-install',
      '--timeout',
      '180',
    ]);
    expect(rt.startedByUs).toBe(true);
  });

  it('ours: no start; stopIfOurs stops it', async () => {
    const { rt, calls } = runtime((_f, a) =>
      isCall({ args: a }, 'system', 'status') ? ok(statusJson(roots.appRoot, roots.installRoot)) : undefined,
    );
    await rt.ensureStarted();
    expect(calls.some((c) => isCall(c, 'system', 'start'))).toBe(false);
    expect(await rt.stopIfOurs()).toBe(true);
    expect(calls.some((c) => isCall(c, 'system', 'stop'))).toBe(true);
  });

  it('ours but stale install root: stops, then starts from the current root', async () => {
    let restarted = false;
    const { rt, calls } = runtime((_f, a) => {
      if (isCall({ args: a }, 'system', 'status')) {
        return ok(statusJson(roots.appRoot, restarted ? roots.installRoot : '/old/install'));
      }
      if (isCall({ args: a }, 'system', 'start')) restarted = true;
      return undefined;
    });
    await rt.ensureStarted();
    const order = calls.filter((c) => c.args[0] === 'system' && c.args[1] !== 'status').map((c) => c.args[1]);
    expect(order).toEqual(['stop', 'start']);
  });

  it('a hanging stop falls back to bootout of our own labels only', async () => {
    const ourProg = join(roots.installRoot, 'bin', 'container-apiserver');
    const { rt, calls } = runtime((file, a) => {
      if (isCall({ args: a }, 'system', 'status')) return ok(statusJson(roots.appRoot, roots.installRoot));
      if (isCall({ args: a }, 'system', 'stop')) return { ...ok(), code: null, timedOut: true };
      if (file === '/bin/launchctl' && a[0] === 'list') {
        return ok(
          'PID\tStatus\tLabel\n1\t0\tcom.apple.container.apiserver\n2\t0\tcom.apple.container.foreign-plugin\n3\t0\tcom.example.other\n',
        );
      }
      if (file === '/bin/launchctl' && a[0] === 'print') {
        return a[1]?.endsWith('apiserver')
          ? ok(`program = ${ourProg}\n`)
          : ok('program = /usr/local/libexec/x\n');
      }
      return undefined;
    });
    expect(await rt.stopIfOurs()).toBe(true);
    const bootouts = calls
      .filter((c) => c.file === '/bin/launchctl' && c.args[0] === 'bootout')
      .map((c) => c.args[1]);
    expect(bootouts).toEqual(['gui/501/com.apple.container.apiserver']);
  });

  it('a status timeout with a foreign launchd job is reported, not recovered', async () => {
    const { rt, calls } = runtime((file, a) => {
      if (isCall({ args: a }, 'system', 'status')) return { ...ok(), code: null, timedOut: true };
      if (file === '/bin/launchctl' && a[0] === 'print')
        return ok('program = /usr/local/bin/container-apiserver\n');
      return undefined;
    });
    await expect(rt.ensureStarted()).rejects.toMatchObject({ code: 'ENGINE_FOREIGN' });
    expect(calls.some((c) => c.args[0] === 'bootout')).toBe(false);
  });

  it('M5: an apiserver of ours running an older version is stopped and restarted', async () => {
    let restarted = false;
    const { rt, calls } = runtime((_f, a) => {
      if (isCall({ args: a }, 'system', 'status')) {
        return ok(statusJson(roots.appRoot, roots.installRoot, 'running', restarted ? '1.5.0' : '1.4.0'));
      }
      if (isCall({ args: a }, 'system', 'start')) restarted = true;
      return undefined;
    });
    await rt.ensureStarted();
    const order = calls.filter((c) => c.args[0] === 'system' && c.args[1] !== 'status').map((c) => c.args[1]);
    expect(order).toEqual(['stop', 'start']);
  });

  it('L9: not running, but the shared launchd label belongs to another install: never start over it', async () => {
    const { rt, calls } = runtime((file, a) => {
      if (isCall({ args: a }, 'system', 'status')) return ok('{"status":"unregistered"}', 1);
      if (file === '/bin/launchctl' && a[0] === 'print')
        return ok('program = /usr/local/bin/container-apiserver\n');
      return undefined;
    });
    await expect(rt.ensureStarted()).rejects.toMatchObject({ code: 'ENGINE_FOREIGN' });
    expect(calls.some((c) => isCall(c, 'system', 'start'))).toBe(false);
  });

  it('every CLI call carries the roots in env and a timeout', async () => {
    const seen: { env?: NodeJS.ProcessEnv; timeoutMs: number }[] = [];
    const rt = new ContainerRuntime({
      ...roots,
      lock,
      cacheDir: dir,
      exec: async (_f, _a, o) => {
        seen.push({ ...(o.env ? { env: o.env } : {}), timeoutMs: o.timeoutMs });
        return ok('[]');
      },
    });
    await rt.exec(['list', '--all']);
    expect(seen[0]?.env?.CONTAINER_APP_ROOT).toBe(roots.appRoot);
    expect(seen[0]?.env?.CONTAINER_INSTALL_ROOT).toBe(roots.installRoot);
    expect(seen[0]?.timeoutMs).toBeGreaterThan(0);
  });
});

describe('provisioning', () => {
  it('rejects a pkg whose sha256 does not match the lock', async () => {
    rmSync(join(roots.installRoot, 'bin', 'container'));
    const pkg = join(dir, 'container.pkg');
    writeFileSync(pkg, 'not the real pkg');
    const fetchImpl = (async () => new Response('still not it')) as unknown as typeof fetch;
    const { exec, calls } = fakeExec(() => undefined);
    const rt = new ContainerRuntime({
      ...roots,
      lock,
      cacheDir: join(dir, 'cache'),
      pkgPath: pkg,
      exec,
      fetchImpl,
    });
    await expect(rt.provision()).rejects.toThrow(/sha256/);
    expect(calls.some((c) => c.args.includes('--expand-full'))).toBe(false);
  });

  it('M5: stops our running apiserver before replacing the install root', async () => {
    // An old binary is installed; the lock wants a new one.
    writeFileSync(join(roots.installRoot, 'bin', 'container'), 'old binary');
    const pkg = join(dir, 'container.pkg');
    writeFileSync(pkg, 'the pkg');
    const newBin = 'new binary';
    const sha = (t: string) => createHash('sha256').update(t).digest('hex');
    const lk: ContainerLock = {
      version: '1.5.0',
      pkg: { name: 'container.pkg', url: 'https://invalid.example/x', sha256: sha('the pkg') },
      installRootFiles: { 'bin/container': sha(newBin) },
    };
    const order: string[] = [];
    const exec: ExecFn = async (file, args) => {
      if (file === '/usr/sbin/pkgutil' && args[0] === '--expand-full') {
        const out = args[2] as string;
        mkdirSync(join(out, 'Payload', 'bin'), { recursive: true });
        writeFileSync(join(out, 'Payload', 'bin', 'container'), newBin);
        order.push('expand');
        return ok();
      }
      if (args[0] === 'system' && args[1] === 'status') {
        // Answered by the old binary still in place: proves we asked before replacing it.
        order.push(`status:${readFileSync(join(roots.installRoot, 'bin', 'container'), 'utf8')}`);
        return ok(statusJson(roots.appRoot, roots.installRoot));
      }
      if (args[0] === 'system' && args[1] === 'stop') {
        order.push('stop');
        return ok();
      }
      return ok();
    };
    const rt = new ContainerRuntime({ ...roots, lock: lk, cacheDir: dir, pkgPath: pkg, exec });
    await rt.provision();
    expect(order).toEqual(['expand', 'status:old binary', 'stop']);
    expect(readFileSync(join(roots.installRoot, 'bin', 'container'), 'utf8')).toBe(newBin);
  });

  it('never writes into a read-only (bundled) install root', async () => {
    const sha = (t: string) => createHash('sha256').update(t).digest('hex');
    const { exec, calls } = fakeExec(() => undefined);
    const fetchImpl = (async () => {
      throw new Error('no download expected');
    }) as unknown as typeof fetch;
    // The bundle's binary does not match the lock: refused, not replaced.
    const rt = new ContainerRuntime({
      ...roots,
      lock: { ...lock, installRootFiles: { 'bin/container': sha('something else') } },
      cacheDir: join(dir, 'cache'),
      exec,
      fetchImpl,
      readOnlyInstall: true,
    });
    await expect(rt.provision()).rejects.toMatchObject({ code: 'NOT_PROVISIONED' });
    expect(calls).toEqual([]);
    expect(readFileSync(join(roots.installRoot, 'bin', 'container'), 'utf8')).toBe('#!/bin/sh\n');
    // A matching (or unpinned) bundle is fine.
    const ok2 = new ContainerRuntime({ ...roots, lock, cacheDir: dir, exec, readOnlyInstall: true });
    await ok2.provision();
    expect(calls).toEqual([]);
  });

  it('is a no-op when the install root already matches', async () => {
    const { exec, calls } = fakeExec(() => undefined);
    const rt = new ContainerRuntime({ ...roots, lock, cacheDir: dir, exec });
    await rt.provision();
    expect(calls).toEqual([]);
  });
});

describe('exec helpers', () => {
  it('kills a call that overruns its timeout', async () => {
    const r = await execWithTimeout('/bin/sleep', ['5'], { timeoutMs: 150 });
    expect(r.timedOut).toBe(true);
    expect(r.ms).toBeLessThan(2000);
    expect(r.signal).toBe('SIGKILL');
  });

  it('L2: kills the whole process group and resolves even when a grandchild holds the pipes', async () => {
    const r = await execWithTimeout('/bin/sh', ['-c', 'sleep 30 & echo $!; wait'], {
      timeoutMs: 300,
      exitGraceMs: 200,
    });
    expect(r.timedOut).toBe(true);
    expect(r.ms).toBeLessThan(3000);
    const grandchild = Number(r.stdout.trim());
    expect(grandchild).toBeGreaterThan(0);
    await new Promise((res) => setTimeout(res, 100));
    expect(() => process.kill(grandchild, 0)).toThrow(); // gone with the group
    // A child that exits while a background grandchild keeps stdout open: resolve after the grace.
    const t0 = Date.now();
    const r2 = await execWithTimeout('/bin/sh', ['-c', '(sleep 5 &); echo done'], {
      timeoutMs: 10_000,
      exitGraceMs: 200,
    });
    expect(r2.code).toBe(0);
    expect(r2.stdout).toContain('done');
    expect(Date.now() - t0).toBeLessThan(3000);
  });

  it('L5: unparsable JSON never echoes its input', () => {
    expect(() => parseCliJson('container list', '{"env":"CUA_ENV_TOKEN=abcdef0123" nope')).toThrow(
      /^container list: unparsable JSON output \(\d+ bytes\)$/,
    );
    expect(parseCliJson<{ a: number }>('x', '{"a":1}')).toEqual({ a: 1 });
  });

  it('redacts tokens in output and errors', () => {
    expect(redact('env CUA_ENV_TOKEN=abcdef123456 x')).toBe('env CUA_ENV_TOKEN=<redacted> x');
    expect(redact('the secret is s3cr3t-value', ['s3cr3t-value'])).toBe('the secret is <redacted>');
    const e = new CliError('container run', { ...ok(), code: 1, stderr: 'bad CUA_ENV_TOKEN=abcdef123456' });
    expect(e.message).not.toContain('abcdef123456');
  });
});
