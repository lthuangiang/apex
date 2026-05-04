# Implementation Plan

- [x] 1. Write bug condition exploration test
  - **Property 1: Bug Condition** - Session PnL Excludes Unrealized PnL
  - **CRITICAL**: This test MUST FAIL on unfixed code - failure confirms the bug exists
  - **DO NOT attempt to fix the test or the code when it fails**
  - **NOTE**: This test encodes the expected behavior - it will validate the fix when it passes after implementation
  - **GOAL**: Surface counterexamples that demonstrate the bug exists
  - **Scoped PBT Approach**: For deterministic bugs, scope the property to the concrete failing case(s) to ensure reproducibility
  - Test that session PnL remains unchanged when a position is opened and held with unrealized PnL fluctuations
  - The test assertions should match the Expected Behavior Properties from design: session PnL should NOT fluctuate with mark price changes
  - Run test on UNFIXED code
  - **EXPECTED OUTCOME**: Test FAILS (this is correct - it proves the bug exists)
  - Document counterexamples found to understand root cause
  - Mark task complete when test is written, run, and failure is documented
  - _Requirements: 2.1, 2.2, 2.3_

- [x] 2. Write preservation property tests (BEFORE implementing fix)
  - **Property 2: Preservation** - Trade Logging and Volume Tracking
  - **IMPORTANT**: Follow observation-first methodology
  - Observe behavior on UNFIXED code for trade logging, volume tracking, and fee tracking
  - Write property-based tests capturing observed behavior patterns from Preservation Requirements
  - Property-based testing generates many test cases for stronger guarantees
  - Run tests on UNFIXED code
  - **EXPECTED OUTCOME**: Tests PASS (this confirms baseline behavior to preserve)
  - Mark task complete when tests are written, run, and passing on unfixed code
  - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5_

- [x] 3. Fix for session PnL calculation

  - [x] 3.1 Implement the fix in Watcher.ts
    - Remove `sessionStartBalance` field declaration (line ~150)
    - Remove balance-based PnL calculation in `_tick()` method (line ~290)
    - Add realized PnL accumulation in `_onExitFilled()` method: `this.sessionCurrentPnl += pnlNet` (line ~850)
    - Remove `sessionStartBalance` from `resetSession()` method (line ~1409)
    - _Bug_Condition: isBugCondition(input) where input.sessionStartBalance !== null AND sessionPnl is calculated as (balance - sessionStartBalance)_
    - _Expected_Behavior: sessionPnl is accumulated at trade close time via `this.sessionCurrentPnl += pnlNet` in _onExitFilled()_
    - _Preservation: Trade logging, volume tracking, and fee tracking remain unchanged_
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 3.1, 3.2, 3.3, 3.4, 3.5, 3.6_

  - [x] 3.2 Verify bug condition exploration test now passes
    - **Property 1: Expected Behavior** - Session PnL Excludes Unrealized PnL
    - **IMPORTANT**: Re-run the SAME test from task 1 - do NOT write a new test
    - The test from task 1 encodes the expected behavior
    - When this test passes, it confirms the expected behavior is satisfied
    - Run bug condition exploration test from step 1
    - **EXPECTED OUTCOME**: Test PASSES (confirms bug is fixed)
    - _Requirements: Expected Behavior Properties from design_

  - [x] 3.3 Verify preservation tests still pass
    - **Property 2: Preservation** - Trade Logging and Volume Tracking
    - **IMPORTANT**: Re-run the SAME tests from task 2 - do NOT write new tests
    - Run preservation property tests from step 2
    - **EXPECTED OUTCOME**: Tests PASS (confirms no regressions)
    - Confirm all tests still pass after fix (no regressions)

- [x] 4. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.
