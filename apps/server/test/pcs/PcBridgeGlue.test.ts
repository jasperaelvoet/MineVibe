import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ERROR_CODES, PcInfo } from '@minevibe/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { silentLogger } from '../../src/log.js';
import { GiB, type HostFacts } from '../../src/pcs/Budget.js';
import type { FrameService, ViewTier } from '../../src/pcs/FrameService.js';
import type { PcGuestApi } from '../../src/pcs/GuestApi.js';
import { type InputClient, InputRouter } from '../../src/pcs/InputRouter.js';
import { PcBridgeGlue } from '../../src/pcs/PcBridgeGlue.js';
import { PcManager } from '../../src/pcs/PcManager.js';
import { SeatBook } from '../../src/pcs/SeatBook.js';
import type { ShellMirror } from '../../src/pcs/ShellMirror.js';
import { FakePcBridge } from './fakeBridge.js';
import { FakeAndroidDriver, FakeDriver, fakePool } from './fakes.js';

let dir: string;
let host: HostFacts;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'mv-glue-')));
  mkdirSync(join(dir, 'home'), { recursive: true });
  host = { cpus: 18, memBytes: 48 * GiB, diskFreeBytes: 199 * GiB };
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

async function setup(opts: { android?: boolean; fresh?: { kernel: boolean } } = {}) {
  const driver = opts.android ? new FakeAndroidDriver() : new FakeDriver();
  const manager = new PcManager({
    stateDir: join(dir, 'state'),
    driver,
    pool: fakePool(join(dir, 'caches')),
    labelValue: 'pc-test',
    instanceId: 'unit',
    hostFacts: async () => host,
    home: join(dir, 'home'),
    bootTimeoutMs: 2000,
    imageBuild: { contextDir: dir, file: join(dir, 'Containerfile') },
    portProbe: { attempts: 1, intervalMs: 1 },
    ...(opts.android
      ? {
          // A kit whose kernel and phone image are ready (PLAN §8.7).
          android: {
            supported: true,
            kernelPath: '/kits/vmlinux',
            kernelReady: async () => true,
            ensureKernel: async () => '/kits/vmlinux',
            phoneImageReady: async () => true,
            ensurePhoneImage: async () => 'minevibe/android-phone:test',
            // `fresh`: the kernel is not on this Mac yet, so turning a switch on asks first (PLAN §8.7).
            ...(opts.fresh
              ? {
                  downloadsNeeded: async (want: { kernel: boolean }) =>
                    want.kernel && opts.fresh?.kernel
                      ? [{ key: 'kernel:k1', bytes: 214_000_000, what: 'Linux kernel source' }]
                      : [],
                }
              : {}),
          },
          nestedVirtualization: async () => ({ supported: true }),
        }
      : {}),
  });
  await manager.init();
  const bridge = new FakePcBridge();
  const tiers: [string, ViewTier][] = [];
  const acks: [number, number][] = [];
  const frames = {
    setTier: (pcId: string, t: ViewTier) => void tiers.push([pcId, t]),
    ack: (slot: number, seq: number) => void acks.push([slot, seq]),
  };
  const input: string[] = [];
  const client: InputClient = {
    pointerJson: async (j) => {
      input.push(`pointer ${j}`);
      return '{}';
    },
    keyboardJson: async (j) => {
      input.push(`keyboard ${j}`);
      return '{}';
    },
    typeText: async (t) => void input.push(`type ${t}`),
    hotkey: async (k) => void input.push(`hotkey ${k.join('+')}`),
  };
  const router = new InputRouter({ getClient: async () => client });
  const seats = new SeatBook();
  const killed: string[] = [];
  const guest = {
    killTag: async (pcId: string, tag: string) => {
      killed.push(`${pcId} ${tag}`);
      return 1;
    },
    forgetPc: () => {},
    forgetGuest: () => {},
  };
  const mirrors = new Map<string, string>();
  const mirrorLog: string[] = [];
  const mirror = {
    open: async (pcId: string, agentId: string) => {
      mirrors.set(pcId, agentId);
      mirrorLog.push(`open ${pcId} ${agentId}`);
    },
    close: async (pcId: string) => {
      mirrors.delete(pcId);
      mirrorLog.push(`close ${pcId}`);
    },
    openFor: (pcId: string) => mirrors.get(pcId) ?? null,
    forget: (pcId: string) => void mirrors.delete(pcId),
  };
  const picks: unknown[] = [];
  const glue = new PcBridgeGlue({
    bridge,
    manager,
    frames: frames as unknown as FrameService,
    router,
    seats,
    guest: guest as unknown as PcGuestApi,
    mirror: mirror as unknown as ShellMirror,
    pickFolder: async (r) => {
      picks.push(r);
      return '/Users/me/Code/picked';
    },
    logger: silentLogger(),
    settleMs: 1500,
    budgetDebounceMs: 0,
    helloRepushMs: 30,
  });
  glue.attach();
  return { driver, manager, bridge, tiers, acks, input, router, seats, killed, mirrorLog, picks, glue };
}

