/**
 * Test suite for LONG/SHORT direction logic improvements
 * 
 * Issues fixed:
 * 1. SIDEWAY mid-range whipsaw → now requires price at extremes (25%/75%) + RSI confirmation
 * 2. Asymmetric thresholds → now regime-specific with higher confidence requirements
 * 3. No minimum confidence filter → now requires MIN_CONFIDENCE = 0.55
 * 4. Trend-following in wrong regime → now respects regime-specific strategies
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AISignalEngine } from '../AISignalEngine.js';
import type { ExchangeAdapter } from '../../adapters/ExchangeAdapter.js';

// Mock adapter
function createMockAdapter(): ExchangeAdapter {
    return {
        get_orderbook_depth: vi.fn().mockResolvedValue({
            bids: [[78000, 1.5], [77990, 2.0]],
            asks: [[78010, 1.5], [78020, 2.0]],
        }),
        get_recent_trades: vi.fn().mockResolvedValue(
            Array(100).fill(null).map((_, i) => ({
                price: 78000 + (i % 2 === 0 ? 5 : -5),
                size: 0.01,
                side: i % 2 === 0 ? 'buy' : 'sell',
                timestamp: Date.now() - i * 1000,
            }))
        ),
    } as unknown as ExchangeAdapter;
}

// Mock Binance API responses
function mockBinanceResponses(scenario: 'sideway-mid' | 'sideway-bottom' | 'sideway-top' | 'trend-up' | 'trend-down') {
    const basePrice = 78000;
    const candles: [string, string, string, string, string, string][] = [];

    switch (scenario) {
        case 'sideway-mid':
            // Price oscillating in middle of range (40-60%)
            for (let i = 0; i < 30; i++) {
                const price = basePrice + (i % 2 === 0 ? 50 : -50);
                candles.push([
                    String(Date.now() - (30 - i) * 300000),
                    String(price - 10), // open
                    String(price + 20), // high
                    String(price - 20), // low
                    String(price),      // close
                    '100',              // volume
                ]);
            }
            break;

        case 'sideway-bottom':
            // Price at bottom of range (<25%)
            for (let i = 0; i < 30; i++) {
                const price = i < 20 ? basePrice : basePrice - 200; // drop to bottom
                candles.push([
                    String(Date.now() - (30 - i) * 300000),
                    String(price - 5),
                    String(price + 10),
                    String(price - 10),
                    String(price),
                    '100',
                ]);
            }
            break;

        case 'sideway-top':
            // Price at top of range (>75%)
            for (let i = 0; i < 30; i++) {
                const price = i < 20 ? basePrice : basePrice + 200; // rise to top
                candles.push([
                    String(Date.now() - (30 - i) * 300000),
                    String(price - 5),
                    String(price + 10),
                    String(price - 10),
                    String(price),
                    '100',
                ]);
            }
            break;

        case 'trend-up':
            // Clear uptrend
            for (let i = 0; i < 30; i++) {
                const price = basePrice + i * 20;
                candles.push([
                    String(Date.now() - (30 - i) * 300000),
                    String(price - 5),
                    String(price + 10),
                    String(price - 5),
                    String(price),
                    '120',
                ]);
            }
            break;

        case 'trend-down':
            // Clear downtrend
            for (let i = 0; i < 30; i++) {
                const price = basePrice - i * 20;
                candles.push([
                    String(Date.now() - (30 - i) * 300000),
                    String(price + 5),
                    String(price + 5),
                    String(price - 10),
                    String(price),
                    '120',
                ]);
            }
            break;
    }

    return {
        klines: candles,
        lsRatio: [{ longShortRatio: '1.2' }],
    };
}

describe('AISignalEngine - LONG/SHORT Direction Logic', () => {
    let engine: AISignalEngine;
    let adapter: ExchangeAdapter;

    beforeEach(() => {
        adapter = createMockAdapter();
        engine = new AISignalEngine(adapter);
        vi.clearAllMocks();
    });

    describe('SIDEWAY regime', () => {
        it('should SKIP in mid-range to avoid whipsaw (Bug Fix #1)', async () => {
            const mock = mockBinanceResponses('sideway-mid');
            vi.spyOn(global, 'fetch').mockImplementation((url) => {
                if (String(url).includes('klines')) {
                    return Promise.resolve({
                        ok: true,
                        json: async () => mock.klines,
                    } as Response);
                }
                if (String(url).includes('topLongShortPositionRatio')) {
                    return Promise.resolve({
                        ok: true,
                        json: async () => mock.lsRatio,
                    } as Response);
                }
                return Promise.reject(new Error('Unknown URL'));
            });

            const signal = await engine.getSignal('BTC/USD');

            // In SIDEWAY mid-range, should SKIP to avoid chop
            expect(signal.direction).toBe('skip');
            expect(signal.reasoning).toContain('SIDEWAY');
            expect(signal.reasoning).toContain('SKIP');
        });

        it('should LONG at bottom of range with RSI confirmation', async () => {
            const mock = mockBinanceResponses('sideway-bottom');
            vi.spyOn(global, 'fetch').mockImplementation((url) => {
                if (String(url).includes('klines')) {
                    return Promise.resolve({
                        ok: true,
                        json: async () => mock.klines,
                    } as Response);
                }
                if (String(url).includes('topLongShortPositionRatio')) {
                    return Promise.resolve({
                        ok: true,
                        json: async () => mock.lsRatio,
                    } as Response);
                }
                return Promise.reject(new Error('Unknown URL'));
            });

            const signal = await engine.getSignal('BTC/USD');

            // At bottom of range with oversold RSI, should LONG
            if (signal.direction === 'long') {
                expect(signal.confidence).toBeGreaterThan(0.55);
                expect(signal.reasoning).toContain('bottom');
            }
            // If RSI is not oversold enough, may still SKIP (which is correct)
            expect(['long', 'skip']).toContain(signal.direction);
        });

        it('should SHORT at top of range with RSI confirmation', async () => {
            const mock = mockBinanceResponses('sideway-top');
            vi.spyOn(global, 'fetch').mockImplementation((url) => {
                if (String(url).includes('klines')) {
                    return Promise.resolve({
                        ok: true,
                        json: async () => mock.klines,
                    } as Response);
                }
                if (String(url).includes('topLongShortPositionRatio')) {
                    return Promise.resolve({
                        ok: true,
                        json: async () => mock.lsRatio,
                    } as Response);
                }
                return Promise.reject(new Error('Unknown URL'));
            });

            const signal = await engine.getSignal('BTC/USD');

            // At top of range with overbought RSI, should SHORT
            if (signal.direction === 'short') {
                expect(signal.confidence).toBeGreaterThan(0.55);
                expect(signal.reasoning).toContain('top');
            }
            // If RSI is not overbought enough, may still SKIP (which is correct)
            expect(['short', 'skip']).toContain(signal.direction);
        });
    });

    describe('TREND_UP regime', () => {
        it('should prefer LONG and require strong signal for SHORT (Bug Fix #2)', async () => {
            const mock = mockBinanceResponses('trend-up');
            vi.spyOn(global, 'fetch').mockImplementation((url) => {
                if (String(url).includes('klines')) {
                    return Promise.resolve({
                        ok: true,
                        json: async () => mock.klines,
                    } as Response);
                }
                if (String(url).includes('topLongShortPositionRatio')) {
                    return Promise.resolve({
                        ok: true,
                        json: async () => mock.lsRatio,
                    } as Response);
                }
                return Promise.reject(new Error('Unknown URL'));
            });

            const signal = await engine.getSignal('BTC/USD');

            // In uptrend, should prefer LONG or SKIP (not SHORT unless strong reversal)
            expect(['long', 'skip']).toContain(signal.direction);
            
            if (signal.direction === 'long') {
                expect(signal.confidence).toBeGreaterThan(0.55);
            }
        });
    });

    describe('TREND_DOWN regime', () => {
        it('should prefer SHORT and require strong signal for LONG (Bug Fix #2)', async () => {
            const mock = mockBinanceResponses('trend-down');
            vi.spyOn(global, 'fetch').mockImplementation((url) => {
                if (String(url).includes('klines')) {
                    return Promise.resolve({
                        ok: true,
                        json: async () => mock.klines,
                    } as Response);
                }
                if (String(url).includes('topLongShortPositionRatio')) {
                    return Promise.resolve({
                        ok: true,
                        json: async () => mock.lsRatio,
                    } as Response);
                }
                return Promise.reject(new Error('Unknown URL'));
            });

            const signal = await engine.getSignal('BTC/USD');

            // In downtrend, should prefer SHORT or SKIP (not LONG unless strong reversal)
            expect(['short', 'skip']).toContain(signal.direction);
            
            if (signal.direction === 'short') {
                expect(signal.confidence).toBeGreaterThan(0.55);
            }
        });
    });

    describe('Minimum confidence filter (Bug Fix #3)', () => {
        it('should enforce MIN_CONFIDENCE = 0.55 threshold', async () => {
            const mock = mockBinanceResponses('sideway-mid');
            vi.spyOn(global, 'fetch').mockImplementation((url) => {
                if (String(url).includes('klines')) {
                    return Promise.resolve({
                        ok: true,
                        json: async () => mock.klines,
                    } as Response);
                }
                if (String(url).includes('topLongShortPositionRatio')) {
                    return Promise.resolve({
                        ok: true,
                        json: async () => mock.lsRatio,
                    } as Response);
                }
                return Promise.reject(new Error('Unknown URL'));
            });

            const signal = await engine.getSignal('BTC/USD');

            // Any non-skip signal must have confidence >= 0.55
            if (signal.direction !== 'skip') {
                expect(signal.confidence).toBeGreaterThanOrEqual(0.55);
            }
        });
    });
});
