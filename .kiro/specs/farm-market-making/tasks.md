# Tasks: Farm Market Making (Phase 6)

## Task List

- [x] 1. Add MM_* config keys
  - [x] 1.1 Add `MM_ENABLED`, `MM_PINGPONG_BIAS_STRENGTH`, `MM_INVENTORY_SOFT_BIAS`, `MM_INVENTORY_HARD_BLOCK`, `MM_INVENTORY_BIAS_STRENGTH`, `MM_SPREAD_MULT`, `MM_MIN_FEE_MULT`, `MM_TP_MAX_USD` to `config.ts` with default values from design
  - [x] 1.2 Add all eight MM_* keys to `OverridableConfig` type and `OVERRIDABLE_KEYS` array in `src/config/ConfigStore.ts`
  - [x] 1.3 Add `extractBase()` mappings for all eight MM_* keys in `ConfigStore.ts`
  - [x] 1.4 Add validation rules for MM_* keys in `validateOverrides.ts`: `MM_INVENTORY_HARD_BLOCK > MM_INVENTORY_SOFT_BIAS`, `MM_SPREAD_MULT > 0`, `MM_MIN_FEE_MULT >= 1.0`, `MM_TP_MAX_USD > 0`, `MM_PINGPONG_BIAS_STRENGTH >= 0`, `MM_INVENTORY_BIAS_STRENGTH >= 0`

- [x] 2. Implement MarketMaker — types and state
  - [x] 2.1 Create `src/modules/MarketMaker.ts` with `MMState`, `MMEntryBias`, and `MarketMakerInterface` type definitions matching the design interfaces
  - [x] 2.2 Implement `MarketMaker` class constructor that initialises `MMState` to `{ cumLongUsd: 0, cumShortUsd: 0, lastExitSide: null, tradeCount: 0 }`
  - [x] 2.3 Implement `getState(): MMState` — returns a copy of current state
  - [x] 2.4 Implement `reset(): void` — zeroes all state fields

- [x] 3. Implement MarketMaker — computeEntryBias
  - [x] 3.1 Implement hard-block check: if `|cumLong − cumShort| > MM_INVENTORY_HARD_BLOCK` return `blocked = true` with correct `blockReason`, `biasedDirection = null`, both biases = 0
  - [x] 3.2 Implement ping-pong bias: derive `pingPongBias` and `pingPongDirection` from `lastTradeContext.side` (negative after long, positive after short, zero if null)
  - [x] 3.3 Implement inventory soft bias: derive `inventoryBias` and `inventoryDirection` from `netExposureUsd` vs `MM_INVENTORY_SOFT_BIAS`; inventory direction overrides ping-pong direction when active
  - [x] 3.4 Combine biases: `finalBiasedDirection = inventoryBias !== 0 ? inventoryDirection : pingPongDirection`
  - [x] 3.5 Return complete `MMEntryBias` object with all fields populated

- [x] 4. Implement MarketMaker — computeDynamicTP
  - [x] 4.1 Implement spread target formula: `(spreadBps / 10000) × entryPrice × MM_SPREAD_MULT`
  - [x] 4.2 Implement fee floor formula: `ORDER_SIZE_MIN × entryPrice × FEE_RATE_MAKER × 2 × MM_MIN_FEE_MULT`
  - [x] 4.3 Return `min(max(spreadTarget, feeFloor), MM_TP_MAX_USD)`

- [x] 5. Implement MarketMaker — recordTrade
  - [x] 5.1 Implement `recordTrade(side, volumeUsd)`: increment `cumLongUsd` or `cumShortUsd` by `volumeUsd`, set `lastExitSide = side`, increment `tradeCount`

- [x] 6. Integrate MarketMaker into Watcher — entry path
  - [x] 6.1 Instantiate `MarketMaker` as a private field in `Watcher` constructor; store `_pendingDynamicTP: number | null = null`
  - [x] 6.2 In IDLE state FARM mode tick: when `MM_ENABLED = true`, call `computeEntryBias(lastTradeContext, marketMaker.getState())`
  - [x] 6.3 When `mmBias.blocked = true`, log the block reason and return early (skip entry)
  - [x] 6.4 When `mmBias.blocked = false`, compute `adjustedScore = signal.score + mmBias.pingPongBias + mmBias.inventoryBias` and use it in direction resolution
  - [x] 6.5 After direction is resolved and before placing entry order, call `computeDynamicTP(markPrice, this._pendingEntrySpreadBps ?? 2)` and store result in `this._pendingDynamicTP`
  - [x] 6.6 Log MM bias values (`pingPongBias`, `inventoryBias`, `netExposureUsd`, `dynamicTP`) at entry

