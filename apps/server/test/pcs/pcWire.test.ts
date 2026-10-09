import { Budget, ERROR_CODES, PcInfo } from '@minevibe/protocol';
import { describe, expect, it } from 'vitest';
import type { HostDialogs } from '../../src/app/StubChannel.js';
import { BridgeError } from '../../src/bridge/BridgeServer.js';
import { computeBudget, defaultBudgetSettings, GiB } from '../../src/pcs/Budget.js';
import { EngineError } from '../../src/pcs/drivers/ContainerRuntime.js';
import type { ExecFn } from '../../src/pcs/drivers/exec.js';
import { cleanPickedPath, createFolderPicker, OSASCRIPT_ARGS } from '../../src/pcs/folderPicker.js';
import { PcError, type PcRecord, type PcView } from '../../src/pcs/PcManager.js';
import {
  decommissionedInfo,
  seatBanner,
  toBridgeError,
  toPcInfo,
  toWireBudget,
} from '../../src/pcs/pcWire.js';
import { SeatBook, seatTag, tagAgent } from '../../src/pcs/SeatBook.js';

const view: PcView = {
  pcId: 'linux-1',
  slot: 1,
  type: 'linux',
  status: 'booting',
  progress: 40,
  detail: 'waiting for spacesd\nstill',
  cpus: 2,
  memMb: 4096,
  mounts: [
    { host: '/Users/me/Code/foo', ro: false },
    { host: '/Users/me/notes', ro: true },
  ],
  plugged: true,
  pinned: false,
  display: [1280, 800],
};
const rec = {
  id: 'linux-1',
  slot: 1,
  type: 'linux',
  cpus: 2,
  memMiB: 4096,
  shmMiB: 2048,
  disk: { homeGiB: 32, overlayGiB: 16, tmpGiB: 8, varTmpGiB: 4, rootfsGiB: 24 },
  mounts: [],
  pinned: false,
  plugged: true,
  createdAt: 0,
  name: 'Workbench',
  wipeOnDeath: true,
} as PcRecord;

describe('pc.state (PcInfo)', () => {
  it('maps a PcManager view onto a schema-valid PcInfo', () => {
    const seats = new SeatBook();
    seats.seat('linux-1', { kind: 'agent', agentId: 'ada', seatEpoch: 3 });
    const info = toPcInfo(view, rec, { seat: seats.get('linux-1'), diskGiB: 68 });
    expect(PcInfo.parse(info)).toEqual(info);
    expect(info).toMatchObject({
      name: 'Workbench',
      status: 'booting',
      progress: 0.4,
      detail: 'waiting for spacesd still',
      memoryMiB: 4096,
      diskGiB: 68,
      wipeOnDeath: true,
      mounts: [
        { hostPath: '/Users/me/Code/foo', mode: 'rw' },
        { hostPath: '/Users/me/notes', mode: 'ro' },
      ],
      occupant: { kind: 'agent', agentId: 'ada' },
      reservation: null,
      screen: { w: 1280, h: 800 },
      consent: null,
    });
  });

  it('carries the away reservation and has no progress outside downloading/booting', () => {
    const seats = new SeatBook();
    seats.seat('linux-1', { kind: 'agent', agentId: 'ada', seatEpoch: 3 });
    seats.unseat('linux-1', { kind: 'agent', agentId: 'ada' }, true);
    const info = toPcInfo({ ...view, status: 'running' }, { ...rec, name: undefined } as PcRecord, {
      seat: seats.get('linux-1'),
      diskGiB: 0,
    });
    expect(info).toMatchObject({
      name: 'linux-1',
      progress: null,
      occupant: null,
      reservation: { agentId: 'ada', kind: 'away' },
      diskGiB: 1,
    });
    expect(PcInfo.safeParse(info).success).toBe(true);
    const gone = decommissionedInfo(info as PcInfo);
    expect(gone).toMatchObject({ status: 'decommissioned', reservation: null, occupant: null });
    expect(PcInfo.safeParse(gone).success).toBe(true);
  });

  it('carries the download prompt only while the PC awaits consent', () => {
    const consent = {
      consentId: 'macos-image-0a1b',
      what: 'macOS 26 image',
      bytes: 23.8e9,
      freeBytes: 300e9,
    };
    const mac = {
      ...view,
      pcId: 'mac-1',
      type: 'macos' as const,
      status: 'awaiting_consent' as const,
      consent,
    };
    const info = toPcInfo(mac, { ...rec, id: 'mac-1', type: 'macos' } as PcRecord, {
      seat: new SeatBook().get('mac-1'),
      diskGiB: 40,
    });
    expect(info?.consent).toEqual(consent);
    expect(PcInfo.safeParse(info).success).toBe(true);
    const later = toPcInfo(
      { ...mac, status: 'downloading' },
      { ...rec, id: 'mac-1', type: 'macos' } as PcRecord,
      {
        seat: new SeatBook().get('mac-1'),
        diskGiB: 40,
      },
    );
    expect(later?.consent).toBeNull();
  });

  it('has no wire form for a windows PC', () => {
    expect(
      toPcInfo({ ...view, type: 'windows' }, rec, { seat: new SeatBook().get('x'), diskGiB: 1 }),
    ).toBeNull();
  });

  it('shows "BRB: asking <player>" while the agent walked over to ask (away reservation only)', () => {
    const away = { occupant: null, reservation: { agentId: 'bram', kind: 'away' as const } };
    expect(seatBanner(away, 'Jordan', 'bram')).toBe('BRB: asking Jordan');
    expect(seatBanner(away, null, 'bram')).toBe('BRB: asking the player');
    // An away reservation of a meeting pull (no pc.unseat{away}) shows nothing.
    expect(seatBanner(away, 'Jordan', null)).toBeNull();
    expect(
      seatBanner({ occupant: null, reservation: { agentId: 'bram', kind: 'coming' } }, 'Jordan', 'bram'),
    ).toBeNull();
    expect(
      seatBanner(
        { occupant: { kind: 'agent', agentId: 'bram', seatEpoch: 1 }, reservation: null },
        'Jordan',
        'bram',
      ),
    ).toBeNull();
    const info = toPcInfo(view, rec, { seat: away, diskGiB: 68, banner: seatBanner(away, 'Jordan', 'bram') });
    expect(info?.banner).toBe('BRB: asking Jordan');
    expect(PcInfo.safeParse(info).success).toBe(true);
  });
});

