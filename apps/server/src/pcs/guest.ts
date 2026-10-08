import { ApiError } from '../contracts/common.js';
import { PC_ERROR_CODES, PC_LIMITS } from '../contracts/PcApi.js';

/**
 * Pieces of the guest-side PcApi (PLAN §6.2) that need no PC: the shell scripts that run inside the guest (every
 * path and pattern reaches them as an argument, never spliced into the script), output capping, the background-job
 * buffer, Edit's exact-string replacement, and the ripgrep argument building and output formatting.
 */

/** The unprivileged guest user (spacesd refuses to run as root, PLAN §8.6) and its home. */
export const GUEST_USER = 'cua';
export const GUEST_HOME = '/home/cua';
/** The XFCE display spacesd's desktop runs on. */
export const GUEST_DISPLAY = ':1';
/** The shell log every `pc__bash` call appends to and ShellMirror tails (PLAN §6.2). */
export const SHELL_LOG = '~/.mv/shell.log';

/** Exit codes of the guest scripts below. */
export const SCRIPT_EXIT = {
  NOT_FOUND: 3,
  NOT_A_FILE: 4,
  DENIED: 5,
  BINARY: 6,
  TOO_LARGE: 7,
  CHANGED: 8,
} as const;

/** Lines longer than this are cut by `readFile` (the tool server cuts again at 2000 characters). */
export const READ_LINE_MAX = 4000;
/** Bytes `readFile` returns at most per call. */
export const READ_MAX_BYTES = 256 * 1024;
/** Files larger than this are not edited in place (Edit is for text files). */
export const EDIT_MAX_BYTES = 16 * 1024 * 1024;
/** Largest `writeFile` content. */
export const WRITE_MAX_BYTES = 32 * 1024 * 1024;
/** Guest output kept for one grep or glob. */
export const SEARCH_MAX_BYTES = 16 * 1024 * 1024;
/** Paths a glob returns at most. */
export const GLOB_LIMIT = 100;

/**
 * `readFile`: `$1` path, `$2` first line (1-based), `$3` line count, `$4` byte budget. Prints the selected lines
 * (long ones cut) and, on stderr, `<total lines> <printed lines> <cut>`.
 */
export const READ_SCRIPT = `f=$1
[ -e "$f" ] || exit ${SCRIPT_EXIT.NOT_FOUND}
[ -d "$f" ] && exit ${SCRIPT_EXIT.NOT_A_FILE}
[ -r "$f" ] || exit ${SCRIPT_EXIT.DENIED}
a=$(head -c 8000 -- "$f" | wc -c)
b=$(head -c 8000 -- "$f" | tr -d '\\000' | wc -c)
[ "$a" = "$b" ] || exit ${SCRIPT_EXIT.BINARY}
exec awk -v o="$2" -v l="$3" -v maxb="$4" -v maxl=${READ_LINE_MAX} '
NR >= o && NR < o + l && !cut {
  line = $0
  if (length(line) > maxl) line = substr(line, 1, maxl) "… (line truncated)"
  tot += length(line) + 1
  if (tot > maxb) cut = 1
  else { print line; n++ }
}
END { printf "%d %d %d\\n", NR, n, cut > "/dev/stderr" }' < "$f"`;

/** `writeFile`: `$1` path; the content arrives on stdin. Creates parent directories; keeps the file's mode. */
export const WRITE_SCRIPT = `f=$1
d=$(dirname -- "$f")
mkdir -p -- "$d" || exit ${SCRIPT_EXIT.DENIED}
[ -d "$f" ] && exit ${SCRIPT_EXIT.NOT_A_FILE}
cat > "$f" || exit ${SCRIPT_EXIT.DENIED}`;

