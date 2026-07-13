/**
 * SoSoValue Intelligence Engine
 *
 * WAVE 3 UPGRADE: Transform SoSoValue from "overlay multiplier" to "core brain"
 *
 * Key capabilities:
 * 1. Strategy Auto-Selection — Farm/Trade/Hedge based on market intelligence
 * 2. Multi-Signal Conviction Scoring — F&G + ETF + OI + Funding + Stablecoin flows
 * 3. Kelly-Optimized Position Sizing — conviction-based, not arbitrary multipliers
 * 4. Market Regime Classification — 8 regimes, each with optimal strategy
 * 5. Risk-On/Risk-Off Detection — institutional flow patterns
 */

import { SoSoValueClient, type SoSoValueData, type EtfFlowData, type MacroRisk } from './SoSoValueClient.js';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPE DEFINITIONS
// ═══════════════════════════════════════════════════════════════════════════════

export type TradingStrategy = 'farm' | 'trade' | 'hedge' | 'standby';

export type MarketRegime =
  | 'bull_momentum'       // Strong uptrend, high OI growth, positive funding
  | 'bear_momentum'       // Strong downtrend, high OI growth, negative funding
  | 'accumulation'        // Extreme fear, ETF inflows, low volatility
  | 'distribution'        // Extreme greed, ETF outflows, high volatility
  | 'choppy_neutral'      // Low conviction, balanced flows
  | 'pre_breakout'        // OI building, funding neutral, low volatility
  | 'overheated'          // Very high funding, extreme greed
  | 'capitulation';       // Extreme fear, panic selling

export interface MarketIntelligence {
  // Current state
  regime: MarketRegime;
  regimeConfidence: number;  // 0-1

  // Conviction scoring (0-100)
  bullConviction: number;
  bearConviction: number;
  neutralConviction: number;

  // Recommended strategy
  recommendedStrategy: TradingStrategy;
  strategyReason: string;

  // Position sizing guidance
  baseSize: number;           // 0.3 - 1.3x (Kelly-optimized)
  maxLeverage: number;        // 1x - 5x
  confidenceMultiplier: number; // Signal threshold adjustment

  // Risk flags
  riskLevel: 'low' | 'medium' | 'high' | 'extreme';
  warnings: string[];

  // Raw signals (for logging)
  signals: {
    fearGreed: number;
    etfFlow: string;
    openInterest: number;
    fundingRate: number;
    stablecoinInflow: number;
    macroRisk: string;
  };
}

export interface ConvictionScore {
  overall: number;        // 0-100
  components: {
    sentiment: number;    // Fear & Greed
    institutional: number; // ETF flows
    retail: number;       // Open interest + funding
    macro: number;        // Economic events
    technical: number;    // Price action vs flows
  };
  confidence: number;     // How sure are we? 0-1
}

// ═══════════════════════════════════════════════════════════════════════════════
// INTELLIGENCE ENGINE
// ═══════════════════════════════════════════════════════════════════════════════

export class SoSoValueIntelligenceEngine {
  private client: SoSoValueClient;

  // Cached data (refreshed every analysis)
  private fearGreed: SoSoValueData | null = null;
  private etfFlow: EtfFlowData | null = null;
  private macroRisk: MacroRisk | null = null;
  private openInterest: number | null = null;
  private fundingRate: number | null = null;
  private stablecoinInflow: number | null = null;

  constructor() {
    this.client = new SoSoValueClient();
  }

  /**
   * Main intelligence analysis — call this before each trading decision
   */
  async analyze(): Promise<MarketIntelligence> {
    // Fetch all signals in parallel
    await this._fetchAllSignals();

    // Compute conviction scores
    const conviction = this._computeConviction();

    // Classify market regime
    const regime = this._classifyRegime(conviction);

    // Recommend strategy
    const { strategy, reason } = this._recommendStrategy(regime, conviction);

    // Compute position sizing
    const sizing = this._computeKellySize(conviction);

    // Assess risk level
    const { riskLevel, warnings } = this._assessRisk();

    return {
      regime: regime.type,
      regimeConfidence: regime.confidence,
      bullConviction: conviction.components.sentiment > 50 ? conviction.components.sentiment : 0,
      bearConviction: conviction.components.sentiment < 50 ? 100 - conviction.components.sentiment : 0,
      neutralConviction: 100 - Math.abs(conviction.overall - 50) * 2,
      recommendedStrategy: strategy,
      strategyReason: reason,
      baseSize: sizing.baseSize,
      maxLeverage: sizing.maxLeverage,
      confidenceMultiplier: sizing.confidenceMultiplier,
      riskLevel,
      warnings,
      signals: {
        fearGreed: this.fearGreed?.fearGreedIndex ?? 50,
        etfFlow: this.etfFlow?.signal ?? 'neutral',
        openInterest: this.openInterest ?? 0,
        fundingRate: this.fundingRate ?? 0,
        stablecoinInflow: this.stablecoinInflow ?? 0,
        macroRisk: this.macroRisk?.riskLevel ?? 'none',
      },
    };
  }

