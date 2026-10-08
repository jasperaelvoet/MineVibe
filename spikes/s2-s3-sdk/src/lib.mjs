// Shared harness for spike S2 + S3 (PLAN §12.1). Mirrors the PLAN §6.1 session
// options so every check exercises the production shape, with fake mc/pc tools.
//
// Hygiene rules enforced here:
//  - options.env is a strict allowlist (agentEnv); nothing ANTHROPIC_*, CLAUDE_CODE_*
//    (except the two documented switches), MCP_* or CLAUDE_CONFIG_DIR is forwarded.
//  - pathToClaudeCodeExecutable is left unset, so the SDK-bundled binary runs.
//  - Everything written to out/ goes through sanitize(): account e-mail, organisation,
//    token-ish keys and API-key-looking strings are never persisted.

import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSdkMcpServer, query, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

export const SPIKE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const OUT = join(SPIKE_ROOT, 'out');

export const HAIKU = 'claude-haiku-5-5';
export const OPUS = 'claude-opus-5-5';

// PLAN §6.1 (minus WebSearch/WebFetch, which the spike brief leaves out).
export const BUILTIN_TOOLS = ['TodoWrite', 'AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode'];
export const DISALLOWED_TOOLS = ['Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep', 'NotebookEdit', 'Agent', 'Task'];
export const TOOL_ALIASES = {
  Bash: 'mcp__pc__bash',
  Read: 'mcp__pc__read',
  Edit: 'mcp__pc__edit',
  Write: 'mcp__pc__write',
  Glob: 'mcp__pc__glob',
  Grep: 'mcp__pc__grep',
};
const HOST_BUILTINS = new Set(DISALLOWED_TOOLS);

const PERSONA =
  'You are a test agent inside an automated SDK spike. Follow the user instructions exactly, ' +
  'use only the tools you are told to use, and keep every reply to one short line.';

// ---------------------------------------------------------------- environment

