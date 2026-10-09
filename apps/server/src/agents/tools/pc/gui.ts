/**
 * The computer tools (PC tools V2 §5.1, D1): the members of the trained computer-use toolset
 * (`computer_toolset_20260801`), one tool each, with the trained names and parameters (plus `ref`, an element from
 * `ui`). Coordinates are pixels of the screenshots the agent sees (D2). Several actions in one turn run in order and
 * stop at the first failure; the last one answers with the settled screen (D4).
 */

import { z } from 'zod';
import type { PointerAction } from '../../../contracts/PcApi.js';
import type { PcToolName } from '../catalog.js';
import { type CallToolResult, errorResult, textResult } from '../results.js';
import { type Def, defs, finishAction, imageResult, tool } from './common.js';
import { type PcToolContext, type Seat, windowLabel } from './context.js';
import { invalidZoom, OK, outOfBounds } from './formats.js';
import { checkPoint, regionToScreen, toImage, toScreen } from './geometry.js';
import { parseKeyText, parseModifiers } from './keys.js';
import { act, pickRef, pressable, refPoint } from './ui.js';

const XY = z.array(z.number().int().min(0)).length(2);
const MODS = z
  .string()
  .max(64)
  .describe(
    'Modifier keys to hold during the action: "shift", "ctrl", "alt", "super", or joined with + ("ctrl+shift")',
  );
const REF = z.string().max(16).describe('A ui element ref (ref_12) to act on instead of coordinate');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Point = { x: number; y: number };

/** A coordinate (image pixels) as screen pixels, or the out-of-bounds teaching error. */
async function screenPoint(
  ctx: PcToolContext,
  pcId: string,
  xy: readonly number[],
): Promise<Point | CallToolResult> {
  const g = await ctx.geometry(pcId);
  const p = checkPoint(g, xy);
  if (!p.ok) return errorResult(outOfBounds(p.x, p.y, g.imgW, g.imgH));
  return toScreen(g, p.x, p.y);
}

const isResult = (v: unknown): v is CallToolResult =>
  typeof v === 'object' && v !== null && Array.isArray((v as { content?: unknown }).content);

type ClickKind = 'left' | 'right' | 'middle' | 'double' | 'triple';

const CLICK_TOOL: Record<ClickKind, PcToolName> = {
  left: 'left_click',
  right: 'right_click',
  middle: 'middle_click',
  double: 'double_click',
  triple: 'triple_click',
};

async function click(
  ctx: PcToolContext,
  seat: Seat,
  kind: ClickKind,
  args: { coordinate?: number[] | undefined; text?: string | undefined; ref?: string | undefined },
): Promise<CallToolResult> {
  const mods = parseModifiers(args.text);
  if (!mods.ok) return errorResult(mods.error);
  const modifiers = mods.chords[0] ?? [];
  let at: Point | undefined;
  let what = '';
  if (args.ref !== undefined) {
    const r = pickRef(ctx, seat.pcId, args.ref);
    if (!r.ok) return r.error;
    const label = `${r.entry.role}${r.entry.name ? ` "${r.entry.name}"` : ''}`;
    if (kind === 'left' && modifiers.length === 0 && pressable(r.entry)) {
      const failed = await act(ctx, seat, r.entry, 'press');
      if (failed) return failed;
      return finishAction(ctx, seat, `pressed ${label} (accessibility)`);
    }
    const p = await refPoint(ctx, seat, r.entry);
    if (isResult(p)) return p;
    at = p;
    what = ` ${label}`;
  } else if (args.coordinate !== undefined) {
    const p = await screenPoint(ctx, seat.pcId, args.coordinate);
    if (isResult(p)) return p;
    at = p;
  }
  const action: PointerAction =
    kind === 'right'
      ? { action: 'right_click', ...(at ?? {}), ...(modifiers.length ? { modifiers } : {}) }
      : kind === 'double'
        ? { action: 'double_click', ...(at ?? {}), ...(modifiers.length ? { modifiers } : {}) }
        : {
            action: 'click',
            ...(at ?? {}),
            button: kind === 'middle' ? 'middle' : 'left',
            ...(kind === 'triple' ? { count: 3 } : {}),
            ...(modifiers.length ? { modifiers } : {}),
          };
  await ctx.host.pcs.pointer(seat.pcId, action);
  return finishAction(ctx, seat, what ? `${OK}: clicked${what}` : OK);
}

