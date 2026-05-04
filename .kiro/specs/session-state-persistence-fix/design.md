# Session State Persistence Fix Design

## Overview

This design addresses the bug where session statistics (sessionFees, sessionGrossPnl, sessionVolume, sessionStartBalance, currentBalance) reset to 0 on bot restart. The fix extends the existing StateStore.ts persistence pattern to include these additional session fields, ensuring they survive bot restarts while maintaining the existing behavior for fresh session starts.

The approach leverages the existing StateStore infrastructure and adds minimal changes to Watcher.ts and BotInstance.ts to persist and restore the missing session fields.

## Glossary

- **Bug_Condition (C)**: The condition that triggers the bug - when a bot restarts (stop/start or crash) and session stats are lost
- **Property (P)**: The desired behavior - session stats should be persisted on stop and restored on start
- **Preservation**: Existing persistence behavior (sessionPnl, sessionVolume, todayVolume, pnlHistory, volumeHistory, eventLog) must remain unchanged
- **StateStore**: The module in `src/ai/StateStore.ts` that persists sharedState to disk (currently saves sessionPnl, sessionVolume, todayVolume, histories, and eventLog)
- **BotSharedState**: The per-bot state interface in `src/bot/BotSharedState.ts` that defines session statistics
- **Watcher**: The main bot loop in `src/modules/Watcher.ts` that tracks session stats in memory
- **resetSession()**: The method in Watcher.ts that initializes session stats - currently resets all to zero/null
- **PersistedState**: The interface in StateStore.ts that defines which fields are saved to disk

## Bug Details

### Bug Condition

The bug manifests when a bot restarts (via stop button, crash, or Docker restart). The Watcher class tracks session statistics in memory (sessionFees, sessionGrossPnl, sessionVolume, sessionStartBalance, currentBalance), but these fields are not persisted to disk by StateStore. When resetSession() is called on bot start, it initializes all session stats to zero/null, discarding any previous session data.

**Formal Specification:**
```
FUNCTION isBugCondition(input)
  INPUT: input of type BotLifecycleEvent
  OUTPUT: boolean
  
  RETURN input.event IN ['bot_stop', 'bot_crash', 'docker_restart']
         AND sessionStatsExistInMemory(input.botInstance)
         AND NOT sessionStatsPersisted(input.botInstance)
END FUNCTION
```

### Examples

- **Example 1**: Bot runs for 2 hours, accumulates sessionFees=$5.20, sessionGrossPnl=$12.50, sessionVolume=$1000. User clicks stop button. Bot restarts. Dashboard shows sessionFees=$0, sessionGrossPnl=$0, sessionVolume=$0 (expected: $5.20, $12.50, $1000).

- **Example 2**: Bot crashes during a trade. Before crash: sessionStartBalance=$500, currentBalance=$512.50. After restart: sessionStartBalance=null, currentBalance=null (expected: $500, $512.50).

- **Example 3**: Multi-bot setup with 3 bots. Bot #2 restarts. Bot #2's session stats reset to 0 while Bot #1 and #3 retain their stats (expected: Bot #2 should also retain stats).

- **Edge case**: User explicitly calls resetSession() to start a fresh session (not a restart). Expected behavior: all session stats should reset to zero/null as currently implemented.

## Expected Behavior

### Preservation Requirements

**Unchanged Behaviors:**
- Existing StateStore persistence of sessionPnl, sessionVolume, todayVolume, pnlHistory, volumeHistory, eventLog must continue to work exactly as before
- The debounced save mechanism (3-second debounce) must remain unchanged
- The todayVolume date-based restoration logic (only restore if same UTC day) must remain unchanged
- Multi-bot mode with BotSharedState must continue to maintain isolated state per bot instance
- Fresh session starts (explicit resetSession() calls) must continue to reset all session metrics to zero/null
- Runtime accumulation of fees, PnL, and volume during active trading must remain unchanged

