/**
 * W1, world awareness and protection on the Node side: the consent ledger, the `mc` tools attaching consent only when
 * the player granted it (never from tool input), look_around as readable text, and the zone in the status footer.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { statusFooter } from '../../../src/agents/AgentBrain.js';
import { personaPrompt } from '../../../src/agents/prompts/persona.js';
import { createMcServer, type McHost } from '../../../src/agents/tools/mcServer.js';
import { ConsentLedger, REFUSAL_TTL_MS } from '../../../src/agents/world/consent.js';
import { refusalOf } from '../../../src/agents/world/guard.js';
import { perceiveFind } from '../../../src/agents/world/perception.js';
import { agentActor } from '../../../src/contracts/common.js';
import { FakeOrgApi } from '../../../src/contracts/FakeOrgApi.js';
import { FakeSkillApi } from '../../../src/contracts/FakeSkillApi.js';

// The mc tools here are the v1 set, the fallback behind MINEVIBE_MC_TOOLS=v1 (v2's consent: toolsV2*.test.ts).
beforeAll(() => {
  vi.stubEnv('MINEVIBE_MC_TOOLS', 'v1');
});
afterAll(() => {
  vi.unstubAllEnvs();
});

type Registered = Record<
  string,
  {
    inputSchema?: { safeParse(v: unknown): { success: boolean; data?: unknown } };
    handler: (a: unknown, e: unknown) => Promise<unknown>;
  }
>;

async function call(reg: Registered, name: string, args: Record<string, unknown>) {
  const tool = reg[name];
  if (!tool) throw new Error(`no tool ${name}`);
  const parsed = tool.inputSchema ? tool.inputSchema.safeParse(args) : { success: true, data: args };
  if (!parsed.success) return { invalid: true, text: '', isError: true };
  const res = (await tool.handler(parsed.data, {})) as {
    content: { type: string; text?: string }[];
    isError?: boolean;
  };
  return {
    invalid: false,
    text: res.content
      .filter((c) => c.type === 'text')
      .map((c) => c.text)
      .join('\n'),
    isError: res.isError === true,
  };
}

const TOKEN = '3f9c2a7be41d08c65a9e0b7d21c4f8e1';
const PROTECTED = {
  pos: { x: 102, y: 64, z: -37 },
  what: 'base' as const,
  owner: 'Jordan',
  block: 'minecraft:stripped_spruce_log',
  zone: 'Base',
  count: 4,
  consentId: TOKEN,
  hint: "That's part of Jordan's base — ask Jordan before changing it.",
};

function mcHost(consents?: ConsentLedger, extra: Partial<McHost> = {}) {
  const skills = new FakeSkillApi();
  const org = new FakeOrgApi({
    now: () => 1_000,
    clockTime: () => 30_000,
    positionOf: () => ({ pos: { x: 10, y: 64, z: -3 }, dim: 'minecraft:overworld' }),
    isCeo: () => true,
    playerName: () => 'Jordan',
  });
  const host: McHost = {
    agentId: 'ada-1',
    skills,
    org,
    actor: () => agentActor('ada-1', true),
    playerName: () => 'Jordan',
    footer: () => '[footer]',
    here: () => ({ pos: { x: 10, y: 64, z: -3 }, dim: 'minecraft:overworld' }),
    clockTime: () => 30_000,
    trackJob: () => {},
    say: () => {},
    tell: async () => '',
    remember: async () => '',
    requestHire: async () => '',
    sitAtPc: async () => '',
    standUp: async () => '',
    wait: async () => '',
    taskReported: () => {},
    takeConsent: () => consents?.take('ada-1') ?? null,
    ...extra,
  };
  const reg = (createMcServer(host).instance as unknown as { _registeredTools: Registered })._registeredTools;
  return { skills, reg };
}

describe("ConsentLedger with the mod's tokens", () => {
  it("a PROTECTED failure's token is granted only by the player, once", () => {
    let now = 0;
    const ledger = new ConsentLedger({ now: () => now });
    const refusal = refusalOf({ protected: PROTECTED });
    expect(refusal).toMatchObject({ positions: [PROTECTED.pos], zone: 'base', count: 4, consentId: TOKEN });
    ledger.noteRefusal('ada-1', refusal);
    expect(ledger.take('ada-1')).toBeNull();
    expect(ledger.fromChat('bram-1', 'yes, take the stripped spruce logs').kind).toBe('none');
    expect(ledger.fromChat('ada-1', 'yes, take it').kind).toBe('unclear');
    const verdict = ledger.fromChat('ada-1', 'yes, take the stripped spruce logs');
    expect(verdict.kind).toBe('granted');
    expect(ledger.take('bram-1')).toBeNull();
    expect(ledger.take('ada-1')).toEqual({ token: TOKEN });
    expect(ledger.take('ada-1')).toBeNull();
    ledger.noteRefusal('ada-1', refusal);
    now = REFUSAL_TTL_MS + 1;
    expect(ledger.fromChat('ada-1', 'yes, take the stripped spruce logs').kind).toBe('none');
  });

  it('a refusal without a well-formed token cannot be allowed', () => {
    const ledger = new ConsentLedger();
    for (const consentId of [undefined, 'yes please']) {
      ledger.noteRefusal('ada-1', refusalOf({ protected: { ...PROTECTED, consentId } }));
      expect(ledger.fromChat('ada-1', 'yes, take the stripped spruce logs').kind).toBe('unclear');
      expect(ledger.take('ada-1')).toBeNull();
    }
  });
});

describe('mc tools and consent (W1)', () => {
  it('allow_protected sends nothing until the player granted the refusal', async () => {
    const ledger = new ConsentLedger();
    const { reg, skills } = mcHost(ledger);
    skills.skillHandler = () => ({
      status: 'failed',
      code: 'PROTECTED',
      msg: PROTECTED.hint,
      result: { mined: 0, protected: PROTECTED },
    });
    const refused = await call(reg, 'mine', { block: 'stripped_spruce_log', count: 1 });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain('PROTECTED');
    expect(refused.text).toContain('ask Jordan before changing it');
    expect(refused.text).not.toContain(TOKEN);
    // AgentManager notes every PROTECTED job end (here by hand).
    ledger.noteRefusal('ada-1', refusalOf({ protected: PROTECTED }));

    // The model asks on its own: no consent goes along.
    await call(reg, 'mine', { block: 'stripped_spruce_log', count: 1, allow_protected: true });
    expect(skills.runs[1]?.consent).toBeUndefined();
    expect(skills.runs[1]?.args).toMatchObject({ allow_protected: true });

    // A token smuggled into the tool input is stripped before it reaches the mod.
    await call(reg, 'mine', { block: 'stripped_spruce_log', count: 1, consent: { token: TOKEN } });
    expect(skills.runs[2]?.consent).toBeUndefined();
    expect(Object.hasOwn(skills.runs[2]?.args ?? {}, 'consent')).toBe(false);

    // The player agreed (a player-driven path calls grant): the next allow_protected call carries it, once.
    expect(ledger.fromChat('ada-1', 'yes, break the stripped spruce log').kind).toBe('granted');
    skills.skillHandler = () => ({ status: 'done', result: { mined: 1 } });
    await call(reg, 'mine', { block: 'stripped_spruce_log', count: 1, allow_protected: true });
    expect(skills.runs[3]?.consent).toEqual({ token: TOKEN });
    await call(reg, 'mine', { block: 'stripped_spruce_log', count: 1, allow_protected: true });
    expect(skills.runs[4]?.consent).toBeUndefined();
  });

  it('a call without allow_protected never uses up a granted consent', async () => {
    const ledger = new ConsentLedger();
    ledger.noteRefusal('ada-1', refusalOf({ protected: PROTECTED }));
    expect(ledger.fromChat('ada-1', 'yes, take the stripped spruce logs').kind).toBe('granted');
    const { reg, skills } = mcHost(ledger);
    await call(reg, 'mine', { block: 'oak_log', count: 1 });
    expect(skills.runs[0]?.consent).toBeUndefined();
    expect(ledger.take('ada-1')).toEqual({ token: TOKEN });
  });

  it('without a ledger no consent is ever attached', async () => {
    const { reg, skills } = mcHost();
    await call(reg, 'dig', { from: { x: 0, y: 0, z: 0 }, to: { x: 1, y: 1, z: 1 }, allow_protected: true });
    expect(skills.runs[0]?.consent).toBeUndefined();
  });

  it('look_around reads as the scene text; find and the skills take the new arguments', async () => {
    const { reg, skills } = mcHost();
    skills.observations.set('look_around', {
      scene: "Here: 1 64 2 overworld.\nInside Base (Jordan's base): never break or change its blocks.",
      detail: 'brief',
      footer: 'HP 20/20 food 20 | day 1 06:00 | 1 64 2 overworld | in Base | idle (follow)',
    });
    const look = await call(reg, 'look_around', { detail: 'full' });
    expect(look.text.startsWith('Here: 1 64 2 overworld.\nInside Base')).toBe(true);
    expect(look.text).not.toContain('"scene"');
    expect(look.text.endsWith('| in Base | idle (follow)')).toBe(true);
    expect((await call(reg, 'look_around', { detail: 'everything' })).invalid).toBe(true);
    expect((await call(reg, 'find', { what: '#minecraft:logs', filter: 'natural' })).invalid).toBe(false);
    expect((await call(reg, 'find', { what: 'oak_log', filter: 'trees' })).invalid).toBe(true);
    expect((await call(reg, 'collect', { item: 'oak_log', count: 6, replant: true })).invalid).toBe(false);
    expect(skills.runs.at(-1)?.args).toMatchObject({ item: 'oak_log', count: 6, replant: true });
  });
});

describe("the mod's perception through Node", () => {
  it('find reads provenance, trees and reachability words', () => {
    const seen = perceiveFind(
      {
        what: 'oak_log',
        kind: 'block',
        filter: 'any',
        matches: [
          {
            pos: { x: 3, y: 64, z: 0 },
            block: 'minecraft:stripped_spruce_log',
            provenance: 'base',
            owner: 'Jordan',
            zone: 'Base',
          },
          {
            pos: { x: 5, y: 64, z: 0 },
            block: 'minecraft:oak_planks',
            provenance: 'agent-built',
            owner: 'ada',
          },
          {
            pos: { x: 20, y: 64, z: 0 },
            block: 'minecraft:oak_log',
            provenance: 'natural',
            tree: { species: 'oak', trunk: { x: 20, y: 64, z: 0 }, logs: 6 },
            reachable: 'reachable',
          },
        ],
        protectedNote: 'Matches marked player-built or base belong to Jordan.',
      },
      { here: { x: 0, y: 64, z: 0 }, base: null, playerName: 'Jordan' },
    );
    expect(seen.text).toContain('stripped_spruce_log 3m E at 3 64 0: PROTECTED (part of the Base)');
    expect(seen.text).toContain('built by the crew (yours to take back)');
    expect(seen.text).toContain('oak_log 20m E at 20 64 0: natural (oak tree, 6 logs), reachable');
    expect(seen.text).not.toContain('More:');
    expect(seen.trees).toEqual({ pos: { x: 20, y: 64, z: 0 }, reachable: true });
  });

  it("look_around's trees feed the scene line", async () => {
    const sightings: unknown[] = [];
    const { reg, skills } = mcHost(undefined, { noteTrees: (t) => sightings.push(t) });
    skills.observations.set('look_around', {
      scene: 'Here: 1 64 2 overworld.',
      detail: 'brief',
      trees: [
        {
          species: 'birch',
          trunk: { x: 9, y: 70, z: 9 },
          distance: 12,
          dir: 'SE',
          reachable: 'unreachable',
          logs: 5,
        },
        {
          species: 'oak',
          trunk: { x: 20, y: 64, z: 0 },
          distance: 20,
          dir: 'E',
          reachable: 'reachable',
          logs: 6,
        },
      ],
    });
    await call(reg, 'look_around', {});
    expect(sightings).toEqual([{ pos: { x: 20, y: 64, z: 0 }, reachable: true }]);
  });
});

describe('status footer and persona (W1)', () => {
  it('the Node-built footer names the zone like the mod does', () => {
    const footer = statusFooter(
      {
        agentId: 'ada-1',
        pos: { x: 101.5, y: 64, z: -35.5 },
        dim: 'minecraft:overworld',
        hp: 20,
        maxHp: 20,
        food: 18,
        saturation: 3,
        mode: 'follow',
        hasFood: true,
        inCombat: false,
        zone: '12m from Base',
      },
      null,
    );
    expect(footer).toBe('HP 20/20 food 18 | 101 64 -36 overworld | 12m from Base | idle (follow)');
  });

  it('the persona teaches to protect the base and never substitute', () => {
    const text = personaPrompt({
      name: 'Ada',
      handle: 'ada',
      role: 'ceo',
      ceo: true,
      playerName: 'Jordan',
      nonce: 'abc123',
    });
    expect(text).toContain('mcp__mc__look_around');
    expect(text).toContain('Never break, replace or take blocks of the Base or anything Jordan built');
    expect(text).toContain('NO_NATURAL_SOURCE');
    expect(text).toContain('instead of taking something else');
    expect(text).toContain('logs come from trees, not from walls');
    expect(text).toContain('allow_protected:true');
  });
});
