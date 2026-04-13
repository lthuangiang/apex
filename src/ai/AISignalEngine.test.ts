// Feature: ai-alpha-execution-engine, Property 4: AISignalEngine always returns a valid Signal
// **Validates: Requirements 3.1, 3.3**
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fc from 'fast-check';
import axios from 'axios';

vi.mock('axios');
const mockedAxios = axios as unknown as {
  get: ReturnType<typeof vi.fn>;
};

import { AISignalEngine } from './AISignalEngine.js';
import type { ExchangeAdapter } from '../adapters/ExchangeAdapter.js';

// Minimal valid klines response (50 candles)
function makeKlines(price = 50000): [string, string, string, string, string][] {
  return Array.from({ length: 50 }, (_, i) => [
    String(Date.now() - (50 - i) * 60000),
    String(price * 0.999),
    String(price * 1.001),
    String(price * 0.998),
    String(price),
  ]);
}

function makeMockAdapter(): ExchangeAdapter {
  return {
    get_orderbook_depth: vi.fn().mockResolvedValue({
      bids: [[50000, 1.0]],
      asks: [[50001, 0.8]],
    }),
    get_recent_trades: vi.fn().mockResolvedValue([
      { side: 'buy', price: 50000, size: 1.0, timestamp: Date.now() },
      { side: 'sell', price: 50000, size: 0.5, timestamp: Date.now() },
    ]),
    get_mark_price: vi.fn().mockResolvedValue(50000),
    get_orderbook: vi.fn().mockResolvedValue({ best_bid: 49999, best_ask: 50001 }),
    place_limit_order: vi.fn().mockResolvedValue('order-id'),
    cancel_order: vi.fn().mockResolvedValue(true),
    cancel_all_orders: vi.fn().mockResolvedValue(true),
    get_open_orders: vi.fn().mockResolvedValue([]),
    get_position: vi.fn().mockResolvedValue(null),
    get_balance: vi.fn().mockResolvedValue(1000),
  };
}

const VALID_SIGNAL_FIELDS = [
  'base_score', 'regime', 'direction', 'confidence',
  'imbalance', 'tradePressure', 'score', 'chartTrend',
  'reasoning', 'fallback',
] as const;

function assertValidSignal(signal: unknown): void {
  expect(signal).toBeDefined();
  expect(typeof signal).toBe('object');
  const s = signal as Record<string, unknown>;

  for (const field of VALID_SIGNAL_FIELDS) {
    expect(s).toHaveProperty(field);
  }

  expect(typeof s.base_score).toBe('number');
  expect(['TREND_UP', 'TREND_DOWN', 'SIDEWAY']).toContain(s.regime);
  expect(['long', 'short', 'skip']).toContain(s.direction);
  expect(typeof s.confidence).toBe('number');
  expect(typeof s.imbalance).toBe('number');
  expect(typeof s.tradePressure).toBe('number');
  expect(typeof s.score).toBe('number');
  expect(['bullish', 'bearish', 'neutral']).toContain(s.chartTrend);
  expect(typeof s.reasoning).toBe('string');
  expect(typeof s.fallback).toBe('boolean');
}

