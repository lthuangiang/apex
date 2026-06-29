# sodex_sltp — Native Stop Loss / Take Profit for SoDEX

## Context

File: `src/adapters/sodex_adapter.ts`

The current `place_limit_order()` sends a single order per request using manually serialized JSON with strict Go struct field order:

```
{"clOrdID":"...","modifier":1,"side":1,"type":1,"timeInForce":4,"price":"...","quantity":"...","reduceOnly":false,"positionSide":1}
```

The `request()` method has a special branch for `POST /trade/orders` that only handles `data.orders[0]` (single order). The signature (`getSignature()`) is computed over a manually built `paramsStr` string — **field order matters**, do NOT use `JSON.stringify`.

The current poll-based SL in `Watcher.ts` fires every ~5s and is too slow for flash crashes. SoDEX supports native server-side SL/TP via batch orders with `modifier: 3` (STOP) and `modifier: 5` (ATTACHED_STOP).

---

## Modifier / Type / TimeInForce Enums

| Value | Modifier | Value | Type | Value | TimeInForce |
|-------|----------|-------|------|-------|-------------|
| 1 | NORMAL (entry) | 1 | LIMIT | 1 | IOC |
| 3 | STOP (standalone on existing position) | 2 | MARKET | 3 | GTC |
| 5 | ATTACHED_STOP (bracket SL/TP) | | | 4 | GTX (Post-Only) |

---

## Task 1 — Add `placeOrdersBatch()` private method

Update `request()` or add a new private method that serializes **multiple orders** in a single `POST /trade/orders` payload. Each order item must follow strict field order:

**Entry order item (no stopPrice):**
```
{"clOrdID":"...","modifier":1,"side":1,"type":1,"timeInForce":4,"price":"...","quantity":"...","reduceOnly":false,"positionSide":1}
```

**SL/TP order item (includes stopPrice):**
```
{"clOrdID":"...","modifier":5,"side":2,"type":2,"timeInForce":1,"price":"0","quantity":"...","stopPrice":"...","reduceOnly":true,"positionSide":1}
```

Full batch payload:
```
{"accountID":N,"symbolID":N,"orders":[<item0>,<item1>,<item2>]}
```

Rules:
- Build all strings manually — **no `JSON.stringify`**
- `stopPrice` field must only appear in SL/TP items (Go omits zero-value fields with `omitempty`)
- `price` on a MARKET order = `"0"`
- `getSignature()` action type = `"newOrder"` (same as single order)
- `positionSide` always = `1` (one-way mode)

---

## Task 2 — Add `place_limit_order_with_sl()`

```typescript
async place_limit_order_with_sl(
    symbol: string,
    side: 'buy' | 'sell',
    price: number,
    size: number,
    slPercent: number,   // e.g. 0.05 = 5%
    tpUsd?: number,      // optional: absolute USD profit target e.g. 0.5
    reduceOnly = false,
): Promise<{ entryClOrdID: string; slClOrdID: string; tpClOrdID?: string }>
```

Places 2–3 orders in one batch:

**orders[0] — Entry (modifier: 1, BRACKET if API requires, else NORMAL)**
- Same as current `place_limit_order` entry order

**orders[1] — SL (modifier: 5, type: 2 MARKET, timeInForce: 1 IOC)**
- `side`: opposite of entry (`buy` → `sell`, `sell` → `buy`)
- `stopPrice`:
  - LONG: `entryPrice * (1 - slPercent)`
  - SHORT: `entryPrice * (1 + slPercent)`
- `reduceOnly: true`
- `price: "0"` (market order)

**orders[2] — TP (modifier: 5, type: 1 LIMIT, timeInForce: 3 GTC)** *(optional, only if `tpUsd` provided)*
- `side`: opposite of entry
- `tpPrice`:
  - LONG: `entryPrice + (tpUsd / size)`
  - SHORT: `entryPrice - (tpUsd / size)`
- `stopPrice` = `tpPrice` (trigger)
- `price` = `tpPrice` (limit fill)
- `reduceOnly: true`

All prices → `roundToTick()`, all quantities → `roundToLot()`.

Log after placing:
```
[SoDEX] Native SL placed: clOrdID=sl-xxx stopPrice=95000 side=sell
[SoDEX] Native TP placed: clOrdID=tp-xxx price=96000 side=sell
```

---

## Task 3 — Add `attach_sl_to_position()`

For existing open positions that don't have a native SL yet.

```typescript
async attach_sl_to_position(
    symbol: string,
    side: 'buy' | 'sell',   // current position side
    size: number,
    currentPrice: number,
    slPercent: number,
): Promise<string>           // returns clOrdID
```

