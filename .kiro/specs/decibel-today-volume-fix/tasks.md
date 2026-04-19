# Implementation Plan

- [x] 1. Write bug condition exploration test
  - **Property 1: Bug Condition** - Today Volume Not Reconciled From API
  - **CRITICAL**: This test MUST FAIL on unfixed code — failure confirms the bug exists
  - **DO NOT attempt to fix the test or the code when it fails**
  - **NOTE**: This test encodes the expected behavior — it will validate the fix when it passes after implementation
  - **GOAL**: Surface counterexamples that demonstrate that `todayVolume` stays 0 even when the Decibel API has trades for today
  - **Scoped PBT Approach**: Scope the property to the concrete failing cases — bot restart scenario and missed fill scenario
  - Create test file at `src/adapters/__tests__/decibel-today-volume-bug.test.ts`
  - **Restart Scenario**: Reset `sharedState.todayVolume = 0`, create a mock `DecibelAdapter` with `getTodayVolumeFromAPI` returning `50000`. Assert that without the fix, `todayVolume` stays 0 after startup (no reconciliation call exists on unfixed code)
  - **Missed Fill Scenario**: Simulate 3 trades in mock API totalling `$15,000`. Never call `addTodayVolume`. Assert `todayVolume` is 0 without fix
  - **Periodic Gap Scenario**: Advance mock time by 6 minutes. Assert that without the fix, `todayVolume` is not updated from the API
  - The test assertions should match the Expected Behavior from design: `sharedState.todayVolume = SUM(size * price FOR trade IN API WHERE isToday(trade))`
  - Run test on UNFIXED code
  - **EXPECTED OUTCOME**: Test FAILS (this is correct — it proves the bug exists: no `getTodayVolumeFromAPI` method on `DecibelAdapter`, no `reconcileTodayVolume` call in `Watcher.run()` or `_tick()`)
  - Document counterexamples found (e.g., "`sharedState.todayVolume` remains 0 even when mock API returns $50,000 in trades for today")
  - Mark task complete when test is written, run, and failure is documented
  - _Requirements: 1.1, 1.2, 1.3_

- [x] 2. Write preservation property tests (BEFORE implementing fix)
  - **Property 2: Preservation** - Non-Buggy Input Behavior Unchanged
  - **IMPORTANT**: Follow observation-first methodology — observe behavior on UNFIXED code first, then write tests
  - Create test file at `src/adapters/__tests__/decibel-today-volume-preservation.test.ts`
  - **Observe on unfixed code**:
    - `addTodayVolume(5000)` increments `sharedState.todayVolume` by 5000
    - With a Sodex/Dango adapter (no `getTodayVolumeFromAPI`), `todayVolume` is unchanged by any reconciliation attempt
    - When `todayVolumeDate` changes to a new day, `addTodayVolume` resets `todayVolume` to 0 before accumulating
    - When API throws, `todayVolume` retains its last known value
  - **Write property-based tests capturing observed behavior**:
    - For all non-zero `addTodayVolume` call sequences, `todayVolume` equals the running sum (real-time fill accumulation preserved)
    - For all non-Decibel adapters (no `getTodayVolumeFromAPI` method), `reconcileTodayVolume()` is a no-op and `todayVolume` is unchanged
    - For all UTC-day boundary crossings, `todayVolume` resets to 0 before new day accumulation
    - For all API error scenarios, `todayVolume` retains its pre-error value (not reset to 0)
    - `StateStore.loadState()` still restores `todayVolume` from `bot_state.json` as the initial baseline
  - Verify tests PASS on UNFIXED code (confirms baseline behavior to preserve)
  - Mark task complete when tests are written, run, and passing on unfixed code
  - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5_

