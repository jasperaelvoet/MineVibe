/**
 * The VM side of a macOS PC (PLAN §8.1, §8.7). Container engines implement {@link PcDriver}; a macOS PC is a whole VM
 * instead: no volumes, networks or published ports, one disk cloned from a base image, folders shared at run time, and
 * spacesd reached on the VM's own NAT address. LumeMacDriver implements it on MineVibe's `lume serve`.
 *
 * The lifecycle verbs match PcDriver's (ensure the engine, create, start, stop, remove, inspect, list), so PcManager runs
 * both kinds under one set of statuses, locks, admissions and budgets.
 */

/** What a VM is doing, as far as MineVibe can tell (Lume's own status is stale after a guest-side shutdown). */
export type MacVmState = 'running' | 'stopped' | 'starting' | 'unknown';

/** One folder shared with the guest at `/Volumes/My Shared Files/<name>`. */
export interface MacShare {
  /** The share's name in the guest (unique per VM; never `setup`). */
  name: string;
  /** Absolute real path on the host. */
  hostPath: string;
  readOnly: boolean;
}

/** Everything needed to make one macOS VM (a clone of the base image). */
export interface MacVmSpec {
  name: string;
  cpus: number;
  memoryMiB: number;
  display: readonly [number, number];
  /** Kept next to the VM (Lume has no labels): nothing is reused, stopped or removed without them. */
  labels: Record<string, string>;
}

/** One start of a VM. */
export interface MacStartSpec {
  name: string;
  /** spacesd's token, written to the read-only `setup` share (0600) right before the start; never logged. */
  token: string;
  /** The Vault folders and the Codex, after `setup` (which the driver adds first). */
  shares: readonly MacShare[];
  /** How long to wait for the VM's address (default 120 s). */
  timeoutMs?: number;
}

export interface MacVmInfo {
  name: string;
  state: MacVmState;
  /** The VM's NAT address (spacesd listens on :3211 there). */
  ip?: string;
  cpus?: number;
  memoryBytes?: number;
  /** `1280x800`. */
  display?: string;
  /** From the VM's MineVibe sidecar ({} for a VM MineVibe did not make). */
  labels: Record<string, string>;
  /** Allocated bytes of the VM's sparse disk (clones share most of them with the base). */
  diskAllocatedBytes?: number;
  /** sha256 of the token in its setup share (the token itself never leaves the driver). */
  tokenSha256?: string;
  /**
   * The folders shared with the current run (Lume's `sessions.json`); `target` is the folder a share link points at
   * (the Vault folder or the Codex), absent for `setup`.
   */
  shares?: { hostPath: string; readOnly: boolean; target?: string }[];
  /** The serve logged that the VM ended after its last start (Lume's status may still say running). */
  ended?: boolean;
}

/** The base image every macOS PC is cloned from. */
export interface MacBaseImage {
  present: boolean;
  /** A pull of it runs now. */
  pulling?: { fraction: number; bytes: number; total: number };
  /** Why a present base does not count (a digest that is not the pinned one). */
  problem?: string;
  allocatedBytes?: number;
}

/** The image download the player approves (`pc.consent`). */
export interface MacImageInfo {
  /** "macOS 26 image (ghcr.io/trycua/macos:26-…)". */
  what: string;
  downloadBytes: number;
  /** Disk the base occupies once pulled (about 1.3 × the download). */
  diskBytes: number;
  digest: string;
}

export type MacStartErrorCode = 'MACOS_SLOTS' | 'START_FAILED' | 'NO_ADDRESS';

/** A VM that did not come up: Apple's limit of two macOS VMs (another app's VMs count too), or another failure. */
export class MacStartError extends Error {
  readonly code: MacStartErrorCode;
  constructor(code: MacStartErrorCode, message: string) {
    super(message);
    this.name = 'MacStartError';
    this.code = code;
  }
}

export interface MacPcDriver {
  readonly kind: 'lume';
  /** The pinned image, for the consent prompt and the disk check. */
  readonly image: MacImageInfo;
  /** Where shares appear in the guest. */
  readonly shareRoot: string;
  /** The guest's path to the ripgrep binary in the setup share, when the driver provides one. */
  readonly guestRipgrep: string | null;

  /**
   * Provisions the runtime (download, verify), starts or joins its server and takes this process's lease. `keep` names
   * the VMs of the caller's own instance: when no other live MineVibe uses the server, every other running MineVibe VM
   * in it is an orphan of a dead process and is stopped; the caller's own are left for it to adopt or stop.
   */
  ensureEngine(options?: {
    keep?: (vmName: string) => boolean;
    onProgress?: (m: string) => void;
  }): Promise<void>;
  /** Drops the lease; stops the server only when no other live MineVibe uses it. Returns whether it stopped. */
  shutdownEngine(): Promise<boolean>;
  /** Whether {@link ensureEngine} succeeded in this process (and the server was not let go since). */
  readonly engineHeld: boolean;
  /**
   * Whether the server this process holds still runs (it may have crashed; its VMs die with it). A server that runs but
   * answers slowly is alive: it is never given up for being busy.
   */
  engineAlive(): Promise<boolean>;
  /** Whether a server of this root runs at all, held or not (no VM can run without one). Starts nothing. */
  engineRunning(): Promise<boolean>;
  /**
   * The reaper (while the engine is held): claims the running VMs `keep` names for this process and stops every other
   * running MineVibe VM whose owner process died. Returns the VMs it stopped.
   */
  reapOrphans(keep: (vmName: string) => boolean): Promise<string[]>;
  /** Whether the VM exists on disk (no engine needed): a PC that never booted has nothing to remove. */
  hasVm(name: string): Promise<boolean>;

  baseImage(): Promise<MacBaseImage>;
  /** Pulls the base image (once; concurrent callers share the pull) and checks its digest. */
  pullBase(onProgress?: (p: { fraction: number; bytes: number; total: number }) => void): Promise<void>;

  /** Clones the base into `spec.name`, sets CPUs, memory and display, and writes the labels. */
  create(spec: MacVmSpec): Promise<MacVmInfo>;
  /** CPUs, memory and display of a stopped VM. */
  configure(
    name: string,
    r: { cpus: number; memoryMiB: number; display: readonly [number, number] },
  ): Promise<void>;
  /** Starts the VM with its shares and token; resolves with its address, or throws {@link MacStartError}. */
  start(spec: MacStartSpec): Promise<{ ip: string }>;
  /**
   * Stops the VM. With `graceful`, that callback asks the guest to shut down first (spacesd) and the VM gets
   * `timeoutMs` (default 30 s) to end before it is powered off.
   */
  stop(name: string, options?: { graceful?: () => Promise<void>; timeoutMs?: number }): Promise<void>;
  /** Deletes the VM (stopping it first) and its shares folder; a VM not on disk needs no engine. */
  remove(name: string): Promise<void>;
  inspect(name: string): Promise<MacVmInfo | null>;
  /** VMs whose labels carry every given label. */
  list(labels: Record<string, string>): Promise<MacVmInfo[]>;
}