const states = (b: FakePcBridge, pcId = 'linux-1') => b.pushed('pc.state').filter((s) => s.pcId === pcId);
/** The `err` code of a request, or null when it succeeded. */
const errCode = (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e: { code: string }) => e.code,
  );

describe('pushes', () => {
  it('sends every PC and the budget after hello, schema-valid, and only changes afterwards', async () => {
    const t = await setup();
    t.bridge.fire('hello', { mod: '0.1.0', mc: '26.3', phase: 'in_world', worldId: 'world-1' });
    await tick(5);
    const first = states(t.bridge);
    expect(first).toHaveLength(1);
    expect(PcInfo.safeParse(first[0]).success).toBe(true);
    expect(first[0]).toMatchObject({
      pcId: 'linux-1',
      name: 'linux-1',
      status: 'off',
      slot: 1,
      occupant: null,
    });
    await tick(20);
    expect(t.bridge.pushed('budget.state').length).toBeGreaterThan(0);
    // The second full push a moment later.
    await tick(40);
    expect(states(t.bridge)).toHaveLength(2);
    t.bridge.clear();
    t.glue.pushStates();
    expect(states(t.bridge)).toHaveLength(0);
    await t.manager.setName('linux-1', 'Workbench');
    expect(states(t.bridge).at(-1)).toMatchObject({ name: 'Workbench' });
  });

  it('a booting PC shows its progress, then running', async () => {
    const t = await setup();
    await t.manager.start('linux-1');
    const seen = states(t.bridge).map((s) => s.status);
    expect(seen).toContain('booting');
    expect(seen.at(-1)).toBe('running');
    expect(states(t.bridge).find((s) => s.status === 'booting')?.progress).toBeTypeOf('number');
  });
});

describe('frames', () => {
  it('maps pc.view onto tiers (visible with an agent seated gets the seated rate) and acks by slot', async () => {
    const t = await setup();
    t.bridge.fire('pc.view', { pcId: 'linux-1', tier: 'visible' });
    t.bridge.fire('pc.seat', {
      pcId: 'linux-1',
      occupant: { kind: 'agent', agentId: 'ada' },
      seatEpoch: 2,
    });
    t.bridge.fire('pc.view', { pcId: 'linux-1', tier: 'focus' });
    t.bridge.fire('pc.view', { pcId: 'nope', tier: 'focus' });
    t.bridge.fire('pc.frame.ack', { pcId: 'linux-1', seq: 7 });
    expect(t.tiers).toEqual([
      ['linux-1', { mode: 'visible', agentSeated: false }],
      ['linux-1', { mode: 'visible', agentSeated: true }],
      ['linux-1', { mode: 'focus' }],
    ]);
    expect(t.acks).toEqual([[1, 7]]);
    t.bridge.disconnect();
    expect(t.tiers.at(-1)).toEqual(['linux-1', { mode: 'none' }]);
  });

  it("pushes the seated agent's cursor, and hides it when the agent leaves", async () => {
    const t = await setup();
    t.glue.onCursor('linux-1', { x: 5, y: 6 });
    expect(t.bridge.pushed('pc.cursor')).toEqual([]);
    t.bridge.fire('pc.seat', { pcId: 'linux-1', occupant: { kind: 'agent', agentId: 'ada' }, seatEpoch: 2 });
    t.glue.onCursor('linux-1', { x: 5, y: 6 });
    t.glue.onCursor('linux-1', { x: 5, y: 6 });
    t.bridge.fire('pc.unseat', {
      pcId: 'linux-1',
      occupant: { kind: 'agent', agentId: 'ada' },
      reason: 'stand',
      reserved: false,
    });
    expect(t.bridge.pushed('pc.cursor')).toEqual([
      { pcId: 'linux-1', x: 5, y: 6, visible: true },
      { pcId: 'linux-1', x: 5, y: 6, visible: false },
    ]);
  });
});