Places a single STOP order:
- `modifier: 3` (STOP — standalone, not bracket)
- `type: 2` (MARKET)
- `timeInForce: 1` (IOC)
- `reduceOnly: true`
- `side`: opposite of position
- `stopPrice`:
  - LONG position: `currentPrice * (1 - slPercent)`
  - SHORT position: `currentPrice * (1 + slPercent)`
- `price: "0"`

Serialized item:
```
{"clOrdID":"sl-pos-xxx","modifier":3,"side":2,"type":2,"timeInForce":1,"price":"0","quantity":"...","stopPrice":"...","reduceOnly":true,"positionSide":1}
```

---

## Task 4 — Add camelCase aliases

```typescript
async placeLimitOrderWithSL(
    params: OrderParams & { slPercent: number; tpUsd?: number }
): Promise<{ entryClOrdID: string; slClOrdID: string; tpClOrdID?: string }> {
    return this.place_limit_order_with_sl(
        params.symbol, params.side, params.price, params.size,
        params.slPercent, params.tpUsd, params.reduceOnly
    );
}

async attachSLToPosition(
    symbol: string, side: 'buy' | 'sell', size: number,
    currentPrice: number, slPercent: number
): Promise<string> {
    return this.attach_sl_to_position(symbol, side, size, currentPrice, slPercent);
}
```

---

## Task 5 — Update `Watcher.ts`

### 5a — New state fields

```typescript
private _nativeSLOrderId: string | null = null;
private _nativeTPOrderId: string | null = null;
```

### 5b — Call `attachSLToPosition` after fill

In `_onEntryFilled()` (or wherever fill is confirmed and `_state` transitions to `IN_POSITION`):

```typescript
if (this.config.useNativeSL !== false) {   // default ON
    try {
        this._nativeSLOrderId = await (this.adapter as SodexAdapter).attachSLToPosition(
            this.config.symbol,
            fill.side,
            fill.quantity,
            fill.price,
            this.config.slPercent ?? 0.05
        );
        this.logger.info(`[SL] Native SL attached @ stopPrice=${fill.price * (fill.side === 'buy' ? 0.95 : 1.05)} | ${this._nativeSLOrderId}`);
    } catch (err) {
        this.logger.warn('[SL] Native SL failed — falling back to poll-based SL', err);
    }
}
```

### 5c — Skip poll-based SL check if native SL is active

In `_checkExitConditions()`, at the top of the SL check block:

```typescript
// Skip poll-based SL if native SL is active on exchange
if (this._nativeSLOrderId) {
    // Only check TP and time exit
    return this._checkTPAndTimeExit();
}
// else: run full exit check (fallback)
return this._checkAllExitConditions();
```

### 5d — Cancel native SL/TP when exiting via TP or time exit

In `_placeExitOrder()` or `_onExitFilled()`:

```typescript
private async _cancelNativeOrders(): Promise<void> {
    const toCancel = [this._nativeSLOrderId, this._nativeTPOrderId].filter(Boolean) as string[];
    for (const ordId of toCancel) {
        try {
            await this.adapter.cancelOrder(ordId, this.config.symbol);
            this.logger.info(`[SL] Cancelled native order ${ordId}`);
        } catch (err) {
            this.logger.warn(`[SL] Failed to cancel native order ${ordId}`, err);
        }
    }
    this._nativeSLOrderId = null;
    this._nativeTPOrderId = null;
}
```

Call `_cancelNativeOrders()` before placing any exit order that isn't triggered by the native SL itself.

### 5e — Config flag

Add to `config.ts` / `BotConfig`:

```typescript
useNativeSL?: boolean;   // default: true (only for SoDEX adapter)
```

---

## Constraints

- Do NOT change `place_limit_order()` — must remain backward compatible
- Do NOT use `JSON.stringify` anywhere in the serialization path
- Do NOT change `getSignature()` or request header logic
- `cachedTickSize` / `cachedLotSize` are already populated by `getSymbolId()` — use existing `roundToTick()` / `roundToLot()`
- Native SL only applies when `this.adapter instanceof SodexAdapter` — other adapters keep poll-based SL unchanged
- All new methods: wrap in try/catch and rethrow with prefix `[SoDEX] <methodName> failed:`

---

## Files to modify

| File | Change |
|------|--------|
| `src/adapters/sodex_adapter.ts` | Add Tasks 1–4 |
| `src/modules/Watcher.ts` | Add Task 5a–5e |
| `src/config.ts` | Add `useNativeSL?: boolean` to BotConfig |
