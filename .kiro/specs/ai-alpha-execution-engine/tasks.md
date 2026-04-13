# Implementation Plan: AI Alpha Execution Engine

## Overview

Incrementally replace the rule-based `SignalEngine` with an AI-powered decision layer. New modules (`SoSoValueClient`, `LLMClient`, `AISignalEngine`, `TradeLogger`, `DashboardServer`, `sharedState`) slot in via the existing `Signal` interface. The `Watcher` state machine and `Executor` core logic are preserved; changes are additive.

## Tasks

- [x] 1. Extend Signal interface with reasoning and fallback fields
  - In `src/modules/SignalEngine.ts`, append `reasoning: string` and `fallback: boolean` to the `Signal` interface
  - Set default values (`reasoning: ''`, `fallback: false`) in the existing `SignalEngine.getSignal()` error-return object and the main return statement so all existing consumers continue to compile
  - _Requirements: 3.3_

- [x] 2. Create SoSoValueClient
  - Create `src/ai/SoSoValueClient.ts`
  - Implement `SoSoValueData` interface: `{ sectorIndex: number; fearGreedIndex: number; fearGreedLabel: string }`
  - Implement `SoSoValueClient.fetch()` using `axios` with a 5-second timeout; return `null` on any error
  - Read optional `SOSOVALUE_API_KEY` from env and attach as `Authorization: Bearer` header when present
  - _Requirements: 1.1, 1.2, 1.3, 1.4_

  - [x] 2.1 Write property test for SoSoValueClient response completeness
    - **Property 1: SoSoValue response always yields a complete structured object**
    - **Validates: Requirements 1.2**
    - Use `fc.record({ sectorIndex: fc.float(), fearGreedIndex: fc.float(), fearGreedLabel: fc.string() })` as generator
    - Mock axios to return the generated payload; assert all three fields are present with correct types

- [x] 3. Create LLMClient
  - Create `src/ai/LLMClient.ts`
  - Implement `MarketContext` and `LLMDecision` interfaces per design
  - Implement `buildPrompt(ctx: MarketContext): string` as a pure function using the template from the design; replace SoSoValue lines with `"- SoSoValue data: unavailable"` when fields are null
  - Implement `call(ctx: MarketContext): Promise<LLMDecision | null>` using `axios` with a 15-second timeout; support `openai` and `anthropic` providers via constructor arg; clamp `confidence` to `[0, 1]`; return `null` on timeout, network error, or JSON parse failure
  - _Requirements: 2.1, 2.3, 2.4, 2.5, 2.6_

  - [x] 3.1 Write property test for LLM prompt completeness
    - **Property 2: LLM prompt always contains all market data fields**
    - **Validates: Requirements 2.1**
    - Use `fc.record({ sma50: fc.float(), currentPrice: fc.float(), lsRatio: fc.float(), imbalance: fc.float(), tradePressure: fc.float(), fearGreedIndex: fc.option(fc.float()), fearGreedLabel: fc.option(fc.string()), sectorIndex: fc.option(fc.float()) })` as generator
    - Assert prompt string contains SMA value, current price, L/S ratio, imbalance, and trade pressure

  - [x] 3.2 Write property test for confidence clamping
    - **Property 3: LLM confidence is always clamped to [0, 1]**
    - **Validates: Requirements 2.3**
    - Use `fc.float({ min: -10, max: 10 })` as generator for raw confidence values
    - Mock axios to return a valid LLM JSON response with the generated confidence; assert returned `Signal.confidence` satisfies `0 <= confidence <= 1`

- [x] 4. Create AISignalEngine
  - Create `src/ai/AISignalEngine.ts`
  - Implement `AISignalEngine` class with `constructor(adapter: ExchangeAdapter)` and `getSignal(symbol: string): Promise<Signal>`
  - Orchestrate: instantiate `SoSoValueClient` and `LLMClient` (from env vars), fetch SoSoValue context, fetch Binance market data via adapter, build `MarketContext`, call `LLMClient.call()`
  - On LLM success: map `LLMDecision` fields onto `Signal`, set `fallback: false`, set `reasoning` from LLM response
  - On any failure (SoSoValue null is not a failure — proceed without it; LLM null IS a failure): delegate to existing `SignalEngine.getSignal()`, set `fallback: true`, set `reasoning: ''`
  - Never throw — wrap entire body in try/catch that returns fallback signal
  - _Requirements: 2.2, 3.1, 3.2, 3.3, 3.4_

  - [x] 4.1 Write property test for AISignalEngine never throws
    - **Property 4: AISignalEngine always returns a valid Signal**
    - **Validates: Requirements 3.1, 3.3**
    - Simulate random failure modes (LLM timeout, network error, malformed JSON, null return) using `fc.oneof`
    - Assert returned value has all required `Signal` fields populated and `fallback: true`, and no exception is thrown

