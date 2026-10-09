import type { PcStatus, PcType } from '@minevibe/protocol';
import { ApiError } from './common.js';
import {
  type EditRequest,
  type ExecRequest,
  type ExecResult,
  type FileStat,
  type GlobRequest,
  type GlobResult,
  type GrepRequest,
  type GrepResult,
  type GuestWindow,
  type JobExit,
  type JobOutput,
  type KeyboardAction,
  type OpenRequest,
  type OpenResult,
  PC_ERROR_CODES,
  PC_LIMITS,
  type PcApi,
  type PcGuestInfo,
  type PointerAction,
  type ReadRequest,
  type ReadResult,
  type Screenshot,
  type ScreenshotOptions,
  type UiAction,
  type UiFindRequest,
  type UiNode,
  type UiSnapshot,
  type UiTreeRequest,
  type WindowOp,
} from './PcApi.js';

export interface FakePcInit {
  readonly pcId: string;
  readonly type?: PcType;
  readonly status?: PcStatus;
  /** Guest files by absolute path. */
  readonly files?: Readonly<Record<string, string>>;
  /** Guest screen size (default 1280x800). */
  readonly screen?: { readonly w: number; readonly h: number };
}

interface FakeJob {
  readonly tag: string;
  running: boolean;
  exitCode: number | null;
  output: string;
  readonly outputPath: string | undefined;
  readonly startedAt: number;
}

/** A window of the fake desktop, with the accessibility elements it exposes. */
export type FakeWindow = { -readonly [K in keyof GuestWindow]: GuestWindow[K] } & {
  /** Elements in document order (their `elementId`s are the fake's own; snapshots copy them). */
  nodes: UiNode[];
};

interface FakePc {
  readonly pcId: string;
  readonly type: PcType;
  status: PcStatus;
  readonly screen: { readonly w: number; readonly h: number };
  readonly files: Map<string, string>;
  /** Modification times per path (bumped by every write). */
  readonly mtimes: Map<string, number>;
  clipboard: string;
  readonly jobs: Map<string, FakeJob>;
  windows: FakeWindow[];
  cursor: { x: number; y: number };
  /** Bumped by every input or window change: the screenshot bytes change with it. */
  screenVersion: number;
}

const HOME = '/home/cua';

