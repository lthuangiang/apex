# Requirements Document

## Introduction

Feature **farm-signal-cost-optimizer** tối ưu hóa chi phí giao dịch trong farm mode của trading bot. Mục tiêu là maximize volume (số lượng trade × notional) trong khi minimize net cost = total fees paid − rebate earned − PnL. Dựa trên phân tích 1000+ trades thực tế, hệ thống hiện tại có 6 vấn đề chính: tradePressure không được dùng để filter, fee ăn mòn gross profit, LLM-Momentum mismatch, fallback trades chất lượng thấp, holding time quá ngắn, và direction-reasoning mâu thuẫn. Feature này implement 6 bộ lọc/điều chỉnh để giải quyết từng vấn đề.

## Glossary

- **Watcher**: Module chính điều phối entry/exit logic (`src/modules/Watcher.ts`)
- **AISignalEngine**: Module tạo signal giao dịch (`src/ai/AISignalEngine.ts`)
- **AnalyticsEngine**: Module phân tích hiệu suất trades (`src/ai/AnalyticsEngine.ts`)
- **ConfigStore**: Module quản lý config per-bot (`src/config/ConfigStore.ts`)
- **Signal**: Object chứa thông tin signal giao dịch (direction, confidence, regime, v.v.)
- **tradePressure**: Tỷ lệ buy volume / total volume từ recent trades (0–1)
- **confidence**: Độ tin cậy của signal (0–1)
- **momentumScore**: Điểm momentum kỹ thuật (0–1, >0.5 = bullish)
- **atrPct**: ATR percentage — đo lường volatility của thị trường
- **bbWidth**: Bollinger Band width — đo lường mức độ nén/mở rộng của giá
- **regime**: Trạng thái thị trường: `SIDEWAY`, `TREND_UP`, hoặc `TREND_DOWN`
- **fallback**: Signal được tạo bởi fallback engine khi AISignalEngine lỗi
- **llmMatchesMomentum**: Boolean — LLM direction có đồng thuận với momentum direction không
- **effectiveConfidence**: Confidence sau khi áp dụng LLM-Momentum boost/penalty
- **minRequiredMove**: Mức giá tối thiểu cần di chuyển để cover fee (tính theo % notional)
- **expectedEdge**: Lợi thế kỳ vọng dựa trên momentum và volatility
- **feeBreakEvenSecs**: Thời gian tối thiểu cần giữ lệnh để price move đủ cover fee
- **dynamicMinHold**: Thời gian giữ lệnh tối thiểu động, tính từ fee và ATR
- **FeeAwareEntryFilter**: Bộ lọc entry dựa trên fee và expected edge
- **TradePressureGate**: Bộ lọc dựa trên tradePressure và confidence
- **LLMMomentumAdjuster**: Module điều chỉnh effectiveConfidence dựa trên LLM-Momentum alignment
- **FallbackQualityGate**: Bộ lọc chất lượng cho fallback signals
- **RegimeConfidenceThreshold**: Ngưỡng confidence tối thiểu theo regime
- **MinHoldTimeEnforcer**: Module enforce thời gian giữ lệnh tối thiểu dựa trên ATR

---

## Requirements

### Requirement 1: Fee-Aware Entry Filter

**User Story:** As a farm bot operator, I want the bot to only enter trades where the expected price movement is sufficient to cover fees, so that I minimize trades that win before fee but lose after fee.

#### Acceptance Criteria

1. WHEN evaluating a farm mode entry signal, THE FeeAwareEntryFilter SHALL compute `minRequiredMove = (FEE_RATE_MAKER × 2) / 1` as a percentage of position value.
2. WHEN evaluating a farm mode entry signal, THE FeeAwareEntryFilter SHALL compute `expectedEdge = |momentumScore - 0.5| × 2 × atrPct`.
3. WHEN `expectedEdge <= minRequiredMove × 1.5`, THE FeeAwareEntryFilter SHALL reject the entry signal and log the rejection reason.
4. WHEN `expectedEdge > minRequiredMove × 1.5`, THE FeeAwareEntryFilter SHALL allow the entry signal to proceed to subsequent filters.
5. THE FeeAwareEntryFilter SHALL operate only in `MODE === 'farm'` and SHALL be a no-op in `MODE === 'trade'`.
6. WHEN the FeeAwareEntryFilter rejects a signal, THE Watcher SHALL log `[FeeFilter] SKIP: edge={expectedEdge} <= minMove×1.5={threshold}` to console.

---

### Requirement 2: tradePressure Gate

**User Story:** As a farm bot operator, I want to skip low-quality trades when there is no measurable buy/sell pressure and confidence is low, so that I avoid near-random entries that waste fees.

#### Acceptance Criteria

