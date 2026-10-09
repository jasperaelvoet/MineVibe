/**
 * BatchBook (PC tools V2 §4.2): which `pc` calls an assistant message made, in order, so a computer action knows
 * whether it is the last `pc` call of its batch (it then answers with a settled screenshot) and whether an earlier
 * computer action of the same message failed (it then does not run: the trained halt rule).
 *
 * The session feeds it from the stream (`includePartialMessages`): `message_start`, each `tool_use` block start and
 * `message_stop`, plus the complete assistant messages as a fallback. Claude Code runs `pc` tools that are not
 * read-only one at a time, in order, and may start the first before the message ends, so {@link BatchBook.isLast}
 * waits a little for the end of the message.
 */

/** Tool names (as the model wrote them) whose calls run in the PC: `mcp__pc__*` and the aliased built-ins. */
const PC_ALIASES: ReadonlySet<string> = new Set([
  'Bash',
  'Read',
  'Edit',
  'Write',
  'Glob',
  'Grep',
  'TaskStop',
  'KillShell',
]);

export function isPcToolUse(name: string): boolean {
  return name.startsWith('mcp__pc__') || PC_ALIASES.has(name);
}

interface MessageEntry {
  readonly id: string;
  /** The `pc` tool_use ids, in order. */
  readonly calls: string[];
  done: boolean;
  /** A computer action of this message failed: later ones do not run. */
  failedAt: number;
  readonly waiters: (() => void)[];
}

/** How many messages are remembered. */
const KEEP = 64;

export class BatchBook {
  readonly #messages = new Map<string, MessageEntry>();
  readonly #byTool = new Map<string, MessageEntry>();
  /** Calls asked about before their tool_use block was seen (the stream may lag the call a little). */
  readonly #pending = new Map<string, (() => void)[]>();
  /** Computer actions that failed before their tool_use block was seen: applied when it is. */
  readonly #failedEarly = new Set<string>();
  #current: MessageEntry | null = null;

  #entry(id: string): MessageEntry {
    let m = this.#messages.get(id);
    if (!m) {
      m = { id, calls: [], done: false, failedAt: Number.POSITIVE_INFINITY, waiters: [] };
      this.#messages.set(id, m);
      while (this.#messages.size > KEEP) {
        const oldest = this.#messages.values().next().value as MessageEntry;
        this.#messages.delete(oldest.id);
        for (const c of oldest.calls) this.#byTool.delete(c);
        for (const w of oldest.waiters.splice(0)) w();
      }
    }
    return m;
  }

  /** A streamed message started. */
  messageStart(messageId: string): void {
    this.#current = this.#entry(messageId);
  }

  /** A tool_use block started (streamed) or was seen in a complete message. Only `pc` calls are kept. */
  toolUse(messageId: string | null, toolUseId: string, name: string): void {
    if (!isPcToolUse(name) || this.#byTool.has(toolUseId)) return;
    const m = messageId ? this.#entry(messageId) : this.#current;
    if (!m) return;
    m.calls.push(toolUseId);
    this.#byTool.set(toolUseId, m);
    if (this.#failedEarly.delete(toolUseId)) m.failedAt = Math.min(m.failedAt, m.calls.length - 1);
    const waiting = this.#pending.get(toolUseId);
    if (waiting) {
      this.#pending.delete(toolUseId);
      for (const w of waiting) w();
    }
  }

  /** Waits up to `ms` for a call's tool_use block to be seen. */
  async #seen(toolUseId: string, ms: number): Promise<MessageEntry | undefined> {
    const known = this.#byTool.get(toolUseId);
    if (known || ms <= 0) return known;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(done, ms);
      timer.unref?.();
      const list = this.#pending.get(toolUseId) ?? [];
      list.push(done);
      this.#pending.set(toolUseId, list);
      function done() {
        clearTimeout(timer);
        resolve();
      }
    });
    this.#pending.delete(toolUseId);
    return this.#byTool.get(toolUseId);
  }

  /** The message is complete: no more tool calls will join it. */
  messageStop(messageId?: string | null): void {
    const m = messageId ? this.#messages.get(messageId) : this.#current;
    if (!m) return;
    m.done = true;
    for (const w of m.waiters.splice(0)) w();
    if (this.#current === m) this.#current = null;
  }

  /** A complete assistant message (no stream): its pc calls in order; it is complete. */
  assistantMessage(messageId: string, toolUses: readonly { id: string; name: string }[]): void {
    for (const t of toolUses) this.toolUse(messageId, t.id, t.name);
  }

  /**
   * Whether `toolUseId` is the last `pc` call of its message: true / false, or null when the call is unknown (no
   * stream). Waits up to `waitMs` for the message to complete; a message still streaming then counts its known calls.
   */
  async isLast(toolUseId: string | undefined, waitMs = 1_000): Promise<boolean | null> {
    if (!toolUseId) return null;
    const m = await this.#seen(toolUseId, Math.min(waitMs, 300));
    if (!m) return null;
    if (!m.done && waitMs > 0) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, waitMs);
        timer.unref?.();
        m.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    return m.calls.at(-1) === toolUseId;
  }

  /** Whether an earlier computer action of the same message failed (so this one must not run). */
  halted(toolUseId: string | undefined): boolean {
    if (!toolUseId) return false;
    const m = this.#byTool.get(toolUseId);
    if (!m) return false;
    return m.calls.indexOf(toolUseId) > m.failedAt;
  }

  /** A computer action failed: the computer actions after it in its message do not run. */
  fail(toolUseId: string | undefined): void {
    if (!toolUseId) return;
    const m = this.#byTool.get(toolUseId);
    if (!m) {
      // The stream has not shown this call yet: the failure applies once it does.
      this.#failedEarly.add(toolUseId);
      while (this.#failedEarly.size > KEEP) {
        this.#failedEarly.delete(this.#failedEarly.values().next().value as string);
      }
      return;
    }
    m.failedAt = Math.min(m.failedAt, m.calls.indexOf(toolUseId));
  }

  /** Forgets everything (a new session). */
  reset(): void {
    for (const m of this.#messages.values()) for (const w of m.waiters.splice(0)) w();
    this.#messages.clear();
    this.#byTool.clear();
    this.#failedEarly.clear();
    this.#current = null;
  }
}
