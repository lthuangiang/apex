import { describe, it, expect } from 'vitest';
import { FakeBreakoutFilter } from '../FakeBreakoutFilter.js';
import { config } from '../../config.js';

const filter = new FakeBreakoutFilter();

// A score that is clearly a breakout (well beyond the edge threshold)
const BREAKOUT_SCORE = 0.5 + config.CHOP_BREAKOUT_SCORE_EDGE + 0.05; // e.g. 0.63

// Sufficient volume and neutral imbalance (no fake breakout conditions)
const GOOD_VOL = config.CHOP_BREAKOUT_VOL_MIN + 0.2;       // e.g. 1.0
const NEUTRAL_IMBALANCE = 0;

// Low volume (triggers low_volume condition)
const LOW_VOL = config.CHOP_BREAKOUT_VOL_MIN - 0.1;        // e.g. 0.7

// Imbalance that contradicts a long direction
const NEGATIVE_IMBALANCE = -(config.CHOP_BREAKOUT_IMBALANCE_THRESHOLD + 0.05); // e.g. -0.2

// Imbalance that contradicts a short direction
const POSITIVE_IMBALANCE = config.CHOP_BREAKOUT_IMBALANCE_THRESHOLD + 0.05;    // e.g. 0.2

describe('FakeBreakoutFilter', () => {
  it('1. non-breakout score → always false regardless of volRatio/imbalance', () => {
    // score within the edge band → not a breakout attempt, skip filter
    const nonBreakoutScore = 0.5 + config.CHOP_BREAKOUT_SCORE_EDGE; // exactly at edge
    const result = filter.check(
      { score: nonBreakoutScore, volRatio: LOW_VOL, imbalance: NEGATIVE_IMBALANCE },
      'long'
    );
    expect(result).toEqual({ isFakeBreakout: false, reason: null });
  });

  it('2. breakout + low volume only → low_volume', () => {
    const result = filter.check(
      { score: BREAKOUT_SCORE, volRatio: LOW_VOL, imbalance: NEUTRAL_IMBALANCE },
      'long'
    );
    expect(result).toEqual({ isFakeBreakout: true, reason: 'low_volume' });
  });

  it('3. breakout + long + negative imbalance contradiction → imbalance_contradiction', () => {
    const result = filter.check(
      { score: BREAKOUT_SCORE, volRatio: GOOD_VOL, imbalance: NEGATIVE_IMBALANCE },
      'long'
    );
    expect(result).toEqual({ isFakeBreakout: true, reason: 'imbalance_contradiction' });
  });

  it('4. breakout + short + positive imbalance contradiction → imbalance_contradiction', () => {
    const result = filter.check(
      { score: BREAKOUT_SCORE, volRatio: GOOD_VOL, imbalance: POSITIVE_IMBALANCE },
      'short'
    );
    expect(result).toEqual({ isFakeBreakout: true, reason: 'imbalance_contradiction' });
  });

  it('5. breakout + both conditions → both', () => {
    const result = filter.check(
      { score: BREAKOUT_SCORE, volRatio: LOW_VOL, imbalance: NEGATIVE_IMBALANCE },
      'long'
    );
    expect(result).toEqual({ isFakeBreakout: true, reason: 'both' });
  });

  it('6. breakout + sufficient volume + neutral imbalance → no fake breakout', () => {
    const result = filter.check(
      { score: BREAKOUT_SCORE, volRatio: GOOD_VOL, imbalance: NEUTRAL_IMBALANCE },
      'long'
    );
    expect(result).toEqual({ isFakeBreakout: false, reason: null });
  });

  it('7. design doc example: score=0.62, volRatio=0.6, imbalance=-0.2, direction=long → both', () => {
    const result = filter.check(
      { score: 0.62, volRatio: 0.6, imbalance: -0.2 },
      'long'
    );
    expect(result).toEqual({ isFakeBreakout: true, reason: 'both' });
  });
});
