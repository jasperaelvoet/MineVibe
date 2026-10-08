import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrainScheduler, type Grant, SchedulerCancelled } from '../../../src/agents/BrainScheduler.js';
import { BrainSupervisor, isAuthError } from '../../../src/agents/BrainSupervisor.js';
import { normalizeEpoch, normalizeUtilization, UsageGovernor } from '../../../src/agents/UsageGovernor.js';

const flush = () => new Promise((r) => setImmediate(r));

describe('BrainScheduler (PLAN §6.5 lanes)', () => {
  it('runs at most 2 work turns and keeps 1 interactive slot for P0', async () => {
    const s = new BrainScheduler();
    const g1 = await s.acquire('a', 1);
    const g2 = await s.acquire('b', 3);
    expect([g1.lane, g2.lane]).toEqual(['work', 'work']);
    let third: Grant | null = null;
    void s.acquire('c', 2).then((g) => (third = g));
    await flush();
    expect(third).toBeNull();
    // A P0 player message is answered while 2 seated agents are mid-turn.
    const p0 = await s.acquire('d', 0);
    expect(p0.lane).toBe('interactive');
    expect(s.summary()).toEqual({ inFlight: 3, queued: 1, max: 3 });
    g1.release();
    await flush();
    expect(third).not.toBeNull();
    expect((third as unknown as Grant).agentId).toBe('c');
  });

  it('orders the queue by priority, then age; P0 can borrow a free work slot', async () => {
    const s = new BrainScheduler({ workSlots: 1, interactiveSlots: 1 });
    const busy = await s.acquire('x', 3);
    const i = await s.acquire('y', 0);
    expect(i.lane).toBe('interactive');
    const order: string[] = [];
    const track = (id: string, p: 0 | 1 | 2 | 3 | 4) =>
      s.acquire(id, p).then((g) => order.push(`${id}:${g.lane}`));
    const done = Promise.all([track('p4', 4), track('p3', 3), track('p1', 1), track('p0', 0)]);
    await flush();
    expect(s.estimate('p4')).toMatchObject({ waiting: true, ahead: 3 });
    busy.release();
    await flush();
    expect(order).toEqual(['p0:work']);
    i.release();
    await flush();
    s.grantOf('p0')?.release();
    await flush();
    s.grantOf('p1')?.release();
    await flush();
    s.grantOf('p3')?.release();
    await done;
    expect(order).toEqual(['p0:work', 'p1:work', 'p3:work', 'p4:work']);
  });

  it('gives an agent its existing grant and merges a better priority into its queued request', async () => {
    const s = new BrainScheduler({ workSlots: 1, interactiveSlots: 0 });
    const held = await s.acquire('a', 3);
    expect(await s.acquire('a', 0)).toBe(held);
    const first = s.acquire('b', 4);
    const second = s.acquire('b', 1);
    expect(s.summary().queued).toBe(1);
    held.release();
    const [g1, g2] = await Promise.all([first, second]);
    expect(g1).toBe(g2);
  });

  it('Tired: one work slot; Asleep: nothing until awake; cancel rejects waiters', async () => {
    const s = new BrainScheduler();
    s.setMode('tired');
    const a = await s.acquire('a', 3);
    let b: Grant | null = null;
    void s.acquire('b', 3).then((g) => (b = g));
    await flush();
    expect(b).toBeNull();
    expect((await s.acquire('p', 0)).lane).toBe('interactive');
    s.setMode('asleep');
    a.release();
    await flush();
    expect(b).toBeNull();
    expect(s.estimate('b')).toMatchObject({ asleep: true, waiting: true });
    s.setMode('normal');
    await flush();
    expect(b).not.toBeNull();
    await s.acquire('c', 3);
    const pending = s.acquire('zz', 4);
    expect(s.isWaiting('zz')).toBe(true);
    s.cancel('zz');
    await expect(pending).rejects.toBeInstanceOf(SchedulerCancelled);
  });

  it('release is idempotent', async () => {
    const s = new BrainScheduler({ workSlots: 1, interactiveSlots: 0 });
    const g = await s.acquire('a', 3);
    g.release();
    g.release();
    expect(g.released).toBe(true);
    expect(s.summary().inFlight).toBe(0);
  });
});

