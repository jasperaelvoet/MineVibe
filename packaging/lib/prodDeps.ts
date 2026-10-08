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

/** The Agent SDK's platform packages (`@anthropic-ai/claude-agent-sdk-darwin-arm64`), which carry its own claude. */
const SDK_PLATFORM_PACKAGE = /^@anthropic-ai\/claude-agent-sdk-[a-z0-9]+-[a-z0-9]+$/;

/**
 * Files a release build leaves out, relative to `node_modules` (PLAN §9.1): the SDK's own `claude` binary (about
 * 236 MB). Release builds run the user's own claude only; a dev build keeps it for `MINEVIBE_CLAUDE=bundled`.
 */
export function releasePrunedFiles(packages: readonly string[]): string[] {
  return packages.filter((rel) => SDK_PLATFORM_PACKAGE.test(rel)).map((rel) => `${rel}/claude`);
}

/**
 * Copies each package into `<dest>/node_modules/<rel>` byte for byte (modes, symlinks and timestamps kept). A
 * package's own `node_modules` is not copied wholesale: its nested production packages are listed (and copied)
 * on their own, so dev-only leftovers never ride along. `prune` lists files (relative to `node_modules`) to leave
 * out.
 */
export async function copyProductionPackages(
  repoRoot: string,
  packages: readonly string[],
  dest: string,
  prune: readonly string[] = [],
): Promise<void> {
  const pruned = new Set(prune.map((rel) => join(repoRoot, 'node_modules', ...rel.split('/'))));
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
      filter: (path) => !(basename(path) === 'node_modules' && dirname(path) === src) && !pruned.has(path),
    });
  }
}
