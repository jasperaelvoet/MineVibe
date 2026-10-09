// Spike S6: which stale views of host edits `sudo purge` in the guest repairs (rename-replace, delete, new files), and
// what it costs. Also: does a guest `ls` see host-side creates and deletes at once?
//   node coherence2.mjs <vm> <host folder shared as /Volumes/My Shared Files/<basename>>
import { renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { guest, sleep } from './g.mjs';

const [name, dir] = process.argv.slice(2);
const { sh } = await guest(name);
const share = `/Volumes/My Shared Files/${basename(dir)}`;
const q = (s) => `'${s.replace(/'/g, `'\\''`)}'`;
const view = async (f) => (await sh(`cat ${q(`${share}/${f}`)} 2>&1`)).out.trim();
const ls = async () => (await sh(`ls ${q(share)} | grep -E '^(r|n|x)[0-9]' | tr '\\n' ' '`)).out.trim();

writeFileSync(join(dir, 'r1.txt'), 'r1 v1\n');
writeFileSync(join(dir, 'x1.txt'), 'x1 v1\n');
await sleep(200);
console.log('warm:', await view('r1.txt'), '|', await view('x1.txt'), '| ls:', await ls());
writeFileSync(join(dir, 'r1.tmp'), 'r1 v2 renamed\n');
renameSync(join(dir, 'r1.tmp'), join(dir, 'r1.txt'));
rmSync(join(dir, 'x1.txt'));
writeFileSync(join(dir, 'n1.txt'), 'n1 new\n');
await sleep(200);
console.log('after host rename/delete/create:', JSON.stringify(await view('r1.txt')), '|', JSON.stringify(await view('x1.txt')), '| ls:', await ls(), '| new:', await view('n1.txt'));
const p = await sh('sudo -n purge; echo $?');
console.log(`purge ${p.out.trim()} in ${p.ms} ms`);
console.log('after purge:', JSON.stringify(await view('r1.txt')), '|', JSON.stringify(await view('x1.txt')), '| ls:', await ls());
// Cost of purge with a warm cache: time a guest build-ish read before/after.
const t = await sh('time (find /usr/share -type f 2>/dev/null | head -3000 | xargs cat >/dev/null 2>&1) 2>&1 | grep real; sudo -n purge; time (find /usr/share -type f 2>/dev/null | head -3000 | xargs cat >/dev/null 2>&1) 2>&1 | grep real');
console.log('warm read vs after purge:', t.out.replace(/\n/g, ' '));
process.exit(0);
