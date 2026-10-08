/**
 * What the org services see of the world and the crew (PLAN §6.4, §6.6), assembled from the mod's pushes and the
 * crew's state:
 *
 * - `world.state` (1 Hz while ready): the overworld clock, the player snapshot (`player`: position, HP, combat,
 *   idle time, PC screen) and the office layout OfficeBuilder reports (`office.slots`: the meeting table, the
 *   workstations with their `pcId`, the door, …).
 * - `agent.state` (1 Hz): every body's position, dimension, seat, idle mode and distance to the player.
 * - `agent.event{approach_blocked}`: the mod's ApproachPlayer reflex cannot walk over (combat, night, far, another
 *   dimension, the player in a PC screen), so the presenter falls back to a ping for a while.
 * - The crew (CrewApi): names, handles, CEO, status, seated PC, brain status and last activity.
 *
 * Everything degrades gracefully: without a player snapshot the player counts as active, unhurt and out of combat;
 * without an office the meeting table is unknown (no ETAs, no distance).
 */

import type { PayloadOf, Place } from '@minevibe/protocol';
import type { AgentSummary } from '../contracts/CrewApi.js';
import type { AgentView, ApproachSnapshot, PlayerView } from './approach/ApproachQueue.js';
import type { UsageState } from './calendar/CalendarService.js';
import { TICKS_PER_DAY } from './clock.js';
import type { PlayerSnapshot, StatusLine } from './meeting/MeetingRunner.js';
import type { OrgCrewMember } from './OrgServices.js';

export const OVERWORLD = 'minecraft:overworld';

type Body = PayloadOf<'agent.state'>['agents'][number];
type PlayerState = NonNullable<PayloadOf<'world.state'>['player']>;
type Office = NonNullable<PayloadOf<'world.state'>['office']>;
type BlockedWhy = 'combat' | 'night' | 'far' | 'dimension' | 'pc_screen';

/** Walking speed used for meeting ETAs (blocks per second; a player walks 4.3, paths are not straight). */
const ETA_BLOCKS_PER_SECOND = 3.4;
/** How long an `approach_blocked` keeps the presenter on a ping. */
const BLOCKED_MS = 30_000;

/** Night (ticks of the day, 06:00 = 0): mobs spawn roughly from 13000 to 23000. */
export function isNightAt(clockTime: number | null): boolean {
  if (clockTime === null) return false;
  const t = ((clockTime % TICKS_PER_DAY) + TICKS_PER_DAY) % TICKS_PER_DAY;
  return t >= 13_000 && t < 23_000;
}

