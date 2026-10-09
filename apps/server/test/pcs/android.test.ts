/**
 * The host side of the Android phone and nested virtualization (PLAN §8.7, spike S9-android): the engine arguments,
 * the OCI patch that makes Redroid's /etc relative, AndroidKit's kernel build and image preparation, the chip check
 * and the guest capability probe.
 */
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ANDROID_KERNEL,
  AndroidKit,
  KERNEL_BUILD_SCRIPT,
  KERNEL_BUILD_TOOLS_BYTES,
  KERNEL_FRAGMENT,
  PHONE_IMAGE,
} from '../../src/pcs/android/kit.js';
import { addRelativeEtcLayer, listTar, sha256, tarOf } from '../../src/pcs/android/oci.js';
import { LINK_PHONE_SCRIPT } from '../../src/pcs/android/phone.js';
import {
  AppleContainerDriver,
  buildAppleCreateArgs,
  buildOneShotArgs,
  buildPhoneCreateArgs,
  lineSplitter,
  parseAppleContainer,
} from '../../src/pcs/drivers/AppleContainerDriver.js';
import type { ContainerRuntime } from '../../src/pcs/drivers/ContainerRuntime.js';
import type { ExecResult } from '../../src/pcs/drivers/exec.js';
import {
  assertRunSpec,
  type OneShotSpec,
  type PcRunSpec,
  type PhoneRunSpec,
  specProblems,
} from '../../src/pcs/drivers/PcDriver.js';
import { CAPS_SCRIPT, parseCapsProbe } from '../../src/pcs/guest.js';
import { nestedVirtualizationFor } from '../../src/pcs/host.js';
import { FakeAndroidDriver } from './fakes.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mv-android-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const ok = (stdout = ''): ExecResult => ({
  code: 0,
  signal: null,
  stdout,
  stderr: '',
  ms: 1,
  timedOut: false,
});

function pcSpec(over: Partial<PcRunSpec> = {}): PcRunSpec {
  return {
    name: 'mv-pc-x-linux-1',
    image: 'minevibe/linux-pc:dev',
    cpus: 2,
    memoryMiB: 4096,
    shmMiB: 1024,
    hostPort: 43211,
    network: 'mv-pc-x-linux-1-net',
    binds: [],
    volumes: [{ name: 'mv-pc-x-linux-1-home', target: '/home/cua', sizeGiB: 32 }],
    labels: { minevibe: 'pc', 'minevibe.pc': 'linux-1' },
    env: {},
    secretEnv: { CUA_ENV_TOKEN: 'tok' },
    ...over,
  };
}

const KERNEL = '/Users/me/Library/Application Support/MineVibe/container/minevibe-android/kernel/vmlinux';

