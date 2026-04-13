import { describe, it, expect, vi, afterEach } from 'vitest';
import { computeAdaptiveCooldown } from '../AdaptiveCooldown.js';
import { config } from '../../config.js';

afterEach(() => {
  vi.restoreAllMocks();
});

// Helper: mock Math.random to return a fixed value so baseMins is deterministic
function mockRandom(value: number) {
  vi.spyOn(Math, 'random').mockReturnValue(value);
}

describe('computeAdaptiveCooldown', () => {
  it('empty recentPnLs → losingStreak=0, streakMult=1.0', () => {
    mockRandom(0);
    const result = computeAdaptiveCooldown({ recentPnLs: [], lastChopScore: 0 });
    expect(result.losingStreak).toBe(0);
    expect(result.streakMult).toBe(1.0);
  });

  it('mixed PnLs ending in a win → losingStreak=0', () => {
    mockRandom(0);
    const result = computeAdaptiveCooldown({
      recentPnLs: [-1, -2, 3],
      lastChopScore: 0,
    });
    expect(result.losingStreak).toBe(0);
    expect(result.streakMult).toBe(1.0);
  });

  it('3 trailing losses → streakMult=2.5 (1 + 3×0.5)', () => {
    mockRandom(0);
    const result = computeAdaptiveCooldown({
      recentPnLs: [5, -1, -2, -3],
      lastChopScore: 0,
    });
    expect(result.losingStreak).toBe(3);
    expect(result.streakMult).toBeCloseTo(2.5);
  });

  it('lastChopScore=0 → chopMult=1.0', () => {
    mockRandom(0);
    const result = computeAdaptiveCooldown({ recentPnLs: [], lastChopScore: 0 });
    expect(result.chopMult).toBe(1.0);
  });

  it('lastChopScore=1.0 → chopMult=2.0 (1 + 1.0×1.0)', () => {
    mockRandom(0);
    const result = computeAdaptiveCooldown({ recentPnLs: [], lastChopScore: 1.0 });
    expect(result.chopMult).toBeCloseTo(2.0);
  });

  it('all 5 losses → streakMult clamped to 4.0 (not 3.5)', () => {
    mockRandom(0);
    // 5 losses: 1 + 5×0.5 = 3.5 — below the 4.0 cap, so result is 3.5
    const result5 = computeAdaptiveCooldown({
      recentPnLs: [-1, -2, -3, -4, -5],
      lastChopScore: 0,
    });
    expect(result5.losingStreak).toBe(5);
    expect(result5.streakMult).toBeCloseTo(3.5);

    // 7 losses: 1 + 7×0.5 = 4.5 → clamped to 4.0 (cap is 4.0, not 3.5)
    const result7 = computeAdaptiveCooldown({
      recentPnLs: [-1, -2, -3, -4, -5, -6, -7],
      lastChopScore: 0,
    });
    expect(result7.streakMult).toBe(4.0);
  });

  it('design doc example: 3 losses, chopScore=0.7 → streakMult=2.5, chopMult=1.7', () => {
    mockRandom(0);
    const result = computeAdaptiveCooldown({
      recentPnLs: [-0.3, -0.5, -0.2],
      lastChopScore: 0.7,
    });
    expect(result.streakMult).toBeCloseTo(2.5);
    expect(result.chopMult).toBeCloseTo(1.7);
  });

  it('cooldownMs is always within [COOLDOWN_MIN_MINS×60000, CHOP_COOLDOWN_MAX_MINS×60000]', () => {
    const minMs = config.COOLDOWN_MIN_MINS * 60_000;
    const maxMs = config.CHOP_COOLDOWN_MAX_MINS * 60_000;

    const scenarios = [
      { recentPnLs: [], lastChopScore: 0, random: 0 },
      { recentPnLs: [], lastChopScore: 0, random: 1 },
      { recentPnLs: [-1, -2, -3, -4, -5], lastChopScore: 1.0, random: 0 },
      { recentPnLs: [-1, -2, -3, -4, -5], lastChopScore: 1.0, random: 1 },
      { recentPnLs: [1, 2, 3], lastChopScore: 0.5, random: 0.5 },
    ];

    for (const { recentPnLs, lastChopScore, random } of scenarios) {
      mockRandom(random);
      const result = computeAdaptiveCooldown({ recentPnLs, lastChopScore });
      expect(result.cooldownMs).toBeGreaterThanOrEqual(minMs);
      expect(result.cooldownMs).toBeLessThanOrEqual(maxMs);
    }
  });
});
