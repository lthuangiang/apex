import { describe, it } from 'vitest';
import * as fc from 'fast-check';
import { computeAdaptiveCooldown } from '../AdaptiveCooldown.js';
import { config } from '../../config.js';

// ── Arbitraries ───────────────────────────────────────────────────────────────

const pnlArb = fc.float({ noNaN: true, noDefaultInfinity: true, min: -1000, max: 1000 });

const recentPnLsArb = fc.array(pnlArb, { minLength: 0, maxLength: 20 });

const chopScoreArb = fc.float({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true });

const adaptiveCooldownInputArb = fc.record({
  recentPnLs: recentPnLsArb,
  lastChopScore: chopScoreArb,
});

// recentPnLs with no trailing losses: last element >= 0 or empty
const noTrailingLossesArb = fc.oneof(
  fc.constant([] as number[]),
  fc.array(pnlArb, { minLength: 0, maxLength: 19 }).chain((prefix) =>
    fc.float({ min: 0, max: 1000, noNaN: true, noDefaultInfinity: true }).map((lastWin) => [
      ...prefix,
      lastWin,
    ])
  )
);

// ── Properties ────────────────────────────────────────────────────────────────

describe('AdaptiveCooldown — property-based tests', () => {
  /**
   * Property 6 (cooldown bounds): for any valid AdaptiveCooldownInput,
   * cooldownMs ∈ [COOLDOWN_MIN_MINS × 60000, CHOP_COOLDOWN_MAX_MINS × 60000].
   * Validates: Requirements 4.1
   */
  it('Property 6: cooldownMs is always within [COOLDOWN_MIN_MINS×60000, CHOP_COOLDOWN_MAX_MINS×60000]', () => {
    const minMs = config.COOLDOWN_MIN_MINS * 60_000;
    const maxMs = config.CHOP_COOLDOWN_MAX_MINS * 60_000;

    fc.assert(
      fc.property(adaptiveCooldownInputArb, (input) => {
        const result = computeAdaptiveCooldown(input);
        return result.cooldownMs >= minMs && result.cooldownMs <= maxMs;
      }),
      { numRuns: 100 }
    );
  });

  /**
   * Property 7 (neutral multipliers): for any recentPnLs with no trailing losses
   * (last element >= 0 or empty) and lastChopScore === 0,
   * streakMult === 1.0 and chopMult === 1.0.
   * Validates: Requirements 4.2
   */
  it('Property 7: no trailing losses + chopScore=0 → streakMult=1.0 and chopMult=1.0', () => {
    fc.assert(
      fc.property(noTrailingLossesArb, (recentPnLs) => {
        const result = computeAdaptiveCooldown({ recentPnLs, lastChopScore: 0 });
        return result.streakMult === 1.0 && result.chopMult === 1.0;
      }),
      { numRuns: 100 }
    );
  });

  /**
   * Property 8 (streak monotonicity): for any fixed lastChopScore, a recentPnLs array
   * with a strictly longer trailing loss streak produces streakMult >= the first.
   * Validates: Requirements 4.3
   */
  it('Property 8: longer trailing loss streak produces streakMult >= shorter streak', () => {
    // Build two arrays: shorter has N trailing losses, longer has N+1 trailing losses
    const shorterStreakArb = fc.integer({ min: 0, max: 5 }).chain((n) => {
      const losses = Array.from({ length: n }, (_, i) => -(i + 1));
      // Prefix with a win to anchor the streak
      const prefix: number[] = n > 0 ? [1] : [];
      return fc.constant([...prefix, ...losses]);
    });

    fc.assert(
      fc.property(shorterStreakArb, chopScoreArb, (shorter, lastChopScore) => {
        // Longer = shorter + one more loss appended
        const longer = [...shorter, -1];

        const r1 = computeAdaptiveCooldown({ recentPnLs: shorter, lastChopScore });
        const r2 = computeAdaptiveCooldown({ recentPnLs: longer, lastChopScore });

        return r2.streakMult >= r1.streakMult;
      }),
      { numRuns: 100 }
    );
  });
});
