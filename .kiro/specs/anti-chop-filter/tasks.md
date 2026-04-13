# Tasks: Anti-Chop & Trade Filtering (Phase 4)

## Implementation Plan

### 1. Config — add CHOP_* keys

- [x] 1.1 In `src/config.ts`, add all 12 `CHOP_*` keys with defaults:
  `CHOP_FLIP_WINDOW: 5`, `CHOP_FLIP_WEIGHT: 0.4`, `CHOP_MOM_WEIGHT: 0.35`, `CHOP_BB_WEIGHT: 0.25`,
  `CHOP_BB_COMPRESS_MAX: 0.015`, `CHOP_SCORE_THRESHOLD: 0.55`,
  `CHOP_BREAKOUT_SCORE_EDGE: 0.08`, `CHOP_BREAKOUT_VOL_MIN: 0.8`, `CHOP_BREAKOUT_IMBALANCE_THRESHOLD: 0.15`,
  `CHOP_COOLDOWN_STREAK_FACTOR: 0.5`, `CHOP_COOLDOWN_CHOP_FACTOR: 1.0`, `CHOP_COOLDOWN_MAX_MINS: 30`
- [x] 1.2 In `src/config/ConfigStore.ts`, add all 12 `CHOP_*` keys to the `OverridableConfig` type, the `OVERRIDABLE_KEYS` array, and the `extractBase()` function

### 2. Config validation — CHOP_* rules

- [x] 2.1 In `src/config/validateOverrides.ts`, add validation rules for `CHOP_*` keys:
  - `CHOP_FLIP_WINDOW` must be a positive integer (`>= 1`)
  - `CHOP_FLIP_WEIGHT`, `CHOP_MOM_WEIGHT`, `CHOP_BB_WEIGHT` must each be in `(0, 1)`, and their sum must equal `1.0` (tolerance `1e-9`) — cross-field check using effective values
  - `CHOP_BB_COMPRESS_MAX` must be a positive number
  - `CHOP_SCORE_THRESHOLD` must be in `(0, 1)`
  - `CHOP_BREAKOUT_SCORE_EDGE` must be in `(0, 0.5)`
  - `CHOP_BREAKOUT_VOL_MIN` must be in `(0, 1]`
  - `CHOP_BREAKOUT_IMBALANCE_THRESHOLD` must be in `(0, 1)`
  - `CHOP_COOLDOWN_STREAK_FACTOR` and `CHOP_COOLDOWN_CHOP_FACTOR` must be positive numbers
  - `CHOP_COOLDOWN_MAX_MINS` must be a positive integer and `>= effective COOLDOWN_MAX_MINS` (cross-field)
- [x] 2.2 Extend `src/config/__tests__/validateOverrides.test.ts` with tests for:
  - Weight sum violation (e.g. `CHOP_FLIP_WEIGHT: 0.5` without updating others) → rejected
  - `CHOP_COOLDOWN_MAX_MINS < COOLDOWN_MAX_MINS` → rejected
  - `CHOP_SCORE_THRESHOLD: 0` and `CHOP_SCORE_THRESHOLD: 1` → rejected
  - `CHOP_FLIP_WINDOW: 0` → rejected
  - Valid full `CHOP_*` patch → accepted

### 3. ChopDetector — core implementation

- [x] 3.1 Create `src/ai/ChopDetector.ts` with the `SignalHistoryEntry` interface, `ChopResult` interface, and `ChopDetector` class
- [x] 3.2 Implement `evaluate(signal, signalHistory)`:
  - Compute `flipRate`: if `signalHistory.length < 2` return `0.0`; otherwise count adjacent direction changes (skipping `'skip'` entries) and divide by `signalHistory.length - 1`
  - Compute `momNeutrality`: `1.0 - clamp(Math.abs(signal.score - 0.5) / 0.5, 0.0, 1.0)`
  - Compute `bbCompression`: if `signal.bbWidth <= 0` return `1.0`; otherwise `clamp(1.0 - (signal.bbWidth / config.CHOP_BB_COMPRESS_MAX - 1.0), 0.0, 1.0)`
  - Compute `chopScore = clamp(flipRate * CHOP_FLIP_WEIGHT + momNeutrality * CHOP_MOM_WEIGHT + bbCompression * CHOP_BB_WEIGHT, 0.0, 1.0)`
  - Return `ChopResult { chopScore, isChoppy: chopScore >= config.CHOP_SCORE_THRESHOLD, flipRate, momNeutrality, bbCompression }`

