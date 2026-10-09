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
/** Matches a glob counts at most (its total beyond is a floor). */
export const GLOB_COUNT_CAP = 10_000;
/** Where background jobs tee their output (`<jobId>.out`), readable with the agent's read tool. */
export const JOBS_DIR = `${GUEST_HOME}/.mv/jobs`;
/** A running job's output file is cut back to half when it grows past this. */
export const JOB_FILE_MAX_BYTES = 8 * 1024 * 1024;

/**
 * `readFile`: `$1` path, `$2` first line (1-based), `$3` line count, `$4` byte budget. Prints the selected lines
 * (long ones cut) and, on stderr, `<total lines> <printed lines> <cut> <ends with a newline>`.
 */
export const READ_SCRIPT = `f=$1
[ -e "$f" ] || exit ${SCRIPT_EXIT.NOT_FOUND}
[ -d "$f" ] && exit ${SCRIPT_EXIT.NOT_A_FILE}
[ -r "$f" ] || exit ${SCRIPT_EXIT.DENIED}
a=$(head -c 8000 -- "$f" | wc -c)
b=$(head -c 8000 -- "$f" | tr -d '\\000' | wc -c)
[ "$a" = "$b" ] || exit ${SCRIPT_EXIT.BINARY}
nl=0; [ -s "$f" ] && [ -z "$(tail -c 1 -- "$f")" ] && nl=1
exec awk -v o="$2" -v l="$3" -v maxb="$4" -v maxl=${READ_LINE_MAX} -v nl="$nl" '
NR >= o && NR < o + l && !cut {
  line = $0
  if (length(line) > maxl) line = substr(line, 1, maxl) "… (line truncated)"
  tot += length(line) + 1
  if (tot > maxb) cut = 1
  else { print line; n++ }
}
END { printf "%d %d %d %d\\n", NR, n, cut, nl > "/dev/stderr" }' < "$f"`;

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

/**
 * `glob`: `$1` directory, `$2` gitignore-style pattern, `$3` how many paths at most, `$4` how many matches to count at
 * most. Prints the newest paths, then `__MV_TOTAL__<n>`.
 */
export const GLOB_SCRIPT = `[ -d "$1" ] || exit ${SCRIPT_EXIT.NOT_FOUND}
cd -- "$1" || exit ${SCRIPT_EXIT.DENIED}
rg --files --hidden --no-config --no-messages -g "$2" -g '!.git' --sortr=modified . 2>/dev/null | head -n "$4" |
  awk -v n="$3" 'NR <= n { print } END { printf "__MV_TOTAL__%d\\n", NR }'`;

/**
 * zoom: `$1` the crop (`WxH+X+Y`, screen pixels), `$2` the output size (`WxH!`), `$3` the JPEG quality. Captures the
 * screen with ImageMagick (in the image) and scales the crop with Lanczos; prints the JPEG. 127 without ImageMagick.
 */
export const ZOOM_SCRIPT = `command -v import >/dev/null 2>&1 || exit 127
exec import -silent -window root -crop "$1" +repage -filter Lanczos -resize "$2" -quality "$3" jpg:-`;

/**
 * `stat` of what a symlink (`$1`) points at: prints `<file type>|<size>|<mtime in seconds>`; NOT_FOUND for a dangling
 * link. (spacesd's Stat describes the link itself, whose size and time never change with the file behind it.)
 */
export const STAT_TARGET_SCRIPT = `[ -e "$1" ] || exit ${SCRIPT_EXIT.NOT_FOUND}
exec stat -L -c '%F|%s|%Y' -- "$1"`;

/**
 * Cuts a running job's output file (`$1`) back to its last half when it is over `$2` bytes. The job appends with
 * `tee -a` (O_APPEND), so writes after the cut still land at the end.
 */
export const TRIM_JOB_SCRIPT = `f=$1
s=$(stat -c %s -- "$f" 2>/dev/null) || exit 0
[ "$s" -gt "$2" ] || exit 0
{ printf '[… earlier output was dropped …]\\n'; tail -c $(( $2 / 2 )) -- "$f"; } > "$f.trim" && cat -- "$f.trim" > "$f"
rm -f -- "$f.trim"`;

