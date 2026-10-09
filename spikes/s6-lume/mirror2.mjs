// Spike S6: ShellMirror through a `.terminal` settings file (CommandString + shellExitAction 0 = close the window when
// the command ends), so killing the tail closes the window without Apple events or input.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { connect } from './spacesd.mjs';

const name = process.argv[2] ?? 'mv-pc-mac-1';
const asShell = process.argv[3] !== 'inside';
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
  (JSON.parse(await c.callJson('/cua.env.v1.WindowsService/ListWindows', '{}')).windows ?? []).map((w) => w.title);

const script = `#!/bin/bash
echo $$ > ~/.mv/mirror2.pid
bye() { (sleep 0.3; osascript -e 'tell application "Terminal" to close (every window whose custom title is "Shell: ada")') >/dev/null 2>&1 & exit 0; }
trap bye TERM INT HUP
mkdir -p ~/.mv && touch ~/.mv/shell.log
printf '\\n\\033[1;36m── ada sat down ──\\033[0m\\n' >> ~/.mv/shell.log
tail -n 200 -F ~/.mv/shell.log &
wait $!
`;
const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>name</key><string>MineVibe Shell</string>
<key>type</key><string>Window Settings</string>
<key>ProfileCurrentVersion</key><real>2.07</real>
<key>CommandString</key><string>/bin/bash /Users/lume/.mv/mirror2.sh</string>
<key>RunCommandAsShell</key>${asShell ? '<true/>' : '<false/>'}
<key>shellExitAction</key><integer>0</integer>
<key>WindowTitle</key><string>Shell: ada</string>
<key>ShowActiveProcessInTitle</key><false/>
<key>ShowDimensionsInTitle</key><false/>
<key>ShowShellCommandInTitle</key><false/>
<key>ShowRepresentedURLInTitle</key><false/>
<key>ShowTTYNameInTitle</key><false/>
<key>columnCount</key><integer>110</integer>
<key>rowCount</key><integer>32</integer>
<key>warnOnShellCloseAction</key><integer>0</integer>
</dict></plist>
`;
const b64s = Buffer.from(script).toString('base64');
const b64p = Buffer.from(plist).toString('base64');
let t0 = performance.now();
console.log(
  await sh(
    `mkdir -p ~/.mv && echo ${b64s} | base64 -d > ~/.mv/mirror2.sh && echo ${b64p} | base64 -d > ~/.mv/mirror2.terminal && open ~/.mv/mirror2.terminal && echo opened`,
  ),
);
await sleep(2500);
console.log(`after open (${Math.round(performance.now() - t0)} ms):`, await windows());
await sh(`echo 'ada@mac-1:~$ echo hello' >> ~/.mv/shell.log; echo hello >> ~/.mv/shell.log`);
await sleep(500);
t0 = performance.now();
console.log(await sh('p=$(cat ~/.mv/mirror2.pid); pkill -TERM -P "$p"; kill -TERM "$p"; echo killed $p'));
await sleep(3000);
console.log(`after kill (${Math.round(performance.now() - t0)} ms):`, await windows());
console.log(await sh('defaults read com.apple.Terminal "Window Settings" | grep -c "MineVibe Shell" ; defaults read com.apple.Terminal "Default Window Settings"'));
process.exit(0);
