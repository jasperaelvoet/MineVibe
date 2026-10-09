import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MOD_CAPS } from '@minevibe/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { EventRouter } from '../../../src/agents/EventRouter.js';
import { personaPrompt } from '../../../src/agents/prompts/persona.js';
import { decideTool, type GateContext } from '../../../src/agents/ToolGate.js';
import { toolsUpdatedNote } from '../../../src/agents/tools/toolRefs.js';
import { FakeSkillApi } from '../../../src/contracts/FakeSkillApi.js';
import { mcRefs, mcToolsVersion } from '../../../src/contracts/mcRefs.js';
import { SequenceFallbackSkillApi } from '../../../src/contracts/SequenceFallback.js';
import { createHarness, type Harness } from '../../helpers/agentHarness.js';
import { resultText } from '../../helpers/fakeSdk.js';

const harnesses: Harness[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.cleanup();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function v2World(dir?: string, mcTools: 'v1' | 'v2' = 'v2') {
  const h = await createHarness({ mcTools, ...(dir ? { dir } : {}) });
  harnesses.push(h);
  await h.manager.openWorld({ worldId: 'w1', gen: 1 });
  const ceoId = h.manager.listAgents()[0]?.agentId ?? '';
  const q = h.query(0);
  await h.until(() => h.texts(q).some((t) => t.includes('WELCOME')), 'welcome');
  q.init();
  q.result();
  await h.until(() => h.manager.brain(ceoId)?.status === 'idle', 'idle');
  return { h, q, ceoId };
}

describe('v2 tools in the agent runtime', () => {
  it('a v2 session gets the v2 set: v1 names are denied, the persona names the composite tools', async () => {
    const { h, q } = await v2World();
    await h.manager.deliverChat({ to: 'all', text: '@ada collect 10 oak logs and make a crafting table' });
    await h.until(() => h.texts(q).some((t) => t.includes('oak logs')), 'wake');
    const denied = await q.callTool('mcp__mc__mine', { block: 'oak_log', count: 10 });
    expect(denied.kind).toBe('denied');
    const persona = JSON.stringify(q.options.systemPrompt);
    expect(persona).toContain('mcp__mc__gather');
    expect(persona).not.toContain('mcp__mc__mine');
    expect(persona).not.toContain('mcp__mc__look_around');
    expect(persona).toContain('mcp__mc__calendar{action:\\"add\\"}');
  });

  it('a running job wakes the agent with the v2 result line; a job the agent replaced wakes nobody', async () => {
    const { h, q, ceoId } = await v2World();
    await h.manager.deliverChat({ to: 'all', text: '@ada get logs' });
    await h.until(() => h.texts(q).some((t) => t.includes('get logs')), 'wake');
    h.skills.skillHandler = () => ({ status: 'running' });
    const out = await q.callTool('mcp__mc__gather', { item: 'oak_log', count: 10 });
    expect(out.kind).toBe('allowed');
    expect(resultText(out)).toMatch(/^running: gather oak_log \(job j/);
    // A second world call replaces the first: its cancel is in this result, not in a wake.
    const second = await q.callTool('mcp__mc__gather', { item: 'birch_log', count: 2 });
    expect(resultText(second)).toMatch(/\(stopped your previous job j\S+ gather oak_log\)/);
    q.result();
    await h.until(() => h.manager.brain(ceoId)?.status === 'idle', 'idle');
    const jobId = h.skills.runningJobs()[0] ?? '';
    h.skills.finish(jobId, {
      status: 'done',
      result: { item: 'minecraft:birch_log', got: 2, have: 2, footer: 'HP 20/20' },
    });
    await h.until(() => h.texts(q).some((t) => t.includes('JOB DONE')), 'job done wake');
    const wakes = h.texts(q).filter((t) => t.includes('JOB DONE') || t.includes('JOB FAILED'));
    expect(wakes).toHaveLength(1);
    expect(wakes[0]).toMatch(new RegExp(`JOB DONE\\] ${jobId} gather birch_log 2/2 \\| have birch_log 2$`));
  });

  it('a job its job{wait} saw end is not woken for again after the turn', async () => {
    const { h, q, ceoId } = await v2World();
    await h.manager.deliverChat({ to: 'all', text: '@ada get logs' });
    await h.until(() => h.texts(q).some((t) => t.includes('get logs')), 'wake');
    h.skills.skillHandler = () => ({ status: 'running' });
    await q.callTool('mcp__mc__gather', { item: 'oak_log', count: 10 });
    const jobId = h.skills.runningJobs()[0] ?? '';
    const waiting = q.callTool('mcp__mc__job', { action: 'wait', seconds: 30 });
    await new Promise((r) => setTimeout(r, 20));
    h.skills.finish(jobId, { status: 'done', result: { item: 'minecraft:oak_log', got: 10, have: 10 } });
    expect(resultText(await waiting)).toMatch(/^done: gather oak_log 10\/10/);
    q.result();
    await h.until(() => h.manager.brain(ceoId)?.status === 'idle', 'idle');
    // A job that ends while nobody waits still wakes the agent (the control case).
    h.skills.skillHandler = () => ({ status: 'running' });
    await h.manager.deliverChat({ to: 'all', text: '@ada more logs' });
    await h.until(() => h.texts(q).some((t) => t.includes('more logs')), 'second wake');
    await q.callTool('mcp__mc__gather', { item: 'birch_log', count: 2 });
    q.result();
    await h.until(() => h.manager.brain(ceoId)?.status === 'idle', 'idle again');
    const second = h.skills.runningJobs()[0] ?? '';
    h.skills.finish(second, { status: 'done', result: { item: 'minecraft:birch_log', got: 2, have: 2 } });
    await h.until(() => h.texts(q).some((t) => t.includes('JOB DONE')), 'job done wake');
    const wakes = h.texts(q).filter((t) => t.includes('JOB DONE') || t.includes('JOB FAILED'));
    expect(wakes).toHaveLength(1);
    expect(wakes[0]).toContain(`JOB DONE] ${second} gather birch_log 2/2`);
  });

  for (const native of [true, false]) {
    it(`a do step the mod refused PROTECTED can be allowed (${native ? "the mod's sequence" : "Node's macro"})`, async () => {
      const { h, q, ceoId } = await v2World();
      h.skills.capSet = new Set(Object.values(MOD_CAPS).filter((c) => native || c !== MOD_CAPS.SEQUENCE));
      await h.manager.deliverChat({ to: 'all', text: '@ada knock down that cabin wall' });
      await h.until(() => h.texts(q).some((t) => t.includes('cabin wall')), 'wake');
      const TOKEN = '0123456789abcdef0123456789abcdef';
      const refused = {
        dug: 0,
        protected: {
          pos: { x: 6, y: 66, z: -6 },
          what: 'player-built',
          owner: 'Player',
          block: 'minecraft:stripped_spruce_log',
          count: 1,
          consentId: TOKEN,
        },
      };
      const allowed = (args: unknown) => (args as { allow_protected?: boolean }).allow_protected === true;
      h.skills.skillHandler = (r) => {
        if (r.skill === 'sequence') {
          return allowed(r.args)
            ? { status: 'done', result: { completed: 2, steps: [] } }
            : {
                status: 'failed',
                code: 'PROTECTED',
                msg: "step 2/2 dig: that is part of Player's build",
                result: {
                  completed: 1,
                  steps: [
                    { skill: 'goto', status: 'done', result: {} },
                    {
                      skill: 'dig',
                      status: 'failed',
                      code: 'PROTECTED',
                      msg: 'player-built',
                      result: refused,
                    },
                  ],
                },
              };
        }
        if (r.skill === 'dig' && !allowed(r.args)) {
          return { status: 'failed', code: 'PROTECTED', msg: 'player-built', result: refused };
        }
        return { status: 'done', result: {} };
      };
      const call = {
        steps: [
          { tool: 'goto', args: { to: '6 66 -4' } },
          { tool: 'build', args: { action: 'dig', from: '6 66 -6', to: '6 66 -6' } },
        ],
      };
      const out = await q.callTool('mcp__mc__do', call);
      expect(resultText(out)).toMatch(/^failed: do step 2\/2 build \| PROTECTED/);
      // The token is the refused step's: the player's "Allow" can grant it.
      expect(h.manager.consents.openRefusal(ceoId)).toMatchObject({ consentId: TOKEN, zone: 'built' });
      expect(h.manager.consents.fromChat(ceoId, 'yes, break the stripped spruce log').kind).toBe('granted');
      const runs = h.skills.runs.length;
      const retry = await q.callTool('mcp__mc__do', call);
      expect(resultText(retry)).toMatch(/^done: do /);
      const consented = h.skills.runs.slice(runs).filter((r) => r.consent !== undefined);
      expect(consented.map((r) => [r.skill, r.consent])).toEqual([
        [native ? 'sequence' : 'dig', { token: TOKEN }],
      ]);
      expect(consented[0]?.args).toMatchObject({ allow_protected: true });
    });
  }

  it('a session resumed under the other tool set is told the new names once', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mv-v2-resume-'));
    dirs.push(dir);
    const a = await v2World(dir, 'v1');
    await a.h.manager.shutdown();
    harnesses.splice(harnesses.indexOf(a.h), 1);
    a.h.manager.dispose();
    const b = await createHarness({ dir, mcTools: 'v2' });
    harnesses.push(b);
    await b.manager.openWorld({ worldId: 'w1', gen: 1 });
    const q2 = b.query(0);
    expect(q2.options.resume).toBe(a.q.options.sessionId);
    await b.until(() => b.texts(q2).some((t) => t.includes('TOOLS UPDATED')), 'tools note');
    expect(b.texts(q2).find((t) => t.includes('TOOLS UPDATED'))).toContain(
      'mine, collect, pickup, hunt (for drops) → gather',
    );
  });
});

describe('v2 texts and gate', () => {
  it('texts name the tool set of the process', () => {
    expect(mcToolsVersion({})).toBe('v1');
    expect(mcToolsVersion({ MINEVIBE_MC_TOOLS: 'V2' })).toBe('v2');
    expect(mcToolsVersion({ MINEVIBE_MC_TOOLS: 'v3' })).toBe('v1');
    expect(mcRefs('v2').reportTaskWith('ev-3')).toBe(
      'mcp__mc__calendar{"action":"report","id":"ev-3","status":"done"}',
    );
    expect(mcRefs('v1').codexRead).toBe('mcp__mc__codex_read');
    const v2 = personaPrompt({
      name: 'Ada',
      handle: 'ada',
      role: 'ceo',
      ceo: true,
      playerName: 'Jasper',
      nonce: 'abcdef',
      mcTools: 'v2',
    });
    for (const old of ['calendar_add', 'report_task', 'codex_search', 'mcp__mc__mine', 'mcp__mc__collect']) {
      expect(v2, old).not.toContain(old);
    }
    expect(toolsUpdatedNote('abcdef', 'v1', 'v2')).toMatch(
      /^\[MV:abcdef TOOLS UPDATED\] Your mc tools changed/,
    );
  });

  it('the scheduled-task wake names report in the tool set the router was made for', () => {
    const router = new EventRouter({ mcTools: 'v2' });
    const routed = router.scheduled(
      { agentId: 'ada1', name: 'Ada', handle: 'ada', nonce: 'abcdef', alive: true, ceo: true } as never,
      { eventId: 'ev-3', occurrence: 1, title: 'Mine', kind: 'task', assignees: ['ada1'] } as never,
      'Mine iron',
    );
    const text = (routed.item as { text: string }).text;
    expect(text).toContain(
      'When done, call mcp__mc__calendar{"action":"report","id":"ev-3","status":"done"}.',
    );
    expect(text).not.toContain('report_task');
  });

  it('the gate follows the session set and the action of each call', async () => {
    const seat = {
      state: 'seated',
      kind: 'pc',
      pcId: 'linux-1',
      meetingId: null,
      epoch: 1,
      since: 0,
      purpose: null,
      jobId: null,
      debounceUntil: 0,
      lastPcId: null,
      awayExpiresAt: null,
      lastEnd: null,
    } as const;
    const ctx = (over: Partial<GateContext> = {}): GateContext => ({
      agentId: 'bram1',
      ceo: false,
      seat,
      occupant: () => 'bram1',
      trackedMode: 'bypassPermissions',
      plans: { isPlanPath: () => false } as never,
      turn: { calls: 0, activeMs: 0 },
      playerName: 'Jasper',
      mcTools: 'v2',
      ...over,
    });
    const decide = (tool: string, input: Record<string, unknown>, over?: Partial<GateContext>) =>
      decideTool(`mcp__mc__${tool}`, input, ctx(over));
    expect((await decide('items', { action: 'eat' })).behavior).toBe('allow');
    expect((await decide('items', { action: 'give', item: 'x', to: 'player' })).behavior).toBe('deny');
    expect((await decide('craft', { item: 'stick', plan: true })).behavior).toBe('allow');
    expect((await decide('craft', { item: 'stick' })).behavior).toBe('deny');
    expect((await decide('menu', { action: 'state' })).behavior).toBe('allow');
    expect((await decide('observe', {})).behavior).toBe('allow');
    expect((await decide('mine', { block: 'oak_log', count: 1 })).behavior).toBe('deny');
    // Scheduling others is the CEO's: without assignees v2 schedules for the caller.
    const wandering = {
      seat: { ...seat, state: 'wandering', kind: null, pcId: null, epoch: 0 },
    } as Partial<GateContext>;
    expect((await decide('calendar', { action: 'add', title: 't', when: 'now' }, wandering)).behavior).toBe(
      'allow',
    );
    expect(
      (await decide('calendar', { action: 'add', title: 't', when: 'now', assignees: ['ada1'] }, wandering))
        .behavior,
    ).toBe('deny');
    expect(
      (await decide('calendar', { action: 'add', title: 't', when: 'now', assignees: ['bram1'] }, wandering))
        .behavior,
    ).toBe('allow');
    // v1 sessions keep v1 names.
    expect((await decide('gather', { item: 'x', count: 1 }, { ...wandering, mcTools: 'v1' })).behavior).toBe(
      'deny',
    );
    expect((await decide('mine', { block: 'x', count: 1 }, { ...wandering, mcTools: 'v1' })).behavior).toBe(
      'allow',
    );
  });
});

describe('Node sequence fallback (§11 M1 without the mod cap)', () => {
  it('runs the steps as one macro job with step progress, ends with the sequence result, cancels as one', async () => {
    const fake = new FakeSkillApi();
    const api = new SequenceFallbackSkillApi(fake);
    fake.skillHandler = () => ({ status: 'running' });
    const progress: string[] = [];
    const ends: string[] = [];
    api.on('progress', (p) => {
      progress.push(`${p.jobId}:${p.text}`);
    });
    api.on('result', (e) => {
      ends.push(`${e.jobId}:${e.status}`);
    });
    const res = await api.runSkill({
      agentId: 'ada1',
      skill: 'sequence',
      args: {
        steps: [
          { skill: 'collect', args: { item: 'oak_log', count: 2 } },
          { skill: 'craft', args: { item: 'crafting_table', count: 1 } },
        ],
      },
      waitMs: 5,
      replace: true,
      jobId: 'mseq-1',
    });
    expect(res).toEqual({ jobId: 'mseq-1', status: 'running' });
    const first = fake.runningJobs()[0] ?? '';
    fake.progress(first, '1/2 oak_log');
    expect(progress).toContain('mseq-1:step 1/2 1/2 oak_log');
    fake.finish(first, { status: 'done', result: { got: 2 } });
    await new Promise((r) => setTimeout(r, 5));
    expect(fake.runs.map((r) => r.skill)).toEqual(['collect', 'craft']);
    const second = fake.runningJobs()[0] ?? '';
    expect(await api.cancelSkill('ada1', { jobId: 'mseq-1', reason: 'stop' })).toEqual(['mseq-1']);
    const end = await api.awaitJob('mseq-1', 1_000);
    expect(end.status).toBe('cancelled');
    expect(end.result).toMatchObject({
      completed: 1,
      steps: [
        { skill: 'collect', status: 'done' },
        { skill: 'craft', status: 'cancelled' },
      ],
    });
    expect(fake.runningJobs()).not.toContain(second);
    expect(ends).toContain('mseq-1:cancelled');
  });

  it('another job started between two steps ends the macro; its next step never replaces that job', async () => {
    const fake = new FakeSkillApi();
    const api = new SequenceFallbackSkillApi(fake);
    fake.skillHandler = () => ({ status: 'running' });
    await api.runSkill({
      agentId: 'ada1',
      skill: 'sequence',
      args: {
        steps: [
          { skill: 'collect', args: { item: 'oak_log', count: 2 } },
          { skill: 'craft', args: { item: 'crafting_table', count: 1 } },
        ],
      },
      waitMs: 5,
      replace: true,
      jobId: 'mseq-2',
    });
    const first = fake.runningJobs()[0] ?? '';
    // Step 1 ends and, before the macro gets to step 2, the agent starts a goto.
    fake.finish(first, { status: 'done', result: { got: 2 } });
    const gotoRun = api.runSkill({
      agentId: 'ada1',
      skill: 'goto',
      args: { entity: 'player' },
      waitMs: 0,
      replace: true,
      jobId: 'jgoto-1',
    });
    const end = await api.awaitJob('mseq-2', 1_000);
    await gotoRun;
    expect(end.status).toBe('cancelled');
    expect(end.error?.msg).toBe('replaced by goto');
    expect(fake.runs.map((r) => r.skill)).toEqual(['collect', 'goto']);
    expect(fake.runningJobs()).toEqual(['jgoto-1']);
  });

  it('a replacing run refused for bad arguments leaves the macro running', async () => {
    const fake = new FakeSkillApi();
    const api = new SequenceFallbackSkillApi(fake);
    fake.skillHandler = () => ({ status: 'running' });
    await api.runSkill({
      agentId: 'ada1',
      skill: 'sequence',
      args: {
        steps: [
          { skill: 'collect', args: { item: 'oak_log', count: 2 } },
          { skill: 'craft', args: { item: 'crafting_table', count: 1 } },
        ],
      },
      waitMs: 5,
      replace: true,
      jobId: 'mseq-3',
    });
    await expect(
      api.runSkill({ agentId: 'ada1', skill: 'goto', args: {} as never, replace: true }),
    ).rejects.toThrow(/BAD_ARGS|exactly one/);
    const first = fake.runningJobs()[0] ?? '';
    fake.finish(first, { status: 'done', result: { got: 2 } });
    await new Promise((r) => setTimeout(r, 5));
    expect(fake.runs.map((r) => r.skill)).toEqual(['collect', 'craft']);
  });

  it('a mod with the cap runs sequences itself', async () => {
    const fake = new FakeSkillApi();
    fake.capSet = new Set(['skill.sequence']);
    const api = new SequenceFallbackSkillApi(fake);
    await api.runSkill({
      agentId: 'ada1',
      skill: 'sequence',
      args: {
        steps: [
          { skill: 'eat', args: {} },
          { skill: 'eat', args: {} },
        ],
      },
      replace: true,
    });
    expect(fake.runs.map((r) => r.skill)).toEqual(['sequence']);
  });

  it('a bad step is BAD_ARGS before anything runs', async () => {
    const api = new SequenceFallbackSkillApi(new FakeSkillApi());
    await expect(
      api.runSkill({
        agentId: 'ada1',
        skill: 'sequence',
        args: {
          steps: [
            { skill: 'collect', args: { item: 'oak_log' } },
            { skill: 'eat', args: {} },
          ],
        } as never,
        replace: true,
      }),
    ).rejects.toThrow(/steps\.0\.args\.count/);
  });
});
