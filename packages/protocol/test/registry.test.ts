import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CHAT_MAX_LENGTH,
  createMessage,
  DebugStateResult,
  directionOf,
  encodeMessage,
  exceedsTextFrameLimit,
  isMessageType,
  MAX_TEXT_FRAME_BYTES,
  ProtocolError,
  parseMessageText,
  safeParseMessage,
  safeParseMessageText,
  utf8ByteLength,
} from '../src/index.js';

describe('createMessage / encodeMessage', () => {
  it('adds the envelope and validates the payload', () => {
    const msg = createMessage('ui.toast', { text: 'Hi', kind: 'info' }, { id: 'n-1' });
    expect(msg).toEqual({ t: 'ui.toast', v: 1, id: 'n-1', text: 'Hi', kind: 'info' });
  });

  it('rejects an invalid payload before it reaches the wire', () => {
    expect(() =>
      createMessage('world.open', {
        worldId: 'World 7',
        gen: 7,
        fresh: true,
        hardcore: true,
        difficulty: 'hard',
      }),
    ).toThrow(ProtocolError);
  });

  it('builds ok replies with arbitrary result keys', () => {
    const text = encodeMessage('ok', { echo: 'You → Ada: hi' }, { re: 'm-1' });
    expect(JSON.parse(text)).toEqual({ t: 'ok', v: 1, re: 'm-1', echo: 'You → Ada: hi' });
  });

  it('requires re on err replies', () => {
    expect(() => createMessage('err', { code: 'BAD_MESSAGE', msg: 'x' })).toThrow(ProtocolError);
    expect(createMessage('err', { code: 'BAD_MESSAGE', msg: 'x' }, { re: 'm-9' }).re).toBe('m-9');
  });

  it('rejects lowercase error codes', () => {
    expect(() => createMessage('err', { code: 'bad', msg: 'x' }, { re: 'm-9' })).toThrow(ProtocolError);
  });

  it('enforces the text frame limit on encode', () => {
    const big = 'x'.repeat(MAX_TEXT_FRAME_BYTES);
    expect(() => encodeMessage('ok', { blob: big }, { re: 'm-1' })).toThrow(
      expect.objectContaining({ code: 'TOO_LARGE' }),
    );
  });
});

describe('safeParseMessage', () => {
  it('keeps the envelope of an invalid request so it can be answered', () => {
    const result = safeParseMessage({ t: 'chat.send', v: 1, id: 'm-5', to: 'all', text: '' });
    expect(result.status).toBe('invalid');
    if (result.status === 'invalid') {
      expect(result.envelope?.id).toBe('m-5');
      expect(result.error).toMatch(/text/);
    }
  });

  it('rejects ids with spaces', () => {
    expect(
      safeParseMessage({ t: 'hello', v: 1, id: 'a b', mod: '1', mc: '26.3', phase: 'boot' }).status,
    ).toBe('invalid');
  });

  it('rejects non-objects', () => {
    for (const value of [null, 42, 'hello', [], true]) {
      expect(safeParseMessage(value).status).toBe('invalid');
    }
  });

  it('accepts chat.send at the max length and rejects one char more', () => {
    const ok = { t: 'chat.send', v: 1, id: 'm-1', to: 'all', text: 'a'.repeat(CHAT_MAX_LENGTH) };
    expect(safeParseMessage(ok).status).toBe('ok');
    expect(safeParseMessage({ ...ok, text: `${ok.text}a` }).status).toBe('invalid');
  });

  it('strips unknown payload keys of known types (forward compatible)', () => {
    const result = safeParseMessage({ t: 'client.stopping', v: 1, futureField: 1 });
    expect(result.status).toBe('ok');
    if (result.status === 'ok') expect(result.message).toEqual({ t: 'client.stopping', v: 1 });
  });
});

