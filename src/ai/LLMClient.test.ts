// Feature: ai-alpha-execution-engine, Property 2: LLM prompt always contains all market data fields
// Feature: ai-alpha-execution-engine, Property 3: LLM confidence is always clamped to [0, 1]
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fc from 'fast-check';
import axios from 'axios';

vi.mock('axios');
const mockedAxios = axios as unknown as {
  post: ReturnType<typeof vi.fn>;
};

import { LLMClient, type MarketContext } from './LLMClient.js';

describe('LLMClient', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // **Validates: Requirements 2.1**
  // Property 2: LLM prompt always contains all market data fields
  it('P2: prompt always contains all market data fields for any valid MarketContext', () => {
    fc.assert(
      fc.property(
        fc.record({
          sma50: fc.float({ noNaN: true }),
          currentPrice: fc.float({ noNaN: true }),
          lsRatio: fc.float({ noNaN: true }),
          imbalance: fc.float({ noNaN: true }),
          tradePressure: fc.float({ noNaN: true }),
          fearGreedIndex: fc.option(fc.float({ noNaN: true })),
          fearGreedLabel: fc.option(fc.string()),
          sectorIndex: fc.option(fc.float({ noNaN: true })),
        }),
        (ctx) => {
          // fc.option returns null when not present
          const marketCtx: MarketContext = {
            ...ctx,
            fearGreedIndex: ctx.fearGreedIndex ?? null,
            fearGreedLabel: ctx.fearGreedLabel ?? null,
            sectorIndex: ctx.sectorIndex ?? null,
          };

          const client = new LLMClient('openai', 'test-key');
          const prompt = client.buildPrompt(marketCtx);

          expect(prompt).toContain(String(marketCtx.sma50));
          expect(prompt).toContain(String(marketCtx.currentPrice));
          expect(prompt).toContain(String(marketCtx.lsRatio));
          expect(prompt).toContain(String(marketCtx.imbalance));
          expect(prompt).toContain(String(marketCtx.tradePressure));
        }
      ),
      { numRuns: 100 }
    );
  });

  it('prompt contains SoSoValue unavailable text when any SoSoValue field is null', () => {
    const client = new LLMClient('openai', 'test-key');
    const ctx: MarketContext = {
      sma50: 50000,
      currentPrice: 51000,
      lsRatio: 1.2,
      imbalance: 0.05,
      tradePressure: 0.6,
      fearGreedIndex: null,
      fearGreedLabel: null,
      sectorIndex: null,
    };
    const prompt = client.buildPrompt(ctx);
    expect(prompt).toContain('- SoSoValue data: unavailable');
    expect(prompt).not.toContain('Fear/Greed');
    expect(prompt).not.toContain('Sector Index');
  });

  it('prompt contains SoSoValue data when all fields are present', () => {
    const client = new LLMClient('openai', 'test-key');
    const ctx: MarketContext = {
      sma50: 50000,
      currentPrice: 51000,
      lsRatio: 1.2,
      imbalance: 0.05,
      tradePressure: 0.6,
      fearGreedIndex: 72,
      fearGreedLabel: 'Greed',
      sectorIndex: 105,
    };
    const prompt = client.buildPrompt(ctx);
    expect(prompt).toContain('72');
    expect(prompt).toContain('Greed');
    expect(prompt).toContain('105');
    expect(prompt).not.toContain('unavailable');
  });

  // **Validates: Requirements 2.3**
  // Property 3: LLM confidence is always clamped to [0, 1]
  it('P3: confidence is always clamped to [0, 1] for any raw LLM confidence value', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.float({ min: -10, max: 10, noNaN: true }),
        async (rawConfidence) => {
          const llmResponse = JSON.stringify({
            direction: 'long',
            confidence: rawConfidence,
            reasoning: 'test reasoning',
          });

          mockedAxios.post = vi.fn().mockResolvedValue({
            data: {
              choices: [{ message: { content: llmResponse } }],
            },
          });

          const client = new LLMClient('openai', 'test-key');
          const ctx: MarketContext = {
            sma50: 50000,
            currentPrice: 51000,
            lsRatio: 1.2,
            imbalance: 0.05,
            tradePressure: 0.6,
            fearGreedIndex: null,
            fearGreedLabel: null,
            sectorIndex: null,
          };

          const result = await client.call(ctx);

          expect(result).not.toBeNull();
          expect(result!.confidence).toBeGreaterThanOrEqual(0);
          expect(result!.confidence).toBeLessThanOrEqual(1);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('returns null on network error', async () => {
    mockedAxios.post = vi.fn().mockRejectedValue(new Error('Network Error'));
    const client = new LLMClient('openai', 'test-key');
    const ctx: MarketContext = {
      sma50: 50000,
      currentPrice: 51000,
      lsRatio: 1.2,
      imbalance: 0.05,
      tradePressure: 0.6,
      fearGreedIndex: null,
      fearGreedLabel: null,
      sectorIndex: null,
    };
    const result = await client.call(ctx);
    expect(result).toBeNull();
  });

  it('returns null on JSON parse failure', async () => {
    mockedAxios.post = vi.fn().mockResolvedValue({
      data: { choices: [{ message: { content: 'not valid json {{' } }] },
    });
    const client = new LLMClient('openai', 'test-key');
    const ctx: MarketContext = {
      sma50: 50000,
      currentPrice: 51000,
      lsRatio: 1.2,
      imbalance: 0.05,
      tradePressure: 0.6,
      fearGreedIndex: null,
      fearGreedLabel: null,
      sectorIndex: null,
    };
    const result = await client.call(ctx);
    expect(result).toBeNull();
  });

  it('uses anthropic endpoint and extracts content[0].text', async () => {
    const llmResponse = JSON.stringify({
      direction: 'short',
      confidence: 0.8,
      reasoning: 'bearish signal',
    });

    mockedAxios.post = vi.fn().mockResolvedValue({
      data: { content: [{ text: llmResponse }] },
    });

    const client = new LLMClient('anthropic', 'test-key');
    const ctx: MarketContext = {
      sma50: 50000,
      currentPrice: 49000,
      lsRatio: 0.8,
      imbalance: -0.1,
      tradePressure: 0.4,
      fearGreedIndex: null,
      fearGreedLabel: null,
      sectorIndex: null,
    };

    const result = await client.call(ctx);
    expect(result).not.toBeNull();
    expect(result!.direction).toBe('short');
    expect(result!.confidence).toBe(0.8);

    expect(mockedAxios.post).toHaveBeenCalledWith(
      'https://api.anthropic.com/v1/messages',
      expect.any(Object),
      expect.objectContaining({
        headers: expect.objectContaining({ 'anthropic-version': '2023-06-01' }),
      })
    );
  });
});
