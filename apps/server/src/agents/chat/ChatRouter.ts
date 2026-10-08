/**
 * ChatRouter (PLAN §6.5 "Chat routing"): turns one player chat line into deliveries.
 *
 * Parsing
 * - Only **leading** mentions route; `@` must start the message or follow whitespace. Mentions later in
 *   the text are references. A leading `@name` must be followed by whitespace (optionally after `,:;.!?`),
 *   otherwise the line is refused rather than silently broadcast ("@ada,@bram" -> "put a space …").
 * - Names resolve via {@link resolveHandle}: exact beats a unique prefix of ≥ 2 characters; ambiguous,
 *   unknown, too-short and dead names are errors with an inline hint, and nothing is sent.
 * - `@all` / `@everyone` broadcast explicitly; `@all!` also wakes seated agents. `@ceo` is the CEO alias.
 *   `@meeting <text>` goes to the running meeting; exactly `@meeting end` ends it.
 *
 * Delivery
 * - Mentions: only the named agents receive the message and wake. The CEO is not copied.
 * - No mention: every living agent receives it. Wandering agents wake; seated agents get it as context
 *   unless they are named in the text or the line starts with `@all!`.
 * - During a meeting with the player in scope (within 16 blocks or chairing), unmentioned lines go to the
 *   meeting; agents not at the table get a context copy. The echo shows "You → meeting (3)".
 * - Only a message whose leading mentions address exactly one agent may resolve that agent's front card
 *   (see answerGrammar). Broadcasts never do: "(not an answer: 2 cards pending, use @ada or G)".
 *
 * The router is pure: callers pass a snapshot of the crew, cards and meeting, and act on the result.
 * Debounce and stale-wake handling live in {@link ChatInbox}.
 */

import { CHAT_MAX_LENGTH, ERROR_CODES, type KnownErrorCode } from '@minevibe/protocol';
import {
  clip,
  formatAnswerEcho,
  frontCard,
  type Interpretation,
  interpretAnswer,
  type PendingCard,
} from './answerGrammar.js';
import { type HandleResolution, type HandleTarget, resolveHandle } from './handles.js';

/** A crew member as the router sees it. */
export interface ChatAgent extends HandleTarget {
  /** Seated at a PC (meeting chairs do not count). */
  readonly seated: boolean;
}

/** The running meeting, if any. */
export interface MeetingScope {
  readonly meetingId: string;
  /** Agents at the table or dialled in. */
  readonly attendees: readonly string[];
  readonly chairId: string | null;
  /** Player within 16 blocks of the table, or chairing it. Only then do unmentioned lines go to the meeting. */
  readonly playerInScope: boolean;
}

export interface ChatContext {
  readonly playerName: string;
  /** Every crew member of the current world, living or not. */
  readonly crew: readonly ChatAgent[];
  /** Pending cards per agent id. */
  readonly cards: ReadonlyMap<string, readonly PendingCard[]>;
  readonly meeting: MeetingScope | null;
}

/** The `chat.send` payload. */
export interface ChatInput {
  /** `"all"`: a raw chat line (mentions parsed). A list: explicit recipients (text not mention-parsed). */
  readonly to: readonly string[] | 'all';
  readonly text: string;
}

export type ChatErrorCode =
  | 'empty'
  | 'too_long'
  | 'malformed'
  | 'unknown'
  | 'ambiguous'
  | 'too_short'
  | 'unavailable'
  | 'no_ceo'
  | 'mixed'
  | 'no_meeting'
  | 'invalid_answer';

export interface ChatError {
  readonly code: ChatErrorCode;
  /** Inline hint shown under the chat box; the text stays in the box. */
  readonly hint: string;
  /** The `err` code sent on the wire. */
  readonly wireCode: KnownErrorCode;
}

export type DeliveryMode = 'wake' | 'context' | 'meeting';
export type DeliveryReason =
  | 'mention'
  | 'broadcast'
  | 'loud'
  | 'named'
  | 'seated'
  | 'meeting'
  | 'meeting_absent'
  | 'card_message';

