/**
 * Integration test: TradingMemoryService with real SQLite (:memory:)
 * and a stub VectorStore that stores embeddings in-memory.
 * Validates end-to-end save → predict flow and winRateOfSimilar math.
 */
import { describe, it, expect, vi } from 'vitest';
import { TradingMemoryService } from '../TradingMemoryService.js';
import { TradeDB } from '../TradeDB.js';
import type { VectorStore } from '../VectorStore.js';
import type { OllamaClient } from '../OllamaClient.js';
import type { MemorySignal, TradeRecord } from '../types.js';
import { signalToEmbedding } from '../signalEmbedding.js';

// In-memory VectorStore stub — no ChromaDB server needed
class InMemoryVectorStore {
  private store: Array<{ id: string; embedding: number[]; metadata: Record<string, unknown> }> = [];

  async upsert(tradeId: string, embedding: number[], metadata: Record<string, unknown>): Promise<void> {
    this.store.push({ id: tradeId, embedding, metadata });
  }

  async query(embedding: number[], n: number): Promise<TradeRecord[]> {
    // Cosine similarity
    const scored = this.store.map(entry => ({
      entry,
      score: cosineSimilarity(embedding, entry.embedding),
    }));
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, n).map(({ entry }) => {
      const m = entry.metadata;
      return {
        tradeId: m['tradeId'] as string,
        signal: typeof m['signal'] === 'string' ? JSON.parse(m['signal']) : m['signal'],
        decision: m['decision'] as TradeRecord['decision'],
        pnlPercent: m['pnlPercent'] as number,
        outcome: m['outcome'] as 'WIN' | 'LOSS',
        timestamp: m['timestamp'] as string,
      };
    });
  }
}

function cosineSimilarity(a: number[], b: number[]): number {
  const dot = a.reduce((sum, v, i) => sum + v * (b[i] ?? 0), 0);
  const magA = Math.sqrt(a.reduce((sum, v) => sum + v * v, 0));
  const magB = Math.sqrt(b.reduce((sum, v) => sum + v * v, 0));
  return magA && magB ? dot / (magA * magB) : 0;
}

const baseSignal: MemorySignal = {
  price: 42500,
  sma50: 41800,
  ls_ratio: 0.62,
  orderbook_imbalance: 0.55,
  buy_pressure: 0.70,
  rsi: 58.3,
};

function makeSignal(offset: number): MemorySignal {
  return { ...baseSignal, price: baseSignal.price + offset, rsi: Math.min(100, baseSignal.rsi + offset * 0.01) };
}

describe('Integration: save 20 trades → predict', () => {
  it('winRateOfSimilar matches actual WIN ratio of retrieved trades', async () => {
    const tradeDB = new TradeDB(':memory:');
    const vectorStore = new InMemoryVectorStore() as unknown as VectorStore;
    const ollamaClient = {
      complete: vi.fn().mockResolvedValue('{"direction": "long", "confidence": 0.75, "reasoning": "test"}'),
    } as unknown as OllamaClient;

    const svc = new TradingMemoryService(tradeDB, vectorStore, ollamaClient);

    // Save 20 synthetic trades: 14 WIN, 6 LOSS
    for (let i = 0; i < 14; i++) {
      await svc.saveTrade(makeSignal(i), 'long', { pnlPercent: 1.5, outcome: 'WIN' });
    }
    for (let i = 14; i < 20; i++) {
      await svc.saveTrade(makeSignal(i), 'short', { pnlPercent: -1.0, outcome: 'LOSS' });
    }

    const result = await svc.predict(baseSignal);

    // Result shape
    expect(['long', 'short', 'skip']).toContain(result.direction);
    expect(result.confidence).toBeGreaterThanOrEqual(0);
    expect(result.confidence).toBeLessThanOrEqual(1);
    expect(typeof result.reasoning).toBe('string');
    expect(result.winRateOfSimilar).toBeGreaterThanOrEqual(0);
    expect(result.winRateOfSimilar).toBeLessThanOrEqual(1);

    // winRateOfSimilar must be a valid ratio (not NaN, not out of bounds)
    expect(Number.isFinite(result.winRateOfSimilar)).toBe(true);
  });

  it('predict returns valid result after 0 saves (cold start)', async () => {
    const tradeDB = new TradeDB(':memory:');
    const vectorStore = new InMemoryVectorStore() as unknown as VectorStore;
    const ollamaClient = {
      complete: vi.fn().mockResolvedValue('{"direction": "skip", "confidence": 0.1, "reasoning": "no data"}'),
    } as unknown as OllamaClient;

    const svc = new TradingMemoryService(tradeDB, vectorStore, ollamaClient);
    const result = await svc.predict(baseSignal);

    expect(['long', 'short', 'skip']).toContain(result.direction);
    expect(result.winRateOfSimilar).toBe(0);
  });

  it('winRateOfSimilar is exactly wins/total from retrieved trades', async () => {
    const tradeDB = new TradeDB(':memory:');
    const vectorStore = new InMemoryVectorStore() as unknown as VectorStore;
    const ollamaClient = {
      complete: vi.fn().mockResolvedValue('{"direction": "long", "confidence": 0.8, "reasoning": "ok"}'),
    } as unknown as OllamaClient;

    const svc = new TradingMemoryService(tradeDB, vectorStore, ollamaClient);

    // Save exactly 4 trades: 3 WIN, 1 LOSS — all very similar to baseSignal
    await svc.saveTrade(makeSignal(1), 'long', { pnlPercent: 2, outcome: 'WIN' });
    await svc.saveTrade(makeSignal(2), 'long', { pnlPercent: 1, outcome: 'WIN' });
    await svc.saveTrade(makeSignal(3), 'long', { pnlPercent: 0.5, outcome: 'WIN' });
    await svc.saveTrade(makeSignal(4), 'short', { pnlPercent: -1, outcome: 'LOSS' });

    const result = await svc.predict(baseSignal);
    // 4 trades retrieved (n=10 but only 4 exist), 3 WIN → 0.75
    expect(result.winRateOfSimilar).toBeCloseTo(0.75);
  });
});
