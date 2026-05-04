# Bugfix Requirements Document

## Introduction

The trading bot's session PnL and fee calculations are producing incorrect values due to four related issues:

1. **Fee Calculation Assumption Error**: The code assumes all exchange APIs return net PnL (after fees), but the Decibel adapter returns gross PnL (price difference only), while SoDEX's behavior is unverified. This causes fees to be added instead of subtracted when the adapter returns gross PnL.

2. **Multi-Bot Balance Contamination**: When multiple bots run on the same exchange account (e.g., `sodex-bot` + `sodex-hedge-bot`), the balance-based PnL calculation (`currentBalance - sessionStartBalance`) includes trades from other bots, making individual bot PnL inaccurate.

3. **Dashboard Balance Display**: The dashboard shows `$N/A` for Start Balance and Current Balance because existing bot instances lack the newly added state fields (`sessionStartBalance`, `currentBalance`).

4. **Dashboard Fee Fallback Rate**: The dashboard fallback logic (line 95 in `manager-dashboard.js`) uses `fee = vol * 0.0003` (0.03%) instead of the correct SoDEX maker fee rate of 0.00012 (0.012%), causing fee estimates to be 2.5× higher than actual.

**Impact**: Users cannot trust displayed PnL values, making it impossible to evaluate bot performance accurately. The discrepancy between displayed PnL and actual balance changes undermines confidence in the system.

**Evidence**: 
- User logs show a SoDEX trade (Entry 0.003 BTC @ 77327, Exit @ 76966) with displayed PnL of -0.5490 but actual balance loss of 1.11 (14.44 → 13.33), suggesting fees are being "doubled" (nhân 2 lên).
- User reports dashboard showing fee of $0.83 for $2,800 volume, but with 0.012% maker fee, the correct fee should be $0.336. The dashboard fallback uses 0.03% rate: $2,800 × 0.0003 = $0.84 ≈ $0.83.

## Bug Analysis

### Current Behavior (Defect)

#### 1. Fee Calculation Logic

1.1 WHEN an exchange adapter returns gross PnL (price difference only, no fee deduction) THEN the system incorrectly adds fees to the gross PnL instead of subtracting them, resulting in inflated gross PnL values

1.2 WHEN calculating net PnL from an adapter that returns gross PnL THEN the system treats the gross PnL as net PnL, causing the final net PnL to be incorrect

1.3 WHEN the Decibel adapter computes `unrealizedPnl` from price difference THEN it returns gross PnL without any fee deduction, but the Watcher module assumes it's net PnL

1.4 WHEN the SoDEX adapter returns `unrealizedPnl` from the API THEN the system does not know whether this value includes fees or not, leading to potential miscalculation

#### 2. Multi-Bot Balance Contamination

1.5 WHEN multiple bots run on the same exchange account (e.g., `sodex-bot` + `sodex-hedge-bot`) THEN the balance-based PnL calculation includes trades from all bots, making individual bot PnL inaccurate

1.6 WHEN a bot calculates session PnL using `currentBalance - sessionStartBalance` THEN it attributes balance changes from other bots' trades to itself

1.7 WHEN users run multiple bots per exchange without warnings THEN they receive misleading PnL metrics without understanding the contamination issue

#### 3. Dashboard Balance Display

1.8 WHEN the dashboard renders bot cards for existing bot instances THEN it displays `$N/A` for Start Balance and Current Balance because these fields are `null` in the state

1.9 WHEN a bot is restarted after the state schema is updated THEN the new fields (`sessionStartBalance`, `currentBalance`) remain `null` until explicitly initialized

#### 4. Dashboard Fee Fallback Estimation

1.10 WHEN the dashboard fallback logic estimates fees (line 95 in `manager-dashboard.js`) THEN it uses `fee = vol * 0.0003` (0.03%) which is 2.5× higher than the actual SoDEX maker fee rate of 0.012%

1.11 WHEN `sessionFees === 0` and the bot has non-zero volume THEN the dashboard displays an inflated fee estimate ($0.84 instead of $0.336 for $2,800 volume)

