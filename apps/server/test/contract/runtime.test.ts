/**
 * The composed runtime (orchestrator/runtime.ts) against the bridgeSim fake mod, a scripted brain (fake SDK, zero
 * tokens) and recording PC and org modules: composition order, world events, the CEO at the office door, CrewHooks
 * over the real bridge, the world-end flow, and a brainless end-to-end chat → turn → skill.run → result → bubble.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolvePaths } from '../../src/config/paths.js';
import type { CrewApi } from '../../src/contracts/CrewApi.js';
import { FakeOrgApi } from '../../src/contracts/FakeOrgApi.js';
import { FakePcApi } from '../../src/contracts/FakePcApi.js';
import { silentLogger } from '../../src/log.js';
import type {
  CreateOrgModule,
  CreatePcModule,
  CrewHooks,
  OrgModule,
  PcModule,
} from '../../src/orchestrator/modules.js';
import { officeDoor, type Runtime, startRuntime } from '../../src/orchestrator/runtime.js';
import { settle } from '../helpers/fakeSdk.js';
import { type ScriptedBrain, scriptedBrain, type TurnScript } from '../helpers/scriptedBrain.js';
import { BridgeSim, SIM_FOOTER, type SimOffice } from '../sim/bridgeSim.js';

const dirs: string[] = [];
const runtimes: Runtime[] = [];
const sims: BridgeSim[] = [];

afterEach(async () => {
  for (const s of sims.splice(0)) s.close();
  await Promise.all(runtimes.splice(0).map((r) => r.stop()));
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const OFFICE: SimOffice = {
  origin: { x: 6, y: 64, z: -44 },
  slots: [
    { kind: 'workstation', pos: { x: 8, y: 64, z: -42 }, pcId: 'linux-1' },
    { kind: 'door', pos: { x: 12, y: 64, z: -35 } },
    { kind: 'meeting_table', pos: { x: 12, y: 64, z: -38 } },
  ],
};

interface Recorded {
  readonly calls: string[];
  readonly clocks: number[];
  bound: { crew: CrewApi; hooks: CrewHooks } | null;
  pc: CreatePcModule;
  org: CreateOrgModule;
}

/** PC and org modules that record what the runtime does with them. */
function recordingModules(): Recorded {
  const rec: Recorded = {
    calls: [],
    clocks: [],
    bound: null,
    pc: (ctx, opts) => {
      rec.calls.push(`pc.create:${opts.runtime}:${ctx.mode}`);
      const module: PcModule = {
        pcApi: new FakePcApi([]),
        start: async () => {
          rec.calls.push('pc.start');
        },
        stop: async () => {
          rec.calls.push('pc.stop');
        },
        onWorldOpen: (worldId, fresh) => {
          rec.calls.push(`pc.open:${worldId}:${fresh}:${JSON.stringify(ctx.world())}`);
        },
        onWorldEnded: (worldId) => {
          rec.calls.push(`pc.ended:${worldId}`);
        },
        onClock: (t) => {
          rec.clocks.push(t);
        },
      };
      return module;
    },
    org: () => {
      const module: OrgModule = {
        orgApi: new FakeOrgApi(),
        bindCrew: (crew, hooks) => {
          rec.calls.push('org.bind');
          rec.bound = { crew, hooks };
        },
        start: async () => {
          rec.calls.push('org.start');
        },
        stop: async () => {
          rec.calls.push('org.stop');
        },
        onWorldOpen: (worldId, fresh) => {
          rec.calls.push(`org.open:${worldId}:${fresh}`);
        },
        onWorldEnded: (worldId) => {
          rec.calls.push(`org.ended:${worldId}`);
        },
        onClock: () => {},
      };
      return module;
    },
  };
  return rec;
}

