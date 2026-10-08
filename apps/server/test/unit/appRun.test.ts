import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { appBundleLayout, BUNDLE_LAYOUT, findBundledModJar } from '../../src/app/appLayout.js';
import type { AppPcs, PcPrepEvent, PcPrepOutcome } from '../../src/app/appPcs.js';
import { LaunchProgress, type LaunchProgressMessage } from '../../src/app/launchProgress.js';
import type { PrereqOptions, PrereqReport } from '../../src/app/prerequisites.js';
import { appHooks, describeFailure, runApp } from '../../src/app/runApp.js';
import type { LineWriter } from '../../src/app/StubChannel.js';
import { runSelftestChecks } from '../../src/app/selftest.js';
import type { NodeToStub } from '../../src/app/stubProtocol.js';
import { writeBridgeFile } from '../../src/bridge/bridgeFile.js';
import { resolvePaths } from '../../src/config/paths.js';
import { silentLogger } from '../../src/log.js';
import { MOD_JAR_ENV, type PlayOptions, RESOURCES_ENV } from '../../src/orchestrator/play.js';
import { AlreadyRunningError } from '../../src/orchestrator/runLock.js';

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'mv-app-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

function stubSide() {
  const stdin = new PassThrough();
  const sent: NodeToStub[] = [];
  const waiters: Array<() => void> = [];
  const writeLine: LineWriter = (line, done) => {
    sent.push(JSON.parse(line) as NodeToStub);
    for (const w of waiters.splice(0)) w();
    queueMicrotask(() => done());
  };
  const command = (cmd: Record<string, unknown>) => stdin.write(`${JSON.stringify(cmd)}\n`);
  const until = async (pred: (m: NodeToStub[]) => boolean) => {
    while (!pred(sent)) await new Promise<void>((r) => waiters.push(r));
  };
  return { stdin, sent, writeLine, command, until };
}

const PREREQS_OK: PrereqReport = {
  ok: true,
  problems: [],
  macos: '26.1',
  claude: { source: 'user', path: '/x/claude', version: '2.1.293' },
  loggedIn: true,
};
const prereqsOk = async () => PREREQS_OK;
const platformOk = { appleSilicon: async () => true, macosVersion: async () => '26.1' };

/**
 * A fake bundle: `<dir>/MineVibe.app/Contents/...` with a mod jar, the lock, seed configs, JRE, the container install
 * root with a vendor.lock.json pinning it, and the Linux PC build context.
 */
function fakeBundle(
  buildInfo: Record<string, unknown> = { commit: 'abc1234', built: '2026-10-08T00:00:00Z' },
): string {
  const bundle = join(tmp(), 'MineVibe.app');
  const at = (rel: string) => join(bundle, ...rel.split('/'));
  mkdirSync(join(at(BUNDLE_LAYOUT.mod), 'seed-configs'), { recursive: true });
  writeFileSync(
    join(at(BUNDLE_LAYOUT.mod), 'minevibe-0.1.0.jar'),
    Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0]),
  );
  // The real lock is the best fixture there is.
  copyFileSync(
    fileURLToPath(new URL('../../../../packaging/mods.lock.json', import.meta.url)),
    join(at(BUNDLE_LAYOUT.mod), 'mods.lock.json'),
  );
  writeFileSync(join(at(BUNDLE_LAYOUT.mod), 'seed-configs', 'dynamic_fps.json'), '{}');
  const pins: Record<string, string> = {};
  for (const rel of [
    'bin/container',
    'bin/container-apiserver',
    'libexec/container/plugins/container-runtime-linux/bin/container-runtime-linux',
    'libexec/container/plugins/container-network-vmnet/bin/container-network-vmnet',
  ]) {
    const p = join(at(BUNDLE_LAYOUT.container), ...rel.split('/'));
    mkdirSync(join(p, '..'), { recursive: true });
    const body = `#!/bin/sh\n# ${rel}\n`;
    writeFileSync(p, body);
    chmodSync(p, 0o755);
    pins[rel] = createHash('sha256').update(body).digest('hex');
  }
  writeFileSync(
    at(BUNDLE_LAYOUT.vendorLock),
    JSON.stringify({
      container: {
        version: '1.5.0',
        pkg: { name: 'c.pkg', url: 'https://invalid.example/c.pkg', sha256: 'a'.repeat(64) },
        installRootFiles: pins,
      },
    }),
  );
  mkdirSync(at(BUNDLE_LAYOUT.linuxPc), { recursive: true });
  writeFileSync(
    join(at(BUNDLE_LAYOUT.linuxPc), 'Containerfile'),
    'FROM ghcr.io/trycua/linux:24.04@sha256:abc\n',
  );
  writeFileSync(join(at(BUNDLE_LAYOUT.linuxPc), 'minevibe-entrypoint.sh'), '#!/bin/sh\n');
  chmodSync(join(at(BUNDLE_LAYOUT.linuxPc), 'minevibe-entrypoint.sh'), 0o755);
  mkdirSync(join(at(BUNDLE_LAYOUT.jre), 'bin'), { recursive: true });
  writeFileSync(join(at(BUNDLE_LAYOUT.jre), 'bin', 'MineVibe'), '');
  mkdirSync(join(bundle, 'Contents', 'MacOS'), { recursive: true });
  writeFileSync(at(BUNDLE_LAYOUT.buildInfo), JSON.stringify(buildInfo));
  return bundle;
}

