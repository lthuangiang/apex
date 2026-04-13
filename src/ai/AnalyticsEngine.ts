import { TradeRecord } from './TradeLogger.js';

export interface WinRateBreakdown {
  total: number;
  wins: number;
  losses: number;
  winRate: number;
  avgPnl: number;
  totalPnl: number;
}

export interface AnalyticsSummary {
  overall: WinRateBreakdown;
  byMode: { farm: WinRateBreakdown; trade: WinRateBreakdown };
  byDirection: { long: WinRateBreakdown; short: WinRateBreakdown };
  byRegime: { TREND_UP: WinRateBreakdown; TREND_DOWN: WinRateBreakdown; SIDEWAY: WinRateBreakdown };
  byConfidence: Array<{ label: string; min: number; max: number } & WinRateBreakdown>;
  byHour: Array<{ hour: number; label: string } & WinRateBreakdown>;
  bestTrade: TradeRecord | null;
  worstTrade: TradeRecord | null;
  avgPnl: number;
  maxConsecWins: number;
  maxConsecLosses: number;
  currentStreak: { type: 'win' | 'loss'; count: number };
  signalQuality: {
    llmMatchesMomentumRate: number;
    fallbackRate: number;
    avgConfidence: number;
  };
  feeImpact: {
    totalFeePaid: number;
    tradesWonBeforeFee: number;
    feeLoserRate: number;
  };
  holdingTime: {
    avgSecs: number;
    medianSecs: number;
    distribution: Array<{ bucket: string; count: number }>;
  };
}

function emptyBreakdown(): WinRateBreakdown {
  return { total: 0, wins: 0, losses: 0, winRate: 0, avgPnl: 0, totalPnl: 0 };
}

function emptySummary(): AnalyticsSummary {
  return {
    overall: emptyBreakdown(),
    byMode: { farm: emptyBreakdown(), trade: emptyBreakdown() },
    byDirection: { long: emptyBreakdown(), short: emptyBreakdown() },
    byRegime: { TREND_UP: emptyBreakdown(), TREND_DOWN: emptyBreakdown(), SIDEWAY: emptyBreakdown() },
    byConfidence: [],
    byHour: [],
    bestTrade: null,
    worstTrade: null,
    avgPnl: 0,
    maxConsecWins: 0,
    maxConsecLosses: 0,
    currentStreak: { type: 'win', count: 0 },
    signalQuality: { llmMatchesMomentumRate: 0, fallbackRate: 0, avgConfidence: 0 },
    feeImpact: { totalFeePaid: 0, tradesWonBeforeFee: 0, feeLoserRate: 0 },
    holdingTime: { avgSecs: 0, medianSecs: 0, distribution: [] },
  };
}

