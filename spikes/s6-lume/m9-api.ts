// M9 debugging: raw `lume serve` API calls on MineVibe's dev Lume (the serve is started and stopped around them).
//   node --import tsx m9-api.ts 'GET /lume/vms' 'GET /lume/vms?storage=minevibe' …
import { homedir } from 'node:os';
import { join } from 'node:path';
import { devLumeRoot, LumeRuntime, loadLumeLocks } from '../../apps/server/src/pcs/drivers/LumeRuntime.js';

const locks = loadLumeLocks([join(import.meta.dirname, '..', '..', 'packaging', 'vendor.lock.json')]);
if (!locks) throw new Error('no lume locks');
const runtime = new LumeRuntime({
  root: devLumeRoot(),
  locks,
  cacheDir: join(homedir(), 'Library', 'Caches', 'MineVibe-dev', 'vendor'),
  leaseHolder: 'm9-api',
});
await runtime.provision();
await runtime.startAndLease({ keep: () => true });
try {
  for (const call of process.argv.slice(2)) {
    const [method, path, body] = call.split(' ');
    const r = await runtime.api(method as string, path as string, body ? JSON.parse(body) : undefined);
    console.log(call, '→', r.status, JSON.stringify(r.body).slice(0, 600));
  }
} finally {
  console.log('serve stopped:', await runtime.releaseAndStopIfUnused());
}
process.exit(0);