- [x] 5. Wire AISignalEngine into Watcher
  - In `src/modules/Watcher.ts`, replace `import { SignalEngine }` with `import { AISignalEngine }` from `../ai/AISignalEngine.js`
  - Change `private signalEngine: SignalEngine` to `private signalEngine: AISignalEngine`
  - Update constructor to instantiate `AISignalEngine` instead of `SignalEngine`
  - No other changes to `Watcher` logic — the `Signal` interface is backward-compatible
  - _Requirements: 3.4_

- [x] 6. Create TradeLogger
  - Create `src/ai/TradeLogger.ts`
  - Implement `TradeRecord` interface per design (all fields including `id`, `fallback`, `sessionPnl`)
  - Implement `TradeLogger` class with `constructor(backend: 'json' | 'sqlite', logPath: string)`
  - JSON backend: `log()` appends a newline-delimited JSON line to the file (fire-and-forget, catches all errors)
  - SQLite backend: `log()` inserts a row using `better-sqlite3` synchronous API (fire-and-forget, catches all errors)
  - `readAll()`: returns all records ordered by `timestamp` descending; returns `[]` on read error
  - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6_

  - [x] 6.1 Write property test for TradeLogger round-trip fidelity
    - **Property 5: TradeLogger round-trip fidelity**
    - **Validates: Requirements 4.1, 4.2, 4.3, 4.4**
    - Use `fc.record(...)` to generate random `TradeRecord` objects with all required fields
    - Log each record via `TradeLogger.log()`, call `readAll()`, assert the returned collection contains a record with identical field values
    - Test both `json` and `sqlite` backends

- [x] 7. Create sharedState module
  - Create `src/ai/sharedState.ts`
  - Export a mutable object: `export const sharedState = { sessionPnl: 0, updatedAt: new Date().toISOString() }`
  - _Requirements: 7.2_

- [x] 8. Wire TradeLogger into Watcher
  - In `src/modules/Watcher.ts`, import `TradeLogger` and `sharedState`
  - Instantiate `TradeLogger` in the `Watcher` constructor using `TRADE_LOG_BACKEND` and `TRADE_LOG_PATH` env vars
  - In the `PENDING_EXIT → IDLE` transition (after `notifyExitFilled`), call `this.tradeLogger.log(record)` fire-and-forget with a complete `TradeRecord` built from `pendingEntry` meta (entry price, reasoning, confidence, fallback) and `pendingExit` data (exit price, pnl, sessionPnl)
  - Store entry signal metadata (`reasoning`, `confidence`, `fallback`, `entryPrice`) on `PendingEntryState` so it is available at exit time
  - _Requirements: 4.1, 4.2_

- [x] 9. Update Executor.notifyEntryFilled and notifyExitFilled to include reasoning
  - In `src/modules/Executor.ts`, extend the `meta` parameter of `notifyEntryFilled` to include `reasoning: string` and `fallback: boolean`
  - In `notifyEntryFilled`: if `fallback` is true, append `\n🔄 *[Fallback Mode]*` to the message; otherwise append `\n💬 *Reasoning:* \`${reasoning.slice(0, 200)}\``
  - In `notifyExitFilled`: extend `meta` to include `reasoning: string` and `fallback: boolean`; apply the same truncation/fallback label logic
  - Update `Watcher` call sites to pass the new fields from the stored signal metadata
  - _Requirements: 5.1, 5.2, 5.3, 5.4_

  - [x] 9.1 Write property test for reasoning truncation
    - **Property 6: Telegram reasoning is always truncated to ≤ 200 characters**
    - **Validates: Requirements 5.1, 5.2**
    - Use `fc.string({ minLength: 0, maxLength: 1000 })` as generator for reasoning strings
    - Call `notifyEntryFilled` / `notifyExitFilled` with generated reasoning; capture the message sent to `TelegramManager`; assert the reasoning snippet in the message is ≤ 200 characters

  - [x] 9.2 Write property test for fallback label in notifications
    - **Property 7: Fallback signals are always labeled in Telegram notifications**
    - **Validates: Requirements 5.3**
    - Generate random `Signal` objects with `fallback: true` using `fc.record`
    - Assert notification message contains `"[Fallback Mode]"` and does NOT contain the raw `reasoning` value

