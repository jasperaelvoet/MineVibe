import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { SpacesdClientLike } from '@trycua/cua';
import type { Logger } from 'pino';
import { withDeadline } from './deadline.js';

/**
 * One `@trycua/cua` spacesd client per PC (PLAN §3, §8.6).
 *
 * - `@trycua/cua` is imported lazily, after `DO_NOT_TRACK=1`, `CUA_TELEMETRY=0` and
 *   `CUA_HOME=<Caches>/cua` are set (otherwise `embedded()` writes `~/.cua` and may send telemetry).
 *   Only type imports of the package are allowed anywhere else.
 * - Readiness means `health().status === "HEALTH_STATUS_SERVING"`; `health()` also resolves while
 *   spacesd reports NOT_SERVING (S5).
 * - A transport failure drops the client; the next call reconnects.
 * - Every connect and call has a deadline (H3): the promise rejects at the deadline even when the native
 *   call ignores its AbortSignal, so a hung guest never blocks a caller. A connect that completes after
 *   its deadline is released at once (N6): nobody holds that client.
 */

/** Frees a native client nobody will use (best effort; the `Like` interface has no close). */
export function releaseClient(c: unknown): void {
  try {
    (c as { uniffiDestroy?: () => void } | null)?.uniffiDestroy?.();
  } catch {
    // already gone
  }
}

/** The parts of the `@trycua/cua` module MineVibe uses. */
export interface CuaModule {
  embedded(config?: Record<string, unknown>): {
    spacesd(
      url: string,
      token: string | undefined,
      opts?: { signal: AbortSignal },
    ): Promise<SpacesdClientLike>;
  };
  ImageFormat: { Png: number; Jpeg: number; Webp: number };
  telemetrySetEnabled?: (enabled: boolean) => unknown;
}

export const CUA_VERSION = '0.4.1';

/** Sets the cua environment (must run before the first import of `@trycua/cua`). Returns CUA_HOME. */
export function configureCuaEnv(cachesDir: string, env: NodeJS.ProcessEnv = process.env): string {
  const home = join(cachesDir, 'cua');
  env.DO_NOT_TRACK = '1';
  env.CUA_TELEMETRY = '0';
  env.CUA_HOME = home;
  return home;
}

let cuaModule: Promise<CuaModule> | null = null;

/** Loads `@trycua/cua` once, with telemetry off and its state under MineVibe's caches. */
export function loadCua(cachesDir: string): Promise<CuaModule> {
  cuaModule ??= (async () => {
    const home = configureCuaEnv(cachesDir);
    await mkdir(home, { recursive: true, mode: 0o700 });
    const mod = (await import('@trycua/cua')) as unknown as CuaModule;
    try {
      mod.telemetrySetEnabled?.(false);
    } catch {
      // telemetry toggles never fail startup
    }
    return mod;
  })();
  return cuaModule;
}

export interface HealthComponent {
  name: string;
  status: string;
  detail?: string;
}

export interface HealthReport {
  status: string;
  components: HealthComponent[];
  serving: boolean;
}

export const HEALTH_SERVING = 'HEALTH_STATUS_SERVING';

/** Parses spacesd's proto3-JSON `Health`. */
export function parseHealth(json: string): HealthReport {
  const h = JSON.parse(json) as { status?: string; components?: HealthComponent[] };
  const status = h.status ?? 'HEALTH_STATUS_UNKNOWN';
  return {
    status,
    components: (h.components ?? []).map((c) => ({
      name: c.name,
      status: c.status,
      ...(c.detail ? { detail: c.detail } : {}),
    })),
    serving: status === HEALTH_SERVING,
  };
}

/** Boot progress from the component list (`booting%`): serving components / all, capped below 100. */
export function readinessPercent(h: HealthReport): number {
  if (h.serving) return 100;
  const total = Math.max(h.components.length, 3);
  const ok = h.components.filter((c) => c.status === HEALTH_SERVING).length;
  return Math.min(95, Math.round(25 + (ok / total) * 70));
}

const TRANSPORT_RE =
  /connect|transport|unavailable|refused|reset|closed|broken pipe|eof|timed? ?out|deadline|socket|network|hang ?up/i;

export function isTransportError(err: unknown): boolean {
  const msg = err instanceof Error ? `${err.name} ${err.message}` : String(err);
  return TRANSPORT_RE.test(msg);
}

export interface PcEndpoint {
  url: string;
  token: string;
}

export interface SpacesdPoolOptions {
  cachesDir: string;
  logger?: Logger;
  /** Replaces the `@trycua/cua` loader (tests). */
  loader?: () => Promise<CuaModule>;
  connectTimeoutMs?: number;
  healthTimeoutMs?: number;
  /** Default deadline for {@link SpacesdPool.call}. */
  callTimeoutMs?: number;
}

interface Entry {
  endpoint: PcEndpoint;
  client: Promise<SpacesdClientLike> | null;
  generation: number;
}

export class SpacesdPool {
  readonly #entries = new Map<string, Entry>();
  readonly #loader: () => Promise<CuaModule>;
  readonly #log: Logger | undefined;
  readonly #connectTimeoutMs: number;
  readonly #healthTimeoutMs: number;
  readonly #callTimeoutMs: number;
  #module: CuaModule | null = null;
  #lateConnects = 0;

