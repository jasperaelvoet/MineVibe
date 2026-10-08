/**
 * The v2 `mc` tools (docs/design/tools-v2-mc.md): 20 tools instead of 54. One tool per intent (`gather`, `craft`,
 * `do`, `observe`), low-level operations folded into action enums (`use`, `items`, `build`, `menu`, `job`, `codex`,
 * `calendar`), positions as `"x y z"` strings, no `wait_s` (every world tool answers within {@link ACTION_WAIT_S}),
 * compact text results with a `next:` hint (tools/format.ts), and descriptions that say when to use each tool.
 *
 * World calls go through one table (tools/translate.ts) to the same wire skills as v1, plus the additive ones the mod
 * announces in `hello.caps` (`sequence`, `collect{near, make_tools}`, `craft{tree, gather_missing}`, ...). Safety
 * stays where it was: the world guard (world/guard.ts) refuses Base-reaching calls before the mod sees them, the mod
 * refuses protected blocks (W1), and the player's consent is attached by Node, never taken from tool arguments.
 */

import { type SdkMcpToolDefinition, tool } from '@anthropic-ai/claude-agent-sdk';
import {
  AgentRole,
  type BlockPos,
  CodexCategory,
  CodexScope,
  CodexTag,
  IdleMode,
  MOD_CAPS,
  type ObsQueryName,
  type SkillConsent,
} from '@minevibe/protocol';
import { z } from 'zod';
import { isApiError } from '../../contracts/common.js';
import type { OrgToolResult } from '../../contracts/OrgApi.js';
import { newJobId } from '../../contracts/SkillApi.js';
import { inBase } from '../../world/baseArea.js';
import { ACTION_WAIT_S, JOB_WAIT_DEFAULT_S, MAX_WAIT_S, SIT_WAIT_S } from '../constants.js';
import { singleLine } from '../envelope.js';
import { baseConflict, PROTECTED } from '../world/guard.js';
import { perceiveLookAround } from '../world/perception.js';
import {
  arr,
  asPos,
  call,
  compose,
  type Detail,
  footerLine,
  hintFor,
  idText,
  itemList,
  type JobMeta,
  nextLine,
  num,
  obj,
  posText,
  type Rendered,
  type RenderContext,
  renderCrew,
  renderEvents,
  renderFind,
  renderInventory,
  renderJobStatus,
  renderMenu,
  renderOutcome,
  renderPcs,
  renderRunning,
  renderScene,
  renderStatus,
  short,
} from './format.js';
import { CONSENT_SKILLS_V2, type McHost, resolveCodexPlace, splitFooter } from './host.js';
import { type CallToolResult, errorResult, textResult } from './results.js';
import { parsePos, requirePos } from './targets.js';
import {
  badArgs,
  CRAFT_EXAMPLE,
  DO_EXAMPLE,
  STEP_TOOLS,
  type TranslateHost,
  translateBuild,
  translateCraft,
  translateGather,
  translateGoto,
  translateItems,
  translateMenu,
  translateStep,
  translateUse,
  type WireCall,
} from './translate.js';

// biome-ignore lint/suspicious/noExplicitAny: the server holds tools of many different input shapes
type Def = SdkMcpToolDefinition<any>;

/** The v2 tool names (§3), in list order. */
export const MC_V2_TOOL_NAMES = [
  'observe',
  'find',
  'goto',
  'gather',
  'craft',
  'build',
  'use',
  'items',
  'menu',
  'do',
  'job',
  'set_mode',
  'say',
  'tell',
  'remember',
  'sit_at_pc',
  'stand_up',
  'request_hire',
  'codex',
  'calendar',
] as const;
export type McV2ToolName = (typeof MC_V2_TOOL_NAMES)[number];

/** Tools that could be deferred behind tool search once that is verified for Haiku (§13 phase C). */
export const MC_V2_DEFERRABLE: ReadonlySet<McV2ToolName> = new Set(['menu', 'codex', 'calendar', 'request_hire']);

