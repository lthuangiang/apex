# Requirements Document

## Introduction

Phase 4 of APEX adds an anti-chop filtering layer to the Watcher state machine. The feature introduces three pure-function components — `ChopDetector`, `FakeBreakoutFilter`, and `computeAdaptiveCooldown` — that work together to suppress low-quality entries during choppy, directionless market conditions and to dynamically extend the post-trade cooldown when the bot is on a losing streak or the market is noisy.

Phase 3 (regime-adaptive strategy) already adjusts *how* to trade in a given regime. Phase 4 decides *whether* to trade at all, operating at a finer granularity via a continuous chop score derived from direction flip rate, momentum neutrality, and Bollinger Band compression. The two systems are complementary and compositionally independent.

## Glossary

- **ChopDetector**: Pure stateless service that computes a continuous chop score `[0, 1]` from three market-quality sub-scores and determines whether the market is too choppy to enter.
- **FakeBreakoutFilter**: Pure stateless service that detects breakout-strength entries lacking volume or orderbook confirmation.
- **AdaptiveCooldown**: Pure function `computeAdaptiveCooldown()` that computes post-trade cooldown duration based on recent PnL history and the last chop score.
- **ChopScore**: Weighted sum of `flipRate`, `momNeutrality`, and `bbCompression`, clamped to `[0, 1]`.
- **FlipRate**: Fraction of direction changes in the last `CHOP_FLIP_WINDOW` signal history entries, in `[0, 1]`.
- **MomNeutrality**: How close the current signal score is to 0.5 (fully neutral), in `[0, 1]`.
- **BBCompression**: How compressed the Bollinger Band width is relative to `CHOP_BB_COMPRESS_MAX`, in `[0, 1]`.
- **SignalHistory**: Ring buffer of the last `CHOP_FLIP_WINDOW` `SignalHistoryEntry` objects stored in `Watcher._signalHistory`.
- **SignalHistoryEntry**: `{ direction: 'long' | 'short' | 'skip'; score: number; ts: number }`.
- **LosingStreak**: Count of consecutive trailing losses (from most recent backward) in `recentPnLs`.
- **StreakMult**: Cooldown multiplier derived from `losingStreak`; always `>= 1.0`.
- **ChopMult**: Cooldown multiplier derived from `lastChopScore`; always `>= 1.0`.
- **Watcher**: The main bot state machine in `src/modules/Watcher.ts`.
- **OverridableConfig**: The set of config keys that can be patched at runtime via the dashboard.
- **validateOverrides**: The pure validation function in `src/config/validateOverrides.ts`.

---

## Requirements

### Requirement 1: ChopDetector — Chop Score Computation

**User Story:** As a bot operator, I want the system to compute a continuous chop score from recent signal history and current market indicators, so that entries can be suppressed during directionless, low-quality market conditions.

#### Acceptance Criteria

1. THE ChopDetector SHALL compute `flipRate` as the fraction of direction changes among the last `CHOP_FLIP_WINDOW` entries in `signalHistory`, ignoring entries with direction `'skip'`.
2. WHEN `signalHistory` contains fewer than 2 entries, THE ChopDetector SHALL return `flipRate === 0.0`.
3. THE ChopDetector SHALL compute `momNeutrality` as `1.0 - clamp(|signal.score - 0.5| / 0.5, 0.0, 1.0)`, yielding `1.0` when `score === 0.5` and `0.0` when `score === 0.0` or `score === 1.0`.
4. THE ChopDetector SHALL compute `bbCompression` as `clamp(1.0 - (signal.bbWidth / CHOP_BB_COMPRESS_MAX - 1.0), 0.0, 1.0)`, yielding `1.0` when `bbWidth <= CHOP_BB_COMPRESS_MAX` and `0.0` when `bbWidth >= 2 × CHOP_BB_COMPRESS_MAX`.
5. WHEN `signal.bbWidth === 0`, THE ChopDetector SHALL treat `bbCompression` as `1.0`.
6. THE ChopDetector SHALL compute `chopScore` as `flipRate × CHOP_FLIP_WEIGHT + momNeutrality × CHOP_MOM_WEIGHT + bbCompression × CHOP_BB_WEIGHT`, clamped to `[0, 1]`.
7. THE ChopDetector SHALL set `isChoppy = true` if and only if `chopScore >= CHOP_SCORE_THRESHOLD`.
8. THE ChopDetector SHALL return all sub-scores (`flipRate`, `momNeutrality`, `bbCompression`) clamped to `[0, 1]`.
9. THE ChopDetector SHALL be a pure function with no I/O side effects.

