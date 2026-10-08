import { z } from 'zod';
import { MessageId, ProtocolVersion } from '../envelope.js';

/** Which peer sends a message type. */
export type Direction = 'mod_to_node' | 'node_to_mod' | 'both';

/** Message groups, as in PLAN §5 (`reply` holds `ok`/`err`). */
export type MessageGroup = 'world' | 'bodies' | 'skills' | 'seats' | 'ui' | 'pc' | 'org' | 'debug' | 'reply';

/** One row of the message catalog. */
export interface CatalogEntry {
  readonly schema: z.ZodType;
  readonly direction: Direction;
  readonly group: MessageGroup;
  readonly summary: string;
  /**
   * Requests only: the schema of the `ok` reply's result keys. A message with a `reply` is always sent with an
   * `id`; the receiver answers `ok` (these keys) or `err`.
   */
  readonly reply?: z.ZodType;
}

const ENVELOPE_KEYS = ['t', 'v', 'id', 're'] as const;

/**
 * A message schema: the envelope keys (`t v id? re?`) plus the payload keys. Payload keys must not reuse an
 * envelope key (a page or event id is `pageId` / `eventId`, never `id`).
 */
export function defineMessage<const T extends string, S extends z.ZodRawShape>(t: T, shape: S) {
  for (const key of ENVELOPE_KEYS) {
    if (Object.hasOwn(shape, key)) throw new Error(`${t}: payload key "${key}" collides with the envelope`);
  }
  return z.object({
    t: z.literal(t),
    v: ProtocolVersion,
    id: MessageId.optional(),
    re: MessageId.optional(),
    ...shape,
  });
}
