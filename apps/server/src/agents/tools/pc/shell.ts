/**
 * `bash` and `task_stop` (PC tools V2 §5.3, D5): Claude Code 2.1.293's Bash and TaskStop, inside the PC. The working
 * directory persists (the `__MV_PWD__` marker); output is head and tail within 30,000 characters; a non-zero exit is
 * an error starting "Exit code N" (except the exit codes some commands use for "nothing found"); a command that
 * overruns its timeout moves to the background; background commands tee into `~/.mv/jobs/<id>.out` (readable with
 * `read`), end with a `<task-notification>` (the brain sends it) and stop after their lifetime.
 */

import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { isApiError } from '../../../contracts/common.js';
import { PC_ERROR_CODES, PC_LIMITS } from '../../../contracts/PcApi.js';
import { type CallToolResult, errorResult, textResult } from '../results.js';
import { type Def, defs, tool } from './common.js';
import type { PcToolContext } from './context.js';
import {
  BASH_NO_OUTPUT,
  bashBackground,
  bashCut,
  bashExit,
  bashMovedToBackground,
  interpretExit,
  taskNotRunning,
  taskStopped,
} from './formats.js';

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

/** Output within the cap: 40% head and 60% tail around a "lines truncated" note (the guest's capture cut already). */
export function clipOutput(text: string, max: number = PC_LIMITS.maxOutputChars): string {
  if (text.length <= max) return text;
  const head = text.slice(0, Math.floor(max * 0.4));
  const tail = text.slice(text.length - Math.floor(max * 0.6));
  const omitted = text.slice(head.length, text.length - tail.length).split('\n').length;
  return bashCut(head, omitted, tail);
}

/** The guest's own head/tail marker (OutputCapture) in the built-in's words. */
function rewordCaptureCut(text: string): string {
  return text.replace(
    /\n… \((\d+) characters omitted\) …\n/,
    (_m, n: string) => `\n\n... [${n} characters truncated] ...\n\n`,
  );
}

/** A short label of a command for notifications (its description, else its first line). */
function labelOf(command: string, description: string | undefined): string {
  const d = (description ?? '').trim();
  if (d) return d.length > 120 ? `${d.slice(0, 119)}…` : d;
  const first = command.trim().split('\n')[0] ?? '';
  return first.length > 120 ? `${first.slice(0, 119)}…` : first;
}