describe('engine arguments', () => {
  it('a PC with nested virtualization boots MineVibe’s kernel with --virtualization', () => {
    const args = buildAppleCreateArgs(pcSpec({ virtualization: true, kernel: KERNEL }));
    const k = args.indexOf('--kernel');
    expect(args[k + 1]).toBe(KERNEL);
    expect(args).toContain('--virtualization');
    expect(args.at(-1)).toBe('minevibe/linux-pc:dev');
    expect(buildAppleCreateArgs(pcSpec())).not.toContain('--virtualization');
    expect(buildAppleCreateArgs(pcSpec())).not.toContain('--kernel');
  });

  it('refuses virtualization without a kernel, and a kernel path --mount-like syntax could break', () => {
    expect(() => assertRunSpec(pcSpec({ virtualization: true }))).toThrow(/without a kernel/);
    expect(() => assertRunSpec(pcSpec({ kernel: 'relative/vmlinux' }))).toThrow(/kernel/);
    expect(() => assertRunSpec(pcSpec({ kernel: '/a,b/vmlinux' }))).toThrow(/kernel/);
  });

  it('reads virtualization from inspect, and a mismatch is a spec problem (recreate)', () => {
    const row = (virtualization?: boolean) => ({
      configuration: {
        id: 'mv-pc-x-linux-1',
        labels: { minevibe: 'pc', 'minevibe.pc': 'linux-1' },
        image: { reference: 'minevibe/linux-pc:dev' },
        mounts: [{ destination: '/home/cua', type: { volume: { name: 'mv-pc-x-linux-1-home' } } }],
        publishedPorts: [{ containerPort: 3211, hostAddress: '127.0.0.1', hostPort: 43211 }],
        resources: { cpus: 2, memoryInBytes: 4096 * 1024 * 1024 },
        networks: [{ network: 'mv-pc-x-linux-1-net' }],
        ...(virtualization === undefined ? {} : { virtualization }),
      },
      status: { state: 'stopped' },
    });
    expect(parseAppleContainer(row(true)).virtualization).toBe(true);
    expect(parseAppleContainer(row(false)).virtualization).toBe(false);
    expect(parseAppleContainer(row()).virtualization).toBeUndefined();
    const want = pcSpec({ virtualization: true, kernel: KERNEL });
    expect(specProblems(want, parseAppleContainer(row(true)))).toEqual([]);
    expect(specProblems(want, parseAppleContainer(row(false)))).toEqual(['virtualization is off']);
    expect(specProblems(pcSpec(), parseAppleContainer(row(true)))).toEqual(['virtualization is on']);
    // An engine that does not say is not held against the container.
    expect(specProblems(want, parseAppleContainer(row()))).toEqual([]);
  });

  it('the phone: own kernel, the PC network, all capabilities, no masks, /data volume, init args', () => {
    const phone: PhoneRunSpec = {
      name: 'mv-pc-x-linux-1-phone',
      image: 'minevibe/android-phone:15.0.0-r1',
      kernel: KERNEL,
      network: 'mv-pc-x-linux-1-net',
      cpus: 4,
      memoryMiB: 4096,
      data: { name: 'mv-pc-x-linux-1-phone-data', target: '/data', sizeGiB: 8 },
      labels: { minevibe: 'pc', 'minevibe.pc': 'linux-1', 'minevibe.role': 'phone' },
      ownerLabels: { minevibe: 'pc', 'minevibe.pc': 'linux-1' },
      initArgs: [
        'androidboot.redroid_gpu_mode=guest',
        'androidboot.redroid_fps=60',
        'androidboot.use_memfd=true',
      ],
    };
    expect(buildPhoneCreateArgs(phone)).toEqual([
      'create',
      '--name',
      'mv-pc-x-linux-1-phone',
      '--cpus',
      '4',
      '--memory',
      '4096M',
      '--network',
      'mv-pc-x-linux-1-net',
      '--kernel',
      KERNEL,
      '--cap-add',
      'ALL',
      '--masked-path',
      'NONE',
      '--read-only-path',
      'NONE',
      '--mount',
      'type=volume,source=mv-pc-x-linux-1-phone-data,target=/data',
      '-l',
      'minevibe=pc',
      '-l',
      'minevibe.pc=linux-1',
      '-l',
      'minevibe.role=phone',
      'minevibe/android-phone:15.0.0-r1',
      'androidboot.redroid_gpu_mode=guest',
      'androidboot.redroid_fps=60',
      'androidboot.use_memfd=true',
    ]);
    // Never a published port: the phone's adb is unauthenticated.
    expect(buildPhoneCreateArgs(phone)).not.toContain('-p');
    expect(() => buildPhoneCreateArgs({ ...phone, initArgs: ['x; rm -rf /'] })).toThrow(/init arg/);
    expect(() => buildPhoneCreateArgs({ ...phone, kernel: 'vmlinux' })).toThrow(/kernel/);
  });

  it('a one-shot run removes itself and mounts its folder with --mount', () => {
    const spec: OneShotSpec = {
      name: 'mv-pc-x-kbuild',
      image: 'minevibe/linux-pc:dev',
      cpus: 4,
      memoryMiB: 3072,
      entrypoint: '/bin/bash',
      args: ['/work/build-x/build.sh', 'build-x'],
      binds: [{ source: '/kits', target: '/work', readonly: false }],
      labels: { minevibe: 'pc', 'minevibe.role': 'kbuild' },
      timeoutMs: 1000,
    };
    expect(buildOneShotArgs(spec)).toEqual([
      'run',
      '--rm',
      '--name',
      'mv-pc-x-kbuild',
      '--cpus',
      '4',
      '--memory',
      '3072M',
      '--entrypoint',
      '/bin/bash',
      '--mount',
      'type=bind,source=/kits,target=/work',
      '-l',
      'minevibe=pc',
      '-l',
      'minevibe.role=kbuild',
      'minevibe/linux-pc:dev',
      '/work/build-x/build.sh',
      'build-x',
    ]);
  });

  it('streamed output is split into whole lines, even when a line is cut across chunks', () => {
    const got: string[] = [];
    const s = lineSplitter((l) => got.push(l));
    s.push('MV-PROGRESS 2 inst');
    s.push('alling\n  CC      a.o\r\n\n  CC   ');
    s.push('   b.o\nMV-ERROR boom');
    s.flush();
    expect(got).toEqual(['MV-PROGRESS 2 installing', 'CC      a.o', 'CC      b.o', 'MV-ERROR boom']);
  });

  it('stop tries a second time when the first stop leaves the container running (errno 95 after Docker)', async () => {
    const calls: string[] = [];
    let stops = 0;
    const rt = {
      appRoot: '/nonexistent',
      exec: async (args: readonly string[]) => {
        calls.push(args.join(' '));
        if (args[0] === 'stop') {
          stops++;
          return stops === 1
            ? { ...ok(), code: 1, stderr: 'deleteProcess: failed with errno 95: cgroup.kill' }
            : ok();
        }
        if (args[0] === 'inspect') {
          return ok(JSON.stringify([{ configuration: { id: 'pc' }, status: { state: 'running' } }]));
        }
        return ok();
      },
    } as unknown as ContainerRuntime;
    await new AppleContainerDriver(rt).stop('pc', 1);
    expect(calls.filter((c) => c.startsWith('stop'))).toHaveLength(2);
  });

  it('stop gives up after the second failure while the container still runs', async () => {
    const rt = {
      appRoot: '/nonexistent',
      exec: async (args: readonly string[]) =>
        args[0] === 'stop'
          ? { ...ok(), code: 1, stderr: 'boom' }
          : ok(JSON.stringify([{ configuration: { id: 'pc' }, status: { state: 'running' } }])),
    } as unknown as ContainerRuntime;
    await expect(new AppleContainerDriver(rt).stop('pc', 1)).rejects.toThrow(/boom/);
  });
});

