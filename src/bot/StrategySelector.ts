/**
 * StrategySelector — Dual-Mode Strategy Selection
 *
 * Evaluates FARM and TRADE strategies each AgentCycle and produces a ranked
 * list of eligible strategies based on:
 *   - Market regime (from SoSoValueIntelligenceEngine)
 *   - Per-strategy rolling win rate
 *   - Cooldown rules (3-cycle cooldown when win rate < 30%)
 *
 * Requirements: 3.1–3.9
 */

import type { MarketRegime } from '../ai/SoSoValueIntelligenceEngine.js';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export type SelectedStrategy = 'FARM' | 'TRADE' | 'BOTH' | 'HOLD';

export interface StrategyEligibility {
  farm: { eligible: boolean; score: number; reason: string };
  trade: { eligible: boolean; score: number; reason: string };
}

export interface StrategySelectionResult {
  selected: SelectedStrategy;
  direction: 'long' | 'short' | 'hold';
  eligibility: StrategyEligibility;
  reasoning: string;
}

export interface StrategyPerformance {
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  recentWinRate: number;  // rolling 10-trade
  totalPnl: number;
  totalVolume: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// STRATEGY SELECTOR
// ═══════════════════════════════════════════════════════════════════════════════

export class StrategySelector {
  private farmPerf: StrategyPerformance;
  private tradePerf: StrategyPerformance;

  // Cooldown state — count cycles remaining
  private farmCooldownCycles = 0;
  private tradeCooldownCycles = 0;

  // Rolling 10-trade results (true = win, false = loss)
  private farmRecentResults: boolean[] = [];
  private tradeRecentResults: boolean[] = [];

  // Risk halt flag — set externally by RiskGate
  private riskHalted = false;

