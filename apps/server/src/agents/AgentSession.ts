/**
 * AgentSession (PLAN §6.1): one long-lived streaming `query()` per agent.
 *
 * - The prompt is an inbox (async iterable) Node pushes user messages into: wakes (`shouldQuery` default), context
 *   (`shouldQuery:false`, no API call) and interrupts (`priority:'now'`).
 * - Stream handling: main-thread assistant text and tool_use blocks go to the callbacks (bubbles, transcript, activity),
 *   `rate_limit_event` to the UsageGovernor, `result` ends a turn. **Results with `num_turns === 0` are ignored** (S2:
 *   a `shouldQuery:false` send emits one) unless an interrupt is pending or the result is an error.
 * - Model swaps use `applyFlagSettings` at turn boundaries and are acknowledged by the `PostModelSwitch` hook, which
 *   fires during the call (S3, 57-94 ms). An effort-only change fires no hook.
 * - Startup assertions run on the first `system/init` ({@link checkStartup}).
 */

import { randomUUID } from 'node:crypto';
import type { Logger } from 'pino';
import { type BrainProfile, FORBIDDEN_INIT_TOOLS, HAIKU, OPUS, SWAP_ACK_TIMEOUT_MS } from './constants.js';
import type {
  CanUseTool,
  HookCallback,
  HookJSONOutput,
  Options,
  PermissionMode,
  PostModelSwitchHookInput,
  QueryFactory,
  QueryLike,
  SDKAssistantMessage,
  SDKMessage,
  SDKRateLimitInfo,
  SDKResultMessage,
  SDKSystemMessage,
  SDKUserMessage,
} from './sdk.js';

/** A push-driven async iterable of user messages (the streaming prompt). */
export class Inbox implements AsyncIterable<SDKUserMessage> {
  #queue: SDKUserMessage[] = [];
  #waiters: ((r: IteratorResult<SDKUserMessage>) => void)[] = [];
  #closed = false;

  get closed(): boolean {
    return this.#closed;
  }

  push(message: SDKUserMessage): void {
    if (this.#closed) throw new Error('inbox closed');
    const waiter = this.#waiters.shift();
    if (waiter) waiter({ value: message, done: false });
    else this.#queue.push(message);
  }

  close(): void {
    this.#closed = true;
    for (const w of this.#waiters.splice(0)) w({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const queued = this.#queue.shift();
        if (queued) return Promise.resolve({ value: queued, done: false });
        if (this.#closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => this.#waiters.push(resolve));
      },
      return: async () => {
        this.close();
        return { value: undefined, done: true };
      },
    };
  }
}

export interface SendOptions {
  /** `now` interrupts, `next` folds into a running turn at the next tool boundary, `later` runs as its own turn. */
  readonly priority?: 'now' | 'next' | 'later' | undefined;
  /** false: context only, no API call (S2). */
  readonly shouldQuery?: boolean | undefined;
  /**
   * A slash command (`/compact`): its result ends a turn even when it reports `num_turns: 0`, so the turn is never left
   * open (and nobody waiting for its end hangs).
   */
  readonly command?: boolean | undefined;
}

export interface SessionCallbacks {
  onInit?(init: SDKSystemMessage, first: boolean): void;
  /** Main-thread assistant text (one call per text block). */
  onAssistantText?(text: string, model: string | null): void;
  onToolUse?(name: string, input: unknown, toolUseId: string): void;
  onAssistantError?(error: NonNullable<SDKAssistantMessage['error']>): void;
  /** A real turn ended (zero-turn context results are filtered out). */
  onTurnEnd?(result: SDKResultMessage): void;
  onRateLimit?(info: SDKRateLimitInfo): void;
  onModelSwitched?(input: PostModelSwitchHookInput): void;
  onCompacted?(): void;
  /** The stream ended: `error` null after {@link AgentSession.close}, otherwise why it died. */
  onExit?(error: Error | null): void;
  /** Every message, for logging and tests. */
  onMessage?(message: SDKMessage): void;
}

export interface SessionConfig {
  readonly agentId: string;
  /** Options without hooks and canUseTool (the session adds them). */
  readonly options: Omit<Options, 'hooks' | 'canUseTool'>;
  readonly gate: HookCallback;
  readonly canUseTool: CanUseTool;
  readonly queryFactory: QueryFactory;
  readonly log?: Logger | undefined;
  readonly now?: () => number;
  readonly swapAckTimeoutMs?: number;
}

export interface SwapResult {
  readonly from: string | null;
  readonly to: string;
  readonly ms: number;
  /** The PostModelSwitch hook confirmed the model (always true for an effort-only change). */
  readonly acked: boolean;
  readonly estimatedCacheWriteUsd: number | null;
}

/** Usage numbers of the last real turn (context guard, accounting). */
export interface TurnUsage {
  /** Prompt tokens the next request re-sends (input + cache read + cache write + output). */
  readonly contextTokens: number;
  readonly totalCostUsd: number;
}

function usageOf(result: SDKResultMessage): TurnUsage {
  const u = result.usage as unknown as Record<string, number | undefined>;
  const contextTokens =
    (u.input_tokens ?? 0) +
    (u.cache_read_input_tokens ?? 0) +
    (u.cache_creation_input_tokens ?? 0) +
    (u.output_tokens ?? 0);
  return { contextTokens, totalCostUsd: result.total_cost_usd ?? 0 };
}

export class AgentSession {
  readonly #config: SessionConfig;
  readonly #cb: SessionCallbacks;
  readonly #now: () => number;
  #inbox: Inbox | null = null;
  #query: QueryLike | null = null;
  #pump: Promise<void> | null = null;
  #closing = false;
  #initSeen = false;
  #sessionId: string | null = null;
  #model: string | null = null;
  #inTurn = false;
  #interruptPending = false;
  #commandPending = false;
  #lastUsage: TurnUsage | null = null;
  #swapWaiter: ((input: PostModelSwitchHookInput) => void) | null = null;
  #lastSwitch: PostModelSwitchHookInput | null = null;

