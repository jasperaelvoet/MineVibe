import { ERROR_CODES, type MessageOf, type PayloadOf, type PcInfo, type PcStatus } from '@minevibe/protocol';
import type { Logger } from 'pino';
import { BridgeError, type BridgeServer, type HandlerResult } from '../bridge/BridgeServer.js';
import type { BudgetState } from './Budget.js';
import { delay } from './deadline.js';
import type { FrameService } from './FrameService.js';
import type { FolderPicker } from './folderPicker.js';
import type { PcGuestApi } from './GuestApi.js';
import type { InputRouter, Occupant } from './InputRouter.js';
import type { PcManager, PcStatusInfo } from './PcManager.js';
import type { PcType } from './PcTypes.js';
import {
  decommissionedInfo,
  type PcRequestKind,
  seatBanner,
  toBridgeError,
  toPcInfo,
  toWireBudget,
} from './pcWire.js';
import { type SeatBook, type SeatOccupant, type SeatState, seatTag } from './SeatBook.js';
import type { ShellMirror } from './ShellMirror.js';
import { suggestOverlays } from './Vault.js';

/**
 * The PC group of the bridge (protocol §7.7, PLAN §8): what the mod sees of the PCs and what it may do with them.
 *
 * - **Pushes.** `pc.state` for every PC whose state changed (PcManager status, config, seats) and `budget.state`,
 *   again in full after every `hello` (once right after `hello.ok` and once more a moment later, because the handshake
 *   reply carries no PC snapshot yet). A deleted PC gets one last `pc.state{decommissioned}`.
 * - **Frames.** `pc.view` sets the FrameService tier (a visible PC with an agent at it gets the seated rate), MVF1
 *   frames go out through `bridge.sendFrame`, `pc.frame.ack` releases them, and the seated agent's pointer becomes
 *   `pc.cursor` (frames carry no cursor, PLAN §8.6). Every tier drops to none when the mod disconnects (it re-sends
 *   them after the next handshake).
 * - **Input.** `pc.input` (the player's T0 event objects) reaches the InputRouter only while the player sits at that
 *   PC (`pc.seat`); the router obeys one occupant, so a seat change releases every held key.
 * - **Seats.** `pc.seat` / `pc.unseat` keep the SeatBook (occupant, `away` reservation). An agent that sits down gets
 *   its ShellMirror; when it leaves for good (anything but `away`) its tagged guest processes are killed and the
 *   mirror closes. A PC that stops while an agent sits there unseats it (`agent.unseat{pc_down}`).
 * - **Requests.** `pc.config`, `pc.action`, `pc.consent` and `host.pick_folder` map onto PcManager with typed errors.
 *   Slow operations (boot, recreate, reimage) answer `ok` once they are admitted and have run for a while; their
 *   progress and failures then show in `pc.state`.
 */

export type PcBridgeLike = Pick<BridgeServer, 'on' | 'handle' | 'send' | 'request' | 'sendFrame'>;

export interface PcBridgeGlueOptions {
  readonly bridge: PcBridgeLike;
  readonly manager: PcManager;
  readonly frames: FrameService;
  readonly router: InputRouter;
  readonly seats: SeatBook;
  readonly guest: PcGuestApi;
  readonly mirror: ShellMirror;
  readonly pickFolder: FolderPicker;
  readonly logger: Logger;
  /** How long a request waits for a slow PC operation before answering `ok` (default 20 s; the mod waits 30 s). */
  readonly settleMs?: number;
  /** Delay of the budget refresh after a status change (default 1 s). */
  readonly budgetDebounceMs?: number;
  /** The second full push after a `hello` (default 1.5 s). */
  readonly helloRepushMs?: number;
}

const PLAYER: Occupant = { kind: 'player', id: 'player' };

const routerOccupant = (o: SeatOccupant | null): Occupant | null =>
  o === null ? null : o.kind === 'player' ? PLAYER : { kind: 'agent', id: o.agentId };

