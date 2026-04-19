# Implementation Plan

- [x] 1. Write bug condition exploration test
  - **Property 1: Bug Condition** - Config Isolation Between Bot Instances
  - **CRITICAL**: This test MUST FAIL on unfixed code - failure confirms the bug exists
  - **DO NOT attempt to fix the test or the code when it fails**
  - **NOTE**: This test encodes the expected behavior - it will validate the fix when it passes after implementation
  - **GOAL**: Surface counterexamples that demonstrate the global config mutation bug
  - **Scoped PBT Approach**: Scope the property to the concrete failing case — two ConfigStore instances with different FARM_MIN_HOLD_SECS values
  - Test setup:
    - Create `store1 = new ConfigStore()`, call `store1.applyOverrides({ FARM_MIN_HOLD_SECS: 120 })`
    - Create `store2 = new ConfigStore()`, call `store2.applyOverrides({ FARM_MIN_HOLD_SECS: 30 })`
    - Assert `store1.getEffective().FARM_MIN_HOLD_SECS === 120` (will FAIL — global was overwritten to 30)
    - Assert `store2.getEffective().FARM_MIN_HOLD_SECS === 30` (may pass)
    - Also test reset collision: after `store2.resetToDefaults()`, assert `store1.getEffective().FARM_MIN_HOLD_SECS === 120` (will FAIL)
  - Run test on UNFIXED code
  - **EXPECTED OUTCOME**: Test FAILS (this is correct - it proves the bug exists)
  - Document counterexamples found (e.g., `store1.getEffective().FARM_MIN_HOLD_SECS` returns `30` instead of `120`)
  - Mark task complete when test is written, run, and failure is documented
  - File: `src/config/__tests__/per-bot-config-isolation-bug.test.ts`
  - _Requirements: 1.1, 1.2, 1.3_

- [x] 2. Write preservation property tests (BEFORE implementing fix)
  - **Property 2: Preservation** - Single-Bot and Existing Behavior Unchanged
  - **IMPORTANT**: Follow observation-first methodology
  - Observe behavior on UNFIXED code for non-buggy inputs (single-bot scenarios):
    - Observe: `new ConfigStore().applyOverrides({ FARM_MIN_HOLD_SECS: 120 })` → `getEffective().FARM_MIN_HOLD_SECS === 120` ✓
    - Observe: `new ConfigStore().resetToDefaults()` → `getEffective().FARM_MIN_HOLD_SECS` equals base config value ✓
    - Observe: `Watcher` constructed without `configStore` reads global `config` directly ✓
  - Write property-based tests capturing observed behavior patterns from Preservation Requirements:
    - For all random `PartialOverride` values applied to a single `ConfigStore`, `getEffective()` returns `{ ...base, ...patch }` correctly
    - `Watcher` without `configStore` param still reads global `config` (fallback behavior)
    - `resetToDefaults()` on a single store restores base values correctly
    - `loadFromDisk()` populates `this.overrides` without mutating global config (post-fix assertion)
  - Run tests on UNFIXED code
  - **EXPECTED OUTCOME**: Tests PASS (this confirms baseline single-bot behavior to preserve)
  - Mark task complete when tests are written, run, and passing on unfixed code
  - File: `src/config/__tests__/per-bot-config-isolation-preservation.test.ts`
  - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5_

