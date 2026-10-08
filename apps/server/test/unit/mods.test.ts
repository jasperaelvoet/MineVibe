import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { IntegrityError } from '../../src/launcher/download.js';
import {
  cachePath,
  installMods,
  loadModsLock,
  type ModLockEntry,
  type ModrinthVersion,
  ModsLock,
  primaryFile,
  quarantineDir,
  selectMods,
  verifyAgainstLock,
  versionsUrl,
} from '../../src/launcher/mods.js';
import { silentLogger } from '../../src/log.js';

const LOCK_PATH = fileURLToPath(new URL('../../../../packaging/mods.lock.json', import.meta.url));

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'mv-mods-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const sha512 = (b: Buffer) => createHash('sha512').update(b).digest('hex');

/** A fake mod: jar bytes plus its lock entry and Modrinth version. */
function fakeMod(slug: string, n: number, overrides: Partial<ModLockEntry> = {}) {
  const bytes = Buffer.from(`fake jar ${slug} `.repeat(50 + n));
  const versionId = `VER${String(n).padStart(5, '0')}`;
  const projectId = `PRJ${String(n).padStart(5, '0')}`;
  const filename = `${slug}-1.0.${n}.jar`;
  const url = `https://cdn.example.test/${projectId}/${versionId}/${filename}`;
  const entry: ModLockEntry = {
    slug,
    name: slug,
    projectId,
    versionId,
    versionNumber: `1.0.${n}`,
    versionType: 'release',
    modId: `${slug.replaceAll('-', '_')}_mod`,
    filename,
    size: bytes.length,
    sha512: sha512(bytes),
    url,
    side: 'client',
    optional: false,
    ...overrides,
  };
  const version: ModrinthVersion = {
    id: versionId,
    project_id: projectId,
    version_number: entry.versionNumber,
    files: [
      {
        hashes: { sha512: 'f'.repeat(128) },
        url: `${url}.sources`,
        filename: `${slug}-sources.jar`,
        primary: false,
        size: 3,
      },
      { hashes: { sha512: entry.sha512 }, url, filename, primary: true, size: bytes.length },
    ],
  };
  return { bytes, entry, version };
}

function lockOf(entries: ModLockEntry[]): ModsLock {
  return ModsLock.parse({
    lockVersion: 1,
    minecraft: '26.3',
    loader: '0.19.5',
    fabric: { libraries: [{ name: 'net.fabricmc:fabric-loader:0.19.5', size: 1, sha512: 'a'.repeat(128) }] },
    mods: entries,
  });
}

/** A fetch that serves the Modrinth API and the CDN from memory, counting calls. */
function fakeFetch(
  versions: ModrinthVersion[],
  files: Map<string, Buffer>,
): { fetch: (url: string) => Promise<Response>; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    fetch: async (url: string) => {
      calls.push(url);
      if (url.startsWith('https://api.example.test/versions?ids=')) {
        const ids = JSON.parse(decodeURIComponent(url.slice(url.indexOf('=') + 1))) as string[];
        return Response.json(versions.filter((v) => ids.includes(v.id)));
      }
      const body = files.get(url);
      return body ? new Response(new Uint8Array(body)) : new Response('nope', { status: 404 });
    },
  };
}

describe('packaging/mods.lock.json', () => {
  it('pins the PLAN §10 default set plus the opt-ins', async () => {
    const lock = await loadModsLock(LOCK_PATH);
    expect(lock.minecraft).toBe('26.3');
    expect(lock.loader).toBe('0.19.5');
    // The whole Fabric profile is pinned, the loader included (its profile entry has no checksum at all).
    expect(lock.fabric.libraries.map((l) => l.name)).toEqual([
      'net.fabricmc:fabric-loader:0.19.5',
      'net.fabricmc:sponge-mixin:0.17.4+mixin.0.8.7',
      'org.ow2.asm:asm:9.10.1',
      'org.ow2.asm:asm-analysis:9.10.1',
      'org.ow2.asm:asm-commons:9.10.1',
      'org.ow2.asm:asm-tree:9.10.1',
      'org.ow2.asm:asm-util:9.10.1',
    ]);
    const defaults = lock.mods.filter((m) => !m.optional);
    expect(Object.fromEntries(defaults.map((m) => [m.slug, m.versionId]))).toEqual({
      'fabric-api': 'v2j28coa',
      sodium: 'bAZQdGpg',
      lithium: 'xS0Q8LSi',
      'ferrite-core': 'd5ddUdiB',
      immediatelyfast: '3MP9UR23',
      entityculling: 'F4loCvYt',
      moreculling: 't7vAlfgO',
      'cloth-config': 'fg2uyxOW',
      'dynamic-fps': 'Jwq069rR',
      badoptimizations: 'Sp0ctspw',
      'sodium-extra': 'te2y9qZn',
    });
    expect(defaults.every((m) => m.versionType === 'release')).toBe(true);
    expect(lock.mods.filter((m) => m.optional).map((m) => m.modId)).toEqual([
      'iris',
      'c2me',
      'chunky',
      'spark',
      'modmenu',
    ]);
    for (const m of lock.mods) expect(new URL(m.url).host).toBe('cdn.modrinth.com');
  });

  it('rejects duplicate mod ids and malformed hashes', () => {
    const a = fakeMod('a', 1).entry;
    expect(() => lockOf([a, { ...fakeMod('b', 2).entry, modId: a.modId }])).toThrow(/duplicate modId/);
    expect(() => lockOf([{ ...a, sha512: 'abc' }])).toThrow();
    expect(() => lockOf([{ ...a, filename: '../evil.jar' }])).toThrow();
    expect(() => lockOf([{ ...a, url: 'http://cdn.example.test/x.jar' }])).toThrow(/https/);
  });
});

