import { type SdkMcpToolDefinition, tool } from '@anthropic-ai/claude-agent-sdk';
import type { Screenshot } from '../../../contracts/PcApi.js';
import type { CallToolResult } from '../results.js';
import { textResult } from '../results.js';
import type { PcToolContext, Seat } from './context.js';
import { SCREEN_UNCHANGED } from './formats.js';

// biome-ignore lint/suspicious/noExplicitAny: the server holds tools of many different input shapes
export type Def = SdkMcpToolDefinition<any>;

export { tool };

/** Whether a helper answered with a tool result (an error to pass on) rather than its value. */
export const isResult = (v: unknown): v is CallToolResult =>
  typeof v === 'object' && v !== null && Array.isArray((v as { content?: unknown }).content);

/** The definitions of a group of tools (each has its own input type; the server holds them together). */
export function defs(...ds: unknown[]): Def[] {
  return ds as Def[];
}

/**
 * A text block, then the image (text first reads better for click accuracy). Never an error result: Claude Code
 * passes only the text of an MCP error on (`McpToolCallError`), so the image of one would never reach the model.
 */
export function imageResult(text: string, shot: Screenshot): CallToolResult {
  return {
    content: [
      { type: 'text', text },
      { type: 'image', data: Buffer.from(shot.data).toString('base64'), mimeType: shot.mime },
    ],
  };
}

/**
 * The answer of a computer action that changes the screen (PC tools V2 D4): "OK" plus what changed; when it is the
 * last `pc` call of its batch (or the batch is unknown), the settled screen too, or one line when the screen is the
 * image the agent already has.
 *
 * `failed`: the action did not do what was asked (a `wait_for` that timed out). The computer actions after it in the
 * same message do not run (the trained halt), but the answer is no MCP error, so its screenshot reaches the agent
 * (Claude Code drops the images of an error result, and the next action would then claim an unseen screen unchanged).
 */
export async function finishAction(
  ctx: PcToolContext,
  seat: Seat,
  text: string,
  options: { forceImage?: boolean; failed?: boolean; windowNote?: boolean } = {},
): Promise<CallToolResult> {
  ctx.noteMutation(seat.pcId);
  if (options.failed) ctx.batch.fail(seat.toolUseId);
  const last = options.forceImage
    ? true
    : await ctx.batch.isLast(seat.toolUseId, ctx.settleTiming.batchWaitMs);
  if (last === false) return textResult(text);
  const { shot, unchanged } = await ctx.look(seat.pcId, { auto: !options.forceImage });
  const { note } = await ctx.windowChange(seat.pcId);
  const line = [text, options.windowNote === false ? '' : note].filter((s) => s.length > 0).join(' · ');
  if (unchanged || !shot) return textResult(`${line}\n${SCREEN_UNCHANGED}`);
  return imageResult(line, shot);
}
