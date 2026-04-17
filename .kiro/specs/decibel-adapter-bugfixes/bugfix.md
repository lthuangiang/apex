# Bugfix Requirements Document: Decibel Adapter

## Introduction

This document specifies the requirements for fixing 6 critical bugs in the Decibel adapter (`src/adapters/decibel_adapter.ts`) that prevent it from functioning correctly across multiple markets, make it difficult to maintain, and cause issues with order tracking and code quality.

The bugs affect:
- **Multi-market support**: Hardcoded "BTC/USD" prevents trading other markets
- **Configuration flexibility**: Hardcoded builder address makes the code inflexible
- **Decibel API compliance**: Builder address format doesn't meet Decibel's 64-hex-character requirement
- **Order tracking**: Fake order IDs prevent proper order management
- **Code quality**: Unused code and parameters cause TypeScript warnings
- **Error handling**: Missing validation and extraction logic for order responses

## Bug Analysis

### Current Behavior (Defect)

#### Bug 1: Hardcoded Symbol

1.1 WHEN `getMarketConfig(symbol)` is called with any symbol THEN the system overwrites the parameter with `symbol = "BTC/USD"` and only returns config for BTC/USD

1.2 WHEN `get_mark_price(symbol)` is called with any symbol THEN the system overwrites the parameter with `symbol = "BTC/USD"` and only returns price for BTC/USD

1.3 WHEN `place_limit_order()` is called with any symbol THEN the system uses hardcoded `marketName: "BTC/USD"` instead of the provided symbol parameter

#### Bug 2: Hardcoded Builder Address

1.4 WHEN `approveBuilderFee()` is called THEN the system uses hardcoded builder address `"0x5eefc26ee8f0b537717e57718a9a0c365e32081d96dc618a56041b3b7ff31ed5"` instead of a configurable value

1.5 WHEN `place_limit_order()` is called THEN the system uses hardcoded builder address `"0x5eefc26ee8f0b537717e57718a9a0c365e32081d96dc618a56041b3b7ff31ed5"` instead of a configurable value

#### Bug 3: Builder Address Format

1.6 WHEN builder address is used in API calls THEN the system does not pad the address to 64 hex characters (66 total with 0x prefix) as required by Decibel API

1.7 WHEN builder address is shorter than 64 hex characters THEN the system may receive "Invalid builder address" errors from Decibel API

#### Bug 4: Fake Order ID

1.8 WHEN `place_limit_order()` successfully places an order THEN the system returns a fake order ID `"decibel-order-" + Date.now()` instead of the real order ID from the response

1.9 WHEN the fake order ID is used to cancel an order THEN the system fails to cancel the order because the ID doesn't match any real order

#### Bug 5: Unused Code

1.10 WHEN the code is compiled THEN TypeScript reports warning "'amountToChainUnits' is declared but its value is never read"

1.11 WHEN `get_orderbook_depth(symbol, limit)` is called THEN the parameters `symbol` and `limit` are not used, causing TypeScript warnings

1.12 WHEN `get_recent_trades(symbol, limit)` is called THEN the parameters `symbol` and `limit` are not used, causing TypeScript warnings

#### Bug 6: Missing Error Handling

1.13 WHEN `place_limit_order()` receives a response from Decibel API THEN the system logs the result but does not extract the order ID from the response structure

1.14 WHEN `place_limit_order()` receives a response without an order ID field THEN the system does not validate the response structure or throw an error

#### Bug 7: Incorrect Error Handling in cancel_all_orders

1.15 WHEN `cancel_all_orders(symbol)` is called and there are open orders THEN the system catches EORDER_NOT_FOUND error and returns `true` without actually cancelling the orders

1.16 WHEN `cancel_all_orders(symbol)` returns `true` but `get_open_orders(symbol)` still shows open orders THEN the system has incorrectly treated an API error as success

### Expected Behavior (Correct)

#### Bug 1: Multi-Market Support

