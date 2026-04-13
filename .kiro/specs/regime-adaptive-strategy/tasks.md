# Tasks: Regime-Adaptive Strategy (Phase 3)

## Implementation Plan

### 1. Config — add REGIME_* keys

- [x] 1.1 In `src/config.ts`, add all 15 `REGIME_*` keys with defaults: `REGIME_ATR_PERIOD: 14`, `REGIME_BB_PERIOD: 20`, `REGIME_BB_STD_DEV: 2`, `REGIME_VOL_LOOKBACK: 10`, `REGIME_HIGH_VOL_THRESHOLD: 0.005`, `REGIME_TREND_EMA_BAND: 0.002`, `REGIME_BB_TREND_MIN: 0.01`, `REGIME_TREND_HOLD_MULT: 1.5`, `REGIME_SIDEWAY_HOLD_MULT: 0.8`, `REGIME_HIGH_VOL_HOLD_MULT: 0.7`, `REGIME_HIGH_VOL_SIZE_FACTOR: 0.5`, `REGIME_SIDEWAY_SIZE_FACTOR: 0.85`, `REGIME_HIGH_VOL_SL_MULT: 1.5`, `REGIME_HIGH_VOL_SKIP_ENTRY: false`, `REGIME_TREND_SUPPRESS_EARLY_EXIT: true`
- [x] 1.2 In `src/config/ConfigStore.ts`, add all `REGIME_*` keys to the `OverridableConfig` type, the `OVERRIDABLE_KEYS` array, and the `extractBase()` function

### 2. Config validation — REGIME_* rules

- [x] 2.1 In `src/config/validateOverrides.ts`, add validation rules for `REGIME_*` keys:
  - `REGIME_HIGH_VOL_SIZE_FACTOR` must be in `(0, 1]`
  - `REGIME_SIDEWAY_SIZE_FACTOR` must be in `(0, 1]`
  - `REGIME_HIGH_VOL_SL_MULT` must be `>= 1.0`
  - `REGIME_HIGH_VOL_THRESHOLD` must be `> 0`
  - `REGIME_TREND_HOLD_MULT`, `REGIME_SIDEWAY_HOLD_MULT`, `REGIME_HIGH_VOL_HOLD_MULT` must be `> 0`
  - `REGIME_ATR_PERIOD`, `REGIME_BB_PERIOD`, `REGIME_VOL_LOOKBACK` must be positive integers
- [x] 2.2 Extend `src/config/__tests__/validateOverrides.test.ts` with tests for: `REGIME_HIGH_VOL_SIZE_FACTOR > 1.0` rejection, `REGIME_HIGH_VOL_SL_MULT < 1.0` rejection, `REGIME_HIGH_VOL_THRESHOLD <= 0` rejection, valid `REGIME_*` patch acceptance

### 3. RegimeDetector — core implementation

- [x] 3.1 Create `src/ai/RegimeDetector.ts` with the `Regime` type, `RegimeResult` interface, and `RegimeDetector` class
- [x] 3.2 Implement `computeATR(highs, lows, closes, period)`: compute true range for each candle `i` as `max(high[i] - low[i], |high[i] - closes[i-1]|, |low[i] - closes[i-1]|)`, return simple average of the last `period` true ranges
- [x] 3.3 Implement `computeBBWidth(closes, period, stdDevMult)`: compute mean and population std dev of `closes.slice(-period)`, return `(mean + stdDevMult*std - (mean - stdDevMult*std)) / mean`; return `0` when mean is 0
- [x] 3.4 Implement `computeVolumeRatio(volumes, lookback)`: return `1.0` when `volumes.length < 2` or average is 0; otherwise return `volumes[last] / avg(volumes.slice(-lookback-1, -1))`
- [x] 3.5 Implement `detect(closes, highs, lows, volumes, ema21Last)`: call the three sub-algorithms, then classify using priority order (HIGH_VOLATILITY → TREND_UP → TREND_DOWN → SIDEWAY), return `RegimeResult`
- [x] 3.6 Export `getRegimeStrategyConfig(regime: Regime): RegimeStrategyConfig` from `RegimeDetector.ts` — a pure function that returns the per-regime config object reading multipliers from `config`

### 4. RegimeDetector — unit tests

