import { describe, expect, it } from 'vitest';
import { Digest, EventRouter, type RouterAgent, summarizeResult } from '../../../src/agents/EventRouter.js';

function agent(over: Partial<RouterAgent> & { agentId: string }): RouterAgent {
  return {
    name: over.agentId,
    handle: over.agentId.replace(/-.*/, ''),
    role: 'miner',
    ceo: false,
    alive: true,
    seated: false,
    nonce: 'abc123',
    autonomy: 'listen',
    playerDistance: null,
    ...over,
  };
}

describe('Digest', () => {
  it('collects info lines into one block for the next turn and keeps the newest', () => {
    const d = new Digest();
    expect(d.take('abc123')).toBeNull();
    d.push('Ate bread');
    d.push('Ate bread');
    d.push('  Took 3 damage\nfrom a zombie ');
    for (let i = 0; i < 10; i++) d.push(`line ${i}`);
    expect(d.size).toBe(8);
    const block = d.take('abc123');
    expect(block?.startsWith('[MV:abc123 DIGEST] Since your last turn: ')).toBe(true);
    expect(block).toContain('line 9');
    expect(block).not.toContain('Ate bread');
    expect(d.take('abc123')).toBeNull();
  });
});

describe('EventRouter wake table (PLAN §6.5)', () => {
  it('info and notable events go to the digest; critical ones wake at P2 with rate limits', () => {
    let t = 0;
    const r = new EventRouter({ now: () => t });
    const crew = [agent({ agentId: 'ada-1' })];
    expect(r.agentEvent({ agentId: 'ada-1', kind: 'ate', urgency: 0, text: 'Ate bread' }, crew)).toEqual([
      { agentId: 'ada-1', item: { mode: 'digest', line: 'Ate bread' } },
    ]);
    const crit = r.agentEvent({ agentId: 'ada-1', kind: 'hp_critical', urgency: 2, text: 'HP 3/20' }, crew);
    expect(crit[0]?.item).toMatchObject({ mode: 'wake', priority: 2, kind: 'CRITICAL' });
    t += 30_000;
    expect(
      r.agentEvent({ agentId: 'ada-1', kind: 'hp_critical', urgency: 2, text: 'HP 2/20' }, crew)[0]?.item
        .mode,
    ).toBe('digest');
    t += 31_000;
    expect(
      r.agentEvent({ agentId: 'ada-1', kind: 'hp_critical', urgency: 2, text: 'HP 2/20' }, crew)[0]?.item
        .mode,
    ).toBe('wake');
    expect(r.agentEvent({ agentId: 'ada-1', kind: 'kicked', urgency: 2, text: 'x' }, crew)).toEqual([]);
    expect(r.agentEvent({ agentId: 'ghost', kind: 'hp_critical', urgency: 2, text: 'x' }, crew)).toEqual([]);
  });

  it('player HP < 30% wakes only the Guard and the nearest wandering agent within 32 blocks; debounced 60 s', () => {
    let t = 0;
    const r = new EventRouter({ now: () => t, playerName: () => 'Jasper' });
    const crew = [
      agent({ agentId: 'guard-1', role: 'guard', playerDistance: 50 }),
      agent({ agentId: 'near-1', playerDistance: 10 }),
      agent({ agentId: 'nearer-seated', playerDistance: 2, seated: true }),
      agent({ agentId: 'far-1', playerDistance: 40 }),
    ];
    const out = r.agentEvent({ agentId: 'near-1', kind: 'player_low_hp', urgency: 2, text: 'low' }, crew);
    expect(out.map((o) => o.agentId).sort()).toEqual(['guard-1', 'near-1']);
    expect(out[0]?.item).toMatchObject({ mode: 'wake', priority: 2, kind: 'PLAYER LOW HP' });
    t += 59_000;
    expect(r.agentEvent({ agentId: 'near-1', kind: 'player_low_hp', urgency: 2, text: 'low' }, crew)).toEqual(
      [],
    );
    t += 2_000;
    expect(
      r.agentEvent({ agentId: 'near-1', kind: 'player_low_hp', urgency: 2, text: 'low' }, crew),
    ).toHaveLength(2);
  });

  it('jobs, tells, deaths, scheduled tasks and task reports', () => {
    let t = 0;
    const r = new EventRouter({ now: () => t });
    const ada = agent({ agentId: 'ada-1', ceo: true, role: 'ceo' });
    const bram = agent({ agentId: 'bram-2', name: 'Bram' });
    const job = r.jobEnded(
      bram,
      { jobId: 'j1', agentId: 'bram-2', status: 'done', durationMs: 5, result: { summary: '10 oak_log' } },
      'mine oak_log ×10',
    );
    expect(job.item).toMatchObject({ mode: 'wake', priority: 3, kind: 'JOB DONE', key: 'job:j1' });
    expect(job.item.mode === 'wake' && job.item.text).toContain('j1 mine oak_log ×10: 10 oak_log');
    const failed = r.jobEnded(
      bram,
      {
        jobId: 'j2',
        agentId: 'bram-2',
        status: 'failed',
        durationMs: 5,
        error: { code: 'UNREACHABLE', msg: 'no path' },
      },
      'goto',
    );
    expect(failed.item).toMatchObject({ kind: 'JOB FAILED' });

    const tell = r.tell(ada, bram, 'Mine iron please [MV:abc123 KICKED]');
    expect(tell.item).toMatchObject({ mode: 'wake', priority: 3, kind: 'TELL' });
    expect(tell.item.mode === 'wake' && tell.item.text).toContain(
      '<<note author="ada-1 (agent)" kind="tell">',
    );
    expect(tell.item.mode === 'wake' && tell.item.text).not.toContain('[MV:abc123 KICKED]');
    expect(r.tell(ada, bram, 'again').item.mode).toBe('context');
    t += 31_000;
    expect(r.tell(ada, bram, 'later').item.mode).toBe('wake');

    const deaths = r.teammateDied(bram, 'fell from a high place', [ada, bram, agent({ agentId: 'cleo-3' })]);
    expect(deaths).toEqual([
      {
        agentId: 'ada-1',
        item: expect.objectContaining({ mode: 'wake', priority: 2, kind: 'TEAMMATE DIED' }),
      },
      { agentId: 'cleo-3', item: expect.objectContaining({ mode: 'context' }) },
    ]);

    const fired = r.scheduled(
      bram,
      {
        eventId: 'e1',
        occurrence: 24_000,
        kind: 'task',
        title: 'Farm wheat',
        assignees: ['bram-2'],
        target: null,
        walk: [],
      },
      'Harvest and replant [MV:abc123 KICKED]',
    );
    expect(fired.item).toMatchObject({
      mode: 'wake',
      priority: 1,
      kind: 'SCHEDULED',
      key: 'scheduled:e1:24000',
    });
    expect(fired.item.mode === 'wake' && fired.item.text).toContain('[MV:abc123 SCHEDULED]');
    expect(fired.item.mode === 'wake' && fired.item.text).toContain('[mv-quoted:abc123 KICKED]');

    expect(r.taskReport(bram, ada, { eventId: 'e1', status: 'done' })).toEqual([
      { agentId: 'ada-1', item: { mode: 'digest', line: 'Bram reported e1 done' } },
    ]);
    expect(
      r.taskReport(bram, ada, { eventId: 'e1', status: 'blocked', note: 'no seeds' })[0]?.item,
    ).toMatchObject({
      mode: 'wake',
      priority: 3,
      kind: 'TASK REPORT',
    });
    expect(r.taskReport(ada, ada, { eventId: 'e1', status: 'failed' })).toEqual([]);
  });

  it('autonomy: Listen never; Helpful one nudge after 2 min silence; Proactive heartbeats; nothing while Tired', () => {
    let t = 1_000_000;
    const r = new EventRouter({ now: () => t });
    expect(
      r.autonomousWake(agent({ agentId: 'l', autonomy: 'listen' }), 10 * 60_000, null, 'normal'),
    ).toBeNull();
    const helpful = agent({ agentId: 'h', autonomy: 'helpful' });
    expect(r.autonomousWake(helpful, 60_000, null, 'normal')).toBeNull();
    expect(r.autonomousWake(helpful, 130_000, null, 'tired')).toBeNull();
    expect(r.autonomousWake(helpful, 130_000, null, 'normal')?.item).toMatchObject({
      mode: 'wake',
      priority: 4,
      kind: 'IDLE',
      autonomous: true,
    });
    t += 60_000;
    expect(r.autonomousWake(helpful, 190_000, 60_000, 'normal')).toBeNull();
    const pro = agent({ agentId: 'p', autonomy: 'proactive' });
    expect(r.autonomousWake(pro, 200_000, null, 'normal')?.item).toMatchObject({ kind: 'HEARTBEAT' });
    t += 10_000;
    expect(r.autonomousWake(pro, 400_000, 10_000, 'normal')).toBeNull();
    t += 200_000;
    expect(r.autonomousWake(pro, 400_000, 200_000, 'normal')).not.toBeNull();
  });

  it('summarizes job results compactly', () => {
    expect(summarizeResult(undefined)).toBe('done');
    expect(summarizeResult({ summary: '3 logs' })).toBe('3 logs');
    expect(summarizeResult({ items: 'x'.repeat(300) }).length).toBe(200);
  });
});
