// Spike S6 / M9 debugging: runs a shell script as `lume` in any running MineVibe VM of the dev Lume root, finding the
// serve from <root>/serve/serve.json and the token in the VM's setup share (never printed).
//   node vmsh.mjs <vm> <script>
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './lib.mjs';
import { connect } from './spacesd.mjs';

const [name, script] = process.argv.slice(2);
const serve = JSON.parse(readFileSync(join(ROOT, 'serve', 'serve.json'), 'utf8'));
const vm = await (await fetch(`http://127.0.0.1:${serve.port}/lume/vms/${name}?storage=minevibe`)).json();
const token = readFileSync(join(ROOT, 'shares', name, 'setup', 'env-token'), 'utf8').trim();
const c = await connect(`http://${vm.ipAddress}:3211`, token);
const o = await c.run({
  program: 'bash',
  args: ['-c', script],
  env: new Map([['HOME', '/Users/lume']]),
  user: 'lume',
  stdin: false,
  timeoutMs: 60_000,
});
process.stdout.write(Buffer.from(o.stdout).toString('utf8'));
process.stderr.write(Buffer.from(o.stderr).toString('utf8'));
console.log(`[exit ${o.exit.code}]`);
process.exit(0);
