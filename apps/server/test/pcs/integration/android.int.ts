/**
 * PC capabilities on the real Apple `container` 1.5.0 runtime (PLAN §8.7, spike S9-android): `npm run test:pcs` with
 * `MINEVIBE_TEST_ANDROID=1` (it downloads ~660 MB once, and builds a kernel unless one is given).
 *
 * - Nested virtualization: a PC created with it boots MineVibe's Android kernel at EL2 and has a usable /dev/kvm (on an
 *   M3 or newer Mac; skipped elsewhere).
 * - The Android phone: turned on for the running PC, it boots next to it (Redroid on the PC's network), the PC reaches
 *   it as `android-phone` with the `android` helper, and adb inside the PC talks to Android 15. Turning it off removes
 *   it and its data.
 *
 * `MINEVIBE_TEST_ANDROID_SCRCPY=1` also runs `android open` in the PC: apt build tools, scrcpy 3.3.4 built from source
 * (about a minute), and the "Android phone" window on the PC's desktop. `MINEVIBE_TEST_ANDROID_APK=<url>` (an arm64 APK,
 * e.g. Shattered Pixel Dungeon from F-Droid, as in the spike) downloads it in the PC, installs and launches it.
 *
 * `MINEVIBE_ANDROID_KERNEL=<path>` uses a kernel built elsewhere (the spike's `vmlinux-6.18.35-mv-android2`) instead
 * of building one (~4 min). The kit's folder is the real one (`<appRoot>/minevibe-android`): what the test prepares
 * (kernel, phone image) is what MineVibe uses later. Everything else carries a per-run label and is deleted at the end;
 * the engine is stopped only when this run started it.
 */
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findRepoRoot } from '../../../src/config/paths.js';
import { androidKitFor, readAndroidHelper } from '../../../src/pcs/android/index.js';
import { AppleContainerDriver } from '../../../src/pcs/drivers/AppleContainerDriver.js';
import {
  ContainerRuntime,
  devContainerRoots,
  readContainerLock,
} from '../../../src/pcs/drivers/ContainerRuntime.js';
import { MANAGED_LABEL } from '../../../src/pcs/drivers/PcDriver.js';
import { nestedVirtualizationSupport } from '../../../src/pcs/host.js';
import { PcManager } from '../../../src/pcs/PcManager.js';
import { LINUX_PC_IMAGE_DEV } from '../../../src/pcs/PcTypes.js';
import { SpacesdPool } from '../../../src/pcs/SpacesdPool.js';

const ENABLED = process.env.MINEVIBE_TEST_ANDROID === '1';
const SCRCPY = process.env.MINEVIBE_TEST_ANDROID_SCRCPY === '1';
const APK = process.env.MINEVIBE_TEST_ANDROID_APK ?? '';
/** Where to save a JPEG of the PC's desktop with the app running (optional). */
const SHOT = process.env.MINEVIBE_TEST_ANDROID_SHOT ?? '';
const RUN = `${process.pid.toString(36)}${Date.now().toString(36).slice(-4)}`;
const LABEL = `pc-test-${RUN}`;
const ID = `and-${process.pid.toString(36)}`;
const repo = findRepoRoot(fileURLToPath(import.meta.url)) as string;
const roots = {
  appRoot: process.env.MINEVIBE_CONTAINER_APP_ROOT ?? devContainerRoots().appRoot,
  installRoot: process.env.MINEVIBE_CONTAINER_INSTALL_ROOT ?? devContainerRoots().installRoot,
};
const context = join(repo, 'images', 'linux-pc');

const results: Record<string, unknown> = {};
const note = (k: string, v: unknown) => {
  results[k] = v;
  console.log(`[android] ${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`);
};
const ms = (t0: number) => Math.round(performance.now() - t0);
const txt = (b: ArrayBuffer) => Buffer.from(b).toString('utf8');

let tmp: string;
let runtime: ContainerRuntime;
let driver: AppleContainerDriver;
let pool: SpacesdPool;
let manager: PcManager;
let engineBefore = 'unknown';
let nested = false;

async function asCua(script: string, timeoutMs = 120_000) {
  const c = await pool.client(ID);
  const out = await c.run({
    program: 'bash',
    args: ['-lc', script],
    env: new Map([
      ['HOME', '/home/cua'],
      ['DISPLAY', ':1'],
    ]),
    stdin: false,
    user: 'cua',
    timeoutMs,
  });
  return { code: out.exit.code, stdout: txt(out.stdout).trim(), stderr: txt(out.stderr).trim() };
}