describe('UsageGovernor', () => {
  afterEach(() => vi.useRealTimers());

  it('reads utilization from unifiedWindows (fractions) and goes Tired at 0.75', () => {
    const g = new UsageGovernor({ now: () => 0 });
    const modes: string[] = [];
    g.on('change', (s) => void modes.push(s.mode));
    g.onRateLimit({
      status: 'allowed',
      unifiedWindows: {
        five_hour: { utilization: 0.28, resetsAt: 1_900_000_000 },
        seven_day: { utilization: 0.1 },
      },
    });
    expect(g.state).toMatchObject({ mode: 'normal', utilization: 0.28, resetsAt: 1_900_000_000_000 });
    g.onRateLimit({ status: 'allowed', unifiedWindows: { five_hour: { utilization: 0.8 } } });
    expect(g.mode).toBe('tired');
    g.onRateLimit({ status: 'allowed', unifiedWindows: { five_hour: { utilization: 0.3 } } });
    // Live: a warning at the 25% weekly milestone is not Tired; a warning without numbers is.
    g.onRateLimit({
      status: 'allowed_warning',
      rateLimitType: 'seven_day',
      utilization: 0.26,
      unifiedWindows: { five_hour: { utilization: 0.28 }, seven_day: { utilization: 0.26 } },
    });
    expect(g.mode).toBe('normal');
    g.onRateLimit({ status: 'allowed_warning' });
    expect(g.mode).toBe('tired');
    expect(modes).toEqual(['normal', 'tired', 'normal', 'normal', 'tired']);
  });

  it('normalizes the usage poll percent and epoch seconds', () => {
    expect(normalizeUtilization(28)).toBe(0.28);
    expect(normalizeUtilization(0.28)).toBe(0.28);
    expect(normalizeUtilization(-1)).toBeNull();
    expect(normalizeEpoch(1_900_000_000)).toBe(1_900_000_000_000);
    expect(normalizeEpoch(1_900_000_000_000)).toBe(1_900_000_000_000);
    const g = new UsageGovernor();
    g.onUsagePoll({ five_hour: { utilization: 80 }, seven_day: { utilization: 10 } });
    expect(g.state).toMatchObject({ mode: 'tired', utilization: 0.8 });
  });

  it('sleeps on rejected until resetsAt plus the grace, and on auth failures until woken', () => {
    vi.useFakeTimers();
    const T = 1_900_000_000_000;
    vi.setSystemTime(T);
    const g = new UsageGovernor({ graceMs: 60_000 });
    g.onRateLimit({ status: 'rejected', resetsAt: (T + 600_000) / 1000 });
    expect(g.state).toMatchObject({ mode: 'asleep', reason: 'rate_limit', resetsAt: T + 600_000 });
    vi.advanceTimersByTime(600_000 + 59_000);
    expect(g.mode).toBe('asleep');
    vi.advanceTimersByTime(2_000);
    expect(g.mode).toBe('normal');
    g.onAuthFailure();
    expect(g.state).toMatchObject({ mode: 'asleep', reason: 'auth' });
    vi.advanceTimersByTime(3_600_000);
    expect(g.mode).toBe('asleep');
    g.wake();
    expect(g.mode).toBe('normal');
    g.dispose();
  });
});

describe('BrainSupervisor', () => {
  it('restarts with exponential backoff, at most 5 times per 10 min, then offline', () => {
    let t = 0;
    const s = new BrainSupervisor({ now: () => t, maxRestarts: 5, backoff: { base: 1000, max: 8000 } });
    const delays: number[] = [];
    for (let i = 0; i < 5; i++) {
      const v = s.verdict('a', new Error('crash'));
      expect(v.action).toBe('restart');
      if (v.action === 'restart') delays.push(v.delayMs);
      t += 1000;
    }
    expect(delays).toEqual([1000, 2000, 4000, 8000, 8000]);
    expect(s.verdict('a', new Error('crash'))).toMatchObject({ action: 'offline' });
    t += 10 * 60_000;
    expect(s.verdict('a', new Error('crash')).action).toBe('restart');
    s.reset('a');
    expect(s.verdict('a', new Error('crash'))).toMatchObject({ action: 'restart', attempt: 1 });
  });

  it('treats 401s and expired logins as auth problems (Zz, no restart loop)', () => {
    expect(isAuthError(new Error('API Error: 401 {"type":"authentication_error"}'))).toBe(true);
    expect(isAuthError(new Error('OAuth token has expired'))).toBe(true);
    expect(isAuthError(new Error('ECONNRESET'))).toBe(false);
    const s = new BrainSupervisor();
    const calls: string[] = [];
    s.onCrash('a', new Error('401 Unauthorized'), {
      restart: () => calls.push('restart'),
      offline: () => calls.push('offline'),
      auth: () => calls.push('auth'),
    });
    expect(calls).toEqual(['auth']);
  });

  it('schedules the restart', async () => {
    vi.useFakeTimers();
    const s = new BrainSupervisor({ backoff: { base: 500, max: 500 } });
    const restart = vi.fn();
    s.onCrash('a', new Error('x'), { restart, offline: vi.fn(), auth: vi.fn() });
    expect(restart).not.toHaveBeenCalled();
    vi.advanceTimersByTime(500);
    expect(restart).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });
});
