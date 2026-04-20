# Requirements Document

## Introduction

The Correlation Hedging Bot is a new bot type that trades two correlated assets (BTC and ETH) simultaneously on the same exchange in opposite directions. The goal is to achieve delta-neutral or divergence-capture positions: one leg goes long while the other goes short, with equal USD value on each side. Entry is triggered by a volume spike on both assets, direction is determined by the AI signal engine (which asset is relatively stronger), and both positions are always opened and closed atomically as a pair.

This bot is a distinct type from the existing single-pair farm/trade bot. It integrates with the existing `BotManager`, `BotInstance` lifecycle, `ExchangeAdapter` interface, and `bot-configs.json` configuration system. The design must not block a future cross-exchange mode (BTC on one exchange, ETH on another).

---

## Glossary

- **HedgeBot**: The Correlation Hedging Bot instance — the new bot type defined in this spec.
- **Leg**: One side of the hedge pair. Each trade cycle has exactly two legs: a long leg and a short leg.
- **LongLeg**: The leg that opens a long (buy) position.
- **ShortLeg**: The leg that opens a short (sell) position.
- **LegPair**: The atomic unit of a HedgeBot trade — a LongLeg and a ShortLeg opened and closed together.
- **LegValue**: The USD notional value of a single leg (size × entry price).
- **CombinedPnL**: The sum of unrealized or realized PnL across both legs of the active LegPair.
- **VolumeMonitor**: The component that tracks real-time volume for both BTC and ETH and detects spikes.
- **RollingAverage**: The rolling mean of recent volume samples used as the baseline for spike detection.
- **VolumeSpike**: A condition where the current volume of an asset exceeds its RollingAverage by a configurable multiplier threshold.
- **CorrelationSignal**: The output of the AI signal engine that identifies which asset (BTC or ETH) is relatively stronger, used to determine leg direction.
- **FundingRate**: The periodic payment rate between long and short holders on a perpetual futures market.
- **EquilibriumSpread**: The historical mean of the BTC/ETH price ratio, used as the mean-reversion exit target.
- **HoldingPeriod**: The maximum time (in seconds) a LegPair may remain open before a time-based exit is triggered.
- **ProfitTarget**: The CombinedPnL threshold (in USD) at which the HedgeBot exits the LegPair with a profit.
- **MaxLoss**: The CombinedPnL threshold (negative USD) at which the HedgeBot exits the LegPair to limit losses.
- **AtomicClose**: The operation of closing both legs of a LegPair in the same logical action, regardless of individual leg PnL.
- **HedgeBotConfig**: The configuration block for a HedgeBot entry in `bot-configs.json`, extending the base bot config schema.
- **BotManager**: The existing registry that creates, starts, stops, and tracks all bot instances.
- **ExchangeAdapter**: The existing interface (`src/adapters/ExchangeAdapter.ts`) used to interact with SoDEX, Decibel, or Dango.
- **AISignalEngine**: The existing signal engine (`src/ai/AISignalEngine.ts`) that produces directional signals with confidence scores.

---

## Requirements

### Requirement 1: HedgeBot Configuration

**User Story:** As a user, I want to configure a Correlation Hedging Bot with two symbols and a single exchange, so that the bot knows which assets to trade and where.

#### Acceptance Criteria

