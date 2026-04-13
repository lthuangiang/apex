import type { TradeRecord, TradeLogger } from '../TradeLogger';
import type { WeightStoreInterface } from './WeightStore';
import { adaptiveWeightAdjuster } from './AdaptiveWeightAdjuster';

export interface ComponentStat {
  total: number;   // trades where component gave a directional signal
  wins: number;    // component prediction matched trade outcome
  winRate: number; // wins / total (0 if total === 0)
}

export interface ComponentStats {
  ema: ComponentStat;
  rsi: ComponentStat & { lossStreak: number };
  momentum: ComponentStat;
  imbalance: ComponentStat;
  computedAt: string;  // ISO 8601
  lookbackN: number;   // how many trades were analysed
}

/**
 * Compute per-component win-rate stats over the last `lookbackN` trades.
 *
 * @param trades   TradeRecord array sorted descending by timestamp
 * @param lookbackN  Maximum number of recent trades to analyse
 */
export function computeComponentStats(
  trades: TradeRecord[],
  lookbackN: number,
): ComponentStats {
  const recent = trades.slice(0, lookbackN);

  let emaTotal = 0;
  let emaWins = 0;

  let rsiTotal = 0;
  let rsiWins = 0;
  let rsiLossStreak = 0;
  let rsiCurStreak = 0;

  let momTotal = 0;
  let momWins = 0;

  let imbTotal = 0;
  let imbWins = 0;

  for (const trade of recent) {
    const won = trade.pnl > 0;
    const dir = trade.direction;

    // ── EMA component ────────────────────────────────────────────────
    if (trade.ema9 != null && trade.ema21 != null) {
      const emaPredicted: 'long' | 'short' = trade.ema9 > trade.ema21 ? 'long' : 'short';
      emaTotal++;
      if (emaPredicted === dir && won) emaWins++;
    }

    // ── RSI component (extreme zones only) ───────────────────────────
    if (trade.rsi != null && (trade.rsi < 35 || trade.rsi > 65)) {
      const rsiPredicted: 'long' | 'short' = trade.rsi < 35 ? 'long' : 'short';
      rsiTotal++;
      if (rsiPredicted === dir && won) {
        rsiWins++;
        rsiCurStreak = 0;
      } else {
        rsiCurStreak++;
        if (rsiCurStreak > rsiLossStreak) rsiLossStreak = rsiCurStreak;
      }
    }

    // ── Momentum component ───────────────────────────────────────────
    if (trade.momentum3candles != null) {
      const momPredicted: 'long' | 'short' = trade.momentum3candles > 0 ? 'long' : 'short';
      momTotal++;
      if (momPredicted === dir && won) momWins++;
    }

    // ── Imbalance component ──────────────────────────────────────────
    if (trade.imbalance != null) {
      const imbPredicted: 'long' | 'short' = trade.imbalance > 1 ? 'long' : 'short';
      imbTotal++;
      if (imbPredicted === dir && won) imbWins++;
    }
  }

  return {
    ema: {
      total: emaTotal,
      wins: emaWins,
      winRate: emaTotal > 0 ? emaWins / emaTotal : 0,
    },
    rsi: {
      total: rsiTotal,
      wins: rsiWins,
      winRate: rsiTotal > 0 ? rsiWins / rsiTotal : 0,
      lossStreak: rsiLossStreak,
    },
    momentum: {
      total: momTotal,
      wins: momWins,
      winRate: momTotal > 0 ? momWins / momTotal : 0,
    },
    imbalance: {
      total: imbTotal,
      wins: imbWins,
      winRate: imbTotal > 0 ? imbWins / imbTotal : 0,
    },
    computedAt: new Date().toISOString(),
    lookbackN: recent.length,
  };
}

const RECALC_EVERY_N = 10;
const LOOKBACK_N = 50;

export class ComponentPerformanceTracker {
  private tradesSinceLastRecalc = 0;
  private latestStats: ComponentStats | null = null;

  constructor(
    private readonly tradeLoggerInstance: TradeLogger,
    private readonly weightStoreInstance: WeightStoreInterface,
  ) {}

  onTradeLogged(): void {
    this.tradesSinceLastRecalc++;

    if (this.tradesSinceLastRecalc >= RECALC_EVERY_N) {
      this.tradeLoggerInstance.readAll().then((trades) => {
        const stats = computeComponentStats(trades, LOOKBACK_N);
        const newWeights = adaptiveWeightAdjuster.adjustWeights(stats, this.weightStoreInstance.getWeights());
        this.weightStoreInstance.setWeights(newWeights);
        this.latestStats = stats;
        this.tradesSinceLastRecalc = 0;
      }).catch((err) => {
        console.error('[ComponentPerformanceTracker] Recalculation failed:', err);
        // Do NOT reset counter — retry on next trade
      });
    }
  }

  getStats(): ComponentStats {
    if (this.latestStats !== null) {
      return this.latestStats;
    }
    // Zero-stats default when no recalc has happened yet
    return {
      ema: { total: 0, wins: 0, winRate: 0 },
      rsi: { total: 0, wins: 0, winRate: 0, lossStreak: 0 },
      momentum: { total: 0, wins: 0, winRate: 0 },
      imbalance: { total: 0, wins: 0, winRate: 0 },
      computedAt: new Date().toISOString(),
      lookbackN: 0,
    };
  }
}

// Singleton — lazily imports TradeLogger and WeightStore to avoid circular deps at module load
import { TradeLogger as TradeLoggerClass } from '../TradeLogger';
import { weightStore } from './WeightStore';

const tradeLogBackend = (process.env.TRADE_LOG_BACKEND ?? 'json') as 'json' | 'sqlite';
const tradeLogPath = process.env.TRADE_LOG_PATH ?? './trades.json';
const _singletonTradeLogger = new TradeLoggerClass(tradeLogBackend, tradeLogPath);

export const componentPerformanceTracker = new ComponentPerformanceTracker(
  _singletonTradeLogger,
  weightStore,
);
