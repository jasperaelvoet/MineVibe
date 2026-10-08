// Check (h): three concurrent tiny Haiku sessions (PLAN §6.5 BrainScheduler / §12.1 S2).
// Side observation: session 1 also passes `skills: []` to see whether that empties the
// built-in skill listing that init reports even with settingSources: [].
import { Recorder, baseOptions, openSession, watchdog } from './lib.mjs';

const rec = new Recorder('h-concurrent');
const sessions = [];
const stop = watchdog(rec, 240_000, () => sessions.forEach((s) => s.q.close()));

let status = 'FAIL';
const checks = {};
try {
  rec.turn = 1;
  const t0 = performance.now();
  const runs = await Promise.allSettled(
    [1, 2, 3].map(async (n) => {
      const s = openSession(rec, baseOptions(rec, { maxTurns: 1, ...(n === 1 ? { skills: [] } : {}) }));
      sessions.push(s);
      const started = performance.now() - t0;
      s.send(`Reply with exactly: ok-${n}`);
      const r = await s.nextResult(180_000);
      const finished = performance.now() - t0;
      const sessionId = s.sessionId;
      await s.close();
      return { n, sessionId, started: Math.round(started), finished: Math.round(finished), subtype: r.subtype, text: r.result };
    }),
  );
  rec.data.runs = runs.map((r) => (r.status === 'fulfilled' ? r.value : { error: String(r.reason?.message ?? r.reason) }));
  rec.data.skillsByInit = rec.inits.map((i) => ({ session_id: i.session_id, skills: i.skills?.length ?? 0, plugins: i.plugins?.length ?? 0 }));

  const ok = rec.data.runs.filter((r) => r.subtype === 'success' && r.text?.trim() === `ok-${r.n}`);
  checks.allThreeSucceeded = ok.length === 3;
  checks.distinctSessions = new Set(rec.data.runs.map((r) => r.sessionId)).size === 3;
  // Overlap: every session started before any finished.
  const firstFinish = Math.min(...rec.data.runs.map((r) => r.finished ?? Number.POSITIVE_INFINITY));
  checks.ranConcurrently = rec.data.runs.every((r) => r.started < firstFinish);
  status = Object.values(checks).every(Boolean) ? 'PASS' : 'FAIL';
} catch (e) {
  rec.data.error = String(e?.message ?? e);
}

stop();
rec.finish(status, { checks });
