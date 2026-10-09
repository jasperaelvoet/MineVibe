/**
 * Every text the `pc` tools answer with (PC tools V2, D5). The shell and file tools answer exactly as Claude Code
 * 2.1.293's built-ins do (strings taken from the bundled `claude` binary and checked against its own Read, Edit, Write
 * and Bash), so models trained on those tools read them as they expect; the computer tools use the trained
 * computer-use toolset's texts where it has one, and short teaching errors otherwise. Golden tests pin them.
 */

// ------------------------------------------------------------------------------------------------- Read

export const READ_EMPTY =
  '<system-reminder>Warning: the file exists but the contents are empty.</system-reminder>';

export function readShorterThanOffset(offset: number, totalLines: number): string {
  return `<system-reminder>Warning: the file exists but is shorter than the provided offset (${offset}). The file has ${totalLines} lines.</system-reminder>`;
}

export function readMissing(cwd: string): string {
  return `File does not exist. Note: your current working directory is ${cwd}.`;
}

export const READ_UNCHANGED =
  'Wasted call — file unchanged since your last Read. Refer to that earlier tool_result instead.';

export const READ_DIRECTORY = (path: string) =>
  `EISDIR: illegal operation on a directory, read '${path}'. List it with bash (ls) or glob instead.`;

/** A view cut short by the result size cap (Claude Code's token-capped Read). */
export function readPartialBySize(
  path: string,
  first: number,
  last: number,
  totalLines: number,
  tokens: number,
  cap: number,
): string {
  const n = last - first + 1;
  return `[Truncated: PARTIAL view — ${path}: showing lines ${first}-${last} of ${totalLines} total (${tokens} tokens, cap ${cap}). Call Read with offset=${last + 1} limit=${n} for the next page, or Grep to find a specific section. Do NOT answer from this page alone if the answer may be further in the file.]`;
}

/** A view that stops before the end of the file (the line limit). */
export function readPartialByLines(path: string, shown: number, totalLines: number): string {
  return `[Truncated: PARTIAL view — ${path}: showing ${shown} of ${totalLines} lines. Call Read with offset/limit to page through. Do NOT answer from this page alone if the answer may be further in the file.]`;
}

// ------------------------------------------------------------------------------------------------- Edit, Write

export const editUpdated = (path: string) => `The file ${path} has been updated successfully.`;
export const editUpdatedAll = (path: string) =>
  `The file ${path} has been updated. All occurrences were successfully replaced.`;
export const editNotFound = (oldString: string) =>
  `String to replace not found in file.\nString: ${oldString}`;
export const editAmbiguous = (count: number, oldString: string) =>
  `Found ${count} matches of the string to replace, but replace_all is false. To replace all occurrences, set replace_all to true. To replace only one occurrence, please provide more context to uniquely identify the instance.\nString: ${oldString}`;
export const EDIT_SAME = 'No changes to make: old_string and new_string are exactly the same.';
export const EDIT_CREATE_EXISTS = 'Cannot create new file - file already exists.';
export const NOT_READ_YET = 'File has not been read yet. Read it first before writing to it.';
export const MODIFIED_SINCE_READ =
  'File has been modified since read, either by the user or by a linter. Read it again before attempting to write it.';

const STATE_CURRENT = ' (file state is current in your context — no need to Read it back)';
export const writeCreated = (path: string) => `File created successfully at: ${path}${STATE_CURRENT}`;
export const writeUpdated = (path: string) =>
  `The file ${path} has been updated successfully.${STATE_CURRENT}`;

// ------------------------------------------------------------------------------------------------- Grep, Glob

function pagination(limit: number | undefined, offset: number): string {
  const parts: string[] = [];
  if (limit !== undefined) parts.push(`limit: ${limit}`);
  if (offset) parts.push(`offset: ${offset}`);
  return parts.join(', ');
}

/** Grep `content` mode. `limit` is set only when the head limit cut results. */
export function grepContent(text: string, limit: number | undefined, offset: number, total: number): string {
  const page = pagination(limit, offset);
  const body = text || (offset && total > 0 ? 'No entries at this offset' : 'No matches found');
  return page ? `${body}\n\n[Showing results with pagination = ${page}]` : body;
}

