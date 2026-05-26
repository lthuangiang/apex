# Requirements: Hibachi PerpDex Exchange Adapter

## Introduction

The Apex trading bot currently supports three perpetual DEX exchanges: Decibel, SoDEX, and Dango. This feature adds Hibachi PerpDex as a fourth supported exchange by implementing a new `HibachiAdapter` class that conforms to the existing `ExchangeAdapter` interface. The adapter must handle Hibachi's two authentication modes (Trustless ECDSA and Exchange Managed HMAC-SHA256), its fixed-point numeric encoding for prices and quantities, and integrate cleanly into the existing `adapterFactory`, `CredentialStore`, and bot configuration system.

---

## Requirements

### 1. Adapter Interface Compliance

#### 1.1 Implement ExchangeAdapter Interface
The `HibachiAdapter` class MUST implement all methods of the `ExchangeAdapter` interface defined in `src/adapters/ExchangeAdapter.ts`, including: `get_mark_price`, `get_orderbook`, `place_limit_order`, `cancel_order`, `cancel_all_orders`, `get_open_orders`, `get_position`, `get_balance`, `get_orderbook_depth`, `get_recent_trades`, and the optional `get_markets`.

#### 1.2 Implement IExchangeAdapter Camelcase Aliases
The adapter MUST also implement the camelCase method aliases (`getMarkPrice`, `getOrderbook`, `placeLimitOrder`, `cancelOrder`, `cancelAllOrders`, `getOpenOrders`, `getPosition`, `getBalance`, `getOrderbookDepth`, `getRecentTrades`) and the connection lifecycle methods (`connect`, `disconnect`, `isConnected`, `getHealthStatus`) as defined in `src/types/core.ts`, matching the pattern used by `DecibelAdapter` and `SodexAdapter`.

#### 1.3 Exchange Name and Supported Symbols
The adapter MUST expose `readonly exchangeName = 'hibachi'` and a `readonly supportedSymbols` array populated from `GET /market/exchange-info` at construction time or on first use.

---

### 2. Authentication

#### 2.1 API Key Header
All requests to non-market endpoints (account info, positions, orders, trade endpoints) MUST include an `Authorization` header with the configured API key value.

