/**
 * Property-based tests for dashboard-config-override feature.
 * Uses fast-check + vitest with isolated ConfigStore instances via freshStore().
 */
import { describe, it, expect, vi } from 'vitest';
import * as fc from 'fast-check';

// ---- Base config (mirrors src/config.ts defaults) ----
const BASE_CONFIG = {
  ORDER_SIZE_MIN: 0.003,
  ORDER_SIZE_MAX: 0.005,
  STOP_LOSS_PERCENT: 0.05,
  TAKE_PROFIT_PERCENT: 0.05,
  POSITION_SL_PERCENT: 0.05,
  FARM_MIN_HOLD_SECS: 120,
  FARM_MAX_HOLD_SECS: 600,
  FARM_TP_USD: 1.0,
  FARM_SL_PERCENT: 0.05,
  TRADE_TP_PERCENT: 0.10,
  TRADE_SL_PERCENT: 0.10,
  COOLDOWN_MIN_MINS: 2,
  COOLDOWN_MAX_MINS: 10,
};

// ---- Per-test fs state ----
let mockExistsSync = vi.fn(() => false);
let mockReadFileSync = vi.fn(() => '');
let mockWriteFileSync = vi.fn();

/**
 * Returns a fresh ConfigStore singleton by resetting the module registry
 * and re-registering mocks with vi.doMock (not hoisted).
 */
async function freshStore(fsSetup?: {
  existsSync?: () => boolean;
  readFileSync?: () => string;
}) {
  mockExistsSync = vi.fn(fsSetup?.existsSync ?? (() => false));
  mockReadFileSync = vi.fn(fsSetup?.readFileSync ?? (() => ''));
  mockWriteFileSync = vi.fn();

  vi.resetModules();

  vi.doMock('fs', () => ({
    existsSync: mockExistsSync,
    readFileSync: mockReadFileSync,
    writeFileSync: mockWriteFileSync,
  }));

  vi.doMock('../../config', () => ({
    config: { ...BASE_CONFIG },
  }));

  const mod = await import('../ConfigStore');
  return { store: mod.configStore, getWritten: () => mockWriteFileSync };
}

// ---- Arbitraries for valid patch fields ----
// fast-check v4 requires fc.float min/max to be 32-bit floats (Math.fround)
const arbOrderSizeMin = fc.float({ min: Math.fround(0.0001), max: Math.fround(0.002), noNaN: true });
const arbOrderSizeMax = fc.float({ min: Math.fround(0.006), max: Math.fround(0.1), noNaN: true });
const arbPercent = fc.float({ min: Math.fround(0.001), max: Math.fround(1.0), noNaN: true });
const arbFarmMinHoldSecs = fc.integer({ min: 1, max: 119 });
const arbFarmMaxHoldSecs = fc.integer({ min: 601, max: 3600 });
const arbFarmTpUsd = fc.float({ min: Math.fround(0.01), max: Math.fround(100), noNaN: true });
const arbCooldownMinMins = fc.integer({ min: 0, max: 1 });
const arbCooldownMaxMins = fc.integer({ min: 11, max: 60 });

type PatchKey =
  | 'ORDER_SIZE_MIN'
  | 'ORDER_SIZE_MAX'
  | 'STOP_LOSS_PERCENT'
  | 'TAKE_PROFIT_PERCENT'
  | 'POSITION_SL_PERCENT'
  | 'FARM_MIN_HOLD_SECS'
  | 'FARM_MAX_HOLD_SECS'
  | 'FARM_TP_USD'
  | 'FARM_SL_PERCENT'
  | 'TRADE_TP_PERCENT'
  | 'TRADE_SL_PERCENT'
  | 'COOLDOWN_MIN_MINS'
  | 'COOLDOWN_MAX_MINS';

