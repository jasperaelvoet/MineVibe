import { describe, expect, it } from 'vitest';
import {
  commandMilestones,
  type MilestoneName,
  MilestoneWatcher,
} from '../../../src/progress/MilestoneWatcher.js';
import { type EventMap, TypedEmitter } from '../../../src/util/TypedEmitter.js';

class Bus<E extends EventMap> extends TypedEmitter<E> {
  fire<K extends keyof E>(event: K, ...args: E[K]): void {
    this.emit(event, ...args);
  }
}

function watcher() {
  const sent: Array<[MilestoneName, number | undefined]> = [];
  const crew = new Bus<{ work: [unknown]; tool: [unknown]; turn: [unknown] }>();
  const usage = new Bus<{ change: [unknown] }>();
  const org = new Bus<{ codexWritten: [unknown]; calendarFired: [unknown]; meetingState: [unknown] }>();
  let boot: ((pc: { pcId: string; family: 'linux' | 'macos' | 'windows' }) => void) | null = null;
  const w = new MilestoneWatcher((m, amount) => sent.push([m, amount])).watch({
    crew: crew as never,
    usage: usage as never,
    org: org as never,
    pcs: {
      onPcBooted: (listener) => {
        boot = listener;
        return () => {
          boot = null;
        };
      },
    },
  });
  return {
    sent,
    names: () => sent.map(([m]) => m),
    crew,
    usage,
    org,
    boot: (family: 'linux' | 'macos') => boot?.({ pcId: 'p', family }),
    w,
  };
}

describe('commandMilestones', () => {
  it('counts every command, and what a successful one achieved', () => {
    expect(commandMilestones('ls -la', 0)).toEqual(['command_run']);
    expect(commandMilestones('git add -A && git commit -m "init"', 0)).toEqual(['command_run', 'git_commit']);
    expect(commandMilestones('git push -u origin main', 0)).toEqual(['command_run', 'git_push']);
    expect(commandMilestones('gh pr create --fill', 0)).toEqual(['command_run', 'pr_opened']);
    expect(commandMilestones('cd app && npm test', 0)).toEqual(['command_run', 'tests_passed']);
    expect(commandMilestones('python3 -m pytest -q', 0)).toEqual(['command_run', 'tests_passed']);
    expect(commandMilestones('./gradlew test', 0)).toEqual(['command_run', 'tests_passed']);
    expect(commandMilestones('sudo apt-get install -y ripgrep', 0)).toEqual([
      'command_run',
      'package_installed',
    ]);
    expect(commandMilestones('npm i express', 0)).toEqual(['command_run', 'package_installed']);
    expect(commandMilestones('pip install requests', 0)).toEqual(['command_run', 'package_installed']);
  });

  it('counts a failure as nothing but a failure', () => {
    expect(commandMilestones('git commit -m wip', 1)).toEqual(['command_run', 'command_failed']);
    expect(commandMilestones('npm test', 2)).toEqual(['command_run', 'command_failed']);
  });

  it('reads one command at a time', () => {
    expect(commandMilestones('git log --oneline; echo commit', 0)).toEqual(['command_run']);
    expect(commandMilestones('git status | grep push', 0)).toEqual(['command_run']);
    expect(commandMilestones('cat latest.txt', 0)).toEqual(['command_run']);
  });
});

describe('MilestoneWatcher', () => {
  it('counts desk sessions, commands and files', () => {
    const t = watcher();
    t.crew.fire('work', { agentId: 'ada', kind: 'desk', pcId: 'linux-1', resumed: false });
    t.crew.fire('work', { agentId: 'ada', kind: 'desk', pcId: 'linux-1', resumed: true });
    t.crew.fire('work', {
      agentId: 'ada',
      kind: 'command',
      pcId: 'linux-1',
      command: 'git commit -am x',
      exitCode: 0,
    });
    t.crew.fire('work', { agentId: 'ada', kind: 'file', pcId: 'linux-1', path: '/home/agent/a.ts' });
    expect(t.names()).toEqual(['desk_session', 'desk_resumed', 'command_run', 'git_commit', 'file_written']);
  });

  it('counts the web and opened apps, only when the gate allowed them', () => {
    const t = watcher();
    t.crew.fire('tool', { toolName: 'WebSearch', behavior: 'allow' });
    t.crew.fire('tool', { toolName: 'WebFetch', behavior: 'deny' });
    t.crew.fire('tool', { toolName: 'mcp__pc__open', behavior: 'allow' });
    t.crew.fire('tool', { toolName: 'mcp__pc__bash', behavior: 'allow' });
    expect(t.names()).toEqual(['web_used', 'app_opened']);
  });

  it('sends the tokens each turn added, per session', () => {
    const t = watcher();
    const turn = (session: string, input: number, output: number) =>
      t.crew.fire('turn', {
        agentId: 'ada',
        session,
        result: {
          modelUsage: { opus: { inputTokens: input, outputTokens: output, cacheReadInputTokens: 99_999 } },
        },
      });
    turn('desk', 1_000, 200);
    turn('desk', 1_500, 300);
    turn('body', 400, 100);
    turn('desk', 50, 10); // a fresh desk session
    expect(t.sent).toEqual([
      ['tokens', 1_200],
      ['tokens', 600],
      ['tokens', 500],
      ['tokens', 60],
    ]);
  });

  it('counts usage dips once per change', () => {
    const t = watcher();
    t.usage.fire('change', { mode: 'tired' });
    t.usage.fire('change', { mode: 'tired' });
    t.usage.fire('change', { mode: 'asleep' });
    t.usage.fire('change', { mode: 'normal' });
    t.usage.fire('change', { mode: 'tired' });
    expect(t.names()).toEqual(['brains_tired', 'brains_asleep', 'brains_tired']);
  });

  it('counts agent Codex pages, fired events once and meetings that were held', () => {
    const t = watcher();
    t.org.fire('codexWritten', { pageId: 'a', created: true, authorKind: 'agent' });
    t.org.fire('codexWritten', { pageId: 'a', created: false, authorKind: 'agent' });
    t.org.fire('codexWritten', { pageId: 'b', created: true, authorKind: 'player' });
    t.org.fire('calendarFired', { eventId: 'e1', occurrence: 1 });
    t.org.fire('calendarFired', { eventId: 'e1', occurrence: 1 });
    t.org.fire('calendarFired', { eventId: 'e1', occurrence: 2 });
    t.org.fire('meetingState', { meetingId: 'm1', phase: 'floor', attendees: [{ status: 'seated' }] });
    t.org.fire('meetingState', { meetingId: 'm2', phase: 'done', attendees: [{ status: 'absent' }] });
    t.org.fire('meetingState', { meetingId: 'm1', phase: 'done', attendees: [{ status: 'seated' }] });
    t.org.fire('meetingState', { meetingId: 'm1', phase: 'done', attendees: [{ status: 'seated' }] });
    expect(t.names()).toEqual(['agent_codex', 'calendar_fired', 'calendar_fired', 'meeting_minutes']);
  });

  it('counts booted PCs, and Macs as Macs', () => {
    const t = watcher();
    t.boot('linux');
    t.boot('macos');
    expect(t.names()).toEqual(['pc_booted', 'pc_booted', 'mac_booted']);
    t.w.stop();
    t.boot('linux');
    t.crew.fire('work', { agentId: 'ada', kind: 'file', pcId: 'p', path: '/x' });
    expect(t.sent).toHaveLength(3);
  });
});
