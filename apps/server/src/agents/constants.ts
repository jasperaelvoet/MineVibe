/**
 * Agent runtime constants (PLAN §6). Every number the brain runtime uses lives here so tests and docs can
 * refer to one place.
 */

import type { EffortLevel } from '@anthropic-ai/claude-agent-sdk';
import type { ModelTier } from '@minevibe/protocol';

export const HAIKU = 'claude-haiku-5-5';
export const OPUS = 'claude-opus-5-5';

/** A model/effort pair a session runs with (fixed for the session's whole life: there are no swaps). */
export interface BrainProfile {
  readonly tier: ModelTier;
  readonly model: string;
  readonly effort: EffortLevel;
}

/**
 * The two sessions of an agent (PLAN §6.1, dual sessions): the BODY session lives in the world (wandering, meetings,
 * everything away from a PC); a DESK session works one PC. Each runs one fixed model and one fixed tool list.
 */
export type SessionKind = 'body' | 'desk';

/** The body session: Haiku 5.5 at xhigh (PLAN §1). */
export const BODY_PROFILE: BrainProfile = Object.freeze({ tier: 'haiku', model: HAIKU, effort: 'xhigh' });
/** A desk session (one per agent and PC): Opus 5.5 at medium. */
export const DESK_PROFILE: BrainProfile = Object.freeze({ tier: 'opus', model: OPUS, effort: 'medium' });

/** The profile of a session kind. */
export function profileOf(kind: SessionKind): BrainProfile {
  return kind === 'desk' ? DESK_PROFILE : BODY_PROFILE;
}

/**
 * The permission mode every agent session runs in, and returns to after an approved plan (never `'default'`).
 *
 * USER DECISION 2026-10-08: in-game agents ALWAYS run in `bypassPermissions` (with `allowDangerouslySkipPermissions`).
 * The PreToolUse hook (ToolGate) stays the authoritative, fail-closed sandbox guard: it returns an explicit allow or
 * deny for every mc/pc/web tool, because under bypass a call the hook leaves undecided is auto-allowed without
 * canUseTool. Verified live (spikes/s2-s3-sdk/result.md, "bypass mode"): hooks still run and their denies still block;
 * AskUserQuestion and ExitPlanMode still reach canUseTool (the InteractionBroker), so the card flow is unchanged.
 */
export const AGENT_PERMISSION_MODE = 'bypassPermissions' as const;

/**
 * `options.tools` of the body session: only AskUserQuestion. TodoWrite is silently dropped by CC 2.1.293 (S2), and
 * USER DECISION 2026-10-08: no EnterPlanMode (agents never put themselves into plan mode).
 */
export const BODY_BUILTIN_TOOLS = ['AskUserQuestion'] as const;

/**
 * `options.tools` of a desk session. ExitPlanMode is added only while the player's Plan-first toggle is on
 * ({@link deskBuiltinTools}); a resumed desk session whose toggle changed gets the difference as an in-message tool
 * delta (spike S3b: the list is pinned to the first request, later changes arrive as `deferred_tools_delta`).
 */
export const DESK_BUILTIN_TOOLS = ['AskUserQuestion', 'WebSearch', 'WebFetch'] as const;

/** The desk session's built-ins for the agent's Plan-first toggle. */
export function deskBuiltinTools(planFirst: boolean): string[] {
  return planFirst ? [...DESK_BUILTIN_TOOLS, 'ExitPlanMode'] : [...DESK_BUILTIN_TOOLS];
}

/** Every built-in either session may list (the ToolGate and the mode tables know these). */
export const BUILTIN_TOOLS = ['AskUserQuestion', 'ExitPlanMode', 'WebSearch', 'WebFetch'] as const;

/** Host tools that must never run on the host. */
export const DISALLOWED_TOOLS = [
  'Bash',
  'Read',
  'Edit',
  'Write',
  'Glob',
  'Grep',
  'NotebookEdit',
  'Agent',
  'Task',
] as const;

/**
 * Built-in names routed to the PC tool server in desk sessions (S2: the hook sees the alias target). A model that calls
 * a built-in by habit (Bash, Read, TaskStop, KillShell, …) reaches the PC's tool, which answers in the built-in's
 * format. Body sessions have no pc server and no aliases.
 */
export const TOOL_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  Bash: 'mcp__pc__bash',
  Read: 'mcp__pc__read',
  Edit: 'mcp__pc__edit',
  Write: 'mcp__pc__write',
  Glob: 'mcp__pc__glob',
  Grep: 'mcp__pc__grep',
  TaskStop: 'mcp__pc__task_stop',
  KillShell: 'mcp__pc__task_stop',
});

