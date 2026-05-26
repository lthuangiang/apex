import { describe, it, afterEach } from 'vitest';
import * as fc from 'fast-check';
import os from 'os';
import fs from 'fs';
import path from 'path';
import { TenantConfigStore, assertWithinDataDir } from '../TenantConfigStore.js';
import type { BotConfig } from '../types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Creates a unique temp directory for a single test run and returns its path. */
function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tenant-configstore-test-'));
}

/** Recursively removes a directory, ignoring errors (best-effort cleanup). */
function removeTempDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore cleanup errors
  }
}

/**
 * Build a minimal valid BotConfig with the given id and tradeLogPath.
 * Only the fields required by `validateBotConfig` are populated.
 */
function makeBotConfig(id: string, tradeLogPath: string): BotConfig {
  return {
    id,
    exchange: 'decibel',
    credentialKey: 'TEST_KEY',
    symbol: 'BTC-PERP',
    tradeLogPath,
    botType: 'standard',
    autoStart: false,
  } as unknown as BotConfig;
}

// ---------------------------------------------------------------------------
// Property 6: Path containment
//
// For any bot config created via the API, `tradeLogPath` always resolves
// within the tenant's `dataDir` after `persistConfigs()` / `save()`.
//
// **Validates: Requirements 5.2, 7.2, 7.3**
// ---------------------------------------------------------------------------

describe('TenantConfigStore — Property 6: path containment', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      removeTempDir(dir);
    }
  });

  // -------------------------------------------------------------------------
  // Sub-property A: assertWithinDataDir throws for paths that escape dataDir
  //
  // For any arbitrary path string that resolves outside the dataDir,
  // `assertWithinDataDir` must throw.
  // -------------------------------------------------------------------------
  it('Property 6a: assertWithinDataDir throws for paths that escape dataDir', () => {
    fc.assert(
      fc.property(
        // Generate arbitrary path strings — many will contain traversal sequences
        // like "..", absolute paths, or other escaping patterns.
        fc.string({ minLength: 1 }),
        (arbitraryPath) => {
          const tempDir = makeTempDir();
          tempDirs.push(tempDir);

          const resolvedDir = path.resolve(tempDir);
          const resolvedPath = path.resolve(tempDir, arbitraryPath);

          const isWithin =
            resolvedPath.startsWith(resolvedDir + path.sep) ||
            resolvedPath === resolvedDir;

          if (isWithin) {
            // Path is safe — assertWithinDataDir must NOT throw
            let threw = false;
            try {
              assertWithinDataDir(resolvedPath, tempDir);
            } catch {
              threw = true;
            }
            return !threw;
          } else {
            // Path escapes dataDir — assertWithinDataDir MUST throw
            let threw = false;
            try {
              assertWithinDataDir(resolvedPath, tempDir);
            } catch {
              threw = true;
            }
            return threw;
          }
        },
      ),
      { numRuns: 500 },
    );
  });

  // -------------------------------------------------------------------------
  // Sub-property B: after save(), all tradeLogPath values resolve within dataDir
  //
  // For any array of bot configs with arbitrary tradeLogPath strings,
  // calling save() followed by load() returns configs whose tradeLogPath
  // values all resolve within the tenant's dataDir.
  // -------------------------------------------------------------------------
  it('Property 6b: after save(), all tradeLogPath values resolve within dataDir', () => {
    fc.assert(
      fc.property(
        // Generate 1–5 bot configs with arbitrary tradeLogPath strings.
        // The IDs must be unique within the array to avoid collisions.
        fc.uniqueArray(
          fc.record({
            id: fc.stringMatching(/^[0-9a-f]{4,12}$/),
            tradeLogPath: fc.string({ minLength: 1 }),
          }),
          { selector: (entry) => entry.id, minLength: 1, maxLength: 5 },
        ),
        (entries) => {
          const tempDir = makeTempDir();
          tempDirs.push(tempDir);

          const store = new TenantConfigStore(tempDir);
          const resolvedDataDir = path.resolve(tempDir);

          const configs = entries.map(({ id, tradeLogPath }) =>
            makeBotConfig(id, tradeLogPath),
          );

          // save() must not throw — it sanitizes paths internally
          store.save(configs);

          // load() returns the persisted configs
          const loaded = store.load();

          // Every tradeLogPath in the loaded configs must resolve within dataDir
          return loaded.every((cfg) => {
            const resolved = path.resolve(cfg.tradeLogPath);
            return (
              resolved.startsWith(resolvedDataDir + path.sep) ||
              resolved === resolvedDataDir
            );
          });
        },
      ),
      { numRuns: 300 },
    );
  });

  // -------------------------------------------------------------------------
  // Sub-property C: traversal attempts are sanitized, not rejected
  //
  // Specifically for classic traversal strings (../../etc/passwd style),
  // save() must succeed (sanitize rather than throw) and the resulting
  // tradeLogPath must still be within dataDir.
  // -------------------------------------------------------------------------
  it('Property 6c: traversal attempts in tradeLogPath are sanitized to dataDir', () => {
    fc.assert(
      fc.property(
        // Generate traversal-style paths: some number of "../" segments
        // followed by an arbitrary filename.
        fc.tuple(
          fc.integer({ min: 1, max: 10 }),
          fc.string({ minLength: 1, maxLength: 40 }),
        ),
        ([depth, filename]) => {
          const tempDir = makeTempDir();
          tempDirs.push(tempDir);

          const store = new TenantConfigStore(tempDir);
          const resolvedDataDir = path.resolve(tempDir);

          // Build a traversal path: ../../.../{filename}
          const traversal = '../'.repeat(depth) + filename;
          const config = makeBotConfig('bot-traversal', traversal);

          // save() must not throw — it sanitizes the path
          store.save([config]);

          const loaded = store.load();

          // The loaded tradeLogPath must be within dataDir
          return loaded.every((cfg) => {
            const resolved = path.resolve(cfg.tradeLogPath);
            return (
              resolved.startsWith(resolvedDataDir + path.sep) ||
              resolved === resolvedDataDir
            );
          });
        },
      ),
      { numRuns: 200 },
    );
  });
});
