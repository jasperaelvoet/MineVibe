/**
 * EventRouter and Digest (PLAN §6.5 "Layer 2" and "Layer 3"): what a game or crew event does to which brain.
 *
 * - **Digest:** info and notable events (urgency 0-1) are buffered per agent and prepended to the next turn as one
 *   short block; they never wake anyone.
 * - **Wakes** go through the BrainScheduler by priority: P0 player, P1 kickoff / scheduled task, P2 own critical
 *   event, P3 job / hire decision / tell / failed task report, P4 autonomous nudges (per autonomy and budget).
 * - **Context** (`shouldQuery:false`) adds text without a turn: reflex outcomes, `report_task{done}`, digest refreshes.
 *
 * The router is pure apart from its rate-limit memory; the caller supplies the crew view and the clock.
 */

import type { AgentRole, Autonomy, PayloadOf } from '@minevibe/protocol';
import type { WakePriority } from './BrainScheduler.js';
import { AUTONOMY_BUDGET_PER_HOUR, AUTONOMY_MIN_GAP_MS, HEARTBEAT_MS, IDLE_NUDGE_MS } from './constants.js';
import { type ControlKind, control, escapeShared, singleLine, wrapNote } from './envelope.js';
import type { UsageMode } from './UsageGovernor.js';

/** One queued item for an agent. */
export type Routed =
  | {
      readonly mode: 'wake';
      readonly priority: WakePriority;
      readonly kind: ControlKind | 'PLAYER';
      readonly text: string;
      /** Items with the same key replace each other (coalescing). */
      readonly key?: string | undefined;
      /** Interrupt the running turn (`priority:'now'`). */
      readonly now?: boolean | undefined;
      /** Charged to the agent's autonomous budget. */
      readonly autonomous?: boolean | undefined;
    }
  | { readonly mode: 'context'; readonly text: string }
  | { readonly mode: 'digest'; readonly line: string };

export interface RoutedFor {
  readonly agentId: string;
  readonly item: Routed;
}

/** What the router needs to know about one crew member. */
export interface RouterAgent {
  readonly agentId: string;
  readonly name: string;
  readonly handle: string;
  readonly role: AgentRole;
  readonly ceo: boolean;
  readonly alive: boolean;
  readonly seated: boolean;
  readonly nonce: string;
  readonly autonomy: Autonomy;
  /** Blocks to the player from the last `agent.state`, or null. */
  readonly playerDistance: number | null;
}

/** Digest lines kept per agent; older lines drop off. */
export const DIGEST_MAX_LINES = 8;
const DIGEST_LINE_MAX = 120;

export class Digest {
  #lines: string[] = [];

