/**
 * PC driver integration suite (`npm run test:pcs`, PLAN §13.5): the real Apple `container` 1.5.0 runtime,
 * the MineVibe Linux PC image and spacesd through `@trycua/cua`.
 *
 * Provision runtime → build/pull image → create a PC with a temp Vault + overlay → SERVING → JPEG
 * screenshot → 3 s BGRA stream → input into a terminal → spawn as cua in the mount → read-only mount →
 * capped /tmp + /var/tmp → spacesd refuses a missing/wrong token (Unauthenticated) → recreate keeps the
 * home volume → budget refusals (by resource) → per-PC networks isolate PCs → guest cannot reach host
 * loopback → monitor: crash, then start on the same rootfs → restart() keeps the rootfs → a taken port
 * recreates visibly → a second live engine lease keeps the engine running → cleanup.
 *
 * Everything it creates carries a per-run label `minevibe=pc-test-<run>` and a per-run instance id (the
 * temp state dir), and is deleted at the end. The container system is stopped at the end only when this
 * run started it. Roots default to the dev roots outside ~/Documents.
 */
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeFrame, type Mvf1Header } from '@minevibe/protocol';
import type { SpacesdClientLike } from '@trycua/cua';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findRepoRoot } from '../../../src/config/paths.js';
import { AppleContainerDriver } from '../../../src/pcs/drivers/AppleContainerDriver.js';
import {
  ContainerRuntime,
  devContainerRoots,
  readContainerLock,
} from '../../../src/pcs/drivers/ContainerRuntime.js';
import { MANAGED_LABEL, tokenFingerprint } from '../../../src/pcs/drivers/PcDriver.js';
import type { FrameService } from '../../../src/pcs/FrameService.js';
import type { InputRouter } from '../../../src/pcs/InputRouter.js';
import { PcError, PcManager } from '../../../src/pcs/PcManager.js';
import { LINUX_PC_IMAGE_DEV } from '../../../src/pcs/PcTypes.js';
import type { CuaModule } from '../../../src/pcs/SpacesdPool.js';
import { SpacesdPool } from '../../../src/pcs/SpacesdPool.js';

const RUN = `${process.pid.toString(36)}${Date.now().toString(36).slice(-4)}`;
/** Per-run label (M1): concurrent runs and other dev servers never see each other's resources. */
const LABEL = `pc-test-${RUN}`;
const repo = findRepoRoot(fileURLToPath(import.meta.url)) as string;
const roots = {
  appRoot: process.env.MINEVIBE_CONTAINER_APP_ROOT ?? devContainerRoots().appRoot,
  installRoot: process.env.MINEVIBE_CONTAINER_INSTALL_ROOT ?? devContainerRoots().installRoot,
};
const ID = `it-${process.pid.toString(36)}`;
const ID_B = `${ID}-b`;
let NAME: string;

