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
  /**
   * The body's walk keeps failing from the same spot (an urgency-2 `stuck` event): "I'm stuck, I can't find a way
   * there. Can you help?"
   */
  stuck: 'stuck',
  /** The body cannot get out of water (the WaterEscape reflex gave up): "I'm stuck in water — can you help or should I dig out?" */
  stuckInWater: 'stuck_in_water',
} as const;

export type BarkKey = (typeof BARKS)[keyof typeof BARKS];
