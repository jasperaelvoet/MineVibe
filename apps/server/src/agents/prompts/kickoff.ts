/**
 * Messages Node writes into a session (never into the system prompt): the PC kickoff, the welcome of a new agent,
 * restart notices, memory and roster context. Shared text always goes through the data envelope.
 */

import type { PcGuestInfo } from '../../contracts/PcApi.js';
import { type BaseArea, posText } from '../../world/baseArea.js';
import { control, escapeShared, wrapNote } from '../envelope.js';
import type { HandoffNote } from '../memory.js';
import { geometryFor } from '../tools/pc/geometry.js';

/** Largest CLAUDE.md excerpt in a kickoff (≈2k tokens). */
export const CLAUDE_MD_EXCERPT_CHARS = 8_000;

export interface KickoffInput {
  readonly nonce: string;
  readonly playerName: string;
  readonly pc: PcGuestInfo;
  /** `sit_at_pc{purpose}`. */
  readonly task: string | null;
  readonly planFirst: boolean;
  /** CLAUDE.md of the primary mount, if any (already clipped or not). */
  readonly claudeMd: { readonly path: string; readonly text: string } | null;
  readonly handoffs: readonly HandoffNote[];
  /** The desk session continues an earlier one at this PC (resumed), or starts fresh. */
  readonly resumed?: boolean | undefined;
  /** The player's latest lines to this agent, oldest first, verbatim (the handoff quotes them). */
  readonly playerLines?: readonly string[] | undefined;
  /** The agent's `memory.md` ("" or absent: none). */
  readonly memory?: string | undefined;
  /** The Codex digest context (Node-made, already enveloped), or null. */
  readonly codexDigest?: string | null | undefined;
}

/**
 * The handoff that opens a desk session's turn at every sit (PLAN §6.3 "Handoffs"): the PC, the task, the player's
 * recent lines verbatim, the agent's memory, the Codex digest, the notes left at this PC and its Vault folders, the
 * mount's CLAUDE.md, plan-first, and how to work the PC.
 */
export function kickoffMessage(input: KickoffInput): string {
  const pc = input.pc;
  const lines = [
    control(
      input.nonce,
      'KICKOFF',
      input.resumed
        ? `You sat down at ${pc.pcId} again (${pc.type}, ${pc.os}, screen ${pc.screen.w}x${pc.screen.h}). Your earlier work at this PC is above; here is the handoff from your body.`
        : `You are seated at ${pc.pcId} (${pc.type}, ${pc.os}, screen ${pc.screen.w}x${pc.screen.h}). This is your PC session; here is the handoff from your body.`,
    ),
    `User ${pc.user}, home ${pc.home}.`,
  ];
  if (pc.mounts.length > 0) {
    lines.push(`${input.playerName}'s Vault folders (same absolute path inside the PC):`);
    for (const m of pc.mounts)
      lines.push(`- ${escapeShared(m.hostPath)} (${m.mode === 'rw' ? 'read-write' : 'read-only'})`);
  } else {
    lines.push(`No Vault folder is mounted on ${pc.pcId}; work in ${pc.home}.`);
  }
  if (pc.codexPath) lines.push(`The Codex is readable at ${pc.codexPath}.`);
  if (input.task) lines.push(`Your task: ${escapeShared(input.task)}`);
  const said = (input.playerLines ?? []).map((l) => l.trim()).filter((l) => l.length > 0);
  if (said.length > 0) {
    lines.push(`What ${input.playerName} said to you lately (oldest first, word for word):`);
    for (const l of said) lines.push(`- ${input.playerName}: ${escapeShared(l).replace(/\s*\n\s*/g, ' / ')}`);
  }
  if (input.memory && input.memory.trim().length > 0) {
    lines.push(wrapNote({ author: 'your own memory', kind: 'memory', text: input.memory }));
  }
  if (input.codexDigest) lines.push(input.codexDigest);
  for (const note of input.handoffs) {
    lines.push(
      wrapNote({
        author: note.author,
        kind: 'handoff',
        attrs: { at: new Date(note.at).toISOString() },
        text: note.text,
      }),
    );
  }
  if (input.claudeMd) {
    const text =
      input.claudeMd.text.length > CLAUDE_MD_EXCERPT_CHARS
        ? `${input.claudeMd.text.slice(0, CLAUDE_MD_EXCERPT_CHARS)}\n… (truncated; read the file for the rest)`
        : input.claudeMd.text;
    lines.push(
      wrapNote({ author: 'project CLAUDE.md', kind: 'mount', attrs: { path: input.claudeMd.path }, text }),
    );
  }
  if (input.planFirst) {
    lines.push(
      `Plan first: you are in plan mode. Look around read-only, write your plan to ~/.claude/plans/<name>.md, then call ExitPlanMode so ${input.playerName} can approve it.`,
    );
  }
  lines.push(pcPrimer(pc, input.playerName));
  lines.push(
    `When you are done, tell ${input.playerName} the result in 1-2 sentences, then call mcp__mc__stand_up.`,
  );
  return lines.join('\n');
}

