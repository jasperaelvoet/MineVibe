/**
 * PcApi, ShellMirror and the PC bridge glue on a real PC (`npm run test:pcs`, PLAN §6.2, §8, §13.5): the real Apple
 * `container` runtime, the MineVibe Linux PC image and spacesd through `@trycua/cua`, driven through the agents' own
 * `pc` tool server (`createPcServer`) the way a seated agent uses it.
 *
 * bash keeps its cwd between calls and writes the shell log → the output cap keeps head and tail → read/edit/grep/
 * glob run in the guest on a Vault file the host sees → writes into a read-only folder are refused → background job
 * output, bash_kill, and a kill by seat tag that also takes processes a command left behind → a foreground timeout
 * kills the command → the agent's own input (click, type, Enter) lands in a terminal → ShellMirror's window appears
 * on sit (the screen changes) and closes on stand → the PC module over a real BridgeServer: hello → pc.state,
 * pc.view focus → MVF1 frames, and the seated player's T0 `pc.input` typing into a terminal.
 *
 * Everything it creates carries a per-run label `minevibe=pc-test-<run>` and a per-run instance id (the temp state
 * dir), and is deleted at the end. The container system is stopped at the end only when this run started it.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeFrame } from '@minevibe/protocol';
import type { SpacesdClientLike } from '@trycua/cua';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HandoffNotes } from '../../../src/agents/memory.js';
import { PlanCapture } from '../../../src/agents/PlanCapture.js';
import { BatchBook, createPcServer, type PcHost } from '../../../src/agents/tools/pcServer.js';
import { BridgeServer } from '../../../src/bridge/BridgeServer.js';
import { generateToken } from '../../../src/bridge/bridgeFile.js';
import { findRepoRoot, resolvePaths } from '../../../src/config/paths.js';
import type { JobExit } from '../../../src/contracts/PcApi.js';
import { silentLogger } from '../../../src/log.js';
import { AppleContainerDriver } from '../../../src/pcs/drivers/AppleContainerDriver.js';
import {
  ContainerRuntime,
  devContainerRoots,
  readContainerLock,
} from '../../../src/pcs/drivers/ContainerRuntime.js';
import { MANAGED_LABEL } from '../../../src/pcs/drivers/PcDriver.js';
import { PcGuestApi } from '../../../src/pcs/GuestApi.js';
import type { InputRouter } from '../../../src/pcs/InputRouter.js';
import { PcModuleImpl } from '../../../src/pcs/module.js';
import { PcManager } from '../../../src/pcs/PcManager.js';
import { LINUX_PC_IMAGE_DEV } from '../../../src/pcs/PcTypes.js';
import { SeatBook } from '../../../src/pcs/SeatBook.js';
import { ShellMirror } from '../../../src/pcs/ShellMirror.js';
import { SpacesdPool } from '../../../src/pcs/SpacesdPool.js';
import { ModClient } from '../../helpers/modClient.js';

const RUN = `${process.pid.toString(36)}${Date.now().toString(36).slice(-4)}`;
const LABEL = `pc-test-${RUN}`;
const repo = findRepoRoot(fileURLToPath(import.meta.url)) as string;
const roots = {
  appRoot: process.env.MINEVIBE_CONTAINER_APP_ROOT ?? devContainerRoots().appRoot,
  installRoot: process.env.MINEVIBE_CONTAINER_INSTALL_ROOT ?? devContainerRoots().installRoot,
};
const ID = `ga-${process.pid.toString(36)}`;
const AGENT = 'ada';
const EPOCH = 1;
const TAG = `${AGENT}:${EPOCH}`;

const results: Record<string, unknown> = {};
const note = (k: string, v: unknown) => {
  results[k] = v;
  console.log(`[pcs] ${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`);
};
const sleep = (n: number) => new Promise((r) => setTimeout(r, n));
const txt = (b: ArrayBuffer) => Buffer.from(b).toString('utf8');

let tmp: string;
let vaultRw: string;
let vaultRo: string;
let runtime: ContainerRuntime;
let driver: AppleContainerDriver;
let pool: SpacesdPool;
let manager: PcManager;
let pc: SpacesdClientLike;
let seats: SeatBook;
let router: InputRouter;
let api: PcGuestApi;
let mirror: ShellMirror;
let engineBefore = 'unknown';

type Registered = Record<
  string,
  { inputSchema?: { parse(v: unknown): unknown }; handler: (a: unknown, e: unknown) => Promise<unknown> }
>;
let tools: Registered;
/** The batch book the `pc` tools read (fed by hand here, from the stream in AgentBrain). */
const batch = new BatchBook();

/**
 * Calls a `pc` tool like the SDK would (with Claude Code's `_meta` tool_use id when given); returns its text, whether
 * it is an error, and the image it returned (JPEG/PNG bytes), if any.
 */
async function tool(
  name: string,
  args: Record<string, unknown>,
  toolUseId?: string,
): Promise<{ text: string; isError: boolean; image: Buffer | null }> {
  const t = tools[name];
  if (!t) throw new Error(`no tool ${name}`);
  const parsed = t.inputSchema ? t.inputSchema.parse(args) : args;
  const res = (await t.handler(
    parsed,
    toolUseId ? { _meta: { 'claudecode/toolUseId': toolUseId } } : {},
  )) as {
    content: { type: string; text?: string; data?: string }[];
    isError?: boolean;
  };
  const img = res.content.find((c) => c.type === 'image');
  return {
    text: res.content
      .filter((c) => c.type === 'text')
      .map((c) => c.text)
      .join('\n'),
    isError: res.isError === true,
    image: img?.data ? Buffer.from(img.data, 'base64') : null,
  };
}