/** The tool descriptions (§5), verbatim: when to use the tool, and one example. */
export const MC_V2_DESCRIPTIONS: Readonly<Record<McV2ToolName, string>> = {
  observe:
    'See yourself and the world in one call: use it before multi-step work and whenever you are unsure where you are or what is around. Read-only, safe in parallel. sections (default status+scene): status = body, place, zone, job, held item; scene = zone (Base, player builds), natural resources with direction, distance and reachability, stations, hazards, mobs, players; inventory; crew = crew and player, where and doing what; jobs = current and recent jobs; events = what happened to you lately; pcs = office PCs and who sits there; menu = the open menu\'s slots and buttons.\nExample: {"sections":["scene","inventory"]}',
  find: 'Find the nearest blocks, mobs or dropped items of one kind, with distance, direction, reachability and natural vs player-built. Read-only. Use it to pick a spot or to check that something exists; gather and craft find their own sources.\nExample: {"target":"iron_ore"}',
  goto: 'Walk somewhere. to: "x y z", "player", a crew @handle, a mob type, or a place: office, home, spawn, bed, chest, crafting_table, furnace, codex, pc:<id>, or a Codex places page title. A job.\nExample: {"to":"crafting_table"}',
  gather:
    'Use for any "get / collect / mine / chop N of X" request. Gets count of an item into your inventory end to end: picks up loose drops, harvests NATURAL sources (whole tree trunks, natural stone and ores, animals for meat, leather, wool), takes or makes the right tool, and collects the drops. Never breaks player-built blocks or the Base; #logs means natural logs only. When nothing natural is reachable it fails with NO_NATURAL_SOURCE: then ask the player, never substitute. A job.\nExample: {"item":"oak_log","count":10}',
  craft:
    'Use for any "make / craft / smelt X" request. Makes count of an item and resolves the whole recipe tree: crafts intermediates (logs to planks to sticks), smelts in a furnace when needed, and uses a nearby crafting table or furnace, or places one (crafting it first if needed). gather_missing:true also gathers missing raw materials from nature. plan:true only shows the tree and what is missing. A job.\nExample: {"item":"crafting_table"}',
  build:
    'Build, clear or farm an area. blueprint builds a built-in plan at "x y z": shelter, wall_ring, torch_ring, bridge, stairs_down, farm_plot. dig clears every block in the box from..to (at most 1024). farm tills, plants and harvests the box. Never changes player-built blocks or the Base. A job.\nExample: {"action":"blueprint","blueprint":"shelter","at":"10 64 -3"}',
  use: 'One hands-on action. place item at target "x y z"; break the one block at target; interact (right-click) a block or entity: door, lever, bed, chest, villager; use_item (item, or the held one), optionally on target: bucket, bone_meal, flint_and_steel; attack target until it dies; ride / dismount; sleep in the nearest bed (or target) at night. Player-built blocks and the Base are refused unless the player agreed. A job.\nExample: {"action":"place","item":"crafting_table","target":"6 66 1"}',
  items:
    'What you carry: equip (hand or armor slot), eat (best food, or item), drop, give (walks to to: "player" or @handle), store / take with a container (nearest chest, or container "x y z"), list a container.\nExample: {"action":"give","item":"oak_log","count":5,"to":"player"}',
  menu: 'Block and entity menus: villager trades, enchanting, anvil, brewing, stonecutter. open target, state lists slots and buttons, click a slot (or button), close. For crafting and chests use craft and items.\nExample: {"action":"open","target":"minecraft:villager"}',
  do: 'Run 2-8 world steps as ONE job, in order, without waking you between them. Use it when a request has several known steps ("get logs, then make a table"). Each step is {tool, args} with the args of goto, gather, craft, build, use or items. Stops at the first failed step unless stop_on_fail is false.\nExample: {"steps":[{"tool":"gather","args":{"item":"oak_log","count":10}},{"tool":"craft","args":{"item":"crafting_table"}}]}',
  job: 'Your world jobs: status (current, or job_id), wait up to seconds for it to end and get its result, stop cancels it. A world tool that answers "running" keeps working after your turn: prefer ending your turn, [JOB DONE] wakes you.\nExample: {"action":"stop"}',
  set_mode:
    'What your body does between jobs: follow the player, stay, guard an area (around anchor), or wander.\nExample: {"mode":"guard","anchor":"0 66 3"}',
  say: 'Say something out loud now (a bubble above your head) without ending your turn, and/or play an emote.\nExample: {"text":"On my way!","emote":"wave"}',
  tell: 'Send a private message to one crew member (@handle, name or "ceo"). Only they get it.\nExample: {"to":"@bram","text":"Need 10 cobblestone at the office."}',
  remember:
    'Add a short note to your private long-term memory (re-read after restarts).\nExample: {"note":"Player\'s cabin at 6 66 -6 is player-built: never mine it."}',
  sit_at_pc:
    'Walk to an office PC and sit down to work on it (shell, files, screen). PC ids: observe sections ["pcs"]. When it says "Seated", end your turn: your PC session starts next turn.\nExample: {"pc":"linux-1","purpose":"fix the failing test"}',
  stand_up: 'Stand up from your PC (or stop walking to one).',
  request_hire:
    'CEO only: ask the player to hire a crew member. Returns at once; [HIRE DECISION] arrives later.\nExample: {"role":"miner","reason":"We need iron","first_task":"Mine 20 iron ore"}',
  codex:
    'The shared Codex (notes by the crew and the player). search (top 8 snippets), list (by category or tag), read (one page and its rev), create a page (title, body, category, scope), update (replace the body; needs id and base_rev) or append (needs id). here:true stamps your position on a places page.\nExample: {"action":"search","query":"iron mine"}',
  calendar:
    'Tasks, reminders and meetings. list (optionally for one agent); add (when: "now", "Day 3 06:00" game clock, or an ISO date on the real clock; only the CEO schedules others); update or cancel an event (scope next or all); report closes a scheduled task occurrence as done, failed or blocked (failed and blocked wake the CEO).\nExample: {"action":"add","kind":"task","title":"Mine iron","assignees":["bram1a2b"],"when":"now","task":"Mine 20 iron ore"}',
};

/** The `mc` server's instructions (Appendix A): a short, stable playbook (≈150 tokens, cached with the tools). */
export const MC_V2_INSTRUCTIONS = [
  'How to use the mc tools:',
  '- One request, one composite call: "get N X" → gather; "make X" → craft; several known steps → do. Don\'t chain low-level use/goto calls for these.',
  '- Unsure where you are or what is around? observe first (read-only; may run in parallel with find).',
  '- World tools may answer "running": end your turn; [JOB DONE] or [JOB FAILED] wakes you with the result.',
  '- Failures end with "next:"; follow it. PROTECTED and NO_NATURAL_SOURCE are hard stops: ask the player, never substitute other blocks.',
  '- Positions are "x y z" strings; copy them from results.',
].join('\n');

// --- Schemas (§5) ------------------------------------------------------------------------------------------------

/** A `"x y z"` string (the regex lives in the handler: tools/targets.ts). */
const Pos = z.string().min(5).max(40);
const PosDesc = Pos.describe('"x y z"');
const Item = z.string().min(1).max(64);
const TargetText = z.string().min(1).max(80);

export const OBSERVE_SECTIONS = ['status', 'scene', 'inventory', 'crew', 'jobs', 'events', 'pcs', 'menu'] as const;
type Section = (typeof OBSERVE_SECTIONS)[number];

