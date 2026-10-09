// M9 debugging: the server's macOS `open` script (PcApi open) on the held PC of m9-hold.ts, for a few targets, with the
// windows on screen after each and whether the launched app carries MV_TAG (the seat's sweep finds it).
//   node --import tsx m9-open.ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MAC_OPEN_SCRIPT, MAC_SWEEP_SCRIPT } from '../../apps/server/src/pcs/guest.js';
import { parseWindows } from '../../apps/server/src/pcs/rpc.js';
// @ts-ignore spike helper
import { HERE, ROOT } from './lib.mjs';
// @ts-ignore spike helper
import { connect } from './spacesd.mjs';

const { vm } = JSON.parse(readFileSync(join(HERE, 'out', 'm9-hold.json'), 'utf8'));
const serve = JSON.parse(readFileSync(join(ROOT, 'serve', 'serve.json'), 'utf8'));
const info = await (await fetch(`http://127.0.0.1:${serve.port}/lume/vms/${vm}?storage=minevibe`)).json();
const token = readFileSync(join(ROOT, 'shares', vm, 'setup', 'env-token'), 'utf8').trim();
const c = await connect(`http://${info.ipAddress}:3211`, token);
const sleep = (n: number) => new Promise((r) => setTimeout(r, n));
const run = async (s: string, args: string[] = [], env: [string, string][] = []) => {
  const o = await c.run({
    program: 'bash',
    args: ['-c', s, 'guest', ...args],
    env: new Map([['HOME', '/Users/lume'], ['PATH', '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin'], ['USER', 'lume'], ...env]),
    user: 'lume',
    stdin: false,
    timeoutMs: 30_000,
  });
  return { code: o.exit.code, out: `${Buffer.from(o.stdout).toString()}${Buffer.from(o.stderr).toString()}`.trim() };
};
const shown = async () =>
  parseWindows(JSON.parse(await c.callJson('/cua.env.v1.WindowsService/ListWindows', '{}')))
    .filter((w) => w.onScreen)
    .map((w) => `${w.app}: ${w.title}`);
for (const target of (process.argv[2] ?? 'terminal,TextEdit,/Users/lume,nosuchapp').split(',')) {
  const r = await run(MAC_OPEN_SCRIPT, [target], [['MV_TAG', 'ada:7'], ['MV_CALL', 'c1']]);
  await sleep(2500);
  console.log(target, '→', r.code, JSON.stringify(r.out.slice(0, 200)), await shown());
}
console.log('tagged pids:', (await run(MAC_SWEEP_SCRIPT, ['MV_TAG', 'ada:7'])).out.split('\n').join(' '));
process.exit(0);
