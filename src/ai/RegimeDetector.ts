import { config } from '../config';

// ── Types ─────────────────────────────────────────────────────────────────────

export type Regime = 'TREND_UP' | 'TREND_DOWN' | 'SIDEWAY' | 'HIGH_VOLATILITY';

export interface RegimeResult {
  regime: Regime;
  atrPct: number;   // ATR as % of current price (e.g. 0.004 = 0.4%)
  bbWidth: number;  // (upperBand - lowerBand) / middleBand
  volRatio: number; // currentVolume / avg10Volume
}

export interface RegimeStrategyConfig {
  // Entry
  entryScoreEdge: number;
  skipEntry: boolean;

  // Sizing
  volatilitySizingFactor: number;

  // Hold time
  holdMultiplier: number;

  // Exit
  slBufferMultiplier: number;
  suppressEarlyExit: boolean;
}

// ── RegimeDetector ────────────────────────────────────────────────────────────

export class RegimeDetector {
  /**
   * Compute 14-period ATR (simple average of true ranges).
   * True range for candle i = max(high-low, |high-prevClose|, |low-prevClose|)
   */
  computeATR(highs: number[], lows: number[], closes: number[], period: number): number {
    const trueRanges: number[] = [];

    for (let i = 1; i < closes.length; i++) {
      const high = highs[i];
      const low = lows[i];
      const prevClose = closes[i - 1];

      const tr = Math.max(
        high - low,
        Math.abs(high - prevClose),
        Math.abs(low - prevClose)
      );
      trueRanges.push(tr);
    }

    if (trueRanges.length === 0) return 0;

    const recent = trueRanges.slice(-period);
    return recent.reduce((sum, v) => sum + v, 0) / recent.length;
  }

  /**
   * Compute Bollinger Band width: (upperBand - lowerBand) / middleBand
   * Uses population std dev over the last `period` closes.
   */
  computeBBWidth(closes: number[], period: number, stdDevMult: number): number {
    const recent = closes.slice(-period);
    const n = recent.length;
    if (n === 0) return 0;

    const mean = recent.reduce((sum, v) => sum + v, 0) / n;
    if (mean === 0) return 0;

    const variance = recent.reduce((sum, v) => sum + (v - mean) ** 2, 0) / n;
    const std = Math.sqrt(variance);

    return (2 * stdDevMult * std) / mean;
  }

  /**
   * Compute volume ratio: currentVolume / avg(volumes[-lookback-1 : -1])
   * Returns 1.0 when insufficient data or average is zero.
   */
  computeVolumeRatio(volumes: number[], lookback: number): number {
    if (volumes.length < 2) return 1.0;

    const currentVol = volumes[volumes.length - 1];
    const priorSlice = volumes.slice(-lookback - 1, -1);
    if (priorSlice.length === 0) return 1.0;

    const avg = priorSlice.reduce((sum, v) => sum + v, 0) / priorSlice.length;
    if (avg === 0) return 1.0;

    return currentVol / avg;
  }

  /**
   * Detect the current market regime from candle arrays and EMA21.
   * Priority: HIGH_VOLATILITY → TREND_UP → TREND_DOWN → SIDEWAY
   */
  detect(
    closes: number[],
    highs: number[],
    lows: number[],
    volumes: number[],
    ema21Last: number
  ): RegimeResult {
    const currentPrice = closes[closes.length - 1];

    const atr = this.computeATR(highs, lows, closes, config.REGIME_ATR_PERIOD);
    const atrPct = currentPrice > 0 ? atr / currentPrice : 0;

    const bbWidth = this.computeBBWidth(closes, config.REGIME_BB_PERIOD, config.REGIME_BB_STD_DEV);

    const volRatio = this.computeVolumeRatio(volumes, config.REGIME_VOL_LOOKBACK);

    let regime: Regime;

    if (atrPct > config.REGIME_HIGH_VOL_THRESHOLD) {
      regime = 'HIGH_VOLATILITY';
    } else if (
      currentPrice > ema21Last * (1 + config.REGIME_TREND_EMA_BAND) &&
      bbWidth > config.REGIME_BB_TREND_MIN
    ) {
      regime = 'TREND_UP';
    } else if (
      currentPrice < ema21Last * (1 - config.REGIME_TREND_EMA_BAND) &&
      bbWidth > config.REGIME_BB_TREND_MIN
    ) {
      regime = 'TREND_DOWN';
    } else {
      regime = 'SIDEWAY';
    }

    return { regime, atrPct, bbWidth, volRatio };
  }
}

// ── getRegimeStrategyConfig ───────────────────────────────────────────────────

export function getRegimeStrategyConfig(regime: Regime): RegimeStrategyConfig {
  switch (regime) {
    case 'TREND_UP':
    case 'TREND_DOWN':
      return {
        entryScoreEdge: 0.02,
        skipEntry: false,
        volatilitySizingFactor: 1.0,
        holdMultiplier: config.REGIME_TREND_HOLD_MULT,
        slBufferMultiplier: 1.0,
        suppressEarlyExit: config.REGIME_TREND_SUPPRESS_EARLY_EXIT,
      };

    case 'SIDEWAY':
      return {
        entryScoreEdge: 0.05,
        skipEntry: false,
        volatilitySizingFactor: config.REGIME_SIDEWAY_SIZE_FACTOR,
        holdMultiplier: config.REGIME_SIDEWAY_HOLD_MULT,
        slBufferMultiplier: 1.0,
        suppressEarlyExit: false,
      };

    case 'HIGH_VOLATILITY':
      return {
        entryScoreEdge: 0.08,
        skipEntry: config.REGIME_HIGH_VOL_SKIP_ENTRY,
        volatilitySizingFactor: config.REGIME_HIGH_VOL_SIZE_FACTOR,
        holdMultiplier: config.REGIME_HIGH_VOL_HOLD_MULT,
        slBufferMultiplier: config.REGIME_HIGH_VOL_SL_MULT,
        suppressEarlyExit: false,
      };
  }
}
