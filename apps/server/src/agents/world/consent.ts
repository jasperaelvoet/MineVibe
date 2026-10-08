/**
 * Consent to change protected blocks (protocol §7.4.3). Node is the only one who can mint it; the model never can,
 * because no tool takes one and the `mc` server strips anything that looks like one from tool arguments.
 *
 * 1. A job fails `PROTECTED`: the refusal (its blocks and zone) is noted for that agent ({@link noteRefusal}).
 * 2. The player explicitly allows it, within {@link REFUSAL_TTL_MS}:
 *    - **Card path** (preferred): a question card of that agent, raised after the refusal, answered with an option
 *      whose label starts with "Allow" and whose label or description names the protected thing ("Allow: take the
 *      Base logs", "Allow: break those stripped_spruce_log"); every chosen option must. The model writes the
 *      options, so an "Allow" option that names something else ("Allow: go further") grants nothing. Free text on a
 *      card counts only as a clear grant (below).
 *    - **Chat path**: a direct reply to that one agent that clearly grants it: it starts with a plain yes ("yes",
 *      "ok", "go ahead", ...), names an action (break, take, use, mine, dig, ...) and names the protected thing
 *      itself ("the house", "the base", "the pillars", the refused block), with no negation, hedge or question, in
 *      at most 16 words. A pronoun ("yes, take it") is ambiguous: the player may be answering another question, so
 *      it needs the card. A chat grant needs the refused positions: a zone-wide grant is card-only.
 * 3. Node grants the mod's own consent token of that refusal (`result.protected.consentId`: single use, bound by the
 *    mod to that agent and the box of the refused blocks), valid {@link CONSENT_TTL_MS} and never past the mod's own
 *    expiry. The `mc` server hands it back (`skill.run` `consent: { token }`) on that agent's next block-changing job
 *    that asks for it (`allow_protected`), once. A refusal Node raised itself carries no token and cannot be allowed.
 *    A new refusal or grant replaces the old one; death and world end clear them.
 */

import type { BlockPos, SkillConsent, ZoneKind } from '@minevibe/protocol';
import type { QuestionCard } from '../PendingStore.js';
import type { Refusal } from './guard.js';

/** How long an issued consent is valid. */
export const CONSENT_TTL_MS = 5 * 60_000;
/** The mod's tokens expire 10 minutes after the refusal; Node stops using one a little earlier. */
export const MOD_TOKEN_TTL_MS = 10 * 60_000 - 30_000;
/** How long after a refusal the player's answer can still grant it. */
export const REFUSAL_TTL_MS = 9 * 60_000;
/** A chat grant longer than this is not "plain". */
const CHAT_GRANT_MAX_WORDS = 16;

export interface OpenRefusal extends Refusal {
  readonly agentId: string;
  readonly at: number;
}

/** A consent the player gave: the mod's token for one refusal, and what it covers (for toasts and notices). */
export interface ConsentGrant {
  readonly token: string;
  readonly agentId: string;
  /** The refused blocks the mod reported (it unlocks the box around them). */
  readonly positions: readonly BlockPos[];
  /** How many protected blocks the refusal met, when the mod said. */
  readonly count?: number | undefined;
  readonly zone: ZoneKind;
  readonly expiresAt: number;
  readonly via: 'card' | 'chat';
}

/** Why a reply did or did not grant consent. */
export type GrantVerdict =
  | { readonly kind: 'granted'; readonly grant: ConsentGrant }
  /** Nothing was refused lately (or the reply was no grant at all). */
  | { readonly kind: 'none' }
  /** It might be a grant, but not clearly: the player should use the card. */
  | { readonly kind: 'unclear'; readonly reason: string };

/** Why a clear "Allow" grants nothing: the refusal came from Node itself, so the mod offered no token. */
const NO_TOKEN = 'that refusal cannot be allowed yet: retry the job so the game itself can ask';

const AFFIRM_RE =
  /^(yes|yeah|yep|yup|sure|ok|okay|alright|all right|go ahead|go for it|fine|allowed|you may|you can|permission granted|approved?)\b/;
const ACTION_RE = /\b(break|mine|take|use|dig|remove|chop|cut|knock|tear|grab)\b/;
/**
 * Words that name the protected thing itself. Pronouns ("it", "them") don't: they may point at anything; nor do words
 * as common outside the Base as "wall", "floor" or "home" (a cave wall, the forest floor, "take them home").
 */
const PROTECTED_RE = /\b(base|house|office|pillars?|protected)\b/;
/** "back to base", "in the house", "the base of the tree": not the Base as what to break. */
const PLACE_RE =
  /\b(to|into|back to|in|inside|at|near|around|by|toward|towards)\s+(the\s+|my\s+|your\s+|our\s+)?(base|house|office|home)\b|\bbase of\b/g;
/** Furniture and supplies: using them needs no permission, so a reply about them is not one. */
const FURNITURE_RE =
  /\b(chests?|crafting|tables?|furnaces?|beds?|barrels?|bread|food|torch(es)?|pcs?|computers?)\b/;