  /**
   * Quick check: should we trade right now?
   * Pass an existing analysis to avoid re-fetching signals.
   */
  async shouldTrade(intel?: MarketIntelligence): Promise<{ trade: boolean; reason: string }> {
    intel ??= await this.analyze();

    // Hard blockers
    if (intel.riskLevel === 'extreme') {
      return { trade: false, reason: `EXTREME RISK: ${intel.warnings.join(', ')}` };
    }

    if (intel.recommendedStrategy === 'standby') {
      return { trade: false, reason: intel.strategyReason };
    }

    // Conviction threshold
    const minConviction = 40;
    const maxConviction = Math.max(intel.bullConviction, intel.bearConviction, intel.neutralConviction);

    if (maxConviction < minConviction) {
      return { trade: false, reason: `Low conviction: ${maxConviction.toFixed(0)}/100 (need ${minConviction})` };
    }

    return {
      trade: true,
      reason: `${intel.regime} regime → ${intel.recommendedStrategy} strategy (conviction: ${maxConviction.toFixed(0)})`
    };
  }

  // ═════════════════════════════════════════════════════════════════════════════
  // PRIVATE: DATA FETCHING
  // ═════════════════════════════════════════════════════════════════════════════

  private async _fetchAllSignals(): Promise<void> {
    const [fg, etf, macro, oi, fr, sc] = await Promise.all([
      this.client.fetch(),
      this.client.fetchEtfFlow(),
      this.client.fetchMacroEvents(),
      this._fetchOpenInterest(),
      this._fetchFundingRate(),
      this._fetchStablecoinInflow(),
    ]);

    this.fearGreed = fg;
    this.etfFlow = etf;
    this.macroRisk = macro;
    this.openInterest = oi;
    this.fundingRate = fr;
    this.stablecoinInflow = sc;
  }

  private async _fetchOpenInterest(): Promise<number | null> {
    try {
      const data = await this.client.fetchChart('futures_open_interest', 1);
      if (!data || data.length === 0) return null;
      const latest = data[0] as any;
      return Number(latest.all ?? latest.binance ?? 0);
    } catch {
      return null;
    }
  }

  private async _fetchFundingRate(): Promise<number | null> {
    try {
      const data = await this.client.fetchChart('funding_rate', 1);
      if (!data || data.length === 0) return null;
      const latest = data[0] as any;
      return Number(latest.binance ?? latest.okx ?? 0);
    } catch {
      return null;
    }
  }

  private async _fetchStablecoinInflow(): Promise<number | null> {
    try {
      const data = await this.client.fetchChart('fiat_backed_stablecoins_usd_pegged_mcap_net_inflows', 5);
      if (!data || data.length === 0) return null;
      // Sum last 5 days
      return data.reduce((sum, row: any) => sum + Number(row.fiat_backed_stablecoins_net_inflows ?? 0), 0);
    } catch {
      return null;
    }
  }

  // ═════════════════════════════════════════════════════════════════════════════
  // PRIVATE: CONVICTION SCORING
  // ═════════════════════════════════════════════════════════════════════════════

  private _computeConviction(): ConvictionScore {
    // Sentiment: Fear & Greed (0-100)
    const sentiment = this.fearGreed?.fearGreedIndex ?? 50;

    // Institutional: ETF flow signal
    const institutional = this._scoreEtfFlow();

    // Retail: Open interest + funding rate
    const retail = this._scoreRetailActivity();

    // Macro: Economic events risk
    const macro = this._scoreMacroRisk();

    // Technical: Does price action confirm flows?
    const technical = this._scoreTechnicalAlignment();

    // Weighted average
    const overall = (
      sentiment * 0.25 +
      institutional * 0.30 +
      retail * 0.20 +
      macro * 0.15 +
      technical * 0.10
    );

    // Confidence: how many signals do we have?
    const signalCount = [
      this.fearGreed !== null,
      this.etfFlow !== null,
      this.openInterest !== null,
      this.fundingRate !== null,
      this.stablecoinInflow !== null,
    ].filter(Boolean).length;

    const confidence = Math.min(signalCount / 5, 1.0);

    return {
      overall,
      components: { sentiment, institutional, retail, macro, technical },
      confidence,
    };
  }

