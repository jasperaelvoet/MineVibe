/**
 * How texts outside the tool server name `mc` tools (persona, kickoff, org replies), per tool set: v1 names
 * (`mcp__mc__calendar_add`) or the v2 call (`mcp__mc__calendar{action:"add"}`). docs/design/tools-v2-mc.md N9.
 *
 * Only the tool set changes these texts, and it is fixed for a process (`MINEVIBE_MC_TOOLS`), so the system prompt
 * stays byte-stable and cached.
 */

import type { McToolsVersion } from '../constants.js';
import { control } from '../envelope.js';

export interface McRefs {
  readonly calendarAdd: string;
  readonly reportTask: string;
  readonly codexSearch: string;
  readonly codexRead: string;
  readonly codexReadWith: (id: string) => string;
  readonly reportTaskWith: (eventId: string) => string;
  readonly look: string;
  readonly find: string;
  readonly gatherExact: string;
}

const V1: McRefs = {
  calendarAdd: 'mcp__mc__calendar_add',
  reportTask: 'mcp__mc__report_task',
  codexSearch: 'mcp__mc__codex_search',
  codexRead: 'mcp__mc__codex_read',
  codexReadWith: (id) => `mcp__mc__codex_read{id:"${id}"}`,
  reportTaskWith: (eventId) => `mcp__mc__report_task{event_id:"${eventId}", status}`,
  look: 'mcp__mc__look_around',
  find: 'mcp__mc__find',
  gatherExact: 'mcp__mc__mine / mcp__mc__collect',
};

const V2: McRefs = {
  calendarAdd: 'mcp__mc__calendar{action:"add"}',
  reportTask: 'mcp__mc__calendar{action:"report"}',
  codexSearch: 'mcp__mc__codex{action:"search"}',
  codexRead: 'mcp__mc__codex{action:"read"}',
  codexReadWith: (id) => `mcp__mc__codex{"action":"read","id":"${id}"}`,
  reportTaskWith: (eventId) => `mcp__mc__calendar{"action":"report","id":"${eventId}","status":"done"}`,
  look: 'mcp__mc__observe',
  find: 'mcp__mc__find',
  gatherExact: 'mcp__mc__gather',
};

export function mcRefs(version: McToolsVersion): McRefs {
  return version === 'v2' ? V2 : V1;
}

/** v1 → v2 renames (N11), for a resumed session whose transcript holds v1 calls. */
const V1_TO_V2 = [
  'status, look_around, inventory, crew, list_pcs, recent_events, menu_state → observe{sections:[…]}',
  'mine, collect, pickup, hunt (for drops) → gather{item, count}',
  'recipe, smelt → craft (plan:true shows the recipe tree)',
  'place, use_block, use_item, attack, sleep, ride, dismount → use{action}',
  'equip, eat, drop, give, container → items{action}',
  'dig, farm → build{action}',
  'open_menu, menu_click, menu_close → menu{action}',
  'job_status, wait, stop → job{action}',
  'emote → say{emote}',
  'codex_* → codex{action}; calendar_*, report_task → calendar{action}',
];

/** The one-time `[MV:<nonce> TOOLS UPDATED]` context note. */
export function toolsUpdatedNote(nonce: string, from: McToolsVersion, to: McToolsVersion): string {
  const text =
    to === 'v2'
      ? `Your mc tools changed since your earlier turns; the old names no longer exist. ${V1_TO_V2.join('; ')}. New: do (several steps as one job). Positions are "x y z" strings. There is no wait_s: tools answer within 20 s.`
      : `Your mc tools changed back to the earlier set (${from} → ${to}): status, look_around, inventory, mine, collect, craft, smelt, place, codex_search, calendar_add and the rest. Positions are {x,y,z} objects.`;
  return control(nonce, 'TOOLS UPDATED', text);
}
