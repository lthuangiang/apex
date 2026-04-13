# Requirements Document

## Introduction

Phase 3 of APEX's trading system introduces a multi-signal `RegimeDetector` service that replaces the single EMA-distance heuristic with a richer four-state market regime classification: `TREND_UP`, `TREND_DOWN`, `SIDEWAY`, and `HIGH_VOLATILITY`. Each detected regime maps to a `RegimeStrategyConfig` that drives concrete behavioural adjustments across signal scoring (`AISignalEngine`), position sizing (`PositionSizer`), and trade management (`Watcher`). The feature also extends `PositionSizer` with a `volatilityFactor` input, adds a `setSlPercent()` method to `RiskManager`, and enriches the `Signal` and `SignalSnapshot` types with raw indicator fields for logging and analytics.

## Glossary

- **RegimeDetector**: Pure stateless service that computes ATR, Bollinger Band width, and volume ratio from candle arrays and classifies the current market regime.
- **Regime**: One of four market states: `TREND_UP`, `TREND_DOWN`, `SIDEWAY`, `HIGH_VOLATILITY`.
- **RegimeResult**: Output of `RegimeDetector.detect()` containing the regime label and raw indicator values (`atrPct`, `bbWidth`, `volRatio`).
- **RegimeStrategyConfig**: Per-regime configuration object specifying entry score edge, sizing factor, hold time multiplier, SL buffer multiplier, and early-exit suppression flag.
- **ATR**: Average True Range — 14-period average of the true range (max of high-low, |high-prevClose|, |low-prevClose|).
- **BB_Width**: Bollinger Band width — `(upperBand - lowerBand) / middleBand` using a 20-period, 2-std-dev band.
- **VolRatio**: Volume ratio — current candle volume divided by the 10-period average of prior candle volumes.
- **atrPct**: ATR expressed as a fraction of the current price (e.g. 0.004 = 0.4%).
- **PositionSizer**: Module that computes order size from confidence, performance, and (new) volatility inputs.
- **RiskManager**: Module that evaluates stop-loss and take-profit conditions for open positions.
- **Watcher**: State-machine module that manages the full trade lifecycle (IDLE → IN_POSITION → IDLE).
- **AISignalEngine**: Module that fetches candle data, computes momentum score, calls the LLM, and returns a `Signal`.
- **Signal**: Output of `AISignalEngine.getSignal()` containing direction, confidence, score, regime, and (new) indicator fields.
- **SignalSnapshot**: Subset of signal fields persisted in `TradeRecord` for post-trade analytics.
- **ConfigStore**: Singleton that manages runtime config overrides with validation and disk persistence.
- **FARM_SL_PERCENT**: Base stop-loss percentage used in farm mode (default 0.05 = 5%).
- **FARM_SCORE_EDGE**: Base minimum score edge required to enter a trade (default 0.03).
- **FARM_MAX_HOLD_SECS**: Maximum hold time in seconds before a forced exit (default 300).
- **FARM_MIN_HOLD_SECS**: Minimum hold time in seconds after entry fill (default 120).

---

## Requirements

### Requirement 1: RegimeDetector — ATR Computation

**User Story:** As a trading system, I want to compute the Average True Range from candle data, so that I can measure market volatility for regime classification.

#### Acceptance Criteria

1. THE RegimeDetector SHALL compute ATR as the simple average of the last `REGIME_ATR_PERIOD` (default 14) true range values, where each true range is `max(high - low, |high - prevClose|, |low - prevClose|)`.
2. THE RegimeDetector SHALL express ATR as a percentage of the current price (`atrPct = atr / currentPrice`).
3. FOR ALL valid candle arrays with `closes.length > REGIME_ATR_PERIOD`, THE RegimeDetector SHALL return `atrPct >= 0`.
4. WHEN all candles have identical OHLC values, THE RegimeDetector SHALL return `atrPct = 0`.

---

### Requirement 2: RegimeDetector — Bollinger Band Width Computation

**User Story:** As a trading system, I want to compute the Bollinger Band width from close prices, so that I can distinguish trending (expanding bands) from ranging (compressed bands) markets.

#### Acceptance Criteria

1. THE RegimeDetector SHALL compute BB width as `(upperBand - lowerBand) / middleBand` using the last `REGIME_BB_PERIOD` (default 20) closes, with `REGIME_BB_STD_DEV` (default 2) standard deviations.
2. FOR ALL valid closes arrays with `closes.length >= REGIME_BB_PERIOD`, THE RegimeDetector SHALL return `bbWidth >= 0`.
3. WHEN all closes in the lookback window are identical, THE RegimeDetector SHALL return `bbWidth = 0`.
4. WHEN `closes.length < REGIME_BB_PERIOD`, THE RegimeDetector SHALL use the available closes rather than throwing an error.

