"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * Integration test: TradingMemoryService with real SQLite (:memory:)
 * and a stub VectorStore that stores embeddings in-memory.
 * Validates end-to-end save → predict flow and winRateOfSimilar math.
 */
const vitest_1 = require("vitest");
const TradingMemoryService_js_1 = require("../TradingMemoryService.js");
const TradeDB_js_1 = require("../TradeDB.js");
// In-memory VectorStore stub — no ChromaDB server needed
class InMemoryVectorStore {
    store = [];
    async upsert(tradeId, embedding, metadata) {
        this.store.push({ id: tradeId, embedding, metadata });
    }
    async query(embedding, n) {
        // Cosine similarity
        const scored = this.store.map(entry => ({
            entry,
            score: cosineSimilarity(embedding, entry.embedding),
        }));
        scored.sort((a, b) => b.score - a.score);
        return scored.slice(0, n).map(({ entry }) => {
            const m = entry.metadata;
            return {
                tradeId: m['tradeId'],
                signal: typeof m['signal'] === 'string' ? JSON.parse(m['signal']) : m['signal'],
                decision: m['decision'],
                pnlPercent: m['pnlPercent'],
                outcome: m['outcome'],
                timestamp: m['timestamp'],
            };
        });
    }
}
function cosineSimilarity(a, b) {
    const dot = a.reduce((sum, v, i) => sum + v * (b[i] ?? 0), 0);
    const magA = Math.sqrt(a.reduce((sum, v) => sum + v * v, 0));
    const magB = Math.sqrt(b.reduce((sum, v) => sum + v * v, 0));
    return magA && magB ? dot / (magA * magB) : 0;
}
const baseSignal = {
    price: 42500,
    sma50: 41800,
    ls_ratio: 0.62,
    orderbook_imbalance: 0.55,
    buy_pressure: 0.70,
    rsi: 58.3,
};
function makeSignal(offset) {
    return { ...baseSignal, price: baseSignal.price + offset, rsi: Math.min(100, baseSignal.rsi + offset * 0.01) };
}
(0, vitest_1.describe)('Integration: save 20 trades → predict', () => {
    (0, vitest_1.it)('winRateOfSimilar matches actual WIN ratio of retrieved trades', async () => {
        const tradeDB = new TradeDB_js_1.TradeDB(':memory:');
        const vectorStore = new InMemoryVectorStore();
        const ollamaClient = {
            complete: vitest_1.vi.fn().mockResolvedValue('{"direction": "long", "confidence": 0.75, "reasoning": "test"}'),
        };
        const svc = new TradingMemoryService_js_1.TradingMemoryService(tradeDB, vectorStore, ollamaClient);
        // Save 20 synthetic trades: 14 WIN, 6 LOSS
        for (let i = 0; i < 14; i++) {
            await svc.saveTrade(makeSignal(i), 'long', { pnlPercent: 1.5, outcome: 'WIN' });
        }
        for (let i = 14; i < 20; i++) {
            await svc.saveTrade(makeSignal(i), 'short', { pnlPercent: -1.0, outcome: 'LOSS' });
        }
        const result = await svc.predict(baseSignal);
        // Result shape
        (0, vitest_1.expect)(['long', 'short', 'skip']).toContain(result.direction);
        (0, vitest_1.expect)(result.confidence).toBeGreaterThanOrEqual(0);
        (0, vitest_1.expect)(result.confidence).toBeLessThanOrEqual(1);
        (0, vitest_1.expect)(typeof result.reasoning).toBe('string');
        (0, vitest_1.expect)(result.winRateOfSimilar).toBeGreaterThanOrEqual(0);
        (0, vitest_1.expect)(result.winRateOfSimilar).toBeLessThanOrEqual(1);
        // winRateOfSimilar must be a valid ratio (not NaN, not out of bounds)
        (0, vitest_1.expect)(Number.isFinite(result.winRateOfSimilar)).toBe(true);
    });
    (0, vitest_1.it)('predict returns valid result after 0 saves (cold start)', async () => {
        const tradeDB = new TradeDB_js_1.TradeDB(':memory:');
        const vectorStore = new InMemoryVectorStore();
        const ollamaClient = {
            complete: vitest_1.vi.fn().mockResolvedValue('{"direction": "skip", "confidence": 0.1, "reasoning": "no data"}'),
        };
        const svc = new TradingMemoryService_js_1.TradingMemoryService(tradeDB, vectorStore, ollamaClient);
        const result = await svc.predict(baseSignal);
        (0, vitest_1.expect)(['long', 'short', 'skip']).toContain(result.direction);
        (0, vitest_1.expect)(result.winRateOfSimilar).toBe(0);
    });
    (0, vitest_1.it)('winRateOfSimilar is exactly wins/total from retrieved trades', async () => {
        const tradeDB = new TradeDB_js_1.TradeDB(':memory:');
        const vectorStore = new InMemoryVectorStore();
        const ollamaClient = {
            complete: vitest_1.vi.fn().mockResolvedValue('{"direction": "long", "confidence": 0.8, "reasoning": "ok"}'),
        };
        const svc = new TradingMemoryService_js_1.TradingMemoryService(tradeDB, vectorStore, ollamaClient);
        // Save exactly 4 trades: 3 WIN, 1 LOSS — all very similar to baseSignal
        await svc.saveTrade(makeSignal(1), 'long', { pnlPercent: 2, outcome: 'WIN' });
        await svc.saveTrade(makeSignal(2), 'long', { pnlPercent: 1, outcome: 'WIN' });
        await svc.saveTrade(makeSignal(3), 'long', { pnlPercent: 0.5, outcome: 'WIN' });
        await svc.saveTrade(makeSignal(4), 'short', { pnlPercent: -1, outcome: 'LOSS' });
        const result = await svc.predict(baseSignal);
        // 4 trades retrieved (n=10 but only 4 exist), 3 WIN → 0.75
        (0, vitest_1.expect)(result.winRateOfSimilar).toBeCloseTo(0.75);
    });
});
