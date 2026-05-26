#!/usr/bin/env tsx
/**
 * Test script for SoSoValue analytics
 * Usage: npx tsx src/scripts/test-sosovalue-analytics.ts
 */

import { TradeLogger } from '../ai/TradeLogger.js';
import { analyzeSoSoValueImpact, formatSoSoValueReport } from '../ai/SoSoValueAnalytics.js';

async function main() {
  console.log('=== SoSoValue Analytics Test ===\n');

  // Load trade logs
  const logger = new TradeLogger(
    (process.env.TRADE_LOG_BACKEND ?? 'json') as 'json' | 'sqlite',
    process.env.TRADE_LOG_PATH ?? './trades.json'
  );

  const trades = await logger.readAll();
  console.log(`Loaded ${trades.length} trades from log\n`);

  if (trades.length === 0) {
    console.log('No trades found. Run the bot first to generate trade data.');
    return;
  }

  // Analyze SoSoValue impact
  const report = analyzeSoSoValueImpact(trades);
  const formatted = formatSoSoValueReport(report);

  console.log(formatted);

  // Additional insights
  console.log('--- Key Insights ---');

  const coverage = (report.tradesWithSoSoData / report.totalTrades * 100).toFixed(1);
  console.log(`SoSoValue Coverage: ${coverage}% of trades have F&G data\n`);

  // Find best performing strategy mode
  const modes = Object.entries(report.byStrategyMode);
  if (modes.length > 0) {
    const bestMode = modes.reduce((best, [mode, stats]) =>
      stats.totalPnl > best[1].totalPnl ? [mode, stats] : best
    );
    console.log(`Best Strategy Mode: ${bestMode[0]} ($${bestMode[1].totalPnl.toFixed(2)} total PnL)\n`);
  }

  // Find best performing sentiment
  const sentiments = Object.entries(report.bySentiment)
    .filter(([_, stats]) => stats.trades > 0);
  if (sentiments.length > 0) {
    const bestSentiment = sentiments.reduce((best, [sentiment, stats]) =>
      stats.totalPnl > best[1].totalPnl ? [sentiment, stats] : best
    );
    console.log(`Best Sentiment: ${bestSentiment[0]} ($${bestSentiment[1].totalPnl.toFixed(2)} total PnL)\n`);
  }

  // Risk reduction analysis
  if (report.riskMetrics.avgSizeMultiplier < 1.0) {
    const reduction = ((1.0 - report.riskMetrics.avgSizeMultiplier) * 100).toFixed(1);
    console.log(`Average position size reduced by ${reduction}% due to sentiment adjustments`);
  } else if (report.riskMetrics.avgSizeMultiplier > 1.0) {
    const increase = ((report.riskMetrics.avgSizeMultiplier - 1.0) * 100).toFixed(1);
    console.log(`Average position size increased by ${increase}% during favorable sentiment`);
  }
}

main().catch(console.error);