const results: Record<string, unknown> = {};
const note = (k: string, v: unknown) => {
  results[k] = v;
  console.log(`[pcs] ${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`);
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
let runtime: ContainerRuntime;
let driver: AppleContainerDriver;
let pool: SpacesdPool;
let manager: PcManager;
let pc: SpacesdClientLike;
let engineBefore = 'unknown';

async function cleanupLabelled(): Promise<void> {
  for (const c of await driver.list({ [MANAGED_LABEL]: LABEL })) await driver.remove(c.name);
  for (const v of await driver.listVolumes({ [MANAGED_LABEL]: LABEL })) await driver.removeVolume(v.name);
  for (const n of await driver.listNetworks({ [MANAGED_LABEL]: LABEL })) await driver.removeNetwork(n.name);
}

async function asCua(pcId: string, script: string, cwd?: string) {
  const c = await pool.client(pcId);
  const out = await c.run({
    program: 'bash',
    args: ['-lc', script],
    env: new Map(),
    stdin: false,
    user: 'cua',
    ...(cwd ? { cwd } : {}),
    timeoutMs: 20_000,
  });
  return {
    ok: out.exit.success,
    code: out.exit.code,
    stdout: txt(out.stdout).trim(),
    stderr: txt(out.stderr).trim(),
  };
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

async function findWindow(title: string, timeoutMs = 10_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const w = JSON.parse(await pc.callJson('/cua.env.v1.WindowsService/ListWindows', '{}')) as {
      windows?: { title?: string; bounds?: { x: number; y: number; width: number; height: number } }[];
    };
    const hit = (w.windows ?? []).find((x) => (x.title ?? '').includes(title));
    if (hit?.bounds) return hit.bounds;
    await sleep(250);
  }
  throw new Error(`window ${title} did not appear`);
}

beforeAll(async () => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'mv-pcs-int-')));
  vaultRw = join(tmp, 'vault-rw');
  vaultRo = join(tmp, 'vault-ro');
  mkdirSync(join(vaultRw, '.git'), { recursive: true });
  writeFileSync(join(vaultRw, 'package.json'), '{"name":"it"}\n');
  mkdirSync(vaultRo, { recursive: true });
  writeFileSync(join(vaultRo, 'readme.txt'), 'read only\n');

  const lock = await readContainerLock(join(repo, 'packaging', 'vendor.lock.json'));
  runtime = new ContainerRuntime({
    ...roots,
    lock,
    cacheDir: join(homedir(), 'Library', 'Caches', 'MineVibe-dev', 'vendor'),
    ...(process.env.MINEVIBE_CONTAINER_PKG ? { pkgPath: process.env.MINEVIBE_CONTAINER_PKG } : {}),
    leaseHolder: `test:pcs ${RUN}`,
  });
  driver = new AppleContainerDriver(runtime);
  let t0 = performance.now();
  await runtime.provision((m) => console.log(`[pcs] ${m}`));
  note('provision_ms', ms(t0));
  const before = await runtime.status();
  engineBefore = before.ownership;
  note('engine_before', before.ownership);
  t0 = performance.now();
  await driver.ensureEngine();
  note('engine_start_ms', ms(t0));

  await cleanupLabelled();
  t0 = performance.now();
  const hadImage = await driver.imageExists(LINUX_PC_IMAGE_DEV);
  if (!hadImage || process.env.MV_PCS_REBUILD === '1') {
    await driver.buildImage({
      contextDir: join(repo, 'images', 'linux-pc'),
      file: join(repo, 'images', 'linux-pc', 'Containerfile'),
      tag: LINUX_PC_IMAGE_DEV,
    });
    note('image_build_ms', ms(t0));
  } else note('image', 'present (set MV_PCS_REBUILD=1 to rebuild)');

  pool = new SpacesdPool({ cachesDir: join(tmp, 'caches') });
  await pool.module();
  manager = new PcManager({
    stateDir: join(tmp, 'state'),
    driver,
    pool,
    labelValue: LABEL,
    diskPath: roots.appRoot,
    bootTimeoutMs: 180_000,
    imageBuild: {
      contextDir: join(repo, 'images', 'linux-pc'),
      file: join(repo, 'images', 'linux-pc', 'Containerfile'),
    },
  });
  await manager.init({ createDefault: false });
  NAME = manager.containerNameOf(ID);
  note('instance', manager.instanceId);
});

afterAll(async () => {
  for (const id of [ID_B, ID]) {
    try {
      if (manager?.get(id)) await manager.decommission(id);
    } catch (err) {
      console.log(`[pcs] decommission ${id} failed: ${String(err)}`);
    }
  }
  try {
    if (driver) await cleanupLabelled();
    const left = driver ? await driver.list({ [MANAGED_LABEL]: LABEL }) : [];
    const leftVols = driver ? await driver.listVolumes({ [MANAGED_LABEL]: LABEL }) : [];
    const leftNets = driver ? await driver.listNetworks({ [MANAGED_LABEL]: LABEL }) : [];
    note('leftover_containers', left.length);
    note('leftover_volumes', leftVols.length);
    note('leftover_networks', leftNets.length);
    await manager?.shutdown({ stopEngine: false });
    // M1/N4: stop the engine only when this run started it (never one that was already running), and
    // even then only when no other live MineVibe holds a lease on it; always drop our own lease.
    if (runtime && engineBefore === 'not_running') {
      note('engine_stopped', await runtime.releaseAndStopIfUnused());
    } else {
      await runtime?.leases.release();
      note('engine_stopped', `left running (was ${engineBefore} before the run)`);
    }
  } finally {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
    console.log(`[pcs] RESULTS ${JSON.stringify(results)}`);
  }
});