/** Grep `count` mode. */
export function grepCount(
  text: string,
  occurrences: number,
  files: number,
  limit: number | undefined,
  offset: number,
): string {
  const page = pagination(limit, offset);
  const body = text || (occurrences > 0 ? 'No entries at this offset' : 'No matches found');
  return `${body}\n\nFound ${occurrences} total ${occurrences === 1 ? 'occurrence' : 'occurrences'} across ${files} ${files === 1 ? 'file' : 'files'}.${page ? ` with pagination = ${page}` : ''}`;
}

/** Grep `files_with_matches` mode. */
export function grepFiles(
  paths: readonly string[],
  limit: number | undefined,
  offset: number,
  total: number,
): string {
  const page = pagination(limit, offset);
  if (paths.length === 0) {
    return offset && total > 0
      ? `No entries at this offset. [Showing results with pagination = ${page}]`
      : 'No files found';
  }
  return `Found ${paths.length} ${paths.length === 1 ? 'file' : 'files'}${page ? ` ${page}` : ''}\n${paths.join('\n')}`;
}

export const GLOB_NONE = 'No files found';

/** The line after a cut glob listing. */
export function globTruncated(
  shown: number,
  total: number | undefined,
  complete: boolean | undefined,
): string {
  if (total === undefined) return '(Results are truncated. Consider using a more specific path or pattern.)';
  if (complete) {
    return `(Showing ${shown} of ${total} matching files; ${total - shown} more are not listed. Narrow the pattern or path to see the rest.)`;
  }
  return `(Showing the first ${shown} files; there are more than ${total} matches. Narrow the pattern or path to see the rest.)`;
}

export const pathMissing = (path: string, cwd: string) =>
  `Path does not exist: ${path}. Note: your current working directory is ${cwd}.`;
export const dirMissing = (path: string, cwd: string) =>
  `Directory does not exist: ${path}. Note: your current working directory is ${cwd}.`;

// ------------------------------------------------------------------------------------------------- Bash

export const BASH_NO_OUTPUT = '(No output)';

export function bashExit(code: number, output: string): string {
  return output.length > 0 ? `Exit code ${code}\n${output}` : `Exit code ${code}`;
}

/** Claude Code's duration format ("30m", "2h", "1h 30m", "45s"). */
export function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const parts: string[] = [];
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  if (sec || parts.length === 0) parts.push(`${sec}s`);
  return parts.join(' ');
}

export function bashBackground(id: string, outputPath: string): string {
  return `Command running in background with ID: ${id}. Output is being written to: ${outputPath}. You will be notified when it completes. To check interim output, use Read on that file path.`;
}

export function bashMovedToBackground(
  timeoutMs: number,
  id: string,
  outputPath: string,
  lifetimeMs: number,
): string {
  return `Command did not complete within its ${Math.max(1, Math.round(timeoutMs / 1000))}s timeout and was moved to the background (ID: ${id}). Output is being written to: ${outputPath}. You will be notified when it completes. If it is still running after ${formatDuration(lifetimeMs)} in the background, it will be stopped and you will be notified. To check interim output, use Read on that file path.`;
}

/** Output over the cap: head and tail with the middle cut (the built-in keeps the head). */
export function bashCut(head: string, omittedLines: number, tail: string): string {
  return `${head}\n\n... [${omittedLines} lines truncated] ...\n\n${tail}`;
}

/** A non-zero exit some commands use for "nothing found" (Claude Code's exit-code interpretation). */
export function interpretExit(command: string, code: number): string | null {
  if (code !== 1) return null;
  const last = lastCommand(command);
  const words = last.split(/\s+/).filter(Boolean);
  const name = (words[0] ?? '').replace(/^.*\//, '');
  if (name === 'git') {
    const sub = words.slice(1).find((w) => !w.startsWith('-'));
    if (sub === 'grep') return 'No matches found';
    if (sub === 'diff') return 'Files differ';
    return null;
  }
  switch (name) {
    case 'grep':
    case 'rg':
    case 'egrep':
    case 'fgrep':
      return 'No matches found';
    case 'find':
      return 'Some directories were inaccessible';
    case 'diff':
      return 'Files differ';
    case 'test':
    case '[':
      return 'Condition is false';
    default:
      return null;
  }
}

/** The last simple command of a command line (after the last `|`, `&&`, `||` or `;` outside quotes). */
export function lastCommand(command: string): string {
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < command.length; i++) {
    const c = command[i] as string;
    if (quote) {
      if (c === '\\' && quote === '"') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === '\\') i++;
    else if (c === '|' || c === ';' || c === '\n') start = i + 1;
    else if (c === '&') {
      // `2>&1` and `&>` are redirections, not command separators.
      const prev = command[i - 1];
      if (prev === '>' || prev === '<' || command[i + 1] === '>') continue;
      start = i + 1;
    }
  }
  return command.slice(start).trim();
}

