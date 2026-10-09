// Spike S6: what repairs a stale name lookup (a host rename-replace leaves the guest with ENOENT for a listed name)?
// Tries, in order: `ls -l` of the entry, a host-side touch of the folder, 30 s of waiting, and an unmount + remount of
// the automounted share (the only reset left).
//   node coherence3.mjs <vm> <host folder shared as /Volumes/My Shared Files/<basename>>
import { renameSync, utimesSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { guest, sleep } from './g.mjs';

const [name, dir] = process.argv.slice(2);
const { sh } = await guest(name);
const share = `/Volumes/My Shared Files/${basename(dir)}`;
const q = (s) => `'${s.replace(/'/g, `'\\''`)}'`;
const view = async (f) => (await sh(`cat ${q(`${share}/${f}`)} 2>&1`)).out.trim();

writeFileSync(join(dir, 's1.txt'), 's1 v1\n');
await sleep(200);
console.log('warm:', await view('s1.txt'));
writeFileSync(join(dir, 's1.tmp'), 's1 v2\n');
renameSync(join(dir, 's1.tmp'), join(dir, 's1.txt'));
await sleep(200);
console.log('stale:', await view('s1.txt'));
await sh(`ls -la ${q(share)} >/dev/null; ls -l ${q(`${share}/s1.txt`)}`);
console.log('after guest ls -l:', await view('s1.txt'));
const now = new Date();
utimesSync(dir, now, now);
await sleep(300);
console.log('after host touch of the folder:', await view('s1.txt'));
await sleep(30_000);
console.log('after 30 s:', await view('s1.txt'));
const m = await sh(
  `sudo -n umount ${q('/Volumes/My Shared Files')} 2>&1; echo umount=$?; sudo -n mkdir -p ${q('/Volumes/My Shared Files')}; sudo -n mount_virtiofs -u lume -g staff com.apple.virtio-fs.automount ${q('/Volumes/My Shared Files')} 2>&1; echo mount=$?; mount | grep -i virtio`,
);
console.log(`remount (${m.ms} ms):`, m.out.replace(/\n/g, ' | '));
console.log('after remount:', await view('s1.txt'));
process.exit(0);
