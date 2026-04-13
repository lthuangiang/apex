# Requirements Document

## Introduction

Farm Market Making (Phase 6) evolves APEX's FARM mode from a simple directional scalper into a pseudo market-maker. Three interlocking subsystems are introduced: **Ping-Pong** (alternate sides after each exit to capture the spread on each leg), **Inventory Control** (track cumulative net USD exposure and soft-bias or hard-block entries that deepen a one-sided book), and **Micro-Spread TP** (replace the fixed `FARM_TP_USD` with a dynamic formula tied to the live spread). A new `MarketMaker` class encapsulates all three subsystems. The existing Watcher state machine, ExecutionEdge, and PositionSizer are extended — no existing exit paths are removed.

## Glossary

- **MarketMaker**: New class in `src/modules/MarketMaker.ts` that encapsulates ping-pong bias, inventory control, and dynamic TP computation.
- **MMState**: In-memory session state tracked by MarketMaker — `cumLongUsd`, `cumShortUsd`, `lastExitSide`, `tradeCount`.
- **MMEntryBias**: Return value of `computeEntryBias()` — contains `biasedDirection`, `pingPongBias`, `inventoryBias`, `blocked`, `blockReason`, `netExposureUsd`.
- **Ping-Pong**: Strategy of biasing the next entry toward the opposite side of the last exit to alternate long/short around mid-price.
- **Inventory Control**: Mechanism that tracks net USD exposure (`cumLongUsd − cumShortUsd`) and applies soft bias or hard block to prevent excessive one-sided exposure.
- **Dynamic TP**: Profit target computed as `max(spreadBps × MM_SPREAD_MULT × entryPrice / 10000, feeRoundTrip × MM_MIN_FEE_MULT)`, capped at `MM_TP_MAX_USD`.
- **netExposureUsd**: `cumLongUsd − cumShortUsd` — positive means net long, negative means net short.
- **Watcher**: Existing state machine (`IDLE → PENDING_ENTRY → IN_POSITION → PENDING_EXIT → IDLE`) in `src/modules/Watcher.ts`.
- **ExecutionEdge**: Existing module that computes spread and entry offset; its `_pendingEntrySpreadBps` value is reused for dynamic TP.
- **TradeRecord**: Existing interface in `src/ai/TradeLogger.ts` extended with MM metadata fields.
- **ConfigStore**: Existing runtime config store in `src/config/ConfigStore.ts`; extended with MM_* keys.
- **validateOverrides**: Existing validation function in `src/config/validateOverrides.ts`; extended with MM config cross-field rules.

---

## Requirements

### Requirement 1: MarketMaker Module

**User Story:** As a developer, I want a self-contained `MarketMaker` class, so that all pseudo market-making logic is independently testable and the Watcher remains thin.

#### Acceptance Criteria

1. THE MarketMaker SHALL expose a `computeEntryBias(lastTradeContext, inventoryState): MMEntryBias` method that is a pure function given its inputs (no I/O).
2. THE MarketMaker SHALL expose a `computeDynamicTP(entryPrice: number, spreadBps: number): number` method that is a pure function given its inputs.
3. THE MarketMaker SHALL expose a `recordTrade(side: 'long' | 'short', volumeUsd: number): void` method that mutates internal `MMState`.
4. THE MarketMaker SHALL expose a `getState(): MMState` method that returns the current session state.
5. THE MarketMaker SHALL expose a `reset(): void` method that sets `cumLongUsd = 0`, `cumShortUsd = 0`, `lastExitSide = null`, and `tradeCount = 0`.
6. WHEN `reset()` is called, THE MarketMaker SHALL restore all MMState fields to their initial zero/null values.

---

### Requirement 2: Inventory Hard Block

**User Story:** As a risk manager, I want entries to be hard-blocked when net USD exposure is too one-sided, so that the bot cannot accumulate runaway directional risk.

#### Acceptance Criteria

1. WHEN `|cumLongUsd − cumShortUsd| > MM_INVENTORY_HARD_BLOCK`, THE MarketMaker SHALL return `blocked = true` from `computeEntryBias()` regardless of `lastTradeContext`.
2. WHEN `netExposureUsd > MM_INVENTORY_HARD_BLOCK`, THE MarketMaker SHALL set `blockReason = 'inventory_long'` in the returned `MMEntryBias`.
3. WHEN `netExposureUsd < −MM_INVENTORY_HARD_BLOCK`, THE MarketMaker SHALL set `blockReason = 'inventory_short'` in the returned `MMEntryBias`.
4. WHEN `blocked = true`, THE MarketMaker SHALL return `biasedDirection = null`, `pingPongBias = 0`, and `inventoryBias = 0`.
5. WHEN `|cumLongUsd − cumShortUsd| <= MM_INVENTORY_HARD_BLOCK`, THE MarketMaker SHALL return `blocked = false` from `computeEntryBias()`.

---

### Requirement 3: Ping-Pong Bias

**User Story:** As a market-making strategist, I want the bot to bias its next entry toward the opposite side of the last exit, so that it alternates long/short and captures the spread on each leg.

