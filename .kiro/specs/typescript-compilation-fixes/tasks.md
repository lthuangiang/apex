# Implementation Plan

- [x] 1. Write bug condition exploration test
  - **Property 1: Bug Condition** - TypeScript Compilation Failures
  - **CRITICAL**: This test MUST FAIL on unfixed code - failure confirms the bug exists
  - **DO NOT attempt to fix the test or the code when it fails**
  - **NOTE**: This test encodes the expected behavior - it will validate the fix when it passes after implementation
  - **GOAL**: Surface counterexamples that demonstrate the compilation failures exist
  - **Scoped PBT Approach**: For deterministic compilation errors, scope the property to the concrete failing files to ensure reproducibility
  - Test that TypeScript compilation fails for all 8 identified error locations from Bug Condition in design
  - The test assertions should match the Expected Behavior Properties from design (successful compilation)
  - Run test on UNFIXED code
  - **EXPECTED OUTCOME**: Test FAILS (this is correct - it proves the compilation errors exist)
  - Document counterexamples found to understand root cause of each compilation error
  - Mark task complete when test is written, run, and failure is documented
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8_

- [x] 2. Write preservation property tests (BEFORE implementing fix)
  - **Property 2: Preservation** - Non-Buggy File Compilation
  - **IMPORTANT**: Follow observation-first methodology
  - Observe behavior on UNFIXED code for files that currently compile successfully
  - Write property-based tests capturing observed behavior patterns from Preservation Requirements
  - Property-based testing generates many test cases for stronger guarantees
  - Run tests on UNFIXED code
  - **EXPECTED OUTCOME**: Tests PASS (this confirms baseline behavior to preserve)
  - Mark task complete when tests are written, run, and passing on unfixed code
  - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7_

- [x] 3. Fix TypeScript compilation errors

  - [x] 3.1 Fix AdapterRegistry.ts export declaration conflict
    - Resolve duplicate AdapterRegistryEvents export declarations
    - Ensure only one export declaration exists for each interface
    - _Bug_Condition: isBugCondition(input) where input.hasExportConflicts = true_
    - _Expected_Behavior: expectedBehavior(result) from design - successful compilation_
    - _Preservation: Preservation Requirements from design - existing functionality unchanged_
    - _Requirements: 1.1, 2.1_

  - [x] 3.2 Fix EventBus.example.ts missing property and module compatibility
    - Add validateOrder method to RiskManager or update example to use existing method
    - Replace import.meta with CommonJS-compatible alternative (require.main === module)
    - _Bug_Condition: isBugCondition(input) where input.hasMissingProperties OR input.hasImportMetaInCommonJS = true_
    - _Expected_Behavior: expectedBehavior(result) from design - successful compilation_
    - _Preservation: Preservation Requirements from design - existing functionality unchanged_
    - _Requirements: 1.2, 1.3, 2.2, 2.3_

  - [x] 3.3 Fix DangoAdapterFactory.ts constructor signature mismatch
    - Review DangoAdapter constructor signature in dango_adapter.ts
    - Modify factory create method to pass correct number and type of arguments
    - _Bug_Condition: isBugCondition(input) where input.hasSignatureMismatches = true_
    - _Expected_Behavior: expectedBehavior(result) from design - successful compilation_
    - _Preservation: Preservation Requirements from design - existing functionality unchanged_
    - _Requirements: 1.4, 2.4_

  - [x] 3.4 Fix DecibelAdapterFactory.ts interface implementation
    - Ensure DecibelAdapter fully implements IExchangeAdapter interface
    - Add missing methods: exchangeName, supportedSymbols properties
    - Implement missing interface methods with proper signatures
    - _Bug_Condition: isBugCondition(input) where input.hasMissingProperties = true_
    - _Expected_Behavior: expectedBehavior(result) from design - successful compilation_
    - _Preservation: Preservation Requirements from design - existing functionality unchanged_
    - _Requirements: 1.5, 2.5_

  - [x] 3.5 Fix SodexAdapterFactory.ts interface implementation
    - Ensure SodexAdapter fully implements IExchangeAdapter interface
    - Add missing methods: exchangeName, supportedSymbols properties
    - Implement missing interface methods with proper signatures
    - _Bug_Condition: isBugCondition(input) where input.hasMissingProperties = true_
    - _Expected_Behavior: expectedBehavior(result) from design - successful compilation_
    - _Preservation: Preservation Requirements from design - existing functionality unchanged_
    - _Requirements: 1.6, 2.6_

  - [x] 3.6 Fix index.ts duplicate export declaration
    - Resolve StrategyConfig export conflict between core.ts and config.ts
    - Remove duplicate StrategyConfig export from one of the files or rename interface
    - Update imports throughout codebase to use the correct interface
    - _Bug_Condition: isBugCondition(input) where input.hasExportConflicts = true_
    - _Expected_Behavior: expectedBehavior(result) from design - successful compilation_
    - _Preservation: Preservation Requirements from design - existing functionality unchanged_
    - _Requirements: 1.7, 2.7_

  - [x] 3.7 Verify bug condition exploration test now passes
    - **Property 1: Expected Behavior** - TypeScript Compilation Success
    - **IMPORTANT**: Re-run the SAME test from task 1 - do NOT write a new test
    - The test from task 1 encodes the expected behavior
    - When this test passes, it confirms the expected behavior is satisfied
    - Run bug condition exploration test from step 1
    - **EXPECTED OUTCOME**: Test PASSES (confirms compilation errors are fixed)
    - _Requirements: Expected Behavior Properties from design - 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8_

  - [x] 3.8 Verify preservation tests still pass
    - **Property 2: Preservation** - Non-Buggy File Compilation
    - **IMPORTANT**: Re-run the SAME tests from task 2 - do NOT write new tests
    - Run preservation property tests from step 2
    - **EXPECTED OUTCOME**: Tests PASS (confirms no regressions)
    - Confirm all tests still pass after fix (no regressions)

- [x] 4. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.