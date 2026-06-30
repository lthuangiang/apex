/**
 * Test SoSoValue Intelligence Engine
 *
 * Demo script to showcase Wave 3 upgrade: SoSoValue as "core brain"
 */

import 'dotenv/config';
import { SoSoValueIntelligenceEngine } from '../ai/SoSoValueIntelligenceEngine.js';

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

function log(msg: string, color: string = COLORS.reset) {
  console.log(color + msg + COLORS.reset);
}

function header(title: string) {
  console.log('\n' + COLORS.bright + COLORS.cyan + '═'.repeat(80) + COLORS.reset);
  console.log(COLORS.bright + COLORS.cyan + `  ${title}` + COLORS.reset);
  console.log(COLORS.bright + COLORS.cyan + '═'.repeat(80) + COLORS.reset + '\n');
}

function section(title: string) {
  console.log('\n' + COLORS.bright + `▸ ${title}` + COLORS.reset);
  console.log('─'.repeat(60));
}

async function main() {
  header('🧠 SOSOVALUE INTELLIGENCE ENGINE — Wave 3 Demo');

  log('Initializing intelligence engine...', COLORS.cyan);
  const engine = new SoSoValueIntelligenceEngine();

  // ═══════════════════════════════════════════════════════════════════════════
  // 1. Full Market Analysis
  // ═══════════════════════════════════════════════════════════════════════════

  section('1. MARKET INTELLIGENCE ANALYSIS');

  log('Fetching all signals in parallel...', COLORS.yellow);
  const intel = await engine.analyze();

  log(`\n✓ Analysis complete!\n`, COLORS.green);

  // Market regime
  log(`Market Regime:    ${COLORS.bright}${intel.regime.toUpperCase()}${COLORS.reset} (confidence: ${(intel.regimeConfidence * 100).toFixed(0)}%)`, COLORS.cyan);

  // Conviction scores
  log(`\nConviction Breakdown:`, COLORS.magenta);
  log(`  • Bull:    ${intel.bullConviction.toFixed(1)}/100`, intel.bullConviction > 60 ? COLORS.green : COLORS.reset);
  log(`  • Bear:    ${intel.bearConviction.toFixed(1)}/100`, intel.bearConviction > 60 ? COLORS.red : COLORS.reset);
  log(`  • Neutral: ${intel.neutralConviction.toFixed(1)}/100`, intel.neutralConviction > 60 ? COLORS.yellow : COLORS.reset);

  // Strategy recommendation
  log(`\nRecommended Strategy: ${COLORS.bright}${intel.recommendedStrategy.toUpperCase()}${COLORS.reset}`, COLORS.green);
  log(`Reason: ${intel.strategyReason}`, COLORS.yellow);

  // Position sizing
  log(`\nPosition Sizing (Kelly-Optimized):`, COLORS.magenta);
  log(`  • Base Size:             ${(intel.baseSize * 100).toFixed(0)}% (${intel.baseSize.toFixed(2)}x)`);
  log(`  • Max Leverage:          ${intel.maxLeverage.toFixed(1)}x`);
  log(`  • Confidence Multiplier: ${intel.confidenceMultiplier.toFixed(2)}x`);

  // Risk assessment
  const riskColor =
    intel.riskLevel === 'extreme' ? COLORS.red :
    intel.riskLevel === 'high' ? COLORS.yellow :
    intel.riskLevel === 'medium' ? COLORS.blue :
    COLORS.green;

  log(`\nRisk Level: ${intel.riskLevel.toUpperCase()}`, riskColor);
  if (intel.warnings.length > 0) {
    log(`Warnings:`, COLORS.yellow);
    intel.warnings.forEach(w => log(`  ⚠️  ${w}`, COLORS.yellow));
  } else {
    log(`No warnings — clear to trade`, COLORS.green);
  }

  // Raw signals
  section('2. RAW SIGNALS');

  log(`Fear & Greed Index:  ${intel.signals.fearGreed} (${_fgLabel(intel.signals.fearGreed)})`, _fgColor(intel.signals.fearGreed));
  log(`ETF Flow Signal:     ${intel.signals.etfFlow}`);
  log(`Open Interest:       $${(intel.signals.openInterest / 1e9).toFixed(2)}B`);
  log(`Funding Rate:        ${(intel.signals.fundingRate * 100).toFixed(4)}% per 8h`);
  log(`Stablecoin Inflow:   $${(intel.signals.stablecoinInflow / 1e9).toFixed(2)}B (5d)`);
  log(`Macro Risk:          ${intel.signals.macroRisk}`);

  // ═══════════════════════════════════════════════════════════════════════════
  // 3. Trading Decision
  // ═══════════════════════════════════════════════════════════════════════════

  section('3. TRADING DECISION');

  const decision = await engine.shouldTrade();

  if (decision.trade) {
    log(`✅ TRADE APPROVED`, COLORS.green + COLORS.bright);
    log(`Reason: ${decision.reason}`, COLORS.green);
    log(`\n→ Bot should execute ${intel.recommendedStrategy.toUpperCase()} strategy now`, COLORS.cyan);
  } else {
    log(`🛑 TRADE BLOCKED`, COLORS.red + COLORS.bright);
    log(`Reason: ${decision.reason}`, COLORS.red);
    log(`\n→ Bot should wait for better conditions`, COLORS.yellow);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 4. Strategy Comparison
  // ═══════════════════════════════════════════════════════════════════════════

  section('4. STRATEGY GUIDANCE BY REGIME');

  const regimeStrategies: Record<string, string> = {
    'bull_momentum': 'TRADE mode (long bias) — ride momentum with trend following',
    'bear_momentum': 'TRADE mode (short bias) — ride momentum with trend following',
    'accumulation': 'TRADE mode (long bias) — smart money buying, contrarian opportunity',
    'distribution': 'TRADE mode (short bias) — smart money selling, fade retail greed',
    'choppy_neutral': 'FARM mode — no clear direction, maximize volume instead',
    'pre_breakout': 'FARM mode — accumulate volume before breakout',
    'overheated': 'STANDBY — market too hot, wait for cooling',
    'capitulation': 'TRADE mode (contrarian long) — panic = opportunity IF institutional support',
  };

  log(`Current regime: ${intel.regime}`, COLORS.cyan);
  log(`Optimal strategy: ${regimeStrategies[intel.regime] || 'Unknown'}`, COLORS.yellow);

  // ═══════════════════════════════════════════════════════════════════════════
  // Summary
  // ═══════════════════════════════════════════════════════════════════════════

  header('📊 SUMMARY — SoSoValue Intelligence Impact');

  log(`Wave 2 Approach:`, COLORS.red);
  log(`  ❌ F&G × ETF × Macro = simple multipliers (0.85x - 1.2x)`, COLORS.red);
  log(`  ❌ Strategy selection = manual (user sets Farm/Trade/Hedge)`, COLORS.red);
  log(`  ❌ Position sizing = arbitrary`, COLORS.red);
  log(`  ❌ SoSoValue = "overlay", not "brain"`, COLORS.red);

  log(`\nWave 3 Approach:`, COLORS.green);
  log(`  ✅ 6 signals combined (F&G + ETF + OI + Funding + Stablecoin + Macro)`, COLORS.green);
  log(`  ✅ 8 market regimes classified with confidence scoring`, COLORS.green);
  log(`  ✅ Auto strategy selection (Farm/Trade/Hedge/Standby)`, COLORS.green);
  log(`  ✅ Kelly-optimized position sizing (conviction-based)`, COLORS.green);
  log(`  ✅ Risk-aware decision engine with blockers`, COLORS.green);
  log(`  ✅ SoSoValue = CORE BRAIN 🧠`, COLORS.green + COLORS.bright);

  log(`\n${'═'.repeat(80)}`, COLORS.cyan);
  log(`Intelligence engine ready for production integration.`, COLORS.green);
  log(`${'═'.repeat(80)}\n`, COLORS.cyan);
}

function _fgLabel(index: number): string {
  if (index < 25) return 'Extreme Fear';
  if (index < 45) return 'Fear';
  if (index < 55) return 'Neutral';
  if (index < 75) return 'Greed';
  return 'Extreme Greed';
}

function _fgColor(index: number): string {
  if (index < 25) return COLORS.red;
  if (index < 45) return COLORS.yellow;
  if (index < 55) return COLORS.reset;
  if (index < 75) return COLORS.cyan;
  return COLORS.green;
}

main().catch(err => {
  console.error(COLORS.red + '❌ Error:', err.message, COLORS.reset);
  console.error(err.stack);
  process.exit(1);
});
