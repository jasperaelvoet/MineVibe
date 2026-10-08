import { isAbsolute } from 'node:path';
import { z } from 'zod';

/**
 * The MineVibe.app stub ⇄ Node channel (PLAN §9.2): newline-delimited JSON over Node's stdin (stub → Node) and
 * stdout (Node → stub). Node messages carry `t`, stub messages carry `cmd`. Node's stdin is also the lifeline:
 * EOF means the stub is gone, and Node tears everything down.
 */
export const STUB_PROTOCOL_VERSION = 1;

/** Coarse phases of an app launch, for the first-run window. */
export type AppPhase = 'start' | 'install' | 'seed' | 'launch' | 'launched' | 'connected' | 'exited';

export interface SelftestCheck {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

/** Node → stub. */
export type NodeToStub =
  | {
      readonly t: 'hello';
      readonly v: typeof STUB_PROTOCOL_VERSION;
      readonly mode: 'app' | 'selftest';
      readonly server: string;
      readonly node: string;
      readonly pid: number;
    }
  | {
      readonly t: 'progress';
      readonly phase: AppPhase;
      /** True when Node is installing or downloading something; the stub only opens its window for work. */
      readonly work: boolean;
      readonly title: string;
      readonly detail?: string;
      /** 0..1, or null/absent for an indeterminate bar. */
      readonly fraction?: number | null;
      readonly bytes?: number;
    }
  /** The game connected to the bridge: the stub hides its window. */
  | { readonly t: 'ready' }
  | {
      readonly t: 'pickFolder';
      readonly id: string;
      readonly title?: string;
      readonly message?: string;
      readonly prompt?: string;
      readonly startIn?: string;
    }
  | { readonly t: 'selftest'; readonly ok: boolean; readonly checks: readonly SelftestCheck[] }
  /** A fatal problem worth a dialog; Node exits non-zero right after. */
  | { readonly t: 'error'; readonly message: string; readonly detail?: string }
  | { readonly t: 'exit'; readonly code: number };

export const StubHello = z.object({
  cmd: z.literal('hello'),
  v: z.number().int(),
  stub: z.string().max(64),
  pid: z.number().int().positive(),
});
export type StubHello = z.infer<typeof StubHello>;

export const StubShutdown = z.object({
  cmd: z.literal('shutdown'),
  reason: z.string().max(64).default('quit'),
});

export const StubPickFolderResult = z.object({
  cmd: z.literal('pickFolder.result'),
  id: z.string().min(1).max(64),
  path: z.string().nullable(),
  error: z.string().max(64).optional(),
});
export type StubPickFolderResult = z.infer<typeof StubPickFolderResult>;

export const StubCommand = z.discriminatedUnion('cmd', [StubHello, StubShutdown, StubPickFolderResult]);
export type StubCommand = z.infer<typeof StubCommand>;

/** Lines longer than this are not parsed (a well-behaved stub never sends one). */
export const MAX_STUB_LINE = 64 * 1024;

/** The longest picked folder path: `PickFolderResult.path` of the `host.pick_folder` wire contract (T0). */
export const MAX_PICKED_PATH = 1024;

/** Parses one stdin line; null for blank, oversized, malformed or unknown input. */
export function parseStubLine(line: string): StubCommand | null {
  const text = line.trim();
  if (text === '' || text.length > MAX_STUB_LINE) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = StubCommand.safeParse(raw);
  if (!parsed.success) return null;
  const cmd = parsed.data;
  // A picked folder is only ever an absolute path that fits the wire contract; anything else is "nothing picked".
  if (
    cmd.cmd === 'pickFolder.result' &&
    cmd.path !== null &&
    (!isAbsolute(cmd.path) || cmd.path.includes('\0') || cmd.path.length > MAX_PICKED_PATH)
  ) {
    return { ...cmd, path: null };
  }
  return cmd;
}

/** One NDJSON line (JSON.stringify never emits a raw newline). */
export function encodeLine(message: NodeToStub): string {
  return `${JSON.stringify(message)}\n`;
}