- [x] 4.1 Create `src/ai/__tests__/RegimeDetector.test.ts` with example-based unit tests:
  - `computeATR`: verify true range formula for a known candle sequence, verify period averaging, verify zero-range candles return 0
  - `computeBBWidth`: verify band formula with known closes, verify zero-width when all closes identical, verify normalisation
  - `computeVolumeRatio`: verify ratio formula, verify `1.0` return when `volumes.length < 2`, verify `1.0` return when avg is 0
  - `detect`: verify HIGH_VOLATILITY wins over TREND when atrPct exceeds threshold, verify all four regime classifications with boundary inputs
  - `getRegimeStrategyConfig`: verify all four regimes return complete configs, verify `slBufferMultiplier >= 1.0` for all, verify `volatilitySizingFactor <= 1.0` for all

### 5. RegimeDetector — property-based tests

- [x] 5.1 Create `src/ai/__tests__/RegimeDetector.properties.test.ts` using `fast-check` with minimum 100 iterations per property:
  - **Property 1** (regime completeness): for any candle arrays of length >= 20, `detect()` returns one of the four valid regime values — validates Requirements 4.1
  - **Property 2** (HIGH_VOLATILITY priority): for any candle arrays where computed `atrPct > REGIME_HIGH_VOL_THRESHOLD`, `detect().regime === 'HIGH_VOLATILITY'` — validates Requirements 4.2
  - **Property 3** (ATR non-negativity): for any valid candle arrays, `computeATR()` returns `>= 0` — validates Requirements 1.3
  - **Property 4** (BB width non-negativity): for any valid closes array, `computeBBWidth()` returns `>= 0` — validates Requirements 2.2
  - **Property 5** (volume ratio non-negativity): for any volumes array with length >= 2, `computeVolumeRatio()` returns `>= 0` — validates Requirements 3.2
  - **Property 6** (volume ratio neutral): for any volumes array with length < 2, `computeVolumeRatio()` returns `1.0` — validates Requirements 3.3
  - **Property 7** (SL never tightens): for all four regime values, `getRegimeStrategyConfig(regime).slBufferMultiplier >= 1.0` — validates Requirements 5.4
  - **Property 8** (sizing factor never amplifies): for all four regime values, `getRegimeStrategyConfig(regime).volatilitySizingFactor ∈ (0, 1]` — validates Requirements 5.5
  - **Property 9** (config completeness): for all four regime values, `getRegimeStrategyConfig(regime)` has no undefined fields — validates Requirements 5.6

### 6. PositionSizer — volatilityFactor extension

- [x] 6.1 In `src/modules/PositionSizer.ts`, add optional `volatilityFactor?: number` to the `SizingInput` interface
- [x] 6.2 In `src/modules/PositionSizer.ts`, add `volatilityFactor: number` to the `SizingResult` interface
- [x] 6.3 In `PositionSizer.computeSize()`, after computing `rawSize = baseSize * combined`, read `volFactor = clamp(input.volatilityFactor ?? 1.0, 0.1, 1.0)`, apply `rawSize *= volFactor`, and include `volatilityFactor: volFactor` in the returned `SizingResult`

### 7. PositionSizer — volatilityFactor tests

- [x] 7.1 Extend `src/modules/__tests__/PositionSizer.test.ts` with example-based tests: calling `computeSize` without `volatilityFactor` produces same result as with `volatilityFactor: 1.0`; calling with `volatilityFactor: 0.5` produces a size <= the same call with `volatilityFactor: 1.0`; out-of-range values (0.0, 1.5) are clamped correctly; `SizingResult.volatilityFactor` reflects the clamped value
- [x] 7.2 Extend `src/modules/__tests__/PositionSizer.properties.test.ts` with:
  - **Property** (volatility factor monotonicity): for any `SizingInput` and `f1 <= f2` both in `[0.1, 1.0]`, `computeSize({...input, volatilityFactor: f1}).size <= computeSize({...input, volatilityFactor: f2}).size` — validates Requirements 6.6

### 8. RiskManager — setSlPercent method

- [x] 8.1 In `src/modules/RiskManager.ts`, add a private `_slPercent: number | null = null` field and a `setSlPercent(pct: number): void` method that sets `this._slPercent = pct`
- [x] 8.2 In `RiskManager.shouldClose()`, replace the hardcoded `config.FARM_SL_PERCENT` reference with `this._slPercent ?? config.FARM_SL_PERCENT` so the runtime override takes effect when set

### 9. Watcher — regime-adaptive entry

