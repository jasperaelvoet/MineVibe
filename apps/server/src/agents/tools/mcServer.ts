/**
 * The `mc` MCP tool server (PLAN §7.4): every `mcp__mc__*` tool. World jobs and observations go to the mod through
 * the SkillApi; Codex, calendar and task reports go to the OrgApi; social and seat tools go to the agent's host (the
 * AgentManager). Long jobs wait `wait_s` (default 20) and then answer `running` with a `job_id`; the agent is woken by
 * `[JOB DONE]` later. Every result ends with a short status footer.
 *
 * Gate rules (who may call what, when) live in the ToolGate; handlers still fail closed where it matters.
 */

import {
  createSdkMcpServer,
  type McpSdkServerConfigWithInstance,
  type SdkMcpToolDefinition,
  tool,
} from '@anthropic-ai/claude-agent-sdk';
import {
  AgentRole,
  Assignees,
  BlockPos,
  CalendarClock,
  CalendarKind,
  CodexCategory,
  CodexScope,
  CodexTag,
  CodexWriteMode,
  EntityRef,
  IdleMode,
  type Place,
  SkillArgs,
  type SkillConsent,
  type SkillName,
} from '@minevibe/protocol';
import { z } from 'zod';
import type { Actor } from '../../contracts/common.js';
import { ApiError, isApiError } from '../../contracts/common.js';
import type { OrgApi, OrgToolResult } from '../../contracts/OrgApi.js';
import type { SkillApi } from '../../contracts/SkillApi.js';
import { DEFAULT_WAIT_S, MAX_WAIT_S, MCP_TOOL_TIMEOUT_MS } from '../constants.js';
import { summarizeResult } from '../EventRouter.js';
import { baseConflict, failureText, PROTECTED, type Refusal } from '../world/guard.js';
import { type PerceptionContext, perceiveFind, perceiveLookAround } from '../world/perception.js';
import type { TreeSighting } from '../world/scene.js';
import { MC_TOOLS, type McToolName } from './catalog.js';
import {
  type CallToolResult,
  compactJson,
  errorFrom,
  errorResult,
  textResult,
  waitMs,
  withFooter,
} from './results.js';

/** What the `mc` tools need from the agent runtime, per agent. */
export interface McHost {
  readonly agentId: string;
  readonly skills: SkillApi;
  readonly org: OrgApi;
  actor(): Actor;
  playerName(): string;
  /** The ~25-token status footer, or null when no body snapshot is known yet. */
  footer(): string | null;
  /** The agent's current position (for `here` and `when:"now"`). */
  here(): Place | null;
  /** The overworld clock in ticks, or null when unknown. */
  clockTime(): number | null;
  /** A job returned `running`: wake the agent with [JOB DONE] when it ends. */
  trackJob(jobId: string, label: string): void;
  say(text: string): void;
  tell(to: string, text: string): Promise<string>;
  remember(note: string): Promise<string>;
  requestHire(request: {
    role: AgentRole;
    name?: string | undefined;
    reason: string;
    firstTask: string;
  }): Promise<string>;
  sitAtPc(request: { pcId: string; purpose: string; waitMs: number }): Promise<string>;
  standUp(): Promise<string>;
  /** Waits up to `ms`; resolves early when job `jobId` ends. */
  wait(ms: number, jobId?: string): Promise<string>;
  /** A task report was filed (wakes the CEO for failed/blocked). */
  taskReported(report: {
    eventId: string;
    status: 'done' | 'failed' | 'blocked';
    note?: string | undefined;
  }): void;
  /**
   * What the perception texts need: the agent's position, the Base and its zone (protocol §7.4.3). Absent: the raw
   * look_around / find results are formatted without them.
   */
  world?(): PerceptionContext;
  /** look_around / find showed natural trees (for the scene line). */
  noteTrees?(sighting: TreeSighting): void;
  /**
   * The player's consent to change protected blocks for this agent, if one is valid (protocol §7.4.3). Only Node mints
   * it; it is attached to world jobs and never read from tool arguments.
   */
  consent?(): SkillConsent | null;
  /** Node refused a job itself (`PROTECTED`, the Base): the refusal the player may still allow. */
  noteRefusal?(refusal: Refusal): void;
}

