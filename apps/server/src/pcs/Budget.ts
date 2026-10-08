import type { PcFamily } from './PcTypes.js';

/**
 * Host budget for PCs (PLAN §8.2 with the S5 corrections of §8.6). Pure functions: the caller supplies
 * host facts and the PC list; nothing here touches the system.
 *
 * - RAM pool (hard) = host RAM − reserves (macOS 10 GiB, Minecraft 8, Node 0.5, claude 1 × crew cap,
 *   `container` system 1). On 48 GiB with crew cap 4 that is 24.5 GiB.
 * - CPU pool (soft) = cores − 4, overcommit up to 1.5× with a warning. Apple `container` gives a guest
 *   `--cpus N` → N+1 vCPUs, so each PC counts `cpus + cpuOverhead`.
 * - macOS: at most 2 running; creating one needs ≥ 40 GB free disk.
 * - Disk: every volume and rootfs has a cap; the sum of caps of every existing PC (and of orphaned
 *   volumes) must fit in the free disk plus what PCs already occupy (measured) minus a reserve. An edit
 *   is charged only the growth of its caps (H5).
 * - Container VMs don't return freed memory to macOS, so the budget counts allocated limits, not usage,
 *   plus a per-VM overhead (kernel, vminitd, virtio) for every active PC (L11).
 * - While an image build runs, the builder VM's memory is reserved too (L11).
 */

export const MiB = 1024 * 1024;
export const GiB = 1024 * MiB;

export interface HostFacts {
  /** Logical cores (`hw.ncpu`). */
  cpus: number;
  /** Physical RAM (`hw.memsize`). */
  memBytes: number;
  /** Free bytes on the volume holding the container app root (`statfs`). */
  diskFreeBytes: number;
  /** Bytes PC disks already occupy on that volume (counted back into the pool; 0 when unknown). */
  diskUsedByPcsBytes?: number;
  /** Live free memory (vm_stat free + inactive), for the low-memory warning only. */
  liveFreeMemBytes?: number;
}

export interface BudgetReserves {
  macosGiB: number;
  minecraftGiB: number;
  nodeGiB: number;
  claudePerAgentGiB: number;
  containerSystemGiB: number;
  /** The `container` builder VM, reserved only while an image build runs. */
  builderGiB: number;
}

export interface BudgetSettings {
  crewCap: number;
  reserves: BudgetReserves;
  /** Cores held back from the CPU pool. */
  cpuReserve: number;
  /** Soft-limit overcommit factor for CPUs. */
  cpuOvercommit: number;
  macosMaxRunning: number;
  macosMinFreeDiskGiB: number;
  /** Disk held back from the PC disk pool. */
  diskReserveGiB: number;
  /** Warn when live free memory drops below this. */
  lowMemoryWarnGiB: number;
  /** Host memory each running VM costs beyond its limit (kernel, vminitd, virtio queues). */
  vmMemOverheadMiB: number;
  /** True while an image build (builder VM) runs. */
  builderActive: boolean;
}

export const DEFAULT_RESERVES: BudgetReserves = {
  macosGiB: 10,
  minecraftGiB: 8,
  nodeGiB: 0.5,
  claudePerAgentGiB: 1,
  containerSystemGiB: 1,
  builderGiB: 2,
};

export function defaultBudgetSettings(overrides: Partial<BudgetSettings> = {}): BudgetSettings {
  return {
    crewCap: 4,
    cpuReserve: 4,
    cpuOvercommit: 1.5,
    macosMaxRunning: 2,
    macosMinFreeDiskGiB: 40,
    diskReserveGiB: 20,
    lowMemoryWarnGiB: 1,
    vmMemOverheadMiB: 256,
    builderActive: false,
    ...overrides,
    reserves: { ...DEFAULT_RESERVES, ...overrides.reserves },
  };
}

/** One PC as the budget sees it. */
export interface PcAllocation {
  id: string;
  family: PcFamily;
  cpus: number;
  memMiB: number;
  /** Extra vCPUs the driver adds (Apple `container`: 1). */
  cpuOverhead: number;
  /** Whether it holds CPU/RAM now (running, booting or stopping). Stopped PCs only hold disk. */
  active: boolean;
  /** Sum of its disk caps in GiB (rootfs + home + overlays); counted whether running or not. */
  diskGiB: number;
}

export interface BudgetState {
  host: HostFacts;
  reserve: { memBytes: number; cpus: number; diskBytes: number };
  pool: { memBytes: number; cpus: number; cpuSoftCap: number; diskBytes: number };
  allocated: { cpus: number; memBytes: number; diskBytes: number; macosRunning: number };
  free: { cpus: number; memBytes: number; diskBytes: number; macosSlots: number };
  macosMaxRunning: number;
  warnings: string[];
}

