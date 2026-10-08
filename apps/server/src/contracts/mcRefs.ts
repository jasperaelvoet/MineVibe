/**
 * How texts the agents read name `mc` tools, per tool set (docs/design/tools-v2-mc.md N9): v1 names
 * (`mcp__mc__calendar_add`) or the v2 call (`mcp__mc__calendar{action:"add"}`). The org services and the agent runtime
 * both use it; the tool set is fixed for a process (`MINEVIBE_MC_TOOLS`), so texts in the cached system prompt and
 * replies stay byte-stable.
 */

/** Which `mc` tool set agents get: `MINEVIBE_MC_TOOLS=v1|v2` (the v1/v2 A/B; tools-v2-mc.md §14). */
export type McToolsVersion = 'v1' | 'v2';
export const DEFAULT_MC_TOOLS: McToolsVersion = 'v1';

export function mcToolsVersion(env: Readonly<Record<string, string | undefined>> = process.env): McToolsVersion {
  const v = env.MINEVIBE_MC_TOOLS?.trim().toLowerCase();
  return v === 'v1' || v === 'v2' ? v : DEFAULT_MC_TOOLS;
}

export interface McRefs {
  readonly calendarAdd: string;
  readonly reportTask: string;
  readonly codexSearch: string;
  readonly codexRead: string;
  readonly codexReadWith: (id: string) => string;
  readonly reportTaskWith: (eventId: string) => string;
}

const V1: McRefs = {
  calendarAdd: 'mcp__mc__calendar_add',
  reportTask: 'mcp__mc__report_task',
  codexSearch: 'mcp__mc__codex_search',
  codexRead: 'mcp__mc__codex_read',
  codexReadWith: (id) => `mcp__mc__codex_read{id:"${id}"}`,
  reportTaskWith: (eventId) => `mcp__mc__report_task{event_id:"${eventId}", status}`,
};

const V2: McRefs = {
  calendarAdd: 'mcp__mc__calendar{action:"add"}',
  reportTask: 'mcp__mc__calendar{action:"report"}',
  codexSearch: 'mcp__mc__codex{action:"search"}',
  codexRead: 'mcp__mc__codex{action:"read"}',
  codexReadWith: (id) => `mcp__mc__codex{"action":"read","id":"${id}"}`,
  reportTaskWith: (eventId) => `mcp__mc__calendar{"action":"report","id":"${eventId}","status":"done"}`,
};

/** The references of a tool set (default: this process's). */
export function mcRefs(version: McToolsVersion = mcToolsVersion()): McRefs {
  return version === 'v2' ? V2 : V1;
}
