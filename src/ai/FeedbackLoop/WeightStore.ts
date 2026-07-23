import { loadWeights, saveWeights } from '../../db/WeightRepository.js';

export interface SignalWeights {
  ema: number;        // [0.05, 0.60]
  rsi: number;        // [0.05, 0.60]
  momentum: number;   // [0.05, 0.60]
  imbalance: number;  // [0.05, 0.60]
  updatedAt?: string; // ISO 8601
  tradeCount?: number;
}

export interface WeightStoreInterface {
  getWeights(): SignalWeights;
  setWeights(w: SignalWeights): void;
  loadFromDisk(): void;
  saveToDisk(): void;
}

export const DEFAULT_WEIGHTS: SignalWeights = {
  ema: 0.40,
  rsi: 0.25,
  momentum: 0.20,
  imbalance: 0.15,
};

const MIN_WEIGHT = 0.05;
const MAX_WEIGHT = 0.60;
const SUM_TOLERANCE = 0.001;

function validateWeights(w: SignalWeights): boolean {
  const keys: (keyof Pick<SignalWeights, 'ema' | 'rsi' | 'momentum' | 'imbalance'>)[] = [
    'ema', 'rsi', 'momentum', 'imbalance',
  ];
  for (const key of keys) {
    const val = w[key];
    if (typeof val !== 'number' || val < MIN_WEIGHT || val > MAX_WEIGHT) return false;
  }
  const sum = w.ema + w.rsi + w.momentum + w.imbalance;
  return Math.abs(sum - 1.0) <= SUM_TOLERANCE;
}

export class WeightStore implements WeightStoreInterface {
  private weights: SignalWeights = { ...DEFAULT_WEIGHTS };

  /** Pure in-memory read — no I/O. */
  getWeights(): SignalWeights {
    return { ...this.weights };
  }

  /** Update in-memory weights and persist to SQLite. */
  setWeights(w: SignalWeights): void {
    this.weights = { ...w };
    this.saveToDisk();
  }

  /**
   * Load weights from SQLite (signal_weights table).
   * Falls back to DEFAULT_WEIGHTS (with a warning) if loading fails
   * or validation fails. Never throws.
   */
  loadFromDisk(): void {
    try {
      const row = loadWeights();

      const candidate: SignalWeights = {
        ema: row.ema,
        rsi: row.rsi,
        momentum: row.momentum,
        imbalance: row.imbalance,
        ...(row.updatedAt ? { updatedAt: row.updatedAt } : {}),
        ...(row.tradeCount ? { tradeCount: row.tradeCount } : {}),
      };

      if (!validateWeights(candidate)) {
        console.warn('[WeightStore] SQLite weights failed validation (bad sum or out-of-bounds), using defaults.');
        this.weights = { ...DEFAULT_WEIGHTS };
        return;
      }

      this.weights = candidate;
    } catch (err) {
      console.warn('[WeightStore] Failed to load weights from SQLite, using defaults:', err);
      this.weights = { ...DEFAULT_WEIGHTS };
    }
  }

  /**
   * Persist current weights to SQLite.
   * Logs error on failure but does not throw.
   */
  saveToDisk(): void {
    try {
      saveWeights({
        ema: this.weights.ema,
        rsi: this.weights.rsi,
        momentum: this.weights.momentum,
        imbalance: this.weights.imbalance,
        updatedAt: this.weights.updatedAt ?? null,
        tradeCount: this.weights.tradeCount ?? 0,
      });
    } catch (err) {
      console.error('[WeightStore] Failed to save weights to SQLite:', err);
    }
  }
}

export const weightStore = new WeightStore();
