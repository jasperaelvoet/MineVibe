import { describe, expect, it } from 'vitest';
import {
  admit,
  type BootCandidate,
  compareBootPriority,
  computeBudget,
  cpuCost,
  defaultBudgetSettings,
  GiB,
  type HostFacts,
  type PcAllocation,
  planBoot,
  reservedMemBytes,
} from '../../src/pcs/Budget.js';

/** The S5 host: M5 Pro, 18 cores, 48 GiB, ~199 GiB free. */
const host: HostFacts = { cpus: 18, memBytes: 48 * GiB, diskFreeBytes: 199 * GiB };
const settings = defaultBudgetSettings();

function linux(id: string, over: Partial<PcAllocation> = {}): PcAllocation {
  return { id, family: 'linux', cpus: 2, memMiB: 4096, cpuOverhead: 1, active: true, diskGiB: 56, ...over };
}
function mac(id: string, over: Partial<PcAllocation> = {}): PcAllocation {
  return { id, family: 'macos', cpus: 4, memMiB: 8192, cpuOverhead: 0, active: true, diskGiB: 150, ...over };
}

describe('pools (PLAN §8.2)', () => {
  it('reserves macOS 10 + Minecraft 8 + Node 0.5 + claude 1×crew + container 1 GiB', () => {
    expect(reservedMemBytes(settings)).toBe(23.5 * GiB);
    expect(reservedMemBytes(defaultBudgetSettings({ crewCap: 6 }))).toBe(25.5 * GiB);
  });

  it('leaves 24.5 GiB of PC RAM on a 48 GiB host with crew cap 4', () => {
    const b = computeBudget(host, settings, []);
    expect(b.pool.memBytes).toBe(24.5 * GiB);
    expect(b.free.memBytes).toBe(24.5 * GiB);
  });

  it('CPU pool is cores − 4 with a 1.5× soft cap', () => {
    const b = computeBudget(host, settings, []);
    expect(b.pool.cpus).toBe(14);
    expect(b.pool.cpuSoftCap).toBe(21);
  });

  it('counts --cpus + 1 for Apple container PCs (S5 cpuOverhead)', () => {
    expect(cpuCost(linux('a'))).toBe(3);
    const b = computeBudget(host, settings, [linux('a'), linux('b', { active: false })]);
    expect(b.allocated.cpus).toBe(3);
    expect(b.allocated.memBytes).toBe(4 * GiB);
    // Stopped PCs still hold their disk caps.
    expect(b.allocated.diskBytes).toBe(112 * GiB);
  });

  it('counts running macOS VMs and free slots', () => {
    const b = computeBudget(host, settings, [mac('m1'), mac('m2', { active: false })]);
    expect(b.allocated.macosRunning).toBe(1);
    expect(b.free.macosSlots).toBe(1);
  });

  it('warns about overcommitted CPUs and low live memory', () => {
    const many = Array.from({ length: 5 }, (_, i) => linux(`l${i}`));
    const b = computeBudget({ ...host, liveFreeMemBytes: 0.5 * GiB }, settings, many);
    expect(b.allocated.cpus).toBe(15);
    expect(b.warnings.join('\n')).toMatch(/CPU overcommitted/);
    expect(b.warnings.join('\n')).toMatch(/memory is low/);
  });
});

