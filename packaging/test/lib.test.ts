import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, inflateSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { BUNDLE_LAYOUT } from '../../apps/server/src/app/appLayout.js';
import { compareTrees, ensureDownloaded, isMachO } from '../lib/files.js';
import { encodePng, ICONSET, placeholderIcon } from '../lib/icon.js';
import { plistBool, plistString, renderInfoPlist } from '../lib/infoPlist.js';
import { copyProductionPackages, productionPackages } from '../lib/prodDeps.js';
import { chooseIdentity, parseIdentities } from '../lib/signing.js';
import { archiveFileName, VendorLock } from '../lib/vendorLock.js';

const repoRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'mv-pack-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const sha256 = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');

describe('vendor.lock.json', () => {
  const real = JSON.parse(readFileSync(join(repoRoot, 'packaging', 'vendor.lock.json'), 'utf8'));

  it('parses, pins https URLs, sizes, sha256s and team IDs', () => {
    const lock = VendorLock.parse(real);
    expect(lock.node.version).toMatch(/^24\./);
    expect(lock.jre.javaVersion).toMatch(/^25\./);
    expect(lock.container.version).toBe('1.5.0');
    expect(lock.container.sha256).toBe('a24808cb202318fa1c3bbee0c6c6887fe1225fe899d7b687a0ddd939bd6573f8');
    expect(lock.container.teamId).toBe('UPBK2H6LZM');
    expect(archiveFileName(lock.node)).toBe(`node-v${lock.node.version}-darwin-arm64.tar.gz`);
    expect(archiveFileName(lock.jre)).toBe('OpenJDK25U-jre_aarch64_mac_hotspot_25.0.4.1_1.tar.gz');
    expect(archiveFileName(lock.container)).toBe('container-1.5.0-installer-signed.pkg');
  });

  it('rejects http, a short hash, an escaping archive path and a wrong archive kind', () => {
    const bad = (patch: (l: typeof real) => void) => {
      const copy = structuredClone(real);
      patch(copy);
      return VendorLock.safeParse(copy).success;
    };
    expect(bad(() => {})).toBe(true);
    expect(bad((l) => (l.node.url = l.node.url.replace('https:', 'http:')))).toBe(false);
    expect(bad((l) => (l.jre.sha256 = 'abc'))).toBe(false);
    expect(bad((l) => (l.container.extract = '../../etc'))).toBe(false);
    expect(bad((l) => (l.container.archive = 'tar.gz'))).toBe(false);
    expect(bad((l) => (l.node.teamId = 'nope'))).toBe(false);
  });
});

describe('Info.plist template', () => {
  const template = readFileSync(join(repoRoot, 'apps', 'launcher-mac', 'Info.plist'), 'utf8');
  const rendered = renderInfoPlist(template, { VERSION: '0.1.0', BUILD: '42', COMMIT: 'abc1234-dirty' });

  it('declares what PLAN §9.1 requires', () => {
    expect(plistString(rendered, 'CFBundleExecutable')).toBe(basename(BUNDLE_LAYOUT.stub));
    expect(plistString(rendered, 'CFBundleIconFile')).toBe(basename(BUNDLE_LAYOUT.icon, '.icns'));
    expect(plistString(rendered, 'CFBundleIdentifier')).toBe('dev.minevibe.MineVibe');
    expect(plistString(rendered, 'LSMinimumSystemVersion')).toBe('26.0');
    expect(plistBool(rendered, 'LSUIElement')).toBe(true);
    expect(plistString(rendered, 'NSLocalNetworkUsageDescription')?.length).toBeGreaterThan(20);
    expect(plistString(rendered, 'CFBundleShortVersionString')).toBe('0.1.0');
    expect(plistString(rendered, 'CFBundleVersion')).toBe('42');
    expect(plistString(rendered, 'MineVibeCommit')).toBe('abc1234-dirty');
    expect(rendered).not.toMatch(/@[A-Z_]+@/);
  });

  it('refuses bad versions and unknown tokens, and escapes values', () => {
    expect(() => renderInfoPlist(template, { VERSION: '1.0-beta', BUILD: '1', COMMIT: 'x' })).toThrow(
      /Short/,
    );
    expect(() => renderInfoPlist(template, { VERSION: '1.0', BUILD: 'x', COMMIT: 'x' })).toThrow(
      /CFBundleVersion/,
    );
    expect(() =>
      renderInfoPlist('<string>@NOPE@</string>', { VERSION: '1', BUILD: '1', COMMIT: 'x' }),
    ).toThrow(/unknown token/);
    expect(renderInfoPlist('<string>@COMMIT@</string>', { VERSION: '1', BUILD: '1', COMMIT: 'a<b&c' })).toBe(
      '<string>a&lt;b&amp;c</string>',
    );
  });

  it.skipIf(process.platform !== 'darwin')('passes plutil -lint', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'Info.plist'), rendered);
    expect(() => execFileSync('plutil', ['-lint', join(dir, 'Info.plist')])).not.toThrow();
  });
});