/**
 * How to work a PC with the V2 `pc` tools (≈180 tokens, seated kickoffs only): coordinates, text-first perception,
 * batched GUI steps, and the shell for code.
 */
export function pcPrimer(pc: PcGuestInfo, playerName: string): string {
  const g = geometryFor(pc.screen);
  return [
    'How to work this PC:',
    `- Screenshots are ${g.imgW}x${g.imgH}; every coordinate is a pixel of them, origin top-left.`,
    '- Look with ui (find, text) first: exact text and ref_N elements for a fraction of a screenshot. Use screenshot or zoom when an app shows no tree.',
    '- Do several GUI steps in one turn (left_click, type, key "ctrl+s"); they run in order and the last one answers with a screenshot.',
    '- open starts a URL, file or app and waits for its window; wait_for waits for text, a window or a still screen.',
    '- Code and files: bash, read, edit, write, grep, glob, not the GUI. Long commands: bash run_in_background (you are notified when they end).',
    `- What you open closes when you stand up. Leave the "Shell: …" window open: ${playerName} watches your commands there.`,
  ].join('\n');
}

/** How a desk session's sit ended, for the DESK REPORT. */
export type DeskOutcome = 'done' | 'interrupted' | 'kicked';

/** One foreground `pc__bash` command and its exit code. */
export interface DeskCommand {
  readonly command: string;
  readonly exitCode: number;
}

export interface DeskReportInput {
  readonly nonce: string;
  readonly playerName: string;
  readonly pcId: string;
  readonly outcome: DeskOutcome;
  /** Why the sit ended, when the agent did not stand up itself ("Jasper kicked you off linux-1 mid-task."). */
  readonly why?: string | null | undefined;
  /** The desk session's last words at this sit (its final text), or null. */
  readonly summary: string | null;
  /** Files the desk wrote or edited at this sit, oldest first. */
  readonly changedFiles: readonly string[];
  /** The last foreground commands at this sit, oldest first. */
  readonly commands: readonly DeskCommand[];
}

/** Files and commands a DESK REPORT names at most. */
export const DESK_REPORT_FILES = 8;
export const DESK_REPORT_COMMANDS = 3;

/**
 * The compact report that wakes the body session after a sit (PLAN §6.3 "Handoffs"): how it ended, the desk's last
 * words (enveloped: the body reads them as information), the files it changed and the exit codes of its last commands.
 */