export interface Delivery {
  readonly agentId: string;
  /** `wake`: P0 wake. `context`: `shouldQuery:false`. `meeting`: handed to the MeetingRunner. */
  readonly mode: DeliveryMode;
  readonly reason: DeliveryReason;
}

/** A card resolution the caller must apply (resolve canUseTool, hire decision, park). */
export type CardAnswer = Exclude<Interpretation, { kind: 'message' } | { kind: 'invalid' }> & {
  readonly agentId: string;
};

export type RouteScope = 'direct' | 'broadcast' | 'meeting';

export interface RouteOk {
  readonly ok: true;
  readonly scope: RouteScope;
  /** `@all!`: seated agents wake too. */
  readonly loud: boolean;
  /** The text with leading mentions removed. */
  readonly body: string;
  readonly deliveries: readonly Delivery[];
  readonly answer: CardAnswer | null;
  readonly command: 'meeting.end' | null;
  /** The player's own line for the chat log, showing how it was read. */
  readonly echo: string;
}

export type RouteResult = RouteOk | { readonly ok: false; readonly error: ChatError };

/** One leading `@token`. */
export interface MentionToken {
  /** As typed, e.g. "@Ada,". */
  readonly raw: string;
  /** Lowercased name without `@` and punctuation. */
  readonly name: string;
  /** Trailing punctuation contained `!`. */
  readonly bang: boolean;
}

export type MentionParse =
  | { readonly ok: true; readonly mentions: readonly MentionToken[]; readonly body: string }
  | { readonly ok: false; readonly token: string };

const MENTION_TOKEN_RE = /^@([A-Za-z][A-Za-z0-9_]*)([!?.,:;]*)/;

/**
 * Splits the leading `@mentions` off a chat line. A leading token that starts like a mention but is not
 * followed by whitespace or the end (e.g. "@ada,@bram", "@ada's") is reported as malformed.
 */
export function parseLeadingMentions(text: string): MentionParse {
  const mentions: MentionToken[] = [];
  let rest = text.replace(/^\s+/, '');
  while (rest.startsWith('@')) {
    const m = MENTION_TOKEN_RE.exec(rest);
    if (!m) break; // "@ " or "@123": not a mention; the rest is plain text
    const after = rest.charAt(m[0].length);
    if (after !== '' && !/\s/.test(after)) {
      return { ok: false, token: rest.split(/\s/, 1)[0] ?? m[0] };
    }
    mentions.push({ raw: m[0], name: (m[1] ?? '').toLowerCase(), bang: (m[2] ?? '').includes('!') });
    rest = rest.slice(m[0].length).replace(/^\s+/, '');
  }
  return { ok: true, mentions, body: rest.trim() };
}

function fail(code: ChatErrorCode, hint: string): RouteResult {
  const wireCode: KnownErrorCode =
    code === 'unknown' || code === 'no_ceo'
      ? ERROR_CODES.CHAT_UNKNOWN
      : code === 'ambiguous' || code === 'too_short'
        ? ERROR_CODES.CHAT_AMBIGUOUS
        : code === 'unavailable'
          ? ERROR_CODES.CHAT_UNAVAILABLE
          : code === 'invalid_answer'
            ? ERROR_CODES.CHAT_INVALID_ANSWER
            : ERROR_CODES.CHAT_REJECTED;
  return { ok: false, error: { code, hint, wireCode } };
}

function unavailableHint(agent: HandleTarget): string {
  if (agent.status === 'dismissed') return `${agent.name} was dismissed`;
  return agent.diedDay !== undefined ? `${agent.name} died on Day ${agent.diedDay}` : `${agent.name} died`;
}

function livingHandles(crew: readonly ChatAgent[]): string {
  const alive = crew.filter((a) => a.status === 'alive').map((a) => `@${a.handle}`);
  return alive.length > 0 ? alive.join(', ') : 'nobody';
}

