// M9 debugging: removes what the M9 debugging tools and test runs left in MineVibe's dev Lume storage: VMs labelled
// `minevibe=pc-hold`, `pc-dbg` or `pc-test-*` (never anything else, never the base image), then lets go of the serve.
//   node --import tsx m9-clean.ts [--dry-run]
import { homedir } from 'node:os';
import { join } from 'node:path';
import { LumeMacDriver } from '../../apps/server/src/pcs/drivers/LumeMacDriver.js';
import { devLumeRoot, LumeRuntime, loadLumeLocks } from '../../apps/server/src/pcs/drivers/LumeRuntime.js';

const dry = process.argv.includes('--dry-run');
const locks = loadLumeLocks([join(import.meta.dirname, '..', '..', 'packaging', 'vendor.lock.json')]);
if (!locks) throw new Error('no lume locks');
const runtime = new LumeRuntime({
  root: devLumeRoot(),
  locks,
  cacheDir: join(homedir(), 'Library', 'Caches', 'MineVibe-dev', 'vendor'),
  leaseHolder: 'm9-clean',
});
const mac = new LumeMacDriver(runtime);
// Keep everything running: only what is listed below is removed.
await mac.ensureEngine({ keep: () => true });
try {
  for (const vm of await mac.list({})) {
    const label = vm.labels.minevibe ?? '';
    if (!/^(pc-hold|pc-dbg|pc-test-[a-z0-9]+)$/.test(label)) {
      console.log('keep', vm.name, label, vm.state);
      continue;
    }
    console.log(dry ? 'would remove' : 'remove', vm.name, label, vm.state);
    if (!dry) await mac.remove(vm.name);
  }
} finally {
  console.log('serve stopped:', await mac.shutdownEngine());
}
process.exit(0);
