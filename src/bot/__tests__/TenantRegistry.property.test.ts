import { describe, it, afterEach } from 'vitest';

// ── Mock broken SDK dependencies before any imports ───────────────────────────
// @decibeltrade/sdk has a broken ./admin sub-path import in this environment.
// Mock it at the top level so the module graph resolves cleanly.
import { vi } from 'vitest';
vi.mock('@decibeltrade/sdk', () => ({
  DecibelReadDex: vi.fn(function () { return {}; }),
  DecibelWriteDex: vi.fn(function () { return {}; }),
  GasPriceManager: vi.fn(function () { return { initialize: vi.fn().mockResolvedValue(undefined) }; }),
  MAINNET_CONFIG: { network: 'mainnet' },
  NETNA_CONFIG: undefined,
  TimeInForce: { PostOnly: 'PostOnly' },
}));

vi.mock('@aptos-labs/ts-sdk', () => ({
  Ed25519Account: vi.fn(function () { return {}; }),
  Ed25519PrivateKey: vi.fn(function () { return {}; }),
  AccountAddress: vi.fn(function () { return {}; }),
  createObjectAddress: vi.fn(),
}));

import * as fc from 'fast-check';
import os from 'os';
import fs from 'fs';
import path from 'path';
import { TenantRegistry } from '../TenantRegistry.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Creates a unique temp directory for a single test run and returns its path. */
function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tenant-registry-test-'));
  return dir;
}

/** Recursively removes a directory, ignoring errors (best-effort cleanup). */
function removeTempDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore cleanup errors
  }
}

// ---------------------------------------------------------------------------
// Property 4: Address normalization
//
// For any mixed-case wallet address string, ensureTenant(addr).walletAddress
// equals addr.toLowerCase().
//
// **Validates: Requirements 2.9, 7.5**
// ---------------------------------------------------------------------------

describe('TenantRegistry — Property 4: address normalization', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    // Clean up all temp dirs created during this test run
    for (const dir of tempDirs.splice(0)) {
      removeTempDir(dir);
    }
  });

  /**
   * Property 4: Address normalization
   *
   * For any mixed-case wallet address string of exactly 40 characters,
   * `ensureTenant(addr).walletAddress === addr.toLowerCase()`.
   *
   * The generator uses `fc.string({ minLength: 40, maxLength: 40 })` which
   * produces arbitrary Unicode strings; we filter to printable ASCII to keep
   * the addresses filesystem-safe (the registry creates a subdirectory named
   * after the lowercase address).
   *
   * **Validates: Requirements 2.9, 7.5**
   */
  it('Property 4: ensureTenant normalizes wallet address to lowercase', () => {
    fc.assert(
      fc.property(
        // Generate 40-character strings with mixed-case hex characters and digits
        // to simulate realistic wallet address inputs with varying case.
        fc.stringMatching(/^[0-9a-fA-F]{40}$/),
        (addr) => {
          const tempDir = makeTempDir();
          tempDirs.push(tempDir);

          const registry = new TenantRegistry(tempDir);
          const tenant = registry.ensureTenant(addr);

          return tenant.walletAddress === addr.toLowerCase();
        },
      ),
      { numRuns: 200 },
    );
  });
});