function resolutionError(
  token: MentionToken,
  res: HandleResolution,
  crew: readonly ChatAgent[],
): RouteResult | null {
  const at = `@${token.name}`;
  switch (res.kind) {
    case 'agent':
    case 'reserved':
      return null;
    case 'unavailable':
      return fail('unavailable', unavailableHint(res.agent));
    case 'no_ceo':
      return fail('no_ceo', 'There is no CEO right now');
    case 'ambiguous':
      return fail('ambiguous', `${at} matches ${res.candidates.join(', ')}`);
    case 'too_short':
      return fail('too_short', `${at} matches ${res.candidates.join(', ')}: type at least 2 letters`);
    case 'unknown':
      return fail('unknown', `Nobody is called ${at}. Crew: ${livingHandles(crew)}`);
  }
}

/** Whole-word, case-insensitive: does `body` name this agent (by handle, `@handle` or display name)? */
export function namesAgent(body: string, agent: Pick<HandleTarget, 'handle' | 'name'>): boolean {
  const lower = body.toLowerCase();
  const words = new Set([agent.handle.toLowerCase(), agent.name.toLowerCase()]);
  for (const word of words) {
    if (word.length === 0) continue;
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}($|[^\\p{L}\\p{N}])`, 'u').test(lower)) return true;
  }
  return false;
}

function cardsNote(agents: readonly ChatAgent[], ctx: ChatContext): string {
  const withCards = agents.filter((a) => frontCard(ctx.cards.get(a.agentId) ?? []) !== null);
  if (withCards.length === 0) return '';
  const n = withCards.length;
  const who = withCards
    .slice(0, 3)
    .map((a) => `@${a.handle}`)
    .join('/');
  return ` (not an answer: ${n} card${n === 1 ? '' : 's'} pending, use ${who} or G)`;
}

function nameList(agents: readonly ChatAgent[]): string {
  return agents.map((a) => a.name).join(', ');
}

export interface ChatRouterOptions {
  readonly maxLength?: number;
}

export class ChatRouter {
  readonly #maxLength: number;

  constructor(options: ChatRouterOptions = {}) {
    this.#maxLength = options.maxLength ?? CHAT_MAX_LENGTH;
  }

  /** Routes one `chat.send`. Pure: the result says what to deliver, answer and echo. */
  route(input: ChatInput, ctx: ChatContext): RouteResult {
    const text = input.text.trim();
    if (text.length === 0) return fail('empty', 'Type a message first');
    if (text.length > this.#maxLength)
      return fail('too_long', `Messages are limited to ${this.#maxLength} characters`);

    if (input.to !== 'all') return this.#routeExplicit(input.to, text, ctx);

    const parsed = parseLeadingMentions(text);
    if (!parsed.ok) return fail('malformed', `Put a space after each @name (${clip(parsed.token, 40)})`);
    if (parsed.mentions.length === 0) return this.#routeBroadcast(parsed.body, false, true, ctx);

    const targets: ChatAgent[] = [];
    let broadcast = false;
    let loud = false;
    let meeting = false;
    for (const token of parsed.mentions) {
      const res = resolveHandle(token.name, ctx.crew);
      const err = resolutionError(token, res, ctx.crew);
      if (err) return err;
      if (res.kind === 'reserved') {
        if (res.word === 'meeting') meeting = true;
        else {
          broadcast = true;
          loud ||= token.bang;
        }
      } else if (res.kind === 'agent') {
        const agent = ctx.crew.find((a) => a.agentId === res.agent.agentId);
        if (agent && !targets.includes(agent)) targets.push(agent);
      }
    }

    const kinds = (broadcast ? 1 : 0) + (meeting ? 1 : 0) + (targets.length > 0 ? 1 : 0);
    if (kinds > 1) {
      return fail('mixed', '@all and @meeting cannot be combined with other names');
    }
    if (meeting) return this.#routeMeetingExplicit(parsed.body, ctx);
    if (parsed.body.length === 0) {
      const first = parsed.mentions[0]?.raw.replace(/[!?.,:;]+$/, '') ?? '@';
      return fail('empty', `Say something after ${first}`);
    }
    if (broadcast) return this.#routeBroadcast(parsed.body, loud, false, ctx);
    return this.#routeDirect(targets, parsed.body, ctx);
  }

  #routeExplicit(ids: readonly string[], text: string, ctx: ChatContext): RouteResult {
    const targets: ChatAgent[] = [];
    for (const id of ids) {
      const agent = ctx.crew.find((a) => a.agentId === id);
      if (!agent) return fail('unknown', `No crew member ${id}. Crew: ${livingHandles(ctx.crew)}`);
      if (agent.status !== 'alive') return fail('unavailable', unavailableHint(agent));
      if (!targets.includes(agent)) targets.push(agent);
    }
    return this.#routeDirect(targets, text, ctx);
  }

  #routeDirect(targets: readonly ChatAgent[], body: string, ctx: ChatContext): RouteResult {
    const only = targets.length === 1 ? targets[0] : undefined;
    if (only) {
      const card = frontCard(ctx.cards.get(only.agentId) ?? []);
      if (card) {
        const interp = interpretAnswer(card, body, only.handle);
        if (interp.kind === 'invalid') return fail('invalid_answer', interp.hint);
        const echo = formatAnswerEcho(only.name, card, interp, body);
        if (interp.kind === 'message') {
          return this.#ok(
            'direct',
            false,
            body,
            [{ agentId: only.agentId, mode: 'wake', reason: 'card_message' }],
            {
              echo,
            },
          );
        }
        return this.#ok('direct', false, body, [], { echo, answer: { ...interp, agentId: only.agentId } });
      }
    }
    const deliveries = targets.map(
      (a): Delivery => ({ agentId: a.agentId, mode: 'wake', reason: 'mention' }),
    );
    const note = targets.length > 1 ? cardsNote(targets, ctx) : '';
    return this.#ok('direct', false, body, deliveries, {
      echo: `You → ${nameList(targets)}: ${clip(body)}${note}`,
    });
  }

  #routeBroadcast(body: string, loud: boolean, implicit: boolean, ctx: ChatContext): RouteResult {
    const meeting = ctx.meeting;
    if (implicit && meeting?.playerInScope) return this.#routeMeeting(body, meeting, ctx);

    const living = ctx.crew.filter((a) => a.status === 'alive');
    const deliveries = living.map((a): Delivery => {
      if (!a.seated) return { agentId: a.agentId, mode: 'wake', reason: 'broadcast' };
      if (loud) return { agentId: a.agentId, mode: 'wake', reason: 'loud' };
      if (namesAgent(body, a)) return { agentId: a.agentId, mode: 'wake', reason: 'named' };
      return { agentId: a.agentId, mode: 'context', reason: 'seated' };
    });
    const scope = loud ? 'all!' : 'all';
    const tail = living.length === 0 ? ' (nobody is around to hear it)' : cardsNote(living, ctx);
    return this.#ok('broadcast', loud, body, deliveries, { echo: `You → ${scope}: ${clip(body)}${tail}` });
  }

  #routeMeetingExplicit(body: string, ctx: ChatContext): RouteResult {
    const meeting = ctx.meeting;
    if (!meeting) return fail('no_meeting', 'No meeting is running');
    if (body.trim().toLowerCase() === 'end') {
      return this.#ok('meeting', false, body, [], { echo: 'You → meeting: end', command: 'meeting.end' });
    }
    if (body.length === 0) return fail('empty', 'Say something after @meeting');
    return this.#routeMeeting(body, meeting, ctx);
  }

  #routeMeeting(body: string, meeting: MeetingScope, ctx: ChatContext): RouteResult {
    const present = new Set(meeting.attendees);
    const living = ctx.crew.filter((a) => a.status === 'alive');
    const deliveries = living.map(
      (a): Delivery =>
        present.has(a.agentId)
          ? { agentId: a.agentId, mode: 'meeting', reason: 'meeting' }
          : { agentId: a.agentId, mode: 'context', reason: 'meeting_absent' },
    );
    const count = deliveries.filter((d) => d.mode === 'meeting').length;
    return this.#ok('meeting', false, body, deliveries, { echo: `You → meeting (${count}): ${clip(body)}` });
  }

  #ok(
    scope: RouteScope,
    loud: boolean,
    body: string,
    deliveries: readonly Delivery[],
    extra: { echo: string; answer?: CardAnswer; command?: 'meeting.end' },
  ): RouteOk {
    return {
      ok: true,
      scope,
      loud,
      body,
      deliveries,
      answer: extra.answer ?? null,
      command: extra.command ?? null,
      echo: extra.echo,
    };
  }
}

