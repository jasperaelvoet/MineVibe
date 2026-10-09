/**
 * macOS PCs on the real Lume (`MINEVIBE_TEST_MACOS=1 npm run test:pcs`, PLAN §8.7, §13.5): MineVibe's own notarized
 * Lume 0.6.1 and `lume serve`, the pinned macOS 26 image, spacesd through `@trycua/cua`, PcManager, PcApi through the
 * agents' own `pc` tools, ShellMirror (Terminal.app) and the InputRouter.
 *
 * Lume provisioned and verified → serve on loopback with a lease → a download waits for consent → create mac-a (4 CPU,
 * 8 GiB, a read-write and a read-only Vault folder, the Codex) to SERVING → wrong token refused → the guest's own
 * setup (sudo, path-identical Vault links, ripgrep, ~/codex) → pc tools: bash as `lume` keeps its cwd, read/edit/
 * grep/glob/write on a Vault file the Mac sees, read-only refused, background job + kill by seat tag → a host-side
 * rename-replace is seen after the guest view refresh → JPEG and the BGRA stream → the player's input with Cmd as
 * KEY_META quits Terminal → ShellMirror window on sit, gone on stand → a second PC (2 CPU, 4 GiB) → a third macOS PC is
 * refused by the budget, and a third VM by Apple's limit (Lume's log) → stop/start times → a resize → a shutdown inside
 * the guest is seen as a crash → reimage gives a fresh disk → decommission → numbers.
 *
 * Needs the macOS image in MineVibe's Lume storage (about 24 GB; the test pulls it only with MINEVIBE_TEST_MACOS_PULL=1).
 * Everything it makes carries a per-run label `minevibe=pc-test-<run>` and a per-run instance id and is deleted at
 * the end; the serve is stopped at the end only when no other MineVibe holds a lease on it.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statfsSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeFrame } from '@minevibe/protocol';
import type { SpacesdClientLike } from '@trycua/cua';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HandoffNotes } from '../../../src/agents/memory.js';
import { PlanCapture } from '../../../src/agents/PlanCapture.js';
import { BatchBook, createPcServer, type PcHost } from '../../../src/agents/tools/pcServer.js';
import { findRepoRoot } from '../../../src/config/paths.js';
import { LumeMacDriver } from '../../../src/pcs/drivers/LumeMacDriver.js';
import { devLumeRoot, LumeRuntime, loadLumeLocks } from '../../../src/pcs/drivers/LumeRuntime.js';
import type { MacPcDriver } from '../../../src/pcs/drivers/MacPcDriver.js';
import { MacStartError } from '../../../src/pcs/drivers/MacPcDriver.js';
import { MANAGED_LABEL } from '../../../src/pcs/drivers/PcDriver.js';
import type { FrameService } from '../../../src/pcs/FrameService.js';
import { PcGuestApi } from '../../../src/pcs/GuestApi.js';
import type { InputRouter } from '../../../src/pcs/InputRouter.js';
import { PcManager } from '../../../src/pcs/PcManager.js';
import { SeatBook } from '../../../src/pcs/SeatBook.js';
import { ShellMirror } from '../../../src/pcs/ShellMirror.js';
import { SpacesdPool } from '../../../src/pcs/SpacesdPool.js';
import { FakeDriver } from '../fakes.js';

const ENABLED = process.env.MINEVIBE_TEST_MACOS === '1';
const RUN = `${process.pid.toString(36)}${Date.now().toString(36).slice(-4)}`;
const LABEL = `pc-test-${RUN}`;
const repo = findRepoRoot(fileURLToPath(import.meta.url)) as string;
const A = `ma-${process.pid.toString(36)}`;
const B = `mb-${process.pid.toString(36)}`;
const AGENT = 'ada';
const EPOCH = 1;
const TAG = `${AGENT}:${EPOCH}`;
const GiB = 1024 ** 3;

const results: Record<string, unknown> = {};
const note = (k: string, v: unknown) => {
  results[k] = v;
  console.log(`[pcs-mac] ${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`);
};
const ms = (t0: number) => Math.round(performance.now() - t0);
const sleep = (n: number) => new Promise((r) => setTimeout(r, n));
const txt = (b: ArrayBuffer) => Buffer.from(b).toString('utf8');
const pct = (a: number[], p: number) => {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))] ?? Number.NaN;
};

let tmp: string;
let vaultRw: string;
let vaultRo: string;
let codex: string;
let runtime: LumeRuntime;
let mac: LumeMacDriver;
let pool: SpacesdPool;
let manager: PcManager;
let pc: SpacesdClientLike;
let seats: SeatBook;
let router: InputRouter;
let api: PcGuestApi;
let mirror: ShellMirror;
let frames: FrameService;
let diskBefore = 0;

type Registered = Record<
  string,
  { inputSchema?: { parse(v: unknown): unknown }; handler: (a: unknown, e: unknown) => Promise<unknown> }
>;
let tools: Registered;
const batch = new BatchBook();

async function tool(
  name: string,
  args: Record<string, unknown>,
): Promise<{ text: string; isError: boolean }> {
  const t = tools[name];
  if (!t) throw new Error(`no tool ${name}`);
  const parsed = t.inputSchema ? t.inputSchema.parse(args) : args;
  const res = (await t.handler(parsed, {})) as {
    content: { type: string; text?: string }[];
    isError?: boolean;
  };
  return {
    text: res.content
      .filter((c) => c.type === 'text')
      .map((c) => c.text)
      .join('\n'),
    isError: res.isError === true,
  };
}

/** A shell in the guest as `lume`, outside PcApi (checks). */
async function asLume(id: string, script: string, timeoutMs = 30_000) {
  const c = await pool.client(id);
  const out = await c.run({
    program: 'bash',
    args: ['-c', script],
    env: new Map([['PATH', '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin']]),
    stdin: false,
    user: 'lume',
    timeoutMs,
  });
  return { code: out.exit.code, stdout: txt(out.stdout).trim(), stderr: txt(out.stderr).trim() };
}

