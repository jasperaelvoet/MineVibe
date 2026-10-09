/**
 * Shapes shared by the eval harness: scenarios (setup, opening message, success checks, scripted replays), what a run
 * records (tool calls, questions, speech), and per-run metrics.
 */

import type { CardQuestion } from '@minevibe/protocol';
import type { ScriptedPc } from '../pc/ScriptedPc.js';
import type { SimSkillApi } from '../sim/SimSkillApi.js';
import type { SimWorld } from '../sim/world.js';

export type Suite = 'mc' | 'pc';
export type Mode = 'replay' | 'live';

/** One step of a scripted model turn: a tool call (full tool name, e.g. `mcp__mc__collect`) or assistant text. */
export type ReplayAction =
  | { readonly tool: string; readonly input: Record<string, unknown> }
  | { readonly text: string };

/** A scripted model: one list of actions per turn (the turn ends after the last). */
export type Replay = readonly (readonly ReplayAction[])[];

export interface Check {
  readonly name: string;
  readonly pass: boolean;
  /** Counts toward success (soft checks are reported only). */
  readonly required: boolean;
  readonly detail?: string | undefined;
}

/** One tool call as the tool server saw it (gate-denied calls never reach a handler). */
export interface ToolCallRecord {
  readonly tool: string;
  readonly input: Record<string, unknown>;
  readonly isError: boolean;
  /** The first text block of the result (clipped at 3,000 characters). */
  readonly text: string;
  readonly turn: number;
}

export interface AskRecord {
  readonly questions: readonly CardQuestion[];
  readonly answers: Readonly<Record<string, string>>;
  readonly turn: number;
}

/** What a run did, as the checks see it. */
export interface RunTrace {
  readonly calls: readonly ToolCallRecord[];
  readonly denials: readonly { readonly tool: string; readonly reason: string; readonly turn: number }[];
  readonly asked: readonly AskRecord[];
  /** Spoken text: `mc__say` texts and every turn's final assistant text, in order. */
  readonly speech: readonly string[];
  /** The last turn's final assistant text. */
  readonly finalText: string;
}

export interface McTrace extends RunTrace {
  readonly world: SimWorld;
  readonly skills: SimSkillApi;
}

export interface PcTrace extends RunTrace {
  readonly pc: ScriptedPc;
}

interface ScenarioBase {
  readonly id: string;
  readonly title: string;
  /** What the player says (mc) or the task on the PC (pc). */
  readonly prompt: string;
  /** Answers a question card (default: the first option, or "Your call."). */
  answer?(question: CardQuestion): string;
  /** A scripted good run (passes) and, where useful, the failure mode to catch (fails). */
  readonly replay: { readonly good: Replay; readonly bad?: Replay };
  /** The same runs with the v2 `mc` tools (docs/design/tools-v2-mc.md), when the scenario has them. */
  readonly replayV2?: { readonly good: Replay; readonly bad?: Replay };
}

export interface McScenario extends ScenarioBase {
  readonly suite: 'mc';
  world(): SimWorld;
  /** Game ticks the world keeps running after the last turn before the checks (default 0). */
  readonly settleTicks?: number;
  /** The simulated player reacts to what the agent says (e.g. walks into the house when told to). */
  onSpeech?(world: SimWorld, text: string): void;
  checks(trace: McTrace): Check[];
}

export interface PcScenario extends ScenarioBase {
  readonly suite: 'pc';
  checks(trace: PcTrace): Check[];
}

export type Scenario = McScenario | PcScenario;

export type StopReason = 'done' | 'turn_cap' | 'budget' | 'timeout' | 'error';

export interface RunResult {
  readonly scenario: string;
  readonly suite: Suite;
  readonly mode: Mode;
  readonly run: number;
  /** The `mc` tool set of the run (v1 when absent: runs saved before v2). */
  readonly tools?: 'v1' | 'v2' | undefined;
  readonly model: string | null;
  readonly effort: string | null;
  readonly success: boolean;
  readonly checks: readonly Check[];
  /** Model turns (one per user message that queried). */
  readonly turns: number;
  /** API round trips across those turns (`num_turns`). */
  readonly apiTurns: number;
  readonly toolCalls: number;
  /** Tool results the model saw as errors (gate denials, failed jobs, bad input). */
  readonly failedCalls: number;
  readonly deniedCalls: number;
  /** Prompt tokens: uncached input + cache reads + cache writes. */
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly costUsd: number;
  readonly wallMs: number;
  readonly stop: StopReason;
  readonly error?: string | undefined;
  readonly finalText: string;
  /** Compact transcript: one line per message, tool call and result. */
  readonly transcript: readonly string[];
}
