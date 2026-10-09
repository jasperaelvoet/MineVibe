import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentManager } from '../../../src/agents/AgentManager.js';
import type { BridgeServer } from '../../../src/bridge/BridgeServer.js';
import { resolvePaths } from '../../../src/config/paths.js';
import type { FakeOrgApi } from '../../../src/contracts/FakeOrgApi.js';
import { gameTicksAt } from '../../../src/org/clock.js';
import { ControlNonce } from '../../../src/org/envelope.js';
import { type CrewCardControl, createOrgModuleWith } from '../../../src/org/module.js';
import { createHarness, type Harness, openWorldWithCeo } from '../../helpers/agentHarness.js';
import { FakeUiBridge } from '../../helpers/fakeUiBridge.js';
import { FakeHooks } from '../../helpers/orgCrew.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn().catch(() => {});
});

// Compile-time: the AgentManager offers the card store the org module drives (presenting, parked, approval cards).
const _offersCards = (m: AgentManager): CrewCardControl => m;
void _offersCards;

describe('org module with the real AgentManager as its crew', () => {
  it('a calendar approval card is raised in the manager, presented (presenting flag) and approved by the player', async () => {
    const home = mkdtempSync(join(tmpdir(), 'mv-orgmgr-'));
    cleanups.push(async () => rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
    const bridge = new FakeUiBridge();
    const mod = createOrgModuleWith(
      {
        bridge: bridge as unknown as BridgeServer,
        paths: resolvePaths({ env: { MINEVIBE_HOME: home } }),
        log: pino({ level: 'silent' }),
        world: () => ({ worldId: 'w1', gen: 1 }),
        mode: 'dev',
      },
      { nonce: new ControlNonce('beef'), gitBinary: null, timeZone: 'UTC', defer: (fn) => fn() },
    );
    await mod.start();
    cleanups.push(() => mod.stop());
    const h: Harness = await createHarness({
      dir: join(home, 'agents'),
      org: mod.orgApi as unknown as FakeOrgApi,
    });
    cleanups.push(() => h.cleanup());
    await openWorldWithCeo(h.manager, { worldId: 'w1', gen: 1 });
    await mod.onWorldOpen('w1', true);
    const hooks = new FakeHooks();
    mod.bindCrew(h.manager, hooks);
    const ceo = h.manager.listAgents()[0];
    if (!ceo) throw new Error('no CEO');
    bridge.fire('world.state', {
      worldId: 'w1',
      phase: 'ready',
      clockTime: gameTicksAt(2, 9),
      player: {
        pos: { x: 0, y: 64, z: 0 },
        dim: 'minecraft:overworld',
        hp: 20,
        maxHp: 20,
        food: 20,
        inCombat: false,
        idleMs: 0,
      },
    });
    bridge.fire('agent.state', {
      tick: 1,
      agents: [
        {
          agentId: ceo.agentId,
          pos: { x: 8, y: 64, z: 0 },
          dim: 'minecraft:overworld',
          hp: 20,
          maxHp: 20,
          food: 20,
          saturation: 5,
          mode: 'follow',
          hasFood: true,
          inCombat: false,
          playerDistance: 8,
        },
      ],
    });

    const added = await mod.orgApi.tools.calendarAdd(ceo.agentId, {
      title: 'Daily standup',
      kind: 'meeting',
      assignees: 'all',
      clock: 'game',
      when: 'Day 3 08:00',
      recurrence: { kind: 'daily' },
    });
    expect(added).toMatchObject({ ok: true, text: expect.stringContaining('approval') });
    const [card] = h.manager.pendingCards();
    expect(card).toMatchObject({ kind: 'calendar', agentId: ceo.agentId, presenting: true, parked: false });
    expect(bridge.pushed('agent.approach')).toEqual([
      { agentId: ceo.agentId, pendingId: card?.id, role: 'present' },
    ]);

    await h.manager.answerCard(card?.id ?? '', { kind: 'approve' });
    const eventId = card?.kind === 'calendar' ? card.eventId : '';
    expect(mod.services.calendar.get(eventId)?.status).toBe('active');
    expect(h.manager.pendingCards()).toEqual([]);
    expect(bridge.pushed('agent.approach').at(-1)).toEqual({
      agentId: ceo.agentId,
      pendingId: null,
      role: 'release',
    });
  });
});