const SHAPES = {
  observe: {
    sections: z.array(z.enum(OBSERVE_SECTIONS)).min(1).max(8).optional(),
    detail: z.enum(['brief', 'full']).optional().describe('full lists more per section (default brief)'),
    radius: z.number().int().min(8).max(48).optional().describe('Scene radius (default 24)'),
  },
  find: {
    target: z.string().min(1).max(80).describe('Block/item id, #tag, or mob type ("cow")'),
    source: z.enum(['natural', 'built', 'any']).optional().describe('For blocks (default natural)'),
    radius: z.number().int().min(4).max(64).optional().describe('Default 48'),
    limit: z.number().int().min(1).max(10).optional().describe('Default 5'),
  },
  goto: {
    to: TargetText,
    range: z.number().min(0).max(16).optional().describe('Stop this close (default 1.5)'),
  },
  gather: {
    item: Item.describe('id or #tag'),
    count: z.number().int().min(1).max(640),
    near: Pos.optional().describe('Search around this "x y z" instead of you'),
    radius: z.number().int().min(8).max(64).optional().describe('Default 48'),
  },
  craft: {
    item: Item.describe('One item id, not a tag'),
    count: z.number().int().min(1).max(640).optional().describe('Default 1'),
    gather_missing: z.boolean().optional().describe('Default false'),
    plan: z.boolean().optional(),
    station: Pos.optional().describe('Use the crafting table or furnace at "x y z"'),
  },
  build: {
    action: z.enum(['blueprint', 'dig', 'farm']),
    blueprint: z.string().min(1).max(80).optional(),
    at: PosDesc.optional(),
    rotation: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]).optional(),
    from: PosDesc.optional(),
    to: PosDesc.optional(),
    crop: Item.optional().describe('farm: a seed item'),
  },
  use: {
    action: z.enum(['place', 'break', 'interact', 'use_item', 'attack', 'ride', 'dismount', 'sleep']),
    target: TargetText.optional().describe('"x y z" or an entity: "player", @handle, mob type'),
    item: Item.optional().describe('id or #tag'),
    count: z.number().int().min(1).max(64).optional().describe('attack: how many of that mob type (default 1)'),
  },
  items: {
    action: z.enum(['equip', 'eat', 'drop', 'give', 'store', 'take', 'list']),
    item: Item.optional().describe('id or #tag'),
    count: z
      .number()
      .int()
      .min(1)
      .max(640)
      .optional()
      .describe('Default: all you have (drop, give, store), one stack (take)'),
    to: TargetText.optional(),
    slot: z.enum(['mainhand', 'offhand', 'head', 'chest', 'legs', 'feet']).optional(),
    container: PosDesc.optional(),
  },
  menu: {
    action: z.enum(['open', 'state', 'click', 'close']),
    target: TargetText.optional(),
    slot: z.number().int().min(-999).max(255).optional().describe('From state; -2 or less presses button -slot-2'),
    button: z.number().int().min(0).max(40).optional(),
    click: z.enum(['pickup', 'quick_move', 'swap', 'throw', 'pickup_all']).optional(),
  },
  do: {
    steps: z
      .array(z.object({ tool: z.enum(STEP_TOOLS), args: z.record(z.string(), z.unknown()) }))
      .min(2)
      .max(8),
    stop_on_fail: z.boolean().optional(),
  },
  job: {
    action: z.enum(['status', 'wait', 'stop']),
    job_id: z.string().min(1).max(64).optional(),
    seconds: z.number().int().min(1).max(MAX_WAIT_S).optional(),
  },
  set_mode: { mode: IdleMode, anchor: PosDesc.optional() },
  say: {
    text: z.string().min(1).max(500).optional(),
    emote: z.enum(['wave', 'nod', 'shake_head', 'point', 'cheer', 'facepalm']).optional(),
  },
  tell: { to: z.string().min(1).max(64), text: z.string().min(1).max(2000) },
  remember: { note: z.string().min(1).max(600) },
  sit_at_pc: {
    pc: z.string().min(1).max(64),
    purpose: z.string().min(1).max(200).describe('Shown on the monitor'),
  },
  stand_up: {},
  request_hire: {
    role: AgentRole.exclude(['ceo']),
    name: z.string().min(1).max(24).optional(),
    reason: z.string().min(1).max(500),
    first_task: z.string().min(1).max(2000),
  },
  codex: {
    action: z.enum(['search', 'list', 'read', 'create', 'update', 'append']),
    query: z.string().min(1).max(200).optional(),
    id: z.string().min(1).max(80).optional(),
    title: z.string().min(1).max(80).optional(),
    body: z.string().min(1).max(8192).optional(),
    category: CodexCategory.optional(),
    tags: z.array(CodexTag).max(16).optional(),
    scope: CodexScope.optional(),
    base_rev: z.string().min(7).max(64).optional(),
    here: z.boolean().optional(),
  },
  calendar: {
    action: z.enum(['list', 'add', 'update', 'cancel', 'report']),
    id: z.string().min(1).max(64).optional().describe('Event id (update, cancel, report)'),
    title: z.string().min(1).max(80).optional(),
    kind: z.enum(['task', 'reminder', 'meeting']).optional(),
    assignees: z.union([z.literal('all'), z.array(z.string().max(64)).max(16)]).optional(),
    when: z.union([z.string().min(1).max(64), z.number().min(0)]).optional(),
    clock: z.enum(['game', 'real']).optional(),
    repeat: z.enum(['once', 'daily', 'weekdays']).optional(),
    every_n_days: z.number().int().min(2).max(365).optional(),
    duration_min: z.number().int().min(1).max(1440).optional(),
    location: z.string().min(1).max(80).optional(),
    task: z.string().min(1).max(2000).optional(),
    scope: z.enum(['next', 'all']).optional(),
    status: z.enum(['done', 'failed', 'blocked']).optional(),
    note: z.string().min(1).max(500).optional(),
    agent: z.string().min(1).max(64).optional(),
  },
} as const satisfies Record<McV2ToolName, z.ZodRawShape>;

const READ_ONLY = { annotations: { readOnlyHint: true } } as const;
const DESTRUCTIVE = { annotations: { destructiveHint: true } } as const;

/** Tool results above this many characters are cut (observe and org texts have their own caps). */
const OBSERVE_MAX = { brief: 2500, full: 6000 } as const;

// --- The server ----------------------------------------------------------------------------------------------------

/** A tool's text, whether it is an error, and the footer line to append (null: none). */
interface Out {
  readonly text: string;
  readonly isError?: boolean | undefined;
  readonly footer?: string | null | undefined;
}

function toResult(out: Out): CallToolResult {
  const text = out.footer ? `${out.text}\n${out.footer}` : out.text;
  return out.isError ? errorResult(text) : textResult(text);
}

