"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
// Feature: ai-alpha-execution-engine, Property 4: AISignalEngine always returns a valid Signal
// **Validates: Requirements 3.1, 3.3**
const vitest_1 = require("vitest");
const fc = __importStar(require("fast-check"));
const axios_1 = __importDefault(require("axios"));
vitest_1.vi.mock('axios');
const mockedAxios = axios_1.default;
const AISignalEngine_js_1 = require("./AISignalEngine.js");
// Minimal valid klines response (50 candles)
function makeKlines(price = 50000) {
    return Array.from({ length: 50 }, (_, i) => [
        String(Date.now() - (50 - i) * 60000),
        String(price * 0.999),
        String(price * 1.001),
        String(price * 0.998),
        String(price),
    ]);
}
function makeMockAdapter() {
    return {
        get_orderbook_depth: vitest_1.vi.fn().mockResolvedValue({
            bids: [[50000, 1.0]],
            asks: [[50001, 0.8]],
        }),
        get_recent_trades: vitest_1.vi.fn().mockResolvedValue([
            { side: 'buy', price: 50000, size: 1.0, timestamp: Date.now() },
            { side: 'sell', price: 50000, size: 0.5, timestamp: Date.now() },
        ]),
        get_mark_price: vitest_1.vi.fn().mockResolvedValue(50000),
        get_orderbook: vitest_1.vi.fn().mockResolvedValue({ best_bid: 49999, best_ask: 50001 }),
        place_limit_order: vitest_1.vi.fn().mockResolvedValue('order-id'),
        cancel_order: vitest_1.vi.fn().mockResolvedValue(true),
        cancel_all_orders: vitest_1.vi.fn().mockResolvedValue(true),
        get_open_orders: vitest_1.vi.fn().mockResolvedValue([]),
        get_position: vitest_1.vi.fn().mockResolvedValue(null),
        get_balance: vitest_1.vi.fn().mockResolvedValue(1000),
    };
}
const VALID_SIGNAL_FIELDS = [
    'base_score', 'regime', 'direction', 'confidence',
    'imbalance', 'tradePressure', 'score', 'chartTrend',
    'reasoning', 'fallback',
];
function assertValidSignal(signal) {
    (0, vitest_1.expect)(signal).toBeDefined();
    (0, vitest_1.expect)(typeof signal).toBe('object');
    const s = signal;
    for (const field of VALID_SIGNAL_FIELDS) {
        (0, vitest_1.expect)(s).toHaveProperty(field);
    }
    (0, vitest_1.expect)(typeof s.base_score).toBe('number');
    (0, vitest_1.expect)(['TREND_UP', 'TREND_DOWN', 'SIDEWAY']).toContain(s.regime);
    (0, vitest_1.expect)(['long', 'short', 'skip']).toContain(s.direction);
    (0, vitest_1.expect)(typeof s.confidence).toBe('number');
    (0, vitest_1.expect)(typeof s.imbalance).toBe('number');
    (0, vitest_1.expect)(typeof s.tradePressure).toBe('number');
    (0, vitest_1.expect)(typeof s.score).toBe('number');
    (0, vitest_1.expect)(['bullish', 'bearish', 'neutral']).toContain(s.chartTrend);
    (0, vitest_1.expect)(typeof s.reasoning).toBe('string');
    (0, vitest_1.expect)(typeof s.fallback).toBe('boolean');
}
(0, vitest_1.describe)('AISignalEngine', () => {
    (0, vitest_1.beforeEach)(() => {
        vitest_1.vi.clearAllMocks();
        process.env.LLM_PROVIDER = 'openai';
        process.env.OPENAI_API_KEY = 'test-key';
    });
    // **Validates: Requirements 3.1, 3.3**
    // Property 4: AISignalEngine always returns a valid Signal regardless of failure mode
    (0, vitest_1.it)('P4: always returns a valid Signal with fallback:true on any LLM failure mode', async () => {
        await fc.assert(fc.asyncProperty(fc.oneof(
        // LLM timeout / network error
        fc.constant({ type: 'network_error' }), 
        // LLM returns malformed JSON
        fc.constant({ type: 'malformed_json' }), 
        // LLM returns null (missing fields)
        fc.constant({ type: 'null_return' }), 
        // LLM returns unexpected shape
        fc.constant({ type: 'wrong_shape' })), async (failureMode) => {
            const adapter = makeMockAdapter();
            // Binance klines and L/S ratio succeed
            mockedAxios.get = vitest_1.vi.fn().mockImplementation((url) => {
                if (url.includes('klines')) {
                    return Promise.resolve({ data: makeKlines() });
                }
                if (url.includes('topLongShortPositionRatio')) {
                    return Promise.resolve({ data: [{ longShortRatio: '1.2' }] });
                }
                // SoSoValue — return null-ish (simulate failure)
                return Promise.reject(new Error('SoSoValue unavailable'));
            });
            // Mock LLM (axios.post) based on failure mode
            const { default: axiosModule } = await import('axios');
            const mockedPost = vitest_1.vi.fn();
            switch (failureMode.type) {
                case 'network_error':
                    mockedPost.mockRejectedValue(new Error('Network timeout'));
                    break;
                case 'malformed_json':
                    mockedPost.mockResolvedValue({
                        data: { choices: [{ message: { content: 'not valid json {{{{' } }] },
                    });
                    break;
                case 'null_return':
                    mockedPost.mockResolvedValue({
                        data: { choices: [{ message: { content: 'null' } }] },
                    });
                    break;
                case 'wrong_shape':
                    mockedPost.mockResolvedValue({
                        data: { choices: [{ message: { content: '{"foo":"bar"}' } }] },
                    });
                    break;
            }
            axiosModule.post = mockedPost;
            // Also mock SignalEngine's axios calls (fallback path uses same axios)
            // The adapter mock handles orderbook/trades; klines/ratio are mocked above
            const engine = new AISignalEngine_js_1.AISignalEngine(adapter);
            let signal;
            let threw = false;
            try {
                signal = await engine.getSignal('BTC-USD');
            }
            catch {
                threw = true;
            }
            (0, vitest_1.expect)(threw).toBe(false);
            assertValidSignal(signal);
            (0, vitest_1.expect)(signal.fallback).toBe(true);
        }), { numRuns: 20 });
    });
    (0, vitest_1.it)('returns fallback:true and reasoning:"" when LLM returns null', async () => {
        const adapter = makeMockAdapter();
        mockedAxios.get = vitest_1.vi.fn().mockImplementation((url) => {
            if (url.includes('klines')) {
                return Promise.resolve({ data: makeKlines() });
            }
            if (url.includes('topLongShortPositionRatio')) {
                return Promise.resolve({ data: [{ longShortRatio: '1.5' }] });
            }
            return Promise.reject(new Error('SoSoValue unavailable'));
        });
        const axiosModule = await import('axios');
        axiosModule.default.post = vitest_1.vi.fn().mockRejectedValue(new Error('LLM timeout'));
        const engine = new AISignalEngine_js_1.AISignalEngine(adapter);
        const signal = await engine.getSignal('BTC-USD');
        assertValidSignal(signal);
        (0, vitest_1.expect)(signal.fallback).toBe(true);
        (0, vitest_1.expect)(signal.reasoning).toBe('');
    });
    (0, vitest_1.it)('returns fallback:false and reasoning from LLM on success', async () => {
        const adapter = makeMockAdapter();
        mockedAxios.get = vitest_1.vi.fn().mockImplementation((url) => {
            if (url.includes('klines')) {
                return Promise.resolve({ data: makeKlines() });
            }
            if (url.includes('topLongShortPositionRatio')) {
                return Promise.resolve({ data: [{ longShortRatio: '1.5' }] });
            }
            return Promise.reject(new Error('SoSoValue unavailable'));
        });
        const llmResponse = JSON.stringify({
            direction: 'long',
            confidence: 0.85,
            reasoning: 'Market is oversold based on contrarian signals.',
        });
        const axiosModule = await import('axios');
        axiosModule.default.post = vitest_1.vi.fn().mockResolvedValue({
            data: { choices: [{ message: { content: llmResponse } }] },
        });
        const engine = new AISignalEngine_js_1.AISignalEngine(adapter);
        const signal = await engine.getSignal('BTC-USD');
        assertValidSignal(signal);
        (0, vitest_1.expect)(signal.fallback).toBe(false);
        (0, vitest_1.expect)(signal.direction).toBe('long');
        (0, vitest_1.expect)(signal.confidence).toBe(0.85);
        (0, vitest_1.expect)(signal.reasoning).toBe('Market is oversold based on contrarian signals.');
    });
    (0, vitest_1.it)('never throws even when adapter completely fails', async () => {
        const brokenAdapter = {
            get_orderbook_depth: vitest_1.vi.fn().mockRejectedValue(new Error('Adapter down')),
            get_recent_trades: vitest_1.vi.fn().mockRejectedValue(new Error('Adapter down')),
            get_mark_price: vitest_1.vi.fn().mockRejectedValue(new Error('Adapter down')),
            get_orderbook: vitest_1.vi.fn().mockRejectedValue(new Error('Adapter down')),
            place_limit_order: vitest_1.vi.fn().mockRejectedValue(new Error('Adapter down')),
            cancel_order: vitest_1.vi.fn().mockRejectedValue(new Error('Adapter down')),
            cancel_all_orders: vitest_1.vi.fn().mockRejectedValue(new Error('Adapter down')),
            get_open_orders: vitest_1.vi.fn().mockRejectedValue(new Error('Adapter down')),
            get_position: vitest_1.vi.fn().mockRejectedValue(new Error('Adapter down')),
            get_balance: vitest_1.vi.fn().mockRejectedValue(new Error('Adapter down')),
        };
        mockedAxios.get = vitest_1.vi.fn().mockRejectedValue(new Error('Network down'));
        const engine = new AISignalEngine_js_1.AISignalEngine(brokenAdapter);
        let signal;
        let threw = false;
        try {
            signal = await engine.getSignal('BTC-USD');
        }
        catch {
            threw = true;
        }
        (0, vitest_1.expect)(threw).toBe(false);
        assertValidSignal(signal);
        (0, vitest_1.expect)(signal.fallback).toBe(true);
    });
});