1. WHEN `tradePressure === 0` AND `confidence < FARM_MIN_CONFIDENCE_PRESSURE_GATE`, THE TradePressureGate SHALL reject the entry signal.
2. WHEN `tradePressure > 0` OR `confidence >= FARM_MIN_CONFIDENCE_PRESSURE_GATE`, THE TradePressureGate SHALL allow the entry signal to proceed.
3. THE ConfigStore SHALL expose a config key `FARM_MIN_CONFIDENCE_PRESSURE_GATE` with default value `0.55`.
4. WHEN the TradePressureGate rejects a signal, THE Watcher SHALL log `[PressureGate] SKIP: tradePressure=0, confidence={confidence} < {threshold}` to console.
5. THE TradePressureGate SHALL operate only in `MODE === 'farm'` and SHALL be a no-op in `MODE === 'trade'`.

---

### Requirement 3: LLM-Momentum Alignment Adjustment

**User Story:** As a farm bot operator, I want the bot to reduce position sizing when LLM direction contradicts momentum, and increase it when they agree, so that sizing reflects actual signal quality.

#### Acceptance Criteria

1. WHEN `llmMatchesMomentum === false` AND `confidence < 0.65`, THE LLMMomentumAdjuster SHALL compute `effectiveConfidence = confidence × 0.80` (20% penalty).
2. WHEN `llmMatchesMomentum === true`, THE LLMMomentumAdjuster SHALL compute `effectiveConfidence = min(1.0, confidence × 1.10)` (10% boost).
3. WHEN `llmMatchesMomentum === false` AND `confidence >= 0.65`, THE LLMMomentumAdjuster SHALL leave `effectiveConfidence = confidence` unchanged.
4. WHEN `llmMatchesMomentum` is `null` or `undefined`, THE LLMMomentumAdjuster SHALL leave `effectiveConfidence = confidence` unchanged.
5. THE PositionSizer SHALL use `effectiveConfidence` (not raw `confidence`) when computing position size in farm mode.
6. THE LLMMomentumAdjuster SHALL log the adjustment applied: `[LLMAlign] confidence={raw} → effectiveConfidence={adjusted} (boost|penalty|unchanged)`.

---

### Requirement 4: Fallback Quality Gate

**User Story:** As a farm bot operator, I want to skip fallback signals with very low confidence, so that I avoid near-random entries when the primary signal engine fails.

#### Acceptance Criteria

1. WHEN `fallback === true` AND `confidence < FARM_MIN_FALLBACK_CONFIDENCE`, THE FallbackQualityGate SHALL reject the entry signal.
2. WHEN `fallback === false` OR `confidence >= FARM_MIN_FALLBACK_CONFIDENCE`, THE FallbackQualityGate SHALL allow the entry signal to proceed.
3. THE ConfigStore SHALL expose a config key `FARM_MIN_FALLBACK_CONFIDENCE` with default value `0.25`.
4. WHEN the FallbackQualityGate rejects a signal, THE Watcher SHALL log `[FallbackGate] SKIP: fallback=true, confidence={confidence} < {threshold}` to console.
5. THE FallbackQualityGate SHALL operate only in `MODE === 'farm'` and SHALL be a no-op in `MODE === 'trade'`.
6. THE FallbackQualityGate SHALL be evaluated independently of the existing `FARM_MIN_CONFIDENCE` check, which applies to all signals regardless of fallback status.

---

### Requirement 5: Regime-Specific Confidence Threshold

**User Story:** As a farm bot operator, I want the minimum confidence threshold to vary by market regime, so that the bot is more selective in sideways markets where prediction is harder.

#### Acceptance Criteria

1. WHEN `regime === 'SIDEWAY'` AND `confidence < FARM_SIDEWAY_MIN_CONFIDENCE`, THE RegimeConfidenceThreshold SHALL reject the entry signal.
2. WHEN `regime === 'TREND_UP'` OR `regime === 'TREND_DOWN'`, AND `confidence < FARM_TREND_MIN_CONFIDENCE`, THE RegimeConfidenceThreshold SHALL reject the entry signal.
3. THE ConfigStore SHALL expose a config key `FARM_SIDEWAY_MIN_CONFIDENCE` with default value `0.45`.
4. THE ConfigStore SHALL expose a config key `FARM_TREND_MIN_CONFIDENCE` with default value `0.35`.
5. WHEN the RegimeConfidenceThreshold rejects a signal, THE Watcher SHALL log `[RegimeGate] SKIP: regime={regime}, confidence={confidence} < {threshold}` to console.
6. THE RegimeConfidenceThreshold SHALL operate only in `MODE === 'farm'` and SHALL be a no-op in `MODE === 'trade'`.
7. THE RegimeConfidenceThreshold SHALL replace the existing flat `FARM_MIN_CONFIDENCE` check in farm mode entry evaluation.

---

### Requirement 6: Minimum Hold Time Enforcer

**User Story:** As a farm bot operator, I want the bot to hold positions long enough for price to move sufficiently to cover fees, so that I reduce premature exits that result in fee losses.

#### Acceptance Criteria

