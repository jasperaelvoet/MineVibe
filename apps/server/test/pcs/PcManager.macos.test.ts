import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GiB, type HostFacts } from '../../src/pcs/Budget.js';
import { MacStartError } from '../../src/pcs/drivers/MacPcDriver.js';
import { tokenFingerprint } from '../../src/pcs/drivers/PcDriver.js';
import { MAC_REFRESH_SCRIPT, MAC_SETUP_SCRIPT } from '../../src/pcs/macGuest.js';
import { PcManager, type PcStatusInfo } from '../../src/pcs/PcManager.js';
import { FakeMacDriver } from './fakeMac.js';
import { FakeDriver, type FakeHealth, fakePool, serving } from './fakes.js';

const INST = 'unit';
const vmName = (id: string) => `mv-pc-${INST}-${id}`;
const DISPLAYS_1280 = JSON.stringify([{ id: '1', primary: true, bounds: { width: 1280, height: 800 } }]);

let dir: string;
let vault: string;
let host: HostFacts;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'mv-pcmac-')));
  vault = join(dir, 'Code', 'foo');
  mkdirSync(join(vault, '.git'), { recursive: true });
  mkdirSync(join(dir, 'home'), { recursive: true });
  mkdirSync(join(dir, 'codex'), { recursive: true });
  host = { cpus: 18, memBytes: 48 * GiB, diskFreeBytes: 300 * GiB };
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function setup(
  opts: { mac?: FakeMacDriver | null; health?: Partial<FakeHealth>; stateDir?: string; codex?: boolean } = {},
) {
  const mac = opts.mac === undefined ? new FakeMacDriver() : opts.mac;
  const runs: NonNullable<FakeHealth['runs']> = [];
  const health: FakeHealth = {
    json: serving,
    runs,
    displays: DISPLAYS_1280,
    runStdout: (cmd) =>
      cmd.args[1] === MAC_SETUP_SCRIPT ? 'MVOK\n' : cmd.args[1] === MAC_REFRESH_SCRIPT ? 'remounted\n' : '',
    ...opts.health,
  };
  const connects: { url: string; token: string | undefined }[] = [];
  const m = new PcManager({
    stateDir: opts.stateDir ?? join(dir, 'state'),
    driver: new FakeDriver(),
    macDriver: mac,
    pool: fakePool(join(dir, 'caches'), connects, health),
    labelValue: 'pc-test',
    instanceId: INST,
    hostFacts: async () => host,
    home: join(dir, 'home'),
    bootTimeoutMs: 2000,
    ...(opts.codex ? { codexExport: join(dir, 'codex') } : {}),
  });
  const statuses: [string, PcStatusInfo][] = [];
  m.on('pc.status', (id, info) => {
    statuses.push([id, info]);
  });
  return { m, mac: mac as FakeMacDriver, runs, connects, statuses };
}

