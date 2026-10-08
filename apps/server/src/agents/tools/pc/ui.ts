/**
 * `ui` and `ui_act` (PC tools V2 §5.2, D3): the PC's apps read and driven through the accessibility tree (spacesd's
 * AccessibilityService and WindowsService). Exact text and clickable elements cost a fraction of a screenshot's
 * tokens; elements come as `ref_N` with role, name and centre @(x,y) in screenshot pixels, usable as `ref` in the
 * click tools or in `ui_act`.
 */

import { z } from 'zod';
import { isApiError } from '../../../contracts/common.js';
import {
  type GuestWindow,
  PC_ERROR_CODES,
  type Rect,
  type UiAction,
  type UiNode,
  type UiSnapshot,
} from '../../../contracts/PcApi.js';
import { type CallToolResult, errorResult, textResult } from '../results.js';
import { type Def, defs, finishAction, tool } from './common.js';
import { isMirror, type PcToolContext, type Seat, windowLabel } from './context.js';
import { a11yEmpty, staleRef, unknownRef, windowNotFound } from './formats.js';
import { centreOf, type ScreenGeometry } from './geometry.js';
import type { RefEntry } from './refs.js';

// ------------------------------------------------------------------------------------------------- roles

const norm = (s: string | undefined) => (s ?? '').toLowerCase().replace(/[\s_-]+/g, ' ').trim();

/** Role names people and models use, grouped with the toolkits' (spacesd's normalized and native) names. */
const ROLE_GROUPS: readonly (readonly string[])[] = [
  ['button', 'push button', 'pushbutton', 'toggle button'],
  [
    'text field',
    'entry',
    'text',
    'textbox',
    'text box',
    'input',
    'edit',
    'editable text',
    'search field',
    'search',
    'password text',
    'password',
    'text area',
    'textarea',
  ],
  ['menu item', 'menuitem', 'check menu item', 'radio menu item'],
  ['check box', 'checkbox', 'check'],
  ['radio button', 'radio'],
  ['link', 'hyperlink', 'anchor'],
  ['tab', 'page tab'],
  ['combo box', 'combobox', 'dropdown', 'drop down', 'select'],
  ['list item', 'listitem', 'option'],
  ['label', 'static text', 'static'],
  ['heading', 'header'],
  ['menu', 'submenu'],
  ['slider', 'scale'],
  ['spin button', 'spinbutton', 'spinner'],
];

/** Whether a node has the role a query names (case, `_`, `-` and spaces ignored; synonyms included). */
export function roleMatches(node: UiNode, want: string): boolean {
  const w = norm(want);
  if (w.length === 0) return true;
  const group = ROLE_GROUPS.find((g) => g.includes(w)) ?? [w];
  return group.includes(norm(node.role)) || group.includes(norm(node.nativeRole));
}

/** Roles a left click on a ref presses through the accessibility tree instead of the mouse. */
const PRESSABLE = new Set([
  'button',
  'toggle button',
  'push button',
  'link',
  'menu',
  'menu item',
  'check box',
  'radio button',
  'tab',
  'page tab',
]);

export function pressable(entry: Pick<RefEntry, 'role' | 'actions'>): boolean {
  return entry.actions.includes('press') && PRESSABLE.has(norm(entry.role));
}

const INTERACTIVE_ROLES = new Set([
  'button',
  'toggle button',
  'text field',
  'combo box',
  'check box',
  'radio button',
  'slider',
  'spin button',
  'link',
  'menu',
  'menu item',
  'tab',
  'page tab',
  'list item',
  'terminal',
]);

function interactive(n: UiNode): boolean {
  return (
    n.actions.length > 0 ||
    n.states.includes('editable') ||
    n.states.includes('focusable') ||
    INTERACTIVE_ROLES.has(norm(n.role))
  );
}

const OFFSCREEN_RE = /off-screen/i;

