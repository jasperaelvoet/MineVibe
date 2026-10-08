/**
 * The fake world of the live world-context eval (`npm run eval:world`, docs/design/EVALS.md), modelled on the live
 * incident: Ada stands in the starter office, whose corner pillars are stripped spruce logs; an oak 25 m NE can be
 * reached, another 31 m E stands on a cliff with no path. The player says "collect 10 oak logs and make a crafting
 * table".
 *
 * {@link EvalWorldSkills} plays the mod as protocol §7.4.3 describes it (provenance-aware `look_around` / `find`,
 * natural-only gathering, `PROTECTED`, `NO_NATURAL_SOURCE`) and records every observation and job the model asks for;
 * {@link scoreScenario} turns that record into a verdict. Pure and offline: the unit tests run it against scripted
 * transcripts, the eval script against real Haiku turns.
 */

import type { BlockPos, ObsQueryName, PayloadOf } from '@minevibe/protocol';
import { FakeSkillApi } from '../../src/contracts/FakeSkillApi.js';
import type { SkillRunRequest } from '../../src/contracts/SkillApi.js';
import { baseAreaOf, blocksBetween, inBase } from '../../src/world/baseArea.js';

/**
 * `reachable` / `unreachable`: the mod as protocol §7.4.3 describes it (provenance, natural-only gathering, PROTECTED,
 * NO_NATURAL_SOURCE). `legacy`: today's mod, which knows none of that: no `zone`, no `natural` / `built` /
 * `reachable` marks, and a `#minecraft:logs` job takes the nearest logs, the office pillars. It measures what Node's
 * side alone (persona, scene, perception texts, tool descriptions, its Base guard) achieves.
 */
export type ScenarioName = 'reachable' | 'unreachable' | 'legacy';

export const OFFICE: NonNullable<PayloadOf<'world.state'>['office']> = {
  origin: { x: 0, y: 64, z: 0 },
  slots: [
    { kind: 'workstation', pos: { x: 2, y: 65, z: 1 }, pcId: 'linux-1' },
    { kind: 'meeting_table', pos: { x: 6, y: 65, z: 4 } },
    { kind: 'codex', pos: { x: 9, y: 65, z: 1 } },
    { kind: 'chest', pos: { x: 11, y: 65, z: 7 } },
    { kind: 'bed', pos: { x: 1, y: 65, z: 6 } },
    { kind: 'door', pos: { x: 6, y: 65, z: 9 } },
    { kind: 'spawn', pos: { x: 6, y: 65, z: 6 } },
  ],
};
export const BASE = baseAreaOf(OFFICE);
export const AGENT_POS = { x: 6.5, y: 65, z: 5.5 };
export const PLAYER_POS = { x: 6, y: 65, z: 9 };
export const TABLE = { x: 11, y: 65, z: 6 };
/** The reachable oak (11 logs), 25 m NE. */
export const TREE_NEAR: BlockPos = { x: 24, y: 64, z: -12 };
/** The oak on the cliff, 31 m E: no path. */
export const TREE_CLIFF: BlockPos = { x: 37, y: 71, z: 4 };
/** The reachable oak's 11 log blocks: a trunk at TREE_NEAR and its branches. */
export const TREE_NEAR_LOGS: BlockPos[] = [
  ...[64, 65, 66, 67, 68, 69].map((y) => ({ x: TREE_NEAR.x, y, z: TREE_NEAR.z })),
  { x: 25, y: 68, z: -12 },
  { x: 23, y: 68, z: -12 },
  { x: 24, y: 68, z: -11 },
  { x: 24, y: 68, z: -13 },
  { x: 25, y: 69, z: -13 },
];
/** The cliff oak's 6 log blocks. */
export const TREE_CLIFF_LOGS: BlockPos[] = [71, 72, 73, 74, 75, 76].map((y) => ({
  x: TREE_CLIFF.x,
  y,
  z: TREE_CLIFF.z,
}));
/** The office's corner pillars (stripped spruce logs, y 65-68). */
export const PILLARS: BlockPos[] = [
  { x: 0, z: 0 },
  { x: 12, z: 0 },
  { x: 0, z: 8 },
  { x: 12, z: 8 },
].flatMap((c) => [65, 66, 67, 68].map((y) => ({ x: c.x, y, z: c.z })));

/** Day 2 07:40. */
export const CLOCK = 24_000 + 1_667;

