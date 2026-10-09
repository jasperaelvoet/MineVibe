/**
 * A scripted crew for development (`npm run dev -- --scripted-crew`): a {@link CrewApi} with canned, zero-token
 * behaviour, so the in-game UI (bubbles, head icons, AgentScreen, cards, chat routing) can be exercised without
 * Claude.
 *
 * - Chat lines are routed by the real {@link ChatRouter} and answer grammar (through the UI glue), so `@ada 2`,
 *   `@bram approve`, ambiguous prefixes and invalid answers behave exactly as with real agents.
 * - An addressed agent "thinks" (… icon), then answers after {@link ScriptedCrewOptions.replyDelayMs}. Keywords in
 *   the message pick the reply:
 *   `question` / `ask` → a single-select question card; `multi` → a two-question card (Q1/2, multi-select second);
 *   `plan` → a plan card; `hire` (to the CEO) → a hire card; `calendar` → a calendar approval card;
 *   `long` → a long reply (bubble truncation, "… (G)"); `busy` → busy for 20 s (later lines are queued);
 *   anything else → a short acknowledgement.
 * - Answers, AgentScreen commands and toggles get a scripted reaction and update the brain indicator.
 * - With a bridge, bodies are requested (`agent.spawn`, restore) once the world is ready; a mod that cannot spawn
 *   them yet is told so once in the log (use `/mv agent spawn Ada ceo`).
 */

import {
  type BrainsSummary,
  ERROR_CODES,
  type IdleMode,
  type PayloadOf,
  type PendingCard,
} from '@minevibe/protocol';
import type { Logger } from 'pino';
import { ChatRouter } from '../agents/chat/ChatRouter.js';
import type { BridgeServer } from '../bridge/BridgeServer.js';
import type {
  AgentDeliveryInfo,
  AgentSummary,
  ChatDelivery,
  CrewActionResult,
  CrewCardAnswer,
  CrewCommand,
  DeliveryResult,
} from '../contracts/CrewApi.js';
import { ApiError } from '../contracts/common.js';
import { type FakeAgentInit, FakeCrewApi } from '../contracts/FakeCrewApi.js';
import { DEFAULT_PLAYER_NAME } from '../launcher/settings.js';
import { chatContextFrom, findCard, toCrewCardAnswer } from './chatGlue.js';

export const SCRIPTED_AGENTS: readonly FakeAgentInit[] = [
  { agentId: 'ada', handle: 'ada', name: 'Ada', role: 'ceo', ceo: true },
  {
    agentId: 'bram',
    handle: 'bram',
    name: 'Bram',
    role: 'engineer',
    model: 'opus',
    seatedPc: 'linux-1',
    planFirst: true,
  },
];

/** How long `busy` keeps an agent mid-task. */
export const BUSY_MS = 20_000;

export interface ScriptedCrewOptions {
  readonly logger: Logger;
  readonly now?: () => number;
  /** Runs `fn` after `ms`; default an unref'd `setTimeout`. */
  readonly schedule?: (fn: () => void, ms: number) => void;
  /** Time between "thinking" and the reply (default 1200 ms). */
  readonly replyDelayMs?: number;
  readonly agents?: readonly FakeAgentInit[];
  /** The player's name (from `hello`), for the router's handle rules; default the launcher's default name. */
  readonly playerName?: () => string;
  /** Lets the crew ask the mod for bodies (`agent.spawn`) and idle modes (`agent.mode`). */
  readonly bridge?: Pick<BridgeServer, 'request' | 'on'>;
  /** Called with the brain summary whenever it changes. */
  readonly onBrains?: (summary: BrainsSummary) => void;
}

const MODE_COMMANDS: ReadonlySet<string> = new Set(['follow', 'stay', 'guard', 'wander']);

