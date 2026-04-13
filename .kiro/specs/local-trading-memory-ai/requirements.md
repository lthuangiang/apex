# Requirements: Local Trading Memory AI

## Introduction

This document defines the functional and non-functional requirements for the local trading memory AI module. The module lives at `src/ai/TradingMemory/` and integrates with the existing TypeScript/Node.js bot. It provides persistent trade memory via ChromaDB (`chromadb` npm) + SQLite (`better-sqlite3`) and LLM-powered prediction via Ollama (llama3) called through `axios`. HTTP endpoints are exposed via the existing Express `DashboardServer`.

---

## Requirements

### Requirement 1: Trade Persistence

**User Story**: As a trading bot, I want to save every completed trade (signal + decision + outcome) so the system can learn from history.

#### Acceptance Criteria

1.1 WHEN `saveTrade(signal, decision, pnlResult)` is called THEN the trade record SHALL be inserted into SQLite with all fields: signal values, decision, pnlPercent, outcome, timestamp, and a generated tradeId.

1.2 WHEN `saveTrade` is called THEN the signal SHALL be embedded as a 6-element float vector and upserted into ChromaDB with the tradeId as the document ID and full trade metadata attached.

1.3 WHEN `saveTrade` is called multiple times THEN each call SHALL return a distinct tradeId (using `crypto.randomUUID()`).

1.4 WHEN `saveTrade` is called with `decision` not in `['long', 'short', 'skip']` THEN the service SHALL throw an `Error` with a descriptive message.

1.5 WHEN `saveTrade` is called with `pnlResult.outcome` not in `['WIN', 'LOSS']` THEN the service SHALL throw an `Error` with a descriptive message.

---

### Requirement 2: Signal Embedding

**User Story**: As the memory service, I need to convert a signal object into a numeric vector so ChromaDB can perform similarity search.

#### Acceptance Criteria

2.1 WHEN `signalToEmbedding(signal)` is called with a valid `MemorySignal` THEN it SHALL return a `number[]` of exactly length 6.

2.2 WHEN `signalToEmbedding` is called THEN every element of the returned array SHALL be in the range [0.0, 1.0] (min-max normalized).

2.3 WHEN `signalToEmbedding` is called twice with the same signal THEN it SHALL return the identical array both times (deterministic).

2.4 WHEN `signalToEmbedding` is called THEN the field order SHALL be fixed: `[priceNorm, sma50Norm, ls_ratio, orderbook_imbalance, buy_pressure, rsiNorm]`.

---

### Requirement 3: Prediction

**User Story**: As a trading bot, I want to get a `long`/`short`/`skip` decision for a new signal based on similar historical trades, so I can make informed entries.

#### Acceptance Criteria

3.1 WHEN `predict(signal)` is called THEN the service SHALL query ChromaDB for the 10 most similar past trades by cosine similarity.

3.2 WHEN `predict` is called THEN the retrieved similar trades SHALL be formatted into an LLM prompt that includes: current signal values, each similar trade's signal, decision, pnlPercent, and outcome.

3.3 WHEN `predict` is called THEN the LLM prompt SHALL instruct the model to return a JSON object with keys: `direction`, `confidence`, `reasoning`.

3.4 WHEN `predict` returns a result THEN `direction` SHALL be one of `'long'`, `'short'`, or `'skip'` (universally, for any valid input).

3.5 WHEN `predict` returns a result THEN `confidence` SHALL be a float in [0.0, 1.0] (universally, for any valid input).

3.6 WHEN `predict` returns a result THEN `winRateOfSimilar` SHALL equal `wins / total` computed from the retrieved trades (not from the LLM output).

3.7 WHEN `predict` returns a result THEN `winRateOfSimilar` SHALL be in [0.0, 1.0] (universally).

3.8 WHEN `predict` is called and no trades exist in memory (cold start) THEN it SHALL still return a valid `PredictionResult` without throwing.

3.9 WHEN `predict` is called and the Ollama service is unreachable THEN it SHALL return `{ direction: 'skip', confidence: 0, reasoning: 'llm_unavailable', winRateOfSimilar: <computed> }` without throwing.

3.10 WHEN `predict` is called and the LLM returns malformed or non-JSON output THEN it SHALL return `{ direction: 'skip', confidence: 0, reasoning: 'parse_error', winRateOfSimilar: <computed> }` without throwing.

---

### Requirement 4: LLM Response Parsing

**User Story**: As the memory service, I need to reliably extract structured data from the LLM's free-text response.

#### Acceptance Criteria

4.1 WHEN `parseLLMResponse(raw, winRate)` is called with a string containing valid JSON THEN it SHALL return a `PredictionResult` with all fields populated.

4.2 WHEN `parseLLMResponse` is called with JSON embedded in surrounding prose THEN it SHALL extract the first JSON object found and parse it successfully.

4.3 WHEN `parseLLMResponse` is called with any input (including empty string, garbage, or partial JSON) THEN it SHALL never throw — it SHALL always return a `PredictionResult`.

4.4 WHEN `parseLLMResponse` returns a result with `confidence` outside [0.0, 1.0] from the LLM THEN it SHALL clamp the value to the valid range.

---

### Requirement 5: Express HTTP Interface

**User Story**: As the trading bot or dashboard, I want to call saveTrade and predict over HTTP so the memory service is accessible without direct TypeScript imports.

#### Acceptance Criteria

5.1 WHEN `POST /api/memory/save` is called with a valid request body THEN it SHALL return HTTP 200 with `{ tradeId: "<uuid>", status: "saved" }`.

5.2 WHEN `POST /api/memory/predict` is called with a valid request body THEN it SHALL return HTTP 200 with a JSON body containing `direction`, `confidence`, `reasoning`, and `winRateOfSimilar`.

5.3 WHEN `GET /api/memory/health` is called THEN it SHALL return HTTP 200 with `{ status: "ok" }`.

5.4 WHEN any endpoint receives a request with missing or invalid fields THEN it SHALL return HTTP 400 with a descriptive error message.

5.5 WHEN the memory routes are registered THEN they SHALL be protected by the existing `DashboardServer` authentication middleware.

---

### Requirement 6: Code Structure

**User Story**: As a developer, I want the memory module to follow the existing TypeScript project conventions so it integrates cleanly with the codebase.

#### Acceptance Criteria

6.1 All source files SHALL live under `src/ai/TradingMemory/` with TypeScript (`.ts`) extensions.

6.2 The module SHALL export a `TradingMemoryService` class with `saveTrade()` and `predict()` as its public interface.

6.3 The module SHALL be split into focused files: `types.ts`, `signalEmbedding.ts`, `TradeDB.ts`, `VectorStore.ts`, `OllamaClient.ts`, `TradingMemoryService.ts`, `routes.ts`, and `index.ts`.

6.4 All modules SHALL be importable independently for unit testing without starting the Express server or connecting to external services.

6.5 The `chromadb` npm package SHALL be the only new dependency added to `package.json`.
