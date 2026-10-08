import { type FetchLike, formatBytes } from '../launcher/download.js';
import type { PlayProgressEvent } from '../orchestrator/play.js';
import type { AppPhase, NodeToStub } from './stubProtocol.js';

type ProgressMessage = Extract<NodeToStub, { t: 'progress' }>;
export type LaunchProgressMessage = ProgressMessage | Extract<NodeToStub, { t: 'ready' }>;

const NULL_BODY_STATUS = new Set([101, 103, 204, 205, 304]);

/**
 * Wraps a fetch so the launcher's downloads become visible: `onRequest` runs when a request starts (any network
 * request means installation work: every installer's fast path is offline), `onBytes` for every body chunk.
 * Status, headers, `ok`, `url`, `json()` and streaming behave as before.
 */
export function countingFetch(
  base: FetchLike,
  onRequest: (url: string) => void,
  onBytes: (bytes: number) => void,
): FetchLike {
  return async (url, init) => {
    onRequest(String(url));
    const res = await base(url, init);
    if (!res.body || NULL_BODY_STATUS.has(res.status)) return res;
    const counter = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        onBytes(chunk.byteLength);
        controller.enqueue(chunk);
      },
    });
    const counted = new Response(res.body.pipeThrough(counter), {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
    });
    Object.defineProperty(counted, 'url', { value: res.url });
    Object.defineProperty(counted, 'redirected', { value: res.redirected });
    return counted;
  };
}

/** What a download host serves, for the progress line. */
export function downloadLabel(url: string): string {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return 'game files';
  }
  if (host === 'resources.download.minecraft.net') return 'Minecraft assets';
  if (host.endsWith('fabricmc.net')) return 'Fabric';
  if (host.endsWith('modrinth.com')) return 'mods';
  if (host.endsWith('mojang.com') || host.endsWith('minecraft.net')) return 'Minecraft';
  return 'game files';
}

export interface LaunchProgressOptions {
  /** Minimum gap between byte-count updates (default 250 ms). Phase changes are sent at once. */
  readonly throttleMs?: number;
}

/**
 * Turns {@link play}'s milestones and the launcher's network traffic into the stub's `progress` / `ready`
 * messages. `work` turns true at the first network request and stays true: the stub opens its first-run window
 * only then, so a normal launch (everything installed and verified offline) shows no window at all.
 */
export class LaunchProgress {
  readonly #send: (message: LaunchProgressMessage) => void;
  readonly #throttleMs: number;
  #work = false;
  #bytes = 0;
  #label = 'game files';
  #phase: AppPhase = 'start';
  #title = 'Starting MineVibe';
  #detail: string | undefined;
  #timer: NodeJS.Timeout | null = null;
  #lastSent = 0;
  #ready = false;

  constructor(send: (message: LaunchProgressMessage) => void, options: LaunchProgressOptions = {}) {
    this.#send = send;
    this.#throttleMs = options.throttleMs ?? 250;
  }

  get work(): boolean {
    return this.#work;
  }

  get bytes(): number {
    return this.#bytes;
  }

  /** A network request started. */
  request(url: string): void {
    this.#label = downloadLabel(url);
    if (!this.#work) {
      this.#work = true;
      if (this.#phase === 'install') this.#title = 'Downloading Minecraft, Fabric and mods';
      this.#detail = `Fetching ${this.#label}…`;
      this.#flush();
    } else {
      this.#schedule();
    }
  }

  /** Body bytes arrived. */
  received(bytes: number): void {
    this.#bytes += bytes;
    if (this.#phase === 'install') this.#detail = `${this.#label} · ${formatBytes(this.#bytes)} downloaded`;
    this.#schedule();
  }

  /** A milestone of {@link play}. */
  onPlay(event: PlayProgressEvent): void {
    switch (event.phase) {
      case 'install':
        if (event.state === 'start') {
          this.#set(
            'install',
            this.#work ? 'Downloading Minecraft, Fabric and mods' : 'Checking the game files',
          );
        } else {
          this.#set(
            'install',
            'Game files ready',
            this.#work ? `${formatBytes(this.#bytes)} downloaded` : undefined,
          );
        }
        break;
      case 'seed':
        this.#set('seed', 'Preparing the game');
        break;
      case 'launch':
        this.#set('launch', 'Starting Minecraft');
        break;
      case 'launched':
        this.#set('launched', 'Starting Minecraft', 'Waiting for the game window…');
        break;
      case 'connected':
        this.#phase = 'connected';
        if (!this.#ready) {
          this.#ready = true;
          this.#clearTimer();
          this.#send({ t: 'ready' });
        }
        break;
      case 'exited':
        this.#phase = 'exited';
        this.#clearTimer();
        break;
    }
  }

  /** Stops pending updates. */
  dispose(): void {
    this.#clearTimer();
  }

  #set(phase: AppPhase, title: string, detail?: string): void {
    this.#phase = phase;
    this.#title = title;
    this.#detail = detail;
    this.#flush();
  }

  #schedule(): void {
    if (this.#timer) return;
    const wait = Math.max(0, this.#lastSent + this.#throttleMs - Date.now());
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.#flush();
    }, wait);
    this.#timer.unref();
  }

  #clearTimer(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
  }

  #flush(): void {
    this.#clearTimer();
    // The game is up: a late update (a download after the game connected) must not reopen the stub's window.
    if (this.#ready) return;
    this.#lastSent = Date.now();
    this.#send({
      t: 'progress',
      phase: this.#phase,
      work: this.#work,
      title: this.#title,
      ...(this.#detail !== undefined ? { detail: this.#detail } : {}),
      fraction: null,
      bytes: this.#bytes,
    });
  }
}