  constructor() {
    this.farmPerf = this._emptyPerformance();
    this.tradePerf = this._emptyPerformance();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PUBLIC API
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Evaluate both strategies and select the best for this cycle.
   *
   * @param regime - Current market regime from Intelligence Engine
   * @param regimeConfidence - 0-1 confidence in regime classification
   * @param bullConviction - 0-100 bull conviction score
   * @param bearConviction - 0-100 bear conviction score
   * @param highVolSkipEntry - config: REGIME_HIGH_VOL_SKIP_ENTRY
   */
  select(
    regime: MarketRegime,
    regimeConfidence: number,
    bullConviction: number,
    bearConviction: number,
    highVolSkipEntry: boolean,
  ): StrategySelectionResult {
    // Decrement cooldowns
    if (this.farmCooldownCycles > 0) this.farmCooldownCycles--;
    if (this.tradeCooldownCycles > 0) this.tradeCooldownCycles--;

    const eligibility = this._evaluateEligibility(regime, highVolSkipEntry);

    // Req 3.7: Always keep at least one strategy eligible
    if (!eligibility.farm.eligible && !eligibility.trade.eligible) {
      const bestRecent = this._farmRecentWinRate() >= this._tradeRecentWinRate() ? 'farm' : 'trade';
      if (bestRecent === 'farm') {
        eligibility.farm.eligible = true;
        eligibility.farm.reason = 'Re-enabled (fallback — both ineligible)';
        this.farmCooldownCycles = 0;
      } else {
        eligibility.trade.eligible = true;
        eligibility.trade.reason = 'Re-enabled (fallback — both ineligible)';
        this.tradeCooldownCycles = 0;
      }
    }

    // Rank strategies based on regime
    const farmScore = this._scoreFarm(regime, regimeConfidence);
    const tradeScore = this._scoreTrade(regime, regimeConfidence, bullConviction, bearConviction);

    eligibility.farm.score = farmScore;
    eligibility.trade.score = tradeScore;

    // Determine direction from conviction
    const direction = this._resolveDirection(bullConviction, bearConviction);

    // Select strategy
    const selected = this._selectStrategy(eligibility, farmScore, tradeScore);

    const reasoning = this._buildReasoning(selected, regime, regimeConfidence, eligibility, direction);

    return { selected, direction, eligibility, reasoning };
  }

  /**
   * Record a completed trade result for a strategy.
   */
  recordTradeResult(strategy: 'farm' | 'trade', won: boolean, pnl: number, volume: number): void {
    const perf = strategy === 'farm' ? this.farmPerf : this.tradePerf;
    const recent = strategy === 'farm' ? this.farmRecentResults : this.tradeRecentResults;

    perf.totalTrades++;
    if (won) perf.wins++;
    else perf.losses++;
    perf.winRate = perf.wins / perf.totalTrades;
    perf.totalPnl += pnl;
    perf.totalVolume += volume;

    recent.push(won);
    if (recent.length > 10) recent.shift();

    perf.recentWinRate = recent.filter(Boolean).length / recent.length;

    // Req 3.6: Cooldown if rolling 10-trade win rate < 30%
    if (recent.length >= 10 && perf.recentWinRate < 0.30) {
      if (strategy === 'farm') {
        this.farmCooldownCycles = 3;
        console.log(`[StrategySelector] FARM entering 3-cycle cooldown (win rate ${(perf.recentWinRate * 100).toFixed(0)}%)`);
      } else {
        this.tradeCooldownCycles = 3;
        console.log(`[StrategySelector] TRADE entering 3-cycle cooldown (win rate ${(perf.recentWinRate * 100).toFixed(0)}%)`);
      }
    }
  }

  /**
   * Set risk halt state — called by RiskGate.
   */
  setRiskHalt(halted: boolean): void {
    this.riskHalted = halted;
  }

  /**
   * Get performance summary for both strategies.
   */
  getPerformance(): { farm: StrategyPerformance; trade: StrategyPerformance } {
    return {
      farm: { ...this.farmPerf },
      trade: { ...this.tradePerf },
    };
  }

  /**
   * Restore performance state from persisted AgentState.
   */
  restore(state: { farm: StrategyPerformance; trade: StrategyPerformance; farmRecent: boolean[]; tradeRecent: boolean[] }): void {
    this.farmPerf = state.farm;
    this.tradePerf = state.trade;
    this.farmRecentResults = state.farmRecent;
    this.tradeRecentResults = state.tradeRecent;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PRIVATE
  // ═══════════════════════════════════════════════════════════════════════════

  private _evaluateEligibility(regime: MarketRegime, highVolSkipEntry: boolean): StrategyEligibility {
    let farmEligible = true;
    let farmReason = 'Eligible';
    let tradeEligible = true;
    let tradeReason = 'Eligible';

    // Req 3.5: Farm is always eligible unless risk_halt
    if (this.riskHalted) {
      farmEligible = false;
      farmReason = 'Risk halt active';
    }

    // Farm cooldown
    if (this.farmCooldownCycles > 0) {
      farmEligible = false;
      farmReason = `Cooldown (${this.farmCooldownCycles} cycles remaining)`;
    }

    // Trade cooldown
    if (this.tradeCooldownCycles > 0) {
      tradeEligible = false;
      tradeReason = `Cooldown (${this.tradeCooldownCycles} cycles remaining)`;
    }

    // Req 3.4: HIGH_VOLATILITY + config skip → trade ineligible
    if (regime === 'overheated' && highVolSkipEntry) {
      tradeEligible = false;
      tradeReason = 'Overheated regime — HIGH_VOL skip enabled';
    }

    // Risk halt blocks trade too
    if (this.riskHalted) {
      tradeEligible = false;
      tradeReason = 'Risk halt active';
    }

    return {
      farm: { eligible: farmEligible, score: 0, reason: farmReason },
      trade: { eligible: tradeEligible, score: 0, reason: tradeReason },
    };
  }

  private _scoreFarm(regime: MarketRegime, confidence: number): number {
    // Farm scores higher in sideways/choppy/pre-breakout regimes
    const regimeScores: Record<MarketRegime, number> = {
      choppy_neutral: 0.90,
      pre_breakout: 0.80,
      accumulation: 0.50,
      distribution: 0.50,
      bull_momentum: 0.30,
      bear_momentum: 0.30,
      overheated: 0.60,   // Farm can still run in overheated
      capitulation: 0.40,
    };
    const base = regimeScores[regime] ?? 0.50;
    // Boost by performance
    const perfBoost = Math.max(0, (this._farmRecentWinRate() - 0.5) * 0.2);
    return Math.min(1.0, base * confidence + perfBoost);
  }

  private _scoreTrade(regime: MarketRegime, confidence: number, bull: number, bear: number): number {
    // Trade scores higher in trending/accumulation/distribution regimes
    const regimeScores: Record<MarketRegime, number> = {
      bull_momentum: 0.90,
      bear_momentum: 0.90,
      accumulation: 0.80,
      distribution: 0.80,
      choppy_neutral: 0.20,
      pre_breakout: 0.30,
      overheated: 0.10,
      capitulation: 0.60,
    };
    const base = regimeScores[regime] ?? 0.40;
    // Boost by conviction strength
    const convictionBoost = Math.max(bull, bear) / 100 * 0.15;
    const perfBoost = Math.max(0, (this._tradeRecentWinRate() - 0.5) * 0.2);
    return Math.min(1.0, base * confidence + convictionBoost + perfBoost);
  }

  private _resolveDirection(bull: number, bear: number): 'long' | 'short' | 'hold' {
    const diff = bull - bear;
    if (diff > 15) return 'long';
    if (diff < -15) return 'short';
    return 'hold';
  }

  private _selectStrategy(
    eligibility: StrategyEligibility,
    farmScore: number,
    tradeScore: number,
  ): SelectedStrategy {
    const farmOk = eligibility.farm.eligible;
    const tradeOk = eligibility.trade.eligible;

    // Req 3.9: Both eligible and both score > 0.5 → BOTH
    if (farmOk && tradeOk && farmScore > 0.50 && tradeScore > 0.50) {
      return 'BOTH';
    }

    if (farmOk && tradeOk) {
      return farmScore >= tradeScore ? 'FARM' : 'TRADE';
    }

    if (farmOk) return 'FARM';
    if (tradeOk) return 'TRADE';

    return 'HOLD';
  }

  private _buildReasoning(
    selected: SelectedStrategy,
    regime: MarketRegime,
    confidence: number,
    eligibility: StrategyEligibility,
    direction: string,
  ): string {
    const parts: string[] = [];
    parts.push(`Regime: ${regime} (${(confidence * 100).toFixed(0)}%)`);
    parts.push(`Direction: ${direction}`);
    parts.push(`Farm: ${eligibility.farm.eligible ? 'eligible' : 'blocked'} (score ${eligibility.farm.score.toFixed(2)}, ${eligibility.farm.reason})`);
    parts.push(`Trade: ${eligibility.trade.eligible ? 'eligible' : 'blocked'} (score ${eligibility.trade.score.toFixed(2)}, ${eligibility.trade.reason})`);
    parts.push(`Selected: ${selected}`);
    return parts.join(' | ');
  }

  private _farmRecentWinRate(): number {
    if (this.farmRecentResults.length === 0) return 0.5;
    return this.farmRecentResults.filter(Boolean).length / this.farmRecentResults.length;
  }

  private _tradeRecentWinRate(): number {
    if (this.tradeRecentResults.length === 0) return 0.5;
    return this.tradeRecentResults.filter(Boolean).length / this.tradeRecentResults.length;
  }

  private _emptyPerformance(): StrategyPerformance {
    return { totalTrades: 0, wins: 0, losses: 0, winRate: 0, recentWinRate: 0.5, totalPnl: 0, totalVolume: 0 };
  }
}
