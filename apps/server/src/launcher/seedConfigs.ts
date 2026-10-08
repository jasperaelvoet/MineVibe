import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writeFileAtomic } from '../util/atomicFile.js';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

function isObject(v: Json | undefined): v is JsonObject {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Deep "fill missing" merge: keys from `seed` are added where `target` lacks them; nested objects are merged
 * the same way; every value already in `target` wins, including arrays and type mismatches. Returns the merged
 * copy and the dotted paths that were added.
 */
export function fillMissing(
  target: JsonObject,
  seed: JsonObject,
  prefix = '',
): { merged: JsonObject; added: string[] } {
  const merged: JsonObject = { ...target };
  const added: string[] = [];
  for (const [key, value] of Object.entries(seed)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (!(key in merged)) {
      merged[key] = structuredClone(value);
      added.push(path);
    } else if (isObject(merged[key]) && isObject(value)) {
      const inner = fillMissing(merged[key] as JsonObject, value, path);
      merged[key] = inner.merged;
      added.push(...inner.added);
    }
  }
  return { merged, added };
}

export type SeedAction = 'created' | 'merged' | 'unchanged' | 'skipped-invalid';

/**
 * Seeds one JSON config: written when absent, merged with {@link fillMissing} when present, never clobbered.
 * A file that is not a JSON object is left untouched (`skipped-invalid`).
 */
export async function seedJsonConfig(
  path: string,
  seed: JsonObject,
): Promise<{ action: SeedAction; added: string[] }> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    await writeFileAtomic(path, `${JSON.stringify(seed, null, 2)}\n`);
    return { action: 'created', added: Object.keys(seed) };
  }
  let current: Json;
  try {
    current = JSON.parse(text) as Json;
  } catch {
    return { action: 'skipped-invalid', added: [] };
  }
  if (!isObject(current)) return { action: 'skipped-invalid', added: [] };
  const { merged, added } = fillMissing(current, seed);
  if (added.length === 0) return { action: 'unchanged', added };
  await writeFileAtomic(path, `${JSON.stringify(merged, null, 2)}\n`);
  return { action: 'merged', added };
}

/**
 * Seeds every `<seedDir>/*.json` into `<gameDir>/config/` (PLAN §10: dynamic_fps.json, entityculling.json).
 * The game runs with cwd = gameDir, so mods that resolve `config/` against cwd (Entity Culling) see the same
 * files.
 */
export async function seedConfigs(
  gameDir: string,
  seedDir: string,
): Promise<Array<{ file: string; action: SeedAction; added: string[] }>> {
  const files = (await readdir(seedDir)).filter((f) => f.endsWith('.json')).sort();
  const results: Array<{ file: string; action: SeedAction; added: string[] }> = [];
  for (const file of files) {
    const seed = JSON.parse(await readFile(join(seedDir, file), 'utf8')) as Json;
    if (!isObject(seed)) throw new Error(`seed config ${file} is not a JSON object`);
    const r = await seedJsonConfig(join(gameDir, 'config', file), seed);
    results.push({ file, ...r });
  }
  return results;
}
