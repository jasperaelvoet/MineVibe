/**
 * PC types (PLAN §8.1). `linux` and `linux-slim` run on Apple `container` (or Docker in dev/CI),
 * `macos` is a Lume VM (driver stub until M9, at most 2 running), `windows` is shown greyed out.
 */

export const PC_TYPES = ['linux', 'linux-slim', 'macos', 'windows'] as const;
export type PcType = (typeof PC_TYPES)[number];

export type PcFamily = 'linux' | 'macos' | 'windows';
export type PcDriverKind = 'apple-container' | 'docker' | 'lume';

/** Local tag of the MineVibe Linux PC image built from `images/linux-pc` (PLAN §9.3 fallback). */
export const LINUX_PC_IMAGE_DEV = 'minevibe/linux-pc:dev';

export interface PcResources {
  cpus: number;
  memMiB: number;
  /** `/dev/shm` size (Linux only). */
  shmMiB: number;
}

/** Disk caps in GiB (PLAN §8.6: every volume and rootfs gets an explicit cap, which the budget counts). */
export interface PcDiskCaps {
  /** The `/home/cua` named volume. */
  homeGiB: number;
  /** Each build-dir overlay volume. */
  overlayGiB: number;
  /**
   * The container root filesystem. Apple `container` 1.5.0 has no rootfs size flag (it is a 512 GiB
   * sparse image), so this is an accounting allowance, not an enforced cap.
   */
  rootfsGiB: number;
}

export interface PcTypeSpec {
  type: PcType;
  label: string;
  family: PcFamily;
  /** Whether a PC of this type can be created on this host at all. */
  available: boolean;
  unavailableReason?: string;
  /** True while the driver is a stub (macOS until M9): PCs can be configured but not booted. */
  driverStub?: boolean;
  defaults: PcResources;
  min: Pick<PcResources, 'cpus' | 'memMiB'>;
  max: Pick<PcResources, 'cpus' | 'memMiB'>;
  disk: PcDiskCaps;
  /** Running instances allowed host-wide (Apple: 2 macOS VMs). */
  maxRunning?: number;
  /** Free disk needed to create one (macOS: 40 GB). */
  minFreeDiskGiB?: number;
  /** Image reference the driver runs. */
  image?: string;
  /** Default display size. */
  display: [number, number];
}

const GiB_MiB = 1024;

export const PC_TYPE_SPECS: Readonly<Record<PcType, PcTypeSpec>> = {
  linux: {
    type: 'linux',
    label: 'Linux',
    family: 'linux',
    available: true,
    defaults: { cpus: 2, memMiB: 4 * GiB_MiB, shmMiB: 2 * GiB_MiB },
    min: { cpus: 1, memMiB: 1 * GiB_MiB },
    max: { cpus: 16, memMiB: 64 * GiB_MiB },
    disk: { homeGiB: 32, overlayGiB: 16, rootfsGiB: 24 },
    image: LINUX_PC_IMAGE_DEV,
    display: [1280, 800],
  },
  'linux-slim': {
    type: 'linux-slim',
    label: 'Linux (slim)',
    family: 'linux',
    available: true,
    defaults: { cpus: 1, memMiB: 2 * GiB_MiB, shmMiB: 1 * GiB_MiB },
    min: { cpus: 1, memMiB: 1 * GiB_MiB },
    max: { cpus: 16, memMiB: 64 * GiB_MiB },
    disk: { homeGiB: 16, overlayGiB: 8, rootfsGiB: 16 },
    // A slim image (FROM trycua/linux:24.04-slim) is not built yet; it shares the full image for now.
    image: LINUX_PC_IMAGE_DEV,
    display: [1280, 800],
  },
  macos: {
    type: 'macos',
    label: 'macOS',
    family: 'macos',
    available: true,
    driverStub: true,
    defaults: { cpus: 4, memMiB: 8 * GiB_MiB, shmMiB: 0 },
    min: { cpus: 2, memMiB: 4 * GiB_MiB },
    max: { cpus: 12, memMiB: 32 * GiB_MiB },
    // The macOS image defines a 150 GiB sparse disk.
    disk: { homeGiB: 0, overlayGiB: 0, rootfsGiB: 150 },
    maxRunning: 2,
    minFreeDiskGiB: 40,
    image: 'ghcr.io/trycua/macos:26',
    display: [1280, 800],
  },
  windows: {
    type: 'windows',
    label: 'Windows',
    family: 'windows',
    available: false,
    unavailableReason: 'Unavailable on Apple Silicon (emulation too slow)',
    defaults: { cpus: 0, memMiB: 0, shmMiB: 0 },
    min: { cpus: 0, memMiB: 0 },
    max: { cpus: 0, memMiB: 0 },
    disk: { homeGiB: 0, overlayGiB: 0, rootfsGiB: 0 },
    display: [1280, 800],
  },
};

export function isPcType(v: unknown): v is PcType {
  return typeof v === 'string' && (PC_TYPES as readonly string[]).includes(v);
}

export function pcTypeSpec(type: PcType): PcTypeSpec {
  return PC_TYPE_SPECS[type];
}

/** PC ids are slugs: `linux-1`, `mac-2`, … (used in container, volume and file names). */
export const PC_ID_RE = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

export function assertPcId(id: string): string {
  if (!PC_ID_RE.test(id)) throw new Error(`invalid PC id "${id}"`);
  return id;
}

/** Container name for a PC. */
export function containerName(pcId: string): string {
  return `mv-pc-${assertPcId(pcId)}`;
}

/** The home volume of a PC. */
export function homeVolumeName(pcId: string): string {
  return `mv-pc-${assertPcId(pcId)}-home`;
}

/** Clamps requested resources to the type's min/max. */
export function clampResources(type: PcType, r: Partial<PcResources>): PcResources {
  const spec = PC_TYPE_SPECS[type];
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.round(v)));
  return {
    cpus: clamp(r.cpus ?? spec.defaults.cpus, spec.min.cpus, spec.max.cpus),
    memMiB: clamp(r.memMiB ?? spec.defaults.memMiB, spec.min.memMiB, spec.max.memMiB),
    shmMiB: clamp(r.shmMiB ?? spec.defaults.shmMiB, 0, spec.max.memMiB),
  };
}

/**
 * PC statuses (PLAN §8.1). `downloading` and `booting` carry a progress percentage. Each one is shown on
 * the monitor, the LED, the HUD hover line and the config screen.
 */
export const PC_STATUSES = [
  'off',
  'downloading',
  'awaiting_consent',
  'booting',
  'running',
  'stopping',
  'remounting',
  'reimaging',
  'no_capacity',
  'macos_slots_full',
  'engine_down',
  'error',
] as const;
export type PcStatus = (typeof PC_STATUSES)[number];
