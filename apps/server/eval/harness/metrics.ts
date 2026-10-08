/**
 * Per-run accounting from the SDK stream (tool calls, failed results, tokens, cost) and the summary table.
 *
 * Token numbers come from the latest `result.modelUsage` of the run's query (cumulative per query, summed over
 * models), falling back to the per-turn `usage` when a result has no modelUsage (the scripted model).
 */

import type { SDKMessage } from '../../src/agents/sdk.js';
import type { RunResult } from './types.js';

/** One line, at most `max` characters. */
export function clip(text: string, max = 140): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** A compact rendering of a tool input: `{item:"oak_log",count:10}`. */
export function briefInput(input: unknown, max = 120): string {
  if (input === null || typeof input !== 'object') return clip(String(input), max);
  const parts = Object.entries(input as Record<string, unknown>).map(([k, v]) => {
    const s =
      typeof v === 'string' ? JSON.stringify(v.length > 60 ? `${v.slice(0, 59)}…` : v) : JSON.stringify(v);
    return `${k}:${s}`;
  });
  return clip(`{${parts.join(',')}}`, max);
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        const block = b as { type?: string; text?: string };
        return block.type === 'text' ? (block.text ?? '') : block.type === 'image' ? '[image]' : '';
      })
      .join(' ');
  }
  return '';
}

function shortTool(name: string): string {
  return name.replace(/^mcp__(mc|pc)__/, '$1.');
}

export class StreamMetrics {
  toolCalls = 0;
  failedCalls = 0;
  apiTurns = 0;
  inputTokens = 0;
  outputTokens = 0;
  cacheReadTokens = 0;
  cacheWriteTokens = 0;
  costUsd = 0;
  model: string | null = null;
  readonly transcript: string[] = [];
  /** Texts of the current turn's assistant messages. */
  turnTexts: string[] = [];
  #perTurnUsage = { input: 0, output: 0, read: 0, write: 0 };
  #sawModelUsage = false;

  onMessage(m: SDKMessage): void {
    switch (m.type) {
      case 'assistant': {
        if (m.parent_tool_use_id !== null) return;
        const model = m.message?.model;
        if (typeof model === 'string' && model !== '<synthetic>') this.model ??= model;
        for (const block of m.message?.content ?? []) {
          if (block.type === 'text' && block.text.trim().length > 0) {
            this.turnTexts.push(block.text);
            this.transcript.push(`  < ${clip(block.text, 200)}`);
          } else if (block.type === 'tool_use') {
            this.toolCalls++;
            this.transcript.push(`  - ${shortTool(block.name)} ${briefInput(block.input)}`);
          }
        }
        return;
      }
      case 'user': {
        if (m.parent_tool_use_id !== null) return;
        const content = m.message?.content;
        if (!Array.isArray(content)) return;
        for (const b of content) {
          const block = b as { type?: string; is_error?: boolean; content?: unknown };
          if (block.type !== 'tool_result') continue;
          if (block.is_error === true) this.failedCalls++;
          this.transcript.push(
            `    ${block.is_error === true ? 'x' : '='} ${clip(toolResultText(block.content), 160)}`,
          );
        }
        return;
      }
      case 'result': {
        this.apiTurns += m.num_turns;
        this.costUsd = Math.max(this.costUsd, m.total_cost_usd ?? 0);
        const models = Object.values(m.modelUsage ?? {}) as unknown as Record<string, number>[];
        if (models.length > 0) {
          this.#sawModelUsage = true;
          const sum = (k: string) => models.reduce((s, u) => s + (u[k] ?? 0), 0);
          this.inputTokens =
            sum('inputTokens') + sum('cacheReadInputTokens') + sum('cacheCreationInputTokens');
          this.outputTokens = sum('outputTokens');
          this.cacheReadTokens = sum('cacheReadInputTokens');
          this.cacheWriteTokens = sum('cacheCreationInputTokens');
        } else if (!this.#sawModelUsage) {
          const u = m.usage as unknown as Record<string, number | undefined>;
          this.#perTurnUsage.input += u.input_tokens ?? 0;
          this.#perTurnUsage.output += u.output_tokens ?? 0;
          this.#perTurnUsage.read += u.cache_read_input_tokens ?? 0;
          this.#perTurnUsage.write += u.cache_creation_input_tokens ?? 0;
          this.inputTokens = this.#perTurnUsage.input + this.#perTurnUsage.read + this.#perTurnUsage.write;
          this.outputTokens = this.#perTurnUsage.output;
          this.cacheReadTokens = this.#perTurnUsage.read;
          this.cacheWriteTokens = this.#perTurnUsage.write;
        }
        return;
      }
      default:
        return;
    }
  }
}

