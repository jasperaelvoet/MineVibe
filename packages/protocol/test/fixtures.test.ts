import { readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  groupOf,
  isMessageType,
  MESSAGE_TYPES,
  type MessageType,
  messageSchemas,
  ProtocolError,
  parseMessage,
  parseMessageText,
  replySchemaOf,
  safeParseMessage,
} from '../src/index.js';

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

interface Fixture {
  /** Path relative to fixtures/, e.g. `world/hello.json`. */
  file: string;
  stem: string;
  /** Directory components between fixtures/ and the file. */
  dirs: string[];
  value: unknown;
}

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return walk(path);
    return entry.name.endsWith('.json') ? [path] : [];
  });
}

const all: Fixture[] = walk(fixturesDir)
  .sort()
  .map((path) => {
    const file = relative(fixturesDir, path);
    return {
      file,
      stem: basename(path, '.json'),
      dirs: dirname(file).split(sep),
      value: JSON.parse(readFileSync(path, 'utf8')) as unknown,
    };
  });

/** `<group>/<type>[--variant].json` are valid; `<group>/invalid/*.json` invalid; `unknown/*.json` unknown types. */
const valid = all.filter((f) => !f.dirs.includes('invalid') && !f.dirs.includes('unknown'));
const invalid = all.filter((f) => f.dirs.includes('invalid'));
const unknown = all.filter((f) => f.dirs.includes('unknown'));

/** `<type>.json` or `<type>--<variant>.json`. */
function typeFromStem(stem: string): string {
  const i = stem.indexOf('--');
  return i === -1 ? stem : stem.slice(0, i);
}

describe('valid fixtures', () => {
  it('exist', () => {
    expect(valid.length).toBeGreaterThan(0);
  });

  it.each(valid)('$file parses under its schema', ({ stem, value }) => {
    const result = safeParseMessage(value);
    if (result.status !== 'ok') throw new Error(`${stem}: ${JSON.stringify(result)}`);
    expect(result.message.t).toBe(typeFromStem(stem));
    expect(parseMessage(value)).toEqual(result.message);
  });

  it.each(valid)('$file round-trips through JSON without losing fields', ({ value }) => {
    const parsed = parseMessage(value);
    expect(parsed).not.toBeNull();
    expect(JSON.parse(JSON.stringify(parsed))).toEqual(value);
  });

  it.each(valid)('$file sits in its group directory', ({ stem, dirs }) => {
    const t = typeFromStem(stem);
    expect(isMessageType(t)).toBe(true);
    expect(dirs).toEqual([groupOf(t as MessageType)]);
  });

  it('cover every registered message type', () => {
    const covered = new Set(valid.map((f) => typeFromStem(f.stem)));
    const missing = MESSAGE_TYPES.filter((t) => !covered.has(t));
    expect(missing).toEqual([]);
  });

  it('only name registered types', () => {
    const known = new Set<string>(MESSAGE_TYPES);
    expect(valid.map((f) => typeFromStem(f.stem)).filter((t) => !known.has(t))).toEqual([]);
  });

  it('registry maps each type to its schema', () => {
    for (const t of MESSAGE_TYPES) {
      expect(messageSchemas[t]).toBeDefined();
    }
  });
});

describe('invalid fixtures', () => {
  it('exist for every group', () => {
    const groups = new Set(MESSAGE_TYPES.map((t) => groupOf(t)));
    groups.delete('debug'); // debug messages have no payload worth breaking
    const withInvalid = new Set(invalid.map((f) => f.dirs[0]));
    expect([...groups].filter((g) => !withInvalid.has(g))).toEqual([]);
  });

  it.each(invalid)('$file is rejected', ({ value }) => {
    const result = safeParseMessage(value);
    expect(result.status).toBe('invalid');
    expect(() => parseMessage(value)).toThrow(ProtocolError);
  });
});

describe('unknown-type fixtures', () => {
  it.each(unknown)('$file is ignored (null), not thrown', ({ value }) => {
    expect(safeParseMessage(value).status).toBe('unknown_type');
    expect(parseMessage(value)).toBeNull();
  });
});

describe('reply fixtures', () => {
  /** `reply/ok--<slug>.json` -> the request type whose `ok` result it shows. */
  const okFixtures: Record<string, MessageType> = {
    'ok--skill-run': 'skill.run',
    'ok--skill-run-replaced': 'skill.run',
    'ok--agent-spawn': 'agent.spawn',
    'ok--codex-search': 'codex.search',
    'ok--meeting-start': 'meeting.start',
    'ok--pick-folder': 'host.pick_folder',
    'ok--debug-state': 'debug.state',
    'ok--debug-state-crew': 'debug.state',
    ok: 'chat.send',
  };

  it.each(Object.entries(okFixtures))('%s matches the reply schema of %s', (stem, request) => {
    const {
      t: _t,
      v: _v,
      re: _re,
      ...result
    } = JSON.parse(readFileSync(join(fixturesDir, 'reply', `${stem}.json`), 'utf8')) as Record<
      string,
      unknown
    >;
    const schema = replySchemaOf(request);
    expect(schema).not.toBeNull();
    const parsed = schema?.safeParse(result);
    if (!parsed?.success) throw new Error(`${stem}: ${JSON.stringify(parsed?.error.issues)}`);
    expect(parsed.data).toEqual(result);
  });
});

describe('parseMessageText', () => {
  it('parses a text frame', () => {
    const text = readFileSync(join(fixturesDir, 'world', 'hello.json'), 'utf8');
    expect(parseMessageText(text)?.t).toBe('hello');
  });

  it('throws BAD_JSON on garbage', () => {
    expect(() => parseMessageText('{nope')).toThrow(expect.objectContaining({ code: 'BAD_JSON' }));
  });

  it('returns null for an unknown type', () => {
    expect(parseMessageText('{"t":"later.feature","v":1}')).toBeNull();
  });

  it('does not treat prototype keys as message types', () => {
    expect(parseMessage({ t: 'constructor', v: 1 })).toBeNull();
    expect(parseMessage({ t: 'tostring', v: 1 })).toBeNull();
  });
});