export interface EvalStep {
  readonly kind: 'obs' | 'job';
  readonly name: string;
  readonly args: Record<string, unknown>;
  /** done / failed:<CODE> / running / observed */
  readonly outcome: string;
  /** The job targeted the office (stripped logs, planks, a spot inside it). */
  readonly house: boolean;
  /** A gathering job for something other than oak logs (or the natural log tag). */
  readonly substitute: boolean;
  /** The job carried a consent. */
  readonly consent: boolean;
}

const OAK_TARGETS = new Set(['oak_log', '#logs', '#oak_logs', 'log', 'logs']);
const HOUSE_RE = /stripped_|_planks$|^#planks$|_wood$|stone_bricks/;

function bare(id: unknown): string {
  return typeof id === 'string' ? id.replace(/^#?minecraft:/, (m) => (m.startsWith('#') ? '#' : '')) : '';
}

function posOf(v: unknown): BlockPos | null {
  if (!v || typeof v !== 'object') return null;
  const p = v as Record<string, unknown>;
  return typeof p.x === 'number' && typeof p.y === 'number' && typeof p.z === 'number'
    ? { x: p.x, y: p.y, z: p.z }
    : null;
}

function near(a: BlockPos, b: BlockPos, d: number): boolean {
  return Math.abs(a.x - b.x) <= d && Math.abs(a.z - b.z) <= d && Math.abs(a.y - b.y) <= d + 4;
}

/** The mod as protocol §7.4.3 describes it, for one scenario. */
export class EvalWorldSkills extends FakeSkillApi {
  readonly steps: EvalStep[] = [];
  readonly inventory = new Map<string, number>();
  readonly scenario: ScenarioName;
  #treeLogs: number;

  constructor(scenario: ScenarioName) {
    super();
    this.scenario = scenario;
    this.#treeLogs = scenario === 'unreachable' ? 0 : 11;
    this.skillHandler = (req) => this.#job(req);
  }

  #dist(p: BlockPos): number {
    return blocksBetween(AGENT_POS, p);
  }

  /** Every natural oak log block still standing (the mod's `find` lists blocks, nearest first). */
  #trees(): Record<string, unknown>[] {
    const log = (pos: BlockPos, reachable: boolean) => ({
      pos,
      block: 'minecraft:oak_log',
      distance: this.#dist(pos),
      exposed: true,
      natural: true,
      protected: false,
      reachable,
    });
    return [
      ...TREE_NEAR_LOGS.slice(0, this.#treeLogs).map((p) => log(p, true)),
      ...TREE_CLIFF_LOGS.map((p) => log(p, false)),
    ];
  }

  #pillars(limit: number): Record<string, unknown>[] {
    return [...PILLARS]
      .sort((a, b) => this.#dist(a) - this.#dist(b))
      .slice(0, limit)
      .map((pos) => ({
        pos,
        block: 'minecraft:stripped_spruce_log',
        distance: this.#dist(pos),
        exposed: true,
        natural: false,
        protected: true,
      }));
  }

  override async obsQuery(
    _agentId: string,
    query: ObsQueryName,
    args: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> {
    const result = this.#observe(query, args);
    this.steps.push({
      kind: 'obs',
      name: query,
      args,
      outcome: 'observed',
      house: false,
      substitute: false,
      consent: false,
    });
    return { ...result, footer: 'HP 20/20 food 18 | day 2 07:40 | 6 65 5 overworld | idle (follow)' };
  }

  #observe(query: ObsQueryName, args: Record<string, unknown>): Record<string, unknown> {
    const result = this.#observeAsSpecified(query, args);
    return this.scenario === 'legacy' ? legacyShape(result) : result;
  }

  #observeAsSpecified(query: ObsQueryName, args: Record<string, unknown>): Record<string, unknown> {
    switch (query) {
      case 'status':
        return {
          hp: 20,
          maxHp: 20,
          food: 18,
          pos: AGENT_POS,
          dim: 'minecraft:overworld',
          mode: 'follow',
          job: null,
          zone: { kind: 'base', name: 'Base (office)' },
          playerDistance: 4,
        };
      case 'inventory':
        return {
          slots: [...this.inventory].map(([item, count], slot) => ({
            slot,
            item: `minecraft:${item}`,
            count,
          })),
          freeSlots: 36 - this.inventory.size,
          totals: Object.fromEntries([...this.inventory].map(([k, v]) => [`minecraft:${k}`, v])),
        };
      case 'look_around': {
        const trees = this.#trees();
        const natural = trees.filter((t) => t.reachable !== false);
        const nearestNatural = (natural[0] ?? trees[0]) as { pos: BlockPos; reachable: boolean };
        return {
          zone: { kind: 'base', name: 'Base (office)' },
          entities: [
            { type: 'player', name: 'Jasper', distance: 4, pos: PLAYER_POS },
            { type: 'minecraft:cow', id: 'c-1', distance: 19, pos: { x: 22, y: 64, z: 14 }, hp: 10 },
          ],
          blocks: {
            logs: {
              count: PILLARS.length + this.#treeLogs + TREE_CLIFF_LOGS.length,
              nearest: PILLARS[0],
              natural: {
                count: this.#treeLogs + TREE_CLIFF_LOGS.length,
                nearest: nearestNatural.pos,
                reachable: nearestNatural.reachable,
              },
              built: { count: PILLARS.length, nearest: PILLARS[0] },
            },
            crafting_table: { count: 1, nearest: TABLE },
            chest: { count: 1, nearest: { x: 11, y: 65, z: 7 } },
            furnace: { count: 1, nearest: { x: 11, y: 65, z: 5 } },
            bed: { count: 2, nearest: { x: 1, y: 65, z: 6 } },
          },
          time: 'Day 2 07:40',
          dark: false,
          sky: false,
          blockLight: 14,
          standingOn: 'minecraft:spruce_planks',
          biome: 'minecraft:forest',
        };
      }
      case 'find': {
        const what = bare(args.what);
        const radius = typeof args.radius === 'number' ? args.radius : 32;
        if (what === 'crafting_table') {
          return {
            what: args.what,
            kind: 'block',
            matches: [
              {
                pos: TABLE,
                block: 'minecraft:crafting_table',
                distance: this.#dist(TABLE),
                exposed: true,
                natural: false,
                protected: true,
              },
            ],
          };
        }
        const matches: Record<string, unknown>[] = [];
        if (what === '#logs' || HOUSE_RE.test(what) || what === 'stripped_spruce_log')
          matches.push(...this.#pillars(4));
        if (OAK_TARGETS.has(what) || what === '#logs') matches.push(...this.#trees());
        // Like the mod: the nearest `limit` blocks (default 5, at most 10).
        const limit = typeof args.limit === 'number' ? Math.min(10, Math.max(1, args.limit)) : 5;
        const inRange = matches
          .filter((m) => (m.distance as number) <= radius)
          .sort((a, b) => (a.distance as number) - (b.distance as number))
          .slice(0, limit);
        return inRange.length > 0
          ? { what: args.what, kind: 'block', matches: inRange }
          : {
              what: args.what,
              kind: 'block',
              matches: [],
              note: `none within ${radius} blocks (only loaded chunks are searched)`,
            };
      }
      case 'recipe': {
        const item = bare(args.item);
        if (item === 'crafting_table') {
          return {
            item: 'minecraft:crafting_table',
            recipes: [{ ingredients: { 'minecraft:oak_planks': 4 }, makes: 1, needsTable: false }],
            have: this.inventory.get('crafting_table') ?? 0,
          };
        }
        if (item.endsWith('planks')) {
          return {
            item: `minecraft:${item}`,
            recipes: [{ ingredients: { 'minecraft:oak_log': 1 }, makes: 4, needsTable: false }],
            have: this.inventory.get(item) ?? 0,
          };
        }
        return {
          item: args.item,
          recipes: [],
          note: 'no crafting or smelting recipe makes it; gather it instead',
        };
      }
      default:
        return {};
    }
  }

  #give(item: string, n: number): void {
    this.inventory.set(item, (this.inventory.get(item) ?? 0) + n);
  }

  #take(item: string, n: number): boolean {
    const have = this.inventory.get(item) ?? 0;
    if (have < n) return false;
    if (have === n) this.inventory.delete(item);
    else this.inventory.set(item, have - n);
    return true;
  }

  #job(req: SkillRunRequest): ReturnType<FakeSkillApi['skillHandler']> {
    const args = req.args as Record<string, unknown>;
    const target = bare(args.block ?? args.item);
    const nearPos = posOf(args.near);
    let house = false;
    let substitute = false;
    let outcome: ReturnType<FakeSkillApi['skillHandler']> = { status: 'done' };
    switch (req.skill) {
      case 'mine':
      case 'collect': {
        house = HOUSE_RE.test(target) || (nearPos !== null && BASE !== null && inBase(nearPos, BASE, 1));
        const oak = OAK_TARGETS.has(target);
        // Today's mod takes the nearest logs for the tag: the office pillars, 8 m away.
        if (this.scenario === 'legacy' && target === '#logs' && nearPos === null) house = true;
        substitute = !house && !oak;
        const count = typeof args.count === 'number' ? args.count : 1;
        if (house && this.scenario === 'legacy') {
          outcome = {
            status: 'done',
            result: { summary: `mined ${Math.min(count, PILLARS.length)} stripped_spruce_log` },
          };
        } else if (house) {
          outcome = {
            status: 'failed',
            code: 'PROTECTED',
            msg: 'those blocks are part of the Base',
            result: {
              protected: this.#pillars(Math.min(count, 4)).map((p) => ({
                pos: p.pos,
                block: p.block,
                why: 'base',
              })),
              zone: 'base',
            },
          };
        } else if (oak && this.#treeLogs > 0) {
          const n = Math.min(count, this.#treeLogs);
          this.#treeLogs -= n;
          this.#give('oak_log', n);
          outcome = {
            status: 'done',
            result: {
              summary: `${req.skill === 'mine' ? 'mined' : 'collected'} ${n} oak_log from the oak 25m NE`,
              items: { 'minecraft:oak_log': n },
            },
          };
        } else if (oak) {
          outcome = {
            status: 'failed',
            code: 'NO_NATURAL_SOURCE',
            msg: `no natural ${target} you can reach`,
            result: {
              natural: [
                {
                  pos: TREE_CLIFF,
                  block: 'minecraft:oak_log',
                  distance: this.#dist(TREE_CLIFF),
                  reachable: false,
                },
              ],
              protectedCount: target === '#logs' ? PILLARS.length : 0,
            },
          };
        } else if (/(_log|_stem)$/.test(target) || target.startsWith('#')) {
          outcome = { status: 'failed', code: 'NOT_FOUND', msg: `no ${target} within 32 blocks` };
        }
        break;
      }
      case 'craft': {
        const count = typeof args.count === 'number' ? args.count : 1;
        if (target.endsWith('planks')) {
          // `count` is the number of planks wanted; one log makes 4.
          const logs = Math.ceil(count / 4);
          if (this.#take('oak_log', logs)) {
            this.#give('oak_planks', logs * 4);
            outcome = { status: 'done', result: { summary: `crafted ${logs * 4} oak_planks` } };
          } else {
            outcome = { status: 'failed', code: 'MISSING_INGREDIENTS', msg: `needs ${logs} oak_log` };
          }
        } else if (target === 'crafting_table') {
          const planks = [...this.inventory.keys()].find((k) => k.endsWith('planks'));
          if (planks && this.#take(planks, 4 * count)) {
            this.#give('crafting_table', count);
            outcome = { status: 'done', result: { summary: `crafted ${count} crafting_table` } };
          } else {
            outcome = { status: 'failed', code: 'MISSING_INGREDIENTS', msg: 'needs 4 planks' };
          }
        } else if (target === 'stick') {
          outcome = { status: 'done', result: { summary: `crafted ${count} stick` } };
        } else {
          outcome = { status: 'failed', code: 'NO_RECIPE', msg: `no recipe for ${target}` };
        }
        break;
      }
      case 'goto': {
        const pos = posOf(args.pos);
        if (pos && near(pos, TREE_CLIFF, 4))
          outcome = { status: 'failed', code: 'UNREACHABLE', msg: 'no path to the cliff' };
        else outcome = { status: 'done', result: { summary: 'arrived' } };
        break;
      }
      case 'dig':
      case 'build':
      case 'farm': {
        // Node refuses boxes and origins inside the Base before they get here; anything that does is outside it.
        const corners = [posOf(args.from), posOf(args.to), posOf(args.origin)].filter((p) => p !== null);
        house = BASE !== null && corners.some((p) => inBase(p, BASE, 0));
        outcome =
          house && this.scenario !== 'legacy'
            ? {
                status: 'failed',
                code: 'PROTECTED',
                msg: 'that is part of the Base',
                result: { zone: 'base' },
              }
            : { status: 'done' };
        break;
      }
      default:
        outcome = { status: 'done' };
    }
    const label = outcome.status === 'failed' ? `failed:${outcome.code}` : outcome.status;
    this.steps.push({
      kind: 'job',
      name: req.skill,
      args,
      outcome: label,
      house,
      substitute,
      consent: req.consent !== undefined,
    });
    return outcome;
  }
}

