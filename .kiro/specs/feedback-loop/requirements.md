# Requirements: Feedback Loop (Phase 1)

## Introduction

The Feedback Loop feature closes the signal-to-outcome gap in APEX by tracking per-component signal accuracy, dynamically reweighting the `momentumScore` formula in `AISignalEngine`, and calibrating LLM confidence values using historical win rates. Trade outcome attribution (2.1) is already complete via `TradeRecord`/`TradeLogger` and is not re-specified here.

---

## Requirements

### 1. Component Performance Tracking

#### 1.1 EMA Component Attribution

**User Story**: As the trading bot, I want to track how often the EMA trend signal (ema9 > ema21 = bullish, ema9 < ema21 = bearish) correctly predicts trade outcomes, so that the adaptive weight system has accurate EMA performance data.

**Acceptance Criteria**:

- [ ] 1.1.1 — Given a `TradeRecord` where `ema9` and `ema21` are present, the system SHALL classify the EMA prediction as `long` if `ema9 > ema21`, else `short`.
- [ ] 1.1.2 — A trade is counted as an EMA win if the EMA prediction matches `trade.direction` AND `trade.pnl > 0`.
- [ ] 1.1.3 — The EMA `winRate` is computed as `wins / total` where `total` is the count of trades with EMA data present; `winRate = 0` when `total = 0`.
- [ ] 1.1.4 — `wins <= total` is always true for the EMA component.

#### 1.2 RSI Component Attribution

**User Story**: As the trading bot, I want to track RSI reversal accuracy only when RSI is in an extreme zone (oversold < 35 or overbought > 65), so that neutral RSI readings do not dilute the performance signal.

**Acceptance Criteria**:

- [ ] 1.2.1 — Given a `TradeRecord` where `rsi < 35`, the RSI prediction is `long`; where `rsi > 65`, the prediction is `short`; otherwise the trade is excluded from RSI stats.
- [ ] 1.2.2 — A trade is counted as an RSI win if the RSI prediction matches `trade.direction` AND `trade.pnl > 0`.
- [ ] 1.2.3 — The RSI `lossStreak` tracks the current consecutive run of RSI-attributed losses (prediction matched direction but `pnl <= 0`, or prediction did not match direction).
- [ ] 1.2.4 — `wins <= total` is always true for the RSI component.

#### 1.3 Momentum Component Attribution

**User Story**: As the trading bot, I want to track whether the 3-candle price momentum direction correctly predicts trade outcomes, so that the weight system can reward or penalise momentum signals.

**Acceptance Criteria**:

- [ ] 1.3.1 — Given a `TradeRecord` where `momentum3candles` is present, the momentum prediction is `long` if `momentum3candles > 0`, else `short`.
- [ ] 1.3.2 — A trade is counted as a momentum win if the prediction matches `trade.direction` AND `trade.pnl > 0`.
- [ ] 1.3.3 — `wins <= total` is always true for the momentum component.

#### 1.4 Orderbook Imbalance Component Attribution

**User Story**: As the trading bot, I want to track whether orderbook imbalance (imbalance > 1 = bullish) correctly predicts trade outcomes, so that the weight system can adapt to changing market microstructure.

**Acceptance Criteria**:

- [ ] 1.4.1 — Given a `TradeRecord` where `imbalance` is present, the imbalance prediction is `long` if `imbalance > 1`, else `short`.
- [ ] 1.4.2 — A trade is counted as an imbalance win if the prediction matches `trade.direction` AND `trade.pnl > 0`.
- [ ] 1.4.3 — `wins <= total` is always true for the imbalance component.

#### 1.5 Lookback Window

**User Story**: As the trading bot, I want component stats to be computed over a configurable rolling window of recent trades, so that the system adapts to current market conditions rather than being anchored to stale history.

**Acceptance Criteria**:

- [ ] 1.5.1 — Component stats are computed over the last `LOOKBACK_N` trades (default 50), sorted descending by timestamp.
- [ ] 1.5.2 — If fewer than `LOOKBACK_N` trades exist, all available trades are used.
- [ ] 1.5.3 — The `ComponentStats.lookbackN` field reflects the actual number of trades analysed.

---

### 2. Adaptive Weight Adjustment

