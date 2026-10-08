/**
 * `read`, `write`, `edit`, `glob`, `grep` (PC tools V2 §5.3, D5, D7): Claude Code 2.1.293's file tools, inside the PC
 * (aliased to Read, Write, Edit, Glob, Grep). Lines are numbered `<n>\t<line>` (a final newline ends in one more,
 * empty line); a view too large for one result is cut and says how to page on; an unchanged re-read costs one line.
 * write and edit keep read-state: an existing file must have been read in this seat and must not have changed since.
 * Files under `~/.claude/plans/` are captured in Node memory (PlanCapture) and never reach the PC.
 */

import { z } from 'zod';
import { isApiError } from '../../../contracts/common.js';
import { PC_ERROR_CODES, PC_LIMITS } from '../../../contracts/PcApi.js';
import { shellQuote } from '../../../pcs/guest.js';
import { type CallToolResult, errorResult, textResult } from '../results.js';
import { type Def, defs, tool } from './common.js';
import type { PcToolContext, Seat } from './context.js';
import {
  dirMissing,
  EDIT_CREATE_EXISTS,
  EDIT_SAME,
  editAmbiguous,
  editNotFound,
  editUpdated,
  editUpdatedAll,
  GLOB_NONE,
  globTruncated,
  grepContent,
  grepCount,
  grepFiles,
  MODIFIED_SINCE_READ,
  NOT_READ_YET,
  pathMissing,
  READ_DIRECTORY,
  READ_EMPTY,
  READ_UNCHANGED,
  readMissing,
  readPartialByLines,
  readPartialBySize,
  readShorterThanOffset,
  writeCreated,
  writeUpdated,
} from './formats.js';
import { unchanged } from './readState.js';

/** Read's defaults (the built-in's). */
export const READ_DEFAULT_LIMIT = 2000;
export const READ_LINE_MAX = 2000;
/** The most text one read returns (D7), and the token cap it is reported as (characters / 4). */
export const READ_MAX_CHARS = 56_000;
export const READ_TOKEN_CAP = READ_MAX_CHARS / 4;
/** Grep's default head limit (the built-in's). */
export const GREP_DEFAULT_HEAD_LIMIT = 250;

const IMAGE_TYPES: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};
/** The largest image read returns (the API's per-image limit). */
const IMAGE_MAX_BYTES = 5 * 1024 * 1024;

/** `<n>\t<line>` numbering, as the built-in Read answers (unpadded; long lines cut). */
export function numberLines(lines: readonly string[], startLine: number): string[] {
  return lines.map((line, i) => {
    const l = line.endsWith('\r') ? line.slice(0, -1) : line;
    const clipped = l.length > READ_LINE_MAX ? `${l.slice(0, READ_LINE_MAX)}… (line truncated)` : l;
    return `${startLine + i}\t${clipped}`;
  });
}

/** Kept for callers of V1's helper: the whole text numbered from `startLine`. */
export function catN(content: string, startLine: number): string {
  if (content.length === 0) return '';
  return numberLines(content.split('\n'), startLine).join('\n');
}

const parsePages = (pages: string | undefined): { first: number; last: number } | null => {
  if (!pages) return null;
  const m = /^\s*(\d{1,6})\s*(?:-\s*(\d{1,6})?)?\s*$/.exec(pages);
  if (!m) return null;
  const first = Number(m[1]);
  const last = m[2] ? Number(m[2]) : pages.includes('-') ? first + 19 : first;
  if (first < 1 || last < first) return null;
  return { first, last: Math.min(last, first + 19) };
};

async function readPdf(ctx: PcToolContext, seat: Seat, path: string, pages: string | undefined): Promise<CallToolResult> {
  const range = parsePages(pages) ?? { first: 1, last: 20 };
  const script = `command -v pdftotext >/dev/null 2>&1 || { echo "__MV_NO_PDFTOTEXT__"; exit 0; }
pdftotext -layout -f ${range.first} -l ${range.last} -- ${shellQuote(path)} - 2>&1`;
  const res = await ctx.host.pcs.exec(seat.pcId, {
    command: script,
    tag: `${ctx.host.agentId}:${seat.epoch}`,
    timeoutMs: 60_000,
  });
  if (res.kind !== 'done') return errorResult(`Reading ${path} did not finish.`);
  if (res.output.includes('__MV_NO_PDFTOTEXT__')) {
    return errorResult(
      `This PC has no PDF reader (pdftotext). Install it with bash: sudo apt-get install -y poppler-utils`,
    );
  }
  if (res.exitCode !== 0) return errorResult(res.output.trim() || `pdftotext failed (${res.exitCode})`);
  const lines = res.output.replace(/\f/g, '\n').split('\n');
  return textResult(`PDF pages ${range.first}-${range.last}:\n${numberLines(lines, 1).join('\n')}`);
}

