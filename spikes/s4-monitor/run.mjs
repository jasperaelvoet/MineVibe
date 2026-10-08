#!/usr/bin/env node
// Spike S4 (PLAN §12.1): PC monitor rendering and PC input, for real.
//
// Starts the dev server in-process (random port, a private MINEVIBE_HOME), plays the PC manager's part on the
// bridge (pc.state for one PC `s4-monitor` on MVF1 slot 7, ok replies to pc.action, pc.frame.ack flow control with at
// most 2 unacked frames), and launches the game with `./gradlew runClient` plus the mod's PC demo
// (MINEVIBE_PC_DEMO=s4-monitor): the mod places a workstation in front of the player, looks at it, sits down,
// types through synthetic SDL3 events, and stands up with Shift+Esc (see PcDemo.java). Meanwhile this script streams
// generated 1280x800 test patterns at 30 fps whenever the mod asks for frames (pc.view != none):
//
//   baseline   no frames (render cost of the world with an idle monitor)
//   watch      the monitor in the world: first half JPEG (q80), second half BGRA8
//   seat       PcControlScreen (focus tier): first half BGRA8, second half JPEG
//   type       synthetic key + text events -> pc.input (checked against the expected events)
//   stand      synthetic Shift+Esc -> pc.unseat{reason: stand}
//   config     PcConfigScreen open (screenshot)
//   watchscreen  Watch mode open (screenshot; pc.action watch/unwatch)
//
// Screenshots (F2) are taken in baseline, twice in watch and seat, and in config and watchscreen.
//
// The mod logs `[pc-stats]` every 5 s (MINEVIBE_PC_STATS=1): render fps, uploads, upload ms, the render-thread
// cost of monitor work per frame (p50/p95/max), decode ms, received/decoded fps. Each line is attributed to the
// window (phase + codec) it covers.
//
// Usage (repo root, after `npm install`):
//   node spikes/s4-monitor/run.mjs            # Sodium + Entity Culling in the game's mods/ (the launcher's jars)
//   node spikes/s4-monitor/run.mjs --vanilla  # no performance mods
// Output: spikes/s4-monitor/out/<run>/ (summary.md, result.json, client.log, devserver.log, screenshots). The game
// is always killed before the script exits.

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..', '..');

if (!process.execArgv.includes('--conditions=source')) {
  const child = spawn(
    process.execPath,
    ['--conditions=source', '--import', 'tsx', fileURLToPath(import.meta.url), ...process.argv.slice(2)],
    { cwd: repo, stdio: 'inherit' },
  );
  child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
} else {
  await main();
}

