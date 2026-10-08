import { TypedEmitter } from '../util/TypedEmitter.js';

/**
 * Who sits at which PC, as the mod's PcRegistry reports it (`pc.seat` / `pc.unseat`, protocol §7.5). The mod is
 * authoritative; this is Node's copy, used for the occupant checks of player input (`pc.input`) and of the seated
 * agent's PC tools (PcApi), for background-job ownership (`agentId:seatEpoch`), and for `pc.state`.
 */

export type SeatOccupant =
  | { readonly kind: 'player' }
  | { readonly kind: 'agent'; readonly agentId: string; readonly seatEpoch: number | null };

export interface SeatReservation {
  readonly agentId: string;
  /** `coming`: walking to the chair; `away`: asking the player (or in a meeting), chair kept. */
  readonly kind: 'coming' | 'away';
}

export interface SeatState {
  readonly occupant: SeatOccupant | null;
  readonly reservation: SeatReservation | null;
}

const EMPTY: SeatState = Object.freeze({ occupant: null, reservation: null });

export type SeatBookEvents = {
  /** The seat state of a PC changed. */
  change: [pcId: string, now: SeatState, before: SeatState];
};

/** `agentId:seatEpoch`, the tag every guest process of a seated agent carries (PLAN §6.2). */
export function seatTag(agentId: string, seatEpoch: number | null): string {
  return `${agentId}:${seatEpoch ?? 0}`;
}

/** The agent id of a `agentId:seatEpoch` tag (null when malformed). */
export function tagAgent(tag: string): string | null {
  const i = tag.lastIndexOf(':');
  if (i <= 0) return null;
  return /^\d+$/.test(tag.slice(i + 1)) ? tag.slice(0, i) : null;
}

export class SeatBook extends TypedEmitter<SeatBookEvents> {
  readonly #seats = new Map<string, SeatState>();

  get(pcId: string): SeatState {
    return this.#seats.get(pcId) ?? EMPTY;
  }

  /** The seated agent of a PC, or null (nobody, or the player). */
  agentAt(pcId: string): { agentId: string; seatEpoch: number | null } | null {
    const o = this.get(pcId).occupant;
    return o?.kind === 'agent' ? { agentId: o.agentId, seatEpoch: o.seatEpoch } : null;
  }

  playerAt(pcId: string): boolean {
    return this.get(pcId).occupant?.kind === 'player';
  }

  /** The PC an agent sits at, if any. */
  pcOfAgent(agentId: string): string | null {
    for (const [pcId, s] of this.#seats) {
      if (s.occupant?.kind === 'agent' && s.occupant.agentId === agentId) return pcId;
    }
    return null;
  }

  /** `pc.seat`: someone sat down. An agent sitting elsewhere is moved (a PC chair holds one occupant). */
  seat(pcId: string, occupant: SeatOccupant): void {
    if (occupant.kind === 'agent') {
      const elsewhere = this.pcOfAgent(occupant.agentId);
      if (elsewhere && elsewhere !== pcId) this.#set(elsewhere, { ...this.get(elsewhere), occupant: null });
    }
    this.#set(pcId, { occupant, reservation: null });
  }

  /**
   * `pc.unseat`: someone left. Ignored when `who` is not the recorded occupant (a stale or out-of-order message).
   * With `reserved` the chair stays reserved for the agent. Returns the occupant that left, or null.
   */
  unseat(
    pcId: string,
    who: { kind: 'player' } | { kind: 'agent'; agentId: string },
    reserved: boolean,
  ): SeatOccupant | null {
    const cur = this.get(pcId);
    const o = cur.occupant;
    const matches =
      o !== null &&
      o.kind === who.kind &&
      (o.kind === 'player' || (who.kind === 'agent' && o.agentId === who.agentId));
    if (!matches) {
      // The reservation of an agent that is not seated (it walked away before) can still be released.
      if (who.kind === 'agent' && !reserved && cur.reservation?.agentId === who.agentId) {
        this.#set(pcId, { ...cur, reservation: null });
      }
      return null;
    }
    const reservation: SeatReservation | null =
      reserved && who.kind === 'agent' ? { agentId: who.agentId, kind: 'away' } : null;
    this.#set(pcId, { occupant: null, reservation });
    return o;
  }

  /** Marks a reservation (or clears it with null) without changing the occupant. */
  reserve(pcId: string, reservation: SeatReservation | null): void {
    this.#set(pcId, { ...this.get(pcId), reservation });
  }

  /** Forgets a PC (decommissioned) or everything (world end, mod gone). */
  clear(pcId?: string): void {
    const ids = pcId === undefined ? [...this.#seats.keys()] : [pcId];
    for (const id of ids) this.#set(id, EMPTY);
  }

  #set(pcId: string, next: SeatState): void {
    const before = this.get(pcId);
    if (
      sameOccupant(before.occupant, next.occupant) &&
      before.reservation?.agentId === next.reservation?.agentId &&
      before.reservation?.kind === next.reservation?.kind
    ) {
      return;
    }
    if (next.occupant === null && next.reservation === null) this.#seats.delete(pcId);
    else this.#seats.set(pcId, next);
    this.emit('change', pcId, next, before);
  }
}

function sameOccupant(a: SeatOccupant | null, b: SeatOccupant | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.kind !== b.kind) return false;
  return (
    a.kind === 'player' || (b.kind === 'agent' && a.agentId === b.agentId && a.seatEpoch === b.seatEpoch)
  );
}
