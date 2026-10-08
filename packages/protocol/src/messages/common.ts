import { z } from 'zod';

// ---------------------------------------------------------------------------------------------
// Shared value types. Every regex is mirrored in apps/mod (dev.minevibe.bridge.protocol.Messages).
// ---------------------------------------------------------------------------------------------

/** Agent id minted by Node (a short slug or a UUID). */
export const AgentId = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/, 'agent id: 1-64 of [A-Za-z0-9_-], starting alphanumeric');

/** World id minted by Node. Also the save-folder name, so it is restricted to a safe slug. */
export const WorldId = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,63}$/, 'world id: 1-64 of [a-z0-9-], starting alphanumeric');

/** Chat handle: what the player types after `@`. */
export const Handle = z.string().regex(/^[a-z][a-z0-9]{1,11}$/, 'handle: [a-z][a-z0-9]{1,11}');

/** Minecraft player name (offline profiles allow 1-16 of [A-Za-z0-9_]). */
export const PlayerName = z.string().regex(/^[A-Za-z0-9_]{1,16}$/, 'Minecraft player name');

/** PC id (`linux-1`, `mac-2`). Also part of container names (`mv-pc-<id>`), so a safe slug. */
export const PcId = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,63}$/, 'pc id: 1-64 of [a-z0-9-], starting alphanumeric');

/**
 * Opaque ids minted by one side and echoed by the other: pending cards, jobs, calendar events, meetings,
 * consent prompts.
 */
const OPAQUE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;
export const PendingId = z.string().regex(OPAQUE_ID_RE, 'pending id: 1-64 of [A-Za-z0-9_.:-]');
export const JobId = z.string().regex(OPAQUE_ID_RE, 'job id: 1-64 of [A-Za-z0-9_.:-]');
export const EventId = z.string().regex(OPAQUE_ID_RE, 'event id: 1-64 of [A-Za-z0-9_.:-]');
export const MeetingId = z.string().regex(OPAQUE_ID_RE, 'meeting id: 1-64 of [A-Za-z0-9_.:-]');
export const ConsentId = z.string().regex(OPAQUE_ID_RE, 'consent id: 1-64 of [A-Za-z0-9_.:-]');

/** Codex page id: a slug (also the markdown file name). */
export const CodexId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/, 'codex id: 1-80 of [a-z0-9-]');

/** A git revision (abbreviated or full SHA-1/SHA-256 hex). */
export const Rev = z.string().regex(/^[0-9a-f]{7,64}$/, 'revision: 7-64 lowercase hex');

/** Namespaced resource id, e.g. `minecraft:overworld`. */
export const Dimension = z
  .string()
  .max(128)
  .regex(/^[a-z0-9_.-]+:[a-z0-9_./-]+$/, 'dimension: namespace:path');

/**
 * Item or block id, optionally namespaced (`oak_log` means `minecraft:oak_log`); a leading `#` names a tag
 * (`#minecraft:logs`).
 */
export const ItemId = z
  .string()
  .max(128)
  .regex(/^#?([a-z0-9_.-]+:)?[a-z0-9_./-]+$/, 'item id: [#][namespace:]path');

/**
 * An entity reference for skills: `player`, an agent id, an entity UUID, or an entity type id such as
 * `minecraft:cow` (the nearest one).
 */
export const EntityRef = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_:.#-]+$/, 'entity reference');

/** One-line short text (titles, labels): 1-80 characters, no line breaks. */
export const Title = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[^\r\n]*$/, 'single line');

/** Display name of an agent ("Ada"). */
export const DisplayName = z.string().min(1).max(32);

/** Scripted bark key, rendered by the mod from its own table. */
export const BarkKey = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/, 'bark key');

export const Int32 = z
  .number()
  .int()
  .min(-(2 ** 31))
  .max(2 ** 31 - 1);
export const NonNegInt = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const PosInt = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
export const UInt32 = z
  .number()
  .int()
  .min(0)
  .max(2 ** 32 - 1);
