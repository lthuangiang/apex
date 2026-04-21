# HedgeBot Double Trade Bugfix Design

## Overview

When HedgeBot re-enters `OPENING` state after a fill-timeout retry, it places fresh limit orders
for **both** legs without first checking whether one leg already has an open position from an
earlier fill. This causes the already-filled leg to accumulate a second position, doubling its
intended notional size (2× `legValueUsd`).

The fix adds a position-existence check at the top of `_tickOpening()`. Before placing any order,
the method queries `get_position` for both symbols. Any leg that already has an open position is
skipped — only legs with no existing position receive a new order. If all legs are already filled,
the method transitions directly to `WAITING_FILL` (or `IN_PAIR`) without placing any orders.

The change is minimal and surgical: it touches only `_tickOpening()` in `src/bot/HedgeBot.ts`
and does not alter any other state-machine path.

---

## Glossary

- **Bug_Condition (C)**: The condition that triggers the double-trade bug — `OPENING` is entered
  while at least one leg already has an open position from a prior fill.
- **Property (P)**: The desired behavior when the bug condition holds — no new order is placed for
  a leg that already has an open position; its position size remains unchanged.
- **Preservation**: All `OPENING` behavior for the normal case (neither leg filled) must remain
  exactly as before.
- **`_tickOpening()`**: The method in `src/bot/HedgeBot.ts` that places entry limit orders for
  both legs when the bot is in `OPENING` state.
- **`_tickWaitingFill()`**: The method that polls for fill confirmation and handles Case 1
  (one filled, one rejected) by re-placing the rejected leg.
- **`legAFilled` / `legBFilled`**: Boolean flags indicating whether `get_position` returns a
  non-null, non-zero position for symbolA / symbolB at the start of an `OPENING` tick.
- **`openingContext`**: The `_openingContext` object that carries direction assignment, signal
  scores, and order IDs across OPENING → WAITING_FILL ticks.

---

## Bug Details

### Bug Condition

The bug manifests when `_tickOpening()` is called while one leg already has an open position
(from a fill that occurred during a previous `WAITING_FILL` cycle). The method does not query
existing positions before placing orders, so it unconditionally places a new order for the
already-filled leg, resulting in a doubled position.

**Formal Specification:**

```
FUNCTION isBugCondition(X)
  INPUT: X of type HedgeBotEntryAttempt {
    legAFilled: boolean,       -- leg A has an open position from a prior fill
    legBFilled: boolean,       -- leg B has an open position from a prior fill
    state: HedgeBotState       -- current bot state
  }
  OUTPUT: boolean

  RETURN X.state = 'OPENING'
         AND (X.legAFilled OR X.legBFilled)
END FUNCTION
```

### Examples

- **Scenario (bug triggers)**: BTC order rejected, ETH order fills. Fill timeout expires while
  re-placed BTC order is still pending. Bot cancels BTC order and transitions back to `OPENING`.
  Next `OPENING` tick: ETH already has a position (size = 0.5), but the bot places a new ETH
  sell order anyway → ETH ends up at size 1.0 (2× intended).

- **Scenario (bug triggers)**: BTC order fills, ETH order rejected. Fill timeout expires while
  re-placed ETH order is still pending. Bot cancels ETH order and transitions back to `OPENING`.
  Next `OPENING` tick: BTC already has a position, but the bot places a new BTC buy order anyway
  → BTC ends up at 2× intended size.

- **Scenario (no bug — normal path)**: Both legs have no existing positions when `OPENING` is
  entered for the first time. Bot places both orders normally. No double-trade risk.

- **Edge case**: Both legs already have open positions when `OPENING` is entered (e.g. after a
  crash-recovery scenario). The fixed code detects both as filled and transitions directly to
  `WAITING_FILL` without placing any orders.

---

## Expected Behavior

### Preservation Requirements

**Unchanged Behaviors:**
- When neither leg has an existing position, `_tickOpening()` must continue to place limit orders
  for both legs exactly as before (Requirement 3.1).
- When both legs fill successfully during `WAITING_FILL`, the bot must continue to transition to
  `IN_PAIR` with the correct position sizes (Requirement 3.2).
- When stale open orders are detected at the start of `OPENING`, the bot must continue to cancel
  them before placing fresh orders (Requirement 3.3).
- When the fill timeout expires and both legs are still pending (no fills), the bot must continue
  to cancel both pending orders and retry from `OPENING` (Requirement 3.4).
- When a leg placement fails during `OPENING` and the other leg was successfully placed, the bot
  must continue to cancel the successful order and return to `IDLE` (Requirement 3.5).
- `IN_PAIR`, `CLOSING`, and `COOLDOWN` state handlers must remain completely unchanged (Requirement 3.6).

**Scope:**
All inputs where neither leg has an existing open position at the start of `OPENING` are
completely unaffected by this fix. This includes:
- First-time entry attempts (normal flow from `IDLE`)
- Retries after a full timeout where both legs were still pending (no fills occurred)
- Any scenario where `get_position` returns `null` or `size === 0` for both symbols