async function readFile(
  ctx: PcToolContext,
  seat: Seat,
  args: { file_path: string; offset?: number | undefined; limit?: number | undefined; pages?: string | undefined },
): Promise<CallToolResult> {
  const { pcId } = seat;
  const path = await ctx.absolute(pcId, args.file_path);
  const st = await ctx.host.pcs.stat(pcId, path);
  if (!st.exists) return errorResult(readMissing(await ctx.cwdOf(pcId)));
  if (st.kind === 'dir') return errorResult(READ_DIRECTORY(path));
  const ext = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase() ?? '';
  const imageType = IMAGE_TYPES[ext];
  if (imageType) {
    if (st.size > IMAGE_MAX_BYTES) return errorResult(`${path} is ${st.size} bytes; images over 5 MB cannot be shown.`);
    const data = await ctx.host.pcs.readBytes(pcId, path, IMAGE_MAX_BYTES);
    ctx.readState.set(pcId, path, { mtimeMs: st.mtimeMs, size: st.size });
    return {
      content: [
        { type: 'text', text: path },
        { type: 'image', data: Buffer.from(data).toString('base64'), mimeType: imageType },
      ],
    };
  }
  if (ext === 'pdf') return readPdf(ctx, seat, path, args.pages);
  const offset = args.offset !== undefined && args.offset > 0 ? Math.floor(args.offset) : 1;
  const limit = args.limit !== undefined && args.limit > 0 ? Math.floor(args.limit) : READ_DEFAULT_LIMIT;
  const before = ctx.readState.get(pcId, path);
  if (before && before.offset === offset && before.limit === limit && unchanged(before, st)) {
    return textResult(READ_UNCHANGED);
  }
  const res = await ctx.host.pcs.readFile(pcId, { path, offset, limit });
  ctx.readState.set(pcId, path, { mtimeMs: st.mtimeMs, size: st.size, offset, limit });
  if (res.totalLines === 0) return textResult(READ_EMPTY);
  if (offset > res.totalLines) return textResult(readShorterThanOffset(offset, res.totalLines));
  const all = numberLines(res.content.split('\n'), res.startLine);
  // D7: a view too large for one result is cut at a line and says how to go on.
  const kept: string[] = [];
  let size = 0;
  for (const line of all) {
    if (size + line.length + 1 > READ_MAX_CHARS && kept.length > 0) break;
    kept.push(line);
    size += line.length + 1;
  }
  const last = res.startLine + kept.length - 1;
  if (kept.length < all.length) {
    const tokens = Math.round(all.reduce((n, l) => n + l.length + 1, 0) / 4);
    return textResult(
      `${kept.join('\n')}\n\n${readPartialBySize(path, res.startLine, last, res.totalLines, tokens, READ_TOKEN_CAP)}`,
    );
  }
  if (res.truncated && args.limit === undefined && last < res.totalLines) {
    return textResult(`${kept.join('\n')}\n\n${readPartialByLines(path, kept.length, res.totalLines)}`);
  }
  return textResult(kept.join('\n'));
}

/** The read-state check of a write or edit to an existing file: null when it may go ahead. */
function staleCheck(ctx: PcToolContext, pcId: string, path: string, st: { mtimeMs: number; size: number }): string | null {
  const seen = ctx.readState.get(pcId, path);
  if (!seen) return NOT_READ_YET;
  if (!unchanged(seen, st)) return MODIFIED_SINCE_READ;
  return null;
}

async function remember(ctx: PcToolContext, pcId: string, path: string): Promise<void> {
  const st = await ctx.host.pcs.stat(pcId, path).catch(() => null);
  if (st?.exists) ctx.readState.set(pcId, path, { mtimeMs: st.mtimeMs, size: st.size });
  else ctx.readState.delete(pcId, path);
}

