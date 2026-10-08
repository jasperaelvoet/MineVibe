import { z } from 'zod';
import { AgentId, JobId, MeetingId, NonNegInt, Occupant, PcId } from './common.js';
import { type CatalogEntry, defineMessage } from './define.js';

/** A seat an agent is sent to: a PC chair, or a chair at the meeting table (PLAN §6.3 "Seat kinds"). */
export const SeatTarget = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('pc'), pcId: PcId }),
  z.object({ kind: z.literal('meeting'), meetingId: MeetingId }),
]);
export type SeatTarget = z.infer<typeof SeatTarget>;

/**
 * Why someone left (or must leave) a seat: the SeatFSM edges out of a seated state (PLAN §6.3), plus
 * `away` (the agent walks to the player to ask, chair stays reserved), `player_took` (the player took the
 * chair of an away agent) and `reservation_expired` (3 min away).
 */
export const UnseatReason = z.enum([
  'stand',
  'kick',
  'damage',
  'survival',
  'death',
  'pc_down',
  'meeting',
  'world_end',
  'dismiss',
  'app_restart',
  'worker_restart',
  'away',
  'player_took',
  'reservation_expired',
]);
export type UnseatReason = z.infer<typeof UnseatReason>;

/** Seat errors (`err` codes of `agent.seat`). `PC_DOWN` and `SEAT_CAP` are Node's own pre-checks. */
export const SEAT_ERROR_CODES = [
  'PC_DOWN',
  'SEAT_CAP',
  'RESERVED',
  'OCCUPIED_BY_PLAYER',
  'UNREACHABLE',
] as const;

/**
 * N→M request. Runs the sit job: reserve the chair ("Bram is coming"), walk there, then a non-forced
 * `startRiding`. The `ok` reply ({@link AgentSeatResult}) means the job started; its outcome arrives as
 * `skill.result{jobId}` (and `pc.seat` for a PC). Errors: `RESERVED`, `OCCUPIED_BY_PLAYER`, `UNREACHABLE`,
 * `NO_SEAT` (no free meeting chair), `UNKNOWN_AGENT`, `PC_UNKNOWN`.
 */
export const AgentSeat = defineMessage('agent.seat', {
  agentId: AgentId,
  jobId: JobId,
  /** SeatFSM epoch the job belongs to; the mod echoes it in `pc.seat`. */
  seatEpoch: NonNegInt,
  target: SeatTarget,
  /** Shown on the monitor while coming ("fix the failing test"). */
  purpose: z.string().min(1).max(200).optional(),
}).describe('Sends an agent to sit at a PC or a meeting chair (a job).');

export const AgentSeatResult = z.object({
  jobId: JobId,
  status: z.literal('running'),
});
export type AgentSeatResult = z.infer<typeof AgentSeatResult>;

/**
 * N→M request. Stand an agent up. With `keepReservation` the chair stays reserved for it (`away`: asking the
 * player; `meeting`: pulled into a meeting). The mod steps the agent aside and, for `kick`, starts the 30 s
 * re-sit cooldown and plays a bark.
 */
export const AgentUnseat = defineMessage('agent.unseat', {
  agentId: AgentId,
  seatEpoch: NonNegInt,
  reason: UnseatReason,
  keepReservation: z.boolean(),
}).describe('Stands an agent up from its seat.');

/** M→N. Someone sat down on a PC chair (the authoritative PcRegistry changed). */
export const PcSeat = defineMessage('pc.seat', {
  pcId: PcId,
  occupant: Occupant,
  /** For an agent: the epoch of the `agent.seat` that brought it there. */
  seatEpoch: NonNegInt.optional(),
}).describe('A PC chair got an occupant.');

/** M→N. A PC chair was left (or its occupant was removed). */
export const PcUnseat = defineMessage('pc.unseat', {
  pcId: PcId,
  occupant: Occupant,
  reason: UnseatReason,
  /** The reservation survives (agent `away` or in a meeting). */
  reserved: z.boolean(),
}).describe('A PC chair was left.');

export const seatMessages = {
  'agent.seat': {
    schema: AgentSeat,
    direction: 'node_to_mod',
    group: 'seats',
    summary: 'Request: reserve a PC or meeting chair, walk there and sit (a job).',
    reply: AgentSeatResult,
  },
  'agent.unseat': {
    schema: AgentUnseat,
    direction: 'node_to_mod',
    group: 'seats',
    summary: 'Request: stand an agent up (optionally keeping its reservation).',
  },
  'pc.seat': {
    schema: PcSeat,
    direction: 'mod_to_node',
    group: 'seats',
    summary: 'A PC chair got an occupant (player or agent).',
  },
  'pc.unseat': {
    schema: PcUnseat,
    direction: 'mod_to_node',
    group: 'seats',
    summary: 'A PC chair was left, with the reason (stand, kick, damage, ...).',
  },
} as const satisfies Record<string, CatalogEntry>;
