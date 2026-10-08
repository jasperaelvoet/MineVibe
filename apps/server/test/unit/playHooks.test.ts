import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { silentLogger } from '../../src/log.js';
import { type PlayHookContext, play } from '../../src/orchestrator/play.js';

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