async function writeFile(
  ctx: PcToolContext,
  seat: Seat,
  args: { file_path: string; content: string },
): Promise<CallToolResult> {
  const path = await ctx.absolute(seat.pcId, args.file_path);
  const st = await ctx.host.pcs.stat(seat.pcId, path);
  if (st.exists) {
    if (st.kind === 'dir') return errorResult(`${path} is a directory.`);
    const stale = staleCheck(ctx, seat.pcId, path, st);
    if (stale) return errorResult(stale);
  }
  await ctx.host.pcs.writeFile(seat.pcId, path, args.content);
  await remember(ctx, seat.pcId, path);
  return textResult(st.exists ? writeUpdated(path) : writeCreated(path));
}

async function editFile(
  ctx: PcToolContext,
  seat: Seat,
  args: { file_path: string; old_string: string; new_string: string; replace_all?: boolean | undefined },
): Promise<CallToolResult> {
  const path = await ctx.absolute(seat.pcId, args.file_path);
  const st = await ctx.host.pcs.stat(seat.pcId, path);
  if (args.old_string === '') {
    // An empty old_string creates the file (or fills an empty one).
    if (st.exists && st.size > 0) return errorResult(EDIT_CREATE_EXISTS);
    await ctx.host.pcs.writeFile(seat.pcId, path, args.new_string);
    await remember(ctx, seat.pcId, path);
    return textResult(editUpdated(path));
  }
  if (!st.exists) return errorResult(readMissing(await ctx.cwdOf(seat.pcId)));
  if (st.kind === 'dir') return errorResult(`${path} is a directory.`);
  const stale = staleCheck(ctx, seat.pcId, path, st);
  if (stale) return errorResult(stale);
  try {
    await ctx.host.pcs.editFile(seat.pcId, {
      path,
      oldString: args.old_string,
      newString: args.new_string,
      replaceAll: args.replace_all === true,
    });
  } catch (err) {
    if (isApiError(err, PC_ERROR_CODES.EDIT_NOT_FOUND)) return errorResult(editNotFound(args.old_string));
    if (isApiError(err, PC_ERROR_CODES.EDIT_AMBIGUOUS)) {
      const n = Number(/(\d+)/.exec(err.message)?.[1] ?? 2);
      return errorResult(editAmbiguous(n, args.old_string));
    }
    if (isApiError(err, PC_ERROR_CODES.NOT_FOUND)) return errorResult(readMissing(await ctx.cwdOf(seat.pcId)));
    if (isApiError(err, PC_ERROR_CODES.GUEST_ERROR) && /changed while it was being edited/.test(err.message)) {
      return errorResult(MODIFIED_SINCE_READ);
    }
    throw err;
  }
  await remember(ctx, seat.pcId, path);
  return textResult(args.replace_all ? editUpdatedAll(path) : editUpdated(path));
}

async function glob(
  ctx: PcToolContext,
  seat: Seat,
  args: { pattern: string; path?: string | undefined },
): Promise<CallToolResult> {
  const dir = args.path ? await ctx.absolute(seat.pcId, args.path) : await ctx.cwdOf(seat.pcId);
  let res: Awaited<ReturnType<typeof ctx.host.pcs.glob>>;
  try {
    res = await ctx.host.pcs.glob(seat.pcId, { pattern: args.pattern, path: dir });
  } catch (err) {
    if (isApiError(err, PC_ERROR_CODES.NOT_FOUND)) return errorResult(dirMissing(args.path ?? dir, await ctx.cwdOf(seat.pcId)));
    throw err;
  }
  if (res.paths.length === 0) return textResult(GLOB_NONE);
  const paths = await Promise.all(res.paths.map((p) => ctx.relative(seat.pcId, p)));
  const lines = [...paths];
  if (res.truncated) lines.push(globTruncated(paths.length, res.total, res.countIsComplete));
  return textResult(lines.join('\n'));
}