1. THE `HedgeBotConfig` SHALL extend the base bot configuration schema with the following fields: `botType: "hedge"`, `symbolA` (string, e.g. `"BTC-USD"`), `symbolB` (string, e.g. `"ETH-USD"`), `exchange` (one of `"sodex"`, `"decibel"`, `"dango"`), `legValueUsd` (number, the USD notional per leg), `holdingPeriodSecs` (number), `profitTargetUsd` (number), `maxLossUsd` (number), `volumeSpikeMultiplier` (number), `volumeRollingWindow` (number, count of samples), and `fundingRateWeight` (number, 0–1).
2. THE `HedgeBotConfig` SHALL store `symbolA` and `symbolB` as separate fields so that a future cross-exchange mode can assign each symbol to a different adapter without changing the config schema.
3. WHEN a `HedgeBotConfig` entry is loaded from `bot-configs.json`, THE `BotManager` SHALL instantiate a `HedgeBot` instance instead of a standard `BotInstance`.
4. IF a `HedgeBotConfig` entry is missing any required field (`botType`, `symbolA`, `symbolB`, `exchange`, `legValueUsd`, `holdingPeriodSecs`, `profitTargetUsd`, `maxLossUsd`), THEN THE config loader SHALL throw a descriptive validation error identifying the missing field.
5. THE `HedgeBotConfig` SHALL be storable in and loadable from `bot-configs.json` using the same `loadBotConfigs` / `persistBotConfigs` utilities used by existing bots.

---

### Requirement 2: HedgeBot Lifecycle Integration

**User Story:** As a user, I want the HedgeBot to appear in the dashboard and be controllable (start/stop) through the existing BotManager, so that I can manage it alongside my other bots.

#### Acceptance Criteria

1. THE `HedgeBot` SHALL implement the same start/stop lifecycle interface as `BotInstance` so that `BotManager.startBot(id)` and `BotManager.stopBot(id)` work without modification.
2. THE `HedgeBot` SHALL expose a `getStatus()` method returning a `BotStatus`-compatible object that includes `id`, `name`, `exchange`, `status`, `tags`, `sessionPnl`, `sessionVolume`, `uptime`, and a `hedgePosition` field describing the active LegPair (or `null` if flat).
3. WHEN the `HedgeBot` is stopped while a LegPair is open, THE `HedgeBot` SHALL NOT automatically close the open positions — it SHALL log a warning that positions remain open.
4. THE `BotManager` SHALL include `HedgeBot` instances in `getAggregatedStats()` totals for `totalPnl`, `totalVolume`, and `activeBotCount`.
5. THE `HedgeBot` SHALL register with the existing `BotManager` registry under its configured `id`, so that dashboard API routes that iterate `getAllBots()` return it without modification.

---

### Requirement 3: Volume Spike Detection

**User Story:** As a user, I want the bot to enter only when both BTC and ETH show a volume spike simultaneously, so that entries are made during periods of genuine market activity.

#### Acceptance Criteria

1. THE `VolumeMonitor` SHALL maintain a separate rolling window of recent volume samples for `symbolA` and `symbolB`, each of length `volumeRollingWindow` (from config).
2. WHEN a new volume sample is received for a symbol, THE `VolumeMonitor` SHALL update that symbol's rolling window by appending the new sample and discarding the oldest if the window is full.
3. THE `VolumeMonitor` SHALL compute a `VolumeSpike` for a symbol as: `currentVolume > RollingAverage × volumeSpikeMultiplier`.
4. THE `VolumeMonitor` SHALL signal an entry opportunity ONLY WHEN a `VolumeSpike` is detected for BOTH `symbolA` AND `symbolB` in the same evaluation tick.
5. IF the rolling window for either symbol contains fewer samples than `volumeRollingWindow`, THEN THE `VolumeMonitor` SHALL NOT signal an entry opportunity (insufficient baseline data).
6. THE `VolumeMonitor` SHALL source volume data from `ExchangeAdapter.get_recent_trades(symbol, limit)` by summing trade sizes within the most recent sampling interval.

---

### Requirement 4: AI-Driven Direction Selection

**User Story:** As a user, I want the bot to use the AI signal engine to determine which asset is stronger, so that the long leg is placed on the stronger asset and the short leg on the weaker one.

#### Acceptance Criteria

