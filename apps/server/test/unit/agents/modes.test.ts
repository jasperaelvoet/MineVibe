/**
 * Mode profiles (agents/modes.ts, PLAN §6.2 "Tools per mode"): membership from the catalog tags, the conservative
 * defaults, the seat → mode mapping, the MODE banner, and ToolGate holding every call to the seat's mode.
 */

import { describe, expect, it } from 'vitest';
import {
  BUILTIN_TOOLS,
  SEATED_PROFILE,
  TOOL_ALIASES,
  WANDERING_PROFILE,
} from '../../../src/agents/constants.js';
import {
  BRAIN_MODES,
  type BrainMode,
  MC_TOOL_SETS,
  MODE_PROFILES,
  mcToolsIn,
  modeForSeat,
  modeProfile,
  profileToolNames,
  toolInMode,
} from '../../../src/agents/modes.js';
import { PlanCapture } from '../../../src/agents/PlanCapture.js';
import { modeBanner, modeSection, outsideModeText } from '../../../src/agents/prompts/modes.js';
import { personaPrompt } from '../../../src/agents/prompts/persona.js';
import { SeatFSM, type SeatSnapshot } from '../../../src/agents/SeatFSM.js';
import { decideTool, type GateContext } from '../../../src/agents/ToolGate.js';
import {
  MC_TOOL_MODES,
  MC_TOOLS_V1,
  MC_TOOLS_V2,
  type McToolName,
  mcToolModes,
  PC_TOOLS,
  pcToolModes,
} from '../../../src/agents/tools/catalog.js';

const ALL_MC = Object.keys(MC_TOOLS_V1) as McToolName[];
const ALL_MC_V2 = Object.keys(MC_TOOLS_V2) as McToolName[];

/** The minimal mc set of PC mode (the idea's SEATED profile). */
const SEATED_MC = [
  'status',
  'look_around',
  'stand_up',
  'say',
  'tell',
  'remember',
  'codex_search',
  'codex_read',
  'codex_write',
  'codex_list',
  'calendar_list',
  'calendar_add',
  'calendar_update',
  'calendar_cancel',
  'report_task',
];
/** The same for the v2 tool set (tools-v2-mc.md): observe, and the codex / calendar action tools. */
const SEATED_MC_V2 = ['observe', 'say', 'tell', 'remember', 'stand_up', 'codex', 'calendar'];
const MEETING_MC_V2 = ['say', 'tell', 'remember', 'stand_up', 'codex', 'calendar'];
/** Meeting mode: social + Codex/calendar + stand_up. */
const MEETING_MC = [
  'stand_up',
  'say',
  'tell',
  'emote',
  'remember',
  'codex_search',
  'codex_read',
  'codex_write',
  'codex_list',
  'calendar_list',
  'calendar_add',
  'calendar_update',
  'calendar_cancel',
  'report_task',
];

