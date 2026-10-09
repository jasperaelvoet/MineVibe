import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type ExecFn, execWithTimeout } from '../../src/pcs/drivers/exec.js';
import {
  type LumeLocks,
  LumeRuntime,
  loadLumeLocks,
  logFields,
  parseLumeLog,
  SERVE_SUPERVISOR,
  VM_LIMIT_RE,
} from '../../src/pcs/drivers/LumeRuntime.js';
import { FakeLume } from './fakeLume.js';

const sha = (b: string | Buffer) => createHash('sha256').update(b).digest('hex');

/** A stand-in `lume.app` (files only; the signature checks are faked). */
function makeApp(dir: string, binary = '#!/bin/sh\nwhile :; do sleep 1; done\n'): Record<string, string> {
  const files: Record<string, string> = {
    'Contents/MacOS/lume': binary,
    'Contents/Info.plist': '<plist/>\n',
    'Contents/_CodeSignature/CodeResources': 'signed\n',
  };
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(join(dir, rel, '..'), { recursive: true });
    writeFileSync(join(dir, rel), body);
  }
  chmodSync(join(dir, 'Contents/MacOS/lume'), 0o755);
  return Object.fromEntries(Object.entries(files).map(([rel, body]) => [rel, sha(body)]));
}

function locksFor(appFiles: Record<string, string>, archive?: Buffer): LumeLocks {
  return {
    lume: {
      version: '0.6.1',
      url: 'https://example.invalid/lume-0.6.1-darwin-arm64.tar.gz',
      size: archive?.byteLength ?? 1,
      sha256: archive ? sha(archive) : 'a'.repeat(64),
      teamId: 'YCK386LBJ7',
      notarized: true,
      appFiles,
    },
    image: {
      ref: 'ghcr.io/trycua/macos:26-test',
      lumeRef: 'macos:26-test',
      digest: `sha256:${'a'.repeat(64)}`,
      downloadBytes: 1e9,
      diskBytes: 2e9,
    },
  };
}

/** codesign and spctl answers (everything else runs for real: tar, ps). */
function signing(opts: { team?: string; notarized?: boolean; valid?: boolean } = {}): ExecFn & {
  calls: string[];
} {
  const calls: string[] = [];
  const fn: ExecFn = async (file, args, options) => {
    const base = { signal: null, ms: 1, timedOut: false };
    if (file === '/usr/bin/codesign' && args[0] === '--verify') {
      calls.push('codesign --verify');
      return opts.valid === false
        ? { ...base, code: 1, stdout: '', stderr: 'a sealed resource is missing or invalid' }
        : { ...base, code: 0, stdout: '', stderr: '' };
    }
    if (file === '/usr/bin/codesign') {
      calls.push('codesign -dv');
      return { ...base, code: 0, stdout: '', stderr: `TeamIdentifier=${opts.team ?? 'YCK386LBJ7'}\n` };
    }
    if (file === '/usr/sbin/spctl') {
      calls.push('spctl');
      return opts.notarized === false
        ? { ...base, code: 3, stdout: '', stderr: 'rejected\nsource=Unnotarized Developer ID' }
        : { ...base, code: 0, stdout: '', stderr: 'accepted\nsource=Notarized Developer ID' };
    }
    return execWithTimeout(file, args, options);
  };
  return Object.assign(fn, { calls });
}

let dir: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'mv-lumert-')));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('the serve log', () => {
  it('reads VM ends and failed starts (with spaces in values, progress bars on \\r)', () => {
    const ev = parseLumeLog(
      [
        '[2026-10-09T10:00:01Z] INFO: VM lifecycle ended name=mv-pc-a',
        '\rDownloading 10%\rDownloading 20%',
        '[2026-10-09T10:00:05Z] ERROR: Failed in VM.run name=mv-pc-b error=The number of virtual machines exceeds the limit. The maximum supported number of active virtual machines has been reached. errorType=NSError',
        '[2026-10-09T10:00:07Z] INFO: VM lifecycle ended name=mv-pc-a',
      ].join('\n'),
    );
    expect(ev.ended.get('mv-pc-a')).toBe(Date.parse('2026-10-09T10:00:07Z'));
    const f = ev.failed.get('mv-pc-b');
    expect(f?.at).toBe(Date.parse('2026-10-09T10:00:05Z'));
    expect(VM_LIMIT_RE.test(f?.message ?? '')).toBe(true);
    expect(f?.message).not.toContain('errorType');
    expect(logFields('name=a b error=x y=z')).toEqual({ name: 'a b', error: 'x', y: 'z' });
  });
});

