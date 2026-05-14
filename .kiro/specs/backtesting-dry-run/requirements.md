# Requirements Document

## Introduction

Tính năng Backtesting / Dry-Run cho phép user replay historical OHLCV data qua đúng bot logic hiện tại (HedgeBot, Farm Mode, FundingFeeArbitrage) mà không đặt lệnh thật. Engine inject một `BacktestAdapter` implement đúng `ExchangeAdapter` interface, simulate order fills, position tracking, và balance updates dựa trên dữ liệu lịch sử. Kết quả được hiển thị trên dashboard với các metrics: PnL, win rate, max drawdown, Sharpe ratio, và trade-by-trade log. Mục tiêu: user có thể đánh giá hiệu suất strategy trên historical data trước khi bỏ tiền thật, mà không cần thay đổi bất kỳ dòng code nào trong bot logic.

## Glossary

- **BacktestAdapter**: Component implement `ExchangeAdapter` interface, simulate toàn bộ exchange behavior dựa trên historical OHLCV data thay vì kết nối exchange thật.
- **BacktestRunner**: Component orchestrate toàn bộ backtest — setup, tick loop, teardown.
- **HistoricalDataFeed**: Component load và cache OHLCV data từ nhiều nguồn (local files, exchange REST API).
- **BacktestMetricsCollector**: Component tính toán performance metrics từ trade log và balance history.
- **Kline**: Một OHLCV candle với các trường: timestamp (t), open (o), high (h), low (l), close (c), volume (v).
- **SimulatedTrade**: Bản ghi một giao dịch hoàn chỉnh trong backtest, bao gồm entry/exit price, PnL, fees.
- **EquityCurve**: Chuỗi thời gian của balance và equity (balance + unrealized PnL) trong suốt backtest.
- **BacktestRunConfig**: Cấu hình đầu vào cho một lần chạy backtest: bot ID, date range, interval, initial balance, fee rates.
- **BacktestResult**: Kết quả đầu ra của một lần chạy backtest: metrics tổng hợp, equity curve, trade log.
- **PendingOrder**: Lệnh limit đã được đặt bởi bot nhưng chưa được fill trong simulation.
- **FillMode**: Chế độ simulate fill: `optimistic` (fill tại đúng limit price), `realistic` (fill tại candle close), `pessimistic` (fill với slippage).
- **MaxDrawdown**: Mức sụt giảm lớn nhất từ đỉnh equity xuống đáy trong suốt backtest.
- **SharpeRatio**: Tỷ lệ lợi nhuận trung bình hàng ngày chia cho độ lệch chuẩn, nhân với sqrt(252).
- **ProfitFactor**: Tổng lợi nhuận gộp chia cho tổng lỗ gộp.
- **SSE**: Server-Sent Events — cơ chế push real-time progress từ server xuống dashboard UI.
- **RunId**: Unique identifier cho mỗi lần chạy backtest.

---

## Requirements

### Requirement 1: BacktestAdapter — Simulated Exchange Interface

**User Story:** As a bot developer, I want the backtest engine to use the same `ExchangeAdapter` interface as live trading, so that bot logic runs unchanged during backtesting without any code modification.

#### Acceptance Criteria