describe('ModeProfile registry (tool metadata)', () => {
  it('wander: every mc tool, no pc tools, no aliases, no web; Haiku/xhigh', () => {
    const p = modeProfile('wander');
    expect(p).toBe(MODE_PROFILES.v1.wander);
    expect([...p.mc].sort()).toEqual([...ALL_MC].sort());
    expect([...modeProfile('wander', 'v2').mc].sort()).toEqual([...ALL_MC_V2].sort());
    expect(p.pc).toEqual([]);
    expect(p.aliases).toEqual([]);
    expect(p.builtins).toEqual(['AskUserQuestion']);
    expect(p.brain).toBe(WANDERING_PROFILE);
    expect(p.title).toBe('Minecraft mode');
  });

  it('seated: every pc tool, the Bash…Grep aliases, web, and only the minimal mc set; Opus/medium', () => {
    const p = modeProfile('seated');
    expect([...p.pc].sort()).toEqual([...PC_TOOLS].sort());
    expect([...p.aliases].sort()).toEqual(Object.keys(TOOL_ALIASES).sort());
    expect([...p.builtins].sort()).toEqual(['AskUserQuestion', 'ExitPlanMode', 'WebFetch', 'WebSearch']);
    expect([...p.mc].sort()).toEqual([...SEATED_MC].sort());
    for (const hidden of ['goto', 'mine', 'craft', 'build', 'sit_at_pc', 'inventory', 'request_hire'])
      expect(p.mc, hidden).not.toContain(hidden);
    expect(p.brain).toBe(SEATED_PROFILE);
    const v2 = modeProfile('seated', 'v2');
    expect([...v2.mc].sort()).toEqual([...SEATED_MC_V2].sort());
    expect(v2.pc).toEqual(p.pc);
    // Whole tools are tagged, never actions: items{eat} and craft{plan} stay in Minecraft mode.
    for (const hidden of ['goto', 'gather', 'craft', 'build', 'use', 'items', 'menu', 'do', 'job', 'find'])
      expect(v2.mc, hidden).not.toContain(hidden);
  });

  it('meeting: social, Codex, calendar and stand_up only', () => {
    const p = modeProfile('meeting');
    expect([...p.mc].sort()).toEqual([...MEETING_MC].sort());
    expect([...modeProfile('meeting', 'v2').mc].sort()).toEqual([...MEETING_MC_V2].sort());
    expect(p.pc).toEqual([]);
    expect(p.aliases).toEqual([]);
    expect(p.builtins).toEqual(['AskUserQuestion']);
  });

  it('defaults conservatively: an untagged mc tool is wander-only, an untagged pc tool seated-only', () => {
    for (const t of new Set([...ALL_MC, ...ALL_MC_V2])) {
      if (!Object.hasOwn(MC_TOOL_MODES, t)) expect(mcToolModes(t), t).toEqual(['wander']);
      // Every tag names known modes, and every mc tool is reachable in Minecraft mode.
      for (const m of mcToolModes(t)) expect(BRAIN_MODES).toContain(m);
      expect(mcToolModes(t), t).toContain('wander');
    }
    for (const t of PC_TOOLS) expect(pcToolModes(t), t).toEqual(['seated']);
    // Every tag names a tool of some set (no stale names after a rename).
    for (const t of Object.keys(MC_TOOL_MODES))
      expect(
        MC_TOOL_SETS.some((v) => (mcToolsIn(v) as string[]).includes(t)),
        t,
      ).toBe(true);
  });

  it('toolInMode: mcp names by tag, aliases by their pc target, built-ins by table; unknown tools nowhere', () => {
    expect(toolInMode('wander', 'mcp__mc__goto')).toBe(true);
    expect(toolInMode('seated', 'mcp__mc__goto')).toBe(false);
    expect(toolInMode('seated', 'mcp__mc__status')).toBe(true);
    expect(toolInMode('meeting', 'mcp__mc__status')).toBe(false);
    expect(toolInMode('seated', 'mcp__pc__bash')).toBe(true);
    expect(toolInMode('wander', 'mcp__pc__bash')).toBe(false);
    expect(toolInMode('seated', 'Bash')).toBe(true);
    expect(toolInMode('wander', 'Grep')).toBe(false);
    expect(toolInMode('seated', 'WebFetch')).toBe(true);
    expect(toolInMode('wander', 'WebSearch')).toBe(false);
    for (const m of BRAIN_MODES) {
      expect(toolInMode(m, 'AskUserQuestion')).toBe(true);
      for (const t of ['EnterPlanMode', 'NotebookEdit', 'mcp__mc__nope', 'mcp__evil__bash', 'constructor'])
        expect(toolInMode(m, t), `${t} in ${m}`).toBe(false);
    }
    expect(toolInMode('wander', 'ExitPlanMode')).toBe(false);
  });

  it('profileToolNames lists every visible name of a mode, and every built-in belongs to some mode', () => {
    expect(profileToolNames('meeting')).toEqual(
      ['AskUserQuestion', ...MEETING_MC.map((t) => `mcp__mc__${t}`)].sort(),
    );
    expect(profileToolNames('seated')).toContain('Bash');
    expect(profileToolNames('seated')).toContain('mcp__pc__screenshot');
    expect(profileToolNames('wander')).not.toContain('mcp__pc__bash');
    for (const b of BUILTIN_TOOLS)
      expect(
        BRAIN_MODES.some((m) => toolInMode(m, b)),
        b,
      ).toBe(true);
  });
});

type SeatCase =
  | 'wandering'
  | 'walking'
  | 'pending'
  | 'seated'
  | 'away'
  | 'standing'
  | 'meeting_walking'
  | 'meeting'
  | 'debounce';

