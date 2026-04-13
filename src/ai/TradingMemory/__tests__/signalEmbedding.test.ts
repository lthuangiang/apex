import { describe, it, expect } from 'vitest';
import { signalToEmbedding, buildPrompt, parseLLMResponse } from '../signalEmbedding.js';
import type { MemorySignal, TradeRecord } from '../types.js';

const baseSignal: MemorySignal = {
  price: 42500,
  sma50: 41800,
  ls_ratio: 0.62,
  orderbook_imbalance: 0.55,
  buy_pressure: 0.70,
  rsi: 58.3,
};

// ── signalToEmbedding ────────────────────────────────────────────────────────

describe('signalToEmbedding', () => {
  it('returns array of length 6', () => {
    expect(signalToEmbedding(baseSignal)).toHaveLength(6);
  });

  it('all values are in [0, 1]', () => {
    const emb = signalToEmbedding(baseSignal);
    for (const v of emb) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it('is deterministic', () => {
    expect(signalToEmbedding(baseSignal)).toEqual(signalToEmbedding(baseSignal));
  });

  it('computes known values correctly', () => {
    const emb = signalToEmbedding(baseSignal);
    const priceNorm = 42500 / (42500 + 41800);
    const sma50Norm = 41800 / (42500 + 41800);
    const rsiNorm = 58.3 / 100;
    expect(emb[0]).toBeCloseTo(priceNorm);
    expect(emb[1]).toBeCloseTo(sma50Norm);
    expect(emb[2]).toBeCloseTo(0.62);
    expect(emb[3]).toBeCloseTo(0.55);
    expect(emb[4]).toBeCloseTo(0.70);
    expect(emb[5]).toBeCloseTo(rsiNorm);
  });
});

// ── buildPrompt ──────────────────────────────────────────────────────────────

describe('buildPrompt', () => {
  it('contains all signal field values', () => {
    const prompt = buildPrompt(baseSignal, []);
    expect(prompt).toContain('42500');
    expect(prompt).toContain('41800');
    expect(prompt).toContain('0.62');
    expect(prompt).toContain('0.55');
    expect(prompt).toContain('0.7');
    expect(prompt).toContain('58.3');
  });

  it('contains trade outcomes when similar trades provided', () => {
    const trade: TradeRecord = {
      tradeId: 'abc',
      signal: baseSignal,
      decision: 'long',
      pnlPercent: 2.1,
      outcome: 'WIN',
      timestamp: '2024-01-01T00:00:00.000Z',
    };
    const prompt = buildPrompt(baseSignal, [trade]);
    expect(prompt).toContain('WIN');
    expect(prompt).toContain('long');
    expect(prompt).toContain('2.1');
  });

  it('handles empty similar trades gracefully', () => {
    const prompt = buildPrompt(baseSignal, []);
    expect(prompt).toContain('No historical trades available yet');
  });

  it('instructs LLM to return JSON with required keys', () => {
    const prompt = buildPrompt(baseSignal, []);
    expect(prompt).toContain('direction');
    expect(prompt).toContain('confidence');
    expect(prompt).toContain('reasoning');
  });
});

// ── parseLLMResponse ─────────────────────────────────────────────────────────

describe('parseLLMResponse', () => {
  it('parses valid JSON', () => {
    const raw = '{"direction": "long", "confidence": 0.8, "reasoning": "strong signal"}';
    const result = parseLLMResponse(raw, 0.7);
    expect(result.direction).toBe('long');
    expect(result.confidence).toBeCloseTo(0.8);
    expect(result.reasoning).toBe('strong signal');
    expect(result.winRateOfSimilar).toBeCloseTo(0.7);
  });

  it('extracts JSON embedded in prose', () => {
    const raw = 'Based on analysis: {"direction": "short", "confidence": 0.6, "reasoning": "overbought"} end.';
    const result = parseLLMResponse(raw, 0.3);
    expect(result.direction).toBe('short');
    expect(result.confidence).toBeCloseTo(0.6);
  });

  it('returns skip fallback for empty string', () => {
    const result = parseLLMResponse('', 0.5);
    expect(result.direction).toBe('skip');
    expect(result.confidence).toBe(0);
    expect(result.reasoning).toBe('parse_error');
  });

  it('returns skip fallback for garbage input', () => {
    const result = parseLLMResponse('not json at all!!!', 0.5);
    expect(result.direction).toBe('skip');
  });

  it('clamps confidence above 1.0', () => {
    const raw = '{"direction": "long", "confidence": 1.5, "reasoning": "test"}';
    const result = parseLLMResponse(raw, 0);
    expect(result.confidence).toBeLessThanOrEqual(1.0);
  });

  it('clamps confidence below 0.0', () => {
    const raw = '{"direction": "long", "confidence": -0.5, "reasoning": "test"}';
    const result = parseLLMResponse(raw, 0);
    expect(result.confidence).toBeGreaterThanOrEqual(0.0);
  });

  it('never throws for any string input', () => {
    const inputs = ['', '{}', 'null', '[]', '{"direction": "invalid"}', 'random text'];
    for (const input of inputs) {
      expect(() => parseLLMResponse(input, 0)).not.toThrow();
    }
  });
});
