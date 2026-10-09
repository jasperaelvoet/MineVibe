// M9 debugging: the server's InputRouter in macOS mode against the held PC of m9-hold.ts: the player's T0 events
// (text, Enter down/up, Cmd+Q as KEY_META down, q down/up, KEY_META up) and a double click.
//   node --import tsx m9-router.ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { InputRouter } from '../../apps/server/src/pcs/InputRouter.js';
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
const sh = async (s: string) => {
  const o = await c.run({ program: 'bash', args: ['-c', s], env: new Map([['HOME', '/Users/lume']]), user: 'lume', stdin: false, timeoutMs: 30_000 });
  return `${Buffer.from(o.stdout).toString()}${Buffer.from(o.stderr).toString()}`.trim();
};
const router = new InputRouter({ getClient: async () => c, osOf: () => 'macos' });
const P = { kind: 'player' as const, id: 'player' };
router.setOccupant('pc', P);
console.log(await sh('rm -f /tmp/mv-typed.txt; pkill -x Terminal; sleep 1; open -a Terminal; sleep 2.5; lsappinfo info -only name "$(lsappinfo front)"'));
let t0 = performance.now();
console.log(
  router.submit('pc', P, [
    { k: 'text', text: 'echo "Hello, World! éà #$%" > /tmp/mv-typed.txt' },
    { k: 'key', key: 'KEY_ENTER', down: true },
    { k: 'key', key: 'KEY_ENTER', down: false },
  ]),
);
await router.idle('pc');
console.log('typed in', Math.round(performance.now() - t0), 'ms', router.stats('pc'));
await sleep(500);
console.log('file:', JSON.stringify(await sh('cat /tmp/mv-typed.txt 2>&1')));
// A double click on the word "Hello" in the Terminal (selects it), then Cmd+C and a check of the pasteboard.
t0 = performance.now();
router.submit('pc', P, [
  { k: 'key', key: 'KEY_META', down: true },
  { k: 'key', key: 'q', down: true },
  { k: 'key', key: 'q', down: false },
  { k: 'key', key: 'KEY_META', down: false },
]);
await router.idle('pc');
await sleep(2000);
console.log('Terminal after Cmd+Q:', await sh('pgrep -x Terminal || echo gone'), router.stats('pc'), router.held('pc'));
process.exit(0);
