// Spike S6 helpers: MineVibe's dev Lume (outside ~/Documents, PLAN §8.6), a `lume serve` child on a random
// loopback port with its config, cache and temp files under MineVibe-dev/lume, and a tiny API client.
// Tokens are never printed.
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const HERE = dirname(fileURLToPath(import.meta.url));
export const OUT = join(HERE, 'out');
export const ROOT = join(homedir(), 'Library', 'Application Support', 'MineVibe-dev', 'lume');
export const VERSION = '0.6.1';
export const BIN = join(ROOT, 'install', VERSION, 'lume.app', 'Contents', 'MacOS', 'lume');
export const VMS = join(ROOT, 'vms');
export const BASE = 'mv-macos-base';
export const IMAGE = 'macos:26-20261003-a7b1e34';

export function lumeEnv() {
  return {
    ...process.env,
    LUME_TELEMETRY_ENABLED: '0',
    LUME_UPDATE_CHECK: '0',
    XDG_CONFIG_HOME: join(ROOT, 'config'),
    XDG_CACHE_HOME: join(ROOT, 'xdg-cache'),
    TMPDIR: `${join(ROOT, 'tmp')}/`,
  };
}

export function writeConfig() {
  for (const d of ['config/lume', 'vms', 'tmp', 'cache', 'xdg-cache']) mkdirSync(join(ROOT, d), { recursive: true });
  writeFileSync(
    join(ROOT, 'config', 'lume', 'config.yaml'),
    `# Lume Configuration (MineVibe spike S6)\n\ndefaultLocationName: "minevibe"\ncacheDirectory: "${join(ROOT, 'cache')}"\ncachingEnabled: false\ntelemetryEnabled: false\n\n# VM Locations\nvmLocations:\n  - name: "minevibe"\n    path: "${VMS}"\n`,
  );
}

export function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

export function port() {
  return Number(readFileSync(join(OUT, 'serve.port'), 'utf8').trim());
}

export async function api(method, path, body, { timeoutMs = 30_000 } = {}) {
  const t0 = performance.now();
  const res = await fetch(`http://127.0.0.1:${port()}${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, body: json, ms: Math.round(performance.now() - t0) };
}

export function lume(args, { timeoutMs = 60_000 } = {}) {
  return new Promise((resolve) => {
    const c = spawn(BIN, args, { env: lumeEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    c.stdout.on('data', (d) => (out += d));
    c.stderr.on('data', (d) => (err += d));
    const t = setTimeout(() => c.kill('SIGKILL'), timeoutMs);
    c.on('close', (code) => {
      clearTimeout(t);
      resolve({ code, out, err });
    });
  });
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