/** Milliseconds since the Unix epoch. */
export const EpochMs = NonNegInt;
/** A 0..1 fraction. */
export const Fraction = z.number().min(0).max(1);

/** A block position in the world. */
export const BlockPos = z.object({ x: Int32, y: Int32, z: Int32 });
export type BlockPos = z.infer<typeof BlockPos>;

/** An exact position (entity coordinates). */
export const Vec3 = z.object({ x: z.number(), y: z.number(), z: z.number() });
export type Vec3 = z.infer<typeof Vec3>;

/** A position in a given dimension. */
export const Place = z.object({ pos: BlockPos, dim: Dimension });
export type Place = z.infer<typeof Place>;

/**
 * What kind of place a body stands in (protocol §7.4.3): `base` is the Base (the starter office and its grounds,
 * the player's home), `built` is among blocks a player placed outside it, `wild` is nature. Blocks of the Base and
 * player-placed blocks are protected: skills leave them alone unless Node passes a consent.
 */
export const ZoneKind = z.enum(['base', 'built', 'wild']);
export type ZoneKind = z.infer<typeof ZoneKind>;

/** A zone with an optional display name ("Base (office)"). */
export const AgentZone = z.object({
  kind: ZoneKind,
  name: z.string().min(1).max(48).optional(),
});
export type AgentZone = z.infer<typeof AgentZone>;

/** Agent roles (PLAN §7.3). Roles tune reflex weights, barks and skins. */
export const AgentRole = z.enum(['ceo', 'engineer', 'miner', 'farmer', 'guard', 'builder']);
export type AgentRole = z.infer<typeof AgentRole>;

/** Body idle modes (reflex 10). `follow` is how the CEO "listens". */
export const IdleMode = z.enum(['follow', 'stay', 'guard', 'wander']);
export type IdleMode = z.infer<typeof IdleMode>;

/** Brain model tier: Haiku while wandering, Opus while seated at a PC. Shown as `[H]` / `[O]`. */
export const ModelTier = z.enum(['haiku', 'opus']);
export type ModelTier = z.infer<typeof ModelTier>;

/** Autonomy levels (PLAN §6.5). */
export const Autonomy = z.enum(['listen', 'helpful', 'proactive']);
export type Autonomy = z.infer<typeof Autonomy>;

/** Who sits on a seat. */
export const Occupant = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('player') }),
  z.object({ kind: z.literal('agent'), agentId: AgentId }),
]);
export type Occupant = z.infer<typeof Occupant>;

/** Who wrote something (Codex pages, calendar events). */
export const Author = z.object({
  kind: z.enum(['player', 'agent', 'system']),
  /** Display name, e.g. "Jasper" or "Bram". */
  name: z.string().min(1).max(48),
  /** Set when `kind` is `agent`. */
  agentId: AgentId.optional(),
});
export type Author = z.infer<typeof Author>;

/** A crew member as the mod needs it for name tags, chat completion and screens. */
export const CrewMember = z.object({
  agentId: AgentId,
  handle: Handle,
  name: DisplayName,
  role: z.string().min(1).max(32),
  ceo: z.boolean(),
  status: z.enum(['alive', 'dead', 'dismissed']),
});
export type CrewMember = z.infer<typeof CrewMember>;

/** Brain scheduler / usage summary (`hello.ok.brains` and `brains.state`). */
export const BrainsSummary = z.object({
  inFlight: NonNegInt,
  queued: NonNegInt,
  max: NonNegInt,
  mode: z.enum(['normal', 'tired', 'asleep']),
  utilization: z.number().min(0).max(1).nullable(),
  /** Epoch milliseconds when usage resets, if known. */
  resetsAt: NonNegInt.nullable(),
});
export type BrainsSummary = z.infer<typeof BrainsSummary>;

/** A free-form JSON object (skill args and results). */
export const JsonObject = z.record(z.string(), z.unknown());
