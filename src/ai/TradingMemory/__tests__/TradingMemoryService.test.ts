import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TradingMemoryService } from '../TradingMemoryService.js';
import type { TradeDB } from '../TradeDB.js';
import type { VectorStore } from '../VectorStore.js';
import type { OllamaClient } from '../OllamaClient.js';
import type { MemorySignal, TradeRecord } from '../types.js';

const baseSignal: MemorySignal = {
  price: 42500,
  sma50: 41800,
  ls_ratio: 0.62,
  orderbook_imbalance: 0.55,
  buy_pressure: 0.70,
  rsi: 58.3,
};

function makeMocks() {
  const tradeDB = {
    insert: vi.fn().mockReturnValue('mock-id'),
    getByIds: vi.fn().mockReturnValue([]),
  } as unknown as TradeDB;

  const vectorStore = {
    upsert: vi.fn().mockResolvedValue(undefined),
    query: vi.fn().mockResolvedValue([]),
  } as unknown as VectorStore;

  const ollamaClient = {
    complete: vi.fn().mockResolvedValue('{"direction": "long", "confidence": 0.8, "reasoning": "test"}'),
  } as unknown as OllamaClient;

  return { tradeDB, vectorStore, ollamaClient };
}

describe('TradingMemoryService.saveTrade', () => {
  it('calls tradeDB.insert and vectorStore.upsert', async () => {
    const { tradeDB, vectorStore, ollamaClient } = makeMocks();
    const svc = new TradingMemoryService(tradeDB, vectorStore, ollamaClient);

    const id = await svc.saveTrade(baseSignal, 'long', { pnlPercent: 2.1, outcome: 'WIN' });

    expect(tradeDB.insert).toHaveBeenCalledOnce();
    expect(vectorStore.upsert).toHaveBeenCalledOnce();
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
  });

  it('returns unique IDs on multiple calls', async () => {
    const { tradeDB, vectorStore, ollamaClient } = makeMocks();
    const svc = new TradingMemoryService(tradeDB, vectorStore, ollamaClient);

    const id1 = await svc.saveTrade(baseSignal, 'long', { pnlPercent: 1, outcome: 'WIN' });
    const id2 = await svc.saveTrade(baseSignal, 'short', { pnlPercent: -1, outcome: 'LOSS' });
    expect(id1).not.toBe(id2);
  });

  it('throws on invalid decision', async () => {
    const { tradeDB, vectorStore, ollamaClient } = makeMocks();
    const svc = new TradingMemoryService(tradeDB, vectorStore, ollamaClient);
    // @ts-expect-error intentional invalid value
    await expect(svc.saveTrade(baseSignal, 'invalid', { pnlPercent: 1, outcome: 'WIN' })).rejects.toThrow();
  });

  it('throws on invalid outcome', async () => {
    const { tradeDB, vectorStore, ollamaClient } = makeMocks();
    const svc = new TradingMemoryService(tradeDB, vectorStore, ollamaClient);
    // @ts-expect-error intentional invalid value
    await expect(svc.saveTrade(baseSignal, 'long', { pnlPercent: 1, outcome: 'DRAW' })).rejects.toThrow();
  });
});

describe('TradingMemoryService.predict', () => {
  it('returns valid PredictionResult', async () => {
    const { tradeDB, vectorStore, ollamaClient } = makeMocks();
    const svc = new TradingMemoryService(tradeDB, vectorStore, ollamaClient);

    const result = await svc.predict(baseSignal);
    expect(['long', 'short', 'skip']).toContain(result.direction);
    expect(result.confidence).toBeGreaterThanOrEqual(0);
    expect(result.confidence).toBeLessThanOrEqual(1);
    expect(typeof result.reasoning).toBe('string');
    expect(result.winRateOfSimilar).toBeGreaterThanOrEqual(0);
    expect(result.winRateOfSimilar).toBeLessThanOrEqual(1);
  });

  it('computes winRateOfSimilar from retrieved trades', async () => {
    const { tradeDB, vectorStore, ollamaClient } = makeMocks();
    const trades: TradeRecord[] = [
      { tradeId: '1', signal: baseSignal, decision: 'long', pnlPercent: 2, outcome: 'WIN', timestamp: '' },
      { tradeId: '2', signal: baseSignal, decision: 'long', pnlPercent: 1, outcome: 'WIN', timestamp: '' },
      { tradeId: '3', signal: baseSignal, decision: 'short', pnlPercent: -1, outcome: 'LOSS', timestamp: '' },
      { tradeId: '4', signal: baseSignal, decision: 'long', pnlPercent: 0.5, outcome: 'WIN', timestamp: '' },
    ];
    (vectorStore.query as ReturnType<typeof vi.fn>).mockResolvedValue(trades);

    const svc = new TradingMemoryService(tradeDB, vectorStore, ollamaClient);
    const result = await svc.predict(baseSignal);
    expect(result.winRateOfSimilar).toBeCloseTo(3 / 4);
  });

  it('returns skip when Ollama is unreachable', async () => {
    const { tradeDB, vectorStore, ollamaClient } = makeMocks();
    (ollamaClient.complete as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('ECONNREFUSED'));

    const svc = new TradingMemoryService(tradeDB, vectorStore, ollamaClient);
    const result = await svc.predict(baseSignal);
    expect(result.direction).toBe('skip');
    expect(result.reasoning).toBe('llm_unavailable');
  });

  it('returns valid result on cold start (empty vector store)', async () => {
    const { tradeDB, vectorStore, ollamaClient } = makeMocks();
    (vectorStore.query as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    const svc = new TradingMemoryService(tradeDB, vectorStore, ollamaClient);
    const result = await svc.predict(baseSignal);
    expect(['long', 'short', 'skip']).toContain(result.direction);
    expect(result.winRateOfSimilar).toBe(0);
  });
});