/** A one-platform `image save` tar like Apple container's: oci-layout, index.json → index → arm64 manifest. */
function imageTar(file: string, options: { tamper?: boolean } = {}) {
  const layerTar = tarOf([{ name: 'system/etc/hosts', data: Buffer.from('127.0.0.1 localhost\n') }]);
  const layer = gzipSync(layerTar);
  const config = Buffer.from(
    JSON.stringify({
      architecture: 'arm64',
      os: 'linux',
      config: { Entrypoint: ['/init', 'qemu=1'] },
      rootfs: { type: 'layers', diff_ids: [sha256(layerTar)] },
      history: [{ created_by: 'redroid' }],
    }),
  );
  const manifest = Buffer.from(
    JSON.stringify({
      schemaVersion: 2,
      mediaType: 'application/vnd.oci.image.manifest.v1+json',
      config: {
        mediaType: 'application/vnd.oci.image.config.v1+json',
        digest: sha256(config),
        size: config.length,
      },
      layers: [
        {
          mediaType: 'application/vnd.oci.image.layer.v1.tar+gzip',
          digest: sha256(layer),
          size: layer.length,
        },
      ],
    }),
  );
  const inner = Buffer.from(
    JSON.stringify({
      schemaVersion: 2,
      mediaType: 'application/vnd.oci.image.index.v1+json',
      manifests: [
        {
          mediaType: 'application/vnd.oci.image.manifest.v1+json',
          digest: sha256(manifest),
          size: manifest.length,
          platform: { architecture: 'arm64', os: 'linux' },
        },
      ],
    }),
  );
  const top = Buffer.from(
    JSON.stringify({
      schemaVersion: 2,
      manifests: [
        {
          mediaType: 'application/vnd.oci.image.index.v1+json',
          digest: sha256(inner),
          size: inner.length,
          annotations: { 'io.containerd.image.name': 'docker.io/redroid/redroid:test' },
        },
      ],
    }),
  );
  const blob = (b: Buffer) => ({ name: `blobs/sha256/${sha256(b).slice(7)}`, data: b });
  const configBlob = blob(config);
  writeFileSync(
    file,
    tarOf([
      { name: 'oci-layout', data: Buffer.from('{"imageLayoutVersion":"1.0.0"}') },
      { name: 'index.json', data: top },
      options.tamper ? { name: configBlob.name, data: Buffer.from('{"tampered":true}') } : configBlob,
      blob(layer),
      blob(manifest),
      blob(inner),
    ]),
  );
  return { manifestDigest: sha256(manifest), layerDigest: sha256(layer) };
}

