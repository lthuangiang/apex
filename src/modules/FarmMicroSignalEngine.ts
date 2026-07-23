/**
 * FarmMicroSignalEngine.ts
 *
 * Fast, deterministic entry-direction engine for FARM mode.
 * Uses completed 1-minute candles + market microstructure (orderbook, trades)
 * to produce LONG / SHORT / SKIP decisions matching the 2-5 minute hold horizon.
 *
 * No LLM, no SoSoValue, no external API calls beyond the exchange adapter.
 * All scoring functions are pure, independently testable, and normalized to [0,1].
 */

import { ExchangeAdapter, Kline, RawTrade } from '../adapters/ExchangeAdapter.js';
import { config } from '../config.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export type FarmMicroDirection = 'long' | 'short' | 'skip';

export type FarmMicroRegime = 'SIDEWAY' | 'TREND_UP' | 'TREND_DOWN' | 'HIGH_VOLATILITY' | 'UNKNOWN';

export interface FarmMicroSignal {
  direction: FarmMicroDirection;
  score: number;          // normalized [0, 1], 0=bearish 0.5=neutral 1=bullish
  confidence: number;     // normalized [0, 1]
  regime: FarmMicroRegime;
  components: {
    candleMomentum: number;
    wickRejection: number;
    volumeAcceleration: number;
    tradePressure: number;
    orderbookImbalance: number;
  };
  dataQuality: {
    candleInterval: string;
    completedCandles: number;
    hasTradeData: boolean;
    hasOrderbookData: boolean;
    usedFallback: boolean;
  };
  reason: string;
  signalSource: 'farm_micro';
}

// ── Skip Reason Codes ─────────────────────────────────────────────────────────

export type SkipReason =
  | 'NEUTRAL_ZONE'
  | 'LOW_CONFIDENCE'
  | 'STALE_CANDLES'
  | 'INSUFFICIENT_CANDLES'
  | 'SPREAD_TOO_WIDE'
  | 'EDGE_BELOW_FEES'
  | 'COUNTER_TREND_BLOCKED'
  | 'INVALID_MARKET_DATA'
  | 'UNSUPPORTED_INTERVAL';

// ── Config Interface ──────────────────────────────────────────────────────────

export interface FarmMicroConfig {
  enabled: boolean;
  symbols: string[];
  interval: string;
  candleLimit: number;
  cacheSecs: number;
  longThreshold: number;
  shortThreshold: number;
  minConfidence: number;
  highVolMinConfidence: number;
  trendCounterThreshold: number;
  maxCandleAgeSecs: number;
  feeSafetyMult: number;
  feeRateMaker: number;
  execMaxSpreadBps: number;
}

export function getFarmMicroConfig(): FarmMicroConfig {
  return {
    enabled: process.env.FARM_MICRO_ENABLED === 'true',
    symbols: (process.env.FARM_MICRO_SYMBOLS ?? 'BTC-USD,BTC-PERP,BTCUSDT')
      .split(',').map(s => s.trim()).filter(Boolean),
    interval: process.env.FARM_MICRO_INTERVAL ?? '1m',
    candleLimit: parseInt(process.env.FARM_MICRO_CANDLE_LIMIT ?? '30', 10) || 30,
    cacheSecs: parseInt(process.env.FARM_MICRO_CACHE_SECS ?? '10', 10) || 10,
    longThreshold: parseFloat(process.env.FARM_MICRO_LONG_THRESHOLD ?? '0.505') || 0.505,
    shortThreshold: parseFloat(process.env.FARM_MICRO_SHORT_THRESHOLD ?? '0.495') || 0.495,
    minConfidence: parseFloat(process.env.FARM_MICRO_MIN_CONFIDENCE ?? '0.15') || 0.15,
    highVolMinConfidence: parseFloat(process.env.FARM_MICRO_HIGH_VOL_MIN_CONFIDENCE ?? '0.35') || 0.35,
    trendCounterThreshold: parseFloat(process.env.FARM_MICRO_TREND_COUNTER_THRESHOLD ?? '0.70') || 0.70,
    maxCandleAgeSecs: parseInt(process.env.FARM_MICRO_MAX_CANDLE_AGE_SECS ?? '120', 10) || 120,
    feeSafetyMult: parseFloat(process.env.FARM_MICRO_FEE_SAFETY_MULT ?? '0.5') || 0.5,
    feeRateMaker: config.FEE_RATE_MAKER,
    execMaxSpreadBps: config.EXEC_MAX_SPREAD_BPS,
  };
}

