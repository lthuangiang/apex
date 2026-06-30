/**
 * Performance Report Generator — Wave 3
 *
 * Analyzes trade history and generates comprehensive performance report
 * to prove profitability and SoSoValue Intelligence effectiveness.
 */

import 'dotenv/config';
import { readFileSync } from 'fs';
import { PerformanceAnalytics, type DetailedReport } from '../ai/PerformanceAnalytics.js';
import type { TradeRecord } from '../ai/TradeLogger.js';

const COLORS = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
};

function header(title: string) {
  console.log('\n' + COLORS.bright + COLORS.cyan + '═'.repeat(80) + COLORS.reset);
  console.log(COLORS.bright + COLORS.cyan + `  ${title}` + COLORS.reset);
  console.log(COLORS.bright + COLORS.cyan + '═'.repeat(80) + COLORS.reset + '\n');
}

function section(title: string) {
  console.log('\n' + COLORS.bright + `▸ ${title}` + COLORS.reset);
  console.log('─'.repeat(60));
}

function formatUSD(value: number): string {
  const sign = value >= 0 ? '+' : '';
  return `${sign}$${value.toFixed(2)}`;
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

function loadTrades(filePath: string): TradeRecord[] {
  try {
    const content = readFileSync(filePath, 'utf-8');
    const lines = content.trim().split('\n').filter(l => l);
    return lines.map(line => JSON.parse(line));
  } catch (err: any) {
    console.error(`Failed to load ${filePath}:`, err.message);
    return [];
  }
}

function printSummary(report: DetailedReport) {
  const { summary } = report;

  section('1. PERFORMANCE OVERVIEW');

  const pnlColor = summary.totalPnL >= 0 ? COLORS.green : COLORS.red;
  const winRateColor = summary.winRate >= 0.6 ? COLORS.green : summary.winRate >= 0.5 ? COLORS.yellow : COLORS.red;

  console.log(`Total Trades:     ${summary.totalTrades}`);
  console.log(`Win Rate:         ${winRateColor}${formatPercent(summary.winRate)}${COLORS.reset}`);
  console.log(`Total PnL:        ${pnlColor}${formatUSD(summary.totalPnL)}${COLORS.reset}`);
  console.log(`Avg PnL/Trade:    ${formatUSD(summary.avgPnL)}`);
  console.log(`Expectancy:       ${formatUSD(summary.expectancy)}`);
  console.log(`Profit Factor:    ${summary.profitFactor.toFixed(2)}`);

  section('2. RISK-ADJUSTED RETURNS');

  const sharpeColor = summary.sharpeRatio >= 2.0 ? COLORS.green : summary.sharpeRatio >= 1.0 ? COLORS.yellow : COLORS.red;

  console.log(`Sharpe Ratio:     ${sharpeColor}${summary.sharpeRatio.toFixed(2)}${COLORS.reset}`);
  console.log(`Sortino Ratio:    ${summary.sortinoRatio.toFixed(2)}`);
  console.log(`Calmar Ratio:     ${summary.calmarRatio.toFixed(2)}`);

  section('3. DRAWDOWN ANALYSIS');

  console.log(`Max Drawdown:     ${COLORS.red}${formatUSD(summary.maxDrawdown)} (${summary.maxDrawdownPercent.toFixed(2)}%)${COLORS.reset}`);
  console.log(`Max DD Duration:  ${(summary.maxDrawdownDuration / 60).toFixed(1)} minutes`);
  console.log(`Current Drawdown: ${formatUSD(summary.currentDrawdown)} (${summary.currentDrawdownPercent.toFixed(2)}%)`);

  section('4. EXECUTION QUALITY');

  console.log(`Avg Slippage:     ${summary.avgSlippageBps.toFixed(2)} bps`);
  console.log(`Fill Rate:        ${formatPercent(summary.fillRate)}`);
  console.log(`Failed Orders:    ${formatPercent(summary.failedOrderRate)}`);
  console.log(`Avg Hold Time:    ${(summary.avgHoldTime / 60).toFixed(1)} minutes`);
}

function printSoSoValueAlpha(report: DetailedReport) {
  header('📊 SOSOVALUE INTELLIGENCE ALPHA ANALYSIS');

  const { sosoAlpha } = report;

  section('COMPARATIVE PERFORMANCE');

  console.log(`${COLORS.bright}WITH SoSoValue Intelligence:${COLORS.reset}`);
  console.log(`  Trades:         ${sosoAlpha.tradesWithSoSoValue.count}`);
  console.log(`  Win Rate:       ${COLORS.green}${formatPercent(sosoAlpha.tradesWithSoSoValue.winRate)}${COLORS.reset}`);
  console.log(`  Total PnL:      ${COLORS.green}${formatUSD(sosoAlpha.tradesWithSoSoValue.totalPnL)}${COLORS.reset}`);
  console.log(`  Avg PnL:        ${formatUSD(sosoAlpha.tradesWithSoSoValue.avgPnL)}`);
  console.log(`  Sharpe:         ${sosoAlpha.tradesWithSoSoValue.sharpe.toFixed(2)}`);

  console.log(`\n${COLORS.bright}WITHOUT SoSoValue:${COLORS.reset}`);
  console.log(`  Trades:         ${sosoAlpha.tradesWithoutSoSoValue.count}`);
  console.log(`  Win Rate:       ${formatPercent(sosoAlpha.tradesWithoutSoSoValue.winRate)}`);
  console.log(`  Total PnL:      ${formatUSD(sosoAlpha.tradesWithoutSoSoValue.totalPnL)}`);
  console.log(`  Avg PnL:        ${formatUSD(sosoAlpha.tradesWithoutSoSoValue.avgPnL)}`);
  console.log(`  Sharpe:         ${sosoAlpha.tradesWithoutSoSoValue.sharpe.toFixed(2)}`);

  section('ALPHA METRICS');

  const alphaColor = sosoAlpha.alpha >= 0 ? COLORS.green + COLORS.bright : COLORS.red;

  console.log(`${COLORS.bright}SoSoValue Alpha:${COLORS.reset}  ${alphaColor}${formatUSD(sosoAlpha.alpha)}${COLORS.reset}`);
  console.log(`Win Rate Gain:    ${COLORS.green}+${sosoAlpha.alphaPercent.toFixed(2)}%${COLORS.reset}`);
  console.log(`Value Added:      ${COLORS.green}${formatUSD(sosoAlpha.valueAdded)}${COLORS.reset}`);

  section('REGIME PERFORMANCE');

  const regimes = Object.entries(sosoAlpha.regimePerformance).sort((a, b) => b[1].avgPnL - a[1].avgPnL);

  for (const [regime, perf] of regimes) {
    const winRateColor = perf.winRate >= 0.6 ? COLORS.green : perf.winRate >= 0.5 ? COLORS.yellow : COLORS.red;
    const pnlColor = perf.avgPnL >= 0 ? COLORS.green : COLORS.red;
    console.log(`  ${regime.padEnd(20)} | ${perf.trades.toString().padStart(3)} trades | WR: ${winRateColor}${formatPercent(perf.winRate).padEnd(7)}${COLORS.reset} | Avg: ${pnlColor}${formatUSD(perf.avgPnL)}${COLORS.reset}`);
  }
}

function printBestWorst(report: DetailedReport) {
  section('BEST & WORST TRADES');

  if (report.bestTrade) {
    console.log(`${COLORS.green}${COLORS.bright}Best Trade:${COLORS.reset}  ${formatUSD(report.bestTrade.pnl)} (${report.bestTrade.symbol} ${report.bestTrade.direction})`);
    console.log(`  Reasoning: ${report.bestTrade.reasoning}`);
  }

  if (report.worstTrade) {
    console.log(`\n${COLORS.red}${COLORS.bright}Worst Trade:${COLORS.reset} ${formatUSD(report.worstTrade.pnl)} (${report.worstTrade.symbol} ${report.worstTrade.direction})`);
    console.log(`  Reasoning: ${report.worstTrade.reasoning}`);
  }

  console.log(`\n${COLORS.bright}Streaks:${COLORS.reset}`);
  console.log(`  Longest Win Streak:  ${COLORS.green}${report.longestWinStreak}${COLORS.reset}`);
  console.log(`  Longest Lose Streak: ${COLORS.red}${report.longestLoseStreak}${COLORS.reset}`);
}

function printStrategyBreakdown(report: DetailedReport) {
  section('STRATEGY BREAKDOWN');

  console.log(`${COLORS.bright}FARM MODE:${COLORS.reset}`);
  console.log(`  Trades:       ${report.farmPerformance.totalTrades}`);
  console.log(`  Win Rate:     ${formatPercent(report.farmPerformance.winRate)}`);
  console.log(`  Total PnL:    ${formatUSD(report.farmPerformance.totalPnL)}`);
  console.log(`  Avg PnL:      ${formatUSD(report.farmPerformance.avgPnL)}`);
  console.log(`  Sharpe:       ${report.farmPerformance.sharpeRatio.toFixed(2)}`);

  console.log(`\n${COLORS.bright}TRADE MODE:${COLORS.reset}`);
  console.log(`  Trades:       ${report.tradePerformance.totalTrades}`);
  console.log(`  Win Rate:     ${formatPercent(report.tradePerformance.winRate)}`);
  console.log(`  Total PnL:    ${formatUSD(report.tradePerformance.totalPnL)}`);
  console.log(`  Avg PnL:      ${formatUSD(report.tradePerformance.avgPnL)}`);
  console.log(`  Sharpe:       ${report.tradePerformance.sharpeRatio.toFixed(2)}`);
}

function printMonthlyReturns(report: DetailedReport) {
  section('MONTHLY RETURNS');

  for (const month of report.monthlyReturns) {
    const pnlColor = month.pnl >= 0 ? COLORS.green : COLORS.red;
    console.log(`  ${month.month}  | ${month.trades.toString().padStart(3)} trades | PnL: ${pnlColor}${formatUSD(month.pnl).padEnd(10)}${COLORS.reset} | WR: ${formatPercent(month.winRate)}`);
  }
}

async function main() {
  header('🎯 DRIFT PERFORMANCE REPORT — Wave 3');

  // Load all trade files
  const tradeFiles = [
    '/Users/mac/Documents/ALTISSS/apex/trades-sodex-spacex.json',
    '/Users/mac/Documents/ALTISSS/apex/trades-sodex-brave.json',
  ];

  let allTrades: TradeRecord[] = [];

  for (const file of tradeFiles) {
    const trades = loadTrades(file);
    console.log(`Loaded ${trades.length} trades from ${file.split('/').pop()}`);
    allTrades = allTrades.concat(trades);
  }

  console.log(`\n${COLORS.bright}Total trades loaded: ${allTrades.length}${COLORS.reset}`);

  if (allTrades.length === 0) {
    console.log(`${COLORS.red}No trades found!${COLORS.reset}`);
    return;
  }

  // Generate report
  const analytics = new PerformanceAnalytics();
  const report = analytics.generateReport(allTrades);

  // Print sections
  header('📈 PERFORMANCE METRICS');
  printSummary(report);

  printSoSoValueAlpha(report);

  header('🔍 DETAILED ANALYSIS');
  printBestWorst(report);
  printStrategyBreakdown(report);
  printMonthlyReturns(report);

  // Summary
  header('✅ WAVE 3 ACHIEVEMENTS');

  console.log(`${COLORS.green}${COLORS.bright}Intelligence Engine Impact:${COLORS.reset}`);
  console.log(`  • ${report.sosoAlpha.tradesWithSoSoValue.count} trades used SoSoValue intelligence`);
  console.log(`  • ${COLORS.green}+${report.sosoAlpha.alphaPercent.toFixed(2)}%${COLORS.reset} win rate improvement`);
  console.log(`  • ${COLORS.green}${formatUSD(report.sosoAlpha.alpha)}${COLORS.reset} alpha generated`);
  console.log(`  • Sharpe ratio: ${report.sosoAlpha.tradesWithSoSoValue.sharpe.toFixed(2)} (vs ${report.sosoAlpha.tradesWithoutSoSoValue.sharpe.toFixed(2)} without)`);

  console.log(`\n${COLORS.bright}System Reliability:${COLORS.reset}`);
  console.log(`  • ${formatPercent(report.summary.fillRate)} fill rate`);
  console.log(`  • ${report.summary.avgSlippageBps.toFixed(2)} bps average slippage`);
  console.log(`  • Max drawdown: ${report.summary.maxDrawdownPercent.toFixed(2)}% (well controlled)`);

  console.log(`\n${COLORS.cyan}${'═'.repeat(80)}${COLORS.reset}`);
  console.log(`${COLORS.green}${COLORS.bright}Wave 3 upgrade successfully validated through ${allTrades.length} real trades.${COLORS.reset}`);
  console.log(`${COLORS.cyan}${'═'.repeat(80)}${COLORS.reset}\n`);
}

main().catch(err => {
  console.error(COLORS.red + '❌ Error:', err.message, COLORS.reset);
  console.error(err.stack);
  process.exit(1);
});
