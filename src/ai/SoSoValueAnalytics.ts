/**
 * SoSoValue Impact Analytics
 *
 * Analyzes trade logs to measure the impact of SoSoValue Fear & Greed Index
 * on trading performance, risk management, and strategy adjustments.
 */

import type { TradeRecord } from './TradeLogger.js';

export interface SoSoValueImpactReport {
  totalTrades: number;
  tradesWithSoSoData: number;

  // Performance by strategy mode
  byStrategyMode: {
    [mode: string]: {
      trades: number;
      winRate: number;
      avgPnl: number;
      totalPnl: number;
      avgFearGreed: number;
    };
  };

  // Performance by sentiment range
  bySentiment: {
    extremeFear: { trades: number; winRate: number; avgPnl: number; totalPnl: number };
    fear: { trades: number; winRate: number; avgPnl: number; totalPnl: number };
    neutral: { trades: number; winRate: number; avgPnl: number; totalPnl: number };
    greed: { trades: number; winRate: number; avgPnl: number; totalPnl: number };
    extremeGreed: { trades: number; winRate: number; avgPnl: number; totalPnl: number };
  };

  // Risk reduction metrics
  riskMetrics: {
    avgSizeMultiplier: number;
    avgConfidenceMultiplier: number;
    tradesSkippedByHighThreshold: number;  // Estimated
    avgDrawdownReduction: number;  // Compared to baseline
  };
}

export function analyzeSoSoValueImpact(trades: TradeRecord[]): SoSoValueImpactReport {
  const tradesWithSoSo = trades.filter(t => t.fearGreedIndex !== undefined);

  // Initialize report
  const report: SoSoValueImpactReport = {
    totalTrades: trades.length,
    tradesWithSoSoData: tradesWithSoSo.length,
    byStrategyMode: {},
    bySentiment: {
      extremeFear: { trades: 0, winRate: 0, avgPnl: 0, totalPnl: 0 },
      fear: { trades: 0, winRate: 0, avgPnl: 0, totalPnl: 0 },
      neutral: { trades: 0, winRate: 0, avgPnl: 0, totalPnl: 0 },
      greed: { trades: 0, winRate: 0, avgPnl: 0, totalPnl: 0 },
      extremeGreed: { trades: 0, winRate: 0, avgPnl: 0, totalPnl: 0 },
    },
    riskMetrics: {
      avgSizeMultiplier: 0,
      avgConfidenceMultiplier: 0,
      tradesSkippedByHighThreshold: 0,
      avgDrawdownReduction: 0,
    },
  };

  if (tradesWithSoSo.length === 0) return report;

  // Analyze by strategy mode
  const modeGroups = groupBy(tradesWithSoSo, t => t.sosoStrategyMode ?? 'unknown');
  for (const [mode, modeTrades] of Object.entries(modeGroups)) {
    const wins = modeTrades.filter(t => t.pnl > 0).length;
    const totalPnl = modeTrades.reduce((sum, t) => sum + t.pnl, 0);
    const avgFearGreed = modeTrades.reduce((sum, t) => sum + (t.fearGreedIndex ?? 50), 0) / modeTrades.length;

    report.byStrategyMode[mode] = {
      trades: modeTrades.length,
      winRate: wins / modeTrades.length,
      avgPnl: totalPnl / modeTrades.length,
      totalPnl,
      avgFearGreed,
    };
  }

  // Analyze by sentiment range
  for (const trade of tradesWithSoSo) {
    const fg = trade.fearGreedIndex!;
    const bucket = fg < 25 ? 'extremeFear'
      : fg < 45 ? 'fear'
      : fg < 55 ? 'neutral'
      : fg < 75 ? 'greed'
      : 'extremeGreed';

    report.bySentiment[bucket].trades++;
    report.bySentiment[bucket].totalPnl += trade.pnl;
  }

  // Calculate win rates and avg PnL for each sentiment bucket
  for (const bucket of Object.keys(report.bySentiment) as Array<keyof typeof report.bySentiment>) {
    const bucketTrades = tradesWithSoSo.filter(t => {
      const fg = t.fearGreedIndex!;
      return bucket === 'extremeFear' ? fg < 25
        : bucket === 'fear' ? fg >= 25 && fg < 45
        : bucket === 'neutral' ? fg >= 45 && fg < 55
        : bucket === 'greed' ? fg >= 55 && fg < 75
        : fg >= 75;
    });

    if (bucketTrades.length > 0) {
      const wins = bucketTrades.filter(t => t.pnl > 0).length;
      report.bySentiment[bucket].winRate = wins / bucketTrades.length;
      report.bySentiment[bucket].avgPnl = report.bySentiment[bucket].totalPnl / bucketTrades.length;
    }
  }

  // Calculate risk metrics
  const sizeMults = tradesWithSoSo.filter(t => t.sosoSizeMultiplier).map(t => t.sosoSizeMultiplier!);
  const confMults = tradesWithSoSo.filter(t => t.sosoConfidenceMultiplier).map(t => t.sosoConfidenceMultiplier!);

  report.riskMetrics.avgSizeMultiplier = sizeMults.length > 0
    ? sizeMults.reduce((sum, m) => sum + m, 0) / sizeMults.length
    : 1.0;

  report.riskMetrics.avgConfidenceMultiplier = confMults.length > 0
    ? confMults.reduce((sum, m) => sum + m, 0) / confMults.length
    : 1.0;

  return report;
}

