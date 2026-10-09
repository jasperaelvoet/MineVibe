import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { fabricVersionId, mavenPath, pinFabricLibraries } from '../../src/launcher/installFabric.js';
import {
  dropUnresolvedArgs,
  gameEnv,
  MINEVIBE_GAME_ARGS,
  offlineUuid,
} from '../../src/launcher/launchGame.js';
import { loadLauncherSettings } from '../../src/launcher/settings.js';
import { stopGame } from '../../src/orchestrator/play.js';

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

  it('pins every profile library to the lock (fabric-loader has no checksum in the profile)', () => {
    const pins = [
      { name: 'net.fabricmc:fabric-loader:0.19.5', size: 7, sha512: 'a'.repeat(128) },
      { name: 'org.ow2.asm:asm:9.10.1', size: 9, sha512: 'b'.repeat(128) },
    ];
    const { profile, libraries } = pinFabricLibraries(
      {
        id: 'x',
        libraries: [
          {
            name: 'org.ow2.asm:asm:9.10.1',
            url: 'https://maven.fabricmc.net/',
            sha1: 'c'.repeat(40),
            sha512: 'B'.repeat(128),
            size: 9,
          },
          { name: 'net.fabricmc:fabric-loader:0.19.5', url: 'https://maven.fabricmc.net' },
        ],
      },
      pins,
    );
    expect(profile.libraries?.[1]).toEqual({
      name: 'net.fabricmc:fabric-loader:0.19.5',
      downloads: {
        artifact: {
          path: 'net/fabricmc/fabric-loader/0.19.5/fabric-loader-0.19.5.jar',
          url: 'https://maven.fabricmc.net/net/fabricmc/fabric-loader/0.19.5/fabric-loader-0.19.5.jar',
          size: 7,
        },
      },
    });
    expect(libraries.map((l) => [l.name, l.sha512])).toEqual([
      ['org.ow2.asm:asm:9.10.1', 'b'.repeat(128)],
      ['net.fabricmc:fabric-loader:0.19.5', 'a'.repeat(128)],
    ]);
  });

  it('refuses unpinned libraries, disagreeing checksums and plain http', () => {
    const pins = [{ name: 'net.fabricmc:fabric-loader:0.19.5', size: 7, sha512: 'a'.repeat(128) }];
    expect(() =>
      pinFabricLibraries({ libraries: [{ name: 'evil:lib:1', url: 'https://maven.fabricmc.net/' }] }, pins),
    ).toThrow(/does not pin/);
    expect(() =>
      pinFabricLibraries(
        {
          libraries: [
            {
              name: 'net.fabricmc:fabric-loader:0.19.5',
              url: 'https://maven.fabricmc.net/',
              sha512: 'f'.repeat(128),
            },
          ],
        },
        pins,
      ),
    ).toThrow(/different sha512/);
    expect(() =>
      pinFabricLibraries(
        {
          libraries: [
            { name: 'net.fabricmc:fabric-loader:0.19.5', url: 'https://maven.fabricmc.net/', size: 8 },
          ],
        },
        pins,
      ),
    ).toThrow(/different size/);
    expect(() =>
      pinFabricLibraries(
        { libraries: [{ name: 'net.fabricmc:fabric-loader:0.19.5', url: 'http://maven.example/' }] },
        pins,
      ),
    ).toThrow(/non-https/);
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
    expect((await loadLauncherSettings(dir, { MINEVIBE_PLAYER_NAME: 'Jordan' })).playerName).toBe('Jordan');
  });
});

describe('stopGame', () => {
  function child(script: string): Promise<ChildProcess> {
    const proc = spawn(
      process.execPath,
      ['-e', `${script}; console.log('ready'); setInterval(() => {}, 1000);`],
      {
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    );
    return new Promise((resolvePromise) => proc.stdout?.once('data', () => resolvePromise(proc)));
  }

  it('asks with SIGTERM, so the JVM shutdown hook can save the world', async () => {
    const proc = await child("process.on('SIGTERM', () => process.exit(0))");
    await stopGame(proc, 10_000);
    expect(proc.exitCode).toBe(0);
    expect(proc.signalCode).toBeNull();
  });

  it('kills a game that ignores SIGTERM once the grace period is over', async () => {
    const proc = await child("process.on('SIGTERM', () => {})");
    await stopGame(proc, 200);
    expect(proc.signalCode).toBe('SIGKILL');
  });
});