1. WHEN a farm mode position is entered, THE MinHoldTimeEnforcer SHALL compute `feeBreakEvenSecs = (FEE_RATE_MAKER × 2 / atrPct) × candleDurationSecs` where `candleDurationSecs = 300` (5-minute candles).
2. WHEN computing the minimum hold time, THE MinHoldTimeEnforcer SHALL compute `dynamicMinHold = max(FARM_MIN_HOLD_SECS, feeBreakEvenSecs)`.
3. WHILE `holdingTimeSecs < dynamicMinHold`, THE Watcher SHALL NOT trigger an early exit based on profit, even if `pnl > FARM_EARLY_EXIT_PNL`.
4. WHEN `holdingTimeSecs >= dynamicMinHold`, THE Watcher SHALL resume normal early-exit evaluation.
5. THE MinHoldTimeEnforcer SHALL cap `dynamicMinHold` at `FARM_MAX_HOLD_SECS` to prevent indefinite holds.
6. WHEN `atrPct === 0` or `atrPct` is unavailable, THE MinHoldTimeEnforcer SHALL fall back to `dynamicMinHold = FARM_MIN_HOLD_SECS`.
7. THE Watcher SHALL log `[MinHold] dynamicMinHold={secs}s (feeBreakEven={feeBreakEvenSecs}s, FARM_MIN={FARM_MIN_HOLD_SECS}s)` at entry time.

---

### Requirement 7: Signal Filter Pipeline Integration

**User Story:** As a farm bot operator, I want all signal filters to be applied in a consistent, ordered pipeline before any entry order is placed, so that the filtering logic is predictable and auditable.

#### Acceptance Criteria

1. THE Watcher SHALL apply farm mode entry filters in the following order: (1) RegimeConfidenceThreshold, (2) TradePressureGate, (3) FallbackQualityGate, (4) FeeAwareEntryFilter.
2. WHEN any filter in the pipeline rejects a signal, THE Watcher SHALL stop evaluating subsequent filters and skip the entry.
3. THE LLMMomentumAdjuster SHALL be applied after all gate filters pass, before position sizing.
4. WHEN all filters pass, THE Watcher SHALL proceed to LLMMomentumAdjuster → PositionSizer → entry order placement.
5. THE Watcher SHALL log a summary line `[SignalFilter] PASS: regime={regime}, confidence={conf}, pressure={pressure}, fallback={fallback}, edge={edge}` when all filters pass.
6. FOR ALL farm mode entry evaluations, THE Watcher SHALL record the filter result (pass/skip + reason) in the trade log's `signalSnapshot` field.

---

### Requirement 8: Config Defaults and Validation

**User Story:** As a developer, I want all new config keys to have sensible defaults and be validated on startup, so that misconfiguration is caught early and the bot behaves predictably out of the box.

#### Acceptance Criteria

1. THE ConfigStore SHALL include the following new keys with defaults: `FARM_MIN_CONFIDENCE_PRESSURE_GATE: 0.55`, `FARM_MIN_FALLBACK_CONFIDENCE: 0.25`, `FARM_SIDEWAY_MIN_CONFIDENCE: 0.45`, `FARM_TREND_MIN_CONFIDENCE: 0.35`.
2. WHEN any of the new config values is set to a number outside the range `[0, 1]`, THE ConfigStore SHALL throw a validation error on startup.
3. WHEN `FARM_SIDEWAY_MIN_CONFIDENCE < FARM_TREND_MIN_CONFIDENCE`, THE ConfigStore SHALL log a warning `[Config] WARN: FARM_SIDEWAY_MIN_CONFIDENCE < FARM_TREND_MIN_CONFIDENCE — sideway threshold should be higher`.
4. THE config.ts SHALL be updated to include all new keys with their default values.
5. WHEN config-overrides.json overrides any new key, THE ConfigStore SHALL apply the override and validate the resulting value.

---

### Requirement 9: Analytics Enrichment

**User Story:** As a farm bot operator, I want the analytics dashboard to show the impact of each filter (how many trades were skipped and why), so that I can tune thresholds based on real data.

#### Acceptance Criteria

1. THE AnalyticsEngine SHALL compute `filterSkipStats` containing per-filter skip counts: `feeFilter`, `pressureGate`, `fallbackGate`, `regimeGate`.
2. WHEN computing analytics, THE AnalyticsEngine SHALL read `signalSnapshot.filterResult` from trade log records to populate `filterSkipStats`.
3. THE AnalyticsEngine SHALL compute `effectiveConfidenceStats`: average raw confidence vs average effectiveConfidence across all farm trades.
4. THE AnalyticsEngine SHALL compute `dynamicMinHoldStats`: average `dynamicMinHold`, average actual `holdingTimeSecs`, and percentage of trades that exited before `dynamicMinHold`.
5. THE AnalyticsSummary interface SHALL be extended to include `filterSkipStats`, `effectiveConfidenceStats`, and `dynamicMinHoldStats` fields.
