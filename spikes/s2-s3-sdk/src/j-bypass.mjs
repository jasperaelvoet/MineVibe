// Check (j): bypassPermissions (USER DECISION 2026-10-08). In-game agents run with permissionMode
// 'bypassPermissions' + allowDangerouslySkipPermissions: true; the PreToolUse hook (ToolGate) stays the
// authoritative, fail-closed sandbox guard. Two short Haiku sessions in the production option shape (no allowedTools,
// tools without EnterPlanMode), at most 3 user turns:
//
//  A (bypass)     (a) PreToolUse still runs for every call and a hook deny still blocks it (the handler never runs);
//                 (b) AskUserQuestion still reaches canUseTool and the answers reach the model.
//                 Also recorded: what happens to an mc/pc call the hook gives NO decision for (a ToolGate bug).
//  B (plan-first) setPermissionMode('plan') as Node does at the sit boundary, then (c) ExitPlanMode still reaches
//                 canUseTool; after approval Node returns to 'bypassPermissions' (never 'default') and the hooks see it.
//
//   node spikes/s2-s3-sdk/src/j-bypass.mjs         A + B; B returns to bypass after handing back the allow (S2 order)
//   node spikes/s2-s3-sdk/src/j-bypass.mjs order   B only, in the production InteractionBroker order: Node awaits
//                                                  setPermissionMode('bypassPermissions') BEFORE returning the allow
// (SDK-bundled claude; nothing secret is printed or persisted)
import { Recorder, baseOptions, makeBroker, makeGate, openSession, sleep, turnTexts, watchdog } from './lib.mjs';

const VARIANT = process.argv[2] === 'order' ? 'order' : 'full';
const rec = new Recorder(VARIANT === 'order' ? 'j-bypass-order' : 'j-bypass');
rec.data.variant = VARIANT;
let session;
const stop = watchdog(rec, 360_000, () => session?.q.close());

/** The production option shape (apps/server/src/agents/sessionOptions.ts) under bypass. */
function bypassOptions(overrides) {
  const opts = baseOptions(rec, {
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    tools: ['AskUserQuestion', 'ExitPlanMode'],
    settings: { effortLevel: 'low' },
    maxTurns: 8,
    ...overrides,
  });
  delete opts.allowedTools; // production has none (S2: allowedTools would shadow canUseTool)
  return opts;
}

const toolResults = (turn) =>
  rec.events
    .filter((e) => e.kind === 'msg' && e.type === 'user' && e.turn === turn && Array.isArray(e.content))
    .flatMap((e) => e.content.filter((c) => c.type === 'tool_result'));
const toolUseIds = (turn, name) =>
  rec.events
    .filter((e) => e.kind === 'msg' && e.type === 'assistant' && e.turn === turn)
    .flatMap((e) => e.blocks.filter((b) => b.type === 'tool_use' && b.name === name).map((b) => b.id));

