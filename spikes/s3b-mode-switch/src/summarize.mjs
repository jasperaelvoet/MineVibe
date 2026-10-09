// Aggregates out/{preflight,m1,m2,m3,m4}.json into out/summary.json and prints the tables used in result.md.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { OUT } from './lib.mjs';

const load = (name) => {
  const p = join(OUT, `${name}.json`);
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
};
const events = (name) => {
  const p = join(OUT, `${name}.events.jsonl`);
  return existsSync(p)
    ? readFileSync(p, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];
};

/** ms from a turn's send to its first assistant message (includes the first API call). */
function firstResponseMs(ev, turn) {
  const send = ev.find((e) => e.turn === turn && e.kind === 'send');
  const first = ev.find((e) => e.turn === turn && e.kind === 'msg' && e.type === 'assistant');
  return send && first ? first.t - send.t : null;
}

const rows = [];
let apiCalls = 0;
let listUsd = 0;
let maxFiveHour = 0;
for (const m of ['m1', 'm2', 'm3', 'm4']) {
  const d = load(m);
  if (!d?.data?.turns) continue;
  const ev = events(m);
  for (const e of ev)
    if (e.type === 'rate_limit_event' && typeof e.five_hour === 'number')
      maxFiveHour = Math.max(maxFiveHour, e.five_hour);
  listUsd += Math.max(0, ...d.data.turns.map((t) => t.result?.total_cost_usd ?? 0));
  d.data.turns.forEach((t, i) => {
    apiCalls += t.apiCalls;
    const g = d.data.grades[i];
    const sw = d.data.switches?.find((s) => s.before_turn === t.turn) ?? null;
    rows.push({
      mech: m,
      turn: t.turn,
      profile: g.profile,
      model: t.models.join(','),
      switchMs: sw
        ? (sw.totalMs ??
          +(
            (sw.toggleMs ?? 0) +
            (sw.setMcpServersMs ?? 0) +
            (sw.applyFlagSettingsMs ?? 0) +
            (sw.relistMs ?? sw.connectMs ?? 0)
          ).toFixed(1))
        : null,
      firstResponseMs: firstResponseMs(ev, t.turn),
      cacheRead1: t.firstCall.cacheRead,
      cacheWrite1: t.firstCall.cacheWrite,
      initExtra: g.init_vs_ideal.extra.length,
      initMissing: g.init_vs_ideal.missing.length,
      listedExtra: g.listed_vs_ideal?.extra.join(' ') ?? '',
      hidden: g.hiddenProbe
        ? `${g.hiddenProbe.tool}: ${g.hiddenProbe.emitted ? 'emitted' : 'not emitted'}; ${
            g.hiddenProbe.gate.length ? `gate ${g.hiddenProbe.gate.join('/')}` : 'gate not reached'
          }; ${g.hiddenProbe.errors.map((x) => x.slice(0, 90)).join(' | ')}`
        : '',
      visibleOk: g.visibleProbe ? g.visibleProbe.handlerRan : null,
      codeword: g.codewordKept ?? null,
    });
  });
}

const pre = load('preflight');
const budget = existsSync(join(OUT, 'budget.json'))
  ? JSON.parse(readFileSync(join(OUT, 'budget.json'), 'utf8'))
  : null;
const summary = {
  rows,
  preflight: pre && { status: pre.status, checks: pre.checks, apiCallsMade: pre.data.apiCallsMade },
  totals: {
    liveTurns: budget?.used ?? null,
    turnCap: budget?.cap ?? null,
    apiCalls,
    estListCostUsd: +listUsd.toFixed(4),
    maxFiveHourUtilization: maxFiveHour,
  },
};
writeFileSync(join(OUT, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
console.table(rows.map(({ hidden, listedExtra, ...r }) => r));
for (const r of rows)
  if (r.hidden || r.listedExtra)
    console.log(`${r.mech} T${r.turn}: hidden=[${r.hidden}] listedExtra=[${r.listedExtra}]`);
console.log(JSON.stringify({ preflight: summary.preflight, totals: summary.totals }, null, 2));
