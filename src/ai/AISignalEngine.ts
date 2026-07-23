import axios from 'axios';
import { ExchangeAdapter } from '../adapters/ExchangeAdapter.js';
import { Signal, SignalEngine } from '../modules/SignalEngine.js';
import { weightStore } from './FeedbackLoop/WeightStore.js';
import { confidenceCalibrator } from './FeedbackLoop/ConfidenceCalibrator.js';
import { TradeLogger } from './TradeLogger.js';
import { RegimeDetector } from './RegimeDetector.js';
import { LLMReasoningAgent } from './LLMReasoningAgent.js';

// Fee per side (maker): 0.00012 = 0.012%
// Round-trip fee: 0.024% — need at least this much profit to break even
const FEE_RATE_PER_SIDE = 0.00012;
const ROUND_TRIP_FEE = FEE_RATE_PER_SIDE * 2;

function ema(values: number[], period: number): number[] {
    const k = 2 / (period + 1);
    const result: number[] = [];
    let prev = values[0];
    for (const v of values) {
        const e = v * k + prev * (1 - k);
        result.push(e);
        prev = e;
    }
    return result;
}

function rsi(closes: number[], period = 14): number {
    if (closes.length < period + 1) return 50;
    let gains = 0, losses = 0;
    for (let i = closes.length - period; i < closes.length; i++) {
        const diff = closes[i] - closes[i - 1];
        if (diff > 0) gains += diff;
        else losses -= diff;
    }
    const avgGain = gains / period;
    const avgLoss = losses / period;
    if (avgLoss === 0) return 100;
    const rs = avgGain / avgLoss;
    return 100 - 100 / (1 + rs);
}

/**
 * Xác định vị trí giá trong range N nến gần nhất (0 = đáy, 1 = đỉnh).
 * Dùng để tránh long ở đỉnh / short ở đáy trong SIDEWAY.
 */
function pricePositionInRange(closes: number[], highs: number[], lows: number[], lookback = 10): number {
    const recentHighs = highs.slice(-lookback);
    const recentLows = lows.slice(-lookback);
    const rangeHigh = Math.max(...recentHighs);
    const rangeLow = Math.min(...recentLows);
    const current = closes[closes.length - 1];
    if (rangeHigh === rangeLow) return 0.5;
    return (current - rangeLow) / (rangeHigh - rangeLow);
}

// Cache TTL: 60s — 5m candles change every 5 min, no point calling LLM more often than once per minute
const SIGNAL_CACHE_TTL_MS = 60_000;

export class AISignalEngine {
    private adapter: ExchangeAdapter;
    private _cache: { signal: Signal; cachedAt: number; symbol: string } | null = null;
    private tradeLogger: TradeLogger;

    constructor(adapter: ExchangeAdapter, tradeLogger?: TradeLogger) {
        this.adapter = adapter;
        this.tradeLogger = tradeLogger ?? new TradeLogger(
            (process.env.TRADE_LOG_BACKEND ?? 'json') as 'json' | 'sqlite',
            process.env.TRADE_LOG_PATH ?? './data/trades.json',
        );
    }

    /** Returns cached signal if still fresh (< 60s old), otherwise fetches a new one. */
    async getSignal(symbol: string, fearGreedIndex?: number): Promise<Signal> {
        const now = Date.now();
        if (
            this._cache &&
            this._cache.symbol === symbol &&
            now - this._cache.cachedAt < SIGNAL_CACHE_TTL_MS
        ) {
            const ageMs = now - this._cache.cachedAt;
            console.log(`[AISignalEngine] Using cached signal (age: ${(ageMs / 1000).toFixed(0)}s) — skipping LLM call`);
            return this._cache.signal;
        }
        const signal = await this._fetchSignal(symbol, fearGreedIndex);
        this._cache = { signal, cachedAt: now, symbol };
        return signal;
    }

    /** Force-invalidate cache (call after a trade is placed so next IDLE tick gets fresh signal). */
    invalidateCache(): void {
        this._cache = null;
    }

