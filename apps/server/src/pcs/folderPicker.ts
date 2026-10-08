import { isAbsolute } from 'node:path';
import type { Logger } from 'pino';
import type { HostDialogs } from '../app/StubChannel.js';
import { type ExecFn, execWithTimeout } from './drivers/exec.js';

/**
 * `host.pick_folder` (PcConfigScreen "Browse…", protocol §7.7): the native macOS folder picker.
 *
 * - In MineVibe.app the Swift stub owns the UI (StubChannel.pickFolder). T0's `prompt` is the panel's title (the
 *   stub's own `prompt` is the button label, so it is mapped, not passed through).
 * - In a dev checkout (`npm run dev` / `npm run play`, no stub) an `osascript` `choose folder` dialog stands in.
 * - Otherwise there is nothing to ask and the answer is "cancelled" (null).
 */

export interface FolderPickRequest {
  /** The panel title (T0's `prompt`). */
  readonly title: string;
  /** A line under the title. */
  readonly message?: string;
  /** The confirm button. */
  readonly button?: string;
}

export type FolderPicker = (request: FolderPickRequest) => Promise<string | null>;

/** Longest path `PickFolderResult.path` carries. */
const MAX_PATH = 1024;

/** A picked path as the wire wants it: absolute, no trailing slash (except `/`), no NUL, ≤ 1024; else null. */
export function cleanPickedPath(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  let p = raw.replace(/\r?\n$/, '');
  while (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
  if (!isAbsolute(p) || p.includes('\0') || p.length > MAX_PATH) return null;
  return p;
}

/** The AppleScript of the dev fallback: the title arrives as `argv`, never spliced into the script. */
export const OSASCRIPT_ARGS = [
  '-e',
  'on run argv',
  '-e',
  'try',
  '-e',
  'return POSIX path of (choose folder with prompt (item 1 of argv))',
  '-e',
  'on error number -128',
  '-e',
  'return ""',
  '-e',
  'end try',
  '-e',
  'end run',
] as const;

export interface FolderPickerOptions {
  /** The runtime mode: the osascript fallback is for `dev` and `play` only. */
  readonly mode: 'dev' | 'play' | 'app';
  /** The stub's dialogs (MineVibe.app). */
  readonly dialogs?: HostDialogs | null;
  readonly platform?: NodeJS.Platform;
  readonly exec?: ExecFn;
  readonly logger?: Logger;
  /** How long the picker may stay open (default 10 minutes, like the mod's request timeout). */
  readonly timeoutMs?: number;
}

export function createFolderPicker(options: FolderPickerOptions): FolderPicker {
  const timeoutMs = options.timeoutMs ?? 10 * 60_000;
  const dialogs = options.dialogs ?? null;
  if (dialogs) {
    return async (req) =>
      cleanPickedPath(
        await dialogs.pickFolder({
          title: req.title,
          ...(req.message !== undefined ? { message: req.message } : {}),
          ...(req.button !== undefined ? { prompt: req.button } : {}),
          timeoutMs,
        }),
      );
  }
  const platform = options.platform ?? process.platform;
  if (options.mode === 'app' || platform !== 'darwin') {
    return async () => {
      options.logger?.warn('no folder picker here (no MineVibe.app stub); answering cancelled');
      return null;
    };
  }
  const exec = options.exec ?? execWithTimeout;
  return async (req) => {
    const r = await exec('/usr/bin/osascript', [...OSASCRIPT_ARGS, req.title], { timeoutMs });
    if (r.timedOut || r.code !== 0) {
      if (r.code !== 0 && !r.timedOut)
        options.logger?.warn({ err: r.stderr.trim().slice(0, 200) }, 'osascript folder picker failed');
      return null;
    }
    return cleanPickedPath(r.stdout.trim() || null);
  };
}
