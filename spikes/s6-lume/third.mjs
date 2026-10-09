// Spike S6: Apple's limit of two running macOS VMs. With <first> already running, starts <second> and then <third>
// through the serve API and reports what the API shows for the refused one (the run call itself answers 202 before
// the VM starts), polling GET for 20 s.
//   node third.mjs <second> <third>
import { mkdirSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { api, log, ROOT, sleep } from './lib.mjs';

const S = 'minevibe';
for (const name of process.argv.slice(2)) {
  if (!/^mv-pc-mac-\d+$/.test(name)) throw new Error('not a spike VM');
  const setup = join(ROOT, 'shares', name, 'setup');
  mkdirSync(setup, { recursive: true, mode: 0o700 });
  writeFileSync(join(setup, 'env-token'), randomBytes(24).toString('hex'), { mode: 0o600 });
  const t0 = Date.now();
  const r = await api('POST', `/lume/vms/${name}/run`, {
    noDisplay: true,
    vnc: 'disabled',
    sharedDirectories: [{ hostPath: setup, readOnly: true }],
    storage: S,
  });
  log(name, 'run', r.status, JSON.stringify(r.body));
  writeFileSync(join('out', `${name}.run.t0`), `${t0}\n`);
  let last = '';
  for (let i = 0; i < 40; i++) {
    const g = await api('GET', `/lume/vms/${name}?storage=${S}`);
    const s = `${g.status} status=${g.body?.status} ip=${g.body?.ipAddress ?? null} prov=${JSON.stringify(g.body?.provisioningOperation ?? null)}`;
    if (s !== last) log(name, `+${Date.now() - t0} ms`, s, `(${g.ms} ms)`);
    last = s;
    if (g.body?.ipAddress) break;
    await sleep(500);
  }
}
process.exit(0);
