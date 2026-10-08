// Shared harness for spike S3b (mode switch). Same hygiene as spikes/s2-s3-sdk/src/lib.mjs:
//  - options.env is a strict allowlist (agentEnv); nothing ANTHROPIC_*, CLAUDE_CODE_* (except the two documented
//    switches), MCP_* or CLAUDE_CONFIG_DIR is forwarded.
//  - pathToClaudeCodeExecutable is left unset, so the SDK-bundled binary runs.
//  - Everything written to out/ goes through sanitize().
//  - Every live model turn is claimed from out/budget.json first (HARD CAP 12 for the whole spike).

import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSdkMcpServer, query, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import {
  BUILTIN_TOOLS,
  DISALLOWED_TOOLS,
  gateAllows,
  MC_TOOLS,
  managedOnly,
  PC_TOOLS,
  parseToolList,
  TOOL_ALIASES,
} from './profiles.mjs';

export const SPIKE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const OUT = join(SPIKE_ROOT, 'out');
export const TURN_CAP = 12;

const BASE_PERSONA =
  'You are a test agent inside an automated SDK spike. Follow the user instructions exactly ' +
  'and keep every reply to one short line.';

// ---------------------------------------------------------------- environment

const SYSTEM_PATH = ['/usr/bin', '/bin', '/usr/sbin', '/sbin'];
const PASSTHROUGH = ['HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'TMPDIR', 'TERM'];

/** PLAN §6.1 agentEnv(): allowlist only. Values are never logged. */
export function agentEnv(source = process.env) {
  const nodeBin = dirname(process.execPath);
  const PATH = [nodeBin, ...SYSTEM_PATH].filter((v, i, a) => a.indexOf(v) === i).join(':');
  const env = { PATH };
  for (const key of PASSTHROUGH) {
    if (source[key]) env[key] = source[key];
  }
  env.LANG ??= 'en_US.UTF-8';
  env.TERM ??= 'dumb';
  env.DISABLE_AUTOUPDATER = '1';
  env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = '1';
  env.CLAUDE_AGENT_SDK_CLIENT_APP = 'minevibe-spike/0';
  return env;
}

// ---------------------------------------------------------------- sanitising

const SENSITIVE_KEY =
  /(e-?mail|organi[sz]ation|token(?!s?$)|api_?key|secret|passw|authori[sz]ation|bearer|cookie|credential|oauth|account_?uuid|org_?uuid|user_?id)/i;
// Enum-valued or count keys that only look sensitive.
const SAFE_KEYS = new Set([
  'apiKeySource',
  'totalTokens',
  'maxTokens',
  'rawMaxTokens',
  'autoCompactThreshold',
]);
const SENSITIVE_VALUE = [
  [/sk-ant-[A-Za-z0-9_-]+/g, '[redacted-key]'],
  // org/account ids inside stringified JSON (transcript attachments such as credential_org)
  [
    /((?:organi[sz]ation|org|account)[A-Za-z_]*(?:uuid|id)\\?"?\s*[:=]\s*\\?"?)[0-9a-fA-F-]{32,36}/gi,
    '$1[redacted]',
  ],
  [/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]'],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[redacted-email]'],
];

export function sanitize(value, depth = 0) {
  if (depth > 12) return '[depth]';
  if (typeof value === 'string') {
    let s = value;
    for (const [re, rep] of SENSITIVE_VALUE) s = s.replace(re, rep);
    return s;
  }
  if (Array.isArray(value)) return value.map((v) => sanitize(v, depth + 1));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SENSITIVE_KEY.test(k) && !SAFE_KEYS.has(k) ? '[redacted]' : sanitize(v, depth + 1);
    }
    return out;
  }
  return value;
}

export const trunc = (s, n = 400) =>
  typeof s === 'string' && s.length > n ? `${s.slice(0, n)}…(+${s.length - n})` : s;

// ---------------------------------------------------------------- turn budget

/** Claims one live model turn from out/budget.json; throws once the spike-wide cap is reached. */
export function claimTurn(label, { path = join(OUT, 'budget.json'), cap = TURN_CAP } = {}) {
  mkdirSync(dirname(path), { recursive: true });
  const b = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : { cap, used: 0, turns: [] };
  if (b.used >= cap) throw new Error(`turn budget exhausted (${b.used}/${cap}); refusing to send "${label}"`);
  b.used += 1;
  b.turns.push({ n: b.used, label, at: new Date().toISOString() });
  writeFileSync(path, `${JSON.stringify(b, null, 2)}\n`);
  return b.used;
}