// ── Pure Calculation Helpers ──────────────────────────────────────────────────

/** Clamp value to [0, 1] */
export function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0.5;
  return Math.max(0, Math.min(1, v));
}

/** Simple EMA (exponential moving average) over an array of values */
export function ema(values: number[], period: number): number {
  if (values.length === 0) return 0;
  const k = 2 / (period + 1);
  let prev = values[0];
  for (let i = 1; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
  }
  return prev;
}

/** ATR (average true range) over the last `period` candles */
export function computeATR(candles: Kline[], period: number): number {
  if (candles.length < 2) return 0;
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const tr = Math.max(
      candles[i].h - candles[i].l,
      Math.abs(candles[i].h - candles[i - 1].c),
      Math.abs(candles[i].l - candles[i - 1].c),
    );
    trs.push(tr);
  }
  const recent = trs.slice(-period);
  if (recent.length === 0) return 0;
  return recent.reduce((a, b) => a + b, 0) / recent.length;
}

// ── Component Scoring Functions ───────────────────────────────────────────────
// Each function returns a value in [0, 1]: 0 = bearish, 0.5 = neutral, 1 = bullish.

/**
 * SR-1: Candle Momentum (weight 30%)
 * Short return over latest 3 candles + EMA5 vs EMA13 distance normalized by ATR.
 */
export function scoreCandleMomentum(candles: Kline[]): number {
  if (candles.length < 14) return 0.5; // need enough for EMA13 + ATR

  const closes = candles.map(c => c.c);
  const n = closes.length;

  // Short return over last 3 candles
  const ret3 = (closes[n - 1] - closes[n - 4]) / closes[n - 4];

  // EMA5 vs EMA13 distance
  const ema5 = ema(closes, 5);
  const ema13 = ema(closes, 13);
  const emaDiff = ema5 - ema13;

  // Normalize by ATR to make it scale-independent
  const atr = computeATR(candles, 14);
  if (atr <= 0) return 0.5;

  // Combine: return normalized by ATR + ema gap normalized by ATR
  const retNorm = ret3 / (atr / closes[n - 1]); // dimensionless
  const emaGapNorm = emaDiff / atr;

  // Blend: 60% short return, 40% ema gap
  const raw = retNorm * 0.6 + emaGapNorm * 0.4;

  // Map to [0,1]: raw ∈ [-3, 3] typical → sigmoid-like mapping
  // Cap outliers: one fast candle cannot dominate
  const capped = Math.max(-2.5, Math.min(2.5, raw));
  return clamp01(0.5 + capped * 0.15);
}

/**
 * SR-2: Wick/Close Rejection (weight 25%)
 * Uses the latest 2 completed candles.
 * Bullish: lower-wick rejection + close near high.
 * Bearish: upper-wick rejection + close near low.
 * Doji/zero-range: neutral.
 */
export function scoreWickRejection(candles: Kline[]): number {
  if (candles.length < 2) return 0.5;

  let totalScore = 0;
  const weights = [0.6, 0.4]; // latest candle weighted more

  for (let i = 0; i < 2; i++) {
    const c = candles[candles.length - 1 - i];
    const range = c.h - c.l;
    if (range <= 0) { totalScore += 0.5 * weights[i]; continue; }

    const body = Math.abs(c.c - c.o);
    const lowerWick = Math.min(c.o, c.c) - c.l;
    const upperWick = c.h - Math.max(c.o, c.c);

    // Close position within range: 0=low, 1=high
    const closePos = (c.c - c.l) / range;

    // Wick rejection ratio
    const lowerWickRatio = lowerWick / range;
    const upperWickRatio = upperWick / range;

    // Bullish: large lower wick + close near top
    // Bearish: large upper wick + close near bottom
    let score = 0.5;
    if (lowerWickRatio > 0.4 && closePos > 0.6) {
      // Strong lower rejection → bullish
      score = 0.5 + (lowerWickRatio * closePos) * 0.5;
    } else if (upperWickRatio > 0.4 && closePos < 0.4) {
      // Strong upper rejection → bearish
      score = 0.5 - (upperWickRatio * (1 - closePos)) * 0.5;
    } else {
      // Slight bias from close position
      score = 0.5 + (closePos - 0.5) * 0.3;
    }

    totalScore += clamp01(score) * weights[i];
  }

  return clamp01(totalScore);
}

