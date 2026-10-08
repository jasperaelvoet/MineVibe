/**
 * ToolGate (PLAN §6.2): the authoritative, fail-closed PreToolUse hook.
 *
 * - The hook sees the alias target (`mcp__pc__bash`, never `Bash`; S2) plus `mcp_server.source`. Only in-process SDK
 *   servers (`source: 'sdk'`) named `mc` / `pc` are trusted.
 * - It returns an explicit `allow` or `deny` for every mc/pc/web tool. Broker tools (AskUserQuestion, and ExitPlanMode
 *   in plan mode) get **no decision**, so canUseTool (the InteractionBroker) runs; anything that is not recognised is
 *   denied. There is no `allowedTools` for mc/pc (S2).
 * - USER DECISION 2026-10-08: sessions run in `bypassPermissions`, where a call the hook leaves undecided is
 *   auto-allowed without canUseTool (verified live) — except the interaction tools AskUserQuestion and ExitPlanMode,
 *   which still reach canUseTool. So this gate is the only sandbox guard: "no decision" is returned for those two
 *   broker tools and nothing else, and every error is a deny.
 * - USER DECISION 2026-10-08: EnterPlanMode is always denied (agents never put themselves into plan mode), and
 *   ExitPlanMode is denied outside plan mode (only the player's Plan-first toggle starts one).
 * - Plan mode uses `input.permission_mode ?? nodeTrackedMode`.
 * - Any exception while deciding is a deny.
 */

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { TURN_CAPS } from './constants.js';
import type { PlanCapture } from './PlanCapture.js';
import type { SeatSnapshot } from './SeatFSM.js';
import type { HookCallback, HookJSONOutput, PermissionMode, PreToolUseHookInput } from './sdk.js';
import {
  MC_TOOLS,
  type McToolName,
  mcToolName,
  PC_PLAN_DENIED_GUI,
  PC_PLAN_FILE_MUTATORS,
  type PcToolName,
  pcToolName,
} from './tools/catalog.js';

export type GateDecision =
  | { readonly behavior: 'allow'; readonly reason: string; readonly context?: string | undefined }
  | { readonly behavior: 'deny'; readonly reason: string; readonly code: GateDenyCode }
  /** No decision: canUseTool (the broker) decides. */
  | { readonly behavior: 'defer'; readonly reason: string };

export type GateDenyCode =
  | 'unknown_tool'
  | 'untrusted_server'
  | 'not_seated'
  | 'seated'
  | 'pending_swap'
  | 'walking'
  | 'away'
  | 'meeting'
  | 'not_occupant'
  | 'plan_mode'
  /** EnterPlanMode, or ExitPlanMode outside plan mode (USER DECISION 2026-10-08). */
  | 'no_plan_mode'
  | 'ceo_only'
  | 'self_only'
  | 'web_wandering'
  | 'web_private'
  | 'turn_cap'
  | 'halted'
  | 'error';

/** What the gate knows about the agent when a call arrives. */
export interface GateContext {
  readonly agentId: string;
  readonly ceo: boolean;
  readonly seat: SeatSnapshot;
  /** Who sits at `pcId` per the mod's PcRegistry (`pc.seat` / `pc.unseat`): an agent id, `player`, or null. */
  occupant(pcId: string): string | null;
  /** Node's own view of the permission mode (its `setPermissionMode` calls and the brokered plan tools). */
  readonly trackedMode: PermissionMode;
  readonly plans: PlanCapture;
  /** Tool calls and active (non card-wait) time of the current turn, this call excluded. */
  readonly turn: { readonly calls: number; readonly activeMs: number };
  readonly playerName: string;
  /** Why this brain must not act at all (failed startup assertions), or null. Every tool is denied. */
  readonly halted?: string | null | undefined;
}

export interface WebTargetCheck {
  /** Resolves a host name to addresses (default: `dns.lookup`, all addresses). */
  resolve?: (host: string) => Promise<readonly string[]>;
}

const NO_PC = (player: string) =>
  `Computer tools work only while seated: walk to a PC and call mcp__mc__sit_at_pc. (${player} can't see host files either.)`;

function deny(code: GateDenyCode, reason: string): GateDecision {
  return { behavior: 'deny', code, reason };
}

function allow(reason: string, context?: string): GateDecision {
  return context === undefined ? { behavior: 'allow', reason } : { behavior: 'allow', reason, context };
}

function isPcSeat(seat: SeatSnapshot): boolean {
  return seat.kind === 'pc';
}

