#!/usr/bin/env node
/**
 * MineVibe live acceptance scenario (docs/design/ACCEPTANCE.md; PLAN §13.7 item 7).
 *
 * Runs `npm run play` in this process (orchestrator/play.ts, the same code path as the CLI) from a temporary
 * MINEVIBE_HOME with MINEVIBE_E2E=1 and MINEVIBE_CLAUDE=bundled, the real Apple `container` engine for linux-1 and a
 * real Claude subscription, then drives the game through the bridge: the mod's `debug.*` requests (state, chat lines
 * typed as the player, UI requests such as `agent.cmd` and `calendar.put`, kill_player, click_begin), `obs.query` for
 * inventories, and the runtime's own events (turns with their model, tool calls with model and effort, swaps).
 *
 * Steps (each records PASS/FAIL and numbers):
 *   1 cold boot   2 CEO at the door   3 logs + crafting table   4 ask flow   5 PC flow + swaps   6 kick
 *   7 Codex + calendar   8 hardcore death -> World #2   9 quit: no orphans
 *
 * Usage (repo root, after `npm install` and `cd apps/mod && ./gradlew build`):
 *   node --conditions=source --import tsx scripts/e2e/run-scenario.ts [options]
 *     --crew agents|scripted   agents (default) spends subscription quota; scripted is zero-token (steps 1, 8, 9
 *                              plus a chat/UI smoke test and a tree check for --seed)
 *     --steps 1,2,3            run only these steps (9 always runs last)
 *     --seed <seed>            MINEVIBE_WORLD_SEED for repeatable terrain
 *     --max-turns <n>          stop prompting the crew after n agent turns (default 40)
 *
 * Output: scripts/e2e/out/<run>/ (result.json, summary.md, events.jsonl, samples.jsonl, server.log, screenshots,
 * the game's console log). The temporary home is removed at the end unless --keep-home.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pino } from 'pino';
import { REDACT_PATHS } from '../../apps/server/src/log.js';
import { type PlayControl, play } from '../../apps/server/src/orchestrator/play.js';
import type { Runtime } from '../../apps/server/src/orchestrator/runtime.js';

type Json = Record<string, unknown>;
type Status = 'PASS' | 'FAIL' | 'SKIP';
interface StepResult {
  step: number;
  name: string;
  status: Status;
  ms: number;
  numbers: Json;
  notes: string[];
}
interface Pos {
  x: number;
  y: number;
  z: number;
}
interface DebugAgent {
  agentId: string;
  handle: string;
  brain: string;
  headIcon: string;
  bubble: string | null;
  cards: number;
  pos: Pos | null;
  atPc: boolean;
}
interface DebugMonitor {
  pcId: string;
  seq: number;
  patches: number;
  ageMs: number | null;
  hash: string | null;
  w: number;
  h: number;
}
interface DebugState {
  screen: string | null;
  worldId: string | null;
  gen: number | null;
  inWorld: boolean;
  hardcore: boolean | null;
  difficulty: string | null;
  gameMode: string | null;
  paused: boolean;
  hp: number | null;
  dead: boolean | null;
  pid: number;
  player?: Pos | null;
  agents?: DebugAgent[];
  monitors?: DebugMonitor[];
}
interface Slot {
  kind: string;
  pos: Pos;
  pcId?: string;
}
interface Ev {
  at: number;
  dir: 'out' | 'in' | 'reply' | 'ev';
  t: string;
  p: Json;
}
interface TurnRec {
  at: number;
  agentId: string;
  sessionModel: string | null;
  usageModels: string[];
  subtype: string;
  numTurns: number | null;
  durationMs: number | null;
  costUsd: number | null;
}
interface ToolRec {
  at: number;
  agentId: string;
  toolName: string;
  behavior: string;
  effort: unknown;
  model: string | null;
}
/** The PC module's parts the harness reads (PcModuleImpl). */
interface PcModuleLike {
  manager: {
    status(id: string): { status: string; detail?: string };
    list(): Array<{ id: string }>;
    containerNameOf(id: string): string;
    on(event: 'pc.status', fn: (id: string, info: { status: string }) => void): unknown;
    driver: {
      exec(
        name: string,
        argv: readonly string[],
        o?: { user?: string; timeoutMs?: number },
      ): Promise<{ code: number | null; stdout: string; stderr: string }>;
    };
  };
}
interface ManagerLike {
  on(event: string, fn: (payload: Json) => void): unknown;
  crewState(): {
    crew: Array<{ agentId: string; handle: string; name: string; ceo: boolean; status: string }>;
  };
  brain(agentId: string): { status: string; model: string } | undefined;
}

// ---------------------------------------------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..', '..');
const argv = process.argv.slice(2);
function arg(name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}
const crewMode = arg('crew') === 'scripted' ? 'scripted' : 'agents';
const onlySteps = arg('steps')
  ?.split(',')
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isInteger(n));
const wants = (n: number) => !onlySteps || onlySteps.includes(n) || n === 9;
const seed = arg('seed');
const maxTurns = Number(arg('max-turns') ?? 40);
const keepHome = argv.includes('--keep-home');

