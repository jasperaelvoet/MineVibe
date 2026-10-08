import { describe, expect, it } from 'vitest';
import { agentActor } from '../../../src/contracts/common.js';
import { createHarness } from '../../helpers/agentHarness.js';

describe('calendar approval cards (PLAN §6.6 "Rights and limits")', () => {
  it('approve and decline go to OrgApi.calendar.decide and clear the card', async () => {
    const h = await createHarness();
    try {
      await h.manager.openWorld({ worldId: 'w1', gen: 1 });
      const id = h.manager.listAgents()[0]?.agentId ?? '';
      const event = {
        kind: 'task' as const,
        assignees: [id],
        clock: 'game' as const,
        at: 48_000,
        recurrence: { kind: 'daily' as const },
        durationMin: 30,
        catchUp: 'skip' as const,
        runWhileAway: false,
      };
      const mining = await h.org.calendar.add(agentActor(id), { ...event, title: 'Daily mining' });
      expect(mining.needsApproval).toBe(true);
      const card = h.manager.raiseCalendarApproval(
        id,
        mining.eventId,
        'task for you, daily from Day 3 06:00',
      );
      const approved = await h.manager.answerCard(card.id, { kind: 'approve' });
      expect(approved.echo).toContain('event approved');
      expect(h.org.calendar.state().events.find((e) => e.id === mining.eventId)?.status).toBe('active');
      expect(h.manager.pendingCards()).toEqual([]);

      const fishing = await h.org.calendar.add(agentActor(id), { ...event, title: 'Daily fishing' });
      const card2 = h.manager.raiseCalendarApproval(id, fishing.eventId, 'task for you, daily');
      await h.manager.answerCard(card2.id, { kind: 'decline', note: 'not now' });
      expect(h.org.calendar.state().events.find((e) => e.id === fishing.eventId)?.status).toBe('cancelled');
      expect(h.manager.pendingCards()).toEqual([]);

      // A card whose event was decided elsewhere (CalendarScreen) still clears.
      const stale = h.manager.raiseCalendarApproval(id, mining.eventId, 'again');
      await h.manager.answerCard(stale.id, { kind: 'approve' });
      expect(h.manager.pendingCards()).toEqual([]);
    } finally {
      await h.cleanup();
    }
  });
});
