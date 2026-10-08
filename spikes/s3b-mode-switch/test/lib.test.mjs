import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  agentEnv,
  apiCalls,
  applyProfileToServers,
  budgetLeft,
  claimTurn,
  makeGate,
  makeServers,
  sanitize,
  summarizeMessage,
  turnEvidence,
  userMessage,
} from '../src/lib.mjs';
import { profile } from '../src/profiles.mjs';

/** A Recorder stand-in that never touches out/. */
function fakeRec() {
  return {
    turn: 1,
    t: () => 0,
    events: [],
    hookCalls: [],
    handlerCalls: [],
    inits: [],
    data: {},
    event() {},
    append(key, value) {
      if (!Array.isArray(this.data[key])) this.data[key] = [];
      this.data[key].push(value);
    },
  };
}

describe('agentEnv', () => {
  it('forwards only the allowlist and drops ANTHROPIC_/CLAUDE/MCP_ names', () => {
    const env = agentEnv({
      HOME: '/home/x',
      USER: 'x',
      ANTHROPIC_API_KEY: 'k',
      ANTHROPIC_BASE_URL: 'http://proxy',
      CLAUDECODE: '1',
      CLAUDE_CODE_EFFORT_LEVEL: 'max',
      CLAUDE_CONFIG_DIR: '/tmp/c',
      MCP_TIMEOUT: '1',
      SECRET_THING: 's',
    });
    assert.deepEqual(Object.keys(env).sort(), [
      'CLAUDE_AGENT_SDK_CLIENT_APP',
      'CLAUDE_CODE_DISABLE_AUTO_MEMORY',
      'DISABLE_AUTOUPDATER',
      'HOME',
      'LANG',
      'PATH',
      'TERM',
      'USER',
    ]);
    assert.equal(env.CLAUDE_CODE_DISABLE_AUTO_MEMORY, '1');
  });
});

describe('sanitize', () => {
  it('redacts e-mails, keys, bearer tokens and token-ish keys but keeps counters', () => {
    const s = sanitize({
      a: 'mail me at someone@example.com',
      b: 'key sk-ant-oat01-abcDEF_123',
      c: 'Authorization: Bearer abc.def-ghi',
      oauthToken: 'x',
      nested: [{ user_id: 'u' }],
      apiKeySource: 'none',
      totalTokens: 123,
      input_tokens: 5,
    });
    assert.equal(s.a, 'mail me at [redacted-email]');
    assert.equal(s.b, 'key [redacted-key]');
    assert.equal(s.c, 'Authorization: Bearer [redacted]');
    assert.equal(s.oauthToken, '[redacted]');
    assert.equal(s.nested[0].user_id, '[redacted]');
    assert.equal(s.apiKeySource, 'none');
    assert.equal(s.totalTokens, 123);
    assert.equal(s.input_tokens, 5);
  });

  it('redacts org/account ids inside stringified JSON but keeps session ids', () => {
    const s = sanitize(
      '{"type":"credential_org","organizationUuid":"00000000-1111-4222-8333-444444444444","sessionId":"aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"}',
    );
    assert.ok(!s.includes('00000000-1111'), s);
    assert.ok(s.includes('"organizationUuid":"[redacted]'), s);
    assert.ok(s.includes('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'), s);
    assert.ok(!sanitize('account_id=0123456789abcdef0123456789abcdef').includes('0123456789abcdef'));
  });
});

describe('claimTurn', () => {
  it('counts turns in the budget file and refuses past the cap', () => {
    const path = join(mkdtempSync(join(tmpdir(), 's3b-budget-')), 'budget.json');
    assert.equal(budgetLeft({ path, cap: 2 }), 2);
    assert.equal(claimTurn('a', { path, cap: 2 }), 1);
    assert.equal(claimTurn('b', { path, cap: 2 }), 2);
    assert.throws(() => claimTurn('c', { path, cap: 2 }), /budget exhausted/);
    assert.equal(budgetLeft({ path, cap: 2 }), 0);
    assert.deepEqual(
      JSON.parse(readFileSync(path, 'utf8')).turns.map((t) => t.label),
      ['a', 'b'],
    );
  });
});

describe('applyProfileToServers (M4)', () => {
  const enabled = (server) =>
    Object.entries(server.instance._registeredTools)
      .filter(([, t]) => t.enabled)
      .map(([n]) => n)
      .sort();

  it('enables exactly the profile tools on the in-process servers and is idempotent', () => {
    const servers = makeServers(fakeRec());
    assert.equal(applyProfileToServers(servers, profile('wander')), 7); // pc off
    assert.deepEqual(enabled(servers.pc), []);
    assert.equal(enabled(servers.mc).length, 13);
    assert.equal(applyProfileToServers(servers, profile('wander')), 0);

    assert.equal(applyProfileToServers(servers, profile('seated')), 11); // 4 mc off, 7 pc on
    assert.deepEqual(enabled(servers.mc), [...profile('seated').mc].sort());
    assert.equal(enabled(servers.pc).length, 7);

    applyProfileToServers(servers, profile('meeting'));
    assert.deepEqual(enabled(servers.mc), [...profile('meeting').mc].sort());
    assert.deepEqual(enabled(servers.pc), []);
  });

  it('mcSubset builds an mc server with only those tools', () => {
    const { mc } = makeServers(fakeRec(), { mcSubset: ['status', 'say'] });
    assert.deepEqual(Object.keys(mc.instance._registeredTools).sort(), ['say', 'status']);
  });
});

