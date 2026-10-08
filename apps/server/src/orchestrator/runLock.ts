import { mkdir, open, readFile, rm } from 'node:fs/promises';
import { dirname } from 'node:path';

/** Another MineVibe instance holds `run/lock`. */
export class AlreadyRunningError extends Error {
  readonly pid: number;

  constructor(pid: number) {
    super(`MineVibe is already running (pid ${pid})`);
    this.name = 'AlreadyRunningError';
    this.pid = pid;
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export interface RunLock {
  release(): Promise<void>;
}

/**
 * Single-instance lock (PLAN §9.2): `run/lock` holds the owner's pid, created with O_EXCL. A lock whose pid is
 * dead is stale and taken over.
 */
export async function acquireRunLock(path: string, pid: number = process.pid): Promise<RunLock> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(path, 'wx', 0o600);
      await handle.writeFile(`${pid}\n`);
      await handle.close();
      return {
        async release() {
          try {
            if (Number((await readFile(path, 'utf8')).trim()) === pid) await rm(path, { force: true });
          } catch {
            // already gone
          }
        },
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const owner = Number((await readFile(path, 'utf8').catch(() => '')).trim());
      if (Number.isInteger(owner) && owner > 0 && owner !== pid && alive(owner))
        throw new AlreadyRunningError(owner);
      await rm(path, { force: true });
    }
  }
  throw new Error(`could not take ${path}`);
}