function pendingSwapText(seat: SeatSnapshot): string {
  return `Seated at ${seat.pcId ?? 'the PC'}. End your turn now; your PC session starts with your next turn.`;
}

/** Per-turn caps by seat (card-wait time is excluded by the caller). */
export function turnCapFor(seat: SeatSnapshot): { calls: number; ms: number } {
  return isPcSeat(seat) && (seat.state === 'seated' || seat.state === 'away_from_seat')
    ? TURN_CAPS.seated
    : TURN_CAPS.wandering;
}

function capDecision(ctx: GateContext): GateDecision | null {
  const cap = turnCapFor(ctx.seat);
  if (ctx.turn.calls >= cap.calls || ctx.turn.activeMs >= cap.ms) {
    return deny(
      'turn_cap',
      `Turn limit reached (${cap.calls} tool calls / ${Math.round(cap.ms / 60_000)} min). Stop here: say in 1-2 sentences where you are, then end your turn.`,
    );
  }
  return null;
}

function assigneesOf(input: Record<string, unknown>): unknown {
  return input.assignees;
}

function decideMc(tool: McToolName, input: Record<string, unknown>, ctx: GateContext): GateDecision {
  const seat = ctx.seat;
  const category = MC_TOOLS[tool];
  if (seat.state === 'seated_pending_swap') return deny('pending_swap', pendingSwapText(seat));

  switch (category) {
    case 'always':
    case 'codex_read':
    case 'codex_write':
      return allow(`mc ${category}`);
    case 'hire':
      return ctx.ceo
        ? allow('ceo hire')
        : deny('ceo_only', 'Only the CEO can hire. Ask the CEO with mcp__mc__tell.');
    case 'stand':
      return seat.state === 'wandering' || seat.state === 'standing_pending_swap'
        ? deny('not_seated', 'You are not seated.')
        : allow('stand');
    case 'calendar': {
      if (ctx.ceo || (tool !== 'calendar_add' && tool !== 'calendar_update')) return allow('calendar');
      const assignees = assigneesOf(input);
      if (assignees === undefined && tool === 'calendar_update') return allow('calendar self');
      const selfOnly = Array.isArray(assignees) && assignees.length === 1 && assignees[0] === ctx.agentId;
      return selfOnly
        ? allow('calendar self')
        : deny(
            'self_only',
            `You can only schedule for yourself (assignees: ["${ctx.agentId}"]). Ask the CEO to schedule others.`,
          );
    }
    case 'sit':
    case 'world': {
      switch (seat.state) {
        case 'wandering':
        case 'standing_pending_swap':
          return allow(`mc ${category}`);
        case 'walking_to_seat':
          return deny(
            'walking',
            'You are walking to a chair. Wait for it (end your turn), or call mcp__mc__stand_up to cancel.',
          );
        case 'away_from_seat':
          return deny('away', `You are away from your seat to ask ${ctx.playerName}; wait for the answer.`);
        default:
          return seat.kind === 'meeting'
            ? deny('meeting', 'You are in a meeting; wait for it to end.')
            : deny('seated', 'You are seated at a PC: stand up first (mcp__mc__stand_up).');
      }
    }
  }
}

function decidePc(tool: PcToolName, input: Record<string, unknown>, ctx: GateContext): GateDecision {
  const seat = ctx.seat;
  switch (seat.state) {
    case 'wandering':
    case 'standing_pending_swap':
      return deny('not_seated', NO_PC(ctx.playerName));
    case 'walking_to_seat':
      return deny('walking', 'You are still walking to the chair; end your turn and wait to be seated.');
    case 'seated_pending_swap':
      return deny('pending_swap', pendingSwapText(seat));
    case 'away_from_seat':
      return deny(
        'away',
        `You are away from your seat asking ${ctx.playerName}; PC tools resume when you sit back down.`,
      );
    case 'seated':
      break;
  }
  if (!isPcSeat(seat) || seat.pcId === null)
    return deny('meeting', 'You are in a meeting chair, not at a PC.');
  const occupant = ctx.occupant(seat.pcId);
  if (occupant !== ctx.agentId) {
    return deny('not_occupant', `${seat.pcId} is not yours right now; stand up (mcp__mc__stand_up).`);
  }

  const planMode = ctx.trackedMode === 'plan';
  if (planMode) {
    if (PC_PLAN_FILE_MUTATORS.has(tool)) {
      if (ctx.plans.isPlanPath(input.file_path)) return allow('plan file (captured)');
      return deny(
        'plan_mode',
        `Plan mode: read-only until ${ctx.playerName} approves. Write your plan to ~/.claude/plans/<name>.md, then call ExitPlanMode.`,
      );
    }
    if (PC_PLAN_DENIED_GUI.has(tool)) {
      return deny('plan_mode', `Plan mode: read-only until ${ctx.playerName} approves your plan.`);
    }
    if (tool === 'clipboard' && (input.action === 'set' || typeof input.text === 'string')) {
      return deny('plan_mode', `Plan mode: read-only until ${ctx.playerName} approves your plan.`);
    }
    if (tool === 'bash') {
      return allow('plan bash', 'Plan mode: read-only commands only (e.g. git status, ls, running tests).');
    }
  }
  return allow('pc seated');
}