const LONG_REPLY =
  'Here is the long version, so you can see how a bubble wraps and truncates: I walked the perimeter, counted ' +
  'three caves to the north, found iron near the river bend, planted wheat behind the office, and put the spare ' +
  'torches in the second chest. Tomorrow I would like to build a proper storage room with labelled chests, ' +
  'a small smelting line and a path lit all the way to the mine, so nobody gets lost at night.';

function clipText(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

export class ScriptedCrew extends FakeCrewApi {
  readonly #router = new ChatRouter();
  readonly #log: Logger;
  readonly #clock: () => number;
  readonly #schedule: (fn: () => void, ms: number) => void;
  readonly #timers = new Set<NodeJS.Timeout>();
  readonly #replyDelayMs: number;
  readonly #playerName: () => string;
  readonly #bridge: Pick<BridgeServer, 'request' | 'on'> | undefined;
  readonly #onBrains: ((summary: BrainsSummary) => void) | undefined;
  readonly #activity = new Map<string, string | null>();
  readonly #busyUntil = new Map<string, number>();
  readonly #spawnedWorlds = new Set<string>();
  readonly #offs: Array<() => void> = [];
  #cardSeq = 0;
  #disposed = false;
  #spawnUnsupportedLogged = false;
  #lastBrains = '';

  constructor(options: ScriptedCrewOptions) {
    const now = options.now ?? Date.now;
    super(options.agents ?? SCRIPTED_AGENTS, { now });
    this.#log = options.logger;
    this.#clock = now;
    this.#replyDelayMs = options.replyDelayMs ?? 1200;
    this.#playerName = options.playerName ?? (() => DEFAULT_PLAYER_NAME);
    this.#bridge = options.bridge;
    this.#onBrains = options.onBrains;
    this.#schedule =
      options.schedule ??
      ((fn, ms) => {
        const timer = setTimeout(() => {
          this.#timers.delete(timer);
          fn();
        }, ms);
        timer.unref();
        this.#timers.add(timer);
      });
    if (this.#bridge) {
      this.#offs.push(
        this.#bridge.on('world.state', (m) => {
          if (m.phase === 'ready') this.#spawnBodies(m.worldId);
        }),
      );
    }
  }

  dispose(): void {
    this.#disposed = true;
    for (const timer of this.#timers) clearTimeout(timer);
    this.#timers.clear();
    for (const off of this.#offs.splice(0)) off();
  }

  /** The current brain scheduler summary (inFlight = thinking agents, queued = busy agents with waiting lines). */
  brainsSummary(): BrainsSummary {
    const agents = this.listAgents().filter((a) => a.status === 'alive');
    return {
      inFlight: agents.filter((a) => a.brain === 'thinking').length,
      queued: agents.filter((a) => a.brain === 'queued').length,
      max: 2,
      mode: 'normal',
      utilization: 0.12,
      resetsAt: null,
    };
  }

  // ------------------------------------------------------------------------------------------
  // CrewApi
  // ------------------------------------------------------------------------------------------

  override async deliverChat(delivery: ChatDelivery): Promise<DeliveryResult> {
    const agents = this.listAgents();
    const cards = this.#allCards();
    const ctx = chatContextFrom({ playerName: this.#playerName(), agents, cards });
    const route = this.#router.route({ to: delivery.to, text: delivery.text }, ctx);
    if (!route.ok) throw new ApiError(route.error.wireCode, route.error.hint);

    if (route.answer) {
      const answer = toCrewCardAnswer(route.answer, findCard(cards, route.answer.cardId));
      if (!answer) throw new ApiError(ERROR_CODES.CARD_GONE, 'That card is no longer pending');
      await this.answerCard(route.answer.cardId, answer);
      return { echo: route.echo, scope: route.scope, deliveries: [], answeredCard: route.answer.cardId };
    }
    if (route.command === 'meeting.end') {
      return { echo: route.echo, scope: 'meeting', deliveries: [], answeredCard: null };
    }

    const now = this.#clock();
    const recipients = route.deliveries.filter((d) => d.mode !== 'meeting').map((d) => d.agentId);
    if (recipients.length > 0) {
      // The base class records the line in each recipient's transcript.
      await super.deliverChat({ to: recipients, text: route.body.length > 0 ? route.body : delivery.text });
    }
    const deliveries: AgentDeliveryInfo[] = route.deliveries.map((d) => {
      const busyFor = (this.#busyUntil.get(d.agentId) ?? 0) - now;
      const queued = busyFor > 0 && d.mode === 'wake';
      const name = agents.find((a) => a.agentId === d.agentId)?.name ?? d.agentId;
      return {
        agentId: d.agentId,
        mode: d.mode,
        queued,
        latencyMs: queued ? busyFor : 0,
        hint: queued ? `${name} is mid-task, reads this at the next step` : null,
      };
    });
    for (const d of deliveries) {
      if (d.mode === 'wake') this.#onMessage(d.agentId, route.body, d.queued ? (d.latencyMs ?? 0) : 0);
    }
    return { echo: route.echo, scope: route.scope, deliveries, answeredCard: null };
  }

  override async answerCard(pendingId: string, answer: CrewCardAnswer): Promise<CrewActionResult> {
    const card = findCard(this.#allCards(), pendingId);
    if (!card) throw new ApiError(ERROR_CODES.CARD_GONE, 'That card is no longer pending');
    const agent = this.#summary(card.agentId);

    // A multi-question card advances to its next question instead of resolving.
    if (card.kind === 'question' && answer.kind !== 'later') {
      const index = card.answers.length;
      const question = card.questions[index];
      if (!question) throw new ApiError(ERROR_CODES.CARD_GONE, 'That card is no longer pending');
      const value = this.#answerValue(question, answer);
      if (value === null) {
        throw new ApiError(
          ERROR_CODES.CHAT_INVALID_ANSWER,
          `Q${index + 1} takes ${question.multiSelect ? 'one or more options' : 'one option'} (1-${question.options.length})`,
        );
      }
      const shown =
        answer.kind === 'options' ? `${answer.picks.join(',')} (${value})` : `"${clipText(value, 120)}"`;
      const echo = `You → ${agent.name}: Q${index + 1} = ${shown}`;
      if (index + 1 < card.questions.length) {
        this.raiseCard({ ...card, answers: [...card.answers, value] });
        this.#say(card.agentId, `Noted: ${value}. Next question.`, 300);
        return { echo };
      }
      await super.answerCard(pendingId, answer); // resolves the card (validated above)
      this.#reactToAnswer(card, `Thanks! Going with ${value}.`);
      return { echo };
    }

    const result = await super.answerCard(pendingId, answer);
    switch (answer.kind) {
      case 'later':
        this.#say(card.agentId, "Okay, later. I'll get back to work.", 300);
        this.#setBrain(card.agentId, 'idle', null);
        return { echo: `You → ${agent.name}: later (card parked; answer any time with G)` };
      case 'approve':
        if (card.kind === 'hire') {
          this.#hire(card);
          return { echo: `You → ${agent.name}: hire approved: ${card.name} (${card.role})` };
        }
        this.#reactToAnswer(
          card,
          card.kind === 'plan' ? 'Plan approved. Starting now.' : 'Approved, thanks!',
        );
        return { echo: `You → ${agent.name}: ${card.kind === 'plan' ? 'plan approved' : 'approved'}` };
      case 'revise':
        this.#reactToAnswer(card, `Revising the plan: ${clipText(answer.feedback, 60)}`);
        return { echo: `You → ${agent.name}: revise plan: "${clipText(answer.feedback, 120)}"` };
      case 'decline':
        this.#reactToAnswer(card, card.kind === 'hire' ? 'Understood, no hire.' : 'Understood.');
        return {
          echo: `You → ${agent.name}: ${card.kind === 'hire' ? 'hire declined' : 'declined'}${answer.note ? `: "${clipText(answer.note, 120)}"` : ''}`,
        };
      default:
        return result;
    }
  }

  override async command(agentId: string, command: CrewCommand): Promise<CrewActionResult> {
    const before = this.#summary(agentId);
    if (command.cmd === 'dismiss') this.emitSay(agentId, 'Goodbye! It was a pleasure.');
    await super.command(agentId, command);
    const agent = this.#summary(agentId);
    let echo = `${agent.name}: ${command.cmd}`;
    switch (command.cmd) {
      case 'follow':
      case 'stay':
      case 'guard':
      case 'wander':
        this.#say(
          agentId,
          {
            follow: 'Following you.',
            stay: 'Staying here.',
            guard: 'On guard.',
            wander: 'I will look around.',
          }[command.cmd],
          200,
        );
        this.#requestMode(agentId, command.cmd);
        echo = `${agent.name} will ${command.cmd}`;
        break;
      case 'stop':
      case 'interrupt':
        this.#busyUntil.delete(agentId);
        this.#setBrain(agentId, 'idle', null);
        this.#say(agentId, command.cmd === 'stop' ? 'Stopping.' : 'Interrupted. What do you need?', 200);
        echo = `${agent.name}: ${command.cmd === 'stop' ? 'stopped' : 'interrupted'}`;
        break;
      case 'kick':
        if (before.seatedPc === null)
          throw new ApiError(ERROR_CODES.FORBIDDEN, `${agent.name} is not at a PC`);
        this.emitBrain({ ...this.#brainOf(agentId), model: 'haiku', status: 'idle' });
        this.#say(agentId, 'Okay, I stood up.', 200);
        echo = `Kicked ${agent.name} off ${before.seatedPc}`;
        break;
      case 'plan_first':
      case 'ping_instead':
      case 'autonomy':
        this.emitBrain(this.#brainOf(agentId));
        echo = `${agent.name}: ${command.cmd.replace('_', ' ')} ${command.cmd === 'autonomy' ? command.level : command.on ? 'on' : 'off'}`;
        break;
      case 'retry_brain':
        this.#setBrain(agentId, 'idle', null);
        echo = `${agent.name}: brain restarted`;
        break;
      case 'dismiss':
        echo = `${agent.name} was dismissed`;
        break;
    }
    return { echo };
  }

  // ------------------------------------------------------------------------------------------
  // Behaviour
  // ------------------------------------------------------------------------------------------

  #onMessage(agentId: string, body: string, delayMs: number): void {
    if (delayMs > 0) {
      this.#setBrain(agentId, 'queued', null);
      this.#later(() => this.#onMessage(agentId, body, 0), delayMs);
      return;
    }
    this.#setBrain(agentId, 'thinking', `Reading: ${clipText(body, 60)}`);
    this.#later(() => this.#reply(agentId, body), this.#replyDelayMs);
  }

  #reply(agentId: string, body: string): void {
    const agent = this.listAgents().find((a) => a.agentId === agentId);
    if (agent?.status !== 'alive') return;
    const text = body.toLowerCase();
    const has = (word: string) => new RegExp(`\\b${word}\\b`).test(text);
    if (has('multi')) {
      this.#raise(agentId, {
        kind: 'question',
        questions: [
          {
            question: 'Where should the farm go?',
            header: 'Farm',
            options: [{ label: 'By the river' }, { label: 'Behind the office' }, { label: 'On the hill' }],
            multiSelect: false,
          },
          {
            question: 'What should I plant?',
            header: 'Crops',
            options: [{ label: 'Wheat' }, { label: 'Carrots' }, { label: 'Potatoes' }, { label: 'Beetroot' }],
            multiSelect: true,
          },
        ],
        answers: [],
      });
      this.#say(agentId, 'I have two questions about the farm.', 0);
      this.#setBrain(agentId, 'waiting_player', 'Waiting for your answer');
    } else if (has('question') || has('ask')) {
      this.#raise(agentId, {
        kind: 'question',
        questions: [
          {
            question: 'Which wood should I use for the new house?',
            header: 'Wood',
            options: [
              { label: 'Oak', description: 'Classic and plentiful' },
              { label: 'Spruce', description: 'Darker, from the taiga' },
              { label: 'Birch', description: 'Light and bright' },
            ],
            multiSelect: false,
          },
        ],
        answers: [],
      });
      this.#say(agentId, 'Quick question for you.', 0);
      this.#setBrain(agentId, 'waiting_player', 'Waiting for your answer');
    } else if (has('plan')) {
      this.#raise(agentId, {
        kind: 'plan',
        plan:
          '# Fix the failing test\n\n1. Run `npm test` to reproduce.\n2. Read `src/parser.ts` around the date handling.\n' +
          '3. Fix the off-by-one in `parseDay`.\n4. Re-run the tests and commit.',
      });
      this.#say(agentId, 'Here is my plan. Approve it, or tell me what to change.', 0);
      this.#setBrain(agentId, 'waiting_player', 'Waiting for plan approval');
    } else if (has('hire') && agent.ceo) {
      this.#raise(agentId, {
        kind: 'hire',
        role: 'miner',
        name: 'Dana',
        handle: 'dana',
        reason: 'We need iron for tools, and mining takes all day.',
        firstTask: 'Mine 20 iron ore in the north cave.',
      });
      this.#say(agentId, 'I would like to hire a miner. Okay?', 0);
      this.#setBrain(agentId, 'waiting_player', 'Waiting for the hire decision');
    } else if (has('calendar')) {
      this.#raise(agentId, {
        kind: 'calendar',
        eventId: `ev-${++this.#cardSeq}`,
        summary: 'Daily 08:00 standup at the meeting table, everyone',
      });
      this.#say(agentId, 'I would like to add a daily standup.', 0);
      this.#setBrain(agentId, 'waiting_player', 'Waiting for approval');
    } else if (has('long')) {
      this.emitSay(agentId, LONG_REPLY);
      this.#setBrain(agentId, 'idle', null);
    } else if (has('busy')) {
      this.#busyUntil.set(agentId, this.#clock() + BUSY_MS);
      this.emitSay(agentId, 'Heads down for a bit: new messages will queue.');
      this.#setBrain(agentId, 'thinking', 'Busy with a long task');
      this.#later(() => {
        this.#busyUntil.delete(agentId);
        this.#setBrain(agentId, 'idle', null);
      }, BUSY_MS);
    } else {
      this.emitSay(agentId, body.length > 0 ? `On it: ${clipText(body, 80)}` : 'On it!');
      this.#setBrain(agentId, 'idle', null);
    }
  }

  #reactToAnswer(card: PendingCard, line: string): void {
    this.#say(card.agentId, line, 300);
    this.#setBrain(card.agentId, 'idle', null);
  }

  #hire(card: Extract<PendingCard, { kind: 'hire' }>): void {
    const exists = this.listAgents().some((a) => a.agentId === card.handle);
    if (!exists)
      this.addAgent({ agentId: card.handle, handle: card.handle, name: card.name, role: card.role });
    this.#reactToAnswer(card, `Great, ${card.name} is on the way.`);
    this.#say(card.handle, 'Reporting for duty!', 600);
    this.#spawnOne(card.handle);
  }

  #raise(
    agentId: string,
    card: DistributiveOmit<PendingCard, 'id' | 'agentId' | 'createdAt' | 'parked' | 'presenting'>,
  ): void {
    const id = `${agentId}-${card.kind}-${++this.#cardSeq}`;
    this.raiseCard({
      ...card,
      id,
      agentId,
      createdAt: this.#clock(),
      parked: false,
      presenting: true,
    } as PendingCard);
    this.#emitBrains();
  }

  #answerValue(
    question: { readonly options: readonly { label: string }[]; readonly multiSelect: boolean },
    answer: CrewCardAnswer,
  ): string | null {
    if (answer.kind === 'text') return answer.text;
    if (answer.kind !== 'options') return null;
    const { options } = question;
    if (answer.picks.some((p) => p < 1 || p > options.length)) return null;
    if (!question.multiSelect && answer.picks.length > 1) return null;
    return answer.picks.map((p) => options[p - 1]?.label ?? String(p)).join(', ');
  }

  #say(agentId: string, text: string, delayMs: number): void {
    if (delayMs <= 0) this.emitSay(agentId, text);
    else this.#later(() => this.emitSay(agentId, text), delayMs);
  }

  #setBrain(agentId: string, status: AgentSummary['brain'], activity: string | null): void {
    if (!this.listAgents().some((a) => a.agentId === agentId)) return;
    this.#activity.set(agentId, activity);
    this.emitBrain({ ...this.#brainOf(agentId), status, activity });
    this.#emitBrains();
  }

  #brainOf(agentId: string): PayloadOf<'agent.brain'> {
    const a = this.#summary(agentId);
    return {
      agentId,
      model: a.model,
      status: a.brain,
      activity: this.#activity.get(agentId) ?? null,
      autonomy: a.autonomy,
      planFirst: a.planFirst,
      pingInstead: a.pingInstead,
    };
  }

  #emitBrains(): void {
    const summary = this.brainsSummary();
    const key = JSON.stringify(summary);
    if (key === this.#lastBrains) return;
    this.#lastBrains = key;
    this.#onBrains?.(summary);
  }

  #summary(agentId: string): AgentSummary {
    const agent = this.listAgents().find((a) => a.agentId === agentId);
    if (!agent) throw new ApiError(ERROR_CODES.UNKNOWN_AGENT, `No agent ${agentId}`);
    return agent;
  }

  #allCards(): Map<string, readonly PendingCard[]> {
    return new Map(this.listAgents().map((a) => [a.agentId, this.cardsOf(a.agentId)]));
  }

  #later(fn: () => void, ms: number): void {
    if (this.#disposed) return;
    this.#schedule(() => {
      if (!this.#disposed) fn();
    }, ms);
  }

  // ------------------------------------------------------------------------------------------
  // Bodies
  // ------------------------------------------------------------------------------------------

  #spawnBodies(worldId: string): void {
    if (this.#spawnedWorlds.has(worldId)) return;
    this.#spawnedWorlds.add(worldId);
    for (const agent of this.listAgents()) if (agent.status === 'alive') this.#spawnOne(agent.agentId);
  }

  #spawnOne(agentId: string): void {
    const bridge = this.#bridge;
    if (!bridge) return;
    const agent = this.listAgents().find((a) => a.agentId === agentId);
    if (!agent) return;
    bridge
      .request('agent.spawn', {
        agentId: agent.agentId,
        handle: agent.handle,
        name: agent.name,
        role: agent.role,
        ceo: agent.ceo,
        restore: true,
        mode: 'follow',
      })
      .then(
        () => this.#log.info({ agentId }, 'scripted crew: body spawned'),
        (err: unknown) => {
          const code = (err as { code?: string }).code;
          if (code === ERROR_CODES.NOT_HANDLED) {
            if (!this.#spawnUnsupportedLogged) {
              this.#spawnUnsupportedLogged = true;
              this.#log.info(
                'scripted crew: this mod build does not spawn bodies over the bridge yet; in game, run ' +
                  this.listAgents()
                    .filter((a) => a.status === 'alive')
                    .map((a) => `/mv agent spawn ${a.name} ${a.role}`)
                    .join(' and '),
              );
            }
          } else {
            this.#log.warn({ agentId, err: (err as Error).message }, 'scripted crew: agent.spawn failed');
          }
        },
      );
  }

  #requestMode(agentId: string, mode: string): void {
    if (!this.#bridge || !MODE_COMMANDS.has(mode)) return;
    this.#bridge.request('agent.mode', { agentId, mode: mode as IdleMode }).catch((err: unknown) => {
      this.#log.debug(
        { agentId, mode, err: (err as Error).message },
        'scripted crew: agent.mode not applied',
      );
    });
  }
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