/** `editFile`, read half: `$1` path, `$2` byte limit. Prints the file. */
export const EDIT_READ_SCRIPT = `f=$1
[ -e "$f" ] || exit ${SCRIPT_EXIT.NOT_FOUND}
[ -d "$f" ] && exit ${SCRIPT_EXIT.NOT_A_FILE}
[ -r "$f" ] || exit ${SCRIPT_EXIT.DENIED}
s=$(stat -c %s -- "$f") || exit ${SCRIPT_EXIT.DENIED}
[ "$s" -le "$2" ] || exit ${SCRIPT_EXIT.TOO_LARGE}
exec cat -- "$f"`;

/**
 * `editFile`, write half: `$1` path, `$2` the sha256 the file had when it was read; the new content arrives on
 * stdin. Refuses (exit CHANGED) when the file changed in between, so a concurrent writer is never clobbered.
 */
export const EDIT_WRITE_SCRIPT = `f=$1
got=$(sha256sum < "$f" | cut -d' ' -f1) || exit ${SCRIPT_EXIT.DENIED}
[ "$got" = "$2" ] || exit ${SCRIPT_EXIT.CHANGED}
cat > "$f" || exit ${SCRIPT_EXIT.DENIED}`;

/** `glob`: `$1` directory, `$2` gitignore-style pattern, `$3` how many paths at most. Newest first. */
export const GLOB_SCRIPT = `[ -d "$1" ] || exit ${SCRIPT_EXIT.NOT_FOUND}
cd -- "$1" || exit ${SCRIPT_EXIT.DENIED}
rg --files --hidden --no-config --no-messages -g "$2" -g '!.git' --sortr=modified . 2>/dev/null | head -n "$3"`;

/** `grep`: the ripgrep arguments are the script's arguments; output is capped. */
export const GREP_SCRIPT = `rg "$@" | head -c ${SEARCH_MAX_BYTES}
exit \${PIPESTATUS[0]}`;

/**
 * Kills every guest process whose environment holds `$1=$2` (for example `MV_TAG=ada:3`), including processes a
 * command left behind (they inherit the variable). Prints how many it killed. It only sees processes of the user it
 * runs as: inside the container even root cannot read another user's `/proc/<pid>/environ` (no CAP_SYS_PTRACE).
 */
export const SWEEP_SCRIPT = `want="$1=$2"
n=0
for d in /proc/[0-9]*; do
  pid=\${d#/proc/}
  [ "$pid" = "$$" ] && continue
  [ -r "$d/environ" ] || continue
  hit=0
  while IFS= read -r -d '' e; do
    if [ "$e" = "$want" ]; then hit=1; break; fi
  done 2>/dev/null < "$d/environ"
  if [ "$hit" = 1 ] && kill -KILL "$pid" 2>/dev/null; then n=$((n+1)); fi
done
echo "$n"`;

/**
 * Runs {@link SWEEP_SCRIPT} (`$3`) as the guest user, and again as root when `sudo -n` works (processes an agent
 * started with `sudo` carry the tag too); prints the total.
 */
export const SWEEP_LAUNCH = `s=$3
n=$(bash -c "$s" sweep "$1" "$2" 2>/dev/null) || n=0
m=0
if sudo -n true 2>/dev/null; then m=$(sudo -n bash -c "$s" sweep "$1" "$2" 2>/dev/null) || m=0; fi
echo $(( \${n:-0} + \${m:-0} ))`;

/**
 * Prefix of every `exec`: the working directory (an argument in `MV_EXEC_CWD`, falling back to the home when it is
 * gone) and, for commands that write the shell log, a prompt line so ShellMirror shows the command too.
 */
export const EXEC_PREFIX = `cd -- "$MV_EXEC_CWD" 2>/dev/null || cd ~
if [ -n "\${MV_PROMPT:-}" ]; then mkdir -p ~/.mv && printf '\\n%s\\n' "$MV_PROMPT" >> ~/.mv/shell.log; fi
unset MV_PROMPT MV_EXEC_CWD`;

/** The tool server's `pc__bash` wrapper writes the shell log; its own command sits between these lines. */
const WRAP_START = 'exec > >(tee -a ~/.mv/shell.log) 2>&1';
const WRAP_END = 'ec=$?';

