import type { SpacesdClientLike } from '@trycua/cua';
import { ApiError } from '../contracts/common.js';
import {
  type GuestWindow,
  PC_ERROR_CODES,
  type UiAction,
  type UiNode,
  type UiSnapshot,
} from '../contracts/PcApi.js';
import { DeadlineError, withDeadline } from './deadline.js';

/**
 * spacesd's JSON RPCs that `@trycua/cua` 0.4.1 has no typed method for, called through `callJson` (PC tools V2, S9
 * probe 2026-10-09 on spacesd 0.5.3, X11/XFCE). Request and response shapes were recorded from the live service:
 *
 * - `AccessibilityService/GetTree {window?:{id,epoch}, maxDepth, maxNodes, includeHidden}` and
 *   `Find {window?, query:{role, name, nameContains, valueContains, states}, maxResults}` answer
 *   `{snapshotId, window?, nodes:[{elementId, parentId?, depth, role, nativeRole, name?, value?, description?,
 *   bounds?{x,y,width,height}, states[], actions["ACCESSIBILITY_ACTION_PRESS", …]}]}` for the focused window by
 *   default. `Act {element:{snapshotId, elementId}, action, value?}`; an expired snapshot is `FailedPrecondition`.
 * - `WindowsService/ListWindows {filter?}` answers `{windows:[{ref:{id,epoch}, title, app:{name,appId,pid},
 *   bounds, state, kind, focused?, onScreen?, zOrder}]}`; `Activate/Maximize/Minimize/Restore/CloseWindow {window}`;
 *   a gone window is `NotFound`, a stale epoch `FailedPrecondition`.
 * - `ComputerService/GetCursorPosition {}` answers `{position:{x,y}, displayId}`; `Screenshot {region, format,
 *   quality, maxDimension, includeCursor}` answers `{image (base64), imageSize, …}`.
 *
 * Every call has a deadline; failures become {@link ApiError}s.
 */

const err = (code: string, message: string) => new ApiError(code, message);

/** Calls one JSON method under a deadline; returns the parsed answer. */
export async function rpc<T>(
  c: SpacesdClientLike,
  method: string,
  request: unknown,
  timeoutMs: number,
): Promise<T> {
  const full = method.startsWith('/') ? method : `/cua.env.v1.${method}`;
  let raw: string;
  try {
    raw = await withDeadline(timeoutMs, method, (signal) =>
      c.callJson(full, JSON.stringify(request ?? {}), { signal }),
    );
  } catch (e) {
    throw rpcError(method, e);
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw err(PC_ERROR_CODES.GUEST_ERROR, `${method} answered something that is not JSON`);
  }
}

/** spacesd's error for a call, as an ApiError with the closest PcApi code. */
export function rpcError(method: string, e: unknown): ApiError {
  if (e instanceof ApiError) return e;
  const msg = e instanceof Error ? e.message : String(e);
  if (e instanceof DeadlineError) return err(PC_ERROR_CODES.TIMEOUT, `${method} timed out`);
  if (/stale accessibility snapshot|unknown or expired snapshot|stale element|element is gone/i.test(msg))
    return err(PC_ERROR_CODES.STALE_REF, 'the accessibility snapshot expired (the window changed)');
  if (/stale window handle|window is gone|no such window|window not found/i.test(msg))
    return err(PC_ERROR_CODES.WINDOW_NOT_FOUND, 'the window is gone');
  if (/cannot launch|No such file or directory/i.test(msg))
    return err(PC_ERROR_CODES.OPEN_FAILED, cleanMsg(msg));
  if (/unimplemented|not supported|unsupported|no accessibility|a11y/i.test(msg))
    return err(PC_ERROR_CODES.A11Y_UNAVAILABLE, cleanMsg(msg));
  return err(PC_ERROR_CODES.GUEST_ERROR, `${method} failed: ${cleanMsg(msg)}`);
}

/** Drops the `CuaError.X: env: ` prefixes and the gRPC status suffix. */
function cleanMsg(msg: string): string {
  return msg
    .replace(/^(Error: )?CuaError\.\w+: /, '')
    .replace(/^(invalid argument|env): /, '')
    .replace(/ \((NotFound|FailedPrecondition|InvalidArgument|Unavailable|Internal)\)$/, '')
    .slice(0, 300);
}

interface RawRect {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}

const rect = (b: RawRect | undefined) =>
  b && typeof b.width === 'number' && typeof b.height === 'number'
    ? { x: Math.round(b.x ?? 0), y: Math.round(b.y ?? 0), w: Math.round(b.width), h: Math.round(b.height) }
    : undefined;

export interface RawWindow {
  ref?: { id?: string; epoch?: string };
  title?: string;
  app?: { name?: string; appId?: string; pid?: number };
  bounds?: RawRect;
  state?: string;
  kind?: string;
  focused?: boolean;
  onScreen?: boolean;
  zOrder?: number;
}

