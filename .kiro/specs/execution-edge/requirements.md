# Requirements: Execution Edge (Phase 5)

## Introduction

Phase 5 adds market-aware execution intelligence to APEX's order placement. Currently, all entry orders are placed at best_bid or best_ask with a fixed zero offset, with no awareness of spread width, orderbook depth, or historical fill performance. This phase introduces three capabilities: dynamic price offset computation, fill probability tracking, and a spread guard that prevents entries during illiquid conditions.

---

## Requirements

### 1. Smart Order Placement

#### 1.1
**What**: The system shall compute a dynamic price offset for Post-Only entry orders based on current market conditions.

**Why**: A static zero offset means orders are always placed at the very top of the book. In wide-spread or thin-book conditions this increases the risk of crossing the spread (losing maker status) or never filling. A dynamic offset keeps the order inside the book at a price that reflects actual market liquidity.

**Acceptance Criteria**:
- Given a normal market (spread ≤ `EXEC_MAX_SPREAD_BPS`, deep book), the computed offset is greater than or equal to zero.
- Given a wider spread, the computed offset is greater than or equal to the offset for a narrower spread (all else equal).
- Given a thin orderbook (`depthScore < EXEC_DEPTH_THIN_THRESHOLD`), the offset includes `EXEC_DEPTH_PENALTY` added to the base spread-derived offset.
- The final offset is always clamped to `[EXEC_OFFSET_MIN, EXEC_OFFSET_MAX]`.

#### 1.2
**What**: The offset formula shall be: `offset = clamp(spreadBps × EXEC_SPREAD_OFFSET_MULT + depthPenalty + fillRatePenalty, EXEC_OFFSET_MIN, EXEC_OFFSET_MAX)`.

**Why**: An additive formula with independently tunable components allows each factor to be adjusted without affecting the others. The clamp prevents runaway offsets from misconfigured multipliers.

**Acceptance Criteria**:
- `spreadBps × EXEC_SPREAD_OFFSET_MULT` contributes the base offset proportional to spread width.
- `depthPenalty` is `EXEC_DEPTH_PENALTY` when `depthScore < EXEC_DEPTH_THIN_THRESHOLD`, otherwise 0.
- `fillRatePenalty` is `EXEC_FILL_RATE_PENALTY` when recent fill rate < `EXEC_FILL_RATE_THRESHOLD` and sample size > 0, otherwise 0.
- The result is clamped to `[EXEC_OFFSET_MIN, EXEC_OFFSET_MAX]`.

#### 1.3
**What**: The depth score shall be computed as the sum of `price × size` for the top `EXEC_DEPTH_LEVELS` levels on the relevant side of the orderbook (bid side for long entries, ask side for short entries).

**Why**: Quote-weighted depth (USD value) is a more meaningful liquidity measure than raw size, since it accounts for price differences across levels.

**Acceptance Criteria**:
- For a long entry, depth score uses bid levels.
- For a short entry, depth score uses ask levels.
- Depth score equals the sum of `price × size` for the top `EXEC_DEPTH_LEVELS` levels.
- If `get_orderbook_depth` fails, depth score defaults to 0 (triggering the thin-book penalty).

---

### 2. Spread-Aware Trading

#### 2.1
**What**: The system shall skip entry order placement when the current spread exceeds `EXEC_MAX_SPREAD_BPS` basis points.

**Why**: Wide spreads indicate illiquid or stressed market conditions. Placing Post-Only orders during wide spreads risks immediate cancellation (if the order crosses the spread) or very long fill times. Skipping entry protects against poor execution quality.

**Acceptance Criteria**:
- Spread is computed as `(best_ask - best_bid) / best_bid × 10000` (basis points).
- If `spreadBps > EXEC_MAX_SPREAD_BPS`, `Executor.placeEntryOrder()` returns `null` without placing an order.
- If `spreadBps <= EXEC_MAX_SPREAD_BPS`, order placement proceeds normally.
- The spread check applies only to entry orders; exit orders (including force-close IOC) are unaffected.