/**
 * SR-3: Volume Acceleration (weight 20%)
 * Compare avg volume of latest 3 candles vs preceding 10-candle avg.
 * High volume WITH directional move = confirming signal.
 * High volume WITHOUT direction = neutral.
 */
export function scoreVolumeAcceleration(candles: Kline[]): number {
  if (candles.length < 14) return 0.5;

  const n = candles.length;
  const recent3 = candles.slice(n - 3);
  const prior10 = candles.slice(n - 13, n - 3);

  const avgRecent = recent3.reduce((s, c) => s + c.v, 0) / 3;
  const avgPrior = prior10.reduce((s, c) => s + c.v, 0) / Math.max(prior10.length, 1);

  if (avgPrior <= 0) return 0.5;

  const volRatio = avgRecent / avgPrior;

  // Determine direction of recent price move
  const priceChange = recent3[2].c - recent3[0].o;
  const recentRange = Math.max(...recent3.map(c => c.h)) - Math.min(...recent3.map(c => c.l));
  const directionality = recentRange > 0 ? Math.abs(priceChange) / recentRange : 0;

  // Volume spike (> 1.5x) with directional move confirms direction
  if (volRatio > 1.0 && directionality > 0.3) {
    const volumeBoost = Math.min((volRatio - 1.0) * 0.5, 0.4); // cap at ±0.4
    const direction = priceChange > 0 ? 1 : -1;
    return clamp01(0.5 + direction * volumeBoost * directionality);
  }

  // High volume without direction = neutral (chop)
  return 0.5;
}

/**
 * SR-4: Recent Trade Pressure (weight 15%)
 * Buy volume / total classified volume.
 * Neutral (0.5) when no data or unclassified.
 */
export function scoreTradePressure(trades: RawTrade[]): number {
  if (!trades || trades.length === 0) return 0.5;

  let buyVol = 0;
  let sellVol = 0;
  for (const t of trades) {
    if (t.side === 'buy') buyVol += t.size * t.price;
    else if (t.side === 'sell') sellVol += t.size * t.price;
  }

  const total = buyVol + sellVol;
  if (total <= 0) return 0.5;

  // Raw ratio [0, 1] where 1 = all buys
  const ratio = buyVol / total;

  // Soften extremes slightly to avoid overreaction to single large trade
  // Map [0.2, 0.8] → [0, 1] with clamping
  return clamp01((ratio - 0.2) / 0.6);
}

/**
 * SR-5: Order Book Imbalance (weight 10%)
 * bidNotional / (bidNotional + askNotional)
 * Empty/crossed/invalid book = neutral.
 */
export function scoreOrderbookImbalance(
  bids: [number, number][],
  asks: [number, number][],
): number {
  if (!bids || !asks || bids.length === 0 || asks.length === 0) return 0.5;

  // Validate: best bid < best ask (not crossed)
  if (bids[0][0] >= asks[0][0]) return 0.5;

  const bidNotional = bids.reduce((s, [p, q]) => s + p * q, 0);
  const askNotional = asks.reduce((s, [p, q]) => s + p * q, 0);
  const total = bidNotional + askNotional;

  if (total <= 0) return 0.5;

  const ratio = bidNotional / total;
  // Slight damping — OB is noisy on perp exchanges
  return clamp01(0.5 + (ratio - 0.5) * 0.8);
}

// ── Regime Detection (5m candles) ─────────────────────────────────────────────

/**
 * Lightweight regime detection from 5m candles.
 * Reuses ATR/EMA logic but self-contained (no RegimeDetector dependency).
 */
