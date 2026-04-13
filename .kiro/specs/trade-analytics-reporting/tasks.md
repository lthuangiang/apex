# Implementation Plan: Trade Analytics Reporting

## Overview

Extend the trading bot with a comprehensive analytics layer: enrich `TradeRecord` with ~20 new fields, migrate the SQLite schema, build a pure `AnalyticsEngine`, wire signal snapshots in `Watcher`, expose `/api/analytics/*` routes, and render an Analytics tab in the dashboard.

## Tasks

- [x] 1. Extend TradeRecord interface and update TradeLogger
  - [x] 1.1 Add all new optional fields to the `TradeRecord` interface in `src/ai/TradeLogger.ts`
    - Add `mode`, `entryTime`, `exitTime`, `holdingTimeSecs`, `exitTrigger` fields
    - Add `grossPnl`, `feePaid`, `wonBeforeFee` fee-analysis fields
    - Add signal snapshot fields: `regime`, `momentumScore`, `ema9`, `ema21`, `rsi`, `momentum3candles`, `volSpike`, `emaCrossUp`, `emaCrossDown`, `imbalance`, `tradePressure`, `lsRatio`, `llmDirection`, `llmConfidence`, `llmMatchesMomentum`
    - All new fields must be optional (`?`) for backward compatibility
    - _Requirements: design.md — Component 1: Extended TradeRecord_

  - [x] 1.2 Add `SignalSnapshot` interface to `src/ai/TradeLogger.ts` (or a shared types file)
    - Export `SignalSnapshot` interface matching the design spec
    - _Requirements: design.md — Data Models: SignalSnapshot_

  - [x] 1.3 Add idempotent SQLite migration in `TradeLogger` constructor
    - Add a `_migrate()` private method that runs `ALTER TABLE trades ADD COLUMN ...` for each new column
    - Wrap each `ALTER TABLE` in a try/catch to swallow `duplicate column name` errors
    - Call `_migrate()` at the end of the SQLite constructor block
    - Update the SQLite `INSERT` statement and `_readAllSqlite()` mapper to include all new columns
    - _Requirements: design.md — Data Models: SQLite Schema Extension_

  - [x] 1.4 Write unit tests for TradeLogger migration idempotency
    - Verify calling the constructor twice on the same DB does not throw
    - Verify new columns are present after migration
    - _Requirements: design.md — TradeLogger.migrate() spec_

- [x] 2. Create AnalyticsEngine
  - [x] 2.1 Create `src/ai/AnalyticsEngine.ts` with all types and the `AnalyticsEngine` class
    - Define `WinRateBreakdown`, `ConfidenceBucket`, `AnalyticsSummary` interfaces
    - Implement `_breakdown(trades)` helper
    - Implement `_streaks(trades)` helper (sort ascending, track curWins/curLosses)
    - Implement `_holdingDistribution(farmTrades)` helper with the 6 time buckets
    - Implement `compute(trades)` — overall, byMode, byDirection, byRegime, byConfidence, byHour, bestTrade, worstTrade, streaks, signalQuality, feeImpact, holdingTime
    - Handle missing optional fields gracefully (exclude from breakdowns that require them)
    - _Requirements: design.md — Component 2: AnalyticsEngine_

  - [x] 2.2 Write property test for AnalyticsEngine — P1: winRate in [0,1]
    - **Property 1: Win rate is always in [0, 1]**
    - **Validates: Requirements design.md P1**
    - Use `fast-check` with a `tradeRecordArbitrary()` generator
    - Assert `s.overall.winRate >= 0 && s.overall.winRate <= 1`

  - [x] 2.3 Write property test for AnalyticsEngine — P2: wins + losses = total
    - **Property 2: wins + losses = total for every breakdown**
    - **Validates: Requirements design.md P2**
    - Assert `s.overall.wins + s.overall.losses === s.overall.total`

  - [x] 2.4 Write property test for AnalyticsEngine — P9: compute is pure
    - **Property 9: Same input always produces same output**
    - **Validates: Requirements design.md P9**
    - Assert `deepEqual(engine.compute(trades), engine.compute([...trades]))`

  - [x] 2.5 Write property test for AnalyticsEngine — P10: empty input returns zero totals
    - **Property 10: Empty input returns zero totals**
    - **Validates: Requirements design.md P10**
    - Assert `compute([]).overall.total === 0 && compute([]).overall.winRate === 0`

  - [x] 2.6 Write unit tests for AnalyticsEngine
    - Single win / single loss cases
    - Mixed win/loss → correct win rate
    - Streak detection: 3 wins then 2 losses → `maxConsecWins=3`, `current={loss,2}`
    - Fee impact: `grossPnl=0.01`, `pnl=-0.005` → `wonBeforeFee=true`
    - Confidence bucket assignment at 0.55, 0.65, 0.75, 0.85
    - Hour bucketing at 00:00, 12:00, 23:00 UTC
    - P3: `bestTrade.pnl >= worstTrade.pnl`
    - P4: streak invariant — `maxConsecWins >= currentStreak.count` when type is 'win'
    - _Requirements: design.md — Testing Strategy_