describe('input and seats', () => {
  it('routes the seated player’s T0 input and drops input from anyone else', async () => {
    const t = await setup();
    const batch = {
      pcId: 'linux-1',
      seq: 1,
      events: [
        { k: 'move' as const, x: 10, y: 20 },
        { k: 'text' as const, text: 'hi' },
      ],
    };
    t.bridge.fire('pc.input', batch);
    await t.router.idle('linux-1');
    expect(t.input).toEqual([]);
    t.bridge.fire('pc.seat', { pcId: 'linux-1', occupant: { kind: 'player' } });
    expect(states(t.bridge).at(-1)?.occupant).toEqual({ kind: 'player' });
    t.bridge.fire('pc.input', { ...batch, seq: 2 });
    await t.router.idle('linux-1');
    expect(t.input).toEqual(['pointer {"move":{"position":{"x":10,"y":20}}}', 'type hi']);
  });

  it('an agent that sits gets its mirror; leaving for good kills its tagged processes and closes it', async () => {
    const t = await setup();
    await t.manager.start('linux-1');
    t.bridge.fire('pc.seat', { pcId: 'linux-1', occupant: { kind: 'agent', agentId: 'ada' }, seatEpoch: 4 });
    expect(t.mirrorLog).toEqual(['open linux-1 ada']);
    // Away (asking the player): the chair stays reserved, nothing is killed.
    t.bridge.fire('pc.unseat', {
      pcId: 'linux-1',
      occupant: { kind: 'agent', agentId: 'ada' },
      reason: 'away',
      reserved: true,
    });
    expect(states(t.bridge).at(-1)).toMatchObject({
      occupant: null,
      reservation: { agentId: 'ada', kind: 'away' },
      banner: 'BRB: asking the player',
    });
    expect(t.killed).toEqual([]);
    t.bridge.fire('pc.seat', { pcId: 'linux-1', occupant: { kind: 'agent', agentId: 'ada' }, seatEpoch: 4 });
    expect(states(t.bridge).at(-1)).toMatchObject({
      occupant: { kind: 'agent', agentId: 'ada' },
      banner: null,
    });
    t.bridge.fire('pc.unseat', {
      pcId: 'linux-1',
      occupant: { kind: 'agent', agentId: 'ada' },
      reason: 'kick',
      reserved: false,
    });
    await tick();
    expect(t.killed).toEqual(['linux-1 ada:4']);
    expect(t.mirrorLog.at(-1)).toBe('close linux-1');
  });

  it('an away agent whose reservation expires is cleaned up too', async () => {
    const t = await setup();
    t.bridge.fire('pc.seat', { pcId: 'linux-1', occupant: { kind: 'agent', agentId: 'ada' }, seatEpoch: 9 });
    t.bridge.fire('pc.unseat', {
      pcId: 'linux-1',
      occupant: { kind: 'agent', agentId: 'ada' },
      reason: 'away',
      reserved: true,
    });
    t.bridge.fire('pc.unseat', {
      pcId: 'linux-1',
      occupant: { kind: 'agent', agentId: 'ada' },
      reason: 'reservation_expired',
      reserved: false,
    });
    await tick();
    expect(t.killed).toEqual(['linux-1 ada:9']);
    expect(states(t.bridge).at(-1)).toMatchObject({ occupant: null, reservation: null });
  });

  it('the player taking an away agent’s chair ends that agent’s seat', async () => {
    const t = await setup();
    await t.manager.start('linux-1');
    t.bridge.fire('pc.seat', { pcId: 'linux-1', occupant: { kind: 'agent', agentId: 'ada' }, seatEpoch: 6 });
    t.bridge.fire('pc.unseat', {
      pcId: 'linux-1',
      occupant: { kind: 'agent', agentId: 'ada' },
      reason: 'away',
      reserved: true,
    });
    t.bridge.fire('pc.seat', { pcId: 'linux-1', occupant: { kind: 'player' } });
    await tick();
    expect(t.killed).toEqual(['linux-1 ada:6']);
    expect(t.mirrorLog).toEqual(['open linux-1 ada', 'close linux-1']);
    expect(states(t.bridge).at(-1)).toMatchObject({ occupant: { kind: 'player' }, reservation: null });
  });

  it('one body, one chair: a seat whose pc.unseat was lost ends when its occupant sits elsewhere', async () => {
    const t = await setup();
    await t.manager.create({ type: 'linux', id: 'linux-2' });
    t.bridge.fire('pc.seat', { pcId: 'linux-1', occupant: { kind: 'player' } });
    t.bridge.fire('pc.seat', { pcId: 'linux-2', occupant: { kind: 'player' } });
    expect(t.seats.playerAt('linux-1')).toBe(false);
    expect(t.router.occupant('linux-1')).toBeNull();
    expect(t.router.occupant('linux-2')).toEqual({ kind: 'player', id: 'player' });
    // Input for the old PC no longer reaches it.
    t.bridge.fire('pc.input', { pcId: 'linux-1', seq: 1, events: [{ k: 'text', text: 'x' }] });
    await t.router.idle('linux-1');
    expect(t.input).toEqual([]);

    t.bridge.fire('pc.seat', { pcId: 'linux-1', occupant: { kind: 'agent', agentId: 'ada' }, seatEpoch: 2 });
    t.bridge.fire('pc.seat', { pcId: 'linux-2', occupant: { kind: 'agent', agentId: 'ada' }, seatEpoch: 3 });
    await tick();
    expect(t.killed).toEqual(['linux-1 ada:2']);
    expect(t.seats.agentAt('linux-1')).toBeNull();
    expect(t.seats.agentAt('linux-2')).toEqual({ agentId: 'ada', seatEpoch: 3 });
  });

  it('a hello from BootScreen ends every seat', async () => {
    const t = await setup();
    t.bridge.fire('pc.seat', { pcId: 'linux-1', occupant: { kind: 'agent', agentId: 'ada' }, seatEpoch: 1 });
    t.bridge.fire('hello', { mod: '0.1.0', mc: '26.3', phase: 'boot' });
    await tick();
    expect(t.killed).toEqual(['linux-1 ada:1']);
    expect(t.seats.agentAt('linux-1')).toBeNull();
  });

  it('a PC that goes down stands its agent up (pc_down)', async () => {
    const t = await setup();
    await t.manager.start('linux-1');
    t.bridge.fire('pc.seat', { pcId: 'linux-1', occupant: { kind: 'agent', agentId: 'ada' }, seatEpoch: 5 });
    await t.manager.stop('linux-1');
    await tick();
    expect(t.bridge.requests).toEqual([
      {
        t: 'agent.unseat',
        payload: { agentId: 'ada', seatEpoch: 5, reason: 'pc_down', keepReservation: false },
      },
    ]);
  });
});

