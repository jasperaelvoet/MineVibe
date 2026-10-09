/**
 * PC capabilities (PLAN §8.7): nested virtualization (a PcRecord flag that recreates the PC with `--virtualization`
 * and MineVibe's kernel) and the Android phone (a Redroid container next to the PC, started once the PC runs, linked
 * into it as `android-phone`, counted in the PC's budget share), through PcManager, the wire and the bridge glue.
 */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PcInfo, PcState } from '@minevibe/protocol';
import type { SpacesdClientLike } from '@trycua/cua';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AndroidKitLike } from '../../src/pcs/android/kit.js';
import { ANDROID_KERNEL, PHONE_INIT_ARGS } from '../../src/pcs/android/kit.js';
import { LINK_PHONE_SCRIPT, OPEN_KVM_SCRIPT, UNLINK_PHONE_SCRIPT } from '../../src/pcs/android/phone.js';
import { GiB, type HostFacts, MiB } from '../../src/pcs/Budget.js';
import { KERNEL_LABEL, ROLE_LABEL } from '../../src/pcs/drivers/PcDriver.js';
import { PcGuestApi } from '../../src/pcs/GuestApi.js';
import { CAPS_SCRIPT } from '../../src/pcs/guest.js';
import { type InputClient, InputRouter } from '../../src/pcs/InputRouter.js';
import { PcError, PcManager, type PcStatusInfo } from '../../src/pcs/PcManager.js';
import { PHONE_RESOURCES, VIRTUALIZATION_OVERHEAD_MIB } from '../../src/pcs/PcTypes.js';
import { toPcInfo } from '../../src/pcs/pcWire.js';
import { SeatBook } from '../../src/pcs/SeatBook.js';
import { FakeAndroidDriver, fakePool } from './fakes.js';

const INST = 'unit';
const PC = `mv-pc-${INST}-linux-1`;
const PHONE = `${PC}-phone`;
const KERNEL = '/kits/vmlinux-6.18.35-mv-android2';
const HELPER = '#!/bin/sh\necho android helper\n';

let dir: string;
let host: HostFacts;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'mv-caps-')));
  mkdirSync(join(dir, 'home'), { recursive: true });
  host = { cpus: 18, memBytes: 48 * GiB, diskFreeBytes: 199 * GiB };
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** An AndroidKit whose kernel and image are ready (or become ready with progress). */
function fakeKit(options: { kernelReady?: boolean } = {}) {
  const state = { kernelReady: options.kernelReady ?? true, kernelBuilds: 0, imagePreps: 0 };
  const kit: AndroidKitLike = {
    supported: true,
    kernelPath: KERNEL,
    kernelReady: async () => state.kernelReady,
    ensureKernel: async (onProgress) => {
      if (!state.kernelReady) {
        state.kernelBuilds++;
        onProgress?.(10, 'downloading the Linux kernel source (40%)');
        onProgress?.(60, 'building the Android kernel (45%)');
        state.kernelReady = true;
      }
      return KERNEL;
    },
    phoneImageReady: async () => true,
    ensurePhoneImage: async (onProgress) => {
      state.imagePreps++;
      onProgress?.(100, 'the Android image is ready');
      return 'minevibe/android-phone:test';
    },
  };
  return { kit, state };
}

function manager(
  driver = new FakeAndroidDriver(),
  opts: { kit?: AndroidKitLike | null; nested?: boolean; phoneBootTimeoutMs?: number } = {},
) {
  const kit = opts.kit === undefined ? fakeKit().kit : opts.kit;
  const m = new PcManager({
    stateDir: join(dir, 'state'),
    driver,
    pool: fakePool(join(dir, 'caches')),
    labelValue: 'pc-test',
    instanceId: INST,
    hostFacts: async () => host,
    home: join(dir, 'home'),
    bootTimeoutMs: 2000,
    imageBuild: { contextDir: dir, file: join(dir, 'Containerfile') },
    portProbe: { attempts: 2, intervalMs: 10 },
    android: kit,
    androidHelper: HELPER,
    nestedVirtualization: async () =>
      opts.nested === false
        ? { supported: false, reason: 'needs an M3 or newer Mac (this one has an M1)' }
        : { supported: true, chip: 'Apple M5 Pro' },
    phoneBootTimeoutMs: opts.phoneBootTimeoutMs ?? 2000,
  });
  return { m, driver };
}

