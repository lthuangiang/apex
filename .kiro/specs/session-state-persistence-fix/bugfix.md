# Bugfix Requirements Document

## Introduction

This bugfix addresses the issue where session statistics (sessionFees, sessionGrossPnl, sessionVolume, sessionStartBalance, currentBalance) reset to 0 when the bot restarts. Currently, these in-memory session stats are lost on bot stop/restart, causing the dashboard to show incorrect cumulative session data. The fix will persist these stats to storage on bot stop and restore them on bot start, ensuring session continuity across restarts.

## Bug Analysis

### Current Behavior (Defect)

1.1 WHEN the bot stops (via stop button or crash) THEN the system loses all in-memory session statistics (sessionFees, sessionGrossPnl, sessionVolume, sessionStartBalance, currentBalance)

1.2 WHEN the bot restarts after being stopped THEN the system resets sessionFees to 0, sessionGrossPnl to 0, sessionVolume to 0, sessionStartBalance to null, and currentBalance to null

1.3 WHEN resetSession() is called on bot start THEN the system initializes all session stats to their default zero/null values, discarding any previous session data

1.4 WHEN the dashboard queries session statistics after a bot restart THEN the system displays incorrect cumulative values (all zeros) instead of the actual session totals

### Expected Behavior (Correct)

2.1 WHEN the bot stops (via stop button or crash) THEN the system SHALL save all session statistics (sessionFees, sessionGrossPnl, sessionVolume, sessionStartBalance, currentBalance) to persistent storage

2.2 WHEN the bot starts after being stopped THEN the system SHALL restore session statistics (sessionFees, sessionGrossPnl, sessionVolume, sessionStartBalance, currentBalance) from persistent storage

2.3 WHEN resetSession() is called on bot start THEN the system SHALL restore persisted session stats instead of resetting them to zero/null values

2.4 WHEN the dashboard queries session statistics after a bot restart THEN the system SHALL display the correct cumulative session values that were persisted before the restart

### Unchanged Behavior (Regression Prevention)

3.1 WHEN a trade is executed and fees are calculated THEN the system SHALL CONTINUE TO accumulate fees correctly in sessionFees during runtime

3.2 WHEN sessionPnl is updated from balance differences THEN the system SHALL CONTINUE TO calculate session PnL correctly during runtime

3.3 WHEN sessionVolume is updated after fills THEN the system SHALL CONTINUE TO accumulate trade volume correctly during runtime

3.4 WHEN the existing StateStore saves sessionPnl and sessionVolume THEN the system SHALL CONTINUE TO persist those fields as it currently does

3.5 WHEN todayVolume is reconciled from the API THEN the system SHALL CONTINUE TO restore todayVolume only if it's the same UTC day

3.6 WHEN pnlHistory, volumeHistory, and eventLog are persisted THEN the system SHALL CONTINUE TO save and restore these arrays correctly

3.7 WHEN a bot is in multi-bot mode with BotSharedState THEN the system SHALL CONTINUE TO maintain isolated state per bot instance

3.8 WHEN resetSession() is called to start a fresh session (not a restart) THEN the system SHALL CONTINUE TO reset all session metrics to zero/null as expected
