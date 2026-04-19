// BUG CONDITION EXPLORATION TEST — Expected to FAIL on unfixed code
//
// This test proves the bug exists: ConfigStore.applyOverrides() mutates the global
// config object. When two ConfigStore instances apply different overrides, the second
// one overwrites the global config — so any code reading config.FARM_MIN_HOLD_SECS
// directly (like Watcher does) gets the wrong value.
//
// The bug: store2.applyOverrides({ FARM_MIN_HOLD_SECS: 30 }) writes 30 to the global
// config object. Watcher reads config.FARM_MIN_HOLD_SECS and gets 30 instead of 120.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ConfigStore } from '../../config/ConfigStore.js';
import { config } from '../../config.js';

describe('Per-Bot Config Isolation — Bug Condition Exploration', () => {
  // Save and restore the original global config value around each test
  // so tests don't bleed into each other
  let savedFarmMinHoldSecs: number;

  beforeEach(() => {
    savedFarmMinHoldSecs = config.FARM_MIN_HOLD_SECS;
  });

  afterEach(() => {
    // Restore global config to its pre-test value
    (config as Record<string, unknown>).FARM_MIN_HOLD_SECS = savedFarmMinHoldSecs;
  });

  it('baseline sanity: single store, global config reflects the override', () => {
    // This SHOULD PASS even on unfixed code — single store, no collision
    const store1 = new ConfigStore();
    store1.applyOverrides({ FARM_MIN_HOLD_SECS: 120 });

    // store1's effective value is correct
    expect(store1.getEffective().FARM_MIN_HOLD_SECS).toBe(120);
  });

  it('two-bot override collision: global config is overwritten by store2 (FAILS on unfixed code)', () => {
    // store1 represents Bot A (SoDEX) — wants FARM_MIN_HOLD_SECS = 120
    const store1 = new ConfigStore();
    store1.applyOverrides({ FARM_MIN_HOLD_SECS: 120 });

    // store2 represents Bot B (Decibel) — wants FARM_MIN_HOLD_SECS = 30
    const store2 = new ConfigStore();
    store2.applyOverrides({ FARM_MIN_HOLD_SECS: 30 });

    // On unfixed code, applyOverrides() mutates the global config object.
    // After store2.applyOverrides(), config.FARM_MIN_HOLD_SECS === 30.
    // Watcher reads config.FARM_MIN_HOLD_SECS directly — it will get 30, not 120.
    // This assertion proves the global mutation happened:
    expect(config.FARM_MIN_HOLD_SECS).toBe(120);
    // ^ FAILS on unfixed code: actual value is 30 (store2 overwrote it)
  });

  it('reset collision: store2.resetToDefaults() does NOT corrupt store1 effective config (FAILS on unfixed code)', () => {
    // Both stores are created while global is at default (120).
    // store2 is created BEFORE store1 applies its override, so store2.base = 120.
    (config as Record<string, unknown>).FARM_MIN_HOLD_SECS = 120;

    // Both bots start up at the same time — both capture base = 120
    const store1 = new ConfigStore(); // base = 120
    const store2 = new ConfigStore(); // base = 120

    // Bot A applies its override: FARM_MIN_HOLD_SECS = 300
    store1.applyOverrides({ FARM_MIN_HOLD_SECS: 300 });

    // Bot B resets to defaults (e.g., operator clicks "reset" in dashboard)
    // On unfixed code: resetToDefaults() writes store2.base (120) back to global config,
    // wiping store1's override — so store1.getEffective() would return 120 instead of 300
    store2.resetToDefaults();

    // The correct behavior: store1's effective config is unaffected by store2's reset.
    // store1.getEffective() must still return 300 (store1's own override).
    expect(store1.getEffective().FARM_MIN_HOLD_SECS).toBe(300);
    // ^ FAILS on unfixed code: store1.getEffective() returns 120 because resetToDefaults()
    // wiped the global config that store1.base was pointing to

    // store2's effective config should be back to base (120) after reset
    expect(store2.getEffective().FARM_MIN_HOLD_SECS).toBe(120);
  });
});
