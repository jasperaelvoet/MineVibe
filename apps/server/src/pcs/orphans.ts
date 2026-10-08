import { existsSync } from 'node:fs';
import { readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { INSTANCE_ID_RE } from '../util/hostPaths.js';
import { MANAGED_LABEL, PC_INSTANCE_LABEL, type PcDriver } from './drivers/PcDriver.js';
import {
  defaultProbe,
  type InstanceRecord,
  type ProcessProbe,
  readInstanceRecords,
  recordLiveness,
  removeInstanceRecord,
} from './InstanceRegistry.js';

/**
 * Orphaned PC instances (`doctor --clean-orphans`, DEBT "throwaway homes leak PC instances"). Every MineVibe home has
 * its own PC instance (an id hashed from its state dir) in the shared container engine: containers, networks and
 * volumes named `mv-pc-<instance>-…` and labelled `minevibe.instance=<instance>`, plus, for a home in a TCC-protected
 * folder, a relocated Codex export (`MineVibe-dev/codex-export/<instance>`). A throwaway home leaves all of that behind
 * when it is deleted.
 *
 * An instance is an **orphan** only when its home is known to be gone and nothing can still be using it:
 * - its state dir comes from the instance registry (InstanceRegistry.ts), the export's owner file, or a known home;
 * - that state dir no longer exists (a home on an unmounted volume is "unknown", never gone);
 * - the process the registry names no longer runs (or it shut down cleanly), and, for an instance without a registry
 *   record, no other MineVibe process holds a lease on the engine.
 * Instances without any record of their home are left alone unless named explicitly (`instances`). Everything else is
 * reported and kept. Removal re-checks the verdict right before it starts, and touches only resources whose label and
 * name both carry the instance id.
 */

export type InstanceVerdict =
  /** Home gone, nothing uses it: removed by a clean. */
  | 'orphan'
  /** Its home still exists. */
  | 'home_exists'
  /** A running process uses it. */
  | 'live'
  /** Could not tell (ps failed, home on an unmounted volume, another MineVibe runs and there is no record). */
  | 'unknown'
  /** No record of its home (an older MineVibe made it, or another tool): only removed when named. */
  | 'unregistered';

export interface InstanceFinding {
  readonly instance: string;
  readonly verdict: InstanceVerdict;
  readonly why: string;
  /** The home's state dir, when known. */
  readonly stateDir: string | null;
  readonly registered: boolean;
  readonly containers: readonly string[];
  readonly networks: readonly string[];
  readonly volumes: readonly string[];
  /** A relocated Codex export folder of this instance, if any. */
  readonly codexExport: string | null;
}

export interface OrphanDeps {
  /** The engine's resources; null when the engine could not be reached (only registry and exports are scanned). */
  readonly driver: Pick<
    PcDriver,
    'list' | 'listNetworks' | 'listVolumes' | 'remove' | 'removeNetwork' | 'removeVolume'
  > | null;
  /** `<appRoot>/minevibe-instances`. */
  readonly registryDir: string;
  /** Where relocated Codex exports live (`MineVibe-dev/codex-export`), or null. */
  readonly codexExportsRoot: string | null;
  /** How many other MineVibe processes hold a live lease on the engine (EngineLeases.others). */
  readonly otherEngineUsers: () => Promise<number>;
  readonly probe?: ProcessProbe;
  readonly exists?: (path: string) => boolean;
}

export interface OrphanOptions {
  /** Remove the orphans (default: only report). */
  readonly apply?: boolean;
  /**
   * Only these instance ids. A named instance with no record of its home counts as an orphan when nothing else uses
   * the engine (the caller vouches that its home is gone); one whose home is known still follows the rules above.
   */
  readonly instances?: readonly string[];
  /** Known homes (instance id → state dir), for instances the registry does not know (dev, play, the app's home). */
  readonly knownHomes?: ReadonlyMap<string, string>;
  /** Only resources whose `minevibe` label has this value (tests: `pc-test-<run>`). */
  readonly label?: string;
}

export interface OrphanReport {
  readonly findings: readonly InstanceFinding[];
  readonly applied: boolean;
  /** Containers, networks, volumes, folders and registry records removed. */
  readonly removed: readonly string[];
  readonly failed: readonly { readonly what: string; readonly error: string }[];
}

interface Resources {
  containers: string[];
  networks: string[];
  volumes: string[];
}

interface ExportEntry {
  dir: string | null;
  owner: string | null;
  state: string | null;
}

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err)).slice(0, 300);