1. THE BacktestAdapter SHALL implement every method defined in the `ExchangeAdapter` interface (`get_mark_price`, `get_orderbook`, `place_limit_order`, `cancel_order`, `cancel_all_orders`, `get_open_orders`, `get_position`, `get_balance`, `get_orderbook_depth`, `get_recent_trades`, `get_klines`), including `get_klines` even though it is optional in the interface.
2. WHEN `get_mark_price` is called, THE BacktestAdapter SHALL return the close price of the current candle for the requested symbol.
3. WHEN `get_orderbook` is called, THE BacktestAdapter SHALL return a synthetic orderbook where `best_bid = candle.close * (1 - slippageBps/10000)` and `best_ask = candle.close * (1 + slippageBps/10000)`.
4. WHEN `place_limit_order` is called with a valid symbol, side, price greater than 0, and size greater than 0, THE BacktestAdapter SHALL add the order to the pending orders queue and return a unique order ID string; optional parameters `reduceOnly` and `timeInForce` SHALL be accepted but ignored in simulation.
5. WHEN `place_limit_order` is called with price ≤ 0 or size ≤ 0, THE BacktestAdapter SHALL throw an `InvalidOrderError`.
6. WHEN `cancel_order` is called with an existing order ID, THE BacktestAdapter SHALL remove the order from the pending orders queue and return `true`.
7. WHEN `cancel_order` is called with a non-existent order ID, THE BacktestAdapter SHALL return `false`.
8. WHEN `cancel_all_orders` is called for a symbol that has pending orders, THE BacktestAdapter SHALL remove all pending orders for that symbol and return `true`; WHEN called for a symbol with no pending orders, THE BacktestAdapter SHALL return `true` without error.
9. WHEN `get_open_orders` is called for a symbol, THE BacktestAdapter SHALL return all pending (unfilled) orders for that symbol.
10. WHEN `get_position` is called for a symbol with an open simulated position, THE BacktestAdapter SHALL return a `Position` object with `unrealizedPnl` computed as `(markPrice ?? currentCandle.close - entryPrice) * size` for a long position and `(entryPrice - (markPrice ?? currentCandle.close)) * size` for a short position.
11. WHEN `get_position` is called for a symbol with no open position, THE BacktestAdapter SHALL return `null`.
12. WHEN `get_balance` is called, THE BacktestAdapter SHALL return the current simulated cash balance.
13. WHEN `get_recent_trades` is called with a `limit` parameter, THE BacktestAdapter SHALL return up to `limit` synthetic trade records constructed from the most recent candles for the requested symbol, each record containing at minimum: timestamp, price (candle close), and side (alternating buy/sell).
14. WHEN `get_klines` is called with a `limit` parameter, THE BacktestAdapter SHALL return up to `limit` historical klines for the requested symbol with timestamps ≤ the current simulated time; IF fewer than `limit` klines are available, THE BacktestAdapter SHALL return all available klines without error.

---

### Requirement 2: Order Fill Simulation

**User Story:** As a user, I want the backtest engine to simulate realistic order fills based on candle price ranges, so that backtest results reflect achievable trading outcomes.

#### Acceptance Criteria

1. WHEN `advanceTo(candle, symbol)` is called and a pending buy limit order has `price >= candle.low`, THE BacktestAdapter SHALL fill that order.
2. WHEN `advanceTo(candle, symbol)` is called and a pending sell limit order has `price <= candle.high`, THE BacktestAdapter SHALL fill that order.
3. WHEN an order is filled in `optimistic` fill mode, THE BacktestAdapter SHALL use the order's limit price as the fill price.
4. WHEN an order is filled in `realistic` fill mode, THE BacktestAdapter SHALL use the candle close price as the fill price.
5. WHEN a buy order is filled in `pessimistic` fill mode, THE BacktestAdapter SHALL use `price * (1 + slippageBps/10000)` as the fill price.
6. WHEN a sell order is filled in `pessimistic` fill mode, THE BacktestAdapter SHALL use `price * (1 - slippageBps/10000)` as the fill price.
7. WHEN a buy order is filled, THE BacktestAdapter SHALL deduct `fillPrice * size * makerFeeBps / 10000` from the simulated balance and increase the simulated balance by `-(fillPrice * size)` (i.e., deduct the cost of the position).
8. WHEN a sell order is filled, THE BacktestAdapter SHALL credit `fillPrice * size` to the simulated balance and deduct `fillPrice * size * makerFeeBps / 10000` as the maker fee.
9. WHEN a buy order is filled, THE BacktestAdapter SHALL increase the simulated long position size for the symbol by `size`; WHEN a sell order is filled, THE BacktestAdapter SHALL decrease the simulated long position size (or increase short position size) by `size`.
10. WHEN an order is filled, THE BacktestAdapter SHALL remove the order from the pending orders queue.
11. WHEN an order is filled, THE BacktestAdapter SHALL append a `SimulatedTrade` record to the trade log.
12. IF a pending order was placed at candle index `i`, THEN THE BacktestAdapter SHALL NOT fill that order during the same `advanceTo` call for candle index `i` (fill monotonicity — orders placed in the current tick cannot fill in the same tick).
13. WHEN `advanceTo` is called and a fill would cause the simulated balance to become negative, THE BacktestAdapter SHALL reject that fill, leave the order in the pending queue, and throw an `InsufficientBalanceError` without modifying balance or position state.

---

### Requirement 3: Historical Data Feed

**User Story:** As a user, I want the backtest engine to load historical OHLCV data from local files or exchange APIs, so that I can run backtests on any available historical period.

#### Acceptance Criteria