export function deskReportMessage(input: DeskReportInput): string {
  const head =
    input.outcome === 'done'
      ? `You stood up from ${input.pcId} (outcome: done). You are on your feet again.`
      : `You are no longer at ${input.pcId} (outcome: ${input.outcome}). ${input.why ?? ''}`.trim();
  const lines = [control(input.nonce, 'DESK REPORT', head)];
  if (input.summary && input.summary.trim().length > 0) {
    lines.push(
      wrapNote({
        author: `your PC session at ${input.pcId}`,
        kind: 'session',
        text: input.summary,
        maxChars: 1_500,
      }),
    );
  } else {
    lines.push('Your PC session said nothing at the end.');
  }
  const files = [...new Set(input.changedFiles)];
  if (files.length > 0) {
    const shown = files.slice(-DESK_REPORT_FILES).map((f) => escapeShared(f));
    const more = files.length - shown.length;
    lines.push(`Files changed: ${shown.join(', ')}${more > 0 ? ` (+${more} more)` : ''}.`);
  }
  if (input.commands.length > 0) {
    const cmds = input.commands
      .slice(-DESK_REPORT_COMMANDS)
      .map((c) => `\`${escapeShared(c.command.split('\n')[0] ?? '').slice(0, 80)}\` exit ${c.exitCode}`);
    lines.push(`Last commands: ${cmds.join('; ')}.`);
  }
  lines.push(
    input.outcome === 'done'
      ? `If ${input.playerName} already heard the result, don't repeat it: carry on with what is next, or reply (silent).`
      : input.outcome === 'kicked'
        ? `Ask ${input.playerName} what they want, or do something else.`
        : 'Deal with that first; sit down again later to continue (your PC session picks up where it left off).',
  );
  return lines.join('\n');
}

/**
 * The KICKOFF when the PC's details could not be read at the sit (PcApi `info` failed): the handoff still carries the
 * task, the player's lines, the memory, the Codex digest and the notes, so nothing the body knew is lost; the desk
 * finds out about the PC itself (`pc__info`).
 */
export function kickoffWithoutPcMessage(
  input: Omit<KickoffInput, 'pc' | 'claudeMd'> & { readonly pcId: string },
): string {
  const lines = [
    control(
      input.nonce,
      'KICKOFF',
      `${input.resumed ? `You sat down at ${input.pcId} again; your earlier work at this PC is above.` : `You are seated at ${input.pcId}. This is your PC session.`} Its details could not be read just now (check with mcp__pc__info); here is the handoff from your body.`,
    ),
  ];
  if (input.task) lines.push(`Your task: ${escapeShared(input.task)}`);
  const said = (input.playerLines ?? []).map((l) => l.trim()).filter((l) => l.length > 0);
  if (said.length > 0) {
    lines.push(`What ${input.playerName} said to you lately (oldest first, word for word):`);
    for (const l of said) lines.push(`- ${input.playerName}: ${escapeShared(l).replace(/\s*\n\s*/g, ' / ')}`);
  }
  if (input.memory && input.memory.trim().length > 0) {
    lines.push(wrapNote({ author: 'your own memory', kind: 'memory', text: input.memory }));
  }
  if (input.codexDigest) lines.push(input.codexDigest);
  for (const note of input.handoffs) {
    lines.push(
      wrapNote({
        author: note.author,
        kind: 'handoff',
        attrs: { at: new Date(note.at).toISOString() },
        text: note.text,
      }),
    );
  }
  if (input.planFirst) {
    lines.push(
      `Plan first: you are in plan mode. Look around read-only, write your plan to ~/.claude/plans/<name>.md, then call ExitPlanMode so ${input.playerName} can approve it.`,
    );
  }
  lines.push(
    `When you are done, tell ${input.playerName} the result in 1-2 sentences, then call mcp__mc__stand_up.`,
  );
  return lines.join('\n');
}

export interface WelcomeInput {
  readonly nonce: string;
  readonly playerName: string;
  readonly worldGen: number;
  readonly ceo: boolean;
  /** Who hired this agent (for hires). */
  readonly hiredBy?: string | undefined;
  /** The first task the player approved on the hire card. */
  readonly firstTask?: string | undefined;
  /** The Chronicle paragraph (new CEO only). */
  readonly chronicle?: string | undefined;
  /** "The Codex survived." after a world death. */
  readonly codexSurvived?: boolean | undefined;
  /** Promoted after the previous CEO died. */
  readonly promotedFrom?: string | undefined;
  /** The Base of this world (`world.state.office`), when known: the welcome names it and its Codex page. */
  readonly base?: BaseArea | null | undefined;
}

