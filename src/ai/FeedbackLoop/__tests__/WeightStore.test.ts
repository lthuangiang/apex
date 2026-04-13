import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

// We need WEIGHTS_FILE to point at a temp dir. Since it's computed at module
// load time via process.cwd(), we spy on process.cwd() BEFORE importing the
// module, then re-import fresh each time using dynamic import + vi.resetModules().

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'weight-store-test-'));
const weightsFile = path.join(tmpDir, 'signal-weights.json');

describe('WeightStore', () => {
  let WeightStore: typeof import('../WeightStore').WeightStore;
  let DEFAULT_WEIGHTS: typeof import('../WeightStore').DEFAULT_WEIGHTS;

  beforeEach(async () => {
    // Remove any leftover weights file from a previous test
    if (fs.existsSync(weightsFile)) fs.unlinkSync(weightsFile);
    if (fs.existsSync(weightsFile + '.tmp')) fs.unlinkSync(weightsFile + '.tmp');

    // Point process.cwd() at our temp dir so WEIGHTS_FILE resolves there
    vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);

    // Fresh module import so WEIGHTS_FILE is re-evaluated with the spy active
    vi.resetModules();
    const mod = await import('../WeightStore');
    WeightStore = mod.WeightStore;
    DEFAULT_WEIGHTS = mod.DEFAULT_WEIGHTS;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('round-trip persistence: setWeights then loadFromDisk on a new instance returns the same weights', () => {
    const w = { ema: 0.40, rsi: 0.25, momentum: 0.20, imbalance: 0.15 };

    // Write via one instance
    const store1 = new WeightStore();
    store1.setWeights(w);

    // Read via a fresh instance
    const store2 = new WeightStore();
    store2.loadFromDisk();

    const loaded = store2.getWeights();
    expect(loaded.ema).toBeCloseTo(w.ema);
    expect(loaded.rsi).toBeCloseTo(w.rsi);
    expect(loaded.momentum).toBeCloseTo(w.momentum);
    expect(loaded.imbalance).toBeCloseTo(w.imbalance);
  });

  it('missing file fallback: getWeights() returns DEFAULT_WEIGHTS when signal-weights.json does not exist', () => {
    // File was cleaned up in beforeEach — just create a fresh store and load
    const store = new WeightStore();
    store.loadFromDisk();

    const weights = store.getWeights();
    expect(weights.ema).toBe(DEFAULT_WEIGHTS.ema);
    expect(weights.rsi).toBe(DEFAULT_WEIGHTS.rsi);
    expect(weights.momentum).toBe(DEFAULT_WEIGHTS.momentum);
    expect(weights.imbalance).toBe(DEFAULT_WEIGHTS.imbalance);
  });

  it('corrupt JSON fallback: getWeights() returns DEFAULT_WEIGHTS when signal-weights.json contains invalid JSON', () => {
    fs.writeFileSync(weightsFile, '{ this is not valid json !!!', 'utf-8');

    const store = new WeightStore();
    store.loadFromDisk();

    const weights = store.getWeights();
    expect(weights.ema).toBe(DEFAULT_WEIGHTS.ema);
    expect(weights.rsi).toBe(DEFAULT_WEIGHTS.rsi);
    expect(weights.momentum).toBe(DEFAULT_WEIGHTS.momentum);
    expect(weights.imbalance).toBe(DEFAULT_WEIGHTS.imbalance);
  });

  it('invalid weights fallback (sum ≠ 1.0): getWeights() returns DEFAULT_WEIGHTS', () => {
    // Weights that are individually in-bounds but don't sum to 1.0
    const bad = { ema: 0.30, rsi: 0.30, momentum: 0.30, imbalance: 0.30 }; // sum = 1.20
    fs.writeFileSync(weightsFile, JSON.stringify(bad), 'utf-8');

    const store = new WeightStore();
    store.loadFromDisk();

    const weights = store.getWeights();
    expect(weights.ema).toBe(DEFAULT_WEIGHTS.ema);
    expect(weights.rsi).toBe(DEFAULT_WEIGHTS.rsi);
    expect(weights.momentum).toBe(DEFAULT_WEIGHTS.momentum);
    expect(weights.imbalance).toBe(DEFAULT_WEIGHTS.imbalance);
  });

  it('invalid weights fallback (out-of-bounds): getWeights() returns DEFAULT_WEIGHTS', () => {
    // ema is below MIN_WEIGHT (0.05)
    const bad = { ema: 0.01, rsi: 0.33, momentum: 0.33, imbalance: 0.33 };
    fs.writeFileSync(weightsFile, JSON.stringify(bad), 'utf-8');

    const store = new WeightStore();
    store.loadFromDisk();

    const weights = store.getWeights();
    expect(weights.ema).toBe(DEFAULT_WEIGHTS.ema);
    expect(weights.rsi).toBe(DEFAULT_WEIGHTS.rsi);
    expect(weights.momentum).toBe(DEFAULT_WEIGHTS.momentum);
    expect(weights.imbalance).toBe(DEFAULT_WEIGHTS.imbalance);
  });
});