  private _scoreEtfFlow(): number {
    if (!this.etfFlow) return 50;

    const signal = this.etfFlow.signal;
    const inflowToday = this.etfFlow.btcNetInflowToday;
    const inflow3d = this.etfFlow.btcNetInflow3d;

    if (signal === 'strong_bull' || (inflowToday > 500e6 && inflow3d > 1e9)) return 85;
    if (signal === 'bull' || (inflowToday > 100e6)) return 65;
    if (signal === 'strong_bear' || (inflow3d < -500e6)) return 15;
    if (signal === 'bear' || (inflowToday < -100e6)) return 35;
    return 50;
  }

  private _scoreRetailActivity(): number {
    // Positive funding + rising OI = bullish
    // Negative funding + rising OI = bearish
    // High funding + stable OI = overheated

    if (this.fundingRate === null) return 50;

    const fr = this.fundingRate;

    // Funding rate interpretation
    if (fr > 0.01) return 75; // Very bullish (1% per 8h)
    if (fr > 0.005) return 65;
    if (fr > 0.001) return 55;
    if (fr < -0.01) return 25; // Very bearish
    if (fr < -0.005) return 35;
    if (fr < -0.001) return 45;
    return 50;
  }

  private _scoreMacroRisk(): number {
    if (!this.macroRisk) return 50;

    if (this.macroRisk.riskLevel === 'high') return 20;
    if (this.macroRisk.riskLevel === 'elevated') return 35;
    return 50;
  }

  private _scoreTechnicalAlignment(): number {
    // Stablecoin inflow = bullish (new capital)
    // Stablecoin outflow = bearish (capital leaving)

    if (this.stablecoinInflow === null) return 50;

    const inflow = this.stablecoinInflow;

    if (inflow > 1e9) return 75;  // $1B+ inflow
    if (inflow > 0) return 60;
    if (inflow < -1e9) return 25;
    if (inflow < 0) return 40;
    return 50;
  }

  // ═════════════════════════════════════════════════════════════════════════════
  // PRIVATE: REGIME CLASSIFICATION
  // ═════════════════════════════════════════════════════════════════════════════

  private _classifyRegime(conviction: ConvictionScore): { type: MarketRegime; confidence: number } {
    const fg = this.fearGreed?.fearGreedIndex ?? 50;
    const etf = conviction.components.institutional;
    const fr = this.fundingRate ?? 0;

    // Bull momentum: Greed + ETF inflows + positive funding
    if (fg > 60 && etf > 60 && fr > 0.005) {
      return { type: 'bull_momentum', confidence: 0.85 };
    }

    // Bear momentum: Fear + ETF outflows + negative funding
    if (fg < 40 && etf < 40 && fr < -0.005) {
      return { type: 'bear_momentum', confidence: 0.85 };
    }

    // Accumulation: Extreme fear + institutional buying
    if (fg < 25 && etf > 55) {
      return { type: 'accumulation', confidence: 0.90 };
    }

    // Distribution: Extreme greed + institutional selling
    if (fg > 75 && etf < 45) {
      return { type: 'distribution', confidence: 0.90 };
    }

    // Overheated: Very high funding
    if (fr > 0.015) {
      return { type: 'overheated', confidence: 0.80 };
    }

    // Capitulation: Extreme fear + panic
    if (fg < 20 && etf < 30) {
      return { type: 'capitulation', confidence: 0.80 };
    }

    // Pre-breakout: Building position, low volatility
    if (this.openInterest && this.openInterest > 40e9 && Math.abs(fr) < 0.002) {
      return { type: 'pre_breakout', confidence: 0.65 };
    }

    // Default: choppy neutral
    return { type: 'choppy_neutral', confidence: 0.60 };
  }

  // ═════════════════════════════════════════════════════════════════════════════
  // PRIVATE: STRATEGY RECOMMENDATION
  // ═════════════════════════════════════════════════════════════════════════════