---

### Requirement 3: RegimeDetector — Volume Ratio Computation

**User Story:** As a trading system, I want to compute the volume ratio relative to recent average volume, so that I can confirm regime signals with volume participation.

#### Acceptance Criteria

1. THE RegimeDetector SHALL compute `volRatio` as `currentVolume / avg(volumes[-REGIME_VOL_LOOKBACK-1 : -1])` using the last `REGIME_VOL_LOOKBACK` (default 10) prior candles as the average baseline.
2. FOR ALL valid volumes arrays with `volumes.length >= 2`, THE RegimeDetector SHALL return `volRatio >= 0`.
3. WHEN `volumes.length < 2`, THE RegimeDetector SHALL return `volRatio = 1.0` (neutral — insufficient data).
4. WHEN the average volume is zero, THE RegimeDetector SHALL return `volRatio = 1.0` (neutral — avoids division by zero).

---

### Requirement 4: RegimeDetector — Regime Classification

**User Story:** As a trading system, I want to classify the current market into one of four regimes, so that downstream components can adapt their behaviour to market conditions.

#### Acceptance Criteria

1. THE RegimeDetector.detect() SHALL always return exactly one of the four valid regime values: `TREND_UP`, `TREND_DOWN`, `SIDEWAY`, or `HIGH_VOLATILITY`.
2. WHEN `atrPct > REGIME_HIGH_VOL_THRESHOLD` (default 0.005), THE RegimeDetector SHALL classify the regime as `HIGH_VOLATILITY` regardless of EMA distance or BB width.
3. WHEN `atrPct <= REGIME_HIGH_VOL_THRESHOLD` AND `currentPrice > ema21Last * (1 + REGIME_TREND_EMA_BAND)` AND `bbWidth > REGIME_BB_TREND_MIN`, THE RegimeDetector SHALL classify the regime as `TREND_UP`.
4. WHEN `atrPct <= REGIME_HIGH_VOL_THRESHOLD` AND `currentPrice < ema21Last * (1 - REGIME_TREND_EMA_BAND)` AND `bbWidth > REGIME_BB_TREND_MIN`, THE RegimeDetector SHALL classify the regime as `TREND_DOWN`.
5. WHEN none of the above conditions are met, THE RegimeDetector SHALL classify the regime as `SIDEWAY`.
6. THE RegimeDetector.detect() SHALL perform no I/O operations (pure synchronous function).

---

### Requirement 5: RegimeStrategyConfig — Per-Regime Behaviour Specification

**User Story:** As a trading system, I want each market regime to map to a concrete strategy configuration, so that entry thresholds, position sizing, hold times, and stop-loss buffers are automatically adjusted to match market conditions.

#### Acceptance Criteria

1. THE RegimeStrategyConfig for `TREND_UP` and `TREND_DOWN` SHALL have `entryScoreEdge = 0.02`, `volatilitySizingFactor = 1.0`, `holdMultiplier = REGIME_TREND_HOLD_MULT`, `slBufferMultiplier = 1.0`, and `suppressEarlyExit = REGIME_TREND_SUPPRESS_EARLY_EXIT`.
2. THE RegimeStrategyConfig for `SIDEWAY` SHALL have `entryScoreEdge = 0.05`, `volatilitySizingFactor = REGIME_SIDEWAY_SIZE_FACTOR`, `holdMultiplier = REGIME_SIDEWAY_HOLD_MULT`, `slBufferMultiplier = 1.0`, and `suppressEarlyExit = false`.
3. THE RegimeStrategyConfig for `HIGH_VOLATILITY` SHALL have `entryScoreEdge = 0.08`, `volatilitySizingFactor = REGIME_HIGH_VOL_SIZE_FACTOR`, `holdMultiplier = REGIME_HIGH_VOL_HOLD_MULT`, `slBufferMultiplier = REGIME_HIGH_VOL_SL_MULT`, and `skipEntry = REGIME_HIGH_VOL_SKIP_ENTRY`.
4. FOR ALL four regime values, `getRegimeStrategyConfig(regime).slBufferMultiplier` SHALL be `>= 1.0` (regime never tightens the stop loss).
5. FOR ALL four regime values, `getRegimeStrategyConfig(regime).volatilitySizingFactor` SHALL be in `(0, 1]` (regime never amplifies position size).
6. FOR ALL four regime values, `getRegimeStrategyConfig(regime)` SHALL return a fully populated `RegimeStrategyConfig` with no undefined fields.

