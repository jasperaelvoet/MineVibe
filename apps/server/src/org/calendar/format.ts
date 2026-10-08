/** How calendar content reaches agents: titles and tasks are shared text, so they arrive inside a data envelope. */

import { singleLine, wrapNote } from '../envelope.js';
import type { CalendarEvent, Recurrence } from './types.js';

export function describeRecurrence(r: Recurrence): string {
  switch (r.kind) {
    case 'once':
      return 'once';
    case 'daily':
      return 'daily';
    case 'weekdays':
      return 'weekdays';
    case 'every_n_days':
      return `every ${r.n} days`;
  }
}

export interface EventFormatContext {
  readonly formatWhen: (ev: CalendarEvent, at: number) => string;
  readonly name: (agentId: string) => string;
}

export function eventLine(ev: CalendarEvent, ctx: EventFormatContext): string {
  const who = ev.assignees === 'all' ? 'everyone' : ev.assignees.map(ctx.name).join(', ');
  const when = ev.nextAt !== null ? ctx.formatWhen(ev, ev.nextAt) : 'no next time';
  const by = ev.createdBy === 'player' ? ev.createdByName : `${ev.createdByName}`;
  const flags = [
    ev.status !== 'active' ? ev.status.replace('_', ' ') : '',
    ev.orphaned ? 'orphaned' : '',
    ev.location ? `at ${singleLine(ev.location, 40)}` : '',
  ].filter(Boolean);
  return `- [${ev.id}] ${singleLine(ev.title)}: ${ev.kind} for ${who}, ${when} (${ev.clock} clock, ${describeRecurrence(ev.recurrence)})${flags.length ? `, ${flags.join(', ')}` : ''}; by ${by}`;
}

/** `calendar_list` result. */
export function formatEventsForAgent(events: readonly CalendarEvent[], ctx: EventFormatContext): string {
  if (events.length === 0) return 'No calendar events match.';
  const lines = events.map((ev) => {
    const task = ev.task && ev.task !== ev.title ? `\n    task: ${singleLine(ev.task, 300)}` : '';
    return `${eventLine(ev, ctx)}${task}`;
  });
  return `${events.length} calendar event(s):\n${wrapNote(
    { author: { kind: 'system', name: 'MineVibe' }, kind: 'calendar' },
    lines.join('\n'),
  )}`;
}
