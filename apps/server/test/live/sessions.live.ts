/**
 * Live check of dual sessions (PLAN §6.1, §6.3) and of the fixed session titles, on the user's subscription. HARD CAP:
 * 5 model turns for the whole file (part 1: 4, part 2: 1), enforced at each session's input.
 *
 *   MINEVIBE_CLAUDE=bundled npx vitest run --config vitest.live.config.ts test/live/sessions.live.ts   (in apps/server)
 *
 * Through the real AgentManager and the SDK-bundled claude (the body side is the contract fakes), default mc tools:
 * - Part 1 (4 turns): the welcome turn runs in the BODY session (Haiku/xhigh); a body turn calls `sit_at_pc`; the
 *   DESK session for linux-1 (Opus/medium, its own tool list) takes over with the KICKOFF, runs a pc tool and stands
 *   up; the body wakes with the DESK REPORT. Then both sessions' transcripts are read (entry types only, never their
 *   text: they hold the account's e-mail address) and the `ai-title` / `custom-title` entries counted.
 * - Part 2 (1 turn): a bare persisted session with NO title, the baseline for the `ai-title` count.
 * The numbers are written to `test/live/out/sessions-live-*.json` (gitignored).
 */

import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSdkMcpServer, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { pino } from 'pino';
import { afterAll, describe, expect, it } from 'vitest';
import { AgentManager, type ToolObservation } from '../../src/agents/AgentManager.js';
import { agentEnv } from '../../src/agents/agentEnv.js';
import { resolveClaudeBinary } from '../../src/agents/claudeBinary.js';
import { type QueryFactory, type SDKResultMessage, sdkQueryFactory } from '../../src/agents/sdk.js';
import { buildSessionOptions } from '../../src/agents/sessionOptions.js';
import { FakeOrgApi } from '../../src/contracts/FakeOrgApi.js';
import { FakeSkillApi } from '../../src/contracts/FakeSkillApi.js';
import type { SeatRequest } from '../../src/contracts/SkillApi.js';
import { SERVER_VERSION } from '../../src/version.js';
import { MountedPcApi } from '../helpers/agentHarness.js';

const OUT = join(import.meta.dirname, 'out');
/** The hard cap on model turns for this file: 5. */
const CAPS = { sessions: 4, baseline: 1 } as const;

class LiveSkills extends FakeSkillApi {
  onSeat: ((req: SeatRequest, jobId: string) => void) | null = null;

