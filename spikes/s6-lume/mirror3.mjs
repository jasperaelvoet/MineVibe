// Spike S6: ShellMirror on macOS without Apple events. A `.terminal` settings document (CommandString, shellExitAction
// 0 = close the window when its command exits) opens a titled Terminal window that runs the tail; closing kills the
// tail's script by its MV_MIRROR environment (`ps -E`, no /proc on macOS). Does the window go away by itself, and how
// fast? Also lists what `ps` shows of the mirror's processes.
//   node mirror3.mjs <vm>
import { guest, sleep } from './g.mjs';

const name = process.argv[2] ?? 'mv-pc-mac-3';
const { c, sh } = await guest(name);
const windows = async () =>
  (JSON.parse(await c.callJson('/cua.env.v1.WindowsService/ListWindows', '{}')).windows ?? []).map((w) => w.title);
const pc = 'mac-9';
const script = `#!/bin/bash
mkdir -p ~/.mv && touch ~/.mv/shell.log
printf '\\n\\033[1;36m── %s sat down at %s ──\\033[0m\\n' "$1" "$2" >> ~/.mv/shell.log
exec tail -n 200 -F ~/.mv/shell.log
`;
const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>name</key><string>MineVibe Shell</string>
<key>type</key><string>Window Settings</string>
<key>ProfileCurrentVersion</key><real>2.07</real>
<key>CommandString</key><string>/usr/bin/env MV_MIRROR=${pc} /bin/bash /Users/lume/.mv/mirror3.sh ada ${pc}</string>
<key>RunCommandAsShell</key><true/>
<key>shellExitAction</key><integer>0</integer>
<key>WindowTitle</key><string>Shell: ada</string>
<key>ShowActiveProcessInTitle</key><false/>
<key>ShowDimensionsInTitle</key><false/>
<key>ShowShellCommandInTitle</key><false/>
<key>ShowRepresentedURLInTitle</key><false/>
<key>ShowTTYNameInTitle</key><false/>
<key>ShowCommandKeyInTitle</key><false/>
<key>ShowWindowSettingsNameInTitle</key><false/>
<key>columnCount</key><integer>110</integer>
<key>rowCount</key><integer>32</integer>
<key>warnOnShellCloseAction</key><integer>0</integer>
</dict></plist>
`;
const b64s = Buffer.from(script).toString('base64');
const b64p = Buffer.from(plist).toString('base64');
let t0 = performance.now();
const o = await sh(
  `mkdir -p ~/.mv && echo ${b64s} | base64 -d > ~/.mv/mirror3.sh && echo ${b64p} | base64 -d > ~/.mv/mirror3.terminal && open ~/.mv/mirror3.terminal && echo opened`,
);
console.log(o.out.trim(), o.err.trim());
for (let i = 0; i < 10; i++) {
  await sleep(500);
  const w = await windows();
  if (w.includes('Shell: ada')) {
    console.log(`window up after ${Math.round(performance.now() - t0)} ms:`, w);
    break;
  }
}
await sh(`echo 'ada@${pc}:~$ echo hello' >> ~/.mv/shell.log; echo hello >> ~/.mv/shell.log`);
await sleep(800);
const ps = await sh(`ps -wwE -o pid=,ppid=,user=,command= | grep -F 'MV_MIRROR=${pc}' | grep -v grep | cut -c1-160`);
console.log('ps -E finds:\n' + ps.out);
t0 = performance.now();
const k = await sh(
  `pids=$(ps -wwE -o pid=,command= | grep -F 'MV_MIRROR=${pc}' | grep -v grep | awk '{print $1}'); echo killing $pids; kill -TERM $pids`,
);
console.log(k.out.trim(), k.err.trim());
for (let i = 0; i < 20; i++) {
  await sleep(250);
  const w = await windows();
  if (!w.includes('Shell: ada')) {
    console.log(`window gone ${Math.round(performance.now() - t0)} ms after the kill:`, w);
    break;
  }
  if (i === 19) console.log('window still there after 5 s:', w);
}
process.exit(0);
