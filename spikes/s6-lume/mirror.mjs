// Spike S6: the ShellMirror on a macOS guest. A `.command` file opened with `open -a Terminal` tails the shell log
// in a titled Terminal window; closing kills the script (its pid file) and checks whether the window goes away.
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
  return `${Buffer.from(o.stdout).toString()}${Buffer.from(o.stderr).toString()}`;
};
const sleep = (n) => new Promise((r) => setTimeout(r, n));
const windows = async () =>
  (JSON.parse(await c.callJson('/cua.env.v1.WindowsService/ListWindows', '{}')).windows ?? []).map(
    (w) => `${w.appName ?? w.app ?? '?'}: ${w.title}`,
  );

const script = `#!/bin/bash
printf '\\033]0;Shell: ada\\007'
echo $$ > ~/.mv/mirror.pid
bye() { exit 0; }
trap bye TERM INT HUP
mkdir -p ~/.mv && touch ~/.mv/shell.log
printf '\\n\\033[1;36m── ada sat down ──\\033[0m\\n' >> ~/.mv/shell.log
tail -n 200 -F ~/.mv/shell.log &
wait $!
bye
`;
const b64 = Buffer.from(script).toString('base64');
let t0 = performance.now();
console.log(
  await sh(
    `mkdir -p ~/.mv && echo ${b64} | base64 -d > ~/.mv/mirror.command && chmod 700 ~/.mv/mirror.command && open -a Terminal ~/.mv/mirror.command && echo opened`,
  ),
);
await sleep(2500);
console.log(`after open (${Math.round(performance.now() - t0)} ms):`, await windows());
await sh(`echo 'ada@mac-1:~$ echo hello' >> ~/.mv/shell.log; echo hello >> ~/.mv/shell.log`);
await sleep(500);
t0 = performance.now();
console.log(await sh('p=$(cat ~/.mv/mirror.pid); pkill -TERM -P "$p"; kill -TERM "$p"; echo killed $p'));
for (let i = 0; i < 6; i++) { await sleep(1000); console.log(i, await windows()); }
console.log(`after kill (${Math.round(performance.now() - t0)} ms):`, await windows());
console.log(await sh('cat ~/.mv/osa.log; pgrep -fl "tail -n 200 -F" || echo no-tail; pgrep -x Terminal >/dev/null && echo terminal-running'));
process.exit(0);