// Arbitrary that generates a random valid partial patch (random subset of keys)
const arbValidPatch = fc
  .record(
    {
      ORDER_SIZE_MIN: arbOrderSizeMin,
      ORDER_SIZE_MAX: arbOrderSizeMax,
      STOP_LOSS_PERCENT: arbPercent,
      TAKE_PROFIT_PERCENT: arbPercent,
      POSITION_SL_PERCENT: arbPercent,
      FARM_MIN_HOLD_SECS: arbFarmMinHoldSecs,
      FARM_MAX_HOLD_SECS: arbFarmMaxHoldSecs,
      FARM_TP_USD: arbFarmTpUsd,
      FARM_SL_PERCENT: arbPercent,
      TRADE_TP_PERCENT: arbPercent,
      TRADE_SL_PERCENT: arbPercent,
      COOLDOWN_MIN_MINS: arbCooldownMinMins,
      COOLDOWN_MAX_MINS: arbCooldownMaxMins,
    },
    { requiredKeys: [] }
  )
  .filter((patch) => Object.keys(patch).length > 0);

// ---- Tests ----

describe('Property 1: Effective config reflects overrides', () => {
  // Feature: dashboard-config-override, Property 1: For any valid partial override patch, after applyOverrides(patch), getEffective() returns the patched values for all keys in the patch, and base values for all keys not in the patch.
  it('getEffective() reflects patched keys and retains base for unpatched keys', async () => {
    await fc.assert(
      fc.asyncProperty(arbValidPatch, async (patch) => {
        const { store } = await freshStore();
        store.applyOverrides(patch);
        const effective = store.getEffective();

        // Patched keys must match patch values
        for (const key of Object.keys(patch) as PatchKey[]) {
          expect(effective[key]).toBe((patch as Record<string, number>)[key]);
        }

        // Unpatched keys must match base config
        const allKeys = Object.keys(BASE_CONFIG) as PatchKey[];
        for (const key of allKeys) {
          if (!(key in patch)) {
            expect(effective[key]).toBe(BASE_CONFIG[key]);
          }
        }
      }),
      { numRuns: 100 }
    );
  });
});

