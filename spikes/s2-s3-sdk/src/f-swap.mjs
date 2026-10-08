// Check (f) = spike S3: turn-boundary model/effort swap in ONE streaming session (PLAN §6.3).
//   turn 1: haiku/xhigh  ->  applyFlagSettings({model: opus, effortLevel: medium})
//   turn 2: opus/medium  ->  applyFlagSettings({model: haiku, effortLevel: xhigh})
//   turn 3: haiku/xhigh
// Evidence per turn: assistant message.model, PreToolUse input.effort.level (the CLI's applied
// effort), init re-emissions, thinking blocks / thinking_tokens, per-model usage deltas, and the
// Pre/PostModelSwitch hooks. If applyFlagSettings is missing or throws, fall back to the T3
// pattern: close() + resume with explicit model/effort options.
import { HAIKU, OPUS, Recorder, baseOptions, makeGate, makeLogHook, openSession, watchdog } from './lib.mjs';

const rec = new Recorder('f-swap');
let session;
const stop = watchdog(rec, 420_000, () => session?.q.close());

const STATES = {
  wandering: { model: HAIKU, effortLevel: 'xhigh' },
  seated: { model: OPUS, effortLevel: 'medium' },
};

function options(extra = {}) {
  return baseOptions(rec, {
    persistSession: true, // needed for the T3 resume fallback
    maxTurns: 4,
    maxBudgetUsd: 1.5,
    hooks: {
      PreToolUse: [{ hooks: [makeGate(rec)] }],
      PreModelSwitch: [{ hooks: [makeLogHook(rec)] }],
      PostModelSwitch: [{ hooks: [makeLogHook(rec)] }],
    },
    ...extra,
  });
}

let lastModelUsage = {};
function turnEvidence(turn, result) {
  const usageDelta = {};
  for (const [model, u] of Object.entries(result?.modelUsage ?? {})) {
    const prev = lastModelUsage[model] ?? {};
    usageDelta[model] = {
      outputTokens: u.outputTokens - (prev.outputTokens ?? 0),
      thinkingTokens: (u.thinkingTokens ?? 0) - (prev.thinkingTokens ?? 0),
      cacheReadInputTokens: u.cacheReadInputTokens - (prev.cacheReadInputTokens ?? 0),
      cacheCreationInputTokens: u.cacheCreationInputTokens - (prev.cacheCreationInputTokens ?? 0),
      costUSD: +(u.costUSD - (prev.costUSD ?? 0)).toFixed(6),
    };
  }
  lastModelUsage = structuredClone(result?.modelUsage ?? {});
  const assistant = rec.events.filter((e) => e.kind === 'msg' && e.type === 'assistant' && e.turn === turn);
  return {
    turn,
    messageModels: [...new Set(assistant.map((e) => e.model))],
    hookEffort: rec.hookCalls.filter((h) => h.turn === turn).map((h) => ({ tool: h.tool_name, effort: h.effort, permission_mode: h.permission_mode })),
    initFrames: rec.inits.filter((i) => i.turn === turn).map((i) => ({ model: i.model, effort: i.effort, permissionMode: i.permissionMode })),
    thinkingBlocks: assistant.flatMap((e) => e.blocks.filter((b) => b.type === 'thinking')).map((b) => b.chars),
    thinkingEstimates: rec.events.filter((e) => e.kind === 'msg' && e.subtype === 'thinking_tokens' && e.turn === turn).map((e) => e.estimated_tokens),
    cacheCreation: assistant.map((e) => e.usage?.cache_creation).filter(Boolean),
    usageDelta,
    result: result && { subtype: result.subtype, num_turns: result.num_turns, text: result.result, duration_ms: result.duration_ms },
  };
}

async function runTurn(turn) {
  rec.turn = turn;
  session.send(`Turn ${turn}: call mcp__mc__status once, then reply with exactly: done ${turn}`);
  const r = await session.nextResult(180_000);
  const ev = turnEvidence(turn, r);
  (rec.data.turns ??= []).push(ev);
  return ev;
}

async function swapTo(stateName) {
  const target = STATES[stateName];
  const t0 = performance.now();
  if (rec.data.mode !== 'fallback') {
    try {
      if (typeof session.q.applyFlagSettings !== 'function') throw new Error('applyFlagSettings missing');
      await session.q.applyFlagSettings({ model: target.model, effortLevel: target.effortLevel });
      (rec.data.swaps ??= []).push({ to: stateName, via: 'applyFlagSettings', ms: +(performance.now() - t0).toFixed(1), ok: true });
      return;
    } catch (e) {
      (rec.data.swaps ??= []).push({ to: stateName, via: 'applyFlagSettings', ok: false, error: String(e?.message ?? e) });
      rec.data.mode = 'fallback';
    }
  }
  // T3 fallback: close + resume with explicit model/effort.
  const resumeId = session.sessionId;
  await session.close();
  session = openSession(rec, options({ resume: resumeId, model: target.model, effort: target.effortLevel, settings: { effortLevel: target.effortLevel } }));
  rec.data.swaps.push({ to: stateName, via: 'close+resume', ms: +(performance.now() - t0).toFixed(1), ok: true });
}

let status = 'FAIL';
const checks = {};
try {
  rec.data.mode = 'applyFlagSettings';
  session = openSession(rec, options());

  const t1 = await runTurn(1);
  await swapTo('seated');
  const t2 = await runTurn(2);
  await swapTo('wandering');
  const t3 = await runTurn(3);

  try {
    const u = await session.q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true });
    rec.data.usageExperimental = {
      topLevelKeys: Object.keys(u ?? {}),
      subscription_type: u?.subscription_type,
      rate_limits_available: u?.rate_limits_available,
      rate_limits: u?.rate_limits,
      session_model_usage_keys: Object.keys(u?.session?.model_usage ?? {}),
    };
  } catch (e) {
    rec.data.usageExperimental = { error: String(e?.message ?? e) };
  }
  await session.close();

  const only = (ev, model) => ev.messageModels.length === 1 && ev.messageModels[0] === model;
  const effortIs = (ev, level) => ev.hookEffort.length > 0 && ev.hookEffort.every((h) => h.effort === level);
  checks.turn1_haiku = only(t1, HAIKU);
  checks.turn1_xhigh = effortIs(t1, 'xhigh');
  checks.turn2_opus = only(t2, OPUS);
  checks.turn2_medium = effortIs(t2, 'medium');
  checks.turn3_haiku = only(t3, HAIKU);
  checks.turn3_xhigh = effortIs(t3, 'xhigh');
  checks.allTurnsSucceeded = [t1, t2, t3].every((t) => t.result?.subtype === 'success');
  status = Object.values(checks).every(Boolean) ? 'PASS' : 'FAIL';
} catch (e) {
  rec.data.error = String(e?.message ?? e);
}

stop();
rec.finish(status, { checks });
