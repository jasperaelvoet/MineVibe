import { createHash } from 'node:crypto';
import { existsSync, lstatSync } from 'node:fs';
import { lstat, mkdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import { overlayVolumePrefix } from './PcTypes.js';

/**
 * The Vault: host folders mounted into PCs (PLAN §8.3, §8.6).
 *
 * - Linux mounts are path-identical (`--mount type=bind,source=P,target=P[,readonly]`).
 * - Refused: `/`, `$HOME` and its ancestors, `~/Library`, anything that is, contains or sits inside
 *   `~/.ssh ~/.aws ~/.config ~/.claude ~/.gnupg ~/.docker`, dotfile-config folders, system folders and
 *   MineVibe's own data (tokens live there). Symlinks are resolved and both spellings are checked.
 * - Git repos are preferred (a warning otherwise); read-write carries the honest warning.
 * - Build-dir overlays (named volumes over `node_modules`, `.venv`, …) keep Linux artifacts out of the
 *   host repo.
 */

export interface VaultMount {
  /** Absolute realpath; the guest sees the same path. */
  host: string;
  ro: boolean;
  /** Relative build-dir paths inside the mount that get a named-volume overlay. */
  overlays: string[];
}

export type VaultCheck =
  | { ok: true; path: string; isGitRepo: boolean; warnings: string[] }
  | { ok: false; code: 'PATH_REFUSED'; reason: string };

/** Folders under $HOME that are refused when equal to, an ancestor of, or inside the candidate. */
export const SENSITIVE_HOME_DIRS = ['.ssh', '.aws', '.config', '.claude', '.gnupg', '.docker'] as const;

/** System folders that are refused (and everything inside them). */
export const SYSTEM_DIRS = [
  '/System',
  '/Library',
  '/Applications',
  '/bin',
  '/sbin',
  '/usr',
  '/etc',
  '/private/etc',
  '/dev',
  '/cores',
  '/opt',
  '/var/db',
  '/private/var/db',
  '/var/root',
  '/private/var/root',
] as const;

/** Folders whose contents trigger a TCC prompt for `container-runtime-linux` on first run (S5). */
const TCC_HOME_DIRS = ['Documents', 'Desktop', 'Downloads'] as const;

/** Build-dir names that get an overlay by default when the project has the matching marker. */
export const DEFAULT_OVERLAYS: readonly { dir: string; markers: string[] }[] = [
  { dir: 'node_modules', markers: ['package.json'] },
  { dir: '.venv', markers: ['pyproject.toml', 'requirements.txt', 'setup.py', 'Pipfile'] },
  { dir: 'target', markers: ['Cargo.toml', 'pom.xml'] },
  { dir: '.gradle', markers: ['build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts'] },
  { dir: 'build', markers: ['build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts'] },
];

/** Overlay entries that are allowed to start with a dot. */
const DOT_OVERLAYS = new Set([
  '.venv',
  '.gradle',
  '.next',
  '.nuxt',
  '.cache',
  '.turbo',
  '.tox',
  '.mypy_cache',
]);

export interface VaultOptions {
  home?: string;
  platform?: NodeJS.Platform;
  /** More refused folders (MineVibe's data dirs): equal, ancestor or descendant. */
  forbidden?: readonly string[];
}

/** APFS is case-insensitive by default: compare folded on macOS. */
function key(p: string, platform: NodeJS.Platform): string {
  return platform === 'darwin' ? p.toLowerCase() : p;
}

function inside(child: string, parent: string, platform: NodeJS.Platform): boolean {
  const rel = relative(key(parent, platform), key(child, platform));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function expandHome(p: string, home: string): string {
  if (p === '~') return home;
  if (p.startsWith('~/')) return join(home, p.slice(2));
  return p;
}

/**
 * Characters that break `--mount type=bind,source=…` (`,` splits directives; `=` makes 1.5.0 fail with
 * "invalid directive format missing value", measured) or the colon-separated `MV_CHOWN_PATHS` list.
 */
const BAD_CHARS_RE = /[,:=\\]/;

/** True when `s` holds an ASCII control character (C0 or DEL). */
export function hasControlChar(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return true;
  }
  return false;
}

const badChars = (s: string) => BAD_CHARS_RE.test(s) || hasControlChar(s);

/** Lexical refusal checks for one spelling of the path. Returns the reason or null. */
export function refusalReason(p: string, options: VaultOptions = {}): string | null {
  const platform = options.platform ?? process.platform;
  const home = resolve(options.home ?? homedir());
  const path = normalize(p);
  if (!isAbsolute(path)) return 'the path must be absolute';
  if (badChars(path)) return 'the path contains a comma, colon, equals sign, backslash or control character';
  if (path === sep || path === '/') return 'the whole disk cannot be mounted';
  if (inside(home, path, platform)) {
    return key(path, platform) === key(home, platform)
      ? 'your home folder cannot be mounted; pick a project folder'
      : 'a folder that contains your home folder cannot be mounted';
  }
  if (inside(path, join(home, 'Library'), platform)) return '~/Library cannot be mounted';
  for (const d of SENSITIVE_HOME_DIRS) {
    const s = join(home, d);
    if (inside(path, s, platform) || inside(s, path, platform)) {
      return `~/${d} (credentials or config) cannot be mounted or contain the mount`;
    }
  }
  if (inside(path, home, platform)) {
    const rel = relative(home, path);
    const dotPart = rel.split(sep).find((part) => part.startsWith('.'));
    if (dotPart) return `dotfile/config folders (${dotPart}) cannot be mounted`;
  }
  for (const s of SYSTEM_DIRS) {
    if (inside(path, s, platform)) return `system folder ${s} cannot be mounted`;
  }
  if (key(path, platform) === key('/Volumes', platform) || key(path, platform) === key('/Users', platform)) {
    return `${path} cannot be mounted`;
  }
  for (const f of options.forbidden ?? []) {
    const fr = resolve(f);
    if (inside(path, fr, platform) || inside(fr, path, platform)) {
      return 'MineVibe data folders cannot be mounted or contain the mount';
    }
  }
  return null;
}

/**
 * Validates a folder for the Vault: absolute (after `~` expansion), refused locations checked on both the
 * given and the resolved spelling, must exist and be a directory.
 */
export async function validateVaultPath(input: string, options: VaultOptions = {}): Promise<VaultCheck> {
  const home = resolve(options.home ?? homedir());
  const given = expandHome(input.trim(), home);
  if (!given) return { ok: false, code: 'PATH_REFUSED', reason: 'empty path' };
  const lexical = refusalReason(given, options);
  if (lexical) return { ok: false, code: 'PATH_REFUSED', reason: lexical };
  let real: string;
  try {
    real = await realpath(given);
  } catch {
    return { ok: false, code: 'PATH_REFUSED', reason: 'the folder does not exist' };
  }
  // Check the resolved path against the resolved home too (/tmp → /private/tmp style aliases).
  let realHome = home;
  try {
    realHome = await realpath(home);
  } catch {}
  const resolvedReason =
    refusalReason(real, { ...options, home: realHome }) ?? refusalReason(real, { ...options, home });
  if (resolvedReason)
    return { ok: false, code: 'PATH_REFUSED', reason: `${resolvedReason} (resolves to ${real})` };
  const st = await stat(real);
  if (!st.isDirectory()) return { ok: false, code: 'PATH_REFUSED', reason: 'not a folder' };

  const warnings: string[] = [];
  const isGitRepo = existsSync(join(real, '.git'));
  if (!isGitRepo)
    warnings.push('not a git repository: changes made by agents cannot be reviewed or undone with git');
  const platform = options.platform ?? process.platform;
  for (const d of TCC_HOME_DIRS) {
    if (inside(real, join(realHome, d), platform)) {
      warnings.push(`inside ~/${d}: macOS asks once to let container-runtime-linux access it`);
    }
  }
  return { ok: true, path: real, isGitRepo, warnings };
}

/**
 * Re-checks a stored mount right before every container create and start (H1). The Vault was validated
 * when it was configured, but the folder may have been swapped since (by the user, or by an agent of a
 * PC that mounts a parent folder read-write): it must still be a real directory (lstat, no symlink),
 * resolve to exactly the stored path (no symlinked ancestor), and pass every refusal again.
 * Returns the reason it may not be mounted, or null.
 */
export async function recheckMount(
  mount: Pick<VaultMount, 'host'>,
  options: VaultOptions = {},
): Promise<string | null> {
  const home = resolve(options.home ?? homedir());
  const lexical = refusalReason(mount.host, options);
  if (lexical) return lexical;
  let st: Awaited<ReturnType<typeof lstat>>;
  try {
    st = await lstat(mount.host);
  } catch {
    return 'the folder no longer exists';
  }
  if (st.isSymbolicLink()) return 'the folder has been replaced by a symlink';
  if (!st.isDirectory()) return 'the path is no longer a folder';
  let real: string;
  try {
    real = await realpath(mount.host);
  } catch {
    return 'the folder no longer resolves';
  }
  if (real !== mount.host) return `the path now resolves to ${real}`;
  let realHome = home;
  try {
    realHome = await realpath(home);
  } catch {}
  return refusalReason(real, { ...options, home: realHome });
}

/** Another PC's mounts, for the cross-PC nesting check. */
export interface OtherPcMounts {
  pcId: string;
  mounts: readonly Pick<VaultMount, 'host' | 'ro'>[];
}

/**
 * Refuses a mount nested strictly inside (or around) another PC's mount when the outer one is
 * read-write (H1): an agent of the outer PC could replace the inner folder with a symlink to `$HOME`
 * before the inner PC's next start. The same folder in two PCs is fine (a share root cannot be renamed
 * from inside the guest), and nesting under a read-only mount is fine.
 */
export function crossPcNestingProblem(
  mounts: readonly Pick<VaultMount, 'host' | 'ro'>[],
  others: readonly OtherPcMounts[],
  platform: NodeJS.Platform = process.platform,
): string | null {
  for (const m of mounts) {
    for (const o of others) {
      for (const om of o.mounts) {
        if (key(m.host, platform) === key(om.host, platform)) continue;
        if (inside(m.host, om.host, platform) && !om.ro) {
          return `${m.host} is inside ${om.host}, which ${o.pcId} mounts read-write`;
        }
        if (inside(om.host, m.host, platform) && !m.ro) {
          return `${m.host} would contain ${om.host} (mounted by ${o.pcId}) read-write`;
        }
      }
    }
  }
  return null;
}

/** The honest warning shown for read-write mounts (PLAN §8.3). */
export const RW_WARNING = 'An agent can put code here that later runs on your Mac.';

/** Validates an overlay entry: a relative path inside the mount, no `..`, no hidden parts except build dirs. */
export function validateOverlay(entry: string): string | null {
  const e = entry.trim();
  if (!e) return 'empty overlay';
  if (isAbsolute(e)) return 'overlays are relative to the mount';
  if (badChars(e)) return 'overlay contains a forbidden character';
  const parts = normalize(e).split(sep);
  if (parts.some((p) => p === '..' || p === '.' || p === '')) return 'overlay must not contain . or ..';
  if (parts.length > 6) return 'overlay is nested too deep';
  if (parts.some((p) => p.startsWith('.') && !DOT_OVERLAYS.has(p)))
    return `hidden folder ${e} cannot be an overlay`;
  if (parts[0] === '.git') return '.git cannot be an overlay';
  return null;
}

/** Overlays suggested for a project folder, from marker files. */
export function suggestOverlays(dir: string): string[] {
  const out: string[] = [];
  for (const o of DEFAULT_OVERLAYS) {
    if (o.markers.some((m) => existsSync(join(dir, m))) && !out.includes(o.dir)) out.push(o.dir);
  }
  return out;
}

/** Name of the named volume backing one overlay of one mount of one PC (of one MineVibe instance). */
export function overlayVolumeName(
  pcId: string,
  instance: string,
  mountPath: string,
  overlay: string,
): string {
  const h = createHash('sha256')
    .update(`${mountPath}\0${normalize(overlay)}`)
    .digest('hex')
    .slice(0, 10);
  return `${overlayVolumePrefix(pcId, instance)}${h}`;
}

/** Absolute guest (= host) path of an overlay. */
export function overlayTarget(mountPath: string, overlay: string): string {
  return join(mountPath, normalize(overlay));
}

/**
 * Checks a PC's mount list: each path validated, no duplicates, no mount nested in another (path
 * identity makes nesting ambiguous), overlays valid and de-duplicated.
 */
export async function validateMounts(
  mounts: readonly { host: string; ro?: boolean; overlays?: readonly string[] }[],
  options: VaultOptions = {},
): Promise<
  { ok: true; mounts: VaultMount[]; warnings: string[] } | { ok: false; code: 'PATH_REFUSED'; reason: string }
> {
  const platform = options.platform ?? process.platform;
  const out: VaultMount[] = [];
  const warnings: string[] = [];
  for (const m of mounts) {
    const check = await validateVaultPath(m.host, options);
    if (!check.ok) return { ok: false, code: 'PATH_REFUSED', reason: `${m.host}: ${check.reason}` };
    for (const other of out) {
      if (inside(check.path, other.host, platform) || inside(other.host, check.path, platform)) {
        return { ok: false, code: 'PATH_REFUSED', reason: `${check.path} overlaps ${other.host}` };
      }
    }
    const overlays: string[] = [];
    for (const o of m.overlays ?? []) {
      const bad = validateOverlay(o);
      if (bad) return { ok: false, code: 'PATH_REFUSED', reason: `${check.path}: ${bad}` };
      const n = normalize(o.trim());
      if (!overlays.includes(n)) overlays.push(n);
    }
    warnings.push(...check.warnings.map((w) => `${check.path}: ${w}`));
    if (!m.ro) warnings.push(`${check.path}: ${RW_WARNING}`);
    out.push({ host: check.path, ro: !!m.ro, overlays });
  }
  return { ok: true, mounts: out, warnings };
}

/**
 * Makes sure each overlay mountpoint exists on the host before `run`: the runtime cannot create it
 * inside a read-only bind (EROFS, measured in M4), and a pre-existing non-directory (e.g. a symlink an
 * agent planted) is skipped rather than followed. Returns the overlays that are safe to mount.
 */
export async function prepareOverlayMountpoints(
  mount: VaultMount,
): Promise<{ ready: string[]; skipped: string[] }> {
  const ready: string[] = [];
  const skipped: string[] = [];
  // Never create anything below a mount root that is not a real directory (H1: swapped for a symlink).
  let rootSt: ReturnType<typeof lstatSync> | null = null;
  try {
    rootSt = lstatSync(mount.host);
  } catch {
    rootSt = null;
  }
  if (!rootSt || rootSt.isSymbolicLink() || !rootSt.isDirectory())
    return { ready, skipped: [...mount.overlays] };
  for (const o of mount.overlays) {
    // Walk each component with lstat so no symlink inside the mount is followed.
    const parts = normalize(o).split(sep);
    let cur = mount.host;
    let ok = true;
    for (const part of parts) {
      cur = join(cur, part);
      let st: ReturnType<typeof lstatSync> | null = null;
      try {
        st = lstatSync(cur);
      } catch {
        st = null;
      }
      if (st === null) {
        try {
          await mkdir(cur, { mode: 0o755 });
        } catch {
          ok = false;
          break;
        }
      } else if (!st.isDirectory() || st.isSymbolicLink()) {
        ok = false;
        break;
      }
    }
    (ok ? ready : skipped).push(o);
  }
  return { ready, skipped };
}
