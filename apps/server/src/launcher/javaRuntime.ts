import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, lstat, mkdir, readFile, readlink, rm, symlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { Logger } from 'pino';
import { z } from 'zod';
import { writeFileAtomic } from '../util/atomicFile.js';
import {
  downloadVerified,
  type FetchLike,
  fileMatches,
  fileSize,
  launcherFetch,
  mapLimit,
} from './download.js';

/** Overrides the Java used to launch the game (absolute path to a `java` binary). */
export const JAVA_ENV = 'MINEVIBE_JAVA';

/** Mojang's Java runtime index (the same one the official launcher reads). */
export const JAVA_RUNTIME_INDEX_URL =
  'https://launchermeta.mojang.com/v1/products/java-runtime/2ec0cc96c44e5a76b9c8b7c39df7210883d12871/all.json';

/** What a Minecraft version JSON asks for (`javaVersion`). */
export interface JavaRequirement {
  readonly component: string;
  readonly majorVersion: number;
}

/** Minecraft 26.3's `javaVersion` (checked against the version JSON after install). */
export const JAVA_FOR_26_3: JavaRequirement = { component: 'java-runtime-epsilon', majorVersion: 25 };

export type JavaSource = 'env' | 'bundled' | 'mojang';

export interface ResolvedJava {
  readonly path: string;
  readonly source: JavaSource;
  /** Full version string from `java -version`, e.g. `25.0.1`. */
  readonly version: string;
  readonly major: number;
  /** True when this call downloaded the runtime. */
  readonly downloaded: boolean;
  readonly downloadedBytes: number;
}

/** Mojang's platform key for the runtime index, or null when Mojang ships no runtime for this host. */
export function mojangPlatformKey(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string | null {
  if (platform === 'darwin') return arch === 'arm64' ? 'mac-os-arm64' : arch === 'x64' ? 'mac-os' : null;
  if (platform === 'linux') return arch === 'x64' ? 'linux' : arch === 'ia32' ? 'linux-i386' : null;
  if (platform === 'win32') {
    if (arch === 'x64') return 'windows-x64';
    if (arch === 'arm64') return 'windows-arm64';
    if (arch === 'ia32') return 'windows-x86';
  }
  return null;
}

/**
 * Parses `java -version` output (it goes to stderr), e.g. `openjdk version "25.0.1" 2025-10-21 LTS` -> 25,
 * `java version "1.8.0_402"` -> 8. Returns null when no version line is found.
 */
export function parseJavaVersion(output: string): { version: string; major: number } | null {
  const m = /\bversion "([^"]+)"/.exec(output);
  if (!m?.[1]) return null;
  const version = m[1];
  const parts = version.split(/[.+_-]/);
  const first = Number(parts[0]);
  if (!Number.isInteger(first)) return null;
  const major = first === 1 ? Number(parts[1]) : first;
  if (!Number.isInteger(major) || major <= 0) return null;
  return { version, major };
}