2.1 WHEN `getMarketConfig(symbol)` is called with any symbol THEN the system SHALL use the provided symbol parameter to fetch and return the correct market configuration

2.2 WHEN `get_mark_price(symbol)` is called with any symbol THEN the system SHALL use the provided symbol parameter to fetch and return the correct mark price

2.3 WHEN `place_limit_order()` is called with any symbol THEN the system SHALL use the provided symbol parameter as the `marketName` in the order request

#### Bug 2: Configurable Builder Address

2.4 WHEN the adapter is constructed THEN the system SHALL accept a `builderAddr` parameter and store it as an instance variable

2.5 WHEN `approveBuilderFee()` is called THEN the system SHALL use the configured builder address from the instance variable

2.6 WHEN `place_limit_order()` is called THEN the system SHALL use the configured builder address from the instance variable

#### Bug 3: Proper Address Padding

2.7 WHEN a builder address is provided to the constructor THEN the system SHALL pad the address to 64 hex characters (66 total with 0x prefix) using leading zeros

2.8 WHEN the padded builder address is used in API calls THEN the system SHALL comply with Decibel's address format requirements and not receive "Invalid builder address" errors

#### Bug 4: Real Order ID

2.9 WHEN `place_limit_order()` successfully places an order THEN the system SHALL extract and return the real order ID from the response (checking fields: `orderId`, `order_id`, or `hash`)

2.10 WHEN the real order ID is used to cancel an order THEN the system SHALL successfully cancel the order

#### Bug 5: Clean Code

2.11 WHEN the code is compiled THEN the system SHALL NOT have any unused methods like `amountToChainUnits()`

2.12 WHEN stub methods like `get_orderbook_depth()` and `get_recent_trades()` are defined THEN the system SHALL prefix unused parameters with underscore (e.g., `_symbol`, `_limit`) to suppress TypeScript warnings

#### Bug 6: Proper Error Handling

2.13 WHEN `place_limit_order()` receives a response from Decibel API THEN the system SHALL extract the order ID from the response structure (checking `orderId`, `order_id`, or `hash` fields)

2.14 WHEN `place_limit_order()` receives a response without a valid order ID field THEN the system SHALL throw an error with a descriptive message including the response structure

#### Bug 7: Correct cancel_all_orders Behavior

2.15 WHEN `cancel_all_orders(symbol)` is called THEN the system SHALL actually cancel all open orders for the symbol and only return `true` when orders are successfully cancelled or when there are genuinely no open orders

2.16 WHEN `cancel_all_orders(symbol)` encounters an EORDER_NOT_FOUND error THEN the system SHALL investigate the root cause (incorrect parameters, timing issues, or market identifier mismatch) rather than assuming success

### Unchanged Behavior (Regression Prevention)

3.1 WHEN any existing method is called with valid parameters THEN the system SHALL CONTINUE TO return the same data types and structures as before

3.2 WHEN `place_limit_order()` is called with valid parameters THEN the system SHALL CONTINUE TO place orders successfully on Decibel DEX

3.3 WHEN `cancel_order()` is called with a valid order ID THEN the system SHALL CONTINUE TO cancel orders successfully

3.4 WHEN `get_position()` is called THEN the system SHALL CONTINUE TO return position information in the same format

3.5 WHEN `get_balance()` is called THEN the system SHALL CONTINUE TO return balance information correctly

3.6 WHEN `get_orderbook()` is called THEN the system SHALL CONTINUE TO return best bid/ask prices using the WebSocket subscription mechanism

3.7 WHEN the adapter is constructed with valid credentials THEN the system SHALL CONTINUE TO initialize the read and write clients successfully

3.8 WHEN Gas Station API key is provided THEN the system SHALL CONTINUE TO use the gas station for transaction fees

3.9 WHEN debug mode is enabled (DECIBEL_DEBUG=true) THEN the system SHALL CONTINUE TO log all HTTP requests and responses
