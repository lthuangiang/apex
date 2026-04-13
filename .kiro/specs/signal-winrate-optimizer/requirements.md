# Requirements Document

## Introduction

The Signal Win Rate Optimizer is a filtering and scoring layer that wraps `AISignalEngine` to suppress low-quality trading signals before they reach the executor. It addresses analytics findings showing ~0% win rate in trending regimes, no time-of-day filtering, average confidence of 42.8%, and a 43.5% fallback rate that bypasses LLM quality entirely.

The optimizer introduces four independent gates (regime, hour, confidence, fallback penalty) plus a composite quality score, and feeds win rate context back into the LLM prompt so the model can self-calibrate based on historical performance.

## Glossary

- **WinRateOptimizer**: The main orchestrating class that wraps `AISignalEngine`, applies all gates sequentially, and returns an `OptimizedSignal`.
- **AISignalEngine**: The existing signal engine that calls the LLM and computes momentum scores.
- **OptimizedSignal**: An extended `Signal` with `qualityScore`, `skipReason`, `gatesPassed`, and `gatesFailed` fields.
- **RegimeGate**: A gate that blocks trend signals unless confidence exceeds the trend override threshold.
- **HourFilter**: A gate that blocks trading during historically low-performing UTC hours.
- **ConfidenceGate**: A gate that enforces minimum confidence thresholds, stricter for fallback signals.
- **QualityScorer**: A component that computes a composite 0–1 score from confidence, regime suitability, and hour performance.
- **LLM_Prompt_Enhancer**: A component that injects historical win rate context into the LLM prompt.
- **WinRateOptimizerConfig**: The configuration object containing all thresholds, weights, and feature flags.
- **ConfigValidationError**: An error thrown at construction time when `WinRateOptimizerConfig` is invalid.
- **GateResult**: A result object with `pass: boolean` and optional `reason` and `metadata` fields.
- **WinRateHints**: Historical win rate context injected into the LLM prompt.
- **fallback signal**: A signal where `signal.fallback === true`, indicating the LLM was unavailable and momentum scoring was used instead.

## Requirements

### Requirement 1: WinRateOptimizer Core Orchestration

**User Story:** As a trading bot operator, I want a signal quality filter that wraps the AI signal engine, so that low-quality signals are suppressed before reaching the executor.

#### Acceptance Criteria

1. THE WinRateOptimizer SHALL expose a `getSignal(symbol: string): Promise<OptimizedSignal>` method that calls `AISignalEngine.getSignal()` and applies all enabled gates sequentially.
2. WHEN all enabled gates pass, THE WinRateOptimizer SHALL return an `OptimizedSignal` with the original signal direction and a `qualityScore` in [0, 1].
3. WHEN any gate fails, THE WinRateOptimizer SHALL return an `OptimizedSignal` with `direction: 'skip'` and `skipReason` set to the failing gate's reason string.
4. THE WinRateOptimizer SHALL always populate `gatesPassed` with the names of gates that passed and `gatesFailed` with the names of gates that rejected the signal.
5. THE WinRateOptimizer SHALL evaluate gates in deterministic order: regime → hour → confidence.
6. WHEN `AISignalEngine.getSignal()` throws or returns null, THE WinRateOptimizer SHALL return `direction: 'skip'` with `skipReason: 'engine:error'` and SHALL NOT propagate the exception.

---

### Requirement 2: Regime Gate

**User Story:** As a trading bot operator, I want trend regime signals to be blocked unless confidence is very high, so that the bot avoids the historically ~0% win rate in trending markets.

#### Acceptance Criteria

1. WHEN `signal.regime` is `SIDEWAY`, THE RegimeGate SHALL return `pass: true` unconditionally.
2. WHEN `signal.regime` is `TREND_UP` or `TREND_DOWN` AND `signal.confidence >= trendConfidenceOverride`, THE RegimeGate SHALL return `pass: true`.
3. WHEN `signal.regime` is `TREND_UP` or `TREND_DOWN` AND `signal.confidence < trendConfidenceOverride`, THE RegimeGate SHALL return `pass: false` with a reason string containing the regime name and confidence values.
4. WHERE `enableRegimeGate` is false, THE WinRateOptimizer SHALL skip the regime gate and treat it as passed.

---

### Requirement 3: Hour Filter

**User Story:** As a trading bot operator, I want trading to be blocked during historically low-performing UTC hours, so that the bot avoids time windows with poor win rates.

#### Acceptance Criteria

1. WHEN `hourUtc` is in `blockedHours`, THE HourFilter SHALL return `pass: false` with a reason string containing the blocked hour.
2. WHEN `hourUtc` is not in `blockedHours`, THE HourFilter SHALL return `pass: true`.
3. THE HourFilter SHALL provide an `hourPerformanceWeight` in [0, 1] derived from `hourWinRates[hourUtc]` for use in quality score calculation.
4. IF `hourWinRates[hourUtc]` is undefined, THEN THE HourFilter SHALL use a default weight of 0.5 (neutral) and SHALL NOT block the signal.
5. WHERE `enableHourFilter` is false, THE WinRateOptimizer SHALL skip the hour filter and treat it as passed.

