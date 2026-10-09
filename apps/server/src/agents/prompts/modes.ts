/**
 * The mode-specific prompt text (agents/modes.ts): the persona section of each mode, the MODE banner that opens the
 * first turn after a mode switch, and ToolGate's teaching text for a tool outside the current mode.
 *
 * Everything here is built from Node-controlled values only (the session nonce, the player's validated name, the
 * catalog), and a mode's banner is the same text every time that agent enters the mode, so it never varies within a
 * mode (the PC, the task and the meeting arrive in their own messages).
 */

import { TOOL_ALIASES } from '../constants.js';
import { control } from '../envelope.js';
import {
  type BrainMode,
  hasEveryMcTool,
  hasEveryPcTool,
  hiddenMcTools,
  MODE_PROFILES,
  type ModeProfile,
} from '../modes.js';
import { MC_PREFIX, PC_PREFIX } from '../tools/catalog.js';

/** The persona section of each mode (what the system prompt's "## Modes" section points at). */
export function modeSection(mode: BrainMode, playerName: string): readonly string[] {
  const p = playerName;
  switch (mode) {
    case 'wander':
      return [
        `Your body has reflexes that already eat, flee, fight, shelter and feed ${p}. Don't micromanage them.`,
        'The mcp__mc__* tools move your body and observe the world. World jobs are long: when a tool says "running", END YOUR TURN. You will be woken with the result.',
        'To use a computer, walk to an office PC and call mcp__mc__sit_at_pc with a purpose; PC mode starts with your next turn.',
      ];
    case 'seated':
      return [
        'You sit at a real computer in the office and drive it. Bash, Read, Edit, Write, Glob and Grep run inside this PC (there is no shell anywhere else), and the screen tools see and click its desktop.',
        `You work on ${p}'s Vault folders, which have the same path inside the PC. Prefer the shell for code and the screen for GUIs.`,
        'Your body stays in the chair. Its reflexes still guard it, and you are stood up at once when you are attacked or starving; mcp__mc__status and mcp__mc__look_around show what goes on around you.',
        `When you finish, tell ${p} the result in 1-2 sentences, then call mcp__mc__stand_up.`,
        // USER DECISION 2026-10-08: no automatic plan mode (EnterPlanMode is gone; ExitPlanMode is for plan-first only).
        `You never switch yourself into plan mode. Only when ${p} turns on Plan-first for you does a PC session start in plan mode; the kickoff then says so, and ExitPlanMode shows ${p} your plan. Otherwise just do the work.`,
      ];
    case 'meeting':
      return [
        'You sit at the meeting table with the crew. Listen, and answer briefly when it is your turn.',
        'Take notes with mcp__mc__remember or the Codex, and put follow-ups on the calendar.',
        'The meeting ends on its own; mcp__mc__stand_up leaves early.',
      ];
  }
}

const WHERE: Readonly<Record<BrainMode, string>> = {
  wander: 'you are on your feet in the world',
  seated: 'you sit at an office PC',
  meeting: 'you sit at the meeting table',
};

const BLOCKED_UNTIL: Readonly<Record<BrainMode, string>> = {
  wander: 'Not available until you sit at a PC',
  seated: 'Blocked until you stand up (mcp__mc__stand_up)',
  meeting: 'Blocked until the meeting ends or you stand up',
};

/** World tools named as examples of what a mode leaves out, in this order. */
const EXAMPLES = ['goto', 'mine', 'craft', 'build', 'sit_at_pc', 'inventory'];

/** The `mcp__mc__` tools of a mode as one short list: `status, look_around, stand_up, …`. */
function mcList(p: ModeProfile): string {
  return p.mc.join(', ');
}

/** One host alias per pc tool, in alias order (`TaskStop` and `KillShell` both stop a task: `TaskStop` is named). */
function aliasNames(p: ModeProfile): string[] {
  const targets = new Set<string>();
  return p.aliases.filter((alias) => {
    const target = TOOL_ALIASES[alias] ?? alias;
    if (targets.has(target)) return false;
    targets.add(target);
    return true;
  });
}

/** "Available now: …" of a mode. */
export function availableText(p: ModeProfile): string {
  const parts: string[] = [];
  if (hasEveryPcTool(p)) {
    parts.push(`${aliasNames(p).join(', ')} and every other ${PC_PREFIX}* tool, all running inside the PC`);
  } else if (p.pc.length > 0) {
    parts.push(p.pc.map((t) => `${PC_PREFIX}${t}`).join(', '));
  }
  // ExitPlanMode is for plan-first sessions only: the kickoff names it when it applies.
  const builtins = p.builtins.filter((b) => b !== 'ExitPlanMode');
  if (builtins.length > 0) parts.push(builtins.join(', '));
  if (hasEveryMcTool(p)) parts.push(`every ${MC_PREFIX}* tool`);
  else if (p.mc.length > 0) parts.push(`from ${MC_PREFIX} only ${mcList(p)}`);
  return parts.join('; ');
}

/** "Blocked until …: …" of a mode. */
export function blockedText(p: ModeProfile): string {
  const parts: string[] = [];
  const hidden = hiddenMcTools(p);
  if (hidden.length > 0) {
    const examples = EXAMPLES.filter((t) => (hidden as readonly string[]).includes(t));
    const eg = examples.length > 0 ? ` (${examples.join(', ')}, …)` : '';
    parts.push(p.mc.length > 0 ? `every other ${MC_PREFIX}* tool${eg}` : `every ${MC_PREFIX}* tool`);
  }
  if (p.pc.length === 0)
    parts.push(`the PC tools (Bash, Read, Edit, Write, Glob, Grep and the other ${PC_PREFIX}* tools)`);
  if (!p.builtins.includes('WebSearch')) parts.push('WebSearch and WebFetch');
  return parts.join(', ');
}

export interface ModeBannerInput {
  readonly nonce: string;
  readonly playerName: string;
}

/**
 * The MODE banner: `[MV:<nonce> MODE] PC mode: you sit at an office PC.`, the mode's persona section, then what is
 * available now and what is blocked until when. It opens the first turn after a mode switch.
 */
export function modeBanner(mode: BrainMode, input: ModeBannerInput): string {
  const p = MODE_PROFILES[mode];
  const lines = [control(input.nonce, 'MODE', `${p.title}: ${WHERE[mode]}.`)];
  for (const line of modeSection(mode, input.playerName)) lines.push(`- ${line}`);
  lines.push(`Available now: ${availableText(p)}.`);
  const blocked = blockedText(p);
  if (blocked.length > 0) lines.push(`${BLOCKED_UNTIL[mode]}: ${blocked}.`);
  return lines.join('\n');
}

/** ToolGate's teaching text for `toolName` outside `mode` (a call the seat rules alone would have allowed). */
export function outsideModeText(mode: BrainMode, toolName: string): string {
  const p = MODE_PROFILES[mode];
  switch (mode) {
    case 'seated':
      return `${toolName} is not available in PC mode. Stand up first (mcp__mc__stand_up). Here you have the computer tools, ${p.builtins.filter((b) => b !== 'ExitPlanMode').join(', ')} and from ${MC_PREFIX} only ${mcList(p)}.`;
    case 'meeting':
      return `${toolName} is not available in Meeting mode. At the table you have ${p.builtins.join(', ')} and from ${MC_PREFIX} only ${mcList(p)}; the rest comes back when the meeting ends.`;
    case 'wander':
      return `${toolName} works only in PC mode: walk to an office PC and call mcp__mc__sit_at_pc.`;
  }
}
