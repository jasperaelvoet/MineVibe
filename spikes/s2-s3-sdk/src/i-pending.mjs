// Check (i): a canUseTool promise (AskUserQuestion card) kept pending for HOLD_MS, then answered;
// the session must still complete (PLAN §6.4: cards wait for the player, slot released meanwhile).
// Also records what the stream does while parked and whether the prompt cache is still warm
// for the continuation (cache_read vs cache_creation after the wait).
import { Recorder, baseOptions, makeBroker, openSession, sleep, watchdog } from './lib.mjs';

const HOLD_MS = Number(process.env.HOLD_MS ?? 180_000);
const rec = new Recorder('i-pending');
let session;
const stop = watchdog(rec, HOLD_MS + 180_000, () => session?.q.close());

const broker = makeBroker(rec, {
  AskUserQuestion: async (input, opts) => {
    const askedAt = rec.t();
    rec.data.parkedAt = askedAt;
    let aborted = false;
    opts?.signal?.addEventListener('abort', () => {
      aborted = true;
      rec.event('canUseTool_abort', { after_ms: rec.t() - askedAt });
    });
    await sleep(HOLD_MS);
    rec.data.answeredAt = rec.t();
    rec.data.abortedWhileParked = aborted;
    const questions = input.questions ?? [];
    const answers = Object.fromEntries(questions.map((q) => [q.question, q.options.at(-1).label]));
    rec.data.answers = answers;
    return { behavior: 'allow', updatedInput: { questions, answers } };
  },
});

let status = 'FAIL';
const checks = {};
try {
  session = openSession(rec, baseOptions(rec, { canUseTool: broker, maxTurns: 4 }));
  rec.turn = 1;
  session.send(
    "Use AskUserQuestion to ask me 'Pick one?' with options 'Red' and 'Blue'. After I answer, reply with only my choice.",
  );
  const r = await session.nextResult(HOLD_MS + 150_000);
  await session.close();

  const parked = rec.data.parkedAt ?? 0;
  const answered = rec.data.answeredAt ?? Number.POSITIVE_INFINITY;
  rec.data.messagesWhileParked = rec.events
    .filter((e) => e.kind === 'msg' && e.t > parked && e.t < answered)
    .map((e) => ({ t: e.t, type: e.type, subtype: e.subtype }));
  const after = rec.events.filter((e) => e.kind === 'msg' && e.type === 'assistant' && e.t > answered);
  rec.data.continuationUsage = after.map((e) => e.usage);
  rec.data.result = { subtype: r.subtype, text: r.result, duration_ms: r.duration_ms, num_turns: r.num_turns };

  checks.heldForFullPeriod = answered - parked >= HOLD_MS - 1000;
  checks.notAbortedWhileParked = rec.data.abortedWhileParked === false;
  checks.sessionCompleted = r.subtype === 'success';
  checks.modelGotAnswer = /blue/i.test(r.result ?? '');
  status = Object.values(checks).every(Boolean) ? 'PASS' : 'FAIL';
} catch (e) {
  rec.data.error = String(e?.message ?? e);
}

stop();
rec.finish(status, { checks, holdMs: HOLD_MS });
