// spacesd client for the spike: @trycua/cua 0.4.1 with telemetry off and its state in out/cua (never ~/.cua).
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { HERE } from './lib.mjs';

process.env.DO_NOT_TRACK = '1';
process.env.CUA_TELEMETRY = '0';
process.env.CUA_HOME = join(HERE, 'out', 'cua');
mkdirSync(process.env.CUA_HOME, { recursive: true });

const cua = await import('@trycua/cua');
cua.telemetrySetEnabled?.(false);
export const { ImageFormat } = cua;

export async function connect(url, token, timeoutMs = 10_000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    return await cua.embedded().spacesd(url, token, { signal: ac.signal });
  } finally {
    clearTimeout(t);
  }
}

export function withTimeout(promise, ms, what) {
  let t;
  return Promise.race([
    promise.finally(() => clearTimeout(t)),
    new Promise((_, rej) => {
      t = setTimeout(() => rej(new Error(`timeout ${ms}ms: ${what}`)), ms);
    }),
  ]);
}
