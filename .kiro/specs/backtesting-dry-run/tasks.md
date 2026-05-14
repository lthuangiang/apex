# Implementation Plan: Backtesting / Dry-Run Engine

## Overview

Implement a backtesting engine that replays historical OHLCV data through the existing bot logic (HedgeBot, BotInstance/Farm Mode) without placing real orders. The engine injects a `BacktestAdapter` that implements the `ExchangeAdapter` interface, simulates order fills and balance tracking, and exposes results via REST + SSE API endpoints and a dashboard UI tab.

All new code is TypeScript. No new npm packages are required — `fast-check` (already in devDependencies) is used for property-based tests.

---

## Tasks

- [x] 1. Define backtest types and shared data models
  - [x] 1.1 Create `src/backtest/types.ts` with all shared interfaces
    - Define `Kline` re-export (or import from `ExchangeAdapter.ts`)
    - Define `BacktestRunConfig`, `BacktestAdapterConfig`, `BacktestResult`, `BacktestMetrics`
    - Define `SimulatedTrade`, `BalanceSnapshot`, `PendingOrder`, `BacktestProgress`
    - Define `FillMode` union type: `'optimistic' | 'realistic' | 'pessimistic'`
    - Define error classes: `InvalidOrderError`, `InsufficientBalanceError`, `NoDataError`, `DataFetchError`, `LoadTimeoutError`
    - _Requirements: 1.4, 1.5, 2.13, 3.6, 3.10, 8.1–8.8_

  - [x] 1.2 Create `src/backtest/index.ts` public exports barrel
    - Re-export `BacktestAdapter`, `BacktestRunner`, `HistoricalDataFeed`, `BacktestMetricsCollector`
    - Re-export all types from `types.ts`
    - _Requirements: all_

- [ ] 2. Implement `BacktestAdapter`
  - [x] 2.1 Create `src/backtest/BacktestAdapter.ts` — core simulated exchange adapter
    - Implement `ExchangeAdapter` interface (all methods including optional `get_klines`)
    - Constructor accepts `klines: Map<string, Kline[]>`, `initialBalance: number`, `config: BacktestAdapterConfig`
    - Maintain `currentCandle: Map<string, Kline>`, `balance: number`, `positions: Map<string, Position>`, `pendingOrders: Map<string, PendingOrder>`
    - Implement `advanceTo(candle: Kline, symbol: string): void` — updates current candle, then calls `_checkFills(candle, symbol)`
    - `get_mark_price(symbol)` → returns `currentCandle.get(symbol).c`
    - `get_orderbook(symbol)` → synthetic bid/ask using `slippageBps`
    - `place_limit_order(symbol, side, price, size, reduceOnly?)` → validates price > 0 and size > 0, throws `InvalidOrderError` otherwise; assigns UUID order ID; stamps `placedAtCandleIndex`; adds to `pendingOrders`; returns order ID
    - `cancel_order(orderId, symbol)` → removes from `pendingOrders`, returns `true`/`false`
    - `cancel_all_orders(symbol)` → removes all pending orders for symbol, returns `true`
    - `get_open_orders(symbol)` → returns pending orders for symbol
    - `get_position(symbol, markPrice?)` → returns `Position` with `unrealizedPnl` computed from `markPrice ?? currentCandle.close`; returns `null` if no position
    - `get_balance()` → returns `this.balance`
    - `get_recent_trades(symbol, limit)` → returns synthetic trades from recent candles
    - `get_klines(symbol, interval, limit)` → returns up to `limit` klines with `t <= currentCandle.t`
    - `getTradeLog()` → returns `SimulatedTrade[]`
    - `getBalanceHistory()` → returns `BalanceSnapshot[]`
    - _Requirements: 1.1–1.14_

  - [x] 2.2 Implement `_checkFills(candle, symbol)` inside `BacktestAdapter`
    - Iterate over `pendingOrders` for the symbol
    - Skip orders whose `placedAtCandleIndex === currentCandleIndex` (fill monotonicity — Req 2.12)
    - Buy limit fills when `candle.low <= order.price`; sell limit fills when `candle.high >= order.price`
    - Apply fill price based on `fillMode`: optimistic → `order.price`, realistic → `candle.close`, pessimistic → apply slippage
    - Compute fee: `fillPrice * size * makerFeeBps / 10000`
    - Check balance sufficiency before applying fill; throw `InsufficientBalanceError` and leave order in queue if balance would go negative (Req 2.13)
    - Update `balance` and `positions` map for filled orders
    - Remove filled orders from `pendingOrders`
    - Append `SimulatedTrade` record to trade log
    - _Requirements: 2.1–2.13_

  - [-] 2.3 Write property test for `BacktestAdapter` — balance conservation (Property 1)
    - **Property 1: Balance Conservation**
    - For any sequence of fill events, `finalBalance == initialBalance + Σ(trade.netPnl)`
    - Use `fc.array(fc.record({...}))` to generate arbitrary trade sequences
    - **Validates: Requirements 1.12, 2.6, 5.1**

  - [-] 2.4 Write property test for `BacktestAdapter` — fill monotonicity (Property 2)
    - **Property 2: Fill Monotonicity**
    - An order placed during `advanceTo(candle[i])` is never filled in that same call
    - Generate arbitrary candles and orders; verify `get_open_orders` still has the order after the same-tick `advanceTo`
    - **Validates: Requirements 2.12, 4.2**

