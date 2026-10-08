// Check (c): AskUserQuestion round trip (PLAN §6.4). Gate returns NO decision for the broker
// tool; canUseTool answers with allow + updatedInput {questions, answers}. Single + multi-select.
import { Recorder, baseOptions, makeBroker, openSession, turnTexts, watchdog } from './lib.mjs';

const rec = new Recorder('c-ask');
let session;
const stop = watchdog(rec, 300_000, () => session?.q.close());

// Answer plan per turn: turn 1 single-select, turn 2 multi-select joined with ", ".
const answerFor = {
  1: (q) => 'Option A',
  2: (q) => {
    const labels = q.options.map((o) => o.label);
    const pick = [labels.find((l) => /apple/i.test(l)) ?? labels[0], labels.find((l) => /cherry/i.test(l)) ?? labels.at(-1)];
    return pick.join(', ');
  },
};

const broker = makeBroker(rec, {
  AskUserQuestion: async (input) => {
    const questions = input.questions ?? [];
    const answers = {};
    for (const q of questions) answers[q.question] = answerFor[rec.turn]?.(q) ?? q.options[0].label;
    (rec.data.asked ??= []).push({ turn: rec.turn, questions, answers });
    return { behavior: 'allow', updatedInput: { questions, answers } };
  },
});

let status = 'FAIL';
const checks = {};
try {
  session = openSession(rec, baseOptions(rec, { canUseTool: broker, maxTurns: 4 }));

  rec.turn = 1;
  session.send(
    "Use the AskUserQuestion tool to ask me one single-select question: 'Which option?' with exactly two options, " +
      "labelled 'Option A' and 'Option B'. After I answer, reply with only the label I chose.",
  );
  const r1 = await session.nextResult(120_000);

  rec.turn = 2;
  session.send(
    "Now use AskUserQuestion to ask one multi-select question (multiSelect true): 'Which fruits?' with options " +
      "'Apple', 'Banana' and 'Cherry'. After I answer, reply with only the labels I chose, comma separated.",
  );
  const r2 = await session.nextResult(120_000);
  await session.close();

  const toolResults = (turn) =>
    rec.events
      .filter((e) => e.kind === 'msg' && e.type === 'user' && e.turn === turn && Array.isArray(e.content))
      .flatMap((e) => e.content.filter((c) => c.type === 'tool_result'))
      .map((c) => c.text);
  const hookSaw = rec.hookCalls.map((h) => ({ turn: h.turn, tool_name: h.tool_name, permission_mode: h.permission_mode }));
  rec.data.hookSaw = hookSaw;
  rec.data.toolResultSeenByModel = { 1: toolResults(1), 2: toolResults(2) };
  rec.data.finalText = { 1: r1.result, 2: r2.result, all1: turnTexts(rec, 1), all2: turnTexts(rec, 2) };

  const asked1 = rec.data.asked?.find((a) => a.turn === 1);
  const asked2 = rec.data.asked?.find((a) => a.turn === 2);
  checks.hookFiredNoDecision = hookSaw.some((h) => h.tool_name === 'AskUserQuestion');
  checks.canUseToolReached = rec.canUseToolCalls.filter((c) => c.toolName === 'AskUserQuestion').length >= 2;
  checks.single_modelGotAnswer = /option a/i.test(r1.result ?? '') && !/option b/i.test(r1.result ?? '');
  checks.multi_wasMultiSelect = asked2?.questions?.[0]?.multiSelect === true;
  checks.multi_modelGotAnswer = /apple/i.test(r2.result ?? '') && /cherry/i.test(r2.result ?? '') && !/banana/i.test(r2.result ?? '');
  checks.asked1Present = Boolean(asked1);
  status = Object.values(checks).every(Boolean) ? 'PASS' : 'FAIL';
} catch (e) {
  rec.data.error = String(e?.message ?? e);
}

stop();
rec.finish(status, { checks });
