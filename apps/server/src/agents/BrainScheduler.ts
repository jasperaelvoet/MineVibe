/**
 * BrainScheduler (PLAN §6.5): who may run a brain turn right now.
 *
 * - **Work lane:** at most 2 concurrent turns (1 while Tired), PC sessions included.
 * - **Interactive lane:** 1 reserved slot for P0 (player messages, resumed answered cards, the meeting speaker, last
 *   words). A P0 request takes the interactive slot first, then a free work slot.
 * - Requests wait in priority order (P0 player > P1 PC kickoff / scheduled > P2 critical > P3 jobs and social > P4
 *   autonomous), oldest first. An agent holds at most one slot; slots are released at `result` and while the agent
 *   waits on the player (a card).
 * - **Asleep:** nothing is granted until the governor wakes up.
 */

import type { BrainsSummary } from '@minevibe/protocol';
import { TypedEmitter } from '../util/TypedEmitter.js';
import { INTERACTIVE_LANE_SLOTS, WORK_LANE_SLOTS } from './constants.js';
import type { UsageMode } from './UsageGovernor.js';

/** Wake priority: 0 player … 4 autonomous (PLAN §6.5 "Layer 3"). */
export type WakePriority = 0 | 1 | 2 | 3 | 4;
export type Lane = 'work' | 'interactive';

export interface Grant {
  readonly agentId: string;
  readonly lane: Lane;
  readonly priority: WakePriority;
  readonly grantedAt: number;
  /** Frees the slot (idempotent). */
  release(): void;
  readonly released: boolean;
}

interface Waiter {
  readonly agentId: string;
  readonly priority: WakePriority;
  readonly seq: number;
  readonly at: number;
  readonly resolve: (grant: Grant) => void;
  readonly reject: (err: Error) => void;
}

export class SchedulerCancelled extends Error {
  constructor(agentId: string) {
    super(`brain request for ${agentId} was cancelled`);
    this.name = 'SchedulerCancelled';
  }
}

export type SchedulerEvents = { change: [summary: Pick<BrainsSummary, 'inFlight' | 'queued' | 'max'>] };

/** How a queued wake will be read, for the echo ("queued: Ada is mid-task, reads this at her next step"). */
export interface QueueEstimate {
  readonly running: boolean;
  readonly waiting: boolean;
  /** Requests ahead of this agent's. */
  readonly ahead: number;
  readonly asleep: boolean;
}

export class BrainScheduler extends TypedEmitter<SchedulerEvents> {
  readonly #work: number;
  readonly #interactive: number;
  readonly #now: () => number;
  readonly #active = new Map<string, Grant>();
  #queue: Waiter[] = [];
  #seq = 0;
  #mode: UsageMode = 'normal';

  constructor(options: { workSlots?: number; interactiveSlots?: number; now?: () => number } = {}) {
    super();
    this.#work = options.workSlots ?? WORK_LANE_SLOTS;
    this.#interactive = options.interactiveSlots ?? INTERACTIVE_LANE_SLOTS;
    this.#now = options.now ?? Date.now;
  }

  get mode(): UsageMode {
    return this.#mode;
  }

  /** Work slots in the current mode. */
  get workCap(): number {
    if (this.#mode === 'asleep') return 0;
    return this.#mode === 'tired' ? Math.min(1, this.#work) : this.#work;
  }

  get interactiveCap(): number {
    return this.#mode === 'asleep' ? 0 : this.#interactive;
  }

  setMode(mode: UsageMode): void {
    if (mode === this.#mode) return;
    this.#mode = mode;
    this.#pump();
    this.#changed();
  }

  /** The agent's current grant, if it holds a slot. */
  grantOf(agentId: string): Grant | undefined {
    return this.#active.get(agentId);
  }

  isWaiting(agentId: string): boolean {
    return this.#queue.some((w) => w.agentId === agentId);
  }

  /**
   * Resolves with a slot for `agentId`. An agent that already holds one gets the same grant back; a second request
   * while one waits joins it with the better priority.
   */
  acquire(agentId: string, priority: WakePriority): Promise<Grant> {
    const held = this.#active.get(agentId);
    if (held) return Promise.resolve(held);
    return new Promise<Grant>((resolve, reject) => {
      const existing = this.#queue.find((w) => w.agentId === agentId);
      if (existing) {
        // Merge: the earlier waiter keeps its place; a better priority replaces it.
        const merged: Waiter = {
          ...existing,
          priority: Math.min(existing.priority, priority) as WakePriority,
          resolve: (g) => {
            existing.resolve(g);
            resolve(g);
          },
          reject: (e) => {
            existing.reject(e);
            reject(e);
          },
        };
        this.#queue = this.#queue.map((w) => (w === existing ? merged : w));
      } else {
        this.#queue.push({ agentId, priority, seq: ++this.#seq, at: this.#now(), resolve, reject });
      }
      this.#pump();
      this.#changed();
    });
  }

  /** Drops the agent's queued request (dismissal, death, world end) and releases its slot. */
  cancel(agentId: string): void {
    const waiting = this.#queue.filter((w) => w.agentId === agentId);
    this.#queue = this.#queue.filter((w) => w.agentId !== agentId);
    for (const w of waiting) w.reject(new SchedulerCancelled(agentId));
    this.#active.get(agentId)?.release();
    this.#changed();
  }

  estimate(agentId: string): QueueEstimate {
    const running = this.#active.has(agentId);
    const sorted = this.#sorted();
    const index = sorted.findIndex((w) => w.agentId === agentId);
    return { running, waiting: index !== -1, ahead: Math.max(0, index), asleep: this.#mode === 'asleep' };
  }

  summary(): Pick<BrainsSummary, 'inFlight' | 'queued' | 'max'> {
    return {
      inFlight: this.#active.size,
      queued: this.#queue.length,
      max: this.#work + this.#interactive,
    };
  }

  #sorted(): Waiter[] {
    return [...this.#queue].sort((a, b) => a.priority - b.priority || a.seq - b.seq);
  }

  #usage(): { work: number; interactive: number } {
    let work = 0;
    let interactive = 0;
    for (const g of this.#active.values()) {
      if (g.lane === 'work') work++;
      else interactive++;
    }
    return { work, interactive };
  }

  #pump(): void {
    for (const w of this.#sorted()) {
      const used = this.#usage();
      let lane: Lane | null = null;
      if (w.priority === 0 && used.interactive < this.interactiveCap) lane = 'interactive';
      else if (used.work < this.workCap) lane = 'work';
      if (lane === null) continue;
      this.#queue = this.#queue.filter((q) => q !== w);
      const grant = this.#grant(w, lane);
      w.resolve(grant);
    }
  }

  #grant(w: Waiter, lane: Lane): Grant {
    let released = false;
    const grant: Grant = {
      agentId: w.agentId,
      lane,
      priority: w.priority,
      grantedAt: this.#now(),
      get released() {
        return released;
      },
      release: () => {
        if (released) return;
        released = true;
        if (this.#active.get(w.agentId) === grant) this.#active.delete(w.agentId);
        this.#pump();
        this.#changed();
      },
    };
    this.#active.set(w.agentId, grant);
    return grant;
  }

  #changed(): void {
    this.emit('change', this.summary());
  }
}