    private async _fetchSignal(symbol: string, fearGreedIndex?: number): Promise<Signal> {
        try {
            // Fetch orderbook, recent trades, and klines in parallel
            // Klines come from SoDEX directly if the adapter supports get_klines,
            // otherwise fall back to Binance futures API
            let klinesPromise: Promise<{ opens: number[]; closes: number[]; highs: number[]; lows: number[]; volumes: number[] }>;

            if (this.adapter.get_klines) {
                klinesPromise = this.adapter.get_klines(symbol, '5m', 30).then(candles => ({
                    opens:   candles.map(c => c.o),
                    closes:  candles.map(c => c.c),
                    highs:   candles.map(c => c.h),
                    lows:    candles.map(c => c.l),
                    volumes: candles.map(c => c.v),
                }));
            } else {
                // Fallback: Binance futures klines
                const normalizedBase = symbol.split('/')[0].split('-')[0].toUpperCase();
                const symbolUpper = `${normalizedBase}USDT`;
                klinesPromise = axios.get('https://fapi.binance.com/fapi/v1/klines', {
                    params: { symbol: symbolUpper, interval: '5m', limit: 30 },
                    timeout: 8000,
                }).then(res => {
                    const candles = res.data as [string, string, string, string, string, string, ...unknown[]][];
                    return {
                        opens:   candles.map(c => parseFloat(c[1])),
                        closes:  candles.map(c => parseFloat(c[4])),
                        highs:   candles.map(c => parseFloat(c[2])),
                        lows:    candles.map(c => parseFloat(c[3])),
                        volumes: candles.map(c => parseFloat(c[5])),
                    };
                });
            }

            const [ob, trades, klinesData] = await Promise.all([
                this.adapter.get_orderbook_depth(symbol, 20),
                this.adapter.get_recent_trades(symbol, 100),
                klinesPromise,
            ]);

            const { opens, closes, highs, lows, volumes } = klinesData;

            // Guard: if klines are empty (new symbol, data unavailable), fall back to orderbook-only signal
            if (!closes || closes.length < 10) {
                console.warn(`[AISignalEngine] Insufficient kline data for ${symbol} (${closes?.length ?? 0} candles) — using orderbook-only signal`);
                const bidVol = ob.bids.reduce((sum, b) => sum + b[1], 0);
                const askVol = ob.asks.reduce((sum, a) => sum + a[1], 0);
                const imbalance = bidVol / (askVol || 1);
                const direction = imbalance > 1.2 ? 'long' : imbalance < 0.8 ? 'short' : 'skip';
                return {
                    direction: direction as 'long' | 'short' | 'skip',
                    confidence: 0.3,
                    score: 0.5,
                    regime: 'SIDEWAY',
                    atrPct: 0,
                    tradePressure: 0.5,
                    reasoning: `Orderbook-only signal (no kline data): imbalance=${imbalance.toFixed(2)}`,
                    fallback: true,
                } as any;
            }

            const currentPrice = closes[closes.length - 1];

            // EMA9 and EMA21 for short-term momentum
            const ema9 = ema(closes, 9);
            const ema21 = ema(closes, 21);
            const ema9Last = ema9[ema9.length - 1];
            const ema21Last = ema21[ema21.length - 1];
            const ema9Prev = ema9[ema9.length - 2];
            const ema21Prev = ema21[ema21.length - 2];

            // EMA crossover signal
            const emaCrossUp = ema9Prev <= ema21Prev && ema9Last > ema21Last;
            const emaCrossDown = ema9Prev >= ema21Prev && ema9Last < ema21Last;
            const emaAbove = ema9Last > ema21Last; // momentum direction

            // RSI for overbought/oversold
            const rsiVal = rsi(closes, 14);
            const rsiOversold = rsiVal < 35;
            const rsiOverbought = rsiVal > 65;

            // Price momentum (last 3 candles)
            const momentum3 = (currentPrice - closes[closes.length - 4]) / closes[closes.length - 4];

            // Volume spike (current vs avg of last 10)
            const avgVol = volumes.slice(-11, -1).reduce((a, b) => a + b, 0) / 10;
            const volSpike = volumes[volumes.length - 1] > avgVol * 1.5;

            // Candle body analysis
            const lastOpen = opens[opens.length - 1];
            const lastHigh = highs[highs.length - 1];
            const lastLow = lows[lows.length - 1];
            const body = Math.abs(currentPrice - lastOpen);
            const lowerTail = Math.min(lastOpen, currentPrice) - lastLow;
            const upperTail = lastHigh - Math.max(lastOpen, currentPrice);
            const isGreenCandle = currentPrice > lastOpen;

            // Orderbook imbalance
            const bidVol = ob.bids.reduce((sum: number, b: [number, number]) => sum + b[1], 0);
            const askVol = ob.asks.reduce((sum: number, a: [number, number]) => sum + a[1], 0);
            const imbalance = bidVol / (askVol || 1);

            // Trade pressure (recent trades)
            const buyVol = trades.filter(t => t.side === 'buy').reduce((sum: number, t) => sum + t.size, 0);
            const sellVol = trades.filter(t => t.side === 'sell').reduce((sum: number, t) => sum + t.size, 0);
            const tradePressure = buyVol / (buyVol + sellVol || 1);

            // Built-in sentiment indicator (replaces Binance L/S ratio)
            // Combines: trade pressure, orderbook imbalance, volume trend
            // Range: 0-2 (1 = neutral, >1 = bullish, <1 = bearish)
            const sentimentScore = (
                tradePressure * 0.4 +           // 40% weight: recent trade flow
                (imbalance / 2) * 0.4 +         // 40% weight: orderbook depth
                (volSpike ? 0.15 : 0.05) * 2    // 20% weight: volume activity
            );

            // ── Momentum Score (0-1, >0.5 = bullish) ──────────────────────────
            // Farm mode: follow momentum, not contrarian
            let momentumScore = 0.5;

            // EMA trend (weight 40%)
            const emaTrend = emaAbove ? 0.65 : 0.35;
            const w = weightStore.getWeights();
            momentumScore = emaTrend * w.ema;

            // RSI (weight 25%) — oversold = buy, overbought = sell
            let rsiScore = 0.5;
            if (rsiOversold) rsiScore = 0.75;
            else if (rsiOverbought) rsiScore = 0.25;
            else rsiScore = 0.5 + (50 - rsiVal) / 100; // linear
            momentumScore += rsiScore * w.rsi;

            // Price momentum 3 candles (weight 20%)
            const momScore = Math.min(Math.max(momentum3 * 50 + 0.5, 0), 1);
            momentumScore += momScore * w.momentum;

            // Orderbook imbalance (weight 15%) — direct (not contrarian)
            const imbScore = Math.min(Math.max((imbalance - 1) * 0.5 + 0.5, 0), 1);
            momentumScore += imbScore * w.imbalance;

            // Candle pattern bonus/penalty
            if (emaCrossUp || (isGreenCandle && volSpike && lowerTail > body)) momentumScore += 0.05;
            if (emaCrossDown || (!isGreenCandle && volSpike && upperTail > body)) momentumScore -= 0.05;
            momentumScore = Math.min(Math.max(momentumScore, 0), 1);

            const base_score = (momentumScore - 0.5) * 2;

            // Regime
            const regimeDetector = new RegimeDetector();
            const regimeResult = regimeDetector.detect(closes, highs, lows, volumes, ema21Last);
            const { regime, atrPct, bbWidth, volRatio } = regimeResult;

            // ── Swing position in range (0=đáy, 1=đỉnh) ──────────────────────
            // Dùng 10 nến gần nhất để xác định giá đang ở đâu trong range
            const pricePosition = pricePositionInRange(closes, highs, lows, 10);

            // Trong SIDEWAY: penalize long khi giá ở đỉnh range, penalize short khi ở đáy
            if (regime === 'SIDEWAY') {
                if (pricePosition > 0.75) {
                    // Giá gần đỉnh range → giảm điểm bullish, tăng điểm bearish
                    momentumScore -= 0.08;
                } else if (pricePosition < 0.25) {
                    // Giá gần đáy range → tăng điểm bullish, giảm điểm bearish
                    momentumScore += 0.08;
                }
                momentumScore = Math.min(Math.max(momentumScore, 0), 1);
            }

            // ── Technical Signal Decision (no LLM) ───────────────────────────
            // LLM adds latency and noise — pure technical signal is more reliable
            // for short-term scalping based on recent candles
            let direction: 'long' | 'short' | 'skip';
            let confidence: number;
            let reasoning: string;

            // Minimum confidence threshold to avoid chop
            const MIN_CONFIDENCE = 0.55;

            if (regime === 'SIDEWAY') {
                // In SIDEWAY: use price position in range as primary signal
                // Bottom of range (<25%) → LONG, top of range (>75%) → SHORT
                // Tighten thresholds to avoid mid-range whipsaw
                if (pricePosition < 0.25 && rsiVal < 45) {
                    // Only LONG at bottom if RSI confirms oversold
                    direction = 'long';
                    confidence = 0.5 + (0.25 - pricePosition) * 2.0;
                    reasoning = `SIDEWAY: price at range bottom (${(pricePosition*100).toFixed(0)}%) RSI=${rsiVal.toFixed(1)} → LONG`;
                } else if (pricePosition > 0.75 && rsiVal > 55) {
                    // Only SHORT at top if RSI confirms overbought
                    direction = 'short';
                    confidence = 0.5 + (pricePosition - 0.75) * 2.0;
                    reasoning = `SIDEWAY: price at range top (${(pricePosition*100).toFixed(0)}%) RSI=${rsiVal.toFixed(1)} → SHORT`;
                } else {
                    // Mid-range or weak signal: SKIP to avoid chop
                    direction = 'skip';
                    confidence = 0;
                    reasoning = `SIDEWAY mid-range: pos=${(pricePosition*100).toFixed(0)}% RSI=${rsiVal.toFixed(1)} → SKIP (avoid chop)`;
                }
            } else if (regime === 'TREND_UP') {
                // In uptrend: prefer LONG, only SHORT on strong reversal signal
                if (momentumScore > 0.60 && !rsiOverbought) {
                    direction = 'long';
                    confidence = (momentumScore - 0.5) * 2;
                    reasoning = `TREND_UP: momentum=${momentumScore.toFixed(2)} RSI=${rsiVal.toFixed(1)} → LONG`;
                } else if (momentumScore < 0.35 && emaCrossDown) {
                    direction = 'short';
                    confidence = (0.5 - momentumScore) * 2;
                    reasoning = `TREND_UP reversal: EMA cross down, momentum=${momentumScore.toFixed(2)} → SHORT`;
                } else {
                    direction = 'skip';
                    confidence = 0;
                    reasoning = `TREND_UP: weak signal, momentum=${momentumScore.toFixed(2)} → SKIP`;
                }
            } else if (regime === 'TREND_DOWN') {
                // In downtrend: prefer SHORT, only LONG on strong reversal signal
                if (momentumScore < 0.40 && !rsiOversold) {
                    direction = 'short';
                    confidence = (0.5 - momentumScore) * 2;
                    reasoning = `TREND_DOWN: momentum=${momentumScore.toFixed(2)} RSI=${rsiVal.toFixed(1)} → SHORT`;
                } else if (momentumScore > 0.65 && emaCrossUp) {
                    direction = 'long';
                    confidence = (momentumScore - 0.5) * 2;
                    reasoning = `TREND_DOWN reversal: EMA cross up, momentum=${momentumScore.toFixed(2)} → LONG`;
                } else {
                    direction = 'skip';
                    confidence = 0;
                    reasoning = `TREND_DOWN: weak signal, momentum=${momentumScore.toFixed(2)} → SKIP`;
                }
            } else {
                // HIGH_VOLATILITY: require very strong signal or skip
                if (momentumScore > 0.65 && volSpike && isGreenCandle) {
                    direction = 'long';
                    confidence = (momentumScore - 0.5) * 2;
                    reasoning = `HIGH_VOL: strong bullish momentum=${momentumScore.toFixed(2)} → LONG`;
                } else if (momentumScore < 0.35 && volSpike && !isGreenCandle) {
                    direction = 'short';
                    confidence = (0.5 - momentumScore) * 2;
                    reasoning = `HIGH_VOL: strong bearish momentum=${momentumScore.toFixed(2)} → SHORT`;
                } else {
                    direction = 'skip';
                    confidence = 0;
                    reasoning = `HIGH_VOL: insufficient signal strength → SKIP`;
                }
            }

            // Apply minimum confidence filter
            if (confidence < MIN_CONFIDENCE) {
                direction = 'skip';
                reasoning += ` [conf=${confidence.toFixed(2)} < ${MIN_CONFIDENCE}]`;
                confidence = 0;
            }

            confidence = Math.min(1, Math.max(0, confidence));

            console.log(`[AISignalEngine] 5m | EMA9=${ema9Last.toFixed(0)} EMA21=${ema21Last.toFixed(0)} RSI=${rsiVal.toFixed(1)} Mom=${(momentum3*100).toFixed(3)}% pos=${(pricePosition*100).toFixed(0)}% | Score=${momentumScore.toFixed(2)} | ${direction.toUpperCase()} (${confidence.toFixed(2)}) | ${regime}`);

            const recentTrades = await this.tradeLogger.readAll();
            const calibratedConf = confidenceCalibrator.calibrate(confidence, recentTrades.slice(0, 50));

            // ── LLM Reasoning Agent ───────────────────────────────────────────
            // If LLM_REASONING_ENABLED=true, ask Ollama to write a human-readable
            // explanation. Falls back to the rule-based `reasoning` string on
            // timeout or if Ollama is not running. Non-blocking by design.
            const llmReasoning = await LLMReasoningAgent.getInstance().generateReasoning(
                {
                    symbol,
                    direction,
                    regime,
                    rsi: rsiVal,
                    ema9: ema9Last,
                    ema21: ema21Last,
                    momentumScore,
                    pricePosition,
                    volSpike,
                    imbalance,
                    tradePressure,
                    currentPrice,
                    confidence: calibratedConf,
                },
                reasoning,
            );

            // Apply SoSoValue Fear & Greed adjustment to confidence
            let adjustedConf = calibratedConf;
            if (fearGreedIndex !== undefined) {
                if (fearGreedIndex < 25 || fearGreedIndex > 75) {
                    adjustedConf = calibratedConf * 0.8; // Reduce confidence by 20% in extreme sentiment
                    console.log(`[AISignalEngine] Extreme sentiment (F&G: ${fearGreedIndex}) — confidence: ${calibratedConf.toFixed(2)} → ${adjustedConf.toFixed(2)}`);
                }
            }

            return {
                base_score,
                regime,
                direction,
                confidence: adjustedConf,
                imbalance,
                tradePressure,
                score: momentumScore,
                chartTrend: emaAbove ? 'bullish' : 'bearish',
                reasoning: llmReasoning,
                fallback: false,
                atrPct, bbWidth, volRatio,
                pricePositionInRange: pricePosition,
            };

        } catch (error) {
            console.error('[AISignalEngine] Error — falling back to SignalEngine:', error);
            try {
                const fallbackEngine = new SignalEngine(this.adapter);
                const fallbackSignal = await fallbackEngine.getSignal(symbol);
                return { ...fallbackSignal, fallback: true, reasoning: '' };
            } catch {
                return {
                    base_score: 0, regime: 'SIDEWAY', direction: 'skip',
                    confidence: 0, imbalance: 1, tradePressure: 0.5,
                    score: 0.5, chartTrend: 'neutral', reasoning: '', fallback: true,
                };
            }
        }
    } // end _fetchSignal
}
