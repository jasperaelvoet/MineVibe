import type { z } from 'zod';
import { MAX_TEXT_FRAME_BYTES, PROTOCOL_VERSION } from './constants.js';
import { Envelope, ErrReply, OkReply } from './envelope.js';
import { bodyMessages } from './messages/bodies.js';
import { debugMessages } from './messages/debug.js';
import type { CatalogEntry, Direction, MessageGroup } from './messages/define.js';
import { orgMessages } from './messages/org.js';
import { pcMessages } from './messages/pc.js';
import { seatMessages } from './messages/seats.js';
import { skillMessages } from './messages/skills.js';
import { uiMessages } from './messages/ui.js';
import { worldMessages } from './messages/world.js';

const replyMessages = {
  ok: { schema: OkReply, direction: 'both', group: 'reply', summary: 'Success reply to a request.' },
  err: { schema: ErrReply, direction: 'both', group: 'reply', summary: 'Failure reply to a request.' },
} as const satisfies Record<string, CatalogEntry>;

/**
 * The message catalog: type name -> schema, direction, group, one-line summary and (for requests) the schema of
 * the `ok` reply. Each group lives in `src/messages/<group>.ts`. Generated docs and the Java contract tests are
 * driven from this table and `fixtures/`.
 */
export const messageCatalog = {
  ...worldMessages,
  ...bodyMessages,
  ...skillMessages,
  ...seatMessages,
  ...uiMessages,
  ...pcMessages,
  ...orgMessages,
  ...debugMessages,
  ...replyMessages,
} as const satisfies Record<string, CatalogEntry>;

type Catalog = typeof messageCatalog;

/** Every known message type name. */
export type MessageType = keyof Catalog;

/** Registry: message type -> zod schema. */
export const messageSchemas: { readonly [K in MessageType]: Catalog[K]['schema'] } = Object.freeze(
  Object.fromEntries(Object.entries(messageCatalog).map(([t, entry]) => [t, entry.schema])),
) as { readonly [K in MessageType]: Catalog[K]['schema'] };

export const MESSAGE_TYPES = Object.freeze(Object.keys(messageCatalog)) as readonly MessageType[];

/** The full parsed message for type `T` (envelope keys included). */
export type MessageOf<T extends MessageType> = z.infer<Catalog[T]['schema']>;

/** Union of every known message. */
export type AnyMessage = { [K in MessageType]: MessageOf<K> }[MessageType];

/** Envelope keys that are not part of a payload. */
type EnvelopeKey = 't' | 'v' | 'id' | 're';

/** The payload of type `T`: the message without its envelope keys. */
export type PayloadOf<T extends MessageType> = Omit<MessageOf<T>, EnvelopeKey>;

/** Types the mod sends to Node. */
export type ModToNodeType = {
  [K in MessageType]: Catalog[K]['direction'] extends 'mod_to_node' | 'both' ? K : never;
}[MessageType];

/** Types Node sends to the mod. */
export type NodeToModType = {
  [K in MessageType]: Catalog[K]['direction'] extends 'node_to_mod' | 'both' ? K : never;
}[MessageType];

export function isMessageType(t: unknown): t is MessageType {
  return typeof t === 'string' && Object.hasOwn(messageCatalog, t);
}

export function directionOf(t: MessageType): Direction {
  return messageCatalog[t].direction;
}

export function groupOf(t: MessageType): MessageGroup {
  return messageCatalog[t].group;
}

/** Request types: the ones whose catalog entry defines the `ok` reply. */
export type RequestType = {
  [K in MessageType]: Catalog[K] extends { reply: z.ZodType } ? K : never;
}[MessageType];

/** The `ok` result keys of request type `T`. */
export type ReplyOf<T extends RequestType> = Catalog[T] extends { reply: infer R extends z.ZodType }
  ? z.infer<R>
  : never;

/** The schema of the `ok` result of `t`, or null when the catalog defines none (the reply is then `ok {}`). */
export function replySchemaOf(t: MessageType): z.ZodType | null {
  const entry: CatalogEntry = messageCatalog[t];
  return entry.reply ?? null;
}

/** Raised by the throwing helpers on malformed input. */
export class ProtocolError extends Error {
  readonly code: 'BAD_JSON' | 'BAD_ENVELOPE' | 'BAD_MESSAGE' | 'TOO_LARGE';
  readonly type: string | undefined;

  constructor(code: ProtocolError['code'], message: string, type?: string) {
    super(message);
    this.name = 'ProtocolError';
    this.code = code;
    this.type = type;
  }
}

/** Outcome of {@link safeParseMessage}. */
export type ParseResult =
  | { readonly status: 'ok'; readonly message: AnyMessage }
  | { readonly status: 'unknown_type'; readonly envelope: Envelope }
  | {
      readonly status: 'invalid';
      /** The envelope when it was readable (so a request `id` can still be answered with `err`). */
      readonly envelope: Envelope | null;
      readonly error: string;
    };

function describeIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 5)
    .map((issue) => `${issue.path.length > 0 ? issue.path.join('.') : '(root)'}: ${issue.message}`)
    .join('; ');
}

/** Validates an already-decoded JSON value. Never throws. */
export function safeParseMessage(input: unknown): ParseResult {
  const env = Envelope.safeParse(input);
  if (!env.success) {
    return { status: 'invalid', envelope: null, error: `bad envelope: ${describeIssues(env.error)}` };
  }
  const envelope = env.data;
  if (!isMessageType(envelope.t)) {
    return { status: 'unknown_type', envelope };
  }
  const schema: z.ZodType = messageSchemas[envelope.t];
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    return { status: 'invalid', envelope, error: `${envelope.t}: ${describeIssues(parsed.error)}` };
  }
  return { status: 'ok', message: parsed.data as AnyMessage };
}

/** Decodes and validates one JSON text frame. Never throws. */
export function safeParseMessageText(text: string): ParseResult {
  if (exceedsTextFrameLimit(text)) {
    return { status: 'invalid', envelope: null, error: `frame exceeds ${MAX_TEXT_FRAME_BYTES} bytes` };
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { status: 'invalid', envelope: null, error: 'not valid JSON' };
  }
  return safeParseMessage(value);
}

/**
 * Parses a decoded JSON value. Returns `null` for a well-formed envelope whose `t` is unknown (forward
 * compatibility: unknown types are ignored), and throws {@link ProtocolError} for anything malformed.
 */
export function parseMessage(input: unknown): AnyMessage | null {
  const result = safeParseMessage(input);
  switch (result.status) {
    case 'ok':
      return result.message;
    case 'unknown_type':
      return null;
    case 'invalid':
      throw new ProtocolError(
        result.envelope === null ? 'BAD_ENVELOPE' : 'BAD_MESSAGE',
        result.error,
        result.envelope?.t,
      );
  }
}

/** Like {@link parseMessage} but takes the raw text frame. */
export function parseMessageText(text: string): AnyMessage | null {
  if (exceedsTextFrameLimit(text)) {
    throw new ProtocolError('TOO_LARGE', `frame exceeds ${MAX_TEXT_FRAME_BYTES} bytes`);
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ProtocolError('BAD_JSON', 'not valid JSON');
  }
  return parseMessage(value);
}

/** Correlation ids for {@link createMessage}. */
export interface EnvelopeIds {
  id?: string | undefined;
  re?: string | undefined;
}

/**
 * Builds and validates a message of type `t`. Throws {@link ProtocolError} if the payload does not match
 * the schema, so a bug on the sending side never reaches the wire.
 */
export function createMessage<T extends MessageType>(
  t: T,
  payload: PayloadOf<T>,
  ids: EnvelopeIds = {},
): MessageOf<T> {
  const candidate: Record<string, unknown> = { ...payload, t, v: PROTOCOL_VERSION };
  if (ids.id !== undefined) candidate.id = ids.id;
  if (ids.re !== undefined) candidate.re = ids.re;
  const schema: z.ZodType = messageSchemas[t];
  const parsed = schema.safeParse(candidate);
  if (!parsed.success) {
    throw new ProtocolError('BAD_MESSAGE', `${t}: ${describeIssues(parsed.error)}`, t);
  }
  return parsed.data as MessageOf<T>;
}

/** {@link createMessage} serialised as a JSON text frame. Enforces the text frame size limit. */
export function encodeMessage<T extends MessageType>(
  t: T,
  payload: PayloadOf<T>,
  ids: EnvelopeIds = {},
): string {
  const text = JSON.stringify(createMessage(t, payload, ids));
  if (exceedsTextFrameLimit(text)) {
    throw new ProtocolError('TOO_LARGE', `${t} frame exceeds ${MAX_TEXT_FRAME_BYTES} bytes`, t);
  }
  return text;
}

/** True when `text` encodes to more than {@link MAX_TEXT_FRAME_BYTES} bytes of UTF-8. */
export function exceedsTextFrameLimit(text: string): boolean {
  // Fast path: a UTF-16 code unit never encodes to more than 3 UTF-8 bytes.
  if (text.length * 3 <= MAX_TEXT_FRAME_BYTES) return false;
  return utf8ByteLength(text, MAX_TEXT_FRAME_BYTES) > MAX_TEXT_FRAME_BYTES;
}

/** UTF-8 length of `text` (lone surrogates count as U+FFFD), stopping early once it exceeds `stopAfter`. */
export function utf8ByteLength(text: string, stopAfter = Number.POSITIVE_INFINITY): number {
  let bytes = 0;
  for (let i = 0; i < text.length && bytes <= stopAfter; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) {
      bytes += 1;
    } else if (c < 0x800) {
      bytes += 2;
    } else if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i++;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }
  return bytes;
}
