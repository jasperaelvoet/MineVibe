import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingHttpHeaders, type Server, STATUS_CODES } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import {
  type AnyMessage,
  BRIDGE_HOST,
  BRIDGE_PATH,
  directionOf,
  ERROR_CODES,
  encodeMessage,
  FRAME_SKIP_BUFFERED_BYTES,
  looksLikeMvf1,
  MAX_TEXT_FRAME_BYTES,
  type MessageOf,
  type ModToNodeType,
  type NodeToModType,
  type OkReply,
  type PayloadOf,
  ProtocolError,
  RPC_TIMEOUTS,
  SUBPROTOCOL,
  safeParseMessageText,
} from '@minevibe/protocol';
import type { Logger } from 'pino';
import { type RawData, WebSocket, WebSocketServer } from 'ws';
import { TypedEmitter } from '../util/TypedEmitter.js';

/** Message types the mod sends that are not replies. */
export type IncomingType = Exclude<ModToNodeType, 'ok' | 'err'>;
/** Message types Node sends that are not replies. */
export type OutgoingType = Exclude<NodeToModType, 'ok' | 'err'>;

export interface ConnectionInfo {
  /** Monotonic id of the connection within this server's lifetime. */
  readonly connectionId: number;
  readonly remoteAddress: string;
}

export interface DisconnectInfo extends ConnectionInfo {
  readonly code: number;
  readonly reason: string;
  /** True when a newer authenticated connection took over. */
  readonly replaced: boolean;
}

/** Events: one per incoming message type, plus lifecycle events. */
export type BridgeEvents = { [K in IncomingType]: [message: MessageOf<K>] } & {
  connected: [info: ConnectionInfo];
  disconnected: [info: DisconnectInfo];
  /** Every validated incoming message (replies excluded). */
  message: [message: AnyMessage];
};

type LifecycleEvent = 'connected' | 'disconnected' | 'message';
// Compile-time guard: a protocol message type must never collide with a lifecycle event name.
const _noEventCollision: Extract<IncomingType, LifecycleEvent> extends never ? true : never = true;
void _noEventCollision;

/** Result payload of a request handler (the keys of the `ok` reply). */
export type HandlerResult = Record<string, unknown> | undefined;
export type RequestHandler<K extends IncomingType> = (
  message: MessageOf<K>,
) => HandlerResult | Promise<HandlerResult>;

/** A failure with a protocol error code: thrown by handlers to reply `err`, and rejected by `request()`. */
export class BridgeError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'BridgeError';
    this.code = code;
  }
}

export interface BridgeServerOptions {
  /** Shared secret the mod presents as `Authorization: Bearer <token>`. */
  token: string;
  /** TCP port; 0 picks a random free port. */
  port?: number;
  /** Loopback only. */
  host?: '127.0.0.1' | '::1';
  logger: Logger;
  /** Default `request()` timeout. */
  requestTimeoutMs?: number;
  /** WebSocket ping interval; a peer that misses {@link MAX_MISSED_PONGS} pongs in a row is dropped. 0 disables. */
  heartbeatMs?: number;
  /** `sendFrame` skips frames while the socket buffers more than this many bytes. */
  frameSkipBytes?: number;
}

export interface BridgeStats {
  framesSent: number;
  framesSkipped: number;
  messagesIn: number;
  messagesOut: number;
  rejectedUpgrades: number;
}

interface PendingRequest {
  readonly t: string;
  readonly resolve: (reply: OkReply) => void;
  readonly reject: (err: BridgeError) => void;
  readonly timer: NodeJS.Timeout;
}

interface Connection {
  readonly id: number;
  readonly ws: WebSocket;
  readonly remoteAddress: string;
  readonly pending: Map<string, PendingRequest>;
  missedPongs: number;
  replaced: boolean;
}

/** Consecutive unanswered pings before the peer is considered dead. */
export const MAX_MISSED_PONGS = 2;

/** Why an upgrade request was refused. */
export interface UpgradeRejection {
  readonly status: 400 | 401 | 403 | 404;
  readonly reason: string;
}

