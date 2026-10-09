/**
 * Tool-list size per session (docs/design/EVALS.md "Dual sessions"). Zero model turns.
 *
 *   node --conditions=source --import tsx apps/server/scripts/tool-tokens.ts          # offline estimate
 *   node --conditions=source --import tsx apps/server/scripts/tool-tokens.ts --cli    # + the CLI's own counts
 *
 * Each agent has two sessions (PLAN §6.1, dual sessions), each with its own tool list, pinned to its first request:
 * - body: every `mc` tool of the set, AskUserQuestion;
 * - desk: the `pc` tools (with the host aliases), WebSearch, WebFetch, AskUserQuestion, PC mode's minimal `mc` set
 *   (and ExitPlanMode while Plan-first is on).
 *
 * Offline: builds the real tool definitions of each session, renders each one the way the API receives it
 * (`{name, description, input_schema}`), and estimates tokens as characters / 4. `--cli` starts the SDK-bundled
 * claude with the production session options of each session once per mc tool set and reads `getContextUsage()`
 * (per-tool token counts, the built-ins, the system prompt), using a `shouldQuery:false` message, so no model turn
 * runs (spike S3b, "zero-turn preflight").
 */

import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSdkMcpServer, query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { agentEnv } from '../src/agents/agentEnv.js';
import { resolveClaudeBinary } from '../src/agents/claudeBinary.js';
import {
  BODY_BUILTIN_TOOLS,
  deskBuiltinTools,
  type McToolsVersion,
  type SessionKind,
} from '../src/agents/constants.js';
import { MC_TOOL_SETS, sessionMcTools } from '../src/agents/modes.js';
import { modeBanner } from '../src/agents/prompts/modes.js';
import { personaPrompt } from '../src/agents/prompts/persona.js';
import { buildSessionOptions } from '../src/agents/sessionOptions.js';
import { MC_PREFIX, PC_PREFIX } from '../src/agents/tools/catalog.js';
import { type McHost, mcServerOptions, mcToolDefinitions } from '../src/agents/tools/mcServer.js';
import { type PcHost, pcToolDefinitions } from '../src/agents/tools/pcServer.js';
import { SERVER_VERSION } from '../src/version.js';

const SESSIONS: readonly SessionKind[] = ['body', 'desk'];

/**
 * A host whose every member is a no-op: the definitions are only rendered, never run (a tool server may still
 * subscribe to host events while it builds them).
 */
function inert<T extends object>(): T {
  return new Proxy({} as T, {
    get: (_t, key) => (key === 'then' ? undefined : () => undefined),
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

function persona(version: McToolsVersion, session: SessionKind): string {
  return personaPrompt({
    name: 'Ada',
    handle: 'ada',
    role: 'ceo',
    ceo: true,
    playerName: 'Jordan',
    nonce: 'abc123',
    mcTools: version,
    session,
  });
}

/** The mc tool definitions a session registers. */
function mcDefs(version: McToolsVersion, session: SessionKind) {
  return mcToolDefinitions(
    inert<McHost>(),
    version,
    session === 'desk' ? sessionMcTools('desk', version) : undefined,
  );
}

/** The `mcp__*` tools of a session, rendered. */
function tools(version: McToolsVersion, session: SessionKind): Rendered[] {
  const mc = mcDefs(version, session).map((d) => render(MC_PREFIX, d));
  if (session === 'body') return mc;
  return [...mc, ...pcToolDefinitions(inert<PcHost>()).map((d) => render(PC_PREFIX, d))];
}

function builtins(session: SessionKind): string[] {
  return session === 'desk' ? deskBuiltinTools(false) : [...BODY_BUILTIN_TOOLS];
}

interface CliCounts {
  tools: Map<string, number>;
  systemTools: number;
  categories: { name: string; tokens: number }[];
  model: string;
}

/** The CLI's per-tool counts for one session of one tool set (`--cli`): a session that never runs a model turn. */
async function cliCounts(version: McToolsVersion, session: SessionKind): Promise<CliCounts> {
  const env = process.env;
  const claude = await resolveClaudeBinary({
    env,
    versionEnv: agentEnv({ version: SERVER_VERSION, source: env }),
    allowBundled: true,
  });
  const dir = mkdtempSync(join(tmpdir(), 'mv-tool-tokens-'));
  const mc = createSdkMcpServer({
    ...mcServerOptions(version, { world: session === 'body' }),
    tools: mcDefs(version, session),
  });
  const common = {
    claude,
    env: agentEnv({ version: SERVER_VERSION, source: env }),
    cwd: dir,
    resume: null,
    sessionId: randomUUID(),
    persona: persona(version, session),
    title: `MineVibe tool-tokens · ${session}`,
  };
  const options =
    session === 'desk'
      ? buildSessionOptions({
          ...common,
          kind: 'desk',
          mc,
          pc: createSdkMcpServer({
            name: 'pc',
            version: '2.0.0',
            alwaysLoad: true,
            tools: pcToolDefinitions(inert<PcHost>()),
          }),
        })
      : buildSessionOptions({ ...common, kind: 'body', mc });
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

async function sessionReport(version: McToolsVersion, session: SessionKind) {
  const rendered = tools(version, session);
  const cli = withCli ? await cliCounts(version, session) : null;
  const sizeOf = (names: readonly string[]) => {
    const chars = names.reduce((n, name) => n + (rendered.find((t) => t.name === name)?.chars ?? 0), 0);
    const cliTokens = cli ? names.reduce((n, name) => n + (cli.tools.get(name) ?? 0), 0) : null;
    return { tools: names.length, chars, approxTokens: approx(chars), cliTokens };
  };
  const all = rendered.map((t) => t.name);
  const text = persona(version, session);
  return {
    mcpTools: sizeOf(all),
    mc: sizeOf(all.filter((n) => n.startsWith(MC_PREFIX))),
    pc: sizeOf(all.filter((n) => n.startsWith(PC_PREFIX))),
    builtins: { names: builtins(session), cliTokens: cli?.systemTools ?? null },
    totalToolTokens: cli ? (sizeOf(all).cliTokens ?? 0) + cli.systemTools : null,
    persona: { chars: text.length, approxTokens: approx(text.length) },
    cli: cli
      ? {
          model: cli.model,
          categories: cli.categories,
          largestTools: [...cli.tools.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6),
        }
      : null,
  };
}

async function report(version: McToolsVersion) {
  const out: Record<string, unknown> = {};
  for (const session of SESSIONS) out[session] = await sessionReport(version, session);
  const banner = modeBanner('meeting', { nonce: 'abc123', playerName: 'Jordan', mcTools: version });
  out.meetingBanner = { chars: banner.length, approxTokens: approx(banner.length) };
  return out;
}

const out: Record<string, unknown> = {
  note: 'per session (body, desk); approxTokens = chars / 4 of the rendered {name, description, input_schema}; cliTokens from getContextUsage()',
};
for (const version of MC_TOOL_SETS) out[version] = await report(version);
console.log(JSON.stringify(out, null, 2));