/** Skills whose jobs may break or replace blocks: they carry the agent's consent, when there is one. */
export const BLOCK_CHANGING_SKILLS: ReadonlySet<SkillName> = new Set([
  'mine',
  'collect',
  'dig',
  'place',
  'build',
  'farm',
  'use_item',
]);

// biome-ignore lint/suspicious/noExplicitAny: the server holds tools of many different input shapes
type Def = SdkMcpToolDefinition<any>;

const WaitS = z
  .number()
  .min(0)
  .max(MAX_WAIT_S)
  .optional()
  .describe(`Seconds to wait for the job before it reports "running" (default ${DEFAULT_WAIT_S}).`);

/** Skill tools: name → description. Input schemas come from the protocol's `SkillArgs`. */
const SKILL_TOOLS: Readonly<Record<Exclude<SkillName, 'goto'>, string>> = {
  mine: 'Break blocks of one kind nearby (24 blocks around you, or around near) and keep the drops. Name the exact natural block you were asked for ("oak_log"): a #tag means any of its kinds, which is a substitution, and building blocks (planks, stripped logs, bricks, glass) are never gathered. Never the Base (the office, the player\'s home) or anything a player built: that fails PROTECTED, a hard stop (never retry). NO_NATURAL_SOURCE: nothing natural in reach; tell the player and ask, never substitute. Examples: {block:"oak_log", count:10}; {block:"oak_log", count:10, near:{x:130,y:64,z:-20}} for the tree find showed. A job.',
  collect:
    'Get count of an item: picks up dropped ones, then breaks blocks that drop it (stone → cobblestone, ores → raw metal). For natural things only: never ask it for building blocks (planks, glass, bricks) or furniture (crafting_table, chest); craft those. Same rules as mine: never blocks of the Base or anything a player built (PROTECTED), and NO_NATURAL_SOURCE when nothing natural is in reach (ask the player, don\'t substitute). Example: {item:"oak_log", count:10}. A job.',
  hunt: 'Hunt mobs of a kind (e.g. "minecraft:cow"), count of them. A job.',
  dig: 'Dig out every block in the box from..to (inclusive): a tunnel, a cellar, a path. A box that holds protected blocks (the Base, anything a player built) fails PROTECTED before anything breaks: pick a box outside them. Example: {from:{x:100,y:60,z:-20}, to:{x:102,y:62,z:-10}}. A job.',
  place:
    'Place one block from your inventory at pos (an empty or replaceable spot). Never replaces a protected block (PROTECTED). Example: {block:"torch", pos:{x:12,y:65,z:-28}}.',
  use_block: 'Use (right-click) the block at pos: doors, levers, beds, chests.',
  use_item: 'Use your held item, or the given item, optionally on a block or entity.',
  attack: 'Attack an entity until it dies or flees. A job.',
  equip: 'Equip an item into a slot (default main hand).',
  eat: 'Eat food now (the given item, or the best food you have).',
  sleep: 'Sleep in a bed (nearest, or at pos) when it is night.',
  pickup: 'Pick up dropped items nearby.',
  drop: 'Drop items from your inventory.',
  give: 'Give items to an entity (the player is "player", agents by id). Walks over first. A job.',
  craft:
    'Craft count of an item with a real crafting menu (uses a table nearby or at table when needed). A job.',
  smelt: 'Smelt count of an item in a furnace (nearest, or at furnace). A job.',
  container: 'List, put into or take from a container block at pos.',
  open_menu:
    'Open the menu of a block or entity (villager trading, enchanting, anvil, …). Then use menu_state and menu_click.',
  menu_click: 'Click a slot of the open menu: {slot, button, type}.',
  menu_close: 'Close the open menu.',
  build:
    'Build a built-in blueprint at origin: shelter, wall_ring, torch_ring, bridge, stairs_down or farm_plot. Pick open ground outside the Base: a build that would replace protected blocks fails PROTECTED. Example: {blueprint:"shelter", origin:{x:140,y:64,z:-30}}. A job.',
  farm: 'Till, plant and harvest the farmland in the box from..to. A job.',
  ride: 'Ride an entity (boat, minecart, horse). Not office chairs: use sit_at_pc.',
  dismount: 'Get off what you ride.',
  emote: 'Play an emote: wave, nod, shake_head, point, cheer, facepalm.',
};

