import { describe, expect, it } from 'vitest';
import {
  AppleContainerDriver,
  bindMountArg,
  buildAppleRunArgs,
  buildVolumeCreateArgs,
  parseAppleContainer,
} from '../../src/pcs/drivers/AppleContainerDriver.js';
import type { ContainerRuntime } from '../../src/pcs/drivers/ContainerRuntime.js';
import { buildDockerRunArgs, parseDockerInspect } from '../../src/pcs/drivers/DockerDriver.js';
import type { ExecResult } from '../../src/pcs/drivers/exec.js';
import { assertRunSpec, mountProblems, type PcRunSpec } from '../../src/pcs/drivers/PcDriver.js';

const TOKEN = 'deadbeefcafebabe0123456789abcdef0123456789abcdef';
const VAULT = '/Users/me/Code/foo';
const DOCS = '/Users/me/Code/docs';

function spec(over: Partial<PcRunSpec> = {}): PcRunSpec {
  return {
    name: 'mv-pc-linux-1',
    image: 'minevibe/linux-pc:dev',
    cpus: 2,
    memoryMiB: 4096,
    shmMiB: 2048,
    hostPort: 43211,
    binds: [
      { source: VAULT, target: VAULT, readonly: false },
      { source: DOCS, target: DOCS, readonly: true },
    ],
    volumes: [
      { name: 'mv-pc-linux-1-ov-abc', target: `${VAULT}/node_modules`, sizeGiB: 16 },
      { name: 'mv-pc-linux-1-home', target: '/home/cua', sizeGiB: 32 },
    ],
    labels: { minevibe: 'pc', 'minevibe.pc': 'linux-1' },
    env: { MV_CHOWN_PATHS: `${VAULT}/node_modules` },
    secretEnv: { CUA_ENV_TOKEN: TOKEN },
    ...over,
  };
}

describe('Apple container run arguments (PLAN §8.1/§8.6)', () => {
  const args = buildAppleRunArgs(spec());
  const joined = args.join(' ');

  it('uses --mount type=bind,…,readonly for read-only Vault folders (path-identical)', () => {
    expect(args).toContain(`type=bind,source=${DOCS},target=${DOCS},readonly`);
    expect(args).toContain(`type=bind,source=${VAULT},target=${VAULT}`);
    expect(bindMountArg({ source: '/a', target: '/a', readonly: true })).toBe(
      'type=bind,source=/a,target=/a,readonly',
    );
  });

  it('never uses -v and never the :ro suffix', () => {
    expect(args).not.toContain('-v');
    expect(args).not.toContain('--volume');
    expect(args.some((a) => /:ro$|:ro,|:readonly$/.test(a))).toBe(false);
  });

  it('publishes spacesd on loopback only', () => {
    const i = args.indexOf('-p');
    expect(args[i + 1]).toBe('127.0.0.1:43211:3211');
    expect(args.filter((a) => a === '-p')).toHaveLength(1);
  });

  it('passes the token by name only (inherited from the CLI env)', () => {
    expect(joined).not.toContain(TOKEN);
    const i = args.indexOf('CUA_ENV_TOKEN');
    expect(args[i - 1]).toBe('-e');
    expect(args).toContain(`MV_CHOWN_PATHS=${VAULT}/node_modules`);
  });

  it('mounts named volumes with --mount type=volume, binds first and shallow before deep', () => {
    const mounts = args.flatMap((a, i) => (args[i - 1] === '--mount' ? [a] : []));
    expect(mounts).toEqual([
      `type=bind,source=${VAULT},target=${VAULT}`,
      `type=bind,source=${DOCS},target=${DOCS},readonly`,
      'type=volume,source=mv-pc-linux-1-home,target=/home/cua',
      `type=volume,source=mv-pc-linux-1-ov-abc,target=${VAULT}/node_modules`,
    ]);
  });

  it('sets resources, labels, name and the image last', () => {
    expect(args.slice(0, 8)).toEqual([
      'run',
      '-d',
      '--name',
      'mv-pc-linux-1',
      '--cpus',
      '2',
      '--memory',
      '4096M',
    ]);
    expect(args).toContain('--shm-size');
    expect(args[args.indexOf('--shm-size') + 1]).toBe('2048M');
    expect(args).toContain('minevibe=pc');
    expect(args).toContain('minevibe.pc=linux-1');
    expect(args.at(-1)).toBe('minevibe/linux-pc:dev');
  });

  it('creates capped volumes', () => {
    expect(buildVolumeCreateArgs({ name: 'v', target: '/x', sizeGiB: 32 }, { minevibe: 'pc' })).toEqual([
      'volume',
      'create',
      '-s',
      '32G',
      '--label',
      'minevibe=pc',
      'v',
    ]);
  });

  it('rejects unsafe specs', () => {
    expect(() => assertRunSpec(spec({ hostPort: 80 }))).toThrow(/hostPort/);
    expect(() =>
      assertRunSpec(spec({ binds: [{ source: '/a,b', target: '/a,b', readonly: false }] })),
    ).toThrow(/bind/);
    expect(() =>
      assertRunSpec(spec({ binds: [{ source: '/a:b', target: '/a:b', readonly: true }] })),
    ).toThrow(/bind/);
    expect(() => assertRunSpec(spec({ labels: { 'bad key': 'x' } }))).toThrow(/label/);
    expect(() => assertRunSpec(spec({ env: { CUA_ENV_TOKEN: 'x' } }))).toThrow(/twice/);
    expect(() => assertRunSpec(spec({ volumes: [{ name: 'v', target: '/x', sizeGiB: 0 }] }))).toThrow(/size/);
  });
});

