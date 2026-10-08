// Check (e): context messages and priorities (PLAN §6.5).
//  1. shouldQuery:false message carrying a fact -> must not start a turn.
//  2. A normal question about the fact that needs one mc__status call.
//  3. While that tool call is in flight (PreToolUse), push two more messages:
//       priority 'next'  -> "also say MANGO"
//       priority 'later' -> "also say KIWI"
//     and observe whether each is folded into the running turn or run as its own turn.
import { Recorder, baseOptions, makeGate, openSession, sleep, turnTexts, watchdog } from './lib.mjs';

const rec = new Recorder('e-messages');
let session;
const stop = watchdog(rec, 300_000, () => session?.q.close());

let injected = false;
const uuids = {};
const gate = makeGate(rec, undefined, (input) => {
  if (injected || input.tool_name !== 'mcp__mc__status') return;
  injected = true;
  uuids.next = session.send('Also include the word MANGO in your reply.', { priority: 'next' });
  uuids.later = session.send('Also include the word KIWI in your reply.', { priority: 'later' });
});

let status = 'FAIL';
const checks = {};
try {
  session = openSession(rec, baseOptions(rec, { hooks: { PreToolUse: [{ hooks: [gate] }] }, maxTurns: 4 }));

  rec.turn = 0;
  uuids.context = session.send('[context] The crate code is PINEAPPLE-42.', { shouldQuery: false });
  // Observed on 2.1.293: a shouldQuery:false append emits a zero-turn `result` frame
  // (num_turns 0, no API call). Consume it here so it is not mistaken for turn 1's result.
  let contextResult;
  try {
    contextResult = await session.nextResult(6000);
  } catch {
    contextResult = undefined;
  }
  await sleep(500);
  const resultsAfterContext = rec.results.length;
  const assistantAfterContext = rec.assistantModels.length;
  rec.data.contextResult = contextResult && { subtype: contextResult.subtype, num_turns: contextResult.num_turns, result: contextResult.result };

  rec.turn = 1;
  uuids.question = session.send('Call mcp__mc__status once, then tell me the crate code in one short line.', { priority: 'next' });
  const r1 = await session.nextResult(120_000);

  // The 'later' message may run as its own turn; wait for it briefly without sending anything new.
  rec.turn = 2;
  let r2;
  try {
    r2 = await session.nextResult(60_000);
  } catch {
    r2 = undefined;
  }
  await session.close();

  const replyUuids = rec.events
    .filter((e) => e.kind === 'msg' && e.type === 'assistant' && e.user_message_uuids)
    .map((e) => ({ turn: e.turn, user_message_uuids: e.user_message_uuids }));
  const label = Object.fromEntries(Object.entries(uuids).map(([k, v]) => [v, k]));
  rec.data.uuids = uuids;
  rec.data.replyBoundTo = replyUuids.map((r) => ({ turn: r.turn, sends: r.user_message_uuids.map((u) => label[u] ?? u) }));
  rec.data.userMessagesEchoed = rec.events
    .filter((e) => e.kind === 'msg' && e.type === 'user' && typeof e.content === 'string')
    .map((e) => ({ turn: e.turn, priority: e.priority, content: e.content, isSynthetic: e.isSynthetic }));
  rec.data.resultTexts = { r1: r1?.result, r2: r2?.result, turn1: turnTexts(rec, 1), turn2: turnTexts(rec, 2) };
  rec.data.resultsAfterContext = resultsAfterContext;
  rec.data.assistantAfterContext = assistantAfterContext;

  const all = `${r1?.result ?? ''} || ${r2?.result ?? ''}`;
  checks.shouldQueryFalseStartedNoTurn = assistantAfterContext === 0 && (!contextResult || contextResult.num_turns === 0);
  checks.modelSawContextFact = /PINEAPPLE-42/.test(r1?.result ?? '') || /PINEAPPLE-42/.test(all);
  checks.injectedMidTurn = injected;
  rec.data.observed = {
    mangoInTurn1: /MANGO/i.test(r1?.result ?? ''),
    kiwiInTurn1: /KIWI/i.test(r1?.result ?? ''),
    secondTurnRan: Boolean(r2),
    mangoInTurn2: /MANGO/i.test(r2?.result ?? ''),
    kiwiInTurn2: /KIWI/i.test(r2?.result ?? ''),
  };
  status = Object.values(checks).every(Boolean) ? 'PASS' : 'FAIL';
} catch (e) {
  rec.data.error = String(e?.message ?? e);
}

stop();
rec.finish(status, { checks });
