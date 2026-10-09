/**
 * Replay mode's "model": a {@link QueryFactory} that answers each user message that queries with the next scripted
 * turn. It drives the tools exactly as the CLI does (the FakeQuery test helper): PreToolUse gate → canUseTool for
 * broker tools → the in-process MCP handler with its own input validation, then emits the tool result back into the
 * stream, so the harness's accounting, the ToolGate, the InteractionBroker and the tool servers all run for real.
 */

import { randomUUID } from 'node:crypto';
import type { QueryFactory } from '../../src/agents/sdk.js';
import { FakeQuery, type ToolCallOutcome } from '../../test/helpers/fakeSdk.js';
import type { Replay, ReplayAction } from './types.js';

function outcomeText(outcome: ToolCallOutcome): { text: string; isError: boolean } {
  if (outcome.kind === 'denied') return { text: outcome.reason, isError: true };
  if (outcome.kind === 'invalid') return { text: `InputValidationError: ${outcome.error}`, isError: true };
  const result = outcome.result as { content?: { type: string; text?: string }[]; isError?: boolean } | null;
  if (!result) return { text: JSON.stringify(outcome.input).slice(0, 400), isError: false };
  const text = (result.content ?? [])
    .map((b) => (b.type === 'text' ? (b.text ?? '') : `[${b.type}]`))
    .join('\n');
  return { text, isError: result.isError === true };
}

async function play(q: FakeQuery, actions: readonly ReplayAction[]): Promise<void> {
  let apiTurns = 1;
  let last = '';
  for (const action of actions) {
    if ('text' in action) {
      q.assistantText(action.text);
      last = action.text;
      continue;
    }
    apiTurns++;
    const id = q.assistantToolUse(action.tool, action.input);
    const { text, isError } = outcomeText(await q.callTool(action.tool, action.input, { toolUseId: id }));
    q.emit({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: id, content: text, is_error: isError }],
      },
      parent_tool_use_id: null,
      uuid: randomUUID(),
      session_id: q.sessionId,
    } as never);
  }
  q.result({
    num_turns: apiTurns,
    result: last,
    total_cost_usd: 0,
    usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    modelUsage: {},
  });
}

/** A scripted query factory: turn n of `replay` answers the n-th querying user message. */
export function scriptedFactory(replay: Replay): QueryFactory {
  return (params) => {
    const q = new FakeQuery(params);
    let turn = 0;
    let started = false;
    let chain = Promise.resolve();
    q.onUser = (m) => {
      if (m.shouldQuery === false) return;
      if (!started) {
        started = true;
        q.init();
      }
      const actions = replay[turn++] ?? [{ text: '(the script has no more turns)' }];
      chain = chain.then(() => play(q, actions)).catch((err: unknown) => q.crash(String(err)));
    };
    return q;
  };
}
