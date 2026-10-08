import { describe, expect, it } from 'vitest';
import type {
  CardQuestion,
  PendingCard,
  PlanCard,
  QuestionCard,
} from '../../src/agents/chat/answerGrammar.js';
import {
  type ChatAgent,
  type ChatContext,
  ChatInbox,
  ChatRouter,
  type Delivery,
  demoteStale,
  type MeetingScope,
  namesAgent,
  PLAYER_DEBOUNCE_MS,
  parseLeadingMentions,
  type RouteOk,
  type RouteResult,
  STALE_BROADCAST_MS,
} from '../../src/agents/chat/ChatRouter.js';

function agent(handle: string, extra: Partial<ChatAgent> = {}): ChatAgent {
  return {
    agentId: handle,
    handle,
    name: handle.charAt(0).toUpperCase() + handle.slice(1),
    status: 'alive',
    ceo: false,
    seated: false,
    ...extra,
  };
}

const wood: CardQuestion = {
  question: 'Which wood?',
  options: [{ label: 'Oak' }, { label: 'Spruce' }, { label: 'Birch' }],
  multiSelect: false,
};
const extras: CardQuestion = {
  question: 'Which extras?',
  options: [{ label: 'Oak' }, { label: 'Torches' }, { label: 'Birch' }],
  multiSelect: true,
};

function questionCard(
  agentId: string,
  questions: CardQuestion[],
  extra: Partial<QuestionCard> = {},
): QuestionCard {
  return { kind: 'question', id: `q-${agentId}`, agentId, createdAt: 1, questions, answers: [], ...extra };
}
function planCard(agentId: string): PlanCard {
  return { kind: 'plan', id: `p-${agentId}`, agentId, createdAt: 2, plan: 'do things' };
}

const crew: ChatAgent[] = [
  agent('ada', { ceo: true }),
  agent('abe'),
  agent('bram', { seated: true }),
  agent('cleo', { status: 'dead', diedDay: 4 }),
  agent('dax', { status: 'dismissed' }),
];

function ctx(extra: Partial<ChatContext> = {}): ChatContext {
  return { playerName: 'Jasper', crew, cards: new Map(), meeting: null, ...extra };
}

const router = new ChatRouter();

function ok(result: RouteResult): RouteOk {
  if (!result.ok) throw new Error(`expected ok, got ${result.error.code}: ${result.error.hint}`);
  return result;
}

function err(result: RouteResult) {
  if (result.ok) throw new Error(`expected an error, got echo "${result.echo}"`);
  return result.error;
}

function byAgent(deliveries: readonly Delivery[]): Record<string, string> {
  return Object.fromEntries(deliveries.map((d) => [d.agentId, `${d.mode}:${d.reason}`]));
}

describe('parseLeadingMentions', () => {
  it('splits leading mentions from the body', () => {
    expect(parseLeadingMentions('@ada @Bram  go mine')).toEqual({
      ok: true,
      mentions: [
        { raw: '@ada', name: 'ada', bang: false },
        { raw: '@Bram', name: 'bram', bang: false },
      ],
      body: 'go mine',
    });
  });

  it('accepts punctuation after a mention when followed by whitespace', () => {
    const r = parseLeadingMentions('@ada, @bram: come here');
    expect(r.ok && r.mentions.map((m) => m.name)).toEqual(['ada', 'bram']);
    expect(r.ok && r.body).toBe('come here');
  });

  it('marks @all! as loud', () => {
    const r = parseLeadingMentions('@all! wake up');
    expect(r.ok && r.mentions[0]).toEqual({ raw: '@all!', name: 'all', bang: true });
  });

  it('only leading mentions count; later ones are references', () => {
    const r = parseLeadingMentions('@ada tell @bram about the cave');
    expect(r.ok && r.mentions.map((m) => m.name)).toEqual(['ada']);
    expect(r.ok && r.body).toBe('tell @bram about the cave');
  });

  it('text without a leading @ has no mentions (emails are not mentions)', () => {
    expect(parseLeadingMentions('mail me at x@y.com')).toEqual({
      ok: true,
      mentions: [],
      body: 'mail me at x@y.com',
    });
  });

  it('@ followed by a non-letter is plain text', () => {
    expect(parseLeadingMentions('@ 5 zombies')).toEqual({ ok: true, mentions: [], body: '@ 5 zombies' });
    expect(parseLeadingMentions('@123 go')).toEqual({ ok: true, mentions: [], body: '@123 go' });
  });

  it('a mention glued to more text is malformed', () => {
    expect(parseLeadingMentions('@ada,@bram hi')).toEqual({ ok: false, token: '@ada,@bram' });
    expect(parseLeadingMentions("@ada's cave")).toEqual({ ok: false, token: "@ada's" });
  });

  it('leading whitespace is ignored and a bare mention has an empty body', () => {
    expect(parseLeadingMentions('   @ada')).toEqual({
      ok: true,
      mentions: [{ raw: '@ada', name: 'ada', bang: false }],
      body: '',
    });
  });
});

