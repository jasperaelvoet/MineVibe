/**
 * Lists an in-process SDK MCP server's tools the way Claude Code sees them (an MCP client over an in-memory
 * transport), and measures the tool list as the model gets it: `{name: "mcp__<server>__<tool>", description,
 * input_schema}` per tool (docs/design/tools-v2-mc.md §1.4, Appendix C).
 */

import type { McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

export interface ListedTool {
  readonly name: string;
  readonly description?: string | undefined;
  readonly inputSchema: Record<string, unknown>;
  readonly annotations?: Record<string, unknown> | undefined;
  readonly _meta?: Record<string, unknown> | undefined;
}

export async function listTools(server: McpSdkServerConfigWithInstance): Promise<{
  tools: ListedTool[];
  instructions: string | undefined;
}> {
  const [a, b] = InMemoryTransport.createLinkedPair();
  const instance = server.instance as unknown as {
    connect(t: unknown): Promise<void>;
    close(): Promise<void>;
  };
  await instance.connect(a);
  const client = new Client({ name: 'measure', version: '1' });
  await client.connect(b);
  try {
    const { tools } = await client.listTools();
    return { tools: tools as ListedTool[], instructions: client.getInstructions() };
  } finally {
    await client.close();
    await instance.close();
  }
}

/** Characters of the tool list as sent to the model (≈ tokens × 4). */
export function toolListChars(server: string, tools: readonly ListedTool[]): number {
  let total = 0;
  for (const t of tools) {
    total += JSON.stringify({
      name: `mcp__${server}__${t.name}`,
      description: t.description,
      input_schema: t.inputSchema,
    }).length;
  }
  return total;
}
