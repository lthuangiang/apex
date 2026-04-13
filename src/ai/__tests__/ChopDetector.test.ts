import { describe, it, expect } from 'vitest';
import { ChopDetector, SignalHistoryEntry } from '../ChopDetector.js';
import { config } from '../../config.js';

const detector = new ChopDetector();

// Helper to build a history entry
function entry(direction: 'long' | 'short' | 'skip', score = 0.5): SignalHistoryEntry {
  return { direction, score, ts: Date.now() };
}

// ─── flipRate ────────────────────────────────────────────────────────────────

describe('flipRate', () => {
  it('empty history → 0.0', () => {
    const result = detector.evaluate({ score: 0.5, bbWidth: 0 }, []);
    expect(result.flipRate).toBe(0.0);
  });

  it('single entry → 0.0', () => {
    const result = detector.evaluate({ score: 0.5, bbWidth: 0 }, [entry('long')]);
    expect(result.flipRate).toBe(0.0);
  });

  it('all same direction → 0.0', () => {
    const history = [entry('long'), entry('long'), entry('long'), entry('long')];
    const result = detector.evaluate({ score: 0.5, bbWidth: 0 }, history);
    expect(result.flipRate).toBe(0.0);
  });

  it('alternating long/short → 1.0', () => {
    // 4 entries, 3 adjacent pairs, all flip → flips/3 = 1.0
    const history = [entry('long'), entry('short'), entry('long'), entry('short')];
    const result = detector.evaluate({ score: 0.5, bbWidth: 0 }, history);
    expect(result.flipRate).toBe(1.0);
  });

  it('mixed with skip entries → skips are ignored in flip counting', () => {
    // [long, skip, short] — nonSkip = [long, short] → 1 flip
    // denominator = signalHistory.length - 1 = 2
    // flipRate = 1/2 = 0.5
    const history = [entry('long'), entry('skip'), entry('short')];
    const result = detector.evaluate({ score: 0.5, bbWidth: 0 }, history);
    expect(result.flipRate).toBe(0.5);
  });
});

// ─── momNeutrality ───────────────────────────────────────────────────────────

describe('momNeutrality', () => {
  it('score=0.5 → 1.0 (perfectly neutral)', () => {
    const result = detector.evaluate({ score: 0.5, bbWidth: 0.1 }, []);
    expect(result.momNeutrality).toBe(1.0);
  });

  it('score=0.0 → 0.0 (fully directional)', () => {
    const result = detector.evaluate({ score: 0.0, bbWidth: 0.1 }, []);
    expect(result.momNeutrality).toBe(0.0);
  });

  it('score=1.0 → 0.0 (fully directional)', () => {
    const result = detector.evaluate({ score: 1.0, bbWidth: 0.1 }, []);
    expect(result.momNeutrality).toBe(0.0);
  });

  it('score=0.72 → ~0.56 (formula: 1 - |0.72-0.5|/0.5)', () => {
    // |0.72 - 0.5| = 0.22; deviation/0.5 = 0.44; momNeutrality = 1 - 0.44 = 0.56
    // Note: the design doc example comment says "momNeutrality=0.44" for score=0.72,
    // but that is the deviation value, not the neutrality. The formula and implementation
    // both produce 0.56 for score=0.72.
    const result = detector.evaluate({ score: 0.72, bbWidth: 0.1 }, []);
    expect(result.momNeutrality).toBeCloseTo(0.56, 5);
  });
});

// ─── bbCompression ───────────────────────────────────────────────────────────

describe('bbCompression', () => {
  const MAX = config.CHOP_BB_COMPRESS_MAX;

  it('bbWidth=0 → 1.0', () => {
    const result = detector.evaluate({ score: 0.5, bbWidth: 0 }, []);
    expect(result.bbCompression).toBe(1.0);
  });

  it('bbWidth=CHOP_BB_COMPRESS_MAX → 1.0', () => {
    const result = detector.evaluate({ score: 0.5, bbWidth: MAX }, []);
    expect(result.bbCompression).toBeCloseTo(1.0, 10);
  });

  it('bbWidth=2×CHOP_BB_COMPRESS_MAX → 0.0', () => {
    const result = detector.evaluate({ score: 0.5, bbWidth: 2 * MAX }, []);
    expect(result.bbCompression).toBeCloseTo(0.0, 10);
  });

  it('bbWidth=1.5×CHOP_BB_COMPRESS_MAX → 0.5', () => {
    const result = detector.evaluate({ score: 0.5, bbWidth: 1.5 * MAX }, []);
    expect(result.bbCompression).toBeCloseTo(0.5, 10);
  });
});

// ─── chopScore ───────────────────────────────────────────────────────────────

