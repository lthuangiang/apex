# Implementation Plan

- [x] 1. Write bug condition exploration test
  - **Property 1: Bug Condition** - Default maxLoss, Missing Session Reset, Missing Start/Stop Message Info
  - **CRITICAL**: This test MUST FAIL on unfixed code - failure confirms the bugs exist
  - **DO NOT attempt to fix the test or the code when it fails**
  - **NOTE**: This test encodes the expected behavior - it will validate the fix when it passes after implementation
  - **GOAL**: Surface counterexamples that demonstrate all four defects exist
  - **Scoped PBT Approach**: Scope each assertion to the concrete failing case to ensure reproducibility
  - Test 1 — Default maxLoss: `new SessionManager()` → assert `getState().maxLoss === 5` (Bug Condition: `sessionManagerState.maxLoss === 50`)
  - Test 2 — Session Reset: Instantiate Watcher, manually set `sessionStartBalance = 100`, call `watcher.resetSession()` → assert `sessionStartBalance === null` (Bug Condition: `watcherState.sessionStartBalance != null` after restart)
  - Test 3 — Start Message: Mock `adapter.get_balance()` returning `42.5`, trigger `start_bot` handler → assert Telegram message contains `"42.5"` and `"Balance"` (Bug Condition: message does not contain 'Balance')
  - Test 4 — Stop Cooldown Message: Set `watcher.cooldownUntil = Date.now() + 120000`, trigger `stop_bot` handler → assert Telegram message contains `"cooldown"` or `"120"` (Bug Condition: `cooldownUntil != null` AND message does not contain 'cooldown')
  - Run tests on UNFIXED code
  - **EXPECTED OUTCOME**: Tests FAIL (this is correct - it proves the bugs exist)
  - Document counterexamples found (e.g., `maxLoss` is `50`, `resetSession is not a function`, stop message has no cooldown info)
  - Mark task complete when tests are written, run, and failures are documented
  - _Requirements: 1.1, 1.2, 1.3, 1.4_

