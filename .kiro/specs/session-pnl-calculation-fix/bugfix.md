# Bugfix Requirements Document

## Introduction

Session PnL calculation is currently incorrect because it includes unrealized PnL fluctuations from open positions, not just realized PnL from closed trades. The user reported that when a position is opened during the session, the session PnL fluctuates with the position's unrealized PnL changes, making it impossible to track the actual realized trading performance.

**Example scenario:**
- Session starts with balance = $33 (no open positions)
- User opens a position → unrealized PnL = +$5 → balance becomes $38
- Position's unrealized PnL decreases to +$2 → balance becomes $35
- Session PnL = $35 - $33 = +$2 (but this is just unrealized PnL, not realized profit)
- If position closes at a loss → balance drops → session PnL shows exaggerated loss

The root cause is that the current implementation calculates session PnL as `balance - sessionStartBalance`, where `balance` comes from `adapter.get_balance()` which returns `perp_equity_balance`. This equity balance **includes unrealized PnL from open positions**, causing session PnL to fluctuate with mark price changes rather than tracking only realized PnL from closed trades.

**What session PnL should track:** Only the realized PnL from trades that were opened AND closed during the session (net of fees).

**What it currently tracks:** All balance changes including unrealized PnL fluctuations from open positions.

## Bug Analysis

### Current Behavior (Defect)

1.1 WHEN a bot session starts with no open positions THEN the system sets `sessionStartBalance` to the current account balance (e.g., $33)

1.2 WHEN a position is opened during the session with unrealized PnL THEN the account balance includes that unrealized PnL (e.g., balance becomes $38 with +$5 unrealized PnL)

1.3 WHEN the position's unrealized PnL fluctuates THEN the session PnL calculation `balance - sessionStartBalance` fluctuates accordingly (e.g., unrealized PnL drops to +$2 → balance = $35 → session PnL = +$2)

1.4 WHEN the dashboard displays session PnL THEN it shows unrealized PnL fluctuations from open positions instead of only realized PnL from closed trades

1.5 WHEN a position opened during the session closes at a loss THEN the session PnL shows an exaggerated loss because it includes all the unrealized PnL fluctuations that occurred while the position was open

### Expected Behavior (Correct)

2.1 WHEN a bot session starts THEN the system SHALL initialize `sessionPnl` to 0 and track it independently from account balance and unrealized PnL

2.2 WHEN a position is opened during the session THEN the system SHALL NOT include its unrealized PnL in the session PnL calculation

2.3 WHEN a position's unrealized PnL fluctuates THEN the session PnL SHALL remain unchanged (not affected by mark price changes)

2.4 WHEN a trade is closed during the session THEN the system SHALL add ONLY the trade's realized PnL to `sessionPnl` (net PnL after fees)

2.5 WHEN the dashboard displays session PnL THEN it SHALL show only the cumulative realized PnL from trades that were opened AND closed during the current session

### Unchanged Behavior (Regression Prevention)

3.1 WHEN trades are logged to the trade logger THEN the system SHALL CONTINUE TO record individual trade PnL correctly

3.2 WHEN the session volume is calculated THEN the system SHALL CONTINUE TO accumulate trade volumes correctly

3.3 WHEN session fees are tracked THEN the system SHALL CONTINUE TO accumulate fees correctly

3.4 WHEN the bot is stopped and restarted THEN the system SHALL CONTINUE TO reset session metrics correctly via `resetSession()`

3.5 WHEN the dashboard queries session statistics THEN the system SHALL CONTINUE TO return `sessionVolume`, `sessionFees`, and `sessionGrossPnl` correctly

3.6 WHEN emergency max-loss stop is triggered THEN the system SHALL CONTINUE TO use the correct session PnL for comparison
