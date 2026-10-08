/**
 * The world context through the real AgentManager (fake SDK and contract fakes): the Base in the CEO's welcome, the
 * scene line at the head of every turn, PROTECTED refusals noted from job ends, and consent issued only by the
 * player's explicit answer (card or clear chat reply), then attached to the agent's next world job.
 */

import type { AgentBody, PayloadOf } from '@minevibe/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../../helpers/agentHarness.js';
import { type FakeQuery, resultText } from '../../helpers/fakeSdk.js';

let h: Harness | null = null;
afterEach(async () => {
  await h?.cleanup();
  h = null;
});

const OFFICE: NonNullable<PayloadOf<'world.state'>['office']> = {
  origin: { x: 0, y: 64, z: 0 },
  slots: [
    { kind: 'meeting_table', pos: { x: 6, y: 65, z: 4 } },
    { kind: 'door', pos: { x: 6, y: 65, z: 9 } },
  ],
};
const PILLAR = { x: 12, y: 65, z: 0 };
/** Day 2 07:40. */
const CLOCK = 24_000 + 1_667;

function body(agentId: string): AgentBody {
  return {
    agentId,
    pos: { x: 6.5, y: 65, z: 5.5 },
    dim: 'minecraft:overworld',
    hp: 20,
    maxHp: 20,
    food: 18,
    saturation: 4,
    mode: 'follow',
    hasFood: true,
    inCombat: false,
    playerDistance: 4.2,
    zone: { kind: 'base', name: 'Base (office)' },
  };
}

/** A fresh world with an office; the CEO's welcome turn ended. */
async function officeWorld() {
  h = await createHarness();
  const w = h;
  w.manager.onWorldState({ worldId: 'w1', phase: 'ready', office: OFFICE, clockTime: CLOCK });
  await w.manager.openWorld({ worldId: 'w1', gen: 1 });
  const id = w.manager.listAgents()[0]?.agentId ?? '';
  const q = w.query(0);
  await w.until(() => w.texts(q).some((t) => t.includes('WELCOME')), 'welcome');
  q.init();
  q.result();
  await w.until(() => w.manager.brain(id)?.status === 'idle', 'idle');
  w.manager.onAgentState({ tick: 1, agents: [body(id)] });
  return { w, id, q };
}

async function wake(w: Harness, q: FakeQuery, text: string) {
  await w.manager.deliverChat({ to: 'all', text: `@ada ${text}` });
  await w.until(() => w.texts(q).some((t) => t.includes(text)), `wake ${text}`);
}

/** The agent's mine of the house is refused PROTECTED. */
async function refusedMine(w: Harness, q: FakeQuery) {
  w.skills.skillHandler = () => ({ status: 'failed', code: 'PROTECTED', msg: 'part of the Base' });
  // FakeSkillApi reports no result details; the mod's protocol §7.4.3 result is emitted below as the job end.
  const outcome = await q.callTool('mcp__mc__mine', { block: '#minecraft:logs', count: 10 });
  expect(resultText(outcome)).toContain('PROTECTED: part of the Base.');
  // The real refusal (with its blocks) as the mod sends it for a running job.
  w.skills.skillHandler = () => ({ status: 'running' });
  await q.callTool('mcp__mc__mine', { block: 'stripped_spruce_log', count: 2, wait_s: 0 });
  const jobId = w.skills.runningJobs().at(-1) ?? '';
  w.skills.finish(jobId, { status: 'failed', code: 'PROTECTED', msg: 'part of the Base' });
  return jobId;
}