- [x] 9.1 In `src/modules/Watcher.ts`, import `getRegimeStrategyConfig` from `src/ai/RegimeDetector.ts`
- [x] 9.2 In the IDLE state entry block, after `finalDirection` is determined, call `const regimeConfig = getRegimeStrategyConfig(signal.regime)` and implement the `skipEntry` guard (log and return if true)
- [x] 9.3 Replace the `config.FARM_SCORE_EDGE` threshold check with `regimeConfig.entryScoreEdge`
- [x] 9.4 Pass `volatilityFactor: regimeConfig.volatilitySizingFactor` to `this.positionSizer.computeSize()`
- [x] 9.5 Compute `holdSecs = Math.round(baseHoldSecs * regimeConfig.holdMultiplier)` and clamp to `[config.FARM_MIN_HOLD_SECS, config.FARM_MAX_HOLD_SECS * 2]` before setting `this.farmHoldUntil`
- [x] 9.6 Compute `effectiveSlPercent = config.FARM_SL_PERCENT * regimeConfig.slBufferMultiplier` and call `this.riskManager.setSlPercent(effectiveSlPercent)` before placing the entry order
- [x] 9.7 Add a regime log line at entry: `🎯 [REGIME] ${signal.regime} | ATR: ${(signal.atrPct*100).toFixed(3)}% | BB: ${(signal.bbWidth*100).toFixed(2)}% | Vol: ${signal.volRatio.toFixed(2)}x | Hold: ${holdSecs}s | SL: ${(effectiveSlPercent*100).toFixed(2)}%`

### 10. Watcher — regime-adaptive exit

- [x] 10.1 In the IN_POSITION early-exit block, wrap the `FARM_EARLY_PROFIT` trigger with a `regimeConfig.suppressEarlyExit` check: if `suppressEarlyExit` is true, log the suppression and skip the exit; otherwise proceed with normal early exit logic
- [x] 10.2 Ensure `regimeConfig` is read from the signal snapshot stored at entry time (`_pendingEntrySignalMeta.signalSnapshot.regime`), not from a fresh signal fetch

### 11. AISignalEngine — RegimeDetector integration

- [x] 11.1 In `src/ai/AISignalEngine.ts`, import `RegimeDetector` from `./RegimeDetector`
- [x] 11.2 Replace the inline three-state regime detection block (`if (currentPrice > ema21Last * 1.002) ...`) with `const regimeDetector = new RegimeDetector(); const regimeResult = regimeDetector.detect(closes, highs, lows, volumes, ema21Last); const { regime, atrPct, bbWidth, volRatio } = regimeResult;`
- [x] 11.3 Add `atrPct`, `bbWidth`, and `volRatio` to the `Signal` interface in `src/modules/SignalEngine.ts` (or wherever `Signal` is defined) as optional fields
- [x] 11.4 Include `atrPct`, `bbWidth`, and `volRatio` in both the normal and fallback `Signal` return objects in `_fetchSignal()`
- [x] 11.5 Update the `regime` type in `Signal` from `'TREND_UP' | 'TREND_DOWN' | 'SIDEWAY'` to include `'HIGH_VOLATILITY'`

### 12. TradeLogger — SignalSnapshot extension

- [x] 12.1 In `src/ai/TradeLogger.ts`, add optional fields `atrPct?: number`, `bbWidth?: number`, `volRatio?: number` to the `SignalSnapshot` interface
- [x] 12.2 In `src/modules/Watcher.ts`, populate `atrPct`, `bbWidth`, and `volRatio` in the `signalSnapshot` object stored in `_pendingEntrySignalMeta` at entry time using `signal.atrPct`, `signal.bbWidth`, `signal.volRatio`
- [x] 12.3 In `TradeLogger.log()` (SQLite path), add migration columns `atr_pct REAL`, `bb_width REAL`, `vol_ratio REAL` to `_migrate()` and include them in the INSERT statement

### 13. Config persistence — REGIME_* round-trip

- [x] 13.1 Extend `src/config/__tests__/ConfigStore.test.ts` to verify that `REGIME_*` overrides are correctly persisted to disk and restored via `loadFromDisk()` on a fresh `ConfigStore` instance

### 14. Integration verification

- [x] 14.1 Run the existing `AISignalEngine.test.ts` suite and verify all tests still pass after the `RegimeDetector` integration (no behaviour regression)
- [x] 14.2 Run the existing `PositionSizer.properties.test.ts` suite and verify all existing properties still pass after the `volatilityFactor` extension
