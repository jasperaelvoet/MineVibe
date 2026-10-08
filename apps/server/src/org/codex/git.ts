/**
 * Git for the Codex (PLAN §6.6 "Storage"): every write is a commit authored by the agent or player, so history
 * shows who wrote what.
 *
 * Git runs isolated from the user's setup:
 * - a fresh environment (nothing inherited): `GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CONFIG_NOSYSTEM=1`,
 *   `GIT_TERMINAL_PROMPT=0`, `HOME` set to the Codex root, a fixed `PATH`;
 * - `-c commit.gpgsign=false -c core.hooksPath=/dev/null -c core.fsmonitor=false` (plus a few more) on every call;
 * - fixed author identities (`bram@agents.minevibe.invalid`) and one committer;
 * - `git init --template=` so no sample hooks are copied in.
 * The binary path is absolute (`/usr/bin/git` by default), never looked up on PATH.
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { CodexHistoryEntry } from './types.js';

export const DEFAULT_GIT_BINARY = '/usr/bin/git';

const ISOLATION_ARGS = [
  '-c',
  'commit.gpgsign=false',
  '-c',
  'tag.gpgsign=false',
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.autocrlf=false',
  '-c',
  'core.quotepath=false',
  '-c',
  'gc.auto=0',
  '-c',
  'maintenance.auto=false',
  '-c',
  'init.defaultBranch=main',
  '-c',
  'safe.directory=*',
] as const;

export interface GitIdentity {
  readonly name: string;
  readonly email: string;
}

export const COMMITTER: GitIdentity = { name: 'MineVibe Codex', email: 'codex@minevibe.invalid' };

/** A fixed identity for a writer: "Bram (agent)" <bram@agents.minevibe.invalid>. */
export function identityFor(actor: {
  kind: 'agent' | 'player' | 'system';
  id: string;
  name: string;
}): GitIdentity {
  const local = actor.id.toLowerCase().replace(/[^a-z0-9_-]/g, '') || 'unknown';
  const name = `${actor.name.replace(/[<>\n\r]/g, '').slice(0, 32) || local} (${actor.kind})`;
  switch (actor.kind) {
    case 'player':
      return { name, email: 'player@minevibe.invalid' };
    case 'system':
      return { name: 'MineVibe (system)', email: 'system@minevibe.invalid' };
    default:
      return { name, email: `${local}@agents.minevibe.invalid` };
  }
}

/** The environment every git call gets. Exported for tests. */
export function gitEnv(root: string, author: GitIdentity = COMMITTER): NodeJS.ProcessEnv {
  return {
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    HOME: root,
    LANG: 'C',
    LC_ALL: 'C',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_AUTHOR_NAME: author.name,
    GIT_AUTHOR_EMAIL: author.email,
    GIT_COMMITTER_NAME: COMMITTER.name,
    GIT_COMMITTER_EMAIL: COMMITTER.email,
  };
}

export interface GitResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs the Codex's git. Disabled (every call a no-op) when no binary is available. */
export class CodexGit {
  readonly root: string;
  readonly binary: string | null;
  readonly timeoutMs: number;

  constructor(root: string, binary: string | null | undefined, timeoutMs = 15_000) {
    this.root = root;
    const candidate = binary === undefined ? DEFAULT_GIT_BINARY : binary;
    this.binary = candidate && existsSync(candidate) ? candidate : null;
    this.timeoutMs = timeoutMs;
  }

  get enabled(): boolean {
    return this.binary !== null;
  }

  run(args: readonly string[], author?: GitIdentity): Promise<GitResult> {
    const binary = this.binary;
    if (!binary) return Promise.resolve({ code: 0, stdout: '', stderr: '' });
    return new Promise((resolve) => {
      execFile(
        binary,
        [...ISOLATION_ARGS, ...args],
        {
          cwd: this.root,
          env: gitEnv(this.root, author),
          timeout: this.timeoutMs,
          maxBuffer: 4 * 1024 * 1024,
          windowsHide: true,
        },
        (err, stdout, stderr) => {
          const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
          resolve({ code, stdout: String(stdout), stderr: String(stderr) });
        },
      );
    });
  }

  /** `git init` without templates (so no sample hooks), if the root is not a repo yet. */
  async init(): Promise<void> {
    if (!this.enabled || existsSync(`${this.root}/.git`)) return;
    const res = await this.run(['init', '-q', '--template=']);
    if (res.code !== 0) throw new Error(`git init failed: ${res.stderr.trim()}`);
  }

  /** Stages `paths` (additions, edits and removals) and commits them as `author`. False when nothing changed. */
  async commit(paths: readonly string[], message: string, author: GitIdentity): Promise<boolean> {
    if (!this.enabled) return false;
    const add = await this.run(['add', '-A', '--', ...paths], author);
    if (add.code !== 0) throw new Error(`git add failed: ${add.stderr.trim()}`);
    const status = await this.run(['diff', '--cached', '--quiet'], author);
    if (status.code === 0) return false;
    const res = await this.run(['commit', '-q', '--no-verify', '-m', message.slice(0, 200)], author);
    if (res.code !== 0) throw new Error(`git commit failed: ${res.stderr.trim()}`);
    return true;
  }

  /** Commit history of one file, newest first. */
  async log(relPath: string, limit = 20): Promise<CodexHistoryEntry[]> {
    if (!this.enabled) return [];
    const res = await this.run([
      'log',
      `-n${Math.max(1, Math.min(200, limit))}`,
      '--format=%H%x1f%an%x1f%ae%x1f%aI%x1f%s%x1e',
      '--',
      relPath,
    ]);
    if (res.code !== 0) return [];
    return res.stdout
      .split('\x1e')
      .map((rec) => rec.trim())
      .filter((rec) => rec.length > 0)
      .map((rec) => {
        const [commit = '', authorName = '', authorEmail = '', at = '', message = ''] = rec.split('\x1f');
        return { commit, authorName, authorEmail, at, message };
      });
  }
}
