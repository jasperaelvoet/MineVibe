/**
 * Page revisions. Inside Node a page's `rev` is a counter (1, 2, …); everywhere outside (the wire's `Rev`, agent
 * text, the PC export) it is a 7-digit zero-padded token (`0000003`), which matches the protocol's `Rev`
 * (`^[0-9a-f]{7,64}$`), so the token an agent reads is exactly the `base_rev` it passes back.
 */

/** Width of the revision token. */
export const REV_WIDTH = 7;

/** The token of a page revision counter. */
export function encodeRev(rev: number): string {
  return String(Math.max(0, Math.trunc(rev))).padStart(REV_WIDTH, '0');
}

/**
 * A page revision counter from a token, a number or a digit string. Anything else (a git hash, garbage) is -1, which
 * never matches a page, so an update with it is refused as a conflict (with the current text).
 */
export function decodeRev(rev: string | number | undefined | null): number | undefined {
  if (rev === undefined || rev === null) return undefined;
  if (typeof rev === 'number') return Number.isInteger(rev) && rev >= 0 ? rev : -1;
  const t = rev.trim();
  return /^\d{1,15}$/.test(t) ? Number.parseInt(t, 10) : -1;
}