describe('makeGate', () => {
  const call = async (gate, tool_name) => gate({ hook_event_name: 'PreToolUse', tool_name, tool_input: {} });

  it('allows visible tools, denies hidden ones, leaves broker tools to canUseTool', async () => {
    const rec = fakeRec();
    let current = profile('seated');
    const gate = makeGate(rec, () => current);
    assert.equal((await call(gate, 'mcp__pc__bash')).hookSpecificOutput.permissionDecision, 'allow');
    assert.equal((await call(gate, 'mcp__mc__goto')).hookSpecificOutput.permissionDecision, 'deny');
    assert.deepEqual(await call(gate, 'AskUserQuestion'), {});
    current = profile('wander');
    assert.equal((await call(gate, 'mcp__pc__bash')).hookSpecificOutput.permissionDecision, 'deny');
    assert.equal((await call(gate, 'mcp__mc__goto')).hookSpecificOutput.permissionDecision, 'allow');
    assert.deepEqual(
      rec.hookCalls.map((h) => [h.profile, h.tool_name, h.decision]),
      [
        ['seated', 'mcp__pc__bash', 'allow'],
        ['seated', 'mcp__mc__goto', 'deny'],
        ['seated', 'AskUserQuestion', 'none'],
        ['wander', 'mcp__pc__bash', 'deny'],
        ['wander', 'mcp__mc__goto', 'allow'],
      ],
    );
  });
});

describe('turn evidence', () => {
  const assistant = (id, model, usage, blocks) => ({
    kind: 'msg',
    turn: 2,
    ...summarizeMessage({ type: 'assistant', message: { id, model, usage, content: blocks } }),
  });

  it('dedupes API calls by message id and reports the first call cache usage', () => {
    const rec = fakeRec();
    const u1 = {
      input_tokens: 3,
      output_tokens: 10,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 9000,
    };
    const u2 = {
      input_tokens: 1,
      output_tokens: 5,
      cache_read_input_tokens: 9000,
      cache_creation_input_tokens: 200,
    };
    rec.events.push(
      assistant('m1', 'claude-opus-5-5', u1, [
        { type: 'tool_use', id: 't1', name: 'mcp__pc__bash', input: { command: 'echo x' } },
      ]),
      assistant('m1', 'claude-opus-5-5', u1, [{ type: 'text', text: 'x' }]),
      {
        kind: 'msg',
        turn: 2,
        type: 'user',
        content: [{ type: 'tool_result', is_error: true, text: 'No such tool available' }],
      },
      assistant('m2', 'claude-opus-5-5', u2, [{ type: 'text', text: 'tools=mcp__pc__bash' }]),
      assistant('m3', 'claude-haiku-5-5', u2, [{ type: 'text', text: 'other turn' }]),
    );
    rec.events.at(-1).turn = 3;
    rec.inits.push({ turn: 2, tools: ['AskUserQuestion', 'mcp__pc__bash'] });
    rec.handlerCalls.push({ turn: 2, tool: 'mcp__pc__bash' });
    assert.equal(apiCalls(rec.events, 2).length, 2);
    const ev = turnEvidence(rec, 2, {
      result: 'codeword=ALPHA-7; tools=mcp__pc__bash, WebSearch',
      subtype: 'success',
      num_turns: 2,
    });
    assert.deepEqual(ev.models, ['claude-opus-5-5']);
    assert.equal(ev.firstCall.cacheWrite, 9000);
    assert.equal(ev.firstCall.cacheRead, 0);
    assert.equal(ev.turnTotals.cacheRead, 9000);
    assert.deepEqual(
      ev.toolUses.map((t) => t.name),
      ['mcp__pc__bash'],
    );
    assert.deepEqual(ev.toolResults, [{ is_error: true, text: 'No such tool available' }]);
    assert.deepEqual(ev.initTools, ['mcp__pc__bash']);
    assert.deepEqual(ev.listed, ['WebSearch', 'mcp__pc__bash']);
    assert.deepEqual(ev.handlers, ['mcp__pc__bash']);
  });

  it('userMessage carries extra fields such as shouldQuery', () => {
    const m = userMessage('hi', { shouldQuery: false });
    assert.equal(m.shouldQuery, false);
    assert.equal(m.message.content, 'hi');
    assert.equal(m.parent_tool_use_id, null);
  });
});