- [x] 3. Fix per-bot config isolation

  - [x] 3.1 Remove global config mutation from ConfigStore
    - In `src/config/ConfigStore.ts`, `applyOverrides()`: delete the final for-loop that writes to global `config`:
      ```
      // DELETE this block:
      const effective = this.getEffective();
      for (const key of OVERRIDABLE_KEYS) {
        (config as Record<string, unknown>)[key] = effective[key];
      }
      ```
    - In `src/config/ConfigStore.ts`, `resetToDefaults()`: delete the for-loop that restores global `config`:
      ```
      // DELETE this block:
      for (const key of OVERRIDABLE_KEYS) {
        (config as Record<string, unknown>)[key] = this.base[key];
      }
      ```
    - Keep `saveToDisk()`, `loadFromDisk()`, `getEffective()` unchanged
    - Also remove the global mutation in `loadFromDisk()` (the line `(config as Record<string, unknown>)[key] = value;`)
    - _Bug_Condition: isBugCondition(input) where input.botCount >= 2 AND overridesPerBot have different values for same key_
    - _Expected_Behavior: each ConfigStore instance's getEffective() returns its own merged values, never affected by other instances_
    - _Preservation: single-bot getEffective() still returns { ...base, ...overrides } correctly_
    - _Requirements: 2.1, 2.2, 2.3, 3.1, 3.2, 3.3_

  - [x] 3.2 Add configStore injection to Watcher
    - In `src/modules/Watcher.ts`, add optional param to constructor:
      ```typescript
      constructor(
        private adapter: ExchangeAdapter,
        symbol: string,
        private telegram: TelegramManager,
        private sessionManager: SessionManager,
        private _botSharedState?: BotSharedState,
        private _configStore?: ConfigStoreInterface,  // ADD THIS
      )
      ```
    - Add private getter `_cfg` after the constructor:
      ```typescript
      private get _cfg() {
        return this._configStore ? this._configStore.getEffective() : config;
      }
      ```
    - Replace ALL occurrences of `config.XYZ` with `this._cfg.XYZ` throughout `Watcher.ts`
      - `_computeLoopDelay`: `config.FARM_EARLY_EXIT_SECS` → `this._cfg.FARM_EARLY_EXIT_SECS`
      - `_handlePending`: `config.MODE`, `config.MODE` → `this._cfg.MODE`
      - `_handlePending`: `config.MODE === 'farm' ? 3 : 10` → `this._cfg.MODE === 'farm' ? 3 : 10`
      - `_evaluateExitConditions`: all `config.XYZ` references → `this._cfg.XYZ`
      - `_handleIdle`: all `config.XYZ` references → `this._cfg.XYZ`
      - `_handleExiting`: all `config.XYZ` references → `this._cfg.XYZ`
      - `_onEntryFilled`: `config.MODE` → `this._cfg.MODE`
      - Any other `config.XYZ` usage in the file
    - Keep `import { config } from '../config.js'` — still needed for fallback
    - _Requirements: 2.2, 3.1_

  - [x] 3.3 Pass configStore from BotInstance to Watcher
    - In `src/bot/BotInstance.ts`, update Watcher constructor call:
      ```typescript
      // BEFORE:
      this.watcher = new Watcher(adapter, config.symbol, telegram, this.sessionManager, this.state);
      // AFTER:
      this.watcher = new Watcher(adapter, config.symbol, telegram, this.sessionManager, this.state, this.configStore);
      ```
    - Note: `config.symbol` here refers to `this.config.symbol` (BotConfig), not global config
    - _Requirements: 2.1, 2.2_

  - [x] 3.4 Verify bug condition exploration test now passes
    - **Property 1: Expected Behavior** - Config Isolation Between Bot Instances
    - **IMPORTANT**: Re-run the SAME test from task 1 - do NOT write a new test
    - The test from task 1 encodes the expected behavior
    - When this test passes, it confirms each ConfigStore instance maintains independent effective config
    - Run bug condition exploration test from step 1
    - **EXPECTED OUTCOME**: Test PASSES (confirms bug is fixed)
    - _Requirements: 2.1, 2.2, 2.3_

  - [x] 3.5 Verify preservation tests still pass
    - **Property 2: Preservation** - Single-Bot and Existing Behavior Unchanged
    - **IMPORTANT**: Re-run the SAME tests from task 2 - do NOT write new tests
    - Run preservation property tests from step 2
    - **EXPECTED OUTCOME**: Tests PASS (confirms no regressions)
    - Confirm all tests still pass after fix (no regressions)

- [x] 4. Checkpoint - Ensure all tests pass
  - Run full test suite: `npx vitest run src/config/__tests__/per-bot-config-isolation-bug.test.ts src/config/__tests__/per-bot-config-isolation-preservation.test.ts`
  - Also run existing ConfigStore tests to confirm no regression: `npx vitest run src/config/__tests__/`
  - Ensure all tests pass, ask the user if questions arise.