1. WHEN `loadKlines(symbol, interval, from, to)` is called and a local CSV or JSON file exists in `./backtest-data/`, THE HistoricalDataFeed SHALL load klines from that file.
2. WHEN `loadKlines` is called and no local file exists, THE HistoricalDataFeed SHALL fetch klines from the exchange REST API.
3. WHEN klines are fetched from the exchange REST API, THE HistoricalDataFeed SHALL cache the result to `./backtest-data/` for future reuse.
4. WHEN `loadKlines` returns data, THE HistoricalDataFeed SHALL return klines sorted in ascending order by timestamp (oldest first).
5. WHEN `loadKlines` returns data, THE HistoricalDataFeed SHALL return only klines whose timestamps satisfy `from <= timestamp <= to` (inclusive on both ends).
6. IF `loadKlines` finds no data for the requested symbol and range after checking both local files and the exchange API, THEN THE HistoricalDataFeed SHALL throw a `NoDataError` with a message identifying the symbol, interval, and date range.
7. WHEN loaded klines contain duplicate timestamps, THE HistoricalDataFeed SHALL deduplicate them, keeping the last occurrence.
8. THE HistoricalDataFeed SHALL support intervals: `1m`, `5m`, `15m`, `1h`, `4h`, `1d`.
9. THE HistoricalDataFeed SHALL expose `listAvailableSymbols()` returning the list of symbols with locally cached data.
10. WHEN the exchange REST API returns an HTTP error during data fetch, THE HistoricalDataFeed SHALL throw a `DataFetchError` containing the HTTP status code and a message suggesting the user retry or use local data.
11. WHEN a local data file contains a malformed record (missing required OHLCV fields or non-numeric values), THE HistoricalDataFeed SHALL skip that record, log a warning with the record index, and continue loading the remaining records.

---

### Requirement 4: BacktestRunner — Orchestration

**User Story:** As a user, I want the backtest engine to drive the bot tick loop over historical candles, so that the bot's strategy is evaluated across the full historical period.

#### Acceptance Criteria

1. WHEN `run()` is called, THE BacktestRunner SHALL load klines via `HistoricalDataFeed`, instantiate `BacktestAdapter` with the loaded klines and `initialBalance`, instantiate the bot with the adapter, and start the tick loop.
2. WHEN `run()` is called and `HistoricalDataFeed.loadKlines()` returns an empty array or throws a `NoDataError`, THE BacktestRunner SHALL return a `BacktestResult` with `status: 'error'` and an `error` field containing the data feed's error message without starting the tick loop.
3. WHEN the tick loop runs, THE BacktestRunner SHALL process candles in ascending timestamp order, calling `adapter.advanceTo(candle, symbol)` then the bot's internal tick method exposed for backtest use for each candle.
4. WHEN each candle is processed, THE BacktestRunner SHALL record a `BalanceSnapshot` containing timestamp, balance, equity (balance + unrealized PnL from all open positions), and drawdown (peak equity observed so far minus current equity, minimum 0).
5. WHEN `speedMultiplier` is 0 or not set, THE BacktestRunner SHALL process candles at maximum speed without any artificial delay.
6. WHEN `speedMultiplier` is greater than 0, THE BacktestRunner SHALL introduce a delay of `(candleIntervalMs / speedMultiplier)` between ticks, where `candleIntervalMs` is derived from `BacktestRunConfig.interval` (e.g., `'1m'` → 60000ms, `'1h'` → 3600000ms, `'1d'` → 86400000ms).
7. WHEN `abort()` is called during a run, THE BacktestRunner SHALL set an abort flag and stop the tick loop after completing the current candle.
8. WHEN the tick loop completes or is aborted, THE BacktestRunner SHALL call `bot.stop()` and return a `BacktestResult`.
9. WHEN the bot's tick method throws an unhandled error for a candle, THE BacktestRunner SHALL record the error in `BacktestResult.errors[]` with the candle timestamp and error message, skip that candle, and continue the loop without aborting the entire backtest.
10. WHEN the backtest is aborted, THE BacktestRunner SHALL return a `BacktestResult` with `status: 'aborted'` and metrics computed up to the abort point.
11. WHEN the backtest completes successfully, THE BacktestRunner SHALL return a `BacktestResult` with `status: 'completed'`.

---

### Requirement 5: BacktestMetricsCollector — Performance Metrics

**User Story:** As a user, I want the backtest engine to compute comprehensive performance metrics, so that I can evaluate my bot's strategy objectively.

#### Acceptance Criteria