- [x] 3. Checkpoint — Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 4. Update Watcher to capture SignalSnapshot and enrich TradeRecord
  - [x] 4.1 Extend `_pendingEntrySignalMeta` in `src/modules/Watcher.ts` to include `SignalSnapshot` fields
    - Import `SignalSnapshot` from `TradeLogger.ts`
    - Add `signalSnapshot?: SignalSnapshot` to the `_pendingEntrySignalMeta` type
    - _Requirements: design.md — Sequence Diagram: Trade Lifecycle_

  - [x] 4.2 Capture `SignalSnapshot` from the signal in the IDLE tick and store it in `_pendingEntrySignalMeta`
    - After `getSignal()` returns, build a `SignalSnapshot` from `signal` fields
    - Compute `llmMatchesMomentum = signal.direction === (signal.score > 0.5 ? 'long' : 'short')`
    - Store snapshot in `_pendingEntrySignalMeta.signalSnapshot`
    - _Requirements: design.md — Example Usage_

  - [x] 4.3 Enrich `TradeRecord` at trade close with all new fields
    - In the PENDING_EXIT → IDLE transition block where `tradeLogger.log(tradeRecord)` is called:
    - Compute `feePaid = positionValue * config.FEE_RATE_MAKER * 2`
    - Compute `grossPnl = pnl + feePaid`
    - Set `entryTime`, `exitTime`, `holdingTimeSecs`, `exitTrigger`, `mode`
    - Spread `_pendingEntrySignalMeta.signalSnapshot` into the record
    - _Requirements: design.md — Component 1, Example Usage_

  - [x] 4.4 Propagate `exitTrigger` string from the exit decision logic to the trade record
    - The `exitTrigger` variable is already computed in the IN_POSITION block; map it to the `exitTrigger` union type
    - Map `'SL/TP (RiskManager)'` → `'SL'`, `'FARM TP'` → `'FARM_TP'`, `'FARM TIME EXIT'` → `'FARM_TIME'`, `'FARM EARLY PROFIT'` → `'FARM_EARLY_PROFIT'`, force close → `'FORCE'`
    - Store mapped trigger so it's available when logging
    - _Requirements: design.md — Extended TradeRecord: exitTrigger_

- [x] 5. Add analytics API routes to DashboardServer
  - [x] 5.1 Add `AnalyticsEngine` instantiation and 30-second summary cache to `DashboardServer`
    - Import `AnalyticsEngine` and `AnalyticsSummary` in `src/dashboard/server.ts`
    - Add private `_analyticsCache: { summary: AnalyticsSummary | null; cachedAt: number }` field
    - Add `_analyticsEngine = new AnalyticsEngine()` field
    - _Requirements: design.md — Component 3: Analytics API Routes_

  - [x] 5.2 Implement `GET /api/analytics/summary` route
    - If cache is fresh (< 30s), return cached summary
    - Otherwise call `this.tradeLogger.readAll()` then `this._analyticsEngine.compute(trades)`
    - Store result in cache with timestamp
    - _Requirements: design.md — Component 3_

  - [x] 5.3 Implement `GET /api/analytics/trades` route with filtering
    - Accept query params: `mode`, `direction`, `regime`, `limit` (default 100), `offset` (default 0)
    - Read all trades, apply filters, slice for pagination
    - Return `{ trades, total }`
    - _Requirements: design.md — Component 3_

  - [x] 5.4 Implement `GET /api/analytics/signal-quality` and `GET /api/analytics/fee-impact` fast-path routes
    - Reuse the cached summary; return only the relevant sub-object
    - _Requirements: design.md — Component 3_

  - [x] 5.5 Invalidate analytics cache when a new trade is logged
    - Add a `onTradeLogged?: () => void` callback field to `TradeLogger`
    - Call it at the end of `log()` when a record is successfully persisted
    - In `DashboardServer`, set `this.tradeLogger.onTradeLogged = () => { this._analyticsCache.cachedAt = 0; }`
    - _Requirements: design.md — Performance Considerations_

- [x] 6. Add Analytics tab to dashboard HTML
  - [x] 6.1 Add Analytics tab button to the existing tab navigation in `_buildHtml()`
    - Add an "Analytics" tab alongside existing tabs
    - _Requirements: design.md — Component 4: Dashboard Analytics Tab_

  - [x] 6.2 Add Analytics tab panel HTML with stat cards and chart canvas elements
    - Overall win rate card, avg PnL card, total trades card, fee impact card
    - Canvas elements for: byMode, byDirection, byRegime, byConfidence, byHour charts
    - Signal quality section: LLM match rate, fallback rate, avg confidence
    - Best/worst trade display
    - Holding time distribution chart (farm mode)
    - _Requirements: design.md — Component 4_

  - [x] 6.3 Add JavaScript to fetch `/api/analytics/summary` and render all charts
    - On tab activation, fetch summary and call render functions
    - Poll every 30 seconds while tab is active
    - Use Chart.js (already loaded) for bar charts
    - Render win-rate stat cards from `summary.overall`, `summary.byMode`
    - Render bar charts for `byRegime`, `byConfidence`, `byHour`, `byDirection`
    - Render signal quality metrics and fee impact numbers
    - _Requirements: design.md — Component 4_

- [x] 7. Final checkpoint — Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- All new `TradeRecord` fields are optional — existing JSON/SQLite records remain readable without migration
- `AnalyticsEngine` is pure/stateless — easy to unit test in isolation
- The 30s cache prevents redundant recomputation during dashboard polling
- Property tests use `fast-check` — add to devDependencies if not already present (`npm i -D fast-check`)
