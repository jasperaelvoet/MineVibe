/**
 * S9 (PC tools V2, P0 probe): boots one labelled Linux PC through PcManager and keeps it up until `<out>/stop`
 * appears (or SIGINT/SIGTERM), then decommissions it and removes everything carrying its per-run label.
 *
 * Run from the repo root:
 *   node --conditions=source --import tsx spikes/s9-pc-tools-v2/boot.ts <outDir>
 *
 * Writes `<outDir>/endpoint.json` ({pcId, url, tokenFile}); the token itself stays in the 0600 token file under the
 * state dir and is never printed. Probe scripts connect with that endpoint.
 */
import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findRepoRoot } from '../../apps/server/src/config/paths.js';
import { AppleContainerDriver } from '../../apps/server/src/pcs/drivers/AppleContainerDriver.js';
import {
  ContainerRuntime,
  devContainerRoots,
  readContainerLock,
} from '../../apps/server/src/pcs/drivers/ContainerRuntime.js';
import { MANAGED_LABEL } from '../../apps/server/src/pcs/drivers/PcDriver.js';
import { PcManager } from '../../apps/server/src/pcs/PcManager.js';
import { LINUX_PC_IMAGE_DEV } from '../../apps/server/src/pcs/PcTypes.js';
import { SpacesdPool } from '../../apps/server/src/pcs/SpacesdPool.js';

const out = realpathSync(process.argv[2] ?? '.');
mkdirSync(out, { recursive: true });
const RUN = `${process.pid.toString(36)}${Date.now().toString(36).slice(-4)}`;
const LABEL = `pc-test-s9-${RUN}`;
const ID = `s9-${process.pid.toString(36)}`;
const repo = findRepoRoot(fileURLToPath(import.meta.url)) as string;
const roots = devContainerRoots();
const sleep = (n: number) => new Promise((r) => setTimeout(r, n));

const lock = await readContainerLock(join(repo, 'packaging', 'vendor.lock.json'));
const runtime = new ContainerRuntime({
  ...roots,
  lock,
  cacheDir: join(homedir(), 'Library', 'Caches', 'MineVibe-dev', 'vendor'),
  leaseHolder: `s9 probe ${RUN}`,
});
const driver = new AppleContainerDriver(runtime);
await runtime.provision((m) => console.log(`[s9] ${m}`));
const engineBefore = (await runtime.status()).ownership;
console.log(`[s9] engine before: ${engineBefore}`);
await driver.ensureEngine();
if (!(await driver.imageExists(LINUX_PC_IMAGE_DEV))) {
  console.log('[s9] building the image');
  await driver.buildImage({
    contextDir: join(repo, 'images', 'linux-pc'),
    file: join(repo, 'images', 'linux-pc', 'Containerfile'),
    tag: LINUX_PC_IMAGE_DEV,
  });
}
const state = join(out, 'state');
const vault = join(out, 'vault');
mkdirSync(vault, { recursive: true });
writeFileSync(join(vault, 'notes.md'), '# Notes\n\nfirst line\n');
const pool = new SpacesdPool({ cachesDir: join(out, 'caches') });
await pool.module();
const manager = new PcManager({
  stateDir: state,
  driver,
  pool,
  labelValue: LABEL,
  diskPath: roots.appRoot,
  bootTimeoutMs: 180_000,
});
await manager.init({ createDefault: false });

let cleaned = false;
async function cleanup(): Promise<void> {
  if (cleaned) return;
  cleaned = true;
  try {
    if (manager.get(ID)) await manager.decommission(ID).catch((e) => console.log(`[s9] decommission: ${e}`));
    for (const c of await driver.list({ [MANAGED_LABEL]: LABEL })) await driver.remove(c.name);
    for (const v of await driver.listVolumes({ [MANAGED_LABEL]: LABEL })) await driver.removeVolume(v.name);
    for (const n of await driver.listNetworks({ [MANAGED_LABEL]: LABEL })) await driver.removeNetwork(n.name);
    console.log(`[s9] leftover containers: ${(await driver.list({ [MANAGED_LABEL]: LABEL })).length}`);
    await manager.shutdown({ stopEngine: false });
    if (engineBefore === 'not_running') console.log(`[s9] engine stopped: ${await runtime.releaseAndStopIfUnused()}`);
    else await runtime.leases.release();
  } catch (e) {
    console.log(`[s9] cleanup failed: ${e}`);
  }
}
process.on('SIGINT', () => void cleanup().then(() => process.exit(130)));
process.on('SIGTERM', () => void cleanup().then(() => process.exit(143)));

try {
  const t0 = performance.now();
  await manager.create({ type: 'linux', id: ID, mounts: [{ host: vault }], boot: true });
  console.log(`[s9] create to SERVING: ${Math.round(performance.now() - t0)} ms`);
  const rec = manager.get(ID);
  writeFileSync(
    join(out, 'endpoint.json'),
    JSON.stringify({
      pcId: ID,
      url: `http://127.0.0.1:${rec?.hostPort}`,
      tokenFile: join(state, 'pc-tokens', `${ID}.token`),
      vault,
    }),
  );
  console.log('[s9] READY');
  const maxMs = Number(process.env.S9_MAX_MS ?? 4 * 3600_000);
  const end = Date.now() + maxMs;
  while (!existsSync(join(out, 'stop')) && Date.now() < end) await sleep(1000);
} finally {
  await cleanup();
  console.log('[s9] DONE');
}
