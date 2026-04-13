import { describe, it, expect } from 'vitest';
import { ConfidenceCalibrator } from '../ConfidenceCalibrator';
import { TradeRecord } from '../../TradeLogger';

// Minimal fixture factory — only confidence and pnl matter for calibration logic
function makeTrade(confidence: number, pnl: number): TradeRecord {
  return {
    id: 'test',
    timestamp: '2024-01-01T00:00:00Z',
    symbol: 'BTC',
    direction: 'long',
    confidence,
    reasoning: '',
    fallback: false,
    entryPrice: 100,
    exitPrice: 110,
    pnl,
    sessionPnl: 0,
  };
}

// Build N trades in the [0.7, 0.8) bucket with a given number of wins
function bucket07Trades(total: number, wins: number): TradeRecord[] {
  return Array.from({ length: total }, (_, i) =>
    makeTrade(0.75, i < wins ? 1 : -1)
  );
}

describe('ConfidenceCalibrator', () => {
  const calibrator = new ConfidenceCalibrator();

  it('clamps adjusted confidence to 1.00 when winRate is high (0.8)', () => {
    // bucket [0.7,0.8): 10 trades, 8 wins → winRate=0.8
    // adjusted = 0.7 × (0.8/0.5) = 1.12 → clamped to 1.00
    const trades = bucket07Trades(10, 8);
    const result = calibrator.calibrate(0.7, trades);
    expect(result).toBe(1.0);
  });

  it('returns adjusted value as-is when winRate is below baseline (0.3)', () => {
    // bucket [0.7,0.8): 10 trades, 3 wins → winRate=0.3
    // adjusted = 0.7 × (0.3/0.5) = 0.42 → above 0.10, returned as-is
    const trades = bucket07Trades(10, 3);
    const result = calibrator.calibrate(0.7, trades);
    expect(result).toBeCloseTo(0.42, 5);
  });

  it('returns rawConf unchanged when bucket has fewer than 5 trades (sparse)', () => {
    // Only 4 trades in bucket — below MIN_BUCKET_TRADES
    const trades = bucket07Trades(4, 4);
    const result = calibrator.calibrate(0.7, trades);
    expect(result).toBe(0.7);
  });

  it('returns rawConf unchanged when rawConf is out of range (below 0.5)', () => {
    // rawConf=0.3 falls below all bucket definitions → no bucket found
    const trades = bucket07Trades(10, 8);
    const result = calibrator.calibrate(0.3, trades);
    expect(result).toBe(0.3);
  });

  it('clamps adjusted confidence to 0.10 when winRate is very low', () => {
    // bucket [0.7,0.8): 10 trades, 0 wins → winRate=0
    // adjusted = 0.7 × (0/0.5) = 0 → clamped to 0.10
    const trades = bucket07Trades(10, 0);
    const result = calibrator.calibrate(0.7, trades);
    expect(result).toBe(0.10);
  });

  it('clamps adjusted confidence to 1.00 when winRate is very high', () => {
    // bucket [0.7,0.8): 10 trades, 10 wins → winRate=1.0
    // adjusted = 0.7 × (1.0/0.5) = 1.4 → clamped to 1.00
    const trades = bucket07Trades(10, 10);
    const result = calibrator.calibrate(0.7, trades);
    expect(result).toBe(1.0);
  });

  it('never returns NaN or Infinity', () => {
    const scenarios: Array<[number, TradeRecord[]]> = [
      [0.7, bucket07Trades(10, 0)],
      [0.7, bucket07Trades(10, 10)],
      [0.7, bucket07Trades(10, 5)],
      [0.3, bucket07Trades(10, 8)],  // out-of-range bucket
      [0.7, bucket07Trades(3, 3)],   // sparse bucket
    ];

    for (const [rawConf, trades] of scenarios) {
      const result = calibrator.calibrate(rawConf, trades);
      expect(isNaN(result)).toBe(false);
      expect(isFinite(result)).toBe(true);
    }
  });
});

