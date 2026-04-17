# Decibel Adapter Bugfixes Design

## Overview

This design addresses 7 critical bugs in the Decibel adapter that prevent multi-market trading, make the code inflexible and unmaintainable, and cause order tracking failures. The bugs fall into four categories:

1. **Hardcoded values** (symbols and builder address) that prevent flexibility
2. **API compliance issues** (builder address format and order ID extraction)
3. **Code quality issues** (unused code and missing error handling)
4. **Incorrect error handling** (cancel_all_orders treating API errors as success)

The fix approach is surgical and minimal: remove hardcoded values, add proper address padding, extract real order IDs from responses, clean up unused code, and fix incorrect error handling in cancel_all_orders. All existing functionality will be preserved.

## Glossary

- **Bug_Condition (C)**: The condition that triggers each bug - when hardcoded values override parameters, when addresses aren't padded, when fake IDs are returned, or when unused code exists
- **Property (P)**: The desired behavior - parameters should be used as provided, addresses should be properly formatted, real IDs should be returned, and code should be clean
- **Preservation**: All existing adapter functionality (order placement, cancellation, position queries, balance queries, orderbook subscriptions) must continue working exactly as before
- **DecibelAdapter**: The exchange adapter class in `src/adapters/decibel_adapter.ts` that interfaces with Decibel DEX
- **Builder Address**: A 64-hex-character address (66 total with 0x prefix) used to collect trading fees from orders
- **Market Config**: Configuration for a trading pair including size decimals, price decimals, tick size, and minimum size
- **Chain Units**: Decibel's internal representation where prices and sizes are multiplied by 10^decimals

## Bug Details

### Bug Condition

The bugs manifest in seven distinct scenarios:

**Bug 1: Hardcoded Symbol**
- Occurs when `getMarketConfig(symbol)`, `get_mark_price(symbol)`, or `place_limit_order()` is called with any symbol
- The functions override the `symbol` parameter with hardcoded `"BTC/USD"`
- Result: Only BTC/USD market works, all other markets fail

**Bug 2: Hardcoded Builder Address**
- Occurs when `approveBuilderFee()` or `place_limit_order()` is called
- The functions use a hardcoded builder address instead of a configurable value
- Result: Cannot change builder address without modifying source code

**Bug 3: Builder Address Format**
- Occurs when builder address is used in Decibel API calls
- The address is not padded to 64 hex characters as required by Decibel
- Result: "Invalid builder address" errors from Decibel API

**Bug 4: Fake Order ID**
- Occurs when `place_limit_order()` successfully places an order
- The function returns `"decibel-order-" + Date.now()` instead of extracting the real order ID from the response
- Result: Cannot cancel orders because fake IDs don't match real orders

**Bug 5: Unused Code**
- Occurs during TypeScript compilation
- Methods like `amountToChainUnits()` are defined but never used
- Parameters in stub methods (`get_orderbook_depth`, `get_recent_trades`) are not used
- Result: TypeScript warnings clutter the build output

**Bug 6: Missing Error Handling**
- Occurs when `place_limit_order()` receives a response from Decibel API
- The function logs the response but doesn't extract or validate the order ID
- Result: No validation that the order was actually placed successfully

**Bug 7: Incorrect Error Handling in cancel_all_orders**
- Occurs when `cancel_all_orders(symbol)` is called and there are open orders
- The function catches EORDER_NOT_FOUND error and treats it as success, returning `true`
- Result: Orders remain open despite the method returning success, breaking the contract that `true` means orders were cancelled

