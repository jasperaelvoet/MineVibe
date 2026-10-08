/** A code-signing identity from `security find-identity -v -p codesigning`. */
export interface SigningIdentity {
  /** SHA-1 of the certificate (what codesign is given). */
  readonly hash: string;
  /** e.g. `Apple Development: Jane Doe (ABCDE12345)`. */
  readonly name: string;
}

/** Parses `security find-identity -v -p codesigning` output (valid identities only). */
export function parseIdentities(output: string): SigningIdentity[] {
  const out: SigningIdentity[] = [];
  for (const line of output.split('\n')) {
    const m = /^\s*\d+\)\s+([0-9A-F]{40})\s+"([^"]+)"\s*$/.exec(line);
    if (m?.[1] && m[2]) out.push({ hash: m[1], name: m[2] });
  }
  return out;
}

/**
 * PLAN §9.1: local builds sign with the free Apple Development identity when there is one (stable TCC and Local
 * Network grants across rebuilds); otherwise ad hoc. Never picks a Developer ID here (release signing is separate).
 */
export function chooseIdentity(identities: readonly SigningIdentity[]): SigningIdentity | null {
  return identities.find((i) => i.name.startsWith('Apple Development:')) ?? null;
}
