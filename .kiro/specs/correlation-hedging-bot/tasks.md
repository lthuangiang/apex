# Implementation Plan: Correlation Hedging Bot

## Overview

Implement the `HedgeBot` as a new bot type that trades two correlated assets (BTC and ETH) simultaneously in opposite directions on the same exchange. The implementation introduces `HedgeBot`, `VolumeMonitor`, and `HedgeBotSharedState`, extends `loadBotConfigs` to handle `botType: "hedge"` entries, updates `BotManager` to support the union type, and wires everything into the `bot.ts` bootstrap. All new components are tested with unit, property-based, and integration tests using vitest and fast-check.

## Tasks

- [x] 1. Define types and interfaces for the HedgeBot system
  - Create `src/bot/HedgeBotSharedState.ts` with `LegState`, `ActiveLegPair`, `HedgeBotSharedState`, `HedgeBotStatus`, and `HedgeTradeRecord` interfaces
  - Create `HedgeBotConfig` interface in `src/bot/types.ts` (add alongside existing `BotConfig`)
  - Export all new types from the module
  - _Requirements: 1.1, 1.2, 2.2, 8.3, 9.2_

- [ ] 2. Implement `VolumeMonitor`
  - [x] 2.1 Create `src/bot/VolumeMonitor.ts` with rolling window FIFO logic
    - Implement `sample()` to fetch trades via `adapter.get_recent_trades` and sum sizes
    - Implement `shouldEnter()` — returns `true` only when both windows are full AND both show a spike
    - Expose `getWindowA()`, `getWindowB()`, `getRollingAverageA()`, `getRollingAverageB()` for testing
    - Expose `_addSampleA(v)` / `_addSampleB(v)` internal helpers for property tests
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6_

  - [x] 2.2 Write unit tests for `VolumeMonitor` (`src/bot/__tests__/VolumeMonitor.test.ts`)
    - Test rolling window overflow (oldest element discarded)
    - Test `shouldEnter()` returns `false` when windows are not full
    - Test `shouldEnter()` returns `false` when only one symbol spikes
    - Test `shouldEnter()` returns `true` when both symbols spike with full windows
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5_

  - [x] 2.3 Write property test: rolling window size invariant (`src/bot/__tests__/HedgeBot.properties.test.ts`)
    - **Property 5: Rolling window never exceeds configured size**
    - **Validates: Requirements 3.1, 3.2**

  - [x] 2.4 Write property test: volume spike detection formula
    - **Property 6: Volume spike detection formula**
    - **Validates: Requirements 3.3, 3.4, 3.5**

- [ ] 3. Implement `HedgeBotConfig` validation and config loader extension
  - [x] 3.1 Add `validateHedgeBotConfig` function to `src/bot/loadBotConfigs.ts`
    - Validate all required fields: `botType`, `symbolA`, `symbolB`, `exchange`, `legValueUsd`, `holdingPeriodSecs`, `profitTargetUsd`, `maxLossUsd`, `volumeSpikeMultiplier`, `volumeRollingWindow`, `fundingRateWeight`
    - Throw descriptive error naming the missing field when any required field is absent
    - _Requirements: 1.1, 1.4_

  - [x] 3.2 Extend `loadBotConfigs` to detect and route `botType: "hedge"` entries
    - When `config.botType === "hedge"`, call `validateHedgeBotConfig` instead of `validateBotConfig`
    - Return validated `HedgeBotConfig` objects alongside standard `BotConfig` objects
    - Update return type to `(BotConfig | HedgeBotConfig)[]`
    - _Requirements: 1.3, 1.5_

  - [x] 3.3 Write unit tests for config validation (`src/bot/__tests__/HedgeBot.test.ts`)
    - Test that valid `HedgeBotConfig` passes validation
    - Test that each missing required field causes a descriptive error
    - _Requirements: 1.4_

  - [x] 3.4 Write property test: config validation rejects missing required fields
    - **Property 2: Config validation rejects missing required fields**
    - **Validates: Requirements 1.4**

  - [x] 3.5 Write property test: config round-trip serialization
    - **Property 1: Config round-trip serialization**
    - **Validates: Requirements 1.5**

