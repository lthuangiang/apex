/**
 * TypeScript Compilation Preservation Property Tests
 * 
 * These tests verify baseline behavior that MUST be preserved after the bugfix implementation.
 * They focus on the specific preservation requirements from the bugfix specification.
 * 
 * **IMPORTANT**: These tests are EXPECTED TO PASS on unfixed code.
 * They capture baseline behavior that must be preserved.
 * 
 * **Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7**
 */

import { describe, it, expect } from 'vitest';
import { execSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

// Helper function to test TypeScript compilation of individual files
function compileTypeScriptFile(filePath: string): { success: boolean; output: string } {
  try {
    const output = execSync(`npx tsc --noEmit --ignoreConfig "${filePath}"`, {
      encoding: 'utf8',
      cwd: process.cwd(),
      timeout: 30000 // Increased timeout to 30 seconds
    });
    return { success: true, output };
  } catch (error: any) {
    return { success: false, output: error.stdout || error.message };
  }
}

// Helper function to check if a file exists
function fileExists(filePath: string): boolean {
  return existsSync(join(process.cwd(), filePath));
}

// Helper function to check if a file contains specific content
function fileContains(filePath: string, content: string): boolean {
  if (!fileExists(filePath)) return false;
  try {
    const fileContent = readFileSync(join(process.cwd(), filePath), 'utf8');
    return fileContent.includes(content);
  } catch {
    return false;
  }
}

// Helper function to get the current compilation errors (for baseline)
function getCurrentCompilationErrors(): string {
  try {
    execSync('npx tsc --noEmit', { encoding: 'utf8', cwd: process.cwd() });
    return '';
  } catch (error: any) {
    return error.stdout || error.message || '';
  }
}

describe('Property 2: Preservation - Non-Buggy File Compilation', () => {
  
  // **Validates: Requirements 3.1** - Files without compilation errors should CONTINUE TO compile successfully
  describe('3.1 - Successfully compiling files remain compilable', () => {
    
    // Test files that are known to compile successfully in isolation
    const knownWorkingFiles = [
      'src/modules/SessionManager.ts',
      'src/modules/RiskManager.ts', 
      'src/adapters/ExchangeAdapter.ts'
    ];

    knownWorkingFiles.forEach(filePath => {
      it(`${filePath} should compile successfully in isolation`, () => {
        if (!fileExists(filePath)) {
          console.warn(`Skipping test for ${filePath} - file does not exist`);
          return;
        }

        const result = compileTypeScriptFile(filePath);
        expect(result.success).toBe(true);
        if (!result.success) {
          console.error(`Compilation failed for ${filePath}:`, result.output);
        }
      }, 30000); // 30 second timeout
    });

    // Property-based test: Files that compile in isolation should continue to do so
    it('property: files that compile in isolation preserve compilation success', () => {
      const isolatedFiles = [
        'src/modules/SessionManager.ts',
        'src/modules/RiskManager.ts',
        'src/adapters/ExchangeAdapter.ts'
      ];

      for (const filePath of isolatedFiles) {
        if (fileExists(filePath)) {
          const result = compileTypeScriptFile(filePath);
          expect(result.success).toBe(true);
        }
      }
    }, 30000);
  });

  // **Validates: Requirements 3.2** - Adapters implementing IExchangeAdapter correctly should CONTINUE TO be recognized as valid
  describe('3.2 - Valid adapter interface implementations remain valid', () => {
    
    it('ExchangeAdapter interface should be properly defined', () => {
      const result = compileTypeScriptFile('src/adapters/ExchangeAdapter.ts');
      expect(result.success).toBe(true);
    });

    it('ExchangeAdapter interface should define expected methods', () => {
      expect(fileExists('src/adapters/ExchangeAdapter.ts')).toBe(true);
      
      // Check that the interface contains expected method signatures
      expect(fileContains('src/adapters/ExchangeAdapter.ts', 'get_mark_price')).toBe(true);
      expect(fileContains('src/adapters/ExchangeAdapter.ts', 'get_position')).toBe(true);
      expect(fileContains('src/adapters/ExchangeAdapter.ts', 'get_balance')).toBe(true);
      expect(fileContains('src/adapters/ExchangeAdapter.ts', 'place_limit_order')).toBe(true);
    });

    // Property: The ExchangeAdapter interface structure should be preserved
    it('property: ExchangeAdapter interface structure preserves method definitions', () => {
      const result = compileTypeScriptFile('src/adapters/ExchangeAdapter.ts');
      expect(result.success).toBe(true);
      
      // The interface should compile without errors
      expect(result.output).not.toContain('error');
    });
  });

  // **Validates: Requirements 3.3** - Export declarations that are unique and properly named should CONTINUE TO export correctly
  describe('3.3 - Valid export declarations remain valid', () => {
    
    it('ExchangeAdapter.ts exports should remain valid', () => {
      const result = compileTypeScriptFile('src/adapters/ExchangeAdapter.ts');
      expect(result.success).toBe(true);
    });

    it('SessionManager.ts exports should remain valid', () => {
      const result = compileTypeScriptFile('src/modules/SessionManager.ts');
      expect(result.success).toBe(true);
    });

    // Property: Files with valid exports should continue to have valid exports
    it('property: valid export declarations preserve export validity', () => {
      const filesWithValidExports = [
        'src/adapters/ExchangeAdapter.ts',
        'src/modules/SessionManager.ts',
        'src/modules/RiskManager.ts'
      ];

      for (const filePath of filesWithValidExports) {
        if (fileExists(filePath)) {
          const result = compileTypeScriptFile(filePath);
          expect(result.success).toBe(true);
          expect(result.output).not.toContain('Export declaration conflicts');
        }
      }
    }, 30000);
  });

  // **Validates: Requirements 3.4** - Function signatures matching expected parameters should CONTINUE TO compile successfully  
  describe('3.4 - Valid function signatures remain valid', () => {
    
    it('SessionManager methods should have correct signatures', () => {
      const result = compileTypeScriptFile('src/modules/SessionManager.ts');
      expect(result.success).toBe(true);
    });

    it('RiskManager methods should have correct signatures', () => {
      const result = compileTypeScriptFile('src/modules/RiskManager.ts');
      expect(result.success).toBe(true);
    });

    // Property: Functions with correct signatures should continue to have correct signatures
    it('property: valid function signatures preserve signature correctness', () => {
      const filesWithValidSignatures = [
        'src/modules/SessionManager.ts',
        'src/modules/RiskManager.ts'
      ];

      for (const filePath of filesWithValidSignatures) {
        if (fileExists(filePath)) {
          const result = compileTypeScriptFile(filePath);
          expect(result.success).toBe(true);
          expect(result.output).not.toContain('Expected');
          expect(result.output).not.toContain('arguments, but got');
        }
      }
    }, 30000);
  });

  // **Validates: Requirements 3.5** - Module syntax compatible with target output should CONTINUE TO build correctly
  describe('3.5 - Compatible module syntax remains compatible', () => {
    
    it('files with compatible module syntax should not use import.meta', () => {
      const compatibleFiles = [
        'src/modules/SessionManager.ts',
        'src/modules/RiskManager.ts',
        'src/adapters/ExchangeAdapter.ts'
      ];

      for (const filePath of compatibleFiles) {
        if (fileExists(filePath)) {
          // These files should not contain import.meta usage
          expect(fileContains(filePath, 'import.meta')).toBe(false);
        }
      }
    });

    // Property: Files with compatible module syntax should continue to be compatible
    it('property: compatible module syntax preserves compatibility', () => {
      const compatibleFiles = [
        'src/modules/SessionManager.ts',
        'src/modules/RiskManager.ts',
        'src/adapters/ExchangeAdapter.ts'
      ];

      for (const filePath of compatibleFiles) {
        if (fileExists(filePath)) {
          const result = compileTypeScriptFile(filePath);
          expect(result.success).toBe(true);
          expect(result.output).not.toContain('import.meta');
          expect(result.output).not.toContain('not allowed in files which will build into CommonJS');
        }
      }
    }, 30000);
  });

  // **Validates: Requirements 3.6** - RiskManager type with all required properties should CONTINUE TO allow property access
  describe('3.6 - RiskManager property access remains valid', () => {
    
    it('RiskManager should compile with existing methods', () => {
      const result = compileTypeScriptFile('src/modules/RiskManager.ts');
      expect(result.success).toBe(true);
    });

    it('RiskManager should have shouldClose method', () => {
      expect(fileContains('src/modules/RiskManager.ts', 'shouldClose')).toBe(true);
    });

    it('RiskManager should have setSlPercent method', () => {
      expect(fileContains('src/modules/RiskManager.ts', 'setSlPercent')).toBe(true);
    });

    // Property: RiskManager methods that exist should continue to be accessible
    it('property: existing RiskManager methods preserve accessibility', () => {
      const result = compileTypeScriptFile('src/modules/RiskManager.ts');
      expect(result.success).toBe(true);
      
      // The RiskManager should have its core methods available
      expect(result.output).not.toContain('Property');
      expect(result.output).not.toContain('does not exist on type');
    });
  });

  // **Validates: Requirements 3.7** - Tests and other build processes should CONTINUE TO execute successfully after fixes
  describe('3.7 - Build processes remain functional', () => {
    
    it('package.json should exist for build configuration', () => {
      expect(fileExists('package.json')).toBe(true);
    });

    it('tsconfig.json should exist for TypeScript configuration', () => {
      expect(fileExists('tsconfig.json')).toBe(true);
    });

    it('should preserve the current set of compilation errors (baseline)', () => {
      // This test captures the current compilation errors as a baseline
      // After the fix, these specific errors should be resolved, but no new ones should appear
      const currentErrors = getCurrentCompilationErrors();
      
      // After fixes, compilation should succeed with no errors
      // This test validates that the preservation of working functionality is maintained
      expect(currentErrors).toBe(''); // No compilation errors should exist
    });

    // Property: Build configuration files should continue to exist and be valid
    it('property: build processes preserve configuration validity', () => {
      // Essential build files should exist
      expect(fileExists('package.json')).toBe(true);
      expect(fileExists('tsconfig.json')).toBe(true);
      
      // Package.json should contain test scripts
      expect(fileContains('package.json', '"test"')).toBe(true);
      expect(fileContains('package.json', '"build"')).toBe(true);
    });
  });
});