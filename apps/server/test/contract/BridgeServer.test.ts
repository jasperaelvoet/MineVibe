import { createHash } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { encodeFrame, FrameCodec, FrameFlag, FrameKind, MAX_TEXT_FRAME_BYTES } from '@minevibe/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import {
  BridgeError,
  BridgeServer,
  type BridgeServerOptions,
  CLOSE_CODES,
  checkUpgradeRequest,
  isLoopbackAddress,
  tokenMatches,
} from '../../src/bridge/BridgeServer.js';
import { generateToken } from '../../src/bridge/bridgeFile.js';
import { silentLogger } from '../../src/log.js';
import { ModClient } from '../helpers/modClient.js';

const TOKEN = generateToken();
const digest = createHash('sha256').update(TOKEN).digest();

const servers: BridgeServer[] = [];
const clients: ModClient[] = [];

async function startServer(options: Partial<BridgeServerOptions> = {}): Promise<BridgeServer> {
  const server = new BridgeServer({
    token: TOKEN,
    port: 0,
    logger: silentLogger(),
    heartbeatMs: 0,
    ...options,
  });
  servers.push(server);
  await server.start();
  return server;
}

async function connect(server: BridgeServer, token: string | null = TOKEN, options = {}): Promise<ModClient> {
  const client = await ModClient.connect(server.port, token, options);
  clients.push(client);
  return client;
}

