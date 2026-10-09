// M9 debugging: which spacesd keyboard and pointer operations a macOS guest supports (held PC of m9-hold.ts).
//   node m9-ops.mjs
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
const tryOp = async (what, f) => {
  try {
    const r = await f();
    console.log(`${what}: ok ${typeof r === 'string' ? r.slice(0, 120) : ''}`);
    return true;
  } catch (e) {
    console.log(`${what}: ${e?.tag ?? ''} ${String(e?.message ?? e).slice(0, 160)}`);
    return false;
  }
};
const kb = (o) => c.keyboardJson(JSON.stringify(o));
const pt = (o) => c.pointerJson(JSON.stringify(o));
console.log(await sh('rm -f /tmp/y*; open -a Terminal; sleep 2; lsappinfo info -only name "$(lsappinfo front)"'));
await tryOp('key down KEY_SHIFT', () => kb({ down: { key: { named: 'KEY_SHIFT' } } }));
await tryOp('key up KEY_SHIFT', () => kb({ up: { key: { named: 'KEY_SHIFT' } } }));
await tryOp('key down char a', () => kb({ down: { key: { character: 'a' } } }));
await tryOp('key up char a', () => kb({ up: { key: { character: 'a' } } }));
await tryOp('press char a', () => kb({ press: { key: { character: 'a' } } }));
await tryOp('press KEY_BACKSPACE', () => kb({ press: { key: { named: 'KEY_BACKSPACE' } } }));
await tryOp('press char e with KEY_SHIFT', () => kb({ press: { key: { character: 'e' }, modifiers: ['KEY_SHIFT'] } }));
await tryOp('press KEY_BACKSPACE repeat 2', () => kb({ press: { key: { named: 'KEY_BACKSPACE' }, repeat: 2 } }));
await tryOp('typeText', () => c.typeText('echo ops > /tmp/y1'));
await tryOp('press KEY_ENTER', () => kb({ press: { key: { named: 'KEY_ENTER' } } }));
await sleep(600);
console.log('y1:', await sh('cat /tmp/y1 2>&1'));
await tryOp('hotkey ctrl+u', () => c.hotkey(['KEY_CONTROL', 'u']));
await tryOp('press char u with KEY_CONTROL', () => kb({ press: { key: { character: 'u' }, modifiers: ['KEY_CONTROL'] } }));
await tryOp('press F5', () => kb({ press: { key: { named: 'KEY_F5' } } }));
await tryOp('press arrow left', () => kb({ press: { key: { named: 'KEY_LEFT' } } }));
await tryOp('pointer move', () => pt({ move: { position: { x: 300, y: 300 } } }));
await tryOp('pointer down', () => pt({ down: { button: 'MOUSE_BUTTON_LEFT' } }));
await tryOp('pointer up', () => pt({ up: { button: 'MOUSE_BUTTON_LEFT' } }));
await tryOp('pointer click', () => pt({ click: { position: { x: 300, y: 300 }, button: 'MOUSE_BUTTON_LEFT', count: 1 } }));
await tryOp('pointer scroll', () => pt({ scroll: { position: { x: 300, y: 300 }, deltaX: 0, deltaY: 3 } }));
await tryOp('pointer drag', () => pt({ drag: { from: { x: 300, y: 300 }, to: { x: 320, y: 320 }, button: 'MOUSE_BUTTON_LEFT' } }));
await tryOp('cursor', async () => JSON.stringify(await c.cursorPosition?.()));
process.exit(0);
