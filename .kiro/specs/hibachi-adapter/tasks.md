# Tasks: Hibachi PerpDex Exchange Adapter

## Implementation Plan

### Phase 1: Core Adapter Skeleton

- [x] 1.1 Create `src/adapters/hibachi_adapter.ts` with the `HibachiAdapter` class skeleton
  - Define the class implementing `ExchangeAdapter` (snake_case interface from `ExchangeAdapter.ts`)
  - Add `readonly exchangeName = 'hibachi'` and `readonly supportedSymbols: string[]`
  - Add constructor accepting `HibachiAdapterConfig` (apiKey, accountType, privateKey/secretKey, optional baseUrl)
  - Validate credentials in constructor and throw descriptive errors for missing/invalid fields
  - Add private fields: `_baseUrl`, `_apiKey`, `_lastNonce: bigint`, `_infoCache: Map`, `_infoCacheExpiry: Map`
  - Stub all interface methods to throw `new Error('Not implemented')`
  - Requirements: 1.1, 1.2, 1.3, 2.4, 9.1, 9.2, 9.3

- [x] 1.2 Implement `ExchangeInfoCache` — fetch and cache `GET /market/exchange-info`
  - Implement `_fetchExchangeInfo()`: GET `/market/exchange-info` with `Authorization` header
  - Parse response into `ContractInfo` objects (contractId, underlyingDecimals, settlementDecimals, minQuantity, tickSize)
  - Cache with 5-minute TTL per symbol
  - Implement `_getContractInfo(symbol)`: return cached entry or refresh and return
  - Throw `Error('Symbol not found: <symbol>')` if symbol absent after fresh fetch
  - Populate `supportedSymbols` from exchange-info on first call
  - Requirements: 6.1, 6.2, 6.3, 2.1

### Phase 2: Signing Infrastructure

- [x] 2.1 Implement nonce generation
  - Implement `_buildNonce(): bigint` — microsecond timestamp (`BigInt(Date.now()) * 1000n`)
  - Enforce monotonicity: if candidate ≤ `_lastNonce`, use `_lastNonce + 1n`
  - Update `_lastNonce` on each call
  - Requirements: 3.1, 3.2, 3.3

- [x] 2.2 Implement numeric encoding helpers
  - Implement `_encodeQuantity(floatSize: number, underlyingDecimals: number): bigint`
  - Implement `_encodePrice(floatPrice: number, underlyingDecimals: number, settlementDecimals: number): bigint`
  - Implement `_decodeQuantity(encoded: bigint, underlyingDecimals: number): number`
  - Implement `_decodePrice(encoded: bigint, underlyingDecimals: number, settlementDecimals: number): number`
  - Requirements: 4.1, 4.2, 4.3

- [x] 2.3 Implement ECDSA signer (Trustless accounts)
  - In constructor, when `accountType === 'trustless'`: create `ethers.Wallet` from `privateKey`, store as `_wallet`; do NOT store raw `privateKey` string
  - Implement `_signOrderPayload(payload: OrderSignPayload): string`
    - Build 40-byte Buffer: nonce(8) + contractId(4) + quantity(8) + side(4) + price(8) + maxFeesPercent(8), all big-endian
    - Hash with `ethers.keccak256`
    - Sign with `_wallet.signingKey.sign(hash)`
    - Return 65-byte hex: r(32) + s(32) + recoveryId(1), where recoveryId = sig.v - 27
  - Implement `_signCancelOrder(orderId: bigint): string`
    - Build 8-byte Buffer with orderId big-endian
    - Hash and sign same way
  - Implement `_signCancelAll(nonce: bigint): string`
    - Build 8-byte Buffer with nonce big-endian
    - Hash and sign same way
  - Requirements: 2.2, 5.1, 5.2, 5.3, 9.1

- [x] 2.4 Implement HMAC-SHA256 signer (Exchange Managed accounts)
  - In constructor, when `accountType === 'exchange_managed'`: store `secretKey` as `Buffer` (`_secretKeyBuf`); do NOT store raw string
  - Implement `_signOrderPayload`, `_signCancelOrder`, `_signCancelAll` for HMAC path
    - Build same byte buffers as ECDSA path
    - Use `crypto.createHmac('sha256', _secretKeyBuf).update(buf).digest('hex')`
  - Requirements: 2.3, 5.1, 5.2, 5.3, 9.2