const T0 = Date.now();
const runTag = `e2e-${new Date(T0).toISOString().replace(/[:.]/g, '-')}`;
const outDir = join(here, 'out', runTag);
mkdirSync(outDir, { recursive: true });
const harnessLog = createWriteStream(join(outDir, 'harness.log'));
const rel = (at = Date.now()) => `${((at - T0) / 1000).toFixed(1)}s`;
function say(msg: string): void {
  const line = `[e2e ${rel()}] ${msg}`;
  process.stdout.write(`${line}\n`);
  harnessLog.write(`${line}\n`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const dist = (a: Pos | null | undefined, b: Pos | null | undefined) =>
  a && b ? Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) : Number.POSITIVE_INFINITY;
const round = (n: number, d = 1) => Math.round(n * 10 ** d) / 10 ** d;

// ---------------------------------------------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------------------------------------------

const events: Ev[] = [];
const eventsOut = createWriteStream(join(outDir, 'events.jsonl'));
const samplesOut = createWriteStream(join(outDir, 'samples.jsonl'));
function record(dir: Ev['dir'], t: string, p: Json): Ev {
  const e: Ev = { at: Date.now(), dir, t, p };
  events.push(e);
  eventsOut.write(`${JSON.stringify({ rel: rel(e.at), dir, t, ...p })}\n`);
  return e;
}
const turns: TurnRec[] = [];
const tools: ToolRec[] = [];
const offices = new Map<string, Slot[]>();
const shownScreens: string[] = [];
let lastState: DebugState | null = null;
let lastSig = '';
/** Per agent: head icons and bubble texts seen by the client, with times. */
const iconsSeen: Array<{ at: number; agentId: string; icon: string }> = [];
const bubblesSeen: Array<{ at: number; agentId: string; text: string }> = [];
const monitorSeen: Array<{ at: number; pcId: string; hash: string | null; seq: number; patches: number }> =
  [];

function sampleState(raw: DebugState): void {
  // Nested nulls may arrive as absent keys (the mod's reply encoder drops them): normalize to null.
  const s: DebugState = {
    ...raw,
    player: raw.player ?? null,
    agents: (raw.agents ?? []).map((a) => ({ ...a, bubble: a.bubble ?? null, pos: a.pos ?? null })),
    monitors: (raw.monitors ?? []).map((m) => ({ ...m, hash: m.hash ?? null, ageMs: m.ageMs ?? null })),
  };
  lastState = s;
  const sig = JSON.stringify({
    screen: s.screen,
    world: s.worldId,
    agents: (s.agents ?? []).map((a) => [a.agentId, a.headIcon, a.bubble, a.atPc, a.cards, a.brain]),
    monitors: (s.monitors ?? []).map((m) => [m.pcId, m.hash]),
  });
  const now = Date.now();
  for (const a of s.agents ?? []) {
    const lastIcon = [...iconsSeen].reverse().find((i) => i.agentId === a.agentId);
    if (lastIcon?.icon !== a.headIcon) iconsSeen.push({ at: now, agentId: a.agentId, icon: a.headIcon });
    if (a.bubble) {
      const lastBubble = [...bubblesSeen].reverse().find((b) => b.agentId === a.agentId);
      if (lastBubble?.text !== a.bubble) bubblesSeen.push({ at: now, agentId: a.agentId, text: a.bubble });
    }
  }
  for (const m of s.monitors ?? []) {
    const last = [...monitorSeen].reverse().find((x) => x.pcId === m.pcId);
    if (last?.hash !== m.hash)
      monitorSeen.push({ at: now, pcId: m.pcId, hash: m.hash, seq: m.seq, patches: m.patches });
  }
  if (sig !== lastSig) {
    lastSig = sig;
    samplesOut.write(`${JSON.stringify({ rel: rel(now), ...s })}\n`);
  }
}

/** The game window of `pid`: its CGWindow number and whether macOS shows it (a hidden one draws at most 1 fps). */
function gameWindow(pid: number): { id: string; onscreen: boolean } | null {
  const out = spawnSync('osascript', ['-l', 'JavaScript', join(here, 'window-id.js'), String(pid)], {
    encoding: 'utf8',
    timeout: 15_000,
  }).stdout?.trim();
  const [id, state] = (out ?? '').split(' ');
  return id ? { id, onscreen: state === 'onscreen' } : null;
}

function screenshot(name: string): string | null {
  // The game window only (never the desktop): its CGWindow number by the JVM's pid.
  const pid = lastState?.pid;
  if (!pid) return null;
  const id = gameWindow(pid)?.id;
  if (!id) return null;
  const file = join(outDir, `${name}.png`);
  const r = spawnSync('screencapture', ['-x', '-o', '-l', id, '-t', 'png', file], { timeout: 15_000 });
  if (r.status !== 0) return null;
  say(`screenshot ${name}.png`);
  return `${name}.png`;
}

/**
 * The CEO is plan-first, so sitting at a PC starts in plan mode and its ExitPlanMode becomes a plan card: the harness
 * approves it as the player would (the card's Approve, `plan.decision`), through the mod's UI transport.
 */
function approvePlans(p: Json): void {
  if (!autoApprovePlans || !rt?.debug) return;
  for (const card of (p.cards as Json[] | undefined) ?? []) {
    const id = String(card.id);
    if (card.kind !== 'plan' || approvedPlans.has(id)) continue;
    approvedPlans.add(id);
    const agentId = String(p.agentId);
    setTimeout(() => {
      say(`approving plan card ${id} of ${agentId}: ${String(card.plan).replace(/\s+/g, ' ').slice(0, 120)}`);
      rt?.debug
        ?.uiRequest('plan.decision', { agentId, pendingId: id, decision: 'approve' })
        .then((r) => record('ev', 'plan.approved', { agentId, pendingId: id, reply: r }))
        .catch((err: Error) => say(`plan approval failed: ${err.message}`));
    }, 1500);
  }
}

/** Instruments the runtime: every message both ways, the crew's turns, tools, says and brains. */
function instrument(rt: Runtime): void {
  const bridge = rt.bridge as unknown as {
    send: (t: string, p: Json, ids?: Json) => boolean;
    request: (t: string, p: Json, o?: Json) => Promise<Json>;
    on: (e: string, fn: (m: Json) => void) => unknown;
  };
  const quietOut = new Set(['pc.cursor']);
  const origSend = bridge.send.bind(bridge);
  bridge.send = (t, p, ids) => {
    if (!quietOut.has(t)) record('out', t, p);
    if (t === 'agent.pending') approvePlans(p);
    return origSend(t, p, ids);
  };
  const origRequest = bridge.request.bind(bridge);
  bridge.request = (t, p, o) => {
    const quiet = t === 'debug.state';
    if (!quiet) record('out', t, p);
    const pr = origRequest(t, p, o);
    if (!quiet) {
      pr.then(
        (r) => {
          if (t === 'skill.run' && typeof r.jobId === 'string' && r.status === 'running')
            runningJobs.add(r.jobId);
          record('reply', t, { request: p, reply: r });
        },
        (err: { code?: string; message?: string }) =>
          record('reply', t, { request: p, error: err?.code ?? 'ERR', msg: err?.message }),
      );
    }
    return pr;
  };
  bridge.on('message', (m) => {
    const t = String(m.t);
    if (t === 'skill.result' && typeof m.jobId === 'string') runningJobs.delete(m.jobId);
    if (t === 'agent.state' || t === 'pc.frame.ack') return;
    if (t === 'world.state') {
      const office = m.office as { slots?: Slot[] } | undefined;
      if (office?.slots) offices.set(String(m.worldId), office.slots);
      if (m.clockTime !== undefined && !office && m.phase === 'ready') return;
    }
    record('in', t, m);
  });
  const mgr = rt.agents?.manager as unknown as ManagerLike | undefined;
  if (mgr) {
    mgr.on('turn', (e) => {
      const result = (e.result ?? {}) as Json;
      const usage = (result.modelUsage ?? {}) as Json;
      const rec: TurnRec = {
        at: Date.now(),
        agentId: String(e.agentId),
        sessionModel: (e.model as string | null) ?? null,
        usageModels: Object.keys(usage),
        subtype: String(result.subtype ?? ''),
        numTurns: typeof result.num_turns === 'number' ? result.num_turns : null,
        durationMs: typeof result.duration_ms === 'number' ? result.duration_ms : null,
        costUsd: typeof result.total_cost_usd === 'number' ? round(result.total_cost_usd, 4) : null,
      };
      turns.push(rec);
      record('ev', 'turn', rec as unknown as Json);
      say(
        `turn #${turns.length} ${rec.agentId}: ${rec.subtype}, ${rec.usageModels.join('+') || rec.sessionModel}, ${rec.durationMs ?? '?'} ms`,
      );
    });
    mgr.on('tool', (e) => {
      const rec: ToolRec = {
        at: Date.now(),
        agentId: String(e.agentId),
        toolName: String(e.toolName),
        behavior: String(e.behavior),
        effort: e.effort,
        model: (e.model as string | null) ?? null,
      };
      tools.push(rec);
      record('ev', 'tool', rec as unknown as Json);
      say(`tool ${rec.toolName} (${rec.behavior}) on ${rec.model}/${String(rec.effort)}`);
    });
    for (const name of ['say', 'brain', 'card', 'toast', 'chat']) {
      mgr.on(name, (e) => {
        record('ev', name, e);
        if (name === 'say' && typeof e.text === 'string')
          say(`say ${String(e.agentId)}: ${e.text.slice(0, 160)}`);
        if (name === 'toast') say(`toast: ${String(e.text)}`);
      });
    }
  }
  const pcm = (rt.pcModule as unknown as Partial<PcModuleLike>).manager;
  pcm?.on('pc.status', (id, info) => {
    record('ev', 'pc.status', { id, ...info });
    say(`pc ${id}: ${info.status}`);
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Helpers over the runtime
// ---------------------------------------------------------------------------------------------------------------

let rt: Runtime | null = null;
/** Ctrl+C on the harness: the session is stopping (as `npm run play` on Ctrl+C); step 9 still checks the teardown. */
let stopRequested = false;
/** Jobs the mod runs for the crew (skill.run replied `running`, no skill.result yet). */
const runningJobs = new Set<string>();
/** Plan cards the harness approved as the player would (Alt+1 on the plan card). */
const approvedPlans = new Set<string>();
const autoApprovePlans = true;
let playExit: { code: number | null; at: number } | null = null;

class Timeout extends Error {}
async function waitFor<T>(
  label: string,
  timeoutMs: number,
  fn: () => T | null | undefined | false | Promise<T | null | undefined | false>,
  everyMs = 250,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown = null;
  while (Date.now() < deadline) {
    if (playExit || stopRequested) throw new Error(`the game session ended while waiting for ${label}`);
    try {
      const v = await fn();
      if (v) return v as T;
    } catch (err) {
      lastErr = err;
    }
    await sleep(everyMs);
  }
  throw new Timeout(
    `timed out after ${timeoutMs} ms waiting for ${label}${lastErr ? ` (last error: ${String((lastErr as Error).message ?? lastErr)})` : ''}`,
  );
}

function runtime(): Runtime {
  if (!rt) throw new Error('no runtime');
  return rt;
}
function debug() {
  const d = runtime().debug;
  if (!d) throw new Error('E2E debug helpers are off');
  return d;
}
function manager(): ManagerLike {
  const m = runtime().agents?.manager as unknown as ManagerLike | undefined;
  if (!m) throw new Error('no agent runtime');
  return m;
}
function pcs(): PcModuleLike['manager'] {
  const m = (runtime().pcModule as unknown as Partial<PcModuleLike>).manager;
  if (!m) throw new Error('no PC module');
  return m;
}
function ceo(): { agentId: string; handle: string; name: string } | null {
  const m = runtime().agents?.manager as unknown as ManagerLike | undefined;
  if (m) return m.crewState().crew.find((c) => c.ceo && c.status === 'alive') ?? null;
  const s = runtime().scriptedCrew as unknown as {
    listAgents(): Array<{ agentId: string; handle: string; name: string; ceo: boolean }>;
  } | null;
  return s?.listAgents().find((a) => a.ceo) ?? null;
}
function agentOnClient(agentId: string): DebugAgent | null {
  return lastState?.agents?.find((a) => a.agentId === agentId) ?? null;
}
function monitor(pcId: string): DebugMonitor | null {
  return lastState?.monitors?.find((m) => m.pcId === pcId) ?? null;
}
async function chat(text: string): Promise<{ sent: boolean; hint: string | null }> {
  say(`chat> ${text}`);
  const r = await debug().chat(text);
  record('ev', 'player.chat', { text, ...r });
  if (!r.sent) say(`chat refused locally: ${r.hint}`);
  return r;
}
async function inventory(agentId: string): Promise<Array<{ item: string; count: number }>> {
  const reply = (await runtime().bridge.request('obs.query', {
    agentId,
    query: 'inventory',
    args: {},
  })) as Json;
  const slots = ((reply.result as Json | undefined)?.slots ?? []) as Array<{ item: string; count: number }>;
  return slots;
}
function countItem(slots: Array<{ item: string; count: number }>, id: string): number {
  return slots.filter((s) => s.item === id || s.item === `minecraft:${id}`).reduce((n, s) => n + s.count, 0);
}
async function find(agentId: string, what: string, radius = 64): Promise<Json> {
  const reply = (await runtime().bridge.request('obs.query', {
    agentId,
    query: 'find',
    args: { what, radius, limit: 3 },
  })) as Json;
  return (reply.result ?? {}) as Json;
}
function turnsLeft(): number {
  return maxTurns - turns.length;
}
function turnsSince(at: number, agentId?: string): TurnRec[] {
  return turns.filter((t) => t.at >= at && (!agentId || t.agentId === agentId));
}
function toolsSince(at: number, agentId?: string): ToolRec[] {
  return tools.filter((t) => t.at >= at && (!agentId || t.agentId === agentId));
}
/** The agent's own transcript lines (`chat.append` kind agent) since `at`: the full text of what it said. */
function linesSince(at: number, agentId: string): string[] {
  return events
    .filter((e) => e.dir === 'ev' && e.t === 'chat' && e.at >= at && e.p.agentId === agentId)
    .map((e) => e.p.entry as Json | undefined)
    .filter((entry) => entry?.kind === 'agent' && typeof entry.text === 'string')
    .map((entry) => String(entry?.text));
}
function saysSince(at: number, agentId: string): string[] {
  return events
    .filter(
      (e) =>
        e.dir === 'ev' &&
        e.t === 'say' &&
        e.at >= at &&
        e.p.agentId === agentId &&
        typeof e.p.text === 'string',
    )
    .map((e) => String(e.p.text));
}
/** Waits until the agent's brain is idle with no turn started for `quietMs`, after at least one turn since `at`. */
async function waitSettled(agentId: string, at: number, timeoutMs: number, quietMs = 8_000): Promise<void> {
  await waitFor(
    `${agentId} to finish`,
    timeoutMs,
    () => {
      const b = manager().brain(agentId);
      const mine = turnsSince(at, agentId);
      const lastTurn = mine.at(-1);
      return (
        mine.length > 0 &&
        b?.status === 'idle' &&
        runningJobs.size === 0 &&
        lastTurn !== undefined &&
        Date.now() - lastTurn.at > quietMs
      );
    },
    500,
  );
}
async function guest(pcId: string, script: string): Promise<{ code: number | null; out: string }> {
  const m = pcs();
  const r = await m.driver.exec(m.containerNameOf(pcId), ['sh', '-c', script], { timeoutMs: 20_000 });
  return { code: r.code, out: `${r.stdout}${r.stderr}`.trim() };
}
function office(worldId: string | null | undefined): Slot[] {
  return (worldId && offices.get(worldId)) || [];
}

// ---------------------------------------------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------------------------------------------

const results: StepResult[] = [];
async function step(n: number, name: string, fn: (r: StepResult) => Promise<void>): Promise<void> {
  const r: StepResult = { step: n, name, status: 'PASS', ms: 0, numbers: {}, notes: [] };
  if (!wants(n)) {
    r.status = 'SKIP';
    r.notes.push('not selected');
    results.push(r);
    return;
  }
  const start = Date.now();
  say(`=== step ${n}: ${name}`);
  try {
    await fn(r);
  } catch (err) {
    r.status = 'FAIL';
    r.notes.push(`error: ${(err as Error).message ?? String(err)}`);
  }
  r.ms = Date.now() - start;
  results.push(r);
  say(`=== step ${n}: ${r.status} (${(r.ms / 1000).toFixed(1)} s) ${JSON.stringify(r.numbers)}`);
  for (const note of r.notes) say(`    ${note}`);
  writeResults();
}
function check(r: StepResult, ok: boolean, what: string): boolean {
  if (!ok) {
    r.status = 'FAIL';
    r.notes.push(`FAIL: ${what}`);
  } else {
    r.notes.push(`ok: ${what}`);
  }
  return ok;
}
function needTurns(r: StepResult, n: number): boolean {
  if (crewMode !== 'agents') {
    r.status = 'SKIP';
    r.notes.push('needs --crew agents');
    return false;
  }
  if (turnsLeft() < n) {
    r.status = 'SKIP';
    r.notes.push(`turn budget: ${turns.length}/${maxTurns} used, this step needs about ${n}`);
    return false;
  }
  return true;
}

let firstWorld: string | null = null;

async function step1(r: StepResult): Promise<void> {
  let lastWindowLog = 0;
  const ready = await waitFor(
    'world ready with an office',
    8 * 60_000,
    () => {
      if (Date.now() - lastWindowLog > 30_000) {
        lastWindowLog = Date.now();
        const jvm = descendants(process.pid).find((p) => /java/.test(p.cmd));
        const w = jvm ? gameWindow(jvm.pid) : null;
        r.notes.push(`${rel()}: game window ${w ? (w.onscreen ? 'on screen' : 'hidden') : 'not open yet'}`);
      }
      const e = events.find(
        (x) =>
          x.dir === 'in' &&
          x.t === 'world.state' &&
          x.p.phase === 'ready' &&
          offices.has(String(x.p.worldId)),
      );
      return e ?? null;
    },
    250,
  );
  firstWorld = String(ready.p.worldId);
  const connected = events.find((x) => x.dir === 'in' && x.t === 'hello');
  r.numbers.helloMs = connected ? connected.at - T0 : null;
  r.numbers.worldReadyMs = ready.at - T0;
  const s = await waitFor('debug.state in world', 60_000, async () => {
    const st = (await debug().state(3000)) as DebugState;
    sampleState(st);
    return st.inWorld && st.screen === null ? st : null;
  });
  r.numbers.worldId = s.worldId;
  check(
    r,
    s.hardcore === true && s.difficulty === 'hard' && s.gameMode === 'survival',
    `hardcore HARD survival (${s.hardcore}, ${s.difficulty}, ${s.gameMode})`,
  );

  // The screen log: BootScreen straight into the world, never the title screen.
  const consoleLog = join(runtime().paths.logs, 'minecraft-console.log');
  const lines = existsSync(consoleLog) ? readFileSync(consoleLog, 'utf8').split('\n') : [];
  for (const line of lines) {
    const m = /\[screen\] ([\w$]+)(?: \(requested ([\w$]+)\))?/.exec(line);
    if (m?.[1]) shownScreens.push(m[2] ? `${m[1]}<-${m[2]}` : m[1]);
  }
  r.numbers.screens = shownScreens.slice(0, 12);
  check(
    r,
    lines.length > 0 && !shownScreens.some((x) => x.split('<-')[0] === 'TitleScreen'),
    'no TitleScreen shown',
  );

  const slots = office(firstWorld);
  const ws = slots.find((x) => x.kind === 'workstation' && x.pcId === 'linux-1');
  r.numbers.officeSlots = slots.length;
  check(
    r,
    ws !== undefined,
    `starter office has a workstation bound to linux-1 (${slots
      .filter((x) => x.kind === 'workstation')
      .map((x) => x.pcId ?? '-')
      .join(',')})`,
  );

  const running = await waitFor(
    'linux-1 running',
    15 * 60_000,
    () => pcs().status('linux-1').status === 'running',
    1000,
  ).catch((err: Error) => {
    r.notes.push(err.message);
    return false;
  });
  const runEv = events.find((e) => e.t === 'pc.status' && e.p.id === 'linux-1' && e.p.status === 'running');
  r.numbers.linux1RunningMs = runEv ? runEv.at - T0 : null;
  const cleaned = cleanLeaked();
  if (cleaned.length > 0)
    r.notes.push(`harness: removed ${cleaned.length} leftovers of earlier runs from the dev engine`);
  check(r, running === true, `linux-1 status running (${pcs().status('linux-1').status})`);

  const frames = await waitFor(
    'linux-1 frames on the client',
    3 * 60_000,
    () => {
      const seen = monitorSeen.filter((x) => x.pcId === 'linux-1' && x.hash !== null);
      return seen.length >= 1 && (monitor('linux-1')?.patches ?? 0) > 0 ? monitor('linux-1') : null;
    },
    500,
  ).catch((err: Error) => {
    r.notes.push(err.message);
    return null;
  });
  const firstFrame = monitorSeen.find((x) => x.pcId === 'linux-1' && x.hash !== null);
  r.numbers.firstFrameMs = firstFrame ? firstFrame.at - T0 : null;
  r.numbers.frame = frames ? `${frames.w}x${frames.h}, seq ${frames.seq}, ${frames.patches} patches` : null;
  check(r, frames !== null, 'the linux-1 monitor receives frames');
  screenshot('step1-boot');
}

async function step2(r: StepResult): Promise<void> {
  const boss = await waitFor('the CEO', 90_000, () => ceo(), 500);
  r.numbers.ceo = `${boss.name} (${boss.agentId})`;
  const spawn = events.find(
    (e) => e.dir === 'reply' && e.t === 'agent.spawn' && (e.p.request as Json)?.agentId === boss.agentId,
  );
  const spawnReq = (spawn?.p.request ?? {}) as Json;
  const spawnPos = ((spawn?.p.reply as Json | undefined)?.pos ?? null) as Pos | null;
  const door = office(firstWorld).find((x) => x.kind === 'door')?.pos ?? null;
  r.numbers.spawnPos = spawnPos ? `${round(spawnPos.x)},${round(spawnPos.y)},${round(spawnPos.z)}` : null;
  r.numbers.door = door ? `${door.x},${door.y},${door.z}` : null;
  r.numbers.spawnToDoor = round(
    dist(spawnPos, door ? { x: door.x + 0.5, y: door.y, z: door.z + 0.5 } : null),
    2,
  );
  check(
    r,
    // The scripted crew spawns next to the player (no `at`); the agent runtime passes the office door.
    (crewMode === 'scripted' || Boolean(spawnReq.at)) && Number(r.numbers.spawnToDoor) <= 3,
    `spawned at the office door (at=${JSON.stringify(spawnReq.at ?? null)})`,
  );
  check(r, spawnReq.mode === 'follow', `idle mode follow (${String(spawnReq.mode)})`);
  const near = await waitFor(
    'the CEO near the player',
    90_000,
    () => {
      const a = agentOnClient(boss.agentId);
      const d = dist(a?.pos, lastState?.player);
      return d <= 4.5 ? d : null;
    },
    500,
  ).catch(() => null);
  const dNow = dist(agentOnClient(boss.agentId)?.pos, lastState?.player);
  r.numbers.followDistance = round(near ?? dNow, 2);
  check(r, near !== null, `follows the player (distance ${round(near ?? dNow, 2)} blocks)`);
  if (crewMode === 'agents') {
    await waitFor('the welcome turn', 180_000, () => turnsSince(T0, boss.agentId).length > 0, 500).catch(
      (e: Error) => r.notes.push(e.message),
    );
    await sleep(1500);
  }
  const icons = [...new Set(iconsSeen.filter((i) => i.agentId === boss.agentId).map((i) => i.icon))];
  const bubbles = bubblesSeen.filter((b) => b.agentId === boss.agentId).map((b) => b.text.slice(0, 80));
  r.numbers.headIcons = icons;
  r.numbers.bubbles = bubbles.slice(0, 4);
  check(r, bubbles.length > 0, 'a bubble over the CEO on the client');
  if (crewMode === 'agents') check(r, icons.includes('THINKING'), 'the THINKING head icon during its turn');
  screenshot('step2-ceo');
}

async function step3(r: StepResult): Promise<void> {
  if (!needTurns(r, 6)) return;
  const boss = ceo();
  if (!boss) throw new Error('no CEO');
  const at = Date.now();
  const sent = await chat('@ceo collect 10 oak logs and make a crafting table');
  check(r, sent.sent, 'chat line sent');
  let inv: Array<{ item: string; count: number }> = [];
  let tableNearby = false;
  await waitFor(
    'oak logs and a crafting table',
    10 * 60_000,
    async () => {
      if (turnsLeft() <= 0) return 'budget';
      if (turnsSince(at, boss.agentId).length === 0) return false;
      inv = await inventory(boss.agentId);
      const settled = manager().brain(boss.agentId)?.status === 'idle' && runningJobs.size === 0;
      if (countItem(inv, 'crafting_table') > 0 && settled) return true;
      if (settled && Date.now() - (turnsSince(at, boss.agentId).at(-1)?.at ?? at) > 30_000) {
        const found = await find(boss.agentId, 'minecraft:crafting_table', 8);
        tableNearby = JSON.stringify(found).includes('crafting_table');
        return true;
      }
      return false;
    },
    5_000,
  );
  const logs = countItem(inv, 'oak_log');
  const planks = countItem(inv, 'oak_planks');
  const table = countItem(inv, 'crafting_table');
  r.numbers.inventory = {
    oak_log: logs,
    oak_planks: planks,
    crafting_table: table,
    placedTableNearby: tableNearby,
  };
  const myTurns = turnsSince(at, boss.agentId);
  const myTools = toolsSince(at, boss.agentId);
  r.numbers.turns = myTurns.length;
  // A turn's model is its assistant messages' message.model (the session model at the turn's end); modelUsage and
  // total_cost_usd are cumulative over the session, so they only show what was used so far.
  r.numbers.turnModels = [...new Set(myTurns.map((t) => t.sessionModel ?? '?'))];
  r.numbers.toolModels = [...new Set(myTools.map((t) => `${t.model}/${String(t.effort)}`))];
  r.numbers.tools = myTools.map((t) => t.toolName.replace('mcp__mc__', '')).slice(0, 20);
  r.numbers.sessionCostUsd = myTurns.at(-1)?.costUsd ?? null;
  check(
    r,
    logs + planks / 4 + table >= 9,
    `about 10 oak logs collected (logs ${logs}, planks ${planks}, table ${table})`,
  );
  // The office already has a crafting table, so "nearby" proves nothing: a craft job for one must have finished.
  const crafted = events.some(
    (e) =>
      e.at >= at &&
      ((e.dir === 'reply' &&
        e.t === 'skill.run' &&
        (e.p.request as Json)?.skill === 'craft' &&
        /crafting_table/.test(JSON.stringify((e.p.request as Json)?.args)) &&
        (e.p.reply as Json)?.status === 'done') ||
        (e.dir === 'in' &&
          e.t === 'skill.result' &&
          e.p.status === 'done' &&
          /crafting_table/.test(JSON.stringify(e.p.result)))),
  );
  r.numbers.craftedTable = crafted;
  r.numbers.otherLogs = inv
    .filter((x) => /_log$/.test(x.item) && !/oak_log$/.test(x.item))
    .map((x) => `${x.item} ${x.count}`);
  check(r, table >= 1 || crafted, `a crafting table made (inventory ${table}, craft job done ${crafted})`);
  check(
    r,
    myTurns.length > 0 && myTurns.every((t) => String(t.sessionModel).includes('haiku')),
    'every turn on Haiku (message.model)',
  );
  check(
    r,
    myTools.some((t) => t.effort !== null) &&
      myTools.every((t) => t.effort === null || String(t.effort) === 'xhigh'),
    'tools ran at effort xhigh',
  );
}

async function step4(r: StepResult): Promise<void> {
  if (!needTurns(r, 4)) return;
  const boss = ceo();
  if (!boss) throw new Error('no CEO');
  const at = Date.now();
  // Step away first so the approach is visible: the CEO stays here while the player... cannot move (no input), so
  // the evidence is the agent.approach{present} push and the distance at the card.
  await chat(
    '@ceo ask me a multiple-choice question with exactly three options about which tree type we should harvest next (use your question tool), then wait for my answer and tell me in one short sentence which option I picked',
  );
  const card = await waitFor(
    'a question card',
    180_000,
    () =>
      events.find(
        (e) =>
          e.at >= at &&
          e.dir === 'out' &&
          e.t === 'agent.pending' &&
          e.p.agentId === boss.agentId &&
          ((e.p.cards as Json[]) ?? []).some((c) => c.kind === 'question'),
      ),
    500,
  );
  const cards = (card.p.cards as Json[]).filter((c) => c.kind === 'question');
  const q = cards[0] ?? {};
  r.numbers.cardMs = card.at - at;
  r.numbers.question = JSON.stringify(q).slice(0, 300);
  const approach = await waitFor(
    'agent.approach present',
    20_000,
    () =>
      events.find(
        (e) =>
          e.at >= at &&
          e.dir === 'out' &&
          e.t === 'agent.approach' &&
          e.p.agentId === boss.agentId &&
          e.p.role === 'present',
      ),
    250,
  ).catch(() => null);
  check(
    r,
    approach !== null,
    `agent.approach{present} sent (${approach ? approach.at - card.at : '-'} ms after the card)`,
  );
  const qIcon = await waitFor(
    'QUESTION head icon',
    15_000,
    () => agentOnClient(boss.agentId)?.headIcon === 'QUESTION',
    300,
  ).catch(() => false);
  check(r, qIcon === true, 'QUESTION head icon on the client');
  const close = await waitFor(
    'the CEO at the player',
    30_000,
    () => {
      const d = dist(agentOnClient(boss.agentId)?.pos, lastState?.player);
      return d <= 4 ? d : null;
    },
    300,
  ).catch(() => null);
  r.numbers.presentDistance =
    close !== null ? round(close, 2) : round(dist(agentOnClient(boss.agentId)?.pos, lastState?.player), 2);
  check(
    r,
    close !== null,
    `the CEO came to the player (ApproachPlayer, ${r.numbers.presentDistance} blocks)`,
  );
  screenshot('step4-question');
  // The second option's label (the answer the model must report back).
  const opts = (((q.questions as Json[] | undefined)?.[0]?.options ?? q.options ?? []) as Json[]).map((o) =>
    String(o.label ?? o),
  );
  r.numbers.options = opts;
  const answerAt = Date.now();
  const ans = await chat('@ceo 2');
  check(r, ans.sent, 'answer "@ceo 2" sent');
  const cleared = await waitFor(
    'the card answered',
    20_000,
    () =>
      events.find(
        (e) =>
          e.at >= answerAt &&
          e.dir === 'out' &&
          e.t === 'agent.pending' &&
          e.p.agentId === boss.agentId &&
          !((e.p.cards as Json[]) ?? []).some((c) => c.kind === 'question'),
      ),
    250,
  ).catch(() => null);
  check(r, cleared !== null, 'the question card cleared');
  await waitSettled(boss.agentId, answerAt, 180_000).catch((e: Error) => r.notes.push(e.message));
  const replies = saysSince(answerAt, boss.agentId);
  r.numbers.reply = replies.join(' | ').slice(0, 300);
  const label = opts[1]?.toLowerCase() ?? '';
  const firstWord = label.split(/\s+/)[0] ?? '';
  check(
    r,
    label !== '' && replies.some((t) => t.toLowerCase().includes(firstWord)),
    `the model reports option 2 ("${opts[1] ?? '?'}")`,
  );
  r.numbers.turns = turnsSince(at, boss.agentId).length;
}

async function step5(r: StepResult): Promise<void> {
  if (!needTurns(r, 6)) return;
  const boss = ceo();
  if (!boss) throw new Error('no CEO');
  const kernel = await guest('linux-1', 'uname -r').catch(() => ({ code: null, out: '' }));
  r.numbers.guestKernel = kernel.out;
  const hashBefore = monitor('linux-1')?.hash ?? null;
  const at = Date.now();
  await chat(
    '@ceo sit at linux-1, run uname -a and ls /mnt/codex in the terminal, then tell me the kernel version and stand up',
  );
  const sit = await waitFor(
    'sit_at_pc',
    180_000,
    () => toolsSince(at, boss.agentId).find((t) => /sit_at_pc/.test(t.toolName)),
    500,
  );
  r.numbers.sitTool = `${sit.model}/${String(sit.effort)}`;
  const seated = await waitFor(
    'seated on the client',
    150_000,
    () => agentOnClient(boss.agentId)?.atPc === true,
    300,
  ).catch(() => false);
  check(r, seated === true, 'seated at linux-1 (client atPc, SEATED icon possible)');
  const opusBrain = await waitFor(
    'swap to Opus',
    120_000,
    () =>
      events.find(
        (e) =>
          e.at >= sit.at &&
          e.dir === 'ev' &&
          e.t === 'brain' &&
          e.p.agentId === boss.agentId &&
          e.p.model === 'opus',
      ),
    300,
  ).catch(() => null);
  r.numbers.swapToOpusMs = opusBrain ? opusBrain.at - sit.at : null;
  const bash = await waitFor(
    'pc bash',
    240_000,
    () => {
      const found = toolsSince(at, boss.agentId).filter(
        (t) => /bash/i.test(t.toolName) && t.behavior === 'allow',
      );
      return found.length > 0 ? found : null;
    },
    500,
  ).catch(() => [] as ToolRec[]);
  r.numbers.bashTools = bash.map((t) => `${t.toolName}@${t.model}/${String(t.effort)}`);
  check(
    r,
    bash.length > 0 &&
      bash.every(
        (t) => String(t.model).includes('opus') && (t.effort === null || String(t.effort) === 'medium'),
      ),
    'pc bash ran on Opus/medium',
  );
  const changed = await waitFor(
    'the monitor to change',
    60_000,
    () => {
      const h = monitor('linux-1')?.hash;
      return h && h !== hashBefore ? h : null;
    },
    300,
  ).catch(() => null);
  const hashes = monitorSeen.filter((x) => x.pcId === 'linux-1' && x.at >= at).length;
  r.numbers.monitorHashChanges = hashes;
  check(
    r,
    changed !== null,
    `ShellMirror on the monitor (frame hash ${hashBefore ?? '-'} -> ${changed ?? '-'}, ${hashes} changes)`,
  );
  screenshot('step5-pc');
  const stand = await waitFor(
    'stand_up',
    300_000,
    () => toolsSince(at, boss.agentId).find((t) => /stand_up/.test(t.toolName)),
    500,
  ).catch(() => null);
  check(r, stand !== null, 'stood up');
  await waitSettled(boss.agentId, at, 240_000).catch((e: Error) => r.notes.push(e.message));
  // The full reply is the transcript line (the bubble shows its first sentences).
  const replies = [...linesSince(at, boss.agentId), ...saysSince(at, boss.agentId)].join(' | ');
  r.numbers.reply = linesSince(at, boss.agentId).join(' | ').slice(0, 400);
  const kVer = kernel.out.split('-')[0] ?? '';
  check(r, kVer !== '' && replies.includes(kVer), `the kernel version reported (${kernel.out})`);
  const seatedTurns = turnsSince(at, boss.agentId);
  r.numbers.turns = seatedTurns.map((t) => t.sessionModel);
  check(
    r,
    seatedTurns.some((t) => String(t.sessionModel).includes('opus')),
    'a turn on Opus while seated (message.model)',
  );
  r.numbers.compactedBeforeDownswap = turnsSince(at, boss.agentId).some((t) => t.numTurns === 0);
  // Back on Haiku once standing (the swap waits out the 60 s re-sit debounce).
  const standAt = stand?.at ?? Date.now();
  const haiku = await waitFor(
    'swap back to Haiku',
    150_000,
    () =>
      events.find(
        (e) =>
          e.at >= standAt &&
          e.dir === 'ev' &&
          e.t === 'brain' &&
          e.p.agentId === boss.agentId &&
          e.p.model === 'haiku',
      ),
    500,
  ).catch(() => null);
  r.numbers.backToHaikuMs = haiku ? haiku.at - standAt : null;
  check(
    r,
    haiku !== null && opusBrain !== null,
    `Opus/medium at the sit boundary, Haiku/xhigh after standing (${r.numbers.backToHaikuMs ?? '-'} ms)`,
  );
}

async function step6(r: StepResult): Promise<void> {
  if (!needTurns(r, 4)) return;
  const boss = ceo();
  if (!boss) throw new Error('no CEO');
  const at = Date.now();
  await chat(
    '@ceo sit at linux-1 and run "sleep 600 && echo build-finished" in the terminal in the foreground; it is a long build, wait for it to finish before you do anything else',
  );
  const running = await waitFor(
    'sleep 600 in the guest',
    300_000,
    async () => {
      const bash = toolsSince(at, boss.agentId).some(
        (t) => /bash/i.test(t.toolName) && t.behavior === 'allow',
      );
      if (!bash) return false;
      const g = await guest('linux-1', "ps -eo pid,args | grep '[s]leep 600' | head -5");
      return g.out.trim() !== '' ? g.out.trim() : false;
    },
    1000,
  );
  r.numbers.guestPids = running.split('\n').join(',');
  await sleep(2000);
  const turnsBefore = turnsSince(at, boss.agentId).length;
  const kickAt = Date.now();
  const reply = await debug().uiRequest('agent.cmd', { agentId: boss.agentId, cmd: 'kick' });
  const replyMs = Date.now() - kickAt;
  r.numbers.kickReply = `${String(reply.echo)} (${replyMs} ms)`;
  const ended = await waitFor(
    'the turn to end',
    20_000,
    () =>
      turnsSince(kickAt, boss.agentId).length > 0 || manager().brain(boss.agentId)?.status !== 'thinking'
        ? Date.now()
        : null,
    100,
  ).catch(() => null);
  r.numbers.interruptMs = ended ? ended - kickAt : null;
  r.numbers.turnsBeforeKick = turnsBefore;
  check(
    r,
    ended !== null && ended - kickAt <= 3000,
    `interrupted within ~2 s (${r.numbers.interruptMs ?? '-'} ms)`,
  );
  const gone = await waitFor(
    'guest processes killed',
    15_000,
    async () =>
      (await guest('linux-1', "ps -eo pid,args | grep '[s]leep 600' || true")).out === '' ? Date.now() : null,
    500,
  ).catch(() => null);
  r.numbers.guestKilledMs = gone ? gone - kickAt : null;
  check(r, gone !== null, `guest processes killed (${r.numbers.guestKilledMs ?? '-'} ms)`);
  const unseated = await waitFor(
    'stood up on the client',
    15_000,
    () => agentOnClient(boss.agentId)?.atPc === false,
    300,
  ).catch(() => false);
  check(r, unseated === true, 'off the seat');
  const haiku = await waitFor(
    'back on Haiku',
    150_000,
    () => (manager().brain(boss.agentId)?.model === 'haiku' ? Date.now() : null),
    500,
  ).catch(() => null);
  r.numbers.backToHaikuMs = haiku ? haiku - kickAt : null;
  check(r, haiku !== null, `back on Haiku (${r.numbers.backToHaikuMs ?? '-'} ms after the kick)`);
  // A kicked agent wakes and may ask what to do next: the player tells it to leave the PC alone (otherwise it might
  // retry the 10-minute build, as in the first live run).
  const ask = await waitFor(
    'a question after the kick',
    30_000,
    () => {
      const e = [...events]
        .reverse()
        .find(
          (x) => x.at >= kickAt && x.dir === 'out' && x.t === 'agent.pending' && x.p.agentId === boss.agentId,
        );
      return ((e?.p.cards as Json[] | undefined) ?? []).find((c) => c.kind === 'question') ?? null;
    },
    500,
  ).catch(() => null);
  if (ask) {
    r.numbers.afterKickQuestion = JSON.stringify(
      (ask.questions as Json[] | undefined)?.[0]?.question ?? '',
    ).slice(0, 120);
    await debug()
      .uiRequest('pending.answer', {
        agentId: boss.agentId,
        pendingId: String(ask.id),
        answer: {
          kind: 'text',
          text: 'Leave the PC alone for now; no retry. Just wait for my next request.',
        },
      })
      .catch((e: Error) => r.notes.push(`answering the after-kick question failed: ${e.message}`));
  }
  await waitSettled(boss.agentId, kickAt, 120_000, 5_000).catch(() => {});
  r.numbers.turns = turnsSince(at, boss.agentId).length;
}

async function step7(r: StepResult): Promise<void> {
  if (!needTurns(r, 5)) return;
  const boss = ceo();
  if (!boss) throw new Error('no CEO');
  const org = runtime().orgModule.orgApi;
  const at = Date.now();
  await chat(
    '@ceo use your Codex write tool to create a lasting Codex page (scope lasting, category howto) titled "E2E acceptance" whose body says that linux-1 runs Linux and was checked during the acceptance run',
  );
  const write = await waitFor(
    'codex_write',
    180_000,
    () => toolsSince(at, boss.agentId).find((t) => /codex_write/.test(t.toolName)),
    500,
  ).catch(() => null);
  check(r, write !== null, `mc__codex_write called (${write?.model ?? '-'})`);
  await waitSettled(boss.agentId, at, 180_000, 5_000).catch((e: Error) => r.notes.push(e.message));
  const page = org.codex.index().pages.find((p) => /e2e acceptance/i.test(p.title));
  r.numbers.codexPage = page ? `${page.title} (${page.id}, ${page.scope})` : null;
  check(r, page !== undefined, 'the page is in the Codex index');
  check(r, page?.scope === 'lasting', `the page is lasting (${page?.scope ?? '-'})`);

  // The player schedules a real-clock task one minute out (CalendarScreen sends calendar.put).
  const dueAt = Date.now() + 60_000;
  const put = await debug().uiRequest('calendar.put', {
    title: 'E2E check-in',
    kind: 'task',
    assignees: [boss.agentId],
    clock: 'real',
    at: dueAt,
    recurrence: { kind: 'once' },
    durationMin: 5,
    task: 'Say "check-in done" in a short speech bubble, then report this task as done.',
    catchUp: 'skip',
    runWhileAway: false,
  });
  r.numbers.eventId = put.eventId;
  check(r, typeof put.eventId === 'string', 'calendar.put accepted');
  const fired = await waitFor(
    'calendar.fired',
    150_000,
    () => events.find((e) => e.dir === 'out' && e.t === 'calendar.fired' && e.p.eventId === put.eventId),
    500,
  ).catch(() => null);
  r.numbers.firedLateMs = fired ? fired.at - dueAt : null;
  check(r, fired !== null, `fired (${r.numbers.firedLateMs ?? '-'} ms after due)`);
  const report = await waitFor(
    'the task report',
    240_000,
    () => {
      const ev = org.calendar.state().events.find((e) => e.id === put.eventId);
      const occ = ev?.occurrences.find(
        (o) => o.status === 'done' || o.status === 'failed' || o.status === 'blocked',
      );
      return occ ? { ev, occ } : null;
    },
    1000,
  ).catch(() => null);
  r.numbers.occurrence = report
    ? `${report.occ.status}${report.occ.note ? `: ${report.occ.note}` : ''}`
    : null;
  const reportTool = toolsSince(dueAt, boss.agentId).find((t) => /report_task/.test(t.toolName));
  r.numbers.reportTool = reportTool ? reportTool.toolName : null;
  check(r, report?.occ.status === 'done', `reported done (${r.numbers.occurrence ?? 'no report'})`);
  r.numbers.reply = saysSince(dueAt, boss.agentId).join(' | ').slice(0, 200);
  await waitSettled(boss.agentId, dueAt, 120_000, 5_000).catch(() => {});
  r.numbers.turns = turnsSince(at, boss.agentId).length;
}

async function step8(r: StepResult): Promise<void> {
  const before = (await debug().state(3000)) as DebugState;
  sampleState(before);
  const worldBefore = before.worldId;
  const pcsBefore = pcs()
    .list()
    .map((p) => p.id);
  const killAt = Date.now();
  await waitFor(
    'debug.kill_player',
    30_000,
    async () => {
      await debug().killPlayer();
      return true;
    },
    1000,
  );
  const over = await waitFor(
    'GameOverScreen',
    15_000,
    async () => {
      const s = (await debug().state(3000)) as DebugState;
      sampleState(s);
      return s.screen === 'GameOverScreen' ? Date.now() : null;
    },
    200,
  );
  r.numbers.gameOverMs = over - killAt;
  screenshot('step8-gameover');
  // Begin is enabled once Node allocated the next world (and the last words are out).
  const begin = await waitFor(
    'Begin',
    60_000,
    async () => {
      await debug().clickBegin();
      return Date.now();
    },
    1000,
  );
  const ready = await waitFor(
    'World #2 ready',
    120_000,
    async () => {
      const s = (await debug().state(3000)) as DebugState;
      sampleState(s);
      return s.inWorld && s.screen === null && s.worldId !== worldBefore ? s : null;
    },
    500,
  );
  r.numbers.beginToWorldMs = Date.now() - begin;
  r.numbers.deathToWorldMs = Date.now() - killAt;
  r.numbers.worlds = `${worldBefore} -> ${ready.worldId} (gen ${ready.gen})`;
  check(r, ready.gen === 2 && ready.hardcore === true, `World #2, hardcore (${r.numbers.worlds})`);
  check(
    r,
    Number(r.numbers.deathToWorldMs) < 60_000,
    `death to the next world in ${r.numbers.deathToWorldMs} ms`,
  );
  const graveyard = join(runtime().savesDir, '_graveyard');
  await waitFor('the dead save buried', 30_000, () => existsSync(graveyard), 500).catch(() => null);
  check(r, existsSync(graveyard), 'the dead save moved to saves/_graveyard');
  const slots = await waitFor(
    'the new office',
    60_000,
    () => {
      const s = office(ready.worldId);
      return s.length > 0 ? s : null;
    },
    500,
  ).catch(() => [] as Slot[]);
  const pcsAfter = pcs()
    .list()
    .map((p) => p.id);
  r.numbers.pcs = `${pcsBefore.join(',')} -> ${pcsAfter.join(',')}`;
  check(r, pcsAfter.join() === pcsBefore.join() && pcsAfter.includes('linux-1'), 'the same PCs (linux-1)');
  check(
    r,
    slots.some((x) => x.kind === 'workstation' && x.pcId === 'linux-1'),
    'the new office binds linux-1',
  );
  const linuxUp = await waitFor(
    'linux-1 running in World #2',
    120_000,
    () => pcs().status('linux-1').status === 'running',
    1000,
  ).catch(() => false);
  check(r, linuxUp === true, `linux-1 running (${pcs().status('linux-1').status})`);
  const org = runtime().orgModule.orgApi;
  const lasting = org.codex.index().pages.filter((p) => p.scope === 'lasting');
  r.numbers.lastingPages = lasting.map((p) => p.title);
  if (wants(7) && crewMode === 'agents')
    check(
      r,
      lasting.some((p) => /e2e acceptance/i.test(p.title)),
      'the lasting Codex page survived',
    );
  if (crewMode === 'agents') {
    const newCeo = await waitFor(
      'the new CEO',
      90_000,
      () => {
        const c = ceo();
        return c && agentOnClient(c.agentId) ? c : null;
      },
      1000,
    ).catch(() => null);
    r.numbers.newCeo = newCeo ? `${newCeo.name} (${newCeo.agentId})` : null;
    check(r, newCeo !== null, 'a new CEO arrives in World #2');
  }
  screenshot('step8-world2');
}

async function scriptedSmoke(r: StepResult): Promise<void> {
  const boss = await waitFor(
    'the scripted CEO',
    60_000,
    () => {
      const c = ceo();
      return c && agentOnClient(c.agentId) ? c : null;
    },
    500,
  ).catch(() => null);
  r.numbers.ceo = boss ? `${boss.name} (${boss.agentId})` : null;
  if (!boss) {
    check(r, false, 'a scripted CEO body on the client');
    return;
  }
  const at = Date.now();
  const sent = await chat(`@${boss.handle} hello from the harness`);
  check(r, sent.sent, 'debug.chat goes out as chat.send');
  const echoed = await waitFor(
    'chat.send at Node',
    10_000,
    () => events.find((e) => e.at >= at && e.dir === 'in' && e.t === 'chat.send'),
    200,
  ).catch(() => null);
  check(r, echoed !== null, 'Node received chat.send from the mod');
  const bubble = await waitFor(
    'a reply bubble',
    15_000,
    () => bubblesSeen.find((b) => b.at >= at && b.agentId === boss.agentId),
    300,
  ).catch(() => null);
  check(r, bubble !== null, `reply bubble on the client (${bubble?.text.slice(0, 60) ?? '-'})`);
  const refused = await chat('@nobodyhere hi');
  check(
    r,
    !refused.sent && Boolean(refused.hint),
    `an unknown name is refused locally (${refused.hint ?? '-'})`,
  );
  const cmd = await debug()
    .uiRequest('agent.cmd', { agentId: boss.agentId, cmd: 'stay' })
    .catch((e: Error) => ({ error: e.message }));
  r.numbers.uiRequest = JSON.stringify(cmd).slice(0, 120);
  check(r, !('error' in cmd), 'debug.ui_request agent.cmd answered by Node');
  const trees = await find(boss.agentId, 'minecraft:oak_log', 48).catch((e: Error) => ({ error: e.message }));
  r.numbers.oakNearSpawn = JSON.stringify(trees).slice(0, 200);
  // Seed scouting at zero tokens: can a body standing in the office actually mine oak here (the mod's own job)?
  const job = (await runtime()
    .bridge.request(
      'skill.run',
      {
        jobId: `e2e-scout-${Date.now()}`,
        agentId: boss.agentId,
        skill: 'mine',
        args: { block: 'oak_log', count: 2, radius: 32 },
        waitMs: 60_000,
        replace: true,
      },
      { timeoutMs: 75_000 },
    )
    .catch((e: Error) => ({ status: 'error', error: e.message }))) as Json;
  r.numbers.oakMineJob = `${String(job.status)} ${JSON.stringify(job.error ?? job.result ?? '').slice(0, 160)}`;
  if (job.status !== 'done') {
    // Diagnosis: is it the office (the body starts inside, by the player) or the tree? Walk out through the door to
    // the porch, then try again from there.
    const door = office(firstWorld).find((x) => x.kind === 'door')?.pos;
    const run = (skill: 'goto' | 'mine', args: Json, waitMs: number) =>
      runtime()
        .bridge.request(
          'skill.run',
          { jobId: `e2e-${skill}-${Date.now()}`, agentId: boss.agentId, skill, args, waitMs, replace: true },
          { timeoutMs: waitMs + 15_000 },
        )
        .catch((e: Error) => ({ status: 'error', error: e.message })) as Promise<Json>;
    if (door) {
      const out = await run('goto', { pos: { x: door.x, y: door.y, z: door.z + 1 } }, 30_000);
      r.numbers.gotoPorch = `${String(out.status)} ${JSON.stringify(out.error ?? '').slice(0, 120)}`;
      const again = await run('mine', { block: 'oak_log', count: 2, radius: 32 }, 60_000);
      r.numbers.oakFromPorch = `${String(again.status)} ${JSON.stringify(again.error ?? again.result ?? '').slice(0, 160)}`;
    }
  }
  // And the office stays whole: its stripped spruce corner posts are never a mining target.
  const posts = (await find(boss.agentId, 'minecraft:stripped_spruce_log', 16)) as Json;
  r.numbers.officePosts = ((posts.matches as Json[] | undefined) ?? []).length;
  const grab = (await runtime()
    .bridge.request(
      'skill.run',
      {
        jobId: `e2e-posts-${Date.now()}`,
        agentId: boss.agentId,
        skill: 'mine',
        args: { block: 'stripped_spruce_log', count: 1, radius: 16 },
        waitMs: 30_000,
        replace: true,
      },
      { timeoutMs: 45_000 },
    )
    .catch((e: Error) => ({ status: 'error', error: e.message }))) as Json;
  r.numbers.officePostJob = `${String(grab.status)} ${JSON.stringify(grab.error ?? grab.result ?? '').slice(0, 120)}`;
  check(r, grab.status === 'failed', 'the office corner posts are not minable by agents');
}

// ---------------------------------------------------------------------------------------------------------------
// Quit and orphans
// ---------------------------------------------------------------------------------------------------------------

function ps(): Array<{ pid: number; ppid: number; cmd: string }> {
  const out = execFileSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8', maxBuffer: 16 << 20 });
  return out
    .split('\n')
    .map((l) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(l))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), cmd: m[3] ?? '' }));
}
function descendants(root: number): Array<{ pid: number; ppid: number; cmd: string }> {
  const all = ps();
  const out: Array<{ pid: number; ppid: number; cmd: string }> = [];
  const queue = [root];
  while (queue.length) {
    const p = queue.shift();
    for (const c of all.filter((x) => x.ppid === p)) {
      out.push(c);
      queue.push(c.pid);
    }
  }
  return out;
}

