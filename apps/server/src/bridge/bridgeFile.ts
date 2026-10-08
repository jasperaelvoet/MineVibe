import { randomBytes } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { z } from 'zod';
import { writeFileAtomic } from '../util/atomicFile.js';

/** Bridge tokens: 24 random bytes, base64url (32 characters). */
export const TOKEN_BYTES = 24;
const TOKEN_RE = /^[A-Za-z0-9_-]{32,256}$/;

/** `run/bridge.json`: how the mod finds and authenticates to the bridge. */
export const BridgeFileContents = z.object({
  port: z.number().int().min(1).max(65535),
  token: z.string().regex(TOKEN_RE, 'token must be base64url'),
  pid: z.number().int().min(1),
});
export type BridgeFileContents = z.infer<typeof BridgeFileContents>;

/** A fresh bridge token: `crypto.randomBytes(24).toString('base64url')`. */
export function generateToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

export function isWellFormedToken(token: string): boolean {
  return TOKEN_RE.test(token);
}

/** Writes `contents` to `path` atomically, readable by the owner only (0600); the parent is created 0700. */
export function writePrivateFile(path: string, contents: string): Promise<void> {
  return writeFileAtomic(path, contents, { mode: 0o600, dirMode: 0o700 });
}

/** Writes `run/bridge.json` (mode 0600). */
export async function writeBridgeFile(path: string, contents: BridgeFileContents): Promise<void> {
  const valid = BridgeFileContents.parse(contents);
  await writePrivateFile(path, `${JSON.stringify(valid, null, 2)}\n`);
}

/** Reads and validates a bridge file. */
export async function readBridgeFile(path: string): Promise<BridgeFileContents> {
  return BridgeFileContents.parse(JSON.parse(await readFile(path, 'utf8')));
}

/**
 * Removes the bridge file, but only if it still belongs to `pid` (another instance may have replaced it).
 * Missing files are fine.
 */
export async function removeBridgeFile(path: string, pid: number = process.pid): Promise<boolean> {
  try {
    const current = await readBridgeFile(path);
    if (current.pid !== pid) return false;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    // unreadable or malformed: ours to clean up
  }
  await rm(path, { force: true });
  return true;
}
