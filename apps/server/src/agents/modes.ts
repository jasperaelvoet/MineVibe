/**
 * Brain modes and their tool profiles (PLAN §6.2 "Tools per mode", §6.3; spike S3b), and the two sessions they come
 * in (PLAN §6.1, dual sessions).
 *
 * | Mode | Seat | Session (fixed model) | Tools |
 * |---|---|---|---|
 * | `wander` (Minecraft mode) | none, or walking to one | body, Haiku 5.5 / xhigh | every mc tool; no pc tools, aliases or web |
 * | `seated` (PC mode) | a PC: seated, pending handoff, or away asking the player | desk, Opus 5.5 / medium | every pc tool (Bash/Read/Edit/Write/Glob/Grep/TaskStop are aliases of theirs), WebSearch/WebFetch, a minimal mc set |
 * | `meeting` (Meeting mode) | the meeting table | body | talk, notes, Codex, calendar, stand_up |
 *
 * Membership comes from the tool metadata in tools/catalog.ts, for both mc tool sets (v1 and v2, `MINEVIBE_MC_TOOLS`):
 * an untagged mc tool is wander-only and an untagged pc tool seated-only, so a new tool never leaks into another mode.
 *
 * Why two sessions (spikes/s3b-mode-switch/result.md): Claude Code 2.1.293 pins the tool list the model is offered to
 * the conversation's first request (the pin survives `resume`), and deny rules never remove an MCP tool. So one
 * session could never offer a smaller list per mode. Instead each agent has a BODY session whose list is the Minecraft
 * tools ({@link sessionMcTools} `body`: Minecraft and Meeting mode) and, per PC, a DESK session whose list is PC mode's
 * ({@link sessionMcTools} `desk`). Meeting mode stays a prompt-level switch inside the body session (the MODE banner,
 * prompts/modes.ts). ToolGate still enforces the profile of the seat at call time as a backstop, so a turn that keeps
 * going after a mid-turn stand_up or kick is held to the new profile.
 */

import {
  BODY_PROFILE,
  type BrainProfile,
  BUILTIN_TOOLS,
  DESK_PROFILE,
  type McToolsVersion,
  type SessionKind,
  TOOL_ALIASES,
} from './constants.js';
import type { SeatSnapshot } from './SeatFSM.js';
import {
  BRAIN_MODES,
  type BrainMode,
  BUILTIN_TOOL_MODES,
  MC_PREFIX,
  type McToolName,
  mcToolModes,
  mcToolName,
  mcToolsOf,
  PC_PREFIX,
  PC_TOOLS,
  type PcToolName,
  pcToolModes,
  pcToolName,
} from './tools/catalog.js';

export { BRAIN_MODES, type BrainMode };

/** Both mc tool sets. */
export const MC_TOOL_SETS: readonly McToolsVersion[] = ['v1', 'v2'];

/** One mode's tool surface, for one mc tool set. */
export interface ModeProfile {
  readonly mode: BrainMode;
  /** The mc tool set (`MINEVIBE_MC_TOOLS`). */
  readonly version: McToolsVersion;
  /** "Minecraft mode", "PC mode", "Meeting mode". */
  readonly title: string;
  /** The session the mode runs in: the body session (Minecraft and Meeting mode) or a desk session (PC mode). */
  readonly session: SessionKind;
  /** The session's fixed model and effort. */
  readonly brain: BrainProfile;
  readonly mc: readonly McToolName[];
  readonly pc: readonly PcToolName[];
  /** Built-ins of `options.tools` in this mode. */
  readonly builtins: readonly string[];
  /** Built-in names aliased to a pc tool of this mode (`Bash` → `mcp__pc__bash`, …). */
  readonly aliases: readonly string[];
}

const TITLES: Readonly<Record<BrainMode, string>> = {
  wander: 'Minecraft mode',
  seated: 'PC mode',
  meeting: 'Meeting mode',
};

const SESSIONS: Readonly<Record<BrainMode, SessionKind>> = {
  wander: 'body',
  seated: 'desk',
  meeting: 'body',
};

const BRAINS: Readonly<Record<SessionKind, BrainProfile>> = { body: BODY_PROFILE, desk: DESK_PROFILE };

/** The mc tools of a set, in catalog order. */
export function mcToolsIn(version: McToolsVersion): McToolName[] {
  return Object.keys(mcToolsOf(version)) as McToolName[];
}

function builtinModes(name: string): readonly BrainMode[] {
  return Object.hasOwn(BUILTIN_TOOL_MODES, name) ? (BUILTIN_TOOL_MODES[name] ?? []) : [];
}

function aliasTarget(name: string): string | null {
  return Object.hasOwn(TOOL_ALIASES, name) ? (TOOL_ALIASES[name] ?? null) : null;
}

