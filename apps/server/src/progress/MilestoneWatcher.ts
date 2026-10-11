/**
 * The guide's technical milestones (PLAN §7.5 "Guide"): Node sees the crew's computer work (PCs booting, desk sessions,
 * commands, commits, pull requests, tests, files, the web, the Codex, meetings, usage) and counts each one towards the
 * player's advancements with a `progress.milestone` to the mod. The mod keeps the totals (per world, as statistics) and
 * decides what they earn; this only says what happened. Names must match the mod's `Milestone` ids.
 */
import type { SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import type { PayloadOf } from '@minevibe/protocol';
import type { DeskWork } from '../agents/AgentBrain.js';
import type { SessionKind } from '../agents/constants.js';
import type { UsageState } from '../agents/UsageGovernor.js';

export type MilestoneName =
  | 'pc_booted'
  | 'mac_booted'
  | 'desk_session'
  | 'desk_resumed'
  | 'command_run'
  | 'command_failed'
  | 'package_installed'
  | 'tests_passed'
  | 'git_commit'
  | 'git_push'
  | 'pr_opened'
  | 'file_written'
  | 'web_used'
  | 'app_opened'
  | 'agent_codex'
  | 'meeting_minutes'
  | 'calendar_fired'
  | 'tokens'
  | 'brains_tired'
  | 'brains_asleep';

/** One shell command, without what follows `|`, `;`, `&&` or `||` (so `git log; echo commit` is not a commit). */
const SEGMENT = String.raw`[^|;&\n]*`;
const COMMANDS: ReadonlyArray<readonly [MilestoneName, RegExp]> = [
  ['git_commit', new RegExp(String.raw`\bgit\b${SEGMENT}\bcommit\b`)],
  ['git_push', new RegExp(String.raw`\bgit\b${SEGMENT}\bpush\b`)],
  ['pr_opened', /\bgh\s+pr\s+create\b/],
  [
    'tests_passed',
    new RegExp(
      String.raw`\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b|\b(?:pytest|vitest|jest|ctest)\b|\b(?:cargo|go|swift|dotnet|mix|deno)\s+test\b|\bmake\s+(?:test|check)\b|\b(?:gradlew?|mvn)\b${SEGMENT}\b(?:test|check)\b|\bpython3?\s+-m\s+(?:pytest|unittest)\b`,
    ),
  ],
  [
    'package_installed',
    /\b(?:apt(?:-get)?|brew|dnf|yum|pacman|apk|gem|pipx)\s+(?:install|add|-S)\b|\b(?:npm|pnpm|yarn|bun)\s+(?:install|i|add)\b|\bpip3?\s+install\b|\b(?:cargo|go)\s+(?:install|add|get)\b|\buv\s+(?:add|pip\s+install)\b/,
  ],
];

/** What a finished foreground command counts towards: always `command_run`, then a failure or what it achieved. */
export function commandMilestones(command: string, exitCode: number): MilestoneName[] {
  const out: MilestoneName[] = ['command_run'];
  if (exitCode !== 0) {
    out.push('command_failed');
    return out;
  }
  for (const [name, pattern] of COMMANDS) {
    if (pattern.test(command)) out.push(name);
  }
  return out;
}

/** The tools that count as using the web, or as opening something on the PC (a browser, an app, a file). */
const WEB_TOOLS = new Set(['WebSearch', 'WebFetch']);
const OPEN_TOOL = 'mcp__pc__open';

interface On<E extends Record<string, unknown[]>> {
  on<K extends keyof E>(event: K, listener: (...args: E[K]) => void): () => void;
}

export interface MilestoneSources {
  readonly crew?: On<{
    work: [payload: DeskWork & { readonly agentId: string }];
    tool: [payload: { readonly toolName: string; readonly behavior: 'allow' | 'deny' | 'defer' }];
    turn: [
      payload: { readonly agentId: string; readonly result: SDKResultMessage; readonly session: SessionKind },
    ];
  }>;
  readonly usage?: On<{ change: [state: UsageState] }>;
  readonly org?: On<{
    codexWritten: [
      payload: { readonly created: boolean; readonly authorKind: 'agent' | 'player' | 'system' },
    ];
    calendarFired: [payload: PayloadOf<'calendar.fired'>];
    meetingState: [payload: PayloadOf<'meeting.state'>];
  }>;
  readonly pcs?: {
    onPcBooted?(
      listener: (pc: { readonly pcId: string; readonly family: 'linux' | 'macos' | 'windows' }) => void,
    ): () => void;
  };
}

/** Attendees who were really at the meeting (at the table or dialed in from a PC). */
const PRESENT = new Set(['seated', 'dialed_in']);

export class MilestoneWatcher {
  readonly #send: (milestone: MilestoneName, amount?: number) => void;
  readonly #offs: Array<() => void> = [];
  /** Cumulative tokens per `agentId:session`, as each turn's result reports them (the deltas are sent). */
  readonly #tokens = new Map<string, number>();
  readonly #fired = new Set<string>();
  readonly #meetings = new Set<string>();
  #usage: UsageState['mode'] = 'normal';

  constructor(send: (milestone: MilestoneName, amount?: number) => void) {
    this.#send = send;
  }

  watch(sources: MilestoneSources): this {
    const { crew, usage, org, pcs } = sources;
    if (crew) {
      this.#offs.push(
        crew.on('work', (w) => this.#onWork(w)),
        crew.on('tool', (t) => {
          if (t.behavior !== 'allow') return;
          if (WEB_TOOLS.has(t.toolName)) this.#send('web_used');
          else if (t.toolName === OPEN_TOOL) this.#send('app_opened');
        }),
        crew.on('turn', (t) => this.#onTurn(t.agentId, t.session, t.result)),
      );
    }
    if (usage) {
      this.#offs.push(
        usage.on('change', (state) => {
          if (state.mode !== this.#usage) {
            if (state.mode === 'tired') this.#send('brains_tired');
            if (state.mode === 'asleep') this.#send('brains_asleep');
          }
          this.#usage = state.mode;
        }),
      );
    }
    if (org) {
      this.#offs.push(
        org.on('codexWritten', (c) => {
          if (c.created && c.authorKind === 'agent') this.#send('agent_codex');
        }),
        org.on('calendarFired', (f) => {
          // Fired again (same occurrence) as assignees accept: one count per occurrence.
          const key = `${f.eventId}:${f.occurrence}`;
          if (this.#fired.has(key)) return;
          this.#fired.add(key);
          this.#send('calendar_fired');
        }),
        org.on('meetingState', (m) => {
          if (m.phase !== 'done' || this.#meetings.has(m.meetingId)) return;
          if (!m.attendees.some((a) => PRESENT.has(a.status))) return;
          this.#meetings.add(m.meetingId);
          this.#send('meeting_minutes');
        }),
      );
    }
    const booted = pcs?.onPcBooted?.((pc) => {
      this.#send('pc_booted');
      if (pc.family === 'macos') this.#send('mac_booted');
    });
    if (booted) this.#offs.push(booted);
    return this;
  }

  stop(): void {
    for (const off of this.#offs.splice(0)) off();
  }

  #onWork(w: DeskWork): void {
    switch (w.kind) {
      case 'desk':
        this.#send(w.resumed ? 'desk_resumed' : 'desk_session');
        break;
      case 'command':
        for (const m of commandMilestones(w.command, w.exitCode)) this.#send(m);
        break;
      case 'file':
        this.#send('file_written');
        break;
    }
  }

  #onTurn(agentId: string, session: SessionKind, result: SDKResultMessage): void {
    const total = Object.values(result.modelUsage ?? {}).reduce(
      (sum, u) => sum + (u.inputTokens ?? 0) + (u.outputTokens ?? 0),
      0,
    );
    const key = `${agentId}:${session}`;
    const before = this.#tokens.get(key) ?? 0;
    this.#tokens.set(key, total);
    // A fresh session starts again from zero: its whole total is new.
    const delta = total >= before ? total - before : total;
    if (delta > 0) this.#send('tokens', Math.min(delta, 1_000_000_000));
  }
}
