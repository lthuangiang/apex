# Implementation Plan: DRIFT Agent Layer

## Overview

Implement the autonomous orchestration brain that sits above `BotManager`, transforming DRIFT into a self-directing trading entity. The Agent Layer introduces four sub-components (`StrategySelector`, `CapitalAllocator`, `RiskGate`, `MarketContextAssembler`) composed into a top-level `DriftAgent` class, plus persistence, dashboard endpoints, and adaptive learning integration.

## Tasks

- [ ] 1. Define core types and interfaces
  - Create `src/agent/types.ts` with all shared types: `AgentDecision`, `AgentState`, `MarketContext`, `PortfolioState`, `BotPortfolioEntry`, `StrategyEligibility`, `AllocationInput`, `AllocationResult`, `RiskGateResult`, `RiskGateStatus`, `PerStrategyStats`, `PerformanceSummary`
  - All `AgentDecision` fields must be `readonly` to enforce immutability after emission
  - Include the `Regime` union type (`'TREND_UP' | 'TREND_DOWN' | 'SIDEWAY' | 'HIGH_VOLATILITY'`)
  - _Requirements: 8.1, 8.2, 8.5_

- [ ] 2. Implement AgentStateStore
  - [ ] 2.1 Create `src/agent/AgentStateStore.ts`
    - Implement `load(filePath: string): AgentState` — returns a fresh default `AgentState` if file is missing or corrupt
    - Implement `save(state: AgentState, filePath: string): void` — writes JSON atomically
    - _Requirements: 1.7, 1.8_

  - [ ]* 2.2 Write property test for AgentState round-trip persistence
    - **Property 1: AgentState round-trip persistence**
    - **Validates: Requirements 1.7, 1.8**
    - File: `src/agent/__tests__/AgentStateStore.properties.test.ts`
    - Use `fc.record(...)` to generate arbitrary valid `AgentState` objects; assert `load(save(state)) deepEquals state`

- [ ] 3. Implement StrategySelector
  - [ ] 3.1 Create `src/agent/StrategySelector.ts`
    - Implement `evaluate(context, performanceStats, riskGateStatus): StrategyEligibility[]`
    - Apply ranking rules in priority order: `risk_halt` blocks FARM; `HIGH_VOLATILITY + REGIME_HIGH_VOL_SKIP_ENTRY` blocks TRADE; win rate < 30% over last 10 trades triggers 3-cycle cooldown; `SIDEWAY` → FARM rank 1; `TREND_UP/DOWN` → TRADE rank 1
    - Fallback: if both strategies are ineligible, re-enable the one with the highest recent win rate
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7_

  - [ ]* 3.2 Write property test: StrategySelector always produces at least one eligible strategy
    - **Property 2: StrategySelector always produces at least one eligible strategy**
    - **Validates: Requirements 3.7**
    - File: `src/agent/__tests__/StrategySelector.properties.test.ts`
    - Generate arbitrary `MarketContext`, `PerStrategyStats`, and `RiskGateStatus`; assert result always contains at least one `eligible: true` entry

  - [ ]* 3.3 Write property test: FARM eligibility invariant
    - **Property 3: FARM eligibility invariant**
    - **Validates: Requirements 3.5**
    - Generate contexts where `riskGateStatus !== 'HALTED'`; assert FARM is always eligible

  - [ ]* 3.4 Write property test: Regime-based strategy ranking
    - **Property 4: Regime-based strategy ranking**
    - **Validates: Requirements 3.2, 3.3**
    - Use `fc.constantFrom('SIDEWAY', 'TREND_UP', 'TREND_DOWN')` for regime; assert correct rank ordering

  - [ ]* 3.5 Write property test: TRADE filter conjunction
    - **Property 9: TRADE entry requires all filters to pass simultaneously**
    - **Validates: Requirements 5.1, 5.2, 5.3, 5.4**
    - Generate signals where at least one filter fails; assert TRADE is not authorized

