# Implementation Plan: Signal Win Rate Optimizer

## Overview

Implement the `WinRateOptimizer` class as a filtering and scoring layer that wraps `AISignalEngine`. The implementation proceeds in layers: types and config validation first, then each gate, then the quality scorer, then LLM prompt enrichment, and finally wiring into `bot.ts`.

## Tasks

- [x] 1. Define types and config validation
  - Create `src/ai/WinRateOptimizer.ts` with all TypeScript interfaces: `OptimizedSignal`, `GateResult`, `WinRateHints`, `WinRateOptimizerConfig`, and `ConfigValidationError`
  - Implement `validateConfig(cfg: WinRateOptimizerConfig): void` that throws `ConfigValidationError` for: `trendConfidenceOverride` outside [0,1], `minConfidence >= fallbackMinConfidence`, `qualityWeights` not summing to 1.0, any `blockedHours` value outside [0,23]
  - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5_

  - [x] 1.1 Write property test for config validation
    - **Property 11: Invalid config always throws at construction**
    - **Validates: Requirements 7.1, 7.2, 7.3, 7.4**

- [x] 2. Implement RegimeGate
  - Implement `applyRegimeGate(signal: Signal, cfg): GateResult` in `WinRateOptimizer.ts`
  - SIDEWAY always returns `pass: true`; TREND_UP/DOWN returns `pass: true` only if `confidence >= trendConfidenceOverride`, otherwise `pass: false` with reason string containing regime name and confidence values
  - _Requirements: 2.1, 2.2, 2.3_

  - [x] 2.1 Write property test for RegimeGate — trend signals below threshold always skip
    - **Property 1: Trend regime signals below threshold are always skipped**
    - **Validates: Requirements 2.3, 1.3**

  - [x] 2.2 Write property test for RegimeGate — SIDEWAY always passes
    - **Property 2: SIDEWAY signals always pass the regime gate**
    - **Validates: Requirements 2.1**

- [x] 3. Implement HourFilter
  - Implement `applyHourFilter(hourUtc: number, cfg): GateResult` in `WinRateOptimizer.ts`
  - Blocked hours return `pass: false` with reason; unblocked hours return `pass: true`
  - Derive `hourPerformanceWeight` from `hourWinRates[hourUtc]`, defaulting to 0.5 if undefined
  - _Requirements: 3.1, 3.2, 3.3, 3.4_

  - [x] 3.1 Write property test for HourFilter — blocked hours always skip
    - **Property 3: Blocked hour signals are always skipped**
    - **Validates: Requirements 3.1, 1.3**

- [x] 4. Implement ConfidenceGate
  - Implement `applyConfidenceGate(signal: Signal, cfg): GateResult` in `WinRateOptimizer.ts`
  - Apply `fallbackMinConfidence` when `signal.fallback === true`, `minConfidence` otherwise
  - Return `pass: true` with metadata (threshold used, isFallback) when confidence meets threshold
  - _Requirements: 4.1, 4.2, 4.3, 4.4_

  - [x] 4.1 Write property test for ConfidenceGate — fallback signals use stricter threshold
    - **Property 4: Fallback signals below stricter threshold are always skipped**
    - **Validates: Requirements 4.2, 1.3**

  - [x] 4.2 Write property test for ConfidenceGate — non-fallback signals use base threshold
    - **Property 5: Non-fallback signals below base threshold are always skipped**
    - **Validates: Requirements 4.1, 1.3**

- [x] 5. Checkpoint — Ensure all gate unit tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 6. Implement QualityScorer
  - Implement `computeQualityScore(signal: Signal, hourUtc: number, cfg): number` in `WinRateOptimizer.ts`
  - Assign `regimeSuitability`: 1.0 for SIDEWAY, 0.1 for TREND_UP/TREND_DOWN
  - Compute weighted composite, apply 0.85 fallback penalty, clamp to [0, 1]
  - _Requirements: 5.1, 5.2, 5.3, 5.4_

  - [x] 6.1 Write property test for QualityScorer — score always in [0, 1]
    - **Property 6: Quality score is always in [0, 1]**
    - **Validates: Requirements 5.4, 1.2**

  - [x] 6.2 Write property test for QualityScorer — fallback signals always score lower
    - **Property 7: Fallback signals always score lower than equivalent non-fallback signals**
    - **Validates: Requirements 5.3, 5.5**

- [x] 7. Implement LLM Prompt Enhancer
  - Add `buildPromptWithHints(ctx: MarketContext, hints: WinRateHints): string` to `LLMClient.ts`
  - Append a `Historical Performance Context` section to the base `buildPrompt` output
  - Include regime warning when `regimeWinRate < 0.30`; include hour warning when `hourWinRate < 0.25`; include neutral note otherwise
  - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5_

  - [x] 7.1 Write property test for LLM prompt enrichment — original content preserved
    - **Property 10: LLM prompt enrichment preserves original content**
    - **Validates: Requirements 6.2**

- [x] 8. Implement WinRateOptimizer core orchestration
  - Implement the `WinRateOptimizer` class constructor (calls `validateConfig`, stores config and engine reference)
  - Implement `getSignal(symbol: string): Promise<OptimizedSignal>`:
    - Build `WinRateHints` and optionally enrich LLM context before calling `AISignalEngine.getSignal()`
    - Apply gates in order: regime → hour → confidence; return skip with `skipReason` on first failure
    - Compute `qualityScore` and return full `OptimizedSignal` on pass
    - Catch engine errors and return `direction: 'skip'` with `skipReason: 'engine:error'`
  - Implement `buildWinRateHints(regime, hourUtc): WinRateHints`
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 2.4, 3.5, 4.5, 6.6_

  - [x] 8.1 Write property test for gate evaluation order
    - **Property 8: Gate evaluation order is deterministic**
    - **Validates: Requirements 1.5**

  - [x] 8.2 Write property test for skipReason ↔ direction:skip invariant
    - **Property 9: skipReason is set if and only if direction is skip**
    - **Validates: Requirements 1.3, 1.4**

- [x] 9. Checkpoint — Ensure all optimizer tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 10. Wire WinRateOptimizer into bot.ts
  - Import `WinRateOptimizer` in `src/bot.ts` (or `src/modules/Watcher.ts` — wherever `AISignalEngine.getSignal()` is called)
  - Instantiate `WinRateOptimizer` wrapping the existing `AISignalEngine` instance with default config values from the design
  - Replace direct `AISignalEngine.getSignal()` calls with `optimizer.getSignal()`
  - Log `skipReason` when `direction === 'skip'`; log `qualityScore` and `gatesPassed` when signal passes
  - _Requirements: 8.1, 8.2, 8.3_

- [x] 11. Final checkpoint — Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Property tests use `fast-check` (already a dev dependency)
- Each gate function is pure and independently testable
- Default config values: `trendConfidenceOverride: 0.75`, `minConfidence: 0.60`, `fallbackMinConfidence: 0.70`, `blockedHours: [1,2,3,4,5,6,7,9,10,11,12,13,14,16,17,18,19,20,21,22]`
