import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  allMcpTools,
  BUILTIN_TOOLS,
  compareTools,
  denyRules,
  gateAllows,
  HAIKU,
  MC_TOOLS,
  managedOnly,
  mcpServerNames,
  OPUS,
  PC_TOOLS,
  PROFILES,
  parseToolList,
  profile,
  visibleMcpTools,
  visibleTools,
  WEB_TOOLS,
} from '../src/profiles.mjs';

const mc = (n) => `mcp__mc__${n}`;
const pc = (n) => `mcp__pc__${n}`;

describe('profiles match the brief', () => {
  it('wander: Haiku xhigh, every mc tool, no pc, no web', () => {
    const p = profile('wander');
    assert.equal(p.model, HAIKU);
    assert.equal(p.effort, 'xhigh');
    assert.deepEqual(visibleMcpTools(p).sort(), Object.keys(MC_TOOLS).map(mc).sort());
    assert.ok(!visibleTools(p).some((t) => t.startsWith('mcp__pc__')));
    assert.ok(!visibleTools(p).some((t) => WEB_TOOLS.includes(t)));
  });

  it('seated: Opus medium, every pc tool + web, a minimal mc set without movement/world/sit', () => {
    const p = profile('seated');
    assert.equal(p.model, OPUS);
    assert.equal(p.effort, 'medium');
    const v = visibleTools(p);
    for (const t of PC_TOOLS) assert.ok(v.includes(pc(t)), t);
    for (const t of WEB_TOOLS) assert.ok(v.includes(t), t);
    for (const t of [
      'status',
      'look_around',
      'stand_up',
      'say',
      'tell',
      'remember',
      'codex_read',
      'calendar_list',
      'report_task',
    ])
      assert.ok(v.includes(mc(t)), t);
    for (const t of ['goto', 'mine', 'craft', 'sit_at_pc']) assert.ok(!v.includes(mc(t)), t);
  });

  it('meeting: Haiku, social + codex + calendar + stand only', () => {
    const p = profile('meeting');
    assert.equal(p.model, HAIKU);
    assert.deepEqual(
      visibleMcpTools(p).sort(),
      ['say', 'tell', 'remember', 'codex_read', 'calendar_list', 'report_task', 'stand_up'].map(mc).sort(),
    );
  });

  it('unknown profile throws', () => {
    assert.throws(() => profile('sleeping'), /unknown profile/);
  });
});

describe('denyRules', () => {
  it('wander hides the whole pc server by its server-level rule and both web tools, no mc tool', () => {
    assert.deepEqual(denyRules(profile('wander')), ['mcp__pc', ...WEB_TOOLS]);
  });

  it('seated hides exactly the movement/world/sit mc tools', () => {
    assert.deepEqual(
      denyRules(profile('seated')).sort(),
      ['craft', 'goto', 'mine', 'sit_at_pc'].map(mc).sort(),
    );
  });

  it('visible and denied partition every managed tool in every profile', () => {
    const managed = [...allMcpTools(), ...WEB_TOOLS].sort();
    for (const p of Object.values(PROFILES)) {
      const visible = managedOnly(visibleTools(p));
      const denied = denyRules(p).flatMap((r) => (r === 'mcp__pc' ? PC_TOOLS.map(pc) : [r]));
      assert.deepEqual([...visible, ...denied].sort(), managed, p.name);
      assert.equal(new Set([...visible, ...denied]).size, managed.length, `${p.name}: overlap`);
    }
  });
});

describe('gateAllows agrees with the profile', () => {
  it('allows exactly the visible mcp/web tools', () => {
    for (const p of Object.values(PROFILES)) {
      const visible = new Set(visibleTools(p));
      for (const t of [...allMcpTools(), ...WEB_TOOLS])
        assert.equal(gateAllows(p, t), visible.has(t), `${p.name} ${t}`);
    }
  });

  it('denies unknown tools on the managed servers and leaves broker built-ins undecided', () => {
    assert.equal(gateAllows(profile('seated'), 'mcp__pc__rm_rf'), false);
    assert.equal(gateAllows(profile('wander'), 'mcp__mc__fly'), false);
    assert.equal(gateAllows(profile('wander'), 'AskUserQuestion'), null);
    assert.equal(gateAllows(profile('wander'), 'mcp__other__x'), null);
  });
});

describe('mcpServerNames (M2)', () => {
  it('registers pc only while seated', () => {
    assert.deepEqual(mcpServerNames(profile('wander')), ['mc']);
    assert.deepEqual(mcpServerNames(profile('seated')), ['mc', 'pc']);
    assert.deepEqual(mcpServerNames(profile('meeting')), ['mc']);
  });
});

describe('parseToolList', () => {
  it('extracts mcp and built-in names from a one-line reply, deduplicated and sorted', () => {
    const reply =
      'codeword=ALPHA-7; goto=No such tool; tools=AskUserQuestion, EnterPlanMode, ExitPlanMode, WebSearch, WebFetch, ' +
      'mcp__pc__bash, mcp__mc__status, mcp__pc__bash';
    assert.deepEqual(parseToolList(reply), [
      'AskUserQuestion',
      'EnterPlanMode',
      'ExitPlanMode',
      'WebFetch',
      'WebSearch',
      'mcp__mc__status',
      'mcp__pc__bash',
    ]);
  });

  it('handles markdown/backticks and non-strings', () => {
    assert.deepEqual(parseToolList('`mcp__mc__goto`, **ToolSearch**'), ['ToolSearch', 'mcp__mc__goto']);
    assert.deepEqual(parseToolList(undefined), []);
    assert.deepEqual(parseToolList('no tools here'), []);
  });
});

describe('compareTools / managedOnly', () => {
  it('reports missing and extra names', () => {
    assert.deepEqual(compareTools(['a', 'b'], ['b', 'c']), { missing: ['a'], extra: ['c'] });
    assert.deepEqual(compareTools([], []), { missing: [], extra: [] });
  });

  it('managedOnly keeps mc/pc/web tools and drops other built-ins', () => {
    assert.deepEqual(managedOnly(['AskUserQuestion', 'WebFetch', 'mcp__pc__read', 'mcp__x__y']), [
      'WebFetch',
      'mcp__pc__read',
    ]);
  });

  it('every built-in passed in options.tools is either web or a broker tool', () => {
    for (const t of BUILTIN_TOOLS)
      assert.ok(WEB_TOOLS.includes(t) || ['AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode'].includes(t), t);
  });
});
