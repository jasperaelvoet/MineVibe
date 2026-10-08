import type { SpacesdClientLike, SpacesdProcessLike } from '@trycua/cua';
import type { Logger } from 'pino';
import { withDeadline } from './deadline.js';
import { GUEST_DISPLAY, GUEST_HOME, GUEST_USER } from './guest.js';

/**
 * ShellMirror (PLAN §6.2): while an agent sits at a PC, a terminal window on the PC's own screen tails
 * `~/.mv/shell.log`, which every `pc__bash` call appends to, so a player walking by sees the agent's commands and
 * their output on the monitor. It opens when the agent sits down and closes when it stands up (or is kicked).
 *
 * The terminal runs as `cua` on the guest display with `MV_MIRROR=<pcId>` in its environment; closing kills the
 * spawned process and sweeps every process carrying that variable (a mirror left by an earlier Node run included).
 */

/**
 * Rotates the log when it grows past 4 MB, writes a header for the agent and follows the file. The tool server's
 * `__MV_PWD__` cwd markers are cut out of what the terminal shows.
 */
export const MIRROR_SCRIPT = `mkdir -p ~/.mv && touch ~/.mv/shell.log
s=$(stat -c %s ~/.mv/shell.log 2>/dev/null || echo 0)
if [ "$s" -gt 4000000 ]; then tail -c 1000000 ~/.mv/shell.log > ~/.mv/shell.log.tmp && mv ~/.mv/shell.log.tmp ~/.mv/shell.log; fi
printf '\\n\\033[1;36m── %s sat down at %s (%s) ──\\033[0m\\n' "$1" "$2" "$(date '+%H:%M')" >> ~/.mv/shell.log
tail -n 200 -F ~/.mv/shell.log 2>/dev/null | sed -u 's/__MV_PWD__.*$//'`;

/** The window title of a PC's mirror. */
export function mirrorTitle(agentLabel: string): string {
  return `Shell: ${agentLabel}`;
}

export interface ShellMirrorOptions {
  /** The connected spacesd client of a running PC. */
  readonly client: (pcId: string) => Promise<SpacesdClientLike>;
  /** Kills every guest process whose environment holds `name=value` (PcGuestApi.sweep). */
  readonly sweep: (pcId: string, name: string, value: string) => Promise<number>;
  readonly logger?: Logger;
  /** Deadline of the spawn and kill calls (default 8 s). */
  readonly callTimeoutMs?: number;
  /** Terminal geometry (columns x rows + x + y). */
  readonly geometry?: string;
}

export class ShellMirror {
  readonly #o: ShellMirrorOptions;
  readonly #open = new Map<string, { agentId: string; proc: SpacesdProcessLike | null }>();
  /** Serializes open/close per PC. */
  readonly #locks = new Map<string, Promise<unknown>>();
  readonly #timeoutMs: number;

  constructor(options: ShellMirrorOptions) {
    this.#o = options;
    this.#timeoutMs = options.callTimeoutMs ?? 8_000;
  }

  /** The agent whose mirror is open on a PC, or null. */
  openFor(pcId: string): string | null {
    return this.#open.get(pcId)?.agentId ?? null;
  }

  /** Opens the mirror for `agentId` (replacing any mirror already on the PC). Never throws. */
  open(pcId: string, agentId: string, label = agentId): Promise<void> {
    return this.#serialize(pcId, async () => {
      if (this.#open.get(pcId)?.agentId === agentId) return;
      await this.#closeNow(pcId);
      try {
        const c = await this.#o.client(pcId);
        const proc = await withDeadline(this.#timeoutMs, 'shell mirror', (signal) =>
          c.spawn(
            {
              program: 'xfce4-terminal',
              args: [
                '--disable-server',
                `--title=${mirrorTitle(label)}`,
                `--geometry=${this.#o.geometry ?? '110x32+40+40'}`,
                '--hide-menubar',
                '--hide-toolbar',
                '-x',
                'bash',
                '-c',
                MIRROR_SCRIPT,
                'mirror',
                label,
                pcId,
              ],
              env: new Map([
                ['DISPLAY', GUEST_DISPLAY],
                ['HOME', GUEST_HOME],
                ['MV_MIRROR', pcId],
              ]),
              user: GUEST_USER,
              stdin: false,
              tag: `mv-mirror-${pcId}`,
            },
            { signal },
          ),
        );
        this.#open.set(pcId, { agentId, proc });
      } catch (err) {
        this.#o.logger?.warn({ pcId, agentId, err: String(err) }, 'could not open the shell mirror');
      }
    });
  }

  /** Closes the PC's mirror (if any). Never throws. */
  close(pcId: string): Promise<void> {
    return this.#serialize(pcId, () => this.#closeNow(pcId));
  }

  /** Forgets a PC whose guest is gone (stopped, recreated): nothing is left to close. */
  forget(pcId: string): void {
    this.#open.delete(pcId);
  }

  /** Closes every mirror (shutdown), each bounded by the call deadline. */
  async closeAll(): Promise<void> {
    await Promise.all([...this.#open.keys()].map((pcId) => this.close(pcId)));
  }

  async #closeNow(pcId: string): Promise<void> {
    const cur = this.#open.get(pcId);
    this.#open.delete(pcId);
    if (cur?.proc) {
      const proc = cur.proc;
      await withDeadline(this.#timeoutMs, 'shell mirror kill', (signal) => proc.kill({ signal })).catch(
        () => {},
      );
    }
    // Also anything an earlier run left (the terminal forks; the tail inherits MV_MIRROR).
    await this.#o.sweep(pcId, 'MV_MIRROR', pcId).catch((err: unknown) => {
      this.#o.logger?.debug({ pcId, err: String(err) }, 'shell mirror sweep failed');
    });
  }

  #serialize(pcId: string, fn: () => Promise<void>): Promise<void> {
    const prev = this.#locks.get(pcId) ?? Promise.resolve();
    const next = prev.then(fn, fn).catch(() => {});
    this.#locks.set(pcId, next);
    void next.then(() => {
      if (this.#locks.get(pcId) === next) this.#locks.delete(pcId);
    });
    return next;
  }
}