/**
 * `open`: `$1` target (URL, absolute path or app), the rest the app's arguments. Picks the program, prints
 * `via <program>`, and starts it detached (`setsid -f`), so it inherits the caller's `MV_TAG` and dies with the seat.
 * URLs and pages go to Firefox (its pages have an accessibility tree; Chromium's has none unless asked), folders to
 * Thunar, files to their default app, else a text editor, else the browser. Exits NOT_FOUND for a missing path and 2
 * (printing `apps: …`, the installed launchers) when nothing opens the target.
 */
export const OPEN_SCRIPT = `t=$1; shift
pick() { for p in "$@"; do command -v "$p" >/dev/null 2>&1 && { echo "$p"; return 0; }; done; return 1; }
apps() { printf 'apps: '; ls /usr/share/applications ~/.local/share/applications 2>/dev/null | sed -n 's/\\.desktop$//p' | sort -u | head -n 20 | tr '\\n' ' '; echo; }
prog=''; arg=$t
case "$t" in
  http://*|https://*|file://*|about:*) prog=$(pick firefox chromium xdg-open) ;;
  /*)
    [ -e "$t" ] || exit ${SCRIPT_EXIT.NOT_FOUND}
    if [ -d "$t" ]; then prog=$(pick thunar xdg-open)
    else
      m=$(xdg-mime query filetype "$t" 2>/dev/null)
      case "$m" in
        text/html|application/xhtml*|image/*|application/pdf) prog=$(pick firefox xdg-open) ;;
        *)
          if [ -n "$m" ] && [ -n "$(xdg-mime query default "$m" 2>/dev/null)" ]; then prog=xdg-open
          else case "$m" in
            text/*|application/json|application/xml|application/javascript|application/x-shellscript|application/x-*script*|inode/x-empty|application/x-zerosize)
              prog=$(pick mousepad gedit xed pluma code firefox) ;;
            *) prog=$(pick xdg-open) ;;
          esac; fi ;;
      esac
    fi ;;
  *)
    arg=''
    if command -v "$t" >/dev/null 2>&1; then prog=$t
    else
      d=$(ls /usr/share/applications/"$t".desktop ~/.local/share/applications/"$t".desktop 2>/dev/null | head -n 1)
      if [ -n "$d" ]; then
        e=$(sed -n 's/^Exec=//p' "$d" | head -n 1 | sed 's/ %[fFuUdDnNickvm]//g')
        [ -n "$e" ] && { echo "via $t"; setsid -f bash -c "exec $e" >/dev/null 2>&1 < /dev/null; exit 0; }
      fi
    fi ;;
esac
[ -n "$prog" ] || { apps; exit 2; }
echo "via $prog"
if [ "$prog" = xfce4-terminal ]; then set -- --disable-server "$@"; fi
if [ -n "$arg" ]; then setsid -f "$prog" "$@" "$arg" >/dev/null 2>&1 < /dev/null
else setsid -f "$prog" "$@" >/dev/null 2>&1 < /dev/null; fi`;

/** `grep`: the ripgrep arguments are the script's arguments; output is capped. */
export const GREP_SCRIPT = `rg "$@" | head -c ${SEARCH_MAX_BYTES}
exit \${PIPESTATUS[0]}`;

/**
 * Prints (one per line) the pid of every guest process whose environment holds `$1=$2` (for example `MV_TAG=ada:3`),
 * which takes processes a command left behind (they inherit the variable), plus every descendant of one, found by
 * parent pid. The environment is only readable for some processes: inside the container even root cannot read
 * another user's `/proc/<pid>/environ` (no CAP_SYS_PTRACE), nor that of a setuid `sudo`, and `sudo` resets the
 * environment of what it runs. Parent pids are readable for every process, so a root process an agent started with
 * `sudo` is still found, as a descendant of the agent's tagged shell.
 */