describe('placeholder icon', () => {
  it('encodes a valid RGBA PNG', () => {
    const png = encodePng(placeholderIcon(32));
    expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    // IHDR: length 13, type, 32x32, depth 8, colour type 6, then a CRC over type + data
    expect(png.readUInt32BE(8)).toBe(13);
    expect(png.subarray(12, 16).toString('ascii')).toBe('IHDR');
    expect(png.readUInt32BE(16)).toBe(32);
    expect(png.readUInt32BE(20)).toBe(32);
    expect(png[24]).toBe(8);
    expect(png[25]).toBe(6);
    expect(png.readUInt32BE(29)).toBe(crc32(png.subarray(12, 29)) >>> 0);
    const idatLength = png.readUInt32BE(33);
    expect(png.subarray(37, 41).toString('ascii')).toBe('IDAT');
    const raw = inflateSync(png.subarray(41, 41 + idatLength));
    expect(raw.length).toBe(32 * (32 * 4 + 1));
    expect(png.subarray(-8, -4).toString('ascii')).toBe('IEND');
  });

  it('has transparent corners and an opaque middle', () => {
    const icon = placeholderIcon(128);
    const alpha = (x: number, y: number) => icon.data[(y * 128 + x) * 4 + 3];
    expect(alpha(0, 0)).toBe(0);
    expect(alpha(127, 127)).toBe(0);
    expect(alpha(64, 64)).toBe(255);
    expect(() => placeholderIcon(30)).toThrow();
  });

  it('lists every iconset size iconutil needs', () => {
    expect(ICONSET).toHaveLength(10);
    expect(new Set(ICONSET.map(([, s]) => s))).toEqual(new Set([16, 32, 64, 128, 256, 512, 1024]));
  });
});

describe('signing identity', () => {
  const output = `  1) 0123456789ABCDEF0123456789ABCDEF01234567 "Developer ID Application: Jane Doe (ABCDE12345)"
  2) 89ABCDEF0123456789ABCDEF0123456789ABCDEF "Apple Development: Jane Doe (FGHIJ67890)"
     2 valid identities found`;

  it('parses identities and prefers Apple Development (never Developer ID locally)', () => {
    const ids = parseIdentities(output);
    expect(ids).toHaveLength(2);
    expect(chooseIdentity(ids)).toEqual({
      hash: '89ABCDEF0123456789ABCDEF0123456789ABCDEF',
      name: 'Apple Development: Jane Doe (FGHIJ67890)',
    });
    expect(chooseIdentity(ids.slice(0, 1))).toBeNull();
    expect(chooseIdentity(parseIdentities('     0 valid identities found'))).toBeNull();
  });
});

describe('ensureDownloaded', () => {
  const body = Buffer.from('vendor archive bytes');
  const item = {
    url: 'https://example.test/v.tar.gz',
    size: body.length,
    sha256: sha256(body),
    fileName: 'v.tar.gz',
  };

  it('downloads, verifies and caches by sha256; a cached copy costs no request', async () => {
    const cache = tmp();
    let requests = 0;
    const fetch = async () => {
      requests++;
      return new Response(body);
    };
    const first = await ensureDownloaded(item, cache, { fetch });
    expect(first).toEqual({ path: join(cache, item.sha256, 'v.tar.gz'), downloaded: true });
    expect(readFileSync(first.path)).toEqual(body);
    const second = await ensureDownloaded(item, cache, { fetch });
    expect(second.downloaded).toBe(false);
    expect(requests).toBe(1);
    // A corrupted cache entry is downloaded again.
    writeFileSync(first.path, 'x'.repeat(body.length));
    expect((await ensureDownloaded(item, cache, { fetch })).downloaded).toBe(true);
    expect(requests).toBe(2);
  });

  it('rejects a wrong hash, a wrong size and an HTTP error, leaving nothing behind', async () => {
    const cache = tmp();
    const serve =
      (b: Buffer | string, status = 200) =>
      async () =>
        new Response(b, { status });
    await expect(ensureDownloaded(item, cache, { fetch: serve('vendor archive bytez') })).rejects.toThrow(
      /does not match the lock/,
    );
    await expect(ensureDownloaded(item, cache, { fetch: serve('short') })).rejects.toThrow(/the lock pins/);
    await expect(ensureDownloaded(item, cache, { fetch: serve(`${body}more`) })).rejects.toThrow(/more than/);
    await expect(ensureDownloaded(item, cache, { fetch: serve('', 404) })).rejects.toThrow(/HTTP 404/);
    expect(existsSync(join(cache, item.sha256, 'v.tar.gz'))).toBe(false);
    expect(existsSync(join(cache, item.sha256, 'v.tar.gz.part'))).toBe(false);
  });
});

