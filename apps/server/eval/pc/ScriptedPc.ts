/**
 * The scripted PC of the tool evals: a {@link PcApi} for one Linux PC (`linux-1`) whose screen is the {@link Desktop}
 * state machine (real PNG frames), whose shell is the whitelist {@link Shell} over an in-memory file system with a
 * small failing repo, and whose file calls (Read, Write, Edit, Glob, Grep) follow the guest's semantics. The `pc`
 * tool server talks to it exactly as it talks to a real PC, `pc__bash` wrapper and `__MV_PWD__` marker included.
 *
 * PC tools V2: one window at a time (the desktop's open app), accessibility elements from {@link Desktop.elements}
 * (refs, `ui_act`, `open`, `wait_for` work on it), a pointer position, stat/readBytes over the file system (the
 * modification time follows the content, so read-state sees edits), and background jobs that end at once and say so.
 */

import { createHash } from 'node:crypto';
import { ApiError } from '../../src/contracts/common.js';
import { globToRegExp } from '../../src/contracts/FakePcApi.js';
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
} from '../../src/contracts/PcApi.js';
import { HOME, homeFs, OS_RELEASE, REPO, type TestRun } from './content.js';
import { Desktop, type DesktopElement, SCREEN } from './desktop.js';
import { MemFs } from './fs.js';
import { Shell } from './shell.js';

export const PC_ID = 'linux-1';

/** The command inside the `pc__bash` wrapper (pcServer.wrapBash), or the input unchanged. */
export function unwrapBash(wrapped: string): string {
  const lines = wrapped.split('\n');
  if (
    lines.length >= 7 &&
    lines[0] === 'mkdir -p ~/.mv' &&
    (lines[2] ?? '').startsWith('cd "$MV_CWD"') &&
    lines.at(-3) === 'ec=$?' &&
    (lines.at(-1) ?? '').startsWith('exit ')
  ) {
    return lines.slice(3, -3).join('\n');
  }
  return wrapped;
}

/** cua key names (what the V2 tools send) as the desktop's own key words. */
function deskKey(key: string): string {
  const k = key.toLowerCase().replace(/^key_/, '');
  const arrows: Record<string, string> = { arrow_left: 'left', arrow_right: 'right', arrow_up: 'up', arrow_down: 'down' };
  if (arrows[k]) return arrows[k] as string;
  if (k === 'numpad_enter') return 'enter';
  if (k === 'control' || k.startsWith('control_')) return 'ctrl';
  if (k.startsWith('shift_')) return 'shift';
  if (k.startsWith('alt_')) return 'alt';
  if (k === 'meta' || k.startsWith('meta_')) return 'super';
  return k;
}

/** The modification time of a file in this fake: a number that changes with its content. */
function mtimeOf(content: string): number {
  return Number.parseInt(createHash('sha1').update(content).digest('hex').slice(0, 10), 16);
}

const WINDOW_ID = 'win-app';

export interface ExecRecord {
  readonly command: string;
  readonly cwd: string;
  readonly exitCode: number;
  readonly output: string;
}

export class ScriptedPc implements PcApi {
  readonly fs: MemFs;
  readonly shell: Shell;
  readonly desktop: Desktop;
  /** Repo files at HEAD. */
  readonly gitHead: ReadonlyMap<string, string>;
  readonly execs: ExecRecord[] = [];
  readonly testRuns: TestRun[] = [];
  readonly input: { kind: string; value: unknown }[] = [];
  /** Full-size screenshots taken (thumbnails for settling the screen are not counted). */
  screenshots = 0;
  clipboard = '';
  /** Where the pointer is. */
  cursorPos = { x: 640, y: 400 };
  readonly #jobs = new Map<string, { tag: string; output: string; exitCode: number; running: boolean }>();
  readonly #listeners = new Set<(exit: JobExit) => void>();
  #jobSeq = 0;
  /** Accessibility snapshots: id → the elements it saw. */
  readonly #snapshots = new Map<string, DesktopElement[]>();
  #snapshotSeq = 0;

