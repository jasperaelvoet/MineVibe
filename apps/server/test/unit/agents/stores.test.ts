import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MEMORY_MAX_BYTES } from '../../../src/agents/constants.js';
import { Chronicle, HandoffNotes, MemoryStore } from '../../../src/agents/memory.js';
import { TranscriptStore } from '../../../src/agents/TranscriptStore.js';

const tmp: string[] = [];
afterEach(() => {
  for (const d of tmp.splice(0)) rmSync(d, { recursive: true, force: true });
});
function dir(): string {
  const d = mkdtempSync(join(tmpdir(), 'mv-stores-'));
  tmp.push(d);
  return d;
}

describe('TranscriptStore', () => {
  it('appends numbered entries, pages them and persists chat.jsonl', async () => {
    const d = dir();
    const fileOf = (id: string) => join(d, id, 'chat.jsonl');
    let t = 100;
    const s = new TranscriptStore({ fileOf, now: () => t++ });
    const seen: number[] = [];
    s.on('append', (_id, e) => {
      seen.push(e.seq);
    });
    s.append('ada', { kind: 'player', text: 'hi' });
    expect(s.append('ada', { kind: 'agent', text: '   ' })).toBeNull();
    for (let i = 0; i < 5; i++) s.append('ada', { kind: 'activity', text: `step ${i}` });
    s.append('ada', { kind: 'tell', text: 'x'.repeat(9000), fromAgentId: 'bram' });
    expect(seen).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(s.page('ada', { limit: 3 })).toMatchObject({
      more: true,
      entries: [{ seq: 4 }, { seq: 5 }, { seq: 6 }],
    });
    expect(s.page('ada', { beforeSeq: 2, limit: 10 })).toMatchObject({
      more: false,
      entries: [{ seq: 0 }, { seq: 1 }],
    });
    expect(s.tail('ada', 1)[0]?.text.length).toBe(8000);
    await s.flush();
    const lines = readFileSync(fileOf('ada'), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(7);
    writeFileSync(fileOf('ada'), `${lines.join('\n')}\n{"torn`);
    const reloaded = new TranscriptStore({ fileOf });
    await reloaded.load('ada');
    expect(reloaded.page('ada', { limit: 200 }).entries).toHaveLength(7);
    expect(reloaded.append('ada', { kind: 'system', text: 'restarted' })?.seq).toBe(7);
  });
});

describe('MemoryStore', () => {
  it('appends notes to memory.md and drops the oldest past the 8 KB cap', async () => {
    const d = dir();
    const m = new MemoryStore((id) => join(d, id, 'memory.md'));
    await m.remember('ada', 'iron cave at 120,40,-80', '[Day 2 08:00]');
    expect(await m.text('ada')).toBe('- [Day 2 08:00] iron cave at 120,40,-80');
    let dropped = 0;
    for (let i = 0; i < 30; i++)
      dropped += (await m.remember('ada', `note ${i} ${'y'.repeat(500)}`, '[t]')).dropped;
    expect(dropped).toBeGreaterThan(0);
    const raw = readFileSync(join(d, 'ada', 'memory.md'), 'utf8');
    expect(Buffer.byteLength(raw)).toBeLessThanOrEqual(MEMORY_MAX_BYTES);
    expect(raw).toContain('note 29');
    expect(raw).not.toContain('iron cave');
    const fresh = new MemoryStore((id) => join(d, id, 'memory.md'));
    expect((await fresh.notes('ada')).at(-1)).toContain('note 29');
  });
});

describe('HandoffNotes and Chronicle', () => {
  it('keeps the last 5 handoff notes per PC or mount', async () => {
    const h = new HandoffNotes(join(dir(), 'vault-handoffs'));
    for (let i = 0; i < 7; i++) await h.add('linux-1', { at: i, author: 'Ada (agent)', text: `note ${i}` });
    const notes = await h.list('linux-1');
    expect(notes.map((n) => n.text)).toEqual(['note 2', 'note 3', 'note 4', 'note 5', 'note 6']);
    expect(await h.list('/Users/jasper/Code/foo')).toEqual([]);
  });

  it('chronicles worlds within the cap, one entry per world', async () => {
    const c = new Chronicle(join(dir(), 'chronicle.json'));
    await c.add({ worldId: 'w1', gen: 1, text: 'ended on Day 3: fell.' });
    await c.add({ worldId: 'w1', gen: 1, text: 'ended on Day 4: lava.' });
    await c.add({ worldId: 'w2', gen: 2, text: 'ended on Day 9: creeper.' });
    expect(await c.paragraph()).toBe('World #1: ended on Day 4: lava.\nWorld #2: ended on Day 9: creeper.');
    for (let i = 3; i < 40; i++) await c.add({ worldId: `w${i}`, gen: i, text: 'x'.repeat(300) });
    expect((await c.paragraph()).length).toBeLessThanOrEqual(6000);
    expect(await c.paragraph()).toContain('World #39');
  });
});