/** One assistant message's pc calls, in order (what AgentSession feeds from the stream). */
function batchOf(id: string, calls: [string, string][]): void {
  batch.messageStart(id);
  for (const [toolUseId, name] of calls) batch.toolUse(id, toolUseId, `mcp__pc__${name}`);
  batch.messageStop(id);
}

/** Width and height of a JPEG (its SOF marker). */
function jpegSize(b: Buffer): { w: number; h: number } | null {
  for (let i = 2; i < b.length - 9; ) {
    if (b[i] !== 0xff) return null;
    const marker = b[i + 1] as number;
    const len = b.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xc3) return { h: b.readUInt16BE(i + 5), w: b.readUInt16BE(i + 7) };
    i += 2 + len;
  }
  return null;
}

async function asCua(script: string) {
  const out = await pc.run({
    program: 'bash',
    args: ['-lc', script],
    env: new Map(),
    stdin: false,
    user: 'cua',
    timeoutMs: 20_000,
  });
  return { code: out.exit.code, stdout: txt(out.stdout).trim(), stderr: txt(out.stderr).trim() };
}

async function shotHash(): Promise<string> {
  const s = await pc.screenshot({
    format: pool.jpegFormat,
    quality: 75,
    maxDimension: 640,
    includeCursor: false,
  });
  return createHash('sha256').update(Buffer.from(s.image)).digest('hex').slice(0, 16);
}

async function windows(): Promise<
  { title?: string; bounds?: { x: number; y: number; width: number; height: number } }[]
> {
  const w = JSON.parse(await pc.callJson('/cua.env.v1.WindowsService/ListWindows', '{}')) as {
    windows?: { title?: string; bounds?: { x: number; y: number; width: number; height: number } }[];
  };
  return w.windows ?? [];
}

async function findWindow(title: string, timeoutMs = 10_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const hit = (await windows()).find((x) => (x.title ?? '').includes(title));
    if (hit?.bounds) return hit.bounds;
    await sleep(250);
  }
  throw new Error(`window ${title} did not appear`);
}

async function cleanupLabelled(): Promise<void> {
  for (const c of await driver.list({ [MANAGED_LABEL]: LABEL })) await driver.remove(c.name);
  for (const v of await driver.listVolumes({ [MANAGED_LABEL]: LABEL })) await driver.removeVolume(v.name);
  for (const n of await driver.listNetworks({ [MANAGED_LABEL]: LABEL })) await driver.removeNetwork(n.name);
}

beforeAll(async () => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'mv-pcs-ga-')));
  vaultRw = join(tmp, 'vault-rw');
  vaultRo = join(tmp, 'vault-ro');
  mkdirSync(join(vaultRw, '.git'), { recursive: true });
  mkdirSync(join(vaultRw, 'src', 'deep'), { recursive: true });
  writeFileSync(
    join(vaultRw, 'src', 'app.ts'),
    'export const greeting = "hello";\nexport const answer = 41;\n',
  );
  writeFileSync(join(vaultRw, 'src', 'deep', 'util.ts'), '// answer lives in app.ts\n');
  writeFileSync(join(vaultRw, 'top.ts'), 'export {};\n');
  mkdirSync(vaultRo, { recursive: true });
  writeFileSync(join(vaultRo, 'readme.txt'), 'read only\n');

  const lock = await readContainerLock(join(repo, 'packaging', 'vendor.lock.json'));
  runtime = new ContainerRuntime({
    ...roots,
    lock,
    cacheDir: join(homedir(), 'Library', 'Caches', 'MineVibe-dev', 'vendor'),
    leaseHolder: `test:pcs ${RUN}`,
  });
  driver = new AppleContainerDriver(runtime);
  await runtime.provision((m) => console.log(`[pcs] ${m}`));
  engineBefore = (await runtime.status()).ownership;
  note('engine_before', engineBefore);
  await driver.ensureEngine();
  await cleanupLabelled();
  if (!(await driver.imageExists(LINUX_PC_IMAGE_DEV))) {
    await driver.buildImage({
      contextDir: join(repo, 'images', 'linux-pc'),
      file: join(repo, 'images', 'linux-pc', 'Containerfile'),
      tag: LINUX_PC_IMAGE_DEV,
    });
  }
  pool = new SpacesdPool({ cachesDir: join(tmp, 'caches') });
  await pool.module();
  manager = new PcManager({
    stateDir: join(tmp, 'state'),
    driver,
    pool,
    labelValue: LABEL,
    diskPath: roots.appRoot,
    bootTimeoutMs: 180_000,
  });
  await manager.init({ createDefault: false });
  const t0 = performance.now();
  await manager.create({
    type: 'linux',
    id: ID,
    mounts: [{ host: vaultRw }, { host: vaultRo, ro: true }],
    boot: true,
  });
  note('create_to_serving_ms', Math.round(performance.now() - t0));
  pc = await pool.client(ID);

  seats = new SeatBook();
  router = manager.createInputRouter();
  api = new PcGuestApi({
    pcs: manager,
    client: (id) => pool.client(id),
    router,
    seats,
    jpegFormat: () => pool.jpegFormat,
  });
  mirror = new ShellMirror({ client: (id) => pool.client(id), sweep: (id, n, v) => api.sweep(id, n, v) });
  seats.seat(ID, { kind: 'agent', agentId: AGENT, seatEpoch: EPOCH });
  router.setOccupant(ID, { kind: 'agent', id: AGENT });
  const host: PcHost = {
    agentId: AGENT,
    pcs: api,
    plans: new PlanCapture(['/home/cua']),
    handoffs: new HandoffNotes(join(tmp, 'handoffs')),
    access: () => ({ pcId: ID, epoch: EPOCH }),
    authorName: () => 'Ada',
    playerName: () => 'Jordan',
    batch,
  };
  tools = (createPcServer(host).instance as unknown as { _registeredTools: Registered })._registeredTools;
});

