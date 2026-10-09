/**
 * An in-memory macOS VM driver for the PcManager unit tests (the real one is LumeMacDriver on `lume serve`).
 */
import {
  type MacBaseImage,
  type MacImageInfo,
  type MacPcDriver,
  type MacShare,
  MacStartError,
  type MacStartSpec,
  type MacVmInfo,
  type MacVmSpec,
} from '../../src/pcs/drivers/MacPcDriver.js';
import { hasLabels, tokenFingerprint } from '../../src/pcs/drivers/PcDriver.js';

export interface FakeVm {
  spec: MacVmSpec;
  cpus: number;
  memoryMiB: number;
  display: string;
  state: 'running' | 'stopped';
  ip?: string;
  token?: string;
  shares: MacShare[];
  /** The guest shut down by itself (Lume would still say running). */
  ended?: boolean;
}

export class FakeMacDriver implements MacPcDriver {
  readonly kind = 'lume' as const;
  readonly shareRoot = '/Volumes/My Shared Files';
  readonly guestRipgrep = '/Volumes/My Shared Files/setup/rg';
  readonly image: MacImageInfo = {
    what: 'macOS 26 image (ghcr.io/trycua/macos:26-test)',
    downloadBytes: 23_825_217_508,
    diskBytes: 161_061_273_600,
    digest: `sha256:${'d'.repeat(64)}`,
  };
  engineHeld = false;
  basePresent = true;
  vms = new Map<string, FakeVm>();
  log: string[] = [];
  /** The `keep` the engine was started with. */
  keep: ((vm: string) => boolean) | null = null;
  engineError: Error | null = null;
  /** Errors the next starts throw, one per call. */
  startErrors: Error[] = [];
  pullSteps = [0.1, 0.5, 1];
  /** A pull waits for this after its first step (a long download). */
  pullHold: Promise<void> | null = null;
  gracefulCalls = 0;
  #ips = 2;

  /** The serve died under us: its VMs died with it; list fails until the engine is ensured again. */
  serveDead = false;

