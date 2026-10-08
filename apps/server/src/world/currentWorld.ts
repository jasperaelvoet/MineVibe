import { readFile } from 'node:fs/promises';
import { WorldId } from '@minevibe/protocol';
import { z } from 'zod';
import { writeFileAtomic } from '../util/atomicFile.js';

/** One world as `state/current-world.json` records it (PLAN §7.9). */
export const WorldRecord = z.object({
  v: z.literal(1),
  worldId: WorldId,
  gen: z.number().int().min(1),
  status: z.enum(['alive', 'dead']),
  /** The mod reported the world `ready` at least once (so it exists on disk). */
  created: z.boolean(),
  death: z
    .object({
      cause: z.string(),
      killer: z.string().optional(),
      day: z.number().int().min(1),
      ticksAlive: z.number().int().min(0),
      at: z.string(),
    })
    .optional(),
  /** Allocated before anything else happens on death. */
  next: z.object({ worldId: WorldId, gen: z.number().int().min(1) }).optional(),
});
export type WorldRecord = z.infer<typeof WorldRecord>;

/** How many unfinished world endings the record keeps (oldest dropped first). */
export const UNBURIED_KEEP = 16;

/** `state/current-world.json`, owned by Node (PLAN §7.9). */
export const CurrentWorldRecord = WorldRecord.extend({
  /**
   * Dead worlds Node moved past whose end has not been dealt with yet: the world-ended hook (which buries the save)
   * has not completed. Written in the same atomic save as the move to the next world, so a crash in between never
   * forgets one; retried at the next start (DEBT N3). Absent when empty.
   */
  unburied: z.array(WorldRecord).optional(),
});
export type CurrentWorldRecord = z.infer<typeof CurrentWorldRecord>;

export type DeathInfo = Omit<NonNullable<CurrentWorldRecord['death']>, 'at'>;

export function worldIdForGen(gen: number): string {
  return `world-${gen}`;
}

/**
 * Durable record of which world is current and whether it died. Every change is written atomically
 * before it is acted on, so a crash between death and the next world never loses the transition.
 */
export class CurrentWorldStore {
  readonly #path: string;
  #record: CurrentWorldRecord | null = null;
  #chain: Promise<void> = Promise.resolve();

  constructor(path: string) {
    this.#path = path;
  }

  get path(): string {
    return this.#path;
  }

  /** The loaded record; call {@link load} first. */
  get current(): CurrentWorldRecord {
    if (!this.#record) throw new Error('CurrentWorldStore: load() first');
    return this.#record;
  }

  /** Dead worlds whose end has not been dealt with yet (`unburied` of the record), oldest first. */
  get unburied(): readonly WorldRecord[] {
    return this.current.unburied ?? [];
  }

  /** Loads the record, creating World #1 when none exists. */
  load(): Promise<CurrentWorldRecord> {
    return this.#exclusive(async () => {
      try {
        this.#record = CurrentWorldRecord.parse(JSON.parse(await readFile(this.#path, 'utf8')));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        await this.#save({ v: 1, worldId: worldIdForGen(1), gen: 1, status: 'alive', created: false });
      }
      return this.current;
    });
  }

  /** Records that the mod has the world on disk. Returns whether anything changed. */
  markCreated(worldId: string): Promise<boolean> {
    return this.#exclusive(async () => {
      const rec = this.current;
      if (rec.worldId !== worldId || rec.created) return false;
      await this.#save({ ...rec, created: true });
      return true;
    });
  }

  /**
   * Marks `worldId` dead and allocates the next world, durably. Idempotent: repeating it for the same
   * world returns the already-allocated next world. Returns null if `worldId` is not the current world.
   */
  markDead(worldId: string, death: DeathInfo, now = new Date()): Promise<CurrentWorldRecord | null> {
    return this.#exclusive(async () => {
      const rec = this.current;
      if (rec.worldId !== worldId) return null;
      if (rec.status === 'dead') return rec;
      const gen = rec.gen + 1;
      await this.#save({
        ...rec,
        status: 'dead',
        death: { ...death, at: now.toISOString() },
        next: { worldId: worldIdForGen(gen), gen },
      });
      return this.current;
    });
  }

  /**
   * Moves from the dead world `deadWorldId` to its allocated successor, listing the dead world as `unburied` in the
   * same write ({@link markBuried} clears it once its end was dealt with). Returns the new record, or null when
   * `deadWorldId` is not the current dead world (already advanced, or still alive).
   */
  advanceFrom(deadWorldId: string): Promise<CurrentWorldRecord | null> {
    return this.#exclusive(async () => {
      const { unburied = [], ...rec } = this.current;
      if (rec.worldId !== deadWorldId || rec.status !== 'dead' || !rec.next) return null;
      await this.#save({
        v: 1,
        worldId: rec.next.worldId,
        gen: rec.next.gen,
        status: 'alive',
        created: false,
        unburied: [...unburied, rec].slice(-UNBURIED_KEEP),
      });
      return this.current;
    });
  }

  /** The end of the dead world `worldId` was dealt with: drops it from `unburied`. Returns whether it was listed. */
  markBuried(worldId: string): Promise<boolean> {
    return this.#exclusive(async () => {
      const { unburied = [], ...rec } = this.current;
      const left = unburied.filter((w) => w.worldId !== worldId);
      if (left.length === unburied.length) return false;
      await this.#save(left.length > 0 ? { ...rec, unburied: left } : rec);
      return true;
    });
  }

  /** Runs store operations one at a time, in call order. */
  #exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#chain.then(fn);
    this.#chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async #save(record: CurrentWorldRecord): Promise<void> {
    const valid = CurrentWorldRecord.parse(record);
    await writeFileAtomic(this.#path, `${JSON.stringify(valid, null, 2)}\n`, { mode: 0o600, dirMode: 0o700 });
    this.#record = valid;
  }
}
