# FARM Candle & Microstructure Mode — Requirements

> Feature: Replace slow FARM directional signals with short-horizon BTC price action
> Priority: HIGH
> Scope: Crypto FARM mode only
> Target hold time: 120–300 seconds

---

## 1. Objective

Implement a dedicated entry-decision engine for FARM mode that chooses LONG, SHORT, or SKIP from short-horizon candle price action and market microstructure.

The current FARM path uses `AISignalEngine`, whose 5-minute EMA/RSI/macro inputs have a longer horizon than a FARM position. FARM positions normally last only 2–5 minutes, so the entry decision must react to the most recent completed 1-minute candles and live exchange activity.

The new engine must:

- improve direction selection for positions held for 2–5 minutes;
- keep the existing fee-aware execution, sizing, inventory, TP/SL and position lifecycle;
- remove SoSoValue, LLM and the existing `AISignalEngine` from the FARM entry hot path when the feature is enabled;
- leave TRADE mode unchanged;
- remain exchange-agnostic and backward compatible.

This is not a “green candle = LONG, red candle = SHORT” strategy.

---

## 2. User Story

As an operator running a BTC crypto bot in FARM mode, I want entry direction to be calculated from recent 1-minute price action, volume, recent trades and order-book imbalance, so that the decision matches the bot's 2–5 minute holding horizon and does not wait for slow macro or 5-minute signals.

---

## 3. Scope

### 3.1 In scope

- BTC crypto symbols in FARM mode.
- A new exchange-independent `FarmMicroSignalEngine`.
- Completed 1-minute candle analysis.
- Short trend/momentum, wick rejection, volume acceleration, recent trade pressure and order-book imbalance.
- A lightweight 5-minute market-regime guard.
- Fee/spread-aware entry gating.
- Feature flags and safe fallback to the legacy FARM path.
- Structured logs, trade metadata and analytics fields.
- Unit, property and integration tests.
- Backtest compatibility where historical inputs are available.

### 3.2 Out of scope

- Any change to TRADE mode or hedge/pair bots.
- Predictive ML or LLM calls.
- Changes to exchange adapter business logic beyond accepting supported kline intervals.
- Redesigning order execution, maker/taker escalation, position sizing or exit lifecycle.
- Guaranteed profitability or a hard-coded win-rate target.
- Enabling the new path for equities, commodities or other non-crypto instruments.

---

## 4. Architecture Requirements

### AR-1: Strategy isolation

Create a new module, preferably:

```text
src/modules/FarmMicroSignalEngine.ts
```

The engine must depend only on an exchange-data interface, not on a concrete adapter. It must not place/cancel orders or mutate bot state.

### AR-2: Public contract

Expose a result equivalent to:

```typescript
export type FarmMicroDirection = 'long' | 'short' | 'skip';

export interface FarmMicroSignal {
  direction: FarmMicroDirection;
  score: number;          // normalized to [0, 1], bearish -> bullish
  confidence: number;     // normalized to [0, 1]
  regime: 'SIDEWAY' | 'TREND_UP' | 'TREND_DOWN' | 'HIGH_VOLATILITY' | 'UNKNOWN';
  components: {
    candleMomentum: number;
    wickRejection: number;
    volumeAcceleration: number;
    tradePressure: number;
    orderbookImbalance: number;
  };
  dataQuality: {
    candleInterval: string;
    completedCandles: number;
    hasTradeData: boolean;
    hasOrderbookData: boolean;
    usedFallback: boolean;
  };
  reason: string;
}
```

Naming may follow existing project conventions, but all information above must be available to the caller.

### AR-3: Integration boundary

In `Watcher._handleIdleFarm()`:

- use `FarmMicroSignalEngine` only when the feature is enabled, mode is `farm`, and the instrument is supported crypto;
- do not call `AISignalEngine`, SoSoValue, or `LLMMomentumAdjuster` to choose FARM direction on that path;
- retain existing balance/risk checks, spread guard, inventory hard block, order placement, fill handling, sizing, TP/SL, time exit and cooldown;
- preserve the current FARM implementation as a legacy fallback;
- leave `_handleIdleTrade()` unchanged.

### AR-4: No adapter coupling

Do not add exchange-name branches to the scoring engine. Use `ExchangeAdapter` capabilities such as `get_klines`, order book and recent trades. Normalize symbols outside the strategy where necessary.

