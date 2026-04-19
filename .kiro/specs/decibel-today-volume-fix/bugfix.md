# Bugfix Requirements Document

## Introduction

The Decibel bot dashboard displays "Today Volume (UTC): $0.00" even when the bot has been actively trading and accumulating volume throughout the day. The root cause is that `todayVolume` in `sharedState` is maintained purely in-memory via `addTodayVolume()` calls triggered by fill events in `Watcher.ts`. This approach has two failure modes: (1) a bot restart mid-day wipes all accumulated volume since the persisted value in `bot_state.json` is only restored if the bot restarts on the same UTC day AND the state was saved before the restart, and (2) missed fill events (due to polling gaps or WebSocket errors) mean `addTodayVolume` is never called for those trades. The Decibel SDK provides `read.userTradeHistory.getByAddr()` which is the authoritative source of truth for actual executed trades but is never consulted for volume calculation.

## Bug Analysis

### Current Behavior (Defect)

1.1 WHEN the bot restarts mid-UTC-day after having accumulated trades THEN the system resets `todayVolume` to 0 (or restores a stale persisted value), losing all volume accumulated before the restart

1.2 WHEN a fill event is missed due to a WebSocket error or polling gap THEN the system never calls `addTodayVolume()` for that trade, causing the displayed volume to be lower than actual traded volume

1.3 WHEN the dashboard `/api/pnl` endpoint is called THEN the system returns `todayVolume` from in-memory `sharedState` without reconciling against the Decibel trade history API, potentially returning $0.00 even when trades have occurred

### Expected Behavior (Correct)

2.1 WHEN the bot restarts mid-UTC-day THEN the system SHALL query `read.userTradeHistory.getByAddr()` and compute `todayVolume` as the sum of `size * price` for all trades where `transaction_unix_ms` falls within the current UTC day (00:00:00 UTC to 23:59:59 UTC)

2.2 WHEN fill events are missed due to WebSocket errors or polling gaps THEN the system SHALL reconcile `todayVolume` against the Decibel trade history API so that all executed trades within the current UTC day are counted regardless of whether their fill events were observed

2.3 WHEN the dashboard `/api/pnl` endpoint is called THEN the system SHALL return a `todayVolume` value that reflects the actual sum of `size * price` for all Decibel trades executed within the current UTC day, as reported by the trade history API

### Unchanged Behavior (Regression Prevention)

3.1 WHEN the bot is running and a fill event is observed via `_onEntryFilled()` or `_onExitFilled()` THEN the system SHALL CONTINUE TO update `sessionVolume` and `sharedState` in real-time as it does today

3.2 WHEN `todayVolumeDate` changes to a new UTC day THEN the system SHALL CONTINUE TO reset `todayVolume` to 0 before accumulating the new day's trades

3.3 WHEN the bot is used with a non-Decibel exchange adapter (e.g. Sodex, Dango) THEN the system SHALL CONTINUE TO function normally without attempting to call Decibel-specific trade history APIs

3.4 WHEN `bot_state.json` is loaded on startup and the saved `todayVolumeDate` matches the current UTC day THEN the system SHALL CONTINUE TO restore the persisted `todayVolume` as a baseline before applying any API reconciliation

3.5 WHEN the Decibel trade history API is unavailable or returns an error THEN the system SHALL CONTINUE TO display the last known `todayVolume` value without crashing or resetting it to 0

---

## Bug Condition Pseudocode

**Bug Condition Function** — identifies inputs that trigger the incorrect $0.00 display:

```pascal
FUNCTION isBugCondition(X)
  INPUT: X of type { botRestartedMidDay: boolean, fillsMissed: boolean, tradesExistInAPI: boolean }
  OUTPUT: boolean

  // Bug triggers when trades exist in the Decibel API for today
  // but todayVolume in sharedState does not reflect them
  RETURN X.tradesExistInAPI AND (X.botRestartedMidDay OR X.fillsMissed)
END FUNCTION
```

**Property: Fix Checking**
```pascal
FOR ALL X WHERE isBugCondition(X) DO
  result ← getTodayVolume'(X)  // after fix
  ASSERT result = SUM(size * price FOR trade IN decibelAPI WHERE isToday(trade.transaction_unix_ms))
  ASSERT result > 0
END FOR
```

**Property: Preservation Checking**
```pascal
FOR ALL X WHERE NOT isBugCondition(X) DO
  // Normal operation: no restart, no missed fills, no Decibel adapter
  ASSERT getTodayVolume(X) = getTodayVolume'(X)
END FOR
```
