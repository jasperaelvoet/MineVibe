/**
 * Live smoke of the brain runtime (PLAN §13 item 6) on the user's subscription: six short turns.
 *
 *   MINEVIBE_CLAUDE=bundled npm run test:live -w apps/server
 *
 * Through the real AgentManager and the real Claude Agent SDK (the body side is the contract fakes) it proves:
 * 1. the CEO session starts and passes the startup assertions;
 * 2. an `mcp__mc__*` call reaches the (fake) SkillApi, on Haiku at xhigh;
 * 3. AskUserQuestion becomes a pending card and resolves from a chat answer;
 * 4. sit → the desk session (Opus/medium, PLAN §6.1 dual sessions) takes over with the KICKOFF → stand → the body
 *    session (Haiku/xhigh) wakes with the DESK REPORT.
 * The numbers (turn times, sessions, models, efforts, cost) are printed and written to `test/live/out/brain-live.json`
 * (gitignored).
 *
 * Recorded 2026-10-08, before dual sessions (one session, flag-layer swaps; SDK 0.3.293, bundled claude 2.1.293,
 * Claude Max), 6 model turns, $0.242 list estimate:
 *
 * | Turn            | Model / effort  | API turns | Wall time | Tools                 |
 * |-----------------|-----------------|-----------|-----------|-----------------------|
 * | welcome         | haiku           | 1         | 2.1 s     | none                  |
 * | mc status       | haiku / xhigh   | 2         | 1.3 s     | mc__status (allow)    |
 * | ask (card)      | haiku / xhigh   | 2         | 1.5 s*    | AskUserQuestion       |
 * | sit             | haiku / xhigh   | 2         | 1.6 s     | mc__sit_at_pc         |
 * | kickoff         | opus / medium   | 2         | 2.7 s     | mc__stand_up          |
 * | back on haiku   | haiku / xhigh   | 2         | 1.1 s     | mc__status            |
 *
 * (*) excluding the card wait. Swaps via applyFlagSettings: haiku→opus 16 ms, opus→haiku 15 ms, both acknowledged by
 * PostModelSwitch; estimated cache writes $0.2226 (to Opus) and $0.0057 (back to Haiku's warm cache). The Opus kickoff
 * turn was ~$0.23 of the $0.24. A one-turn probe showed `allowed_warning` at the 25% weekly milestone
 * (`seven_day`, utilization 0.26), so warnings alone no longer mean Tired (UsageGovernor).
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { AgentManager, type ToolObservation } from '../../src/agents/AgentManager.js';
import { agentEnv } from '../../src/agents/agentEnv.js';
import { resolveClaudeBinary } from '../../src/agents/claudeBinary.js';
import { type QueryFactory, type SDKResultMessage, sdkQueryFactory } from '../../src/agents/sdk.js';
import { FakeOrgApi } from '../../src/contracts/FakeOrgApi.js';
import { FakeSkillApi } from '../../src/contracts/FakeSkillApi.js';
import type { SeatRequest } from '../../src/contracts/SkillApi.js';
import { SERVER_VERSION } from '../../src/version.js';
import { MountedPcApi } from '../helpers/agentHarness.js';

const OUT = join(import.meta.dirname, 'out');

/** FakeSkillApi that records observations and completes sit jobs like the mod would (pc.seat, then the job). */
class LiveSkills extends FakeSkillApi {
  readonly queries: string[] = [];
  onSeat: ((req: SeatRequest, jobId: string) => void) | null = null;

