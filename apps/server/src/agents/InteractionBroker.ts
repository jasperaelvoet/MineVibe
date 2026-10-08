/**
 * InteractionBroker (PLAN §6.4): the `canUseTool` callback. The ToolGate gives no decision only for the broker tools,
 * so everything else that reaches here is denied (fail closed).
 *
 * - **AskUserQuestion** becomes a question card. The brain slot is released while it waits; the answer is
 *   `allow` with `updatedInput: {questions, answers: {[question]: "Oak, Spruce" | free text}}` (S2).
 * - **ExitPlanMode** carries `{}` in CC 2.1.293 (S2): the plan text comes from PlanCapture. Approve = `allow` and
 *   `setPermissionMode('bypassPermissions')` (USER DECISION 2026-10-08: back to the agents' bypass mode, never
 *   `'default'`); Revise = `deny` with the feedback (the agent stays in plan mode). Only plan-first sessions reach it:
 *   ToolGate denies ExitPlanMode outside plan mode.
 * - **EnterPlanMode** is denied (USER DECISION 2026-10-08: agents never put themselves into plan mode; it is not in
 *   the tool list, and ToolGate denies it too).
 * - Cards resolve as `deny` with a reason on interrupt, kick, death, dismiss or world end (PendingStore.cleanup), and
 *   when the SDK aborts the call.
 */

import { CardQuestion, CHAT_MAX_LENGTH } from '@minevibe/protocol';
import { z } from 'zod';
import { AGENT_PERMISSION_MODE } from './constants.js';
import { type Card, type CardOutcome, newCardId, type PendingStore } from './PendingStore.js';
import type { PlanCapture } from './PlanCapture.js';
import type { CanUseTool, PermissionMode, PermissionResult } from './sdk.js';

export const AskUserQuestionInput = z.object({
  questions: z.array(CardQuestion).min(1).max(8),
});

export interface BrokerHooks {
  /** A card is up: release the brain slot, show "waiting for the player". */
  onWaitStart(card: Card): void;
  /**
   * The card was answered and the turn will continue: re-acquire a slot (P0, interactive lane) before the SDK hears
   * the answer. Not called for cleanup denials.
   */
  onWaitEnd(card: Card, outcome: CardOutcome): Promise<void>;
  /** Node switches the session's permission mode (and tracks it for the gate). */
  setPermissionMode(mode: PermissionMode): Promise<void>;
}

export interface BrokerOptions {
  readonly agentId: string;
  readonly store: PendingStore;
  readonly plans: PlanCapture;
  readonly hooks: BrokerHooks;
  /** The current seat epoch (plan cards die with the seat). */
  readonly seatEpoch: () => number;
  readonly playerName: () => string;
  readonly now?: () => number;
}

/** What a plan card shows when no plan file was captured. */
export const MISSING_PLAN_TEXT =
  '(No plan file was captured. Ask the agent to describe its plan, or reply with changes to get one.)';

function deny(message: string, interrupt = false): PermissionResult {
  return interrupt ? { behavior: 'deny', message, interrupt: true } : { behavior: 'deny', message };
}

/** Builds the canUseTool callback of one agent. */
export function createInteractionBroker(options: BrokerOptions): CanUseTool {
  const now = options.now ?? Date.now;
  const { store, hooks } = options;

  const wait = (card: Card, signal: AbortSignal, epoch: number | null): Promise<CardOutcome> =>
    new Promise<CardOutcome>((resolve) => {
      let settled = false;
      const finish = (outcome: CardOutcome) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        resolve(outcome);
      };
      const onAbort = () => {
        store.resolve(card.id, { kind: 'denied', reason: 'The turn was interrupted.' });
        finish({ kind: 'denied', reason: 'The turn was interrupted.' });
      };
      store.add(card, { waiter: finish, epoch });
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
      hooks.onWaitStart(card);
    });

  return async (toolName, input, opts): Promise<PermissionResult> => {
    try {
      switch (toolName) {
        case 'AskUserQuestion': {
          const parsed = AskUserQuestionInput.safeParse(input);
          if (!parsed.success) {
            return deny(
              `AskUserQuestion input is malformed: ${parsed.error.issues[0]?.message ?? 'invalid'}`,
            );
          }
          const card: Card = {
            id: newCardId('q'),
            agentId: options.agentId,
            createdAt: now(),
            parked: false,
            presenting: false,
            kind: 'question',
            questions: parsed.data.questions,
            answers: [],
          };
          const outcome = await wait(card, opts.signal, null);
          if (outcome.kind !== 'answered') {
            return deny(
              outcome.kind === 'denied' ? outcome.reason : 'The question was withdrawn.',
              outcome.kind === 'denied' && outcome.interrupt === true,
            );
          }
          await hooks.onWaitEnd(card, outcome);
          const answers: Record<string, string> = {};
          for (const [q, a] of Object.entries(outcome.answers)) answers[q] = a.slice(0, CHAT_MAX_LENGTH);
          return { behavior: 'allow', updatedInput: { ...input, answers } };
        }

        case 'ExitPlanMode': {
          const captured = options.plans.latest()?.text.trim();
          const inline = typeof input.plan === 'string' ? input.plan.trim() : '';
          const plan = (captured && captured.length > 0 ? captured : inline) || MISSING_PLAN_TEXT;
          const card: Card = {
            id: newCardId('p'),
            agentId: options.agentId,
            createdAt: now(),
            parked: false,
            presenting: false,
            kind: 'plan',
            plan: plan.slice(0, 32_000),
          };
          const outcome = await wait(card, opts.signal, options.seatEpoch());
          if (outcome.kind === 'approved') {
            await hooks.onWaitEnd(card, outcome);
            // USER DECISION 2026-10-08: back to bypassPermissions, never 'default'. Awaited before the allow is
            // returned (verified live in this order: the next calls run in bypassPermissions).
            await hooks.setPermissionMode(AGENT_PERMISSION_MODE);
            options.plans.clear();
            return { behavior: 'allow', updatedInput: input };
          }
          if (outcome.kind === 'revise') {
            await hooks.onWaitEnd(card, outcome);
            return deny(
              `${options.playerName()} wants changes to the plan: ${outcome.feedback}\nUpdate the plan file, then call ExitPlanMode again.`,
            );
          }
          return deny(
            outcome.kind === 'denied' ? outcome.reason : 'The plan was not approved.',
            outcome.kind === 'denied' && outcome.interrupt === true,
          );
        }

        case 'EnterPlanMode':
          // USER DECISION 2026-10-08: no automatic plan mode. Only the player's Plan-first toggle starts one.
          return deny(
            `You can't switch yourself into plan mode. ${options.playerName()} turns on Plan-first for you when they want a plan first.`,
          );

        default:
          return deny(`${toolName} is not permitted.`);
      }
    } catch (err) {
      return deny(`Permission broker error: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
}