### 4. ChopDetector — unit tests

- [x] 4.1 Create `src/ai/__tests__/ChopDetector.test.ts` with example-based unit tests:
  - `flipRate`: empty history → `0.0`; single entry → `0.0`; all same direction → `0.0`; alternating long/short → `1.0`; mixed with `'skip'` entries → skips are ignored
  - `momNeutrality`: `score=0.5` → `1.0`; `score=0.0` → `0.0`; `score=1.0` → `0.0`; `score=0.72` → `0.44`
  - `bbCompression`: `bbWidth=0` → `1.0`; `bbWidth=CHOP_BB_COMPRESS_MAX` → `1.0`; `bbWidth=2×CHOP_BB_COMPRESS_MAX` → `0.0`; `bbWidth=1.5×CHOP_BB_COMPRESS_MAX` → `0.5`
  - `chopScore`: verify weighted sum with known inputs; verify `isChoppy` threshold boundary
  - Clean trending market example from design doc → `isChoppy=false`; choppy market example → `isChoppy=true`

### 5. ChopDetector — property-based tests

- [x] 5.1 Create `src/ai/__tests__/ChopDetector.properties.test.ts` using `fast-check` with minimum 100 iterations per property:
  - **Property 1** (chop score bounds): for any `signal` with `score ∈ [0,1]` and `bbWidth >= 0`, and any `signalHistory` array, `evaluate().chopScore ∈ [0, 1]` and all sub-scores are in `[0, 1]` — validates Requirements 1.6, 1.8
  - **Property 2** (threshold consistency): for any valid inputs, `evaluate().isChoppy === (chopScore >= config.CHOP_SCORE_THRESHOLD)` — validates Requirements 1.7
  - **Property 3** (empty history → zero flip rate): for any `signalHistory` with length `< 2`, `evaluate().flipRate === 0.0` — validates Requirements 1.2

### 6. FakeBreakoutFilter — core implementation

- [x] 6.1 Create `src/ai/FakeBreakoutFilter.ts` with the `FakeBreakoutResult` interface and `FakeBreakoutFilter` class
- [x] 6.2 Implement `check(signal, direction)`:
  - If `Math.abs(signal.score - 0.5) <= config.CHOP_BREAKOUT_SCORE_EDGE` → return `{ isFakeBreakout: false, reason: null }`
  - Compute `lowVolume = signal.volRatio < config.CHOP_BREAKOUT_VOL_MIN`
  - Compute `imbalanceContradicts`: `direction === 'long' && signal.imbalance < -config.CHOP_BREAKOUT_IMBALANCE_THRESHOLD` OR `direction === 'short' && signal.imbalance > config.CHOP_BREAKOUT_IMBALANCE_THRESHOLD`
  - Return `{ isFakeBreakout: true, reason: 'both' }` if both; `{ isFakeBreakout: true, reason: 'low_volume' }` if only volume; `{ isFakeBreakout: true, reason: 'imbalance_contradiction' }` if only imbalance; else `{ isFakeBreakout: false, reason: null }`

### 7. FakeBreakoutFilter — unit tests