// ---------------------------------------------------------------------------------------------
// Debounce and stale broadcast handling
// ---------------------------------------------------------------------------------------------

/** Player messages to one agent within this window merge into one wake. */
export const PLAYER_DEBOUNCE_MS = 2_000;
/** A queued wake made only of broadcasts becomes context once it is older than this. */
export const STALE_BROADCAST_MS = 120_000;

/** One agent's merged player input, ready for the EventRouter. */
export interface MergedPlayerInput {
  readonly agentId: string;
  /** `wake` if any part should wake the agent, else `context`. */
  readonly mode: 'wake' | 'context';
  readonly texts: readonly string[];
  /** At least one part addressed this agent directly (mention, @all!, named). */
  readonly direct: boolean;
  readonly firstAt: number;
  readonly lastAt: number;
}

interface Bucket {
  texts: string[];
  wake: boolean;
  direct: boolean;
  firstAt: number;
  lastAt: number;
}

const DIRECT_REASONS: ReadonlySet<DeliveryReason> = new Set(['mention', 'loud', 'named', 'card_message']);

/**
 * Debounces player messages per agent (PLAN §6.5): messages within {@link PLAYER_DEBOUNCE_MS} of each other
 * merge into one wake. Pure apart from its buffer: callers pass the clock.
 */
