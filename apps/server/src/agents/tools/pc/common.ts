import { type SdkMcpToolDefinition, tool } from '@anthropic-ai/claude-agent-sdk';
import type { Screenshot } from '../../../contracts/PcApi.js';
import type { CallToolResult } from '../results.js';
import { textResult } from '../results.js';
import type { PcToolContext, Seat } from './context.js';
import { SCREEN_UNCHANGED } from './formats.js';

// biome-ignore lint/suspicious/noExplicitAny: the server holds tools of many different input shapes
export type Def = SdkMcpToolDefinition<any>;

export { tool };

/** The definitions of a group of tools (each has its own input type; the server holds them together). */
export function defs(...ds: unknown[]): Def[] {
  return ds as Def[];
}

/** A text block, then the image (text first reads better for click accuracy). */
export function imageResult(text: string, shot: Screenshot, isError = false): CallToolResult {
  return {
    content: [
      { type: 'text', text },
      { type: 'image', data: Buffer.from(shot.data).toString('base64'), mimeType: shot.mime },
    ],
    ...(isError ? { isError: true } : {}),
  };
}

/**
 * The answer of a computer action that changes the screen (PC tools V2 D4): "OK" plus what changed; when it is the
 * last `pc` call of its batch (or the batch is unknown), the settled screen too, or one line when the screen is the
 * image the agent already has.
 */
export async function finishAction(
  ctx: PcToolContext,
  seat: Seat,
  text: string,
  options: { forceImage?: boolean; isError?: boolean; windowNote?: boolean } = {},
): Promise<CallToolResult> {
  ctx.noteMutation(seat.pcId);
  const last = options.forceImage
    ? true
    : await ctx.batch.isLast(seat.toolUseId, ctx.settleTiming.batchWaitMs);
  if (last === false) return options.isError ? { ...textResult(text), isError: true } : textResult(text);
  const { shot, unchanged } = await ctx.look(seat.pcId, { auto: !options.forceImage });
  const { note } = await ctx.windowChange(seat.pcId);
  const line = [text, options.windowNote === false ? '' : note].filter((s) => s.length > 0).join(' · ');
  if (unchanged || !shot) {
    const r = textResult(`${line}\n${SCREEN_UNCHANGED}`);
    return options.isError ? { ...r, isError: true } : r;
  }
  return imageResult(line, shot, options.isError === true);
}
