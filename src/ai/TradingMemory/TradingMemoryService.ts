import type { MemorySignal, PnLResult, PredictionResult, TradeDecision, TradeRecord } from './types.js';
import { signalToEmbedding, buildPrompt, parseLLMResponse } from './signalEmbedding.js';
import { TradeDB } from './TradeDB.js';
import { VectorStore } from './VectorStore.js';
import { OllamaClient } from './OllamaClient.js';

export class TradingMemoryService {
  private tradeDB: TradeDB;
  private vectorStore: VectorStore;
  private ollamaClient: OllamaClient;

  constructor(
    tradeDB?: TradeDB,
    vectorStore?: VectorStore,
    ollamaClient?: OllamaClient,
  ) {
    this.tradeDB = tradeDB ?? new TradeDB();
    this.vectorStore = vectorStore ?? new VectorStore();
    this.ollamaClient = ollamaClient ?? new OllamaClient();
  }

  async saveTrade(
    signal: MemorySignal,
    decision: TradeDecision,
    pnlResult: PnLResult,
  ): Promise<string> {
    if (!['long', 'short', 'skip'].includes(decision)) {
      throw new Error(`Invalid decision: ${decision}. Must be 'long', 'short', or 'skip'.`);
    }
    if (!['WIN', 'LOSS'].includes(pnlResult.outcome)) {
      throw new Error(`Invalid outcome: ${pnlResult.outcome}. Must be 'WIN' or 'LOSS'.`);
    }

    const tradeId = crypto.randomUUID();
    const timestamp = new Date().toISOString();

    const record: TradeRecord = {
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
    const embedding = signalToEmbedding(signal);
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

  async predict(signal: MemorySignal): Promise<PredictionResult> {
    const embedding = signalToEmbedding(signal);

    // Retrieve 10 most similar past trades
    let similarTrades: TradeRecord[] = [];
    try {
      similarTrades = await this.vectorStore.query(embedding, 10);
    } catch (err) {
      console.error('[TradingMemoryService] VectorStore query failed:', err);
    }

    // Compute win rate from retrieved trades
    const wins = similarTrades.filter(t => t.outcome === 'WIN').length;
    const winRateOfSimilar = similarTrades.length > 0 ? wins / similarTrades.length : 0;

    // Build prompt and call LLM
    const prompt = buildPrompt(signal, similarTrades);
    let rawResponse = '';
    try {
      rawResponse = await this.ollamaClient.complete(prompt);
    } catch (err) {
      console.error('[TradingMemoryService] Ollama unreachable:', err);
      return { direction: 'skip', confidence: 0, reasoning: 'llm_unavailable', winRateOfSimilar };
    }

    return parseLLMResponse(rawResponse, winRateOfSimilar);
  }
}