**Note:** The actual expected correct behavior for the bug condition is defined in the
Correctness Properties section (Property 1). This section focuses on what must NOT change.

---

## Hypothesized Root Cause

Based on the bug description and code analysis, the root cause is:

1. **Missing Position Pre-Check in `_tickOpening()`**: The method checks for stale *open orders*
   (via `get_open_orders`) before placing new orders, but it does **not** check for existing
   *open positions* (via `get_position`). Open orders and open positions are distinct: an order
   that has already filled no longer appears in `get_open_orders`, but it does appear in
   `get_position`. The stale-order check therefore cannot detect a previously filled leg.

2. **Timeout Retry Path Bypasses Fill State**: When `_tickWaitingFill()` times out, it cancels
   pending orders and transitions back to `OPENING` (not `IDLE`). This is intentional — it
   preserves the `_openingContext` so the bot can retry at current market prices. However, it
   does not clear or account for any leg that may have already filled before the timeout, leaving
   the bot in a state where `OPENING` will re-place an order for an already-filled leg.

3. **`_openingContext` Does Not Track Fill Status**: The context object stores `orderIdA` and
   `orderIdB` but does not record which legs have been confirmed filled. When `OPENING` is
   re-entered after a timeout, there is no in-memory signal that one leg is already live.

4. **No Guard Against Duplicate Positions**: The exchange adapter (`place_limit_order`) does not
   reject orders that would add to an existing position — it simply executes them, resulting in
   the doubled size.

---

## Correctness Properties

Property 1: Bug Condition — No New Order for Already-Filled Leg

_For any_ `OPENING` tick where `isBugCondition` returns true (at least one leg already has an
open position), the fixed `_tickOpening()` SHALL NOT place a new order for the already-filled
leg. The position size for that leg SHALL remain unchanged after the tick completes.

**Validates: Requirements 2.1, 2.2, 2.3**

Property 2: Preservation — Normal OPENING Behavior Unchanged

_For any_ `OPENING` tick where `isBugCondition` returns false (neither leg has an existing open
position), the fixed `_tickOpening()` SHALL produce exactly the same observable behavior as the
original `_tickOpening()`: both legs receive fresh limit orders, and the bot transitions to
`WAITING_FILL` on success.

**Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5**

---

## Fix Implementation

### Changes Required

**File**: `src/bot/HedgeBot.ts`

**Method**: `_tickOpening()`

**Specific Changes**:

1. **Add Position Pre-Check Step**: After the existing stale-order cancellation block (Step 1)
   and before fetching mark prices (Step 2), insert a new step that calls `get_position` for
   both symbols in parallel.

2. **Skip Already-Filled Legs**: If `get_position` returns a non-null, non-zero position for
   a leg, do not place a new order for that leg. Log a message indicating the leg is already
   filled and will be skipped.

3. **Handle All-Filled Case**: If both legs already have open positions, transition directly to
   `WAITING_FILL` (preserving `_openingContext`) without placing any orders. The existing
   `_tickWaitingFill()` logic will then detect both legs as filled and transition to `IN_PAIR`.

4. **Selective Order Placement**: When only one leg needs a new order (the other is already
   filled), place only that one order. Store its order ID in the appropriate field of
   `_openingContext` (`orderIdA` or `orderIdB`). Transition to `WAITING_FILL` as normal.

5. **Error Handling**: If the `get_position` call fails, log a warning and skip the tick
   (same pattern as the existing stale-order check failure handling).

**Pseudocode for the new step:**

```
// Step 1.5: Check for existing open positions — skip placing orders for already-filled legs
posA ← get_position(symbolA, markPriceA_approx)   // or use 0 as placeholder price
posB ← get_position(symbolB, markPriceB_approx)

legAFilled ← posA !== null AND posA.size > 0
legBFilled ← posB !== null AND posB.size > 0

IF legAFilled AND legBFilled THEN
  log "Both legs already filled — transitioning to WAITING_FILL"
  state ← WAITING_FILL
  RETURN
END IF

// Proceed to place orders only for unfilled legs
// (mark price fetch and order placement remain unchanged for unfilled legs)
```

**Implementation note**: `get_position` requires a mark price. Since we haven't fetched mark
prices yet at this point in the method, we can either (a) fetch mark prices first and then check
positions, or (b) use a placeholder price of `0` for the position check (since we only need to
know whether a position exists, not its PnL). Option (a) is cleaner and reuses the existing mark
price fetch. The implementation should reorder the steps so mark prices are fetched before the
position check, or fetch mark prices once and use them for both the position check and order sizing.

---

## Testing Strategy

### Validation Approach

The testing strategy follows a two-phase approach: first, surface counterexamples that demonstrate
the bug on unfixed code, then verify the fix works correctly and preserves existing behavior.

### Exploratory Bug Condition Checking

**Goal**: Surface counterexamples that demonstrate the bug BEFORE implementing the fix. Confirm
or refute the root cause analysis. If we refute, we will need to re-hypothesize.

**Test Plan**: Write tests that simulate the exact failure scenario — one leg filled, fill timeout
expires, bot re-enters `OPENING`, and the already-filled leg receives a second order. Run these
tests on the UNFIXED code to observe that `place_limit_order` is called for the already-filled
leg.

