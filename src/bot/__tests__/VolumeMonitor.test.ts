import { describe, it, expect, vi } from 'vitest';
import { VolumeMonitor } from '../VolumeMonitor.js';
import type { ExchangeAdapter } from '../../adapters/ExchangeAdapter.js';

// Minimal mock adapter — only get_recent_trades is exercised by VolumeMonitor
const mockAdapter: ExchangeAdapter = {
  get_mark_price: vi.fn(),
  get_orderbook: vi.fn(),
  place_limit_order: vi.fn(),
  cancel_order: vi.fn(),
  cancel_all_orders: vi.fn(),
  get_open_orders: vi.fn(),
  get_position: vi.fn(),
  get_balance: vi.fn(),
  get_orderbook_depth: vi.fn(),
  get_recent_trades: vi.fn(),
};

// Helper: build a VolumeMonitor with a given window size and spike multiplier
function makeMonitor(windowSize: number, spikeMultiplier = 2.0): VolumeMonitor {
  return new VolumeMonitor(mockAdapter, 'BTC-USD', 'ETH-USD', windowSize, spikeMultiplier);
}

// Helper: fill a window to exactly `count` samples using the _addSample helpers
function fillWindowA(monitor: VolumeMonitor, values: number[]): void {
  for (const v of values) monitor._addSampleA(v);
}

function fillWindowB(monitor: VolumeMonitor, values: number[]): void {
  for (const v of values) monitor._addSampleB(v);
}