describe('the phone image patch (relative /etc)', () => {
  it('adds one layer with etc -> system/etc, a new config, manifest and index, named for image load', async () => {
    const src = join(dir, 'source.tar');
    const dst = join(dir, 'phone.tar');
    const { manifestDigest, layerDigest } = imageTar(src);
    const r = await addRelativeEtcLayer(src, dst, {
      name: 'docker.io/minevibe/android-phone:t',
      expectManifest: manifestDigest,
    });
    const entries = await listTar(dst);
    const names = entries.map((e) => e.name);
    expect(names).toContain(`blobs/sha256/${layerDigest.slice(7)}`);
    expect(names.at(-1)).toBe('index.json');
    expect(names.filter((n) => n === 'index.json')).toHaveLength(1);
    const read = (name: string) => {
      const e = entries.find((x) => x.name === name);
      if (!e) throw new Error(`no ${name}`);
      return readFileSync(dst).subarray(e.dataOffset, e.dataOffset + e.size);
    };
    const top = JSON.parse(read('index.json').toString());
    expect(top.manifests[0].digest).toBe(r.indexDigest);
    expect(top.manifests[0].annotations['com.apple.containerization.image.name']).toBe(
      'docker.io/minevibe/android-phone:t',
    );
    const blob = (d: string) => read(`blobs/sha256/${d.slice(7)}`);
    expect(sha256(blob(r.indexDigest))).toBe(r.indexDigest);
    const manifest = JSON.parse(blob(r.manifestDigest).toString());
    expect(manifest.layers.map((l: { digest: string }) => l.digest)).toEqual([layerDigest, r.layerDigest]);
    const config = JSON.parse(blob(manifest.config.digest).toString());
    const added = gunzipSync(blob(r.layerDigest));
    expect(config.rootfs.diff_ids.at(-1)).toBe(sha256(added));
    expect(config.history.at(-1).created_by).toMatch(/system\/etc/);
    // One symlink entry, `etc` -> `system/etc` (type 2), then the end blocks.
    expect(added.subarray(0, 3).toString()).toBe('etc');
    expect(String.fromCharCode(added[156] as number)).toBe('2');
    expect(added.subarray(157, 167).toString()).toBe('system/etc');
    // Deterministic: the same source gives the same digests.
    const again = await addRelativeEtcLayer(src, join(dir, 'again.tar'), {
      name: 'docker.io/minevibe/android-phone:t',
      expectManifest: manifestDigest,
    });
    expect(again).toEqual(r);
  });

  it('refuses another image than the pinned one, and a blob that does not match its digest', async () => {
    const src = join(dir, 'source.tar');
    imageTar(src);
    await expect(
      addRelativeEtcLayer(src, join(dir, 'x.tar'), { name: 'n', expectManifest: `sha256:${'0'.repeat(64)}` }),
    ).rejects.toThrow(/not the pinned/);
    const bad = join(dir, 'bad.tar');
    const { manifestDigest } = imageTar(bad, { tamper: true });
    await expect(
      addRelativeEtcLayer(bad, join(dir, 'y.tar'), { name: 'n', expectManifest: manifestDigest }),
    ).rejects.toThrow(/does not match its digest/);
  });
});