export function budgetLeft({ path = join(OUT, 'budget.json'), cap = TURN_CAP } = {}) {
  if (!existsSync(path)) return cap;
  return cap - JSON.parse(readFileSync(path, 'utf8')).used;
}

// ---------------------------------------------------------------- recorder

export class Recorder {
  constructor(check) {
    this.check = check;
    this.t0 = Date.now();
    this.turn = 0;
    this.events = [];
    this.hookCalls = [];
    this.handlerCalls = [];
    this.inits = [];
    this.results = [];
    this.stderrTail = '';
    this.data = {};
    mkdirSync(OUT, { recursive: true });
    this.jsonlPath = join(OUT, `${check}.events.jsonl`);
    writeFileSync(this.jsonlPath, '');
  }

  t() {
    return Date.now() - this.t0;
  }

  event(kind, payload = {}) {
    const e = { t: this.t(), turn: this.turn, kind, ...sanitize(payload) };
    this.events.push(e);
    appendFileSync(this.jsonlPath, `${JSON.stringify(e)}\n`);
    return e;
  }

  stderr(chunk) {
    this.stderrTail = (this.stderrTail + chunk).slice(-8000);
  }

  /** Appends `value` to the list `this.data[key]`. */
  append(key, value) {
    if (!Array.isArray(this.data[key])) this.data[key] = [];
    this.data[key].push(value);
  }

  onMessage(m) {
    const s = summarizeMessage(m);
    if (!s) return;
    if (m.type === 'system' && m.subtype === 'init') this.inits.push({ turn: this.turn, t: this.t(), ...s });
    if (m.type === 'result') this.results.push({ turn: this.turn, ...s });
    this.event('msg', s);
  }

  finish(status, extra = {}) {
    const summary = sanitize({
      check: this.check,
      status,
      elapsed_ms: this.t(),
      ...extra,
      data: this.data,
      inits: this.inits.map((i) => ({
        turn: i.turn,
        t: i.t,
        model: i.model,
        session_id: i.session_id,
        tools: i.tools,
      })),
      results: this.results,
      hookCalls: this.hookCalls,
      handlerCalls: this.handlerCalls,
    });
    writeFileSync(join(OUT, `${this.check}.json`), `${JSON.stringify(summary, null, 2)}\n`);
    if (this.stderrTail.trim())
      writeFileSync(join(OUT, `${this.check}.stderr.txt`), sanitize(this.stderrTail));
    console.log(`[${this.check}] ${status} in ${(this.t() / 1000).toFixed(1)}s`);
    return summary;
  }
}

export function summarizeMessage(m) {
  switch (m.type) {
    case 'assistant': {
      const msg = m.message ?? {};
      return {
        type: 'assistant',
        model: msg.model,
        id: msg.id,
        stop_reason: msg.stop_reason,
        error: m.error,
        usage: msg.usage && {
          input_tokens: msg.usage.input_tokens,
          output_tokens: msg.usage.output_tokens,
          cache_read_input_tokens: msg.usage.cache_read_input_tokens,
          cache_creation_input_tokens: msg.usage.cache_creation_input_tokens,
          cache_creation: msg.usage.cache_creation,
        },
        blocks: (msg.content ?? []).map((b) => {
          if (b.type === 'text') return { type: 'text', text: trunc(b.text, 1200) };
          if (b.type === 'thinking') return { type: 'thinking', chars: b.thinking?.length ?? 0 };
          if (b.type === 'tool_use')
            return { type: 'tool_use', id: b.id, name: b.name, input: trunc(JSON.stringify(b.input), 400) };
          return { type: b.type };
        }),
      };
    }
    case 'user': {
      const c = m.message?.content;
      return {
        type: 'user',
        isSynthetic: m.isSynthetic,
        content:
          typeof c === 'string'
            ? trunc(c, 600)
            : (c ?? []).map((b) =>
                b.type === 'tool_result'
                  ? {
                      type: 'tool_result',
                      tool_use_id: b.tool_use_id,
                      is_error: b.is_error,
                      text: trunc(typeof b.content === 'string' ? b.content : JSON.stringify(b.content), 600),
                    }
                  : b.type === 'text'
                    ? { type: 'text', text: trunc(b.text, 600) }
                    : { type: b.type },
              ),
      };
    }
    case 'system': {
      if (m.subtype === 'init') {
        return {
          type: 'system',
          subtype: 'init',
          session_id: m.session_id,
          apiKeySource: m.apiKeySource,
          claude_code_version: m.claude_code_version,
          model: m.model,
          permissionMode: m.permissionMode,
          tools: m.tools,
          mcp_servers: m.mcp_servers,
        };
      }
      if (m.subtype === 'thinking_tokens') return null;
      const { uuid, session_id, ...rest } = m;
      return { ...rest, _keys: Object.keys(m) };
    }
    case 'rate_limit_event':
      return {
        type: 'rate_limit_event',
        status: m.rate_limit_info?.status,
        five_hour: m.rate_limit_info?.unifiedWindows?.five_hour?.utilization,
      };
    case 'result':
      return {
        type: 'result',
        subtype: m.subtype,
        is_error: m.is_error,
        num_turns: m.num_turns,
        duration_ms: m.duration_ms,
        duration_api_ms: m.duration_api_ms,
        total_cost_usd: m.total_cost_usd,
        result: trunc(m.result, 1500),
        errors: m.errors,
        permission_denials: m.permission_denials,
      };
    case 'stream_event':
      return null;
    default:
      return { type: m.type, subtype: m.subtype, _keys: Object.keys(m) };
  }
}

