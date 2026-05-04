# Session PnL Calculation Fix - Bugfix Design

## Overview

The session PnL calculation is currently incorrect because it uses a balance-based approach (`balance - sessionStartBalance`) which includes unrealized PnL fluctuations from open positions. This makes it impossible to track actual realized trading performance, especially in multi-bot environments where multiple bots share the same exchange account.

**Root Cause:** The bug occurs because `adapter.get_balance()` returns `perp_equity_balance`, which includes unrealized PnL from all open positions across all bots on the same exchange. When multiple bots (e.g., sodex-bot + sodex-hedge-bot) run on the same exchange, each bot's session PnL calculation includes trades from OTHER bots, causing incorrect PnL tracking.

**Fix Strategy:** Change from balance-based calculation to trade-based accumulation. Track only realized PnL from trades that are opened AND closed during the current session, accumulated at trade close time.

## Glossary

- **Bug_Condition (C)**: The condition that triggers the bug - when session PnL is calculated using balance difference instead of trade accumulation
- **Property (P)**: The desired behavior - session PnL should reflect only realized PnL from closed trades, not unrealized PnL fluctuations
- **Preservation**: Existing trade logging, volume tracking, and fee tracking that must remain unchanged by the fix
- **sessionStartBalance**: The account balance when the bot session starts (currently used for PnL calculation, will be removed)
- **sessionCurrentPnl**: The current session PnL value (currently calculated as `balance - sessionStartBalance`, will be changed to accumulated realized PnL)
- **sessionGrossPnl**: Cumulative gross PnL before fees (already correctly tracked in Watcher.ts)
- **sessionFees**: Cumulative fees paid (already correctly tracked in Watcher.ts)
- **Watcher.ts**: The main bot loop for BotInstance (single-symbol trading bot)
- **HedgeBot.ts**: The correlation hedging bot that trades two symbols simultaneously
- **_onExitFilled()**: Method in Watcher.ts that handles exit order fills and logs trades
- **_completeClose()**: Method in HedgeBot.ts that finalizes hedge position closes and logs trades

## Bug Details

### Bug Condition

The bug manifests when a bot session is running and the session PnL is calculated using the balance-based approach. This occurs in two locations:

1. **Watcher.ts (_tick method)**: `this.sessionCurrentPnl = balance - this.sessionStartBalance`
2. **HedgeBot.ts (_completeClose method)**: `this.state.sessionPnl += pair.combinedPnl`

The bug is particularly severe in multi-bot environments where multiple bots share the same exchange account, because `adapter.get_balance()` returns the TOTAL account balance including unrealized PnL from ALL bots.

**Formal Specification:**
```
FUNCTION isBugCondition(input)
  INPUT: input of type { sessionStartBalance: number | null, balance: number, openPositions: Position[] }
  OUTPUT: boolean
  
  RETURN input.sessionStartBalance !== null
         AND input.balance includes unrealized PnL from input.openPositions
         AND sessionPnl is calculated as (input.balance - input.sessionStartBalance)
END FUNCTION
```

### Examples

**Example 1: Single bot with open position**
- Session starts: balance = $33, no open positions → sessionStartBalance = $33
- Bot opens long position → unrealized PnL = +$5 → balance = $38
- Session PnL = $38 - $33 = +$5 (WRONG: this is unrealized PnL, not realized)
- Position's unrealized PnL drops to +$2 → balance = $35
- Session PnL = $35 - $33 = +$2 (WRONG: fluctuates with mark price)
- Position closes at -$1 realized PnL → balance = $32
- Session PnL = $32 - $33 = -$1 (CORRECT by accident, but only because position closed)

