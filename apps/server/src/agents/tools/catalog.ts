/**
 * The tool catalog (PLAN §6.2, §7.4): every `mcp__mc__*` and `mcp__pc__*` tool name with the gate category it falls
 * in, for both `mc` tool sets (v1 and v2, docs/design/tools-v2-mc.md §9). The tool servers and the ToolGate both read
 * this list, and a test checks that they agree.
 */

import type { McToolsVersion } from '../constants.js';

/** ToolGate categories for `mc` tools (the rows of PLAN §6.2's table). */
export type McCategory =
  /** observe / social / eat / equip / remember / behaviour: allowed wandering and seated. */
  | 'always'
  /** movement and world jobs: denied while seated ("stand up first"). */
  | 'world'
  /** `sit_at_pc`. */
  | 'sit'
  /** `stand_up`: denied while not seated. */
  | 'stand'
  /** `request_hire`: CEO only. */
  | 'hire'
  /** `codex_*` reads. */
  | 'codex_read'
  /** `codex_write`: allowed; the write budget is enforced by the Codex. */
  | 'codex_write'
  /** `calendar_*` and `report_task`: self only, scheduling others is CEO only. */
  | 'calendar';

/** The v1 tool set (54 tools; mcServerV1.ts). */
export const MC_TOOLS_V1 = {
  // Observe
  status: 'always',
  look_around: 'always',
  inventory: 'always',
  find: 'always',
  recipe: 'always',
  recent_events: 'always',
  crew: 'always',
  list_pcs: 'always',
  job_status: 'always',
  // Behaviour
  set_mode: 'always',
  stop: 'always',
  // Move
  goto: 'world',
  // World
  mine: 'world',
  collect: 'world',
  hunt: 'world',
  dig: 'world',
  place: 'world',
  use_block: 'world',
  use_item: 'world',
  attack: 'world',
  equip: 'always',
  eat: 'always',
  sleep: 'world',
  pickup: 'world',
  drop: 'world',
  give: 'world',
  // Craft
  craft: 'world',
  smelt: 'world',
  container: 'world',
  // Generic menus
  open_menu: 'world',
  menu_state: 'always',
  menu_click: 'world',
  menu_close: 'world',
  // Build
  build: 'world',
  farm: 'world',
  // Ride
  ride: 'world',
  dismount: 'world',
  // PC
  sit_at_pc: 'sit',
  stand_up: 'stand',
  // Social
  say: 'always',
  tell: 'always',
  emote: 'always',
  remember: 'always',
  wait: 'always',
  request_hire: 'hire',
  // Codex
  codex_search: 'codex_read',
  codex_read: 'codex_read',
  codex_write: 'codex_write',
  codex_list: 'codex_read',
  // Calendar
  calendar_list: 'calendar',
  calendar_add: 'calendar',
  calendar_update: 'calendar',
  calendar_cancel: 'calendar',
  report_task: 'calendar',
} as const satisfies Record<string, McCategory>;

export type McV1ToolName = keyof typeof MC_TOOLS_V1;

/** The v1 catalog under its historical name. */
export const MC_TOOLS = MC_TOOLS_V1;

/** A category, fixed or decided by the call's input (v2 action enums mix gates: tools-v2-mc.md §9). */
export type McCategoryRule = McCategory | ((input: Readonly<Record<string, unknown>>) => McCategory);

/** The v2 tool set (20 tools; mcToolsV2.ts) with its gate rules (tools-v2-mc.md §9). */
export const MC_TOOLS_V2 = {
  observe: 'always',
  find: 'always',
  goto: 'world',
  gather: 'world',
  /** `plan:true` only reads. */
  craft: (input) => (input.plan === true ? 'always' : 'world'),
  build: 'world',
  use: 'world',
  /** equip and eat work seated, like v1's equip and eat. */
  items: (input) => (input.action === 'equip' || input.action === 'eat' ? 'always' : 'world'),
  /** state only reads. */
  menu: (input) => (input.action === 'state' ? 'always' : 'world'),
  do: 'world',
  job: 'always',
  set_mode: 'always',
  say: 'always',
  tell: 'always',
  remember: 'always',
  sit_at_pc: 'sit',
  stand_up: 'stand',
  request_hire: 'hire',
  codex: (input) =>
    input.action === 'search' || input.action === 'list' || input.action === 'read' ? 'codex_read' : 'codex_write',
  calendar: 'calendar',
} as const satisfies Record<string, McCategoryRule>;

export type McV2ToolName = keyof typeof MC_TOOLS_V2;
/** A tool name of either set. */
export type McToolName = McV1ToolName | McV2ToolName;
export type { McToolsVersion };

/** The catalog of one tool set. */
export function mcToolsOf(version: McToolsVersion): Readonly<Record<string, McCategoryRule>> {
  return version === 'v2' ? MC_TOOLS_V2 : MC_TOOLS_V1;
}

/** The gate category of a call, or null when the tool is not in that set. */
export function categoryOf(
  tool: string,
  input: Readonly<Record<string, unknown>>,
  version: McToolsVersion,
): McCategory | null {
  const tools = mcToolsOf(version);
  if (!Object.hasOwn(tools, tool)) return null;
  const rule = tools[tool] as McCategoryRule;
  return typeof rule === 'function' ? rule(input) : rule;
}

/** `pc` tools (PLAN §6.2). */
export const PC_TOOLS = [
  'screenshot',
  'click',
  'double_click',
  'right_click',
  'move',
  'drag',
  'scroll',
  'type',
  'key',
  'clipboard',
  'bash',
  'bash_output',
  'bash_kill',
  'read',
  'write',
  'edit',
  'glob',
  'grep',
  'info',
  'handoff_note',
] as const;
export type PcToolName = (typeof PC_TOOLS)[number];

/** GUI mutators denied in plan mode (`clipboard` only when it sets). */
export const PC_PLAN_DENIED_GUI: ReadonlySet<PcToolName> = new Set([
  'click',
  'double_click',
  'right_click',
  'drag',
  'type',
  'key',
]);

/** File mutators denied in plan mode except under `~/.claude/plans/` (PlanCapture). */
export const PC_PLAN_FILE_MUTATORS: ReadonlySet<PcToolName> = new Set(['write', 'edit']);

export const MC_PREFIX = 'mcp__mc__';
export const PC_PREFIX = 'mcp__pc__';

/** The `mc` tool a full name refers to, in either set (the gate then checks it against the session's set). */
export function mcToolName(name: string): McToolName | null {
  if (!name.startsWith(MC_PREFIX)) return null;
  const short = name.slice(MC_PREFIX.length);
  return Object.hasOwn(MC_TOOLS_V1, short) || Object.hasOwn(MC_TOOLS_V2, short) ? (short as McToolName) : null;
}

export function pcToolName(name: string): PcToolName | null {
  if (!name.startsWith(PC_PREFIX)) return null;
  const short = name.slice(PC_PREFIX.length);
  return (PC_TOOLS as readonly string[]).includes(short) ? (short as PcToolName) : null;
}

/**
 * Built-in tools brokered by canUseTool (they still reach it under bypassPermissions). USER DECISION 2026-10-08: no
 * EnterPlanMode; ExitPlanMode only in plan-first sessions.
 */
export const BROKER_TOOLS = ['AskUserQuestion', 'ExitPlanMode'] as const;