/** Observation tools → `obs.query` with these input shapes. */
const OBS_TOOLS = {
  status: { desc: 'Your body: health, food, position, held item, current job, mode.', shape: {} },
  look_around: {
    desc: 'The scene around you: where you are (in the Base, the player\'s home, or outside), natural resources with distance and direction ("logs ×12 nearest 25m NE"), PROTECTED blocks (the Base, anything the player built: never break), things to use, people, mobs and items. Call it before multi-step gathering. Example: {} or {radius:32}.',
    shape: { radius: z.number().int().min(1).max(64).optional() },
  },
  inventory: { desc: 'Your inventory and equipment.', shape: {} },
  find: {
    desc: 'Find the nearest blocks, mobs or items of a kind. Each block says its distance and direction and whether it is natural (fine to gather), PROTECTED (part of the Base or built by the player: never break) or UNREACHABLE. Examples: {what:"oak_log"}; {what:"oak_log", radius:64} to look further; {what:"minecraft:cow"}.',
    shape: { what: z.string().min(1).max(128), radius: z.number().int().min(1).max(128).optional() },
  },
  recipe: { desc: 'How to craft or smelt an item.', shape: { item: z.string().min(1).max(128) } },
  recent_events: {
    desc: 'What happened to you recently (reflexes, pickups, damage).',
    shape: { limit: z.number().int().min(1).max(50).optional() },
  },
  crew: { desc: 'Where the crew and the player are and what they do.', shape: {} },
  list_pcs: { desc: 'The office PCs: id, type, status, who sits there.', shape: {} },
  job_status: {
    desc: 'Status of a job (your current one when job_id is absent).',
    shape: { job_id: z.string().min(1).max(64).optional() },
  },
  menu_state: { desc: 'The open menu: slots and their items.', shape: {} },
} as const satisfies Record<string, { desc: string; shape: z.ZodRawShape }>;

const READ_ONLY = { annotations: { readOnlyHint: true } } as const;

// The game-clock helpers moved to contracts/orgTools.ts (the fake OrgApi formats with them); re-exported here.
export { gameTimeToTicks, parseWhen, ticksToGameTime } from '../../contracts/orgTools.js';

/** An org tool's result (the exact text the org services made) as a tool result. */
function orgResult(result: OrgToolResult): CallToolResult {
  return result.ok ? textResult(result.text) : errorResult(result.text);
}

/**
 * Splits the mod's status `footer` off a skill or observation result (protocol §7.3): the rest is the result the
 * agent reads, the footer becomes the tool result's last line.
 */
export function splitFooter(result: Record<string, unknown> | undefined): {
  result: Record<string, unknown> | undefined;
  footer: string | null;
} {
  if (!result || typeof result.footer !== 'string') return { result, footer: null };
  const { footer, ...rest } = result;
  return { result: rest, footer: footer.trim().length > 0 ? footer.trim() : null };
}