export function detectRegime(candles5m: Kline[]): FarmMicroRegime {
  if (!candles5m || candles5m.length < 15) return 'UNKNOWN';

  const closes = candles5m.map(c => c.c);
  const currentPrice = closes[closes.length - 1];

  // ATR as % of price
  const atr = computeATR(candles5m, 14);
  const atrPct = currentPrice > 0 ? atr / currentPrice : 0;

  // EMA21
  const ema21 = ema(closes, 21);

  // High volatility check
  if (atrPct > 0.005) return 'HIGH_VOLATILITY';

  // Trend detection: price vs EMA21 with band
  const band = 0.002; // 0.2%
  if (currentPrice > ema21 * (1 + band)) return 'TREND_UP';
  if (currentPrice < ema21 * (1 - band)) return 'TREND_DOWN';

  return 'SIDEWAY';
}

// ── Composite Score & Direction ───────────────────────────────────────────────

/** Default component weights */
const WEIGHTS = {
  candleMomentum: 0.30,
  wickRejection: 0.25,
  volumeAcceleration: 0.20,
  tradePressure: 0.15,
  orderbookImbalance: 0.10,
};

export interface CompositeInput {
  components: FarmMicroSignal['components'];
  regime: FarmMicroRegime;
  cfg: FarmMicroConfig;
}

/**
 * Compute composite score from 5 components + regime-based direction decision.
 */
export function computeComposite(input: CompositeInput): {
  score: number;
  direction: FarmMicroDirection;
  confidence: number;
  reason: string;
} {
  const { components, regime, cfg } = input;
  const { candleMomentum, wickRejection, volumeAcceleration, tradePressure, orderbookImbalance } = components;

  // Weighted sum (weights do NOT redistribute when data is missing — missing stays neutral 0.5)
  const score = clamp01(
    candleMomentum * WEIGHTS.candleMomentum +
    wickRejection * WEIGHTS.wickRejection +
    volumeAcceleration * WEIGHTS.volumeAcceleration +
    tradePressure * WEIGHTS.tradePressure +
    orderbookImbalance * WEIGHTS.orderbookImbalance
  );

  // Confidence: based on component agreement and score distance from neutral.
  // FARM mode operates in moderate-score territory (0.55-0.65), so confidence
  // should not require extreme scores to be actionable.
  const distFromNeutral = Math.abs(score - 0.5) * 2; // [0, 1]
  const vals = [candleMomentum, wickRejection, volumeAcceleration, tradePressure, orderbookImbalance];
  const maxComp = Math.max(...vals);
  const minComp = Math.min(...vals);
  const disagreement = maxComp - minComp; // [0, 1]

  // Count how many components agree with direction (above/below 0.5)
  const directionSign = score >= 0.5 ? 1 : -1;
  const agreeing = vals.filter(v => (v - 0.5) * directionSign > 0).length;
  const agreementRatio = agreeing / vals.length; // [0, 1]

  // Confidence formula: agreement-heavy (60%) + distance (40%), penalized by disagreement
  let confidence = agreementRatio * 0.5 + distFromNeutral * 0.3 + (1 - disagreement * 0.5) * 0.2;
  confidence = clamp01(confidence);

  // Direction: FARM always trades. score >= 0.5 → LONG, < 0.5 → SHORT. No skip from thresholds.
  let direction: FarmMicroDirection;
  let reason: string;

  if (score >= 0.5) {
    direction = 'long';
    reason = `LONG: score=${score.toFixed(3)} >= 0.5`;
  } else {
    direction = 'short';
    reason = `SHORT: score=${score.toFixed(3)} < 0.5`;
  }

  // Regime guards (GR-2) — may convert to skip in counter-trend situations
  direction = applyRegimeGuard(direction, score, confidence, regime, cfg);
  if (direction === 'skip') {
    reason = `COUNTER_TREND_BLOCKED: regime=${regime} blocked original direction`;
  }

  // Confidence floor: scores very close to 0.5 get low confidence
  if (Math.abs(score - 0.5) < 0.03) {
    confidence = Math.min(confidence, 0.3);
  }

  // No min confidence gate for FARM — always trade, confidence only affects sizing info.

  return { score, direction, confidence, reason };
}

/**
 * GR-2: Regime guard — veto or tighten counter-trend entries.
 */