describe('chopScore', () => {
  it('weighted sum with known inputs', () => {
    // flipRate=1.0 (alternating), score=0.5 (momNeutrality=1.0), bbWidth=0 (bbCompression=1.0)
    // chopScore = 1.0×0.4 + 1.0×0.35 + 1.0×0.25 = 1.0
    const history = [entry('long'), entry('short'), entry('long'), entry('short')];
    const result = detector.evaluate({ score: 0.5, bbWidth: 0 }, history);
    expect(result.chopScore).toBeCloseTo(1.0, 5);
  });

  it('isChoppy=true when chopScore >= CHOP_SCORE_THRESHOLD', () => {
    // Use inputs that produce a high chop score
    const history = [entry('long'), entry('short'), entry('long'), entry('short')];
    const result = detector.evaluate({ score: 0.5, bbWidth: 0 }, history);
    expect(result.chopScore).toBeGreaterThanOrEqual(config.CHOP_SCORE_THRESHOLD);
    expect(result.isChoppy).toBe(true);
  });

  it('isChoppy=false when chopScore < CHOP_SCORE_THRESHOLD', () => {
    // flipRate=0, score=0.9 (momNeutrality=0.2), bbWidth=large (bbCompression=0)
    // chopScore = 0×0.4 + 0.2×0.35 + 0×0.25 = 0.07 < 0.55
    const history = [entry('long'), entry('long'), entry('long')];
    const result = detector.evaluate({ score: 0.9, bbWidth: 1.0 }, history);
    expect(result.chopScore).toBeLessThan(config.CHOP_SCORE_THRESHOLD);
    expect(result.isChoppy).toBe(false);
  });

  it('isChoppy threshold boundary: score exactly at threshold', () => {
    // Construct inputs so chopScore ≈ CHOP_SCORE_THRESHOLD
    // We need chopScore = 0.55 exactly
    // Use flipRate=0, bbCompression=0, so chopScore = momNeutrality × 0.35
    // momNeutrality = 0.55/0.35 ≈ 1.571 → clamped to 1.0 → chopScore = 0.35 (not enough)
    // Use flipRate=1.0, bbCompression=0: chopScore = 0.4 + momNeutrality×0.35
    // 0.55 = 0.4 + mom×0.35 → mom = 0.15/0.35 ≈ 0.4286
    // momNeutrality = 0.4286 → |score-0.5|/0.5 = 0.5714 → |score-0.5| = 0.2857 → score = 0.7857
    const history = [entry('long'), entry('short'), entry('long'), entry('short')];
    const result = detector.evaluate({ score: 0.7857, bbWidth: 1.0 }, history);
    expect(result.isChoppy).toBe(result.chopScore >= config.CHOP_SCORE_THRESHOLD);
  });
});

// ─── Design doc examples ─────────────────────────────────────────────────────

describe('design doc examples', () => {
  it('clean trending market: score=0.72, bbWidth=0.025, history=[long,long,long] → isChoppy=false', () => {
    const history: SignalHistoryEntry[] = [
      { direction: 'long', score: 0.68, ts: Date.now() - 30000 },
      { direction: 'long', score: 0.71, ts: Date.now() - 15000 },
      { direction: 'long', score: 0.70, ts: Date.now() - 5000 },
    ];
    const result = detector.evaluate({ score: 0.72, bbWidth: 0.025 }, history);
    // flipRate=0.0, momNeutrality≈0.56, bbCompression=0.0 (0.025/0.015=1.67 → 1-(1.67-1)=0.33... wait)
    // bbWidth=0.025, MAX=0.015: ratio=0.025/0.015=1.667, compression=1-(1.667-1)=0.333
    // chopScore = 0×0.4 + 0.56×0.35 + 0.333×0.25 = 0 + 0.196 + 0.083 = 0.279 < 0.55
    expect(result.isChoppy).toBe(false);
    expect(result.flipRate).toBe(0.0);
  });

  it('choppy market: score=0.51, bbWidth=0.008, history=[long,short,long,short] → isChoppy=true', () => {
    const history: SignalHistoryEntry[] = [
      { direction: 'long',  score: 0.52, ts: Date.now() - 40000 },
      { direction: 'short', score: 0.48, ts: Date.now() - 25000 },
      { direction: 'long',  score: 0.51, ts: Date.now() - 10000 },
      { direction: 'short', score: 0.49, ts: Date.now() - 3000 },
    ];
    const result = detector.evaluate({ score: 0.51, bbWidth: 0.008 }, history);
    // flipRate = 3 flips / (4-1) = 1.0
    // momNeutrality = 1 - |0.51-0.5|/0.5 = 1 - 0.02 = 0.98
    // bbCompression: ratio=0.008/0.015=0.533, compression=1-(0.533-1)=1.467→clamped 1.0
    // chopScore = 1.0×0.4 + 0.98×0.35 + 1.0×0.25 = 0.4 + 0.343 + 0.25 = 0.993
    expect(result.isChoppy).toBe(true);
    expect(result.flipRate).toBe(1.0);
    expect(result.momNeutrality).toBeCloseTo(0.98, 5);
    expect(result.bbCompression).toBe(1.0);
    expect(result.chopScore).toBeCloseTo(0.993, 2);
  });
});