describe('Docker run arguments', () => {
  const args = buildDockerRunArgs(spec());
  it('uses the same safe forms', () => {
    expect(args).toContain(`type=bind,source=${DOCS},target=${DOCS},readonly`);
    expect(args[args.indexOf('-p') + 1]).toBe('127.0.0.1:43211:3211');
    expect(args).not.toContain('-v');
    expect(args.join(' ')).not.toContain(TOKEN);
    expect(args).toContain('--memory-swap');
  });
});

/** Trimmed `container inspect` output from S5 (token redacted). */
const S5_INSPECT = {
  configuration: {
    id: 'mv-pc-s5',
    image: { descriptor: { digest: 'sha256:71db' }, reference: 'ghcr.io/trycua/linux:24.04' },
    initProcess: { environment: ['CUA_ENV_TOKEN=<redacted>'] },
    labels: { minevibe: 'pc' },
    mounts: [
      { destination: '/v', options: [], source: '/v', type: { virtiofs: {} } },
      { destination: '/r', options: ['ro'], source: '/r', type: { virtiofs: {} } },
      {
        destination: '/home/cua',
        options: [],
        source: '/x/volume.img',
        type: { volume: { name: 'mv-pc-s5-home', format: 'ext4' } },
      },
    ],
    publishedPorts: [
      { containerPort: 3211, count: 1, hostAddress: '127.0.0.1', hostPort: 43211, proto: 'tcp' },
    ],
    resources: { cpuOverhead: 1, cpus: 2, memoryInBytes: 4294967296 },
  },
  id: 'mv-pc-s5',
  status: { networks: [{ ipv4Address: '192.168.64.2/24' }], state: 'running' },
};