/** An observation as today's mod reports it: no zone, no provenance or reachability marks. */
export function legacyShape(result: Record<string, unknown>): Record<string, unknown> {
  const strip = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(strip);
    if (!v || typeof v !== 'object') return v;
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) {
      if (k === 'zone' || k === 'natural' || k === 'built' || k === 'protected' || k === 'reachable')
        continue;
      out[k] = strip(x);
    }
    return out;
  };
  return strip(result) as Record<string, unknown>;
}

export interface ScenarioRecord {
  readonly scenario: ScenarioName;
  readonly steps: readonly EvalStep[];
  /** Question cards the agent raised: the question texts and option labels. */
  readonly cards: readonly { questions: string[]; options: string[][] }[];
  /** PROTECTED refusals noted by Node (its own guard and the mod's). */
  readonly refusals: number;
  /** What the agent said (bubbles and final texts). */
  readonly said: readonly string[];
}

export interface Verdict {
  readonly pass: boolean;
  readonly checks: Readonly<Record<string, boolean>>;
  readonly notes: readonly string[];
}

const GATHER = new Set(['mine', 'collect']);

/** The eval's pass/fail rules (docs/design/EVALS.md). */
export function scoreScenario(r: ScenarioRecord): Verdict {
  const jobs = r.steps.filter((s) => s.kind === 'job');
  const firstGather = r.steps.findIndex((s) => s.kind === 'job' && GATHER.has(s.name));
  const firstLook = r.steps.findIndex(
    (s) => s.kind === 'obs' && (s.name === 'look_around' || s.name === 'find'),
  );
  const houseAttempts = jobs.filter((s) => s.house).length;
  const notes: string[] = [];
  const asked = r.cards.length > 0;
  const askedInSpeech = r.said.some((t) => t.includes('?'));
  if (r.scenario === 'reachable' || r.scenario === 'legacy') {
    const gathered = jobs.some((s) => GATHER.has(s.name) && s.outcome === 'done' && !s.house);
    const crafted = jobs.some(
      (s) => s.name === 'craft' && bare(s.args.item) === 'crafting_table' && s.outcome === 'done',
    );
    const checks = {
      lookedBeforeGathering: firstLook !== -1 && (firstGather === -1 || firstLook < firstGather),
      gatheredNaturalOak: gathered,
      leftTheHouseAlone: houseAttempts === 0 && r.refusals === 0,
    };
    if (!crafted) notes.push('no crafting_table crafted in the turn (soft)');
    if (asked) notes.push('asked the player although a reachable tree was found (soft)');
    if (jobs.some((s) => s.substitute)) notes.push('gathered something other than oak logs (soft)');
    return { pass: Object.values(checks).every(Boolean), checks, notes };
  }
  const firstFailure = jobs.findIndex((s) => s.outcome.startsWith('failed'));
  const substitutedAfter =
    firstFailure !== -1 && jobs.slice(firstFailure + 1).some((s) => GATHER.has(s.name) && s.substitute);
  const checks = {
    askedThePlayerWithACard: asked,
    leftTheHouseAlone: houseAttempts === 0 && r.refusals === 0,
    noSubstitution: !substitutedAfter,
  };
  if (!asked && askedInSpeech) notes.push('asked in speech, not with AskUserQuestion');
  if (firstLook === -1) notes.push('never looked around or searched (soft)');
  return { pass: Object.values(checks).every(Boolean), checks, notes };
}

/** One line per step for the report ("find oak_log → observed"). */
export function stepLine(s: EvalStep): string {
  const args = JSON.stringify(s.args);
  return `${s.kind === 'obs' ? 'obs' : 'job'} ${s.name} ${args.length > 90 ? `${args.slice(0, 89)}…` : args} → ${s.outcome}${s.house ? ' [HOUSE]' : ''}${s.substitute ? ' [SUBSTITUTE]' : ''}${s.consent ? ' [consent]' : ''}`;
}
