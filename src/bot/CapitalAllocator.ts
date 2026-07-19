/**
 * CapitalAllocator — Kelly-Based Capital Allocation
 *
 * Computes position sizes for each active strategy using:
 *   baseSize * confidenceMultiplier * performanceMultiplier * regimeVolatilityFactor
 *
 * Enforces:
 *   - ExposureCap (total open notional limit)
 *   - Drawdown floor (halves size when losing)
 *   - Farm/Trade capital split ratio
 *   - ORDER_SIZE_MIN / ORDER_SIZE_MAX clamping
 *
 * Requirements: 6.1–6.9
 */

import type { SelectedStrategy } from './StrategySelector.js';
import type { MarketRegime } from '../ai/SoSoValueIntelligenceEngine.js';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface AllocationConfig {
  orderSizeMin: number;        // BTC — from config
  orderSizeMax: number;        // BTC — from config
  sizingMaxBtc: number;        // hard ceiling
  sizingConfWeight: number;    // default 0.6
  sizingPerfWeight: number;    // default 0.4
  sizingDrawdownThreshold: number; // e.g. -3.0 USD
  sizingDrawdownFloor: number;     // e.g. 0.5
  exposureCapUsd: number;      // default 500
  farmCapitalRatio: number;    // default 0.6 (farm gets 60%, trade gets 40%)
}

export interface AllocationInput {
  strategy: SelectedStrategy;
  confidenceScore: number;     // 0-1 from Intelligence Engine
  performanceWinRate: number;  // 0-1 rolling win rate for the active strategy
  regime: MarketRegime;
  sessionPnl: number;          // current session PnL (negative = drawdown)
  totalOpenExposureUsd: number; // sum of all open position notional
  kellyBaseSize: number;       // from Intelligence Engine (0.3-1.3)
}