  async ensureEngine(options: { keep?: (vm: string) => boolean } = {}) {
    if (this.engineError) throw this.engineError;
    this.engineHeld = true;
    this.serveDead = false;
    this.keep = options.keep ?? null;
    this.log.push('engine');
  }
  async engineAlive() {
    return this.engineHeld && !this.serveDead;
  }
  /** A serve of the root runs (this process's or another's); set by hand for "another process kept it". */
  serveRunsElsewhere = false;
  async engineRunning() {
    return (this.engineHeld && !this.serveDead) || this.serveRunsElsewhere;
  }
  /** What the reaper was called with, and the VMs it reports stopped. */
  reaps: ((vm: string) => boolean)[] = [];
  reapResult: string[] = [];
  async reapOrphans(keep: (vm: string) => boolean) {
    this.reaps.push(keep);
    return this.reapResult;
  }
  async hasVm(name: string) {
    return this.vms.has(name);
  }
  /** Lume crashed: every VM stopped and the API is gone. */
  crashServe(): void {
    this.serveDead = true;
    for (const vm of this.vms.values()) vm.state = 'stopped';
  }
  async shutdownEngine() {
    if (!this.engineHeld) return false;
    this.engineHeld = false;
    this.log.push('engine-stop');
    return true;
  }
  async baseImage(): Promise<MacBaseImage> {
    return { present: this.basePresent };
  }
  #pull: Promise<void> | null = null;
  readonly #listeners = new Set<(p: { fraction: number; bytes: number; total: number }) => void>();
  /** Like LumeMacDriver: concurrent callers share one pull and all get its progress. */
  pullBase(onProgress?: (p: { fraction: number; bytes: number; total: number }) => void): Promise<void> {
    if (onProgress) this.#listeners.add(onProgress);
    this.#pull ??= (async () => {
      this.log.push('pull');
      for (const [i, f] of this.pullSteps.entries()) {
        await new Promise((r) => setTimeout(r, 1));
        for (const l of this.#listeners) {
          l({ fraction: f, bytes: f * this.image.downloadBytes, total: this.image.downloadBytes });
        }
        if (i === 0 && this.pullHold) await this.pullHold;
      }
      this.basePresent = true;
    })().finally(() => {
      this.#pull = null;
      this.#listeners.clear();
    });
    return this.#pull;
  }
  async create(spec: MacVmSpec): Promise<MacVmInfo> {
    if (!this.basePresent) throw new Error('no base image');
    this.log.push(`create ${spec.name}`);
    this.vms.set(spec.name, {
      spec,
      cpus: spec.cpus,
      memoryMiB: spec.memoryMiB,
      display: `${spec.display[0]}x${spec.display[1]}`,
      state: 'stopped',
      shares: [],
    });
    return (await this.inspect(spec.name)) as MacVmInfo;
  }
  async configure(name: string, r: { cpus: number; memoryMiB: number; display: readonly [number, number] }) {
    const vm = this.vms.get(name);
    if (!vm) throw new Error(`no VM ${name}`);
    if (vm.state === 'running') throw new Error('configure needs a stopped VM');
    this.log.push(`configure ${name} ${r.cpus}/${r.memoryMiB}`);
    vm.cpus = r.cpus;
    vm.memoryMiB = r.memoryMiB;
    vm.display = `${r.display[0]}x${r.display[1]}`;
  }
  async start(spec: MacStartSpec): Promise<{ ip: string }> {
    const vm = this.vms.get(spec.name);
    if (!vm) throw new Error(`no VM ${spec.name}`);
    this.log.push(
      `start ${spec.name} ${spec.shares.map((s) => `${s.name}${s.readOnly ? ':ro' : ''}`).join(',')}`,
    );
    const e = this.startErrors.shift();
    if (e) throw e;
    vm.state = 'running';
    vm.ended = false;
    vm.ip = `192.168.64.${this.#ips++}`;
    vm.token = spec.token;
    vm.shares = [...spec.shares];
    return { ip: vm.ip };
  }
  async stop(name: string, options: { graceful?: () => Promise<void>; timeoutMs?: number } = {}) {
    const vm = this.vms.get(name);
    if (!vm) return;
    if (options.graceful && vm.state === 'running' && !vm.ended) {
      this.gracefulCalls++;
      await options.graceful().catch(() => {});
    }
    this.log.push(`stop ${name}`);
    vm.state = 'stopped';
    vm.ended = false;
  }
  async remove(name: string) {
    this.log.push(`remove ${name}`);
    this.vms.delete(name);
  }
  async inspect(name: string): Promise<MacVmInfo | null> {
    const vm = this.vms.get(name);
    if (!vm) return null;
    return {
      name,
      state: vm.ended ? 'stopped' : vm.state,
      ...(vm.ended ? { ended: true } : {}),
      ...(vm.ip && vm.state === 'running' ? { ip: vm.ip } : {}),
      cpus: vm.cpus,
      memoryBytes: vm.memoryMiB * 1024 * 1024,
      display: vm.display,
      labels: vm.spec.labels,
      ...(vm.token ? { tokenSha256: tokenFingerprint(vm.token) } : {}),
      ...(vm.state === 'running'
        ? {
            shares: [
              { hostPath: `/lume/shares/${name}/setup`, readOnly: true },
              ...vm.shares.map((s) => ({
                hostPath: `/lume/shares/${name}/links/${s.name}`,
                readOnly: s.readOnly,
                target: s.hostPath,
              })),
            ],
          }
        : {}),
    };
  }
  async list(labels: Record<string, string>): Promise<MacVmInfo[]> {
    if (this.serveDead) throw new Error('lume GET /lume/vms: fetch failed');
    const out: MacVmInfo[] = [];
    for (const name of this.vms.keys()) {
      const info = await this.inspect(name);
      if (info && hasLabels(info.labels, labels)) out.push(info);
    }
    return out;
  }
}

export { MacStartError };