/** A SeatFSM driven into each state. */
function fsmIn(state: SeatCase): SeatFSM {
  const fsm = new SeatFSM({ now: () => 1000 });
  if (state === 'wandering') return fsm;
  if (state === 'meeting' || state === 'meeting_walking') {
    fsm.beginSit({ kind: 'meeting', meetingId: 'm1' });
    if (state === 'meeting') fsm.arrived();
    return fsm;
  }
  fsm.beginSit({ kind: 'pc', pcId: 'linux-1' }, { purpose: 'fix tests' });
  if (state === 'walking') return fsm;
  fsm.arrived();
  if (state === 'pending') return fsm;
  fsm.boundary();
  if (state === 'seated') return fsm;
  if (state === 'away') {
    fsm.goAway();
    return fsm;
  }
  fsm.stand('stand');
  if (state === 'standing') return fsm;
  fsm.boundary();
  return fsm; // wandering within the re-sit debounce
}

const seat = (state: SeatCase): SeatSnapshot => fsmIn(state).snapshot;

describe('modeForSeat', () => {
  it('maps every seat state to its mode (away keeps PC mode; walking and standing are Minecraft mode)', () => {
    const expected: Record<SeatCase, BrainMode> = {
      wandering: 'wander',
      walking: 'wander',
      pending: 'seated',
      seated: 'seated',
      away: 'seated',
      standing: 'wander',
      meeting_walking: 'wander',
      meeting: 'meeting',
      debounce: 'wander',
    };
    for (const [state, mode] of Object.entries(expected))
      expect(modeForSeat(seat(state as SeatCase)), state).toBe(mode);
  });

  it("agrees with the SeatFSM's model choice outside the re-sit debounce", () => {
    // A PC seat runs on Opus; Minecraft and Meeting mode on Haiku once no debounce holds Opus any more.
    const later = 1000 + 24 * 3_600_000;
    const states = [
      'wandering',
      'walking',
      'pending',
      'seated',
      'away',
      'standing',
      'meeting',
      'debounce',
    ] as const;
    for (const state of states) {
      const fsm = fsmIn(state);
      const tier = modeProfile(modeForSeat(fsm.snapshot)).brain.tier;
      expect(tier === 'opus', state).toBe(fsm.wantsOpus(later));
    }
    // Within the debounce the model stays Opus while the mode is Minecraft mode already (debounce rules unchanged).
    const debounce = fsmIn('debounce');
    expect(debounce.wantsOpus(1001)).toBe(true);
    expect(modeForSeat(debounce.snapshot)).toBe('wander');
  });
});