describe('appBundleLayout', () => {
  it('derives every path from Contents/MacOS/node', () => {
    const layout = appBundleLayout('/Applications/MineVibe.app/Contents/MacOS/node');
    expect(layout).toEqual({
      bundle: '/Applications/MineVibe.app',
      node: '/Applications/MineVibe.app/Contents/MacOS/node',
      serverMain: '/Applications/MineVibe.app/Contents/Resources/server/dist/main.mjs',
      modResources: '/Applications/MineVibe.app/Contents/Resources/mod',
      jreHome: '/Applications/MineVibe.app/Contents/Runtime/jre',
      containerInstallRoot: '/Applications/MineVibe.app/Contents/Runtime/container',
      buildInfo: '/Applications/MineVibe.app/Contents/Resources/build-info.json',
      vendorLock: '/Applications/MineVibe.app/Contents/Resources/vendor.lock.json',
      linuxPcContext: '/Applications/MineVibe.app/Contents/Resources/linux-pc',
    });
  });

  it('is null outside a bundle', () => {
    expect(appBundleLayout('/opt/homebrew/bin/node')).toBeNull();
    expect(appBundleLayout('/x/Contents/MacOS/node')).toBeNull();
    expect(appBundleLayout('/x/Foo.app/MacOS/node')).toBeNull();
  });

  it('finds exactly one mod jar', async () => {
    const dir = tmp();
    expect(await findBundledModJar(join(dir, 'missing'))).toBeNull();
    writeFileSync(join(dir, 'minevibe-0.1.0-sources.jar'), '');
    writeFileSync(join(dir, 'fabric-api.jar'), '');
    expect(await findBundledModJar(dir)).toBeNull();
    writeFileSync(join(dir, 'minevibe-0.1.0.jar'), '');
    expect(await findBundledModJar(dir)).toBe(join(dir, 'minevibe-0.1.0.jar'));
    writeFileSync(join(dir, 'minevibe-0.2.0.jar'), '');
    await expect(findBundledModJar(dir)).rejects.toThrow(/more than one/);
  });
});