describe('AndroidKit', () => {
  /** A fake engine whose kernel build "runs": it writes an arm64 Image and its config into the build folder. */
  function kitWith(
    driver: FakeAndroidDriver,
    over: Partial<ConstructorParameters<typeof AndroidKit>[0]> = {},
  ) {
    const holds: string[] = [];
    const kit = new AndroidKit({
      dir,
      driver,
      buildImage: 'minevibe/linux-pc:dev',
      labels: { minevibe: 'pc', 'minevibe.instance': 'unit' },
      instanceId: 'unit',
      admitBuild: async (r) => {
        holds.push(`hold ${r.cpus}/${r.memMiB}`);
        return () => holds.push('release');
      },
      ensureBuildImage: async () => {
        holds.push('image');
      },
      // Hermetic: never the test machine's own free space.
      freeDiskBytes: async () => 100 * 1024 ** 3,
      ...over,
    });
    return { kit, holds };
  }

  it('builds the kernel once from the cached source, with progress, inside its budget hold', async () => {
    const driver = new FakeAndroidDriver();
    driver.runOnce = async (spec, onOutput) => {
      driver.oneShots.push(spec);
      const build = join(dir, spec.args[1] as string);
      expect(readFileSync(join(build, 'android.fragment'), 'utf8')).toBe(KERNEL_FRAGMENT);
      onOutput?.('MV-PROGRESS 2 installing build tools');
      for (let i = 0; i < 100; i++) onOutput?.(`  CC      kernel/f${i}.o`);
      onOutput?.('MV-PROGRESS 100 done');
      const image = Buffer.alloc(16 * 1024 * 1024);
      image.write('ARM\x64', 0x38, 'latin1');
      writeFileSync(join(build, 'Image'), image);
      writeFileSync(join(build, 'config'), 'CONFIG_KVM=y\n');
    };
    // The source is already in the cache (its size is what the kit checks; the download verifies sha256).
    mkdirSync(join(dir, 'cache'), { recursive: true });
    writeFileSync(join(dir, 'cache', ANDROID_KERNEL.source.file), '');
    truncateSync(join(dir, 'cache', ANDROID_KERNEL.source.file), ANDROID_KERNEL.source.size);
    const { kit, holds } = kitWith(driver);
    expect(await kit.kernelReady()).toBe(false);
    const progress: [number, string][] = [];
    const [a, b] = await Promise.all([kit.ensureKernel((p, d) => progress.push([p, d])), kit.ensureKernel()]);
    expect(a).toBe(join(dir, 'kernel', ANDROID_KERNEL.file));
    expect(b).toBe(a);
    expect(driver.oneShots).toHaveLength(1);
    expect(driver.oneShots[0]).toMatchObject({
      name: 'mv-pc-unit-kbuild',
      image: 'minevibe/linux-pc:dev',
      entrypoint: '/bin/bash',
      binds: [{ source: dir, target: '/work', readonly: false }],
      labels: { minevibe: 'pc', 'minevibe.instance': 'unit', 'minevibe.role': 'kbuild' },
    });
    expect(holds).toEqual(['image', 'hold 6/3072', 'release']);
    expect(driver.oneShots[0]?.cpus).toBe(6);
    expect(await kit.kernelReady()).toBe(true);
    const marker = JSON.parse(readFileSync(`${a}.json`, 'utf8'));
    expect(marker).toMatchObject({ id: ANDROID_KERNEL.id, size: 16 * 1024 * 1024 });
    expect(marker.sha256).toBe(createHash('sha256').update(readFileSync(a)).digest('hex'));
    expect(readFileSync(`${a}.config`, 'utf8')).toBe('CONFIG_KVM=y\n');
    expect(existsSync(join(dir, 'build-unit'))).toBe(false);
    expect(progress[0]?.[1]).toMatch(/preparing|building/);
    expect(progress.at(-1)).toEqual([100, 'the Android kernel is ready']);
    expect(progress.map(([p]) => p)).toEqual([...progress.map(([p]) => p)].sort((x, y) => x - y));
    // Ready now: nothing more is built.
    await kit.ensureKernel();
    expect(driver.oneShots).toHaveLength(1);
  });

  it('builds with fewer vCPUs when 6 do not fit the budget, and gives up when nothing fits', async () => {
    const driver = new FakeAndroidDriver();
    driver.runOnce = async (spec) => {
      driver.oneShots.push(spec);
      const image = Buffer.alloc(1024 * 1024);
      image.write('ARM\x64', 0x38, 'latin1');
      writeFileSync(join(dir, spec.args[1] as string, 'Image'), image);
    };
    mkdirSync(join(dir, 'cache'), { recursive: true });
    writeFileSync(join(dir, 'cache', ANDROID_KERNEL.source.file), '');
    truncateSync(join(dir, 'cache', ANDROID_KERNEL.source.file), ANDROID_KERNEL.source.size);
    const tried: number[] = [];
    const { kit } = kitWith(driver, {
      admitBuild: async (r) => {
        tried.push(r.cpus);
        if (r.cpus > 4) throw new Error('OVER_BUDGET: no room');
        return () => {};
      },
    });
    await kit.ensureKernel();
    expect(tried).toEqual([6, 4]);
    expect(driver.oneShots[0]?.cpus).toBe(4);

    const none = new FakeAndroidDriver();
    rmSync(join(dir, 'kernel'), { recursive: true, force: true });
    const { kit: full } = kitWith(none, {
      admitBuild: async () => {
        throw new Error('no room to build the Android kernel now');
      },
    });
    await expect(full.ensureKernel()).rejects.toThrow(/no room/);
    expect(none.oneShots).toHaveLength(0);
  });

  it('a build that fails says why (MV-ERROR) and leaves no kernel', async () => {
    const driver = new FakeAndroidDriver();
    driver.runOnce = async (_spec, onOutput) => {
      onOutput?.("MV-ERROR the engine's kernel exposes no /proc/config.gz");
      throw new Error('exit 3');
    };
    mkdirSync(join(dir, 'cache'), { recursive: true });
    writeFileSync(join(dir, 'cache', ANDROID_KERNEL.source.file), '');
    truncateSync(join(dir, 'cache', ANDROID_KERNEL.source.file), ANDROID_KERNEL.source.size);
    const { kit, holds } = kitWith(driver);
    await expect(kit.ensureKernel()).rejects.toThrow(/config\.gz/);
    expect(holds.at(-1)).toBe('release');
    expect(await kit.kernelReady()).toBe(false);
  });

  it('MINEVIBE_ANDROID_KERNEL points at a kernel built elsewhere; nothing is built', async () => {
    const k = join(dir, 'vmlinux-elsewhere');
    writeFileSync(k, 'x');
    const driver = new FakeAndroidDriver();
    const { kit } = kitWith(driver, { kernelOverride: k });
    expect(kit.kernelPath).toBe(k);
    expect(await kit.ensureKernel()).toBe(k);
    expect(driver.oneShots).toHaveLength(0);
  });

  it('refuses to prepare the phone image without 3 GiB of free disk, before pulling anything', async () => {
    const driver = new FakeAndroidDriver();
    driver.imagePresent = false;
    const { kit } = kitWith(driver, { freeDiskBytes: async () => 2 * 1024 ** 3 });
    await expect(kit.ensurePhoneImage()).rejects.toThrow(
      /needs 3 GiB of free disk to prepare; 2\.0 GiB free/,
    );
    expect(driver.log).toEqual([]);
  });

  it('says what a first use downloads (for the consent prompt), and nothing once it is here', async () => {
    const driver = new FakeAndroidDriver();
    driver.imagePresent = false;
    const { kit } = kitWith(driver);
    expect(await kit.downloadsNeeded({ kernel: true, phone: true })).toEqual([
      {
        key: `kernel:${ANDROID_KERNEL.id}`,
        bytes: ANDROID_KERNEL.source.size + KERNEL_BUILD_TOOLS_BYTES,
        what: 'Linux kernel source',
      },
      { key: `phone:${PHONE_IMAGE.patchedIndex}`, bytes: PHONE_IMAGE.downloadBytes, what: 'Android 15' },
    ]);
    expect(await kit.downloadsNeeded({ kernel: true, phone: false })).toHaveLength(1);
    // A cached source leaves the build tools; a pulled Redroid is only patched here.
    mkdirSync(join(dir, 'cache'), { recursive: true });
    writeFileSync(join(dir, 'cache', ANDROID_KERNEL.source.file), '');
    truncateSync(join(dir, 'cache', ANDROID_KERNEL.source.file), ANDROID_KERNEL.source.size);
    driver.imagePresent = true;
    expect(await kit.downloadsNeeded({ kernel: true, phone: true })).toEqual([
      expect.objectContaining({ bytes: KERNEL_BUILD_TOOLS_BYTES }),
    ]);
    // Built and loaded: nothing.
    const k = join(dir, 'vmlinux-elsewhere');
    writeFileSync(k, 'x');
    driver.images.set(PHONE_IMAGE.ref, PHONE_IMAGE.patchedIndex);
    const { kit: ready } = kitWith(driver, { kernelOverride: k });
    expect(await ready.downloadsNeeded({ kernel: true, phone: true })).toEqual([]);
  });

  it('prepares the phone image: pull by digest, save, patch, load, verify the pinned digest; temp files go', async () => {
    const driver = new FakeAndroidDriver();
    driver.imagePresent = false;
    let manifest = '';
    let patched = '';
    driver.saveImage = async (ref, file) => {
      driver.log.push(`save ${ref}`);
      manifest = imageTar(file).manifestDigest;
      const probe = await addRelativeEtcLayer(file, join(dir, 'probe.tar'), {
        name: 'docker.io/minevibe/android-phone:t',
        expectManifest: manifest,
      });
      patched = probe.indexDigest;
      rmSync(join(dir, 'probe.tar'));
      pin.arm64Manifest = manifest;
      pin.patchedIndex = patched;
    };
    driver.loadImage = async (file) => {
      driver.log.push('load');
      expect((await listTar(file)).at(-1)?.name).toBe('index.json');
      driver.images.set('minevibe/android-phone:t', patched);
    };
    const pin = {
      ref: 'minevibe/android-phone:t',
      source: 'docker.io/redroid/redroid@sha256:abc',
      arm64Manifest: '',
      patchedIndex: '',
    };
    const { kit } = kitWith(driver, { phoneImage: pin });
    expect(await kit.phoneImageReady()).toBe(false);
    const progress: number[] = [];
    expect(await kit.ensurePhoneImage((p) => progress.push(p))).toBe('minevibe/android-phone:t');
    expect(driver.log).toEqual([
      'pull docker.io/redroid/redroid@sha256:abc',
      'save docker.io/redroid/redroid@sha256:abc',
      'load',
    ]);
    expect(await kit.phoneImageReady()).toBe(true);
    expect(progress.at(-1)).toBe(100);
    expect(existsSync(join(dir, 'oci', 'source.tar'))).toBe(false);
    expect(existsSync(join(dir, 'oci', 'phone.tar'))).toBe(false);
  });
});

