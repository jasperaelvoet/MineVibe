import { constants as fsConstants } from 'node:fs';
import { copyFile, mkdir, readdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { Logger } from 'pino';
import { z } from 'zod';
import { writeFileAtomic } from '../util/atomicFile.js';
import {
  downloadVerified,
  type FetchLike,
  fetchJson,
  fileMatches,
  IntegrityError,
  launcherFetch,
  mapLimit,
} from './download.js';

export const MODRINTH_API = 'https://api.modrinth.com/v2';

const SHA512_RE = /^[0-9a-f]{128}$/;
/** A plain jar file name: no directories, no leading dot. */
const JAR_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]*\.jar$/;

export const ModLockEntry = z.object({
  slug: z.string().min(1),
  name: z.string().min(1),
  projectId: z.string().regex(/^[A-Za-z0-9]{8}$/),
  versionId: z.string().regex(/^[A-Za-z0-9]{8}$/),
  versionNumber: z.string().min(1),
  versionType: z.enum(['release', 'beta', 'alpha']),
  /** The `id` in the jar's fabric.mod.json (duplicate check). */
  modId: z.string().regex(/^[a-z][a-z0-9_-]{1,63}$/),
  filename: z.string().regex(JAR_NAME_RE),
  size: z.number().int().positive(),
  sha512: z.string().regex(SHA512_RE),
  url: z
    .string()
    .url()
    .refine((u) => new URL(u).protocol === 'https:', 'url must be https'),
  side: z.enum(['client', 'server', 'both']),
  optional: z.boolean(),
  note: z.string().optional(),
});
export type ModLockEntry = z.infer<typeof ModLockEntry>;

/** One library of Fabric's launcher profile, pinned: Maven coordinates, size and sha512. */
export const FabricLibraryPin = z.object({
  name: z.string().regex(/^[A-Za-z0-9_.+-]+:[A-Za-z0-9_.+-]+:[A-Za-z0-9_.+-]+(:[A-Za-z0-9_.+-]+)?$/),
  size: z.number().int().positive(),
  sha512: z.string().regex(SHA512_RE),
});
export type FabricLibraryPin = z.infer<typeof FabricLibraryPin>;

/** `packaging/mods.lock.json` (PLAN §10). */
export const ModsLock = z
  .object({
    $comment: z.string().optional(),
    lockVersion: z.literal(1),
    minecraft: z.string().min(1),
    loader: z.string().min(1),
    generated: z.string().optional(),
    /** Every library of the Fabric profile (the loader included), so nothing about Fabric is trusted at install time. */
    fabric: z.object({
      $comment: z.string().optional(),
      libraries: z.array(FabricLibraryPin).min(1),
    }),
    mods: z.array(ModLockEntry).min(1),
  })
  .superRefine((lock, ctx) => {
    if (!lock.fabric.libraries.some((l) => l.name === `net.fabricmc:fabric-loader:${lock.loader}`)) {
      ctx.addIssue({
        code: 'custom',
        message: `fabric.libraries must pin net.fabricmc:fabric-loader:${lock.loader}`,
      });
    }
    const names = new Set<string>();
    for (const l of lock.fabric.libraries) {
      if (names.has(l.name)) ctx.addIssue({ code: 'custom', message: `duplicate Fabric library ${l.name}` });
      names.add(l.name);
    }
    for (const key of ['versionId', 'modId', 'filename', 'slug'] as const) {
      const seen = new Set<string>();
      for (const m of lock.mods) {
        if (seen.has(m[key])) ctx.addIssue({ code: 'custom', message: `duplicate ${key} ${m[key]}` });
        seen.add(m[key]);
      }
    }
  });
export type ModsLock = z.infer<typeof ModsLock>;

export async function loadModsLock(path: string): Promise<ModsLock> {
  return ModsLock.parse(JSON.parse(await readFile(path, 'utf8')));
}

