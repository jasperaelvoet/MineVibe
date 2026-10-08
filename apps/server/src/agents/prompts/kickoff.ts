/**
 * Messages Node writes into a session (never into the system prompt): the PC kickoff, the welcome of a new agent,
 * restart notices, memory and roster context. Shared text always goes through the data envelope.
 */

import type { PcGuestInfo } from '../../contracts/PcApi.js';
import { geometryFor } from '../tools/pc/geometry.js';
import { type BaseArea, posText } from '../../world/baseArea.js';
import { control, escapeShared, wrapNote } from '../envelope.js';
import type { HandoffNote } from '../memory.js';

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
}

/** The P1 kickoff after the swap to Opus (PLAN §6.3 "Swaps happen only at turn boundaries" step 3). */
export function kickoffMessage(input: KickoffInput): string {
  const pc = input.pc;
  const lines = [
    control(
      input.nonce,
      'KICKOFF',
      `You are seated at ${pc.pcId} (${pc.type}, ${pc.os}, screen ${pc.screen.w}x${pc.screen.h}). You are now the brain of this PC session.`,
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
