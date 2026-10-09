import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Logger } from 'pino';
import { writeFileAtomic } from '../util/atomicFile.js';
import { downloadVerified, type FetchLike, fileMatches } from './download.js';
import type { ShaderpackPin } from './mods.js';

export interface InstallShaderpackOptions {
  readonly pin: ShaderpackPin;
  readonly gameDir: string;
  readonly log: Logger;
  readonly fetch?: FetchLike;
  readonly signal?: AbortSignal;
}

/**
 * Places the pinned shaderpack zip in `<game>/shaderpacks/` (verified by size and sha512; downloaded only when missing
 * or different). Iris finds the `shaders/` folder inside GitHub's top-level archive directory itself, so the zip is
 * used as downloaded. Returns the bytes downloaded.
 */
export async function installShaderpack(options: InstallShaderpackOptions): Promise<number> {
  const { pin, log } = options;
  const destination = join(options.gameDir, 'shaderpacks', pin.filename);
  const hash = { algorithm: 'sha512' as const, value: pin.sha512 };
  if (await fileMatches(destination, { size: pin.size, hash })) return 0;
  log.info({ shaderpack: pin.name, commit: pin.commit.slice(0, 7) }, 'downloading shaderpack');
  return downloadVerified(
    { url: pin.url, destination, size: pin.size, hash },
    {
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    },
  );
}

export type IrisSeedAction = 'created' | 'selected' | 'unchanged';

/**
 * Selects `shaderPack` in `<game>/config/iris.properties` and turns shaders on, unless the player already picked a
 * pack: a missing file or an empty `shaderPack` gets ours with `enableShaders=true`; any other choice (another pack,
 * or ours switched off) is left alone. Other lines are kept as they are.
 */
export async function seedIrisProperties(gameDir: string, shaderPack: string): Promise<IrisSeedAction> {
  const path = join(gameDir, 'config', 'iris.properties');
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    await writeFileAtomic(path, `enableShaders=true\nshaderPack=${shaderPack}\n`);
    return 'created';
  }
  const lines = text.split(/\r?\n/);
  const keyOf = (line: string) => /^\s*([^#!=:\s]+)\s*[=:]/.exec(line)?.[1];
  const current = lines.find((l) => keyOf(l) === 'shaderPack');
  if (current !== undefined && current.replace(/^[^=:]*[=:]/, '').trim() !== '') return 'unchanged';
  const kept = lines.filter((l) => keyOf(l) !== 'shaderPack' && keyOf(l) !== 'enableShaders');
  while (kept.length > 0 && kept[kept.length - 1] === '') kept.pop();
  kept.push('enableShaders=true', `shaderPack=${shaderPack}`, '');
  await writeFileAtomic(path, kept.join('\n'));
  return 'selected';
}