/** One `ListWindows` entry; null for an entry without an id. */
export function parseWindow(w: RawWindow): GuestWindow | null {
  const id = w.ref?.id;
  if (typeof id !== 'string' || id.length === 0) return null;
  const b = rect(w.bounds);
  return {
    id,
    title: typeof w.title === 'string' ? w.title : '',
    app: w.app?.name ?? w.app?.appId ?? '',
    ...(typeof w.app?.pid === 'number' ? { pid: w.app.pid } : {}),
    ...(b ? { bounds: b } : {}),
    focused: w.focused === true,
    ...(w.state ? { state: w.state.replace(/^WINDOW_STATE_/, '') } : {}),
    onScreen: w.onScreen !== false,
    ...(typeof w.zOrder === 'number' ? { z: w.zOrder } : {}),
  };
}

/** `ListWindows`' answer, front first (the focused window, then by z-order). */
export function parseWindows(answer: { windows?: RawWindow[] } | null | undefined): GuestWindow[] {
  const list = (answer?.windows ?? []).map(parseWindow).filter((w): w is GuestWindow => w !== null);
  return list.sort((a, b) => Number(b.focused) - Number(a.focused) || (a.z ?? 1e9) - (b.z ?? 1e9));
}

interface RawNode {
  elementId?: string;
  parentId?: string;
  depth?: number;
  role?: string;
  nativeRole?: string;
  name?: string;
  value?: string;
  description?: string;
  bounds?: RawRect;
  states?: string[];
  actions?: string[];
}

/** U+FFFC (an embedded object's placeholder) and other invisible padding the toolkits put into text. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this strips
const JUNK_RE = /[￼​\u0000-\u0008\u000B-\u001F\u007F]/g;

/** Text of an accessible name or value, without placeholders; undefined when nothing is left. */
export function cleanText(s: string | undefined): string | undefined {
  if (typeof s !== 'string') return undefined;
  const t = s.replace(JUNK_RE, '').trim();
  return t.length > 0 ? t : undefined;
}

/** `ACCESSIBILITY_ACTION_SET_VALUE` → `set_value`. */
export function actionName(a: string): string {
  return a.replace(/^ACCESSIBILITY_ACTION_/, '').toLowerCase();
}

export function parseUiSnapshot(answer: {
  snapshotId?: string;
  window?: { id?: string };
  nodes?: RawNode[];
}): UiSnapshot {
  const nodes: UiNode[] = [];
  for (const n of answer.nodes ?? []) {
    if (typeof n.elementId !== 'string') continue;
    const b = rect(n.bounds);
    const name = cleanText(n.name);
    const value = cleanText(n.value);
    const description = cleanText(n.description);
    nodes.push({
      elementId: n.elementId,
      ...(typeof n.parentId === 'string' ? { parentId: n.parentId } : {}),
      depth: typeof n.depth === 'number' ? n.depth : 0,
      role: typeof n.role === 'string' && n.role.length > 0 ? n.role : 'unknown',
      ...(n.nativeRole ? { nativeRole: n.nativeRole } : {}),
      ...(name ? { name } : {}),
      ...(value ? { value } : {}),
      ...(description ? { description } : {}),
      ...(b && b.w > 0 && b.h > 0 ? { bounds: b } : {}),
      // `enabled`, `focused`, … (an enum spelling, `ACCESSIBILITY_STATE_ENABLED`, reads the same).
      states: (n.states ?? []).map((s) => s.toLowerCase().replace(/^accessibility_state_/, '')),
      actions: (n.actions ?? []).map(actionName),
    });
  }
  return {
    snapshotId: typeof answer.snapshotId === 'string' ? answer.snapshotId : '',
    windowId: typeof answer.window?.id === 'string' ? answer.window.id : null,
    nodes,
  };
}

const UI_ACTIONS: Readonly<Record<UiAction, string>> = {
  press: 'ACCESSIBILITY_ACTION_PRESS',
  focus: 'ACCESSIBILITY_ACTION_FOCUS',
  set_value: 'ACCESSIBILITY_ACTION_SET_VALUE',
  increment: 'ACCESSIBILITY_ACTION_INCREMENT',
  decrement: 'ACCESSIBILITY_ACTION_DECREMENT',
  show_menu: 'ACCESSIBILITY_ACTION_SHOW_MENU',
  expand: 'ACCESSIBILITY_ACTION_EXPAND',
  collapse: 'ACCESSIBILITY_ACTION_COLLAPSE',
  select: 'ACCESSIBILITY_ACTION_SELECT',
  scroll_into_view: 'ACCESSIBILITY_ACTION_SCROLL_INTO_VIEW',
};

/** The spacesd enum of an element action. */
export function uiActionEnum(action: UiAction): string {
  return UI_ACTIONS[action];
}

/** A window reference as spacesd's handle (`{id}`; the epoch is optional). */
export function windowRef(id: string): { id: string } {
  return { id };
}