describe('AISignalEngine', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.LLM_PROVIDER = 'openai';
    process.env.OPENAI_API_KEY = 'test-key';
  });

  // **Validates: Requirements 3.1, 3.3**
  // Property 4: AISignalEngine always returns a valid Signal regardless of failure mode
  it('P4: always returns a valid Signal with fallback:true on any LLM failure mode', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.oneof(
          // LLM timeout / network error
          fc.constant({ type: 'network_error' as const }),
          // LLM returns malformed JSON
          fc.constant({ type: 'malformed_json' as const }),
          // LLM returns null (missing fields)
          fc.constant({ type: 'null_return' as const }),
          // LLM returns unexpected shape
          fc.constant({ type: 'wrong_shape' as const }),
        ),
        async (failureMode) => {
          const adapter = makeMockAdapter();

          // Binance klines and L/S ratio succeed
          mockedAxios.get = vi.fn().mockImplementation((url: string) => {
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
          const mockedPost = vi.fn();

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

          (axiosModule as unknown as { post: typeof mockedPost }).post = mockedPost;

          // Also mock SignalEngine's axios calls (fallback path uses same axios)
          // The adapter mock handles orderbook/trades; klines/ratio are mocked above

          const engine = new AISignalEngine(adapter);
          let signal: unknown;
          let threw = false;

          try {
            signal = await engine.getSignal('BTC-USD');
          } catch {
            threw = true;
          }

          expect(threw).toBe(false);
          assertValidSignal(signal);
          expect((signal as { fallback: boolean }).fallback).toBe(true);
        }
      ),
      { numRuns: 20 }
    );
  });

  it('returns fallback:true and reasoning:"" when LLM returns null', async () => {
    const adapter = makeMockAdapter();

    mockedAxios.get = vi.fn().mockImplementation((url: string) => {
      if (url.includes('klines')) {
        return Promise.resolve({ data: makeKlines() });
      }
      if (url.includes('topLongShortPositionRatio')) {
        return Promise.resolve({ data: [{ longShortRatio: '1.5' }] });
      }
      return Promise.reject(new Error('SoSoValue unavailable'));
    });

    const axiosModule = await import('axios');
    (axiosModule.default as unknown as { post: ReturnType<typeof vi.fn> }).post = vi.fn().mockRejectedValue(new Error('LLM timeout'));

    const engine = new AISignalEngine(adapter);
    const signal = await engine.getSignal('BTC-USD');

    assertValidSignal(signal);
    expect(signal.fallback).toBe(true);
    expect(signal.reasoning).toBe('');
  });

  it('returns fallback:false and reasoning from LLM on success', async () => {
    const adapter = makeMockAdapter();

    mockedAxios.get = vi.fn().mockImplementation((url: string) => {
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
    (axiosModule.default as unknown as { post: ReturnType<typeof vi.fn> }).post = vi.fn().mockResolvedValue({
      data: { choices: [{ message: { content: llmResponse } }] },
    });

    const engine = new AISignalEngine(adapter);
    const signal = await engine.getSignal('BTC-USD');

    assertValidSignal(signal);
    expect(signal.fallback).toBe(false);
    expect(signal.direction).toBe('long');
    expect(signal.confidence).toBe(0.85);
    expect(signal.reasoning).toBe('Market is oversold based on contrarian signals.');
  });

  it('never throws even when adapter completely fails', async () => {
    const brokenAdapter: ExchangeAdapter = {
      get_orderbook_depth: vi.fn().mockRejectedValue(new Error('Adapter down')),
      get_recent_trades: vi.fn().mockRejectedValue(new Error('Adapter down')),
      get_mark_price: vi.fn().mockRejectedValue(new Error('Adapter down')),
      get_orderbook: vi.fn().mockRejectedValue(new Error('Adapter down')),
      place_limit_order: vi.fn().mockRejectedValue(new Error('Adapter down')),
      cancel_order: vi.fn().mockRejectedValue(new Error('Adapter down')),
      cancel_all_orders: vi.fn().mockRejectedValue(new Error('Adapter down')),
      get_open_orders: vi.fn().mockRejectedValue(new Error('Adapter down')),
      get_position: vi.fn().mockRejectedValue(new Error('Adapter down')),
      get_balance: vi.fn().mockRejectedValue(new Error('Adapter down')),
    };

    mockedAxios.get = vi.fn().mockRejectedValue(new Error('Network down'));

    const engine = new AISignalEngine(brokenAdapter);
    let signal: unknown;
    let threw = false;

    try {
      signal = await engine.getSignal('BTC-USD');
    } catch {
      threw = true;
    }

    expect(threw).toBe(false);
    assertValidSignal(signal);
    expect((signal as { fallback: boolean }).fallback).toBe(true);
  });
});