describe('budget.state', () => {
  it('maps the budget onto the schema', () => {
    const state = computeBudget(
      { cpus: 18, memBytes: 48 * GiB, diskFreeBytes: 199 * GiB },
      defaultBudgetSettings(),
      [{ id: 'linux-1', family: 'linux', cpus: 2, memMiB: 4096, cpuOverhead: 1, active: true, diskGiB: 68 }],
    );
    const b = toWireBudget(state, { crewCap: 4, cpuOvercommit: 1.5 });
    expect(Budget.parse(b)).toEqual(b);
    expect(b).toMatchObject({
      cpu: { total: 14, used: 3, maxOvercommit: 1.5 },
      memoryMiB: { pool: 24.5 * 1024, used: 4096 + 256 },
      diskFreeGiB: 199,
      macos: { running: 0, max: 2 },
      crewCap: 4,
    });
  });
});

describe('typed PC errors', () => {
  it('maps PcManager failures to the protocol codes', () => {
    const code = (e: unknown, kind: Parameters<typeof toBridgeError>[1] = 'action') =>
      toBridgeError(e, kind).code;
    expect(code(new PcError('OVER_BUDGET', 'x'), 'create')).toBe(ERROR_CODES.NO_CAPACITY);
    expect(code(new PcError('OVER_BUDGET', 'x'), 'config')).toBe(ERROR_CODES.OVER_BUDGET);
    expect(code(new PcError('MACOS_SLOTS', 'x'))).toBe(ERROR_CODES.MACOS_SLOTS_FULL);
    expect(code(new PcError('PATH_REFUSED', 'x'), 'config')).toBe(ERROR_CODES.BAD_MOUNT);
    expect(code(new PcError('UNKNOWN_PC', 'x'))).toBe(ERROR_CODES.PC_UNKNOWN);
    expect(code(new PcError('ENGINE_DOWN', 'x'))).toBe(ERROR_CODES.ENGINE_DOWN);
    expect(code(new EngineError('ENGINE_FOREIGN', 'x'))).toBe(ERROR_CODES.ENGINE_DOWN);
    expect(code(new PcError('UNAVAILABLE', 'x'), 'config')).toBe(ERROR_CODES.BAD_MESSAGE);
    expect(code(new PcError('UNAVAILABLE', 'x'), 'start')).toBe(ERROR_CODES.NO_CAPACITY);
    expect(code(new PcError('INVALID', 'x'))).toBe(ERROR_CODES.BAD_MESSAGE);
    expect(code(new Error('boom'))).toBe(ERROR_CODES.INTERNAL);
    const same = new BridgeError('RESERVED', 'r');
    expect(toBridgeError(same, 'action')).toBe(same);
    expect(toBridgeError(new PcError('OVER_BUDGET', 'not enough memory'), 'start').message).toBe(
      'not enough memory',
    );
  });
});