describe('Property 2: Validation rejects invalid order sizing', () => {
  // Feature: dashboard-config-override, Property 2: For any ORDER_SIZE_MIN <= 0 or ORDER_SIZE_MAX <= 0, validateOverrides returns at least one error. Also: for any ORDER_SIZE_MIN >= effective ORDER_SIZE_MAX, validateOverrides returns at least one error.
  it('rejects non-positive ORDER_SIZE_MIN', async () => {
    const { store } = await freshStore();
    const { validateOverrides } = await import('../validateOverrides');

    await fc.assert(
      fc.asyncProperty(
        fc.oneof(
          fc.float({ max: Math.fround(-0.0001), noNaN: true }),
          fc.constant(0)
        ),
        async (badMin) => {
          const errors = validateOverrides({ ORDER_SIZE_MIN: badMin }, store.getEffective());
          expect(errors.length).toBeGreaterThan(0);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('rejects non-positive ORDER_SIZE_MAX', async () => {
    const { store } = await freshStore();
    const { validateOverrides } = await import('../validateOverrides');

    await fc.assert(
      fc.asyncProperty(
        fc.oneof(
          fc.float({ max: Math.fround(-0.0001), noNaN: true }),
          fc.constant(0)
        ),
        async (badMax) => {
          const errors = validateOverrides({ ORDER_SIZE_MAX: badMax }, store.getEffective());
          expect(errors.length).toBeGreaterThan(0);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('rejects ORDER_SIZE_MIN >= effective ORDER_SIZE_MAX', async () => {
    const { store } = await freshStore();
    const { validateOverrides } = await import('../validateOverrides');

    await fc.assert(
      fc.asyncProperty(
        // Generate min >= max (both positive)
        fc.float({ min: Math.fround(0.001), max: Math.fround(0.01), noNaN: true }).chain((max) =>
          fc.float({ min: max, max: Math.fround(max + 0.01), noNaN: true }).map((min) => ({ min, max }))
        ),
        async ({ min, max }) => {
          const errors = validateOverrides(
            { ORDER_SIZE_MIN: min, ORDER_SIZE_MAX: max },
            store.getEffective()
          );
          expect(errors.length).toBeGreaterThan(0);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('applyOverrides leaves config unchanged when order sizing is invalid', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.float({ max: Math.fround(-0.0001), noNaN: true }),
        async (badMin) => {
          const { store } = await freshStore();
          const before = store.getEffective().ORDER_SIZE_MIN;
          try {
            store.applyOverrides({ ORDER_SIZE_MIN: badMin });
          } catch {
            // expected
          }
          expect(store.getEffective().ORDER_SIZE_MIN).toBe(before);
        }
      ),
      { numRuns: 100 }
    );
  });
});

describe('Property 3: Validation rejects out-of-range percent parameters', () => {
  // Feature: dashboard-config-override, Property 3: For any percent field value not in (0, 1], validateOverrides returns at least one error.
  const percentFields = [
    'STOP_LOSS_PERCENT',
    'TAKE_PROFIT_PERCENT',
    'POSITION_SL_PERCENT',
    'FARM_SL_PERCENT',
    'TRADE_TP_PERCENT',
    'TRADE_SL_PERCENT',
  ] as const;

  const arbInvalidPercent = fc.oneof(
    fc.float({ max: Math.fround(-0.0001), noNaN: true }),
    fc.constant(0),
    fc.float({ min: Math.fround(1.001), max: Math.fround(100), noNaN: true })
  );

  for (const field of percentFields) {
    it(`rejects out-of-range value for ${field}`, async () => {
      const { store } = await freshStore();
      const { validateOverrides } = await import('../validateOverrides');

      await fc.assert(
        fc.asyncProperty(arbInvalidPercent, async (badVal) => {
          const errors = validateOverrides({ [field]: badVal } as Record<string, number>, store.getEffective());
          expect(errors.length).toBeGreaterThan(0);
        }),
        { numRuns: 100 }
      );
    });
  }

  it('applyOverrides leaves config unchanged when percent field is invalid', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...percentFields),
        arbInvalidPercent,
        async (field, badVal) => {
          const { store } = await freshStore();
          const before = store.getEffective()[field];
          try {
            store.applyOverrides({ [field]: badVal } as Record<string, number>);
          } catch {
            // expected
          }
          expect(store.getEffective()[field]).toBe(before);
        }
      ),
      { numRuns: 100 }
    );
  });
});

describe('Property 4: Validation rejects invalid range pairs', () => {
  // Feature: dashboard-config-override, Property 4: For FARM_MIN_HOLD_SECS >= FARM_MAX_HOLD_SECS or COOLDOWN_MIN_MINS >= COOLDOWN_MAX_MINS, validateOverrides returns at least one error.
  it('rejects FARM_MIN_HOLD_SECS >= FARM_MAX_HOLD_SECS', async () => {
    const { store } = await freshStore();
    const { validateOverrides } = await import('../validateOverrides');

    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 1000 }).chain((max) =>
          fc.integer({ min: max, max: max + 100 }).map((min) => ({ min, max }))
        ),
        async ({ min, max }) => {
          const errors = validateOverrides(
            { FARM_MIN_HOLD_SECS: min, FARM_MAX_HOLD_SECS: max },
            store.getEffective()
          );
          expect(errors.length).toBeGreaterThan(0);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('rejects COOLDOWN_MIN_MINS >= COOLDOWN_MAX_MINS', async () => {
    const { store } = await freshStore();
    const { validateOverrides } = await import('../validateOverrides');

    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 100 }).chain((max) =>
          fc.integer({ min: max, max: max + 50 }).map((min) => ({ min, max }))
        ),
        async ({ min, max }) => {
          const errors = validateOverrides(
            { COOLDOWN_MIN_MINS: min, COOLDOWN_MAX_MINS: max },
            store.getEffective()
          );
          expect(errors.length).toBeGreaterThan(0);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('applyOverrides leaves config unchanged when range pair is invalid', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 1000 }).chain((max) =>
          fc.integer({ min: max, max: max + 100 }).map((min) => ({ min, max }))
        ),
        async ({ min, max }) => {
          const { store } = await freshStore();
          const beforeMin = store.getEffective().FARM_MIN_HOLD_SECS;
          const beforeMax = store.getEffective().FARM_MAX_HOLD_SECS;
          try {
            store.applyOverrides({ FARM_MIN_HOLD_SECS: min, FARM_MAX_HOLD_SECS: max });
          } catch {
            // expected
          }
          expect(store.getEffective().FARM_MIN_HOLD_SECS).toBe(beforeMin);
          expect(store.getEffective().FARM_MAX_HOLD_SECS).toBe(beforeMax);
        }
      ),
      { numRuns: 100 }
    );
  });
});

describe('Property 5: Reset restores base config', () => {
  // Feature: dashboard-config-override, Property 5: For any sequence of applyOverrides calls followed by resetToDefaults, getEffective() returns values identical to the original base config.
  it('resetToDefaults always restores base config after any sequence of valid patches', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(arbValidPatch, { minLength: 1, maxLength: 5 }),
        async (patches) => {
          const { store } = await freshStore();

          for (const patch of patches) {
            store.applyOverrides(patch);
          }

          store.resetToDefaults();
          const effective = store.getEffective();

          for (const key of Object.keys(BASE_CONFIG) as PatchKey[]) {
            expect(effective[key]).toBe(BASE_CONFIG[key]);
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});

describe('Property 6: Persistence round-trip', () => {
  // Feature: dashboard-config-override, Property 6: For any valid set of overrides applied via applyOverrides, the overrides written to disk when parsed and loaded via loadFromDisk on a fresh store produce an identical effective config.
  it('loadFromDisk on a fresh store produces identical effective config', async () => {
    await fc.assert(
      fc.asyncProperty(arbValidPatch, async (patch) => {
        // Store 1: apply overrides, capture what was written to disk
        let capturedJson = '';
        mockWriteFileSync = vi.fn((_path: string, data: string) => {
          capturedJson = data;
        });

        vi.resetModules();
        vi.doMock('fs', () => ({
          existsSync: vi.fn(() => false),
          readFileSync: vi.fn(() => ''),
          writeFileSync: mockWriteFileSync,
        }));
        vi.doMock('../../config', () => ({ config: { ...BASE_CONFIG } }));

        const mod1 = await import('../ConfigStore');
        const store1 = mod1.configStore;
        store1.applyOverrides(patch);
        const effective1 = store1.getEffective();

        // Store 2: load from the captured JSON
        vi.resetModules();
        vi.doMock('fs', () => ({
          existsSync: vi.fn(() => true),
          readFileSync: vi.fn(() => capturedJson),
          writeFileSync: vi.fn(),
        }));
        vi.doMock('../../config', () => ({ config: { ...BASE_CONFIG } }));

        const mod2 = await import('../ConfigStore');
        const store2 = mod2.configStore;
        store2.loadFromDisk();
        const effective2 = store2.getEffective();

        expect(effective2).toEqual(effective1);
      }),
      { numRuns: 100 }
    );
  });
});

describe('Property 7: Invalid persisted values are discarded individually', () => {
  // Feature: dashboard-config-override, Property 7: For any config-overrides.json containing a mix of valid and invalid values, loadFromDisk applies all valid values and discards only the invalid ones.
  it('loadFromDisk applies valid values and discards invalid ones', async () => {
    await fc.assert(
      fc.asyncProperty(
        // Valid override: a single valid field
        fc.record({
          FARM_TP_USD: arbFarmTpUsd,
          STOP_LOSS_PERCENT: arbPercent,
        }),
        // Invalid value: negative ORDER_SIZE_MIN
        fc.float({ min: Math.fround(-100), max: Math.fround(-0.0001), noNaN: true }),
        async (validOverrides, invalidMin) => {
          const mixedJson = JSON.stringify({
            ...validOverrides,
            ORDER_SIZE_MIN: invalidMin, // invalid
          });

          vi.resetModules();
          vi.doMock('fs', () => ({
            existsSync: vi.fn(() => true),
            readFileSync: vi.fn(() => mixedJson),
            writeFileSync: vi.fn(),
          }));
          vi.doMock('../../config', () => ({ config: { ...BASE_CONFIG } }));

          const mod = await import('../ConfigStore');
          const store = mod.configStore;
          store.loadFromDisk();
          const effective = store.getEffective();

          // Invalid value discarded — ORDER_SIZE_MIN stays at base
          expect(effective.ORDER_SIZE_MIN).toBe(BASE_CONFIG.ORDER_SIZE_MIN);

          // Valid values applied
          expect(effective.FARM_TP_USD).toBe(validOverrides.FARM_TP_USD);
          expect(effective.STOP_LOSS_PERCENT).toBe(validOverrides.STOP_LOSS_PERCENT);
        }
      ),
      { numRuns: 100 }
    );
  });
});
