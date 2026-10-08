import { readFile } from 'node:fs/promises';
import { MinecraftFolder, type ResolvedVersion, Version } from '@xmcl/core';
import { installFabric } from '@xmcl/installer';
import type { Logger } from 'pino';
import { writeFileAtomic } from '../util/atomicFile.js';
import { type DownloadSpec, downloadAll, type FetchLike, fileMatches, launcherFetch } from './download.js';
import { quickVerifyVersion, readInstallMarker, writeInstallMarker } from './installMinecraft.js';
import type { FabricLibraryPin } from './mods.js';

/** The version id `@xmcl/installer`'s `installFabric` writes: `<minecraft>-fabric<loader>`. */
export function fabricVersionId(minecraftVersion: string, loaderVersion: string): string {
  return `${minecraftVersion}-fabric${loaderVersion}`;
}

interface ProfileLibrary {
  name: string;
  url?: string;
  sha1?: string;
  sha512?: string;
  size?: number;
  downloads?: unknown;
  [key: string]: unknown;
}

/** Maven coordinates `group:artifact:version[:classifier]` -> repository path. */
export function mavenPath(coords: string): string {
  const [group, artifact, version, classifier] = coords.split(':');
  if (!group || !artifact || !version) throw new Error(`bad maven coordinates: ${coords}`);
  const file = `${artifact}-${version}${classifier ? `-${classifier}` : ''}.jar`;
  return `${group.replaceAll('.', '/')}/${artifact}/${version}/${file}`;
}

/** A library of Fabric's profile: pinned in `mods.lock.json`, then downloaded and verified by sha512. */
export interface PinnedFabricLibrary {
  readonly name: string;
  readonly path: string;
  readonly url: string;
  readonly size: number;
  readonly sha512: string;
}

/**
 * Checks Fabric's launcher profile against the lock's pins (PLAN §10) and rewrites its libraries into Mojang's
 * `downloads.artifact` form (path, url, size), which `@xmcl/core` resolves like vanilla libraries.
 *
 * - Every profile library must be pinned by its exact Maven coordinates; an unknown one is refused.
 * - Where the profile carries its own size or sha512, it must agree with the pin.
 * - Repositories must be https. The checksums themselves only come from the lock: Fabric's profile has none for
 *   `fabric-loader`, and nothing fetched from Fabric's servers at install time is trusted for it.
 */
export function pinFabricLibraries<T extends { libraries?: ProfileLibrary[] }>(
  profile: T,
  pins: readonly FabricLibraryPin[],
): { profile: T; libraries: PinnedFabricLibrary[] } {
  const byName = new Map(pins.map((p) => [p.name, p]));
  const libraries: PinnedFabricLibrary[] = [];
  const rewritten = (profile.libraries ?? []).map((lib) => {
    const pin = byName.get(lib.name);
    if (!pin) throw new Error(`Fabric's profile lists ${lib.name}, which mods.lock.json does not pin`);
    const declared = typeof lib.sha512 === 'string' ? lib.sha512.toLowerCase() : undefined;
    if (declared !== undefined && declared !== pin.sha512) {
      throw new Error(`Fabric's profile has a different sha512 for ${lib.name} than mods.lock.json`);
    }
    if (typeof lib.size === 'number' && lib.size !== pin.size) {
      throw new Error(`Fabric's profile has a different size for ${lib.name} than mods.lock.json`);
    }
    const base =
      typeof lib.url === 'string' ? (lib.url.endsWith('/') ? lib.url : `${lib.url}/`) : MAVEN_FABRIC;
    if (!base.startsWith('https://')) throw new Error(`refusing non-https Maven repository ${base}`);
    const path = mavenPath(lib.name);
    libraries.push({ name: lib.name, path, url: base + path, size: pin.size, sha512: pin.sha512 });
    return { name: lib.name, downloads: { artifact: { path, url: base + path, size: pin.size } } };
  });
  return { profile: { ...profile, libraries: rewritten }, libraries };
}

/** Fabric's Maven repository (the profile names it per library; this is only the fallback). */
const MAVEN_FABRIC = 'https://maven.fabricmc.net/';

