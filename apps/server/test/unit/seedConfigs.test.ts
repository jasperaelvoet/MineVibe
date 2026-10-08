import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { fillMissing, seedConfigs, seedJsonConfig } from '../../src/launcher/seedConfigs.js';

const SEED_DIR = fileURLToPath(new URL('../../../../packaging/seed-configs', import.meta.url));

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'mv-seed-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const readJson = (p: string) => JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>;

describe('fillMissing', () => {
  it('adds missing keys at any depth and lets existing values win', () => {
    const { merged, added } = fillMissing(
      { idle: { timeout: 600 }, states: { unfocused: { frame_rate_target: 5 } }, list: [1] },
      {
        idle: { timeout: 0, condition: 'none' },
        states: { unfocused: { frame_rate_target: 30, show_toasts: false } },
        list: [2, 3],
        download_natives: false,
      },
    );
    expect(merged).toEqual({
      idle: { timeout: 600, condition: 'none' },
      states: { unfocused: { frame_rate_target: 5, show_toasts: false } },
      list: [1],
      download_natives: false,
    });
    expect(added).toEqual(['idle.condition', 'states.unfocused.show_toasts', 'download_natives']);
  });

  it('does not descend into a user value of another type', () => {
    expect(fillMissing({ idle: 'off' }, { idle: { timeout: 0 } }).merged).toEqual({ idle: 'off' });
  });

  it('does not mutate its inputs', () => {
    const target = { a: { b: 1 } };
    const seed = { a: { c: 2 } };
    fillMissing(target, seed);
    expect(target).toEqual({ a: { b: 1 } });
    expect(seed).toEqual({ a: { c: 2 } });
  });
});

describe('seedJsonConfig', () => {
  it('creates, then merges, then leaves alone', async () => {
    const path = join(tmp(), 'config', 'x.json');
    expect((await seedJsonConfig(path, { a: 1, b: { c: 2 } })).action).toBe('created');
    expect(readJson(path)).toEqual({ a: 1, b: { c: 2 } });
    writeFileSync(path, JSON.stringify({ a: 5, b: {}, user: true }));
    const merged = await seedJsonConfig(path, { a: 1, b: { c: 2 } });
    expect(merged).toEqual({ action: 'merged', added: ['b.c'] });
    expect(readJson(path)).toEqual({ a: 5, b: { c: 2 }, user: true });
    expect((await seedJsonConfig(path, { a: 1, b: { c: 2 } })).action).toBe('unchanged');
  });

  it('never clobbers a file it cannot parse', async () => {
    const path = join(tmp(), 'x.json');
    writeFileSync(path, '{ not json');
    expect((await seedJsonConfig(path, { a: 1 })).action).toBe('skipped-invalid');
    expect(readFileSync(path, 'utf8')).toBe('{ not json');
    writeFileSync(path, '[1,2]');
    expect((await seedJsonConfig(path, { a: 1 })).action).toBe('skipped-invalid');
  });
});

describe('seedConfigs (packaging/seed-configs)', () => {
  it('seeds Dynamic FPS and Entity Culling per PLAN §10', async () => {
    const game = tmp();
    const results = await seedConfigs(game, SEED_DIR);
    expect(results.map((r) => [r.file, r.action])).toEqual([
      ['dynamic_fps.json', 'created'],
      ['entityculling.json', 'created'],
    ]);
    const dfps = readJson(join(game, 'config', 'dynamic_fps.json')) as {
      idle: { timeout: number; condition: string };
      states: { unfocused: { frame_rate_target: number }; invisible: { frame_rate_target: number } };
      ignore_initial_click: string;
    };
    expect(dfps.states.unfocused.frame_rate_target).toBe(30);
    // Never 0 (Dynamic FPS's default): BootScreen waits for the loading overlay, which only fades on drawn frames.
    expect(dfps.states.invisible.frame_rate_target).toBe(1);
    expect(dfps.idle).toEqual({ timeout: 0, condition: 'none' });
    expect(dfps.ignore_initial_click).toBe('disabled');
    expect(readJson(join(game, 'config', 'entityculling.json'))).toEqual({ configVersion: 9 });
  });

  it('merges into configs the mods already wrote without overriding the player', async () => {
    const game = tmp();
    mkdirSync(join(game, 'config'));
    // Dynamic FPS saves only fields that differ from its defaults; the player picked 60 fps unfocused.
    writeFileSync(
      join(game, 'config', 'dynamic_fps.json'),
      JSON.stringify({ states: { unfocused: { frame_rate_target: 60 } }, uncap_menu_frame_rate: true }),
    );
    // Entity Culling writes its whole config; an older configVersion must stay for its own upgrader.
    writeFileSync(
      join(game, 'config', 'entityculling.json'),
      JSON.stringify({ configVersion: 8, tracingDistance: 64 }),
    );
    const results = await seedConfigs(game, SEED_DIR);
    expect(results.map((r) => r.action)).toEqual(['merged', 'unchanged']);
    const dfps = readJson(join(game, 'config', 'dynamic_fps.json')) as {
      states: { unfocused: { frame_rate_target: number } };
      uncap_menu_frame_rate: boolean;
      idle: unknown;
    };
    expect(dfps.states.unfocused.frame_rate_target).toBe(60);
    expect(dfps.uncap_menu_frame_rate).toBe(true);
    expect(dfps.idle).toEqual({ timeout: 0, condition: 'none' });
    expect(readJson(join(game, 'config', 'entityculling.json'))).toEqual({
      configVersion: 8,
      tracingDistance: 64,
    });
  });
});
