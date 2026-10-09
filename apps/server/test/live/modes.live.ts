/**
 * Live check of the mode switch (PLAN §6.3 "Mode switch", agents/modes.ts) on the user's subscription. HARD CAP: 6
 * model turns (this run uses 5).
 *
 *   MINEVIBE_CLAUDE=bundled npx vitest run --config vitest.live.config.ts test/live/modes.live.ts   (in apps/server)
 *
 * Through the real AgentManager and the SDK-bundled claude (the body side is the contract fakes):
 * 1. welcome: Haiku/xhigh, the first message opens with the Minecraft-mode banner;
 * 2. wander: a pc tool is refused, an mc tool runs; the agent names what its MODE notice makes available;
 * 3. sit: `sit_at_pc`, then the turn ends;
 * 4. kickoff: Opus/medium; the message opens with the PC-mode banner before the kickoff; a pc tool runs, an mc
 *    world tool is refused (code `mode`), the minimal mc set runs, the agent names its mc tools and stands up;
 * 5. back: Haiku/xhigh after the (2 s) debounce; the Minecraft-mode banner opens the turn; pc refused, mc runs.
 * "Visible" here means what the MODE banner offers plus what ToolGate lets through: the model's raw tool list stays
 * the full, pinned one (spike S3b). The numbers are written to `test/live/out/modes-live.json` (gitignored).
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
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

const OUT = join(import.meta.dirname, 'out');
/** The task's hard cap on model turns for this check. */
const TURN_CAP = 6;

class LiveSkills extends FakeSkillApi {
  onSeat: ((req: SeatRequest, jobId: string) => void) | null = null;

  override async seat(req: SeatRequest) {
    const res = await super.seat(req);
    setTimeout(() => this.onSeat?.(req, res.jobId), 300);
    return res;
  }
}