export interface AllocationResult {
  farmSizeBtc: number;
  tradeSizeBtc: number;
  totalAllocatedBtc: number;
  reasoning: string;
  breakdown: {
    baseSize: number;
    confidenceMultiplier: number;
    performanceMultiplier: number;
    regimeVolatilityFactor: number;
    drawdownMultiplier: number;
    exposureReduction: number;
    finalSize: number;
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// CAPITAL ALLOCATOR
// ═══════════════════════════════════════════════════════════════════════════════

export class CapitalAllocator {
  private cfg: AllocationConfig;

  constructor(cfg: AllocationConfig) {
    this.cfg = cfg;
  }

  /**
   * Update configuration at runtime (e.g. from /agent/config PATCH)
   */
  updateConfig(patch: Partial<AllocationConfig>): void {
    Object.assign(this.cfg, patch);
  }

  /**
   * Compute capital allocation for the current cycle.
   *
   * Requirements: 6.1–6.9
   */
  allocate(input: AllocationInput): AllocationResult {
    const { strategy, confidenceScore, performanceWinRate, regime, sessionPnl, totalOpenExposureUsd, kellyBaseSize } = input;

    // ── Step 1: Base size from Kelly (Req 6.1) ───────────────────────────────
    const baseSize = kellyBaseSize * this.cfg.orderSizeMax;

    // ── Step 2: Confidence multiplier (Req 6.6) ──────────────────────────────
    // Scale between 0.6 and 1.4 based on confidence
    const confidenceMultiplier = 0.6 + confidenceScore * 0.8;

    // ── Step 3: Performance multiplier (Req 6.6) ─────────────────────────────
    // Win rate maps to 0.7-1.3 range
    const performanceMultiplier = 0.7 + performanceWinRate * 0.6;

    // ── Step 4: Regime volatility factor ─────────────────────────────────────
    const regimeVolatilityFactor = this._regimeFactor(regime);

    // ── Step 5: Drawdown guard (Req 6.3) ─────────────────────────────────────
    let drawdownMultiplier = 1.0;
    if (sessionPnl < this.cfg.sizingDrawdownThreshold) {
      drawdownMultiplier = this.cfg.sizingDrawdownFloor;
    }

    // ── Step 6: Exposure cap reduction (Req 6.4, 6.5) ────────────────────────
    let exposureReduction = 1.0;
    const exposureRatio = totalOpenExposureUsd / this.cfg.exposureCapUsd;
    if (exposureRatio >= 1.0) {
      // At or over cap — block allocation
      exposureReduction = 0;
    } else if (exposureRatio >= 0.8) {
      // Within 80-100% of cap — reduce by 50% (Req 6.5)
      exposureReduction = 0.5;
    }

    // ── Step 7: Combine multipliers (Req 6.1) ────────────────────────────────
    const rawSize = baseSize
      * (this.cfg.sizingConfWeight * confidenceMultiplier + this.cfg.sizingPerfWeight * performanceMultiplier)
      * regimeVolatilityFactor
      * drawdownMultiplier
      * exposureReduction;

    // ── Step 8: Clamp to [min, max] (Req 6.2) ───────────────────────────────
    const clampedSize = Math.max(
      this.cfg.orderSizeMin,
      Math.min(rawSize, this.cfg.sizingMaxBtc),
    );

    // Req 6.7: final size must be > 0 and <= SIZING_MAX_BTC
    const finalSize = exposureReduction === 0 ? 0 : clampedSize;

    // ── Step 9: Split between Farm/Trade (Req 6.9) ───────────────────────────
    let farmSizeBtc = 0;
    let tradeSizeBtc = 0;

    switch (strategy) {
      case 'FARM':
        farmSizeBtc = finalSize;
        break;
      case 'TRADE':
        tradeSizeBtc = finalSize;
        break;
      case 'BOTH':
        farmSizeBtc = finalSize * this.cfg.farmCapitalRatio;
        tradeSizeBtc = finalSize * (1 - this.cfg.farmCapitalRatio);
        // Clamp each individually
        farmSizeBtc = Math.max(this.cfg.orderSizeMin, farmSizeBtc);
        tradeSizeBtc = Math.max(this.cfg.orderSizeMin, tradeSizeBtc);
        break;
      case 'HOLD':
        // No allocation
        break;
    }

    // ── Step 10: Build reasoning (Req 6.8) ───────────────────────────────────
    const reasoning = [
      `base=${baseSize.toFixed(5)}`,
      `conf=${confidenceMultiplier.toFixed(2)}`,
      `perf=${performanceMultiplier.toFixed(2)}`,
      `regime=${regimeVolatilityFactor.toFixed(2)}`,
      `dd=${drawdownMultiplier.toFixed(2)}`,
      `expo=${exposureReduction.toFixed(2)}`,
      `final=${finalSize.toFixed(5)} BTC`,
      strategy === 'BOTH' ? `split: farm=${farmSizeBtc.toFixed(5)} trade=${tradeSizeBtc.toFixed(5)}` : '',
    ].filter(Boolean).join(' | ');

    return {
      farmSizeBtc,
      tradeSizeBtc,
      totalAllocatedBtc: farmSizeBtc + tradeSizeBtc,
      reasoning,
      breakdown: {
        baseSize,
        confidenceMultiplier,
        performanceMultiplier,
        regimeVolatilityFactor,
        drawdownMultiplier,
        exposureReduction,
        finalSize,
      },
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PRIVATE
  // ═══════════════════════════════════════════════════════════════════════════

  private _regimeFactor(regime: MarketRegime): number {
    // Reduce size in volatile/risky regimes, increase in stable regimes
    const factors: Record<MarketRegime, number> = {
      choppy_neutral: 0.85,
      pre_breakout: 0.90,
      accumulation: 1.10,
      distribution: 0.90,
      bull_momentum: 1.15,
      bear_momentum: 1.10,
      overheated: 0.50,
      capitulation: 0.60,
    };
    return factors[regime] ?? 0.80;
  }
}