export type AdmissionReason = 'OVER_BUDGET' | 'MACOS_SLOTS';
export type BudgetResource = 'memory' | 'cpu' | 'disk';

export type Admission =
  | { ok: true; warnings: string[] }
  | { ok: false; reason: AdmissionReason; resource?: BudgetResource; detail: string };

/**
 * RAM reserved for everything that isn't a PC. Computed on demand from `crewCap`, so changing the crew
 * cap recomputes the claude reserve (L11).
 */
export function reservedMemBytes(settings: BudgetSettings): number {
  const r = settings.reserves;
  return (
    (r.macosGiB +
      r.minecraftGiB +
      r.nodeGiB +
      r.claudePerAgentGiB * settings.crewCap +
      r.containerSystemGiB +
      (settings.builderActive ? r.builderGiB : 0)) *
    GiB
  );
}

/** CPUs a PC holds while active. */
export function cpuCost(pc: Pick<PcAllocation, 'cpus' | 'cpuOverhead'>): number {
  return pc.cpus + pc.cpuOverhead;
}

/** Host memory a PC holds while active: its limit plus the per-VM overhead. */
export function memCost(pc: Pick<PcAllocation, 'memMiB'>, settings: BudgetSettings): number {
  return (pc.memMiB + settings.vmMemOverheadMiB) * MiB;
}

/** Computes pools, allocations and free capacity. */
export function computeBudget(
  host: HostFacts,
  settings: BudgetSettings,
  pcs: readonly PcAllocation[],
): BudgetState {
  const memReserve = reservedMemBytes(settings);
  const diskReserve = settings.diskReserveGiB * GiB;
  const memPool = Math.max(0, host.memBytes - memReserve);
  const cpuPool = Math.max(0, host.cpus - settings.cpuReserve);
  const cpuSoftCap = Math.floor(cpuPool * settings.cpuOvercommit);
  const diskPool = Math.max(0, host.diskFreeBytes + (host.diskUsedByPcsBytes ?? 0) - diskReserve);

  let cpus = 0;
  let memBytes = 0;
  let diskBytes = 0;
  let macosRunning = 0;
  for (const pc of pcs) {
    diskBytes += pc.diskGiB * GiB;
    if (!pc.active) continue;
    cpus += cpuCost(pc);
    memBytes += memCost(pc, settings);
    if (pc.family === 'macos') macosRunning++;
  }
  const warnings: string[] = [];
  if (cpus > cpuPool)
    warnings.push(`CPU overcommitted: ${cpus} of ${cpuPool} cores (soft cap ${cpuSoftCap})`);
  if (host.liveFreeMemBytes !== undefined && host.liveFreeMemBytes < settings.lowMemoryWarnGiB * GiB) {
    warnings.push(`host memory is low: ${(host.liveFreeMemBytes / GiB).toFixed(1)} GiB free`);
  }
  return {
    host,
    reserve: { memBytes: memReserve, cpus: settings.cpuReserve, diskBytes: diskReserve },
    pool: { memBytes: memPool, cpus: cpuPool, cpuSoftCap, diskBytes: diskPool },
    allocated: { cpus, memBytes, diskBytes, macosRunning },
    free: {
      cpus: cpuPool - cpus,
      memBytes: memPool - memBytes,
      diskBytes: diskPool - diskBytes,
      macosSlots: Math.max(0, settings.macosMaxRunning - macosRunning),
    },
    macosMaxRunning: settings.macosMaxRunning,
    warnings,
  };
}

export interface AdmissionRequest {
  /** `create`: new PC (disk + whether it would fit running); `start`: activate an existing PC; `edit`: resize/retype/remount. */
  kind: 'create' | 'start' | 'edit';
  pc: PcAllocation;
}

const fmtGiB = (b: number) => `${(b / GiB).toFixed(1)} GiB`;

/**
 * Admission (PLAN §8.2): a start or an edit is admitted only if it fits; otherwise OVER_BUDGET (or
 * MACOS_SLOTS for a third macOS VM). The PC being admitted is excluded from the current allocation,
 * so an edit is checked as "replace mine with the new size".
 */