describe('pins', () => {
  it('takes the first vendor.lock.json with valid Lume and image pins', () => {
    const bad = join(dir, 'bad.json');
    const good = join(dir, 'good.json');
    writeFileSync(bad, JSON.stringify({ lume: { sha256: 'nope' } }));
    const l = locksFor({ 'Contents/MacOS/lume': 'b'.repeat(64) });
    writeFileSync(good, JSON.stringify({ lume: l.lume, images: { 'cua-macos': l.image } }));
    expect(loadLumeLocks([join(dir, 'missing.json'), bad])).toBeNull();
    expect(loadLumeLocks([bad, good])?.lume.version).toBe('0.6.1');
  });
});

describe('provisioning the notarized lume.app', () => {
  it('verifies every file, the signature, the team and the notarization; refuses anything else', async () => {
    const app = join(dir, 'lume.app');
    const files = makeApp(app);
    const exec = signing();
    const rt = new LumeRuntime({ root: join(dir, 'root'), locks: locksFor(files), cacheDir: dir, exec });
    await rt.verifyApp(app);
    expect(exec.calls).toEqual(['codesign --verify', 'codesign -dv', 'spctl']);
    const fails = async (e: ExecFn, l = locksFor(files)) =>
      new LumeRuntime({ root: join(dir, 'root'), locks: l, cacheDir: dir, exec: e }).verifyApp(app).then(
        () => 'ok',
        (err: Error) => err.message,
      );
    expect(await fails(signing({ team: 'OTHER12345' }))).toMatch(/signed by team OTHER12345/);
    expect(await fails(signing({ notarized: false }))).toMatch(/not accept it as notarized/);
    expect(await fails(signing({ valid: false }))).toMatch(/codesign --verify failed/);
    expect(await fails(signing(), locksFor({ ...files, 'Contents/Info.plist': 'c'.repeat(64) }))).toMatch(
      /Info\.plist sha256/,
    );
    writeFileSync(join(app, 'Contents', 'extra.dylib'), 'x');
    expect(await fails(signing())).toMatch(/unexpected file Contents\/extra\.dylib/);
  });

  it('downloads the pinned archive once (size and sha256), extracts and installs it under the root', async () => {
    const src = join(dir, 'src');
    const files = makeApp(join(src, 'lume.app'));
    execFileSync('/usr/bin/tar', ['-czf', join(dir, 'lume.tgz'), '-C', src, 'lume.app']);
    const archive = readFileSync(join(dir, 'lume.tgz'));
    let downloads = 0;
    const fetchImpl = (async () => {
      downloads++;
      return new Response(archive);
    }) as unknown as typeof fetch;
    const root = join(dir, 'root');
    const mk = (a = archive) =>
      new LumeRuntime({
        root,
        locks: locksFor(files, a),
        cacheDir: join(dir, 'cache'),
        exec: signing(),
        fetchImpl,
      });
    const rt = mk();
    const progress: string[] = [];
    await rt.provision((m) => progress.push(m));
    expect(existsSync(rt.bin)).toBe(true);
    expect(rt.bin).toBe(join(root, 'install', '0.6.1', 'lume.app', 'Contents', 'MacOS', 'lume'));
    expect(progress[0]).toBe('downloading Lume 0.6.1');
    expect(await rt.isProvisioned()).toBe(true);
    // Installed and cached: a new process verifies, nothing is downloaded again.
    await mk().provision();
    expect(downloads).toBe(1);
    rmSync(join(root, 'install'), { recursive: true });
    await mk().provision();
    expect(downloads).toBe(1);
    // An archive that is not the pinned one is refused and nothing is installed.
    rmSync(join(root, 'install'), { recursive: true });
    const other = Buffer.concat([archive, Buffer.from('x')]);
    const wrong = new LumeRuntime({
      root,
      locks: { ...locksFor(files), lume: { ...locksFor(files, archive).lume, sha256: sha(other) } },
      cacheDir: join(dir, 'cache2'),
      exec: signing(),
      fetchImpl,
    });
    await expect(wrong.provision()).rejects.toMatchObject({ code: 'VERIFY_FAILED' });
    expect(existsSync(join(root, 'install', '0.6.1', 'lume.app'))).toBe(false);
  });

  it('refuses a root in a TCC-protected folder and a bundled app that is not the pinned one', async () => {
    const files = makeApp(join(dir, 'Bundle.app', 'lume.app'));
    const tcc = new LumeRuntime({
      root: join(dir, 'home', 'Documents', 'lume'),
      locks: locksFor(files),
      cacheDir: dir,
    });
    expect(() => tcc.assertRootUsable(join(dir, 'home'))).toThrow(/TCC|Documents/);
    const bundled = new LumeRuntime({
      root: join(dir, 'root'),
      locks: locksFor({ ...files, 'Contents/MacOS/lume': 'd'.repeat(64) }),
      cacheDir: dir,
      bundledApp: join(dir, 'Bundle.app', 'lume.app'),
      exec: signing(),
    });
    await expect(bundled.provision()).rejects.toMatchObject({ code: 'NOT_PROVISIONED' });
  });
});

