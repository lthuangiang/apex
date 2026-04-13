"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AISignalEngine = void 0;
const axios_1 = __importDefault(require("axios"));
const SignalEngine_js_1 = require("../modules/SignalEngine.js");
const SoSoValueClient_js_1 = require("./SoSoValueClient.js");
const LLMClient_js_1 = require("./LLMClient.js");
class AISignalEngine {
    adapter;
    constructor(adapter) {
        this.adapter = adapter;
    }
    async getSignal(symbol) {
        try {
            // Instantiate clients from env vars
            const provider = (process.env.LLM_PROVIDER ?? 'openai');
            const apiKey = provider === 'anthropic'
                ? (process.env.ANTHROPIC_API_KEY ?? '')
                : (process.env.OPENAI_API_KEY ?? '');
            const sosoClient = new SoSoValueClient_js_1.SoSoValueClient();
            const llmClient = new LLMClient_js_1.LLMClient(provider, apiKey);
            // Normalize symbol to BTCUSDT format
            const normalizedBase = symbol.split('-')[0].replace('/', '').toUpperCase();
            const symbolUpper = `${normalizedBase}USDT`;
            // Fetch all data in parallel — SoSoValue null is OK
            const [sosoData, ob, trades, klinesRes, lsRatioRes] = await Promise.all([
                sosoClient.fetch(),
                this.adapter.get_orderbook_depth(symbol, 20),
                this.adapter.get_recent_trades(symbol, 100),
                axios_1.default.get('https://fapi.binance.com/fapi/v1/klines', {
                    params: { symbol: symbolUpper, interval: '15m', limit: 50 },
                    timeout: 10000,
                }),
                axios_1.default.get('https://fapi.binance.com/futures/data/topLongShortPositionRatio', {
                    params: { symbol: symbolUpper, period: '15m', limit: 1 },
                    timeout: 10000,
                }),
            ]);
            // Compute orderbook imbalance
            const bidVol = ob.bids.reduce((sum, b) => sum + b[1], 0);
            const askVol = ob.asks.reduce((sum, a) => sum + a[1], 0);
            const imbalance = bidVol / (askVol || 1);
            // Compute trade pressure
            const buyVol = trades.filter(t => t.side === 'buy').reduce((sum, t) => sum + t.size, 0);
            const sellVol = trades.filter(t => t.side === 'sell').reduce((sum, t) => sum + t.size, 0);
            const tradePressure = buyVol / (buyVol + sellVol || 1);
            // Compute SMA50 and current price from klines
            const candles = klinesRes.data;
            const avgClose = candles.reduce((sum, c) => sum + parseFloat(c[4]), 0) / candles.length;
            const currentPrice = parseFloat(candles[candles.length - 1][4]);
            // L/S ratio
            const lsData = lsRatioRes.data[0];
            const lsRatio = lsData ? parseFloat(lsData.longShortRatio) : 1;
            // Build MarketContext
            const ctx = {
                sma50: avgClose,
                currentPrice,
                lsRatio,
                imbalance,
                tradePressure,
                fearGreedIndex: sosoData?.fearGreedIndex ?? null,
                fearGreedLabel: sosoData?.fearGreedLabel ?? null,
                sectorIndex: sosoData?.sectorIndex ?? null,
            };
            // Call LLM — null means fallback
            const decision = await llmClient.call(ctx);
            if (decision === null) {
                console.warn('[AISignalEngine] LLM returned null — falling back to SignalEngine');
                const fallbackEngine = new SignalEngine_js_1.SignalEngine(this.adapter);
                const fallbackSignal = await fallbackEngine.getSignal(symbol);
                return { ...fallbackSignal, fallback: true, reasoning: '' };
            }
            // Compute additional Signal fields from market data (same logic as SignalEngine)
            const imbScore = Math.min(Math.max((imbalance - 1) * 0.5 + 0.5, 0), 1);
            const tradePressureScore = 1 - tradePressure;
            const lsScore = Math.min(Math.max((-lsRatio + 2) * 0.5, 0), 1);
            const isBullish = currentPrice > avgClose;
            let chartScore = isBullish ? 0.3 : 0.7;
            chartScore = Math.min(Math.max(chartScore, 0), 1);
            const chartTrend = isBullish ? 'bullish' : 'bearish';
            const score = (chartScore * 0.50) + (lsScore * 0.20) + (tradePressureScore * 0.15) + (imbScore * 0.15);
            const base_score = (score - 0.5) * 2;
            let regime = 'SIDEWAY';
            if (currentPrice > avgClose * 1.002)
                regime = 'TREND_UP';
            else if (currentPrice < avgClose * 0.998)
                regime = 'TREND_DOWN';
            return {
                base_score,
                regime,
                direction: decision.direction,
                confidence: decision.confidence,
                imbalance,
                tradePressure,
                score,
                chartTrend,
                reasoning: decision.reasoning,
                fallback: false,
            };
        }
        catch (error) {
            console.error('[AISignalEngine] Error — falling back to SignalEngine:', error);
            try {
                const fallbackEngine = new SignalEngine_js_1.SignalEngine(this.adapter);
                const fallbackSignal = await fallbackEngine.getSignal(symbol);
                return { ...fallbackSignal, fallback: true, reasoning: '' };
            }
            catch (fallbackError) {
                console.error('[AISignalEngine] Fallback also failed:', fallbackError);
                return {
                    base_score: 0,
                    regime: 'SIDEWAY',
                    direction: 'skip',
                    confidence: 0,
                    imbalance: 1,
                    tradePressure: 0.5,
                    score: 0.5,
                    chartTrend: 'neutral',
                    reasoning: '',
                    fallback: true,
                };
            }
        }
    }
}
exports.AISignalEngine = AISignalEngine;