---

## 5. Market Data Requirements

### DR-1: Candle inputs

- Request at least 21 completed 1-minute candles.
- Never make the primary decision from an unfinished candle.
- Sort candles by timestamp and reject duplicates or invalid OHLCV values.
- If the adapter returns the active candle, remove it based on timestamp/interval boundaries.
- Use 5-minute candles only for regime/risk context, never as the primary FARM trigger.

### DR-2: Microstructure inputs

When supported, request:

- recent trades sufficient to calculate buy/sell pressure;
- order-book depth sufficient to calculate bid/ask imbalance and current spread;
- current mark price for sanity checks.

All independent data requests should run concurrently.

### DR-3: Data freshness

- A completed 1-minute candle set is stale if the newest completed candle is older than 120 seconds.
- Order book and trade data are stale if older than the existing adapter response/cache policy allows; do not silently treat unavailable data as bullish or bearish.
- Cache a FARM micro signal for no more than 10 seconds.
- Invalidate the cache after an entry order is placed.

### DR-4: Missing data behavior

- Fewer than 10 valid completed 1-minute candles: return `skip`; do not guess a direction.
- 10–20 candles: allow candle-only degraded mode, set `usedFallback=true`, reduce confidence by 20%.
- Missing either trades or order book: assign a neutral component value of `0.5`, mark data quality accordingly and reduce confidence by 10% per missing source.
- Missing both trades and order book: allow candle-only mode only if at least 21 completed candles exist; otherwise return `skip`.
- Adapter does not support 1-minute candles: call the legacy FARM decision path and log the fallback reason. Do not substitute the slow 5-minute signal and label it as micro mode.
- Never fall back to random LONG/SHORT or unconditional ping-pong because data is missing.

---

## 6. Signal Calculation Requirements

Every component must be normalized and clamped to `[0, 1]`, where `0` is strongly bearish, `0.5` is neutral and `1` is strongly bullish. Calculations must be deterministic for identical inputs.

### SR-1: Candle momentum — weight 30%

Use completed 1-minute candles and include both:

- short return over the latest 3 completed candles;
- EMA5 versus EMA13 distance normalized by ATR(14).

Cap outliers so one fast candle cannot dominate the total score. Do not use the direction of a single candle by itself.

### SR-2: Wick/close rejection — weight 25%

Use the latest 2 completed candles:

- bullish evidence: lower-wick rejection and close near candle high;
- bearish evidence: upper-wick rejection and close near candle low;
- doji or negligible range: neutral.

Guard all divisions against zero-range candles.

### SR-3: Volume acceleration — weight 20%

Compare average volume of the latest 3 completed candles with the preceding 10-candle average. Volume increases confidence in the direction of multi-candle price movement; high volume without a directional move remains neutral.

### SR-4: Recent trade pressure — weight 15%

Calculate buy volume divided by total classified trade volume. If the adapter's side semantics differ, normalize them in the adapter/data layer. Zero or unclassified volume is neutral.

### SR-5: Order-book imbalance — weight 10%

Calculate top-N bid and ask notional using the existing configured depth level where possible:

```text
bidNotional / (bidNotional + askNotional)
```

An empty or crossed/invalid book must not produce an actionable signal.

### SR-6: Composite score

Default formula:

```text
score =
  candleMomentum      * 0.30 +
  wickRejection       * 0.25 +
  volumeAcceleration  * 0.20 +
  tradePressure       * 0.15 +
  orderbookImbalance  * 0.10
```

If a microstructure source is unavailable, its component remains neutral; do not redistribute its weight. Clamp the final result to `[0, 1]`.

### SR-7: Direction thresholds

Default thresholds:

```text
score >= 0.60 -> LONG candidate
score <= 0.40 -> SHORT candidate
0.40 < score < 0.60 -> SKIP
```

Threshold equality behavior must be tested. Thresholds must be configurable.

### SR-8: Confidence

Confidence must increase with distance from `0.5` and with data completeness. It must decrease for stale/degraded data and conflicting components. A score near `0.5` must never have high confidence.

The implementation may choose the exact deterministic formula, but it must be documented and unit-tested. Minimum actionable confidence defaults to `0.55`.

---

## 7. Regime and Entry Guard Requirements

### GR-1: Regime context