describe('SeatBook', () => {
  it('tracks seats, moves an agent, ignores stale unseats and keeps the away reservation', () => {
    const seats = new SeatBook();
    const changes: string[] = [];
    seats.on('change', (pcId, now) => {
      changes.push(`${pcId}:${now.occupant?.kind ?? '-'}:${now.reservation?.kind ?? '-'}`);
    });
    seats.seat('a', { kind: 'agent', agentId: 'ada', seatEpoch: 1 });
    seats.seat('b', { kind: 'agent', agentId: 'ada', seatEpoch: 2 });
    expect(seats.agentAt('a')).toBeNull();
    expect(seats.pcOfAgent('ada')).toBe('b');
    expect(seats.unseat('b', { kind: 'agent', agentId: 'bram' }, false)).toBeNull();
    expect(seats.unseat('b', { kind: 'agent', agentId: 'ada' }, true)).toMatchObject({
      agentId: 'ada',
    });
    expect(seats.get('b').reservation).toEqual({ agentId: 'ada', kind: 'away' });
    // The reservation of an agent that is no longer seated is released by its own unseat.
    seats.unseat('b', { kind: 'agent', agentId: 'ada' }, false);
    expect(seats.get('b')).toEqual({ occupant: null, reservation: null });
    seats.seat('a', { kind: 'player' });
    expect(seats.playerAt('a')).toBe(true);
    seats.clear();
    expect(seats.playerAt('a')).toBe(false);
    expect(changes).toEqual(['a:agent:-', 'a:-:-', 'b:agent:-', 'b:-:away', 'b:-:-', 'a:player:-', 'a:-:-']);
  });

  it('formats and parses seat tags', () => {
    expect(seatTag('ada', 7)).toBe('ada:7');
    expect(seatTag('ada', null)).toBe('ada:0');
    expect(tagAgent('ada:7')).toBe('ada');
    expect(tagAgent('my-agent:12')).toBe('my-agent');
    expect(tagAgent('ada')).toBeNull();
    expect(tagAgent('ada:x')).toBeNull();
  });
});

describe('host.pick_folder', () => {
  it('cleans picked paths', () => {
    expect(cleanPickedPath('/Users/me/Code/foo/\n')).toBe('/Users/me/Code/foo');
    expect(cleanPickedPath('/')).toBe('/');
    expect(cleanPickedPath('relative')).toBeNull();
    expect(cleanPickedPath(null)).toBeNull();
    expect(cleanPickedPath(`/${'x'.repeat(2000)}`)).toBeNull();
  });

  it("asks the stub with T0's prompt as the panel title (not its button label)", async () => {
    const asked: unknown[] = [];
    const dialogs: HostDialogs = {
      pickFolder: async (o) => {
        asked.push(o);
        return '/Users/me/Code/foo/';
      },
    };
    const pick = createFolderPicker({ mode: 'app', dialogs });
    expect(await pick({ title: 'Choose a folder for linux-1', button: 'Add to Vault' })).toBe(
      '/Users/me/Code/foo',
    );
    expect(asked).toEqual([
      expect.objectContaining({ title: 'Choose a folder for linux-1', prompt: 'Add to Vault' }),
    ]);
  });

  it('falls back to osascript in dev (title as argv, cancel = null)', async () => {
    const calls: { file: string; args: readonly string[] }[] = [];
    let answer = { code: 0, stdout: '/Users/me/Code/bar/\n' };
    const exec: ExecFn = async (file, args) => {
      calls.push({ file, args });
      return { ...answer, signal: null, stderr: '', ms: 1, timedOut: false };
    };
    const pick = createFolderPicker({ mode: 'dev', platform: 'darwin', exec });
    expect(await pick({ title: 'Pick "it"' })).toBe('/Users/me/Code/bar');
    expect(calls[0]).toEqual({ file: '/usr/bin/osascript', args: [...OSASCRIPT_ARGS, 'Pick "it"'] });
    // A folder name may end in a space: only osascript's line break is cut.
    answer = { code: 0, stdout: '/Users/me/Code/Spaced /\n' };
    expect(await pick({ title: 'x' })).toBe('/Users/me/Code/Spaced ');
    answer = { code: 0, stdout: '\n' };
    expect(await pick({ title: 'x' })).toBeNull();
    answer = { code: 1, stdout: '' };
    expect(await pick({ title: 'x' })).toBeNull();
  });

  it('answers cancelled in the app without a stub, and off macOS', async () => {
    let ran = false;
    const exec: ExecFn = async () => {
      ran = true;
      return { code: 0, signal: null, stdout: '/x', stderr: '', ms: 1, timedOut: false };
    };
    expect(await createFolderPicker({ mode: 'app', exec })({ title: 'x' })).toBeNull();
    expect(await createFolderPicker({ mode: 'dev', platform: 'linux', exec })({ title: 'x' })).toBeNull();
    expect(ran).toBe(false);
  });
});
