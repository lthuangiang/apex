import { TradeRecord } from '../TradeLogger';

export interface ConfidenceBucket {
  label: string;
  min: number;
  max: number;
  winRate: number;
  total: number;
}

const BASELINE_WIN_RATE = 0.50;
const MIN_BUCKET_TRADES = 5;

const BUCKET_DEFINITIONS: Array<{ label: string; min: number; max: number }> = [
  { label: '0.5–0.6', min: 0.5, max: 0.6 },
  { label: '0.6–0.7', min: 0.6, max: 0.7 },
  { label: '0.7–0.8', min: 0.7, max: 0.8 },
  { label: '0.8–1.0', min: 0.8, max: 1.0 },
];

class ConfidenceCalibrator {
  computeBuckets(trades: TradeRecord[]): ConfidenceBucket[] {
    return BUCKET_DEFINITIONS.map((def, i) => {
      const isLast = i === BUCKET_DEFINITIONS.length - 1;
      const bucketTrades = trades.filter((t) =>
        isLast
          ? t.confidence >= def.min && t.confidence <= 1.0
          : t.confidence >= def.min && t.confidence < def.max
      );
      const total = bucketTrades.length;
      const wins = bucketTrades.filter((t) => t.pnl > 0).length;
      const winRate = total > 0 ? wins / total : 0;
      return { label: def.label, min: def.min, max: def.max, winRate, total };
    });
  }

  calibrate(rawConf: number, trades: TradeRecord[]): number {
    const buckets = this.computeBuckets(trades);

    const bucket = buckets.find((b, i) => {
      const isLast = i === buckets.length - 1;
      return isLast
        ? rawConf >= b.min && rawConf <= 1.0
        : rawConf >= b.min && rawConf < b.max;
    });

    if (!bucket) return rawConf;
    if (bucket.total < MIN_BUCKET_TRADES) return rawConf;

    // Guard against division by zero (BASELINE_WIN_RATE is a constant 0.50, never 0)
    const historicalWinRate = bucket.winRate;
    const adjusted = rawConf * (historicalWinRate / BASELINE_WIN_RATE);

    if (!isFinite(adjusted) || isNaN(adjusted)) return rawConf;

    return Math.min(1.0, Math.max(0.10, adjusted));
  }
}

export const confidenceCalibrator = new ConfidenceCalibrator();
export { ConfidenceCalibrator, BASELINE_WIN_RATE, MIN_BUCKET_TRADES };
