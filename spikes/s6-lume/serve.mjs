// Starts `lume serve` as this process's child on a random loopback port (PLAN §8.1) and keeps it running until
// SIGINT/SIGTERM; VMs started through the API live in the serve process, so they stop with it.
// Its output goes straight to out/serve.log (a file descriptor, not a pipe through Node: a pipe that stops being read
// would block the serve's logging), unbuffered (NSUnbufferedIO), so a failed VM start shows at once.
import { spawn } from 'node:child_process';
import { mkdirSync, openSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BIN, freePort, log, lumeEnv, OUT, writeConfig } from './lib.mjs';

mkdirSync(OUT, { recursive: true });
writeConfig();
const port = await freePort();
const fd = openSync(join(OUT, 'serve.log'), 'a');
const child = spawn(BIN, ['serve', '--port', String(port)], {
  env: { ...lumeEnv(), NSUnbufferedIO: 'YES' },
  stdio: ['ignore', fd, fd],
});
writeFileSync(join(OUT, 'serve.port'), `${port}\n`);
writeFileSync(join(OUT, 'serve.pid'), `${child.pid}\n`);
log(`lume serve pid ${child.pid} on 127.0.0.1:${port}`);
const stop = (sig) => {
  log(`got ${sig}; stopping lume serve`);
  child.kill('SIGTERM');
  setTimeout(() => child.kill('SIGKILL'), 20_000).unref();
};
process.on('SIGINT', () => stop('SIGINT'));
process.on('SIGTERM', () => stop('SIGTERM'));
child.on('exit', (code, signal) => {
  log(`lume serve exited code=${code} signal=${signal}`);
  rmSync(join(OUT, 'serve.port'), { force: true });
  process.exit(0);
});