/** Tools that must never appear in `system/init.tools` (startup assertion). */
export const FORBIDDEN_INIT_TOOLS = [
  'Bash',
  'Read',
  'Edit',
  'Write',
  'Glob',
  'Grep',
  'NotebookEdit',
  'Agent',
  'Task',
  'Skill',
] as const;

/** In-process MCP server tool-call timeout (PLAN §6.1). */
export const MCP_TOOL_TIMEOUT_MS = 600_000;

/** Crew cap and seat cap (PLAN §2). */
/**
 * Agent ids the mod accepts (`AgentService.ID`, `SkillService.AGENT_ID`): it names each body's fake player after the
 * id, so at most 16 characters of `[a-z0-9_]`, starting with a letter. Node mints ids inside it.
 */
export const MOD_AGENT_ID = /^[a-z][a-z0-9_]{0,15}$/;

export const CREW_CAP = 4;
export const MAX_SEATED = 2;

/** BrainScheduler lanes (PLAN §6.5). */
export const WORK_LANE_SLOTS = 2;
export const INTERACTIVE_LANE_SLOTS = 1;

/** Per-turn caps (PLAN §6.5); card-wait time is excluded. */
export const TURN_CAPS = Object.freeze({
  wandering: { calls: 40, ms: 5 * 60_000 },
  seated: { calls: 400, ms: 45 * 60_000 },
});

/** An agent away from its seat loses the reservation after this long (PLAN §6.4). */
export const AWAY_RESERVATION_MS = 3 * 60_000;
/**
 * A desk session idle longer than this (since its last turn) is not resumed: the next sit at that PC starts a fresh
 * one (PLAN §6.1, dual sessions). Desk sessions also end with the world: their records live in the world's crew file.
 */
export const DESK_SESSION_TTL_MS = 6 * 60 * 60_000;
/** How many of the player's latest lines to the agent the desk handoff quotes verbatim. */
export const HANDOFF_PLAYER_LINES = 6;
/** A desk turn that keeps calling tools after its seat ended is interrupted after this many refused calls. */
export const DESK_CLOSED_STRIKES = 2;

/** UsageGovernor thresholds (PLAN §6.5). */
export const TIRED_UTILIZATION = 0.75;
/** Asleep agents wake this long after `resetsAt`. */
export const ASLEEP_GRACE_MS = 60_000;

/** BrainSupervisor: at most this many restarts per window, then "brain offline". */
export const SUPERVISOR_MAX_RESTARTS = 5;
export const SUPERVISOR_WINDOW_MS = 10 * 60_000;
export const SUPERVISOR_BACKOFF_MS = Object.freeze({ base: 1_000, max: 60_000 });

/** Long jobs: the `wait_s` default (PLAN §6.5). */
export const DEFAULT_WAIT_S = 20;
export const MAX_WAIT_S = 120;

/**
 * v2 `mc` tools (docs/design/tools-v2-mc.md §7): every world tool answers within this many seconds (`running` with
 * the job's progress when it is still going); there is no `wait_s` argument. `sit_at_pc` waits {@link SIT_WAIT_S}.
 */
export const ACTION_WAIT_S = 20;
export const SIT_WAIT_S = 60;
/** `job{wait}` without `seconds`. */
export const JOB_WAIT_DEFAULT_S = 30;

/** Which `mc` tool set agents get: `MINEVIBE_MC_TOOLS=v1|v2` (contracts/mcRefs.ts). */
export { DEFAULT_MC_TOOLS, type McToolsVersion, mcToolsVersion } from '../contracts/mcRefs.js';

/** `memory.md` cap (PLAN §6.5). */
export const MEMORY_MAX_BYTES = 8 * 1024;
/** Chronicle cap (≈1.5k tokens). */
export const CHRONICLE_MAX_CHARS = 6_000;

/** Last words: one CEO turn, hard-capped (PLAN §7.9). */
export const LAST_WORDS_MS = 8_000;

/** A meeting turn (CrewHooks.meetingTurn) is interrupted after this long, queue wait included. */
export const MEETING_TURN_TIMEOUT_MS = 90_000;

/** Autonomous wake budgets per agent per hour (full design §5.8). */
export const AUTONOMY_BUDGET_PER_HOUR = Object.freeze({ listen: 0, helpful: 20, proactive: 40 });
/** Minimum spacing between autonomous wakes of one agent. */
export const AUTONOMY_MIN_GAP_MS = 30_000;
/** Helpful: one idle nudge after this much silence. Proactive: heartbeat period. */
export const IDLE_NUDGE_MS = 2 * 60_000;
export const HEARTBEAT_MS = 3 * 60_000;

/** Bubble text: the first 1-2 sentences of the assistant text, at most this long. */
export const BUBBLE_MAX_CHARS = 240;
