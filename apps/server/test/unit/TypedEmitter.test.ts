import { describe, expect, it } from 'vitest';
import { TypedEmitter } from '../../src/util/TypedEmitter.js';

type Events = { ping: [n: number]; pair: [a: string, b: boolean] };

class Emitter extends TypedEmitter<Events> {
  errors: Array<[string, unknown]> = [];
  fire<K extends keyof Events>(event: K, ...args: Events[K]): boolean {
    return this.emit(event, ...args);
  }
  protected override onListenerError(event: string, error: unknown): void {
    this.errors.push([event, error]);
  }
}

describe('TypedEmitter', () => {
  it('delivers typed arguments in subscription order', () => {
    const e = new Emitter();
    const seen: string[] = [];
    e.on('pair', (a, b) => {
      seen.push(`1:${a}:${b}`);
    });
    e.on('pair', (a) => {
      seen.push(`2:${a}`);
    });
    expect(e.fire('pair', 'x', true)).toBe(true);
    expect(seen).toEqual(['1:x:true', '2:x']);
  });

  it('unsubscribes and reports listener counts', () => {
    const e = new Emitter();
    const off = e.on('ping', () => {});
    expect(e.listenerCount('ping')).toBe(1);
    off();
    expect(e.listenerCount('ping')).toBe(0);
    expect(e.fire('ping', 1)).toBe(false);
  });

  it('once fires a single time', () => {
    const e = new Emitter();
    let n = 0;
    e.once('ping', (v) => {
      n += v;
    });
    e.fire('ping', 2);
    e.fire('ping', 3);
    expect(n).toBe(2);
  });

  it('isolates throwing and rejecting listeners', async () => {
    const e = new Emitter();
    let reached = false;
    e.on('ping', () => {
      throw new Error('sync boom');
    });
    e.on('ping', async () => {
      throw new Error('async boom');
    });
    e.on('ping', () => {
      reached = true;
    });
    e.fire('ping', 1);
    await Promise.resolve();
    await Promise.resolve();
    expect(reached).toBe(true);
    expect(e.errors.map(([ev, err]) => `${ev}:${(err as Error).message}`)).toEqual([
      'ping:sync boom',
      'ping:async boom',
    ]);
  });

  it('a listener removed during emit still runs for that emit only', () => {
    const e = new Emitter();
    const calls: string[] = [];
    const offB = e.on('ping', () => {
      calls.push('b');
    });
    e.on('ping', () => {
      calls.push('c');
      offB();
    });
    e.fire('ping', 1);
    e.fire('ping', 1);
    expect(calls).toEqual(['b', 'c', 'c']);
  });
});
