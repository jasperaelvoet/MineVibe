import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { generateToken, writeBridgeFile } from '../../src/bridge/bridgeFile.js';
import { doctorReport } from '../../src/doctor.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('doctor', () => {
  it('prints versions and paths, never the token', async () => {
    const home = mkdtempSync(join(tmpdir(), 'mv-doctor-'));
    dirs.push(home);
    const token = generateToken();
    await writeBridgeFile(join(home, 'run', 'bridge.json'), { port: 47800, token, pid: process.pid });
    const text = (await doctorReport({ env: { MINEVIBE_HOME: home }, skipClaude: true })).join('\n');
    expect(text).toContain('MineVibe server');
    expect(text).toContain('subprotocol minevibe.v1');
    expect(text).toContain(`paths (MINEVIBE_HOME=${home})`);
    expect(text).toContain(join(home, 'Caches'));
    expect(text).toMatch(new RegExp(`codex export +${join(home, 'codex-export')}\\n`));
    expect(text).toContain(`port 47800, pid ${process.pid} (running)`);
    expect(text).not.toContain(token);
  });

  it('reports a missing bridge file', async () => {
    const home = mkdtempSync(join(tmpdir(), 'mv-doctor-'));
    dirs.push(home);
    const text = (await doctorReport({ env: { MINEVIBE_HOME: home }, skipClaude: true })).join('\n');
    expect(text).toContain('no bridge file');
  });
});
