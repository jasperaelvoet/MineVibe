// Spike S6: exact text typed into a guest Terminal (`cat > file`), then read back from the shell.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { connect } from './spacesd.mjs';

const name = process.argv[2] ?? 'mv-pc-mac-1';
const ip = readFileSync(join('out', `${name}.ip`), 'utf8').trim();
const token = readFileSync(
  join(process.env.HOME, 'Library/Application Support/MineVibe-dev/lume/shares', name, 'setup', 'env-token'),
  'utf8',
).trim();
const c = await connect(`http://${ip}:3211`, token);
const sh = async (s) => {
  const o = await c.run({ program: 'bash', args: ['-c', s], env: new Map(), user: 'lume', stdin: false, timeoutMs: 20000 });
  return Buffer.from(o.stdout).toString();
};
const sleep = (n) => new Promise((r) => setTimeout(r, n));
await sh('rm -f /tmp/t2.txt; open -a Terminal');
await sleep(3000);
await c.typeText('cat > /tmp/t2.txt');
await c.press('KEY_ENTER');
await sleep(500);
const text = 'Hello, World! 123 éà #$%';
const t0 = performance.now();
await c.typeText(text);
console.log(`typeText ${[...text].length} chars: ${Math.round(performance.now() - t0)} ms`);
await c.press('KEY_ENTER');
await c.hotkey(['KEY_CONTROL', 'd']);
await sleep(800);
const got = await sh('cat /tmp/t2.txt; rm -f /tmp/t2.txt');
console.log('typed back:', JSON.stringify(got), got === `${text}\n` ? 'EXACT' : 'DIFFERENT');
await c.hotkey(['KEY_META', 'q']);
process.exit(0);
