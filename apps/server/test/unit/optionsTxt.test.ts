import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_OPTIONS,
  FORCED_OPTIONS,
  mergeOptionsTxt,
  seedOptionsTxt,
} from '../../src/launcher/optionsTxt.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const parse = (text: string) =>
  Object.fromEntries(
    text
      .split(/\r?\n/)
      .filter((l) => l.includes(':'))
      .map((l) => [l.slice(0, l.indexOf(':')), l.slice(l.indexOf(':') + 1)]),
  );

describe('FORCED_OPTIONS', () => {
  it('forces the OpenGL backend and no pause on focus loss, in 26.3 options.txt syntax', () => {
    expect(FORCED_OPTIONS.preferredGraphicsBackend).toBe('"opengl"');
    expect(FORCED_OPTIONS.pauseOnLostFocus).toBe('false');
    expect(FORCED_OPTIONS.onboardAccessibility).toBe('false');
    expect(FORCED_OPTIONS.tutorialStep).toBe('none');
  });
});

describe('mergeOptionsTxt', () => {
  it('creates a new file stamped with the data version so datafixers leave it alone', () => {
    const { text, changed } = mergeOptionsTxt(null, { dataVersion: 4790 });
    const lines = text.trimEnd().split('\n');
    expect(lines[0]).toBe('version:4790');
    expect(parse(text)).toEqual({ version: '4790', ...FORCED_OPTIONS, ...DEFAULT_OPTIONS });
    expect(changed).toEqual([...Object.keys(FORCED_OPTIONS), ...Object.keys(DEFAULT_OPTIONS)]);
    expect(text.endsWith('\n')).toBe(true);
  });

  it('omits the version line when the data version is unknown', () => {
    expect(mergeOptionsTxt(null).text.startsWith('pauseOnLostFocus:false\n')).toBe(true);
  });

  it('never clobbers other user values and keeps order, unknown and malformed lines', () => {
    const existing = [
      'version:4790',
      'fov:0.25',
      'pauseOnLostFocus:true',
      'garbage line without colon',
      'lastServer:host:25565',
      'autoJump:true',
      'narrator:2',
      'preferredGraphicsBackend:"vulkan"',
      'key_key.chat:key.keyboard.t',
      'resourcePacks:["vanilla","file/x.zip"]',
    ].join('\n');
    const { text, changed } = mergeOptionsTxt(`${existing}\n`, { dataVersion: 9999 });
    const lines = text.trimEnd().split('\n');
    expect(lines.slice(0, 10)).toEqual([
      'version:4790',
      'fov:0.25',
      'pauseOnLostFocus:false',
      'garbage line without colon',
      'lastServer:host:25565',
      'autoJump:true',
      'narrator:2',
      'preferredGraphicsBackend:"opengl"',
      'key_key.chat:key.keyboard.t',
      'resourcePacks:["vanilla","file/x.zip"]',
    ]);
    // Defaults the player already set stay; missing forced keys are appended.
    expect(parse(text).autoJump).toBe('true');
    expect(parse(text).narrator).toBe('2');
    expect(changed).toContain('pauseOnLostFocus');
    expect(changed).toContain('preferredGraphicsBackend');
    expect(changed).not.toContain('autoJump');
    expect(lines.slice(10)).toEqual([
      'onboardAccessibility:false',
      'tutorialStep:none',
      'skipMultiplayerWarning:true',
      'joinedFirstServer:true',
      'realmsNotifications:false',
    ]);
  });

  it('is idempotent', () => {
    const once = mergeOptionsTxt('fov:0.5\n', { dataVersion: 1 }).text;
    const twice = mergeOptionsTxt(once, { dataVersion: 1 });
    expect(twice.text).toBe(once);
    expect(twice.changed).toEqual([]);
  });

  it('keeps CRLF line endings and touches only the first occurrence of a duplicated key', () => {
    const { text } = mergeOptionsTxt('pauseOnLostFocus:true\r\npauseOnLostFocus:true\r\n');
    expect(text.startsWith('pauseOnLostFocus:false\r\npauseOnLostFocus:true\r\n')).toBe(true);
    expect(text.includes('\n') && !/[^\r]\n/.test(text)).toBe(true);
  });
});

describe('seedOptionsTxt', () => {
  it('reads the data version lazily, only for a new file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mv-options-'));
    dirs.push(dir);
    let calls = 0;
    const dataVersion = async () => {
      calls++;
      return 5023;
    };
    await seedOptionsTxt(dir, { dataVersion });
    expect(readFileSync(join(dir, 'options.txt'), 'utf8').startsWith('version:5023\n')).toBe(true);
    await seedOptionsTxt(dir, { dataVersion });
    expect(calls).toBe(1);
  });

  it('writes only when something changed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mv-options-'));
    dirs.push(dir);
    const first = await seedOptionsTxt(dir, { dataVersion: 4790 });
    expect(first.written).toBe(true);
    const second = await seedOptionsTxt(dir, { dataVersion: 4790 });
    expect(second.written).toBe(false);
    writeFileSync(join(dir, 'options.txt'), `${readFileSync(join(dir, 'options.txt'), 'utf8')}fov:1.0\n`);
    expect((await seedOptionsTxt(dir)).written).toBe(false);
    expect(readFileSync(join(dir, 'options.txt'), 'utf8')).toContain('fov:1.0\n');
  });
});
