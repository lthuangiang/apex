import { config } from '../config.js';

export interface SignalHistoryEntry {
  direction: 'long' | 'short' | 'skip';
  score: number;
  ts: number;
}

export interface ChopResult {
  chopScore: number;        // [0, 1] — 0 = clean, 1 = maximum chop
  isChoppy: boolean;        // chopScore >= CHOP_SCORE_THRESHOLD
  flipRate: number;         // [0, 1] — fraction of direction changes in window
  momNeutrality: number;    // [0, 1] — how close score is to 0.5
  bbCompression: number;    // [0, 1] — how compressed BB width is
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export class ChopDetector {
  evaluate(
    signal: { score: number; bbWidth: number },
    signalHistory: SignalHistoryEntry[]
  ): ChopResult {
    // Compute flipRate: count adjacent direction changes, skipping 'skip' entries
    let flipRate = 0.0;
    if (signalHistory.length >= 2) {
      const nonSkip = signalHistory.filter(e => e.direction !== 'skip');
      let flips = 0;
      for (let i = 1; i < nonSkip.length; i++) {
        if (nonSkip[i].direction !== nonSkip[i - 1].direction) {
          flips++;
        }
      }
      flipRate = flips / (signalHistory.length - 1);
    }

    // Compute momNeutrality: 1 = perfectly neutral (score=0.5), 0 = strong directional
    const momNeutrality = 1.0 - clamp(Math.abs(signal.score - 0.5) / 0.5, 0.0, 1.0);

    // Compute bbCompression: 1 = maximally compressed, 0 = wide bands
    let bbCompression: number;
    if (signal.bbWidth <= 0) {
      bbCompression = 1.0;
    } else {
      bbCompression = clamp(1.0 - (signal.bbWidth / config.CHOP_BB_COMPRESS_MAX - 1.0), 0.0, 1.0);
    }

    // Weighted sum
    const chopScore = clamp(
      flipRate * config.CHOP_FLIP_WEIGHT +
      momNeutrality * config.CHOP_MOM_WEIGHT +
      bbCompression * config.CHOP_BB_WEIGHT,
      0.0,
      1.0
    );

    return {
      chopScore,
      isChoppy: chopScore >= config.CHOP_SCORE_THRESHOLD,
      flipRate,
      momNeutrality,
      bbCompression,
    };
  }
}