/** Builds the v2 `mc` tool definitions of one agent. */
export function mcToolDefinitionsV2(host: McHost): Def[] {
  const ctx = (): RenderContext => {
    const here = host.here();
    return { here: here ? here.pos : null, playerName: host.playerName() };
  };
  const nodeFooter = (): string | null => footerLine(host.footer());
  const caps = (): ReadonlySet<string> => host.skills.caps?.() ?? new Set<string>();
  const obs = async (query: ObsQueryName, args: Record<string, unknown> = {}) => {
    const { result, footer } = splitFooter(await host.skills.obsQuery(host.agentId, query, args));
    return { result: result ?? {}, footer };
  };
  const translateHost: TranslateHost = {
    playerName: () => host.playerName(),
    crewMember: (ref) => host.crewMember?.(ref) ?? null,
    caps,
    here: () => host.here()?.pos ?? null,
    codexPlace: async (name) => {
      try {
        return await resolveCodexPlace(host, name, { exact: true });
      } catch (err) {
        if (isApiError(err, 'UNKNOWN_PLACE')) return null;
        throw err;
      }
    },
    obs: async (query, args) => (await obs(query, args)).result,
  };

  /** Errors as v2 text: `failed: <what> | CODE: msg` and the code's next step. */
  const failure = (
    what: string,
    err: unknown,
    meta: JobMeta | null,
    footer: boolean,
    args?: Readonly<Record<string, unknown>>,
  ): Out => {
    const code = isApiError(err) ? err.code : 'INTERNAL';
    const msg = err instanceof Error ? err.message : String(err);
    const m: JobMeta = meta ?? { tool: what.split(' ')[0] ?? what, skill: '', what, args };
    const next = code === 'BAD_ARGS' ? null : hintFor(code, m, ctx());
    const lines = [`failed: ${what} | ${code}: ${singleLine(msg, 400)}`];
    if (next) lines.push(nextLine(next));
    return { text: lines.join('\n'), isError: true, footer: footer ? nodeFooter() : null };
  };

  /** Runs a handler; any throw becomes a v2 failure (with the footer when `footer`). */
  const run = async (
    what: string,
    footer: boolean,
    fn: () => Promise<Out>,
    args?: Readonly<Record<string, unknown>>,
  ): Promise<CallToolResult> => {
    try {
      return toResult(await fn());
    } catch (err) {
      return toResult(failure(what, err, null, footer, args));
    }
  };

  /**
   * The world guard (W2): wire calls that reach the Base never get to the mod. Only for a mod that reports no zones: one
   * that does guards provenance itself and offers a consent token with its refusal (protocol §7.4.3), and a refusal of
   * Node's own could never be allowed.
   */
  const guard = (calls: readonly WireCall[]): Out | null => {
    const world = host.world?.() ?? null;
    if (!world || (world.zone !== null && world.zone !== undefined)) return null;
    for (const [i, c] of calls.entries()) {
      const conflict = baseConflict(c.skill, c.args, world.base, {
        here: world.here,
        modGuards: false,
        playerName: host.playerName(),
      });
      if (!conflict) continue;
      host.noteRefusal?.(conflict.refusal);
      const step = calls.length > 1 ? `do step ${i + 1}/${calls.length} ${c.meta.tool}` : c.meta.what;
      const lines = [`failed: ${step} | ${PROTECTED}: ${singleLine(conflict.msg, 300)}`];
      if (conflict.advice) lines.push(` ${adviceFor(c)}`);
      lines.push(nextLine(hintFor(PROTECTED, c.meta, ctx()) ?? ''));
      return { text: lines.join('\n'), isError: true, footer: nodeFooter() };
    }
    return null;
  };

  /** Starts a wire call as a job and answers within ACTION_WAIT_S (§7). */
  const runWire = async (wire: WireCall): Promise<Out> => {
    const key = wireKey(wire);
    const meta: JobMeta = { ...wire.meta, wire: key };
    const refused = guard(wire.skill === 'sequence' ? (meta.steps ?? []).map((s, i) => stepCall(wire, s, i)) : [wire]);
    if (refused) return refused;
    // The player's consent (§8 PROTECTED): the model repeats the exact call the mod refused, after the player picked an
    // "Allow" option; Node then attaches the mod's token and asks for it (allow_protected). Never from tool arguments.
    let consent: SkillConsent | null = null;
    let args = wire.args;
    if (CONSENT_SKILLS_V2.has(wire.skill) && host.jobs?.refused() === key && host.hasConsent?.() === true) {
      consent = host.takeConsent?.() ?? null;
      if (consent) args = { ...args, allow_protected: true };
    }
    const previous = host.jobs?.current() ?? null;
    if (previous) host.jobs?.markCancelled('replace');
    const jobId = newJobId();
    host.jobs?.started(jobId, meta);
    const started = Date.now();
    const elapsed = () => host.jobs?.elapsed(jobId) ?? Date.now() - started;
    let res: Awaited<ReturnType<typeof host.skills.runSkill>>;
    try {
      res = await host.skills.runSkill({
        agentId: host.agentId,
        skill: wire.skill,
        args: args as never,
        waitMs: ACTION_WAIT_S * 1000,
        replace: true,
        jobId,
        ...(consent ? { consent } : {}),
      });
    } catch (err) {
      host.jobs?.ended(jobId, 'failed', { head: '', details: [], next: null, isError: true });
      return failure(meta.what, err, meta, true);
    }
    const replaced =
      previous && previous.jobId !== res.jobId
        ? `(stopped your previous job ${previous.jobId} ${previous.meta.what}${previous.progress ? ` ${progressFor(previous.meta, previous.progress)}` : ''})`
        : null;
    if (res.status === 'running') {
      host.trackJob(res.jobId, meta.what);
      const running = host.jobs?.get(res.jobId);
      const rendered = renderRunning(
        meta,
        res.jobId,
        elapsed(),
        running?.progress ? progressFor(meta, running.progress) : null,
      );
      return { text: compose(withNote(rendered, replaced), null), footer: nodeFooter() };
    }
    const { result, footer } = splitFooter(res.result);
    const rendered = renderOutcome(
      meta,
      {
        status: res.status,
        result,
        error: res.error,
        durationMs: elapsed(),
      },
      ctx(),
    );
    host.jobs?.ended(res.jobId, res.status, rendered, res.error?.code);
    return {
      text: compose(withNote(rendered, replaced), null, meta.skill === 'sequence' ? 900 : 600),
      isError: rendered.isError,
      footer: footerLine(footer) ?? nodeFooter(),
    };
  };

  const defs: Def[] = [];
  const push = (...ds: unknown[]) => {
    defs.push(...(ds as Def[]));
  };

  // --- observe --------------------------------------------------------------------------------------------------
  push(
    tool(
      'observe',
      MC_V2_DESCRIPTIONS.observe,
      SHAPES.observe,
      (args) =>
        run('observe', false, async () => {
          const want = new Set<Section>(args.sections ?? ['status', 'scene']);
          const detail: Detail = args.detail ?? 'brief';
          const sections = OBSERVE_SECTIONS.filter((s) => want.has(s));
          const footers: (string | null)[] = [];
          const texts = await Promise.all(
            sections.map(async (s): Promise<string> => {
              try {
                const r = await section(s, detail, args.radius);
                footers.push(r.footer);
                return r.text;
              } catch (err) {
                return `${s}: unavailable (${isApiError(err) ? err.code : 'ERROR'})`;
              }
            }),
          );
          const text = texts.join('\n');
          const cap = OBSERVE_MAX[detail];
          const capped = text.length > cap ? `${text.slice(0, cap - 1)}…` : text;
          const footer = want.has('status') ? null : (footerLine(footers.find((f) => f) ?? null) ?? nodeFooter());
          return { text: capped, footer };
        }),
      READ_ONLY,
    ),
  );

  /** One observe section (§5.1). */
  const section = async (
    s: Section,
    detail: Detail,
    radius: number | undefined,
  ): Promise<{ text: string; footer: string | null }> => {
    const c = ctx();
    switch (s) {
      case 'status': {
        const { result, footer } = await obs('status');
        const zone = host.body?.()?.zone;
        return { text: renderStatus(zone && !result.zone ? { ...result, zone } : result, c, detail), footer };
      }
      case 'scene': {
        const max = caps().has(MOD_CAPS.LOOK_AROUND_48) ? 48 : 32;
        const r = Math.min(radius ?? 24, max);
        const { result, footer } = await obs('look_around', { radius: r, detail });
        const world = host.world?.() ?? null;
        let trees = treesOf(result);
        const text = renderScene(result, r, detail, (raw) => {
          const seen = perceiveLookAround(raw, world ?? { here: c.here, base: null, playerName: c.playerName });
          trees = trees ?? seen.trees;
          return seen.text;
        });
        if (trees) host.noteTrees?.(trees);
        return { text, footer };
      }
      case 'inventory': {
        const { result, footer } = await obs('inventory');
        return { text: renderInventory(result, detail), footer };
      }
      case 'crew': {
        const { result, footer } = await obs('crew');
        const body = host.body?.() ?? null;
        return {
          text: renderCrew(
            result,
            {
              ...c,
              self: host.agentId,
              names: (id) => host.crewNames?.(id) ?? null,
              playerDistance: body?.playerDistance ?? null,
            },
            detail,
          ),
          footer,
        };
      }
      case 'jobs': {
        const jobs = host.jobs;
        if (jobs?.current()) return { text: jobs.section(), footer: null };
        const { result, footer } = await obs('job_status');
        const mod = renderJobStatus(result);
        const base = jobs ? jobs.section() : 'jobs: no job running';
        return {
          text: mod && mod !== 'idle' ? `${base.replace('no job running', `mod says ${mod}`)}` : base,
          footer,
        };
      }
      case 'events': {
        const { result, footer } = await obs('recent_events', { limit: detail === 'full' ? 20 : 8 });
        return { text: renderEvents(result, detail), footer };
      }
      case 'pcs': {
        const { result, footer } = await obs('list_pcs');
        return { text: renderPcs(result, c, detail), footer };
      }
      case 'menu': {
        const { result, footer } = await obs('menu_state');
        return { text: renderMenu(result, detail), footer };
      }
    }
  };

  // --- find -----------------------------------------------------------------------------------------------------
  push(
    tool(
      'find',
      MC_V2_DESCRIPTIONS.find,
      SHAPES.find,
      (args) =>
        run(`find ${short(args.target)}`, true, async () => {
          const radius = args.radius ?? 48;
          const source = args.source ?? 'natural';
          const target = args.target.trim().toLowerCase();
          const { result, footer } = await obs('find', {
            what: target,
            radius,
            limit: args.limit ?? 5,
            filter: source,
          });
          const world = host.world?.() ?? null;
          const base = world?.base ?? null;
          const found = renderFind(
            result,
            { ...ctx(), inBase: base ? (p: BlockPos) => inBase(p, base, 1) : undefined },
            { target, source, radius },
          );
          if (found.trees) host.noteTrees?.(found.trees);
          return { text: found.text, footer: footerLine(footer) ?? nodeFooter() };
        }),
      READ_ONLY,
    ),
  );

  // --- World jobs -------------------------------------------------------------------------------------------------
  push(
    tool('goto', MC_V2_DESCRIPTIONS.goto, SHAPES.goto, (args) =>
      run(`goto ${args.to}`, true, async () => runWire(await translateGoto(args, translateHost)), args),
    ),
    tool(
      'gather',
      MC_V2_DESCRIPTIONS.gather,
      SHAPES.gather,
      (args) => run(`gather ${short(args.item)}`, true, async () => runWire(translateGather(args, translateHost)), args),
      DESTRUCTIVE,
    ),
    tool('craft', MC_V2_DESCRIPTIONS.craft, SHAPES.craft, (args) =>
      run(`craft ${short(args.item)}`, true, async () => {
        if (args.plan === true) return planCraft(args.item, args.count ?? 1);
        return runWire(await translateCraft(args, translateHost));
      }),
    ),
    tool(
      'build',
      MC_V2_DESCRIPTIONS.build,
      SHAPES.build,
      (args) => run(`build ${args.action}`, true, async () => runWire(translateBuild(args, translateHost)), args),
      DESTRUCTIVE,
    ),
    tool(
      'use',
      MC_V2_DESCRIPTIONS.use,
      SHAPES.use,
      (args) => run(`use ${args.action}`, true, async () => runWire(translateUse(args, translateHost)), args),
      DESTRUCTIVE,
    ),
    tool('items', MC_V2_DESCRIPTIONS.items, SHAPES.items, (args) =>
      run(`items ${args.action}`, true, async () => {
        const wire = await translateItems(args, translateHost);
        const out = await runWire(wire);
        return args.action === 'list' || args.action === 'equip' || args.action === 'eat'
          ? { ...out, text: out.text.replace(/^done: /, 'ok: ') }
          : out;
      }),
    ),
    tool('menu', MC_V2_DESCRIPTIONS.menu, SHAPES.menu, (args) =>
      run(`menu ${args.action}`, true, async () => {
        if (args.action === 'state') {
          const { result, footer } = await obs('menu_state');
          return { text: renderMenu(result, 'full'), footer: footerLine(footer) ?? nodeFooter() };
        }
        return runWire(translateMenu(args, translateHost));
      }),
    ),
    tool(
      'do',
      MC_V2_DESCRIPTIONS.do,
      SHAPES.do,
      (args) =>
        run(`do ${args.steps.length} steps`, true, async () => {
          const calls: WireCall[] = [];
          for (const [i, step] of args.steps.entries()) calls.push(await translateStep(i, step, translateHost));
          const stepArgs = calls.map((c) => ({ skill: c.skill, args: c.args }));
          const sequence: WireCall = {
            skill: 'sequence',
            args: args.stop_on_fail === false ? { steps: stepArgs, stop_on_fail: false } : { steps: stepArgs },
            meta: {
              tool: 'do',
              skill: 'sequence',
              what: `do ${calls.length} steps`,
              steps: calls.map((c) => c.meta),
              from: host.here()?.pos ?? null,
              args,
            },
          };
          return runWire(sequence);
        }),
      DESTRUCTIVE,
    ),
  );

  /** `craft{plan:true}`: the recipe tree without acting (§5.5, M5). */
  const planCraft = async (rawItem: string, count: number): Promise<Out> => {
    const item = rawItem.trim().toLowerCase();
    if (item.startsWith('#')) throw badArgs('item must be one item id, not a tag', CRAFT_EXAMPLE);
    const tree = caps().has(MOD_CAPS.RECIPE_TREE);
    const { result, footer } = await obs('recipe', tree ? { item, count, tree: true } : { item });
    return { text: renderPlan(item, count, result, ctx()), footer: footerLine(footer) ?? nodeFooter() };
  };

  // --- job ------------------------------------------------------------------------------------------------------
  push(
    tool('job', MC_V2_DESCRIPTIONS.job, SHAPES.job, (args) =>
      run(`job ${args.action}`, true, async () => {
        const jobs = host.jobs;
        switch (args.action) {
          case 'status': {
            const id = args.job_id ?? jobs?.current()?.jobId ?? null;
            const running = id ? jobs?.get(id) : null;
            const ended = id ? jobs?.endedJob(id) : null;
            if (ended) {
              return {
                text: compose(ended.rendered, null),
                isError: ended.rendered.isError,
                footer: nodeFooter(),
              };
            }
            if (running && jobs?.current()?.jobId === id) {
              const progress = running.progress ? ` ${progressFor(running.meta, running.progress)}` : '';
              const body = host.body?.() ?? null;
              const paused = body?.reflex ? `; paused for reflex ${body.reflex}` : '';
              return {
                text: `running: ${running.jobId} ${running.meta.what}${progress} (${secondsSince(running.startedAt)}${paused})`,
                footer: nodeFooter(),
              };
            }
            const { result, footer } = await obs('job_status', args.job_id ? { jobId: args.job_id } : {});
            const mod = renderJobStatus(result);
            const last = jobs?.recent()[0];
            if (!mod || mod === 'idle' || mod.startsWith('unknown')) {
              return {
                text: `idle: no job${last ? ` | last: ${jobs?.describeEnded(last)}` : ''}`,
                footer: footerLine(footer) ?? nodeFooter(),
              };
            }
            return { text: mod, footer: footerLine(footer) ?? nodeFooter() };
          }
          case 'wait': {
            const seconds = args.seconds ?? JOB_WAIT_DEFAULT_S;
            const id = args.job_id ?? jobs?.current()?.jobId ?? null;
            if (!id) {
              await host.wait(seconds * 1000);
              return { text: `ok: waited ${seconds}s; no job was running`, footer: nodeFooter() };
            }
            const ended = jobs?.endedJob(id);
            if (ended) return { text: compose(ended.rendered, null), isError: ended.rendered.isError, footer: nodeFooter() };
            try {
              const end = await host.skills.awaitJob(id, seconds * 1000);
              const meta = jobs?.meta(id) ?? { tool: 'job', skill: '', what: `job ${id}` };
              const { result, footer } = splitFooter(end.result);
              const rendered = renderOutcome(
                meta,
                { status: end.status, result, error: end.error, durationMs: end.durationMs },
                ctx(),
              );
              jobs?.ended(id, end.status, rendered, end.error?.code);
              return {
                text: compose(rendered, null, meta.skill === 'sequence' ? 900 : 600),
                isError: rendered.isError,
                footer: footerLine(footer) ?? nodeFooter(),
              };
            } catch (err) {
              if (!isApiError(err, 'TIMEOUT')) throw err;
              const running = jobs?.get(id);
              const progress = running?.progress ? ` ${progressFor(running.meta, running.progress)}` : '';
              return {
                text: `running: ${id} ${running?.meta.what ?? ''}${progress} (still going after ${seconds}s more)\n${nextLine(`end your turn; [JOB DONE] wakes you. Or ${call('job', { action: 'stop' })}.`)}`,
                footer: nodeFooter(),
              };
            }
          }
          case 'stop': {
            const current = jobs?.current() ?? null;
            if (current && (!args.job_id || args.job_id === current.jobId)) jobs?.markCancelled('stop');
            const cancelled = await host.skills.cancelSkill(host.agentId, {
              ...(args.job_id ? { jobId: args.job_id } : {}),
              reason: 'stop',
            });
            if (cancelled.length === 0) return { text: 'ok: no job was running', footer: nodeFooter() };
            const lines: string[] = [];
            for (const id of cancelled) {
              let kept = '';
              try {
                const end = await host.skills.awaitJob(id, 3_000);
                const items = itemList(obj(splitFooter(end.result).result?.items), 3);
                if (items) kept = ` (kept ${items})`;
              } catch {
                // no result in time: say what we know
              }
              const meta = jobs?.meta(id);
              const progress = jobs?.get(id)?.progress;
              lines.push(
                `cancelled: ${id}${meta ? ` ${meta.what}` : ''}${progress && meta ? ` ${progressFor(meta, progress)}` : ''}${kept}`,
              );
            }
            return { text: lines.join('\n'), footer: nodeFooter() };
          }
        }
      }),
    ),
  );

  // --- Behaviour and social ---------------------------------------------------------------------------------------
  push(
    tool('set_mode', MC_V2_DESCRIPTIONS.set_mode, SHAPES.set_mode, (args) =>
      run('set_mode', false, async () => {
        const anchor = args.anchor === undefined ? undefined : requirePos(args.anchor, 'anchor');
        await host.skills.setMode(host.agentId, args.mode, anchor);
        return { text: `ok: idle mode ${args.mode}${anchor ? ` around ${posText(anchor)}` : ''}` };
      }),
    ),
    tool('say', MC_V2_DESCRIPTIONS.say, SHAPES.say, (args) =>
      run('say', false, async () => {
        if (args.text === undefined && args.emote === undefined) {
          throw badArgs('give text, emote or both', call('say', { text: 'On my way!', emote: 'wave' }));
        }
        const done: string[] = [];
        if (args.text !== undefined) {
          host.say(args.text);
          done.push('said');
        }
        if (args.emote !== undefined) {
          try {
            await host.skills.runSkill({
              agentId: host.agentId,
              skill: 'emote',
              args: { kind: args.emote },
              waitMs: 2_000,
              replace: false,
            });
            done.push(EMOTE_PAST[args.emote] ?? args.emote);
          } catch (err) {
            done.push(`no ${args.emote} (${isApiError(err) ? err.code : 'error'})`);
          }
        }
        return { text: `ok: ${done.join(', ')}` };
      }),
    ),
    tool('tell', MC_V2_DESCRIPTIONS.tell, SHAPES.tell, (args) =>
      run('tell', false, async () => ({ text: await host.tell(args.to, args.text) })),
    ),
    tool('remember', MC_V2_DESCRIPTIONS.remember, SHAPES.remember, (args) =>
      run('remember', false, async () => ({ text: await host.remember(args.note) })),
    ),
    tool('sit_at_pc', MC_V2_DESCRIPTIONS.sit_at_pc, SHAPES.sit_at_pc, (args) =>
      run(`sit_at_pc ${args.pc}`, false, async () => ({
        text: await host.sitAtPc({ pcId: args.pc, purpose: args.purpose, waitMs: SIT_WAIT_S * 1000 }),
      })),
    ),
    tool('stand_up', MC_V2_DESCRIPTIONS.stand_up, SHAPES.stand_up, () =>
      run('stand_up', false, async () => ({ text: await host.standUp() })),
    ),
    tool('request_hire', MC_V2_DESCRIPTIONS.request_hire, SHAPES.request_hire, (args) =>
      run('request_hire', false, async () => ({
        text: await host.requestHire({
          role: args.role,
          name: args.name,
          reason: args.reason,
          firstTask: args.first_task,
        }),
      })),
    ),
  );

  // --- Codex and calendar (OrgApi texts, unchanged) ---------------------------------------------------------------
  push(
    tool('codex', MC_V2_DESCRIPTIONS.codex, SHAPES.codex, (args) =>
      run(`codex ${args.action}`, false, async () => orgOut(await codexCall(host, args))),
    ),
    tool('calendar', MC_V2_DESCRIPTIONS.calendar, SHAPES.calendar, (args) =>
      run(`calendar ${args.action}`, false, async () => {
        const result = await calendarCall(host, args);
        if (args.action === 'report' && result.ok && args.id && args.status) {
          host.taskReported({ eventId: args.id, status: args.status, note: args.note });
        }
        return orgOut(result);
      }),
    ),
  );

  return defs;
}