async function grep(
  ctx: PcToolContext,
  seat: Seat,
  args: {
    pattern: string;
    path?: string | undefined;
    glob?: string | undefined;
    type?: string | undefined;
    output_mode?: 'content' | 'files_with_matches' | 'count' | undefined;
    '-i'?: boolean | undefined;
    '-n'?: boolean | undefined;
    '-o'?: boolean | undefined;
    '-A'?: number | undefined;
    '-B'?: number | undefined;
    '-C'?: number | undefined;
    context?: number | undefined;
    multiline?: boolean | undefined;
    head_limit?: number | undefined;
    offset?: number | undefined;
  },
): Promise<CallToolResult> {
  const cwd = (await ctx.cwdOf(seat.pcId)).replace(/\/+$/, '');
  const path = args.path ? await ctx.absolute(seat.pcId, args.path) : cwd;
  const mode = args.output_mode ?? 'files_with_matches';
  const around = args.context ?? args['-C'];
  const offset = Math.max(0, Math.floor(args.offset ?? 0));
  const headLimit = args.head_limit === 0 ? undefined : Math.max(1, Math.floor(args.head_limit ?? GREP_DEFAULT_HEAD_LIMIT));
  let res: Awaited<ReturnType<typeof ctx.host.pcs.grep>>;
  try {
    res = await ctx.host.pcs.grep(seat.pcId, {
      pattern: args.pattern,
      path,
      glob: args.glob,
      type: args.type,
      outputMode: mode,
      caseInsensitive: args['-i'],
      lineNumbers: args['-n'] ?? true,
      onlyMatching: args['-o'],
      before: args['-B'] ?? around,
      after: args['-A'] ?? around,
      multiline: args.multiline,
      offset,
      headLimit,
    });
  } catch (err) {
    if (isApiError(err, PC_ERROR_CODES.NOT_FOUND)) return errorResult(pathMissing(args.path ?? path, cwd));
    throw err;
  }
  const rel = (line: string) => (line.startsWith(`${cwd}/`) ? line.slice(cwd.length + 1) : line);
  const total = res.total ?? res.output.split('\n').filter(Boolean).length;
  const appliedLimit = headLimit !== undefined && total - offset > headLimit ? headLimit : undefined;
  const lines = res.output.length > 0 ? res.output.split('\n').map(rel) : [];
  if (mode === 'content') return textResult(grepContent(lines.join('\n'), appliedLimit, offset, total));
  if (mode === 'count') {
    return textResult(grepCount(lines.join('\n'), res.matches, res.files ?? total, appliedLimit, offset));
  }
  return textResult(grepFiles(lines, appliedLimit, offset, total));
}