- [x] 4. Checkpoint — Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 5. Implement direction assignment and exit condition logic
  - [x] 5.1 Implement `assignDirections` pure function (in `src/bot/HedgeBot.ts` or a helper module)
    - Compare adjusted scores: higher score → LongLeg, lower score → ShortLeg
    - Apply funding rate adjustment: `adjustedScore = score + fundingRate × fundingRateWeight`
    - Return `{ longSymbol, shortSymbol }` or `null` when scores are equal (within 0.001) or both are `"skip"`
    - _Requirements: 4.2, 4.3, 4.4_

  - [x] 5.2 Implement `evaluateExitConditions` pure function
    - Evaluate in priority order: `MAX_LOSS` → `PROFIT_TARGET` → `MEAN_REVERSION` → `TIME_EXPIRY`
    - Accept `{ combinedPnl, profitTargetUsd, maxLossUsd, elapsedSecs, holdingPeriodSecs, currentRatio, equilibriumSpread }` as input
    - Return `{ shouldExit: boolean, reason: ExitReason | null }`
    - _Requirements: 6.2, 6.3, 6.4, 6.5, 6.6_

  - [x] 5.3 Implement `computeCombinedPnl` and `buildHedgeTradeRecord` pure functions
    - `computeCombinedPnl(pnlA, pnlB)` returns arithmetic sum
    - `buildHedgeTradeRecord(trade)` constructs a complete `HedgeTradeRecord` from a completed trade
    - _Requirements: 8.3, 8.4, 9.2_

  - [x] 5.4 Write unit tests for direction assignment and exit conditions
    - Test direction assignment with clear score differences
    - Test tie/skip handling (scores within 0.001)
    - Test each exit condition trigger individually
    - Test mean reversion threshold (0.5% of equilibrium spread)
    - _Requirements: 4.2, 4.3, 4.4, 6.2, 6.3, 6.4, 6.5, 6.6_

  - [x] 5.5 Write property test: direction assignment follows signal score ordering
    - **Property 7: Direction assignment follows signal score ordering**
    - **Validates: Requirements 4.2, 4.3**

  - [x] 5.6 Write property test: exit condition priority ordering
    - **Property 10: Exit condition priority ordering**
    - **Validates: Requirements 6.6**

  - [x] 5.7 Write property test: mean reversion trigger threshold
    - **Property 11: Mean reversion trigger threshold**
    - **Validates: Requirements 6.5**

  - [x] 5.8 Write property test: CombinedPnL arithmetic identity
    - **Property 12: CombinedPnL arithmetic identity**
    - **Validates: Requirements 8.3, 8.4**

- [ ] 6. Implement leg sizing and value equality logic
  - [x] 6.1 Implement `computeLegSize(legValueUsd, markPrice)` pure function
    - Returns `legValueUsd / markPrice`
    - _Requirements: 5.1_

  - [x] 6.2 Implement imbalance detection helper
    - Compute `|legValueA - legValueB| / legValueUsd` after fills
    - Log warning if deviation exceeds 0.01 (1%)
    - _Requirements: 8.1, 8.2_

  - [x] 6.3 Write property test: leg size computation
    - **Property 8: Leg size computation**
    - **Validates: Requirements 5.1**

  - [x] 6.4 Write property test: leg value equality invariant
    - **Property 9: Leg value equality invariant**
    - **Validates: Requirements 5.3, 8.1**