1.12 WHEN the backend has not yet provided `sessionFees` (e.g., bot just started or no trades completed) THEN the dashboard fallback overestimates fees by 150%

### Expected Behavior (Correct)

#### 1. Fee Calculation Logic

2.1 WHEN an exchange adapter returns gross PnL THEN the system SHALL subtract fees to compute net PnL: `netPnl = grossPnl - feePaid`

2.2 WHEN an exchange adapter returns net PnL THEN the system SHALL add fees to compute gross PnL: `grossPnl = netPnl + feePaid`

2.3 WHEN the Decibel adapter computes `unrealizedPnl` THEN it SHALL document that it returns gross PnL (price difference only) and the Watcher SHALL handle it accordingly

2.4 WHEN the SoDEX adapter returns `unrealizedPnl` from the API THEN the system SHALL verify whether the API includes fees and document the behavior, then handle it correctly in the Watcher

2.5 WHEN calculating fees for a round-trip trade THEN the system SHALL use the formula: `feePaid = positionValue * feeRate * 2` (entry + exit)

#### 2. Multi-Bot Balance Contamination

2.6 WHEN multiple bots are detected running on the same exchange account THEN the system SHALL log a warning explaining that balance-based PnL will be inaccurate

2.7 WHEN a bot initializes and detects other bots on the same exchange THEN it SHALL emit a warning message: "Multiple bots detected on [exchange]. Balance-based PnL may include trades from other bots."

2.8 WHEN users view the dashboard with multiple bots per exchange THEN they SHALL see a visual indicator or tooltip warning about potential PnL contamination

#### 3. Dashboard Balance Display

2.9 WHEN the dashboard renders bot cards THEN it SHALL display Start Balance and Current Balance correctly if the fields are initialized

2.10 WHEN a bot starts and `sessionStartBalance` is `null` THEN it SHALL initialize `sessionStartBalance` to the current account balance

2.11 WHEN a bot updates state during operation THEN it SHALL update `currentBalance` to reflect the latest account balance

2.12 WHEN the dashboard encounters `null` balance fields THEN it SHALL display `$N/A` as a fallback (current behavior is acceptable for uninitialized state)

#### 4. Dashboard Fee Fallback Estimation

2.13 WHEN the dashboard fallback logic estimates fees THEN it SHALL use the correct fee rate: `fee = vol * 0.00012` (0.012% for SoDEX maker)

2.14 WHEN `sessionFees === 0` and the bot has non-zero volume THEN the dashboard SHALL display an accurate fee estimate based on the actual exchange fee rate

2.15 WHEN the backend has not yet provided `sessionFees` THEN the dashboard SHALL use the exchange-specific fee rate from configuration rather than a hardcoded approximation

### Unchanged Behavior (Regression Prevention)

#### 1. Fee Calculation Logic

3.1 WHEN an adapter correctly returns net PnL and the Watcher correctly interprets it THEN the system SHALL CONTINUE TO calculate gross PnL and fees accurately

3.2 WHEN calculating session cumulative stats (`sessionGrossPnl`, `sessionFees`) THEN the system SHALL CONTINUE TO accumulate them correctly across multiple trades

3.3 WHEN logging trade records with `feePaid`, `grossPnl`, and `pnl` (net) THEN the system SHALL CONTINUE TO store all three values for analytics

#### 2. Multi-Bot Balance Contamination

3.4 WHEN a single bot runs on an exchange account THEN the system SHALL CONTINUE TO calculate balance-based PnL accurately

3.5 WHEN the balance-based PnL calculation is used THEN the system SHALL CONTINUE TO update `sessionCurrentPnl` from balance difference in `_tick()`

#### 3. Dashboard Balance Display

3.6 WHEN the dashboard displays other bot metrics (sessionPnl, sessionVolume, todayVolume) THEN it SHALL CONTINUE TO render them correctly

3.7 WHEN the dashboard updates in real-time via SSE THEN it SHALL CONTINUE TO push updates to connected clients

3.8 WHEN bot state is saved and loaded THEN the system SHALL CONTINUE TO persist and restore all state fields correctly