  constructor() {
    this.fs = homeFs();
    this.fs.write('/etc/os-release', OS_RELEASE);
    this.gitHead = new Map(this.fs.walk(REPO).map((p) => [p, this.fs.read(p) ?? '']));
    this.desktop = new Desktop({ runCommand: (cmd) => this.shell.run(cmd, HOME).output });
    this.shell = new Shell({
      fs: this.fs,
      home: HOME,
      user: 'cua',
      gitHead: this.gitHead,
      gitRoot: REPO,
      openBrowser: (url) => this.desktop.openBrowser(url),
      onTestRun: (run) => this.testRuns.push(run),
    });
  }

  #check(pcId: string): void {
    if (pcId !== PC_ID) throw new ApiError(PC_ERROR_CODES.PC_UNKNOWN, `no PC ${pcId}`);
  }

  async info(pcId: string): Promise<PcGuestInfo> {
    this.#check(pcId);
    return {
      pcId,
      type: 'linux',
      status: 'running',
      os: 'linux',
      screen: { ...SCREEN },
      user: 'cua',
      home: HOME,
      mounts: [],
      codexPath: null,
      cpus: 2,
      memoryMiB: 4096,
      osVersion: 'Ubuntu 24.04',
    };
  }

  async screenshot(pcId: string, options: ScreenshotOptions = {}): Promise<Screenshot> {
    this.#check(pcId);
    if (!options.region && (options.maxDim === undefined || options.maxDim >= 1_000)) this.screenshots++;
    return {
      mime: 'image/png',
      data: this.desktop.frame(),
      w: SCREEN.w,
      h: SCREEN.h,
      screen: { ...SCREEN },
      scale: 1,
    };
  }

  async pointer(pcId: string, action: PointerAction): Promise<void> {
    this.#check(pcId);
    this.input.push({ kind: 'pointer', value: action });
    if ('x' in action && action.x !== undefined && action.y !== undefined) {
      this.cursorPos = { x: action.x, y: action.y };
    }
    const { x, y } = this.cursorPos;
    switch (action.action) {
      case 'click':
        if ((action.button ?? 'left') === 'left') this.desktop.click(x, y, (action.count ?? 1) >= 2);
        return;
      case 'double_click':
        this.desktop.click(x, y, true);
        return;
      case 'drag':
        this.cursorPos = { x: action.toX, y: action.toY };
        return;
      default:
        return;
    }
  }

  async keyboard(pcId: string, action: KeyboardAction): Promise<void> {
    this.#check(pcId);
    this.input.push({ kind: 'keyboard', value: action });
    if (action.action === 'press') {
      for (let i = 0; i < (action.repeat ?? 1); i++) this.desktop.key(action.keys.map(deskKey));
    } else if (action.action === 'sequence') {
      for (let i = 0; i < (action.repeat ?? 1); i++)
        for (const chord of action.chords) this.desktop.key(chord.map(deskKey));
    }
  }

  async cursor(pcId: string): Promise<{ x: number; y: number }> {
    this.#check(pcId);
    return { ...this.cursorPos };
  }

  async windows(pcId: string): Promise<GuestWindow[]> {
    this.#check(pcId);
    const title = this.desktop.title();
    if (title === null) return [];
    return [
      {
        id: WINDOW_ID,
        title,
        app: this.desktop.app,
        bounds: { x: 0, y: 30, w: SCREEN.w, h: SCREEN.h - 30 },
        focused: true,
        onScreen: true,
        state: 'MAXIMIZED',
      },
    ];
  }

  async window(pcId: string, windowId: string, op: WindowOp): Promise<void> {
    this.#check(pcId);
    if (windowId !== WINDOW_ID || this.desktop.title() === null) {
      throw new ApiError(PC_ERROR_CODES.WINDOW_NOT_FOUND, 'the window is gone');
    }
    this.input.push({ kind: 'window', value: { windowId, op } });
    if (op === 'close' || op === 'minimize') this.desktop.closeWindow();
  }

  async open(pcId: string, request: OpenRequest): Promise<OpenResult> {
    this.#check(pcId);
    this.input.push({ kind: 'open', value: request.target });
    const t = request.target.trim();
    let via: string;
    if (/^(https?|file):\/\//i.test(t) || t.startsWith('about:')) {
      this.desktop.openBrowser(t);
      via = 'firefox';
    } else if (/^(firefox|chromium|browser|xdg-open)$/i.test(t)) {
      this.desktop.openBrowser(null);
      via = t.toLowerCase();
    } else if (/terminal/i.test(t)) {
      this.desktop.openApp('terminal');
      via = 'xfce4-terminal';
    } else if (/^(thunar|files)$/i.test(t) || (t.startsWith('/') && this.fs.isDir(t))) {
      this.desktop.openApp('files');
      via = 'thunar';
    } else if (t.startsWith('/')) {
      if (!this.fs.isFile(t)) throw new ApiError(PC_ERROR_CODES.NOT_FOUND, `no such file or directory: ${t}`);
      throw new ApiError(PC_ERROR_CODES.OPEN_FAILED, `nothing opens ${t}. Installed apps include: firefox thunar xfce4-terminal`);
    } else {
      throw new ApiError(PC_ERROR_CODES.OPEN_FAILED, `nothing opens ${t}. Installed apps include: firefox thunar xfce4-terminal`);
    }
    const [win] = await this.windows(pcId);
    return { window: win ?? null, newWindow: true, via };
  }

  #snapshot(elements: DesktopElement[]): UiSnapshot {
    const snapshotId = `ax-${++this.#snapshotSeq}`;
    this.#snapshots.set(snapshotId, elements);
    const nodes: UiNode[] = elements.map((e, i) => ({
      elementId: String(i),
      depth: e.depth,
      role: e.role,
      name: e.name,
      ...(e.value ? { value: e.value } : {}),
      ...(e.box ? { bounds: { ...e.box } } : {}),
      states: ['enabled', ...(e.field && this.desktop.focus === e.field ? ['focused'] : [])],
      actions: [...e.actions],
    }));
    return { snapshotId, windowId: this.desktop.title() === null ? null : WINDOW_ID, nodes };
  }

  async uiFind(pcId: string, request: UiFindRequest): Promise<UiSnapshot> {
    this.#check(pcId);
    const has = (s: string | undefined, q: string | undefined) =>
      q === undefined || (s ?? '').toLowerCase().includes(q.toLowerCase());
    const all = this.desktop.elements();
    const picked = all.filter(
      (e) =>
        has(e.name, request.nameContains) &&
        (request.valueContains === undefined || has(e.value, request.valueContains)) &&
        (request.role === undefined || e.role === request.role),
    );
    const snap = this.#snapshot(all);
    const ids = new Set(picked.slice(0, request.maxResults ?? 50).map((e) => String(all.indexOf(e))));
    return { ...snap, nodes: snap.nodes.filter((n) => ids.has(n.elementId)) };
  }

  async uiTree(pcId: string, request: UiTreeRequest): Promise<UiSnapshot> {
    this.#check(pcId);
    if (request.windowId !== undefined && (request.windowId !== WINDOW_ID || this.desktop.title() === null)) {
      throw new ApiError(PC_ERROR_CODES.WINDOW_NOT_FOUND, 'the window is gone');
    }
    const snap = this.#snapshot(this.desktop.elements());
    return { ...snap, nodes: snap.nodes.slice(0, request.maxNodes ?? 600) };
  }

  async uiAct(
    pcId: string,
    request: { snapshotId: string; elementId: string; action: UiAction; value?: string | undefined },
  ): Promise<void> {
    this.#check(pcId);
    const seen = this.#snapshots.get(request.snapshotId)?.[Number(request.elementId)];
    // A snapshot stays valid while the screen shows the same element (by role and name).
    const now = this.desktop.elements().find((e) => seen && e.role === seen.role && e.name === seen.name);
    if (!seen || !now) {
      throw new ApiError(PC_ERROR_CODES.STALE_REF, 'the accessibility snapshot expired (the window changed)');
    }
    this.input.push({ kind: 'ui', value: { action: request.action, role: now.role, name: now.name } });
    if ((request.action === 'set_value' || request.action === 'focus') && now.field) {
      this.desktop.setField(now.field, request.action === 'set_value' ? (request.value ?? '') : (now.value ?? ''));
      return;
    }
    if (request.action === 'press' && now.open) {
      this.desktop.openApp(now.open as 'terminal' | 'browser' | 'files');
      return;
    }
    if (request.action === 'press' && now.box) {
      this.desktop.click(now.box.x + Math.floor(now.box.w / 2), now.box.y + Math.floor(now.box.h / 2));
    }
  }

  onJobExit(listener: (exit: JobExit) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  async stat(pcId: string, path: string): Promise<FileStat> {
    this.#check(pcId);
    const p = this.#abs(path);
    if (this.fs.isDir(p)) return { exists: true, kind: 'dir', size: 0, mtimeMs: 0 };
    const text = this.fs.read(p);
    if (text === undefined) return { exists: false, size: 0, mtimeMs: 0 };
    return { exists: true, kind: 'file', size: Buffer.byteLength(text, 'utf8'), mtimeMs: mtimeOf(text) };
  }

  async readBytes(pcId: string, path: string, maxBytes: number): Promise<Uint8Array> {
    this.#check(pcId);
    const data = Buffer.from(this.#file(path), 'utf8');
    if (data.byteLength > maxBytes) throw new ApiError(PC_ERROR_CODES.DENIED, `${path} is too large`);
    return new Uint8Array(data);
  }

  async type(pcId: string, text: string): Promise<void> {
    this.#check(pcId);
    this.input.push({ kind: 'type', value: text });
    this.desktop.type(text);
  }

  async clipboardGet(pcId: string): Promise<string> {
    this.#check(pcId);
    return this.clipboard;
  }

  async clipboardSet(pcId: string, text: string): Promise<void> {
    this.#check(pcId);
    this.clipboard = text;
  }

  async exec(pcId: string, request: ExecRequest): Promise<ExecResult> {
    this.#check(pcId);
    const command = unwrapBash(request.command);
    const cwd = request.env?.MV_CWD ?? request.cwd ?? HOME;
    const res = this.shell.run(command, cwd);
    const output = `${res.output}\n__MV_PWD__${res.cwd}`;
    this.execs.push({ command, cwd, exitCode: res.exitCode, output: res.output });
    if (request.background) {
      // The scripted shell is instant: a background job has already ended, and says so right after it starts.
      const jobId = request.jobId ?? `job-${++this.#jobSeq}`;
      const outputPath = request.outputFile ? `${HOME}/.mv/jobs/${jobId}.out` : undefined;
      if (outputPath) this.fs.write(outputPath, res.output);
      this.#jobs.set(jobId, { tag: request.tag, output, exitCode: res.exitCode, running: false });
      setTimeout(() => {
        const exit: JobExit = {
          pcId,
          jobId,
          tag: request.tag,
          exitCode: res.exitCode,
          reason: 'exited',
          ...(outputPath ? { outputPath } : {}),
          durationMs: 40,
        };
        for (const l of [...this.#listeners]) l(exit);
      }, 0);
      return { kind: 'background', jobId, ...(outputPath ? { outputPath } : {}) };
    }
    const truncated = output.length > PC_LIMITS.maxOutputChars;
    return {
      kind: 'done',
      exitCode: res.exitCode,
      output: truncated ? output.slice(output.length - PC_LIMITS.maxOutputChars) : output,
      truncated,
      durationMs: 40,
    };
  }

  async jobOutput(pcId: string, jobId: string, fromOffset = 0): Promise<JobOutput> {
    this.#check(pcId);
    const job = this.#jobs.get(jobId);
    if (!job) throw new ApiError(PC_ERROR_CODES.UNKNOWN_JOB, `no job ${jobId}`);
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
    this.#check(pcId);
    if ('jobId' in target && !this.#jobs.has(target.jobId))
      throw new ApiError(PC_ERROR_CODES.UNKNOWN_JOB, 'no such job');
    return 0;
  }

  #abs(path: string): string {
    return MemFs.resolve(HOME, path, HOME);
  }

  #file(path: string): string {
    const p = this.#abs(path);
    if (this.fs.isDir(p)) throw new ApiError(PC_ERROR_CODES.NOT_A_FILE, `${p} is a directory`);
    const text = this.fs.read(p);
    if (text === undefined) throw new ApiError(PC_ERROR_CODES.NOT_FOUND, `no such file: ${p}`);
    return text;
  }

  async readFile(pcId: string, request: ReadRequest): Promise<ReadResult> {
    this.#check(pcId);
    const content = this.#file(request.path);
    if (content.length === 0) return { content: '', startLine: 1, totalLines: 0, truncated: false };
    // Claude Code's Read: a final newline ends in one more (empty) line.
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

  async writeFile(pcId: string, path: string, content: string): Promise<number> {
    this.#check(pcId);
    const p = this.#abs(path);
    if (this.fs.isDir(p)) throw new ApiError(PC_ERROR_CODES.NOT_A_FILE, `${p} is a directory`);
    this.fs.write(p, content);
    return Buffer.byteLength(content, 'utf8');
  }

  async editFile(pcId: string, request: EditRequest): Promise<number> {
    this.#check(pcId);
    const p = this.#abs(request.path);
    const content = this.#file(p);
    const count = request.oldString.length === 0 ? 0 : content.split(request.oldString).length - 1;
    if (count === 0) throw new ApiError(PC_ERROR_CODES.EDIT_NOT_FOUND, 'old_string not found in the file');
    if (count > 1 && !request.replaceAll) {
      throw new ApiError(PC_ERROR_CODES.EDIT_AMBIGUOUS, `old_string occurs ${count} times`);
    }
    const next = request.replaceAll
      ? content.split(request.oldString).join(request.newString)
      : content.replace(request.oldString, () => request.newString);
    this.fs.write(p, next);
    return request.replaceAll ? count : 1;
  }

  async glob(pcId: string, request: GlobRequest): Promise<GlobResult> {
    this.#check(pcId);
    const root = this.#abs(request.path ?? HOME);
    const pattern = request.pattern.startsWith('/')
      ? request.pattern
      : `${root.replace(/\/$/, '')}/${request.pattern}`;
    const re = globToRegExp(pattern);
    const paths = this.fs
      .walk(root)
      .filter((p) => re.test(p) && !p.includes('/.git/'))
      .sort();
    return { paths: paths.slice(0, 100), truncated: paths.length > 100, total: paths.length, countIsComplete: true };
  }

  async grep(pcId: string, request: GrepRequest): Promise<GrepResult> {
    this.#check(pcId);
    const root = this.#abs(request.path ?? HOME);
    const files = this.fs.isFile(root) ? [root] : this.fs.walk(root).filter((p) => !p.includes('/.git/'));
    const fileRe =
      request.glob !== undefined
        ? globToRegExp(`${root.replace(/\/$/, '')}/**/${request.glob.replace(/^\*\*\//, '')}`)
        : null;
    const typeExt: Record<string, string[]> = {
      js: ['.js', '.mjs', '.cjs'],
      ts: ['.ts'],
      md: ['.md'],
      json: ['.json'],
    };
    let re: RegExp;
    try {
      re = new RegExp(
        request.pattern,
        `${request.caseInsensitive ? 'i' : ''}${request.multiline ? 's' : ''}`,
      );
    } catch (err) {
      throw new ApiError(
        PC_ERROR_CODES.GUEST_ERROR,
        `regex parse error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const out: string[] = [];
    let matches = 0;
    let fileCount = 0;
    for (const path of files) {
      if (fileRe && !fileRe.test(path)) continue;
      if (request.type && !(typeExt[request.type] ?? [`.${request.type}`]).some((e) => path.endsWith(e)))
        continue;
      const content = this.fs.read(path) ?? '';
      if (content === '(binary)') continue;
      const lines = content.split('\n');
      const hits = lines.map((text, i) => ({ text, line: i + 1 })).filter((l) => re.test(l.text));
      if (hits.length === 0) continue;
      fileCount++;
      if (request.outputMode === 'files_with_matches') {
        out.push(path);
        matches++;
      } else if (request.outputMode === 'count') {
        out.push(`${path}:${hits.length}`);
        matches += hits.length;
      } else {
        for (const h of hits) {
          const parts = request.onlyMatching
            ? [...h.text.matchAll(new RegExp(re.source, `${re.flags}g`))].map((m) => m[0])
            : [h.text];
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
      ...(request.outputMode === 'count' ? { files: fileCount } : {}),
      truncated: limited.length < after.length,
    };
  }

  /** The repo's test file is unchanged. */
  testFileIntact(): boolean {
    const p = `${REPO}/test/cart.test.js`;
    return this.fs.read(p) === this.gitHead.get(p);
  }
}
