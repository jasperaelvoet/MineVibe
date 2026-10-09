// Assembles dist/MineVibe.app (PLAN §9.1, packaging/README.md). macOS on Apple Silicon only.
//
//   npm run build:app [-- --out <dir>] [--identity auto|adhoc|<name or SHA-1>] [--mod-jar <path>]
//                         [--skip-mod-build] [--skip-server-build] [--cache <dir>] [--channel dev|release]
//
// Independent steps run in parallel: the three vendor downloads (sha256-pinned in vendor.lock.json, cached), the
// server bundle, the mod jar (Gradle) and the Swift stub. Vendor files are copied byte-identically and checked
// against their sources and team IDs; only the stub (the bundle's main executable) is signed by us.
import { chmod, copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { BUNDLE_LAYOUT, MOD_JAR_RE } from '../apps/server/src/app/appLayout.js';
import { run, runCommand } from './lib/exec.js';
import { compareTrees, ensureDownloaded, isMachO, sha256File, snapshotTree, treeSize } from './lib/files.js';
import { writePlaceholderIconset } from './lib/icon.js';
import { renderInfoPlist } from './lib/infoPlist.js';
import { copyProductionPackages, productionPackages, releasePrunedFiles } from './lib/prodDeps.js';
import { chooseIdentity, parseIdentities } from './lib/signing.js';
import {
  archiveFileName,
  checkInstallRoot,
  loadVendorLock,
  type TarVendorEntry,
  type VendorLock,
} from './lib/vendorLock.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SWIFTC_ARGS = ['-O', '-parse-as-library', '-target', 'arm64-apple-macos26.0'];
/**
 * `images/linux-pc`: everything the image build needs, and nothing else (it is the build context). `android` is also
 * read at run time: PcManager installs it into every PC with an Android phone (PLAN §8.7).
 */
const LINUX_PC_CONTEXT = ['Containerfile', 'minevibe-entrypoint.sh', 'sudoers-minevibe', 'android'] as const;

const started = performance.now();
const say = (message: string) => {
  const s = ((performance.now() - started) / 1000).toFixed(1).padStart(5);
  process.stderr.write(`[build-app ${s}s] ${message}\n`);
};

async function step<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const t = performance.now();
  const result = await fn();
  say(`${name}: done in ${((performance.now() - t) / 1000).toFixed(1)} s`);
  return result;
}