**Formal Specification:**
```
FUNCTION isBugCondition(input)
  INPUT: input of type { method: string, params: any }
  OUTPUT: boolean
  
  RETURN (
    // Bug 1: Hardcoded symbol
    (input.method IN ['getMarketConfig', 'get_mark_price', 'place_limit_order']
     AND input.params.symbol != 'BTC/USD'
     AND codeOverridesSymbolParameter())
    
    OR
    
    // Bug 2: Hardcoded builder address
    (input.method IN ['approveBuilderFee', 'place_limit_order']
     AND codeUsesHardcodedBuilderAddress())
    
    OR
    
    // Bug 3: Builder address format
    (input.method IN ['approveBuilderFee', 'place_limit_order']
     AND builderAddress.length != 66  // 0x + 64 hex chars
     AND NOT isPaddedTo64HexChars(builderAddress))
    
    OR
    
    // Bug 4: Fake order ID
    (input.method == 'place_limit_order'
     AND orderPlacedSuccessfully()
     AND returnedOrderId.startsWith('decibel-order-'))
    
    OR
    
    // Bug 5: Unused code
    (input.method == 'compile'
     AND (unusedMethodExists('amountToChainUnits')
          OR unusedParametersExist(['symbol', 'limit'])))
    
    OR
    
    // Bug 6: Missing error handling
    (input.method == 'place_limit_order'
     AND responseReceived()
     AND NOT orderIdExtractedFromResponse()
     AND NOT responseValidated())
    
    OR
    
    // Bug 7: Incorrect error handling in cancel_all_orders
    (input.method == 'cancel_all_orders'
     AND openOrdersExist(input.params.symbol)
     AND apiReturnsEORDER_NOT_FOUND()
     AND methodReturnsTrueIncorrectly())
  )
END FUNCTION
```

### Examples

**Bug 1: Hardcoded Symbol**
- Call `adapter.place_limit_order('ETH/USD', 'buy', 2000, 1.0)`
- Expected: Order placed on ETH/USD market
- Actual: Order placed on BTC/USD market (symbol overridden)

**Bug 2: Hardcoded Builder Address**
- Construct adapter with custom builder address `0x1234...`
- Call `adapter.approveBuilderFee(10)`
- Expected: Approves fee for custom builder address
- Actual: Approves fee for hardcoded address `0x5eefc...`

**Bug 3: Builder Address Format**
- Provide builder address `0x8c967e73e7b15087c42a10d344cff4c96d877f1d` (42 chars)
- Call `adapter.place_limit_order('BTC/USD', 'buy', 95000, 0.1)`
- Expected: Order placed successfully
- Actual: Decibel API returns "Invalid builder address" error

