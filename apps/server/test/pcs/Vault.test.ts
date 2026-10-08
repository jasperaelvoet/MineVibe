import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  overlayTarget,
  overlayVolumeName,
  prepareOverlayMountpoints,
  RW_WARNING,
  refusalReason,
  suggestOverlays,
  validateMounts,
  validateOverlay,
  validateVaultPath,
} from '../../src/pcs/Vault.js';

let root: string;
let home: string;
let code: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'mv-vault-')));
  home = join(root, 'Users', 'me');
  code = join(home, 'Code');
  for (const d of [
    '.ssh',
    '.aws',
    '.config/gh',
    '.claude',
    '.gnupg',
    '.docker',
    '.kube',
    'Library/Keychains',
    'Documents/proj',
    'Code/foo/.git',
    'Code/bar',
  ]) {
    mkdirSync(join(home, d), { recursive: true });
  }
  writeFileSync(join(code, 'foo', 'package.json'), '{}');
  writeFileSync(join(code, 'notes.txt'), 'x');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const opts = () => ({ home, platform: 'darwin' as const });

describe('refusals (PLAN §8.3)', () => {
  it.each([
    ['/', /whole disk/],
    ['HOME', /home folder/],
    ['ROOT/Users', /contains your home/],
    ['HOME/Library', /~\/Library/],
    ['HOME/Library/Keychains', /~\/Library/],
    ['HOME/.ssh', /~\/.ssh/],
    ['HOME/.config/gh', /~\/.config/],
    ['HOME/.aws', /~\/.aws/],
    ['HOME/.claude', /~\/.claude/],
    ['HOME/.gnupg', /~\/.gnupg/],
    ['HOME/.docker', /~\/.docker/],
    ['HOME/.kube', /dotfile/],
    ['/etc', /system folder/],
    ['/usr/local/src', /system folder/],
    ['/opt/homebrew', /system folder/],
    ['/System/Library', /system folder/],
    ['relative/path', /absolute/],
    ['HOME/Code/a,b', /comma/],
    ['HOME/Code/a:b', /colon/],
  ])('refuses %s', (p, why) => {
    const path = p.replace('HOME', home).replace('ROOT', root);
    expect(refusalReason(path, opts())).toMatch(why);
  });

  it('is case-insensitive on macOS (APFS)', () => {
    expect(refusalReason(join(home, '.SSH'), opts())).toMatch(/\.ssh/);
    expect(refusalReason(join(home, 'library', 'x'), opts())).toMatch(/Library/);
  });

  it('refuses a folder that contains MineVibe data', () => {
    const state = join(code, 'bar', 'state');
    expect(refusalReason(join(code, 'bar'), { ...opts(), forbidden: [state] })).toMatch(/MineVibe data/);
    expect(refusalReason(join(state, 'x'), { ...opts(), forbidden: [state] })).toMatch(/MineVibe data/);
  });

  it('allows an ordinary project folder', () => {
    expect(refusalReason(join(code, 'foo'), opts())).toBeNull();
  });
});

describe('validateVaultPath', () => {
  it('accepts a git repo with no git warning and returns the realpath', async () => {
    const r = await validateVaultPath(join(code, 'foo'), opts());
    expect(r).toMatchObject({ ok: true, path: join(code, 'foo'), isGitRepo: true });
    if (r.ok) expect(r.warnings.join()).not.toMatch(/git/);
  });

  it('prefers git repos: warns for a plain folder', async () => {
    const r = await validateVaultPath(join(code, 'bar'), opts());
    expect(r.ok && r.isGitRepo).toBe(false);
    if (r.ok) expect(r.warnings.join()).toMatch(/not a git repository/);
  });

  it('expands ~', async () => {
    const r = await validateVaultPath('~/Code/foo', opts());
    expect(r).toMatchObject({ ok: true, path: join(code, 'foo') });
  });

  it('resolves symlinks and refuses one that points at ~/.ssh', async () => {
    symlinkSync(join(home, '.ssh'), join(code, 'innocent'));
    const r = await validateVaultPath(join(code, 'innocent'), opts());
    expect(r).toMatchObject({ ok: false, code: 'PATH_REFUSED' });
    if (!r.ok) expect(r.reason).toMatch(/\.ssh.*resolves to/);
  });

  it('refuses a missing folder and a file', async () => {
    expect(await validateVaultPath(join(code, 'nope'), opts())).toMatchObject({
      ok: false,
      reason: /does not exist/,
    });
    expect(await validateVaultPath(join(code, 'notes.txt'), opts())).toMatchObject({
      ok: false,
      reason: /not a folder/,
    });
  });

  it('warns about the one-time TCC prompt for ~/Documents', async () => {
    const r = await validateVaultPath(join(home, 'Documents', 'proj'), opts());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.warnings.join()).toMatch(/Documents.*container-runtime-linux/);
  });
});

