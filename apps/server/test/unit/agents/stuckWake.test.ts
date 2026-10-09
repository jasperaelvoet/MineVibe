/**
 * A stuck body speaks up (PLAN §7.3, water exits): the mod's urgency-2 `stuck` event (the WaterEscape reflex gave up,
 * or a walk keeps failing from the same spot) makes Node say the stuck bark at once and wakes the body's brain at P2,
 * and that turn opens without the "one sec" bark talking over it.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { EventRouter, type RouterAgent, STUCK_WAKE_KEY, stuckBark } from '../../../src/agents/EventRouter.js';
import { BARKS } from '../../../src/agents/prompts/barks.js';
import { hintFor } from '../../../src/agents/tools/format.js';
import { createHarness, type Harness, openWorldWithCeo } from '../../helpers/agentHarness.js';

let h: Harness | null = null;
afterEach(async () => {
  await h?.cleanup();
  h = null;
});

const WATER_TEXT =
  "I'm stuck in water at 12 63 -40 and found no way out (no bank low enough, nothing to step on, nowhere to stand and dig). Ask the player to help, or say if I should dig out.";

function crewOf(agentId: string): RouterAgent[] {
  return [
    {
      agentId,
      name: 'Ada',
      handle: 'ada',
      role: 'ceo',
      ceo: true,
      alive: true,
      seated: false,
      nonce: 'abc123',
      autonomy: 'listen',
      playerDistance: 4,
    },
  ];
}

describe('stuck events', () => {
  it('an urgency-2 stuck wakes the body at P2 (CRITICAL); urgency 1 stays in the digest', () => {
    const r = new EventRouter({ now: () => 0 });
    const crew = crewOf('ada-1');
    const wake = r.agentEvent(
      {
        agentId: 'ada-1',
        kind: 'stuck',
        urgency: 2,
        text: WATER_TEXT,
        data: { why: 'water', bark: 'stuck_in_water' },
      },
      crew,
    );
    expect(wake).toHaveLength(1);
    expect(wake[0]?.item).toMatchObject({ mode: 'wake', priority: 2, kind: 'CRITICAL', key: STUCK_WAKE_KEY });
    expect(wake[0]?.item.mode === 'wake' && wake[0].item.text).toContain('stuck in water at 12 63 -40');
    expect(
      new EventRouter({ now: () => 0 }).agentEvent(
        { agentId: 'ada-1', kind: 'stuck', urgency: 1, text: 'stuck at 1 2 3' },
        crew,
      ),
    ).toEqual([{ agentId: 'ada-1', item: { mode: 'digest', line: 'stuck at 1 2 3' } }]);
  });

  it('stuckBark: water or a walk, only for urgency-2 stuck', () => {
    const base = { agentId: 'ada-1', text: 'x' } as const;
    expect(stuckBark({ ...base, kind: 'stuck', urgency: 2, data: { why: 'water' } })).toBe(
      BARKS.stuckInWater,
    );
    expect(stuckBark({ ...base, kind: 'stuck', urgency: 2, data: { why: 'nav' } })).toBe(BARKS.stuck);
    expect(stuckBark({ ...base, kind: 'stuck', urgency: 2 })).toBe(BARKS.stuck);
    expect(stuckBark({ ...base, kind: 'stuck', urgency: 1, data: { why: 'water' } })).toBeNull();
    expect(stuckBark({ ...base, kind: 'hp_critical', urgency: 2 })).toBeNull();
  });

  it('the body barks at once and its idle brain wakes with the event; no "one sec" bark over it', async () => {
    h = await createHarness();
    await openWorldWithCeo(h.manager, { worldId: 'w1', gen: 1 });
    const id = h.manager.listAgents()[0]?.agentId ?? '';
    const q = h.query(0);
    await h.until(() => h?.texts(q).some((t) => t.includes('WELCOME')) ?? false, 'welcome');
    q.init();
    q.result();
    await h.until(() => h?.manager.brain(id)?.status === 'idle', 'idle');
    const barksBefore = h.events.filter((e) => e.type === 'say').length;

    h.manager.onAgentEvent({
      agentId: id,
      kind: 'stuck',
      urgency: 2,
      text: WATER_TEXT,
      data: { why: 'water', reason: 'no_path', bark: 'stuck_in_water' },
    });

    await h.until(
      () => h?.texts(q).some((t) => t.includes('stuck in water at 12 63 -40')) ?? false,
      'stuck wake',
    );
    const wakeText = h.texts(q).find((t) => t.includes('stuck in water at 12 63 -40')) ?? '';
    expect(wakeText).toContain('CRITICAL');
    const says = h.events.slice(0).filter((e) => e.type === 'say');
    const barks = says.slice(barksBefore).map((e) => (e.payload as { bark?: string }).bark);
    expect(barks).toEqual(['stuck_in_water']);
  });

  it('a job failed STUCK_IN_WATER says to ask, not to retry', () => {
    const next =
      hintFor(
        'STUCK_IN_WATER',
        { tool: 'goto', skill: 'goto', what: 'goto 10 64 10' },
        { here: null, playerName: 'Jordan' },
      ) ?? '';
    expect(next).toContain('ask Jordan');
    expect(next).toContain("Don't retry");
    expect(next.length).toBeLessThanOrEqual(160);
  });
});
