// Mode profiles for spike S3b (pure: no SDK import, unit-tested in test/profiles.test.mjs).
//
// A profile is the tool surface the model should SEE in one brain mode. The ToolGate stays the authoritative
// guard; hiding tools is about prompt size and focus, not security.
//
//   wander  (Haiku xhigh)  every mc tool; no pc tools, no web tools
//   seated  (Opus medium)  every pc tool + web + a minimal mc set (observe, stand_up, social, memory, codex, calendar)
//   meeting (Haiku xhigh)  social + codex + calendar + stand_up

export const HAIKU = 'claude-haiku-5-5';
export const OPUS = 'claude-opus-5-5';

/** A small but representative slice of the real mc catalog (apps/server/src/agents/tools/catalog.ts). */
export const MC_TOOLS = Object.freeze({
  status: 'observe',
  look_around: 'observe',
  goto: 'move',
  mine: 'world',
  craft: 'world',
  sit_at_pc: 'sit',
  stand_up: 'stand',
  say: 'social',
  tell: 'social',
  remember: 'social',
  codex_read: 'codex',
  calendar_list: 'calendar',
  report_task: 'calendar',
});

export const PC_TOOLS = Object.freeze(['bash', 'read', 'edit', 'write', 'glob', 'grep', 'screenshot']);

/** Built-ins passed in options.tools (production BUILTIN_TOOLS). */
export const BUILTIN_TOOLS = Object.freeze([
  'AskUserQuestion',
  'EnterPlanMode',
  'ExitPlanMode',
  'WebSearch',
  'WebFetch',
]);
export const WEB_TOOLS = Object.freeze(['WebSearch', 'WebFetch']);

/** Host tools that must never run on the host (production DISALLOWED_TOOLS). */
export const DISALLOWED_TOOLS = Object.freeze([
  'Bash',
  'Read',
  'Edit',
  'Write',
  'Glob',
  'Grep',
  'NotebookEdit',
  'Agent',
  'Task',
]);

export const TOOL_ALIASES = Object.freeze({
  Bash: 'mcp__pc__bash',
  Read: 'mcp__pc__read',
  Edit: 'mcp__pc__edit',
  Write: 'mcp__pc__write',
  Glob: 'mcp__pc__glob',
  Grep: 'mcp__pc__grep',
});

const mc = (n) => `mcp__mc__${n}`;
const pc = (n) => `mcp__pc__${n}`;

const MC_BY_CATEGORY = (cats) =>
  Object.entries(MC_TOOLS)
    .filter(([, c]) => cats.includes(c))
    .map(([n]) => n);

export const PROFILES = Object.freeze({
  wander: Object.freeze({
    name: 'wander',
    model: HAIKU,
    effort: 'xhigh',
    mc: Object.keys(MC_TOOLS),
    pc: false,
    web: false,
    persona:
      'Mode: WANDERING in the Minecraft world. You have your body tools only (mc). There is no computer here.',
  }),
  seated: Object.freeze({
    name: 'seated',
    model: OPUS,
    effort: 'medium',
    mc: MC_BY_CATEGORY(['observe', 'stand', 'social', 'codex', 'calendar']),
    pc: true,
    web: true,
    persona:
      'Mode: SEATED at a PC. You work with the computer tools (pc). To walk, mine or craft, stand up first.',
  }),
  meeting: Object.freeze({
    name: 'meeting',
    model: HAIKU,
    effort: 'xhigh',
    mc: MC_BY_CATEGORY(['social', 'codex', 'calendar', 'stand']),
    pc: false,
    web: false,
    persona: 'Mode: IN A MEETING at the table. Talk, take notes and plan; stand up to leave.',
  }),
});

export function profile(name) {
  const p = PROFILES[name];
  if (!p) throw new Error(`unknown profile ${name}`);
  return p;
}

/** Every mcp tool the spike servers expose, full names. */
export function allMcpTools() {
  return [...Object.keys(MC_TOOLS).map(mc), ...PC_TOOLS.map(pc)];
}

/** Full names of the mcp tools the model should see in this profile. */
export function visibleMcpTools(p) {
  return [...p.mc.map(mc), ...(p.pc ? PC_TOOLS.map(pc) : [])];
}

/** Every tool name (built-ins + mcp) the model should see in this profile. */
export function visibleTools(p) {
  const builtins = BUILTIN_TOOLS.filter((t) => p.web || !WEB_TOOLS.includes(t));
  return [...builtins, ...visibleMcpTools(p)].sort();
}

/**
 * Permission deny rules that hide everything the profile must not see: the whole pc server by its
 * server-level rule (`mcp__pc`), single mc tools by exact name, and the web built-ins by name.
 * Host built-ins stay in options.disallowedTools (a lower layer the flag layer cannot clear).
 */
export function denyRules(p) {
  const hiddenMc = Object.keys(MC_TOOLS)
    .filter((n) => !p.mc.includes(n))
    .map(mc);
  return [...(p.pc ? [] : ['mcp__pc']), ...hiddenMc, ...(p.web ? [] : WEB_TOOLS)];
}

/** M2: the mcp server names a profile keeps registered (setMcpServers replaces the dynamic set). */
export function mcpServerNames(p) {
  return p.pc ? ['mc', 'pc'] : ['mc'];
}

/** Whether a tool name is allowed in a profile (the spike's ToolGate). Built-ins outside mc/pc are not decided here. */
export function gateAllows(p, toolName) {
  if (toolName.startsWith('mcp__mc__')) return p.mc.includes(toolName.slice('mcp__mc__'.length));
  if (toolName.startsWith('mcp__pc__')) return p.pc && PC_TOOLS.includes(toolName.slice('mcp__pc__'.length));
  if (WEB_TOOLS.includes(toolName)) return p.web;
  return null;
}

const TOOL_TOKEN =
  /\b(mcp__[a-z0-9_]+__[a-z0-9_]+|[A-Z][A-Za-z]+(?:Search|Fetch|Mode|Question)|ToolSearch)\b/g;

/** Tool names a model listed in free text ("tools=a, b, c"), deduplicated and sorted. */
export function parseToolList(text) {
  if (typeof text !== 'string') return [];
  return [...new Set(text.match(TOOL_TOKEN) ?? [])].sort();
}

/** Expected vs observed tool names. `extra` = seen but should be hidden; `missing` = should be seen but is not. */
export function compareTools(expected, observed) {
  const e = new Set(expected);
  const o = new Set(observed);
  return {
    missing: [...e].filter((t) => !o.has(t)).sort(),
    extra: [...o].filter((t) => !e.has(t)).sort(),
  };
}

/** Restrict a list of tool names to the ones this spike manages (mc, pc, web), dropping other built-ins. */
export function managedOnly(names) {
  const managed = new Set([...allMcpTools(), ...WEB_TOOLS]);
  return names.filter((n) => managed.has(n)).sort();
}
