/**
 * The `pc` MCP tool server (PLAN §6.2, PC tools V2): every `mcp__pc__*` tool, run inside the PC the agent sits at
 * through the PcApi. The host never opens a path an agent controls.
 *
 * - Computer (gui.ts): the trained computer-use toolset, member by member (screenshot, zoom, the clicks, drag, mouse
 *   down/up/move, cursor_position, scroll, type, key, hold_key, wait), in screenshot pixels. Several in one turn run in
 *   order and stop at the first failure; the last one answers with the settled screen, or one line when nothing
 *   changed since the agent's last image.
 * - Perception (ui.ts, helpers.ts): `ui` reads apps through the accessibility tree (refs, text, windows), `ui_act`
 *   drives elements and windows, `open` opens a URL/file/app and returns its window, `wait_for` waits for text, an
 *   element, a window or a still screen.
 * - Shell and files (shell.ts, files.ts): Claude Code 2.1.293's Bash, TaskStop, Read, Write, Edit, Glob and Grep,
 *   aliased from the built-ins, answering byte for byte as they do; background commands notify when they end.
 * - Every handler re-checks the seat (fail closed); every result stays within 60k characters (D7).
 */

import { createSdkMcpServer, type McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import { MCP_TOOL_TIMEOUT_MS } from '../../constants.js';
import { PC_TOOLS } from '../catalog.js';
import type { Def } from './common.js';
import { PcToolContext } from './context.js';
import { fileTools } from './files.js';
import { guiTools } from './gui.js';
import { helperTools } from './helpers.js';
import { metaTools } from './meta.js';
import { shellTools } from './shell.js';
import type { PcHost } from './types.js';
import { uiTools } from './ui.js';

export { BatchBook, isPcToolUse } from './batch.js';
export { PcToolContext } from './context.js';
export { catN, numberLines, READ_DEFAULT_LIMIT, READ_LINE_MAX } from './files.js';
export { jobNotification, ownJobKey, type PcJob, PcJobBook } from './jobs.js';
export { parseKeyText } from './keys.js';
export { clipOutput, stripPwdMarker, wrapBash } from './shell.js';
export type { PcHost } from './types.js';

/** The `pc` tool definitions of one agent, in catalog order. */
export function pcToolDefinitions(host: PcHost): Def[] {
  const ctx = new PcToolContext(host);
  const defs = [
    ...guiTools(ctx),
    ...uiTools(ctx),
    ...helperTools(ctx),
    ...shellTools(ctx),
    ...fileTools(ctx),
    ...metaTools(ctx),
  ];
  const order = new Map<string, number>(PC_TOOLS.map((n, i) => [n, i]));
  return defs.sort((a, b) => (order.get(a.name) ?? 99) - (order.get(b.name) ?? 99));
}

/** The in-process `pc` server (never swapped; `alwaysLoad`, 600 s tool timeout). */
export function createPcServer(host: PcHost): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: 'pc',
    version: '2.0.0',
    alwaysLoad: true,
    timeout: MCP_TOOL_TIMEOUT_MS,
    tools: pcToolDefinitions(host),
  });
}

export { PC_TOOLS };
