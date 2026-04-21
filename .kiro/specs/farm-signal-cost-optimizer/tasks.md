# Tasks: farm-signal-cost-optimizer

## Task List

- [x] 1. Implement FarmSignalFilters.ts — pure filter functions
  - [x] 1.1 Create `src/modules/FarmSignalFilters.ts` with `FilterInput` and `FilterResult` interfaces
  - [x] 1.2 Implement `regimeConfidenceThreshold(input)` — SIDEWAY vs TREND thresholds
  - [x] 1.3 Implement `tradePressureGate(input)` — skip when pressure=0 and confidence low
  - [x] 1.4 Implement `fallbackQualityGate(input)` — skip fallback signals with very low confidence
  - [x] 1.5 Implement `feeAwareEntryFilter(input)` — skip when expectedEdge <= minRequiredMove × 1.5
  - [x] 1.6 Implement `llmMomentumAdjuster(input)` — compute effectiveConfidence with boost/penalty
  - [x] 1.7 Implement `computeDynamicMinHold(input)` — compute feeBreakEvenSecs and cap at FARM_MAX_HOLD_SECS
  - [x] 1.8 Implement `evaluateFarmEntryFilters(input)` — pipeline function combining all filters in order

- [x] 2. Update config.ts — add 4 new config keys
  - [x] 2.1 Add `FARM_MIN_CONFIDENCE_PRESSURE_GATE: 0.55` to config.ts
  - [x] 2.2 Add `FARM_MIN_FALLBACK_CONFIDENCE: 0.25` to config.ts
  - [x] 2.3 Add `FARM_SIDEWAY_MIN_CONFIDENCE: 0.45` to config.ts
  - [x] 2.4 Add `FARM_TREND_MIN_CONFIDENCE: 0.35` to config.ts

- [x] 3. Update TradeLogger.ts — extend SignalSnapshot
  - [x] 3.1 Add `filterResult?: string` field to `SignalSnapshot` interface
  - [x] 3.2 Add `effectiveConfidence?: number` field to `SignalSnapshot` interface
  - [x] 3.3 Add `dynamicMinHold?: number` field to `SignalSnapshot` interface
  - [x] 3.4 Add SQLite migration columns for new fields in `TradeLogger._migrate()`

- [x] 4. Update Watcher.ts — integrate filter pipeline into _handleIdleFarm
  - [x] 4.1 Import `evaluateFarmEntryFilters` and `FilterInput` from `FarmSignalFilters.ts`
  - [x] 4.2 Call `evaluateFarmEntryFilters` after `getSignal` in `_handleIdleFarm`
  - [x] 4.3 Return early (skip entry) when `filterResult.pass === false`, log skip reason
  - [x] 4.4 Log `[SignalFilter] PASS: ...` summary line when all filters pass
  - [x] 4.5 Pass `filterResult.effectiveConfidence` to `PositionSizer.computeSize` instead of raw `signal.confidence`
  - [x] 4.6 Set `farmHoldUntil` using `filterResult.dynamicMinHold` instead of random hold
  - [x] 4.7 Log `[MinHold] dynamicMinHold={secs}s ...` at entry time
  - [x] 4.8 Store `filterResult` fields in `signalSnapshot` when building `_pendingEntrySignalMeta`
  - [x] 4.9 Remove the old flat `FARM_MIN_CONFIDENCE` check that is now replaced by `RegimeConfidenceThreshold`

- [x] 5. Update AnalyticsEngine.ts — add filter analytics
  - [x] 5.1 Add `FilterSkipStats`, `EffectiveConfidenceStats`, `DynamicMinHoldStats` interfaces to `AnalyticsEngine.ts`
  - [x] 5.2 Extend `AnalyticsSummary` interface with `filterSkipStats`, `effectiveConfidenceStats`, `dynamicMinHoldStats` fields
  - [x] 5.3 Update `emptySummary()` to include empty values for the 3 new fields
  - [x] 5.4 Implement `filterSkipStats` computation — read `signalSnapshot.filterResult` from farm trade records and count per-filter skips
  - [x] 5.5 Implement `effectiveConfidenceStats` computation — average raw confidence vs average effectiveConfidence for farm trades
  - [x] 5.6 Implement `dynamicMinHoldStats` computation — average dynamicMinHold, average holdingTimeSecs, earlyExitRate for farm trades

- [x] 6. Write property-based tests for FarmSignalFilters
  - [x] 6.1 Create `src/modules/__tests__/FarmSignalFilters.properties.test.ts`
  - [x] 6.2 Property 1 & 2: fee filter rejects/passes based on expectedEdge vs threshold
  - [x] 6.3 Property 3: all filters are no-ops in trade mode
  - [x] 6.4 Property 4 & 5: pressure gate rejects/passes based on tradePressure and confidence
  - [x] 6.5 Property 6, 7, 8: LLM adjuster applies correct boost/penalty/identity
  - [x] 6.6 Property 9: fallback gate rejects low-confidence fallback signals
  - [x] 6.7 Property 10: regime gate rejects low-confidence signals per regime
  - [x] 6.8 Property 11 & 12: dynamicMinHold is bounded and falls back correctly
  - [x] 6.9 Property 13: pipeline short-circuits on first rejection
  - [x] 6.10 Property 14: filterSkipStats counts match trade records
  - [x] 6.11 Property 15: config validation rejects out-of-range values

- [x] 7. Write unit tests for FarmSignalFilters
  - [x] 7.1 Create `src/modules/__tests__/FarmSignalFilters.test.ts`
  - [x] 7.2 Test default config values are correct (2.3, 4.3, 5.3, 5.4, 8.1)
  - [x] 7.3 Test log output format when each filter rejects
  - [x] 7.4 Test log output when all filters pass
  - [x] 7.5 Test pipeline happy path: signal passes all filters
  - [x] 7.6 Test config warning when FARM_SIDEWAY_MIN_CONFIDENCE < FARM_TREND_MIN_CONFIDENCE
  - [x] 7.7 Test AnalyticsSummary has all 3 new fields

- [x] 8. Verify TypeScript compilation and run tests
  - [x] 8.1 Run `npx tsc --noEmit` to verify no type errors
  - [x] 8.2 Run property-based tests: `npx vitest run src/modules/__tests__/FarmSignalFilters.properties.test.ts`
  - [x] 8.3 Run unit tests: `npx vitest run src/modules/__tests__/FarmSignalFilters.test.ts`
  - [x] 8.4 Run full test suite to verify no regressions: `npx vitest run`
