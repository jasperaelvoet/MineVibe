import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  agentDir,
  agentHome,
  devHome,
  ensureBaseDirs,
  findRepoRoot,
  HOME_ENV,
  legacyDevTokenFile,
  playHome,
  resolvePaths,
  worldDir,
} from '../../src/config/paths.js';

const tmpDirs: string[] = [];
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mv-paths-'));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('resolvePaths', () => {
  it('uses the macOS Library folders by default', () => {
    const p = resolvePaths({ env: {}, home: '/Users/jasper', platform: 'darwin' });
    expect(p.overridden).toBe(false);
    expect(p.appSupport).toBe('/Users/jasper/Library/Application Support/MineVibe');
    expect(p.caches).toBe('/Users/jasper/Library/Caches/MineVibe');
    expect(p.logs).toBe('/Users/jasper/Library/Logs/MineVibe');
    expect(p.state).toBe('/Users/jasper/Library/Application Support/MineVibe/state');
    expect(p.bridgeFile).toBe('/Users/jasper/Library/Application Support/MineVibe/run/bridge.json');
    expect(p.codexExport).toBe('/Users/jasper/Library/Application Support/MineVibe/codex-export');
    expect(p.worlds).toBe('/Users/jasper/Library/Application Support/MineVibe/worlds');
    expect(p.game).toBe('/Users/jasper/Library/Application Support/MineVibe/game');
  });

  it('MINEVIBE_HOME overrides everything', () => {
    const p = resolvePaths({ env: { [HOME_ENV]: '/x/dev' }, home: '/Users/jasper', platform: 'darwin' });
    expect(p.overridden).toBe(true);
    expect(p.appSupport).toBe('/x/dev');
    expect(p.caches).toBe('/x/dev/Caches');
    expect(p.logs).toBe('/x/dev/Logs');
    expect(p.run).toBe('/x/dev/run');
    expect(p.lockFile).toBe('/x/dev/run/lock');
  });

  it('resolves a relative MINEVIBE_HOME against cwd and ignores blank values', () => {
    expect(resolvePaths({ env: { [HOME_ENV]: 'data' }, cwd: '/repo' }).appSupport).toBe('/repo/data');
    expect(resolvePaths({ env: { [HOME_ENV]: '  ' }, home: '/h', platform: 'darwin' }).overridden).toBe(
      false,
    );
  });

  it('falls back to XDG locations off macOS (CI)', () => {
    const p = resolvePaths({ env: { XDG_CACHE_HOME: '/cache' }, home: '/home/ci', platform: 'linux' });
    expect(p.appSupport).toBe('/home/ci/.local/share/minevibe');
    expect(p.caches).toBe('/cache/minevibe');
    expect(p.logs).toBe('/home/ci/.local/state/minevibe/logs');
  });
});

describe('per-world paths', () => {
  const p = resolvePaths({ env: { [HOME_ENV]: '/mv' } });

  it('builds world and agent dirs', () => {
    expect(worldDir(p, 'world-3')).toBe('/mv/worlds/world-3');
    expect(agentDir(p, 'world-3', 'ada')).toBe('/mv/worlds/world-3/agents/ada');
    expect(agentHome(p, 'world-3', 'ada')).toBe('/mv/worlds/world-3/agents/ada/home');
  });

  it('rejects ids that could escape', () => {
    expect(() => worldDir(p, '../etc')).toThrow();
    expect(() => worldDir(p, 'World 3')).toThrow();
    expect(() => agentDir(p, 'world-3', '../../x')).toThrow();
    expect(() => agentDir(p, 'world-3', '')).toThrow();
  });
});

describe('ensureBaseDirs', () => {
  it('creates the tree with private state and run dirs', async () => {
    const home = join(tmp(), 'home');
    const p = resolvePaths({ env: { [HOME_ENV]: home } });
    await ensureBaseDirs(p);
    expect(statSync(p.caches).isDirectory()).toBe(true);
    expect(statSync(p.logs).isDirectory()).toBe(true);
    expect(statSync(p.worlds).isDirectory()).toBe(true);
    expect(statSync(p.state).mode & 0o777).toBe(0o700);
    expect(statSync(p.run).mode & 0o777).toBe(0o700);
  });
});

describe('repo helpers', () => {
  it('finds the workspace root walking up', () => {
    const root = tmp();
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'x', workspaces: ['apps/*'] }));
    mkdirSync(join(root, 'apps', 'server', 'src'), { recursive: true });
    writeFileSync(join(root, 'apps', 'server', 'package.json'), JSON.stringify({ name: 'server' }));
    expect(findRepoRoot(join(root, 'apps', 'server', 'src'))).toBe(root);
    expect(devHome(root)).toBe(join(root, '.minevibe-dev'));
    // npm run play never shares run/ or state/ with npm run dev.
    expect(playHome(root)).toBe(join(root, '.minevibe-dev', 'play'));
    expect(legacyDevTokenFile(root)).toBe(join(root, '.dev-token'));
  });

  it('returns null outside a checkout', () => {
    expect(findRepoRoot(tmp())).toBeNull();
  });

  it('finds this repository', () => {
    const root = findRepoRoot(process.cwd());
    expect(root).not.toBeNull();
  });
});