// ─── Property-Based Tests ────────────────────────────────────────────────────
// Validates: Requirements 4.4 — calibrate output ∈ [0.10, 1.00] when calibration is applied
import * as fc from 'fast-check';

describe('ConfidenceCalibrator — property-based', () => {
  const calibrator = new ConfidenceCalibrator();

  it('when calibration is applied (bucket populated with ≥5 trades), output ∈ [0.10, 1.00]', () => {
    // Generate rawConf in [0.5, 1.0] (within a defined bucket) and a trade array
    // where all trades share the same bucket as rawConf, with ≥5 trades.
    const calibratedInputArb = fc
      .float({ min: Math.fround(0.5), max: Math.fround(1.0), noNaN: true })
      .chain((rawConf) => {
        return fc
          .array(
            fc.record({
              pnl: fc.float({ min: Math.fround(-100), max: Math.fround(100), noNaN: true }),
            }),
            { minLength: 5, maxLength: 20 }
          )
          .map((partialTrades) => ({
            rawConf,
            trades: partialTrades.map((t) => ({
              id: 'test',
              timestamp: '2024-01-01T00:00:00Z',
              symbol: 'BTC',
              direction: 'long' as const,
              confidence: rawConf,
              reasoning: '',
              fallback: false,
              entryPrice: 100,
              exitPrice: 110,
              pnl: t.pnl,
              sessionPnl: 0,
            })),
          }));
      });

    fc.assert(
      fc.property(calibratedInputArb, ({ rawConf, trades }) => {
        const result = calibrator.calibrate(rawConf, trades);
        return result >= 0.10 && result <= 1.0;
      }),
      { numRuns: 500 }
    );
  });

  it('output is never NaN or Infinity for any rawConf ∈ [0, 1] and any trade array', () => {
    const tradeArb = fc.record({
      confidence: fc.float({ min: Math.fround(0), max: Math.fround(1), noNaN: true }),
      pnl: fc.float({ min: Math.fround(-1000), max: Math.fround(1000), noNaN: true }),
    });

    fc.assert(
      fc.property(
        fc.float({ min: Math.fround(0), max: Math.fround(1), noNaN: true }),
        fc.array(tradeArb, { minLength: 0, maxLength: 30 }),
        (rawConf, partialTrades) => {
          const trades = partialTrades.map((t) => ({
            id: 'test',
            timestamp: '2024-01-01T00:00:00Z',
            symbol: 'BTC',
            direction: 'long' as const,
            confidence: t.confidence,
            reasoning: '',
            fallback: false,
            entryPrice: 100,
            exitPrice: 110,
            pnl: t.pnl,
            sessionPnl: 0,
          }));
          const result = calibrator.calibrate(rawConf, trades);
          return !isNaN(result) && isFinite(result);
        }
      ),
      { numRuns: 500 }
    );
  });

  it('if output differs from rawConf, output ∈ [0.10, 1.00]', () => {
    const tradeArb = fc.record({
      confidence: fc.float({ min: Math.fround(0), max: Math.fround(1), noNaN: true }),
      pnl: fc.float({ min: Math.fround(-1000), max: Math.fround(1000), noNaN: true }),
    });

    fc.assert(
      fc.property(
        fc.float({ min: Math.fround(0), max: Math.fround(1), noNaN: true }),
        fc.array(tradeArb, { minLength: 0, maxLength: 30 }),
        (rawConf, partialTrades) => {
          const trades = partialTrades.map((t) => ({
            id: 'test',
            timestamp: '2024-01-01T00:00:00Z',
            symbol: 'BTC',
            direction: 'long' as const,
            confidence: t.confidence,
            reasoning: '',
            fallback: false,
            entryPrice: 100,
            exitPrice: 110,
            pnl: t.pnl,
            sessionPnl: 0,
          }));
          const result = calibrator.calibrate(rawConf, trades);
          // If calibration was applied (result changed), it must be in [0.10, 1.00]
          if (result !== rawConf) {
            return result >= 0.10 && result <= 1.0;
          }
          return true;
        }
      ),
      { numRuns: 500 }
    );
  });
});
