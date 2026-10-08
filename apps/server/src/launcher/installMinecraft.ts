import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MinecraftFolder, type ResolvedVersion, Version } from '@xmcl/core';
import { getVersionList, type MinecraftVersion } from '@xmcl/installer';
import type { Logger } from 'pino';
import { z } from 'zod';
import { writeFileAtomic } from '../util/atomicFile.js';
import {
  type DownloadSpec,
  downloadAll,
  type FetchLike,
  fileSize,
  launcherFetch,
  mapLimit,
} from './download.js';
import type { JavaRequirement } from './javaRuntime.js';

const MARKER = '.minevibe-installed.json';
const Marker = z.object({ id: z.string(), kind: z.string(), installedAt: z.string() });

/** Mojang's v2 version manifest: unlike v1 it carries each version JSON's sha1. */
export const VERSION_MANIFEST_V2 = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';
export const ASSET_HOST = 'https://resources.download.minecraft.net';

/** `versions/<id>/.minevibe-installed.json`: written only after a complete, checksum-verified install. */
export function installMarkerPath(gameDir: string, versionId: string): string {
  return join(MinecraftFolder.from(gameDir).getVersionRoot(versionId), MARKER);
}

export async function readInstallMarker(gameDir: string, versionId: string, kind: string): Promise<boolean> {
  try {
    const m = Marker.parse(JSON.parse(await readFile(installMarkerPath(gameDir, versionId), 'utf8')));
    return m.id === versionId && m.kind === kind;
  } catch {
    return false;
  }
}

export async function writeInstallMarker(gameDir: string, versionId: string, kind: string): Promise<void> {
  const body = { id: versionId, kind, installedAt: new Date().toISOString() };
  await writeFileAtomic(installMarkerPath(gameDir, versionId), `${JSON.stringify(body, null, 2)}\n`);
}

/**
 * Cheap completeness check of an installed version (inherited parts included): the client jar, every library,
 * the logging config, the asset index and every asset object exist with the expected size. No hashing; the
 * install itself verified sha1s. Returns a list of problems (empty = fine).
 */
export async function quickVerifyVersion(gameDir: string, resolved: ResolvedVersion): Promise<string[]> {
  const mc = MinecraftFolder.from(gameDir);
  const checks: Array<{ path: string; size: number | undefined; label: string }> = [];
  const client = resolved.downloads.client;
  checks.push({ path: mc.getVersionJar(resolved.minecraftVersion), size: client?.size, label: 'client jar' });
  for (const lib of resolved.libraries) {
    checks.push({ path: mc.getLibraryByPath(lib.download.path), size: lib.download.size, label: lib.name });
  }
  const logging = resolved.logging?.client?.file;
  if (logging)
    checks.push({ path: mc.getLogConfig(logging.id), size: logging.size, label: 'logging config' });

  const problems: string[] = [];
  if (resolved.assetIndex) {
    const indexPath = mc.getAssetsIndex(resolved.assets);
    try {
      const index = JSON.parse(await readFile(indexPath, 'utf8')) as {
        objects: Record<string, { hash: string; size: number }>;
      };
      for (const [name, obj] of Object.entries(index.objects)) {
        checks.push({ path: mc.getAsset(obj.hash), size: obj.size, label: `asset ${name}` });
      }
    } catch {
      problems.push('asset index missing or unreadable');
    }
  }
  await mapLimit(checks, 64, async (c) => {
    const size = await fileSize(c.path);
    if (size === null) problems.push(`${c.label}: missing`);
    else if (c.size !== undefined && c.size >= 0 && size !== c.size) problems.push(`${c.label}: wrong size`);
  });
  return problems;
}

const sha1Of = (value: string | undefined) => (value ? { algorithm: 'sha1' as const, value } : undefined);

/**
 * Download specs for a resolved version's files except asset objects: client jar, libraries (inherited ones
 * included), logging config and asset index, each with Mojang's (or Fabric's) sha1 and size.
 */
export function versionFileSpecs(gameDir: string, resolved: ResolvedVersion): DownloadSpec[] {
  const mc = MinecraftFolder.from(gameDir);
  const specs: DownloadSpec[] = [];
  const client = resolved.downloads.client;
  if (!client) throw new Error(`${resolved.id} has no client download`);
  specs.push({
    url: client.url,
    destination: mc.getVersionJar(resolved.minecraftVersion),
    size: client.size,
    hash: sha1Of(client.sha1),
  });
  for (const lib of resolved.libraries) {
    const a = lib.download;
    if (!a.url) throw new Error(`library ${lib.name} has no download URL`);
    specs.push({
      url: a.url,
      destination: mc.getLibraryByPath(a.path),
      size: a.size >= 0 ? a.size : undefined,
      hash: sha1Of(a.sha1),
    });
  }
  const logging = resolved.logging?.client?.file;
  if (logging) {
    specs.push({
      url: logging.url,
      destination: mc.getLogConfig(logging.id),
      size: logging.size,
      hash: sha1Of(logging.sha1),
    });
  }
  const ai = resolved.assetIndex;
  if (ai) {
    specs.push({
      url: ai.url,
      destination: mc.getAssetsIndex(resolved.assets),
      size: ai.size,
      hash: sha1Of(ai.sha1),
    });
  }
  return specs;
}