describe('selftest checks', () => {
  it('passes for a complete bundle', async () => {
    const bundle = fakeBundle();
    const layout = appBundleLayout(join(bundle, 'Contents', 'MacOS', 'node'));
    const checks = await runSelftestChecks({
      layout,
      repoRoot: null,
      env: { MINEVIBE_HOME: '/tmp/mv-home' },
      bundledJava: () => join(bundle, 'Contents', 'Runtime', 'jre', 'bin', 'MineVibe'),
      probe: async () => ({ version: '25.0.4.1', major: 25 }),
      ...platformOk,
    });
    const byName = Object.fromEntries(checks.map((c) => [c.name, c]));
    expect(Object.keys(byName).sort()).toEqual(
      [
        'container',
        'data',
        'java',
        'linux-pc image',
        'mod jar',
        'mods.lock',
        'node',
        'platform',
        'seed configs',
        'server',
      ].sort(),
    );
    expect(checks.filter((c) => !c.ok)).toEqual([]);
    expect(byName.server?.detail).toContain('abc1234');
    expect(byName.server?.detail).toContain('dev');
    expect(byName.container?.detail).toMatch(/^1\.5\.0, 4 files as pinned/);
    expect(byName.platform?.detail).toBe('Apple silicon, macOS 26.1');
    expect(byName.data?.detail).toBe('/tmp/mv-home');
  });

  it('fails on a missing JRE, a wrong Java, a broken jar and a missing container binary', async () => {
    const bundle = fakeBundle();
    const layout = appBundleLayout(join(bundle, 'Contents', 'MacOS', 'node'));
    writeFileSync(join(bundle, 'Contents', 'Resources', 'mod', 'minevibe-0.1.0.jar'), 'not a zip');
    rmSync(join(bundle, 'Contents', 'Runtime', 'container', 'bin', 'container'));
    const noJava = await runSelftestChecks({
      layout,
      repoRoot: null,
      bundledJava: () => null,
      ...platformOk,
    });
    const failed = noJava.filter((c) => !c.ok).map((c) => c.name);
    expect(failed.sort()).toEqual(['container', 'java', 'mod jar']);
    expect(noJava.find((c) => c.name === 'container')?.detail).toContain('bin/container: missing');
    const wrongJava = await runSelftestChecks({
      layout,
      repoRoot: null,
      bundledJava: () => '/x/java',
      probe: async () => ({ version: '21.0.1', major: 21 }),
      appleSilicon: async () => false,
      macosVersion: async () => '15.6',
    });
    expect(wrongJava.find((c) => c.name === 'java')).toMatchObject({ ok: false });
    expect(wrongJava.find((c) => c.name === 'platform')).toMatchObject({ ok: false });
  });

  it('fails on a container plugin the lock leaves out (k8s) and an unpinned image base', async () => {
    const bundle = fakeBundle();
    const layout = appBundleLayout(join(bundle, 'Contents', 'MacOS', 'node'));
    const k8s = join(
      bundle,
      'Contents',
      'Runtime',
      'container',
      'libexec',
      'container',
      'plugins',
      'k8s',
      'bin',
    );
    mkdirSync(k8s, { recursive: true });
    writeFileSync(join(k8s, 'k8s'), 'k8s');
    writeFileSync(join(bundle, 'Contents', 'Resources', 'linux-pc', 'Containerfile'), 'FROM ubuntu:24.04\n');
    const checks = await runSelftestChecks({
      layout,
      repoRoot: null,
      bundledJava: () => '/x/java',
      probe: async () => ({ version: '25.0.4.1', major: 25 }),
      ...platformOk,
    });
    expect(checks.find((c) => c.name === 'container')?.detail).toContain(
      'libexec/container/plugins/k8s/bin/k8s: not in vendor.lock.json',
    );
    expect(checks.find((c) => c.name === 'linux-pc image')).toMatchObject({ ok: false });
  });
});

describe('runApp --selftest', () => {
  it('says hello, waits for the stub, reports checks and exits on shutdown', async () => {
    const stub = stubSide();
    const result = runApp({
      argv: ['--selftest'],
      stdin: stub.stdin,
      writeLine: stub.writeLine,
      logger: silentLogger(),
      layout: null,
      repoRoot: null,
      selftest: async () => [{ name: 'node', ok: true, detail: 'v24' }],
    });
    await stub.until((m) => m.some((x) => x.t === 'hello'));
    expect(stub.sent[0]).toMatchObject({ t: 'hello', v: 1, mode: 'selftest', pid: process.pid });
    stub.command({ cmd: 'hello', v: 1, stub: 'test', pid: 1 });
    await stub.until((m) => m.some((x) => x.t === 'selftest'));
    expect(stub.sent.find((m) => m.t === 'selftest')).toEqual({
      t: 'selftest',
      ok: true,
      checks: [{ name: 'node', ok: true, detail: 'v24' }],
    });
    stub.command({ cmd: 'shutdown', reason: 'selftest' });
    await expect(result).resolves.toBe(0);
  });

  it('exits 1 when a check fails, and when the stub never says hello', async () => {
    const stub = stubSide();
    const failing = runApp({
      argv: ['--selftest'],
      stdin: stub.stdin,
      writeLine: stub.writeLine,
      logger: silentLogger(),
      layout: null,
      repoRoot: null,
      selftest: async () => [{ name: 'java', ok: false, detail: 'missing' }],
    });
    stub.command({ cmd: 'hello', v: 1, stub: 'test', pid: 1 });
    await stub.until((m) => m.some((x) => x.t === 'selftest'));
    stub.stdin.end();
    await expect(failing).resolves.toBe(1);

    const silent = stubSide();
    await expect(
      runApp({
        argv: ['--selftest'],
        stdin: silent.stdin,
        writeLine: silent.writeLine,
        logger: silentLogger(),
        layout: null,
        repoRoot: null,
        helloTimeoutMs: 20,
      }),
    ).resolves.toBe(1);
  });
});

