# Bugfix Requirements Document

## Introduction

When HedgeBot places entry orders for a hedge pair (e.g. BTC long + ETH short), one leg may be
rejected by the exchange while the other is placed successfully and subsequently fills. In this
scenario the bot correctly re-places the rejected leg in `_tickWaitingFill` (Case 1). However,
if the fill timeout later expires while the re-placed order is still pending, the bot cancels
the pending order and transitions back to `OPENING`. On the next `OPENING` tick it places **both**
legs again — without first checking whether one leg already has an open position from the earlier
fill. The result is that the already-filled leg accumulates a second position, doubling its
intended size (e.g. ETH ends up at 2× the configured `legValueUsd`).

The fix must ensure that before placing any entry order in `OPENING`, the bot checks for existing
open positions and skips placing a new order for any leg that is already filled.

---

## Bug Analysis

### Current Behavior (Defect)

1.1 WHEN leg A order is rejected and leg B order fills during `WAITING_FILL`, AND the fill timeout
    subsequently expires while the re-placed leg A order is still pending, THEN the system
    transitions back to `OPENING` and places a new order for **both** leg A and leg B, ignoring
    the existing leg B position.

1.2 WHEN `OPENING` places orders for both legs without checking existing positions, THEN the
    system creates a second position for the already-filled leg, resulting in double the intended
    size (2× `legValueUsd`).

1.3 WHEN the double-sized position is later closed, THEN the system closes more notional than
    intended, exposing the bot to unintended risk and incorrect PnL accounting.

### Expected Behavior (Correct)

2.1 WHEN the bot enters `OPENING` state (whether for the first time or after a timeout retry),
    THEN the system SHALL query current open positions for both symbols before placing any orders.

2.2 WHEN an existing open position is detected for a leg during `OPENING`, THEN the system SHALL
    skip placing a new order for that leg and only place orders for legs that are not yet filled.

2.3 WHEN all legs already have open positions at the start of an `OPENING` tick, THEN the system
    SHALL transition directly to `WAITING_FILL` (or `IN_PAIR` if both are confirmed filled)
    without placing any new orders.

2.4 WHEN leg A is already filled and leg B has no position and no pending order during
    `WAITING_FILL` Case 1, THEN the system SHALL re-place only leg B, which is the current
    behavior and SHALL be preserved.

### Unchanged Behavior (Regression Prevention)

3.1 WHEN both legs have no existing positions and no pending orders at the start of `OPENING`,
    THEN the system SHALL CONTINUE TO place limit orders for both legs as normal.

3.2 WHEN both legs fill successfully during `WAITING_FILL`, THEN the system SHALL CONTINUE TO
    transition to `IN_PAIR` with the correct position sizes.

3.3 WHEN stale open orders are detected at the start of `OPENING`, THEN the system SHALL
    CONTINUE TO cancel them before placing fresh orders.

3.4 WHEN the fill timeout expires and both legs are still pending (no fills), THEN the system
    SHALL CONTINUE TO cancel both pending orders and retry from `OPENING`.

3.5 WHEN a leg placement fails during `OPENING` and the other leg was successfully placed,
    THEN the system SHALL CONTINUE TO cancel the successful order and return to `IDLE`.

3.6 WHEN the bot is in `IN_PAIR`, `CLOSING`, or `COOLDOWN` states, THEN the system SHALL
    CONTINUE TO operate those states without any change in behavior.

---

## Bug Condition

**Bug Condition Function:**

```pascal
FUNCTION isBugCondition(X)
  INPUT: X of type HedgeBotEntryAttempt {
    legAFilled: boolean,       -- leg A has an open position from a prior fill
    legBFilled: boolean,       -- leg B has an open position from a prior fill
    state: 'OPENING'           -- bot is in OPENING state
  }
  OUTPUT: boolean

  // Bug triggers when OPENING is entered with one leg already filled
  RETURN X.state = 'OPENING' AND (X.legAFilled OR X.legBFilled)
END FUNCTION
```

**Property: Fix Checking**

```pascal
// For all OPENING ticks where one leg is already filled:
FOR ALL X WHERE isBugCondition(X) DO
  result ← _tickOpening'(X)
  ASSERT no new order placed for the already-filled leg
  ASSERT position size for the already-filled leg remains unchanged
END FOR
```

**Property: Preservation Checking**

```pascal
// For all OPENING ticks where neither leg is filled:
FOR ALL X WHERE NOT isBugCondition(X) DO
  ASSERT _tickOpening(X) = _tickOpening'(X)
  -- Both legs receive fresh orders as before
END FOR
```