/** A glob (`**`, `*`, `?`) as an anchored regex over absolute paths. */
export function globToRegExp(pattern: string): RegExp {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i] as string;
    if (c === '*' && pattern[i + 1] === '*') {
      if (pattern[i + 2] === '/') {
        re += '(?:.*/)?';
        i += 2;
      } else {
        re += '.*';
        i += 1;
      }
    } else if (c === '*') {
      re += '[^/]*';
    } else if (c === '?') {
      re += '[^/]';
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`);
}

function absolute(base: string, path: string): string {
  return path.startsWith('/') ? path : `${base.replace(/\/+$/, '')}/${path}`;
}

/** The terminal window every fake PC starts with. */
function terminalWindow(pcId: string): FakeWindow {
  return {
    id: 'win-term',
    title: `Terminal - cua@${pcId}: ~`,
    app: 'Xfce4-terminal',
    pid: 400,
    bounds: { x: 100, y: 80, w: 800, h: 500 },
    focused: true,
    state: 'NORMAL',
    onScreen: true,
    z: 1,
    nodes: [
      {
        elementId: '0',
        depth: 1,
        role: 'menu',
        name: 'File',
        bounds: { x: 100, y: 80, w: 40, h: 24 },
        states: ['enabled'],
        actions: ['press'],
      },
      {
        elementId: '1',
        depth: 1,
        role: 'menu',
        name: 'Edit',
        bounds: { x: 140, y: 80, w: 40, h: 24 },
        states: ['enabled'],
        actions: ['press'],
      },
      {
        elementId: '2',
        depth: 2,
        role: 'terminal',
        name: 'Terminal',
        description: `cua@${pcId}: ~`,
        bounds: { x: 100, y: 104, w: 800, h: 476 },
        states: ['enabled', 'focused'],
        actions: ['show_menu'],
      },
    ],
  };
}

/**
 * An in-memory {@link PcApi} for tests: a guest file system per PC, scripted command results, background jobs that
 * run until {@link finishJob} or a kill, a small desktop (windows with accessibility elements, a pointer, a screen
 * whose image changes with every input) and a log of every input call. Not a sandbox and not a shell.
 */
export class FakePcApi implements PcApi {
  readonly #pcs = new Map<string, FakePc>();
  readonly #listeners = new Set<(exit: JobExit) => void>();
  #jobSeq = 0;
  #snapshotSeq = 0;
  /** Snapshots handed out: id → the window and nodes it saw. */
  readonly #snapshots = new Map<string, { pcId: string; windowId: string; nodes: UiNode[] }>();
  readonly #latest = new Map<string, string>();

  /** Every pointer, keyboard and type call, in order. */
  readonly input: { pcId: string; kind: 'pointer' | 'keyboard' | 'type'; value: unknown }[] = [];
  /** Every exec request, in order. */
  readonly execs: { pcId: string; request: ExecRequest }[] = [];
  /** Every accessibility action, window operation and open, in order. */
  readonly actions: { pcId: string; kind: 'ui' | 'window' | 'open'; value: unknown }[] = [];
  /** Screenshots taken (options), in order. */
  readonly shots: { pcId: string; options: ScreenshotOptions }[] = [];
  /**
   * What a foreground command returns (default: exit 0, no output). `hang: true` acts like a command that overruns its
   * timeout: TIMEOUT, or a background job with `onTimeout: 'background'`.
   */
  execHandler: (pcId: string, request: ExecRequest) => { exitCode: number; output: string; hang?: boolean } =
    () => ({
      exitCode: 0,
      output: '',
    });
  /** What `open` does (default: a new focused window titled after the target). */
  openHandler: ((pcId: string, request: OpenRequest) => FakeWindow | null) | null = null;
  /** What a click changes on the desktop (default: nothing but the screen version). */
  onClick: ((pcId: string, x: number | undefined, y: number | undefined) => void) | null = null;

  constructor(pcs: readonly FakePcInit[] = [{ pcId: 'linux-1' }]) {
    for (const init of pcs) {
      const files = new Map(Object.entries(init.files ?? {}));
      this.#pcs.set(init.pcId, {
        pcId: init.pcId,
        type: init.type ?? 'linux',
        status: init.status ?? 'running',
        screen: init.screen ?? { w: 1280, h: 800 },
        files,
        mtimes: new Map([...files.keys()].map((p) => [p, 1_000])),
        clipboard: '',
        jobs: new Map(),
        windows: [terminalWindow(init.pcId)],
        cursor: { x: 640, y: 400 },
        screenVersion: 0,
      });
    }
  }

  setStatus(pcId: string, status: PcStatus): void {
    this.#known(pcId).status = status;
  }

  /** The guest file system of a PC. */
  files(pcId: string): ReadonlyMap<string, string> {
    return this.#known(pcId).files;
  }

  /** Changes a file as someone else would (the player, a linter): content and modification time. */
  touchFile(pcId: string, path: string, content: string): void {
    const pc = this.#known(pcId);
    pc.files.set(path, content);
    pc.mtimes.set(path, (pc.mtimes.get(path) ?? 1_000) + 1_000);
  }

  /** The fake desktop's windows (front first), to inspect or rearrange. */
  desktop(pcId: string): FakeWindow[] {
    return this.#known(pcId).windows;
  }

  /** Adds a window in front with the focus. */
  addWindow(pcId: string, win: Omit<FakeWindow, 'focused' | 'onScreen'> & Partial<FakeWindow>): FakeWindow {
    const pc = this.#known(pcId);
    for (const w of pc.windows) w.focused = false;
    const full: FakeWindow = { onScreen: true, ...win, focused: true };
    pc.windows.unshift(full);
    pc.screenVersion++;
    return full;
  }

  /** Changes the screen (as an app redrawing would). */
  bumpScreen(pcId: string): void {
    this.#known(pcId).screenVersion++;
  }

  /** Ends a background job. */
  finishJob(pcId: string, jobId: string, exitCode: number, output = ''): void {
    const job = this.#job(this.#known(pcId), jobId);
    job.output += output;
    job.running = false;
    job.exitCode = exitCode;
    this.#emit(pcId, jobId, job, 'exited');
  }

  #emit(pcId: string, jobId: string, job: FakeJob, reason: JobExit['reason']): void {
    const exit: JobExit = {
      pcId,
      jobId,
      tag: job.tag,
      exitCode: job.exitCode,
      reason,
      ...(job.outputPath ? { outputPath: job.outputPath } : {}),
      durationMs: Date.now() - job.startedAt,
    };
    for (const l of [...this.#listeners]) l(exit);
  }

  onJobExit(listener: (exit: JobExit) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  async info(pcId: string): Promise<PcGuestInfo> {
    const pc = this.#known(pcId);
    return {
      pcId,
      type: pc.type,
      status: pc.status,
      os: pc.type === 'macos' ? 'macos' : 'linux',
      screen: { ...pc.screen },
      user: 'cua',
      home: HOME,
      mounts: [],
      codexPath: '/mnt/codex',
    };
  }

  async screenshot(pcId: string, options: ScreenshotOptions = {}): Promise<Screenshot> {
    const pc = this.#running(pcId);
    this.shots.push({ pcId, options });
    const src = options.region ?? { x: 0, y: 0, w: pc.screen.w, h: pc.screen.h };
    const scale =
      options.region && options.fit
        ? Math.min(options.fit.w / src.w, options.fit.h / src.h)
        : options.maxDim !== undefined
          ? Math.min(1, options.maxDim / Math.max(src.w, src.h))
          : 1;
    const v = pc.screenVersion;
    return {
      mime: options.format === 'png' ? 'image/png' : 'image/jpeg',
      // A JPEG-like blob whose bytes change with the screen.
      data: new Uint8Array([0xff, 0xd8, v & 0xff, (v >> 8) & 0xff, src.x & 0xff, src.w & 0xff, 0xff, 0xd9]),
      w: Math.round(src.w * scale),
      h: Math.round(src.h * scale),
      screen: { ...pc.screen },
      scale,
    };
  }

  async pointer(pcId: string, action: PointerAction): Promise<void> {
    const pc = this.#running(pcId);
    this.input.push({ pcId, kind: 'pointer', value: action });
    if ('x' in action && action.x !== undefined && action.y !== undefined) {
      pc.cursor = { x: action.x, y: action.y };
    }
    if (action.action === 'drag') pc.cursor = { x: action.toX, y: action.toY };
    if (action.action !== 'move') pc.screenVersion++;
    if (action.action === 'click' || action.action === 'double_click' || action.action === 'right_click') {
      this.onClick?.(pcId, action.x, action.y);
    }
  }

  async keyboard(pcId: string, action: KeyboardAction): Promise<void> {
    const pc = this.#running(pcId);
    this.input.push({ pcId, kind: 'keyboard', value: action });
    pc.screenVersion++;
  }

  async type(pcId: string, text: string): Promise<void> {
    const pc = this.#running(pcId);
    this.input.push({ pcId, kind: 'type', value: text });
    pc.screenVersion++;
  }

  async cursor(pcId: string): Promise<{ x: number; y: number }> {
    return { ...this.#running(pcId).cursor };
  }

  async clipboardGet(pcId: string): Promise<string> {
    return this.#running(pcId).clipboard;
  }

  async clipboardSet(pcId: string, text: string): Promise<void> {
    this.#running(pcId).clipboard = text;
  }

  async windows(pcId: string): Promise<GuestWindow[]> {
    return this.#running(pcId).windows.map(({ nodes: _n, ...w }) => ({ ...w }));
  }

  async window(pcId: string, windowId: string, op: WindowOp): Promise<void> {
    const pc = this.#running(pcId);
    const w = pc.windows.find((x) => x.id === windowId);
    if (!w) throw new ApiError(PC_ERROR_CODES.WINDOW_NOT_FOUND, 'the window is gone');
    this.actions.push({ pcId, kind: 'window', value: { windowId, op } });
    pc.screenVersion++;
    if (op === 'close') {
      pc.windows = pc.windows.filter((x) => x !== w);
      if (w.focused && pc.windows[0]) pc.windows[0].focused = true;
      return;
    }
    if (op === 'activate' || op === 'restore' || op === 'maximize') {
      for (const x of pc.windows) x.focused = x === w;
      pc.windows = [w, ...pc.windows.filter((x) => x !== w)];
    }
    if (op !== 'activate') (w as { state?: string }).state = op === 'restore' ? 'NORMAL' : op.toUpperCase();
  }

  async open(pcId: string, request: OpenRequest): Promise<OpenResult> {
    const pc = this.#running(pcId);
    this.actions.push({ pcId, kind: 'open', value: request });
    const win =
      this.openHandler !== null
        ? this.openHandler(pcId, request)
        : this.addWindow(pcId, {
            id: `win-${this.actions.length}`,
            title: `${request.target.split('/').at(-1) ?? request.target} - App`,
            app: 'App',
            bounds: { x: 0, y: 0, w: pc.screen.w, h: pc.screen.h },
            nodes: [],
          });
    if (win && !pc.windows.includes(win)) this.addWindow(pcId, win);
    const { nodes: _n, ...shown } = win ?? ({ nodes: [] } as unknown as FakeWindow);
    return { window: win ? (shown as GuestWindow) : null, newWindow: win !== null, via: 'fake' };
  }

  #snapshot(pcId: string, win: FakeWindow, nodes: UiNode[]): UiSnapshot {
    const snapshotId = `ax-${++this.#snapshotSeq}`;
    this.#snapshots.set(snapshotId, { pcId, windowId: win.id, nodes });
    // Like spacesd: one live snapshot per window (a newer look at the window expires the older one).
    this.#latest.set(`${pcId}\n${win.id}`, snapshotId);
    return { snapshotId, windowId: win.id, nodes };
  }

  #windowOf(pc: FakePc, windowId: string | undefined): FakeWindow {
    const w = windowId ? pc.windows.find((x) => x.id === windowId) : pc.windows.find((x) => x.focused);
    if (!w) throw new ApiError(PC_ERROR_CODES.WINDOW_NOT_FOUND, 'the window is gone');
    return w;
  }

  async uiFind(pcId: string, request: UiFindRequest): Promise<UiSnapshot> {
    const pc = this.#running(pcId);
    const w = this.#windowOf(pc, request.windowId);
    const has = (s: string | undefined, q: string | undefined) =>
      q === undefined || (s ?? '').toLowerCase().includes(q.toLowerCase());
    const nodes = w.nodes
      .filter(
        (n) =>
          has(n.name, request.nameContains) &&
          has(n.value, request.valueContains) &&
          (request.role === undefined || n.role === request.role),
      )
      .slice(0, request.maxResults ?? 50);
    return this.#snapshot(pcId, w, nodes);
  }

  async uiTree(pcId: string, request: UiTreeRequest): Promise<UiSnapshot> {
    const pc = this.#running(pcId);
    const w = this.#windowOf(pc, request.windowId);
    return this.#snapshot(pcId, w, w.nodes.slice(0, request.maxNodes ?? 600));
  }

  async uiAct(
    pcId: string,
    request: { snapshotId: string; elementId: string; action: UiAction; value?: string | undefined },
  ): Promise<void> {
    const pc = this.#running(pcId);
    const snap = this.#snapshots.get(request.snapshotId);
    const w = snap ? pc.windows.find((x) => x.id === snap.windowId) : undefined;
    const node = w?.nodes.find((n) => n.elementId === request.elementId);
    const current = snap ? this.#latest.get(`${pcId}\n${snap.windowId}`) === request.snapshotId : false;
    if (!snap || snap.pcId !== pcId || !w || !node || !current) {
      throw new ApiError(PC_ERROR_CODES.STALE_REF, 'the accessibility snapshot expired (the window changed)');
    }
    this.actions.push({ pcId, kind: 'ui', value: request });
    if (request.action === 'set_value' && request.value !== undefined) {
      (node as { value?: string }).value = request.value;
    }
    pc.screenVersion++;
  }

  async exec(pcId: string, request: ExecRequest): Promise<ExecResult> {
    const pc = this.#running(pcId);
    this.execs.push({ pcId, request });
    const timeoutMs = Math.min(request.timeoutMs ?? PC_LIMITS.defaultTimeoutMs, PC_LIMITS.maxTimeoutMs);
    const jobId = request.jobId ?? `job-${++this.#jobSeq}`;
    const outputPath = request.outputFile ? `${HOME}/.mv/jobs/${jobId}.out` : undefined;
    const lifetimeMs = Math.min(
      request.lifetimeMs ?? PC_LIMITS.defaultJobLifetimeMs,
      PC_LIMITS.maxJobLifetimeMs,
    );
    const startJob = (output: string): FakeJob => {
      const job: FakeJob = {
        tag: request.tag,
        running: true,
        exitCode: null,
        output,
        outputPath,
        startedAt: Date.now(),
      };
      pc.jobs.set(jobId, job);
      if (outputPath) pc.files.set(outputPath, output);
      return job;
    };
    if (request.background) {
      startJob('');
      return { kind: 'background', jobId, ...(outputPath ? { outputPath } : {}), lifetimeMs };
    }
    if (timeoutMs <= 0) throw new ApiError(PC_ERROR_CODES.TIMEOUT, `timed out after ${timeoutMs} ms`);
    const { exitCode, output, hang } = this.execHandler(pcId, request);
    if (hang) {
      if (request.onTimeout === 'background') {
        startJob(output);
        return {
          kind: 'background',
          jobId,
          ...(outputPath ? { outputPath } : {}),
          timedOutAfterMs: timeoutMs,
          lifetimeMs,
        };
      }
      throw new ApiError(PC_ERROR_CODES.TIMEOUT, `timed out after ${Math.round(timeoutMs / 1000)} s`);
    }
    const truncated = output.length > PC_LIMITS.maxOutputChars;
    return {
      kind: 'done',
      exitCode,
      output: truncated ? output.slice(0, PC_LIMITS.maxOutputChars) : output,
      truncated,
      durationMs: 1,
    };
  }

  async jobOutput(pcId: string, jobId: string, fromOffset = 0): Promise<JobOutput> {
    const job = this.#job(this.#running(pcId), jobId);
    const output = job.output.slice(fromOffset, fromOffset + PC_LIMITS.maxOutputChars);
    return {
      jobId,
      running: job.running,
      exitCode: job.exitCode,
      output,
      nextOffset: fromOffset + output.length,
      truncated: job.output.length - fromOffset > PC_LIMITS.maxOutputChars,
    };
  }

  async kill(pcId: string, target: { readonly jobId: string } | { readonly tag: string }): Promise<number> {
    const pc = this.#known(pcId);
    let killed = 0;
    if ('jobId' in target && !pc.jobs.has(target.jobId))
      throw new ApiError(PC_ERROR_CODES.UNKNOWN_JOB, 'no such job');
    for (const [jobId, job] of pc.jobs) {
      const hit = 'jobId' in target ? jobId === target.jobId : job.tag === target.tag;
      if (hit && job.running) {
        job.running = false;
        job.exitCode = 137;
        killed++;
        this.#emit(pcId, jobId, job, 'jobId' in target ? 'stopped' : 'seat');
      }
    }
    return killed;
  }

  async readFile(pcId: string, request: ReadRequest): Promise<ReadResult> {
    const content = this.#file(this.#running(pcId), request.path);
    if (content.length === 0) return { content: '', startLine: 1, totalLines: 0, truncated: false };
    // Like Claude Code's Read: a final newline ends in one more (empty) line.
    const lines = content.split('\n');
    const start = Math.max(1, request.offset ?? 1);
    const limit = request.limit ?? 2000;
    const selected = lines.slice(start - 1, start - 1 + limit);
    return {
      content: selected.join('\n'),
      startLine: start,
      totalLines: lines.length,
      truncated: start - 1 + selected.length < lines.length,
    };
  }

  async readBytes(pcId: string, path: string, maxBytes: number): Promise<Uint8Array> {
    const data = Buffer.from(this.#file(this.#running(pcId), path), 'binary');
    if (data.byteLength > maxBytes) throw new ApiError(PC_ERROR_CODES.DENIED, `${path} is too large`);
    return new Uint8Array(data);
  }

  async stat(pcId: string, path: string): Promise<FileStat> {
    const pc = this.#running(pcId);
    const p = absolute(HOME, path);
    const content = pc.files.get(p);
    if (content !== undefined) {
      return {
        exists: true,
        kind: 'file',
        size: Buffer.byteLength(content, 'utf8'),
        mtimeMs: pc.mtimes.get(p) ?? 1_000,
      };
    }
    const dir = `${p.replace(/\/+$/, '')}/`;
    if ([...pc.files.keys()].some((f) => f.startsWith(dir)))
      return { exists: true, kind: 'dir', size: 0, mtimeMs: 0 };
    return { exists: false, size: 0, mtimeMs: 0 };
  }

  async writeFile(pcId: string, path: string, content: string): Promise<number> {
    const pc = this.#running(pcId);
    const p = absolute(HOME, path);
    pc.files.set(p, content);
    pc.mtimes.set(p, (pc.mtimes.get(p) ?? 1_000) + 1);
    return Buffer.byteLength(content, 'utf8');
  }

  async editFile(pcId: string, request: EditRequest): Promise<number> {
    const pc = this.#running(pcId);
    const path = absolute(HOME, request.path);
    const content = this.#file(pc, path);
    const count = request.oldString.length === 0 ? 0 : content.split(request.oldString).length - 1;
    if (count === 0) throw new ApiError(PC_ERROR_CODES.EDIT_NOT_FOUND, 'old_string not found in the file');
    if (count > 1 && !request.replaceAll) {
      throw new ApiError(
        PC_ERROR_CODES.EDIT_AMBIGUOUS,
        `old_string occurs ${count} times; add context or use replace_all`,
      );
    }
    const next = request.replaceAll
      ? content.split(request.oldString).join(request.newString)
      : content.replace(request.oldString, () => request.newString);
    pc.files.set(path, next);
    pc.mtimes.set(path, (pc.mtimes.get(path) ?? 1_000) + 1);
    return request.replaceAll ? count : 1;
  }

  async glob(pcId: string, request: GlobRequest): Promise<GlobResult> {
    const pc = this.#running(pcId);
    const re = globToRegExp(absolute(request.path ?? HOME, request.pattern));
    const paths = [...pc.files.keys()].filter((p) => re.test(p)).sort();
    return {
      paths: paths.slice(0, 100),
      truncated: paths.length > 100,
      total: paths.length,
      countIsComplete: true,
    };
  }

  async grep(pcId: string, request: GrepRequest): Promise<GrepResult> {
    const pc = this.#running(pcId);
    const root = absolute(HOME, request.path ?? HOME).replace(/\/+$/, '');
    const fileRe = request.glob !== undefined ? globToRegExp(absolute(root, `**/${request.glob}`)) : null;
    const re = new RegExp(
      request.pattern,
      `${request.caseInsensitive ? 'i' : ''}${request.multiline ? 's' : ''}${request.onlyMatching ? 'g' : ''}`,
    );
    const out: string[] = [];
    let matches = 0;
    let files = 0;
    for (const [path, content] of [...pc.files].sort(([a], [b]) => a.localeCompare(b))) {
      if (path !== root && !path.startsWith(`${root}/`)) continue;
      if (fileRe && !fileRe.test(path)) continue;
      const hits = content
        .split('\n')
        .map((text, i) => ({ text, line: i + 1 }))
        .filter((l) => new RegExp(re.source, re.flags.replace('g', '')).test(l.text));
      if (hits.length === 0) continue;
      files++;
      if (request.outputMode === 'files_with_matches') {
        out.push(path);
        matches++;
      } else if (request.outputMode === 'count') {
        out.push(`${path}:${hits.length}`);
        matches += hits.length;
      } else {
        for (const h of hits) {
          const parts = request.onlyMatching ? [...h.text.matchAll(re)].map((m) => m[0]) : [h.text];
          for (const t of parts) out.push(request.lineNumbers ? `${path}:${h.line}:${t}` : `${path}:${t}`);
        }
        matches += hits.length;
      }
    }
    const after = out.slice(Math.max(0, request.offset ?? 0));
    const limited = request.headLimit ? after.slice(0, request.headLimit) : after;
    return {
      output: limited.join('\n'),
      matches,
      total: out.length,
      ...(request.outputMode === 'count' ? { files } : {}),
      truncated: limited.length < after.length,
    };
  }

  #known(pcId: string): FakePc {
    const pc = this.#pcs.get(pcId);
    if (!pc) throw new ApiError(PC_ERROR_CODES.PC_UNKNOWN, `no PC ${pcId}`);
    return pc;
  }

  #running(pcId: string): FakePc {
    const pc = this.#known(pcId);
    if (pc.status !== 'running') throw new ApiError(PC_ERROR_CODES.PC_DOWN, `${pcId} is ${pc.status}`);
    return pc;
  }

  #file(pc: FakePc, path: string): string {
    const content = pc.files.get(absolute(HOME, path));
    if (content === undefined) throw new ApiError(PC_ERROR_CODES.NOT_FOUND, `no such file: ${path}`);
    return content;
  }

  #job(pc: FakePc, jobId: string): FakeJob {
    const job = pc.jobs.get(jobId);
    if (!job) throw new ApiError(PC_ERROR_CODES.UNKNOWN_JOB, `no job ${jobId}`);
    return job;
  }
}
