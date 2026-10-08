// Aggregates out/<check>.json into out/summary.json: status per check, usage totals, and
// check (g): every rate_limit_event seen across all checks (fields only).
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { OUT } from './lib.mjs';

const files = readdirSync(OUT).filter((f) => f.endsWith('.json') && f !== 'summary.json');
const checks = files.map((f) => JSON.parse(readFileSync(join(OUT, f), 'utf8'))).sort((a, b) => a.check.localeCompare(b.check));

let userTurns = 0;
let apiCalls = 0;
let costUsd = 0;
const rateLimits = [];
const rows = [];
for (const c of checks) {
  userTurns += c.usage?.userTurns ?? 0;
  apiCalls += c.usage?.apiCalls ?? 0;
  // total_cost_usd is cumulative per session (list-price estimate; the subscription is what is
  // actually charged). Taking the max per check is a lower bound for multi-session checks.
  const cost = Math.max(0, ...(c.results ?? []).map((r) => r.total_cost_usd ?? 0));
  costUsd += cost;
  for (const rl of c.rateLimits ?? []) rateLimits.push({ check: c.check, ...rl });
  rows.push({ check: c.check, status: c.status, userTurns: c.usage?.userTurns, apiCalls: c.usage?.apiCalls, estCostUsd: +cost.toFixed(4) });
}

const fieldSet = [...new Set(rateLimits.flatMap((r) => Object.keys(r)))].filter((k) => !['check', 't', 'turn'].includes(k));
const g = {
  check: 'g-rate-limits',
  status: rateLimits.length > 0 ? 'PASS' : 'FAIL',
  count: rateLimits.length,
  fieldsSeen: fieldSet,
  statuses: [...new Set(rateLimits.map((r) => r.status))],
  rateLimitTypes: [...new Set(rateLimits.map((r) => r.rateLimitType))],
  maxFiveHourUtilization: Math.max(0, ...rateLimits.map((r) => r.unifiedWindows?.five_hour?.utilization ?? 0)),
  sample: rateLimits[0],
};

const summary = { rows, g, totals: { userTurns, apiCalls, estListCostUsdApprox: +costUsd.toFixed(4) } };
writeFileSync(join(OUT, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
console.table(rows);
console.log(JSON.stringify({ g, totals: summary.totals }, null, 2));