describe('overlays', () => {
  it('validates entries', () => {
    expect(validateOverlay('node_modules')).toBeNull();
    expect(validateOverlay('.venv')).toBeNull();
    expect(validateOverlay('apps/web/node_modules')).toBeNull();
    expect(validateOverlay('../x')).toMatch(/\.\./);
    expect(validateOverlay('/abs')).toMatch(/relative/);
    expect(validateOverlay('.git')).toMatch(/hidden|\.git/);
    expect(validateOverlay('.ssh')).toMatch(/hidden/);
    expect(validateOverlay('a,b')).toMatch(/forbidden/);
    expect(validateOverlay('')).toMatch(/empty/);
  });

  it('suggests overlays from marker files', () => {
    expect(suggestOverlays(join(code, 'foo'))).toEqual(['node_modules']);
    writeFileSync(join(code, 'bar', 'Cargo.toml'), '');
    writeFileSync(join(code, 'bar', 'pyproject.toml'), '');
    expect(suggestOverlays(join(code, 'bar')).sort()).toEqual(['.venv', 'target']);
  });

  it('names overlay volumes per PC, mount and entry', () => {
    const a = overlayVolumeName('linux-1', '/x/foo', 'node_modules');
    expect(a).toMatch(/^mv-pc-linux-1-ov-[0-9a-f]{10}$/);
    expect(overlayVolumeName('linux-1', '/x/foo', 'node_modules')).toBe(a);
    expect(overlayVolumeName('linux-1', '/x/bar', 'node_modules')).not.toBe(a);
    expect(overlayVolumeName('linux-2', '/x/foo', 'node_modules')).not.toBe(a);
    expect(overlayTarget('/x/foo', 'apps/web/node_modules')).toBe('/x/foo/apps/web/node_modules');
  });

  it('pre-creates overlay mountpoints and skips a planted symlink', async () => {
    const foo = join(code, 'foo');
    symlinkSync(join(home, '.ssh'), join(foo, 'target'));
    const r = await prepareOverlayMountpoints({
      host: foo,
      ro: true,
      overlays: ['node_modules', 'target', 'a/b/build'],
    });
    expect(r.ready).toEqual(['node_modules', 'a/b/build']);
    expect(r.skipped).toEqual(['target']);
    expect(lstatSync(join(foo, 'node_modules')).isDirectory()).toBe(true);
    expect(existsSync(join(foo, 'a', 'b', 'build'))).toBe(true);
    expect(existsSync(join(home, '.ssh', 'target'))).toBe(false);
  });
});

describe('validateMounts', () => {
  it('validates, de-duplicates overlays and adds the read-write warning', async () => {
    const r = await validateMounts(
      [{ host: join(code, 'foo'), overlays: ['node_modules', 'node_modules'] }],
      opts(),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.mounts).toEqual([{ host: join(code, 'foo'), ro: false, overlays: ['node_modules'] }]);
      expect(r.warnings.join()).toContain(RW_WARNING);
    }
  });

  it('refuses overlapping mounts and bad overlays', async () => {
    mkdirSync(join(code, 'foo', 'sub'));
    expect(
      await validateMounts([{ host: join(code, 'foo') }, { host: join(code, 'foo', 'sub') }], opts()),
    ).toMatchObject({
      ok: false,
      reason: /overlaps/,
    });
    expect(await validateMounts([{ host: join(code, 'foo'), overlays: ['../x'] }], opts())).toMatchObject({
      ok: false,
    });
    expect(await validateMounts([{ host: home }], opts())).toMatchObject({ ok: false, code: 'PATH_REFUSED' });
  });
});
