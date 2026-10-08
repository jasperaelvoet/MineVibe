// Check (b): tool routing (PLAN §6.1/§6.2). disallowedTools + toolAliases + in-process mc/pc.
//
// Session B1 = production shape (Bash/Read disallowed AND aliased): the model never sees
//   Bash/Read, so this shows what Haiku does when told "use Bash".
// Session B2 = alias forced: Bash/Read stay in the model's tool list but are aliased, so the
//   model really emits "Bash"/"Read" and we see where the call lands and what the hook sees.
//   Fail-closed: the broker denies host built-ins if they ever reach canUseTool.
import {
  BUILTIN_TOOLS,
  DISALLOWED_TOOLS,
  Recorder,
  baseOptions,
  makeGate,
  openSession,
  watchdog,
} from './lib.mjs';

const rec = new Recorder('b-routing');
const sessions = [];
const stop = watchdog(rec, 360_000, () => sessions.forEach((s) => s.q.close()));

function analyse(turns) {
  const toolUses = rec.events
    .filter((e) => e.kind === 'msg' && e.type === 'assistant' && turns.includes(e.turn))
    .flatMap((e) => e.blocks.filter((b) => b.type === 'tool_use').map((b) => ({ turn: e.turn, id: b.id, name: b.name })));
  const toolResults = rec.events
    .filter((e) => e.kind === 'msg' && e.type === 'user' && turns.includes(e.turn) && Array.isArray(e.content))
    .flatMap((e) => e.content.filter((c) => c.type === 'tool_result'));
  const withResults = toolUses.map((u) => {
    const r = toolResults.find((x) => x.tool_use_id === u.id);
    return { ...u, result: r?.text, is_error: r?.is_error, landedOnPc: Boolean(r?.text?.includes('FAKE-PC')) };
  });
  return {
    modelEmitted: withResults,
    hookSaw: rec.hookCalls.filter((h) => turns.includes(h.turn)).map((h) => ({
      turn: h.turn,
      tool_name: h.tool_name,
      tool_use_id: h.tool_use_id,
      has_permission_mode: h.has_permission_mode,
      permission_mode: h.permission_mode,
      effort: h.effort,
      mcp_server: h.mcp_server,
      tool_input_keys: h.tool_input_keys,
    })),
    canUseToolSaw: rec.canUseToolCalls.filter((c) => turns.includes(c.turn)).map((c) => ({ turn: c.turn, toolName: c.toolName, decisionReason: c.decisionReason })),
    handlerRan: rec.handlerCalls.filter((h) => turns.includes(h.turn)).map((h) => ({ turn: h.turn, tool: h.tool, args: h.args })),
  };
}

let status = 'FAIL';
const checks = {};
try {
  // ---- B1: production shape
  const b1 = openSession(rec, baseOptions(rec, { maxTurns: 4 }));
  sessions.push(b1);
  rec.turn = 1;
  b1.send('Use the Bash tool to run: echo hi. Then reply with only the command output.');
  await b1.nextResult(120_000);
  rec.turn = 2;
  b1.send('Use the Read tool to read /tmp/x.txt. Then reply with only its first line.');
  await b1.nextResult(120_000);
  rec.data.b1Init = rec.inits[0] && { tools: rec.inits[0].tools };
  await b1.close();
  rec.data.B1 = analyse([1, 2]);

  // ---- B2: alias forced (Bash/Read visible to the model, aliased to pc)
  const visible = ['Bash', 'Read', ...BUILTIN_TOOLS];
  const b2 = openSession(
    rec,
    baseOptions(rec, {
      maxTurns: 5,
      tools: visible,
      disallowedTools: DISALLOWED_TOOLS.filter((t) => t !== 'Bash' && t !== 'Read'),
      // Gate: allow mc/pc, no decision for anything else (so we can see which name reaches it).
      hooks: { PreToolUse: [{ hooks: [makeGate(rec)] }] },
    }),
  );
  sessions.push(b2);
  rec.turn = 3;
  b2.send('Use the Bash tool to run: echo hi. Then use the Read tool to read /tmp/x.txt. Reply with both outputs on one line.');
  await b2.nextResult(150_000);
  rec.data.b2Init = rec.inits.find((i) => i.turn === 3) && { tools: rec.inits.find((i) => i.turn === 3).tools };
  await b2.close();
  rec.data.B2 = analyse([3]);

  const B1 = rec.data.B1;
  const B2 = rec.data.B2;
  checks.b1_bashLandedOnPc = B1.handlerRan.some((h) => h.turn === 1 && h.tool === 'mcp__pc__bash');
  checks.b1_readLandedOnPc = B1.handlerRan.some((h) => h.turn === 2 && h.tool === 'mcp__pc__read');
  checks.b2_bashLandedOnPc = B2.handlerRan.some((h) => h.tool === 'mcp__pc__bash');
  checks.b2_readLandedOnPc = B2.handlerRan.some((h) => h.tool === 'mcp__pc__read');
  checks.noHostBuiltinExecuted = [...B1.modelEmitted, ...B2.modelEmitted]
    .filter((u) => ['Bash', 'Read'].includes(u.name))
    .every((u) => u.landedOnPc);
  checks.hookSawPermissionMode = rec.hookCalls.length > 0 && rec.hookCalls.every((h) => h.has_permission_mode);
  status = Object.values(checks).every(Boolean) ? 'PASS' : 'FAIL';
} catch (e) {
  rec.data.error = String(e?.message ?? e);
}

stop();
rec.finish(status, { checks });