const EMOTE_PAST: Readonly<Record<string, string>> = {
  wave: 'waved',
  nod: 'nodded',
  shake_head: 'shook your head',
  point: 'pointed',
  cheer: 'cheered',
  facepalm: 'facepalmed',
};

function orgOut(result: OrgToolResult): Out {
  return { text: result.text, isError: !result.ok };
}

function secondsSince(t: number): string {
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

/** Inserts the replace notice as the first detail line. */
function withNote(r: Rendered, note: string | null): Rendered {
  return note ? { ...r, details: [note, ...r.details] } : r;
}

/**
 * A job's progress text, shortened for its result line: `4/10 minecraft:oak_log` → `4/10` when the item is the one
 * the call asked for; a sequence's `step 1/2 4/10 oak_log` names the step's tool.
 */
export function progressFor(meta: JobMeta, text: string): string {
  const flat = singleLine(text.replace(/minecraft:/g, ''), 120);
  const step = /^step (\d+)\/(\d+) ?(.*)$/.exec(flat);
  if (step && meta.steps) {
    const i = Number(step[1]) - 1;
    const sub = meta.steps[i];
    const rest = sub ? progressFor(sub, step[3] ?? '') : (step[3] ?? '');
    return `step ${step[1]}/${step[2]}${sub ? ` ${sub.what}` : ''}${rest ? ` ${rest}` : ''}`;
  }
  const m = /^(\d+\/\d+)\s+(\S+)$/.exec(flat);
  if (m && meta.want && short(meta.want.item) === m[2]) return m[1] ?? flat;
  return flat;
}

/** A wire call's identity: the same tool call translates to the same key (the consent retry matches on it). */
export function wireKey(wire: Pick<WireCall, 'skill' | 'args'>): string {
  return JSON.stringify([wire.skill, wire.args]);
}

/** The wire call of `do` step `i` (for the guard; the steps are in the sequence's args). */
function stepCall(wire: WireCall, meta: JobMeta, i: number): WireCall {
  const steps = Array.isArray(wire.args.steps) ? (wire.args.steps as { skill: string; args: Record<string, unknown> }[]) : [];
  const step = steps[i];
  return { skill: (step?.skill ?? meta.skill) as WireCall['skill'], args: step?.args ?? {}, meta };
}

/** v2 wording of the world guard's advice for a search Node refused (world/guard.ts `advice`). */
function adviceFor(c: WireCall): string {
  const target = String(c.args.item ?? c.args.block ?? '').toLowerCase();
  const t = short(target);
  if (t.startsWith('#')) {
    return `Name the exact natural block instead (oak_log, spruce_log, stone), e.g. ${call('gather', { item: 'oak_log', count: 10 })}; gather looks for it in nature.`;
  }
  if (t.endsWith('_planks')) return `Get logs and craft planks: ${call('craft', { item: t, gather_missing: true })}.`;
  if (/crafting_table|furnace|chest|torch|lantern|_bed$|_door$/.test(t)) {
    return `Use the Base's ${t} where it stands, or make your own: ${call('craft', { item: t })}.`;
  }
  return `Gather it away from the Base: give near "x y z" from find, far from its walls, or craft it.`;
}

/** W1's `look_around.trees` data: the nearest natural tree, for the scene line. */
function treesOf(result: Record<string, unknown>): { pos: BlockPos; reachable: boolean | null } | null {
  for (const raw of arr(result.trees)) {
    const t = obj(raw);
    const pos = asPos(t?.trunk);
    if (!pos) continue;
    const r = t?.reachable;
    return { pos, reachable: r === 'reachable' ? true : r === 'unreachable' ? false : null };
  }
  return null;
}

/**
 * `craft{plan:true}` → text. With the mod's tree (M5: `steps`, `missing`, `station`) the whole plan; with an older
 * mod the first recipes and their ingredients.
 */
export function renderPlan(item: string, count: number, r: Record<string, unknown>, ctx: RenderContext): string {
  const lines: string[] = [];
  const name = short(item);
  const steps = arr(r.steps)
    .map(obj)
    .filter((s): s is Record<string, unknown> => s !== null);
  const missing = arr(r.missing)
    .map(obj)
    .filter((m): m is Record<string, unknown> => m !== null);
  if (steps.length > 0 || r.tree === true) {
    const stations = obj(r.stations) ?? {};
    const stationBits: string[] = [];
    for (const [kind, raw] of Object.entries(stations)) {
      const s = obj(raw);
      const pos = asPos(s?.pos);
      const how = typeof s?.how === 'string' ? s.how : null;
      if (pos) stationBits.push(`${kind}: at ${posText(pos)}${ctx.here ? ` (${Math.round(Math.hypot(pos.x - ctx.here.x, pos.z - ctx.here.z))}m)` : ''}`);
      else if (how) stationBits.push(`${kind}: ${singleLine(how, 40)}`);
    }
    lines.push([`plan: ${name} ×${count}`, ...stationBits].join(' | '));
    for (const s of steps.slice(0, 8)) {
      const out = idText(s.item) ?? '?';
      const n = num(s.count) ?? 1;
      const action = s.action === 'smelt' ? 'smelt ' : '';
      const from = itemList(obj(s.from), 4) || '?';
      const ready = s.ready === true ? ' ok' : '';
      lines.push(` ${out} ×${n} ← ${action}${from}${ready}`);
    }
    if (missing.length > 0) {
      lines.push(` missing raw: ${missing.map((m) => `${idText(m.item) ?? '?'} ${num(m.need) ?? 0}`).join(', ')}`);
      lines.push(nextLine(`${call('craft', { item, ...(count > 1 ? { count } : {}), gather_missing: true })} (gathers what is missing)`));
    } else {
      lines.push(nextLine(`${call('craft', { item, ...(count > 1 ? { count } : {}) })}`));
    }
    return lines.join('\n');
  }
  // An older mod: `recipes: [{station, makes, ingredients: [{item, need, have}], canCraftNow}]`.
  const recipes = arr(r.recipes)
    .map(obj)
    .filter((x): x is Record<string, unknown> => x !== null);
  if (recipes.length === 0) {
    lines.push(`plan: ${name} has no recipe | have ${num(r.have) ?? 0}`);
    lines.push(nextLine(`${call('gather', { item, count })} (it is gathered, not crafted)`));
    return lines.join('\n');
  }
  lines.push(`plan: ${name} ×${count} (one level; this mod has no recipe tree) | have ${num(r.have) ?? 0}`);
  for (const rec of recipes.slice(0, 2)) {
    const station = typeof rec.station === 'string' ? rec.station : '?';
    const ings = arr(rec.ingredients)
      .map(obj)
      .filter((x): x is Record<string, unknown> => x !== null)
      .map((x) => `${singleLine(String(x.item ?? '?'), 30)} ${num(x.need) ?? 0} (have ${num(x.have) ?? 0})`);
    lines.push(` ${station}: ${ings.join(', ')}${num(rec.canCraftNow) ? ` | can make ${num(rec.canCraftNow)} now` : ''}`);
  }
  lines.push(nextLine(`${call('craft', { item, ...(count > 1 ? { count } : {}) })}`));
  return lines.join('\n');
}

// --- Codex and calendar ------------------------------------------------------------------------------------------

const CODEX_EXAMPLES = {
  search: call('codex', { action: 'search', query: 'iron mine' }),
  read: call('codex', { action: 'read', id: 'iron-cave' }),
  create: call('codex', {
    action: 'create',
    title: 'Iron cave',
    body: 'Entrance at 120 40 -80 by the river.',
    category: 'places',
    scope: 'world',
  }),
  update: call('codex', { action: 'update', id: 'iron-cave', base_rev: '0000003', body: 'New text' }),
  append: call('codex', { action: 'append', id: 'iron-cave', body: 'More iron north.' }),
} as const;

type CodexArgs = z.infer<z.ZodObject<typeof SHAPES.codex>>;
type CalendarArgs = z.infer<z.ZodObject<typeof SHAPES.calendar>>;

async function codexCall(host: McHost, a: CodexArgs): Promise<OrgToolResult> {
  const tools = host.org.tools;
  switch (a.action) {
    case 'search':
      if (!a.query) throw badArgs('search needs query', CODEX_EXAMPLES.search);
      return tools.codexSearch(host.agentId, { query: a.query, tags: a.tags, category: a.category });
    case 'list':
      return tools.codexList(host.agentId, { category: a.category, tag: a.tags?.[0] });
    case 'read':
      if (!a.id) throw badArgs('read needs id', CODEX_EXAMPLES.read);
      return tools.codexRead(host.agentId, { id: a.id });
    case 'create':
    case 'update':
    case 'append': {
      if (a.category === 'rules') throw badArgs('rules pages are the player\'s: pick another category', CODEX_EXAMPLES.create);
      if (!a.body) throw badArgs(`${a.action} needs body`, CODEX_EXAMPLES[a.action]);
      if (a.action === 'create' && (!a.title || !a.category || !a.scope)) {
        throw badArgs('create needs title, body, category and scope', CODEX_EXAMPLES.create);
      }
      if (a.action !== 'create' && !a.id) throw badArgs(`${a.action} needs id`, CODEX_EXAMPLES[a.action]);
      if (a.action === 'update' && !a.base_rev) throw badArgs('update needs base_rev (from read)', CODEX_EXAMPLES.update);
      const input: Record<string, unknown> = { mode: a.action, body: a.body };
      for (const k of ['title', 'tags', 'category', 'scope', 'id', 'base_rev', 'here'] as const) {
        if (a[k] !== undefined) input[k] = a[k];
      }
      if (a.action !== 'create' && a.id && (!a.title || !a.category || !a.scope)) {
        // Fill what the page already says (the org service wants them for a write).
        try {
          const page = await host.org.codex.read(host.actor(), a.id);
          input.title ??= page.title;
          input.category ??= page.category;
          input.scope ??= page.scope;
        } catch {
          // the write itself reports a missing page
        }
      }
      return tools.codexWrite(host.agentId, input);
    }
  }
}

const CALENDAR_EXAMPLES = {
  add: call('calendar', { action: 'add', kind: 'task', title: 'Mine iron', when: 'now', task: 'Mine 20 iron ore' }),
  update: call('calendar', { action: 'update', id: 'ev-3', when: 'Day 4 07:00' }),
  cancel: call('calendar', { action: 'cancel', id: 'ev-3' }),
  report: call('calendar', { action: 'report', id: 'ev-3', status: 'done' }),
} as const;

/** `"now"` and `"Day 3 06:00"` are the game clock; anything else (an ISO date) the real one. */
export function clockOf(when: unknown, given: 'game' | 'real' | undefined): 'game' | 'real' {
  if (given) return given;
  if (typeof when === 'string' && /^(now|day\s+\d+)/i.test(when.trim())) return 'game';
  return typeof when === 'number' ? 'game' : 'real';
}

function recurrenceOf(a: CalendarArgs): unknown {
  if (a.every_n_days !== undefined) return { kind: 'every_n_days', n: a.every_n_days };
  if (a.repeat !== undefined) return { kind: a.repeat };
  return undefined;
}

async function calendarCall(host: McHost, a: CalendarArgs): Promise<OrgToolResult> {
  const tools = host.org.tools;
  const fields = (): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const k of ['title', 'kind', 'assignees', 'when', 'duration_min', 'location', 'task'] as const) {
      if (a[k] !== undefined) out[k] = a[k];
    }
    const recurrence = recurrenceOf(a);
    if (recurrence !== undefined) out.recurrence = recurrence;
    return out;
  };
  switch (a.action) {
    case 'list':
      return tools.calendarList(host.agentId, a.agent ? { agent: a.agent } : {});
    case 'add': {
      if (!a.title || a.when === undefined) throw badArgs('add needs title and when', CALENDAR_EXAMPLES.add);
      return tools.calendarAdd(host.agentId, {
        ...fields(),
        kind: a.kind ?? 'task',
        assignees: a.assignees ?? [host.agentId],
        clock: clockOf(a.when, a.clock),
      });
    }
    case 'update': {
      if (!a.id) throw badArgs('update needs id', CALENDAR_EXAMPLES.update);
      const input: Record<string, unknown> = { id: a.id, ...fields() };
      if (a.clock !== undefined || a.when !== undefined) input.clock = clockOf(a.when, a.clock);
      return tools.calendarUpdate(host.agentId, input);
    }
    case 'cancel':
      if (!a.id) throw badArgs('cancel needs id', CALENDAR_EXAMPLES.cancel);
      return tools.calendarCancel(host.agentId, a.scope ? { id: a.id, scope: a.scope } : { id: a.id });
    case 'report':
      if (!a.id || !a.status) throw badArgs('report needs id and status', CALENDAR_EXAMPLES.report);
      return tools.reportTask(host.agentId, {
        event_id: a.id,
        status: a.status,
        ...(a.note ? { note: a.note } : {}),
      });
  }
}

/** For tests: the position parser the handlers use. */
export { parsePos };
export { DO_EXAMPLE };