export class AnalyticsEngine {
  compute(trades: TradeRecord[]): AnalyticsSummary {
    if (trades.length === 0) return emptySummary();

    const summary = emptySummary();

    summary.overall = this._breakdown(trades);

    // By mode
    summary.byMode.farm = this._breakdown(trades.filter(t => t.mode === 'farm'));
    summary.byMode.trade = this._breakdown(trades.filter(t => t.mode === 'trade'));

    // By direction
    summary.byDirection.long = this._breakdown(trades.filter(t => t.direction === 'long'));
    summary.byDirection.short = this._breakdown(trades.filter(t => t.direction === 'short'));

    // By regime
    summary.byRegime.TREND_UP = this._breakdown(trades.filter(t => t.regime === 'TREND_UP'));
    summary.byRegime.TREND_DOWN = this._breakdown(trades.filter(t => t.regime === 'TREND_DOWN'));
    summary.byRegime.SIDEWAY = this._breakdown(trades.filter(t => t.regime === 'SIDEWAY'));

    // By confidence bucket
    const buckets = [
      { label: '0.5–0.6', min: 0.5, max: 0.6 },
      { label: '0.6–0.7', min: 0.6, max: 0.7 },
      { label: '0.7–0.8', min: 0.7, max: 0.8 },
      { label: '0.8–1.0', min: 0.8, max: 1.01 },
    ];
    summary.byConfidence = buckets.map(b => ({
      ...b,
      ...this._breakdown(trades.filter(t => t.confidence >= b.min && t.confidence < b.max)),
    }));

    // By hour of day (UTC)
    const hourMap = new Map<number, TradeRecord[]>();
    for (const t of trades) {
      const h = new Date(t.timestamp).getUTCHours();
      if (!hourMap.has(h)) hourMap.set(h, []);
      hourMap.get(h)!.push(t);
    }
    summary.byHour = Array.from(hourMap.entries())
      .sort(([a], [b]) => a - b)
      .map(([hour, ts]) => ({
        hour,
        label: `${String(hour).padStart(2, '0')}:00`,
        ...this._breakdown(ts),
      }));

    // Best / worst
    summary.bestTrade = trades.reduce((best, t) => t.pnl > (best?.pnl ?? -Infinity) ? t : best, null as TradeRecord | null);
    summary.worstTrade = trades.reduce((worst, t) => t.pnl < (worst?.pnl ?? Infinity) ? t : worst, null as TradeRecord | null);
    summary.avgPnl = trades.reduce((s, t) => s + t.pnl, 0) / trades.length;

    // Streaks
    const streaks = this._streaks(trades);
    summary.maxConsecWins = streaks.maxWins;
    summary.maxConsecLosses = streaks.maxLosses;
    summary.currentStreak = streaks.current;

    // Signal quality
    const llmTrades = trades.filter(t => t.llmMatchesMomentum != null);
    summary.signalQuality.llmMatchesMomentumRate = llmTrades.length > 0
      ? llmTrades.filter(t => t.llmMatchesMomentum).length / llmTrades.length : 0;
    summary.signalQuality.fallbackRate = trades.filter(t => t.fallback).length / trades.length;
    summary.signalQuality.avgConfidence = trades.reduce((s, t) => s + t.confidence, 0) / trades.length;

    // Fee impact
    const feeTrades = trades.filter(t => t.feePaid != null);
    summary.feeImpact.totalFeePaid = feeTrades.reduce((s, t) => s + (t.feePaid ?? 0), 0);
    const feeLoserTrades = feeTrades.filter(t => t.wonBeforeFee === true);
    summary.feeImpact.tradesWonBeforeFee = feeLoserTrades.length;
    summary.feeImpact.feeLoserRate = feeTrades.length > 0 ? feeLoserTrades.length / feeTrades.length : 0;

    // Holding time (farm mode)
    const farmTrades = trades.filter(t => t.mode === 'farm' && t.holdingTimeSecs != null);
    if (farmTrades.length > 0) {
      const times = farmTrades.map(t => t.holdingTimeSecs!).sort((a, b) => a - b);
      summary.holdingTime.avgSecs = times.reduce((s, v) => s + v, 0) / times.length;
      summary.holdingTime.medianSecs = times[Math.floor(times.length / 2)];
      summary.holdingTime.distribution = this._holdingDistribution(farmTrades);
    }

    return summary;
  }

  private _breakdown(trades: TradeRecord[]): WinRateBreakdown {
    if (trades.length === 0) return emptyBreakdown();
    const wins = trades.filter(t => t.pnl > 0).length;
    const total = trades.length;
    const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
    return { total, wins, losses: total - wins, winRate: wins / total, avgPnl: totalPnl / total, totalPnl };
  }

  private _streaks(trades: TradeRecord[]): { maxWins: number; maxLosses: number; current: { type: 'win' | 'loss'; count: number } } {
    const sorted = [...trades].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    let maxWins = 0, maxLosses = 0, curWins = 0, curLosses = 0;
    for (const t of sorted) {
      if (t.pnl > 0) {
        curWins++; curLosses = 0;
        if (curWins > maxWins) maxWins = curWins;
      } else {
        curLosses++; curWins = 0;
        if (curLosses > maxLosses) maxLosses = curLosses;
      }
    }
    const current = curWins > 0
      ? { type: 'win' as const, count: curWins }
      : { type: 'loss' as const, count: curLosses };
    return { maxWins, maxLosses, current };
  }

  private _holdingDistribution(farmTrades: TradeRecord[]): Array<{ bucket: string; count: number }> {
    const buckets = [
      { bucket: '0–60s', min: 0, max: 60 },
      { bucket: '1–2min', min: 60, max: 120 },
      { bucket: '2–3min', min: 120, max: 180 },
      { bucket: '3–4min', min: 180, max: 240 },
      { bucket: '4–5min', min: 240, max: 300 },
      { bucket: '5min+', min: 300, max: Infinity },
    ];
    return buckets.map(b => ({
      bucket: b.bucket,
      count: farmTrades.filter(t => (t.holdingTimeSecs ?? 0) >= b.min && (t.holdingTimeSecs ?? 0) < b.max).length,
    }));
  }
}
