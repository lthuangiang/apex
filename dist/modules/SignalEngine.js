"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.SignalEngine = void 0;
const config_js_1 = require("../config.js");
const axios_1 = __importDefault(require("axios"));
class SignalEngine {
    adapter;
    constructor(adapter) {
        this.adapter = adapter;
    }
    async getChartSignal(symbol, interval, limit) {
        try {
            const sym = symbol.replace('-', '').toUpperCase();
            const url = `https://fapi.binance.com/fapi/v1/klines`;
            const params = { symbol: sym, interval, limit };
            console.log(`[Binance REQ] GET ${url} | Params: ${JSON.stringify(params)}`);
            const res = await axios_1.default.get(url, { params });
            console.log(`[Binance RES] Klines Status: ${res.status} | Data Length: ${res.data?.length}`);
            const candles = res.data; // [OpenTime, Open, High, Low, Close, Volume, ...]
            if (!candles || candles.length === 0)
                return null;
            const lastCandle = candles[candles.length - 1];
            const closePrice = parseFloat(lastCandle[4]);
            const openPrice = parseFloat(lastCandle[1]);
            const high = parseFloat(lastCandle[2]);
            const low = parseFloat(lastCandle[3]);
            // 1. Tính SMA 10 (Trung bình giá đóng cửa)
            const avgClose = candles.reduce((sum, c) => sum + parseFloat(c[4]), 0) / candles.length;
            // 2. Phân tích Râu nến (Price Action)
            const body = Math.abs(closePrice - openPrice);
            const lowerTail = Math.max(0, Math.min(openPrice, closePrice) - low);
            const upperTail = Math.max(0, high - Math.max(openPrice, closePrice));
            // Tỷ lệ râu dưới vs nến (Bullish Hammer detection)
            const tailBullish = lowerTail > body * 1.5;
            const tailBearish = upperTail > body * 1.5;
            return {
                price: closePrice,
                avgClose,
                isBullish: closePrice > avgClose,
                isGreen: closePrice > openPrice,
                tailBullish,
                tailBearish,
                priceChange: ((closePrice - openPrice) / openPrice) * 100
            };
        }
        catch (e) {
            console.error('[SignalEngine] Chart error:', e);
            return null;
        }
    }
    async getSignal(symbol) {
        try {
            // 1. Lấy dữ liệu song song (Orderbook, Trades, Binance Ratio và Chart Klines)
            const normalizedBase = symbol.split('-')[0].replace('/', '').toUpperCase();
            const symbolUpper = `${normalizedBase}USDT`;
            const ratioUrl = `https://fapi.binance.com/futures/data/topLongShortPositionRatio`;
            const ratioParams = { symbol: symbolUpper, period: '15m', limit: 1 };
            console.log(`[Binance REQ] GET ${ratioUrl} | Params: ${JSON.stringify(ratioParams)}`);
            const [ob, trades, lsRatioRes, chart] = await Promise.all([
                this.adapter.get_orderbook_depth(symbol, 20),
                this.adapter.get_recent_trades(symbol, 100),
                axios_1.default.get(ratioUrl, { params: ratioParams }),
                this.getChartSignal(symbolUpper, config_js_1.config.CHART_INTERVAL, config_js_1.config.CHART_LIMIT)
            ]);
            console.log(`[Binance RES] Ratio Data: ${JSON.stringify(lsRatioRes.data[0])}`);
            // 2. Tính Orderbook Imbalance (Continuous)
            const bidVol = ob.bids.reduce((sum, b) => sum + b[1], 0);
            const askVol = ob.asks.reduce((sum, a) => sum + a[1], 0);
            const imbalance = bidVol / (askVol || 1);
            const imbScore = Math.min(Math.max((imbalance - 1) * 0.5 + 0.5, 0), 1);
            // 3. Tính Trade Pressure
            // Contrarian: buy pressure cao → SHORT signal (invert)
            const buyVol = trades.filter(t => t.side === 'buy').reduce((sum, t) => sum + t.size, 0);
            const sellVol = trades.filter(t => t.side === 'sell').reduce((sum, t) => sum + t.size, 0);
            const tradePressure = buyVol / (buyVol + sellVol || 1);
            const tradePressureScore = 1 - tradePressure; // Inverted for contrarian
            // 4. Lấy dữ liệu Ratio từ Binance
            // Contrarian: crowd long nhiều → SHORT signal (lsScore thấp), crowd short nhiều → LONG signal (lsScore cao)
            const lsData = lsRatioRes.data[0];
            const ratio = lsData ? parseFloat(lsData.longShortRatio) : 1;
            const lsScore = Math.min(Math.max((-ratio + 2) * 0.5, 0), 1); // Inverted: ratio > 1 → score < 0.5
            // 5. Tính Chart Score (Price Action)
            // Contrarian: giá trên SMA (overextended up) → SHORT signal (chartScore thấp)
            //             giá dưới SMA (overextended down) → LONG signal (chartScore cao)
            let chartScore = 0.5;
            let trend = 'neutral';
            if (chart) {
                // Invert: isBullish (price > SMA) → bearish contrarian signal
                chartScore = chart.isBullish ? 0.3 : 0.7;
                if (chart.isGreen)
                    chartScore -= 0.1;
                else
                    chartScore += 0.1; // Green candle = overbought → lower score
                if (chart.tailBullish)
                    chartScore += 0.2; // Hammer = bounce signal → LONG
                if (chart.tailBearish)
                    chartScore -= 0.2; // Shooting star = rejection → SHORT
                chartScore = Math.min(Math.max(chartScore, 0), 1);
                // trend label reflects price action (not signal direction)
                trend = chart.isBullish ? 'bullish' : 'bearish';
            }
            // 6. GOLDEN RULE: Kết hợp trọng số (Chart chiếm 50% để quyết định trend chính)
            // 50% Chart (contrarian), 20% LS Ratio (contrarian), 15% Trade Pressure (contrarian), 15% Imbalance
            const score = (chartScore * 0.50) + (lsScore * 0.20) + (tradePressureScore * 0.15) + (imbScore * 0.15);
            const base_score = (score - 0.5) * 2; // Normalize to [-1, +1]
            // Regime Detection (using simple SMA distance logic)
            let regime = 'SIDEWAY';
            if (chart) {
                // 0.2% distance from SMA to define trend vs sideway
                if (chart.price > chart.avgClose * 1.002)
                    regime = 'TREND_UP';
                else if (chart.price < chart.avgClose * 0.998)
                    regime = 'TREND_DOWN';
            }
            console.log(`[Signal Debug] Symbol: ${symbol} [CONTRARIAN MODE]`);
            console.log(`   - Chart (${trend}): Score ${chartScore.toFixed(2)} (inverted, Weight 50%)`);
            console.log(`   - L/S Ratio (${ratio.toFixed(2)}): Score ${lsScore.toFixed(2)} (inverted, Weight 20%)`);
            console.log(`   - Trade Flow (Pressure ${tradePressure.toFixed(2)}): Score ${tradePressureScore.toFixed(2)} (inverted, Weight 15%)`);
            console.log(`   - Orderbook (Imbalance ${imbalance.toFixed(2)}): Score ${imbScore.toFixed(2)} (Weight 15%)`);
            console.log(`   => TOTAL SCORE: ${score.toFixed(2)} | BASE_SCORE: ${base_score.toFixed(2)}`);
            console.log(`   => REGIME DETECTED: ${regime}`);
            // 7. Xác định Direction dựa trên Mode và Neutral Zone
            let direction = 'skip';
            const [neutralMin, neutralMax] = config_js_1.config.NEUTRAL_ZONE;
            if (score > neutralMax)
                direction = 'long';
            else if (score < neutralMin)
                direction = 'short';
            else
                direction = 'skip';
            // 8. Tính Confidence
            const confidence = Math.abs(score - 0.5) * 2;
            return {
                base_score,
                regime,
                direction,
                confidence,
                imbalance,
                tradePressure,
                score,
                chartTrend: trend,
                reasoning: '',
                fallback: false
            };
        }
        catch (error) {
            console.error('[SignalEngine] Error:', error);
            return { base_score: 0, regime: 'SIDEWAY', direction: 'skip', confidence: 0, imbalance: 1, tradePressure: 0.5, score: 0.5, chartTrend: 'neutral', reasoning: '', fallback: false };
        }
    }
}
exports.SignalEngine = SignalEngine;
