import { describe, expect, it } from 'vitest';
import {
  chatCompletions,
  foldName,
  type HandleTarget,
  handleFromName,
  isValidHandleSyntax,
  RESERVED_WORDS,
  resolveHandle,
  validateHandle,
} from '../../src/agents/chat/handles.js';

function agent(handle: string, extra: Partial<HandleTarget> = {}): HandleTarget {
  return {
    agentId: `id-${handle}`,
    handle,
    name: handle.charAt(0).toUpperCase() + handle.slice(1),
    status: 'alive',
    ceo: false,
    ...extra,
  };
}

describe('handle syntax', () => {
  it.each(['ada', 'bram', 'r2', 'abcdefghijkl', 'x9'])('accepts %s', (h) => {
    expect(isValidHandleSyntax(h)).toBe(true);
  });

  it.each(['a', 'Ada', '2bob', 'abcdefghijklm', 'ad_a', 'ad-a', '', 'zoë'])('rejects %j', (h) => {
    expect(isValidHandleSyntax(h)).toBe(false);
  });
});

describe('handleFromName', () => {
  it('folds display names', () => {
    expect(handleFromName('Ada')).toBe('ada');
    expect(handleFromName('Zoë-Ann')).toBe('zoeann');
    expect(handleFromName('R2-D2')).toBe('r2d2');
    expect(handleFromName('42 Bram')).toBe('bram');
    expect(handleFromName('Maximiliana Long')).toBe('maximilianal');
  });

  it('returns null when nothing usable remains', () => {
    expect(handleFromName('A')).toBeNull();
    expect(handleFromName('123')).toBeNull();
    expect(handleFromName('---')).toBeNull();
  });

  it('foldName strips accents and symbols', () => {
    expect(foldName('Jasper_Aelvoet')).toBe('jasperaelvoet');
    expect(foldName('Ångström')).toBe('angstrom');
  });
});

describe('validateHandle (enforced at hire)', () => {
  const rules = { taken: ['ada', 'bram'], playerName: 'Jasper' };

  it('accepts a distinct handle', () => {
    expect(validateHandle('cleo', rules)).toBeNull();
  });

  it('rejects bad syntax', () => {
    expect(validateHandle('Cleo', rules)?.code).toBe('syntax');
  });

  it('rejects an exact duplicate', () => {
    expect(validateHandle('ada', rules)).toMatchObject({ code: 'taken', other: 'ada' });
  });

  it('rejects a handle that is a prefix of another handle', () => {
    expect(validateHandle('br', rules)).toMatchObject({ code: 'prefix', other: 'bram' });
  });

  it('rejects a handle that another handle is a prefix of', () => {
    expect(validateHandle('adam', rules)).toMatchObject({ code: 'prefix', other: 'ada' });
  });

  it.each(RESERVED_WORDS)('rejects the reserved word %s', (word) => {
    expect(validateHandle(word, { taken: [] })).toMatchObject({ code: 'reserved', word });
  });

  it('rejects prefixes of reserved words', () => {
    expect(validateHandle('al', { taken: [] })).toMatchObject({ code: 'reserved', word: 'all' });
    expect(validateHandle('ce', { taken: [] })).toMatchObject({ code: 'reserved', word: 'ceo' });
    expect(validateHandle('every', { taken: [] })).toMatchObject({ code: 'reserved', word: 'everyone' });
    expect(validateHandle('meet', { taken: [] })).toMatchObject({ code: 'reserved', word: 'meeting' });
  });

  it('rejects handles that start with a reserved word (so @all is never an agent)', () => {
    expect(validateHandle('allie', { taken: [] })).toMatchObject({ code: 'reserved', word: 'all' });
    expect(validateHandle('ceora', { taken: [] })).toMatchObject({ code: 'reserved', word: 'ceo' });
  });

  it('allows names that merely share letters with reserved words', () => {
    expect(validateHandle('alba', { taken: [] })).toBeNull();
    expect(validateHandle('cedric', { taken: [] })).toBeNull();
  });

  it("rejects prefixes of the player's name, and the name itself", () => {
    expect(validateHandle('jas', rules)?.code).toBe('player');
    expect(validateHandle('jasper', rules)?.code).toBe('player');
    expect(validateHandle('jasperbot', rules)?.code).toBe('player');
    expect(validateHandle('jade', rules)).toBeNull();
  });

  it('folds the player name before comparing', () => {
    expect(validateHandle('steve', { taken: [], playerName: 'Steve_99' })?.code).toBe('player');
  });

  it('counts dead agents of the world as taken', () => {
    expect(validateHandle('ada', { taken: ['ada'] })?.code).toBe('taken');
  });
});

