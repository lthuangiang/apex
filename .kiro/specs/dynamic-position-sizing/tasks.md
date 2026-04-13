# Tasks: Dynamic Position Sizing (Phase 2)

## Implementation Plan

### 1. Config — add SIZING_* keys

- [x] 1.1 In `src/config.ts`, add the eight new keys with defaults: `SIZING_MIN_MULTIPLIER: 0.5`, `SIZING_MAX_MULTIPLIER: 2.0`, `SIZING_CONF_WEIGHT: 0.6`, `SIZING_PERF_WEIGHT: 0.4`, `SIZING_DRAWDOWN_THRESHOLD: -3.0`, `SIZING_DRAWDOWN_FLOOR: 0.5`, `SIZING_MAX_BTC: 0.008`, `SIZING_MAX_BALANCE_PCT: 0.02`
- [x] 1.2 In `src/config/ConfigStore.ts`, add all eight `SIZING_*` keys to the `OverridableConfig` type, the `OVERRIDABLE_KEYS` array, and the `extractBase()` function

### 2. Config validation — SIZING_* rules

- [x] 2.1 In `src/config/validateOverrides.ts`, add validation rules for `SIZING_*` keys:
  - `SIZING_CONF_WEIGHT` and `SIZING_PERF_WEIGHT` must each be in `(0, 1)` and their effective sum must equal 1.0 (cross-field check using effective values)
  - `SIZING_MAX_BTC` must be a positive number and must be `>= ORDER_SIZE_MIN` (cross-field check)
  - `SIZING_MIN_MULTIPLIER` must be positive and less than effective `SIZING_MAX_MULTIPLIER`
  - `SIZING_MAX_MULTIPLIER` must be positive and greater than effective `SIZING_MIN_MULTIPLIER`
  - `SIZING_DRAWDOWN_THRESHOLD` must be a finite negative number
  - `SIZING_DRAWDOWN_FLOOR` must be in `(0, 1)`
  - `SIZING_MAX_BALANCE_PCT` must be in `(0, 1)`
- [x] 2.2 Write unit tests in `src/config/__tests__/validateOverrides.test.ts` (extend existing file): weight sum rejection, SIZING_MAX_BTC < ORDER_SIZE_MIN rejection, multiplier bound inversion rejection, valid SIZING_* patch acceptance

### 3. PositionSizer — core implementation

- [x] 3.1 Create `src/modules/PositionSizer.ts` with `SizingInput` and `SizingResult` interfaces and the `PositionSizer` class implementing `computeSize(input: SizingInput): SizingResult`
- [x] 3.2 Implement `confidenceMultiplier(confidence, mode)`: trade mode linear scale from 1.0 at `MIN_CONFIDENCE` to `SIZING_MAX_MULTIPLIER` at 1.0; farm mode dampened scale `1.0 + (confidence - 0.5) × 0.6`; clamp to `[SIZING_MIN_MULTIPLIER, SIZING_MAX_MULTIPLIER]`
- [x] 3.3 Implement `performanceMultiplier(recentPnLs, sessionPnl, profile)`: win-rate component (0% → 0.7×, 50% → 1.0×, 100% → 1.3×; empty → 1.0); drawdown component (neutral above threshold, linear scale-down below, clamped to `SIZING_MIN_MULTIPLIER`); profile bias map (`SCALP: 0.85`, `NORMAL: 1.0`, `RUNNER: 1.15`, `DEGEN: 0.9`); combine and clamp
- [x] 3.4 Implement `applyRiskCaps(rawSize)`: apply `SIZING_MAX_BTC` hard cap and set `cappedBy`; enforce `ORDER_SIZE_MIN` floor
- [x] 3.5 Implement `computeSize`: draw `baseSize` from uniform random in `[ORDER_SIZE_MIN, ORDER_SIZE_MAX]`, compute both multipliers, compute weighted `combinedMultiplier`, compute `rawSize`, call `applyRiskCaps`, return full `SizingResult`

### 4. PositionSizer — unit tests

- [x] 4.1 Create `src/modules/__tests__/PositionSizer.test.ts` with example-based unit tests:
  - `confidenceMultiplier`: farm dampening, trade mode scaling, boundary values (0, `MIN_CONFIDENCE`, 1.0), clamp at bounds
  - `performanceMultiplier`: 0%/50%/100% win rate, drawdown floor activation, profile bias ordering, empty `recentPnLs` neutrality
  - `applyRiskCaps`: BTC cap applied, floor enforced, `cappedBy` accuracy
  - `computeSize`: end-to-end with representative inputs (high-confidence winning streak, deep drawdown scenario); verify all result fields populated

