import { config } from '../config';

export type OrderType = 'entry' | 'exit';

export interface FillRecord {
  filled: boolean;
  fillMs: number;   // ms from placement to fill (or 0 if cancelled)
  ts: number;       // timestamp
}

export interface FillStats {
  fillRate: number;    // [0, 1]
  avgFillMs: number;   // average ms to fill (only filled orders), 0 if none
  sampleSize: number;  // number of records in window
}

export class FillTracker {
  private entryBuffer: FillRecord[] = [];
  private exitBuffer: FillRecord[] = [];

  private getBuffer(type: OrderType): FillRecord[] {
    return type === 'entry' ? this.entryBuffer : this.exitBuffer;
  }

  private push(type: OrderType, record: FillRecord): void {
    const buffer = this.getBuffer(type);
    buffer.push(record);
    if (buffer.length > config.EXEC_FILL_WINDOW) {
      buffer.shift();
    }
  }

  recordFill(type: OrderType, fillMs: number): void {
    this.push(type, { filled: true, fillMs, ts: Date.now() });
  }

  recordCancel(type: OrderType): void {
    this.push(type, { filled: false, fillMs: 0, ts: Date.now() });
  }

  getFillStats(type: OrderType): FillStats {
    const buffer = this.getBuffer(type);

    if (buffer.length === 0) {
      return { fillRate: 1.0, avgFillMs: 0, sampleSize: 0 };
    }

    const filledRecords = buffer.filter(r => r.filled);
    const fillRate = filledRecords.length / buffer.length;
    const avgFillMs = filledRecords.length > 0
      ? filledRecords.reduce((sum, r) => sum + r.fillMs, 0) / filledRecords.length
      : 0;

    return { fillRate, avgFillMs, sampleSize: buffer.length };
  }

  reset(): void {
    this.entryBuffer = [];
    this.exitBuffer = [];
  }
}
