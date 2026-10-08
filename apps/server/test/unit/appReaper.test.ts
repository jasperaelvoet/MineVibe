import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { reapStaleRunFiles } from '../../src/app/reaper.js';
import { writeBridgeFile } from '../../src/bridge/bridgeFile.js';

const dirs: string[] = [];
function bridgeFile(): string {
  const d = mkdtempSync(join(tmpdir(), 'mv-reap-'));
  dirs.push(d);
  mkdirSync(join(d, 'run'));
  return join(d, 'run', 'bridge.json');
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const TOKEN = 'a'.repeat(32);

describe('startup reaper: run files', () => {
  it('has nothing to do without a bridge file, and keeps our own', async () => {
    const path = bridgeFile();
    expect(await reapStaleRunFiles({ bridgeFile: path })).toEqual({ bridgeFile: 'absent' });
    await writeBridgeFile(path, { port: 4000, token: TOKEN, pid: 4242 });
    expect(await reapStaleRunFiles({ bridgeFile: path }, { pid: 4242 })).toEqual({ bridgeFile: 'ours' });
    expect(existsSync(path)).toBe(true);
  });

  it("removes a crashed run's bridge file, also when its pid now belongs to another process", async () => {
    const path = bridgeFile();
    await writeBridgeFile(path, { port: 4000, token: TOKEN, pid: 999_999 });
    expect(await reapStaleRunFiles({ bridgeFile: path }, { pid: 1, pidExists: () => false })).toEqual({
      bridgeFile: 'removed',
      stale: { pid: 999_999, pidRunning: false },
    });
    expect(existsSync(path)).toBe(false);

    await writeBridgeFile(path, { port: 4000, token: TOKEN, pid: 77 });
    const reused = await reapStaleRunFiles({ bridgeFile: path }, { pid: 1, pidExists: () => true });
    expect(reused).toEqual({ bridgeFile: 'removed', stale: { pid: 77, pidRunning: true } });
    expect(existsSync(path)).toBe(false);
  });

  it('removes a malformed bridge file', async () => {
    const path = bridgeFile();
    writeFileSync(path, '{"port":');
    expect(await reapStaleRunFiles({ bridgeFile: path }, { pid: 1 })).toEqual({
      bridgeFile: 'removed',
      stale: { pid: null, pidRunning: false },
    });
    expect(existsSync(path)).toBe(false);
  });
});
