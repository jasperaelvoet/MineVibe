/**
 * The world-scope Codex page "Base (office)" (protocol §7.4.3): written by MineVibe (system author) once per world,
 * as soon as the mod reports the starter office (`world.state.office`). It is a `places` page, so its coordinates are
 * stamped (the door) and `goto{place:"Base (office)"}` walks there; the CEO's welcome points at it.
 *
 * The door comes first in the body: `goto` reads the first coordinate triple of a places page.
 */

import { BASE_NAME, type BaseArea, baseAreaOf, type OfficeLayout, posText } from '../../world/baseArea.js';

/** Slot kinds in the order the page lists them, with their labels. */
const SLOT_LABELS: ReadonlyArray<readonly [string, string]> = [
  ['workstation', 'PC workstation'],
  ['meeting_table', 'meeting table'],
  ['codex', 'Codex'],
  ['wall_calendar', 'wall calendar'],
  ['chest', 'supply chest (bread, torches)'],
  ['bed', 'bed'],
  ['spawn', 'where the world began'],
];

export const BASE_PAGE_TAGS = ['base', 'office', 'home'] as const;

/** The page body, or null without an office. */
export function basePageBody(office: OfficeLayout, playerName: string): string | null {
  const base: BaseArea | null = baseAreaOf(office);
  if (!base) return null;
  const lines: string[] = [];
  const door = base.door ?? office.origin;
  lines.push(
    `The Base is ${playerName}'s home: the starter office MineVibe built where this world began.`,
    '',
    `Door (the porch in front of it): ${door.x}, ${door.y}, ${door.z}`,
    `Building: x ${base.min.x} to ${base.max.x}, z ${base.min.z} to ${base.max.z}, floor y ${base.floorY}, roof y ${base.max.y}`,
    '',
    'Inside:',
  );
  for (const [kind, label] of SLOT_LABELS) {
    const slots = office.slots.filter((s) => s.kind === kind);
    for (const s of slots.slice(0, kind === 'bed' ? 1 : 4)) {
      lines.push(`- ${label}${s.pcId ? ` (${s.pcId})` : ''}: ${posText(s.pos)}`);
    }
  }
  lines.push(
    '',
    'For the crew:',
    `- Never break, replace or take blocks of the Base, or anything ${playerName} built. Its chests, beds, tables and PCs are there to use.`,
    `- Gather wood and stone from nature outside the Base. If what ${playerName} asked for is missing or out of reach, ask ${playerName} instead of taking something else.`,
  );
  return lines.join('\n');
}

export { BASE_NAME };