interface TurnRecord {
  label: string;
  ms: number;
  models: string[];
  efforts: string[];
  tools: string[];
  /** The first line of the user message that started the turn. */
  opened: string;
  costUsd: number;
  text: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The session's user messages, as they are handed to claude. */
function recording(prompt: AsyncIterable<SDKUserMessage>, sent: string[]): AsyncIterable<SDKUserMessage> {
  return {
    [Symbol.asyncIterator]() {
      const it = prompt[Symbol.asyncIterator]();
      return {
        async next() {
          const r = await it.next();
          if (!r.done) {
            const c = r.value.message.content;
            sent.push(typeof c === 'string' ? c : JSON.stringify(c));
          }
          return r;
        },
        return: async () => (it.return ? it.return() : { value: undefined, done: true }),
      };
    },
  };
}

describe('live mode switch (subscription, ≤ 6 turns)', () => {
  it('wander → sit (PC mode, Opus/medium) → stand (Minecraft mode, Haiku/xhigh)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mv-live-modes-'));
    const env = process.env;
    const claude = await resolveClaudeBinary({
      env,
      versionEnv: agentEnv({ version: SERVER_VERSION, source: env }),
      allowBundled: true,
    });
    const skills = new LiveSkills();
    skills.observations.set('status', { hp: 20, maxHp: 20, food: 20, pos: { x: 0, y: 64, z: 0 }, job: null });
    skills.observations.set('inventory', { items: [{ item: 'minecraft:oak_log', count: 3 }] });
    const sent: string[] = [];
    let turnsStarted = 0;
    // Safety caps on top of the production options: API round trips per turn, spend, and the turn cap itself.
    const factory: QueryFactory = (params) =>
      sdkQueryFactory({
        ...params,
        prompt: recording(params.prompt, sent),
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
    const swaps: SwapResult[] = [];
    const turns: TurnRecord[] = [];
    const observations: ToolObservation[] = [];
    const blank = (label: string): TurnRecord => ({
      label,
      ms: 0,
      models: [],
      efforts: [],
      tools: [],
      opened: '',
      costUsd: 0,
      text: '',
    });
    let current = blank('welcome');
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
      turns.push(current);
      current = blank('(next)');
      turnStart = Date.now();
    });

    const waitFor = async (pred: () => boolean, what: string, ms = 180_000) => {
      const start = Date.now();
      while (!pred()) {
        if (Date.now() - start > ms) throw new Error(`timed out: ${what}`);
        await sleep(50);
      }
    };
    let agentId = '';
    const brain = () => manager.brain(agentId);
    const swapTimer = setInterval(() => {
      const s = brain()?.lastSwap;
      if (s && swaps.at(-1) !== s) swaps.push(s);
    }, 10);
    /** One turn: waits for its result and the brain to settle. Refuses to go past the cap. */
    const turn = async (label: string, start: () => Promise<unknown>) => {
      if (++turnsStarted > TURN_CAP) throw new Error(`turn cap ${TURN_CAP} reached`);
      const before = results.length;
      const sentBefore = sent.length;
      current.label = label;
      turnStart = Date.now();
      await start();
      await waitFor(() => results.length > before, `${label}: result`);
      await waitFor(() => brain()?.session?.inTurn === false, `${label}: settled`, 30_000);
      const record = turns.at(-1) as TurnRecord;
      record.opened =
        sent
          .slice(sentBefore)
          .find((t) => !t.startsWith('/'))
          ?.split('\n')[0] ?? '';
      return record;
    };
    const say = (text: string) => () => manager.deliverChat({ to: 'all', text: `@ada ${text}` });
    const nonce = () => brain()?.record.nonce ?? '';
    const opens = (title: string) => `[MV:${nonce()} MODE] ${title}:`;

    try {
      // 1. The welcome turn (Haiku): Minecraft mode is announced first.
      turnsStarted++;
      await manager.openWorld({ worldId: 'live-modes', gen: 1 });
      agentId = manager.listAgents()[0]?.agentId ?? '';
      await waitFor(() => results.length >= 1, 'welcome result');
      await waitFor(() => brain()?.session?.inTurn === false, 'welcome settled');
      const welcome = sent.find((t) => t.includes('WELCOME]')) ?? '';
      expect(welcome.startsWith(opens('Minecraft mode'))).toBe(true);
      (turns[0] as TurnRecord).opened = welcome.split('\n')[0] ?? '';
      expect(brain()?.mode).toBe('wander');

      // 2. Wandering: pc refused, mc runs, on Haiku/xhigh.
      const wander = await turn(
        'wander',
        say(
          'test of your tools, no chit-chat: (1) call mcp__pc__bash with command "echo hi", (2) call mcp__mc__status, (3) reply in one line "pc=<allowed or refused> mc=<allowed or refused> mode=<the mode your latest MODE notice names>".',
        ),
      );
      expect(wander.models).toContain('claude-haiku-5-5');
      expect(wander.efforts).toContain('xhigh');
      expect(wander.tools).toContain('pc__bash:deny(not_seated)');
      expect(wander.tools).toContain('mc__status:allow');

      // 3. Sit.
      await manager.command(agentId, { cmd: 'plan_first', on: false });
      skills.onSeat = (req, jobId) => {
        manager.onPcSeat({ pcId: 'linux-1', occupant: { kind: 'agent', agentId }, seatEpoch: req.seatEpoch });
        skills.finish(jobId, { status: 'done' });
      };
      await turn(
        'sit',
        say(
          'call mcp__mc__sit_at_pc with pc "linux-1" and purpose "mode check: (1) call mcp__pc__bash with command echo pc-ok, (2) call mcp__mc__inventory once, (3) call mcp__mc__status, (4) reply in one line: mc tools available now = <the mcp__mc__ tool names your latest MODE notice lists as available>, then call mcp__mc__stand_up". When it says Seated, end your turn and reply: sitting',
        ),
      );
      await waitFor(() => brain()?.model === 'opus', 'swap to opus', 30_000);

      // 4. The kickoff turn on Opus/medium in PC mode.
      const kickoff = await turn('kickoff (PC mode)', async () => {
        await waitFor(() => brain()?.session?.inTurn === true, 'kickoff turn', 30_000);
      });
      expect(kickoff.opened.startsWith(opens('PC mode'))).toBe(true);
      const kickoffMessage = sent.find((t) => t.includes('KICKOFF]')) ?? '';
      expect(kickoffMessage.indexOf('MODE]')).toBeLessThan(kickoffMessage.indexOf('KICKOFF]'));
      expect(kickoff.models).toContain('claude-opus-5-5');
      expect(kickoff.efforts).toContain('medium');
      expect(kickoff.tools).toContain('pc__bash:allow');
      expect(kickoff.tools).toContain('mc__inventory:deny(mode)');
      expect(kickoff.tools).toContain('mc__status:allow');
      expect(kickoff.tools).toContain('mc__stand_up:allow');
      const listed = modeProfile('seated', brain()?.mcTools).mc.filter((t) => kickoff.text.includes(t));
      await waitFor(() => brain()?.fsm.state === 'wandering', 'stood up', 30_000);
      await waitFor(() => brain()?.model === 'haiku', 'swap back to haiku', 30_000);

      // 5. Back in Minecraft mode on Haiku/xhigh.
      const back = await turn(
        'back (Minecraft mode)',
        say(
          'test again, no chit-chat: (1) call mcp__pc__bash with command "echo hi", (2) call mcp__mc__inventory, (3) reply in one line "pc=<allowed or refused> mc=<allowed or refused>".',
        ),
      );
      expect(back.opened.startsWith(opens('Minecraft mode'))).toBe(true);
      expect(back.models).toContain('claude-haiku-5-5');
      expect(back.efforts).toContain('xhigh');
      expect(back.tools).toContain('pc__bash:deny(not_seated)');
      expect(back.tools).toContain('mc__inventory:allow');
      expect(swaps.map((s) => s.to)).toEqual(['claude-opus-5-5', 'claude-haiku-5-5']);
      expect(listed.length).toBeGreaterThan(0);
      console.log(`seated mc tools the agent named: ${listed.join(', ')}`);
    } finally {
      clearInterval(swapTimer);
      const summary = {
        at: new Date().toISOString(),
        claude: { source: claude.source, version: claude.version },
        turns,
        swaps,
        modelTurns: results.length,
        totalCostUsd: results.at(-1)?.total_cost_usd ?? null,
        banners: sent.filter((t) => t.includes(' MODE] ')).map((t) => t.split('\n')[0]),
        denials: observations
          .filter((o) => o.behavior === 'deny')
          .map((o) => ({ tool: o.toolName, code: o.code, mode: o.mode })),
        usage: manager.governor.state,
      };
      mkdirSync(OUT, { recursive: true });
      writeFileSync(join(OUT, 'modes-live.json'), `${JSON.stringify(summary, null, 2)}\n`);
      console.log(JSON.stringify(summary, null, 2));
      await manager.shutdown();
      manager.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
