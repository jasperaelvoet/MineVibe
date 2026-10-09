/**
 * The `pc` tool server, V2 (PLAN §6.2, PC tools V2): the trained computer-use members, accessibility perception,
 * Claude Code 2.1.293's file and shell formats, batches and end-of-batch screenshots, read-state, background jobs.
 * Everything runs against FakePcApi (a guest file system, scripted commands, a small desktop with windows and
 * accessibility elements); the real PC is covered by `npm run test:pcs`.
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HandoffNotes } from '../../../src/agents/memory.js';
import { PlanCapture } from '../../../src/agents/PlanCapture.js';
import { PC_TOOLS } from '../../../src/agents/tools/catalog.js';
import {
  BatchBook,
  createPcServer,
  type PcHost,
  PcJobBook,
  stripPwdMarker,
  wrapBash,
} from '../../../src/agents/tools/pcServer.js';
import { FakePcApi, type FakePcInit, type FakeWindow } from '../../../src/contracts/FakePcApi.js';
import type { PcGuestInfo } from '../../../src/contracts/PcApi.js';

type Content = { type: string; text?: string; data?: string; mimeType?: string };
type Registered = Record<
  string,
  {
    inputSchema?: { safeParse(v: unknown): { success: boolean; data?: unknown } };
    annotations?: { readOnlyHint?: boolean };
    handler: (a: unknown, e: unknown) => Promise<unknown>;
  }
>;

function registry(server: { instance: unknown }): Registered {
  return (server.instance as { _registeredTools: Registered })._registeredTools;
}

/** Calls a tool like the SDK would, with the tool_use id Claude Code puts into `_meta`. */
async function call(reg: Registered, name: string, args: Record<string, unknown>, toolUseId?: string) {
  const tool = reg[name];
  if (!tool) throw new Error(`no tool ${name}`);
  const parsed = tool.inputSchema ? tool.inputSchema.safeParse(args) : { success: true, data: args };
  if (!parsed.success) return { invalid: true, text: '', isError: true, content: [] as Content[] };
  const extra = toolUseId ? { _meta: { 'claudecode/toolUseId': toolUseId } } : {};
  const res = (await tool.handler(parsed.data, extra)) as { content: Content[]; isError?: boolean };
  return {
    invalid: false,
    text: res.content
      .filter((c) => c.type === 'text')
      .map((c) => c.text)
      .join('\n'),
    isError: res.isError === true,
    content: res.content,
    image: res.content.find((c) => c.type === 'image'),
  };
}

const VAULT = '/Users/jasper/Code/foo';

/** FakePcApi with a Vault folder mounted (the working directory). */
class VaultPcApi extends FakePcApi {
  override async info(pcId: string): Promise<PcGuestInfo> {
    return { ...(await super.info(pcId)), mounts: [{ hostPath: VAULT, mode: 'rw' as const }] };
  }
}

function setup(
  options: { init?: Partial<FakePcInit>; batch?: BatchBook; jobs?: PcJobBook; over?: Partial<PcHost> } = {},
) {
  const pcs = new VaultPcApi([
    {
      pcId: 'linux-1',
      files: {
        [`${VAULT}/a.ts`]: 'line one\nline two\nline three\n',
        [`${VAULT}/src/b.ts`]: 'export const b = 1;\n',
        [`${VAULT}/empty.txt`]: '',
      },
      ...options.init,
    },
  ]);
  const plans = new PlanCapture(['/Users/jasper']);
  const handoffs = new HandoffNotes(join(mkdtempSync(join(tmpdir(), 'mv-handoff-')), 'h'));
  let seated = true;
  let epoch = 7;
  const compaction: (() => void)[] = [];
  const host: PcHost = {
    agentId: 'ada-1',
    pcs,
    plans,
    handoffs,
    access: () => (seated ? { pcId: 'linux-1', epoch } : null),
    authorName: () => 'Ada',
    playerName: () => 'Jasper',
    settle: { windowMs: 1_500, pollMs: 1, minMs: 0, maxMs: 20, batchWaitMs: 50 },
    onCompaction: (l) => compaction.push(l),
    ...(options.batch ? { batch: options.batch } : {}),
    ...(options.jobs ? { jobs: options.jobs } : {}),
    ...options.over,
  };
  return {
    pcs,
    plans,
    handoffs,
    reg: registry(createPcServer(host)),
    unseat: () => {
      seated = false;
    },
    newSeat: () => {
      epoch++;
    },
    compact: () => {
      for (const l of compaction) l();
    },
  };
}

/** Feeds a BatchBook one complete assistant message with these pc calls. */
function message(batch: BatchBook, id: string, calls: [string, string][]) {
  batch.messageStart(id);
  for (const [toolUseId, name] of calls) batch.toolUse(id, toolUseId, name);
  batch.messageStop(id);
}

