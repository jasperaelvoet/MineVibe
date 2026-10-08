import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BURIAL_FILENAME, buryWorldSave, GRAVEYARD_DIRNAME } from '../../src/world/graveyard.js';

const dirs: string[] = [];
function savesDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mv-saves-'));
  dirs.push(dir);
  return dir;
}
function makeSave(saves: string, id: string): void {
  mkdirSync(join(saves, id, 'region'), { recursive: true });
  writeFileSync(join(saves, id, 'level.dat'), id);
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('buryWorldSave', () => {
  it('moves the dead save into _graveyard and stamps it', async () => {
    const saves = savesDir();
    makeSave(saves, 'world-1');
    makeSave(saves, 'world-2');
    const result = await buryWorldSave(saves, 'world-1', { now: new Date('2026-10-08T12:00:00Z') });
    expect(result.movedTo).toBe(join(saves, GRAVEYARD_DIRNAME, 'world-1'));
    expect(existsSync(join(saves, 'world-1'))).toBe(false);
    expect(readFileSync(join(saves, GRAVEYARD_DIRNAME, 'world-1', 'level.dat'), 'utf8')).toBe('world-1');
    expect(
      JSON.parse(readFileSync(join(saves, GRAVEYARD_DIRNAME, 'world-1', BURIAL_FILENAME), 'utf8')),
    ).toEqual({
      worldId: 'world-1',
      buriedAt: '2026-10-08T12:00:00.000Z',
    });
    expect(existsSync(join(saves, 'world-2', 'level.dat'))).toBe(true);
  });

  it('is a no-op for a world that has no save', async () => {
    const saves = savesDir();
    expect(await buryWorldSave(saves, 'world-9')).toEqual({ movedTo: null, pruned: [] });
    expect(existsSync(join(saves, GRAVEYARD_DIRNAME))).toBe(false);
  });

  it('keeps only the newest N buried saves', async () => {
    const saves = savesDir();
    for (let gen = 1; gen <= 7; gen++) {
      makeSave(saves, `world-${gen}`);
      await buryWorldSave(saves, `world-${gen}`, { keep: 5, now: new Date(Date.UTC(2026, 9, gen)) });
    }
    expect(readdirSync(join(saves, GRAVEYARD_DIRNAME)).sort()).toEqual([
      'world-3',
      'world-4',
      'world-5',
      'world-6',
      'world-7',
    ]);
  });

  it('does not overwrite an existing graveyard entry', async () => {
    const saves = savesDir();
    makeSave(saves, 'world-1');
    await buryWorldSave(saves, 'world-1', { now: new Date(1000) });
    makeSave(saves, 'world-1');
    const second = await buryWorldSave(saves, 'world-1', { now: new Date(2000) });
    expect(second.movedTo).toBe(join(saves, GRAVEYARD_DIRNAME, 'world-1-2000'));
    expect(readdirSync(join(saves, GRAVEYARD_DIRNAME)).sort()).toEqual(['world-1', 'world-1-2000']);
  });

  it('rejects world ids that could escape the saves folder', async () => {
    const saves = savesDir();
    await expect(buryWorldSave(saves, '../etc')).rejects.toThrow();
    await expect(buryWorldSave(saves, '_graveyard')).rejects.toThrow();
  });
});