  private _recommendStrategy(
    regime: { type: MarketRegime; confidence: number },
    conviction: ConvictionScore
  ): { strategy: TradingStrategy; reason: string } {

    switch (regime.type) {
      case 'bull_momentum':
        return {
          strategy: 'trade',
          reason: 'Bull momentum detected — strong directional edge (Trade mode optimal)'
        };

      case 'bear_momentum':
        return {
          strategy: 'trade',
          reason: 'Bear momentum detected — strong directional edge (Trade mode optimal)'
        };

      case 'accumulation':
        return {
          strategy: 'trade',
          reason: 'Accumulation phase — smart money buying dips (Trade mode, long bias)'
        };

      case 'distribution':
        return {
          strategy: 'trade',
          reason: 'Distribution phase — smart money exiting (Trade mode, short bias)'
        };

      case 'choppy_neutral':
        return {
          strategy: 'farm',
          reason: 'Choppy market — no clear direction (Farm mode to capture volume)'
        };

      case 'pre_breakout':
        return {
          strategy: 'farm',
          reason: 'Pre-breakout consolidation — farm volume until breakout confirmed'
        };

      case 'overheated':
        return {
          strategy: 'standby',
          reason: 'Market overheated (funding > 1.5%) — high reversal risk, stand aside'
        };

      case 'capitulation':
        if (conviction.components.institutional > 60) {
          return {
            strategy: 'trade',
            reason: 'Capitulation + institutional buying — contrarian long opportunity'
          };
        }
        return {
          strategy: 'standby',
          reason: 'Capitulation with no institutional support — wait for stabilization'
        };

      default:
        return { strategy: 'farm', reason: 'Default to farm mode' };
    }
  }

  // ═════════════════════════════════════════════════════════════════════════════
  // PRIVATE: KELLY POSITION SIZING
  // ═════════════════════════════════════════════════════════════════════════════

  private _computeKellySize(conviction: ConvictionScore): {
    baseSize: number;
    maxLeverage: number;
    confidenceMultiplier: number;
  } {
    // Kelly criterion: f* = (p*b - q) / b
    // Where: p = win probability, q = 1-p, b = win/loss ratio
    // Simplified: size scales with conviction and confidence

    const convictionScore = conviction.overall; // 0-100
    const confidence = conviction.confidence;   // 0-1

    // Base size: 0.5x to 1.3x
    // High conviction + high confidence = bigger size
    const baseSize = 0.5 + (convictionScore / 100) * 0.5 + confidence * 0.3;

    // Max leverage: 1x-5x (higher conviction = more leverage allowed)
    const maxLeverage = 1.0 + (convictionScore / 100) * 4.0;

    // Confidence multiplier: adjust signal threshold
    // Low conviction → raise threshold (be selective)
    // High conviction → lower threshold (take more trades)
    const confidenceMultiplier = convictionScore < 40 ? 1.3 :
                                  convictionScore < 60 ? 1.0 :
                                  0.85;

    // Macro guard override
    if (this.macroRisk && this.macroRisk.riskLevel !== 'none') {
      return {
        baseSize: Math.min(baseSize, this.macroRisk.sizeMultiplier),
        maxLeverage: Math.min(maxLeverage, 2.0),
        confidenceMultiplier: Math.max(confidenceMultiplier, this.macroRisk.confidenceMultiplier),
      };
    }

    return {
      baseSize: Math.max(0.3, Math.min(1.3, baseSize)),
      maxLeverage: Math.max(1.0, Math.min(5.0, maxLeverage)),
      confidenceMultiplier: Math.max(0.7, Math.min(1.5, confidenceMultiplier)),
    };
  }

  // ═════════════════════════════════════════════════════════════════════════════
  // PRIVATE: RISK ASSESSMENT
  // ═════════════════════════════════════════════════════════════════════════════

  private _assessRisk(): { riskLevel: MarketIntelligence['riskLevel']; warnings: string[] } {
    const warnings: string[] = [];
    let riskScore = 0;

    // Macro events
    if (this.macroRisk?.riskLevel === 'high') {
      riskScore += 40;
      warnings.push(`High-impact macro event: ${this.macroRisk.reason}`);
    } else if (this.macroRisk?.riskLevel === 'elevated') {
      riskScore += 20;
      warnings.push(`Elevated macro risk: ${this.macroRisk.reason}`);
    }

    // Extreme funding
    if (this.fundingRate && Math.abs(this.fundingRate) > 0.015) {
      riskScore += 25;
      warnings.push(`Extreme funding rate: ${(this.fundingRate * 100).toFixed(3)}% (reversal risk)`);
    }

    // Extreme greed
    if (this.fearGreed && this.fearGreed.fearGreedIndex > 85) {
      riskScore += 15;
      warnings.push('Extreme Greed (85+) — euphoria, high reversal risk');
    }

    // Institutional outflow during greed
    if (this.fearGreed && this.fearGreed.fearGreedIndex > 70 &&
        this.etfFlow && this.etfFlow.btcNetInflow3d < -200e6) {
      riskScore += 20;
      warnings.push('Smart money exiting during retail greed — distribution phase');
    }

    const riskLevel: MarketIntelligence['riskLevel'] =
      riskScore >= 60 ? 'extreme' :
      riskScore >= 40 ? 'high' :
      riskScore >= 20 ? 'medium' :
      'low';

    return { riskLevel, warnings };
  }
}
