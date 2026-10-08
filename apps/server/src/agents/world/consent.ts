/**
 * Consent to change protected blocks (protocol §7.4.3). Node is the only one who can mint it; the model never can,
 * because no tool takes one and the `mc` server strips anything that looks like one from tool arguments.
 *
 * 1. A job fails `PROTECTED`: the refusal (its blocks and zone) is noted for that agent ({@link noteRefusal}).
 * 2. The player explicitly allows it, within {@link REFUSAL_TTL_MS}:
 *    - **Card path** (preferred): a question card of that agent, raised after the refusal, answered with an option
 *      whose label starts with "Allow" (every chosen label must). Free text on a card counts only as a clear grant
 *      (below).
 *    - **Chat path**: a direct reply to that one agent that clearly grants it: it starts with a plain yes ("yes",
 *      "ok", "go ahead", ...), names an action (break, take, use, mine, dig, ...) and points at the thing ("them",
 *      "it", "the house", "the base", ...), with no negation, hedge or question, in at most 16 words. Anything else
 *      is ambiguous and needs the card. A chat grant needs the refused positions: a zone-wide grant is card-only.
 * 3. Node issues a consent for exactly the refused positions (or, card only, the zone when the mod named none), for
 *    that agent, valid {@link CONSENT_TTL_MS}. The `mc` server attaches it to that agent's world jobs (`skill.run`
 *    `consent`) until it expires. A new refusal or grant replaces the old one; death and world end clear them.
 */

import { randomBytes } from 'node:crypto';
import type { BlockPos, SkillConsent, ZoneKind } from '@minevibe/protocol';
import type { QuestionCard } from '../PendingStore.js';
import type { Refusal } from './guard.js';

/** How long an issued consent is valid. */
export const CONSENT_TTL_MS = 5 * 60_000;
/** How long after a refusal the player's answer can still grant it. */
export const REFUSAL_TTL_MS = 10 * 60_000;
/** A chat grant longer than this is not "plain". */
const CHAT_GRANT_MAX_WORDS = 16;

export interface OpenRefusal extends Refusal {
  readonly agentId: string;
  readonly at: number;
}

export interface ConsentGrant extends SkillConsent {
  readonly via: 'card' | 'chat';
}

/** Why a reply did or did not grant consent. */
export type GrantVerdict =
  | { readonly kind: 'granted'; readonly grant: ConsentGrant }
  /** Nothing was refused lately (or the reply was no grant at all). */
  | { readonly kind: 'none' }
  /** It might be a grant, but not clearly: the player should use the card. */
  | { readonly kind: 'unclear'; readonly reason: string };

const AFFIRM_RE =
  /^(yes|yeah|yep|yup|sure|ok|okay|alright|all right|go ahead|go for it|fine|allowed|you may|you can|permission granted|approved?)\b/;
const ACTION_RE = /\b(break|mine|take|use|dig|remove|chop|cut|knock|tear|grab)\b/;
const REFERENCE_RE =
  /\b(it|them|those|these|that|this|house|base|office|home|wall|walls|pillar|pillars|corner|corners|build|building)\b/;