/** The non-optional mods plus the opt-ins named (by slug or mod id) in `enabled`. Unknown names throw. */
export function selectMods(lock: ModsLock, enabled: readonly string[] = []): ModLockEntry[] {
  const optional = lock.mods.filter((m) => m.optional);
  for (const name of enabled) {
    if (!optional.some((m) => m.slug === name || m.modId === name)) {
      throw new Error(`unknown opt-in mod "${name}" (opt-ins: ${optional.map((m) => m.slug).join(', ')})`);
    }
  }
  return lock.mods.filter((m) => !m.optional || enabled.includes(m.slug) || enabled.includes(m.modId));
}

// --- Modrinth API -----------------------------------------------------------------------------------------

export const ModrinthFile = z.object({
  hashes: z.object({ sha512: z.string(), sha1: z.string().optional() }).passthrough(),
  url: z.string().url(),
  filename: z.string(),
  primary: z.boolean(),
  size: z.number().int(),
});
export type ModrinthFile = z.infer<typeof ModrinthFile>;

export const ModrinthVersion = z
  .object({
    id: z.string(),
    project_id: z.string(),
    version_number: z.string(),
    files: z.array(ModrinthFile),
  })
  .passthrough();
export type ModrinthVersion = z.infer<typeof ModrinthVersion>;

/**
 * The version's primary file. Modrinth flags at most one file `primary`; with none flagged, the first file is
 * the primary one (API docs). Never picks a secondary file (sources, dev jars, other loaders).
 */
export function primaryFile(version: Pick<ModrinthVersion, 'files'>): ModrinthFile | undefined {
  return version.files.find((f) => f.primary) ?? version.files[0];
}

/** `GET /v2/versions?ids=[…]` URL for a set of version ids. */
export function versionsUrl(versionIds: readonly string[], api = MODRINTH_API): string {
  return `${api}/versions?ids=${encodeURIComponent(JSON.stringify(versionIds))}`;
}

/**
 * Checks Modrinth's answer against the lock: every pinned version must be present, belong to the pinned
 * project, and have a primary file whose name, size and sha512 equal the lock's. Returns the download URL per
 * version id. Throws on the first discrepancy; a lock is never "updated" at runtime.
 */
export function verifyAgainstLock(
  entries: readonly ModLockEntry[],
  response: readonly ModrinthVersion[],
): Map<string, string> {
  const byId = new Map(response.map((v) => [v.id, v]));
  const urls = new Map<string, string>();
  for (const m of entries) {
    const v = byId.get(m.versionId);
    if (!v) throw new Error(`Modrinth did not return ${m.name} version ${m.versionId}`);
    if (v.project_id !== m.projectId) {
      throw new Error(
        `${m.name}: version ${m.versionId} belongs to project ${v.project_id}, not ${m.projectId}`,
      );
    }
    const file = primaryFile(v);
    if (!file) throw new Error(`${m.name}: version ${m.versionId} has no files`);
    if (file.filename !== m.filename) {
      throw new Error(`${m.name}: primary file is ${file.filename}, lock says ${m.filename}`);
    }
    if (file.size !== m.size)
      throw new Error(`${m.name}: primary file is ${file.size} bytes, lock says ${m.size}`);
    if (file.hashes.sha512.toLowerCase() !== m.sha512)
      throw new Error(`${m.name}: sha512 differs from the lock`);
    const url = new URL(file.url);
    if (url.protocol !== 'https:') throw new Error(`${m.name}: refusing non-https download ${file.url}`);
    urls.set(m.versionId, file.url);
  }
  return urls;
}

// --- Installer ----------------------------------------------------------------------------------------------

/** Content-addressed cache entry: `<cacheDir>/<sha512>.jar`. */
export function cachePath(cacheDir: string, sha512: string): string {
  if (!SHA512_RE.test(sha512)) throw new Error('bad sha512');
  return join(cacheDir, `${sha512}.jar`);
}

/** A jar placed in `mods/` that is not from Modrinth (the MineVibe mod in dev). */
export interface ExtraJar {
  readonly source: string;
  readonly filename: string;
  readonly modId: string;
}

