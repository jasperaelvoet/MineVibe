import { readFile } from 'node:fs/promises';
import { z } from 'zod';

const Sha256 = z.string().regex(/^[0-9a-f]{64}$/, 'sha256 must be 64 lowercase hex characters');
const HttpsUrl = z
  .string()
  .url()
  .refine((u) => new URL(u).protocol === 'https:', 'url must be https');
const TeamId = z.string().regex(/^[A-Z0-9]{10}$/);
/** A path inside an archive or install root: relative, no `..`. */
const ArchivePath = z
  .string()
  .min(1)
  .refine(
    (p) => !p.startsWith('/') && !p.split('/').includes('..'),
    'archive path must be relative, without ..',
  );
/** A file name for the download cache. */
const FileName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._+-]*$/, 'unexpected archive file name');

const TarVendor = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
  url: HttpsUrl,
  size: z.number().int().positive(),
  sha256: Sha256,
  sha256Source: z.string().optional(),
  archive: z.literal('tar.gz'),
  extract: ArchivePath,
  teamId: TeamId,
  license: z.string().min(1),
});

/**
 * `packaging/vendor.lock.json`. The `container` entry has the shape the PC manager reads too
 * (`apps/server/src/pcs/drivers/ContainerRuntime.ts`, `readContainerLock`): one file, one pin for both.
 */
export const VendorLock = z.object({
  $comment: z.string().optional(),
  version: z.literal(1),
  node: TarVendor,
  jre: TarVendor.extend({ javaVersion: z.string().min(1) }),
  container: z.object({
    version: z.string().min(1),
    license: z.string().min(1),
    pkg: z.object({ name: FileName, url: HttpsUrl, size: z.number().int().positive(), sha256: Sha256 }),
    /** The first certificate of `pkgutil --check-signature`. */
    signer: z.string().min(1),
    teamId: TeamId,
    /**
     * Payload files or folders left out of the install root: Apple's update and uninstall scripts, and the `k8s`
     * plugin (61 MB; a CLI-only Kubernetes helper MineVibe never runs, and `system start`, `build` and `run` work
     * without it).
     */
    exclude: z.array(ArchivePath).default([]),
    /** Every file of the install root with its sha256: the bundled copy must hold exactly these. */
    installRootFiles: z.record(ArchivePath, Sha256).refine((files) => 'bin/container' in files, {
      message: 'installRootFiles must list bin/container',
    }),
  }),
  /** Container images (PC manager); not bundled. */
  images: z.record(z.string(), z.unknown()).optional(),
});
export type VendorLock = z.infer<typeof VendorLock>;
export type TarVendorEntry = VendorLock['node'] | VendorLock['jre'];

export async function loadVendorLock(path: string): Promise<VendorLock> {
  return VendorLock.parse(JSON.parse(await readFile(path, 'utf8')));
}

/** The file name a tar vendor archive is cached under (the last URL segment, decoded). */
export function archiveFileName(entry: Pick<TarVendorEntry, 'url'>): string {
  const name = decodeURIComponent(new URL(entry.url).pathname.split('/').pop() ?? '');
  if (!FileName.safeParse(name).success) throw new Error(`unexpected archive name in ${entry.url}`);
  return name;
}

/**
 * Checks an install root against `installRootFiles`: every listed file with its sha256, and no other regular file.
 * `files` maps each regular file under the root (relative, `/`) to its sha256. Returns the problems (empty = ok).
 */
export function checkInstallRoot(
  files: ReadonlyMap<string, string>,
  want: Readonly<Record<string, string>>,
): string[] {
  const problems: string[] = [];
  for (const [rel, sha] of Object.entries(want)) {
    const got = files.get(rel);
    if (got === undefined) problems.push(`${rel}: missing`);
    else if (got !== sha) problems.push(`${rel}: sha256 ${got}, the lock pins ${sha}`);
  }
  for (const rel of files.keys()) if (!(rel in want)) problems.push(`${rel}: not in installRootFiles`);
  return problems;
}