- [ ] 4. Implement CapitalAllocator
  - [ ] 4.1 Create `src/agent/CapitalAllocator.ts`
    - Implement `compute(inputs: AllocationInput[]): AllocationResult[]`
    - Apply sizing formula: `baseSize × confidenceMultiplier × performanceMultiplier × regimeVolatilityFactor`
    - Clamp to `[ORDER_SIZE_MIN, ORDER_SIZE_MAX]`, apply drawdown floor when `sessionDrawdown > SIZING_DRAWDOWN_THRESHOLD`, apply 50% reduction when exposure is 80–100% of cap, block (size = 0) when exposure ≥ cap
    - Implement dual-strategy capital split using `AGENT_FARM_CAPITAL_RATIO`
    - Implement `computeDynamicFarmTP(spreadBps, positionValue): number` using `max(FARM_TP_USD, spreadBps × positionValue × 1.5)`
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7, 6.8, 6.9, 4.5_

  - [ ]* 4.2 Write property test: CapitalAllocator output is always in valid range
    - **Property 5: CapitalAllocator output is always in valid range**
    - **Validates: Requirements 6.2, 6.7**
    - File: `src/agent/__tests__/CapitalAllocator.properties.test.ts`
    - Generate arbitrary valid `AllocationInput`; assert `0 < sizeBtc <= SIZING_MAX_BTC`

  - [ ]* 4.3 Write property test: ExposureCap is never exceeded
    - **Property 6: ExposureCap is never exceeded**
    - **Validates: Requirements 6.4, 7.3**
    - Generate arrays of allocation inputs; assert total allocated USD never exceeds `AGENT_EXPOSURE_CAP_USD`

  - [ ]* 4.4 Write property test: Drawdown floor is applied when threshold is exceeded
    - **Property 7: Drawdown floor is applied when threshold is exceeded**
    - **Validates: Requirements 6.3**
    - Generate drawdown values above `SIZING_DRAWDOWN_THRESHOLD`; assert resulting size < size without drawdown multiplier

  - [ ]* 4.5 Write property test: Dynamic FARM take-profit formula invariant
    - **Property 8: Dynamic FARM take-profit formula invariant**
    - **Validates: Requirements 4.5**
    - Generate arbitrary non-negative `spreadBps` and `positionValue`; assert `computeDynamicFarmTP(spreadBps, positionValue) >= FARM_TP_USD`

- [ ] 5. Implement RiskGate
  - [ ] 5.1 Create `src/agent/RiskGate.ts`
    - Implement `evaluate(decision, portfolioState): RiskGateResult`
    - Gate rules in order: `sessionPnl < MAX_LOSS` → `HALTED`; `totalExposureUsd >= exposureCapUsd` → `HALTED`; `consecutiveLosses >= AGENT_CONSECUTIVE_LOSS_HALT` → `COOLDOWN` for `AGENT_LOSS_COOLDOWN_MINS`
    - Implement `getRiskStatus(): { status: RiskGateStatus; reason: string | null }`
    - Implement `recordTradeOutcome(win: boolean): void` and `reset(): void`
    - RiskGate must never throw — catch all errors and return `HALTED` with error message as reason
    - RiskGate must not interfere with exit orders
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.8_

  - [ ]* 5.2 Write property test: RiskGate blocks entries when MAX_LOSS is breached
    - **Property 10: RiskGate blocks entries when MAX_LOSS is breached**
    - **Validates: Requirements 7.2**
    - File: `src/agent/__tests__/RiskGate.properties.test.ts`
    - Generate `portfolioState` where `sessionPnl < MAX_LOSS`; assert `authorized: false` and `status: 'HALTED'`

