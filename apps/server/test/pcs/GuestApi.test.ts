import { createHash } from 'node:crypto';
import type { SpacesdClientLike } from '@trycua/cua';
import { beforeEach, describe, expect, it } from 'vitest';
import { wrapBash } from '../../src/agents/tools/pcServer.js';
import type { ApiError } from '../../src/contracts/common.js';
import { PcGuestApi } from '../../src/pcs/GuestApi.js';
import {
  EDIT_READ_SCRIPT,
  EDIT_WRITE_SCRIPT,
  EXEC_PREFIX,
  GLOB_SCRIPT,
  GREP_SCRIPT,
  READ_SCRIPT,
  SWEEP_LAUNCH,
  WRITE_SCRIPT,
} from '../../src/pcs/guest.js';
import { type InputClient, InputRouter } from '../../src/pcs/InputRouter.js';
import type { PcRecord, PcStatusInfo } from '../../src/pcs/PcManager.js';
import { SeatBook } from '../../src/pcs/SeatBook.js';

type Ev = { kind: number; offset: bigint; data: ArrayBuffer; exit?: Record<string, unknown> };
const buf = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer;

/** A guest process whose events the test pushes. */
class FakeProc {
  readonly events: Ev[] = [];
  readonly stdin: Uint8Array[] = [];
  killed = false;
  #waiters: (() => void)[] = [];
  constructor(
    readonly command: { program: string; args: string[]; env: Map<string, string>; user?: string },
    readonly onWait?: (stdin: Buffer) => { code: number; stdout?: string; stderr?: string },
  ) {}
  push(ev: Ev): void {
    this.events.push(ev);
    for (const w of this.#waiters.splice(0)) w();
  }
  out(text: string): void {
    this.push({ kind: 0, offset: 0n, data: buf(text) });
  }
  exit(exit: Record<string, unknown>): void {
    this.push({
      kind: 3,
      offset: 0n,
      data: new ArrayBuffer(0),
      exit: { timedOut: false, success: exit.code === 0, ...exit },
    });
  }
  async nextEvent(o?: { signal: AbortSignal }): Promise<Ev | undefined> {
    for (;;) {
      const ev = this.events.shift();
      if (ev) return ev;
      if (o?.signal.aborted) throw new Error('aborted');
      await new Promise<void>((resolve, reject) => {
        this.#waiters.push(resolve);
        o?.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    }
  }
  async kill(): Promise<void> {
    this.killed = true;
    this.exit({ signal: 'kill' });
  }
  async writeStdin(data: ArrayBuffer): Promise<void> {
    this.stdin.push(new Uint8Array(data));
  }
  async closeStdin(): Promise<void> {}
  async wait() {
    const r = this.onWait?.(Buffer.concat(this.stdin)) ?? { code: 0 };
    return {
      exit: { code: r.code, timedOut: false, success: r.code === 0 },
      stdout: buf(r.stdout ?? ''),
      stderr: buf(r.stderr ?? ''),
      pty: new ArrayBuffer(0),
    };
  }
}

type ScriptHandler = (args: string[], stdin: Buffer) => { code: number; stdout?: string; stderr?: string };

/** A fake spacesd: guest scripts answered by handlers keyed by the script, `bash -lc` spawns become FakeProcs. */
class FakeGuest {
  readonly scripts = new Map<string, ScriptHandler>();
  readonly runs: { script: string; args: string[] }[] = [];
  readonly execs: FakeProc[] = [];
  clipboard = '';
  readonly client = {
    run: async (cmd: { args: string[] }) => {
      const [, script = '', , ...args] = cmd.args;
      this.runs.push({ script, args });
      const h = this.scripts.get(script);
      const r = h ? h(args, Buffer.alloc(0)) : { code: 0 };
      return {
        exit: { code: r.code, timedOut: false, success: r.code === 0 },
        stdout: buf(r.stdout ?? ''),
        stderr: buf(r.stderr ?? ''),
        pty: new ArrayBuffer(0),
      };
    },
    spawn: async (cmd: { program: string; args: string[]; env: Map<string, string>; stdin: boolean }) => {
      if (cmd.stdin) {
        const [, script = '', , ...args] = cmd.args;
        this.runs.push({ script, args });
        return new FakeProc(cmd, (stdin) => (this.scripts.get(script) ?? (() => ({ code: 0 })))(args, stdin));
      }
      const p = new FakeProc(cmd);
      this.execs.push(p);
      return p;
    },
    displays: async () => JSON.stringify([{ primary: true, bounds: { width: 1440, height: 900 } }]),
    capabilities: async () => ({ osName: 'Ubuntu', osVersion: '24.04' }),
    screenshot: async (o: { maxDimension?: number }) => ({
      image: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]).buffer,
      width: Math.min(1440, o.maxDimension ?? 1440),
      height: Math.round((Math.min(1440, o.maxDimension ?? 1440) * 900) / 1440),
      format: 1,
      scale: 1,
      screenshotId: 's',
    }),
    getClipboard: async () => this.clipboard,
    setClipboard: async (t: string) => {
      this.clipboard = t;
      return 1n;
    },
  };
}

const record = (id: string, type: PcRecord['type'] = 'linux'): PcRecord =>
  ({
    id,
    slot: 1,
    type,
    cpus: 2,
    memMiB: 4096,
    shmMiB: 2048,
    disk: { homeGiB: 1, overlayGiB: 1, tmpGiB: 1, varTmpGiB: 1, rootfsGiB: 1 },
    mounts: [{ host: '/Users/me/Code/foo', ro: false, overlays: [] }],
    pinned: false,
    plugged: true,
    createdAt: 0,
  }) as PcRecord;

let guest: FakeGuest;
let seats: SeatBook;
let router: InputRouter;
let inputCalls: string[];
let statuses: Map<string, PcStatusInfo>;
let api: PcGuestApi;

beforeEach(() => {
  guest = new FakeGuest();
  seats = new SeatBook();
  inputCalls = [];
  const input: InputClient = {
    pointerJson: async (j) => {
      inputCalls.push(`pointer ${j}`);
      return '{}';
    },
    keyboardJson: async (j) => {
      inputCalls.push(`keyboard ${j}`);
      return '{}';
    },
    typeText: async (t) => {
      inputCalls.push(`type ${t}`);
    },
    hotkey: async (k) => {
      inputCalls.push(`hotkey ${k.join('+')}`);
    },
  };
  router = new InputRouter({ getClient: async () => input });
  statuses = new Map([['linux-1', { status: 'running' }]]);
  const recs = new Map([['linux-1', record('linux-1')]]);
  api = new PcGuestApi({
    pcs: { get: (id) => recs.get(id), status: (id) => statuses.get(id) ?? { status: 'off' } },
    client: async () => guest.client as unknown as SpacesdClientLike,
    router,
    seats,
    jpegFormat: () => 1,
    scriptTimeoutMs: 2_000,
  });
});

const sit = (agentId = 'ada', seatEpoch = 3) => {
  seats.seat('linux-1', { kind: 'agent', agentId, seatEpoch });
  router.setOccupant('linux-1', { kind: 'agent', id: agentId });
};
const codeOf = async (p: Promise<unknown>) =>
  (
    (await p.then(
      () => null,
      (e: unknown) => e,
    )) as ApiError | null
  )?.code;

describe('PC state checks', () => {
  it('PC_UNKNOWN and PC_DOWN', async () => {
    expect(await codeOf(api.readFile('nope', { path: '/x' }))).toBe('PC_UNKNOWN');
    statuses.set('linux-1', { status: 'booting', progress: 30 });
    expect(await codeOf(api.readFile('linux-1', { path: '/x' }))).toBe('PC_DOWN');
  });

  it('mutating calls need an agent in the chair, not the player', async () => {
    expect(await codeOf(api.writeFile('linux-1', '/x', 'y'))).toBe('DENIED');
    seats.seat('linux-1', { kind: 'player' });
    expect(await codeOf(api.type('linux-1', 'hi'))).toBe('DENIED');
    expect(await codeOf(api.clipboardSet('linux-1', 'hi'))).toBe('DENIED');
    expect(await codeOf(api.exec('linux-1', { command: 'ls', tag: 'ada:3' }))).toBe('DENIED');
  });
});

describe('info and screenshot', () => {
  it('reports the guest: display, mounts, OS', async () => {
    const info = await api.info('linux-1');
    expect(info).toMatchObject({
      pcId: 'linux-1',
      os: 'linux',
      status: 'running',
      screen: { w: 1440, h: 900 },
      user: 'cua',
      home: '/home/cua',
      mounts: [{ hostPath: '/Users/me/Code/foo', mode: 'rw' }],
      cpus: 2,
      memoryMiB: 4096,
      osVersion: 'Ubuntu 24.04',
    });
  });

  it('returns a JPEG with its scale against the guest screen', async () => {
    const shot = await api.screenshot('linux-1', { maxDim: 720 });
    expect(shot).toMatchObject({
      mime: 'image/jpeg',
      w: 720,
      h: 450,
      screen: { w: 1440, h: 900 },
      scale: 0.5,
    });
  });
});

describe('input through the router as the seated agent', () => {
  it('clicks, types and presses chords; the player in the chair wins', async () => {
    sit();
    await api.pointer('linux-1', { action: 'double_click', x: 10, y: 20 });
    await api.keyboard('linux-1', { action: 'press', keys: ['ctrl', 's'] });
    await api.type('linux-1', 'hello');
    expect(inputCalls).toEqual([
      'pointer {"click":{"position":{"x":10,"y":20},"button":"MOUSE_BUTTON_LEFT","count":2}}',
      'hotkey KEY_CONTROL+s',
      'type hello',
    ]);
    seats.seat('linux-1', { kind: 'player' });
    router.setOccupant('linux-1', { kind: 'player', id: 'player' });
    expect(await codeOf(api.pointer('linux-1', { action: 'move', x: 1, y: 1 }))).toBe('DENIED');
  });

  it('clipboard', async () => {
    sit();
    await api.clipboardSet('linux-1', 'copied');
    expect(await api.clipboardGet('linux-1')).toBe('copied');
  });
});

describe('files in the guest', () => {
  it('reads selected lines with the totals from the script', async () => {
    guest.scripts.set(READ_SCRIPT, () => ({ code: 0, stdout: 'two\nthree\n', stderr: '9 2 0\n' }));
    const r = await api.readFile('linux-1', { path: '/w/a.txt', offset: 2, limit: 2 });
    expect(r).toEqual({ content: 'two\nthree', startLine: 2, totalLines: 9, truncated: true });
    expect(guest.runs.at(-1)).toEqual({
      script: READ_SCRIPT,
      args: ['/w/a.txt', '2', '2', String(256 * 1024)],
    });
  });

  it('maps the script exits to PcApi errors', async () => {
    for (const [code, want] of [
      [3, 'NOT_FOUND'],
      [4, 'NOT_A_FILE'],
      [5, 'DENIED'],
      [6, 'NOT_A_FILE'],
      [42, 'GUEST_ERROR'],
    ] as const) {
      guest.scripts.set(READ_SCRIPT, () => ({ code }));
      expect(await codeOf(api.readFile('linux-1', { path: '/w/a.txt' }))).toBe(want);
    }
  });

  it('writes through stdin and returns the bytes', async () => {
    sit();
    let got = '';
    guest.scripts.set(WRITE_SCRIPT, (args, stdin) => {
      got = `${args[0]}=${stdin.toString('utf8')}`;
      return { code: 0 };
    });
    expect(await api.writeFile('linux-1', '/w/new/é.txt', 'héllo')).toBe(6);
    expect(got).toBe('/w/new/é.txt=héllo');
  });

  it('edits exactly, writing back only over the content it read', async () => {
    sit();
    const before = 'const a = 1;\nconst b = 1;\n';
    let wrote: { sha: string; content: string } | null = null;
    guest.scripts.set(EDIT_READ_SCRIPT, () => ({ code: 0, stdout: before }));
    guest.scripts.set(EDIT_WRITE_SCRIPT, (args, stdin) => {
      wrote = { sha: args[1] as string, content: stdin.toString('utf8') };
      return { code: 0 };
    });
    expect(await api.editFile('linux-1', { path: '/w/a.ts', oldString: 'b = 1', newString: 'b = 2' })).toBe(
      1,
    );
    expect(wrote).toEqual({
      sha: createHash('sha256').update(before).digest('hex'),
      content: 'const a = 1;\nconst b = 2;\n',
    });
    expect(
      await codeOf(api.editFile('linux-1', { path: '/w/a.ts', oldString: '= 1', newString: '= 9' })),
    ).toBe('EDIT_AMBIGUOUS');
    expect(
      await api.editFile('linux-1', {
        path: '/w/a.ts',
        oldString: '= 1',
        newString: '= 9',
        replaceAll: true,
      }),
    ).toBe(2);
    guest.scripts.set(EDIT_WRITE_SCRIPT, () => ({ code: 8 }));
    const e = await api
      .editFile('linux-1', { path: '/w/a.ts', oldString: 'a = 1', newString: 'a = 0' })
      .catch((x: ApiError) => x);
    expect(e).toMatchObject({
      code: 'GUEST_ERROR',
      message: expect.stringMatching(/changed while it was being edited/),
    });
    guest.scripts.set(EDIT_READ_SCRIPT, () => ({ code: 0, stdout: 'bin\u0000ary' }));
    expect(await codeOf(api.editFile('linux-1', { path: '/w/b', oldString: 'bin', newString: 'x' }))).toBe(
      'NOT_A_FILE',
    );
  });

  it('globs relative to the directory, newest first, capped at 100', async () => {
    guest.scripts.set(GLOB_SCRIPT, () => ({
      code: 0,
      stdout: Array.from({ length: 101 }, (_, i) => `./src/f${i}.ts`).join('\n'),
    }));
    const r = await api.glob('linux-1', { pattern: '*.ts', path: '/w' });
    expect(guest.runs.at(-1)).toEqual({ script: GLOB_SCRIPT, args: ['/w', '/*.ts', '101'] });
    expect(r.paths[0]).toBe('/w/src/f0.ts');
    expect(r.paths).toHaveLength(100);
    expect(r.truncated).toBe(true);
    await api.glob('linux-1', { pattern: '/home/cua/app/**/*.md' });
    expect(guest.runs.at(-1)?.args.slice(0, 2)).toEqual(['/home/cua/app', '**/*.md']);
  });

  it('greps with rg in every output mode', async () => {
    guest.scripts.set(GREP_SCRIPT, (args) => {
      if (args.includes('--json')) {
        return {
          code: 0,
          stdout: `${JSON.stringify({
            type: 'match',
            data: { path: { text: '/w/a.ts' }, line_number: 3, lines: { text: 'needle\n' } },
          })}\n`,
        };
      }
      if (args.includes('--count')) return { code: 0, stdout: '/w/a.ts:2\n/w/b.ts:1\n' };
      return { code: 0, stdout: '/w/a.ts\n/w/b.ts\n' };
    });
    expect(await api.grep('linux-1', { pattern: 'needle', path: '/w', outputMode: 'content' })).toEqual({
      output: '/w/a.ts:3:needle',
      matches: 1,
      truncated: false,
    });
    expect(await api.grep('linux-1', { pattern: 'needle', path: '/w', outputMode: 'count' })).toMatchObject({
      matches: 3,
    });
    expect(
      await api.grep('linux-1', {
        pattern: 'needle',
        path: '/w',
        outputMode: 'files_with_matches',
        headLimit: 1,
      }),
    ).toEqual({ output: '/w/a.ts', matches: 2, truncated: true });
    guest.scripts.set(GREP_SCRIPT, () => ({ code: 1 }));
    expect((await api.grep('linux-1', { pattern: 'x', outputMode: 'content' })).output).toBe('');
    guest.scripts.set(GREP_SCRIPT, () => ({
      code: 2,
      stderr: 'rg: /nope: No such file or directory (os error 2)',
    }));
    expect(await codeOf(api.grep('linux-1', { pattern: 'x', path: '/nope', outputMode: 'content' }))).toBe(
      'NOT_FOUND',
    );
    guest.scripts.set(GREP_SCRIPT, () => ({ code: 2, stderr: 'regex parse error: unclosed group' }));
    expect(await codeOf(api.grep('linux-1', { pattern: '(', outputMode: 'content' }))).toBe('GUEST_ERROR');
  });
});

describe('the shell', () => {
  it('runs bash -lc as cua with the tag, the call id and the cwd in the environment', async () => {
    sit();
    const command = wrapBash('npm test');
    const run = api.exec('linux-1', { command, cwd: '/w', env: { MV_CWD: '/w' }, tag: 'ada:3' });
    await new Promise((r) => setTimeout(r, 10));
    const p = guest.execs[0] as FakeProc;
    expect(p.command.program).toBe('bash');
    expect(p.command.args).toEqual(['-lc', `${EXEC_PREFIX}\n${command}`]);
    expect(p.command.user).toBe('cua');
    expect(p.command.env.get('MV_TAG')).toBe('ada:3');
    expect(p.command.env.get('MV_CWD')).toBe('/w');
    expect(p.command.env.get('MV_EXEC_CWD')).toBe('/w');
    expect(p.command.env.get('MV_CALL')).toMatch(/^[0-9a-f]{12}$/);
    expect(p.command.env.get('MV_PROMPT')).toContain('$ npm test');
    p.out('ok\n');
    p.out('\n__MV_PWD__/w/sub');
    p.exit({ code: 1 });
    expect(await run).toMatchObject({
      kind: 'done',
      exitCode: 1,
      output: 'ok\n\n__MV_PWD__/w/sub',
      truncated: false,
    });
  });

  it('refuses a tag of another agent', async () => {
    sit('ada');
    expect(await codeOf(api.exec('linux-1', { command: 'ls', tag: 'bram:3' }))).toBe('DENIED');
    expect(await codeOf(api.exec('linux-1', { command: 'ls', tag: 'not a tag' }))).toBe('DENIED');
  });

  it('kills a command that overruns its timeout, and everything it left behind', async () => {
    sit();
    guest.scripts.set(SWEEP_LAUNCH, () => ({ code: 0, stdout: '2\n' }));
    const run = api.exec('linux-1', { command: 'sleep 999', timeoutMs: 1_000, tag: 'ada:3' });
    const e = await run.catch((x: ApiError) => x);
    expect(e).toMatchObject({ code: 'TIMEOUT' });
    const p = guest.execs[0] as FakeProc;
    expect(p.killed).toBe(true);
    const sweep = guest.runs.find((r) => r.script === SWEEP_LAUNCH);
    expect(sweep?.args.slice(0, 2)).toEqual(['MV_CALL', p.command.env.get('MV_CALL')]);
  });

  it('background jobs: output by offset, owned by agent + seat epoch, killed by id or by tag', async () => {
    sit('ada', 3);
    guest.scripts.set(SWEEP_LAUNCH, () => ({ code: 0, stdout: '1\n' }));
    const started = await api.exec('linux-1', { command: 'npm run dev', background: true, tag: 'ada:3' });
    expect(started.kind).toBe('background');
    const jobId = (started as { jobId: string }).jobId;
    const p = guest.execs[0] as FakeProc;
    p.out('listening on 3000\n');
    await new Promise((r) => setTimeout(r, 10));
    const first = await api.jobOutput('linux-1', jobId);
    expect(first).toMatchObject({
      running: true,
      exitCode: null,
      output: 'listening on 3000\n',
      truncated: false,
    });
    p.out('GET /\n');
    await new Promise((r) => setTimeout(r, 10));
    expect((await api.jobOutput('linux-1', jobId, first.nextOffset)).output).toBe('GET /\n');
    // A new seat (another epoch) does not own the job.
    sit('ada', 4);
    expect(await codeOf(api.jobOutput('linux-1', jobId))).toBe('UNKNOWN_JOB');
    expect(await codeOf(api.kill('linux-1', { jobId }))).toBe('UNKNOWN_JOB');
    sit('ada', 3);
    expect(await api.kill('linux-1', { jobId })).toBeGreaterThanOrEqual(1);
    expect(p.killed).toBe(true);
    expect((await api.jobOutput('linux-1', jobId)).running).toBe(false);

    const second = await api.exec('linux-1', { command: 'tail -f x', background: true, tag: 'ada:3' });
    const q = guest.execs[1] as FakeProc;
    guest.runs.length = 0;
    expect(await api.kill('linux-1', { tag: 'ada:3' })).toBeGreaterThanOrEqual(1);
    expect(q.killed).toBe(true);
    expect(guest.runs.find((r) => r.script === SWEEP_LAUNCH)?.args.slice(0, 2)).toEqual(['MV_TAG', 'ada:3']);
    const out = await api.jobOutput('linux-1', (second as { jobId: string }).jobId);
    expect(out.running).toBe(false);
  });

  it('a job that exits reports its exit code', async () => {
    sit();
    const started = await api.exec('linux-1', { command: 'make', background: true, tag: 'ada:3' });
    const p = guest.execs[0] as FakeProc;
    p.out('done\n');
    p.exit({ code: 2 });
    await new Promise((r) => setTimeout(r, 10));
    expect(await api.jobOutput('linux-1', (started as { jobId: string }).jobId)).toMatchObject({
      running: false,
      exitCode: 2,
      output: 'done\n',
    });
  });
});