  override async obsQuery(agentId: string, query: Parameters<FakeSkillApi['obsQuery']>[1]) {
    this.queries.push(query);
    return super.obsQuery(agentId, query);
  }

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
  numTurns: number;
  durationApiMs: number;
  costUsd: number;
  text: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('live brain smoke (subscription)', () => {
  it('session, mc tool, question card, sit/stand swaps', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mv-live-'));
    const env = process.env;
    const claude = await resolveClaudeBinary({
      env,
      versionEnv: agentEnv({ version: SERVER_VERSION, source: env }),
      allowBundled: true,
    });
    const skills = new LiveSkills();
    skills.observations.set('status', { hp: 20, maxHp: 20, food: 20, pos: { x: 0, y: 64, z: 0 }, job: null });
    // Safety caps on top of the production options (per-turn round trips and spend).
    const factory: QueryFactory = (params) =>
      sdkQueryFactory({ ...params, options: { ...params.options, maxTurns: 8, maxBudgetUsd: 2 } });
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
    });

    const toasts: string[] = [];
    const results: SDKResultMessage[] = [];
    const turns: TurnRecord[] = [];
    let current: TurnRecord = {
      label: 'welcome',
      ms: 0,
      models: [],
      efforts: [],
      tools: [],
      numTurns: 0,
      durationApiMs: 0,
      costUsd: 0,
      text: '',
    };
    let turnStart = Date.now();
    manager.on('toast', (t) => {
      toasts.push(t.text);
    });
    manager.on('tool', (o: ToolObservation) => {
      if (o.model && !current.models.includes(o.model)) current.models.push(o.model);
      if (o.effort && !current.efforts.includes(o.effort)) current.efforts.push(o.effort);
      current.tools.push(`${o.toolName.replace(/^mcp__/, '')}:${o.behavior}`);
    });
    manager.on('turn', ({ result, model }) => {
      results.push(result);
      if (model && !current.models.includes(model)) current.models.push(model);
      current.ms = Date.now() - turnStart;
      current.numTurns = result.num_turns;
      current.durationApiMs = result.duration_api_ms;
      current.costUsd = result.total_cost_usd;
      current.text = result.subtype === 'success' ? result.result.slice(0, 160) : result.subtype;
      turns.push(current);
      current = {
        label: '(next)',
        ms: 0,
        models: [],
        efforts: [],
        tools: [],
        numTurns: 0,
        durationApiMs: 0,
        costUsd: 0,
        text: '',
      };
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
    /** One player-driven turn: waits for its result and the brain to settle. */
    const turn = async (label: string, start: () => Promise<unknown>, during?: () => Promise<void>) => {
      const before = results.length;
      current.label = label;
      turnStart = Date.now();
      await start();
      if (during) await during();
      await waitFor(() => results.length > before, `${label}: result`);
      await waitFor(() => brain()?.session?.inTurn === false, `${label}: settled`, 30_000);
      return turns.at(-1) as TurnRecord;
    };

    try {
      await manager.openWorld({ worldId: 'live-1', gen: 1 });
      agentId = manager.listAgents()[0]?.agentId ?? '';
      // 1. The welcome turn: session start and startup assertions.
      await waitFor(() => results.length >= 1, 'welcome result');
      await waitFor(() => brain()?.session?.inTurn === false, 'welcome settled');
      await sleep(500);
      expect(toasts).toEqual([]);
      expect(brain()?.status).toBe('idle');

      // 2. An mc tool call reaches the SkillApi on Haiku at xhigh.
      const status = await turn('mc status', () =>
        manager.deliverChat({
          to: 'all',
          text: '@ada call the mcp__mc__status tool once, then reply with exactly: status ok',
        }),
      );
      expect(skills.queries).toContain('status');
      expect(status.models).toContain('claude-haiku-5-5');
      expect(status.efforts).toContain('xhigh');

      // 3. AskUserQuestion → pending card → answered from chat.
      const ask = await turn(
        'ask',
        () =>
          manager.deliverChat({
            to: 'all',
            text: '@ada use the AskUserQuestion tool to ask me one single-select question, "Which wood?", with the options Oak and Spruce. After my answer, reply with just the wood name.',
          }),
        async () => {
          await waitFor(() => manager.pendingCards().length === 1, 'question card');
          expect(manager.pendingCards()[0]).toMatchObject({ kind: 'question', agentId });
          expect(brain()?.status).toBe('waiting_player');
          const res = await manager.deliverChat({ to: 'all', text: '@ada 2' });
          expect(res.echo).toBe('You → Ada: Q1 = 2 (Spruce)');
        },
      );
      expect(ask.text.toLowerCase()).toContain('spruce');

      // 4. Sit → the desk session (Opus/medium) takes over with the kickoff, stands up → the body gets the report.
      await manager.command(agentId, { cmd: 'plan_first', on: false });
      skills.onSeat = (req, jobId) => {
        manager.onPcSeat({ pcId: 'linux-1', occupant: { kind: 'agent', agentId }, seatEpoch: req.seatEpoch });
        skills.finish(jobId, { status: 'done' });
      };
      await turn('sit', () =>
        manager.deliverChat({
          to: 'all',
          text: '@ada call mcp__mc__sit_at_pc with pc "linux-1" and purpose "smoke test: call mcp__mc__stand_up right away, then reply done". When it says Seated, end your turn and reply: sitting',
        }),
      );
      await waitFor(() => brain()?.activeSession === 'desk', 'desk session', 30_000);
      const beforeKickoff = results.length;
      const kickoff = await turn('kickoff in the desk', async () => {
        await waitFor(() => brain()?.session?.inTurn === true, 'kickoff turn', 30_000);
      });
      expect(kickoff.models).toContain('claude-opus-5-5');
      expect(kickoff.efforts).toContain('medium');
      expect(kickoff.tools.some((t) => t.startsWith('mc__stand_up'))).toBe(true);
      await waitFor(() => brain()?.fsm.state === 'wandering', 'stood up', 30_000);
      await waitFor(() => brain()?.activeSession === 'body', 'back in the body', 30_000);
      // The body's DESK REPORT turn (it may already be over).
      await waitFor(() => results.length >= beforeKickoff + 2, 'desk report turn');
      await waitFor(() => brain()?.session?.inTurn === false, 'report settled', 30_000);
      expect(turns.at(-1)?.models).toContain('claude-haiku-5-5');

      // 5. Back on Haiku at xhigh.
      const back = await turn('back on haiku', () =>
        manager.deliverChat({
          to: 'all',
          text: '@ada call the mcp__mc__status tool once, then reply with exactly: back',
        }),
      );
      expect(back.models).toContain('claude-haiku-5-5');
      expect(back.efforts).toContain('xhigh');
    } finally {
      const summary = {
        at: new Date().toISOString(),
        claude: { source: claude.source, version: claude.version },
        turns,
        modelTurns: results.length,
        totalCostUsd: results.at(-1)?.total_cost_usd ?? null,
        usage: manager.governor.state,
        toasts,
      };
      mkdirSync(OUT, { recursive: true });
      writeFileSync(join(OUT, 'brain-live.json'), `${JSON.stringify(summary, null, 2)}\n`);
      console.log(JSON.stringify(summary, null, 2));
      await manager.shutdown();
      manager.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
