"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TradingMemoryService = void 0;
const signalEmbedding_js_1 = require("./signalEmbedding.js");
const TradeDB_js_1 = require("./TradeDB.js");
const VectorStore_js_1 = require("./VectorStore.js");
const OllamaClient_js_1 = require("./OllamaClient.js");
class TradingMemoryService {
    tradeDB;
    vectorStore;
    ollamaClient;
    constructor(tradeDB, vectorStore, ollamaClient) {
        this.tradeDB = tradeDB ?? new TradeDB_js_1.TradeDB();
        this.vectorStore = vectorStore ?? new VectorStore_js_1.VectorStore();
        this.ollamaClient = ollamaClient ?? new OllamaClient_js_1.OllamaClient();
    }
    async saveTrade(signal, decision, pnlResult) {
        if (!['long', 'short', 'skip'].includes(decision)) {
            throw new Error(`Invalid decision: ${decision}. Must be 'long', 'short', or 'skip'.`);
        }
        if (!['WIN', 'LOSS'].includes(pnlResult.outcome)) {
            throw new Error(`Invalid outcome: ${pnlResult.outcome}. Must be 'WIN' or 'LOSS'.`);
        }
        const tradeId = crypto.randomUUID();
        const timestamp = new Date().toISOString();
        const record = {
            tradeId,
            signal,
            decision,
            pnlPercent: pnlResult.pnlPercent,
            outcome: pnlResult.outcome,
            timestamp,
        };
        // Persist to SQLite (sync)
        this.tradeDB.insert(record);
        // Persist to ChromaDB (async) — fire and await
        const embedding = (0, signalEmbedding_js_1.signalToEmbedding)(signal);
        await this.vectorStore.upsert(tradeId, embedding, {
            tradeId,
            signal: JSON.stringify(signal),
            decision,
            pnlPercent: pnlResult.pnlPercent,
            outcome: pnlResult.outcome,
            timestamp,
        });
        return tradeId;
    }
    async predict(signal) {
        const embedding = (0, signalEmbedding_js_1.signalToEmbedding)(signal);
        // Retrieve 10 most similar past trades
        let similarTrades = [];
        try {
            similarTrades = await this.vectorStore.query(embedding, 10);
        }
        catch (err) {
            console.error('[TradingMemoryService] VectorStore query failed:', err);
        }
        // Compute win rate from retrieved trades
        const wins = similarTrades.filter(t => t.outcome === 'WIN').length;
        const winRateOfSimilar = similarTrades.length > 0 ? wins / similarTrades.length : 0;
        // Build prompt and call LLM
        const prompt = (0, signalEmbedding_js_1.buildPrompt)(signal, similarTrades);
        let rawResponse = '';
        try {
            rawResponse = await this.ollamaClient.complete(prompt);
        }
        catch (err) {
            console.error('[TradingMemoryService] Ollama unreachable:', err);
            return { direction: 'skip', confidence: 0, reasoning: 'llm_unavailable', winRateOfSimilar };
        }
        return (0, signalEmbedding_js_1.parseLLMResponse)(rawResponse, winRateOfSimilar);
    }
}
exports.TradingMemoryService = TradingMemoryService;