- [x] 7. Integrate MarketMaker into Watcher — exit path
  - [x] 7.1 In IN_POSITION FARM mode exit check: use `this._pendingDynamicTP ?? config.FARM_TP_USD` as the TP threshold when `MM_ENABLED = true`
  - [x] 7.2 When `pnl >= dynamicTP`, set `exitTrigger = 'FARM_MM_TP'` and trigger exit
  - [x] 7.3 On PENDING_EXIT → IDLE (exit fill confirmed) in FARM mode with `MM_ENABLED = true`: call `marketMaker.recordTrade(positionSide, filledSize × exitPrice)`
  - [x] 7.4 In `resetSession()`: call `this.marketMaker.reset()` and set `this._pendingDynamicTP = null`
  - [x] 7.5 When `MM_ENABLED = false`: skip all MM calls; use `config.FARM_TP_USD` as TP; leave `_pendingDynamicTP = null`

- [x] 8. Extend TradeRecord with MM metadata
  - [x] 8.1 Add optional fields `mmPingPongBias?: number`, `mmInventoryBias?: number`, `mmDynamicTP?: number`, `mmNetExposure?: number` to `TradeRecord` interface in `src/ai/TradeLogger.ts`
  - [x] 8.2 In Watcher exit path: when `MM_ENABLED = true`, populate all four MM fields on the `TradeRecord` before calling `tradeLogger.log()`

- [x] 9. Add `exitTrigger` value for MM TP
  - [x] 9.1 Add `'FARM_MM_TP'` to the `exitTrigger` union type in `TradeRecord` (alongside existing `'FARM_TP'`, `'FARM_TIME'`, etc.)

- [x] 10. Tests — config and validation
  - [x] 10.1 Unit: all eight MM_* keys present in `config.ts` with correct default values
  - [x] 10.2 Unit: all eight MM_* keys present in `OverridableConfig` and `OVERRIDABLE_KEYS`
  - [x] 10.3 Unit: `validateOverrides` rejects `MM_INVENTORY_HARD_BLOCK <= MM_INVENTORY_SOFT_BIAS`
  - [x] 10.4 Unit: `validateOverrides` rejects `MM_SPREAD_MULT <= 0`, `MM_MIN_FEE_MULT < 1.0`, `MM_TP_MAX_USD <= 0`
  - [x] 10.5 Unit: `validateOverrides` rejects `MM_PINGPONG_BIAS_STRENGTH < 0`, `MM_INVENTORY_BIAS_STRENGTH < 0`
  - [x] 10.6 Unit: `validateOverrides` accepts a fully valid MM config patch

- [x] 11. Tests — MarketMaker unit
  - [x] 11.1 Unit: `computeEntryBias` returns `blocked = true` with `blockReason = 'inventory_long'` when `cumLong − cumShort > MM_INVENTORY_HARD_BLOCK`
  - [x] 11.2 Unit: `computeEntryBias` returns `blocked = true` with `blockReason = 'inventory_short'` when `cumShort − cumLong > MM_INVENTORY_HARD_BLOCK`
  - [x] 11.3 Unit: `computeEntryBias` returns `pingPongBias = −MM_PINGPONG_BIAS_STRENGTH` and `biasedDirection = 'short'` after a long exit (balanced inventory)
  - [x] 11.4 Unit: `computeEntryBias` returns `pingPongBias = +MM_PINGPONG_BIAS_STRENGTH` and `biasedDirection = 'long'` after a short exit (balanced inventory)
  - [x] 11.5 Unit: `computeEntryBias` returns `pingPongBias = 0` and `biasedDirection = null` when `lastTradeContext = null` (balanced inventory)
  - [x] 11.6 Unit: `computeEntryBias` returns `inventoryBias = −MM_INVENTORY_BIAS_STRENGTH` and `biasedDirection = 'short'` when `netExposure > MM_INVENTORY_SOFT_BIAS`
  - [x] 11.7 Unit: `computeEntryBias` returns `inventoryBias = +MM_INVENTORY_BIAS_STRENGTH` and `biasedDirection = 'long'` when `netExposure < −MM_INVENTORY_SOFT_BIAS`
  - [x] 11.8 Unit: inventory bias direction overrides ping-pong direction when both are active and conflicting
  - [x] 11.9 Unit: `computeEntryBias` returns `inventoryBias = 0` when `|netExposure| <= MM_INVENTORY_SOFT_BIAS`
  - [x] 11.10 Unit: `computeDynamicTP` returns value <= `MM_TP_MAX_USD` for typical BTC price and spread
  - [x] 11.11 Unit: `computeDynamicTP` returns fee floor when `spreadBps = 0`
  - [x] 11.12 Unit: `computeDynamicTP` returns `MM_TP_MAX_USD` when spread is very wide
  - [x] 11.13 Unit: `recordTrade('long', 100)` increments `cumLongUsd` by 100, sets `lastExitSide = 'long'`, increments `tradeCount`
  - [x] 11.14 Unit: `recordTrade('short', 50)` increments `cumShortUsd` by 50, sets `lastExitSide = 'short'`, increments `tradeCount`
  - [x] 11.15 Unit: `reset()` sets all state fields to initial values

