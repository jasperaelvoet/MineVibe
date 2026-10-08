import { constants } from 'node:fs';
import { access, open, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { resolvePaths } from '../config/paths.js';
import { bundledJavaPath, JAVA_FOR_26_3, probeJava } from '../launcher/javaRuntime.js';
import { findDevModJar, loadModsLock } from '../launcher/mods.js';
import { readContainerLock } from '../pcs/drivers/ContainerRuntime.js';
import { SERVER_VERSION } from '../version.js';
import { type AppBundleLayout, findBundledModJar, readBuildInfo } from './appLayout.js';
import { installRootMismatches } from './appPcs.js';
import { isAppleSilicon, MIN_MACOS_MAJOR, macosMajor, readMacosVersion } from './prerequisites.js';
import type { SelftestCheck } from './stubProtocol.js';

export interface SelftestOptions {
  readonly layout: AppBundleLayout | null;
  /** The checkout, when not running from a bundle. */
  readonly repoRoot: string | null;
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Test seam for `java -version`. */
  readonly probe?: (javaPath: string) => Promise<{ version: string; major: number }>;
  /** Test seam for the bundled Java lookup. */
  readonly bundledJava?: () => string | null;
  /** Test seams for the platform check. */
  readonly appleSilicon?: () => Promise<boolean>;
  readonly macosVersion?: () => Promise<string | null>;
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function isZip(path: string): Promise<boolean> {
  const handle = await open(path, 'r');
  try {
    const head = Buffer.alloc(4);
    await handle.read(head, 0, 4, 0);
    return head.equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  } finally {
    await handle.close();
  }
}

/** Runs one check; a throw is a failed check, never a crash. */
async function check(name: string, fn: () => Promise<string>): Promise<SelftestCheck> {
  try {
    return { name, ok: true, detail: await fn() };
  } catch (err) {
    return { name, ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * `minevibe-server app --selftest` (CI, PLAN §11): what a launch needs is present and runnable, without starting the
 * bridge, installing anything or launching the game. Read-only: creates no directories.
 */
export async function runSelftestChecks(options: SelftestOptions): Promise<SelftestCheck[]> {
  const { layout, repoRoot } = options;
  const env = options.env ?? process.env;
  const resources = layout?.modResources ?? (repoRoot ? join(repoRoot, 'packaging') : null);
  const checks: Array<Promise<SelftestCheck>> = [
    check('node', async () => {
      const major = Number(process.versions.node.split('.')[0]);
      if (major !== 24) throw new Error(`Node ${process.version}; MineVibe ships Node 24`);
      return `${process.version} (${process.platform}-${process.arch})`;
    }),
    check('server', async () => {
      if (!layout) return `${SERVER_VERSION} (dev checkout, not MineVibe.app)`;
      const info = await readBuildInfo(layout.buildInfo);
      if (!info) return `${SERVER_VERSION} (no build-info.json)`;
      return `${SERVER_VERSION} (${info.commit ?? 'unknown commit'}, built ${info.built ?? '?'}, ${info.channel})`;
    }),
    check('mods.lock', async () => {
      if (!resources) throw new Error('no resources folder');
      const lock = await loadModsLock(join(resources, 'mods.lock.json'));
      return `${lock.mods.length} mods for Minecraft ${lock.minecraft} (Fabric loader ${lock.loader})`;
    }),
    check('seed configs', async () => {
      if (!resources) throw new Error('no resources folder');
      const files = (await readdir(join(resources, 'seed-configs'))).filter((f) => f.endsWith('.json'));
      if (files.length === 0) throw new Error('seed-configs holds no .json files');
      return files.sort().join(', ');
    }),
    check('mod jar', async () => {
      const jar = layout
        ? await findBundledModJar(layout.modResources)
        : repoRoot
          ? await findDevModJar(repoRoot)
          : null;
      if (!jar) throw new Error('minevibe-<version>.jar not found');
      if (!(await isZip(jar))) throw new Error(`${jar} is not a jar`);
      return jar;
    }),
    check('java', async () => {
      const java = (options.bundledJava ?? bundledJavaPath)();
      if (!java) {
        if (!layout) return 'dev: resolved at launch (MINEVIBE_JAVA or Mojang runtime)';
        throw new Error('the bundled JRE is missing (Contents/Runtime/jre/bin/MineVibe)');
      }
      const v = await (options.probe ?? probeJava)(java);
      if (v.major !== JAVA_FOR_26_3.majorVersion) throw new Error(`${java} is Java ${v.version}, not 25`);
      return `${v.version} (${java})`;
    }),
    check('platform', async () => {
      const [silicon, macos] = await Promise.all([
        (options.appleSilicon ?? isAppleSilicon)(),
        (options.macosVersion ?? readMacosVersion)(),
      ]);
      if (!silicon) throw new Error('not an Apple silicon Mac');
      const major = macosMajor(macos);
      if (major === null || major < MIN_MACOS_MAJOR)
        throw new Error(`macOS ${macos ?? '?'}; MineVibe needs ${MIN_MACOS_MAJOR} or later`);
      return `Apple silicon, macOS ${macos}`;
    }),
    check('container', async () => {
      if (!layout) return 'dev: not bundled';
      // The bundled lock is what the app checks the install root against at every start (it never provisions it).
      const lock = await readContainerLock(layout.vendorLock);
      const problems = await installRootMismatches(layout.containerInstallRoot, lock);
      if (problems.length > 0) throw new Error(problems.slice(0, 5).join('; '));
      for (const rel of ['bin/container', 'bin/container-apiserver']) {
        const bin = join(layout.containerInstallRoot, ...rel.split('/'));
        if (!(await isExecutable(bin))) throw new Error(`not executable: ${bin}`);
      }
      return `${lock.version}, ${Object.keys(lock.installRootFiles ?? {}).length} files as pinned (${layout.containerInstallRoot})`;
    }),
    check('linux-pc image', async () => {
      const context = layout?.linuxPcContext ?? (repoRoot ? join(repoRoot, 'images', 'linux-pc') : null);
      if (!context) throw new Error('no build context');
      const file = await readFile(join(context, 'Containerfile'), 'utf8');
      const from = /^FROM\s+(\S+)/m.exec(file)?.[1];
      if (!from?.includes('@sha256:'))
        throw new Error(`Containerfile base is not pinned by digest (${from ?? 'no FROM'})`);
      if (!(await isExecutable(join(context, 'minevibe-entrypoint.sh'))))
        throw new Error('minevibe-entrypoint.sh is missing or not executable');
      return `built on first run from ${from.split('@')[0]}`;
    }),
    check('data', async () => resolvePaths({ env }).appSupport),
  ];
  return Promise.all(checks);
}