function mib(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

// --- vendors ---------------------------------------------------------------------------------------------------

interface Vendors {
  /** The extracted `bin/node`. */
  readonly node: string;
  /** The extracted JRE home (`Contents/Home`). */
  readonly jreHome: string;
  /** The pkg payload root (`bin/`, `libexec/`). */
  readonly containerRoot: string;
}

async function fetchVendor(
  label: string,
  item: { url: string; size: number; sha256: string; fileName: string },
  cache: string,
): Promise<string> {
  const { path, downloaded } = await ensureDownloaded(item, cache, {
    userAgent: 'MineVibe-packaging (+https://github.com/jasperaelvoet/MineVibe)',
  });
  say(`${label}: ${downloaded ? 'downloaded' : 'cached'}, sha256 ok`);
  return path;
}

const fetchTarVendor = (entry: TarVendorEntry, cache: string) =>
  fetchVendor(
    `${entry.name} ${entry.version}`,
    { url: entry.url, size: entry.size, sha256: entry.sha256, fileName: archiveFileName(entry) },
    cache,
  );

/** Checks the pkg's installer signature against the lock (`pkgutil --check-signature`). */
async function checkPkgSignature(pkg: string, signer: string): Promise<void> {
  const { stdout } = await run('pkgutil', ['--check-signature', pkg]);
  if (!/Status: signed by a developer certificate issued by Apple for distribution/.test(stdout)) {
    throw new Error(`${basename(pkg)} is not signed for distribution:\n${stdout}`);
  }
  const first = /^\s*1\.\s+(.+?)\s*$/m.exec(stdout)?.[1];
  if (first !== signer)
    throw new Error(`${basename(pkg)} is signed by "${first}", the lock expects "${signer}"`);
}

async function prepareVendors(lock: VendorLock, cache: string, work: string): Promise<Vendors> {
  const vendorDir = join(work, 'vendor');
  const node = (async () => {
    const archive = await fetchTarVendor(lock.node, cache);
    const dir = join(vendorDir, 'node');
    await mkdir(dir, { recursive: true });
    await run('tar', ['-xzf', archive, '-C', dir, lock.node.extract]);
    return join(dir, ...lock.node.extract.split('/'));
  })();
  const jre = (async () => {
    const archive = await fetchTarVendor(lock.jre, cache);
    const dir = join(vendorDir, 'jre');
    await mkdir(dir, { recursive: true });
    await run('tar', ['-xzf', archive, '-C', dir]);
    return join(dir, ...lock.jre.extract.split('/'));
  })();
  const container = (async () => {
    const { pkg: pin } = lock.container;
    const pkg = await fetchVendor(
      `Apple container ${lock.container.version}`,
      { url: pin.url, size: pin.size, sha256: pin.sha256, fileName: pin.name },
      cache,
    );
    await checkPkgSignature(pkg, lock.container.signer);
    const dir = join(vendorDir, 'container-pkg'); // pkgutil wants a path that does not exist yet
    await run('pkgutil', ['--expand-full', pkg, dir]);
    const payload = join(dir, 'Payload');
    await stat(join(payload, 'bin', 'container'));
    // The same install root the PC manager provisions in dev: Apple's update/uninstall scripts are left out.
    for (const rel of lock.container.exclude)
      await rm(join(payload, ...rel.split('/')), { recursive: true, force: true });
    return payload;
  })();
  const [nodeBin, jreHome, containerRoot] = await Promise.all([node, jre, container]);
  return { node: nodeBin, jreHome, containerRoot };
}

/** `codesign -dv` of a vendor Mach-O: valid, and signed by the team the lock names. */
async function checkVendorSignature(path: string, teamId: string): Promise<void> {
  await run('codesign', ['--verify', '--strict', path]);
  const { stderr } = await run('codesign', ['-dv', path]);
  const team = /^TeamIdentifier=(\S+)$/m.exec(stderr)?.[1];
  if (team !== teamId)
    throw new Error(`${path} is signed by team ${team ?? '(none)'}, the lock expects ${teamId}`);
}

/** Every Mach-O under `root` (vendor trees), checked with {@link checkVendorSignature}. */
async function checkVendorTree(root: string, teamId: string): Promise<number> {
  const machOs: string[] = [];
  for (const e of await snapshotTree(root)) {
    if (e.kind === 'file' && (await isMachO(join(root, ...e.rel.split('/')))))
      machOs.push(join(root, ...e.rel.split('/')));
  }
  const queue = [...machOs];
  await Promise.all(
    Array.from({ length: 8 }, async () => {
      for (let next = queue.shift(); next; next = queue.shift()) await checkVendorSignature(next, teamId);
    }),
  );
  return machOs.length;
}

// --- our parts --------------------------------------------------------------------------------------------------

async function buildServer(skip: boolean): Promise<string> {
  const dist = join(repoRoot, 'apps', 'server', 'dist');
  if (!skip) await run('npm', ['run', 'build', '--workspace', '@minevibe/server'], { cwd: repoRoot });
  await stat(join(dist, 'main.mjs'));
  return dist;
}

async function serverProductionPackages(): Promise<string[]> {
  const { stdout } = await run(
    'npm',
    ['ls', '--omit=dev', '--workspace', '@minevibe/server', '--all', '--parseable'],
    { cwd: repoRoot },
  );
  return productionPackages(stdout, repoRoot);
}

async function newestJar(dir: string): Promise<string | null> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return null;
  }
  const jars = names.filter((n) => MOD_JAR_RE.test(n) && !/-(sources|dev|javadoc)\.jar$/.test(n));
  const timed = await Promise.all(jars.map(async (n) => ({ n, t: (await stat(join(dir, n))).mtimeMs })));
  timed.sort((a, b) => b.t - a.t);
  return timed[0] ? join(dir, timed[0].n) : null;
}

async function resolveModJar(explicit: string | undefined, skipBuild: boolean): Promise<string> {
  if (explicit) {
    const path = resolve(explicit);
    if (!MOD_JAR_RE.test(basename(path)))
      throw new Error(`--mod-jar must be named minevibe-<version>.jar: ${path}`);
    await stat(path);
    return path;
  }
  const modDir = join(repoRoot, 'apps', 'mod');
  if (!skipBuild)
    await run('./gradlew', ['jar', '--console=plain'], { cwd: modDir, echo: 'gradle', timeoutMs: 1_200_000 });
  const jar = await newestJar(join(modDir, 'build', 'libs'));
  if (!jar)
    throw new Error('no apps/mod/build/libs/minevibe-<version>.jar (build it: cd apps/mod && ./gradlew jar)');
  return jar;
}