### Phase 3: REST API Methods

- [x] 3.1 Implement `_request(method, path, body?, requiresAuth?)` helper
  - Build URL from `_baseUrl + path`
  - Add `Authorization: <apiKey>` header for authenticated endpoints
  - Add `Content-Type: application/json` for POST/DELETE with body
  - Parse JSON response; throw structured error on non-2xx with status + body
  - Handle HTTP 429: set `_rateLimitUntil` timestamp, log warning, throw
  - Handle HTTP 404: return `null` (caller decides how to handle)
  - Requirements: 2.1, 10.2, 10.3, 10.4

- [x] 3.2 Implement `get_mark_price(symbol)`
  - Use `_getContractInfo(symbol)` to resolve contractId
  - Fetch mark price from appropriate endpoint (exchange-info or dedicated price endpoint)
  - Fall back to orderbook mid-price if no dedicated endpoint
  - Return positive float
  - Requirements: 7.1

- [x] 3.3 Implement `get_orderbook(symbol)` and `get_orderbook_depth(symbol, limit)`
  - `get_orderbook`: subscribe to WebSocket orderbook feed (lazy init, same pattern as `DecibelAdapter._obCache`)
  - Cache best bid/ask with 2-second TTL
  - Fall back to REST if WebSocket not yet connected
  - `get_orderbook_depth`: fetch full depth from REST endpoint
  - Requirements: 7.2

- [x] 3.4 Implement `get_open_orders(symbol)`
  - Call `GET /account/orders` with `Authorization` header
  - Filter results by `contractId` matching the symbol
  - Map to `Order[]` with fields: `id` (orderId string), `symbol`, `side`, `price` (decoded float), `size` (decoded float), `status: 'pending'`, `timestamp: new Date()`
  - Return `[]` on 404
  - Requirements: 7.3, 10.3

- [x] 3.5 Implement `get_position(symbol, markPrice?)`
  - Call `GET /account/positions` with `Authorization` header
  - Find position matching `contractId`
  - Return `null` if not found or size is zero
  - Decode size to float; derive `side` from sign (positive = long, negative = short); `size` always positive
  - Compute `unrealizedPnl` locally from `markPrice` if API does not return it
  - Requirements: 7.4, 10.3

- [x] 3.6 Implement `get_balance()`
  - Call `GET /account/info` with `Authorization` header
  - Return equity/available balance as positive float
  - Return `0` on 404
  - Requirements: 7.5, 10.3

- [x] 3.7 Implement `place_limit_order(symbol, side, price, size, reduceOnly?, timeInForce?)`
  - Resolve `ContractInfo` for symbol
  - Build nonce with `_buildNonce()`
  - Encode quantity and price
  - Build and sign `OrderSignPayload`
  - POST to `/trade/orders` with signed body
  - Extract and return `orderId` string from response
  - Throw on API error
  - Requirements: 7.6, 5.1, 3.1, 3.2, 4.1, 4.2

- [x] 3.8 Implement `cancel_order(order_id, symbol)`
  - Build nonce
  - Sign `orderId` as 8-byte big-endian int
  - DELETE `/trade/orders` with `{ orderId, nonce, signature }`
  - Return `true` on success or 404 (already gone)
  - Catch all errors, log, return `false`
  - Requirements: 7.7, 5.2, 10.1

- [x] 3.9 Implement `cancel_all_orders(symbol)`
  - Build nonce
  - Sign nonce as 8-byte big-endian
  - DELETE `/trade/orders` with `{ nonce, signature }` (no orderId list)
  - Return `true` on success, `false` on error
  - Requirements: 7.8, 5.3, 10.1

- [x] 3.10 Implement `get_recent_trades(symbol, limit)`
  - Fetch recent trades from appropriate REST endpoint
  - Map to `RawTrade[]` with `side`, `price`, `size`, `timestamp`
  - Return `[]` on error
  - Requirements: 1.1

