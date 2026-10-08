import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  bundledJavaPath,
  installMojangRuntime,
  JAVA_ENV,
  mojangPlatformKey,
  parseJavaVersion,
  resolveJava,
} from '../../src/launcher/javaRuntime.js';
import { silentLogger } from '../../src/log.js';

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'mv-java-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('parseJavaVersion', () => {
  it.each([
    ['openjdk version "25.0.1" 2025-10-21 LTS\nOpenJDK Runtime Environment', '25.0.1', 25],
    ['openjdk version "25" 2025-09-16', '25', 25],
    ['openjdk version "25-ea" 2025-06-05', '25-ea', 25],
    ['openjdk version "21.0.8" 2025-07-15 LTS', '21.0.8', 21],
    ['java version "1.8.0_402"\nJava(TM) SE Runtime Environment', '1.8.0_402', 8],
    ['Picked up JAVA_TOOL_OPTIONS: -Dx=y\nopenjdk version "25.0.4.1" 2026-08-18 LTS', '25.0.4.1', 25],
  ])('parses %j', (output, version, major) => {
    expect(parseJavaVersion(output)).toEqual({ version, major });
  });

  it('returns null for output without a version', () => {
    expect(parseJavaVersion('Error: could not find libjava.dylib')).toBeNull();
    expect(parseJavaVersion('')).toBeNull();
    expect(parseJavaVersion('version "abc"')).toBeNull();
  });
});

describe('mojangPlatformKey', () => {
  it('maps hosts to the runtime index keys', () => {
    expect(mojangPlatformKey('darwin', 'arm64')).toBe('mac-os-arm64');
    expect(mojangPlatformKey('darwin', 'x64')).toBe('mac-os');
    expect(mojangPlatformKey('linux', 'x64')).toBe('linux');
    expect(mojangPlatformKey('win32', 'x64')).toBe('windows-x64');
    expect(mojangPlatformKey('linux', 'arm64')).toBeNull();
  });
});

describe('bundledJavaPath (M10 stub)', () => {
  it('is null outside an app bundle', () => {
    expect(bundledJavaPath('/opt/homebrew/bin/node')).toBeNull();
    expect(bundledJavaPath('/Applications/MineVibe.app/Contents/MacOS/node')).toBeNull(); // no JRE there
  });
});

describe('resolveJava', () => {
  const requirement = { component: 'java-runtime-epsilon', majorVersion: 25 };
  const base = { runtimeRoot: '/unused', requirement, log: silentLogger(), bundledJava: () => null };
  const noInstall = async () => {
    throw new Error('should not install');
  };

  it('prefers MINEVIBE_JAVA', async () => {
    const r = await resolveJava({
      ...base,
      env: { [JAVA_ENV]: '/jdk/bin/java' },
      probe: async () => ({ version: '25.0.4', major: 25 }),
      installRuntime: noInstall,
    });
    expect(r).toMatchObject({ path: '/jdk/bin/java', source: 'env', major: 25, downloaded: false });
  });

  it('rejects an override older than required and a relative override', async () => {
    await expect(
      resolveJava({
        ...base,
        env: { [JAVA_ENV]: '/jdk17/bin/java' },
        probe: async () => ({ version: '17.0.9', major: 17 }),
      }),
    ).rejects.toThrow(/needs Java 25/);
    await expect(resolveJava({ ...base, env: { [JAVA_ENV]: 'java' } })).rejects.toThrow(/absolute/);
  });

  it('uses the bundled JRE next, then the Mojang runtime', async () => {
    const bundled = await resolveJava({
      ...base,
      env: {},
      bundledJava: () => '/App/Contents/Runtime/jre/bin/MineVibe',
      probe: async () => ({ version: '25.0.1', major: 25 }),
      installRuntime: noInstall,
    });
    expect(bundled.source).toBe('bundled');

    const mojang = await resolveJava({
      ...base,
      env: {},
      probe: async () => ({ version: '25.0.1', major: 25 }),
      installRuntime: async () => ({
        javaPath: '/rt/bin/java',
        downloaded: true,
        downloadedBytes: 42,
        version: '25.0.1',
      }),
    });
    expect(mojang).toMatchObject({
      source: 'mojang',
      path: '/rt/bin/java',
      downloaded: true,
      downloadedBytes: 42,
    });
  });

  it('requires exactly the major version from the Mojang runtime', async () => {
    await expect(
      resolveJava({
        ...base,
        env: {},
        probe: async () => ({ version: '26.0.1', major: 26 }),
        installRuntime: async () => ({
          javaPath: '/rt/bin/java',
          downloaded: false,
          downloadedBytes: 0,
          version: '26',
        }),
      }),
    ).rejects.toThrow(/needs Java 25/);
  });
});