async function compileStub(work: string): Promise<string> {
  const out = join(work, 'stub', 'MineVibe');
  await mkdir(dirname(out), { recursive: true });
  await run('xcrun', [
    'swiftc',
    ...SWIFTC_ARGS,
    '-o',
    out,
    join(repoRoot, 'apps', 'launcher-mac', 'MineVibe.swift'),
  ]);
  return out;
}

async function gitInfo(): Promise<{ commit: string; build: string }> {
  const rev = await runCommand('git', ['rev-parse', '--short=10', 'HEAD'], { cwd: repoRoot });
  const count = await runCommand('git', ['rev-list', '--count', 'HEAD'], { cwd: repoRoot });
  const dirty = await runCommand('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: repoRoot });
  const commit = rev.code === 0 ? rev.stdout.trim() : 'unknown';
  return {
    commit: commit + (dirty.code === 0 && dirty.stdout.trim() !== '' ? '-dirty' : ''),
    build: count.code === 0 && /^\d+$/.test(count.stdout.trim()) ? count.stdout.trim() : '0',
  };
}

async function modVersion(): Promise<string> {
  const props = await readFile(join(repoRoot, 'apps', 'mod', 'gradle.properties'), 'utf8');
  const version = /^version=(.+)$/m.exec(props)?.[1]?.trim();
  if (!version) throw new Error('apps/mod/gradle.properties has no version=');
  return version;
}

// --- signing ----------------------------------------------------------------------------------------------------

async function sign(app: string, requested: string): Promise<string> {
  const adhoc = async () => {
    await run('codesign', ['--force', '--sign', '-', '--options', 'runtime', '--timestamp=none', app]);
    return 'ad hoc';
  };
  if (requested === 'adhoc' || requested === '-') return adhoc();
  let identity: { hash: string; name: string } | null = null;
  if (requested === 'auto') {
    const found = await runCommand('security', ['find-identity', '-v', '-p', 'codesigning']);
    identity = found.code === 0 ? chooseIdentity(parseIdentities(found.stdout)) : null;
    if (!identity) {
      say('no Apple Development identity in the keychain: signing ad hoc');
      return adhoc();
    }
  } else {
    identity = { hash: requested, name: requested };
  }
  say(`signing the stub with "${identity.name}" (macOS may ask once for keychain access)`);
  // A keychain prompt nobody answers must not hang the build forever.
  const result = await runCommand(
    'codesign',
    ['--force', '--sign', identity.hash, '--options', 'runtime', '--timestamp=none', app],
    { timeoutMs: 120_000 },
  ).catch((err: unknown) => ({ code: -1, stdout: '', stderr: String(err) }));
  if (result.code === 0) return identity.name;
  if (requested !== 'auto')
    throw new Error(`codesign with ${identity.name} failed:\n${result.stderr.trim()}`);
  say(
    `signing with "${identity.name}" failed (${result.stderr.trim().split('\n').pop()}); signing ad hoc instead`,
  );
  return adhoc();
}

// --- main -------------------------------------------------------------------------------------------------------

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      out: { type: 'string', default: 'dist' },
      identity: { type: 'string', default: process.env.MINEVIBE_SIGN_IDENTITY ?? 'auto' },
      'mod-jar': { type: 'string' },
      'skip-mod-build': { type: 'boolean', default: false },
      'skip-server-build': { type: 'boolean', default: false },
      cache: {
        type: 'string',
        default:
          process.env.MINEVIBE_VENDOR_CACHE ?? join(homedir(), 'Library', 'Caches', 'MineVibe-dev', 'vendor'),
      },
      // dev: keeps the SDK's own claude (MINEVIBE_CLAUDE=bundled works); release: prunes it (PLAN §9.1).
      channel: { type: 'string', default: 'dev' },
    },
    strict: true,
  });
  const channel = values.channel;
  if (channel !== 'dev' && channel !== 'release')
    throw new Error(`--channel must be dev or release: ${channel}`);
  if (process.platform !== 'darwin' || process.arch !== 'arm64') {
    throw new Error('MineVibe.app is built on macOS on Apple Silicon only');
  }
  const outDir = resolve(repoRoot, values.out);
  const work = join(outDir, '.build-app');
  const finalApp = join(outDir, 'MineVibe.app');
  await rm(work, { recursive: true, force: true });
  await mkdir(work, { recursive: true });
  const lock = await loadVendorLock(join(repoRoot, 'packaging', 'vendor.lock.json'));
  say(`building ${finalApp}`);

  const [vendors, serverDist, packages, modJar, stub, git, version] = await Promise.all([
    step('vendors', () => prepareVendors(lock, resolve(values.cache), work)),
    step('server bundle', () => buildServer(values['skip-server-build'])),
    step('server node_modules', serverProductionPackages),
    step('mod jar', () =>
      resolveModJar(values['mod-jar'] ?? process.env.MINEVIBE_MOD_JAR, values['skip-mod-build']),
    ),
    step('stub', () => compileStub(work)),
    gitInfo(),
    modVersion(),
  ]);

  const app = join(work, 'MineVibe.app');
  const at = (rel: string) => join(app, ...rel.split('/'));
  await step('assemble', async () => {
    const contents = join(app, 'Contents');
    await mkdir(join(contents, 'MacOS'), { recursive: true });
    await mkdir(join(contents, 'Resources'), { recursive: true });
    await mkdir(join(contents, 'Runtime'), { recursive: true });

    const template = await readFile(join(repoRoot, 'apps', 'launcher-mac', 'Info.plist'), 'utf8');
    await writeFile(
      join(contents, 'Info.plist'),
      renderInfoPlist(template, { VERSION: version, BUILD: git.build, COMMIT: git.commit }),
    );
    await run('plutil', ['-lint', join(contents, 'Info.plist')]);
    await writeFile(join(contents, 'PkgInfo'), 'APPL????');

    await copyFile(stub, at(BUNDLE_LAYOUT.stub));
    await chmod(at(BUNDLE_LAYOUT.stub), 0o755);
    // Vendor code: ditto keeps bytes, modes, symlinks and extended attributes.
    await run('ditto', [vendors.node, at(BUNDLE_LAYOUT.node)]);
    await run('ditto', [vendors.jreHome, at(BUNDLE_LAYOUT.jre)]);
    await run('ditto', [vendors.containerRoot, at(BUNDLE_LAYOUT.container)]);

    // The server: the esbuild bundle (+ map, legal notices) and its production node_modules.
    const server = at(BUNDLE_LAYOUT.server);
    await mkdir(join(server, 'dist'), { recursive: true });
    for (const name of await readdir(serverDist))
      await copyFile(join(serverDist, name), join(server, 'dist', name));
    const serverPkg = JSON.parse(
      await readFile(join(repoRoot, 'apps', 'server', 'package.json'), 'utf8'),
    ) as {
      version: string;
    };
    await writeFile(
      join(server, 'package.json'),
      `${JSON.stringify({ name: 'minevibe-server', version: serverPkg.version, private: true, type: 'module' }, null, 2)}\n`,
    );
    const pruned = channel === 'release' ? releasePrunedFiles(packages) : [];
    await copyProductionPackages(repoRoot, packages, server, pruned);
    if (pruned.length > 0) say(`release: left out ${pruned.join(', ')}`);

    // The mod, its lock and the seeded configs (MINEVIBE_RESOURCES).
    const mod = at(BUNDLE_LAYOUT.mod);
    await mkdir(join(mod, 'seed-configs'), { recursive: true });
    await copyFile(modJar, join(mod, basename(modJar)));
    await copyFile(join(repoRoot, 'packaging', 'mods.lock.json'), join(mod, 'mods.lock.json'));
    const seeds = join(repoRoot, 'packaging', 'seed-configs');
    for (const name of await readdir(seeds)) {
      if (name.endsWith('.json')) await copyFile(join(seeds, name), join(mod, 'seed-configs', name));
    }

    // The pins the running app checks its read-only container install root against (it never provisions it).
    await copyFile(join(repoRoot, 'packaging', 'vendor.lock.json'), at(BUNDLE_LAYOUT.vendorLock));
    // The Linux PC image's build context: built on first run until the GHCR image is published (PLAN §9.3).
    const linuxPc = at(BUNDLE_LAYOUT.linuxPc);
    await mkdir(linuxPc, { recursive: true });
    for (const name of LINUX_PC_CONTEXT) {
      const src = join(repoRoot, 'images', 'linux-pc', name);
      await copyFile(src, join(linuxPc, name));
      await chmod(join(linuxPc, name), (await stat(src)).mode & 0o777);
    }

    const legal = join(contents, 'Resources', 'legal');
    await mkdir(legal, { recursive: true });
    for (const name of ['LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.md']) {
      await copyFile(join(repoRoot, name), join(legal, name));
    }

    const iconset = await writePlaceholderIconset(join(work, 'icon'));
    await run('iconutil', ['-c', 'icns', iconset, '-o', at(BUNDLE_LAYOUT.icon)]);

    await writeFile(
      at(BUNDLE_LAYOUT.buildInfo),
      `${JSON.stringify(
        {
          version,
          build: git.build,
          commit: git.commit,
          built: new Date().toISOString(),
          server: serverPkg.version,
          channel,
          modJar: basename(modJar),
          vendors: {
            node: lock.node.version,
            jre: lock.jre.version,
            container: lock.container.version,
          },
        },
        null,
        2,
      )}\n`,
    );
  });

  await step('verify vendor copies', async () => {
    const problems = [
      ...(await compareTrees(vendors.jreHome, at(BUNDLE_LAYOUT.jre))),
      ...(await compareTrees(vendors.containerRoot, at(BUNDLE_LAYOUT.container))),
    ];
    if ((await sha256File(vendors.node)) !== (await sha256File(at(BUNDLE_LAYOUT.node))))
      problems.push('node differs');
    // The install root must be exactly what the lock pins, or the PC manager's isProvisioned() fails and it would
    // try to provision (write) inside the signed bundle.
    const installRoot = new Map(
      (await snapshotTree(at(BUNDLE_LAYOUT.container)))
        .filter((e) => e.kind === 'file')
        .map((e) => [e.rel, e.content] as const),
    );
    problems.push(...checkInstallRoot(installRoot, lock.container.installRootFiles));
    if (problems.length > 0)
      throw new Error(`vendor copies differ from their pins:\n${problems.slice(0, 20).join('\n')}`);
    // The Dock shows the JVM's executable name: bin/MineVibe is a byte-identical copy of bin/java.
    const java = join(at(BUNDLE_LAYOUT.jre), 'bin', 'java');
    const renamed = join(at(BUNDLE_LAYOUT.jre), 'bin', 'MineVibe');
    await copyFile(java, renamed);
    await chmod(renamed, (await stat(java)).mode & 0o777);
    await checkVendorSignature(at(BUNDLE_LAYOUT.node), lock.node.teamId);
    const jreBins = await checkVendorTree(at(BUNDLE_LAYOUT.jre), lock.jre.teamId);
    const containerBins = await checkVendorTree(at(BUNDLE_LAYOUT.container), lock.container.teamId);
    const nodeVersion = (await run(at(BUNDLE_LAYOUT.node), ['--version'])).stdout.trim();
    if (nodeVersion !== `v${lock.node.version}`) throw new Error(`bundled node says ${nodeVersion}`);
    const javaVersion = (await run(renamed, ['-version'])).stderr;
    if (!javaVersion.includes(`"${lock.jre.javaVersion}"`))
      throw new Error(`bundled java says ${javaVersion}`);
    say(
      `vendor code intact: node ${nodeVersion}, Java ${lock.jre.javaVersion} (${jreBins} Mach-O), container ${lock.container.version} (${containerBins} Mach-O)`,
    );
  });

  const signedWith = await step('sign', () => sign(app, values.identity));
  await step('verify signature', () =>
    run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app]),
  );

  await rm(finalApp, { recursive: true, force: true });
  await rename(app, finalApp);
  await rm(work, { recursive: true, force: true });
  say(
    `MineVibe.app ${version} (${git.commit}, ${channel}) ready: ${finalApp}, ${mib(await treeSize(finalApp))}, signed ${signedWith}`,
  );
  say(`self-test: ${join(finalApp, 'Contents', 'MacOS', 'MineVibe')} --selftest`);
}

main().catch((err: unknown) => {
  say(`FAILED: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
