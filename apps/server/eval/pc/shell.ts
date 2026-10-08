/**
 * The scripted PC's shell: a small bash look-alike over {@link MemFs}. It parses `&&`, `||`, `;`, pipes, quotes,
 * `~`, `$HOME`-style variables, simple globs and `>`/`>>`/`2>` redirects, and runs a whitelist of commands (coreutils,
 * grep/rg/find/sed, git, npm/node test runs, df/du/free, a browser launcher). Anything else answers like bash does
 * for a missing command; network tools fail like an offline box. Nothing here ever executes model-written code.
 */

import { posix } from 'node:path';
import { dfOutput, FREE_H, HOSTNAME, human, runRepoTests, type TestRun, UNAME_A } from './content.js';
import { MemFs } from './fs.js';

export interface ShellHost {
  readonly fs: MemFs;
  readonly home: string;
  readonly user: string;
  /** Tracked files at HEAD, for `git status` / `git diff` (path → text). */
  readonly gitHead: ReadonlyMap<string, string>;
  readonly gitRoot: string;
  /** A browser was launched (`firefox`, `xdg-open URL`). */
  openBrowser(url: string | null): void;
  onTestRun?(run: TestRun): void;
}

export interface ShellResult {
  readonly output: string;
  readonly exitCode: number;
  readonly cwd: string;
}

type Tok = { t: 'w'; v: string; glob: boolean } | { t: 'op'; v: string };

const OPS = ['&&', '||', '2>&1', '2>>', '&>', '>>', '2>', '|', ';', '&', '>', '<', '\n'];

function tokenize(src: string, env: Readonly<Record<string, string>>): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  let word = '';
  let inWord = false;
  let glob = false;
  const flush = () => {
    if (inWord) out.push({ t: 'w', v: word, glob });
    word = '';
    inWord = false;
    glob = false;
  };
  const expandVars = (s: string) =>
    s.replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g, (_m, name: string) => env[name] ?? '');
  while (i < src.length) {
    const c = src[i] as string;
    if (c === ' ' || c === '\t') {
      flush();
      i++;
      continue;
    }
    if (c === '#' && !inWord) {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    const op = OPS.find((o) => src.startsWith(o, i));
    if (op && !(op === '2>' && inWord) && !(op === '2>&1' && inWord) && !(op === '2>>' && inWord)) {
      flush();
      out.push({ t: 'op', v: op });
      i += op.length;
      continue;
    }
    if (c === "'") {
      const end = src.indexOf("'", i + 1);
      word += src.slice(i + 1, end < 0 ? undefined : end);
      inWord = true;
      i = end < 0 ? src.length : end + 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let s = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length && '"\\$`'.includes(src[j + 1] as string)) {
          s += src[j + 1];
          j += 2;
        } else s += src[j++];
      }
      word += expandVars(s);
      inWord = true;
      i = j + 1;
      continue;
    }
    if (c === '\\' && i + 1 < src.length) {
      word += src[i + 1];
      inWord = true;
      i += 2;
      continue;
    }
    if (c === '$') {
      const m = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/.exec(src.slice(i));
      if (m) {
        word += env[m[1] as string] ?? '';
        inWord = true;
        i += m[0].length;
        continue;
      }
    }
    if (c === '~' && !inWord && (src[i + 1] === undefined || src[i + 1] === '/' || src[i + 1] === ' ')) {
      word += env.HOME ?? '~';
      inWord = true;
      i++;
      continue;
    }
    if (c === '*' || c === '?') glob = true;
    word += c;
    inWord = true;
    i++;
  }
  flush();
  return out;
}

interface Cmd {
  argv: string[];
  redirects: { op: string; target: string }[];
}
interface Pipeline {
  readonly cmds: Cmd[];
  /** The operator before this pipeline (`&&`, `||`, `;`). */
  readonly before: string;
}

