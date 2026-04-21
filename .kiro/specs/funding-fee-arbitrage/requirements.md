# Requirements Document

## Introduction

Tính năng **Funding Fee Arbitrage (Cross-Exchange)** cho phép người dùng cấu hình và chạy một bot chiến lược ăn chênh lệch phí Funding giữa hai sàn giao dịch khác nhau (trong số SoDEX, Decibel, Dango) trên cùng cặp BTC/USDT. Bot mở đồng thời một lệnh SHORT trên sàn có Funding Rate cao (dương) và một lệnh LONG trên sàn có Funding Rate thấp/âm, đảm bảo `Size_Long = Size_Short` để triệt tiêu rủi ro biến động giá. Lợi nhuận ròng đến từ chênh lệch phí Funding thu được sau khi trừ phí giao dịch. Bot tích hợp vào hệ thống `BotManager` / `BotInstance` hiện có, hiển thị trên dashboard, và tự động tái cân bằng khi margin bị thiếu.

---

## Glossary

- **Arbitrage_Bot**: Instance bot thực hiện chiến lược Funding Fee Arbitrage cross-exchange.
- **Exchange_A**: Sàn giao dịch đầu tiên được chọn khi cấu hình bot (một trong: `sodex`, `decibel`, `dango`).
- **Exchange_B**: Sàn giao dịch thứ hai được chọn khi cấu hình bot, khác với Exchange_A.
- **Funding_Rate**: Tỷ lệ phí định kỳ (thường mỗi 8 giờ) mà bên Long trả cho bên Short (khi dương) hoặc ngược lại (khi âm), tính theo % giá trị vị thế.
- **Funding_Rate_Spread**: Chênh lệch tuyệt đối giữa Funding Rate của Exchange_A và Exchange_B: `|FR_A - FR_B|`.
- **Leg_A**: Vị thế được mở trên Exchange_A (SHORT nếu FR_A > FR_B, LONG nếu FR_A < FR_B).
- **Leg_B**: Vị thế được mở trên Exchange_B, đối xứng với Leg_A.
- **Net_Profit**: Lợi nhuận ròng sau một chu kỳ: `(Funding_Received - Funding_Paid) - Total_Trading_Fees`.
- **Margin_Ratio**: Tỷ lệ margin còn lại so với margin ban đầu của một leg, dùng để phát hiện nguy cơ thanh lý.
- **Rebalance**: Hành động tự động điều chỉnh vị thế hoặc chuyển tài sản khi Margin_Ratio của một leg xuống dưới ngưỡng an toàn.
- **Min_Spread_Threshold**: Ngưỡng Funding_Rate_Spread tối thiểu (tính bằng bps) để bot quyết định vào lệnh.
- **FundingArbConfig**: Cấu hình đặc thù của Arbitrage_Bot, lưu trong `bot-configs.json`.
- **FundingArbState**: Trạng thái runtime của Arbitrage_Bot (IDLE, SCANNING, ENTERING, ACTIVE, REBALANCING, CLOSING, COOLDOWN).
- **ExchangeAdapter**: Interface `src/adapters/ExchangeAdapter.ts` đã có, cung cấp `get_mark_price`, `place_limit_order`, `get_position`, `get_balance`, v.v.
- **BotManager**: Class `src/bot/BotManager.ts` quản lý registry các bot instance.
- **Dashboard**: Giao diện web tại `src/dashboard/server.ts` hiển thị trạng thái và số liệu bot.

---

## Requirements

### Requirement 1: Cấu hình Bot Arbitrage

**User Story:** As a trader, I want to configure a Funding Fee Arbitrage bot by selecting two exchanges and setting position parameters, so that the bot knows which exchanges to monitor and how large to size each leg.

#### Acceptance Criteria