- [ ] 7. Implement `HedgeBot` core class
  - [x] 7.1 Create `src/bot/HedgeBot.ts` with constructor and state initialization
    - Accept `(config: HedgeBotConfig, adapter: ExchangeAdapter, telegram: TelegramManager)`
    - Initialize `HedgeBotSharedState` with `hedgeBotState: 'IDLE'`, `hedgePosition: null`
    - Initialize `VolumeMonitor`, `AISignalEngine` (one per symbol), and `TradeLogger`
    - _Requirements: 2.1, 2.5_

  - [x] 7.2 Implement `start()` and `stop()` lifecycle methods
    - `start()`: set `botStatus = 'RUNNING'`, launch tick loop in background, return `true`
    - `stop()`: set `botStatus = 'STOPPED'`, stop tick loop, log warning if `hedgePosition !== null`
    - _Requirements: 2.1, 2.3_

  - [x] 7.3 Implement `getStatus()` method
    - Return `HedgeBotStatus` with all `BotStatus`-compatible fields plus `hedgePosition`
    - Set `symbol` to `"symbolA/symbolB"` for display
    - Set `openPosition: null` (hedge uses `hedgePosition` instead)
    - _Requirements: 2.2_

  - [x] 7.4 Write unit tests for `HedgeBot` lifecycle and `getStatus()`
    - Test `start()` transitions state to RUNNING
    - Test `stop()` with no active pair transitions to STOPPED
    - Test `stop()` with active pair logs warning and does not close positions
    - Test `getStatus()` returns all required fields in all states
    - _Requirements: 2.1, 2.2, 2.3_

  - [x] 7.5 Write property test: `getStatus()` always returns all required fields
    - **Property 3: getStatus always returns all required fields**
    - **Validates: Requirements 2.2**

- [ ] 8. Implement the HedgeBot tick loop (IDLE → OPENING → IN_PAIR → CLOSING → COOLDOWN)
  - [x] 8.1 Implement IDLE state: volume sampling and entry evaluation
    - Call `volumeMonitor.sample()` on each tick; skip tick on error (log warning)
    - When `volumeMonitor.shouldEnter()` is true, call `AISignalEngine.getSignal()` for both symbols in parallel
    - Call `assignDirections()`; skip entry if result is `null`
    - Transition to OPENING state on valid direction assignment
    - _Requirements: 3.4, 3.5, 4.1, 4.4, 4.5_

  - [x] 8.2 Implement OPENING state: atomic leg placement
    - Fetch mark prices for both symbols, compute leg sizes via `computeLegSize`
    - Place both leg orders via `Promise.all([adapter.place_limit_order(...), adapter.place_limit_order(...)])`
    - On one-leg failure: cancel the successful leg, log error, return to IDLE
    - On both fills confirmed: record `ActiveLegPair`, check imbalance, transition to IN_PAIR
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6_

  - [x] 8.3 Implement IN_PAIR state: exit condition monitoring
    - On each tick: fetch positions for both symbols, compute `combinedPnl`, update `hedgePosition`
    - Compute current BTC/ETH ratio and update equilibrium spread rolling window
    - Call `evaluateExitConditions()`; on `shouldExit`, transition to CLOSING
    - Call `adapter.get_balance()` once per tick to track available balance
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 8.3, 10.4_

  - [x] 8.4 Implement CLOSING state: atomic close with retry
    - Place close orders for both legs via `Promise.all` with `reduceOnly: true`
    - Retry failed close orders up to 3 times with exponential backoff (1s, 2s, 4s)
    - Poll `get_position` up to 5 times (1s interval) to confirm flat
    - On confirmed flat: call `buildHedgeTradeRecord`, log via `TradeLogger`, update `sessionPnl`/`sessionVolume`, transition to COOLDOWN
    - On persistent failure: log critical error, alert via Telegram, remain in CLOSING
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 9.1, 9.2, 9.3, 9.4_

  - [x] 8.5 Implement COOLDOWN state
    - Wait `cooldownSecs` (default 30) before transitioning back to IDLE
    - _Requirements: 7.6_

  - [x] 8.6 Write property test: trade log record completeness
    - **Property 13: Trade log record completeness**
    - **Validates: Requirements 7.5, 9.2**