/** Download specs for every object in an asset index (`assets/objects/<hh>/<hash>`, named by sha1). */
export function assetObjectSpecs(
  gameDir: string,
  index: { objects: Record<string, { hash: string; size: number }> },
): DownloadSpec[] {
  const mc = MinecraftFolder.from(gameDir);
  const seen = new Set<string>();
  const specs: DownloadSpec[] = [];
  for (const { hash, size } of Object.values(index.objects)) {
    if (seen.has(hash)) continue;
    if (!/^[0-9a-f]{40}$/.test(hash)) throw new Error(`bad asset hash ${hash}`);
    seen.add(hash);
    specs.push({
      url: `${ASSET_HOST}/${hash.slice(0, 2)}/${hash}`,
      destination: mc.getAsset(hash),
      size,
      hash: { algorithm: 'sha1', value: hash },
    });
  }
  return specs;
}

/**
 * Makes every file of a resolved version present and sha1-verified (already-valid files are skipped), then
 * every object of its asset index.
 */
export async function installVersionFiles(
  gameDir: string,
  resolved: ResolvedVersion,
  options: { fetch?: FetchLike; signal?: AbortSignal } = {},
): Promise<{ files: number; bytes: number }> {
  const dl = {
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  };
  const files = await downloadAll(versionFileSpecs(gameDir, resolved), { ...dl, concurrency: 8 });
  let assets = { files: 0, bytes: 0 };
  if (resolved.assetIndex) {
    const indexPath = MinecraftFolder.from(gameDir).getAssetsIndex(resolved.assets);
    const index = JSON.parse(await readFile(indexPath, 'utf8')) as {
      objects: Record<string, { hash: string; size: number }>;
    };
    assets = await downloadAll(assetObjectSpecs(gameDir, index), { ...dl, concurrency: 16 });
  }
  return { files: files.files + assets.files, bytes: files.bytes + assets.bytes };
}

export interface InstallMinecraftOptions {
  readonly gameDir: string;
  /** Vanilla version id, e.g. `26.3`. */
  readonly version: string;
  readonly log: Logger;
  readonly fetch?: FetchLike;
  readonly signal?: AbortSignal;
}

export interface InstalledMinecraft {
  readonly versionId: string;
  readonly resolved: ResolvedVersion;
  /** False when the fast path found a complete install. */
  readonly installed: boolean;
  readonly javaRequirement: JavaRequirement | null;
  /** Bytes downloaded by this call. */
  readonly bytes: number;
}

/** The `javaVersion` of a resolved version, if it declares one. */
export function javaRequirementOf(resolved: ResolvedVersion): JavaRequirement | null {
  const jv = resolved.javaVersion as { component?: string; majorVersion?: number } | undefined;
  return jv?.component && jv.majorVersion ? { component: jv.component, majorVersion: jv.majorVersion } : null;
}

/**
 * Installs vanilla Minecraft: `@xmcl/installer` reads Mojang's version list, the version JSON is fetched and
 * sha1-checked, `@xmcl/core` resolves it (rules, natives, inheritance), and every file (client jar, libraries,
 * logging config, asset index, ~4k assets) is streamed with size + sha1 verification. A marker makes the next
 * run a stat-only fast path with no network.
 *
 * `@xmcl/installer`'s own `install()` is not used for the files: its downloader (`@xmcl/file-transfer`) crashes
 * the process on a non-2xx response with a patched undici and hit connect timeouts on this IPv4-only host
 * (spikes/s8-launcher/result.md).
 */
export async function installMinecraft(options: InstallMinecraftOptions): Promise<InstalledMinecraft> {
  const { gameDir, version, log } = options;
  if (await readInstallMarker(gameDir, version, 'minecraft')) {
    try {
      const resolved = await Version.parse(gameDir, version);
      const problems = await quickVerifyVersion(gameDir, resolved);
      if (problems.length === 0) {
        const javaRequirement = javaRequirementOf(resolved);
        return { versionId: version, resolved, installed: false, javaRequirement, bytes: 0 };
      }
      log.warn(
        { problems: problems.slice(0, 5), count: problems.length },
        'Minecraft install incomplete; repairing',
      );
    } catch (err) {
      log.warn({ err }, 'Minecraft install unreadable; reinstalling');
    }
  }

  const doFetch = options.fetch ?? launcherFetch();
  const dl = { fetch: doFetch, ...(options.signal ? { signal: options.signal } : {}) };
  const list = await getVersionList({ fetch: doFetch as typeof fetch, remote: VERSION_MANIFEST_V2 });
  const meta = list.versions.find((v) => v.id === version) as
    | (MinecraftVersion & { sha1?: string })
    | undefined;
  if (!meta) throw new Error(`Minecraft ${version} is not in Mojang's version manifest`);
  log.info({ version }, 'installing Minecraft (client, libraries, assets)');
  const json = await downloadAll(
    [
      {
        url: meta.url,
        destination: MinecraftFolder.from(gameDir).getVersionJson(version),
        hash: sha1Of(meta.sha1),
      },
    ],
    dl,
  );
  const resolved = await Version.parse(gameDir, version);
  const fetched = await installVersionFiles(gameDir, resolved, dl);
  const problems = await quickVerifyVersion(gameDir, resolved);
  if (problems.length > 0)
    throw new Error(`Minecraft install incomplete: ${problems.slice(0, 3).join('; ')}`);
  await writeInstallMarker(gameDir, version, 'minecraft');
  const javaRequirement = javaRequirementOf(resolved);
  return {
    versionId: version,
    resolved,
    installed: true,
    javaRequirement,
    bytes: json.bytes + fetched.bytes,
  };
}
