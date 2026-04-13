import { describe, it } from 'vitest';
import * as fc from 'fast-check';
import { ChopDetector, SignalHistoryEntry } from '../ChopDetector.js';
import { config } from '../../config.js';

const detector = new ChopDetector();

// ── Arbitraries ───────────────────────────────────────────────────────────────

const signalArb = fc.record({
  score: fc.float({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
  bbWidth: fc.float({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
});

const historyEntryArb: fc.Arbitrary<SignalHistoryEntry> = fc.record({
  direction: fc.constantFrom('long', 'short', 'skip') as fc.Arbitrary<'long' | 'short' | 'skip'>,
  score: fc.float({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
  ts: fc.integer({ min: 0, max: 1_000_000 }),
});

const signalHistoryArb = fc.array(historyEntryArb, { minLength: 0, maxLength: 20 });

const shortHistoryArb = fc.oneof(
  fc.constant([] as SignalHistoryEntry[]),
  fc.array(historyEntryArb, { minLength: 1, maxLength: 1 })
);

// ── Properties ────────────────────────────────────────────────────────────────

describe('ChopDetector — property-based tests', () => {
  /**
   * Property 1 (chop score bounds): for any signal with score ∈ [0,1] and bbWidth >= 0,
   * and any signalHistory array, evaluate().chopScore ∈ [0, 1] and all sub-scores
   * (flipRate, momNeutrality, bbCompression) are in [0, 1].
   * Validates: Requirements 1.1
   */
  it('Property 1: all scores are bounded in [0, 1]', () => {
    fc.assert(
      fc.property(signalArb, signalHistoryArb, (signal, signalHistory) => {
        const result = detector.evaluate(signal, signalHistory);
        return (
          result.chopScore >= 0 && result.chopScore <= 1 &&
          result.flipRate >= 0 && result.flipRate <= 1 &&
          result.momNeutrality >= 0 && result.momNeutrality <= 1 &&
          result.bbCompression >= 0 && result.bbCompression <= 1
        );
      }),
      { numRuns: 100 }
    );
  });

  /**
   * Property 2 (threshold consistency): for any valid inputs,
   * evaluate().isChoppy === (chopScore >= config.CHOP_SCORE_THRESHOLD).
   * Validates: Requirements 1.2
   */
  it('Property 2: isChoppy is consistent with chopScore >= CHOP_SCORE_THRESHOLD', () => {
    fc.assert(
      fc.property(signalArb, signalHistoryArb, (signal, signalHistory) => {
        const result = detector.evaluate(signal, signalHistory);
        return result.isChoppy === (result.chopScore >= config.CHOP_SCORE_THRESHOLD);
      }),
      { numRuns: 100 }
    );
  });

  /**
   * Property 3 (empty history → zero flip rate): for any signalHistory with length < 2,
   * evaluate().flipRate === 0.0.
   * Validates: Requirements 1.3
   */
  it('Property 3: flipRate is 0.0 when signalHistory has fewer than 2 entries', () => {
    fc.assert(
      fc.property(signalArb, shortHistoryArb, (signal, signalHistory) => {
        const result = detector.evaluate(signal, signalHistory);
        return result.flipRate === 0.0;
      }),
      { numRuns: 100 }
    );
  });
});
