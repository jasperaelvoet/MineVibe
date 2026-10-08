import { existsSync, readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { AgentId, WorldId } from '@minevibe/protocol';

export const APP_NAME = 'MineVibe';

/** Overrides every MineVibe data location (dev: `<repo>/.minevibe-dev`, tests: a temp dir). */
export const HOME_ENV = 'MINEVIBE_HOME';

/** Name of the gitignored dev data directory at the repo root. */
export const DEV_HOME_DIRNAME = '.minevibe-dev';

/** Name of the gitignored dev token file at the repo root. */
export const DEV_TOKEN_FILENAME = '.dev-token';

/** Every on-disk location MineVibe uses (PLAN §4 "Runtime data"). */
export interface MineVibePaths {
  /** True when {@link HOME_ENV} replaced the platform locations. */
  readonly overridden: boolean;
  /** `~/Library/Application Support/MineVibe`: lasting state. */
  readonly appSupport: string;
  /** `~/Library/Caches/MineVibe`: re-downloadable content. */
  readonly caches: string;
  /** `~/Library/Logs/MineVibe`. */
  readonly logs: string;
  /** Settings, pcs.json, chronicle.json, current-world.json, Vault handoff notes, per-PC tokens (0700). */
  readonly state: string;
  /** Per-run files: bridge.json and the single-instance lock (0700). */
  readonly run: string;
  /** `run/bridge.json` {port, token, pid} (0600). */
  readonly bridgeFile: string;
  /** `run/lock`. */
  readonly lockFile: string;
  /** Codex git repo (`lasting/`, `world-<id>/`). */
  readonly codex: string;
  /** Read-only Codex export mounted into PCs. */
  readonly codexExport: string;
  /** Real-clock calendar events. */
  readonly calendar: string;
  /** Per-world data (`worlds/<id>/…`). */
  readonly worlds: string;
  /** Minecraft install, mods, saves. */
  readonly game: string;
  /** Apple `container` app root. */
  readonly container: string;
  /** Lume storage. */
  readonly lume: string;
}

export interface ResolvePathsOptions {
  env?: Readonly<Record<string, string | undefined>>;
  /** User home directory (defaults to `os.homedir()`). */
  home?: string;
  platform?: NodeJS.Platform;
  /** Base for a relative {@link HOME_ENV}. */
  cwd?: string;
}

/**
 * Resolves MineVibe's directories. With {@link HOME_ENV} set, everything lives under that one folder
 * (`<home>`, `<home>/Caches`, `<home>/Logs`); otherwise the macOS Library folders are used, with XDG
 * fallbacks on other platforms (CI).
 */
export function resolvePaths(options: ResolvePathsOptions = {}): MineVibePaths {
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const platform = options.platform ?? process.platform;
  const override = env[HOME_ENV]?.trim();

  let appSupport: string;
  let caches: string;
  let logs: string;
  if (override) {
    appSupport = isAbsolute(override) ? override : resolve(options.cwd ?? process.cwd(), override);
    caches = join(appSupport, 'Caches');
    logs = join(appSupport, 'Logs');
  } else if (platform === 'darwin') {
    appSupport = join(home, 'Library', 'Application Support', APP_NAME);
    caches = join(home, 'Library', 'Caches', APP_NAME);
    logs = join(home, 'Library', 'Logs', APP_NAME);
  } else {
    const xdg = (name: string, fallback: string) => {
      const v = env[name];
      return v && isAbsolute(v) ? v : join(home, fallback);
    };
    appSupport = join(xdg('XDG_DATA_HOME', '.local/share'), 'minevibe');
    caches = join(xdg('XDG_CACHE_HOME', '.cache'), 'minevibe');
    logs = join(xdg('XDG_STATE_HOME', '.local/state'), 'minevibe', 'logs');
  }

  const run = join(appSupport, 'run');
  return {
    overridden: Boolean(override),
    appSupport,
    caches,
    logs,
    state: join(appSupport, 'state'),
    run,
    bridgeFile: join(run, 'bridge.json'),
    lockFile: join(run, 'lock'),
    codex: join(appSupport, 'codex'),
    codexExport: join(appSupport, 'codex-export'),
    calendar: join(appSupport, 'calendar'),
    worlds: join(appSupport, 'worlds'),
    game: join(appSupport, 'game'),
    container: join(appSupport, 'container'),
    lume: join(appSupport, 'lume'),
  };
}

/** `worlds/<worldId>`; rejects ids that are not safe slugs. */
export function worldDir(paths: MineVibePaths, worldId: string): string {
  return join(paths.worlds, WorldId.parse(worldId));
}

/** `worlds/<worldId>/agents/<agentId>`. */
export function agentDir(paths: MineVibePaths, worldId: string, agentId: string): string {
  return join(worldDir(paths, worldId), 'agents', AgentId.parse(agentId));
}

/** The agent's claude cwd: `worlds/<worldId>/agents/<agentId>/home` (never a Vault path). */
export function agentHome(paths: MineVibePaths, worldId: string, agentId: string): string {
  return join(agentDir(paths, worldId, agentId), 'home');
}

/** Creates the base directories. `state` and `run` hold secrets and are owner-only (0700). */
export async function ensureBaseDirs(paths: MineVibePaths): Promise<void> {
  for (const dir of [paths.appSupport, paths.caches, paths.logs, paths.worlds]) {
    await mkdir(dir, { recursive: true });
  }
  for (const dir of [paths.state, paths.run]) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
  }
}

/** The dev data directory for a checkout: `<repoRoot>/.minevibe-dev`. */
export function devHome(repoRoot: string): string {
  return join(repoRoot, DEV_HOME_DIRNAME);
}

/** The dev token file for a checkout: `<repoRoot>/.dev-token`. */
export function devTokenFile(repoRoot: string): string {
  return join(repoRoot, DEV_TOKEN_FILENAME);
}

/**
 * Walks up from `start` to the monorepo root: the first directory whose package.json declares
 * `workspaces`. Returns null when not inside a checkout (e.g. inside MineVibe.app).
 */
export function findRepoRoot(start: string): string | null {
  let dir = resolve(start);
  for (;;) {
    const pkgPath = join(dir, 'package.json');
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { workspaces?: unknown };
        if (Array.isArray(pkg.workspaces)) return dir;
      } catch {
        // unreadable package.json: keep walking
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}
