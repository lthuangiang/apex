import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { signalToEmbedding, parseLLMResponse } from '../signalEmbedding.js';
import type { MemorySignal } from '../types.js';

// Arbitrary for valid MemorySignal
const signalArb = fc.record<MemorySignal>({
  price: fc.float({ min: 1, max: 1_000_000, noNaN: true }),
  sma50: fc.float({ min: 1, max: 1_000_000, noNaN: true }),
  ls_ratio: fc.float({ min: 0, max: 1, noNaN: true }),
  orderbook_imbalance: fc.float({ min: 0, max: 1, noNaN: true }),
  buy_pressure: fc.float({ min: 0, max: 1, noNaN: true }),
  rsi: fc.float({ min: 0, max: 100, noNaN: true }),
});

describe('Property: signalToEmbedding', () => {
  it('always returns 6 floats in [0, 1]', () => {
    fc.assert(fc.property(signalArb, (signal) => {
      const emb = signalToEmbedding(signal);
      expect(emb).toHaveLength(6);
      for (const v of emb) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
        expect(Number.isFinite(v)).toBe(true);
      }
    }));
  });

  it('is deterministic for any signal', () => {
    fc.assert(fc.property(signalArb, (signal) => {
      expect(signalToEmbedding(signal)).toEqual(signalToEmbedding(signal));
    }));
  });
});

describe('Property: parseLLMResponse', () => {
  it('never throws for any string input', () => {
    fc.assert(fc.property(fc.string(), fc.float({ min: 0, max: 1, noNaN: true }), (raw, winRate) => {
      expect(() => parseLLMResponse(raw, winRate)).not.toThrow();
    }));
  });

  it('always returns a valid direction', () => {
    fc.assert(fc.property(fc.string(), fc.float({ min: 0, max: 1, noNaN: true }), (raw, winRate) => {
      const result = parseLLMResponse(raw, winRate);
      expect(['long', 'short', 'skip']).toContain(result.direction);
    }));
  });

  it('always returns confidence in [0, 1]', () => {
    fc.assert(fc.property(fc.string(), fc.float({ min: 0, max: 1, noNaN: true }), (raw, winRate) => {
      const result = parseLLMResponse(raw, winRate);
      expect(result.confidence).toBeGreaterThanOrEqual(0);
      expect(result.confidence).toBeLessThanOrEqual(1);
    }));
  });

  it('winRateOfSimilar always equals the passed-in value', () => {
    fc.assert(fc.property(fc.string(), fc.float({ min: 0, max: 1, noNaN: true }), (raw, winRate) => {
      const result = parseLLMResponse(raw, winRate);
      expect(result.winRateOfSimilar).toBeCloseTo(winRate);
    }));
  });
});
