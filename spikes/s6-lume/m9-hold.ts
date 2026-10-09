// M9 debugging: boots one macOS PC through the real PcManager + LumeMacDriver and holds it until `out/m9-hold.stop`
// exists (or SIGTERM), then decommissions it and lets go of Lume. While it holds, `node vmsh.mjs <vm> '<script>'` runs
// commands in the guest and `out/m9-hold.json` names the VM (never the token).
//   node --import tsx m9-hold.ts [--codex]
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { LumeMacDriver } from '../../apps/server/src/pcs/drivers/LumeMacDriver.js';
import { devLumeRoot, LumeRuntime, loadLumeLocks } from '../../apps/server/src/pcs/drivers/LumeRuntime.js';
import { PcManager } from '../../apps/server/src/pcs/PcManager.js';
import { SpacesdPool } from '../../apps/server/src/pcs/SpacesdPool.js';
import { FakeDriver } from '../../apps/server/test/pcs/fakes.js';
import { pino } from 'pino';

const out = join(import.meta.dirname, 'out');
mkdirSync(out, { recursive: true });
const stopFile = join(out, 'm9-hold.stop');
rmSync(stopFile, { force: true });
const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'mv-m9hold-')));
const vault = join(tmp, 'Code', 'demo');
mkdirSync(vault, { recursive: true });
writeFileSync(join(vault, 'hello.txt'), 'hello\n');
const locks = loadLumeLocks([join(import.meta.dirname, '..', '..', 'packaging', 'vendor.lock.json')]);
if (!locks) throw new Error('no lume locks');
const t00 = Date.now();
const logger = pino({ level: process.env.LOG_LEVEL ?? 'info', timestamp: () => `,"t":${Date.now() - t00}` });
const runtime = new LumeRuntime({
  root: devLumeRoot(),
  locks,
  cacheDir: join(homedir(), 'Library', 'Caches', 'MineVibe-dev', 'vendor'),
  leaseHolder: 'm9-hold',
  logger,
});
const pool = new SpacesdPool({ cachesDir: join(tmp, 'caches') });
await pool.module();
const m = new PcManager({
  stateDir: join(tmp, 'state'),
  driver: new FakeDriver(),
  macDriver: new LumeMacDriver(runtime, { logger }),
  logger,
  pool,
  labelValue: 'pc-hold',
  diskPath: devLumeRoot(),
  bootTimeoutMs: 240_000,
});
await m.init({ createDefault: false });
const ID = 'hold';
let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  await m.decommission(ID).catch((e) => console.log('decommission', String(e)));
  await m.shutdown();
  rmSync(tmp, { recursive: true, force: true });
  rmSync(join(out, 'm9-hold.json'), { force: true });
  console.log('stopped');
  process.exit(0);
};
process.on('SIGTERM', () => void stop());
process.on('SIGINT', () => void stop());
try {
  const t0 = performance.now();
  await m.create({ type: 'macos', id: ID, mounts: [{ host: vault }], boot: true });
  console.log('running after', Math.round(performance.now() - t0), 'ms', m.status(ID));
  writeFileSync(join(out, 'm9-hold.json'), JSON.stringify({ vm: m.containerNameOf(ID), vault }, null, 2));
  for (;;) {
    if (existsSync(stopFile)) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
} catch (err) {
  console.log('failed', err);
}
await stop();
