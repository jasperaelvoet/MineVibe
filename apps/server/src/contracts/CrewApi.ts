/**
 * CrewApi: what the UI side (UiHub, chat glue, AgentScreen handlers; T1) needs from the agent runtime
 * (AgentManager; T3). The UI never talks to AgentSession, the scheduler or the broker directly.
 *
 * - `deliverChat` takes a `chat.send` line and returns how it was routed, including per-agent queue/latency hints
 *   for the echo ("queued: Ada is mid-task, reads this at her next step").
 * - `answerCard` resolves a pending card (question, plan, hire, calendar approval).
 * - `command` runs an AgentScreen command (follow, stop, interrupt, kick, dismiss, toggles).
 * - Events carry exactly the protocol payloads the UI forwards to the mod (`agent.say`, `agent.brain`,
 *   `agent.pending`, `chat.append`, `crew.state`).
 *
 * Failures reject with {@link ApiError}, whose code is the protocol error code to answer the mod with
 * (`CHAT_*`, `CARD_GONE`, `CHAT_INVALID_ANSWER`, `UNKNOWN_AGENT`, `FORBIDDEN`).
 */

import type {
  AgentCommand,
  AgentRole,
  Autonomy,
  BrainStatus,
  CardAnswer,
  ChatHistoryResult,
  ChatMode,
  ModelTier,
  PayloadOf,
} from '@minevibe/protocol';
import type { Subscribable } from './common.js';

/** One crew member as the UI shows it (CrewHud, Crew log, AgentScreen header). */
export interface AgentSummary {
  readonly agentId: string;
  readonly handle: string;
  readonly name: string;
  readonly role: AgentRole;
  readonly ceo: boolean;
  readonly status: 'alive' | 'dead' | 'dismissed';
  readonly model: ModelTier;
  readonly brain: BrainStatus;
  /** The PC the agent sits at, if any. */
  readonly seatedPc: string | null;
  readonly autonomy: Autonomy;
  readonly planFirst: boolean;
  readonly pingInstead: boolean;
  /** Pending cards of this agent. */
  readonly pendingCards: number;
}

/** A `chat.send` line. */
export interface ChatDelivery {
  /** `"all"`: a raw chat line whose leading `@mentions` route it. A list: explicit recipients (AgentScreen, G card). */
  readonly to: 'all' | readonly string[];
  readonly text: string;
  /** AgentScreen Reply / New task / Interrupt; absent = `chat`. */
  readonly mode?: ChatMode | undefined;
}

/** How one agent received a line. */
export interface AgentDeliveryInfo {
  readonly agentId: string;
  /** `wake`: P0 wake. `context`: added without a turn. `meeting`: handed to the running meeting. */
  readonly mode: 'wake' | 'context' | 'meeting';
  /** The agent will not read it right away (mid-turn, waiting for a brain slot, asleep). */
  readonly queued: boolean;
  /** Rough time until the agent reads it, in ms; null when unknown (e.g. asleep until a reset). */
  readonly latencyMs: number | null;
  /** Human hint for the echo ("Ada is mid-task, reads this at her next step"); null when it is read at once. */
  readonly hint: string | null;
}

/** The result of {@link CrewApi.deliverChat}. */
export interface DeliveryResult {
  /** The `chat.send` reply line: how the message was read ("You → Ada: Q1 = 2 (Spruce)"). */
  readonly echo: string;
  readonly scope: 'direct' | 'broadcast' | 'meeting';
  readonly deliveries: readonly AgentDeliveryInfo[];
  /** The card this line answered, if it was an answer. */
  readonly answeredCard: string | null;
}

/** A card answer: the protocol's {@link CardAnswer}, plus `revise` for plan cards. */
export type CrewCardAnswer = CardAnswer | { readonly kind: 'revise'; readonly feedback: string };

/** An AgentScreen command (`agent.cmd` without the envelope). */
export interface CrewCommand {
  readonly cmd: AgentCommand;
  /** For `plan_first` and `ping_instead`. */
  readonly on?: boolean | undefined;
  /** For `autonomy`. */
  readonly level?: Autonomy | undefined;
}

/** Result of `answerCard` and `command`: the echo line for the chat log / screen. */
export interface CrewActionResult {
  readonly echo: string;
}

/** CrewApi events: the protocol payloads to forward to the mod. */
export type CrewEvents = {
  say: [payload: PayloadOf<'agent.say'>];
  brain: [payload: PayloadOf<'agent.brain'>];
  pending: [payload: PayloadOf<'agent.pending'>];
  chat: [payload: PayloadOf<'chat.append'>];
  crew: [payload: PayloadOf<'crew.state'>];
};

export interface CrewApi extends Subscribable<CrewEvents> {
  /** Every crew member of the current world, living or not, oldest first. */
  listAgents(): readonly AgentSummary[];
  /** Routes a player line. Rejects with `CHAT_*` codes (the text stays in the chat box, `message` is the hint). */
  deliverChat(delivery: ChatDelivery): Promise<DeliveryResult>;
  /** Resolves a pending card. Rejects with `CARD_GONE` or `CHAT_INVALID_ANSWER`. */
  answerCard(pendingId: string, answer: CrewCardAnswer): Promise<CrewActionResult>;
  /** Runs an AgentScreen command. Rejects with `UNKNOWN_AGENT` or `FORBIDDEN`. */
  command(agentId: string, command: CrewCommand): Promise<CrewActionResult>;
  /** A page of an agent's transcript (oldest first), for `chat.history`. */
  chatHistory(
    agentId: string,
    options: { beforeSeq?: number | undefined; limit: number },
  ): Promise<ChatHistoryResult>;
}
