import { spawnSync } from 'node:child_process';
import {
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
import { type ContainerLock, ContainerRuntime } from '../../src/pcs/drivers/ContainerRuntime.js';
import { EngineLeases, type LeaseRecord } from '../../src/pcs/drivers/EngineLeases.js';
import { type ExecFn, type ExecResult, execWithTimeout } from '../../src/pcs/drivers/exec.js';

const ok = (stdout = '', code = 0): ExecResult => ({
  code,
  signal: null,
  stdout,
  stderr: '',
  ms: 1,
  timedOut: false,
});

let dir: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'mv-lease-')));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const leaseFiles = (d: string) => readdirSync(d).filter((f) => f.endsWith('.json'));
const writeLease = (d: string, name: string, rec: LeaseRecord) => {
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, name), JSON.stringify(rec));
};
/** A pid that existed a moment ago and is gone now. */
const deadPid = () => spawnSync('/usr/bin/true').pid as number;

describe('N4: engine leases', () => {
  it('a lease records the pid and its process start time; release removes it', async () => {
    const l = new EngineLeases({ dir, holder: 'unit' });
    await l.acquire();
    await l.acquire(); // idempotent
    const files = leaseFiles(dir);
    expect(files).toHaveLength(1);
    const rec = JSON.parse(readFileSync(join(dir, files[0] as string), 'utf8')) as LeaseRecord;
    expect(rec).toMatchObject({ pid: process.pid, holder: 'unit' });
    expect(rec.started).toMatch(/\d\d:\d\d:\d\d \d{4}/);
    expect(await l.others()).toEqual([]);
    await l.release();
    expect(leaseFiles(dir)).toEqual([]);
  });

  it('a live lease counts; a dead pid and a reused pid (other start time) are stale and removed', async () => {
    const l = new EngineLeases({ dir });
    const parentStart = await l.processStart(process.ppid);
    expect(typeof parentStart).toBe('string');
    writeLease(dir, 'live.json', { pid: process.ppid, started: parentStart as string, holder: 'dev', at: 1 });
    writeLease(dir, 'dead.json', {
      pid: deadPid(),
      started: 'Thu Jan  1 00:00:00 1970',
      holder: 'old',
      at: 1,
    });
    writeLease(dir, 'reused.json', {
      pid: process.pid,
      started: 'Thu Jan  1 00:00:00 1970',
      holder: 'pid-reuse',
      at: 1,
    });
    writeFileSync(join(dir, 'garbage.json'), '{nope');
    expect((await l.others()).map((o) => o.holder)).toEqual(['dev']);
    expect(leaseFiles(dir)).toEqual(['live.json']);
  });

  it('a lease whose liveness cannot be told counts as live (never stop under someone)', async () => {
    const l = new EngineLeases({ dir, liveness: async () => 'unknown' });
    writeLease(dir, 'x.json', { pid: 1, started: null, holder: 'x', at: 1 });
    expect(await l.others()).toHaveLength(1);
  });

  it('withLock serializes holders and breaks the lock of a dead holder', async () => {
    const a = new EngineLeases({ dir });
    const b = new EngineLeases({ dir });
    const order: string[] = [];
    let releaseA: () => void = () => {};
    const heldA = a.withLock(async () => {
      order.push('a-in');
      await new Promise<void>((r) => {
        releaseA = r;
      });
      order.push('a-out');
    });
    while (!order.includes('a-in')) await new Promise((r) => setTimeout(r, 5));
    const heldB = b.withLock(async () => {
      order.push('b');
    });
    await new Promise((r) => setTimeout(r, 150));
    expect(order).toEqual(['a-in']);
    releaseA();
    await Promise.all([heldA, heldB]);
    expect(order).toEqual(['a-in', 'a-out', 'b']);
    // A lock left by a process that died is broken.
    writeFileSync(
      join(dir, 'engine.lock'),
      JSON.stringify({ pid: deadPid(), started: 'x', holder: 'gone', at: 1 }),
    );
    const t0 = Date.now();
    await b.withLock(async () => {});
    expect(Date.now() - t0).toBeLessThan(2000);
    // A live holder that never lets go makes a waiter give up after its timeout.
    const c = new EngineLeases({ dir, lockTimeoutMs: 100 });
    const started = await c.processStart(process.ppid);
    writeFileSync(
      join(dir, 'engine.lock'),
      JSON.stringify({ pid: process.ppid, started, holder: 'busy', at: 1 }),
    );
    await expect(c.withLock(async () => {})).rejects.toThrow(/starting or stopping the container system/);
  });
});