/** The default script: a turn that asks for logs mines them; anything else gets a short answer. */
const defaultScript: TurnScript = (text) => {
  if (/LAST WORDS/.test(text)) return [{ say: 'Goodbye, Jordan.' }];
  if (/MEETING/.test(text)) return [{ say: 'Mined logs today. Next I build a hut. Then more.' }];
  // A whole word: every first turn opens with the "Minecraft mode" banner (agents/modes.ts).
  if (/\bmine\b/i.test(text))
    return [
      // The default (v2) mc tools: gather gets an item from nature.
      { tool: { name: 'mcp__mc__gather', input: { item: 'oak_log', count: 3 } } },
      { say: 'Got 3 oak logs.' },
    ];
  return [{ say: 'Hello Jordan.' }];
};

async function start(
  options: { script?: TurnScript; crew?: 'agents' | 'none'; officeDoorWaitMs?: number } = {},
): Promise<{ runtime: Runtime; sim: BridgeSim; mods: Recorded; brain: ScriptedBrain; dir: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'mv-runtime-'));
  dirs.push(dir);
  const mods = recordingModules();
  const brain = scriptedBrain(options.script ?? defaultScript);
  const runtime = await startRuntime({
    mode: 'dev',
    paths: resolvePaths({ env: { MINEVIBE_HOME: dir } }),
    log: silentLogger(),
    savesDir: join(dir, 'saves'),
    env: {},
    port: 0,
    heartbeatMs: 0,
    crew: options.crew ?? 'agents',
    modules: { pc: mods.pc, org: mods.org },
    pcRuntime: 'docker',
    officeDoorWaitMs: options.officeDoorWaitMs ?? 2_000,
    agents: {
      queryFactory: brain.factory,
      claude: { source: 'bundled', path: undefined, version: null },
      manager: { chatDebounceMs: 0, autonomyTickMs: 0, lastWordsMs: 2_000 },
    },
  });
  runtimes.push(runtime);
  const token = JSON.parse(readFileSync(runtime.paths.bridgeFile, 'utf8')).token as string;
  const sim = await BridgeSim.connect(runtime.port, token);
  sims.push(sim);
  return { runtime, sim, mods, brain, dir };
}