function applyRegimeGuard(
  direction: 'long' | 'short',
  score: number,
  confidence: number,
  regime: FarmMicroRegime,
  cfg: FarmMicroConfig,
): FarmMicroDirection {
  switch (regime) {
    case 'TREND_UP':
      // SHORT in uptrend requires very strong bearish signal
      if (direction === 'short' && score > (1 - cfg.trendCounterThreshold)) return 'skip';
      break;
    case 'TREND_DOWN':
      // LONG in downtrend requires very strong bullish signal
      if (direction === 'long' && score < cfg.trendCounterThreshold) return 'skip';
      break;
    case 'HIGH_VOLATILITY':
    case 'UNKNOWN':
      // Higher confidence required — handled by minConf in computeComposite
      break;
    case 'SIDEWAY':
      // Both sides allowed at normal thresholds
      break;
  }
  return direction;
}

// ── Fee/Spread Edge Guard (GR-3) ─────────────────────────────────────────────

/**
 * Check if expected move covers round-trip fees + safety multiplier.
 * Returns skip reason or null if edge is sufficient.
 */
export function checkFeeEdge(
  candles: Kline[],
  spreadBps: number,
  cfg: FarmMicroConfig,
): SkipReason | null {
  // Spread gate
  if (spreadBps > cfg.execMaxSpreadBps) return 'SPREAD_TOO_WIDE';

  // Expected move from 1m ATR
  const atr = computeATR(candles, 14);
  const price = candles[candles.length - 1]?.c ?? 0;
  if (price <= 0 || atr <= 0) return 'INVALID_MARKET_DATA';

  const atrPct = atr / price;
  const roundTripFee = cfg.feeRateMaker * 2;
  const requiredEdge = roundTripFee * cfg.feeSafetyMult;

  // Expected edge: we expect to capture ~50% of 1m ATR in 2-5 min hold
  const expectedEdge = atrPct * 0.5;
  if (expectedEdge < requiredEdge) return 'EDGE_BELOW_FEES';

  return null;
}

// ── Candle Validation ─────────────────────────────────────────────────────────

/**
 * Filter and validate candles:
 * - Sort by timestamp
 * - Remove duplicates
 * - Remove the active (unfinished) candle
 * - Reject invalid OHLCV values
 */
export function validateCandles(raw: Kline[], intervalMs: number): Kline[] {
  if (!raw || raw.length === 0) return [];

  // Sort chronologically
  const sorted = [...raw].sort((a, b) => a.t - b.t);

  // Deduplicate by timestamp
  const deduped: Kline[] = [];
  let lastT = -1;
  for (const c of sorted) {
    if (c.t === lastT) continue;
    // Validate OHLCV
    if (
      !Number.isFinite(c.o) || !Number.isFinite(c.h) ||
      !Number.isFinite(c.l) || !Number.isFinite(c.c) ||
      !Number.isFinite(c.v) || c.o <= 0 || c.h <= 0 ||
      c.l <= 0 || c.c <= 0 || c.v < 0 ||
      c.h < c.l
    ) continue;
    deduped.push(c);
    lastT = c.t;
  }

  if (deduped.length === 0) return [];

  // Remove the active/unfinished candle:
  // A candle starting at time T is complete when now >= T + intervalMs
  const now = Date.now();
  const lastCandle = deduped[deduped.length - 1];
  if (lastCandle.t + intervalMs > now) {
    deduped.pop();
  }

  return deduped;
}

/**
 * Check candle staleness: newest completed candle age in seconds.
 */
export function candleAgeSecs(candles: Kline[], intervalMs: number): number {
  if (candles.length === 0) return Infinity;
  const lastCandle = candles[candles.length - 1];
  // Candle close time = open time + interval
  const closeTime = lastCandle.t + intervalMs;
  return (Date.now() - closeTime) / 1000;
}

// ── Main Engine Class ─────────────────────────────────────────────────────────

export class FarmMicroSignalEngine {
  private _cache: { signal: FarmMicroSignal; cachedAt: number; symbol: string } | null = null;
  private _cfg: FarmMicroConfig;

  constructor(private adapter: ExchangeAdapter, cfg?: Partial<FarmMicroConfig>) {
    this._cfg = { ...getFarmMicroConfig(), ...cfg };
  }

  get config(): FarmMicroConfig { return this._cfg; }

  /** Invalidate cache (call after entry order placed). */
  invalidateCache(): void {
    this._cache = null;
  }