async function main() {
  const { startDevServer } = await import('../../apps/server/src/orchestrator/devServer.ts');
  const { installMods, loadModsLock, cachePath } = await import('../../apps/server/src/launcher/mods.ts');
  const { encodeFrame, FrameCodec, FrameFlag, FrameKind } = await import('@minevibe/protocol');
  const sharp = (await import('sharp')).default;
  const { pino } = await import('pino');

  const vanilla = process.argv.includes('--vanilla');
  const PC_ID = 's4-monitor';
  const SLOT = 7;
  const W = 1280;
  const H = 800;
  const FPS = 30;
  const PATTERNS = 30;
  const PHASES = process.env.S4_PHASES ?? 'baseline:12,watch:50,seat:50,type:8,stand:6,config:6,watchscreen:6';

  const modDir = join(repo, 'apps', 'mod');
  const runTag = `s4-${vanilla ? 'vanilla' : 'sodium'}-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const outDir = join(here, 'out', runTag);
  const gameDirRel = join('build', 's4', runTag);
  const gameDir = join(modDir, gameDirRel);
  const home = join(outDir, 'home');
  mkdirSync(outDir, { recursive: true });
  mkdirSync(gameDir, { recursive: true });

  const t0 = Date.now();
  const say = (msg) => process.stdout.write(`[s4 ${((Date.now() - t0) / 1000).toFixed(1)}s] ${msg}\n`);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const logger = pino({ level: 'info' }, pino.destination({ dest: join(outDir, 'devserver.log'), sync: true }));

  writeFileSync(
    join(gameDir, 'options.txt'),
    [
      'onboardAccessibility:false',
      'pauseOnLostFocus:false',
      'tutorialStep:none',
      'skipMultiplayerWarning:true',
      'joinedFirstServer:true',
      'renderDistance:8',
      'simulationDistance:5',
      'soundCategory_master:0.0',
      'narrator:0',
      'enableVsync:false',
      'maxFps:260',
      '',
    ].join('\n'),
  );

  // --- performance mods: Sodium + Entity Culling from the launcher's lock (sha512-verified) ----------------------
  let modsInstalled = [];
  if (!vanilla) {
    const lock = await loadModsLock(join(repo, 'packaging', 'mods.lock.json'));
    const wanted = new Set(['sodium', 'entityculling']);
    const subset = { ...lock, mods: lock.mods.filter((m) => wanted.has(m.modId)) };
    const cacheDir = join(here, 'out', 'mod-cache');
    mkdirSync(cacheDir, { recursive: true });
    // Reuse jars another MineVibe home already verified (content-addressed by sha512), else Modrinth.
    const knownCaches = [
      join(homedir(), 'Library', 'Caches', 'MineVibe-dev', 'app-test', 'home', 'Caches', 'mods'),
      join(repo, '.minevibe-dev', 'play', 'Caches', 'mods'),
      join(homedir(), 'Library', 'Caches', 'MineVibe', 'mods'),
    ];
    for (const m of subset.mods) {
      const mine = cachePath(cacheDir, m.sha512);
      if (existsSync(mine)) continue;
      for (const dir of knownCaches) {
        const theirs = cachePath(dir, m.sha512);
        if (existsSync(theirs) && sha512(theirs) === m.sha512) {
          copyFileSync(theirs, mine);
          break;
        }
      }
    }
    const result = await installMods({ lock: subset, cacheDir, modsDir: join(gameDir, 'mods'), log: logger });
    modsInstalled = result.mods.map((m) => `${m.slug} ${m.versionNumber}`);
    say(`mods: ${modsInstalled.join(', ')} (downloaded ${result.downloaded})`);
  }

  // --- test patterns -----------------------------------------------------------------------------------------------
  say(`rendering ${PATTERNS} test patterns (${W}x${H}, BGRA8 + JPEG q80)`);
  const bgra = [];
  const jpeg = [];
  for (let i = 0; i < PATTERNS; i++) {
    const frame = pattern(i, W, H);
    bgra.push(frame);
    const rgba = Buffer.alloc(frame.length);
    for (let p = 0; p < frame.length; p += 4) {
      rgba[p] = frame[p + 2];
      rgba[p + 1] = frame[p + 1];
      rgba[p + 2] = frame[p];
      rgba[p + 3] = 255;
    }
    jpeg.push(await sharp(rgba, { raw: { width: W, height: H, channels: 4 } }).jpeg({ quality: 80 }).toBuffer());
  }
  const jpegAvg = Math.round(jpeg.reduce((a, b) => a + b.length, 0) / jpeg.length);
  say(`patterns ready: BGRA ${(bgra[0].length / 1048576).toFixed(1)} MiB, JPEG avg ${(jpegAvg / 1024).toFixed(0)} KiB`);

  // --- dev server + the PC manager's side of the bridge ------------------------------------------------------------
  const server = await startDevServer({ repoRoot: repo, logger, port: 0, env: { MINEVIBE_HOME: home }, savesDir: join(gameDir, 'saves'), e2e: true });
  const bridge = server.bridge;
  say(`dev server on 127.0.0.1:${server.port}`);

  const events = { views: [], inputs: [], seats: [], actions: [], acks: 0 };
  let tier = 'none';
  const unacked = new Map();
  let seq = 0;
  const sendStats = { sent: 0, skippedBridge: 0, waitedForAck: 0, bytes: 0 };

  const pcInfo = (extra = {}) => ({
    pcId: PC_ID,
    type: 'linux',
    name: 'S4 Monitor',
    status: 'running',
    progress: null,
    detail: null,
    slot: SLOT,
    cpus: 2,
    memoryMiB: 4096,
    diskGiB: 64,
    plugged: true,
    pinned: false,
    wipeOnDeath: false,
    mounts: [],
    occupant: null,
    reservation: null,
    banner: null,
    screen: { w: W, h: H },
    consent: null,
    ...extra,
  });
  const budget = {
    cpu: { total: 14, used: 3, free: 11, maxOvercommit: 1.5 },
    memoryMiB: { pool: 25088, used: 4352, free: 20736 },
    diskFreeGiB: 400,
    macos: { running: 0, max: 2 },
    crewCap: 4,
  };
  bridge.on('hello', () => {
    setTimeout(() => {
      bridge.send('budget.state', budget);
      bridge.send('pc.state', pcInfo());
    }, 200);
  });
  bridge.handle('pc.action', (m) => {
    events.actions.push({ at: Date.now(), action: m.action, pcId: m.pcId ?? null });
    return { pcId: m.pcId ?? PC_ID };
  });
  bridge.on('pc.view', (m) => {
    events.views.push({ at: Date.now(), pcId: m.pcId, tier: m.tier });
    if (m.pcId === PC_ID) tier = m.tier;
  });
  bridge.on('pc.input', (m) => events.inputs.push({ at: Date.now(), seq: m.seq, events: m.events }));
  bridge.on('pc.seat', (m) => {
    events.seats.push({ ...m, at: Date.now(), t: 'seat' });
    bridge.send('pc.state', pcInfo({ occupant: m.occupant }));
  });
  bridge.on('pc.unseat', (m) => {
    events.seats.push({ ...m, at: Date.now(), t: 'unseat' });
    bridge.send('pc.state', pcInfo());
  });
  bridge.on('pc.frame.ack', (m) => {
    events.acks++;
    for (const k of [...unacked.keys()]) if ((m.seq - k) >>> 0 < 0x80000000) unacked.delete(k);
  });

  // --- phases and codec windows ------------------------------------------------------------------------------------
  const phaseSeconds = Object.fromEntries(PHASES.split(',').map((p) => p.split(':')).map(([n, s]) => [n, Number(s)]));
  let phase = 'boot';
  let phaseStart = Date.now();
  const windows = [];
  let codec = null;
  function codecFor(now) {
    const half = (now - phaseStart) / 1000 < (phaseSeconds[phase] ?? 0) / 2;
    if (phase === 'watch') return half ? 'jpeg' : 'bgra';
    if (phase === 'seat') return half ? 'bgra' : 'jpeg';
    return null;
  }
  function markWindow(now) {
    const c = codecFor(now);
    const name = c ? `${phase}-${c}` : phase;
    const last = windows.at(-1);
    if (!last || last.name !== name) {
      if (last) last.end = now;
      windows.push({ name, phase, codec: c, start: now, end: null, stats: [], sent: 0 });
    }
    codec = c;
  }

  const streamer = setInterval(() => {
    const now = Date.now();
    markWindow(now);
    if (!codec || tier === 'none' || !bridge.isConnected) return;
    for (const [k, at] of unacked) if (now - at > 1000) unacked.delete(k);
    if (unacked.size >= 2) {
      sendStats.waitedForAck++;
      return;
    }
    const i = seq % PATTERNS;
    const payload = codec === 'jpeg' ? jpeg[i] : bgra[i];
    const s = (seq = (seq + 1) >>> 0);
    const frame = encodeFrame(
      { kind: FrameKind.PC_FRAME, codec: codec === 'jpeg' ? FrameCodec.JPEG : FrameCodec.BGRA8, flags: FrameFlag.FULL, pcSlot: SLOT, seq: s, w: W, h: H },
      payload,
    );
    if (bridge.sendFrame(frame)) {
      unacked.set(s, now);
      sendStats.sent++;
      sendStats.bytes += frame.length;
      windows.at(-1).sent++;
    } else {
      sendStats.skippedBridge++;
    }
  }, 1000 / FPS);

  // --- the game ------------------------------------------------------------------------------------------------------
  const lifeline = spawn('sleep', ['900'], { stdio: 'ignore' });
  const killGame = () => {
    spawnSync('pkill', ['-9', '-f', `minevibe.runTag=${runTag}`]);
  };
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      say(`${sig}: killing the game`);
      lifeline.kill('SIGKILL');
      killGame();
      process.exit(130);
    });
  }
  const clientLog = createWriteStream(join(outDir, 'client.log'));
  const lines = { stats: [], demo: [], input: [], errors: [] };
  let done = false;
  let exited = null;
  const proc = spawn('./gradlew', ['runClient', '--console=plain'], {
    cwd: modDir,
    env: {
      ...process.env,
      MINEVIBE_BRIDGE_FILE: server.paths.bridgeFile,
      MINEVIBE_E2E: 'true',
      MINEVIBE_DEV: 'true',
      MINEVIBE_PARENT_PID: String(lifeline.pid),
      MINEVIBE_RUN_TAG: runTag,
      MINEVIBE_RUN_DIR: gameDirRel,
      MINEVIBE_PC_DEMO: PC_ID,
      MINEVIBE_PC_DEMO_PHASES: PHASES,
      MINEVIBE_PC_STATS: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  let buffered = '';
  const onData = (chunk) => {
    clientLog.write(chunk);
    buffered += chunk.toString('utf8');
    let nl = buffered.indexOf('\n');
    while (nl !== -1) {
      const line = buffered.slice(0, nl);
      buffered = buffered.slice(nl + 1);
      onLine(line);
      nl = buffered.indexOf('\n');
    }
  };
  function onLine(line) {
    const now = Date.now();
    const demo = /\[pc-demo\] (.*)$/.exec(line);
    if (demo) {
      lines.demo.push({ at: now, text: demo[1] });
      const p = /^phase=(\S+)/.exec(demo[1]);
      if (p) {
        phase = p[1];
        phaseStart = now;
        markWindow(now);
        say(`phase ${phase}`);
      }
      if (demo[1] === 'done') {
        phase = 'done';
        markWindow(now);
        done = true;
      }
      if (/placed|seat at|pushing|screenshot/.test(demo[1])) say(demo[1]);
    }
    const st = /\[pc-stats\] (.*)$/.exec(line);
    if (st) {
      const kv = Object.fromEntries(st[1].split(' ').map((s) => s.split('=')).map(([k, v]) => [k, Number(v)]));
      const entry = { at: now, ...kv };
      lines.stats.push(entry);
      // A line covers the 5 s before it: attribute it to the window that contains all of it.
      const w = windows.find((win) => win.start <= now - 5200 && (win.end === null || win.end >= now));
      if (w) w.stats.push(entry);
    }
    const inp = /\[pc-input\] (.*)$/.exec(line);
    if (inp) lines.input.push(inp[1]);
    if (/Exception|ERROR|FATAL/.test(line) && !/\[pc-stats\]/.test(line)) lines.errors.push(line.trim());
  }
  proc.stdout.on('data', onData);
  proc.stderr.on('data', onData);
  proc.on('exit', (code, signal) => {
    exited = { code, signal };
  });
  say(`launched the game (gradle pid ${proc.pid}), log ${relative(repo, join(outDir, 'client.log'))}`);

  const totalSeconds = Object.values(phaseSeconds).reduce((a, b) => a + b, 0);
  const deadline = Date.now() + (240 + totalSeconds) * 1000;
  while (!done && !exited && Date.now() < deadline) await sleep(250);
  await sleep(1500);
  clearInterval(streamer);
  const finished = done;
  say(finished ? 'demo finished' : `demo did not finish (exited=${JSON.stringify(exited)})`);

  // --- shut down -----------------------------------------------------------------------------------------------------
  lifeline.kill('SIGKILL');
  killGame();
  try {
    process.kill(-proc.pid, 'SIGKILL');
  } catch {
    // already gone
  }
  await sleep(1500);
  const leftover = spawnSync('pgrep', ['-f', `minevibe.runTag=${runTag}`]).stdout.toString().trim();
  await server.stop('s4 done');

  // --- screenshots ----------------------------------------------------------------------------------------------------
  const shots = [];
  const shotDir = join(gameDir, 'screenshots');
  if (existsSync(shotDir)) {
    for (const f of readdirSync(shotDir).sort()) {
      copyFileSync(join(shotDir, f), join(outDir, f));
      shots.push(f);
    }
  }

  // --- results --------------------------------------------------------------------------------------------------------
  const median = (xs) => {
    const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
    return s.length ? s[Math.floor((s.length - 1) / 2)] : null;
  };
  const max = (xs) => (xs.length ? Math.max(...xs.filter((x) => Number.isFinite(x))) : null);
  const summary = windows
    .filter((w) => w.end !== null || w.name === 'done')
    .map((w) => ({
      window: w.name,
      seconds: w.end ? Math.round((w.end - w.start) / 1000) : 0,
      nodeFps: w.end ? +(w.sent / ((w.end - w.start) / 1000)).toFixed(1) : 0,
      samples: w.stats.length,
      fps: median(w.stats.map((s) => s.fps)),
      recvFps: median(w.stats.map((s) => s.recvFps)),
      decodedFps: median(w.stats.map((s) => s.decodedFps)),
      uploadAvgMs: median(w.stats.map((s) => s.uploadAvgMs)),
      uploadMaxMs: max(w.stats.map((s) => s.uploadMaxMs)),
      costP50Ms: median(w.stats.map((s) => s.costP50Ms)),
      costP95Ms: median(w.stats.map((s) => s.costP95Ms)),
      costMaxMs: max(w.stats.map((s) => s.costMaxMs)),
      decodeAvgMs: median(w.stats.map((s) => s.decodeAvgMs)),
    }));

  const typed = events.inputs.flatMap((b) => b.events);
  const describe = (e) =>
    e.k === 'key' ? `${e.down ? '+' : '-'}${e.key}` : e.k === 'text' ? `'${e.text}'` : e.k === 'release_all' ? 'release_all' : e.k;
  // Text split over two batches is still one piece of typing: join consecutive text events.
  const typedKeys = [];
  for (const e of typed.filter((x) => x.k !== 'move')) {
    const last = typedKeys.at(-1);
    if (e.k === 'text' && last?.startsWith("'")) typedKeys[typedKeys.length - 1] = `${last.slice(0, -1)}${e.text}'`;
    else typedKeys.push(describe(e));
  }
  const expected = ["'aHé AZERTY ü'", '+KEY_TAB', '-KEY_TAB', '+KEY_CONTROL', '+KEY_C', '-KEY_C', '-KEY_CONTROL', '+KEY_ENTER', '-KEY_ENTER', '+KEY_ARROW_UP', '-KEY_ARROW_UP'];
  const typedOk = expected.every((e, i) => typedKeys.includes(e)) && indexOrder(typedKeys, expected);
  const seatOk = events.seats.some((s) => s.t === 'seat' && s.occupant?.kind === 'player');
  const standOk = events.seats.some((s) => s.t === 'unseat' && s.reason === 'stand');
  const tiers = events.views.filter((v) => v.pcId === PC_ID).map((v) => v.tier);
  const checks = [
    ['demo finished', finished],
    ['pc.view visible while watching', tiers.includes('visible')],
    ['pc.view focus while seated', tiers.includes('focus')],
    ['pc.seat{player}', seatOk],
    ['typed input reached pc.input in order', typedOk],
    ['Shift+Esc stood up (pc.unseat{stand})', standOk],
    ['release_all sent on leaving the PC', typedKeys.includes('release_all')],
    [
      'Watch mode sent pc.action watch then unwatch',
      !('watchscreen' in phaseSeconds) ||
        (events.actions.some((a) => a.action === 'watch') && events.actions.some((a) => a.action === 'unwatch')),
    ],
    ['frames acknowledged', events.acks > 0],
    ['no game process left', leftover === ''],
  ];
  const result = {
    runTag,
    mods: modsInstalled,
    vanilla,
    phases: PHASES,
    jpegAvgBytes: jpegAvg,
    nodeSend: sendStats,
    bridgeStats: bridge.stats,
    acks: events.acks,
    windows: summary,
    tiers,
    seats: events.seats,
    actions: events.actions,
    typedKeys,
    inputLog: lines.input.slice(0, 80),
    statsLines: lines.stats,
    screenshots: shots,
    errors: lines.errors.slice(0, 40),
    checks: Object.fromEntries(checks),
  };
  writeFileSync(join(outDir, 'result.json'), `${JSON.stringify(result, null, 2)}\n`);
  const md = [
    `# S4 run ${runTag}`,
    '',
    `Mods: ${vanilla ? 'none (vanilla)' : modsInstalled.join(', ')}. JPEG avg ${(jpegAvg / 1024).toFixed(0)} KiB, BGRA ${(W * H * 4 / 1048576).toFixed(1)} MiB.`,
    '',
    '| Window | s | Node fps | samples | game fps | recv fps | decoded fps | upload avg ms | upload max ms | cost p50 ms | cost p95 ms | cost max ms | decode avg ms |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|',
    ...summary.map(
      (w) =>
        `| ${w.window} | ${w.seconds} | ${w.nodeFps} | ${w.samples} | ${w.fps ?? '-'} | ${w.recvFps ?? '-'} | ${w.decodedFps ?? '-'} | ${w.uploadAvgMs ?? '-'} | ${w.uploadMaxMs ?? '-'} | ${w.costP50Ms ?? '-'} | ${w.costP95Ms ?? '-'} | ${w.costMaxMs ?? '-'} | ${w.decodeAvgMs ?? '-'} |`,
    ),
    '',
    ...checks.map(([name, ok]) => `- ${ok ? 'PASS' : 'FAIL'} ${name}`),
    '',
    `Typed: ${typedKeys.join(' ')}`,
    `Tiers: ${tiers.join(' > ')}`,
    `Screenshots: ${shots.join(', ')}`,
  ].join('\n');
  writeFileSync(join(outDir, 'summary.md'), `${md}\n`);
  process.stdout.write(`\n${md}\n\nOutput: ${relative(repo, outDir)}\n`);
  process.exit(checks.every(([, ok]) => ok) ? 0 : 1);
}

