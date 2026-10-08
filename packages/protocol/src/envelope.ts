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
} as const;
export type KnownErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];
