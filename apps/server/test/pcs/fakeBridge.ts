import { createMessage, type MessageOf, type OkReply, type PayloadOf } from '@minevibe/protocol';
import {
  BridgeError,
  type BridgeEvents,
  type IncomingType,
  type OutgoingType,
  type RequestHandler,
} from '../../src/bridge/BridgeServer.js';
import { TypedEmitter } from '../../src/util/TypedEmitter.js';

/**
 * The parts of BridgeServer the PC glue uses (`on`, `handle`, `send`, `request`, `sendFrame`), in memory. Every
 * pushed payload and request is validated against its schema, so a mapping bug fails the test.
 */
export class FakePcBridge extends TypedEmitter<BridgeEvents> {
  readonly handlers = new Map<string, RequestHandler<IncomingType>>();
  readonly sent: { t: OutgoingType; payload: Record<string, unknown> }[] = [];
  readonly requests: { t: OutgoingType; payload: Record<string, unknown> }[] = [];
  readonly frames: Uint8Array[] = [];
  connected = true;
  requestReply: (
    t: OutgoingType,
    payload: Record<string, unknown>,
  ) => Record<string, unknown> | { error: string } = () => ({});
  #seq = 0;

  handle<K extends IncomingType>(t: K, handler: RequestHandler<K>): () => void {
    if (this.handlers.has(t)) throw new Error(`handler for ${t} already registered`);
    this.handlers.set(t, handler as unknown as RequestHandler<IncomingType>);
    return () => this.handlers.delete(t);
  }

  send<K extends OutgoingType>(t: K, payload: PayloadOf<K>): boolean {
    createMessage(t, payload);
    if (!this.connected) return false;
    this.sent.push({ t, payload: payload as Record<string, unknown> });
    return true;
  }

  request<K extends OutgoingType>(t: K, payload: PayloadOf<K>): Promise<OkReply> {
    createMessage(t, payload, { id: 'n-1' });
    this.requests.push({ t, payload: payload as Record<string, unknown> });
    const reply = this.requestReply(t, payload as Record<string, unknown>);
    if ('error' in reply && typeof reply.error === 'string') {
      return Promise.reject(new BridgeError(reply.error, `${t} failed`));
    }
    return Promise.resolve({ t: 'ok', v: 1, re: 'n-1', ...reply } as OkReply);
  }

  sendFrame(frame: Uint8Array): boolean {
    if (!this.connected) return false;
    this.frames.push(frame);
    return true;
  }

  /** An incoming message from the mod (listeners only). */
  fire<K extends IncomingType>(t: K, payload: PayloadOf<K>): void {
    const message = createMessage(t, payload) as MessageOf<K>;
    const args = [message] as unknown as BridgeEvents[K];
    this.emit(t, ...args);
  }

  disconnect(): void {
    this.emit('disconnected', {
      connectionId: 1,
      remoteAddress: '127.0.0.1',
      code: 1000,
      reason: '',
      replaced: false,
    });
  }

  /** Calls the registered request handler like the bridge would; rejects with the handler's error. */
  async call<K extends IncomingType>(t: K, payload: PayloadOf<K>): Promise<Record<string, unknown>> {
    const handler = this.handlers.get(t);
    if (!handler) throw new Error(`no handler for ${t}`);
    const message = createMessage(t, payload, { id: `m-${++this.#seq}` }) as MessageOf<IncomingType>;
    return ((await handler(message)) ?? {}) as Record<string, unknown>;
  }

  pushed<K extends OutgoingType>(t: K): PayloadOf<K>[] {
    return this.sent.filter((s) => s.t === t).map((s) => s.payload as PayloadOf<K>);
  }

  clear(): void {
    this.sent.length = 0;
    this.requests.length = 0;
  }
}