const HEDGE_RE =
  /\?|\b(no|not|don'?t|dont|never|nope|nah|stop|wait|later|skip|instead|further|farther|but|unless|only|except|maybe|perhaps|hmm|first|rather|other)\b/;
const ALLOW_RE = /^\s*allow\b/i;

/** An option label that grants (starts with "Allow"). */
export function isAllowLabel(label: string): boolean {
  return ALLOW_RE.test(label);
}

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[’`]/g, "'")
    .replace(/[,.!;:()"]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Whether a free-text reply clearly grants the change (see the module comment). */
export function clearlyGrants(text: string): boolean {
  const t = normalize(text);
  if (t.length === 0 || t.split(' ').length > CHAT_GRANT_MAX_WORDS) return false;
  if (HEDGE_RE.test(t)) return false;
  return AFFIRM_RE.test(t) && ACTION_RE.test(t) && REFERENCE_RE.test(t);
}

/** Whether a free-text reply looks like it means yes (to tell the player to use the card when it is not clear). */
function soundsLikeYes(text: string): boolean {
  const t = normalize(text);
  return AFFIRM_RE.test(t) || /^(allow|take|break|use|mine|dig)\b/.test(t);
}

export class ConsentLedger {
  readonly #now: () => number;
  readonly #mintId: () => string;
  readonly #refusals = new Map<string, OpenRefusal>();
  readonly #grants = new Map<string, ConsentGrant>();

  constructor(options: { now?: () => number; mintId?: () => string } = {}) {
    this.#now = options.now ?? Date.now;
    this.#mintId = options.mintId ?? (() => `consent-${randomBytes(8).toString('hex')}`);
  }

  /** A job of `agentId` was refused `PROTECTED`. */
  noteRefusal(agentId: string, refusal: Refusal): void {
    this.#refusals.set(agentId, { ...refusal, agentId, at: this.#now() });
  }

  /** The agent's refusal the player can still allow, or null. */
  openRefusal(agentId: string): OpenRefusal | null {
    const r = this.#refusals.get(agentId);
    if (!r) return null;
    if (this.#now() - r.at > REFUSAL_TTL_MS) {
      this.#refusals.delete(agentId);
      return null;
    }
    return r;
  }

  /** A question card of `agentId` was answered (`answers`: question text → chosen label(s) or free text). */
  fromCard(
    agentId: string,
    card: Pick<QuestionCard, 'createdAt' | 'questions'>,
    answers: Readonly<Record<string, string>>,
  ): GrantVerdict {
    const refusal = this.openRefusal(agentId);
    if (!refusal || card.createdAt < refusal.at) return { kind: 'none' };
    let granted = false;
    let unclear = false;
    for (const q of card.questions) {
      const value = answers[q.question];
      if (value === undefined) continue;
      const labels = q.options.map((o) => o.label);
      const parts = value.split(', ');
      const chosen = labels.filter((l) => value === l || parts.includes(l));
      if (chosen.length > 0) {
        if (chosen.every(isAllowLabel)) granted = true;
        continue;
      }
      if (clearlyGrants(value)) granted = true;
      else if (soundsLikeYes(value)) unclear = true;
    }
    if (granted) return { kind: 'granted', grant: this.#issue(refusal, 'card') };
    return unclear
      ? { kind: 'unclear', reason: 'pick the "Allow" option on the card to allow it' }
      : { kind: 'none' };
  }

  /** A direct chat reply to `agentId` (not a card answer). */
  fromChat(agentId: string, text: string): GrantVerdict {
    const refusal = this.openRefusal(agentId);
    if (!refusal) return { kind: 'none' };
    if (!clearlyGrants(text)) {
      return soundsLikeYes(text)
        ? { kind: 'unclear', reason: 'not a clear permission; answer the card to allow it' }
        : { kind: 'none' };
    }
    if (refusal.positions.length === 0) {
      return { kind: 'unclear', reason: 'a permission for a whole area needs the card' };
    }
    return { kind: 'granted', grant: this.#issue(refusal, 'chat') };
  }

  /** The agent's valid consent (attached to its world jobs), or null. */
  active(agentId: string): SkillConsent | null {
    const g = this.#grants.get(agentId);
    if (!g) return null;
    if (g.expiresAt <= this.#now()) {
      this.#grants.delete(agentId);
      return null;
    }
    const { via: _via, ...consent } = g;
    return consent;
  }

  /** Drops an agent's refusal and consent (death, dismissal), or everyone's (world end). */
  clear(agentId?: string): void {
    if (agentId === undefined) {
      this.#refusals.clear();
      this.#grants.clear();
      return;
    }
    this.#refusals.delete(agentId);
    this.#grants.delete(agentId);
  }

  #issue(refusal: OpenRefusal, via: 'card' | 'chat'): ConsentGrant {
    const positions: BlockPos[] = refusal.positions.map((p) => ({ x: p.x, y: p.y, z: p.z }));
    const zone: ZoneKind = refusal.zone ?? 'base';
    const grant: ConsentGrant = {
      consentId: this.#mintId(),
      agentId: refusal.agentId,
      ...(positions.length > 0 ? { positions } : { zone }),
      expiresAt: this.#now() + CONSENT_TTL_MS,
      via,
    };
    this.#grants.set(refusal.agentId, grant);
    this.#refusals.delete(refusal.agentId);
    return grant;
  }
}

/** "4 protected blocks" / "protected blocks in the Base", for toasts and notices. */
export function grantScope(grant: SkillConsent): string {
  const n = grant.positions?.length ?? 0;
  if (n > 0) return `${n} protected block${n === 1 ? '' : 's'}`;
  return grant.zone === 'built' ? 'protected player-built blocks' : 'protected blocks of the Base';
}
