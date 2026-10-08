// Preflight (ZERO model turns): the tool list the CLI would send next, per mechanism.
//
// Probe = a `shouldQuery:false` context message: the CLI re-emits system/init (tools as filtered for the next
// request) plus a zero-turn result, with no API call (S2 check e). getContextUsage({detail:'summary'}) and
// mcpServerStatus() are recorded too (no API call either) for deferral, connection state and token estimates.
//
//   P1  (M1) applyFlagSettings({model, effortLevel, permissions:{deny}}): wander -> seated -> meeting -> wander
//            -> rule spelling 'mcp__pc__*' -> permissions:null
//   P1b (M1) built-in names (Bash/Read/...) passed in options.tools: can the flag layer toggle them?
//   P2  (M2) setMcpServers: {mc} -> {mc, pc(new)} -> {mc} -> {mc, pc(same instance)} -> {mc(subset), pc(new)}
//   P3  (M3) a fresh session per profile with disallowedTools = host built-ins + deny rules
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import {
  applyProfileToServers,
  baseOptions,
  contextView,
  makeGate,
  makeServers,
  OUT,
  openSession,
  Recorder,
  serverView,
  sleep,
  timed,
  watchdog,
} from './lib.mjs';
import {
  BUILTIN_TOOLS,
  compareTools,
  DISALLOWED_TOOLS,
  denyRules,
  managedOnly,
  profile,
  visibleTools,
} from './profiles.mjs';

const rec = new Recorder('preflight');
let session;
const stop = watchdog(rec, 300_000, () => session?.q.close());
let current = profile('wander');
const gate = makeGate(rec, () => current);
const checks = {};

async function snap(label, want) {
  const init = await session.probeInit(label);
  const view = await contextView(session.q);
  const servers = await serverView(session.q);
  const initTools = init?.tools ?? [];
  const shown = managedOnly(initTools);
  const diff = compareTools(managedOnly(want), shown);
  const ok = init !== null && diff.missing.length === 0 && diff.extra.length === 0;
  const row = {
    label,
    ok,
    initModel: init?.model,
    ...diff,
    initTools,
    ctxModel: view.model,
    ctxMcpLoaded: view.mcpLoaded,
    ctxMcpDeferred: view.mcpDeferred,
    ctxTotalTokens: view.totalTokens,
    servers: servers.map((s) => ({ name: s.name, status: s.status, n: s.tools.length })),
  };
  rec.append('snaps', row);
  console.log(
    `${label.padEnd(40)} ${ok ? 'OK  ' : 'DIFF'} missing=[${diff.missing}] extra=[${diff.extra}] model=${init?.model} servers=${row.servers.map((s) => `${s.name}:${s.status}:${s.n}`).join(',')}`,
  );
  return row;
}

const cwd = () => mkdtempSync(join(OUT, `cwd-${rec.check}-`));

async function waitConnected(name, ms = 6000) {
  const t0 = performance.now();
  while (performance.now() - t0 < ms) {
    const s = (await serverView(session.q)).find((x) => x.name === name);
    if (s?.status === 'connected') return +(performance.now() - t0).toFixed(1);
    await sleep(100);
  }
  return null;
}

