import type { ComponentStats } from './ComponentPerformanceTracker';
import type { SignalWeights } from './WeightStore';

const WEIGHT_STEP = 0.05;
const MIN_WEIGHT = 0.05;
const MAX_WEIGHT = 0.60;
const RSI_LOSS_STREAK_THRESHOLD = 3;
const MIN_STAT_TRADES = 5;

export class AdaptiveWeightAdjuster {
  adjustWeights(stats: ComponentStats, current: SignalWeights): SignalWeights {
    const w = {
      ema: current.ema,
      rsi: current.rsi,
      momentum: current.momentum,
      imbalance: current.imbalance,
    };

    // Step 1: apply per-component deltas (only if enough trades)
    if (stats.ema.total >= MIN_STAT_TRADES) {
      if (stats.ema.winRate > 0.60) w.ema += WEIGHT_STEP;
      if (stats.ema.winRate < 0.40) w.ema -= WEIGHT_STEP;
    }

    if (stats.rsi.total >= MIN_STAT_TRADES) {
      if (stats.rsi.lossStreak > RSI_LOSS_STREAK_THRESHOLD) w.rsi -= WEIGHT_STEP;
      if (stats.rsi.winRate > 0.60) w.rsi += WEIGHT_STEP;
    }

    if (stats.momentum.total >= MIN_STAT_TRADES) {
      if (stats.momentum.winRate > 0.60) w.momentum += WEIGHT_STEP;
      if (stats.momentum.winRate < 0.40) w.momentum -= WEIGHT_STEP;
    }

    if (stats.imbalance.total >= MIN_STAT_TRADES) {
      if (stats.imbalance.winRate > 0.60) w.imbalance += WEIGHT_STEP;
      if (stats.imbalance.winRate < 0.40) w.imbalance -= WEIGHT_STEP;
    }

    // Step 2: clamp each to [MIN_WEIGHT, MAX_WEIGHT]
    w.ema = Math.min(MAX_WEIGHT, Math.max(MIN_WEIGHT, w.ema));
    w.rsi = Math.min(MAX_WEIGHT, Math.max(MIN_WEIGHT, w.rsi));
    w.momentum = Math.min(MAX_WEIGHT, Math.max(MIN_WEIGHT, w.momentum));
    w.imbalance = Math.min(MAX_WEIGHT, Math.max(MIN_WEIGHT, w.imbalance));

    // Step 3: normalise so sum === 1.0
    const total = w.ema + w.rsi + w.momentum + w.imbalance;
    w.ema /= total;
    w.rsi /= total;
    w.momentum /= total;
    w.imbalance /= total;

    return w;
  }
}

export const adaptiveWeightAdjuster = new AdaptiveWeightAdjuster();
