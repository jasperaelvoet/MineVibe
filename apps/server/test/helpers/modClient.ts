import { SUBPROTOCOL } from '@minevibe/protocol';
import WebSocket from 'ws';

export interface Received {
  t: string;
  [key: string]: unknown;
}

/** A minimal fake mod: connects like BridgeClient and records what Node sends. */
export class ModClient {
  readonly ws: WebSocket;
  readonly messages: Received[] = [];
  readonly binary: Buffer[] = [];
  #waiters: Array<{ match: (m: Received) => boolean; resolve: (m: Received) => void }> = [];

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        this.binary.push(data as Buffer);
        return;
      }
      const msg = JSON.parse(String(data)) as Received;
      this.messages.push(msg);
      for (const w of [...this.#waiters]) {
        if (w.match(msg)) {
          this.#waiters.splice(this.#waiters.indexOf(w), 1);
          w.resolve(msg);
        }
      }
    });
  }

  /** Connects with the given token and headers; rejects with the HTTP status on refusal. */
  static connect(
    port: number,
    token: string | null,
    options: { path?: string; protocols?: string[]; headers?: Record<string, string>; host?: string } = {},
  ): Promise<ModClient> {
    const headers: Record<string, string> = { ...(options.headers ?? {}) };
    if (token !== null) headers.Authorization = `Bearer ${token}`;
    const ws = new WebSocket(
      `ws://${options.host ?? '127.0.0.1'}:${port}${options.path ?? '/v1'}`,
      options.protocols ?? [SUBPROTOCOL],
      { headers },
    );
    return new Promise((resolve, reject) => {
      ws.once('open', () => resolve(new ModClient(ws)));
      ws.once('unexpected-response', (_req, res) => {
        reject(Object.assign(new Error(`HTTP ${res.statusCode}`), { status: res.statusCode }));
        ws.terminate();
      });
      ws.once('error', reject);
    });
  }

  send(msg: Record<string, unknown>): void {
    this.ws.send(JSON.stringify(msg));
  }

  /** Resolves with the first already-received or future message matching `t` (and `pred`). */
  next(t: string, pred: (m: Received) => boolean = () => true, timeoutMs = 2000): Promise<Received> {
    const match = (m: Received) => m.t === t && pred(m);
    const seen = this.messages.find(match);
    if (seen) {
      this.messages.splice(this.messages.indexOf(seen), 1);
      return Promise.resolve(seen);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for ${t}`)), timeoutMs);
      this.#waiters.push({
        match,
        resolve: (m) => {
          clearTimeout(timer);
          this.messages.splice(this.messages.indexOf(m), 1);
          resolve(m);
        },
      });
    });
  }

  closed(): Promise<{ code: number; reason: string }> {
    if (this.ws.readyState === WebSocket.CLOSED) return Promise.resolve({ code: 0, reason: '' });
    return new Promise((resolve) => {
      this.ws.once('close', (code, reason) => resolve({ code, reason: reason.toString() }));
    });
  }

  close(): Promise<{ code: number; reason: string }> {
    const done = this.closed();
    this.ws.close(1000);
    return done;
  }
}
