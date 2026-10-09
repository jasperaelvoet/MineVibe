import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Logger } from 'pino';
import { downloadVerified, type FetchLike } from '../../launcher/download.js';
import { GiB } from '../Budget.js';
import { type AndroidDriverOps, type PcDriver, ROLE_LABEL } from '../drivers/PcDriver.js';
import { freeDiskBytes } from '../host.js';
import { addRelativeEtcLayer } from './oci.js';

/**
 * AndroidKit (PLAN §8.8, spike S9-android): what the Android phone and nested virtualization need on the host, made
 * once and shared by every PC of every MineVibe on this engine.
 *
 * - **MineVibe's Android kernel.** The engine's stock kernel has neither binder (Android) nor KVM (nested
 *   virtualization). It is built on demand from the pinned kernel.org source with the stock kernel's own config
 *   (`/proc/config.gz` of the build container, which runs on it) plus {@link KERNEL_FRAGMENT}, in a one-shot container
 *   of the Linux PC image (~4 min, once). Containers get it per container with `--kernel`; the engine default is never
 *   changed. `MINEVIBE_ANDROID_KERNEL` points at a kernel built elsewhere instead.
 * - **The phone image.** Redroid 15 (64-bit only), pulled by digest, with one added layer that makes its absolute
 *   `/etc` symlink relative (Apple's vminitd writes `/etc/hosts` through it), loaded as {@link PHONE_IMAGE}.
 *
 * Downloads report progress; nothing is fetched before a PC asks for a phone or for virtualization.
 */

/** The kernel MineVibe builds: Linux 6.18.35 (the stock kernel's version) with KVM, binder and PSI. */
export const ANDROID_KERNEL = {
  /** Kernel id in labels and file names; bump it whenever {@link KERNEL_FRAGMENT} or the source changes. */
  id: '6.18.35-mv-android2',
  file: 'vmlinux-6.18.35-mv-android2',
  source: {
    url: 'https://cdn.kernel.org/pub/linux/kernel/v6.x/linux-6.18.35.tar.xz',
    file: 'linux-6.18.35.tar.xz',
    size: 154_511_164,
    sha256: 'f78602932219125e211c5f5bfd84edcfd4ec5ce88fc944f8248413f665bef236',
  },
} as const;

/**
 * What the Android kernel adds to the stock (Kata) config: KVM for nested virtualization; binder and binderfs for
 * Android; PSI on by default (Android's lmkd restart-loops without it: a 76 s boot and 50 s app starts in the spike);
 * transparent huge pages; the vhost, sync, dma-buf and uinput bits Android and QEMU use; no debug info (a faster
 * build of the same Image).
 */
export const KERNEL_FRAGMENT = `# MineVibe Android kernel (${ANDROID_KERNEL.id}) on top of the engine's stock config
CONFIG_VIRTUALIZATION=y
CONFIG_KVM=y
CONFIG_ANDROID_BINDER_IPC=y
CONFIG_ANDROID_BINDERFS=y
CONFIG_ANDROID_BINDER_DEVICES="binder,hwbinder,vndbinder"
CONFIG_VHOST_MENU=y
CONFIG_VHOST=y
CONFIG_VHOST_NET=y
CONFIG_VHOST_VSOCK=y
CONFIG_USERFAULTFD=y
CONFIG_SYNC_FILE=y
CONFIG_SW_SYNC=y
CONFIG_DMABUF_HEAPS=y
CONFIG_DMABUF_HEAPS_SYSTEM=y
CONFIG_UDMABUF=y
CONFIG_INPUT_MISC=y
CONFIG_INPUT_UINPUT=y
CONFIG_TRANSPARENT_HUGEPAGE=y
CONFIG_TRANSPARENT_HUGEPAGE_ALWAYS=y
# CONFIG_TRANSPARENT_HUGEPAGE_MADVISE is not set
# CONFIG_PSI_DEFAULT_DISABLED is not set
# CONFIG_DEBUG_INFO is not set
CONFIG_DEBUG_INFO_NONE=y
# CONFIG_DEBUG_INFO_DWARF_TOOLCHAIN_DEFAULT is not set
# CONFIG_DEBUG_INFO_DWARF4 is not set
# CONFIG_DEBUG_INFO_DWARF5 is not set
# CONFIG_DEBUG_INFO_BTF is not set
CONFIG_LOCALVERSION="-mv-android2"
`;