#### 2.2 Trustless Account (ECDSA Signing)
When `accountType` is `'trustless'`, the adapter MUST sign write operations (place order, cancel order, cancel all) using ECDSA with the provided EVM private key. The signature MUST be a 65-byte value: 32 bytes `r` + 32 bytes `s` + 1 byte recovery ID (0 or 1, normalized from Ethereum's 27/28).

#### 2.3 Exchange Managed Account (HMAC-SHA256 Signing)
When `accountType` is `'exchange_managed'`, the adapter MUST sign write operations using HMAC-SHA256 with the provided secret key, producing a 32-byte hex digest.

#### 2.4 Credential Validation at Construction
The constructor MUST throw a descriptive error if:
- `accountType === 'trustless'` and `privateKey` is missing or not a valid 66-character `0x`-prefixed hex string
- `accountType === 'exchange_managed'` and `secretKey` is missing or empty
- `apiKey` is missing or empty

---

### 3. Nonce Management

#### 3.1 Microsecond Timestamp Nonce
Every signed request MUST use a nonce that is a microsecond-precision Unix timestamp (milliseconds × 1000), represented as a 64-bit unsigned integer.

#### 3.2 Monotonic Nonce
The adapter MUST guarantee that each nonce is strictly greater than the previous nonce issued by the same adapter instance, even when multiple calls occur within the same millisecond.

#### 3.3 Nonce Window Compliance
The adapter MUST generate nonces within the ±15-second server window. Nonces MUST NOT be pre-generated or cached for future use.

---

### 4. Numeric Encoding

#### 4.1 Quantity Encoding
Order quantities MUST be encoded as `BigInt(Math.round(floatSize * 10^underlyingDecimals))` where `underlyingDecimals` is fetched from `GET /market/exchange-info` for the relevant contract.

#### 4.2 Price Encoding
Order prices MUST be encoded as `BigInt(Math.round(floatPrice * 2^32 * 10^(settlementDecimals - underlyingDecimals)))` where both decimal values are fetched from `GET /market/exchange-info`.

#### 4.3 Decoded Values Are Floats
All values returned by the adapter to the bot core (prices, sizes, balances, PnL) MUST be standard JavaScript `number` (float), not `BigInt` or strings.

---

### 5. Order Signing Payload

#### 5.1 Place Order Payload Layout
The signing payload for placing an order MUST be a 40-byte big-endian buffer with the following layout:
- Bytes 0–7: nonce (uint64)
- Bytes 8–11: contractId (uint32)
- Bytes 12–19: quantity (uint64)
- Bytes 20–23: side (uint32, 0 = buy, 1 = sell)
- Bytes 24–31: price (uint64)
- Bytes 32–39: maxFeesPercent (uint64)

#### 5.2 Cancel Single Order Payload
The signing payload for cancelling a single order MUST be the 8-byte big-endian representation of the numeric `orderId`.

#### 5.3 Cancel All Orders Payload
The signing payload for cancelling all orders MUST be the 8-byte big-endian representation of the nonce.

---

### 6. Exchange Info Cache

#### 6.1 Cache Population
The adapter MUST fetch `GET /market/exchange-info` to obtain `contractId`, `underlyingDecimals`, `settlementDecimals`, `minQuantity`, and `tickSize` for each contract. This data MUST be cached in memory.

#### 6.2 Cache TTL
The exchange info cache MUST have a TTL of at least 5 minutes. Expired entries MUST be refreshed on next access.

#### 6.3 Symbol Resolution Failure
If a symbol cannot be resolved from the cache (after a fresh fetch), the adapter MUST throw an `Error` with a message identifying the missing symbol.

---

### 7. REST API Endpoints

#### 7.1 Mark Price
`get_mark_price(symbol)` MUST return the current mark price as a positive float. The implementation SHOULD use `GET /market/exchange-info` or a dedicated price endpoint; it MAY fall back to the mid-price from the orderbook.

#### 7.2 Orderbook
`get_orderbook(symbol)` MUST return `{ best_bid, best_ask }` as positive floats. The implementation SHOULD use a WebSocket subscription for low latency (same pattern as `DecibelAdapter`) with a REST fallback.

#### 7.3 Open Orders
`get_open_orders(symbol)` MUST call `GET /account/orders`, filter results by the symbol's `contractId`, and return an array of `Order` objects with `id`, `symbol`, `side`, `price`, `size`, `status`, and `timestamp` fields.

#### 7.4 Position
`get_position(symbol, markPrice?)` MUST call `GET /account/positions`, find the position matching the symbol's `contractId`, and return a `Position` object or `null` if no position exists or the size is zero. The returned `size` MUST always be positive; direction MUST be encoded in `side`. If the API does not return unrealized PnL and `markPrice` is provided, the adapter MUST compute PnL locally.

#### 7.5 Balance
`get_balance()` MUST call `GET /account/info` and return the equity or available balance as a positive float. It MUST return `0` on a 404 response (unfunded account) rather than throwing.

#### 7.6 Place Order
`place_limit_order(symbol, side, price, size, reduceOnly?, timeInForce?)` MUST call `POST /trade/orders` with the signed payload and return the `orderId` string from the response. It MUST throw if the API returns an error.

#### 7.7 Cancel Order
`cancel_order(order_id, symbol)` MUST call `DELETE /trade/orders` with the signed cancel payload. It MUST return `true` on success or if the order is already gone (idempotent). It MUST return `false` (not throw) on non-fatal errors, logging the error.

#### 7.8 Cancel All Orders
`cancel_all_orders(symbol)` MUST call `DELETE /trade/orders` with a nonce + signature on the nonce (not per-order IDs). It MUST return `true` on success and `false` on API error.

#### 7.9 Markets
`get_markets()` MUST call `GET /market/exchange-info` and return a sorted array of symbol strings in the format the exchange uses (e.g. `"BTC-USDT"`). It MUST fall back to `supportedSymbols` if the API call fails.

---

### 8. Factory and Configuration Integration

#### 8.1 adapterFactory — Env Var Mode
`createAdapter('hibachi', credentialKey)` in `src/bot/adapterFactory.ts` MUST read the following env vars using the `credentialKey` prefix and construct a `HibachiAdapter`:
- `{credentialKey}_API_KEY` (required)
- `{credentialKey}_ACCOUNT_TYPE` (required, `'trustless'` or `'exchange_managed'`)
- `{credentialKey}_PRIVATE_KEY` (required when `ACCOUNT_TYPE=trustless`)
- `{credentialKey}_SECRET_KEY` (required when `ACCOUNT_TYPE=exchange_managed`)

#### 8.2 adapterFactory — Credentials Mode
`createAdapterFromCredentials('hibachi', credentials)` MUST construct a `HibachiAdapter` from a `BotCredentials` object, throwing a descriptive error if required fields are missing.

#### 8.3 CredentialStore Type Extension
The `BotCredentials` interface in `src/bot/CredentialStore.ts` MUST be extended to include `'hibachi'` in the `exchange` union type and the following optional fields: `apiKey`, `accountType`, `privateKey` (trustless), `secretKey` (exchange managed).

#### 8.4 Legacy Single-Bot Mode
The `createAdapter` switch in `src/bot.ts` MUST include a `case 'hibachi'` branch that reads `HIBACHI_*` env vars and constructs a `HibachiAdapter`.

#### 8.5 Environment Variable Documentation
`.env.example` MUST be updated to document all `HIBACHI_*` env vars with comments explaining each field and which are required for each account type.

---

### 9. Security

#### 9.1 Private Key Not Retained as String
The ECDSA private key string MUST NOT be stored as a class field after the constructor completes. It MUST be wrapped in an `ethers.Wallet` or `ethers.SigningKey` instance immediately.

#### 9.2 HMAC Secret Not Retained as String
The HMAC secret MUST NOT be stored as a class field after the constructor completes. It MUST be stored only in a form suitable for signing (e.g. as a `Buffer` or used only within the signing function).

#### 9.3 No Credential Logging
The adapter MUST NOT log the private key, secret key, or API key at any log level.

---

### 10. Error Handling and Resilience

#### 10.1 Non-Throwing Cancel
`cancel_order` and `cancel_all_orders` MUST catch all errors internally and return `false` rather than propagating exceptions, matching the behavior of `SodexAdapter` and `DecibelAdapter`.

#### 10.2 Rate Limit Backoff
If Hibachi returns HTTP 429, the adapter SHOULD set a `_rateLimitUntil` timestamp and pause subsequent requests until the backoff period expires, following the same pattern as `SodexAdapter`.

#### 10.3 404 Handling
HTTP 404 responses from account/position/order endpoints MUST be treated as "not found" (return `null` or empty array) rather than thrown errors.

#### 10.4 Structured Error Messages
All thrown errors MUST include the HTTP status code and the API error body to aid debugging.
