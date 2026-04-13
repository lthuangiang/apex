import * as fs from 'fs';
import * as path from 'path';

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

const WEIGHTS_FILE = path.join(process.cwd(), 'signal-weights.json');
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

  /** Update in-memory weights and persist to disk. */
  setWeights(w: SignalWeights): void {
    this.weights = { ...w };
    this.saveToDisk();
  }

  /**
   * Load weights from signal-weights.json.
   * Falls back to DEFAULT_WEIGHTS (with a warning) if the file is missing,
   * contains invalid JSON, or fails validation. Never throws.
   */
  loadFromDisk(): void {
    if (!fs.existsSync(WEIGHTS_FILE)) {
      this.weights = { ...DEFAULT_WEIGHTS };
      return;
    }

    let raw: string;
    try {
      raw = fs.readFileSync(WEIGHTS_FILE, 'utf-8');
    } catch (err) {
      console.warn('[WeightStore] Failed to read signal-weights.json, using defaults:', err);
      this.weights = { ...DEFAULT_WEIGHTS };
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      console.warn('[WeightStore] signal-weights.json contains invalid JSON, using defaults.');
      this.weights = { ...DEFAULT_WEIGHTS };
      return;
    }

    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      console.warn('[WeightStore] signal-weights.json has unexpected format, using defaults.');
      this.weights = { ...DEFAULT_WEIGHTS };
      return;
    }

    const candidate = parsed as SignalWeights;
    if (!validateWeights(candidate)) {
      console.warn('[WeightStore] signal-weights.json failed validation (bad sum or out-of-bounds weights), using defaults.');
      this.weights = { ...DEFAULT_WEIGHTS };
      return;
    }

    this.weights = {
      ema: candidate.ema,
      rsi: candidate.rsi,
      momentum: candidate.momentum,
      imbalance: candidate.imbalance,
      ...(candidate.updatedAt !== undefined ? { updatedAt: candidate.updatedAt } : {}),
      ...(candidate.tradeCount !== undefined ? { tradeCount: candidate.tradeCount } : {}),
    };
  }

  /**
   * Atomically persist current weights to signal-weights.json via a .tmp rename.
   * Logs error on failure but does not throw.
   */
  saveToDisk(): void {
    const tmpFile = WEIGHTS_FILE + '.tmp';
    try {
      fs.writeFileSync(tmpFile, JSON.stringify(this.weights, null, 2), 'utf-8');
      fs.renameSync(tmpFile, WEIGHTS_FILE);
    } catch (err) {
      console.error('[WeightStore] Failed to save signal-weights.json:', err);
      // Clean up orphaned .tmp if rename failed
      try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
    }
  }
}

export const weightStore = new WeightStore();