/** The welcome's line about the Base: the player's home, what not to touch, where its Codex page is. */
export function baseLine(playerName: string, base: BaseArea): string {
  const door = base.door ? `, door at ${posText(base.door)}` : '';
  return `The ${base.name} is ${playerName}'s home (Codex page "${base.name}"${door}). Never break or take its blocks or anything ${playerName} builds; its chests, beds and tables are there to use. Gather wood and stone from nature outside it.`;
}

export function welcomeMessage(input: WelcomeInput): string {
  const p = input.playerName;
  const lines: string[] = [];
  if (input.hiredBy !== undefined) {
    lines.push(
      control(
        input.nonce,
        'WELCOME',
        `${p} approved your hire. You just walked into the office in World #${input.worldGen}. You report to ${escapeShared(input.hiredBy)} (the CEO) via mcp__mc__tell; ${p} is the boss.`,
      ),
    );
    if (input.base) lines.push(baseLine(p, input.base));
    if (input.firstTask) lines.push(`First task (approved by ${p}): ${escapeShared(input.firstTask)}`);
    lines.push('Say hello in one short sentence, then start.');
    return lines.join('\n');
  }
  lines.push(
    control(
      input.nonce,
      'WELCOME',
      `You just arrived in World #${input.worldGen}, a fresh hardcore world. ${p} is nearby; you start in Listen mode and follow ${p}.`,
    ),
  );
  if (input.base) lines.push(baseLine(p, input.base));
  if (input.codexSurvived)
    lines.push('The previous world ended, but the Codex survived: search it before asking.');
  if (input.chronicle) lines.push(wrapNote({ author: 'MineVibe', kind: 'chronicle', text: input.chronicle }));
  lines.push(`Greet ${p} in one short sentence, then wait for instructions.`);
  return lines.join('\n');
}

export function promotedMessage(nonce: string, previous: string, playerName: string): string {
  return control(
    nonce,
    'PROMOTED',
    `${escapeShared(previous)} died. You are now the CEO: you can hire (with ${playerName}'s approval) and schedule work for anyone. Tell ${playerName} in one sentence.`,
  );
}

export function restartNotice(nonce: string, seatedAt: string | null, pausedMs: number | null): string {
  const parts = ['The app restarted.'];
  if (pausedMs !== null && pausedMs > 60_000)
    parts.push(`The world was paused for ${formatDuration(pausedMs)}.`);
  if (seatedAt) parts.push(`You are no longer seated at ${seatedAt}.`);
  return control(nonce, 'RESTARTED', parts.join(' '));
}

/** "3h 5m", "12 min", "40 s". */
export function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export function memoryContext(nonce: string, memory: string): string | null {
  if (memory.trim().length === 0) return null;
  return `${control(nonce, 'MEMORY', 'What you wrote down earlier (your private memory.md):')}\n${wrapNote({ author: 'your own memory', kind: 'memory', text: memory })}`;
}

export interface RosterEntry {
  readonly name: string;
  readonly handle: string;
  readonly role: string;
  readonly ceo: boolean;
  readonly status: 'alive' | 'dead' | 'dismissed';
}

export function rosterContext(nonce: string, selfHandle: string, roster: readonly RosterEntry[]): string {
  const alive = roster.filter((r) => r.status === 'alive');
  const list = alive
    .map((r) => `${r.handle === selfHandle ? 'you' : `@${r.handle}`} ${r.name} (${r.ceo ? 'CEO' : r.role})`)
    .join(', ');
  return control(nonce, 'CREW', `Crew now: ${list || 'just you'}.`);
}
