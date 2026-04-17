import { config } from '../config';

export interface SizingInput {
  confidence: number;          // calibrated signal confidence [0, 1]
  recentPnLs: number[];        // last N trade PnLs (USD)
  sessionPnl: number;          // running session PnL (USD)
  balance: number;             // current account balance (USD)
  mode: 'farm' | 'trade';
  profile: 'SCALP' | 'NORMAL' | 'RUNNER' | 'DEGEN';
  volatilityFactor?: number;   // regime-based volatility scaling factor [0.1, 1.0]
}

export interface SizingResult {
  size: number;                // final order size (BTC)
  confidenceMultiplier: number;
  performanceMultiplier: number;
  combinedMultiplier: number;
  cappedBy: 'none' | 'btc_cap' | 'balance_pct';
  volatilityFactor: number;    // clamped volatility factor actually applied
}

export class PositionSizer {
  /**
   * Computes the confidence multiplier based on signal confidence and mode.
   * - trade mode: linear scale from 1.0 at MIN_CONFIDENCE to SIZING_MAX_MULTIPLIER at 1.0
   * - farm mode: dampened scale 1.0 + (confidence - 0.5) × 0.6
   * Clamped to [SIZING_MIN_MULTIPLIER, SIZING_MAX_MULTIPLIER].
   */
  confidenceMultiplier(confidence: number, mode: 'farm' | 'trade'): number {
    let multiplier: number;

    if (mode === 'farm') {
      multiplier = 1.0 + (confidence - 0.5) * 0.6;
    } else {
      const range = 1.0 - config.MIN_CONFIDENCE;
      if (range <= 0) {
        multiplier = 1.0;
      } else {
        const normalised = (confidence - config.MIN_CONFIDENCE) / range;
        multiplier = 1.0 + normalised * (config.SIZING_MAX_MULTIPLIER - 1.0);
      }
    }

    return Math.max(config.SIZING_MIN_MULTIPLIER, Math.min(config.SIZING_MAX_MULTIPLIER, multiplier));
  }

  /**
   * Computes the performance multiplier from recent win rate, session drawdown, and profile.
   * - win-rate component: 0% → 0.7×, 50% → 1.0×, 100% → 1.3× (formula: 0.7 + winRate × 0.6); empty → 1.0
   * - drawdown component: neutral (1.0) above threshold; below: severity-based scale clamped to SIZING_MIN_MULTIPLIER
   * - profile bias: SCALP: 0.85, NORMAL: 1.0, RUNNER: 1.15, DEGEN: 0.9
   * Clamped to [SIZING_MIN_MULTIPLIER, SIZING_MAX_MULTIPLIER].
   */
  performanceMultiplier(
    recentPnLs: number[],
    sessionPnl: number,
    profile: 'SCALP' | 'NORMAL' | 'RUNNER' | 'DEGEN'
  ): number {
    // Step 1: win-rate component
    let winRateMult: number;
    if (recentPnLs.length === 0) {
      winRateMult = 1.0;
    } else {
      const wins = recentPnLs.filter(pnl => pnl > 0).length;
      const winRate = wins / recentPnLs.length;
      winRateMult = 0.7 + winRate * 0.6;
    }

    // Step 2: drawdown component
    let drawdownMult: number;
    if (sessionPnl <= config.SIZING_DRAWDOWN_THRESHOLD) {
      const severity = sessionPnl / config.SIZING_DRAWDOWN_THRESHOLD; // >= 1.0 when in drawdown
      drawdownMult = config.SIZING_DRAWDOWN_FLOOR * (1.0 - 0.2 * (severity - 1.0));
      drawdownMult = Math.max(drawdownMult, config.SIZING_MIN_MULTIPLIER);
    } else {
      drawdownMult = 1.0;
    }

    // Step 3: profile bias
    const profileBiasMap: Record<string, number> = {
      SCALP: 0.85,
      NORMAL: 1.0,
      RUNNER: 1.15,
      DEGEN: 0.9,
    };
    const profileBias = profileBiasMap[profile] ?? 1.0;

    // Step 4: combine and clamp
    const multiplier = winRateMult * drawdownMult * profileBias;
    return Math.max(config.SIZING_MIN_MULTIPLIER, Math.min(config.SIZING_MAX_MULTIPLIER, multiplier));
  }

