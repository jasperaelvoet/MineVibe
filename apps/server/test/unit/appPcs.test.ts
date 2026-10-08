import { createHash } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { appBundleLayout } from '../../src/app/appLayout.js';
import {
  AppContainerDriver,
  AppPcs,
  abortableExec,
  bundledInstallRootProblems,
  createAppPcs,
  defaultKernelInstalled,
  installRootMismatches,
  isLongContainerCall,
  type PcPrepEvent,
} from '../../src/app/appPcs.js';
import { resolvePaths } from '../../src/config/paths.js';
import { silentLogger } from '../../src/log.js';
import { type ContainerLock, ContainerRuntime, EngineError } from '../../src/pcs/drivers/ContainerRuntime.js';
import type { ExecFn, ExecResult } from '../../src/pcs/drivers/exec.js';
import { MANAGED_LABEL, PC_ID_LABEL, PC_INSTANCE_LABEL } from '../../src/pcs/drivers/PcDriver.js';
import { PcManager } from '../../src/pcs/PcManager.js';
import { FakeDriver, fakePool } from '../pcs/fakes.js';

const dirs: string[] = [];
function tmp(): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'mv-apppcs-')));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const ok = (stdout = '', code = 0): ExecResult => ({
  code,
  signal: null,
  stdout,
  stderr: '',
  ms: 1,
  timedOut: false,
});

/** An install root holding `files`, and the lock that pins exactly them. */
function installRoot(files: Record<string, string>): { root: string; lock: ContainerLock } {
  const root = join(tmp(), 'container');
  for (const [rel, content] of Object.entries(files)) {
    const p = join(root, ...rel.split('/'));
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, content);
    chmodSync(p, 0o755);
  }
  return {
    root,
    lock: {
      version: '1.5.0',
      pkg: { name: 'container.pkg', url: 'https://invalid.example/c.pkg', sha256: 'a'.repeat(64) },
      installRootFiles: Object.fromEntries(Object.entries(files).map(([rel, c]) => [rel, sha(c)])),
    },
  };
}

const FILES = {
  'bin/container': 'container cli\n',
  'bin/container-apiserver': 'apiserver\n',
  'libexec/container/plugins/container-runtime-linux/bin/container-runtime-linux': 'runtime\n',
  'libexec/container/plugins/container-runtime-linux/config.toml': 'abstract = "x"\n',
};

describe('long container calls', () => {
  it('are the kernel download, image pulls and builds only', () => {
    expect(isLongContainerCall(['build', '--progress', 'plain'])).toBe(true);
    expect(isLongContainerCall(['image', 'pull', 'x'])).toBe(true);
    expect(isLongContainerCall(['system', 'start', '--app-root', '/a'])).toBe(true);
    for (const args of [
      ['system', 'stop'],
      ['system', 'status', '--format', 'json'],
      ['builder', 'stop'],
      ['builder', 'delete'],
      ['list', '--all'],
      ['stop', 'x'],
      ['image', 'inspect', 'x'],
    ]) {
      expect(isLongContainerCall(args)).toBe(false);
    }
  });

  it('are killed on abort and refused once aborted; everything else is left alone', async () => {
    const seen: { args: readonly string[]; signal: AbortSignal | undefined }[] = [];
    const base: ExecFn = async (_file, args, options) => {
      seen.push({ args, signal: options.signal });
      return ok();
    };
    const ac = new AbortController();
    const exec = abortableExec(ac.signal, base);
    await exec('/c', ['build', '.'], { timeoutMs: 1000 });
    await exec('/c', ['system', 'stop'], { timeoutMs: 1000 });
    const own = new AbortController();
    await exec('/c', ['image', 'pull', 'x'], { timeoutMs: 1000, signal: own.signal });
    expect(seen.map((s) => s.signal)).toEqual([ac.signal, undefined, own.signal]);

    ac.abort();
    const refused = await exec('/c', ['system', 'start'], { timeoutMs: 1000 });
    expect(refused).toMatchObject({ code: null, error: 'aborted', timedOut: false });
    expect(seen).toHaveLength(3); // never spawned
    await exec('/c', ['builder', 'delete'], { timeoutMs: 1000 }); // cleanup still runs
    expect(seen.at(-1)?.args).toEqual(['builder', 'delete']);
  });
});

