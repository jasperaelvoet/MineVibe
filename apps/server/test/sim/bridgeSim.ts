/**
 * bridgeSim (PLAN §4 `test/sim/bridgeSim.ts`, §13.4): a fake mod for brainless integration tests. It connects to a
 * real BridgeServer like BridgeClient does, follows the world loop when asked (hello → world.open → world.state), and
 * answers Node's body requests the way the mod does (`agent.spawn`, `skill.run`, `obs.query`, `agent.mode`,
 * `agent.seat` / `agent.unseat`, `skill.cancel`, `agent.despawn`), with every result ending in the mod's status
 * `footer`. Everything Node sends is checked against the protocol and recorded.
 */

import { type BlockPos, parseMessage } from '@minevibe/protocol';
import { ModClient, type Received } from '../helpers/modClient.js';

/** The footer the sim's bodies report (protocol §7.3). */
export const SIM_FOOTER = 'HP 20/20 food 20 | day 1 06:00 | 0 64 0 overworld | idle (follow)';

export type SimSkillOutcome =
  | { readonly status: 'done'; readonly result?: Record<string, unknown> }
  | { readonly status: 'failed'; readonly code: string; readonly msg: string }
  | { readonly status: 'running' };

export interface SimOffice {
  readonly origin: BlockPos;
  readonly slots: readonly { kind: string; pos: BlockPos; pcId?: string }[];
}

let simSeq = 0;

export class BridgeSim {
  readonly mod: ModClient;
  /** Every request Node sent, in order (the sim answered each). */
  readonly requests: Received[] = [];
  /** Every message Node sent (requests, pushes, replies), in order. */
  readonly all: Received[] = [];
  /** How `skill.run` ends (default: done at once with an empty result). */
  skillHandler: (msg: Received) => SimSkillOutcome = () => ({ status: 'done' });
  /** `obs.query` answers by query name (default `{}`); the footer is added. */
  readonly observations = new Map<string, Record<string, unknown>>();
  /** `agent.seat` answers: null = `running` (end it with {@link endJob}), or an error code. */
  seatError: string | null = null;
  #replyWaiters: Array<{ id: string; resolve: (m: Received) => void }> = [];