describe('compareTrees', () => {
  function tree(root: string) {
    mkdirSync(join(root, 'bin'), { recursive: true });
    writeFileSync(join(root, 'bin', 'tool'), 'binary');
    chmodSync(join(root, 'bin', 'tool'), 0o755);
    writeFileSync(join(root, 'config.toml'), 'a = 1\n');
    symlinkSync('bin/tool', join(root, 'link'));
  }

  it('finds no difference in an exact copy, and every kind of difference otherwise', async () => {
    const a = join(tmp(), 'a');
    const b = join(tmp(), 'b');
    tree(a);
    tree(b);
    expect(await compareTrees(a, b)).toEqual([]);
    writeFileSync(join(b, 'config.toml'), 'a = 2\n');
    chmodSync(join(b, 'bin', 'tool'), 0o644);
    writeFileSync(join(b, 'extra'), '');
    rmSync(join(b, 'link'));
    symlinkSync('elsewhere', join(b, 'link'));
    expect((await compareTrees(a, b)).sort()).toEqual(
      [
        'bin/tool: mode differs',
        'config.toml: content differs',
        'extra: extra',
        'link: content differs',
      ].sort(),
    );
    rmSync(join(b, 'config.toml'));
    expect(await compareTrees(a, b)).toContain('config.toml: missing');
  });

  it.skipIf(process.platform !== 'darwin')('recognises Mach-O files', async () => {
    expect(await isMachO(process.execPath)).toBe(true);
    const f = join(tmp(), 'script.sh');
    writeFileSync(f, '#!/bin/sh\n');
    expect(await isMachO(f)).toBe(false);
  });
});

describe('server production node_modules', () => {
  it('keeps installed production packages and drops workspace links', () => {
    const root = '/repo';
    const ls = [
      '/repo',
      '/repo/node_modules/@minevibe/server',
      '/repo/node_modules/@minevibe/protocol',
      '/repo/node_modules/ws',
      '/repo/node_modules/@xmcl/core',
      '/repo/node_modules/pino-pretty/node_modules/sonic-boom',
      '/repo/packages/protocol',
      '',
    ].join('\n');
    expect(productionPackages(ls, root)).toEqual(['@xmcl/core', 'pino-pretty/node_modules/sonic-boom', 'ws']);
  });

  it('copies each package byte for byte without its nested node_modules wholesale', async () => {
    const root = tmp();
    const nm = join(root, 'node_modules');
    mkdirSync(join(nm, 'a', 'node_modules', 'b'), { recursive: true });
    mkdirSync(join(nm, 'a', 'node_modules', 'dev-only'), { recursive: true });
    mkdirSync(join(nm, '@s', 'c'), { recursive: true });
    writeFileSync(join(nm, 'a', 'index.js'), 'a');
    writeFileSync(join(nm, 'a', 'node_modules', 'b', 'index.js'), 'b');
    writeFileSync(join(nm, 'a', 'node_modules', 'dev-only', 'index.js'), 'x');
    writeFileSync(join(nm, '@s', 'c', 'addon.node'), Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 1, 2, 3]));
    const dest = tmp();
    await copyProductionPackages(root, ['@s/c', 'a', 'a/node_modules/b'], dest);
    expect(readFileSync(join(dest, 'node_modules', 'a', 'index.js'), 'utf8')).toBe('a');
    expect(readFileSync(join(dest, 'node_modules', 'a', 'node_modules', 'b', 'index.js'), 'utf8')).toBe('b');
    expect(existsSync(join(dest, 'node_modules', 'a', 'node_modules', 'dev-only'))).toBe(false);
    expect(readFileSync(join(dest, 'node_modules', '@s', 'c', 'addon.node'))).toEqual(
      readFileSync(join(nm, '@s', 'c', 'addon.node')),
    );
  });
});
