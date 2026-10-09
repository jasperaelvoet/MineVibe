import { execFile } from 'node:child_process';
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

/** Whether this Mac can run nested virtualization in a container (PLAN §8.7). */
export interface NestedVirtualizationSupport {
  supported: boolean;
  /** Why not, in the player's words ("needs an M3 or newer Mac"). */
  reason?: string;
  /** The chip, as `sysctl machdep.cpu.brand_string` names it. */
  chip?: string;
}

/**
 * Apple's Virtualization framework nests only on M3 or newer (`VZGenericPlatformConfiguration
 * .isNestedVirtualizationSupported`, macOS 15+; MineVibe needs 26 anyway). Pure: the chip name in, the verdict out.
 */
export function nestedVirtualizationFor(
  chip: string,
  platform: NodeJS.Platform = process.platform,
): NestedVirtualizationSupport {
  if (platform !== 'darwin') return { supported: false, reason: 'needs a Mac (Apple container)' };
  const m = /Apple M(\d+)/.exec(chip);
  if (!m) return { supported: false, reason: 'needs an Apple silicon Mac with an M3 or newer chip', chip };
  return Number(m[1]) >= 3
    ? { supported: true, chip }
    : {
        supported: false,
        reason: `needs an M3 or newer Mac (this one has an ${chip.replace(/^Apple /, '')})`,
        chip,
      };
}

/** {@link nestedVirtualizationFor} of this Mac's chip (`sysctl -n machdep.cpu.brand_string`). */
export function nestedVirtualizationSupport(): Promise<NestedVirtualizationSupport> {
  return new Promise((resolvePromise) => {
    if (process.platform !== 'darwin') {
      resolvePromise(nestedVirtualizationFor('', process.platform));
      return;
    }
    execFile('/usr/sbin/sysctl', ['-n', 'machdep.cpu.brand_string'], { timeout: 5_000 }, (err, stdout) => {
      resolvePromise(
        err
          ? { supported: false, reason: 'could not tell which chip this Mac has' }
          : nestedVirtualizationFor(stdout.trim()),
      );
    });
  });
}
