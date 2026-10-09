/**
 * The simulated world of the tool evals: a deterministic, tick-based stand-in for the mod's side of the SkillApi.
 *
 * - Blocks: a flat grass plain (y 63) plus explicit blocks, each with a provenance (`natural`, `player`, `agent`) and
 *   an optional structure name, so scenarios can tell "a tree" from "the player's house" even though the current mc
 *   tools cannot.
 * - One agent body (position, vitals, idle mode, held item, inventory), the player, mobs, containers, a clock.
 * - Jobs advance in game time (`advance`): a job is a sequence of steps, each taking some ticks and applying its effect
 *   when the time has passed, so a `wait_s` shorter than the job answers `running` like the mod does.
 * - Scheduled world events (a zombie at dusk) and a 1 Hz mob tick (zombies walk to the player and hurt them; the
 *   body's Protect reflex fights them when it is close to the player).
 *
 * Nothing here is random. Observation and job result formats live in observe.ts and jobs.ts.
 */

import type { IdleMode } from '@minevibe/protocol';
import { blockSpec, maxStack, NS, normId, shortId } from './items.js';

export const TPS = 20;
export const TICKS_PER_DAY = 24_000;
/** Walking speed of the body in blocks per second (jobs and idle modes). */
export const WALK_BPS = 4.3;
/** The mod's idle modes (ReflexBrain): follow keeps 3 blocks (starts at 4), guard clears 12 around the anchor. */
const FOLLOW_DISTANCE = 3;
const GUARD_RADIUS = 12;