1. THE `FundingArbConfig` SHALL contain the following required fields: `id`, `name`, `botType` (value: `"funding-arb"`), `exchangeA`, `exchangeB`, `symbol`, `legValueUsd`, `minSpreadBps`, `marginSafetyRatio`, `credentialKeyA`, `credentialKeyB`, `tradeLogPath`, `autoStart`, `tags`.
2. WHEN a `FundingArbConfig` is loaded, THE `Config_Validator` SHALL reject any config where `exchangeA === exchangeB` and return a descriptive error message.
3. WHEN a `FundingArbConfig` is loaded, THE `Config_Validator` SHALL reject any config where `legValueUsd <= 0` and return a descriptive error message.
4. WHEN a `FundingArbConfig` is loaded, THE `Config_Validator` SHALL reject any config where `minSpreadBps < 0` and return a descriptive error message.
5. WHEN a `FundingArbConfig` is loaded, THE `Config_Validator` SHALL reject any config where `marginSafetyRatio` is not in the range `(0, 1)` and return a descriptive error message.
6. THE `loadBotConfigs` function SHALL parse and validate `FundingArbConfig` entries from `bot-configs.json` alongside existing `BotConfig` and `HedgeBotConfig` entries.
7. WHERE `autoStart` is `true`, THE `BotManager` SHALL automatically start the Arbitrage_Bot after loading configs.

---

### Requirement 2: Quét và So sánh Funding Rate

**User Story:** As a trader, I want the bot to continuously scan and compare Funding Rates between the two selected exchanges, so that it can identify profitable arbitrage opportunities.

#### Acceptance Criteria

1. THE `Arbitrage_Bot` SHALL fetch the current Funding Rate for the configured `symbol` from both Exchange_A and Exchange_B at each scan cycle.
2. WHEN a Funding Rate fetch fails on either exchange, THE `Arbitrage_Bot` SHALL log the error, skip the current scan cycle, and retry on the next cycle without entering a position.
3. THE `Arbitrage_Bot` SHALL compute `Funding_Rate_Spread = |FR_A - FR_B|` after each successful fetch.
4. WHEN `Funding_Rate_Spread >= minSpreadBps / 10000`, THE `Arbitrage_Bot` SHALL transition from `SCANNING` to `ENTERING` state.
5. WHILE in `SCANNING` state, THE `Arbitrage_Bot` SHALL NOT place any orders.
6. THE `Arbitrage_Bot` SHALL expose the latest `FR_A`, `FR_B`, and `Funding_Rate_Spread` values in its runtime state for dashboard consumption.
7. THE `Funding_Rate_Fetcher` SHALL support fetching Funding Rate from all three adapters: `SodexAdapter`, `DecibelAdapter`, `DangoAdapter` via a unified `getFundingRate(symbol): Promise<number>` method.

---

### Requirement 3: Mở Vị thế Đối xứng (Entry Logic)

**User Story:** As a trader, I want the bot to open perfectly balanced long and short positions simultaneously on both exchanges, so that price movements are fully hedged.

#### Acceptance Criteria

1. WHEN transitioning to `ENTERING` state, THE `Arbitrage_Bot` SHALL determine: open SHORT on the exchange with higher Funding Rate, open LONG on the exchange with lower Funding Rate.
2. THE `Arbitrage_Bot` SHALL place both legs with identical `size` (in BTC), computed as `size = legValueUsd / markPrice`, rounded to the exchange's minimum lot size.
3. WHEN placing entry orders, THE `Arbitrage_Bot` SHALL use limit orders (Post-Only / maker) on both exchanges to minimize trading fees.
4. WHEN both legs are confirmed filled, THE `Arbitrage_Bot` SHALL transition to `ACTIVE` state and record `entryTime`, `entryPriceA`, `entryPriceB`, `sizeA`, `sizeB`.
5. IF one leg fills but the other fails to fill within `entryTimeoutSecs`, THEN THE `Arbitrage_Bot` SHALL cancel the pending leg, close the filled leg with an IOC order, and transition back to `SCANNING` state.
6. THE `Arbitrage_Bot` SHALL verify `|sizeA - sizeB| / max(sizeA, sizeB) < 0.01` (within 1% size imbalance) before transitioning to `ACTIVE`; IF the check fails, THEN THE `Arbitrage_Bot` SHALL close both legs and log a size mismatch error.
7. WHILE in `ENTERING` state, THE `Arbitrage_Bot` SHALL NOT evaluate new spread signals.

---

### Requirement 4: Tính toán Lợi nhuận Ròng

**User Story:** As a trader, I want the bot to accurately calculate net profit from funding fees minus trading fees, so that I can evaluate the strategy's performance.

#### Acceptance Criteria

