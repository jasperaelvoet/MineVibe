// Spike S6 VM steps through the `lume serve` API (never `lume run --detach`). Usage:
//   node vm.mjs clone <name>                 APFS clone of mv-macos-base
//   node vm.mjs set <name> <cpu> <memGB>
//   node vm.mjs run <name> [--vault]         setup share (ro, env-token) [+ test Vault folders], VNC off
//   node vm.mjs wait <name>                  until running with an IP, then spacesd SERVING with our token
//   node vm.mjs stop <name> | get <name> | ls | delete <name>
// Only VMs named mv-pc-mac-* (created here) are ever stopped or deleted.
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { api, BASE, log, ROOT, sleep } from './lib.mjs';

const [cmd, name, ...rest] = process.argv.slice(2);
const OURS = /^mv-pc-mac-\d+$/;
const S = 'minevibe';
const shares = (n) => join(ROOT, 'shares', n);

function mustBeOurs(n) {
  if (!OURS.test(n ?? '')) throw new Error(`refusing to touch ${n}: not a VM this spike created`);
}

export function tokenOf(n) {
  return readFileSync(join(shares(n), 'setup', 'env-token'), 'utf8').trim();
}

export const VAULTS = {
  // Not TCC-protected (a path with a space, like real ones under Application Support).
  plain: join(ROOT, 's6', 'vault-plain'),
  // TCC-protected (~/Documents): does Virtualization's virtiofs server get to read it?
  docs: join(process.cwd(), 'out', 'vault-docs'),
};

switch (cmd) {
  case 'clone': {
    mustBeOurs(name);
    const r = await api('POST', '/lume/vms/clone', { name: BASE, newName: name, sourceLocation: S, destLocation: S }, { timeoutMs: 600_000 });
    log('clone', r.status, JSON.stringify(r.body), `${r.ms} ms`);
    break;
  }
  case 'set': {
    mustBeOurs(name);
    const [cpu, mem] = rest;
    const r = await api('PATCH', `/lume/vms/${name}`, { cpu: Number(cpu), memory: `${mem}GB`, storage: S });
    log('set', r.status, JSON.stringify(r.body), `${r.ms} ms`);
    break;
  }
  case 'run': {
    mustBeOurs(name);
    const setup = join(shares(name), 'setup');
    mkdirSync(setup, { recursive: true, mode: 0o700 });
    const tokenFile = join(setup, 'env-token');
    if (!existsSync(tokenFile) || rest.includes('--rotate')) {
      writeFileSync(tokenFile, randomBytes(24).toString('hex'), { mode: 0o600 });
      chmodSync(tokenFile, 0o600);
    }
    const dirs = [{ hostPath: setup, readOnly: true }];
    if (rest.includes('--vault')) {
      for (const v of Object.values(VAULTS)) {
        mkdirSync(v, { recursive: true });
        writeFileSync(join(v, 'from-host.txt'), `written on the host at ${new Date().toISOString()}\n`);
        dirs.push({ hostPath: v, readOnly: false });
      }
      const ro = join(ROOT, 's6', 'codex-ro');
      mkdirSync(ro, { recursive: true });
      writeFileSync(join(ro, 'page.md'), '# a read-only page\n');
      dirs.push({ hostPath: ro, readOnly: true });
    }
    const t0 = Date.now();
    const r = await api('POST', `/lume/vms/${name}/run`, { noDisplay: true, vnc: 'disabled', sharedDirectories: dirs, storage: S });
    log('run', r.status, JSON.stringify(r.body), `${r.ms} ms`);
    writeFileSync(join('out', `${name}.run.t0`), `${t0}\n`);
    break;
  }
  case 'wait': {
    mustBeOurs(name);
    const t0 = Number(readFileSync(join('out', `${name}.run.t0`), 'utf8'));
    let ip = null;
    for (;;) {
      const r = await api('GET', `/lume/vms/${name}?storage=${S}`);
      if (r.body?.status === 'running' && r.body.ipAddress) {
        ip = r.body.ipAddress;
        log(`running with ip ${ip} after ${Date.now() - t0} ms`, JSON.stringify({ vncUrl: r.body.vncUrl ?? null }));
        break;
      }
      if (Date.now() - t0 > 300_000) throw new Error(`no IP after 300 s: ${JSON.stringify(r.body)}`);
      await sleep(500);
    }
    writeFileSync(join('out', `${name}.ip`), `${ip}\n`);
    const { connect } = await import('./spacesd.mjs');
    for (;;) {
      try {
        const c = await connect(`http://${ip}:3211`, tokenOf(name), 3000);
        const h = JSON.parse(await c.health());
        if (h.status === 'HEALTH_STATUS_SERVING') {
          log(`spacesd SERVING after ${Date.now() - t0} ms`);
          break;
        }
        log('health', h.status);
      } catch (e) {
        if (Date.now() - t0 > 600_000) throw e;
      }
      await sleep(1000);
    }
    break;
  }
  case 'stop': {
    mustBeOurs(name);
    const r = await api('POST', `/lume/vms/${name}/stop`, { storage: S }, { timeoutMs: 120_000 });
    log('stop', r.status, JSON.stringify(r.body), `${r.ms} ms`);
    break;
  }
  case 'delete': {
    mustBeOurs(name);
    const r = await api('DELETE', `/lume/vms/${name}?storage=${S}`, undefined, { timeoutMs: 120_000 });
    log('delete', r.status, JSON.stringify(r.body), `${r.ms} ms`);
    break;
  }
  case 'get': {
    const r = await api('GET', `/lume/vms/${name}?storage=${S}`);
    log(JSON.stringify(r.body));
    break;
  }
  case 'ls': {
    const r = await api('GET', '/lume/vms');
    for (const v of r.body) log(JSON.stringify(v));
    break;
  }
  default:
    console.error('usage: node vm.mjs clone|set|run|wait|stop|get|ls|delete <name>');
    process.exit(2);
}