---

### Requirement 2: AdaptiveCooldown — Post-Trade Cooldown Computation

**User Story:** As a bot operator, I want the post-trade cooldown to automatically extend during losing streaks and choppy markets, so that the bot pauses longer when conditions are unfavorable.

#### Acceptance Criteria

1. THE AdaptiveCooldown SHALL return `cooldownMs >= COOLDOWN_MIN_MINS × 60000` for any valid input.
2. THE AdaptiveCooldown SHALL return `cooldownMs <= CHOP_COOLDOWN_MAX_MINS × 60000` for any valid input.
3. WHEN `recentPnLs` contains no trailing losses AND `lastChopScore === 0`, THE AdaptiveCooldown SHALL return `streakMult === 1.0` AND `chopMult === 1.0`.
4. THE AdaptiveCooldown SHALL compute `losingStreak` by counting consecutive negative values from the end of `recentPnLs`, stopping at the first non-negative value.
5. THE AdaptiveCooldown SHALL compute `streakMult = clamp(1.0 + losingStreak × CHOP_COOLDOWN_STREAK_FACTOR, 1.0, 4.0)`.
6. THE AdaptiveCooldown SHALL compute `chopMult = clamp(1.0 + lastChopScore × CHOP_COOLDOWN_CHOP_FACTOR, 1.0, 3.0)`.
7. WHEN `recentPnLs` is empty, THE AdaptiveCooldown SHALL return `losingStreak === 0` AND `streakMult === 1.0`.
8. WHEN `lastChopScore === 0`, THE AdaptiveCooldown SHALL return `chopMult === 1.0`.
9. THE AdaptiveCooldown SHALL draw `baseMins` from the range `[COOLDOWN_MIN_MINS, COOLDOWN_MAX_MINS]` and compute `finalMins = clamp(baseMins × streakMult × chopMult, COOLDOWN_MIN_MINS, CHOP_COOLDOWN_MAX_MINS)`.
10. THE AdaptiveCooldown SHALL be a pure function with no I/O side effects.
11. FOR any two inputs where the second has a strictly longer trailing loss streak and all other inputs are equal, THE AdaptiveCooldown SHALL return a `streakMult` greater than or equal to the first.

---

### Requirement 3: FakeBreakoutFilter — Breakout Validation

**User Story:** As a bot operator, I want breakout-strength entries to be rejected when they lack volume or orderbook confirmation, so that the bot avoids false breakout traps that the regime classifier misses.

#### Acceptance Criteria

1. WHEN `|signal.score - 0.5| <= CHOP_BREAKOUT_SCORE_EDGE`, THE FakeBreakoutFilter SHALL return `isFakeBreakout === false` regardless of `volRatio` or `imbalance`.
2. WHEN `|signal.score - 0.5| > CHOP_BREAKOUT_SCORE_EDGE` AND `signal.volRatio < CHOP_BREAKOUT_VOL_MIN`, THE FakeBreakoutFilter SHALL return `isFakeBreakout === true`.
3. WHEN `|signal.score - 0.5| > CHOP_BREAKOUT_SCORE_EDGE` AND `direction === 'long'` AND `signal.imbalance < -CHOP_BREAKOUT_IMBALANCE_THRESHOLD`, THE FakeBreakoutFilter SHALL return `isFakeBreakout === true`.
4. WHEN `|signal.score - 0.5| > CHOP_BREAKOUT_SCORE_EDGE` AND `direction === 'short'` AND `signal.imbalance > CHOP_BREAKOUT_IMBALANCE_THRESHOLD`, THE FakeBreakoutFilter SHALL return `isFakeBreakout === true`.
5. WHEN `isFakeBreakout === true` AND both low-volume and imbalance-contradiction conditions hold, THE FakeBreakoutFilter SHALL return `reason === 'both'`.
6. WHEN `isFakeBreakout === true` AND only the low-volume condition holds, THE FakeBreakoutFilter SHALL return `reason === 'low_volume'`.
7. WHEN `isFakeBreakout === true` AND only the imbalance-contradiction condition holds, THE FakeBreakoutFilter SHALL return `reason === 'imbalance_contradiction'`.
8. WHEN `isFakeBreakout === true`, THE FakeBreakoutFilter SHALL return a non-null `reason`.
9. THE FakeBreakoutFilter SHALL be a pure function with no I/O side effects.