export function guiTools(ctx: PcToolContext): Def[] {
  const clickTool = (kind: ClickKind, description: string, described: boolean) =>
    tool(
      CLICK_TOOL[kind],
      description,
      described
        ? {
            coordinate: XY.optional().describe(
              '[x, y] in pixels of the latest screenshot; omit to click at the cursor',
            ),
            text: MODS.optional(),
            ref: REF.optional(),
          }
        : {
            coordinate: XY.optional(),
            text: z.string().max(64).optional(),
            ref: z.string().max(16).optional(),
          },
      (args, extra) =>
        ctx.run(CLICK_TOOL[kind], extra, (seat) => click(ctx, seat, kind, args), { gui: true }),
    );

  return defs(
    tool(
      'screenshot',
      'Take a screenshot of the PC screen. Coordinates in every tool are pixels of this image, origin top-left.',
      {},
      (_args, extra) =>
        ctx.run(
          'screenshot',
          extra,
          async (seat) => {
            const { shot } = await ctx.look(seat.pcId, { auto: false });
            const { windows } = await ctx.windowChange(seat.pcId);
            const focused = windows.find((w) => w.focused);
            if (!shot) return errorResult('No screenshot.');
            return imageResult(
              `${shot.w}x${shot.h}${focused ? ` · focused: "${windowLabel(focused)}"` : ''}`,
              shot,
            );
          },
          { gui: true },
        ),
      { annotations: { readOnlyHint: true } },
    ),
    tool(
      'zoom',
      'See a region of the screen enlarged, for small text and dense UI. region is [x0, y0, x1, y1] in screenshot pixels; coordinates stay in full-screenshot space afterwards.',
      { region: z.array(z.number().int().min(0)).length(4) },
      (args, extra) =>
        ctx.run(
          'zoom',
          extra,
          async (seat) => {
            const g = await ctx.geometry(seat.pcId);
            const rect = regionToScreen(g, args.region);
            if (!rect) return errorResult(invalidZoom(g.imgW, g.imgH));
            await ctx.settle(seat.pcId);
            const shot = await ctx.host.pcs.screenshot(seat.pcId, {
              region: rect,
              fit: { w: g.imgW, h: g.imgH },
              quality: 85,
            });
            const [x0, y0, x1, y1] = args.region;
            const factor = shot.w / Math.max(1, (x1 ?? 0) - (x0 ?? 0));
            return imageResult(
              `[${x0}, ${y0}, ${x1}, ${y1}] at ${factor >= 1.05 ? `${factor.toFixed(1)}x` : 'full size'} (${shot.w}x${shot.h})`,
              shot,
            );
          },
          { gui: true },
        ),
      { annotations: { readOnlyHint: true } },
    ),
    clickTool(
      'left',
      'Click the left mouse button at coordinate [x, y] (pixels of the latest screenshot), or at the cursor when omitted. With ref, a button, link, menu item, check box or tab is pressed through the accessibility tree.',
      true,
    ),
    clickTool('right', 'Click the right mouse button at coordinate (or ref, or the cursor).', false),
    clickTool('middle', 'Click the middle mouse button at coordinate (or ref, or the cursor).', false),
    clickTool('double', 'Double-click the left mouse button at coordinate (or ref, or the cursor).', false),
    clickTool(
      'triple',
      'Triple-click the left mouse button at coordinate (selects a line or paragraph).',
      false,
    ),
    tool(
      'left_click_drag',
      'Press the left button at start_coordinate, drag to coordinate, release.',
      { start_coordinate: XY, coordinate: XY, text: MODS.optional() },
      (args, extra) =>
        ctx.run(
          'left_click_drag',
          extra,
          async (seat) => {
            const mods = parseModifiers(args.text);
            if (!mods.ok) return errorResult(mods.error);
            const from = await screenPoint(ctx, seat.pcId, args.start_coordinate);
            if (isResult(from)) return from;
            const to = await screenPoint(ctx, seat.pcId, args.coordinate);
            if (isResult(to)) return to;
            const modifiers = mods.chords[0] ?? [];
            await ctx.host.pcs.pointer(seat.pcId, {
              action: 'drag',
              x: from.x,
              y: from.y,
              toX: to.x,
              toY: to.y,
              ...(modifiers.length ? { modifiers } : {}),
            });
            return finishAction(ctx, seat, OK);
          },
          { gui: true },
        ),
    ),
    tool(
      'mouse_move',
      'Move the mouse to coordinate (or to ref) without clicking (hover).',
      { coordinate: XY.optional(), ref: REF.optional() },
      (args, extra) =>
        ctx.run(
          'mouse_move',
          extra,
          async (seat) => {
            let at: Point;
            if (args.ref !== undefined) {
              const r = pickRef(ctx, seat.pcId, args.ref);
              if (!r.ok) return r.error;
              const p = await refPoint(ctx, seat, r.entry);
              if (isResult(p)) return p;
              at = p;
            } else if (args.coordinate !== undefined) {
              const p = await screenPoint(ctx, seat.pcId, args.coordinate);
              if (isResult(p)) return p;
              at = p;
            } else return errorResult('mouse_move needs coordinate or ref.');
            await ctx.host.pcs.pointer(seat.pcId, { action: 'move', ...at });
            return finishAction(ctx, seat, OK);
          },
          { gui: true },
        ),
    ),
    tool(
      'left_mouse_down',
      'Press and hold the left mouse button at the cursor (move with mouse_move, release with left_mouse_up).',
      {},
      (_args, extra) =>
        ctx.run(
          'left_mouse_down',
          extra,
          async (seat) => {
            await ctx.host.pcs.pointer(seat.pcId, { action: 'down', button: 'left' });
            return finishAction(ctx, seat, OK);
          },
          { gui: true },
        ),
    ),
    tool('left_mouse_up', 'Release the left mouse button at the cursor.', {}, (_args, extra) =>
      ctx.run(
        'left_mouse_up',
        extra,
        async (seat) => {
          await ctx.host.pcs.pointer(seat.pcId, { action: 'up', button: 'left' });
          return finishAction(ctx, seat, OK);
        },
        { gui: true },
      ),
    ),
    tool(
      'cursor_position',
      'Report the cursor position in screenshot pixels.',
      {},
      (_args, extra) =>
        ctx.run(
          'cursor_position',
          extra,
          async (seat) => {
            const g = await ctx.geometry(seat.pcId);
            const c = await ctx.host.pcs.cursor(seat.pcId);
            const p = toImage(g, c.x, c.y);
            return textResult(`X=${p.x}, Y=${p.y}`);
          },
          { gui: true },
        ),
      { annotations: { readOnlyHint: true } },
    ),
    tool(
      'scroll',
      'Scroll the mouse wheel scroll_amount clicks in scroll_direction at coordinate (or at the cursor).',
      {
        scroll_direction: z.enum(['up', 'down', 'left', 'right']),
        scroll_amount: z.number().int().min(1).max(50),
        coordinate: XY.optional(),
        text: MODS.optional(),
      },
      (args, extra) =>
        ctx.run(
          'scroll',
          extra,
          async (seat) => {
            const mods = parseModifiers(args.text);
            if (!mods.ok) return errorResult(mods.error);
            let at: Point | undefined;
            if (args.coordinate !== undefined) {
              const p = await screenPoint(ctx, seat.pcId, args.coordinate);
              if (isResult(p)) return p;
              at = p;
            }
            const n = args.scroll_amount;
            const dx = args.scroll_direction === 'left' ? -n : args.scroll_direction === 'right' ? n : 0;
            const dy = args.scroll_direction === 'up' ? -n : args.scroll_direction === 'down' ? n : 0;
            const modifiers = mods.chords[0] ?? [];
            await ctx.host.pcs.pointer(seat.pcId, {
              action: 'scroll',
              ...(at ?? {}),
              dx,
              dy,
              ...(modifiers.length ? { modifiers } : {}),
            });
            return finishAction(ctx, seat, OK);
          },
          { gui: true },
        ),
    ),
    tool(
      'type',
      'Type literal text at the keyboard focus ("\\n" presses Enter). To put more than a few lines into a file, use write.',
      { text: z.string().min(1).max(16_384) },
      (args, extra) =>
        ctx.run(
          'type',
          extra,
          async (seat) => {
            await ctx.host.pcs.type(seat.pcId, args.text);
            return finishAction(ctx, seat, OK);
          },
          { gui: true },
        ),
    ),
    tool(
      'key',
      'Press a key or combination, xdotool names joined by +: "Return", "Escape", "ctrl+s", "alt+Tab", "ctrl+shift+t", "Page_Down", "super". Separate with spaces to press several in order ("ctrl+a Delete").',
      { text: z.string().min(1).max(200), repeat: z.number().int().min(1).max(100).optional() },
      (args, extra) =>
        ctx.run(
          'key',
          extra,
          async (seat) => {
            const parsed = parseKeyText(args.text);
            if (!parsed.ok) return errorResult(parsed.error);
            const repeat = args.repeat ?? 1;
            if (parsed.chords.length === 1) {
              await ctx.host.pcs.keyboard(seat.pcId, {
                action: 'press',
                keys: parsed.chords[0] as string[],
                ...(repeat > 1 ? { repeat } : {}),
              });
            } else {
              await ctx.host.pcs.keyboard(seat.pcId, {
                action: 'sequence',
                chords: parsed.chords,
                ...(repeat > 1 ? { repeat } : {}),
              });
            }
            return finishAction(ctx, seat, OK);
          },
          { gui: true },
        ),
    ),
    tool(
      'hold_key',
      'Hold a key or combination down for duration seconds, then release it.',
      { text: z.string().min(1).max(64), duration: z.number().min(0).max(300) },
      (args, extra) =>
        ctx.run(
          'hold_key',
          extra,
          async (seat) => {
            const parsed = parseKeyText(args.text);
            if (!parsed.ok) return errorResult(parsed.error);
            if (parsed.chords.length !== 1)
              return errorResult('hold_key takes one key or combination ("shift", "ctrl+alt").');
            await ctx.host.pcs.keyboard(seat.pcId, {
              action: 'hold',
              keys: parsed.chords[0] as string[],
              ms: Math.round(args.duration * 1000),
            });
            return finishAction(ctx, seat, OK);
          },
          { gui: true },
        ),
    ),
    tool(
      'wait',
      'Pause for duration seconds. Prefer wait_for when you know what you are waiting for.',
      { duration: z.number().min(0).max(300) },
      (args, extra) =>
        ctx.run(
          'wait',
          extra,
          async (seat) => {
            await sleep(Math.round(args.duration * 1000));
            return finishAction(ctx, seat, OK);
          },
          { gui: true },
        ),
    ),
  );
}
