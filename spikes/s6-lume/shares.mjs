// Spike S6: how Lume names shares in the guest, and whether a share can be given its name through a symlink.
// Restarts <vm> (stop through the API, then run) with: setup (ro), two folders that share a basename (`dup`), a symlink
// named `vlink` pointing at a real folder, and a read-only folder; then lists /Volumes/My Shared Files. Times the stop
// and the start to SERVING.
//   node shares.mjs <vm>
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { api, log, ROOT, sleep } from './lib.mjs';
import { guest } from './g.mjs';

const name = process.argv[2] ?? 'mv-pc-mac-1';
if (!/^mv-pc-mac-\d+$/.test(name)) throw new Error('not a spike VM');
const S = 'minevibe';
const base = join(ROOT, 's6', 'shares-test');
rmSync(base, { recursive: true, force: true });
for (const d of ['one/dup', 'two/dup', 'real', 'links']) mkdirSync(join(base, d), { recursive: true });
writeFileSync(join(base, 'one/dup/which.txt'), 'one\n');
writeFileSync(join(base, 'two/dup/which.txt'), 'two\n');
writeFileSync(join(base, 'real/which.txt'), 'real (through the vlink symlink)\n');
symlinkSync(join(base, 'real'), join(base, 'links', 'vlink'));

let t0 = Date.now();
const st = await api('POST', `/lume/vms/${name}/stop`, { storage: S }, { timeoutMs: 120_000 });
log('stop', st.status, JSON.stringify(st.body), `${Date.now() - t0} ms`);
const dirs = [
  { hostPath: join(ROOT, 'shares', name, 'setup'), readOnly: true },
  { hostPath: join(base, 'one/dup'), readOnly: false },
  { hostPath: join(base, 'two/dup'), readOnly: false },
  { hostPath: join(base, 'links', 'vlink'), readOnly: false },
];
t0 = Date.now();
const r = await api('POST', `/lume/vms/${name}/run`, { noDisplay: true, vnc: 'disabled', sharedDirectories: dirs, storage: S });
log('run', r.status, JSON.stringify(r.body));
let ip = null;
while (!ip) {
  const g = await api('GET', `/lume/vms/${name}?storage=${S}`);
  if (g.body?.status === 'running' && g.body.ipAddress) ip = g.body.ipAddress;
  else await sleep(500);
}
log(`ip ${ip} after ${Date.now() - t0} ms`);
let g;
for (;;) {
  try {
    g = await guest(name);
    const h = JSON.parse(await g.c.health());
    if (h.status === 'HEALTH_STATUS_SERVING') break;
  } catch {}
  await sleep(1000);
}
log(`SERVING after ${Date.now() - t0} ms`);
const o = await g.sh(
  `cd "/Volumes/My Shared Files" && for d in *; do printf '%s -> %s\\n' "$d" "$(cat "$d/which.txt" 2>/dev/null || ls "$d" | head -3 | tr '\\n' ' ')"; done; echo w > vlink/w.txt && echo vlink-write-ok`,
);
console.log(o.out, o.err);
process.exit(0);
