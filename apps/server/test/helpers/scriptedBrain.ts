/**
 * A scripted brain (PLAN §13.4 "brainless integration"): the fake SDK query of every session answers each turn with
 * a script instead of a model. A turn may call tools the way the CLI does (gate, broker, the in-process MCP handler)
 * and then say something; every turn ends with a `result`. No process, no network, zero tokens.
 */

import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { QueryFactory } from '../../src/agents/sdk.js';
import { type FakeQuery, fakeQueryFactory, resultText, type ToolCallOutcome, userText } from './fakeSdk.js';

export interface TurnStep {
  /** Call an `mcp__…` (or built-in) tool; its outcome is recorded. */
  readonly tool?: { readonly name: string; readonly input: Record<string, unknown> };
  /** Then say this (bubble + transcript). */
  readonly say?: string;
}

/** What a session does with one turn's text (the user message that started it). */
export type TurnScript = (text: string, q: FakeQuery) => readonly TurnStep[];

export interface ToolRecord {
  readonly name: string;
  readonly input: Record<string, unknown>;
  readonly outcome: ToolCallOutcome;
  /** The tool result's text (first text blocks). */
  readonly text: string;
}

export interface ScriptedBrain {
  readonly factory: QueryFactory & { queries: FakeQuery[]; last(): FakeQuery };
  /** Every turn's text, per query, in order. */
  readonly turns: Array<{ q: FakeQuery; text: string }>;
  /** Every tool call the scripts made. */
  readonly tools: ToolRecord[];
  /** Turns that are still running (a step awaits a tool). */
  busy(): number;
}

const silentlyEnd = (q: FakeQuery) => {
  try {
    q.result();
  } catch {
    // the stream already ended
  }
};

/** A query factory whose sessions run `script`; the default script just says hello. */
export function scriptedBrain(script: TurnScript = () => [{ say: 'Hello.' }]): ScriptedBrain {
  const base = fakeQueryFactory();
  const turns: ScriptedBrain['turns'] = [];
  const tools: ToolRecord[] = [];
  let running = 0;
  const factory = ((params: Parameters<typeof base>[0]) => {
    const q = base(params) as unknown as FakeQuery;
    // The CLI says init first; the gate waits for its startup check before any tool runs.
    q.init();
    q.onUser = (m: SDKUserMessage) => {
      if ((m as { shouldQuery?: boolean }).shouldQuery === false) return;
      const text = userText(m);
      turns.push({ q, text });
      running++;
      void (async () => {
        try {
          for (const step of script(text, q)) {
            if (q.closed) return;
            if (step.tool) {
              q.assistantToolUse(step.tool.name, step.tool.input);
              const outcome = await q.callTool(step.tool.name, step.tool.input);
              tools.push({ ...step.tool, outcome, text: resultText(outcome) });
            }
            if (step.say && !q.closed) q.assistantText(step.say);
          }
          if (!q.closed) silentlyEnd(q);
        } finally {
          running--;
        }
      })();
    };
    return q;
  }) as unknown as ScriptedBrain['factory'];
  factory.queries = base.queries;
  factory.last = base.last;
  return { factory, turns, tools, busy: () => running };
}
