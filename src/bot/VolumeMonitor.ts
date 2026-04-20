import type { ExchangeAdapter } from '../adapters/ExchangeAdapter.js';

/**
 * VolumeMonitor tracks real-time volume for two symbols using rolling FIFO windows
 * and detects simultaneous volume spikes on both symbols.
 *
 * Each sample() call measures volume within a recent time window (intervalMs)
 * rather than summing a fixed number of trades. This makes spike detection
 * meaningful regardless of how many trades occur per tick.
 *
 * Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6
 */
export class VolumeMonitor {
  private windowA: number[] = [];
  private windowB: number[] = [];

  /**
   * How many recent trades to fetch per sample call.
   * Keep low to reduce API payload and rate limit pressure.
   */
  private readonly fetchLimit = 20;

  /**
   * Time window in milliseconds for each volume sample.
   * Only trades within the last `intervalMs` are counted.
   * Default: 5 seconds.
   */
  private readonly intervalMs: number;

  constructor(
    private adapter: ExchangeAdapter,
    private symbolA: string,
    private symbolB: string,
    private windowSize: number,
    private spikeMultiplier: number,
    intervalMs = 30_000,
  ) {
    this.intervalMs = intervalMs;
  }

  /**
   * Fetch the latest volume sample for both symbols and update rolling windows.
   * Volume is computed by summing trade.size values for trades within the last
   * `intervalMs` milliseconds. This gives a consistent time-based measurement
   * rather than a fixed trade count, making spike detection reliable.
   * Requirements: 3.6
   */
  async sample(): Promise<void> {
    const cutoff = Date.now() - this.intervalMs;

    const [tradesA, tradesB] = await Promise.all([
      this.adapter.get_recent_trades(this.symbolA, this.fetchLimit),
      this.adapter.get_recent_trades(this.symbolB, this.fetchLimit),
    ]);

    // Sum only trades within the time window
    const volumeA = tradesA
      .filter(t => t.timestamp >= cutoff)
      .reduce((sum, t) => sum + t.size, 0);

    const volumeB = tradesB
      .filter(t => t.timestamp >= cutoff)
      .reduce((sum, t) => sum + t.size, 0);

    this._addSampleA(volumeA);
    this._addSampleB(volumeB);

    // Debug log so we can see what the monitor is measuring
    if (this.windowA.length >= this.windowSize) {
      const avgA = this.getRollingAverageA();
      const avgB = this.getRollingAverageB();
      const currentA = this.windowA[this.windowA.length - 1];
      const currentB = this.windowB[this.windowB.length - 1];
      const threshA = (avgA * this.spikeMultiplier).toFixed(4);
      const threshB = (avgB * this.spikeMultiplier).toFixed(4);
      const spikeA = currentA > avgA * this.spikeMultiplier;
      const spikeB = currentB > avgB * this.spikeMultiplier;
      const pctA = avgA > 0 ? ((currentA / (avgA * this.spikeMultiplier)) * 100).toFixed(0) : '—';
      const pctB = avgB > 0 ? ((currentB / (avgB * this.spikeMultiplier)) * 100).toFixed(0) : '—';
      console.log(
        `[VolumeMonitor] ${this.symbolA} vol=${currentA.toFixed(4)} avg=${avgA.toFixed(4)} threshold=${threshA} ${pctA}% ${spikeA ? '🔥 SPIKE' : '——'} | ` +
        `${this.symbolB} vol=${currentB.toFixed(4)} avg=${avgB.toFixed(4)} threshold=${threshB} ${pctB}% ${spikeB ? '🔥 SPIKE' : '——'}` +
        (spikeA && spikeB ? ' ✅ BOTH SPIKE → ENTER' : ''),
      );
    } else {
      console.log(
        `[VolumeMonitor] Filling window ${this.windowA.length}/${this.windowSize} — ` +
        `${this.symbolA}=${volumeA.toFixed(4)} ${this.symbolB}=${volumeB.toFixed(4)}`,
      );
    }
  }

  /**
   * Returns true only when both windows are full AND both show a volume spike.
   * Spike condition: currentVolume > rollingAverage * spikeMultiplier
   * Requirements: 3.3, 3.4, 3.5
   */
  shouldEnter(): boolean {
    // Both windows must be full (Requirement 3.5)
    if (this.windowA.length < this.windowSize || this.windowB.length < this.windowSize) {
      return false;
    }

    const avgA = this.getRollingAverageA();
    const avgB = this.getRollingAverageB();

    // Need a valid baseline — if all samples are zero, no spike is possible
    if (avgA === 0 || avgB === 0) {
      return false;
    }

    // The most recently added sample is the "current" volume
    const currentA = this.windowA[this.windowA.length - 1];
    const currentB = this.windowB[this.windowB.length - 1];

    const spikeA = currentA > avgA * this.spikeMultiplier;
    const spikeB = currentB > avgB * this.spikeMultiplier;

    // Both must spike simultaneously (Requirement 3.4)
    return spikeA && spikeB;
  }

  /**
   * Returns a copy of the rolling window for symbolA.
   */
  getWindowA(): number[] {
    return [...this.windowA];
  }

  /**
   * Returns a copy of the rolling window for symbolB.
   */
  getWindowB(): number[] {
    return [...this.windowB];
  }

  /**
   * Returns the rolling average of symbolA's window.
   * Only counts non-zero samples to avoid diluting the baseline with empty ticks.
   * Returns 0 if the window is empty or all samples are zero.
   */
  getRollingAverageA(): number {
    const nonZero = this.windowA.filter(v => v > 0);
    if (nonZero.length === 0) return 0;
    return nonZero.reduce((sum, v) => sum + v, 0) / nonZero.length;
  }

  /**
   * Returns the rolling average of symbolB's window.
   * Only counts non-zero samples to avoid diluting the baseline with empty ticks.
   * Returns 0 if the window is empty or all samples are zero.
   */
  getRollingAverageB(): number {
    const nonZero = this.windowB.filter(v => v > 0);
    if (nonZero.length === 0) return 0;
    return nonZero.reduce((sum, v) => sum + v, 0) / nonZero.length;
  }

  /**
   * Internal helper: directly add a sample to windowA without calling the adapter.
   * Used by property tests to populate the window deterministically.
   * Requirements: 3.1, 3.2
   */
  _addSampleA(v: number): void {
    if (this.windowA.length >= this.windowSize) {
      this.windowA.shift(); // discard oldest (FIFO)
    }
    this.windowA.push(v);
  }

  /**
   * Internal helper: directly add a sample to windowB without calling the adapter.
   * Used by property tests to populate the window deterministically.
   * Requirements: 3.1, 3.2
   */
  _addSampleB(v: number): void {
    if (this.windowB.length >= this.windowSize) {
      this.windowB.shift(); // discard oldest (FIFO)
    }
    this.windowB.push(v);
  }
}