describe('catalog and schemas', () => {
  it('defines exactly the catalog tools: the trained members, perception, shell and files', () => {
    const { reg } = setup();
    expect(Object.keys(reg).sort()).toEqual([...PC_TOOLS].sort());
    expect(PC_TOOLS).toHaveLength(31);
    for (const gone of ['click', 'move', 'drag', 'bash_output', 'bash_kill'])
      expect(reg[gone]).toBeUndefined();
  });

  it('takes the trained computer-use inputs', () => {
    const { reg } = setup();
    const ok = (name: string, args: unknown) => reg[name]?.inputSchema?.safeParse(args).success;
    expect(ok('left_click', { coordinate: [10, 20], text: 'ctrl' })).toBe(true);
    expect(ok('left_click', {})).toBe(true);
    expect(ok('left_click', { coordinate: [10] })).toBe(false);
    expect(ok('left_click', { coordinate: [-1, 2] })).toBe(false);
    expect(ok('triple_click', { coordinate: [1, 2] })).toBe(true);
    expect(ok('left_click_drag', { start_coordinate: [1, 2], coordinate: [3, 4] })).toBe(true);
    expect(
      ok('scroll', { scroll_direction: 'down', scroll_amount: 5, coordinate: [1, 2], text: 'shift' }),
    ).toBe(true);
    expect(ok('scroll', { scroll_direction: 'sideways', scroll_amount: 5 })).toBe(false);
    expect(ok('key', { text: 'ctrl+s', repeat: 3 })).toBe(true);
    expect(ok('hold_key', { text: 'shift', duration: 1.5 })).toBe(true);
    expect(ok('wait', { duration: 2 })).toBe(true);
    expect(ok('zoom', { region: [0, 0, 100, 100] })).toBe(true);
    expect(ok('zoom', { region: [0, 0, 100] })).toBe(false);
    expect(ok('type', { text: 'hi' })).toBe(true);
    expect(ok('mouse_move', { coordinate: [3, 4] })).toBe(true);
  });

  it('takes the built-ins inputs unchanged (aliases, S2)', () => {
    const { reg } = setup();
    const ok = (name: string, args: unknown) => reg[name]?.inputSchema?.safeParse(args).success;
    expect(
      ok('bash', {
        command: 'ls',
        description: 'list',
        timeout: 5000,
        run_in_background: false,
        dangerouslyDisableSandbox: true,
      }),
    ).toBe(true);
    expect(ok('read', { file_path: '/x', offset: 1, limit: 2, pages: '1-2' })).toBe(true);
    expect(ok('edit', { file_path: '/x', old_string: 'a', new_string: 'b', replace_all: true })).toBe(true);
    expect(ok('write', { file_path: '/x', content: '' })).toBe(true);
    expect(ok('glob', { pattern: '**/*.ts', path: '/x' })).toBe(true);
    expect(
      ok('grep', {
        pattern: 'x',
        output_mode: 'content',
        '-i': true,
        '-n': true,
        '-o': true,
        '-A': 1,
        '-B': 1,
        '-C': 2,
        context: 2,
        multiline: false,
        head_limit: 5,
        offset: 2,
      }),
    ).toBe(true);
    expect(ok('task_stop', { task_id: 'b1', shell_id: 'b2' })).toBe(true);
  });

  it('marks reads read-only (they may run in parallel) and keeps waits ordered', () => {
    const { reg } = setup();
    const ro = Object.entries(reg)
      .filter(([, t]) => t.annotations?.readOnlyHint === true)
      .map(([n]) => n)
      .sort();
    expect(ro).toEqual(['cursor_position', 'glob', 'grep', 'info', 'read', 'screenshot', 'ui', 'zoom']);
  });
});

