import { type Budget, ERROR_CODES, type PcInfo, type PcStatus, type VaultMount } from '@minevibe/protocol';
import { BridgeError } from '../bridge/BridgeServer.js';
import { type BudgetState, GiB, MiB } from './Budget.js';
import { EngineError } from './drivers/ContainerRuntime.js';
import { PcError, type PcRecord, type PcView } from './PcManager.js';
import type { SeatState } from './SeatBook.js';

/**
 * PcManager's views as the PC messages of the wire protocol (protocol §7.7): `pc.state` (`PcInfo`), `budget.state`
 * (`Budget`) and the `err` codes of `pc.config` / `pc.action`. Pure functions; the bridge glue sends the results.
 */

const clampInt = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.round(v)));
const nonNeg = (v: number) => Math.max(0, Math.round(Number.isFinite(v) ? v : 0));

function clip(text: string | undefined, max: number): string | null {
  if (text === undefined) return null;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this strips
  const t = text.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  if (t.length === 0) return null;
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

export interface PcInfoExtras {
  /** Seat state from the mod's `pc.seat` / `pc.unseat`. */
  readonly seat: SeatState;
  /** Sum of the PC's disk caps. */
  readonly diskGiB: number;
  /** Measured guest screen size, when known. */
  readonly screen?: { w: number; h: number } | null;
  readonly banner?: string | null;
}

/**
 * The monitor banner of a PC whose agent walked over to ask the player: "BRB: asking <player>" (PLAN §6.3/§6.4; USER
 * DECISION 2026-10-08 keeps this walk only for a player who is not near). `askingAgent` is the agent that left with
 * `pc.unseat{away}` (an `away` reservation also covers a meeting pull, which shows no banner).
 */
export function seatBanner(
  seat: SeatState,
  playerName: string | null,
  askingAgent: string | null,
): string | null {
  if (seat.occupant !== null || seat.reservation?.kind !== 'away') return null;
  if (askingAgent === null || seat.reservation.agentId !== askingAgent) return null;
  return `BRB: asking ${playerName ?? 'the player'}`;
}

/** One PC as `pc.state` sends it; null for a PC type the protocol has no name for (`windows`). */
export function toPcInfo(view: PcView, rec: PcRecord, extras: PcInfoExtras): PcInfo | null {
  if (view.type === 'windows') return null;
  const progress =
    (view.status === 'booting' || view.status === 'downloading') && view.progress !== undefined
      ? Math.min(1, Math.max(0, view.progress / 100))
      : null;
  const occupant = extras.seat.occupant;
  const mounts: VaultMount[] = view.mounts.slice(0, 16).map((m) => ({
    hostPath: m.host.length > 1024 ? m.host.slice(0, 1024) : m.host,
    mode: m.ro ? 'ro' : 'rw',
  }));
  const [w, h] = view.display;
  return {
    pcId: view.pcId,
    type: view.type,
    name: clip(rec.name ?? rec.id, 32) ?? rec.id.slice(0, 32),
    status: view.status as PcStatus,
    progress,
    detail: clip(view.detail, 256),
    slot: view.slot >>> 0,
    cpus: clampInt(view.cpus, 1, 64),
    memoryMiB: clampInt(view.memMb, 256, 1_048_576),
    diskGiB: clampInt(extras.diskGiB, 1, 16_384),
    plugged: view.plugged,
    pinned: view.pinned,
    wipeOnDeath: rec.wipeOnDeath === true,
    mounts,
    occupant:
      occupant === null
        ? null
        : occupant.kind === 'player'
          ? { kind: 'player' }
          : { kind: 'agent', agentId: occupant.agentId },
    reservation: extras.seat.reservation
      ? { agentId: extras.seat.reservation.agentId, kind: extras.seat.reservation.kind }
      : null,
    banner: clip(extras.banner ?? undefined, 80),
    screen: extras.screen
      ? { w: clampInt(extras.screen.w, 1, 65_535), h: clampInt(extras.screen.h, 1, 65_535) }
      : { w: clampInt(w, 1, 65_535), h: clampInt(h, 1, 65_535) },
    consent: null,
  };
}

/** The last state of a deleted PC: the mod drops its texture and shows the workstation as empty. */
export function decommissionedInfo(last: PcInfo): PcInfo {
  return {
    ...last,
    status: 'decommissioned',
    progress: null,
    detail: null,
    occupant: null,
    reservation: null,
    banner: null,
    consent: null,
  };
}

/** PcManager's budget as `budget.state`. */
export function toWireBudget(b: BudgetState, settings: { crewCap: number; cpuOvercommit: number }): Budget {
  return {
    cpu: {
      total: nonNeg(b.pool.cpus),
      used: nonNeg(b.allocated.cpus),
      free: Math.round(b.free.cpus),
      maxOvercommit: Math.min(4, Math.max(1, settings.cpuOvercommit)),
    },
    memoryMiB: {
      pool: nonNeg(b.pool.memBytes / MiB),
      used: nonNeg(b.allocated.memBytes / MiB),
      free: Math.round(b.free.memBytes / MiB),
    },
    diskFreeGiB: nonNeg(Math.floor(b.host.diskFreeBytes / GiB)),
    macos: { running: nonNeg(b.allocated.macosRunning), max: nonNeg(b.macosMaxRunning) },
    crewCap: nonNeg(settings.crewCap),
  };
}

/** What a PC request was doing when it failed (`create` refusals are `NO_CAPACITY`, edits `OVER_BUDGET`). */
export type PcRequestKind = 'create' | 'start' | 'config' | 'action';

/** A PcManager failure as the typed `err` of a PC request (protocol §7.7). */
export function toBridgeError(err: unknown, kind: PcRequestKind): BridgeError {
  if (err instanceof BridgeError) return err;
  const msg = (err instanceof Error ? err.message : String(err)).slice(0, 2000);
  if (err instanceof EngineError) return new BridgeError(ERROR_CODES.ENGINE_DOWN, msg);
  if (!(err instanceof PcError)) return new BridgeError(ERROR_CODES.INTERNAL, msg);
  switch (err.code) {
    case 'OVER_BUDGET':
      return new BridgeError(kind === 'create' ? ERROR_CODES.NO_CAPACITY : ERROR_CODES.OVER_BUDGET, msg);
    case 'MACOS_SLOTS':
      return new BridgeError(ERROR_CODES.MACOS_SLOTS_FULL, msg);
    case 'PATH_REFUSED':
      return new BridgeError(ERROR_CODES.BAD_MOUNT, msg);
    case 'UNKNOWN_PC':
      return new BridgeError(ERROR_CODES.PC_UNKNOWN, msg);
    case 'ENGINE_DOWN':
      return new BridgeError(ERROR_CODES.ENGINE_DOWN, msg);
    case 'UNAVAILABLE':
      // A type this Mac cannot run (or not yet: macOS arrives with M9), or a type change across families.
      return new BridgeError(kind === 'config' ? ERROR_CODES.BAD_MESSAGE : ERROR_CODES.NO_CAPACITY, msg);
    case 'INVALID':
      return new BridgeError(ERROR_CODES.BAD_MESSAGE, msg);
    case 'BUSY':
      return new BridgeError(ERROR_CODES.BUSY, msg);
  }
}