export class PcBridgeGlue {
  readonly #o: PcBridgeGlueOptions;
  readonly #log: Logger;
  readonly #offs: (() => void)[] = [];
  /** JSON of the last `pc.state` sent per PC. */
  readonly #sent = new Map<string, string>();
  /** The last `pc.state` per PC (for the final `decommissioned`). */
  readonly #last = new Map<string, PcInfo>();
  /** The tier the mod asked for per PC (`pc.view`). */
  readonly #tiers = new Map<string, 'focus' | 'visible' | 'none'>();
  readonly #watching = new Set<string>();
  readonly #statuses = new Map<string, PcStatus>();
  /** Agents away from their chair (asking the player): their seat tag survives until they come back or leave. */
  readonly #away = new Map<string, { agentId: string; seatEpoch: number | null }>();
  readonly #cursors = new Map<string, string>();
  /** PCs whose seated agent was already told to stand because the PC went down. */
  readonly #downUnseats = new Set<string>();
  readonly #timers = new Set<NodeJS.Timeout>();
  #budgetTimer: NodeJS.Timeout | null = null;
  #attached = false;
  /** The player's name from `hello` (the "BRB: asking <player>" banner). */
  #playerName: string | null = null;

  constructor(options: PcBridgeGlueOptions) {
    this.#o = options;
    this.#log = options.logger;
  }

