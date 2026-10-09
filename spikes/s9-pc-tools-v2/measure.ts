/**
 * S9: the size of the `pc` tool definitions as the model sees them (name, description, JSON schema), V2.
 *   node --conditions=source --import tsx spikes/s9-pc-tools-v2/measure.ts
 * Tokens are estimated as characters / 3.6 (the A2 audit's ratio); `count_tokens` gives the exact number.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { HandoffNotes } from '../../apps/server/src/agents/memory.js';
import { PlanCapture } from '../../apps/server/src/agents/PlanCapture.js';
import { pcToolDefinitions } from '../../apps/server/src/agents/tools/pcServer.js';
import { FakePcApi } from '../../apps/server/src/contracts/FakePcApi.js';

const defs = pcToolDefinitions({
  agentId: 'ada',
  pcs: new FakePcApi(),
  plans: new PlanCapture([]),
  handoffs: new HandoffNotes(join(mkdtempSync(join(tmpdir(), 's9-')), 'h')),
  access: () => null,
  authorName: () => 'Ada',
});
let total = 0;
const rows: [string, number][] = [];
for (const d of defs) {
  const schema = z.toJSONSchema(z.object(d.inputSchema as Record<string, z.ZodType>));
  const n = JSON.stringify({ name: `mcp__pc__${d.name}`, description: d.description, input_schema: schema }).length;
  total += n;
  rows.push([d.name, n]);
}
for (const [name, n] of rows) console.log(`${name.padEnd(16)} ${String(n).padStart(5)} chars  ≈${Math.round(n / 3.6)} tokens`);
console.log(`${rows.length} tools, ${total} chars ≈ ${Math.round(total / 3.6)} tokens`);