export function taskStopped(id: string, command: string): string {
  return `Successfully stopped task: ${id} (${command})`;
}

export function taskNotRunning(id: string, pcId: string): string {
  return `No background command with ID ${id} is running on ${pcId} for this seat: it has already finished or been stopped, or it was never yours.`;
}

export interface TaskNotification {
  readonly taskId: string;
  readonly toolUseId?: string | undefined;
  readonly outputFile?: string | undefined;
  readonly status: 'completed' | 'failed' | 'killed';
  readonly summary: string;
}

/** Claude Code 2.x's `<task-notification>` block. */
export function taskNotification(n: TaskNotification): string {
  return [
    '<task-notification>',
    `<task-id>${n.taskId}</task-id>`,
    ...(n.toolUseId ? [`<tool-use-id>${n.toolUseId}</tool-use-id>`] : []),
    ...(n.outputFile ? [`<output-file>${n.outputFile}</output-file>`] : []),
    `<status>${n.status}</status>`,
    `<summary>${n.summary}</summary>`,
    '</task-notification>',
  ].join('\n');
}

export function jobSummary(
  description: string,
  outcome: { status: 'completed' | 'failed' | 'killed'; exitCode: number | null; why?: string },
): string {
  const d = `Background command "${description}"`;
  if (outcome.status === 'completed') return `${d} completed (exit code 0)`;
  if (outcome.status === 'failed') return `${d} failed with exit code ${outcome.exitCode ?? '?'}`;
  return `${d} was stopped${outcome.why ? ` (${outcome.why})` : ''}`;
}

// ------------------------------------------------------------------------------------------------- computer

/** The trained text of a batch call that did not run. */
export const BATCH_HALT = 'Not executed: an earlier computer action in this turn failed.';
export const SCREEN_UNCHANGED = '(Screen unchanged since your last screenshot.)';
export const OK = 'OK';

export const outOfBounds = (x: number, y: number, w: number, h: number) =>
  `Coordinate (${x}, ${y}) is outside the screen (${w}x${h}). Coordinates are pixels of the latest screenshot, origin top-left.`;
export const badKey = (key: string) =>
  `Unknown key "${key}". Use xdotool names joined by +, e.g. "ctrl+s", "Return", "alt+Tab", "Page_Down".`;
export const staleRef = (ref: string, title: string) =>
  `${ref} is from an older view of "${title}" (the window changed). Call ui find or ui tree again.`;
export const unknownRef = (ref: string) => `No element ${ref}. Refs come from ui find/tree in this seat.`;
export const a11yEmpty = (window: string, why: string) =>
  `"${window}" exposes no accessibility tree (${why}). Use screenshot and zoom with coordinates.`;
export const windowNotFound = (query: string, open: readonly string[]) =>
  `No window matches "${query}". Open windows: ${open.length > 0 ? open.map((t) => `"${t}"`).join(', ') : 'none'}.`;
export const openFailed = (target: string, apps: string) =>
  `Nothing opens "${target}".${apps ? ` Installed apps include: ${apps}` : ''}`;
export const playerTookOver = (player: string, pcId: string) =>
  `${player} took over ${pcId}; your input was not sent. Wait or stand up.`;
export const invalidZoom = (w: number, h: number) =>
  `region must be [x0, y0, x1, y1] with x1 > x0 and y1 > y0 inside ${w}x${h}.`;
export const NOT_SEATED =
  'Not seated at a PC (or your seat changed). Walk to a PC and call mcp__mc__sit_at_pc.';
export const MIRROR_KEEP = '(MineVibe shell mirror; leave it open)';