export function formatSoSoValueReport(report: SoSoValueImpactReport): string {
  let output = '\n=== SoSoValue Impact Report ===\n\n';

  output += `Total Trades: ${report.totalTrades}\n`;
  output += `Trades with SoSoValue Data: ${report.tradesWithSoSoData}\n\n`;

  output += '--- Performance by Strategy Mode ---\n';
  for (const [mode, stats] of Object.entries(report.byStrategyMode)) {
    output += `${mode}:\n`;
    output += `  Trades: ${stats.trades}\n`;
    output += `  Win Rate: ${(stats.winRate * 100).toFixed(1)}%\n`;
    output += `  Avg PnL: $${stats.avgPnl.toFixed(2)}\n`;
    output += `  Total PnL: $${stats.totalPnl.toFixed(2)}\n`;
    output += `  Avg F&G: ${stats.avgFearGreed.toFixed(0)}\n\n`;
  }

  output += '--- Performance by Sentiment ---\n';
  const sentimentLabels = {
    extremeFear: 'Extreme Fear (< 25)',
    fear: 'Fear (25-45)',
    neutral: 'Neutral (45-55)',
    greed: 'Greed (55-75)',
    extremeGreed: 'Extreme Greed (> 75)',
  };

  for (const [bucket, label] of Object.entries(sentimentLabels)) {
    const stats = report.bySentiment[bucket as keyof typeof report.bySentiment];
    if (stats.trades > 0) {
      output += `${label}:\n`;
      output += `  Trades: ${stats.trades}\n`;
      output += `  Win Rate: ${(stats.winRate * 100).toFixed(1)}%\n`;
      output += `  Avg PnL: $${stats.avgPnl.toFixed(2)}\n`;
      output += `  Total PnL: $${stats.totalPnl.toFixed(2)}\n\n`;
    }
  }

  output += '--- Risk Metrics ---\n';
  output += `Avg Size Multiplier: ${report.riskMetrics.avgSizeMultiplier.toFixed(2)}x\n`;
  output += `Avg Confidence Multiplier: ${report.riskMetrics.avgConfidenceMultiplier.toFixed(2)}x\n`;

  return output;
}

function groupBy<T>(array: T[], keyFn: (item: T) => string): Record<string, T[]> {
  return array.reduce((groups, item) => {
    const key = keyFn(item);
    if (!groups[key]) groups[key] = [];
    groups[key].push(item);
    return groups;
  }, {} as Record<string, T[]>);
}
