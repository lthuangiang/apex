# Four-Day Trade Volume Results

## Summary

Successfully created and executed tools to fetch trade volume data from Decibel exchange for the last four days.

## Results (as of May 1, 2026)

| Date       | Volume      | Trade Count |
|------------|-------------|-------------|
| 2026-05-01 | $50,145.92  | 200 trades  |
| 2026-04-30 | $0.00       | 0 trades    |
| 2026-04-29 | $0.00       | 0 trades    |
| 2026-04-28 | $0.00       | 0 trades    |

### Aggregate Statistics

- **Total 4-day volume**: $50,145.92
- **Total trades**: 200
- **Average daily volume**: $12,536.48
- **Average daily trades**: 50

## Files Created

### 1. Unit Test: `src/adapters/__tests__/decibel-three-day-volume.test.ts`

A Vitest unit test that:
- Fetches trade history from Decibel API for the last 4 days
- Calculates volume by summing `size * price` for each trade
- Handles pagination automatically (200 trades per page)
- Displays formatted results with trade counts
- Includes assertions to validate data integrity

**Run with:**
```bash
npm test -- src/adapters/__tests__/decibel-three-day-volume.test.ts
```

### 2. Standalone Script: `src/scripts/get-three-day-volume.ts`

A standalone TypeScript script that:
- Can be run directly without the test framework
- Provides formatted console output with emojis
- Shows detailed progress for each day
- Displays a comprehensive summary table
- **Fetches data for the last 4 days**

**Run with:**
```bash
npx tsx src/scripts/get-three-day-volume.ts
```

## Technical Details

### API Integration

Both tools query the Decibel trade history API:
- **Endpoint**: `https://api.mainnet.aptoslabs.com/decibel/api/v1/trade_history`
- **Authentication**: Bearer token via `DECIBELS_NODE_API_KEY`
- **Account**: Filtered by `DECIBELS_SUBACCOUNT` address

### Volume Calculation

For each day (UTC timezone):
1. Calculate start timestamp: `00:00:00 UTC`
2. Calculate end timestamp: `23:59:59.999 UTC`
3. Fetch all trades in that time range (with pagination)
4. Sum: `volume += trade.size * trade.price`

### Features

- ✅ Handles multiple API response formats
- ✅ Automatic pagination for large datasets
- ✅ UTC timezone alignment
- ✅ Error handling for API failures
- ✅ Trade count tracking
- ✅ Formatted output with statistics

## Environment Variables Required

```bash
DECIBELS_SUBACCOUNT=0xa1edf1c2b077bde023efba8a9317fd4db6552dcc6916566dc491ca1247013d6d
DECIBELS_NODE_API_KEY=<your-api-key>
```

## Notes

- All volumes are in USD
- Timestamps use UTC timezone
- The test has a 30-second timeout to accommodate API latency
- Pagination handles up to thousands of trades automatically
