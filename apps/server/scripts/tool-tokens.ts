/**
 * Tool-list size per mode (docs/design/EVALS.md "Mode profiles"). Zero model turns.
 *
 *   node --conditions=source --import tsx apps/server/scripts/tool-tokens.ts          # offline estimate
 *   node --conditions=source --import tsx apps/server/scripts/tool-tokens.ts --cli    # + the CLI's own counts
 *
 * Offline: builds the real `mc` / `pc` tool definitions, renders each one the way the API receives it
 * (`{name, description, input_schema}`), and estimates tokens as characters / 4. `--cli` starts the SDK-bundled claude
 * with the production session options and reads `getContextUsage()` (per-tool token counts and the system prompt),
 * using a `shouldQuery:false` message, so no model turn runs (spike S3b, "zero-turn preflight").
 *
 * Prints a JSON report: the full list every session is offered (pinned to its first request, spike S3b), the subset
 * each mode profile allows, the persona and the MODE banners.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSdkMcpServer, query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { agentEnv } from '../src/agents/agentEnv.js';
import { resolveClaudeBinary } from '../src/agents/claudeBinary.js';
import { BRAIN_MODES, type BrainMode, MODE_PROFILES, toolInMode } from '../src/agents/modes.js';
import { modeBanner } from '../src/agents/prompts/modes.js';
import { personaPrompt } from '../src/agents/prompts/persona.js';
import { buildSessionOptions } from '../src/agents/sessionOptions.js';
import { MC_PREFIX, PC_PREFIX } from '../src/agents/tools/catalog.js';
import { type McHost, mcToolDefinitions } from '../src/agents/tools/mcServer.js';
import { type PcHost, pcToolDefinitions } from '../src/agents/tools/pcServer.js';
import { SERVER_VERSION } from '../src/version.js';

/** A host whose every member throws: the definitions are only rendered, never run. */
function inert<T extends object>(): T {
  return new Proxy({} as T, {
    get: (_t, key) => {
      if (key === 'then') return undefined;
      return () => {
        throw new Error(`tool-tokens: host.${String(key)} called`);
      };
    },
  });
}

interface Rendered {
  readonly name: string;
  readonly chars: number;
}

/** One tool as the API sees it. */
function render(prefix: string, def: { name: string; description: string; inputSchema: unknown }): Rendered {
  const shape = def.inputSchema as z.ZodRawShape;
  const inputSchema = z.toJSONSchema(z.object(shape), { io: 'input', unrepresentable: 'any' });
  const json = JSON.stringify({
    name: `${prefix}${def.name}`,
    description: def.description,
    input_schema: inputSchema,
  });
  return { name: `${prefix}${def.name}`, chars: json.length };
}

const approx = (chars: number) => Math.round(chars / 4);

const persona = personaPrompt({
  name: 'Ada',
  handle: 'ada',
  role: 'ceo',
  ceo: true,
  playerName: 'Jasper',
  nonce: 'abc123',
});

const tools: Rendered[] = [
  ...mcToolDefinitions(inert<McHost>()).map((d) => render(MC_PREFIX, d)),
  ...pcToolDefinitions(inert<PcHost>()).map((d) => render(PC_PREFIX, d)),
];

