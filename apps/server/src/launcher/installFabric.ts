import { readFile } from 'node:fs/promises';
import { MinecraftFolder, type ResolvedVersion, Version } from '@xmcl/core';
import { installFabric } from '@xmcl/installer';
import type { Logger } from 'pino';
import { writeFileAtomic } from '../util/atomicFile.js';
import { type DownloadSpec, downloadAll, type FetchLike, launcherFetch } from './download.js';
import { quickVerifyVersion, readInstallMarker, writeInstallMarker } from './installMinecraft.js';

/** The version id `@xmcl/installer`'s `installFabric` writes: `<minecraft>-fabric<loader>`. */
export function fabricVersionId(minecraftVersion: string, loaderVersion: string): string {
  return `${minecraftVersion}-fabric${loaderVersion}`;
}

interface ProfileLibrary {
  name: string;
  url?: string;
  sha1?: string;
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

/**
 * Fabric's launcher profile lists libraries as `{name, url, sha1, size}`. `@xmcl/core` ignores those checksums
 * for url-style entries, so rewrite them into Mojang's `downloads.artifact` form; the library installer then
 * verifies every Fabric jar's sha1 and size.
 */
export function withArtifactDownloads<T extends { libraries?: ProfileLibrary[] }>(profile: T): T {
  const libraries = (profile.libraries ?? []).map((lib) => {
    if (lib.downloads || !lib.sha1 || !lib.url) return lib;
    const path = mavenPath(lib.name);
    const base = lib.url.endsWith('/') ? lib.url : `${lib.url}/`;
    return {
      name: lib.name,
      downloads: { artifact: { path, url: base + path, sha1: lib.sha1, size: lib.size ?? -1 } },
    };
  });
  return { ...profile, libraries };
}

/**
 * Fills in `sha1` for profile libraries that lack one (Fabric's profile omits it for `fabric-loader` itself)
 * from the Maven repository's `.sha1` sidecar, fetched over HTTPS from the library's own repository.
 */
export async function fillMavenSha1<T extends { libraries?: ProfileLibrary[] }>(
  profile: T,
  doFetch: FetchLike,
): Promise<T> {
  const libraries = await Promise.all(
    (profile.libraries ?? []).map(async (lib) => {
      if (lib.downloads || lib.sha1 || !lib.url) return lib;
      const base = lib.url.endsWith('/') ? lib.url : `${lib.url}/`;
      if (!base.startsWith('https://')) throw new Error(`refusing non-https Maven repository ${base}`);
      const url = `${base}${mavenPath(lib.name)}.sha1`;
      const res = await doFetch(url);
      if (!res.ok) throw new Error(`GET ${url}: HTTP ${res.status}`);
      const sha1 = /^[0-9a-f]{40}/i.exec((await res.text()).trim())?.[0]?.toLowerCase();
      if (!sha1) throw new Error(`${url} is not a sha1`);
      return { ...lib, sha1 };
    }),
  );
  return { ...profile, libraries };
}

export interface InstallFabricOptions {
  readonly gameDir: string;
  readonly minecraftVersion: string;
  readonly loaderVersion: string;
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
 * fetches Fabric's official launcher profile from meta.fabricmc.net), then downloads its libraries with sha1
 * and size checks.
 */
export async function installFabricLoader(options: InstallFabricOptions): Promise<InstalledFabric> {
  const { gameDir, minecraftVersion, loaderVersion, log } = options;
  const versionId = fabricVersionId(minecraftVersion, loaderVersion);
  if (await readInstallMarker(gameDir, versionId, 'fabric')) {
    try {
      const resolved = await Version.parse(gameDir, versionId);
      const problems = await quickVerifyVersion(gameDir, resolved);
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
  const profile = withArtifactDownloads(
    await fillMavenSha1(
      JSON.parse(await readFile(jsonPath, 'utf8')) as { libraries?: ProfileLibrary[] },
      doFetch,
    ),
  );
  await writeFileAtomic(jsonPath, JSON.stringify(profile, null, 2));

  // Only Fabric's own libraries: the inherited vanilla files were verified by installMinecraft.
  // biome-ignore lint/suspicious/noExplicitAny: xmcl's Version.Library union is not exported usefully
  const libs = Version.resolveLibraries((profile.libraries ?? []) as any);
  const specs: DownloadSpec[] = libs.map((lib) => {
    if (!lib.download.url || !lib.download.sha1)
      throw new Error(`Fabric library ${lib.name} has no checksum`);
    return {
      url: lib.download.url,
      destination: mc.getLibraryByPath(lib.download.path),
      size: lib.download.size >= 0 ? lib.download.size : undefined,
      hash: { algorithm: 'sha1', value: lib.download.sha1 },
    };
  });
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