afterAll(async () => {
  try {
    api?.dispose();
    if (manager?.get(ID))
      await manager.decommission(ID).catch((e) => console.log(`[pcs] decommission: ${e}`));
    if (driver) await cleanupLabelled();
    note('leftover_containers', driver ? (await driver.list({ [MANAGED_LABEL]: LABEL })).length : 'n/a');
    await manager?.shutdown({ stopEngine: false });
    if (runtime && engineBefore === 'not_running')
      note('engine_stopped', await runtime.releaseAndStopIfUnused());
    else {
      await runtime?.leases.release();
      note('engine_stopped', `left running (was ${engineBefore} before the run)`);
    }
  } finally {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
    console.log(`[pcs] RESULTS ${JSON.stringify(results)}`);
  }
});

describe('PcApi on a real PC, through the agents’ pc tools', () => {
  it('bash keeps its cwd between calls, reports exit codes and writes the shell log', async () => {
    let r = await tool('bash', { command: 'id -un; pwd' });
    expect(r.text.split('\n')).toEqual(['cua', vaultRw]);
    r = await tool('bash', { command: 'mkdir -p sub/dir && cd sub/dir && pwd' });
    expect(r.text).toBe(join(vaultRw, 'sub', 'dir'));
    r = await tool('bash', { command: 'pwd; echo "$MV_TAG"' });
    expect(r.text.split('\n')).toEqual([join(vaultRw, 'sub', 'dir'), TAG]);
    // (An `exit` would end the wrapper before it reports the cwd, so the failure runs in a subshell.)
    r = await tool('bash', { command: 'cd ~ && (echo oops >&2; exit 3)' });
    // Claude Code's Bash: a non-zero exit is an error starting "Exit code N".
    expect(r).toMatchObject({ isError: true, text: 'Exit code 3\noops' });
    r = await tool('bash', { command: 'pwd' });
    expect(r.text).toBe('/home/cua');
    const log = await asCua('tail -n 20 ~/.mv/shell.log');
    expect(log.stdout).toContain('oops');
    expect(log.stdout).toContain(`${AGENT}@${ID}`);
    note('shell_log_tail', log.stdout.split('\n').slice(-3).join(' | '));
  });

  it('caps long output at 30k characters, head and tail', async () => {
    const r = await tool('bash', { command: 'seq 1 40000' });
    expect(r.text.length).toBeLessThanOrEqual(30_100);
    expect(r.text.startsWith('1\n2\n3\n')).toBe(true);
    expect(r.text).toMatch(/\n\n\.\.\. \[\d+ characters truncated\] \.\.\.\n\n/);
    expect(r.text).toMatch(/\n40000$/);
    note('capped_output_chars', r.text.length);
  });

  it('read, edit, grep and glob run in the guest on a Vault file the host sees', async () => {
    await tool('bash', { command: `cd ${vaultRw}` });
    const file = join(vaultRw, 'src', 'app.ts');
    const read = await tool('read', { file_path: file });
    // Claude Code 2.1.293's Read: unpadded numbers, and the final newline is a third, empty line.
    expect(read.text).toBe('1\texport const greeting = "hello";\n2\texport const answer = 41;\n3\t');
    const edit = await tool('edit', {
      file_path: file,
      old_string: 'answer = 41',
      new_string: 'answer = 42',
    });
    expect(edit.isError).toBe(false);
    expect(readFileSync(file, 'utf8')).toBe('export const greeting = "hello";\nexport const answer = 42;\n');
    const ambiguous = await tool('edit', {
      file_path: file,
      old_string: 'export const',
      new_string: 'const',
    });
    expect(ambiguous.isError).toBe(true);
    // Paths inside the working directory (the read-write Vault folder) are relative, as Claude Code shows them.
    const grep = await tool('grep', { pattern: 'answer', path: vaultRw, output_mode: 'content' });
    expect(grep.text.split('\n').sort()).toEqual(
      ['src/app.ts:2:export const answer = 42;', 'src/deep/util.ts:1:// answer lives in app.ts'].sort(),
    );
    const files = await tool('grep', { pattern: 'ANSWER', path: vaultRw, '-i': true });
    expect(files.text.split('\n')[0]).toBe('Found 2 files');
    expect(files.text.split('\n').slice(1).sort()).toEqual(['src/app.ts', 'src/deep/util.ts']);
    const only = await tool('grep', {
      pattern: 'answer = \\d+',
      path: vaultRw,
      output_mode: 'content',
      '-o': true,
    });
    expect(only.text).toBe('src/app.ts:2:answer = 42');
    const counted = await tool('grep', { pattern: 'export', path: vaultRw, output_mode: 'count' });
    expect(counted.text).toMatch(/\n\nFound 3 total occurrences across 2 files\.$/);
    const deep = await tool('glob', { pattern: '**/*.ts', path: vaultRw });
    expect(deep.text.split('\n').sort()).toEqual(['src/app.ts', 'src/deep/util.ts', 'top.ts']);
    const top = await tool('glob', { pattern: '*.ts', path: vaultRw });
    expect(top.text).toBe('top.ts');
    const written = await tool('write', {
      file_path: join(vaultRw, 'notes', 'todo.md'),
      content: '- ship it\n',
    });
    expect(written.isError).toBe(false);
    expect(readFileSync(join(vaultRw, 'notes', 'todo.md'), 'utf8')).toBe('- ship it\n');
    const refused = await tool('write', { file_path: join(vaultRo, 'nope.txt'), content: 'x' });
    expect(refused.isError).toBe(true);
    expect(refused.text).toMatch(/^Error DENIED: .*Read-only file system/);
    note('ro_write_refusal', refused.text);
    const missing = await tool('read', { file_path: join(vaultRw, 'missing.txt') });
    expect(missing.isError).toBe(true);
  });

  it('background jobs: an output file read tells, task_stop, and a kill by seat tag that takes left-behind processes too', async () => {
    const started = await tool('bash', {
      command: 'for i in $(seq 1 1000); do echo tick-$i; sleep 0.2; done',
      run_in_background: true,
    });
    const jobId = /ID: (b[0-9a-f]{8})\./.exec(started.text)?.[1] as string;
    expect(jobId).toBeTruthy();
    expect(started.text).toBe(
      `Command running in background with ID: ${jobId}. Output is being written to: /home/cua/.mv/jobs/${jobId}.out. You will be notified when it completes. To check interim output, use Read on that file path.`,
    );
    await sleep(1200);
    const out = await tool('read', { file_path: `/home/cua/.mv/jobs/${jobId}.out` });
    expect(out.text).toContain('\ttick-1');
    const killed = await tool('task_stop', { task_id: jobId });
    expect(killed.text).toBe(
      `Successfully stopped task: ${jobId} (for i in $(seq 1 1000); do echo tick-$i; sleep 0.2; done)`,
    );
    await sleep(300);
    expect((await asCua('pgrep -fc "[s]eq 1 1000" || true')).stdout).toBe('0');

    // A command that leaves a process behind, plus a background job; the seat's tag kill takes both.
    await tool('bash', { command: 'nohup sleep 271 >/dev/null 2>&1 & echo left' });
    await tool('bash', { command: 'sleep 272', run_in_background: true });
    await sleep(500);
    // sleep 271 (left behind), sleep 272 and the job's own shell.
    expect(Number((await asCua('pgrep -fc "sleep 27[12]" || true')).stdout)).toBeGreaterThanOrEqual(2);
    const n = await api.killTag(ID, TAG);
    note('killed_by_tag', n);
    expect(n).toBeGreaterThanOrEqual(2);
    await sleep(300);
    expect((await asCua('pgrep -fc "sleep 27[12]" || true')).stdout).toBe('0');
  });

  it('a kill by seat tag takes what the agent started with sudo too', async () => {
    // The image keeps the seat tag through sudo (images/linux-pc/sudoers-minevibe). A dev image built before that
    // drop-in existed gets the very same file here, so the run checks what a rebuilt image does.
    const dropIn = readFileSync(join(repo, 'images', 'linux-pc', 'sudoers-minevibe'), 'utf8');
    const has = await asCua('sudo -n test -f /etc/sudoers.d/minevibe && echo yes || echo no');
    if (has.stdout !== 'yes') {
      const put = await pc.run({
        program: 'bash',
        args: [
          '-c',
          'printf %s "$1" | sudo -n tee /etc/sudoers.d/minevibe >/dev/null && sudo -n chmod 0440 /etc/sudoers.d/minevibe && sudo -n visudo -cf /etc/sudoers.d/minevibe',
          'put',
          dropIn,
        ],
        env: new Map(),
        stdin: false,
        user: 'cua',
        timeoutMs: 20_000,
      });
      expect(put.exit.code).toBe(0);
    }
    note(
      'sudoers_dropin',
      has.stdout === 'yes' ? 'from the image' : 'installed by the test (image predates it)',
    );
    // Left behind by a call that ended (its sudo is reparented away from the call's shell), and a running job.
    await tool('bash', { command: 'sudo -n sleep 273 >/dev/null 2>&1 & echo left' });
    await tool('bash', { command: 'sudo -n sleep 274', run_in_background: true });
    await sleep(600);
    const diag = await asCua(
      `for p in $(pgrep -f "sleep 27[34]"); do s=$(cat /proc/$p/stat); r=\${s##*) }; set -- $r; ` +
        `t=$(sudo -n cat /proc/$p/environ 2>/dev/null | tr '\\0' '\\n' | grep -c '^MV_TAG=' || true); ` +
        `echo "$p ppid=$2 uid=$(stat -c %u /proc/$p) tag=$t $(tr '\\0' ' ' < /proc/$p/cmdline | cut -c1-40)"; done`,
    );
    note('sudo_processes', diag.stdout.split('\n'));
    expect(Number((await asCua('pgrep -fc "^sleep 27[34]" || true')).stdout)).toBe(2);
    const n = await api.killTag(ID, TAG);
    note('killed_by_tag_with_sudo', n);
    await sleep(300);
    expect((await asCua('pgrep -fc "^(sudo -n )?sleep 27[34]" || true')).stdout).toBe('0');
  });

  it('a call from an ended seat never starts; an edit keeps a byte-order mark; no spacesd token in the shell', async () => {
    expect(await api.exec(ID, { command: 'true', tag: `${AGENT}:${EPOCH + 1}` }).catch((e) => e.code)).toBe(
      'DENIED',
    );
    const file = join(vaultRw, 'bom.ini');
    writeFileSync(file, '\uFEFFkey = old\r\n');
    await tool('read', { file_path: file });
    const edit = await tool('edit', { file_path: file, old_string: 'old', new_string: 'new' });
    expect(edit.isError).toBe(false);
    expect(readFileSync(file)).toEqual(Buffer.from('\uFEFFkey = new\r\n', 'utf8'));
    const token = await tool('bash', { command: 'printenv CUA_ENV_TOKEN | wc -c' });
    note('cua_env_token_chars_in_agent_shell', token.text);
    expect(token.text).toBe('0');
  });

  it('a command that overruns its timeout moves to the background, keeps its output file, and can be stopped', async () => {
    const t0 = Date.now();
    const r = await tool('bash', { command: 'echo started; sleep 61 && echo never', timeout: 2000 });
    expect(r.isError).toBe(false);
    const jobId = /\(ID: (b[0-9a-f]{8})\)/.exec(r.text)?.[1] as string;
    expect(r.text).toBe(
      `Command did not complete within its 2s timeout and was moved to the background (ID: ${jobId}). Output is being written to: /home/cua/.mv/jobs/${jobId}.out. You will be notified when it completes. If it is still running after 30m in the background, it will be stopped and you will be notified. To check interim output, use Read on that file path.`,
    );
    expect(Date.now() - t0).toBeLessThan(15_000);
    expect((await asCua('pgrep -fc "^sleep 61" || true')).stdout).toBe('1');
    expect((await tool('read', { file_path: `/home/cua/.mv/jobs/${jobId}.out` })).text).toBe(
      '1\tstarted\n2\t',
    );
    expect((await tool('task_stop', { task_id: jobId })).isError).toBe(false);
    await sleep(300);
    expect((await asCua('pgrep -fc "^sleep 61" || true')).stdout).toBe('0');
  });

  it("the agent's own input lands in a terminal (click, type, Enter) and the screenshot scales", async () => {
    const term = await pc.spawn({
      program: 'xfce4-terminal',
      args: ['--title=mvagent', '--geometry=90x24+120+120', '--disable-server'],
      env: new Map([['DISPLAY', ':1']]),
      user: 'cua',
      stdin: false,
      tag: 'mv-it-agent-term',
    });
    const b = await findWindow('mvagent');
    await api.pointer(ID, {
      action: 'click',
      x: Math.round(b.x + b.width / 2),
      y: Math.round(b.y + b.height / 2),
    });
    await sleep(200);
    // A chord (hotkey with cua names): ctrl+u clears what was typed so far, or the command below breaks.
    await api.type(ID, 'garbage');
    await api.keyboard(ID, { action: 'press', keys: ['ctrl', 'u'] });
    await sleep(200);
    await api.type(ID, 'echo agent-typed-$((6*7)) > /tmp/mv-agent.txt');
    await api.keyboard(ID, { action: 'press', keys: ['Enter'] });
    await sleep(700);
    expect((await asCua('cat /tmp/mv-agent.txt')).stdout).toBe('agent-typed-42');
    await term.kill().catch(() => {});
    const shot = await api.screenshot(ID, { maxDim: 640 });
    expect(shot).toMatchObject({ mime: 'image/jpeg', w: 640, screen: { w: 1280, h: 800 }, scale: 0.5 });
    expect(shot.data[0]).toBe(0xff);
    const info = await api.info(ID);
    note('guest_info', { os: info.osVersion, screen: info.screen, mounts: info.mounts.length });
    expect(info.osVersion).toMatch(/Ubuntu/);
  });

  it('ShellMirror: a terminal tailing the shell log appears on sit and closes on stand', async () => {
    const h0 = await shotHash();
    await mirror.open(ID, AGENT);
    const b = await findWindow(`Shell: ${AGENT}`);
    note('mirror_window', b);
    await tool('bash', { command: 'echo mirror-check-$((40+2))' });
    await sleep(800);
    // The prompt line carries real colour codes (ESC [), not their printable remains.
    expect((await asCua(`grep -c $'\\e\\[1;32m${AGENT}@${ID}' ~/.mv/shell.log`)).stdout).not.toBe('0');
    const h1 = await shotHash();
    expect(h1).not.toBe(h0);
    const mirrorProcs = await asCua('pgrep -fc "[t]ail -n 200 -F" || true');
    expect(Number(mirrorProcs.stdout)).toBeGreaterThanOrEqual(1);
    await mirror.close(ID);
    await sleep(800);
    expect((await windows()).some((w) => (w.title ?? '').includes(`Shell: ${AGENT}`))).toBe(false);
    expect((await asCua('pgrep -fc "[t]ail -n 200 -F" || true')).stdout).toBe('0');
  });
});

