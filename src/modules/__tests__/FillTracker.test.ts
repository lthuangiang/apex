import { describe, it, expect, beforeEach } from 'vitest';
import * as fc from 'fast-check';
import { FillTracker } from '../FillTracker';
import { config } from '../../config';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeFillTracker() {
  return new FillTracker();
}

// ─── Task 7.1: recordFill / recordCancel basic behaviour ─────────────────────

describe('7.1 recordFill and recordCancel', () => {
  it('recordFill adds a filled=true record: sampleSize=1, fillRate=1.0', () => {
    const tracker = makeFillTracker();
    tracker.recordFill('entry', 100);
    const stats = tracker.getFillStats('entry');
    expect(stats.sampleSize).toBe(1);
    expect(stats.fillRate).toBe(1.0);
  });

  it('recordCancel adds a filled=false record: sampleSize=1, fillRate=0.0', () => {
    const tracker = makeFillTracker();
    tracker.recordCancel('entry');
    const stats = tracker.getFillStats('entry');
    expect(stats.sampleSize).toBe(1);
    expect(stats.fillRate).toBe(0.0);
  });

  it('exit type is tracked independently from entry', () => {
    const tracker = makeFillTracker();
    tracker.recordFill('exit', 50);
    expect(tracker.getFillStats('entry').sampleSize).toBe(0);
    expect(tracker.getFillStats('exit').sampleSize).toBe(1);
  });
});

// ─── Task 7.2: Ring buffer evicts oldest when full ────────────────────────────

describe('7.2 ring buffer eviction', () => {
  it('buffer length stays <= EXEC_FILL_WINDOW after overflow', () => {
    const tracker = makeFillTracker();
    const window = config.EXEC_FILL_WINDOW;

    // Fill exactly EXEC_FILL_WINDOW records
    for (let i = 0; i < window; i++) {
      tracker.recordFill('entry', i * 10);
    }
    expect(tracker.getFillStats('entry').sampleSize).toBe(window);

    // Add one more — oldest should be evicted
    tracker.recordFill('entry', 9999);
    expect(tracker.getFillStats('entry').sampleSize).toBe(window);
  });

  it('buffer length never exceeds EXEC_FILL_WINDOW after many records', () => {
    const tracker = makeFillTracker();
    const window = config.EXEC_FILL_WINDOW;

    for (let i = 0; i < window * 3; i++) {
      tracker.recordFill('entry', i);
    }
    expect(tracker.getFillStats('entry').sampleSize).toBeLessThanOrEqual(window);
  });
});

// ─── Task 7.3: Empty buffer defaults ─────────────────────────────────────────

describe('7.3 getFillStats on empty buffer', () => {
  it('returns fillRate=1.0, avgFillMs=0, sampleSize=0 for a new tracker', () => {
    const tracker = makeFillTracker();
    const stats = tracker.getFillStats('entry');
    expect(stats).toEqual({ fillRate: 1.0, avgFillMs: 0, sampleSize: 0 });
  });

  it('exit buffer also returns defaults when empty', () => {
    const tracker = makeFillTracker();
    const stats = tracker.getFillStats('exit');
    expect(stats).toEqual({ fillRate: 1.0, avgFillMs: 0, sampleSize: 0 });
  });
});

// ─── Task 7.4: Correct fillRate and avgFillMs for known sequences ─────────────

describe('7.4 getFillStats computes correct fillRate and avgFillMs', () => {
  it('3 fills (100ms, 200ms, 300ms) + 1 cancel → fillRate=0.75, avgFillMs=200', () => {
    const tracker = makeFillTracker();
    tracker.recordFill('entry', 100);
    tracker.recordFill('entry', 200);
    tracker.recordFill('entry', 300);
    tracker.recordCancel('entry');

    const stats = tracker.getFillStats('entry');
    expect(stats.sampleSize).toBe(4);
    expect(stats.fillRate).toBe(0.75);
    expect(stats.avgFillMs).toBe(200);
  });

  it('all cancels → fillRate=0, avgFillMs=0', () => {
    const tracker = makeFillTracker();
    tracker.recordCancel('entry');
    tracker.recordCancel('entry');

    const stats = tracker.getFillStats('entry');
    expect(stats.fillRate).toBe(0);
    expect(stats.avgFillMs).toBe(0);
  });

  it('single fill → fillRate=1.0, avgFillMs equals that fill time', () => {
    const tracker = makeFillTracker();
    tracker.recordFill('entry', 500);

    const stats = tracker.getFillStats('entry');
    expect(stats.fillRate).toBe(1.0);
    expect(stats.avgFillMs).toBe(500);
  });
});

