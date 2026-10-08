import { z } from 'zod';
import { CHAT_MAX_LENGTH } from '../constants.js';
import {
  AgentId,
  AgentRole,
  Autonomy,
  BrainsSummary,
  DisplayName,
  EpochMs,
  EventId,
  Handle,
  ModelTier,
  NonNegInt,
  PendingId,
} from './common.js';
import { type CatalogEntry, defineMessage } from './define.js';

// ---------------------------------------------------------------------------------------------
// Value types
// ---------------------------------------------------------------------------------------------

export const QuestionOption = z.object({
  label: z.string().min(1).max(120),
  description: z.string().max(500).optional(),
});
export type QuestionOption = z.infer<typeof QuestionOption>;

/** One AskUserQuestion question. */
export const CardQuestion = z.object({
  question: z.string().min(1).max(1000),
  /** Short chip label (AskUserQuestion `header`). */
  header: z.string().min(1).max(40).optional(),
  options: z.array(QuestionOption).max(10),
  multiSelect: z.boolean(),
});
export type CardQuestion = z.infer<typeof CardQuestion>;

const cardBase = {
  id: PendingId,
  /** The agent the card belongs to (the CEO for hires). */
  agentId: AgentId,
  /** Creation time; older cards come first. */
  createdAt: EpochMs,
  /** Parked by "later" or auto-park: still answerable via `@` or G, the agent is not walking over. */
  parked: z.boolean(),
  /** The agent is the current ApproachQueue presenter for this card. */
  presenting: z.boolean(),
};

/**
 * A pending card (PLAN §6.4): an AskUserQuestion, an ExitPlanMode plan, a CEO hire request, or an approval
 * for a recurring event or meeting an agent created (PLAN §6.6 "Rights and limits").
 */
export const PendingCard = z.discriminatedUnion('kind', [
  z.object({
    ...cardBase,
    kind: z.literal('question'),
    questions: z.array(CardQuestion).min(1).max(8),
    /** Answers given so far, in question order ("Q2/3" after one answer). */
    answers: z.array(z.string().max(CHAT_MAX_LENGTH)).max(8),
  }),
  z.object({
    ...cardBase,
    kind: z.literal('plan'),
    /** The captured plan markdown (PlanCapture). */
    plan: z.string().min(1).max(32_000),
  }),
  z.object({
    ...cardBase,
    kind: z.literal('hire'),
    role: AgentRole,
    name: DisplayName,
    handle: Handle,
    reason: z.string().max(500),
    firstTask: z.string().max(2000),
  }),
  z.object({
    ...cardBase,
    kind: z.literal('calendar'),
    eventId: EventId,
    /** One line describing what needs approval ("Daily 08:00 standup, everyone"). */
    summary: z.string().min(1).max(500),
  }),
]);
export type PendingCard = z.infer<typeof PendingCard>;

/** One line of an agent's transcript (AgentScreen, Crew log). */
export const ChatEntry = z.object({
  /** Per-agent sequence number, increasing. */
  seq: NonNegInt,
  at: EpochMs,
  /**
   * `player`: the player's line to this agent. `agent`: the agent's own text. `activity`: a one-line tool
   * activity. `card` / `answer`: a card was raised / answered. `tell`: a message from another agent.
   * `system`: Node's notes (kicked, queued, out of usage, ...).
   */
  kind: z.enum(['player', 'agent', 'activity', 'card', 'answer', 'tell', 'system']),
  text: z.string().min(1).max(8000),
  /** The other agent of a `tell`. */
  fromAgentId: AgentId.optional(),
  /** The card of a `card` / `answer` entry. */
  cardId: PendingId.optional(),
});
export type ChatEntry = z.infer<typeof ChatEntry>;

/** How an AgentScreen line is delivered: Reply, New task or Interrupt (PLAN §7.8). */
export const ChatMode = z.enum(['chat', 'reply', 'task', 'interrupt']);
export type ChatMode = z.infer<typeof ChatMode>;