describe('PC tools V2 on a real PC', () => {
  it('Read, Write and Edit answer like Claude Code, with read-state against host edits', async () => {
    await tool('bash', { command: `cd ${vaultRw}` });
    const dir = join(vaultRw, 'v2');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'nl.txt'), 'a\nb\n');
    writeFileSync(join(dir, 'nonl.txt'), 'a\nb');
    writeFileSync(join(dir, 'empty.txt'), '');
    expect((await tool('read', { file_path: join(dir, 'nl.txt') })).text).toBe('1\ta\n2\tb\n3\t');
    expect((await tool('read', { file_path: join(dir, 'nonl.txt') })).text).toBe('1\ta\n2\tb');
    expect((await tool('read', { file_path: join(dir, 'empty.txt') })).text).toBe(
      '<system-reminder>Warning: the file exists but the contents are empty.</system-reminder>',
    );
    expect((await tool('read', { file_path: join(dir, 'nl.txt'), offset: 9 })).text).toBe(
      '<system-reminder>Warning: the file exists but is shorter than the provided offset (9). The file has 3 lines.</system-reminder>',
    );
    expect((await tool('read', { file_path: join(dir, 'nl.txt'), offset: 9 })).text).toMatch(/^Wasted call/);
    expect((await tool('read', { file_path: join(dir, 'missing.txt') })).text).toBe(
      `File does not exist. Note: your current working directory is ${vaultRw}.`,
    );
    // write: an existing file needs a read first; a host edit since the read is refused.
    writeFileSync(join(dir, 'player.md'), 'the player wrote this\n');
    expect((await tool('write', { file_path: join(dir, 'player.md'), content: 'x' })).text).toBe(
      'File has not been read yet. Read it first before writing to it.',
    );
    await tool('read', { file_path: join(dir, 'player.md') });
    await sleep(20);
    writeFileSync(join(dir, 'player.md'), 'the player changed it again\n');
    expect(
      (await tool('edit', { file_path: join(dir, 'player.md'), old_string: 'again', new_string: 'x' })).text,
    ).toBe(
      'File has been modified since read, either by the user or by a linter. Read it again before attempting to write it.',
    );
    expect(readFileSync(join(dir, 'player.md'), 'utf8')).toBe('the player changed it again\n');
    await tool('read', { file_path: join(dir, 'player.md') });
    expect(
      (await tool('edit', { file_path: join(dir, 'player.md'), old_string: 'again', new_string: 'twice' }))
        .text,
    ).toBe(`The file ${join(dir, 'player.md')} has been updated successfully.`);
    expect((await tool('write', { file_path: join(dir, 'player.md'), content: 'mine\n' })).text).toBe(
      `The file ${join(dir, 'player.md')} has been updated successfully. (file state is current in your context — no need to Read it back)`,
    );
    expect(readFileSync(join(dir, 'player.md'), 'utf8')).toBe('mine\n');
  });

  it('Bash answers like Claude Code: (No output), exit codes as errors, "nothing found" exits are not', async () => {
    expect(await tool('bash', { command: 'true' })).toMatchObject({ isError: false, text: '(No output)' });
    expect(await tool('bash', { command: 'false' })).toMatchObject({ isError: true, text: 'Exit code 1' });
    expect(await tool('bash', { command: 'grep -q nothing-here /etc/hostname' })).toMatchObject({
      isError: false,
      text: 'No matches found',
    });
    expect(await tool('bash', { command: 'test -e /nope' })).toMatchObject({
      isError: false,
      text: 'Condition is false',
    });
  });

  it('a background command that ends is reported with its exit, its output file kept for read', async () => {
    const exits: JobExit[] = [];
    const off = api.onJobExit((x) => exits.push(x));
    try {
      const r = await tool('bash', {
        command: 'echo partial; sleep 1; echo whole; exit 3',
        run_in_background: true,
      });
      const jobId = /ID: (b[0-9a-f]{8})\./.exec(r.text)?.[1] as string;
      const until = Date.now() + 10_000;
      while (exits.length === 0 && Date.now() < until) await sleep(100);
      expect(exits).toMatchObject([{ jobId, exitCode: 3, reason: 'exited', tag: TAG }]);
      expect((await tool('read', { file_path: `/home/cua/.mv/jobs/${jobId}.out` })).text).toBe(
        '1\tpartial\n2\twhole\n3\t',
      );
      note('job_exit', exits[0]);
    } finally {
      off();
    }
  });

  it('computer actions in screenshot pixels: a batch runs in order and only its last action shows the screen', async () => {
    const opened = await tool('open', { target: 'xfce4-terminal' }, 'o1');
    note('open_terminal', opened.text);
    expect(opened.text).toMatch(/^Opened xfce4-terminal: window ".*" is focused\.$/);
    expect(opened.image && jpegSize(opened.image)).toEqual({ w: 1280, h: 800 });
    const wins = await tool('ui', { action: 'windows' });
    note('ui_windows', wins.text);
    const term = (await windows()).find((w) => (w.title ?? '').startsWith('Terminal'));
    const b = term?.bounds as { x: number; y: number; width: number; height: number };
    const cx = Math.round(b.x + b.width / 2);
    const cy = Math.round(b.y + b.height / 2);
    batchOf('msg-1', [
      ['c1', 'left_click'],
      ['c2', 'type'],
      ['c3', 'key'],
    ]);
    const t0 = performance.now();
    const click = await tool('left_click', { coordinate: [cx, cy] }, 'c1');
    const typed = await tool('type', { text: 'echo v2-typed-$((6*7)) > /tmp/mv-v2.txt' }, 'c2');
    const enter = await tool('key', { text: 'Return' }, 'c3');
    note('batch_ms', Math.round(performance.now() - t0));
    expect(click).toMatchObject({ isError: false, text: 'OK', image: null });
    expect(typed).toMatchObject({ isError: false, text: 'OK', image: null });
    expect(enter.text.startsWith('OK')).toBe(true);
    expect(enter.image && jpegSize(enter.image)).toEqual({ w: 1280, h: 800 });
    expect((await asCua('cat /tmp/mv-v2.txt')).stdout).toBe('v2-typed-42');
    expect((await tool('cursor_position', {})).text).toBe(`X=${cx}, Y=${cy}`);
    // Nothing changed since that screen: the next look is one line, not an image.
    batchOf('msg-2', [['w1', 'wait']]);
    const still = await tool('wait', { duration: 0.2 }, 'w1');
    note('unchanged_screen', still.text);
    expect(still.image === null || still.text.includes('focused')).toBe(true);
    // A failure halts the rest of its batch with the trained text.
    batchOf('msg-3', [
      ['h1', 'left_click'],
      ['h2', 'type'],
    ]);
    expect((await tool('left_click', { coordinate: [1400, 10] }, 'h1')).text).toBe(
      'Coordinate (1400, 10) is outside the screen (1280x800). Coordinates are pixels of the latest screenshot, origin top-left.',
    );
    expect((await tool('type', { text: 'never' }, 'h2')).text).toBe(
      'Not executed: an earlier computer action in this turn failed.',
    );
    // zoom: the guest scales the region up to the screenshot size.
    const zoom = await tool('zoom', { region: [0, 0, 320, 200] });
    expect(zoom.text).toBe('[0, 0, 320, 200] at 4.0x (1280x800)');
    expect(zoom.image && jpegSize(zoom.image)).toEqual({ w: 1280, h: 800 });
    const keyErr = await tool('key', { text: 'Ctrl-S' });
    expect(keyErr.isError).toBe(true);
  });

  it('ui reads and drives a GTK app through the accessibility tree; wait_for waits for the window title', async () => {
    const opened = await tool('open', { target: '/home/cua' });
    note('open_thunar', opened.text);
    expect(opened.text).toMatch(/Thunar/);
    const field = await tool('ui', { action: 'find', role: 'entry', window: 'Thunar' });
    note('ui_find_entry', field.text);
    const ref = /(ref_\d+) text field/.exec(field.text)?.[1] as string;
    expect(ref).toBeTruthy();
    const set = await tool('ui_act', { op: 'set_value', ref, value: '/tmp/' });
    expect(set.isError).toBe(false);
    const moved = await tool('wait_for', { window: 'tmp - Thunar', timeout_ms: 8_000 });
    note('wait_for_window', moved.text);
    expect(moved.text).toMatch(/^Found window "tmp - Thunar" after/);
    const home = await tool('ui', { action: 'find', query: 'Home', role: 'button', window: 'Thunar' });
    const homeRef = /(ref_\d+) button "Home"/.exec(home.text)?.[1] as string;
    expect(homeRef).toBeTruthy();
    const pressed = await tool('left_click', { ref: homeRef });
    expect(pressed.text).toMatch(/^pressed button "Home" \(accessibility\)/);
    expect((await tool('wait_for', { window: 'cua - Thunar', timeout_ms: 8_000 })).isError).toBe(false);
    const tree = await tool('ui', { action: 'tree', window: 'Thunar' });
    note('ui_tree_chars', tree.text.length);
    expect(tree.text).toMatch(/^window "cua - Thunar"/);
    expect(tree.text).toMatch(/ref_\d+ button "Home" @\(\d+,\d+\)/);
    // A terminal exposes no text through accessibility: ui text says so.
    const termText = await tool('ui', { action: 'text', window: 'Terminal' });
    expect(termText.text).toContain('A terminal does not expose its text');
    const closed = await tool('ui_act', { op: 'close', window: 'Thunar' });
    expect(closed.text).toMatch(/^closed "cua - Thunar"/);
    const stale = await tool('ui_act', { op: 'press', ref: homeRef });
    expect(stale.isError).toBe(true);
    expect((await tool('wait_for', { stable: true, timeout_ms: 5_000 })).text).toMatch(
      /^The screen is still after/,
    );
  });

  it('open shows a page in Firefox, whose text the agent reads without a screenshot', async () => {
    writeFileSync(
      join(vaultRw, 'page.html'),
      '<html><head><title>MineVibe test page</title></head><body><h1>Hello from MineVibe</h1><p>The answer is 42.</p><a href="#x">Docs</a></body></html>',
    );
    const t0 = performance.now();
    const opened = await tool('open', { target: `file://${join(vaultRw, 'page.html')}` });
    note('open_firefox', { text: opened.text, ms: Math.round(performance.now() - t0) });
    const found = await tool('wait_for', { text: 'Hello from MineVibe', timeout_ms: 30_000 });
    note('wait_for_text', found.text);
    expect(found.isError).toBe(false);
    const text = await tool('ui', { action: 'text', window: 'Firefox' });
    note('ui_text_chars', text.text.length);
    expect(text.text).toContain('The answer is 42.');
    const link = await tool('ui', { action: 'find', query: 'Docs', role: 'link' });
    expect(link.text).toMatch(/ref_\d+ link "Docs" @\(\d+,\d+\)/);
    // Everything the agent opened dies with its seat.
    const n = await api.killTag(ID, TAG);
    note('killed_opened_apps', n);
    await sleep(800);
    expect((await windows()).some((w) => /Mozilla Firefox|Thunar/.test(w.title ?? ''))).toBe(false);
  });
});