- [x] 10. Checkpoint — Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 11. Create DashboardServer
  - Create `src/dashboard/server.ts`
  - Implement `DashboardServer` class with `constructor(tradeLogger: TradeLogger, port: number)` and `start(): void`
  - `GET /`: serve inline HTML (template literal) with a trades table and PnL display; include a `setInterval` polling `GET /api/pnl` every 5 seconds to update PnL without page reload
  - `GET /api/trades`: return `await tradeLogger.readAll()` as JSON; return `500` with JSON error body on failure
  - `GET /api/pnl`: return `{ sessionPnl: sharedState.sessionPnl, updatedAt: sharedState.updatedAt }` as JSON
  - Use `express` (add as dependency); listen on configured port
  - _Requirements: 6.1, 6.2, 6.3, 6.4, 7.1, 7.3, 8.1, 8.2, 8.3_

  - [x] 11.1 Write property test for trades endpoint ordering
    - **Property 8: Dashboard trades endpoint returns records ordered by timestamp descending**
    - **Validates: Requirements 6.2**
    - Use `fc.array(fc.record({ ...TradeRecord fields..., timestamp: fc.date().map(d => d.toISOString()) }), { minLength: 2 })` as generator
    - Log all records, call `GET /api/trades`, assert response array is sorted by `timestamp` descending

  - [x] 11.2 Write property test for PnL endpoint state reflection
    - **Property 9: Dashboard PnL endpoint reflects current shared state**
    - **Validates: Requirements 7.2**
    - Use `fc.float()` as generator; write value to `sharedState.sessionPnl`; call `GET /api/pnl`; assert `sessionPnl` in response equals written value

- [x] 12. Wire DashboardServer into bot.ts bootstrap
  - In `src/bot.ts`, import `DashboardServer`, `TradeLogger`, and read `DASHBOARD_PORT` / `TRADE_LOG_BACKEND` / `TRADE_LOG_PATH` from env
  - Instantiate `TradeLogger` once and pass it to both `Watcher` (via constructor or setter) and `DashboardServer`
  - Call `dashboardServer.start()` before the Telegram command setup
  - Validate that `LLM_PROVIDER` and the corresponding API key (`OPENAI_API_KEY` or `ANTHROPIC_API_KEY`) are present at startup; throw a descriptive error if missing
  - _Requirements: 6.4, 6.5_

- [x] 13. Update Watcher to write sessionPnl to sharedState
  - In `src/modules/Watcher.ts`, import `sharedState` from `../ai/sharedState.js`
  - After updating `this.sessionCurrentPnl` on each tick, write `sharedState.sessionPnl = this.sessionCurrentPnl` and `sharedState.updatedAt = new Date().toISOString()`
  - _Requirements: 7.2_

- [x] 14. Write unit tests for LLMClient.buildPrompt, SoSoValueClient, and AISignalEngine fallback
  - Create `src/__tests__/ai-alpha.test.ts`
  - `SoSoValueClient`: mock axios, verify `null` returned on network error / timeout / non-2xx; verify correct field extraction on a valid response
  - `LLMClient.buildPrompt()`: verify prompt contains all required fields for a known `MarketContext` input; verify SoSoValue unavailable text appears when fields are null
  - `AISignalEngine` fallback: mock `LLMClient.call()` to return `null`; verify returned `Signal` has `fallback: true` and all required fields populated
  - _Requirements: 1.3, 2.1, 3.1_

- [x] 15. Add new env vars to .env.example
  - Append the following variables to `.env.example` with placeholder values and inline comments:
    `LLM_PROVIDER`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `SOSOVALUE_API_KEY`, `TRADE_LOG_PATH`, `TRADE_LOG_BACKEND`, `DASHBOARD_PORT`
  - _Requirements: 2.6, 4.6_

- [x] 16. Verify TypeScript compiles with no errors
  - Run `tsc --noEmit` and resolve any type errors introduced by the new modules and interface extensions
  - Ensure `express` and `better-sqlite3` type declarations are installed (`@types/express`, `@types/better-sqlite3`)
  - _Requirements: all_

- [x] 17. Final checkpoint — Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Property tests use **fast-check** (add as devDependency if not present)
- `better-sqlite3` and `express` must be added as runtime dependencies
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
