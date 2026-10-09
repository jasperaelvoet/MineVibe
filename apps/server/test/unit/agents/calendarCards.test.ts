import { describe, expect, it } from 'vitest';
import { agentActor, PLAYER } from '../../../src/contracts/common.js';
import { createHarness, openWorldWithCeo } from '../../helpers/agentHarness.js';

describe('calendar approval cards (PLAN §6.6 "Rights and limits")', () => {
  it('approve and decline go to OrgApi.calendar.decide and clear the card', async () => {
    const h = await createHarness();
    try {
      await openWorldWithCeo(h.manager, { worldId: 'w1', gen: 1 });
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
      // So does one whose event is gone altogether (approve and decline alike).
      const gone = h.manager.raiseCalendarApproval(id, 'ev-gone', 'gone');
      await expect(h.manager.answerCard(gone.id, { kind: 'approve' })).resolves.toMatchObject({
        echo: expect.stringContaining('event approved'),
      });
      const gone2 = h.manager.raiseCalendarApproval(id, 'ev-gone', 'gone');
      await h.manager.answerCard(gone2.id, { kind: 'decline' });
      expect(h.manager.pendingCards()).toEqual([]);
    } finally {
      await h.cleanup();
    }
  });
});

describe('meeting chat scope (PLAN §6.5 "During a meeting")', () => {
  it('a meeting that is still gathering takes no unmentioned chat (they route as usual)', async () => {
    const h = await createHarness();
    try {
      await openWorldWithCeo(h.manager, { worldId: 'w1', gen: 1 });
      const id = h.manager.listAgents()[0]?.agentId ?? '';
      // The fake starts a player-chaired meeting in the gathering phase (the wire `chair` is already "player").
      const started = await h.org.meeting.start(PLAYER, { attendees: [id], preview: false });
      expect(h.org.meeting.state()).toMatchObject({ phase: 'gathering', chair: 'player' });
      const lines: string[] = [];
      h.manager.on('meetingMessage', (m) => {
        lines.push(m.text);
      });
      const res = await h.manager.deliverChat({ to: 'all', text: 'is everyone coming?' });
      // The MeetingRunner ignores lines while gathering, so they must not be routed to the meeting.
      expect(res.scope).toBe('broadcast');
      expect(lines).toEqual([]);
      expect(started.meetingId).not.toBeNull();
    } finally {
      await h.cleanup();
    }
  });
});