1. WHEN a volume spike entry opportunity is detected, THE `HedgeBot` SHALL call `AISignalEngine.getSignal(symbolA)` and `AISignalEngine.getSignal(symbolB)` in parallel.
2. THE `HedgeBot` SHALL compare the `score` field of both signals: the symbol with the higher `score` SHALL be assigned the LongLeg; the symbol with the lower `score` SHALL be assigned the ShortLeg.
3. WHERE `fundingRateWeight` is greater than 0, THE `HedgeBot` SHALL fetch the funding rate for both symbols and apply a weighted adjustment to each signal score before direction comparison: `adjustedScore = score + fundingRate × fundingRateWeight`.
4. IF both signals return `direction: "skip"` or both `score` values are equal (within 0.001), THEN THE `HedgeBot` SHALL skip the entry opportunity and log the reason.
5. IF either `AISignalEngine.getSignal()` call throws an error, THEN THE `HedgeBot` SHALL skip the entry opportunity and log the error without crashing.

---

### Requirement 5: Atomic Leg Opening

**User Story:** As a user, I want both legs to open simultaneously with equal USD value, so that the position is delta-neutral from the moment of entry.

#### Acceptance Criteria

1. WHEN an entry is triggered, THE `HedgeBot` SHALL compute the size of each leg as: `size = legValueUsd / markPrice` for each symbol, using the current mark price fetched immediately before order placement.
2. THE `HedgeBot` SHALL place the LongLeg order and the ShortLeg order as close in time as possible — both placement calls SHALL be issued in the same async batch (e.g. `Promise.all`).
3. THE `LegValue` of the LongLeg and the `LegValue` of the ShortLeg SHALL be equal within a tolerance of ±1% of `legValueUsd` at the time of order placement.
4. IF either leg order placement fails (exchange error or rejection), THEN THE `HedgeBot` SHALL attempt to cancel the successfully placed leg order and SHALL transition to an error state, logging the failure. THE `HedgeBot` SHALL NOT leave a single open leg without attempting cancellation.
5. WHEN both leg orders are confirmed filled, THE `HedgeBot` SHALL record the `LegPair` as active with entry prices, sizes, and timestamps for both legs.
6. THE `HedgeBot` SHALL use the existing `ExchangeAdapter.place_limit_order` interface for all order placement, ensuring compatibility with SoDEX, Decibel, and Dango adapters.

---

### Requirement 6: Exit Conditions

**User Story:** As a user, I want the bot to exit both positions together when any of the defined exit conditions are met, so that the hedge is always unwound atomically.

#### Acceptance Criteria

1. THE `HedgeBot` SHALL evaluate exit conditions on every monitoring tick while a LegPair is active.
2. WHEN the elapsed time since LegPair entry exceeds `holdingPeriodSecs`, THE `HedgeBot` SHALL trigger an AtomicClose with exit reason `"TIME_EXPIRY"`.
3. WHEN `CombinedPnL` of the active LegPair reaches or exceeds `profitTargetUsd`, THE `HedgeBot` SHALL trigger an AtomicClose with exit reason `"PROFIT_TARGET"`.
4. WHEN `CombinedPnL` of the active LegPair reaches or falls below `-maxLossUsd`, THE `HedgeBot` SHALL trigger an AtomicClose with exit reason `"MAX_LOSS"`.
5. WHEN the current BTC/ETH price ratio returns to within 0.5% of the `EquilibriumSpread` (rolling mean of the ratio over the last `volumeRollingWindow` samples), THE `HedgeBot` SHALL trigger an AtomicClose with exit reason `"MEAN_REVERSION"`.
6. THE `HedgeBot` SHALL evaluate exit conditions in priority order: `MAX_LOSS` → `PROFIT_TARGET` → `MEAN_REVERSION` → `TIME_EXPIRY`.

---

### Requirement 7: Atomic Close Execution

**User Story:** As a user, I want both legs to always close together regardless of individual leg PnL, so that I am never left with a one-sided open position.

#### Acceptance Criteria