describe('runApp (app mode)', () => {
  function fakePlay(behaviour: (options: PlayOptions) => Promise<number>) {
    const calls: PlayOptions[] = [];
    return {
      calls,
      play: async (options: PlayOptions) => {
        calls.push(options);
        return behaviour(options);
      },
    };
  }

  /** A play() that installs its stop handler, reports milestones, and returns 130 once stopped. */
  const stoppable = (options: PlayOptions) =>
    new Promise<number>((resolve) => {
      options.onProgress?.({ phase: 'install', state: 'start' });
      options.onProgress?.({ phase: 'install', state: 'done' });
      options.onProgress?.({ phase: 'launched', pid: 99 });
      options.onProgress?.({ phase: 'connected' });
      if (options.control) {
        options.control.onStopRequest = (reason) => {
          resolve(reason.startsWith('stub:') || reason === 'stub-gone' ? 130 : 2);
        };
      }
    });

  it('runs play from the bundle resources and stops it on a shutdown command', async () => {
    const bundle = fakeBundle();
    const stub = stubSide();
    const fake = fakePlay(stoppable);
    const result = runApp({
      argv: [],
      prerequisites: prereqsOk,
      pcs: null,
      stdin: stub.stdin,
      writeLine: stub.writeLine,
      logger: silentLogger(),
      layout: appBundleLayout(join(bundle, 'Contents', 'MacOS', 'node')),
      env: { [MOD_JAR_ENV]: '/elsewhere.jar', MINEVIBE_HOME: '/tmp/x' },
      handleSignals: false,
      play: fake.play,
    });
    await stub.until((m) => m.some((x) => x.t === 'ready'));
    expect(stub.sent[0]).toMatchObject({ t: 'hello', mode: 'app' });
    const call = fake.calls[0];
    expect(call?.repoRoot).toBeNull();
    expect(call?.env?.[RESOURCES_ENV]).toBe(join(bundle, 'Contents', 'Resources', 'mod'));
    expect(call?.env?.[MOD_JAR_ENV]).toBe(join(bundle, 'Contents', 'Resources', 'mod', 'minevibe-0.1.0.jar'));
    expect(call?.env?.MINEVIBE_HOME).toBe('/tmp/x');
    expect(typeof call?.fetch).toBe('function');
    stub.command({ cmd: 'shutdown', reason: 'sigterm' });
    await expect(result).resolves.toBe(130);
    expect(stub.sent.at(-1)).toEqual({ t: 'exit', code: 130 });
  });

  it('treats EOF on stdin (the stub died) as a stop', async () => {
    const stub = stubSide();
    const result = runApp({
      argv: [],
      prerequisites: prereqsOk,
      pcs: null,
      stdin: stub.stdin,
      writeLine: stub.writeLine,
      logger: silentLogger(),
      layout: null,
      repoRoot: '/repo',
      handleSignals: false,
      play: fakePlay(stoppable).play,
    });
    await stub.until((m) => m.some((x) => x.t === 'ready'));
    stub.stdin.end();
    await expect(result).resolves.toBe(130);
  });

  it('replays a stop that arrived before play installed its handler', async () => {
    const stub = stubSide();
    let gate: () => void = () => {};
    const opened = new Promise<void>((r) => {
      gate = r;
    });
    const result = runApp({
      argv: [],
      prerequisites: prereqsOk,
      pcs: null,
      stdin: stub.stdin,
      writeLine: stub.writeLine,
      logger: silentLogger(),
      layout: null,
      repoRoot: '/repo',
      handleSignals: false,
      play: async (options) => {
        await opened; // the stop arrives while play is still setting up
        return stoppable(options);
      },
    });
    await stub.until((m) => m.some((x) => x.t === 'hello'));
    stub.command({ cmd: 'shutdown', reason: 'quit' });
    await tick(20);
    gate();
    await expect(result).resolves.toBe(130);
  });

  it('reports a failure to the stub and exits 1', async () => {
    const stub = stubSide();
    const result = runApp({
      argv: [],
      prerequisites: prereqsOk,
      pcs: null,
      stdin: stub.stdin,
      writeLine: stub.writeLine,
      logger: silentLogger(),
      layout: null,
      repoRoot: '/repo',
      handleSignals: false,
      play: async () => {
        throw new Error('GET https://piston-meta.mojang.com/x failed: HTTP 503');
      },
    });
    await expect(result).resolves.toBe(1);
    expect(stub.sent.find((m) => m.t === 'error')).toMatchObject({
      t: 'error',
      message: 'MineVibe could not download the game files',
    });
    expect(stub.sent.at(-1)).toEqual({ t: 'exit', code: 1 });
  });

  it('explains a game that quit by itself with an error, but not a clean quit', async () => {
    const crashed = stubSide();
    await expect(
      runApp({
        argv: [],
        prerequisites: prereqsOk,
        pcs: null,
        stdin: crashed.stdin,
        writeLine: crashed.writeLine,
        logger: silentLogger(),
        layout: null,
        repoRoot: '/repo',
        env: { MINEVIBE_HOME: '/tmp/mv-home' },
        handleSignals: false,
        play: async () => 1,
      }),
    ).resolves.toBe(1);
    expect(crashed.sent.find((m) => m.t === 'error')).toMatchObject({
      message: 'Minecraft quit unexpectedly',
      detail: expect.stringContaining('/tmp/mv-home/Logs/minecraft-console.log'),
    });

    const clean = stubSide();
    await expect(
      runApp({
        argv: [],
        prerequisites: prereqsOk,
        pcs: null,
        stdin: clean.stdin,
        writeLine: clean.writeLine,
        logger: silentLogger(),
        layout: null,
        repoRoot: '/repo',
        handleSignals: false,
        play: async () => 0,
      }),
    ).resolves.toBe(0);
    expect(clean.sent.some((m) => m.t === 'error')).toBe(false);
    expect(clean.sent.at(-1)).toEqual({ t: 'exit', code: 0 });
  });

  it('refuses a bundle without a mod jar', async () => {
    const bundle = fakeBundle();
    rmSync(join(bundle, 'Contents', 'Resources', 'mod', 'minevibe-0.1.0.jar'));
    const stub = stubSide();
    const result = runApp({
      argv: [],
      prerequisites: prereqsOk,
      pcs: null,
      stdin: stub.stdin,
      writeLine: stub.writeLine,
      logger: silentLogger(),
      layout: appBundleLayout(join(bundle, 'Contents', 'MacOS', 'node')),
      handleSignals: false,
      play: async () => 0,
    });
    await expect(result).resolves.toBe(1);
    expect(stub.sent.find((m) => m.t === 'error')).toMatchObject({
      detail: expect.stringContaining('mod jar'),
    });
  });
});

