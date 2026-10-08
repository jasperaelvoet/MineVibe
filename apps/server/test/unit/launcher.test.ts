import { type ChildProcess, spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
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
import {
  AlreadyRunningError,
  acquireRunLock,
  parseLockOwner,
  processStartTime,
} from '../../src/orchestrator/runLock.js';

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
    expect((await loadLauncherSettings(dir, { MINEVIBE_PLAYER_NAME: 'Jasper' })).playerName).toBe('Jasper');
  });
});

describe('run lock', () => {
  it('is exclusive while the owner lives and taken over when stale', async () => {
    const path = join(tmp(), 'run', 'lock');
    const lock = await acquireRunLock(path, process.pid);
    const owner = parseLockOwner(readFileSync(path, 'utf8'));
    expect(owner).toMatchObject({ pid: process.pid, started: await processStartTime(process.pid) });
    await expect(acquireRunLock(path, process.pid + 1)).rejects.toBeInstanceOf(AlreadyRunningError);
    await lock.release();
    expect(existsSync(path)).toBe(false);
    writeFileSync(path, '999999\n'); // a pid that does not exist
    const taken = await acquireRunLock(path, process.pid);
    await taken.release();
  });

  it('takes over a lock whose pid now belongs to a newer process (pid reuse after a reboot)', async () => {
    const path = join(tmp(), 'run', 'lock');
    mkdirSync(join(path, '..'), { recursive: true });
    // This test process is alive, but it is not the process that wrote the lock: different start time.
    writeFileSync(
      path,
      `${JSON.stringify({ pid: process.pid, started: 'Mon Jan 1 00:00:00 2024', nonce: 'x' })}\n`,
    );
    const lock = await acquireRunLock(path, process.pid + 1);
    expect(parseLockOwner(readFileSync(path, 'utf8'))?.pid).toBe(process.pid + 1);
    await lock.release();
  });

  it('handles old pid-only locks by comparing the start time with the lock file', async () => {
    const path = join(tmp(), 'run', 'lock');
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, `${process.pid}\n`);
    // Written now, by a process that started earlier: that owner is plausible.
    await expect(acquireRunLock(path, process.pid + 1)).rejects.toBeInstanceOf(AlreadyRunningError);
    // Written long before this process started: the pid was reused, the lock is stale.
    const past = new Date(Date.now() - 30 * 24 * 3600 * 1000);
    utimesSync(path, past, past);
    const lock = await acquireRunLock(path, process.pid + 1);
    await lock.release();
  });

  it('keeps a live pid as the owner when its start time cannot be read', async () => {
    const path = join(tmp(), 'run', 'lock');
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, `${JSON.stringify({ pid: 4242, started: 'then', nonce: 'x' })}\n`);
    const deps = { pidExists: () => true, startTime: async () => null };
    await expect(acquireRunLock(path, 1, deps)).rejects.toMatchObject({ pid: 4242 });
  });

  it('lets exactly one of several racing starters take over a stale lock', async () => {
    const deps = {
      pidExists: (pid: number) => pid >= 1000,
      startTime: async (pid: number) => `start-${pid}`,
    };
    for (let round = 0; round < 25; round++) {
      const path = join(tmp(), 'run', 'lock');
      mkdirSync(join(path, '..'), { recursive: true });
      writeFileSync(path, `${JSON.stringify({ pid: 7, started: 'start-7', nonce: 'dead' })}\n`); // owner gone
      const results = await Promise.allSettled(
        [1001, 1002, 1003, 1004].map((pid) => acquireRunLock(path, pid, deps)),
      );
      const won = results.filter((r) => r.status === 'fulfilled');
      expect(won).toHaveLength(1);
      for (const r of results) {
        if (r.status === 'rejected') expect(r.reason).toBeInstanceOf(AlreadyRunningError);
      }
      const holder = parseLockOwner(readFileSync(path, 'utf8'));
      expect(holder?.pid).toBeGreaterThanOrEqual(1001);
      expect(readdirSync(join(path, '..')).filter((f) => f !== 'lock')).toEqual([]);
    }
  });

  it('never releases a lock that someone else holds now', async () => {
    const path = join(tmp(), 'run', 'lock');
    const lock = await acquireRunLock(path, process.pid);
    writeFileSync(path, `${JSON.stringify({ pid: 5, started: 'x', nonce: 'theirs' })}\n`);
    await lock.release();
    expect(parseLockOwner(readFileSync(path, 'utf8'))?.nonce).toBe('theirs');
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