describe('macOS PCs (PcManager + a Lume driver)', () => {
  it('without a macOS driver a macOS PC can be made but not started', async () => {
    const { m } = setup({ mac: null });
    await m.init({ createDefault: false });
    await m.create({ type: 'macos', id: 'mac-1' });
    await expect(m.start('mac-1')).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    expect(m.status('mac-1').status).toBe('error');
    expect(m.codexPathOf('mac-1')).toBeNull();
  });

  it('boots: the engine on demand, a clone with labels and 1280x800, shares for the Vault and the Codex, spacesd at the VM address', async () => {
    const { m, mac, runs, connects } = setup({ codex: true });
    await m.init({ createDefault: false });
    expect(mac.engineHeld).toBe(false);
    const { pc } = await m.create({ type: 'macos', mounts: [{ host: vault, overlays: ['node_modules'] }] });
    expect(pc).toMatchObject({ id: 'mac-1', cpus: 4, memMiB: 8192, disk: { rootfsGiB: 40 } });
    // A macOS share has no build-dir overlays.
    expect(pc.mounts).toEqual([{ host: vault, ro: false, overlays: [] }]);
    await m.start('mac-1');
    expect(m.status('mac-1')).toEqual({ status: 'running' });
    expect(mac.engineHeld).toBe(true);
    expect(mac.keep?.(vmName('mac-1'))).toBe(true);
    expect(mac.keep?.('mv-pc-other123-mac-1')).toBe(false);
    const vm = mac.vms.get(vmName('mac-1'));
    expect(vm?.spec.labels).toMatchObject({
      minevibe: 'pc-test',
      'minevibe.instance': INST,
      'minevibe.pc': 'mac-1',
    });
    expect(vm?.display).toBe('1280x800');
    expect(vm?.shares).toEqual([
      { name: 'foo', hostPath: vault, readOnly: false },
      { name: 'codex', hostPath: join(dir, 'codex'), readOnly: true },
    ]);
    const token = readFileSync(join(dir, 'state', 'pc-tokens', 'mac-1.token'), 'utf8').trim();
    expect(vm?.token).toBe(token);
    expect(connects.at(-1)).toEqual({ url: `http://${vm?.ip}:3211`, token });
    // MineVibe's guest setup ran as `lume` with the Vault links and the Codex share.
    const setupRun = runs.find((r) => r.args[1] === MAC_SETUP_SCRIPT);
    expect(setupRun).toMatchObject({ user: 'lume', args: ['-c', MAC_SETUP_SCRIPT, 'setup', 'foo', vault] });
    expect(setupRun?.env.get('MV_CODEX')).toBe('codex');
    expect(setupRun?.env.get('MV_RG')).toBe('/Volumes/My Shared Files/setup/rg');
    expect(m.codexPathOf('mac-1')).toBe('/Volumes/My Shared Files/codex');
    const b = await m.budget();
    expect(b.allocated.macosRunning).toBe(1);
    expect(b.allocated.memBytes).toBe((8192 + 256) * 1024 * 1024);
    expect(b.allocated.cpus).toBe(4);
  });

  it('a missing image waits for one consent for every waiting PC; accepting downloads it once and boots them', async () => {
    const mac = new FakeMacDriver();
    mac.basePresent = false;
    const { m, statuses } = setup({ mac });
    await m.init({ createDefault: false });
    await m.create({ type: 'macos', id: 'mac-1' });
    await m.create({ type: 'macos', id: 'mac-2', cpus: 2, memMiB: 4096 });
    await m.start('mac-1');
    await m.start('mac-2');
    expect(m.status('mac-1').status).toBe('awaiting_consent');
    expect(m.status('mac-2').status).toBe('awaiting_consent');
    const views = m.views();
    const c1 = views.find((v) => v.pcId === 'mac-1')?.consent;
    expect(c1).toMatchObject({ what: mac.image.what, bytes: mac.image.downloadBytes, freeBytes: 300 * GiB });
    expect(views.find((v) => v.pcId === 'mac-2')?.consent?.consentId).toBe(c1?.consentId);
    // While it waits, it holds no budget.
    expect((await m.budget()).allocated.macosRunning).toBe(0);
    await expect(m.consent('mac-1', 'macos-image-nope', true)).rejects.toMatchObject({ code: 'INVALID' });
    const { start } = await m.consent('mac-1', c1?.consentId as string, true);
    expect(start.sort()).toEqual(['mac-1', 'mac-2']);
    expect(m.pendingConsent).toBeNull();
    const saved = JSON.parse(readFileSync(m.pcsFile, 'utf8')) as {
      consents?: { macosImage?: { digest: string } };
    };
    expect(saved.consents?.macosImage?.digest).toBe(mac.image.digest);
    await Promise.all(start.map((id) => m.start(id)));
    expect(mac.log.filter((l) => l === 'pull')).toHaveLength(1);
    expect(m.status('mac-1').status).toBe('running');
    expect(m.status('mac-2').status).toBe('running');
    const downloading = statuses.filter(([id, s]) => id === 'mac-1' && s.status === 'downloading');
    expect(downloading.map(([, s]) => s.progress)).toEqual(expect.arrayContaining([10, 50, 99]));
    // A later image that is missing again (deleted by hand) needs no new consent: the digest was approved.
    const again = setup({
      mac: Object.assign(new FakeMacDriver(), { basePresent: false }),
      stateDir: join(dir, 'state'),
    });
    await again.m.init({ createDefault: false });
    await again.m.start('mac-1');
    expect(again.m.status('mac-1').status).toBe('running');
  });

  it('a stop while the image downloads ends that wait at once; the download goes on for the next start', async () => {
    const mac = new FakeMacDriver();
    mac.basePresent = false;
    let finish = () => {};
    mac.pullHold = new Promise<void>((r) => {
      finish = r;
    });
    const { m } = setup({ mac });
    await m.init({ createDefault: false });
    await m.create({ type: 'macos', id: 'mac-1' });
    await m.start('mac-1');
    await m.consent('mac-1', m.pendingConsent?.consentId as string, true);
    const starting = m.start('mac-1');
    for (let i = 0; i < 50 && m.status('mac-1').status !== 'downloading'; i++)
      await new Promise((r) => setTimeout(r, 2));
    expect(m.status('mac-1')).toMatchObject({ status: 'downloading', progress: 10 });
    await m.stop('mac-1');
    await starting;
    expect(m.status('mac-1').status).toBe('off');
    expect(mac.vms.size).toBe(0);
    expect((await m.budget()).allocated.macosRunning).toBe(0);
    // The next start joins the same download.
    const again = m.start('mac-1');
    finish();
    await again;
    expect(m.status('mac-1').status).toBe('running');
    expect(mac.log.filter((l) => l === 'pull')).toHaveLength(1);
  });

  it("the manager's input router presses keys on a macOS PC instead of holding them", async () => {
    const input: string[] = [];
    const { m } = setup({ health: { input } });
    await m.init({ createDefault: false });
    await m.create({ type: 'macos', id: 'mac-1', boot: true });
    const router = m.createInputRouter();
    router.setOccupant('mac-1', { kind: 'player', id: 'p' });
    router.submit('mac-1', { kind: 'player', id: 'p' }, [
      { k: 'key', key: 'KEY_META', down: true },
      { k: 'key', key: 'q', down: true },
      { k: 'key', key: 'q', down: false },
      { k: 'key', key: 'KEY_META', down: false },
    ]);
    await router.idle('mac-1');
    expect(input).toEqual(['keyboard {"press":{"key":{"character":"q"},"modifiers":["KEY_META"]}}']);
  });

  it('a declined download turns the PCs off and asks again next time', async () => {
    const mac = new FakeMacDriver();
    mac.basePresent = false;
    const { m } = setup({ mac });
    await m.init({ createDefault: false });
    await m.create({ type: 'macos', id: 'mac-1' });
    await m.start('mac-1');
    const id = m.pendingConsent?.consentId as string;
    expect(await m.consent('mac-1', id, false)).toEqual({ start: [] });
    expect(m.status('mac-1')).toEqual({ status: 'off', detail: 'the macOS download was declined' });
    await m.start('mac-1');
    expect(m.status('mac-1').status).toBe('awaiting_consent');
    expect(m.pendingConsent?.consentId).not.toBe(id);
  });

  it("Apple's limit from the driver shows as macos_slots_full; the budget refuses a third running VM", async () => {
    const { m, mac } = setup();
    await m.init({ createDefault: false });
    await m.create({ type: 'macos', id: 'mac-1' });
    mac.startErrors.push(new MacStartError('MACOS_SLOTS', 'Apple allows two macOS VMs at a time'));
    await expect(m.start('mac-1')).rejects.toMatchObject({ code: 'MACOS_SLOTS' });
    expect(m.status('mac-1')).toMatchObject({ status: 'macos_slots_full' });
    await m.start('mac-1');
    await m.create({ type: 'macos', id: 'mac-2', cpus: 2, memMiB: 4096, boot: true });
    await m.create({ type: 'macos', id: 'mac-3', cpus: 2, memMiB: 4096 });
    await expect(m.start('mac-3')).rejects.toMatchObject({ code: 'MACOS_SLOTS' });
    expect(m.status('mac-3')).toMatchObject({
      status: 'macos_slots_full',
      detail: expect.stringContaining('2/2'),
    });
    expect(mac.vms.has(vmName('mac-3'))).toBe(false);
  });

  it('stop asks the guest to shut down first; resize and new mounts keep the VM (PATCH), reimage clones anew', async () => {
    const { m, mac, runs } = setup();
    await m.init({ createDefault: false });
    await m.create({ type: 'macos', id: 'mac-1', boot: true });
    await m.stop('mac-1');
    expect(m.status('mac-1').status).toBe('off');
    expect(mac.gracefulCalls).toBe(1);
    expect(runs.some((r) => r.args[1]?.includes('shutdown -h now'))).toBe(true);
    await m.start('mac-1');
    const r = await m.resize('mac-1', { cpus: 6, memMiB: 12_288 });
    expect(r.restarted).toBe(true);
    expect(mac.log).toContain(`configure ${vmName('mac-1')} 6/12288`);
    expect(mac.log.filter((l) => l.startsWith('create'))).toHaveLength(1);
    expect(m.status('mac-1').status).toBe('running');
    await m.setMounts('mac-1', [{ host: vault, ro: true }]);
    expect(mac.log.at(-1)).toBe(`start ${vmName('mac-1')} foo:ro`);
    expect(mac.log.filter((l) => l.startsWith('create'))).toHaveLength(1);
    await m.reimage('mac-1');
    expect(mac.log).toContain(`remove ${vmName('mac-1')}`);
    expect(mac.log.filter((l) => l.startsWith('create'))).toHaveLength(2);
    expect(m.status('mac-1').status).toBe('running');
    await expect(m.reconfigure('mac-1', { type: 'linux' })).rejects.toMatchObject({ code: 'UNAVAILABLE' });
  });

  it('decommission removes the VM, its token and its record', async () => {
    const { m, mac } = setup();
    await m.init({ createDefault: false });
    await m.create({ type: 'macos', id: 'mac-1', boot: true });
    await m.decommission('mac-1');
    expect(mac.vms.size).toBe(0);
    expect(existsSync(join(dir, 'state', 'pc-tokens', 'mac-1.token'))).toBe(false);
    expect(m.get('mac-1')).toBeUndefined();
  });

  it('monitor: a VM that ended inside the guest is a crash; a VM running for an off PC is stopped', async () => {
    const { m, mac } = setup();
    await m.init({ createDefault: false });
    await m.create({ type: 'macos', id: 'mac-1', boot: true });
    await m.create({ type: 'macos', id: 'mac-2', cpus: 2, memMiB: 4096, boot: true });
    (mac.vms.get(vmName('mac-1')) as { ended?: boolean }).ended = true;
    await m.stop('mac-2');
    (mac.vms.get(vmName('mac-2')) as { state: string }).state = 'running';
    await m.monitorOnce();
    expect(m.status('mac-1')).toMatchObject({ status: 'error', reason: 'crashed' });
    expect(mac.log).toContain(`stop ${vmName('mac-1')}`);
    expect(mac.vms.get(vmName('mac-2'))?.state).toBe('stopped');
    expect(m.status('mac-2').status).toBe('off');
    await m.start('mac-1');
    expect(m.status('mac-1').status).toBe('running');
  });

  it('monitor: when lume serve dies, its running PCs are crashes; the next start brings Lume back', async () => {
    const { m, mac } = setup();
    await m.init({ createDefault: false });
    await m.create({ type: 'macos', id: 'mac-1', boot: true });
    mac.crashServe();
    await m.monitorOnce();
    expect(m.status('mac-1')).toMatchObject({ status: 'error', reason: 'crashed' });
    expect(m.status('mac-1').detail).toMatch(/Lume/);
    await m.start('mac-1');
    expect(m.status('mac-1').status).toBe('running');
    expect(mac.log.filter((l) => l === 'engine')).toHaveLength(2);
  });

  it("reconcile adopts this instance's running VM that matches its record and stops one that does not", async () => {
    const first = setup();
    await first.m.init({ createDefault: false });
    await first.m.create({ type: 'macos', id: 'mac-1', mounts: [{ host: vault }], boot: true });
    await first.m.create({ type: 'macos', id: 'mac-2', cpus: 2, memMiB: 4096, boot: true });
    // mac-2's VM was resized behind MineVibe's back.
    (first.mac.vms.get(vmName('mac-2')) as { cpus: number }).cpus = 3;
    const next = setup({ mac: first.mac, stateDir: join(dir, 'state') });
    first.mac.engineHeld = false;
    await next.m.init({ createDefault: false });
    const r = await next.m.reconcile();
    expect(r.adopted).toEqual(['mac-1']);
    expect(r.mismatched).toEqual(['mac-2']);
    expect(first.mac.vms.get(vmName('mac-2'))?.state).toBe('stopped');
    const boot = await next.m.bootAll();
    expect(boot.booted.sort()).toEqual(['mac-1', 'mac-2']);
    expect(first.mac.log.filter((l) => l.startsWith(`start ${vmName('mac-1')}`))).toHaveLength(1);
    const token = readFileSync(join(dir, 'state', 'pc-tokens', 'mac-1.token'), 'utf8').trim();
    expect(first.mac.vms.get(vmName('mac-1'))?.token).toBe(token);
    expect(tokenFingerprint(token)).toHaveLength(64);
  });

  it('a host edit of the Vault refreshes the guest view before the next PcApi call (macOS only)', async () => {
    const { m, runs } = setup();
    await m.init({ createDefault: false });
    await m.create({ type: 'macos', id: 'mac-1', mounts: [{ host: vault }], boot: true });
    await m.create({ type: 'linux', id: 'linux-1' });
    const refreshes = () => runs.filter((r) => r.args[1] === MAC_REFRESH_SCRIPT).length;
    (await m.guestIo('mac-1'))();
    expect(refreshes()).toBe(0);
    m.markGuestViewStale('mac-1');
    const done = await m.guestIo('mac-1');
    expect(refreshes()).toBe(1);
    done();
    (await m.guestIo('mac-1'))();
    expect(refreshes()).toBe(1);
    (await m.guestIo('linux-1'))();
    expect(refreshes()).toBe(1);
  });

  it('an incomplete guest setup leaves the PC running with the reason and what went wrong', async () => {
    const { m } = setup({
      health: {
        runStdout: (cmd) => (cmd.args[1] === MAC_SETUP_SCRIPT ? `MVWARN taken ${vault}\nMVOK\n` : ''),
        displays: JSON.stringify([{ primary: true, bounds: { width: 1024, height: 768 } }]),
      },
    });
    await m.init({ createDefault: false });
    await m.create({ type: 'macos', id: 'mac-1', mounts: [{ host: vault }], boot: true });
    expect(m.status('mac-1')).toMatchObject({ status: 'running', reason: 'guest_setup' });
    expect(m.status('mac-1').detail).toContain(`taken ${vault}`);
    // The display switch printed nothing (no "ok"): the 1024x768 guest is reported.
    expect(m.status('mac-1').detail).toContain('the display stays 1024x768');
  });

  it('shutdown stops macOS PCs and lets go of Lume', async () => {
    const { m, mac } = setup();
    await m.init({ createDefault: false });
    await m.create({ type: 'macos', id: 'mac-1', boot: true });
    await m.shutdown();
    expect(mac.vms.get(vmName('mac-1'))?.state).toBe('stopped');
    expect(mac.log.at(-1)).toBe('engine-stop');
  });
});
