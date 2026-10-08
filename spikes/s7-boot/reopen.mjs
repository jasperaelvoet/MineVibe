#!/usr/bin/env node
// S7-style check for DEBT M1 N1: reopening an existing, live world (the S7 run only ever creates worlds).
//
// Starts the dev server in-process (E2E mode, random port, a private MINEVIBE_HOME), launches the game with
// `./gradlew runClient`, and:
//   1. boots into a fresh World #1;
//   2. quits the game the normal way (its parent process exits: it saves and quits);
//   3. relaunches it: Node asks for the existing world-1, which `WorldOpenFlows#openWorld` opens asynchronously
//      (no level and no integrated server for a while). Meanwhile this script floods the mod with duplicate
//      `world.open{world-1}` (what a reconnect's hello would bring);
//   4. checks that world-1 was opened exactly once (never created again, never switched), that duplicates that
//      arrived mid-load were ignored as "already loading", and that the game stays in world-1 afterwards.
//
// Usage (from the repo root, after `npm install`):  node spikes/s7-boot/reopen.mjs
// Output: spikes/s7-boot/out/<run>/ (summary.md, result.json, client-*.log, devserver.log). Every game started is
// killed before the script exits.

import { spawn, spawnSync } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, writeFileSync } from 'node:fs';
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
  const { pino } = await import('pino');

  const modDir = join(repo, 'apps', 'mod');
  const runTag = `s7reopen-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const outDir = join(here, 'out', runTag);
  const gameDirRel = join('build', 's7', runTag);
  const gameDir = join(modDir, gameDirRel);
  const savesDir = join(gameDir, 'saves');
  const home = join(outDir, 'home');
  mkdirSync(outDir, { recursive: true });
  mkdirSync(gameDir, { recursive: true });
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
  const say = (msg) => process.stdout.write(`[s7-reopen ${((Date.now() - t0) / 1000).toFixed(1)}s] ${msg}\n`);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const checks = [];
  function check(name, ok, detail = '') {
    checks.push({ name, ok: Boolean(ok), detail });
    say(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
  }

  const logger = pino(
    { level: 'info' },
    pino.destination({ dest: join(outDir, 'devserver.log'), sync: true }),
  );
  const nodeEvents = [];
  const server = await startDevServer({
    repoRoot: repo,
    logger,
    port: 0,
    env: { MINEVIBE_HOME: home },
    savesDir,
    e2e: true,
  });
  server.bridge.on('message', (m) => {
    if (m.t === 'world.state' && m.phase === 'ready' && m.clockTime !== undefined && m.fresh === undefined)
      return;
    nodeEvents.push({ at: Date.now(), ...m });
  });
  say(`dev server on 127.0.0.1:${server.port}`);

  const launches = [];
  let lifeline = null;
  function launchClient(label) {
    lifeline = spawn('sleep', ['900'], { stdio: 'ignore' });
    const logPath = join(outDir, `client-${label}.log`);
    const log = createWriteStream(logPath);
    const launch = { label, startedAt: Date.now(), lines: [], exited: null, proc: null, lifeline };
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
        launch.lines.push({ at: Date.now(), line: buffered.slice(0, nl) });
        buffered = buffered.slice(nl + 1);
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
    say(`launched client "${label}", log ${relative(repo, logPath)}`);
    return launch;
  }

  async function waitState(what, pred, timeoutMs, launch) {
    const deadline = Date.now() + timeoutMs;
    let last = null;
    while (Date.now() < deadline) {
      if (launch?.exited) throw new Error(`client exited while waiting for ${what}`);
      try {
        last = await server.debug.state(2000);
        if (pred(last)) return last;
      } catch {}
      await sleep(100);
    }
    throw new Error(`timed out waiting for ${what}; last state ${JSON.stringify(last)}`);
  }

  const inWorld = (s) => s.inWorld && s.screen === null;
  const count = (launch, re) => launch.lines.filter((l) => re.test(l.line)).length;
  let exitCode = 1;
  try {
    // ---- 1. Fresh World #1 ---------------------------------------------------------------------------
    const first = launchClient('1-create');
    const created = await waitState('World #1', inWorld, 240_000, first);
    check('booted into a fresh World #1', created.worldId === 'world-1');

    // ---- 2. Quit the normal way: the parent exits, the game saves and quits ---------------------------
    first.lifeline.kill('SIGTERM');
    const deadline = Date.now() + 90_000;
    while (!first.exited && Date.now() < deadline) await sleep(200);
    check(
      'the game saved and quit',
      Boolean(first.exited) && existsSync(join(savesDir, 'world-1', 'level.dat')),
    );

    // ---- 3. Relaunch into the existing world, with duplicate world.open during the load --------------
    const second = launchClient('2-reopen');
    let duplicates = 0;
    let flooding = false;
    const flood = setInterval(() => {
      if (!flooding && second.lines.some((l) => /Opening World #1 \(world-1\)/.test(l.line))) flooding = true;
      if (flooding) {
        const sent = server.bridge.send('world.open', {
          worldId: 'world-1',
          gen: 1,
          fresh: false,
          hardcore: true,
          difficulty: 'hard',
        });
        if (sent) duplicates++;
      }
    }, 25);
    const reopened = await waitState('World #1 again', inWorld, 240_000, second);
    clearInterval(flood);
    check('reopened World #1', reopened.worldId === 'world-1', reopened.worldId);
    const readies = nodeEvents.filter(
      (e) => e.t === 'world.state' && e.phase === 'ready' && e.worldId === 'world-1' && e.fresh !== undefined,
    );
    check(
      'reported world-1 ready, not fresh, the second time',
      readies.length >= 2 && readies.at(-1).fresh === false,
      JSON.stringify(readies.map((r) => r.fresh)),
    );
    await sleep(5000);
    const after = await server.debug.state(2000);
    check('still standing in world-1 five seconds later', inWorld(after) && after.worldId === 'world-1');
    check(`sent ${duplicates} duplicate world.open during and after the load`, duplicates > 0);
    check(
      'world-1 was opened exactly once',
      count(second, /Opening World #1 \(world-1\)/) === 1,
      `${count(second, /Opening World #1/)} opens`,
    );
    check('never created again', count(second, /Creating World #1/) === 0);
    check('never switched away', count(second, /while .* is open; switching/) === 0);
    check(
      'no second "Node asks for World #1" while loading',
      count(second, /Node asks for World #1/) <= 1,
      `${count(second, /Node asks for World #1/)}`,
    );
    say(`duplicates ignored as already loading: ${count(second, /world.open world-1: already loading/)}`);
    exitCode = checks.every((c) => c.ok) ? 0 : 1;
  } catch (err) {
    say(`ERROR ${err.stack ?? err}`);
    checks.push({ name: 'run completed', ok: false, detail: String(err.message ?? err) });
  } finally {
    for (const launch of launches) {
      if (launch.lifeline && !launch.lifeline.killed) launch.lifeline.kill('SIGKILL');
      if (!launch.exited && launch.proc?.pid) {
        try {
          process.kill(-launch.proc.pid, 'SIGTERM');
        } catch {}
      }
    }
    spawnSync('pkill', ['-9', '-f', `minevibe.runTag=${runTag}`]);
    await sleep(500);
    const stragglers = spawnSync('pgrep', ['-f', `minevibe.runTag=${runTag}`], {
      encoding: 'utf8',
    }).stdout.trim();
    check('no game process left behind', stragglers === '', stragglers);
    await server.stop('quit').catch(() => {});
    const lines = [
      `# S7 reopen run ${runTag}`,
      '',
      '| Check | Result | Detail |',
      '|---|---|---|',
      ...checks.map((c) => `| ${c.name} | ${c.ok ? 'PASS' : 'FAIL'} | ${c.detail.replace(/\|/g, '\\|')} |`),
      '',
    ];
    writeFileSync(join(outDir, 'summary.md'), `${lines.join('\n')}\n`);
    writeFileSync(
      join(outDir, 'result.json'),
      `${JSON.stringify({ runTag, checks, nodeEvents }, null, 2)}\n`,
    );
    process.stdout.write(`${lines.join('\n')}\n`);
    process.exit(checks.every((c) => c.ok) ? exitCode : 1);
  }
}