function status(promise: Promise<unknown>): Promise<number | undefined> {
  return promise.then(
    () => undefined,
    (err: { status?: number }) => err.status,
  );
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

afterEach(async () => {
  for (const c of clients.splice(0)) c.ws.terminate();
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

const hello = { t: 'hello', v: 1, id: 'm-1', mod: '0.1.0', mc: '26.3', phase: 'boot' };

describe('isLoopbackAddress', () => {
  it.each(['127.0.0.1', '127.1.2.3', '::1', '::ffff:127.0.0.1', '::FFFF:127.0.0.1'])(
    '%s is loopback',
    (a) => {
      expect(isLoopbackAddress(a)).toBe(true);
    },
  );
  it.each(['10.0.0.1', '192.168.64.1', '0.0.0.0', '::', '::ffff:192.168.1.2', '127.0.0.256', '', undefined])(
    '%s is not loopback',
    (a) => {
      expect(isLoopbackAddress(a)).toBe(false);
    },
  );
});

describe('checkUpgradeRequest', () => {
  const good = {
    url: '/v1',
    headers: {
      host: '127.0.0.1:47800',
      authorization: `Bearer ${TOKEN}`,
      'sec-websocket-protocol': 'minevibe.v1',
    },
    socket: { remoteAddress: '127.0.0.1' },
  };

  it('accepts a well-formed request', () => {
    expect(checkUpgradeRequest(good, digest)).toBeNull();
    expect(checkUpgradeRequest({ ...good, url: '/v1?x=1' }, digest)).toBeNull();
    expect(
      checkUpgradeRequest({ ...good, headers: { ...good.headers, host: 'localhost:47800' } }, digest),
    ).toBeNull();
    expect(
      checkUpgradeRequest(
        { ...good, headers: { ...good.headers, authorization: `bearer ${TOKEN}`, host: '[::1]:47800' } },
        digest,
      ),
    ).toBeNull();
    expect(
      checkUpgradeRequest(
        { ...good, headers: { ...good.headers, 'sec-websocket-protocol': 'other, minevibe.v1' } },
        digest,
      ),
    ).toBeNull();
  });

  it('rejects non-loopback peers', () => {
    expect(checkUpgradeRequest({ ...good, socket: { remoteAddress: '192.168.64.2' } }, digest)).toEqual({
      status: 403,
      reason: 'non-loopback peer',
    });
    expect(checkUpgradeRequest({ ...good, socket: {} }, digest)?.status).toBe(403);
  });

  it('rejects any Origin header', () => {
    for (const origin of ['http://localhost', 'null', 'file://']) {
      expect(checkUpgradeRequest({ ...good, headers: { ...good.headers, origin } }, digest)).toEqual({
        status: 403,
        reason: 'Origin header not allowed',
      });
    }
    expect(
      checkUpgradeRequest({ ...good, headers: { ...good.headers, 'sec-websocket-origin': 'x' } }, digest)
        ?.status,
    ).toBe(403);
  });

  it('rejects non-loopback Host headers (DNS rebinding)', () => {
    expect(
      checkUpgradeRequest({ ...good, headers: { ...good.headers, host: 'evil.example' } }, digest)?.status,
    ).toBe(403);
    const { host: _omit, ...noHost } = good.headers;
    expect(checkUpgradeRequest({ ...good, headers: noHost }, digest)?.status).toBe(403);
  });

  it('rejects other paths', () => {
    expect(checkUpgradeRequest({ ...good, url: '/' }, digest)?.status).toBe(404);
    expect(checkUpgradeRequest({ ...good, url: '/v2' }, digest)?.status).toBe(404);
    expect(checkUpgradeRequest({ ...good, url: '/v1/' }, digest)?.status).toBe(404);
  });

  it('rejects missing, malformed and wrong tokens', () => {
    const { authorization: _omit, ...noAuth } = good.headers;
    expect(checkUpgradeRequest({ ...good, headers: noAuth }, digest)?.status).toBe(401);
    for (const authorization of [
      TOKEN,
      `Basic ${TOKEN}`,
      'Bearer ',
      `Bearer ${TOKEN}x`,
      `Bearer ${generateToken()}`,
    ]) {
      expect(
        checkUpgradeRequest({ ...good, headers: { ...good.headers, authorization } }, digest)?.status,
      ).toBe(401);
    }
  });

  it('requires the minevibe.v1 subprotocol', () => {
    const { 'sec-websocket-protocol': _omit, ...noProto } = good.headers;
    expect(checkUpgradeRequest({ ...good, headers: noProto }, digest)?.status).toBe(400);
    expect(
      checkUpgradeRequest(
        { ...good, headers: { ...good.headers, 'sec-websocket-protocol': 'minevibe.v2' } },
        digest,
      )?.status,
    ).toBe(400);
  });

  it('compares tokens in constant time over equal-length digests', () => {
    expect(tokenMatches(TOKEN, digest)).toBe(true);
    expect(tokenMatches('', digest)).toBe(false);
    expect(tokenMatches(`${TOKEN}${TOKEN}`, digest)).toBe(false);
  });
});

describe('BridgeServer over real sockets', () => {
  it('refuses to bind anything but loopback and short tokens', () => {
    expect(
      () => new BridgeServer({ token: TOKEN, logger: silentLogger(), host: '0.0.0.0' as '::1' }),
    ).toThrow(/loopback/);
    expect(() => new BridgeServer({ token: 'short', logger: silentLogger() })).toThrow(/token/);
  });

  it('accepts the mod with token and subprotocol', async () => {
    const server = await startServer();
    const connected = new Promise((r) => server.once('connected', r));
    const client = await connect(server);
    expect(client.ws.protocol).toBe('minevibe.v1');
    await connected;
    expect(server.isConnected).toBe(true);
  });

  it('rejects bad tokens, Origin, wrong path, missing subprotocol and evil Host', async () => {
    const server = await startServer();
    expect(await status(connect(server, 'x'.repeat(32)))).toBe(401);
    expect(await status(connect(server, null))).toBe(401);
    expect(await status(connect(server, TOKEN, { headers: { Origin: 'http://127.0.0.1' } }))).toBe(403);
    expect(await status(connect(server, TOKEN, { path: '/v2' }))).toBe(404);
    expect(await status(connect(server, TOKEN, { protocols: ['chat'] }))).toBe(400);
    expect(await status(connect(server, TOKEN, { headers: { Host: 'evil.example' } }))).toBe(403);
    expect(server.stats.rejectedUpgrades).toBe(6);
    expect(server.isConnected).toBe(false);
  });

  it('answers plain HTTP with 426', async () => {
    const server = await startServer();
    const code = await new Promise<number | undefined>((resolve, reject) => {
      httpRequest({ host: '127.0.0.1', port: server.port, path: '/v1' }, (res) => {
        res.resume();
        resolve(res.statusCode);
      })
        .on('error', reject)
        .end();
    });
    expect(code).toBe(426);
  });

  it('emits typed events for incoming messages', async () => {
    const server = await startServer();
    const got = new Promise<unknown>((resolve) => server.on('hello', (msg) => resolve(msg)));
    const any: string[] = [];
    server.on('message', (m) => {
      any.push(m.t);
    });
    const client = await connect(server);
    client.send(hello);
    expect(await got).toEqual(hello);
    expect(any).toEqual(['hello']);
  });

  it('replies ok with the handler result, err with BridgeError codes', async () => {
    const server = await startServer();
    let n = 0;
    server.handle('player.died', async (msg) => {
      n++;
      if (msg.day === 99) throw new BridgeError('NO_SERVER', 'no integrated server');
      if (msg.day === 98) throw new Error('kaboom');
      return { accepted: msg.worldId };
    });
    expect(() => server.handle('player.died', () => undefined)).toThrow(/already/);
    const client = await connect(server);
    const died = { t: 'player.died', v: 1, worldId: 'world-1', cause: 'lava', day: 2, ticksAlive: 10 };
    client.send({ ...died, id: 'd-1' });
    expect(await client.next('ok')).toEqual({ t: 'ok', v: 1, re: 'd-1', accepted: 'world-1' });
    client.send({ ...died, id: 'd-2', day: 99 });
    expect(await client.next('err')).toEqual({
      t: 'err',
      v: 1,
      re: 'd-2',
      code: 'NO_SERVER',
      msg: 'no integrated server',
    });
    client.send({ ...died, id: 'd-3', day: 98 });
    expect(await client.next('err')).toMatchObject({ re: 'd-3', code: 'INTERNAL', msg: 'kaboom' });
    expect(n).toBe(3);
  });

  it('answers requests nobody handles with NOT_HANDLED', async () => {
    const server = await startServer();
    const client = await connect(server);
    client.send({ t: 'chat.send', v: 1, id: 'c-1', to: 'all', text: 'hi' });
    expect(await client.next('err')).toMatchObject({ re: 'c-1', code: 'NOT_HANDLED' });
  });

  it('answers invalid requests with BAD_MESSAGE and unknown requests with UNKNOWN_TYPE', async () => {
    const server = await startServer();
    const client = await connect(server);
    client.send({ t: 'chat.send', v: 1, id: 'c-2', to: [], text: 'hi' });
    expect(await client.next('err')).toMatchObject({ re: 'c-2', code: 'BAD_MESSAGE' });
    client.send({ t: 'future.thing', v: 1, id: 'f-1' });
    expect(await client.next('err')).toMatchObject({ re: 'f-1', code: 'UNKNOWN_TYPE' });
  });

  it('ignores unknown messages without an id, garbage and binary frames', async () => {
    const server = await startServer();
    const client = await connect(server);
    client.send({ t: 'future.thing', v: 1 });
    client.ws.send('{not json');
    client.ws.send(Buffer.from([1, 2, 3]));
    client.send({ t: 'client.stopping', v: 1 }); // no id and no listener: nothing to answer
    client.send({ t: 'chat.send', v: 1, id: 'sentinel', to: 'all', text: 'x' });
    expect(await client.next('err')).toMatchObject({ re: 'sentinel', code: 'NOT_HANDLED' });
    expect(client.messages).toEqual([]);
    expect(server.isConnected).toBe(true);
  });

  it('refuses node-to-mod message types from the mod', async () => {
    const server = await startServer();
    const client = await connect(server);
    client.send({
      t: 'world.open',
      v: 1,
      id: 'x-1',
      worldId: 'world-1',
      gen: 1,
      fresh: true,
      hardcore: true,
      difficulty: 'hard',
    });
    expect(await client.next('err')).toMatchObject({ re: 'x-1', code: 'BAD_MESSAGE' });
  });

  it('send() validates outgoing payloads and reports whether a mod is connected', async () => {
    const server = await startServer();
    expect(server.send('ui.toast', { text: 'nobody listening', kind: 'info' })).toBe(false);
    const client = await connect(server);
    await sleep(10);
    expect(server.send('ui.toast', { text: 'hi', kind: 'info' }, { id: 't-1' })).toBe(true);
    expect(await client.next('ui.toast')).toEqual({
      t: 'ui.toast',
      v: 1,
      id: 't-1',
      text: 'hi',
      kind: 'info',
    });
    expect(() => server.send('ui.toast', { text: '', kind: 'info' })).toThrow(/text/);
  });

  it('request() resolves on ok and rejects on err, timeout and disconnect', async () => {
    const server = await startServer({ requestTimeoutMs: 100 });
    await expect(server.request('ui.toast', { text: 'x', kind: 'info' })).rejects.toMatchObject({
      code: 'DISCONNECTED',
    });
    const client = await connect(server);
    await sleep(10);

    const okReq = server.request('agent.say', { agentId: 'ada', text: 'hi', style: 'speech', ttlMs: 1000 });
    const sent = await client.next('agent.say');
    expect(typeof sent.id).toBe('string');
    client.send({ t: 'ok', v: 1, re: sent.id, entityId: 7 });
    await expect(okReq).resolves.toMatchObject({ t: 'ok', re: sent.id, entityId: 7 });

    const errReq = server.request('ui.toast', { text: 'x', kind: 'info' });
    const sent2 = await client.next('ui.toast');
    client.send({ t: 'err', v: 1, re: sent2.id, code: 'NO_SERVER', msg: 'not in a world' });
    await expect(errReq).rejects.toMatchObject({
      name: 'BridgeError',
      code: 'NO_SERVER',
      message: 'not in a world',
    });

    await expect(server.request('ui.toast', { text: 'slow', kind: 'info' })).rejects.toMatchObject({
      code: 'TIMEOUT',
    });

    const pending = server.request('ui.toast', { text: 'x', kind: 'info' }, { timeoutMs: 5000 });
    await client.next('ui.toast', (m) => m.text === 'x');
    client.ws.close();
    await expect(pending).rejects.toMatchObject({ code: 'DISCONNECTED' });
  });

  it('a late reply after a timeout is ignored', async () => {
    const server = await startServer();
    const client = await connect(server);
    await sleep(10);
    const p = server.request('ui.toast', { text: 'x', kind: 'info' }, { timeoutMs: 20 });
    const sent = await client.next('ui.toast');
    await expect(p).rejects.toMatchObject({ code: 'TIMEOUT' });
    client.send({ t: 'ok', v: 1, re: sent.id });
    await sleep(20);
    expect(server.isConnected).toBe(true);
  });

  it('a new authenticated connection replaces the old one', async () => {
    const server = await startServer();
    const events: string[] = [];
    server.on('connected', (i) => {
      events.push(`connected:${i.connectionId}`);
    });
    server.on('disconnected', (i) => {
      events.push(`disconnected:${i.connectionId}:${i.replaced}:${i.code}`);
    });
    const first = await connect(server);
    const firstClosed = first.closed();
    const second = await connect(server);
    expect((await firstClosed).code).toBe(CLOSE_CODES.REPLACED);
    await sleep(10);
    expect(events).toEqual(['connected:1', 'connected:2', `disconnected:1:true:${CLOSE_CODES.REPLACED}`]);
    expect(server.isConnected).toBe(true);
    server.send('ui.toast', { text: 'to the new one', kind: 'info' });
    expect((await second.next('ui.toast')).text).toBe('to the new one');
    expect(first.messages).toEqual([]);
  });

  it('a failed auth attempt does not disturb the live connection', async () => {
    const server = await startServer();
    const live = await connect(server);
    expect(await status(connect(server, 'y'.repeat(32)))).toBe(401);
    server.send('ui.toast', { text: 'still here', kind: 'info' });
    expect((await live.next('ui.toast')).text).toBe('still here');
  });

  it('closes peers that send oversized text frames', async () => {
    const server = await startServer();
    const client = await connect(server);
    const closed = client.closed();
    client.ws.send('x'.repeat(MAX_TEXT_FRAME_BYTES + 1));
    expect((await closed).code).toBe(1009);
  });

  it('sendFrame delivers MVF1 frames and skips them while the socket is backed up', async () => {
    const server = await startServer({ frameSkipBytes: 64 * 1024 });
    const frame = (w: number, h: number) =>
      encodeFrame(
        { kind: FrameKind.PC_FRAME, codec: FrameCodec.BGRA8, flags: FrameFlag.FULL, pcSlot: 1, seq: 1, w, h },
        new Uint8Array(w * h * 4),
      );
    expect(server.sendFrame(frame(2, 2))).toBe(false); // nobody connected
    expect(() => server.sendFrame(new Uint8Array(40))).toThrow(/MVF1/);

    const client = await connect(server);
    await sleep(10);
    expect(server.sendFrame(frame(2, 2))).toBe(true);
    // 16 MB in flight: the next frame must be skipped, not queued.
    expect(server.sendFrame(frame(2048, 2048))).toBe(true);
    expect(server.sendFrame(frame(2, 2))).toBe(false);
    expect(server.stats.framesSkipped).toBe(1);
    // Control messages are never dropped.
    expect(server.send('ui.toast', { text: 'after frames', kind: 'info' })).toBe(true);
    expect((await client.next('ui.toast', () => true, 5000)).text).toBe('after frames');
    expect(client.binary.length).toBe(2);
    expect(client.binary[0]?.subarray(0, 4).toString('latin1')).toBe('MVF1');
  });

  it('drops a peer that stops answering pings', async () => {
    const server = await startServer({ heartbeatMs: 30 });
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/v1`, 'minevibe.v1', {
      headers: { Authorization: `Bearer ${TOKEN}` },
      autoPong: false,
    });
    const code = await new Promise<number>((resolve, reject) => {
      ws.once('close', (c) => resolve(c));
      ws.once('error', reject);
    });
    expect(code).toBe(CLOSE_CODES.TIMEOUT);
  });

  it('keeps a peer that answers pings', async () => {
    const server = await startServer({ heartbeatMs: 20 });
    await connect(server);
    await sleep(150);
    expect(server.isConnected).toBe(true);
  });

  it('close() says server.shutdown, closes 1001, fails pending requests and stops listening', async () => {
    const server = await startServer();
    const client = await connect(server);
    await sleep(10);
    const pending = server
      .request('ui.toast', { text: 'x', kind: 'info' }, { timeoutMs: 5000 })
      .catch((e) => e);
    const closed = client.closed();
    await server.close('restart');
    expect((await closed).code).toBe(CLOSE_CODES.GOING_AWAY);
    expect(await pending).toMatchObject({ code: 'DISCONNECTED' });
    expect(client.messages.map((m) => m.t)).toEqual(['ui.toast', 'server.shutdown']);
    expect(client.messages[1]).toMatchObject({ reason: 'restart' });
    await expect(ModClient.connect(server.port, TOKEN)).rejects.toBeDefined();
    await server.close(); // idempotent
  });
});
