import { type MessageOf, type PayloadOf, PROTOCOL_VERSION } from '@minevibe/protocol';
import type { Logger } from 'pino';
import type { BridgeServer, HandlerResult } from '../bridge/BridgeServer.js';
import type { CurrentWorldRecord, CurrentWorldStore } from './currentWorld.js';

export interface WorldLifecycleOptions {
  readonly bridge: BridgeServer;
  readonly store: CurrentWorldStore;
  readonly logger: Logger;
  readonly serverVersion: string;
  /** Offline profile name; a name reported in `hello` takes precedence. */
  readonly playerName: string;
  /**
   * Called once a dead world was closed by the mod and Node moved on to the next one, before the next
   * world's `world.open` is sent (the dev server buries the old save here). Errors are logged, not fatal.
   *
   * **Must be idempotent.** The move to the next world is saved first, with the dead world listed as `unburied`
   * in the same write; the entry is cleared only after this hook succeeds. If Node stops before that (a crash,
   * or the hook threw), the hook runs again for that world when the next WorldLifecycle starts (DEBT N3). On such
   * a retry `next` is the world that followed `dead`, as far as the record still knows it.
   */
  readonly onWorldEnded?: (dead: CurrentWorldRecord, next: CurrentWorldRecord) => void | Promise<void>;
  /**
   * Called after every `world.state{ready}` for the current, living world was recorded (the 1 Hz pushes included):
   * `fresh` is true when this was the first `ready` that world ever had. The runtime opens the crew here.
   */
  readonly onWorldReady?: (world: { worldId: string; gen: number }, info: { fresh: boolean }) => void;
  /** The live parts of `hello.ok` (crew, brains, cards, PCs); the rest comes from the world record. */
  readonly snapshot?: () => Partial<
    Pick<PayloadOf<'hello.ok'>, 'crew' | 'brains' | 'pending' | 'pcs' | 'budget' | 'settings'>
  >;
  /** The crew's fates for the Game Over summary (`world.next.summary.crewFates`) of a dead world. */
  readonly crewFates?: (worldId: string) => PayloadOf<'world.next'>['summary']['crewFates'];
  /**
   * Level seed for every fresh world (`world.open.seed`; dev and E2E only, `MINEVIBE_WORLD_SEED`): repeatable terrain
   * for acceptance runs. Default: none, the mod picks a random seed.
   */
  readonly worldSeed?: string;
}

/**
 * M1 world lifecycle over the bridge (PLAN §7.9): handshake, which world to open, and the hardcore loop
 * (player death -> durable dead mark -> `world.next` -> world closed -> `world.open` of the next world).
 * Later milestones add the crew, PCs and the Game Over summary contents.
 *
 * Node only moves past a dead world when the mod says it closed it (`world.state{closed}`, acknowledged so the
 * mod can re-send it), or when the mod shows that it is already in the allocated next world (`hello{in_world}`,
 * `world.state{loading|ready}` or `player.died` for that world): a lost `closed` can never leave Node on the
 * dead world while the mod plays the next one.
 *
 * World endings are durable: a dead world Node moved past stays listed as `unburied` in the world record until the
 * `onWorldEnded` hook succeeded for it, and the constructor retries the listed ones (see {@link whenRecovered}).
 * The store must be loaded before construction.
 */
export class WorldLifecycle {
  readonly #bridge: BridgeServer;
  readonly #store: CurrentWorldStore;
  readonly #log: Logger;
  readonly #serverVersion: string;
  readonly #onWorldEnded: WorldLifecycleOptions['onWorldEnded'];
  readonly #onWorldReady: WorldLifecycleOptions['onWorldReady'];
  readonly #snapshot: WorldLifecycleOptions['snapshot'];
  readonly #crewFates: WorldLifecycleOptions['crewFates'];
  readonly #worldSeed: string | undefined;
  #playerName: string;
  #lastPhase: string | null = null;
  readonly #unsubscribe: Array<() => void> = [];
  /** World endings run one at a time, in order: retries from the last run first, then new ones. */
  #endings: Promise<void> = Promise.resolve();
  readonly #recovered: Promise<void>;