let status = 'FAIL';
const checks = {};
const info = {};
try {
  // ------------------------------------------------------------------ A: bypass, deny, no-decision, AskUserQuestion
  if (VARIANT === 'full') {
  const gateA = makeGate(rec, (input) => {
    switch (input.tool_name) {
      case 'mcp__mc__status':
        return { decision: 'allow', reason: 'spike ToolGate: allowed' };
      case 'mcp__pc__bash':
        return { decision: 'deny', reason: 'SPIKE-GATE-DENY: not seated at a PC' };
      default:
        return null; // mcp__pc__read (simulated gate bug) and AskUserQuestion: no decision
    }
  });
  const brokerA = makeBroker(rec, {
    AskUserQuestion: async (input) => {
      const questions = input.questions ?? [];
      const answers = {};
      for (const q of questions) answers[q.question] = 'Blue';
      rec.data.asked = { questions, answers };
      return { behavior: 'allow', updatedInput: { questions, answers } };
    },
    mcp__pc__read: async () => ({ behavior: 'deny', message: 'SPIKE-BROKER-DENY: no decision reached canUseTool' }),
  });
  session = openSession(rec, bypassOptions({ hooks: { PreToolUse: [{ hooks: [gateA] }] }, canUseTool: brokerA }));
  rec.turn = 1;
  session.send(
    'Do these four steps in order, one tool call at a time, even if a step fails: ' +
      '1) call mcp__mc__status. 2) call mcp__pc__bash with command "echo hello". ' +
      '3) call mcp__pc__read with file_path "/tmp/spike.txt". ' +
      "4) use AskUserQuestion to ask me one single-select question 'Which colour?' with exactly two options " +
      "labelled 'Red' and 'Blue'. Then reply with only the colour I chose.",
  );
  const rA = await session.nextResult(150_000);
  await session.close();

  const hooksA = rec.hookCalls.filter((h) => h.turn === 1);
  const hookFor = (name) => hooksA.find((h) => h.tool_name === name);
  const handlerA = rec.handlerCalls.filter((h) => h.turn === 1).map((h) => h.tool);
  const bashIds = new Set(toolUseIds(1, 'mcp__pc__bash'));
  const bashResult = toolResults(1).find((r) => bashIds.has(r.tool_use_id));
  rec.data.initA = rec.inits[0] && { permissionMode: rec.inits[0].permissionMode, tools: rec.inits[0].tools };
  rec.data.hookSawA = hooksA.map((h) => ({ tool_name: h.tool_name, permission_mode: h.permission_mode }));
  rec.data.handlersA = handlerA;
  rec.data.bashResult = bashResult;
  rec.data.finalA = { result: rA?.result, texts: turnTexts(rec, 1), denials: rA?.permission_denials };

  checks.a_initBypass = rec.inits[0]?.permissionMode === 'bypassPermissions';
  checks.a_hookRanUnderBypass = ['mcp__mc__status', 'mcp__pc__bash', 'AskUserQuestion'].every(
    (n) => hookFor(n)?.permission_mode === 'bypassPermissions',
  );
  checks.a_allowRan = handlerA.includes('mcp__mc__status');
  checks.a_denyBlocked = !handlerA.includes('mcp__pc__bash') && bashResult?.is_error === true;
  checks.a_denyReasonReachedModel = /SPIKE-GATE-DENY/.test(bashResult?.text ?? '');
  checks.b_askReachedCanUseTool = rec.canUseToolCalls.some((c) => c.turn === 1 && c.toolName === 'AskUserQuestion');
  checks.b_modelGotAnswer = /blue/i.test(rA?.result ?? '') && !/\bred\b/i.test(rA?.result ?? '');
  info.noDecision_reachedCanUseTool = rec.canUseToolCalls.some((c) => c.turn === 1 && c.toolName === 'mcp__pc__read');
  info.noDecision_handlerRan = handlerA.includes('mcp__pc__read');
  info.noDecision_hookSaw = Boolean(hookFor('mcp__pc__read'));
  }

  // ------------------------------------------------------------------ B: plan-first under bypass, ExitPlanMode
  let approvedAt = null;
  const gateB = makeGate(rec, (input) =>
    input.tool_name?.startsWith('mcp__mc__') || input.tool_name?.startsWith('mcp__pc__')
      ? { decision: 'allow', reason: 'spike ToolGate: allowed (plan file captured)' }
      : null,
  );
  const brokerB = makeBroker(rec, {
    ExitPlanMode: async (input) => {
      rec.data.exitPlanInput = { turn: rec.turn, t: rec.t(), keys: Object.keys(input ?? {}) };
      approvedAt = rec.t();
      if (VARIANT === 'order') {
        // Production order (InteractionBroker): the mode switch is awaited before the allow is returned.
        const t = rec.t();
        try {
          await session.q.setPermissionMode('bypassPermissions');
          rec.data.backToBypass = { ok: true, t, ms: rec.t() - t, order: 'before_allow' };
        } catch (e) {
          rec.data.backToBypass = { ok: false, t, error: String(e?.message ?? e) };
        }
        rec.event('setPermissionMode', rec.data.backToBypass);
        return { behavior: 'allow', updatedInput: input };
      }
      // Approve, then return to bypassPermissions once the allow is handed back (the S2 d-plan order).
      setImmediate(async () => {
        const t = rec.t();
        try {
          await session.q.setPermissionMode('bypassPermissions');
          rec.data.backToBypass = { ok: true, t, ms: rec.t() - t };
        } catch (e) {
          rec.data.backToBypass = { ok: false, t, error: String(e?.message ?? e) };
        }
        rec.event('setPermissionMode', rec.data.backToBypass);
      });
      return { behavior: 'allow', updatedInput: input };
    },
  });
  session = openSession(rec, bypassOptions({ hooks: { PreToolUse: [{ hooks: [gateB] }] }, canUseTool: brokerB }));
  // The sit boundary of a plan-first agent: Node switches the running session to plan mode.
  try {
    await session.q.setPermissionMode('plan');
    rec.data.toPlan = { ok: true };
  } catch (e) {
    rec.data.toPlan = { ok: false, error: String(e?.message ?? e) };
  }
  rec.turn = 2;
  session.send(
    'Make a 2-line plan. Line 1: "Call mcp__mc__status". Line 2: "Reply DONE". ' +
      'Present it for approval with ExitPlanMode, and once approved carry it out.',
  );
  const rB = await session.nextResult(150_000);
  const statusAfterApproval = () =>
    rec.handlerCalls.some((h) => h.tool === 'mcp__mc__status' && approvedAt !== null && h.t > approvedAt);
  let rB2;
  if (!statusAfterApproval() && approvedAt !== null) {
    rec.turn = 3;
    session.send('The plan is approved. Carry it out now.');
    rB2 = await session.nextResult(120_000);
  }
  await sleep(200);
  await session.close();

  const hooksB = rec.hookCalls.filter((h) => h.turn >= 2);
  const exitHook = hooksB.find((h) => h.tool_name === 'ExitPlanMode');
  const afterHooks = hooksB.filter((h) => approvedAt !== null && h.t > approvedAt);
  const exitIds = new Set([...toolUseIds(2, 'ExitPlanMode'), ...toolUseIds(3, 'ExitPlanMode')]);
  const exitResult = [...toolResults(2), ...toolResults(3)].find((r) => exitIds.has(r.tool_use_id));
  rec.data.hookSawB = hooksB.map((h) => ({ turn: h.turn, tool_name: h.tool_name, permission_mode: h.permission_mode }));
  rec.data.exitResult = exitResult;
  rec.data.finalB = { r: rB?.result, r2: rB2?.result, texts: [...turnTexts(rec, 2), ...turnTexts(rec, 3)] };

  checks.c_setPlanOk = rec.data.toPlan?.ok === true;
  checks.c_exitHookSawPlan = exitHook?.permission_mode === 'plan';
  checks.c_exitReachedCanUseTool = rec.canUseToolCalls.some((c) => c.turn >= 2 && c.toolName === 'ExitPlanMode');
  checks.c_exitAllowedNotError = exitResult !== undefined && exitResult.is_error !== true;
  checks.c_backToBypassOk = rec.data.backToBypass?.ok === true;
  checks.c_continuedAfterApproval = statusAfterApproval();
  checks.c_bypassAfterApproval =
    afterHooks.length > 0 && afterHooks.every((h) => h.permission_mode === 'bypassPermissions');
  status = Object.values(checks).every(Boolean) ? 'PASS' : 'FAIL';
} catch (e) {
  rec.data.error = String(e?.message ?? e);
}

stop();
rec.finish(status, { checks, info });
console.log(JSON.stringify({ checks, info }, null, 2));
process.exit(0);