---

### Requirement 4: Confidence Gate

**User Story:** As a trading bot operator, I want a minimum confidence threshold enforced on all signals, with a stricter threshold for fallback signals, so that low-confidence and unreliable signals are rejected.

#### Acceptance Criteria

1. WHEN `signal.fallback` is `false` AND `signal.confidence < minConfidence`, THE ConfidenceGate SHALL return `pass: false`.
2. WHEN `signal.fallback` is `true` AND `signal.confidence < fallbackMinConfidence`, THE ConfidenceGate SHALL return `pass: false`.
3. WHEN `signal.confidence` meets or exceeds the applicable threshold, THE ConfidenceGate SHALL return `pass: true` with metadata indicating the threshold used and whether the signal was a fallback.
4. THE ConfidenceGate SHALL always apply `fallbackMinConfidence` to fallback signals and `minConfidence` to non-fallback signals, never the reverse.
5. WHERE `enableConfidenceGate` is false, THE WinRateOptimizer SHALL skip the confidence gate and treat it as passed.

---

### Requirement 5: Quality Scorer

**User Story:** As a trading bot operator, I want a composite quality score on every passing signal, so that downstream consumers can rank and filter signals by overall quality.

#### Acceptance Criteria

1. THE QualityScorer SHALL compute a weighted composite score as: `(confidence × weights.confidence) + (regimeSuitability × weights.regimeSuitability) + (hourPerformance × weights.hourPerformance)`.
2. THE QualityScorer SHALL assign `regimeSuitability` of 1.0 for `SIDEWAY`, and 0.1 for `TREND_UP` or `TREND_DOWN`.
3. WHEN `signal.fallback` is `true`, THE QualityScorer SHALL multiply the composite score by 0.85 before returning.
4. THE QualityScorer SHALL clamp the final score to [0, 1].
5. FOR ALL fallback signals, THE QualityScorer SHALL return a score less than or equal to the score of an equivalent non-fallback signal with identical other inputs.

---

### Requirement 6: LLM Prompt Enhancer

**User Story:** As a trading bot operator, I want historical win rate context injected into the LLM prompt, so that the model can self-calibrate and prefer `skip` in historically poor conditions.

#### Acceptance Criteria

1. WHEN `enableLLMHints` is `true`, THE LLM_Prompt_Enhancer SHALL append a `Historical Performance Context` section to the base LLM prompt before `AISignalEngine.getSignal()` is called.
2. THE LLM_Prompt_Enhancer SHALL preserve all original prompt content when appending hints.
3. WHEN `regimeWinRate < 0.30`, THE LLM_Prompt_Enhancer SHALL include a warning in `contextNote` instructing the LLM to prefer `skip` or require very high confidence.
4. WHEN `hourWinRate < 0.25`, THE LLM_Prompt_Enhancer SHALL include a warning in `contextNote` about the historically low-performing UTC hour.
5. WHEN neither regime nor hour win rate is below threshold, THE LLM_Prompt_Enhancer SHALL include a neutral context note indicating conditions are within acceptable performance range.
6. WHERE `enableLLMHints` is `false`, THE WinRateOptimizer SHALL call `AISignalEngine.getSignal()` without prompt enrichment.

---

### Requirement 7: Configuration Validation

**User Story:** As a trading bot operator, I want the optimizer to validate its configuration at startup, so that misconfiguration is caught immediately rather than silently degrading signal quality.

#### Acceptance Criteria

1. WHEN `WinRateOptimizerConfig` is provided with `trendConfidenceOverride` outside [0, 1], THE WinRateOptimizer SHALL throw a `ConfigValidationError` at construction time.
2. WHEN `WinRateOptimizerConfig` is provided with `minConfidence >= fallbackMinConfidence`, THE WinRateOptimizer SHALL throw a `ConfigValidationError` at construction time.
3. WHEN `WinRateOptimizerConfig` is provided with `qualityWeights` that do not sum to 1.0, THE WinRateOptimizer SHALL throw a `ConfigValidationError` at construction time.
4. WHEN `WinRateOptimizerConfig` is provided with any `blockedHours` value outside [0, 23], THE WinRateOptimizer SHALL throw a `ConfigValidationError` at construction time.
5. IF `WinRateOptimizerConfig` passes all validation rules, THEN THE WinRateOptimizer SHALL construct successfully without throwing.

---

### Requirement 8: Bot Integration

**User Story:** As a trading bot developer, I want the WinRateOptimizer to be a drop-in replacement for direct AISignalEngine calls in bot.ts, so that the optimizer can be adopted without restructuring the bot.

#### Acceptance Criteria

1. THE WinRateOptimizer SHALL implement the same `getSignal(symbol: string): Promise<Signal>` interface contract as `AISignalEngine`, returning a type that extends `Signal`.
2. WHEN `signal.direction === 'skip'` is returned by the optimizer, THE bot SHALL log the `skipReason` and return without proceeding to the executor.
3. WHEN a passing signal is returned, THE bot SHALL log the `qualityScore` and `gatesPassed` fields for observability.
