/**
 * The outbound redactor (agents/redact.ts, PLAN §6.1 "Account identifiers"): the account's e-mail address and
 * organisation, learned from `accountInfo()`, never leave a session in agent-authored text.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HandoffNotes } from '../../../src/agents/memory.js';
import { AccountRedactor, REDACTED, redactingOrgApi } from '../../../src/agents/redact.js';
import { TranscriptStore } from '../../../src/agents/TranscriptStore.js';
import { PLAYER } from '../../../src/contracts/common.js';
import { FakeOrgApi } from '../../../src/contracts/FakeOrgApi.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const ACCOUNT = { email: 'Pat.Player@example.com', organization: "Pat.Player@example.com's Organization" };

describe('AccountRedactor', () => {
  it('knows nothing until a session reports its account, then redacts case-insensitively', () => {
    const r = new AccountRedactor();
    expect(r.active).toBe(false);
    expect(r.redact('mail pat.player@example.com')).toBe('mail pat.player@example.com');
    r.noteAccount(ACCOUNT);
    expect(r.active).toBe(true);
    expect(r.redact('mail pat.player@example.com or PAT.PLAYER@EXAMPLE.COM now')).toBe(
      `mail ${REDACTED} or ${REDACTED} now`,
    );
    // The organisation named after the e-mail goes as a whole, not as "[redacted]'s Organization".
    expect(r.redact("Billing: Pat.Player@example.com's Organization.")).toBe(`Billing: ${REDACTED}.`);
    // Look-alikes stay.
    expect(r.redact('pat.player@example.co, player@example.com')).toBe(
      'pat.player@example.co, player@example.com',
    );
    // Regex characters in the identifiers are literal.
    const odd = new AccountRedactor();
    odd.noteAccount({ email: 'a+b(c)@x.io' });
    expect(odd.redact('a+b(c)@x.io and aab(c)@x.io')).toBe(`${REDACTED} and aab(c)@x.io`);
  });

  it('ignores missing, malformed and too-short identifiers; learning twice changes nothing', () => {
    const r = new AccountRedactor();
    r.noteAccount(null);
    r.noteAccount({});
    r.noteAccount({ email: 'not an address', organization: 'Org' });
    expect(r.active).toBe(false);
    expect(r.redact('Org is fine')).toBe('Org is fine');
    r.noteAccount({ email: 'a@b.cd', organization: 'Acme Corp' });
    r.noteAccount({ email: 'a@b.cd', organization: 'Acme Corp' });
    expect(r.redact('a@b.cd works at Acme Corp; acme corp too')).toBe(
      `${REDACTED} works at ${REDACTED}; ${REDACTED} too`,
    );
  });

  it('redacts every string of a structure, leaving the rest', () => {
    const r = new AccountRedactor();
    r.noteAccount(ACCOUNT);
    const input = {
      title: 'Contact pat.player@example.com',
      count: 3,
      ok: true,
      tags: ['x', 'pat.player@example.com'],
      nested: { body: 'by pat.player@example.com', none: null },
    };
    expect(r.redactDeep(input)).toEqual({
      title: `Contact ${REDACTED}`,
      count: 3,
      ok: true,
      tags: ['x', REDACTED],
      nested: { body: `by ${REDACTED}`, none: null },
    });
    // Without an account the input comes back as is.
    const idle = new AccountRedactor();
    expect(idle.redactDeep(input)).toBe(input);
  });
});

describe('where agent text leaves a session', () => {
  it('the transcript redacts agent lines but keeps the player’s own lines and answers', () => {
    const r = new AccountRedactor();
    r.noteAccount(ACCOUNT);
    const store = new TranscriptStore({ redact: (t) => r.redact(t) });
    store.append('ada', { kind: 'agent', text: 'I am pat.player@example.com' });
    store.append('ada', { kind: 'activity', text: 'bash: echo pat.player@example.com' });
    store.append('ada', { kind: 'tell', text: 'mail pat.player@example.com', fromAgentId: 'bram' });
    store.append('ada', { kind: 'player', text: 'my mail is pat.player@example.com' });
    store.append('ada', { kind: 'answer', text: 'pat.player@example.com' });
    expect(store.tail('ada', 10).map((e) => e.text)).toEqual([
      `I am ${REDACTED}`,
      `bash: echo ${REDACTED}`,
      `mail ${REDACTED}`,
      'my mail is pat.player@example.com',
      'pat.player@example.com',
    ]);
  });

  it('Vault handoff notes are redacted before they are stored', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mv-redact-'));
    dirs.push(dir);
    const r = new AccountRedactor();
    r.noteAccount(ACCOUNT);
    const notes = new HandoffNotes(dir, { redact: (t) => r.redact(t) });
    await notes.add('linux-1', {
      at: 1,
      author: 'Ada (agent)',
      text: 'Ask pat.player@example.com for the key',
    });
    expect((await notes.list('linux-1'))[0]?.text).toBe(`Ask ${REDACTED} for the key`);
  });

  it('the agents’ OrgApi redacts Codex writes, calendar events and task reports; reads and screens pass through', async () => {
    const r = new AccountRedactor();
    r.noteAccount(ACCOUNT);
    const base = new FakeOrgApi();
    const org = redactingOrgApi(base, r);
    const written = await org.tools.codexWrite('ada-1', {
      mode: 'create',
      title: 'Owner pat.player@example.com',
      body: 'Ask pat.player@example.com',
      category: 'people',
      scope: 'lasting',
    });
    expect(written.ok).toBe(true);
    const page = base.codex.index().pages[0];
    expect(page?.title).toBe(`Owner ${REDACTED}`);
    expect((await base.codex.read(PLAYER, page?.id ?? '')).body).toBe(`Ask ${REDACTED}`);
    const added = await org.tools.calendarAdd('ada-1', {
      title: 'Mail pat.player@example.com',
      kind: 'task',
      assignees: ['ada-1'],
      clock: 'real',
      when: '2099-01-01T08:00:00Z',
      task: 'Write to pat.player@example.com',
    });
    expect(added.ok).toBe(true);
    const event = (await base.calendar.list(PLAYER))[0];
    expect(event?.title).toBe(`Mail ${REDACTED}`);
    expect(JSON.stringify(event)).not.toContain('pat.player');
    // Reads pass through, and the structured API (the screens) is the same object's.
    expect((await org.tools.codexRead('ada-1', { id: page?.id })).text).toContain(`Ask ${REDACTED}`);
    expect(org.codex.index()).toEqual(base.codex.index());
    // The player's own writes through the screens are not touched.
    await org.codex.write(PLAYER, {
      mode: 'create',
      title: 'Mine',
      body: 'pat.player@example.com',
      tags: [],
      category: 'howto',
      scope: 'lasting',
    });
    expect(
      (await base.codex.read(PLAYER, base.codex.index().pages.find((p) => p.title === 'Mine')?.id ?? ''))
        .body,
    ).toBe('pat.player@example.com');
  });
});
