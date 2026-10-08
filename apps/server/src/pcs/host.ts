import { statfs } from 'node:fs/promises';
import { createServer } from 'node:net';
import { availableParallelism, freemem, totalmem } from 'node:os';
import { dirname, resolve } from 'node:path';
import type { HostFacts } from './Budget.js';

/**
 * Free bytes on the volume holding `path`. A path that does not exist yet (the app root before the
 * first engine start) is measured at its nearest existing ancestor (L8), never reported as 0 free.
 */
export async function freeDiskBytes(path: string): Promise<number> {
  let cur = resolve(path);
  for (;;) {
    try {
      const s = await statfs(cur);
      return Number(s.bavail) * Number(s.bsize);
    } catch {
      const parent = dirname(cur);
      if (parent === cur) return 0;
      cur = parent;
    }
  }
}

/** Host CPU, RAM and free disk on the volume holding `diskPath` (the container app root). */
export async function readHostFacts(diskPath: string): Promise<HostFacts> {
  const diskFreeBytes = await freeDiskBytes(diskPath);
  return {
    cpus: availableParallelism(),
    memBytes: totalmem(),
    diskFreeBytes,
    liveFreeMemBytes: freemem(),
  };
}

/** True when nothing listens on 127.0.0.1:`port` (we can bind it exclusively). */
export function isLoopbackPortFree(port: number): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const srv = createServer();
    srv.unref();
    srv.once('error', () => resolvePromise(false));
    srv.listen({ host: '127.0.0.1', port, exclusive: true }, () => srv.close(() => resolvePromise(true)));
  });
}

/** A free TCP port on 127.0.0.1 (bind to :0, read, close). `preferred` is tried first. */
export function freeLoopbackPort(preferred?: number): Promise<number> {
  const tryPort = (port: number) =>
    new Promise<number>((resolve, reject) => {
      const srv = createServer();
      srv.unref();
      srv.once('error', reject);
      srv.listen({ host: '127.0.0.1', port, exclusive: true }, () => {
        const addr = srv.address();
        const p = typeof addr === 'object' && addr ? addr.port : 0;
        srv.close(() => (p ? resolve(p) : reject(new Error('no port'))));
      });
    });
  if (preferred && preferred >= 1024) return tryPort(preferred).catch(() => tryPort(0));
  return tryPort(0);
}
