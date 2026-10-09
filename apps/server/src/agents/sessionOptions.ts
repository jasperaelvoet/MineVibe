/**
 * The exact `query()` options of an agent's two sessions (PLAN §6.1, dual sessions; as amended by S2/S3/S3b).
 *
 * Both sessions:
 * - `settingSources: []`, `strictMcpConfig`, the allowlisted env, a cwd of the agent's own (never a Vault path), a
 *   persistent session (`sessionId` new, `resume` later) with a fixed `title` (a custom title skips Claude Code's
 *   automatic title generation, which is one model call on a new session's first message);
 * - USER DECISION 2026-10-08: `permissionMode: 'bypassPermissions'` with `allowDangerouslySkipPermissions: true`
 *   ({@link AGENT_PERMISSION_MODE}); ToolGate (PreToolUse) stays the authoritative, fail-closed guard, and
 *   AskUserQuestion / ExitPlanMode still reach canUseTool (verified live). The SDK warns
 *   `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED` at startup; for those two interaction tools the warning does not hold;
 * - no TodoWrite (2.1.293 drops it silently), **no `allowedTools`** (S2: it would shadow canUseTool), the host tools
 *   (Bash, Read, …, Agent, Task) disallowed;
 * - a fixed model and effort for the session's whole life (no `applyFlagSettings` swaps), adaptive thinking, partial
 *   messages, the preset system prompt with the session's persona appended.
 *
 * - **Body** (Haiku 5.5 xhigh): the `mc` server with every tool of the set, AskUserQuestion. No `pc` server, no
 *   aliases, no web.
 * - **Desk** (Opus 5.5 medium, one per agent and PC): the `pc` server, Bash/Read/Edit/Write/Glob/Grep/TaskStop
 *   aliased to it, WebSearch/WebFetch, an `mc` server with only PC mode's minimal set, AskUserQuestion, and
 *   ExitPlanMode only while Plan-first is on (the session then starts in plan mode).
 *
 * Hooks (PreToolUse = ToolGate) and canUseTool are added by AgentSession.
 */

import type { McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import type { ResolvedClaude } from './claudeBinary.js';
import {
  AGENT_PERMISSION_MODE,
  BODY_BUILTIN_TOOLS,
  BODY_PROFILE,
  type BrainProfile,
  DESK_PROFILE,
  DISALLOWED_TOOLS,
  deskBuiltinTools,
  type SessionKind,
  TOOL_ALIASES,
} from './constants.js';
import type { Options } from './sdk.js';

interface CommonInput {
  readonly claude: ResolvedClaude;
  /** The allowlisted agent env (agentEnv()). */
  readonly env: Record<string, string>;
  /** The session's claude cwd (`worlds/<w>/agents/<id>/home`, or the desk's own folder). */
  readonly cwd: string;
  /** Resume this session (it was started before), or start a new one with `sessionId`. */
  readonly resume: string | null;
  readonly sessionId: string;
  readonly persona: string;
  /** The session's fixed title (`MineVibe · Ada · body · World #2`). */
  readonly title?: string | undefined;
  /** Overrides the session kind's model (the eval harness only). */
  readonly profile?: BrainProfile | undefined;
  readonly stderr?: ((data: string) => void) | undefined;
}

export interface BodySessionInput extends CommonInput {
  readonly kind: 'body';
  /** Every `mc` tool of the agent's set. */
  readonly mc: McpSdkServerConfigWithInstance;
}

export interface DeskSessionInput extends CommonInput {
  readonly kind: 'desk';
  /** PC mode's minimal `mc` set. */
  readonly mc: McpSdkServerConfigWithInstance;
  readonly pc: McpSdkServerConfigWithInstance;
  /** The player's Plan-first toggle: ExitPlanMode is listed and the session starts in plan mode. */
  readonly planFirst?: boolean | undefined;
}

export type SessionOptionsInput = BodySessionInput | DeskSessionInput;

export type BaseSessionOptions = Omit<Options, 'hooks' | 'canUseTool'>;

/** The fixed title of a session (`MineVibe · Ada · desk:linux-1 · World #2`). */
export function sessionTitle(input: {
  readonly name: string;
  readonly kind: SessionKind;
  readonly pcId?: string | null | undefined;
  readonly worldGen?: number | null | undefined;
}): string {
  const where = input.kind === 'desk' ? `desk:${input.pcId ?? 'pc'}` : 'body';
  const world = input.worldGen ? ` · World #${input.worldGen}` : '';
  return `MineVibe · ${input.name} · ${where}${world}`;
}

export function buildSessionOptions(input: SessionOptionsInput): BaseSessionOptions {
  const desk = input.kind === 'desk';
  const profile = input.profile ?? (desk ? DESK_PROFILE : BODY_PROFILE);
  const planFirst = desk && input.planFirst === true;
  const options: BaseSessionOptions = {
    env: { ...input.env },
    settingSources: [],
    strictMcpConfig: true,
    // USER DECISION 2026-10-08: bypassPermissions; ToolGate is the sandbox guard (see AGENT_PERMISSION_MODE). A
    // plan-first desk session starts in plan mode; an approved plan returns it to bypassPermissions.
    permissionMode: planFirst ? 'plan' : AGENT_PERMISSION_MODE,
    allowDangerouslySkipPermissions: true,
    cwd: input.cwd,
    persistSession: true,
    model: profile.model,
    settings: { effortLevel: profile.effort === 'max' ? 'xhigh' : profile.effort },
    thinking: { type: 'adaptive' },
    includePartialMessages: true,
    tools: desk ? deskBuiltinTools(planFirst) : [...BODY_BUILTIN_TOOLS],
    disallowedTools: [...DISALLOWED_TOOLS],
    mcpServers: input.kind === 'desk' ? { mc: input.mc, pc: input.pc } : { mc: input.mc },
    systemPrompt: { type: 'preset', preset: 'claude_code', append: input.persona },
  };
  if (desk) options.toolAliases = { ...TOOL_ALIASES };
  if (input.title) options.title = input.title;
  if (input.claude.path !== undefined) options.pathToClaudeCodeExecutable = input.claude.path;
  if (input.resume !== null) options.resume = input.resume;
  else options.sessionId = input.sessionId;
  if (input.stderr) options.stderr = input.stderr;
  return options;
}