---

### Requirement 6: PositionSizer — Volatility Factor Extension

**User Story:** As a trading system, I want the position sizer to accept a regime-based volatility factor, so that position sizes are automatically reduced in high-volatility or ranging market conditions.

#### Acceptance Criteria

1. THE PositionSizer SHALL accept an optional `volatilityFactor` field in `SizingInput` with type `number | undefined`.
2. WHEN `volatilityFactor` is provided, THE PositionSizer SHALL apply it as a multiplier on the raw size after the combined confidence/performance multiplier: `rawSize = baseSize * combined * volatilityFactor`.
3. WHEN `volatilityFactor` is not provided or is `undefined`, THE PositionSizer SHALL default to `1.0` (no change to existing behaviour).
4. THE PositionSizer SHALL clamp `volatilityFactor` to `[0.1, 1.0]` before applying it, preventing both amplification and near-zero sizes.
5. THE SizingResult SHALL include a `volatilityFactor` field reflecting the clamped value actually used.
6. FOR ANY `SizingInput`, `computeSize({ ...input, volatilityFactor: f1 }).size <= computeSize({ ...input, volatilityFactor: f2 }).size` WHEN `f1 <= f2` (lower factor produces smaller or equal size).

---

### Requirement 7: RiskManager — Runtime SL Override

**User Story:** As a trading system, I want to set the stop-loss percentage at runtime per trade, so that the Watcher can apply regime-specific SL buffers without modifying the global config.

#### Acceptance Criteria

1. THE RiskManager SHALL expose a `setSlPercent(pct: number)` method that overrides the SL percentage used in `shouldClose()` for farm mode.
2. WHEN `setSlPercent(pct)` is called, THE RiskManager SHALL use `pct` instead of `config.FARM_SL_PERCENT` in all subsequent `shouldClose()` evaluations until overridden again.
3. WHEN `setSlPercent` has not been called, THE RiskManager SHALL continue to use `config.FARM_SL_PERCENT` as the default (backward-compatible behaviour).

---

### Requirement 8: Watcher — Regime-Adaptive Entry

**User Story:** As a trading system, I want the Watcher to apply regime-specific entry rules when deciding whether to open a position, so that entries are filtered and sized appropriately for the current market regime.

#### Acceptance Criteria

1. WHEN the Watcher is in IDLE state and receives a signal, THE Watcher SHALL look up the `RegimeStrategyConfig` for `signal.regime`.
2. WHEN `regimeConfig.skipEntry` is `true`, THE Watcher SHALL skip the entry, log the reason, and return without placing an order.
3. WHEN `regimeConfig.skipEntry` is `false`, THE Watcher SHALL use `regimeConfig.entryScoreEdge` as the minimum score edge threshold instead of `config.FARM_SCORE_EDGE`.
4. THE Watcher SHALL pass `regimeConfig.volatilitySizingFactor` as `volatilityFactor` to `PositionSizer.computeSize()`.
5. THE Watcher SHALL compute `holdSecs = round(baseHoldSecs * regimeConfig.holdMultiplier)` and clamp the result to `[FARM_MIN_HOLD_SECS, FARM_MAX_HOLD_SECS * 2]`.
6. WHEN `holdSecs` is computed with any valid `holdMultiplier`, THE Watcher SHALL ensure `holdSecs >= FARM_MIN_HOLD_SECS`.
7. THE Watcher SHALL compute `effectiveSlPercent = config.FARM_SL_PERCENT * regimeConfig.slBufferMultiplier` and pass it to `RiskManager.setSlPercent()` before placing the entry order.
8. WHEN `effectiveSlPercent` is computed with any valid `slBufferMultiplier >= 1.0`, THE Watcher SHALL ensure `effectiveSlPercent >= config.FARM_SL_PERCENT` (regime never tightens SL).

---

### Requirement 9: Watcher — Regime-Adaptive Exit

**User Story:** As a trading system, I want the Watcher to suppress early profit exits during strong trends, so that winning trend trades are held longer to capture more of the move.

#### Acceptance Criteria