describe('selectMods', () => {
  const lock = lockOf([fakeMod('core', 1).entry, { ...fakeMod('shader', 2).entry, optional: true }]);
  it('takes the defaults and opt-ins by slug or mod id', () => {
    expect(selectMods(lock).map((m) => m.slug)).toEqual(['core']);
    expect(selectMods(lock, ['shader']).map((m) => m.slug)).toEqual(['core', 'shader']);
  });
  it('rejects unknown opt-ins', () => {
    expect(() => selectMods(lock, ['optifine'])).toThrow(/unknown opt-in/);
  });
});

describe('primaryFile', () => {
  it('picks the flagged primary file, not the first one', () => {
    expect(primaryFile(fakeMod('a', 1).version)?.filename).toBe('a-1.0.1.jar');
  });
  it('falls back to the first file when none is flagged', () => {
    const v = fakeMod('a', 1).version;
    const files = v.files.map((f) => ({ ...f, primary: false }));
    expect(primaryFile({ files })?.filename).toBe('a-sources.jar');
    expect(primaryFile({ files: [] })).toBeUndefined();
  });
});

describe('verifyAgainstLock', () => {
  const a = fakeMod('a', 1);
  const b = fakeMod('b', 2);
  it('returns the primary file URLs when everything matches', () => {
    const urls = verifyAgainstLock([a.entry, b.entry], [a.version, b.version]);
    expect(urls.get(a.entry.versionId)).toBe(a.entry.url);
  });
  it('rejects a version missing from the response', () => {
    expect(() => verifyAgainstLock([a.entry, b.entry], [a.version])).toThrow(/did not return b/);
  });
  it('rejects a version from another project', () => {
    expect(() => verifyAgainstLock([a.entry], [{ ...a.version, project_id: 'OTHERPRJ' }])).toThrow(
      /belongs to project/,
    );
  });
  it('rejects a size mismatch', () => {
    const files = a.version.files.map((f) => (f.primary ? { ...f, size: f.size + 1 } : f));
    expect(() => verifyAgainstLock([a.entry], [{ ...a.version, files }])).toThrow(/bytes, lock says/);
  });
  it('rejects a sha512 mismatch', () => {
    const files = a.version.files.map((f) => (f.primary ? { ...f, hashes: { sha512: '0'.repeat(128) } } : f));
    expect(() => verifyAgainstLock([a.entry], [{ ...a.version, files }])).toThrow(/sha512 differs/);
  });
  it('rejects a renamed primary file', () => {
    const files = a.version.files.map((f) => (f.primary ? { ...f, filename: 'other.jar' } : f));
    expect(() => verifyAgainstLock([a.entry], [{ ...a.version, files }])).toThrow(
      /primary file is other.jar/,
    );
  });
});

