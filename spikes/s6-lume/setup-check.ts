// Spike S6: runs the server's macOS guest setup and refresh scripts (apps/server/src/pcs/macGuest.ts) on a spike VM.
//   node --import tsx setup-check.ts <vm> <host folder shared under its basename>
import { writeFileSync, renameSync } from 'node:fs';
import { basename, join } from 'node:path';
import {
  MAC_REFRESH_SCRIPT,
  MAC_SETUP_SCRIPT,
  macSetupArgs,
  parseSetupOutput,
} from '../../apps/server/src/pcs/macGuest.js';
// @ts-ignore spike helper
import { guest, sleep } from './g.mjs';

const [name, dir] = process.argv.slice(2) as [string, string];
const { sh, c } = await guest(name);
const links = [{ share: { name: basename(dir), hostPath: dir, readOnly: false }, guestPath: dir }];
const run = async (script: string, args: string[], env: Record<string, string>) => {
  const t0 = performance.now();
  const o = await c.run({
    program: 'bash',
    args: ['-c', script, 'setup', ...args],
    env: new Map(Object.entries({ HOME: '/Users/lume', ...env })),
    user: 'lume',
    stdin: false,
    timeoutMs: 60_000,
  });
  return {
    code: o.exit.code,
    ms: Math.round(performance.now() - t0),
    out: Buffer.from(o.stdout).toString('utf8'),
    err: Buffer.from(o.stderr).toString('utf8'),
  };
};
const s = await run(MAC_SETUP_SCRIPT, macSetupArgs(links), { MV_RG: '', MV_CODEX: '' });
console.log('setup', s.code, `${s.ms} ms`, parseSetupOutput(s.out), s.err.trim().slice(0, 300));
console.log((await sh(`ls -la ${JSON.stringify(dir)} | head -3; cat /var/db/minevibe/links`)).out);
// A rename-replace on the host, then the refresh.
writeFileSync(join(dir, 'rr.txt'), 'v1\n');
await sleep(200);
console.log('warm', (await sh(`cat ${JSON.stringify(join(dir, 'rr.txt'))} 2>&1`)).out.trim());
writeFileSync(join(dir, 'rr.tmp'), 'v2\n');
renameSync(join(dir, 'rr.tmp'), join(dir, 'rr.txt'));
await sleep(200);
console.log('stale', (await sh(`cat ${JSON.stringify(join(dir, 'rr.txt'))} 2>&1`)).out.trim());
const r = await run(MAC_REFRESH_SCRIPT, [], {});
console.log('refresh', r.code, `${r.ms} ms`, r.out.trim(), r.err.trim());
console.log('after', (await sh(`cat ${JSON.stringify(join(dir, 'rr.txt'))} 2>&1; mount | grep -i virtio`)).out.trim());
// Busy: a process with its cwd in the share keeps it mounted; the refresh only purges.
await sh(`cd ${JSON.stringify(dir)} && (nohup sleep 20 >/dev/null 2>&1 &)`);
await sleep(500);
const b = await run(MAC_REFRESH_SCRIPT, [], {});
console.log('refresh while busy', b.code, `${b.ms} ms`, b.out.trim());
process.exit(0);