  /** Registers the handlers and listeners (before the bridge starts, so the first `hello` is not missed). */
  attach(): void {
    if (this.#attached) return;
    this.#attached = true;
    const { bridge, manager, seats } = this.#o;
    const handle = <K extends 'pc.config' | 'pc.action' | 'pc.consent' | 'host.pick_folder'>(
      t: K,
      fn: (m: MessageOf<K>) => Promise<HandlerResult>,
    ) => {
      try {
        this.#offs.push(bridge.handle(t, fn));
      } catch (err) {
        this.#log.error({ err: String(err), t }, 'another module already handles this PC request');
      }
    };
    this.#offs.push(
      bridge.on('hello', (m) => this.#onHello(m)),
      bridge.on('disconnected', () => this.#onDisconnected()),
      bridge.on('pc.view', (m) => this.#onView(m)),
      bridge.on('pc.frame.ack', (m) => this.#onAck(m)),
      bridge.on('pc.input', (m) => this.#onInput(m)),
      bridge.on('pc.seat', (m) => this.#onSeat(m)),
      bridge.on('pc.unseat', (m) => this.#onUnseat(m)),
      manager.on('pc.state', () => this.pushStates()),
      manager.on('pc.status', (id, info) => this.#onStatus(id, info)),
      manager.on('budget.state', (s) => this.#pushBudget(s)),
      seats.on('change', (pcId, now, before) => this.#onSeatChange(pcId, now, before)),
    );
    handle('pc.config', (m) => this.#onConfig(m));
    handle('pc.action', (m) => this.#onAction(m));
    handle('pc.consent', (m) => this.#onConsent(m));
    handle('host.pick_folder', (m) => this.#onPickFolder(m));
  }

  detach(): void {
    for (const off of this.#offs.splice(0)) off();
    for (const t of this.#timers) clearTimeout(t);
    this.#timers.clear();
    if (this.#budgetTimer) clearTimeout(this.#budgetTimer);
    this.#budgetTimer = null;
    this.#attached = false;
  }

  // ------------------------------------------------------------------------------------------- pushes

  /** Sends `pc.state` for every PC that changed since it was last sent (`force`: every PC). */
  pushStates(force = false): void {
    const { manager, seats } = this.#o;
    const views = manager.views();
    const present = new Set<string>();
    for (const view of views) {
      present.add(view.pcId);
      const rec = manager.get(view.pcId);
      if (!rec) continue;
      let info: PcInfo | null;
      try {
        const seat = seats.get(view.pcId);
        info = toPcInfo(view, rec, {
          seat,
          diskGiB: manager.diskGiBOf(view.pcId),
          banner: seatBanner(seat, this.#playerName, this.#away.get(view.pcId)?.agentId ?? null),
        });
      } catch (err) {
        this.#log.warn({ pcId: view.pcId, err: String(err) }, 'pc.state could not be built');
        continue;
      }
      if (!info) continue;
      this.#last.set(view.pcId, info);
      const json = JSON.stringify(info);
      if (!force && this.#sent.get(view.pcId) === json) continue;
      if (this.#send('pc.state', info)) this.#sent.set(view.pcId, json);
    }
    for (const [pcId, last] of [...this.#last]) {
      if (present.has(pcId)) continue;
      // Deleted: one last state, so the mod drops the monitor texture and shows the desk empty.
      this.#send('pc.state', decommissionedInfo(last));
      this.#last.delete(pcId);
      this.#sent.delete(pcId);
      this.#forget(pcId);
    }
  }

  /** Every PC and the budget, now (after `hello`). */
  pushAll(): void {
    this.#sent.clear();
    this.pushStates(true);
    this.refreshBudget(0);
  }

  /** Recomputes the budget (a container listing) after `delayMs`, coalescing calls; PcManager emits the result. */
  refreshBudget(delayMs = this.#o.budgetDebounceMs ?? 1000): void {
    if (this.#budgetTimer) return;
    this.#budgetTimer = setTimeout(() => {
      this.#budgetTimer = null;
      this.#o.manager.budget().catch((err: unknown) => {
        this.#log.debug({ err: String(err) }, 'budget refresh failed');
      });
    }, delayMs);
    this.#budgetTimer.unref?.();
  }

  #pushBudget(state: BudgetState): void {
    const { manager } = this.#o;
    this.#send(
      'budget.state',
      toWireBudget(state, { crewCap: manager.crewCap, cpuOvercommit: manager.cpuOvercommit }),
    );
  }

  #send<K extends 'pc.state' | 'budget.state' | 'pc.cursor'>(t: K, payload: PayloadOf<K>): boolean {
    try {
      return this.#o.bridge.send(t, payload);
    } catch (err) {
      this.#log.warn({ err: String(err), t }, 'PC push failed');
      return false;
    }
  }

  #later(ms: number, fn: () => void): void {
    const t = setTimeout(() => {
      this.#timers.delete(t);
      fn();
    }, ms);
    t.unref?.();
    this.#timers.add(t);
  }

  // ------------------------------------------------------------------------------------------- session

  #onHello(m: MessageOf<'hello'>): void {
    if (m.playerName) this.#playerName = m.playerName;
    if (m.phase === 'boot') {
      // The game is on BootScreen: nobody sits anywhere.
      this.#endAllSeats('world_end');
    }
    // hello.ok goes out first (the world lifecycle answers on the same event); then the full state, and once more
    // shortly after in case the handshake reply was delayed (it carries no PC snapshot, so it would wipe ours).
    this.#later(0, () => this.pushAll());
    this.#later(this.#o.helloRepushMs ?? 1500, () => this.pushAll());
  }

  #onDisconnected(): void {
    for (const pcId of this.#tiers.keys()) this.#o.frames.setTier(pcId, { mode: 'none' });
    this.#tiers.clear();
    this.#watching.clear();
    this.#cursors.clear();
  }

  // ------------------------------------------------------------------------------------------- frames

  #onView(m: MessageOf<'pc.view'>): void {
    if (!this.#o.manager.get(m.pcId)) return;
    if (m.tier === 'none') this.#tiers.delete(m.pcId);
    else this.#tiers.set(m.pcId, m.tier);
    this.#applyTier(m.pcId);
  }

  #applyTier(pcId: string): void {
    const tier = this.#tiers.get(pcId) ?? 'none';
    const { frames, seats } = this.#o;
    if (tier === 'focus') frames.setTier(pcId, { mode: 'focus' });
    else if (tier === 'visible')
      frames.setTier(pcId, { mode: 'visible', agentSeated: seats.agentAt(pcId) !== null });
    else frames.setTier(pcId, { mode: 'none' });
  }

  #onAck(m: MessageOf<'pc.frame.ack'>): void {
    const slot = this.#o.manager.slotOf(m.pcId);
    if (slot !== undefined) this.#o.frames.ack(slot, m.seq);
  }

  /** The seated agent's pointer (its last target, or the polled guest cursor) as `pc.cursor`. */
  onCursor(pcId: string, pos: { x: number; y: number }): void {
    if (!this.#o.seats.agentAt(pcId)) return;
    const cursor = {
      pcId,
      x: Math.max(0, Math.min(65_535, Math.round(pos.x))),
      y: Math.max(0, Math.min(65_535, Math.round(pos.y))),
      visible: true,
    };
    const json = JSON.stringify(cursor);
    if (this.#cursors.get(pcId) === json) return;
    if (this.#send('pc.cursor', cursor)) this.#cursors.set(pcId, json);
  }

  #hideCursor(pcId: string): void {
    const last = this.#cursors.get(pcId);
    if (!last) return;
    this.#cursors.delete(pcId);
    const prev = JSON.parse(last) as { x: number; y: number };
    this.#send('pc.cursor', { pcId, x: prev.x, y: prev.y, visible: false });
  }

  // ------------------------------------------------------------------------------------------- input

  #onInput(m: MessageOf<'pc.input'>): void {
    if (!this.#o.seats.playerAt(m.pcId)) {
      this.#log.debug({ pcId: m.pcId, seq: m.seq }, 'pc.input from a player who does not sit there; dropped');
      return;
    }
    const r = this.#o.router.submit(m.pcId, PLAYER, m.events);
    if (r.rejected > 0) this.#log.debug({ pcId: m.pcId, seq: m.seq, ...r }, 'pc.input events rejected');
  }

  // ------------------------------------------------------------------------------------------- seats

  #onSeat(m: MessageOf<'pc.seat'>): void {
    const occupant: SeatOccupant =
      m.occupant.kind === 'player'
        ? { kind: 'player' }
        : { kind: 'agent', agentId: m.occupant.agentId, seatEpoch: m.seatEpoch ?? null };
    const away = this.#away.get(m.pcId);
    if (away) {
      this.#away.delete(m.pcId);
      // Someone else took the chair of an agent that was away asking: its seat is over.
      if (occupant.kind !== 'agent' || occupant.agentId !== away.agentId) {
        this.#endAgentSeat(m.pcId, away.agentId, away.seatEpoch, 'player_took');
      }
    }
    if (occupant.kind === 'agent') {
      // The agent sits down here while Node still has it at another PC (that `pc.unseat` was lost): that seat is
      // over, so its processes and mirror go like on any other unseat.
      const elsewhere = this.#o.seats.pcOfAgent(occupant.agentId);
      const before = elsewhere && elsewhere !== m.pcId ? this.#o.seats.agentAt(elsewhere) : null;
      if (elsewhere && before) this.#endAgentSeat(elsewhere, before.agentId, before.seatEpoch, 'moved');
    }
    this.#o.seats.seat(m.pcId, occupant);
    if (this.#o.manager.get(m.pcId)) {
      this.#o.manager.markUsed(m.pcId).catch(() => {});
    }
  }

  #onUnseat(m: MessageOf<'pc.unseat'>): void {
    const who =
      m.occupant.kind === 'player'
        ? ({ kind: 'player' } as const)
        : ({ kind: 'agent', agentId: m.occupant.agentId } as const);
    const left = this.#o.seats.unseat(m.pcId, who, m.reserved);
    if (who.kind !== 'agent') return;
    if (left?.kind === 'agent') {
      if (m.reason === 'away') {
        this.#away.set(m.pcId, { agentId: left.agentId, seatEpoch: left.seatEpoch });
        this.pushStates(); // the "BRB: asking <player>" banner
        return;
      }
      this.#endAgentSeat(m.pcId, left.agentId, left.seatEpoch, m.reason);
      return;
    }
    // An agent that was away and is now gone for good (reservation expired, the player took the chair, a kick).
    const away = this.#away.get(m.pcId);
    if (away && away.agentId === who.agentId && !m.reserved) {
      this.#away.delete(m.pcId);
      this.#endAgentSeat(m.pcId, away.agentId, away.seatEpoch, m.reason);
    }
  }

  /** The agent's seat at a PC ended: kill its tagged guest processes and close its mirror. */
  #endAgentSeat(pcId: string, agentId: string, seatEpoch: number | null, reason: string): void {
    const tag = seatTag(agentId, seatEpoch);
    void this.#o.guest
      .killTag(pcId, tag)
      .then((n) => {
        if (n > 0)
          this.#log.info({ pcId, agentId, reason, killed: n }, 'killed the guest processes of a seat');
      })
      .catch(() => {});
    if (this.#o.mirror.openFor(pcId) === agentId) void this.#o.mirror.close(pcId);
  }

  /** Ends every agent seat (the mod is gone from the world): kills, mirrors, bookkeeping. */
  #endAllSeats(reason: string): void {
    const { manager, seats } = this.#o;
    for (const v of manager.views()) {
      const a = seats.agentAt(v.pcId) ?? this.#away.get(v.pcId) ?? null;
      if (a) this.#endAgentSeat(v.pcId, a.agentId, a.seatEpoch, reason);
    }
    this.#away.clear();
    seats.clear();
  }

  /** World end (PcModule.onWorldEnded): every seat is gone with the world. */
  worldEnded(): void {
    this.#endAllSeats('world_end');
  }

  #onSeatChange(pcId: string, now: SeatState, before: SeatState): void {
    this.#o.router.setOccupant(pcId, routerOccupant(now.occupant));
    const nowAgent = now.occupant?.kind === 'agent' ? now.occupant.agentId : null;
    const beforeAgent = before.occupant?.kind === 'agent' ? before.occupant.agentId : null;
    if (nowAgent && nowAgent !== beforeAgent && this.#o.manager.status(pcId).status === 'running') {
      this.#downUnseats.delete(pcId);
      void this.#o.mirror.open(pcId, nowAgent);
    }
    if (!nowAgent) this.#hideCursor(pcId);
    if ((nowAgent === null) !== (beforeAgent === null) && this.#tiers.get(pcId) === 'visible')
      this.#applyTier(pcId);
    this.pushStates();
  }

  // ------------------------------------------------------------------------------------------- PC status

  #onStatus(pcId: string, info: PcStatusInfo): void {
    const before = this.#statuses.get(pcId);
    if (before === info.status) return;
    this.#statuses.set(pcId, info.status);
    this.refreshBudget();
    const { guest, mirror } = this.#o;
    if (info.status === 'running') {
      guest.forgetGuest(pcId);
      this.#downUnseats.delete(pcId);
      return;
    }
    if (before === 'running') {
      guest.forgetPc(pcId);
      mirror.forget(pcId);
      this.#unseatAgent(pcId, 'pc_down');
    }
  }

  /** Stands the seated agent up (`agent.unseat`), once per PC until someone sits again. Never throws. */
  #unseatAgent(pcId: string, reason: 'pc_down' | 'kick'): Promise<void> {
    const agent = this.#o.seats.agentAt(pcId);
    if (!agent) return Promise.resolve();
    if (reason === 'pc_down') {
      if (this.#downUnseats.has(pcId)) return Promise.resolve();
      this.#downUnseats.add(pcId);
    }
    return this.#o.bridge
      .request(
        'agent.unseat',
        { agentId: agent.agentId, seatEpoch: agent.seatEpoch ?? 0, reason, keepReservation: false },
        { timeoutMs: 10_000 },
      )
      .then(
        () => {},
        (err: unknown) =>
          this.#log.warn({ pcId, agentId: agent.agentId, reason, err: String(err) }, 'agent.unseat failed'),
      );
  }

  #forget(pcId: string): void {
    this.#tiers.delete(pcId);
    this.#watching.delete(pcId);
    this.#statuses.delete(pcId);
    this.#away.delete(pcId);
    this.#cursors.delete(pcId);
    this.#downUnseats.delete(pcId);
    this.#o.seats.clear(pcId);
    this.#o.guest.forgetPc(pcId);
    this.#o.mirror.forget(pcId);
  }

  // ------------------------------------------------------------------------------------------- requests

  /**
   * Waits for a PC operation at most `settleMs`: a failure in that time is the request's typed `err`; an operation
   * still running then goes on in the background (its outcome shows in `pc.state`).
   */
  async #settle(op: Promise<unknown>, kind: PcRequestKind, what: string): Promise<unknown> {
    const outcome = await Promise.race([
      op.then(
        (v) => ({ ok: true as const, v }),
        (e: unknown) => ({ ok: false as const, e }),
      ),
      delay(this.#o.settleMs ?? 20_000).then(() => null),
    ]);
    if (outcome === null) {
      op.catch((err: unknown) => this.#log.warn({ what, err: String(err) }, 'PC operation failed'));
      return undefined;
    }
    if (!outcome.ok) throw toBridgeError(outcome.e, kind);
    return outcome.v;
  }

  /** Runs an operation in the background (its failures show in `pc.state` and the log). */
  #background(what: string, op: () => Promise<unknown>): void {
    void op().catch((err: unknown) => this.#log.warn({ what, err: String(err) }, 'PC operation failed'));
  }

  #known(pcId: string | undefined): string {
    if (!pcId || !this.#o.manager.get(pcId)) {
      throw new BridgeError(ERROR_CODES.PC_UNKNOWN, `there is no PC ${pcId ?? ''}`.trim());
    }
    return pcId;
  }

  async #onConfig(m: MessageOf<'pc.config'>): Promise<HandlerResult> {
    const { manager } = this.#o;
    const pcId = this.#known(m.pcId);
    const rec = manager.get(pcId);
    if (!rec) throw new BridgeError(ERROR_CODES.PC_UNKNOWN, `there is no PC ${pcId}`);
    try {
      if (m.name !== undefined) await manager.setName(pcId, m.name);
      if (m.pinned !== undefined) await manager.setPinned(pcId, m.pinned);
      if (m.wipeOnDeath !== undefined) await manager.setWipeOnDeath(pcId, m.wipeOnDeath);
    } catch (err) {
      throw toBridgeError(err, 'config');
    }
    // Everything that defines the PC's containers goes through one reconfigure (an Android phone alone recreates
    // nothing; PcManager tells).
    const wantsReconfigure =
      m.type !== undefined ||
      m.cpus !== undefined ||
      m.memoryMiB !== undefined ||
      m.mounts !== undefined ||
      m.virtualization !== undefined ||
      m.android !== undefined;
    if (!wantsReconfigure) {
      this.pushStates();
      return { recreate: false };
    }
    const mac = (m.type ?? rec.type) === 'macos';
    const mounts = m.mounts?.map((w) => {
      const existing = rec.mounts.find((x) => x.host === w.hostPath);
      const ro = w.mode === 'ro';
      // Keep a folder's overlays; a new read-write project folder gets the build-dir overlays its marker files suggest
      // (Linux only: a macOS PC shares the folder as it is).
      const overlays = mac
        ? []
        : existing && existing.ro === ro
          ? existing.overlays
          : ro
            ? []
            : suggestOverlays(w.hostPath);
      return { host: w.hostPath, ro, overlays };
    });
    const op = manager.reconfigure(pcId, {
      ...(m.type !== undefined ? { type: m.type as PcType } : {}),
      ...(m.cpus !== undefined ? { cpus: m.cpus } : {}),
      ...(m.memoryMiB !== undefined ? { memMiB: m.memoryMiB } : {}),
      ...(mounts !== undefined ? { mounts } : {}),
      ...(m.virtualization !== undefined ? { virtualization: m.virtualization } : {}),
      ...(m.android !== undefined ? { android: m.android } : {}),
    });
    const done = (await this.#settle(op, 'config', `configure ${pcId}`)) as
      | Awaited<ReturnType<PcManager['reconfigure']>>
      | undefined;
    return { recreate: done ? done.recreated : true };
  }

  async #onAction(m: MessageOf<'pc.action'>): Promise<HandlerResult> {
    const { manager } = this.#o;
    if (m.action === 'create') {
      let pcId: string;
      try {
        ({
          pc: { id: pcId },
        } = await manager.create({ type: m.type as PcType, boot: false }));
      } catch (err) {
        throw toBridgeError(err, 'create');
      }
      // Admission and boot run in the background: a PC that does not fit shows `no_capacity` on its monitor.
      this.#background(`start ${pcId}`, () => manager.start(pcId));
      this.pushStates();
      return { pcId };
    }
    const pcId = this.#known(m.pcId);
    switch (m.action) {
      case 'start':
        await this.#settle(manager.start(pcId), 'start', `start ${pcId}`);
        break;
      case 'stop':
        await this.#settle(manager.stop(pcId), 'action', `stop ${pcId}`);
        break;
      case 'restart':
        await this.#settle(manager.restart(pcId), 'start', `restart ${pcId}`);
        break;
      case 'reimage':
        await this.#settle(manager.reimage(pcId), 'start', `reimage ${pcId}`);
        break;
      case 'decommission':
        await this.#unseatAgent(pcId, 'pc_down');
        await this.#settle(manager.decommission(pcId), 'action', `decommission ${pcId}`);
        break;
      case 'reissue':
        // A new workstation item bound to this PC (the old one was lost); the mod hands it out. Node keeps the PC
        // as it is: unplugged until that item's desk sends `plug`.
        break;
      case 'unplug':
        await this.#unseatAgent(pcId, 'pc_down');
        await this.#settle(manager.setPlugged(pcId, false), 'action', `unplug ${pcId}`);
        break;
      case 'plug':
        try {
          await manager.setPlugged(pcId, true);
        } catch (err) {
          throw toBridgeError(err, 'action');
        }
        if (manager.status(pcId).status !== 'running') {
          this.#background(`start ${pcId}`, () => manager.start(pcId));
        }
        break;
      case 'kick': {
        const agent = this.#o.seats.agentAt(pcId);
        if (!agent) throw new BridgeError(ERROR_CODES.NOT_READY, `no agent sits at ${pcId}`);
        await this.#o.bridge.request(
          'agent.unseat',
          { agentId: agent.agentId, seatEpoch: agent.seatEpoch ?? 0, reason: 'kick', keepReservation: false },
          { timeoutMs: 10_000 },
        );
        break;
      }
      case 'watch':
        this.#watching.add(pcId);
        break;
      case 'unwatch':
        this.#watching.delete(pcId);
        break;
    }
    this.pushStates();
    return { pcId };
  }

  /**
   * The player's answer to a download prompt (`PcInfo.consent`): the macOS image (accepting starts every PC that
   * waited for it, in the background: the download takes minutes, its progress shows as `downloading`; declining turns
   * them off), or the first use of a Linux PC's Android phone or nested virtualization (PLAN §8.8: "Download" applies
   * the switch that waited for it, which may recreate the PC, so like `pc.config` the reply comes once that has run
   * for a while).
   */
  async #onConsent(m: MessageOf<'pc.consent'>): Promise<HandlerResult> {
    const { manager } = this.#o;
    const pcId = this.#known(m.pcId);
    if (manager.consentOf(pcId)?.consentId === m.consentId) {
      await this.#settle(manager.answerConsent(pcId, m.consentId, m.accept), 'config', `consent ${pcId}`);
      this.pushStates();
      return {};
    }
    let start: string[];
    try {
      ({ start } = await manager.consent(pcId, m.consentId, m.accept));
    } catch (err) {
      throw new BridgeError(
        ERROR_CODES.NOT_READY,
        (err instanceof Error ? err.message : String(err)).slice(0, 300),
      );
    }
    for (const id of start) this.#background(`start ${id}`, () => manager.start(id));
    this.pushStates();
    return {};
  }

  async #onPickFolder(m: MessageOf<'host.pick_folder'>): Promise<HandlerResult> {
    const title = m.prompt ?? (m.pcId ? `Choose a folder for ${m.pcId}` : 'Choose a folder');
    const path = await this.#o.pickFolder({
      title,
      message:
        'MineVibe mounts the folder into the PC at the same path. Agents at that PC can change its files.',
      button: 'Add to Vault',
    });
    return { path };
  }

  /** Whether the player watches a PC fullscreen (`pc.action watch`). */
  isWatching(pcId: string): boolean {
    return this.#watching.has(pcId);
  }
}
