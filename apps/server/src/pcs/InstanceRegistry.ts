import { readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { writeFileAtomic } from '../util/atomicFile.js';
import { INSTANCE_ID_RE } from '../util/hostPaths.js';
import { pidExists, processStartTime, sameStartTime } from '../util/processes.js';

/**
 * The PC instance registry (DEBT "throwaway homes leak PC instances"). Several MineVibe homes share one container
 * engine (the dev roots), and every home's PCs carry its instance id (a hash of its state dir) in their names and
 * labels. A hash cannot be turned back into a path, so each PcManager writes `<appRoot>/minevibe-instances/<id>.json`
 * when it starts: which state dir the id belongs to, and which process uses it now. `doctor --clean-orphans`
 * (pcs/orphans.ts) reads it to find instances whose home no longer exists and that no live process uses.
 *
 * The record names the process that uses the instance (pid and start time, so a reused pid never counts); a clean
 * shutdown clears it (`pid: null`), so a process that ran a home in-process (the E2E harness) can clean that home's
 * PCs once its PcManager has stopped.
 */

/** Folder of the registry inside a container app root (next to `minevibe-leases/`). */
export const INSTANCE_REGISTRY_DIRNAME = 'minevibe-instances';

export interface InstanceRecord {
  readonly v: 1;
  readonly instance: string;
  /** The home's state dir (realpath at registration); its hash is the instance id. */
  readonly stateDir: string;
  /** Value of the `minevibe` label (`pc`; tests `pc-test-<run>`). */
  readonly label: string;
  /** The process that uses the instance now; null once it shut down cleanly. */
  readonly pid: number | null;
  /** That process's start time ({@link processStartTime}). */
  readonly started: string | null;
  readonly updatedAt: number;
}

export type Liveness = 'alive' | 'dead' | 'unknown';

export interface ProcessProbe {
  pidExists(pid: number): boolean;
  startTime(pid: number): Promise<string | null>;
}

export const defaultProbe: ProcessProbe = { pidExists, startTime: processStartTime };

export function registryDirFor(appRoot: string): string {
  return join(appRoot, INSTANCE_REGISTRY_DIRNAME);
}

function recordPath(dir: string, instance: string): string {
  if (!INSTANCE_ID_RE.test(instance)) throw new Error(`invalid instance id ${instance}`);
  return join(dir, `${instance}.json`);
}

/** Writes (replaces) the record of an instance. */
export async function writeInstanceRecord(dir: string, record: InstanceRecord): Promise<void> {
  await writeFileAtomic(recordPath(dir, record.instance), `${JSON.stringify(record)}\n`, {
    mode: 0o600,
    dirMode: 0o700,
  });
}

/** The record of this process for an instance (its pid and start time). */
export async function currentRecord(
  instance: string,
  stateDir: string,
  label: string,
  probe: Pick<ProcessProbe, 'startTime'> = defaultProbe,
): Promise<InstanceRecord> {
  return {
    v: 1,
    instance,
    stateDir,
    label,
    pid: process.pid,
    started: await probe.startTime(process.pid),
    updatedAt: Date.now(),
  };
}

function parseRecord(raw: unknown, instance: string): InstanceRecord | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Partial<Record<keyof InstanceRecord, unknown>>;
  if (r.instance !== instance || typeof r.stateDir !== 'string' || !r.stateDir.startsWith('/')) return null;
  return {
    v: 1,
    instance,
    stateDir: r.stateDir,
    label: typeof r.label === 'string' ? r.label : 'pc',
    pid: typeof r.pid === 'number' && Number.isInteger(r.pid) && r.pid > 0 ? r.pid : null,
    started: typeof r.started === 'string' ? r.started : null,
    updatedAt: typeof r.updatedAt === 'number' ? r.updatedAt : 0,
  };
}

/** Every readable record, by instance id. Unreadable or malformed files are skipped. */
export async function readInstanceRecords(dir: string): Promise<Map<string, InstanceRecord>> {
  const out = new Map<string, InstanceRecord>();
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return out;
  }
  for (const f of files) {
    const instance = f.endsWith('.json') ? f.slice(0, -5) : '';
    if (!INSTANCE_ID_RE.test(instance)) continue;
    try {
      const rec = parseRecord(JSON.parse(await readFile(join(dir, f), 'utf8')), instance);
      if (rec) out.set(instance, rec);
    } catch {
      // half-written or foreign: ignored
    }
  }
  return out;
}

export async function removeInstanceRecord(dir: string, instance: string): Promise<void> {
  await rm(recordPath(dir, instance), { force: true });
}

/**
 * Whether the process a record names still runs: its pid exists and started when the record says. `unknown` when
 * that cannot be told (no start time recorded, or ps failed): callers treat it as alive.
 */
export async function recordLiveness(
  record: Pick<InstanceRecord, 'pid' | 'started'>,
  probe: ProcessProbe = defaultProbe,
): Promise<Liveness> {
  if (record.pid === null) return 'dead';
  if (!probe.pidExists(record.pid)) return 'dead';
  if (record.started === null) return 'unknown';
  const now = await probe.startTime(record.pid);
  if (now === null) return probe.pidExists(record.pid) ? 'unknown' : 'dead';
  return sameStartTime(record.started, now) ? 'alive' : 'dead';
}
