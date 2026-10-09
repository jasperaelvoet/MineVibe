/**
 * Brain modes and their tool profiles (PLAN §6.2 "Tools per mode", §6.3 "Mode switch"; spike S3b).
 *
 * | Mode | Seat | Model (outside the re-sit debounce) | Tools |
 * |---|---|---|---|
 * | `wander` (Minecraft mode) | none, or walking to one | Haiku 5.5 / xhigh | every mc tool; no pc tools, aliases or web |
 * | `seated` (PC mode) | a PC: seated, pending swap, or away asking the player | Opus 5.5 / medium | every pc tool (Bash/Read/Edit/Write/Glob/Grep/TaskStop are aliases of theirs), WebSearch/WebFetch, a minimal mc set |
 * | `meeting` (Meeting mode) | the meeting table | as before the meeting | talk, notes, Codex, calendar, stand_up |
 *
 * Membership comes from the tool metadata in tools/catalog.ts, for both mc tool sets (v1 and v2, `MINEVIBE_MC_TOOLS`):
 * an untagged mc tool is wander-only and an untagged pc tool seated-only, so a new tool never leaks into another mode.
 *
 * What a profile is, and what it is not (spikes/s3b-mode-switch/result.md): Claude Code 2.1.293 pins the tool list the
 * model is offered to the conversation's first request (the pin survives `resume`), and deny rules never remove an MCP
 * tool. So every session keeps registering the full `mc` + `pc` servers (`alwaysLoad`), and the switch is a prompt-level
 * change made at the same turn boundary as the model/effort swap: the MODE banner (prompts/modes.ts: the mode's persona
 * section plus "available now / blocked until …") opens the first turn after that boundary, which is also the first
 * turn on the swapped model. ToolGate enforces the profile of the seat at call time and refuses a tool outside it with
 * teaching text, so a turn that keeps going after a mid-turn stand_up or kick is already held to the new profile.
 */

import {
  type BrainProfile,
  BUILTIN_TOOLS,
  type McToolsVersion,
  SEATED_PROFILE,
  TOOL_ALIASES,
  WANDERING_PROFILE,
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
  /**
   * The model and effort of the mode. The swap itself follows the SeatFSM (`wantsOpus`): its re-sit debounce keeps
   * Opus for a while after a PC seat ends (60 s; a meeting pulled from a PC stretches it over the meeting).
   */
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

const BRAINS: Readonly<Record<BrainMode, BrainProfile>> = {
  wander: WANDERING_PROFILE,
  seated: SEATED_PROFILE,
  meeting: WANDERING_PROFILE,
};

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
    brain: BRAINS[mode],
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
 * The mode a seat puts the agent in. A PC seat is PC mode from the moment the body sits (`seated_pending_swap`, where
 * ToolGate denies every call until the turn ends) and stays PC mode while the agent is away asking the player (the
 * chair is reserved, the turn is in flight). Walking to a seat and the rest of a turn after standing up are Minecraft
 * mode.
 */
export function modeForSeat(seat: Pick<SeatSnapshot, 'state' | 'kind'>): BrainMode {
  switch (seat.state) {
    case 'seated_pending_swap':
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