export interface Pos {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export type Provenance = 'natural' | 'player' | 'agent';

export interface Block {
  readonly id: string;
  readonly placedBy: Provenance;
  /** A named structure (`house`, `tree:oak_a`) for scenario checks. */
  readonly structure?: string | undefined;
}

export interface Mob {
  readonly id: string;
  readonly type: string;
  pos: Pos;
  hp: number;
  readonly hostile: boolean;
  alive: boolean;
}

export interface BrokenBlock {
  readonly pos: Pos;
  readonly block: Block;
  readonly at: number;
  readonly skill: string;
}

export interface WorldEventLog {
  readonly type: string;
  readonly at: number;
  readonly data?: Readonly<Record<string, unknown>> | undefined;
}

export interface Box {
  readonly min: Pos;
  readonly max: Pos;
}

/** A protected zone (the mod's `Zones.Zone`): the Base is the office's box plus a 2-block margin. */
export interface Zone {
  readonly name: string;
  readonly box: Box;
  /** Whose it is; null means the world's player. */
  readonly owner: string | null;
}

/**
 * Why a block may not be changed (the mod's `Protection.Verdict`): player-built, or inside a protected zone (`base`).
 * `lead` replaces "That's %s" in the hint (a natural block that holds up a protected one).
 */
export interface Verdict {
  readonly pos: Pos;
  readonly what: 'player-built' | 'base';
  readonly owner: string;
  /** The block id (`minecraft:stripped_spruce_log`). */
  readonly block: string;
  readonly zone: string | null;
  readonly lead?: string | undefined;
}

/** The mod's `Verdict.hint()`: "That's part of Jasper's build — ask Jasper before changing it." */
export function verdictHint(v: Verdict): string {
  const thing =
    v.what === 'base'
      ? `part of ${v.owner}'s ${v.zone === null || v.zone === 'Base' ? 'base' : v.zone}`
      : `part of ${v.owner}'s build`;
  const head = v.lead ? v.lead.replace('%s', thing) : `That's ${thing}`;
  return `${head} — ask ${v.owner} before changing it.`;
}

/** The mod's `Protection.ROOF_SCAN`: how far up a natural block looks for a player's roof. */
const ROOF_SCAN = 6;

export const AIR = 'minecraft:air';
const AIR_BLOCK: Block = { id: AIR, placedBy: 'natural' };
const GRASS: Block = { id: `${NS}grass_block`, placedBy: 'natural' };
const DIRT: Block = { id: `${NS}dirt`, placedBy: 'natural' };
const STONE: Block = { id: `${NS}stone`, placedBy: 'natural' };
const BEDROCK: Block = { id: `${NS}bedrock`, placedBy: 'natural' };

/** Half-width of the generated plain; beyond it there is only air (unloaded). */
export const WORLD_RADIUS = 48;
export const GROUND_Y = 63;

export function posKey(p: Pos): string {
  return `${p.x},${p.y},${p.z}`;
}

export function dist(a: Pos, b: Pos): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

export function inBox(p: Pos, box: Box): boolean {
  return (
    p.x >= box.min.x &&
    p.x <= box.max.x &&
    p.y >= box.min.y &&
    p.y <= box.max.y &&
    p.z >= box.min.z &&
    p.z <= box.max.z
  );
}

export function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

/** `day 3 08:12` from a clock in ticks (the mod's WorldClock.dayAndTime). */
export function dayAndTime(t: number): string {
  const day = Math.floor(t / TICKS_PER_DAY) + 1;
  const inDay = ((t % TICKS_PER_DAY) + TICKS_PER_DAY) % TICKS_PER_DAY;
  const hour = (Math.floor(inDay / 1000) + 6) % 24;
  const minute = Math.floor(((inDay % 1000) * 60) / 1000);
  return `day ${day} ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

export interface AgentBody {
  readonly agentId: string;
  readonly name: string;
  readonly role: string;
  pos: Pos;
  hp: number;
  readonly maxHp: number;
  food: number;
  saturation: number;
  mode: IdleMode;
  anchor: Pos | null;
  held: string | null;
  /** Item id → count, in pickup order. */
  readonly inventory: Map<string, number>;
  readonly home: Pos;
}

export interface PlayerBody {
  readonly name: string;
  pos: Pos;
  hp: number;
  /** Items the agent gave the player. */
  readonly received: Map<string, number>;
  sheltered: boolean;
}

interface Scheduled {
  readonly at: number;
  readonly label: string;
  readonly fire: (world: SimWorld) => void;
}

/** One running or finished job of the agent (jobs.ts builds the step logic). */
export interface JobStep {
  /** Ticks this step takes; its effect applies when they have passed. */
  readonly dt: number;
  readonly effect?: (() => void) | undefined;
  /** Progress shown while this step runs: fraction and text ("3/10 minecraft:oak_log"), like `skill.progress`. */
  readonly progress?: readonly [number, string] | undefined;
}

export interface JobEndSpec {
  readonly status: 'done' | 'failed';
  readonly result: Record<string, unknown>;
  readonly error?: { readonly code: string; readonly msg: string } | undefined;
}

export type JobNext = JobStep | { readonly end: JobEndSpec };

export interface JobLogic {
  next(): JobNext;
}

export interface SimJob {
  readonly jobId: string;
  readonly skill: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly startedAt: number;
  dueAt: number;
  pending: JobStep | null;
  status: 'running' | 'done' | 'failed' | 'cancelled';
  result: Record<string, unknown> | undefined;
  error: { code: string; msg: string } | undefined;
  endedAt: number | null;
  progress: number | null;
  text: string;
  readonly logic: JobLogic;
}

export interface SimWorldInit {
  readonly agentId?: string;
  readonly agentName?: string;
  readonly role?: string;
  readonly agentPos?: Pos;
  readonly playerName?: string;
  readonly playerPos?: Pos;
  readonly clock?: number;
  readonly mode?: IdleMode;
  readonly inventory?: readonly (readonly [string, number])[];
  readonly held?: string | null;
}

export class SimWorld {
  clock: number;
  readonly agent: AgentBody;
  readonly player: PlayerBody;
  readonly mobs: Mob[] = [];
  readonly #blocks = new Map<string, Block>();
  readonly containers = new Map<string, Map<string, number>>();
  readonly unreachable: Box[] = [];
  /** Interiors that shelter whoever stands in them (the house). */
  readonly shelters: Box[] = [];
  /** Protected zones (W1; only the v2 mod reads them): the Base around the house. */
  readonly zones: Zone[] = [];
  /** Consent tokens offered with `PROTECTED` refusals (the mod's `Consents`): token → the refused box. */
  readonly #consentOffers = new Map<string, Box>();
  #consentSeq = 0;
  /** The redeemed consent of the running job: it may change protected blocks inside `box`. */
  grant: { readonly box: Box; readonly jobId: string } | null = null;
  readonly broken: BrokenBlock[] = [];
  readonly placed: { readonly pos: Pos; readonly id: string; readonly at: number }[] = [];
  readonly events: WorldEventLog[] = [];
  /** Agent events for `recent_events` (type, game time, data). */
  readonly agentEvents: WorldEventLog[] = [];
  readonly #scheduled: Scheduled[] = [];
  readonly jobs = new Map<string, SimJob>();
  current: SimJob | null = null;
  /**
   * Which mod this world simulates: `v1` (the mod the v1 tools were measured on: no provenance, tags take building
   * variants) or `v2` (W1 world awareness plus the v2 skill additions: eval/sim/v2.ts).
   */
  mod: 'v1' | 'v2' = 'v1';
  /** Called when a job ends (SimSkillApi turns it into a `result` event). */
  onJobEnd: ((job: SimJob) => void) | null = null;
  #mobSeq = 0;
  /** The idle mode is walking the body back (inner hysteresis distance applies). */
  #idleWalking = false;

  constructor(init: SimWorldInit = {}) {
    this.clock = init.clock ?? 2_000;
    const home = init.agentPos ?? { x: 0, y: 64, z: -3 };
    this.agent = {
      agentId: init.agentId ?? 'ada',
      name: init.agentName ?? 'Ada',
      role: init.role ?? 'ceo',
      pos: home,
      hp: 20,
      maxHp: 20,
      food: 20,
      saturation: 5,
      mode: init.mode ?? 'follow',
      anchor: null,
      held: init.held ?? null,
      inventory: new Map(),
      home,
    };
    for (const [item, count] of init.inventory ?? []) this.give(normId(item), count);
    this.player = {
      name: init.playerName ?? 'Jasper',
      pos: init.playerPos ?? { x: 2, y: 64, z: -2 },
      hp: 20,
      received: new Map(),
      sheltered: false,
    };
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Blocks
  // ---------------------------------------------------------------------------------------------------------------

  /** The block at `p`: an explicit block, else the generated plain. */
  block(p: Pos): Block {
    const explicit = this.#blocks.get(posKey(p));
    if (explicit) return explicit;
    if (Math.abs(p.x) > WORLD_RADIUS || Math.abs(p.z) > WORLD_RADIUS) return AIR_BLOCK;
    if (p.y > GROUND_Y) return AIR_BLOCK;
    if (p.y === GROUND_Y) return GRASS;
    if (p.y >= GROUND_Y - 3) return DIRT;
    if (p.y <= -60) return BEDROCK;
    return STONE;
  }

  set(p: Pos, id: string, placedBy: Provenance = 'natural', structure?: string): void {
    this.#blocks.set(posKey(p), { id: normId(id), placedBy, structure });
  }

  isAir(p: Pos): boolean {
    return this.block(p).id === AIR;
  }

  /** A block can be placed here: air, or a block a placement replaces (water). */
  isReplaceable(p: Pos): boolean {
    const id = this.block(p).id;
    return id === AIR || id === 'minecraft:water';
  }

  /** Any face touches air or a non-solid block (the mod's BlockScan.exposed). */
  exposed(p: Pos): boolean {
    for (const [dx, dy, dz] of FACES) {
      const n = this.block({ x: p.x + dx, y: p.y + dy, z: p.z + dz });
      if (n.id === AIR || !blockSpec(n.id).solid) return true;
    }
    return false;
  }

  /**
   * Every non-air block within `radius` of `center` matching `pred`: explicit blocks plus the plain's surface (grass),
   * which is all a scan can see (the dirt and stone under it are never exposed).
   */
  scan(center: Pos, radius: number, pred: (id: string) => boolean): { pos: Pos; block: Block }[] {
    const out: { pos: Pos; block: Block }[] = [];
    const seen = new Set<string>();
    for (const [k, b] of this.#blocks) {
      seen.add(k);
      if (b.id === AIR || !pred(b.id)) continue;
      const pos = parseKey(k);
      if (dist(pos, center) <= radius) out.push({ pos, block: b });
    }
    if (pred(GRASS.id) || pred(DIRT.id)) {
      const r = Math.ceil(radius);
      for (let x = center.x - r; x <= center.x + r; x++) {
        for (let z = center.z - r; z <= center.z + r; z++) {
          const pos = { x, y: GROUND_Y, z };
          const k = posKey(pos);
          if (seen.has(k)) continue;
          const b = this.block(pos);
          if (b.id !== AIR && pred(b.id) && dist(pos, center) <= radius) out.push({ pos, block: b });
        }
      }
    }
    return out;
  }

  /** Removes the block (the agent broke it): recorded with its provenance. */
  breakBlock(p: Pos, skill: string): Block {
    const b = this.block(p);
    this.#blocks.set(posKey(p), AIR_BLOCK);
    this.broken.push({ pos: p, block: b, at: this.clock, skill });
    const contents = this.containers.get(posKey(p));
    if (contents) {
      // A broken chest spills: the items are gone for the scenario's purposes.
      this.containers.delete(posKey(p));
      this.log('container_broken', { pos: p, items: Object.fromEntries(contents) });
    }
    return b;
  }

  placeBlock(p: Pos, id: string): void {
    this.set(p, id, 'agent');
    this.placed.push({ pos: p, id: normId(id), at: this.clock });
  }

  isUnreachable(p: Pos): boolean {
    return this.unreachable.some((box) => inBox(p, box));
  }

  // ---------------------------------------------------------------------------------------------------------------
  // W1: zones, protection, consent (the mod's Zones, Protection and Consents)
  // ---------------------------------------------------------------------------------------------------------------

  /** The zone that contains `p`, or null. */
  zoneAt(p: Pos): Zone | null {
    return this.zones.find((z) => inBox(p, z.box)) ?? null;
  }

  /** The nearest zone to `p` (0 inside), or null when there is none. */
  nearestZone(p: Pos): Zone | null {
    let best: Zone | null = null;
    let d = Number.POSITIVE_INFINITY;
    for (const z of this.zones) {
      const dz = zoneDistance(z, p);
      if (dz < d) {
        d = dz;
        best = z;
      }
    }
    return best;
  }

  /**
   * Why the block at `p` may not be changed by the agent, or null (the mod's `Protection.check`): air, a block an agent
   * placed, a natural block outside zones (unless it is the floor under a player's roof), or a block the running job's
   * consent covers. Simplification: natural blocks that hold up a protected one sideways are not looked for.
   */
  protectedAt(p: Pos, options: { readonly ignoreGrant?: boolean } = {}): Verdict | null {
    const b = this.block(p);
    if (b.id === AIR || b.placedBy === 'agent') return null;
    const zone = this.zoneAt(p);
    let roof: Verdict | null = null;
    if (b.placedBy === 'natural' && !zone) {
      roof = this.#underRoof(p, b.id);
      if (!roof) return null;
    }
    if (!options.ignoreGrant && this.grant && inBox(p, this.grant.box)) return null;
    if (roof) return roof;
    if (b.placedBy === 'player') {
      return { pos: p, what: 'player-built', owner: this.player.name, block: b.id, zone: zone?.name ?? null };
    }
    return {
      pos: p,
      what: 'base',
      owner: zone?.owner ?? this.player.name,
      block: b.id,
      zone: zone?.name ?? 'Base',
    };
  }

  /** The mod's `Protection.underRoof`: the first solid block above, at most 6 up, is the player's. */
  #underRoof(p: Pos, id: string): Verdict | null {
    for (let dy = 1; dy <= ROOF_SCAN; dy++) {
      const q = { x: p.x, y: p.y + dy, z: p.z };
      const above = this.block(q);
      if (above.id === AIR || !blockSpec(above.id).solid) continue;
      if (above.placedBy !== 'player') return null;
      const what = `${shortId(above.id)} at ${q.x} ${q.y} ${q.z}`;
      const lead = dy === 1 ? `That holds up %s (${what})` : `That's inside %s, under its roof (${what})`;
      return { pos: p, what: 'player-built', owner: this.player.name, block: id, zone: null, lead };
    }
    return null;
  }

  /** The mod's `Protection.checkZoneCell`: a wall, roof or water placed into a zone changes it, even into air. */
  zoneCellVerdict(p: Pos): Verdict | null {
    const zone = this.zoneAt(p);
    if (!zone || (this.grant && inBox(p, this.grant.box))) return null;
    return {
      pos: p,
      what: 'base',
      owner: zone.owner ?? this.player.name,
      block: this.block(p).id,
      zone: zone.name,
      lead: 'Building there changes %s',
    };
  }

  /** A consent token for changing `positions` (the mod's `Consents.offer`: 32 hex, single use). */
  offerConsent(positions: readonly Pos[]): string | null {
    if (positions.length === 0) return null;
    const box: Box = {
      min: {
        x: Math.min(...positions.map((q) => q.x)),
        y: Math.min(...positions.map((q) => q.y)),
        z: Math.min(...positions.map((q) => q.z)),
      },
      max: {
        x: Math.max(...positions.map((q) => q.x)),
        y: Math.max(...positions.map((q) => q.y)),
        z: Math.max(...positions.map((q) => q.z)),
      },
    };
    const token = (++this.#consentSeq).toString(16).padStart(32, 'c');
    this.#consentOffers.set(token, box);
    return token;
  }

  /** Takes the box behind `token` once (the mod's `Consents.redeem`), or null for an unknown token. */
  redeemConsent(token: string): Box | null {
    const box = this.#consentOffers.get(token) ?? null;
    this.#consentOffers.delete(token);
    return box;
  }

  /**
   * Whether a roof is over `p` (the mod's heightmap test: a block above the head). `noLeaves`: leaves are no roof (the
   * People line's `MOTION_BLOCKING_NO_LEAVES`: a player under a tree is in the open).
   */
  covered(p: Pos, options: { readonly noLeaves?: boolean } = {}): boolean {
    for (let y = p.y + 1; y <= p.y + 32; y++) {
      const id = this.block({ x: p.x, y, z: p.z }).id;
      if (id === AIR || (options.noLeaves && id.endsWith('_leaves'))) continue;
      return true;
    }
    return false;
  }

  /** The footer's zone words (StatusFooter.zone): `in Base`, `12m from Base`, or null without zones. */
  zoneWords(p: Pos): string | null {
    const z = this.nearestZone(p);
    if (!z) return null;
    if (inBox(p, z.box)) return `in ${z.name}`;
    return `${Math.round(zoneHorizontalDistance(z, p))}m from ${z.name}`;
  }

  isSheltered(p: Pos): boolean {
    return this.shelters.some((box) => inBox(p, box));
  }

  /** Blocks of a structure that were broken. */
  damage(structure: string): BrokenBlock[] {
    return this.broken.filter((b) => b.block.structure === structure);
  }

  /** A standing spot next to `target`: a free neighbour column nearest to the agent, else on top of it. */
  standSpot(target: Pos): Pos {
    let best: Pos | null = null;
    for (const [dx, dz] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      for (const y of [target.y, GROUND_Y + 1]) {
        const p = { x: target.x + dx, y, z: target.z + dz };
        if (!this.isAir(p) || !this.isAir({ ...p, y: p.y + 1 })) continue;
        if (!best || dist(p, this.agent.pos) < dist(best, this.agent.pos)) best = p;
      }
    }
    return best ?? { x: target.x, y: target.y + 1, z: target.z };
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Inventory
  // ---------------------------------------------------------------------------------------------------------------

  count(pred: (id: string) => boolean): number {
    let n = 0;
    for (const [id, c] of this.agent.inventory) if (pred(id)) n += c;
    return n;
  }

  /** Inventory slots in use (stacks of 64; tools take one each). */
  slotsUsed(inv: ReadonlyMap<string, number> = this.agent.inventory): number {
    let n = 0;
    for (const [id, c] of inv) n += Math.ceil(c / maxStack(id));
    return n;
  }

  freeSlots(): number {
    return Math.max(0, 36 - this.slotsUsed());
  }

  give(id: string, count: number): void {
    if (count <= 0) return;
    const inv = this.agent.inventory;
    inv.set(id, (inv.get(id) ?? 0) + count);
  }

  /** Removes up to `count` matching items (in inventory order); returns what was taken per id. */
  take(pred: (id: string) => boolean, count: number): Map<string, number> {
    const taken = new Map<string, number>();
    let left = count;
    for (const [id, c] of [...this.agent.inventory]) {
      if (left <= 0) break;
      if (!pred(id)) continue;
      const n = Math.min(c, left);
      left -= n;
      taken.set(id, n);
      if (c - n > 0) this.agent.inventory.set(id, c - n);
      else {
        this.agent.inventory.delete(id);
        if (this.agent.held === id) this.agent.held = null;
      }
    }
    return taken;
  }

  totals(): Record<string, number> {
    return Object.fromEntries(this.agent.inventory);
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Mobs, events, time
  // ---------------------------------------------------------------------------------------------------------------

  spawnMob(type: string, pos: Pos, hp = 20, hostile = true): Mob {
    const mob: Mob = {
      id: `00000000-0000-4000-8000-${String(++this.#mobSeq).padStart(12, '0')}`,
      type: normId(type),
      pos,
      hp,
      hostile,
      alive: true,
    };
    this.mobs.push(mob);
    this.log('mob_spawned', { type: mob.type, pos });
    return mob;
  }

  schedule(at: number, label: string, fire: (world: SimWorld) => void): void {
    this.#scheduled.push({ at, label, fire });
    this.#scheduled.sort((a, b) => a.at - b.at);
  }

  log(type: string, data?: Record<string, unknown>): void {
    this.events.push({ type, at: this.clock, data });
  }

  agentEvent(type: string, data?: Record<string, unknown>): void {
    this.agentEvents.push({ type, at: this.clock, data });
  }

  isNight(t = this.clock): boolean {
    const inDay = ((t % TICKS_PER_DAY) + TICKS_PER_DAY) % TICKS_PER_DAY;
    return inDay >= 13_000 && inDay < 23_000;
  }

  /**
   * Runs the world to `toTick`: scheduled events, the 1 Hz mob tick and the current job's steps, in time order.
   * Stops early (at the tick it happened) when `until` holds.
   */
  advance(toTick: number, until?: () => boolean): void {
    let guard = 0;
    for (;;) {
      if (until?.()) return;
      if (++guard > 1_000_000) throw new Error('SimWorld.advance: runaway loop');
      const jobAt = this.current?.dueAt ?? Number.POSITIVE_INFINITY;
      const eventAt = this.#scheduled[0]?.at ?? Number.POSITIVE_INFINITY;
      const secondAt =
        this.#hasActiveMobs() || this.#idleGoal() !== null
          ? (Math.floor(this.clock / TPS) + 1) * TPS
          : Number.POSITIVE_INFINITY;
      const at = Math.min(jobAt, eventAt, secondAt);
      if (at > toTick) break;
      this.clock = Math.max(this.clock, at);
      if (eventAt <= at) {
        const e = this.#scheduled.shift() as Scheduled;
        e.fire(this);
      } else if (jobAt <= at) {
        this.#stepJob(this.current as SimJob);
      } else {
        this.#secondTick();
      }
    }
    this.clock = Math.max(this.clock, toTick);
  }

  /** Starts `logic` as the agent's job (the caller cancelled any running one). */
  startJob(jobId: string, skill: string, args: Record<string, unknown>, logic: JobLogic): SimJob {
    const job: SimJob = {
      jobId,
      skill,
      args,
      startedAt: this.clock,
      dueAt: this.clock,
      pending: null,
      status: 'running',
      result: undefined,
      error: undefined,
      endedAt: null,
      progress: null,
      text: '',
      logic,
    };
    this.jobs.set(jobId, job);
    this.current = job;
    return job;
  }

  /** Cancels the running job: its pending step never applies. */
  cancelJob(reason: string): SimJob | null {
    const job = this.current;
    if (!job) return null;
    job.pending = null;
    this.#finish(job, 'cancelled', job.result ?? {}, { code: 'INTERRUPTED', msg: reason });
    return job;
  }

  #stepJob(job: SimJob): void {
    if (job.pending) {
      const step = job.pending;
      job.pending = null;
      step.effect?.();
    }
    const next = job.logic.next();
    if ('end' in next) {
      this.#finish(job, next.end.status, next.end.result, next.end.error);
      return;
    }
    if (next.progress) {
      job.progress = next.progress[0];
      job.text = next.progress[1];
    }
    job.pending = next;
    job.dueAt = this.clock + Math.max(0, Math.round(next.dt));
  }

  #finish(
    job: SimJob,
    status: SimJob['status'],
    result: Record<string, unknown>,
    error?: { code: string; msg: string },
  ): void {
    job.status = status;
    job.result = result;
    job.error = error;
    job.endedAt = this.clock;
    if (this.current === job) this.current = null;
    this.onJobEnd?.(job);
  }

  #hasActiveMobs(): boolean {
    return this.mobs.some((m) => m.alive && m.hostile);
  }

  /**
   * The 1 Hz tick: zombies walk to the player and hurt them; the body's Protect reflex fights a zombie near the
   * player; with no job and no fight, the idle mode moves the body (follow, stay, guard), like the mod's ReflexBrain.
   */
  #secondTick(): void {
    let fought = false;
    for (const mob of this.mobs) {
      if (!mob.alive || !mob.hostile) continue;
      const target = this.player.pos;
      const d = dist(mob.pos, target);
      const agentNearPlayer = dist(this.agent.pos, this.player.pos) <= 16;
      if (agentNearPlayer && d <= 12) {
        // Protect (80) preempts the job: the body walks over and fights.
        this.#strike(mob, 'reflex:protect');
        fought = true;
        continue;
      }
      if (this.player.sheltered || this.isSheltered(this.player.pos)) continue;
      if (d > 1.5) {
        // One block a second along the longer axis.
        const dx = target.x - mob.pos.x;
        const dz = target.z - mob.pos.z;
        mob.pos =
          Math.abs(dx) >= Math.abs(dz)
            ? { ...mob.pos, x: mob.pos.x + Math.sign(dx) }
            : { ...mob.pos, z: mob.pos.z + Math.sign(dz) };
      } else {
        this.player.hp = Math.max(0, this.player.hp - 3);
        this.log('player_hurt', { by: mob.type, hp: this.player.hp });
      }
    }
    if (!fought && !this.current) this.#idleTick();
  }

  /** One second of fighting `mob` (4 damage bare-handed, 6 with a sword), standing next to it. */
  #strike(mob: Mob, by: string): void {
    mob.hp -= this.agent.held?.endsWith('_sword') ? 6 : 4;
    this.agent.pos = this.standSpot(mob.pos);
    if (mob.hp <= 0) {
      mob.alive = false;
      this.log('mob_killed', { type: mob.type, by });
      this.agentEvent('killed', { entity: mob.type });
    }
  }

  /**
   * What the idle mode wants (only without a job): follow walks back to the player once more than 4 blocks away
   * (IdleFollowReflex), stay returns to the anchor past 2 blocks, guard fights hostiles within 12 of its anchor and
   * returns past 6 (IdleModeReflex). Null: the body stands still.
   */
  #idleGoal(): { readonly goal: Pos; readonly stopAt: number } | { readonly mob: Mob } | null {
    if (this.current) return null;
    const a = this.agent;
    const anchor = a.anchor ?? a.pos;
    // Hysteresis like the mod's reflexes: start past the outer distance, keep walking until within the inner one.
    const away = (goal: Pos, start: number, keep: number) =>
      dist(a.pos, goal) > (this.#idleWalking ? keep : start);
    switch (a.mode) {
      case 'follow':
        return away(this.player.pos, FOLLOW_DISTANCE + 1, FOLLOW_DISTANCE)
          ? { goal: this.player.pos, stopAt: FOLLOW_DISTANCE }
          : null;
      case 'stay':
        return away(anchor, 2, 1) ? { goal: anchor, stopAt: 0 } : null;
      case 'guard': {
        const mob = this.mobs.find(
          (m) => m.alive && m.hostile && m.type !== `${NS}creeper` && dist(m.pos, anchor) <= GUARD_RADIUS,
        );
        if (mob) return { mob };
        return away(anchor, 6, 2) ? { goal: anchor, stopAt: 0 } : null;
      }
      default:
        return null;
    }
  }

  #idleTick(): void {
    const want = this.#idleGoal();
    this.#idleWalking = want !== null && 'goal' in want;
    if (!want) return;
    if ('mob' in want) {
      this.#strike(want.mob, 'idle:guard');
      return;
    }
    // One second of walking; the last step lands next to the player (follow) or on the anchor.
    const from = this.agent.pos;
    const d = dist(from, want.goal);
    if (d - want.stopAt <= WALK_BPS) {
      this.agent.pos = want.stopAt > 0 ? this.standSpot(want.goal) : want.goal;
      this.#idleWalking = false;
      return;
    }
    const f = WALK_BPS / d;
    this.agent.pos = {
      x: Math.round(from.x + (want.goal.x - from.x) * f),
      y: Math.round(from.y + (want.goal.y - from.y) * f),
      z: Math.round(from.z + (want.goal.z - from.z) * f),
    };
  }

  /** The mod's status footer line (the v2 mod names the zone after the position, W1). */
  footer(): string {
    const a = this.agent;
    const zone = this.mod === 'v2' ? this.zoneWords(a.pos) : null;
    const parts = [
      `HP ${Math.ceil(a.hp)}/${a.maxHp} food ${a.food}`,
      dayAndTime(this.clock),
      `${a.pos.x} ${a.pos.y} ${a.pos.z} overworld`,
      ...(zone ? [zone] : []),
      this.activity(),
    ];
    if (a.held) parts.push(shortId(a.held));
    return parts.join(' | ');
  }

  /** What the body does: the job with its progress, or the idle mode. */
  activity(): string {
    const job = this.current;
    if (job) return job.text.length > 0 ? `${job.skill} ${job.text}` : job.skill;
    return `idle (${this.agent.mode})`;
  }
}