/** The CLI's per-tool counts, when `--cli` is given. */
async function cliCounts(): Promise<{
  tools: Map<string, number>;
  systemTools: Map<string, number>;
  categories: { name: string; tokens: number }[];
  sections: { name: string; tokens: number }[];
  model: string;
}> {
  const env = process.env;
  const claude = await resolveClaudeBinary({
    env,
    versionEnv: agentEnv({ version: SERVER_VERSION, source: env }),
    allowBundled: true,
  });
  const dir = mkdtempSync(join(tmpdir(), 'mv-tool-tokens-'));
  const options = buildSessionOptions({
    claude,
    env: agentEnv({ version: SERVER_VERSION, source: env }),
    cwd: dir,
    resume: null,
    sessionId: crypto.randomUUID(),
    persona,
    mc: createSdkMcpServer({
      name: 'mc',
      version: '1.0.0',
      alwaysLoad: true,
      tools: mcToolDefinitions(inert<McHost>()),
    }),
    pc: createSdkMcpServer({
      name: 'pc',
      version: '1.0.0',
      alwaysLoad: true,
      tools: pcToolDefinitions(inert<PcHost>()),
    }),
  });
  let push: ((m: SDKUserMessage) => void) | null = null;
  let done = false;
  const inbox: AsyncIterable<SDKUserMessage> = {
    [Symbol.asyncIterator]: () => ({
      next: () =>
        done
          ? Promise.resolve({ value: undefined, done: true })
          : new Promise((resolve) => {
              push = (m) => resolve({ value: m, done: false });
            }),
      return: async () => ({ value: undefined, done: true }),
    }),
  };
  const q = query({ prompt: inbox, options: { ...options, persistSession: false } });
  let initSeen: () => void = () => {};
  const init = new Promise<void>((resolve) => {
    initSeen = resolve;
  });
  // Keep reading the stream (leaving the loop would close the query); a context-only message never starts a turn.
  const pump = (async () => {
    try {
      for await (const m of q) {
        if (m.type === 'system' && m.subtype === 'init') initSeen();
        if (m.type === 'assistant') throw new Error('tool-tokens: a model turn ran');
      }
    } catch (err) {
      if (!done) throw err;
    }
  })();
  try {
    while (!push) await new Promise((r) => setTimeout(r, 10));
    (push as (m: SDKUserMessage) => void)({
      type: 'user',
      message: { role: 'user', content: 'tool-tokens probe (context only)' },
      parent_tool_use_id: null,
      shouldQuery: false,
    } as SDKUserMessage);
    await init;
    const u = await q.getContextUsage({ detail: 'summary' });
    return {
      tools: new Map(u.mcpTools.map((t) => [t.name, t.tokens])),
      systemTools: new Map((u.systemTools ?? []).map((t) => [t.name, t.tokens])),
      categories: u.categories
        .filter((c) => c.kind === 'used')
        .map((c) => ({ name: c.name, tokens: c.tokens })),
      sections: (u.systemPromptSections ?? []).map((s) => ({ name: s.name, tokens: s.tokens })),
      model: u.model,
    };
  } finally {
    done = true;
    q.close();
    await pump.catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
}

const cli = process.argv.includes('--cli') ? await cliCounts() : null;

function sizeOf(names: readonly string[]) {
  const chars = names.reduce((n, name) => n + (tools.find((t) => t.name === name)?.chars ?? 0), 0);
  const cliTokens = cli ? names.reduce((n, name) => n + (cli.tools.get(name) ?? 0), 0) : null;
  return { tools: names.length, chars, approxTokens: approx(chars), cliTokens };
}

const all = tools.map((t) => t.name);
const perMode = Object.fromEntries(
  BRAIN_MODES.map((m: BrainMode) => {
    const names = all.filter((n) => toolInMode(m, n));
    const builtins = MODE_PROFILES[m].builtins;
    return [
      m,
      {
        ...sizeOf(names),
        builtins,
        builtinCliTokens: cli ? builtins.reduce((n, b) => n + (cli.systemTools.get(b) ?? 0), 0) : null,
      },
    ];
  }),
);
const banners = Object.fromEntries(
  BRAIN_MODES.map((m) => {
    const text = modeBanner(m, { nonce: 'abc123', playerName: 'Jasper' });
    return [m, { chars: text.length, approxTokens: approx(text.length) }];
  }),
);

const report = {
  note: 'approxTokens = chars / 4 of the rendered {name, description, input_schema}; cliTokens from getContextUsage()',
  everyMode: {
    ...sizeOf(all),
    mc: sizeOf(all.filter((n) => n.startsWith(MC_PREFIX))),
    pc: sizeOf(all.filter((n) => n.startsWith(PC_PREFIX))),
    builtinCliTokens: cli ? [...cli.systemTools.values()].reduce((a, b) => a + b, 0) : null,
  },
  perMode,
  persona: { chars: persona.length, approxTokens: approx(persona.length) },
  banners,
  cli: cli
    ? {
        model: cli.model,
        categories: cli.categories,
        systemPromptSections: cli.sections,
        systemTools: Object.fromEntries(cli.systemTools),
        largestTools: [...cli.tools.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8),
      }
    : null,
};
console.log(JSON.stringify(report, null, 2));