### 5. PositionSizer — property-based tests

- [x] 5.1 Create `src/modules/__tests__/PositionSizer.properties.test.ts` using `fast-check`:
  - **Property 1** (size bounds): for any valid `SizingInput`, `computeSize().size ∈ [ORDER_SIZE_MIN, SIZING_MAX_BTC]` — validates Requirements 1.2, 4.1
  - **Property 2** (multiplier bounds): for any valid `SizingInput`, all three multipliers ∈ `[SIZING_MIN_MULTIPLIER, SIZING_MAX_MULTIPLIER]` — validates Requirements 1.3, 2.5, 3.6
  - **Property 3** (drawdown protection): for any input where `sessionPnl <= SIZING_DRAWDOWN_THRESHOLD`, `performanceMultiplier < 1.0` — validates Requirements 3.3
  - **Property 4** (confidence monotonicity): for any fixed inputs with `mode = 'trade'`, `conf_a >= conf_b` implies `confidenceMultiplier(conf_a) >= confidenceMultiplier(conf_b)` — validates Requirements 2.3
  - **Property 5** (win rate monotonicity): all-positive `recentPnLs` produces `performanceMultiplier >= ` all-negative for same `sessionPnl` and `profile` — validates Requirements 3.7
  - **Property 6** (farm dampening): for any `confidence`, farm mode `confidenceMultiplier` is closer to 1.0 than trade mode — validates Requirements 2.4
  - **Property 7** (empty history neutral): `recentPnLs = []`, `sessionPnl > threshold`, `profile = 'NORMAL'` → `performanceMultiplier === 1.0` — validates Requirements 3.1
  - **Property 8** (cap reporting accuracy): `rawSize > SIZING_MAX_BTC` iff `cappedBy === 'btc_cap'` — validates Requirements 4.2, 4.3, 4.5
  - Run minimum 100 iterations per property

### 6. Watcher integration — replace inline sizing block

- [x] 6.1 In `src/modules/Watcher.ts`, import `PositionSizer` and instantiate it as a private field in the constructor
- [x] 6.2 In the IDLE state entry block, replace the inline `size` computation (the `if (config.MODE === 'farm') { ... } else { ... }` sizing block) with a call to `this.positionSizer.computeSize({ confidence: signal.confidence, recentPnLs: this.recentPnLs, sessionPnl: this.sessionCurrentPnl, balance, mode: config.MODE as 'farm' | 'trade', profile: this.currentProfile })`
- [x] 6.3 After `computeSize()`, apply the balance-% soft cap in `Watcher` using `markPrice`: `const maxSizeFromBalance = (balance * config.SIZING_MAX_BALANCE_PCT) / markPrice; if (size > maxSizeFromBalance) size = Math.max(config.ORDER_SIZE_MIN, maxSizeFromBalance);`
- [x] 6.4 Replace the existing `console.log` for order size with the enriched log line: `📐 Order size: ${size.toFixed(5)} BTC | confMult: ${sizingResult.confidenceMultiplier.toFixed(2)}x | perfMult: ${sizingResult.performanceMultiplier.toFixed(2)}x | combined: ${sizingResult.combinedMultiplier.toFixed(2)}x | cappedBy: ${sizingResult.cappedBy}`
- [x] 6.5 Verify that all existing `Watcher` unit/integration tests still pass after the refactor (no behaviour change outside the sizing block)

### 7. TradeLogger — optional sizing metadata

- [x] 7.1 In `src/ai/TradeLogger.ts`, optionally extend the `TradeRecord` interface with sizing fields: `sizingConfMult?: number`, `sizingPerfMult?: number`, `sizingCombinedMult?: number`, `sizingCappedBy?: 'none' | 'btc_cap' | 'balance_pct'`
- [x] 7.2 In `Watcher.ts`, populate the optional sizing fields in the `tradeRecord` object constructed at exit time using the stored `SizingResult` from entry (store it alongside `_pendingEntrySignalMeta`)

### 8. Config persistence — SIZING_* round-trip

- [x] 8.1 Verify that `ConfigStore.loadFromDisk()` correctly restores `SIZING_*` overrides from `config-overrides.json` on startup (extend existing `ConfigStore` tests or add a new test case in `src/config/__tests__/ConfigStore.test.ts`)
