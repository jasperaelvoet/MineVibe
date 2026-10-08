// Check (d): ExitPlanMode round trip (PLAN §6.4). Session starts in permissionMode 'plan';
// canUseTool captures input.plan, approves with allow + updatedInput, then Node calls
// setPermissionMode('default') and the session must continue with the plan.
import { Recorder, baseOptions, makeBroker, openSession, turnTexts, watchdog } from './lib.mjs';

// Variant "inline" (argv[2]): planModeInstructions ask for the plan inside the ExitPlanMode
// call instead of a plan file, to test whether input.plan can be recovered that way.
const VARIANT = process.argv[2] === 'inline' ? 'inline' : 'default';
const PLAN_INSTRUCTIONS =
  'Do not write any plan file and do not call any write or edit tool while planning. ' +
  'When the plan is ready, call ExitPlanMode and put the complete plan text in its "plan" field.';
const rec = new Recorder(VARIANT === 'inline' ? 'd-plan-inline' : 'd-plan');
rec.data.variant = VARIANT;
let session;
const stop = watchdog(rec, 300_000, () => session?.q.close());

const broker = makeBroker(rec, {
  ExitPlanMode: async (input) => {
    rec.data.exitPlanInput = {
      turn: rec.turn,
      t: rec.t(),
      keys: Object.keys(input ?? {}),
      plan: input?.plan,
      planType: typeof input?.plan,
      other: Object.fromEntries(Object.entries(input ?? {}).filter(([k]) => k !== 'plan')),
    };
    // Approve, then flip the mode once the allow has been handed back (PLAN order).
    setImmediate(async () => {
      const t = rec.t();
      try {
        await session.q.setPermissionMode('default');
        rec.data.setPermissionMode = { ok: true, t, ms: rec.t() - t };
      } catch (e) {
        rec.data.setPermissionMode = { ok: false, t, error: String(e?.message ?? e) };
      }
      rec.event('setPermissionMode', rec.data.setPermissionMode);
    });
    return { behavior: 'allow', updatedInput: input };
  },
});

let status = 'FAIL';
const checks = {};
try {
  session = openSession(
    rec,
    baseOptions(rec, {
      permissionMode: 'plan',
      canUseTool: broker,
      maxTurns: 6,
      ...(VARIANT === 'inline' ? { planModeInstructions: PLAN_INSTRUCTIONS } : {}),
    }),
  );
  rec.turn = 1;
  session.send(
    'Make a 2-line plan. Line 1: "Call mcp__mc__status". Line 2: "Reply DONE". ' +
      'Present it for approval with ExitPlanMode, and once approved carry it out.',
  );
  const r1 = await session.nextResult(150_000);

  const statusAfterApproval = () =>
    rec.handlerCalls.some((h) => h.tool === 'mcp__mc__status' && h.t > (rec.data.exitPlanInput?.t ?? Number.POSITIVE_INFINITY));
  let r2;
  if (!statusAfterApproval()) {
    // Model ended its turn right after approval: nudge once so we still see the session continue.
    rec.turn = 2;
    session.send('The plan is approved. Carry it out now.');
    r2 = await session.nextResult(120_000);
  }
  await session.close();

  rec.data.hookSaw = rec.hookCalls.map((h) => ({ turn: h.turn, t: h.t, tool_name: h.tool_name, permission_mode: h.permission_mode, effort: h.effort }));
  rec.data.modelsWhileInPlan = [...new Set(rec.assistantModels.map((m) => m.model))];
  rec.data.finalText = { r1: r1?.result, r2: r2?.result, turn1: turnTexts(rec, 1), turn2: turnTexts(rec, 2) };
  rec.data.initPermissionModes = rec.inits.map((i) => ({ turn: i.turn, permissionMode: i.permissionMode }));

  const exitHook = rec.hookCalls.find((h) => h.tool_name === 'ExitPlanMode');
  const afterHooks = rec.hookCalls.filter((h) => h.t > (rec.data.exitPlanInput?.t ?? Number.POSITIVE_INFINITY));
  checks.hookSawPlanMode = exitHook?.permission_mode === 'plan';
  checks.canUseToolReached = rec.canUseToolCalls.some((c) => c.toolName === 'ExitPlanMode');
  checks.planTextPresent = typeof rec.data.exitPlanInput?.plan === 'string' && rec.data.exitPlanInput.plan.length > 0;
  checks.setPermissionModeOk = rec.data.setPermissionMode?.ok === true;
  checks.continuedAfterApproval = statusAfterApproval();
  checks.defaultModeAfter = afterHooks.length > 0 && afterHooks.every((h) => h.permission_mode === 'default');
  checks.repliedDone = /done/i.test(`${r1?.result ?? ''} ${r2?.result ?? ''}`);
  status = Object.values(checks).every(Boolean) ? 'PASS' : 'FAIL';
} catch (e) {
  rec.data.error = String(e?.message ?? e);
}

stop();
rec.finish(status, { checks });