// ---------------------------------------------------------------- fake tools

const text = (t) => ({ content: [{ type: 'text', text: t }] });

const MC_SCHEMAS = {
  goto: { x: z.number(), y: z.number(), z: z.number() },
  mine: { block: z.string(), count: z.number().optional() },
  craft: { item: z.string(), count: z.number().optional() },
  sit_at_pc: { pc_id: z.string() },
  say: { text: z.string() },
  tell: { to: z.string(), text: z.string() },
  remember: { note: z.string() },
  codex_read: { path: z.string() },
  report_task: { task_id: z.string(), status: z.string() },
};

const MC_DESCRIPTIONS = {
  status: 'Your body status: health, hunger, position, time.',
  look_around: 'Describe what you see around you, including nearby danger.',
  goto: 'Walk your body to a block position.',
  mine: 'Mine blocks of a type nearby.',
  craft: 'Craft an item from your inventory.',
  sit_at_pc: 'Walk to a PC and sit down to use it.',
  stand_up: 'Stand up from the PC or meeting seat.',
  say: 'Say something out loud in chat.',
  tell: 'Whisper to one crew member or the player.',
  remember: 'Add a line to your long-term memory.',
  codex_read: 'Read a page of the team Codex.',
  calendar_list: 'List your calendar items.',
  report_task: 'Report progress on a calendar task.',
};

const PC_DEFS = {
  bash: [
    'Run a shell command inside the PC you are seated at.',
    { command: z.string(), description: z.string().optional(), timeout: z.number().optional() },
  ],
  read: [
    'Read a file inside the PC.',
    { file_path: z.string(), offset: z.number().optional(), limit: z.number().optional() },
  ],
  edit: [
    'Replace a string in a file inside the PC.',
    {
      file_path: z.string(),
      old_string: z.string(),
      new_string: z.string(),
      replace_all: z.boolean().optional(),
    },
  ],
  write: ['Write a file inside the PC.', { file_path: z.string(), content: z.string() }],
  glob: ['Find files by glob pattern inside the PC.', { pattern: z.string(), path: z.string().optional() }],
  grep: ['Search file contents inside the PC.', { pattern: z.string(), path: z.string().optional() }],
  screenshot: ['Take a screenshot of the PC screen.', {}],
};

/**
 * Fresh in-process mc + pc servers (a server instance binds to one transport, so every session gets its own).
 * `mcSubset` limits the mc tools (M2's attempt to change a server's tool list in place).
 */
export function makeServers(rec, { mcSubset = null } = {}) {
  const called = (name, args) => {
    const entry = { turn: rec.turn, t: rec.t(), tool: name, args: sanitize(args) };
    rec.handlerCalls.push(entry);
    rec.event('handler', entry);
  };
  const mcNames = Object.keys(MC_TOOLS).filter((n) => !mcSubset || mcSubset.includes(n));
  const mc = createSdkMcpServer({
    name: 'mc',
    version: '0.0.0',
    alwaysLoad: true,
    timeout: 600_000,
    tools: mcNames.map((n) =>
      tool(n, MC_DESCRIPTIONS[n], MC_SCHEMAS[n] ?? {}, async (args) => {
        called(`mcp__mc__${n}`, args);
        return text(`FAKE-MC-${n.toUpperCase()}: ok`);
      }),
    ),
  });
  const pc = createSdkMcpServer({
    name: 'pc',
    version: '0.0.0',
    alwaysLoad: true,
    timeout: 600_000,
    tools: PC_TOOLS.map((n) =>
      tool(n, PC_DEFS[n][0], PC_DEFS[n][1], async (args) => {
        called(`mcp__pc__${n}`, args);
        const echo =
          typeof args.command === 'string' && args.command.startsWith('echo ')
            ? args.command.slice(5)
            : '(ok)';
        return text(`FAKE-PC-${n.toUpperCase()}: ${echo}`);
      }),
    ),
  });
  return { mc, pc };
}

