/**
 * Shared pieces of the contracts between server modules (`apps/server/src/contracts`). The contracts let tracks build
 * against each other in parallel: each module implements one interface and depends only on the others' interfaces,
 * and tests use the `Fake*` implementations.
 */

import type { EventMap, Listener } from '../util/TypedEmitter.js';

/**
 * A failed contract call. `code` is a stable SCREAMING_SNAKE_CASE code: one of the protocol's `ERROR_CODES` when the
 * failure is reported to the mod (`CARD_GONE`, `FORBIDDEN`, `CODEX_CONFLICT`, ...), or a module-local code (the PcApi
 * codes below). `message` is a one-line hint fit for an agent or the player.
 */
export class ApiError extends Error {
  readonly code: string;
  /** Extra machine-readable details (e.g. the current revision on `CODEX_CONFLICT`). */
  readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.details = details;
  }
}

export function isApiError(err: unknown, code?: string): err is ApiError {
  return err instanceof ApiError && (code === undefined || err.code === code);
}

/** Something that emits typed events; `on` returns an unsubscribe function. */
export interface Subscribable<E extends EventMap> {
  on<K extends keyof E>(event: K, listener: Listener<E[K]>): () => void;
}

/** Who performs an action; rights (CEO only, player-only `rules` pages, ...) are checked against it. */
export type Actor =
  | { readonly kind: 'player' }
  | { readonly kind: 'agent'; readonly agentId: string; readonly ceo: boolean };

export const PLAYER: Actor = Object.freeze({ kind: 'player' });

export function agentActor(agentId: string, ceo = false): Actor {
  return { kind: 'agent', agentId, ceo };
}