**Test Cases**:

1. **ETH Already Filled, BTC Rejected — Re-enters OPENING** (will fail on unfixed code):
   Set up `_openingContext` with `longSymbol = 'BTC-USD'`, `shortSymbol = 'ETH-USD'`.
   Mock `get_open_orders` to return `[]` for both symbols (no stale orders).
   Mock `get_position` to return a non-null position for ETH-USD (size > 0) and null for BTC-USD.
   Call `_tickOpening()`. Assert that `place_limit_order` is NOT called for ETH-USD.
   On unfixed code, `place_limit_order` WILL be called for ETH-USD → test fails → bug confirmed.

2. **BTC Already Filled, ETH Rejected — Re-enters OPENING** (will fail on unfixed code):
   Same setup but with BTC-USD having the existing position.
   Assert that `place_limit_order` is NOT called for BTC-USD.

3. **Both Legs Already Filled — Re-enters OPENING** (will fail on unfixed code):
   Mock both `get_position` calls to return non-null positions.
   Assert that `place_limit_order` is NOT called for either leg.
   Assert that state transitions to `WAITING_FILL`.

4. **Position Check API Failure** (may fail on unfixed code):
   Mock `get_position` to throw. Assert the tick returns early without placing orders.

**Expected Counterexamples**:
- `place_limit_order` is called for the already-filled leg, adding to the existing position.
- Possible causes: no position pre-check exists; only open-order check is performed.

### Fix Checking

**Goal**: Verify that for all inputs where the bug condition holds, the fixed function produces
the expected behavior.

**Pseudocode:**
```
FOR ALL X WHERE isBugCondition(X) DO
  result := _tickOpening_fixed(X)
  ASSERT place_limit_order NOT called for already-filled leg
  ASSERT position size for already-filled leg unchanged
  ASSERT state transitions correctly (WAITING_FILL or remains in OPENING for unfilled leg)
END FOR
```

### Preservation Checking

**Goal**: Verify that for all inputs where the bug condition does NOT hold, the fixed function
produces the same result as the original function.

**Pseudocode:**
```
FOR ALL X WHERE NOT isBugCondition(X) DO
  ASSERT _tickOpening_original(X) = _tickOpening_fixed(X)
  -- Both legs receive fresh orders as before
  -- State transitions to WAITING_FILL as before
END FOR
```

**Testing Approach**: Property-based testing is recommended for preservation checking because:
- It generates many combinations of mark prices, leg sizes, and order outcomes automatically.
- It catches edge cases (e.g. very small or very large prices) that manual tests might miss.
- It provides strong guarantees that the normal OPENING path is unchanged for all non-buggy inputs.

**Test Plan**: Observe behavior on UNFIXED code first for the normal (neither-leg-filled) path,
then write property-based tests capturing that behavior.

**Test Cases**:

1. **Normal Path Preservation**: Verify that when both `get_position` calls return null, the
   fixed `_tickOpening()` still calls `place_limit_order` for both legs and transitions to
   `WAITING_FILL` — identical to the original behavior.

2. **Stale Order Cancellation Preservation**: Verify that when stale open orders exist, the
   fixed method still cancels them and returns (no orders placed this tick) — unchanged.

3. **Mark Price Fetch Failure Preservation**: Verify that when `get_mark_price` fails, the
   fixed method still returns to `IDLE` — unchanged.

4. **Leg Placement Failure Preservation**: Verify that when one leg's `place_limit_order` fails,
   the fixed method still cancels the successful leg and returns to `IDLE` — unchanged.

### Unit Tests

- Test that `_tickOpening()` skips `place_limit_order` for leg A when `get_position(symbolA)`
  returns a non-null, non-zero position.
- Test that `_tickOpening()` skips `place_limit_order` for leg B when `get_position(symbolB)`
  returns a non-null, non-zero position.
- Test that `_tickOpening()` transitions to `WAITING_FILL` without placing any orders when both
  legs already have positions.
- Test that `_tickOpening()` still places orders for both legs when neither has a position
  (normal path — preservation).
- Test that `_tickOpening()` returns early (skips tick) when `get_position` throws an error.

### Property-Based Tests

- Generate random mark prices and position states: for any combination where at least one leg
  has a non-null position, verify that `place_limit_order` is never called for that leg.
- Generate random mark prices where both positions are null: verify that `place_limit_order` is
  called exactly twice (once per leg) and the bot transitions to `WAITING_FILL`.
- Generate random combinations of `legAFilled` / `legBFilled` flags: verify that the number of
  `place_limit_order` calls equals the number of unfilled legs (0, 1, or 2).

### Integration Tests

- Full scenario: BTC rejected, ETH fills, timeout expires, bot re-enters `OPENING` → verify ETH
  position size remains at 1× `legValueUsd` after the second `OPENING` tick.
- Full scenario: both legs fill on first attempt → verify normal `IN_PAIR` transition is
  unaffected by the fix.
- Full scenario: both legs rejected on first attempt → verify both are re-placed on retry from
  `OPENING` (no existing positions, so normal path applies).
