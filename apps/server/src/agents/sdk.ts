/**
 * The slice of the Claude Agent SDK the brain runtime uses, behind an injectable factory so unit tests can run a
 * fake query object (no live calls). The real factory is {@link sdkQueryFactory}.
 */

import {
  type AccountInfo,
  type EffortLevel,
  type ModelInfo,
  type Options,
  type PermissionMode,
  query,
  type SDKMessage,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';

export type {
  AccountInfo,
  CanUseTool,
  EffortLevel,
  HookCallback,
  HookInput,
  HookJSONOutput,
  ModelInfo,
  Options,
  PermissionMode,
  PermissionResult,
  PostModelSwitchHookInput,
  PreToolUseHookInput,
  SDKAssistantMessage,
  SDKMessage,
  SDKRateLimitInfo,
  SDKResultMessage,
  SDKSystemMessage,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';

/** What AgentSession needs from a running `query()`. */
export interface QueryLike extends AsyncIterable<SDKMessage> {
  interrupt(): Promise<unknown>;
  setPermissionMode(mode: PermissionMode): Promise<void>;
  applyFlagSettings(settings: { model?: string | null; effortLevel?: EffortLevel | null }): Promise<void>;
  accountInfo(): Promise<AccountInfo>;
  supportedModels(): Promise<ModelInfo[]>;
  close(): void;
}

export type QueryFactory = (params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => QueryLike;

/** The production factory: the SDK's own `query()`. */
export const sdkQueryFactory: QueryFactory = ({ prompt, options }) => query({ prompt, options });
