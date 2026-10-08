import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  fabricVersionId,
  fillMavenSha1,
  mavenPath,
  withArtifactDownloads,
} from '../../src/launcher/installFabric.js';
import {
  dropUnresolvedArgs,
  gameEnv,
  MINEVIBE_GAME_ARGS,
  offlineUuid,
} from '../../src/launcher/launchGame.js';
import { loadLauncherSettings } from '../../src/launcher/settings.js';
import { AlreadyRunningError, acquireRunLock } from '../../src/orchestrator/runLock.js';

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'mv-launcher-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('offlineUuid', () => {
  it('matches Java UUID.nameUUIDFromBytes("OfflinePlayer:" + name)', () => {
    // Reference values computed with jshell on JDK 25.
    expect(offlineUuid('Notch')).toBe('b50ad385-829d-3141-a216-7e7d7539ba7f');
    expect(offlineUuid('Player')).toBe('a01e3843-e521-3998-958a-f459800e4d11');
  });
});

describe('launch arguments', () => {
  it('always disables multiplayer and forces the OpenGL backend', () => {
    expect(MINEVIBE_GAME_ARGS).toEqual(['--disableMultiplayer', '--graphicsBackend', 'opengl']);
  });

  it('drops options whose value is an unfilled placeholder', () => {
    const placeholder = (name: string) => `$\{${name}}`;
    expect(
      dropUnresolvedArgs([
        placeholder('stray'),
        '--uuid',
        'abc',
        '--clientId',
        placeholder('clientid'),
        '--xuid',
        placeholder('auth_xuid'),
        '--demo',
      ]),
    ).toEqual(['--uuid', 'abc', '--demo']);
  });

  it('keeps credentials out of the game environment', () => {
    const env = gameEnv({
      PATH: '/bin',
      HOME: '/Users/x',
      ANTHROPIC_API_KEY: 'k',
      CLAUDE_CODE_OAUTH_TOKEN: 't',
    });
    expect(env).toEqual({ PATH: '/bin', HOME: '/Users/x' });
  });
});

describe('Fabric profile', () => {
  it('names versions like @xmcl/installer and maps maven coordinates', () => {
    expect(fabricVersionId('26.3', '0.19.5')).toBe('26.3-fabric0.19.5');
    expect(mavenPath('net.fabricmc:sponge-mixin:0.17.4+mixin.0.8.7')).toBe(
      'net/fabricmc/sponge-mixin/0.17.4+mixin.0.8.7/sponge-mixin-0.17.4+mixin.0.8.7.jar',
    );
    expect(mavenPath('org.lwjgl:lwjgl:3.4.3:natives-macos-arm64')).toBe(
      'org/lwjgl/lwjgl/3.4.3/lwjgl-3.4.3-natives-macos-arm64.jar',
    );
  });

  it('fills a missing sha1 from the Maven .sha1 sidecar (fabric-loader has none in the profile)', async () => {
    const urls: string[] = [];
    const out = await fillMavenSha1(
      {
        libraries: [
          { name: 'net.fabricmc:fabric-loader:0.19.5', url: 'https://maven.fabricmc.net/' },
          { name: 'org.ow2.asm:asm:9.10.1', url: 'https://maven.fabricmc.net/', sha1: 'b'.repeat(40) },
        ],
      },
      async (url) => {
        urls.push(url);
        return new Response(`${'F'.repeat(40)}  fabric-loader-0.19.5.jar\n`);
      },
    );
    expect(urls).toEqual([
      'https://maven.fabricmc.net/net/fabricmc/fabric-loader/0.19.5/fabric-loader-0.19.5.jar.sha1',
    ]);
    expect(out.libraries?.[0]?.sha1).toBe('f'.repeat(40));
    expect(out.libraries?.[1]?.sha1).toBe('b'.repeat(40));
    await expect(
      fillMavenSha1(
        { libraries: [{ name: 'a:b:1', url: 'http://insecure.example/' }] },
        async () => new Response(''),
      ),
    ).rejects.toThrow(/non-https/);
    await expect(
      fillMavenSha1(
        { libraries: [{ name: 'a:b:1', url: 'https://maven.example/' }] },
        async () => new Response('<html>'),
      ),
    ).rejects.toThrow(/not a sha1/);
  });

  it('turns url+sha1 libraries into checksummed artifacts', () => {
    const out = withArtifactDownloads({
      id: 'x',
      libraries: [
        {
          name: 'net.fabricmc:fabric-loader:0.19.5',
          url: 'https://maven.fabricmc.net/',
          sha1: 'a'.repeat(40),
          size: 7,
        },
        { name: 'no.checksum:lib:1', url: 'https://maven.example/' },
      ],
    });
    expect(out.libraries?.[0]).toEqual({
      name: 'net.fabricmc:fabric-loader:0.19.5',
      downloads: {
        artifact: {
          path: 'net/fabricmc/fabric-loader/0.19.5/fabric-loader-0.19.5.jar',
          url: 'https://maven.fabricmc.net/net/fabricmc/fabric-loader/0.19.5/fabric-loader-0.19.5.jar',
          sha1: 'a'.repeat(40),
          size: 7,
        },
      },
    });
    expect(out.libraries?.[1]).toEqual({ name: 'no.checksum:lib:1', url: 'https://maven.example/' });
  });
});

describe('launcher settings', () => {
  it('defaults the player to "Player" and falls back per invalid field', async () => {
    const dir = tmp();
    expect(await loadLauncherSettings(dir, {})).toEqual({
      playerName: 'Player',
      optionalMods: [],
      maxMemoryMb: 6144,
    });
    writeFileSync(
      join(dir, 'settings.json'),
      JSON.stringify({ playerName: 'no spaces!', optionalMods: ['iris'] }),
    );
    const warnings: string[] = [];
    const s = await loadLauncherSettings(dir, {}, (m) => warnings.push(m));
    expect(s).toEqual({ playerName: 'Player', optionalMods: ['iris'], maxMemoryMb: 6144 });
    expect(warnings).toEqual(['settings.playerName is invalid; using the default']);
    expect((await loadLauncherSettings(dir, { MINEVIBE_PLAYER_NAME: 'Jasper' })).playerName).toBe('Jasper');
  });
});

describe('run lock', () => {
  it('is exclusive while the owner lives and taken over when stale', async () => {
    const path = join(tmp(), 'run', 'lock');
    const lock = await acquireRunLock(path, process.pid);
    await expect(acquireRunLock(path, process.pid + 1)).rejects.toBeInstanceOf(AlreadyRunningError);
    await lock.release();
    writeFileSync(path, '999999\n'); // a pid that does not exist
    const taken = await acquireRunLock(path, process.pid);
    await taken.release();
  });
});
