import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseMessage } from '@minevibe/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { silentLogger } from '../../src/log.js';
import { type DevServer, startDevServer } from '../../src/orchestrator/devServer.js';
import { ModClient, type Received } from '../helpers/modClient.js';

const dirs: string[] = [];
const servers: DevServer[] = [];
const clients: ModClient[] = [];

afterEach(async () => {
  for (const c of clients.splice(0)) c.ws.terminate();
  await Promise.all(servers.splice(0).map((s) => s.stop()));
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function start(scriptedCrew: boolean): Promise<{ server: DevServer; mod: ModClient }> {
  const repo = mkdtempSync(join(tmpdir(), 'mv-ui-'));
  dirs.push(repo);
  const server = await startDevServer({
    repoRoot: repo,
    logger: silentLogger(),
    port: 0,
    env: {},
    heartbeatMs: 0,
    scriptedCrew,
    scriptedReplyDelayMs: 20,
  });
  servers.push(server);
  const token = JSON.parse(readFileSync(server.paths.bridgeFile, 'utf8')).token as string;
  const mod = await ModClient.connect(server.port, token);
  clients.push(mod);
  return { server, mod };
}

/** Everything Node sends must be a valid protocol message. */
function valid(m: Received): Received {
  expect(() => parseMessage(m)).not.toThrow();
  return m;
}

describe('dev server with --scripted-crew', () => {
  it('re-sends the crew after hello.ok and answers chat over the real bridge', async () => {
    const { server, mod } = await start(true);
    expect(server.ui).not.toBeNull();
    expect(server.scriptedCrew?.listAgents().map((a) => a.handle)).toEqual(['ada', 'bram']);

    const order: string[] = [];
    mod.ws.on('message', (data, isBinary) => {
      if (!isBinary) order.push((JSON.parse(String(data)) as Received).t);
    });
    mod.send({ t: 'hello', v: 1, id: 'm-1', mod: '0.1.0', mc: '26.3', phase: 'boot', playerName: 'Jasper' });
    await mod.next('hello.ok');
    const crew = valid(await mod.next('crew.state'));
    expect((crew.crew as Array<{ handle: string }>).map((c) => c.handle)).toEqual(['ada', 'bram']);
    valid(await mod.next('brains.state'));
    const brain = valid(await mod.next('agent.brain', (m) => m.agentId === 'bram'));
    expect(brain).toMatchObject({ model: 'opus', planFirst: true });
    valid(await mod.next('agent.pending', (m) => m.agentId === 'ada'));
    // hello.ok goes first: the pushes are deferred past it.
    expect(order[0]).toBe('hello.ok');
    expect(order.filter((t) => t !== 'world.open').slice(1, 3)).toEqual(['crew.state', 'brains.state']);

    mod.send({ t: 'chat.send', v: 1, id: 'm-2', to: 'all', text: '@ada please ask me a question' });
    const ok = valid(await mod.next('ok', (m) => m.re === 'm-2'));
    expect(ok.echo).toBe('You → Ada: please ask me a question');
    const pending = valid(await mod.next('agent.pending', (m) => (m.cards as unknown[]).length > 0));
    const card = (pending.cards as Array<{ id: string; kind: string }>)[0];
    expect(card?.kind).toBe('question');
    valid(await mod.next('agent.say', (m) => m.agentId === 'ada'));

    mod.send({ t: 'chat.send', v: 1, id: 'm-3', to: 'all', text: '@ada 9' });
    const err = valid(await mod.next('err', (m) => m.re === 'm-3'));
    expect(err).toMatchObject({ code: 'CHAT_INVALID_ANSWER' });

    mod.send({
      t: 'pending.answer',
      v: 1,
      id: 'm-4',
      agentId: 'ada',
      pendingId: card?.id,
      answer: { kind: 'options', picks: [1] },
    });
    const answered = valid(await mod.next('ok', (m) => m.re === 'm-4'));
    expect(answered.echo).toBe('You → Ada: Q1 = 1 (Oak)');
    await mod.next('agent.pending', (m) => m.agentId === 'ada' && (m.cards as unknown[]).length === 0);

    mod.send({ t: 'agent.cmd', v: 1, id: 'm-5', agentId: 'bram', cmd: 'ping_instead', on: true });
    expect(valid(await mod.next('ok', (m) => m.re === 'm-5')).echo).toBe('Bram: ping instead on');

    mod.send({ t: 'chat.history', v: 1, id: 'm-6', agentId: 'ada', limit: 50 });
    const history = valid(await mod.next('ok', (m) => m.re === 'm-6'));
    expect((history.entries as Array<{ kind: string }>).map((e) => e.kind)).toContain('player');
  });

  it('keeps the M1 chat handler (empty roster) without the flag', async () => {
    const { server, mod } = await start(false);
    expect(server.ui).toBeNull();
    mod.send({ t: 'chat.send', v: 1, id: 'm-1', to: 'all', text: '@ada hi' });
    const err = await mod.next('err', (m) => m.re === 'm-1');
    expect(err).toMatchObject({ code: 'CHAT_UNKNOWN' });
  });
});
