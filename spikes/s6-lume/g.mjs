// Spike S6: a connected spacesd client of a running VM (token from its setup share, never printed) and a guest shell.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './lib.mjs';
import { connect } from './spacesd.mjs';

export async function guest(name) {
  const ip = readFileSync(join('out', `${name}.ip`), 'utf8').trim();
  const token = readFileSync(join(ROOT, 'shares', name, 'setup', 'env-token'), 'utf8').trim();
  const c = await connect(`http://${ip}:3211`, token);
  const sh = async (script, { user = 'lume', timeoutMs = 60_000, env = {} } = {}) => {
    const t0 = performance.now();
    const o = await c.run({
      program: 'bash',
      args: ['-c', script],
      env: new Map(Object.entries(env)),
      ...(user ? { user } : {}),
      stdin: false,
      timeoutMs,
    });
    return {
      code: o.exit.code,
      ms: Math.round(performance.now() - t0),
      out: Buffer.from(o.stdout).toString('utf8'),
      err: Buffer.from(o.stderr).toString('utf8'),
    };
  };
  return { c, ip, sh };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