const PRIVATE_V4: readonly [number, number][] = [
  [0x00000000, 8], // 0.0.0.0/8
  [0x0a000000, 8], // 10/8
  [0x64400000, 10], // 100.64/10 (CGNAT)
  [0x7f000000, 8], // 127/8
  [0xa9fe0000, 16], // 169.254/16
  [0xac100000, 12], // 172.16/12
  [0xc0000000, 24], // 192.0.0/24
  [0xc0a80000, 16], // 192.168/16
  [0xc6120000, 15], // 198.18/15 (benchmarking)
  [0xe0000000, 4], // multicast
  [0xf0000000, 4], // reserved + broadcast
];

function v4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const v = Number(p);
    if (v > 255) return null;
    n = n * 256 + v;
  }
  return n;
}

/** Loopback, RFC 1918, link-local, CGNAT, unspecified, multicast and the IPv6 equivalents. */
export function isPrivateAddress(address: string): boolean {
  const kind = isIP(address);
  if (kind === 4) {
    const n = v4ToInt(address);
    if (n === null) return true;
    return PRIVATE_V4.some(([base, bits]) => {
      const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
      return (n & mask) >>> 0 === base;
    });
  }
  if (kind === 6) {
    const a = address.toLowerCase().replace(/^\[|\]$/g, '');
    if (a === '::' || a === '::1') return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a);
    if (mapped?.[1]) return isPrivateAddress(mapped[1]);
    if (/^::ffff:[0-9a-f]{1,4}:[0-9a-f]{1,4}$/.test(a)) return true; // hex-mapped v4: refuse
    const first = Number.parseInt(a.split(':')[0] || '0', 16);
    if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
    if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
    if ((first & 0xff00) === 0xff00) return true; // multicast
    if (a.startsWith('64:ff9b:')) return true; // NAT64 can reach v4 private space
    return false;
  }
  return true;
}

const PRIVATE_HOST_RE = /(^|\.)(localhost|local|internal|home\.arpa|lan|intranet)$/i;

/**
 * Whether a WebFetch URL may be fetched: http(s) only, and no loopback, RFC 1918 or link-local target, by literal IP or
 * by any address the host name resolves to. Fails closed (unresolvable hosts are refused).
 */
export async function checkWebTarget(
  url: unknown,
  options: WebTargetCheck = {},
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (typeof url !== 'string') return { ok: false, reason: 'WebFetch needs a url' };
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: 'not a valid URL' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, reason: 'only http and https URLs can be fetched' };
  }
  if (parsed.username !== '' || parsed.password !== '')
    return { ok: false, reason: 'URLs with credentials are refused' };
  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  if (host.length === 0) return { ok: false, reason: 'no host' };
  if (isIP(host) !== 0) {
    return isPrivateAddress(host)
      ? { ok: false, reason: `${host} is a private or loopback address` }
      : { ok: true };
  }
  if (PRIVATE_HOST_RE.test(host) || !host.includes('.')) {
    return { ok: false, reason: `${host} is a local host name` };
  }
  const resolve =
    options.resolve ??
    (async (h: string) => (await lookup(h, { all: true, verbatim: true })).map((r) => r.address));
  let addresses: readonly string[];
  try {
    addresses = await resolve(host);
  } catch {
    return { ok: false, reason: `could not resolve ${host}` };
  }
  if (addresses.length === 0) return { ok: false, reason: `could not resolve ${host}` };
  const bad = addresses.find(isPrivateAddress);
  return bad ? { ok: false, reason: `${host} resolves to the private address ${bad}` } : { ok: true };
}

/**
 * The gate's decision for one call. `input.permission_mode` (when the CLI sends it) wins over Node's tracked mode.
 */