Reuse the existing regime detector where possible, based on completed 5-minute candles. The regime can veto or tighten an entry but must not supply the primary direction.

### GR-2: Trend behavior

- `TREND_UP`: allow LONG at normal thresholds; SHORT requires score `<= 0.30` and explicit bearish 1-minute momentum.
- `TREND_DOWN`: allow SHORT at normal thresholds; LONG requires score `>= 0.70` and explicit bullish 1-minute momentum.
- `SIDEWAY`: allow both sides at normal thresholds and favor wick rejection/mean reversion naturally through the score.
- `HIGH_VOLATILITY`: require confidence `>= 0.65` and apply the existing high-volatility size reduction.
- `UNKNOWN`: require confidence `>= 0.65`.

### GR-3: Fee and spread edge

Before placing an order:

- retain the existing `EXEC_MAX_SPREAD_BPS` guard;
- estimate the expected short-horizon move from recent 1-minute ATR;
- skip if expected executable movement does not cover round-trip fee plus configured safety multiplier;
- invalid price, ATR, fee or spread values must fail closed with `skip`.

### GR-4: No forced entry

Micro mode is allowed to return `skip`. A neutral score, stale data, inadequate edge or failed guard must not be converted into ping-pong direction solely to generate volume.

Existing market-maker inventory logic may:

- block an entry;
- reduce size;
- prefer flattening risk when there is existing inventory.

It must not flip a valid directional micro signal into its opposite merely to alternate sides.

---

## 8. Configuration Requirements

Add typed configuration with environment overrides, following the project's existing config-loading pattern:

```text
FARM_MICRO_ENABLED=false
FARM_MICRO_SYMBOLS=BTC-USD,BTC-PERP,BTCUSDT
FARM_MICRO_INTERVAL=1m
FARM_MICRO_CANDLE_LIMIT=30
FARM_MICRO_CACHE_SECS=10
FARM_MICRO_LONG_THRESHOLD=0.60
FARM_MICRO_SHORT_THRESHOLD=0.40
FARM_MICRO_MIN_CONFIDENCE=0.55
FARM_MICRO_HIGH_VOL_MIN_CONFIDENCE=0.65
FARM_MICRO_TREND_COUNTER_THRESHOLD=0.70
FARM_MICRO_MAX_CANDLE_AGE_SECS=120
FARM_MICRO_FEE_SAFETY_MULT=1.5
```

Requirements:

- Default `FARM_MICRO_ENABLED=false` for safe rollout.
- Validate all numeric ranges during config load.
- Invalid settings must produce a clear startup warning/error and fall back to safe defaults; never produce `NaN` trading decisions.
- Do not hard-code exchange credentials or symbol-specific prices.
- Document new values in `.env.example` and the FARM section of `README.md`.

---

## 9. State, Logs and Analytics

### LR-1: Decision log

Produce one concise structured log per evaluation, for example:

```text
[FarmMicro] BTC-USD 1m score=0.64 conf=0.71 dir=LONG regime=SIDEWAY mom=0.70 wick=0.66 vol=0.61 pressure=0.58 ob=0.55 age=34s
```

For a skipped decision, include a stable reason code such as:

```text
NEUTRAL_ZONE
LOW_CONFIDENCE
STALE_CANDLES
INSUFFICIENT_CANDLES
SPREAD_TOO_WIDE
EDGE_BELOW_FEES
COUNTER_TREND_BLOCKED
INVALID_MARKET_DATA
UNSUPPORTED_INTERVAL
```

### LR-2: Trade metadata

Persist the following with the entry/trade record without breaking older records:

- `signalSource: 'farm_micro' | 'legacy_ai'`;
- composite score and confidence;
- five component scores;
- candle interval and newest candle age;
- regime;
- fallback/degraded flags;
- entry guard result and reason.

All new fields must be optional when reading historical data.

### LR-3: Metrics

Expose enough data to compare legacy FARM and micro FARM by:

- net PnL after fees;
- total fees;
- volume generated;
- net cost per $1,000 volume;
- win rate;
- average PnL per trade;
- fill rate;
- skip rate and skip reasons;
- average holding time;
- MAE/MFE at 30, 60 and 180 seconds when data is available;
- performance by regime and `signalSource`.

Do not claim success from win rate alone.

---

## 10. Backward Compatibility and Rollout

### BR-1: Feature disabled