  /**
   * Adds a small random jitter to the size so orders don't repeat the same
   * round number every trade — harder to fingerprint as a bot.
   *
   * Strategy: randomise the last significant decimal digit within ±1 step,
   * then clamp back to [ORDER_SIZE_MIN, ORDER_SIZE_MAX].
   *
   * With sz_decimals=3 (Decibel default), the chain unit is 0.001 BTC.
   * We jitter at the 0.0001 level (sub-unit noise) so the on-chain size
   * still rounds to a valid tick but the float passed to the SDK varies.
   */
  humanizeSize(size: number): number {
    // Jitter at 4th decimal place (0.0001 BTC ≈ $7 at $70k — negligible)
    const jitterStep = 0.0001;
    // Random offset in [-2, +2] steps, biased away from zero to avoid exact repeats
    const steps = Math.floor(Math.random() * 5) - 2; // -2, -1, 0, 1, 2
    const jittered = size + steps * jitterStep;
    // Clamp to valid range
    return Math.max(config.ORDER_SIZE_MIN, Math.min(config.ORDER_SIZE_MAX, jittered));
  }

  /**
   * Applies risk caps to the raw size.
   * - If rawSize > SIZING_MAX_BTC: cap to SIZING_MAX_BTC, cappedBy = 'btc_cap'
   * - If rawSize < ORDER_SIZE_MIN: floor to ORDER_SIZE_MIN
   * - Otherwise: cappedBy = 'none'
   */
  applyRiskCaps(rawSize: number): { size: number; cappedBy: 'none' | 'btc_cap' | 'balance_pct' } {
    let size = rawSize;
    let cappedBy: 'none' | 'btc_cap' | 'balance_pct' = 'none';

    if (size > config.SIZING_MAX_BTC) {
      size = config.SIZING_MAX_BTC;
      cappedBy = 'btc_cap';
    }

    if (size < config.ORDER_SIZE_MIN) {
      size = config.ORDER_SIZE_MIN;
    }

    return { size, cappedBy };
  }

  /**
   * Computes the final order size given a SizingInput.
   * - Draws baseSize from uniform random in [ORDER_SIZE_MIN, ORDER_SIZE_MAX]
   * - Computes confidence and performance multipliers
   * - Combines them as weighted average, clamped to [SIZING_MIN_MULTIPLIER, SIZING_MAX_MULTIPLIER]
   * - Scales baseSize by combined multiplier, then clamps result to [ORDER_SIZE_MIN, ORDER_SIZE_MAX]
   *   before applying the hard BTC cap — this ensures size always varies across the full min-max range
   * - Applies risk caps and returns full SizingResult
   */
  computeSize(input: SizingInput): SizingResult {
    // Step 1: base size — uniform random in [ORDER_SIZE_MIN, ORDER_SIZE_MAX]
    const baseSize =
      config.ORDER_SIZE_MIN +
      Math.random() * (config.ORDER_SIZE_MAX - config.ORDER_SIZE_MIN);

    // Step 2: individual multipliers
    const confMult = this.confidenceMultiplier(input.confidence, input.mode);
    const perfMult = this.performanceMultiplier(input.recentPnLs, input.sessionPnl, input.profile);

    // Step 3: weighted combination, clamped
    const combined = Math.max(
      config.SIZING_MIN_MULTIPLIER,
      Math.min(
        config.SIZING_MAX_MULTIPLIER,
        confMult * config.SIZING_CONF_WEIGHT + perfMult * config.SIZING_PERF_WEIGHT
      )
    );

    // Step 4: raw size — clamp to [ORDER_SIZE_MIN, ORDER_SIZE_MAX] so multiplier
    // scales within the configured range rather than collapsing to the floor
    let rawSize = Math.max(
      config.ORDER_SIZE_MIN,
      Math.min(config.ORDER_SIZE_MAX, baseSize * combined)
    );

    // Step 5: apply volatility factor (clamped to [0.1, 1.0])
    const volFactor = Math.min(1.0, Math.max(0.1, input.volatilityFactor ?? 1.0));
    rawSize *= volFactor;

    // Step 6: apply risk caps (hard BTC cap + final floor)
    const { size, cappedBy } = this.applyRiskCaps(rawSize);

    // Step 7: humanize — add sub-unit jitter so size varies naturally trade-to-trade
    const humanizedSize = this.humanizeSize(size);

    return {
      size: humanizedSize,
      confidenceMultiplier: confMult,
      performanceMultiplier: perfMult,
      combinedMultiplier: combined,
      cappedBy,
      volatilityFactor: volFactor,
    };
  }
}
