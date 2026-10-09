/**
 * Measures the `mc` tool list as the model sees it (docs/design/tools-v2-mc.md §13): per tool and in total, for v1
 * and v2. `npm run measure:mc-tools -w apps/server` (no model calls). chars/4 underestimates JSON-schema tokens by
 * 15-30%; the ratio between the sets holds.
 */

import type { McToolsVersion } from '../src/agents/constants.js';
import { createMcServer, type McHost } from '../src/agents/tools/mcServer.js';
import { MC_V2_DEFERRABLE, type McV2ToolName } from '../src/agents/tools/mcToolsV2.js';
import { agentActor } from '../src/contracts/common.js';
import { FakeOrgApi } from '../src/contracts/FakeOrgApi.js';
import { FakeSkillApi } from '../src/contracts/FakeSkillApi.js';
import { listTools, toolListChars } from '../test/helpers/listTools.js';

function host(): McHost {
  const org = new FakeOrgApi({
    now: () => 1_000,
    clockTime: () => 30_000,
    positionOf: () => ({ pos: { x: 0, y: 64, z: 0 }, dim: 'minecraft:overworld' }),
    isCeo: () => true,
    playerName: () => 'Jordan',
  });
  return {
    agentId: 'ada1',
    skills: new FakeSkillApi(),
    org,
    actor: () => agentActor('ada1', true),
    playerName: () => 'Jordan',
    footer: () => null,
    here: () => null,
    clockTime: () => 0,
    trackJob: () => {},
    say: () => {},
    tell: async () => '',
    remember: async () => '',
    requestHire: async () => '',
    sitAtPc: async () => '',
    standUp: async () => '',
    wait: async () => '',
    taskReported: () => {},
  };
}

async function measure(version: McToolsVersion): Promise<void> {
  const { tools, instructions } = await listTools(createMcServer(host(), version));
  const rows = tools
    .map((t) => ({ name: t.name, chars: toolListChars('mc', [t]), desc: (t.description ?? '').length }))
    .sort((a, b) => b.chars - a.chars);
  const total = toolListChars('mc', tools);
  const desc = rows.reduce((n, r) => n + r.desc, 0);
  console.log(
    `\n${version}: ${tools.length} tools, ${total} chars (~${Math.round(total / 4)} tok), descriptions ${desc} chars (${Math.round((desc / total) * 100)}%)`,
  );
  for (const r of rows) console.log(`  ${r.name.padEnd(16)} ${String(r.chars).padStart(5)}  desc ${r.desc}`);
  if (version === 'v2') {
    const core = tools.filter((t) => !MC_V2_DEFERRABLE.has(t.name as McV2ToolName));
    const coreChars = toolListChars('mc', core);
    console.log(
      `  core (no ${[...MC_V2_DEFERRABLE].join(', ')}): ${core.length} tools, ${coreChars} chars (~${Math.round(coreChars / 4)} tok)`,
    );
    console.log(`  instructions: ${instructions?.length ?? 0} chars`);
  }
}

await measure('v1');
await measure('v2');