describe('ChatRouter: mentions', () => {
  it('routes to exactly the named agent and wakes it; the CEO is not copied', () => {
    const r = ok(router.route({ to: 'all', text: '@abe fetch logs' }, ctx()));
    expect(r.scope).toBe('direct');
    expect(r.deliveries).toEqual([{ agentId: 'abe', mode: 'wake', reason: 'mention' }]);
    expect(r.echo).toBe('You → Abe: fetch logs');
    expect(r.answer).toBeNull();
  });

  it('several mentions reach several agents', () => {
    const r = ok(router.route({ to: 'all', text: '@abe @bram regroup' }, ctx()));
    expect(byAgent(r.deliveries)).toEqual({ abe: 'wake:mention', bram: 'wake:mention' });
    expect(r.echo).toBe('You → Abe, Bram: regroup');
  });

  it('a seated agent named directly wakes', () => {
    const r = ok(router.route({ to: 'all', text: '@bram status?' }, ctx()));
    expect(r.deliveries).toEqual([{ agentId: 'bram', mode: 'wake', reason: 'mention' }]);
  });

  it('duplicate mentions collapse', () => {
    const r = ok(router.route({ to: 'all', text: '@ada @ceo @ad hi' }, ctx()));
    expect(r.deliveries).toEqual([{ agentId: 'ada', mode: 'wake', reason: 'mention' }]);
  });

  it('@ceo aliases the current CEO', () => {
    const r = ok(router.route({ to: 'all', text: '@ceo hire a farmer' }, ctx()));
    expect(r.deliveries.map((d) => d.agentId)).toEqual(['ada']);
  });

  it('prefix of 2+ characters resolves when unique', () => {
    expect(ok(router.route({ to: 'all', text: '@br go' }, ctx())).deliveries[0]?.agentId).toBe('bram');
  });

  it('ambiguous prefix: error with candidates, nothing sent', () => {
    const e = err(router.route({ to: 'all', text: '@a hi' }, ctx()));
    expect(e.code).toBe('too_short');
    expect(e.hint).toBe('@a matches @all, Ada, Abe: type at least 2 letters');
    expect(e.wireCode).toBe('CHAT_AMBIGUOUS');
  });

  it('ambiguous 2-letter prefix: "@ab" is unique but "@a" is not', () => {
    expect(ok(router.route({ to: 'all', text: '@ab hi' }, ctx())).deliveries[0]?.agentId).toBe('abe');
    const amb = [agent('ada'), agent('adrian')];
    const e = err(router.route({ to: 'all', text: '@ad hi' }, ctx({ crew: amb })));
    expect(e).toMatchObject({
      code: 'ambiguous',
      hint: '@ad matches Ada, Adrian',
      wireCode: 'CHAT_AMBIGUOUS',
    });
  });

  it('unknown name: error listing the crew', () => {
    const e = err(router.route({ to: 'all', text: '@zed hi' }, ctx()));
    expect(e).toMatchObject({ code: 'unknown', wireCode: 'CHAT_UNKNOWN' });
    expect(e.hint).toBe('Nobody is called @zed. Crew: @ada, @abe, @bram');
  });

  it('dead name: error, never broadcast as a fallback', () => {
    const e = err(router.route({ to: 'all', text: '@cleo are you there' }, ctx()));
    expect(e).toEqual({ code: 'unavailable', hint: 'Cleo died on Day 4', wireCode: 'CHAT_UNAVAILABLE' });
  });

  it('dismissed name: error', () => {
    expect(err(router.route({ to: 'all', text: '@dax hi' }, ctx())).hint).toBe('Dax was dismissed');
  });

  it('one bad mention among good ones rejects the whole line', () => {
    expect(err(router.route({ to: 'all', text: '@abe @zed hi' }, ctx())).code).toBe('unknown');
  });

  it('@ceo without a CEO', () => {
    const noCeo = [agent('abe')];
    expect(err(router.route({ to: 'all', text: '@ceo hi' }, ctx({ crew: noCeo }))).code).toBe('no_ceo');
  });

  it('a mention with no text is refused', () => {
    expect(err(router.route({ to: 'all', text: '@ada' }, ctx()))).toMatchObject({
      code: 'empty',
      hint: 'Say something after @ada',
    });
    expect(err(router.route({ to: 'all', text: '@ada,' }, ctx())).hint).toBe('Say something after @ada');
  });

  it('malformed leading mention is refused rather than broadcast', () => {
    expect(err(router.route({ to: 'all', text: '@ada,@bram hi' }, ctx()))).toMatchObject({
      code: 'malformed',
      wireCode: 'CHAT_REJECTED',
    });
  });

  it('mentions later in the text are references only', () => {
    const r = ok(router.route({ to: 'all', text: '@abe tell @bram the cave is at 100 64 -20' }, ctx()));
    expect(r.deliveries.map((d) => d.agentId)).toEqual(['abe']);
  });
});

