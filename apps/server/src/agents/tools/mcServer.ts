/**
 * The `mc` MCP tool server (PLAN §7.4): every `mcp__mc__*` tool. World jobs and observations go to the mod through
 * the SkillApi; Codex, calendar and task reports go to the OrgApi; social and seat tools go to the agent's host (the
 * AgentManager).
 *
 * Two tool sets exist while the v1/v2 A/B runs (docs/design/tools-v2-mc.md §14): v1 (54 tools, mcServerV1.ts) and v2
 * (20 tools, mcToolsV2.ts), chosen by `MINEVIBE_MC_TOOLS` ({@link mcToolsVersion}). The tool list is byte-stable for
 * a session and the same for every agent, so prompt caches survive promotions.
 *
 * Gate rules (who may call what, when) live in the ToolGate; handlers still fail closed where it matters.
 */

import {
  createSdkMcpServer,
  type McpSdkServerConfigWithInstance,
  type SdkMcpToolDefinition,
} from '@anthropic-ai/claude-agent-sdk';
import { MCP_TOOL_TIMEOUT_MS, type McToolsVersion, mcToolsVersion } from '../constants.js';
import { type McToolName, mcToolsOf } from './catalog.js';
import type { McHost } from './host.js';
import { mcToolDefinitionsV1 } from './mcServerV1.js';
import { MC_V2_INSTRUCTIONS, mcToolDefinitionsV2 } from './mcToolsV2.js';

// The game-clock helpers moved to contracts/orgTools.ts (the fake OrgApi formats with them); re-exported here.
export { gameTimeToTicks, parseWhen, ticksToGameTime } from '../../contracts/orgTools.js';
export { BLOCK_CHANGING_SKILLS, type McHost, splitFooter } from './host.js';

// biome-ignore lint/suspicious/noExplicitAny: the server holds tools of many different input shapes
type Def = SdkMcpToolDefinition<any>;

/** The `mc` tool definitions of one agent, for the given tool set (default: `MINEVIBE_MC_TOOLS`). */
export function mcToolDefinitions(host: McHost, version: McToolsVersion = mcToolsVersion()): Def[] {
  return version === 'v2' ? mcToolDefinitionsV2(host) : mcToolDefinitionsV1(host);
}

/** The server options both versions share (and the eval harness copies). */
export function mcServerOptions(version: McToolsVersion = mcToolsVersion()): {
  name: 'mc';
  version: string;
  alwaysLoad: true;
  timeout: number;
  instructions?: string;
} {
  return version === 'v2'
    ? {
        name: 'mc',
        version: '2.0.0',
        alwaysLoad: true,
        timeout: MCP_TOOL_TIMEOUT_MS,
        instructions: MC_V2_INSTRUCTIONS,
      }
    : { name: 'mc', version: '1.0.0', alwaysLoad: true, timeout: MCP_TOOL_TIMEOUT_MS };
}

/** The in-process `mc` server (never swapped; `alwaysLoad`, 600 s tool timeout). */
export function createMcServer(
  host: McHost,
  version: McToolsVersion = mcToolsVersion(),
): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({ ...mcServerOptions(version), tools: mcToolDefinitions(host, version) });
}

/** Every mc tool name the server defines (tests compare it with the catalog). */
export function mcToolNames(
  defs: readonly { name: string }[],
  version: McToolsVersion = mcToolsVersion(),
): McToolName[] {
  const known = mcToolsOf(version);
  return defs.map((d) => d.name).filter((n): n is McToolName => Object.hasOwn(known, n));
}