/** Brain status shown as a head icon: … thinking, hourglass queued, Zz asleep/offline. */
export const BrainStatus = z.enum(['idle', 'thinking', 'queued', 'waiting_player', 'asleep', 'offline']);
export type BrainStatus = z.infer<typeof BrainStatus>;

/** `agent.cmd` commands (AgentScreen buttons and toggles). */
export const AgentCommand = z.enum([
  'follow',
  'stay',
  'guard',
  'wander',
  'stop',
  'interrupt',
  'kick',
  'dismiss',
  'plan_first',
  'ping_instead',
  'autonomy',
  'retry_brain',
]);
export type AgentCommand = z.infer<typeof AgentCommand>;

// ---------------------------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------------------------

/** N→M. A toast in the bottom-left corner. */
export const UiToast = defineMessage('ui.toast', {
  text: z.string().min(1).max(512),
  kind: z.enum(['info', 'success', 'warn', 'error']),
  /** Agent the toast is about (adds its face), if any. */
  agentId: AgentId.optional(),
  ttlMs: z.number().int().min(500).max(60_000).optional(),
}).describe('Shows a toast.');

/** N→M. A speech bubble above an agent's head. At least one of `text` / `bark` is present. */
export const AgentSay = defineMessage('agent.say', {
  agentId: AgentId,
  text: z.string().min(1).max(CHAT_MAX_LENGTH).optional(),
  /** Scripted bark key, rendered by the mod from its own table. */
  bark: z.string().min(1).max(64).optional(),
  style: z.enum(['speech', 'bark', 'tell']),
  ttlMs: z.number().int().min(500).max(120_000),
})
  .refine((m) => m.text !== undefined || m.bark !== undefined, {
    message: 'agent.say needs text or bark',
    path: ['text'],
  })
  .describe('Speech bubble above an agent.');

/** N→M. Brain indicator for one agent: model suffix, head icon, last activity and AgentScreen toggles. */
export const AgentBrain = defineMessage('agent.brain', {
  agentId: AgentId,
  model: ModelTier,
  status: BrainStatus,
  /** Last one-line activity ("Reading src/app.ts"), null when none. */
  activity: z.string().min(1).max(160).nullable(),
  autonomy: Autonomy,
  planFirst: z.boolean(),
  /** "Ping instead of walking over". */
  pingInstead: z.boolean(),
}).describe('Brain indicator and settings for one agent.');

/** N→M. The full list of an agent's pending cards (replaces the previous list; empty clears it). */
export const AgentPending = defineMessage('agent.pending', {
  agentId: AgentId,
  cards: z.array(PendingCard).max(16),
}).describe("An agent's pending cards.");

/**
 * N→M. ApproachQueue (PLAN §6.4): `present` walks the agent to 2.5 blocks from the player (reflex 40);
 * `present_seated` (USER DECISION 2026-10-08) keeps a seated agent in its chair: it turns toward the player who is
 * near, shows the card-mode bubble and chimes once, and never dismounts; `queue` waits 5-7 blocks behind showing "?";
 * `ping` stays put (toast, CrewHud "?", off-screen arrow); `release` ends approaching (pendingId null).
 */
export const AgentApproach = defineMessage('agent.approach', {
  agentId: AgentId,
  pendingId: PendingId.nullable(),
  role: z.enum(['present', 'present_seated', 'queue', 'ping', 'release']),
}).describe(
  'Tells an agent to present a card to the player (walking over or from its chair), queue, ping, or stop.',
);

/** N→M. Appends one line to an agent's transcript. */
export const ChatAppend = defineMessage('chat.append', {
  agentId: AgentId,
  entry: ChatEntry,
}).describe("Appends a line to an agent's transcript.");

/** M→N request. Older transcript lines for AgentScreen; the reply is {@link ChatHistoryResult}. */
export const ChatHistory = defineMessage('chat.history', {
  agentId: AgentId,
  /** Only entries with `seq` below this; absent = the newest. */
  beforeSeq: NonNegInt.optional(),
  limit: z.number().int().min(1).max(200),
}).describe("Requests a page of an agent's transcript.");