describe('world context on the agent runtime', () => {
  it("the CEO's welcome names the Base and its Codex page; every turn starts with the scene", async () => {
    const { w, id, q } = await officeWorld();
    const welcome = w.texts(q).find((t) => t.includes('WELCOME')) ?? '';
    expect(welcome).toContain(
      'The Base (office) is Jasper\'s home (Codex page "Base (office)", door at 6 65 9). Never break or take its blocks',
    );
    await wake(w, q, 'collect 10 oak logs and make a crafting table');
    const turn = w.texts(q).find((t) => t.includes('collect 10 oak logs')) ?? '';
    const nonce = w.manager.brain(id)?.record.nonce ?? '';
    expect(turn).toContain(
      `[MV:${nonce} DIGEST] Scene: D2 07:40 · in Base (office) · Jasper 4m · no threats.`,
    );
    expect(turn.indexOf('DIGEST')).toBeLessThan(turn.indexOf('collect 10 oak logs'));
    // The persona carries the world primer.
    const append = (q.options.systemPrompt as { append?: string }).append ?? '';
    expect(append).toContain('## The world');
    expect(append).toContain("The Base (the office you start in) is Jasper's home.");
  });

  it('a refused job, then an "Allow" option on the card: consent for exactly those blocks on the next job', async () => {
    const { w, id, q } = await officeWorld();
    await wake(w, q, 'get logs');
    w.skills.skillHandler = () => ({ status: 'running' });
    await q.callTool('mcp__mc__mine', { block: 'stripped_spruce_log', count: 2, wait_s: 0 });
    const jobId = w.skills.runningJobs().at(-1) ?? '';
    // The mod's refusal for a job that outlived its reply: skill.result with the refused blocks.
    w.skills.finish(jobId, {
      status: 'failed',
      code: 'PROTECTED',
      msg: 'part of the Base',
      result: {
        protected: [{ pos: PILLAR, block: 'minecraft:stripped_spruce_log', why: 'base' }],
        zone: 'base',
      },
    });
    // The [JOB FAILED] wake (next turn) teaches the same hard stop.
    q.result();
    await w.until(() => w.texts(q).some((t) => t.includes('JOB FAILED')), 'job failed wake');
    expect(w.texts(q).find((t) => t.includes('JOB FAILED'))).toContain(
      'PROTECTED: part of the Base. 1 block (e.g. stripped_spruce_log at 12 65 0) is part of the Base',
    );
    expect(w.manager.consents.openRefusal(id)).toMatchObject({ positions: [PILLAR], zone: 'base' });
    const asking = q.callTool('AskUserQuestion', {
      questions: [
        {
          question: 'The only logs near are your house. What should I do?',
          header: 'Logs',
          options: [
            { label: 'Go further', description: 'Look for trees further out' },
            { label: 'Allow: take the corner log', description: 'Break one house pillar' },
            { label: 'Skip', description: 'Do something else' },
          ],
          multiSelect: false,
        },
      ],
    });
    await w.until(() => w.manager.pendingCards().length === 1, 'card');
    const answered = await w.manager.deliverChat({ to: 'all', text: '@ada 2' });
    expect(answered.answeredCard).not.toBeNull();
    await asking;
    expect(
      w.events.some(
        (e) =>
          e.type === 'toast' && /Ada may change 1 protected block for 5 min/.test(JSON.stringify(e.payload)),
      ),
    ).toBe(true);
    const nonce = w.manager.brain(id)?.record.nonce ?? '';
    await w.until(() => w.texts(q).some((t) => t.includes(`[MV:${nonce} CONSENT]`)), 'consent notice');
    w.skills.skillHandler = () => ({ status: 'done', result: { summary: 'mined 1 stripped_spruce_log' } });
    await q.callTool('mcp__mc__mine', { block: 'stripped_spruce_log', count: 1 });
    expect(w.skills.runs.at(-1)?.consent).toMatchObject({ agentId: id, positions: [PILLAR] });
    expect(w.skills.runs.at(-1)?.consent?.consentId).toMatch(/^consent-[0-9a-f]{16}$/);
  });

  it('a card answered with anything else, or a bare chat "yes", grants nothing', async () => {
    const { w, id, q } = await officeWorld();
    await wake(w, q, 'get logs');
    await refusedMine(w, q);
    const asking = q.callTool('AskUserQuestion', {
      questions: [
        {
          question: 'What now?',
          options: [{ label: 'Go further' }, { label: 'Allow: take the house logs' }],
          multiSelect: false,
        },
      ],
    });
    await w.until(() => w.manager.pendingCards().length === 1, 'card');
    await w.manager.deliverChat({ to: 'all', text: '@ada 1' });
    await asking;
    expect(w.manager.consents.active(id)).toBeNull();
    const reply = await w.manager.deliverChat({ to: 'all', text: '@ada yes' });
    expect(reply.echo).toContain('not a permission');
    expect(w.manager.consents.active(id)).toBeNull();
    w.skills.skillHandler = () => ({ status: 'done' });
    await q.callTool('mcp__mc__mine', { block: 'oak_log', count: 1 });
    expect(w.skills.runs.at(-1)?.consent).toBeUndefined();
  });

  it('a clear chat reply to that agent grants it (and says so in the echo); a broadcast never does', async () => {
    const { w, id, q } = await officeWorld();
    await wake(w, q, 'get logs');
    const jobId = await refusedMine(w, q);
    // FakeSkillApi.finish carries no result: the refusal has no positions, so chat cannot grant a zone.
    expect(w.manager.consents.openRefusal(id)).toMatchObject({ positions: [], zone: 'base' });
    expect(jobId).not.toBe('');
    w.skills.skillHandler = () => ({
      status: 'failed',
      code: 'PROTECTED',
      msg: 'part of the Base',
      result: { protected: [{ pos: PILLAR, block: 'minecraft:stripped_spruce_log' }] },
    });
    await q.callTool('mcp__mc__mine', { block: 'stripped_spruce_log', count: 1 });
    const broadcast = await w.manager.deliverChat({ to: 'all', text: 'yes, take them from the house' });
    expect(broadcast.echo).not.toContain('permission');
    expect(w.manager.consents.active(id)).toBeNull();
    const direct = await w.manager.deliverChat({ to: 'all', text: '@ada yes, take them from the house' });
    expect(direct.echo).toContain('(permission: Ada may change 1 protected block for 5 min)');
    expect(w.manager.consents.active(id)).toMatchObject({ positions: [PILLAR] });
  });
});