/** Whether a state dir is gone: `unknown` when it sat on a volume that is not mounted now. */
function homeState(stateDir: string, exists: (p: string) => boolean): 'exists' | 'gone' | 'unknown' {
  if (exists(stateDir)) return 'exists';
  const m = /^\/Volumes\/[^/]+/.exec(stateDir);
  if (m && !exists(m[0])) return 'unknown';
  return 'gone';
}

async function scanResources(deps: OrphanDeps, label: string | undefined): Promise<Map<string, Resources>> {
  const out = new Map<string, Resources>();
  if (!deps.driver) return out;
  const of = (id: string) => {
    let r = out.get(id);
    if (!r) {
      r = { containers: [], networks: [], volumes: [] };
      out.set(id, r);
    }
    return r;
  };
  const ours = (name: string, labels: Readonly<Record<string, string>>): string | null => {
    const id = labels[PC_INSTANCE_LABEL];
    const managed = labels[MANAGED_LABEL];
    if (!id || !INSTANCE_ID_RE.test(id) || managed === undefined) return null;
    if (label !== undefined && managed !== label) return null;
    // Name and label must agree: a resource is never removed on its label alone.
    return name.startsWith(`mv-pc-${id}-`) ? id : null;
  };
  for (const c of await deps.driver.list({})) {
    const id = ours(c.name, c.labels);
    if (id) of(id).containers.push(c.name);
  }
  for (const n of await deps.driver.listNetworks({})) {
    const id = ours(n.name, n.labels);
    if (id) of(id).networks.push(n.name);
  }
  for (const v of await deps.driver.listVolumes({})) {
    const id = ours(v.name, v.labels);
    if (id) of(id).volumes.push(v.name);
  }
  return out;
}

async function scanExports(root: string | null): Promise<Map<string, ExportEntry>> {
  const out = new Map<string, ExportEntry>();
  if (!root) return out;
  let names: string[];
  try {
    names = await readdir(root);
  } catch {
    return out;
  }
  for (const name of names) {
    const id = name.endsWith('.json') ? name.slice(0, -5) : name;
    if (!INSTANCE_ID_RE.test(id)) continue;
    const e = out.get(id) ?? { dir: null, owner: null, state: null };
    if (name.endsWith('.json')) {
      e.owner = join(root, name);
      try {
        const o = JSON.parse(await readFile(e.owner, 'utf8')) as { state?: unknown };
        if (typeof o.state === 'string' && o.state.startsWith('/')) e.state = o.state;
      } catch {
        // unreadable owner file: the folder's home stays unknown
      }
    } else {
      e.dir = join(root, name);
    }
    out.set(id, e);
  }
  return out;
}

async function verdictOf(
  rec: InstanceRecord | undefined,
  stateDir: string | null,
  named: boolean,
  deps: OrphanDeps,
): Promise<{ verdict: InstanceVerdict; why: string }> {
  const exists = deps.exists ?? existsSync;
  if (stateDir === null) {
    if (!named)
      return { verdict: 'unregistered', why: 'no record of its home (name it with --instance to remove it)' };
    if ((await deps.otherEngineUsers()) > 0) {
      return {
        verdict: 'unknown',
        why: 'named, but another MineVibe uses the engine and this instance has no record',
      };
    }
    return { verdict: 'orphan', why: 'named explicitly; no record of its home' };
  }
  const home = homeState(stateDir, exists);
  if (home === 'exists') return { verdict: 'home_exists', why: `${stateDir} exists` };
  if (home === 'unknown')
    return { verdict: 'unknown', why: `${stateDir} is on a volume that is not mounted` };
  if (rec) {
    const live = await recordLiveness(rec, deps.probe ?? defaultProbe);
    if (live === 'alive') return { verdict: 'live', why: `pid ${rec.pid} still uses it` };
    if (live === 'unknown')
      return { verdict: 'unknown', why: `cannot tell whether pid ${rec.pid} still uses it` };
    return { verdict: 'orphan', why: `${stateDir} is gone and no process uses it` };
  }
  if ((await deps.otherEngineUsers()) > 0) {
    return { verdict: 'unknown', why: `${stateDir} is gone, but another MineVibe uses the engine` };
  }
  return { verdict: 'orphan', why: `${stateDir} is gone` };
}