/**
 * The prompt line ShellMirror shows before a command: `ada@linux-1:~/foo$ npm test`. Null for commands that do not
 * write the shell log (they are not mirrored).
 */
export function mirrorPrompt(
  command: string,
  who: { agentId: string; pcId: string; cwd: string | undefined },
): string | null {
  if (!command.includes(WRAP_START)) return null;
  const lines = command.split('\n');
  const start = lines.indexOf(WRAP_START);
  const end = lines.lastIndexOf(WRAP_END);
  // The wrapper's own `cd "$MV_CWD"` line follows its tee line.
  const inner = (end > start + 2 ? lines.slice(start + 2, end) : lines.slice(start + 1)).filter(
    (l) => l.trim().length > 0,
  );
  const first = (inner[0] ?? '').trim();
  const shown = first.length > 300 ? `${first.slice(0, 300)}…` : first;
  const more = inner.length > 1 ? ' …' : '';
  const cwd = (who.cwd ?? GUEST_HOME).replace(new RegExp(`^${GUEST_HOME}(?=/|$)`), '~');
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this strips
  const clean = (s: string) => s.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '');
  return clean(
    `\u001b[1;32m${who.agentId}@${who.pcId}\u001b[0m:\u001b[1;34m${cwd}\u001b[0m$ ${shown}${more}`,
  );
}

/** POSIX shell quoting of one word. */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

// ------------------------------------------------------------------------------------------- output capture

/**
 * Keeps the start and the end of a stream of text within `max` characters (head + marker + tail), so a huge build
 * log still shows how it began and how it ended (where the error and the `__MV_PWD__` marker are).
 */
export class OutputCapture {
  readonly #max: number;
  readonly #headMax: number;
  #head = '';
  #tail = '';
  #total = 0;

  constructor(max: number = PC_LIMITS.maxOutputChars, headShare = 0.4) {
    this.#max = max;
    this.#headMax = Math.floor(max * headShare);
  }

  get total(): number {
    return this.#total;
  }

  get truncated(): boolean {
    return this.#total > this.#max;
  }

