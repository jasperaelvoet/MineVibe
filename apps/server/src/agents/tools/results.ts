/** Tool-result helpers shared by the `mc` and `pc` servers. */

import type { SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';
import { isApiError } from '../../contracts/common.js';

/** The MCP `CallToolResult` (taken from the SDK's tool type, so the MCP SDK is not a direct dependency). */
export type CallToolResult = Awaited<ReturnType<SdkMcpToolDefinition['handler']>>;

export function textResult(text: string): CallToolResult {
  return { content: [{ type: 'text', text }] };
}

export function errorResult(text: string): CallToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

/** An ApiError as an agent-facing tool error ("Error RESERVED: …"); anything else as a generic error. */
export function errorFrom(err: unknown): CallToolResult {
  if (isApiError(err)) return errorResult(`Error ${err.code}: ${err.message}`);
  return errorResult(`Error: ${err instanceof Error ? err.message : String(err)}`);
}

/** Appends a line (the status footer) to the last text block. */
export function withFooter(result: CallToolResult, footer: string | null): CallToolResult {
  if (!footer) return result;
  const content = [...result.content];
  const last = content.at(-1);
  if (last && last.type === 'text') {
    content[content.length - 1] = { ...last, text: `${last.text}\n${footer}` };
  } else {
    content.push({ type: 'text', text: footer });
  }
  return { ...result, content };
}

/** Compact JSON for observation results, capped. */
export function compactJson(value: unknown, max = 8_000): string {
  const text = JSON.stringify(value);
  if (text === undefined) return 'null';
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Clamps a `wait_s` input to milliseconds. */
export function waitMs(waitS: unknown, fallbackS: number, maxS: number): number {
  const s = typeof waitS === 'number' && Number.isFinite(waitS) ? waitS : fallbackS;
  return Math.round(Math.max(0, Math.min(maxS, s)) * 1000);
}