- [x] 7.1 Create `src/ai/__tests__/FakeBreakoutFilter.test.ts` with example-based unit tests:
  - Non-breakout score (`|score - 0.5| <= CHOP_BREAKOUT_SCORE_EDGE`) → always `false` regardless of `volRatio`/`imbalance`
  - Breakout + low volume only → `{ isFakeBreakout: true, reason: 'low_volume' }`
  - Breakout + long + negative imbalance contradiction → `{ isFakeBreakout: true, reason: 'imbalance_contradiction' }`
  - Breakout + short + positive imbalance contradiction → `{ isFakeBreakout: true, reason: 'imbalance_contradiction' }`
  - Breakout + both conditions → `{ isFakeBreakout: true, reason: 'both' }`
  - Breakout + sufficient volume + neutral imbalance → `{ isFakeBreakout: false, reason: null }`
  - Fake breakout example from design doc (`score=0.62, volRatio=0.6, imbalance=-0.2, direction='long'`) → `reason='both'`

### 8. FakeBreakoutFilter — property-based tests

- [x] 8.1 Extend `src/ai/__tests__/FakeBreakoutFilter.properties.test.ts` (or add to ChopDetector properties file) using `fast-check` with minimum 100 iterations per property:
  - **Property 4** (non-breakout never filtered): for any `signal` where `|score - 0.5| <= CHOP_BREAKOUT_SCORE_EDGE`, `check()` returns `isFakeBreakout === false` — validates Requirements 3.1
  - **Property 5** (reason non-null when flagged): for any inputs where `check()` returns `isFakeBreakout === true`, `result.reason` is non-null — validates Requirements 3.2, 3.8

### 9. AdaptiveCooldown — core implementation

- [x] 9.1 Create `src/ai/AdaptiveCooldown.ts` with the `AdaptiveCooldownInput` and `AdaptiveCooldownResult` interfaces and the `computeAdaptiveCooldown` function
- [x] 9.2 Implement `computeAdaptiveCooldown(input)`:
  - Count `losingStreak` by iterating `recentPnLs` from the end, stopping at the first non-negative value
  - Compute `streakMult = clamp(1.0 + losingStreak * config.CHOP_COOLDOWN_STREAK_FACTOR, 1.0, 4.0)`
  - Compute `chopMult = clamp(1.0 + input.lastChopScore * config.CHOP_COOLDOWN_CHOP_FACTOR, 1.0, 3.0)`
  - Draw `baseMins` from `[config.COOLDOWN_MIN_MINS, config.COOLDOWN_MAX_MINS]` using `Math.random()`
  - Compute `finalMins = clamp(baseMins * streakMult * chopMult, config.COOLDOWN_MIN_MINS, config.CHOP_COOLDOWN_MAX_MINS)`
  - Return `{ cooldownMs: finalMins * 60 * 1000, baseMins, streakMult, chopMult, losingStreak }`

### 10. AdaptiveCooldown — unit tests

- [x] 10.1 Create `src/ai/__tests__/AdaptiveCooldown.test.ts` with example-based unit tests:
  - Empty `recentPnLs` → `losingStreak=0`, `streakMult=1.0`
  - Mixed PnLs ending in a win → `losingStreak=0`
  - 3 trailing losses → `streakMult=2.5`
  - `lastChopScore=0` → `chopMult=1.0`
  - `lastChopScore=1.0` → `chopMult=2.0`
  - All 5 losses → `streakMult` clamped to `4.0` (not `3.5`)
  - Adaptive cooldown example from design doc (3 losses, chopScore=0.7) → `streakMult=2.5`, `chopMult=1.7`
  - Verify `cooldownMs` is always within `[COOLDOWN_MIN_MINS × 60000, CHOP_COOLDOWN_MAX_MINS × 60000]`

### 11. AdaptiveCooldown — property-based tests

- [x] 11.1 Create `src/ai/__tests__/AdaptiveCooldown.properties.test.ts` using `fast-check` with minimum 100 iterations per property:
  - **Property 6** (cooldown bounds): for any valid `AdaptiveCooldownInput`, `cooldownMs ∈ [COOLDOWN_MIN_MINS × 60000, CHOP_COOLDOWN_MAX_MINS × 60000]` — validates Requirements 2.1, 2.2
  - **Property 7** (neutral multipliers): for any `recentPnLs` with no trailing losses and `lastChopScore === 0`, `streakMult === 1.0` and `chopMult === 1.0` — validates Requirements 2.3, 2.7, 2.8
  - **Property 8** (streak monotonicity): for any fixed `lastChopScore` and two `recentPnLs` arrays where the second has a strictly longer trailing loss streak, the second produces `streakMult >= ` the first — validates Requirements 2.11

