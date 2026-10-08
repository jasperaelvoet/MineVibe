import { readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  MESSAGE_TYPES,
  messageSchemas,
  ProtocolError,
  parseMessage,
  parseMessageText,
  safeParseMessage,
} from '../src/index.js';

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

function loadDir(dir: string): Array<{ file: string; stem: string; value: unknown }> {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((file) => ({
      file,
      stem: basename(file, '.json'),
      value: JSON.parse(readFileSync(join(dir, file), 'utf8')) as unknown,
    }));
}

const valid = loadDir(fixturesDir);
const invalid = loadDir(join(fixturesDir, 'invalid'));
const unknown = loadDir(join(fixturesDir, 'unknown'));

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
  it('exist', () => {
    expect(invalid.length).toBeGreaterThan(0);
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

describe('parseMessageText', () => {
  it('parses a text frame', () => {
    const text = readFileSync(join(fixturesDir, 'hello.json'), 'utf8');
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