**Example 2: Multi-bot environment (CRITICAL)**
- SoDEX exchange has TWO bots: sodex-bot + sodex-hedge-bot
- Session starts: sodex-bot balance = $100, sodex-hedge-bot balance = $100 (SAME account!)
- sodex-bot opens position → unrealized PnL = +$10 → account balance = $110
- sodex-hedge-bot calls `adapter.get_balance()` → returns $110 (includes sodex-bot's unrealized PnL!)
- sodex-hedge-bot session PnL = $110 - $100 = +$10 (WRONG: includes OTHER bot's unrealized PnL)
- sodex-bot closes position at +$5 realized → account balance = $105
- sodex-hedge-bot session PnL = $105 - $100 = +$5 (WRONG: includes OTHER bot's realized PnL)

**Example 3: Edge case - restart with open position**
- Bot restarts with open position (unrealized PnL = +$3)
- sessionStartBalance = $38 (includes unrealized PnL from pre-restart position)
- Position closes at +$3 realized → balance = $38 (unchanged)
- Session PnL = $38 - $38 = $0 (WRONG: should be +$3 if position was opened during session, or $0 if opened before session)

**Example 4: Expected behavior after fix**
- Session starts: sessionPnl = 0
- Bot opens position → unrealized PnL = +$5 → sessionPnl = 0 (CORRECT: unchanged)
- Position's unrealized PnL drops to +$2 → sessionPnl = 0 (CORRECT: unchanged)
- Position closes at -$1 realized PnL → sessionPnl = -$1 (CORRECT: accumulated at close time)
- Bot opens another position → unrealized PnL = +$3 → sessionPnl = -$1 (CORRECT: unchanged)
- Position closes at +$2 realized PnL → sessionPnl = +$1 (CORRECT: -$1 + $2 = +$1)

## Expected Behavior

### Preservation Requirements

**Unchanged Behaviors:**
- Trade logging via TradeLogger must continue to record individual trade PnL correctly
- Session volume tracking must continue to accumulate trade volumes correctly
- Session fees tracking must continue to accumulate fees correctly
- Bot restart via `resetSession()` must continue to reset session metrics correctly
- Dashboard queries for session statistics must continue to return correct values
- Emergency max-loss stop must continue to use the correct session PnL for comparison

**Scope:**
All inputs that do NOT involve session PnL calculation should be completely unaffected by this fix. This includes:
- Individual trade PnL calculations (entry price, exit price, fees)
- Position management (opening, holding, closing positions)
- Signal evaluation and order placement logic
- Risk management (stop-loss, take-profit)

## Hypothesized Root Cause

Based on the bug description and code analysis, the root cause is:

1. **Balance-Based Calculation**: The current implementation calculates session PnL as `balance - sessionStartBalance`, where `balance` comes from `adapter.get_balance()` which returns `perp_equity_balance`. This equity balance includes unrealized PnL from open positions.

2. **Multi-Bot Shared Account**: In multi-bot environments, `adapter.get_balance()` returns the TOTAL account balance for the exchange, not per-bot balance. This means each bot's session PnL calculation includes unrealized and realized PnL from OTHER bots on the same exchange.

3. **Tick-Level Balance Tracking**: The balance is queried every tick and used to update `sessionCurrentPnl`, causing it to fluctuate with mark price changes rather than tracking only realized PnL from closed trades.

4. **Incorrect Initialization**: `sessionStartBalance` is set to the current balance at session start, which may include unrealized PnL from positions opened before the session started (e.g., after a bot restart).

## Correctness Properties

Property 1: Bug Condition - Session PnL Excludes Unrealized PnL

_For any_ bot session where positions are opened and held with unrealized PnL, the fixed session PnL calculation SHALL remain unchanged (not fluctuate with mark price changes) until the position is closed and realized PnL is accumulated.

**Validates: Requirements 2.1, 2.2, 2.3**

Property 2: Preservation - Trade Logging and Volume Tracking

_For any_ trade that is closed during the session, the fixed code SHALL produce exactly the same trade log records, session volume accumulation, and session fees accumulation as the original code, preserving all existing trade tracking functionality.

**Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5**

## Fix Implementation

### Changes Required

The fix requires changes in two files: `src/modules/Watcher.ts` and `src/bot/HedgeBot.ts`.

**File**: `src/modules/Watcher.ts`

**Function**: `_tick()` and `_onExitFilled()`

**Specific Changes**:

1. **Remove balance-based calculation in _tick()**:
   - **Current code** (line ~290):
     ```typescript
     if (this.sessionStartBalance === null) this.sessionStartBalance = balance;
     this.sessionCurrentPnl = balance - this.sessionStartBalance;
     ```
   - **Fixed code**:
     ```typescript
     // sessionStartBalance no longer needed for PnL calculation
     // sessionCurrentPnl is now accumulated at trade close time in _onExitFilled()
     // Keep balance query for other purposes (emergency stop, position sizing)
     ```

2. **Initialize sessionCurrentPnl to 0 in constructor**:
   - **Current code** (line ~150):
     ```typescript
     private sessionCurrentPnl = 0;
     ```
   - **Fixed code** (no change needed - already initialized to 0)

3. **Accumulate realized PnL in _onExitFilled()**:
   - **Current code** (line ~850):
     ```typescript
     // Update session cumulative stats
     this.sessionGrossPnl += grossPnl;
     this.sessionFees += feePaid;
     ```
   - **Fixed code**:
     ```typescript
     // Update session cumulative stats
     this.sessionGrossPnl += grossPnl;
     this.sessionFees += feePaid;
     this.sessionCurrentPnl += pnlNet; // Accumulate realized PnL (net of fees)
     ```

4. **Remove sessionStartBalance from resetSession()**:
   - **Current code** (line ~1380):
     ```typescript
     resetSession() {
         this.sessionStartBalance = null;
         this.sessionCurrentPnl = 0;
         // ... other resets
     }
     ```
   - **Fixed code**:
     ```typescript
     resetSession() {
         // sessionStartBalance removed - no longer needed
         this.sessionCurrentPnl = 0;
         // ... other resets
     }
     ```

5. **Remove sessionStartBalance field declaration**:
   - **Current code** (line ~150):
     ```typescript
     private sessionStartBalance: number | null = null;
     ```
   - **Fixed code**:
     ```typescript
     // Field removed - no longer needed
     ```

**File**: `src/bot/HedgeBot.ts`

**Function**: `_completeClose()`

**Specific Changes**:

1. **Accumulate realized PnL in _completeClose()**:
   - **Current code** (line ~1050):
     ```typescript
     // Requirement 9.4: update sessionPnl and sessionVolume
     this.state.sessionPnl += pair.combinedPnl;
     this.state.sessionVolume += this.config.legValueUsd * 2; // both legs
     ```
   - **Fixed code** (no change needed - already accumulates realized PnL correctly)
   - **Note**: HedgeBot already uses the correct approach! It accumulates `pair.combinedPnl` (realized PnL from closed hedge position) rather than using balance difference.

2. **Remove balance tracking from _tickInPair() if present**:
   - **Current code** (line ~750):
     ```typescript
     // Requirement 10.4: track available balance once per tick
     try {
       await this.adapter.get_balance();
     } catch (err) {
       console.warn(`[HedgeBot:${this.id}] get_balance failed:`, err);
     }
     ```
   - **Fixed code** (no change needed - this is just for tracking, not used for PnL calculation)

### Summary of Changes

**Watcher.ts**:
- Remove `sessionStartBalance` field declaration
- Remove balance-based PnL calculation in `_tick()` method
- Add realized PnL accumulation in `_onExitFilled()` method: `this.sessionCurrentPnl += pnlNet`
- Remove `sessionStartBalance` from `resetSession()` method

**HedgeBot.ts**:
- No changes needed - already uses correct trade-based accumulation approach

**Key Insight**: The fix is simpler than expected because `sessionGrossPnl` and `sessionFees` are already correctly tracked via trade accumulation in Watcher.ts. We just need to apply the same pattern to `sessionCurrentPnl`.

## Testing Strategy

### Validation Approach

The testing strategy follows a two-phase approach: first, surface counterexamples that demonstrate the bug on unfixed code, then verify the fix works correctly and preserves existing behavior.

### Exploratory Bug Condition Checking

**Goal**: Surface counterexamples that demonstrate the bug BEFORE implementing the fix. Confirm or refute the root cause analysis. If we refute, we will need to re-hypothesize.

**Test Plan**: Write tests that simulate a bot session with open positions and verify that session PnL fluctuates with unrealized PnL changes. Run these tests on the UNFIXED code to observe failures and understand the root cause.

**Test Cases**:
1. **Single Position Unrealized PnL Test**: Open a position, verify session PnL changes with unrealized PnL fluctuations (will fail on unfixed code - session PnL should NOT change)
2. **Multi-Bot Shared Account Test**: Run two bots on the same exchange, verify that one bot's session PnL includes the other bot's trades (will fail on unfixed code - session PnL should be isolated per bot)
3. **Restart With Open Position Test**: Restart a bot with an open position, verify session PnL calculation is correct (will fail on unfixed code - sessionStartBalance includes unrealized PnL)
4. **Multiple Trades Test**: Open and close multiple positions, verify session PnL accumulates correctly (may pass on unfixed code if no positions are held at end)

**Expected Counterexamples**:
- Session PnL fluctuates with mark price changes while position is open
- Session PnL includes unrealized PnL from other bots on the same exchange
- Session PnL is incorrect after bot restart with open position

### Fix Checking

**Goal**: Verify that for all inputs where the bug condition holds, the fixed function produces the expected behavior.

**Pseudocode:**
```
FOR ALL input WHERE isBugCondition(input) DO
  result := calculateSessionPnl_fixed(input)
  ASSERT expectedBehavior(result)
END FOR
```

**Expected Behavior:**
- Session PnL remains 0 when positions are opened (not yet closed)
- Session PnL remains unchanged when unrealized PnL fluctuates
- Session PnL increases/decreases only when trades are closed
- Session PnL is isolated per bot (not affected by other bots on same exchange)

### Preservation Checking

**Goal**: Verify that for all inputs where the bug condition does NOT hold, the fixed function produces the same result as the original function.

**Pseudocode:**
```
FOR ALL input WHERE NOT isBugCondition(input) DO
  ASSERT originalFunction(input) = fixedFunction(input)
END FOR
```

**Testing Approach**: Property-based testing is recommended for preservation checking because:
- It generates many test cases automatically across the input domain
- It catches edge cases that manual unit tests might miss
- It provides strong guarantees that behavior is unchanged for all non-buggy inputs

**Test Plan**: Observe behavior on UNFIXED code first for trade logging, volume tracking, and fee tracking, then write property-based tests capturing that behavior.

**Test Cases**:
1. **Trade Logging Preservation**: Verify that trade log records are identical before and after fix
2. **Volume Tracking Preservation**: Verify that session volume accumulation is identical before and after fix
3. **Fee Tracking Preservation**: Verify that session fees accumulation is identical before and after fix
4. **Reset Session Preservation**: Verify that `resetSession()` behavior is identical before and after fix
5. **Dashboard Query Preservation**: Verify that dashboard queries return correct values before and after fix

### Unit Tests

- Test session PnL calculation with single position (open, hold, close)
- Test session PnL calculation with multiple positions (open, close, open, close)
- Test session PnL isolation in multi-bot environment (mock two bots on same exchange)
- Test session PnL after bot restart with open position
- Test edge cases (dust positions, partial fills, cancelled orders)

### Property-Based Tests

- Generate random sequences of trades (open, hold, close) and verify session PnL equals sum of realized PnL
- Generate random mark price fluctuations and verify session PnL remains unchanged while positions are open
- Generate random multi-bot scenarios and verify session PnL is isolated per bot
- Test that session PnL never includes unrealized PnL from open positions

### Integration Tests

- Test full bot lifecycle with session PnL tracking (start, trade, stop, restart)
- Test multi-bot environment with shared exchange account
- Test dashboard display of session PnL during active trading
- Test emergency max-loss stop using session PnL threshold