export const ChatHistoryResult = z.object({
  /** Oldest first. */
  entries: z.array(ChatEntry).max(200),
  /** Older entries exist. */
  more: z.boolean(),
});
export type ChatHistoryResult = z.infer<typeof ChatHistoryResult>;

/**
 * M→N request. A line the player typed (chat box intercepted client-side) or sent from AgentScreen.
 * - `to: "all"`: a raw chat line. Node parses its leading `@mentions`; with none it is a broadcast.
 * - `to: [agentIds]`: explicit recipients (AgentScreen, the G card); `text` is not mention-parsed.
 * - `mode` (AgentScreen only): `reply` (default for explicit recipients), `task` (New task) or
 *   `interrupt` (delivered `now`). Absent means `chat`.
 * Node replies `ok{echo}` or `err{code: CHAT_*, msg: <inline hint>}`; on `err` the mod keeps the text
 * in the chat box and shows `msg`.
 */
export const ChatSend = defineMessage('chat.send', {
  to: z.union([z.literal('all'), z.array(AgentId).min(1).max(16)]),
  text: z.string().min(1).max(CHAT_MAX_LENGTH),
  mode: ChatMode.optional(),
}).describe('Player chat line, routed by Node (mentions, broadcast, answers).');

/** Result payload of a successful `chat.send`, `pending.answer`, `plan.decision` or `hire.decision`. */
export const ChatSendResult = z.object({
  /** How the message was read, e.g. "You → Ada: Q1 = 2 (Spruce)". Shown in the chat log. */
  echo: z
    .string()
    .min(1)
    .max(CHAT_MAX_LENGTH + 200),
});
export type ChatSendResult = z.infer<typeof ChatSendResult>;

/** An answer to a card from AgentScreen, the G card or Alt+1-4. */
export const CardAnswer = z.discriminatedUnion('kind', [
  /** 1-based option numbers (several only on multi-select questions). */
  z.object({ kind: z.literal('options'), picks: z.array(z.number().int().min(1).max(10)).min(1).max(10) }),
  /** Free text for the front question. */
  z.object({ kind: z.literal('text'), text: z.string().min(1).max(CHAT_MAX_LENGTH) }),
  /** Park the card. */
  z.object({ kind: z.literal('later') }),
  /** Approve a calendar approval card. */
  z.object({ kind: z.literal('approve') }),
  /** Decline a calendar approval card. */
  z.object({ kind: z.literal('decline'), note: z.string().min(1).max(500).optional() }),
]);
export type CardAnswer = z.infer<typeof CardAnswer>;

/**
 * M→N request. Answers a question card (or parks any card with `later`, or decides a calendar approval card).
 * Plans use `plan.decision`, hires `hire.decision`. Reply: {@link ChatSendResult}; `err CARD_GONE` when the card
 * is no longer pending, `err CHAT_INVALID_ANSWER` for an out-of-range or multi pick on a single-select question.
 */
export const PendingAnswer = defineMessage('pending.answer', {
  agentId: AgentId,
  pendingId: PendingId,
  answer: CardAnswer,
}).describe('Answers (or parks) a pending card.');

/** M→N request. Approve or revise a plan card. `revise` needs `feedback`. Reply: {@link ChatSendResult}. */
export const PlanDecision = defineMessage('plan.decision', {
  agentId: AgentId,
  pendingId: PendingId,
  decision: z.enum(['approve', 'revise']),
  feedback: z.string().min(1).max(CHAT_MAX_LENGTH).optional(),
})
  .refine((m) => m.decision !== 'revise' || m.feedback !== undefined, {
    message: 'revise needs feedback',
    path: ['feedback'],
  })
  .describe('Approves or revises a plan card.');

/** M→N request. Approve or decline a hire card. Reply: {@link ChatSendResult}. */
export const HireDecision = defineMessage('hire.decision', {
  pendingId: PendingId,
  decision: z.enum(['approve', 'decline']),
  note: z.string().min(1).max(500).optional(),
}).describe('Approves or declines a hire card.');