#### Acceptance Criteria

1. WHEN `lastTradeContext.side = 'long'` and `blocked = false`, THE MarketMaker SHALL return `pingPongBias = −MM_PINGPONG_BIAS_STRENGTH` and `biasedDirection = 'short'` (absent inventory override).
2. WHEN `lastTradeContext.side = 'short'` and `blocked = false`, THE MarketMaker SHALL return `pingPongBias = +MM_PINGPONG_BIAS_STRENGTH` and `biasedDirection = 'long'` (absent inventory override).
3. WHEN `lastTradeContext` is `null`, THE MarketMaker SHALL return `pingPongBias = 0` and `biasedDirection = null` (absent inventory override).
4. THE MarketMaker SHALL constrain `pingPongBias` to the range `[−MM_PINGPONG_BIAS_STRENGTH, +MM_PINGPONG_BIAS_STRENGTH]`.

---

### Requirement 4: Inventory Soft Bias

**User Story:** As a market-making strategist, I want a graduated soft bias applied before the hard block threshold, so that the bot gently rebalances inventory without abruptly stopping.

#### Acceptance Criteria

1. WHEN `netExposureUsd > MM_INVENTORY_SOFT_BIAS` and `blocked = false`, THE MarketMaker SHALL return `inventoryBias = −MM_INVENTORY_BIAS_STRENGTH` (bias toward short).
2. WHEN `netExposureUsd < −MM_INVENTORY_SOFT_BIAS` and `blocked = false`, THE MarketMaker SHALL return `inventoryBias = +MM_INVENTORY_BIAS_STRENGTH` (bias toward long).
3. WHEN `|netExposureUsd| <= MM_INVENTORY_SOFT_BIAS`, THE MarketMaker SHALL return `inventoryBias = 0`.
4. WHEN both inventory soft bias and ping-pong bias are active, THE MarketMaker SHALL use the inventory bias direction as `biasedDirection`, overriding the ping-pong direction.

---

### Requirement 5: Dynamic Take-Profit

**User Story:** As a trader, I want the take-profit target to adapt to the current spread, so that the bot targets a realistic fraction of the spread rather than an arbitrary fixed constant.

#### Acceptance Criteria

1. WHEN `computeDynamicTP(entryPrice, spreadBps)` is called, THE MarketMaker SHALL compute `spreadTarget = (spreadBps / 10000) × entryPrice × MM_SPREAD_MULT`.
2. WHEN `computeDynamicTP(entryPrice, spreadBps)` is called, THE MarketMaker SHALL compute `feeFloor = feeRoundTrip × MM_MIN_FEE_MULT` where `feeRoundTrip = ORDER_SIZE_MIN × entryPrice × FEE_RATE_MAKER × 2`.
3. THE MarketMaker SHALL return `dynamicTP = min(max(spreadTarget, feeFloor), MM_TP_MAX_USD)`.
4. FOR ALL `entryPrice > 0` and `spreadBps >= 0`, THE MarketMaker SHALL return `dynamicTP <= MM_TP_MAX_USD`.
5. FOR ALL `entryPrice > 0` and `spreadBps >= 0`, THE MarketMaker SHALL return `dynamicTP >= feeRoundTrip × MM_MIN_FEE_MULT`.
6. FOR ALL fixed `entryPrice`, if `spreadBps_a >= spreadBps_b` THEN THE MarketMaker SHALL return `computeDynamicTP(entryPrice, spreadBps_a) >= computeDynamicTP(entryPrice, spreadBps_b)`.

---

### Requirement 6: Trade Recording

**User Story:** As a developer, I want `recordTrade()` to accurately accumulate session volume, so that inventory control has correct data to work with.

#### Acceptance Criteria

1. WHEN `recordTrade('long', volumeUsd)` is called, THE MarketMaker SHALL increment `state.cumLongUsd` by `volumeUsd`.
2. WHEN `recordTrade('short', volumeUsd)` is called, THE MarketMaker SHALL increment `state.cumShortUsd` by `volumeUsd`.
3. WHEN `recordTrade(side, volumeUsd)` is called, THE MarketMaker SHALL set `state.lastExitSide = side`.
4. WHEN `recordTrade(side, volumeUsd)` is called, THE MarketMaker SHALL increment `state.tradeCount` by 1.
5. FOR ALL sequences of `recordTrade()` calls with `volumeUsd > 0`, THE MarketMaker SHALL maintain `state.cumLongUsd >= 0` and `state.cumShortUsd >= 0`.

---

### Requirement 7: Configuration Keys

**User Story:** As an operator, I want all MM parameters to be configurable via the dashboard, so that I can tune market-making behavior without redeploying.

#### Acceptance Criteria