export function fileTools(ctx: PcToolContext): Def[] {
  const plans = ctx.host.plans;
  return defs(
    tool(
      'read',
      `Read a file inside the PC you sit at. file_path should be absolute.
- Returns up to 2000 lines from the start (or from offset), numbered from 1 as "<n>\\t<line>". Lines over 2000 characters are cut.
- Use offset and limit only for files too large to read at once; a larger view is cut and says how to go on.
- Images (png, jpg, gif, webp) are shown to you as images; PDFs as text (pages: "1-5", at most 20).
- Reading a directory fails: list it with glob or bash ls. An empty file returns a warning instead of lines.
- Re-reading a file that did not change returns a short notice: use what you read before.`,
      {
        file_path: z.string().min(1).describe('The absolute path to the file to read'),
        offset: z
          .number()
          .optional()
          .describe('The line number to start reading from. Only provide if the file is too large to read at once'),
        limit: z
          .number()
          .optional()
          .describe('The number of lines to read. Only provide if the file is too large to read at once.'),
        pages: z
          .string()
          .optional()
          .describe('Page range for PDF files (e.g., "1-5", "3", "10-20"). Maximum 20 pages per request.'),
      },
      async (args, extra) => {
        if (plans.isPlanPath(args.file_path)) {
          const file = plans.read(args.file_path);
          if (!file) return errorResult(readMissing('~'));
          if (file.text.length === 0) return textResult(READ_EMPTY);
          return textResult(numberLines(file.text.split('\n'), 1).join('\n'));
        }
        return ctx.run('read', extra, (seat) => readFile(ctx, seat, args));
      },
      { annotations: { readOnlyHint: true } },
    ),
    tool(
      'write',
      'Write a file inside the PC (creates parent directories). Overwriting an existing file needs a read of it first in this seat. Prefer edit for changes to existing files.',
      {
        file_path: z.string().min(1).describe('The absolute path to the file to write (must be absolute, not relative)'),
        content: z.string().describe('The content to write to the file'),
      },
      async (args, extra) => {
        if (plans.isPlanPath(args.file_path)) {
          const existed = plans.read(args.file_path) !== null;
          plans.write(args.file_path, args.content);
          return textResult(existed ? writeUpdated(args.file_path) : writeCreated(args.file_path));
        }
        return ctx.run('write', extra, (seat) => writeFile(ctx, seat, args));
      },
    ),
    tool(
      'edit',
      'Replace exact text in a file inside the PC. Read the file first. old_string must match the file exactly (indentation included, without read\'s line-number prefix) and exactly once, unless replace_all is true. An empty old_string creates a new file with new_string.',
      {
        file_path: z.string().min(1).describe('The absolute path to the file to modify'),
        old_string: z.string().describe('The text to replace'),
        new_string: z.string().describe('The text to replace it with (must be different from old_string)'),
        replace_all: z.boolean().optional().describe('Replace all occurrences of old_string (default false)'),
      },
      async (args, extra) => {
        if (args.old_string === args.new_string) return errorResult(EDIT_SAME);
        if (plans.isPlanPath(args.file_path)) {
          if (args.old_string === '') {
            plans.write(args.file_path, args.new_string);
            return textResult(editUpdated(args.file_path));
          }
          const res = plans.edit(args.file_path, args.old_string, args.new_string, args.replace_all === true);
          if (res.ok) return textResult(args.replace_all ? editUpdatedAll(args.file_path) : editUpdated(args.file_path));
          if (res.code === 'EDIT_NOT_FOUND') return errorResult(editNotFound(args.old_string));
          if (res.code === 'EDIT_AMBIGUOUS') {
            return errorResult(editAmbiguous(Number(/(\d+)/.exec(res.message)?.[1] ?? 2), args.old_string));
          }
          return errorResult(readMissing('~'));
        }
        return ctx.run('edit', extra, (seat) => editFile(ctx, seat, args));
      },
    ),
    tool(
      'glob',
      'Find files inside the PC by glob pattern ("**/*.ts", "src/**/test_*.py"), most recently modified first, at most 100.',
      {
        pattern: z.string().min(1).describe('The glob pattern to match files against'),
        path: z
          .string()
          .optional()
          .describe('The directory to search in. Omit it to use the working directory.'),
      },
      (args, extra) => ctx.run('glob', extra, (seat) => glob(ctx, seat, args)),
      { annotations: { readOnlyHint: true } },
    ),
    tool(
      'grep',
      'Search file contents inside the PC with ripgrep (full regex syntax; escape literal braces: interface\\{\\}). Paths inside the working directory are shown relative to it.',
      {
        pattern: z.string().min(1).describe('The regular expression pattern to search for in file contents'),
        path: z.string().optional().describe('File or directory to search in. Defaults to the working directory.'),
        glob: z.string().optional().describe('Glob pattern to filter files (e.g. "*.js", "*.{ts,tsx}")'),
        type: z.string().optional().describe('File type to search (rg --type): js, py, rust, go, java, ...'),
        output_mode: z
          .enum(['content', 'files_with_matches', 'count'])
          .optional()
          .describe('"content" shows matching lines, "files_with_matches" file paths (default), "count" match counts'),
        '-i': z.boolean().optional().describe('Case insensitive search'),
        '-n': z.boolean().optional().describe('Line numbers (content mode; default true)'),
        '-o': z.boolean().optional().describe('Only the matched parts, one per line (content mode)'),
        '-A': z.number().int().min(0).optional().describe('Lines after each match (content mode)'),
        '-B': z.number().int().min(0).optional().describe('Lines before each match (content mode)'),
        '-C': z.number().int().min(0).optional().describe('Alias for context'),
        context: z.number().int().min(0).optional().describe('Lines before and after each match (content mode)'),
        multiline: z.boolean().optional().describe('Let . match newlines and patterns span lines'),
        head_limit: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe('First N lines/entries after offset (default 250; 0 for all, sparingly)'),
        offset: z.number().int().min(0).optional().describe('Skip the first N lines/entries before head_limit'),
      },
      (args, extra) => ctx.run('grep', extra, (seat) => grep(ctx, seat, args)),
      { annotations: { readOnlyHint: true } },
    ),
  );
}

export { PC_LIMITS };
