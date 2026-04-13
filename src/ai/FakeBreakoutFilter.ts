import { config } from '../config.js';

export interface FakeBreakoutResult {
  isFakeBreakout: boolean;
  reason: 'low_volume' | 'imbalance_contradiction' | 'both' | null;
}

export class FakeBreakoutFilter {
  check(
    signal: { score: number; volRatio: number; imbalance: number },
    direction: 'long' | 'short'
  ): FakeBreakoutResult {
    // Non-breakout: score edge is too small — skip filter
    if (Math.abs(signal.score - 0.5) <= config.CHOP_BREAKOUT_SCORE_EDGE) {
      return { isFakeBreakout: false, reason: null };
    }

    const lowVolume = signal.volRatio < config.CHOP_BREAKOUT_VOL_MIN;

    const imbalanceContradicts =
      (direction === 'long' && signal.imbalance < -config.CHOP_BREAKOUT_IMBALANCE_THRESHOLD) ||
      (direction === 'short' && signal.imbalance > config.CHOP_BREAKOUT_IMBALANCE_THRESHOLD);

    if (lowVolume && imbalanceContradicts) {
      return { isFakeBreakout: true, reason: 'both' };
    }
    if (lowVolume) {
      return { isFakeBreakout: true, reason: 'low_volume' };
    }
    if (imbalanceContradicts) {
      return { isFakeBreakout: true, reason: 'imbalance_contradiction' };
    }

    return { isFakeBreakout: false, reason: null };
  }
}
