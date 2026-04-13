import { config } from '../config';
import { ExchangeAdapter } from '../adapters/ExchangeAdapter';
import { FillTracker } from './FillTracker';

export interface OffsetResult {
  offset: number;          // final offset in USD, clamped to [EXEC_OFFSET_MIN, EXEC_OFFSET_MAX]
  spreadBps: number;       // (ask - bid) / bid × 10000
  spreadOk: boolean;       // spread <= EXEC_MAX_SPREAD_BPS
  depthScore: number;      // sum of (price × size) for top N levels on relevant side
  fillRatePenalty: number; // 0 or EXEC_FILL_RATE_PENALTY
}

export class ExecutionEdge {
  constructor(private adapter: ExchangeAdapter, private fillTracker: FillTracker) {}

  async computeOffset(
    symbol: string,
    direction: 'long' | 'short',
    orderbook: { best_bid: number; best_ask: number }
  ): Promise<OffsetResult> {
    const { best_bid, best_ask } = orderbook;

    // Task 3.2: spreadBps computation
    const spreadBps = (best_ask - best_bid) / best_bid * 10000;

    // Task 3.3: Spread guard
    if (spreadBps > config.EXEC_MAX_SPREAD_BPS) {
      console.warn(
        `[ExecutionEdge] Spread too wide (${spreadBps.toFixed(1)} bps > ${config.EXEC_MAX_SPREAD_BPS}). Skipping entry.`
      );
      console.log(
        `[ExecutionEdge] offset=0.00 | spread=${spreadBps.toFixed(1)}bps | depth=0k | fillPenalty=0.00 | spreadOk=false`
      );
      return { offset: 0, spreadBps, spreadOk: false, depthScore: 0, fillRatePenalty: 0 };
    }

    // Task 3.4: Depth score
    let depthScore = 0;
    try {
      const depth = await this.adapter.get_orderbook_depth(symbol, config.EXEC_DEPTH_LEVELS);
      const levels = direction === 'long' ? depth.bids : depth.asks;
      depthScore = levels.reduce((sum, [price, size]) => sum + price * size, 0);
    } catch (err) {
      console.warn(`[ExecutionEdge] Failed to fetch orderbook depth, defaulting depthScore=0:`, err);
      depthScore = 0;
    }

    // Task 3.5: Depth penalty
    const depthPenalty = depthScore < config.EXEC_DEPTH_THIN_THRESHOLD ? config.EXEC_DEPTH_PENALTY : 0;

    // Task 3.6: Fill rate penalty
    const stats = this.fillTracker.getFillStats('entry');
    const fillRatePenalty =
      stats.sampleSize > 0 && stats.fillRate < config.EXEC_FILL_RATE_THRESHOLD
        ? config.EXEC_FILL_RATE_PENALTY
        : 0;

    // Task 3.7: Offset formula and clamp
    const rawOffset = spreadBps * config.EXEC_SPREAD_OFFSET_MULT + depthPenalty + fillRatePenalty;
    const offset = Math.max(config.EXEC_OFFSET_MIN, Math.min(config.EXEC_OFFSET_MAX, rawOffset));

    // Task 3.8: Logging
    console.log(
      `[ExecutionEdge] offset=${offset.toFixed(2)} | spread=${spreadBps.toFixed(1)}bps | depth=${(depthScore / 1000).toFixed(0)}k | fillPenalty=${fillRatePenalty.toFixed(2)} | spreadOk=true`
    );

    return { offset, spreadBps, spreadOk: true, depthScore, fillRatePenalty };
  }
}