/** Distance from `p` to the nearest block of the zone (0 inside). */
export function zoneDistance(z: Zone, p: Pos): number {
  const dx = Math.max(0, z.box.min.x - p.x, p.x - z.box.max.x);
  const dy = Math.max(0, z.box.min.y - p.y, p.y - z.box.max.y);
  const dz = Math.max(0, z.box.min.z - p.z, p.z - z.box.max.z);
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/** Horizontal distance to the zone ("12m from Base"). */
export function zoneHorizontalDistance(z: Zone, p: Pos): number {
  const dx = Math.max(0, z.box.min.x - p.x, p.x - z.box.max.x);
  const dz = Math.max(0, z.box.min.z - p.z, p.z - z.box.max.z);
  return Math.sqrt(dx * dx + dz * dz);
}

/** BoundingBox.getCenter. */
export function zoneCenter(z: Zone): Pos {
  const c = (lo: number, hi: number) => lo + Math.floor((hi - lo + 1) / 2);
  return {
    x: c(z.box.min.x, z.box.max.x),
    y: c(z.box.min.y, z.box.max.y),
    z: c(z.box.min.z, z.box.max.z),
  };
}

const FACES = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
] as const;

function parseKey(k: string): Pos {
  const [x, y, z] = k.split(',').map(Number);
  return { x: x ?? 0, y: y ?? 0, z: z ?? 0 };
}