- [x] 3.11 Implement `get_markets()`
  - Call `_fetchExchangeInfo()` (uses cache)
  - Return sorted array of symbol strings
  - Fall back to `supportedSymbols` on error
  - Requirements: 7.9

### Phase 4: Connection Lifecycle

- [x] 4.1 Implement connection lifecycle methods
  - `connect()`: set `_connected = true`; optionally pre-warm exchange info cache
  - `disconnect()`: set `_connected = false`; close any WebSocket subscriptions
  - `isConnected()`: return `_connected`
  - `getHealthStatus()`: return `{ isHealthy: _connected, lastPing: new Date(), latency: 0 }`
  - Requirements: 1.2

### Phase 5: Factory and Configuration Integration

- [x] 5.1 Extend `CredentialStore.ts` — add `hibachi` to `BotCredentials`
  - Add `'hibachi'` to the `exchange` union type
  - Add optional fields: `hibachiApiKey?: string`, `hibachiAccountType?: 'trustless' | 'exchange_managed'`, `hibachiPrivateKey?: string`, `hibachiSecretKey?: string`
  - Requirements: 8.3

- [x] 5.2 Update `adapterFactory.ts` — add `case 'hibachi'` to both factory functions
  - In `createAdapter(exchange, credentialKey)`: read `{credentialKey}_API_KEY`, `{credentialKey}_ACCOUNT_TYPE`, `{credentialKey}_PRIVATE_KEY`, `{credentialKey}_SECRET_KEY` from `process.env`; construct and return `HibachiAdapter`
  - In `createAdapterFromCredentials(exchange, credentials)`: read `hibachiApiKey`, `hibachiAccountType`, `hibachiPrivateKey`, `hibachiSecretKey` from `credentials`; construct and return `HibachiAdapter`
  - Update the `default` error message to include `'hibachi'` in the supported exchanges list
  - Requirements: 8.1, 8.2

- [x] 5.3 Update `src/bot.ts` — add `case 'hibachi'` to legacy `createAdapter` switch
  - Read `HIBACHI_API_KEY`, `HIBACHI_ACCOUNT_TYPE`, `HIBACHI_PRIVATE_KEY`, `HIBACHI_SECRET_KEY` from `process.env`
  - Validate required vars and call `process.exit(1)` with a descriptive message if missing
  - Construct and return `HibachiAdapter`
  - Requirements: 8.4

- [x] 5.4 Update `.env.example` with `HIBACHI_*` env vars
  - Add commented section for Hibachi credentials
  - Document `HIBACHI_API_KEY`, `HIBACHI_ACCOUNT_TYPE`, `HIBACHI_PRIVATE_KEY` (trustless), `HIBACHI_SECRET_KEY` (exchange managed)
  - Include comments explaining which vars are required for each account type
  - Requirements: 8.5

### Phase 6: Testing

- [x] 6.1 Write unit tests for encoding/signing helpers
  - Test `_encodeQuantity(0.001, 8)` → `100000n`
  - Test `_encodePrice` with known BTC price and decimals → expected BigInt
  - Test `_buildNonce()` called twice rapidly → second > first
  - Test `_signOrderPayload` with ECDSA → 132-char hex string starting with `0x`
  - Test `_signOrderPayload` with HMAC → 64-char hex string
  - Test `_signCancelOrder` → correct 65-byte ECDSA signature
  - Test `_signCancelAll` → correct 65-byte ECDSA signature
  - File: `src/adapters/__tests__/hibachi_adapter.test.ts`

- [x] 6.2 Write integration tests with mocked HTTP
  - Mock `GET /market/exchange-info` with fixture data
  - Test full `place_limit_order` flow: cache fetch → encoding → signing → POST → orderId returned
  - Test `get_open_orders` filters by contractId correctly
  - Test `get_position` returns `null` for zero-size positions
  - Test `get_balance` returns `0` on 404
  - Test `cancel_order` returns `false` (not throws) on API error
  - Test `get_markets()` returns sorted symbol list

- [x] 6.3 Verify TypeScript compilation
  - Run `tsc --noEmit` and confirm zero errors in `hibachi_adapter.ts` and all modified files
  - Confirm `HibachiAdapter` satisfies both `ExchangeAdapter` and `IExchangeAdapter` type checks
