import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { LineWriter } from '../../src/app/StubChannel.js';
import { StubChannel } from '../../src/app/StubChannel.js';
import { encodeLine, MAX_PICKED_PATH, type NodeToStub, parseStubLine } from '../../src/app/stubProtocol.js';

function harness() {
  const input = new PassThrough();
  const lines: NodeToStub[] = [];
  const write: LineWriter = (line, done) => {
    expect(line.endsWith('\n')).toBe(true);
    expect(line.slice(0, -1)).not.toContain('\n');
    lines.push(JSON.parse(line) as NodeToStub);
    queueMicrotask(() => done());
  };
  const channel = new StubChannel(input, write);
  return { input, lines, channel };
}

const tick = () => new Promise((r) => setTimeout(r, 5));

describe('stub protocol lines', () => {
  it('parses the three stub commands', () => {
    expect(parseStubLine('{"cmd":"hello","v":1,"stub":"0.1.0","pid":42}')).toEqual({
      cmd: 'hello',
      v: 1,
      stub: '0.1.0',
      pid: 42,
    });
    expect(parseStubLine('{"cmd":"shutdown","reason":"sigterm"}')).toEqual({
      cmd: 'shutdown',
      reason: 'sigterm',
    });
    expect(parseStubLine('{"cmd":"shutdown"}')).toEqual({ cmd: 'shutdown', reason: 'quit' });
    expect(parseStubLine('{"cmd":"pickFolder.result","id":"a1","path":"/Users/me/Code"}')).toEqual({
      cmd: 'pickFolder.result',
      id: 'a1',
      path: '/Users/me/Code',
    });
  });

  it('rejects junk, unknown commands and oversized lines', () => {
    for (const line of [
      '',
      '   ',
      'hello',
      '{"cmd":"rm -rf"}',
      '[1,2]',
      '{"t":"hello"}',
      `"${'x'.repeat(70_000)}"`,
    ]) {
      expect(parseStubLine(line)).toBeNull();
    }
    expect(parseStubLine('{"cmd":"hello","v":1,"stub":"x","pid":-1}')).toBeNull();
  });

  it('turns a relative, NUL-carrying or over-long picked path into "nothing picked"', () => {
    expect(parseStubLine('{"cmd":"pickFolder.result","id":"a","path":"Code"}')).toMatchObject({ path: null });
    expect(parseStubLine('{"cmd":"pickFolder.result","id":"a","path":"/a\\u0000b"}')).toMatchObject({
      path: null,
    });
    // host.pick_folder's PickFolderResult (T0) caps the path at 1024 characters.
    const long = `/${'a'.repeat(MAX_PICKED_PATH)}`;
    expect(parseStubLine(JSON.stringify({ cmd: 'pickFolder.result', id: 'a', path: long }))).toMatchObject({
      path: null,
    });
    const fits = `/${'a'.repeat(MAX_PICKED_PATH - 1)}`;
    expect(parseStubLine(JSON.stringify({ cmd: 'pickFolder.result', id: 'a', path: fits }))).toMatchObject({
      path: fits,
    });
  });

  it('encodes one JSON object per line, newlines escaped', () => {
    const line = encodeLine({ t: 'error', message: 'two\nlines' });
    expect(line).toBe('{"t":"error","message":"two\\nlines"}\n');
  });
});

describe('StubChannel', () => {
  it('reassembles commands split across chunks and several per chunk', async () => {
    const { input, channel } = harness();
    const reasons: string[] = [];
    channel.on('shutdown', (r) => {
      reasons.push(r);
    });
    input.write('{"cmd":"hello","v":1,"stub":"t","pi');
    input.write('d":7}\n{"cmd":"shutdown","reason":"a"}\n{"cmd":"shut');
    input.write('down","reason":"b"}\n');
    await tick();
    expect(channel.stubHello).toMatchObject({ stub: 't', pid: 7 });
    expect(reasons).toEqual(['a', 'b']);
  });

  it('reports invalid lines without failing', async () => {
    const { input, channel } = harness();
    const invalid: string[] = [];
    channel.on('invalid', (l) => {
      invalid.push(l);
    });
    input.write('not json\n{"cmd":"nope"}\n\n');
    await tick();
    expect(invalid).toEqual(['not json', '{"cmd":"nope"}']);
  });

  it('drops a runaway line instead of buffering it forever', async () => {
    const { input, channel } = harness();
    const invalid: string[] = [];
    channel.on('invalid', (l) => {
      invalid.push(l);
    });
    const reasons: string[] = [];
    channel.on('shutdown', (r) => {
      reasons.push(r);
    });
    input.write('x'.repeat(70_000));
    input.write('\n{"cmd":"shutdown"}\n');
    await tick();
    expect(invalid.length).toBeGreaterThanOrEqual(1);
    expect(reasons).toEqual(['quit']);
  });

  it('emits eof once when stdin ends (the lifeline)', async () => {
    const { input, channel } = harness();
    let eofs = 0;
    channel.on('eof', () => {
      eofs++;
    });
    input.end();
    await tick();
    input.destroy();
    await tick();
    expect(eofs).toBe(1);
    expect(channel.ended).toBe(true);
  });

  it('round-trips a folder pick by id', async () => {
    const { input, lines, channel } = harness();
    const picked = channel.pickFolder({ title: 'Add a Vault folder', startIn: '/Users/me' });
    await tick();
    const request = lines.at(-1);
    expect(request).toMatchObject({ t: 'pickFolder', title: 'Add a Vault folder', startIn: '/Users/me' });
    const id = (request as { id: string }).id;
    input.write(`${JSON.stringify({ cmd: 'pickFolder.result', id: 'other', path: '/nope' })}\n`);
    input.write(`${JSON.stringify({ cmd: 'pickFolder.result', id, path: '/Users/me/Code' })}\n`);
    await expect(picked).resolves.toBe('/Users/me/Code');
  });

  it('answers null for a cancelled pick, a timeout and a closed channel', async () => {
    const { input, lines, channel } = harness();
    const cancelled = channel.pickFolder();
    await tick();
    const id = (lines.at(-1) as { id: string }).id;
    input.write(`${JSON.stringify({ cmd: 'pickFolder.result', id, path: null })}\n`);
    await expect(cancelled).resolves.toBeNull();

    await expect(channel.pickFolder({ timeoutMs: 10 })).resolves.toBeNull();

    const open = channel.pickFolder();
    await tick();
    input.end();
    await expect(open).resolves.toBeNull();
    await expect(channel.pickFolder()).resolves.toBeNull();
  });

  it('waits for the hello, or fails on timeout and on EOF', async () => {
    const a = harness();
    const hello = a.channel.waitForHello(1000);
    a.input.write('{"cmd":"hello","v":1,"stub":"s","pid":1}\n');
    await expect(hello).resolves.toMatchObject({ stub: 's' });
    await expect(a.channel.waitForHello(1)).resolves.toMatchObject({ stub: 's' });

    const b = harness();
    await expect(b.channel.waitForHello(10)).rejects.toThrow(/no hello/);
    const c = harness();
    const pending = c.channel.waitForHello(1000);
    c.input.end();
    await expect(pending).rejects.toThrow(/closed/);
  });

  it('never rejects a send, even when the writer throws or the channel is closed', async () => {
    const input = new PassThrough();
    const channel = new StubChannel(input, () => {
      throw new Error('EPIPE');
    });
    await expect(channel.send({ t: 'ready' })).resolves.toBeUndefined();
    channel.close();
    await expect(channel.send({ t: 'ready' })).resolves.toBeUndefined();
  });
});