function indexOrder(list, wanted) {
  let i = 0;
  for (const w of wanted) {
    const j = list.indexOf(w, i);
    if (j < 0) return false;
    i = j + 1;
  }
  return true;
}

function sha512(file) {
  return createHash('sha512').update(readFileSync(file)).digest('hex');
}

/** One 1280x800 BGRA8 test pattern: moving colour bars, a grid, and a frame counter block that changes every frame. */
function pattern(i, w, h) {
  const buf = Buffer.alloc(w * h * 4);
  const px = new Uint32Array(buf.buffer, buf.byteOffset, w * h);
  const bars = [0xff4ade80, 0xfffbbf24, 0xfff87171, 0xff60a5fa, 0xffc084fc, 0xfff472b6, 0xff2dd4bf, 0xffe5e7eb];
  const shift = (i * 16) % w;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let c;
      if (y < h / 2) {
        const bar = Math.floor(((x + shift) % w) / (w / bars.length));
        c = bars[bar];
      } else {
        const shade = Math.floor((x / w) * 255);
        c = 0xff000000 | (shade << 16) | ((255 - shade) << 8) | ((y * 255) / h);
      }
      if (x % 80 === 0 || y % 80 === 0) c = 0xff111111;
      px[row + x] = c >>> 0;
    }
  }
  // A counter block: 30 cells, the i-th one lit.
  for (let cell = 0; cell < 30; cell++) {
    const on = cell === i % 30;
    for (let y = 700; y < 760; y++) for (let x = 40 + cell * 40; x < 70 + cell * 40; x++) px[y * w + x] = on ? 0xffffffff : 0xff333333;
  }
  return buf;
}