- [x] 9. Checkpoint — Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 10. Update `BotManager` to support `HedgeBot`
  - [x] 10.1 Change registry type from `Map<string, BotInstance>` to `Map<string, BotInstance | HedgeBot>`
    - Update `getAllBots()` return type to `(BotInstance | HedgeBot)[]`
    - Update `getBot()` return type to `BotInstance | HedgeBot | undefined`
    - _Requirements: 2.4, 2.5_

  - [x] 10.2 Add `createHedgeBot(config, adapter, telegram)` method to `BotManager`
    - Accepts `HedgeBotConfig`, creates a `HedgeBot`, registers it in the registry
    - Throws if a bot with the same `id` already exists (same guard as `createBot`)
    - _Requirements: 1.3, 2.5_

  - [x] 10.3 Verify `getAggregatedStats()` works with mixed bot types
    - `HedgeBotSharedState` must expose `sessionPnl`, `sessionVolume`, `sessionFees`, `botStatus` at the same paths as `BotSharedState` so the existing aggregation loop works without modification
    - _Requirements: 2.4_

  - [x] 10.4 Write property test: BotManager aggregated stats include HedgeBot contributions
    - **Property 4: BotManager aggregated stats include HedgeBot contributions**
    - **Validates: Requirements 2.4**

- [x] 11. Wire `HedgeBot` into the `bot.ts` bootstrap
  - In the multi-bot loop in `src/bot.ts`, detect `botType: "hedge"` configs and call `botManager.createHedgeBot(config, adapter, telegram)` instead of `botManager.createBot(config, adapter, telegram)`
  - Auto-start hedge bots when `autoStart: true`, same as standard bots
  - _Requirements: 1.3, 2.1_

- [ ] 12. Write integration tests (`src/bot/__tests__/HedgeBot.integration.test.ts`)
  - [x] 12.1 Write integration test: full entry → fill → PROFIT_TARGET exit cycle
    - Use mock adapter; verify `HedgeTradeRecord` is written with `exitReason: "PROFIT_TARGET"`
    - _Requirements: 6.3, 7.5, 9.2_

  - [x] 12.2 Write integration test: full entry → fill → MAX_LOSS exit cycle
    - Verify `exitReason: "MAX_LOSS"` and `combinedPnl ≤ -maxLossUsd`
    - _Requirements: 6.4_

  - [x] 12.3 Write integration test: one-leg failure during entry
    - Mock adapter throws on second `place_limit_order`; verify first order is cancelled and state returns to IDLE
    - _Requirements: 5.4_

  - [x] 12.4 Write integration test: close retry with exponential backoff
    - Mock adapter fails close order twice then succeeds; verify 3 attempts and correct backoff delays
    - _Requirements: 7.3_

  - [x] 12.5 Write integration test: stop with open positions
    - Call `stop()` while `hedgeBotState === 'IN_PAIR'`; verify no close orders are placed and warning is logged
    - _Requirements: 2.3_

  - [x] 12.6 Write integration test: BotManager aggregation with mixed bot types
    - Register one `BotInstance` and one `HedgeBot`; verify `getAggregatedStats()` sums both
    - _Requirements: 2.4_

- [x] 13. Final checkpoint — Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for a faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation at logical boundaries
- Property tests (Properties 1–13) validate universal correctness guarantees using fast-check
- Unit tests validate specific examples, edge cases, and error paths
- Integration tests verify end-to-end state machine flows with mock adapters
- `HedgeBotSharedState` must expose `sessionPnl`, `sessionVolume`, `sessionFees`, and `botStatus` at the same field paths as `BotSharedState` to keep `BotManager.getAggregatedStats()` unmodified
- The `assignDirections`, `evaluateExitConditions`, `computeCombinedPnl`, `computeLegSize`, and `buildHedgeTradeRecord` functions should be pure (no side effects) to make them directly testable by property tests
