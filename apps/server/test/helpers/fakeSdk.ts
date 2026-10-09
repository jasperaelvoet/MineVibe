/**
 * A fake Claude Agent SDK `query()` for unit tests: no process, no network. The test drives the stream (init,
 * assistant text and tool_use, results, rate limits) and simulates what the CLI does around a tool call: the
 * PreToolUse hook, canUseTool for "no decision", then the in-process MCP tool handler (with the tool's own input
 * validation). Control calls (`setPermissionMode`, `interrupt`, and `applyFlagSettings`, which the runtime no longer
 * makes since dual sessions: tests assert it stays unused) are recorded; `applyFlagSettings` would fire the
 * PostModelSwitch hook during the call, as CC 2.1.293 does (S3).
 *
 * Permission modes follow what the live check of USER DECISION 2026-10-08 showed (spikes/s2-s3-sdk/result.md, "bypass
 * mode"): under `bypassPermissions` a call the hook leaves undecided is auto-allowed without canUseTool, except the
 * interaction tools AskUserQuestion and ExitPlanMode, which still reach canUseTool. An approved ExitPlanMode leaves
 * plan mode for the mode the session had before it (unless Node already switched).
 */

import { randomUUID } from 'node:crypto';
import type {
  AccountInfo,
  EffortLevel,
  HookCallback,
  ModelInfo,
  Options,
  PermissionMode,
  PermissionResult,
  SDKMessage,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type { QueryFactory, QueryLike } from '../../src/agents/sdk.js';

export const FAKE_MODELS: ModelInfo[] = [
  {
    value: 'haiku',
    resolvedModel: 'claude-haiku-5-5',
    displayName: 'Haiku 5.5',
    description: '',
    supportsEffort: true,
    supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
  },
  {
    value: 'opus',
    resolvedModel: 'claude-opus-5-5',
    displayName: 'Opus 5.5',
    description: '',
    supportsEffort: true,
    supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
  },
  { value: 'default', resolvedModel: 'claude-opus-5-5', displayName: 'Default', description: '' },
];

/** The fake account's e-mail address (what Claude Code's `session_context` would show the model). */
export const FAKE_ACCOUNT_EMAIL = 'player@example.com';

export type ToolCallOutcome =
  | { readonly kind: 'denied'; readonly by: 'gate' | 'broker'; readonly reason: string }
  | {
      readonly kind: 'allowed';
      readonly input: Record<string, unknown>;
      readonly result: unknown;
      readonly context?: string;
    }
  | { readonly kind: 'invalid'; readonly error: string };

interface Registered {
  inputSchema?: { safeParse(v: unknown): { success: boolean; data?: unknown; error?: { message: string } } };
  handler: (args: unknown, extra: unknown) => Promise<unknown>;
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Tools that ask the user even under bypassPermissions (verified live, CC 2.1.293). */
const INTERACTION_TOOLS: ReadonlySet<string> = new Set(['AskUserQuestion', 'ExitPlanMode']);

export class FakeQuery implements QueryLike {
  readonly options: Options;
  readonly sent: SDKUserMessage[] = [];
  readonly calls: { method: string; args: unknown }[] = [];
  readonly sessionId = randomUUID();
  /** The account the fake CLI runs on (its e-mail address and organisation feed the outbound redactor). */
  account: AccountInfo = {
    subscriptionType: 'Claude Max',
    apiProvider: 'firstParty',
    email: FAKE_ACCOUNT_EMAIL,
    organization: `${FAKE_ACCOUNT_EMAIL}'s Organization`,
  };
  models: ModelInfo[] = FAKE_MODELS;
  model: string;
  effort: EffortLevel | null;
  permissionMode: PermissionMode;
  /** The mode before the last switch into plan mode (an approved ExitPlanMode returns to it). */
  prePlanMode: PermissionMode = 'default';
  closed = false;
  interrupted = 0;
  #out: SDKMessage[] = [];
  #waiters: { resolve: (r: IteratorResult<SDKMessage>) => void; reject: (e: Error) => void }[] = [];
  #crashError: Error | null = null;
  #userWaiters: ((m: SDKUserMessage) => void)[] = [];
  /** Called for each user message the session sends. */
  onUser: ((m: SDKUserMessage) => void) | null = null;

  constructor(params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) {
    this.options = params.options;
    this.model = typeof params.options.model === 'string' ? params.options.model : 'claude-haiku-5-5';
    const settings = params.options.settings;
    this.effort = (typeof settings === 'object' && settings?.effortLevel) || null;
    this.permissionMode = params.options.permissionMode ?? 'default';
    void (async () => {
      for await (const m of params.prompt) {
        this.sent.push(m);
        this.onUser?.(m);
        for (const w of this.#userWaiters.splice(0)) w(m);
      }
      // The CLI exits when its input ends (streaming mode), which ends the stream.
      this.end();
    })();
  }

  // ---- QueryLike ------------------------------------------------------------------------------------------------

  async interrupt(): Promise<undefined> {
    this.calls.push({ method: 'interrupt', args: null });
    this.interrupted++;
    return undefined;
  }

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    this.calls.push({ method: 'setPermissionMode', args: mode });
    if (mode === 'plan' && this.permissionMode !== 'plan') this.prePlanMode = this.permissionMode;
    this.permissionMode = mode;
  }

  async applyFlagSettings(settings: {
    model?: string | null;
    effortLevel?: EffortLevel | null;
  }): Promise<void> {
    this.calls.push({ method: 'applyFlagSettings', args: settings });
    if (settings.effortLevel !== undefined) this.effort = settings.effortLevel;
    if (settings.model && settings.model !== this.model) {
      const from = this.model;
      this.model = settings.model;
      for (const matcher of this.options.hooks?.PostModelSwitch ?? []) {
        for (const hook of matcher.hooks) {
          await hook(
            {
              hook_event_name: 'PostModelSwitch',
              session_id: this.sessionId,
              transcript_path: '/dev/null',
              cwd: this.options.cwd ?? '/',
              from_model: from,
              to_model: settings.model,
              requested_model: settings.model,
              source: 'sdk',
              context_tokens: 9000,
              prompt_cache_warm: true,
              cache_ttl: '1h',
              estimated_cache_write_usd: 0.07,
              pricing: 'catalog',
            } as never,
            undefined,
            { signal: new AbortController().signal },
          );
        }
      }
    }
  }

  async accountInfo(): Promise<AccountInfo> {
    return this.account;
  }

  async supportedModels(): Promise<ModelInfo[]> {
    return this.models;
  }

  close(): void {
    this.calls.push({ method: 'close', args: null });
    this.end();
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKMessage> {
    return {
      next: () => {
        const m = this.#out.shift();
        if (m) return Promise.resolve({ value: m, done: false });
        if (this.#crashError) return Promise.reject(this.#crashError);
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve, reject) => this.#waiters.push({ resolve, reject }));
      },
    };
  }

  // ---- stream drivers -------------------------------------------------------------------------------------------

  emit(message: SDKMessage): void {
    const w = this.#waiters.shift();
    if (w) w.resolve({ value: message, done: false });
    else this.#out.push(message);
  }

  /** Ends the stream (as if the CLI exited). */
  end(): void {
    this.closed = true;
    for (const w of this.#waiters.splice(0)) w.resolve({ value: undefined, done: true });
  }

  /** Ends the stream with an error. */
  crash(message = 'claude exited with code 1'): void {
    const err = new Error(message);
    this.closed = true;
    this.#crashError = err;
    this.#out = [];
    for (const w of this.#waiters.splice(0)) w.reject(err);
  }

  init(extra: Record<string, unknown> = {}): void {
    this.emit({
      type: 'system',
      subtype: 'init',
      apiKeySource: 'none',
      claude_code_version: '2.1.293',
      cwd: this.options.cwd ?? '/',
      tools: ['AskUserQuestion', 'ExitPlanMode', 'WebSearch', 'WebFetch', 'mcp__mc__status', 'mcp__pc__bash'],
      mcp_servers: [
        { name: 'mc', status: 'connected' },
        { name: 'pc', status: 'connected' },
      ],
      model: this.model,
      permissionMode: this.permissionMode,
      slash_commands: [],
      output_style: 'default',
      skills: [],
      plugins: [],
      uuid: randomUUID(),
      session_id: this.sessionId,
      ...extra,
    } as never);
  }

  assistantText(text: string): void {
    this.emit({
      type: 'assistant',
      message: { id: randomUUID(), model: this.model, role: 'assistant', content: [{ type: 'text', text }] },
      parent_tool_use_id: null,
      uuid: randomUUID(),
      session_id: this.sessionId,
    } as never);
  }

  assistantToolUse(
    name: string,
    input: Record<string, unknown>,
    id = `toolu_${randomUUID().slice(0, 8)}`,
  ): string {
    const messageId = `msg_${randomUUID().slice(0, 12)}`;
    if (this.options.includePartialMessages) {
      // What the CLI streams with includePartialMessages: the message starts, the tool_use block starts, it stops.
      for (const event of [
        { type: 'message_start', message: { id: messageId } },
        { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id, name, input: {} } },
        { type: 'message_stop' },
      ]) {
        this.emit({
          type: 'stream_event',
          event,
          parent_tool_use_id: null,
          uuid: randomUUID(),
          session_id: this.sessionId,
        } as never);
      }
    }
    this.emit({
      type: 'assistant',
      message: {
        id: messageId,
        model: this.model,
        role: 'assistant',
        content: [{ type: 'tool_use', id, name, input }],
      },
      parent_tool_use_id: null,
      uuid: randomUUID(),
      session_id: this.sessionId,
    } as never);
    return id;
  }

  assistantError(error: string): void {
    this.emit({
      type: 'assistant',
      error,
      message: { id: randomUUID(), model: '<synthetic>', role: 'assistant', content: [] },
      parent_tool_use_id: null,
      uuid: randomUUID(),
      session_id: this.sessionId,
    } as never);
  }

  result(fields: Record<string, unknown> = {}): void {
    this.emit({
      type: 'result',
      subtype: 'success',
      duration_ms: 1000,
      duration_api_ms: 900,
      is_error: false,
      num_turns: 1,
      result: 'ok',
      stop_reason: 'end_turn',
      total_cost_usd: 0.001,
      usage: {
        input_tokens: 100,
        output_tokens: 20,
        cache_read_input_tokens: 5000,
        cache_creation_input_tokens: 0,
      },
      modelUsage: {},
      permission_denials: [],
      uuid: randomUUID(),
      session_id: this.sessionId,
      ...fields,
    } as never);
  }

  rateLimit(info: Record<string, unknown>): void {
    this.emit({
      type: 'rate_limit_event',
      rate_limit_info: info,
      uuid: randomUUID(),
      session_id: this.sessionId,
    } as never);
  }

  // ---- tool calls (what the CLI does) ---------------------------------------------------------------------------

  /** Waits until the session sent `n` user messages in total. */
  async waitForSent(n: number, timeoutMs = 2000): Promise<SDKUserMessage> {
    const start = Date.now();
    while (this.sent.length < n) {
      if (Date.now() - start > timeoutMs)
        throw new Error(`only ${this.sent.length} user messages, wanted ${n}`);
      await new Promise<SDKUserMessage>((resolve) => {
        this.#userWaiters.push(resolve);
        setTimeout(() => resolve(this.sent.at(-1) as SDKUserMessage), 50);
      });
    }
    return this.sent[n - 1] as SDKUserMessage;
  }

  /** The PreToolUse hook's raw output for a call. */
  async preToolUse(toolName: string, input: Record<string, unknown>, extra: Record<string, unknown> = {}) {
    const hooks = this.options.hooks?.PreToolUse ?? [];
    let out: Record<string, unknown> = {};
    for (const matcher of hooks) {
      for (const hook of matcher.hooks as HookCallback[]) {
        out = (await hook(
          {
            hook_event_name: 'PreToolUse',
            session_id: this.sessionId,
            transcript_path: '/dev/null',
            cwd: this.options.cwd ?? '/',
            permission_mode: this.permissionMode,
            effort: { level: this.effort ?? 'xhigh' },
            tool_name: toolName,
            tool_input: input,
            tool_use_id: `toolu_${randomUUID().slice(0, 8)}`,
            ...(toolName.startsWith('mcp__')
              ? { mcp_server: { name: toolName.split('__')[1], source: 'sdk' } }
              : {}),
            ...extra,
          } as never,
          undefined,
          { signal: new AbortController().signal },
        )) as Record<string, unknown>;
      }
    }
    return out as {
      hookSpecificOutput?: {
        permissionDecision?: string;
        permissionDecisionReason?: string;
        additionalContext?: string;
      };
    };
  }

  /**
   * One tool call as the CLI runs it: gate → (no decision) canUseTool → tool. Built-in broker tools return the
   * canUseTool result; mcp tools run their handler on the validated input.
   */
  async callTool(
    toolName: string,
    input: Record<string, unknown>,
    options: { signal?: AbortSignal; extra?: Record<string, unknown>; toolUseId?: string } = {},
  ): Promise<ToolCallOutcome> {
    const hook = await this.preToolUse(toolName, input, {
      ...(options.toolUseId ? { tool_use_id: options.toolUseId } : {}),
      ...options.extra,
    });
    const decision = hook.hookSpecificOutput?.permissionDecision;
    let finalInput = input;
    if (decision === 'deny')
      return { kind: 'denied', by: 'gate', reason: hook.hookSpecificOutput?.permissionDecisionReason ?? '' };
    const bypassed =
      this.permissionMode === 'bypassPermissions' &&
      this.options.allowDangerouslySkipPermissions === true &&
      !INTERACTION_TOOLS.has(toolName);
    if (decision !== 'allow' && !bypassed) {
      const canUse = this.options.canUseTool;
      if (!canUse) return { kind: 'denied', by: 'broker', reason: 'no canUseTool' };
      const res: PermissionResult | null = await canUse(toolName, input, {
        signal: options.signal ?? new AbortController().signal,
        toolUseID: `toolu_${randomUUID().slice(0, 8)}`,
        requestId: randomUUID(),
      });
      if (!res || res.behavior === 'deny')
        return { kind: 'denied', by: 'broker', reason: res?.message ?? 'null' };
      finalInput = res.updatedInput ?? input;
      if (toolName === 'ExitPlanMode' && this.permissionMode === 'plan')
        this.permissionMode = this.prePlanMode;
      if (toolName === 'EnterPlanMode') {
        if (this.permissionMode !== 'plan') this.prePlanMode = this.permissionMode;
        this.permissionMode = 'plan';
      }
      if (!toolName.startsWith('mcp__')) return { kind: 'allowed', input: finalInput, result: null };
    } else if (decision !== 'allow' && !toolName.startsWith('mcp__')) {
      // Auto-allowed by bypassPermissions (a built-in the hook left undecided).
      return { kind: 'allowed', input: finalInput, result: null };
    }
    const [, server, name] = toolName.split('__');
    const cfg = this.options.mcpServers?.[server ?? ''] as
      | { instance?: { _registeredTools?: Record<string, Registered> } }
      | undefined;
    const tool = cfg?.instance?._registeredTools?.[name ?? ''];
    if (!tool) return { kind: 'invalid', error: `no tool ${toolName}` };
    const parsed = tool.inputSchema
      ? tool.inputSchema.safeParse(finalInput)
      : { success: true, data: finalInput };
    if (!parsed.success) return { kind: 'invalid', error: parsed.error?.message ?? 'invalid' };
    // Claude Code passes the call's tool_use id in the MCP request's `_meta` (2.1.293).
    const result = await tool.handler(
      parsed.data,
      options.toolUseId ? { _meta: { 'claudecode/toolUseId': options.toolUseId } } : {},
    );
    const context = hook.hookSpecificOutput?.additionalContext;
    return context
      ? { kind: 'allowed', input: finalInput, result, context }
      : { kind: 'allowed', input: finalInput, result };
  }
}

/** The text of a tool result (first text block). */
export function resultText(outcome: ToolCallOutcome): string {
  if (outcome.kind !== 'allowed') return outcome.kind === 'denied' ? outcome.reason : outcome.error;
  const r = outcome.result as { content?: { type: string; text?: string }[] } | null;
  return (r?.content ?? [])
    .filter((c) => c.type === 'text')
    .map((c) => c.text ?? '')
    .join('\n');
}

export function isErrorResult(outcome: ToolCallOutcome): boolean {
  return outcome.kind === 'allowed' && (outcome.result as { isError?: boolean } | null)?.isError === true;
}

/** A factory that records every query it creates. */
export function fakeQueryFactory(): QueryFactory & { queries: FakeQuery[]; last(): FakeQuery } {
  const queries: FakeQuery[] = [];
  const factory = ((params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => {
    const q = new FakeQuery(params);
    queries.push(q);
    return q;
  }) as unknown as QueryFactory & { queries: FakeQuery[]; last(): FakeQuery };
  factory.queries = queries;
  factory.last = () => {
    const q = queries.at(-1);
    if (!q) throw new Error('no query created');
    return q;
  };
  return factory;
}

/** Lets pending promises and setImmediate callbacks run. */
export async function settle(rounds = 5): Promise<void> {
  for (let i = 0; i < rounds; i++) await tick();
}

/** The user message text. */
export function userText(m: SDKUserMessage | undefined): string {
  const c = m?.message.content;
  return typeof c === 'string' ? c : JSON.stringify(c);
}