#### 2.2
**What**: The spread check shall be performed inside `ExecutionEdge.computeOffset()` and the result communicated to `Executor` via the `spreadOk` field of `OffsetResult`.

**Why**: Centralising the spread check in `ExecutionEdge` keeps `Executor` thin and makes the check independently testable.

**Acceptance Criteria**:
- `OffsetResult.spreadOk = false` when `spreadBps > EXEC_MAX_SPREAD_BPS`.
- `OffsetResult.spreadOk = true` when `spreadBps <= EXEC_MAX_SPREAD_BPS`.
- `Executor` checks `spreadOk` and returns `null` immediately when `false`.

---

### 3. Fill Probability Tracking

#### 3.1
**What**: The system shall maintain a rolling window of fill outcomes for entry and exit orders using an in-memory ring buffer of size `EXEC_FILL_WINDOW`.

**Why**: A bounded ring buffer provides a recent-history view of fill performance without unbounded memory growth. In-memory storage is sufficient since fill stats are session-local and do not need to survive restarts.

**Acceptance Criteria**:
- Two separate ring buffers are maintained: one for entry orders, one for exit orders.
- Each buffer holds at most `EXEC_FILL_WINDOW` records.
- When a new record is added to a full buffer, the oldest record is evicted.
- Each record stores: `filled` (boolean), `fillMs` (time to outcome in ms), `ts` (timestamp).

#### 3.2
**What**: `Watcher` shall call `FillTracker.recordFill(type, fillMs)` when an order fills and `FillTracker.recordCancel(type)` when an order times out and is cancelled.

**Why**: `Watcher` is the state machine that observes fill/cancel outcomes; it is the correct place to record these events.

**Acceptance Criteria**:
- On `PENDING_ENTRY → IN_POSITION` transition: `recordFill('entry', fillMs)` is called where `fillMs = Date.now() - pendingEntry.placedAt`.
- On `PENDING_ENTRY` timeout → cancel: `recordCancel('entry')` is called.
- On `PENDING_EXIT → IDLE` transition: `recordFill('exit', fillMs)` is called.
- On `PENDING_EXIT` timeout → cancel: `recordCancel('exit')` is called.

#### 3.3
**What**: `FillTracker.getFillStats(type)` shall return `{ fillRate, avgFillMs, sampleSize }` computed from the current ring buffer contents.

**Why**: These stats are consumed by `ExecutionEdge` to compute the fill rate penalty and are available for dashboard display.

**Acceptance Criteria**:
- `fillRate = filledCount / totalCount` where counts are over the current buffer.
- `avgFillMs` is the mean `fillMs` of filled records only (0 if no filled records).
- `sampleSize = buffer.length`.
- When `sampleSize = 0` (empty buffer), `fillRate = 1.0` (optimistic default — no penalty on first order).

---

### 4. Fill Rate Feedback

#### 4.1
**What**: When recent fill rate falls below `EXEC_FILL_RATE_THRESHOLD`, the offset formula shall add `EXEC_FILL_RATE_PENALTY` to move the order price closer to mid.

**Why**: A low fill rate indicates the current placement strategy is too aggressive (price too far from mid). Adding a penalty offset moves the price toward mid, increasing the probability of a fill on the next attempt.

**Acceptance Criteria**:
- If `getFillStats('entry').fillRate < EXEC_FILL_RATE_THRESHOLD` AND `sampleSize > 0`, `fillRatePenalty = EXEC_FILL_RATE_PENALTY`.
- If `fillRate >= EXEC_FILL_RATE_THRESHOLD` OR `sampleSize = 0`, `fillRatePenalty = 0`.
- The penalty is applied additively in the offset formula.

#### 4.2
**What**: The fill rate penalty shall only apply when there is sufficient sample data (`sampleSize > 0`).

**Why**: On the first order of a session there is no history. Applying a penalty with no data would unnecessarily widen the offset.

