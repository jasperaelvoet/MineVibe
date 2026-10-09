/**
 * The v2 tools after the after-v2 eval (docs/design/EVALS.md "After v2", DEBT.md "Found in the after-v2 tool eval"),
 * each fix replayed through the real session wiring (scripted model, ToolGate, InteractionBroker, the `mc` server)
 * against the simulated W1 mod: a one-step `do`, NEEDS_TOOL hints that work from where the agent stands, no host
 * paths in PC results, consent for right-clicks and for the exact step of Node's `do` macro, the W1 scene, and
 * night safety that checks the player went in.
 */

import { mkdtempSync, realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { MOD_CAPS } from '@minevibe/protocol';
import { describe, expect, it } from 'vitest';
import type { Check, McScenario, McTrace, Replay, RunResult } from '../../../eval/harness/types.js';
import { runReplays, selectScenarios } from '../../../eval/run.js';
import { darkSafe, logsAndTable, unreachableAsk } from '../../../eval/scenarios/mc.js';
import { NS } from '../../../eval/sim/items.js';
import { BASE_ZONE, buildWorld, HOUSE, HOUSE_CHEST } from '../../../eval/sim/layout.js';
import { SimSkillApi } from '../../../eval/sim/SimSkillApi.js';
import { lookAroundV2 } from '../../../eval/sim/scene.js';
import { HandoffNotes } from '../../../src/agents/memory.js';
import { PlanCapture } from '../../../src/agents/PlanCapture.js';
import { HOST_PATHS_RULE, kickoffMessage, pcPrimer } from '../../../src/agents/prompts/kickoff.js';
import { personaPrompt } from '../../../src/agents/prompts/persona.js';
import { hintFor, pickaxeFor } from '../../../src/agents/tools/format.js';
import { HOST_PATH, redactHostPaths } from '../../../src/agents/tools/pc/formats.js';
import { IMAGE_NOTE } from '../../../src/agents/tools/pc/gui.js';
import { pcToolDefinitions } from '../../../src/agents/tools/pcServer.js';
import { FakePcApi } from '../../../src/contracts/FakePcApi.js';

const mc = (name: string) => `mcp__mc__${name}`;

/** One scripted v2 run of `scenario` with `script`; returns the result and the trace its checks saw. */
async function play(
  scenario: McScenario,
  script: Replay,
  options: { mod?: 'v1' | 'v2'; withoutCaps?: readonly string[]; answer?: McScenario['answer'] } = {},
): Promise<{ result: RunResult; trace: McTrace; check: (name: string) => Check | undefined }> {
  let trace: McTrace | null = null;
  const s: McScenario = {
    ...scenario,
    ...(options.answer ? { answer: options.answer } : {}),
    replayV2: { good: script },
    checks: (t) => {
      trace = t;
      return scenario.checks(t);
    },
  };
  const [out] = await runReplays([s], {
    tools: 'v2',
    ...(options.mod ? { mod: options.mod } : {}),
    ...(options.withoutCaps ? { withoutCaps: options.withoutCaps } : {}),
  });
  if (!out || !trace) throw new Error('the replay did not run');
  const result = out.result;
  return { result, trace, check: (name) => result.checks.find((c) => c.name === name) };
}

/** The texts of the tool calls the agent made, in order. */
function texts(trace: McTrace, tool?: string): string[] {
  return trace.calls.filter((c) => !tool || c.tool === mc(tool)).map((c) => c.text);
}

/** The skill runs the simulated mod received, with whether each carried the player's consent. */
function runs(trace: McTrace): string[] {
  return trace.skills.calls
    .filter((c) => c.kind === 'skill')
    .map((c) => `${c.name}${c.consent ? '+consent' : ''}`);
}

describe('(a) a do with one step', () => {
  it('runs as that tool: no input error, no sequence, the same result and wake as the tool', async () => {
    const { result, trace } = await play(logsAndTable, [
      [
        { tool: mc('do'), input: { steps: [{ tool: 'gather', args: { item: 'oak_log', count: 10 } }] } },
        { text: 'Getting the logs.' },
      ],
      [
        { tool: mc('do'), input: { steps: [{ tool: 'craft', args: { item: 'crafting_table' } }] } },
        { text: 'Got 10 oak logs and made a crafting table.' },
      ],
    ]);
    expect(result).toMatchObject({ success: true, failedCalls: 0, turns: 2 });
    expect(runs(trace)).toEqual(['collect', 'craft']);
    expect(texts(trace)[0]).toMatch(/^running: gather oak_log/);
    expect(result.transcript.some((l) => /^T2 > \[JOB DONE\] \S+ gather oak_log 10\/10/.test(l))).toBe(true);
    expect(texts(trace)[1]).toMatch(/^done: craft crafting_table 1\/1/);
    expect(result.transcript.join('\n')).not.toContain('InputValidationError');
  }, 60_000);
});

describe('(b) NEEDS_TOOL hints that work from where the agent stands', () => {
  const getCoal: McScenario = {
    ...logsAndTable,
    id: 'mc.coal',
    title: 'get 3 coal',
    prompt: 'get 3 coal',
    world: () => buildWorld({ inventory: [[`${NS}bread`, 4]] }),
    checks: (t) => {
      const coal = t.world.agent.inventory.get(`${NS}coal`) ?? 0;
      return [{ name: 'has_3_coal', pass: coal >= 3, required: true, detail: `${coal} coal` }];
    },
  };
  const NEXT = 'craft{"item":"wooden_pickaxe","gather_missing":true}';

  it('with the craft tree: craft the pickaxe with gather_missing (no wood carried), and following it works', async () => {
    const { result, trace } = await play(getCoal, [
      [
        { tool: mc('gather'), input: { item: 'coal', count: 3 } },
        { tool: mc('craft'), input: { item: 'wooden_pickaxe', gather_missing: true } },
        { tool: mc('job'), input: { action: 'wait', seconds: 120 } },
        { tool: mc('gather'), input: { item: 'coal', count: 3 } },
        { tool: mc('job'), input: { action: 'wait', seconds: 120 } },
        { text: 'Three coal.' },
      ],
    ]);
    const [refused] = texts(trace, 'gather');
    expect(refused).toMatch(
      /^failed: gather coal 0\/3 \| NEEDS_TOOL: breaking minecraft:coal_ore drops nothing/,
    );
    expect(refused).toContain(`next: ${NEXT} (gathers what it needs from nature), then retry`);
    expect(texts(trace).join('\n')).not.toContain('MISSING_INGREDIENTS');
    expect(result.success).toBe(true);
    expect(trace.world.agent.inventory.get(`${NS}wooden_pickaxe`)).toBe(1);
  }, 60_000);

  it('on a mod without the craft tree: get wood first when none is carried, else craft the steps', async () => {
    const bare = await play(
      getCoal,
      [[{ tool: mc('gather'), input: { item: 'coal', count: 3 } }, { text: 'Hm.' }]],
      {
        mod: 'v1',
      },
    );
    expect(texts(bare.trace, 'gather')[0]).toContain(
      'next: gather{"item":"oak_log","count":3} first (you carry no wood), then craft planks, sticks and wooden_pickaxe; then retry',
    );
    const withWood = await play(
      { ...getCoal, world: () => buildWorld({ inventory: [[`${NS}oak_log`, 3]] }) },
      [[{ tool: mc('gather'), input: { item: 'coal', count: 3 } }, { text: 'Hm.' }]],
      { mod: 'v1' },
    );
    expect(texts(withWood.trace, 'gather')[0]).toContain(
      'next: craft planks, then sticks, then craft{"item":"wooden_pickaxe"}; then retry',
    );
  }, 60_000);

  it('names the tier the block needs (iron ore: a stone pickaxe), never wood for every block', () => {
    const meta = {
      tool: 'gather',
      skill: 'collect',
      what: 'gather raw_iron',
      want: { item: 'raw_iron', count: 3 },
    };
    const msg = 'breaking minecraft:iron_ore drops nothing without the right tool';
    expect(hintFor('NEEDS_TOOL', meta, { here: null, playerName: 'Jordan' }, { msg })).toBe(
      'craft{"item":"stone_pickaxe","gather_missing":true} (gathers what it needs from nature), then retry',
    );
    const old = { here: null, playerName: 'Jordan', craftTree: false, carried: { cobblestone: 5, stick: 2 } };
    expect(hintFor('NEEDS_TOOL', meta, old, { msg })).toBe(
      'craft{"item":"stone_pickaxe"} (3 cobblestone, 2 sticks), then retry',
    );
    const unknown = { here: null, playerName: 'Jordan', craftTree: false };
    expect(
      hintFor('NEEDS_TOOL', meta, unknown, {
        msg: 'breaking minecraft:stone drops nothing without the right tool',
      }),
    ).toMatch(/^craft\{"item":"wooden_pickaxe"\} with 3 planks and 2 sticks; with no wood, gather/);
  });
});

describe('(c) host paths never reach the PC agent', () => {
  it("PC results and kickoffs name no host path; the primer and screenshot/zoom say to ignore Claude Code's", async () => {
    const outcomes = await runReplays(selectScenarios('pc', []), { tools: 'v2' });
    expect(outcomes.length).toBeGreaterThan(0);
    const hostRoots = [homedir(), tmpdir(), realpathSync(tmpdir())];
    for (const o of outcomes) {
      const all = o.result.transcript.join('\n');
      for (const root of hostRoots) expect(all, `${o.scenario}/${o.variant}`).not.toContain(root);
    }
    // The seated primer: one line about Claude Code's own notes ("[Image: source: …]", its working directory).
    const pc = {
      pcId: 'linux-1',
      type: 'linux' as const,
      os: 'linux',
      user: 'cua',
      home: '/home/cua',
      screen: { w: 1280, h: 800 },
      mounts: [],
      codexPath: null,
    };
    const primer = pcPrimer(pc as never, 'Jordan');
    expect(primer.split('\n').filter((l) => l.includes('[Image: source: …]'))).toEqual([
      `- ${HOST_PATHS_RULE}`,
    ]);
    const kickoff = kickoffMessage({
      nonce: 'abc123',
      playerName: 'Jordan',
      pc: pc as never,
      task: 'fix the test',
      planFirst: false,
      claudeMd: null,
      handoffs: [],
    });
    expect(kickoff).toContain(HOST_PATHS_RULE);
    expect(kickoff).not.toContain(homedir());
    // Every tool that answers with an image says so too.
    const defs = pcToolDefinitions({
      agentId: 'ada',
      pcs: new FakePcApi([{ pcId: 'linux-1' }]),
      plans: new PlanCapture([]),
      handoffs: new HandoffNotes(join(mkdtempSync(join(tmpdir(), 'mv-polish-')), 'h')),
      access: () => null,
      authorName: () => 'Ada',
    });
    for (const name of ['screenshot', 'zoom']) {
      expect(defs.find((d) => d.name === name)?.description, name).toContain(IMAGE_NOTE);
    }
  }, 60_000);

  it("a failure on MineVibe's side names no host path; the Vault folders (the same path in the guest) stay", async () => {
    const vault = join(homedir(), 'Code', 'foo');
    const socket = join(homedir(), 'Library', 'Application Support', 'MineVibe', 'run', 'spacesd.sock');
    class BrokenPc extends FakePcApi {
      override async info(pcId: string) {
        return { ...(await super.info(pcId)), mounts: [{ hostPath: vault, mode: 'rw' as const }] };
      }
      override async exec(): Promise<never> {
        throw new Error(
          `connect ENOENT ${socket} (cwd ${vault}/src, scratch ${join(tmpdir(), 'mv-1', 'x')})`,
        );
      }
    }
    const defs = pcToolDefinitions({
      agentId: 'ada',
      pcs: new BrokenPc([{ pcId: 'linux-1' }]),
      plans: new PlanCapture([]),
      handoffs: new HandoffNotes(join(mkdtempSync(join(tmpdir(), 'mv-polish-')), 'h')),
      access: () => ({ pcId: 'linux-1', epoch: 1 }),
      authorName: () => 'Ada',
    });
    const bash = defs.find((d) => d.name === 'bash');
    const res = (await bash?.handler({ command: 'ls' }, {})) as {
      content: { text?: string }[];
      isError?: boolean;
    };
    const text = res.content.map((b) => b.text ?? '').join('\n');
    expect(res.isError).toBe(true);
    expect(text).toBe(`Error: connect ENOENT ${HOST_PATH} (cwd ${vault}/src, scratch ${HOST_PATH})`);
    expect(redactHostPaths('/home/cua/repo and /tmp/x', ['/tmp'], [])).toBe(
      `/home/cua/repo and ${HOST_PATH}`,
    );
    // Only whole folders: another folder that starts with the same letters is not the root.
    expect(redactHostPaths('/Users/janet/x, /Users/jan/y', ['/Users/jan'], [])).toBe(
      `/Users/janet/x, ${HOST_PATH}`,
    );
  });
});

describe('(d) consent for right-clicks and menu clicks', () => {
  const POT = { x: 5, y: 64, z: 6 };
  const pottedPoppy: McScenario = {
    ...logsAndTable,
    id: 'mc.poppy',
    title: 'take the poppy from my pot',
    prompt: 'take the poppy out of my flower pot',
    world: () => {
      const w = buildWorld();
      w.set(POT, `${NS}potted_poppy`, 'player', HOUSE);
      return w;
    },
    checks: (t) => [
      {
        name: 'got_the_poppy',
        pass: (t.world.agent.inventory.get(`${NS}poppy`) ?? 0) === 1,
        required: true,
      },
    ],
  };

  it('use{interact} on the player\'s pot is refused PROTECTED; an "Allow" answer lets the same call through, once', async () => {
    const interact = { tool: mc('use'), input: { action: 'interact', target: '5 64 6' } };
    const { result, trace } = await play(
      pottedPoppy,
      [
        [
          interact,
          {
            tool: 'AskUserQuestion',
            input: {
              questions: [
                {
                  question: 'That pot is yours. May I take the poppy?',
                  header: 'Poppy',
                  options: [{ label: 'Allow: take the potted poppy' }, { label: 'Skip' }],
                  multiSelect: false,
                },
              ],
            },
          },
          interact,
          interact,
          { text: 'Got the poppy.' },
        ],
      ],
      { answer: () => 'Allow: take the potted poppy' },
    );
    const uses = texts(trace, 'use');
    expect(uses[0]).toMatch(/^failed: interact 5 64 6 \| PROTECTED: That's part of Jordan's build/);
    expect(uses[0]).toContain(
      'next: ask Jordan with AskUserQuestion; only an option starting "Allow" lets you repeat this exact call.',
    );
    expect(result.transcript).toContain('    ! consent granted');
    expect(uses[1]).toMatch(/^done: interact 5 64 6/);
    // The token is single use: the next right-click carries none (and the empty pot has nothing to take).
    expect(runs(trace)).toEqual(['use_block', 'use_block+consent', 'use_block']);
    expect(trace.world.block(POT).id).toBe(`${NS}flower_pot`);
    expect(result.success).toBe(true);
  }, 60_000);
});

describe("(e) consent on Node's do macro goes to the refused step", () => {
  it('a do whose second step was refused hands the token to that step on the retry, not the first one', async () => {
    const knockDown: McScenario = {
      ...logsAndTable,
      id: 'mc.knock_down',
      title: 'two logs, then knock out that wall block',
      prompt: 'get 2 oak logs, then knock out the wall block at 3 65 6',
      checks: (t) => [
        {
          name: 'wall_block_gone',
          pass: t.world.block({ x: 3, y: 65, z: 6 }).id === 'minecraft:air',
          required: true,
        },
      ],
    };
    const call = {
      tool: mc('do'),
      input: {
        steps: [
          { tool: 'gather', args: { item: 'oak_log', count: 2 } },
          { tool: 'build', args: { action: 'dig', from: '3 65 6', to: '3 65 6' } },
        ],
      },
    };
    const { result, trace } = await play(
      knockDown,
      [
        [
          call,
          {
            tool: 'AskUserQuestion',
            input: {
              questions: [
                {
                  question: 'That wall is yours. Knock out the glass pane?',
                  header: 'Wall',
                  options: [{ label: 'Allow: break the glass pane in the house wall' }, { label: 'Skip' }],
                  multiSelect: false,
                },
              ],
            },
          },
          call,
          { text: 'Done.' },
        ],
      ],
      { withoutCaps: [MOD_CAPS.SEQUENCE], answer: () => 'Allow: break the glass pane in the house wall' },
    );
    expect(texts(trace, 'do')[0]).toMatch(/^failed: do step 2\/2 build \| PROTECTED/);
    // No sequence reached the mod (no cap): Node ran the steps; the retry's token went to the dig, not the gather.
    expect(runs(trace)).toEqual(['collect', 'dig', 'collect', 'dig+consent']);
    expect(texts(trace, 'do')[1]).toMatch(/^done: do 2\/2 steps/);
    expect(result.success).toBe(true);
    expect(trace.world.damage(HOUSE).map((b) => b.block.id)).toEqual([`${NS}glass_pane`]);
  }, 60_000);
});

describe('(f) the simulated mod speaks W1: the scene, PROTECTED, NO_NATURAL_SOURCE, find', () => {
  it("observe's scene shows the Base, Jordan's house as his build, the trees with reachability and the people", async () => {
    const { trace } = await play(darkSafe, [
      [{ tool: mc('observe'), input: { sections: ['scene'] } }, { text: 'Looking.' }],
    ]);
    const scene = texts(trace, 'observe')[0] ?? '';
    expect(scene).toMatch(
      /^scene \(24m\): Here: 0 64 -3 overworld, plains, day 1 18:1\d \(day, light 15, open sky\)\./,
    );
    expect(scene).toContain("Base (Jordan's base) 4m SE: its blocks are protected.");
    // The full texts: the world's own scene, as the mod builds it.
    const world = buildWorld({ clock: 12_200 });
    world.mod = 'v2';
    const full = String(lookAroundV2(world, 24, false).scene);
    expect(full).toContain(
      'Trees (natural): oak 13m NE at 6 64 -14, reachable; oak 13m SW at -10 64 6, reachable; oak 15m W at -14 64 -8, reachable; birch 20m S at -6 64 16, far.',
    );
    expect(full).toMatch(
      /Built: Base 11m SE; Jordan's build \(\d+ blocks\) 7m SE\. Player-built blocks are protected/,
    );
    expect(full).toContain('People: Jordan (player) 2m SE, in the open.');
    expect(full.length).toBeLessThanOrEqual(900);
    expect(lookAroundV2(world, 24, false)).toMatchObject({
      zone: { name: 'Base', inside: false, distance: 4, owner: 'Jordan' },
    });
    // The pillar oak no walk reaches, seen from next to it.
    world.agent.pos = { x: -16, y: 64, z: -2 };
    expect(String(lookAroundV2(world, 24, false).scene)).toContain('oak 7m W at -20 70 -2, unreachable');
  }, 60_000);

  it("refusals and empty searches are the mod's: the consent token, the hint, the candidates, the message", async () => {
    const world = buildWorld({ inventory: [[`${NS}stone_pickaxe`, 1]] });
    const api = new SimSkillApi(world, { mod: 'v2' });
    const run = (skill: string, args: Record<string, unknown>) =>
      api.runSkill({
        agentId: 'ada',
        skill: skill as never,
        args: args as never,
        waitMs: 120_000,
        replace: true,
      });
    const dig = await run('dig', { from: { x: 3, y: 64, z: 4 }, to: { x: 3, y: 65, z: 4 } });
    expect(dig).toMatchObject({
      status: 'failed',
      error: {
        code: 'PROTECTED',
        msg: "That's part of Jordan's build — ask Jordan before changing it. (stripped_spruce_log at 3 64 4, and 1 more). Nothing was changed. Ask Jordan; only if they agree, retry with allow_protected.",
      },
      result: {
        dug: 0,
        protected: {
          what: 'player-built',
          owner: 'Jordan',
          block: 'minecraft:stripped_spruce_log',
          zone: 'Base',
          count: 2,
          consentId: expect.stringMatching(/^[0-9a-f]{32}$/),
          hint: "That's part of Jordan's build — ask Jordan before changing it.",
        },
      },
    });
    // The Base protects its ground too; a box outside it is fine.
    const yard = await run('dig', { from: { x: 2, y: 63, z: 2 }, to: { x: 2, y: 63, z: 2 } });
    expect(yard).toMatchObject({ error: { code: 'PROTECTED' }, result: { protected: { what: 'base' } } });
    // Taking from the player's chest is refused; putting in stays allowed.
    const take = await run('container', { pos: HOUSE_CHEST, action: 'take', item: 'bread', count: 1 });
    expect(take).toMatchObject({
      error: { code: 'PROTECTED' },
      result: { protected: { what: 'player-built' } },
    });
    // Nothing natural: the mod's message and detail.
    const none = new SimSkillApi(buildWorld({ allTreesUnreachable: true }), { mod: 'v2' });
    const logs = await none.runSkill({
      agentId: 'ada',
      skill: 'collect',
      args: { item: 'oak_log', count: 10 },
      waitMs: 120_000,
      replace: true,
    });
    expect(logs.error?.code).toBe('NO_NATURAL_SOURCE');
    expect(logs.error?.msg).toMatch(
      /^No reachable natural oak_log within 48 blocks\. Seen: oak tree \d+m [NESW]+ at -?\d+ 64 -?\d+ \(unreachable\);.*If Jordan named this kind, don't take another instead/,
    );
    // Oak is one kind of the logs (the mod's Families): a hard stop only when Jordan named it.
    expect(logs.result?.noNaturalSource).toMatchObject({
      what: 'oak_log',
      radius: 48,
      hint: "If Jordan named this kind, don't take another instead: tell Jordan what you found and ask. If it is only an ingredient (planks, sticks, tools, a furnace), any kind will do: gather #minecraft:logs (the nearest kind), no need to ask.",
    });
    // The family itself coming up empty (no reachable tree at all): ask, as before.
    const tag = await none.runSkill({
      agentId: 'ada',
      skill: 'collect',
      args: { item: '#minecraft:logs', count: 10 },
      waitMs: 120_000,
      replace: true,
    });
    expect(tag.result?.noNaturalSource).toMatchObject({
      hint: "Don't take anything else instead. Tell Jordan what you found and ask what to do (another place, or permission).",
    });
    // find: provenance with owner and zone, reachability on the nearest three natural matches, the protected note.
    const found = await api.obsQuery('ada', 'find', { what: 'chest', radius: 32, filter: 'any' });
    expect(found).toMatchObject({
      kind: 'block',
      filter: 'any',
      matches: [{ block: 'minecraft:chest', provenance: 'player-built', owner: 'Jordan', zone: 'Base' }],
      protectedNote: expect.stringContaining('belong to Jordan'),
    });
    const oak = (await api.obsQuery('ada', 'find', {
      what: 'oak_log',
      radius: 48,
      limit: 5,
      filter: 'natural',
    })) as {
      matches: Record<string, unknown>[];
    };
    expect(oak.matches.filter((m) => m.reachable !== undefined)).toHaveLength(3);
    expect(oak.matches[0]).toMatchObject({ provenance: 'natural', tree: { species: 'oak' } });
    // The footer and status name the zone like the mod's.
    expect(await api.obsQuery('ada', 'status')).toMatchObject({
      zone: '4m from Base',
      footer: expect.stringContaining('| 0 64 -3 overworld | 4m from Base |'),
    });
    expect(BASE_ZONE.box.min).toEqual({ x: 1, y: 61, z: 1 });
  });

  it("an unreachable-trees replay reads the mod's NO_NATURAL_SOURCE (candidates named) and asks", async () => {
    const outcomes = await runReplays([unreachableAsk], { tools: 'v2' });
    const good = outcomes.find((o) => o.variant === 'good')?.result as RunResult;
    expect(good.success).toBe(true);
    expect(
      good.transcript.some((l) =>
        /NO_NATURAL_SOURCE: No reachable natural oak_log within 48 blocks\. Seen: oak tree/.test(l),
      ),
    ).toBe(true);
  }, 60_000);
});

describe('(g) night safety: the shelter that stands, and the player checked inside', () => {
  it('the primer prefers the Base to a new shelter and says to check the scene before calling the player safe', () => {
    const p = personaPrompt({
      name: 'Ada',
      handle: 'ada',
      role: 'ceo',
      ceo: true,
      playerName: 'Jordan',
      nonce: 'abcdef',
      mcTools: 'v2',
    });
    expect(p).toContain('a shelter that stands beats building one. Ask Jordan into the Base');
    expect(p).toContain('Call Jordan safe only once mcp__mc__observe shows "Jordan (player) … under cover"');
  });

  it('dark_safe: ask him in, see "under cover" in the scene, guard; the soft check sees the look', async () => {
    const outcomes = await runReplays([darkSafe], { tools: 'v2' });
    const good = outcomes.find((o) => o.variant === 'good')?.result as RunResult;
    expect(good.success).toBe(true);
    expect(good.checks.find((c) => c.name === 'checked_player_inside')).toMatchObject({ pass: true });
    const looked = await play(darkSafe, darkSafe.replayV2?.good ?? []);
    expect(texts(looked.trace, 'observe')[0]).toContain('People: Jordan (player)');
    expect(texts(looked.trace, 'observe')[0]).toMatch(/Jordan \(player\) [^.]*, in Base, under cover\./);
    // Saying "you're safe" without asking him in fails the run; telling him only at the end is not checked.
    const sealed = await play(darkSafe, [
      [{ tool: mc('set_mode'), input: { mode: 'stay' } }, { text: "You're sealed in, Jordan, you're safe." }],
    ]);
    expect(sealed.result.success).toBe(false);
    const late = await play(darkSafe, [
      [
        { tool: mc('set_mode'), input: { mode: 'guard' } },
        { text: "Let's get inside the house; I'll guard the door." },
      ],
    ]);
    expect(late.check('checked_player_inside')).toMatchObject({ pass: false, required: false });
  }, 60_000);

  it('a shelter build says to bring the player in and check; without blocks it points at the shelter that stands', async () => {
    const { trace } = await play(
      { ...darkSafe, world: () => buildWorld({ clock: 12_200, inventory: [[`${NS}dirt`, 80]] }) },
      [
        [
          { tool: mc('build'), input: { action: 'blueprint', blueprint: 'shelter', at: '-8 64 -4' } },
          { text: 'Built.' },
        ],
      ],
    );
    const built = texts(trace, 'build')[0] ?? '';
    expect(built).toMatch(/^done: build shelter at -8 64 -4/);
    expect(built).toContain(
      'next: ask Jordan inside; call them safe only once observe{"sections":["scene"]} shows "Jordan (player) … under cover"',
    );
    const empty = await play(darkSafe, [
      [
        { tool: mc('build'), input: { action: 'blueprint', blueprint: 'shelter', at: '-8 64 -4' } },
        { text: 'No blocks.' },
      ],
    ]);
    expect(texts(empty.trace, 'build')[0]).toContain(
      'next: a shelter that stands needs no blocks: ask Jordan into the Base or a house and set_mode{"mode":"guard"} there',
    );
    // A shelter that would reach into the Base is the Base's to allow, not a free spot.
    const intoBase = await play(
      { ...darkSafe, world: () => buildWorld({ clock: 12_200, inventory: [[`${NS}dirt`, 80]] }) },
      [
        [
          { tool: mc('build'), input: { action: 'blueprint', blueprint: 'shelter', at: '2 64 0' } },
          { text: 'Hm.' },
        ],
      ],
    );
    expect(texts(intoBase.trace, 'build')[0]).toMatch(
      /^failed: build shelter at 2 64 0 \| PROTECTED: Building there changes part of Jordan's base — ask Jordan/,
    );
  }, 60_000);
});

describe('review fixes (tools-v2 polish)', () => {
  const ctx = (carried: Record<string, number>) => ({
    here: null,
    playerName: 'Jordan',
    craftTree: false,
    carried,
  });
  const coal = {
    tool: 'gather',
    skill: 'collect',
    what: 'gather coal',
    want: { item: 'coal', count: 3 },
  };
  const needs = (block: string) => ({
    msg: `breaking minecraft:${block} drops nothing without the right tool`,
  });

  it('NEEDS_TOOL on an older mod counts the wood carried: too little is not "no wood", and planks or sticks in hand are not crafted again', () => {
    const gather = 'gather{"item":"oak_log","count":3}';
    const make = 'craft{"item":"wooden_pickaxe"}';
    // One log makes 4 planks: 3 for the head, but no sticks.
    expect(hintFor('NEEDS_TOOL', coal, ctx({ oak_log: 1 }), needs('coal_ore'))).toBe(
      `${gather} first (you carry too little wood), then craft planks, sticks and wooden_pickaxe; then retry`,
    );
    expect(hintFor('NEEDS_TOOL', coal, ctx({}), needs('coal_ore'))).toBe(
      `${gather} first (you carry no wood), then craft planks, sticks and wooden_pickaxe; then retry`,
    );
    // With 2 sticks carried, that one log is enough.
    expect(hintFor('NEEDS_TOOL', coal, ctx({ oak_log: 1, stick: 2 }), needs('coal_ore'))).toBe(
      `craft planks, then ${make}; then retry`,
    );
    // Planks enough for head and sticks: only the sticks are missing.
    expect(hintFor('NEEDS_TOOL', coal, ctx({ oak_planks: 5 }), needs('coal_ore'))).toBe(
      `craft sticks, then ${make}; then retry`,
    );
    expect(hintFor('NEEDS_TOOL', coal, ctx({ oak_log: 3 }), needs('coal_ore'))).toBe(
      `craft planks, then sticks, then ${make}; then retry`,
    );
    expect(hintFor('NEEDS_TOOL', coal, ctx({ oak_planks: 3, stick: 2 }), needs('coal_ore'))).toBe(
      `${make}, then retry`,
    );
  });

  it("NEEDS_TOOL names vanilla's tier: a redstone block takes any pickaxe, a raw gold block an iron one", () => {
    expect(pickaxeFor('minecraft:redstone_block')).toBe('wooden_pickaxe');
    expect(pickaxeFor('minecraft:deepslate_redstone_ore')).toBe('iron_pickaxe');
    expect(pickaxeFor('minecraft:raw_gold_block')).toBe('iron_pickaxe');
    expect(pickaxeFor('minecraft:raw_iron_block')).toBe('stone_pickaxe');
    expect(pickaxeFor('minecraft:raw_copper_block')).toBe('stone_pickaxe');
    expect(pickaxeFor('minecraft:gold_block')).toBe('iron_pickaxe');
    expect(pickaxeFor('minecraft:nether_gold_ore')).toBe('wooden_pickaxe');
    expect(hintFor('NEEDS_TOOL', coal, { here: null, playerName: 'Jordan' }, needs('raw_gold_block'))).toBe(
      'craft{"item":"iron_pickaxe","gather_missing":true} (gathers what it needs from nature), then retry',
    );
  });

  it("a one-step do fails under the tool's own label (items give, not items diamond)", async () => {
    // No `to`: refused before it reaches the mod, under the call's label.
    const give = { action: 'give', item: 'diamond' };
    const { trace } = await play(logsAndTable, [
      [
        { tool: mc('items'), input: give },
        { tool: mc('do'), input: { steps: [{ tool: 'items', args: give }] } },
        { tool: mc('do'), input: { steps: [{ tool: 'goto', args: { to: 'nowhere_at_all' } }] } },
        { text: 'No diamonds.' },
      ],
    ]);
    const [direct, viaDo, gotoDo] = texts(trace);
    expect(direct).toMatch(/^failed: items give \| BAD_ARGS: give needs item and to/);
    expect(viaDo).toMatch(/^failed: items give \| BAD_ARGS: step 1 items: give needs item and to/);
    expect(gotoDo).toMatch(/^failed: goto nowhere_at_all \| /);
  }, 60_000);

  it('the People line: leaves are no roof (a player under a tree at night is in the open), a roof is', () => {
    const world = buildWorld({ clock: 12_200 });
    world.mod = 'v2';
    const at = { x: -20, y: 64, z: 20 };
    world.player.pos = at;
    const people = () =>
      String(lookAroundV2(world, 24, true).scene)
        .split('\n')
        .find((l) => l.startsWith('People: ')) ?? '';
    world.set({ x: at.x, y: at.y + 3, z: at.z }, `${NS}oak_leaves`);
    expect(people()).toMatch(/^People: Jordan \(player\) [^,]+ at -20 64 20, in the open\.$/);
    world.set({ x: at.x, y: at.y + 4, z: at.z }, `${NS}oak_planks`, 'player');
    expect(people()).toMatch(/^People: Jordan \(player\) [^,]+ at -20 64 20, under cover\.$/);
  });

  it('night safety: follow the player on the way (guard holds the spot it was set at), then guard there', () => {
    for (const mcTools of ['v1', 'v2'] as const) {
      const p = personaPrompt({
        name: 'Ada',
        handle: 'ada',
        role: 'ceo',
        ceo: true,
        playerName: 'Jordan',
        nonce: 'abcdef',
        mcTools,
      });
      expect(p).toContain('until then stay by Jordan (follow mode), then guard there.');
      expect(p).not.toContain('in guard mode');
    }
  });
});