- [ ] 6. Implement MarketContextAssembler
  - [ ] 6.1 Create `src/agent/MarketContextAssembler.ts`
    - Implement `assemble(cycleId: string): Promise<MarketContext>`
    - Fetch regime from `RegimeDetector`, signal from `AISignalEngine` (use cached value if < 60s old), portfolio state from `BotManager`
    - Wrap each fetch in a 10-second timeout; on failure, use last known value and add field name to `degradedFields`
    - Set `degraded: true` when any field uses stale data
    - Mark bots as `STALE` if no state update for > 60 seconds; still count their exposure toward total
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 10.5, 10.6_

  - [ ]* 6.2 Write property test: PortfolioState aggregation correctness
    - **Property 14: PortfolioState aggregation correctness**
    - **Validates: Requirements 2.4, 10.5**
    - File: `src/agent/__tests__/MarketContextAssembler.properties.test.ts`
    - Generate arrays of `BotInstance` states; assert `totalExposureUsd` equals sum of individual exposures and `sessionPnl` equals sum of individual PnLs

- [ ] 7. Checkpoint — Ensure all sub-component tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 8. Implement DriftAgent core (lifecycle + cycle loop)
  - [ ] 8.1 Create `src/agent/DriftAgent.ts`
    - Implement lifecycle methods: `initialize()`, `start()`, `pause()`, `stop()`
    - `initialize()`: load `AgentState` from disk via `AgentStateStore`, register strategies, connect to `BotManager`
    - `start()`: begin executing `_runCycle()` at `AGENT_CYCLE_INTERVAL_SECS` interval
    - `pause()`: complete current cycle, then suspend new cycles without closing positions
    - `stop()`: complete current cycle, emit stop signal to all bots via `BotManager`, persist state; if position open, wait up to 60s before hard stop
    - Implement `_runCycle()` following the observe → decide → allocate → gate → emit → persist pattern
    - On 5 consecutive cycle errors, transition to `PAUSED` and send Telegram alert
    - Implement `getAgentState()`, `getLastDecision()`, `getPerformanceSummary()`
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8_

  - [ ] 8.2 Wire sub-components into `_runCycle()`
    - Call `MarketContextAssembler.assemble()` → `StrategySelector.evaluate()` → `CapitalAllocator.compute()` → `RiskGate.evaluate()` → emit `AgentDecision` to `BotManager`
    - When `degraded: true`, skip new entries but continue monitoring exits
    - When `selectedStrategy` is `HOLD`, do not emit any order
    - Produce exactly one `AgentDecision` per cycle; serialize it to the trade log
    - Emit `strategy_selected`, `bot_assignment`, `risk_halt`, `farm_loss_halt`, `slow_cycle`, `agent_lifecycle` events via `EventBus`
    - Log each cycle with unique `cycleId`, duration, `MarketContext` summary, `AgentDecision`, and DualObjective metrics
    - Warn on `slow_cycle` when cycle duration > 10 seconds
    - _Requirements: 2.6, 3.8, 3.9, 4.8, 5.8, 7.7, 8.1, 8.2, 8.3, 8.4, 8.6, 10.1, 10.2, 10.3, 10.4, 10.7, 11.1, 11.6, 11.7_

  - [ ]* 8.3 Write property test: AgentDecision directional size invariant
    - **Property 11: AgentDecision directional size invariant**
    - **Validates: Requirements 8.6**
    - File: `src/agent/__tests__/DriftAgent.properties.test.ts`
    - Generate decisions where `direction` is `'long'` or `'short'`; assert `allocatedSize > 0`

- [ ] 9. Implement adaptive learning integration
  - [ ] 9.1 Wire `FeedbackLoop` into `DriftAgent`
    - On trade completion (exit filled), record outcome in `FeedbackLoop` with strategy (`FARM`/`TRADE`), PnL, and regime at entry
    - Trigger `AdaptiveWeightAdjuster` after every 10 completed trades
    - Update per-strategy win rate statistics after every completed trade
    - Persist updated `WeightStore` and strategy performance stats to disk after every weight adjustment cycle
    - Emit `strategy_improvement` event when a strategy's win rate improves by > 10pp over 20 trades
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 9.6_

  - [ ]* 9.2 Write property test: Weight adjustment invariants
    - **Property 12: Weight adjustment invariants**
    - **Validates: Requirements 9.7**
    - File: `src/agent/__tests__/AdaptiveWeightAdjuster.properties.test.ts` (extend existing)
    - Generate arrays of trade outcomes (min length 10); assert weights sum to 1.0 (±0.001) and each weight is within `[0.05, 0.60]`