1. WHEN the Watcher is IN_POSITION and the `FARM_EARLY_PROFIT` trigger condition is met AND `regimeConfig.suppressEarlyExit` is `true`, THE Watcher SHALL suppress the early exit and continue holding.
2. WHEN the Watcher is IN_POSITION and the `FARM_EARLY_PROFIT` trigger condition is met AND `regimeConfig.suppressEarlyExit` is `false`, THE Watcher SHALL proceed with the normal early exit logic.
3. THE Watcher SHALL evaluate `suppressEarlyExit` using the regime stored in the signal snapshot at entry time, not the current live regime.

---

### Requirement 10: AISignalEngine — RegimeDetector Integration

**User Story:** As a trading system, I want AISignalEngine to use the new RegimeDetector for regime classification, so that the richer four-state regime (including HIGH_VOLATILITY) is available to all downstream components.

#### Acceptance Criteria

1. THE AISignalEngine SHALL replace the inline three-state EMA-distance regime detection with a call to `RegimeDetector.detect(closes, highs, lows, volumes, ema21Last)`.
2. THE Signal returned by AISignalEngine SHALL include `atrPct`, `bbWidth`, and `volRatio` fields populated from the `RegimeResult`.
3. THE Signal returned by AISignalEngine SHALL include `regime` as one of the four valid `Regime` values (including `HIGH_VOLATILITY`).
4. WHEN `RegimeDetector.detect()` is called, THE AISignalEngine SHALL pass the same candle arrays already fetched for momentum score computation (no additional API calls).

---

### Requirement 11: Signal and SignalSnapshot — Indicator Field Extensions

**User Story:** As a trading system, I want the Signal and SignalSnapshot types to carry raw indicator values, so that regime context is available for logging, analytics, and future per-regime performance tracking.

#### Acceptance Criteria

1. THE Signal interface SHALL include optional fields `atrPct?: number`, `bbWidth?: number`, and `volRatio?: number`.
2. THE SignalSnapshot interface in TradeLogger SHALL include optional fields `atrPct?: number`, `bbWidth?: number`, and `volRatio?: number`.
3. THE Watcher SHALL populate `atrPct`, `bbWidth`, and `volRatio` in the `signalSnapshot` stored in `_pendingEntrySignalMeta` at entry time.
4. THE TradeRecord persisted at exit time SHALL include `atrPct`, `bbWidth`, and `volRatio` when they were present in the entry signal.

---

### Requirement 12: Config — REGIME_* Keys

**User Story:** As a system operator, I want all regime detection and strategy parameters to be configurable via the standard config system, so that thresholds and multipliers can be tuned without code changes.

#### Acceptance Criteria

1. THE `config.ts` SHALL include all `REGIME_*` keys with the following defaults: `REGIME_ATR_PERIOD: 14`, `REGIME_BB_PERIOD: 20`, `REGIME_BB_STD_DEV: 2`, `REGIME_VOL_LOOKBACK: 10`, `REGIME_HIGH_VOL_THRESHOLD: 0.005`, `REGIME_TREND_EMA_BAND: 0.002`, `REGIME_BB_TREND_MIN: 0.01`, `REGIME_TREND_HOLD_MULT: 1.5`, `REGIME_SIDEWAY_HOLD_MULT: 0.8`, `REGIME_HIGH_VOL_HOLD_MULT: 0.7`, `REGIME_HIGH_VOL_SIZE_FACTOR: 0.5`, `REGIME_SIDEWAY_SIZE_FACTOR: 0.85`, `REGIME_HIGH_VOL_SL_MULT: 1.5`, `REGIME_HIGH_VOL_SKIP_ENTRY: false`, `REGIME_TREND_SUPPRESS_EARLY_EXIT: true`.
2. THE `ConfigStore` SHALL expose all `REGIME_*` keys in `OverridableConfig`, the `OVERRIDABLE_KEYS` array, and `extractBase()`.
3. IF `REGIME_HIGH_VOL_SIZE_FACTOR > 1.0` is submitted as an override, THEN THE ConfigStore SHALL reject it with a validation error.
4. IF `REGIME_SIDEWAY_SIZE_FACTOR > 1.0` is submitted as an override, THEN THE ConfigStore SHALL reject it with a validation error.
5. IF `REGIME_HIGH_VOL_SL_MULT < 1.0` is submitted as an override, THEN THE ConfigStore SHALL reject it with a validation error.
6. IF `REGIME_HIGH_VOL_THRESHOLD <= 0` is submitted as an override, THEN THE ConfigStore SHALL reject it with a validation error.
7. WHEN valid `REGIME_*` overrides are persisted to disk and the system restarts, THE ConfigStore SHALL restore those overrides correctly via `loadFromDisk()`.
