/**
 * The tool catalog (PLAN §6.2, §7.4): every `mcp__mc__*` and `mcp__pc__*` tool name with the gate category it falls
 * in. The tool servers and the ToolGate both read this list, and a test checks that they agree.
 */

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

export const MC_TOOLS = {
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

export type McToolName = keyof typeof MC_TOOLS;

/**
 * `pc` tools (PLAN §6.2, PC tools V2). The computer tools mirror the trained computer-use toolset member by member
 * (`computer_toolset_20260801`); `ui`, `ui_act`, `open` and `wait_for` read and drive apps through the accessibility
 * tree; the shell and file tools answer like Claude Code's built-ins (they are aliased to them).
 */
export const PC_TOOLS = [
  // Computer (trained members)
  'screenshot',
  'zoom',
  'cursor_position',
  'left_click',
  'right_click',
  'middle_click',
  'double_click',
  'triple_click',
  'left_click_drag',
  'left_mouse_down',
  'left_mouse_up',
  'mouse_move',
  'scroll',
  'type',
  'key',
  'hold_key',
  'wait',
  // Perception and helpers
  'ui',
  'ui_act',
  'open',
  'wait_for',
  'clipboard',
  // Shell and files
  'bash',
  'task_stop',
  'read',
  'write',
  'edit',
  'glob',
  'grep',
  // About the PC
  'info',
  'handoff_note',
] as const;
export type PcToolName = (typeof PC_TOOLS)[number];

/** Computer actions that change what is on screen or where input goes: denied in plan mode. */
export const PC_PLAN_DENIED_GUI: ReadonlySet<PcToolName> = new Set([
  'left_click',
  'right_click',
  'middle_click',
  'double_click',
  'triple_click',
  'left_click_drag',
  'left_mouse_down',
  'left_mouse_up',
  'type',
  'key',
  'hold_key',
  'ui_act',
  'open',
]);

/**
 * The computer actions of the batch rules (PC tools V2 §4.2): run in order, and after one fails the rest of the same
 * message do not run.
 */
export const PC_COMPUTER_ACTIONS: ReadonlySet<PcToolName> = new Set([
  'screenshot',
  'zoom',
  'cursor_position',
  'left_click',
  'right_click',
  'middle_click',
  'double_click',
  'triple_click',
  'left_click_drag',
  'left_mouse_down',
  'left_mouse_up',
  'mouse_move',
  'scroll',
  'type',
  'key',
  'hold_key',
  'wait',
  'ui_act',
  'open',
  'wait_for',
]);

/** File mutators denied in plan mode except under `~/.claude/plans/` (PlanCapture). */
export const PC_PLAN_FILE_MUTATORS: ReadonlySet<PcToolName> = new Set(['write', 'edit']);

export const MC_PREFIX = 'mcp__mc__';
export const PC_PREFIX = 'mcp__pc__';

export function mcToolName(name: string): McToolName | null {
  if (!name.startsWith(MC_PREFIX)) return null;
  const short = name.slice(MC_PREFIX.length);
  return Object.hasOwn(MC_TOOLS, short) ? (short as McToolName) : null;
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