describe('ChatRouter: broadcasts', () => {
  it('no mention reaches every living agent: wandering wake, seated get context', () => {
    const r = ok(router.route({ to: 'all', text: 'night is coming, head inside' }, ctx()));
    expect(r.scope).toBe('broadcast');
    expect(byAgent(r.deliveries)).toEqual({
      ada: 'wake:broadcast',
      abe: 'wake:broadcast',
      bram: 'context:seated',
    });
    expect(r.echo).toBe('You → all: night is coming, head inside');
  });

  it('a seated agent named in a broadcast wakes', () => {
    const r = ok(router.route({ to: 'all', text: 'everyone inside, Bram too' }, ctx()));
    expect(byAgent(r.deliveries).bram).toBe('wake:named');
  });

  it('@all! wakes seated agents too', () => {
    const r = ok(router.route({ to: 'all', text: '@all! creeper in the office' }, ctx()));
    expect(r.loud).toBe(true);
    expect(byAgent(r.deliveries)).toEqual({
      ada: 'wake:broadcast',
      abe: 'wake:broadcast',
      bram: 'wake:loud',
    });
    expect(r.echo).toBe('You → all!: creeper in the office');
  });

  it('@all and @everyone without ! keep seated agents on context', () => {
    expect(byAgent(ok(router.route({ to: 'all', text: '@all lunch' }, ctx())).deliveries).bram).toBe(
      'context:seated',
    );
    expect(byAgent(ok(router.route({ to: 'all', text: '@everyone lunch' }, ctx())).deliveries).bram).toBe(
      'context:seated',
    );
  });

  it('@all cannot be combined with names', () => {
    expect(err(router.route({ to: 'all', text: '@all @ada hi' }, ctx()))).toMatchObject({
      code: 'mixed',
      wireCode: 'CHAT_REJECTED',
    });
  });

  it('broadcasts never answer cards and say so', () => {
    const cards = new Map<string, PendingCard[]>([
      ['ada', [questionCard('ada', [wood])]],
      ['abe', [planCard('abe')]],
    ]);
    const r = ok(router.route({ to: 'all', text: '2' }, ctx({ cards })));
    expect(r.answer).toBeNull();
    expect(r.echo).toBe('You → all: 2 (not an answer: 2 cards pending, use @ada/@abe or G)');
  });

  it('one pending card is reported in the singular', () => {
    const cards = new Map<string, PendingCard[]>([['ada', [questionCard('ada', [wood])]]]);
    expect(ok(router.route({ to: 'all', text: 'hi' }, ctx({ cards }))).echo).toBe(
      'You → all: hi (not an answer: 1 card pending, use @ada or G)',
    );
  });

  it('works with nobody alive', () => {
    const r = ok(
      router.route({ to: 'all', text: 'hello?' }, ctx({ crew: [agent('cleo', { status: 'dead' })] })),
    );
    expect(r.deliveries).toEqual([]);
    expect(r.echo).toBe('You → all: hello? (nobody is around to hear it)');
  });

  it('empty and oversized lines are refused', () => {
    expect(err(router.route({ to: 'all', text: '   ' }, ctx())).code).toBe('empty');
    expect(err(router.route({ to: 'all', text: 'x'.repeat(2001) }, ctx())).code).toBe('too_long');
    expect(ok(router.route({ to: 'all', text: 'x'.repeat(2000) }, ctx())).scope).toBe('broadcast');
  });
});

