# Tasks: Local Trading Memory AI

## Task List

- [x] 1 Scaffold module structure and types
  - [x] 1.1 Add `chromadb` to package.json dependencies and install
  - [x] 1.2 Create `src/ai/TradingMemory/types.ts` — define `MemorySignal`, `PnLResult`, `TradeRecord`, `PredictionResult`, `TradeDecision`
  - [x] 1.3 Create `src/ai/TradingMemory/index.ts` — re-export public API (`TradingMemoryService`, types)

- [x] 2 Implement core logic
  - [x] 2.1 Create `src/ai/TradingMemory/signalEmbedding.ts` — implement `signalToEmbedding()`, `buildPrompt()`, `parseLLMResponse()`
  - [x] 2.2 Create `src/ai/TradingMemory/TradeDB.ts` — SQLite wrapper using `better-sqlite3`: `insert()`, `getByIds()`, schema init
  - [x] 2.3 Create `src/ai/TradingMemory/VectorStore.ts` — ChromaDB wrapper using `chromadb` npm: `upsert()`, `query()`
  - [x] 2.4 Create `src/ai/TradingMemory/OllamaClient.ts` — Ollama REST client using `axios`: `complete()` calling `POST http://localhost:11434/api/generate`
  - [x] 2.5 Create `src/ai/TradingMemory/TradingMemoryService.ts` — orchestrator: `saveTrade()` and `predict()` wiring all components

- [x] 3 Add Express routes
  - [x] 3.1 Create `src/ai/TradingMemory/routes.ts` — Express router with `POST /api/memory/save`, `POST /api/memory/predict`, `GET /api/memory/health`
  - [x] 3.2 Mount memory router in `src/dashboard/server.ts` — register routes on the existing `DashboardServer` app

- [x] 4 Write tests
  - [x] 4.1 Unit test `signalToEmbedding` — known input → exact output vector; assert length 6 and all values in [0, 1]
  - [x] 4.2 Unit test `parseLLMResponse` — valid JSON, JSON embedded in prose, empty string, garbage input
  - [x] 4.3 Unit test `buildPrompt` — assert signal fields and trade outcomes appear in output string
  - [x] 4.4 Unit test `saveTrade` with mocked `VectorStore` and `TradeDB` — assert both stores called with correct args
  - [x] 4.5 Integration test: save 20 synthetic trades → predict → assert result shape and `winRateOfSimilar` math (SQLite `:memory:` + ChromaDB in-memory)
  - [x] 4.6 Property test (fast-check): `signalToEmbedding` always returns 6 floats in [0, 1] for any valid signal
  - [x] 4.7 Property test (fast-check): `predict` always returns valid `PredictionResult` (direction in set, confidence bounded)
  - [x] 4.8 Property test (fast-check): `parseLLMResponse` never throws for any string input
  - [x] 4.9 Edge case test: `predict` on cold start (empty ChromaDB) returns valid result without throwing
  - [x] 4.10 Edge case test: `predict` when Ollama unreachable returns `skip` default result