export async function decideTool(
  toolName: string,
  toolInput: unknown,
  ctx: GateContext,
  extra: {
    permissionMode?: string | undefined;
    serverSource?: string | undefined;
    web?: WebTargetCheck;
  } = {},
): Promise<GateDecision> {
  const input = (toolInput && typeof toolInput === 'object' ? toolInput : {}) as Record<string, unknown>;
  const mode = (extra.permissionMode as PermissionMode | undefined) ?? ctx.trackedMode;
  const c: GateContext =
    mode === ctx.trackedMode ? ctx : { ...ctx, trackedMode: mode, occupant: ctx.occupant };
  if (ctx.halted) return deny('halted', `MineVibe stopped this brain: ${ctx.halted}. End your turn now.`);

  switch (toolName) {
    case 'AskUserQuestion':
      return { behavior: 'defer', reason: 'broker' };
    case 'ExitPlanMode':
      // USER DECISION 2026-10-08: only plan-first sessions (the player's toggle) are in plan mode.
      return mode === 'plan'
        ? { behavior: 'defer', reason: 'broker' }
        : deny('no_plan_mode', 'You are not in plan mode: there is no plan to approve. Just do the work.');
    case 'EnterPlanMode':
      // USER DECISION 2026-10-08: agents never put themselves into plan mode (not in the tool list either).
      return deny(
        'no_plan_mode',
        `Plan mode is not available to you. ${ctx.playerName} turns on Plan-first for you when they want a plan first; otherwise just do the work.`,
      );
    case 'WebSearch':
    case 'WebFetch': {
      if (!(ctx.seat.state === 'seated' && isPcSeat(ctx.seat))) {
        return deny(
          'web_wandering',
          'No internet away from a PC: walk to a PC and sit down to search the web.',
        );
      }
      const cap = capDecision(c);
      if (cap) return cap;
      if (toolName === 'WebFetch') {
        const check = await checkWebTarget(input.url, extra.web);
        if (!check.ok) return deny('web_private', `WebFetch refused: ${check.reason}.`);
      }
      return allow('web seated');
    }
  }

  const mc = mcToolName(toolName);
  const pc = mc === null ? pcToolName(toolName) : null;
  if (mc === null && pc === null) {
    return deny(
      'unknown_tool',
      `${toolName} is not available here. Use the mcp__mc__* and mcp__pc__* tools.`,
    );
  }
  if (extra.serverSource !== undefined && extra.serverSource !== 'sdk') {
    return deny('untrusted_server', `${toolName} comes from an untrusted server.`);
  }
  const cap = capDecision(c);
  if (cap) return cap;
  return mc !== null ? decideMc(mc, input, c) : decidePc(pc as PcToolName, input, c);
}

/** What the gate hook reports for every decision (activity, caps, effort). */
export interface GateObservation {
  readonly toolName: string;
  readonly toolUseId: string;
  readonly input: unknown;
  readonly decision: GateDecision;
  /** `input.effort.level`: the CLI's applied effort (S2: init has none). */
  readonly effort: string | null;
  readonly permissionMode: string | null;
}

/**
 * The PreToolUse hook. `context()` is read per call; `observe` sees every decision (the session counts calls, records
 * the applied effort and remembers the seat epoch of allowed `pc` calls).
 */
export function createToolGateHook(
  context: () => GateContext,
  observe: (o: GateObservation) => void = () => {},
  web: WebTargetCheck = {},
): HookCallback {
  return async (hookInput): Promise<HookJSONOutput> => {
    const input = hookInput as PreToolUseHookInput;
    let decision: GateDecision;
    try {
      if (input.hook_event_name !== 'PreToolUse') return {};
      decision = await decideTool(input.tool_name, input.tool_input, context(), {
        permissionMode: input.permission_mode,
        serverSource: input.mcp_server?.source,
        web,
      });
    } catch (err) {
      decision = deny('error', `Tool gate error: ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
      observe({
        toolName: input.tool_name,
        toolUseId: input.tool_use_id,
        input: input.tool_input,
        decision,
        effort: input.effort?.level ?? null,
        permissionMode: input.permission_mode ?? null,
      });
    } catch {
      // observation failures never change the decision
    }
    if (decision.behavior === 'defer') return {};
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: decision.behavior,
        permissionDecisionReason: decision.reason,
        ...(decision.behavior === 'allow' && decision.context ? { additionalContext: decision.context } : {}),
      },
    };
  };
}
