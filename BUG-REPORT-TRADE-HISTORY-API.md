**Signal Report:** @junxcrypto

**Category:** API / Backend / Data Retrieval

---

**The Gap:**

The `/api/v1/trade_history` endpoint is ignoring the `limit` parameter and consistently returning only 200 trades regardless of the requested limit value. This creates a hard ceiling on historical data access, preventing users from retrieving complete trading history for analytics, reporting, and volume calculations. When requesting limits of 250, 500, or even 1000 trades, the API still returns exactly 200 trades with identical timestamps, suggesting either a hard-coded backend limitation or a data retention policy that is not documented.

---

**Evidence of the Bug:**

**Test 1 - limit=200:**
- Request: `GET /api/v1/trade_history?account=0xa1ed...3d6d&limit=200&offset=0`
- Result: 200 trades returned ✓
- Oldest trade: 2026-05-01T02:45:20.844Z
- Newest trade: 2026-05-01T13:38:27.762Z

**Test 2 - limit=250:**
- Request: `GET /api/v1/trade_history?account=0xa1ed...3d6d&limit=250&offset=0`
- Result: 200 trades returned (expected 250+)
- Oldest trade: 2026-05-01T02:45:20.844Z (identical to Test 1)
- Newest trade: 2026-05-01T13:38:27.762Z (identical to Test 1)

**Test 3 - limit=500:**
- Request: `GET /api/v1/trade_history?account=0xa1ed...3d6d&limit=500&offset=0`
- Result: 200 trades returned (expected 500+)
- Data: Identical timestamps and trade count as previous tests

**Test 4 - limit=1000:**
- Request: `GET /api/v1/trade_history?account=0xa1ed...3d6d&limit=1000&offset=0`
- Result: 200 trades returned (expected 1000+)
- Data: Identical timestamps and trade count as previous tests

All four requests returned the exact same 200 trades covering only a 10.89-hour window on May 1, 2026. The `total_count` field consistently reports 200, making it impossible to determine if older historical data exists in the database.

**Critical Impact:** This limitation is causing the event/incentive program ticket count to remain stuck at 1, despite generating $50k+ in actual trading volume. The volume calculation logic cannot access the full trade history needed to properly calculate milestone progress, resulting in incorrect reward tracking and user frustration.

---

**The Fix:**

The backend query logic needs to respect the `limit` parameter passed in the request. If there is an intentional maximum limit (e.g., 1000 trades per request), it should be documented and enforced properly:

```typescript
// Current (broken):
const trades = await db.query('SELECT * FROM trades WHERE account = ? LIMIT 200');

// Fixed:
const requestedLimit = parseInt(req.query.limit) || 200;
const maxLimit = 1000; // or whatever the system can handle
const limit = Math.min(requestedLimit, maxLimit);
const trades = await db.query('SELECT * FROM trades WHERE account = ? LIMIT ?', [account, limit]);
```

Additionally, if there is a data retention policy limiting historical trades to 200 per account, this must be clearly documented in the API specification. The `total_count` field should accurately reflect whether more data exists, and pagination via `offset` should be tested to ensure older trades are accessible.

---

**Why It Matters:**

Accurate historical data access is fundamental for professional trading operations. Users building analytics dashboards, calculating multi-day volumes, generating tax reports, or auditing trading performance cannot function with a 200-trade ceiling. When the API silently ignores the `limit` parameter, it breaks the contract between the platform and developers, forcing them to either accept incomplete data or implement complex workarounds that may not even work if the data truly doesn't exist beyond 200 trades.

**This bug is directly breaking incentive programs.** The 200-trade limitation prevents volume calculation systems from accessing complete trading history, causing milestone tracking to fail. In the current case, despite generating over $50,000 in verified trading volume, the event dashboard shows the ticket count stuck at 1 because the backend cannot retrieve and sum all trades. This creates a devastating user experience where traders see their efforts go unrewarded, not due to insufficient activity, but due to a data retrieval bug.

For volume-based competitions, reward distribution, or compliance reporting, this limitation results in incorrect calculations, unfair outcomes, and severe loss of user trust. When participants trade actively but see no progress on their incentive dashboard, they lose motivation to continue. A reliable, well-documented API is essential for ecosystem growth and developer confidence—especially when real rewards are at stake.