describe('runApp prerequisites, protocol and hooks', () => {
  it('stops before anything starts when a prerequisite is missing, with a one-line instruction', async () => {
    const stub = stubSide();
    let played = false;
    const result = runApp({
      argv: [],
      stdin: stub.stdin,
      writeLine: stub.writeLine,
      logger: silentLogger(),
      layout: null,
      repoRoot: '/repo',
      handleSignals: false,
      pcs: null,
      prerequisites: async () => ({
        ...PREREQS_OK,
        ok: false,
        claude: null,
        problems: [
          {
            id: 'claude',
            message: 'Claude Code 2.1.284 is too old',
            instruction: 'Run `claude update` in Terminal, then open MineVibe again.',
          },
        ],
      }),
      play: async () => {
        played = true;
        return 0;
      },
    });
    await expect(result).resolves.toBe(1);
    expect(played).toBe(false);
    expect(stub.sent.find((m) => m.t === 'error')).toEqual({
      t: 'error',
      message: 'Claude Code 2.1.284 is too old',
      detail: 'Run `claude update` in Terminal, then open MineVibe again.',
    });
    expect(stub.sent.at(-1)).toEqual({ t: 'exit', code: 1 });
  });

  it('lets only dev builds (and a checkout) run the SDK claude', async () => {
    const seen: boolean[] = [];
    const record = async (o: PrereqOptions) => {
      seen.push(o.allowBundled);
      return PREREQS_OK;
    };
    for (const layout of [
      appBundleLayout(join(fakeBundle({ channel: 'dev' }), 'Contents', 'MacOS', 'node')),
      appBundleLayout(join(fakeBundle({ channel: 'release' }), 'Contents', 'MacOS', 'node')),
      appBundleLayout(join(fakeBundle({}), 'Contents', 'MacOS', 'node')), // before channels: dev
      null,
    ]) {
      const stub = stubSide();
      await runApp({
        argv: [],
        stdin: stub.stdin,
        writeLine: stub.writeLine,
        logger: silentLogger(),
        layout,
        repoRoot: layout ? null : '/repo',
        handleSignals: false,
        pcs: null,
        prerequisites: record,
        play: async () => 0,
      });
    }
    expect(seen).toEqual([true, false, true, true]);
    // An unreadable build-info.json is the strict side.
    const bundle = fakeBundle();
    writeFileSync(join(bundle, 'Contents', 'Resources', 'build-info.json'), '{');
    const stub = stubSide();
    await runApp({
      argv: [],
      stdin: stub.stdin,
      writeLine: stub.writeLine,
      logger: silentLogger(),
      layout: appBundleLayout(join(bundle, 'Contents', 'MacOS', 'node')),
      handleSignals: false,
      pcs: null,
      prerequisites: record,
      play: async () => 0,
    });
    expect(seen.at(-1)).toBe(false);
  });

  it('stops when the stub speaks another protocol version (app), and fails the self-test', async () => {
    const stub = stubSide();
    const fake = (options: PlayOptions) =>
      new Promise<number>((resolve) => {
        if (options.control)
          options.control.onStopRequest = (reason) => resolve(reason === 'stub-protocol' ? 130 : 2);
      });
    const result = runApp({
      argv: [],
      stdin: stub.stdin,
      writeLine: stub.writeLine,
      logger: silentLogger(),
      layout: null,
      repoRoot: '/repo',
      handleSignals: false,
      prerequisites: prereqsOk,
      pcs: null,
      play: fake,
    });
    await stub.until((m) => m.some((x) => x.t === 'hello'));
    stub.command({ cmd: 'hello', v: 2, stub: 'future', pid: 1 });
    await expect(result).resolves.toBe(130);
    expect(stub.sent.find((m) => m.t === 'error')).toMatchObject({
      message: 'MineVibe is damaged',
      detail: expect.stringContaining('launcher speaks protocol v2, its server v1'),
    });

    const self = stubSide();
    const selftest = runApp({
      argv: ['--selftest'],
      stdin: self.stdin,
      writeLine: self.writeLine,
      logger: silentLogger(),
      layout: null,
      repoRoot: null,
      selftest: async () => [{ name: 'node', ok: true, detail: 'v24' }],
    });
    self.command({ cmd: 'hello', v: 7, stub: 'future', pid: 1 });
    await self.until((m) => m.some((x) => x.t === 'selftest'));
    expect(self.sent.find((m) => m.t === 'selftest')).toMatchObject({
      ok: false,
      checks: [
        { name: 'stub protocol', ok: false },
        { name: 'node', ok: true },
      ],
    });
    self.stdin.end();
    await expect(selftest).resolves.toBe(1);
  });

  it('hands play the app hooks', async () => {
    const stub = stubSide();
    const calls: PlayOptions[] = [];
    await runApp({
      argv: [],
      stdin: stub.stdin,
      writeLine: stub.writeLine,
      logger: silentLogger(),
      layout: null,
      repoRoot: '/repo',
      handleSignals: false,
      prerequisites: prereqsOk,
      pcs: null,
      play: async (o) => {
        calls.push(o);
        return 0;
      },
    });
    expect(Object.keys(calls[0]?.hooks ?? {}).sort()).toEqual([
      'afterLock',
      'beforeLaunch',
      'beforeTeardown',
    ]);
  });
});