1. WHEN `finalize()` is called, THE BacktestMetricsCollector SHALL compute `totalPnl` as the sum of `netPnl` across all `SimulatedTrade` records.
2. WHEN `finalize()` is called, THE BacktestMetricsCollector SHALL compute `winRate` as `winningTrades / totalTrades`, where a winning trade has `netPnl > 0`.
3. WHEN `finalize()` is called with zero trades, THE BacktestMetricsCollector SHALL return `winRate = 0` and `totalTrades = 0`.
4. WHEN `finalize()` is called, THE BacktestMetricsCollector SHALL compute `maxDrawdown` in USD as the maximum value of `(peakEquity - currentEquity)` observed across all `BalanceSnapshot` records, where equity = balance + unrealizedPnl per tick.
5. WHEN `finalize()` is called with at least 2 calendar days of equity snapshots, THE BacktestMetricsCollector SHALL compute `sharpeRatio` as `(meanDailyReturn / stdDevDailyReturn) * sqrt(252)`, where daily returns are computed as the percentage change between the first equity value of consecutive calendar days; WHEN fewer than 2 calendar days of data exist, THE BacktestMetricsCollector SHALL return `sharpeRatio = 0`.
6. WHEN `finalize()` is called, THE BacktestMetricsCollector SHALL compute `profitFactor` as `sum(netPnl for winning trades) / |sum(netPnl for losing trades)|`; IF there are no losing trades and gross profit > 0, THE BacktestMetricsCollector SHALL return `profitFactor = Infinity`; IF there are no winning trades, THE BacktestMetricsCollector SHALL return `profitFactor = 0`; IF there are zero trades, THE BacktestMetricsCollector SHALL return `profitFactor = 0`.
7. WHEN `finalize()` is called, THE BacktestMetricsCollector SHALL compute `totalFeesPaid` as the sum of `feePaid` across all `SimulatedTrade` records.
8. WHEN `finalize()` is called, THE BacktestMetricsCollector SHALL return `result.trades` sorted in ascending order by `entryTime`.
9. WHEN `finalize()` is called, THE BacktestMetricsCollector SHALL return `result.equityCurve` with one entry per `recordTick()` call, in the order they were recorded.
10. WHEN `finalize()` is called, THE BacktestMetricsCollector SHALL compute `netPnl` for each `SimulatedTrade` as `grossPnl - feePaid`.
11. WHEN `finalize()` is called before any `recordTick()` call has been made, THE BacktestMetricsCollector SHALL return a `BacktestResult` with all numeric metrics set to 0, `trades` as an empty array, and `equityCurve` as an empty array.

---

### Requirement 6: Backtest API Endpoints

**User Story:** As a dashboard user, I want REST and SSE API endpoints for backtesting, so that I can start, monitor, and retrieve backtest results from the UI.

#### Acceptance Criteria

1. WHEN a `POST /api/backtest/run` request is received with a valid `BacktestRunConfig`, THE Backtest_API SHALL start a new backtest run, assign a unique `runId`, and return `{ runId }` with HTTP 202.
2. WHEN a `POST /api/backtest/run` request is received with an invalid config (missing required fields, invalid date range, `from >= to`, `initialBalance <= 0`), THE Backtest_API SHALL return HTTP 400 with an error message indicating which field failed validation.
3. WHEN a `GET /api/backtest/status/:runId` request is received for an active run, THE Backtest_API SHALL return HTTP 200 with the current progress: `{ runId, status, processed, total, currentBalance }`.
4. WHEN a `GET /api/backtest/status/:runId` request is received for an unknown `runId`, THE Backtest_API SHALL return HTTP 404.
5. WHEN a `GET /api/backtest/result/:runId` request is received for a completed run, THE Backtest_API SHALL return HTTP 200 with the full `BacktestResult` as JSON.
6. WHEN a `GET /api/backtest/result/:runId` request is received for a run that is still in progress, THE Backtest_API SHALL return HTTP 202 with `{ status: 'running' }`.
7. WHEN a `GET /api/backtest/stream/:runId` SSE connection is established for a known `runId`, THE Backtest_API SHALL push progress events as `data: { type: 'progress', processed, total, currentBalance }`, a `data: { type: 'complete', result }` event when the run finishes successfully, and a `data: { type: 'aborted', result }` event when the run is aborted.
8. WHEN a `GET /api/backtest/stream/:runId` SSE connection is established for an unknown `runId`, THE Backtest_API SHALL immediately send `data: { type: 'error', message: 'Run not found' }` and close the connection.
9. WHEN a `DELETE /api/backtest/:runId` request is received for an active run, THE Backtest_API SHALL call `runner.abort()` and return HTTP 200.
10. WHEN a `DELETE /api/backtest/:runId` request is received for a non-active or unknown `runId`, THE Backtest_API SHALL return HTTP 404.
11. WHEN a `GET /api/backtest/history` request is received, THE Backtest_API SHALL return a list of past `BacktestResult` summaries sorted by `startedAt` descending, each entry containing: `runId`, `status`, `startedAt`, `completedAt`, bot name, date range, interval, `totalPnl`, `winRate`, `totalTrades`, `maxDrawdown`, and `sharpeRatio`; the list SHALL be capped at the 50 most recent runs.
12. WHEN multiple backtest runs are active concurrently, THE Backtest_API SHALL ensure that progress events, results, and SSE streams for one `runId` never appear in responses for a different `runId`.

