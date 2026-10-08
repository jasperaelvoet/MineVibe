import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BridgeServer } from '../../src/bridge/BridgeServer.js';
import { resolvePaths } from '../../src/config/paths.js';
import { silentLogger } from '../../src/log.js';
import type { RuntimeContext } from '../../src/orchestrator/modules.js';
import { GiB, type HostFacts } from '../../src/pcs/Budget.js';
import { AppleContainerDriver } from '../../src/pcs/drivers/AppleContainerDriver.js';
import {
  buildPcParts,
  containerRootsFor,
  createPcModule,
  loadContainerLock,
  PcModuleImpl,
} from '../../src/pcs/module.js';
import { PcManager } from '../../src/pcs/PcManager.js';
import { FakePcBridge } from './fakeBridge.js';
import { FakeDriver, fakePool } from './fakes.js';

let dir: string;
let host: HostFacts;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'mv-pcmod-')));
  mkdirSync(join(dir, 'home'), { recursive: true });
  host = { cpus: 18, memBytes: 48 * GiB, diskFreeBytes: 199 * GiB };
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function context(bridge: FakePcBridge, mode: RuntimeContext['mode'] = 'dev'): RuntimeContext {
  return {
    bridge: bridge as unknown as BridgeServer,
    paths: resolvePaths({ env: { MINEVIBE_HOME: join(dir, 'mv') } }),
    log: silentLogger(),
    world: () => ({ worldId: 'world-1', gen: 1 }),
    mode,
  };
}

function moduleWith(driver = new FakeDriver(), bridge = new FakePcBridge()) {
  const ctx = context(bridge);
  const pool = fakePool(join(dir, 'caches'));
  const manager = new PcManager({
    stateDir: ctx.paths.state,
    driver,
    pool,
    labelValue: 'pc-test',
    instanceId: 'unit',
    hostFacts: async () => host,
    home: join(dir, 'home'),
    bootTimeoutMs: 2000,
    portProbe: { attempts: 1, intervalMs: 1 },
  });
  const mod = new PcModuleImpl(
    ctx,
    { manager, pool, pickFolder: async () => null, log: silentLogger() },
    { settleMs: 500, helloRepushMs: 10, budgetDebounceMs: 0 },
  );
  return { mod, manager, driver, bridge };
}

