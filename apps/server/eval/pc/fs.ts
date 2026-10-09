/**
 * The scripted PC's in-memory file system: absolute POSIX paths to text, directories implied by files plus explicit
 * empty ones, and size overrides for the big files the disk-usage scenario reports.
 */

import { posix } from 'node:path';

export class MemFs {
  readonly files = new Map<string, string>();
  readonly dirs = new Set<string>(['/']);
  /** Reported sizes in bytes for files whose text is a placeholder (ISOs, videos). */
  readonly sizes = new Map<string, number>();

  constructor(files: Readonly<Record<string, string>> = {}, dirs: readonly string[] = []) {
    for (const [p, text] of Object.entries(files)) this.write(p, text);
    for (const d of dirs) this.mkdirp(d);
  }

  static norm(path: string): string {
    const n = posix.normalize(path);
    return n.length > 1 && n.endsWith('/') ? n.slice(0, -1) : n;
  }

  /** `path` resolved against `cwd`, with `~` as `home`. */
  static resolve(cwd: string, path: string, home: string): string {
    if (path === '~' || path.startsWith('~/')) return MemFs.norm(`${home}${path.slice(1)}`);
    return MemFs.norm(path.startsWith('/') ? path : posix.join(cwd, path));
  }

  mkdirp(dir: string): void {
    let d = MemFs.norm(dir);
    while (!this.dirs.has(d)) {
      this.dirs.add(d);
      d = posix.dirname(d);
    }
  }

  write(path: string, text: string): void {
    const p = MemFs.norm(path);
    this.mkdirp(posix.dirname(p));
    this.files.set(p, text);
    this.sizes.delete(p);
  }

  isFile(path: string): boolean {
    return this.files.has(MemFs.norm(path));
  }

  isDir(path: string): boolean {
    return this.dirs.has(MemFs.norm(path));
  }

  read(path: string): string | undefined {
    return this.files.get(MemFs.norm(path));
  }

  remove(path: string): boolean {
    const p = MemFs.norm(path);
    if (this.files.delete(p)) return true;
    if (!this.dirs.has(p)) return false;
    for (const f of [...this.files.keys()]) if (f.startsWith(`${p}/`)) this.files.delete(f);
    for (const d of [...this.dirs]) if (d === p || d.startsWith(`${p}/`)) this.dirs.delete(d);
    return true;
  }

  size(path: string): number {
    const p = MemFs.norm(path);
    const override = this.sizes.get(p);
    if (override !== undefined) return override;
    const text = this.files.get(p);
    if (text !== undefined) return Buffer.byteLength(text);
    let total = 4096;
    for (const [f] of this.files) if (f.startsWith(`${p}/`)) total += this.size(f);
    for (const [f, s] of this.sizes) if (f.startsWith(`${p}/`) && !this.files.has(f)) total += s;
    return total;
  }

  /** Direct children of a directory: names, directories marked. */
  list(dir: string, all = false): { name: string; dir: boolean }[] {
    const d = MemFs.norm(dir);
    const prefix = d === '/' ? '/' : `${d}/`;
    const out = new Map<string, boolean>();
    for (const f of this.files.keys()) {
      if (!f.startsWith(prefix)) continue;
      const rest = f.slice(prefix.length);
      const name = rest.split('/')[0] as string;
      out.set(name, out.get(name) === true || rest.includes('/'));
    }
    for (const sub of this.dirs) {
      if (sub === d || !sub.startsWith(prefix)) continue;
      const name = sub.slice(prefix.length).split('/')[0] as string;
      out.set(name, true);
    }
    return [...out]
      .filter(([name]) => all || !name.startsWith('.'))
      .map(([name, isDir]) => ({ name, dir: isDir }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)); // C locale: upper case first
  }

  /** Every file under `dir`, recursively. */
  walk(dir: string): string[] {
    const d = MemFs.norm(dir);
    const prefix = d === '/' ? '/' : `${d}/`;
    return [...this.files.keys()].filter((f) => f.startsWith(prefix)).sort();
  }
}

/** `1536` → `1.5K` (du -h / ls -h style). */
export function human(bytes: number): string {
  const units = ['', 'K', 'M', 'G', 'T'];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  if (i === 0) return String(Math.round(v));
  return v >= 10 ? `${Math.round(v)}${units[i]}` : `${v.toFixed(1)}${units[i]}`;
}