  private constructor(mod: ModClient) {
    this.mod = mod;
    mod.ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      const msg = JSON.parse(String(data)) as Received;
      // Node must only send valid protocol messages.
      parseMessage(msg);
      this.all.push(msg);
      if ((msg.t === 'ok' || msg.t === 'err') && typeof msg.re === 'string') {
        const w = this.#replyWaiters.find((x) => x.id === msg.re);
        if (w) {
          this.#replyWaiters.splice(this.#replyWaiters.indexOf(w), 1);
          w.resolve(msg);
        }
        return;
      }
      if (typeof msg.id === 'string') {
        this.requests.push(msg);
        this.#answer(msg);
      }
    });
  }

  static async connect(port: number, token: string): Promise<BridgeSim> {
    return new BridgeSim(await ModClient.connect(port, token));
  }

  /** The first already-received or future message of type `t` matching `pred` (consumed). */
  next(t: string, pred: (m: Received) => boolean = () => true, timeoutMs = 3000): Promise<Received> {
    return this.mod.next(t, pred, timeoutMs);
  }

  /** Messages of type `t` received so far (not consumed). */
  sent(t: string): Received[] {
    return this.all.filter((m) => m.t === t);
  }

  send(msg: Record<string, unknown>): void {
    this.mod.send({ v: 1, ...msg });
  }

  /** Sends a request and resolves with Node's `ok` or `err`. */
  request(t: string, payload: Record<string, unknown>, timeoutMs = 3000): Promise<Received> {
    const id = `m-${++simSeq}`;
    const reply = new Promise<Received>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no reply to ${t}`)), timeoutMs);
      this.#replyWaiters.push({
        id,
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m);
        },
      });
    });
    this.send({ t, id, ...payload });
    return reply;
  }

  /** `hello{boot}`: resolves with `hello.ok` and the `world.open` that follows it. */
  async boot(playerName = 'Jasper'): Promise<{ helloOk: Received; open: Received }> {
    const id = `m-${++simSeq}`;
    this.send({ t: 'hello', id, mod: '0.1.0', mc: '26.3', phase: 'boot', playerName });
    const helloOk = await this.next('hello.ok', (m) => m.re === id);
    const open = await this.next('world.open');
    return { helloOk, open };
  }

  /** The world is ready (BootScreen created or opened it); `office` follows as the extra `ready` the mod sends. */
  ready(worldId: string, options: { fresh?: boolean; office?: SimOffice; clockTime?: number } = {}): void {
    this.send({
      t: 'world.state',
      worldId,
      phase: 'ready',
      ...(options.fresh !== undefined ? { fresh: options.fresh } : {}),
      spawn: { x: 0, y: 64, z: 0 },
      clockTime: options.clockTime ?? 0,
    });
    if (options.office) {
      this.send({
        t: 'world.state',
        worldId,
        phase: 'ready',
        office: options.office,
        clockTime: options.clockTime ?? 0,
      });
    }
  }

  clock(worldId: string, clockTime: number): void {
    this.send({ t: 'world.state', worldId, phase: 'ready', clockTime });
  }

  /** Ends a running job (or sit job) the way the mod does: `skill.result`. */
  endJob(jobId: string, agentId: string, outcome: Exclude<SimSkillOutcome, { status: 'running' }>): void {
    this.send({
      t: 'skill.result',
      jobId,
      agentId,
      status: outcome.status,
      ...(outcome.status === 'done' ? { result: { ...(outcome.result ?? {}), footer: SIM_FOOTER } } : {}),
      ...(outcome.status === 'failed' ? { error: { code: outcome.code, msg: outcome.msg } } : {}),
      durationMs: 5,
    });
  }

  close(): void {
    this.mod.ws.terminate();
  }

  #ok(re: string, result: Record<string, unknown> = {}): void {
    this.send({ t: 'ok', re, ...result });
  }

  #err(re: string, code: string, msg: string): void {
    this.send({ t: 'err', re, code, msg });
  }

  #answer(msg: Received): void {
    const id = msg.id as string;
    switch (msg.t) {
      case 'agent.spawn':
        this.#ok(id, {
          pos: { x: 0.5, y: 64, z: 0.5 },
          dim: 'minecraft:overworld',
          restored: msg.restore === true,
        });
        return;
      case 'agent.despawn':
      case 'agent.mode':
      case 'agent.unseat':
        this.#ok(id);
        return;
      case 'skill.cancel':
        this.#ok(id, { cancelled: typeof msg.jobId === 'string' ? [msg.jobId] : [] });
        return;
      case 'obs.query':
        this.#ok(id, {
          result: { ...(this.observations.get(msg.query as string) ?? {}), footer: SIM_FOOTER },
        });
        return;
      case 'agent.seat':
        if (this.seatError) this.#err(id, this.seatError, 'no chair');
        else this.#ok(id, { jobId: msg.jobId, status: 'running' });
        return;
      case 'skill.run': {
        const outcome = this.skillHandler(msg);
        if (outcome.status === 'running') this.#ok(id, { jobId: msg.jobId, status: 'running' });
        else if (outcome.status === 'done')
          this.#ok(id, {
            jobId: msg.jobId,
            status: 'done',
            result: { ...(outcome.result ?? {}), footer: SIM_FOOTER },
          });
        else
          this.#ok(id, {
            jobId: msg.jobId,
            status: 'failed',
            result: { footer: SIM_FOOTER },
            error: { code: outcome.code, msg: outcome.msg },
          });
        return;
      }
      default:
        this.#err(id, 'NOT_HANDLED', `the sim does not handle ${msg.t}`);
    }
  }
}
