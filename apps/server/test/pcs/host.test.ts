import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { freeDiskBytes, isLoopbackPortFree, readHostFacts } from '../../src/pcs/host.js';

describe('host facts', () => {
  it('L8: measures free disk at the nearest existing ancestor of a path that does not exist yet', async () => {
    const missing = join(tmpdir(), `mv-not-there-${process.pid}`, 'container', 'app-root');
    const free = await freeDiskBytes(missing);
    expect(free).toBeGreaterThan(0);
    expect((await readHostFacts(missing)).diskFreeBytes).toBeGreaterThan(0);
  });

  it('tells whether a loopback port is taken', async () => {
    const srv = createServer();
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const port = (srv.address() as { port: number }).port;
    expect(await isLoopbackPortFree(port)).toBe(false);
    await new Promise<void>((r) => srv.close(() => r()));
    expect(await isLoopbackPortFree(port)).toBe(true);
  });
});
