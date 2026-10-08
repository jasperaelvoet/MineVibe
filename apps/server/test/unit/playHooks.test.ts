import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { silentLogger } from '../../src/log.js';
import {
  e2eJvmArgs,
  MOD_JAR_ENV,
  type PlayHookContext,
  play,
  RESOURCES_ENV,
} from '../../src/orchestrator/play.js';

const repoRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..', '..');

const dirs: string[] = [];
function home(): string {
  const d = mkdtempSync(join(tmpdir(), 'mv-hooks-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('play hooks (MineVibe.app)', () => {
  it('runs afterLock under the run lock and beforeTeardown on the way out, even when the launch fails', async () => {
    const h = home();
    const order: string[] = [];
    let context: PlayHookContext | null = null;
    await expect(
      play({
        repoRoot: null,
        logger: silentLogger(),
        env: { MINEVIBE_HOME: h }, // no mods.lock.json anywhere: fails right after afterLock
        hooks: {
          async afterLock(ctx) {
            context = ctx;
            order.push(`afterLock lock=${existsSync(join(h, 'run', 'lock'))}`);
          },
          async beforeLaunch() {
            order.push('beforeLaunch');
          },
          async beforeTeardown(ctx) {
            order.push(`beforeTeardown lock=${existsSync(join(h, 'run', 'lock'))} same=${ctx === context}`);
          },
        },
      }),
    ).rejects.toThrow(/mods\.lock\.json/);
    expect(order).toEqual(['afterLock lock=true', 'beforeTeardown lock=true same=true']);
    expect(existsSync(join(h, 'run', 'lock'))).toBe(false); // released after the teardown hook
    expect((context as PlayHookContext | null)?.paths.appSupport).toBe(h);
  });

  it('a stop during afterLock ends the launch there: no bridge, no installs, and the teardown runs', async () => {
    const h = home();
    const order: string[] = [];
    const control: { onStopRequest: ((reason: string) => void) | null } = { onStopRequest: null };
    const jar = join(h, 'minevibe-0.1.0.jar');
    writeFileSync(jar, '');
    const code = await play({
      repoRoot: null,
      logger: silentLogger(),
      // Everything the launch needs before the bridge starts is there (the real lock, a mod jar).
      env: { MINEVIBE_HOME: h, [RESOURCES_ENV]: join(repoRoot, 'packaging'), [MOD_JAR_ENV]: jar },
      control,
      hooks: {
        async afterLock() {
          order.push('afterLock');
          control.onStopRequest?.('stub:cancel'); // the window's Quit button, during the reaper
        },
        async beforeLaunch() {
          order.push('beforeLaunch');
        },
        async beforeTeardown() {
          // The bridge (if any) is still up here: it stops after the teardown hook.
          order.push(`beforeTeardown bridge=${existsSync(join(h, 'run', 'bridge.json'))}`);
        },
      },
    });
    expect(code).toBe(130);
    expect(order).toEqual(['afterLock', 'beforeTeardown bridge=false']);
    expect(existsSync(join(h, 'run', 'lock'))).toBe(false);
  });

  it('a failing afterLock still tears down; a failing teardown is only logged', async () => {
    const h = home();
    const order: string[] = [];
    await expect(
      play({
        repoRoot: null,
        logger: silentLogger(),
        env: { MINEVIBE_HOME: h },
        hooks: {
          async afterLock() {
            order.push('afterLock');
            throw new Error('reaper failed');
          },
          async beforeTeardown() {
            order.push('beforeTeardown');
            throw new Error('teardown failed');
          },
        },
      }),
    ).rejects.toThrow('reaper failed');
    expect(order).toEqual(['afterLock', 'beforeTeardown']);
    expect(existsSync(join(h, 'run', 'lock'))).toBe(false);
  });
});

describe('E2E mode (MINEVIBE_E2E=1 npm run play)', () => {
  it('turns on the game debug handlers with the system property the mod reads', () => {
    expect(e2eJvmArgs(true)).toEqual(['-Dminevibe.e2e=true']);
    expect(e2eJvmArgs(false)).toEqual([]);
  });
});
