import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Logger } from 'pino';
import {
  codexExportsRoot,
  devHome,
  findRepoRoot,
  HOME_ENV,
  playHome,
  resolvePaths,
} from '../config/paths.js';
import { instanceIdFor } from '../util/hostPaths.js';
import { AppleContainerDriver } from './drivers/AppleContainerDriver.js';
import {
  type ContainerRoots,
  ContainerRuntime,
  devContainerRoots,
  resolveContainerRoots,
} from './drivers/ContainerRuntime.js';
import { registryDirFor } from './InstanceRegistry.js';
import { loadContainerLock } from './module.js';
import { cleanOrphans, formatOrphanReport, type OrphanReport } from './orphans.js';

/**
 * `doctor --clean-orphans` (and the E2E harness): finds and, with `apply`, removes the PC instances of MineVibe homes
 * that no longer exist from a container engine (the dev engine by default; `MINEVIBE_CONTAINER_APP_ROOT` picks
 * another), plus their relocated Codex exports. See pcs/orphans.ts for what counts as an orphan.
 *
 * The engine must run to list its resources: when it is stopped, this starts it under a lease of its own and lets go
 * afterwards (it stops again unless another MineVibe uses it); an engine that already ran keeps running. A process
 * that still runs PCs of its own on the same engine (the E2E harness during a session) passes `releaseEngine: false`,
 * so only the extra lease is dropped.
 */

export interface OrphanCleanupOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly cwd?: string;
  readonly home?: string;
  readonly apply?: boolean;
  /** Only these instance ids (a named instance without a record of its home may be removed; see orphans.ts). */
  readonly instances?: readonly string[];
  /** Only resources with this `minevibe` label value (tests). */
  readonly label?: string;
  /** Container roots (default: the dev roots, with the env overrides). */
  readonly roots?: ContainerRoots;
  /** Let go of the engine afterwards: stop it unless another MineVibe uses it (default true). */
  readonly releaseEngine?: boolean;
  readonly logger?: Logger;
  /** Progress lines (engine start, ...). */
  readonly onProgress?: (line: string) => void;
}

export interface OrphanCleanupResult {
  readonly report: OrphanReport;
  /** The report as text, after the notes about the engine. */
  readonly lines: string[];
}

/** Instance ids of the homes this checkout and this Mac use (never guessed to be gone without a check). */
export function knownHomes(
  env: Readonly<Record<string, string | undefined>>,
  cwd: string,
  home: string,
): Map<string, string> {
  const states = new Set<string>();
  states.add(resolvePaths({ env, cwd, home }).state);
  const { [HOME_ENV]: _unset, ...withoutHome } = env;
  states.add(resolvePaths({ env: withoutHome, cwd, home }).state);
  const repo = findRepoRoot(cwd);
  if (repo) {
    states.add(join(devHome(repo), 'state'));
    states.add(join(playHome(repo), 'state'));
  }
  return new Map([...states].map((s) => [instanceIdFor(s), s]));
}

export async function runOrphanCleanup(options: OrphanCleanupOptions = {}): Promise<OrphanCleanupResult> {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const home = options.home ?? homedir();
  const lines: string[] = [];
  const note = (line: string) => {
    lines.push(line);
    options.onProgress?.(line);
  };
  const roots =
    options.roots ??
    resolveContainerRoots({ appSupportContainer: devContainerRoots(home).appRoot, env, home });
  const repo = findRepoRoot(cwd);
  const lock = loadContainerLock(repo ? [join(repo, 'packaging', 'vendor.lock.json')] : []);
  const runtime = new ContainerRuntime({
    ...roots,
    lock,
    cacheDir: join(home, 'Library', 'Caches', 'MineVibe-dev', 'vendor'),
    leaseHolder: `doctor clean-orphans ${process.pid}`,
    ...(options.logger ? { logger: options.logger } : {}),
  });
  const driver = new AppleContainerDriver(runtime, options.logger ? { logger: options.logger } : {});
  note(`engine         app root ${roots.appRoot}`);
  let engine: AppleContainerDriver | null = null;
  let startedIt = false;
  if (process.platform !== 'darwin') {
    note('               no Apple container engine on this platform: only the registry is checked');
  } else if (!(await runtime.isProvisioned())) {
    note(
      `               not installed at ${roots.installRoot}: only the registry and Codex exports are checked`,
    );
  } else {
    const st = await runtime.status();
    if (st.ownership === 'foreign' || st.ownership === 'unknown') {
      note(
        `               not ours (${st.ownership}): left alone; only the registry and Codex exports are checked`,
      );
    } else {
      if (st.ownership === 'not_running') {
        note(
          '               starting it to list PC resources (it stops again unless another MineVibe uses it)',
        );
        startedIt = true;
      }
      await driver.ensureEngine();
      engine = driver;
    }
  }
  let report: OrphanReport;
  try {
    report = await cleanOrphans(
      {
        driver: engine,
        registryDir: registryDirFor(roots.appRoot),
        codexExportsRoot: codexExportsRoot(home),
        otherEngineUsers: async () => (await runtime.leases.others()).length,
      },
      {
        ...(options.apply ? { apply: true } : {}),
        ...(options.instances?.length ? { instances: options.instances } : {}),
        ...(options.label !== undefined ? { label: options.label } : {}),
        knownHomes: knownHomes(env, cwd, home),
      },
    );
  } finally {
    if (engine) {
      if (options.releaseEngine === false || !startedIt) {
        // Ran before this (or another part of this process runs PCs on it): only our own lease goes.
        await runtime.leases.withLock(() => runtime.leases.release());
      } else if (await driver.shutdownEngine()) {
        note('               stopped the engine again');
      }
    }
  }
  lines.push(...formatOrphanReport(report));
  return { report, lines };
}
