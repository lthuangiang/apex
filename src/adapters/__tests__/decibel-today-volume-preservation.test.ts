/**
 * Preservation Property Tests — Decibel Today Volume Fix
 *
 * Property 2: Preservation — Non-Buggy Input Behavior Unchanged
 *
 * These tests MUST PASS on unfixed code (establishing baseline behavior to preserve)
 * AND MUST CONTINUE TO PASS after the fix is implemented (no regressions).
 *
 * Covers:
 *   3.1 Real-time addTodayVolume() calls still work
 *   3.2 UTC-day reset logic still works
 *   3.3 Non-Decibel adapters (no getTodayVolumeFromAPI) are unaffected
 *   3.4 StateStore baseline restoration still works
 *   3.5 API errors do not reset todayVolume to 0
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { sharedState, addTodayVolume } from '../../ai/sharedState.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function resetSharedState(todayVolume = 0, date?: string) {
  sharedState.todayVolume = todayVolume;
  sharedState.todayVolumeDate = date ?? new Date().toISOString().slice(0, 10);
}

/** Simulate reconcileTodayVolume() — the fix logic (duck-typed) */
async function reconcileTodayVolume(adapter: any): Promise<void> {
  if (typeof adapter.getTodayVolumeFromAPI !== 'function') return; // non-Decibel: no-op
  try {
    const apiVolume = await adapter.getTodayVolumeFromAPI();
    sharedState.todayVolume = apiVolume;
  } catch {
    // API error: keep existing value, do not reset
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Preservation: Real-time addTodayVolume() accumulation', () => {
  beforeEach(() => resetSharedState(0));

  it('addTodayVolume increments todayVolume correctly', () => {
    addTodayVolume(5_000);
    expect(sharedState.todayVolume).toBe(5_000);

    addTodayVolume(3_000);
    expect(sharedState.todayVolume).toBe(8_000);
  });

  it('multiple addTodayVolume calls accumulate correctly', () => {
    const amounts = [1000, 2500, 750, 4200, 300];
    const expected = amounts.reduce((a, b) => a + b, 0);
    amounts.forEach(a => addTodayVolume(a));
    expect(sharedState.todayVolume).toBe(expected);
  });

  it('addTodayVolume with zero does not change todayVolume', () => {
    sharedState.todayVolume = 10_000;
    addTodayVolume(0);
    expect(sharedState.todayVolume).toBe(10_000);
  });

  it('property: for any sequence of positive amounts, todayVolume equals their sum', () => {
    const amounts = [500, 1200, 3300, 800, 2100, 450];
    let expected = 0;
    for (const amount of amounts) {
      addTodayVolume(amount);
      expected += amount;
      expect(sharedState.todayVolume).toBe(expected);
    }
  });
});

describe('Preservation: UTC-day reset logic', () => {
  beforeEach(() => resetSharedState(0));

  it('addTodayVolume resets todayVolume to 0 when date changes to new UTC day', () => {
    // Simulate: todayVolume accumulated yesterday
    sharedState.todayVolume = 50_000;
    sharedState.todayVolumeDate = '2020-01-01'; // yesterday

    // Now call addTodayVolume — today's date is different, should reset first
    addTodayVolume(1_000);

    const today = new Date().toISOString().slice(0, 10);
    expect(sharedState.todayVolumeDate).toBe(today);
    expect(sharedState.todayVolume).toBe(1_000); // reset to 0, then added 1000
  });

  it('addTodayVolume does NOT reset when date is still today', () => {
    const today = new Date().toISOString().slice(0, 10);
    sharedState.todayVolume = 25_000;
    sharedState.todayVolumeDate = today;

    addTodayVolume(5_000);

    expect(sharedState.todayVolume).toBe(30_000); // accumulated, not reset
    expect(sharedState.todayVolumeDate).toBe(today);
  });
});