export const SWEEP_SCRIPT = `want="$1=$2"
declare -A parent=() hit=()
for d in /proc/[0-9]*; do
  pid=\${d#/proc/}
  [ "$pid" = "$$" ] && continue
  { IFS= read -r st < "$d/stat"; } 2>/dev/null || continue
  rest=\${st##*) }
  rest=\${rest#* }
  ppid=\${rest%% *}
  case $ppid in ''|*[!0-9]*) ;; *) parent[$pid]=$ppid ;; esac
  [ -r "$d/environ" ] || continue
  while IFS= read -r -d '' e; do
    if [ "$e" = "$want" ]; then hit[$pid]=1; break; fi
  done 2>/dev/null < "$d/environ"
done
grow=1
while [ "$grow" = 1 ]; do
  grow=0
  for pid in "\${!parent[@]}"; do
    [ -n "\${hit[$pid]:-}" ] && continue
    if [ -n "\${hit[\${parent[$pid]}]:-}" ]; then hit[$pid]=1; grow=1; fi
  done
done
for pid in "\${!hit[@]}"; do echo "$pid"; done`;

/** Kills the pids given as arguments; prints how many it killed. */
const KILL_SCRIPT = 'n=0; for p in "$@"; do kill -KILL "$p" 2>/dev/null && n=$((n+1)); done; echo "$n"';

/**
 * Collects the pids of {@link SWEEP_SCRIPT} (`$3`), run as the guest user and again as root when `sudo -n` works
 * (root reads the environment of root processes started with `sudo -n --preserve-env`), first, and only then kills
 * them all (as root when it can), so a child is never reparented away from its tagged parent before it is found.
 * Prints how many processes died.
 */
export const SWEEP_LAUNCH = `s=$3
k='${KILL_SCRIPT}'
pids=$(bash -c "$s" sweep "$1" "$2" 2>/dev/null)
root=0
if sudo -n true 2>/dev/null; then
  root=1
  pids="$pids
$(sudo -n bash -c "$s" sweep "$1" "$2" 2>/dev/null)"
fi
set -f
pids=$(printf '%s\n' $pids | grep -E '^[0-9]+$' | sort -un)
[ -n "$pids" ] || { echo 0; exit 0; }
if [ "$root" = 1 ]; then sudo -n bash -c "$k" kill $pids 2>/dev/null || echo 0
else bash -c "$k" kill $pids; fi`;

/**
 * Prefix of every `exec`: the working directory (an argument in `MV_EXEC_CWD`, falling back to the home when it is
 * gone); for commands that write the shell log, a prompt line so ShellMirror shows the command too; and with
 * `MV_OUT`, a tee of all output into that file, which the shell's exit deletes unless the command runs in the
 * background (`MV_KEEP`) or Node moved it there (`$MV_OUT.keep`).
 */
export const EXEC_PREFIX = `cd -- "$MV_EXEC_CWD" 2>/dev/null || cd ~
if [ -n "\${MV_PROMPT:-}" ]; then mkdir -p ~/.mv && printf '\\n%s\\n' "$MV_PROMPT" >> ~/.mv/shell.log; fi
if [ -n "\${MV_OUT:-}" ]; then
  mkdir -p -- "\${MV_OUT%/*}" && : > "$MV_OUT" && exec > >(tee -a -- "$MV_OUT") 2>&1
  [ -n "\${MV_KEEP:-}" ] || trap '[ -e "$MV_OUT.keep" ] || rm -f -- "$MV_OUT"' EXIT
fi
unset MV_PROMPT MV_EXEC_CWD MV_KEEP`;

/** The tool server's `pc__bash` wrapper writes the shell log; its own command sits between these lines. */
const WRAP_START = 'exec > >(tee -a ~/.mv/shell.log) 2>&1';
const WRAP_END = 'ec=$?';

const ESC = '\u001b';

/**
 * The prompt line ShellMirror shows before a command: `ada@linux-1:~/foo$ npm test`. Null for commands that do not
 * write the shell log (they are not mirrored).
 */