/** Minimal view of an upgrade request, so the checks can be unit-tested without sockets. */
export interface UpgradeRequestLike {
  readonly url?: string | undefined;
  readonly headers: IncomingHttpHeaders;
  readonly socket: { readonly remoteAddress?: string | undefined };
}

/** True for IPv4 127.0.0.0/8, IPv6 ::1 and IPv4-mapped loopback. */
export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  if (address === '::1') return true;
  const v4 = address.toLowerCase().startsWith('::ffff:') ? address.slice(7) : address;
  const m = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(v4);
  if (!m) return false;
  return m.slice(1).every((octet) => Number(octet) <= 255);
}

const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]']);

function hostnameOf(hostHeader: string): string {
  const h = hostHeader.trim().toLowerCase();
  if (h.startsWith('[')) {
    const end = h.indexOf(']');
    return end === -1 ? h : h.slice(0, end + 1);
  }
  const colon = h.indexOf(':');
  return colon === -1 ? h : h.slice(0, colon);
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/** Constant-time token comparison (hashing first makes the inputs equal length). */
export function tokenMatches(presented: string, expectedDigest: Buffer): boolean {
  return timingSafeEqual(digest(presented), expectedDigest);
}

function offeredProtocols(headers: IncomingHttpHeaders): string[] {
  const raw = headers['sec-websocket-protocol'];
  if (!raw) return [];
  return (Array.isArray(raw) ? raw.join(',') : raw)
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
}

/**
 * Validates an upgrade request (PLAN §5 "Auth"): loopback peer only, path `/v1`, no `Origin` header
 * (browsers always send one), a loopback `Host`, a matching bearer token, and the `minevibe.v1`
 * subprotocol. Returns null when the request may be upgraded.
 */
export function checkUpgradeRequest(
  req: UpgradeRequestLike,
  expectedDigest: Buffer,
): UpgradeRejection | null {
  if (!isLoopbackAddress(req.socket.remoteAddress)) {
    return { status: 403, reason: 'non-loopback peer' };
  }
  let pathname: string;
  try {
    pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
  } catch {
    return { status: 400, reason: 'bad request target' };
  }
  if (pathname !== BRIDGE_PATH) return { status: 404, reason: 'unknown path' };
  if (req.headers.origin !== undefined || req.headers['sec-websocket-origin'] !== undefined) {
    return { status: 403, reason: 'Origin header not allowed' };
  }
  const host = req.headers.host;
  if (!host || !LOOPBACK_HOSTNAMES.has(hostnameOf(host))) {
    return { status: 403, reason: 'non-loopback Host' };
  }
  const auth = req.headers.authorization;
  const match = auth ? /^Bearer\s+(\S+)\s*$/i.exec(auth) : null;
  if (!match?.[1] || !tokenMatches(match[1], expectedDigest)) {
    return { status: 401, reason: 'missing or bad token' };
  }
  if (!offeredProtocols(req.headers).includes(SUBPROTOCOL)) {
    return { status: 400, reason: `subprotocol ${SUBPROTOCOL} required` };
  }
  return null;
}

function rejectUpgrade(socket: Duplex, rejection: UpgradeRejection): void {
  if (!socket.writable) {
    socket.destroy();
    return;
  }
  const body = `${rejection.reason}\n`;
  socket.once('finish', () => socket.destroy());
  socket.end(
    `HTTP/1.1 ${rejection.status} ${STATUS_CODES[rejection.status] ?? ''}\r\n` +
      'Connection: close\r\nContent-Type: text/plain; charset=utf-8\r\n' +
      `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
  );
}

function rawToText(data: RawData): string {
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.from(data).toString('utf8');
}

/** WebSocket close codes used by the bridge. */
export const CLOSE_CODES = {
  NORMAL: 1000,
  GOING_AWAY: 1001,
  /** A newer authenticated connection replaced this one. */
  REPLACED: 4000,
  /** Missed heartbeats. */
  TIMEOUT: 4001,
} as const;

/**
 * The single WebSocket between the mod and Node (PLAN §5).
 *
 * - Listens on 127.0.0.1 only, path `/v1`, subprotocol `minevibe.v1`, bearer-token auth.
 * - One live connection: a new authenticated connection replaces the old one.
 * - JSON text frames are validated with `@minevibe/protocol`; incoming messages are emitted as typed
 *   events, requests can be answered by `handle()`, and `request()` does RPC keyed by `id`.
 * - `sendFrame()` sends MVF1 binary frames, skipping them while the socket is backed up.
 */
export class BridgeServer extends TypedEmitter<BridgeEvents> {
  readonly #token: Buffer;
  readonly #host: string;
  readonly #requestedPort: number;
  readonly #log: Logger;
  readonly #requestTimeoutMs: number;
  readonly #heartbeatMs: number;
  readonly #frameSkipBytes: number;
  readonly #handlers = new Map<IncomingType, RequestHandler<IncomingType>>();
  readonly #stats: BridgeStats = {
    framesSent: 0,
    framesSkipped: 0,
    messagesIn: 0,
    messagesOut: 0,
    rejectedUpgrades: 0,
  };

  #http: Server | null = null;
  #wss: WebSocketServer | null = null;
  #conn: Connection | null = null;
  #connSeq = 0;
  #requestSeq = 0;
  #heartbeat: NodeJS.Timeout | null = null;
  #port = 0;
  #closing: Promise<void> | null = null;

  constructor(options: BridgeServerOptions) {
    super();
    if (options.token.length < 16) throw new Error('BridgeServer: token too short');
    const host = options.host ?? BRIDGE_HOST;
    if (host !== '127.0.0.1' && host !== '::1') throw new Error('BridgeServer: loopback hosts only');
    this.#token = digest(options.token);
    this.#host = host;
    this.#requestedPort = options.port ?? 0;
    this.#log = options.logger;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? RPC_TIMEOUTS.default;
    this.#heartbeatMs = options.heartbeatMs ?? 15_000;
    this.#frameSkipBytes = options.frameSkipBytes ?? FRAME_SKIP_BUFFERED_BYTES;
  }

  /** The bound port (valid after `start()`). */
  get port(): number {
    return this.#port;
  }

  get isConnected(): boolean {
    return this.#conn !== null && this.#conn.ws.readyState === WebSocket.OPEN;
  }

  get stats(): Readonly<BridgeStats> {
    return { ...this.#stats };
  }

  /** Starts listening. Resolves with the bound port. */
  async start(): Promise<number> {
    if (this.#http) throw new Error('BridgeServer already started');
    const wss = new WebSocketServer({
      noServer: true,
      maxPayload: MAX_TEXT_FRAME_BYTES,
      perMessageDeflate: false,
      clientTracking: false,
      handleProtocols: (protocols) => (protocols.has(SUBPROTOCOL) ? SUBPROTOCOL : false),
    });
    const http = createServer((req, res) => {
      // Plain HTTP is never served.
      res.writeHead(426, { 'Content-Type': 'text/plain', Connection: 'close' });
      res.end('WebSocket only\n');
      req.resume();
    });
    http.on('upgrade', (req, socket, head) => {
      socket.on('error', (err) => this.#log.debug({ err }, 'bridge upgrade socket error'));
      const rejection = checkUpgradeRequest(req, this.#token);
      if (rejection) {
        this.#stats.rejectedUpgrades++;
        this.#log.warn(
          { status: rejection.status, reason: rejection.reason, remote: req.socket.remoteAddress },
          'bridge connection rejected',
        );
        rejectUpgrade(socket, rejection);
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => this.#attach(ws, req.socket.remoteAddress ?? 'unknown'));
    });
    http.on('clientError', (err, socket) => {
      this.#log.debug({ err }, 'bridge client error');
      socket.destroy();
    });

    await new Promise<void>((resolvePromise, reject) => {
      const onError = (err: Error) => reject(err);
      http.once('error', onError);
      http.listen({ port: this.#requestedPort, host: this.#host, exclusive: true }, () => {
        http.off('error', onError);
        resolvePromise();
      });
    });
    http.on('error', (err) => this.#log.error({ err }, 'bridge server error'));
    this.#http = http;
    this.#wss = wss;
    this.#port = (http.address() as AddressInfo).port;
    if (this.#heartbeatMs > 0) {
      this.#heartbeat = setInterval(() => this.#beat(), this.#heartbeatMs);
      this.#heartbeat.unref();
    }
    this.#log.info({ host: this.#host, port: this.#port, path: BRIDGE_PATH }, 'bridge listening');
    return this.#port;
  }

  /**
   * Registers the request handler for `t` (one per type). For a message with an `id`, the handler's
   * return value becomes the `ok` reply and a thrown {@link BridgeError} becomes `err{code,msg}`.
   */
  handle<K extends IncomingType>(t: K, handler: RequestHandler<K>): () => void {
    if (this.#handlers.has(t)) throw new Error(`BridgeServer: handler for ${t} already registered`);
    this.#handlers.set(t, handler as unknown as RequestHandler<IncomingType>);
    return () => {
      if (this.#handlers.get(t) === (handler as unknown)) this.#handlers.delete(t);
    };
  }

  /**
   * Sends a message. Returns false when no mod is connected (state is fully re-sent on the next `hello`,
   * so nothing is queued). Throws {@link ProtocolError} if the payload does not match its schema.
   */
  send<K extends OutgoingType>(t: K, payload: PayloadOf<K>, ids: { id?: string; re?: string } = {}): boolean {
    const text = encodeMessage(t, payload, ids);
    return this.#sendText(text, t);
  }

  /**
   * Sends a request and resolves with the peer's `ok` reply. Rejects with {@link BridgeError}:
   * the peer's `err` code, `TIMEOUT`, or `DISCONNECTED`.
   */
  request<K extends OutgoingType>(
    t: K,
    payload: PayloadOf<K>,
    options: { timeoutMs?: number } = {},
  ): Promise<OkReply> {
    const conn = this.#conn;
    if (!conn || conn.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new BridgeError(ERROR_CODES.DISCONNECTED, `cannot send ${t}: mod not connected`));
    }
    const id = `n-${++this.#requestSeq}`;
    let text: string;
    try {
      text = encodeMessage(t, payload, { id });
    } catch (err) {
      return Promise.reject(err);
    }
    const timeoutMs = options.timeoutMs ?? this.#requestTimeoutMs;
    return new Promise<OkReply>((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        conn.pending.delete(id);
        reject(new BridgeError(ERROR_CODES.TIMEOUT, `${t} timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      timer.unref();
      conn.pending.set(id, { t, resolve: resolvePromise, reject, timer });
      if (!this.#sendText(text, t)) {
        clearTimeout(timer);
        conn.pending.delete(id);
        reject(new BridgeError(ERROR_CODES.DISCONNECTED, `cannot send ${t}: mod not connected`));
      }
    });
  }

  /**
   * Sends one MVF1 binary frame. Frames are droppable: returns false (and counts a skip) when no mod is
   * connected or the socket already buffers more than 8 MB. Control messages are never dropped this way.
   */
  sendFrame(frame: Uint8Array): boolean {
    if (!looksLikeMvf1(frame)) throw new TypeError('sendFrame: not an MVF1 frame');
    const conn = this.#conn;
    if (!conn || conn.ws.readyState !== WebSocket.OPEN) return false;
    if (conn.ws.bufferedAmount > this.#frameSkipBytes) {
      this.#stats.framesSkipped++;
      return false;
    }
    conn.ws.send(frame, { binary: true });
    this.#stats.framesSent++;
    return true;
  }

  /**
   * Graceful shutdown: tells the mod (`server.shutdown`), closes the socket (forcefully after 1 s),
   * fails pending requests and stops listening. Idempotent.
   */
  close(reason = 'quit'): Promise<void> {
    this.#closing ??= this.#doClose(reason);
    return this.#closing;
  }

  async #doClose(reason: string): Promise<void> {
    if (this.#heartbeat) clearInterval(this.#heartbeat);
    this.#heartbeat = null;
    const conn = this.#conn;
    if (conn) {
      if (conn.ws.readyState === WebSocket.OPEN) {
        try {
          this.send('server.shutdown', { reason });
        } catch (err) {
          this.#log.debug({ err }, 'server.shutdown not sent');
        }
      }
      await this.#closeSocket(conn, CLOSE_CODES.GOING_AWAY, 'server shutting down', 1000);
    }
    this.#wss?.close();
    const http = this.#http;
    if (http) {
      await new Promise<void>((resolvePromise) => {
        http.close(() => resolvePromise());
        http.closeAllConnections();
      });
    }
    this.#log.info('bridge closed');
  }

  protected override onListenerError(event: string, error: unknown): void {
    this.#log.error({ err: error, event }, 'bridge listener failed');
  }

  #attach(ws: WebSocket, remoteAddress: string): void {
    if (this.#closing) {
      ws.close(CLOSE_CODES.GOING_AWAY, 'server shutting down');
      return;
    }
    const conn: Connection = {
      id: ++this.#connSeq,
      ws,
      remoteAddress,
      pending: new Map(),
      missedPongs: 0,
      replaced: false,
    };
    const previous = this.#conn;
    this.#conn = conn;
    if (previous) {
      previous.replaced = true;
      this.#log.info({ old: previous.id, new: conn.id }, 'bridge connection replaced');
      void this.#closeSocket(previous, CLOSE_CODES.REPLACED, 'replaced by a newer connection', 1000);
    }

    ws.on('message', (data, isBinary) => this.#onData(conn, data, isBinary));
    ws.on('pong', () => {
      conn.missedPongs = 0;
    });
    ws.on('error', (err) => this.#log.warn({ err, connection: conn.id }, 'bridge socket error'));
    ws.on('close', (code, reasonBuf) => {
      this.#failPending(conn, ERROR_CODES.DISCONNECTED, 'connection closed');
      const reason = reasonBuf.toString('utf8');
      if (this.#conn === conn) this.#conn = null;
      this.#log.info({ connection: conn.id, code, reason, replaced: conn.replaced }, 'bridge disconnected');
      this.emit('disconnected', {
        connectionId: conn.id,
        remoteAddress: conn.remoteAddress,
        code,
        reason,
        replaced: conn.replaced,
      });
    });

    this.#log.info({ connection: conn.id, remote: remoteAddress }, 'bridge connected');
    this.emit('connected', { connectionId: conn.id, remoteAddress });
  }

  #onData(conn: Connection, data: RawData, isBinary: boolean): void {
    if (this.#conn !== conn) return; // a replaced connection's late frames are ignored
    if (isBinary) {
      this.#log.warn({ connection: conn.id }, 'ignoring binary frame from mod');
      return;
    }
    this.#stats.messagesIn++;
    const result = safeParseMessageText(rawToText(data));
    if (result.status === 'invalid') {
      this.#log.warn({ type: result.envelope?.t, error: result.error }, 'invalid message from mod');
      const env = result.envelope;
      if (env?.id !== undefined && env.t !== 'ok' && env.t !== 'err') {
        this.#reply(conn, env.id, { error: { code: ERROR_CODES.BAD_MESSAGE, msg: result.error } });
      }
      return;
    }
    if (result.status === 'unknown_type') {
      // Forward compatibility: unknown types are logged and ignored (a request still gets an answer).
      this.#log.debug({ type: result.envelope.t }, 'ignoring unknown message type');
      if (result.envelope.id !== undefined) {
        this.#reply(conn, result.envelope.id, {
          error: { code: ERROR_CODES.UNKNOWN_TYPE, msg: `unknown type ${result.envelope.t}` },
        });
      }
      return;
    }
    const message = result.message;
    if (message.t === 'ok' || message.t === 'err') {
      this.#settle(conn, message);
      return;
    }
    if (directionOf(message.t) === 'node_to_mod') {
      this.#log.warn({ type: message.t }, 'mod sent a node-to-mod message type');
      if (message.id !== undefined) {
        this.#reply(conn, message.id, {
          error: { code: ERROR_CODES.BAD_MESSAGE, msg: `${message.t} is not accepted from the mod` },
        });
      }
      return;
    }
    this.#dispatch(conn, message as MessageOf<IncomingType>);
  }

  #settle(conn: Connection, reply: MessageOf<'ok'> | MessageOf<'err'>): void {
    const pending = conn.pending.get(reply.re);
    if (!pending) {
      this.#log.debug({ re: reply.re, t: reply.t }, 'reply for unknown or expired request');
      return;
    }
    conn.pending.delete(reply.re);
    clearTimeout(pending.timer);
    if (reply.t === 'ok') pending.resolve(reply);
    else pending.reject(new BridgeError(reply.code, reply.msg));
  }

  #dispatch(conn: Connection, message: MessageOf<IncomingType>): void {
    const t = message.t;
    const hadListeners = this.listenerCount(t) > 0;
    this.emit('message', message);
    const args = [message] as unknown as BridgeEvents[IncomingType];
    this.emit(t, ...args);

    const handler = this.#handlers.get(t);
    const id = message.id;
    if (!handler) {
      if (id !== undefined && !hadListeners) {
        this.#reply(conn, id, { error: { code: ERROR_CODES.NOT_HANDLED, msg: `no handler for ${t}` } });
      }
      return;
    }
    Promise.resolve()
      .then(() => handler(message))
      .then(
        (result) => {
          if (id !== undefined) this.#reply(conn, id, { result: result ?? {} });
        },
        (err: unknown) => {
          const code = err instanceof BridgeError ? err.code : ERROR_CODES.INTERNAL;
          const msg = err instanceof Error ? err.message : String(err);
          if (!(err instanceof BridgeError)) this.#log.error({ err, type: t }, 'bridge handler failed');
          if (id !== undefined) this.#reply(conn, id, { error: { code, msg } });
        },
      );
  }

  #reply(
    conn: Connection,
    re: string,
    outcome: { result: Record<string, unknown> } | { error: { code: string; msg: string } },
  ): void {
    if (this.#conn !== conn) return;
    let text: string;
    try {
      text =
        'result' in outcome
          ? encodeMessage('ok', outcome.result, { re })
          : encodeMessage('err', { code: outcome.error.code, msg: outcome.error.msg.slice(0, 2000) }, { re });
    } catch (err) {
      const msg = err instanceof ProtocolError ? err.message : 'reply encoding failed';
      this.#log.error({ err, re }, 'bridge reply could not be encoded');
      text = encodeMessage('err', { code: ERROR_CODES.INTERNAL, msg: msg.slice(0, 2000) }, { re });
    }
    this.#sendText(text, 'reply');
  }

  #sendText(text: string, t: string): boolean {
    const conn = this.#conn;
    if (!conn || conn.ws.readyState !== WebSocket.OPEN) {
      this.#log.debug({ type: t }, 'not sent: mod not connected');
      return false;
    }
    conn.ws.send(text);
    this.#stats.messagesOut++;
    return true;
  }

  #failPending(conn: Connection, code: string, msg: string): void {
    for (const [id, pending] of conn.pending) {
      clearTimeout(pending.timer);
      pending.reject(new BridgeError(code, `${pending.t}: ${msg}`));
      conn.pending.delete(id);
    }
  }

  #closeSocket(conn: Connection, code: number, reason: string, graceMs: number): Promise<void> {
    const { ws } = conn;
    if (ws.readyState === WebSocket.CLOSED) return Promise.resolve();
    return new Promise((resolvePromise) => {
      const timer = setTimeout(() => {
        ws.terminate();
      }, graceMs);
      timer.unref();
      ws.once('close', () => {
        clearTimeout(timer);
        resolvePromise();
      });
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close(code, reason);
      }
    });
  }

  #beat(): void {
    const conn = this.#conn;
    if (!conn || conn.ws.readyState !== WebSocket.OPEN) return;
    if (conn.missedPongs >= MAX_MISSED_PONGS) {
      this.#log.warn({ connection: conn.id }, 'bridge peer missed heartbeats; dropping');
      void this.#closeSocket(conn, CLOSE_CODES.TIMEOUT, 'heartbeat timeout', 1000);
      return;
    }
    conn.missedPongs++;
    conn.ws.ping();
  }
}