const SYSTEM_PATH = ['/usr/bin', '/bin', '/usr/sbin', '/sbin'];
const PASSTHROUGH = ['HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'TMPDIR', 'TERM'];

/** PLAN §6.1 agentEnv(): allowlist only. Values are never logged. */
export function agentEnv() {
  const nodeBin = dirname(process.execPath);
  const PATH = [nodeBin, ...SYSTEM_PATH].filter((v, i, a) => a.indexOf(v) === i).join(':');
  const env = { PATH };
  for (const key of PASSTHROUGH) {
    if (process.env[key]) env[key] = process.env[key];
  }
  env.LANG ??= 'en_US.UTF-8';
  env.TERM ??= 'dumb';
  env.DISABLE_AUTOUPDATER = '1';
  env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = '1';
  env.CLAUDE_AGENT_SDK_CLIENT_APP = 'minevibe-spike/0';
  return env;
}

/** Names (never values) of inherited variables that agentEnv() drops. */
export function droppedEnvNames() {
  const kept = new Set(Object.keys(agentEnv()));
  return Object.keys(process.env)
    .filter((k) => !kept.has(k) && /^(ANTHROPIC_|CLAUDE|MCP_)/.test(k))
    .sort();
}

// ---------------------------------------------------------------- sanitising

const SENSITIVE_KEY =
  /(e-?mail|organi[sz]ation|token(?!s?$)|api_?key|secret|passw|authori[sz]ation|bearer|cookie|credential|oauth|account_?uuid|org_?uuid|user_?id)/i;
// Enum-valued keys that name a credential *source* (e.g. 'none'), not a credential.
const SAFE_KEYS = new Set(['apiKeySource', 'apiKeySourceNone']);
const SENSITIVE_VALUE = [
  [/sk-ant-[A-Za-z0-9_-]+/g, '[redacted-key]'],
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

const trunc = (s, n = 400) => (typeof s === 'string' && s.length > n ? `${s.slice(0, n)}…(+${s.length - n})` : s);

// ---------------------------------------------------------------- recorder

export class Recorder {
  constructor(check) {
    this.check = check;
    this.t0 = Date.now();
    this.turn = 0; // label applied to events; scripts bump it per user turn
    this.events = [];
    this.hookCalls = [];
    this.canUseToolCalls = [];
    this.handlerCalls = [];
    this.rateLimits = [];
    this.inits = [];
    this.results = [];
    this.apiMessageIds = new Set();
    this.assistantModels = [];
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

  onMessage(m) {
    const s = summarizeMessage(m);
    if (!s) return;
    if (m.type === 'assistant') {
      if (m.message?.id) this.apiMessageIds.add(m.message.id);
      this.assistantModels.push({ turn: this.turn, model: m.message?.model, id: m.message?.id });
    }
    if (m.type === 'rate_limit_event') this.rateLimits.push({ t: this.t(), turn: this.turn, ...sanitize(m.rate_limit_info) });
    if (m.type === 'system' && m.subtype === 'init') this.inits.push({ turn: this.turn, ...s });
    if (m.type === 'result') this.results.push({ turn: this.turn, ...s });
    this.event('msg', s);
  }

  finish(status, extra = {}) {
    const summary = sanitize({
      check: this.check,
      status,
      elapsed_ms: this.t(),
      usage: {
        userTurns: this.results.length,
        apiCalls: this.apiMessageIds.size,
      },
      ...extra,
      inits: this.inits,
      results: this.results,
      assistantModels: this.assistantModels,
      hookCalls: this.hookCalls,
      canUseToolCalls: this.canUseToolCalls,
      handlerCalls: this.handlerCalls,
      rateLimits: this.rateLimits,
      data: this.data,
    });
    writeFileSync(join(OUT, `${this.check}.json`), `${JSON.stringify(summary, null, 2)}\n`);
    if (this.stderrTail.trim()) writeFileSync(join(OUT, `${this.check}.stderr.txt`), sanitize(this.stderrTail));
    console.log(`[${this.check}] ${status} in ${(this.t() / 1000).toFixed(1)}s — userTurns=${this.results.length} apiCalls=${this.apiMessageIds.size}`);
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
        parent_tool_use_id: m.parent_tool_use_id,
        user_message_uuids: m.user_message_uuids,
        usage: msg.usage && {
          input_tokens: msg.usage.input_tokens,
          output_tokens: msg.usage.output_tokens,
          cache_read_input_tokens: msg.usage.cache_read_input_tokens,
          cache_creation_input_tokens: msg.usage.cache_creation_input_tokens,
          cache_creation: msg.usage.cache_creation,
        },
        blocks: (msg.content ?? []).map((b) => {
          if (b.type === 'text') return { type: 'text', text: trunc(b.text, 600) };
          if (b.type === 'thinking') return { type: 'thinking', chars: b.thinking?.length ?? 0, signed: Boolean(b.signature) };
          if (b.type === 'tool_use') return { type: 'tool_use', id: b.id, name: b.name, input: trunc(JSON.stringify(b.input), 800) };
          return { type: b.type };
        }),
      };
    }
    case 'user': {
      const c = m.message?.content;
      return {
        type: 'user',
        isSynthetic: m.isSynthetic,
        priority: m.priority,
        uuid: m.uuid,
        parent_tool_use_id: m.parent_tool_use_id,
        content:
          typeof c === 'string'
            ? trunc(c, 600)
            : (c ?? []).map((b) =>
                b.type === 'tool_result'
                  ? {
                      type: 'tool_result',
                      tool_use_id: b.tool_use_id,
                      is_error: b.is_error,
                      text: trunc(typeof b.content === 'string' ? b.content : JSON.stringify(b.content), 800),
                    }
                  : b.type === 'text'
                    ? { type: 'text', text: trunc(b.text, 600) }
                    : { type: b.type },
              ),
        tool_use_result: m.tool_use_result === undefined ? undefined : trunc(JSON.stringify(m.tool_use_result), 800),
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
          effort: m.effort,
          tools: m.tools,
          mcp_servers: m.mcp_servers,
          agents: m.agents,
          skills: m.skills,
          plugins: (m.plugins ?? []).map((p) => ({ name: p.name, path: p.path, source: p.source })),
          plugin_errors: m.plugin_errors,
          slash_commands_count: m.slash_commands?.length,
          output_style: m.output_style,
          fast_mode_state: m.fast_mode_state,
          capabilities: m.capabilities,
          betas: m.betas,
        };
      }
      if (m.subtype === 'thinking_tokens') {
        return { type: 'system', subtype: 'thinking_tokens', estimated_tokens: m.estimated_tokens, delta: m.estimated_tokens_delta };
      }
      const { uuid, session_id, ...rest } = m;
      return { ...rest, _keys: Object.keys(m) };
    }
    case 'rate_limit_event':
      return { type: 'rate_limit_event', rate_limit_info: m.rate_limit_info };
    case 'result':
      return {
        type: 'result',
        subtype: m.subtype,
        is_error: m.is_error,
        num_turns: m.num_turns,
        duration_ms: m.duration_ms,
        duration_api_ms: m.duration_api_ms,
        stop_reason: m.stop_reason,
        terminal_reason: m.terminal_reason,
        total_cost_usd: m.total_cost_usd,
        result: trunc(m.result, 600),
        errors: m.errors,
        usage: m.usage && {
          input_tokens: m.usage.input_tokens,
          output_tokens: m.usage.output_tokens,
          cache_read_input_tokens: m.usage.cache_read_input_tokens,
          cache_creation_input_tokens: m.usage.cache_creation_input_tokens,
        },
        modelUsage: m.modelUsage,
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

/** In-process mc + pc servers (PLAN §6.1/§6.2). pc schemas are supersets of the built-in inputs. */
export function makeServers(rec) {
  const called = (name, args) => {
    const entry = { turn: rec.turn, t: rec.t(), tool: name, args: sanitize(args) };
    rec.handlerCalls.push(entry);
    rec.event('handler', entry);
  };

  const mc = createSdkMcpServer({
    name: 'mc',
    version: '0.0.0',
    alwaysLoad: true,
    timeout: 600_000,
    tools: [
      tool(
        'status',
        'Report your own body status in the Minecraft world: health, hunger, position and time.',
        {},
        async (args) => {
          called('mcp__mc__status', args);
          return text('FAKE-MC-STATUS: HP 20/20, hunger 20/20, pos (0,64,0), day 1 08:00.');
        },
        { annotations: { readOnlyHint: true } },
      ),
    ],
  });

  const pc = createSdkMcpServer({
    name: 'pc',
    version: '0.0.0',
    alwaysLoad: true,
    timeout: 600_000,
    tools: [
      tool(
        'bash',
        'Run a shell command inside the PC you are seated at (cwd persists between calls).',
        {
          command: z.string().describe('The command to execute'),
          timeout: z.number().optional().describe('Timeout in milliseconds (max 600000)'),
          description: z.string().optional().describe('Short description of what the command does'),
          run_in_background: z.boolean().optional().describe('Run the command in the background'),
          dangerouslyDisableSandbox: z.boolean().optional().describe('Ignored inside a PC'),
        },
        async (args) => {
          called('mcp__pc__bash', args);
          return text(`FAKE-PC-BASH-OUTPUT\n${args.command?.startsWith('echo ') ? args.command.slice(5) : '(ok)'}`);
        },
      ),
      tool(
        'read',
        'Read a file inside the PC. Output uses cat -n line numbering.',
        {
          file_path: z.string().describe('The absolute path to the file to read'),
          offset: z.number().optional().describe('Line number to start reading from'),
          limit: z.number().optional().describe('Number of lines to read'),
          pages: z.string().optional().describe('Page range for PDF files'),
        },
        async (args) => {
          called('mcp__pc__read', args);
          return text('     1\tFAKE-PC-READ first line\n     2\tsecond line');
        },
        { annotations: { readOnlyHint: true } },
      ),
      tool(
        'edit',
        'Replace an exact string in a file inside the PC.',
        {
          file_path: z.string(),
          old_string: z.string(),
          new_string: z.string(),
          replace_all: z.boolean().optional(),
        },
        async (args) => {
          called('mcp__pc__edit', args);
          return text(`FAKE-PC-EDIT: The file ${args.file_path} has been updated.`);
        },
      ),
      tool(
        'write',
        'Write a file inside the PC.',
        { file_path: z.string(), content: z.string() },
        async (args) => {
          called('mcp__pc__write', args);
          return text(`FAKE-PC-WRITE: File created successfully at: ${args.file_path}`);
        },
      ),
      tool(
        'glob',
        'Find files by glob pattern inside the PC.',
        { pattern: z.string(), path: z.string().optional() },
        async (args) => {
          called('mcp__pc__glob', args);
          return text('FAKE-PC-GLOB\n/home/cua/fake/a.txt');
        },
        { annotations: { readOnlyHint: true } },
      ),
      tool(
        'grep',
        'Search file contents with ripgrep inside the PC.',
        {
          pattern: z.string(),
          path: z.string().optional(),
          glob: z.string().optional(),
          output_mode: z.enum(['content', 'files_with_matches', 'count']).optional(),
          '-B': z.number().optional(),
          '-A': z.number().optional(),
          '-C': z.number().optional(),
          context: z.number().optional(),
          '-n': z.boolean().optional(),
          '-i': z.boolean().optional(),
          '-o': z.boolean().optional(),
          type: z.string().optional(),
          head_limit: z.number().optional(),
          offset: z.number().optional(),
          multiline: z.boolean().optional(),
        },
        async (args) => {
          called('mcp__pc__grep', args);
          return text('FAKE-PC-GREP\n/home/cua/fake/a.txt');
        },
        { annotations: { readOnlyHint: true } },
      ),
    ],
  });

  return { mc, pc };
}

// ---------------------------------------------------------------- gate + broker

const allowMcPc = (input) =>
  input.tool_name?.startsWith('mcp__mc__') || input.tool_name?.startsWith('mcp__pc__')
    ? { decision: 'allow', reason: 'spike ToolGate: mc/pc allowed' }
    : null; // no decision: broker tools fall through to canUseTool

/** PreToolUse hook that records what the gate sees, then decides via `decide`. */
export function makeGate(rec, decide = allowMcPc, onCall) {
  return async (input) => {
    const entry = {
      turn: rec.turn,
      t: rec.t(),
      hook_event_name: input.hook_event_name,
      tool_name: input.tool_name,
      has_permission_mode: Object.hasOwn(input, 'permission_mode'),
      permission_mode: input.permission_mode,
      effort: input.effort?.level,
      mcp_server: input.mcp_server,
      tool_use_id: input.tool_use_id,
      tool_input_keys: Object.keys(input.tool_input ?? {}),
      tool_input: trunc(JSON.stringify(input.tool_input), 600),
      input_keys: Object.keys(input),
    };
    rec.hookCalls.push(sanitize(entry));
    rec.event('hook', entry);
    onCall?.(input);
    const d = decide(input);
    if (!d) return {};
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: d.decision,
        permissionDecisionReason: d.reason,
      },
    };
  };
}

/** Generic hook logger (PreModelSwitch / PostModelSwitch / anything). */
export function makeLogHook(rec) {
  return async (input) => {
    const { session_id, transcript_path, cwd, ...rest } = input;
    rec.event('hook_other', rest);
    (rec.data.otherHooks ??= []).push(sanitize({ turn: rec.turn, t: rec.t(), ...rest }));
    return {};
  };
}

/** canUseTool broker: records every call; per-tool handlers decide, built-ins are denied. */
export function makeBroker(rec, handlers = {}) {
  return async (toolName, input, opts) => {
    const entry = {
      turn: rec.turn,
      t: rec.t(),
      toolName,
      input_keys: Object.keys(input ?? {}),
      toolUseID: opts?.toolUseID,
      mcpServer: opts?.mcpServer,
      decisionReason: opts?.decisionReason,
      blockedPath: opts?.blockedPath,
      title: opts?.title,
      suggestions: opts?.suggestions?.length ?? 0,
    };
    rec.canUseToolCalls.push(sanitize(entry));
    rec.event('canUseTool', { ...entry, input: trunc(JSON.stringify(input), 1500) });
    const handler = handlers[toolName] ?? handlers['*'];
    let res;
    if (handler) res = await handler(input, opts);
    else if (HOST_BUILTINS.has(toolName)) res = { behavior: 'deny', message: 'Spike broker: host built-in tools are denied.' };
    else res = { behavior: 'allow', updatedInput: input };
    rec.event('canUseTool_decision', { toolName, behavior: res.behavior, updatedInput: res.updatedInput && trunc(JSON.stringify(res.updatedInput), 1500) });
    return res;
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

/** Base options in the PLAN §6.1 shape. Overrides win. */
export function baseOptions(rec, overrides = {}) {
  mkdirSync(OUT, { recursive: true });
  const cwd = mkdtempSync(join(OUT, `cwd-${rec.check}-`));
  return {
    env: agentEnv(),
    settingSources: [],
    strictMcpConfig: true,
    permissionMode: 'default',
    cwd,
    persistSession: false,
    model: HAIKU,
    settings: { effortLevel: 'xhigh' },
    thinking: { type: 'adaptive' },
    includePartialMessages: false,
    tools: [...BUILTIN_TOOLS],
    disallowedTools: [...DISALLOWED_TOOLS],
    toolAliases: { ...TOOL_ALIASES },
    mcpServers: makeServers(rec),
    allowedTools: ['mcp__mc__*', 'mcp__pc__*'],
    hooks: { PreToolUse: [{ hooks: [makeGate(rec)] }] },
    canUseTool: makeBroker(rec),
    systemPrompt: { type: 'preset', preset: 'claude_code', append: PERSONA },
    maxTurns: 4,
    maxBudgetUsd: 0.5,
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
  const listeners = new Set();
  let sessionId;
  let failure;

  const pump = (async () => {
    try {
      for await (const m of q) {
        if (m.session_id) sessionId = m.session_id;
        rec.onMessage(m);
        for (const l of listeners) l(m);
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
    inbox,
    pump,
    get sessionId() {
      return sessionId;
    },
    on(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    send(content, extra = {}) {
      const msg = userMessage(content, extra);
      rec.event('send', { uuid: msg.uuid, content: trunc(typeof content === 'string' ? content : JSON.stringify(content), 400), extra });
      inbox.push(msg);
      return msg.uuid;
    },
    nextResult(timeoutMs = 120_000) {
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

/** Final text of the assistant messages that belong to a given turn label. */
export function turnTexts(rec, turn) {
  return rec.events
    .filter((e) => e.kind === 'msg' && e.type === 'assistant' && e.turn === turn)
    .flatMap((e) => e.blocks.filter((b) => b.type === 'text').map((b) => b.text));
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

/** Numeric dotted-version comparison ("2.1.293" >= "2.1.30"). */
export function versionAtLeast(v, min) {
  const a = String(v).split(/[.\s]/).map((n) => Number.parseInt(n, 10) || 0);
  const b = String(min).split('.').map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return true;
}