/** Lines `MV-PROGRESS <percent> <what>` mark the build's phases; `make` prints one line per object. */
export const KERNEL_BUILD_SCRIPT = `#!/bin/bash
# MineVibe Android kernel build (PLAN §8.8). Runs as root in a one-shot container of the Linux PC image, on the
# engine's stock kernel, with /work = the kit's folder on the host and $1 = this build's folder in it.
set -euo pipefail
B="/work/$1"
export DEBIAN_FRONTEND=noninteractive
echo "MV-PROGRESS 2 installing build tools"
apt-get update -qq
apt-get install -y -qq --no-install-recommends build-essential flex bison bc libelf-dev libssl-dev xz-utils cpio kmod python3 >/dev/null
echo "MV-PROGRESS 8 unpacking the kernel source"
rm -rf /kbuild && mkdir -p /kbuild
tar -xf /work/cache/${ANDROID_KERNEL.source.file} -C /kbuild --strip-components=1
cd /kbuild
if [ ! -r /proc/config.gz ]; then echo "MV-ERROR the engine's kernel exposes no /proc/config.gz"; exit 3; fi
zcat /proc/config.gz > .config
./scripts/kconfig/merge_config.sh -m .config "$B/android.fragment" >/dev/null
make olddefconfig >/dev/null
for o in VIRTUALIZATION KVM ANDROID_BINDER_IPC ANDROID_BINDERFS PSI; do
  grep -q "^CONFIG_$o=y" .config || { echo "MV-ERROR CONFIG_$o is not set"; exit 3; }
done
if grep -q '^CONFIG_PSI_DEFAULT_DISABLED=y' .config; then echo "MV-ERROR PSI is disabled by default"; exit 3; fi
echo "MV-PROGRESS 12 compiling"
make -j"$(nproc)" Image
cp arch/arm64/boot/Image "$B/Image"
cp .config "$B/config"
echo "MV-PROGRESS 100 done"
`;

/** Objects a build of the Android kernel compiles (`CC`/`AS`/`AR`/`LD` lines; measured 3 056 on 2026-10-09). */
export const KERNEL_BUILD_OBJECTS = 3_100;

/** The Android phone's image: Redroid 15, 64-bit only (Apple silicon has no AArch32), plus the relative-/etc layer. */
export const PHONE_IMAGE = {
  ref: 'minevibe/android-phone:15.0.0-r1',
  source: 'docker.io/redroid/redroid@sha256:b51bde9cef80f7bd7581148192f2b2f4d41f23c6344cfe88eceeb8ddd67490ee',
  /** Its linux/arm64 manifest (checked in the saved tar before it is patched). */
  arm64Manifest: 'sha256:dc2024a999dd0acb1112a23cddc9537ec8cb60a0dbe5a87ce9fbd75a2f5e94d2',
  /** The patched image's index digest (the patch is deterministic; measured on the pinned source). */
  patchedIndex: 'sha256:cefb267743ec2b9fbf668d9ee8c2b38d53065d6c8eb9e2e61c47a47c331abad7',
  /** Compressed size of the download, for the progress text and the disk check. */
  downloadBytes: 693_612_895,
} as const;

/** Android init arguments of the phone (`androidboot.redroid_fps=60`: 62 fps in a game; the default 30 Hz gave 15). */
export const PHONE_INIT_ARGS = [
  'androidboot.redroid_gpu_mode=guest',
  'androidboot.redroid_fps=60',
  'androidboot.use_memfd=true',
] as const;

/** Free disk an image preparation needs: the saved tar and its patched copy (~0.7 GB each), plus room. */
const IMAGE_PREP_FREE_BYTES = 3 * GiB;

export type KitProgress = (percent: number, detail: string) => void;