function build(mode: BrainMode, version: McToolsVersion): ModeProfile {
  const pc = PC_TOOLS.filter((t) => pcToolModes(t).includes(mode));
  return Object.freeze({
    mode,
    version,
    title: TITLES[mode],
    session: SESSIONS[mode],
    brain: BRAINS[SESSIONS[mode]],
    mc: Object.freeze(mcToolsIn(version).filter((t) => mcToolModes(t).includes(mode))),
    pc: Object.freeze(pc),
    builtins: Object.freeze(BUILTIN_TOOLS.filter((t) => builtinModes(t).includes(mode))),
    aliases: Object.freeze(
      Object.keys(TOOL_ALIASES).filter((alias) => {
        const target = pcToolName(aliasTarget(alias) ?? '');
        return target !== null && pc.includes(target);
      }),
    ),
  });
}

function table(version: McToolsVersion): Readonly<Record<BrainMode, ModeProfile>> {
  return Object.freeze({
    wander: build('wander', version),
    seated: build('seated', version),
    meeting: build('meeting', version),
  });
}

/** The ModeProfile registry: per mc tool set, per mode. */
export const MODE_PROFILES: Readonly<Record<McToolsVersion, Readonly<Record<BrainMode, ModeProfile>>>> =
  Object.freeze({ v1: table('v1'), v2: table('v2') });

/** One mode's profile (default: the v1 tool set, like the rest of the runtime). */
export function modeProfile(mode: BrainMode, version: McToolsVersion = 'v1'): ModeProfile {
  return MODE_PROFILES[version][mode];
}

/**
 * The mode a seat puts the agent in. A PC seat is PC mode from the moment the body sits (`seated_pending_handoff`,
 * where ToolGate denies every call until the body's turn ends) and stays PC mode while the agent is away asking the
 * player (the chair is reserved, the desk's turn is in flight). Walking to a seat and the rest of a turn after standing
 * up are Minecraft mode.
 */
export function modeForSeat(seat: Pick<SeatSnapshot, 'state' | 'kind'>): BrainMode {
  switch (seat.state) {
    case 'seated_pending_handoff':
    case 'seated':
    case 'away_from_seat':
      return seat.kind === 'meeting' ? 'meeting' : 'seated';
    default:
      return 'wander';
  }
}

/**
 * Whether a tool belongs to `mode`: `mcp__mc__*` / `mcp__pc__*` by their catalog tags, a host alias (`Bash`) by its pc
 * target, a built-in by {@link BUILTIN_TOOL_MODES}. Anything unknown belongs to no mode. (Whether an mc tool is in the
 * session's tool set at all is ToolGate's first question; the tags of a shared name hold for both sets.)
 */
export function toolInMode(mode: BrainMode, toolName: string): boolean {
  const mc = mcToolName(toolName);
  if (mc !== null) return mcToolModes(mc).includes(mode);
  const pc = pcToolName(toolName);
  if (pc !== null) return pcToolModes(pc).includes(mode);
  const target = aliasTarget(toolName);
  if (target !== null) return toolInMode(mode, target);
  return builtinModes(toolName).includes(mode);
}

/** Every tool name of a mode (built-ins, aliases, `mcp__mc__*`, `mcp__pc__*`), sorted. */
export function profileToolNames(mode: BrainMode, version: McToolsVersion = 'v1'): string[] {
  const p = modeProfile(mode, version);
  return [
    ...p.builtins,
    ...p.aliases,
    ...p.mc.map((t) => `${MC_PREFIX}${t}`),
    ...p.pc.map((t) => `${PC_PREFIX}${t}`),
  ].sort();
}

/** Whether a mode has every mc tool of its set. */
export function hasEveryMcTool(p: ModeProfile): boolean {
  return p.mc.length === mcToolsIn(p.version).length;
}

/** Whether a mode has every pc tool. */
export function hasEveryPcTool(p: ModeProfile): boolean {
  return p.pc.length === PC_TOOLS.length;
}

/** The mc tools of its set a mode does not have, in catalog order. */
export function hiddenMcTools(p: ModeProfile): McToolName[] {
  return mcToolsIn(p.version).filter((t) => !p.mc.includes(t));
}

/**
 * The `mc` tools a session's server registers (PLAN §6.1, dual sessions): the body has every mc tool (Minecraft mode
 * has them all; Meeting mode is a subset the gate holds it to), a desk session only PC mode's minimal set.
 */
export function sessionMcTools(kind: SessionKind, version: McToolsVersion = 'v1'): readonly McToolName[] {
  return kind === 'desk' ? modeProfile('seated', version).mc : mcToolsIn(version);
}

/** The mode a session works in when nothing else is known: PC mode for a desk, Minecraft mode for the body. */
export function sessionMode(kind: SessionKind): BrainMode {
  return kind === 'desk' ? 'seated' : 'wander';
}