**Acceptance Criteria**:
- `sampleSize = 0` → `fillRatePenalty = 0` regardless of the threshold.
- `sampleSize > 0` and `fillRate < EXEC_FILL_RATE_THRESHOLD` → `fillRatePenalty = EXEC_FILL_RATE_PENALTY`.

---

### 5. Configuration

#### 5.1
**What**: All execution edge parameters shall be defined in `config.ts` under the `EXEC_` prefix and exposed through `ConfigStore` for live dashboard overrides.

**Why**: Consistent with the existing config pattern used by all other APEX phases. Dashboard overridability allows tuning without redeployment.

**Acceptance Criteria**:
- The following keys are added to `config.ts`: `EXEC_MAX_SPREAD_BPS`, `EXEC_SPREAD_OFFSET_MULT`, `EXEC_DEPTH_LEVELS`, `EXEC_DEPTH_THIN_THRESHOLD`, `EXEC_DEPTH_PENALTY`, `EXEC_FILL_WINDOW`, `EXEC_FILL_RATE_THRESHOLD`, `EXEC_FILL_RATE_PENALTY`, `EXEC_OFFSET_MIN`, `EXEC_OFFSET_MAX`.
- All keys are included in `OverridableConfig` in `ConfigStore.ts`.
- `validateOverrides` rejects `EXEC_OFFSET_MAX < EXEC_OFFSET_MIN` with a descriptive error.
- `validateOverrides` rejects `EXEC_FILL_RATE_THRESHOLD` outside `[0, 1]` with a descriptive error.
- `validateOverrides` rejects `EXEC_DEPTH_LEVELS < 1` with a descriptive error.

#### 5.2
**What**: Default values shall be conservative and safe for live trading.

**Why**: Defaults must not cause regressions on existing behaviour. The zero-offset behaviour of the current system should be approximately preserved under normal market conditions.

**Acceptance Criteria**:
- `EXEC_MAX_SPREAD_BPS = 10` (10 bps — typical BTC perp spread is 1–3 bps; 10 bps is a generous guard).
- `EXEC_SPREAD_OFFSET_MULT = 0.3` (at 2 bps spread → 0.6 USD offset, close to current zero-offset behaviour).
- `EXEC_DEPTH_LEVELS = 5`.
- `EXEC_DEPTH_THIN_THRESHOLD = 50000` (USD).
- `EXEC_DEPTH_PENALTY = 0.5` (USD).
- `EXEC_FILL_WINDOW = 20`.
- `EXEC_FILL_RATE_THRESHOLD = 0.6`.
- `EXEC_FILL_RATE_PENALTY = 1.0` (USD).
- `EXEC_OFFSET_MIN = 0`.
- `EXEC_OFFSET_MAX = 5` (USD).

---

### 6. Logging and Observability

#### 6.1
**What**: `Executor` shall log the offset result on every entry order attempt, including spread, depth score, and fill rate penalty.

**Why**: Execution quality is critical for a trading bot. Operators need visibility into why a specific offset was chosen or why an entry was skipped.

**Acceptance Criteria**:
- On every `placeEntryOrder` call, a log line is emitted with: `offset`, `spreadBps`, `depthScore`, `fillRatePenalty`, and `spreadOk`.
- When `spreadOk = false`, a log line is emitted indicating the spread value and the threshold.

#### 6.2
**What**: Fill stats shall be accessible for dashboard display.

**Why**: Operators should be able to monitor fill rate trends to detect execution quality degradation.

**Acceptance Criteria**:
- `FillTracker` exposes `getFillStats('entry')` and `getFillStats('exit')` publicly.
- Fill stats are included in `sharedState` or accessible via the dashboard API (implementation detail deferred to tasks).

#### 6.3
**What**: `FillTracker.reset()` shall be called when `Watcher.resetSession()` is called.

**Why**: Fill stats are session-local. Resetting the session should clear stale fill history so the new session starts with a clean slate.

**Acceptance Criteria**:
- `Watcher.resetSession()` calls `fillTracker.reset()`.
- After `reset()`, both ring buffers are empty and `getFillStats()` returns `sampleSize = 0`.
