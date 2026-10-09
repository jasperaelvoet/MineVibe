/**
 * Tool-list size per mode (docs/design/EVALS.md "Mode profiles"). Zero model turns.
 *
 *   node --conditions=source --import tsx apps/server/scripts/tool-tokens.ts          # offline estimate
 *   node --conditions=source --import tsx apps/server/scripts/tool-tokens.ts --cli    # + the CLI's own counts
 *
 * Offline: builds the real `mc` (both tool sets) and `pc` tool definitions, renders each one the way the API receives
 * it (`{name, description, input_schema}`), and estimates tokens as characters / 4. `--cli` starts the SDK-bundled
 * claude with the production session options once per mc tool set and reads `getContextUsage()` (per-tool token
 * counts, the system prompt), using a `shouldQuery:false` message, so no model turn runs (spike S3b, "zero-turn
 * preflight").
 *
 * Prints a JSON report per tool set: the full list every session is offered (pinned to its first request, spike S3b),
 * the subset each mode profile allows, the persona and the MODE banners.
 */

import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSdkMcpServer, query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { agentEnv } from '../src/agents/agentEnv.js';
import { resolveClaudeBinary } from '../src/agents/claudeBinary.js';
import type { McToolsVersion } from '../src/agents/constants.js';
import { BRAIN_MODES, MC_TOOL_SETS, modeProfile, toolInMode } from '../src/agents/modes.js';
import { modeBanner } from '../src/agents/prompts/modes.js';
import { personaPrompt } from '../src/agents/prompts/persona.js';
import { buildSessionOptions } from '../src/agents/sessionOptions.js';
import { MC_PREFIX, PC_PREFIX } from '../src/agents/tools/catalog.js';
import { type McHost, mcServerOptions, mcToolDefinitions } from '../src/agents/tools/mcServer.js';
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
  const schema = def.inputSchema as z.ZodType | z.ZodRawShape;
  const object = schema instanceof z.ZodType ? schema : z.object(schema);
  const inputSchema = z.toJSONSchema(object, { io: 'input', unrepresentable: 'any' });
  const json = JSON.stringify({
    name: `${prefix}${def.name}`,
    description: def.description,
    input_schema: inputSchema,
  });
  return { name: `${prefix}${def.name}`, chars: json.length };
}

const approx = (chars: number) => Math.round(chars / 4);

function persona(version: McToolsVersion): string {
  return personaPrompt({
    name: 'Ada',
    handle: 'ada',
    role: 'ceo',
    ceo: true,
    playerName: 'Jasper',
    nonce: 'abc123',
    mcTools: version,
  });
}

function tools(version: McToolsVersion): Rendered[] {
  return [
    ...mcToolDefinitions(inert<McHost>(), version).map((d) => render(MC_PREFIX, d)),
    ...pcToolDefinitions(inert<PcHost>()).map((d) => render(PC_PREFIX, d)),
  ];
}

interface CliCounts {
  tools: Map<string, number>;
  systemTools: number;
  categories: { name: string; tokens: number }[];
  model: string;
}

/** The CLI's per-tool counts for one tool set (`--cli`): a session that never runs a model turn. */
async function cliCounts(version: McToolsVersion): Promise<CliCounts> {
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
    sessionId: randomUUID(),
    persona: persona(version),
    mc: createSdkMcpServer({
      ...mcServerOptions(version),
      tools: mcToolDefinitions(inert<McHost>(), version),
    }),
    pc: createSdkMcpServer({
      name: 'pc',
      version: '2.0.0',
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
    const categories = u.categories
      .filter((c) => c.kind === 'used')
      .map((c) => ({ name: c.name, tokens: c.tokens }));
    return {
      tools: new Map(u.mcpTools.map((t) => [t.name, t.tokens])),
      systemTools: categories.find((c) => c.name === 'System tools')?.tokens ?? 0,
      categories,
      model: u.model,
    };
  } finally {
    done = true;
    q.close();
    await pump.catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
}

const withCli = process.argv.includes('--cli');

async function report(version: McToolsVersion) {
  const rendered = tools(version);
  const cli = withCli ? await cliCounts(version) : null;
  const sizeOf = (names: readonly string[]) => {
    const chars = names.reduce((n, name) => n + (rendered.find((t) => t.name === name)?.chars ?? 0), 0);
    const cliTokens = cli ? names.reduce((n, name) => n + (cli.tools.get(name) ?? 0), 0) : null;
    return { tools: names.length, chars, approxTokens: approx(chars), cliTokens };
  };
  const all = rendered.map((t) => t.name);
  const text = persona(version);
  return {
    everyMode: {
      ...sizeOf(all),
      mc: sizeOf(all.filter((n) => n.startsWith(MC_PREFIX))),
      pc: sizeOf(all.filter((n) => n.startsWith(PC_PREFIX))),
      builtinsCliTokens: cli?.systemTools ?? null,
    },
    perMode: Object.fromEntries(
      BRAIN_MODES.map((m) => [
        m,
        { ...sizeOf(all.filter((n) => toolInMode(m, n))), builtins: modeProfile(m, version).builtins },
      ]),
    ),
    persona: { chars: text.length, approxTokens: approx(text.length) },
    banners: Object.fromEntries(
      BRAIN_MODES.map((m) => {
        const banner = modeBanner(m, { nonce: 'abc123', playerName: 'Jasper', mcTools: version });
        return [m, { chars: banner.length, approxTokens: approx(banner.length) }];
      }),
    ),
    cli: cli
      ? {
          model: cli.model,
          categories: cli.categories,
          largestTools: [...cli.tools.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6),
        }
      : null,
  };
}

const out: Record<string, unknown> = {
  note: 'approxTokens = chars / 4 of the rendered {name, description, input_schema}; cliTokens from getContextUsage()',
};
for (const version of MC_TOOL_SETS) out[version] = await report(version);
console.log(JSON.stringify(out, null, 2));
