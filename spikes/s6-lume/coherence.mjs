// Spike S6: does the guest see host edits of a shared (virtiofs) folder? In-place rewrites vs rename-replace, the
// guest's view right away and after a while, and what makes a stale view refresh.
//   node coherence.mjs <vm> <host folder shared as /Volumes/My Shared Files/<basename>>
import { renameSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { guest, sleep } from './g.mjs';

const [name, dir] = process.argv.slice(2);
const { sh } = await guest(name);
const share = `/Volumes/My Shared Files/${basename(dir)}`;
const q = (s) => `'${s.replace(/'/g, `'\\''`)}'`;
const view = async (f) => (await sh(`cat ${q(`${share}/${f}`)} 2>&1`)).out.trim();

async function check(label, f, write, want) {
  write();
  const t0 = Date.now();
  const first = await view(f);
  let fresh = first === want ? 0 : null;
  for (let i = 0; fresh === null && i < 40; i++) {
    await sleep(500);
    if ((await view(f)) === want) fresh = Date.now() - t0;
  }
  console.log(
    `${label.padEnd(34)} first=${JSON.stringify(first).slice(0, 40).padEnd(42)} fresh=${fresh === null ? 'NOT within 20 s' : `${fresh} ms`}`,
  );
  return fresh;
}

const inplace = (f, s) => () => writeFileSync(join(dir, f), s);
const rename = (f, s) => () => {
  writeFileSync(join(dir, `${f}.tmp`), s);
  renameSync(join(dir, `${f}.tmp`), join(dir, f));
};

// Warm the guest's cache of each file first (the case that matters: the agent read it before the player edited it).
for (const f of ['a.txt', 'b.txt', 'c.txt', 'd.txt']) {
  writeFileSync(join(dir, f), `${f} v1\n`);
}
await sleep(300);
for (const f of ['a.txt', 'b.txt', 'c.txt', 'd.txt']) await view(f);

await check('in place, same size', 'a.txt', inplace('a.txt', 'a.txt v2\n'), 'a.txt v2');
await check('in place, longer', 'b.txt', inplace('b.txt', 'b.txt v2 longer\n'), 'b.txt v2 longer');
await check('rename-replace (new inode)', 'c.txt', rename('c.txt', 'c.txt v2 renamed\n'), 'c.txt v2 renamed');
// What refreshes a stale page cache: the guest's own `purge` (sudo), or reopening after the host bumps mtime?
inplace('d.txt', 'd.txt v2 xx\n')();
await sleep(200);
console.log('stale d.txt:', JSON.stringify(await view('d.txt')), 'host mtime', statSync(join(dir, 'd.txt')).mtimeMs);
const p = await sh('sudo -n purge 2>&1; echo purge=$?');
console.log('after sudo purge:', JSON.stringify(await view('d.txt')), p.out.trim(), `${p.ms} ms`);
inplace('d.txt', 'd.txt v3 yy\n')();
const n = await sh(`cat -u ${q(`${share}/d.txt`)} >/dev/null; dd if=${q(`${share}/d.txt`)} bs=4k 2>/dev/null; echo; stat -f '%z %m' ${q(`${share}/d.txt`)}`);
console.log('dd after a host rewrite:', JSON.stringify(n.out.trim()));
process.exit(0);