describe('safeParseMessageText', () => {
  it('reports invalid JSON', () => {
    expect(safeParseMessageText('not json')).toMatchObject({ status: 'invalid', error: 'not valid JSON' });
  });

  it('rejects oversize frames before parsing', () => {
    const text = JSON.stringify({ t: 'ok', v: 1, re: 'x', blob: 'é'.repeat(MAX_TEXT_FRAME_BYTES / 2) });
    expect(exceedsTextFrameLimit(text)).toBe(true);
    expect(safeParseMessageText(text).status).toBe('invalid');
    expect(() => parseMessageText(text)).toThrow(expect.objectContaining({ code: 'TOO_LARGE' }));
  });
});

describe('utf8ByteLength', () => {
  it.each(['', 'ascii', 'héllo', '€uro', '日本語', '🙂 emoji', '\ud800 lone', 'tail \udc00'])(
    'matches TextEncoder for %j',
    (s) => {
      expect(utf8ByteLength(s)).toBe(new TextEncoder().encode(s).byteLength);
    },
  );
});

describe('catalog helpers', () => {
  it('knows directions', () => {
    expect(directionOf('hello')).toBe('mod_to_node');
    expect(directionOf('hello.ok')).toBe('node_to_mod');
    expect(directionOf('ok')).toBe('both');
  });

  it('isMessageType', () => {
    expect(isMessageType('world.open')).toBe(true);
    expect(isMessageType('world.close')).toBe(false);
    expect(isMessageType(7)).toBe(false);
    expect(isMessageType('__proto__')).toBe(false);
  });
});

describe('debug messages (E2E)', () => {
  const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

  it('are requests from Node to the mod', () => {
    for (const t of ['debug.state', 'debug.kill_player', 'debug.open_menu', 'debug.click_begin'] as const) {
      expect(directionOf(t)).toBe('node_to_mod');
      expect(createMessage(t, {}, { id: 'n-1' })).toEqual({ t, v: 1, id: 'n-1' });
    }
  });

  it('DebugStateResult parses the payload of ok--debug-state.json', () => {
    const {
      t: _t,
      v: _v,
      re: _re,
      ...payload
    } = JSON.parse(readFileSync(join(fixturesDir, 'reply', 'ok--debug-state.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    const parsed = DebugStateResult.parse(payload);
    expect(parsed.screen).toBe('MineVibeMenuScreen');
    expect(parsed.paused).toBe(false);
  });

  it('DebugStateResult takes the optional crew and monitor snapshot, nested nulls dropped or kept', () => {
    const base = {
      screen: null,
      worldId: 'world-1',
      gen: 1,
      inWorld: true,
      hardcore: true,
      difficulty: 'hard',
      gameMode: 'survival',
      allowCommands: false,
      paused: false,
      serverTicks: 10,
      serverPaused: false,
      hp: 20,
      dead: false,
      pid: 1,
      player: { x: 1.5, y: 64, z: -3 },
    };
    const agent = {
      agentId: 'ada1f3c',
      handle: 'ada',
      status: 'alive',
      brain: 'idle',
      headIcon: 'NONE',
      cards: 0,
    };
    const parsed = DebugStateResult.parse({
      ...base,
      // The mod's reply encoder drops nested nulls: bubble, pos, ageMs and hash may be absent.
      agents: [
        agent,
        { ...agent, agentId: 'bram2b4d', bubble: 'hi', pos: { x: 0, y: 64, z: 0 }, atPc: true },
      ].map((a) => ({ atPc: false, ...a })),
      monitors: [{ pcId: 'linux-1', w: 0, h: 0, seq: -1, patches: 0 }],
    });
    expect(parsed.agents?.[0]?.bubble ?? null).toBeNull();
    expect(parsed.agents?.[1]).toMatchObject({ bubble: 'hi', atPc: true });
    expect(parsed.monitors?.[0]?.hash ?? null).toBeNull();
  });

  it('DebugStateResult accepts a BootScreen snapshot with no world', () => {
    expect(
      DebugStateResult.safeParse({
        screen: 'BootScreen',
        worldId: null,
        gen: null,
        inWorld: false,
        hardcore: null,
        difficulty: null,
        gameMode: null,
        allowCommands: null,
        paused: false,
        serverTicks: null,
        serverPaused: null,
        hp: null,
        dead: null,
        pid: 1,
      }).success,
    ).toBe(true);
  });
});
