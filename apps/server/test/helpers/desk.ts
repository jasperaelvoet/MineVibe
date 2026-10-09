/**
 * Test steps for the dual-session flow (PLAN §6.1): a fresh world with an idle CEO, a player wake, and a sit at a PC
 * that hands the agent over to its desk session (a second fake query, started in its own cwd).
 */

import { createHarness, type Harness, openWorldWithCeo } from './agentHarness.js';
import type { FakeQuery } from './fakeSdk.js';

/** A fresh world whose CEO is idle after its welcome turn; `q` is its body session. */
export async function freshWorld(options: Parameters<typeof createHarness>[0] = {}) {
  const w = await createHarness(options);
  await openWorldWithCeo(w.manager, { worldId: 'w1', gen: 1 });
  const id = w.manager.listAgents()[0]?.agentId ?? '';
  const q = w.query(0);
  await w.until(() => w.texts(q).some((t) => t.includes('WELCOME')), 'welcome');
  q.init();
  q.result();
  await w.until(() => w.manager.brain(id)?.status === 'idle', 'idle');
  const nonce = w.manager.brain(id)?.record.nonce ?? '';
  return { w, id, q, nonce };
}

/** Starts a body turn with a player message to Ada. */
export async function wake(w: Harness, q: FakeQuery, text: string): Promise<void> {
  await w.manager.deliverChat({ to: 'all', text: `@ada ${text}` });
  await w.until(() => w.texts(q).some((t) => t.includes(text)), `wake ${text}`);
}

/** The query of the agent's open desk session (by its cwd), or null. */
export function deskQuery(w: Harness, id: string): FakeQuery | null {
  const cwd = w.manager.brain(id)?.deskSession?.options?.cwd;
  if (!cwd) return null;
  return [...w.factory.queries].reverse().find((x) => x.options.cwd === cwd) ?? null;
}

/**
 * Sits the agent at `pcId` from inside its body turn (the sit job ends and the mod reports pc.seat); returns the
 * tool's text. The body's turn is still running.
 */
export async function sitCall(
  w: Harness,
  q: FakeQuery,
  id: string,
  pcId = 'linux-1',
  purpose = 'fix the failing test',
): Promise<string> {
  const before = w.skills.seats.length;
  const calling = q.callTool('mcp__mc__sit_at_pc', { pc: pcId, purpose });
  await w.until(() => w.skills.seats.length > before, 'agent.seat');
  const seat = w.skills.seats.at(-1) as { jobId: string; seatEpoch: number };
  w.manager.onPcSeat({ pcId, occupant: { kind: 'agent', agentId: id }, seatEpoch: seat.seatEpoch });
  w.skills.finish(seat.jobId, { status: 'done' });
  const out = await calling;
  return out.kind === 'allowed'
    ? ((out.result as { content?: { text?: string }[] }).content?.[0]?.text ?? '')
    : out.kind === 'denied'
      ? out.reason
      : out.error;
}

/**
 * Sits at `pcId` and ends the body's turn: the desk session takes over. Resolves with the desk's query once it got
 * its KICKOFF (after `init`, so its tools pass the startup gate).
 */
export async function sitAtDesk(
  w: Harness,
  q: FakeQuery,
  id: string,
  pcId = 'linux-1',
  purpose = 'fix the failing test',
): Promise<FakeQuery> {
  const queries = w.factory.queries.length;
  await sitCall(w, q, id, pcId, purpose);
  q.result();
  await w.until(() => w.factory.queries.length > queries && deskQuery(w, id) !== null, 'desk session');
  const d = deskQuery(w, id) as FakeQuery;
  d.init();
  await w.until(() => w.texts(d).some((t) => t.includes('KICKOFF')), 'kickoff');
  return d;
}

/** The last user message a query received. */
export function lastText(w: Harness, q: FakeQuery): string {
  return w.texts(q).at(-1) ?? '';
}
