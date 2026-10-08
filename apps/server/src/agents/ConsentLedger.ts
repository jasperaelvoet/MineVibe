/**
 * ConsentLedger (W1): the player's consent for an agent to change protected blocks (the player's builds, the Base).
 *
 * The mod refuses such changes with `PROTECTED` and offers a consent token (`result.protected.consentId`) bound to
 * that agent and those blocks. The ledger keeps the offer. Only a player-originated path may {@link grant} it (the
 * player explicitly agreeing in the UI or chat); the model never can: tool input reaches the mod only as `args`, and
 * the token travels outside `args` (`skill.run.consent`), attached by the `mc` tools only when the agent asks with
 * `allow_protected` and the ledger holds a granted, unexpired token for it ({@link take}). Each token is single use,
 * in the ledger and in the mod.
 */

import { ConsentToken, type ProtectedDetail } from '@minevibe/protocol';

/** An offer the mod made with a `PROTECTED` failure. */
export interface ConsentOffer {
  readonly agentId: string;
  readonly token: string;
  readonly detail: ProtectedDetail;
  readonly offeredAt: number;
  granted: boolean;
}

/** How long an offer stays answerable; the mod's own tokens expire after 10 minutes. */
export const CONSENT_TTL_MS = 9 * 60_000;

export class ConsentLedger {
  readonly #offers = new Map<string, ConsentOffer[]>();
  readonly #now: () => number;

  constructor(options: { now?: () => number } = {}) {
    this.#now = options.now ?? Date.now;
  }

  /** Records the offer of a `PROTECTED` failure (ignored without a valid token). */
  offered(agentId: string, detail: ProtectedDetail): void {
    if (!detail.consentId || !ConsentToken.safeParse(detail.consentId).success) return;
    const list = this.#fresh(agentId);
    list.push({ agentId, token: detail.consentId, detail, offeredAt: this.#now(), granted: false });
    while (list.length > 8) list.shift();
    this.#offers.set(agentId, list);
  }

  /** The newest open (not yet granted) offer of an agent: what the player would be asked about. */
  pending(agentId: string): ConsentOffer | null {
    const list = this.#fresh(agentId).filter((o) => !o.granted);
    return list.at(-1) ?? null;
  }

  /**
   * The player agreed to the offer `token` of `agentId` (the newest open one when `token` is omitted). Call this only
   * from a path the player drives (a UI button, an answered card, a chat command); never from tool input.
   */
  grant(agentId: string, token?: string): boolean {
    const open = this.#fresh(agentId).filter((o) => !o.granted);
    const target = token === undefined ? open.at(-1) : open.find((o) => o.token === token);
    if (!target) return false;
    target.granted = true;
    return true;
  }

  /** Takes (uses up) the newest granted token of `agentId`, or null. */
  take(agentId: string): string | null {
    const list = this.#fresh(agentId);
    for (let i = list.length - 1; i >= 0; i--) {
      const offer = list[i];
      if (offer?.granted) {
        list.splice(i, 1);
        return offer.token;
      }
    }
    return null;
  }

  /** Drops everything of an agent (death, dismissal, world change). */
  forget(agentId: string): void {
    this.#offers.delete(agentId);
  }

  #fresh(agentId: string): ConsentOffer[] {
    const now = this.#now();
    const list = (this.#offers.get(agentId) ?? []).filter((o) => now - o.offeredAt < CONSENT_TTL_MS);
    this.#offers.set(agentId, list);
    return list;
  }
}
