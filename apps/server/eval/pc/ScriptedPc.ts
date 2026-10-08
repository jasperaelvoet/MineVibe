/**
 * The scripted PC of the tool evals: a {@link PcApi} for one Linux PC (`linux-1`) whose screen is the {@link Desktop}
 * state machine (real PNG frames), whose shell is the whitelist {@link Shell} over an in-memory file system with a
 * small failing repo, and whose file calls (Read, Write, Edit, Glob, Grep) follow the guest's semantics. The `pc`
 * tool server talks to it exactly as it talks to a real PC, `pc__bash` wrapper and `__MV_PWD__` marker included.
 */

import { ApiError } from '../../src/contracts/common.js';
import { globToRegExp } from '../../src/contracts/FakePcApi.js';
import {
  type EditRequest,
  type ExecRequest,
  type ExecResult,
  type GlobRequest,
  type GrepRequest,
  type GrepResult,
  type JobOutput,
  type KeyboardAction,
  PC_ERROR_CODES,
  PC_LIMITS,
  type PcApi,
  type PcGuestInfo,
  type PointerAction,
  type ReadRequest,
  type ReadResult,
  type Screenshot,
} from '../../src/contracts/PcApi.js';
import { HOME, homeFs, OS_RELEASE, REPO, type TestRun } from './content.js';
import { Desktop, SCREEN } from './desktop.js';
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
  screenshots = 0;
  clipboard = '';
  readonly #jobs = new Map<string, { tag: string; output: string; exitCode: number; running: boolean }>();
  #jobSeq = 0;

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

  async screenshot(pcId: string): Promise<Screenshot> {
    this.#check(pcId);
    this.screenshots++;
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
    switch (action.action) {
      case 'click':
        if ((action.button ?? 'left') === 'left') this.desktop.click(action.x, action.y);
        return;
      case 'double_click':
        this.desktop.click(action.x, action.y, true);
        return;
      default:
        return;
    }
  }

  async keyboard(pcId: string, action: KeyboardAction): Promise<void> {
    this.#check(pcId);
    this.input.push({ kind: 'keyboard', value: action });
    if (action.action === 'press') this.desktop.key(action.keys);
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
      const jobId = `job-${++this.#jobSeq}`;
      this.#jobs.set(jobId, { tag: request.tag, output, exitCode: res.exitCode, running: false });
      return { kind: 'background', jobId };
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
    const lines = content.replace(/\n$/, '').split('\n');
    const start = Math.max(1, request.offset ?? 1);
    const limit = request.limit ?? 2000;
    const selected = lines.slice(start - 1, start - 1 + limit);
    return {
      content: selected.length > 0 ? `${selected.join('\n')}\n` : '',
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

  async glob(pcId: string, request: GlobRequest): Promise<{ paths: string[]; truncated: boolean }> {
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
    return { paths: paths.slice(0, 100), truncated: paths.length > 100 };
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
    for (const path of files) {
      if (fileRe && !fileRe.test(path)) continue;
      if (request.type && !(typeExt[request.type] ?? [`.${request.type}`]).some((e) => path.endsWith(e)))
        continue;
      const content = this.fs.read(path) ?? '';
      if (content === '(binary)') continue;
      const lines = content.split('\n');
      const hits = lines.map((text, i) => ({ text, line: i + 1 })).filter((l) => re.test(l.text));
      if (hits.length === 0) continue;
      if (request.outputMode === 'files_with_matches') {
        out.push(path);
        matches++;
      } else if (request.outputMode === 'count') {
        out.push(`${path}:${hits.length}`);
        matches += hits.length;
      } else {
        for (const h of hits)
          out.push(request.lineNumbers ? `${path}:${h.line}:${h.text}` : `${path}:${h.text}`);
        matches += hits.length;
      }
    }
    const limited = request.headLimit ? out.slice(0, request.headLimit) : out;
    return { output: limited.join('\n'), matches, truncated: limited.length < out.length };
  }

  /** The repo's test file is unchanged. */
  testFileIntact(): boolean {
    const p = `${REPO}/test/cart.test.js`;
    return this.fs.read(p) === this.gitHead.get(p);
  }
}