describe('the PC module over a real bridge', () => {
  it('hello → pc.state; pc.view focus → MVF1 frames; the seated player types through pc.input', async () => {
    const token = generateToken();
    const bridge = new BridgeServer({ token, port: 0, logger: silentLogger(), heartbeatMs: 0 });
    const mod = new PcModuleImpl(
      {
        bridge,
        paths: resolvePaths({ env: { MINEVIBE_HOME: join(tmp, 'mv') } }),
        log: silentLogger(),
        world: () => ({ worldId: 'world-1', gen: 1 }),
        mode: 'dev',
      },
      { manager, pool, pickFolder: async () => null, log: silentLogger() },
      { boot: false, monitor: false, firstPc: false, stopEngine: false, helloRepushMs: 200 },
    );
    await mod.start();
    const port = await bridge.start();
    const mc = await ModClient.connect(port, token);
    try {
      mc.send({ t: 'hello', v: 1, id: 'm-1', mod: 'it', mc: '26.3', phase: 'in_world', worldId: 'world-1' });
      const state = await mc.next('pc.state', (m) => m.pcId === ID, 5000);
      expect(state).toMatchObject({ pcId: ID, status: 'running', occupant: null });
      const slot = state.slot as number;

      mc.send({ t: 'pc.view', v: 1, pcId: ID, tier: 'focus' });
      const until = Date.now() + 8000;
      let acked = 0;
      while (acked < 5 && Date.now() < until) {
        const f = mc.binary.shift();
        if (!f) {
          await sleep(50);
          continue;
        }
        const d = decodeFrame(new Uint8Array(f));
        expect(d.header.pcSlot).toBe(slot);
        mc.send({ t: 'pc.frame.ack', v: 1, pcId: ID, seq: d.header.seq });
        acked++;
      }
      note('bridge_frames_acked', acked);
      expect(acked).toBeGreaterThanOrEqual(1);

      const term = await pc.spawn({
        program: 'xfce4-terminal',
        args: ['--title=mvbridge', '--geometry=90x24+160+160', '--disable-server'],
        env: new Map([['DISPLAY', ':1']]),
        user: 'cua',
        stdin: false,
        tag: 'mv-it-bridge-term',
      });
      const b = await findWindow('mvbridge');
      const cx = Math.round(b.x + b.width / 2);
      const cy = Math.round(b.y + b.height / 2);
      mc.send({ t: 'pc.seat', v: 1, pcId: ID, occupant: { kind: 'player' } });
      await mc.next(
        'pc.state',
        (m) => m.pcId === ID && (m.occupant as { kind?: string } | null)?.kind === 'player',
      );
      mc.send({
        t: 'pc.input',
        v: 1,
        pcId: ID,
        seq: 1,
        events: [
          { k: 'move', x: cx, y: cy },
          { k: 'button', button: 'left', down: true, x: cx, y: cy },
          { k: 'button', button: 'left', down: false, x: cx, y: cy },
        ],
      });
      await sleep(300);
      mc.send({
        t: 'pc.input',
        v: 1,
        pcId: ID,
        seq: 2,
        events: [
          { k: 'text', text: 'echo bridge-typed-$((7*6)) > /tmp/mv-bridge.txt' },
          { k: 'key', key: 'KEY_ENTER', down: true },
          { k: 'key', key: 'KEY_ENTER', down: false },
          { k: 'release_all' },
        ],
      });
      await sleep(1000);
      expect((await asCua('cat /tmp/mv-bridge.txt')).stdout).toBe('bridge-typed-42');
      mc.send({
        t: 'pc.unseat',
        v: 1,
        pcId: ID,
        occupant: { kind: 'player' },
        reason: 'stand',
        reserved: false,
      });
      mc.send({ t: 'pc.view', v: 1, pcId: ID, tier: 'none' });
      await term.kill().catch(() => {});
    } finally {
      await mc.close();
      mod.glue?.detach();
      await bridge.close();
    }
  });
});
