import { readFile } from 'node:fs/promises';
import { z } from 'zod';

const Sha256 = z.string().regex(/^[0-9a-f]{64}$/, 'sha256 must be 64 lowercase hex characters');
const HttpsUrl = z
  .string()
  .url()
  .refine((u) => new URL(u).protocol === 'https:', 'url must be https');
const TeamId = z.string().regex(/^[A-Z0-9]{10}$/);
/** A path inside an archive: relative, no `..`. */
const ArchivePath = z
  .string()
  .min(1)
  .refine(
    (p) => !p.startsWith('/') && !p.split('/').includes('..'),
    'archive path must be relative, without ..',
  );

const VendorBase = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
  url: HttpsUrl,
  size: z.number().int().positive(),
  sha256: Sha256,
  sha256Source: z.string().optional(),
  extract: ArchivePath,
  teamId: TeamId,
  license: z.string().min(1),
});

export const VendorLock = z.object({
  $comment: z.string().optional(),
  lockVersion: z.literal(1),
  node: VendorBase.extend({ archive: z.literal('tar.gz') }),
  jre: VendorBase.extend({ archive: z.literal('tar.gz'), javaVersion: z.string().min(1) }),
  container: VendorBase.extend({ archive: z.literal('pkg'), pkgSigner: z.string().min(1) }),
});
export type VendorLock = z.infer<typeof VendorLock>;
export type VendorEntry = VendorLock['node'] | VendorLock['jre'] | VendorLock['container'];

export async function loadVendorLock(path: string): Promise<VendorLock> {
  return VendorLock.parse(JSON.parse(await readFile(path, 'utf8')));
}

/** The file name a vendor archive is cached under (the last URL segment, decoded). */
export function archiveFileName(entry: Pick<VendorEntry, 'url'>): string {
  const name = decodeURIComponent(new URL(entry.url).pathname.split('/').pop() ?? '');
  if (!/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(name)) throw new Error(`unexpected archive name in ${entry.url}`);
  return name;
}