- [x] 3. Implement `BacktestMetricsCollector`
  - [x] 3.1 Create `src/backtest/BacktestMetricsCollector.ts`
    - Constructor accepts `runId: string`, `config: BacktestRunConfig`
    - `recordTick(snapshot: BalanceSnapshot): void` — appends to equity curve
    - `recordTrade(trade: SimulatedTrade): void` — appends to trade log
    - `finalize(): BacktestResult` — computes all metrics and returns result
    - Compute `totalPnl = Σ(trade.netPnl)`, `winRate = winningTrades / totalTrades` (0 if no trades)
    - Compute `maxDrawdown` as max `(peakEquity - currentEquity)` across equity curve snapshots
    - Compute `sharpeRatio = (meanDailyReturn / stdDevDailyReturn) * sqrt(252)`; return 0 if fewer than 2 calendar days
    - Compute `profitFactor = grossProfit / |grossLoss|`; handle edge cases (no losers → Infinity, no winners → 0, no trades → 0)
    - Compute `totalFeesPaid = Σ(trade.feePaid)`, `netPnl = grossPnl - feePaid` per trade
    - Return `trades` sorted ascending by `entryTime`; return `equityCurve` in recording order
    - Return zero-value result if `finalize()` called before any `recordTick()`
    - _Requirements: 5.1–5.11_

  - [x] 3.2 Write property test for `BacktestMetricsCollector` — win rate bounds (Property 4)
    - **Property 4: Win Rate Bounds**
    - For any array of `SimulatedTrade` records (including empty), `0 ≤ winRate ≤ 1`
    - Use `fc.array(fc.record({ netPnl: fc.float() }))` as arbitrary input
    - **Validates: Requirements 5.2, 5.3**

  - [x] 3.3 Write property test for `BacktestMetricsCollector` — drawdown non-negative (Property 5)
    - **Property 5: Drawdown Non-Negative**
    - For any equity curve (array of `BalanceSnapshot`), `maxDrawdown >= 0`
    - Use `fc.array(fc.record({ equity: fc.float({ min: 0 }) }))` as arbitrary input
    - **Validates: Requirements 5.4**

- [x] 4. Implement `HistoricalDataFeed`
  - [x] 4.1 Create `src/backtest/HistoricalDataFeed.ts`
    - Implement `loadKlines(symbol, interval, from, to): Promise<Kline[]>`
    - Check `./backtest-data/` for local CSV or JSON file matching `{symbol}_{interval}.csv` / `.json`
    - If local file exists, parse and return filtered klines (`from <= t <= to`)
    - If no local file, fetch from exchange REST API (use `axios` already in dependencies)
    - Cache fetched data to `./backtest-data/{symbol}_{interval}.json`
    - Deduplicate klines by timestamp (keep last occurrence)
    - Sort result ascending by timestamp
    - Throw `NoDataError` if no data found from either source
    - Throw `DataFetchError` on HTTP error from exchange API
    - Skip malformed records (missing OHLCV fields or non-numeric values), log warning with record index
    - Implement `listAvailableSymbols(): Promise<string[]>` — scans `./backtest-data/` for cached files
    - Support intervals: `1m`, `5m`, `15m`, `1h`, `4h`, `1d`
    - Apply 10-second load timeout; throw `LoadTimeoutError` if exceeded
    - _Requirements: 3.1–3.11, 8.7, 8.8, 8.9, 8.10, 8.11_

