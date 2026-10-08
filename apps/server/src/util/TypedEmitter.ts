/** Event name -> listener argument tuple. */
export type EventMap = { [event: string]: unknown[] };

export type Listener<A extends unknown[]> = (...args: A) => void | Promise<void>;

/**
 * A small, strictly typed event emitter. Listener errors (sync throws and rejected promises) are routed
 * to {@link TypedEmitter.onListenerError} instead of propagating into the emitter, so one bad listener
 * can never take down the bridge.
 */
export class TypedEmitter<E extends EventMap> {
  readonly #listeners = new Map<keyof E, Set<Listener<never[]>>>();

  /** Subscribes; returns an unsubscribe function. */
  on<K extends keyof E>(event: K, listener: Listener<E[K]>): () => void {
    let set = this.#listeners.get(event);
    if (!set) {
      set = new Set();
      this.#listeners.set(event, set);
    }
    set.add(listener as unknown as Listener<never[]>);
    return () => this.off(event, listener);
  }

  /** Subscribes for a single emission. */
  once<K extends keyof E>(event: K, listener: Listener<E[K]>): () => void {
    const off = this.on(event, ((...args: E[K]) => {
      off();
      return listener(...args);
    }) as Listener<E[K]>);
    return off;
  }

  off<K extends keyof E>(event: K, listener: Listener<E[K]>): void {
    const set = this.#listeners.get(event);
    if (!set) return;
    set.delete(listener as unknown as Listener<never[]>);
    if (set.size === 0) this.#listeners.delete(event);
  }

  listenerCount(event: keyof E): number {
    return this.#listeners.get(event)?.size ?? 0;
  }

  removeAllListeners(): void {
    this.#listeners.clear();
  }

  /** Calls every listener of `event` in subscription order. Returns whether any listener ran. */
  protected emit<K extends keyof E>(event: K, ...args: E[K]): boolean {
    const set = this.#listeners.get(event);
    if (!set || set.size === 0) return false;
    for (const listener of [...set]) {
      try {
        const result = (listener as unknown as Listener<E[K]>)(...args);
        if (result && typeof result.then === 'function') {
          result.then(undefined, (err: unknown) => this.onListenerError(String(event), err));
        }
      } catch (err) {
        this.onListenerError(String(event), err);
      }
    }
    return true;
  }

  /** Override to log listener failures. */
  protected onListenerError(_event: string, _error: unknown): void {}
}