describe('Linux PC on Apple container', () => {
  it('runtime is ours, from the bundled-style roots outside ~/Documents', async () => {
    const st = await runtime.status();
    expect(st.ownership).toBe('ours');
    expect(st.serverVersion).toBe('1.5.0');
    expect(st.appRoot && realpathSync(st.appRoot)).toBe(realpathSync(roots.appRoot));
  });

  it('creates a PC with a temp Vault (rw + ro) and an overlay, and reaches SERVING', async () => {
    const t0 = performance.now();
    const { warnings } = await manager.create({
      type: 'linux',
      id: ID,
      mounts: [
        { host: vaultRw, overlays: ['node_modules'] },
        { host: vaultRo, ro: true },
      ],
      boot: true,
    });
    note('create_to_serving_ms', ms(t0));
    expect(warnings.join('\n')).toMatch(/An agent can put code here/);
    expect(manager.status(ID).status).toBe('running');
    const info = await driver.inspect(NAME);
    expect(info?.hostAddress).toBe('127.0.0.1');
    expect(info?.networks).toEqual([manager.networkNameOf(ID)]);
    expect(info?.labels).toMatchObject({ [MANAGED_LABEL]: LABEL, 'minevibe.instance': manager.instanceId });
    expect(info?.binds).toEqual(
      expect.arrayContaining([
        { source: vaultRw, target: vaultRw, readonly: false },
        { source: vaultRo, target: vaultRo, readonly: true },
      ]),
    );
    expect(info?.volumes.map((v) => v.target).sort()).toEqual(
      ['/home/cua', '/tmp', '/var/tmp', join(vaultRw, 'node_modules')].sort(),
    );
    note('cpus_seen_by_runtime', { cpus: info?.cpus, cpuOverhead: info?.cpuOverhead });
    // inspect shows the token in plaintext; the driver keeps only its fingerprint, and it is ours.
    const token = readFileSync(join(manager.tokensDir, `${ID}.token`), 'utf8').trim();
    expect(info?.tokenSha256).toBe(tokenFingerprint(token));
    expect(JSON.stringify(info)).not.toContain(token);
    // N4: this process holds an engine lease in the app root.
    const leases = readdirSync(runtime.leases.dir).filter((f) => f.startsWith(`${process.pid}-`));
    expect(leases).toHaveLength(1);
    pc = await pool.client(ID);
    note('transport', pc.transport());
    const health = await pool.health(ID);
    expect(health.serving).toBe(true);
    const disp = JSON.parse(await pc.displays()) as { bounds?: { width: number; height: number } }[];
    note('display', disp[0]?.bounds);
  });

  it('home volume was seeded from the skeleton and chowned by the boot hook', async () => {
    const r = await asCua(
      ID,
      'stat -c "%U:%G %a" /home/cua; ls -A /home/cua | sort | tr "\\n" " "; test -f /home/cua/.bashrc && echo bashrc-ok; nproc',
    );
    note('home', r.stdout.replace(/\n/g, ' | '));
    expect(r.stdout).toMatch(/^cua:cua/);
    expect(r.stdout).toContain('bashrc-ok');
    expect(r.stdout).not.toContain('lost+found');
  });

  it('serves JPEG screenshots', async () => {
    const lat: number[] = [];
    let bytes = 0;
    let size = '';
    for (let i = 0; i < 12; i++) {
      const t0 = performance.now();
      const s = await pc.screenshot({
        format: pool.jpegFormat,
        quality: 75,
        maxDimension: 1280,
        includeCursor: false,
      });
      lat.push(performance.now() - t0);
      const b = new Uint8Array(s.image);
      expect(b[0]).toBe(0xff);
      expect(b[1]).toBe(0xd8);
      bytes += b.byteLength;
      size = `${s.width}x${s.height}`;
    }
    note('jpeg_1280', {
      size,
      p50ms: +pct(lat.slice(2), 50).toFixed(1),
      p95ms: +pct(lat.slice(2), 95).toFixed(1),
      avgKB: Math.round(bytes / 12 / 1024),
    });
  });

  it('streams BGRA frames for 3 s through FrameService (focus tier) as MVF1', async () => {
    const damage = await pc.spawn({
      program: 'xfce4-terminal',
      args: [
        '--title=mvdamage',
        '--geometry=100x30+80+80',
        '--disable-server',
        '-x',
        'sh',
        '-c',
        'while true; do date +%s.%N; done',
      ],
      env: new Map([['DISPLAY', ':1']]),
      user: 'cua',
      stdin: false,
      tag: 'mv-it-damage',
    });
    await findWindow('mvdamage');
    const frames: { t: number; h: Mvf1Header; n: number }[] = [];
    const slot = manager.slotOf(ID) as number;
    let svc: FrameService | null = null;
    svc = manager.createFrameService({
      sendFrame: (f) => {
        const d = decodeFrame(f);
        frames.push({ t: performance.now(), h: d.header, n: f.byteLength });
        // The mod acks each decoded frame.
        queueMicrotask(() => svc?.ack(slot, d.header.seq));
        return true;
      },
    });
    svc.setTier(ID, { mode: 'focus' });
    await sleep(500);
    const start = performance.now();
    const from = frames.length;
    await sleep(3000);
    const got = frames.slice(from);
    const secs = (performance.now() - start) / 1000;
    svc.setTier(ID, { mode: 'none' });
    const stats = svc.stats(ID);
    await svc.close();
    await damage.kill().catch(() => {});
    const fps = got.length / secs;
    const first = got[0]?.h;
    note('bgra_stream', {
      seconds: +secs.toFixed(2),
      frames: got.length,
      fps: +fps.toFixed(1),
      size: first ? `${first.w}x${first.h}` : null,
      MBps: +(got.reduce((a, f) => a + f.n, 0) / secs / 1e6).toFixed(1),
      superseded: stats?.superseded,
      sinkSkipped: stats?.sinkSkipped,
    });
    expect(first?.codec).toBe(3);
    expect(first?.pcSlot).toBe(slot);
    expect(fps).toBeGreaterThan(15);
  });

  it('JPEG visible tier delivers 2–4 fps', async () => {
    const frames: Mvf1Header[] = [];
    const slot = manager.slotOf(ID) as number;
    let svc: FrameService | null = null;
    svc = manager.createFrameService({
      sendFrame: (f) => {
        const h = decodeFrame(f).header;
        frames.push(h);
        queueMicrotask(() => svc?.ack(slot, h.seq));
        return true;
      },
    });
    // A clock in the terminal guarantees a changing image.
    const clock = await pc.spawn({
      program: 'xfce4-terminal',
      args: [
        '--title=mvclock',
        '--geometry=40x5+600+500',
        '--disable-server',
        '-x',
        'sh',
        '-c',
        'while true; do date +%s.%N; sleep 0.05; done',
      ],
      env: new Map([['DISPLAY', ':1']]),
      user: 'cua',
      stdin: false,
      tag: 'mv-it-clock',
    });
    await findWindow('mvclock');
    svc.setTier(ID, { mode: 'visible', px: 500 });
    await sleep(3000);
    svc.setTier(ID, { mode: 'none' });
    await svc.close();
    await clock.kill().catch(() => {});
    note('jpeg_visible_640', {
      frames: frames.length,
      fps: +(frames.length / 3).toFixed(1),
      size: frames[0] ? `${frames[0].w}x${frames[0].h}` : null,
    });
    expect(frames.length).toBeGreaterThanOrEqual(6);
    expect(frames[0]?.codec).toBe(1);
    expect(frames[0]?.w).toBe(640);
  });

  it('routes player input into a terminal (text lands, frame hash changes)', async () => {
    const term = await pc.spawn({
      program: 'xfce4-terminal',
      args: ['--title=mvterm', '--geometry=90x24+100+100', '--disable-server'],
      env: new Map([['DISPLAY', ':1']]),
      user: 'cua',
      stdin: false,
      tag: 'mv-it-term',
    });
    const b = await findWindow('mvterm');
    const router: InputRouter = manager.createInputRouter();
    const player = { kind: 'player' as const, id: 'jasper' };
    router.setOccupant(ID, player);
    router.setDisplay(ID, 1280, 800);
    const cx = Math.round(b.x + b.width / 2);
    const cy = Math.round(b.y + b.height / 2);
    const h0 = await shotHash();
    const t0 = performance.now();
    // The T0 `pc.input` event objects, as PcControlScreen sends them.
    router.submit(ID, player, [
      { k: 'move', x: cx - 40, y: cy - 20 },
      { k: 'move', x: cx - 20, y: cy - 10 },
      { k: 'move', x: cx, y: cy },
      { k: 'button', button: 'left', down: true, x: cx, y: cy },
      { k: 'button', button: 'left', down: false, x: cx, y: cy },
    ]);
    await router.idle(ID);
    await sleep(200);
    router.submit(ID, player, [
      { k: 'text', text: 'echo mv-typed-$((6*7)) > /tmp/mv-typed.txt' },
      { k: 'key', key: 'KEY_ENTER', down: true },
      { k: 'key', key: 'KEY_ENTER', down: false },
      { k: 'key', key: 'KEY_SHIFT', down: true },
    ]);
    await router.idle(ID);
    expect(router.held(ID).keys).toEqual(['KEY_SHIFT']);
    await router.releaseAll(ID);
    note('input_roundtrip_ms', ms(t0));
    await sleep(600);
    const typed = await asCua(ID, 'cat /tmp/mv-typed.txt');
    const h1 = await shotHash();
    const cur = await pc.cursorPosition();
    note('input', { typed: typed.stdout, hashChanged: h0 !== h1, cursor: cur, stats: router.stats(ID) });
    expect(typed.stdout).toBe('mv-typed-42');
    expect(h1).not.toBe(h0);
    expect(cur).toEqual({ x: cx, y: cy });
    router.setOccupant(ID, null);
    await term.kill().catch(() => {});
  });

  it('spawns bash as cua inside the rw mount; the host sees the file; the overlay stays in the guest', async () => {
    const r = await asCua(
      ID,
      'id -un; pwd; echo from-guest > guest-file.txt; echo linux-artifact > node_modules/built.txt && echo overlay-ok; stat -c "%U %a" node_modules',
      vaultRw,
    );
    note('spawn_in_mount', r.stdout.replace(/\n/g, ' | '));
    expect(r.ok).toBe(true);
    expect(r.stdout.split('\n').slice(0, 2)).toEqual(['cua', vaultRw]);
    expect(r.stdout).toContain('overlay-ok');
    expect(readFileSync(join(vaultRw, 'guest-file.txt'), 'utf8')).toBe('from-guest\n');
    expect(statSync(join(vaultRw, 'guest-file.txt')).uid).toBe(process.getuid?.());
    // The overlay is a named volume: the host only has the empty mountpoint.
    expect(readdirSync(join(vaultRw, 'node_modules'))).toEqual([]);
  });

  it('a read-only mount refuses writes', async () => {
    const r = await asCua(ID, `cat readme.txt; touch ${vaultRo}/nope.txt 2>&1; echo rc=$?`, vaultRo);
    note('ro_mount', r.stdout.replace(/\n/g, ' | '));
    expect(r.stdout).toContain('read only');
    expect(r.stdout).toMatch(/Read-only file system/);
    expect(r.stdout).toMatch(/rc=1/);
    expect(existsSync(join(vaultRo, 'nope.txt'))).toBe(false);
  });

  it('/tmp and /var/tmp are capped volumes (1777; /tmp starts empty)', async () => {
    const r = await asCua(
      ID,
      'for d in /tmp /var/tmp; do echo "$d $(stat -c %a $d) $(df -BG --output=size $d | tail -1 | tr -d " ")"; done; touch /tmp/mv-x && echo tmp-writable; ls -A /tmp | grep -c lost+found || true',
    );
    note('tmp_volumes', r.stdout.replace(/\n/g, ' | '));
    const lines = r.stdout.split('\n');
    const size = (d: string) =>
      Number((lines.find((l) => l.startsWith(`${d} `)) ?? '').split(' ')[2]?.replace('G', ''));
    expect(lines[0]).toMatch(/^\/tmp 1777 /);
    expect(lines[1]).toMatch(/^\/var\/tmp 1777 /);
    expect(size('/tmp')).toBeLessThanOrEqual(8);
    expect(size('/var/tmp')).toBeLessThanOrEqual(4);
    expect(r.stdout).toContain('tmp-writable');
  });

  it('spacesd rejects a missing or wrong token (L10)', async () => {
    const mod = (await pool.module()) as CuaModule;
    const port = manager.get(ID)?.hostPort as number;
    const url = `http://127.0.0.1:${port}`;
    const attempt = async (token: string | undefined) => {
      const signal = AbortSignal.timeout(8000);
      const c = await mod.embedded().spacesd(url, token, { signal });
      return (c as unknown as SpacesdClientLike).displays({ signal });
    };
    const outcome = (e: unknown) => ({
      tag: (e as { tag?: unknown }).tag,
      message: String(e).slice(0, 160),
    });
    const wrong = await attempt('0'.repeat(48)).then(() => 'accepted' as const, outcome);
    const missing = await attempt(undefined).then(() => 'accepted' as const, outcome);
    note('spacesd_auth', { wrong, missing });
    // L10: refused as Unauthenticated specifically (not a transport error or a timeout).
    expect(wrong).toMatchObject({
      tag: 'Unauthenticated',
      message: expect.stringMatching(/Unauthenticated/),
    });
    expect(missing).toMatchObject({
      tag: 'Unauthenticated',
      message: expect.stringMatching(/Unauthenticated/),
    });
    // Positive control: the real token works.
    expect(JSON.parse(await pc.displays()).length).toBeGreaterThan(0);
  });

  it('recreate (resize) keeps the home volume and the Vault', async () => {
    const marker = `persist-${Date.now()}`;
    expect((await asCua(ID, `echo ${marker} > /home/cua/mv-persist.txt`)).ok).toBe(true);
    const t0 = performance.now();
    await manager.resize(ID, { cpus: 1, memMiB: 3072 });
    note('recreate_to_serving_ms', ms(t0));
    expect(manager.status(ID).status).toBe('running');
    const info = await driver.inspect(NAME);
    expect(info).toMatchObject({ cpus: 1, memoryBytes: 3072 * 1024 * 1024 });
    pc = await pool.client(ID);
    const r = await asCua(ID, 'cat /home/cua/mv-persist.txt; cat guest-file.txt; nproc', vaultRw);
    note('after_recreate', r.stdout.replace(/\n/g, ' | '));
    expect(r.stdout.split('\n').slice(0, 2)).toEqual([marker, 'from-guest']);
    expect((await driver.listVolumes({ [MANAGED_LABEL]: LABEL })).map((v) => v.name)).toContain(
      manager.homeVolumeOf(ID),
    );
  });

  it('refuses an over-budget resize and an over-budget PC, naming the resource (H5)', async () => {
    const err = await manager.resize(ID, { memMiB: 60 * 1024 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PcError);
    expect(err).toMatchObject({ code: 'OVER_BUDGET', resource: 'memory' });
    note('budget_refusal', (err as Error).message);
    const err2 = await manager
      .create({
        type: 'linux',
        id: `${ID}-big`,
        cpus: 16,
        memMiB: 64 * 1024,
        // Tiny disk caps, so the refusal is about memory whatever this Mac's free disk is.
        disk: { homeGiB: 1, overlayGiB: 1, tmpGiB: 1, varTmpGiB: 1, rootfsGiB: 0 },
        boot: true,
      })
      .catch((e: unknown) => e);
    expect(err2).toMatchObject({ code: 'OVER_BUDGET', resource: 'memory' });
    expect(manager.get(`${ID}-big`)).toBeUndefined();
    const err3 = await manager
      .create({ type: 'linux', id: `${ID}-disk`, disk: { homeGiB: 4000 } })
      .catch((e: unknown) => e);
    expect(err3).toMatchObject({ code: 'OVER_BUDGET', resource: 'disk' });
    const b = await manager.budget();
    note('budget', {
      ramPoolGiB: +(b.pool.memBytes / 2 ** 30).toFixed(1),
      cpuPool: b.pool.cpus,
      allocatedCpus: b.allocated.cpus,
      allocatedMemGiB: +(b.allocated.memBytes / 2 ** 30).toFixed(1),
      diskCapsGiB: +(b.allocated.diskBytes / 2 ** 30).toFixed(1),
      diskUsedByPcsGiB: +((b.host.diskUsedByPcsBytes ?? 0) / 2 ** 30).toFixed(2),
    });
    expect(b.host.diskUsedByPcsBytes).toBeGreaterThan(0);
    expect(manager.status(ID).status).toBe('running');
  });

  it('every PC has its own network; PCs cannot reach each other (M7)', async () => {
    await manager.create({ type: 'linux-slim', id: ID_B, cpus: 1, memMiB: 2048, boot: true });
    const a = await driver.inspect(NAME);
    const bInfo = await driver.inspect(manager.containerNameOf(ID_B));
    expect(bInfo?.networks).toEqual([manager.networkNameOf(ID_B)]);
    expect(a?.ipv4).toBeTruthy();
    expect(bInfo?.ipv4).toBeTruthy();
    const nets = await driver.listNetworks({ [MANAGED_LABEL]: LABEL });
    note(
      'networks',
      nets.map((n) => `${n.name} ${n.subnet}`),
    );
    const probe = (ip: string) =>
      `timeout 4 bash -c "</dev/tcp/${ip}/3211" 2>/dev/null && echo open || echo closed`;
    const fromA = await asCua(ID, `${probe(a?.ipv4 as string)}; ${probe(bInfo?.ipv4 as string)}`);
    const fromB = await asCua(ID_B, probe(a?.ipv4 as string));
    note('pc_isolation', {
      aSelf: fromA.stdout.split('\n')[0],
      aToB: fromA.stdout.split('\n')[1],
      bToA: fromB.stdout,
    });
    expect(fromA.stdout.split('\n')).toEqual(['open', 'closed']);
    expect(fromB.stdout).toBe('closed');
    await manager.decommission(ID_B);
    expect((await driver.listNetworks({ [MANAGED_LABEL]: LABEL })).map((n) => n.name)).toEqual([
      manager.networkNameOf(ID),
    ]);
  });

  it('a guest cannot reach a host service bound to 127.0.0.1', async () => {
    const srv = createServer((_q, res) => res.end('host-loopback'));
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const port = (srv.address() as { port: number }).port;
    try {
      const r = await asCua(
        ID,
        `GW=$(ip route 2>/dev/null | awk '/default/ {print $3; exit}'); GW=\${GW:-192.168.64.1}; echo gw=$GW; curl -s --max-time 3 http://$GW:${port}/ || echo unreachable`,
      );
      note('guest_to_host_loopback', r.stdout);
      expect(r.stdout).not.toContain('host-loopback');
      expect(r.stdout).toContain('unreachable');
    } finally {
      srv.close();
    }
  });

  /** A file on the container's own root filesystem (no volume): it survives only on the same container. */
  const ROOTFS_MARKER = '/var/lib/mv-rootfs-marker';
  let rootfsMarker = '';
  const readRootfsMarker = async () =>
    (await asCua(ID, `cat ${ROOTFS_MARKER} 2>/dev/null || echo missing`)).stdout;

  it('the monitor sees a healthy PC and a crash; a start comes back on the same rootfs (H4)', async () => {
    rootfsMarker = `rootfs-${Date.now()}`;
    const w = await asCua(ID, `echo ${rootfsMarker} | sudo -n tee ${ROOTFS_MARKER} >/dev/null && echo ok`);
    expect(w.stdout).toBe('ok');
    await manager.monitorOnce();
    expect(manager.status(ID)).toEqual({ status: 'running' });
    const port = manager.get(ID)?.hostPort;
    // Kill the container behind the manager's back: the next pass marks it crashed.
    await driver.stop(NAME, 2);
    await manager.monitorOnce();
    expect(manager.status(ID)).toMatchObject({ status: 'error', reason: 'crashed' });
    // A start brings it back on the same container: rootfs and port kept, nothing recreated.
    const t0 = performance.now();
    await manager.start(ID);
    note('restart_after_crash_ms', ms(t0));
    expect(manager.status(ID)).toEqual({ status: 'running' });
    expect(manager.get(ID)?.hostPort).toBe(port);
    pc = await pool.client(ID);
    expect(await readRootfsMarker()).toBe(rootfsMarker);
    await manager.monitorOnce();
    expect(manager.status(ID)).toEqual({ status: 'running' });
  });

  it('restart() (stop, then start at once) reuses the container: rootfs and port survive', async () => {
    const port = manager.get(ID)?.hostPort;
    const t0 = performance.now();
    await manager.restart(ID);
    note('restart_ms', ms(t0));
    // A port the engine had not released yet must not count as a conflict (that would recreate).
    expect(manager.status(ID)).toEqual({ status: 'running' });
    expect(manager.get(ID)?.hostPort).toBe(port);
    pc = await pool.client(ID);
    expect(await readRootfsMarker()).toBe(rootfsMarker);
    expect((await asCua(ID, 'cat /home/cua/mv-persist.txt')).stdout).toMatch(/^persist-/);
  });

  it('a loopback port taken by another program recreates the container visibly (home kept)', async () => {
    await manager.stop(ID);
    const port = manager.get(ID)?.hostPort as number;
    const squatter = createTcpServer();
    await new Promise<void>((r, j) => {
      squatter.once('error', j);
      squatter.listen({ host: '127.0.0.1', port, exclusive: true }, () => r());
    });
    try {
      const t0 = performance.now();
      await manager.start(ID);
      note('port_conflict_recreate_ms', ms(t0));
    } finally {
      await new Promise<void>((r) => squatter.close(() => r()));
    }
    const st = manager.status(ID);
    note('port_conflict_status', st);
    expect(st).toMatchObject({
      status: 'running',
      reason: 'port_conflict',
      detail: expect.stringMatching(new RegExp(`port ${port} is in use.*recreated on a new port`)),
    });
    expect(manager.get(ID)?.hostPort).not.toBe(port);
    pc = await pool.client(ID);
    // The home volume survives a recreate; the rootfs does not (which is why it is surfaced).
    expect((await asCua(ID, 'cat /home/cua/mv-persist.txt')).stdout).toMatch(/^persist-/);
    expect(await readRootfsMarker()).toBe('missing');
  });

  it('a second live engine lease keeps the engine running when this process lets go (N4)', async () => {
    const other = join(runtime.leases.dir, `${process.ppid}-it.json`);
    const started = await runtime.leases.processStart(process.ppid);
    writeFileSync(
      other,
      JSON.stringify({ pid: process.ppid, started, holder: 'test:pcs other', at: Date.now() }),
    );
    try {
      expect(await driver.shutdownEngine()).toBe(false);
      const st = await runtime.status();
      expect(st.ownership).toBe('ours');
      expect(st.state).toBe('running');
      expect((await pool.health(ID)).serving).toBe(true);
    } finally {
      rmSync(other, { force: true });
      await runtime.leases.acquire();
    }
  });
});
