/**
 * The `pc` MCP tool server (PLAN §6.2): every `mcp__pc__*` tool, run inside the PC the agent sits at through the
 * PcApi. The host never opens a path an agent controls.
 *
 * - `toolAliases` route the built-ins here with their own input (S2), so `bash`, `read`, `edit`, `write`, `glob` and
 *   `grep` accept a superset of the built-in schemas (Bash's `description` and `dangerouslyDisableSandbox`, Read's
 *   `pages`, Grep's flags) and answer in the built-ins' style (`cat -n` lines, "The file … has been updated.").
 * - `pc__bash` runs `bash -lc` as the guest user with the shell-log wrapper; the cwd persists per agent and PC through
 *   the `__MV_PWD__` marker. Output is capped at 30k characters; timeouts default 120 s, max 600 s; background jobs
 *   are read with `bash_output` and killed with `bash_kill`. Every spawn is tagged `agentId:seatEpoch`.
 * - Writes, edits and reads under `~/.claude/plans/` are captured in Node memory (PlanCapture) and never reach the PC.
 * - Handlers re-check the seat (fail closed): a call allowed under an older seat epoch is refused.
 */

import {
  createSdkMcpServer,
  type McpSdkServerConfigWithInstance,
  type SdkMcpToolDefinition,
  tool,
} from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { ApiError, isApiError } from '../../contracts/common.js';
import { PC_ERROR_CODES, PC_LIMITS, type PcApi, type PcGuestInfo } from '../../contracts/PcApi.js';
import { MCP_TOOL_TIMEOUT_MS } from '../constants.js';
import type { HandoffNotes } from '../memory.js';
import type { PlanCapture } from '../PlanCapture.js';
import { PC_TOOLS, type PcToolName } from './catalog.js';
import { type CallToolResult, errorFrom, errorResult, textResult } from './results.js';

export interface PcHost {
  readonly agentId: string;
  readonly pcs: PcApi;
  readonly plans: PlanCapture;
  readonly handoffs: HandoffNotes;
  /** The PC and seat epoch this call may use, or null (not seated, or the seat changed since the gate allowed it). */
  access(tool: PcToolName): { readonly pcId: string; readonly epoch: number } | null;
  /** Display name for handoff notes. */
  authorName(): string;
}

// biome-ignore lint/suspicious/noExplicitAny: the server holds tools of many different input shapes
type Def = SdkMcpToolDefinition<any>;

/** Read's defaults (the built-in's). */
export const READ_DEFAULT_LIMIT = 2000;
export const READ_LINE_MAX = 2000;

/** The wrapper around a `pc__bash` command (PLAN §6.2). `MV_CWD` is set by the caller. */
export function wrapBash(command: string): string {
  return [
    'mkdir -p ~/.mv',
    'exec > >(tee -a ~/.mv/shell.log) 2>&1',
    'cd "$MV_CWD" 2>/dev/null || cd ~',
    command,
    'ec=$?',
    'printf \'\\n__MV_PWD__%s\' "$PWD"',
    'exit $ec',
  ].join('\n');
}

const PWD_MARKER_RE = /\n?__MV_PWD__([^\n]*)\n?/g;

/** Splits the `__MV_PWD__` marker off the output: the clean output and the last cwd seen. */
export function stripPwdMarker(output: string): { output: string; cwd: string | null } {
  let cwd: string | null = null;
  const clean = output.replace(PWD_MARKER_RE, (_m, dir: string) => {
    const d = dir.trim();
    if (d.startsWith('/')) cwd = d;
    return '';
  });
  return { output: clean, cwd };
}

/** `cat -n` formatting, as the built-in Read answers. */
export function catN(content: string, startLine: number): string {
  if (content.length === 0) return '';
  const lines = content.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines
    .map((line, i) => {
      const clipped =
        line.length > READ_LINE_MAX ? `${line.slice(0, READ_LINE_MAX)}… (line truncated)` : line;
      return `${String(startLine + i).padStart(6)}\t${clipped}`;
    })
    .join('\n');
}