function globToRe(pattern: string): RegExp {
  let re = '';
  for (const ch of pattern) {
    if (ch === '*') re += '[^/]*';
    else if (ch === '?') re += '[^/]';
    else re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

export class Shell {
  readonly host: ShellHost;
  readonly #env: Record<string, string>;
  /** Every command line run, in order. */
  readonly history: string[] = [];

  constructor(host: ShellHost) {
    this.host = host;
    this.#env = {
      HOME: host.home,
      USER: host.user,
      LOGNAME: host.user,
      SHELL: '/bin/bash',
      PATH: '/usr/local/bin:/usr/bin:/bin',
      HOSTNAME,
      LANG: 'C.UTF-8',
    };
  }

  run(command: string, cwd: string): ShellResult {
    this.history.push(command);
    let dir = this.host.fs.isDir(cwd) ? cwd : this.host.home;
    this.#env.PWD = dir;
    const toks = tokenize(command, this.#env);
    const pipelines = this.#parse(toks);
    let code = 0;
    let out = '';
    for (const p of pipelines) {
      if (p.before === '&&' && code !== 0) continue;
      if (p.before === '||' && code === 0) continue;
      let stdin = '';
      let errs = '';
      for (const [n, cmd] of p.cmds.entries()) {
        const argv = this.#expand(cmd.argv, dir);
        let res: { out: string; err: string; code: number; cwd?: string };
        try {
          res = this.#exec(argv, stdin, dir);
        } catch (err) {
          res = { out: '', err: `bash: ${err instanceof Error ? err.message : String(err)}\n`, code: 1 };
        }
        if (res.cwd) dir = res.cwd;
        this.#env.PWD = dir;
        let stdout = res.out;
        let stderr = res.err;
        for (const r of cmd.redirects) {
          const target = r.target === '/dev/null' ? null : MemFs.resolve(dir, r.target, this.host.home);
          if (r.op === '>' || r.op === '>>' || r.op === '&>') {
            if (target) {
              const prev = r.op === '>>' ? (this.host.fs.read(target) ?? '') : '';
              this.host.fs.write(target, prev + stdout + (r.op === '&>' ? stderr : ''));
            }
            stdout = '';
            if (r.op === '&>') stderr = '';
          } else if (r.op === '2>' || r.op === '2>>') {
            if (target)
              this.host.fs.write(target, (r.op === '2>>' ? (this.host.fs.read(target) ?? '') : '') + stderr);
            stderr = '';
          } else if (r.op === '2>&1') {
            stdout += stderr;
            stderr = '';
          }
        }
        errs += stderr;
        code = res.code;
        stdin = stdout;
        if (n === p.cmds.length - 1) out += stdout;
      }
      out += errs;
    }
    return { output: out, exitCode: code, cwd: dir };
  }

  #parse(toks: Tok[]): Pipeline[] {
    const pipelines: Pipeline[] = [];
    let cmds: Cmd[] = [];
    let cmd: Cmd = { argv: [], redirects: [] };
    let before = ';';
    const endCmd = () => {
      if (cmd.argv.length > 0) cmds.push(cmd);
      cmd = { argv: [], redirects: [] };
    };
    const endPipe = (next: string) => {
      endCmd();
      if (cmds.length > 0) pipelines.push({ cmds, before });
      cmds = [];
      before = next;
    };
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i] as Tok;
      if (t.t === 'w') {
        cmd.argv.push(t.v);
        continue;
      }
      switch (t.v) {
        case '|':
          endCmd();
          break;
        case '&&':
        case '||':
          endPipe(t.v);
          break;
        case ';':
        case '\n':
        case '&':
          endPipe(';');
          break;
        case '2>&1':
          cmd.redirects.push({ op: '2>&1', target: '' });
          break;
        case '<': {
          i++;
          break;
        }
        default: {
          const next = toks[i + 1];
          if (next?.t === 'w') {
            cmd.redirects.push({ op: t.v, target: next.v });
            i++;
          }
        }
      }
    }
    endPipe(';');
    return pipelines;
  }

  #expand(argv: string[], cwd: string): string[] {
    const out: string[] = [];
    for (const a of argv) {
      if (!/[*?]/.test(a) || a.startsWith('-')) {
        out.push(a);
        continue;
      }
      const abs = a.startsWith('/');
      const dir = posix.dirname(a);
      const base = posix.basename(a);
      if (/[*?]/.test(dir)) {
        out.push(a);
        continue;
      }
      const real = MemFs.resolve(cwd, dir, this.host.home);
      const re = globToRe(base);
      const hits = this.host.fs
        .list(real, base.startsWith('.'))
        .filter((e) => re.test(e.name))
        .map((e) => (dir === '.' && !abs && !a.startsWith('./') ? e.name : posix.join(dir, e.name)));
      if (hits.length === 0) out.push(a);
      else out.push(...hits);
    }
    return out;
  }

  #path(cwd: string, p: string): string {
    return MemFs.resolve(cwd, p, this.host.home);
  }

  #exec(
    argv: string[],
    stdin: string,
    cwd: string,
  ): { out: string; err: string; code: number; cwd?: string } {
    const [name, ...args] = argv;
    const fs = this.host.fs;
    const ok = (out: string) => ({
      out: out.length > 0 && !out.endsWith('\n') ? `${out}\n` : out,
      err: '',
      code: 0,
    });
    const err = (msg: string, code = 1) => ({ out: '', err: `${msg}\n`, code });
    if (!name) return ok('');
    const flags = new Set(
      args
        .filter((a) => a.startsWith('-') && a.length > 1)
        .flatMap((a) => (a.startsWith('--') ? [a] : [...a.slice(1)].map((c) => `-${c}`))),
    );
    const operands = args.filter((a) => !a.startsWith('-') || a === '-');
    switch (name) {
      case 'true':
      case ':':
        return ok('');
      case 'false':
        return { out: '', err: '', code: 1 };
      case 'clear':
      case 'sleep':
      case 'export':
      case 'set':
      case 'source':
      case '.':
      case 'history':
        return ok('');
      case 'cd': {
        const target = this.#path(cwd, operands[0] ?? this.host.home);
        if (!fs.isDir(target)) return err(`bash: cd: ${operands[0]}: No such file or directory`);
        return { out: '', err: '', code: 0, cwd: target };
      }
      case 'pwd':
        return ok(cwd);
      case 'echo':
        return ok(
          `${args.filter((a) => a !== '-n' && a !== '-e').join(' ')}${args.includes('-n') ? '' : '\n'}`,
        );
      case 'printf':
        return ok((args[0] ?? '').replace(/%s/g, () => args[1] ?? '').replace(/\\n/g, '\n'));
      case 'whoami':
        return ok(this.host.user);
      case 'id':
        return ok(`uid=1000(${this.host.user}) gid=1000(${this.host.user}) groups=1000(${this.host.user})`);
      case 'hostname':
        return ok(HOSTNAME);
      case 'uname':
        return ok(flags.has('-a') ? UNAME_A : flags.has('-r') ? '6.8.0-45-generic' : 'Linux');
      case 'date':
        return ok('Fri Oct  9 14:05:00 UTC 2026');
      case 'env':
      case 'printenv':
        return ok(
          Object.entries(this.#env)
            .map(([k, v]) => `${k}=${v}`)
            .join('\n'),
        );
      case 'which':
      case 'command':
        return operands.length > 0 && KNOWN.has(operands.at(-1) as string)
          ? ok(`/usr/bin/${operands.at(-1)}`)
          : { out: '', err: '', code: 1 };
      case 'ls':
        return this.#ls(args, flags, operands, cwd);
      case 'cat': {
        if (operands.length === 0) return ok(stdin);
        let out = '';
        let e = '';
        for (const o of operands) {
          const p = this.#path(cwd, o);
          if (fs.isDir(p)) e += `cat: ${o}: Is a directory\n`;
          else if (!fs.isFile(p)) e += `cat: ${o}: No such file or directory\n`;
          else out += fs.read(p);
        }
        return { out, err: e, code: e ? 1 : 0 };
      }
      case 'head':
      case 'tail': {
        const n = numArg(args, 10);
        const file = operands.find((o) => !/^\d+$/.test(o));
        const text = file ? fs.read(this.#path(cwd, file)) : stdin;
        if (text === undefined)
          return err(`${name}: cannot open '${file}' for reading: No such file or directory`);
        const lines = text.replace(/\n$/, '').split('\n');
        return ok((name === 'head' ? lines.slice(0, n) : lines.slice(-n)).join('\n'));
      }
      case 'wc': {
        const files = operands;
        const count = (t: string) =>
          flags.has('-l')
            ? String(t.split('\n').length - (t.endsWith('\n') ? 1 : 0))
            : flags.has('-w')
              ? String(t.split(/\s+/).filter(Boolean).length)
              : flags.has('-c')
                ? String(Buffer.byteLength(t))
                : `${t.split('\n').length - 1} ${t.split(/\s+/).filter(Boolean).length} ${Buffer.byteLength(t)}`;
        if (files.length === 0) return ok(count(stdin));
        return ok(files.map((f) => `${count(fs.read(this.#path(cwd, f)) ?? '')} ${f}`).join('\n'));
      }
      case 'grep':
      case 'egrep':
      case 'rg':
        return this.#grep(name, args, stdin, cwd);
      case 'find':
        return this.#find(args, cwd);
      case 'mkdir':
        for (const o of operands) fs.mkdirp(this.#path(cwd, o));
        return ok('');
      case 'touch':
        for (const o of operands) {
          const p = this.#path(cwd, o);
          if (!fs.isFile(p)) fs.write(p, '');
        }
        return ok('');
      case 'rm': {
        let e = '';
        for (const o of operands) {
          const p = this.#path(cwd, o);
          if (fs.isDir(p) && !flags.has('-r') && !flags.has('-R'))
            e += `rm: cannot remove '${o}': Is a directory\n`;
          else if (!fs.remove(p) && !flags.has('-f'))
            e += `rm: cannot remove '${o}': No such file or directory\n`;
        }
        return { out: '', err: e, code: e ? 1 : 0 };
      }
      case 'cp':
      case 'mv': {
        const [src, dst] = operands;
        if (!src || !dst) return err(`${name}: missing file operand`);
        const s = this.#path(cwd, src);
        let d = this.#path(cwd, dst);
        const text = fs.read(s);
        if (text === undefined) return err(`${name}: cannot stat '${src}': No such file or directory`);
        if (fs.isDir(d)) d = posix.join(d, posix.basename(s));
        fs.write(d, text);
        if (name === 'mv') fs.remove(s);
        return ok('');
      }
      case 'sed':
        return this.#sed(args, stdin, cwd);
      case 'sort': {
        const text = operands[0] ? (fs.read(this.#path(cwd, operands[0])) ?? '') : stdin;
        const lines = text
          .replace(/\n$/, '')
          .split('\n')
          .filter((l) => l.length > 0);
        const key = (l: string) =>
          flags.has('-h') ? parseHuman(l) : flags.has('-n') ? Number.parseFloat(l) || 0 : 0;
        lines.sort((a, b) => (flags.has('-h') || flags.has('-n') ? key(a) - key(b) : a.localeCompare(b)));
        if (flags.has('-r')) lines.reverse();
        return ok(lines.join('\n'));
      }
      case 'uniq': {
        const lines = stdin.replace(/\n$/, '').split('\n');
        return ok(lines.filter((l, i) => i === 0 || l !== lines[i - 1]).join('\n'));
      }
      case 'awk': {
        const prog = operands[0] ?? '';
        const m = /\{\s*print\s+\$(\d+)\s*\}/.exec(prog);
        const sepIdx = args.indexOf('-F');
        const sep = sepIdx >= 0 ? (args[sepIdx + 1] ?? ' ') : null;
        if (!m) return err('awk: only {print $N} is supported on this PC');
        const n = Number(m[1]);
        const text = operands[1] ? (fs.read(this.#path(cwd, operands[1])) ?? '') : stdin;
        return ok(
          text
            .replace(/\n$/, '')
            .split('\n')
            .map((l) => (n === 0 ? l : ((sep ? l.split(sep) : l.trim().split(/\s+/))[n - 1] ?? '')))
            .join('\n'),
        );
      }
      case 'df':
        return ok(dfOutput(flags.has('-h') || flags.has('-H'), operands.length > 0));
      case 'du':
        return this.#du(args, flags, operands, cwd);
      case 'free':
        return ok(FREE_H);
      case 'lsblk':
        return ok(
          'NAME   MAJ:MIN RM SIZE RO TYPE MOUNTPOINTS\nvda    253:0    0  50G  0 disk\n└─vda1 253:1    0  50G  0 part /etc/hosts',
        );
      case 'ps':
        return ok(
          '    PID TTY          TIME CMD\n      1 ?        00:00:01 spacesd\n    214 ?        00:00:00 bash',
        );
      case 'nproc':
        return ok('2');
      case 'git':
        return this.#git(args, cwd);
      case 'npm':
      case 'node':
      case 'npx':
      case 'yarn':
      case 'pnpm':
        return this.#node(name, args, cwd);
      case 'python':
      case 'python3':
        return args[0] === '--version' || args[0] === '-V'
          ? ok('Python 3.12.3')
          : err(`${name}: running scripts is not available on this eval PC`);
      case 'firefox':
      case 'xdg-open':
      case 'sensible-browser':
      case 'x-www-browser':
      case 'google-chrome':
      case 'chromium':
      case 'chromium-browser':
        this.host.openBrowser(operands[0] ?? null);
        return ok('');
      case 'curl':
      case 'wget': {
        const url = operands.find((o) => /\./.test(o)) ?? '';
        const host = url.replace(/^https?:\/\//, '').split('/')[0] ?? url;
        return name === 'curl'
          ? { out: '', err: `curl: (6) Could not resolve host: ${host}\n`, code: 6 }
          : { out: '', err: `wget: unable to resolve host address '${host}'\n`, code: 4 };
      }
      case 'ping':
        return {
          out: '',
          err: `ping: ${operands[0] ?? ''}: Temporary failure in name resolution\n`,
          code: 2,
        };
      case 'sudo':
        return err('sudo: a password is required');
      case 'apt':
      case 'apt-get':
      case 'pip':
      case 'pip3':
        return err(`${name}: no network on this PC`, 100);
      case 'vim':
      case 'vi':
      case 'nano':
      case 'emacs':
      case 'less':
      case 'more':
      case 'top':
      case 'htop':
        return err(`${name}: interactive programs need a terminal; use the file tools or plain commands`);
      case 'stat': {
        const p = this.#path(cwd, operands[0] ?? '.');
        if (!fs.isFile(p) && !fs.isDir(p))
          return err(`stat: cannot statx '${operands[0]}': No such file or directory`);
        return ok(
          `  File: ${operands[0]}\n  Size: ${fs.size(p)}\t${fs.isDir(p) ? 'directory' : 'regular file'}`,
        );
      }
      default:
        return err(`bash: ${name}: command not found`, 127);
    }
  }

  #ls(args: string[], flags: Set<string>, operands: string[], cwd: string) {
    const fs = this.host.fs;
    const all = flags.has('-a') || flags.has('-A');
    const long = flags.has('-l');
    const h = flags.has('-h');
    const targets = operands.length > 0 ? operands : ['.'];
    let out = '';
    let e = '';
    const fmt = (name: string, p: string, dir: boolean) => {
      if (!long) return name;
      const size = dir ? 4096 : fs.size(p);
      return `${dir ? 'drwxr-xr-x' : '-rw-r--r--'} 1 ${this.host.user} ${this.host.user} ${(h ? human(size) : String(size)).padStart(6)} Oct  9 10:00 ${name}`;
    };
    for (const t of targets) {
      const p = this.#path(cwd, t);
      if (fs.isFile(p)) {
        out += `${fmt(t, p, false)}\n`;
        continue;
      }
      if (!fs.isDir(p)) {
        e += `ls: cannot access '${t}': No such file or directory\n`;
        continue;
      }
      if (targets.length > 1) out += `${t}:\n`;
      const entries = fs.list(p, all);
      if (long) out += `total ${entries.length * 4}\n`;
      const lines = entries.map((en) => fmt(en.name, posix.join(p, en.name), en.dir));
      if (all && long) lines.unshift(fmt('.', p, true), fmt('..', posix.dirname(p), true));
      out += lines.length > 0 ? `${lines.join(long || flags.has('-1') ? '\n' : '  ')}\n` : '';
    }
    void args;
    return { out, err: e, code: e ? 2 : 0 };
  }

  #grep(name: string, args: string[], stdin: string, cwd: string) {
    const fs = this.host.fs;
    const rg = name === 'rg';
    let pattern: string | null = null;
    const paths: string[] = [];
    const f = new Set<string>();
    let include: RegExp | null = null;
    for (let i = 0; i < args.length; i++) {
      const a = args[i] as string;
      if (a === '-e' || a === '--regexp') {
        pattern = args[++i] ?? '';
      } else if (a.startsWith('--include=') || a.startsWith('--glob=')) {
        include = globToRe(a.slice(a.indexOf('=') + 1).replace(/^\*\*\//, ''));
      } else if (a === '-g' || a === '--glob' || a === '--include' || a === '-t' || a === '--type') {
        const v = args[++i] ?? '';
        if (a === '-g' || a === '--glob' || a === '--include') include = globToRe(v.replace(/^\*\*\//, ''));
      } else if (a.startsWith('--')) {
        f.add(a);
      } else if (a.startsWith('-') && a.length > 1) {
        for (const c of a.slice(1)) f.add(`-${c}`);
      } else if (pattern === null) pattern = a;
      else paths.push(a);
    }
    if (pattern === null) return { out: '', err: `Usage: ${name} [OPTION]... PATTERNS [FILE]...\n`, code: 2 };
    let re: RegExp;
    try {
      const src = f.has('-F')
        ? pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        : pattern.replace(/\\\|/g, '|');
      re = new RegExp(f.has('-w') ? `\\b(?:${src})\\b` : src, f.has('-i') ? 'i' : '');
    } catch {
      return { out: '', err: `${name}: invalid regular expression\n`, code: 2 };
    }
    const recursive = rg || f.has('-r') || f.has('-R');
    const lineNumbers = f.has('-n') || (rg && !f.has('-N'));
    const filesOnly = f.has('-l') || f.has('--files-with-matches');
    const countOnly = f.has('-c') || f.has('--count');
    const invert = f.has('-v');
    const files: string[] = [];
    if (paths.length === 0 && (rg ? stdin.length > 0 : !recursive)) {
      const hits = stdin
        .replace(/\n$/, '')
        .split('\n')
        .map((l, i) => [l, i + 1] as const)
        .filter(([l]) => re.test(l) !== invert);
      const lines = countOnly
        ? [String(hits.length)]
        : hits.map(([l, n]) => `${f.has('-n') ? `${n}:` : ''}${l}`);
      return { out: lines.length > 0 ? `${lines.join('\n')}\n` : '', err: '', code: hits.length > 0 ? 0 : 1 };
    }
    for (const p of paths.length > 0 ? paths : ['.']) {
      const abs = this.#path(cwd, p);
      if (fs.isFile(abs)) files.push(abs);
      else if (fs.isDir(abs) && recursive)
        files.push(...fs.walk(abs).filter((x) => !x.includes('/.git/') && !x.includes('/node_modules/')));
      else if (fs.isDir(abs)) return { out: '', err: `grep: ${p}: Is a directory\n`, code: 2 };
      else return { out: '', err: `${name}: ${p}: No such file or directory\n`, code: 2 };
    }
    const many = files.length > 1 || recursive;
    const show = (abs: string) => {
      const rel = posix.relative(cwd, abs);
      return paths.some((p) => p.startsWith('/')) || rel.startsWith('..') ? abs : rel;
    };
    const out: string[] = [];
    for (const file of files) {
      if (include && !include.test(posix.basename(file))) continue;
      const text = fs.read(file) ?? '';
      if (text === '(binary)') continue;
      const lines = text.split('\n');
      const hits = lines
        .map((l, i) => [l, i + 1] as const)
        .filter(([l]) => re.test(l) !== invert && l.length > 0);
      if (hits.length === 0) continue;
      if (filesOnly) out.push(show(file));
      else if (countOnly) out.push(many ? `${show(file)}:${hits.length}` : String(hits.length));
      else
        for (const [l, n] of hits)
          out.push(`${many ? `${show(file)}:` : ''}${lineNumbers ? `${n}:` : ''}${l}`);
    }
    return { out: out.length > 0 ? `${out.join('\n')}\n` : '', err: '', code: out.length > 0 ? 0 : 1 };
  }

  #find(args: string[], cwd: string) {
    const fs = this.host.fs;
    const start = args[0] && !args[0].startsWith('-') ? args[0] : '.';
    const root = this.#path(cwd, start);
    if (!fs.isDir(root)) return { out: '', err: `find: '${start}': No such file or directory\n`, code: 1 };
    let name: RegExp | null = null;
    let type: string | null = null;
    let maxDepth = Number.POSITIVE_INFINITY;
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '-name' || a === '-iname') {
        const g = args[++i] ?? '*';
        name = new RegExp(globToRe(g).source, a === '-iname' ? 'i' : '');
      } else if (a === '-type') type = args[++i] ?? null;
      else if (a === '-maxdepth') maxDepth = Number(args[++i] ?? 'Infinity');
    }
    const all = new Set<string>([root]);
    for (const f of fs.walk(root)) {
      all.add(f);
      let d = posix.dirname(f);
      while (d.startsWith(root) && d !== root) {
        all.add(d);
        d = posix.dirname(d);
      }
    }
    for (const d of fs.dirs) if (d.startsWith(`${root}/`)) all.add(d);
    const depth = (p: string) => (p === root ? 0 : p.slice(root.length).split('/').length - 1);
    const shown = [...all]
      .filter((p) => depth(p) <= maxDepth)
      .filter((p) => !type || (type === 'f' ? fs.isFile(p) : fs.isDir(p)))
      .filter((p) => !name || name.test(posix.basename(p)))
      .sort()
      .map((p) =>
        start.startsWith('/') ? p : p === root ? start : `${start.replace(/\/$/, '')}${p.slice(root.length)}`,
      );
    return { out: shown.length > 0 ? `${shown.join('\n')}\n` : '', err: '', code: 0 };
  }

  #sed(args: string[], stdin: string, cwd: string) {
    const fs = this.host.fs;
    const inPlace = args.some((a) => a === '-i' || a.startsWith('-i'));
    const quiet = args.includes('-n');
    const rest = args.filter((a) => !a.startsWith('-'));
    const script = rest[0] ?? '';
    const file = rest[1];
    const text = file ? fs.read(this.#path(cwd, file)) : stdin;
    if (text === undefined)
      return { out: '', err: `sed: can't read ${file}: No such file or directory\n`, code: 2 };
    const print = /^(\d+)(?:,(\d+|\$))?p$/.exec(script);
    if (print) {
      const lines = text.split('\n');
      const a = Number(print[1]);
      const b = print[2] === undefined ? a : print[2] === '$' ? lines.length : Number(print[2]);
      return { out: `${lines.slice(a - 1, b).join('\n')}\n`, err: '', code: 0 };
    }
    const sub = /^s(.)(.*?)\1(.*?)\1(g?)$/.exec(script);
    if (!sub) return { out: '', err: `sed: only 'N,Mp' and 's/a/b/[g]' are supported on this PC\n`, code: 1 };
    let re: RegExp;
    try {
      re = new RegExp(sub[2] as string, sub[4] === 'g' ? 'g' : '');
    } catch {
      return { out: '', err: 'sed: -e expression #1: invalid regular expression\n', code: 1 };
    }
    const replaced = text
      .split('\n')
      .map((l) => l.replace(re, (sub[3] as string).replace(/\\\//g, '/').replace(/&/g, '$&')))
      .join('\n');
    if (inPlace && file) {
      fs.write(this.#path(cwd, file), replaced);
      return { out: '', err: '', code: 0 };
    }
    return { out: quiet ? '' : replaced, err: '', code: 0 };
  }

  #du(args: string[], flags: Set<string>, operands: string[], cwd: string) {
    const fs = this.host.fs;
    const h = flags.has('-h');
    const summary = flags.has('-s');
    let maxDepth = summary ? 0 : Number.POSITIVE_INFINITY;
    const md = args.find((a) => a.startsWith('--max-depth='));
    if (md) maxDepth = Number(md.split('=')[1]);
    const di = args.indexOf('-d');
    if (di >= 0) maxDepth = Number(args[di + 1] ?? 0);
    const fmt = (bytes: number) => (h ? human(bytes) : String(Math.ceil(bytes / 1024)));
    const lines: string[] = [];
    let e = '';
    let grand = 0;
    const targets = operands.filter((o) => !/^\d+$/.test(o));
    for (const t of targets.length > 0 ? targets : ['.']) {
      const p = this.#path(cwd, t);
      if (!fs.isDir(p) && !fs.isFile(p)) {
        e += `du: cannot access '${t}': No such file or directory\n`;
        continue;
      }
      grand += fs.size(p);
      if (maxDepth > 0 && fs.isDir(p)) {
        const subs = fs.list(p, true).filter((x) => x.dir);
        for (const s of subs) lines.push(`${fmt(fs.size(posix.join(p, s.name)))}\t${posix.join(t, s.name)}`);
      }
      lines.push(`${fmt(fs.size(p))}\t${t}`);
    }
    if (flags.has('-c')) lines.push(`${fmt(grand)}\ttotal`);
    return { out: lines.length > 0 ? `${lines.join('\n')}\n` : '', err: e, code: e ? 1 : 0 };
  }

  #git(args: string[], cwd: string) {
    const fs = this.host.fs;
    const root = this.host.gitRoot;
    if (!(cwd === root || cwd.startsWith(`${root}/`)))
      return {
        out: '',
        err: 'fatal: not a git repository (or any of the parent directories): .git\n',
        code: 128,
      };
    const changed = [...this.host.gitHead].filter(([p, text]) => fs.read(p) !== text).map(([p]) => p);
    const untracked = fs.walk(root).filter((p) => !this.host.gitHead.has(p) && !p.includes('/.git/'));
    const rel = (p: string) => posix.relative(cwd, p);
    const sub = args[0];
    switch (sub) {
      case 'status': {
        if (args.includes('--short') || args.includes('-s') || args.includes('--porcelain'))
          return {
            out:
              [...changed.map((p) => ` M ${rel(p)}`), ...untracked.map((p) => `?? ${rel(p)}`)].join('\n') +
              (changed.length + untracked.length ? '\n' : ''),
            err: '',
            code: 0,
          };
        const lines = ['On branch main'];
        if (changed.length === 0 && untracked.length === 0)
          lines.push('nothing to commit, working tree clean');
        if (changed.length > 0)
          lines.push(
            'Changes not staged for commit:',
            '  (use "git add <file>..." to update what will be committed)',
            ...changed.map((p) => `\tmodified:   ${rel(p)}`),
            '',
          );
        if (untracked.length > 0) lines.push('Untracked files:', ...untracked.map((p) => `\t${rel(p)}`), '');
        return { out: `${lines.join('\n')}\n`, err: '', code: 0 };
      }
      case 'diff': {
        let out = '';
        for (const p of changed)
          out += unifiedDiff(posix.relative(root, p), this.host.gitHead.get(p) ?? '', fs.read(p) ?? '');
        return { out, err: '', code: 0 };
      }
      case 'log':
        return {
          out: 'a41c9e2 Add total() with discounts\n7d03b11 Add subtotal()\n1f2a6c0 Initial commit\n',
          err: '',
          code: 0,
        };
      case 'branch':
        return { out: '* main\n', err: '', code: 0 };
      case 'add':
      case 'stash':
        return { out: '', err: '', code: 0 };
      case 'commit':
        return { out: '[main 5be0c4d] Commit from the eval PC\n 1 file changed\n', err: '', code: 0 };
      case 'checkout':
      case 'restore': {
        for (const a of args.slice(1).filter((x) => !x.startsWith('-'))) {
          const p = this.#path(cwd, a);
          const head = this.host.gitHead.get(p);
          if (head !== undefined) fs.write(p, head);
        }
        return { out: '', err: '', code: 0 };
      }
      case 'show':
        return {
          out: 'commit a41c9e2\nAuthor: Jasper <jasper@example.com>\n\n    Add total() with discounts\n',
          err: '',
          code: 0,
        };
      default:
        return { out: '', err: `git: '${sub}' is not supported on this PC\n`, code: 1 };
    }
  }

  #node(name: string, args: string[], cwd: string) {
    const fs = this.host.fs;
    const prefixIdx = args.indexOf('--prefix');
    const dir = prefixIdx >= 0 ? this.#path(cwd, args[prefixIdx + 1] ?? '.') : cwd;
    const pkgDir = findUp(fs, dir, 'package.json');
    const sub = args.filter((_a, i) => !(prefixIdx >= 0 && (i === prefixIdx || i === prefixIdx + 1)));
    const runTests = (viaNpm: boolean) => {
      if (!pkgDir || pkgDir !== this.host.gitRoot) {
        return viaNpm
          ? {
              out: '',
              err: `npm error code ENOENT\nnpm error path ${dir}/package.json\nnpm error enoent Could not read package.json\n`,
              code: 254,
            }
          : { out: 'ℹ tests 0\nℹ pass 0\nℹ fail 0\n', err: '', code: 0 };
      }
      const run = runRepoTests(fs, viaNpm);
      this.host.onTestRun?.(run);
      return { out: `${run.output}\n`, err: '', code: run.exitCode };
    };
    if (name === 'node') {
      if (sub[0] === '-v' || sub[0] === '--version') return { out: 'v22.11.0\n', err: '', code: 0 };
      if (sub.includes('--test')) return runTests(false);
      if (sub[0] && /test/.test(sub[0])) return runTests(false);
      return {
        out: '',
        err: 'node: running scripts is not available on this eval PC (use npm test)\n',
        code: 1,
      };
    }
    if (name === 'npm') {
      const [cmd, arg] = sub;
      if (cmd === '-v' || cmd === '--version') return { out: '10.9.0\n', err: '', code: 0 };
      if (cmd === 'test' || cmd === 't' || (cmd === 'run' && (arg === 'test' || arg === undefined))) {
        if (cmd === 'run' && arg === undefined)
          return {
            out: 'Lifecycle scripts included in shop-cart@1.0.0:\n  test\n    node --test\n',
            err: '',
            code: 0,
          };
        return runTests(true);
      }
      if (cmd === 'install' || cmd === 'i' || cmd === 'ci')
        return {
          out: '\nup to date, audited 1 package in 312ms\n\nfound 0 vulnerabilities\n',
          err: '',
          code: 0,
        };
      if (cmd === 'ls') return { out: 'shop-cart@1.0.0\n└── (empty)\n', err: '', code: 0 };
      return { out: '', err: `npm error unknown command: "${cmd}"\n`, code: 1 };
    }
    return { out: '', err: `npm error could not determine executable to run\n`, code: 1 };
  }
}

const KNOWN = new Set([
  'bash',
  'ls',
  'cat',
  'grep',
  'rg',
  'find',
  'sed',
  'awk',
  'git',
  'node',
  'npm',
  'npx',
  'df',
  'du',
  'free',
  'firefox',
  'xdg-open',
  'python3',
  'curl',
  'wget',
  'sort',
  'head',
  'tail',
  'wc',
]);

function numArg(args: string[], dflt: number): number {
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (a === '-n' || a === '-c') return Number(args[i + 1] ?? dflt);
    const m = /^-n?(\d+)$/.exec(a);
    if (m) return Number(m[1]);
  }
  return dflt;
}

function parseHuman(line: string): number {
  const m = /^\s*([\d.]+)([KMGT]?)/i.exec(line);
  if (!m) return 0;
  const mult: Record<string, number> = { '': 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 };
  return Number(m[1]) * (mult[(m[2] ?? '').toUpperCase()] ?? 1);
}

function findUp(fs: MemFs, dir: string, file: string): string | null {
  let d = dir;
  for (;;) {
    if (fs.isFile(posix.join(d, file))) return d;
    if (d === '/') return null;
    d = posix.dirname(d);
  }
}

/** A minimal unified diff (whole-file hunk). */
function unifiedDiff(rel: string, a: string, b: string): string {
  const al = a.replace(/\n$/, '').split('\n');
  const bl = b.replace(/\n$/, '').split('\n');
  let start = 0;
  while (start < al.length && start < bl.length && al[start] === bl[start]) start++;
  let endA = al.length - 1;
  let endB = bl.length - 1;
  while (endA >= start && endB >= start && al[endA] === bl[endB]) {
    endA--;
    endB--;
  }
  const ctx = 3;
  const from = Math.max(0, start - ctx);
  const toA = Math.min(al.length - 1, endA + ctx);
  const toB = Math.min(bl.length - 1, endB + ctx);
  const lines = [
    `diff --git a/${rel} b/${rel}`,
    `--- a/${rel}`,
    `+++ b/${rel}`,
    `@@ -${from + 1},${toA - from + 1} +${from + 1},${toB - from + 1} @@`,
  ];
  for (let i = from; i < start; i++) lines.push(` ${al[i]}`);
  for (let i = start; i <= endA; i++) lines.push(`-${al[i]}`);
  for (let i = start; i <= endB; i++) lines.push(`+${bl[i]}`);
  for (let i = endA + 1; i <= toA; i++) lines.push(` ${al[i]}`);
  return `${lines.join('\n')}\n`;
}