1. THE `Profit_Calculator` SHALL compute `Net_Profit = (Funding_Received - Funding_Paid) - Total_Trading_Fees` after each funding settlement event.
2. THE `Profit_Calculator` SHALL compute `Funding_Received` as `|FR_high| * legValueUsd` for the SHORT leg on the high-rate exchange.
3. THE `Profit_Calculator` SHALL compute `Funding_Paid` as `|FR_low| * legValueUsd` for the LONG leg on the low-rate exchange (zero if FR_low is negative, meaning LONG also receives).
4. THE `Profit_Calculator` SHALL compute `Total_Trading_Fees` as `(entryFeeA + exitFeeA + entryFeeB + exitFeeB)`, where each fee = `size * price * feeRateMaker`.
5. THE `Arbitrage_Bot` SHALL accumulate `sessionNetProfit`, `sessionFundingReceived`, `sessionFundingPaid`, and `sessionTradingFees` across all completed cycles in the current session.
6. WHEN a funding settlement occurs, THE `Arbitrage_Bot` SHALL update `sessionNetProfit` and emit a log event with the settlement details.
7. FOR ALL valid `legValueUsd` and fee rate inputs, THE `Profit_Calculator` SHALL produce `Net_Profit` values where `Net_Profit = Funding_Received - Funding_Paid - Total_Trading_Fees` (round-trip calculation property).

---

### Requirement 5: Tự động Tái cân bằng (Auto-Rebalance)

**User Story:** As a trader, I want the bot to automatically rebalance positions when margin becomes insufficient on either exchange, so that liquidation is avoided.

#### Acceptance Criteria

1. WHILE in `ACTIVE` state, THE `Arbitrage_Bot` SHALL monitor `Margin_Ratio` for both legs at each tick, where `Margin_Ratio = current_margin / initial_margin`.
2. WHEN `Margin_Ratio` of either leg falls below `marginSafetyRatio`, THE `Arbitrage_Bot` SHALL transition to `REBALANCING` state.
3. WHEN entering `REBALANCING` state, THE `Arbitrage_Bot` SHALL send a Telegram alert with the affected exchange name, current margin ratio, and threshold.
4. WHILE in `REBALANCING` state, THE `Arbitrage_Bot` SHALL attempt to reduce the position size on the leg with excess margin to restore balance, using IOC orders.
5. IF reducing position size is insufficient to restore `Margin_Ratio >= marginSafetyRatio` within `rebalanceTimeoutSecs`, THEN THE `Arbitrage_Bot` SHALL close both legs entirely and transition to `COOLDOWN` state.
6. WHEN rebalancing completes successfully, THE `Arbitrage_Bot` SHALL transition back to `ACTIVE` state and log the rebalance event with before/after margin ratios.
7. THE `Arbitrage_Bot` SHALL record all rebalance events (timestamp, exchange, trigger ratio, action taken, result) in the trade log.

---

### Requirement 6: Đóng Vị thế và Cooldown

**User Story:** As a trader, I want the bot to close both legs cleanly and enter a cooldown period after each cycle, so that positions are never left open unintentionally.

#### Acceptance Criteria

1. WHEN the user manually triggers a stop via the dashboard or API, THE `Arbitrage_Bot` SHALL transition to `CLOSING` state and close both legs with IOC orders.
2. WHEN both legs are confirmed closed, THE `Arbitrage_Bot` SHALL transition to `COOLDOWN` state for a configurable `cooldownSecs` duration.
3. IF closing one leg fails within `closeTimeoutSecs`, THEN THE `Arbitrage_Bot` SHALL retry the close up to 3 times before logging a critical error and halting.
4. WHEN transitioning to `COOLDOWN`, THE `Arbitrage_Bot` SHALL log the final `Net_Profit`, `sessionFundingReceived`, `sessionFundingPaid`, and `sessionTradingFees` for the completed cycle.
5. WHEN `cooldownSecs` expires, THE `Arbitrage_Bot` SHALL transition back to `SCANNING` state automatically.
6. WHILE in `CLOSING` or `COOLDOWN` state, THE `Arbitrage_Bot` SHALL NOT place any new orders.

---

### Requirement 7: Dashboard và Monitoring

**User Story:** As a trader, I want a real-time dashboard view showing Funding Rates, position status, and net profit for the arbitrage bot, so that I can monitor performance at a glance.