function dist(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

export class WorldView {
  #crew = new Map<string, AgentSummary>();
  readonly #activity = new Map<string, string | null>();
  #bodies = new Map<string, Body>();
  #player: PlayerState | null = null;
  #playerAt = 0;
  #office: Office | null = null;
  #clockTime: number | null = null;
  readonly #blocked = new Map<string, { why: BlockedWhy; until: number }>();
  /** The crew-wide usage (the UsageGovernor's `brains.state`), when the crew reports it. */
  #brains: { state: UsageState; resetsAt?: number | undefined } | null = null;

  // -------------------------------------------------------------------------------------------
  // Inputs
  // -------------------------------------------------------------------------------------------

  setCrew(agents: readonly AgentSummary[]): void {
    this.#crew = new Map(agents.map((a) => [a.agentId, a]));
  }

  /** The brain scheduler / usage summary (`mode` normal, tired or asleep, and when usage resets). */
  setBrains(summary: { mode: 'normal' | 'tired' | 'asleep'; resetsAt: number | null }): void {
    this.#brains = {
      state: summary.mode === 'normal' ? 'ok' : summary.mode,
      ...(summary.resetsAt !== null ? { resetsAt: summary.resetsAt } : {}),
    };
  }

  setActivity(agentId: string, activity: string | null): void {
    this.#activity.set(agentId, activity);
  }

  setBodies(bodies: readonly Body[]): void {
    this.#bodies = new Map(bodies.map((b) => [b.agentId, b]));
  }

  setPlayer(player: PlayerState, at: number): void {
    this.#player = player;
    this.#playerAt = at;
  }

  setOffice(office: Office): void {
    this.#office = office;
  }

  setClock(clockTime: number): void {
    this.#clockTime = clockTime;
  }

  /** `agent.event{approach_blocked, data.why}`. */
  blocked(agentId: string, why: unknown, now: number): void {
    const w: BlockedWhy =
      why === 'combat' || why === 'night' || why === 'dimension' || why === 'pc_screen' ? why : 'far';
    this.#blocked.set(agentId, { why: w, until: now + BLOCKED_MS });
  }

  /** A new world: bodies, the player and the office belong to the old one. */
  resetWorld(): void {
    this.#bodies.clear();
    this.#player = null;
    this.#office = null;
    this.#clockTime = null;
    this.#blocked.clear();
  }

  // -------------------------------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------------------------------

  get clockTime(): number | null {
    return this.#clockTime;
  }

  get office(): Office | null {
    return this.#office;
  }

  body(agentId: string): Body | undefined {
    return this.#bodies.get(agentId);
  }

  member(agentId: string): AgentSummary | undefined {
    return this.#crew.get(agentId);
  }

  get members(): readonly AgentSummary[] {
    return [...this.#crew.values()];
  }

  /** The crew as the org services see it. */
  orgCrew(): OrgCrewMember[] {
    return [...this.#crew.values()].map((a) => {
      const body = this.#bodies.get(a.agentId);
      return {
        agentId: a.agentId,
        name: a.name,
        handle: a.handle,
        status: a.status,
        isCeo: a.ceo,
        seated: a.seatedPc !== null || body?.seat?.kind === 'pc',
        dimension: body?.dim ?? OVERWORLD,
        escortingPlayer: body?.mode === 'follow',
        distanceToPlayer: body?.playerDistance ?? null,
        usage: this.#brains ?? { state: (a.brain === 'asleep' ? 'asleep' : 'ok') as UsageState },
        position: body
          ? {
              x: Math.floor(body.pos.x),
              y: Math.floor(body.pos.y),
              z: Math.floor(body.pos.z),
              dim: body.dim,
            }
          : null,
      };
    });
  }

  /**
   * Crew-wide usage: the governor's summary when the crew reports it (Tired shortens meetings, Asleep postpones
   * them until `resetsAt`), else asleep when every living agent's brain is.
   */
  usage(): { state: UsageState; resetsAt?: number | undefined } {
    if (this.#brains) return this.#brains;
    const living = [...this.#crew.values()].filter((a) => a.status === 'alive');
    return { state: living.length > 0 && living.every((a) => a.brain === 'asleep') ? 'asleep' : 'ok' };
  }

  /** An office slot's place (overworld). */
  slot(kind: string, pcId?: string): Place | null {
    const s = this.#office?.slots.find((x) => x.kind === kind && (pcId === undefined || x.pcId === pcId));
    return s ? { pos: { ...s.pos }, dim: OVERWORLD } : null;
  }

  /**
   * The player as the MeetingRunner sees them. Without a player snapshot it is not "night" for the safety rule (far
   * from the table at night), which needs the player's position: scheduled meetings would otherwise be postponed and
   * missed every night.
   */
  playerSnapshot(): PlayerSnapshot {
    const p = this.#player;
    const table = this.slot('meeting_table');
    return {
      hpFraction: p && p.maxHp > 0 ? Math.max(0, Math.min(1, p.hp / p.maxHp)) : 1,
      inCombat: p?.inCombat ?? false,
      distanceToTable: p && table && p.dim === table.dim ? dist(p.pos, table.pos) : null,
      isNight: p !== null && isNightAt(this.#clockTime),
    };
  }

  /** A rough path ETA to the meeting table, in seconds (null: other dimension, no body or no table). */
  etaSeconds(agentId: string): number | null {
    const body = this.#bodies.get(agentId);
    const table = this.slot('meeting_table');
    if (!body || !table || body.dim !== table.dim) return null;
    return Math.round(dist(body.pos, table.pos) / ETA_BLOCKS_PER_SECOND);
  }

  /** The quick standup's zero-token line: the agent's last activity. */
  statusLine(agentId: string): StatusLine {
    return { todo: [], lastActivity: this.#activity.get(agentId) ?? '' };
  }

  /** The 1 Hz world view of the ApproachQueue. */
  approachSnapshot(now: number): ApproachSnapshot {
    const p = this.#player;
    for (const [id, b] of [...this.#blocked]) if (b.until <= now) this.#blocked.delete(id);
    const blockedWhy = new Set([...this.#blocked.values()].map((b) => b.why));
    const player: PlayerView = {
      pos: p?.pos ?? null,
      dimension: p?.dim ?? OVERWORLD,
      hostileNearby: (p?.inCombat ?? false) || blockedWhy.has('combat'),
      lastDamageAt: null,
      inPcScreen:
        (p !== null && (p.screen === 'PcControlScreen' || p.seatedPc !== undefined)) ||
        blockedWhy.has('pc_screen'),
      seated: p !== null && p.seatedPc !== undefined,
      // Without a snapshot the player counts as active (no AFK parking).
      lastInputAt: p ? Math.min(now, this.#playerAt - p.idleMs) : now,
    };
    const agents: Record<string, AgentView> = {};
    for (const a of this.#crew.values()) {
      if (a.status !== 'alive') continue;
      const body = this.#bodies.get(a.agentId);
      if (!body) continue;
      const blocked = this.#blocked.get(a.agentId)?.why;
      const sameDim = body.dim === player.dimension;
      agents[a.agentId] = {
        pos: body.pos,
        dimension: blocked === 'dimension' ? `${body.dim}#elsewhere` : body.dim,
        seated: a.seatedPc !== null || body.seat?.kind === 'pc',
        pathBlocks:
          blocked === 'far' ? Number.POSITIVE_INFINITY : sameDim ? (body.playerDistance ?? null) : null,
        pathNeedsDigging: false,
        ...(blocked === 'night' ? { inLitArea: false } : {}),
      };
    }
    return { player, isNight: isNightAt(this.#clockTime) || blockedWhy.has('night'), agents };
  }
}