describe('ChatRouter: answers', () => {
  it('a single-agent message answers its front card', () => {
    const cards = new Map<string, PendingCard[]>([['ada', [questionCard('ada', [wood])]]]);
    const r = ok(router.route({ to: 'all', text: '@ada 2' }, ctx({ cards })));
    expect(r.answer).toMatchObject({
      kind: 'question.answer',
      agentId: 'ada',
      cardId: 'q-ada',
      value: 'Spruce',
      answers: { 'Which wood?': 'Spruce' },
    });
    expect(r.deliveries).toEqual([]);
    expect(r.echo).toBe('You → Ada: Q1 = 2 (Spruce)');
  });

  it('multi-select by numbers', () => {
    const cards = new Map<string, PendingCard[]>([['ada', [questionCard('ada', [extras])]]]);
    const r = ok(router.route({ to: 'all', text: '@ada 1,3' }, ctx({ cards })));
    expect(r.answer).toMatchObject({ value: 'Oak, Birch' });
    expect(r.echo).toBe('You → Ada: Q1 = 1,3 (Oak, Birch)');
  });

  it('by label via @ceo', () => {
    const cards = new Map<string, PendingCard[]>([['ada', [questionCard('ada', [wood])]]]);
    expect(ok(router.route({ to: 'all', text: '@ceo oak' }, ctx({ cards }))).answer).toMatchObject({
      value: 'Oak',
    });
  });

  it('invalid answers are rejected inline and nothing is sent', () => {
    const cards = new Map<string, PendingCard[]>([['ada', [questionCard('ada', [wood])]]]);
    expect(err(router.route({ to: 'all', text: '@ada 1,3' }, ctx({ cards })))).toMatchObject({
      code: 'invalid_answer',
      wireCode: 'CHAT_INVALID_ANSWER',
      hint: expect.stringContaining('takes one answer'),
    });
    expect(err(router.route({ to: 'all', text: '@ada 7' }, ctx({ cards }))).hint).toBe(
      'Q1 has options 1-3; 7 is not one of them',
    );
  });

  it('a question to an agent with a pending plan is delivered, not a Revise', () => {
    const cards = new Map<string, PendingCard[]>([['ada', [planCard('ada')]]]);
    const r = ok(router.route({ to: 'all', text: '@ada why step 2?' }, ctx({ cards })));
    expect(r.answer).toBeNull();
    expect(r.deliveries).toEqual([{ agentId: 'ada', mode: 'wake', reason: 'card_message' }]);
    expect(r.echo).toContain('(question; the plan is still waiting');
  });

  it('plan approve and revise', () => {
    const cards = new Map<string, PendingCard[]>([['ada', [planCard('ada')]]]);
    expect(ok(router.route({ to: 'all', text: '@ada approve' }, ctx({ cards }))).answer).toEqual({
      kind: 'plan.approve',
      cardId: 'p-ada',
      agentId: 'ada',
    });
    expect(ok(router.route({ to: 'all', text: '@ada use tabs' }, ctx({ cards }))).answer).toMatchObject({
      kind: 'plan.revise',
      feedback: 'use tabs',
    });
  });

  it('hire cards via @ceo yes / no <note>', () => {
    const cards = new Map<string, PendingCard[]>([
      ['ada', [{ kind: 'hire', id: 'h-1', agentId: 'ada', createdAt: 1, role: 'farmer', name: 'Fenna' }]],
    ]);
    expect(ok(router.route({ to: 'all', text: '@ceo yes' }, ctx({ cards }))).answer?.kind).toBe(
      'hire.approve',
    );
    expect(ok(router.route({ to: 'all', text: '@ceo no not yet' }, ctx({ cards }))).answer).toMatchObject({
      kind: 'hire.decline',
      note: 'not yet',
    });
  });

  it('the front card (blocking before hire) is the one answered', () => {
    const cards = new Map<string, PendingCard[]>([
      [
        'ada',
        [
          { kind: 'hire', id: 'h-1', agentId: 'ada', createdAt: 0, role: 'farmer', name: 'Fenna' },
          questionCard('ada', [wood], { createdAt: 5 }),
        ],
      ],
    ]);
    expect(ok(router.route({ to: 'all', text: '@ada yes' }, ctx({ cards }))).answer).toMatchObject({
      kind: 'question.answer',
      value: 'yes',
      freeText: true,
    });
  });

  it('a message to several agents never answers a card', () => {
    const cards = new Map<string, PendingCard[]>([['ada', [questionCard('ada', [wood])]]]);
    const r = ok(router.route({ to: 'all', text: '@ada @abe 2' }, ctx({ cards })));
    expect(r.answer).toBeNull();
    expect(byAgent(r.deliveries)).toEqual({ ada: 'wake:mention', abe: 'wake:mention' });
    expect(r.echo).toBe('You → Ada, Abe: 2 (not an answer: 1 card pending, use @ada or G)');
  });

  it('later parks the card', () => {
    const cards = new Map<string, PendingCard[]>([['ada', [planCard('ada')]]]);
    expect(ok(router.route({ to: 'all', text: '@ada later' }, ctx({ cards }))).answer).toMatchObject({
      kind: 'later',
      agentId: 'ada',
    });
  });

  it('no card: a normal message', () => {
    const r = ok(router.route({ to: 'all', text: '@ada 2' }, ctx()));
    expect(r.answer).toBeNull();
    expect(r.echo).toBe('You → Ada: 2');
  });
});