describe('the chip check', () => {
  it('nested virtualization needs an M3 or newer', () => {
    expect(nestedVirtualizationFor('Apple M5 Pro', 'darwin')).toEqual({
      supported: true,
      chip: 'Apple M5 Pro',
    });
    expect(nestedVirtualizationFor('Apple M3', 'darwin').supported).toBe(true);
    expect(nestedVirtualizationFor('Apple M2 Max', 'darwin')).toMatchObject({
      supported: false,
      reason: 'needs an M3 or newer Mac (this one has an M2 Max)',
    });
    expect(nestedVirtualizationFor('Intel(R) Core(TM) i9', 'darwin').supported).toBe(false);
    expect(nestedVirtualizationFor('', 'linux').supported).toBe(false);
  });
});

describe('guest scripts', () => {
  it('the capability probe parses arch, kernel, KVM, sizes, toolchains and the phone', () => {
    const p = parseCapsProbe(
      [
        'arch=aarch64',
        'kernel=6.18.35-197-debug',
        'kvm=no',
        'cpus=2',
        'mem=3911',
        'disk=25.4',
        'tool=node 24.4.1',
        'tool=python3 3.12.3',
        'tool=java ?',
        'phone=android-phone',
        'garbage line',
      ].join('\n'),
    );
    expect(p).toEqual({
      arch: 'aarch64',
      kernel: '6.18.35-197-debug',
      kvm: false,
      cpus: 2,
      memoryMiB: 3911,
      diskFreeGiB: 25.4,
      toolchains: ['node 24.4.1', 'python3 3.12.3', 'java ?'],
      phoneHost: 'android-phone',
    });
    expect(parseCapsProbe('kvm=usable').kvm).toBe(true);
    expect(parseCapsProbe('cpus=').cpus).toBeNull();
  });

  it('the probe and the phone link are valid shell', async () => {
    const { execFileSync } = await import('node:child_process');
    for (const script of [CAPS_SCRIPT, LINK_PHONE_SCRIPT, KERNEL_BUILD_SCRIPT]) {
      expect(() => execFileSync('bash', ['-n', '-c', script])).not.toThrow();
    }
  });

  it('the link script refuses anything but an IPv4 address', async () => {
    const { spawnSync } = await import('node:child_process');
    const r = spawnSync('sh', ['-c', LINK_PHONE_SCRIPT, 'link-phone', '1.2.3.4; touch /tmp/x', '']);
    expect(r.status).toBe(2);
    expect(r.stderr.toString()).toMatch(/bad address/);
  });
});
