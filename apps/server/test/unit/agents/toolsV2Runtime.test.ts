import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
    expect(b.texts(q2).find((t) => t.includes('TOOLS UPDATED'))).toContain('mine, collect, pickup, hunt (for drops) → gather');
  });
});

describe('v2 texts and gate', () => {
  it('texts name the tool set of the process', () => {
    expect(mcToolsVersion({})).toBe('v1');
    expect(mcToolsVersion({ MINEVIBE_MC_TOOLS: 'V2' })).toBe('v2');
    expect(mcToolsVersion({ MINEVIBE_MC_TOOLS: 'v3' })).toBe('v1');
    expect(mcRefs('v2').reportTaskWith('ev-3')).toBe('mcp__mc__calendar{"action":"report","id":"ev-3","status":"done"}');
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
    expect(toolsUpdatedNote('abcdef', 'v1', 'v2')).toMatch(/^\[MV:abcdef TOOLS UPDATED\] Your mc tools changed/);
  });

  it('the scheduled-task wake names report in the tool set the router was made for', () => {
    const router = new EventRouter({ mcTools: 'v2' });
    const routed = router.scheduled(
      { agentId: 'ada1', name: 'Ada', handle: 'ada', nonce: 'abcdef', alive: true, ceo: true } as never,
      { eventId: 'ev-3', occurrence: 1, title: 'Mine', kind: 'task', assignees: ['ada1'] } as never,
      'Mine iron',
    );
    const text = (routed.item as { text: string }).text;
    expect(text).toContain('When done, call mcp__mc__calendar{"action":"report","id":"ev-3","status":"done"}.');
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
    const wandering = { seat: { ...seat, state: 'wandering', kind: null, pcId: null, epoch: 0 } } as Partial<GateContext>;
    expect((await decide('calendar', { action: 'add', title: 't', when: 'now' }, wandering)).behavior).toBe('allow');
    expect(
      (await decide('calendar', { action: 'add', title: 't', when: 'now', assignees: ['ada1'] }, wandering)).behavior,
    ).toBe('deny');
    expect(
      (await decide('calendar', { action: 'add', title: 't', when: 'now', assignees: ['bram1'] }, wandering)).behavior,
    ).toBe('allow');
    // v1 sessions keep v1 names.
    expect((await decide('gather', { item: 'x', count: 1 }, { ...wandering, mcTools: 'v1' })).behavior).toBe('deny');
    expect((await decide('mine', { block: 'x', count: 1 }, { ...wandering, mcTools: 'v1' })).behavior).toBe('allow');
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
    expect(end.result).toMatchObject({ completed: 1, steps: [{ skill: 'collect', status: 'done' }, { skill: 'craft', status: 'cancelled' }] });
    expect(fake.runningJobs()).not.toContain(second);
    expect(ends).toContain('mseq-1:cancelled');
  });

  it('a mod with the cap runs sequences itself', async () => {
    const fake = new FakeSkillApi();
    fake.capSet = new Set(['skill.sequence']);
    const api = new SequenceFallbackSkillApi(fake);
    await api.runSkill({
      agentId: 'ada1',
      skill: 'sequence',
      args: { steps: [{ skill: 'eat', args: {} }, { skill: 'eat', args: {} }] },
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
        args: { steps: [{ skill: 'collect', args: { item: 'oak_log' } }, { skill: 'eat', args: {} }] } as never,
        replace: true,
      }),
    ).rejects.toThrow(/steps\.0\.args\.count/);
  });
});