/** Titles of the windows on screen (Terminal keeps a closed window as a HIDDEN one). */
async function windowTitles(c: SpacesdClientLike): Promise<string[]> {
  const w = JSON.parse(await c.callJson('/cua.env.v1.WindowsService/ListWindows', '{}')) as {
    windows?: { title?: string; state?: string }[];
  };
  return (w.windows ?? []).filter((x) => x.state !== 'WINDOW_STATE_HIDDEN').map((x) => x.title ?? '');
}

const freeDisk = () => {
  const s = statfsSync(devLumeRoot());
  return Number(s.bavail) * Number(s.bsize);
};

beforeAll(async () => {
  if (!ENABLED) return;
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'mv-mac-int-')));
  vaultRw = join(tmp, 'Code', 'web-app');
  vaultRo = join(tmp, 'Docs', 'manual');
  codex = join(tmp, 'codex-export');
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
  mkdirSync(codex, { recursive: true });
  writeFileSync(join(codex, 'iron-cave.md'), '# Iron cave\nAt (120, 40, -80).\n');
  diskBefore = freeDisk();

  const locks = loadLumeLocks([join(repo, 'packaging', 'vendor.lock.json')]);
  if (!locks) throw new Error('packaging/vendor.lock.json has no Lume pins');
  runtime = new LumeRuntime({
    root: process.env.MINEVIBE_LUME_ROOT ?? devLumeRoot(),
    locks,
    cacheDir: join(homedir(), 'Library', 'Caches', 'MineVibe-dev', 'vendor'),
    leaseHolder: `test:pcs ${RUN}`,
  });
  mac = new LumeMacDriver(runtime);
  pool = new SpacesdPool({ cachesDir: join(tmp, 'caches') });
  await pool.module();
  manager = new PcManager({
    stateDir: join(tmp, 'state'),
    // No Linux PCs here: an in-memory container driver keeps the Apple container engine out of this run.
    driver: new FakeDriver(),
    macDriver: mac,
    pool,
    labelValue: LABEL,
    diskPath: devLumeRoot(),
    codexExport: codex,
    bootTimeoutMs: 240_000,
    shutdownTimeoutMs: 30_000,
  });
  await manager.init({ createDefault: false });
  note('instance', manager.instanceId);
});

