# Decibel Today Volume Fix — Bugfix Design

## Overview

The Decibel dashboard displays "Today Volume (UTC): $0.00" even when the bot has been actively trading. The root cause is that `todayVolume` in `sharedState` is maintained purely in-memory via `addTodayVolume()` calls triggered by fill events in `Watcher.ts`. Two failure modes exist: (1) a bot restart mid-day wipes accumulated volume, and (2) missed fill events (polling gaps, WebSocket errors) mean `addTodayVolume` is never called for those trades.

The fix adds a `getTodayVolumeFromAPI()` method to `DecibelAdapter` that queries `read.userTradeHistory.getByAddr()` — the authoritative source of truth — and sums `size * price` for all trades within the current UTC day. This is called on startup and periodically (~every 5 minutes) in the Watcher tick to reconcile `todayVolume` against actual executed trades. Real-time `addTodayVolume()` calls are preserved for immediate UI feedback.

## Glossary

- **Bug_Condition (C)**: The condition that triggers the bug — trades exist in the Decibel API for today but `todayVolume` in `sharedState` does not reflect them (due to restart or missed fills)
- **Property (P)**: The desired behavior — `todayVolume` equals the sum of `size * price` for all Decibel trades where `transaction_unix_ms` falls within the current UTC day
- **Preservation**: Existing real-time `addTodayVolume()` calls, non-Decibel adapter behavior, and UTC-day reset logic that must remain unchanged
- **`getTodayVolumeFromAPI()`**: New method on `DecibelAdapter` in `src/adapters/decibel_adapter.ts` that queries the trade history API and computes today's volume
- **`reconcileTodayVolume()`**: New method on `Watcher` in `src/modules/Watcher.ts` that calls `getTodayVolumeFromAPI()` if the adapter supports it and updates `sharedState`
- **`todayVolume`**: The `sharedState` property displayed as "Today Volume (UTC)" on the dashboard
- **`transaction_unix_ms`**: UTC timestamp in milliseconds on each trade history item from the Decibel API
- **`todayStartMs` / `tomorrowStartMs`**: UTC midnight boundaries used to filter trades to the current day

## Bug Details

### Bug Condition

The bug manifests when the bot has executed trades on the Decibel exchange during the current UTC day, but `todayVolume` in `sharedState` is 0 (or stale) because either the bot was restarted mid-day or fill events were missed. The `addTodayVolume()` function is only called from `_onEntryFilled()` and `_onExitFilled()` in `Watcher.ts` — if those callbacks are never triggered for a trade (restart, WS error), the volume is never counted.

**Formal Specification:**
```
FUNCTION isBugCondition(X)
  INPUT: X of type { botRestartedMidDay: boolean, fillsMissed: boolean, tradesExistInAPI: boolean }
  OUTPUT: boolean

  RETURN X.tradesExistInAPI
         AND (X.botRestartedMidDay OR X.fillsMissed)
         AND sharedState.todayVolume < actualAPIVolume(currentUTCDay)
END FUNCTION
```

### Examples

- **Bot restart at 14:00 UTC**: Bot traded $50,000 volume before restart. After restart, `todayVolume` resets to 0 (or restores a stale persisted value). Dashboard shows $0.00 instead of $50,000+.
- **WebSocket error at 10:00 UTC**: Fill event for a $5,000 trade is missed. `addTodayVolume` is never called. Dashboard shows $X instead of $X + $5,000.
- **Fresh start with no prior state**: Bot starts at 08:00 UTC, no `bot_state.json` exists. `todayVolume` starts at 0. Without API reconciliation, any trades from before this session are invisible.
- **Edge case — API error**: `getTodayVolumeFromAPI()` throws. System must keep the last known `todayVolume` and not reset to 0.

## Expected Behavior

### Preservation Requirements

**Unchanged Behaviors:**
- Real-time `addTodayVolume()` calls from `_onEntryFilled()` and `_onExitFilled()` in `Watcher.ts` must continue to fire for immediate UI feedback
- UTC-day reset logic in `addTodayVolume()` (resetting `todayVolume` to 0 when `todayVolumeDate` changes) must remain unchanged
- Non-Decibel adapters (Sodex, Dango) must not be affected — no Decibel-specific API calls should be made for those adapters
- `StateStore.loadState()` restoration of `todayVolume` from `bot_state.json` (when same UTC day) must continue to work as a baseline
- API errors from `getTodayVolumeFromAPI()` must not crash the bot or reset `todayVolume` to 0

**Scope:**
All inputs that do NOT involve the bug condition (no restart, no missed fills, non-Decibel adapter) should be completely unaffected by this fix. This includes:
- Sodex and Dango adapter operation
- Real-time fill event processing
- Session volume tracking (`sessionVolume`)
- UTC-day boundary resets

