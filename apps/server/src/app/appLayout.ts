import { readdir, readFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

/**
 * Where things live inside MineVibe.app (PLAN §9.1), relative to the bundle. `packaging/build-app.ts` assembles the
 * bundle from these same paths.
 *
 * Apple `container`'s install root is `Contents/Runtime/container`, not `Contents/Helpers/container` (PLAN §9.1).
 * Everything under `Helpers/` must be signed code, and the install root also holds Apple's unsigned data files
 * (`config.toml`, shell scripts), so a bundle with it under `Helpers/` cannot be signed without re-signing Apple's
 * files. Under `Runtime/` they are sealed as resources, and Apple's Mach-O signatures stay untouched
 * (packaging/README.md). The bundle is read-only at runtime: the install root is checked against the bundled
 * `vendor.lock.json`, never provisioned.
 */
export const BUNDLE_LAYOUT = Object.freeze({
  /** The Swift stub (CFBundleExecutable). */
  stub: 'Contents/MacOS/MineVibe',
  /** Official Node 24 darwin-arm64, byte-identical. */
  node: 'Contents/MacOS/node',
  /** The server bundle and its production `node_modules`. */
  server: 'Contents/Resources/server',
  serverMain: 'Contents/Resources/server/dist/main.mjs',
  /** `minevibe-<version>.jar`, `mods.lock.json`, `seed-configs/` (MINEVIBE_RESOURCES). */
  mod: 'Contents/Resources/mod',
  /** Temurin 25 JRE home; `bin/MineVibe` is a copy of `bin/java`. */
  jre: 'Contents/Runtime/jre',
  /** Apple `container` 1.5.0 install root (`bin/container`, `libexec/container/plugins/…`). */
  container: 'Contents/Runtime/container',
  /** `packaging/vendor.lock.json`: the pins the bundled install root is checked against (never provisioned). */
  vendorLock: 'Contents/Resources/vendor.lock.json',
  /** `images/linux-pc` (Containerfile + boot hook): the build context of the Linux PC image on first run. */
  linuxPc: 'Contents/Resources/linux-pc',
  /** Versions of everything inside, written by build-app. */
  buildInfo: 'Contents/Resources/build-info.json',
  icon: 'Contents/Resources/MineVibe.icns',
});

export interface AppBundleLayout {
  /** `/Applications/MineVibe.app`. */
  readonly bundle: string;
  readonly node: string;
  readonly serverMain: string;
  readonly modResources: string;
  readonly jreHome: string;
  /** Pass as `--install-root` / `CONTAINER_INSTALL_ROOT` (PLAN §8.1). */
  readonly containerInstallRoot: string;
  readonly buildInfo: string;
  /** The bundled copy of `packaging/vendor.lock.json`. */
  readonly vendorLock: string;
  /** The Linux PC image's build context (`Containerfile`, `minevibe-entrypoint.sh`, `sudoers-minevibe`, `android`). */
  readonly linuxPcContext: string;
}

/** The bundle this Node runs from (`<bundle>/Contents/MacOS/node`), or null in a dev checkout. */
export function appBundleLayout(execPath: string = process.execPath): AppBundleLayout | null {
  const macos = dirname(execPath);
  const contents = dirname(macos);
  const bundle = dirname(contents);
  if (basename(macos) !== 'MacOS' || basename(contents) !== 'Contents' || !bundle.endsWith('.app'))
    return null;
  const at = (rel: string) => join(bundle, ...rel.split('/'));
  return {
    bundle,
    node: at(BUNDLE_LAYOUT.node),
    serverMain: at(BUNDLE_LAYOUT.serverMain),
    modResources: at(BUNDLE_LAYOUT.mod),
    jreHome: at(BUNDLE_LAYOUT.jre),
    containerInstallRoot: at(BUNDLE_LAYOUT.container),
    buildInfo: at(BUNDLE_LAYOUT.buildInfo),
    vendorLock: at(BUNDLE_LAYOUT.vendorLock),
    linuxPcContext: at(BUNDLE_LAYOUT.linuxPc),
  };
}

/** `dev` builds may run the SDK-bundled claude (`MINEVIBE_CLAUDE=bundled`); `release` builds prune it (PLAN §9.1). */
export type BuildChannel = 'dev' | 'release';

/** `Resources/build-info.json`, written by build-app. */
export interface BuildInfo {
  readonly version?: string;
  readonly commit?: string;
  readonly built?: string;
  readonly channel: BuildChannel;
}

/**
 * Reads `build-info.json`. A build from before channels existed is `dev`; an unreadable file is null (callers then
 * take the strict, `release` side).
 */
export async function readBuildInfo(path: string): Promise<BuildInfo | null> {
  try {
    const raw = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    const str = (k: string) => (typeof raw[k] === 'string' ? { [k]: raw[k] as string } : {});
    return {
      ...str('version'),
      ...str('commit'),
      ...str('built'),
      channel: raw.channel === 'release' ? 'release' : 'dev',
    };
  } catch {
    return null;
  }
}

/** A MineVibe mod jar name (`minevibe-0.1.0.jar`), not a sources/dev/javadoc jar. */
export const MOD_JAR_RE = /^minevibe-\d[\w.+-]*\.jar$/;

/** The one `minevibe-<version>.jar` in the bundle's mod folder, or null. Several jars are an assembly error. */
export async function findBundledModJar(modResources: string): Promise<string | null> {
  let names: string[];
  try {
    names = await readdir(modResources);
  } catch {
    return null;
  }
  const jars = names.filter((n) => MOD_JAR_RE.test(n) && !/-(sources|dev|javadoc)\.jar$/.test(n));
  if (jars.length > 1) throw new Error(`${modResources} holds more than one mod jar: ${jars.join(', ')}`);
  return jars[0] ? join(modResources, jars[0]) : null;
}