  /**
   * Main entry point: evaluate FARM micro signal.
   * Returns direction, score, confidence, components, data quality.
   * Never throws — catches errors and returns skip with reason.
   */
  async evaluate(symbol: string): Promise<FarmMicroSignal> {
    // Check cache
    const now = Date.now();
    if (
      this._cache &&
      this._cache.symbol === symbol &&
      now - this._cache.cachedAt < this._cfg.cacheSecs * 1000
    ) {
      return this._cache.signal;
    }

    try {
      const signal = await this._compute(symbol);
      this._cache = { signal, cachedAt: now, symbol };
      return signal;
    } catch (err: any) {
      console.error(`[FarmMicro] Error evaluating ${symbol}:`, err?.message ?? err);
      return this._skipSignal('INVALID_MARKET_DATA', `Error: ${err?.message ?? 'unknown'}`, {
        candleInterval: this._cfg.interval,
        completedCandles: 0,
        hasTradeData: false,
        hasOrderbookData: false,
        usedFallback: false,
      });
    }
  }

  private async _compute(symbol: string): Promise<FarmMicroSignal> {
    const cfg = this._cfg;
    const intervalMs = this._parseIntervalMs(cfg.interval);

    // ── Fetch data concurrently ───────────────────────────────────────────
    // Check adapter supports get_klines
    if (!this.adapter.get_klines) {
      return this._skipSignal('UNSUPPORTED_INTERVAL', 'Adapter does not support get_klines', {
        candleInterval: cfg.interval,
        completedCandles: 0,
        hasTradeData: false,
        hasOrderbookData: false,
        usedFallback: true,
      });
    }

    const [rawCandles1m, rawCandles5m, rawTrades, obDepth] = await Promise.all([
      this.adapter.get_klines(symbol, cfg.interval, cfg.candleLimit),
      this.adapter.get_klines(symbol, '5m', 25).catch(() => [] as Kline[]),
      this.adapter.get_recent_trades(symbol, 200).catch(() => [] as RawTrade[]),
      this.adapter.get_orderbook_depth(symbol, 10).catch(() => ({ bids: [] as [number, number][], asks: [] as [number, number][] })),
    ]);

    // ── Validate 1m candles ───────────────────────────────────────────────
    const candles = validateCandles(rawCandles1m, intervalMs);
    const hasTradeData = rawTrades.length > 0;
    const hasOrderbookData = obDepth.bids.length > 0 && obDepth.asks.length > 0;

    // DR-4: Insufficient candles
    if (candles.length < 10) {
      return this._skipSignal('INSUFFICIENT_CANDLES', `Only ${candles.length} valid completed candles`, {
        candleInterval: cfg.interval,
        completedCandles: candles.length,
        hasTradeData,
        hasOrderbookData,
        usedFallback: false,
      });
    }

    // DR-3: Stale candles
    const age = candleAgeSecs(candles, intervalMs);
    if (age > cfg.maxCandleAgeSecs) {
      return this._skipSignal('STALE_CANDLES', `Newest candle age ${age.toFixed(0)}s > ${cfg.maxCandleAgeSecs}s`, {
        candleInterval: cfg.interval,
        completedCandles: candles.length,
        hasTradeData,
        hasOrderbookData,
        usedFallback: false,
      });
    }

    // ── Compute components ────────────────────────────────────────────────
    const candleMomentum = scoreCandleMomentum(candles);
    const wickRejection = scoreWickRejection(candles);
    const volumeAcceleration = scoreVolumeAcceleration(candles);
    const tradePressure = hasTradeData ? scoreTradePressure(rawTrades) : 0.5;
    const orderbookImbalance = hasOrderbookData
      ? scoreOrderbookImbalance(obDepth.bids, obDepth.asks)
      : 0.5;

    const components = { candleMomentum, wickRejection, volumeAcceleration, tradePressure, orderbookImbalance };

    // ── Regime from 5m candles ────────────────────────────────────────────
    const candles5m = validateCandles(rawCandles5m, 5 * 60 * 1000);
    const regime = detectRegime(candles5m);

    // ── Fee/Spread Edge Guard (disabled for FARM — volume-first mode) ────
    // FARM accepts thin edges; the existing EXEC_MAX_SPREAD_BPS in Executor
    // already guards against truly unacceptable spreads at order placement.
    // Only block for invalid market data or extreme spread.
    let spreadBps = 0;
    if (hasOrderbookData && obDepth.bids.length > 0 && obDepth.asks.length > 0) {
      const bestBid = obDepth.bids[0][0];
      const bestAsk = obDepth.asks[0][0];
      const mid = (bestBid + bestAsk) / 2;
      if (mid > 0) spreadBps = ((bestAsk - bestBid) / mid) * 10000;
    }

    // Only check spread gate (not fee edge) — FARM tolerates thin edges
    const feeEdgeBlock = spreadBps > cfg.execMaxSpreadBps ? 'SPREAD_TOO_WIDE' as const : null;

    // ── Composite score & direction ───────────────────────────────────────
    const { score, direction, confidence, reason } = computeComposite({ components, regime, cfg });

    // Apply fee edge block AFTER direction (so we still log score)
    let finalDirection = direction;
    let finalReason = reason;
    if (finalDirection !== 'skip' && feeEdgeBlock) {
      finalDirection = 'skip';
      finalReason = `${feeEdgeBlock}: spreadBps=${spreadBps.toFixed(1)}`;
    }

    // ── Data quality adjustments ──────────────────────────────────────────
    let finalConfidence = confidence;
    let usedFallback = false;

    // Degraded mode: 10-20 candles, reduce confidence 20%
    if (candles.length < 21) {
      finalConfidence *= 0.80;
      usedFallback = true;
    }
    // Missing trade data: reduce confidence 10%
    if (!hasTradeData) finalConfidence *= 0.90;
    // Missing orderbook: reduce confidence 10%
    if (!hasOrderbookData) finalConfidence *= 0.90;
    // Both missing + not enough candles: skip
    if (!hasTradeData && !hasOrderbookData && candles.length < 21) {
      finalDirection = 'skip';
      finalReason = 'INSUFFICIENT_CANDLES: candle-only mode requires >= 21 candles';
    }

    finalConfidence = clamp01(finalConfidence);

    // ── Build result ──────────────────────────────────────────────────────
    const signal: FarmMicroSignal = {
      direction: finalDirection,
      score,
      confidence: finalConfidence,
      regime,
      components,
      dataQuality: {
        candleInterval: cfg.interval,
        completedCandles: candles.length,
        hasTradeData,
        hasOrderbookData,
        usedFallback,
      },
      reason: finalReason,
      signalSource: 'farm_micro',
    };

    // Log
    const dir = finalDirection.toUpperCase().padEnd(5);
    console.log(
      `[FarmMicro] ${symbol} ${cfg.interval} score=${score.toFixed(2)} conf=${finalConfidence.toFixed(2)} dir=${dir} regime=${regime} ` +
      `mom=${candleMomentum.toFixed(2)} wick=${wickRejection.toFixed(2)} vol=${volumeAcceleration.toFixed(2)} ` +
      `pressure=${tradePressure.toFixed(2)} ob=${orderbookImbalance.toFixed(2)} age=${age.toFixed(0)}s`
    );

    return signal;
  }

  private _skipSignal(
    reasonCode: SkipReason,
    detail: string,
    dataQuality: FarmMicroSignal['dataQuality'],
  ): FarmMicroSignal {
    console.log(`[FarmMicro] SKIP: ${reasonCode} — ${detail}`);
    return {
      direction: 'skip',
      score: 0.5,
      confidence: 0,
      regime: 'UNKNOWN',
      components: {
        candleMomentum: 0.5,
        wickRejection: 0.5,
        volumeAcceleration: 0.5,
        tradePressure: 0.5,
        orderbookImbalance: 0.5,
      },
      dataQuality,
      reason: `${reasonCode}: ${detail}`,
      signalSource: 'farm_micro',
    };
  }

  private _parseIntervalMs(interval: string): number {
    const match = interval.match(/^(\d+)(m|h|s)$/);
    if (!match) return 60_000; // default 1m
    const val = parseInt(match[1], 10);
    switch (match[2]) {
      case 'm': return val * 60_000;
      case 'h': return val * 3_600_000;
      case 's': return val * 1_000;
      default: return 60_000;
    }
  }
}