- [x] 2. Write preservation property tests (BEFORE implementing fix)
  - **Property 2: Preservation** - set_max_loss, Emergency Stop, No-Cooldown Stop, Double Start Prevention
  - **IMPORTANT**: Follow observation-first methodology
  - Observe: `setMaxLoss(25)` after `startSession()` → `getState().maxLoss === 25` on unfixed code
  - Observe: `updatePnL(-51)` with default `maxLoss = 50` → returns `true` (emergency stop triggers) on unfixed code
  - Observe: `getCooldownInfo()` when `cooldownUntil = null` → returns `null` (no error) on unfixed code (note: method doesn't exist yet — skip this observation, write the test for after fix)
  - Observe: calling `startSession()` twice → second call returns `false` on unfixed code
  - Write property-based test: for any `amount` passed to `setMaxLoss(amount)`, `getState().maxLoss` always equals `Math.abs(amount)` regardless of default value
  - Write property-based test: for any `pnl <= -maxLoss`, `updatePnL(pnl)` always returns `true`
  - Write unit test: `stop_bot` handler when `cooldownUntil = null` sends message without error
  - Write unit test: second `startSession()` call returns `false`
  - Run tests on UNFIXED code (skip getCooldownInfo test until after fix)
  - **EXPECTED OUTCOME**: Tests PASS (confirms baseline behavior to preserve)
  - Mark task complete when tests are written, run, and passing on unfixed code
  - _Requirements: 3.1, 3.2, 3.3, 3.4_

- [x] 3. Fix bot start/stop improvements

  - [x] 3.1 Fix SessionManager default maxLoss
    - In `src/modules/SessionManager.ts` constructor, change `maxLoss: 50` to `maxLoss: 5`
    - Update the inline comment from `// Default $50 max loss` to `// Default $5 max loss`
    - _Bug_Condition: `new SessionManager()` → `getState().maxLoss === 50`_
    - _Expected_Behavior: `new SessionManager()` → `getState().maxLoss === 5`_
    - _Preservation: `setMaxLoss(amount)` after construction must still override the default correctly_
    - _Requirements: 2.1, 3.1_

  - [x] 3.2 Add resetSession() method to Watcher
    - In `src/modules/Watcher.ts`, add public method `resetSession()` that resets all 7 session fields:
      - `this.sessionStartBalance = null`
      - `this.sessionCurrentPnl = 0`
      - `this.sessionVolume = 0`
      - `this.recentPnLs = []`
      - `this.currentProfile = 'NORMAL'`
      - `this.cooldownUntil = null`
      - `this.lastTradeContext = null`
    - _Bug_Condition: `watcherState.sessionStartBalance != null` OR `watcherState.cooldownUntil != null` after restart_
    - _Expected_Behavior: all 7 fields return to their constructor initial values_
    - _Preservation: trading logic in `tick()`, `forceClosePosition()`, `getDetailedStatus()` must be unaffected_
    - _Requirements: 2.2, 3.2_

  - [x] 3.3 Add getCooldownInfo() method to Watcher
    - In `src/modules/Watcher.ts`, add public method `getCooldownInfo(): number | null`:
      - If `this.cooldownUntil === null` OR `Date.now() >= this.cooldownUntil`, return `null`
      - Otherwise return `Math.floor((this.cooldownUntil - Date.now()) / 1000)` (seconds remaining)
    - _Bug_Condition: `cooldownUntil != null` AND stop message does not contain cooldown info (method not exposed)_
    - _Expected_Behavior: returns remaining seconds as positive integer, or `null` when no active cooldown_
    - _Preservation: `stop_bot` when `cooldownUntil = null` must not throw_
    - _Requirements: 2.4, 3.3_

  - [x] 3.4 Fix start_bot handler in bot.ts
    - In `src/bot.ts` `start_bot` handler:
      - Fetch balance before starting: `const balance = await adapter.get_balance()`
      - After `sessionManager.startSession()` succeeds, call `watcher.resetSession()`
      - Replace the hardcoded message with a detailed one containing:
        - `💰 Account Balance: \`{balance}\``
        - `🛡️ Max Fee Loss: \`{maxLoss}\`` (read from `sessionManager.getState().maxLoss`)
        - `📈 Symbol: \`{symbol}\``
        - `🕐 Session Start: \`{startTime}\`` (use `new Date().toLocaleString()`)
    - _Bug_Condition: message does not contain 'Balance', no `watcher.resetSession()` call_
    - _Expected_Behavior: message contains balance, maxLoss, symbol, startTime; session fields are reset_
    - _Preservation: double-start guard (`isRunning` check) must remain intact_
    - _Requirements: 2.2, 2.3, 3.4_

  - [x] 3.5 Fix stop_bot handler in bot.ts
    - In `src/bot.ts` `stop_bot` handler:
      - After `watcher.stop()`, call `const cooldownSecs = watcher.getCooldownInfo()`
      - Build cooldown text: if `cooldownSecs !== null`, append `\n⏳ Cooldown active: \`{cooldownSecs}s\` remaining before next trade.`; otherwise empty string
      - Send: `"🛑 *Bot stopped.* Session terminated." + cooldownText`
    - _Bug_Condition: `cooldownUntil != null` AND message does not contain 'cooldown'_
    - _Expected_Behavior: stop message includes cooldown seconds when active; no change when cooldown is null_
    - _Preservation: stop when no cooldown active must not throw or produce malformed message_
    - _Requirements: 2.4, 3.3_

  - [x] 3.6 Verify bug condition exploration test now passes
    - **Property 1: Expected Behavior** - Default maxLoss, Session Reset, Start/Stop Message Info
    - **IMPORTANT**: Re-run the SAME tests from task 1 - do NOT write new tests
    - The tests from task 1 encode the expected behavior
    - When all four assertions pass, it confirms all four defects are fixed
    - Run bug condition exploration tests from step 1
    - **EXPECTED OUTCOME**: All tests PASS (confirms bugs are fixed)
    - _Requirements: 2.1, 2.2, 2.3, 2.4_

  - [x] 3.7 Verify preservation tests still pass
    - **Property 2: Preservation** - set_max_loss, Emergency Stop, No-Cooldown Stop, Double Start Prevention
    - **IMPORTANT**: Re-run the SAME tests from task 2 - do NOT write new tests
    - Run preservation property tests from step 2
    - **EXPECTED OUTCOME**: All tests PASS (confirms no regressions)
    - Confirm `setMaxLoss` override still works, emergency stop still triggers, no-cooldown stop is error-free, double start still rejected

- [x] 4. Checkpoint - Ensure all tests pass
  - Run the full test suite and confirm all tests pass
  - Verify no TypeScript compilation errors (`tsc --noEmit`)
  - Ask the user if any questions arise