## Hypothesized Root Cause

Based on the bug description and code analysis:

1. **No API Reconciliation on Startup**: `StateStore.loadState()` restores `todayVolume` from `bot_state.json` only if the saved date matches today — but if the bot was restarted after a crash (no clean shutdown), the persisted value may be stale or missing. There is no call to the Decibel trade history API to establish the true baseline.

2. **No Periodic Reconciliation**: The Watcher tick loop never queries `read.userTradeHistory.getByAddr()`. Volume is accumulated only via `addTodayVolume()` in `_onEntryFilled()` / `_onExitFilled()`. Any fill event that is missed (WS disconnect, polling gap) is permanently lost.

3. **In-Memory Only Accumulation**: `addTodayVolume()` is a pure in-memory accumulator. It has no awareness of what the exchange actually executed — it only knows what the bot observed locally.

4. **Missing Interface Method**: `ExchangeAdapter` interface has no `getTodayVolumeFromAPI()` method, so `Watcher.ts` cannot call it generically. The reconciliation logic must be gated on adapter type (duck-typing or optional interface extension).

## Correctness Properties

Property 1: Bug Condition — API Volume Reconciliation

_For any_ state where `isBugCondition` holds (trades exist in the Decibel API for today but `sharedState.todayVolume` does not reflect them due to restart or missed fills), the fixed system SHALL set `sharedState.todayVolume` to the sum of `size * price` for all trades where `transaction_unix_ms >= todayStartMs && transaction_unix_ms < tomorrowStartMs`, as returned by `read.userTradeHistory.getByAddr()`.

**Validates: Requirements 2.1, 2.2, 2.3**

Property 2: Preservation — Non-Buggy Input Behavior

_For any_ input where `isBugCondition` does NOT hold (non-Decibel adapter, no restart, no missed fills, or API error), the fixed system SHALL produce the same `todayVolume` behavior as the original system — real-time `addTodayVolume()` accumulation, UTC-day resets, and `StateStore` restoration all continue to work identically.

**Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5**

## Fix Implementation

### Changes Required

Assuming our root cause analysis is correct:

**File**: `src/adapters/decibel_adapter.ts`

**Function**: New method `getTodayVolumeFromAPI()`

**Specific Changes**:
1. **Add `getTodayVolumeFromAPI()` method**: Computes UTC day boundaries (`todayStartMs`, `tomorrowStartMs`), calls `this.read.userTradeHistory.getByAddr({ subAddr: this.subaccountAddr, limit: 200 })`, filters items by `transaction_unix_ms` within today's UTC day, and returns `sum(item.size * item.price)`.
2. **Handle pagination**: If `total_count > 200`, make additional calls with `offset` to capture all trades.
3. **Error handling**: Wrap in try/catch; on error, throw so the caller can decide to keep the existing value.

---

**File**: `src/modules/Watcher.ts`

**Function**: New method `reconcileTodayVolume()` + calls in `run()` and `_tick()`

**Specific Changes**:
1. **Add `reconcileTodayVolume()` method**: Duck-type checks if `this.adapter` has `getTodayVolumeFromAPI`. If yes, calls it and updates `sharedState.todayVolume` (and `_botSharedState.todayVolume` if multi-bot). Catches errors and logs a warning without resetting volume.
2. **Call on startup**: In `run()`, after `this._setState({ botStatus: 'RUNNING' })`, call `await this.reconcileTodayVolume()` to establish accurate baseline before first tick.
3. **Call periodically**: Add a `_lastVolumeReconcileAt` timestamp. In `_tick()`, after fetching market data, check if 5 minutes have elapsed since last reconcile and call `reconcileTodayVolume()` if so.

---

**File**: `src/adapters/ExchangeAdapter.ts`

**Changes**: No required changes. The `getTodayVolumeFromAPI()` method is Decibel-specific and will be accessed via duck-typing in `Watcher.ts` to avoid breaking the interface for Sodex/Dango.

---

**File**: `src/ai/sharedState.ts`

**Changes**: No changes needed. `addTodayVolume()` and `todayVolume` remain as-is.

---

**File**: `src/ai/StateStore.ts`

**Changes**: No changes needed. Existing `loadState()` restoration logic is preserved as the initial baseline before API reconciliation.

## Testing Strategy

### Validation Approach

The testing strategy follows a two-phase approach: first, surface counterexamples that demonstrate the bug on unfixed code, then verify the fix works correctly and preserves existing behavior.

### Exploratory Bug Condition Checking

**Goal**: Surface counterexamples that demonstrate the bug BEFORE implementing the fix. Confirm or refute the root cause analysis. If we refute, we will need to re-hypothesize.