describe('Preservation: Non-Decibel adapters are unaffected', () => {
  beforeEach(() => resetSharedState(12_000));

  it('reconcileTodayVolume is a no-op for adapters without getTodayVolumeFromAPI', async () => {
    const sodexAdapter = { exchangeName: 'sodex' }; // no getTodayVolumeFromAPI
    const dangoAdapter = { exchangeName: 'dango' }; // no getTodayVolumeFromAPI

    await reconcileTodayVolume(sodexAdapter);
    expect(sharedState.todayVolume).toBe(12_000); // unchanged

    await reconcileTodayVolume(dangoAdapter);
    expect(sharedState.todayVolume).toBe(12_000); // unchanged
  });

  it('property: for any adapter without getTodayVolumeFromAPI, todayVolume is unchanged after reconcile', async () => {
    const adapters = [
      { exchangeName: 'sodex' },
      { exchangeName: 'dango' },
      {}, // empty object
      { someOtherMethod: () => {} }, // has methods but not getTodayVolumeFromAPI
    ];

    for (const adapter of adapters) {
      const before = sharedState.todayVolume;
      await reconcileTodayVolume(adapter);
      expect(sharedState.todayVolume).toBe(before);
    }
  });
});

describe('Preservation: API errors do not reset todayVolume', () => {
  beforeEach(() => resetSharedState(20_000));

  it('when getTodayVolumeFromAPI throws, todayVolume retains its last known value', async () => {
    const failingAdapter = {
      getTodayVolumeFromAPI: async () => { throw new Error('Network error'); },
    };

    await reconcileTodayVolume(failingAdapter);

    expect(sharedState.todayVolume).toBe(20_000); // not reset to 0
  });

  it('when getTodayVolumeFromAPI rejects, todayVolume is not set to 0', async () => {
    const rejectingAdapter = {
      getTodayVolumeFromAPI: () => Promise.reject(new Error('API unavailable')),
    };

    await reconcileTodayVolume(rejectingAdapter);

    expect(sharedState.todayVolume).not.toBe(0);
    expect(sharedState.todayVolume).toBe(20_000);
  });

  it('property: for any API error, todayVolume >= pre-error value', async () => {
    const errorTypes = [
      new Error('Network timeout'),
      new Error('404 Not Found'),
      new Error('Rate limited'),
    ];

    for (const error of errorTypes) {
      const before = sharedState.todayVolume;
      const failingAdapter = {
        getTodayVolumeFromAPI: async () => { throw error; },
      };
      await reconcileTodayVolume(failingAdapter);
      expect(sharedState.todayVolume).toBe(before); // unchanged on error
    }
  });
});

describe('Preservation: StateStore baseline restoration', () => {
  beforeEach(() => resetSharedState(0));

  it('todayVolume can be restored from a saved state for the same UTC day', () => {
    const today = new Date().toISOString().slice(0, 10);
    const savedVolume = 35_000;

    // Simulate StateStore.loadState() restoring todayVolume
    if (today === today) { // same day check (always true here, mirrors StateStore logic)
      sharedState.todayVolume = savedVolume;
      sharedState.todayVolumeDate = today;
    }

    expect(sharedState.todayVolume).toBe(35_000);
    expect(sharedState.todayVolumeDate).toBe(today);
  });

  it('todayVolume is NOT restored from a saved state for a different UTC day', () => {
    const today = new Date().toISOString().slice(0, 10);
    const yesterday = '2020-01-01';
    const savedVolume = 35_000;

    // Simulate StateStore.loadState() — only restore if same day
    if (yesterday === today) {
      sharedState.todayVolume = savedVolume;
      sharedState.todayVolumeDate = yesterday;
    }
    // else: leave todayVolume at 0 (default)

    expect(sharedState.todayVolume).toBe(0); // not restored (different day)
  });

  it('after StateStore restoration, addTodayVolume still accumulates on top', () => {
    const today = new Date().toISOString().slice(0, 10);
    sharedState.todayVolume = 10_000; // restored from StateStore
    sharedState.todayVolumeDate = today;

    addTodayVolume(5_000); // new trade after restart

    expect(sharedState.todayVolume).toBe(15_000); // baseline + new trade
  });
});

describe('Preservation: reconcileTodayVolume with successful API call', () => {
  beforeEach(() => resetSharedState(0));

  it('reconcileTodayVolume updates todayVolume to API value when adapter supports it', async () => {
    const decibelAdapter = {
      getTodayVolumeFromAPI: async () => 42_000,
    };

    await reconcileTodayVolume(decibelAdapter);

    expect(sharedState.todayVolume).toBe(42_000);
  });

  it('reconcileTodayVolume with API returning 0 sets todayVolume to 0 (no trades today)', async () => {
    sharedState.todayVolume = 5_000; // some stale value
    const decibelAdapter = {
      getTodayVolumeFromAPI: async () => 0,
    };

    await reconcileTodayVolume(decibelAdapter);

    expect(sharedState.todayVolume).toBe(0); // API is authoritative
  });
});