describe('ChatRouter: explicit recipients (AgentScreen)', () => {
  it('delivers to the given ids without parsing mentions', () => {
    const r = ok(router.route({ to: ['abe'], text: '@bram is slacking' }, ctx()));
    expect(r.deliveries).toEqual([{ agentId: 'abe', mode: 'wake', reason: 'mention' }]);
    expect(r.body).toBe('@bram is slacking');
  });

  it('answers the front card of a single explicit recipient', () => {
    const cards = new Map<string, PendingCard[]>([['ada', [questionCard('ada', [wood])]]]);
    expect(ok(router.route({ to: ['ada'], text: '3' }, ctx({ cards }))).answer).toMatchObject({
      value: 'Birch',
    });
  });

  it('rejects unknown and dead ids', () => {
    expect(err(router.route({ to: ['nobody'], text: 'hi' }, ctx())).code).toBe('unknown');
    expect(err(router.route({ to: ['cleo'], text: 'hi' }, ctx())).code).toBe('unavailable');
  });
});

describe('ChatRouter: meetings', () => {
  const meeting: MeetingScope = {
    meetingId: 'm-1',
    attendees: ['ada', 'bram'],
    chairId: 'ada',
    playerInScope: true,
  };

  it('unmentioned lines go to the meeting when the player is in scope', () => {
    const r = ok(router.route({ to: 'all', text: 'what about the farm' }, ctx({ meeting })));
    expect(r.scope).toBe('meeting');
    expect(byAgent(r.deliveries)).toEqual({
      ada: 'meeting:meeting',
      abe: 'context:meeting_absent',
      bram: 'meeting:meeting',
    });
    expect(r.echo).toBe('You → meeting (2): what about the farm');
  });

  it('out of scope (player far away), unmentioned lines are ordinary broadcasts', () => {
    const r = ok(
      router.route({ to: 'all', text: 'hi' }, ctx({ meeting: { ...meeting, playerInScope: false } })),
    );
    expect(r.scope).toBe('broadcast');
  });

  it('direct mentions still route normally during a meeting', () => {
    const r = ok(router.route({ to: 'all', text: '@abe bring torches' }, ctx({ meeting })));
    expect(r.scope).toBe('direct');
    expect(r.deliveries).toEqual([{ agentId: 'abe', mode: 'wake', reason: 'mention' }]);
  });

  it('@all bypasses the meeting scope', () => {
    expect(ok(router.route({ to: 'all', text: '@all hi' }, ctx({ meeting }))).scope).toBe('broadcast');
  });

  it('@meeting addresses the meeting even out of scope', () => {
    const r = ok(
      router.route(
        { to: 'all', text: '@meeting next item' },
        ctx({ meeting: { ...meeting, playerInScope: false } }),
      ),
    );
    expect(r.scope).toBe('meeting');
  });

  it('exactly "@meeting end" ends it', () => {
    const r = ok(router.route({ to: 'all', text: '@meeting end' }, ctx({ meeting })));
    expect(r.command).toBe('meeting.end');
    expect(r.deliveries).toEqual([]);
    expect(ok(router.route({ to: 'all', text: '@meeting end it now' }, ctx({ meeting }))).command).toBeNull();
  });

  it('@meeting without a meeting', () => {
    expect(err(router.route({ to: 'all', text: '@meeting end' }, ctx())).code).toBe('no_meeting');
  });

  it('@meeting cannot be combined with names', () => {
    expect(err(router.route({ to: 'all', text: '@meeting @ada hi' }, ctx({ meeting }))).code).toBe('mixed');
  });
});