- [ ] 5. Implement `BacktestRunner`
  - [-] 5.1 Create `src/backtest/BacktestRunner.ts`
    - Constructor accepts `config: BacktestRunConfig`, `dataFeed: HistoricalDataFeed`, `onProgress?: (p: BacktestProgress) => void`
    - `run(): Promise<BacktestResult>` — full orchestration:
      1. Load klines via `dataFeed.loadKlines()`; return error result if empty or throws `NoDataError`
      2. Instantiate `BacktestAdapter` with loaded klines and `initialBalance`
      3. Instantiate bot (`HedgeBot` or `BotInstance`) with the adapter based on `config.botId`
      4. Call `bot.start()` (or equivalent)
      5. Tick loop: for each candle in ascending order, call `adapter.advanceTo(candle, symbol)`, then `bot.tickOnce()`
      6. After each candle, record `BalanceSnapshot` to `BacktestMetricsCollector`
      7. Emit progress via `onProgress` callback
      8. Respect `speedMultiplier`: if > 0, delay `candleIntervalMs / speedMultiplier` between ticks; if 0, no delay
      9. On bot tick error: record in `errors[]`, skip candle, continue loop (Req 4.9)
      10. Detect data gaps (timestamp diff > 1.5× expected interval); log warning, skip gap (Req 9.2)
      11. After loop: call `bot.stop()`, call `metrics.finalize()`, return `BacktestResult`
    - `abort(): void` — sets abort flag; loop exits after current candle; result has `status: 'aborted'`
    - Return `status: 'completed'` on normal finish, `status: 'error'` on fatal init failure
    - _Requirements: 4.1–4.11, 9.1–9.6, 10.1–10.5_

- [ ] 6. Expose `tickOnce()` on bot classes
  - [-] 6.1 Add `tickOnce(): Promise<void>` to `src/bot/HedgeBot.ts`
    - Add public method that calls `this._tick()` directly (one iteration of the state machine)
    - Must not throw a state-guard error when `botStatus === 'STOPPED'`
    - Must not call `setTimeout` or `setInterval` inside the tick body
    - _Requirements: 11.1, 11.3, 11.4, 11.5_

  - [-] 6.2 Add `tickOnce(): Promise<void>` to `src/bot/BotInstance.ts`
    - Add public method that calls `this.watcher._tick()` (expose `_tick` as `public` or add a `tickOnce` proxy on `Watcher`)
    - Must not throw a state-guard error when `botStatus === 'STOPPED'`
    - _Requirements: 11.2, 11.3, 11.4, 11.5_

  - [ ] 6.3 Add `tickOnce(): Promise<void>` to `src/modules/Watcher.ts`
    - Change `private async _tick()` to `public async _tick()` (or add a `tickOnce()` public wrapper)
    - Ensure no sleep/setTimeout is called inside `_tick()` body itself (timing is controlled by caller)
    - _Requirements: 11.2, 11.5_

- [ ] 7. Checkpoint — core engine complete
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 8. Implement Backtest API routes
  - [x] 8.1 Create `src/dashboard/routes/backtestRoutes.ts`
    - Export `createBacktestRouter(dataFeed: HistoricalDataFeed): express.Router`
    - Maintain in-memory `runs: Map<string, RunState>` (runId → runner + result + SSE clients)
    - `POST /api/backtest/run` — validate `BacktestRunConfig` (required fields, date range, `from < to`, `initialBalance > 0`, enum values); return HTTP 400 with field-level error on invalid; assign `runId = randomUUID()`; start `BacktestRunner.run()` in background; return `{ runId }` HTTP 202
    - `GET /api/backtest/status/:runId` — return `{ runId, status, processed, total, currentBalance }` HTTP 200; HTTP 404 if unknown
    - `GET /api/backtest/result/:runId` — return full `BacktestResult` HTTP 200 if completed; HTTP 202 `{ status: 'running' }` if in progress; HTTP 404 if unknown
    - `GET /api/backtest/stream/:runId` — SSE endpoint; push `{ type: 'progress', ... }` events; push `{ type: 'complete', result }` on finish; push `{ type: 'aborted', result }` on abort; send `{ type: 'error', message: 'Run not found' }` and close if unknown runId
    - `DELETE /api/backtest/:runId` — call `runner.abort()` HTTP 200; HTTP 404 if not active
    - `GET /api/backtest/history` — return last 50 completed runs sorted by `startedAt` descending with summary fields
    - Ensure run isolation: each runId's events/results never leak to other runIds
    - _Requirements: 6.1–6.12_

  - [ ] 8.2 Write unit tests for backtest API route validation
    - Test HTTP 400 on missing required fields, invalid date range, `from >= to`, `initialBalance <= 0`
    - Test HTTP 404 on unknown runId for status/result/stream/delete endpoints
    - Test HTTP 202 on valid `POST /api/backtest/run`
    - _Requirements: 6.1, 6.2, 6.4, 6.10_