1. WHEN an AtomicClose is triggered, THE `HedgeBot` SHALL place close orders for BOTH legs — the close orders SHALL be issued in the same async batch (`Promise.all`).
2. THE `HedgeBot` SHALL close each leg using `ExchangeAdapter.place_limit_order` with `reduceOnly: true` to ensure the close order cannot open a new position.
3. IF a close order for one leg fails, THEN THE `HedgeBot` SHALL retry the failed close order up to 3 times with exponential backoff before logging a critical error.
4. THE `HedgeBot` SHALL NOT consider the AtomicClose complete until BOTH legs report a flat position (size = 0) as confirmed by `ExchangeAdapter.get_position`.
5. WHEN the AtomicClose is confirmed complete, THE `HedgeBot` SHALL record the trade result including: exit reason, CombinedPnL, individual leg PnL, hold duration, and entry/exit prices for both legs.
6. THE `HedgeBot` SHALL apply a configurable cooldown period after each AtomicClose before evaluating the next entry opportunity.

---

### Requirement 8: Position Value Equality Invariant

**User Story:** As a user, I want the system to enforce that both legs always have equal USD value, so that the position remains delta-neutral.

#### Acceptance Criteria

1. THE `HedgeBot` SHALL verify that `|LegValue_A - LegValue_B| / legValueUsd ≤ 0.01` (within 1%) immediately after both legs are filled, using actual fill prices.
2. IF the filled leg values differ by more than 1%, THEN THE `HedgeBot` SHALL log a warning with the actual values and the deviation percentage. THE `HedgeBot` SHALL continue managing the position (not abort) but SHALL record the imbalance in the trade log.
3. THE `HedgeBot` SHALL compute `CombinedPnL` as the arithmetic sum of `unrealizedPnl` from both legs, fetched via `ExchangeAdapter.get_position` on each monitoring tick.
4. FOR ALL active LegPairs, the `CombinedPnL` computed from individual leg PnL values SHALL equal the sum of `(currentPrice - entryPrice) × size × direction_multiplier` for each leg within floating-point precision.

---

### Requirement 9: Trade Logging and Observability

**User Story:** As a user, I want each hedge trade cycle to be logged with full detail, so that I can review performance and debug issues.

#### Acceptance Criteria

1. THE `HedgeBot` SHALL log each completed trade cycle to the configured `tradeLogPath` using the existing `TradeLogger` infrastructure.
2. WHEN a trade cycle completes, THE `HedgeBot` SHALL write a log entry containing: `botId`, `exchange`, `symbolA`, `symbolB`, `legValueUsd`, `entryPriceA`, `entryPriceB`, `exitPriceA`, `exitPriceB`, `pnlA`, `pnlB`, `combinedPnl`, `holdDurationSecs`, `exitReason`, `entryTimestamp`, and `exitTimestamp`.
3. THE `HedgeBot` SHALL emit structured log messages (using the existing `logEvent` pattern) for the following events: entry triggered, both legs filled, exit triggered, AtomicClose confirmed, and any error during leg placement or close.
4. THE `HedgeBot` SHALL update `sessionPnl` and `sessionVolume` in its shared state after each completed trade cycle so that the dashboard reflects current session statistics.

---

### Requirement 10: Exchange Adapter Compatibility

**User Story:** As a user, I want the HedgeBot to work identically on SoDEX, Decibel, and Dango, so that I can choose any supported exchange without special handling.

#### Acceptance Criteria

1. THE `HedgeBot` SHALL interact with all exchanges exclusively through the `ExchangeAdapter` interface, using no exchange-specific APIs or adapter internals.
2. THE `HedgeBot` SHALL support `symbolA` and `symbolB` in the symbol format required by the configured exchange (e.g. `"BTC-USD"` for SoDEX/Dango, `"BTC/USD"` for Decibel) — the symbol format SHALL be specified in `HedgeBotConfig` and passed directly to adapter calls.
3. WHEN the `HedgeBot` is configured with `exchange: "decibel"`, THE `HedgeBot` SHALL function identically to SoDEX and Dango configurations — no Decibel-specific code paths SHALL exist in the HedgeBot logic layer.
4. THE `HedgeBot` SHALL call `ExchangeAdapter.get_balance()` once per monitoring tick to track available balance, using the same pattern as the existing `Watcher`.
