// The Swift stub (apps/launcher-mac/MineVibe.swift), compiled once and driven against a fake Node.
// macOS only (needs swiftc and a window server session for the AppKit mode).
import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

const repoRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');

function haveSwiftc(): boolean {
  if (process.platform !== 'darwin') return false;
  try {
    execFileSync('xcrun', ['--find', 'swiftc'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** A fake Node: speaks the stub protocol and records what it receives. */
const FAKE_MAIN = `
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const mode = process.env.FAKE_NODE_MODE ?? 'ok';
const record = (s) => appendFileSync(process.env.FAKE_NODE_LOG, s + '\\n');
const selftest = process.argv.includes('--selftest');
record('start ' + process.pid + ' ' + process.execArgv.join(' ') + ' ' + process.argv.slice(2).join(' ') + ' bundle=' + process.env.MINEVIBE_APP_BUNDLE + ' options=' + (process.env.NODE_OPTIONS ?? ''));
const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
if (mode !== 'silent') {
  process.stdout.write('this line is not NDJSON\\n');
  send({ t: 'hello', v: 1, mode: selftest ? 'selftest' : 'app', server: 'fake', node: process.version, pid: process.pid });
}
const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const cmd = JSON.parse(line);
  record(('cmd ' + cmd.cmd + ' ' + (cmd.reason ?? '')).trim());
  if (cmd.cmd === 'hello' && selftest) {
    send({ t: 'selftest', ok: mode !== 'fail', checks: [{ name: 'fake', ok: mode !== 'fail', detail: 'checked' }] });
  }
  if (cmd.cmd === 'hello' && mode === 'progress') {
    send({ t: 'progress', phase: 'install', work: false, title: 'Checking' });
    send({ t: 'ready' });
  }
  if (cmd.cmd === 'shutdown' && mode !== 'stubborn') {
    record('exiting');
    process.exit(selftest ? (mode === 'fail' ? 1 : 0) : 130);
  }
});
rl.on('close', () => {
  record('eof');
  if (mode !== 'stubborn') process.exit(0);
});
if (mode === 'exit0') setTimeout(() => { record('game closed'); process.exit(0); }, 300);
setInterval(() => {}, 1000);
`;

const INFO_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>MineVibe</string>
<key>CFBundleIdentifier</key><string>dev.minevibe.stubtest</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>9.8.7</string>
<key>LSUIElement</key><true/>
</dict></plist>
`;

/** Sends the standard quit Apple Event (what logout and restart send) to an app by pid. */
const QUIT_HELPER = `
import AppKit
guard let pid = Int32(CommandLine.arguments[1]), let app = NSRunningApplication(processIdentifier: pid) else { exit(1) }
exit(app.terminate() ? 0 : 1)
`;

const tmpDirs: string[] = [];
const children: ChildProcess[] = [];
let stub = '';
let quitHelper = '';

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function until(fn: () => boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!fn()) {
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** A throwaway bundle around the compiled stub; returns the paths a test needs. */
function makeBundle() {
  const root = mkdtempSync(join(tmpdir(), 'mv-stub-'));
  tmpDirs.push(root);
  const bundle = join(root, 'MineVibe.app');
  mkdirSync(join(bundle, 'Contents', 'MacOS'), { recursive: true });
  mkdirSync(join(bundle, 'Contents', 'Resources', 'server', 'dist'), { recursive: true });
  writeFileSync(join(bundle, 'Contents', 'Info.plist'), INFO_PLIST);
  execFileSync('cp', [stub, join(bundle, 'Contents', 'MacOS', 'MineVibe')]);
  symlinkSync(process.execPath, join(bundle, 'Contents', 'MacOS', 'node'));
  writeFileSync(join(bundle, 'Contents', 'Resources', 'server', 'dist', 'main.mjs'), FAKE_MAIN);
  const home = join(root, 'home');
  const nodeLog = join(root, 'node.log');
  writeFileSync(nodeLog, '');
  return { bundle, exe: join(bundle, 'Contents', 'MacOS', 'MineVibe'), home, nodeLog };
}

function startStub(
  exe: string,
  args: string[],
  env: Record<string, string>,
): { child: ChildProcess; out: () => string; exit: Promise<number | null> } {
  const child = spawn(exe, args, {
    env: { ...process.env, NODE_OPTIONS: '--inspect=0', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  let out = '';
  child.stdout?.on('data', (d: Buffer) => {
    out += d.toString();
  });
  child.stderr?.on('data', (d: Buffer) => {
    out += d.toString();
  });
  const exit = new Promise<number | null>((r) => child.on('exit', (code) => r(code)));
  return { child, out: () => out, exit };
}

const nodePid = (log: string): number => Number(/^start (\d+)/m.exec(readFileSync(log, 'utf8'))?.[1] ?? 0);

describe.skipIf(!haveSwiftc())('MineVibe stub', () => {
  beforeAll(() => {
    const dir = mkdtempSync(join(tmpdir(), 'mv-stub-build-'));
    tmpDirs.push(dir);
    stub = join(dir, 'MineVibe');
    execFileSync('xcrun', [
      'swiftc',
      '-O',
      '-parse-as-library',
      '-target',
      'arm64-apple-macos26.0',
      '-o',
      stub,
      join(repoRoot, 'apps', 'launcher-mac', 'MineVibe.swift'),
    ]);
    writeFileSync(join(dir, 'quit.swift'), QUIT_HELPER);
    quitHelper = join(dir, 'quit');
    execFileSync('xcrun', ['swiftc', '-O', '-o', quitHelper, join(dir, 'quit.swift')]);
  });

  afterEach(() => {
    for (const c of children.splice(0)) if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL');
  });

  afterAll(() => {
    for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('prints its bundle version', () => {
    const { exe } = makeBundle();
    expect(execFileSync(exe, ['--version']).toString().trim()).toBe('9.8.7');
  });

  it('refuses TCC-protected folders and translocation, and accepts the rest', () => {
    const { exe } = makeBundle();
    const verdict = (path: string) => {
      try {
        return { code: 0, out: execFileSync(exe, ['--check-location', path]).toString().trim() };
      } catch (err) {
        const e = err as { status: number; stdout: Buffer };
        return { code: e.status, out: e.stdout.toString().trim() };
      }
    };
    const home = homedir();
    expect(verdict(join(home, 'Documents', 'MineVibe', 'dist', 'MineVibe.app'))).toEqual({
      code: 3,
      out: 'protected: Documents',
    });
    expect(verdict(join(home, 'Desktop', 'MineVibe.app')).out).toBe('protected: Desktop');
    expect(verdict(join(home, 'Downloads', 'MineVibe.app')).out).toBe('protected: Downloads');
    expect(verdict(join(home, 'DOCUMENTS', 'MineVibe.app')).out).toBe('protected: Documents');
    expect(
      verdict(join(home, 'Library', 'Mobile Documents', 'com~apple~CloudDocs', 'MineVibe.app')).out,
    ).toBe('protected: iCloud Drive');
    expect(verdict('/Volumes/USB/MineVibe.app').out).toBe('protected: an external or network volume');
    expect(verdict('/private/var/folders/ab/xyz/T/AppTranslocation/1234/d/MineVibe.app').out).toBe(
      'translocated',
    );
    expect(verdict('/Applications/MineVibe.app')).toEqual({ code: 0, out: 'ok' });
    expect(verdict(join(home, 'Applications', 'MineVibe.app')).out).toBe('ok');
    expect(verdict(join(home, 'Library', 'Caches', 'MineVibe-dev', 'app-test', 'MineVibe.app')).out).toBe(
      'ok',
    );
    expect(verdict(join(home, 'Documentsx', 'MineVibe.app')).out).toBe('ok');
  });

  it('--selftest: handshake, checks and a clean Node exit', async () => {
    const { exe, home, nodeLog } = makeBundle();
    const run = startStub(exe, ['--selftest'], { MINEVIBE_HOME: home, FAKE_NODE_LOG: nodeLog });
    expect(await run.exit).toBe(0);
    expect(run.out()).toMatch(/hello from node v\d+/);
    expect(run.out()).toContain('ok   fake: checked');
    expect(run.out()).toMatch(/\[selftest\] OK \(hello after \d+ ms/);
    const log = readFileSync(nodeLog, 'utf8');
    expect(log).toMatch(/^start \d+ --enable-source-maps app --selftest bundle=/m);
    expect(log).toMatch(/options=$/m); // NODE_OPTIONS never reaches the bundled Node
    expect(log).toContain('cmd hello');
    expect(log).toContain('cmd shutdown selftest');
  });

  it('--selftest fails on a failed check and on a Node that never says hello', async () => {
    const failing = makeBundle();
    const a = startStub(failing.exe, ['--selftest'], {
      MINEVIBE_HOME: failing.home,
      FAKE_NODE_LOG: failing.nodeLog,
      FAKE_NODE_MODE: 'fail',
    });
    expect(await a.exit).toBe(1);
    expect(a.out()).toContain('FAIL fake');

    const silent = makeBundle();
    const t = Date.now();
    const b = startStub(silent.exe, ['--selftest'], {
      MINEVIBE_HOME: silent.home,
      FAKE_NODE_LOG: silent.nodeLog,
      FAKE_NODE_MODE: 'silent',
      MINEVIBE_STUB_HANDSHAKE_S: '1',
    });
    expect(await b.exit).toBe(1);
    expect(Date.now() - t).toBeLessThan(10_000);
    expect(b.out()).toContain('no hello from node');
    await until(() => !isAlive(nodePid(silent.nodeLog)));
  });

  it('app: SIGTERM sends shutdown, Node exits, the stub exits 0 and logs it', async () => {
    const { exe, home, nodeLog, bundle } = makeBundle();
    const run = startStub(exe, [], {
      MINEVIBE_HOME: home,
      FAKE_NODE_LOG: nodeLog,
      FAKE_NODE_MODE: 'progress',
    });
    await until(() => readFileSync(nodeLog, 'utf8').includes('cmd hello'));
    expect(readFileSync(nodeLog, 'utf8')).toContain(`bundle=${bundle}`);
    run.child.kill('SIGTERM');
    expect(await run.exit).toBe(0);
    const log = readFileSync(nodeLog, 'utf8');
    expect(log).toContain('cmd shutdown sigterm');
    expect(log).toContain('exiting');
    expect(isAlive(nodePid(nodeLog))).toBe(false);
    const launcherLog = readFileSync(join(home, 'Logs', 'launcher.log'), 'utf8');
    expect(launcherLog).toContain('node started');
    expect(launcherLog).toContain('shutdown (sigterm)');
    expect(launcherLog).toContain('this line is not NDJSON'); // ignored, but logged
    expect(launcherLog).toMatch(/node exited \(code 130\)/);
  });

  it('app: the quit Apple Event (logout) shuts Node down before the stub quits', async () => {
    const { exe, home, nodeLog } = makeBundle();
    const run = startStub(exe, [], { MINEVIBE_HOME: home, FAKE_NODE_LOG: nodeLog });
    await until(() => readFileSync(nodeLog, 'utf8').includes('cmd hello'));
    execFileSync(quitHelper, [String(run.child.pid)]);
    expect(await run.exit).toBe(0);
    expect(readFileSync(nodeLog, 'utf8')).toContain('cmd shutdown quit');
    expect(isAlive(nodePid(nodeLog))).toBe(false);
  });

  it('app: a Node that ignores shutdown is killed after the grace period', async () => {
    const { exe, home, nodeLog } = makeBundle();
    const run = startStub(exe, [], {
      MINEVIBE_HOME: home,
      FAKE_NODE_LOG: nodeLog,
      FAKE_NODE_MODE: 'stubborn',
      MINEVIBE_STUB_GRACE_S: '1',
    });
    await until(() => readFileSync(nodeLog, 'utf8').includes('cmd hello'));
    const t = Date.now();
    run.child.kill('SIGTERM');
    expect(await run.exit).toBe(0);
    expect(Date.now() - t).toBeGreaterThanOrEqual(900);
    expect(isAlive(nodePid(nodeLog))).toBe(false);
    expect(readFileSync(join(home, 'Logs', 'launcher.log'), 'utf8')).toContain('SIGKILL');
  });

  it('app: Node reads EOF when the stub dies (the lifeline)', async () => {
    const { exe, home, nodeLog } = makeBundle();
    const run = startStub(exe, [], { MINEVIBE_HOME: home, FAKE_NODE_LOG: nodeLog });
    await until(() => readFileSync(nodeLog, 'utf8').includes('cmd hello'));
    run.child.kill('SIGKILL');
    await run.exit;
    await until(() => readFileSync(nodeLog, 'utf8').includes('eof'));
    await until(() => !isAlive(nodePid(nodeLog)));
  });

  it('app: when Node exits by itself (the game closed), the stub exits 0', async () => {
    const { exe, home, nodeLog } = makeBundle();
    const run = startStub(exe, [], { MINEVIBE_HOME: home, FAKE_NODE_LOG: nodeLog, FAKE_NODE_MODE: 'exit0' });
    expect(await run.exit).toBe(0);
    expect(readFileSync(nodeLog, 'utf8')).toContain('game closed');
    expect(existsSync(join(home, 'Logs', 'launcher.log'))).toBe(true);
  });
});