- [ ] 9. Register backtest routes in `DashboardServer`
  - [ ] 9.1 Modify `src/dashboard/server.ts` to import and register `backtestRoutes`
    - Import `createBacktestRouter` from `./routes/backtestRoutes.js`
    - Instantiate `HistoricalDataFeed` and pass to `createBacktestRouter`
    - Register router: `this.app.use('/api/backtest', backtestRouter)` inside `_setupRoutes()` or `_setupManagerRoutes()`
    - _Requirements: 6.1_

- [ ] 10. Implement Dashboard UI — Backtest tab
  - [ ] 10.1 Create `src/dashboard/views/backtest.ejs`
    - Configuration form: bot selector (populated from `/api/bots`), date range (from/to date inputs), candle interval select (`1m`/`5m`/`15m`/`1h`/`4h`/`1d`), initial balance input (> 0), maker fee bps (0–500), taker fee bps (0–500), slippage bps (0–200), fill mode select (`optimistic`/`realistic`/`pessimistic`), data source select (`local`/`exchange_api`/`auto`)
    - Client-side validation: show inline error for missing/out-of-range fields; do NOT submit if invalid
    - On submit: `POST /api/backtest/run`, disable submit button, show "Connecting…" indicator
    - Open SSE stream to `/api/backtest/stream/:runId`; update progress display (candles processed, % complete, current balance) at most once per second
    - On `complete` event: display results summary (total PnL, PnL%, win rate, total trades, max drawdown, Sharpe ratio, profit factor, total fees paid)
    - Render equity curve chart (use `<canvas>` with inline Chart.js or a simple SVG path — no new npm packages)
    - Render trade-by-trade log table sorted ascending by entry time: entry time, exit time, symbol, side, entry price, exit price, size, net PnL, exit reason
    - "Stop" button visible during run: sends `DELETE /api/backtest/:runId`; on abort, display partial results with "Aborted" status badge
    - History list: show last 50 runs with run date, bot name, date range, final PnL
    - On API error (4xx/5xx): display error message, re-enable submit button
    - _Requirements: 7.1–7.11_

  - [ ] 10.2 Add Backtest tab navigation link to `src/dashboard/views/manager.ejs`
    - Add a "Backtest" nav link pointing to `/backtest` (or render inline as a tab)
    - Add route `GET /backtest` in `server.ts` that renders `backtest.ejs`
    - _Requirements: 7.1_

- [ ] 11. Checkpoint — full integration
  - Ensure all tests pass, ask the user if questions arise.

---

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- `tickOnce()` on `HedgeBot` and `BotInstance` is the minimal interface change needed — bot logic itself is untouched
- The `BacktestAdapter` uses `placedAtCandleIndex` to enforce fill monotonicity (Property 2): orders placed during candle `i` cannot fill until candle `i+1`
- `HistoricalDataFeed` caches to `./backtest-data/` — ensure this directory is in `.gitignore`
- SSE streams are scoped per `runId` — no cross-run data leakage
- Property tests use `fast-check` (already in devDependencies); run with `npm test`

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2"] },
    { "id": 1, "tasks": ["2.1", "3.1", "4.1"] },
    { "id": 2, "tasks": ["2.2", "3.2", "3.3"] },
    { "id": 3, "tasks": ["2.3", "2.4", "5.1", "6.1", "6.2", "6.3"] },
    { "id": 4, "tasks": ["8.1"] },
    { "id": 5, "tasks": ["8.2", "9.1"] },
    { "id": 6, "tasks": ["10.1", "10.2"] }
  ]
}
```