export interface InstallModsOptions {
  readonly lock: ModsLock;
  readonly enabledOptional?: readonly string[];
  readonly cacheDir: string;
  readonly modsDir: string;
  readonly extraJars?: readonly ExtraJar[];
  readonly log: Logger;
  readonly fetch?: FetchLike;
  readonly signal?: AbortSignal;
  readonly api?: string;
}

export interface InstallModsResult {
  readonly mods: readonly ModLockEntry[];
  readonly downloaded: number;
  readonly downloadedBytes: number;
  readonly apiCalls: number;
  readonly removed: readonly string[];
  /** Jars MineVibe did not place, moved out of `mods/` into {@link quarantineDir} (file names before the move). */
  readonly quarantined: readonly string[];
}

/** `<game>/mods-quarantine`: where jars MineVibe does not manage are moved, next to `mods/`. */
export function quarantineDir(modsDir: string): string {
  return join(dirname(modsDir), 'mods-quarantine');
}

const MANAGED_FILE = '.minevibe-managed.json';
const Managed = z.object({ files: z.array(z.string()) });

/**
 * Lock-driven mod installer (PLAN §10). Every jar lives in a content-addressed cache keyed by sha512; cached
 * jars are re-verified (size + sha512) before use. Missing ones cost exactly one `GET /v2/versions?ids=[…]`,
 * whose answer is checked against the lock, then each primary file is streamed to `.part` with size and
 * sha512 verification. `mods/` then holds exactly the selected jars (plus `extraJars`): jars MineVibe placed
 * earlier but no longer wants are removed, and any other jar is moved to `mods-quarantine/` (a stray copy of a
 * mod the lock also provides, e.g. after the managed list was lost and the lock moved on, would otherwise crash
 * Fabric with a duplicate mod id).
 */
