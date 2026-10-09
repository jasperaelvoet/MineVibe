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
  /** The capped `/tmp` volume (cleared on every boot by the image's boot hook). */
  tmpGiB: number;
  /** The capped `/var/tmp` volume. */
  varTmpGiB: number;
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
    disk: { homeGiB: 32, overlayGiB: 16, tmpGiB: 8, varTmpGiB: 4, rootfsGiB: 24 },
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
    disk: { homeGiB: 16, overlayGiB: 8, tmpGiB: 4, varTmpGiB: 2, rootfsGiB: 16 },
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
    disk: { homeGiB: 0, overlayGiB: 0, tmpGiB: 0, varTmpGiB: 0, rootfsGiB: 150 },
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
    disk: { homeGiB: 0, overlayGiB: 0, tmpGiB: 0, varTmpGiB: 0, rootfsGiB: 0 },
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

/**
 * MineVibe instance id: a short hash of the state directory. Every container, volume and network name
 * and label carries it, so two dev servers (or a test run) sharing one `container` app root never act on
 * each other's PCs (PLAN §8.6).
 */
export const INSTANCE_ID_RE = /^[a-z0-9]{4,12}$/;

function scope(instance: string, pcId: string): string {
  if (!INSTANCE_ID_RE.test(instance)) throw new Error(`invalid instance id "${instance}"`);
  return `mv-pc-${instance}-${assertPcId(pcId)}`;
}

/** Container name for a PC. */
export function containerName(pcId: string, instance: string): string {
  return scope(instance, pcId);
}

/**
 * The container name used before instance scoping (`mv-pc-<id>`, label `minevibe=pc` but no
 * `minevibe.instance`). Reconcile looks for these so a leftover from an older build is not left running
 * unseen (M1).
 */
export function legacyContainerName(pcId: string): string {
  return `mv-pc-${assertPcId(pcId)}`;
}

/** The home volume of a PC. */
export function homeVolumeName(pcId: string, instance: string): string {
  return `${scope(instance, pcId)}-home`;
}

/** The capped `/tmp` and `/var/tmp` volumes of a PC. */
export function tmpVolumeName(pcId: string, instance: string, which: 'tmp' | 'vartmp'): string {
  return `${scope(instance, pcId)}-${which}`;
}

/** The PC's own network (Apple `container` 1.5.0 isolates networks from each other, PLAN §8.6). */
export function networkName(pcId: string, instance: string): string {
  return `${scope(instance, pcId)}-net`;
}

/** Prefix of every overlay volume of a PC. */
export function overlayVolumePrefix(pcId: string, instance: string): string {
  return `${scope(instance, pcId)}-ov-`;
}

/**
 * The container of a PC's Android phone (PLAN §8.7): a Redroid container on the PC's own network. It keeps the PC's
 * `mv-pc-<instance>-` prefix, so `doctor --clean-orphans` finds it with the rest of the instance.
 */
export function phoneContainerName(pcId: string, instance: string): string {
  return `${scope(instance, pcId)}-phone`;
}

/** The phone's `/data` volume (installed apps and their saves survive a PC restart). */
export function phoneDataVolumeName(pcId: string, instance: string): string {
  return `${scope(instance, pcId)}-phone-data`;
}

/**
 * The Android phone a Linux PC can have (PLAN §8.7, spike S9-android): 4 vCPUs and 4 GiB are what a game needed at
 * 60 fps (~300 % CPU, 2.4 GiB); `/data` gets its own capped volume.
 */
export const PHONE_RESOURCES = { cpus: 4, memMiB: 4096, dataGiB: 8 } as const;

/**
 * Host memory a PC with nested virtualization is charged beyond its limit (PLAN §8.7): the hypervisor's shadow
 * stage-2 tables and the nested guests' exits cost the host more than a plain VM. An estimate, not a measurement.
 */
export const VIRTUALIZATION_OVERHEAD_MIB = 512;

/**
 * Images a PC may run: the type's own image, the local dev tag, or the published MineVibe Linux PC image
 * (by tag or digest). Anything else is refused (L4), so a crafted `pcs.json` or API call cannot point a
 * PC at an arbitrary image.
 */