#### Acceptance Criteria

1. THE `Dashboard` SHALL display the following data for each Arbitrage_Bot: current state (`FundingArbState`), `FR_A`, `FR_B`, `Funding_Rate_Spread`, `Leg_A` position details, `Leg_B` position details, `sessionNetProfit`, `sessionFundingReceived`, `sessionFundingPaid`, `sessionTradingFees`.
2. WHEN the Arbitrage_Bot is in `ACTIVE` state, THE `Dashboard` SHALL display unrealized PnL for each leg updated at each tick.
3. THE `Dashboard` SHALL refresh Funding Rate data at most every 10 seconds to avoid excessive API calls.
4. WHEN `Funding_Rate_Spread` exceeds `minSpreadBps * 2`, THE `Dashboard` SHALL highlight the spread value visually (e.g., green color indicator).
5. THE `Dashboard` API endpoint `/api/bots/:id/status` SHALL return all Arbitrage_Bot fields in addition to the existing `BotStatus` fields, using a discriminated union on `botType`.
6. THE `Dashboard` SHALL display a start/stop control button for each Arbitrage_Bot consistent with existing bot controls.

---

### Requirement 8: Tích hợp với BotManager và Config System

**User Story:** As a developer, I want the Arbitrage Bot to integrate seamlessly with the existing BotManager, loadBotConfigs, and dashboard server, so that no existing functionality is broken.

#### Acceptance Criteria

1. THE `BotManager` SHALL support creating `FundingArbBot` instances via a `createFundingArbBot(config, adapterA, adapterB, telegram)` method alongside existing `createBot` and `createHedgeBot` methods.
2. THE `BotManager.getAllBots()` SHALL return `FundingArbBot` instances alongside `BotInstance` and `HedgeBot` instances.
3. THE `BotManager.getAggregatedStats()` SHALL include `sessionNetProfit` from all `FundingArbBot` instances in `totalPnl`.
4. THE `loadBotConfigs` function SHALL parse `FundingArbConfig` entries (identified by `botType === "funding-arb"`) without breaking parsing of existing `BotConfig` and `HedgeBotConfig` entries.
5. THE `adapterFactory` SHALL instantiate two separate adapter instances (one per exchange) for each `FundingArbConfig`, using `credentialKeyA` and `credentialKeyB` to resolve environment variable prefixes.
6. WHEN the dashboard server starts, THE `Server` SHALL initialize `FundingArbBot` instances from config alongside existing bot types without requiring code changes to the main startup sequence beyond the factory registration.
7. THE `FundingArbBot` SHALL implement a common `IBotInstance` interface (or duck-type compatible with `BotInstance` and `HedgeBot`) exposing `state`, `start()`, `stop()`, and `getStatus()`.

---

### Requirement 9: Logging và Telegram Notifications

**User Story:** As a trader, I want to receive Telegram notifications for key arbitrage events and have all trades logged, so that I have full visibility into bot activity.

#### Acceptance Criteria

1. WHEN the Arbitrage_Bot enters `ENTERING` state, THE `Telegram_Notifier` SHALL send a message including: exchange pair, symbol, spread in bps, and planned leg sizes.
2. WHEN both legs are filled, THE `Telegram_Notifier` SHALL send a confirmation message with fill prices for both legs.
3. WHEN a rebalance is triggered, THE `Telegram_Notifier` SHALL send an alert with the affected exchange and current margin ratio.
4. WHEN a cycle completes (both legs closed), THE `Telegram_Notifier` SHALL send a summary message with `Net_Profit`, `sessionFundingReceived`, `sessionFundingPaid`, and `sessionTradingFees`.
5. THE `Trade_Logger` SHALL record each completed arbitrage cycle as a structured log entry containing: `cycleId`, `exchangeA`, `exchangeB`, `symbol`, `entryTime`, `exitTime`, `sizeA`, `sizeB`, `entryPriceA`, `entryPriceB`, `exitPriceA`, `exitPriceB`, `fundingReceived`, `fundingPaid`, `tradingFees`, `netProfit`.
6. IF a critical error occurs (e.g., failed close after 3 retries), THEN THE `Telegram_Notifier` SHALL send a critical alert and THE `Trade_Logger` SHALL record the error with full context.