/** "ctrl+shift+t" / ["ctrl","c"] / "Enter" → cua key names. */
export function parseKeys(keys: unknown): string[] {
  const list = Array.isArray(keys) ? keys.map(String) : typeof keys === 'string' ? keys.split('+') : [];
  return list.map((k) => k.trim()).filter((k) => k.length > 0 && k.length <= 32);
}

function clipOutput(text: string): string {
  const max = PC_LIMITS.maxOutputChars;
  if (text.length <= max) return text;
  const head = text.slice(0, Math.floor(max * 0.4));
  const tail = text.slice(text.length - Math.floor(max * 0.6));
  return `${head}\n… (${text.length - head.length - tail.length} characters omitted) …\n${tail}`;
}

const NOT_SEATED = errorResult(
  'Not seated at a PC (or your seat changed). Walk to a PC and call mcp__mc__sit_at_pc.',
);

/** Builds the `pc` tool definitions of one agent. */
export function pcToolDefinitions(host: PcHost): Def[] {
  const defs: Def[] = [];
  const push = (...ds: unknown[]) => {
    defs.push(...(ds as Def[]));
  };
  const cwds = new Map<string, string>();
  const infos = new Map<string, PcGuestInfo>();
  const offsets = new Map<string, number>();

  const info = async (pcId: string): Promise<PcGuestInfo> => {
    const cached = infos.get(pcId);
    if (cached) return cached;
    const fresh = await host.pcs.info(pcId);
    infos.set(pcId, fresh);
    return fresh;
  };
  const cwdOf = async (pcId: string): Promise<string> => {
    const known = cwds.get(pcId);
    if (known) return known;
    const i = await info(pcId);
    return i.mounts.find((m) => m.mode === 'rw')?.hostPath ?? i.mounts[0]?.hostPath ?? i.home;
  };
  const absolute = async (pcId: string, path: string): Promise<string> =>
    path.startsWith('/') ? path : `${(await cwdOf(pcId)).replace(/\/+$/, '')}/${path.replace(/^~\//, '')}`;

  /** Runs a handler with the seat checked; plan paths never reach it. */
  const seated =
    (name: PcToolName, fn: (pcId: string, epoch: number) => Promise<CallToolResult>) =>
    async (): Promise<CallToolResult> => {
      const access = host.access(name);
      if (!access) return NOT_SEATED;
      try {
        return await fn(access.pcId, access.epoch);
      } catch (err) {
        if (isApiError(err, PC_ERROR_CODES.PC_DOWN))
          return errorResult(`${access.pcId} is down: ${err.message}`);
        return errorFrom(err);
      }
    };

  // --- Shell ---------------------------------------------------------------------------------------------------
  push(
    tool(
      'bash',
      'Run a shell command inside the PC you sit at (bash, as the PC user). The working directory persists between calls. Output is capped at 30000 characters.',
      {
        command: z.string().min(1).describe('The command to execute'),
        timeout: z.number().optional().describe('Timeout in milliseconds (default 120000, max 600000)'),
        description: z.string().optional().describe('What the command does, in a few words'),
        run_in_background: z
          .boolean()
          .optional()
          .describe('Run in the background; read output with mcp__pc__bash_output'),
        dangerouslyDisableSandbox: z
          .boolean()
          .optional()
          .describe('Ignored: commands always run inside the PC'),
      },
      (args) =>
        seated('bash', async (pcId, epoch) => {
          const cwd = await cwdOf(pcId);
          const timeoutMs = Math.min(
            PC_LIMITS.maxTimeoutMs,
            Math.max(1_000, typeof args.timeout === 'number' ? args.timeout : PC_LIMITS.defaultTimeoutMs),
          );
          let res: Awaited<ReturnType<PcApi['exec']>>;
          try {
            res = await host.pcs.exec(pcId, {
              command: wrapBash(args.command),
              cwd,
              env: { MV_CWD: cwd },
              timeoutMs,
              background: args.run_in_background === true,
              tag: `${host.agentId}:${epoch}`,
            });
          } catch (err) {
            if (isApiError(err, PC_ERROR_CODES.TIMEOUT)) {
              return errorResult(`Command timed out after ${Math.round(timeoutMs / 1000)} s and was killed.`);
            }
            throw err;
          }
          if (res.kind === 'background') {
            offsets.set(res.jobId, 0);
            return textResult(
              `Command running in background with ID: ${res.jobId}. Read its output with mcp__pc__bash_output{bash_id:"${res.jobId}"}.`,
            );
          }
          const { output, cwd: newCwd } = stripPwdMarker(res.output);
          if (newCwd) cwds.set(pcId, newCwd);
          const body = clipOutput(output.replace(/\s+$/, '')) || '(no output)';
          const tail = res.exitCode === 0 ? '' : `\nExit code ${res.exitCode}`;
          return textResult(`${body}${res.truncated ? '\n(output truncated)' : ''}${tail}`);
        })(),
    ),
    tool(
      'bash_output',
      'Read new output of a background command started with mcp__pc__bash.',
      {
        bash_id: z.string().min(1).max(64).optional(),
        shell_id: z.string().min(1).max(64).optional(),
        id: z.string().min(1).max(64).optional(),
        filter: z.string().max(200).optional().describe('Only lines matching this regular expression'),
      },
      (args) =>
        seated('bash_output', async (pcId) => {
          const jobId = args.bash_id ?? args.shell_id ?? args.id;
          if (!jobId) return errorResult('Give bash_id.');
          const out = await host.pcs.jobOutput(pcId, jobId, offsets.get(jobId) ?? 0);
          offsets.set(jobId, out.nextOffset);
          let text = stripPwdMarker(out.output).output;
          if (args.filter) {
            let re: RegExp;
            try {
              re = new RegExp(args.filter);
            } catch {
              return errorResult('filter is not a valid regular expression');
            }
            text = text
              .split('\n')
              .filter((l) => re.test(l))
              .join('\n');
          }
          const status = out.running ? 'running' : `exited with code ${out.exitCode ?? '?'}`;
          return textResult(`<status>${status}</status>\n${clipOutput(text) || '(no new output)'}`);
        })(),
      { annotations: { readOnlyHint: true } },
    ),
    tool(
      'bash_kill',
      'Kill a background command started with mcp__pc__bash.',
      {
        shell_id: z.string().min(1).max(64).optional(),
        bash_id: z.string().min(1).max(64).optional(),
        id: z.string().min(1).max(64).optional(),
      },
      (args) =>
        seated('bash_kill', async (pcId) => {
          const jobId = args.shell_id ?? args.bash_id ?? args.id;
          if (!jobId) return errorResult('Give shell_id.');
          const n = await host.pcs.kill(pcId, { jobId });
          return textResult(n > 0 ? `Killed ${jobId}.` : `${jobId} was not running.`);
        })(),
    ),
  );

  // --- Files ---------------------------------------------------------------------------------------------------
  push(
    tool(
      'read',
      'Read a text file inside the PC. Output uses cat -n line numbering. Use offset/limit for long files.',
      {
        file_path: z.string().min(1).describe('The absolute path to the file to read'),
        offset: z.number().int().min(0).optional().describe('Line number to start reading from'),
        limit: z.number().int().min(1).optional().describe('Number of lines to read'),
        pages: z.string().optional().describe('Page range for PDF files (not supported inside PCs)'),
      },
      async (args) => {
        if (host.plans.isPlanPath(args.file_path)) {
          const file = host.plans.read(args.file_path);
          if (!file) return errorResult(`File does not exist: ${args.file_path}`);
          return textResult(catN(file.text, 1) || '(empty file)');
        }
        return seated('read', async (pcId) => {
          const path = await absolute(pcId, args.file_path);
          const res = await host.pcs.readFile(pcId, {
            path,
            offset: args.offset && args.offset > 0 ? args.offset : undefined,
            limit: args.limit ?? READ_DEFAULT_LIMIT,
          });
          if (res.totalLines === 0) return textResult('(empty file)');
          const body = catN(res.content, res.startLine);
          const more = res.truncated ? `\n… (file has ${res.totalLines} lines; read more with offset)` : '';
          return textResult(`${body}${more}`);
        })();
      },
      { annotations: { readOnlyHint: true } },
    ),
    tool(
      'write',
      'Write a file inside the PC (creates parent directories, replaces an existing file).',
      {
        file_path: z.string().min(1).describe('The absolute path to the file to write'),
        content: z.string().describe('The content to write'),
      },
      async (args) => {
        if (host.plans.isPlanPath(args.file_path)) {
          host.plans.write(args.file_path, args.content);
          return textResult(`File created successfully at: ${args.file_path}`);
        }
        return seated('write', async (pcId) => {
          const path = await absolute(pcId, args.file_path);
          await host.pcs.writeFile(pcId, path, args.content);
          return textResult(`File created successfully at: ${path}`);
        })();
      },
    ),
    tool(
      'edit',
      'Replace an exact string in a file inside the PC. old_string must match exactly once unless replace_all.',
      {
        file_path: z.string().min(1).describe('The absolute path to the file to modify'),
        old_string: z.string().describe('The text to replace'),
        new_string: z.string().describe('The text to replace it with'),
        replace_all: z.boolean().optional().describe('Replace every occurrence'),
      },
      async (args) => {
        if (args.old_string === args.new_string)
          return errorResult('old_string and new_string are the same.');
        if (host.plans.isPlanPath(args.file_path)) {
          const res = host.plans.edit(
            args.file_path,
            args.old_string,
            args.new_string,
            args.replace_all === true,
          );
          return res.ok
            ? textResult(`The file ${args.file_path} has been updated.`)
            : errorResult(res.message);
        }
        return seated('edit', async (pcId) => {
          const path = await absolute(pcId, args.file_path);
          try {
            const n = await host.pcs.editFile(pcId, {
              path,
              oldString: args.old_string,
              newString: args.new_string,
              replaceAll: args.replace_all === true,
            });
            return textResult(
              args.replace_all
                ? `The file ${path} has been updated (${n} replacements).`
                : `The file ${path} has been updated.`,
            );
          } catch (err) {
            if (isApiError(err, PC_ERROR_CODES.EDIT_NOT_FOUND))
              return errorResult(`String to replace not found in file: ${path}`);
            if (isApiError(err, PC_ERROR_CODES.EDIT_AMBIGUOUS)) {
              return errorResult(`${err.message}. Give more context in old_string, or set replace_all.`);
            }
            if (isApiError(err, PC_ERROR_CODES.NOT_FOUND)) return errorResult(`File does not exist: ${path}`);
            throw err;
          }
        })();
      },
    ),
    tool(
      'glob',
      'Find files by glob pattern inside the PC (e.g. "**/*.ts"), newest first.',
      {
        pattern: z.string().min(1).describe('The glob pattern'),
        path: z.string().optional().describe('Directory to search (default: the working directory)'),
      },
      (args) =>
        seated('glob', async (pcId) => {
          const path = args.path ? await absolute(pcId, args.path) : await cwdOf(pcId);
          const res = await host.pcs.glob(pcId, { pattern: args.pattern, path });
          if (res.paths.length === 0) return textResult('No files found');
          return textResult(`${res.paths.join('\n')}${res.truncated ? '\n(results truncated)' : ''}`);
        })(),
      { annotations: { readOnlyHint: true } },
    ),
    tool(
      'grep',
      'Search file contents with ripgrep inside the PC.',
      {
        pattern: z.string().min(1).describe('The regular expression to search for'),
        path: z.string().optional(),
        glob: z.string().optional(),
        type: z.string().optional(),
        output_mode: z.enum(['content', 'files_with_matches', 'count']).optional(),
        '-i': z.boolean().optional(),
        '-n': z.boolean().optional(),
        '-A': z.number().int().min(0).optional(),
        '-B': z.number().int().min(0).optional(),
        '-C': z.number().int().min(0).optional(),
        context: z.number().int().min(0).optional(),
        '-o': z.boolean().optional(),
        multiline: z.boolean().optional(),
        head_limit: z.number().int().min(0).optional(),
        offset: z.number().int().min(0).optional(),
      },
      (args) =>
        seated('grep', async (pcId) => {
          const path = args.path ? await absolute(pcId, args.path) : await cwdOf(pcId);
          const around = args['-C'] ?? args.context;
          const res = await host.pcs.grep(pcId, {
            pattern: args.pattern,
            path,
            glob: args.glob,
            type: args.type,
            outputMode: args.output_mode ?? 'files_with_matches',
            caseInsensitive: args['-i'],
            lineNumbers: args['-n'] ?? true,
            before: args['-B'] ?? around,
            after: args['-A'] ?? around,
            multiline: args.multiline,
            headLimit: args.head_limit,
          });
          let out = res.output;
          if (args.offset) out = out.split('\n').slice(args.offset).join('\n');
          if (out.trim().length === 0) return textResult('No matches found');
          return textResult(`${clipOutput(out)}${res.truncated ? '\n(results truncated)' : ''}`);
        })(),
      { annotations: { readOnlyHint: true } },
    ),
  );

  // --- Screen ----------------------------------------------------------------------------------------------------
  const Coord = z.number().int().min(0).max(16_384);
  const Button = z.enum(['left', 'right', 'middle']).optional();
  push(
    tool(
      'screenshot',
      'See the PC screen (an image). Coordinates in the image are screen pixels.',
      { max_dim: z.number().int().min(320).max(2560).optional() },
      (args) =>
        seated('screenshot', async (pcId) => {
          const shot = await host.pcs.screenshot(pcId, { maxDim: args.max_dim ?? 1280 });
          return {
            content: [
              { type: 'image', data: Buffer.from(shot.data).toString('base64'), mimeType: shot.mime },
              { type: 'text', text: `${shot.w}x${shot.h}` },
            ],
          };
        })(),
      { annotations: { readOnlyHint: true } },
    ),
    tool('click', 'Click at screen pixel x,y.', { x: Coord, y: Coord, button: Button }, (args) =>
      seated('click', async (pcId) => {
        await host.pcs.pointer(pcId, { action: 'click', x: args.x, y: args.y, button: args.button });
        return textResult(`Clicked ${args.x},${args.y}.`);
      })(),
    ),
    tool('double_click', 'Double-click at screen pixel x,y.', { x: Coord, y: Coord }, (args) =>
      seated('double_click', async (pcId) => {
        await host.pcs.pointer(pcId, { action: 'double_click', x: args.x, y: args.y });
        return textResult(`Double-clicked ${args.x},${args.y}.`);
      })(),
    ),
    tool('right_click', 'Right-click at screen pixel x,y.', { x: Coord, y: Coord }, (args) =>
      seated('right_click', async (pcId) => {
        await host.pcs.pointer(pcId, { action: 'right_click', x: args.x, y: args.y });
        return textResult(`Right-clicked ${args.x},${args.y}.`);
      })(),
    ),
    tool('move', 'Move the mouse to screen pixel x,y.', { x: Coord, y: Coord }, (args) =>
      seated('move', async (pcId) => {
        await host.pcs.pointer(pcId, { action: 'move', x: args.x, y: args.y });
        return textResult(`Moved to ${args.x},${args.y}.`);
      })(),
    ),
    tool(
      'drag',
      'Drag with the left button from x,y to to_x,to_y.',
      { x: Coord, y: Coord, to_x: Coord, to_y: Coord },
      (args) =>
        seated('drag', async (pcId) => {
          await host.pcs.pointer(pcId, {
            action: 'drag',
            x: args.x,
            y: args.y,
            toX: args.to_x,
            toY: args.to_y,
          });
          return textResult(`Dragged to ${args.to_x},${args.to_y}.`);
        })(),
    ),
    tool(
      'scroll',
      'Scroll at x,y: dy > 0 scrolls down, dx > 0 scrolls right (in notches).',
      {
        x: Coord,
        y: Coord,
        dx: z.number().int().min(-50).max(50).optional(),
        dy: z.number().int().min(-50).max(50).optional(),
      },
      (args) =>
        seated('scroll', async (pcId) => {
          await host.pcs.pointer(pcId, {
            action: 'scroll',
            x: args.x,
            y: args.y,
            dx: args.dx ?? 0,
            dy: args.dy ?? 3,
          });
          return textResult('Scrolled.');
        })(),
    ),
    tool(
      'type',
      'Type text with the keyboard (layout independent).',
      { text: z.string().min(1).max(10_000) },
      (args) =>
        seated('type', async (pcId) => {
          await host.pcs.type(pcId, args.text);
          return textResult(`Typed ${args.text.length} characters.`);
        })(),
    ),
    tool(
      'key',
      'Press a key or a chord: "Enter", "ctrl+c", "ctrl+shift+t", or a list of keys.',
      { keys: z.union([z.string().min(1).max(64), z.array(z.string().min(1).max(32)).min(1).max(6)]) },
      (args) =>
        seated('key', async (pcId) => {
          const keys = parseKeys(args.keys);
          if (keys.length === 0) return errorResult('No keys given.');
          await host.pcs.keyboard(pcId, { action: 'press', keys });
          return textResult(`Pressed ${keys.join('+')}.`);
        })(),
    ),
    tool(
      'clipboard',
      'Read the PC clipboard, or set it with text.',
      { action: z.enum(['get', 'set']).optional(), text: z.string().max(100_000).optional() },
      (args) =>
        seated('clipboard', async (pcId) => {
          if (args.action === 'set' || args.text !== undefined) {
            if (args.text === undefined) return errorResult('Give text to set.');
            await host.pcs.clipboardSet(pcId, args.text);
            return textResult('Clipboard set.');
          }
          const text = await host.pcs.clipboardGet(pcId);
          return textResult(text.length > 0 ? clipOutput(text) : '(clipboard is empty)');
        })(),
    ),
  );

  // --- About the PC ----------------------------------------------------------------------------------------------
  push(
    tool(
      'info',
      'About this PC: OS, screen, user, Vault folders (same path as on the host) and your working directory.',
      {},
      () =>
        seated('info', async (pcId) => {
          infos.delete(pcId);
          const i = await info(pcId);
          const mounts = i.mounts.map((m) => `${m.hostPath} (${m.mode})`).join(', ') || 'none';
          return textResult(
            `${i.pcId}: ${i.type} (${i.os}), ${i.status}, screen ${i.screen.w}x${i.screen.h}, user ${i.user}, home ${i.home}\nVault: ${mounts}\nCodex: ${i.codexPath ?? 'not mounted'}\ncwd: ${await cwdOf(pcId)}`,
          );
        })(),
      { annotations: { readOnlyHint: true } },
    ),
    tool(
      'handoff_note',
      'Leave a note for whoever works at this PC (or on a Vault folder) next: what you did, what is left. It is shown in their kickoff.',
      { text: z.string().min(1).max(1500), mount: z.string().min(1).max(1024).optional() },
      (args) =>
        seated('handoff_note', async (pcId) => {
          const target = args.mount ?? pcId;
          if (args.mount) {
            const i = await info(pcId);
            if (!i.mounts.some((m) => m.hostPath === args.mount)) {
              throw new ApiError('NOT_FOUND', `${args.mount} is not a Vault folder of ${pcId}`);
            }
          }
          await host.handoffs.add(target, {
            at: Date.now(),
            author: `${host.authorName()} (agent)`,
            text: args.text,
          });
          return textResult(`Note saved for ${target}.`);
        })(),
    ),
  );

  return defs;
}

/** The in-process `pc` server (never swapped; `alwaysLoad`, 600 s tool timeout). */
export function createPcServer(host: PcHost): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: 'pc',
    version: '1.0.0',
    alwaysLoad: true,
    timeout: MCP_TOOL_TIMEOUT_MS,
    tools: pcToolDefinitions(host),
  });
}

export { PC_TOOLS };