export class ChatInbox {
  readonly #buckets = new Map<string, Bucket>();
  readonly #debounceMs: number;

  constructor(debounceMs = PLAYER_DEBOUNCE_MS) {
    this.#debounceMs = debounceMs;
  }

  /** Buffers the wake/context deliveries of a routed message (meeting deliveries are not buffered). */
  push(deliveries: readonly Delivery[], text: string, at: number): void {
    for (const d of deliveries) {
      if (d.mode === 'meeting') continue;
      let b = this.#buckets.get(d.agentId);
      if (!b) {
        b = { texts: [], wake: false, direct: false, firstAt: at, lastAt: at };
        this.#buckets.set(d.agentId, b);
      }
      b.texts.push(text);
      b.wake ||= d.mode === 'wake';
      b.direct ||= DIRECT_REASONS.has(d.reason);
      b.lastAt = Math.max(b.lastAt, at);
    }
  }

  /** Releases every agent whose last message is at least the debounce window old. */
  flush(now: number): MergedPlayerInput[] {
    const out: MergedPlayerInput[] = [];
    for (const [agentId, b] of this.#buckets) {
      if (now - b.lastAt < this.#debounceMs) continue;
      this.#buckets.delete(agentId);
      out.push({
        agentId,
        mode: b.wake ? 'wake' : 'context',
        texts: b.texts,
        direct: b.direct,
        firstAt: b.firstAt,
        lastAt: b.lastAt,
      });
    }
    return out;
  }

  /** When the next agent becomes ready, or null if nothing is buffered. */
  nextFlushAt(): number | null {
    let next: number | null = null;
    for (const b of this.#buckets.values()) {
      const at = b.lastAt + this.#debounceMs;
      if (next === null || at < next) next = at;
    }
    return next;
  }

  get size(): number {
    return this.#buckets.size;
  }
}

/**
 * A queued wake that only carries broadcasts and has waited longer than {@link STALE_BROADCAST_MS}
 * (e.g. behind a busy brain slot) is downgraded to context: the moment has passed.
 */
export function demoteStale(
  input: MergedPlayerInput,
  now: number,
  maxAgeMs = STALE_BROADCAST_MS,
): MergedPlayerInput {
  if (input.mode !== 'wake' || input.direct) return input;
  return now - input.firstAt > maxAgeMs ? { ...input, mode: 'context' } : input;
}