describe('installMods', () => {
  const api = 'https://api.example.test';

  function setup(mods: ReturnType<typeof fakeMod>[], serve?: Map<string, Buffer>) {
    const root = tmp();
    const files = serve ?? new Map(mods.map((m) => [m.entry.url, m.bytes]));
    const net = fakeFetch(
      mods.map((m) => m.version),
      files,
    );
    const opts = {
      lock: lockOf(mods.map((m) => m.entry)),
      cacheDir: join(root, 'Caches', 'mods'),
      modsDir: join(root, 'game', 'mods'),
      log: silentLogger(),
      fetch: net.fetch,
      api,
    };
    return { root, net, opts };
  }

  it('downloads with one API call into the sha512 cache and mods/, then needs no network', async () => {
    const mods = [fakeMod('a', 1), fakeMod('b', 2), fakeMod('c', 3)];
    const { net, opts } = setup(mods);
    const first = await installMods(opts);
    expect(first.apiCalls).toBe(1);
    expect(first.downloaded).toBe(3);
    expect(net.calls.filter((u) => u.startsWith(api))).toEqual([
      versionsUrl(['VER00001', 'VER00002', 'VER00003'], api),
    ]);
    for (const m of mods) {
      expect(readFileSync(cachePath(opts.cacheDir, m.entry.sha512)).equals(m.bytes)).toBe(true);
      expect(readFileSync(join(opts.modsDir, m.entry.filename)).equals(m.bytes)).toBe(true);
    }
    net.calls.length = 0;
    const second = await installMods(opts);
    expect(second.apiCalls).toBe(0);
    expect(second.downloaded).toBe(0);
    expect(net.calls).toEqual([]);
  });

  it('rejects a download whose bytes do not match the lock and leaves nothing behind', async () => {
    const good = fakeMod('a', 1);
    const tampered = Buffer.from(good.bytes);
    tampered[0] = 0x58;
    const { opts } = setup([good], new Map([[good.entry.url, tampered]]));
    await expect(installMods(opts)).rejects.toBeInstanceOf(IntegrityError);
    expect(existsSync(cachePath(opts.cacheDir, good.entry.sha512))).toBe(false);
    expect(readdirSync(opts.cacheDir)).toEqual([]);
    expect(existsSync(join(opts.modsDir, good.entry.filename))).toBe(false);
  });

  it('rejects a download with the wrong size', async () => {
    const good = fakeMod('a', 1);
    const { opts } = setup(
      [good],
      new Map([[good.entry.url, Buffer.concat([good.bytes, Buffer.from('x')])]]),
    );
    await expect(installMods(opts)).rejects.toThrow(/more than the expected|expected/);
    expect(readdirSync(opts.cacheDir)).toEqual([]);
  });

  it('rejects when the API omits a pinned version', async () => {
    const a = fakeMod('a', 1);
    const b = fakeMod('b', 2);
    const { opts } = setup([a, b]);
    const net = fakeFetch([a.version], new Map([[a.entry.url, a.bytes]]));
    await expect(installMods({ ...opts, fetch: net.fetch })).rejects.toThrow(/did not return b/);
  });

  it('replaces a corrupted cache entry and a tampered mods/ jar', async () => {
    const a = fakeMod('a', 1);
    const { opts } = setup([a]);
    await installMods(opts);
    writeFileSync(cachePath(opts.cacheDir, a.entry.sha512), 'garbage');
    writeFileSync(join(opts.modsDir, a.entry.filename), 'garbage');
    const r = await installMods(opts);
    expect(r.downloaded).toBe(1);
    expect(readFileSync(join(opts.modsDir, a.entry.filename)).equals(a.bytes)).toBe(true);
  });

  it('removes jars it placed earlier, quarantines foreign ones, and copies extra jars', async () => {
    const a = fakeMod('a', 1);
    const b = fakeMod('b', 2);
    const { root, opts } = setup([a, b]);
    await installMods(opts);
    writeFileSync(join(opts.modsDir, 'user-added.jar'), 'mine');
    const devJar = join(root, 'minevibe-0.1.0.jar');
    writeFileSync(devJar, 'dev mod');
    const r = await installMods({
      ...opts,
      lock: lockOf([a.entry]),
      extraJars: [{ source: devJar, filename: 'minevibe-0.1.0.jar', modId: 'minevibe' }],
    });
    expect(r.removed).toEqual([b.entry.filename]);
    expect(r.quarantined).toEqual(['user-added.jar']);
    expect(readdirSync(opts.modsDir).sort()).toEqual(
      ['.minevibe-managed.json', a.entry.filename, 'minevibe-0.1.0.jar'].sort(),
    );
    const moved = readdirSync(quarantineDir(opts.modsDir));
    expect(moved).toHaveLength(1);
    expect(moved[0]).toMatch(/-user-added\.jar$/);
    expect(readFileSync(join(quarantineDir(opts.modsDir), moved[0] as string), 'utf8')).toBe('mine');
    expect(readFileSync(join(opts.modsDir, 'minevibe-0.1.0.jar'), 'utf8')).toBe('dev mod');
  });

  it('quarantines a stray copy of a locked mod after the managed list was lost (no duplicate mod ids)', async () => {
    const a = fakeMod('a', 1);
    const { opts } = setup([a]);
    await installMods(opts);
    // An older version of the same mod, left behind: the managed list that would have removed it is gone.
    writeFileSync(join(opts.modsDir, 'a-mod-0.9.jar'), 'old a');
    rmSync(join(opts.modsDir, '.minevibe-managed.json'));
    const r = await installMods(opts);
    expect(r.quarantined).toEqual(['a-mod-0.9.jar']);
    expect(readdirSync(opts.modsDir).filter((f) => f.endsWith('.jar'))).toEqual([a.entry.filename]);
  });

  it('refuses two jars with the same mod id', async () => {
    const a = fakeMod('a', 1);
    const { root, opts } = setup([a]);
    mkdirSync(join(root, 'x'));
    await expect(
      installMods({
        ...opts,
        extraJars: [{ source: join(root, 'x', 'a.jar'), filename: 'a2.jar', modId: 'a_mod' }],
      }),
    ).rejects.toThrow(/two jars provide mod id a_mod/);
  });
});
