import { cp, mkdir } from 'node:fs/promises';
import { basename, dirname, join, sep } from 'node:path';

/**
 * The server's production packages from `npm ls --omit=dev --workspace @minevibe/server --all --parseable`, as paths
 * relative to `<repoRoot>/node_modules` (`ws`, `@xmcl/core`, `pino-pretty/node_modules/sonic-boom`, …). Workspace
 * packages (`@minevibe/*`) are left out: esbuild bundles them into main.mjs.
 */
export function productionPackages(lsOutput: string, repoRoot: string): string[] {
  const nodeModules = join(repoRoot, 'node_modules') + sep;
  const out = new Set<string>();
  for (const line of lsOutput.split('\n')) {
    const path = line.trim();
    if (!path.startsWith(nodeModules)) {
      // A package npm could not hoist (`apps/server/node_modules/x`) would be left out of the bundle, and the app
      // would fail at runtime with "Cannot find module". Fail the build instead.
      if (path.includes(`${sep}node_modules${sep}`))
        throw new Error(`${path}: a production package outside ${nodeModules} (hoist or dedupe it)`);
      continue; // the repo root and workspace folders
    }
    const rel = path.slice(nodeModules.length).split(sep).join('/');
    if (rel === '' || rel.startsWith('@minevibe/') || rel.split('/').includes('..')) continue;
    out.add(rel);
  }
  return [...out].sort();
}

/**
 * Copies each package into `<dest>/node_modules/<rel>` byte for byte (modes, symlinks and timestamps kept). A
 * package's own `node_modules` is not copied wholesale: its nested production packages are listed (and copied)
 * on their own, so dev-only leftovers never ride along.
 */
export async function copyProductionPackages(
  repoRoot: string,
  packages: readonly string[],
  dest: string,
): Promise<void> {
  for (const rel of packages) {
    const src = join(repoRoot, 'node_modules', ...rel.split('/'));
    const target = join(dest, 'node_modules', ...rel.split('/'));
    await mkdir(dirname(target), { recursive: true });
    await cp(src, target, {
      recursive: true,
      verbatimSymlinks: true,
      preserveTimestamps: true,
      errorOnExist: true,
      force: false,
      filter: (path) => !(basename(path) === 'node_modules' && dirname(path) === src),
    });
  }
}