---

### Requirement 4: Watcher Integration — IDLE Entry Gate

**User Story:** As a bot operator, I want the Watcher to apply chop detection and fake breakout filtering before placing any entry order, so that low-quality entries are suppressed at the state machine level.

#### Acceptance Criteria

1. WHEN the Watcher is in the IDLE state and evaluates a signal, THE Watcher SHALL call `ChopDetector.evaluate()` after `getRegimeStrategyConfig()` and before `FakeBreakoutFilter.check()`.
2. WHEN `ChopDetector.evaluate()` returns `isChoppy === true`, THE Watcher SHALL skip the entry and log the chop score and sub-scores without placing an order.
3. WHEN `ChopDetector.evaluate()` returns `isChoppy === false` AND `FakeBreakoutFilter.check()` returns `isFakeBreakout === true`, THE Watcher SHALL skip the entry and log the fake breakout reason without placing an order.
4. WHEN the Watcher evaluates a signal in IDLE state, THE Watcher SHALL store the current signal's direction, score, and timestamp in `_signalHistory` after calling `ChopDetector.evaluate()`.
5. THE Watcher SHALL maintain `_signalHistory` as a ring buffer capped at `CHOP_FLIP_WINDOW` entries, dropping the oldest entry when the buffer is full.
6. THE Watcher SHALL update `_lastChopScore` with `ChopResult.chopScore` on every IDLE tick that reaches the chop detection step.
7. WHEN `regimeConfig.skipEntry === true`, THE Watcher SHALL skip the entry before calling `ChopDetector.evaluate()` (Phase 3 check takes precedence).

---

### Requirement 5: Watcher Integration — Adaptive Cooldown on Exit

**User Story:** As a bot operator, I want the post-trade cooldown to use the adaptive formula instead of a fixed random range, so that the bot automatically pauses longer after losses or in choppy conditions.

#### Acceptance Criteria

1. WHEN the Watcher transitions from `PENDING_EXIT` to `IDLE` after a fill, THE Watcher SHALL call `computeAdaptiveCooldown({ recentPnLs, lastChopScore: _lastChopScore })` to determine the cooldown duration.
2. THE Watcher SHALL replace the existing fixed random cooldown (`Math.floor(Math.random() * ...)`) in the `PENDING_EXIT` fill handler with the result of `computeAdaptiveCooldown().cooldownMs`.
3. WHEN the Watcher sets the cooldown after a fill, THE Watcher SHALL log the final cooldown duration in minutes along with `baseMins`, `streakMult`, and `chopMult`.
4. THE Watcher SHALL also apply `computeAdaptiveCooldown` when a position is closed externally (detected in the `IN_POSITION` state with no open position).

---

### Requirement 6: Config Extensions — New CHOP_* Keys

**User Story:** As a bot operator, I want all anti-chop parameters to be configurable and overridable at runtime via the dashboard, so that I can tune the filter without restarting the bot.

#### Acceptance Criteria

