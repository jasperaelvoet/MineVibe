/**
 * The outbound redactor (PLAN §6.1 "Account identifiers").
 *
 * Claude Code injects the account's e-mail address into every session as a `session_context` attachment, and records
 * the organisation id in the transcript as a `credential_org` attachment (spike S3b). The CLI (2.1.293) has no
 * supported switch to leave them out: the e-mail is only skipped when `ANTHROPIC_UNIX_SOCKET` reroutes the transport,
 * and `credential_org` renders to nothing in the model's prompt (the id stays in the on-disk transcript only). So the
 * model can read the e-mail address, and the persona tells it never to repeat account identifiers.
 *
 * This is the backstop: every piece of agent-authored text that leaves a session (speech bubbles, the chat transcript,
 * tells, Codex writes, calendar events and task reports, meeting minutes, Vault handoff notes, hire requests) passes
 * {@link AccountRedactor.redact}, which replaces the account's e-mail address and organisation (from `accountInfo()`,
 * kept only in memory, never logged or stored) with `[redacted]`. Typing and the clipboard inside a PC are out of
 * scope. Until a session reports its account the redactor knows nothing and passes text through.
 */

import type { OrgAgentTools, OrgApi } from '../contracts/OrgApi.js';
import type { AccountInfo } from './sdk.js';

export const REDACTED = '[redacted]';

/** Shortest organisation name that is redacted (shorter ones would hit ordinary words). */
const MIN_ORG_CHARS = 4;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export class AccountRedactor {
  #pattern: RegExp | null = null;
  readonly #needles = new Set<string>();

  /** Learns the identifiers of the account a session runs on (`accountInfo()`); safe to call for every session. */
  noteAccount(account: Pick<AccountInfo, 'email' | 'organization'> | null | undefined): void {
    if (!account) return;
    const before = this.#needles.size;
    const email = account.email?.trim();
    if (email && EMAIL_RE.test(email)) this.#needles.add(email.toLowerCase());
    const org = account.organization?.trim();
    if (org && org.length >= MIN_ORG_CHARS) this.#needles.add(org.toLowerCase());
    if (this.#needles.size === before) return;
    // Longest first, so an organisation named after the e-mail ("ada@x.org's Organization") goes as a whole.
    const alternatives = [...this.#needles].sort((a, b) => b.length - a.length).map(escapeRegExp);
    this.#pattern = new RegExp(alternatives.join('|'), 'gi');
  }

  /** Whether any identifier is known. */
  get active(): boolean {
    return this.#pattern !== null;
  }

  /** `text` with every known account identifier replaced by `[redacted]` (case-insensitive). */
  redact(text: string): string {
    const pattern = this.#pattern;
    if (pattern === null || text.length === 0) return text;
    pattern.lastIndex = 0;
    return text.replace(pattern, REDACTED);
  }

  /** Every string inside `value` (objects and arrays, recursively) redacted; other values unchanged. */
  redactDeep<T>(value: T): T {
    if (this.#pattern === null) return value;
    return this.#deep(value, 0) as T;
  }

  #deep(value: unknown, depth: number): unknown {
    if (typeof value === 'string') return this.redact(value);
    if (depth > 8 || value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map((v) => this.#deep(v, depth + 1));
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = this.#deep(v, depth + 1);
    return out;
  }
}

/** The org agent tools that write shared text (Codex pages, calendar events, task reports). */
const WRITING_TOOLS: readonly (keyof OrgAgentTools)[] = [
  'codexWrite',
  'calendarAdd',
  'calendarUpdate',
  'reportTask',
];

/**
 * The OrgApi an agent's `mc` tools see: the same services, with every string of a Codex write, calendar add or update
 * and task report redacted before it is stored and shown to others. Reads, the screens' structured calls and the
 * events pass through unchanged.
 */
export function redactingOrgApi(org: OrgApi, redactor: Pick<AccountRedactor, 'redactDeep'>): OrgApi {
  const tools = org.tools;
  const wrapped = {} as Record<keyof OrgAgentTools, OrgAgentTools[keyof OrgAgentTools]>;
  // Listed by name: class-based tools keep their methods on the prototype, where Object.keys does not look.
  for (const name of [
    'codexSearch',
    'codexRead',
    'codexWrite',
    'codexList',
    'calendarList',
    'calendarAdd',
    'calendarUpdate',
    'calendarCancel',
    'reportTask',
  ] as const) {
    const fn = tools[name];
    wrapped[name] = WRITING_TOOLS.includes(name)
      ? (agentId: string, input: unknown) => fn.call(tools, agentId, redactor.redactDeep(input))
      : fn.bind(tools);
  }
  const agentTools = wrapped as unknown as OrgAgentTools;
  return new Proxy(org, {
    get(target, key, receiver) {
      if (key === 'tools') return agentTools;
      const value = Reflect.get(target, key, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
