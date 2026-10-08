// Live driver: `node src/live.mjs <m1|m2|m3|m4> [--dry]`
//
// Three model turns per mechanism, each with the model/effort swap of the real brain:
//   T1 wander (Haiku xhigh)  -> switch -> T2 seated (Opus medium) -> switch -> T3 wander (Haiku xhigh)
//
//   m1  applyFlagSettings({model, effortLevel, permissions:{deny}})        (flag-layer deny rules)
//   m2  setMcpServers: pc removed/added + applyFlagSettings({model, effortLevel})
//   m3  close() + resume with per-mode options (disallowedTools, model, effort, persona)
//   m4  MCP-native RegisteredTool.enable()/disable() (tools/list_changed) + applyFlagSettings({model, effortLevel})
//
// Evidence per turn: system/init.tools, the model's own verbatim tool list, a deliberate call of a tool that
// should be hidden, a call of a tool that should be visible, the codeword from T1 (conversation kept), and the
// first API call's cache read/write. `--dry` swaps every model turn for a zero-cost init probe (plumbing check).
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  applyProfileToServers,
  baseOptions,
  budgetLeft,
  claimTurn,
  makeGate,
  makeServers,
  OUT,
  openSession,
  Recorder,
  sanitize,
  serverView,
  sleep,
  timed,
  turnEvidence,
  watchdog,
} from './lib.mjs';
import {
  compareTools,
  DISALLOWED_TOOLS,
  denyRules,
  managedOnly,
  profile,
  visibleTools,
} from './profiles.mjs';

const mechName = process.argv[2];
const dry = process.argv.includes('--dry');
if (!['m1', 'm2', 'm3', 'm4'].includes(mechName)) {
  console.error('usage: node src/live.mjs <m1|m2|m3|m4> [--dry]');
  process.exit(1);
}

const rec = new Recorder(`${mechName}${dry ? '-dry' : ''}`);
const cwd = mkdtempSync(join(OUT, `cwd-${rec.check}-`));
let current = profile('wander');
const gate = makeGate(rec, () => current);
let session;
let servers;
const stop = watchdog(rec, 600_000, () => session?.q.close());

const CODEWORD = 'ALPHA-7';
const TURNS = [
  {
    profile: 'wander',
    hiddenProbe: null,
    visibleProbe: null,
    prompt:
      `Turn 1 (harness check). The codeword is ${CODEWORD}. Do not call any tool. Reply with exactly one line: ` +
      'tools=<the exact names of ALL tools you can call right now, comma-separated, verbatim>',
  },
  {
    profile: 'seated',
    hiddenProbe: 'mcp__mc__goto',
    visibleProbe: 'mcp__pc__bash',
    prompt:
      'Turn 2 (harness check). Do these steps in order. ' +
      '1) Emit a tool call to mcp__mc__goto with {"x":1,"y":64,"z":1} even if that tool is not in your tool list; ' +
      'this deliberately tests the harness. ' +
      '2) Call mcp__pc__bash with {"command":"echo seated"}. ' +
      '3) Reply with exactly one line: codeword=<the codeword from turn 1>; goto=<what happened>; ' +
      'tools=<the exact names of ALL tools you can call right now, comma-separated, verbatim>',
  },
  {
    profile: 'wander',
    hiddenProbe: 'mcp__pc__bash',
    visibleProbe: 'mcp__mc__goto',
    prompt:
      'Turn 3 (harness check). Do these steps in order. ' +
      '1) Emit a tool call to mcp__pc__bash with {"command":"echo wander"} even if that tool is not in your tool list; ' +
      'this deliberately tests the harness. ' +
      '2) Call mcp__mc__goto with {"x":2,"y":64,"z":2}. ' +
      '3) Reply with exactly one line: pc=<what happened>; ' +
      'tools=<the exact names of ALL tools you can call right now, comma-separated, verbatim>',
  },
];

// ---------------------------------------------------------------- mechanisms

async function waitFor(pred, ms = 5000, step = 25) {
  const t0 = performance.now();
  while (performance.now() - t0 < ms) {
    if (await pred()) return +(performance.now() - t0).toFixed(1);
    await sleep(step);
  }
  return null;
}

/** Waits until mcpServerStatus() lists exactly `counts` tools per server (the CLI re-listed). */
const waitToolCounts = (counts) =>
  waitFor(async () => {
    const v = await serverView(session.q);
    return Object.entries(counts).every(
      ([name, n]) => (v.find((s) => s.name === name)?.tools.length ?? 0) === n,
    );
  });

const swapFlags = (p) => session.q.applyFlagSettings({ model: p.model, effortLevel: p.effort });

