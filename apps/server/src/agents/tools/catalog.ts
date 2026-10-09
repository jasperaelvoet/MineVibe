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

// -------------------------------------------------------------------------------------------------------------------
// Modes (PLAN §6.2 "Tools per mode", agents/modes.ts)
// -------------------------------------------------------------------------------------------------------------------

/** The three brain modes: walking the world, seated at an office PC, seated at the meeting table. */
export type BrainMode = 'wander' | 'seated' | 'meeting';
export const BRAIN_MODES: readonly BrainMode[] = ['wander', 'seated', 'meeting'];

const EVERY_MODE: readonly BrainMode[] = BRAIN_MODES;
/** Keeps an eye on the body and the scene while seated (danger awareness). */
const WANDER_SEATED: readonly BrainMode[] = ['wander', 'seated'];
const WANDER_MEETING: readonly BrainMode[] = ['wander', 'meeting'];

/**
 * The modes each `mc` tool belongs to. **An untagged mc tool is wander-only** (the conservative default): a new world
 * tool never shows up in PC mode or at the meeting table by accident. Seated agents keep a minimal set (their body and
 * the scene around it, stand up, talk, memory, Codex, calendar); meetings keep talk, notes, calendar and stand_up.
 */
export const MC_TOOL_MODES: Readonly<Partial<Record<McToolName, readonly BrainMode[]>>> = {
  status: WANDER_SEATED,
  look_around: WANDER_SEATED,
  stand_up: EVERY_MODE,
  say: EVERY_MODE,
  tell: EVERY_MODE,
  emote: WANDER_MEETING,
  remember: EVERY_MODE,
  codex_search: EVERY_MODE,
  codex_read: EVERY_MODE,
  codex_write: EVERY_MODE,
  codex_list: EVERY_MODE,
  calendar_list: EVERY_MODE,
  calendar_add: EVERY_MODE,
  calendar_update: EVERY_MODE,
  calendar_cancel: EVERY_MODE,
  report_task: EVERY_MODE,
};

/** The modes each `pc` tool belongs to. **An untagged pc tool is seated-only**: no tool reaches a PC you don't sit at. */
export const PC_TOOL_MODES: Readonly<Partial<Record<PcToolName, readonly BrainMode[]>>> = {};

/** Built-in tools (`options.tools`) per mode. A built-in that is not listed belongs to no mode. */
export const BUILTIN_TOOL_MODES: Readonly<Record<string, readonly BrainMode[]>> = {
  AskUserQuestion: EVERY_MODE,
  /** Plan-first PC sessions only (ToolGate denies it outside plan mode). */
  ExitPlanMode: ['seated'],
  WebSearch: ['seated'],
  WebFetch: ['seated'],
};

export function mcToolModes(tool: McToolName): readonly BrainMode[] {
  return MC_TOOL_MODES[tool] ?? ['wander'];
}

export function pcToolModes(tool: PcToolName): readonly BrainMode[] {
  return PC_TOOL_MODES[tool] ?? ['seated'];
}