**Test Plan**: Write tests that simulate the two failure modes — bot restart (by constructing a fresh `sharedState` with `todayVolume = 0` and a mock adapter that returns trade history) and missed fills (by calling `reconcileTodayVolume` without having called `addTodayVolume`). Run these tests on the UNFIXED code to observe that `todayVolume` remains 0 despite trades existing in the mock API.

**Test Cases**:
1. **Restart Scenario**: Create a mock `DecibelAdapter` with `getTodayVolumeFromAPI` returning `$50,000`. Start with `sharedState.todayVolume = 0`. Assert that without the fix, `todayVolume` stays 0 after startup. (will fail on unfixed code — no reconciliation call exists)
2. **Missed Fill Scenario**: Simulate 3 trades in the mock API totalling `$15,000`. Never call `addTodayVolume`. Assert `todayVolume` is 0 without fix. (will fail on unfixed code)
3. **Periodic Reconciliation Gap**: Advance mock time by 6 minutes. Assert that without the fix, `todayVolume` is not updated from the API. (will fail on unfixed code)
4. **API Error Scenario**: Mock `getTodayVolumeFromAPI` to throw. Assert `todayVolume` is not reset to 0. (may pass on unfixed code since no call is made)

**Expected Counterexamples**:
- `sharedState.todayVolume` remains 0 even when mock API returns trades for today
- Possible causes: no `getTodayVolumeFromAPI` method exists, no reconciliation call in `run()` or `_tick()`

### Fix Checking

**Goal**: Verify that for all inputs where the bug condition holds, the fixed function produces the expected behavior.

**Pseudocode:**
```
FOR ALL X WHERE isBugCondition(X) DO
  result := reconcileTodayVolume_fixed(X)
  ASSERT sharedState.todayVolume = SUM(size * price FOR trade IN API WHERE isToday(trade))
  ASSERT sharedState.todayVolume > 0
END FOR
```

### Preservation Checking

**Goal**: Verify that for all inputs where the bug condition does NOT hold, the fixed function produces the same result as the original function.

**Pseudocode:**
```
FOR ALL X WHERE NOT isBugCondition(X) DO
  ASSERT todayVolume_original(X) = todayVolume_fixed(X)
END FOR
```

**Testing Approach**: Property-based testing is recommended for preservation checking because:
- It generates many test cases automatically across the input domain
- It catches edge cases that manual unit tests might miss
- It provides strong guarantees that behavior is unchanged for all non-buggy inputs

**Test Plan**: Observe behavior on UNFIXED code first for real-time fill accumulation and non-Decibel adapters, then write property-based tests capturing that behavior.

**Test Cases**:
1. **Real-time Fill Preservation**: Verify `addTodayVolume()` still increments `todayVolume` correctly after the fix — reconciliation must not overwrite a higher real-time value with a stale API value
2. **Non-Decibel Adapter Preservation**: Verify that with a Sodex or Dango adapter (no `getTodayVolumeFromAPI` method), `reconcileTodayVolume()` is a no-op and `todayVolume` is unchanged
3. **UTC-Day Reset Preservation**: Verify that when `todayVolumeDate` changes to a new day, `todayVolume` resets to 0 before API reconciliation populates it with the new day's trades
4. **API Error Preservation**: Verify that when `getTodayVolumeFromAPI()` throws, `todayVolume` retains its last known value (not reset to 0)
5. **StateStore Baseline Preservation**: Verify that `loadState()` still restores `todayVolume` from `bot_state.json` as the initial baseline before API reconciliation runs

### Unit Tests

- Test `getTodayVolumeFromAPI()` with mock SDK responses: correct sum, empty response, pagination, trades outside today's UTC window
- Test `reconcileTodayVolume()` with mock adapter: updates `sharedState`, handles missing method (non-Decibel), handles thrown errors
- Test UTC boundary calculation: trades at exactly midnight, trades one ms before midnight, trades spanning day boundary

### Property-Based Tests

- Generate random arrays of trade history items with random `transaction_unix_ms` values; verify only today's trades are summed
- Generate random `todayVolume` values and verify that after reconciliation with a higher API value, `todayVolume` is updated; with a lower API value, behavior is deterministic (API is authoritative)
- Generate random sequences of `addTodayVolume()` calls interleaved with `reconcileTodayVolume()` calls; verify `todayVolume` is always >= the API-reported value

### Integration Tests

- Test full startup flow: `loadState()` → `reconcileTodayVolume()` → first tick; verify `todayVolume` reflects API value
- Test periodic reconciliation: advance mock clock by 5+ minutes, verify `reconcileTodayVolume()` is called again
- Test with non-Decibel adapter: verify no errors and `todayVolume` unchanged
- Test API unavailability: mock network error, verify bot continues running with last known volume
