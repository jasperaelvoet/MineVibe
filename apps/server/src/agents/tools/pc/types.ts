import type { PcApi } from '../../../contracts/PcApi.js';
import type { HandoffNotes } from '../../memory.js';
import type { PlanCapture } from '../../PlanCapture.js';
import type { PcToolName } from '../catalog.js';
import type { BatchBook } from './batch.js';
import type { SettleTiming } from './context.js';
import type { PcJobBook } from './jobs.js';

/** What the `pc` tool server needs from the agent it serves. */
export interface PcHost {
  readonly agentId: string;
  readonly pcs: PcApi;
  readonly plans: PlanCapture;
  readonly handoffs: HandoffNotes;
  /**
   * The PC and seat epoch this call may use, or null (not seated, or the seat changed since the gate allowed it); the
   * gate's tool_use id of the call when the host knows it.
   */
  access(
    tool: PcToolName,
  ): { readonly pcId: string; readonly epoch: number; readonly toolUseId?: string } | null;
  /** Display name for handoff notes. */
  authorName(): string;
  /** The player's name (teaching errors). */
  playerName?(): string;
  /**
   * The batch book fed from this agent's stream (which `pc` calls each assistant message made); default the server's
   * own, which knows no messages (every computer action then counts as the last of its batch).
   */
  readonly batch?: BatchBook | undefined;
  /**
   * Background jobs this agent started (ownership and their task notifications), kept by the brain so a session
   * restart keeps them; default a book of this tool server's own.
   */
  readonly jobs?: PcJobBook | undefined;
  /** Subscribes to compactions (the agent no longer has what it read and saw). */
  onCompaction?(listener: () => void): void;
  /** A foreground `bash` command finished (the DESK REPORT lists the last exit codes). */
  onCommand?(record: { readonly pcId: string; readonly command: string; readonly exitCode: number }): void;
  /** `write` or `edit` changed a file (the DESK REPORT lists them). */
  onFileChanged?(record: { readonly pcId: string; readonly path: string }): void;
  /** Screen settle timing (tests shorten it). */
  readonly settle?: Partial<SettleTiming> | undefined;
}
