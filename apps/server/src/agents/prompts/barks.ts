/**
 * Scripted, zero-token bark keys Node asks the mod to play (`agent.say{bark}`); the mod renders them from its own
 * table with cooldowns (PLAN §7.3, full design §6.3). Node only picks the key.
 */

export const BARKS = {
  /** A brain wake starts: "Hmm, one sec…" hides model latency. */
  wake: 'wake',
  /** A new agent arrives at the office door. */
  reportingForDuty: 'reporting_for_duty',
  /** Sat down at a PC ("big brain time"). */
  satAtPc: 'sat_at_pc',
  /** Kicked off a PC. */
  kicked: 'kicked',
  /** Usage is getting low. */
  tired: 'tired',
  /** Out of usage (Zz). */
  asleep: 'asleep',
  /** A teammate died. */
  teammateDied: 'teammate_died',
  /** Last words of a non-CEO agent when the player dies. */
  lastWords: 'last_words',
  /** Dismissed: waves and walks off. */
  farewell: 'farewell',
  /** Has a question for the player. */
  question: 'question',
  /** The brain is offline. */
  brainOffline: 'brain_offline',
  /** Promoted to CEO. */
  promoted: 'promoted',
} as const;

export type BarkKey = (typeof BARKS)[keyof typeof BARKS];
