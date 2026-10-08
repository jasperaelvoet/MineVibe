import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { open as openZip, readEntry, walkEntriesGenerator } from '@xmcl/unzip';
import { writeFileAtomic } from '../util/atomicFile.js';

/**
 * options.txt values MineVibe needs on every launch (PLAN §7.9, §10). Values are written exactly as
 * Minecraft 26.3 saves them: OptionInstance values are JSON (`"opengl"` for the backend enum), plain fields
 * are raw text.
 */
export const FORCED_OPTIONS: Readonly<Record<string, string>> = Object.freeze({
  /** Never pause when the window loses focus: agents keep living. */
  pauseOnLostFocus: 'false',
  /** OpenGL backend (Iris and our monitors need it); `--graphicsBackend opengl` also forces it per launch. */
  preferredGraphicsBackend: '"opengl"',
  /** Onboarding screens and toasts that would sit between launch and the world. */
  onboardAccessibility: 'false',
  tutorialStep: 'none',
  skipMultiplayerWarning: 'true',
  joinedFirstServer: 'true',
  realmsNotifications: 'false',
});

/** Seeded only when the key is absent, so the player's own choice wins afterwards. */
export const DEFAULT_OPTIONS: Readonly<Record<string, string>> = Object.freeze({
  narrator: '0',
  autoJump: 'false',
});

export interface OptionsMergeResult {
  readonly text: string;
  /** Keys whose value was added or changed. */
  readonly changed: readonly string[];
}

/**
 * Merges MineVibe's keys into an options.txt (`key:value` per line, split at the first colon). Forced keys are
 * set in place, defaults are added only when missing, and every other line (including unknown or malformed
 * ones, comments and the `version` line) is kept byte-for-byte and in order. A new file starts with
 * `version:<dataVersion>` so Minecraft does not run its options datafixers over our values.
 */
export function mergeOptionsTxt(
  existing: string | null,
  options: {
    forced?: Readonly<Record<string, string>>;
    defaults?: Readonly<Record<string, string>>;
    dataVersion?: number | null;
  } = {},
): OptionsMergeResult {
  const forced = options.forced ?? FORCED_OPTIONS;
  const defaults = options.defaults ?? DEFAULT_OPTIONS;
  const eol = existing?.includes('\r\n') ? '\r\n' : '\n';
  const lines = existing === null || existing === '' ? [] : existing.split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

  const changed: string[] = [];
  const seen = new Set<string>();
  const out = lines.map((line) => {
    const colon = line.indexOf(':');
    if (colon <= 0) return line;
    const key = line.slice(0, colon);
    if (seen.has(key)) return line;
    seen.add(key);
    const want = forced[key];
    if (want !== undefined && line.slice(colon + 1) !== want) {
      changed.push(key);
      return `${key}:${want}`;
    }
    return line;
  });

  if (existing === null && options.dataVersion != null && !seen.has('version')) {
    out.unshift(`version:${options.dataVersion}`);
    seen.add('version');
  }
  for (const [key, value] of [...Object.entries(forced), ...Object.entries(defaults)]) {
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(`${key}:${value}`);
    changed.push(key);
  }
  return { text: out.length === 0 ? '' : `${out.join(eol)}${eol}`, changed };
}

/** Reads `world_version` (the data version options.txt is stamped with) from a client jar's `version.json`. */
export async function readDataVersion(clientJar: string): Promise<number | null> {
  try {
    const zip = await openZip(clientJar, { lazyEntries: true, autoClose: false });
    try {
      for await (const entry of walkEntriesGenerator(zip)) {
        if (entry.fileName === 'version.json') {
          const json = JSON.parse((await readEntry(zip, entry)).toString('utf8')) as {
            world_version?: unknown;
          };
          return typeof json.world_version === 'number' ? json.world_version : null;
        }
      }
      return null;
    } finally {
      zip.close();
    }
  } catch {
    return null;
  }
}

/**
 * Merges MineVibe's keys into `<gameDir>/options.txt`; writes only when something changed. `dataVersion` may be
 * a function: it is then only called when the file does not exist yet (reading it from the client jar costs a
 * few hundred ms).
 */
export async function seedOptionsTxt(
  gameDir: string,
  options: { dataVersion?: number | null | (() => Promise<number | null>) } = {},
): Promise<OptionsMergeResult & { path: string; written: boolean }> {
  const path = join(gameDir, 'options.txt');
  let existing: string | null = null;
  try {
    existing = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  const dv = options.dataVersion;
  const dataVersion = typeof dv === 'function' ? (existing === null ? await dv() : null) : (dv ?? null);
  const result = mergeOptionsTxt(existing, { dataVersion });
  const written = existing === null || result.text !== existing;
  if (written) await writeFileAtomic(path, result.text);
  return { ...result, path, written };
}