/**
 * M4 (MCP-native): enable/disable single tools on the in-process servers. Each change makes the MCP server send
 * `notifications/tools/list_changed`; the CLI then re-lists that server's tools. Uses the McpServer's
 * `_registeredTools` handles (the SDK does not re-export them). Returns how many tools changed state.
 */
export function applyProfileToServers(servers, p) {
  let changed = 0;
  const want = {
    mc: (n) => p.mc.includes(n),
    pc: () => p.pc,
  };
  for (const [server, wants] of Object.entries(want)) {
    const registered = servers[server]?.instance?._registeredTools ?? {};
    for (const [name, rt] of Object.entries(registered)) {
      const on = wants(name);
      if (rt.enabled === on) continue;
      if (on) rt.enable();
      else rt.disable();
      changed++;
    }
  }
  return changed;
}

// ---------------------------------------------------------------- gate

/**
 * ToolGate-like PreToolUse hook: records what reaches it, then allows a tool only if the CURRENT profile shows it.
 * A deny here means hiding failed (the model reached a tool it should not have seen) — the gate is the backstop.
 */
export function makeGate(rec, currentProfile) {
  return async (input) => {
    const p = currentProfile();
    const allowed = gateAllows(p, input.tool_name);
    const entry = {
      turn: rec.turn,
      t: rec.t(),
      profile: p.name,
      tool_name: input.tool_name,
      mcp_server: input.mcp_server,
      effort: input.effort?.level,
      permission_mode: input.permission_mode,
      decision: allowed === null ? 'none' : allowed ? 'allow' : 'deny',
      tool_input: trunc(JSON.stringify(input.tool_input), 300),
    };
    rec.hookCalls.push(sanitize(entry));
    rec.event('hook', entry);
    if (allowed === null) return {};
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: allowed ? 'allow' : 'deny',
        permissionDecisionReason: allowed
          ? `spike gate: visible in ${p.name}`
          : `spike gate: not available while ${p.name}`,
      },
    };
  };
}

export function makeLogHook(rec, name) {
  return async (input) => {
    const { session_id, transcript_path, cwd, ...rest } = input;
    rec.event('hook_other', rest);
    rec.append('otherHooks', sanitize({ name, turn: rec.turn, t: rec.t(), ...rest }));
    return {};
  };
}

/** canUseTool: everything that reaches it is denied (no HITL in this spike). */
export function makeBroker(rec) {
  return async (toolName) => {
    rec.event('canUseTool', { toolName });
    rec.append('canUseTool', { turn: rec.turn, toolName });
    return { behavior: 'deny', message: 'spike broker: denied' };
  };
}

// ---------------------------------------------------------------- session plumbing

export class Inbox {
  #queue = [];
  #waiters = [];
  #closed = false;