### 12. Watcher — add new private fields and imports

- [x] 12.1 In `src/modules/Watcher.ts`, add imports for `ChopDetector`, `SignalHistoryEntry` from `../ai/ChopDetector.js`, `FakeBreakoutFilter` from `../ai/FakeBreakoutFilter.js`, and `computeAdaptiveCooldown` from `../ai/AdaptiveCooldown.js`
- [x] 12.2 Add private fields to the `Watcher` class:
  - `private _signalHistory: SignalHistoryEntry[] = []`
  - `private _lastChopScore: number = 0`
  - `private readonly chopDetector = new ChopDetector()`
  - `private readonly fakeBreakoutFilter = new FakeBreakoutFilter()`

### 13. Watcher — IDLE entry gate integration

- [x] 13.1 In the IDLE state entry block, after `finalDirection` is determined and after the `regimeConfig.skipEntry` guard, call `ChopDetector.evaluate()` with `{ score: signal.score, bbWidth: signal.bbWidth ?? 0 }` and `this._signalHistory`; store result in `chopResult`; update `this._lastChopScore = chopResult.chopScore`
- [x] 13.2 After calling `evaluate()`, push `{ direction: finalDirection, score: signal.score, ts: Date.now() }` to `this._signalHistory`; if `_signalHistory.length > config.CHOP_FLIP_WINDOW`, call `_signalHistory.shift()` to maintain the ring buffer
- [x] 13.3 If `chopResult.isChoppy === true`, log the chop score and sub-scores with the `🌀 [CHOP]` prefix and return without placing an order
- [x] 13.4 After the chop gate, if `finalDirection !== 'skip'`, call `FakeBreakoutFilter.check()` with `{ score: signal.score, volRatio: signal.volRatio ?? 1, imbalance: signal.imbalance ?? 0 }` and `finalDirection`; if `isFakeBreakout === true`, log with the `🚫 [CHOP]` prefix and return without placing an order

### 14. Watcher — adaptive cooldown on exit

- [x] 14.1 In the `PENDING_EXIT` fill handler (where `cooldownUntil` is set after a successful exit), replace the existing `Math.floor(Math.random() * ...)` fixed cooldown with a call to `computeAdaptiveCooldown({ recentPnLs: this.recentPnLs, lastChopScore: this._lastChopScore })`; set `this.cooldownUntil = Date.now() + cooldownResult.cooldownMs`
- [x] 14.2 Log the adaptive cooldown result with the `⏱️` prefix, including `finalMins`, `baseMins`, `streakMult`, and `chopMult`
- [x] 14.3 Apply the same `computeAdaptiveCooldown` replacement in the externally-closed position handler (the `IN_POSITION` block where position disappears unexpectedly)

### 15. Watcher — resetSession cleanup

- [x] 15.1 In `Watcher.resetSession()`, reset `this._signalHistory = []` and `this._lastChopScore = 0` so session state is fully cleared on reset

### 16. Config persistence — CHOP_* round-trip

- [x] 16.1 Extend `src/config/__tests__/ConfigStore.test.ts` to verify that `CHOP_*` overrides are correctly persisted to disk and restored via `loadFromDisk()` on a fresh `ConfigStore` instance

### 17. Integration verification

- [x] 17.1 Run the existing test suites (`AISignalEngine.test.ts`, `RegimeDetector.properties.test.ts`, `PositionSizer.properties.test.ts`, `ConfigStore.test.ts`) and verify all tests still pass after Phase 4 changes (non-regression)
- [x] 17.2 Verify TypeScript compilation succeeds with no errors across all modified and new files
