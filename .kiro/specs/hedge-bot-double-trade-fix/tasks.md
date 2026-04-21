# Implementation Plan

- [x] 1. Write bug condition exploration test
  - **Property 1: Bug Condition** - Already-Filled Leg Receives Duplicate Order
  - **CRITICAL**: This test MUST FAIL on unfixed code — failure confirms the bug exists
  - **DO NOT attempt to fix the test or the code when it fails**
  - **NOTE**: This test encodes the expected behavior — it will validate the fix when it passes after implementation
  - **GOAL**: Surface counterexamples that demonstrate the bug exists
  - **Scoped PBT Approach**: Scope the property to the concrete failing cases: legAFilled=true OR legBFilled=true, state=OPENING
  - Test setup: mock `get_open_orders` to return `[]` for both symbols (no stale orders), mock `get_position` to return a non-null position (size > 0) for the already-filled leg and null for the other
  - Test assertion: `place_limit_order` is NOT called for the already-filled leg
  - On unfixed code, `place_limit_order` WILL be called for the already-filled leg → test fails → bug confirmed
  - Concrete cases to cover: (1) legA filled, legB not; (2) legB filled, legA not; (3) both legs filled → state transitions to WAITING_FILL without any orders
  - Run test on UNFIXED code
  - **EXPECTED OUTCOME**: Test FAILS (this is correct — it proves the bug exists)
  - Document counterexamples found (e.g., "place_limit_order called for ETH-USD even though it already has a position")
  - Mark task complete when test is written, run, and failure is documented
  - _Requirements: 2.1, 2.2, 2.3_

- [x] 2. Write preservation property tests (BEFORE implementing fix)
  - **Property 2: Preservation** - Normal OPENING Behavior Unchanged When Neither Leg Is Filled
  - **IMPORTANT**: Follow observation-first methodology
  - Observe: on unfixed code, when both `get_position` calls return null, `_tickOpening()` calls `place_limit_order` for both legs and transitions to WAITING_FILL
  - Observe: stale-order cancellation path is unchanged (open orders → cancel → return)
  - Observe: mark price fetch failure → return to IDLE (unchanged)
  - Observe: one leg placement failure → cancel successful leg → return to IDLE (unchanged)
  - Write property-based test: for any combination of mark prices where both `get_position` calls return null, `place_limit_order` is called exactly twice and state transitions to WAITING_FILL
  - Verify tests pass on UNFIXED code
  - **EXPECTED OUTCOME**: Tests PASS (this confirms baseline behavior to preserve)
  - Mark task complete when tests are written, run, and passing on unfixed code
  - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5_

- [x] 3. Fix for HedgeBot double trade bug

  - [x] 3.1 Implement the fix in `_tickOpening()`
    - After the existing stale-order cancellation block (Step 1) and before fetching mark prices (Step 2), add a new position pre-check step
    - Fetch mark prices first (reuse the existing fetch), then call `get_position` for both symbols in parallel
    - Set `legAFilled = posA !== null && posA.size > 0` and `legBFilled = posB !== null && posB.size > 0`
    - If both legs are already filled: log a message, transition to WAITING_FILL, and return (no orders placed)
    - If only one leg is filled: skip `place_limit_order` for that leg; place an order only for the unfilled leg; transition to WAITING_FILL as normal
    - If `get_position` throws: log a warning and return (skip tick) — same pattern as the stale-order check failure
    - _Bug_Condition: isBugCondition(X) where X.state = 'OPENING' AND (X.legAFilled OR X.legBFilled)_
    - _Expected_Behavior: place_limit_order NOT called for already-filled leg; position size unchanged; state transitions to WAITING_FILL_
    - _Preservation: when neither leg is filled, both legs receive fresh orders and state transitions to WAITING_FILL exactly as before_
    - _Requirements: 2.1, 2.2, 2.3, 3.1, 3.2, 3.3, 3.4, 3.5_

  - [x] 3.2 Verify bug condition exploration test now passes
    - **Property 1: Expected Behavior** - Already-Filled Leg Receives Duplicate Order
    - **IMPORTANT**: Re-run the SAME test from task 1 — do NOT write a new test
    - The test from task 1 encodes the expected behavior
    - When this test passes, it confirms the expected behavior is satisfied
    - Run bug condition exploration test from step 1
    - **EXPECTED OUTCOME**: Test PASSES (confirms bug is fixed)
    - _Requirements: 2.1, 2.2, 2.3_

  - [x] 3.3 Verify preservation tests still pass
    - **Property 2: Preservation** - Normal OPENING Behavior Unchanged When Neither Leg Is Filled
    - **IMPORTANT**: Re-run the SAME tests from task 2 — do NOT write new tests
    - Run preservation property tests from step 2
    - **EXPECTED OUTCOME**: Tests PASS (confirms no regressions)
    - Confirm all tests still pass after fix (no regressions)

- [x] 4. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.
