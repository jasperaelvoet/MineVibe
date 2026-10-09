// Spike S6: what AppleScript run from inside a Terminal window (a `.command`) sees of Terminal and whether it can close
// windows (Terminal scripting itself needs no Automation consent).
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
  const o = await c.run({ program: 'bash', args: ['-c', s], env: new Map(), user: 'lume', stdin: false, timeoutMs: 30000 });
  return `${Buffer.from(o.stdout).toString()}${Buffer.from(o.stderr).toString()}`;
};
const sleep = (n) => new Promise((r) => setTimeout(r, n));
const script = `#!/bin/bash
{
osascript -e 'tell application "Terminal" to get {name, custom title, processes of selected tab} of every window'
echo "exit $?"
osascript -e 'tell application "Terminal"' -e 'repeat with w in (every window)' -e 'if name of w contains "Shell: ada" then close w' -e 'end repeat' -e 'end tell'
echo "close exit $?"
} > ~/.mv/osa2.log 2>&1
`;
const b64 = Buffer.from(script).toString('base64');
console.log(await sh(`echo ${b64} | base64 -d > ~/.mv/osa.command && chmod 700 ~/.mv/osa.command && open -a Terminal ~/.mv/osa.command && echo opened`));
await sleep(8000);
console.log(await sh('cat ~/.mv/osa2.log'));
console.log(
  (JSON.parse(await c.callJson('/cua.env.v1.WindowsService/ListWindows', '{}')).windows ?? []).map((w) => w.title),
);
process.exit(0);