  constructor(options: WorldLifecycleOptions) {
    this.#bridge = options.bridge;
    this.#store = options.store;
    this.#log = options.logger;
    this.#serverVersion = options.serverVersion;
    this.#playerName = options.playerName;
    this.#onWorldEnded = options.onWorldEnded;
    // Read now, so an unloaded store throws here instead of rejecting `whenRecovered()` unobserved.
    this.#recovered = this.#retryUnburied(this.#store.unburied);
    this.#onWorldReady = options.onWorldReady;
    this.#snapshot = options.snapshot;
    this.#crewFates = options.crewFates;
    this.#worldSeed = options.worldSeed?.trim() || undefined;

    this.#unsubscribe.push(
      this.#bridge.on('hello', (msg) => this.#onHello(msg)),
      this.#bridge.handle('world.state', (msg) => this.#onWorldState(msg)),
      this.#bridge.on('client.stopping', (msg) => {
        this.#log.info({ reason: msg.reason }, 'game client stopping');
      }),
      this.#bridge.handle('player.died', (msg) => this.#onPlayerDied(msg)),
    );
  }

  get playerName(): string {
    return this.#playerName;
  }

  /**
   * Settles once the world endings a previous run left unfinished (`unburied` in the record when this lifecycle
   * started) were retried. Never rejects: a hook that fails again is logged, and its world stays listed for the
   * next start.
   */
  whenRecovered(): Promise<void> {
    return this.#recovered;
  }

  dispose(): void {
    for (const off of this.#unsubscribe.splice(0)) off();
  }

  async #onHello(msg: MessageOf<'hello'>): Promise<void> {
    if (msg.playerName) this.#playerName = msg.playerName;
    this.#log.info({ mod: msg.mod, mc: msg.mc, phase: msg.phase, worldId: msg.worldId }, 'mod hello');
    const modWorld = msg.phase === 'in_world' ? msg.worldId : undefined;
    // Only wait when there is something to adopt, so hello.ok normally goes out at once.
    if (modWorld !== undefined && this.#isAllocatedNext(modWorld)) await this.#adoptNext(modWorld, 'hello');

    const rec = this.#store.current;
    this.#bridge.send('hello.ok', this.#helloOk(rec), msg.id !== undefined ? { re: msg.id } : {});
    this.#resync(rec, modWorld);
  }

  /**
   * Tells the mod where it should be: `world.next` while the current world is dead (the mod shows Game Over,
   * or already did and is waiting for its `closed` to be taken), `world.open` when the mod is not in the
   * current world.
   */
  #resync(rec: CurrentWorldRecord, modWorld: string | undefined): void {
    if (rec.status === 'dead') {
      // Either the mod is still in the dead world (Game Over), or the game restarted on Game Over (crash
      // recovery, PLAN §7.9). Both show Game Over with this summary; the mod's world.state{closed} for the
      // dead world then moves Node to the allocated next world.
      this.#sendWorldNext(rec);
      return;
    }
    if (modWorld !== rec.worldId) {
      if (modWorld !== undefined) {
        this.#log.warn({ modWorld, current: rec.worldId }, 'mod is in a stale world; reopening');
      }
      this.#sendWorldOpen(rec);
    }
  }

  async #onWorldState(msg: MessageOf<'world.state'>): Promise<HandlerResult> {
    if (msg.phase !== this.#lastPhase) {
      this.#log.info({ worldId: msg.worldId, phase: msg.phase }, 'world state');
      this.#lastPhase = msg.phase;
    }
    if (msg.phase === 'loading' || msg.phase === 'ready') {
      if (this.#isAllocatedNext(msg.worldId)) await this.#adoptNext(msg.worldId, `world.state{${msg.phase}}`);
      if (msg.phase === 'ready') {
        // True only for the first `ready` the world ever had.
        const fresh = await this.#store.markCreated(msg.worldId);
        const rec = this.#store.current;
        if (this.#onWorldReady && rec.worldId === msg.worldId && rec.status === 'alive') {
          try {
            this.#onWorldReady({ worldId: rec.worldId, gen: rec.gen }, { fresh });
          } catch (err) {
            this.#log.error({ err, worldId: rec.worldId }, 'world-ready hook failed');
          }
        }
      }
      return {};
    }
    if (msg.phase !== 'closed') return {};

    const before = this.#store.current;
    const next = await this.#store.advanceFrom(msg.worldId);
    if (next) {
      await this.#worldEnded(before, next);
      this.#log.info({ worldId: next.worldId, gen: next.gen }, 'opening next world');
      // The `ok` reply goes out first (a microtask), then the next world.
      setImmediate(() => this.#sendWorldOpen(next));
      return {};
    }
    // Not an advance: a repeat after Node already moved on, or a world Node never saw die. The mod has no world
    // now, so tell it where to go, exactly as after hello{boot}.
    const rec = this.#store.current;
    this.#log.warn(
      { closed: msg.worldId, current: rec.worldId, status: rec.status },
      'world.state{closed} for a world that is not the current dead world; resyncing the mod',
    );
    setImmediate(() => this.#resync(rec, undefined));
    return { ignored: true };
  }

  async #onPlayerDied(msg: MessageOf<'player.died'>): Promise<Record<string, unknown>> {
    const death = {
      cause: msg.cause,
      ...(msg.killer !== undefined ? { killer: msg.killer } : {}),
      day: msg.day,
      ticksAlive: msg.ticksAlive,
    };
    let rec = await this.#store.markDead(msg.worldId, death);
    if (rec === null && (await this.#adoptNext(msg.worldId, 'player.died'))) {
      rec = await this.#store.markDead(msg.worldId, death);
    }
    if (rec === null) {
      // A re-send for a world that is no longer current: acknowledge so the mod stops retrying.
      this.#log.warn({ worldId: msg.worldId }, 'player.died for a world that is not current; ignored');
      return { ignored: true };
    }
    this.#log.info({ worldId: rec.worldId, cause: msg.cause, day: msg.day, next: rec.next }, 'player died');
    // Ack first (the handler's reply), then announce the next world.
    const dead = rec;
    setImmediate(() => this.#sendWorldNext(dead));
    return {};
  }

  /** `worldId` is the next world Node allocated after the current, dead world. */
  #isAllocatedNext(worldId: string): boolean {
    const rec = this.#store.current;
    return rec.status === 'dead' && rec.next?.worldId === worldId;
  }

  /**
   * The mod is in (or loading, or dying in) `worldId`, which is the next world Node allocated after the current
   * dead world: its `world.state{closed}` never arrived. Advance now, as if it had. Returns whether it advanced.
   */
  async #adoptNext(worldId: string, via: string): Promise<boolean> {
    if (!this.#isAllocatedNext(worldId)) return false;
    const rec = this.#store.current;
    const next = await this.#store.advanceFrom(rec.worldId);
    if (!next) return false;
    this.#log.warn(
      { dead: rec.worldId, worldId, via },
      'mod is already in the next world; advancing (its world.state{closed} was lost)',
    );
    await this.#worldEnded(rec, next);
    return true;
  }

  /**
   * Deals with the end of `dead` (the hook), then clears it from the record's `unburied` list. Endings run one at a
   * time. A failing hook leaves the world listed, so the next start tries again.
   */
  #worldEnded(dead: CurrentWorldRecord, next: CurrentWorldRecord): Promise<void> {
    const run = this.#endings.then(async () => {
      try {
        await this.#onWorldEnded?.(dead, next);
      } catch (err) {
        this.#log.error(
          { err, worldId: dead.worldId },
          'world-ended hook failed; it runs again at the next start',
        );
        return;
      }
      try {
        await this.#store.markBuried(dead.worldId);
      } catch (err) {
        this.#log.error({ err, worldId: dead.worldId }, 'could not record that a dead world was dealt with');
      }
    });
    this.#endings = run;
    return run;
  }

  /**
   * Retries the world endings a previous run did not finish (it stopped between the advance and the hook). They
   * are all queued at once, oldest first, so they run before any ending of this run.
   */
  async #retryUnburied(unburied: readonly CurrentWorldRecord[]): Promise<void> {
    const retries = unburied.map((dead) => {
      this.#log.warn(
        { worldId: dead.worldId, next: dead.next?.worldId },
        'finishing the end of a dead world that the last run left unfinished',
      );
      return this.#worldEnded(dead, this.#successorOf(dead));
    });
    await Promise.all(retries);
  }

  /** The world that followed `dead`: the current one when it still is, else what the record knows of it. */
  #successorOf(dead: CurrentWorldRecord): CurrentWorldRecord {
    const rec = this.#store.current;
    if (!dead.next || rec.worldId === dead.next.worldId) return rec;
    // Node moved past that one too, so it died as well (only dead worlds are advanced past).
    return { v: 1, worldId: dead.next.worldId, gen: dead.next.gen, status: 'dead', created: true };
  }

  #helloOk(rec: CurrentWorldRecord): PayloadOf<'hello.ok'> {
    let live: ReturnType<NonNullable<WorldLifecycleOptions['snapshot']>> = {};
    try {
      live = this.#snapshot?.() ?? {};
    } catch (err) {
      this.#log.warn({ err }, 'hello.ok snapshot failed');
    }
    return {
      server: { version: this.#serverVersion, protocol: PROTOCOL_VERSION },
      world: { id: rec.worldId, gen: rec.gen, fresh: !rec.created },
      player: { name: this.#playerName },
      settings: {},
      pcs: [],
      budget: null,
      crew: [],
      brains: { inFlight: 0, queued: 0, max: 2, mode: 'normal', utilization: null, resetsAt: null },
      pending: [],
      ...live,
    };
  }

  #sendWorldOpen(rec: CurrentWorldRecord): void {
    const seed = this.#worldSeed;
    this.#bridge.send('world.open', {
      worldId: rec.worldId,
      gen: rec.gen,
      fresh: !rec.created,
      hardcore: true,
      difficulty: 'hard',
      ...(seed && !rec.created ? { seed } : {}),
    });
  }

  #fatesOf(worldId: string): PayloadOf<'world.next'>['summary']['crewFates'] {
    try {
      return this.#crewFates?.(worldId) ?? [];
    } catch (err) {
      this.#log.warn({ err, worldId }, 'crew fates failed');
      return [];
    }
  }

  #sendWorldNext(rec: CurrentWorldRecord): void {
    if (rec.status !== 'dead' || !rec.next || !rec.death) return;
    this.#bridge.send('world.next', {
      worldId: rec.next.worldId,
      gen: rec.next.gen,
      summary: {
        worldId: rec.worldId,
        gen: rec.gen,
        day: rec.death.day,
        cause: rec.death.cause,
        ...(rec.death.killer !== undefined ? { killer: rec.death.killer } : {}),
        crewFates: this.#fatesOf(rec.worldId),
        vaultCommits: [],
      },
    });
  }
}
