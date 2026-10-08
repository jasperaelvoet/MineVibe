import { statfs } from 'node:fs/promises';
import { createServer } from 'node:net';
import { availableParallelism, freemem, totalmem } from 'node:os';
import type { HostFacts } from './Budget.js';

/** Host CPU, RAM and free disk on the volume holding `diskPath` (the container app root). */
export async function readHostFacts(diskPath: string): Promise<HostFacts> {
  let diskFreeBytes = 0;
  try {
    const s = await statfs(diskPath);
    diskFreeBytes = Number(s.bavail) * Number(s.bsize);
  } catch {
    diskFreeBytes = 0;
  }
  return {
    cpus: availableParallelism(),
    memBytes: totalmem(),
    diskFreeBytes,
    liveFreeMemBytes: freemem(),
  };
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