/** Whether every pinned library is on disk with its pinned size and sha512 (a few MB, hashed every launch). */
async function pinnedLibrariesIntact(gameDir: string, pins: readonly FabricLibraryPin[]): Promise<string[]> {
  const mc = MinecraftFolder.from(gameDir);
  const problems: string[] = [];
  for (const pin of pins) {
    const ok = await fileMatches(mc.getLibraryByPath(mavenPath(pin.name)), {
      size: pin.size,
      hash: { algorithm: 'sha512', value: pin.sha512 },
    });
    if (!ok) problems.push(`${pin.name}: missing or not the pinned file`);
  }
  return problems;
}

export interface InstallFabricOptions {
  readonly gameDir: string;
  readonly minecraftVersion: string;
  readonly loaderVersion: string;
  /** `mods.lock.json` `fabric.libraries`: every library of the profile, pinned by size and sha512. */
  readonly libraries: readonly FabricLibraryPin[];
  readonly log: Logger;
  readonly fetch?: FetchLike;
  readonly signal?: AbortSignal;
}

export interface InstalledFabric {
  readonly versionId: string;
  readonly resolved: ResolvedVersion;
  readonly installed: boolean;
}

/**
 * Installs the Fabric loader profile on top of an installed vanilla version (`@xmcl/installer` `installFabric`
 * fetches Fabric's official launcher profile from meta.fabricmc.net), checks its libraries against the lock's pins,
 * then downloads them with size and sha512 checks. Later launches re-hash the pinned jars (a few MB).
 */
export async function installFabricLoader(options: InstallFabricOptions): Promise<InstalledFabric> {
  const { gameDir, minecraftVersion, loaderVersion, log } = options;
  const versionId = fabricVersionId(minecraftVersion, loaderVersion);
  if (await readInstallMarker(gameDir, versionId, 'fabric')) {
    try {
      const resolved = await Version.parse(gameDir, versionId);
      const problems = [
        ...(await quickVerifyVersion(gameDir, resolved)),
        ...(await pinnedLibrariesIntact(gameDir, options.libraries)),
      ];
      if (problems.length === 0) return { versionId, resolved, installed: false };
      log.warn({ problems: problems.slice(0, 5) }, 'Fabric install incomplete; repairing');
    } catch (err) {
      log.warn({ err }, 'Fabric install unreadable; reinstalling');
    }
  }

  log.info({ minecraftVersion, loaderVersion }, 'installing Fabric loader');
  const doFetch = options.fetch ?? launcherFetch();
  const id = await installFabric({
    minecraftVersion,
    version: loaderVersion,
    minecraft: gameDir,
    fetch: doFetch as typeof fetch,
  });
  if (id !== versionId) throw new Error(`unexpected Fabric version id ${id}`);
  const mc = MinecraftFolder.from(gameDir);
  const jsonPath = mc.getVersionJson(versionId);
  const { profile, libraries } = pinFabricLibraries(
    JSON.parse(await readFile(jsonPath, 'utf8')) as { libraries?: ProfileLibrary[] },
    options.libraries,
  );
  await writeFileAtomic(jsonPath, JSON.stringify(profile, null, 2));

  // Only Fabric's own libraries: the inherited vanilla files were verified by installMinecraft.
  const specs: DownloadSpec[] = libraries.map((lib) => ({
    url: lib.url,
    destination: mc.getLibraryByPath(lib.path),
    size: lib.size,
    hash: { algorithm: 'sha512', value: lib.sha512 },
  }));
  await downloadAll(specs, {
    fetch: doFetch,
    concurrency: 8,
    ...(options.signal ? { signal: options.signal } : {}),
  });

  const resolved = await Version.parse(gameDir, versionId);
  const problems = await quickVerifyVersion(gameDir, resolved);
  if (problems.length > 0) throw new Error(`Fabric install incomplete: ${problems.slice(0, 3).join('; ')}`);
  await writeInstallMarker(gameDir, versionId, 'fabric');
  return { versionId, resolved, installed: true };
}
