// Shared helpers for the S5 spike: a timeout-wrapped `container` runner and a spacesd client.
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const SPIKE = join(dirname(fileURLToPath(import.meta.url)), "..");
export const OUT = join(SPIKE, "out");
export const VAULT = join(OUT, "vault");
export const NAME = "mv-pc-s5";
export const HOST_PORT = 43211;

// Roots outside ~/Documents (see ct.sh for why); overridable.
const SP =
  process.env.MV_CT_BASE ?? `${process.env.HOME}/Library/Application Support/MineVibe-dev/container-spike`;
export const INSTALL_ROOT = process.env.MV_CT_INSTALL_ROOT ?? `${SP}/root`;
export const APP_ROOT = process.env.MV_CT_APP_ROOT ?? `${SP}/app`;
export const CONTAINER = `${INSTALL_ROOT}/bin/container`;

/** The PC token (never printed). */
export function token() {
  return readFileSync(join(OUT, "token"), "utf8").trim();
}

/**
 * Run `container <args>` with a hard Node-side timeout (SIGKILL on overrun, apple/container#2275).
 * Resolves { code, stdout, stderr, ms, timedOut }. Never rejects.
 */
export function ct(args, { timeoutMs = 60_000, env = {}, input } = {}) {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const child = spawn(CONTAINER, args, {
      env: {
        ...process.env,
        CONTAINER_INSTALL_ROOT: INSTALL_ROOT,
        CONTAINER_APP_ROOT: APP_ROOT,
        ...env,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
      try {
        writeFileSync(
          join(OUT, "timeouts.log"),
          `${new Date().toISOString()} TIMEOUT after ${timeoutMs}ms: container ${args.join(" ")}\n`,
          { flag: "a" },
        );
      } catch {}
    }, timeoutMs);
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, ms: Math.round(performance.now() - t0), timedOut });
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: String(e), ms: Math.round(performance.now() - t0), timedOut });
    });
  });
}

/** Run a shell command inside the container via `container exec` (as root unless user given). */
export function cexec(cmd, { user, timeoutMs = 30_000, workdir } = {}) {
  const args = ["exec"];
  if (user) args.push("--user", user);
  if (workdir) args.push("--workdir", workdir);
  args.push(NAME, "sh", "-c", cmd);
  return ct(args, { timeoutMs });
}

export function save(name, data) {
  mkdirSync(OUT, { recursive: true });
  const p = join(OUT, name);
  writeFileSync(p, typeof data === "string" ? data : JSON.stringify(data, bigintSafe, 2));
  return p;
}

export function bigintSafe(_k, v) {
  return typeof v === "bigint" ? Number(v) : v;
}

export function pct(arr, p) {
  const s = [...arr].sort((a, b) => a - b);
  if (!s.length) return NaN;
  const i = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return s[i];
}

export function withTimeout(promise, ms, what) {
  let t;
  return Promise.race([
    promise.finally(() => clearTimeout(t)),
    new Promise((_, rej) => {
      t = setTimeout(() => rej(new Error(`timeout ${ms}ms: ${what}`)), ms);
    }),
  ]);
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Connect a spacesd client (does not print the token). */
export async function connectPc(url = `http://127.0.0.1:${HOST_PORT}`, { timeoutMs = 10_000 } = {}) {
  const { embedded } = await import("@trycua/cua");
  const cua = embedded();
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    return await cua.spacesd(url, token(), { signal: ac.signal });
  } finally {
    clearTimeout(t);
  }
}

export function ab(buf) {
  return Buffer.from(buf);
}
