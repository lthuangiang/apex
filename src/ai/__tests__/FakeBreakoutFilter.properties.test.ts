import { describe, it } from 'vitest';
import * as fc from 'fast-check';
import { FakeBreakoutFilter } from '../FakeBreakoutFilter.js';
import { config } from '../../config.js';

const filter = new FakeBreakoutFilter();

// ── Arbitraries ───────────────────────────────────────────────────────────────

const directionArb = fc.constantFrom('long', 'short') as fc.Arbitrary<'long' | 'short'>;

// Scores within the non-breakout band: |score - 0.5| <= CHOP_BREAKOUT_SCORE_EDGE
// Shrink slightly inward to avoid float precision issues at the boundary
const EDGE = config.CHOP_BREAKOUT_SCORE_EDGE;
const nonBreakoutScoreArb = fc.float({
  min: Math.fround(0.5 - EDGE + 0.001),
  max: Math.fround(0.5 + EDGE - 0.001),
  noNaN: true,
  noDefaultInfinity: true,
});

// Scores clearly outside the band: |score - 0.5| > CHOP_BREAKOUT_SCORE_EDGE
// Use two ranges: [0, 0.5 - edge) and (0.5 + edge, 1]
const breakoutScoreArb = fc.oneof(
  fc.float({
    min: Math.fround(0),
    max: Math.fround(0.5 - EDGE - 0.001),
    noNaN: true,
    noDefaultInfinity: true,
  }),
  fc.float({
    min: Math.fround(0.5 + EDGE + 0.001),
    max: Math.fround(1),
    noNaN: true,
    noDefaultInfinity: true,
  })
);

const volRatioArb = fc.float({ min: Math.fround(0), max: Math.fround(3), noNaN: true, noDefaultInfinity: true });
const imbalanceArb = fc.float({ min: Math.fround(-1), max: Math.fround(1), noNaN: true, noDefaultInfinity: true });

// ── Properties ────────────────────────────────────────────────────────────────

describe('FakeBreakoutFilter — property-based tests', () => {
  /**
   * Property 4 (non-breakout never filtered): for any signal where
   * |score - 0.5| <= config.CHOP_BREAKOUT_SCORE_EDGE, check() returns
   * isFakeBreakout === false regardless of volRatio or imbalance.
   * Validates: Requirements 2.1
   */
  it('Property 4: non-breakout score always returns isFakeBreakout === false', () => {
    fc.assert(
      fc.property(
        nonBreakoutScoreArb,
        volRatioArb,
        imbalanceArb,
        directionArb,
        (score, volRatio, imbalance, direction) => {
          const result = filter.check({ score, volRatio, imbalance }, direction);
          return result.isFakeBreakout === false;
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * Property 5 (reason non-null when flagged): for any inputs where check()
   * returns isFakeBreakout === true, result.reason is non-null
   * (one of 'low_volume', 'imbalance_contradiction', 'both').
   * Validates: Requirements 2.2
   */
  it('Property 5: reason is non-null whenever isFakeBreakout is true', () => {
    fc.assert(
      fc.property(
        breakoutScoreArb,
        volRatioArb,
        imbalanceArb,
        directionArb,
        (score, volRatio, imbalance, direction) => {
          const result = filter.check({ score, volRatio, imbalance }, direction);
          if (result.isFakeBreakout) {
            return (
              result.reason === 'low_volume' ||
              result.reason === 'imbalance_contradiction' ||
              result.reason === 'both'
            );
          }
          // Not flagged — property doesn't constrain reason here
          return true;
        }
      ),
      { numRuns: 100 }
    );
  });
});