/** Builds the `mc` tool definitions of one agent. */
export function mcToolDefinitions(host: McHost): Def[] {
  const defs: Def[] = [];
  /** Adds definitions of any input shape (their handler argument types differ). */
  const push = (...ds: unknown[]) => {
    defs.push(...(ds as Def[]));
  };
  /**
   * The mod's footer of a result that came from the mod (protocol §7.3: the source of the footer). `run` appends it,
   * or Node's own line from `agent.state` for results that never reached the mod, so a result never gets two.
   */
  const modFooters = new WeakMap<CallToolResult, string>();
  const fromMod = (result: CallToolResult, footer: string | null): CallToolResult => {
    if (footer) modFooters.set(result, footer);
    return result;
  };
  const run = async (fn: () => Promise<CallToolResult>): Promise<CallToolResult> => {
    let result: CallToolResult;
    try {
      result = await fn();
    } catch (err) {
      result = errorFrom(err);
    }
    return withFooter(result, modFooters.get(result) ?? host.footer());
  };

  const runJob = async (skill: SkillName, args: Record<string, unknown>, waitS: unknown, label: string) => {
    // Consent is Node's alone (protocol §7.4.3): whatever the model put in the arguments never reaches the mod.
    const { consent: _forged, consentId: _forgedId, ...cleanArgs } = args;
    const consent = BLOCK_CHANGING_SKILLS.has(skill) ? (host.consent?.() ?? null) : null;
    // Jobs that would reach the Base never get to the mod without the player's consent (world/guard.ts).
    const world = consent ? null : (host.world?.() ?? null);
    const conflict = world
      ? baseConflict(skill, cleanArgs, world.base, {
          here: world.here,
          // A mod that reports zones guards provenance itself (protocol §7.4.3); today's mod reports none.
          modGuards: world.zone !== null && world.zone !== undefined,
          playerName: host.playerName(),
        })
      : null;
    if (conflict) {
      host.noteRefusal?.(conflict.refusal);
      return errorResult(
        conflict.advice
          ? `Failed: ${label}. ${PROTECTED}: ${conflict.msg}. ${conflict.advice}`
          : `Failed: ${label}. ${failureText({
              label,
              skill,
              code: PROTECTED,
              msg: conflict.msg,
              result: { zone: conflict.refusal.zone },
              playerName: host.playerName(),
            })}`,
      );
    }
    const res = await host.skills.runSkill({
      agentId: host.agentId,
      skill,
      args: cleanArgs as never,
      waitMs: waitMs(waitS, DEFAULT_WAIT_S, MAX_WAIT_S),
      replace: skill !== 'emote',
      ...(consent ? { consent } : {}),
    });
    const { result, footer } = splitFooter(res.result);
    switch (res.status) {
      case 'running':
        host.trackJob(res.jobId, label);
        return fromMod(
          textResult(
            `Job ${res.jobId} (${label}) is running. You'll get [JOB DONE] when it ends: end your turn now.`,
          ),
          footer,
        );
      case 'done':
        return fromMod(textResult(`Done: ${label}. ${summarizeResult(result)}`), footer);
      case 'cancelled':
        return fromMod(errorResult(`Cancelled: ${label}.`), footer);
      default:
        return fromMod(
          errorResult(
            `Failed: ${label}. ${failureText({
              label,
              skill,
              code: res.error?.code ?? 'FAILED',
              msg: res.error?.msg ?? 'failed',
              result,
              playerName: host.playerName(),
            })}`,
          ),
          footer,
        );
    }
  };

  // --- Observe -------------------------------------------------------------------------------------------------
  for (const [name, spec] of Object.entries(OBS_TOOLS)) {
    push(
      tool(
        name,
        spec.desc,
        spec.shape,
        (args) =>
          run(async () => {
            const query = name as keyof typeof OBS_TOOLS;
            const queryArgs: Record<string, unknown> = { ...(args as Record<string, unknown>) };
            if (typeof queryArgs.job_id === 'string') {
              queryArgs.jobId = queryArgs.job_id;
              delete queryArgs.job_id;
            }
            const { result, footer } = splitFooter(
              await host.skills.obsQuery(host.agentId, query, queryArgs),
            );
            if ((query === 'look_around' || query === 'find') && result) {
              const ctx = host.world?.() ?? { here: null, base: null, playerName: host.playerName() };
              const seen = query === 'find' ? perceiveFind(result, ctx) : perceiveLookAround(result, ctx);
              if (seen.trees) host.noteTrees?.(seen.trees);
              return fromMod(textResult(seen.text), footer);
            }
            return fromMod(textResult(compactJson(result ?? {})), footer);
          }),
        READ_ONLY,
      ),
    );
  }

  // --- Behaviour -----------------------------------------------------------------------------------------------
  push(
    tool(
      'set_mode',
      'Set your idle behaviour between jobs: follow (the player), stay, guard (an area) or wander.',
      { mode: IdleMode, anchor: BlockPos.optional() },
      (args) =>
        run(async () => {
          await host.skills.setMode(host.agentId, args.mode, args.anchor);
          return textResult(`Idle mode: ${args.mode}.`);
        }),
    ),
    tool('stop', 'Stop your current job.', {}, () =>
      run(async () => {
        const cancelled = await host.skills.cancelSkill(host.agentId, { reason: 'stop' });
        return textResult(cancelled.length > 0 ? `Stopped ${cancelled.join(', ')}.` : 'No job was running.');
      }),
    ),
  );

  // --- Move ----------------------------------------------------------------------------------------------------
  push(
    tool(
      'goto',
      'Walk to a block position {pos}, an entity {entity: "player" | agent id | mob type}, or a named Codex place {place}. A job.',
      {
        pos: BlockPos.optional(),
        entity: EntityRef.optional(),
        place: z.string().min(1).max(80).optional().describe('A Codex `places` page id or title.'),
        range: z.number().min(0).max(64).optional(),
        wait_s: WaitS,
      },
      (args) =>
        run(async () => {
          const given = [args.pos, args.entity, args.place].filter((v) => v !== undefined).length;
          if (given !== 1) return errorResult('Give exactly one of pos, entity or place.');
          let pos = args.pos;
          if (args.place !== undefined) {
            pos = await resolvePlace(host, args.place);
          }
          const skillArgs: Record<string, unknown> = {};
          if (pos) skillArgs.pos = pos;
          if (args.entity) skillArgs.entity = args.entity;
          if (args.range !== undefined) skillArgs.range = args.range;
          const label = args.place
            ? `goto ${args.place}`
            : args.entity
              ? `goto ${args.entity}`
              : `goto ${pos?.x},${pos?.y},${pos?.z}`;
          return runJob('goto', skillArgs, args.wait_s, label);
        }),
    ),
  );

  // --- World, craft, menus, build, ride, emote (skill jobs) ------------------------------------------------------
  for (const [skill, desc] of Object.entries(SKILL_TOOLS) as [Exclude<SkillName, 'goto'>, string][]) {
    const base = (SkillArgs[skill] as unknown as z.ZodObject<z.ZodRawShape>).shape;
    push(
      tool(skill, desc, { ...base, wait_s: WaitS }, (args) =>
        run(async () => {
          const { wait_s: w, ...skillArgs } = args as Record<string, unknown>;
          return runJob(skill, skillArgs, w, labelOf(skill, skillArgs));
        }),
      ),
    );
  }

  // --- PC ------------------------------------------------------------------------------------------------------
  push(
    tool(
      'sit_at_pc',
      'Walk to a PC and sit down to work on it (shell, files, screen). Say what for in purpose. When it says "Seated", end your turn: your PC session starts next turn.',
      {
        pc: z.string().min(1).max(64).describe('PC id, e.g. "linux-1" (see mcp__mc__list_pcs).'),
        purpose: z
          .string()
          .min(1)
          .max(200)
          .describe('The task, shown on the monitor ("fix the failing test").'),
        wait_s: WaitS,
      },
      (args) =>
        run(async () =>
          textResult(
            await host.sitAtPc({
              pcId: args.pc,
              purpose: args.purpose,
              waitMs: waitMs(args.wait_s, 60, MAX_WAIT_S),
            }),
          ),
        ),
    ),
    tool('stand_up', 'Stand up from your PC (or leave the chair you walk to).', {}, () =>
      run(async () => textResult(await host.standUp())),
    ),
  );

  // --- Social --------------------------------------------------------------------------------------------------
  push(
    tool(
      'say',
      'Say something out loud now (a bubble above your head), without ending your turn.',
      { text: z.string().min(1).max(500) },
      (args) =>
        run(async () => {
          host.say(args.text);
          return textResult('Said.');
        }),
    ),
    tool(
      'tell',
      'Send a short message to one crew member (by @handle, name or "ceo"). It reaches only them.',
      { to: z.string().min(1).max(64), text: z.string().min(1).max(2000) },
      (args) => run(async () => textResult(await host.tell(args.to, args.text))),
    ),
    tool(
      'remember',
      'Write a note to your private long-term memory (memory.md). Keep it short; it is re-read after restarts.',
      { note: z.string().min(1).max(600) },
      (args) => run(async () => textResult(await host.remember(args.note))),
    ),
    tool(
      'wait',
      'Wait a while (at most 120 s), or until a job ends. Prefer ending your turn for long waits.',
      { seconds: z.number().min(1).max(MAX_WAIT_S), job_id: z.string().min(1).max(64).optional() },
      (args) => run(async () => textResult(await host.wait(Math.round(args.seconds * 1000), args.job_id))),
    ),
    tool(
      'request_hire',
      'CEO only: ask the player to hire a new crew member. Returns at once; you get [HIRE DECISION] later.',
      {
        role: AgentRole.exclude(['ceo']),
        name: z.string().min(1).max(24).optional(),
        reason: z.string().min(1).max(500),
        first_task: z.string().min(1).max(2000),
      },
      (args) =>
        run(async () =>
          textResult(
            await host.requestHire({
              role: args.role,
              name: args.name,
              reason: args.reason,
              firstTask: args.first_task,
            }),
          ),
        ),
    ),
  );

  // --- Codex ---------------------------------------------------------------------------------------------------
  push(
    tool(
      'codex_search',
      'Search the shared Codex (notes written by the crew and the player). Returns the top 8 snippets.',
      {
        query: z.string().min(1).max(200),
        tags: z.array(CodexTag).max(8).optional(),
        category: CodexCategory.optional(),
      },
      (args) => run(async () => orgResult(await host.org.tools.codexSearch(host.agentId, args))),
      READ_ONLY,
    ),
    tool(
      'codex_read',
      'Read one Codex page with its revision (pass it as base_rev to update).',
      { id: z.string().min(1).max(80) },
      (args) => run(async () => orgResult(await host.org.tools.codexRead(host.agentId, args))),
      READ_ONLY,
    ),
    tool(
      'codex_write',
      'Write to the shared Codex: mode create (new page), update (replace body; needs id and base_rev) or append (add to the end; needs id). Set here:true on a places page to stamp your position.',
      {
        mode: CodexWriteMode,
        title: z.string().min(1).max(80),
        body: z.string().min(1).max(8192),
        tags: z.array(CodexTag).max(16).optional(),
        category: CodexCategory.exclude(['rules']),
        scope: CodexScope,
        id: z.string().min(1).max(80).optional(),
        base_rev: z.string().min(7).max(64).optional(),
        here: z.boolean().optional(),
      },
      (args) => run(async () => orgResult(await host.org.tools.codexWrite(host.agentId, args))),
    ),
    tool(
      'codex_list',
      'List Codex pages, optionally by category or tag.',
      { category: CodexCategory.optional(), tag: CodexTag.optional() },
      (args) => run(async () => orgResult(await host.org.tools.codexList(host.agentId, args))),
      READ_ONLY,
    ),
  );

  // --- Calendar ------------------------------------------------------------------------------------------------
  const Recurrence = z.object({
    kind: z.enum(['once', 'daily', 'every_n_days', 'weekdays']),
    n: z.number().int().min(2).max(365).optional(),
  });
  push(
    tool(
      'calendar_list',
      'List calendar events (tasks, reminders, meetings), optionally for one agent.',
      {
        from: z.number().min(0).optional(),
        to: z.number().min(0).optional(),
        agent: z.string().min(1).max(64).optional(),
      },
      (args) => run(async () => orgResult(await host.org.tools.calendarList(host.agentId, args))),
      READ_ONLY,
    ),
    tool(
      'calendar_add',
      'Schedule a task, reminder or meeting. when: "now", "Day 3 06:00" (game clock) or an ISO date (real clock). assignees: agent ids or "all" (only the CEO schedules for others).',
      {
        title: z.string().min(1).max(80),
        kind: CalendarKind,
        assignees: Assignees,
        clock: CalendarClock,
        when: z.union([z.string().min(1).max(64), z.number().min(0)]),
        recurrence: Recurrence.optional(),
        duration_min: z.number().int().min(1).max(1440).optional(),
        location: z.string().min(1).max(80).optional(),
        task: z.string().min(1).max(2000).optional(),
        catch_up: z.enum(['skip', 'once_late']).optional(),
        run_while_away: z.boolean().optional(),
      },
      (args) => run(async () => orgResult(await host.org.tools.calendarAdd(host.agentId, args))),
    ),
    tool(
      'calendar_update',
      'Change an event you may edit (not events the player created).',
      {
        id: z.string().min(1).max(64),
        title: z.string().min(1).max(80).optional(),
        assignees: Assignees.optional(),
        when: z.union([z.string().min(1).max(64), z.number().min(0)]).optional(),
        clock: CalendarClock.optional(),
        recurrence: Recurrence.optional(),
        duration_min: z.number().int().min(1).max(1440).optional(),
        location: z.string().min(1).max(80).optional(),
        task: z.string().min(1).max(2000).optional(),
      },
      (args) => run(async () => orgResult(await host.org.tools.calendarUpdate(host.agentId, args))),
    ),
    tool(
      'calendar_cancel',
      'Cancel an event (scope "all") or only its next occurrence ("next").',
      { id: z.string().min(1).max(64), scope: z.enum(['next', 'all']).optional() },
      (args) => run(async () => orgResult(await host.org.tools.calendarCancel(host.agentId, args))),
    ),
    tool(
      'report_task',
      'Close a scheduled task occurrence: done, failed or blocked (failed and blocked wake the CEO).',
      {
        event_id: z.string().min(1).max(64),
        status: z.enum(['done', 'failed', 'blocked']),
        note: z.string().min(1).max(500).optional(),
      },
      (args) =>
        run(async () => {
          const result = await host.org.tools.reportTask(host.agentId, args);
          if (result.ok) host.taskReported({ eventId: args.event_id, status: args.status, note: args.note });
          return orgResult(result);
        }),
    ),
  );

  return defs;
}