  /**
   * Adds a line. Lines carry game and crew text (mob and item names, other agents' report notes) and end up inside
   * a nonce-tagged notice, so look-alike tags and envelope delimiters are made inert here.
   */
  push(line: string): void {
    const flat = escapeShared(line).replace(/\s+/g, ' ').trim();
    if (flat.length === 0) return;
    const clipped = flat.length > DIGEST_LINE_MAX ? `${flat.slice(0, DIGEST_LINE_MAX - 1)}…` : flat;
    if (this.#lines.at(-1) === clipped) return;
    this.#lines.push(clipped);
    if (this.#lines.length > DIGEST_MAX_LINES) this.#lines.splice(0, this.#lines.length - DIGEST_MAX_LINES);
  }

  get size(): number {
    return this.#lines.length;
  }

  /** The block for the next turn (and clears it), or null when empty. */
  take(nonce: string): string | null {
    if (this.#lines.length === 0) return null;
    const block = control(nonce, 'DIGEST', `Since your last turn: ${this.#lines.join('; ')}.`);
    this.#lines = [];
    return block;
  }
}

/** Minimum spacing of the same critical wake per agent (full design §5.8). */
const CRITICAL_GAP_MS: Partial<Record<string, number>> = { hp_critical: 60_000, starving: 120_000 };
const PLAYER_LOW_HP_DEBOUNCE_MS = 60_000;
const PLAYER_LOW_HP_RANGE = 32;
/** Agent-to-agent tells: at most one wake per pair per this gap, and this many per receiver per hour. */
const TELL_PAIR_GAP_MS = 30_000;
const TELL_WAKES_PER_HOUR = 20;

export class EventRouter {
  readonly #now: () => number;
  readonly #lastCritical = new Map<string, number>();
  #lastPlayerLowHp = Number.NEGATIVE_INFINITY;
  readonly #lastTell = new Map<string, number>();
  readonly #tellWakes = new Map<string, number[]>();
  readonly #autonomous = new Map<string, number[]>();
  readonly #playerName: () => string;

  constructor(options: { now?: () => number; playerName?: () => string } = {}) {
    this.#now = options.now ?? Date.now;
    this.#playerName = options.playerName ?? (() => 'the player');
  }

  /** An `agent.event` from the mod. `kicked` / `unseated` are handled by the seat flow, not here. */
  agentEvent(event: PayloadOf<'agent.event'>, crew: readonly RouterAgent[]): RoutedFor[] {
    const self = crew.find((a) => a.agentId === event.agentId && a.alive);
    if (event.kind === 'player_low_hp') return this.#playerLowHp(crew);
    if (!self) return [];
    if (event.kind === 'kicked' || event.kind === 'unseated') return [];
    if (event.urgency <= 1) return [{ agentId: self.agentId, item: { mode: 'digest', line: event.text } }];

    const gap = CRITICAL_GAP_MS[event.kind] ?? 30_000;
    const key = `${self.agentId}:${event.kind}`;
    const last = this.#lastCritical.get(key);
    const now = this.#now();
    if (last !== undefined && now - last < gap) {
      return [{ agentId: self.agentId, item: { mode: 'digest', line: event.text } }];
    }
    this.#lastCritical.set(key, now);
    return [
      {
        agentId: self.agentId,
        item: {
          mode: 'wake',
          priority: 2,
          kind: 'CRITICAL',
          text: control(self.nonce, 'CRITICAL', singleLine(event.text, 300)),
          key: `critical:${event.kind}`,
        },
      },
    ];
  }

  /** PLAN §6.5: wakes only the Guard and the nearest wandering agent within 32 blocks; debounced 60 s. */
  #playerLowHp(crew: readonly RouterAgent[]): RoutedFor[] {
    const now = this.#now();
    if (now - this.#lastPlayerLowHp < PLAYER_LOW_HP_DEBOUNCE_MS) return [];
    const targets = new Set<RouterAgent>();
    for (const a of crew) if (a.alive && a.role === 'guard' && !a.seated) targets.add(a);
    const nearest = crew
      .filter(
        (a) => a.alive && !a.seated && a.playerDistance !== null && a.playerDistance <= PLAYER_LOW_HP_RANGE,
      )
      .sort((a, b) => (a.playerDistance ?? 0) - (b.playerDistance ?? 0))[0];
    if (nearest) targets.add(nearest);
    if (targets.size === 0) return [];
    this.#lastPlayerLowHp = now;
    const player = this.#playerName();
    return [...targets].map((a) => ({
      agentId: a.agentId,
      item: {
        mode: 'wake' as const,
        priority: 2 as const,
        kind: 'PLAYER LOW HP' as const,
        text: control(
          a.nonce,
          'PLAYER LOW HP',
          `${player} is below 30% health. Help if you can (reflexes already fight and feed).`,
        ),
        key: 'player_low_hp',
      },
    }));
  }

  /** A job that returned `running` ended (P3, coalesced per job). */
  jobEnded(agent: RouterAgent, end: PayloadOf<'skill.result'>, label: string): RoutedFor {
    const kind: ControlKind = end.status === 'done' ? 'JOB DONE' : 'JOB FAILED';
    const detail =
      end.status === 'done'
        ? summarizeResult(end.result)
        : end.status === 'cancelled'
          ? 'cancelled'
          : `${end.error?.code ?? 'FAILED'}: ${end.error?.msg ?? 'failed'}`;
    return {
      agentId: agent.agentId,
      item: {
        mode: 'wake',
        priority: 3,
        kind,
        text: control(agent.nonce, kind, singleLine(`${end.jobId} ${label}: ${detail}`, 400)),
        key: `job:${end.jobId}`,
      },
    };
  }

  /** `mcp__mc__tell` from one agent to another (P3; ping-pong limited). */
  tell(from: RouterAgent, to: RouterAgent, text: string): RoutedFor {
    const now = this.#now();
    const note = wrapNote({ author: `${from.name} (agent)`, kind: 'tell', text });
    const pair = `${from.agentId}>${to.agentId}`;
    const hour = (this.#tellWakes.get(to.agentId) ?? []).filter((t) => now - t < 3_600_000);
    const lastPair = this.#lastTell.get(pair);
    const throttled =
      (lastPair !== undefined && now - lastPair < TELL_PAIR_GAP_MS) || hour.length >= TELL_WAKES_PER_HOUR;
    if (throttled) {
      return {
        agentId: to.agentId,
        item: { mode: 'context', text: `${control(to.nonce, 'TELL', `From @${from.handle}:`)}\n${note}` },
      };
    }
    this.#lastTell.set(pair, now);
    hour.push(now);
    this.#tellWakes.set(to.agentId, hour);
    return {
      agentId: to.agentId,
      item: {
        mode: 'wake',
        priority: 3,
        kind: 'TELL',
        text: `${control(to.nonce, 'TELL', `From @${from.handle} (reply with mcp__mc__tell if needed):`)}\n${note}`,
      },
    };
  }

  /** A teammate died: one P2 wake for the CEO, context for the others. */
  teammateDied(dead: RouterAgent, cause: string, crew: readonly RouterAgent[]): RoutedFor[] {
    return crew
      .filter((a) => a.alive && a.agentId !== dead.agentId)
      .map((a) => {
        const text = control(a.nonce, 'TEAMMATE DIED', `${dead.name} died: ${singleLine(cause, 200)}.`);
        return a.ceo
          ? {
              agentId: a.agentId,
              item: { mode: 'wake' as const, priority: 2 as const, kind: 'TEAMMATE DIED' as const, text },
            }
          : { agentId: a.agentId, item: { mode: 'context' as const, text } };
      });
  }

  /** A calendar task fired for an assignee (P1, after its current turn). */
  scheduled(agent: RouterAgent, fired: PayloadOf<'calendar.fired'>, task: string | null): RoutedFor {
    const body = task ? `${fired.title}: ${task}` : fired.title;
    return {
      agentId: agent.agentId,
      item: {
        mode: 'wake',
        priority: 1,
        kind: 'SCHEDULED',
        text: `${control(agent.nonce, 'SCHEDULED', `Calendar task ${fired.eventId} (occurrence ${fired.occurrence}). When done, call mcp__mc__report_task{eventId:"${fired.eventId}", status}.`)}\n${wrapNote({ author: 'calendar', kind: 'calendar', attrs: { event: fired.eventId }, text: body })}`,
        key: `scheduled:${fired.eventId}:${fired.occurrence}`,
      },
    };
  }

  /** `report_task`: failed/blocked wake the CEO (P3); done goes to its digest. */
  taskReport(
    reporter: RouterAgent,
    ceo: RouterAgent | undefined,
    report: { eventId: string; status: 'done' | 'failed' | 'blocked'; note?: string | undefined },
  ): RoutedFor[] {
    if (!ceo || ceo.agentId === reporter.agentId) return [];
    // The event id and the note are the reporter's own words: quoted, never part of the notice itself.
    const eventId = singleLine(report.eventId, 64);
    const line = `${reporter.name} reported ${eventId} ${report.status}${report.note ? ` (their note: "${report.note}")` : ''}`;
    if (report.status === 'done') return [{ agentId: ceo.agentId, item: { mode: 'digest', line } }];
    return [
      {
        agentId: ceo.agentId,
        item: {
          mode: 'wake',
          priority: 3,
          kind: 'TASK REPORT',
          text: `${control(ceo.nonce, 'TASK REPORT', `@${reporter.handle} reported ${eventId} ${report.status}:`)}\n${wrapNote({ author: `${reporter.name} (agent)`, kind: 'tell', text: report.note ?? '(no note)' })}`,
        },
      },
    ];
  }

  /**
   * Idle nudges and heartbeats (P4) per autonomy: Listen never; Helpful one nudge after 2 min of silence; Proactive
   * a heartbeat every 3 min. Budgeted per hour, at least 30 s apart, never while Tired or Asleep.
   */
  autonomousWake(
    agent: RouterAgent,
    idleMs: number,
    sinceLastAutonomousMs: number | null,
    usage: UsageMode,
  ): RoutedFor | null {
    if (!agent.alive || usage !== 'normal') return null;
    const budget = AUTONOMY_BUDGET_PER_HOUR[agent.autonomy];
    if (budget === 0) return null;
    const now = this.#now();
    const hour = (this.#autonomous.get(agent.agentId) ?? []).filter((t) => now - t < 3_600_000);
    if (hour.length >= budget) return null;
    if (hour.length > 0 && now - (hour.at(-1) ?? 0) < AUTONOMY_MIN_GAP_MS) return null;
    let kind: ControlKind;
    if (agent.autonomy === 'helpful') {
      if (idleMs < IDLE_NUDGE_MS || sinceLastAutonomousMs !== null) return null; // one nudge per silence
      kind = 'IDLE';
    } else {
      if (idleMs < HEARTBEAT_MS || (sinceLastAutonomousMs !== null && sinceLastAutonomousMs < HEARTBEAT_MS))
        return null;
      kind = 'HEARTBEAT';
    }
    hour.push(now);
    this.#autonomous.set(agent.agentId, hour);
    return {
      agentId: agent.agentId,
      item: {
        mode: 'wake',
        priority: 4,
        kind,
        text: control(
          agent.nonce,
          kind,
          kind === 'IDLE'
            ? 'You have been idle for a while. If something useful needs doing, do it; otherwise end your turn quietly with (silent).'
            : 'Heartbeat: check on the crew and your work; act if needed, otherwise end your turn with (silent).',
        ),
        key: 'autonomous',
        autonomous: true,
      },
    };
  }
}

/** A one-line summary of a job result object. */
export function summarizeResult(result: Record<string, unknown> | undefined): string {
  if (!result || Object.keys(result).length === 0) return 'done';
  if (typeof result.summary === 'string') return result.summary.slice(0, 200);
  const text = JSON.stringify(result);
  return text.length > 200 ? `${text.slice(0, 199)}…` : text;
}