describe('bundled install root checks', () => {
  it('accepts an intact root and names missing files and a wrong bin/container, without writing', async () => {
    const { root, lock } = installRoot(FILES);
    expect(await bundledInstallRootProblems(root, lock)).toEqual([]);
    rmSync(join(root, 'bin', 'container-apiserver'));
    expect(await bundledInstallRootProblems(root, lock)).toEqual(['bin/container-apiserver is missing']);
    writeFileSync(join(root, 'bin', 'container-apiserver'), 'apiserver\n');
    writeFileSync(join(root, 'bin', 'container'), 'tampered\n');
    const before = readdirSync(root, { recursive: true }).sort();
    expect((await bundledInstallRootProblems(root, lock))[0]).toMatch(/bin\/container does not match/);
    expect(readdirSync(root, { recursive: true }).sort()).toEqual(before);
  });

  it('the self-test check wants exactly the pinned files, byte for byte', async () => {
    const { root, lock } = installRoot(FILES);
    expect(await installRootMismatches(root, lock)).toEqual([]);
    // A plugin the lock leaves out (k8s) must really be gone.
    mkdirSync(join(root, 'libexec', 'container', 'plugins', 'k8s', 'bin'), { recursive: true });
    writeFileSync(join(root, 'libexec', 'container', 'plugins', 'k8s', 'bin', 'k8s'), 'k8s');
    writeFileSync(join(root, 'bin', 'container-apiserver'), 'changed\n');
    rmSync(join(root, 'libexec', 'container', 'plugins', 'container-runtime-linux', 'config.toml'));
    symlinkSync('/etc/hosts', join(root, 'bin', 'link'));
    expect(await installRootMismatches(root, lock)).toEqual([
      'bin/container-apiserver: sha256 differs from vendor.lock.json',
      'bin/link: not a regular file',
      'libexec/container/plugins/container-runtime-linux/config.toml: missing',
      'libexec/container/plugins/k8s/bin/k8s: not in vendor.lock.json',
    ]);
    expect(await installRootMismatches(join(root, 'nope'), lock)).toContain(
      `${join(root, 'nope')} is missing`,
    );
  });
});

