# Requirements: Dynamic Position Sizing (Phase 2)

## Introduction

Phase 2 replaces APEX's static random-range position sizing with a multi-factor dynamic sizer. A new `PositionSizer` service combines signal confidence, recent trade performance, and session drawdown into a single risk-capped output size. `Watcher` delegates all sizing decisions to `PositionSizer` instead of the current inline formula. New `SIZING_*` config keys are added to `config.ts` and exposed through `ConfigStore` for live dashboard overrides.

---

## Glossary

- **PositionSizer**: The new pure-function service class (`src/modules/PositionSizer.ts`) responsible for computing order size in BTC.
- **SizingInput**: The input record passed to `PositionSizer.computeSize()`, containing confidence, recent PnLs, session PnL, balance, mode, and profile.
- **SizingResult**: The output record from `computeSize()`, containing the final size, individual multipliers, combined multiplier, and cap indicator.
- **confidenceMultiplier**: A multiplier derived from `signal.confidence` that scales size up for high-confidence signals.
- **performanceMultiplier**: A multiplier derived from recent win rate, session drawdown, and trading profile.
- **combinedMultiplier**: The weighted average of `confidenceMultiplier` and `performanceMultiplier`, clamped to `[SIZING_MIN_MULTIPLIER, SIZING_MAX_MULTIPLIER]`.
- **SIZING_CONF_WEIGHT**: Config weight for the confidence multiplier (default 0.6).
- **SIZING_PERF_WEIGHT**: Config weight for the performance multiplier (default 0.4); must sum to 1.0 with `SIZING_CONF_WEIGHT`.
- **SIZING_MIN_MULTIPLIER**: Floor multiplier applied to all computed multipliers (default 0.5).
- **SIZING_MAX_MULTIPLIER**: Ceiling multiplier applied to all computed multipliers (default 2.0).
- **SIZING_DRAWDOWN_THRESHOLD**: Session PnL (USD) below which sizing scales down (default -3.0).
- **SIZING_DRAWDOWN_FLOOR**: Multiplier floor when drawdown is severe (default 0.5).
- **SIZING_MAX_BTC**: Absolute maximum order size in BTC — hard cap enforced inside `PositionSizer` (default 0.008).
- **SIZING_MAX_BALANCE_PCT**: Maximum order value as a fraction of account balance — soft cap enforced by `Watcher` using `markPrice` (default 0.02).
- **Watcher**: The existing `src/modules/Watcher.ts` state machine that drives the trade loop.
- **ConfigStore**: The existing `src/config/ConfigStore.ts` singleton that manages live config overrides.
- **OverridableConfig**: The TypeScript type in `ConfigStore.ts` listing all keys that can be overridden via the dashboard.

---

## Requirements

### Requirement 1: PositionSizer Core Computation

**User Story:** As the trading bot, I want a dedicated `PositionSizer` service that computes order size from signal confidence and recent performance, so that sizing logic is testable in isolation and the trade loop stays clean.

#### Acceptance Criteria

1. THE `PositionSizer` SHALL expose a `computeSize(input: SizingInput): SizingResult` method that is a pure synchronous function with no I/O.
2. WHEN `computeSize` is called with a valid `SizingInput`, THE `PositionSizer` SHALL return a `SizingResult` where `size` is in `[config.ORDER_SIZE_MIN, config.SIZING_MAX_BTC]`.
3. WHEN `computeSize` is called with a valid `SizingInput`, THE `PositionSizer` SHALL return a `SizingResult` where `confidenceMultiplier`, `performanceMultiplier`, and `combinedMultiplier` are each in `[config.SIZING_MIN_MULTIPLIER, config.SIZING_MAX_MULTIPLIER]`.
4. THE `PositionSizer` SHALL compute `combinedMultiplier` as the weighted average `(confidenceMultiplier × SIZING_CONF_WEIGHT) + (performanceMultiplier × SIZING_PERF_WEIGHT)`, clamped to `[SIZING_MIN_MULTIPLIER, SIZING_MAX_MULTIPLIER]`.
5. THE `PositionSizer` SHALL compute `rawSize` as a uniform random value in `[ORDER_SIZE_MIN, ORDER_SIZE_MAX]` multiplied by `combinedMultiplier`.
6. THE `PositionSizer` SHALL apply the BTC hard cap: IF `rawSize > SIZING_MAX_BTC`, THEN THE `PositionSizer` SHALL set `size = SIZING_MAX_BTC` and `cappedBy = 'btc_cap'`.
7. THE `PositionSizer` SHALL enforce the floor: IF `rawSize < ORDER_SIZE_MIN`, THEN THE `PositionSizer` SHALL set `size = ORDER_SIZE_MIN`.
8. THE `SizingResult` returned by `computeSize` SHALL include `size`, `confidenceMultiplier`, `performanceMultiplier`, `combinedMultiplier`, and `cappedBy` fields.