const MECHS = {
  m1: {
    open(p) {
      servers = makeServers(rec);
      return openSession(
        rec,
        baseOptions(rec, p, {
          cwd,
          servers,
          gate,
          settings: { effortLevel: p.effort, permissions: { deny: denyRules(p) } },
        }),
      );
    },
    async switchTo(p) {
      const r = await timed(() =>
        session.q.applyFlagSettings({
          model: p.model,
          effortLevel: p.effort,
          permissions: { deny: denyRules(p) },
        }),
      );
      return { applyFlagSettingsMs: r.ms };
    },
  },
  m2: {
    open(p) {
      servers = makeServers(rec);
      return openSession(rec, baseOptions(rec, p, { cwd, servers: { mc: servers.mc }, gate }));
    },
    async switchTo(p) {
      const map = p.pc ? { mc: servers.mc, pc: servers.pc } : { mc: servers.mc };
      const set = await timed(() => session.q.setMcpServers(map));
      const flags = await timed(() => swapFlags(p));
      const settleMs = p.pc ? await waitToolCounts({ pc: 7 }) : 0;
      return {
        setMcpServersMs: set.ms,
        setResult: set.value,
        applyFlagSettingsMs: flags.ms,
        connectMs: settleMs,
      };
    },
  },
  m3: {
    open(p, resume) {
      servers = makeServers(rec);
      return openSession(
        rec,
        baseOptions(rec, p, {
          cwd,
          servers,
          gate,
          persona: p.persona,
          persistSession: true,
          disallowedTools: [...DISALLOWED_TOOLS, ...denyRules(p)],
          ...(resume ? { resume } : {}),
        }),
      );
    },
    async switchTo(p) {
      const resumeId = session.sessionId;
      const c = await timed(() => session.close());
      const o = await timed(async () => {
        session = MECHS.m3.open(p, resumeId);
        return session.q.initializationResult();
      });
      return { resumeId, closeMs: c.ms, reopenToInitMs: o.ms, totalMs: +(c.ms + o.ms).toFixed(1) };
    },
  },
  m4: {
    open(p) {
      servers = makeServers(rec);
      applyProfileToServers(servers, p); // before connect: the first tools/list already has the subset
      // persistSession as in production, so the transcript shows what the tool-list change injects.
      return openSession(rec, baseOptions(rec, p, { cwd, servers, gate, persistSession: true }));
    },
    async switchTo(p) {
      const t = await timed(() => applyProfileToServers(servers, p));
      const flags = await timed(() => swapFlags(p));
      const relistMs = await waitToolCounts({ mc: p.mc.length, pc: p.pc ? 7 : 0 });
      return { toggled: t.value, toggleMs: t.ms, applyFlagSettingsMs: flags.ms, relistMs };
    },
  },
};

// What each mechanism can express at all (the rest of the profile is up to the ToolGate).
const CAN = {
  m1: (p) => visibleTools(p),
  m2: (p) => visibleTools({ ...p, mc: profile('wander').mc, web: true }),
  m3: (p) => visibleTools(p),
  m4: (p) => visibleTools({ ...p, web: true }),
};

// ---------------------------------------------------------------- run

const mech = MECHS[mechName];

async function runTurn(i) {
  const spec = TURNS[i];
  rec.turn = i + 1;
  if (dry) {
    const init = await session.probeInit(`dry turn ${i + 1}`);
    return { turn: i + 1, dry: true, initTools: managedOnly(init?.tools ?? []), initModel: init?.model };
  }
  const n = claimTurn(`${mechName} T${i + 1} ${spec.profile}`);
  console.log(`[${mechName}] live turn ${i + 1} (spike budget ${n}/12)`);
  session.send(spec.prompt);
  const r = await session.nextResult(240_000);
  return turnEvidence(rec, i + 1, r);
}

function grade(i, ev) {
  const spec = TURNS[i];
  const p = profile(spec.profile);
  const ideal = managedOnly(visibleTools(p));
  const g = {
    profile: p.name,
    init_vs_ideal: compareTools(ideal, ev.initTools ?? []),
    init_vs_capability: compareTools(managedOnly(CAN[mechName](p)), ev.initTools ?? []),
  };
  if (ev.dry) return g;
  g.listed_vs_ideal = compareTools(ideal, managedOnly(ev.listed));
  g.models = ev.models;
  g.modelOk = ev.models.length === 1 && ev.models[0] === p.model;
  g.effortSeenByGate = [...new Set(ev.gate.map((x) => x.effort))];
  if (spec.hiddenProbe) {
    g.hiddenProbe = {
      tool: spec.hiddenProbe,
      emitted: ev.toolUses.some((u) => u.name === spec.hiddenProbe),
      handlerRan: ev.handlers.includes(spec.hiddenProbe),
      gate: ev.gate.filter((x) => x.tool === spec.hiddenProbe).map((x) => x.decision),
      errors: ev.toolResults.filter((r) => r.is_error).map((r) => r.text),
    };
  }
  if (spec.visibleProbe) {
    g.visibleProbe = { tool: spec.visibleProbe, handlerRan: ev.handlers.includes(spec.visibleProbe) };
  }
  if (i === 1) g.codewordKept = ev.reply.includes(CODEWORD);
  return g;
}

