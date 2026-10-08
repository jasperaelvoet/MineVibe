import { randomBytes } from 'node:crypto';
import { chmod, mkdir, open, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * Writes `contents` to `path` atomically and durably: a temp file in the same directory is written with
 * `mode`, fsynced, and renamed over the target. Readers see either the old or the new file, never a torn one.
 */
export async function writeFileAtomic(
  path: string,
  contents: string,
  options: { mode?: number; dirMode?: number } = {},
): Promise<void> {
  const mode = options.mode ?? 0o644;
  await mkdir(dirname(path), {
    recursive: true,
    ...(options.dirMode !== undefined ? { mode: options.dirMode } : {}),
  });
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  const handle = await open(tmp, 'wx', mode);
  try {
    await handle.writeFile(contents, 'utf8');
    await handle.chmod(mode); // the umask may have masked bits off at creation
    await handle.sync();
  } catch (err) {
    await handle.close();
    await rm(tmp, { force: true });
    throw err;
  }
  await handle.close();
  try {
    await rename(tmp, path);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
  await chmod(path, mode);
}