When `FARM_MICRO_ENABLED=false`, behavior must be identical to the current system except for harmless additional initialization/logging.

### BR-2: Unsupported bot

TRADE, hedge, pair and non-crypto bots must continue using their existing paths.

### BR-3: Runtime failure

If the new engine throws or receives unsupported data:

- catch the error at the integration boundary;
- log a stable failure reason without secrets;
- fall back to legacy FARM evaluation for that tick;
- do not place two entry orders for one tick;
- do not corrupt pending-position state.

### BR-4: Rollout phases

1. Ship disabled by default.
2. Run backtests/replay comparisons against legacy FARM.
3. Enable for one BTC FARM bot only.
4. Compare at least 100 closed trades per variant where operationally possible.
5. Expand only after reviewing net cost/PnL after fees, fill rate, drawdown and data-quality fallbacks.

---

## 11. Testing Requirements

### TR-1: Unit tests

Add tests for:

- bullish, bearish and neutral candle sequences;
- wick rejection in both directions;
- zero-range/doji candles;
- zero and missing volume;
- stale, duplicated, out-of-order and unfinished candles;
- missing order book and/or trades;
- exact threshold boundaries `0.40` and `0.60`;
- counter-trend regime restrictions;
- fee/spread guard;
- cache TTL and invalidation;
- all outputs being finite and within `[0, 1]`.

### TR-2: Property tests

For arbitrary valid OHLCV data:

- score and confidence are finite and bounded;
- identical input produces identical output;
- invalid/insufficient data never produces an entry;
- raising only bullish evidence must not make the score more bearish;
- raising only bearish evidence must not make the score more bullish.

### TR-3: Integration tests

Verify:

- FARM micro enabled calls the new engine and does not call `AISignalEngine` for direction;
- FARM micro disabled retains legacy behavior;
- TRADE always retains `AISignalEngine` behavior;
- one bot tick can place at most one entry;
- `skip` never reaches `Executor.placeEntryOrder`;
- engine failure invokes legacy fallback exactly once;
- existing position, pending order and inventory guards still prevent duplicate exposure.

### TR-4: Regression

Run:

```bash
npm test
npm run build
```

All pre-existing tests must pass. Update tests only where the intended requirement changes behavior; do not weaken unrelated assertions.

---

## 12. Acceptance Criteria

The feature is complete only when all of the following are true:

1. With the flag enabled for a supported BTC FARM bot, entry direction comes from completed 1-minute candles plus available microstructure data.
2. The enabled FARM path does not call SoSoValue, an LLM or `AISignalEngine` to decide direction.
3. A neutral/unsafe evaluation returns `skip` and places no order.
4. No unfinished or stale candle can cause an entry.
5. Missing data follows the deterministic degradation/fallback rules.
6. TRADE mode and other bot types behave exactly as before.
7. Existing risk, inventory, execution and exit protections remain active.
8. Logs and trade records identify the source and full component snapshot.
9. Unit, property and integration tests cover the cases in Section 11.
10. `npm test` and `npm run build` succeed.
11. `.env.example` and `README.md` document activation, defaults, behavior and rollback.
12. No credentials, session tokens, live trade logs or mutable runtime state are added to source control.

---

## 13. Implementation Constraints for Kiro

- Follow `kiro/system.md`: OOP, interface-based design, composition over inheritance, no strategy-to-adapter coupling and no breaking backward compatibility.
- Inspect the current `Watcher`, `AISignalEngine`, `FarmSignalFilters`, `MarketMaker`, `Executor`, config loader and adapter interfaces before designing changes.
- Reuse pure existing indicator utilities where correct; do not duplicate EMA/ATR calculations unnecessarily.
- Keep calculation functions pure and independently testable.
- Do not silently delete legacy FARM code in the first release.
- Do not tune thresholds against production trade logs in source control.
- Before coding, produce design and task documents mapped back to the requirement IDs above.

---

## 14. Deliverables

1. Requirements/design/task artifacts used by Kiro.
2. `FarmMicroSignalEngine` and supporting types/pure calculations.
3. Minimal `Watcher` integration behind the feature flag.
4. Typed config and environment overrides.
5. Optional, backward-compatible logging/analytics fields.
6. Unit, property, integration and regression tests.
7. README and `.env.example` updates.
8. A short rollout/rollback note with observed test and backtest results; do not invent live-performance results.