describe('resolveHandle', () => {
  const roster: HandleTarget[] = [
    agent('ada', { ceo: true }),
    agent('abe'),
    agent('bram'),
    agent('cleo', { status: 'dead', diedDay: 4 }),
    agent('dax', { status: 'dismissed' }),
    agent('cedric'),
  ];

  it('resolves an exact handle', () => {
    expect(resolveHandle('bram', roster)).toMatchObject({
      kind: 'agent',
      via: 'exact',
      agent: { handle: 'bram' },
    });
  });

  it('is case-insensitive', () => {
    expect(resolveHandle('BRAM', roster)).toMatchObject({ kind: 'agent', agent: { handle: 'bram' } });
  });

  it('resolves a unique prefix of 2+ characters', () => {
    expect(resolveHandle('br', roster)).toMatchObject({
      kind: 'agent',
      via: 'prefix',
      agent: { handle: 'bram' },
    });
    expect(resolveHandle('ad', roster)).toMatchObject({ kind: 'agent', agent: { handle: 'ada' } });
  });

  it('refuses a 1-character prefix even when unique', () => {
    expect(resolveHandle('b', roster)).toEqual({ kind: 'too_short', candidates: ['Bram'] });
  });

  it('reports ambiguous 1-character prefixes with candidates', () => {
    expect(resolveHandle('a', roster)).toMatchObject({
      kind: 'too_short',
      candidates: ['@all', 'Ada', 'Abe'],
    });
  });

  it('reports an ambiguous prefix, including reserved words', () => {
    expect(resolveHandle('ce', roster)).toEqual({ kind: 'ambiguous', candidates: ['@ceo', 'Cedric'] });
  });

  it('exact match beats prefix (exact handle that prefixes nothing else)', () => {
    const r = [agent('ada'), agent('adelheid')];
    expect(resolveHandle('ada', r)).toMatchObject({ kind: 'agent', via: 'exact', agent: { handle: 'ada' } });
    expect(resolveHandle('ad', r)).toMatchObject({ kind: 'ambiguous' });
  });

  it('@ceo resolves to the current living CEO', () => {
    expect(resolveHandle('ceo', roster)).toMatchObject({
      kind: 'agent',
      via: 'ceo',
      agent: { handle: 'ada' },
    });
  });

  it('@ceo with no living CEO', () => {
    expect(resolveHandle('ceo', [agent('bram'), agent('ada', { ceo: true, status: 'dead' })])).toEqual({
      kind: 'no_ceo',
    });
  });

  it('a unique prefix of ceo resolves to the CEO alias', () => {
    expect(resolveHandle('ce', [agent('ada', { ceo: true })])).toMatchObject({
      kind: 'agent',
      via: 'ceo',
      agent: { handle: 'ada' },
    });
  });

  it('reserved words resolve as reserved', () => {
    expect(resolveHandle('all', roster)).toEqual({ kind: 'reserved', word: 'all' });
    expect(resolveHandle('everyone', roster)).toEqual({ kind: 'reserved', word: 'everyone' });
    expect(resolveHandle('meeting', roster)).toEqual({ kind: 'reserved', word: 'meeting' });
    expect(resolveHandle('ev', roster)).toEqual({ kind: 'reserved', word: 'everyone' });
  });

  it('dead and dismissed agents are unavailable, by exact or prefix', () => {
    expect(resolveHandle('cleo', roster)).toMatchObject({ kind: 'unavailable', agent: { handle: 'cleo' } });
    expect(resolveHandle('cl', roster)).toMatchObject({ kind: 'unavailable', agent: { handle: 'cleo' } });
    expect(resolveHandle('dax', roster)).toMatchObject({
      kind: 'unavailable',
      agent: { status: 'dismissed' },
    });
  });

  it('labels dead candidates in ambiguity hints', () => {
    const r = [agent('cleo', { status: 'dead' }), agent('clara')];
    expect(resolveHandle('cl', r)).toEqual({ kind: 'ambiguous', candidates: ['Cleo (dead)', 'Clara'] });
  });

  it('unknown names', () => {
    expect(resolveHandle('zed', roster)).toEqual({ kind: 'unknown' });
    expect(resolveHandle('z', roster)).toEqual({ kind: 'unknown' });
    expect(resolveHandle('bramble', roster)).toEqual({ kind: 'unknown' });
  });

  it('an empty roster still knows reserved words', () => {
    expect(resolveHandle('all', [])).toEqual({ kind: 'reserved', word: 'all' });
    expect(resolveHandle('ceo', [])).toEqual({ kind: 'no_ceo' });
  });
});

describe('chatCompletions', () => {
  it('lists living handles, @ceo, @all and @everyone', () => {
    const roster = [agent('ada', { ceo: true }), agent('bram'), agent('cleo', { status: 'dead' })];
    expect(chatCompletions(roster)).toEqual(['@ada', '@bram', '@ceo', '@all', '@everyone']);
  });

  it('adds @meeting while a meeting runs and drops @ceo without a CEO', () => {
    expect(chatCompletions([agent('bram')], { meetingActive: true })).toEqual([
      '@bram',
      '@all',
      '@everyone',
      '@meeting',
    ]);
  });
});