**Scope:**
All inputs that do NOT involve bot restart (stop/start, crash, Docker restart) should be completely unaffected by this fix. This includes:
- Active trading operations (order placement, fills, exits)
- Real-time session stat updates during bot execution
- Dashboard queries during active bot sessions
- Fresh session initialization (explicit reset, not restart)

## Hypothesized Root Cause

Based on the bug description and code analysis, the most likely issues are:

1. **Incomplete PersistedState Interface**: The PersistedState interface in StateStore.ts only includes sessionPnl and sessionVolume, but not sessionFees, sessionGrossPnl, sessionStartBalance, or currentBalance.

2. **Missing Save Logic**: The saveState() and saveStateSync() functions in StateStore.ts only persist the fields defined in PersistedState, omitting the missing session fields.

3. **Missing Restore Logic**: The loadState() function in StateStore.ts only restores the fields defined in PersistedState, leaving the missing session fields uninitialized.

4. **resetSession() Unconditional Reset**: The resetSession() method in Watcher.ts unconditionally resets all session stats to zero/null without checking if persisted values should be restored (for restart scenarios vs. fresh session scenarios).

## Correctness Properties

Property 1: Bug Condition - Session Stats Persist on Restart

_For any_ bot restart event (stop/start, crash, Docker restart) where session statistics existed before the restart, the fixed system SHALL persist sessionFees, sessionGrossPnl, sessionVolume, sessionStartBalance, and currentBalance to disk on stop, and restore these values from disk on start, preserving the cumulative session data across the restart.

**Validates: Requirements 2.1, 2.2, 2.3, 2.4**

Property 2: Preservation - Existing Persistence Behavior

_For any_ persistence operation that does NOT involve the new session fields (sessionFees, sessionGrossPnl, sessionStartBalance, currentBalance), the fixed system SHALL produce exactly the same behavior as the original system, preserving the existing save/restore logic for sessionPnl, sessionVolume, todayVolume, pnlHistory, volumeHistory, and eventLog.

**Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8**

## Fix Implementation

### Changes Required

Assuming our root cause analysis is correct:

**File**: `src/ai/StateStore.ts`

**Function**: `PersistedState` interface, `loadState()`, `saveState()`, `saveStateSync()`

**Specific Changes**:
1. **Extend PersistedState Interface**: Add sessionFees, sessionGrossPnl, sessionStartBalance, currentBalance fields
   - Add `sessionFees?: number;`
   - Add `sessionGrossPnl?: number;`
   - Add `sessionStartBalance?: number | null;`
   - Add `currentBalance?: number | null;`

2. **Update saveState() and saveStateSync()**: Include new fields in persistence payload
   - Add `sessionFees: sharedState.sessionFees,`
   - Add `sessionGrossPnl: sharedState.sessionGrossPnl,`
   - Add `sessionStartBalance: sharedState.sessionStartBalance,`
   - Add `currentBalance: sharedState.currentBalance,`

3. **Update loadState()**: Restore new fields from persisted state
   - Add `if (typeof saved.sessionFees === 'number') sharedState.sessionFees = saved.sessionFees;`
   - Add `if (typeof saved.sessionGrossPnl === 'number') sharedState.sessionGrossPnl = saved.sessionGrossPnl;`
   - Add `if (saved.sessionStartBalance !== undefined) sharedState.sessionStartBalance = saved.sessionStartBalance;`
   - Add `if (saved.currentBalance !== undefined) sharedState.currentBalance = saved.currentBalance;`

4. **Guard Against Null/Undefined**: Ensure null values for sessionStartBalance and currentBalance are handled correctly (they can legitimately be null before first balance fetch)

**File**: `src/modules/Watcher.ts`

**Function**: `resetSession()`