describe('AppContainerDriver', () => {
  function runtimeFor(
    root: string,
    lock: ContainerLock,
    answer: (args: readonly string[]) => ExecResult | undefined,
    liveOthers = false,
  ) {
    const appRoot = join(tmp(), 'app');
    const calls: string[] = [];
    const exec: ExecFn = async (file, args) => {
      calls.push(`${file.endsWith('/container') ? 'container' : file} ${args.join(' ')}`);
      if (file === 'ps') return ok('Thu Oct  8 10:00:00 2026\n');
      return answer(args) ?? ok();
    };
    const runtime = new ContainerRuntime({
      appRoot,
      installRoot: root,
      lock,
      cacheDir: join(appRoot, 'cache'),
      exec,
      uid: 501,
      leases: { pid: 4242, liveness: async () => (liveOthers ? 'alive' : 'dead') },
    });
    return { runtime, calls, appRoot };
  }

  const status = (appRoot: string, installRoot: string, state = 'running') =>
    ok(JSON.stringify({ status: state, paths: { appRoot, installRoot }, server: { version: '1.5.0' } }));

  it('never provisions a bundled root: a damaged one is NOT_PROVISIONED and nothing runs', async () => {
    const { root, lock } = installRoot(FILES);
    rmSync(join(root, 'bin', 'container-apiserver'));
    const { runtime, calls } = runtimeFor(root, lock, () => undefined);
    const driver = new AppContainerDriver(runtime, { mayProvision: false });
    const err = await driver.ensureEngine().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EngineError);
    expect((err as EngineError).code).toBe('NOT_PROVISIONED');
    expect(driver.lastError).toMatch(/damaged.*container-apiserver is missing/);
    expect(calls.filter((c) => /pkgutil|system start/.test(c))).toEqual([]);
  });

  it('starts the engine from the bundled root with our app root and holds a lease', async () => {
    const { root, lock } = installRoot(FILES);
    let started = false;
    const { runtime, calls, appRoot } = runtimeFor(root, lock, (args) => {
      if (args[0] === 'system' && args[1] === 'status')
        return started ? status(appRoot, root) : ok('{"status":"unregistered"}', 1);
      if (args[0] === 'system' && args[1] === 'start') started = true;
      return undefined;
    });
    const launchctl = calls; // launchctl print answers ok('') = no registered job
    const driver = new AppContainerDriver(runtime, { mayProvision: false });
    await driver.ensureEngine();
    expect(driver.lastError).toBeNull();
    const start = calls.find((c) => c.startsWith('container system start'));
    expect(start).toContain(`--app-root ${appRoot}`);
    expect(start).toContain(`--install-root ${root}`);
    expect(start).toContain('--enable-kernel-install');
    expect(readdirSync(join(appRoot, 'minevibe-leases')).filter((n) => n.endsWith('.json'))).toHaveLength(1);
    expect(launchctl.some((c) => c.includes('pkgutil'))).toBe(false);
  });

  it('refuses to restart our apiserver from another install root while another MineVibe holds a lease', async () => {
    const { root, lock } = installRoot(FILES);
    const { runtime, calls, appRoot } = runtimeFor(
      root,
      lock,
      (args) =>
        args[1] === 'status'
          ? status(appRoot, '/Applications/Old.app/Contents/Runtime/container')
          : undefined,
      true,
    );
    mkdirSync(join(appRoot, 'minevibe-leases'), { recursive: true });
    writeFileSync(
      join(appRoot, 'minevibe-leases', '777-abcd.json'),
      JSON.stringify({ pid: 777, started: 'x', holder: 'MineVibe.app', at: 1 }),
    );
    const driver = new AppContainerDriver(runtime, { mayProvision: false });
    const err = await driver.ensureEngine().catch((e: unknown) => e);
    expect((err as EngineError).code).toBe('ENGINE_IN_USE');
    expect(calls.filter((c) => /system (stop|start)|bootout/.test(c))).toEqual([]);
  });

  /** Our apiserver, running from the bundled root; `system stop` / `start` flip it. */
  function oursRunning(liveOthers: boolean) {
    const { root, lock } = installRoot(FILES);
    let running = true;
    const rt = runtimeFor(
      root,
      lock,
      (args) => {
        if (args[0] !== 'system') return undefined;
        if (args[1] === 'status')
          return running ? status(rt.appRoot, root) : ok('{"status":"unregistered"}', 1);
        if (args[1] === 'stop') running = false;
        if (args[1] === 'start') running = true;
        return undefined;
      },
      liveOthers,
    );
    if (liveOthers) {
      mkdirSync(join(rt.appRoot, 'minevibe-leases'), { recursive: true });
      writeFileSync(
        join(rt.appRoot, 'minevibe-leases', '777-abcd.json'),
        JSON.stringify({ pid: 777, started: 'x', holder: 'npm run dev', at: 1 }),
      );
    }
    const kernel = () => {
      mkdirSync(join(rt.appRoot, 'kernels'), { recursive: true });
      writeFileSync(join(rt.appRoot, 'kernels', 'default.kernel-arm64'), 'vmlinux');
    };
    return { ...rt, kernel };
  }
  const engineCalls = (calls: string[]) =>
    calls.filter((c) => /container system (stop|start)|bootout/.test(c)).map((c) => c.split(' --')[0]);

  it('restarts our running apiserver when its kernel is missing (an interrupted first start)', async () => {
    const { runtime, calls, appRoot } = oursRunning(false);
    expect(defaultKernelInstalled(appRoot)).toBe(false);
    await new AppContainerDriver(runtime, { mayProvision: false }).ensureEngine();
    // Stopped, then started again with --enable-kernel-install (which installs the kernel).
    expect(engineCalls(calls)).toEqual(['container system stop', 'container system start']);
    expect(calls.find((c) => c.startsWith('container system start'))).toContain('--enable-kernel-install');
  });

  it('adopts our running apiserver as is when its kernel is there', async () => {
    const { runtime, calls, kernel, appRoot } = oursRunning(false);
    kernel();
    expect(defaultKernelInstalled(appRoot)).toBe(true);
    await new AppContainerDriver(runtime, { mayProvision: false }).ensureEngine();
    expect(engineCalls(calls)).toEqual([]);
  });

  it('never restarts a kernel-less apiserver another live MineVibe uses', async () => {
    const { runtime, calls } = oursRunning(true);
    await new AppContainerDriver(runtime, { mayProvision: false }).ensureEngine();
    expect(engineCalls(calls)).toEqual([]);
  });

  it('never boots out a wedged apiserver of ours while another MineVibe holds a lease on it', async () => {
    const { root, lock } = installRoot(FILES);
    const wedged: ExecResult = { ...ok(), code: null, signal: 'SIGKILL', ms: 15_000, timedOut: true };
    const program = ok(
      `gui/501/com.apple.container.apiserver = {\n\tprogram = ${root}/bin/container-apiserver\n}\n`,
    );
    const { runtime, calls, appRoot } = runtimeFor(
      root,
      lock,
      (args) => {
        if (args[0] === 'system' && args[1] === 'status') return wedged;
        if (args[0] === 'print') return program;
        if (args[0] === 'list') return ok(`-\t0\tcom.apple.container.apiserver\n`);
        return undefined;
      },
      true,
    );
    mkdirSync(join(appRoot, 'minevibe-leases'), { recursive: true });
    writeFileSync(
      join(appRoot, 'minevibe-leases', '777-abcd.json'),
      JSON.stringify({ pid: 777, started: 'x', holder: 'npm run dev', at: 1 }),
    );
    const err = await new AppContainerDriver(runtime, { mayProvision: false })
      .ensureEngine()
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'ENGINE_IN_USE' });
    expect((err as Error).message).toMatch(/does not answer.*pid 777/);
    expect(engineCalls(calls)).toEqual([]);
  });
});