const snippet = (v, n = 360) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s && s.length > n ? `${s.slice(0, n)}…` : s;
};

/**
 * Summary of the persisted transcript (production uses persistSession:true): entry kinds, duplicate uuids, and a
 * short snippet of every entry that is not a plain user/assistant turn message (attachments, meta, local
 * commands) — that is where tool-list deltas and model-switch notices land.
 */
function transcriptSummary(sessionId) {
  const dir = join(homedir(), '.claude', 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'));
  if (!existsSync(dir)) return { dir: '[not found]' };
  const files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
  const out = { files: files.length, sessions: {} };
  for (const f of files) {
    const lines = readFileSync(join(dir, f), 'utf8').split('\n').filter(Boolean);
    const types = {};
    const uuids = new Map();
    const notable = [];
    for (const l of lines) {
      let e;
      try {
        e = JSON.parse(l);
      } catch {
        types['<bad json>'] = (types['<bad json>'] ?? 0) + 1;
        continue;
      }
      let k = String(e.type);
      if (e.type === 'system' && e.subtype) k = `system/${e.subtype}`;
      if (e.type === 'attachment' && e.attachment?.type) k = `attachment/${e.attachment.type}`;
      if (e.isSidechain) k += '(sidechain)';
      if (e.isMeta) k += '(meta)';
      types[k] = (types[k] ?? 0) + 1;
      if (e.uuid) uuids.set(e.uuid, (uuids.get(e.uuid) ?? 0) + 1);
      const content = e.message?.content;
      const plainUserText =
        e.type === 'user' && !e.isMeta && typeof content === 'string' && !content.startsWith('<');
      const plainUserBlocks = e.type === 'user' && !e.isMeta && Array.isArray(content);
      if (e.type !== 'assistant' && !plainUserText && !plainUserBlocks) {
        notable.push({
          kind: k,
          text: sanitize(snippet(e.attachment ?? content ?? e.content ?? Object.keys(e))),
        });
      }
    }
    out.sessions[f.replace('.jsonl', '') === sessionId ? 'main' : f] = {
      lines: lines.length,
      types,
      duplicateUuids: [...uuids.values()].filter((n) => n > 1).length,
      notable: notable.slice(0, 80),
    };
  }
  return { projectDir: sanitize(dir.replace(homedir(), '~')), ...out };
}

let status = 'FAIL';
try {
  if (!dry && budgetLeft() < TURNS.length)
    throw new Error(`only ${budgetLeft()} live turns left; ${mechName} needs ${TURNS.length}`);
  current = profile(TURNS[0].profile);
  const o = await timed(async () => {
    session = mech.open(current);
    return session.q.initializationResult();
  });
  rec.data.openMs = o.ms;
  const firstSessionId = () => session.sessionId;

  const evidence = [];
  const grades = [];
  for (let i = 0; i < TURNS.length; i++) {
    const p = profile(TURNS[i].profile);
    if (i > 0) {
      current = p;
      const sw = await mech.switchTo(p);
      rec.append('switches', { before_turn: i + 1, to: p.name, ...sw });
      console.log(`[${mechName}] switch -> ${p.name}`, JSON.stringify(sw));
    }
    const ev = await runTurn(i);
    evidence.push(ev);
    const g = grade(i, ev);
    grades.push(g);
    console.log(`[${mechName}] T${i + 1}`, JSON.stringify(g));
  }
  rec.data.sessionIds = [...new Set(rec.inits.map((x) => x.session_id))];
  if (mechName === 'm3' || mechName === 'm4') rec.data.transcript = transcriptSummary(firstSessionId());
  await session.close();
  session = undefined;
  rec.data.turns = evidence;
  rec.data.grades = grades;
  status = 'DONE';
} catch (e) {
  rec.data.error = String(e?.stack ?? e);
  console.error(e);
  await session?.close().catch(() => {});
}
stop();
rec.finish(status);