1. THE `config.ts` SHALL include `MM_ENABLED: boolean` with default `true`.
2. THE `config.ts` SHALL include `MM_PINGPONG_BIAS_STRENGTH: number` with default `0.08`.
3. THE `config.ts` SHALL include `MM_INVENTORY_SOFT_BIAS: number` with default `50`.
4. THE `config.ts` SHALL include `MM_INVENTORY_HARD_BLOCK: number` with default `150`.
5. THE `config.ts` SHALL include `MM_INVENTORY_BIAS_STRENGTH: number` with default `0.12`.
6. THE `config.ts` SHALL include `MM_SPREAD_MULT: number` with default `1.5`.
7. THE `config.ts` SHALL include `MM_MIN_FEE_MULT: number` with default `1.5`.
8. THE `config.ts` SHALL include `MM_TP_MAX_USD: number` with default `2.0`.
9. THE `ConfigStore` SHALL include all eight MM_* keys in `OverridableConfig` and `OVERRIDABLE_KEYS`.

---

### Requirement 8: Configuration Validation

**User Story:** As an operator, I want invalid MM configuration combinations to be rejected, so that the bot cannot enter an inconsistent state from a misconfigured dashboard override.

#### Acceptance Criteria

1. WHEN `MM_INVENTORY_HARD_BLOCK <= MM_INVENTORY_SOFT_BIAS` is submitted as an override, THE `validateOverrides` SHALL reject it with a descriptive error message.
2. WHEN `MM_SPREAD_MULT <= 0` is submitted as an override, THE `validateOverrides` SHALL reject it.
3. WHEN `MM_MIN_FEE_MULT < 1.0` is submitted as an override, THE `validateOverrides` SHALL reject it.
4. WHEN `MM_TP_MAX_USD <= 0` is submitted as an override, THE `validateOverrides` SHALL reject it.
5. WHEN `MM_PINGPONG_BIAS_STRENGTH < 0` is submitted as an override, THE `validateOverrides` SHALL reject it.
6. WHEN `MM_INVENTORY_BIAS_STRENGTH < 0` is submitted as an override, THE `validateOverrides` SHALL reject it.
7. WHEN a valid MM configuration is submitted, THE `validateOverrides` SHALL accept it without error.

---

### Requirement 9: Watcher Integration — Entry

**User Story:** As a trader, I want the Watcher to apply MM bias during IDLE state signal evaluation, so that ping-pong and inventory control influence entry decisions.

#### Acceptance Criteria

1. WHEN `MM_ENABLED = true` and Watcher is in IDLE state, THE Watcher SHALL call `marketMaker.computeEntryBias()` before placing an entry order.
2. WHEN `computeEntryBias()` returns `blocked = true`, THE Watcher SHALL skip the entry and log the block reason.
3. WHEN `computeEntryBias()` returns `blocked = false`, THE Watcher SHALL resolve the final entry direction using the adjusted score (`signal.score + pingPongBias + inventoryBias`).
4. WHEN an entry order is placed with `MM_ENABLED = true`, THE Watcher SHALL call `computeDynamicTP()` using `entryPrice` and `_pendingEntrySpreadBps` (falling back to `2` bps if unavailable).
5. WHEN `computeDynamicTP()` returns a value, THE Watcher SHALL store it in `_pendingDynamicTP` for use in the IN_POSITION exit check.
6. WHEN `MM_ENABLED = false`, THE Watcher SHALL skip all `computeEntryBias()` and `computeDynamicTP()` calls and use `FARM_TP_USD` as the TP target.

---

### Requirement 10: Watcher Integration — Exit

**User Story:** As a trader, I want the Watcher to use the dynamic TP for exit decisions and record each trade for inventory tracking, so that the MM subsystems have accurate state.

#### Acceptance Criteria

1. WHEN Watcher is IN_POSITION in FARM mode with `MM_ENABLED = true`, THE Watcher SHALL use `_pendingDynamicTP` (falling back to `FARM_TP_USD` if null) as the TP threshold.
2. WHEN `pnl >= dynamicTP`, THE Watcher SHALL trigger an exit with trigger label `FARM_MM_TP`.
3. WHEN an exit fill is confirmed in FARM mode with `MM_ENABLED = true`, THE Watcher SHALL call `marketMaker.recordTrade(positionSide, filledSize × exitPrice)`.
4. WHEN `Watcher.resetSession()` is called, THE Watcher SHALL call `marketMaker.reset()`.

---

### Requirement 11: TradeRecord MM Metadata

**User Story:** As an analyst, I want MM metadata captured in every trade record, so that I can analyze the effectiveness of ping-pong and inventory control in post-trade analytics.

#### Acceptance Criteria

1. THE `TradeRecord` interface SHALL include optional field `mmPingPongBias?: number`.
2. THE `TradeRecord` interface SHALL include optional field `mmInventoryBias?: number`.
3. THE `TradeRecord` interface SHALL include optional field `mmDynamicTP?: number`.
4. THE `TradeRecord` interface SHALL include optional field `mmNetExposure?: number`.
5. WHEN a trade is logged in FARM mode with `MM_ENABLED = true`, THE Watcher SHALL populate all four MM metadata fields on the `TradeRecord`.
6. WHEN `MM_ENABLED = false`, THE Watcher SHALL leave MM metadata fields as `undefined` on the `TradeRecord`.