describe('installMojangRuntime', () => {
  const sha1 = (s: string) => createHash('sha1').update(s).digest('hex');
  const javaBody = '#!/bin/sh\necho fake java\n';
  const libBody = 'libjli';

  function fakeRuntime(files: Record<string, unknown>) {
    const manifest = JSON.stringify({ files });
    const index = {
      'mac-os-arm64': {
        'java-runtime-epsilon': [
          {
            manifest: {
              sha1: sha1(manifest),
              size: manifest.length,
              url: 'https://piston.test/manifest.json',
            },
            version: { name: '25.0.1', released: '2025-12-10T14:24:00+00:00' },
          },
        ],
      },
    };
    const served: Record<string, string> = {
      'https://index.test/all.json': JSON.stringify(index),
      'https://piston.test/manifest.json': manifest,
      'https://piston.test/java': javaBody,
      'https://piston.test/libjli': libBody,
    };
    const calls: string[] = [];
    const fetch = async (url: string) => {
      calls.push(url);
      const body = served[url];
      return body === undefined ? new Response('', { status: 404 }) : new Response(body);
    };
    return { fetch, calls };
  }

  const goodFiles = {
    'jre.bundle': { type: 'directory' },
    'jre.bundle/Contents/Home/bin': { type: 'directory' },
    'jre.bundle/Contents/Home/bin/java': {
      type: 'file',
      executable: true,
      downloads: { raw: { sha1: sha1(javaBody), size: javaBody.length, url: 'https://piston.test/java' } },
    },
    'jre.bundle/Contents/Home/lib/libjli.dylib': {
      type: 'file',
      executable: false,
      downloads: { raw: { sha1: sha1(libBody), size: libBody.length, url: 'https://piston.test/libjli' } },
    },
    'jre.bundle/Contents/MacOS/libjli.dylib': { type: 'link', target: '../Home/lib/libjli.dylib' },
  };

  const opts = (root: string, fetch: (url: string) => Promise<Response>) => ({
    runtimeRoot: root,
    requirement: { component: 'java-runtime-epsilon', majorVersion: 25 },
    platform: 'mac-os-arm64',
    log: silentLogger(),
    fetch,
    indexUrl: 'https://index.test/all.json',
  });

  it('downloads every file with sha1 checks, sets exec bits and links, then takes the offline fast path', async () => {
    const root = tmp();
    const net = fakeRuntime(goodFiles);
    const first = await installMojangRuntime(opts(root, net.fetch));
    const dir = join(root, 'java-runtime-epsilon', 'mac-os-arm64');
    expect(first.javaPath).toBe(join(dir, 'jre.bundle', 'Contents', 'Home', 'bin', 'java'));
    expect(first).toMatchObject({
      downloaded: true,
      version: '25.0.1',
      downloadedBytes: javaBody.length + libBody.length,
    });
    expect(statSync(first.javaPath).mode & 0o777).toBe(0o755);
    expect(readlinkSync(join(dir, 'jre.bundle/Contents/MacOS/libjli.dylib'))).toBe(
      '../Home/lib/libjli.dylib',
    );

    net.calls.length = 0;
    const second = await installMojangRuntime(opts(root, net.fetch));
    expect(second).toMatchObject({ downloaded: false, javaPath: first.javaPath });
    expect(net.calls).toEqual([]);

    // A damaged file is detected (size) and repaired with a fresh download.
    writeFileSync(first.javaPath, 'x');
    const third = await installMojangRuntime(opts(root, net.fetch));
    expect(third.downloaded).toBe(true);
    expect(readFileSync(first.javaPath, 'utf8')).toBe(javaBody);
  });

  it('rejects a file whose sha1 does not match', async () => {
    const files = structuredClone(goodFiles) as typeof goodFiles;
    files['jre.bundle/Contents/Home/bin/java'].downloads.raw.sha1 = sha1('something else');
    const net = fakeRuntime(files);
    await expect(installMojangRuntime(opts(tmp(), net.fetch))).rejects.toThrow(/sha1 mismatch/);
  });

  it('rejects links and paths that escape the runtime directory', async () => {
    const escaping = { ...goodFiles, 'jre.bundle/evil': { type: 'link', target: '../../../../etc/passwd' } };
    await expect(installMojangRuntime(opts(tmp(), fakeRuntime(escaping).fetch))).rejects.toThrow(/escapes/);
    const dotdot = { '../outside': { type: 'directory' } };
    await expect(installMojangRuntime(opts(tmp(), fakeRuntime(dotdot).fetch))).rejects.toThrow(/unsafe/);
  });
});
