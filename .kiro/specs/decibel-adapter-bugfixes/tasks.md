# Implementation Plan

## Phase 1: Exploration Tests (BEFORE Fix)

- [x] 1. Write bug condition exploration tests
  - **Property 1: Bug Condition** - Multi-Market Support, Configurable Builder, Address Padding, Real Order ID, Clean Code, Error Handling
  - **CRITICAL**: These tests MUST FAIL on unfixed code - failure confirms the bugs exist
  - **DO NOT attempt to fix the tests or the code when they fail**
  - **NOTE**: These tests encode the expected behavior - they will validate the fix when they pass after implementation
  - **GOAL**: Surface counterexamples that demonstrate the bugs exist
  - **Scoped PBT Approach**: For deterministic bugs, scope the property to the concrete failing case(s) to ensure reproducibility
  - Test implementation details from Bug Condition in design:
    - Bug 1: Hardcoded Symbol - Test that `place_limit_order('ETH/USD', ...)` uses ETH/USD not BTC/USD
    - Bug 2: Hardcoded Builder Address - Test that custom builder address is used in API calls
    - Bug 3: Builder Address Format - Test that short addresses are padded to 64 hex chars
    - Bug 4: Fake Order ID - Test that returned order ID can be used to cancel the order
    - Bug 5: Unused Code - Test that TypeScript compilation produces no warnings
    - Bug 6: Missing Error Handling - Test that missing order ID in response throws error
    - Bug 7: Incorrect cancel_all_orders Error Handling - Test that method only returns `true` when orders are actually cancelled
  - The test assertions should match the Expected Behavior Properties from design
  - Run tests on UNFIXED code
  - **EXPECTED OUTCOME**: Tests FAIL (this is correct - it proves the bugs exist)
  - Document counterexamples found to understand root cause
  - Mark task complete when tests are written, run, and failures are documented
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9, 1.10, 1.11, 1.12, 1.13, 1.14, 1.15, 1.16_

- [x] 2. Write preservation property tests (BEFORE implementing fix)
  - **Property 2: Preservation** - Existing Functionality Unchanged
  - **IMPORTANT**: Follow observation-first methodology
  - Observe behavior on UNFIXED code for non-buggy inputs:
    - BTC/USD trading (place, cancel, query orders)
    - Read operations (get_position, get_balance, get_orderbook, get_open_orders)
    - WebSocket subscriptions and caching
    - Gas station integration
    - Debug mode logging
  - Write property-based tests capturing observed behavior patterns from Preservation Requirements
  - Property-based testing generates many test cases for stronger guarantees
  - Run tests on UNFIXED code
  - **EXPECTED OUTCOME**: Tests PASS (this confirms baseline behavior to preserve)
  - Mark task complete when tests are written, run, and passing on unfixed code
  - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8, 3.9_

## Phase 2: Implementation