describe('VolumeMonitor', () => {
  // ─── Rolling window mechanics ────────────────────────────────────────────────

  describe('rolling window — overflow / FIFO eviction (Requirements 3.1, 3.2)', () => {
    it('should keep the window at exactly windowSize after overflow', () => {
      const monitor = makeMonitor(3);

      fillWindowA(monitor, [1, 2, 3, 4]); // 4 samples into a window of size 3

      expect(monitor.getWindowA()).toHaveLength(3);
    });

    it('should discard the oldest element when the window overflows', () => {
      const monitor = makeMonitor(3);

      fillWindowA(monitor, [10, 20, 30]); // window is now full: [10, 20, 30]
      monitor._addSampleA(40);            // oldest (10) should be evicted → [20, 30, 40]

      expect(monitor.getWindowA()).toEqual([20, 30, 40]);
    });

    it('should retain the most recently added sample as the last element', () => {
      const monitor = makeMonitor(3);

      fillWindowA(monitor, [1, 2, 3, 99]);

      const window = monitor.getWindowA();
      expect(window[window.length - 1]).toBe(99);
    });

    it('should apply the same FIFO eviction logic to windowB', () => {
      const monitor = makeMonitor(3);

      fillWindowB(monitor, [5, 10, 15]); // full: [5, 10, 15]
      monitor._addSampleB(20);           // evict 5 → [10, 15, 20]

      expect(monitor.getWindowB()).toEqual([10, 15, 20]);
    });

    it('should not evict elements while the window is not yet full', () => {
      const monitor = makeMonitor(5);

      fillWindowA(monitor, [1, 2, 3]);

      expect(monitor.getWindowA()).toEqual([1, 2, 3]);
    });

    it('getWindowA / getWindowB should return copies, not internal references', () => {
      const monitor = makeMonitor(3);
      fillWindowA(monitor, [1, 2, 3]);

      const copy = monitor.getWindowA();
      copy.push(999);

      // Internal window must be unaffected
      expect(monitor.getWindowA()).toHaveLength(3);
    });
  });

  // ─── shouldEnter() — windows not full ────────────────────────────────────────

  describe('shouldEnter() — returns false when windows are not full (Requirement 3.5)', () => {
    it('should return false when both windows are empty', () => {
      const monitor = makeMonitor(5);
      expect(monitor.shouldEnter()).toBe(false);
    });

    it('should return false when windowA is full but windowB is empty', () => {
      const monitor = makeMonitor(3);
      fillWindowA(monitor, [100, 100, 100]);
      // windowB is empty
      expect(monitor.shouldEnter()).toBe(false);
    });

    it('should return false when windowB is full but windowA is empty', () => {
      const monitor = makeMonitor(3);
      fillWindowB(monitor, [100, 100, 100]);
      // windowA is empty
      expect(monitor.shouldEnter()).toBe(false);
    });

    it('should return false when both windows have samples but neither is full', () => {
      const monitor = makeMonitor(5);
      fillWindowA(monitor, [10, 20]);  // 2 of 5
      fillWindowB(monitor, [10, 20]);  // 2 of 5
      expect(monitor.shouldEnter()).toBe(false);
    });

    it('should return false when one window is full and the other has one fewer sample', () => {
      const monitor = makeMonitor(4);
      fillWindowA(monitor, [10, 10, 10, 10]); // full
      fillWindowB(monitor, [10, 10, 10]);      // one short
      expect(monitor.shouldEnter()).toBe(false);
    });
  });

  // ─── shouldEnter() — only one symbol spikes ──────────────────────────────────

  describe('shouldEnter() — returns false when only one symbol spikes (Requirement 3.4)', () => {
    it('should return false when only symbolA spikes', () => {
      // windowSize=4, multiplier=2.0
      // windowA baseline: [10, 10, 10, 10] → avg=10; spike threshold = 10*2 = 20
      // last sample for A = 25 → spikes ✓
      // windowB baseline: [10, 10, 10, 10] → avg=10; spike threshold = 20
      // last sample for B = 15 → does NOT spike ✗
      const monitor = makeMonitor(4, 2.0);

      fillWindowA(monitor, [10, 10, 10, 25]); // last sample is the "current" volume
      fillWindowB(monitor, [10, 10, 10, 15]);

      expect(monitor.shouldEnter()).toBe(false);
    });

    it('should return false when only symbolB spikes', () => {
      const monitor = makeMonitor(4, 2.0);

      fillWindowA(monitor, [10, 10, 10, 15]); // does NOT spike
      fillWindowB(monitor, [10, 10, 10, 25]); // spikes

      expect(monitor.shouldEnter()).toBe(false);
    });

    it('should return false when neither symbol spikes', () => {
      const monitor = makeMonitor(4, 2.0);

      fillWindowA(monitor, [10, 10, 10, 12]); // 12 < 10*2=20 → no spike
      fillWindowB(monitor, [10, 10, 10, 12]);

      expect(monitor.shouldEnter()).toBe(false);
    });

    it('should return false when current volume equals exactly the spike threshold (not strictly greater)', () => {
      // Spike condition is strictly greater-than: currentVolume > avg * multiplier
      // avg = (10+10+10) / 3 = 10, multiplier = 2.0, threshold = 20
      // current = 20 → NOT a spike (must be > 20)
      const monitor = makeMonitor(4, 2.0);

      fillWindowA(monitor, [10, 10, 10, 20]); // exactly at threshold — not a spike
      fillWindowB(monitor, [10, 10, 10, 20]);

      expect(monitor.shouldEnter()).toBe(false);
    });
  });

  // ─── shouldEnter() — both symbols spike ──────────────────────────────────────

  describe('shouldEnter() — returns true when both symbols spike with full windows (Requirements 3.3, 3.4, 3.5)', () => {
    it('should return true when both windows are full and both show a spike', () => {
      // windowSize=4, multiplier=2.0
      // windowA: [10, 10, 10, 25] → avg of first 3 = 10, current = 25 > 10*2=20 ✓
      // windowB: [10, 10, 10, 30] → avg of first 3 = 10, current = 30 > 20 ✓
      // Note: avg is computed over the FULL window including the current sample
      // avg([10,10,10,25]) = 13.75; current=25 > 13.75*2=27.5? No — let's use a clearer setup.
      //
      // Use a window where the spike is unambiguous regardless of whether avg includes current:
      // baseline samples all = 1, current = 100, multiplier = 2.0
      // avg([1,1,1,100]) = 25.75; 100 > 25.75*2=51.5 ✓
      const monitor = makeMonitor(4, 2.0);

      fillWindowA(monitor, [1, 1, 1, 100]);
      fillWindowB(monitor, [1, 1, 1, 100]);

      expect(monitor.shouldEnter()).toBe(true);
    });

    it('should return true with a custom spike multiplier', () => {
      // multiplier = 1.5; baseline = 10; current must be > 10*1.5 = 15
      const monitor = makeMonitor(3, 1.5);

      fillWindowA(monitor, [10, 10, 20]); // avg([10,10,20])=13.33; 20 > 13.33*1.5=20? 20 > 20 is false
      // Use a clearer spike: baseline=10, current=50
      const monitor2 = makeMonitor(3, 1.5);
      fillWindowA(monitor2, [10, 10, 50]); // avg=23.33; 50 > 23.33*1.5=35 ✓
      fillWindowB(monitor2, [10, 10, 50]);

      expect(monitor2.shouldEnter()).toBe(true);
    });

    it('should return true immediately after the window becomes full with a spike', () => {
      const monitor = makeMonitor(3, 2.0);

      // Add 2 samples (window not yet full)
      monitor._addSampleA(5);
      monitor._addSampleB(5);
      expect(monitor.shouldEnter()).toBe(false);

      // Add 2 more samples (window not yet full for size=3)
      monitor._addSampleA(5);
      monitor._addSampleB(5);
      expect(monitor.shouldEnter()).toBe(false);

      // Third sample fills the window — make it a spike
      monitor._addSampleA(100); // avg([5,5,100])=36.67; 100 > 36.67*2=73.33 ✓
      monitor._addSampleB(100);
      expect(monitor.shouldEnter()).toBe(true);
    });

    it('should return false again after a spike sample is replaced by a non-spike sample', () => {
      const monitor = makeMonitor(3, 2.0);

      // Fill with a spike
      fillWindowA(monitor, [1, 1, 100]); // avg=34; 100 > 68 ✓
      fillWindowB(monitor, [1, 1, 100]);
      expect(monitor.shouldEnter()).toBe(true);

      // Add a non-spike sample — the spike sample (100) is now the middle element
      // new window: [1, 100, 5] → avg=35.33; current=5 < 70.67 → no spike
      monitor._addSampleA(5);
      monitor._addSampleB(5);
      expect(monitor.shouldEnter()).toBe(false);
    });
  });

  // ─── sample() — adapter integration ──────────────────────────────────────────

  describe('sample() — fetches trades and updates windows (Requirement 3.6)', () => {
    it('should sum trade sizes and add the result to both windows', async () => {
      const adapter: ExchangeAdapter = {
        ...mockAdapter,
        get_recent_trades: vi.fn()
          .mockResolvedValueOnce([
            { side: 'buy', price: 50000, size: 1.5, timestamp: 1 },
            { side: 'sell', price: 50000, size: 0.5, timestamp: 2 },
          ])
          .mockResolvedValueOnce([
            { side: 'buy', price: 3000, size: 10, timestamp: 1 },
            { side: 'buy', price: 3000, size: 5, timestamp: 2 },
          ]),
      };

      const monitor = new VolumeMonitor(adapter, 'BTC-USD', 'ETH-USD', 5, 2.0);
      await monitor.sample();

      expect(monitor.getWindowA()).toEqual([2.0]);  // 1.5 + 0.5
      expect(monitor.getWindowB()).toEqual([15]);   // 10 + 5
    });

    it('should call get_recent_trades for both symbols in parallel', async () => {
      const get_recent_trades = vi.fn().mockResolvedValue([]);
      const adapter: ExchangeAdapter = { ...mockAdapter, get_recent_trades };

      const monitor = new VolumeMonitor(adapter, 'BTC-USD', 'ETH-USD', 5, 2.0);
      await monitor.sample();

      expect(get_recent_trades).toHaveBeenCalledTimes(2);
      expect(get_recent_trades).toHaveBeenCalledWith('BTC-USD', 5);
      expect(get_recent_trades).toHaveBeenCalledWith('ETH-USD', 5);
    });
  });

  // ─── Rolling average helpers ──────────────────────────────────────────────────

  describe('getRollingAverageA / getRollingAverageB', () => {
    it('should return 0 when the window is empty', () => {
      const monitor = makeMonitor(5);
      expect(monitor.getRollingAverageA()).toBe(0);
      expect(monitor.getRollingAverageB()).toBe(0);
    });

    it('should return the correct mean of all samples in the window', () => {
      const monitor = makeMonitor(4);
      fillWindowA(monitor, [10, 20, 30, 40]);
      expect(monitor.getRollingAverageA()).toBe(25); // (10+20+30+40)/4
    });

    it('should recompute the average after overflow evicts the oldest sample', () => {
      const monitor = makeMonitor(3);
      fillWindowA(monitor, [10, 20, 30]); // avg = 20
      monitor._addSampleA(40);            // window becomes [20, 30, 40], avg = 30
      expect(monitor.getRollingAverageA()).toBeCloseTo(30);
    });
  });
});
