/**
 * Agent runtime constants (PLAN §6). Every number the brain runtime uses lives here so tests and docs can
 * refer to one place.
 */

import type { EffortLevel } from '@anthropic-ai/claude-agent-sdk';
import type { ModelTier } from '@minevibe/protocol';

export const HAIKU = 'claude-haiku-5-5';
export const OPUS = 'claude-opus-5-5';

/** A model/effort pair the session runs with. */
export interface BrainProfile {
  readonly tier: ModelTier;
  readonly model: string;
  readonly effort: EffortLevel;
}

/** Wandering: Haiku 5.5 at xhigh (PLAN §1). */
export const WANDERING_PROFILE: BrainProfile = Object.freeze({
  tier: 'haiku',
  model: HAIKU,
  effort: 'xhigh',
});
/** Seated at a PC: Opus 5.5 at medium. */
export const SEATED_PROFILE: BrainProfile = Object.freeze({ tier: 'opus', model: OPUS, effort: 'medium' });

export function profileOf(tier: ModelTier): BrainProfile {
  return tier === 'opus' ? SEATED_PROFILE : WANDERING_PROFILE;
}

/** `options.tools`: TodoWrite is silently dropped by CC 2.1.293 (S2), so it is not listed. */
export const BUILTIN_TOOLS = [
  'AskUserQuestion',
  'EnterPlanMode',
  'ExitPlanMode',
  'WebSearch',
  'WebFetch',
] as const;

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

/** Built-in names routed to the PC tool server (S2: the hook sees the alias target). */
export const TOOL_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  Bash: 'mcp__pc__bash',
  Read: 'mcp__pc__read',
  Edit: 'mcp__pc__edit',
  Write: 'mcp__pc__write',
  Glob: 'mcp__pc__glob',
  Grep: 'mcp__pc__grep',
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

/** A stand and re-sit on the same PC within this window skips the swap (PLAN §6.3). */
export const SWAP_DEBOUNCE_MS = 60_000;
/** An agent away from its seat loses the reservation after this long (PLAN §6.4). */
export const AWAY_RESERVATION_MS = 3 * 60_000;
/** Compact before an Opus→Haiku swap above this share of Haiku's window (PLAN §6.3). */
export const CONTEXT_GUARD_RATIO = 0.7;
/** Haiku 5.5 context window used by the context guard. */
export const HAIKU_CONTEXT_TOKENS = 200_000;
/** The context guard's `/compact` never holds the seat mutex longer than this. */
export const CONTEXT_GUARD_TIMEOUT_MS = 180_000;
/** How long to wait for the PostModelSwitch acknowledgement after `applyFlagSettings`. */
export const SWAP_ACK_TIMEOUT_MS = 5_000;

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

/** `memory.md` cap (PLAN §6.5). */
export const MEMORY_MAX_BYTES = 8 * 1024;
/** Chronicle cap (≈1.5k tokens). */
export const CHRONICLE_MAX_CHARS = 6_000;

/** Last words: one CEO turn, hard-capped (PLAN §7.9). */
export const LAST_WORDS_MS = 8_000;

/** A meeting turn (CrewHooks.meetingTurn) is interrupted after this long, queue wait included. */
export const MEETING_TURN_TIMEOUT_MS = 90_000;
/**
 * The re-sit debounce of an agent pulled from its PC into a meeting: the longest meeting (10 min) plus 2 min, so the
 * walk back to the reserved PC costs no model swap (PLAN §6.6).
 */
export const MEETING_SWAP_DEBOUNCE_MS = 12 * 60_000;

/** Autonomous wake budgets per agent per hour (full design §5.8). */
export const AUTONOMY_BUDGET_PER_HOUR = Object.freeze({ listen: 0, helpful: 20, proactive: 40 });
/** Minimum spacing between autonomous wakes of one agent. */
export const AUTONOMY_MIN_GAP_MS = 30_000;
/** Helpful: one idle nudge after this much silence. Proactive: heartbeat period. */
export const IDLE_NUDGE_MS = 2 * 60_000;
export const HEARTBEAT_MS = 3 * 60_000;

/** Bubble text: the first 1-2 sentences of the assistant text, at most this long. */
export const BUBBLE_MAX_CHARS = 240;