  append(text: string): void {
    if (text.length === 0) return;
    this.#total += text.length;
    let rest = text;
    if (this.#head.length < this.#headMax) {
      const take = this.#headMax - this.#head.length;
      this.#head += rest.slice(0, take);
      rest = rest.slice(take);
    }
    if (rest.length === 0) return;
    this.#tail += rest;
    const keep = this.#max - this.#headMax;
    if (this.#tail.length > keep * 2) this.#tail = this.#tail.slice(this.#tail.length - keep);
  }

  /** At most `max` characters: everything, or the head, an omission note and the tail. */
  text(): string {
    if (this.#total <= this.#max) return this.#head + this.#tail;
    const marker = (n: number) => `\n… (${n} characters omitted) …\n`;
    // Sized with the largest possible count, so the result never exceeds `max`.
    const keep = Math.max(0, this.#max - this.#head.length - marker(this.#total).length);
    const tail = this.#tail.slice(Math.max(0, this.#tail.length - keep));
    return `${this.#head}${marker(this.#total - this.#head.length - tail.length)}${tail}`;
  }
}

/**
 * The output of a background job: an append-only character stream addressed by offset, of which the newest
 * `max` characters are kept (older ones are dropped and counted in {@link base}).
 */
export class JobBuffer {
  readonly #max: number;
  #text = '';
  #base = 0;

  constructor(max = 1_000_000) {
    this.#max = max;
  }

  /** Offset of the first character still kept. */
  get base(): number {
    return this.#base;
  }

  /** Offset after the last character. */
  get end(): number {
    return this.#base + this.#text.length;
  }

  append(text: string): void {
    this.#text += text;
    if (this.#text.length > this.#max) {
      const drop = this.#text.length - this.#max;
      this.#text = this.#text.slice(drop);
      this.#base += drop;
    }
  }

  /** Up to `limit` characters from `from`; `skipped` when part of what was asked for is gone already. */
  read(from: number, limit: number): { text: string; next: number; more: boolean; skipped: boolean } {
    const start = Math.max(from, this.#base);
    const text = this.#text.slice(start - this.#base, start - this.#base + limit);
    const next = start + text.length;
    return { text, next, more: next < this.end, skipped: from < this.#base };
  }
}

// ------------------------------------------------------------------------------------------------- edit

/** Edit's exact-string replacement (the built-in's semantics): one unique match, or every match with `replaceAll`. */
export function applyEdit(
  content: string,
  oldString: string,
  newString: string,
  replaceAll: boolean,
): { content: string; count: number } {
  const count = oldString.length === 0 ? 0 : content.split(oldString).length - 1;
  if (count === 0) throw new ApiError(PC_ERROR_CODES.EDIT_NOT_FOUND, 'old_string not found in the file');
  if (count > 1 && !replaceAll) {
    throw new ApiError(
      PC_ERROR_CODES.EDIT_AMBIGUOUS,
      `old_string occurs ${count} times; add context or use replace_all`,
    );
  }
  if (replaceAll) return { content: content.split(oldString).join(newString), count };
  return { content: content.replace(oldString, () => newString), count: 1 };
}

// ------------------------------------------------------------------------------------------------- glob

const GLOB_META = /[*?[\]{}!]/;

/**
 * Glob patterns behave like the built-in Glob tool's: `*.ts` matches in the directory itself, `**\/*.ts` at any depth.
 * ripgrep's `-g` uses gitignore rules, where a pattern without a slash matches at any depth, so such a pattern is
 * anchored with a leading `/`.
 */
export function anchorGlob(pattern: string): string {
  const p = pattern.trim();
  if (p.startsWith('/') || p.startsWith('**')) return p;
  return `/${p}`;
}

/**
 * An absolute pattern (`/home/cua/app/src/**\/*.ts`) as a directory plus a relative pattern; a relative pattern is
 * kept relative to `dir`.
 */
export function splitGlob(pattern: string, dir: string): { dir: string; pattern: string } {
  const p = pattern.trim();
  if (!p.startsWith('/')) return { dir, pattern: p };
  const parts = p.split('/').filter((x) => x.length > 0);
  const base: string[] = [];
  while (parts.length > 1 && !GLOB_META.test(parts[0] as string)) base.push(parts.shift() as string);
  return { dir: `/${base.join('/')}`, pattern: parts.join('/') };
}

/** Joins the `./x` paths ripgrep prints in `dir` into absolute paths. */
export function absolutePaths(stdout: string, dir: string): string[] {
  const root = dir.replace(/\/+$/, '') || '/';
  return stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => (l.startsWith('./') ? l.slice(2) : l))
    .map((l) => (l.startsWith('/') ? l : `${root === '/' ? '' : root}/${l}`));
}

// ------------------------------------------------------------------------------------------------- grep

export interface GrepArgsInput {
  readonly pattern: string;
  readonly path: string;
  readonly glob?: string | undefined;
  readonly type?: string | undefined;
  readonly outputMode: 'content' | 'files_with_matches' | 'count';
  readonly caseInsensitive?: boolean | undefined;
  readonly before?: number | undefined;
  readonly after?: number | undefined;
  readonly multiline?: boolean | undefined;
}

/** ripgrep arguments for one grep (the pattern travels as `-e`, the path after `--`). */
export function grepArgs(r: GrepArgsInput): string[] {
  const args = ['--no-config', '--hidden', '--no-messages', '-g', '!.git'];
  if (r.outputMode === 'content') args.push('--json');
  else if (r.outputMode === 'files_with_matches') args.push('--files-with-matches', '--sortr=modified');
  else args.push('--count', '--with-filename');
  if (r.caseInsensitive) args.push('-i');
  if (r.multiline) args.push('-U', '--multiline-dotall');
  if (r.type) args.push('-t', r.type);
  if (r.glob) args.push('-g', r.glob);
  if (r.outputMode === 'content') {
    const clamp = (n: number) => String(Math.max(0, Math.min(100, Math.floor(n))));
    if (r.before !== undefined && r.before > 0) args.push('-B', clamp(r.before));
    if (r.after !== undefined && r.after > 0) args.push('-A', clamp(r.after));
  }
  args.push('-e', r.pattern, '--', r.path);
  return args;
}

/** Longest line of grep output (a minified bundle would otherwise flood the result). */
export const GREP_LINE_MAX = 2000;

interface RgText {
  text?: string;
  bytes?: string;
}

const rgText = (t: RgText | undefined): string =>
  t?.text ?? (t?.bytes ? Buffer.from(t.bytes, 'base64').toString('utf8') : '');

const clipLine = (s: string) => (s.length > GREP_LINE_MAX ? `${s.slice(0, GREP_LINE_MAX)}…` : s);

/**
 * Formats `rg --json` like `rg -n` prints: `path:line:text` for matches, `path-line-text` for context lines and `--`
 * between separate groups. Returns the lines and how many matching lines there were. A cut-off last JSON line (the
 * output cap) is skipped and reported as `incomplete`.
 */
export function formatRgJson(
  stdout: string,
  options: { lineNumbers: boolean; context: boolean },
): { lines: string[]; matches: number; incomplete: boolean } {
  const lines: string[] = [];
  let matches = 0;
  let incomplete = false;
  let lastPath: string | null = null;
  let lastLine = -1;
  let started = false;
  for (const raw of stdout.split('\n')) {
    if (raw.trim().length === 0) continue;
    let msg: { type?: string; data?: Record<string, unknown> };
    try {
      msg = JSON.parse(raw) as typeof msg;
    } catch {
      incomplete = true;
      continue;
    }
    if (msg.type !== 'match' && msg.type !== 'context') continue;
    const d = msg.data ?? {};
    const path = rgText(d.path as RgText | undefined);
    const first = typeof d.line_number === 'number' ? d.line_number : null;
    const text = rgText(d.lines as RgText | undefined).replace(/\r?\n$/, '');
    const parts = text.split(/\r?\n/);
    if (
      options.context &&
      started &&
      (path !== lastPath || (first !== null && lastLine >= 0 && first > lastLine + 1))
    ) {
      lines.push('--');
    }
    started = true;
    const sep = msg.type === 'match' ? ':' : '-';
    parts.forEach((p, i) => {
      const n = first !== null ? first + i : null;
      lines.push(
        options.lineNumbers && n !== null
          ? `${path}${sep}${n}${sep}${clipLine(p)}`
          : `${path}${sep}${clipLine(p)}`,
      );
    });
    if (msg.type === 'match') matches += parts.length;
    lastPath = path;
    lastLine = first !== null ? first + parts.length - 1 : -1;
  }
  return { lines, matches, incomplete };
}

/** `rg --count` output (`path:N`) as its lines and the total. */
export function parseRgCount(stdout: string): { lines: string[]; matches: number } {
  const lines = stdout.split('\n').filter((l) => l.length > 0);
  let matches = 0;
  for (const l of lines) {
    const m = /:(\d+)$/.exec(l);
    if (m) matches += Number(m[1]);
  }
  return { lines, matches };
}

// ------------------------------------------------------------------------------------------------- exits

/** A spacesd exit as a shell exit code (a signal is 128 + its number, like bash reports it). */
export function exitCodeOf(exit: { code?: number | undefined; signal?: string | undefined }): number {
  if (typeof exit.code === 'number') return exit.code;
  const sig = (exit.signal ?? '').toLowerCase().replace(/^sig/, '');
  const nums: Record<string, number> = { hup: 1, int: 2, quit: 3, kill: 9, segv: 11, pipe: 13, term: 15 };
  return 128 + (nums[sig] ?? 9);
}
