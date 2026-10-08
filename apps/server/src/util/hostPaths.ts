import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

/**
 * Host path facts shared by the config, the PC manager and the container runtime: symlink-resolving paths that may
 * not exist yet, TCC-protected locations (PLAN §8.6), what `container --mount` can carry, and the instance id that
 * scopes a MineVibe home's PCs.
 */

/**
 * `~/Library/Application Support/MineVibe-dev`: development data that root daemons and the container engine must reach,
 * so it never sits inside a TCC-protected folder like a checkout in `~/Documents` (PLAN §8.6): the container roots and
 * the Codex exports of such checkouts.
 */
export const DEV_SUPPORT_DIRNAME = 'MineVibe-dev';

/** `~/Library/Application Support/MineVibe-dev` ({@link DEV_SUPPORT_DIRNAME}). */
export function devSupportDir(home = homedir()): string {
  return join(home, 'Library', 'Application Support', DEV_SUPPORT_DIRNAME);
}

/** Folders whose contents root daemons cannot read without a TCC grant (S5: vmnet 1001 hang). */
export const TCC_PROTECTED_HOME_DIRS: readonly string[] = [
  'Documents',
  'Desktop',
  'Downloads',
  join('Library', 'Mobile Documents'),
  join('Library', 'CloudStorage'),
];

/** Resolves symlinks of the longest existing prefix (paths may not exist yet). */
export function realpathLoose(p: string): string {
  let cur = resolve(p);
  const rest: string[] = [];
  for (;;) {
    try {
      const real = realpathSync(cur);
      return rest.length ? join(real, ...rest.reverse()) : real;
    } catch {
      const parent = dirname(cur);
      if (parent === cur) return resolve(p);
      rest.push(cur.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
      cur = parent;
    }
  }
}

/** True when `child` equals `parent` or is below it. */
export function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** Why `p` sits in a TCC-protected location (or null). */
export function tccProtectedReason(p: string, home = homedir()): string | null {
  const real = realpathLoose(p);
  const realHome = realpathLoose(home);
  for (const d of TCC_PROTECTED_HOME_DIRS) {
    const base = join(realHome, d);
    if (isInside(real, base)) return `inside ~/${d}`;
  }
  if (isInside(real, '/Volumes')) return 'on an external volume';
  return null;
}

/**
 * Why `p` cannot be the source of a `container --mount` bind (or null): `--mount type=bind,source=/a=b,…` fails with
 * "invalid directive format missing value" (PLAN §8.6), `,` splits directives, and `:` breaks `MV_CHOWN_PATHS`.
 */
export function mountSourceProblem(p: string): string | null {
  if (!isAbsolute(p)) return 'not an absolute path';
  if (/[,=:\\\n\r\0]/.test(p)) return 'contains a comma, colon, equals sign, backslash or control character';
  return null;
}

/** A MineVibe instance id: 8 hex characters of sha256(realpath(state dir)). Names and labels of its PCs carry it. */
export function instanceIdFor(stateDir: string): string {
  return createHash('sha256').update(realpathLoose(stateDir)).digest('hex').slice(0, 8);
}

/** Instance ids are exactly 8 lowercase hex characters. */
export const INSTANCE_ID_RE = /^[0-9a-f]{8}$/;