---

### Requirement 7: Dashboard UI — Backtest Tab

**User Story:** As a user, I want a dedicated Backtest tab in the dashboard, so that I can configure, launch, and review backtests without leaving the application.

#### Acceptance Criteria

1. WHEN the user navigates to the Backtest tab, THE Dashboard SHALL display a configuration form with fields: bot selector, date range (from/to), candle interval, initial balance (must be > 0), maker fee bps (0–500), taker fee bps (0–500), slippage bps (0–200), fill mode selector, and data source selector (local/exchange_api/auto).
2. WHEN the user submits the configuration form, THE Dashboard SHALL send a `POST /api/backtest/run` request, disable the submit button, and display a "Connecting…" indicator until the SSE stream opens.
3. WHEN a backtest is running and SSE events are received, THE Dashboard SHALL update the progress display at most once per second showing: candles processed, percentage complete, and current simulated balance.
4. WHEN a backtest completes, THE Dashboard SHALL display the results summary: total PnL, PnL%, win rate, total trades, max drawdown, Sharpe ratio, profit factor, total fees paid.
5. WHEN a backtest completes, THE Dashboard SHALL display an equity curve chart showing balance and equity over time.
6. WHEN a backtest completes, THE Dashboard SHALL display a trade-by-trade log table sorted ascending by entry time with columns: entry time, exit time, symbol, side, entry price, exit price, size, net PnL, exit reason.
7. WHEN a backtest is running, THE Dashboard SHALL display a "Stop" button that sends `DELETE /api/backtest/:runId` to abort the run.
8. WHEN the user clicks "Stop" and the run is aborted, THE Dashboard SHALL display the partial results (all metrics computed up to the abort point) with a status indicator showing "Aborted".
9. WHEN a previous backtest result exists, THE Dashboard SHALL display a history list showing run date, bot name, date range, and final PnL for each past run, capped at the 50 most recent runs.
10. WHEN the user submits the configuration form with a missing required field or an out-of-range value, THE Dashboard SHALL display an inline validation error for that field and SHALL NOT send the `POST /api/backtest/run` request.
11. WHEN the `POST /api/backtest/run` request returns an error (HTTP 4xx or 5xx), THE Dashboard SHALL display the error message returned by the API and re-enable the submit button.

---

### Requirement 8: Simulation Configuration

**User Story:** As a user, I want to configure fee rates, slippage, and fill mode for the simulation, so that backtest results reflect realistic trading costs.

#### Acceptance Criteria

1. THE BacktestRunConfig SHALL accept `makerFeeBps` as an integer in the range [0, 10000] representing the maker fee in basis points.
2. THE BacktestRunConfig SHALL accept `takerFeeBps` as an integer in the range [0, 10000] representing the taker fee in basis points.
3. THE BacktestRunConfig SHALL accept `slippageBps` as an integer in the range [0, 10000] representing simulated slippage in basis points.
4. THE BacktestRunConfig SHALL accept `fillMode` with values `'optimistic'`, `'realistic'`, or `'pessimistic'`.
5. WHEN `fillMode` is not specified, THE BacktestAdapter SHALL default to `'realistic'` fill mode.
6. THE BacktestRunConfig SHALL accept `initialBalance` as a number in the range [0.01, 1,000,000,000] representing the starting USD balance.
7. THE BacktestRunConfig SHALL accept `interval` as one of: `'1m'`, `'5m'`, `'15m'`, `'1h'`, `'4h'`, `'1d'`.
8. THE BacktestRunConfig SHALL accept `dataSource` as one of: `'local'`, `'exchange_api'`, `'auto'`.
9. IF `dataSource` is `'auto'` and local data is available (loadable without error) for the requested symbol and range, THEN THE HistoricalDataFeed SHALL use the local data.
10. IF `dataSource` is `'auto'` and local data is not available, THEN THE HistoricalDataFeed SHALL fetch from the exchange API.
11. IF `dataSource` is `'auto'` and both local data and the exchange API are unavailable, THEN THE HistoricalDataFeed SHALL throw a `NoDataError` with a message indicating both sources failed.
12. WHEN a `BacktestRunConfig` is received with any field outside its valid range or with an invalid enum value, THE Backtest_API SHALL return HTTP 400 before starting any backtest execution.