describe('PcModuleImpl', () => {
  it('first run creates linux-1, boots it and pushes its state; stop shuts the PCs down', async () => {
    const { mod, manager, driver, bridge } = moduleWith();
    await mod.start();
    expect(manager.list().map((p) => p.id)).toEqual(['linux-1']);
    await mod.booting;
    expect(manager.status('linux-1').status).toBe('running');
    expect(bridge.pushed('pc.state').at(-1)).toMatchObject({ pcId: 'linux-1', status: 'running' });
    expect(bridge.handlers.has('pc.action')).toBe(true);
    await mod.stop();
    expect(manager.status('linux-1').status).toBe('off');
    expect(driver.log).toContain('engine-stop');
    expect(bridge.handlers.has('pc.action')).toBe(false);
  });

  it('linux-1 comes only with the very first run, not after the player decommissioned every PC', async () => {
    const first = moduleWith();
    await first.mod.start();
    await first.mod.booting;
    await first.manager.decommission('linux-1');
    await first.mod.stop();
    const second = moduleWith(first.driver);
    await second.mod.start();
    await second.mod.booting;
    expect(second.manager.list()).toEqual([]);
    await second.mod.stop();
  });

  it('pcApi exists before start (the agent runtime is built with it)', async () => {
    const { mod } = moduleWith();
    await expect(mod.pcApi.info('linux-1')).rejects.toMatchObject({ code: 'PC_UNKNOWN' });
    await mod.start();
    await mod.booting;
    expect((await mod.pcApi.info('linux-1')).status).toBe('running');
    await mod.stop();
  });

  it('a PC set to wipe on death is reimaged when the world ends', async () => {
    const { mod, manager, driver } = moduleWith();
    await mod.start();
    await mod.booting;
    await manager.setWipeOnDeath('linux-1', true);
    driver.log.length = 0;
    mod.onWorldEnded('world-1');
    for (let i = 0; i < 100 && !driver.log.some((l) => l.startsWith('rmvol')); i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(driver.log.some((l) => l.startsWith('rmvol') && l.includes('-home'))).toBe(true);
    for (let i = 0; i < 100 && manager.status('linux-1').status !== 'running'; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    await mod.stop();
  });

  it('a stop that comes while start is loading wins: nothing is attached and nothing boots', async () => {
    const { mod, driver, bridge } = moduleWith();
    const starting = mod.start();
    const stopping = mod.stop();
    await starting;
    await stopping;
    expect(mod.glue).toBeNull();
    expect(mod.booting).toBeNull();
    expect(bridge.handlers.size).toBe(0);
    expect(driver.log.filter((l) => l === 'engine' || l.startsWith('create '))).toEqual([]);
    await mod.start();
    expect(mod.glue).toBeNull();
  });

  it('PCs planned by the boot that have not started yet stay off once stop begins', async () => {
    /** Holds the first container start until `open()`. */
    class GatedDriver extends FakeDriver {
      readonly started: string[] = [];
      gate: Promise<void> | null = null;
      override async start(name: string) {
        this.started.push(name);
        if (this.started.length === 1 && this.gate) await this.gate;
        return super.start(name);
      }
    }
    const driver = new GatedDriver();
    const earlier = moduleWith(driver);
    await earlier.manager.init({ createDefault: true });
    await earlier.manager.create({ type: 'linux', id: 'linux-2' });
    let open = () => {};
    driver.gate = new Promise<void>((r) => {
      open = r;
    });
    const { mod, manager } = moduleWith(driver);
    await mod.start();
    for (let i = 0; i < 200 && driver.started.length === 0; i++) await new Promise((r) => setTimeout(r, 5));
    expect(driver.started).toHaveLength(1);
    const stopping = mod.stop();
    await new Promise((r) => setTimeout(r, 20));
    open();
    await stopping;
    await mod.booting;
    expect(driver.started).toHaveLength(1);
    expect(manager.list().map((p) => manager.status(p.id).status)).toEqual(['off', 'off']);
  });

  it('an engine that cannot start leaves the PCs engine_down, and start still resolves', async () => {
    const driver = new FakeDriver();
    driver.engineError = new Error('apiserver did not start');
    const { mod, manager } = moduleWith(driver);
    await mod.start();
    await mod.booting;
    expect(manager.status('linux-1').status).toBe('engine_down');
    await mod.stop();
  });
});

describe('createPcModule', () => {
  it('builds the dev stack on the MineVibe-dev roots, with the repo image context and a writable install', () => {
    const parts = buildPcParts(context(new FakePcBridge()), { runtime: 'container' });
    expect(parts.manager.driver).toBeInstanceOf(AppleContainerDriver);
    const rt = (parts.manager.driver as AppleContainerDriver).runtime;
    if (!process.env.MINEVIBE_CONTAINER_APP_ROOT) {
      expect(rt.appRoot).toBe(join(homedir(), 'Library', 'Application Support', 'MineVibe-dev', 'container'));
    }
    expect(rt.lock.version).toBe('1.5.0');
    expect(parts.manager.pcsFile).toBe(join(dir, 'mv', 'state', 'pcs.json'));
  });

  it('uses Docker with runtime docker, and returns a module whose pcApi exists before start', () => {
    const parts = buildPcParts(context(new FakePcBridge()), { runtime: 'docker' });
    expect(parts.manager.driver.kind).toBe('docker');
    const mod = createPcModule(context(new FakePcBridge()), { runtime: 'docker' });
    expect(typeof mod.pcApi.exec).toBe('function');
  });
});

describe('container roots and lock', () => {
  it('dev and play use the MineVibe-dev roots; the app uses Application Support and the bundle', () => {
    const paths = resolvePaths({ env: {}, home: '/Users/me', platform: 'darwin' });
    const dev = containerRootsFor({ mode: 'dev', paths }, undefined, {});
    expect(dev.appRoot).toBe(join(homedir(), 'Library', 'Application Support', 'MineVibe-dev', 'container'));
    expect(dev.installRoot).toBe(
      join(homedir(), 'Library', 'Application Support', 'MineVibe-dev', 'container-root'),
    );
    const app = containerRootsFor(
      { mode: 'app', paths },
      '/Applications/MineVibe.app/Contents/Runtime/container',
      {},
    );
    expect(app).toEqual({
      appRoot: '/Users/me/Library/Application Support/MineVibe/container',
      installRoot: '/Applications/MineVibe.app/Contents/Runtime/container',
    });
    const overridden = containerRootsFor({ mode: 'dev', paths }, undefined, {
      MINEVIBE_CONTAINER_APP_ROOT: '/tmp/a',
      MINEVIBE_CONTAINER_INSTALL_ROOT: '/tmp/b',
    });
    expect(overridden).toEqual({ appRoot: '/tmp/a', installRoot: '/tmp/b' });
  });

  it('reads the first usable vendor lock, else a version-only lock', () => {
    const good = join(dir, 'vendor.lock.json');
    writeFileSync(
      good,
      JSON.stringify({ container: { version: '1.5.0', pkg: { name: 'p', url: 'u', sha256: 'ab' } } }),
    );
    expect(loadContainerLock([join(dir, 'missing.json'), good]).pkg.sha256).toBe('ab');
    const fallback = loadContainerLock([join(dir, 'missing.json')], '1.6.0');
    expect(fallback.version).toBe('1.6.0');
    expect(fallback.installRootFiles).toBeUndefined();
    expect(existsSync(join(dir, 'missing.json'))).toBe(false);
  });
});