async function until(cond: () => boolean, what: string, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

async function runningPc(opts: Parameters<typeof manager>[1] = {}) {
  const { m, driver } = manager(new FakeAndroidDriver(), opts);
  await m.init();
  await m.start('linux-1');
  expect(m.status('linux-1').status).toBe('running');
  return { m, driver };
}

describe('pcs.json', () => {
  it('keeps virtualization and android only on Linux PCs, and only when on', async () => {
    mkdirSync(join(dir, 'state'), { recursive: true });
    const base = {
      cpus: 2,
      memMiB: 4096,
      shmMiB: 1024,
      mounts: [],
      pinned: false,
      plugged: true,
      createdAt: 1,
    };
    writeFileSync(
      join(dir, 'state', 'pcs.json'),
      JSON.stringify({
        version: 1,
        nextSlot: 3,
        pcs: [
          { ...base, id: 'linux-1', slot: 1, type: 'linux', virtualization: true, android: 'yes' },
          { ...base, id: 'mac-1', slot: 2, type: 'macos', virtualization: true, android: true },
        ],
      }),
    );
    const { m } = manager();
    await m.init();
    expect(m.get('linux-1')).toMatchObject({ virtualization: true });
    expect(m.get('linux-1')).not.toHaveProperty('android');
    expect(m.get('mac-1')).not.toHaveProperty('virtualization');
    expect(m.get('mac-1')).not.toHaveProperty('android');
    expect(m.views().find((v) => v.pcId === 'mac-1')).not.toHaveProperty('capabilities');
  });
});

describe('nested virtualization', () => {
  it('turning it on recreates the PC with --virtualization and the Android kernel; off recreates it without', async () => {
    const { m, driver } = await runningPc();
    const res = await m.reconfigure('linux-1', { virtualization: true });
    expect(res).toMatchObject({ recreated: true, restarted: true });
    const spec = driver.containers.get(PC)?.spec;
    expect(spec).toMatchObject({ virtualization: true, kernel: KERNEL });
    expect(spec?.labels[KERNEL_LABEL]).toBe(ANDROID_KERNEL.id);
    expect(m.get('linux-1')?.virtualization).toBe(true);
    expect(m.capabilitiesOf('linux-1').virtualization).toEqual({ enabled: true, unavailable: null });
    expect(JSON.parse(readFileSync(m.pcsFile, 'utf8')).pcs[0].virtualization).toBe(true);
    // /dev/kvm comes up root-only: it is opened to the guest user once the PC serves.
    expect(driver.execs.find((e) => e.argv.includes(OPEN_KVM_SCRIPT))).toMatchObject({
      name: PC,
      user: 'root',
    });

    // Stop and start reuse the container: it matches the record (virtualization on).
    await m.stop('linux-1');
    driver.log.length = 0;
    await m.start('linux-1');
    expect(driver.log.filter((l) => l.startsWith('create'))).toEqual([]);

    await m.reconfigure('linux-1', { virtualization: false });
    const after = driver.containers.get(PC)?.spec;
    expect(after?.virtualization).toBeUndefined();
    expect(after?.kernel).toBeUndefined();
    expect(m.get('linux-1')).not.toHaveProperty('virtualization');
  });

  it('a container created without it is recreated once the record wants it (M10)', async () => {
    const { m, driver } = await runningPc();
    await m.stop('linux-1');
    // pcs.json says on (e.g. edited while MineVibe was not running); the stopped container has it off.
    await m.reconfigure('linux-1', { virtualization: true });
    expect(driver.containers.has(PC)).toBe(false);
    await m.start('linux-1');
    expect(driver.containers.get(PC)?.spec.virtualization).toBe(true);
  });

  it('is refused on a Mac that cannot nest virtualization, with the reason', async () => {
    const { m } = manager(new FakeAndroidDriver(), { nested: false });
    await m.init();
    expect(m.capabilitiesOf('linux-1').virtualization.unavailable).toMatch(/M3 or newer/);
    const err = await m.reconfigure('linux-1', { virtualization: true }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PcError);
    expect((err as PcError).code).toBe('UNAVAILABLE');
    expect((err as PcError).message).toMatch(/M3 or newer/);
    expect(m.get('linux-1')).not.toHaveProperty('virtualization');
  });

  it('a record that has it on a Mac that cannot boots without it (and says why)', async () => {
    mkdirSync(join(dir, 'state'), { recursive: true });
    writeFileSync(
      join(dir, 'state', 'pcs.json'),
      JSON.stringify({
        version: 1,
        nextSlot: 2,
        pcs: [
          {
            id: 'linux-1',
            slot: 1,
            type: 'linux',
            cpus: 2,
            memMiB: 4096,
            shmMiB: 1024,
            mounts: [],
            pinned: false,
            plugged: true,
            createdAt: 1,
            virtualization: true,
          },
        ],
      }),
    );
    const { m, driver } = manager(new FakeAndroidDriver(), { nested: false });
    await m.init();
    await m.start('linux-1');
    expect(m.status('linux-1').status).toBe('running');
    expect(driver.containers.get(PC)?.spec.virtualization).toBeUndefined();
    expect(m.capabilitiesOf('linux-1').virtualization).toEqual({
      enabled: true,
      unavailable: 'needs an M3 or newer Mac (this one has an M1)',
    });
    // It holds no virtualization overhead it does not get.
    const withRecord = await m.budget();
    // It can still be turned off.
    await m.reconfigure('linux-1', { virtualization: false });
    expect(m.get('linux-1')).not.toHaveProperty('virtualization');
    expect((await m.budget()).allocated.memBytes).toBe(withRecord.allocated.memBytes);
  });

  it('shows downloading with progress while the kernel is prepared, then boots', async () => {
    const { kit, state } = fakeKit({ kernelReady: false });
    const { m } = manager(new FakeAndroidDriver(), { kit });
    await m.init();
    const seen: PcStatusInfo[] = [];
    m.on('pc.status', (_id, s) => {
      seen.push(s);
    });
    await m.reconfigure('linux-1', { virtualization: true });
    await m.start('linux-1');
    expect(state.kernelBuilds).toBe(1);
    expect(seen.filter((s) => s.status === 'downloading').map((s) => [s.progress, s.detail])).toEqual([
      [0, 'preparing the virtualization kernel'],
      [10, 'downloading the Linux kernel source (40%)'],
      [60, 'building the Android kernel (45%)'],
    ]);
    expect(m.status('linux-1').status).toBe('running');
  });

  it('an engine refusal ("not supported on the platform") becomes a plain UNAVAILABLE', async () => {
    const driver = new FakeAndroidDriver();
    const create = driver.create.bind(driver);
    driver.create = async (spec) => {
      if (spec.virtualization)
        throw new Error('unsupported: "nested virtualization is not supported on the platform"');
      return create(spec);
    };
    const { m } = manager(driver);
    await m.init();
    await m.reconfigure('linux-1', { virtualization: true });
    await expect(m.start('linux-1')).rejects.toThrow(/M3 or newer/);
    expect(m.status('linux-1')).toMatchObject({ status: 'error' });
  });
});

describe('the Android phone', () => {
  it('turning it on starts a phone next to the running PC, links it and leaves the PC alone', async () => {
    const { m, driver } = await runningPc();
    driver.log.length = 0;
    const res = await m.reconfigure('linux-1', { android: true });
    expect(res).toEqual({ recreated: false, restarted: false, warnings: [] });
    await until(() => m.phone('linux-1').status === 'running', 'the phone');
    // The PC itself was not touched.
    expect(driver.log.filter((l) => l.includes(`${PC} `) || l.endsWith(PC))).toEqual([]);
    const phone = driver.phones.get(PHONE);
    expect(phone?.state).toBe('running');
    expect(phone?.spec).toMatchObject({
      image: 'minevibe/android-phone:test',
      kernel: KERNEL,
      network: `${PC}-net`,
      cpus: PHONE_RESOURCES.cpus,
      memoryMiB: PHONE_RESOURCES.memMiB,
      data: { name: `${PC}-phone-data`, target: '/data', sizeGiB: PHONE_RESOURCES.dataGiB },
      initArgs: [...PHONE_INIT_ARGS],
    });
    expect(phone?.spec.labels).toMatchObject({ 'minevibe.pc': 'linux-1', [ROLE_LABEL]: 'phone' });
    expect(phone?.spec.initArgs).toContain('androidboot.redroid_fps=60');
    // android-phone in the PC's /etc/hosts and the helper, as root.
    const link = driver.execs.find((e) => e.name === PC && e.argv.includes(LINK_PHONE_SCRIPT));
    expect(link?.user).toBe('root');
    expect(link?.argv.slice(-2)).toEqual([phone?.ip, Buffer.from(HELPER).toString('base64')]);
    expect(m.phone('linux-1')).toMatchObject({ status: 'running', ip: phone?.ip });
    expect(m.views()[0]?.capabilities?.android).toMatchObject({ enabled: true, unavailable: null });
  });

  it('counts the phone in the PC budget share; virtualization adds its overhead', async () => {
    const { m } = await runningPc();
    const before = await m.budget();
    await m.reconfigure('linux-1', { android: true });
    const withPhone = await m.budget();
    expect(withPhone.allocated.cpus - before.allocated.cpus).toBe(PHONE_RESOURCES.cpus + 1);
    expect((withPhone.allocated.memBytes - before.allocated.memBytes) / MiB).toBe(
      PHONE_RESOURCES.memMiB + 256,
    );
    expect((withPhone.allocated.diskBytes - before.allocated.diskBytes) / GiB).toBe(PHONE_RESOURCES.dataGiB);
    await m.reconfigure('linux-1', { virtualization: true });
    const withVirt = await m.budget();
    expect((withVirt.allocated.memBytes - withPhone.allocated.memBytes) / MiB).toBe(
      VIRTUALIZATION_OVERHEAD_MIB,
    );
  });

  it('a phone that does not fit the budget is refused before anything changes', async () => {
    host = { cpus: 18, memBytes: 30 * GiB, diskFreeBytes: 199 * GiB };
    const { m, driver } = await runningPc();
    const err = await m.reconfigure('linux-1', { android: true }).catch((e: unknown) => e);
    expect((err as PcError).code).toBe('OVER_BUDGET');
    expect(m.get('linux-1')).not.toHaveProperty('android');
    expect(driver.phones.size).toBe(0);
  });

  it('stopping the PC removes its phone first; starting the PC brings a new one', async () => {
    const { m, driver } = await runningPc();
    await m.reconfigure('linux-1', { android: true });
    await until(() => m.phone('linux-1').status === 'running', 'the phone');
    driver.log.length = 0;
    await m.stop('linux-1');
    expect(driver.phones.size).toBe(0);
    expect(driver.log.indexOf(`rm ${PHONE}`)).toBeLessThan(driver.log.indexOf(`stop ${PC}`));
    expect(m.phone('linux-1').status).toBe('off');
    // Its apps survive: the /data volume stays.
    expect(driver.volumes.has(`${PC}-phone-data`)).toBe(true);
    await m.start('linux-1');
    await until(() => m.phone('linux-1').status === 'running', 'the phone again');
    expect(driver.phones.get(PHONE)?.state).toBe('running');
  });

  it('turning it off removes the phone with its data and forgets android-phone in the PC', async () => {
    const { m, driver } = await runningPc();
    await m.reconfigure('linux-1', { android: true });
    await until(() => m.phone('linux-1').status === 'running', 'the phone');
    await m.reconfigure('linux-1', { android: false });
    expect(driver.phones.size).toBe(0);
    expect(driver.volumes.has(`${PC}-phone-data`)).toBe(false);
    expect(driver.execs.some((e) => e.name === PC && e.argv.includes(UNLINK_PHONE_SCRIPT))).toBe(true);
    expect(m.capabilitiesOf('linux-1').android).toMatchObject({ enabled: false, phone: { status: 'off' } });
    expect(m.status('linux-1').status).toBe('running');
  });

  it('on a stopped PC the phone waits for the PC; decommission removes it all', async () => {
    const { m, driver } = manager();
    await m.init();
    await m.reconfigure('linux-1', { android: true });
    expect(driver.phones.size).toBe(0);
    await m.start('linux-1');
    await until(() => m.phone('linux-1').status === 'running', 'the phone');
    await m.decommission('linux-1');
    expect(driver.phones.size).toBe(0);
    expect([...driver.volumes.keys()].filter((v) => v.startsWith(PC))).toEqual([]);
  });

  it('a phone that never finishes booting ends in error and is removed; the PC keeps running', async () => {
    const driver = new FakeAndroidDriver();
    driver.bootCompleted = '0';
    const { m } = manager(driver, { phoneBootTimeoutMs: 200 });
    await m.init();
    await m.start('linux-1');
    await m.reconfigure('linux-1', { android: true });
    await until(() => m.phone('linux-1').status === 'error', 'the error', 4000);
    expect(m.phone('linux-1').detail).toMatch(/did not finish booting/);
    expect(driver.phones.size).toBe(0);
    expect(m.status('linux-1').status).toBe('running');
  });

  it('the monitor starts a stopped phone again, at most 3 times', async () => {
    const { m, driver } = await runningPc();
    await m.reconfigure('linux-1', { android: true });
    await until(() => m.phone('linux-1').status === 'running', 'the phone');
    for (let i = 1; i <= 3; i++) {
      const ph = driver.phones.get(PHONE);
      if (ph) ph.state = 'stopped';
      await m.monitorOnce();
      await until(() => driver.phones.get(PHONE)?.state === 'running', `restart ${i}`);
      await until(() => m.phone('linux-1').status === 'running', `running ${i}`);
    }
    const ph = driver.phones.get(PHONE);
    if (ph) ph.state = 'stopped';
    await m.monitorOnce();
    expect(m.phone('linux-1')).toMatchObject({ status: 'error' });
    expect(m.phone('linux-1').detail).toMatch(/keeps stopping/);
  });

  it('reconcile removes leftover phone and kernel-build containers and never adopts them', async () => {
    const driver = new FakeAndroidDriver();
    const labels = { minevibe: 'pc-test', 'minevibe.instance': INST, 'minevibe.pc': 'linux-1' };
    driver.phones.set(PHONE, {
      spec: {
        name: PHONE,
        image: 'minevibe/android-phone:test',
        kernel: KERNEL,
        network: `${PC}-net`,
        cpus: 4,
        memoryMiB: 4096,
        data: null,
        labels: { ...labels, [ROLE_LABEL]: 'phone' },
        ownerLabels: labels,
        initArgs: [],
      },
      state: 'running',
      ip: '192.168.64.2',
    });
    const { m } = manager(driver);
    await m.init();
    const r = await m.reconcile();
    expect(r.orphans).toEqual([]);
    expect(driver.phones.size).toBe(0);
    expect(driver.log).toContain(`rm ${PHONE}`);
  });

  it('without the kit (Docker) both capabilities are unavailable and refused', async () => {
    const { m } = manager(new FakeAndroidDriver(), { kit: null });
    await m.init();
    expect(m.capabilitiesOf('linux-1')).toMatchObject({
      virtualization: { enabled: false, unavailable: expect.stringMatching(/Apple container/) },
      android: { enabled: false, unavailable: expect.stringMatching(/Apple container/) },
    });
    await expect(m.reconfigure('linux-1', { android: true })).rejects.toThrow(/Apple container/);
  });

  it('macOS PCs have neither', async () => {
    host = { cpus: 18, memBytes: 48 * GiB, diskFreeBytes: 400 * GiB };
    const { m } = manager();
    await m.init();
    const { pc } = await m.create({ type: 'macos' });
    await expect(m.reconfigure(pc.id, { android: true })).rejects.toThrow(/only Linux PCs/);
  });
});

/** A kit that has nothing yet: its downloads wait for the player's OK (PLAN §8.7). */
function freshKit() {
  const state = { kernelReady: false, imageReady: false, kernelBuilds: 0, imagePreps: 0, asked: 0 };
  const kit: AndroidKitLike = {
    supported: true,
    kernelPath: KERNEL,
    kernelReady: async () => state.kernelReady,
    ensureKernel: async () => {
      if (!state.kernelReady) state.kernelBuilds++;
      state.kernelReady = true;
      return KERNEL;
    },
    phoneImageReady: async () => state.imageReady,
    ensurePhoneImage: async () => {
      if (!state.imageReady) state.imagePreps++;
      state.imageReady = true;
      return 'minevibe/android-phone:test';
    },
    downloadsNeeded: async (want) => {
      state.asked++;
      return [
        ...(want.kernel && !state.kernelReady
          ? [{ key: 'kernel:k1', bytes: 214_000_000, what: 'Linux kernel source' }]
          : []),
        ...(want.phone && !state.imageReady
          ? [{ key: 'phone:p1', bytes: 694_000_000, what: 'Android 15' }]
          : []),
      ];
    },
  };
  return { kit, state };
}

describe('download consent (first use on this Mac)', () => {
  it('turning on the phone asks first: nothing downloads or changes until "Download"', async () => {
    const { kit, state } = freshKit();
    const { m, driver } = await runningPc({ kit });
    const res = await m.reconfigure('linux-1', { android: true });
    expect(res.recreated).toBe(false);
    expect(res.warnings.join(' ')).toMatch(/needs a download first/);
    expect(m.get('linux-1')).not.toHaveProperty('android');
    const prompt = m.consentOf('linux-1');
    expect(prompt).toMatchObject({
      what: 'Linux kernel source + Android 15 for linux-1',
      bytes: 908_000_000,
      freeBytes: 199 * GiB,
    });
    expect(prompt?.consentId).toMatch(/^dl-[0-9a-f]{16}$/);
    // pc.state shows it (PcConfigScreen opens the modal), and it fits the protocol.
    const view = m.views()[0];
    const rec = m.get('linux-1');
    if (!view || !rec) throw new Error('no linux-1');
    const info = toPcInfo(view, rec, { seat: { occupant: null, reservation: null }, diskGiB: 64 });
    expect(info?.consent).toEqual({
      consentId: prompt?.consentId,
      what: prompt?.what,
      bytes: 908_000_000,
      freeBytes: 199 * GiB,
    });
    expect(info?.status).toBe('running');
    expect(PcInfo.parse(info)).toEqual(info);
    await new Promise((r) => setTimeout(r, 20));
    expect(state.kernelBuilds + state.imagePreps).toBe(0);
    expect(driver.phones.size).toBe(0);

    await m.answerConsent('linux-1', prompt?.consentId as string, true);
    expect(m.consentOf('linux-1')).toBeNull();
    expect(m.get('linux-1')?.android).toBe(true);
    await until(() => m.phone('linux-1').status === 'running', 'the phone');
    expect(state).toMatchObject({ kernelBuilds: 1, imagePreps: 1 });
    expect(m.views()[0]).not.toHaveProperty('consent');
  });

  it('"Not now" leaves it off; an OK covers later switches of any PC', async () => {
    const { kit, state } = freshKit();
    const { m } = await runningPc({ kit });
    await m.reconfigure('linux-1', { android: true });
    const first = m.consentOf('linux-1')?.consentId as string;
    const wrong = await m.answerConsent('linux-1', 'dl-0000000000000000', true).catch((e: unknown) => e);
    expect((wrong as PcError).code).toBe('INVALID');
    expect(await m.answerConsent('linux-1', first, false)).toBeNull();
    expect(m.consentOf('linux-1')).toBeNull();
    expect(m.get('linux-1')).not.toHaveProperty('android');
    expect(m.phone('linux-1').status).toBe('off');
    expect(state.kernelBuilds + state.imagePreps).toBe(0);

    // Asked again on the next try; this time OK'd.
    await m.reconfigure('linux-1', { android: true });
    const second = m.consentOf('linux-1')?.consentId as string;
    expect(second).not.toBe(first);
    await m.answerConsent('linux-1', second, true);
    await until(() => m.phone('linux-1').status === 'running', 'the phone');
    // Off and on again: nothing left to download, nothing asked.
    await m.reconfigure('linux-1', { android: false });
    await m.reconfigure('linux-1', { android: true });
    expect(m.consentOf('linux-1')).toBeNull();
    expect(m.get('linux-1')?.android).toBe(true);
  });

  it('KVM the first time: the rest of the edit applies now, KVM after "Download" (then the kernel is built)', async () => {
    const { kit, state } = freshKit();
    const { m, driver } = await runningPc({ kit });
    const res = await m.reconfigure('linux-1', { virtualization: true, cpus: 3 });
    expect(res).toMatchObject({ recreated: true, restarted: true });
    expect(m.get('linux-1')).toMatchObject({ cpus: 3 });
    expect(m.get('linux-1')).not.toHaveProperty('virtualization');
    expect(driver.containers.get(PC)?.spec.virtualization).toBeUndefined();
    const prompt = m.consentOf('linux-1');
    expect(prompt).toMatchObject({ what: 'Linux kernel source for linux-1', bytes: 214_000_000 });
    expect(state.kernelBuilds).toBe(0);
    const applied = await m.answerConsent('linux-1', prompt?.consentId as string, true);
    expect(applied).toMatchObject({ recreated: true });
    expect(state.kernelBuilds).toBe(1);
    expect(driver.containers.get(PC)?.spec).toMatchObject({ virtualization: true, kernel: KERNEL });
    expect(m.status('linux-1').status).toBe('running');
  });

  it('a change that does not fit is refused before anything is asked', async () => {
    host = { cpus: 18, memBytes: 30 * GiB, diskFreeBytes: 199 * GiB };
    const { kit } = freshKit();
    const { m } = await runningPc({ kit });
    const err = await m.reconfigure('linux-1', { android: true }).catch((e: unknown) => e);
    expect((err as PcError).code).toBe('OVER_BUDGET');
    expect(m.consentOf('linux-1')).toBeNull();
  });

  it('a new choice replaces a waiting prompt; decommission drops it', async () => {
    const { kit } = freshKit();
    const { m } = await runningPc({ kit });
    await m.reconfigure('linux-1', { android: true });
    expect(m.consentOf('linux-1')).not.toBeNull();
    await m.reconfigure('linux-1', { android: false });
    expect(m.consentOf('linux-1')).toBeNull();
    await m.reconfigure('linux-1', { virtualization: true });
    expect(m.consentOf('linux-1')?.what).toBe('Linux kernel source for linux-1');
    await m.decommission('linux-1');
    expect(m.views()).toEqual([]);
  });

  it('askBeforeDownloads: false (headless runs) downloads without asking', async () => {
    const { kit, state } = freshKit();
    const driver = new FakeAndroidDriver();
    const m = new PcManager({
      stateDir: join(dir, 'state'),
      driver,
      pool: fakePool(join(dir, 'caches')),
      labelValue: 'pc-test',
      instanceId: INST,
      hostFacts: async () => host,
      home: join(dir, 'home'),
      bootTimeoutMs: 2000,
      imageBuild: { contextDir: dir, file: join(dir, 'Containerfile') },
      portProbe: { attempts: 2, intervalMs: 10 },
      android: kit,
      nestedVirtualization: async () => ({ supported: true }),
      askBeforeDownloads: false,
    });
    await m.init();
    await m.start('linux-1');
    await m.reconfigure('linux-1', { android: true });
    expect(m.consentOf('linux-1')).toBeNull();
    await until(() => m.phone('linux-1').status === 'running', 'the phone');
    expect(state.asked).toBe(0);
  });
});

describe('the wire', () => {
  it('pc.state carries the capabilities of a Linux PC, phone progress as a fraction', async () => {
    const { m } = await runningPc();
    await m.reconfigure('linux-1', { android: true });
    await until(() => m.phone('linux-1').status === 'running', 'the phone');
    const view = m.views()[0];
    const rec = m.get('linux-1');
    if (!view || !rec) throw new Error('no linux-1');
    const info = toPcInfo(view, rec, { seat: { occupant: null, reservation: null }, diskGiB: 64 });
    expect(info?.capabilities).toEqual({
      virtualization: { enabled: false, unavailable: null },
      android: {
        enabled: true,
        unavailable: null,
        status: 'running',
        progress: null,
        detail: "android-phone:5555 on the PC's network",
      },
    });
    expect(PcInfo.parse(info)).toEqual(info);
    expect(() => PcState.parse({ t: 'pc.state', v: 1, ...info })).not.toThrow();
  });

  it('a preparing phone reports its progress as a fraction', async () => {
    const { m } = await runningPc();
    const view = { ...(m.views()[0] as NonNullable<ReturnType<typeof m.views>[0]>) };
    view.capabilities = {
      virtualization: { enabled: false, unavailable: 'needs an M3 or newer Mac (this one has an M1)' },
      android: {
        enabled: true,
        unavailable: null,
        phone: { status: 'preparing', progress: 42, detail: 'building the Android kernel (40%)' },
      },
    };
    const info = toPcInfo(view, m.get('linux-1') as NonNullable<ReturnType<typeof m.get>>, {
      seat: { occupant: null, reservation: null },
      diskGiB: 64,
    });
    expect(info?.capabilities?.android).toMatchObject({ status: 'preparing', progress: 0.42 });
    expect(info?.capabilities?.virtualization.unavailable).toMatch(/M1/);
  });
});

describe('pc__info data (GuestApi.info)', () => {
  it('joins the PC manager settings with the guest probe, and the network facts', async () => {
    const { m } = await runningPc();
    await m.reconfigure('linux-1', { android: true });
    await until(() => m.phone('linux-1').status === 'running', 'the phone');
    const scripts: string[] = [];
    const buf = (t: string) => new TextEncoder().encode(t).buffer as ArrayBuffer;
    const client = {
      run: async (cmd: { args: string[] }) => {
        scripts.push(cmd.args[1] ?? '');
        return {
          exit: { code: 0, success: true, timedOut: false },
          stdout: buf(
            'arch=aarch64\nkernel=6.18.35-197-debug\nkvm=no\ncpus=2\nmem=3911\ndisk=25.4\ntool=node 24.4.1\nphone=android-phone\n',
          ),
          stderr: buf(''),
        };
      },
      displays: async () => JSON.stringify([{ primary: true, bounds: { width: 1280, height: 800 } }]),
      capabilities: async () => ({ osName: 'Ubuntu', osVersion: '24.04' }),
    };
    const api = new PcGuestApi({
      pcs: m,
      client: async () => client as unknown as SpacesdClientLike,
      router: new InputRouter({ getClient: async () => ({}) as InputClient }),
      seats: new SeatBook(),
      jpegFormat: () => 1,
    });
    const info = await api.info('linux-1');
    expect(scripts).toContain(CAPS_SCRIPT);
    expect(info.capabilities).toEqual({
      arch: 'aarch64',
      kernel: '6.18.35-197-debug',
      kvm: false,
      cpus: 2,
      memoryMiB: 3911,
      diskFreeGiB: 25.4,
      network: { internet: true, hostAndLan: false },
      toolchains: ['node 24.4.1'],
      virtualization: { enabled: false, unavailable: null },
      android: {
        enabled: true,
        unavailable: null,
        status: 'running',
        detail: "android-phone:5555 on the PC's network",
        host: 'android-phone',
      },
    });
    // The probe is kept for a minute (it runs at every sit and every pc__info).
    await api.info('linux-1');
    expect(scripts.filter((x) => x === CAPS_SCRIPT)).toHaveLength(1);
  });
});
