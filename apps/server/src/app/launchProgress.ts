import { type FetchLike, formatBytes } from '../launcher/download.js';
import type { PlayProgressEvent } from '../orchestrator/play.js';
import type { PcPrepEvent } from './appPcs.js';
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

/** Longest detail line sent to the stub (build output can be long). */
const MAX_DETAIL = 160;

/** One line of tool output, fit for the window: no control characters or escapes, and at most {@link MAX_DETAIL}. */
export function cleanDetail(line: string): string {
  const text = line
    // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping terminal escapes and control characters
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
    // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping terminal escapes and control characters
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > MAX_DETAIL ? `${text.slice(0, MAX_DETAIL - 1)}…` : text;
}

export interface LaunchProgressOptions {
  /** Minimum gap between byte-count updates (default 250 ms). Phase changes are sent at once. */
  readonly throttleMs?: number;
}

/**
 * Turns {@link play}'s milestones and the launcher's network traffic into the stub's `progress` / `ready`
 * messages. `work` turns true at the first network request (or a first-run PC step: the kernel download, the image
 * build) and stays true: the stub opens its first-run window only then, so a normal launch (everything installed and
 * verified offline) shows no window at all. The install titles speak of downloading only when game files are.
 */
export class LaunchProgress {
  readonly #send: (message: LaunchProgressMessage) => void;
  readonly #throttleMs: number;
  /** Something is downloaded or built (the game files, the PC kernel or image): the stub may open its window. */
  #work = false;
  /** The game files are being downloaded (a PC step alone is not that). */
  #downloading = false;
  #bytes = 0;
  #label = 'game files';
  #phase: AppPhase = 'start';
  #title = 'Starting MineVibe';
  #detail: string | undefined;
  #timer: NodeJS.Timeout | null = null;
  #lastSent = 0;
  #ready = false;
  /** The Linux PC lane (engine, image), shown while the game waits for it ({@link waitForPcs}). */
  #pc: { title: string; detail?: string } | null = null;

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
    if (!this.#downloading) {
      this.#downloading = true;
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
            this.#downloading ? 'Downloading Minecraft, Fabric and mods' : 'Checking the game files',
          );
        } else {
          this.#set(
            'install',
            'Game files ready',
            this.#downloading ? `${formatBytes(this.#bytes)} downloaded` : undefined,
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

  /**
   * A PC preparation step (it runs alongside the game install). A first-run step (the kernel download, the image
   * build) is installation work and opens the stub's window; build output updates the detail, throttled.
   */
  onPcs(event: PcPrepEvent): void {
    switch (event.step) {
      case 'engine':
        this.#pc = event.firstRun
          ? { title: 'Setting up the Linux PC engine', detail: 'Downloading the Linux kernel (first run)…' }
          : { title: 'Starting the Linux PC engine' };
        if (event.firstRun) this.#markWork();
        break;
      case 'image':
        if (event.line === undefined) {
          this.#pc = {
            title: 'Building the Linux PC image (first run)',
            detail: 'About 1.2 GB to download; this takes a few minutes…',
          };
          this.#markWork();
        } else {
          const detail = cleanDetail(event.line);
          if (!detail) return;
          this.#pc = { title: this.#pc?.title ?? 'Building the Linux PC image (first run)', detail };
          if (this.#phase === 'pcs') this.#show(this.#pc);
          this.#schedule();
          return;
        }
        break;
      case 'done':
      case 'unavailable':
        this.#pc = null;
        return;
    }
    if (this.#phase === 'pcs' && this.#pc) this.#show(this.#pc);
    this.#flush();
  }

  /** The game is installed and waits for the PC setup: the window shows the PC lane. */
  waitForPcs(): void {
    if (!this.#pc) return;
    this.#phase = 'pcs';
    this.#show(this.#pc);
    this.#flush();
  }

  #markWork(): void {
    this.#work = true;
  }

  #show(lane: { title: string; detail?: string }): void {
    this.#title = lane.title;
    this.#detail = lane.detail;
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