#### 4. Dashboard Fee Fallback Estimation

3.9 WHEN the backend provides `sessionFees` correctly THEN the dashboard SHALL CONTINUE TO display the actual fee value without using fallback estimation

3.10 WHEN the dashboard displays volume and PnL metrics THEN it SHALL CONTINUE TO format them correctly using the `fmtUsd()` helper

## Bug Condition Derivation

### Bug Condition Function

```pascal
FUNCTION isBugCondition(X)
  INPUT: X of type TradeExitContext
  OUTPUT: boolean
  
  // Returns true when the bug condition is met
  // X contains: adapter, pnlFromAdapter, feePaid, isMultiBotEnvironment, balanceFields, dashboardFeeRate
  
  RETURN (X.adapter.returnsPnlType = "GROSS" AND X.feeCalculationAssumesNet = true)
         OR (X.isMultiBotEnvironment = true AND X.usesBalanceBasedPnl = true)
         OR (X.sessionStartBalance = null OR X.currentBalance = null)
         OR (X.dashboardFeeRate = 0.0003 AND X.actualFeeRate = 0.00012)
END FUNCTION
```

### Property Specification: Fix Checking

```pascal
// Property 1: Correct Fee Calculation for Gross PnL Adapters
FOR ALL X WHERE X.adapter.returnsPnlType = "GROSS" DO
  result ← calculateNetPnl'(X.pnlFromAdapter, X.feePaid)
  ASSERT result = X.pnlFromAdapter - X.feePaid
END FOR

// Property 2: Multi-Bot Warning Emission
FOR ALL X WHERE X.isMultiBotEnvironment = true DO
  warnings ← initializeBot'(X.exchangeAccount)
  ASSERT warnings CONTAINS "Multiple bots detected"
END FOR

// Property 3: Balance Field Initialization
FOR ALL X WHERE X.sessionStartBalance = null DO
  state ← startBot'(X.accountBalance)
  ASSERT state.sessionStartBalance = X.accountBalance
  ASSERT state.currentBalance = X.accountBalance
END FOR

// Property 4: Dashboard Fee Rate Accuracy
FOR ALL X WHERE X.sessionFees = 0 AND X.sessionVolume > 0 DO
  displayedFee ← dashboardFallback'(X.sessionVolume, X.actualFeeRate)
  ASSERT displayedFee = X.sessionVolume * X.actualFeeRate
  ASSERT displayedFee ≠ X.sessionVolume * 0.0003
END FOR
```

### Preservation Goal

```pascal
// Property: Preservation Checking
FOR ALL X WHERE NOT isBugCondition(X) DO
  // For adapters that return net PnL correctly
  ASSERT calculateGrossPnl(X) = calculateGrossPnl'(X)
  
  // For single-bot environments
  ASSERT calculateSessionPnl(X) = calculateSessionPnl'(X)
  
  // For initialized balance fields
  ASSERT displayBalance(X) = displayBalance'(X)
END FOR
```

**Key Definitions:**
- **F**: Original (unfixed) code in `Watcher.ts`, adapters, and dashboard
- **F'**: Fixed code with correct fee calculation, multi-bot warnings, and balance initialization

**Counterexamples:**

1. **Fee Calculation**: Decibel adapter returns gross PnL of +10 USDC, fees are 2 USDC. Current code: `grossPnl = 10 + 2 = 12` (wrong). Expected: `netPnl = 10 - 2 = 8`.

2. **Multi-Bot Contamination**: `sodex-bot` starts with balance 100 USDC. `sodex-hedge-bot` makes a trade losing 5 USDC. `sodex-bot` calculates PnL as -5 USDC even though it made no trades.

3. **Balance Display**: Bot state has `sessionStartBalance: null`. Dashboard renders `$N/A` instead of the actual balance value.

4. **Dashboard Fee Fallback**: Bot has volume $2,800 and `sessionFees = 0`. Dashboard calculates: `fee = 2800 * 0.0003 = $0.84` (wrong). Expected: `fee = 2800 * 0.00012 = $0.336`.
