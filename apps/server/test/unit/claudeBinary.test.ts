import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  compareVersions,
  findClaudeBinary,
  MIN_CLAUDE_VERSION,
  parseClaudeVersion,
  readClaudeVersion,
} from '../../src/agents/claudeBinary.js';

const tmpDirs: string[] = [];
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('claude version helpers', () => {
  it('parses --version output', () => {
    expect(parseClaudeVersion('2.1.293 (Claude Code)\n')).toBe('2.1.293');
    expect(parseClaudeVersion('nothing')).toBeNull();
  });

  it('compares numerically', () => {
    expect(compareVersions('2.1.293', MIN_CLAUDE_VERSION)).toBe(0);
    expect(compareVersions('2.1.284', MIN_CLAUDE_VERSION)).toBeLessThan(0);
    expect(compareVersions('2.10.0', '2.9.999')).toBeGreaterThan(0);
    expect(compareVersions('3', '2.99.99')).toBeGreaterThan(0);
  });

  it('finds ~/.local/bin/claude first, then PATH, and runs --version', async () => {
    const home = mkdtempSync(join(tmpdir(), 'mv-claude-'));
    tmpDirs.push(home);
    const bin = join(home, '.local', 'bin');
    mkdirSync(bin, { recursive: true });
    const other = join(home, 'other');
    mkdirSync(other);
    for (const dir of [bin, other]) {
      writeFileSync(join(dir, 'claude'), '#!/bin/sh\necho "2.1.300 (Claude Code)"\n');
      chmodSync(join(dir, 'claude'), 0o755);
    }
    expect(findClaudeBinary({ home, path: other })).toBe(join(bin, 'claude'));
    rmSync(join(bin, 'claude'));
    expect(findClaudeBinary({ home, path: `relative:${other}` })).toBe(join(other, 'claude'));
    expect(findClaudeBinary({ home, path: '' })).toBeNull();
    expect(await readClaudeVersion(join(other, 'claude'), { PATH: '/usr/bin:/bin' })).toBe('2.1.300');
    expect(await readClaudeVersion(join(home, 'missing'), { PATH: '/usr/bin:/bin' })).toBeNull();
  });
});