/** The harness's own helpers (tsx's esbuild service, our ps): not part of the session under test. */
const harnessChild = (p: { cmd: string }) => /\bps -axo\b|@esbuild\/|esbuild --service/.test(p.cmd);

/** The dev container CLI with the MineVibe-dev roots (the roots `npm run play` uses). */
function containerCli(args: string[]): { code: number | null; out: string } {
  const base = join(homedir(), 'Library', 'Application Support', 'MineVibe-dev');
  const r = spawnSync(join(base, 'container-root', 'bin', 'container'), args, {
    encoding: 'utf8',
    timeout: 60_000,
    env: {
      ...process.env,
      CONTAINER_APP_ROOT: join(base, 'container'),
      CONTAINER_INSTALL_ROOT: join(base, 'container-root'),
    },
  });
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

async function step9(r: StepResult, home: string, playDone: Promise<number>): Promise<void> {
  const kids = descendants(process.pid).filter((p) => !harnessChild(p));
  const claudes = kids.filter((p) => /claude/i.test(p.cmd));
  const javas = kids.filter((p) => /java/.test(p.cmd));
  r.numbers.before = { children: kids.length, java: javas.length, claude: claudes.length };
  let containerName: string | null = null;
  try {
    containerName = pcs().containerNameOf('linux-1');
  } catch {
    containerName = null;
  }
  const jvm = lastState?.pid ?? javas[0]?.pid;
  const quitAt = Date.now();
  if (!playExit && jvm && !stopRequested) {
    // The player closes the game: the JVM quits on its own (saving), and Node notices and tears everything down.
    say(`closing the game (SIGTERM to the JVM ${jvm})`);
    try {
      process.kill(jvm, 'SIGTERM');
    } catch (err) {
      r.notes.push(`the JVM was already gone: ${(err as Error).message}`);
    }
  }
  const code = await Promise.race([playDone, sleep(150_000).then(() => null)]);
  r.numbers.playExitCode = code;
  r.numbers.teardownMs = Date.now() - quitAt;
  check(r, code !== null, `npm run play returned (${code}) in ${r.numbers.teardownMs} ms`);
  await sleep(3000);
  const left = descendants(process.pid).filter((p) => !harnessChild(p));
  const all = ps();
  const strays = all.filter(
    (p) =>
      p.pid !== process.pid &&
      (p.cmd.includes(home) || claudes.some((c) => c.pid === p.pid) || javas.some((j) => j.pid === p.pid)),
  );
  r.numbers.after = {
    children: left.map((p) => p.cmd.slice(0, 80)),
    strays: strays.map((p) => `${p.pid} ${p.cmd.slice(0, 100)}`),
  };
  check(r, left.length === 0, `no child processes left (${left.length})`);
  check(r, strays.length === 0, `no java/claude/node orphans of this run (${strays.length})`);
  // The PC's VM is a container-runtime-linux helper named after the container; its network keeps a vmnet helper while
  // the engine runs (stopping the engine ends it).
  const vm = containerName
    ? all.filter((p) => p.cmd.includes(containerName) && !/container-network-vmnet/.test(p.cmd))
    : [];
  const net = containerName ? all.filter((p) => p.cmd.includes(`${containerName}-net`)) : [];
  r.numbers.vmProcesses = vm.length;
  r.numbers.networkHelpers = net.length;
  check(r, vm.length === 0, `linux-1 stopped (no ${containerName ?? 'container'} VM processes)`);
  const launchd = spawnSync('launchctl', ['list'], { encoding: 'utf8' }).stdout ?? '';
  const engine = launchd
    .split('\n')
    .filter((l) => /com\.apple\.container\.(apiserver|container-runtime|core)/.test(l));
  const otherMineVibe = all.filter(
    (p) => /main\.ts (play|dev|app)|minevibe-server/.test(p.cmd) && p.pid !== process.pid,
  );
  r.numbers.engineJobs = engine.map((l) => l.trim());
  r.numbers.otherMineVibes = otherMineVibe.map((p) => `${p.pid} ${p.cmd.slice(0, 80)}`);
  if (otherMineVibe.length > 0) {
    r.notes.push('another MineVibe ran on this Mac: the shared engine is allowed to stay up for it');
    check(r, true, `engine jobs left for the other MineVibe: ${engine.length}`);
  } else {
    check(r, engine.length === 0, `our container engine stopped (${engine.length} launchd jobs left)`);
  }
  // Harness hygiene: each run has its own PC instance (a fresh home), so its container, network and volumes are
  // removed from the shared dev engine when it is still up (another MineVibe runs). Not part of the product path.
  const prefix = containerName?.replace(/linux-1$/, '');
  if (prefix && engine.length > 0) {
    const removed: string[] = [];
    for (const [list, del] of [
      [['list', '-a', '-q'], ['rm']],
      [
        ['network', 'list', '-q'],
        ['network', 'delete'],
      ],
      [
        ['volume', 'list', '-q'],
        ['volume', 'delete'],
      ],
    ] as const) {
      const names = containerCli([...list])
        .out.split('\n')
        .map((l) => l.trim())
        .filter((l) => l.startsWith(prefix));
      if (names.length > 0 && containerCli([...del, ...names]).code === 0) removed.push(...names);
    }
    r.numbers.cleanedUp = removed;
  } else if (prefix) {
    // The engine stopped with us (nobody else used it): remove this instance's leftovers on the next run instead.
    writeFileSync(LEAKED, `${[...leakedPrefixes(), prefix].join('\n')}\n`);
  }
}

/** PC instances of earlier runs whose container, network and volumes are still in the dev engine's store. */
const LEAKED = join(here, 'out', 'leaked-instances.txt');
function leakedPrefixes(): string[] {
  try {
    return readFileSync(LEAKED, 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => /^mv-pc-[0-9a-f]{8}-$/.test(l));
  } catch {
    return [];
  }
}
/** Once the engine runs: removes the leftovers of earlier runs (only instances this harness created). */
function cleanLeaked(): string[] {
  const prefixes = leakedPrefixes();
  if (prefixes.length === 0) return [];
  const removed: string[] = [];
  for (const [list, del] of [
    [['list', '-a', '-q'], ['rm']],
    [
      ['network', 'list', '-q'],
      ['network', 'delete'],
    ],
    [
      ['volume', 'list', '-q'],
      ['volume', 'delete'],
    ],
  ] as const) {
    const names = containerCli([...list])
      .out.split('\n')
      .map((l) => l.trim())
      .filter((l) => prefixes.some((p) => l.startsWith(p)));
    if (names.length > 0 && containerCli([...del, ...names]).code === 0) removed.push(...names);
  }
  writeFileSync(LEAKED, '');
  return removed;
}

// ---------------------------------------------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------------------------------------------

function writeResults(): void {
  const summary = {
    run: runTag,
    crew: crewMode,
    seed: seed ?? null,
    turns: turns.length,
    maxTurns,
    // total_cost_usd is cumulative per session: the last turn of each agent holds its session's total.
    costUsd: round(
      [...new Map(turns.map((t) => [t.agentId, t.costUsd ?? 0])).values()].reduce((n, c) => n + c, 0),
      4,
    ),
    results,
    turnLog: turns,
  };
  writeFileSync(join(outDir, 'result.json'), `${JSON.stringify(summary, null, 2)}\n`);
  const md = [
    `# MineVibe acceptance run ${runTag}`,
    '',
    `crew ${crewMode}, seed ${seed ?? 'random'}, ${turns.length} agent turns, $${summary.costUsd} (SDK estimate)`,
    '',
    '| Step | Result | Time | Numbers |',
    '| --- | --- | --- | --- |',
    ...results.map(
      (x) =>
        `| ${x.step}. ${x.name} | ${x.status} | ${(x.ms / 1000).toFixed(1)} s | ${JSON.stringify(x.numbers).replaceAll('|', '/')} |`,
    ),
    '',
    ...results.flatMap((x) => [
      `## ${x.step}. ${x.name}: ${x.status}`,
      '',
      ...x.notes.map((n) => `- ${n}`),
      '',
    ]),
  ].join('\n');
  writeFileSync(join(outDir, 'summary.md'), md);
}

async function seedHome(home: string): Promise<void> {
  // Reuse the downloads of the default play home (APFS clones, no network); the world, PCs and state start empty.
  const from = join(repo, '.minevibe-dev', 'play');
  for (const d of ['game/assets', 'game/libraries', 'game/versions', 'runtime', 'Caches/mods']) {
    const src = join(from, d);
    if (!existsSync(src)) continue;
    mkdirSync(dirname(join(home, d)), { recursive: true });
    // `cp -cR`: APFS clones that keep the JRE bundle's relative symlinks (fs.cp rewrote them, and the launcher then
    // found the runtime "damaged" and downloaded it again on every run).
    if (spawnSync('cp', ['-cR', src, join(home, d)]).status !== 0) {
      await cp(src, join(home, d), { recursive: true, verbatimSymlinks: true });
    }
  }
}

async function main(): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), 'minevibe-e2e-'));
  say(`run ${runTag}: crew ${crewMode}, home ${home}, out ${outDir}`);
  await seedHome(home);
  const env: Record<string, string | undefined> = {
    ...process.env,
    MINEVIBE_HOME: home,
    MINEVIBE_E2E: '1',
    MINEVIBE_CLAUDE: 'bundled',
    ...(seed ? { MINEVIBE_WORLD_SEED: seed } : {}),
  };
  const logger = pino(
    { level: 'info', redact: { paths: REDACT_PATHS, censor: '[redacted]' } },
    pino.destination({ dest: join(outDir, 'server.log'), sync: true }),
  );
  const control: PlayControl = { onStopRequest: null };
  let gotRuntime: (r: Runtime) => void = () => {};
  const runtimeReady = new Promise<Runtime>((res) => {
    gotRuntime = res;
  });
  const playDone = play({
    repoRoot: repo,
    logger,
    env,
    control,
    runtime: { crew: crewMode },
    onRuntime: (r) => {
      instrument(r);
      gotRuntime(r);
    },
  }).then(
    (code) => {
      playExit = { code, at: Date.now() };
      say(`play returned ${code}`);
      return code;
    },
    (err: unknown) => {
      playExit = { code: 1, at: Date.now() };
      say(`play failed: ${(err as Error).stack ?? String(err)}`);
      return 1;
    },
  );
  let stopping = false;
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => {
      if (stopping) process.exit(130);
      stopping = true;
      stopRequested = true;
      say(`${sig}: stopping the session`);
      control.onStopRequest?.(sig);
    });
  }
  rt = await Promise.race([runtimeReady, playDone.then(() => null)]);
  if (rt) {
    // Client snapshots at ~3 Hz for bubbles, head icons, positions and monitor hashes.
    const sampler = (async () => {
      while (!playExit) {
        if (rt?.bridge.isConnected) {
          try {
            sampleState((await debug().state(2000)) as DebugState);
          } catch {
            // not ready yet, or between worlds
          }
        }
        await sleep(330);
      }
    })();
    void sampler;
    const crewSteps = async () => {
      await step(1, 'Cold boot: no TitleScreen, hardcore, office with linux-1, frames', step1);
      await step(2, 'CEO at the door, follows; bubbles and head icons', step2);
      if (crewMode === 'scripted')
        await step(0, 'Scripted smoke: debug.chat, debug.ui_request, trees near spawn', scriptedSmoke);
      await step(3, '@ceo collect 10 oak logs and make a crafting table (Haiku/xhigh)', step3);
      await step(4, 'Ask flow: question card, ApproachPlayer, "@ceo 2" reaches the model', step4);
      await step(5, 'PC flow: sit, Opus/medium, pc bash, ShellMirror, stand, Haiku/xhigh', step5);
      await step(6, 'Kick during a long PC task', step6);
      await step(7, 'Codex page + real-clock calendar task', step7);
      await step(8, 'Hardcore: death -> Game Over -> Begin -> World #2', step8);
    };
    await crewSteps().catch((err: unknown) => say(`scenario aborted: ${String(err)}`));
  }
  await step(9, 'Quit: everything stops, no orphans', (r) => step9(r, home, playDone));
  // Never exit before the session finished its teardown (PCs, engine lease, run lock).
  if (!playExit) await Promise.race([playDone, sleep(120_000)]);
  writeResults();
  say(`turns used: ${turns.length}/${maxTurns}`);
  for (const x of results) say(`${x.step}. ${x.status} ${x.name}`);
  // The game's own logs are evidence too.
  for (const f of ['Logs/minecraft-console.log', 'game/logs/latest.log']) {
    const src = join(home, f);
    if (existsSync(src)) await cp(src, join(outDir, f.replaceAll('/', '_'))).catch(() => {});
  }
  if (!keepHome) await rm(home, { recursive: true, force: true }).catch(() => {});
  eventsOut.end();
  samplesOut.end();
  harnessLog.end();
  process.exit(results.some((x) => x.status === 'FAIL') ? 1 : 0);
}

await main();