---

### Requirement 9: Data Quality and Error Handling

**User Story:** As a user, I want the backtest engine to handle data gaps and errors gracefully, so that a single bad candle or missing data does not invalidate the entire backtest.

#### Acceptance Criteria

1. WHEN `HistoricalDataFeed.loadKlines()` returns an empty array, THE BacktestRunner SHALL return a `BacktestResult` with `status: 'error'` and `error: 'No historical data for the requested symbol and date range'`.
2. WHEN a gap is detected in the OHLCV data (the timestamp difference between two consecutive candles exceeds the expected interval duration by more than 50%), THE BacktestRunner SHALL log a warning with the gap start and end timestamps, skip the missing candles, and continue with the next available candle.
3. WHEN the gap count exceeds 10% of total expected candles for the requested date range and interval, THE BacktestResult SHALL include a `dataQuality.gapCount` field reporting the number of gaps detected.
4. WHEN the bot's tick method throws an unhandled error, THE BacktestRunner SHALL record the error in `BacktestResult.errors[]` with the candle timestamp and error message, and continue the loop.
5. WHEN the exchange REST API returns an HTTP error during data fetch, THE HistoricalDataFeed SHALL throw a `DataFetchError` containing the HTTP status code and a message suggesting the user retry or provide local data.
6. IF a backtest run encounters a fatal error during initialization (adapter initialization failure, bot instantiation failure, or invalid config), THEN THE BacktestRunner SHALL return a `BacktestResult` with `status: 'error'` and a descriptive `error` field without starting the tick loop.

---

### Requirement 10: Performance and Concurrency

**User Story:** As a user, I want backtests to run fast and not block other dashboard functionality, so that I can iterate quickly on strategy evaluation.

#### Acceptance Criteria

1. WHEN `speedMultiplier` is 0 (maximum speed mode), THE BacktestRunner SHALL process a dataset of 100,000 candles in under 10 seconds of wall-clock time, measured from the first `advanceTo` call to the last.
2. WHEN the backtest tick loop is running, THE BacktestRunner SHALL not perform any file I/O or network I/O inside the loop (all market data reads from in-memory state).
3. WHEN multiple `BacktestRunner` instances are created concurrently, each instance SHALL maintain its own independent `BacktestAdapter`, bot instance, and `BacktestMetricsCollector` with no shared mutable state between runs.
4. WHEN loading 1 year of 1-minute klines (~525,600 candles), THE HistoricalDataFeed SHALL complete loading within 10 seconds of wall-clock time; IF loading exceeds 10 seconds, THE HistoricalDataFeed SHALL throw a `LoadTimeoutError`.
5. WHEN a backtest run is in progress, THE Backtest_API SHALL respond to other API requests (bot status, trade history, etc.) within 500ms.

---

---

### Requirement 11: Bot Compatibility — Tick Interface

**User Story:** As a developer, I want the existing bot classes to expose a tick method usable by the BacktestRunner, so that backtesting works with all supported bot types without modifying bot logic.

#### Acceptance Criteria

1. THE HedgeBot class SHALL expose a public `tickOnce()` method that executes one iteration of the bot's state machine (equivalent to one call of the private `_tick()` method) and returns a Promise that resolves when the tick is complete.
2. THE BotInstance class SHALL expose a public `tickOnce()` method that executes one iteration of the bot's Watcher logic and returns a Promise that resolves when the tick is complete.
3. WHEN `tickOnce()` is called on a HedgeBot or BotInstance that is in `STOPPED` state, THE bot SHALL execute the tick logic without throwing a state-guard error; the BacktestRunner is responsible for managing the execution loop.
4. WHEN `tickOnce()` is called on a HedgeBot or BotInstance, THE bot SHALL use only the injected `ExchangeAdapter` instance for all exchange interactions; no direct exchange client calls SHALL be made outside of the adapter.
5. WHEN `tickOnce()` is called in backtest mode, THE bot SHALL NOT invoke `setTimeout`, `setInterval`, or any Promise-based sleep inside the tick body; all timing control SHALL be delegated to the BacktestRunner.