- [x] 3. Fix Decibel Adapter Bugs

  - [x] 3.1 Add builder address configuration to constructor
    - Add `builderAddr: string` parameter to constructor
    - Add `builderFeeBps: number = 10` parameter with default value
    - Store padded builder address as instance variable `this.builderAddr`
    - Store builder fee as instance variable `this.builderFeeBps`
    - _Bug_Condition: isBugCondition(input) where input.method IN ['approveBuilderFee', 'place_limit_order'] AND codeUsesHardcodedBuilderAddress()_
    - _Expected_Behavior: Constructor accepts builder address and fee parameters, stores padded address_
    - _Preservation: Constructor signature changes but existing functionality preserved_
    - _Requirements: 2.4, 2.5, 2.6_

  - [x] 3.2 Implement address padding method
    - Add private method `padAddress(addr: string): string`
    - Remove `0x` prefix if present
    - Validate hex string length (must be <= 64 chars)
    - Pad with leading zeros to 64 characters
    - Return with `0x` prefix
    - _Bug_Condition: isBugCondition(input) where builderAddress.length != 66 AND NOT isPaddedTo64HexChars(builderAddress)_
    - _Expected_Behavior: Builder addresses are padded to 64 hex chars (66 total with 0x prefix)_
    - _Preservation: New method, no impact on existing functionality_
    - _Requirements: 2.7, 2.8_

  - [x] 3.3 Remove hardcoded symbols
    - In `getMarketConfig()`: Remove line `symbol = "BTC/USD"`
    - In `get_mark_price()`: Remove line `symbol = "BTC/USD"`
    - In `place_limit_order()`: Change `marketName: "BTC/USD"` to `marketName: symbol`
    - _Bug_Condition: isBugCondition(input) where input.method IN ['getMarketConfig', 'get_mark_price', 'place_limit_order'] AND input.params.symbol != 'BTC/USD' AND codeOverridesSymbolParameter()_
    - _Expected_Behavior: Symbol parameter is used as provided, enabling multi-market trading_
    - _Preservation: BTC/USD trading continues to work exactly as before_
    - _Requirements: 2.1, 2.2, 2.3_

  - [x] 3.4 Use configured builder address in API calls
    - In `approveBuilderFee()`: Change hardcoded address to `this.builderAddr`
    - In `place_limit_order()`: Change hardcoded address to `this.builderAddr`
    - In `place_limit_order()`: Change hardcoded fee `10` to `this.builderFeeBps`
    - _Bug_Condition: isBugCondition(input) where input.method IN ['approveBuilderFee', 'place_limit_order'] AND codeUsesHardcodedBuilderAddress()_
    - _Expected_Behavior: Configured builder address and fee are used in all API calls_
    - _Preservation: Existing API call behavior preserved, just using configurable values_
    - _Requirements: 2.4, 2.5, 2.6_

  - [x] 3.5 Extract real order ID from response
    - In `place_limit_order()`: After successful API call, extract order ID from result
    - Check fields in order: `result.orderId`, `result.order_id`, `result.hash`
    - If no order ID found, throw error with response structure
    - Return the extracted order ID
    - _Bug_Condition: isBugCondition(input) where input.method == 'place_limit_order' AND orderPlacedSuccessfully() AND returnedOrderId.startsWith('decibel-order-')_
    - _Expected_Behavior: Real order ID extracted from response, enabling proper order tracking_
    - _Preservation: Order placement continues to work, now with real IDs_
    - _Requirements: 2.9, 2.10, 2.13, 2.14_

  - [x] 3.6 Remove unused code and fix parameter warnings
    - Delete `amountToChainUnits()` method (replaced by `toChainSize` and `toChainPrice`)
    - In `get_orderbook_depth()`: Rename parameters to `_symbol` and `_limit`
    - In `get_recent_trades()`: Rename parameters to `_symbol` and `_limit`
    - _Bug_Condition: isBugCondition(input) where input.method == 'compile' AND (unusedMethodExists('amountToChainUnits') OR unusedParametersExist(['symbol', 'limit']))_
    - _Expected_Behavior: TypeScript compilation produces no warnings about unused code_
    - _Preservation: Stub methods continue to return same values, just with clean parameters_
    - _Requirements: 2.11, 2.12_

  - [x] 3.7 Fix cancel_all_orders error handling
    - Remove the EORDER_NOT_FOUND catch block that treats the error as success
    - Add proper verification: check if orders actually exist before attempting cancellation
    - Only return `true` when orders are actually cancelled or when verified no orders exist
    - Always return `false` on API errors instead of treating them as success
    - _Bug_Condition: isBugCondition(input) where input.method == 'cancel_all_orders' AND openOrdersExist(input.params.symbol) AND apiReturnsEORDER_NOT_FOUND() AND methodReturnsTrueIncorrectly()_
    - _Expected_Behavior: Method only returns `true` when orders are actually cancelled or genuinely no orders exist_
    - _Preservation: Existing cancellation behavior preserved, just with correct error handling_
    - _Requirements: 2.15, 2.16_

  - [x] 3.8 Update constructor calls in tests and scripts
    - Update `src/scripts/test-decibel.ts` to pass builder address
    - Update `src/adapters/__tests__/decibel_adapter.test.ts` to pass builder address
    - Update any other files that instantiate `DecibelAdapter`
    - Use default builder address: `0x5eefc26ee8f0b537717e57718a9a0c365e32081d96dc618a56041b3b7ff31ed5`
    - _Bug_Condition: Constructor signature changed, all instantiations must be updated_
    - _Expected_Behavior: All existing code continues to work with new constructor signature_
    - _Preservation: Existing test and script functionality preserved_
    - _Requirements: 2.4_

  - [x] 3.9 Verify bug condition exploration tests now pass
    - **Property 1: Expected Behavior** - Multi-Market Support, Configurable Builder, Address Padding, Real Order ID, Clean Code, Error Handling, Correct cancel_all_orders Behavior
    - **IMPORTANT**: Re-run the SAME tests from task 1 - do NOT write new tests
    - The tests from task 1 encode the expected behavior
    - When these tests pass, it confirms the expected behavior is satisfied
    - Run bug condition exploration tests from step 1
    - **EXPECTED OUTCOME**: Tests PASS (confirms bugs are fixed)
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 2.9, 2.10, 2.11, 2.12, 2.13, 2.14, 2.15, 2.16_

  - [x] 3.10 Verify preservation tests still pass
    - **Property 2: Preservation** - Existing Functionality Unchanged
    - **IMPORTANT**: Re-run the SAME tests from task 2 - do NOT write new tests
    - Run preservation property tests from step 2
    - **EXPECTED OUTCOME**: Tests PASS (confirms no regressions)
    - Confirm all tests still pass after fix (no regressions)
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8, 3.9_

## Phase 3: Validation

- [x] 4. Checkpoint - Ensure all tests pass
  - Run full test suite: `npm test`
  - Verify TypeScript compilation: `npm run build`
  - Ensure no TypeScript warnings about unused code
  - Verify all bug condition tests pass (multi-market, builder address, order ID, etc.)
  - Verify all preservation tests pass (BTC/USD trading, read operations, WebSocket, etc.)
  - If any issues arise, investigate and fix before marking complete
