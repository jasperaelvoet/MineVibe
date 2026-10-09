// M9 debugging: the server's display switch (macGuest.ts MAC_DISPLAY_SCRIPT + MAC_DISPLAY_JXA) on the held PC of
// m9-hold.ts: to 1024x768 and back to 1280x800, timed, with spacesd's display size after each.
//   node --import tsx m9-display.ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MAC_DISPLAY_JXA, MAC_DISPLAY_SCRIPT } from '../../apps/server/src/pcs/macGuest.js';
// @ts-ignore spike helper
import { HERE, ROOT } from './lib.mjs';
// @ts-ignore spike helper
import { connect } from './spacesd.mjs';

const { vm } = JSON.parse(readFileSync(join(HERE, 'out', 'm9-hold.json'), 'utf8'));
const serve = JSON.parse(readFileSync(join(ROOT, 'serve', 'serve.json'), 'utf8'));
const info = await (await fetch(`http://127.0.0.1:${serve.port}/lume/vms/${vm}?storage=minevibe`)).json();
const token = readFileSync(join(ROOT, 'shares', vm, 'setup', 'env-token'), 'utf8').trim();
const c = await connect(`http://${info.ipAddress}:3211`, token);
for (const size of ['1024x768', '1280x800']) {
  const t0 = performance.now();
  const o = await c.run({
    program: 'bash',
    args: ['-c', MAC_DISPLAY_SCRIPT, 'display', MAC_DISPLAY_JXA, size],
    env: new Map([['HOME', '/Users/lume'], ['PATH', '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin']]),
    user: 'lume',
    stdin: false,
    timeoutMs: 20_000,
  });
  const d = JSON.parse(await c.displays()) as { bounds?: { width?: number; height?: number } }[];
  console.log(size, Math.round(performance.now() - t0), 'ms', JSON.stringify(Buffer.from(o.stdout).toString().trim()), Buffer.from(o.stderr).toString().trim().slice(0, 200), `now ${d[0]?.bounds?.width}x${d[0]?.bounds?.height}`);
}
process.exit(0);