  constructor(config: SessionConfig, callbacks: SessionCallbacks = {}) {
    this.#config = config;
    this.#cb = callbacks;
    this.#now = config.now ?? Date.now;
  }

  get started(): boolean {
    return this.#query !== null && !this.#closing;
  }

  /** The SDK session id (from the stream), for `resume`. */
  get sessionId(): string | null {
    return this.#sessionId;
  }

  /** The model the session runs, as last reported (init / PostModelSwitch / assistant message). */
  get model(): string | null {
    return this.#model;
  }

  get inTurn(): boolean {
    return this.#inTurn;
  }

  get lastUsage(): TurnUsage | null {
    return this.#lastUsage;
  }

  /** The options the query was started with (tests). */
  get options(): Options | null {
    return this.#query ? this.#fullOptions() : null;
  }

  start(): void {
    if (this.#query) throw new Error('session already started');
    this.#inbox = new Inbox();
    this.#model = typeof this.#config.options.model === 'string' ? this.#config.options.model : null;
    const q = this.#config.queryFactory({ prompt: this.#inbox, options: this.#fullOptions() });
    this.#query = q;
    this.#pump = this.#run(q);
  }

  #fullOptions(): Options {
    const postSwitch: HookCallback = async (input): Promise<HookJSONOutput> => {
      if (input.hook_event_name === 'PostModelSwitch') this.#onSwitched(input as PostModelSwitchHookInput);
      return {};
    };
    return {
      ...this.#config.options,
      hooks: {
        PreToolUse: [{ hooks: [this.#config.gate] }],
        PostModelSwitch: [{ hooks: [postSwitch] }],
      },
      canUseTool: this.#config.canUseTool,
    };
  }

  /**
   * Pushes a user message. A query message while idle starts a turn; while a turn runs it folds in (`next`) or runs
   * after it (`later`). Returns the message uuid.
   */
  send(text: string, options: SendOptions = {}): string {
    if (!this.#inbox || this.#closing) throw new Error('session not running');
    const uuid = randomUUID();
    const message: SDKUserMessage = {
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      uuid: uuid as SDKUserMessage['uuid'],
      ...(options.priority ? { priority: options.priority } : {}),
      ...(options.shouldQuery === false ? { shouldQuery: false } : {}),
    };
    if (options.shouldQuery !== false) this.#inTurn = true;
    if (options.command === true) this.#commandPending = true;
    this.#inbox.push(message);
    return uuid;
  }

  /** Runs the startup assertions against this session's query. */
  checkStartup(init: SDKSystemMessage, mode: 'subscription' | 'api_key'): Promise<string[]> {
    if (!this.#query) return Promise.resolve(['session not running']);
    return checkStartup(init, this.#query, mode);
  }

  /** Interrupts the running turn; its `result` still arrives and ends the turn. */
  async interrupt(): Promise<void> {
    if (!this.#query || !this.#inTurn) return;
    this.#interruptPending = true;
    try {
      await this.#query.interrupt();
    } catch (err) {
      this.#config.log?.warn({ err, agentId: this.#config.agentId }, 'interrupt failed');
    }
  }

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    if (!this.#query) throw new Error('session not running');
    await this.#query.setPermissionMode(mode);
  }

  /**
   * Swaps model and effort through the flag layer (call only at a turn boundary). Resolves once the PostModelSwitch
   * hook acknowledged the new model, or after the ack timeout.
   */
  async applyProfile(profile: BrainProfile): Promise<SwapResult> {
    const q = this.#query;
    if (!q) throw new Error('session not running');
    const from = this.#model;
    const t0 = this.#now();
    const modelChanges = from !== profile.model;
    const acked = modelChanges
      ? new Promise<PostModelSwitchHookInput | null>((resolve) => {
          const timer = setTimeout(() => {
            this.#swapWaiter = null;
            resolve(null);
          }, this.#config.swapAckTimeoutMs ?? SWAP_ACK_TIMEOUT_MS);
          timer.unref?.();
          this.#swapWaiter = (input) => {
            clearTimeout(timer);
            resolve(input);
          };
        })
      : Promise.resolve(null);
    this.#lastSwitch = null;
    await q.applyFlagSettings({ model: profile.model, effortLevel: profile.effort });
    const ack = modelChanges ? (this.#lastSwitch ?? (await acked)) : null;
    this.#swapWaiter = null;
    if (ack) this.#model = ack.to_model;
    else if (!modelChanges) this.#model = profile.model;
    return {
      from,
      to: profile.model,
      ms: this.#now() - t0,
      acked: !modelChanges || ack !== null,
      estimatedCacheWriteUsd: ack?.estimated_cache_write_usd ?? null,
    };
  }

  /** Closes the inbox and the query; the pump ends and `onExit(null)` fires. */
  async close(graceMs = 2_000): Promise<void> {
    if (!this.#query || this.#closing) {
      await this.#pump;
      return;
    }
    this.#closing = true;
    this.#swapWaiter = null;
    this.#inbox?.close();
    const pump = this.#pump ?? Promise.resolve();
    let timer: NodeJS.Timeout | undefined;
    const settled = await Promise.race([
      pump.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), graceMs);
        timer.unref?.();
      }),
    ]);
    clearTimeout(timer);
    if (!settled) {
      try {
        this.#query.close();
      } catch {
        // already gone
      }
    }
    await pump;
  }

  #onSwitched(input: PostModelSwitchHookInput): void {
    this.#lastSwitch = input;
    this.#model = input.to_model;
    this.#swapWaiter?.(input);
    this.#cb.onModelSwitched?.(input);
  }

  async #run(q: QueryLike): Promise<void> {
    let error: Error | null = null;
    try {
      for await (const message of q) this.#onMessage(message);
      if (!this.#closing) error = new Error('the claude process ended');
    } catch (err) {
      if (!this.#closing) error = err instanceof Error ? err : new Error(String(err));
    } finally {
      this.#inTurn = false;
      this.#closing = true;
      this.#inbox?.close();
      try {
        this.#cb.onExit?.(error);
      } catch (err) {
        this.#config.log?.error({ err }, 'session onExit failed');
      }
    }
  }

  #onMessage(m: SDKMessage): void {
    try {
      this.#cb.onMessage?.(m);
    } catch {
      // logging only
    }
    if ('session_id' in m && typeof m.session_id === 'string' && m.session_id.length > 0)
      this.#sessionId = m.session_id;
    switch (m.type) {
      case 'system': {
        if (m.subtype === 'init') {
          const init = m as SDKSystemMessage;
          this.#model = init.model;
          const first = !this.#initSeen;
          this.#initSeen = true;
          this.#cb.onInit?.(init, first);
        } else if (m.subtype === 'compact_boundary') {
          this.#cb.onCompacted?.();
        }
        return;
      }
      case 'assistant': {
        const a = m as SDKAssistantMessage;
        if (a.parent_tool_use_id !== null) return; // subagent traffic (none expected)
        if (a.error) this.#cb.onAssistantError?.(a.error);
        const model = typeof a.message?.model === 'string' ? a.message.model : null;
        if (model && model !== '<synthetic>') this.#model = model;
        for (const block of a.message?.content ?? []) {
          if (block.type === 'text' && block.text.trim().length > 0)
            this.#cb.onAssistantText?.(block.text, model);
          else if (block.type === 'tool_use') this.#cb.onToolUse?.(block.name, block.input, block.id);
        }
        return;
      }
      case 'rate_limit_event':
        this.#cb.onRateLimit?.(m.rate_limit_info);
        return;
      case 'result': {
        const r = m as SDKResultMessage;
        const contextOnly =
          r.num_turns === 0 &&
          r.subtype === 'success' &&
          !r.is_error &&
          !this.#interruptPending &&
          !this.#commandPending;
        if (contextOnly) return;
        this.#interruptPending = false;
        this.#commandPending = false;
        this.#lastUsage = usageOf(r);
        this.#inTurn = (r.queued_turn_count ?? 0) > 0;
        this.#cb.onTurnEnd?.(r);
        return;
      }
      default:
        return;
    }
  }
}

/** Why a session must not run (PLAN §6.1 "Startup assertions"); empty when everything holds. */
export async function checkStartup(
  init: SDKSystemMessage,
  query: Pick<QueryLike, 'accountInfo' | 'supportedModels'>,
  mode: 'subscription' | 'api_key',
): Promise<string[]> {
  const problems: string[] = [];
  if (mode === 'subscription') {
    if (init.apiKeySource !== 'none')
      problems.push(`an API key is in use (${init.apiKeySource}) instead of your subscription`);
    try {
      const account = await query.accountInfo();
      if (!account.subscriptionType)
        problems.push('no Claude subscription is logged in (run `claude` and log in)');
      if (account.apiProvider !== undefined && account.apiProvider !== 'firstParty') {
        problems.push(`claude talks to ${account.apiProvider}, not Anthropic directly`);
      }
    } catch (err) {
      problems.push(`could not read the account (${err instanceof Error ? err.message : String(err)})`);
    }
  }
  try {
    const models = await query.supportedModels();
    const haiku = models.find((m) => m.resolvedModel === HAIKU || m.value === HAIKU);
    const opus = models.find((m) => m.resolvedModel === OPUS || m.value === OPUS);
    if (!haiku) problems.push('Haiku 5.5 is not available to this account');
    else if (haiku.supportedEffortLevels && !haiku.supportedEffortLevels.includes('xhigh')) {
      problems.push('Haiku 5.5 does not offer xhigh effort here (claude too old?)');
    }
    if (!opus) problems.push('Opus 5.5 is not available to this account');
  } catch (err) {
    problems.push(`could not list models (${err instanceof Error ? err.message : String(err)})`);
  }
  const forbidden = init.tools.filter((t) => (FORBIDDEN_INIT_TOOLS as readonly string[]).includes(t));
  if (forbidden.length > 0) problems.push(`host tools are enabled: ${forbidden.join(', ')}`);
  return problems;
}
