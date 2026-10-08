import { randomBytes } from 'node:crypto';
import type { Readable } from 'node:stream';
import { TypedEmitter } from '../util/TypedEmitter.js';
import { encodeLine, MAX_STUB_LINE, type NodeToStub, parseStubLine, type StubHello } from './stubProtocol.js';

/** Writes one line; calls `done` once it is flushed (or failed). */
export type LineWriter = (line: string, done: (err?: Error | null) => void) => void;

export type StubChannelEvents = {
  hello: [hello: StubHello];
  /** The stub asked for a clean shutdown (quit, logout, SIGTERM, the window's Quit button). */
  shutdown: [reason: string];
  /** stdin closed: the stub is gone (the lifeline, PLAN §9.2). */
  eof: [];
  /** A line that is not a known stub command (ignored). */
  invalid: [line: string];
};

export interface PickFolderOptions {
  readonly title?: string;
  readonly message?: string;
  readonly prompt?: string;
  readonly startIn?: string;
  /** Default 10 minutes; the answer is then null. */
  readonly timeoutMs?: number;
}

/** Native host dialogs, answered by the stub (null outside MineVibe.app). */
export interface HostDialogs {
  /** The macOS folder picker (for a Vault folder). Resolves the absolute path, or null when cancelled. */
  pickFolder(options?: PickFolderOptions): Promise<string | null>;
}

/**
 * Node's end of the stub channel: parses NDJSON commands from `input` and writes events with `write`. Everything
 * that is not a valid command is ignored, never fatal; EOF is reported once.
 */
export class StubChannel extends TypedEmitter<StubChannelEvents> implements HostDialogs {
  readonly #write: LineWriter;
  readonly #input: Readable;
  readonly #pending = new Map<string, { resolve: (path: string | null) => void; timer: NodeJS.Timeout }>();
  #buffer = '';
  #hello: StubHello | null = null;
  #ended = false;
  #closed = false;

  constructor(input: Readable, write: LineWriter) {
    super();
    this.#input = input;
    this.#write = write;
    input.setEncoding('utf8');
    input.on('data', this.#onData);
    input.on('end', this.#onEnd);
    input.on('close', this.#onEnd);
    input.on('error', this.#onEnd);
  }

  /** The stub's hello, once it arrived. */
  get stubHello(): StubHello | null {
    return this.#hello;
  }

  /** True once stdin reached EOF (or failed). */
  get ended(): boolean {
    return this.#ended;
  }

  /** Sends one event; resolves when it is flushed. Never rejects (a gone stub is not an error here). */
  send(message: NodeToStub): Promise<void> {
    if (this.#closed) return Promise.resolve();
    return new Promise((resolvePromise) => {
      try {
        this.#write(encodeLine(message), () => resolvePromise());
      } catch {
        resolvePromise();
      }
    });
  }

  /** Resolves with the stub's hello, or rejects after `timeoutMs` or at EOF. */
  waitForHello(timeoutMs: number): Promise<StubHello> {
    if (this.#hello) return Promise.resolve(this.#hello);
    return new Promise((resolvePromise, reject) => {
      const done = () => {
        clearTimeout(timer);
        offHello();
        offEof();
      };
      const timer = setTimeout(() => {
        done();
        reject(new Error(`no hello from the stub within ${timeoutMs} ms`));
      }, timeoutMs);
      const offHello = this.once('hello', (hello) => {
        done();
        resolvePromise(hello);
      });
      const offEof = this.once('eof', () => {
        done();
        reject(new Error('the stub closed the channel before its hello'));
      });
    });
  }

  async pickFolder(options: PickFolderOptions = {}): Promise<string | null> {
    if (this.#ended || this.#closed) return null;
    const id = randomBytes(6).toString('hex');
    const result = new Promise<string | null>((resolvePromise) => {
      const timer = setTimeout(() => this.#settle(id, null), options.timeoutMs ?? 10 * 60_000);
      timer.unref();
      this.#pending.set(id, { resolve: resolvePromise, timer });
    });
    await this.send({
      t: 'pickFolder',
      id,
      ...(options.title !== undefined ? { title: options.title } : {}),
      ...(options.message !== undefined ? { message: options.message } : {}),
      ...(options.prompt !== undefined ? { prompt: options.prompt } : {}),
      ...(options.startIn !== undefined ? { startIn: options.startIn } : {}),
    });
    return result;
  }

  /** Stops reading and answers open folder requests with null. Further sends are dropped. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#input.off('data', this.#onData);
    for (const id of [...this.#pending.keys()]) this.#settle(id, null);
  }

  #settle(id: string, path: string | null): void {
    const pending = this.#pending.get(id);
    if (!pending) return;
    this.#pending.delete(id);
    clearTimeout(pending.timer);
    pending.resolve(path);
  }

  readonly #onData = (chunk: string | Buffer) => {
    this.#buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    let newline = this.#buffer.indexOf('\n');
    while (newline !== -1) {
      const line = this.#buffer.slice(0, newline);
      this.#buffer = this.#buffer.slice(newline + 1);
      this.#handleLine(line);
      newline = this.#buffer.indexOf('\n');
    }
    if (this.#buffer.length > MAX_STUB_LINE) {
      this.emit('invalid', `${this.#buffer.slice(0, 80)}…`);
      this.#buffer = '';
    }
  };

  #handleLine(line: string): void {
    if (line.trim() === '') return;
    const cmd = parseStubLine(line);
    if (!cmd) {
      this.emit('invalid', line.slice(0, 200));
      return;
    }
    switch (cmd.cmd) {
      case 'hello':
        this.#hello = cmd;
        this.emit('hello', cmd);
        break;
      case 'shutdown':
        this.emit('shutdown', cmd.reason);
        break;
      case 'pickFolder.result':
        this.#settle(cmd.id, cmd.path);
        break;
    }
  }

  readonly #onEnd = () => {
    if (this.#ended) return;
    this.#ended = true;
    for (const id of [...this.#pending.keys()]) this.#settle(id, null);
    this.emit('eof');
  };
}
