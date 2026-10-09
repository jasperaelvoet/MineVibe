/**
 * `open`, `wait_for` and `clipboard` (PC tools V2 §5.2): open a URL, file or app and get its window in one call;
 * wait for what the agent expects to see instead of guessing with `wait`; read or set the clipboard.
 */

import { createHash } from 'node:crypto';
import { z } from 'zod';
import { isApiError } from '../../../contracts/common.js';
import { type GuestWindow, PC_ERROR_CODES } from '../../../contracts/PcApi.js';
import { type CallToolResult, errorResult, textResult } from '../results.js';
import { type Def, defs, finishAction, tool } from './common.js';
import { isMirror, type PcToolContext, type Seat, windowLabel } from './context.js';
import { openFailed } from './formats.js';
import { roleMatches } from './ui.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Friendly app names agents use, as what the PC has. */
const APP_ALIASES: Readonly<Record<string, string>> = {
  terminal: 'xfce4-terminal',
  'a terminal': 'xfce4-terminal',
  shell: 'xfce4-terminal',
  browser: 'firefox',
  'web browser': 'firefox',
  'firefox browser': 'firefox',
  chrome: 'chromium',
  'google chrome': 'chromium',
  files: 'thunar',
  'file manager': 'thunar',
  explorer: 'thunar',
  finder: 'thunar',
  editor: 'mousepad',
  'text editor': 'mousepad',
  vscode: 'code',
  'vs code': 'code',
  'visual studio code': 'code',
};

function resolveTarget(target: string, home: string): string {
  const t = target.trim();
  if (t === '~' || t.startsWith('~/')) return `${home.replace(/\/+$/, '')}${t.slice(1)}`;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t) || t.startsWith('about:') || t.startsWith('/')) return t;
  if (/^(www\.|[a-z0-9-]+\.(com|org|net|io|dev|app|ai|edu|gov)(\/|$))/i.test(t)) return `https://${t}`;
  const alias = APP_ALIASES[t.toLowerCase()];
  if (alias) return alias;
  // "Firefox", "Thunar": executables are lowercase.
  return /^[A-Za-z][A-Za-z0-9_+-]*$/.test(t) ? t.toLowerCase() : t;
}

async function open(
  ctx: PcToolContext,
  seat: Seat,
  args: { target: string; args?: string[] | undefined },
): Promise<CallToolResult> {
  const info = await ctx.info(seat.pcId);
  const target = resolveTarget(args.target, info.home);
  let result: Awaited<ReturnType<typeof ctx.host.pcs.open>>;
  try {
    result = await ctx.host.pcs.open(seat.pcId, {
      target,
      ...(args.args?.length ? { args: args.args } : {}),
      tag: `${ctx.host.agentId}:${seat.epoch}`,
    });
  } catch (err) {
    if (isApiError(err, PC_ERROR_CODES.OPEN_FAILED)) {
      const apps = /Installed apps include: (.*)$/.exec(err.message)?.[1] ?? '';
      return errorResult(openFailed(args.target, apps));
    }
    if (isApiError(err, PC_ERROR_CODES.NOT_FOUND)) return errorResult(`No such file or folder: ${target}`);
    throw err;
  }
  if (!result.window) {
    return finishAction(
      ctx,
      seat,
      `Started ${result.via} for ${target}, but no window appeared within 15 s (it may still be starting).`,
      { forceImage: true, windowNote: false },
    );
  }
  const label = windowLabel(result.window);
  const text = result.newWindow
    ? `Opened ${target}: window "${label}" is focused.`
    : `Opened ${target} in "${label}" (focused).`;
  return finishAction(ctx, seat, text, { forceImage: true, windowNote: false });
}

// ------------------------------------------------------------------------------------------------- wait_for

interface WaitArgs {
  text?: string | undefined;
  role?: string | undefined;
  name?: string | undefined;
  window?: string | undefined;
  stable?: boolean | undefined;
  gone?: boolean | undefined;
  timeout_ms?: number | undefined;
}

/** Whether what the agent waits for is on the screen now; where it was seen. */
async function holds(
  ctx: PcToolContext,
  pcId: string,
  args: WaitArgs,
): Promise<{ found: boolean; where: GuestWindow | null }> {
  const windows = await ctx.host.pcs.windows(pcId);
  const q = (s: string) => s.toLowerCase();
  if (args.window && !args.text && !args.role && !args.name) {
    const w = windows.find((x) => q(x.title).includes(q(args.window as string)));
    return { found: w !== undefined, where: w ?? null };
  }
  let scope = windows.filter((w) => w.onScreen && !isMirror(w));
  if (args.window) scope = scope.filter((w) => q(w.title).includes(q(args.window as string)));
  const text = args.text ?? args.name;
  for (const w of scope) {
    if (args.text && !args.role && q(w.title).includes(q(args.text))) return { found: true, where: w };
    const queries = text ? [{ nameContains: text }, { valueContains: text }] : [{}];
    for (const query of queries) {
      try {
        const snap = text
          ? await ctx.host.pcs.uiFind(pcId, { windowId: w.id, ...query, maxResults: 20 })
          : await ctx.host.pcs.uiTree(pcId, { windowId: w.id, maxNodes: 1_500 });
        if (snap.nodes.some((n) => !args.role || roleMatches(n, args.role))) return { found: true, where: w };
      } catch {
        // a window that closed or exposes nothing: the next one
      }
    }
  }
  return { found: false, where: null };
}