async function waitFor(cond: () => boolean, what: string, timeoutMs: number): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

async function cleanupLabelled(): Promise<void> {
  for (const c of await driver.list({ [MANAGED_LABEL]: LABEL })) await driver.remove(c.name);
  for (const v of await driver.listVolumes({ [MANAGED_LABEL]: LABEL })) await driver.removeVolume(v.name);
  for (const n of await driver.listNetworks({ [MANAGED_LABEL]: LABEL })) await driver.removeNetwork(n.name);
}

describe.skipIf(!ENABLED)('PC capabilities on Apple container (MINEVIBE_TEST_ANDROID=1)', () => {
  beforeAll(async () => {
    tmp = realpathSync(mkdtempSync(join(tmpdir(), 'mv-android-int-')));
    const lock = await readContainerLock(join(repo, 'packaging', 'vendor.lock.json'));
    runtime = new ContainerRuntime({
      ...roots,
      lock,
      cacheDir: join(homedir(), 'Library', 'Caches', 'MineVibe-dev', 'vendor'),
      leaseHolder: `test:android ${RUN}`,
    });
    driver = new AppleContainerDriver(runtime);
    await runtime.provision();
    engineBefore = (await runtime.status()).ownership;
    note('engine_before', engineBefore);
    await driver.ensureEngine();
    await cleanupLabelled();
    if (!(await driver.imageExists(LINUX_PC_IMAGE_DEV))) {
      await driver.buildImage({
        contextDir: context,
        file: join(context, 'Containerfile'),
        tag: LINUX_PC_IMAGE_DEV,
      });
    }
    nested = (await nestedVirtualizationSupport()).supported;
    note('nested_virtualization', nested);
    pool = new SpacesdPool({ cachesDir: join(tmp, 'caches') });
    await pool.module();
    const stateDir = join(tmp, 'state');
    manager = new PcManager({
      stateDir,
      driver,
      pool,
      labelValue: LABEL,
      diskPath: roots.appRoot,
      bootTimeoutMs: 180_000,
      imageBuild: { contextDir: context, file: join(context, 'Containerfile') },
      android: androidKitFor({
        appRoot: roots.appRoot,
        driver,
        stateDir,
        labelValue: LABEL,
        manager: () => manager,
      }),
      androidHelper: readAndroidHelper(context),
      phoneBootTimeoutMs: 180_000,
    });
    await manager.init({ createDefault: false });
    note('instance', manager.instanceId);
  });

  afterAll(async () => {
    try {
      if (manager?.get(ID)) await manager.decommission(ID);
    } catch (err) {
      console.log(`[android] decommission failed: ${String(err)}`);
    }
    try {
      if (driver) await cleanupLabelled();
      note('leftover_containers', driver ? (await driver.list({ [MANAGED_LABEL]: LABEL })).length : 0);
      await manager?.shutdown({ stopEngine: false });
      if (runtime && engineBefore === 'not_running')
        note('engine_stopped', await runtime.releaseAndStopIfUnused());
      else await runtime?.leases.release();
    } finally {
      if (tmp) rmSync(tmp, { recursive: true, force: true });
      console.log(`[android] RESULTS ${JSON.stringify(results)}`);
    }
  });

  it('a PC with nested virtualization boots the Android kernel and has a usable /dev/kvm', async () => {
    if (!nested) {
      note('virtualization', 'skipped: this Mac cannot nest virtualization');
      return;
    }
    await manager.create({ type: 'linux', id: ID });
    const t0 = performance.now();
    await manager.reconfigure(ID, { virtualization: true });
    await manager.start(ID);
    note('virtualization_boot_ms', ms(t0));
    const info = await driver.inspect(manager.containerNameOf(ID));
    expect(info?.virtualization).toBe(true);
    const k = await asCua('uname -r; ls -l /dev/kvm; [ -r /dev/kvm ] && [ -w /dev/kvm ] && echo kvm-usable');
    note('virtualization_guest', k.stdout);
    expect(k.stdout).toMatch(/mv-android/);
    expect(k.stdout).toContain('kvm-usable');
  });

  it('turning on the Android phone boots it next to the PC; adb in the PC reaches Android 15', async () => {
    if (!manager.get(ID)) await manager.create({ type: 'linux', id: ID });
    if (manager.status(ID).status !== 'running') await manager.start(ID);
    const t0 = performance.now();
    const res = await manager.reconfigure(ID, { android: true });
    expect(res.recreated).toBe(false);
    let last = '';
    await waitFor(
      () => {
        const p = manager.phone(ID);
        const line = `${p.status} ${p.progress ?? ''} ${p.detail ?? ''}`;
        if (line !== last) {
          last = line;
          console.log(`[android] phone: ${line}`);
        }
        if (p.status === 'error') throw new Error(`the phone failed: ${p.detail}`);
        return p.status === 'running';
      },
      'the phone',
      40 * 60_000,
    );
    note('phone_ready_ms', ms(t0));
    note('phone', manager.phone(ID));
    const hosts = await asCua('getent hosts android-phone; command -v android');
    expect(hosts.stdout).toMatch(/android-phone/);
    expect(hosts.stdout).toContain('/usr/local/bin/android');
    const t1 = performance.now();
    const v = await asCua(
      'android adb shell getprop ro.build.version.release; android adb shell getprop ro.product.cpu.abilist',
      300_000,
    );
    note('adb_ms', ms(t1));
    note('android_adb', v);
    expect(v.code).toBe(0);
    expect(v.stdout).toMatch(/^15/m);
    expect(v.stdout).toContain('arm64-v8a');
    const status = await asCua('android status');
    note('android_status', status.stdout);
    expect(status.stdout).toContain('booted: Android 15');
    const info = await manager.capabilitiesOf(ID);
    expect(info.android.phone.status).toBe('running');
  });

  it.skipIf(!SCRCPY)(
    'android open shows the phone in a window on the PC desktop (scrcpy built in the PC)',
    async () => {
      const t0 = performance.now();
      const open = await asCua('android open', 600_000);
      note('android_open_ms', ms(t0));
      note('android_open', open);
      expect(open.code).toBe(0);
      const win = await asCua("xdotool search --name '^Android phone$' | head -n 1");
      expect(win.stdout).toMatch(/^\d+$/);
      const shot = await asCua('android screenshot /tmp/phone.png && stat -c %s /tmp/phone.png');
      expect(Number(shot.stdout.split('\n').at(-1))).toBeGreaterThan(1000);
      // The second open finds the window already there.
      expect((await asCua('android open')).stdout).toContain('already open');
    },
  );

  it.skipIf(!APK)('android install and launch run a real APK', async () => {
    const t0 = performance.now();
    const r = await asCua(
      `set -e; curl -fsSL -o ~/test.apk ${JSON.stringify(APK)}; android install ~/test.apk; android apps`,
      600_000,
    );
    note('apk_install_ms', ms(t0));
    note('apk_install', r);
    expect(r.code).toBe(0);
    const pkg = /android: installed (\S+)/.exec(r.stdout)?.[1];
    expect(pkg).toBeTruthy();
    const launch = await asCua(`android launch ${pkg}; sleep 3; android adb shell pidof ${pkg}`);
    note('apk_launch', launch);
    expect(launch.stdout).toMatch(/started/);
    expect(launch.stdout.split('\n').at(-1)).toMatch(/^\d+/);
    if (SHOT) {
      await new Promise((r) => setTimeout(r, 5_000));
      const c = await pool.client(ID);
      const s = await c.screenshot({
        format: pool.jpegFormat,
        quality: 85,
        maxDimension: 1280,
        includeCursor: false,
      });
      writeFileSync(SHOT, Buffer.from(s.image));
      note('desktop_shot', SHOT);
    }
  });

  it('the phone keeps its apps across a PC restart (its /data volume)', async () => {
    const mark = await asCua(
      'android adb shell "echo kept > /data/local/tmp/mv-mark && cat /data/local/tmp/mv-mark"',
    );
    expect(mark.stdout).toContain('kept');
    await manager.stop(ID);
    expect(manager.phone(ID).status).toBe('off');
    await manager.start(ID);
    await waitFor(() => manager.phone(ID).status === 'running', 'the phone again', 180_000);
    const again = await asCua('android adb shell cat /data/local/tmp/mv-mark', 120_000);
    expect(again.stdout).toContain('kept');
  });

  it('turning the phone off removes it and its data; the PC forgets android-phone', async () => {
    await manager.reconfigure(ID, { android: false });
    const phoneName = `${manager.containerNameOf(ID)}-phone`;
    expect(await driver.inspect(phoneName)).toBeNull();
    const vols = (await driver.listVolumes({ [MANAGED_LABEL]: LABEL })).map((v) => v.name);
    expect(vols.some((v) => v.endsWith('-phone-data'))).toBe(false);
    const hosts = await asCua('getent hosts android-phone || echo none');
    expect(hosts.stdout).toBe('none');
    const st = await asCua('android status');
    expect(st.stdout).toContain('not attached');
  });
});
