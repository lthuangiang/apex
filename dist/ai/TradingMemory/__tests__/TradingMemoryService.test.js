"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const TradingMemoryService_js_1 = require("../TradingMemoryService.js");
const baseSignal = {
    price: 42500,
    sma50: 41800,
    ls_ratio: 0.62,
    orderbook_imbalance: 0.55,
    buy_pressure: 0.70,
    rsi: 58.3,
};
function makeMocks() {
    const tradeDB = {
        insert: vitest_1.vi.fn().mockReturnValue('mock-id'),
        getByIds: vitest_1.vi.fn().mockReturnValue([]),
    };
    const vectorStore = {
        upsert: vitest_1.vi.fn().mockResolvedValue(undefined),
        query: vitest_1.vi.fn().mockResolvedValue([]),
    };
    const ollamaClient = {
        complete: vitest_1.vi.fn().mockResolvedValue('{"direction": "long", "confidence": 0.8, "reasoning": "test"}'),
    };
    return { tradeDB, vectorStore, ollamaClient };
}
(0, vitest_1.describe)('TradingMemoryService.saveTrade', () => {
    (0, vitest_1.it)('calls tradeDB.insert and vectorStore.upsert', async () => {
        const { tradeDB, vectorStore, ollamaClient } = makeMocks();
        const svc = new TradingMemoryService_js_1.TradingMemoryService(tradeDB, vectorStore, ollamaClient);
        const id = await svc.saveTrade(baseSignal, 'long', { pnlPercent: 2.1, outcome: 'WIN' });
        (0, vitest_1.expect)(tradeDB.insert).toHaveBeenCalledOnce();
        (0, vitest_1.expect)(vectorStore.upsert).toHaveBeenCalledOnce();
        (0, vitest_1.expect)(typeof id).toBe('string');
        (0, vitest_1.expect)(id.length).toBeGreaterThan(0);
    });
    (0, vitest_1.it)('returns unique IDs on multiple calls', async () => {
        const { tradeDB, vectorStore, ollamaClient } = makeMocks();
        const svc = new TradingMemoryService_js_1.TradingMemoryService(tradeDB, vectorStore, ollamaClient);
        const id1 = await svc.saveTrade(baseSignal, 'long', { pnlPercent: 1, outcome: 'WIN' });
        const id2 = await svc.saveTrade(baseSignal, 'short', { pnlPercent: -1, outcome: 'LOSS' });
        (0, vitest_1.expect)(id1).not.toBe(id2);
    });
    (0, vitest_1.it)('throws on invalid decision', async () => {
        const { tradeDB, vectorStore, ollamaClient } = makeMocks();
        const svc = new TradingMemoryService_js_1.TradingMemoryService(tradeDB, vectorStore, ollamaClient);
        // @ts-expect-error intentional invalid value
        await (0, vitest_1.expect)(svc.saveTrade(baseSignal, 'invalid', { pnlPercent: 1, outcome: 'WIN' })).rejects.toThrow();
    });
    (0, vitest_1.it)('throws on invalid outcome', async () => {
        const { tradeDB, vectorStore, ollamaClient } = makeMocks();
        const svc = new TradingMemoryService_js_1.TradingMemoryService(tradeDB, vectorStore, ollamaClient);
        // @ts-expect-error intentional invalid value
        await (0, vitest_1.expect)(svc.saveTrade(baseSignal, 'long', { pnlPercent: 1, outcome: 'DRAW' })).rejects.toThrow();
    });
});
(0, vitest_1.describe)('TradingMemoryService.predict', () => {
    (0, vitest_1.it)('returns valid PredictionResult', async () => {
        const { tradeDB, vectorStore, ollamaClient } = makeMocks();
        const svc = new TradingMemoryService_js_1.TradingMemoryService(tradeDB, vectorStore, ollamaClient);
        const result = await svc.predict(baseSignal);
        (0, vitest_1.expect)(['long', 'short', 'skip']).toContain(result.direction);
        (0, vitest_1.expect)(result.confidence).toBeGreaterThanOrEqual(0);
        (0, vitest_1.expect)(result.confidence).toBeLessThanOrEqual(1);
        (0, vitest_1.expect)(typeof result.reasoning).toBe('string');
        (0, vitest_1.expect)(result.winRateOfSimilar).toBeGreaterThanOrEqual(0);
        (0, vitest_1.expect)(result.winRateOfSimilar).toBeLessThanOrEqual(1);
    });
    (0, vitest_1.it)('computes winRateOfSimilar from retrieved trades', async () => {
        const { tradeDB, vectorStore, ollamaClient } = makeMocks();
        const trades = [
            { tradeId: '1', signal: baseSignal, decision: 'long', pnlPercent: 2, outcome: 'WIN', timestamp: '' },
            { tradeId: '2', signal: baseSignal, decision: 'long', pnlPercent: 1, outcome: 'WIN', timestamp: '' },
            { tradeId: '3', signal: baseSignal, decision: 'short', pnlPercent: -1, outcome: 'LOSS', timestamp: '' },
            { tradeId: '4', signal: baseSignal, decision: 'long', pnlPercent: 0.5, outcome: 'WIN', timestamp: '' },
        ];
        vectorStore.query.mockResolvedValue(trades);
        const svc = new TradingMemoryService_js_1.TradingMemoryService(tradeDB, vectorStore, ollamaClient);
        const result = await svc.predict(baseSignal);
        (0, vitest_1.expect)(result.winRateOfSimilar).toBeCloseTo(3 / 4);
    });
    (0, vitest_1.it)('returns skip when Ollama is unreachable', async () => {
        const { tradeDB, vectorStore, ollamaClient } = makeMocks();
        ollamaClient.complete.mockRejectedValue(new Error('ECONNREFUSED'));
        const svc = new TradingMemoryService_js_1.TradingMemoryService(tradeDB, vectorStore, ollamaClient);
        const result = await svc.predict(baseSignal);
        (0, vitest_1.expect)(result.direction).toBe('skip');
        (0, vitest_1.expect)(result.reasoning).toBe('llm_unavailable');
    });
    (0, vitest_1.it)('returns valid result on cold start (empty vector store)', async () => {
        const { tradeDB, vectorStore, ollamaClient } = makeMocks();
        vectorStore.query.mockResolvedValue([]);
        const svc = new TradingMemoryService_js_1.TradingMemoryService(tradeDB, vectorStore, ollamaClient);
        const result = await svc.predict(baseSignal);
        (0, vitest_1.expect)(['long', 'short', 'skip']).toContain(result.direction);
        (0, vitest_1.expect)(result.winRateOfSimilar).toBe(0);
    });
});