export function isAllowedImage(type: PcType, ref: string): boolean {
  if (ref === PC_TYPE_SPECS[type].image) return true;
  if (PC_TYPE_SPECS[type].family !== 'linux') return false;
  return (
    /^minevibe\/linux-pc(?:-slim)?:[a-z0-9][a-z0-9._-]{0,63}$/.test(ref) ||
    /^ghcr\.io\/jasperaelvoet\/minevibe-linux-pc(?:-slim)?(?::[a-z0-9][a-z0-9._-]{0,63})?(?:@sha256:[0-9a-f]{64})?$/.test(
      ref,
    )
  );
}

/** Why a resource request is unusable (not a finite non-negative number, `/dev/shm` above RAM), or null. */
export function resourceProblem(r: Partial<PcResources>): string | null {
  for (const k of ['cpus', 'memMiB', 'shmMiB'] as const) {
    const v = r[k];
    if (v !== undefined && (typeof v !== 'number' || !Number.isFinite(v) || v < 0)) {
      return `${k} must be a non-negative number`;
    }
  }
  if (r.shmMiB !== undefined && r.memMiB !== undefined && r.shmMiB > r.memMiB) {
    return `/dev/shm (${r.shmMiB} MiB) cannot exceed the PC's memory (${r.memMiB} MiB)`;
  }
  return null;
}

/**
 * Clamps requested resources to the type's min/max. `/dev/shm` never exceeds the PC's memory (by default
 * it is the type's default, at most half of the memory).
 */
export function clampResources(type: PcType, r: Partial<PcResources>): PcResources {
  const spec = PC_TYPE_SPECS[type];
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.round(v)));
  const memMiB = clamp(r.memMiB ?? spec.defaults.memMiB, spec.min.memMiB, spec.max.memMiB);
  const shmDefault = Math.min(spec.defaults.shmMiB, Math.floor(memMiB / 2));
  return {
    cpus: clamp(r.cpus ?? spec.defaults.cpus, spec.min.cpus, spec.max.cpus),
    memMiB,
    shmMiB: clamp(r.shmMiB ?? shmDefault, 0, memMiB),
  };
}

/** The disk cap keys a PC record knows. */
export const DISK_CAP_KEYS: readonly (keyof PcDiskCaps)[] = [
  'homeGiB',
  'overlayGiB',
  'tmpGiB',
  'varTmpGiB',
  'rootfsGiB',
];

const isDiskCapKey = (k: string): k is keyof PcDiskCaps => (DISK_CAP_KEYS as readonly string[]).includes(k);

/**
 * Why disk caps are unusable (L4), or null. Unknown `disk.*` keys are refused (a typo would otherwise be
 * stored and silently ignored), and Linux PCs need every volume cap ≥ 1 GiB.
 */
export function diskCapsProblem(type: PcType, d: Partial<PcDiskCaps>): string | null {
  if (typeof d !== 'object' || d === null || Array.isArray(d)) return 'disk must be an object';
  const linux = PC_TYPE_SPECS[type].family === 'linux';
  for (const [k, v] of Object.entries(d)) {
    if (!isDiskCapKey(k)) return `unknown disk cap disk.${k}`;
    if (v === undefined) continue;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 4096) {
      return `disk.${k} must be a number of GiB between 0 and 4096`;
    }
    if (linux && k !== 'rootfsGiB' && v < 1) return `disk.${k} must be at least 1 GiB`;
  }
  return null;
}

/** Disk caps read from `pcs.json`: the type's defaults overridden by every known, valid stored value. */
export function sanitizeDiskCaps(type: PcType, stored: unknown): PcDiskCaps {
  const caps: PcDiskCaps = { ...PC_TYPE_SPECS[type].disk };
  if (typeof stored !== 'object' || stored === null) return caps;
  for (const [k, v] of Object.entries(stored)) {
    if (!isDiskCapKey(k) || diskCapsProblem(type, { [k]: v })) continue;
    caps[k] = v as number;
  }
  return caps;
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
