// Spike S6: a graceful stop. Asks the guest to shut down (`sudo shutdown -h now` through spacesd), then polls the serve
// API until the VM reports stopped; prints the time. A GET that hangs is cut at 5 s and counted.
//   node shutdown.mjs <vm> [password]
import { api, log, sleep } from './lib.mjs';
import { guest } from './g.mjs';

const [name, pw] = process.argv.slice(2);
if (!/^mv-pc-mac-\d+$/.test(name ?? '')) throw new Error('not a spike VM');
const { sh } = await guest(name);
const t0 = Date.now();
const r = await sh(pw ? `echo ${pw} | sudo -S -p '' shutdown -h now 2>&1` : 'sudo -n shutdown -h now 2>&1', { timeoutMs: 10_000 }).catch(
  (e) => ({ out: String(e) }),
);
log('shutdown asked:', r.out.trim().slice(0, 120));
let slow = 0;
for (;;) {
  const g = await api('GET', `/lume/vms/${name}?storage=minevibe`, undefined, { timeoutMs: 5_000 }).catch(() => null);
  if (!g) slow++;
  if (g?.body?.status === 'stopped') {
    log(`stopped ${Date.now() - t0} ms after the request (${slow} GETs over 5 s)`);
    break;
  }
  if (Date.now() - t0 > 180_000) {
    log('not stopped after 180 s', JSON.stringify(g?.body?.status));
    break;
  }
  await sleep(500);
}
process.exit(0);