export function mirrorPrompt(
  command: string,
  who: { agentId: string; pcId: string; cwd: string | undefined; home?: string },
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
  const home = who.home ?? GUEST_HOME;
  const cwd = who.cwd ?? home;
  const shownCwd = cwd === home || cwd.startsWith(`${home}/`) ? `~${cwd.slice(home.length)}` : cwd;
  // Control characters (escape sequences an agent put in its command included) are stripped from the parts; the
  // prompt's own colours are added afterwards.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this strips
  const clean = (s: string) => s.replace(/[\u0000-\u001f\u007f]/g, '');
  const green = `${ESC}[1;32m`;
  const blue = `${ESC}[1;34m`;
  const reset = `${ESC}[0m`;
  return `${green}${clean(who.agentId)}@${clean(who.pcId)}${reset}:${blue}${clean(shownCwd)}${reset}$ ${clean(shown)}${more}`;
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

/**
 * Longest line of grep output (a minified bundle would otherwise flood the result); Claude Code's Grep passes
 * `--max-columns 500`.
 */
export const GREP_LINE_MAX = 500;

interface RgText {
  text?: string;
  bytes?: string;
}

const rgText = (t: RgText | undefined): string =>
  t?.text ?? (t?.bytes ? Buffer.from(t.bytes, 'base64').toString('utf8') : '');

const clipLine = (s: string) =>
  s.length > GREP_LINE_MAX ? `${s.slice(0, GREP_LINE_MAX)}… [${s.length} characters]` : s;

/**
 * Formats `rg --json` like `rg -n` prints: `path:line:text` for matches, `path-line-text` for context lines and `--`
 * between separate groups. Returns the lines and how many matching lines there were. A cut-off last JSON line (the
 * output cap) is skipped and reported as `incomplete`.
 */
export function formatRgJson(
  stdout: string,
  options: { lineNumbers: boolean; context: boolean; onlyMatching?: boolean },
): { lines: string[]; matches: number; incomplete: boolean } {
  if (options.onlyMatching) return formatRgJsonOnlyMatching(stdout, options.lineNumbers);
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

/** `rg -o`: one line per match (`path:line:match`), the matched text only; context lines are not printed. */
function formatRgJsonOnlyMatching(
  stdout: string,
  lineNumbers: boolean,
): { lines: string[]; matches: number; incomplete: boolean } {
  const lines: string[] = [];
  let incomplete = false;
  for (const raw of stdout.split('\n')) {
    if (raw.trim().length === 0) continue;
    let msg: { type?: string; data?: Record<string, unknown> };
    try {
      msg = JSON.parse(raw) as typeof msg;
    } catch {
      incomplete = true;
      continue;
    }
    if (msg.type !== 'match') continue;
    const d = msg.data ?? {};
    const path = rgText(d.path as RgText | undefined);
    const n = typeof d.line_number === 'number' ? d.line_number : null;
    const subs = Array.isArray(d.submatches) ? (d.submatches as { match?: RgText }[]) : [];
    for (const s of subs) {
      const text = rgText(s.match).replace(/\r?\n$/, '');
      if (text.length === 0) continue;
      const shown = clipLine(text.replace(/\r?\n/g, '\\n'));
      lines.push(lineNumbers && n !== null ? `${path}:${n}:${shown}` : `${path}:${shown}`);
    }
  }
  return { lines, matches: lines.length, incomplete };
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

// ------------------------------------------------------------------------------------------------- macOS guests

/** The macOS image's user (autologin; spacesd runs in its GUI session) and home (S6). */
export const MAC_GUEST_USER = 'lume';
export const MAC_GUEST_HOME = '/Users/lume';
/** Where Lume's shares appear in a macOS guest. */
export const MAC_SHARE_ROOT = '/Volumes/My Shared Files';
/**
 * PATH of the macOS guest scripts: spacesd's children get only `/usr/bin:/bin:/usr/sbin:/sbin`, and the ripgrep MineVibe
 * installs lives in `/usr/local/bin`.
 */
export const MAC_GUEST_PATH = '/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin';

/** `editFile`, read half, on macOS (BSD `stat`). */
export const MAC_EDIT_READ_SCRIPT = EDIT_READ_SCRIPT.replace('stat -c %s --', 'stat -f %z --');

/** `editFile`, write half, on macOS (`sha256sum` is new in macOS 15; `shasum` is the fallback). */
export const MAC_EDIT_WRITE_SCRIPT = `f=$1
if command -v sha256sum >/dev/null 2>&1; then got=$(sha256sum < "$f" | cut -d' ' -f1); else got=$(shasum -a 256 < "$f" | cut -d' ' -f1); fi
[ -n "$got" ] || exit ${SCRIPT_EXIT.DENIED}
[ "$got" = "$2" ] || exit ${SCRIPT_EXIT.CHANGED}
cat > "$f" || exit ${SCRIPT_EXIT.DENIED}`;

/** {@link STAT_TARGET_SCRIPT} on macOS: `<file type>|<size>|<mtime>` (`Regular File`, `Directory`). */
export const MAC_STAT_TARGET_SCRIPT = `[ -e "$1" ] || exit ${SCRIPT_EXIT.NOT_FOUND}
exec stat -L -f '%HT|%z|%m' -- "$1"`;

/** {@link TRIM_JOB_SCRIPT} on macOS. */
export const MAC_TRIM_JOB_SCRIPT = TRIM_JOB_SCRIPT.replace('stat -c %s --', 'stat -f %z --');

/**
 * {@link SWEEP_SCRIPT} on macOS, which has no `/proc`: `ps -axwwE` prints each process's environment after its command
 * (the user's own processes; every process when run as root), so a field equal to `$1=$2` marks a hit; descendants are
 * added by parent pid. bash 3.2 has no associative arrays, so awk does the walk. Name and value reach awk separately:
 * awk cuts its own `-v k=v` arguments at the `=` in place, and `ps` would then show a `MV_TAG=…` word in awk's command.
 */
export const MAC_SWEEP_SCRIPT = `ps -axwwE -o pid=,ppid=,command= 2>/dev/null | awk -v n="$1" -v v="$2" -v self="$$" '
BEGIN { want = n "=" v }
{ pid = $1; parent[pid] = $2; for (i = 3; i <= NF; i++) if ($i == want) { hit[pid] = 1; break } }
END {
  grow = 1
  while (grow) { grow = 0; for (p in parent) if (!(p in hit) && (parent[p] in hit)) { hit[p] = 1; grow = 1 } }
  for (p in hit) if (p != self) print p
}'`;

/**
 * `open` on macOS: URLs go to Safari (the image has no Firefox), paths to their default app (LaunchServices), app names
 * (and the Linux names the tools know: a terminal, a browser, a file manager) to the app. `open --env` gives the
 * launched app `MV_TAG`/`MV_CALL`, so the seat's sweep finds it (`ps -E`). Exits NOT_FOUND for a missing path and 2
 * (printing `apps: …`) when nothing opens the target.
 */
export const MAC_OPEN_SCRIPT = `t=$1; shift
launch() { open --env "MV_TAG=$MV_TAG" --env "MV_CALL=$MV_CALL" "$@" >/dev/null 2>&1; }
case "$t" in
  xfce4-terminal|terminal|Terminal|shell) echo "via Terminal"; launch -a Terminal "$HOME"; exit $? ;;
  firefox|chromium|browser|safari|Safari) echo "via Safari"; launch -a Safari; exit $? ;;
  thunar|files|finder|Finder) echo "via Finder"; launch -a Finder; exit $? ;;
  http://*|https://*|file://*|about:*) echo "via Safari"; launch -a Safari "$t"; exit $? ;;
  /*)
    [ -e "$t" ] || exit ${SCRIPT_EXIT.NOT_FOUND}
    echo "via open"; launch "$t"; exit $? ;;
esac
if open -Ra "$t" >/dev/null 2>&1; then
  echo "via $t"
  if [ $# -gt 0 ]; then launch -a "$t" --args "$@"; else launch -a "$t"; fi
  exit $?
fi
if command -v "$t" >/dev/null 2>&1; then echo "via $t"; nohup "$t" "$@" >/dev/null 2>&1 < /dev/null & exit 0; fi
printf 'apps: '; ls /Applications /System/Applications 2>/dev/null | sed -n 's/\\.app$//p' | sort -u | head -n 25 | tr '\\n' ' '; echo
exit 2`;

/**
 * Prefix of every macOS `exec`: {@link EXEC_PREFIX} after `umask 022` (spacesd's children run with umask 077, so files
 * an agent made would be 0600 on the Mac).
 */
export const MAC_EXEC_PREFIX = `umask 022\n${EXEC_PREFIX}`;

/** What differs between Linux and macOS guests for PcApi, ShellMirror and the boot steps. */
export interface GuestProfile {
  readonly os: 'linux' | 'macos';
  readonly user: string;
  readonly home: string;
  /** `DISPLAY` for GUI programs (Linux); null on macOS. */
  readonly display: string | null;
  /** PATH for the guest scripts (null: spacesd's own). */
  readonly path: string | null;
  readonly jobsDir: string;
  /** Extra environment of every `exec`. */
  readonly execEnv: Readonly<Record<string, string>>;
  readonly execPrefix: string;
  readonly scripts: {
    readonly read: string;
    readonly write: string;
    readonly editRead: string;
    readonly editWrite: string;
    readonly glob: string;
    readonly grep: string;
    readonly statTarget: string;
    readonly trimJob: string;
    readonly open: string;
    readonly zoom: string;
    readonly sweep: string;
  };
}

export const LINUX_GUEST: GuestProfile = {
  os: 'linux',
  user: GUEST_USER,
  home: GUEST_HOME,
  display: GUEST_DISPLAY,
  path: null,
  jobsDir: JOBS_DIR,
  execEnv: { SHELL: '/bin/bash', DISPLAY: GUEST_DISPLAY, DEBIAN_FRONTEND: 'noninteractive' },
  execPrefix: EXEC_PREFIX,
  scripts: {
    read: READ_SCRIPT,
    write: WRITE_SCRIPT,
    editRead: EDIT_READ_SCRIPT,
    editWrite: EDIT_WRITE_SCRIPT,
    glob: GLOB_SCRIPT,
    grep: GREP_SCRIPT,
    statTarget: STAT_TARGET_SCRIPT,
    trimJob: TRIM_JOB_SCRIPT,
    open: OPEN_SCRIPT,
    zoom: ZOOM_SCRIPT,
    sweep: SWEEP_SCRIPT,
  },
};

export const MACOS_GUEST: GuestProfile = {
  os: 'macos',
  user: MAC_GUEST_USER,
  home: MAC_GUEST_HOME,
  display: null,
  path: MAC_GUEST_PATH,
  jobsDir: `${MAC_GUEST_HOME}/.mv/jobs`,
  execEnv: { SHELL: '/bin/bash', HOMEBREW_NO_AUTO_UPDATE: '1' },
  execPrefix: MAC_EXEC_PREFIX,
  scripts: {
    read: READ_SCRIPT,
    write: WRITE_SCRIPT,
    editRead: MAC_EDIT_READ_SCRIPT,
    editWrite: MAC_EDIT_WRITE_SCRIPT,
    glob: GLOB_SCRIPT,
    grep: GREP_SCRIPT,
    statTarget: MAC_STAT_TARGET_SCRIPT,
    trimJob: MAC_TRIM_JOB_SCRIPT,
    open: MAC_OPEN_SCRIPT,
    // No ImageMagick: exits 127 and the region comes from spacesd.
    zoom: ZOOM_SCRIPT,
    sweep: MAC_SWEEP_SCRIPT,
  },
};

/** The guest profile of a PC family. */
export function guestProfile(family: 'linux' | 'macos' | 'windows'): GuestProfile {
  return family === 'macos' ? MACOS_GUEST : LINUX_GUEST;
}