  constructor(options: SpacesdPoolOptions) {
    this.#loader = options.loader ?? (() => loadCua(options.cachesDir));
    this.#log = options.logger;
    this.#connectTimeoutMs = options.connectTimeoutMs ?? 5_000;
    this.#healthTimeoutMs = options.healthTimeoutMs ?? 5_000;
    this.#callTimeoutMs = options.callTimeoutMs ?? 10_000;
  }

  /** Connects that completed after their deadline and were released (N6). */
  get lateConnects(): number {
    return this.#lateConnects;
  }

  /** Loads the cua module (idempotent) and returns it. */
  async module(): Promise<CuaModule> {
    this.#module ??= await this.#loader();
    return this.#module;
  }

  /** `ImageFormat.Jpeg` of the loaded module (load first). */
  get jpegFormat(): number {
    if (!this.#module) throw new Error('SpacesdPool: cua module not loaded');
    return this.#module.ImageFormat.Jpeg;
  }

  /** `ImageFormat.Png` of the loaded module (load first). */
  get pngFormat(): number {
    if (!this.#module) throw new Error('SpacesdPool: cua module not loaded');
    return this.#module.ImageFormat.Png;
  }

  /** Sets (or replaces) a PC's endpoint. A changed URL or token drops the old client. */
  register(pcId: string, endpoint: PcEndpoint): void {
    const cur = this.#entries.get(pcId);
    if (cur && cur.endpoint.url === endpoint.url && cur.endpoint.token === endpoint.token) return;
    this.#entries.set(pcId, { endpoint, client: null, generation: (cur?.generation ?? 0) + 1 });
  }

  unregister(pcId: string): void {
    this.#entries.delete(pcId);
  }

  has(pcId: string): boolean {
    return this.#entries.has(pcId);
  }

  /** Drops the cached client so the next call reconnects. */
  invalidate(pcId: string): void {
    const e = this.#entries.get(pcId);
    if (e) {
      e.client = null;
      e.generation++;
    }
  }

  /** The connected client of a PC (connects on first use). */
  async client(pcId: string): Promise<SpacesdClientLike> {
    const e = this.#entries.get(pcId);
    if (!e) throw new Error(`spacesd: unknown PC ${pcId}`);
    if (!e.client) {
      const gen = e.generation;
      const p = this.#connect(e.endpoint);
      e.client = p;
      p.catch(() => {
        const cur = this.#entries.get(pcId);
        if (cur && cur.generation === gen && cur.client === p) cur.client = null;
      });
    }
    return e.client;
  }

  async #connect(endpoint: PcEndpoint): Promise<SpacesdClientLike> {
    const mod = await this.module();
    return withDeadline(
      this.#connectTimeoutMs,
      'spacesd connect',
      (signal) => mod.embedded().spacesd(endpoint.url, endpoint.token, { signal }),
      {
        onLate: (c) => {
          this.#lateConnects++;
          releaseClient(c);
        },
      },
    );
  }

  /**
   * Runs `fn` with the PC's client under a deadline (`timeoutMs`, default `callTimeoutMs`); `fn` gets the
   * deadline's signal to pass on. A transport error (a deadline counts) drops the client; with `retry`
   * (default true, for idempotent calls) it reconnects and tries once more.
   */
  async call<T>(
    pcId: string,
    fn: (c: SpacesdClientLike, signal: AbortSignal) => Promise<T>,
    options: { retry?: boolean; timeoutMs?: number } = {},
  ): Promise<T> {
    const retry = options.retry ?? true;
    const ms = options.timeoutMs ?? this.#callTimeoutMs;
    const once = async () => {
      const c = await this.client(pcId);
      return withDeadline(ms, 'spacesd call', (signal) => fn(c, signal));
    };
    try {
      return await once();
    } catch (err) {
      if (!isTransportError(err)) throw err;
      this.invalidate(pcId);
      if (!retry) throw err;
      this.#log?.debug({ pcId }, 'spacesd reconnecting');
      return once();
    }
  }

  /** One health probe. */
  async health(pcId: string): Promise<HealthReport> {
    return this.call(pcId, async (c, signal) => parseHealth(await c.health({ signal })), {
      timeoutMs: this.#healthTimeoutMs,
    });
  }

  /**
   * Polls until spacesd reports HEALTH_STATUS_SERVING (every component up) or the timeout passes.
   * `onProgress` receives a booting percentage and the last report.
   */
  async waitServing(
    pcId: string,
    options: {
      timeoutMs: number;
      intervalMs?: number;
      signal?: AbortSignal;
      onProgress?: (percent: number, report: HealthReport | null) => void;
    },
  ): Promise<HealthReport> {
    const deadline = Date.now() + options.timeoutMs;
    const interval = options.intervalMs ?? 250;
    let last: HealthReport | null = null;
    let lastErr = '';
    while (Date.now() < deadline) {
      if (options.signal?.aborted) throw new Error('waitServing aborted');
      try {
        last = await this.health(pcId);
        options.onProgress?.(readinessPercent(last), last);
        if (last.serving) return last;
      } catch (err) {
        this.invalidate(pcId);
        lastErr = err instanceof Error ? err.message : String(err);
        options.onProgress?.(10, null);
      }
      await new Promise((r) => setTimeout(r, interval));
    }
    const detail = last
      ? `${last.status} (${last.components.map((c) => `${c.name}=${c.status}`).join(', ')})`
      : lastErr || 'no answer';
    throw new Error(`spacesd not serving after ${options.timeoutMs} ms: ${detail}`);
  }

  close(): void {
    this.#entries.clear();
  }
}