#### 2.1 Weight Adjustment Rules

**User Story**: As the trading bot, I want signal weights to increase for high-performing components and decrease for underperforming ones, so that the `momentumScore` formula automatically favours the most reliable signals.

**Acceptance Criteria**:

- [ ] 2.1.1 — If `ema.winRate > 0.60` AND `ema.total >= MIN_STAT_TRADES`, the EMA weight SHALL increase by `WEIGHT_STEP = 0.05` before normalisation.
- [ ] 2.1.2 — If `ema.winRate < 0.40` AND `ema.total >= MIN_STAT_TRADES`, the EMA weight SHALL decrease by `WEIGHT_STEP`.
- [ ] 2.1.3 — If `rsi.lossStreak > RSI_LOSS_STREAK_THRESHOLD (3)` AND `rsi.total >= MIN_STAT_TRADES`, the RSI weight SHALL decrease by `WEIGHT_STEP`.
- [ ] 2.1.4 — If `rsi.winRate > 0.60` AND `rsi.total >= MIN_STAT_TRADES`, the RSI weight SHALL increase by `WEIGHT_STEP`.
- [ ] 2.1.5 — Momentum and imbalance weights follow the same `> 0.60` / `< 0.40` rules as EMA.
- [ ] 2.1.6 — If a component's `total < MIN_STAT_TRADES`, its weight is NOT adjusted in that cycle.

#### 2.2 Weight Bounds

**User Story**: As the trading bot, I want each signal weight to stay within safe bounds, so that no single component dominates or disappears from the score formula.

**Acceptance Criteria**:

- [ ] 2.2.1 — After adjustment and before normalisation, each weight is clamped to `[MIN_WEIGHT, MAX_WEIGHT]` = `[0.05, 0.60]`.
- [ ] 2.2.2 — After normalisation, each weight is strictly greater than 0.

#### 2.3 Weight Sum Invariant

**User Story**: As the trading bot, I want the four signal weights to always sum to 1.0, so that the `momentumScore` formula remains mathematically equivalent to the original.

**Acceptance Criteria**:

- [ ] 2.3.1 — After any call to `adjustWeights()`, the sum of all four weights SHALL be in `[0.999, 1.001]`.
- [ ] 2.3.2 — The `DEFAULT_WEIGHTS` (`{ ema: 0.40, rsi: 0.25, momentum: 0.20, imbalance: 0.15 }`) sum to exactly 1.0.

#### 2.4 Recalculation Frequency

**User Story**: As the trading bot, I want weights to be recalculated every N completed trades (default N=10), so that the system adapts regularly without being noisy on every single trade.

**Acceptance Criteria**:

- [ ] 2.4.1 — The `ComponentPerformanceTracker` SHALL trigger a weight recalculation after every `RECALC_EVERY_N` (default 10) calls to `onTradeLogged()`.
- [ ] 2.4.2 — The trade counter resets to 0 after each recalculation.
- [ ] 2.4.3 — A recalculation failure (e.g. I/O error reading trades) SHALL NOT reset the counter; the system retries on the next trade.

#### 2.5 Weight Persistence

**User Story**: As the trading bot, I want adaptive weights to survive a process restart, so that learned performance data is not lost between sessions.

**Acceptance Criteria**:

- [ ] 2.5.1 — After `setWeights(w)`, calling `loadFromDisk()` on a new `WeightStore` instance SHALL return weights equal to `w` (round-trip fidelity).
- [ ] 2.5.2 — Weights are persisted to `signal-weights.json` in the process working directory.
- [ ] 2.5.3 — `loadFromDisk()` is called at bot startup before the first signal is computed.

#### 2.6 Default Fallback

**User Story**: As the trading bot, I want the system to fall back to static default weights if the weights file is missing or corrupt, so that the bot always starts successfully.

**Acceptance Criteria**:

- [ ] 2.6.1 — If `signal-weights.json` does not exist, `getWeights()` returns `DEFAULT_WEIGHTS`.
- [ ] 2.6.2 — If `signal-weights.json` contains invalid JSON or weights that fail validation (sum ≠ 1.0 or out-of-bounds values), `getWeights()` returns `DEFAULT_WEIGHTS` and logs a warning.
- [ ] 2.6.3 — The fallback does not throw an exception.