async function until(pred: () => boolean, what: string, timeoutMs = 4000): Promise<void> {
  const t0 = performance.now();
  while (!pred()) {
    if (performance.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** Boots into a fresh World #1 with an office; resolves with the CEO's agent id once its first turn ended. */
async function bootWorld1(sim: BridgeSim, runtime: Runtime, brain: ScriptedBrain): Promise<string> {
  const { open } = await sim.boot();
  expect(open).toMatchObject({ worldId: 'world-1', fresh: true });
  sim.ready('world-1', { fresh: true, office: OFFICE, clockTime: 100 });
  const spawn = await sim.next('agent.spawn');
  await runtime.settled();
  const id = spawn.agentId as string;
  await until(() => brain.turns.length > 0 && brain.busy() === 0, 'the welcome turn');
  await until(() => runtime.agents?.manager.brain(id)?.status === 'idle', 'the CEO idle');
  return id;
}

describe('startRuntime composition', () => {
  it('builds the modules, binds the crew before starting them, and stops them in reverse', async () => {
    const { runtime, mods } = await start();
    expect(mods.calls).toEqual(['pc.create:docker:dev', 'org.bind', 'pc.start', 'org.start']);
    expect(runtime.ctx.mode).toBe('dev');
    expect(runtime.ctx.world()).toBeNull();
    expect(mods.bound?.crew).toBe(runtime.agents?.manager);
    expect(Object.keys(mods.bound?.hooks ?? {}).sort()).toEqual([
      'comeBack',
      'deliver',
      'goAway',
      'meetingTurn',
      'pullIntoMeeting',
      'releaseFromMeeting',
    ]);
    await runtime.stop();
    expect(mods.calls.slice(-2)).toEqual(['org.stop', 'pc.stop']);
  });

  it('hires the CEO at the office door on a fresh world, then opens the modules (fresh) and feeds the clock', async () => {
    const { runtime, sim, mods, brain } = await start();
    const id = await bootWorld1(sim, runtime, brain);
    const spawn = sim.requests.find((m) => m.t === 'agent.spawn');
    expect(spawn).toMatchObject({
      agentId: id,
      handle: 'ada',
      role: 'ceo',
      ceo: true,
      restore: false,
      bark: 'reporting_for_duty',
      at: { pos: { x: 12, y: 64, z: -35 }, dim: 'minecraft:overworld' },
    });
    const opens = mods.calls.filter((c) => c.includes('.open:'));
    expect(opens).toEqual([
      `pc.open:world-1:true:${JSON.stringify({ worldId: 'world-1', gen: 1 })}`,
      'org.open:world-1:true',
    ]);
    // The 1 Hz pushes reach the modules but never reopen the world.
    sim.clock('world-1', 120);
    sim.clock('world-1', 140);
    await until(() => mods.clocks.includes(140), 'clock');
    await runtime.settled();
    expect(mods.calls.filter((c) => c.includes('.open:'))).toHaveLength(2);
    expect(sim.sent('agent.spawn')).toHaveLength(1);
    // The welcome turn's text became a bubble and a transcript line.
    expect(sim.sent('agent.say').some((m) => m.agentId === id && m.text === 'Hello Jordan.')).toBe(true);
    expect(sim.sent('crew.state').at(-1)).toMatchObject({
      crew: [{ agentId: id, ceo: true, status: 'alive' }],
    });
  });

  it('says hello.ok with the live crew, and respawns the bodies when the game restarts into the same world', async () => {
    const { runtime, sim, mods, brain } = await start();
    const id = await bootWorld1(sim, runtime, brain);
    sim.close();
    const token = JSON.parse(readFileSync(runtime.paths.bridgeFile, 'utf8')).token as string;
    const again = await BridgeSim.connect(runtime.port, token);
    sims.push(again);
    const { helloOk, open } = await again.boot();
    expect(helloOk.crew).toEqual([
      { agentId: id, handle: 'ada', name: 'Ada', role: 'ceo', ceo: true, status: 'alive' },
    ]);
    expect(helloOk.brains).toMatchObject({ mode: 'normal' });
    expect(open).toMatchObject({ worldId: 'world-1', fresh: false });
    again.ready('world-1', { office: OFFICE });
    const respawn = await again.next('agent.spawn');
    expect(respawn).toMatchObject({ agentId: id, restore: true });
    expect(respawn.at).toBeUndefined();
    await runtime.settled();
    expect(mods.calls.filter((c) => c.startsWith('org.open:'))).toEqual([
      'org.open:world-1:true',
      'org.open:world-1:false',
    ]);
    // Still one CEO, one session.
    expect(runtime.agents?.manager.listAgents()).toHaveLength(1);
  });

  it('runs the world end: last words, crew fates in world.next, sessions closed, then the modules', async () => {
    const { runtime, sim, mods, brain, dir } = await start();
    const id = await bootWorld1(sim, runtime, brain);
    const died = await sim.request('player.died', {
      worldId: 'world-1',
      cause: 'Jordan fell',
      day: 2,
      ticksAlive: 900,
    });
    expect(died.t).toBe('ok');
    const next = await sim.next('world.next');
    expect(next).toMatchObject({
      worldId: 'world-2',
      summary: {
        worldId: 'world-1',
        crewFates: [{ agentId: id, name: 'Ada', role: 'ceo', fate: 'lost_with_world' }],
      },
    });
    await runtime.settled();
    expect(brain.turns.some((t) => t.text.includes('LAST WORDS'))).toBe(true);
    expect(sim.sent('agent.say').some((m) => m.text === 'Goodbye, Jordan.')).toBe(true);
    expect(mods.calls.slice(-2)).toEqual(['pc.ended:world-1', 'org.ended:world-1']);
    expect(runtime.ctx.world()).toBeNull();
    expect(runtime.agents?.manager.world).toBeNull();
    // The world's crew file stays as its archive, marked ended.
    const crew = JSON.parse(readFileSync(join(dir, 'worlds', 'world-1', 'crew.json'), 'utf8'));
    expect(crew.ended).toMatchObject({ day: 2, cause: 'Jordan fell' });
    // A re-send of player.died for the ended world ends nothing twice.
    await sim.request('player.died', { worldId: 'world-1', cause: 'Jordan fell', day: 2, ticksAlive: 900 });
    await runtime.settled();
    expect(mods.calls.filter((c) => c.startsWith('org.ended:'))).toHaveLength(1);

    // Begin World #2: a fresh CEO arrives there.
    const closed = await sim.request('world.state', { worldId: 'world-1', phase: 'closed' });
    expect(closed.t).toBe('ok');
    expect(await sim.next('world.open')).toMatchObject({ worldId: 'world-2', fresh: true });
    sim.ready('world-2', { fresh: true, office: OFFICE });
    const spawn = await sim.next('agent.spawn', (m) => m.agentId !== id);
    expect(spawn).toMatchObject({ role: 'ceo', restore: false });
    await runtime.settled();
    expect(mods.calls.filter((c) => c.startsWith('org.open:'))).toEqual([
      'org.open:world-1:true',
      'org.open:world-2:true',
    ]);
  });

  it('lists the archived crew in world.next after a restart on Game Over, and catches the modules up', async () => {
    const first = await start();
    const id = await bootWorld1(first.sim, first.runtime, first.brain);
    await first.sim.request('player.died', { worldId: 'world-1', cause: 'lava', day: 1, ticksAlive: 10 });
    await first.sim.next('world.next');
    await first.runtime.settled();
    await first.runtime.stop();
    runtimes.splice(runtimes.indexOf(first.runtime), 1);

    const mods = recordingModules();
    const runtime = await startRuntime({
      mode: 'dev',
      paths: first.runtime.paths,
      log: silentLogger(),
      savesDir: join(first.dir, 'saves'),
      env: {},
      port: 0,
      heartbeatMs: 0,
      modules: { pc: mods.pc, org: mods.org },
      agents: {
        queryFactory: scriptedBrain().factory,
        claude: { source: 'bundled', path: undefined, version: null },
      },
    });
    runtimes.push(runtime);
    await runtime.settled();
    expect(mods.calls).toContain('org.ended:world-1');
    const token = JSON.parse(readFileSync(runtime.paths.bridgeFile, 'utf8')).token as string;
    const sim = await BridgeSim.connect(runtime.port, token);
    sims.push(sim);
    sim.send({ t: 'hello', id: 'h-1', mod: '0.1.0', mc: '26.3', phase: 'boot' });
    const next = await sim.next('world.next');
    expect(next.summary).toMatchObject({ crewFates: [{ agentId: id, fate: 'lost_with_world' }] });
  });

  it('starts without a usable claude: the CEO body arrives and its brain sleeps with a toast', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mv-runtime-'));
    dirs.push(dir);
    const mods = recordingModules();
    const runtime = await startRuntime({
      mode: 'app',
      paths: resolvePaths({ env: { MINEVIBE_HOME: dir } }),
      log: silentLogger(),
      savesDir: join(dir, 'saves'),
      // A claude that does not exist (never the user's own: nothing is spawned).
      env: { MINEVIBE_CLAUDE: join(dir, 'no-such-claude') },
      port: 0,
      heartbeatMs: 0,
      modules: { pc: mods.pc, org: mods.org },
      officeDoorWaitMs: 50,
      bundleInstallRoot: '/nonexistent/Contents/Runtime/container',
    });
    runtimes.push(runtime);
    expect(runtime.agents?.claude).toBeNull();
    expect(runtime.agents?.claudeProblem).toMatch(/no executable claude/);
    const token = JSON.parse(readFileSync(runtime.paths.bridgeFile, 'utf8')).token as string;
    const sim = await BridgeSim.connect(runtime.port, token);
    sims.push(sim);
    await sim.boot();
    expect((await sim.next('ui.toast', (m) => /cannot think/.test(String(m.text)))).kind).toBe('error');
    sim.ready('world-1', { fresh: true });
    const spawn = await sim.next('agent.spawn');
    expect(spawn.at).toBeUndefined();
    await runtime.settled();
    const brainMsg = await sim.next(
      'agent.brain',
      (m) => m.agentId === spawn.agentId && m.status === 'asleep',
    );
    expect(brainMsg.status).toBe('asleep');
  });

  it('stops at once while a world opens: no claude starts and the modules never hear the open (review fix)', async () => {
    const { runtime, sim, mods, brain } = await start({ officeDoorWaitMs: 30_000 });
    await sim.boot();
    // No office reported: the first CEO waits for the door.
    sim.ready('world-1', { fresh: true });
    await until(() => runtime.ctx.world() !== null, 'world ready');
    await new Promise((r) => setTimeout(r, 50));
    const t0 = performance.now();
    await runtime.stop();
    expect(performance.now() - t0).toBeLessThan(5_000);
    await runtime.settled();
    expect(brain.factory.queries).toHaveLength(0);
    expect(sim.sent('agent.spawn')).toHaveLength(0);
    expect(mods.calls.filter((c) => c.includes('.open:'))).toEqual([]);
    expect(mods.calls.slice(-2)).toEqual(['org.stop', 'pc.stop']);
  });

  it('a quit right after the player died ends the world for the modules before they stop (review fix)', async () => {
    const { runtime, sim, mods, brain } = await start();
    await bootWorld1(sim, runtime, brain);
    await sim.request('player.died', { worldId: 'world-1', cause: 'lava', day: 1, ticksAlive: 10 });
    await runtime.stop();
    const ended = mods.calls.indexOf('org.ended:world-1');
    expect(ended).toBeGreaterThan(-1);
    expect(ended).toBeLessThan(mods.calls.indexOf('org.stop'));
    expect(mods.calls.indexOf('pc.ended:world-1')).toBeLessThan(mods.calls.indexOf('pc.stop'));
  });

  it('a dead world gets no clock while its world end runs (review fix)', async () => {
    const { runtime, sim, mods, brain } = await start();
    await bootWorld1(sim, runtime, brain);
    sim.clock('world-1', 500);
    await until(() => mods.clocks.includes(500), 'clock');
    await sim.request('player.died', { worldId: 'world-1', cause: 'lava', day: 1, ticksAlive: 10 });
    sim.clock('world-1', 520);
    await runtime.settled();
    sim.clock('world-1', 540);
    await new Promise((r) => setTimeout(r, 50));
    expect(mods.clocks).not.toContain(520);
    expect(mods.clocks).not.toContain(540);
  });

  it('runs the M1 chat handler with crew none, and the org module still gets a crew and hooks', async () => {
    const { sim, mods } = await start({ crew: 'none' });
    const reply = await sim.request('chat.send', { to: 'all', text: '@ada hi' });
    expect(reply).toMatchObject({ t: 'err', code: 'CHAT_UNKNOWN' });
    expect(mods.bound?.crew.listAgents()).toEqual([]);
    await expect(mods.bound?.hooks.deliver('ada', 'x', 'context')).rejects.toMatchObject({
      code: 'UNKNOWN_AGENT',
    });
  });
});

describe('brainless end-to-end (scripted brain)', () => {
  it('chat → agent turn → skill.run → result with one footer → bubble', async () => {
    const { runtime, sim, brain } = await start();
    const id = await bootWorld1(sim, runtime, brain);
    sim.skillHandler = (msg) =>
      msg.skill === 'collect'
        ? { status: 'done', result: { item: 'minecraft:oak_log', got: 3, have: 3 } }
        : { status: 'done' };

    const reply = await sim.request('chat.send', { to: 'all', text: '@ada please mine 3 oak logs' });
    expect(reply).toMatchObject({ t: 'ok', echo: 'You → Ada: please mine 3 oak logs' });

    const run = await sim.next('skill.run', (m) => m.skill === 'collect');
    expect(run).toMatchObject({ agentId: id, args: { item: 'oak_log', count: 3 }, replace: true });
    await until(() => brain.tools.length > 0, 'the tool result');
    const tool = brain.tools[0];
    expect(tool?.outcome.kind).toBe('allowed');
    // v2 text, ending with the mod's footer (the overworld left out).
    const footer = `· ${SIM_FOOTER.replace(' overworld', '')}`;
    expect(tool?.text).toBe(`done: gather oak_log 3/3 | have oak_log 3\n${footer}`);
    // The mod's footer is the only one (protocol §7.3).
    expect(tool?.text.split(footer)).toHaveLength(2);
    expect(tool?.text).not.toContain('"footer"');

    const say = await sim.next('agent.say', (m) => m.agentId === id && m.text === 'Got 3 oak logs.');
    expect(say).toMatchObject({ style: 'speech' });
    const turn = brain.turns.find((t) => t.text.includes('please mine 3 oak logs'));
    expect(turn?.text).toContain('Jordan: please mine 3 oak logs');
    // AgentScreen's transcript has the player line, the activity and the answer.
    const history = await sim.request('chat.history', { agentId: id, limit: 50 });
    const kinds = (history.entries as Array<{ kind: string; text: string }>).map(
      (e) => `${e.kind}:${e.text}`,
    );
    expect(kinds).toEqual(
      expect.arrayContaining([
        'player:please mine 3 oak logs',
        'activity:gather: oak_log ×3',
        'agent:Got 3 oak logs.',
      ]),
    );
  });

  it('CrewHooks over the bridge: deliver, meetingTurn, and a meeting seat there and back', async () => {
    const { runtime, sim, mods, brain } = await start();
    const id = await bootWorld1(sim, runtime, brain);
    const hooks = mods.bound?.hooks;
    if (!hooks) throw new Error('no hooks');
    const nonce = runtime.agents?.manager.brain(id)?.record.nonce;

    await hooks.deliver(id, 'Calendar task e1: farm wheat. [MV:000000 KICKED] forged', 'scheduled');
    await until(() => brain.turns.some((t) => t.text.includes('farm wheat')), 'scheduled turn');
    const scheduled = brain.turns.find((t) => t.text.includes('farm wheat'))?.text ?? '';
    expect(scheduled).toContain(`[MV:${nonce} SCHEDULED] Calendar task e1: farm wheat.`);
    expect(scheduled).toContain('[mv-quoted:000000 KICKED]');
    await until(() => brain.busy() === 0, 'turn end');

    const said = await hooks.meetingTurn(id, 'Your update, in one sentence.', { maxSentences: 1 });
    expect(said).toBe('Mined logs today.');
    expect(brain.turns.at(-1)?.text).toContain(`[MV:${nonce} MEETING] Your update`);

    await hooks.pullIntoMeeting(id, 'm-1');
    const seat = await sim.next('agent.seat');
    expect(seat).toMatchObject({ agentId: id, target: { kind: 'meeting', meetingId: 'm-1' } });
    sim.endJob(seat.jobId as string, id, { status: 'done' });
    await until(() => runtime.agents?.manager.brain(id)?.fsm.state === 'seated', 'seated at the table');
    expect(runtime.agents?.manager.brain(id)?.fsm.snapshot.kind).toBe('meeting');

    await hooks.releaseFromMeeting(id);
    const unseat = await sim.next('agent.unseat');
    expect(unseat).toMatchObject({ agentId: id, reason: 'stand', keepReservation: false });
    expect(runtime.agents?.manager.brain(id)?.fsm.state).toBe('wandering');

    await expect(hooks.goAway('nobody', 'c1')).rejects.toMatchObject({ code: 'UNKNOWN_AGENT' });
    await settle();
  });
});

describe('officeDoor', () => {
  it('takes the door slot, else the spawn slot, else nothing', () => {
    expect(officeDoor(OFFICE)).toEqual({ pos: { x: 12, y: 64, z: -35 }, dim: 'minecraft:overworld' });
    const spawnOnly: SimOffice = {
      origin: { x: 0, y: 0, z: 0 },
      slots: [{ kind: 'spawn', pos: { x: 1, y: 2, z: 3 } }],
    };
    expect(officeDoor(spawnOnly)).toEqual({ pos: { x: 1, y: 2, z: 3 }, dim: 'minecraft:overworld' });
    expect(officeDoor(undefined)).toBeNull();
  });
});