/**
 * M→N request. An AgentScreen command. `plan_first` and `ping_instead` need `on`; `autonomy` needs `level`.
 * `follow|stay|guard|wander` set the idle mode (Node answers with `agent.mode`); `kick` stands a seated agent
 * up; `retry_brain` restarts an offline brain.
 */
export const AgentCmd = defineMessage('agent.cmd', {
  agentId: AgentId,
  cmd: AgentCommand,
  on: z.boolean().optional(),
  level: Autonomy.optional(),
})
  .refine((m) => (m.cmd !== 'plan_first' && m.cmd !== 'ping_instead') || m.on !== undefined, {
    message: 'plan_first and ping_instead need on',
    path: ['on'],
  })
  .refine((m) => m.cmd !== 'autonomy' || m.level !== undefined, {
    message: 'autonomy needs level',
    path: ['level'],
  })
  .describe('An AgentScreen command for one agent.');

/** N→M. Brain scheduler and usage state (CrewHud, Brains menu, Zz icons). */
export const BrainsState = defineMessage('brains.state', BrainsSummary.shape).describe(
  'Brain scheduler and usage state.',
);

export const uiMessages = {
  'ui.toast': { schema: UiToast, direction: 'node_to_mod', group: 'ui', summary: 'Show a toast.' },
  'agent.say': {
    schema: AgentSay,
    direction: 'node_to_mod',
    group: 'ui',
    summary: 'Speech bubble above an agent.',
  },
  'agent.brain': {
    schema: AgentBrain,
    direction: 'node_to_mod',
    group: 'ui',
    summary: 'Model suffix, brain status icon, last activity and toggles of one agent.',
  },
  'agent.pending': {
    schema: AgentPending,
    direction: 'node_to_mod',
    group: 'ui',
    summary: "Replaces an agent's pending cards (questions, plans, hires, calendar approvals).",
  },
  'agent.approach': {
    schema: AgentApproach,
    direction: 'node_to_mod',
    group: 'ui',
    summary:
      'ApproachQueue: present a card (walking over or from the chair), queue behind the player, ping, or release.',
  },
  'chat.append': {
    schema: ChatAppend,
    direction: 'node_to_mod',
    group: 'ui',
    summary: "Appends a line to an agent's transcript (AgentScreen, Crew log).",
  },
  'chat.history': {
    schema: ChatHistory,
    direction: 'mod_to_node',
    group: 'ui',
    summary: "Request: a page of an agent's transcript.",
    reply: ChatHistoryResult,
  },
  'chat.send': {
    schema: ChatSend,
    direction: 'mod_to_node',
    group: 'ui',
    summary: 'Request: player chat line or AgentScreen reply; Node routes it.',
    reply: ChatSendResult,
  },
  'pending.answer': {
    schema: PendingAnswer,
    direction: 'mod_to_node',
    group: 'ui',
    summary: 'Request: answer, park or decide a card from AgentScreen, G or Alt+1-4.',
    reply: ChatSendResult,
  },
  'plan.decision': {
    schema: PlanDecision,
    direction: 'mod_to_node',
    group: 'ui',
    summary: 'Request: approve or revise a plan card.',
    reply: ChatSendResult,
  },
  'hire.decision': {
    schema: HireDecision,
    direction: 'mod_to_node',
    group: 'ui',
    summary: 'Request: approve or decline a hire card.',
    reply: ChatSendResult,
  },
  'agent.cmd': {
    schema: AgentCmd,
    direction: 'mod_to_node',
    group: 'ui',
    summary: 'Request: AgentScreen command (follow, stay, stop, interrupt, kick, dismiss, toggles).',
  },
  'brains.state': {
    schema: BrainsState,
    direction: 'node_to_mod',
    group: 'ui',
    summary: 'Brain scheduler and usage state (normal, tired, asleep).',
  },
} as const satisfies Record<string, CatalogEntry>;