describe('namesAgent', () => {
  const bram = { handle: 'bram', name: 'Bram' };
  it('matches whole words, handle or name, any case', () => {
    expect(namesAgent('BRAM come here', bram)).toBe(true);
    expect(namesAgent('thanks @bram!', bram)).toBe(true);
    expect(namesAgent('brambles everywhere', bram)).toBe(false);
    expect(namesAgent('abram', bram)).toBe(false);
  });

  it('escapes regex characters in names', () => {
    expect(namesAgent('hi a.b', { handle: 'ab', name: 'A.B' })).toBe(true);
    expect(namesAgent('hi axb', { handle: 'zz', name: 'A.B' })).toBe(false);
  });
});

describe('ChatInbox (2 s debounce, merge per agent)', () => {
  const wake = (agentId: string, reason: Delivery['reason'] = 'broadcast'): Delivery => ({
    agentId,
    mode: 'wake',
    reason,
  });
  const context = (agentId: string): Delivery => ({ agentId, mode: 'context', reason: 'seated' });

  it('holds messages until 2 s after the last one, then merges them', () => {
    const inbox = new ChatInbox();
    inbox.push([wake('ada', 'mention')], 'first', 0);
    inbox.push([wake('ada')], 'second', 1500);
    expect(inbox.flush(3000)).toEqual([]);
    expect(inbox.nextFlushAt()).toBe(1500 + PLAYER_DEBOUNCE_MS);
    expect(inbox.flush(3500)).toEqual([
      { agentId: 'ada', mode: 'wake', texts: ['first', 'second'], direct: true, firstAt: 0, lastAt: 1500 },
    ]);
    expect(inbox.size).toBe(0);
    expect(inbox.nextFlushAt()).toBeNull();
  });

  it('context plus wake merges into one wake', () => {
    const inbox = new ChatInbox();
    inbox.push([context('bram')], 'a', 0);
    inbox.push([wake('bram', 'named')], 'b', 100);
    expect(inbox.flush(5000)).toMatchObject([{ agentId: 'bram', mode: 'wake', direct: true }]);
  });

  it('context-only stays context', () => {
    const inbox = new ChatInbox();
    inbox.push([context('bram')], 'a', 0);
    expect(inbox.flush(2000)).toMatchObject([{ agentId: 'bram', mode: 'context', direct: false }]);
  });

  it('agents flush independently', () => {
    const inbox = new ChatInbox();
    inbox.push([wake('ada'), wake('abe')], 'x', 0);
    inbox.push([wake('abe')], 'y', 1900);
    expect(inbox.flush(2000).map((m) => m.agentId)).toEqual(['ada']);
    expect(inbox.flush(3900).map((m) => m.agentId)).toEqual(['abe']);
  });

  it('meeting deliveries are not buffered', () => {
    const inbox = new ChatInbox();
    inbox.push([{ agentId: 'ada', mode: 'meeting', reason: 'meeting' }], 'x', 0);
    expect(inbox.size).toBe(0);
  });
});

describe('demoteStale (queued broadcast wakes older than 2 min become context)', () => {
  const base = { agentId: 'ada', texts: ['x'], firstAt: 0, lastAt: 0 } as const;

  it('demotes old broadcast-only wakes', () => {
    expect(demoteStale({ ...base, mode: 'wake', direct: false }, STALE_BROADCAST_MS + 1).mode).toBe(
      'context',
    );
  });

  it('keeps fresh broadcast wakes', () => {
    expect(demoteStale({ ...base, mode: 'wake', direct: false }, STALE_BROADCAST_MS).mode).toBe('wake');
  });

  it('never demotes direct messages', () => {
    expect(demoteStale({ ...base, mode: 'wake', direct: true }, 10 * STALE_BROADCAST_MS).mode).toBe('wake');
  });
});
