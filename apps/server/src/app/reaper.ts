import { readFile, rm } from 'node:fs/promises';
import type { Logger } from 'pino';
import { BridgeFileContents } from '../bridge/bridgeFile.js';
import type { MineVibePaths } from '../config/paths.js';
import { pidExists } from '../orchestrator/runLock.js';

/**
 * The startup reaper's file part (PLAN §9.2). It runs while this process holds `run/lock`, so nothing it finds
 * there belongs to a live MineVibe on this home:
 * - `run/lock` itself: a lock left by a crashed run is taken over by {@link acquireRunLock} (dead pid, or a pid that
 *   now belongs to a later process), never by the reaper.
 * - `run/bridge.json` from a crashed run holds a dead process's port and token. The mod never connects while its pid
 *   is not running, but a reused pid would look alive, so any bridge file not written by this process is removed
 *   before the bridge starts.
 *
 * The container part runs once the engine is up ({@link AppPcs}): this instance's orphaned containers are stopped by
 * `PcManager.reconcile` (labels `minevibe=pc` + `minevibe.instance=<this home>`, nothing else), and a stale or
 * wedged apiserver is restarted or booted out only when it runs from our own install root
 * (`ContainerRuntime.ensureStarted`).
 */

export interface RunFilesReport {
  /** What happened to `run/bridge.json`. */
  readonly bridgeFile: 'absent' | 'ours' | 'removed';
  /** The pid the stale bridge file named, and whether a process with that pid was running (pid reuse). */
  readonly stale?: { readonly pid: number | null; readonly pidRunning: boolean };
}

export interface ReapOptions {
  readonly pid?: number;
  readonly pidExists?: (pid: number) => boolean;
  readonly logger?: Logger;
}

/** Removes a bridge file left by an earlier process (call only while holding the run lock). */
export async function reapStaleRunFiles(
  paths: Pick<MineVibePaths, 'bridgeFile'>,
  options: ReapOptions = {},
): Promise<RunFilesReport> {
  const pid = options.pid ?? process.pid;
  let raw: string;
  try {
    raw = await readFile(paths.bridgeFile, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { bridgeFile: 'absent' };
    raw = '';
  }
  let owner: number | null = null;
  try {
    owner = BridgeFileContents.parse(JSON.parse(raw)).pid;
  } catch {
    owner = null; // malformed: stale either way
  }
  if (owner === pid) return { bridgeFile: 'ours' };
  const pidRunning = owner !== null && (options.pidExists ?? pidExists)(owner);
  await rm(paths.bridgeFile, { force: true });
  options.logger?.warn(
    { stalePid: owner, pidRunning },
    pidRunning
      ? 'removed a stale bridge file (its pid now belongs to another process)'
      : 'removed a stale bridge file left by a crashed run',
  );
  return { bridgeFile: 'removed', stale: { pid: owner, pidRunning } };
}
