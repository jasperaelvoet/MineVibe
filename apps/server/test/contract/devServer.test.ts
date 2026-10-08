import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { silentLogger } from '../../src/log.js';
import { type DevServer, startDevServer } from '../../src/orchestrator/devServer.js';
import { ModClient } from '../helpers/modClient.js';

const dirs: string[] = [];
const servers: DevServer[] = [];
const clients: ModClient[] = [];

async function start(): Promise<{ server: DevServer; repo: string; token: string }> {
  const repo = mkdtempSync(join(tmpdir(), 'mv-dev-'));
  dirs.push(repo);
  const server = await startDevServer({
    repoRoot: repo,
    logger: silentLogger(),
    port: 0,
    env: {},
    heartbeatMs: 0,
  });
  servers.push(server);
  const token = readFileSync(join(repo, '.dev-token'), 'utf8').trim();
  return { server, repo, token };
}

async function connect(port: number, token: string): Promise<ModClient> {
  const c = await ModClient.connect(port, token);
  clients.push(c);
  return c;
}

afterEach(async () => {
  for (const c of clients.splice(0)) c.ws.terminate();
  await Promise.all(servers.splice(0).map((s) => s.stop()));
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const hello = { t: 'hello', v: 1, id: 'm-1', mod: '0.1.0', mc: '26.3', phase: 'boot', playerName: 'Jasper' };

describe('dev server', () => {
  it('writes .dev-token and run/bridge.json privately under the dev home', async () => {
    const { server, repo, token } = await start();
    expect(statSync(join(repo, '.dev-token')).mode & 0o777).toBe(0o600);
    expect(server.paths.appSupport).toBe(join(repo, '.minevibe-dev'));
    const bridgeFile = join(repo, '.minevibe-dev', 'run', 'bridge.json');
    expect(statSync(bridgeFile).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(bridgeFile, 'utf8'))).toEqual({
      port: server.port,
      token,
      pid: process.pid,
    });
  });

  it('answers hello with hello.ok and opens World #1', async () => {
    const { server, token } = await start();
    const mod = await connect(server.port, token);
    mod.send(hello);
    const ok = await mod.next('hello.ok');
    expect(ok).toMatchObject({
      re: 'm-1',
      server: { protocol: 1 },
      world: { id: 'world-1', gen: 1, fresh: true },
      player: { name: 'Jasper' },
      crew: [],
      pending: [],
    });
    expect(await mod.next('world.open')).toEqual({
      t: 'world.open',
      v: 1,
      worldId: 'world-1',
      gen: 1,
      fresh: true,
      hardcore: true,
      difficulty: 'hard',
    });
  });

  it('runs the hardcore loop: death -> ack -> world.next -> closed -> world.open of World #2', async () => {
    const { server, token } = await start();
    const mod = await connect(server.port, token);
    mod.send(hello);
    await mod.next('world.open');
    mod.send({ t: 'world.state', v: 1, worldId: 'world-1', phase: 'ready', fresh: true });

    const died = {
      t: 'player.died',
      v: 1,
      id: 'd-1',
      worldId: 'world-1',
      cause: 'Jasper burned',
      day: 2,
      ticksAlive: 30000,
    };
    mod.send(died);
    expect(await mod.next('ok')).toMatchObject({ re: 'd-1' });
    const next = await mod.next('world.next');
    expect(next).toMatchObject({
      worldId: 'world-2',
      gen: 2,
      summary: {
        worldId: 'world-1',
        gen: 1,
        day: 2,
        cause: 'Jasper burned',
        crewFates: [],
        vaultCommits: [],
      },
    });

    // The mod re-sends until acked: idempotent.
    mod.send({ ...died, id: 'd-2' });
    expect(await mod.next('ok')).toMatchObject({ re: 'd-2' });
    expect((await mod.next('world.next')).worldId).toBe('world-2');

    mod.send({ t: 'world.state', v: 1, worldId: 'world-1', phase: 'closed' });
    expect(await mod.next('world.open')).toMatchObject({ worldId: 'world-2', gen: 2, fresh: true });

    const state = JSON.parse(readFileSync(join(server.paths.state, 'current-world.json'), 'utf8'));
    expect(state).toMatchObject({ worldId: 'world-2', gen: 2, status: 'alive' });
  });

  it('remembers that a world was created, and reopens a stale in-world mod', async () => {
    const { server, token } = await start();
    const mod = await connect(server.port, token);
    mod.send(hello);
    await mod.next('world.open');
    mod.send({ t: 'world.state', v: 1, worldId: 'world-1', phase: 'ready' });
    await new Promise((r) => setTimeout(r, 30));

    const again = await connect(server.port, token);
    again.send({ ...hello, id: 'm-2', phase: 'in_world', worldId: 'world-1' });
    expect(await again.next('hello.ok')).toMatchObject({ world: { id: 'world-1', fresh: false } });

    const stale = await connect(server.port, token);
    stale.send({ ...hello, id: 'm-3', phase: 'in_world', worldId: 'world-0' });
    await stale.next('hello.ok');
    expect(await stale.next('world.open')).toMatchObject({ worldId: 'world-1', fresh: false });
  });

  it('routes chat.send: broadcast echo, inline errors for unknown names', async () => {
    const { server, token } = await start();
    const mod = await connect(server.port, token);
    mod.send({ t: 'chat.send', v: 1, id: 'c-1', to: 'all', text: 'anyone here?' });
    expect(await mod.next('ok')).toEqual({
      t: 'ok',
      v: 1,
      re: 'c-1',
      echo: 'You → all: anyone here? (nobody is around to hear it)',
    });
    mod.send({ t: 'chat.send', v: 1, id: 'c-2', to: 'all', text: '@ada hi' });
    expect(await mod.next('err')).toEqual({
      t: 'err',
      v: 1,
      re: 'c-2',
      code: 'CHAT_UNKNOWN',
      msg: 'Nobody is called @ada. Crew: nobody',
    });
    mod.send({ t: 'chat.send', v: 1, id: 'c-3', to: 'all', text: '@ada,@bram hi' });
    expect(await mod.next('err')).toMatchObject({ re: 'c-3', code: 'CHAT_REJECTED' });
  });

  it('removes its bridge file on stop and tells the mod', async () => {
    const { server, token } = await start();
    const mod = await connect(server.port, token);
    await new Promise((r) => setTimeout(r, 10));
    const bridgeFile = server.paths.bridgeFile;
    await server.stop();
    expect(existsSync(bridgeFile)).toBe(false);
    expect((await mod.next('server.shutdown')).reason).toBe('quit');
  });

  it('reuses the dev token across restarts', async () => {
    const first = await start();
    await first.server.stop();
    const again = await startDevServer({
      repoRoot: first.repo,
      logger: silentLogger(),
      port: 0,
      env: {},
      heartbeatMs: 0,
    });
    servers.push(again);
    expect(readFileSync(join(first.repo, '.dev-token'), 'utf8').trim()).toBe(first.token);
  });
});
