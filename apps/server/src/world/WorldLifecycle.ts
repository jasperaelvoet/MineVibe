import { type MessageOf, type PayloadOf, PROTOCOL_VERSION } from '@minevibe/protocol';
import type { Logger } from 'pino';
import type { BridgeServer } from '../bridge/BridgeServer.js';
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
   */
  readonly onWorldEnded?: (dead: CurrentWorldRecord, next: CurrentWorldRecord) => void | Promise<void>;
}

/**
 * M1 world lifecycle over the bridge (PLAN §7.9): handshake, which world to open, and the hardcore loop
 * (player death -> durable dead mark -> `world.next` -> world closed -> `world.open` of the next world).
 * Later milestones add the crew, PCs and the Game Over summary contents.
 */
export class WorldLifecycle {
  readonly #bridge: BridgeServer;
  readonly #store: CurrentWorldStore;
  readonly #log: Logger;
  readonly #serverVersion: string;
  readonly #onWorldEnded: WorldLifecycleOptions['onWorldEnded'];
  #playerName: string;
  #lastPhase: string | null = null;
  readonly #unsubscribe: Array<() => void> = [];

  constructor(options: WorldLifecycleOptions) {
    this.#bridge = options.bridge;
    this.#store = options.store;
    this.#log = options.logger;
    this.#serverVersion = options.serverVersion;
    this.#playerName = options.playerName;
    this.#onWorldEnded = options.onWorldEnded;

    this.#unsubscribe.push(
      this.#bridge.on('hello', (msg) => this.#onHello(msg)),
      this.#bridge.on('world.state', (msg) => this.#onWorldState(msg)),
      this.#bridge.on('client.stopping', (msg) => {
        this.#log.info({ reason: msg.reason }, 'game client stopping');
      }),
      this.#bridge.handle('player.died', (msg) => this.#onPlayerDied(msg)),
    );
  }

  get playerName(): string {
    return this.#playerName;
  }

  dispose(): void {
    for (const off of this.#unsubscribe.splice(0)) off();
  }

  #onHello(msg: MessageOf<'hello'>): void {
    if (msg.playerName) this.#playerName = msg.playerName;
    this.#log.info({ mod: msg.mod, mc: msg.mc, phase: msg.phase, worldId: msg.worldId }, 'mod hello');

    const rec = this.#store.current;
    this.#bridge.send('hello.ok', this.#helloOk(rec), msg.id !== undefined ? { re: msg.id } : {});

    if (rec.status === 'dead') {
      // Either the mod is still in the dead world (Game Over), or the game restarted on Game Over (crash
      // recovery, PLAN §7.9). Both show Game Over with this summary; the mod's world.state{closed} for the
      // dead world then moves Node to the allocated next world.
      this.#sendWorldNext(rec);
      return;
    }
    if (msg.phase === 'boot' || msg.worldId !== rec.worldId) {
      if (msg.phase === 'in_world') {
        this.#log.warn({ modWorld: msg.worldId, current: rec.worldId }, 'mod is in a stale world; reopening');
      }
      this.#sendWorldOpen(rec);
    }
  }

  async #onWorldState(msg: MessageOf<'world.state'>): Promise<void> {
    if (msg.phase !== this.#lastPhase) {
      this.#log.info({ worldId: msg.worldId, phase: msg.phase }, 'world state');
      this.#lastPhase = msg.phase;
    }
    if (msg.phase === 'ready') {
      await this.#store.markCreated(msg.worldId);
    } else if (msg.phase === 'closed') {
      const before = this.#store.current;
      const next = await this.#store.advanceFrom(msg.worldId);
      if (next) {
        if (this.#onWorldEnded) {
          try {
            await this.#onWorldEnded(before, next);
          } catch (err) {
            this.#log.error({ err, worldId: before.worldId }, 'world-ended hook failed');
          }
        }
        this.#log.info({ worldId: next.worldId, gen: next.gen }, 'opening next world');
        this.#sendWorldOpen(next);
      }
    }
  }

  async #onPlayerDied(msg: MessageOf<'player.died'>): Promise<Record<string, unknown>> {
    const rec = await this.#store.markDead(msg.worldId, {
      cause: msg.cause,
      ...(msg.killer !== undefined ? { killer: msg.killer } : {}),
      day: msg.day,
      ticksAlive: msg.ticksAlive,
    });
    if (rec === null) {
      // A re-send for a world that is no longer current: acknowledge so the mod stops retrying.
      this.#log.warn({ worldId: msg.worldId }, 'player.died for a world that is not current; ignored');
      return { ignored: true };
    }
    this.#log.info({ worldId: rec.worldId, cause: msg.cause, day: msg.day, next: rec.next }, 'player died');
    // Ack first (the handler's reply), then announce the next world.
    setImmediate(() => this.#sendWorldNext(rec));
    return {};
  }

  #helloOk(rec: CurrentWorldRecord): PayloadOf<'hello.ok'> {
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
    };
  }

  #sendWorldOpen(rec: CurrentWorldRecord): void {
    this.#bridge.send('world.open', {
      worldId: rec.worldId,
      gen: rec.gen,
      fresh: !rec.created,
      hardcore: true,
      difficulty: 'hard',
    });
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
        crewFates: [],
        vaultCommits: [],
      },
    });
  }
}
