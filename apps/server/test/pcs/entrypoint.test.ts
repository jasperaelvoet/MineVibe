import { execFileSync } from 'node:child_process';
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
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * The image's boot hook (images/linux-pc/minevibe-entrypoint.sh), run on the host against temp dirs with
 * stubbed `mountpoint`/`findmnt`/`chown`/`chmod`. Its constants are rewritten to the temp dirs, so nothing
 * outside them is touched.
 */
const SCRIPT = fileURLToPath(new URL('../../../../images/linux-pc/minevibe-entrypoint.sh', import.meta.url));

let dir: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'mv-entry-')));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function run(env: Record<string, string>) {
  const bin = join(dir, 'bin');
  const log = join(dir, 'calls.log');
  mkdirSync(bin, { recursive: true });
  const stub = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  stub('mountpoint', 'exit 0');
  stub('findmnt', 'echo ext4');
  stub('chown', `echo "chown $*" >> '${log}'`);
  stub('chmod', `echo "chmod $*" >> '${log}'`);
  const paths = {
    SKEL: join(dir, 'skel'),
    HOME_DIR: join(dir, 'home'),
    CUA_ENTRYPOINT: join(dir, 'cua-entry.sh'),
    TMP_DIR: join(dir, 'tmp'),
    VAR_TMP_DIR: join(dir, 'vartmp'),
  };
  mkdirSync(paths.SKEL, { recursive: true });
  writeFileSync(join(paths.SKEL, '.bashrc'), '# skel\n');
  mkdirSync(paths.TMP_DIR, { recursive: true });
  writeFileSync(join(paths.TMP_DIR, '.X1-lock'), 'stale');
  mkdirSync(join(paths.TMP_DIR, '.X11-unix'));
  mkdirSync(join(paths.VAR_TMP_DIR, 'lost+found'), { recursive: true });
  writeFileSync(join(paths.VAR_TMP_DIR, 'keep.txt'), 'kept');
  writeFileSync(
    paths.CUA_ENTRYPOINT,
    `#!/bin/sh\necho "cua-entry MV_CHOWN_PATHS=\${MV_CHOWN_PATHS:-unset}"\n`,
  );
  chmodSync(paths.CUA_ENTRYPOINT, 0o755);
  let script = readFileSync(SCRIPT, 'utf8');
  for (const [k, v] of Object.entries(paths)) {
    const re = new RegExp(`^${k}=.*$`, 'm');
    expect(script).toMatch(re);
    script = script.replace(re, `${k}='${v}'`);
  }
  const copy = join(dir, 'entry.sh');
  writeFileSync(copy, script);
  const out = execFileSync('/bin/sh', [copy], {
    env: { PATH: `${bin}:/usr/bin:/bin`, ...env },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { out, calls: existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [], paths };
}

describe('minevibe-entrypoint.sh', () => {
  it('L3: never glob-expands MV_CHOWN_PATHS entries', () => {
    const proj = join(dir, 'proj');
    mkdirSync(join(proj, 'a1'), { recursive: true });
    mkdirSync(join(proj, 'a2'), { recursive: true });
    const { out, calls } = run({ MV_CHOWN_PATHS: `${proj}/a*:${proj}/node_modules` });
    expect(calls).toContain(`chown 1000:1000 ${proj}/a*`);
    expect(calls).toContain(`chown 1000:1000 ${proj}/node_modules`);
    expect(calls.some((c) => c.endsWith('/a1') || c.endsWith('/a2'))).toBe(false);
    // The list is consumed and not passed on.
    expect(out).toContain('cua-entry MV_CHOWN_PATHS=unset');
  });

  it('M6: empties /tmp like a tmpfs, keeps /var/tmp, and makes both 1777', () => {
    const { calls, paths } = run({});
    expect(readdirSync(paths.TMP_DIR)).toEqual([]);
    expect(readdirSync(paths.VAR_TMP_DIR)).toEqual(['keep.txt']);
    expect(calls).toContain(`chmod 1777 ${paths.TMP_DIR}`);
    expect(calls).toContain(`chmod 1777 ${paths.VAR_TMP_DIR}`);
    expect(existsSync(join(paths.HOME_DIR, '.bashrc'))).toBe(true);
  });
});
