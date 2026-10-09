import { createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';
import { AgentSession, checkStartup } from '../../../src/agents/AgentSession.js';
import type { SDKResultMessage } from '../../../src/agents/sdk.js';
import { buildSessionOptions } from '../../../src/agents/sessionOptions.js';
import { FAKE_MODELS, type FakeQuery, fakeQueryFactory, settle, userText } from '../../helpers/fakeSdk.js';

function makeSession(callbacks: ConstructorParameters<typeof AgentSession>[1] = {}) {
  const factory = fakeQueryFactory();
  const options = buildSessionOptions({
    kind: 'body',
    claude: { source: 'bundled', path: undefined, version: null },
    env: { HOME: '/Users/j' },
    cwd: '/tmp/agent-home',
    resume: null,
    sessionId: '11111111-1111-4111-8111-111111111111',
    persona: 'PERSONA',
    mc: createSdkMcpServer({ name: 'mc', tools: [] }),
  });
  const session = new AgentSession(
    {
      agentId: 'ada-1',
      options,
      gate: async () => ({}),
      canUseTool: async () => ({ behavior: 'deny', message: 'no' }),
      queryFactory: factory,
    },
    callbacks,
  );
  session.start();
  return { session, q: factory.last() as FakeQuery, factory };
}

describe('AgentSession', () => {
  it('starts one streaming query with the PreToolUse gate and canUseTool added, on one fixed model', () => {
    const { q } = makeSession();
    expect(q.options.hooks?.PreToolUse).toHaveLength(1);
    // Dual sessions: no model swaps, so no PostModelSwitch hook either.
    expect(q.options.hooks?.PostModelSwitch).toBeUndefined();
    expect(typeof q.options.canUseTool).toBe('function');
    expect(q.options).not.toHaveProperty('allowedTools');
    expect(q.options.model).toBe('claude-haiku-5-5');
  });

  it('sends wakes and context; ignores the zero-turn result of a shouldQuery:false send (S2)', async () => {
    const ends: SDKResultMessage[] = [];
    const { session, q } = makeSession({ onTurnEnd: (r) => ends.push(r) });
    session.send('[context] the crate code is 42', { shouldQuery: false });
    expect(session.inTurn).toBe(false);
    await q.waitForSent(1);
    expect(q.sent[0]).toMatchObject({ shouldQuery: false });
    q.result({ num_turns: 0, result: '' });
    await settle();
    expect(ends).toHaveLength(0);
    session.send('what is the code?');
    expect(session.inTurn).toBe(true);
    await q.waitForSent(2);
    expect(userText(q.sent[1])).toBe('what is the code?');
    q.result({ num_turns: 2 });
    await settle();
    expect(ends).toHaveLength(1);
    expect(session.inTurn).toBe(false);
    expect(session.lastUsage?.contextTokens).toBe(5120);
  });

  it("measures the context from the turn's last API call, not the result's sum over all calls", async () => {
    const { session, q } = makeSession({});
    session.send('collect logs');
    await q.waitForSent(1);
    const call = (input: number, read: number, output: number) =>
      q.emit({
        type: 'assistant',
        message: {
          id: `msg_${input}`,
          model: 'claude-opus-5-5',
          role: 'assistant',
          content: [{ type: 'text', text: 'working' }],
          usage: {
            input_tokens: input,
            cache_read_input_tokens: read,
            cache_creation_input_tokens: 1000,
            output_tokens: output,
          },
        },
        parent_tool_use_id: null,
        uuid: `u-${input}`,
        session_id: 's',
      } as never);
    // Five calls in one turn, each re-reading a ~33k prompt (acceptance run: 165,948 summed, a /compact for nothing).
    for (const n of [1, 2, 3, 4, 5]) call(100 * n, 32_000, 50);
    q.result({
      num_turns: 5,
      usage: {
        input_tokens: 1500,
        output_tokens: 250,
        cache_read_input_tokens: 160_000,
        cache_creation_input_tokens: 5000,
      },
    });
    await settle();
    expect(session.lastUsage?.contextTokens).toBe(500 + 32_000 + 1000 + 50);
  });

  it('keeps the turn open when more queued turns follow, and counts an interrupted zero-turn result', async () => {
    const ends: number[] = [];
    const { session, q } = makeSession({ onTurnEnd: (r) => ends.push(r.num_turns) });
    session.send('a');
    q.result({ num_turns: 1, queued_turn_count: 1 });
    await settle();
    expect(session.inTurn).toBe(true);
    q.result({ num_turns: 1 });
    await settle();
    expect(session.inTurn).toBe(false);
    session.send('long task');
    await session.interrupt();
    expect(q.interrupted).toBe(1);
    q.result({ num_turns: 0, subtype: 'error_during_execution', is_error: true });
    await settle();
    expect(ends).toEqual([1, 1, 0]);
  });

  it('routes main-thread text and tool_use, ignores subagent traffic, and reports rate limits', async () => {
    const seen: string[] = [];
    const { q } = makeSession({
      onAssistantText: (t) => seen.push(`text:${t}`),
      onToolUse: (n) => seen.push(`tool:${n}`),
      onRateLimit: (i) => seen.push(`rate:${i.status}`),
      onAssistantError: (e) => seen.push(`error:${e}`),
    });
    q.assistantText('Hello Jasper. I will mine.');
    q.assistantToolUse('mcp__mc__mine', { block: 'oak_log', count: 3 });
    q.emit({
      type: 'assistant',
      message: {
        id: 'x',
        model: 'claude-haiku-5-5',
        role: 'assistant',
        content: [{ type: 'text', text: 'sub' }],
      },
      parent_tool_use_id: 'toolu_parent',
      uuid: 'u',
      session_id: 's',
    } as never);
    q.rateLimit({ status: 'allowed', unifiedWindows: { five_hour: { utilization: 0.3 } } });
    q.assistantError('rate_limit');
    await settle();
    expect(seen).toEqual([
      'text:Hello Jasper. I will mine.',
      'tool:mcp__mc__mine',
      'rate:allowed',
      'error:rate_limit',
    ]);
  });

  it('never swaps the model: no flag-layer calls, the model stays the one the session started with', async () => {
    const { session, q } = makeSession();
    session.send('go');
    await q.waitForSent(1);
    q.assistantText('Going.');
    q.result();
    await settle();
    expect(q.calls.filter((c) => c.method === 'applyFlagSettings')).toEqual([]);
    expect(session.model).toBe('claude-haiku-5-5');
    expect(q.effort).toBe('xhigh');
  });

  it('notifies the exit: null after close(), an error after a crash', async () => {
    const exits: (Error | null)[] = [];
    const a = makeSession({ onExit: (e) => exits.push(e) });
    await a.session.close(100);
    expect(exits).toEqual([null]);
    const b = makeSession({ onExit: (e) => exits.push(e) });
    b.q.crash('claude exited with code 1');
    await settle();
    expect(exits[1]?.message).toBe('claude exited with code 1');
    expect(b.session.started).toBe(false);
    const c = makeSession({ onExit: (e) => exits.push(e) });
    c.q.end();
    await settle();
    expect(exits[2]?.message).toMatch(/ended/);
  });

  it('remembers the session id from the stream and fires onInit once as first', async () => {
    const inits: boolean[] = [];
    const { session, q } = makeSession({ onInit: (_i, first) => inits.push(first) });
    q.init();
    q.init();
    await settle();
    expect(inits).toEqual([true, false]);
    expect(session.sessionId).toBe(q.sessionId);
  });
});

describe('startup assertions (PLAN §6.1)', () => {
  const init = {
    apiKeySource: 'none',
    tools: ['AskUserQuestion', 'mcp__mc__status', 'mcp__pc__bash'],
  } as never;

  it('passes for a first-party subscription with Haiku xhigh and Opus available', async () => {
    const q = {
      accountInfo: async () => ({ subscriptionType: 'Claude Max', apiProvider: 'firstParty' as const }),
      supportedModels: async () => FAKE_MODELS,
    };
    expect(await checkStartup(init, q, 'subscription')).toEqual([]);
  });

  it('flags an API key, a third-party provider, no subscription, missing models and host tools', async () => {
    const bad = {
      apiKeySource: 'ANTHROPIC_API_KEY',
      tools: ['Bash', 'Read', 'mcp__mc__status', 'Agent'],
    } as never;
    const q = {
      accountInfo: async () => ({ apiProvider: 'bedrock' as const }),
      supportedModels: async () => [
        {
          value: 'claude-haiku-5-5',
          displayName: 'h',
          description: '',
          supportedEffortLevels: ['low' as const],
        },
      ],
    };
    const problems = await checkStartup(bad, q, 'subscription');
    expect(problems).toHaveLength(6);
    expect(problems.join('\n')).toMatch(/API key/);
    expect(problems.join('\n')).toMatch(/bedrock/);
    expect(problems.join('\n')).toMatch(/subscription/);
    expect(problems.join('\n')).toMatch(/xhigh/);
    expect(problems.join('\n')).toMatch(/Opus 5.5/);
    expect(problems.join('\n')).toMatch(/Bash, Read, Agent/);
  });

  it('matches models on resolvedModel, not the alias (S2), and skips account checks in API-key mode', async () => {
    const q = {
      accountInfo: async () => {
        throw new Error('no');
      },
      supportedModels: async () => FAKE_MODELS,
    };
    expect(
      await checkStartup({ apiKeySource: 'ANTHROPIC_API_KEY', tools: [] } as never, q, 'api_key', () => {}),
    ).toEqual([]);
  });

  it('hands the account to the redactor in both modes, and a failing listener fails nothing', async () => {
    const account = {
      subscriptionType: 'Claude Max',
      apiProvider: 'firstParty' as const,
      email: 'jasper@example.com',
      organization: "jasper@example.com's Organization",
    };
    const q = { accountInfo: async () => account, supportedModels: async () => FAKE_MODELS };
    const seen: unknown[] = [];
    expect(await checkStartup(init, q, 'subscription', (a) => seen.push(a))).toEqual([]);
    expect(await checkStartup(init, q, 'api_key', (a) => seen.push(a))).toEqual([]);
    expect(seen).toEqual([account, account]);
    const throwing = () => {
      throw new Error('listener');
    };
    expect(await checkStartup(init, q, 'subscription', throwing)).toEqual([]);
  });
});
