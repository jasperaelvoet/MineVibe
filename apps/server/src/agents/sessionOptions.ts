/**
 * The exact `query()` options of an agent session (PLAN §6.1 as amended by S2/S3):
 * - no TodoWrite (2.1.293 drops it silently), and **no `allowedTools` for mc/pc** (S2: it would shadow canUseTool).
 *   Under bypassPermissions (below) an undecided call is auto-allowed anyway, so ToolGate decides every mc/pc/web call
 *   explicitly;
 * - built-ins Bash/Read/Edit/Write/Glob/Grep disallowed *and* aliased to `mcp__pc__*`;
 * - `settingSources: []`, `strictMcpConfig`, the allowlisted env, the agent's own cwd (never a Vault path), a persistent
 *   session (`sessionId` new, `resume` after a restart);
 * - USER DECISION 2026-10-08: `permissionMode: 'bypassPermissions'` with `allowDangerouslySkipPermissions: true`
 *   ({@link AGENT_PERMISSION_MODE}). ToolGate (PreToolUse) stays the authoritative, fail-closed guard; AskUserQuestion
 *   and ExitPlanMode still reach canUseTool (verified live). The SDK warns `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED` at
 *   startup; for those two interaction tools the warning does not hold;
 * - Haiku at xhigh through the flag layer (`settings.effortLevel`), adaptive thinking, partial messages;
 * - the preset system prompt with the persona appended.
 * Hooks (PreToolUse = ToolGate, PostModelSwitch) and canUseTool are added by AgentSession.
 */

import type { McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import type { ResolvedClaude } from './claudeBinary.js';
import {
  AGENT_PERMISSION_MODE,
  type BrainProfile,
  BUILTIN_TOOLS,
  DISALLOWED_TOOLS,
  TOOL_ALIASES,
  WANDERING_PROFILE,
} from './constants.js';
import type { Options } from './sdk.js';

export interface SessionOptionsInput {
  readonly claude: ResolvedClaude;
  /** The allowlisted agent env (agentEnv()). */
  readonly env: Record<string, string>;
  /** `worlds/<w>/agents/<id>/home`. */
  readonly cwd: string;
  /** Resume this session (app restart), or start a new one with `sessionId`. */
  readonly resume: string | null;
  readonly sessionId: string;
  readonly persona: string;
  readonly mc: McpSdkServerConfigWithInstance;
  readonly pc: McpSdkServerConfigWithInstance;
  /** Normally wandering (everyone loads unseated). */
  readonly profile?: BrainProfile;
  readonly stderr?: ((data: string) => void) | undefined;
}

export type BaseSessionOptions = Omit<Options, 'hooks' | 'canUseTool'>;

export function buildSessionOptions(input: SessionOptionsInput): BaseSessionOptions {
  const profile = input.profile ?? WANDERING_PROFILE;
  const options: BaseSessionOptions = {
    env: { ...input.env },
    settingSources: [],
    strictMcpConfig: true,
    // USER DECISION 2026-10-08: always bypassPermissions; ToolGate is the sandbox guard (see AGENT_PERMISSION_MODE).
    permissionMode: AGENT_PERMISSION_MODE,
    allowDangerouslySkipPermissions: true,
    cwd: input.cwd,
    persistSession: true,
    model: profile.model,
    settings: { effortLevel: profile.effort === 'max' ? 'xhigh' : profile.effort },
    thinking: { type: 'adaptive' },
    includePartialMessages: true,
    tools: [...BUILTIN_TOOLS],
    disallowedTools: [...DISALLOWED_TOOLS],
    toolAliases: { ...TOOL_ALIASES },
    mcpServers: { mc: input.mc, pc: input.pc },
    systemPrompt: { type: 'preset', preset: 'claude_code', append: input.persona },
  };
  if (input.claude.path !== undefined) options.pathToClaudeCodeExecutable = input.claude.path;
  if (input.resume !== null) options.resume = input.resume;
  else options.sessionId = input.sessionId;
  if (input.stderr) options.stderr = input.stderr;
  return options;
}
