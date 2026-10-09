import { createHash } from 'node:crypto';
import type { SpacesdClientLike } from '@trycua/cua';
import { beforeEach, describe, expect, it } from 'vitest';
import { wrapBash } from '../../src/agents/tools/pcServer.js';
import type { ApiError } from '../../src/contracts/common.js';
import type { JobExit } from '../../src/contracts/PcApi.js';
import { PcGuestApi } from '../../src/pcs/GuestApi.js';
import {
  EDIT_READ_SCRIPT,
  EDIT_WRITE_SCRIPT,
  EXEC_PREFIX,
  GLOB_SCRIPT,
  GREP_SCRIPT,
  OPEN_SCRIPT,
  READ_SCRIPT,
  SWEEP_LAUNCH,
  WRITE_SCRIPT,
  ZOOM_SCRIPT,
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
  /** The process already exited: writing its stdin fails (the script refused early). */
  stdinGone = false;
  async writeStdin(data: ArrayBuffer): Promise<void> {
    if (this.stdinGone) throw new Error('process has exited (FailedPrecondition)');
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
  readonly runs: { script: string; args: string[]; env?: Map<string, string> }[] = [];
  readonly execs: FakeProc[] = [];
  /** JSON RPCs by method (without the `/cua.env.v1.` prefix), and every call made. */
  readonly rpc = new Map<string, (request: Record<string, unknown>) => unknown>();
  readonly rpcs: { method: string; request: Record<string, unknown> }[] = [];
  /** Guest files for stat/download. */
  readonly files = new Map<string, { data: Uint8Array; mtime: number }>();
  clipboard = '';
  /** Every stdin script exits before reading its input. */
  stdinGone = false;
  readonly client = {
    callJson: async (method: string, json: string) => {
      const name = method.replace('/cua.env.v1.', '');
      const request = JSON.parse(json) as Record<string, unknown>;
      this.rpcs.push({ method: name, request });
      const h = this.rpc.get(name);
      if (!h) throw new Error(`CuaError.Unimplemented: ${name}`);
      return JSON.stringify(await h(request));
    },
    stat: async (path: string) => {
      const f = this.files.get(path);
      if (!f) throw new Error(`CuaError.Env: env: not found: ${path} (NotFound)`);
      return {
        name: path,
        path,
        kind: 'file',
        size: BigInt(f.data.byteLength),
        mode: 0o644,
        modifiedMs: BigInt(f.mtime),
      };
    },
    download: async (path: string) => {
      const f = this.files.get(path);
      if (!f) throw new Error('not found (NotFound)');
      return f.data.slice().buffer;
    },
    run: async (cmd: { args: string[]; env?: Map<string, string> }) => {
      const [, script = '', , ...args] = cmd.args;
      const extraEnv = cmd.env && [...cmd.env.keys()].some((k) => k !== 'HOME' && k !== 'LC_ALL');
      this.runs.push({ script, args, ...(extraEnv && cmd.env ? { env: cmd.env } : {}) });
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
        const p = new FakeProc(cmd, (stdin) =>
          (this.scripts.get(script) ?? (() => ({ code: 0 })))(args, stdin),
        );
        p.stdinGone = this.stdinGone;
        return p;
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
      'keyboard {"press":{"key":{"character":"s"},"modifiers":["KEY_CONTROL"]}}',
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

  it('a write the script refuses before reading its input is DENIED, not a transport error', async () => {
    sit();
    guest.stdinGone = true;
    guest.scripts.set(WRITE_SCRIPT, () => ({
      code: 5,
      stderr: 'guest: line 5: /ro/x: Read-only file system',
    }));
    const e = await api.writeFile('linux-1', '/ro/x', 'data').catch((x: ApiError) => x);
    expect(e).toMatchObject({ code: 'DENIED', message: '/ro/x: Read-only file system' });
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
    // A UTF-8 byte-order mark survives the edit (the decoder would otherwise eat it).
    const bom = '\uFEFFname = old\r\n';
    let bomWrite: Buffer | null = null;
    guest.scripts.set(EDIT_READ_SCRIPT, () => ({ code: 0, stdout: bom }));
    guest.scripts.set(EDIT_WRITE_SCRIPT, (args, stdin) => {
      bomWrite = stdin;
      expect(args[1]).toBe(createHash('sha256').update(bom).digest('hex'));
      return { code: 0 };
    });
    expect(await api.editFile('linux-1', { path: '/w/b.ini', oldString: 'old', newString: 'new' })).toBe(1);
    expect((bomWrite as Buffer | null)?.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
    expect((bomWrite as Buffer | null)?.toString('utf8')).toBe('\uFEFFname = new\r\n');
    guest.scripts.set(EDIT_READ_SCRIPT, () => ({ code: 0, stdout: 'bin\u0000ary' }));
    expect(await codeOf(api.editFile('linux-1', { path: '/w/b', oldString: 'bin', newString: 'x' }))).toBe(
      'NOT_A_FILE',
    );
  });

  it('globs relative to the directory, newest first, capped at 100', async () => {
    guest.scripts.set(GLOB_SCRIPT, () => ({
      code: 0,
      stdout: `${Array.from({ length: 100 }, (_, i) => `./src/f${i}.ts`).join('\n')}\n__MV_TOTAL__140\n`,
    }));
    const r = await api.glob('linux-1', { pattern: '*.ts', path: '/w' });
    expect(guest.runs.at(-1)).toEqual({ script: GLOB_SCRIPT, args: ['/w', '/*.ts', '100', '10000'] });
    expect(r.paths[0]).toBe('/w/src/f0.ts');
    expect(r.paths).toHaveLength(100);
    expect(r).toMatchObject({ truncated: true, total: 140, countIsComplete: true });
    guest.scripts.set(GLOB_SCRIPT, () => ({ code: 0, stdout: './a.ts\n__MV_TOTAL__1\n' }));
    expect(await api.glob('linux-1', { pattern: '*.ts', path: '/w' })).toEqual({
      paths: ['/w/a.ts'],
      truncated: false,
      total: 1,
      countIsComplete: true,
    });
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
      total: 1,
      truncated: false,
    });
    expect(await api.grep('linux-1', { pattern: 'needle', path: '/w', outputMode: 'count' })).toMatchObject({
      matches: 3,
      files: 2,
    });
    expect(
      await api.grep('linux-1', {
        pattern: 'needle',
        path: '/w',
        outputMode: 'files_with_matches',
        headLimit: 1,
      }),
    ).toEqual({ output: '/w/a.ts', matches: 2, total: 2, truncated: true });
    // Offset first, then the head limit (V1 applied the offset after the guest's limit).
    expect(
      await api.grep('linux-1', {
        pattern: 'needle',
        path: '/w',
        outputMode: 'files_with_matches',
        offset: 1,
        headLimit: 1,
      }),
    ).toEqual({ output: '/w/b.ts', matches: 2, total: 2, truncated: false });
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

  it('refuses a call from an earlier seat of the same agent: nothing starts under a tag no kill will reach', async () => {
    sit('ada', 4);
    const e = await api.exec('linux-1', { command: 'npm run dev', tag: 'ada:3' }).catch((x: ApiError) => x);
    expect(e).toMatchObject({ code: 'DENIED', message: expect.stringMatching(/ada:3 has ended/) });
    expect(guest.execs).toHaveLength(0);
    // A seat whose epoch the mod did not report still runs the agent's commands.
    seats.seat('linux-1', { kind: 'agent', agentId: 'ada', seatEpoch: null });
    const run = api.exec('linux-1', { command: 'true', tag: 'ada:7' });
    await new Promise((r) => setTimeout(r, 10));
    (guest.execs[0] as FakeProc).exit({ code: 0 });
    expect(await run).toMatchObject({ kind: 'done', exitCode: 0 });
  });

  it('a command whose seat ends while it starts is killed with everything it started', async () => {
    sit('ada', 3);
    guest.scripts.set(SWEEP_LAUNCH, () => ({ code: 0, stdout: '1\n' }));
    const spawn = guest.client.spawn;
    guest.client.spawn = async (cmd) => {
      const p = await spawn(cmd);
      // The kick lands while spacesd is starting the process (the seat's kill sweep found nothing yet).
      seats.unseat('linux-1', { kind: 'agent', agentId: 'ada' }, false);
      return p;
    };
    const e = await api
      .exec('linux-1', { command: 'sleep 999', background: true, tag: 'ada:3' })
      .catch((x: ApiError) => x);
    expect(e).toMatchObject({ code: 'DENIED' });
    const p = guest.execs[0] as FakeProc;
    expect(p.killed).toBe(true);
    const sweep = guest.runs.find((r) => r.script === SWEEP_LAUNCH);
    expect(sweep?.args.slice(0, 2)).toEqual(['MV_CALL', p.command.env.get('MV_CALL')]);
  });

  it('a command that starts while its agent is away asking the player keeps running', async () => {
    sit('ada', 3);
    const spawn = guest.client.spawn;
    guest.client.spawn = async (cmd) => {
      const p = await spawn(cmd);
      seats.unseat('linux-1', { kind: 'agent', agentId: 'ada' }, true);
      return p;
    };
    const started = await api.exec('linux-1', { command: 'npm run dev', background: true, tag: 'ada:3' });
    expect(started.kind).toBe('background');
    expect((guest.execs[0] as FakeProc).killed).toBe(false);
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

  it('kills sweep the guest before killing handles, so children are found under their tagged parent', async () => {
    sit('ada', 3);
    // What the sweep saw: whether the shell it walks down from was still alive.
    const parentAlive: boolean[] = [];
    let job: FakeProc | null = null;
    guest.scripts.set(SWEEP_LAUNCH, () => {
      parentAlive.push(job !== null && !job.killed);
      return { code: 0, stdout: '3\n' };
    });
    const bg = await api.exec('linux-1', { command: 'sudo -n sleep 274', background: true, tag: 'ada:3' });
    job = guest.execs[0] as FakeProc;
    expect(await api.kill('linux-1', { jobId: (bg as { jobId: string }).jobId })).toBe(3);
    const next = await api.exec('linux-1', { command: 'sudo -n sleep 275', background: true, tag: 'ada:3' });
    job = guest.execs[1] as FakeProc;
    expect(await api.killTag('linux-1', 'ada:3')).toBe(3);
    expect(parentAlive).toEqual([true, true]);
    expect((guest.execs[0] as FakeProc).killed && (guest.execs[1] as FakeProc).killed).toBe(true);
    expect((await api.jobOutput('linux-1', (next as { jobId: string }).jobId)).running).toBe(false);
    // A PC that is stopping cannot be swept: the handles are what is killed, and counted.
    await api.exec('linux-1', { command: 'sleep 9', background: true, tag: 'ada:3' });
    statuses.set('linux-1', { status: 'stopping' });
    expect(await api.killTag('linux-1', 'ada:3')).toBe(1);
    expect(parentAlive).toHaveLength(2);
    expect((guest.execs[2] as FakeProc).killed).toBe(true);
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

describe('PC tools V2: input', () => {
  it('clicks at the pointer, with modifiers, a triple click; buttons and wheels without a position', async () => {
    sit();
    await api.pointer('linux-1', { action: 'click', button: 'left', count: 3 });
    await api.pointer('linux-1', { action: 'click', x: 5, y: 6, modifiers: ['ctrl', 'shift'] });
    await api.pointer('linux-1', { action: 'down' });
    await api.pointer('linux-1', { action: 'up' });
    await api.pointer('linux-1', { action: 'scroll', dx: 0, dy: 3 });
    await api.pointer('linux-1', { action: 'scroll', x: 10, y: 20, dx: 0, dy: -2, modifiers: ['ctrl'] });
    await api.pointer('linux-1', { action: 'drag', x: 1, y: 2, toX: 3, toY: 4, modifiers: ['shift'] });
    expect(inputCalls).toEqual([
      'pointer {"click":{"button":"MOUSE_BUTTON_LEFT","count":3}}',
      'pointer {"click":{"position":{"x":5,"y":6},"button":"MOUSE_BUTTON_LEFT","count":1,"modifiers":["KEY_CONTROL","KEY_SHIFT"]}}',
      'pointer {"down":{"button":"MOUSE_BUTTON_LEFT"}}',
      'pointer {"up":{"button":"MOUSE_BUTTON_LEFT"}}',
      'pointer {"scroll":{"deltaX":0,"deltaY":3,"unit":"SCROLL_UNIT_LINE"}}',
      'keyboard {"down":{"key":{"named":"KEY_CONTROL"}}}',
      'pointer {"scroll":{"position":{"x":10,"y":20},"deltaX":0,"deltaY":-2,"unit":"SCROLL_UNIT_LINE"}}',
      'keyboard {"up":{"key":{"named":"KEY_CONTROL"}}}',
      'pointer {"drag":{"from":{"x":1,"y":2},"to":{"x":3,"y":4},"button":"MOUSE_BUTTON_LEFT","modifiers":["KEY_SHIFT"]}}',
    ]);
    expect(router.held('linux-1')).toEqual({ keys: [], buttons: [] });
  });

  it('presses chords with spacesd modifiers and repeat, sequences in order, and holds keys', async () => {
    sit();
    await api.keyboard('linux-1', { action: 'press', keys: ['KEY_PAGE_DOWN'], repeat: 3 });
    await api.keyboard('linux-1', { action: 'press', keys: ['ctrl', 'S'] });
    await api.keyboard('linux-1', { action: 'sequence', chords: [['ctrl', 'a'], ['Delete']] });
    await api.keyboard('linux-1', { action: 'hold', keys: ['shift'], ms: 20 });
    expect(inputCalls).toEqual([
      'keyboard {"press":{"key":{"named":"KEY_PAGE_DOWN"},"repeat":3}}',
      'keyboard {"press":{"key":{"character":"s"},"modifiers":["KEY_CONTROL"]}}',
      'keyboard {"press":{"key":{"character":"a"},"modifiers":["KEY_CONTROL"]}}',
      'keyboard {"press":{"key":{"named":"KEY_DELETE"}}}',
      'keyboard {"down":{"key":{"named":"KEY_SHIFT"}}}',
      'keyboard {"up":{"key":{"named":"KEY_SHIFT"}}}',
    ]);
    expect(router.held('linux-1').keys).toEqual([]);
  });

  it('a hold is cut short when the player takes the chair, and its keys are released', async () => {
    sit();
    const hold = api.keyboard('linux-1', { action: 'hold', keys: ['alt'], ms: 60_000 });
    await new Promise((r) => setTimeout(r, 20));
    expect(router.held('linux-1').keys).toEqual(['KEY_ALT']);
    const t0 = Date.now();
    router.setOccupant('linux-1', { kind: 'player', id: 'player' });
    await hold.catch(() => {});
    await router.idle('linux-1');
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(router.held('linux-1').keys).toEqual([]);
  });
});

describe('PC tools V2: screen, windows and accessibility', () => {
  it('reads the cursor and the windows (focused first, mirror and all)', async () => {
    guest.rpc.set('ComputerService/GetCursorPosition', () => ({
      position: { x: 700, y: 500 },
      displayId: '0',
    }));
    expect(await api.cursor('linux-1')).toEqual({ x: 700, y: 500 });
    guest.rpc.set('WindowsService/ListWindows', () => ({
      windows: [
        {
          ref: { id: 'w1', epoch: '1' },
          title: 'Shell: ada',
          app: { name: 'Xfce4-terminal', pid: 9 },
          zOrder: 4,
          onScreen: true,
        },
        {
          ref: { id: 'w2', epoch: '1' },
          title: 'notes - Mousepad',
          app: { name: 'Mousepad', pid: 7 },
          bounds: { x: 5, y: 56, width: 640, height: 480 },
          state: 'WINDOW_STATE_MAXIMIZED',
          focused: true,
          onScreen: true,
          zOrder: 3,
        },
      ],
    }));
    expect(await api.windows('linux-1')).toEqual([
      {
        id: 'w2',
        title: 'notes - Mousepad',
        app: 'Mousepad',
        pid: 7,
        bounds: { x: 5, y: 56, w: 640, h: 480 },
        focused: true,
        state: 'MAXIMIZED',
        onScreen: true,
        z: 3,
      },
      { id: 'w1', title: 'Shell: ada', app: 'Xfce4-terminal', pid: 9, focused: false, onScreen: true, z: 4 },
    ]);
  });

  it('window operations need the seated agent and map a gone window to WINDOW_NOT_FOUND', async () => {
    expect(await codeOf(api.window('linux-1', 'w2', 'activate'))).toBe('DENIED');
    sit();
    guest.rpc.set('WindowsService/CloseWindow', () => {
      throw new Error('CuaError.Env: env: target unavailable: window is gone (NotFound)');
    });
    guest.rpc.set('WindowsService/ActivateWindow', () => ({ window: {} }));
    await api.window('linux-1', 'w2', 'activate');
    expect(guest.rpcs.at(-1)).toEqual({
      method: 'WindowsService/ActivateWindow',
      request: { window: { id: 'w2' } },
    });
    expect(await codeOf(api.window('linux-1', 'w2', 'close'))).toBe('WINDOW_NOT_FOUND');
  });

  it('finds, reads and acts on accessibility elements; an expired snapshot is STALE_REF', async () => {
    guest.rpc.set('AccessibilityService/Find', () => ({
      snapshotId: 'ax-1',
      nodes: [
        {
          elementId: '3',
          depth: 4,
          role: 'button',
          nativeRole: 'push button',
          name: 'Home',
          bounds: { x: 102, y: 85, width: 31, height: 31 },
          states: ['enabled'],
          actions: ['ACCESSIBILITY_ACTION_PRESS'],
        },
        { elementId: '9', depth: 2, role: 'paragraph', name: 'Hi￼ there', states: ['enabled'], actions: [] },
      ],
    }));
    const found = await api.uiFind('linux-1', { windowId: 'w2', nameContains: 'home', maxResults: 5 });
    expect(guest.rpcs.at(-1)?.request).toEqual({
      window: { id: 'w2' },
      query: { nameContains: 'home' },
      maxResults: 5,
    });
    expect(found.snapshotId).toBe('ax-1');
    expect(found.nodes[0]).toEqual({
      elementId: '3',
      depth: 4,
      role: 'button',
      nativeRole: 'push button',
      name: 'Home',
      bounds: { x: 102, y: 85, w: 31, h: 31 },
      states: ['enabled'],
      actions: ['press'],
    });
    expect(found.nodes[1]?.name).toBe('Hi there');
    expect(await codeOf(api.uiAct('linux-1', { snapshotId: 'ax-1', elementId: '3', action: 'press' }))).toBe(
      'DENIED',
    );
    sit();
    guest.rpc.set('AccessibilityService/Act', (req) => {
      if ((req.element as { snapshotId: string }).snapshotId === 'ax-old') {
        throw new Error(
          'CuaError.Env: env: stale accessibility snapshot: unknown or expired snapshot_id (FailedPrecondition)',
        );
      }
      return { report: { delivery: 'DELIVERY_BACKGROUND' } };
    });
    await api.uiAct('linux-1', { snapshotId: 'ax-1', elementId: '3', action: 'set_value', value: '/tmp' });
    expect(guest.rpcs.at(-1)?.request).toEqual({
      element: { snapshotId: 'ax-1', elementId: '3' },
      action: 'ACCESSIBILITY_ACTION_SET_VALUE',
      value: '/tmp',
    });
    expect(
      await codeOf(api.uiAct('linux-1', { snapshotId: 'ax-old', elementId: '3', action: 'press' })),
    ).toBe('STALE_REF');
  });

  it('a PC whose spacesd lists no a11y feature refuses accessibility calls', async () => {
    (guest.client as unknown as { capabilities: () => Promise<unknown> }).capabilities = async () => ({
      osName: 'Ubuntu',
      osVersion: '24.04',
      features: [{ name: 'windows', supported: true }],
    });
    api.forgetGuest('linux-1');
    expect(await codeOf(api.uiTree('linux-1', {}))).toBe('A11Y_UNAVAILABLE');
  });

  it('captures a region through spacesd, or scaled up by the guest for zoom', async () => {
    guest.rpc.set('ComputerService/Screenshot', () => ({
      image: Buffer.from([0xff, 0xd8, 1, 0xff, 0xd9]).toString('base64'),
      imageSize: { width: 200, height: 100 },
    }));
    const shot = await api.screenshot('linux-1', { region: { x: 100, y: 100, w: 200, h: 100 } });
    expect(guest.rpcs.at(-1)?.request).toMatchObject({
      region: { x: 100, y: 100, width: 200, height: 100 },
      format: 'IMAGE_FORMAT_JPEG',
    });
    expect(shot).toMatchObject({ w: 200, h: 100, mime: 'image/jpeg' });
    guest.scripts.set(ZOOM_SCRIPT, () => ({ code: 0, stdout: 'ÿØzoomed' }));
    const zoom = await api.screenshot('linux-1', {
      region: { x: 100, y: 100, w: 200, h: 100 },
      fit: { w: 1440, h: 900 },
    });
    expect(guest.runs.at(-1)).toMatchObject({
      script: ZOOM_SCRIPT,
      args: ['200x100+100+100', '1440x720!', '80'],
    });
    expect(zoom).toMatchObject({ w: 1440, h: 720 });
    // No ImageMagick: the region at full size.
    guest.scripts.set(ZOOM_SCRIPT, () => ({ code: 127 }));
    expect(
      await api.screenshot('linux-1', {
        region: { x: 100, y: 100, w: 200, h: 100 },
        fit: { w: 1440, h: 900 },
      }),
    ).toMatchObject({ w: 200, h: 100 });
  });

  it('opens a target as the seat, then finds and activates the window that appeared', async () => {
    sit();
    let calls = 0;
    guest.rpc.set('WindowsService/ListWindows', () => {
      calls++;
      const term = {
        ref: { id: 'w1' },
        title: 'Terminal',
        app: { name: 'Xfce4-terminal' },
        focused: calls <= 1,
        zOrder: 3,
      };
      const ff = {
        ref: { id: 'w9' },
        title: 'Example Domain — Mozilla Firefox',
        app: { name: 'firefox' },
        zOrder: 4,
      };
      return { windows: calls <= 1 ? [term] : [term, ff] };
    });
    guest.rpc.set('WindowsService/ActivateWindow', () => ({}));
    guest.scripts.set(OPEN_SCRIPT, () => ({ code: 0, stdout: 'via firefox\n' }));
    const r = await api.open('linux-1', { target: 'https://example.com', tag: 'ada:3', waitMs: 2_000 });
    expect(r).toMatchObject({ via: 'firefox', newWindow: true, window: { id: 'w9', focused: true } });
    const run = guest.runs.find((x) => x.script === OPEN_SCRIPT);
    expect(run?.args).toEqual(['https://example.com']);
    expect(run?.env?.get('MV_TAG')).toBe('ada:3');
    expect(run?.env?.get('DISPLAY')).toBe(':1');
    expect(guest.rpcs.some((x) => x.method === 'WindowsService/ActivateWindow')).toBe(true);
    guest.scripts.set(OPEN_SCRIPT, () => ({ code: 2, stdout: 'apps: firefox thunar\n' }));
    const e = await api.open('linux-1', { target: 'nope', tag: 'ada:3' }).catch((x: ApiError) => x);
    expect(e).toMatchObject({ code: 'OPEN_FAILED', message: expect.stringContaining('firefox thunar') });
    expect(await codeOf(api.open('linux-1', { target: 'x', tag: 'bram:3' }))).toBe('DENIED');
  });
});

describe('PC tools V2: files', () => {
  it('stat and readBytes go through spacesd; a missing path does not exist', async () => {
    guest.files.set('/w/a.png', { data: new Uint8Array([1, 2, 3]), mtime: 1_700_000_000_123 });
    expect(await api.stat('linux-1', '/w/a.png')).toEqual({
      exists: true,
      kind: 'file',
      size: 3,
      mtimeMs: 1_700_000_000_123,
    });
    expect(await api.stat('linux-1', '/w/none')).toEqual({ exists: false, size: 0, mtimeMs: 0 });
    expect([...(await api.readBytes('linux-1', '/w/a.png', 10))]).toEqual([1, 2, 3]);
    expect(await codeOf(api.readBytes('linux-1', '/w/a.png', 2))).toBe('DENIED');
    expect(await codeOf(api.readBytes('linux-1', '/w/none', 2))).toBe('NOT_FOUND');
  });

  it('a final newline makes one more, empty line (as Claude Code reads it)', async () => {
    guest.scripts.set(READ_SCRIPT, () => ({ code: 0, stdout: 'a\nb\n', stderr: '2 2 0 1\n' }));
    expect(await api.readFile('linux-1', { path: '/w/x' })).toEqual({
      content: 'a\nb\n',
      startLine: 1,
      totalLines: 3,
      truncated: false,
    });
    guest.scripts.set(READ_SCRIPT, () => ({ code: 0, stdout: 'a\n', stderr: '2 1 0 1\n' }));
    expect(await api.readFile('linux-1', { path: '/w/x', limit: 1 })).toEqual({
      content: 'a',
      startLine: 1,
      totalLines: 3,
      truncated: true,
    });
    guest.scripts.set(READ_SCRIPT, () => ({ code: 0, stdout: 'a\nb\n', stderr: '2 2 0 0\n' }));
    expect((await api.readFile('linux-1', { path: '/w/x' })).totalLines).toBe(2);
  });

  it('greps only the matched parts with -o', async () => {
    guest.scripts.set(GREP_SCRIPT, () => ({
      code: 0,
      stdout: `${JSON.stringify({
        type: 'match',
        data: {
          path: { text: '/w/a.ts' },
          line_number: 3,
          lines: { text: 'id=12 id=34\n' },
          submatches: [{ match: { text: 'id=12' } }, { match: { text: 'id=34' } }],
        },
      })}\n`,
    }));
    const r = await api.grep('linux-1', {
      pattern: 'id=\\d+',
      path: '/w',
      outputMode: 'content',
      onlyMatching: true,
    });
    expect(r.output).toBe('/w/a.ts:3:id=12\n/w/a.ts:3:id=34');
  });
});

describe('PC tools V2: background jobs', () => {
  it('a foreground command that overruns moves to the background with its output so far and its file kept', async () => {
    sit();
    const exits: JobExit[] = [];
    api.onJobExit((x) => exits.push(x));
    const run = api.exec('linux-1', {
      command: 'npm run build',
      timeoutMs: 1_000,
      tag: 'ada:3',
      onTimeout: 'background',
      jobId: 'b1234abcd',
      outputFile: true,
    });
    await new Promise((r) => setTimeout(r, 10));
    const p = guest.execs[0] as FakeProc;
    expect(p.command.env.get('MV_OUT')).toBe('/home/cua/.mv/jobs/b1234abcd.out');
    expect(p.command.env.has('MV_KEEP')).toBe(false);
    p.out('compiling…\n');
    const res = await run;
    expect(res).toMatchObject({
      kind: 'background',
      jobId: 'b1234abcd',
      outputPath: '/home/cua/.mv/jobs/b1234abcd.out',
      timedOutAfterMs: 1_000,
    });
    expect(p.killed).toBe(false);
    expect(guest.runs.some((r) => r.args[0] === '/home/cua/.mv/jobs/b1234abcd.out')).toBe(true);
    p.out('done\n');
    p.exit({ code: 0 });
    await new Promise((r) => setTimeout(r, 10));
    expect((await api.jobOutput('linux-1', 'b1234abcd')).output).toBe('compiling…\ndone\n');
    expect(exits).toMatchObject([{ jobId: 'b1234abcd', tag: 'ada:3', exitCode: 0, reason: 'exited' }]);
  });

  it('a background job keeps its file, is stopped at the end of its lifetime, and says why it ended', async () => {
    sit();
    guest.scripts.set(SWEEP_LAUNCH, () => ({ code: 0, stdout: '1\n' }));
    const exits: JobExit[] = [];
    api.onJobExit((x) => exits.push(x));
    const started = await api.exec('linux-1', {
      command: 'npm run dev',
      background: true,
      tag: 'ada:3',
      lifetimeMs: 1_000,
      jobId: 'bdev0001',
      outputFile: true,
    });
    expect(started).toMatchObject({ kind: 'background', jobId: 'bdev0001', lifetimeMs: 1_000 });
    expect((guest.execs[0] as FakeProc).command.env.get('MV_KEEP')).toBe('1');
    await new Promise((r) => setTimeout(r, 1_200));
    expect((guest.execs[0] as FakeProc).killed).toBe(true);
    expect(exits).toMatchObject([{ jobId: 'bdev0001', reason: 'lifetime', exitCode: 137 }]);
    // Stopped by id, and by the seat's end.
    await api.exec('linux-1', { command: 'a', background: true, tag: 'ada:3', jobId: 'bstop001' });
    await api.kill('linux-1', { jobId: 'bstop001' });
    await api.exec('linux-1', {
      command: 'b',
      background: true,
      tag: 'ada:3',
      jobId: 'bseat001',
      outputFile: true,
    });
    guest.runs.length = 0;
    await api.killTag('linux-1', 'ada:3');
    expect(exits.map((x) => `${x.jobId}:${x.reason}`)).toEqual([
      'bdev0001:lifetime',
      'bstop001:stopped',
      'bseat001:seat',
    ]);
    // The seat's job files are deleted.
    const rm = guest.runs.find((r) => r.script.startsWith('rm -f'));
    expect(rm?.args).toContain('/home/cua/.mv/jobs/bseat001.out');
    expect(await codeOf(api.exec('linux-1', { command: 'x', tag: 'ada:3', jobId: 'BAD id' }))).toBe(
      'GUEST_ERROR',
    );
  });
});