describe('requests', () => {
  it('pc.action create returns the new id at once and boots it in the background', async () => {
    const t = await setup();
    const r = await t.bridge.call('pc.action', {
      action: 'create',
      type: 'linux',
      pos: { x: 1, y: 64, z: 2 },
    });
    expect(r).toEqual({ pcId: 'linux-2' });
    expect(t.manager.get('linux-2')).toBeDefined();
    for (let i = 0; i < 50 && t.manager.status('linux-2').status !== 'running'; i++) await tick(10);
    expect(t.manager.status('linux-2').status).toBe('running');
  });

  it('a create that does not fit shows no_capacity on its monitor', async () => {
    const t = await setup();
    host.memBytes = 20 * GiB;
    const r = await t.bridge.call('pc.action', { action: 'create', type: 'linux' });
    for (let i = 0; i < 50 && t.manager.status(r.pcId as string).status !== 'no_capacity'; i++)
      await tick(10);
    expect(states(t.bridge, r.pcId as string).at(-1)?.status).toBe('no_capacity');
  });

  it('typed errors: unknown PC, over budget, refused mount, nothing to kick or consent', async () => {
    const t = await setup();
    const err = (p: Promise<unknown>) =>
      p.then(
        () => null,
        (e: { code: string }) => e.code,
      );
    expect(await err(t.bridge.call('pc.action', { action: 'start', pcId: 'nope' }))).toBe(
      ERROR_CODES.PC_UNKNOWN,
    );
    expect(await err(t.bridge.call('pc.config', { pcId: 'nope', pinned: true }))).toBe(
      ERROR_CODES.PC_UNKNOWN,
    );
    expect(await err(t.bridge.call('pc.config', { pcId: 'linux-1', memoryMiB: 60 * 1024 }))).toBe(
      ERROR_CODES.OVER_BUDGET,
    );
    expect(
      await err(
        t.bridge.call('pc.config', {
          pcId: 'linux-1',
          mounts: [{ hostPath: join(dir, 'home'), mode: 'rw' }],
        }),
      ),
    ).toBe(ERROR_CODES.BAD_MOUNT);
    expect(await err(t.bridge.call('pc.action', { action: 'kick', pcId: 'linux-1' }))).toBe(
      ERROR_CODES.NOT_READY,
    );
    expect(await err(t.bridge.call('pc.consent', { pcId: 'linux-1', consentId: 'c1', accept: true }))).toBe(
      ERROR_CODES.NOT_READY,
    );
    host.memBytes = 20 * GiB;
    expect(await err(t.bridge.call('pc.action', { action: 'start', pcId: 'linux-1' }))).toBe(
      ERROR_CODES.OVER_BUDGET,
    );
  });

  it('pc.config: name, flags and one recreate for type + resources + mounts', async () => {
    const t = await setup();
    await t.manager.start('linux-1');
    const vault = join(dir, 'Code', 'web');
    mkdirSync(join(vault, '.git'), { recursive: true });
    writeFileSync(join(vault, 'package.json'), '{}');
    t.driver.log.length = 0;
    const r = await t.bridge.call('pc.config', {
      pcId: 'linux-1',
      name: 'Web box',
      pinned: true,
      wipeOnDeath: true,
      type: 'linux-slim',
      cpus: 1,
      memoryMiB: 2048,
      mounts: [{ hostPath: vault, mode: 'rw' }],
    });
    expect(r).toEqual({ recreate: true });
    const pc = t.manager.get('linux-1');
    expect(pc).toMatchObject({
      name: 'Web box',
      pinned: true,
      wipeOnDeath: true,
      type: 'linux-slim',
      cpus: 1,
    });
    // A rw project folder gets the build-dir overlays its markers suggest.
    expect(pc?.mounts).toEqual([{ host: vault, ro: false, overlays: ['node_modules'] }]);
    expect(t.driver.log.filter((l) => l.startsWith('create '))).toHaveLength(1);
    expect(t.manager.status('linux-1').status).toBe('running');
    expect(states(t.bridge).at(-1)).toMatchObject({
      name: 'Web box',
      type: 'linux-slim',
      mounts: [{ hostPath: vault, mode: 'rw' }],
      wipeOnDeath: true,
    });
    expect(await t.bridge.call('pc.config', { pcId: 'linux-1', cpus: 1 })).toEqual({ recreate: false });
  });

  it('pc.config: virtualization recreates the PC, android only starts the phone; pc.state shows both', async () => {
    const t = await setup({ android: true });
    await t.manager.start('linux-1');
    expect(states(t.bridge).at(-1)?.capabilities).toMatchObject({
      virtualization: { enabled: false, unavailable: null },
      android: { enabled: false, unavailable: null, status: 'off' },
    });
    expect(await t.bridge.call('pc.config', { pcId: 'linux-1', virtualization: true })).toEqual({
      recreate: true,
    });
    expect(t.manager.get('linux-1')?.virtualization).toBe(true);
    expect(await t.bridge.call('pc.config', { pcId: 'linux-1', android: true })).toEqual({ recreate: false });
    for (let i = 0; i < 200 && t.manager.phone('linux-1').status !== 'running'; i++) await tick(5);
    expect(states(t.bridge).at(-1)?.capabilities).toMatchObject({
      virtualization: { enabled: true },
      android: { enabled: true, status: 'running' },
    });
    expect(PcInfo.safeParse(states(t.bridge).at(-1)).success).toBe(true);
  });

  it('pc.consent: a first-use download waits for the modal; Download applies the switch, a stale id is NOT_READY', async () => {
    const t = await setup({ android: true, fresh: { kernel: true } });
    await t.manager.start('linux-1');
    expect(await t.bridge.call('pc.config', { pcId: 'linux-1', android: true })).toEqual({ recreate: false });
    const asking = states(t.bridge).at(-1);
    expect(asking?.status).toBe('running');
    expect(asking?.consent).toMatchObject({ what: 'Linux kernel source for linux-1', bytes: 214_000_000 });
    expect(asking?.capabilities?.android.enabled).toBe(false);
    expect(PcInfo.safeParse(asking).success).toBe(true);
    const consentId = asking?.consent?.consentId as string;
    expect(
      await errCode(
        t.bridge.call('pc.consent', { pcId: 'linux-1', consentId: 'dl-0000000000000000', accept: true }),
      ),
    ).toBe(ERROR_CODES.NOT_READY);
    expect(await t.bridge.call('pc.consent', { pcId: 'linux-1', consentId, accept: true })).toEqual({});
    expect(t.manager.get('linux-1')?.android).toBe(true);
    for (let i = 0; i < 200 && t.manager.phone('linux-1').status !== 'running'; i++) await tick(5);
    expect(states(t.bridge).at(-1)).toMatchObject({
      consent: null,
      capabilities: { android: { enabled: true } },
    });
    // Answered: the same id is no longer waiting.
    expect(await errCode(t.bridge.call('pc.consent', { pcId: 'linux-1', consentId, accept: false }))).toBe(
      ERROR_CODES.NOT_READY,
    );
  });

  it('pc.consent: Not now leaves the switch off and clears the prompt', async () => {
    const t = await setup({ android: true, fresh: { kernel: true } });
    await t.manager.start('linux-1');
    await t.bridge.call('pc.config', { pcId: 'linux-1', virtualization: true });
    const consentId = states(t.bridge).at(-1)?.consent?.consentId as string;
    expect(consentId).toBeTruthy();
    expect(await t.bridge.call('pc.consent', { pcId: 'linux-1', consentId, accept: false })).toEqual({});
    expect(t.manager.get('linux-1')).not.toHaveProperty('virtualization');
    expect(states(t.bridge).at(-1)?.consent).toBeNull();
  });

  it('pc.config: a capability this engine cannot have is BAD_MESSAGE with the reason', async () => {
    const t = await setup();
    t.glue.pushAll();
    expect(states(t.bridge).at(-1)?.capabilities?.android.unavailable).toMatch(/Apple container/);
    const e = await t.bridge
      .call('pc.config', { pcId: 'linux-1', android: true })
      .catch((err: unknown) => err);
    expect((e as { code?: string }).code).toBe(ERROR_CODES.BAD_MESSAGE);
    expect(t.manager.get('linux-1')).not.toHaveProperty('android');
  });

  it('kick unseats the agent through the mod; decommission ends with a last decommissioned state', async () => {
    const t = await setup();
    t.bridge.fire('pc.seat', { pcId: 'linux-1', occupant: { kind: 'agent', agentId: 'ada' }, seatEpoch: 3 });
    expect(await t.bridge.call('pc.action', { action: 'kick', pcId: 'linux-1' })).toEqual({
      pcId: 'linux-1',
    });
    expect(t.bridge.requests.at(-1)).toEqual({
      t: 'agent.unseat',
      payload: { agentId: 'ada', seatEpoch: 3, reason: 'kick', keepReservation: false },
    });
    expect(await t.bridge.call('pc.action', { action: 'decommission', pcId: 'linux-1' })).toEqual({
      pcId: 'linux-1',
    });
    expect(t.manager.get('linux-1')).toBeUndefined();
    const last = states(t.bridge).at(-1);
    expect(last).toMatchObject({ status: 'decommissioned', occupant: null });
    expect(PcInfo.safeParse(last).success).toBe(true);
  });

  it('unplug stops the PC; plug starts it again; reissue and watch only acknowledge', async () => {
    const t = await setup();
    await t.manager.start('linux-1');
    await t.bridge.call('pc.action', { action: 'unplug', pcId: 'linux-1' });
    expect(t.manager.get('linux-1')?.plugged).toBe(false);
    expect(t.manager.status('linux-1').status).toBe('off');
    expect(await t.bridge.call('pc.action', { action: 'reissue', pcId: 'linux-1' })).toEqual({
      pcId: 'linux-1',
    });
    await t.bridge.call('pc.action', { action: 'plug', pcId: 'linux-1' });
    for (let i = 0; i < 50 && t.manager.status('linux-1').status !== 'running'; i++) await tick(10);
    expect(t.manager.status('linux-1').status).toBe('running');
    await t.bridge.call('pc.action', { action: 'watch', pcId: 'linux-1' });
    expect(t.glue.isWatching('linux-1')).toBe(true);
    await t.bridge.call('pc.action', { action: 'unwatch', pcId: 'linux-1' });
    expect(t.glue.isWatching('linux-1')).toBe(false);
  });

  it("host.pick_folder opens the picker with T0's prompt as the title", async () => {
    const t = await setup();
    expect(
      await t.bridge.call('host.pick_folder', {
        purpose: 'vault',
        pcId: 'linux-1',
        prompt: 'Choose a folder for linux-1',
      }),
    ).toEqual({ path: '/Users/me/Code/picked' });
    expect(t.picks[0]).toMatchObject({ title: 'Choose a folder for linux-1', button: 'Add to Vault' });
    await t.bridge.call('host.pick_folder', { purpose: 'vault' });
    expect(t.picks[1]).toMatchObject({ title: 'Choose a folder' });
  });
});
