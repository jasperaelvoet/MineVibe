// M9 debugging: ShellMirror on the held PC of m9-hold.ts. Opens the Terminal mirror, shows what `ps -E` reveals of its
// processes as `lume` and as root, runs the server's sweep script both ways, then closes the mirror.
//   node --import tsx m9-mirror.ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MAC_SWEEP_SCRIPT, SWEEP_LAUNCH } from '../../apps/server/src/pcs/guest.js';
import { ShellMirror } from '../../apps/server/src/pcs/ShellMirror.js';
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
    env: new Map([['HOME', '/Users/lume'], ['LC_ALL', 'C.UTF-8'], ['PATH', '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin'], ...env]),
    user: 'lume',
    stdin: false,
    timeoutMs: 30_000,
  });
  return `${Buffer.from(o.stdout).toString()}${Buffer.from(o.stderr).toString()}`.trim();
};
const titles = async () =>
  ((JSON.parse(await c.callJson('/cua.env.v1.WindowsService/ListWindows', '{}')) as { windows?: { title?: string }[] }).windows ?? []).map(
    (w) => w.title,
  );
const ID = 'hold';
const step = process.argv[2] ?? 'all';
let swept = 0;
const mirror = new ShellMirror({
  client: async () => c,
  sweep: async (_id, n, v) => {
    const out = await run(SWEEP_LAUNCH, [n, v, MAC_SWEEP_SCRIPT]);
    swept = Number.parseInt(out.split('\n').at(-1) ?? '0', 10);
    console.log('sweep output:', JSON.stringify(out));
    return swept;
  },
  osOf: () => 'macos',
});
if (step === 'all' || step === 'open') {
  await mirror.open(ID, 'ada');
  await sleep(2500);
  console.log('windows after open:', await titles());
}
console.log('mirror processes (lume):\n', await run(`ps -axww -o pid=,ppid=,user=,command= | grep -E "mirror.sh|tail -n 200|login|sed -u" | grep -v grep`));
console.log('ps -E lines with MV_MIRROR as lume:\n', await run(`ps -axwwE -o pid=,command= | grep -c "MV_MIRROR=${ID}"`));
console.log('ps -E lines with MV_MIRROR as root:\n', await run(`sudo -n ps -axwwE -o pid=,command= | grep -c "MV_MIRROR=${ID}"`));
console.log('as lume, sweep script pids:', await run(MAC_SWEEP_SCRIPT, ['MV_MIRROR', ID]));
console.log('as root, sweep script pids:', await run(`sudo -n bash -c "$1" sweep MV_MIRROR ${ID}`, [MAC_SWEEP_SCRIPT]));
const tail = (await run('pgrep -f "tail -n 200 -F"')).split('\n')[0];
console.log('tail pid', tail, 'ps -E as lume:', (await run(`ps -wwE -o command= -p ${tail}`)).slice(0, 300));
console.log('tail ps -E as root:', (await run(`sudo -n ps -wwE -o command= -p ${tail}`)).slice(0, 300));
if (step === 'all' || step === 'close') {
  await mirror.close(ID);
  await sleep(2000);
  console.log('swept', swept, 'windows after close:', await titles());
}
process.exit(0);