/** Runs `<java> -version` and parses it. Throws when the binary cannot run or prints no version. */
export function probeJava(javaPath: string, timeoutMs = 20_000): Promise<{ version: string; major: number }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(javaPath, ['-version'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d: Buffer) => {
      out += d.toString('utf8');
    });
    child.stderr.on('data', (d: Buffer) => {
      out += d.toString('utf8');
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`cannot run ${javaPath}: ${err.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const parsed = parseJavaVersion(out);
      if (code !== 0 || !parsed) {
        reject(new Error(`${javaPath} -version failed (exit ${code}): ${out.trim().split('\n')[0] ?? ''}`));
        return;
      }
      resolvePromise(parsed);
    });
  });
}

/**
 * M10 stub: the JRE bundled in MineVibe.app (`Contents/Runtime/jre/bin/MineVibe`, a renamed `java`, PLAN §9.1).
 * Found when Node itself runs from `MineVibe.app/Contents/MacOS/node`. Returns null in dev.
 */
export function bundledJavaPath(execPath: string = process.execPath): string | null {
  const macos = dirname(execPath);
  if (!macos.endsWith(`${sep}Contents${sep}MacOS`)) return null;
  const home = join(dirname(macos), 'Runtime', 'jre');
  for (const name of ['MineVibe', 'java']) {
    const candidate = join(home, 'bin', name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

// --- Mojang runtime -------------------------------------------------------------------------------------

const RuntimeIndexEntry = z.object({
  manifest: z.object({
    sha1: z.string().regex(/^[0-9a-f]{40}$/),
    size: z.number().int(),
    url: z.string().url(),
  }),
  version: z.object({ name: z.string(), released: z.string().optional() }),
});
const RuntimeIndex = z.record(z.string(), z.record(z.string(), z.array(RuntimeIndexEntry)));

const RuntimeFile = z.discriminatedUnion('type', [
  z.object({ type: z.literal('directory') }),
  z.object({ type: z.literal('link'), target: z.string().min(1) }),
  z.object({
    type: z.literal('file'),
    executable: z.boolean().optional(),
    downloads: z.object({
      raw: z.object({
        sha1: z.string().regex(/^[0-9a-f]{40}$/),
        size: z.number().int().nonnegative(),
        url: z.string().url(),
      }),
    }),
  }),
]);
export const RuntimeManifest = z.object({ files: z.record(z.string(), RuntimeFile) });
export type RuntimeManifest = z.infer<typeof RuntimeManifest>;

const InstalledMarker = z.object({
  component: z.string(),
  platform: z.string(),
  version: z.string(),
  manifestSha1: z.string(),
});

const MANIFEST_FILE = '.minevibe-manifest.json';
const MARKER_FILE = '.minevibe-installed.json';

/** `<runtimeRoot>/<component>/<platform>`. */
export function runtimeDir(runtimeRoot: string, component: string, platform: string): string {
  return join(runtimeRoot, component, platform);
}

/** Path of the `java` binary inside an installed runtime, based on its manifest. */
export function javaBinaryIn(dir: string, manifest: RuntimeManifest): string {
  for (const rel of ['jre.bundle/Contents/Home/bin/java', 'bin/java', 'bin/java.exe']) {
    if (manifest.files[rel]?.type === 'file') return join(dir, ...rel.split('/'));
  }
  throw new Error('runtime manifest has no bin/java');
}

/** Rejects manifest paths that would escape the runtime directory. */
function safeJoin(dir: string, rel: string): string {
  if (isAbsolute(rel) || rel.split(/[\\/]/).includes('..')) throw new Error(`unsafe runtime path: ${rel}`);
  return join(dir, ...rel.split('/'));
}

/** Cheap check of an installed runtime against its stored manifest: sizes, exec bits and links. No hashing. */
export async function quickVerifyRuntime(dir: string, manifest: RuntimeManifest): Promise<string[]> {
  const problems: string[] = [];
  await mapLimit(Object.entries(manifest.files), 32, async ([rel, entry]) => {
    const path = safeJoin(dir, rel);
    if (entry.type === 'file') {
      const size = await fileSize(path);
      if (size !== entry.downloads.raw.size)
        problems.push(`${rel}: ${size === null ? 'missing' : 'wrong size'}`);
    } else if (entry.type === 'link') {
      try {
        if ((await readlink(path)) !== entry.target) problems.push(`${rel}: wrong link`);
      } catch {
        problems.push(`${rel}: missing link`);
      }
    }
  });
  return problems;
}

export interface InstallRuntimeOptions {
  readonly runtimeRoot: string;
  readonly requirement: JavaRequirement;
  readonly platform?: string;
  readonly log: Logger;
  readonly fetch?: FetchLike;
  readonly signal?: AbortSignal;
  readonly indexUrl?: string;
}

/**
 * Installs Mojang's runtime `requirement.component` for this platform into `<runtimeRoot>/<component>/<platform>`:
 * every file is downloaded raw and sha1-checked, executables get 0755, links are recreated. A completed install
 * leaves a marker plus the manifest, so a re-run only stats files (no network).
 */
export async function installMojangRuntime(
  options: InstallRuntimeOptions,
): Promise<{ javaPath: string; downloadedBytes: number; downloaded: boolean; version: string }> {
  const platform = options.platform ?? mojangPlatformKey();
  if (!platform) throw new Error(`Mojang ships no Java runtime for ${process.platform}/${process.arch}`);
  const { component } = options.requirement;
  const dir = runtimeDir(options.runtimeRoot, component, platform);
  const log = options.log;

  // Fast path: a completed install whose files still look right.
  try {
    const marker = InstalledMarker.parse(JSON.parse(await readFile(join(dir, MARKER_FILE), 'utf8')));
    const manifest = RuntimeManifest.parse(JSON.parse(await readFile(join(dir, MANIFEST_FILE), 'utf8')));
    if (marker.component === component && marker.platform === platform) {
      const problems = await quickVerifyRuntime(dir, manifest);
      if (problems.length === 0) {
        return {
          javaPath: javaBinaryIn(dir, manifest),
          downloadedBytes: 0,
          downloaded: false,
          version: marker.version,
        };
      }
      log.warn({ problems: problems.slice(0, 5), count: problems.length }, 'java runtime damaged; repairing');
    }
  } catch {
    // not installed yet (or unreadable marker): full install below
  }

  const doFetch = options.fetch ?? launcherFetch();
  const indexRes = await doFetch(
    options.indexUrl ?? JAVA_RUNTIME_INDEX_URL,
    options.signal ? { signal: options.signal } : {},
  );
  if (!indexRes.ok) throw new Error(`java runtime index: HTTP ${indexRes.status}`);
  const index = RuntimeIndex.parse(await indexRes.json());
  const entry = index[platform]?.[component]?.[0];
  if (!entry) throw new Error(`Mojang has no ${component} for ${platform}`);

  const manifestRes = await doFetch(entry.manifest.url, options.signal ? { signal: options.signal } : {});
  if (!manifestRes.ok) throw new Error(`java runtime manifest: HTTP ${manifestRes.status}`);
  const manifestText = Buffer.from(await manifestRes.arrayBuffer());
  const manifestSha1 = createHash('sha1').update(manifestText).digest('hex');
  if (manifestSha1 !== entry.manifest.sha1) throw new Error('java runtime manifest sha1 mismatch');
  const manifest = RuntimeManifest.parse(JSON.parse(manifestText.toString('utf8')));
  log.info({ runtime: component, platform, version: entry.version.name }, 'installing Java runtime');

  await mkdir(dir, { recursive: true });
  await rm(join(dir, MARKER_FILE), { force: true });
  const entries = Object.entries(manifest.files);
  for (const [rel, e] of entries) {
    if (e.type === 'directory') await mkdir(safeJoin(dir, rel), { recursive: true });
  }
  let downloadedBytes = 0;
  const files = entries.filter(
    (x): x is [string, Extract<(typeof x)[1], { type: 'file' }>] => x[1].type === 'file',
  );
  await mapLimit(files, 8, async ([rel, e]) => {
    const path = safeJoin(dir, rel);
    const raw = e.downloads.raw;
    const hash = { algorithm: 'sha1' as const, value: raw.sha1 };
    if (!(await fileMatches(path, { size: raw.size, hash }))) {
      const bytes = await downloadVerified(
        { url: raw.url, destination: path, size: raw.size, hash, executable: e.executable === true },
        { fetch: doFetch, ...(options.signal ? { signal: options.signal } : {}) },
      );
      // `x += await …` would read x before the await and lose concurrent updates.
      downloadedBytes += bytes;
    }
    await chmod(path, e.executable ? 0o755 : 0o644);
  });
  for (const [rel, e] of entries) {
    if (e.type !== 'link') continue;
    const path = safeJoin(dir, rel);
    const target = resolve(dirname(path), e.target);
    const inside = relative(dir, target);
    if (inside.startsWith('..') || isAbsolute(inside))
      throw new Error(`runtime link escapes its root: ${rel}`);
    try {
      const st = await lstat(path);
      if (st.isSymbolicLink() && (await readlink(path)) === e.target) continue;
      await rm(path, { force: true, recursive: true });
    } catch {
      // missing: create below
    }
    await mkdir(dirname(path), { recursive: true });
    await symlink(e.target, path);
  }

  await writeFileAtomic(join(dir, MANIFEST_FILE), manifestText.toString('utf8'));
  await writeFileAtomic(
    join(dir, MARKER_FILE),
    `${JSON.stringify({ component, platform, version: entry.version.name, manifestSha1 }, null, 2)}\n`,
  );
  return {
    javaPath: javaBinaryIn(dir, manifest),
    downloadedBytes,
    downloaded: true,
    version: entry.version.name,
  };
}

export interface ResolveJavaOptions {
  readonly runtimeRoot: string;
  readonly requirement: JavaRequirement;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly log: Logger;
  readonly fetch?: FetchLike;
  readonly signal?: AbortSignal;
  /** Test seam for {@link bundledJavaPath}. */
  readonly bundledJava?: () => string | null;
  /** Test seam for {@link probeJava}. */
  readonly probe?: (javaPath: string) => Promise<{ version: string; major: number }>;
  /** Test seam for {@link installMojangRuntime}. */
  readonly installRuntime?: typeof installMojangRuntime;
}

/**
 * Picks the Java that launches the game: `MINEVIBE_JAVA`, then the JRE bundled in MineVibe.app (M10), then
 * Mojang's runtime for the version (downloaded on first use). The chosen binary must report the required major
 * version in `java -version`; an override that is newer only logs a warning.
 */
export async function resolveJava(options: ResolveJavaOptions): Promise<ResolvedJava> {
  const env = options.env ?? process.env;
  const probe = options.probe ?? probeJava;
  const want = options.requirement.majorVersion;

  const check = async (path: string, source: JavaSource, strict: boolean) => {
    const v = await probe(path);
    if (v.major < want || (strict && v.major !== want)) {
      throw new Error(`${source} Java ${path} is ${v.version}; Minecraft needs Java ${want}`);
    }
    if (v.major !== want)
      options.log.warn({ path, version: v.version, want }, 'Java override is newer than required');
    return v;
  };

  const override = env[JAVA_ENV]?.trim();
  if (override) {
    if (!isAbsolute(override)) throw new Error(`${JAVA_ENV} must be an absolute path to a java binary`);
    const v = await check(override, 'env', false);
    return { path: override, source: 'env', ...v, downloaded: false, downloadedBytes: 0 };
  }

  const bundled = (options.bundledJava ?? bundledJavaPath)();
  if (bundled) {
    const v = await check(bundled, 'bundled', true);
    return { path: bundled, source: 'bundled', ...v, downloaded: false, downloadedBytes: 0 };
  }

  const install = options.installRuntime ?? installMojangRuntime;
  const rt = await install({
    runtimeRoot: options.runtimeRoot,
    requirement: options.requirement,
    log: options.log,
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  const v = await check(rt.javaPath, 'mojang', true);
  return {
    path: rt.javaPath,
    source: 'mojang',
    ...v,
    downloaded: rt.downloaded,
    downloadedBytes: rt.downloadedBytes,
  };
}
