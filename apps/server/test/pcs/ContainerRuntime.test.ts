import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
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

function statusJson(appRoot: string, installRoot: string, status = 'running'): string {
  return JSON.stringify({
    status,
    paths: { appRoot: `${appRoot}/`, installRoot: `${installRoot}/` },
    server: { version: '1.5.0' },
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

  it('redacts tokens in output and errors', () => {
    expect(redact('env CUA_ENV_TOKEN=abcdef123456 x')).toBe('env CUA_ENV_TOKEN=<redacted> x');
    expect(redact('the secret is s3cr3t-value', ['s3cr3t-value'])).toBe('the secret is <redacted>');
    const e = new CliError('container run', { ...ok(), code: 1, stderr: 'bad CUA_ENV_TOKEN=abcdef123456' });
    expect(e.message).not.toContain('abcdef123456');
  });
});