describe('read (Claude Code 2.1.293 Read)', () => {
  it('numbers lines without padding; a final newline is one more, empty line', async () => {
    const { reg } = setup();
    expect((await call(reg, 'read', { file_path: `${VAULT}/a.ts` })).text).toBe(
      '1\tline one\n2\tline two\n3\tline three\n4\t',
    );
    expect((await call(reg, 'read', { file_path: 'a.ts', offset: 2, limit: 1 })).text).toBe('2\tline two');
  });

  it('answers an empty file, an offset past the end, a missing file and a directory like the built-in', async () => {
    const { reg } = setup();
    expect((await call(reg, 'read', { file_path: `${VAULT}/empty.txt` })).text).toBe(
      '<system-reminder>Warning: the file exists but the contents are empty.</system-reminder>',
    );
    expect((await call(reg, 'read', { file_path: `${VAULT}/a.ts`, offset: 9 })).text).toBe(
      '<system-reminder>Warning: the file exists but is shorter than the provided offset (9). The file has 4 lines.</system-reminder>',
    );
    const missing = await call(reg, 'read', { file_path: `${VAULT}/nope.ts` });
    expect(missing).toMatchObject({
      isError: true,
      text: `File does not exist. Note: your current working directory is ${VAULT}.`,
    });
    expect((await call(reg, 'read', { file_path: `${VAULT}/src` })).text).toContain('EISDIR');
  });

  it('an unchanged re-read costs one line; a change, a new seat or a compaction reads again', async () => {
    const { reg, pcs, compact, newSeat } = setup();
    const path = `${VAULT}/a.ts`;
    await call(reg, 'read', { file_path: path });
    expect((await call(reg, 'read', { file_path: path })).text).toBe(
      'Wasted call — file unchanged since your last Read. Refer to that earlier tool_result instead.',
    );
    expect((await call(reg, 'read', { file_path: path, offset: 2 })).text).toContain('2\tline two');
    pcs.touchFile('linux-1', path, 'changed\n');
    expect((await call(reg, 'read', { file_path: path, offset: 2 })).text).toBe('2\t');
    compact();
    expect((await call(reg, 'read', { file_path: path, offset: 2 })).text).toBe('2\t');
    newSeat();
    expect((await call(reg, 'read', { file_path: path, offset: 2 })).text).toBe('2\t');
  });

  it('a long file shows its first 2000 lines and says how to page on; a huge one is cut to fit one result', async () => {
    const lines = Array.from({ length: 2500 }, (_, i) => `l${i + 1}`).join('\n');
    const big = Array.from({ length: 300 }, () => 'x'.repeat(1_000)).join('\n');
    const { reg } = setup({ init: { files: { [`${VAULT}/long.txt`]: lines, [`${VAULT}/big.txt`]: big } } });
    const long = await call(reg, 'read', { file_path: `${VAULT}/long.txt` });
    expect(long.text.split('\n')[1999]).toBe('2000\tl2000');
    expect(long.text).toContain(
      `[Truncated: PARTIAL view — ${VAULT}/long.txt: showing 2000 of 2500 lines. Call Read with offset/limit to page through.`,
    );
    const huge = await call(reg, 'read', { file_path: `${VAULT}/big.txt` });
    expect(huge.text.length).toBeLessThan(60_000);
    expect(huge.text).toMatch(
      /\[Truncated: PARTIAL view — .*big\.txt: showing lines 1-55 of 300 total \(\d+ tokens, cap 14000\)\. Call Read with offset=56 limit=55/,
    );
  });

  it('shows images as images', async () => {
    const { reg } = setup({ init: { files: { [`${VAULT}/shot.png`]: '\u0089PNG' } } });
    const r = await call(reg, 'read', { file_path: `${VAULT}/shot.png` });
    expect(r.image).toMatchObject({ type: 'image', mimeType: 'image/png' });
  });
});

describe('write and edit (read-state)', () => {
  it('creates new files; an existing one must have been read, and not changed since', async () => {
    const { reg, pcs } = setup();
    expect((await call(reg, 'write', { file_path: `${VAULT}/new.ts`, content: 'x' })).text).toBe(
      `File created successfully at: ${VAULT}/new.ts (file state is current in your context — no need to Read it back)`,
    );
    const blind = await call(reg, 'write', { file_path: `${VAULT}/a.ts`, content: 'gone' });
    expect(blind).toMatchObject({
      isError: true,
      text: 'File has not been read yet. Read it first before writing to it.',
    });
    expect(pcs.files('linux-1').get(`${VAULT}/a.ts`)).toBe('line one\nline two\nline three\n');
    await call(reg, 'read', { file_path: `${VAULT}/a.ts` });
    pcs.touchFile('linux-1', `${VAULT}/a.ts`, 'the player typed this\n');
    expect((await call(reg, 'write', { file_path: `${VAULT}/a.ts`, content: 'mine' })).text).toBe(
      'File has been modified since read, either by the user or by a linter. Read it again before attempting to write it.',
    );
    await call(reg, 'read', { file_path: `${VAULT}/a.ts` });
    expect((await call(reg, 'write', { file_path: `${VAULT}/a.ts`, content: 'mine' })).text).toBe(
      `The file ${VAULT}/a.ts has been updated successfully. (file state is current in your context — no need to Read it back)`,
    );
    // A file it wrote itself is current: a second write needs no read.
    expect((await call(reg, 'write', { file_path: `${VAULT}/a.ts`, content: 'again' })).isError).toBe(false);
  });

  it('edits with the built-in texts', async () => {
    const { reg, pcs } = setup();
    const file_path = `${VAULT}/a.ts`;
    expect((await call(reg, 'edit', { file_path, old_string: 'two', new_string: '2' })).text).toBe(
      'File has not been read yet. Read it first before writing to it.',
    );
    await call(reg, 'read', { file_path });
    expect((await call(reg, 'edit', { file_path, old_string: 'line two', new_string: 'LINE 2' })).text).toBe(
      `The file ${file_path} has been updated successfully.`,
    );
    expect((await call(reg, 'edit', { file_path, old_string: 'nope', new_string: 'x' })).text).toBe(
      'String to replace not found in file.\nString: nope',
    );
    expect((await call(reg, 'edit', { file_path, old_string: 'line', new_string: 'L' })).text).toBe(
      'Found 2 matches of the string to replace, but replace_all is false. To replace all occurrences, set replace_all to true. To replace only one occurrence, please provide more context to uniquely identify the instance.\nString: line',
    );
    expect(
      (await call(reg, 'edit', { file_path, old_string: 'line', new_string: 'L', replace_all: true })).text,
    ).toBe(`The file ${file_path} has been updated. All occurrences were successfully replaced.`);
    expect(pcs.files('linux-1').get(file_path)).toBe('L one\nLINE 2\nL three\n');
    expect((await call(reg, 'edit', { file_path, old_string: 'x', new_string: 'x' })).text).toBe(
      'No changes to make: old_string and new_string are exactly the same.',
    );
    expect((await call(reg, 'edit', { file_path, old_string: '', new_string: 'x' })).text).toBe(
      'Cannot create new file - file already exists.',
    );
    expect(
      (await call(reg, 'edit', { file_path: `${VAULT}/c.ts`, old_string: '', new_string: 'new\n' })).text,
    ).toBe(`The file ${VAULT}/c.ts has been updated successfully.`);
    expect(pcs.files('linux-1').get(`${VAULT}/c.ts`)).toBe('new\n');
  });

  it('plan files are captured in memory and never reach the PC', async () => {
    const { reg, pcs, plans } = setup();
    const path = '/Users/jasper/.claude/plans/fix.md';
    expect((await call(reg, 'write', { file_path: path, content: '# Plan\n- a' })).text).toContain(
      'File created successfully',
    );
    expect((await call(reg, 'edit', { file_path: path, old_string: '- a', new_string: '- b' })).text).toBe(
      `The file ${path} has been updated successfully.`,
    );
    expect((await call(reg, 'read', { file_path: path })).text).toBe('1\t# Plan\n2\t- b');
    expect(pcs.files('linux-1').has(path)).toBe(false);
    expect(plans.latest()?.text).toBe('# Plan\n- b');
  });
});

describe('glob and grep', () => {
  it('glob lists paths relative to the working directory, newest first', async () => {
    const { reg } = setup();
    expect((await call(reg, 'glob', { pattern: '**/*.ts' })).text).toBe('a.ts\nsrc/b.ts');
    expect((await call(reg, 'glob', { pattern: '**/*.rs' })).text).toBe('No files found');
  });

  it('grep defaults to file paths with a 250 head limit; pages with offset; content and count modes', async () => {
    const { reg, pcs } = setup();
    let seen: unknown;
    const grep = pcs.grep.bind(pcs);
    pcs.grep = async (pcId, req) => {
      seen = req;
      return grep(pcId, req);
    };
    expect((await call(reg, 'grep', { pattern: 'line|const' })).text).toBe('Found 2 files\na.ts\nsrc/b.ts');
    expect(seen).toMatchObject({
      outputMode: 'files_with_matches',
      headLimit: 250,
      offset: 0,
      lineNumbers: true,
    });
    expect((await call(reg, 'grep', { pattern: 'line|const', head_limit: 1 })).text).toBe(
      'Found 1 file limit: 1\na.ts',
    );
    expect((await call(reg, 'grep', { pattern: 'line|const', head_limit: 1, offset: 1 })).text).toBe(
      'Found 1 file offset: 1\nsrc/b.ts',
    );
    expect((await call(reg, 'grep', { pattern: 'line', output_mode: 'content', head_limit: 2 })).text).toBe(
      'a.ts:1:line one\na.ts:2:line two\n\n[Showing results with pagination = limit: 2]',
    );
    expect((await call(reg, 'grep', { pattern: 'line', output_mode: 'count' })).text).toBe(
      'a.ts:3\n\nFound 3 total occurrences across 1 file.',
    );
    expect((await call(reg, 'grep', { pattern: 'zzz', output_mode: 'content' })).text).toBe(
      'No matches found',
    );
    expect((await call(reg, 'grep', { pattern: 'zzz' })).text).toBe('No files found');
    await call(reg, 'grep', { pattern: 'l\\w+', output_mode: 'content', '-o': true, head_limit: 0 });
    expect(seen).toMatchObject({ onlyMatching: true, headLimit: undefined });
  });

  it('grep keeps its answer under 30,000 characters and reports the lines it kept as the limit', async () => {
    const { reg, pcs } = setup();
    const line = (i: number) => `a.ts:${String(i).padStart(3, '0')}:${'x'.repeat(191)}`; // 200 characters
    pcs.grep = async () => ({
      output: Array.from({ length: 400 }, (_, i) => line(i + 1)).join('\n'),
      matches: 400,
      total: 400,
      truncated: false,
    });
    const text = (await call(reg, 'grep', { pattern: 'x', output_mode: 'content', head_limit: 0 })).text;
    expect(text.length).toBeLessThan(30_100);
    expect(text.endsWith('[Showing results with pagination = limit: 149]')).toBe(true);
    expect(text.split('\n\n')[0]?.split('\n')).toHaveLength(149);
  });
});

describe('bash and task_stop (Claude Code 2.1.293 Bash)', () => {
  it('runs the wrapper with the seat tag and the output file, keeps the cwd, answers like the built-in', async () => {
    const { reg, pcs } = setup();
    pcs.execHandler = (_pc, req) =>
      req.command.includes('cd sub')
        ? { exitCode: 0, output: `ok\n__MV_PWD__${VAULT}/sub` }
        : req.command.includes('false')
          ? { exitCode: 2, output: `boom\n__MV_PWD__${VAULT}/sub` }
          : req.command.includes('grep')
            ? { exitCode: 1, output: `__MV_PWD__${VAULT}/sub` }
            : { exitCode: 0, output: `__MV_PWD__${VAULT}/sub` };
    expect((await call(reg, 'bash', { command: 'cd sub && echo ok' })).text).toBe('ok');
    expect(pcs.execs[0]?.request).toMatchObject({
      tag: 'ada-1:7',
      cwd: VAULT,
      timeoutMs: 120_000,
      onTimeout: 'background',
      outputFile: true,
      lifetimeMs: 1_800_000,
    });
    expect(pcs.execs[0]?.request.jobId).toMatch(/^b[0-9a-f]{8}$/);
    expect(pcs.execs[0]?.request.command).toBe(wrapBash('cd sub && echo ok'));
    const failed = await call(reg, 'bash', { command: 'false', timeout: 900_000 });
    expect(failed).toMatchObject({ isError: true, text: 'Exit code 2\nboom' });
    expect(pcs.execs[1]?.request).toMatchObject({
      cwd: `${VAULT}/sub`,
      timeoutMs: 600_000,
      env: { MV_CWD: `${VAULT}/sub` },
    });
    expect(await call(reg, 'bash', { command: 'true' })).toMatchObject({
      isError: false,
      text: '(No output)',
    });
    expect(await call(reg, 'bash', { command: 'grep -r nothing .' })).toMatchObject({
      isError: false,
      text: 'No matches found',
    });
  });

  it('cuts huge output in the middle', async () => {
    const { reg, pcs } = setup();
    pcs.execHandler = () => ({
      exitCode: 0,
      output: Array.from({ length: 4_000 }, (_, i) => `row ${i}`).join('\n'),
    });
    const r = await call(reg, 'bash', { command: 'seq' });
    expect(r.text.length).toBeLessThanOrEqual(30_100);
    expect(r.text).toMatch(/^row 0\n/);
    expect(r.text).toMatch(/\n\n\.\.\. \[(\d+ lines|output) truncated\] \.\.\./);
  });

  it('background commands report their file, overruns move to the background, task_stop stops them', async () => {
    const jobs = new PcJobBook();
    const { reg, pcs } = setup({ jobs });
    const bg = await call(reg, 'bash', {
      command: 'npm run dev',
      run_in_background: true,
      timeout: 3_600_000,
    });
    const id = /ID: (\S+?)\./.exec(bg.text)?.[1] ?? '';
    expect(bg.text).toBe(
      `Command running in background with ID: ${id}. Output is being written to: /home/cua/.mv/jobs/${id}.out. You will be notified when it completes. To check interim output, use Read on that file path.`,
    );
    expect(pcs.execs[0]?.request).toMatchObject({ background: true, lifetimeMs: 3_600_000 });
    expect(jobs.get('linux-1', id)).toMatchObject({
      command: 'npm run dev',
      description: 'npm run dev',
      epoch: 7,
    });
    pcs.execHandler = () => ({ exitCode: 0, output: 'compiling', hang: true });
    const moved = await call(reg, 'bash', {
      command: 'npm run build',
      description: 'Build the app',
      timeout: 5_000,
    });
    const id2 = /\(ID: (\S+?)\)/.exec(moved.text)?.[1] ?? '';
    expect(moved.text).toBe(
      `Command did not complete within its 5s timeout and was moved to the background (ID: ${id2}). Output is being written to: /home/cua/.mv/jobs/${id2}.out. You will be notified when it completes. If it is still running after 30m in the background, it will be stopped and you will be notified. To check interim output, use Read on that file path.`,
    );
    expect(jobs.get('linux-1', id2)?.description).toBe('Build the app');
    expect((await call(reg, 'task_stop', { task_id: id })).text).toBe(
      `Successfully stopped task: ${id} (npm run dev)`,
    );
    expect((await call(reg, 'task_stop', { task_id: 'b00000000' })).isError).toBe(true);
  });

  it('the cwd marker helpers', () => {
    expect(wrapBash('echo hi')).toContain('echo hi\nec=$?');
    expect(stripPwdMarker('out\n__MV_PWD__/tmp/x')).toEqual({ output: 'out', cwd: '/tmp/x' });
    expect(stripPwdMarker('no marker')).toEqual({ output: 'no marker', cwd: null });
  });
});

describe('computer tools (the trained members)', () => {
  it('screenshot: the size and the focused window, then the image', async () => {
    const { reg } = setup();
    const r = await call(reg, 'screenshot', {});
    expect(r.content[0]).toEqual({ type: 'text', text: '1280x800 · focused: "Terminal - cua@linux-1: ~"' });
    expect(r.content[1]).toMatchObject({ type: 'image', mimeType: 'image/jpeg' });
  });

  it('clicks map to the pointer in screen pixels, with modifiers; out of bounds teaches', async () => {
    const { reg, pcs } = setup();
    await call(reg, 'left_click', { coordinate: [10, 20] });
    await call(reg, 'right_click', { coordinate: [11, 21] });
    await call(reg, 'middle_click', {});
    await call(reg, 'double_click', { coordinate: [12, 22], text: 'ctrl+shift' });
    await call(reg, 'triple_click', { coordinate: [13, 23] });
    expect(pcs.input.map((i) => i.value)).toEqual([
      { action: 'click', x: 10, y: 20, button: 'left' },
      { action: 'right_click', x: 11, y: 21 },
      { action: 'click', button: 'middle' },
      { action: 'double_click', x: 12, y: 22, modifiers: ['KEY_CONTROL', 'KEY_SHIFT'] },
      { action: 'click', x: 13, y: 23, button: 'left', count: 3 },
    ]);
    const oob = await call(reg, 'left_click', { coordinate: [1400, 300] });
    expect(oob).toMatchObject({
      isError: true,
      text: 'Coordinate (1400, 300) is outside the screen (1280x800). Coordinates are pixels of the latest screenshot, origin top-left.',
    });
    expect((await call(reg, 'left_click', { coordinate: [1, 1], text: 'banana' })).text).toContain(
      'Unknown key "banana"',
    );
    expect((await call(reg, 'left_click', { coordinate: [1, 1], text: 'ctrl+a' })).text).toContain(
      'is not a modifier',
    );
  });

  it('a larger screen is shown scaled to 1280 pixels, and coordinates are scaled back', async () => {
    const { reg, pcs } = setup({ init: { screen: { w: 2560, h: 1600 } } });
    const shot = await call(reg, 'screenshot', {});
    expect(shot.text).toMatch(/^1280x800/);
    expect(pcs.shots.at(-1)?.options).toMatchObject({ maxDim: 1280 });
    await call(reg, 'left_click', { coordinate: [640, 400] });
    expect(pcs.input.at(-1)?.value).toMatchObject({ x: 1280, y: 800 });
    pcs.input.length = 0;
    await call(reg, 'cursor_position', {});
    expect((await call(reg, 'cursor_position', {})).text).toBe('X=640, Y=400');
  });

  it('key: xdotool names, sequences, repeat; unknown keys teach', async () => {
    const { reg, pcs } = setup();
    await call(reg, 'key', { text: 'ctrl+s' });
    await call(reg, 'key', { text: 'Page_Down', repeat: 3 });
    await call(reg, 'key', { text: 'ctrl+a Delete' });
    await call(reg, 'key', { text: 'KP_Enter' });
    await call(reg, 'hold_key', { text: 'shift', duration: 0.5 });
    expect(pcs.input.map((i) => i.value)).toEqual([
      { action: 'press', keys: ['KEY_CONTROL', 's'] },
      { action: 'press', keys: ['KEY_PAGE_DOWN'], repeat: 3 },
      { action: 'sequence', chords: [['KEY_CONTROL', 'a'], ['KEY_DELETE']] },
      { action: 'press', keys: ['KEY_NUMPAD_ENTER'] },
      { action: 'hold', keys: ['KEY_SHIFT'], ms: 500 },
    ]);
    expect((await call(reg, 'key', { text: 'Ctrl-S' })).text).toBe(
      'Unknown key "Ctrl-S". Use xdotool names joined by +, e.g. "ctrl+s", "Return", "alt+Tab", "Page_Down".',
    );
  });

  it('type, scroll, drag, move, mouse down/up, wait', async () => {
    const { reg, pcs } = setup();
    await call(reg, 'type', { text: 'hello\n' });
    await call(reg, 'scroll', { scroll_direction: 'up', scroll_amount: 4, coordinate: [5, 6], text: 'ctrl' });
    await call(reg, 'scroll', { scroll_direction: 'right', scroll_amount: 2 });
    await call(reg, 'left_click_drag', { start_coordinate: [1, 2], coordinate: [30, 40] });
    await call(reg, 'mouse_move', { coordinate: [7, 8] });
    await call(reg, 'left_mouse_down', {});
    await call(reg, 'left_mouse_up', {});
    expect(pcs.input.map((i) => i.value)).toEqual([
      'hello\n',
      { action: 'scroll', x: 5, y: 6, dx: 0, dy: -4, modifiers: ['KEY_CONTROL'] },
      { action: 'scroll', dx: 2, dy: 0 },
      { action: 'drag', x: 1, y: 2, toX: 30, toY: 40 },
      { action: 'move', x: 7, y: 8 },
      { action: 'down', button: 'left' },
      { action: 'up', button: 'left' },
    ]);
    const waited = await call(reg, 'wait', { duration: 0 });
    expect(waited.isError).toBe(false);
  });

  it('zoom: a region of the screenshot enlarged to fit the screenshot size', async () => {
    const { reg, pcs } = setup();
    const r = await call(reg, 'zoom', { region: [100, 100, 420, 300] });
    expect(pcs.shots.at(-1)?.options).toMatchObject({
      region: { x: 100, y: 100, w: 320, h: 200 },
      fit: { w: 1280, h: 800 },
    });
    expect(r.text).toBe('[100, 100, 420, 300] at 4.0x (1280x800)');
    expect(r.image).toBeDefined();
    expect((await call(reg, 'zoom', { region: [100, 100, 50, 300] })).text).toBe(
      'region must be [x0, y0, x1, y1] with x1 > x0 and y1 > y0 inside 1280x800.',
    );
  });
});

describe('batches (several computer actions in one turn)', () => {
  it('only the last pc call of a message answers with the screen; the others say OK', async () => {
    const batch = new BatchBook();
    const { reg } = setup({ batch });
    message(batch, 'msg_1', [
      ['t1', 'mcp__pc__left_click'],
      ['t2', 'mcp__pc__type'],
      ['t3', 'mcp__pc__key'],
    ]);
    const a = await call(reg, 'left_click', { coordinate: [5, 5] }, 't1');
    const b = await call(reg, 'type', { text: 'hi' }, 't2');
    const c = await call(reg, 'key', { text: 'Return' }, 't3');
    expect(a).toMatchObject({ text: 'OK', image: undefined });
    expect(b).toMatchObject({ text: 'OK', image: undefined });
    // The first look also says which window has the focus.
    expect(c.text).toBe('OK · focused: "Terminal - cua@linux-1: ~"');
    expect(c.content.map((x) => x.type)).toEqual(['text', 'image']);
  });

  it('a screen the agent already saw costs one line instead of an image', async () => {
    const batch = new BatchBook();
    const { reg, pcs } = setup({ batch });
    message(batch, 'm1', [['t1', 'mcp__pc__wait']]);
    expect((await call(reg, 'wait', { duration: 0 }, 't1')).image).toBeDefined();
    message(batch, 'm2', [['t2', 'mcp__pc__wait']]);
    expect(await call(reg, 'wait', { duration: 0 }, 't2')).toMatchObject({
      text: 'OK\n(Screen unchanged since your last screenshot.)',
      image: undefined,
    });
    pcs.bumpScreen('linux-1');
    message(batch, 'm3', [['t3', 'mcp__pc__wait']]);
    expect((await call(reg, 'wait', { duration: 0 }, 't3')).image).toBeDefined();
    // An explicit screenshot always returns the image.
    expect((await call(reg, 'screenshot', {})).image).toBeDefined();
  });

  it('after a failed action, the rest of the batch does not run (the trained halt)', async () => {
    const batch = new BatchBook();
    const { reg, pcs } = setup({ batch });
    message(batch, 'msg_1', [
      ['t1', 'mcp__pc__left_click'],
      ['t2', 'mcp__pc__type'],
      ['t3', 'mcp__pc__bash'],
    ]);
    expect((await call(reg, 'left_click', { coordinate: [5000, 5] }, 't1')).isError).toBe(true);
    expect(await call(reg, 'type', { text: 'rm -rf' }, 't2')).toMatchObject({
      isError: true,
      text: 'Not executed: an earlier computer action in this turn failed.',
    });
    expect(pcs.input).toHaveLength(0);
    // The shell is not a computer action: it still runs.
    expect((await call(reg, 'bash', { command: 'true' }, 't3')).isError).toBe(false);
  });

  it('a new window shows in the answer', async () => {
    const batch = new BatchBook();
    const { reg, pcs } = setup({ batch });
    await call(reg, 'screenshot', {});
    pcs.onClick = () => {
      pcs.addWindow('linux-1', { id: 'save', title: 'Save As', app: 'Mousepad', nodes: [] });
    };
    message(batch, 'm', [['t1', 'mcp__pc__left_click']]);
    expect((await call(reg, 'left_click', { coordinate: [5, 5] }, 't1')).text).toBe(
      'OK · focused: "Save As" (new window)',
    );
  });
});

const EDITOR: FakeWindow = {
  id: 'w-ed',
  title: 'notes.md - Mousepad',
  app: 'Mousepad',
  bounds: { x: 0, y: 30, w: 1280, h: 770 },
  focused: true,
  onScreen: true,
  nodes: [
    {
      elementId: '1',
      depth: 1,
      role: 'menu',
      name: 'File',
      bounds: { x: 0, y: 30, w: 40, h: 20 },
      states: ['enabled'],
      actions: ['press'],
    },
    {
      elementId: '2',
      depth: 2,
      role: 'button',
      nativeRole: 'push button',
      name: 'Save',
      bounds: { x: 1160, y: 28, w: 40, h: 20 },
      states: ['enabled'],
      actions: ['press'],
    },
    {
      elementId: '3',
      depth: 2,
      role: 'text_field',
      name: 'Search',
      value: '',
      bounds: { x: 200, y: 60, w: 300, h: 24 },
      states: ['enabled', 'editable'],
      actions: ['press', 'set_value'],
    },
    {
      elementId: '4',
      depth: 2,
      role: 'paragraph',
      name: 'Hello world',
      bounds: { x: 20, y: 100, w: 400, h: 20 },
      states: ['enabled'],
      actions: [],
    },
    {
      elementId: '5',
      depth: 2,
      role: 'button',
      name: 'Hidden',
      description: 'off-screen: scroll it into view before a pixel action; element actions still reach it',
      states: ['enabled'],
      actions: ['press'],
    },
  ],
};

describe('ui and ui_act (accessibility)', () => {
  function withEditor() {
    const s = setup();
    s.pcs.addWindow('linux-1', { ...EDITOR, nodes: EDITOR.nodes.map((n) => ({ ...n })) });
    return s;
  }

  it('find answers refs with roles, names and centres in screenshot pixels', async () => {
    const { reg } = withEditor();
    const r = await call(reg, 'ui', { action: 'find', query: 'save' });
    expect(r.text).toBe('1 match in "notes.md - Mousepad":\nref_1 button "Save" @(1180,38)');
    const byRole = await call(reg, 'ui', { action: 'find', role: 'entry' });
    expect(byRole.text).toContain('text field "Search" @(350,72)');
    expect((await call(reg, 'ui', { action: 'find', query: 'zebra' })).text).toMatch(
      /^No element matches "zebra"/,
    );
  });

  it('a ref clicks through the accessibility tree; other clicks go to its centre', async () => {
    const { reg, pcs } = withEditor();
    await call(reg, 'ui', { action: 'find', query: 'save' });
    const pressed = await call(reg, 'left_click', { ref: 'ref_1' });
    expect(pressed.text).toMatch(/^pressed button "Save" \(accessibility\)/);
    expect(pcs.actions.at(-1)).toMatchObject({ kind: 'ui', value: { elementId: '2', action: 'press' } });
    await call(reg, 'right_click', { ref: 'ref_1' });
    expect(pcs.input.at(-1)?.value).toEqual({ action: 'right_click', x: 1180, y: 38 });
    expect((await call(reg, 'left_click', { ref: 'ref_99' })).text).toBe(
      'No element ref_99. Refs come from ui find/tree in this seat.',
    );
  });

  it('a ref survives a newer look at its window (spacesd keeps one live snapshot per window)', async () => {
    const { reg, pcs } = withEditor();
    await call(reg, 'ui', { action: 'find', query: 'save' });
    await call(reg, 'ui', { action: 'tree' });
    expect((await call(reg, 'left_click', { ref: 'ref_1' })).text).toMatch(/^pressed button "Save"/);
    expect(pcs.actions.filter((a) => a.kind === 'ui')).toHaveLength(1);
    // Once the element is gone, the ref says so.
    const ed = pcs.desktop('linux-1').find((w) => w.id === 'w-ed') as FakeWindow;
    ed.nodes = ed.nodes.filter((n) => n.name !== 'Save');
    await call(reg, 'ui', { action: 'tree' });
    expect((await call(reg, 'left_click', { ref: 'ref_1' })).text).toBe(
      'ref_1 is from an older view of "notes.md - Mousepad" (the window changed). Call ui find or ui tree again.',
    );
  });

  it('tree shows interactive elements indented, with refs; text reads what a window shows', async () => {
    const { reg } = withEditor();
    const tree = await call(reg, 'ui', { action: 'tree' });
    expect(tree.text.split('\n')).toEqual([
      'window "notes.md - Mousepad" focused',
      ' ref_1 menu "File" @(20,40)',
      '  ref_2 button "Save" @(1180,38)',
      '  ref_3 text field "Search" @(350,72)',
      '  ref_4 button "Hidden" off-screen',
    ]);
    expect((await call(reg, 'ui', { action: 'text' })).text).toBe('File\nSave\nHello world\nHidden');
  });

  it('windows lists them front first and marks the shell mirror', async () => {
    const { reg, pcs } = withEditor();
    pcs.desktop('linux-1').push({
      id: 'mirror',
      title: 'Shell: ada-1',
      app: 'Xfce4-terminal',
      focused: false,
      onScreen: true,
      nodes: [],
    });
    const r = await call(reg, 'ui', { action: 'windows' });
    expect(r.text).toBe(
      [
        '3 windows (front first):',
        '"notes.md - Mousepad" (Mousepad) focused 1280x770 at (0,30)',
        '"Terminal - cua@linux-1: ~" (Xfce4-terminal) 800x500 at (100,80)',
        '"Shell: ada-1" (Xfce4-terminal) (MineVibe shell mirror; leave it open)',
      ].join('\n'),
    );
    expect((await call(reg, 'ui_act', { op: 'close', window: 'Shell' })).text).toContain('leave it open');
  });

  it('ui_act sets values, presses, and operates windows; a ref of a closed window is stale', async () => {
    const { reg, pcs } = withEditor();
    await call(reg, 'ui', { action: 'find', role: 'text field' });
    expect((await call(reg, 'ui_act', { op: 'set_value', ref: 'ref_1', value: 'needle' })).text).toMatch(
      /^set text field "Search" to "needle"/,
    );
    expect(pcs.actions.at(-1)).toMatchObject({ value: { action: 'set_value', value: 'needle' } });
    expect((await call(reg, 'ui_act', { op: 'minimize', window: 'Mousepad' })).text).toMatch(
      /^minimized "notes\.md - Mousepad"/,
    );
    expect((await call(reg, 'ui_act', { op: 'close', window: 'notes.md' })).text).toMatch(
      /^closed "notes\.md - Mousepad"/,
    );
    expect((await call(reg, 'ui_act', { op: 'press', ref: 'ref_1' })).text).toBe(
      'ref_1 is from an older view of "its window" (the window changed). Call ui find or ui tree again.',
    );
    expect((await call(reg, 'ui_act', { op: 'activate', window: 'Firefx' })).text).toBe(
      'No window matches "Firefx". Open windows: "Terminal - cua@linux-1: ~".',
    );
  });

  it('an app without an accessibility tree says to use the screen', async () => {
    const { reg, pcs } = setup();
    pcs.addWindow('linux-1', {
      id: 'ch',
      title: 'page - Chromium',
      app: 'Chromium',
      nodes: [{ elementId: '0', depth: 0, role: 'window', name: 'page - Chromium', states: [], actions: [] }],
    });
    expect((await call(reg, 'ui', { action: 'tree' })).text).toBe(
      '"page - Chromium" exposes no accessibility tree (Chromium starts without one; open pages with open, which uses Firefox). Use screenshot and zoom with coordinates.',
    );
  });
});

describe('open, wait_for, clipboard', () => {
  it('open starts the target as the seat and answers with its window and the screen', async () => {
    const { reg, pcs } = setup();
    const r = await call(reg, 'open', { target: 'browser' });
    expect(pcs.actions.at(-1)).toMatchObject({ kind: 'open', value: { target: 'firefox', tag: 'ada-1:7' } });
    expect(r.text).toBe('Opened firefox: window "firefox - App" is focused.');
    expect(r.image).toBeDefined();
    await call(reg, 'open', { target: 'example.com/docs' });
    expect(pcs.actions.at(-1)).toMatchObject({ value: { target: 'https://example.com/docs' } });
    await call(reg, 'open', { target: '~/notes.md' });
    expect(pcs.actions.at(-1)).toMatchObject({ value: { target: '/home/cua/notes.md' } });
  });

  it('wait_for returns when the text shows, or errors after its timeout, with the screen either way', async () => {
    const { reg, pcs } = setup();
    pcs.addWindow('linux-1', { ...EDITOR, nodes: EDITOR.nodes.map((n) => ({ ...n })) });
    const found = await call(reg, 'wait_for', { text: 'Hello', timeout_ms: 1_000 });
    expect(found.text).toMatch(/^Found "Hello" after \d+\.\d s in "notes\.md - Mousepad"\./);
    expect(found.image).toBeDefined();
    const missing = await call(reg, 'wait_for', { text: 'Build succeeded', timeout_ms: 400 });
    expect(missing.isError).toBe(true);
    expect(missing.text).toBe('"Build succeeded" did not appear within 0 s. Focused: "notes.md - Mousepad".');
    expect(missing.image).toBeDefined();
    const win = await call(reg, 'wait_for', { window: 'Terminal', timeout_ms: 500 });
    expect(win.text).toMatch(/^Found window "Terminal"/);
    const gone = await call(reg, 'wait_for', { text: 'Hello', gone: true, timeout_ms: 300 });
    expect(gone.text).toBe('"Hello" was still there after 0 s.');
    const still = await call(reg, 'wait_for', { stable: true, timeout_ms: 2_000 });
    expect(still.text).toMatch(/^The screen is still after/);
  });

  it('clipboard reads and sets', async () => {
    const { reg } = setup();
    expect((await call(reg, 'clipboard', {})).text).toBe('(clipboard is empty)');
    await call(reg, 'clipboard', { text: 'copied' });
    expect((await call(reg, 'clipboard', {})).text).toBe('copied');
  });
});

describe('seat, info and limits', () => {
  it('refuses every tool when the seat is gone (fail closed)', async () => {
    const { reg, unseat } = setup();
    unseat();
    for (const tool of [
      'bash',
      'read',
      'write',
      'left_click',
      'screenshot',
      'ui',
      'open',
      'task_stop',
      'grep',
    ]) {
      const r = await call(reg, tool, {
        command: 'ls',
        file_path: `${VAULT}/a.ts`,
        content: 'x',
        coordinate: [1, 1],
        action: 'windows',
        target: 'firefox',
        task_id: 'b1',
        pattern: 'x',
      });
      expect(r.isError, tool).toBe(true);
      expect(r.text, tool).toContain('Not seated');
    }
  });

  it('info tells the screen, the Vault and the background commands', async () => {
    const { reg } = setup();
    await call(reg, 'bash', {
      command: 'npm run dev',
      run_in_background: true,
      description: 'Start the dev server',
    });
    const r = await call(reg, 'info', {});
    expect(r.text).toContain('screen 1280x800 (screenshots are the same size, 1334 image tokens)');
    expect(r.text).toContain(`Vault: ${VAULT} (rw)`);
    expect(r.text).toMatch(
      /- b[0-9a-f]{8}: Start the dev server \(started 0s ago; output \/home\/cua\/\.mv\/jobs\/b[0-9a-f]{8}\.out\)/,
    );
  });

  it('handoff notes are kept per PC or mount', async () => {
    const { reg, handoffs } = setup();
    expect((await call(reg, 'handoff_note', { text: 'half done' })).text).toContain('Note saved for linux-1');
    expect((await handoffs.list('linux-1'))[0]).toMatchObject({ author: 'Ada (agent)', text: 'half done' });
    expect((await call(reg, 'handoff_note', { text: 'x', mount: '/etc' })).isError).toBe(true);
  });

  it('no result is larger than 60k characters (D7); the clipboard keeps to 30k', async () => {
    const { reg, pcs } = setup();
    await call(reg, 'clipboard', { text: 'z'.repeat(100_000) });
    const clip = await call(reg, 'clipboard', {});
    expect(clip.text.length).toBeLessThanOrEqual(30_100);
    expect(clip.text).toContain('lines truncated');
    pcs.clipboardGet = async () => '';
    expect((await call(reg, 'clipboard', {})).text).toBe('(clipboard is empty)');
  });
});