- [x] 3. Fix: Decibel today volume API reconciliation

  - [x] 3.1 Add `getTodayVolumeFromAPI()` to `DecibelAdapter` in `src/adapters/decibel_adapter.ts`
    - Compute UTC day boundaries: `todayStartMs = start of current UTC day in ms`, `tomorrowStartMs = todayStartMs + 86400000`
    - Call `this.read.userTradeHistory.getByAddr({ subAddr: this.subaccountAddr, limit: 200 })`
    - Extract items array from response (handle `{ items, total_count }` and direct array formats)
    - Filter items where `item.transaction_unix_ms >= todayStartMs && item.transaction_unix_ms < tomorrowStartMs`
    - Sum `item.size * item.price` for filtered items
    - Handle pagination: if `total_count > 200`, make additional calls with `offset` increments of 200 until all pages are fetched
    - Wrap entire method in try/catch — on error, re-throw so caller can decide to keep existing value
    - Return the computed sum as a `number`
    - _Bug_Condition: isBugCondition(X) where X.tradesExistInAPI AND (X.botRestartedMidDay OR X.fillsMissed)_
    - _Expected_Behavior: sharedState.todayVolume = SUM(size * price FOR trade IN API WHERE transaction_unix_ms in current UTC day)_
    - _Preservation: Non-Decibel adapters are unaffected; method is Decibel-specific_
    - _Requirements: 2.1, 2.2, 2.3_

  - [x] 3.2 Add `reconcileTodayVolume()` to `Watcher` in `src/modules/Watcher.ts`
    - Add private field `_lastVolumeReconcileAt: number = 0` to the `Watcher` class
    - Add `async reconcileTodayVolume(): Promise<void>` method
    - Duck-type check: `if (typeof (this.adapter as any).getTodayVolumeFromAPI !== 'function') return;`
    - Call `const apiVolume = await (this.adapter as any).getTodayVolumeFromAPI()`
    - Update `sharedState.todayVolume = apiVolume` (and `this._botSharedState.todayVolume = apiVolume` if multi-bot)
    - Use `this._setState({ todayVolume: apiVolume })` pattern consistent with existing `_setState` usage
    - Wrap in try/catch — on error, log a warning via `this._logEvent('WARN', ...)` and return without resetting volume
    - Update `this._lastVolumeReconcileAt = Date.now()` on success
    - _Requirements: 2.1, 2.2, 3.3, 3.5_

  - [x] 3.3 Call `reconcileTodayVolume()` on startup in `Watcher.run()`
    - In `run()`, after `this._setState({ botStatus: 'RUNNING' })` and before the `while (this.isRunning)` loop
    - Add `await this.reconcileTodayVolume()` to establish accurate baseline before first tick
    - Log the result: `this._logEvent('INFO', \`Today volume reconciled from API: $\${sharedState.todayVolume.toFixed(2)}\`)`
    - _Requirements: 2.1, 3.4_

  - [x] 3.4 Call `reconcileTodayVolume()` periodically in `Watcher._tick()`
    - In `_tick()`, after the market data fetch block (after `get_mark_price`, `get_balance`, `get_position`)
    - Check: `if (Date.now() - this._lastVolumeReconcileAt > 5 * 60 * 1000)` (5 minutes)
    - If elapsed, call `await this.reconcileTodayVolume()` (fire-and-forget is acceptable; await is preferred for correctness)
    - Place this check before the state machine routing (`switch (this.botState)`)
    - _Requirements: 2.2, 2.3_

  - [x] 3.5 Verify bug condition exploration test now passes
    - **Property 1: Expected Behavior** - Today Volume Reconciled From API
    - **IMPORTANT**: Re-run the SAME test from task 1 — do NOT write a new test
    - The test from task 1 encodes the expected behavior: `todayVolume` equals API sum after reconciliation
    - Run bug condition exploration test from step 1
    - **EXPECTED OUTCOME**: Test PASSES (confirms bug is fixed — `getTodayVolumeFromAPI` exists and `reconcileTodayVolume` is called on startup and periodically)
    - _Requirements: 2.1, 2.2, 2.3_

  - [x] 3.6 Verify preservation tests still pass
    - **Property 2: Preservation** - Non-Buggy Input Behavior Unchanged
    - **IMPORTANT**: Re-run the SAME tests from task 2 — do NOT write new tests
    - Run preservation property tests from step 2
    - **EXPECTED OUTCOME**: Tests PASS (confirms no regressions — real-time fills, UTC resets, non-Decibel adapters, API error handling all unchanged)
    - Confirm all tests still pass after fix (no regressions)

- [x] 4. Checkpoint — Ensure all tests pass
  - Run the full test suite: `npx vitest run src/adapters/__tests__/decibel-today-volume-bug.test.ts src/adapters/__tests__/decibel-today-volume-preservation.test.ts`
  - Verify Property 1 (bug condition) test passes — confirms fix works
  - Verify Property 2 (preservation) tests pass — confirms no regressions
  - Verify existing Decibel adapter tests still pass: `npx vitest run src/adapters/__tests__/`
  - Ensure all tests pass; ask the user if questions arise