- [x] 12. Tests — MarketMaker property-based (fast-check)
  - [x] 12.1 Property (P1): for any `MMState` where `|cumLong − cumShort| > MM_INVENTORY_HARD_BLOCK`, `computeEntryBias()` returns `blocked = true` — validates Requirements 2.1, 2.4
  - [x] 12.2 Property (P2): for any `entryPrice > 0` and `spreadBps >= 0`, `computeDynamicTP() >= feeRoundTrip × MM_MIN_FEE_MULT` — validates Requirement 5.5
  - [x] 12.3 Property (P3): for any `entryPrice > 0` and `spreadBps >= 0`, `computeDynamicTP() <= MM_TP_MAX_USD` — validates Requirement 5.4
  - [x] 12.4 Property (P4): for any fixed `entryPrice` and `spreadBps_a >= spreadBps_b >= 0`, `computeDynamicTP(entryPrice, spreadBps_a) >= computeDynamicTP(entryPrice, spreadBps_b)` — validates Requirement 5.6
  - [x] 12.5 Property (P5): for any non-null `lastTradeContext` and non-blocked `MMState`, `pingPongBias` sign is opposite to `lastTradeContext.side` — validates Requirements 3.1, 3.2
  - [x] 12.6 Property (P6): for any `MMState` where `netExposure > MM_INVENTORY_SOFT_BIAS` and `blocked = false`, `inventoryBias < 0`; for `netExposure < −MM_INVENTORY_SOFT_BIAS`, `inventoryBias > 0` — validates Requirements 4.1, 4.2
  - [x] 12.7 Property (P7): for any sequence of `recordTrade()` calls with `volumeUsd > 0`, `cumLongUsd` equals sum of long volumes and `cumShortUsd` equals sum of short volumes — validates Requirements 6.1, 6.2, 6.5
  - [x] 12.8 Property (P8): for any `MMState` where `|netExposure| <= MM_INVENTORY_SOFT_BIAS`, `computeEntryBias().inventoryBias === 0` — validates Requirement 4.3

- [x] 13. Tests — Watcher integration
  - [x] 13.1 Unit: when `MM_ENABLED = true` and `computeEntryBias()` returns `blocked = true`, Watcher skips entry
  - [x] 13.2 Unit: when `MM_ENABLED = true` and `blocked = false`, Watcher stores `_pendingDynamicTP` from `computeDynamicTP()`
  - [x] 13.3 Unit: when `MM_ENABLED = true` and `pnl >= _pendingDynamicTP`, Watcher triggers exit with `exitTrigger = 'FARM_MM_TP'`
  - [x] 13.4 Unit: on exit fill with `MM_ENABLED = true`, Watcher calls `recordTrade()` with correct side and volume
  - [x] 13.5 Unit: `resetSession()` calls `marketMaker.reset()` and clears `_pendingDynamicTP`
  - [x] 13.6 Unit: when `MM_ENABLED = false`, Watcher uses `FARM_TP_USD` and does not call any MM methods
  - [x] 13.7 Unit: when `_pendingDynamicTP = null` (spread unavailable at entry), Watcher falls back to `FARM_TP_USD` for exit check