export async function installMods(options: InstallModsOptions): Promise<InstallModsResult> {
  const { cacheDir, modsDir, log } = options;
  const mods = selectMods(options.lock, options.enabledOptional);
  const extras = options.extraJars ?? [];
  const modIds = new Set<string>();
  for (const id of [...mods.map((m) => m.modId), ...extras.map((e) => e.modId)]) {
    if (modIds.has(id)) throw new Error(`two jars provide mod id ${id}`);
    modIds.add(id);
  }

  await mkdir(cacheDir, { recursive: true });
  await mkdir(modsDir, { recursive: true });

  const missing: ModLockEntry[] = [];
  for (const m of mods) {
    const cached = cachePath(cacheDir, m.sha512);
    if (!(await fileMatches(cached, { size: m.size, hash: { algorithm: 'sha512', value: m.sha512 } }))) {
      await rm(cached, { force: true });
      missing.push(m);
    }
  }

  let downloadedBytes = 0;
  let apiCalls = 0;
  if (missing.length > 0) {
    const doFetch = options.fetch ?? launcherFetch();
    const raw = await fetchJson<unknown>(
      versionsUrl(
        missing.map((m) => m.versionId),
        options.api,
      ),
      {
        fetch: doFetch,
        ...(options.signal ? { signal: options.signal } : {}),
      },
    );
    apiCalls++;
    const urls = verifyAgainstLock(missing, z.array(ModrinthVersion).parse(raw));
    log.info({ count: missing.length, mods: missing.map((m) => m.slug) }, 'downloading mods from Modrinth');
    await mapLimit(missing, 4, async (m) => {
      const bytes = await downloadVerified(
        {
          url: urls.get(m.versionId) ?? m.url,
          destination: cachePath(cacheDir, m.sha512),
          size: m.size,
          hash: { algorithm: 'sha512', value: m.sha512 },
        },
        { fetch: doFetch, ...(options.signal ? { signal: options.signal } : {}) },
      );
      // `x += await …` would read x before the await and lose concurrent updates.
      downloadedBytes += bytes;
    });
  }

  const wanted = new Map<string, { source: string; size?: number; sha512?: string }>();
  for (const m of mods)
    wanted.set(m.filename, { source: cachePath(cacheDir, m.sha512), size: m.size, sha512: m.sha512 });
  for (const e of extras) {
    if (!JAR_NAME_RE.test(e.filename)) throw new Error(`bad jar name ${e.filename}`);
    if (wanted.has(e.filename)) throw new Error(`jar name collision: ${e.filename}`);
    wanted.set(e.filename, { source: e.source });
  }

  for (const [filename, w] of wanted) {
    const dest = join(modsDir, filename);
    const ok =
      w.sha512 !== undefined
        ? await fileMatches(dest, { size: w.size, hash: { algorithm: 'sha512', value: w.sha512 } })
        : await sameBytes(w.source, dest);
    if (ok) continue;
    const part = `${dest}.part`;
    await copyFile(w.source, part, fsConstants.COPYFILE_FICLONE);
    if (
      w.sha512 !== undefined &&
      !(await fileMatches(part, { size: w.size, hash: { algorithm: 'sha512', value: w.sha512 } }))
    ) {
      await rm(part, { force: true });
      throw new IntegrityError(dest, `${filename}: copy from cache failed verification`);
    }
    await rename(part, dest);
  }

  // Remove jars this installer placed before and no longer wants; report jars it never placed.
  const managedPath = join(modsDir, MANAGED_FILE);
  let previous: string[] = [];
  try {
    previous = Managed.parse(JSON.parse(await readFile(managedPath, 'utf8'))).files;
  } catch {
    // first run
  }
  const removed: string[] = [];
  for (const f of previous) {
    if (!wanted.has(f) && JAR_NAME_RE.test(f)) {
      await rm(join(modsDir, f), { force: true });
      removed.push(f);
    }
  }
  await writeFileAtomic(managedPath, `${JSON.stringify({ files: [...wanted.keys()].sort() }, null, 2)}\n`);
  if (removed.length > 0) log.info({ removed }, 'removed mods no longer in the lock');
  const unmanaged = (await readdir(modsDir)).filter(
    (f) => f.toLowerCase().endsWith('.jar') && !wanted.has(f) && !removed.includes(f),
  );
  if (unmanaged.length > 0) {
    const quarantine = quarantineDir(modsDir);
    await mkdir(quarantine, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    for (const f of unmanaged) await rename(join(modsDir, f), join(quarantine, `${stamp}-${f}`));
    log.warn(
      { quarantined: unmanaged, to: quarantine },
      'moved jars MineVibe does not manage out of mods/ (the game only loads the locked set)',
    );
  }

  return { mods, downloaded: missing.length, downloadedBytes, apiCalls, removed, quarantined: unmanaged };
}

async function sameBytes(a: string, b: string): Promise<boolean> {
  try {
    const [x, y] = await Promise.all([readFile(a), readFile(b)]);
    return x.equals(y);
  } catch {
    return false;
  }
}

/** The dev build of the MineVibe mod: `apps/mod/build/libs/minevibe-<version>.jar` (not `-sources`/`-dev`). */
export async function findDevModJar(repoRoot: string): Promise<string | null> {
  const libs = join(repoRoot, 'apps', 'mod', 'build', 'libs');
  let names: string[];
  try {
    names = await readdir(libs);
  } catch {
    return null;
  }
  const jars = names.filter(
    (n) => /^minevibe-\d[\w.+-]*\.jar$/.test(n) && !/-(sources|dev|javadoc)\.jar$/.test(n),
  );
  if (jars.length === 0) return null;
  // Several versions can sit in build/libs after a version bump: the most recently built one wins.
  const withTimes = await Promise.all(
    jars.map(async (n) => ({ path: join(libs, n), mtime: (await stat(join(libs, n))).mtimeMs })),
  );
  withTimes.sort((a, b) => b.mtime - a.mtime);
  return withTimes[0]?.path ?? null;
}

export function extraJarFor(path: string, modId: string): ExtraJar {
  return { source: path, filename: basename(path), modId };
}