describe('appHooks', () => {
  /** A stand-in for AppPcs: prepare resolves when the test says so. */
  function fakePcs() {
    const log: string[] = [];
    let finish: (o: PcPrepOutcome) => void = () => {};
    const pcs = {
      prepare(signal?: AbortSignal) {
        log.push(`prepare aborted=${signal?.aborted}`);
        return new Promise<PcPrepOutcome>((r) => {
          finish = r;
        });
      },
      async boot() {
        log.push('boot');
      },
      async shutdown() {
        log.push('shutdown');
      },
    } as unknown as AppPcs;
    return { pcs, log, finish: (o: PcPrepOutcome) => finish(o) };
  }

  function setup(createPcs: Parameters<typeof appHooks>[0]['createPcs']) {
    const sent: LaunchProgressMessage[] = [];
    const progress = new LaunchProgress((m) => sent.push(m), { throttleMs: 0 });
    const home = join(tmp(), 'home');
    const paths = resolvePaths({ env: { MINEVIBE_HOME: home } });
    mkdirSync(paths.run, { recursive: true });
    const hooks = appHooks({
      layout: null,
      repoRoot: '/repo',
      env: {},
      log: silentLogger(),
      progress,
      createPcs,
    });
    const context = { paths, signal: new AbortController().signal, logger: silentLogger() };
    return { hooks, context, paths, sent, progress };
  }

  it('afterLock reaps a stale bridge file and starts the PC setup without waiting for it', async () => {
    const fake = fakePcs();
    let created: unknown;
    const { hooks, context, paths } = setup(async (o) => {
      created = o;
      return fake.pcs;
    });
    await writeBridgeFile(paths.bridgeFile, { port: 4000, token: 'b'.repeat(32), pid: 999_999 });
    await hooks.afterLock?.(context);
    expect(existsSync(paths.bridgeFile)).toBe(false);
    expect(created).toMatchObject({ paths, layout: null, repoRoot: '/repo' });
    expect(fake.log).toEqual(['prepare aborted=false']); // started, not awaited
  });

  it('beforeLaunch shows the PC lane while the game waits, then boots the PCs; teardown stops them', async () => {
    const fake = fakePcs();
    const { hooks, context, sent, progress } = setup(async (o) => {
      o.onProgress?.({ step: 'image' } satisfies PcPrepEvent);
      return fake.pcs;
    });
    await hooks.afterLock?.(context);
    let launched = false;
    const waiting = hooks.beforeLaunch?.(context).then(() => {
      launched = true;
    });
    await tick();
    expect(launched).toBe(false);
    expect(sent.at(-1)).toMatchObject({
      t: 'progress',
      phase: 'pcs',
      work: true,
      title: 'Building the Linux PC image (first run)',
    });
    fake.finish({ engine: 'up', image: 'built' });
    await waiting;
    expect(fake.log).toEqual(['prepare aborted=false', 'boot']);
    await hooks.beforeTeardown?.(context);
    expect(fake.log.at(-1)).toBe('shutdown');
    progress.dispose();
  });

  it('without PCs the hooks only reap', async () => {
    const { hooks, context } = setup(null);
    await hooks.afterLock?.(context);
    await hooks.beforeLaunch?.(context);
    await hooks.beforeTeardown?.(context);
  });
});

describe('describeFailure', () => {
  it('maps errors to short dialog messages', () => {
    expect(describeFailure(new AlreadyRunningError(42)).message).toBe('MineVibe is already running');
    expect(describeFailure(new TypeError('fetch failed')).message).toMatch(/download/);
    expect(describeFailure(new Error('client.jar: sha1 mismatch (got …)')).message).toMatch(/checksum/);
    expect(describeFailure(new Error('boom')).message).toBe('MineVibe could not start the game');
  });
});