describe('lume serve: leases, the reaper and the lifeline', () => {
  /** A root whose `lume` is a stand-in that just runs, answering through FakeLume. */
  function serveRoot() {
    const root = join(dir, 'root');
    const fake = new FakeLume(root);
    const files = makeApp(join(root, 'install', '0.6.1', 'lume.app'));
    return { root, fake, files };
  }
  const supervisorOf = (root: string) =>
    (JSON.parse(readFileSync(join(root, 'serve', 'serve.json'), 'utf8')) as { pid: number; port: number })
      .pid;
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const until = async (cond: () => boolean, ms: number) => {
    const end = Date.now() + ms;
    while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 100));
    return cond();
  };

  it('two processes share one serve; the last to leave stops it', async () => {
    const { root, fake, files } = serveRoot();
    const mk = (pid?: number) =>
      new LumeRuntime({
        root,
        locks: locksFor(files),
        cacheDir: dir,
        fetchImpl: fake.fetch as typeof fetch,
        ...(pid ? { leases: { pid } } : {}),
      });
    // "Another process": a live child holds the second lease.
    const other = spawn('/bin/sleep', ['60'], { stdio: 'ignore' });
    try {
      const a = mk();
      const b = mk(other.pid as number);
      await a.startAndLease();
      const sup = supervisorOf(root);
      expect(alive(sup)).toBe(true);
      expect(a.port).toBeGreaterThan(1024);
      // The supervisor runs the stand-in as `<bin> serve --port <port>` in its own process group.
      const ps = execFileSync('/bin/ps', ['-o', 'pgid=,command=', '-p', String(sup)], { encoding: 'utf8' });
      expect(Number(ps.trim().split(/\s+/)[0])).toBe(sup);
      expect(ps).toContain(a.bin);
      expect(SERVE_SUPERVISOR).toContain('"$bin" serve --port "$port"');
      expect(readdirSync(join(root, 'config', 'lume'))).toEqual(['config.yaml']);
      const cfg = readFileSync(join(root, 'config', 'lume', 'config.yaml'), 'utf8');
      expect(cfg).toContain('telemetryEnabled: false');
      expect(cfg).toContain(`path: ${JSON.stringify(join(root, 'vms'))}`);
      expect(a.env()).toMatchObject({ LUME_TELEMETRY_ENABLED: '0', XDG_CONFIG_HOME: join(root, 'config') });
      await b.startAndLease();
      expect(b.port).toBe(a.port);
      expect(supervisorOf(root)).toBe(sup);
      expect(await a.releaseAndStopIfUnused()).toBe(false);
      expect(alive(sup)).toBe(true);
      expect(await b.releaseAndStopIfUnused()).toBe(true);
      expect(await until(() => !alive(sup), 5_000)).toBe(true);
      expect(existsSync(join(root, 'serve', 'serve.json'))).toBe(false);
    } finally {
      other.kill();
    }
  });

  it('the reaper stops running MineVibe VMs nobody claims, never one without a sidecar or a kept one', async () => {
    const { root, fake, files } = serveRoot();
    for (const name of ['mv-pc-dead-mac-1', 'mv-pc-mine-mac-1', 'mv-pc-x-nosidecar', 'other-vm']) {
      fake.addVm(name, { status: 'running', ip: '192.168.65.9' });
      if (name !== 'mv-pc-x-nosidecar')
        writeFileSync(join(root, 'vms', name, 'minevibe.json'), '{"labels":{}}');
    }
    const rt = new LumeRuntime({
      root,
      locks: locksFor(files),
      cacheDir: dir,
      fetchImpl: fake.fetch as typeof fetch,
    });
    await rt.startAndLease({ keep: (vm) => vm.startsWith('mv-pc-mine-') });
    expect(fake.calls.filter((c) => c.endsWith('/stop'))).toEqual(['POST /lume/vms/mv-pc-dead-mac-1/stop']);
    // The list takes no storage query (0.6.1 answers 404 to one).
    expect(fake.calls).toContain('GET /lume/vms');
    await rt.releaseAndStopIfUnused();
  });

  it('the lifeline: once no lease names a live process, the supervisor stops the serve by itself', async () => {
    const { root, fake, files } = serveRoot();
    const rt = new LumeRuntime({
      root,
      locks: locksFor(files),
      cacheDir: dir,
      fetchImpl: fake.fetch as typeof fetch,
    });
    await rt.startAndLease();
    const sup = supervisorOf(root);
    // As if this process had died without letting go: its lease is gone, nobody stops the serve.
    for (const f of readdirSync(join(root, 'minevibe-leases'))) rmSync(join(root, 'minevibe-leases', f));
    expect(await until(() => !alive(sup), 20_000)).toBe(true);
    expect(readFileSync(join(root, 'serve', 'serve.log'), 'utf8')).toContain(
      'no MineVibe process uses this lume serve',
    );
  }, 30_000);
});
