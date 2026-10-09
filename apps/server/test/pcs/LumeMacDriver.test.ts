import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { baseVmName, LumeMacDriver } from '../../src/pcs/drivers/LumeMacDriver.js';
import { type LumeLocks, LumeRuntime } from '../../src/pcs/drivers/LumeRuntime.js';
import { MacStartError } from '../../src/pcs/drivers/MacPcDriver.js';
import { tokenFingerprint } from '../../src/pcs/drivers/PcDriver.js';
import { FakeLume } from './fakeLume.js';

const DIGEST = `sha256:${'a'.repeat(64)}`;
const GiB = 1024 ** 3;
const locks: LumeLocks = {
  lume: {
    version: '0.6.1',
    url: 'https://example.invalid/lume.tgz',
    size: 1,
    sha256: 'b'.repeat(64),
    teamId: 'YCK386LBJ7',
    appFiles: { 'Contents/MacOS/lume': 'c'.repeat(64) },
  },
  image: {
    ref: 'ghcr.io/trycua/macos:26-test',
    lumeRef: 'macos:26-test',
    digest: DIGEST,
    downloadBytes: 10 * GiB,
    diskBytes: 150 * GiB,
  },
};
const BASE = baseVmName(locks.image.lumeRef);
const LABELS = { minevibe: 'pc-test', 'minevibe.instance': 'unit', 'minevibe.pc': 'mac-1' };

let dir: string;
let fake: FakeLume;
let free = 500 * GiB;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'mv-lumedrv-')));
  fake = new FakeLume(join(dir, 'lume'));
  free = 500 * GiB;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function driver() {
  const runtime = new LumeRuntime({
    root: join(dir, 'lume'),
    locks,
    cacheDir: dir,
    fetchImpl: fake.fetch as typeof fetch,
    attachPort: 7777,
  });
  return new LumeMacDriver(runtime, { pollMs: 1, freeDisk: async () => free, startTimeoutMs: 5_000 });
}

function withBase() {
  fake.addVm(BASE, { digest: DIGEST });
}

