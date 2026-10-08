import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

/** Minecraft player names: 3-16 characters, letters, digits and underscores. */
export const PLAYER_NAME_RE = /^[A-Za-z0-9_]{3,16}$/;
export const DEFAULT_PLAYER_NAME = 'Player';

/** The launcher's slice of `state/settings.json`. Unknown keys are ignored (other subsystems own them). */
export const LauncherSettings = z.object({
  playerName: z.string().regex(PLAYER_NAME_RE).default(DEFAULT_PLAYER_NAME),
  /** Opt-in mods from the lock, by slug or mod id (e.g. `["iris"]`). */
  optionalMods: z.array(z.string()).default([]),
  /** JVM heap in MiB (`-Xmx`). */
  maxMemoryMb: z.number().int().min(2048).max(65536).default(6144),
});
export type LauncherSettings = z.infer<typeof LauncherSettings>;

/**
 * Reads `<state>/settings.json`. A missing file gives defaults; an invalid field falls back to its default with
 * a warning. `MINEVIBE_PLAYER_NAME` overrides the name (dev).
 */
export async function loadLauncherSettings(
  stateDir: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
  warn: (msg: string) => void = () => {},
): Promise<LauncherSettings> {
  let raw: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(await readFile(join(stateDir, 'settings.json'), 'utf8')) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
      raw = parsed as Record<string, unknown>;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT')
      warn(`settings.json unreadable: ${(err as Error).message}`);
  }
  const envName = env.MINEVIBE_PLAYER_NAME?.trim();
  if (envName) raw = { ...raw, playerName: envName };

  const settings: Record<string, unknown> = {};
  const shape = LauncherSettings.shape;
  for (const key of Object.keys(shape) as Array<keyof typeof shape>) {
    const r = shape[key].safeParse(raw[key]);
    if (r.success) settings[key] = r.data;
    else {
      warn(`settings.${key} is invalid; using the default`);
      settings[key] = shape[key].parse(undefined);
    }
  }
  return LauncherSettings.parse(settings);
}