---

### Requirement 2: Confidence Multiplier

**User Story:** As the trading bot, I want the order size to scale with signal confidence, so that high-confidence signals result in larger positions and low-confidence signals result in smaller ones.

#### Acceptance Criteria

1. WHEN `mode` is `'trade'` and `confidence >= MIN_CONFIDENCE`, THE `PositionSizer` SHALL compute `confidenceMultiplier` using a linear scale from 1.0 at `MIN_CONFIDENCE` to `SIZING_MAX_MULTIPLIER` at confidence 1.0.
2. WHEN `mode` is `'farm'`, THE `PositionSizer` SHALL compute `confidenceMultiplier` using a dampened linear scale: `1.0 + (confidence - 0.5) × 0.6`, so that farm sizing stays closer to the base size.
3. WHEN `mode` is `'trade'` and `confidence_a >= confidence_b`, THE `PositionSizer` SHALL produce `confidenceMultiplier(confidence_a) >= confidenceMultiplier(confidence_b)` (monotonically non-decreasing).
4. WHEN `mode` is `'farm'`, THE `PositionSizer` SHALL produce a `confidenceMultiplier` closer to 1.0 than the `'trade'` mode multiplier for the same `confidence` value (dampened scale).
5. THE `PositionSizer` SHALL clamp `confidenceMultiplier` to `[SIZING_MIN_MULTIPLIER, SIZING_MAX_MULTIPLIER]` after computation.

---

### Requirement 3: Performance Multiplier

**User Story:** As the trading bot, I want the order size to reflect recent trade performance and session drawdown, so that the bot sizes down during losing streaks and drawdowns and sizes up during winning streaks.

#### Acceptance Criteria

1. WHEN `recentPnLs` is empty AND `sessionPnl > SIZING_DRAWDOWN_THRESHOLD` AND `profile` is `'NORMAL'`, THE `PositionSizer` SHALL return `performanceMultiplier` equal to 1.0 (neutral — no history, no adjustment).
2. WHEN `recentPnLs` is non-empty, THE `PositionSizer` SHALL compute a win-rate component using a linear scale: 0% win rate → 0.7×, 50% → 1.0×, 100% → 1.3×.
3. WHEN `sessionPnl <= SIZING_DRAWDOWN_THRESHOLD`, THE `PositionSizer` SHALL compute a drawdown component less than 1.0, scaling down linearly as drawdown deepens, clamped to `SIZING_MIN_MULTIPLIER` at the floor.
4. WHEN `sessionPnl > SIZING_DRAWDOWN_THRESHOLD`, THE `PositionSizer` SHALL use a drawdown component of 1.0 (no penalty).
5. THE `PositionSizer` SHALL apply a profile bias: `SCALP → 0.85`, `NORMAL → 1.0`, `RUNNER → 1.15`, `DEGEN → 0.9`.
6. THE `PositionSizer` SHALL compute `performanceMultiplier` as `winRateComponent × drawdownComponent × profileBias`, clamped to `[SIZING_MIN_MULTIPLIER, SIZING_MAX_MULTIPLIER]`.
7. WHEN `recentPnLs` contains all positive values (all wins), THE `PositionSizer` SHALL produce a `performanceMultiplier` greater than or equal to the multiplier for all-negative `recentPnLs` with the same `sessionPnl` and `profile`.

---

### Requirement 4: Risk Caps

**User Story:** As the trading bot, I want hard and soft risk caps on order size, so that no single trade can exceed a safe fraction of the account balance or an absolute BTC ceiling regardless of multiplier values.

#### Acceptance Criteria

1. THE `PositionSizer` SHALL enforce a hard BTC cap: `size` SHALL never exceed `SIZING_MAX_BTC` in the returned `SizingResult`.
2. WHEN `rawSize > SIZING_MAX_BTC`, THE `SizingResult` SHALL set `cappedBy = 'btc_cap'`.
3. WHEN `rawSize <= SIZING_MAX_BTC`, THE `SizingResult` SHALL set `cappedBy = 'none'` (assuming no balance-% cap is applied inside `PositionSizer`).
4. AFTER receiving `SizingResult` from `PositionSizer`, THE `Watcher` SHALL apply the balance-% soft cap: IF `size > (balance × SIZING_MAX_BALANCE_PCT) / markPrice`, THEN THE `Watcher` SHALL reduce `size` to `max(ORDER_SIZE_MIN, (balance × SIZING_MAX_BALANCE_PCT) / markPrice)`.
5. THE `cappedBy` field in `SizingResult` SHALL accurately reflect whether the BTC hard cap was the binding constraint.

