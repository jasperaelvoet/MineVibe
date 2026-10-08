import { lstat, mkdir, readdir, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { WorldId } from '@minevibe/protocol';
import { writeFileAtomic } from '../util/atomicFile.js';

/** Folder inside `saves/` that holds the saves of dead worlds (PLAN §7.9). */
export const GRAVEYARD_DIRNAME = '_graveyard';

/** How many dead saves the graveyard keeps; older ones are deleted. */
export const GRAVEYARD_KEEP = 5;

/** Written into every buried save so the graveyard can be pruned oldest-first. */
export const BURIAL_FILENAME = 'minevibe-buried.json';

export interface BuryResult {
  /** Where the save went, or null when `saves/<worldId>` did not exist. */
  readonly movedTo: string | null;
  /** Graveyard entries deleted to stay within the limit. */
  readonly pruned: readonly string[];
}

export interface BuryOptions {
  readonly keep?: number;
  readonly now?: Date;
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

/** When an entry was buried: its burial file, else the folder's mtime. */
async function buriedAt(entryPath: string): Promise<number> {
  try {
    const raw = JSON.parse(await readFile(join(entryPath, BURIAL_FILENAME), 'utf8')) as {
      buriedAt?: unknown;
    };
    if (typeof raw.buriedAt === 'string') {
      const ms = Date.parse(raw.buriedAt);
      if (Number.isFinite(ms)) return ms;
    }
  } catch {
    // no or unreadable burial file: fall back to the folder's mtime
  }
  return (await lstat(entryPath)).mtimeMs;
}

/**
 * Moves the save of a dead world, `<savesDir>/<worldId>`, into `<savesDir>/_graveyard/` and deletes the
 * oldest buried saves beyond `keep` (default 5). Call it only after the mod reported the world `closed`,
 * i.e. after the integrated server stopped and released the save.
 *
 * `worldId` must be a safe slug (the protocol's WorldId), so it can never escape `savesDir`.
 */
export async function buryWorldSave(
  savesDir: string,
  worldId: string,
  options: BuryOptions = {},
): Promise<BuryResult> {
  const id = WorldId.parse(worldId);
  const keep = Math.max(0, options.keep ?? GRAVEYARD_KEEP);
  const now = options.now ?? new Date();
  const source = join(savesDir, id);
  const graveyard = join(savesDir, GRAVEYARD_DIRNAME);

  let movedTo: string | null = null;
  if (await exists(source)) {
    await mkdir(graveyard, { recursive: true });
    let target = join(graveyard, id);
    if (await exists(target)) {
      // A world id is never reused, but a hand-made folder could collide: keep both.
      target = join(graveyard, `${id}-${now.getTime()}`);
    }
    await rename(source, target);
    await writeFileAtomic(
      join(target, BURIAL_FILENAME),
      `${JSON.stringify({ worldId: id, buriedAt: now.toISOString() }, null, 2)}\n`,
    );
    movedTo = target;
  }

  const pruned: string[] = [];
  if (await exists(graveyard)) {
    const entries = await readdir(graveyard, { withFileTypes: true });
    const dirs = await Promise.all(
      entries
        .filter((e) => e.isDirectory())
        .map(async (e) => {
          const path = join(graveyard, e.name);
          return { path, at: await buriedAt(path) };
        }),
    );
    dirs.sort((a, b) => b.at - a.at); // newest first
    for (const old of dirs.slice(keep)) {
      await rm(old.path, { recursive: true, force: true });
      pruned.push(old.path);
    }
  }
  return { movedTo, pruned };
}