function labelOf(skill: SkillName, args: Record<string, unknown>): string {
  const what = args.block ?? args.item ?? args.entity ?? args.blueprint ?? args.kind ?? args.crop;
  const count = typeof args.count === 'number' ? ` ×${args.count}` : '';
  return what !== undefined ? `${skill} ${String(what)}${count}` : skill;
}

const COORD_RE = /(-?\d{1,8})\s*[, ]\s*(-?\d{1,4})\s*[, ]\s*(-?\d{1,8})/;

/** A Codex `places` page → its coordinates (the first `x, y, z` triple in the body). */
async function resolvePlace(host: McHost, place: string): Promise<{ x: number; y: number; z: number }> {
  const actor = host.actor();
  let page: Awaited<ReturnType<OrgApi['codex']['read']>> | null = null;
  try {
    page = await host.org.codex.read(actor, place);
  } catch (err) {
    if (!isApiError(err, 'CODEX_NOT_FOUND')) throw err;
  }
  if (!page) {
    const hits = await host.org.codex.search(actor, { query: place, category: 'places', limit: 1 });
    const hit = hits[0];
    if (!hit) throw new ApiError('UNKNOWN_PLACE', `no Codex place called "${place}"`);
    page = await host.org.codex.read(actor, hit.id);
  }
  const m = COORD_RE.exec(page.body);
  if (!m) throw new ApiError('UNKNOWN_PLACE', `the page "${page.title}" has no coordinates`);
  return { x: Number(m[1]), y: Number(m[2]), z: Number(m[3]) };
}

/** The in-process `mc` server (never swapped; `alwaysLoad`, 600 s tool timeout). */
export function createMcServer(host: McHost): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: 'mc',
    version: '1.0.0',
    alwaysLoad: true,
    timeout: MCP_TOOL_TIMEOUT_MS,
    tools: mcToolDefinitions(host),
  });
}

/** Every mc tool name the server defines (tests compare it with the catalog). */
export function mcToolNames(defs: readonly { name: string }[]): McToolName[] {
  return defs.map((d) => d.name).filter((n): n is McToolName => Object.hasOwn(MC_TOOLS, n));
}
