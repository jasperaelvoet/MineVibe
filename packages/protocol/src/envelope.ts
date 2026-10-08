import { z } from 'zod';
import { PROTOCOL_VERSION } from './constants.js';

/** Correlation id for requests (`id`) and replies (`re`): 1-64 printable ASCII characters, no spaces. */
export const MessageId = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[\x21-\x7e]+$/, 'printable ASCII without spaces');

export const ProtocolVersion = z.literal(PROTOCOL_VERSION);

/** Message type name, e.g. `world.open`. */
export const MessageTypeName = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9]*(\.[a-z][a-z0-9_]*)*$/, 'dotted lowercase type name');

/**
 * The envelope every JSON text frame carries. Payload fields sit next to these keys at the top level.
 * Unknown payload keys are tolerated here; the per-type schemas decide what a message may contain.
 */
export const Envelope = z.looseObject({
  t: MessageTypeName,
  v: ProtocolVersion,
  id: MessageId.optional(),
  re: MessageId.optional(),
});
export type Envelope = z.infer<typeof Envelope>;

/** Machine-readable error code used in `err` replies: SCREAMING_SNAKE_CASE. */
export const ErrorCode = z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/, 'SCREAMING_SNAKE_CASE');

/**
 * Success reply to a request. `re` echoes the request's `id`; any further keys are the result payload,
 * whose shape is defined by the request type (see protocol.md).
 */
export const OkReply = z
  .looseObject({
    t: z.literal('ok'),
    v: ProtocolVersion,
    re: MessageId,
  })
  .describe('Success reply to a request; extra keys are the request-specific result.');
export type OkReply = z.infer<typeof OkReply>;

/** Failure reply to a request. */
export const ErrReply = z
  .object({
    t: z.literal('err'),
    v: ProtocolVersion,
    re: MessageId,
    code: ErrorCode,
    msg: z.string().max(2000),
  })
  .describe('Failure reply to a request: a stable `code` plus a human-readable `msg`.');
export type ErrReply = z.infer<typeof ErrReply>;

/** Error codes shared by both peers. Request types may define additional codes (see protocol.md). */
export const ERROR_CODES = {
  /** The message failed schema validation. */
  BAD_MESSAGE: 'BAD_MESSAGE',
  /** The request type is not known to this peer. */
  UNKNOWN_TYPE: 'UNKNOWN_TYPE',
  /** The type is known but this peer has no handler for it right now. */
  NOT_HANDLED: 'NOT_HANDLED',
  /** The handler failed unexpectedly. */
  INTERNAL: 'INTERNAL',
  /** No reply arrived in time (local only, never sent on the wire). */
  TIMEOUT: 'TIMEOUT',
  /** The connection closed before a reply arrived (local only). */
  DISCONNECTED: 'DISCONNECTED',
  /** No integrated server is running (mod side). */
  NO_SERVER: 'NO_SERVER',
  /** The request cannot be done in the current state (e.g. `debug.click_begin` while Begin is disabled). */
  NOT_READY: 'NOT_READY',
  /** chat.send: a leading @mention matches nobody. */
  CHAT_UNKNOWN: 'CHAT_UNKNOWN',
  /** chat.send: a leading @mention matches several agents. */
  CHAT_AMBIGUOUS: 'CHAT_AMBIGUOUS',
  /** chat.send: the addressed agent is dead or dismissed. */
  CHAT_UNAVAILABLE: 'CHAT_UNAVAILABLE',
  /** chat.send: the message is not a valid answer (out-of-range option, several picks on single-select). */
  CHAT_INVALID_ANSWER: 'CHAT_INVALID_ANSWER',
  /** chat.send: the message cannot be sent as written (empty, mixed @all with names, ...). */
  CHAT_REJECTED: 'CHAT_REJECTED',

  // Bodies and skills
  /** The agent id names no living body. */
  UNKNOWN_AGENT: 'UNKNOWN_AGENT',
  /** skill.run: the skill name is not known to the mod. */
  UNKNOWN_SKILL: 'UNKNOWN_SKILL',
  /** skill.run / obs.query: `args` do not fit the skill. */
  BAD_ARGS: 'BAD_ARGS',
  /** skill.run: the agent already runs a job and `replace` is false. */
  BUSY: 'BUSY',
  /** skill.cancel / job_status: no such job. */
  UNKNOWN_JOB: 'UNKNOWN_JOB',

  // Seats (PLAN §6.3 "Sitting")
  /** The PC is not running. */
  PC_DOWN: 'PC_DOWN',
  /** `maxSeated` agents already sit at PCs. */
  SEAT_CAP: 'SEAT_CAP',
  /** The chair is reserved for another agent. */
  RESERVED: 'RESERVED',
  /** The player sits there. */
  OCCUPIED_BY_PLAYER: 'OCCUPIED_BY_PLAYER',
  /** No path to the chair. */
  UNREACHABLE: 'UNREACHABLE',
  /** No free chair at the meeting table. */
  NO_SEAT: 'NO_SEAT',

  // Cards and commands
  /** The card is no longer pending (answered, resolved or withdrawn). */
  CARD_GONE: 'CARD_GONE',
  /** The actor may not do this (rights: CEO only, player-created event, rules page, ...). */
  FORBIDDEN: 'FORBIDDEN',

  // PCs (PLAN §8)
  PC_UNKNOWN: 'PC_UNKNOWN',
  /** The change does not fit the host budget. */
  OVER_BUDGET: 'OVER_BUDGET',
  /** A new PC does not fit at all. */
  NO_CAPACITY: 'NO_CAPACITY',
  /** Apple allows at most 2 running macOS VMs. */
  MACOS_SLOTS_FULL: 'MACOS_SLOTS_FULL',
  /** A Vault folder was refused (`$HOME`, `~/.ssh`, ...). */
  BAD_MOUNT: 'BAD_MOUNT',
  /** The container engine is down or belongs to another install. */
  ENGINE_DOWN: 'ENGINE_DOWN',

  // Codex (PLAN §6.6)
  CODEX_NOT_FOUND: 'CODEX_NOT_FOUND',
  /** `baseRev` is stale; `msg` carries the current revision. */
  CODEX_CONFLICT: 'CODEX_CONFLICT',
  /** A page with a similar title exists; `msg` names it. */
  CODEX_SIMILAR: 'CODEX_SIMILAR',
  /** Over 8 KB, or appending to a full page. */
  CODEX_TOO_LARGE: 'CODEX_TOO_LARGE',
  /** The text looks like a credential. */
  CODEX_SECRET: 'CODEX_SECRET',
  /** Invalid content (coordinates in a lasting page, places outside world scope, ...). */
  CODEX_INVALID: 'CODEX_INVALID',
  /** The agent's write budget for this game day is used up. */
  CODEX_BUDGET: 'CODEX_BUDGET',

  // Calendar and meetings (PLAN §6.6)
  CALENDAR_NOT_FOUND: 'CALENDAR_NOT_FOUND',
  CALENDAR_INVALID: 'CALENDAR_INVALID',
  /** Rate limits: 1 open CEO task per assignee, 6 CEO events per real hour. */
  CALENDAR_LIMIT: 'CALENDAR_LIMIT',
  /** A meeting is already running. */
  MEETING_BUSY: 'MEETING_BUSY',
  MEETING_NOT_FOUND: 'MEETING_NOT_FOUND',
  /** Fewer than the CEO plus one attendee can come. */
  NO_QUORUM: 'NO_QUORUM',
} as const;
export type KnownErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];