/** The pinned phone image (tests pass their own). */
export interface PhoneImagePin {
  ref: string;
  source: string;
  arm64Manifest: string;
  patchedIndex: string;
  /** Compressed size of the source download (default {@link PHONE_IMAGE}'s). */
  downloadBytes?: number;
}

/**
 * Apt packages the kernel build installs in its container on top of the Linux PC image (flex, bison, bc, libelf-dev,
 * libssl-dev, cpio, kmod; build-essential is in the image already): an estimate for the download consent.
 */
export const KERNEL_BUILD_TOOLS_BYTES = 60_000_000;

/** One thing a capability must fetch before it can be used (PLAN §8.8): what the player is asked to OK first. */
export interface KitDownload {
  /** Stable for what is fetched (`kernel:<id>`, `phone:<digest>`): an OK given once covers it. */
  key: string;
  /** About how much is downloaded. */
  bytes: number;
  /** In the player's words, a few words long ("Android 15"): the consent modal shows it on one line. */
  what: string;
}

export interface AndroidKitOptions {
  /** `<appRoot>/minevibe-android`: the kernel, the source cache, temporary files. It must be mountable (no TCC). */
  readonly dir: string;
  readonly driver: Pick<PcDriver, 'imageExists' | 'pullImage' | 'android'>;
  /** The image the kernel is built in (the Linux PC image: Ubuntu 24.04 with build-essential). */
  readonly buildImage: string;
  /** Labels of the build container (this instance's). */
  readonly labels: Readonly<Record<string, string>>;
  /** Names the build container (`mv-pc-<instance>-kbuild`, so `doctor --clean-orphans` finds a leftover). */
  readonly instanceId: string;
  readonly logger?: Logger;
  readonly fetch?: FetchLike;
  /** A kernel built elsewhere (`MINEVIBE_ANDROID_KERNEL`): used as it is, nothing is built. */
  readonly kernelOverride?: string | null;
  /** Makes sure {@link buildImage} exists (PcManager.ensureImage). */
  readonly ensureBuildImage?: (onProgress?: (m: string) => void) => Promise<void>;
  /**
   * Admits the build container into the PC budget and returns its release (PcManager); it throws when the build does
   * not fit now.
   */
  readonly admitBuild?: (resources: { cpus: number; memMiB: number }) => Promise<() => void>;
  /**
   * Build container resources, tried in order until one fits the budget (default 6, 4, then 2 vCPUs with 3 GiB; 4
   * vCPUs took 3.3 min in all on an M5 Pro).
   */
  readonly buildResources?: readonly { cpus: number; memMiB: number }[];
  /** Kernel build timeout (default 40 min). */
  readonly buildTimeoutMs?: number;
  /** The phone image to prepare (default {@link PHONE_IMAGE}). */
  readonly phoneImage?: PhoneImagePin;
  /** Free bytes on the disk of a folder (default `statfs`; tests pass their own). */
  readonly freeDiskBytes?: (path: string) => Promise<number>;
}

/** What PcManager uses of the kit (tests pass a fake). */
export type AndroidKitLike = Pick<
  AndroidKit,
  'supported' | 'kernelPath' | 'kernelReady' | 'ensureKernel' | 'phoneImageReady' | 'ensurePhoneImage'
> &
  Partial<Pick<AndroidKit, 'downloadsNeeded'>>;

interface KernelMarker {
  id: string;
  sha256: string;
  size: number;
  builtAt: string;
}

/** The arm64 Image header magic ("ARM\x64" at 0x38). */
async function isArm64Image(path: string): Promise<boolean> {
  const fh = await open(path, 'r');
  try {
    const b = Buffer.alloc(4);
    await fh.read(b, 0, 4, 0x38);
    return b.toString('latin1') === 'ARM\x64';
  } finally {
    await fh.close();
  }
}

async function sha256File(path: string): Promise<string> {
  const h = createHash('sha256');
  await pipeline(createReadStream(path), h);
  return h.digest('hex');
}

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err)).slice(0, 300);

