#!/usr/bin/env node
// Spike S7 (PLAN §12.1): boot and hardcore reset, for real.
//
// Starts the dev server in-process (E2E mode, random port, a private MINEVIBE_HOME), launches the game with
// `./gradlew runClient` (bridge file, E2E and dev settings passed as MINEVIBE_* environment variables, which the
// Loom run config turns into -D system properties; see apps/mod/README.md), and drives it over the bridge with the
// debug.* requests:
//
//   1. boot: the screen log never shows TitleScreen; a fresh hardcore HARD survival world is created
//   2. the Esc menu is open and the integrated server keeps ticking (nothing pauses)
//   3. debug.kill_player -> GameOverScreen in < 3 s
//   4. debug.click_begin -> standing in a new world (new worldId) in < 20 s; the dead save is in saves/_graveyard
//   5. kill the game (SIGKILL) on Game Over, relaunch -> straight to GameOverScreen, then into the new world
//   6. dead-marker recovery: the death never reached Node (state rewound), relaunch -> the world's dead marker
//      leads to Game Over, player.died is re-sent, then the next world
//   7. lifeline: the game's parent process exits -> the game saves and quits by itself
//
// Usage (from the repo root, after `npm install`):  node spikes/s7-boot/run.mjs
// Output: spikes/s7-boot/out/<run>/ (summary.md, result.json, client-*.log, devserver.log). Every game started is
// killed before the script exits.

import { spawn, spawnSync } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..', '..');