export function shellTools(ctx: PcToolContext): Def[] {
  return defs(
    tool(
      'bash',
      `Run a bash command inside the PC you sit at (as the PC user; not on any other machine). The working directory persists between calls; the shell environment does not.

- Quote paths that contain spaces. Chain dependent commands with &&; use ; only when later ones should run anyway.
- There is no terminal: interactive programs (vim, less, git rebase -i, a REPL, a password prompt) hang until the timeout. Use non-interactive flags (-y, --no-edit, git --no-pager).
- Prefer read, edit, write, glob and grep over cat/sed/echo>/find/grep: they are exact and cheaper.
- timeout is in ms (default 120000, max 600000). A command that overruns is moved to the background, not lost.
- run_in_background: true returns at once with an ID and an output file you can read with read; you are notified when it exits. Use it for servers, watchers and long builds. timeout then caps its life (default 30 min, max 2 h). Stop one with task_stop.
- Output over 30000 characters is cut in the middle. A non-zero exit is an error starting "Exit code N".
- sudo works without a password; changes outside your home and the Vault are lost when the PC is recreated.`,
      {
        command: z.string().min(1).describe('The command to execute'),
        timeout: z.number().optional().describe('Optional timeout in milliseconds (max 600000)'),
        description: z
          .string()
          .optional()
          .describe('Clear, concise description of what this command does in active voice (5-10 words)'),
        run_in_background: z
          .boolean()
          .optional()
          .describe('Set to true to run this command in the background. Use Read to read the output later.'),
        dangerouslyDisableSandbox: z
          .boolean()
          .optional()
          .describe('Ignored: commands always run inside the PC'),
      },
      (args, extra) =>
        ctx.run('bash', extra, async (seat) => {
          const cwd = await ctx.cwdOf(seat.pcId);
          const background = args.run_in_background === true;
          const requested =
            typeof args.timeout === 'number' && Number.isFinite(args.timeout) ? args.timeout : undefined;
          const timeoutMs = Math.min(
            PC_LIMITS.maxTimeoutMs,
            Math.max(1_000, requested ?? PC_LIMITS.defaultTimeoutMs),
          );
          const lifetimeMs = Math.min(
            PC_LIMITS.maxJobLifetimeMs,
            Math.max(
              1_000,
              background && requested !== undefined ? requested : PC_LIMITS.defaultJobLifetimeMs,
            ),
          );
          const jobId = `b${randomBytes(4).toString('hex')}`;
          const res = await ctx.host.pcs.exec(seat.pcId, {
            command: wrapBash(args.command),
            cwd,
            env: { MV_CWD: cwd },
            timeoutMs,
            background,
            tag: `${ctx.host.agentId}:${seat.epoch}`,
            onTimeout: 'background',
            lifetimeMs,
            jobId,
            outputFile: true,
          });
          if (res.kind === 'background') {
            const outputPath =
              res.outputPath ?? `${(await ctx.info(seat.pcId)).home}/.mv/jobs/${res.jobId}.out`;
            ctx.jobs.add({
              pcId: seat.pcId,
              jobId: res.jobId,
              epoch: seat.epoch,
              command: args.command,
              description: labelOf(args.command, args.description),
              ...(seat.toolUseId ? { toolUseId: seat.toolUseId } : {}),
              outputPath,
              startedAt: Date.now(),
            });
            if (res.timedOutAfterMs !== undefined) {
              return textResult(
                bashMovedToBackground(
                  res.timedOutAfterMs,
                  res.jobId,
                  outputPath,
                  res.lifetimeMs ?? lifetimeMs,
                ),
              );
            }
            return textResult(bashBackground(res.jobId, outputPath));
          }
          const { output, cwd: newCwd } = stripPwdMarker(res.output);
          if (newCwd) ctx.setCwd(seat.pcId, newCwd);
          let text = rewordCaptureCut(output.replace(/\s+$/, ''));
          if (res.truncated && !/\.\.\. \[\d+ (lines|characters) truncated\] \.\.\./.test(text)) {
            text = `${text}\n\n... [output truncated] ...`;
          }
          const body = clipOutput(text);
          if (res.exitCode === 0) return textResult(body || BASH_NO_OUTPUT);
          const meaning = interpretExit(args.command, res.exitCode);
          if (meaning) return textResult(body || meaning);
          return errorResult(bashExit(res.exitCode, body));
        }),
    ),
    tool(
      'task_stop',
      'Stop a background command started with bash run_in_background (or moved there after its timeout).',
      {
        task_id: z.string().max(64).optional().describe('The ID of the background task to stop'),
        shell_id: z.string().max(64).optional().describe('Deprecated: use task_id instead'),
      },
      (args, extra) =>
        ctx.run('task_stop', extra, async (seat): Promise<CallToolResult> => {
          const id = (args.task_id ?? args.shell_id ?? '').trim();
          if (!id) return errorResult('Give task_id.');
          const job = ctx.jobs.get(seat.pcId, id);
          if (!job) return errorResult(taskNotRunning(id, seat.pcId));
          let n: number;
          try {
            n = await ctx.host.pcs.kill(seat.pcId, { jobId: id });
          } catch (err) {
            if (isApiError(err, PC_ERROR_CODES.UNKNOWN_JOB))
              return errorResult(taskNotRunning(id, seat.pcId));
            throw err;
          }
          if (n === 0) return errorResult(taskNotRunning(id, seat.pcId));
          return textResult(taskStopped(id, job.command.split('\n')[0] ?? job.command));
        }),
    ),
  );
}