**Specific Changes**:
1. **Conditional Reset Logic**: Modify resetSession() to check if persisted state should be restored (restart scenario) vs. reset to zero (fresh session scenario)
   - Add a parameter `restoreFromPersistence: boolean = false` to resetSession()
   - If `restoreFromPersistence === true`, skip resetting sessionFees, sessionGrossPnl, sessionVolume, sessionStartBalance, currentBalance (they will be restored by loadState())
   - If `restoreFromPersistence === false`, reset all session stats to zero/null as currently implemented

2. **Alternative Approach (Simpler)**: Instead of modifying resetSession(), add a separate method `restoreSessionFromPersistence()` that is called after loadState() to sync Watcher's in-memory fields with the restored sharedState values
   - This avoids changing resetSession() signature and keeps the logic clearer
   - BotInstance.start() would call loadState() → restoreSessionFromPersistence() → resetSession() (which would skip fields already restored)

**File**: `src/bot/BotInstance.ts`

**Function**: `start()`

**Specific Changes**:
1. **Load State Before Starting Watcher**: Call loadState() before watcher.run() to restore persisted session stats
   - For single-bot mode: call `loadState()` from StateStore
   - For multi-bot mode: implement per-bot state persistence (see Multi-Bot Considerations below)

2. **Sync Watcher State**: After loadState(), sync Watcher's in-memory session fields with the restored BotSharedState values
   - Call `watcher.restoreSessionFromPersistence()` (new method) to copy sessionFees, sessionGrossPnl, sessionVolume, sessionStartBalance, currentBalance from state to Watcher's private fields

3. **Save State on Stop**: Ensure saveStateSync() is called in stop() method to persist session stats before shutdown
   - Already exists for single-bot mode (saveState() is called in _onExitFilled)
   - For multi-bot mode, add explicit saveStateSync() call in BotInstance.stop()

### Multi-Bot Considerations

The current StateStore.ts is designed for single-bot mode (saves to a single file). For multi-bot mode:

**Option A (Recommended)**: Extend StateStore to support per-bot persistence
- Add a `botId` parameter to loadState(), saveState(), saveStateSync()
- Save to `./bot_state_${botId}.json` instead of `./bot_state.json`
- BotInstance passes `this.id` to StateStore methods

**Option B (Alternative)**: Implement BotStateStore as a separate module
- Create `src/bot/BotStateStore.ts` that mirrors StateStore.ts but operates on BotSharedState
- BotInstance uses BotStateStore instead of StateStore
- Keeps single-bot and multi-bot persistence logic separate

**Chosen Approach**: Option A (extend StateStore with botId parameter) for consistency and minimal code duplication.

## Testing Strategy

### Validation Approach

The testing strategy follows a two-phase approach: first, surface counterexamples that demonstrate the bug on unfixed code, then verify the fix works correctly and preserves existing behavior.

### Exploratory Bug Condition Checking

**Goal**: Surface counterexamples that demonstrate the bug BEFORE implementing the fix. Confirm or refute the root cause analysis. If we refute, we will need to re-hypothesize.

**Test Plan**: Write tests that simulate bot restart scenarios (stop/start, crash) and assert that session stats are lost. Run these tests on the UNFIXED code to observe failures and understand the root cause.

**Test Cases**:
1. **Single-Bot Restart Test**: Start bot, accumulate session stats, stop bot, restart bot, assert session stats are 0 (will fail on unfixed code - confirms bug)
2. **Multi-Bot Restart Test**: Start 3 bots, accumulate stats on bot #2, restart bot #2, assert bot #2 stats are 0 while bot #1 and #3 retain stats (will fail on unfixed code)
3. **Crash Recovery Test**: Start bot, accumulate stats, simulate crash (kill process), restart bot, assert stats are 0 (will fail on unfixed code)
4. **Fresh Session Test**: Start bot, call resetSession() explicitly, assert all stats are 0 (should pass on unfixed code - this is correct behavior)

**Expected Counterexamples**:
- Session stats (sessionFees, sessionGrossPnl, sessionVolume, sessionStartBalance, currentBalance) are reset to 0/null on restart
- Possible causes: PersistedState interface missing fields, loadState() not restoring fields, resetSession() unconditionally resetting fields