export class AndroidKit {
  readonly #o: AndroidKitOptions;
  #kernel: Promise<string> | null = null;
  #image: Promise<string> | null = null;
  /** Listeners of the build in flight (several PCs may wait on one build). */
  readonly #kernelListeners = new Set<KitProgress>();
  readonly #imageListeners = new Set<KitProgress>();

  constructor(options: AndroidKitOptions) {
    this.#o = options;
  }

  /** Whether the engine can do any of this (Apple `container`). */
  get supported(): boolean {
    return this.#o.driver.android !== undefined;
  }

  get #ops(): AndroidDriverOps {
    const ops = this.#o.driver.android;
    if (!ops) throw new Error('the Android phone and nested virtualization need Apple container');
    return ops;
  }

  get kernelPath(): string {
    return this.#o.kernelOverride || join(this.#o.dir, 'kernel', ANDROID_KERNEL.file);
  }

  /** Whether the kernel is ready now (no download or build needed). */
  async kernelReady(): Promise<boolean> {
    if (this.#o.kernelOverride) return existsSync(this.#o.kernelOverride);
    try {
      const m = JSON.parse(await readFile(`${this.kernelPath}.json`, 'utf8')) as KernelMarker;
      const st = await stat(this.kernelPath);
      return m.id === ANDROID_KERNEL.id && m.size === st.size;
    } catch {
      return false;
    }
  }

  /** The kernel's path, building it first when needed (one build at a time, shared by every caller). */
  async ensureKernel(onProgress?: KitProgress): Promise<string> {
    if (await this.kernelReady()) return this.kernelPath;
    if (this.#o.kernelOverride)
      throw new Error(`MINEVIBE_ANDROID_KERNEL ${this.#o.kernelOverride} does not exist`);
    if (onProgress) this.#kernelListeners.add(onProgress);
    try {
      this.#kernel ??= this.#buildKernel().finally(() => {
        this.#kernel = null;
      });
      return await this.#kernel;
    } finally {
      if (onProgress) this.#kernelListeners.delete(onProgress);
    }
  }

  #kernelProgress(pct: number, detail: string): void {
    for (const l of this.#kernelListeners) l(Math.max(0, Math.min(100, Math.round(pct))), detail);
  }

  async #buildKernel(): Promise<string> {
    const o = this.#o;
    const ops = this.#ops;
    const log = o.logger;
    const say = (pct: number, detail: string) => this.#kernelProgress(pct, detail);
    const cacheDir = join(o.dir, 'cache');
    // Per instance: two MineVibes on one engine never build into the same folder.
    const buildName = `build-${o.instanceId}`;
    const buildDir = join(o.dir, buildName);
    const kernelDir = join(o.dir, 'kernel');
    await mkdir(cacheDir, { recursive: true });
    await mkdir(kernelDir, { recursive: true });
    const tarball = join(cacheDir, ANDROID_KERNEL.source.file);
    const src = ANDROID_KERNEL.source;
    if (
      !(await stat(tarball).then(
        (s) => s.size === src.size,
        () => false,
      ))
    ) {
      say(0, 'downloading the Linux kernel source (150 MB, once)');
      let last = -1;
      await downloadVerified(
        {
          url: src.url,
          destination: tarball,
          size: src.size,
          hash: { algorithm: 'sha256', value: src.sha256 },
        },
        {
          ...(o.fetch ? { fetch: o.fetch } : {}),
          onBytes: (n) => {
            const pct = Math.floor((n / src.size) * 25);
            if (pct !== last) {
              last = pct;
              say(pct, `downloading the Linux kernel source (${Math.round((n / src.size) * 100)}%)`);
            }
          },
        },
      );
    }
    say(25, 'preparing the kernel build');
    await o.ensureBuildImage?.((m) => log?.debug({ m }, 'kernel build image'));
    await rm(buildDir, { recursive: true, force: true });
    await mkdir(buildDir, { recursive: true });
    await writeFile(join(buildDir, 'build.sh'), KERNEL_BUILD_SCRIPT, { mode: 0o755 });
    await writeFile(join(buildDir, 'android.fragment'), KERNEL_FRAGMENT);
    // The most vCPUs that fit the budget now (the build's length scales with them).
    const tries = o.buildResources ?? [
      { cpus: 6, memMiB: 3072 },
      { cpus: 4, memMiB: 3072 },
      { cpus: 2, memMiB: 3072 },
    ];
    let res = tries[0] ?? { cpus: 4, memMiB: 3072 };
    let release: () => void = () => {};
    for (let i = 0; i < tries.length; i++) {
      res = tries[i] as { cpus: number; memMiB: number };
      try {
        release = (await o.admitBuild?.(res)) ?? (() => {});
        break;
      } catch (err) {
        if (i === tries.length - 1) throw err;
      }
    }
    const started = Date.now();
    let objects = 0;
    let error: string | null = null;
    // Progress only moves forward (the script's phases and the object count interleave).
    let best = 26;
    const forward = (pct: number, detail: string) => {
      best = Math.max(best, Math.min(98, pct));
      say(best, detail);
    };
    try {
      say(
        26,
        `building the Android kernel (about ${res.cpus >= 6 ? 3 : res.cpus >= 4 ? 4 : 8} minutes, once)`,
      );
      await ops.runOnce(
        {
          name: `mv-pc-${o.instanceId}-kbuild`,
          image: o.buildImage,
          cpus: res.cpus,
          memoryMiB: res.memMiB,
          entrypoint: '/bin/bash',
          args: [`/work/${buildName}/build.sh`, buildName],
          binds: [{ source: o.dir, target: '/work', readonly: false }],
          labels: { ...o.labels, [ROLE_LABEL]: 'kbuild' },
          timeoutMs: o.buildTimeoutMs ?? 40 * 60_000,
        },
        (line) => {
          const m = /^MV-PROGRESS (\d+) (.*)$/.exec(line);
          if (m) {
            if (Number(m[1]) < 100)
              forward(26 + Math.round(Number(m[1]) * 0.1), `building the Android kernel: ${m[2]}`);
            return;
          }
          const e = /^MV-ERROR (.*)$/.exec(line);
          if (e) error = e[1] ?? 'failed';
          if (/^\s*(CC|AS|AR|LD)\s/.test(line)) {
            objects++;
            if (objects % 25 === 0) {
              const done = Math.min(1, objects / KERNEL_BUILD_OBJECTS);
              forward(28 + done * 70, `building the Android kernel (${Math.round(done * 100)}%)`);
            }
          }
        },
      );
    } catch (err) {
      throw new Error(`the Android kernel build failed: ${error ?? errText(err)}`);
    } finally {
      release();
    }
    const built = join(buildDir, 'Image');
    if (!existsSync(built) || !(await isArm64Image(built))) {
      throw new Error('the Android kernel build produced no arm64 kernel image');
    }
    const st = await stat(built);
    const marker: KernelMarker = {
      id: ANDROID_KERNEL.id,
      sha256: await sha256File(built),
      size: st.size,
      builtAt: new Date().toISOString(),
    };
    await rename(join(buildDir, 'config'), `${this.kernelPath}.config`).catch(() => {});
    await rename(built, this.kernelPath);
    await writeFile(`${this.kernelPath}.json`, `${JSON.stringify(marker, null, 2)}\n`);
    await rm(buildDir, { recursive: true, force: true });
    log?.info({ ms: Date.now() - started, objects, size: st.size }, 'Android kernel built');
    say(100, 'the Android kernel is ready');
    return this.kernelPath;
  }

  /**
   * What is not on this Mac yet of what the kernel and/or the phone need (PLAN §8.8): the downloads a first use makes,
   * which PcManager asks the player to OK (`PcInfo.consent`) before it turns a capability on. Empty when ready.
   */
  async downloadsNeeded(want: { kernel: boolean; phone: boolean }): Promise<KitDownload[]> {
    const out: KitDownload[] = [];
    if (want.kernel && !(await this.kernelReady())) {
      const src = ANDROID_KERNEL.source;
      const cached = await stat(join(this.#o.dir, 'cache', src.file)).then(
        (s) => s.size === src.size,
        () => false,
      );
      out.push({
        key: `kernel:${ANDROID_KERNEL.id}`,
        bytes: (cached ? 0 : src.size) + KERNEL_BUILD_TOOLS_BYTES,
        what: 'Linux kernel source',
      });
    }
    // A source image already pulled is only patched and loaded here: nothing to download.
    const pin = this.#pin;
    if (
      want.phone &&
      !(await this.phoneImageReady()) &&
      !(await this.#o.driver.imageExists(pin.source).catch(() => false))
    ) {
      out.push({
        key: `phone:${pin.patchedIndex}`,
        bytes: pin.downloadBytes ?? PHONE_IMAGE.downloadBytes,
        what: 'Android 15',
      });
    }
    return out;
  }

  get #pin(): PhoneImagePin {
    return this.#o.phoneImage ?? PHONE_IMAGE;
  }

  /** Whether the phone image is loaded now (and is the pinned one). */
  async phoneImageReady(): Promise<boolean> {
    const ops = this.#o.driver.android;
    if (!ops) return false;
    return (await ops.imageDigest(this.#pin.ref).catch(() => null)) === this.#pin.patchedIndex;
  }

  /** The phone image's reference, preparing it first when needed (once, shared by every caller). */
  async ensurePhoneImage(onProgress?: KitProgress): Promise<string> {
    if (await this.phoneImageReady()) return this.#pin.ref;
    if (onProgress) this.#imageListeners.add(onProgress);
    try {
      this.#image ??= this.#prepareImage().finally(() => {
        this.#image = null;
      });
      return await this.#image;
    } finally {
      if (onProgress) this.#imageListeners.delete(onProgress);
    }
  }

  async #prepareImage(): Promise<string> {
    const o = this.#o;
    const ops = this.#ops;
    const pin = this.#pin;
    const say = (pct: number, detail: string) => {
      for (const l of this.#imageListeners) l(Math.max(0, Math.min(100, Math.round(pct))), detail);
    };
    const ociDir = join(o.dir, 'oci');
    await mkdir(ociDir, { recursive: true });
    const free = await (o.freeDiskBytes ?? freeDiskBytes)(ociDir);
    if (free < IMAGE_PREP_FREE_BYTES) {
      throw new Error(
        `the Android phone image needs ${(IMAGE_PREP_FREE_BYTES / GiB).toFixed(0)} GiB of free disk to prepare; ${(free / GiB).toFixed(1)} GiB free`,
      );
    }
    const saved = join(ociDir, 'source.tar');
    const patched = join(ociDir, 'phone.tar');
    try {
      if (!(await o.driver.imageExists(pin.source).catch(() => false))) {
        say(0, 'downloading the Android image (660 MB, once)');
        await o.driver.pullImage(pin.source, (line) => {
          const m = /(\d{1,3})%/.exec(line);
          if (m) say(Number(m[1]) * 0.6, `downloading the Android image (${m[1]}%)`);
        });
      }
      say(60, 'preparing the Android image');
      await rm(saved, { force: true });
      await ops.saveImage(pin.source, saved);
      say(70, 'preparing the Android image');
      const result = await addRelativeEtcLayer(saved, patched, {
        name: `docker.io/${pin.ref}`,
        expectManifest: pin.arm64Manifest,
      });
      await rm(saved, { force: true });
      say(85, 'loading the Android image');
      await ops.loadImage(patched);
      const digest = await ops.imageDigest(pin.ref);
      if (result.indexDigest !== pin.patchedIndex || digest !== result.indexDigest) {
        throw new Error(
          `the Android image came out as ${digest ?? 'missing'} (patched ${result.indexDigest}), not ${pin.patchedIndex}`,
        );
      }
      o.logger?.info({ image: pin.ref, digest }, 'Android phone image ready');
      say(100, 'the Android image is ready');
      return pin.ref;
    } finally {
      await rm(saved, { force: true });
      await rm(patched, { force: true });
    }
  }
}
