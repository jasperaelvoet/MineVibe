import type { PcStatus, PcType } from '@minevibe/protocol';
import { ApiError } from './common.js';
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
} from './PcApi.js';

export interface FakePcInit {
  readonly pcId: string;
  readonly type?: PcType;
  readonly status?: PcStatus;
  /** Guest files by absolute path. */
  readonly files?: Readonly<Record<string, string>>;
}

interface FakeJob {
  readonly tag: string;
  running: boolean;
  exitCode: number | null;
  output: string;
}

interface FakePc {
  readonly pcId: string;
  readonly type: PcType;
  status: PcStatus;
  readonly files: Map<string, string>;
  clipboard: string;
  readonly jobs: Map<string, FakeJob>;
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

/**
 * An in-memory {@link PcApi} for tests: a guest file system per PC, scripted command results, background jobs that
 * run until {@link finishJob} or a kill, and a log of every input call. Not a sandbox and not a shell.
 */
export class FakePcApi implements PcApi {
  readonly #pcs = new Map<string, FakePc>();
  #jobSeq = 0;

  /** Every pointer, keyboard and type call, in order. */
  readonly input: { pcId: string; kind: 'pointer' | 'keyboard' | 'type'; value: unknown }[] = [];
  /** Every exec request, in order. */
  readonly execs: { pcId: string; request: ExecRequest }[] = [];
  /** What a foreground command returns (default: exit 0, no output). */
  execHandler: (pcId: string, request: ExecRequest) => { exitCode: number; output: string } = () => ({
    exitCode: 0,
    output: '',
  });

  constructor(pcs: readonly FakePcInit[] = [{ pcId: 'linux-1' }]) {
    for (const init of pcs) {
      this.#pcs.set(init.pcId, {
        pcId: init.pcId,
        type: init.type ?? 'linux',
        status: init.status ?? 'running',
        files: new Map(Object.entries(init.files ?? {})),
        clipboard: '',
        jobs: new Map(),
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

  /** Ends a background job. */
  finishJob(pcId: string, jobId: string, exitCode: number, output = ''): void {
    const job = this.#job(this.#known(pcId), jobId);
    job.output += output;
    job.running = false;
    job.exitCode = exitCode;
  }

  async info(pcId: string): Promise<PcGuestInfo> {
    const pc = this.#known(pcId);
    return {
      pcId,
      type: pc.type,
      status: pc.status,
      os: pc.type === 'macos' ? 'macos' : 'linux',
      screen: { w: 1280, h: 800 },
      user: 'cua',
      home: HOME,
      mounts: [],
      codexPath: '/mnt/codex',
    };
  }

  async screenshot(pcId: string, options: { maxDim?: number | undefined } = {}): Promise<Screenshot> {
    this.#running(pcId);
    const scale = options.maxDim !== undefined ? Math.min(1, options.maxDim / 1280) : 1;
    return {
      mime: 'image/jpeg',
      data: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
      w: Math.round(1280 * scale),
      h: Math.round(800 * scale),
    };
  }

  async pointer(pcId: string, action: PointerAction): Promise<void> {
    this.#running(pcId);
    this.input.push({ pcId, kind: 'pointer', value: action });
  }

  async keyboard(pcId: string, action: KeyboardAction): Promise<void> {
    this.#running(pcId);
    this.input.push({ pcId, kind: 'keyboard', value: action });
  }

  async type(pcId: string, text: string): Promise<void> {
    this.#running(pcId);
    this.input.push({ pcId, kind: 'type', value: text });
  }

  async clipboardGet(pcId: string): Promise<string> {
    return this.#running(pcId).clipboard;
  }

  async clipboardSet(pcId: string, text: string): Promise<void> {
    this.#running(pcId).clipboard = text;
  }

  async exec(pcId: string, request: ExecRequest): Promise<ExecResult> {
    const pc = this.#running(pcId);
    this.execs.push({ pcId, request });
    const timeoutMs = Math.min(request.timeoutMs ?? PC_LIMITS.defaultTimeoutMs, PC_LIMITS.maxTimeoutMs);
    if (request.background) {
      const jobId = `job-${++this.#jobSeq}`;
      pc.jobs.set(jobId, { tag: request.tag, running: true, exitCode: null, output: '' });
      return { kind: 'background', jobId };
    }
    if (timeoutMs <= 0) throw new ApiError(PC_ERROR_CODES.TIMEOUT, `timed out after ${timeoutMs} ms`);
    const { exitCode, output } = this.execHandler(pcId, request);
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
    for (const [jobId, job] of pc.jobs) {
      const hit = 'jobId' in target ? jobId === target.jobId : job.tag === target.tag;
      if (hit && job.running) {
        job.running = false;
        job.exitCode = 137;
        killed++;
      }
    }
    if ('jobId' in target && !pc.jobs.has(target.jobId))
      throw new ApiError(PC_ERROR_CODES.UNKNOWN_JOB, 'no such job');
    return killed;
  }

  async readFile(pcId: string, request: ReadRequest): Promise<ReadResult> {
    const content = this.#file(this.#running(pcId), request.path);
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
    this.#running(pcId).files.set(absolute(HOME, path), content);
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
    return request.replaceAll ? count : 1;
  }

  async glob(pcId: string, request: GlobRequest): Promise<{ paths: string[]; truncated: boolean }> {
    const pc = this.#running(pcId);
    const re = globToRegExp(absolute(request.path ?? HOME, request.pattern));
    const paths = [...pc.files.keys()].filter((p) => re.test(p)).sort();
    return { paths: paths.slice(0, 100), truncated: paths.length > 100 };
  }

  async grep(pcId: string, request: GrepRequest): Promise<GrepResult> {
    const pc = this.#running(pcId);
    const root = absolute(HOME, request.path ?? HOME).replace(/\/+$/, '');
    const fileRe = request.glob !== undefined ? globToRegExp(absolute(root, `**/${request.glob}`)) : null;
    const re = new RegExp(
      request.pattern,
      `${request.caseInsensitive ? 'i' : ''}${request.multiline ? 's' : ''}`,
    );
    const out: string[] = [];
    let matches = 0;
    for (const [path, content] of [...pc.files].sort(([a], [b]) => a.localeCompare(b))) {
      if (path !== root && !path.startsWith(`${root}/`)) continue;
      if (fileRe && !fileRe.test(path)) continue;
      const hits = content
        .split('\n')
        .map((text, i) => ({ text, line: i + 1 }))
        .filter((l) => re.test(l.text));
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
    const limited = request.headLimit !== undefined ? out.slice(0, request.headLimit) : out;
    return { output: limited.join('\n'), matches, truncated: limited.length < out.length };
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