/** An AppPcs over the in-memory driver (no engine, no CLI). */
function fakeAppPcs(
  options: { engineError?: Error; imagePresent?: boolean; dir?: string; driver?: FakeDriver } = {},
) {
  const dir = options.dir ?? tmp();
  const driver = options.driver ?? new FakeDriver();
  driver.imagePresent = options.imagePresent ?? false;
  if (options.engineError) driver.engineError = options.engineError;
  const manager = new PcManager({
    stateDir: join(dir, 'state'),
    driver,
    pool: fakePool(join(dir, 'caches')),
    imageBuild: { contextDir: join(dir, 'ctx'), file: join(dir, 'ctx', 'Containerfile') },
    hostFacts: async () => ({ memBytes: 64 * 1024 ** 3, cpus: 12, diskFreeBytes: 500 * 1024 ** 3 }),
    portProbe: { attempts: 1, intervalMs: 1 },
  });
  const events: PcPrepEvent[] = [];
  const pcs = new AppPcs({
    runtime: null,
    driver,
    manager,
    appRoot: join(dir, 'container'),
    imageContext: join(dir, 'ctx'),
    logger: silentLogger(),
    onProgress: (e) => events.push(e),
  });
  return { pcs, driver, manager, events, dir };
}

describe('AppPcs', () => {
  it('first run: engine, linux-1, the image build, then a background boot and a clean shutdown', async () => {
    const { pcs, driver, manager, events } = fakeAppPcs();
    const outcome = await pcs.prepare();
    expect(outcome).toMatchObject({ engine: 'up', image: 'built' });
    expect(manager.list().map((p) => p.id)).toEqual(['linux-1']);
    expect(events).toEqual([{ step: 'engine', firstRun: true }, { step: 'image' }, { step: 'done' }]);
    expect(driver.log.slice(0, 2)).toEqual(['engine', 'build']);
    expect(await pcs.prepare()).toBe(outcome); // once

    await pcs.boot();
    expect(manager.status('linux-1').status).toBe('running');
    await pcs.shutdown();
    expect(manager.status('linux-1').status).toBe('off');
    expect(driver.log.at(-1)).toBe('engine-stop');
    expect([...driver.containers.values()].every((c) => c.state === 'stopped')).toBe(true);
  });

  it('streams the build output: the latest line to the window, everything to the build log', async () => {
    const dir = tmp();
    class BuildingDriver extends FakeDriver {
      override async buildImage(_options?: unknown, onProgress?: (m: string) => void) {
        onProgress?.('#1 [1/3] FROM ghcr.io/trycua/linux\n#2 [2/3] RUN apt-get update');
        onProgress?.('#2 DONE 12.0s');
        this.imagePresent = true;
      }
    }
    const driver = new BuildingDriver();
    driver.imagePresent = false;
    const manager = new PcManager({
      stateDir: join(dir, 'state'),
      driver,
      pool: fakePool(join(dir, 'caches')),
      imageBuild: { contextDir: join(dir, 'ctx'), file: join(dir, 'ctx', 'Containerfile') },
    });
    const events: PcPrepEvent[] = [];
    const buildLog = join(dir, 'Logs', 'pc-image-build.log');
    const pcs = new AppPcs({
      runtime: null,
      driver,
      manager,
      appRoot: join(dir, 'container'),
      imageContext: join(dir, 'ctx'),
      buildLog,
      logger: silentLogger(),
      onProgress: (e) => events.push(e),
    });
    expect(await pcs.prepare()).toMatchObject({ engine: 'up', image: 'built' });
    expect(events.filter((e) => e.step === 'image')).toEqual([
      { step: 'image' },
      { step: 'image', line: '#2 [2/3] RUN apt-get update' },
      { step: 'image', line: '#2 DONE 12.0s' },
    ]);
    const text = readFileSync(buildLog, 'utf8');
    expect(text).toMatch(/--- .* building minevibe\/linux-pc:dev\n#1 \[1\/3\] FROM/);
    expect(text).toContain('#2 [2/3] RUN apt-get update\n#2 DONE 12.0s\n');
    await pcs.shutdown();
  });

  it("the reaper stops this instance's orphaned containers and leaves other instances' alone", async () => {
    const { pcs, driver, manager } = fakeAppPcs({ imagePresent: true });
    const mine = { [MANAGED_LABEL]: 'pc', [PC_INSTANCE_LABEL]: manager.instanceId, [PC_ID_LABEL]: 'gone-1' };
    const theirs = { [MANAGED_LABEL]: 'pc', [PC_INSTANCE_LABEL]: 'ffffffff', [PC_ID_LABEL]: 'linux-1' };
    for (const [name, labels] of [
      ['mv-pc-mine-gone-1', mine],
      ['mv-pc-ffffffff-linux-1', theirs],
    ] as const) {
      driver.containers.set(name, {
        spec: {
          name,
          image: 'minevibe/linux-pc:dev',
          cpus: 2,
          memoryMiB: 4096,
          shmMiB: 0,
          hostPort: 40000,
          binds: [],
          volumes: [],
          labels,
          env: {},
          secretEnv: {},
        },
        state: 'running',
        labels,
      });
    }
    const outcome = await pcs.prepare();
    expect(outcome.reaped?.orphans).toEqual(['mv-pc-mine-gone-1']);
    expect(driver.containers.get('mv-pc-mine-gone-1')?.state).toBe('stopped');
    expect(driver.containers.get('mv-pc-ffffffff-linux-1')?.state).toBe('running');
    expect(driver.containers.has('mv-pc-mine-gone-1')).toBe(true); // stopped, never deleted
    expect(outcome.image).toBe('present');
    await pcs.shutdown();
  });

  it('an engine that does not start leaves the PCs engine_down and the game goes on', async () => {
    const { pcs, driver, manager, events } = fakeAppPcs({
      engineError: new EngineError('ENGINE_FOREIGN', 'another container install is running'),
    });
    const outcome = await pcs.prepare();
    expect(outcome).toMatchObject({ engine: 'down', image: 'skipped' });
    expect(events.at(-1)).toMatchObject({ step: 'unavailable' });
    expect(manager.status('linux-1').status).toBe('engine_down');
    await pcs.boot(); // a no-op
    expect(driver.log.filter((l) => l.startsWith('create'))).toEqual([]);
    await pcs.shutdown();
  });

  it('a quit before the engine starts skips it, and a shutdown without prepare touches nothing', async () => {
    const quit = new AbortController();
    quit.abort();
    const a = fakeAppPcs();
    expect(await a.pcs.prepare(quit.signal)).toMatchObject({
      engine: 'down',
      detail: 'MineVibe is quitting',
    });
    expect(a.driver.log).not.toContain('engine');
    await a.pcs.boot();
    expect(a.driver.log.filter((l) => l.startsWith('create'))).toEqual([]);

    const b = fakeAppPcs();
    await b.pcs.shutdown();
    expect(b.driver.log).toEqual([]);
  });
});

describe('AppPcs on later launches', () => {
  it('a quit during the PC setup boots nothing, even once the engine is up', async () => {
    const { pcs, driver } = fakeAppPcs({ imagePresent: true });
    expect(await pcs.prepare()).toMatchObject({ engine: 'up' });
    const quit = new AbortController();
    void pcs.prepare(quit.signal);
    quit.abort();
    await pcs.boot();
    expect(driver.log.filter((l) => l.startsWith('create') || l.startsWith('start'))).toEqual([]);
    await pcs.shutdown();
  });

  it('creates linux-1 on the first run only: a player who removed every PC keeps none', async () => {
    const first = fakeAppPcs({ imagePresent: true });
    await first.pcs.prepare();
    expect(first.manager.list().map((p) => p.id)).toEqual(['linux-1']);
    await first.manager.decommission('linux-1');
    await first.pcs.shutdown();
    const next = fakeAppPcs({ imagePresent: true, dir: first.dir, driver: first.driver });
    await next.pcs.prepare();
    expect(next.manager.list()).toEqual([]);
    await next.pcs.shutdown();
  });

  it('is no first run once the kernel is installed, and is one again when it went missing', async () => {
    const warm = fakeAppPcs({ imagePresent: true });
    mkdirSync(join(warm.dir, 'container', 'kernels'), { recursive: true });
    writeFileSync(join(warm.dir, 'container', 'kernels', 'default.kernel-arm64'), 'vmlinux');
    await warm.pcs.prepare();
    expect(warm.events[0]).toEqual({ step: 'engine', firstRun: false });
    await warm.pcs.shutdown();
    // An interrupted kernel download can leave kernels/ without the default kernel.
    const broken = fakeAppPcs({ imagePresent: true });
    mkdirSync(join(broken.dir, 'container', 'kernels'), { recursive: true });
    await broken.pcs.prepare();
    expect(broken.events[0]).toEqual({ step: 'engine', firstRun: true });
    await broken.pcs.shutdown();
  });
});

describe('createAppPcs', () => {
  function bundle(withLock = true) {
    const dir = tmp();
    const app = join(dir, 'MineVibe.app');
    const { root, lock } = installRoot(FILES);
    const layout = appBundleLayout(join(app, 'Contents', 'MacOS', 'node'));
    if (!layout) throw new Error('layout');
    mkdirSync(join(layout.containerInstallRoot, '..'), { recursive: true });
    // The install root lives in the bundle, like build-app puts it.
    rmSync(layout.containerInstallRoot, { recursive: true, force: true });
    mkdirSync(join(app, 'Contents', 'Runtime'), { recursive: true });
    renameSync(root, layout.containerInstallRoot);
    mkdirSync(layout.linuxPcContext, { recursive: true });
    writeFileSync(join(layout.linuxPcContext, 'Containerfile'), 'FROM x@sha256:abc\n');
    if (withLock) writeFileSync(layout.vendorLock, JSON.stringify({ container: lock }));
    const paths = resolvePaths({ env: { MINEVIBE_HOME: join(dir, 'home') } });
    return { layout, paths };
  }

  it('is off with MINEVIBE_PC_RUNTIME=off, and without a bundled vendor.lock.json', async () => {
    const { layout, paths } = bundle();
    const base = { layout, paths, repoRoot: null, logger: silentLogger() };
    expect(await createAppPcs({ ...base, env: { MINEVIBE_PC_RUNTIME: 'off' } })).toBeNull();
    const noLock = bundle(false);
    expect(await createAppPcs({ ...base, ...noLock, env: {} })).toBeNull();
  });

  it.runIf(process.platform === 'darwin')(
    "runs the engine from the bundle's install root, under this home's app root, and never provisions it",
    async () => {
      const { layout, paths } = bundle();
      const pcs = await createAppPcs({ layout, paths, repoRoot: null, logger: silentLogger(), env: {} });
      expect(pcs?.runtime?.installRoot).toBe(layout.containerInstallRoot);
      expect(pcs?.runtime?.appRoot).toBe(paths.container);
      expect(pcs?.imageContext).toBe(layout.linuxPcContext);
      // Tamper with the bundle: the driver refuses instead of provisioning (which would download and write).
      writeFileSync(join(layout.containerInstallRoot, 'bin', 'container'), 'tampered');
      await expect(pcs?.driver.ensureEngine()).rejects.toMatchObject({ code: 'NOT_PROVISIONED' });
    },
  );
});