export function admit(
  host: HostFacts,
  settings: BudgetSettings,
  pcs: readonly PcAllocation[],
  request: AdmissionRequest,
): Admission {
  const others = pcs.filter((p) => p.id !== request.pc.id);
  const state = computeBudget(host, settings, others);
  const pc = request.pc;
  const warnings: string[] = [];

  // Disk: every existing PC's caps, including stopped ones. A plain start allocates no new disk, and an
  // edit is charged only the growth of its caps (H5: a CPU-only resize must never fail on disk).
  const before = pcs.find((p) => p.id === pc.id);
  const oldDisk = request.kind === 'edit' ? (before?.diskGiB ?? 0) * GiB : 0;
  const diskNeed = Math.max(0, pc.diskGiB * GiB - oldDisk);
  const diskFree = state.free.diskBytes - oldDisk;
  if (request.kind !== 'start' && diskNeed > 0 && diskNeed > diskFree) {
    return {
      ok: false,
      reason: 'OVER_BUDGET',
      resource: 'disk',
      detail: `needs ${fmtGiB(diskNeed)} more disk, ${fmtGiB(Math.max(0, diskFree))} free`,
    };
  }
  if (pc.family === 'macos' && request.kind === 'create') {
    const minFree = settings.macosMinFreeDiskGiB * 1e9;
    if (host.diskFreeBytes < minFree) {
      return {
        ok: false,
        reason: 'OVER_BUDGET',
        resource: 'disk',
        detail: `a macOS PC needs ${settings.macosMinFreeDiskGiB} GB free disk, ${(host.diskFreeBytes / 1e9).toFixed(0)} GB free`,
      };
    }
  }
  if (!pc.active && request.kind === 'create') return { ok: true, warnings };

  if (pc.family === 'macos' && state.free.macosSlots < 1) {
    return {
      ok: false,
      reason: 'MACOS_SLOTS',
      detail: `Apple allows ${settings.macosMaxRunning} macOS VMs (${state.allocated.macosRunning}/${settings.macosMaxRunning} running)`,
    };
  }
  const memNeed = memCost(pc, settings);
  if (memNeed > state.free.memBytes) {
    return {
      ok: false,
      reason: 'OVER_BUDGET',
      resource: 'memory',
      detail: `needs ${fmtGiB(memNeed)} RAM, ${fmtGiB(Math.max(0, state.free.memBytes))} free of ${fmtGiB(state.pool.memBytes)}`,
    };
  }
  const cpuNeed = cpuCost(pc);
  const cpuAfter = state.allocated.cpus + cpuNeed;
  if (cpuAfter > state.pool.cpuSoftCap) {
    return {
      ok: false,
      reason: 'OVER_BUDGET',
      resource: 'cpu',
      detail: `needs ${cpuNeed} vCPUs (incl. ${pc.cpuOverhead} overhead); ${state.allocated.cpus} of soft cap ${state.pool.cpuSoftCap} in use`,
    };
  }
  if (cpuAfter > state.pool.cpus) {
    warnings.push(`CPU overcommitted: ${cpuAfter} of ${state.pool.cpus} cores`);
  }
  warnings.push(...state.warnings.filter((w) => w.startsWith('host memory')));
  return { ok: true, warnings };
}

/** Boot-order facts for one PC. */
export interface BootCandidate extends PcAllocation {
  pinned?: boolean;
  /** Epoch ms of last use (seat, input, agent work). */
  lastUsedAt?: number;
  createdAt?: number;
}

/** Boot priority (PLAN §8.1): pinned first, then most recently used, then oldest, then id. */
export function compareBootPriority(a: BootCandidate, b: BootCandidate): number {
  if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
  const lu = (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0);
  if (lu !== 0) return lu;
  const ca = (a.createdAt ?? 0) - (b.createdAt ?? 0);
  if (ca !== 0) return ca;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export interface BootPlan {
  /** Ids to boot, in order. */
  boot: string[];
  /** Ids that don't fit, with the refusal. */
  refused: { id: string; reason: AdmissionReason; resource?: BudgetResource; detail: string }[];
  warnings: string[];
}

/**
 * Greedy admission in boot-priority order. `alreadyActive` PCs (running when MineVibe starts) hold
 * their share first; each candidate is admitted against everything admitted before it.
 */
export function planBoot(
  host: HostFacts,
  settings: BudgetSettings,
  candidates: readonly BootCandidate[],
  alreadyActive: readonly PcAllocation[] = [],
): BootPlan {
  const ordered = [...candidates].sort(compareBootPriority);
  const activeIds = new Set(alreadyActive.map((p) => p.id));
  const view = new Map<string, PcAllocation>();
  // `alreadyActive` hold their share first (disk-only entries, like orphaned volumes, keep active=false).
  for (const p of alreadyActive) view.set(p.id, { ...p });
  for (const c of ordered) if (!view.has(c.id)) view.set(c.id, { ...c, active: false });
  const plan: BootPlan = { boot: [], refused: [], warnings: [] };
  for (const c of ordered) {
    if (activeIds.has(c.id)) continue;
    const res = admit(host, settings, [...view.values()], { kind: 'start', pc: { ...c, active: true } });
    if (res.ok) {
      view.set(c.id, { ...c, active: true });
      plan.boot.push(c.id);
      for (const w of res.warnings) if (!plan.warnings.includes(w)) plan.warnings.push(w);
    } else {
      plan.refused.push({
        id: c.id,
        reason: res.reason,
        ...(res.resource ? { resource: res.resource } : {}),
        detail: res.detail,
      });
    }
  }
  return plan;
}