afterAll(async () => {
  if (!ENABLED) return;
  try {
    api?.dispose();
    await frames?.close();
    for (const id of [B, A]) {
      if (manager?.get(id))
        await manager.decommission(id).catch((e) => console.log(`[pcs-mac] decommission ${id}: ${e}`));
    }
    if (mac?.engineHeld) {
      // Anything this run's label still names (a failed step).
      for (const vm of await mac.list({ [MANAGED_LABEL]: LABEL }).catch(() => [])) {
        await mac.remove(vm.name).catch(() => {});
      }
      note('leftover_vms', (await mac.list({ [MANAGED_LABEL]: LABEL })).length);
    }
    await manager?.shutdown();
    note('serve_running_after', runtime?.port !== null);
  } finally {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
    console.log(`[pcs-mac] RESULTS ${JSON.stringify(results)}`);
  }
});

describe.skipIf(!ENABLED)('macOS PCs on Lume', () => {
  it('provisions the notarized Lume, starts lume serve on loopback and finds the pinned image', async () => {
    let t0 = performance.now();
    await runtime.provision((m) => console.log(`[pcs-mac] ${m}`));
    note('lume_provision_and_verify_ms', ms(t0));
    t0 = performance.now();
    await mac.ensureEngine({ keep: () => true });
    note('serve_start_ms', ms(t0));
    expect(runtime.port).toBeGreaterThan(1024);
    const listen = execFileSync('/usr/sbin/lsof', ['-nP', `-iTCP:${runtime.port}`, '-sTCP:LISTEN'], {
      encoding: 'utf8',
    });
    expect(listen).toContain(`127.0.0.1:${runtime.port}`);
    expect(listen).not.toMatch(/\*:\d+/);
    note('serve_listen', listen.trim().split('\n').slice(1).join(' | '));
    let base = await mac.baseImage();
    if (!base.present && process.env.MINEVIBE_TEST_MACOS_PULL === '1') {
      t0 = performance.now();
      await mac.pullBase((p) => console.log(`[pcs-mac] pull ${(p.fraction * 100).toFixed(1)}%`));
      note('pull_ms', ms(t0));
      base = await mac.baseImage();
    }
    expect(base.present).toBe(true);
    note('base_image', { name: mac.baseName, allocatedGiB: +((base.allocatedBytes ?? 0) / GiB).toFixed(1) });
    expect(existsSync(runtime.ripgrepPath as string)).toBe(true);
  });

  it('a missing image waits for the consent, and a declined consent leaves the PC off', async () => {
    // The real manager and image check, with a driver whose base image counts as missing.
    const missing: MacPcDriver = new Proxy(mac, {
      get(target, prop) {
        if (prop === 'baseImage') return async () => ({ present: false });
        // The real driver keeps private fields: its getters and methods run on it, not on the proxy.
        const v = Reflect.get(target, prop, target);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
    const m2 = new PcManager({
      stateDir: join(tmp, 'state-consent'),
      driver: new FakeDriver(),
      macDriver: missing,
      pool: new SpacesdPool({ cachesDir: join(tmp, 'caches2') }),
      labelValue: LABEL,
      diskPath: devLumeRoot(),
    });
    await m2.init({ createDefault: false });
    await m2.create({ type: 'macos', id: 'consent-1' });
    await m2.start('consent-1');
    expect(m2.status('consent-1').status).toBe('awaiting_consent');
    const prompt = m2.views().find((v) => v.pcId === 'consent-1')?.consent;
    expect(prompt).toMatchObject({ bytes: mac.image.downloadBytes });
    expect(prompt?.what).toContain('macos:26');
    note('consent_prompt', prompt);
    await expect(m2.consent('consent-1', 'nope', true)).rejects.toMatchObject({ code: 'INVALID' });
    expect(await m2.consent('consent-1', prompt?.consentId as string, false)).toEqual({ start: [] });
    expect(m2.status('consent-1')).toMatchObject({
      status: 'off',
      detail: 'the macOS download was declined',
    });
    await m2.decommission('consent-1');
    await m2.shutdown({ stopEngine: false });
  });

  it('creates a macOS PC with a Vault and the Codex and boots it to SERVING', async () => {
    const t0 = performance.now();
    await manager.create({
      type: 'macos',
      id: A,
      mounts: [{ host: vaultRw }, { host: vaultRo, ro: true }],
      boot: true,
    });
    note('create_to_running_ms', ms(t0));
    expect(manager.status(A)).toMatchObject({ status: 'running' });
    expect(manager.status(A).reason).toBeUndefined();
    pc = await pool.client(A);
    const vm = await mac.inspect(manager.containerNameOf(A));
    expect(vm).toMatchObject({ state: 'running', cpus: 4, memoryBytes: 8 * GiB, display: '1280x800' });
    note('vm', { ip: vm?.ip, allocatedGiB: +((vm?.diskAllocatedBytes ?? 0) / GiB).toFixed(1) });
    const caps = await pc.capabilities();
    note('guest', `${caps.osName} ${caps.osVersion}`);
    expect(caps.osName).toMatch(/Darwin|macOS/);
    // spacesd refuses a wrong token.
    const mod = await pool.module();
    const wrong = await mod
      .embedded()
      .spacesd(`http://${vm?.ip}:3211`, 'x'.repeat(48))
      .then((c) => c.displays())
      .then(
        () => 'accepted',
        (e: unknown) => String(e),
      );
    expect(wrong).toMatch(/Unauthenticated/);
  }, 600_000);

  it("MineVibe's guest setup: sudo, path-identical Vault folders, ripgrep and ~/codex", async () => {
    const r = await asLume(
      A,
      `id -un; sudo -n true && echo sudo-ok; readlink ${JSON.stringify(vaultRw)}; cat ${JSON.stringify(join(vaultRw, 'top.ts'))}; ` +
        `ls ${JSON.stringify(vaultRo)}; rg --version | head -1; ls ~/codex/`,
    );
    note('guest_setup', r.stdout.split('\n'));
    const lines = r.stdout.split('\n');
    expect(lines[0]).toBe('lume');
    expect(lines[1]).toBe('sudo-ok');
    expect(lines[2]).toBe('/Volumes/My Shared Files/web-app');
    expect(lines[3]).toBe('export {};');
    expect(lines[4]).toBe('readme.txt');
    expect(lines[5]).toMatch(/^ripgrep 15\.2\.0/);
    expect(lines[6]).toBe('iron-cave.md');
    expect(manager.codexPathOf(A)).toBe('/Volumes/My Shared Files/codex');
    // The display was switched from the image's 1024x768 to the PC's 1280x800.
    const d = JSON.parse(await pc.displays()) as { bounds?: { width?: number; height?: number } }[];
    expect([d[0]?.bounds?.width, d[0]?.bounds?.height]).toEqual([1280, 800]);
  });

  it('a restarted MineVibe adopts the running VM (same token, resources and shares) instead of rebooting it', async () => {
    const pool2 = new SpacesdPool({ cachesDir: join(tmp, 'caches-adopt') });
    await pool2.module();
    const m2 = new PcManager({
      stateDir: join(tmp, 'state'),
      driver: new FakeDriver(),
      macDriver: mac,
      pool: pool2,
      labelValue: LABEL,
      diskPath: devLumeRoot(),
      codexExport: codex,
      bootTimeoutMs: 240_000,
    });
    await m2.init({ createDefault: false });
    expect(m2.instanceId).toBe(manager.instanceId);
    const t0 = performance.now();
    const r = await m2.reconcile();
    expect(r.adopted).toEqual([A]);
    const b = await m2.bootAll();
    note('adopt_to_running_ms', ms(t0));
    expect(b.booted).toEqual([A]);
    expect(m2.status(A).status).toBe('running');
    // Not rebooted: the guest's uptime goes on.
    const up = await asLume(A, 'sysctl -n kern.boottime | sed "s/.*sec = \\([0-9]*\\).*/\\1/"');
    expect(Date.now() / 1000 - Number(up.stdout)).toBeGreaterThan(20);
    pool2.close();
  });

  it('PcApi through the pc tools: bash as lume, files, read-only refusal, jobs and a kill by seat tag', async () => {
    seats = new SeatBook();
    router = manager.createInputRouter();
    api = new PcGuestApi({
      pcs: manager,
      client: (id) => pool.client(id),
      router,
      seats,
      jpegFormat: () => pool.jpegFormat,
    });
    seats.seat(A, { kind: 'agent', agentId: AGENT, seatEpoch: EPOCH });
    router.setOccupant(A, { kind: 'agent', id: AGENT });
    const host: PcHost = {
      agentId: AGENT,
      pcs: api,
      plans: new PlanCapture(['/Users/lume']),
      handoffs: new HandoffNotes(join(tmp, 'handoffs')),
      access: () => ({ pcId: A, epoch: EPOCH }),
      authorName: () => 'Ada',
      playerName: () => 'Jordan',
      batch,
    };
    tools = (createPcServer(host).instance as unknown as { _registeredTools: Registered })._registeredTools;
    const info = await api.info(A);
    expect(info).toMatchObject({
      os: 'macos',
      user: 'lume',
      home: '/Users/lume',
      codexPath: '/Volumes/My Shared Files/codex',
    });

    let t0 = performance.now();
    let r = await tool('bash', { command: 'id -un; pwd; echo "$MV_TAG"' });
    note('bash_first_ms', ms(t0));
    expect(r.text.split('\n')).toEqual(['lume', vaultRw, TAG]);
    r = await tool('bash', { command: 'mkdir -p sub/dir && cd sub/dir && pwd' });
    expect(r.text).toBe(join(vaultRw, 'sub', 'dir'));
    r = await tool('bash', { command: 'pwd' });
    expect(r.text).toBe(join(vaultRw, 'sub', 'dir'));
    r = await tool('bash', { command: 'cd ~ && (echo oops >&2; exit 3)' });
    expect(r).toMatchObject({ isError: true, text: 'Exit code 3\noops' });
    // umask 022: what the agent makes is readable on the Mac like anything else.
    await tool('bash', { command: `cd ${JSON.stringify(vaultRw)} && echo made > made.txt` });
    expect(statSync(join(vaultRw, 'made.txt')).mode & 0o777).toBe(0o644);

    const file = join(vaultRw, 'src', 'app.ts');
    t0 = performance.now();
    const read = await tool('read', { file_path: file });
    note('read_ms', ms(t0));
    expect(read.text).toBe('1\texport const greeting = "hello";\n2\texport const answer = 41;\n3\t');
    const edit = await tool('edit', {
      file_path: file,
      old_string: 'answer = 41',
      new_string: 'answer = 42',
    });
    expect(edit.isError).toBe(false);
    expect(readFileSync(file, 'utf8')).toBe('export const greeting = "hello";\nexport const answer = 42;\n');
    const grep = await tool('grep', { pattern: 'answer', path: vaultRw, output_mode: 'content' });
    expect(grep.text.split('\n').sort()).toEqual(
      ['src/app.ts:2:export const answer = 42;', 'src/deep/util.ts:1:// answer lives in app.ts'].sort(),
    );
    const glob = await tool('glob', { pattern: '**/*.ts', path: vaultRw });
    expect(glob.text.split('\n').sort()).toEqual(['src/app.ts', 'src/deep/util.ts', 'top.ts']);
    const written = await tool('write', {
      file_path: join(vaultRw, 'notes', 'todo.md'),
      content: '- ship it\n',
    });
    expect(written.isError).toBe(false);
    expect(readFileSync(join(vaultRw, 'notes', 'todo.md'), 'utf8')).toBe('- ship it\n');
    const refused = await tool('write', { file_path: join(vaultRo, 'nope.txt'), content: 'x' });
    expect(refused.isError).toBe(true);
    note('ro_write_refusal', refused.text);
    expect(existsSync(join(vaultRo, 'nope.txt'))).toBe(false);

    const started = await tool('bash', {
      command: 'for i in $(seq 1 1000); do echo tick-$i; sleep 0.2; done',
      run_in_background: true,
    });
    const jobId = /ID: (b[0-9a-f]{8})\./.exec(started.text)?.[1] as string;
    expect(started.text).toContain(`/Users/lume/.mv/jobs/${jobId}.out`);
    await sleep(1500);
    expect((await tool('read', { file_path: `/Users/lume/.mv/jobs/${jobId}.out` })).text).toContain(
      '\ttick-1',
    );
    await tool('bash', { command: 'nohup sleep 271 >/dev/null 2>&1 & echo left' });
    await tool('bash', { command: 'sudo -n sleep 273 >/dev/null 2>&1 & echo left' });
    // An app the open tool starts carries the seat's tag (`open --env`), so standing up closes it too.
    t0 = performance.now();
    const opened = await tool('open', { target: 'TextEdit' });
    note('open_textedit_ms', ms(t0));
    note('open_textedit', opened.text.split('\n').slice(0, 2).join(' | '));
    expect(opened.isError).toBe(false);
    await sleep(600);
    expect(Number((await asLume(A, 'pgrep -f "sleep 27[13]" | wc -l')).stdout)).toBeGreaterThanOrEqual(2);
    expect((await asLume(A, 'pgrep -x TextEdit >/dev/null && echo up')).stdout).toBe('up');
    const killed = await api.killTag(A, TAG);
    note('killed_by_tag', killed);
    await sleep(500);
    expect((await asLume(A, 'pgrep -f "sleep 27[13]|seq 1 1000" | wc -l')).stdout).toBe('0');
    expect((await asLume(A, 'pgrep -x TextEdit || echo gone')).stdout).toBe('gone');
  }, 300_000);

  it('a host-side rename-replace shows in the guest after the view refresh', async () => {
    const f = join(vaultRw, 'swap.txt');
    writeFileSync(f, 'v1\n');
    await sleep(300);
    expect((await tool('read', { file_path: f })).text).toBe('1\tv1\n2\t');
    // An editor's atomic save (a new inode): without a refresh the guest says "No such file" (S6).
    writeFileSync(`${f}.tmp`, 'v2 from the Mac\n');
    renameSync(`${f}.tmp`, f);
    await sleep(800); // FSEvents latency
    const t0 = performance.now();
    const after = await tool('read', { file_path: f });
    note('refresh_and_read_ms', ms(t0));
    expect(after.text).toBe('1\tv2 from the Mac\n2\t');
    // In-place rewrite of the same size.
    writeFileSync(f, 'v3 from the Mac\n');
    await sleep(800);
    expect((await tool('read', { file_path: f })).text).toBe('1\tv3 from the Mac\n2\t');
  });

  it('frames: JPEG screenshots and the BGRA stream', async () => {
    const lat: number[] = [];
    for (let i = 0; i < 6; i++) {
      const t0 = performance.now();
      const s = await pc.screenshot({
        format: pool.jpegFormat,
        quality: 80,
        maxDimension: 1280,
        includeCursor: false,
      });
      if (i > 0) lat.push(performance.now() - t0);
      expect(s.width).toBe(1280);
    }
    note('jpeg_1280_p50_ms', Math.round(pct(lat, 50)));
    let n = 0;
    let bytes = 0;
    let codec = '';
    const slot = manager.slotOf(A) as number;
    frames = manager.createFrameService(
      {
        sendFrame: (f) => {
          const d = decodeFrame(f);
          n++;
          bytes += f.byteLength;
          codec = `codec ${d.header.codec} ${d.header.w}x${d.header.h}`;
          // The mod acks each decoded frame.
          queueMicrotask(() => frames.ack(slot, d.header.seq));
          return true;
        },
      },
      { jpegFormat: pool.jpegFormat },
    );
    frames.setTier(A, { mode: 'focus' });
    await sleep(1500);
    const before = n;
    const t0 = performance.now();
    // Damage: typing into a terminal.
    await asLume(A, 'open -a Terminal');
    for (let i = 0; i < 40; i++) {
      await pc.typeText('x').catch(() => {});
      await sleep(50);
    }
    const secs = (performance.now() - t0) / 1000;
    note('focus_fps', +((n - before) / secs).toFixed(1));
    note('focus_mb_per_s', +(bytes / 1e6 / ((performance.now() - t0) / 1000)).toFixed(1));
    note('focus_frames', codec);
    expect(n - before).toBeGreaterThan(10);
    frames.setTier(A, { mode: 'none' });
  });

  it("the player's input: typed text lands exactly, and Cmd (KEY_META) + Q quits Terminal", async () => {
    seats.seat(A, { kind: 'player' });
    router.setOccupant(A, { kind: 'player', id: 'player' });
    try {
      // (No osascript: Apple events from spacesd's processes would ask for an Automation consent in the guest.)
      await asLume(A, 'rm -f /tmp/mv-typed.txt; pkill -x Terminal; sleep 1; open -a Terminal');
      await sleep(2500);
      const text = 'echo "Hello, World! éà #$%" > /tmp/mv-typed.txt';
      const t0 = performance.now();
      router.submit(A, { kind: 'player', id: 'player' }, [
        { k: 'text', text },
        { k: 'key', key: 'KEY_ENTER', down: true },
        { k: 'key', key: 'KEY_ENTER', down: false },
      ]);
      let typed = '';
      for (let i = 0; i < 40 && typed !== 'Hello, World! éà #$%'; i++) {
        await sleep(250);
        typed = (await asLume(A, 'cat /tmp/mv-typed.txt 2>/dev/null')).stdout;
      }
      note('typed_48_chars_ms', ms(t0));
      expect(typed).toBe('Hello, World! éà #$%');
      router.submit(A, { kind: 'player', id: 'player' }, [
        { k: 'key', key: 'KEY_META', down: true },
        { k: 'key', key: 'q', down: true },
        { k: 'key', key: 'q', down: false },
        { k: 'key', key: 'KEY_META', down: false },
      ]);
      await sleep(2500);
      expect((await asLume(A, 'pgrep -x Terminal || echo gone')).stdout).toBe('gone');
    } finally {
      seats.unseat(A, { kind: 'player' }, false);
      seats.seat(A, { kind: 'agent', agentId: AGENT, seatEpoch: EPOCH });
      router.setOccupant(A, { kind: 'agent', id: AGENT });
    }
  });

  it('ShellMirror: a Terminal window tails the shell log while the agent sits and closes when it stands', async () => {
    mirror = new ShellMirror({
      client: (id) => pool.client(id),
      sweep: (id, n, v) => api.sweep(id, n, v),
      osOf: () => 'macos',
    });
    await mirror.open(A, AGENT);
    let titles: string[] = [];
    for (let i = 0; i < 20 && !titles.includes(`Shell: ${AGENT}`); i++) {
      await sleep(300);
      titles = await windowTitles(pc);
    }
    expect(titles).toContain(`Shell: ${AGENT}`);
    await tool('bash', { command: 'echo mirror-check-$((40+2))' });
    await sleep(500);
    expect((await asLume(A, 'grep -c mirror-check-42 ~/.mv/shell.log')).stdout).not.toBe('0');
    await mirror.close(A);
    for (let i = 0; i < 20 && titles.includes(`Shell: ${AGENT}`); i++) {
      await sleep(300);
      titles = await windowTitles(pc);
    }
    note('mirror_titles_after_close', titles);
    expect(titles).not.toContain(`Shell: ${AGENT}`);
    expect((await asLume(A, 'pgrep -f "tail -n 200 -F" || echo gone')).stdout).toBe('gone');
  });

  it("a second PC; a third is refused by the budget, and a third VM by Apple's limit", async () => {
    const t0 = performance.now();
    await manager.create({ type: 'macos', id: B, cpus: 2, memMiB: 4096, boot: true });
    note('second_create_to_running_ms', ms(t0));
    expect(manager.status(B).status).toBe('running');
    const b = await manager.budget();
    expect(b.allocated.macosRunning).toBe(2);
    await manager.create({ type: 'macos', id: 'mc-third' });
    await expect(manager.start('mc-third')).rejects.toMatchObject({ code: 'MACOS_SLOTS' });
    expect(manager.status('mc-third').status).toBe('macos_slots_full');
    note('third_pc', manager.status('mc-third'));
    await manager.decommission('mc-third');
    // Past the budget: Virtualization itself refuses a third macOS VM, and the driver reads why from Lume's log.
    const name = `mv-pc-${manager.instanceId}-mc-raw`;
    await mac.create({
      name,
      cpus: 2,
      memoryMiB: 4096,
      display: [1280, 800],
      labels: { [MANAGED_LABEL]: LABEL },
    });
    const err = await mac.start({ name, token: 'x'.repeat(48), shares: [] }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(MacStartError);
    expect((err as MacStartError).code).toBe('MACOS_SLOTS');
    note('apple_limit', (err as Error).message);
    await mac.remove(name);
  }, 600_000);

  it('stop and start times, a resize, a guest-side shutdown seen as a crash, and a reimage', async () => {
    await asLume(B, 'echo keep > ~/marker.txt');
    let t0 = performance.now();
    await manager.stop(B);
    note('graceful_stop_ms', ms(t0));
    expect(manager.status(B).status).toBe('off');
    t0 = performance.now();
    await manager.start(B);
    note('warm_start_to_running_ms', ms(t0));
    expect((await asLume(B, 'cat ~/marker.txt')).stdout).toBe('keep');
    t0 = performance.now();
    const res = await manager.resize(B, { cpus: 3 });
    note('resize_restart_ms', ms(t0));
    expect(res.restarted).toBe(true);
    expect((await asLume(B, 'sysctl -n hw.ncpu')).stdout).toBe('3');
    // Shut down from inside: Lume keeps saying "running"; the serve log tells the monitor.
    await asLume(B, 'sudo -n shutdown -h now >/dev/null 2>&1 &').catch(() => {});
    const t1 = Date.now();
    for (;;) {
      await manager.monitorOnce();
      if (manager.status(B).status !== 'running' || Date.now() - t1 > 90_000) break;
      await sleep(2000);
    }
    note('guest_shutdown_seen_ms', Date.now() - t1);
    expect(manager.status(B)).toMatchObject({ status: 'error', reason: 'crashed' });
    t0 = performance.now();
    await manager.start(B);
    note('restart_after_crash_ms', ms(t0));
    expect((await asLume(B, 'cat ~/marker.txt')).stdout).toBe('keep');
    t0 = performance.now();
    await manager.reimage(B);
    note('reimage_to_running_ms', ms(t0));
    expect((await asLume(B, 'cat ~/marker.txt 2>/dev/null || echo fresh')).stdout).toBe('fresh');
  }, 900_000);

  it('decommission removes the VMs and their shares; numbers', async () => {
    const names = [A, B].map((id) => manager.containerNameOf(id));
    const alloc = await Promise.all(names.map((n) => mac.inspect(n)));
    note(
      'clone_allocated_gib',
      alloc.map((v) => +((v?.diskAllocatedBytes ?? 0) / GiB).toFixed(1)),
    );
    note('disk_used_by_run_gib', +((diskBefore - freeDisk()) / GiB).toFixed(1));
    for (const id of [A, B]) {
      const t0 = performance.now();
      await manager.decommission(id);
      note(`decommission_${id === A ? 'a' : 'b'}_ms`, ms(t0));
    }
    for (const n of names) {
      expect(await mac.inspect(n)).toBeNull();
      expect(existsSync(join(runtime.sharesDir, n))).toBe(false);
    }
    const h = createHash('sha256')
      .update(readFileSync(join(vaultRw, 'src', 'app.ts')))
      .digest('hex')
      .slice(0, 8);
    note('vault_kept', h);
  });
});