### Fix Checking

**Goal**: Verify that for all inputs where the bug condition holds, the fixed function produces the expected behavior.

**Pseudocode:**
```
FOR ALL input WHERE isBugCondition(input) DO
  result := restartBot_fixed(input)
  ASSERT sessionStatsPreserved(result)
END FOR
```

**Test Plan**: After implementing the fix, run the same restart scenarios and assert that session stats are correctly restored from persistence.

**Test Cases**:
1. **Single-Bot Restart Preservation**: Start bot, accumulate sessionFees=$5, sessionGrossPnl=$10, sessionVolume=$1000, stop bot, restart bot, assert sessionFees=$5, sessionGrossPnl=$10, sessionVolume=$1000
2. **Multi-Bot Restart Preservation**: Start 3 bots, accumulate stats on bot #2, restart bot #2, assert bot #2 stats are restored correctly
3. **Balance Preservation**: Start bot, sessionStartBalance=$500, currentBalance=$512, restart bot, assert sessionStartBalance=$500, currentBalance=$512
4. **Null Balance Handling**: Start bot before first balance fetch (sessionStartBalance=null, currentBalance=null), restart bot, assert null values are preserved

### Preservation Checking

**Goal**: Verify that for all inputs where the bug condition does NOT hold, the fixed function produces the same result as the original function.

**Pseudocode:**
```
FOR ALL input WHERE NOT isBugCondition(input) DO
  ASSERT originalBehavior(input) = fixedBehavior(input)
END FOR
```

**Testing Approach**: Property-based testing is recommended for preservation checking because:
- It generates many test cases automatically across the input domain
- It catches edge cases that manual unit tests might miss
- It provides strong guarantees that behavior is unchanged for all non-buggy inputs

**Test Plan**: Observe behavior on UNFIXED code first for non-restart scenarios, then write property-based tests capturing that behavior.

**Test Cases**:
1. **Runtime Accumulation Preservation**: Observe that sessionFees, sessionGrossPnl, sessionVolume accumulate correctly during active trading on unfixed code, then write test to verify this continues after fix
2. **Existing Persistence Preservation**: Observe that sessionPnl, sessionVolume, todayVolume, pnlHistory, volumeHistory, eventLog are persisted correctly on unfixed code, then write test to verify this continues after fix
3. **Fresh Session Reset Preservation**: Observe that explicit resetSession() calls reset all stats to 0/null on unfixed code, then write test to verify this continues after fix (resetSession() should only restore from persistence on restart, not on explicit reset)
4. **Multi-Bot Isolation Preservation**: Observe that each bot maintains isolated state on unfixed code, then write test to verify this continues after fix

### Unit Tests

- Test StateStore.loadState() restores all session fields correctly
- Test StateStore.saveState() persists all session fields correctly
- Test Watcher.resetSession() with restoreFromPersistence flag (or restoreSessionFromPersistence() method)
- Test BotInstance.start() calls loadState() and syncs Watcher state
- Test BotInstance.stop() calls saveStateSync()
- Test null/undefined handling for sessionStartBalance and currentBalance

### Property-Based Tests

- Generate random session stat values and verify they are persisted and restored correctly across restarts
- Generate random bot configurations (single-bot, multi-bot) and verify state isolation is preserved
- Generate random sequences of trades and restarts, verify cumulative session stats are correct
- Test that all non-restart operations (active trading, dashboard queries) produce identical results before and after fix

### Integration Tests

- Test full bot lifecycle: start → trade → accumulate stats → stop → restart → verify stats restored
- Test multi-bot scenario: start 3 bots → trade on all → restart bot #2 → verify bot #2 stats restored, bot #1 and #3 unaffected
- Test crash recovery: start bot → trade → kill process → restart → verify stats restored
- Test fresh session: start bot → trade → explicit resetSession() → verify stats reset to 0/null