- [ ] 10. Extend ConfigStore with Agent-specific parameters
  - Add new Agent config keys to `OverridableConfig` in `src/config/ConfigStore.ts`: `AGENT_CYCLE_INTERVAL_SECS`, `AGENT_EXPOSURE_CAP_USD`, `AGENT_CONSECUTIVE_LOSS_HALT`, `AGENT_LOSS_COOLDOWN_MINS`, `AGENT_FARM_CAPITAL_RATIO`, `TRADE_MIN_CONFIDENCE`, `TRADE_MAX_CHOP_SCORE`, `AGENT_DRY_RUN`, `FARM_MAX_LOSS_USD`
  - Add validation rules in `src/config/validateOverrides.ts`: `AGENT_CYCLE_INTERVAL_SECS >= 5`, confidence thresholds within `[0, 1]`, exposure cap > 0
  - _Requirements: 12.1, 12.2, 12.3, 12.6_

  - [ ]* 10.1 Write property test: Invalid config values are always rejected
    - **Property 13: Invalid config values are always rejected**
    - **Validates: Requirements 12.6**
    - File: `src/agent/__tests__/AgentConfig.properties.test.ts`
    - Generate invalid config values (e.g., `AGENT_CYCLE_INTERVAL_SECS < 5`, confidence outside `[0,1]`); assert each is rejected with a descriptive error and config is unchanged

- [ ] 11. Add Agent dashboard endpoints to DashboardServer
  - Extend `src/dashboard/server.ts` with a `registerDriftAgent(agent: DriftAgent): void` method
  - `GET /agent/status` — returns `AgentState`, last `AgentDecision`, `PortfolioState`, and DualObjective metrics (session volume, session PnL, cycle latency p50/p95/p99)
  - `GET /agent/history` — returns last 100 `AgentDecision` objects in reverse chronological order
  - `GET /agent/config` — returns all current Agent configuration values
  - `PATCH /agent/config` — accepts partial config overrides, validates via `ConfigStore`, applies immediately; reject invalid values with descriptive error
  - _Requirements: 11.2, 11.3, 11.5, 12.4, 12.5, 12.6_

- [ ] 12. Implement `AGENT_DRY_RUN` mode
  - When `AGENT_DRY_RUN` is `true`, `DriftAgent` produces and logs `AgentDecision` objects but does not call `BotManager.assignStrategy()` or emit any orders
  - _Requirements: 12.7_

- [ ] 13. Write integration tests for DriftAgent
  - [ ]* 13.1 Write integration test: Full AgentCycle with mocked dependencies
    - Mock `RegimeDetector`, `AISignalEngine`, `BotManager`; run a complete cycle; verify `AgentDecision` structure and `BotManager` call signatures
    - File: `src/agent/__tests__/DriftAgent.integration.test.ts`
    - _Requirements: 8.1, 8.2_

  - [ ]* 13.2 Write integration test: Lifecycle transitions
    - Test `initialize → start → pause → resume → stop`; verify `AgentState` is persisted at each step
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5_

  - [ ]* 13.3 Write integration test: Degraded mode
    - Simulate data source timeouts; verify no new entries are authorized and existing positions continue to be monitored
    - _Requirements: 2.5, 2.6_

  - [ ]* 13.4 Write integration test: Dashboard endpoints
    - Verify `/agent/status`, `/agent/history`, `/agent/config` return correct data shapes
    - _Requirements: 11.2, 11.3, 12.4_

- [ ] 14. Create `src/agent/index.ts` barrel export
  - Export `DriftAgent`, `StrategySelector`, `CapitalAllocator`, `RiskGate`, `MarketContextAssembler`, `AgentStateStore`, and all types from `types.ts`
  - _Requirements: 1.1_

- [ ] 15. Final checkpoint — Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties using `fast-check` (already in `devDependencies`)
- Unit tests validate specific examples and edge cases
- The Agent Layer is non-invasive: `BotManager`, `Watcher`, `Executor`, and `BotInstance` are unchanged