**Bug 4: Fake Order ID**
- Call `adapter.place_limit_order('BTC/USD', 'buy', 95000, 0.1)`
- Decibel returns `{ orderId: 'abc123', hash: '0xdef456' }`
- Expected: Returns `'abc123'`
- Actual: Returns `'decibel-order-1234567890'`
- Then call `adapter.cancel_order('decibel-order-1234567890', 'BTC/USD')`
- Expected: Order cancelled
- Actual: Cancel fails (order ID doesn't exist)

**Bug 5: Unused Code**
- Compile TypeScript: `npm run build`
- Expected: No warnings
- Actual: Warnings about unused `amountToChainUnits`, unused `symbol` and `limit` parameters

**Bug 6: Missing Error Handling**
- Decibel API returns `{ success: true }` (no orderId field)
- Expected: Error thrown with message "No order ID in response"
- Actual: Returns fake order ID, no validation

**Bug 7: Incorrect Error Handling in cancel_all_orders**
- Call `adapter.cancel_all_orders('BTC/USD')` when there are open orders
- Decibel API returns EORDER_NOT_FOUND error (possibly due to incorrect parameters)
- Expected: Method investigates the error, retries with correct parameters, or returns `false`
- Actual: Method catches error, logs "no open orders (already filled/cancelled)", returns `true`
- Then call `adapter.get_open_orders('BTC/USD')`
- Expected: Empty array (since cancel_all_orders returned `true`)
- Actual: Still shows open orders, breaking the contract

## Expected Behavior

### Preservation Requirements

**Unchanged Behaviors:**
- All existing method signatures must remain the same (no breaking changes to public API)
- Order placement, cancellation, and querying must continue to work for BTC/USD market
- Position and balance queries must return the same data structures
- Orderbook subscription mechanism must continue to work
- WebSocket error handling must remain unchanged
- Gas price manager initialization must remain unchanged
- Debug mode logging must continue to work

**Scope:**
All inputs that do NOT involve the seven specific bugs should be completely unaffected by this fix. This includes:
- Existing BTC/USD trading functionality
- Read-only operations (get_position, get_balance, get_orderbook)
- WebSocket subscriptions and caching
- Gas station integration
- Debug logging

## Hypothesized Root Cause

Based on the bug description and code analysis, the root causes are:

1. **Development Shortcuts**: The code was initially developed and tested only with BTC/USD market, so symbols were hardcoded for convenience. The builder address was similarly hardcoded during initial testing.

2. **Incomplete Decibel API Integration**: The developer may not have been aware of Decibel's requirement for 64-hex-character addresses, or the requirement was added later in the SDK.

3. **Incomplete Response Handling**: The `place_limit_order` method logs the response but doesn't extract the order ID, suggesting the response structure wasn't fully understood or the extraction logic was planned but not implemented.

4. **Incremental Development**: The fake order ID (`"decibel-order-" + Date.now()`) was likely a temporary placeholder during development that was never replaced with real extraction logic.

5. **Stub Methods**: Methods like `get_orderbook_depth` and `get_recent_trades` were stubbed out with the intention of implementing them later, but the unused parameters weren't prefixed with underscore to suppress warnings.

6. **Dead Code**: The `amountToChainUnits` method was likely replaced by the more flexible `toChainSize` and `toChainPrice` methods but never removed.

7. **Overly Permissive Error Handling**: The `cancel_all_orders` method was designed to be "forgiving" by treating EORDER_NOT_FOUND as success, but this masks real issues where the API call fails due to incorrect parameters (wrong market identifier, timing issues, etc.) while orders actually exist.

## Correctness Properties

Property 1: Bug Condition - Multi-Market Support

_For any_ method call where a symbol parameter is provided (getMarketConfig, get_mark_price, place_limit_order), the fixed adapter SHALL use the provided symbol parameter without overriding it, enabling trading on any market supported by Decibel DEX.

**Validates: Requirements 2.1, 2.2, 2.3**

Property 2: Bug Condition - Configurable Builder Address

_For any_ adapter instance where a builder address is provided to the constructor, the fixed adapter SHALL use that configured builder address in all API calls (approveBuilderFee, place_limit_order) instead of hardcoded values.

**Validates: Requirements 2.4, 2.5, 2.6**

Property 3: Bug Condition - Proper Address Padding

_For any_ builder address provided to the constructor, the fixed adapter SHALL pad the address to 64 hex characters (66 total with 0x prefix) using leading zeros, ensuring compliance with Decibel API requirements.

**Validates: Requirements 2.7, 2.8**

Property 4: Bug Condition - Real Order ID Extraction

_For any_ successful order placement, the fixed adapter SHALL extract and return the real order ID from the Decibel API response (checking orderId, order_id, or hash fields), enabling proper order tracking and cancellation.

**Validates: Requirements 2.9, 2.10**

Property 5: Bug Condition - Clean Code

_For any_ TypeScript compilation, the fixed adapter SHALL not produce warnings about unused code, with unused methods removed and stub method parameters prefixed with underscore.

**Validates: Requirements 2.11, 2.12**

Property 6: Bug Condition - Proper Error Handling

_For any_ order placement response, the fixed adapter SHALL validate that an order ID exists in the response and throw a descriptive error if missing, preventing silent failures.

**Validates: Requirements 2.13, 2.14**

Property 7: Bug Condition - Correct cancel_all_orders Behavior

_For any_ call to cancel_all_orders, the fixed adapter SHALL only return `true` when orders are actually cancelled or when there are genuinely no open orders to cancel, and SHALL properly investigate EORDER_NOT_FOUND errors rather than treating them as automatic success.

**Validates: Requirements 2.15, 2.16**

Property 8: Preservation - Existing Functionality

_For any_ method call that does NOT involve the six specific bugs (e.g., get_position, get_balance, get_orderbook, cancel_order with valid ID), the fixed adapter SHALL produce exactly the same behavior as the original adapter, preserving all existing functionality.

**Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8, 3.9**

## Fix Implementation

### Changes Required

Assuming our root cause analysis is correct:

**File**: `src/adapters/decibel_adapter.ts`

**Function**: Multiple functions need changes

**Specific Changes**:

1. **Add Builder Address to Constructor**:
   - Add `builderAddr: string` parameter to constructor
   - Add `builderFeeBps: number = 10` parameter with default value
   - Store padded builder address as instance variable `this.builderAddr`
   - Store builder fee as instance variable `this.builderFeeBps`

2. **Implement Address Padding Method**:
   - Add private method `padAddress(addr: string): string`
   - Remove `0x` prefix if present
   - Validate hex string length (must be <= 64 chars)
   - Pad with leading zeros to 64 characters
   - Return with `0x` prefix

3. **Fix Hardcoded Symbols**:
   - In `getMarketConfig()`: Remove line `symbol = "BTC/USD"`
   - In `get_mark_price()`: Remove line `symbol = "BTC/USD"`
   - In `place_limit_order()`: Change `marketName: "BTC/USD"` to `marketName: symbol`

4. **Fix Hardcoded Builder Address**:
   - In `approveBuilderFee()`: Change hardcoded address to `this.builderAddr`
   - In `place_limit_order()`: Change hardcoded address to `this.builderAddr`
   - In `place_limit_order()`: Change hardcoded fee `10` to `this.builderFeeBps`

5. **Fix Fake Order ID**:
   - In `place_limit_order()`: After successful API call, extract order ID from result
   - Check fields in order: `result.orderId`, `result.order_id`, `result.hash`
   - If no order ID found, throw error with response structure
   - Return the extracted order ID

6. **Remove Unused Code**:
   - Delete `amountToChainUnits()` method (replaced by `toChainSize` and `toChainPrice`)
   - In `get_orderbook_depth()`: Rename parameters to `_symbol` and `_limit`
   - In `get_recent_trades()`: Rename parameters to `_symbol` and `_limit`

7. **Fix cancel_all_orders Error Handling**:
   - In `cancel_all_orders()`: Remove the EORDER_NOT_FOUND catch block that treats the error as success
   - Add proper error investigation: check if orders actually exist before attempting cancellation
   - Only return `true` when orders are actually cancelled or when verified no orders exist
   - Consider adding retry logic or parameter validation to address root cause of EORDER_NOT_FOUND

8. **Update Constructor Calls**:
   - Update all places where `DecibelAdapter` is instantiated to pass builder address
   - This includes test files and scripts

### Implementation Pseudocode

```typescript
// 1. Constructor changes
constructor(
    privateKey: string,
    nodeApiKey: string,
    subaccountAddr: string,
    builderAddr: string,           // NEW
    builderFeeBps: number = 10,    // NEW with default
    gasStationApiKey?: string
) {
    this.subaccountAddr = subaccountAddr;
    this.builderAddr = this.padAddress(builderAddr);  // NEW
    this.builderFeeBps = builderFeeBps;               // NEW
    // ... rest of constructor unchanged
}

// 2. Address padding method
private padAddress(addr: string): string {
    if (!addr.startsWith('0x')) addr = '0x' + addr;
    const hex = addr.slice(2);
    if (hex.length > 64) throw new Error('Address too long');
    return '0x' + hex.padStart(64, '0');
}

// 3. Fix getMarketConfig
private async getMarketConfig(symbol: string): Promise<...> {
    // REMOVE: symbol = "BTC/USD"
    if (this._marketConfig.has(symbol)) return this._marketConfig.get(symbol)!;
    const markets = await this.read.markets.getAll();
    const m = markets?.find((m: any) => m.market_name === symbol);
    // ... rest unchanged
}

// 4. Fix get_mark_price
async get_mark_price(symbol: string): Promise<number> {
    // REMOVE: symbol = "BTC/USD"
    const markets = await this.read.markets.getAll();
    const marketInfo = markets?.find((m: any) => m.market_name === symbol);
    // ... rest unchanged
}

// 5. Fix place_limit_order
async place_limit_order(...): Promise<string> {
    const cfg = await this.getMarketConfig(symbol);
    const orderParams = {
        marketName: symbol,  // CHANGE: was "BTC/USD"
        price: this.toChainPrice(price, cfg.px_decimals),
        size: this.toChainSize(size, cfg.sz_decimals),
        isBuy: side === 'buy',
        timeInForce: TimeInForce.PostOnly,
        isReduceOnly: reduceOnly ?? false,
        builderAddr: this.builderAddr,      // CHANGE: was hardcoded
        builderFee: this.builderFeeBps,     // CHANGE: was hardcoded 10
    };
    
    // CHANGE: Extract real order ID
    const result = await this.write.placeOrder(orderParams);
    const orderId = result.orderId ?? result.order_id ?? result.hash;
    if (!orderId) {
        throw new Error('No order ID in response: ' + JSON.stringify(result));
    }
    return orderId;  // CHANGE: was fake ID
}

// 6. Fix approveBuilderFee
async approveBuilderFee(maxFeeBps: number = 10): Promise<void> {
    await this.write.approveMaxBuilderFee({
        builderAddr: this.builderAddr,  // CHANGE: was hardcoded
        maxFee: maxFeeBps,
    });
}

// 7. Remove unused method
// DELETE: private amountToChainUnits(val: number): number { ... }

// 8. Fix stub methods
async get_orderbook_depth(_symbol: string, _limit: number): Promise<...> {
    return { bids: [], asks: [] };
}

async get_recent_trades(_symbol: string, _limit: number): Promise<...> {
    return [];
}

// 7. Fix cancel_all_orders error handling
async cancel_all_orders(symbol: string): Promise<boolean> {
    try {
        // First check if there are actually open orders
        const openOrders = await this.get_open_orders(symbol);
        if (openOrders.length === 0) {
            console.log(`[Decibel] cancel_all_orders: no open orders for ${symbol}`);
            return true;
        }
        
        // Attempt to cancel orders
        await this.write.cancelBulkOrder({
            marketName: symbol,
            subaccountAddr: this.subaccountAddr,
        });
        
        console.log(`[Decibel] cancel_all_orders OK for ${symbol}`);
        return true;
    } catch (e: any) {
        const msg = e?.message ?? String(e);
        console.error(`[Decibel] cancel_all_orders FAILED for ${symbol}:`, msg);
        return false;  // CHANGE: Always return false on error, don't treat EORDER_NOT_FOUND as success
    }
}
```

## Testing Strategy

### Validation Approach

The testing strategy follows a two-phase approach: first, surface counterexamples that demonstrate the bugs on unfixed code, then verify the fixes work correctly and preserve existing behavior.

### Exploratory Bug Condition Checking

**Goal**: Surface counterexamples that demonstrate the bugs BEFORE implementing the fix. Confirm or refute the root cause analysis. If we refute, we will need to re-hypothesize.

**Test Plan**: Write tests that attempt to use non-BTC/USD markets, custom builder addresses, and verify order ID format. Run these tests on the UNFIXED code to observe failures and understand the root cause.

**Test Cases**:

1. **Hardcoded Symbol Test**: Call `place_limit_order('ETH/USD', 'buy', 2000, 1.0)` on unfixed code
   - Expected failure: Order placed on BTC/USD instead of ETH/USD
   - Confirms: Symbol parameter is overridden

2. **Hardcoded Builder Address Test**: Construct adapter with custom builder address, call `approveBuilderFee()`
   - Expected failure: Hardcoded address used instead of custom address
   - Confirms: Builder address is not configurable

3. **Builder Address Format Test**: Provide short builder address (42 chars), call `place_limit_order()`
   - Expected failure: Decibel API returns "Invalid builder address" error
   - Confirms: Address is not padded to 64 hex chars

4. **Fake Order ID Test**: Call `place_limit_order()`, then try to cancel using returned ID
   - Expected failure: Cancel fails because fake ID doesn't match real order
   - Confirms: Order ID is not extracted from response

5. **Unused Code Test**: Compile TypeScript with unfixed code
   - Expected failure: TypeScript warnings about unused code
   - Confirms: Dead code and unused parameters exist

6. **Missing Error Handling Test**: Mock Decibel API to return response without order ID field
   - Expected failure: No error thrown, fake ID returned
   - Confirms: Response validation is missing

7. **Incorrect cancel_all_orders Error Handling Test**: Mock scenario where open orders exist but cancelBulkOrder returns EORDER_NOT_FOUND
   - Expected failure: Method returns `true` despite orders remaining open
   - Confirms: Error handling treats API errors as success incorrectly

**Expected Counterexamples**:
- ETH/USD orders are placed on BTC/USD market
- Custom builder addresses are ignored
- Short builder addresses cause API errors
- Returned order IDs cannot be used for cancellation
- TypeScript compilation produces warnings
- Invalid responses are not caught
- cancel_all_orders returns `true` but orders remain open

### Fix Checking

**Goal**: Verify that for all inputs where the bug condition holds, the fixed function produces the expected behavior.

**Pseudocode:**
```
FOR ALL input WHERE isBugCondition(input) DO
  result := fixedAdapter.method(input)
  ASSERT expectedBehavior(result)
END FOR
```

**Test Cases**:

1. **Multi-Market Support**: Test placing orders on ETH/USD, APT/USD, SOL/USD
   - Assert: Orders are placed on the correct market
   - Assert: Market config is fetched for the correct symbol
   - Assert: Mark price is fetched for the correct symbol

2. **Configurable Builder Address**: Test with different builder addresses
   - Assert: Constructor accepts builder address parameter
   - Assert: Builder address is padded to 64 hex chars
   - Assert: Padded address is used in API calls

3. **Real Order ID**: Test order placement and cancellation
   - Assert: Returned order ID matches format from Decibel API
   - Assert: Order can be cancelled using returned ID
   - Assert: Error thrown if response has no order ID

4. **Clean Code**: Compile TypeScript
   - Assert: No warnings about unused code
   - Assert: All methods are either used or removed
   - Assert: Stub method parameters are prefixed with underscore

5. **Correct cancel_all_orders Behavior**: Test order cancellation scenarios
   - Assert: Method only returns `true` when orders are actually cancelled
   - Assert: Method returns `false` when cancellation fails
   - Assert: Method verifies no orders exist before claiming success

### Preservation Checking

**Goal**: Verify that for all inputs where the bug condition does NOT hold, the fixed function produces the same result as the original function.

**Pseudocode:**
```
FOR ALL input WHERE NOT isBugCondition(input) DO
  ASSERT originalAdapter.method(input) = fixedAdapter.method(input)
END FOR
```

**Testing Approach**: Property-based testing is recommended for preservation checking because:
- It generates many test cases automatically across the input domain
- It catches edge cases that manual unit tests might miss
- It provides strong guarantees that behavior is unchanged for all non-buggy inputs

**Test Plan**: Observe behavior on UNFIXED code first for non-bug scenarios, then write property-based tests capturing that behavior.

**Test Cases**:

1. **BTC/USD Trading Preservation**: Verify BTC/USD orders continue to work exactly as before
   - Test: Place, cancel, query orders on BTC/USD
   - Assert: Same behavior as unfixed code

2. **Read Operations Preservation**: Verify all read-only operations unchanged
   - Test: get_position, get_balance, get_orderbook, get_open_orders
   - Assert: Same return values and data structures

3. **WebSocket Preservation**: Verify orderbook subscription mechanism unchanged
   - Test: Subscribe to orderbook, receive updates, cache behavior
   - Assert: Same WebSocket handling and caching logic

4. **Gas Station Preservation**: Verify gas station integration unchanged
   - Test: Initialize adapter with gas station API key
   - Assert: Gas price manager initialized correctly

5. **Debug Mode Preservation**: Verify debug logging unchanged
   - Test: Enable DECIBEL_DEBUG=true, make API calls
   - Assert: Same HTTP request/response logging

### Unit Tests

- Test address padding with various input formats (with/without 0x, different lengths)
- Test order ID extraction from different response structures
- Test constructor parameter validation
- Test each bug fix in isolation with mocked Decibel SDK
- Test error cases (missing order ID, invalid address, etc.)

### Property-Based Tests

- Generate random symbols and verify they are used without override
- Generate random builder addresses and verify they are padded correctly
- Generate random order parameters and verify real order IDs are returned
- Test that all non-buggy operations produce identical results to unfixed code

### Integration Tests

- Test full order lifecycle (place, query, cancel) on multiple markets
- Test builder fee approval and order placement with custom builder address
- Test that orders can be cancelled using returned order IDs
- Test error handling when Decibel API returns unexpected responses