const HEDGE_RE =
  /\?|\b(no|not|don'?t|dont|never|nope|nah|stop|wait|later|skip|instead|further|farther|but|unless|only|except|maybe|perhaps|hmm|first|rather|other)\b/;
const ALLOW_RE = /^\s*allow\b/i;
/** An "Allow" option that says the Base stays as it is ("Allow: go further, the house stays untouched"). */
const OPTION_HEDGE_RE =
  /\b(no|not|never|don'?t|untouched|leave|leaves|stay|stays|keep|keeps|safe|intact|skip|further|farther)\b/;

/** An option label that starts with "Allow" (it grants only if it also {@link namesProtected names the thing}). */
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

/**
 * Whether `text` names the protected thing: one of the refused `blocks` ("stripped_spruce_log", also written
 * "stripped spruce logs"), or the Base itself ("the house logs", "the pillars", "the Base"), not as a destination
 * ("back to base") and not about its furniture ("the house's crafting table", "bread from the chest"), which needs
 * no permission.
 */
export function namesProtected(text: string, blocks: readonly string[] = []): boolean {
  const t = normalize(text).replace(/_/g, ' ');
  const named = blocks.some((b) => {
    const phrase = b
      .toLowerCase()
      .replace(/^minecraft:/, '')
      .replace(/_/g, ' ')
      .trim();
    return phrase.length > 0 && t.includes(phrase);
  });
  if (named) return true;
  if (FURNITURE_RE.test(t)) return false;
  return PROTECTED_RE.test(t.replace(PLACE_RE, ' '));
}

/** Whether a free-text reply clearly grants the change (see the module comment). */
export function clearlyGrants(text: string, blocks: readonly string[] = []): boolean {
  const t = normalize(text);
  if (t.length === 0 || t.split(' ').length > CHAT_GRANT_MAX_WORDS) return false;
  if (HEDGE_RE.test(t)) return false;
  return AFFIRM_RE.test(t) && ACTION_RE.test(t) && namesProtected(t, blocks);
}

/**
 * Whether a free-text reply may mean yes to the refused change (to tell the player to use the card): a bare yes, a yes
 * with an action ("yes, take it"), or an order ("take them"). "ok, go further" answers something else.
 */
function soundsLikeYes(text: string): boolean {
  const t = normalize(text);
  if (/^(allow|take|break|use|mine|dig)\b/.test(t)) return true;
  if (!AFFIRM_RE.test(t)) return false;
  return ACTION_RE.test(t) || t.replace(AFFIRM_RE, '').trim().length === 0;
}

export class ConsentLedger {
  readonly #now: () => number;
  readonly #refusals = new Map<string, OpenRefusal>();
  readonly #grants = new Map<string, ConsentGrant>();

  constructor(options: { now?: () => number } = {}) {
    this.#now = options.now ?? Date.now;
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
      const parts = value.split(', ');
      const chosen = q.options.filter((o) => value === o.label || parts.includes(o.label));
      if (chosen.length > 0) {
        // The player reads the label and its description: together they must name what gets unlocked.
        const grants = (o: (typeof chosen)[number]) => {
          const text = `${o.label} ${o.description ?? ''}`;
          return (
            isAllowLabel(o.label) &&
            namesProtected(text, refusal.blocks) &&
            !OPTION_HEDGE_RE.test(normalize(text))
          );
        };
        if (chosen.every(grants)) granted = true;
        else if (chosen.some((o) => isAllowLabel(o.label))) unclear = true;
        continue;
      }
      if (clearlyGrants(value, refusal.blocks)) granted = true;
      else if (soundsLikeYes(value)) unclear = true;
    }
    if (granted) {
      const grant = this.#issue(refusal, 'card');
      return grant ? { kind: 'granted', grant } : { kind: 'unclear', reason: NO_TOKEN };
    }
    return unclear
      ? { kind: 'unclear', reason: 'only an "Allow" option that names the protected blocks allows it' }
      : { kind: 'none' };
  }

  /** A direct chat reply to `agentId` (not a card answer). */
  fromChat(agentId: string, text: string): GrantVerdict {
    const refusal = this.openRefusal(agentId);
    if (!refusal) return { kind: 'none' };
    if (!clearlyGrants(text, refusal.blocks)) {
      return soundsLikeYes(text)
        ? { kind: 'unclear', reason: 'not a clear permission; answer the card to allow it' }
        : { kind: 'none' };
    }
    if (refusal.positions.length === 0) {
      return { kind: 'unclear', reason: 'a permission for a whole area needs the card' };
    }
    const grant = this.#issue(refusal, 'chat');
    return grant ? { kind: 'granted', grant } : { kind: 'unclear', reason: NO_TOKEN };
  }

  /** The agent's valid consent (what it may change), or null. Does not use it up. */
  active(agentId: string): ConsentGrant | null {
    const g = this.#grants.get(agentId);
    if (!g) return null;
    if (g.expiresAt <= this.#now()) {
      this.#grants.delete(agentId);
      return null;
    }
    return g;
  }

  /** Uses up the agent's valid consent for one `skill.run` (the mod's token is single use), or null. */
  take(agentId: string): SkillConsent | null {
    const g = this.active(agentId);
    if (!g) return null;
    this.#grants.delete(agentId);
    return { token: g.token };
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

  #issue(refusal: OpenRefusal, via: 'card' | 'chat'): ConsentGrant | null {
    if (!refusal.consentId) return null;
    const grant: ConsentGrant = {
      token: refusal.consentId,
      agentId: refusal.agentId,
      positions: refusal.positions.map((p) => ({ x: p.x, y: p.y, z: p.z })),
      ...(refusal.count !== undefined ? { count: refusal.count } : {}),
      zone: refusal.zone ?? 'base',
      expiresAt: Math.min(this.#now() + CONSENT_TTL_MS, refusal.at + MOD_TOKEN_TTL_MS),
      via,
    };
    this.#grants.set(refusal.agentId, grant);
    this.#refusals.delete(refusal.agentId);
    return grant;
  }
}

/** "4 protected blocks" / "protected blocks in the Base", for toasts and notices. */
export function grantScope(grant: Pick<ConsentGrant, 'positions' | 'count' | 'zone'>): string {
  const n = Math.max(grant.positions.length, grant.count ?? 0);
  if (n > 0) return `${n} protected block${n === 1 ? '' : 's'}`;
  return grant.zone === 'built' ? 'protected player-built blocks' : 'protected blocks of the Base';
}
