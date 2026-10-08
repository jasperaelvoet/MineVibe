import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  generateToken,
  isWellFormedToken,
  loadOrCreateToken,
  readBridgeFile,
  removeBridgeFile,
  writeBridgeFile,
} from '../../src/bridge/bridgeFile.js';

const tmpDirs: string[] = [];
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mv-bridgefile-'));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('generateToken', () => {
  it('is 24 random bytes as base64url', () => {
    const a = generateToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(Buffer.from(a, 'base64url')).toHaveLength(24);
    expect(generateToken()).not.toBe(a);
    expect(isWellFormedToken(a)).toBe(true);
    expect(isWellFormedToken('short')).toBe(false);
    expect(isWellFormedToken(`${a}+`)).toBe(false);
  });
});

describe('bridge.json', () => {
  it('is written 0600 in a 0700 dir and reads back', async () => {
    const path = join(tmp(), 'run', 'bridge.json');
    const contents = { port: 47800, token: generateToken(), pid: 4242 };
    await writeBridgeFile(path, contents);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(path, '..')).mode & 0o777).toBe(0o700);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(contents);
    expect(await readBridgeFile(path)).toEqual(contents);
  });

  it('replaces an existing file atomically and leaves no temp files', async () => {
    const dir = tmp();
    const path = join(dir, 'bridge.json');
    writeFileSync(path, 'old', { mode: 0o644 });
    await writeBridgeFile(path, { port: 1, token: generateToken(), pid: 1 });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir)).toEqual(['bridge.json']);
  });

  it('rejects invalid contents', async () => {
    const path = join(tmp(), 'bridge.json');
    await expect(writeBridgeFile(path, { port: 0, token: generateToken(), pid: 1 })).rejects.toThrow();
    await expect(writeBridgeFile(path, { port: 1, token: 'short', pid: 1 })).rejects.toThrow();
  });

  it('is removed only by its owner pid', async () => {
    const path = join(tmp(), 'bridge.json');
    await writeBridgeFile(path, { port: 1, token: generateToken(), pid: 111 });
    expect(await removeBridgeFile(path, 222)).toBe(false);
    expect(statSync(path).isFile()).toBe(true);
    expect(await removeBridgeFile(path, 111)).toBe(true);
    expect(await removeBridgeFile(path, 111)).toBe(false);
  });
});

describe('loadOrCreateToken (.dev-token)', () => {
  it('creates a 0600 token file and reuses it', async () => {
    const path = join(tmp(), '.dev-token');
    const first = await loadOrCreateToken(path);
    expect(isWellFormedToken(first)).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(await loadOrCreateToken(path)).toBe(first);
  });

  it('tightens loose permissions on an existing token', async () => {
    const path = join(tmp(), '.dev-token');
    const token = generateToken();
    writeFileSync(path, `${token}\n`);
    chmodSync(path, 0o644);
    expect(await loadOrCreateToken(path)).toBe(token);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('replaces a malformed token', async () => {
    const path = join(tmp(), '.dev-token');
    writeFileSync(path, 'nope');
    const token = await loadOrCreateToken(path);
    expect(token).not.toBe('nope');
    expect(isWellFormedToken(token)).toBe(true);
  });
});