#### 2.7 AISignalEngine Integration

**User Story**: As the trading bot, I want `AISignalEngine` to use the current adaptive weights when computing `momentumScore`, so that the feedback loop actually influences trading decisions.

**Acceptance Criteria**:

- [ ] 2.7.1 — `AISignalEngine._fetchSignal()` SHALL call `weightStore.getWeights()` and use the returned weights in the `momentumScore` formula.
- [ ] 2.7.2 — The static weight constants (`0.40`, `0.25`, `0.20`, `0.15`) SHALL be removed from `AISignalEngine`.
- [ ] 2.7.3 — If `weightStore.getWeights()` returns weights that sum to 1.0, the `momentumScore` range `[0, 1]` is preserved.

---

### 3. Confidence Calibration

#### 3.1 Bucket-Based Calibration Formula

**User Story**: As the trading bot, I want LLM confidence values to be adjusted based on how well that confidence range has historically predicted outcomes, so that overconfident signals are penalised and underconfident signals are rewarded.

**Acceptance Criteria**:

- [ ] 3.1.1 — The calibration formula is `adjusted = rawConfidence × (historicalWinRate / BASELINE_WIN_RATE)` where `BASELINE_WIN_RATE = 0.50`.
- [ ] 3.1.2 — Confidence buckets are: `[0.5, 0.6)`, `[0.6, 0.7)`, `[0.7, 0.8)`, `[0.8, 1.0]`.
- [ ] 3.1.3 — The `historicalWinRate` for a bucket is `wins / total` where `wins` counts trades in that bucket with `pnl > 0`.

#### 3.2 Sparse Data Guard

**User Story**: As the trading bot, I want confidence calibration to be skipped when there is insufficient data in a bucket, so that the system does not overfit on a handful of trades.

**Acceptance Criteria**:

- [ ] 3.2.1 — If a confidence bucket contains fewer than `MIN_BUCKET_TRADES = 5` trades, `calibrate()` SHALL return `rawConfidence` unchanged.
- [ ] 3.2.2 — If `rawConfidence` does not fall into any defined bucket, `calibrate()` SHALL return `rawConfidence` unchanged.

#### 3.3 Calibrated Confidence Range

**User Story**: As the trading bot, I want calibrated confidence to always be a valid value in `[0.10, 1.00]`, so that downstream confidence filters (e.g. `MIN_CONFIDENCE`) continue to work correctly.

**Acceptance Criteria**:

- [ ] 3.3.1 — `calibrate()` output is always clamped to `[0.10, 1.00]` regardless of input or historical win rate.
- [ ] 3.3.2 — `calibrate()` never returns `NaN`, `Infinity`, or a negative value.

#### 3.4 AISignalEngine Calibration Integration

**User Story**: As the trading bot, I want the confidence value returned by `AISignalEngine` to be calibrated before it is used for trade filtering, so that the calibration actually affects entry decisions.

**Acceptance Criteria**:

- [ ] 3.4.1 — After obtaining `decision.confidence` from the LLM (or fallback), `AISignalEngine` SHALL call `confidenceCalibrator.calibrate(rawConf, recentTrades)`.
- [ ] 3.4.2 — The calibrated confidence is used in the returned `Signal` object.
- [ ] 3.4.3 — The `recentTrades` passed to `calibrate()` are the last 50 trades from `TradeLogger`.

---

### 4. Observability

#### 4.1 Dashboard API Endpoint

**User Story**: As an operator, I want a dashboard API endpoint that exposes current adaptive weights, component stats, and confidence bucket data, so that I can monitor the feedback loop without reading raw files.

**Acceptance Criteria**:

- [ ] 4.1.1 — A `GET /api/feedback-loop/stats` endpoint SHALL return a JSON response containing: `weights` (current `SignalWeights`), `componentStats` (latest `ComponentStats`), and `confidenceBuckets` (array of `ConfidenceBucket`).
- [ ] 4.1.2 — The endpoint returns HTTP 200 with valid JSON even when no trades have been logged yet (returns default weights and empty stats).
- [ ] 4.1.3 — The endpoint does not trigger a weight recalculation.