async function waitFor(ctx: PcToolContext, seat: Seat, args: WaitArgs): Promise<CallToolResult> {
  const timeout = Math.max(100, Math.min(120_000, args.timeout_ms ?? 10_000));
  const start = Date.now();
  const end = start + timeout;
  const secs = () => ((Date.now() - start) / 1000).toFixed(1);
  if (args.stable) {
    // The screen stops changing: equal thumbnails over at least 600 ms.
    const hash = async () =>
      createHash('sha1')
        .update(
          (await ctx.host.pcs.screenshot(seat.pcId, { maxDim: 320, quality: 50, includeCursor: false })).data,
        )
        .digest('hex');
    let prev = await hash();
    let since = Date.now();
    while (Date.now() < end) {
      await sleep(120);
      const cur = await hash();
      if (cur !== prev) {
        prev = cur;
        since = Date.now();
      } else if (Date.now() - since >= 600) {
        return finishAction(ctx, seat, `The screen is still after ${secs()} s.`, { forceImage: true });
      }
    }
    return finishAction(ctx, seat, `The screen kept changing for ${Math.round(timeout / 1000)} s.`, {
      forceImage: true,
      isError: true,
    });
  }
  if (!args.text && !args.role && !args.name && !args.window) {
    return errorResult('wait_for needs text, role/name, window or stable.');
  }
  const what = args.text
    ? `"${args.text}"`
    : args.name || args.role
      ? `${args.role ?? 'element'}${args.name ? ` "${args.name}"` : ''}`
      : `window "${args.window}"`;
  let last: { found: boolean; where: GuestWindow | null } = { found: false, where: null };
  while (Date.now() < end) {
    last = await holds(ctx, seat.pcId, args);
    if (last.found !== (args.gone === true)) {
      const where = last.where ? ` in "${windowLabel(last.where)}"` : '';
      const text = args.gone
        ? `${what} is gone after ${secs()} s.`
        : `Found ${what} after ${secs()} s${where}.`;
      return finishAction(ctx, seat, text, { forceImage: true, windowNote: false });
    }
    await sleep(300);
  }
  const focused = (await ctx.host.pcs.windows(seat.pcId).catch(() => [] as GuestWindow[])).find(
    (w) => w.focused,
  );
  const text = args.gone
    ? `${what} was still there after ${Math.round(timeout / 1000)} s.`
    : `${what} did not appear within ${Math.round(timeout / 1000)} s.${focused ? ` Focused: "${windowLabel(focused)}".` : ''}`;
  return finishAction(ctx, seat, text, { forceImage: true, isError: true, windowNote: false });
}

export function helperTools(ctx: PcToolContext): Def[] {
  return defs(
    tool(
      'open',
      'Open a URL, file, folder or app on the PC and wait for its window: target is an http(s) URL, an absolute path, or an app (firefox, xfce4-terminal, thunar, or a name like "terminal", "browser"). Returns the new window and a screenshot. What you open closes when you stand up.',
      {
        target: z.string().min(1).max(2_048),
        args: z.array(z.string().max(1_024)).max(20).optional().describe('Extra arguments for an app'),
      },
      (args, extra) => ctx.run('open', extra, (seat) => open(ctx, seat, args), { gui: true }),
    ),
    tool(
      'wait_for',
      "Wait until the screen shows something, instead of guessing with wait: text (in the windows' accessible text or titles), an element (role and/or name), a window (title or part of it), or stable (the screen stops changing). gone: true waits for it to disappear. Returns as soon as it holds, with a screenshot; an error after timeout_ms (default 10000, max 120000).",
      {
        text: z.string().max(200).optional(),
        role: z.string().max(40).optional(),
        name: z.string().max(200).optional(),
        window: z.string().max(200).optional(),
        stable: z.boolean().optional(),
        gone: z.boolean().optional(),
        timeout_ms: z.number().int().min(100).max(120_000).optional(),
      },
      (args, extra) => ctx.run('wait_for', extra, (seat) => waitFor(ctx, seat, args), { gui: true }),
    ),
    tool(
      'clipboard',
      'Read the PC clipboard, or set it to text.',
      { action: z.enum(['get', 'set']).optional(), text: z.string().max(100_000).optional() },
      (args, extra) =>
        ctx.run('clipboard', extra, async (seat) => {
          if (args.action === 'set' || args.text !== undefined) {
            if (args.text === undefined) return errorResult('Give text to set.');
            await ctx.host.pcs.clipboardSet(seat.pcId, args.text);
            return textResult('Clipboard set.');
          }
          const text = await ctx.host.pcs.clipboardGet(seat.pcId);
          return textResult(text.length > 0 ? text : '(clipboard is empty)');
        }),
    ),
  );
}