describe('MODE banner and persona sections', () => {
  const input = { nonce: 'abc123', playerName: 'Jasper' };

  it('is deterministic per mode and carries the control tag, the persona section and the lists', () => {
    for (const v of MC_TOOL_SETS) {
      for (const m of BRAIN_MODES) {
        const b = modeBanner(m, { ...input, mcTools: v });
        expect(modeBanner(m, { ...input, mcTools: v })).toBe(b);
        expect(b.startsWith(`[MV:abc123 MODE] ${modeProfile(m, v).title}:`)).toBe(true);
        for (const line of modeSection(m, 'Jasper', v)) expect(b).toContain(line);
        expect(b).toMatch(/\nAvailable now: /);
      }
    }
    expect(modeBanner('seated', input)).toBe(modeBanner('seated', { ...input, mcTools: 'v1' }));
  });

  it('Minecraft mode: every mc tool now, the PC tools and the web wait for a PC', () => {
    const b = modeBanner('wander', input);
    expect(b).toContain('Available now: AskUserQuestion; every mcp__mc__* tool.');
    expect(b).toMatch(
      /Not available until you sit at a PC: the PC tools \(Bash, Read, Edit, Write, Glob, Grep/,
    );
    expect(b).toContain('WebSearch and WebFetch');
    expect(b).toContain('mcp__mc__sit_at_pc');
  });

  it('PC mode: the computer tools and exactly the minimal mc set; the world waits for stand_up', () => {
    const b = modeBanner('seated', input);
    expect(b).toContain(
      'Available now: Bash, Read, Edit, Write, Glob, Grep, TaskStop and every other mcp__pc__* tool, all running inside the PC; AskUserQuestion, WebSearch, WebFetch; ',
    );
    expect(b).toContain(`from mcp__mc__ only ${modeProfile('seated').mc.join(', ')}.`);
    expect(b).toMatch(
      /Blocked until you stand up \(mcp__mc__stand_up\): every other mcp__mc__\* tool \(goto, mine, craft, build, …\)\./,
    );
    expect(b).toContain('mcp__mc__status and mcp__mc__look_around show what goes on around you');
    // The v2 tool set: observe, and the codex / calendar action tools.
    const v2 = modeBanner('seated', { ...input, mcTools: 'v2' });
    expect(v2).toContain('from mcp__mc__ only observe, say, tell, remember, stand_up, codex, calendar.');
    expect(v2).toContain('(goto, gather, craft, build, …)');
    expect(v2).toContain('mcp__mc__observe shows what goes on around you');
    // ExitPlanMode is only for plan-first sessions: the kickoff names it then, the list never does.
    expect(b.split('\n').find((l) => l.startsWith('Available now:'))).not.toContain('ExitPlanMode');
    expect(b).toContain("Jasper's Vault folders");
  });

  it('Meeting mode: talk, notes and calendar; everything else waits', () => {
    const b = modeBanner('meeting', input);
    expect(b).toContain(`Available now: AskUserQuestion; from mcp__mc__ only ${MEETING_MC.join(', ')}.`);
    expect(modeBanner('meeting', { ...input, mcTools: 'v2' })).toContain(
      'Available now: AskUserQuestion; from mcp__mc__ only say, tell, remember, stand_up, codex, calendar.',
    );
    expect(b).toMatch(
      /Blocked until the meeting ends or you stand up: every other mcp__mc__\* tool .*the PC tools/,
    );
  });

  it('the persona (system prompt) is the same in every mode and leaves the mode sections to the banner', () => {
    const p = personaPrompt({
      name: 'Ada',
      handle: 'ada',
      role: 'engineer',
      ceo: false,
      playerName: 'Jasper',
      nonce: 'abc123',
    });
    expect(p).toContain('## Modes');
    expect(p).toContain('[MV:abc123 MODE]');
    for (const m of BRAIN_MODES) for (const line of modeSection(m, 'Jasper')) expect(p).not.toContain(line);
  });
});

/** A gate context for a seat (the agent owns linux-1). */
function ctx(s: SeatSnapshot, extra: Partial<GateContext> = {}): GateContext {
  return {
    agentId: 'ada-1',
    ceo: true,
    seat: s,
    occupant: (pcId) => (pcId === 'linux-1' ? 'ada-1' : null),
    trackedMode: 'bypassPermissions',
    plans: new PlanCapture(['/Users/jasper']),
    turn: { calls: 0, activeMs: 0 },
    playerName: 'Jasper',
    ...extra,
  };
}

/** A valid-looking input for any tool (the gate only reads a few fields). */
const INPUT = { assignees: ['ada-1'], url: 'https://93.184.215.14/', command: 'ls', file_path: '/tmp/x' };
const web = { resolve: async () => ['93.184.215.14'] };

describe('ToolGate holds every call to the mode of the seat', () => {
  it('never allows a tool outside the mode, over the whole catalog and every seat state', async () => {
    const states = ['wandering', 'walking', 'seated', 'away', 'standing', 'meeting', 'debounce'] as const;
    const tools = [
      ...ALL_MC.map((t) => `mcp__mc__${t}`),
      ...PC_TOOLS.map((t) => `mcp__pc__${t}`),
      'WebSearch',
      'WebFetch',
    ];
    let allowed = 0;
    for (const state of states) {
      const s = seat(state);
      const mode = modeForSeat(s);
      for (const tool of tools) {
        const d = await decideTool(tool, INPUT, ctx(s), { serverSource: 'sdk', web });
        if (d.behavior === 'allow') {
          allowed++;
          expect(toolInMode(mode, tool), `${tool} allowed in ${state} (${mode})`).toBe(true);
        }
      }
    }
    expect(allowed).toBeGreaterThan(100);
  });

  it('lets nothing outside the mode through (allow or broker), with both tool sets, the built-ins and plan mode', async () => {
    const states: readonly SeatCase[] = [
      'wandering',
      'walking',
      'pending',
      'seated',
      'away',
      'standing',
      'meeting_walking',
      'meeting',
      'debounce',
    ];
    let passed = 0;
    for (const version of MC_TOOL_SETS) {
      const tools = [
        ...mcToolsIn(version).map((t) => `mcp__mc__${t}`),
        ...PC_TOOLS.map((t) => `mcp__pc__${t}`),
        ...BUILTIN_TOOLS,
        'EnterPlanMode',
      ];
      for (const state of states) {
        const s = seat(state);
        const mode = modeForSeat(s);
        for (const trackedMode of ['bypassPermissions', 'plan'] as const) {
          for (const tool of tools) {
            const d = await decideTool(tool, INPUT, ctx(s, { trackedMode, mcTools: version }), {
              serverSource: 'sdk',
              web,
            });
            if (d.behavior === 'deny') continue;
            passed++;
            expect(
              toolInMode(mode, tool),
              `${tool} ${d.behavior} in ${state}/${trackedMode} (${version})`,
            ).toBe(true);
          }
        }
      }
    }
    expect(passed).toBeGreaterThan(200);
  });

  it('ExitPlanMode reaches the broker only in PC mode: a plan ends with its PC seat', async () => {
    const plan = { trackedMode: 'plan' as const };
    expect((await decideTool('ExitPlanMode', {}, ctx(seat('seated'), plan))).behavior).toBe('defer');
    // A plan-first agent that stood up mid-turn: the CLI is still in plan mode until the turn boundary.
    for (const state of ['standing', 'debounce', 'meeting'] as const) {
      const d = await decideTool('ExitPlanMode', {}, ctx(seat(state), plan));
      expect(d, state).toMatchObject({ behavior: 'deny', code: 'mode' });
      expect(d.reason, state).toMatch(
        /^ExitPlanMode is not available in (Minecraft|Meeting) mode: a plan ends/,
      );
    }
    // Outside plan mode the old rule answers first.
    expect(await decideTool('ExitPlanMode', {}, ctx(seat('standing')))).toMatchObject({
      behavior: 'deny',
      code: 'no_plan_mode',
    });
  });

  it('denies a tool outside the mode with teaching text (code "mode")', async () => {
    const seated = await decideTool('mcp__mc__inventory', {}, ctx(seat('seated')), { serverSource: 'sdk' });
    expect(seated).toMatchObject({ behavior: 'deny', code: 'mode' });
    expect(seated.reason).toBe(outsideModeText('seated', 'mcp__mc__inventory'));
    expect(seated.reason).toMatch(/not available in PC mode\. Stand up first \(mcp__mc__stand_up\)/);
    const meeting = await decideTool('mcp__mc__status', {}, ctx(seat('meeting')), { serverSource: 'sdk' });
    expect(meeting).toMatchObject({ behavior: 'deny', code: 'mode' });
    expect(meeting.reason).toMatch(/not available in Meeting mode/);
    // Away from the seat to ask the player: still PC mode.
    const away = await decideTool('mcp__mc__eat', {}, ctx(seat('away')), { serverSource: 'sdk' });
    expect(away).toMatchObject({ behavior: 'deny', code: 'mode' });
    expect(
      (await decideTool('mcp__mc__status', {}, ctx(seat('away')), { serverSource: 'sdk' })).behavior,
    ).toBe('allow');
    // After a mid-turn stand_up the rest of the turn is Minecraft mode already (the model swaps at the boundary).
    expect(
      (await decideTool('mcp__mc__goto', {}, ctx(seat('standing')), { serverSource: 'sdk' })).behavior,
    ).toBe('allow');
    expect(
      await decideTool('mcp__pc__bash', {}, ctx(seat('standing')), { serverSource: 'sdk' }),
    ).toMatchObject({
      behavior: 'deny',
      code: 'not_seated',
    });
  });

  it('PC mode keeps the pc tools, the aliases (as their targets) and the web', async () => {
    const s = seat('seated');
    for (const t of PC_TOOLS) {
      const d = await decideTool(`mcp__pc__${t}`, INPUT, ctx(s), { serverSource: 'sdk' });
      expect(d.behavior, t).toBe('allow');
    }
    expect((await decideTool('WebSearch', {}, ctx(s), { web })).behavior).toBe('allow');
  });
});
