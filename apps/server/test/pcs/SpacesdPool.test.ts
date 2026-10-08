import { describe, expect, it } from 'vitest';
import { DeadlineError, withDeadline } from '../../src/pcs/deadline.js';
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