try {
  // ---------------------------------------------------------------- P1: M1 deny rules through the flag layer
  {
    const w = profile('wander');
    const opts = baseOptions(rec, w, {
      cwd: cwd(),
      servers: makeServers(rec),
      gate,
      settings: { effortLevel: w.effort, permissions: { deny: denyRules(w) } },
    });
    const open = await timed(async () => {
      session = openSession(rec, opts);
      return session.q.initializationResult();
    });
    rec.data.p1_open_ms = open.ms;
    checks.p1_wander = (await snap('P1 start wander', visibleTools(w))).ok;
    for (const name of ['seated', 'meeting', 'wander']) {
      const p = profile(name);
      current = p;
      const r = await timed(() =>
        session.q.applyFlagSettings({
          model: p.model,
          effortLevel: p.effort,
          permissions: { deny: denyRules(p) },
        }),
      );
      rec.append('p1_apply_ms', { to: name, ms: r.ms });
      checks[`p1_${name}`] = (await snap(`P1 apply ${name}`, visibleTools(p))).ok;
    }
    // Rule spelling: 'mcp__pc__*' instead of the server-level 'mcp__pc'.
    await session.q.applyFlagSettings({
      permissions: { deny: denyRules(w).map((r) => (r === 'mcp__pc' ? 'mcp__pc__*' : r)) },
    });
    checks.p1_wildcard_rule = (await snap('P1 deny mcp__pc__* (wildcard)', visibleTools(w))).ok;
    // permissions:null clears the flag-layer rules: everything the session registered comes back.
    await session.q.applyFlagSettings({ permissions: null });
    checks.p1_null_restores_all = (
      await snap('P1 permissions:null', visibleTools({ ...profile('seated'), mc: w.mc }))
    ).ok;
    await session.close();
    session = undefined;
  }

  // ---------------------------------------------------------------- P1b: built-in aliased names toggled by M1
  {
    const w = profile('wander');
    const ALIASED = ['Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep'];
    const opts = baseOptions(rec, w, {
      cwd: cwd(),
      servers: makeServers(rec),
      gate,
      tools: [...BUILTIN_TOOLS, ...ALIASED],
      disallowedTools: DISALLOWED_TOOLS.filter((t) => !ALIASED.includes(t)),
      settings: { effortLevel: w.effort, permissions: { deny: [...denyRules(w), ...ALIASED] } },
    });
    session = openSession(rec, opts);
    await session.q.initializationResult();
    const a = await snap('P1b wander (Bash.. denied)', visibleTools(w));
    const s = profile('seated');
    await session.q.applyFlagSettings({
      model: s.model,
      effortLevel: s.effort,
      permissions: { deny: denyRules(s) },
    });
    const b = await snap('P1b seated (Bash.. allowed)', visibleTools(s));
    rec.data.p1b = {
      wanderHasBash: a.initTools.includes('Bash'),
      seatedHasBash: b.initTools.includes('Bash'),
      seatedAliased: ALIASED.filter((t) => b.initTools.includes(t)),
    };
    checks.p1b_aliases_toggle =
      !rec.data.p1b.wanderHasBash && rec.data.p1b.seatedAliased.length === ALIASED.length;
    console.log('P1b', rec.data.p1b);
    await session.close();
    session = undefined;
  }

  // ---------------------------------------------------------------- P2: M2 setMcpServers
  {
    const w = profile('wander');
    current = w;
    const first = makeServers(rec);
    session = openSession(rec, baseOptions(rec, w, { cwd: cwd(), servers: { mc: first.mc }, gate }));
    await session.q.initializationResult();
    const wanderM2 = visibleTools({ ...w, web: true }); // M2 cannot hide built-ins
    const seatedM2 = visibleTools({ ...profile('seated'), mc: w.mc }); // nor single mc tools
    await snap('P2 start {mc}', wanderM2);

    const second = makeServers(rec);
    current = profile('seated');
    const add = await timed(() => session.q.setMcpServers({ mc: first.mc, pc: second.pc }));
    const addConnectMs = await waitConnected('pc');
    rec.data.p2_add = { ms: add.ms, connectMs: addConnectMs, result: add.value };
    const s1 = await snap('P2 add pc (new instance)', seatedM2);
    checks.p2_add_visible = s1.ok && s1.ctxMcpDeferred.length === 0;

    current = w;
    const rm = await timed(() => session.q.setMcpServers({ mc: first.mc }));
    rec.data.p2_remove = { ms: rm.ms, result: rm.value };
    checks.p2_remove_hidden = (await snap('P2 remove pc', wanderM2)).ok;

    current = profile('seated');
    try {
      const readd = await timed(() => session.q.setMcpServers({ mc: first.mc, pc: second.pc }));
      rec.data.p2_readd_same = { ms: readd.ms, connectMs: await waitConnected('pc'), result: readd.value };
    } catch (e) {
      rec.data.p2_readd_same = { error: String(e?.message ?? e) };
    }
    const s3 = await snap('P2 re-add pc (same instance)', seatedM2);
    checks.p2_readd_same_visible = s3.ok && s3.ctxMcpDeferred.length === 0;

    const third = makeServers(rec, { mcSubset: profile('seated').mc });
    const sub = await timed(() => session.q.setMcpServers({ mc: third.mc, pc: third.pc }));
    rec.data.p2_mc_subset = { ms: sub.ms, connectMs: await waitConnected('pc'), result: sub.value };
    checks.p2_mc_subset_applied = (await snap('P2 mc(subset) + pc(new)', visibleTools(profile('seated')))).ok;
    await session.close();
    session = undefined;
  }

  // ---------------------------------------------------------------- P4: MCP-native tool enable/disable (list_changed)
  {
    const w = profile('wander');
    current = w;
    const servers = makeServers(rec);
    session = openSession(rec, baseOptions(rec, w, { cwd: cwd(), servers, gate }));
    await session.q.initializationResult();
    rec.data.p4_initial_disable = applyProfileToServers(servers, w);
    await sleep(300);
    const wantM4 = (p) => visibleTools({ ...p, web: true }); // built-ins are not MCP: still visible
    checks.p4_wander = (await snap('P4 start wander (disabled pre-turn)', wantM4(w))).ok;
    for (const name of ['seated', 'meeting', 'wander']) {
      const p = profile(name);
      current = p;
      const r = await timed(async () => {
        const n = applyProfileToServers(servers, p);
        await session.q.applyFlagSettings({ model: p.model, effortLevel: p.effort });
        return n;
      });
      await sleep(300); // list_changed is a notification: give the CLI a moment to re-list
      rec.append('p4_apply', { to: name, changed: r.value, ms: r.ms });
      const row = await snap(`P4 apply ${name}`, wantM4(p));
      checks[`p4_${name}`] = row.ok && row.ctxMcpDeferred.length === 0;
    }
    await session.close();
    session = undefined;
  }

  // ---------------------------------------------------------------- P3: M3 per-profile options (fresh sessions)
  for (const name of ['wander', 'seated', 'meeting']) {
    const p = profile(name);
    current = p;
    const opts = baseOptions(rec, p, {
      cwd: cwd(),
      servers: makeServers(rec),
      gate,
      persona: p.persona,
      disallowedTools: [...DISALLOWED_TOOLS, ...denyRules(p)],
    });
    const open = await timed(async () => {
      session = openSession(rec, opts);
      return session.q.initializationResult();
    });
    rec.append('p3_open_ms', { profile: name, ms: open.ms });
    checks[`p3_${name}`] = (await snap(`P3 fresh ${name}`, visibleTools(p))).ok;
    const c = await timed(() => session.close());
    rec.append('p3_close_ms', { profile: name, ms: c.ms });
    session = undefined;
  }
} catch (e) {
  rec.data.error = String(e?.stack ?? e);
  console.error(e);
  await session?.close().catch(() => {});
}

stop();
const apiCallsMade = rec.events.filter((e) => e.kind === 'msg' && e.type === 'assistant').length;
rec.data.apiCallsMade = apiCallsMade;
rec.finish(Object.values(checks).every(Boolean) && !rec.data.error ? 'PASS' : 'MIXED', { checks });
console.log({ ...checks, apiCallsMade });
