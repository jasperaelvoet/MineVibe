import { describe, expect, it } from 'vitest';
import { DeadlineError, settleWithin, withDeadline } from '../../src/pcs/deadline.js';
import { type CuaModule, isTransportError, SpacesdPool } from '../../src/pcs/SpacesdPool.js';

function pool(client: Record<string, unknown>, opts: { connectHangs?: boolean } = {}) {
  let connects = 0;
  const mod: CuaModule = {
    embedded: () => ({
      spacesd: async () => {
        connects++;
        if (opts.connectHangs) return new Promise(() => {});
        return client as never;
      },
    }),
    ImageFormat: { Png: 0, Jpeg: 1, Webp: 2 },
  };
  const p = new SpacesdPool({
    cachesDir: '/nonexistent',
    loader: async () => mod,
    connectTimeoutMs: 50,
    healthTimeoutMs: 50,
    callTimeoutMs: 50,
  });
  p.register('pc', { url: 'http://127.0.0.1:1', token: 't'.repeat(48) });
  return { p, connects: () => connects };
}

describe('H3: spacesd deadlines', () => {
  it('withDeadline rejects at the deadline and aborts the signal, even if the callee ignores it', async () => {
    let seen: AbortSignal | null = null;
    const t0 = Date.now();
    const err = await withDeadline(30, 'thing', (signal) => {
      seen = signal;
      return new Promise(() => {});
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DeadlineError);
    expect(Date.now() - t0).toBeLessThan(1000);
    expect((seen as AbortSignal | null)?.aborted).toBe(true);
    expect(isTransportError(err)).toBe(true);
    await expect(withDeadline(1000, 'fast', async () => 7)).resolves.toBe(7);
  });

  it('a hung health call rejects within the health timeout (and reconnects once)', async () => {
    const { p, connects } = pool({ health: () => new Promise(() => {}) });
    const t0 = Date.now();
    await expect(p.health('pc')).rejects.toThrow(/timed out/);
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(connects()).toBe(2);
  });

  it('a hung connect rejects within the connect timeout', async () => {
    const { p } = pool({}, { connectHangs: true });
    await expect(p.call('pc', async () => 1, { retry: false })).rejects.toThrow(/spacesd connect timed out/);
  });

  it('call passes the deadline signal to the callee', async () => {
    const { p } = pool({
      displays: async (o: { signal: AbortSignal }) => (o.signal instanceof AbortSignal ? 'ok' : 'no'),
    });
    await expect(p.call('pc', (c, signal) => c.displays({ signal }))).resolves.toBe('ok');
  });
});

describe('N5/N6: late results are released, waits are bounded', () => {
  it('withDeadline hands a value that arrives after the deadline to onLate (and only then)', async () => {
    const late: number[] = [];
    let resolve: (n: number) => void = () => {};
    await expect(
      withDeadline(
        20,
        'slow',
        () =>
          new Promise<number>((r) => {
            resolve = r;
          }),
        { onLate: (v) => late.push(v) },
      ),
    ).rejects.toBeInstanceOf(DeadlineError);
    resolve(7);
    await new Promise((r) => setImmediate(r));
    expect(late).toEqual([7]);
    await withDeadline(1000, 'fast', async () => 1, { onLate: (v) => late.push(v) });
    expect(late).toEqual([7]);
  });

  it('a spacesd connect that completes after its deadline is released, not leaked', async () => {
    let destroyed = 0;
    let resolve: (c: unknown) => void = () => {};
    const mod: CuaModule = {
      embedded: () => ({
        spacesd: () =>
          new Promise((r) => {
            resolve = r as (c: unknown) => void;
          }),
      }),
      ImageFormat: { Png: 0, Jpeg: 1, Webp: 2 },
    };
    const p = new SpacesdPool({ cachesDir: '/nonexistent', loader: async () => mod, connectTimeoutMs: 20 });
    p.register('pc', { url: 'http://127.0.0.1:1', token: 't'.repeat(48) });
    await expect(p.client('pc')).rejects.toThrow(/spacesd connect timed out/);
    resolve({ uniffiDestroy: () => destroyed++ });
    await new Promise((r) => setImmediate(r));
    expect(destroyed).toBe(1);
    expect(p.lateConnects).toBe(1);
  });

  it('settleWithin never waits past its bound and never rejects', async () => {
    const t0 = Date.now();
    expect(await settleWithin(new Promise(() => {}), 30)).toBe('timeout');
    expect(await settleWithin(Promise.reject(new Error('x')), 1000)).toBe('settled');
    expect(Date.now() - t0).toBeLessThan(1000);
  });
});
