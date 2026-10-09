/**
 * Live check of the mode switch (PLAN §6.3 "Mode switch", agents/modes.ts) on the user's subscription. HARD CAP: 6
 * model turns for the whole file (part 1: 4, part 2: 2), enforced at each session's input.
 *
 *   MINEVIBE_CLAUDE=bundled npx vitest run --config vitest.live.config.ts test/live/modes.live.ts   (in apps/server)
 *
 * Through the real AgentManager and the SDK-bundled claude (the body side is the contract fakes), default mc tools:
 * - Part 1, wander → sit (4 turns): the welcome opens with the Minecraft-mode banner on Haiku; while wandering a pc
 *   tool is refused and an mc tool runs; `sit_at_pc`; the kickoff turn runs on Opus/medium, opens with the PC-mode
 *   banner ahead of the kickoff, runs a pc tool, gets `inventory` refused (code `mode`) and stands up.
 * - Part 2, stand (2 turns): an existing crew is reopened (no welcome turn) and seated by the mod (a worker restart,
 *   no turn), so its first turn is a PC-mode turn on Opus; it stands up, and after the (2 s) re-sit debounce the next
 *   turn runs on Haiku/xhigh and opens with the Minecraft-mode banner: pc refused, mc runs.
 * "Visible" means what the MODE banner offers plus what ToolGate lets through: the model's raw tool list stays the full,
 * pinned one (spike S3b). The numbers are written to `test/live/out/modes-live-*.json` (gitignored).
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { pino } from 'pino';
import { afterAll, describe, expect, it } from 'vitest';
import { AgentManager, type ToolObservation } from '../../src/agents/AgentManager.js';
import type { SwapResult } from '../../src/agents/AgentSession.js';
import { agentEnv } from '../../src/agents/agentEnv.js';
import { resolveClaudeBinary } from '../../src/agents/claudeBinary.js';
import { modeProfile } from '../../src/agents/modes.js';
import { type QueryFactory, type SDKResultMessage, sdkQueryFactory } from '../../src/agents/sdk.js';
import { FakeOrgApi } from '../../src/contracts/FakeOrgApi.js';
import { FakeSkillApi } from '../../src/contracts/FakeSkillApi.js';
import type { SeatRequest } from '../../src/contracts/SkillApi.js';
import { SERVER_VERSION } from '../../src/version.js';
import { MountedPcApi } from '../helpers/agentHarness.js';
import { fakeQueryFactory } from '../helpers/fakeSdk.js';

const OUT = join(import.meta.dirname, 'out');
/** The task's hard cap on model turns for this file: 6. */
const PART_CAPS = { wanderSit: 4, stand: 2 } as const;

class LiveSkills extends FakeSkillApi {
  onSeat: ((req: SeatRequest, jobId: string) => void) | null = null;

  override async seat(req: SeatRequest) {
    const res = await super.seat(req);
    setTimeout(() => this.onSeat?.(req, res.jobId), 300);
    return res;
  }
}