---

### Requirement 5: Config Keys and Defaults

**User Story:** As an operator, I want all sizing parameters to be configurable via the existing dashboard override system, so that I can tune sizing behaviour live without restarting the bot.

#### Acceptance Criteria

1. THE `config` object in `src/config.ts` SHALL include the following keys with the specified defaults: `SIZING_MIN_MULTIPLIER: 0.5`, `SIZING_MAX_MULTIPLIER: 2.0`, `SIZING_CONF_WEIGHT: 0.6`, `SIZING_PERF_WEIGHT: 0.4`, `SIZING_DRAWDOWN_THRESHOLD: -3.0`, `SIZING_DRAWDOWN_FLOOR: 0.5`, `SIZING_MAX_BTC: 0.008`, `SIZING_MAX_BALANCE_PCT: 0.02`.
2. THE `OverridableConfig` type in `ConfigStore.ts` SHALL include all eight `SIZING_*` keys so they can be patched via the dashboard API.
3. WHEN a `SIZING_*` override is applied via `ConfigStore.applyOverrides()`, THE `PositionSizer` SHALL use the updated values on the next `computeSize()` call (live propagation via the shared `config` object).

---

### Requirement 6: Config Validation

**User Story:** As an operator, I want the config validation system to reject invalid `SIZING_*` overrides, so that misconfigured weights or caps cannot cause runaway position sizes or broken arithmetic.

#### Acceptance Criteria

1. WHEN a config patch sets `SIZING_CONF_WEIGHT` and `SIZING_PERF_WEIGHT` such that their sum is not 1.0, THE `ConfigStore` SHALL reject the patch with a validation error: `"SIZING_CONF_WEIGHT + SIZING_PERF_WEIGHT must equal 1.0"`.
2. WHEN a config patch sets only one of `SIZING_CONF_WEIGHT` or `SIZING_PERF_WEIGHT` such that the effective sum is not 1.0, THE `ConfigStore` SHALL reject the patch with the same validation error.
3. WHEN a config patch sets `SIZING_MAX_BTC` to a value less than `ORDER_SIZE_MIN`, THE `ConfigStore` SHALL reject the patch with a validation error: `"SIZING_MAX_BTC must be >= ORDER_SIZE_MIN"`.
4. WHEN a config patch sets `SIZING_MIN_MULTIPLIER` to a value greater than or equal to `SIZING_MAX_MULTIPLIER`, THE `ConfigStore` SHALL reject the patch with a validation error.
5. WHEN a config patch sets any `SIZING_*` numeric key to a non-finite or non-numeric value, THE `ConfigStore` SHALL reject the patch with a validation error.
6. WHEN a config patch for `SIZING_*` keys passes all validation rules, THE `ConfigStore` SHALL apply the patch and persist it to disk.

---

### Requirement 7: Watcher Integration

**User Story:** As the trading bot, I want `Watcher` to delegate all position sizing to `PositionSizer`, so that the trade loop is clean and sizing is consistently applied in both farm and trade modes.

#### Acceptance Criteria

1. THE `Watcher` SHALL instantiate a `PositionSizer` and call `computeSize()` in the IDLE state instead of the current inline sizing block.
2. WHEN `Watcher` calls `computeSize()`, THE `Watcher` SHALL pass `signal.confidence`, `this.recentPnLs`, `this.sessionCurrentPnl`, `balance`, `config.MODE`, and `this.currentProfile` as the `SizingInput`.
3. AFTER receiving `SizingResult`, THE `Watcher` SHALL apply the balance-% soft cap using the already-available `markPrice` before passing `size` to `Executor.placeEntryOrder()`.
4. THE `Watcher` SHALL log the sizing details: `size`, `confidenceMultiplier`, `performanceMultiplier`, `combinedMultiplier`, and `cappedBy` to the console on each entry.
5. THE existing `Watcher` behaviour for all states other than the IDLE sizing block SHALL remain unchanged after the refactor.

---

### Requirement 8: Observability and Logging

**User Story:** As an operator, I want sizing metadata to be visible in trade logs and console output, so that I can audit why a particular size was chosen for each trade.

#### Acceptance Criteria

1. WHEN an entry order is placed, THE `Watcher` SHALL log a console message containing `size`, `confMult`, `perfMult`, `combined`, and `cappedBy` values.
2. WHERE the `TradeRecord` schema is extended, THE `TradeLogger` SHALL optionally include `sizingResult` fields (`confidenceMultiplier`, `performanceMultiplier`, `combinedMultiplier`, `cappedBy`) in the logged trade record for dashboard analytics.