describe('inspect parsing and mount verification', () => {
  it('parses the Apple inspect shape', () => {
    const info = parseAppleContainer(S5_INSPECT);
    expect(info).toMatchObject({
      name: 'mv-pc-s5',
      state: 'running',
      hostPort: 43211,
      hostAddress: '127.0.0.1',
      cpus: 2,
      cpuOverhead: 1,
      memoryBytes: 4294967296,
      ipv4: '192.168.64.2',
      imageDigest: 'sha256:71db',
    });
    expect(info.binds).toEqual([
      { source: '/v', target: '/v', readonly: false },
      { source: '/r', target: '/r', readonly: true },
    ]);
    expect(info.volumes).toEqual([{ name: 'mv-pc-s5-home', target: '/home/cua' }]);
  });

  it('detects the 1.5.0 `-v …:ro` bug (rw mount at DST+"o")', () => {
    const s = spec({ binds: [{ source: DOCS, target: DOCS, readonly: true }], volumes: [] });
    const info = parseAppleContainer({
      configuration: {
        id: 'x',
        mounts: [{ destination: `${DOCS}o`, options: [], source: DOCS, type: { virtiofs: {} } }],
      },
      status: { state: 'running' },
    });
    const problems = mountProblems(s, info);
    expect(problems).toContain(`bind ${DOCS} missing`);
    expect(problems).toContain(`unexpected bind at ${DOCS}o`);
  });

  it('detects a mount that came up writable', () => {
    const s = spec({ binds: [{ source: DOCS, target: DOCS, readonly: true }], volumes: [] });
    const info = parseAppleContainer({
      configuration: {
        id: 'x',
        mounts: [{ destination: DOCS, options: [], source: DOCS, type: { virtiofs: {} } }],
      },
    });
    expect(mountProblems(s, info)).toEqual([`bind ${DOCS} is read-write`]);
  });

  it('parses docker inspect', () => {
    const info = parseDockerInspect({
      Name: '/mv-pc-a',
      State: { Status: 'exited' },
      Config: { Labels: { minevibe: 'pc' } },
      Mounts: [
        { Type: 'bind', Source: '/v', Destination: '/v', RW: false },
        { Type: 'volume', Name: 'h', Destination: '/home/cua', RW: true },
      ],
      NetworkSettings: { Ports: { '3211/tcp': [{ HostIp: '127.0.0.1', HostPort: '5000' }] } },
    });
    expect(info).toMatchObject({ name: 'mv-pc-a', state: 'stopped', hostPort: 5000 });
    expect(info.binds[0]?.readonly).toBe(true);
  });
});

describe('AppleContainerDriver.run', () => {
  function fakeRuntime(inspectRows: unknown[]) {
    const calls: { args: readonly string[]; env?: NodeJS.ProcessEnv }[] = [];
    const ok = (stdout = ''): ExecResult => ({
      code: 0,
      signal: null,
      stdout,
      stderr: '',
      ms: 1,
      timedOut: false,
    });
    const rt = {
      exec: async (args: readonly string[], o: { env?: NodeJS.ProcessEnv } = {}) => {
        calls.push({ args, ...(o.env ? { env: o.env } : {}) });
        if (args[0] === 'volume' && args[1] === 'inspect')
          return { ...ok(), code: 1, stderr: 'volume not found' };
        if (args[0] === 'inspect') return ok(JSON.stringify(inspectRows));
        return ok();
      },
      execOk: async (args: readonly string[]) => {
        calls.push({ args });
        return '';
      },
    } as unknown as ContainerRuntime;
    return { rt, calls };
  }

  it('creates capped volumes, passes the token only via env, verifies mounts', async () => {
    const s = spec({
      binds: [{ source: DOCS, target: DOCS, readonly: true }],
      volumes: [{ name: 'mv-pc-linux-1-home', target: '/home/cua', sizeGiB: 32 }],
    });
    const { rt, calls } = fakeRuntime([
      {
        configuration: {
          id: 'mv-pc-linux-1',
          mounts: [
            { destination: DOCS, options: ['ro'], source: DOCS, type: { virtiofs: {} } },
            { destination: '/home/cua', source: '/x', type: { volume: { name: 'mv-pc-linux-1-home' } } },
          ],
        },
        status: { state: 'running' },
      },
    ]);
    await new AppleContainerDriver(rt).run(s);
    const create = calls.find((c) => c.args[0] === 'volume' && c.args[1] === 'create');
    expect(create?.args).toEqual([
      'volume',
      'create',
      '-s',
      '32G',
      '--label',
      'minevibe=pc',
      '--label',
      'minevibe.pc=linux-1',
      'mv-pc-linux-1-home',
    ]);
    const run = calls.find((c) => c.args[0] === 'run');
    expect(run?.env?.CUA_ENV_TOKEN).toBe(TOKEN);
    expect(run?.args.join(' ')).not.toContain(TOKEN);
  });

  it('deletes the container and throws when mounts come up wrong', async () => {
    const s = spec({ binds: [{ source: DOCS, target: DOCS, readonly: true }], volumes: [] });
    const { rt, calls } = fakeRuntime([
      {
        configuration: {
          id: 'x',
          mounts: [{ destination: DOCS, options: [], source: DOCS, type: { virtiofs: {} } }],
        },
      },
    ]);
    await expect(new AppleContainerDriver(rt).run(s)).rejects.toThrow(/wrong mounts.*read-write/);
    expect(calls.some((c) => c.args[0] === 'delete')).toBe(true);
  });
});
