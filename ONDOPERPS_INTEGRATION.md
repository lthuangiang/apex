# OndoPerps Integration Guide

## ✅ Phase 1 Complete - Core Implementation

OndoPerps adapter đã được implement và test thành công. Tất cả core APIs đã hoạt động.

## 📁 Files Created

### Core Implementation
- `src/adapters/types/ondoperps.types.ts` - Type definitions
- `src/adapters/ondoperps_adapter.ts` - Main adapter (500 lines)
- `src/adapters/__tests__/ondoperps_adapter.test.ts` - Unit tests (15 tests, all passing)
- `src/adapters/__tests__/ondoperps_integration.test.ts` - Integration tests (manual)
- `scripts/test-ondoperps.ts` - Manual test script

### Configuration
- `.env.example` - Updated with OndoPerps credentials
- `.env.test` - Test credentials template
- `src/bot/adapterFactory.ts` - Updated with OndoPerps support

## 🚀 Quick Start

### 1. Setup Credentials

Copy `.env.example` to `.env` và điền credentials:

```bash
ONDOPERPS_API_KEY_ID=your_api_key_id_here
ONDOPERPS_API_KEY_SECRET=your_api_key_secret_here
ONDOPERPS_BASE_URL=https://api.ondoperps.xyz/v1
```

### 2. Add Bot Config

Thêm vào `bot-configs.json`:

```json
{
  "id": "ondoperps-bot-1",
  "exchange": "ondoperps",
  "symbol": "XAU-PERP",
  "leverage": 10,
  "mode": "trade",
  "budget": 1000
}
```

**Lưu ý**: OndoPerps chỉ hỗ trợ RWA (Real World Assets) như XAU (vàng), AAPL (Apple stock), không hỗ trợ crypto như BTC/ETH.

### 3. Run Tests

```bash
# Unit tests (mocked)
npm test -- ondoperps_adapter.test.ts

# Manual integration test
tsx scripts/test-ondoperps.ts
```

## 📊 Implemented Features

### Core Methods ✅
- [x] `connect()` - Connect and fetch markets
- [x] `getBalance()` - Fetch account balance
- [x] `getPositions()` - Fetch open positions
- [x] `placeOrder()` - Place limit/market orders
- [x] `cancelOrder()` - Cancel order by ID
- [x] `getOrder()` - Fetch order details
- [x] `getOpenOrders()` - Fetch all open orders
- [x] `fetchMarkets()` - Fetch and cache market info

### Features ✅
- [x] Symbol mapping (BTC-PERP → BTC-USD.P)
- [x] Side mapping (long/short → buy/sell)
- [x] Price/size rounding to increments
- [x] Market info caching
- [x] Error handling with OndoPerps-specific codes
- [x] Support for both limit and market orders
- [x] TimeInForce support (GTC, IOC)

## 🧪 Test Results

### Unit Tests: **15/15 PASSED** ✅

```
✅ fetchMarkets - cache market info
✅ fetchMarkets - skip inactive markets
✅ getBalance - fetch and map balance
✅ getPositions - fetch and map positions
✅ placeOrder - limit buy order
✅ placeOrder - market sell order
✅ placeOrder - insufficient_margin error
✅ placeOrder - post_only_has_match error
✅ cancelOrder - cancel by id
✅ getOrder - fetch order details
✅ getOpenOrders - fetch all orders
✅ getOpenOrders - fetch by symbol
✅ connect - fetch markets
✅ disconnect
✅ getConnectionHealth
```

## 🔧 Manual Testing

```bash
# Test với real API credentials
tsx scripts/test-ondoperps.ts
```

Script sẽ test:
1. ✅ Connect và fetch markets
2. ✅ Fetch balance
3. ✅ Fetch positions
4. ✅ Fetch open orders
5. ⚠️ Place/cancel test order (commented - uncomment để test)

## 🎯 API Coverage

| OndoPerps API | Status | Method |
|---------------|--------|--------|
| GET /perps/markets | ✅ | `fetchMarkets()` |
| GET /account | ✅ | `getBalance()`, `getPositions()` |
| POST /perps/orders | ✅ | `placeOrder()` |
| DELETE /perps/orders/{id} | ✅ | `cancelOrder()` |
| GET /perps/orders/{id} | ✅ | `getOrder()` |
| GET /perps/orders | ✅ | `getOpenOrders()` |

## ⚠️ Error Handling

Adapter xử lý tất cả error codes từ OndoPerps:

- `insufficient_margin` - Không đủ margin
- `insufficient_funds` - Không đủ funds
- `account_in_liquidation` - Account đang bị liquidation
- `post_only_has_match` - PostOnly order sẽ match ngay
- `order_invalid_price` - Price không hợp lệ
- `order_invalid_size` - Size không hợp lệ
- `too_many_requests` - Rate limit
- Generic errors

## 📝 Usage Example

```typescript
import { OndoPerpsAdapter } from './adapters/ondoperps_adapter';

const adapter = new OndoPerpsAdapter({
  apiKeyId: 'your-key-id',
  apiKeySecret: 'your-secret',
});

await adapter.connect();

// Get balance
const balance = await adapter.getBalance();
console.log(`Balance: ${balance.available} ${balance.currency}`);

// Place order (XAU - Gold)
const order = await adapter.placeOrder({
  symbol: 'XAU-PERP',
  side: 'long',
  type: 'LIMIT',
  price: 2000,
  size: 10
});

console.log(`Order placed: ${order.id}`);
```

**Supported Assets**: OndoPerps supports RWA (Real World Assets) like XAU (Gold), AAPL (Apple), and other traditional securities - NOT crypto assets.

## 🔜 Next Steps (Phase 2 - Dashboard)

- [ ] Dashboard UI cho OndoPerps
- [ ] Credential form với API Key ID field
- [ ] Exchange dropdown update
- [ ] Multi-bot dashboard views

## 🔜 Future Enhancements (Phase 3)

- [ ] Take Profit / Stop Loss support
- [ ] PostOnly strategy support
- [ ] ReduceOnly mode
- [ ] WebSocket subscriptions
- [ ] Orderbook data
- [ ] Rate limit optimization

## 📚 Reference

- API Docs: https://docs.ondoperps.xyz/api-reference/orders/create-order
- Base URL: https://api.ondoperps.xyz/v1
- Auth: X-API-KEY-ID header + Bearer token

## ✨ Summary

**Phase 1 Core Implementation: COMPLETE** ✅

- 500+ lines of production code
- 15 unit tests, all passing
- Full error handling
- Integration test script
- Ready for dashboard integration
