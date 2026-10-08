/**
 * S9: connects to the PC that `boot.ts` keeps up (its `endpoint.json`) and runs one probe module against it.
 *
 *   node --conditions=source --import tsx spikes/s9-pc-tools-v2/client.ts <outDir> <probe.ts>
 *
 * A probe module default-exports `async (ctx) => unknown`; the result is printed as JSON.
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { SpacesdClientLike } from '@trycua/cua';
import { loadCua } from '../../apps/server/src/pcs/SpacesdPool.js';

export interface ProbeCtx {
  readonly c: SpacesdClientLike;
  readonly pcId: string;
  readonly vault: string;
  readonly jpeg: number;
  readonly png: number;
  call(method: string, req: unknown): Promise<unknown>;
  sh(script: string, opts?: { root?: boolean; timeoutMs?: number }): Promise<{ code: number | undefined; out: string; err: string }>;
  sleep(ms: number): Promise<void>;
  log(...a: unknown[]): void;
}

const out = process.argv[2] as string;
const probe = process.argv[3] as string;
const ep = JSON.parse(readFileSync(join(out, 'endpoint.json'), 'utf8')) as {
  pcId: string;
  url: string;
  tokenFile: string;
  vault: string;
};
const token = readFileSync(ep.tokenFile, 'utf8').trim();
const cua = await loadCua(join(out, 'caches'));
const c = await cua.embedded().spacesd(ep.url, token);
const txt = (b: ArrayBuffer) => Buffer.from(b).toString('utf8');
const ctx: ProbeCtx = {
  c,
  pcId: ep.pcId,
  vault: ep.vault,
  jpeg: cua.ImageFormat.Jpeg,
  png: cua.ImageFormat.Png,
  async call(method, req) {
    const m = method.startsWith('/') ? method : `/cua.env.v1.${method}`;
    const raw = await c.callJson(m, JSON.stringify(req));
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  },
  async sh(script, opts = {}) {
    const env = new Map<string, string>([
      ['DISPLAY', ':1'],
      ['HOME', '/home/cua'],
    ]);
    const r = await c.run({
      program: opts.root ? 'sudo' : 'bash',
      args: opts.root ? ['-n', 'bash', '-lc', script] : ['-lc', script],
      env,
      stdin: false,
      user: 'cua',
      timeoutMs: opts.timeoutMs ?? 30_000,
    });
    return { code: r.exit.code, out: txt(r.stdout).trim(), err: txt(r.stderr).trim() };
  },
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  log: (...a) => console.log('[probe]', ...a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x)))),
};
const mod = (await import(pathToFileURL(resolve(probe)).href)) as { default: (ctx: ProbeCtx) => Promise<unknown> };
try {
  const r = await mod.default(ctx);
  if (r !== undefined) console.log(JSON.stringify(r, null, 1));
} catch (e) {
  console.log('[probe] FAILED', e instanceof Error ? `${e.name}: ${e.message}` : String(e));
  process.exitCode = 1;
}