1. THE Config SHALL include the following keys with the specified defaults: `CHOP_FLIP_WINDOW: 5`, `CHOP_FLIP_WEIGHT: 0.4`, `CHOP_MOM_WEIGHT: 0.35`, `CHOP_BB_WEIGHT: 0.25`, `CHOP_BB_COMPRESS_MAX: 0.015`, `CHOP_SCORE_THRESHOLD: 0.55`, `CHOP_BREAKOUT_SCORE_EDGE: 0.08`, `CHOP_BREAKOUT_VOL_MIN: 0.8`, `CHOP_BREAKOUT_IMBALANCE_THRESHOLD: 0.15`, `CHOP_COOLDOWN_STREAK_FACTOR: 0.5`, `CHOP_COOLDOWN_CHOP_FACTOR: 1.0`, `CHOP_COOLDOWN_MAX_MINS: 30`.
2. THE OverridableConfig type SHALL include all twelve `CHOP_*` keys so they can be patched via the dashboard.
3. WHEN a dashboard patch sets `CHOP_FLIP_WEIGHT`, `CHOP_MOM_WEIGHT`, or `CHOP_BB_WEIGHT` such that their sum deviates from `1.0` by more than `1e-9`, THE validateOverrides function SHALL reject the patch with an error message referencing the weight sum constraint.
4. WHEN a dashboard patch sets `CHOP_COOLDOWN_MAX_MINS` to a value less than the effective `COOLDOWN_MAX_MINS`, THE validateOverrides function SHALL reject the patch.
5. WHEN a dashboard patch sets `CHOP_SCORE_THRESHOLD` outside the range `(0, 1)`, THE validateOverrides function SHALL reject the patch.
6. WHEN a dashboard patch sets `CHOP_FLIP_WINDOW` to a non-positive integer, THE validateOverrides function SHALL reject the patch.
7. WHEN a dashboard patch sets `CHOP_BREAKOUT_SCORE_EDGE` outside the range `(0, 0.5)`, THE validateOverrides function SHALL reject the patch.
8. WHEN a dashboard patch sets `CHOP_BREAKOUT_VOL_MIN` outside the range `(0, 1]`, THE validateOverrides function SHALL reject the patch.
9. WHEN a dashboard patch sets `CHOP_BREAKOUT_IMBALANCE_THRESHOLD` outside the range `(0, 1)`, THE validateOverrides function SHALL reject the patch.
10. WHEN a dashboard patch sets `CHOP_COOLDOWN_STREAK_FACTOR` or `CHOP_COOLDOWN_CHOP_FACTOR` to a non-positive number, THE validateOverrides function SHALL reject the patch.

---

### Requirement 7: Fallback Signal Handling

**User Story:** As a bot operator, I want the anti-chop components to degrade gracefully when signal fields are missing or undefined, so that the bot does not crash or produce false positives on fallback signal paths.

#### Acceptance Criteria

1. WHEN `signal.bbWidth` is `undefined` or `null`, THE Watcher SHALL pass `bbWidth: 0` to `ChopDetector.evaluate()`, causing `bbCompression` to be treated as `1.0` (maximum compression — conservative).
2. WHEN `signal.volRatio` is `undefined` or `null`, THE Watcher SHALL pass `volRatio: 1.0` to `FakeBreakoutFilter.check()`, effectively disabling the volume check for that signal.
3. WHEN `signal.imbalance` is `undefined` or `null`, THE Watcher SHALL pass `imbalance: 0` to `FakeBreakoutFilter.check()`, effectively disabling the imbalance check for that signal.
4. WHEN `_signalHistory` is empty at session start, THE ChopDetector SHALL return `flipRate === 0.0` and compute `chopScore` from `momNeutrality` and `bbCompression` only.

---

### Requirement 8: Phase 3 Non-Interference

**User Story:** As a bot operator, I want the anti-chop filter to operate independently of the Phase 3 regime-adaptive strategy, so that the two systems remain compositionally decoupled and individually testable.

#### Acceptance Criteria

1. THE ChopDetector SHALL read only `signal.score` and `signal.bbWidth` — it SHALL NOT read `signal.regime`, `signal.atrPct`, or any Phase 3 state.
2. THE FakeBreakoutFilter SHALL read only `signal.score`, `signal.volRatio`, and `signal.imbalance` — it SHALL NOT read `signal.regime` or any Phase 3 state.
3. THE computeAdaptiveCooldown function SHALL read only `recentPnLs` and `lastChopScore` — it SHALL NOT read regime state.
4. THE RegimeDetector SHALL require no modifications as part of this feature.