// Re-exec with the tsx loader and the `source` export condition, so the dev server runs from TypeScript sources.
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
  const { pino } = await import('pino');

  const modDir = join(repo, 'apps', 'mod');
  const runTag = `s7-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const outDir = join(here, 'out', runTag);
  const gameDirRel = join('build', 's7', runTag); // relative to apps/mod (Loom runDir)
  const gameDir = join(modDir, gameDirRel);
  const savesDir = join(gameDir, 'saves');
  const home = join(outDir, 'home');
  mkdirSync(outDir, { recursive: true });
  mkdirSync(gameDir, { recursive: true });

  // What the launcher seeds in M1 (PLAN §7.9): no onboarding screen, no pause on focus loss. Quiet and light.
  writeFileSync(
    join(gameDir, 'options.txt'),
    [
      'onboardAccessibility:false',
      'pauseOnLostFocus:false',
      'tutorialStep:none',
      'skipMultiplayerWarning:true',
      'joinedFirstServer:true',
      'renderDistance:6',
      'simulationDistance:5',
      'soundCategory_master:0.0',
      'narrator:0',
      '',
    ].join('\n'),
  );

  const t0 = Date.now();
  const elapsed = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
  const say = (msg) => process.stdout.write(`[s7 ${elapsed()}] ${msg}\n`);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const checks = [];
  const timings = {};
  function check(name, ok, detail = '') {
    checks.push({ name, ok: Boolean(ok), detail });
    say(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
  }

  const logger = pino({ level: 'info' }, pino.destination({ dest: join(outDir, 'devserver.log'), sync: true }));
  const nodeEvents = [];
  let server = null;

  async function startServer() {
    server = await startDevServer({
      repoRoot: repo,
      logger,
      port: 0,
      env: { MINEVIBE_HOME: home },
      savesDir,
      e2e: true,
    });
    server.bridge.on('connected', () => nodeEvents.push({ at: Date.now(), t: 'connected' }));
    server.bridge.on('disconnected', (d) => nodeEvents.push({ at: Date.now(), t: 'disconnected', code: d.code }));
    server.bridge.on('message', (m) => {
      if (m.t === 'world.state' && m.phase === 'ready' && m.clockTime !== undefined && m.fresh === undefined) return;
      nodeEvents.push({ at: Date.now(), ...m });
    });
    say(`dev server on 127.0.0.1:${server.port} (home ${relative(repo, home)})`);
  }

  // A stand-in parent process for -Dminevibe.parentPid: when it exits, the game must save and quit (step 7). It
  // also bounds the game's life if this script dies without cleaning up.
  const lifeline = spawn('sleep', ['900'], { stdio: 'ignore' });
  say(`lifeline process ${lifeline.pid}`);
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      say(`${sig}: killing every game this run started`);
      lifeline.kill('SIGKILL');
      spawnSync('pkill', ['-9', '-f', `minevibe.runTag=${runTag}`]);
      process.exit(130);
    });
  }

  const launches = [];
  function launchClient(label) {
    const logPath = join(outDir, `client-${label}.log`);
    const log = createWriteStream(logPath);
    const launch = {
      label,
      startedAt: Date.now(),
      screens: [],
      exited: null,
      logPath,
      proc: null,
      readyLines: [],
    };
    const proc = spawn('./gradlew', ['runClient', '--console=plain'], {
      cwd: modDir,
      env: {
        ...process.env,
        MINEVIBE_BRIDGE_FILE: server.paths.bridgeFile,
        MINEVIBE_E2E: 'true',
        MINEVIBE_DEV: 'false',
        MINEVIBE_PARENT_PID: String(lifeline.pid),
        MINEVIBE_RUN_TAG: runTag,
        MINEVIBE_RUN_DIR: gameDirRel,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    launch.proc = proc;
    let buffered = '';
    const onData = (chunk) => {
      log.write(chunk);
      buffered += chunk.toString('utf8');
      let nl = buffered.indexOf('\n');
      while (nl !== -1) {
        const line = buffered.slice(0, nl);
        buffered = buffered.slice(nl + 1);
        const m = /\[screen\] (\S+)(?: \(requested (\S+)\))?/.exec(line);
        if (m) launch.screens.push({ at: Date.now(), shown: m[1], requested: m[2] ?? m[1] });
        if (/World \S+ ready/.test(line) || /Parent process .* exited/.test(line)) launch.readyLines.push(line.trim());
        nl = buffered.indexOf('\n');
      }
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.on('exit', (code, signal) => {
      launch.exited = { at: Date.now(), code, signal };
      log.end();
    });
    launches.push(launch);
    say(`launched client "${label}" (gradle pid ${proc.pid}), log ${relative(repo, logPath)}`);
    return launch;
  }

  async function state(timeoutMs = 2000) {
    return server.debug.state(timeoutMs);
  }

  /** Polls debug.state until `pred` holds; returns the state. */
  async function waitState(what, pred, timeoutMs, launch) {
    const deadline = Date.now() + timeoutMs;
    let last = null;
    let lastErr = null;
    while (Date.now() < deadline) {
      if (launch?.exited) throw new Error(`client exited while waiting for ${what}: ${JSON.stringify(launch.exited)}`);
      try {
        last = await state();
        if (pred(last)) return last;
      } catch (err) {
        lastErr = err;
      }
      await sleep(100);
    }
    throw new Error(
      `timed out after ${timeoutMs} ms waiting for ${what}; last state ${JSON.stringify(last)}${lastErr ? `; last error ${lastErr.message}` : ''}`,
    );
  }

  /** Retries debug.click_begin while it answers NOT_READY. */
  async function clickBegin(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        await server.debug.clickBegin();
        return;
      } catch (err) {
        if (err.code !== 'NOT_READY' || Date.now() > deadline) throw err;
        await sleep(100);
      }
    }
  }

  function isAlive(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  async function waitExit(launch, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (!launch.exited && Date.now() < deadline) await sleep(100);
    return launch.exited;
  }

  async function killGame(pid, signal = 'SIGKILL') {
    if (pid && isAlive(pid)) process.kill(pid, signal);
    const deadline = Date.now() + 15_000;
    while (pid && isAlive(pid) && Date.now() < deadline) await sleep(100);
  }

  const inWorld = (s) => s.inWorld && s.screen === null;
  const result = { runTag, startedAt: new Date(t0).toISOString(), checks, timings, launches: [] };
  let exitCode = 1;
  let gamePid = null;

  try {
    await startServer();

    // ---- 1. First boot ------------------------------------------------------------------------------
    const first = launchClient('1-boot');
    const booted = await waitState('the first world', inWorld, 240_000, first);
    gamePid = booted.pid;
    timings.launchToWorldMs = Date.now() - first.startedAt;
    say(`in world ${booted.worldId} after ${timings.launchToWorldMs} ms (game pid ${gamePid})`);
    check('fresh world is World #1', booted.worldId === 'world-1', booted.worldId);
    check(
      'hardcore HARD survival',
      booted.hardcore === true && booted.difficulty === 'hard' && booted.gameMode === 'survival',
      `hardcore=${booted.hardcore} difficulty=${booted.difficulty} mode=${booted.gameMode}`,
    );
    check('commands off without -Dminevibe.dev=true', booted.allowCommands === false, `allowCommands=${booted.allowCommands}`);
    const freshReady = nodeEvents.find((e) => e.t === 'world.state' && e.phase === 'ready' && e.worldId === 'world-1');
    check('mod reported world-1 ready and fresh', freshReady?.fresh === true);
    check('BootScreen replaced TitleScreen', first.screens.some((s) => s.requested === 'TitleScreen' && s.shown === 'BootScreen'));

    // ---- 2. Menu does not pause ----------------------------------------------------------------------
    const menu = await server.debug.openMenu();
    check('Esc opens MineVibeMenuScreen', menu.screen === 'MineVibeMenuScreen', menu.screen);
    const m0 = await state();
    await sleep(3000);
    const m1 = await state();
    const ticked = m1.serverTicks - m0.serverTicks;
    timings.menuTicksIn3s = ticked;
    check(
      'server keeps ticking with the menu open',
      m1.screen === 'MineVibeMenuScreen' && !m1.paused && !m1.serverPaused && ticked >= 40,
      `${ticked} ticks in 3 s, paused=${m1.paused}, serverPaused=${m1.serverPaused}`,
    );

    // ---- 3. Death -> Game Over -----------------------------------------------------------------------
    let tKill = Date.now();
    await server.debug.killPlayer();
    const over = await waitState('GameOverScreen', (s) => s.screen === 'GameOverScreen', 10_000, first);
    timings.deathToGameOverMs = Date.now() - tKill;
    check('death -> GameOverScreen in < 3 s', timings.deathToGameOverMs < 3000, `${timings.deathToGameOverMs} ms`);
    // The death screen packet can reach the client a tick before the health update.
    const deadState = await waitState('the player dead', (s) => s.dead === true, 2000, first).catch(() => over);
    check('player is dead in world-1', deadState.dead === true && deadState.worldId === 'world-1', `hp=${deadState.hp}`);
    await waitState('Node marked world-1 dead', () => server.store.current.status === 'dead', 5000);
    check('Node durably marked world-1 dead, next = world-2', server.store.current.next?.worldId === 'world-2');

    // ---- 4. Begin -> new world -----------------------------------------------------------------------
    const tBegin = Date.now();
    await clickBegin(15_000);
    timings.beginEnabledAfterDeathMs = Date.now() - tKill;
    const second = await waitState('World #2', (s) => inWorld(s) && s.worldId === 'world-2', 60_000, first);
    timings.beginToNewWorldMs = Date.now() - tBegin;
    check('Begin -> standing in World #2 in < 20 s', timings.beginToNewWorldMs < 20_000, `${timings.beginToNewWorldMs} ms`);
    check('new world is hardcore HARD survival', second.hardcore && second.difficulty === 'hard' && second.gameMode === 'survival');
    check('world-1 save moved to saves/_graveyard', existsSync(join(savesDir, '_graveyard', 'world-1', 'level.dat')) && !existsSync(join(savesDir, 'world-1')));

    // ---- 5. Kill the game on Game Over, relaunch -------------------------------------------------------
    tKill = Date.now();
    await server.debug.killPlayer();
    await waitState('GameOverScreen in world-2', (s) => s.screen === 'GameOverScreen' && s.worldId === 'world-2', 10_000, first);
    timings.deathToGameOver2Ms = Date.now() - tKill;
    await waitState('Node marked world-2 dead', () => server.store.current.status === 'dead' && server.store.current.worldId === 'world-2', 5000);
    say(`killing the game (pid ${gamePid}) on Game Over`);
    await killGame(gamePid, 'SIGKILL');
    await waitExit(first, 30_000);
    check('game killed on Game Over', !isAlive(gamePid));

    const relaunch = launchClient('2-relaunch');
    const back = await waitState(
      'GameOverScreen after relaunch',
      (s) => s.screen === 'GameOverScreen' || inWorld(s),
      240_000,
      relaunch,
    );
    gamePid = back.pid;
    timings.relaunchToGameOverMs = Date.now() - relaunch.startedAt;
    check('relaunch boots straight to GameOverScreen', back.screen === 'GameOverScreen' && !back.inWorld, `${back.screen}, inWorld=${back.inWorld}`);
    // The game's log reaches us through Gradle and can lag the bridge: wait for the line before reading the order.
    const logDeadline = Date.now() + 10_000;
    while (!relaunch.screens.some((s) => s.shown === 'GameOverScreen') && Date.now() < logDeadline) await sleep(100);
    const relaunchScreens = relaunch.screens.map((s) => s.shown);
    const firstMineVibe = relaunchScreens.find((n) => n === 'GameOverScreen' || n === 'none' || n === 'LevelLoadingScreen');
    check('Game Over came before any world loaded', firstMineVibe === 'GameOverScreen', relaunchScreens.join(' > '));
    const tBegin2 = Date.now();
    await clickBegin(15_000);
    const third = await waitState('World #3', (s) => inWorld(s) && s.worldId === 'world-3', 60_000, relaunch);
    timings.relaunchBeginToNewWorldMs = Date.now() - tBegin2;
    check('then into World #3 in < 20 s', timings.relaunchBeginToNewWorldMs < 20_000, `${timings.relaunchBeginToNewWorldMs} ms`);
    check('World #3 is hardcore', third.hardcore === true);
    check('world-2 save moved to saves/_graveyard', existsSync(join(savesDir, '_graveyard', 'world-2', 'level.dat')));

    // ---- 6. Dead-marker recovery: Node never heard of the death ---------------------------------------
    await server.debug.killPlayer();
    await waitState('GameOverScreen in world-3', (s) => s.screen === 'GameOverScreen' && s.worldId === 'world-3', 10_000, relaunch);
    await waitState('Node marked world-3 dead', () => server.store.current.status === 'dead' && server.store.current.worldId === 'world-3', 5000);
    await killGame(gamePid, 'SIGKILL');
    await waitExit(relaunch, 30_000);
    await server.stop('restart');
    const recordPath = join(home, 'state', 'current-world.json');
    // Rewind Node's record to "world-3 alive" to simulate a death that never reached Node.
    writeFileSync(
      recordPath,
      `${JSON.stringify({ v: 1, worldId: 'world-3', gen: 3, status: 'alive', created: true }, null, 2)}\n`,
      { mode: 0o600 },
    );
    await startServer();
    const markerRun = launchClient('3-marker');
    const fromMarker = await waitState(
      'GameOverScreen from the dead marker',
      (s) => s.screen === 'GameOverScreen' || inWorld(s),
      240_000,
      markerRun,
    );
    gamePid = fromMarker.pid;
    check('world.open of a dead world -> GameOverScreen (dead marker)', fromMarker.screen === 'GameOverScreen' && !fromMarker.inWorld, fromMarker.screen);
    await waitState('Node marked world-3 dead again', () => server.store.current.status === 'dead', 15_000);
    check('player.died re-sent from the marker; Node allocated world-4', server.store.current.next?.worldId === 'world-4');
    const tBegin3 = Date.now();
    await clickBegin(15_000);
    await waitState('World #4', (s) => inWorld(s) && s.worldId === 'world-4', 60_000, markerRun);
    timings.markerBeginToNewWorldMs = Date.now() - tBegin3;
    check('then into World #4 in < 20 s', timings.markerBeginToNewWorldMs < 20_000, `${timings.markerBeginToNewWorldMs} ms`);

    // ---- 7. Lifeline: parent exits -> the game saves and quits ----------------------------------------
    const stoppingBefore = nodeEvents.filter((e) => e.t === 'client.stopping').length;
    const tParent = Date.now();
    lifeline.kill('SIGTERM');
    const exit = await waitExit(markerRun, 90_000);
    const gameGone = !isAlive(gamePid);
    timings.parentExitToGameExitMs = exit ? exit.at - tParent : null;
    check('parent exit -> game quits by itself', Boolean(exit) && gameGone, exit ? `${timings.parentExitToGameExitMs} ms` : 'still running');
    check('game said client.stopping', nodeEvents.filter((e) => e.t === 'client.stopping').length > stoppingBefore);
    check('world-4 was saved on the way out', existsSync(join(savesDir, 'world-4', 'level.dat')));

    for (const launch of launches) {
      check(`no TitleScreen in launch ${launch.label}`, !launch.screens.some((s) => s.shown === 'TitleScreen'));
    }
    exitCode = checks.every((c) => c.ok) ? 0 : 1;
  } catch (err) {
    say(`ERROR ${err.stack ?? err}`);
    checks.push({ name: 'run completed', ok: false, detail: String(err.message ?? err) });
  } finally {
    // Kill everything this script started.
    if (!lifeline.killed) lifeline.kill('SIGKILL');
    for (const launch of launches) {
      if (!launch.exited && launch.proc?.pid) {
        try {
          process.kill(-launch.proc.pid, 'SIGTERM');
        } catch {}
      }
    }
    if (gamePid && isAlive(gamePid)) await killGame(gamePid, 'SIGKILL');
    spawnSync('pkill', ['-9', '-f', `minevibe.runTag=${runTag}`]);
    const stragglers = spawnSync('pgrep', ['-f', `minevibe.runTag=${runTag}`], { encoding: 'utf8' }).stdout.trim();
    check('no game process left behind', stragglers === '', stragglers);
    if (server) await server.stop('quit').catch(() => {});

    result.finishedAt = new Date().toISOString();
    result.launches = launches.map((l) => ({
      label: l.label,
      screens: l.screens.map((s) => `${s.shown}${s.requested !== s.shown ? ` (requested ${s.requested})` : ''}`),
      exited: l.exited,
      readyLines: l.readyLines,
    }));
    result.nodeEvents = nodeEvents.map((e) => ({ ...e, at: e.at - t0 }));
    writeFileSync(join(outDir, 'result.json'), `${JSON.stringify(result, null, 2)}\n`);
    const lines = [
      `# S7 run ${runTag}`,
      '',
      '| Check | Result | Detail |',
      '|---|---|---|',
      ...checks.map((c) => `| ${c.name} | ${c.ok ? 'PASS' : 'FAIL'} | ${c.detail.replace(/\|/g, '\\|')} |`),
      '',
      '| Timing | ms |',
      '|---|---|',
      ...Object.entries(timings).map(([k, v]) => `| ${k} | ${v} |`),
      '',
      ...result.launches.flatMap((l) => [`Launch ${l.label} screens: ${l.screens.join(' > ')}`, '']),
    ];
    writeFileSync(join(outDir, 'summary.md'), `${lines.join('\n')}\n`);
    say(`summary: ${relative(repo, join(outDir, 'summary.md'))}`);
    process.stdout.write(`${lines.join('\n')}\n`);
    process.exit(checks.every((c) => c.ok) ? exitCode : 1);
  }
}