describe('LumeMacDriver (against a fake lume serve)', () => {
  it('the base image counts only with the pinned digest', async () => {
    const d = driver();
    expect(BASE).toBe('mv-base-macos-26-test');
    expect(await d.baseImage()).toEqual({ present: false });
    fake.addVm(BASE, { digest: `sha256:${'f'.repeat(64)}` });
    expect((await d.baseImage()).problem).toMatch(/not the pinned/);
    fake.vms.delete(BASE);
    withBase();
    expect(await d.baseImage()).toMatchObject({ present: true, allocatedBytes: 30 * GiB });
  });

  it('pulls the image once for concurrent callers, with progress, and checks its digest', async () => {
    const d = driver();
    const a: number[] = [];
    const b: number[] = [];
    await Promise.all([d.pullBase((p) => a.push(p.fraction)), d.pullBase((p) => b.push(p.fraction))]);
    expect(fake.calls.filter((c) => c === 'POST /lume/pull/start')).toHaveLength(1);
    expect(a).toEqual([0.1, 0.6, 1, 1]);
    expect(b).toEqual(a);
    expect((await d.baseImage()).present).toBe(true);
    // Pulled again only when missing.
    await d.pullBase();
    expect(fake.calls.filter((c) => c === 'POST /lume/pull/start')).toHaveLength(1);
  });

  it('refuses a pull without room, one whose digest is not pinned, and reports a failed download', async () => {
    free = 20 * GiB;
    await expect(driver().pullBase()).rejects.toThrow(/needs about \d+ GiB of free disk, 20 GiB free/);
    free = 500 * GiB;
    fake.pullDigest = `sha256:${'e'.repeat(64)}`;
    await expect(driver().pullBase()).rejects.toMatchObject({ code: 'VERIFY_FAILED' });
    fake.vms.delete(BASE);
    rmSync(join(dir, 'lume', 'vms', BASE), { recursive: true, force: true });
    fake.pullFails = true;
    await expect(driver().pullBase()).rejects.toThrow(/download failed: Async pull failed/);
  });

  it('create: a clone with CPUs, memory, display and the labels; another VM of that name is left alone', async () => {
    withBase();
    const d = driver();
    const info = await d.create({
      name: 'mv-pc-unit-mac-1',
      cpus: 4,
      memoryMiB: 8192,
      display: [1280, 800],
      labels: LABELS,
    });
    expect(info).toMatchObject({
      state: 'stopped',
      cpus: 4,
      memoryBytes: 8 * GiB,
      display: '1280x800',
      labels: LABELS,
    });
    expect(fake.calls).toContain('POST /lume/vms/clone');
    // Idempotent for this PC; refused for one whose labels differ.
    expect(
      (
        await d.create({
          name: 'mv-pc-unit-mac-1',
          cpus: 4,
          memoryMiB: 8192,
          display: [1280, 800],
          labels: LABELS,
        })
      ).name,
    ).toBe('mv-pc-unit-mac-1');
    await expect(
      d.create({
        name: 'mv-pc-unit-mac-1',
        cpus: 4,
        memoryMiB: 8192,
        display: [1280, 800],
        labels: { ...LABELS, 'minevibe.instance': 'other' },
      }),
    ).rejects.toThrow(/not this PC's/);
    await expect(
      d.create({ name: 'mv-pc-unit-mac-2', cpus: 2, memoryMiB: 4096, display: [1280, 800], labels: LABELS }),
    ).resolves.toBeTruthy();
    await expect(
      d.create({ name: BASE, cpus: 2, memoryMiB: 4096, display: [1, 1], labels: {} }),
    ).rejects.toThrow(/invalid macOS VM name/);
  });

  it('start: the token in a 0600 setup share, Vault links named by MineVibe, VNC off; resolves with the address', async () => {
    withBase();
    const d = driver();
    const vault = join(dir, 'Code', 'web-app');
    mkdirSync(vault, { recursive: true });
    await d.create({
      name: 'mv-pc-unit-mac-1',
      cpus: 4,
      memoryMiB: 8192,
      display: [1280, 800],
      labels: LABELS,
    });
    const { ip } = await d.start({
      name: 'mv-pc-unit-mac-1',
      token: 't'.repeat(48),
      shares: [
        { name: 'web-app', hostPath: vault, readOnly: false },
        { name: 'codex', hostPath: join(dir, 'codex'), readOnly: true },
      ],
    });
    expect(ip).toMatch(/^192\.168\.65\.\d+$/);
    const shares = join(dir, 'lume', 'shares', 'mv-pc-unit-mac-1');
    const token = join(shares, 'setup', 'env-token');
    expect(readFileSync(token, 'utf8')).toBe('t'.repeat(48));
    expect(statSync(token).mode & 0o777).toBe(0o600);
    expect(statSync(join(shares, 'setup')).mode & 0o777).toBe(0o700);
    expect(lstatSync(join(shares, 'links', 'web-app')).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(shares, 'links', 'web-app'))).toBe(vault);
    const session = JSON.parse(
      readFileSync(join(dir, 'lume', 'vms', 'mv-pc-unit-mac-1', 'sessions.json'), 'utf8'),
    ) as {
      sharedDirectories: { hostPath: string; readOnly: boolean }[];
    };
    expect(session.sharedDirectories).toEqual([
      { hostPath: join(shares, 'setup'), readOnly: true },
      { hostPath: join(shares, 'links', 'web-app'), readOnly: false },
      { hostPath: join(shares, 'links', 'codex'), readOnly: true },
    ]);
    const info = await d.inspect('mv-pc-unit-mac-1');
    expect(info).toMatchObject({ state: 'running', ip, tokenSha256: tokenFingerprint('t'.repeat(48)) });
    expect(info?.shares).toEqual(session.sharedDirectories);
    // The token never reaches the API.
    expect(JSON.stringify(fake.calls)).not.toContain('t'.repeat(48));
    // A restart with fewer shares drops the stale link.
    await d.stop('mv-pc-unit-mac-1');
    await d.start({ name: 'mv-pc-unit-mac-1', token: 'u'.repeat(48), shares: [] });
    expect(existsSync(join(shares, 'links', 'web-app'))).toBe(false);
    await expect(
      d.start({
        name: 'mv-pc-unit-mac-1',
        token: 'x',
        shares: [{ name: 'setup', hostPath: vault, readOnly: true }],
      }),
    ).rejects.toThrow(/invalid or duplicate share name setup/);
  });

  it("a third VM fails on Apple's limit, read from the serve log", async () => {
    withBase();
    const d = driver();
    for (const n of ['mv-pc-unit-a', 'mv-pc-unit-b', 'mv-pc-unit-c']) {
      await d.create({ name: n, cpus: 2, memoryMiB: 4096, display: [1280, 800], labels: LABELS });
    }
    await d.start({ name: 'mv-pc-unit-a', token: 'a', shares: [] });
    await d.start({ name: 'mv-pc-unit-b', token: 'b', shares: [] });
    const err = await d.start({ name: 'mv-pc-unit-c', token: 'c', shares: [] }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MacStartError);
    expect(err).toMatchObject({ code: 'MACOS_SLOTS' });
  });

  it('a VM MineVibe did not make is never started', async () => {
    withBase();
    fake.addVm('mv-pc-unit-foreign');
    await expect(driver().start({ name: 'mv-pc-unit-foreign', token: 'x', shares: [] })).rejects.toThrow(
      /no MineVibe sidecar/,
    );
  });

  it('a shutdown inside the guest: Lume still says running, the driver says stopped; stop resets it', async () => {
    withBase();
    const d = driver();
    await d.create({
      name: 'mv-pc-unit-mac-1',
      cpus: 4,
      memoryMiB: 8192,
      display: [1280, 800],
      labels: LABELS,
    });
    await d.start({ name: 'mv-pc-unit-mac-1', token: 't', shares: [] });
    // The log has one-second times: the end must come after the run's start.
    await new Promise((r) => setTimeout(r, 1100));
    fake.guestShutdown('mv-pc-unit-mac-1');
    expect(fake.vms.get('mv-pc-unit-mac-1')?.status).toBe('running');
    expect(await d.inspect('mv-pc-unit-mac-1')).toMatchObject({ state: 'stopped', ended: true });
    expect((await d.list({ minevibe: 'pc-test' }))[0]).toMatchObject({ state: 'stopped', ended: true });
    await d.stop('mv-pc-unit-mac-1');
    expect(fake.calls.at(-1)).toBe('POST /lume/vms/mv-pc-unit-mac-1/stop');
    expect(fake.vms.get('mv-pc-unit-mac-1')?.status).toBe('stopped');
  });

  it('a graceful stop asks the guest first and powers off what is left; remove deletes the VM and its shares', async () => {
    withBase();
    const d = driver();
    await d.create({
      name: 'mv-pc-unit-mac-1',
      cpus: 4,
      memoryMiB: 8192,
      display: [1280, 800],
      labels: LABELS,
    });
    await d.start({ name: 'mv-pc-unit-mac-1', token: 't', shares: [] });
    let asked = 0;
    await d.stop('mv-pc-unit-mac-1', {
      graceful: async () => {
        asked++;
        await new Promise((r) => setTimeout(r, 1100));
        fake.guestShutdown('mv-pc-unit-mac-1');
      },
      timeoutMs: 5_000,
    });
    expect(asked).toBe(1);
    expect((await d.inspect('mv-pc-unit-mac-1'))?.state).toBe('stopped');
    await d.remove('mv-pc-unit-mac-1');
    expect(await d.inspect('mv-pc-unit-mac-1')).toBeNull();
    expect(existsSync(join(dir, 'lume', 'shares', 'mv-pc-unit-mac-1'))).toBe(false);
  });

  it('list: only MineVibe VMs with the labels asked for, never the base', async () => {
    withBase();
    const d = driver();
    await d.create({
      name: 'mv-pc-unit-mac-1',
      cpus: 4,
      memoryMiB: 8192,
      display: [1280, 800],
      labels: LABELS,
    });
    await d.create({
      name: 'mv-pc-other-mac-1',
      cpus: 4,
      memoryMiB: 8192,
      display: [1280, 800],
      labels: { ...LABELS, 'minevibe.instance': 'other' },
    });
    fake.addVm('mv-pc-unit-nosidecar');
    expect((await d.list({ 'minevibe.instance': 'unit' })).map((v) => v.name)).toEqual(['mv-pc-unit-mac-1']);
    expect((await d.list({})).map((v) => v.name).sort()).toEqual(['mv-pc-other-mac-1', 'mv-pc-unit-mac-1']);
  });
});
