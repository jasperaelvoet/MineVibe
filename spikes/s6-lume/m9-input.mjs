// M9 debugging: input into a held macOS PC (m9-hold.ts): which app is in front after `open -a Terminal`, and does text
// typed with typeText plus Enter as keyboard down/up (InputRouter's ops) reach the shell?
//   node m9-input.mjs
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HERE, ROOT } from './lib.mjs';
import { connect } from './spacesd.mjs';

const { vm } = JSON.parse(readFileSync(join(HERE, 'out', 'm9-hold.json'), 'utf8'));
const serve = JSON.parse(readFileSync(join(ROOT, 'serve', 'serve.json'), 'utf8'));
const info = await (await fetch(`http://127.0.0.1:${serve.port}/lume/vms/${vm}?storage=minevibe`)).json();
const token = readFileSync(join(ROOT, 'shares', vm, 'setup', 'env-token'), 'utf8').trim();
const c = await connect(`http://${info.ipAddress}:3211`, token);
const sleep = (n) => new Promise((r) => setTimeout(r, n));
const sh = async (s) => {
  const o = await c.run({ program: 'bash', args: ['-c', s], env: new Map([['HOME', '/Users/lume']]), user: 'lume', stdin: false, timeoutMs: 30_000 });
  return `${Buffer.from(o.stdout).toString()}${Buffer.from(o.stderr).toString()}`.trim();
};
const front = () => sh('lsappinfo info -only name "$(lsappinfo front)" 2>&1');
const step = process.argv[2] ?? 'all';
console.log('front at start:', await front());
if (step === 'all' || step === 'open') {
  console.log(await sh('rm -f /tmp/x1 /tmp/x2 /tmp/x3; open -a Terminal; echo opened'));
  await sleep(3000);
  console.log('front after open -a Terminal:', await front());
}
const kb = (o) => c.keyboardJson(JSON.stringify(o));
await c.typeText('echo one > /tmp/x1');
await kb({ down: { key: { named: 'KEY_ENTER' } } });
await kb({ up: { key: { named: 'KEY_ENTER' } } });
await sleep(800);
console.log('x1 (typeText + down/up Enter):', await sh('cat /tmp/x1 2>&1'));
await c.typeText('echo two > /tmp/x2');
await kb({ press: { key: { named: 'KEY_ENTER' } } });
await sleep(800);
console.log('x2 (typeText + press Enter):', await sh('cat /tmp/x2 2>&1'));
await c.typeText('echo "Hello, World! éà #$%" > /tmp/x3');
await kb({ press: { key: { named: 'KEY_ENTER' } } });
await sleep(800);
console.log('x3 (non-ASCII):', await sh('cat /tmp/x3 2>&1'));
console.log('windows:', (JSON.parse(await c.callJson('/cua.env.v1.WindowsService/ListWindows', '{}')).windows ?? []).map((w) => `${w.title}|${w.app ?? w.appName ?? ''}`));
process.exit(0);
