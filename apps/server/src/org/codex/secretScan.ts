/**
 * Secret scan for Codex writes (PLAN §6.6 "Quality controls"): known key prefixes and high-entropy strings.
 * Pages are mounted into every PC and shown to every agent, so anything that looks like a credential is refused.
 * The scan reports only *kinds*, never the matched text, so a refusal never echoes the secret.
 */

interface PrefixRule {
  readonly kind: string;
  readonly re: RegExp;
}

const PREFIX_RULES: readonly PrefixRule[] = [
  { kind: 'anthropic_key', re: /\bsk-ant-[A-Za-z0-9_-]{10,}/ },
  { kind: 'openai_key', re: /\bsk-(?:proj-|live-|test-)?[A-Za-z0-9_-]{20,}/ },
  { kind: 'github_token', re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/ },
  { kind: 'github_pat', re: /\bgithub_pat_[A-Za-z0-9_]{20,}/ },
  { kind: 'gitlab_token', re: /\bglpat-[A-Za-z0-9_-]{16,}/ },
  { kind: 'slack_token', re: /\bxox[abposr]-[A-Za-z0-9-]{10,}/ },
  { kind: 'aws_access_key', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { kind: 'google_api_key', re: /\bAIza[0-9A-Za-z_-]{30,}/ },
  { kind: 'stripe_key', re: /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}/ },
  { kind: 'npm_token', re: /\bnpm_[A-Za-z0-9]{30,}/ },
  { kind: 'huggingface_token', re: /\bhf_[A-Za-z0-9]{30,}/ },
  { kind: 'private_key', re: /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/ },
  { kind: 'jwt', re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/ },
  { kind: 'url_credentials', re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]{3,}@/i },
  {
    kind: 'assignment',
    re: /\b(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|bearer)\b["']?\s*[:=]\s*["']?[^\s"'`]{8,}/i,
  },
  { kind: 'bearer_header', re: /\bAuthorization:\s*Bearer\s+[A-Za-z0-9._~+/-]{16,}/i },
];

/** Shannon entropy in bits per character. */
export function shannonEntropy(s: string): number {
  if (s.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX_RE = /^[0-9a-f]+$/i;

/**
 * True for a token that looks like a random credential:
 * - hex of 32+ characters, except git/sha256 digests (40 and 64 characters, which notes cite legitimately);
 * - otherwise 20+ characters mixing letters and digits with entropy ≥ 4.0 bits/char (base64 / base62 keys).
 * Words, identifiers (no digits), UUIDs and paths split at `/` and `.` stay allowed.
 */
export function isHighEntropyToken(token: string): boolean {
  if (UUID_RE.test(token)) return false;
  if (HEX_RE.test(token)) {
    if (token.length === 40 || token.length === 64) return false;
    return token.length >= 32 && shannonEntropy(token) >= 3.0;
  }
  if (token.length < 20) return false;
  const hasDigit = /\d/.test(token);
  const hasLetter = /[A-Za-z]/.test(token);
  if (!hasDigit || !hasLetter) return false;
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[_+=-]/].filter((re) => re.test(token)).length;
  if (classes < 3) return false;
  return shannonEntropy(token) >= 4.0;
}

export interface SecretScanResult {
  readonly found: boolean;
  /** Rule kinds that matched (never the matched text). */
  readonly kinds: readonly string[];
}

/** Scans text for credentials. */
export function scanForSecrets(text: string): SecretScanResult {
  const kinds = new Set<string>();
  for (const rule of PREFIX_RULES) if (rule.re.test(text)) kinds.add(rule.kind);
  for (const token of text.split(/[^A-Za-z0-9_+=-]+/)) {
    if (token.length >= 20 && isHighEntropyToken(token.replace(/^[=_+-]+|[=_+-]+$/g, ''))) {
      kinds.add('high_entropy');
      break;
    }
  }
  return { found: kinds.size > 0, kinds: [...kinds] };
}