interface TurnRecord {
  models: string[];
  efforts: string[];
  tools: string[];
  /** The first line of the user message that started the turn. */
  opened: string;
  /** The session cost so far (`total_cost_usd` adds up over the session). */
  costUsd: number;
  ms: number;
  text: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A user message handed to claude: a query (starts or joins a turn) or context (`shouldQuery:false`). */
interface Sent {
  readonly text: string;
  readonly query: boolean;
}

/**
 * The session's user messages, as they are handed to claude. The hard turn cap lives here: a message that would start
 * one model turn too many is never handed over (the input ends, so the session ends).
 */
function recording(
  prompt: AsyncIterable<SDKUserMessage>,
  sent: Sent[],
  queries: { n: number; cap: number },
): AsyncIterable<SDKUserMessage> {
  return {
    [Symbol.asyncIterator]() {
      const it = prompt[Symbol.asyncIterator]();
      return {
        async next() {
          const r = await it.next();
          if (!r.done) {
            const c = r.value.message.content;
            const text = typeof c === 'string' ? c : JSON.stringify(c);
            const query = (r.value as { shouldQuery?: boolean }).shouldQuery !== false;
            if (query && ++queries.n > queries.cap) return { value: undefined, done: true };
            sent.push({ text, query });
          }
          return r;
        },
        return: async () => (it.return ? it.return() : { value: undefined, done: true }),
      };
    },
  };
}

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** A crew on the real SDK with a hard turn cap, recording turns, tool decisions, swaps and the messages sent. */
async function liveCrew(dir: string, cap: number) {
  const env = process.env;
  const claude = await resolveClaudeBinary({
    env,
    versionEnv: agentEnv({ version: SERVER_VERSION, source: env }),
    allowBundled: true,
  });
  const skills = new LiveSkills();
  skills.observations.set('status', { hp: 20, maxHp: 20, food: 20, pos: { x: 0, y: 64, z: 0 }, job: null });
  skills.observations.set('inventory', { items: [{ item: 'minecraft:oak_log', count: 3 }] });
  const sent: Sent[] = [];
  const queries = { n: 0, cap };
  // Safety caps on top of the production options: API round trips per turn and spend.
  const factory: QueryFactory = (params) =>
    sdkQueryFactory({
      ...params,
      prompt: recording(params.prompt, sent, queries),
      options: { ...params.options, maxTurns: 8, maxBudgetUsd: 2 },
    });
  const manager = new AgentManager({
    skills,
    org: new FakeOrgApi(),
    pcs: new MountedPcApi([{ pcId: 'linux-1' }]),
    claude,
    agentEnv: () => agentEnv({ version: SERVER_VERSION, source: env }),
    worldsDir: join(dir, 'worlds'),
    stateDir: join(dir, 'state'),
    playerName: () => 'Jasper',
    log: pino({ level: env.MINEVIBE_LOG_LEVEL ?? 'warn' }),
    queryFactory: factory,
    chatDebounceMs: 0,
    autonomyTickMs: 0,
    swapDebounceMs: 2_000,
  });
  const results: SDKResultMessage[] = [];
  const turns: TurnRecord[] = [];
  const observations: ToolObservation[] = [];
  const swaps: SwapResult[] = [];
  const blank = (): TurnRecord => ({
    models: [],
    efforts: [],
    tools: [],
    opened: '',
    costUsd: 0,
    ms: 0,
    text: '',
  });
  let current = blank();
  let sentAtStart = 0;
  let turnStart = Date.now();
  manager.on('tool', (o) => {
    observations.push(o);
    if (o.model && !current.models.includes(o.model)) current.models.push(o.model);
    if (o.effort && !current.efforts.includes(o.effort)) current.efforts.push(o.effort);
    current.tools.push(`${o.toolName.replace(/^mcp__/, '')}:${o.behavior}${o.code ? `(${o.code})` : ''}`);
  });
  manager.on('turn', ({ result, model }) => {
    results.push(result);
    if (model && !current.models.includes(model)) current.models.push(model);
    current.ms = Date.now() - turnStart;
    current.costUsd = result.total_cost_usd;
    current.text = result.subtype === 'success' ? result.result.slice(0, 400) : result.subtype;
    current.opened =
      sent
        .slice(sentAtStart)
        .find((m) => m.query && !m.text.startsWith('/'))
        ?.text.split('\n')[0] ?? '';
    turns.push(current);
    current = blank();
    sentAtStart = sent.length;
    turnStart = Date.now();
  });
  let agentId = '';
  const brain = () => manager.brain(agentId);
  const swapTimer = setInterval(() => {
    const s = brain()?.lastSwap;
    if (s && swaps.at(-1) !== s) swaps.push(s);
  }, 10);
  const waitFor = async (pred: () => boolean, what: string, ms = 180_000) => {
    const start = Date.now();
    while (!pred()) {
      if (Date.now() - start > ms) throw new Error(`timed out: ${what}`);
      await sleep(50);
    }
  };
  /** Waits until `n` turns ended in all and the brain is idle again. */
  const turnsDone = async (n: number, what: string) => {
    await waitFor(() => results.length >= n, `${what}: result`);
    await waitFor(() => brain()?.session?.inTurn === false, `${what}: settled`, 60_000);
  };
  const say = (text: string) => manager.deliverChat({ to: 'all', text: `@ada ${text}` });
  const opens = (title: string) => `[MV:${brain()?.record.nonce ?? ''} MODE] ${title}:`;
  const close = async (label: string) => {
    clearInterval(swapTimer);
    const summary = {
      at: new Date().toISOString(),
      label,
      claude: { source: claude.source, version: claude.version },
      mcTools: brain()?.mcTools ?? null,
      turns,
      swaps,
      modelTurns: results.length,
      queryMessages: queries.n,
      // `total_cost_usd` adds up over the session: its last value is the session cost.
      sessionCostUsd: results.at(-1)?.total_cost_usd ?? null,
      banners: sent.filter((m) => m.text.includes(' MODE] ')).map((m) => m.text.split('\n')[0]),
      denials: observations
        .filter((o) => o.behavior === 'deny')
        .map((o) => ({ tool: o.toolName, code: o.code, mode: o.mode })),
      usage: manager.governor.state,
    };
    mkdirSync(OUT, { recursive: true });
    writeFileSync(join(OUT, `modes-live-${label}.json`), `${JSON.stringify(summary, null, 2)}\n`);
    console.log(JSON.stringify(summary, null, 2));
    await manager.shutdown();
    manager.dispose();
  };
  return {
    manager,
    skills,
    turns,
    swaps,
    queries,
    brain,
    setAgent: (id: string) => {
      agentId = id;
    },
    waitFor,
    turnsDone,
    say,
    opens,
    close,
  };
}

const noPcAllowed = (t: TurnRecord) => t.tools.filter((x) => x.startsWith('pc__') && x.includes(':allow'));

describe('live mode switch (subscription, ≤ 6 turns)', () => {
  it('part 1, wander → sit: Minecraft mode on Haiku/xhigh, then PC mode on Opus/medium (4 turns)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mv-live-modes-1-'));
    dirs.push(dir);
    const c = await liveCrew(dir, PART_CAPS.wanderSit);
    try {
      // 1. The welcome turn: Minecraft mode is announced first.
      await c.manager.openWorld({ worldId: 'live-modes', gen: 1 });
      c.setAgent(c.manager.listAgents()[0]?.agentId ?? '');
      await c.turnsDone(1, 'welcome');
      expect(c.turns[0]?.opened.startsWith(c.opens('Minecraft mode'))).toBe(true);
      expect(c.brain()?.mode).toBe('wander');

      // 2. Wandering: pc refused (or not even tried: the banner says there is no PC here), mc runs.
      await c.say(
        'test of your tools, no chit-chat: (1) call mcp__pc__bash with command "echo hi", (2) call mcp__mc__status, (3) reply in one line "pc=<allowed or refused> mc=<allowed or refused> mode=<the mode your latest MODE notice names>".',
      );
      await c.turnsDone(2, 'wander');
      const wander = c.turns[1] as TurnRecord;
      expect(wander.models).toContain('claude-haiku-5-5');
      expect(wander.efforts).toContain('xhigh');
      expect(noPcAllowed(wander)).toEqual([]);
      expect(wander.tools).toContain('mc__status:allow');

      // 3. Sit; 4. the kickoff turn starts on its own after the swap.
      const id = c.brain()?.agentId ?? '';
      c.skills.onSeat = (req, jobId) => {
        c.manager.onPcSeat({
          pcId: 'linux-1',
          occupant: { kind: 'agent', agentId: id },
          seatEpoch: req.seatEpoch,
        });
        c.skills.finish(jobId, { status: 'done' });
      };
      await c.say(
        'call mcp__mc__sit_at_pc with pc "linux-1" and purpose "mode check: (1) call mcp__pc__bash with command echo pc-ok, (2) call mcp__mc__inventory once, (3) call mcp__mc__status, (4) reply in one line: mc tools available now = <the mcp__mc__ tool names your latest MODE notice lists as available>, then call mcp__mc__stand_up". When it says Seated, end your turn and reply: sitting',
      );
      await c.turnsDone(4, 'sit + kickoff');
      const kickoff = c.turns[3] as TurnRecord;
      expect(kickoff.opened.startsWith(c.opens('PC mode'))).toBe(true);
      expect(kickoff.models).toContain('claude-opus-5-5');
      expect(kickoff.efforts).toContain('medium');
      expect(kickoff.tools).toContain('pc__bash:allow');
      expect(
        kickoff.tools.filter((t) => t.startsWith('mc__inventory:') && t !== 'mc__inventory:deny(mode)'),
      ).toEqual([]);
      expect(kickoff.tools).toContain('mc__status:allow');
      expect(kickoff.tools).toContain('mc__stand_up:allow');
      const named = modeProfile('seated', c.brain()?.mcTools).mc.filter((t) => kickoff.text.includes(t));
      console.log(`seated mc tools the agent named: ${named.join(', ')}`);
      await c.waitFor(() => c.brain()?.model === 'haiku', 'swap back to haiku', 30_000);
      expect(c.swaps.map((s) => s.to)).toEqual(['claude-opus-5-5', 'claude-haiku-5-5']);
      expect(c.queries.n).toBeLessThanOrEqual(PART_CAPS.wanderSit);
    } finally {
      await c.close('wander-sit');
    }
  });

  it('part 2, stand: a PC-mode turn on Opus stands up, then Minecraft mode on Haiku/xhigh (2 turns)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mv-live-modes-2-'));
    dirs.push(dir);
    // A crew file with a CEO whose session never ran a model turn (the fake SDK answers nothing).
    const setup = new AgentManager({
      skills: new FakeSkillApi(),
      org: new FakeOrgApi(),
      pcs: new MountedPcApi([{ pcId: 'linux-1' }]),
      claude: { source: 'bundled', path: undefined, version: null },
      agentEnv: () => ({ HOME: dir, PATH: '/usr/bin:/bin' }),
      worldsDir: join(dir, 'worlds'),
      stateDir: join(dir, 'state'),
      playerName: () => 'Jasper',
      log: pino({ level: 'silent' }),
      queryFactory: fakeQueryFactory(),
      chatDebounceMs: 0,
      autonomyTickMs: 0,
    });
    await setup.openWorld({ worldId: 'live-modes-2', gen: 1 });
    await setup.shutdown();
    setup.dispose();

    const c = await liveCrew(dir, PART_CAPS.stand);
    try {
      // Reopened: no welcome turn. The mod still has the agent in the chair (a worker restart): seated, no turn.
      await c.manager.openWorld({ worldId: 'live-modes-2', gen: 1 });
      const id = c.manager.listAgents()[0]?.agentId ?? '';
      c.setAgent(id);
      await c.waitFor(() => c.brain()?.session?.started === true, 'session');
      c.manager.onPcSeat({ pcId: 'linux-1', occupant: { kind: 'agent', agentId: id }, seatEpoch: 0 });
      await c.waitFor(() => c.brain()?.fsm.state === 'seated', 'seated');
      await c.waitFor(() => c.brain()?.lastSwap?.to === 'claude-opus-5-5', 'swap to opus', 30_000);
      expect(c.turns).toHaveLength(0);

      // 5. A PC-mode turn on Opus that stands up.
      await c.say(
        'mode check, no chit-chat: (1) call mcp__pc__bash with command "echo pc-ok", (2) call mcp__mc__inventory once, (3) call mcp__mc__stand_up, (4) reply in one line "done".',
      );
      await c.turnsDone(1, 'seated turn');
      const seated = c.turns[0] as TurnRecord;
      expect(seated.opened.startsWith(c.opens('PC mode'))).toBe(true);
      expect(seated.models).toContain('claude-opus-5-5');
      expect(seated.efforts).toContain('medium');
      expect(seated.tools).toContain('pc__bash:allow');
      expect(
        seated.tools.filter((t) => t.startsWith('mc__inventory:') && t !== 'mc__inventory:deny(mode)'),
      ).toEqual([]);
      expect(seated.tools).toContain('mc__stand_up:allow');
      await c.waitFor(() => c.brain()?.fsm.state === 'wandering', 'stood up', 30_000);
      await c.waitFor(() => c.brain()?.model === 'haiku', 'swap back to haiku', 30_000);

      // 6. Back in Minecraft mode on Haiku/xhigh.
      await c.say(
        'test again, no chit-chat: (1) call mcp__pc__bash with command "echo hi", (2) call mcp__mc__inventory, (3) reply in one line "pc=<allowed or refused> mc=<allowed or refused> mode=<the mode your latest MODE notice names>".',
      );
      await c.turnsDone(2, 'back');
      const back = c.turns[1] as TurnRecord;
      expect(back.opened.startsWith(c.opens('Minecraft mode'))).toBe(true);
      expect(back.models).toContain('claude-haiku-5-5');
      expect(back.efforts).toContain('xhigh');
      expect(noPcAllowed(back)).toEqual([]);
      expect(back.tools).toContain('mc__inventory:allow');
      expect(c.swaps.map((s) => s.to)).toEqual(['claude-opus-5-5', 'claude-haiku-5-5']);
      expect(c.queries.n).toBeLessThanOrEqual(PART_CAPS.stand);
    } finally {
      await c.close('stand');
    }
  });
});