// ─── Task 7.5: reset() clears both buffers ────────────────────────────────────

describe('7.5 reset()', () => {
  it('clears both entry and exit buffers', () => {
    const tracker = makeFillTracker();
    tracker.recordFill('entry', 100);
    tracker.recordCancel('exit');

    tracker.reset();

    expect(tracker.getFillStats('entry').sampleSize).toBe(0);
    expect(tracker.getFillStats('exit').sampleSize).toBe(0);
  });

  it('after reset, defaults are restored', () => {
    const tracker = makeFillTracker();
    tracker.recordFill('entry', 100);
    tracker.reset();

    expect(tracker.getFillStats('entry')).toEqual({ fillRate: 1.0, avgFillMs: 0, sampleSize: 0 });
  });
});

// ─── Task 7.6: Property — buffer.length <= EXEC_FILL_WINDOW ──────────────────
// Validates: Requirements 5.1 (ring buffer bounded)

describe('7.6 Property: buffer.length <= EXEC_FILL_WINDOW after any record sequence', () => {
  it('sampleSize never exceeds EXEC_FILL_WINDOW for any sequence of calls', () => {
    const window = config.EXEC_FILL_WINDOW;

    // Arbitrary: sequence of actions — true = recordFill, false = recordCancel
    const arbAction = fc.record({
      isFill: fc.boolean(),
      fillMs: fc.integer({ min: 0, max: 10000 }),
      type: fc.constantFrom('entry' as const, 'exit' as const),
    });
    const arbSequence = fc.array(arbAction, { minLength: 0, maxLength: window * 5 });

    fc.assert(
      fc.property(arbSequence, (actions) => {
        const tracker = makeFillTracker();
        for (const { isFill, fillMs, type } of actions) {
          if (isFill) {
            tracker.recordFill(type, fillMs);
          } else {
            tracker.recordCancel(type);
          }
        }
        expect(tracker.getFillStats('entry').sampleSize).toBeLessThanOrEqual(window);
        expect(tracker.getFillStats('exit').sampleSize).toBeLessThanOrEqual(window);
      }),
      { numRuns: 200 }
    );
  });
});

// ─── Task 7.7: Property — fillRate ∈ [0, 1] for any record sequence ──────────
// Validates: Requirements 5.2 (fill rate always valid)

describe('7.7 Property: getFillStats().fillRate ∈ [0, 1] for any record sequence', () => {
  it('fillRate is always in [0, 1]', () => {
    const window = config.EXEC_FILL_WINDOW;

    const arbAction = fc.record({
      isFill: fc.boolean(),
      fillMs: fc.integer({ min: 0, max: 10000 }),
      type: fc.constantFrom('entry' as const, 'exit' as const),
    });
    const arbSequence = fc.array(arbAction, { minLength: 0, maxLength: window * 5 });

    fc.assert(
      fc.property(arbSequence, (actions) => {
        const tracker = makeFillTracker();
        for (const { isFill, fillMs, type } of actions) {
          if (isFill) {
            tracker.recordFill(type, fillMs);
          } else {
            tracker.recordCancel(type);
          }
        }
        const entryStats = tracker.getFillStats('entry');
        const exitStats = tracker.getFillStats('exit');
        expect(entryStats.fillRate).toBeGreaterThanOrEqual(0);
        expect(entryStats.fillRate).toBeLessThanOrEqual(1);
        expect(exitStats.fillRate).toBeGreaterThanOrEqual(0);
        expect(exitStats.fillRate).toBeLessThanOrEqual(1);
      }),
      { numRuns: 200 }
    );
  });
});