  push(msg) {
    if (this.#closed) throw new Error('inbox closed');
    const w = this.#waiters.shift();
    if (w) w({ value: msg, done: false });
    else this.#queue.push(msg);
  }

  close() {
    this.#closed = true;
    for (const w of this.#waiters.splice(0)) w({ value: undefined, done: true });
  }

  [Symbol.asyncIterator]() {
    return {
      next: () => {
        if (this.#queue.length) return Promise.resolve({ value: this.#queue.shift(), done: false });
        if (this.#closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((r) => this.#waiters.push(r));
      },
      return: async () => {
        this.close();
        return { value: undefined, done: true };
      },
    };
  }
}

export function userMessage(content, extra = {}) {
  return {
    type: 'user',
    message: { role: 'user', content },
    parent_tool_use_id: null,
    uuid: randomUUID(),
    ...extra,
  };
}

/**
 * Base options in the production shape (apps/server/src/agents/sessionOptions.ts) for a profile. Overrides win.
 * `persona` is appended to the preset system prompt (M3 swaps it per mode; M1/M2 keep the session's first one).
 */
export function baseOptions(rec, p, { cwd, servers, gate, persona, ...overrides }) {
  return {
    env: agentEnv(),
    settingSources: [],
    strictMcpConfig: true,
    permissionMode: 'default',
    cwd,
    persistSession: false,
    model: p.model,
    settings: { effortLevel: p.effort },
    thinking: { type: 'adaptive' },
    includePartialMessages: false,
    tools: [...BUILTIN_TOOLS],
    disallowedTools: [...DISALLOWED_TOOLS],
    toolAliases: { ...TOOL_ALIASES },
    mcpServers: servers,
    hooks: {
      PreToolUse: [{ hooks: [gate] }],
      PreModelSwitch: [{ hooks: [makeLogHook(rec, 'PreModelSwitch')] }],
      PostModelSwitch: [{ hooks: [makeLogHook(rec, 'PostModelSwitch')] }],
    },
    canUseTool: makeBroker(rec),
    systemPrompt: {
      type: 'preset',
      preset: 'claude_code',
      append: persona ? `${BASE_PERSONA}\n${persona}` : BASE_PERSONA,
    },
    maxTurns: 6,
    maxBudgetUsd: 1.5,
    stderr: (d) => rec.stderr(d),
    ...overrides,
  };
}

/** One long-lived streaming query with a result queue. */
export function openSession(rec, options) {
  const inbox = new Inbox();
  const q = query({ prompt: inbox, options });
  const pendingResults = [];
  const resultWaiters = [];
  let sessionId;
  let failure;

  const pump = (async () => {
    try {
      for await (const m of q) {
        if (m.session_id) sessionId = m.session_id;
        rec.onMessage(m);
        if (m.type === 'result') {
          const w = resultWaiters.shift();
          if (w) w.resolve(m);
          else pendingResults.push(m);
        }
      }
      rec.event('stream_end');
    } catch (err) {
      failure = err;
      rec.event('stream_error', { message: String(err?.message ?? err) });
    } finally {
      for (const w of resultWaiters.splice(0)) w.reject(failure ?? new Error('stream ended before result'));
    }
  })();

  return {
    q,
    pump,
    get sessionId() {
      return sessionId;
    },
    send(content, extra = {}) {
      const msg = userMessage(content, extra);
      rec.event('send', { uuid: msg.uuid, content: trunc(content, 600), extra });
      inbox.push(msg);
      return msg.uuid;
    },
    /**
     * Zero-cost probe: a `shouldQuery:false` context message makes the CLI re-emit system/init (with the tool list
     * it would send) and a zero-turn result, without an API call (S2 check e).
     */
    async probeInit(label) {
      const before = rec.inits.length;
      this.send(`[context] probe: ${label}`, { shouldQuery: false });
      const r = await this.nextResult(30_000);
      if (r.num_turns !== 0) throw new Error(`probe "${label}" ran a model turn (num_turns=${r.num_turns})`);
      return rec.inits.length > before ? rec.inits.at(-1) : null;
    },
    nextResult(timeoutMs = 180_000) {
      if (pendingResults.length) return Promise.resolve(pendingResults.shift());
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const i = resultWaiters.indexOf(w);
          if (i >= 0) resultWaiters.splice(i, 1);
          reject(new Error(`no result within ${timeoutMs} ms`));
        }, timeoutMs);
        const w = {
          resolve: (m) => {
            clearTimeout(timer);
            resolve(m);
          },
          reject: (e) => {
            clearTimeout(timer);
            reject(e);
          },
        };
        resultWaiters.push(w);
      });
    },
    async close(graceMs = 5000) {
      inbox.close();
      const settled = await Promise.race([pump.then(() => true), sleep(graceMs).then(() => false)]);
      if (!settled) q.close();
      await pump;
    },
  };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function timed(fn) {
  const t0 = performance.now();
  const value = await fn();
  return { value, ms: +(performance.now() - t0).toFixed(1) };
}

// ---------------------------------------------------------------- observation (no model turn)

/**
 * The CLI's own view of the next request, without an API call: getContextUsage({detail:'summary'}) lists the mcp
 * tools (with isLoaded = not deferred), the built-in tools and the attachments in the transcript.
 */
export async function contextView(q) {
  const u = await q.getContextUsage({ detail: 'summary' });
  const mcpTools = (u.mcpTools ?? []).map((t) => ({
    name: t.name,
    server: t.serverName,
    loaded: t.isLoaded ?? null,
    tokens: t.tokens,
  }));
  return {
    model: u.model,
    totalTokens: u.totalTokens,
    mcpLoaded: mcpTools
      .filter((t) => t.loaded !== false)
      .map((t) => t.name)
      .sort(),
    mcpDeferred: mcpTools
      .filter((t) => t.loaded === false)
      .map((t) => t.name)
      .sort(),
    mcpTools,
    systemTools: (u.systemTools ?? []).map((t) => t.name).sort(),
    deferredBuiltinTools: (u.deferredBuiltinTools ?? []).map((t) => ({ name: t.name, loaded: t.isLoaded })),
    categories: (u.categories ?? []).map((c) => ({
      name: c.name,
      tokens: c.tokens,
      kind: c.kind,
      deferred: c.isDeferred,
    })),
    attachmentsByType: u.messageBreakdown?.attachmentsByType ?? null,
  };
}

export async function serverView(q) {
  const s = await q.mcpServerStatus();
  return s.map((x) => ({
    name: x.name,
    status: x.status,
    source: x.source,
    tools: (x.tools ?? []).map((t) => t.name).sort(),
    error: x.error,
  }));
}

// ---------------------------------------------------------------- per-turn evidence

/** Unique API calls of a turn, in order, with their usage (the SDK repeats one message id per content block). */
export function apiCalls(events, turn) {
  const seen = new Map();
  for (const e of events) {
    if (e.kind !== 'msg' || e.type !== 'assistant' || e.turn !== turn || !e.id) continue;
    if (!seen.has(e.id)) seen.set(e.id, { id: e.id, model: e.model, usage: e.usage, blocks: [] });
    seen.get(e.id).blocks.push(...e.blocks);
  }
  return [...seen.values()];
}

export function turnEvidence(rec, turn, result) {
  const calls = apiCalls(rec.events, turn);
  const toolUses = calls.flatMap((c) =>
    c.blocks.filter((b) => b.type === 'tool_use').map((b) => ({ name: b.name, input: b.input })),
  );
  const toolResults = rec.events
    .filter((e) => e.kind === 'msg' && e.type === 'user' && e.turn === turn && Array.isArray(e.content))
    .flatMap((e) => e.content.filter((b) => b.type === 'tool_result'))
    .map((b) => ({ is_error: b.is_error ?? false, text: b.text }));
  const u = (c) => c?.usage ?? {};
  const sum = (k) => calls.reduce((a, c) => a + (u(c)[k] ?? 0), 0);
  const init = rec.inits.filter((i) => i.turn === turn).at(-1);
  const reply = result?.result ?? '';
  return {
    turn,
    models: [...new Set(calls.map((c) => c.model))],
    apiCalls: calls.length,
    firstCall: {
      input: u(calls[0]).input_tokens,
      cacheRead: u(calls[0]).cache_read_input_tokens,
      cacheWrite: u(calls[0]).cache_creation_input_tokens,
      cacheCreation: u(calls[0]).cache_creation,
    },
    turnTotals: {
      input: sum('input_tokens'),
      output: sum('output_tokens'),
      cacheRead: sum('cache_read_input_tokens'),
      cacheWrite: sum('cache_creation_input_tokens'),
    },
    initTools: init ? managedOnly(init.tools ?? []) : null,
    initToolsAll: init?.tools ?? null,
    toolUses,
    toolResults,
    gate: rec.hookCalls
      .filter((h) => h.turn === turn)
      .map((h) => ({ tool: h.tool_name, decision: h.decision, profile: h.profile, effort: h.effort })),
    handlers: rec.handlerCalls.filter((h) => h.turn === turn).map((h) => h.tool),
    reply: trunc(reply, 1500),
    listed: parseToolList(reply),
    result: result && {
      subtype: result.subtype,
      num_turns: result.num_turns,
      duration_ms: result.duration_ms,
      total_cost_usd: result.total_cost_usd,
      permission_denials: result.permission_denials,
    },
  };
}

/** Hard wall-clock cap for a whole script: closes everything and records FAIL. */
export function watchdog(rec, ms, onFire) {
  const timer = setTimeout(async () => {
    rec.event('watchdog', { ms });
    try {
      await onFire?.();
    } catch {}
    rec.finish('FAIL', { reason: `watchdog: script exceeded ${ms} ms` });
    process.exit(2);
  }, ms);
  timer.unref();
  return () => clearTimeout(timer);
}