function offscreen(n: UiNode): boolean {
  return n.bounds === undefined || OFFSCREEN_RE.test(n.description ?? '');
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const quote = (s: string, n = 80) => `"${clip(s.replace(/\s+/g, ' '), n).replace(/"/g, '\\"')}"`;

/** Notable states, as words. */
function stateWords(n: UiNode): string[] {
  const out: string[] = [];
  if (!n.states.includes('enabled') && n.states.length > 0) out.push('disabled');
  for (const s of ['focused', 'selected', 'checked', 'pressed', 'expanded', 'collapsed']) {
    if (n.states.includes(s)) out.push(s);
  }
  return out;
}

/** One element line: `ref_4 button "Save" @(1180,38) focused`. */
export function nodeLine(ref: string, n: UiNode, g: ScreenGeometry): string {
  const parts = [ref, n.role.replace(/_/g, ' ')];
  if (n.name) parts.push(quote(n.name));
  if (n.value && n.value !== n.name) parts.push(`= ${quote(n.value)}`);
  if (!offscreen(n) && n.bounds) {
    const c = centreOf(g, n.bounds);
    parts.push(`@(${c.x},${c.y})`);
  } else parts.push('off-screen');
  parts.push(...stateWords(n));
  const d = (n.description ?? '').replace(/;?\s*off-screen:.*$/i, '').trim();
  if (d && d !== n.name && d !== n.value) parts.push(`(${clip(d, 60)})`);
  return parts.join(' ');
}

// ------------------------------------------------------------------------------------------------- windows

export type WindowPick = { ok: true; window: GuestWindow; all: readonly GuestWindow[] } | { ok: false; error: CallToolResult };

/** A window by id, title substring or app name (case-insensitive), front first; default the focused one. */
export async function pickWindow(ctx: PcToolContext, pcId: string, query: string | undefined): Promise<WindowPick> {
  const all = await ctx.host.pcs.windows(pcId);
  if (query === undefined || query.trim() === '') {
    const w = all.find((x) => x.focused) ?? all[0];
    if (!w) return { ok: false, error: errorResult('There is no window on the screen.') };
    return { ok: true, window: w, all };
  }
  const q = query.trim().toLowerCase();
  const w =
    all.find((x) => x.id === query.trim()) ??
    all.find((x) => x.title.toLowerCase() === q) ??
    all.find((x) => x.title.toLowerCase().includes(q)) ??
    all.find((x) => x.app.toLowerCase().includes(q));
  if (!w) return { ok: false, error: errorResult(windowNotFound(query, all.map(windowLabel))) };
  return { ok: true, window: w, all };
}

// ------------------------------------------------------------------------------------------------- refs

export type RefPick = { ok: true; entry: RefEntry } | { ok: false; error: CallToolResult };

export function pickRef(ctx: PcToolContext, pcId: string, ref: string): RefPick {
  const entry = ctx.refs.get(ref);
  if (!entry || entry.pcId !== pcId) {
    return { ok: false, error: errorResult(ctx.refs.issued(ref) ? staleRef(ref.trim(), 'its window') : unknownRef(ref.trim())) };
  }
  return { ok: true, entry };
}

function remember(ctx: PcToolContext, pcId: string, snap: UiSnapshot, n: UiNode, w: GuestWindow): RefEntry {
  return ctx.refs.add({
    pcId,
    snapshotId: snap.snapshotId,
    elementId: n.elementId,
    windowId: snap.windowId ?? w.id,
    windowTitle: windowLabel(w),
    role: n.role.replace(/_/g, ' '),
    ...(n.name ? { name: n.name } : {}),
    ...(n.bounds && !offscreen(n) ? { bounds: n.bounds } : {}),
    actions: n.actions,
    states: n.states,
  });
}

/** Runs an element action; an expired snapshot is the stale-ref teaching error. */
export async function act(
  ctx: PcToolContext,
  seat: Seat,
  entry: RefEntry,
  action: UiAction,
  value?: string,
): Promise<CallToolResult | null> {
  try {
    await ctx.host.pcs.uiAct(seat.pcId, {
      snapshotId: entry.snapshotId,
      elementId: entry.elementId,
      action,
      ...(value !== undefined ? { value } : {}),
    });
    return null;
  } catch (err) {
    if (isApiError(err, PC_ERROR_CODES.STALE_REF) || isApiError(err, PC_ERROR_CODES.WINDOW_NOT_FOUND)) {
      return errorResult(staleRef(entry.ref, entry.windowTitle));
    }
    throw err;
  }
}

/**
 * Where a ref is on screen (screen pixels): its box's centre, or, for an element out of view, scrolled into view and
 * found again by role and name.
 */
export async function refPoint(
  ctx: PcToolContext,
  seat: Seat,
  entry: RefEntry,
): Promise<{ x: number; y: number } | CallToolResult> {
  const centre = (b: Rect) => ({ x: Math.round(b.x + b.w / 2), y: Math.round(b.y + b.h / 2) });
  if (entry.bounds) return centre(entry.bounds);
  const failed = await act(ctx, seat, entry, 'scroll_into_view').catch(() => null);
  if (failed) return failed;
  if (entry.name) {
    const snap = await ctx.host.pcs
      .uiFind(seat.pcId, {
        ...(entry.windowId ? { windowId: entry.windowId } : {}),
        nameContains: entry.name,
        maxResults: 20,
      })
      .catch(() => null);
    const n = snap?.nodes.find((x) => norm(x.role) === norm(entry.role) && x.bounds && !offscreen(x));
    if (n?.bounds) return centre(n.bounds);
  }
  return errorResult(
    `${entry.ref} has no place on the screen (hidden or scrolled away). Use ui_act on it, or scroll and ui find again.`,
  );
}

// ------------------------------------------------------------------------------------------------- ui

const DEFAULT_FIND = 25;
const MAX_FIND = 100;

interface Hit {
  readonly n: UiNode;
  readonly snap: UiSnapshot;
  readonly w: GuestWindow;
}

async function findIn(
  ctx: PcToolContext,
  pcId: string,
  w: GuestWindow,
  query: string | undefined,
  role: string | undefined,
): Promise<Hit[]> {
  const snaps: UiSnapshot[] = [];
  if (query) {
    snaps.push(await ctx.host.pcs.uiFind(pcId, { windowId: w.id, nameContains: query, maxResults: MAX_FIND }));
    snaps.push(await ctx.host.pcs.uiFind(pcId, { windowId: w.id, valueContains: query, maxResults: MAX_FIND }));
  } else {
    snaps.push(await ctx.host.pcs.uiTree(pcId, { windowId: w.id, maxNodes: 1_500 }));
  }
  const seen = new Set<string>();
  const hits: Hit[] = [];
  for (const snap of snaps) {
    for (const n of snap.nodes) {
      if (role && !roleMatches(n, role)) continue;
      const key = `${n.role}|${n.name ?? ''}|${n.value ?? ''}|${n.bounds ? `${n.bounds.x},${n.bounds.y}` : n.elementId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      hits.push({ n, snap, w });
    }
  }
  return hits;
}

async function uiFind(
  ctx: PcToolContext,
  seat: Seat,
  args: { query?: string | undefined; role?: string | undefined; window?: string | undefined; max?: number },
): Promise<CallToolResult> {
  if (!args.query && !args.role) return errorResult('ui find needs query (text) and/or role.');
  const g = await ctx.geometry(seat.pcId);
  let windows: readonly GuestWindow[];
  if (args.window) {
    const p = await pickWindow(ctx, seat.pcId, args.window);
    if (!p.ok) return p.error;
    windows = [p.window];
  } else {
    const all = await ctx.host.pcs.windows(seat.pcId);
    windows = [...all.filter((w) => w.onScreen && !isMirror(w)), ...all.filter((w) => w.onScreen && isMirror(w))];
  }
  const max = Math.max(1, Math.min(MAX_FIND, args.max ?? DEFAULT_FIND));
  const groups: { w: GuestWindow; lines: string[] }[] = [];
  let shown = 0;
  let more = 0;
  for (const w of windows) {
    let hits: Hit[];
    try {
      hits = await findIn(ctx, seat.pcId, w, args.query, args.role);
    } catch (err) {
      if (isApiError(err, PC_ERROR_CODES.WINDOW_NOT_FOUND)) continue;
      throw err;
    }
    if (hits.length === 0) continue;
    // On-screen elements first.
    hits.sort((a, b) => Number(offscreen(a.n)) - Number(offscreen(b.n)));
    const lines: string[] = [];
    for (const h of hits) {
      if (shown >= max) {
        more++;
        continue;
      }
      const entry = remember(ctx, seat.pcId, h.snap, h.n, w);
      lines.push(nodeLine(entry.ref, h.n, g));
      shown++;
    }
    if (lines.length > 0) groups.push({ w, lines });
  }
  const what = [args.query ? quote(args.query, 60) : null, args.role ? `role ${args.role}` : null]
    .filter(Boolean)
    .join(', ');
  if (shown === 0) {
    return textResult(
      `No element matches ${what} in ${args.window ? quote(windowLabel(windows[0] as GuestWindow)) : 'the open windows'}. Try another word, ui tree, or a screenshot (some apps expose no accessibility tree).`,
    );
  }
  const out = groups.map(
    (gr) => `${gr.lines.length} ${gr.lines.length === 1 ? 'match' : 'matches'} in ${quote(windowLabel(gr.w))}:\n${gr.lines.join('\n')}`,
  );
  if (more > 0) out.push(`(… ${more} more; narrow with window or role)`);
  return textResult(out.join('\n'));
}

/** The nodes of `ref`'s element and its descendants in a fresh snapshot (found again by role and name). */
function subtree(nodes: readonly UiNode[], entry: RefEntry): UiNode[] | null {
  const i = nodes.findIndex(
    (n) =>
      norm(n.role) === norm(entry.role) &&
      (n.name ?? '') === (entry.name ?? '') &&
      (!entry.bounds || !n.bounds || (Math.abs(n.bounds.x - entry.bounds.x) < 40 && Math.abs(n.bounds.y - entry.bounds.y) < 40)),
  );
  if (i < 0) return null;
  const root = nodes[i] as UiNode;
  const out = [root];
  for (const n of nodes.slice(i + 1)) {
    if (n.depth <= root.depth) break;
    out.push(n);
  }
  return out;
}

async function treeOf(
  ctx: PcToolContext,
  seat: Seat,
  args: { window?: string | undefined; ref?: string | undefined },
): Promise<{ ok: true; w: GuestWindow; snap: UiSnapshot; nodes: UiNode[] } | { ok: false; error: CallToolResult }> {
  let entry: RefEntry | undefined;
  let w: GuestWindow;
  if (args.ref) {
    const r = pickRef(ctx, seat.pcId, args.ref);
    if (!r.ok) return r;
    entry = r.entry;
    const all = await ctx.host.pcs.windows(seat.pcId);
    const found = all.find((x) => x.id === r.entry.windowId);
    if (!found) return { ok: false, error: errorResult(staleRef(r.entry.ref, r.entry.windowTitle)) };
    w = found;
  } else {
    const p = await pickWindow(ctx, seat.pcId, args.window);
    if (!p.ok) return p;
    w = p.window;
  }
  const snap = await ctx.host.pcs.uiTree(seat.pcId, { windowId: w.id, maxNodes: 1_500, maxDepth: 40 });
  if (snap.nodes.length <= 1) {
    const why = /chrom/i.test(`${w.app} ${w.title}`)
      ? 'Chromium starts without one; open pages with open, which uses Firefox'
      : 'the app exposes no accessible elements';
    return { ok: false, error: errorResult(a11yEmpty(windowLabel(w), why)) };
  }
  let nodes = [...snap.nodes];
  if (entry) {
    const sub = subtree(nodes, entry);
    if (!sub) return { ok: false, error: errorResult(staleRef(entry.ref, entry.windowTitle)) };
    nodes = sub;
  }
  return { ok: true, w, snap, nodes };
}

async function uiTree(
  ctx: PcToolContext,
  seat: Seat,
  args: { window?: string | undefined; ref?: string | undefined; filter?: 'interactive' | 'all' | undefined; maxChars?: number | undefined },
): Promise<CallToolResult> {
  const t = await treeOf(ctx, seat, args);
  if (!t.ok) return t.error;
  const g = await ctx.geometry(seat.pcId);
  const all = args.filter === 'all';
  const kept = t.nodes.filter((n) => (all ? Boolean(n.name || n.value || n.actions.length > 0) : interactive(n)));
  const minDepth = kept.length > 0 ? Math.min(...kept.map((n) => n.depth)) : 0;
  const max = Math.max(500, Math.min(30_000, args.maxChars ?? 6_000));
  const head = `window ${quote(windowLabel(t.w))}${t.w.focused ? ' focused' : ''}`;
  const lines: string[] = [head];
  let size = head.length;
  let cut = 0;
  for (const n of kept) {
    if (size > max) {
      cut++;
      continue;
    }
    const entry = remember(ctx, seat.pcId, t.snap, n, t.w);
    const line = `${' '.repeat(n.depth - minDepth + 1)}${nodeLine(entry.ref, n, g)}`;
    lines.push(line);
    size += line.length + 1;
  }
  if (cut > 0) lines.push(`(… ${cut} more nodes; narrow with window/ref or use find)`);
  if (kept.length === 0) lines.push(' (no interactive elements; try filter "all" or ui text)');
  return textResult(lines.join('\n'));
}

const STRUCTURAL = new Set(['window', 'tool bar', 'menu bar', 'scroll bar', 'split pane', 'panel', 'filler', 'scroll pane', 'internal frame', 'section', 'landmark', 'page tab list']);

async function uiText(
  ctx: PcToolContext,
  seat: Seat,
  args: { window?: string | undefined; ref?: string | undefined; maxChars?: number | undefined },
): Promise<CallToolResult> {
  const t = await treeOf(ctx, seat, args);
  if (!t.ok) return t.error;
  const max = Math.max(500, Math.min(30_000, args.maxChars ?? 12_000));
  const out: string[] = [];
  let last = '';
  let size = 0;
  let terminal = false;
  for (const n of t.nodes) {
    const role = norm(n.role);
    if (role === 'terminal') terminal = true;
    if (STRUCTURAL.has(role)) continue;
    const text = role === 'text field' || role === 'combo box' ? n.value : (n.value ?? n.name);
    if (!text || text === last) continue;
    const line = role === 'text field' || role === 'combo box' ? `[${n.name ?? role}: ${text}]` : text;
    last = text;
    if (size + line.length > max) {
      out.push('(… cut; narrow with ref or raise max_chars)');
      break;
    }
    out.push(line);
    size += line.length + 1;
  }
  if (terminal) out.push('(A terminal does not expose its text: run commands with bash, or zoom into it.)');
  if (out.length === 0) return textResult(`${quote(windowLabel(t.w))} shows no text through its accessibility tree. Use zoom.`);
  return textResult(out.join('\n'));
}

async function uiWindows(ctx: PcToolContext, seat: Seat): Promise<CallToolResult> {
  const g = await ctx.geometry(seat.pcId);
  const all = await ctx.host.pcs.windows(seat.pcId);
  ctx.knowWindows(seat.pcId, all);
  if (all.length === 0) return textResult('No windows are open.');
  return textResult(
    `${all.length} ${all.length === 1 ? 'window' : 'windows'} (front first):\n${all.map((w) => ctx.describeWindow(w, g)).join('\n')}`,
  );
}

// ------------------------------------------------------------------------------------------------- ui_act

const ELEMENT_OPS = [
  'press',
  'focus',
  'set_value',
  'toggle',
  'select',
  'expand',
  'collapse',
  'increment',
  'decrement',
  'scroll_into_view',
  'show_menu',
] as const;
const WINDOW_OPS = ['activate', 'maximize', 'minimize', 'restore', 'close'] as const;

const PAST: Record<string, string> = {
  press: 'pressed',
  focus: 'focused',
  set_value: 'set',
  toggle: 'toggled',
  select: 'selected',
  expand: 'expanded',
  collapse: 'collapsed',
  increment: 'incremented',
  decrement: 'decremented',
  scroll_into_view: 'scrolled to',
  show_menu: 'opened the menu of',
  activate: 'activated',
  maximize: 'maximized',
  minimize: 'minimized',
  restore: 'restored',
  close: 'closed',
};

async function uiAct(
  ctx: PcToolContext,
  seat: Seat,
  args: { op: string; ref?: string | undefined; window?: string | undefined; value?: string | undefined },
): Promise<CallToolResult> {
  if ((WINDOW_OPS as readonly string[]).includes(args.op)) {
    if (!args.window && !args.ref) return errorResult(`ui_act ${args.op} needs window (a title or part of it).`);
    let target: GuestWindow;
    if (args.window) {
      const p = await pickWindow(ctx, seat.pcId, args.window);
      if (!p.ok) return p.error;
      target = p.window;
    } else {
      const r = pickRef(ctx, seat.pcId, args.ref as string);
      if (!r.ok) return r.error;
      const found = (await ctx.host.pcs.windows(seat.pcId)).find((w) => w.id === r.entry.windowId);
      if (!found) return errorResult(staleRef(r.entry.ref, r.entry.windowTitle));
      target = found;
    }
    if (args.op === 'close' && isMirror(target)) {
      return errorResult(`${quote(windowLabel(target))} is MineVibe's shell mirror (the player watches your commands there); leave it open.`);
    }
    await ctx.host.pcs.window(seat.pcId, target.id, args.op as (typeof WINDOW_OPS)[number]);
    if (args.op === 'close') ctx.refs.dropWindow(target.id);
    return finishAction(ctx, seat, `${PAST[args.op]} ${quote(windowLabel(target))}`);
  }
  if (!(ELEMENT_OPS as readonly string[]).includes(args.op)) return errorResult(`Unknown op ${args.op}.`);
  if (!args.ref) return errorResult(`ui_act ${args.op} needs ref (from ui find or ui tree).`);
  const r = pickRef(ctx, seat.pcId, args.ref);
  if (!r.ok) return r.error;
  const entry = r.entry;
  if (args.op === 'set_value' && args.value === undefined) return errorResult('set_value needs value.');
  const action: UiAction = args.op === 'toggle' ? 'press' : (args.op as UiAction);
  const label = `${entry.role}${entry.name ? ` ${quote(entry.name)}` : ''}`;
  try {
    const failed = await act(ctx, seat, entry, action, args.op === 'set_value' ? args.value : undefined);
    if (failed) return failed;
  } catch (err) {
    if (args.op !== 'set_value' || !isApiError(err) || !entry.bounds) throw err;
    // An editable that refuses SET_VALUE: click into it, select all, type.
    const c = { x: Math.round(entry.bounds.x + entry.bounds.w / 2), y: Math.round(entry.bounds.y + entry.bounds.h / 2) };
    await ctx.host.pcs.pointer(seat.pcId, { action: 'click', x: c.x, y: c.y });
    await ctx.host.pcs.keyboard(seat.pcId, { action: 'press', keys: ['KEY_CONTROL', 'a'] });
    await ctx.host.pcs.type(seat.pcId, args.value ?? '');
    return finishAction(ctx, seat, `typed into ${label} (it refused a direct value)`);
  }
  const text = args.op === 'set_value' ? `set ${label} to ${quote(args.value ?? '', 60)}` : `${PAST[args.op]} ${label}`;
  return finishAction(ctx, seat, text);
}

// ------------------------------------------------------------------------------------------------- definitions

export function uiTools(ctx: PcToolContext): Def[] {
  return defs(
    tool(
      'ui',
      'Read the PC\'s apps through the accessibility tree: exact text and clickable elements for far fewer tokens than a screenshot. find: elements whose name or value contains query (and/or of role), in every window or in window. tree: the element tree of a window (default the focused one; filter "interactive" by default) or of ref. text: all text of a window or ref (pages, dialogs, editors). windows: the open windows. Elements come as ref_N with role, name and centre @(x,y) in screenshot pixels; use a ref as ref in left_click and friends, or in ui_act. Refs expire when their window changes: find again. Some apps (games, canvases, terminals\' text, Chromium) expose nothing: use screenshot and zoom.',
      {
        action: z.enum(['find', 'tree', 'text', 'windows']),
        query: z.string().max(200).optional().describe('find: text in the name or value (case-insensitive)'),
        role: z.string().max(40).optional().describe('find: role such as button, entry, menu item, link, check box, tab'),
        window: z
          .string()
          .max(200)
          .optional()
          .describe('Window title (or part of it); default the focused window (find: all windows)'),
        ref: z.string().max(16).optional().describe('tree/text: start at this element'),
        filter: z.enum(['interactive', 'all']).optional().describe('tree: interactive elements only (default) or all'),
        max_chars: z.number().int().min(500).max(30_000).optional(),
      },
      (args, extra) =>
        ctx.run('ui', extra, async (seat) => {
          switch (args.action) {
            case 'find':
              return uiFind(ctx, seat, { query: args.query, role: args.role, window: args.window });
            case 'tree':
              return uiTree(ctx, seat, {
                window: args.window,
                ref: args.ref,
                filter: args.filter,
                maxChars: args.max_chars,
              });
            case 'text':
              return uiText(ctx, seat, { window: args.window, ref: args.ref, maxChars: args.max_chars });
            case 'windows':
              return uiWindows(ctx, seat);
          }
        }),
      { annotations: { readOnlyHint: true } },
    ),
    tool(
      'ui_act',
      'Operate an accessibility element or a window without the mouse (works even when it is covered). On ref: press, focus, set_value (value replaces the field\'s text), toggle, select, expand, collapse, increment, decrement, scroll_into_view, show_menu. On window (title or part of it): activate, maximize, minimize, restore, close.',
      {
        op: z.enum([...ELEMENT_OPS, ...WINDOW_OPS]),
        ref: z.string().max(16).optional(),
        window: z.string().max(200).optional(),
        value: z.string().max(16_384).optional(),
      },
      (args, extra) => ctx.run('ui_act', extra, (seat) => uiAct(ctx, seat, args), { gui: true }),
    ),
  );
}