describe('N4: the engine is stopped only when no other live MineVibe uses it', () => {
  const lock: ContainerLock = {
    version: '1.5.0',
    pkg: { name: 'container.pkg', url: 'https://invalid.example/container.pkg', sha256: 'a'.repeat(64) },
  };
  function runtime() {
    const roots = { appRoot: join(dir, 'app'), installRoot: join(dir, 'root') };
    mkdirSync(join(roots.installRoot, 'bin'), { recursive: true });
    writeFileSync(join(roots.installRoot, 'bin', 'container'), '#!/bin/sh\n');
    const status = JSON.stringify({
      status: 'running',
      paths: { appRoot: roots.appRoot, installRoot: roots.installRoot },
      server: { version: '1.5.0' },
    });
    const calls: string[][] = [];
    const exec: ExecFn = async (_file, args) => {
      calls.push([...args]);
      return args[0] === 'system' && args[1] === 'status' ? ok(status) : ok();
    };
    // Leases ask the real `ps`; the container CLI is faked.
    const rt = new ContainerRuntime({
      ...roots,
      lock,
      cacheDir: dir,
      exec,
      leases: { exec: execWithTimeout },
    });
    return { rt, calls, leaseDir: join(roots.appRoot, 'minevibe-leases') };
  }
  const stops = (calls: string[][]) => calls.filter((c) => c[0] === 'system' && c[1] === 'stop').length;

  it('a dev server quitting while another one runs leaves the engine (and its PCs) alone', async () => {
    const { rt, calls, leaseDir } = runtime();
    await rt.startAndLease();
    expect(rt.leases.held).toBe(true);
    expect(leaseFiles(leaseDir)).toHaveLength(1);
    const started = await rt.leases.processStart(process.ppid);
    writeLease(leaseDir, 'other.json', {
      pid: process.ppid,
      started: started as string,
      holder: 'dev-2',
      at: 1,
    });
    expect(await rt.releaseAndStopIfUnused()).toBe(false);
    expect(stops(calls)).toBe(0);
    expect(leaseFiles(leaseDir)).toEqual(['other.json']);
    // The other one is gone now (its lease is stale): the last one out stops the engine.
    writeLease(leaseDir, 'other.json', {
      pid: deadPid(),
      started: started as string,
      holder: 'dev-2',
      at: 1,
    });
    await rt.startAndLease();
    expect(await rt.releaseAndStopIfUnused()).toBe(true);
    expect(stops(calls)).toBe(1);
    expect(leaseFiles(leaseDir)).toEqual([]);
  });

  it('provision refuses to replace an install root another live MineVibe still uses', async () => {
    const { rt, calls, leaseDir } = runtime();
    const started = await rt.leases.processStart(process.ppid);
    writeLease(leaseDir, 'other.json', {
      pid: process.ppid,
      started: started as string,
      holder: 'dev-2',
      at: 1,
    });
    const pkg = join(dir, 'container.pkg');
    writeFileSync(pkg, 'the pkg');
    const { createHash } = await import('node:crypto');
    const sha = (t: string) => createHash('sha256').update(t).digest('hex');
    const rt2 = new ContainerRuntime({
      appRoot: rt.appRoot,
      installRoot: rt.installRoot,
      lock: {
        version: '1.5.0',
        pkg: { name: 'container.pkg', url: 'https://invalid.example/x', sha256: sha('the pkg') },
        installRootFiles: { 'bin/container': sha('new binary') },
      },
      cacheDir: dir,
      pkgPath: pkg,
      exec: async (file, args) => {
        if (file === '/usr/sbin/pkgutil' && args[0] === '--expand-full') {
          const out = args[2] as string;
          mkdirSync(join(out, 'Payload', 'bin'), { recursive: true });
          writeFileSync(join(out, 'Payload', 'bin', 'container'), 'new binary');
        }
        calls.push([...args]);
        return ok();
      },
      leases: { exec: execWithTimeout },
    });
    await expect(rt2.provision()).rejects.toMatchObject({ code: 'ENGINE_IN_USE' });
    expect(stops(calls)).toBe(0);
    expect(readFileSync(join(rt.installRoot, 'bin', 'container'), 'utf8')).toBe('#!/bin/sh\n');
  });
});