export interface SummaryRow {
  readonly scenario: string;
  readonly model: string;
  readonly runs: number;
  readonly successes: number;
  readonly toolCalls: number;
  readonly failedCalls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly wallS: number;
  readonly turns: number;
  readonly costUsd: number;
}

const mean = (xs: readonly number[]) => (xs.length === 0 ? 0 : xs.reduce((s, x) => s + x, 0) / xs.length);

/** One row per scenario (and model), means over its runs. */
export function summarize(results: readonly RunResult[]): SummaryRow[] {
  const groups = new Map<string, RunResult[]>();
  for (const r of results) {
    const key = `${r.scenario}\n${r.model ?? '?'}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  return [...groups.values()].map((rs) => {
    const first = rs[0] as RunResult;
    return {
      scenario: first.scenario,
      model: shortModel(first.model, first.effort),
      runs: rs.length,
      successes: rs.filter((r) => r.success).length,
      toolCalls: mean(rs.map((r) => r.toolCalls)),
      failedCalls: mean(rs.map((r) => r.failedCalls)),
      inputTokens: mean(rs.map((r) => r.inputTokens)),
      outputTokens: mean(rs.map((r) => r.outputTokens)),
      wallS: mean(rs.map((r) => r.wallMs / 1000)),
      turns: mean(rs.map((r) => r.turns)),
      costUsd: rs.reduce((s, r) => s + r.costUsd, 0),
    };
  });
}

export function shortModel(model: string | null, effort: string | null): string {
  const m = (model ?? '?').replace(/^claude-/, '').replace(/-(\d+)-(\d+).*$/, ' $1.$2');
  return effort ? `${m} / ${effort}` : m;
}

function n(v: number, digits = 1): string {
  return Number.isInteger(v) ? String(v) : v.toFixed(digits);
}

function k(v: number): string {
  return v >= 10_000
    ? `${(v / 1000).toFixed(0)}k`
    : v >= 1000
      ? `${(v / 1000).toFixed(1)}k`
      : String(Math.round(v));
}

/** The summary as a Markdown table. */
export function formatTable(rows: readonly SummaryRow[]): string {
  const head = [
    '| Scenario | Model | Success | Tool calls | Failed calls | Input tok | Output tok | Wall s | Turns | Cost $ |',
    '|---|---|---|---|---|---|---|---|---|---|',
  ];
  const body = rows.map(
    (r) =>
      `| ${r.scenario} | ${r.model} | ${r.successes}/${r.runs} | ${n(r.toolCalls)} | ${n(r.failedCalls)} | ${k(r.inputTokens)} | ${k(r.outputTokens)} | ${n(r.wallS)} | ${n(r.turns)} | ${r.costUsd.toFixed(3)} |`,
  );
  return [...head, ...body].join('\n');
}

/** Per-run lines: scenario, run, success, the failed checks, and why the run stopped. */
export function formatRuns(results: readonly RunResult[]): string {
  return results
    .map((r) => {
      const failed = r.checks
        .filter((c) => !c.pass)
        .map((c) => `${c.required ? '' : '(soft) '}${c.name}: ${c.detail ?? ''}`);
      return `- ${r.scenario} #${r.run} ${r.success ? 'PASS' : 'FAIL'} (${r.toolCalls} calls, ${r.failedCalls} failed, ${r.turns} turns, stop ${r.stop})${failed.length > 0 ? ` — ${failed.join('; ')}` : ''}${r.error ? ` [error: ${r.error}]` : ''}`;
    })
    .join('\n');
}