  override async seat(req: SeatRequest) {
    const res = await super.seat(req);
    setTimeout(() => this.onSeat?.(req, res.jobId), 300);
    return res;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Ends the session's input once it would start one model turn too many (the hard cap). */
function capped(prompt: AsyncIterable<SDKUserMessage>, queries: { n: number; cap: number }) {
  return {
    [Symbol.asyncIterator]() {
      const it = prompt[Symbol.asyncIterator]();
      return {
        async next(): Promise<IteratorResult<SDKUserMessage>> {
          const r = await it.next();
          if (
            !r.done &&
            (r.value as { shouldQuery?: boolean }).shouldQuery !== false &&
            ++queries.n > queries.cap
          )
            return { value: undefined, done: true };
          return r;
        },
        return: async () => (it.return ? it.return() : { value: undefined, done: true as const }),
      };
    },
  } as AsyncIterable<SDKUserMessage>;
}

/** The entry types of a session's transcript (`~/.claude/projects/<cwd slug>/<sessionId>.jsonl`), never its text. */
function transcriptTypes(sessionId: string): Record<string, number> | null {
  const root = join(homedir(), '.claude', 'projects');
  if (!existsSync(root)) return null;
  for (const dir of readdirSync(root)) {
    const file = join(root, dir, `${sessionId}.jsonl`);
    if (!existsSync(file)) continue;
    const counts: Record<string, number> = {};
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (line.trim().length === 0) continue;
      try {
        const type = String((JSON.parse(line) as { type?: unknown }).type ?? '?');
        counts[type] = (counts[type] ?? 0) + 1;
      } catch {
        counts['(torn)'] = (counts['(torn)'] ?? 0) + 1;
      }
    }
    return counts;
  }
  return null;
}

/** The transcript folder of a session (removed afterwards: these are throwaway sessions). */
function transcriptDir(sessionId: string): string | null {
  const root = join(homedir(), '.claude', 'projects');
  if (!existsSync(root)) return null;
  for (const dir of readdirSync(root))
    if (existsSync(join(root, dir, `${sessionId}.jsonl`))) return join(root, dir);
  return null;
}

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe('live dual sessions and session titles (subscription, ≤ 5 turns)', () => {
  it('part 1: body → desk (KICKOFF) → body (DESK REPORT); titled sessions write no ai-title (4 turns)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mv-live-sessions-'));
    dirs.push(dir);
    const env = process.env;
    const claude = await resolveClaudeBinary({
      env,
      versionEnv: agentEnv({ version: SERVER_VERSION, source: env }),
      allowBundled: true,
    });
    const skills = new LiveSkills();
    skills.observations.set('status', { hp: 20, maxHp: 20, food: 20, pos: { x: 0, y: 64, z: 0 }, job: null });
    const queries = { n: 0, cap: CAPS.sessions };
    const factory: QueryFactory = (params) =>
      sdkQueryFactory({
        ...params,
        prompt: capped(params.prompt, queries),
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
      playerName: () => 'Jordan',
      log: pino({ level: env.MINEVIBE_LOG_LEVEL ?? 'warn' }),
      queryFactory: factory,
      chatDebounceMs: 0,
      autonomyTickMs: 0,
    });
    const turns: { session: string; model: string | null; tools: string[]; ms: number; costUsd: number }[] =
      [];
    const results: SDKResultMessage[] = [];
    let tools: string[] = [];
    let start = Date.now();
    manager.on('tool', (o: ToolObservation) => {
      tools.push(
        `${o.session}:${o.toolName.replace(/^mcp__/, '')}:${o.behavior}${o.code ? `(${o.code})` : ''}`,
      );
    });
    manager.on('turn', ({ result, model, session }) => {
      results.push(result);
      turns.push({ session, model, tools, ms: Date.now() - start, costUsd: result.total_cost_usd });
      tools = [];
      start = Date.now();
    });
    const waitFor = async (pred: () => boolean, what: string, ms = 240_000) => {
      const t0 = Date.now();
      while (!pred()) {
        if (Date.now() - t0 > ms) throw new Error(`timed out: ${what}`);
        await sleep(50);
      }
    };
    let agentId = '';
    const brain = () => manager.brain(agentId);
    let bodyId = '';
    let deskId = '';
    let titles: Record<string, Record<string, number> | null> = {};
    try {
      await manager.openWorld({ worldId: 'live-sessions', gen: 1 });
      agentId = manager.listAgents()[0]?.agentId ?? '';
      // 1. The welcome turn, in the body session.
      await waitFor(() => results.length >= 1, 'welcome');
      await waitFor(() => brain()?.status === 'idle', 'welcome settled', 60_000);
      bodyId = brain()?.record.sessionId ?? '';
      // 2. A body turn sits at the PC; 3. the desk session takes over with its KICKOFF and stands up.
      skills.onSeat = (req, jobId) => {
        manager.onPcSeat({ pcId: 'linux-1', occupant: { kind: 'agent', agentId }, seatEpoch: req.seatEpoch });
        skills.finish(jobId, { status: 'done' });
      };
      await manager.deliverChat({
        to: 'all',
        text: '@ada call mcp__mc__sit_at_pc with pc "linux-1" and purpose "session check: call mcp__pc__bash with command echo desk-ok, then mcp__mc__stand_up, then reply done". When it says Seated, end your turn and reply: sitting',
      });
      await waitFor(() => results.length >= 3, 'sit + desk turn');
      deskId = brain()?.record.desks?.['linux-1']?.sessionId ?? '';
      // 4. The body wakes with the DESK REPORT.
      await waitFor(() => results.length >= 4, 'report turn');
      await waitFor(() => brain()?.status === 'idle', 'settled', 60_000);
      expect(turns.map((t) => t.session)).toEqual(['body', 'body', 'desk', 'body']);
      expect(turns[0]?.model).toBe('claude-haiku-5-5');
      expect(turns[2]?.model).toBe('claude-opus-5-5');
      expect(turns[3]?.model).toBe('claude-haiku-5-5');
      expect(turns[2]?.tools).toContain('desk:pc__bash:allow');
      expect(turns[2]?.tools).toContain('desk:mc__stand_up:allow');
      expect(brain()?.activeSession).toBe('body');
      expect(queries.n).toBeLessThanOrEqual(CAPS.sessions);
    } finally {
      await manager.shutdown();
      manager.dispose();
      await sleep(500);
      titles = { body: transcriptTypes(bodyId), desk: transcriptTypes(deskId) };
      const summary = {
        at: new Date().toISOString(),
        claude: { source: claude.source, version: claude.version },
        turns,
        modelTurns: results.length,
        queryMessages: queries.n,
        transcriptEntryTypes: titles,
        usage: manager.governor.state,
      };
      mkdirSync(OUT, { recursive: true });
      writeFileSync(join(OUT, 'sessions-live-dual.json'), `${JSON.stringify(summary, null, 2)}\n`);
      console.log(JSON.stringify(summary, null, 2));
      for (const id of [bodyId, deskId]) {
        const d = id ? transcriptDir(id) : null;
        if (d) rmSync(d, { recursive: true, force: true });
      }
    }
    // A titled session never generates an AI title: only its custom title is (re)written.
    expect(titles.body?.['ai-title'] ?? 0).toBe(0);
    expect(titles.desk?.['ai-title'] ?? 0).toBe(0);
    expect(titles.body?.['custom-title'] ?? 0).toBeGreaterThan(0);
  });

  it('part 2, baseline: a persisted session without a title writes ai-title entries (1 turn)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mv-live-title-'));
    dirs.push(dir);
    const env = process.env;
    const claude = await resolveClaudeBinary({
      env,
      versionEnv: agentEnv({ version: SERVER_VERSION, source: env }),
      allowBundled: true,
    });
    const sessionId = randomUUID();
    const queries = { n: 0, cap: CAPS.baseline };
    const options = buildSessionOptions({
      kind: 'body',
      claude,
      env: agentEnv({ version: SERVER_VERSION, source: env }),
      cwd: dir,
      resume: null,
      sessionId,
      persona: 'Reply with one short sentence.',
      mc: createSdkMcpServer({ name: 'mc', tools: [] }),
    });
    expect(options.title).toBeUndefined();
    let push: ((m: SDKUserMessage) => void) | null = null;
    let done = false;
    const inbox: AsyncIterable<SDKUserMessage> = {
      [Symbol.asyncIterator]: () => ({
        next: () =>
          done
            ? Promise.resolve({ value: undefined, done: true as const })
            : new Promise((resolve) => {
                push = (m) => resolve({ value: m, done: false });
              }),
        return: async () => ({ value: undefined, done: true as const }),
      }),
    };
    const q = sdkQueryFactory({
      prompt: capped(inbox, queries),
      options: { ...options, maxTurns: 2, maxBudgetUsd: 0.5 },
    });
    let result: SDKResultMessage | null = null;
    const pump = (async () => {
      for await (const m of q) if (m.type === 'result') result = m as SDKResultMessage;
    })();
    try {
      while (!push) await sleep(10);
      (push as (m: SDKUserMessage) => void)({
        type: 'user',
        message: { role: 'user', content: 'Name one tree that grows in a Minecraft forest biome.' },
        parent_tool_use_id: null,
      } as SDKUserMessage);
      const t0 = Date.now();
      while (!result && Date.now() - t0 < 120_000) await sleep(50);
      // The title is generated in the background: give it a moment to land.
      await sleep(5_000);
    } finally {
      done = true;
      q.close();
      await pump.catch(() => {});
      const types = transcriptTypes(sessionId);
      mkdirSync(OUT, { recursive: true });
      writeFileSync(
        join(OUT, 'sessions-live-baseline.json'),
        `${JSON.stringify({ at: new Date().toISOString(), transcriptEntryTypes: types }, null, 2)}\n`,
      );
      console.log(JSON.stringify({ baseline: types }, null, 2));
      const d = transcriptDir(sessionId);
      if (d) rmSync(d, { recursive: true, force: true });
      expect(queries.n).toBeLessThanOrEqual(CAPS.baseline);
      expect(types?.['ai-title'] ?? 0).toBeGreaterThan(0);
    }
  });
});