/** Lists every PC instance the engine, the registry and the relocated exports know, with a verdict each. */
export async function scanOrphans(deps: OrphanDeps, options: OrphanOptions = {}): Promise<InstanceFinding[]> {
  const [resources, records, exports] = await Promise.all([
    scanResources(deps, options.label),
    readInstanceRecords(deps.registryDir),
    scanExports(deps.codexExportsRoot),
  ]);
  const named = options.instances ? new Set(options.instances) : null;
  const ids = new Set<string>([...resources.keys(), ...exports.keys()]);
  for (const [id, rec] of records) {
    if (options.label === undefined || rec.label === options.label) ids.add(id);
  }
  const findings: InstanceFinding[] = [];
  for (const id of [...ids].sort()) {
    if (named && !named.has(id)) continue;
    const rec = records.get(id);
    const exp = exports.get(id);
    const stateDir = rec?.stateDir ?? exp?.state ?? options.knownHomes?.get(id) ?? null;
    const { verdict, why } = await verdictOf(rec, stateDir, named?.has(id) === true, deps);
    const r = resources.get(id) ?? { containers: [], networks: [], volumes: [] };
    findings.push({
      instance: id,
      verdict,
      why,
      stateDir,
      registered: rec !== undefined,
      containers: r.containers,
      networks: r.networks,
      volumes: r.volumes,
      codexExport: exp?.dir ?? null,
    });
  }
  return findings;
}

/**
 * Scans, and with `apply` removes every orphan: containers (stopped first), networks, volumes, the relocated Codex
 * export with its owner file, then the registry record. Each orphan's verdict is checked again right before.
 */
export async function cleanOrphans(deps: OrphanDeps, options: OrphanOptions = {}): Promise<OrphanReport> {
  const findings = await scanOrphans(deps, options);
  const removed: string[] = [];
  const failed: { what: string; error: string }[] = [];
  if (!options.apply) return { findings, applied: false, removed, failed };
  for (const f of findings) {
    if (f.verdict !== 'orphan') continue;
    // Re-checked under the latest facts: a process may have started using it since the scan.
    const again = (await scanOrphans(deps, { ...options, instances: [f.instance] }))[0];
    if (again?.verdict !== 'orphan') continue;
    let ok = true;
    const attempt = async (what: string, fn: () => Promise<void>) => {
      try {
        await fn();
        removed.push(what);
      } catch (err) {
        ok = false;
        failed.push({ what, error: errText(err) });
      }
    };
    const driver = deps.driver;
    if (driver) {
      for (const name of again.containers) await attempt(name, () => driver.remove(name));
      for (const name of again.networks) await attempt(name, () => driver.removeNetwork(name));
      for (const name of again.volumes) await attempt(name, () => driver.removeVolume(name));
    } else if (again.containers.length + again.networks.length + again.volumes.length > 0) {
      ok = false;
    }
    if (deps.codexExportsRoot) {
      const dir = join(deps.codexExportsRoot, again.instance);
      if (existsSync(dir)) await attempt(dir, () => rm(dir, { recursive: true, force: true }));
      const owner = `${dir}.json`;
      if (existsSync(owner)) await attempt(owner, () => rm(owner, { force: true }));
    }
    if (ok && again.registered) {
      await attempt(`registry ${again.instance}`, () =>
        removeInstanceRecord(deps.registryDir, again.instance),
      );
    }
  }
  return { findings, applied: true, removed, failed };
}

/** Human-readable lines for a report (doctor). */
export function formatOrphanReport(report: OrphanReport): string[] {
  const lines: string[] = [];
  if (report.findings.length === 0) lines.push('No MineVibe PC instances found.');
  for (const f of report.findings) {
    const parts = [
      f.containers.length ? `${f.containers.length} container(s)` : '',
      f.networks.length ? `${f.networks.length} network(s)` : '',
      f.volumes.length ? `${f.volumes.length} volume(s)` : '',
      f.codexExport ? 'a Codex export' : '',
      f.registered ? 'registered' : '',
    ].filter(Boolean);
    lines.push(`${f.instance}  ${f.verdict.padEnd(12)} ${parts.join(', ') || 'nothing'}`);
    lines.push(`          ${f.why}`);
  }
  const orphans = report.findings.filter((f) => f.verdict === 'orphan');
  if (!report.applied) {
    lines.push(
      orphans.length
        ? `Dry run: ${orphans.length} orphaned instance(s) would be removed. Run again with --apply to remove them.`
        : 'Nothing to remove.',
    );
  } else {
    lines.push(`Removed ${report.removed.length} item(s) of ${orphans.length} orphaned instance(s).`);
    for (const f of report.failed) lines.push(`  failed: ${f.what}: ${f.error}`);
  }
  return lines;
}
