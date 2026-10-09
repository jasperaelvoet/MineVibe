/**
 * Element refs (PC tools V2 §4.5): `ui find` / `ui tree` name each element `ref_N`, so the agent can act on it with
 * `ui_act` or pass it as `ref` to the click tools instead of a coordinate. A ref remembers the snapshot it came from;
 * spacesd says when that snapshot expired (the window changed), and a closed window or a new seat drops its refs.
 */

import type { Rect } from '../../../contracts/PcApi.js';

export interface RefEntry {
  readonly ref: string;
  readonly pcId: string;
  readonly snapshotId: string;
  readonly elementId: string;
  readonly windowId: string | null;
  readonly windowTitle: string;
  readonly role: string;
  readonly name?: string | undefined;
  /** Screen pixels, when the element had a box. */
  readonly bounds?: Rect | undefined;
  readonly actions: readonly string[];
  readonly states: readonly string[];
}

/** Refs remembered per agent (older ones expire first). */
const KEEP = 2_000;

export class RefBook {
  #n = 0;
  readonly #refs = new Map<string, RefEntry>();

  add(entry: Omit<RefEntry, 'ref'>): RefEntry {
    const ref = `ref_${++this.#n}`;
    const full = { ...entry, ref };
    this.#refs.set(ref, full);
    while (this.#refs.size > KEEP) {
      const oldest = this.#refs.keys().next().value as string;
      this.#refs.delete(oldest);
    }
    return full;
  }

  get(ref: string): RefEntry | undefined {
    return this.#refs.get(ref.trim());
  }

  /** Points a ref at the same element in a newer snapshot (spacesd keeps one live snapshot per window). */
  update(ref: string, fresh: Pick<RefEntry, 'snapshotId' | 'elementId' | 'bounds'>): RefEntry | undefined {
    const cur = this.#refs.get(ref);
    if (!cur) return undefined;
    const { bounds: _old, ...rest } = cur;
    const next: RefEntry = {
      ...rest,
      snapshotId: fresh.snapshotId,
      elementId: fresh.elementId,
      ...(fresh.bounds ? { bounds: fresh.bounds } : {}),
    };
    this.#refs.set(ref, next);
    return next;
  }

  /** Whether `ref` was ever handed out (an expired one, as opposed to a made-up one). */
  issued(ref: string): boolean {
    const m = /^ref_(\d+)$/.exec(ref.trim());
    return m !== null && Number(m[1]) <= this.#n && Number(m[1]) > 0;
  }

  /** Drops the refs of a window that closed. */
  dropWindow(windowId: string): void {
    for (const [k, v] of this.#refs) if (v.windowId === windowId) this.#refs.delete(k);
  }

  /** Drops every ref (a new seat). Numbers keep counting, so an old ref never names a new element. */
  clear(): void {
    this.#refs.clear();
  }
}
