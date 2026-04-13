# Tasks: Feedback Loop (Phase 1)

## Implementation Plan

### 1. WeightStore — persistence singleton

- [x] 1.1 Create `src/ai/FeedbackLoop/WeightStore.ts` with `SignalWeights` interface, `DEFAULT_WEIGHTS`, `getWeights()`, `setWeights()`, `loadFromDisk()`, `saveToDisk()` (atomic write via `.tmp` rename), and corrupt-file fallback to defaults
- [x] 1.2 Export singleton `weightStore` instance from the module
- [x] 1.3 Write unit tests in `src/ai/FeedbackLoop/__tests__/WeightStore.test.ts`: round-trip persistence, missing file fallback, corrupt JSON fallback, invalid weights fallback

### 2. ComponentPerformanceTracker — attribution + recalculation trigger

- [x] 2.1 Create `src/ai/FeedbackLoop/ComponentPerformanceTracker.ts` with `ComponentStats`/`ComponentStat` interfaces and `computeComponentStats(trades, lookbackN)` implementing the attribution rules for EMA, RSI (extreme zones only), momentum, and imbalance
- [x] 2.2 Add `onTradeLogged()` method: increment counter, trigger recalculation every `RECALC_EVERY_N` trades, catch and log errors without resetting counter on failure
- [x] 2.3 Add `getStats()` method returning the latest computed `ComponentStats`
- [x] 2.4 Export singleton `componentPerformanceTracker` instance
- [x] 2.5 Write unit tests in `src/ai/FeedbackLoop/__tests__/ComponentPerformanceTracker.test.ts`: EMA attribution, RSI extreme-zone filtering, momentum attribution, imbalance attribution, lookback window slicing, recalc trigger at N trades

### 3. AdaptiveWeightAdjuster — weight delta + normalisation

- [x] 3.1 Create `src/ai/FeedbackLoop/AdaptiveWeightAdjuster.ts` with `adjustWeights(stats, current)`: apply per-component deltas (win rate thresholds + RSI loss streak), clamp to `[MIN_WEIGHT, MAX_WEIGHT]`, normalise to sum=1.0
- [x] 3.2 Write unit tests in `src/ai/FeedbackLoop/__tests__/AdaptiveWeightAdjuster.test.ts`: high win rate increases weight, low win rate decreases weight, RSI loss streak decreases RSI weight, clamping at bounds, normalisation correctness
- [x] 3.3 Write property-based tests (fast-check): for any valid `SignalWeights` input and any `ComponentStats`, output always sums to `[0.999, 1.001]` and each weight is in `(0, 1)`

### 4. ConfidenceCalibrator — bucket-based confidence adjustment

- [x] 4.1 Create `src/ai/FeedbackLoop/ConfidenceCalibrator.ts` with `ConfidenceBucket` interface, `computeBuckets(trades)`, and `calibrate(rawConf, trades)` implementing the formula `rawConf × (historicalWinRate / 0.5)` with sparse-data guard and `[0.10, 1.00]` clamp
- [x] 4.2 Export singleton `confidenceCalibrator` instance
- [x] 4.3 Write unit tests in `src/ai/FeedbackLoop/__tests__/ConfidenceCalibrator.test.ts`: formula correctness, sparse bucket no-op, out-of-range bucket no-op, clamp at 0.10 and 1.00, NaN/Infinity guard
- [x] 4.4 Write property-based tests (fast-check): output always in `[0.10, 1.00]` for any `rawConf ∈ [0, 1]` and any trade array

### 5. AISignalEngine integration — adaptive weights + calibrated confidence

- [x] 5.1 In `src/ai/AISignalEngine.ts`, replace the four static weight constants (`0.40`, `0.25`, `0.20`, `0.15`) with a `weightStore.getWeights()` call at the start of the momentum score block
- [x] 5.2 After obtaining `decision.confidence` (LLM or fallback), call `confidenceCalibrator.calibrate(rawConf, recentTrades)` where `recentTrades` is the last 50 trades fetched from `TradeLogger`
- [x] 5.3 Pass `tradeLogger` reference into `AISignalEngine` constructor (or inject via setter) so it can fetch recent trades for calibration
- [x] 5.4 Update `AISignalEngine` tests to verify adaptive weights are used and calibrated confidence is returned

### 6. Watcher wiring — startup + trade-logged callback

- [x] 6.1 In `src/modules/Watcher.ts` constructor, call `weightStore.loadFromDisk()` at startup
- [x] 6.2 Wire `tradeLogger.onTradeLogged` to call `componentPerformanceTracker.onTradeLogged()` (chain with any existing callback)
- [x] 6.3 Pass `tradeLogger` to `AISignalEngine` constructor

### 7. Dashboard API endpoint

- [x] 7.1 Add `GET /api/feedback-loop/stats` route in `src/dashboard/server.ts` returning `{ weights, componentStats, confidenceBuckets }`
- [x] 7.2 Write route test in `src/dashboard/server.test.ts`: returns 200 with valid JSON when no trades exist (defaults), returns populated stats after trades are logged

### 8. Index + exports

- [x] 8.1 Create `src/ai/FeedbackLoop/index.ts` re-exporting all public types and singletons (`weightStore`, `componentPerformanceTracker`, `confidenceCalibrator`, `AdaptiveWeightAdjuster`)