describe('admission', () => {
  it('admits linux-1 on an empty host', () => {
    const r = admit(host, settings, [], { kind: 'start', pc: linux('linux-1') });
    expect(r).toEqual({ ok: true, warnings: [] });
  });

  it('refuses RAM beyond the pool with OVER_BUDGET/memory', () => {
    const pcs = [linux('a', { memMiB: 20 * 1024 })];
    const r = admit(host, settings, pcs, { kind: 'start', pc: linux('b', { memMiB: 8 * 1024 }) });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('OVER_BUDGET');
      expect(r.resource).toBe('memory');
      expect(r.detail).toMatch(/4\.5 GiB free of 24\.5 GiB/);
    }
  });

  it('allows CPU overcommit up to the soft cap with a warning, refuses past it', () => {
    // 6 PCs × 3 vCPUs = 18 > 14 (warning) but ≤ 21.
    const five = Array.from({ length: 5 }, (_, i) => linux(`l${i}`, { memMiB: 1024 }));
    const ok = admit(host, settings, five, { kind: 'start', pc: linux('six', { memMiB: 1024 }) });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.warnings.join()).toMatch(/CPU overcommitted: 18 of 14/);
    const six = [...five, linux('l5', { memMiB: 1024 })];
    const bad = admit(host, settings, six, { kind: 'start', pc: linux('seven', { memMiB: 1024, cpus: 4 }) });
    expect(bad).toMatchObject({ ok: false, reason: 'OVER_BUDGET', resource: 'cpu' });
  });

  it('refuses a third running macOS VM with MACOS_SLOTS', () => {
    const r = admit({ ...host, memBytes: 128 * GiB }, settings, [mac('m1'), mac('m2')], {
      kind: 'start',
      pc: mac('m3'),
    });
    expect(r).toMatchObject({ ok: false, reason: 'MACOS_SLOTS' });
  });

  it('needs 40 GB free disk to create a macOS PC', () => {
    const r = admit({ ...host, diskFreeBytes: 30e9 }, settings, [], {
      kind: 'create',
      pc: mac('m1', { active: false, diskGiB: 1 }),
    });
    expect(r).toMatchObject({ ok: false, reason: 'OVER_BUDGET', resource: 'disk' });
  });

  it('counts disk caps of every PC (running or not) against free disk minus the reserve', () => {
    const small: HostFacts = { ...host, diskFreeBytes: 100 * GiB }; // pool 80 GiB
    const existing = [linux('a', { active: false, diskGiB: 56 })];
    const r = admit(small, settings, existing, {
      kind: 'create',
      pc: linux('b', { active: false, diskGiB: 56 }),
    });
    expect(r).toMatchObject({ ok: false, reason: 'OVER_BUDGET', resource: 'disk' });
    // A plain start allocates no new disk.
    const s = admit(small, settings, existing, { kind: 'start', pc: linux('a') });
    expect(s.ok).toBe(true);
  });

  it('checks an edit as "replace my allocation"', () => {
    const pcs = [linux('a', { memMiB: 20 * 1024 })];
    // Growing a to 24 GiB fits because its old 20 GiB are excluded.
    expect(admit(host, settings, pcs, { kind: 'edit', pc: linux('a', { memMiB: 24 * 1024 }) }).ok).toBe(true);
    expect(admit(host, settings, pcs, { kind: 'edit', pc: linux('a', { memMiB: 25 * 1024 }) }).ok).toBe(
      false,
    );
  });

  it('admits a create that will not boot on disk alone', () => {
    const pcs = [linux('a', { memMiB: 24 * 1024 })];
    expect(admit(host, settings, pcs, { kind: 'create', pc: linux('b', { active: false }) }).ok).toBe(true);
    expect(admit(host, settings, pcs, { kind: 'create', pc: linux('b', { active: true }) }).ok).toBe(false);
  });
});

describe('boot priority and planBoot', () => {
  const c = (id: string, over: Partial<BootCandidate> = {}): BootCandidate => ({
    ...linux(id, { active: false }),
    ...over,
  });

  it('orders pinned first, then most recently used, then oldest', () => {
    const list = [
      c('old', { createdAt: 1 }),
      c('recent', { lastUsedAt: 500, createdAt: 9 }),
      c('pinned', { pinned: true, createdAt: 10 }),
      c('older-use', { lastUsedAt: 100 }),
    ].sort(compareBootPriority);
    expect(list.map((x) => x.id)).toEqual(['pinned', 'recent', 'older-use', 'old']);
  });

  it('boots greedily in priority order and refuses what does not fit', () => {
    const plan = planBoot(host, settings, [
      c('a', { memMiB: 12 * 1024, lastUsedAt: 3 }),
      c('b', { memMiB: 12 * 1024, lastUsedAt: 2 }),
      c('c', { memMiB: 4 * 1024, lastUsedAt: 1 }),
    ]);
    expect(plan.boot).toEqual(['a', 'b']);
    expect(plan.refused).toEqual([
      expect.objectContaining({ id: 'c', reason: 'OVER_BUDGET', resource: 'memory' }),
    ]);
  });

  it('counts PCs that are already running first', () => {
    const plan = planBoot(
      host,
      settings,
      [c('b', { memMiB: 8 * 1024 })],
      [linux('running', { memMiB: 20 * 1024 })],
    );
    expect(plan.boot).toEqual([]);
    expect(plan.refused[0]?.id).toBe('b');
  });

  it('turns a third macOS VM into MACOS_SLOTS', () => {
    const big: HostFacts = { ...host, memBytes: 128 * GiB };
    const m = (id: string, at: number): BootCandidate => ({ ...mac(id, { active: false }), lastUsedAt: at });
    const plan = planBoot(big, settings, [m('m1', 3), m('m2', 2), m('m3', 1)]);
    expect(plan.boot).toEqual(['m1', 'm2']);
    expect(plan.refused).toEqual([expect.objectContaining({ id: 'm3', reason: 'MACOS_SLOTS' })]);
  });
});
