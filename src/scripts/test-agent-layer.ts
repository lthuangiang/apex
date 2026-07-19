/**
 * Test Script: AgentLayer — Dry-Run Demo
 *
 * Runs the Agent Layer in dry-run mode with a mock BotManager to verify:
 * - Lifecycle management (init → start → cycles → stop)
 * - Strategy selection based on Intelligence Engine output
 * - Capital allocation with Kelly sizing
 * - Risk gate enforcement
 * - State persistence
 * - Dashboard API contract
 *
 * Usage: npx tsx src/scripts/test-agent-layer.ts
 *
 * No exchange credentials needed — runs completely offline.
 */

import { AgentLayer } from '../bot/AgentLayer.js';
import { BotManager } from '../bot/BotManager.js';
import { createBotSharedState } from '../bot/BotSharedState.js';

// ═══════════════════════════════════════════════════════════════════════════════
// MOCK SETUP
// ═══════════════════════════════════════════════════════════════════════════════

function createMockBotManager(): BotManager {
  const manager = new BotManager();

  // Create fake bot entries by directly manipulating the registry
  // We'll simulate 2 bots: one farm, one trade
  const fakeFarmBot = {
    id: 'farm-bot-1',
    config: {
      id: 'farm-bot-1',
      name: 'Farm Bot (SoDEX)',
      exchange: 'sodex' as const,
      symbol: 'BTC-USD',
      mode: 'farm' as const,
      intelligenceMode: 'auto' as const,
      tags: ['farm', 'sodex'],
      autoStart: true,
      orderSizeMin: 0.002,
      orderSizeMax: 0.005,
      credentialKey: 'SODEX',
      tradeLogBackend: 'json' as const,
      tradeLogPath: './trades-test.json',
    },
    state: {
      ...createBotSharedState('farm-bot-1'),
      botStatus: 'RUNNING' as const,
      sessionPnl: -1.2,
      sessionVolume: 2500,
      sessionFees: 0.45,
      openPosition: null,
    },
    start: async () => true,
    stop: async () => {},
  };

  const fakeTradeBot = {
    id: 'trade-bot-1',
    config: {
      id: 'trade-bot-1',
      name: 'Trade Bot (SoDEX)',
      exchange: 'sodex' as const,
      symbol: 'BTC-USD',
      mode: 'trade' as const,
      intelligenceMode: 'auto' as const,
      tags: ['trade', 'sodex'],
      autoStart: true,
      orderSizeMin: 0.002,
      orderSizeMax: 0.005,
      credentialKey: 'SODEX',
      tradeLogBackend: 'json' as const,
      tradeLogPath: './trades-test.json',
    },
    state: {
      ...createBotSharedState('trade-bot-1'),
      botStatus: 'RUNNING' as const,
      sessionPnl: 1.8,
      sessionVolume: 800,
      sessionFees: 0.12,
      openPosition: {
        side: 'long' as const,
        size: 0.003,
        entryPrice: 104500,
        unrealizedPnl: 0.35,
      },
    },
    start: async () => true,
    stop: async () => {},
  };

  // Inject fake bots into the registry via the public interface
  // We'll use a trick: override getAllBots
  const origGetAll = manager.getAllBots.bind(manager);
  (manager as any).getAllBots = () => [fakeFarmBot, fakeTradeBot];
  (manager as any).getAggregatedStats = () => ({
    totalVolume: 3300,
    activeBotCount: 2,
    totalFees: 0.57,
    totalPnl: 0.6,
  });

  return manager;
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════════

async function main() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  DRIFT Agent Layer — Test / Demo Script');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log();

  // ── Step 1: Create AgentLayer in DRY-RUN mode ─────────────────────────────
  console.log('📦 [Step 1] Creating AgentLayer (dry-run mode)...');
  const agent = new AgentLayer({
    cycleIntervalSecs: 5,          // Fast cycles for testing
    exposureCapUsd: 500,
    consecutiveLossHalt: 3,
    lossCooldownMins: 1,
    farmCapitalRatio: 0.6,
    tradeMinConfidence: 0.65,
    tradeMaxChopScore: 0.6,
    dryRun: true,                  // No orders emitted
    maxLossUsd: 5,
    statePath: './agent-state-test.json',
  });

  // ── Step 2: Initialize with mock BotManager ───────────────────────────────
  console.log('📦 [Step 2] Initializing with mock BotManager...');
  const mockManager = createMockBotManager();

  const notifications: string[] = [];
  const telegramMock = async (msg: string) => {
    notifications.push(msg);
    console.log(`  📱 [Telegram] ${msg.replace(/\n/g, ' | ')}`);
  };

  await agent.initialize(mockManager, telegramMock);
  console.log('  ✅ Initialized');
  console.log();

  // ── Step 3: Start Agent ───────────────────────────────────────────────────
  console.log('🚀 [Step 3] Starting Agent...');
  agent.start();
  console.log('  ✅ Agent running');
  console.log();

  // ── Step 4: Wait for a few cycles ─────────────────────────────────────────
  console.log('⏳ [Step 4] Running 3 cycles (15s)...');
  console.log('  (Intelligence Engine fetches SoSoValue data in background)');
  console.log();

  await sleep(16_000); // Wait for 3 cycles at 5s interval

  // ── Step 5: Inspect state ─────────────────────────────────────────────────
  console.log();
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  RESULTS');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log();

  const state = agent.getState();
  console.log(`📊 Lifecycle: ${state.lifecycleState}`);
  console.log(`📊 Cycles completed: ${state.cycleCount}`);
  console.log(`📊 Started at: ${state.startedAt}`);
  console.log();

  // Last decision
  const decision = agent.getLastDecision();
  if (decision) {
    console.log('🧠 Last AgentDecision:');
    console.log(`  Strategy: ${decision.selectedStrategy}`);
    console.log(`  Direction: ${decision.direction}`);
    console.log(`  Size: ${decision.allocatedSize.toFixed(5)} BTC`);
    console.log(`  Regime: ${decision.regime}`);
    console.log(`  Confidence: ${decision.confidenceScore.toFixed(2)}`);
    console.log(`  Risk Gate: ${decision.riskGateStatus}`);
    console.log(`  Reasoning: ${decision.reasoning.slice(0, 120)}...`);
  } else {
    console.log('⚠️  No decisions yet (Intelligence Engine may have timed out)');
  }
  console.log();

  // Portfolio state
  const portfolio = agent.getPortfolioState();
  console.log('💰 Portfolio State:');
  console.log(`  Session PnL: $${portfolio.sessionPnl.toFixed(2)}`);
  console.log(`  Session Volume: $${portfolio.sessionVolume.toFixed(0)}`);
  console.log(`  Open Exposure: $${portfolio.totalOpenExposureUsd.toFixed(0)}`);
  console.log(`  Active Bots: ${portfolio.activeBots}`);
  console.log();

  // Risk Gate
  const risk = agent.getRiskStatus();
  console.log('🛡️  Risk Gate:');
  console.log(`  Status: ${risk.status}`);
  console.log(`  Reason: ${risk.reason}`);
  console.log(`  Consecutive Losses: ${risk.consecutiveLosses}`);
  console.log();

  // Cycle latency
  const latency = agent.getCycleLatencyStats();
  console.log('⏱️  Cycle Latency:');
  console.log(`  p50: ${latency.p50}ms`);
  console.log(`  p95: ${latency.p95}ms`);
  console.log(`  p99: ${latency.p99}ms`);
  console.log();

  // Performance
  const perf = agent.getPerformanceSummary();
  console.log('📈 Strategy Performance:');
  console.log(`  Farm: ${perf.farm.totalTrades} trades, ${(perf.farm.winRate * 100).toFixed(0)}% WR, $${perf.farm.totalPnl.toFixed(2)} PnL`);
  console.log(`  Trade: ${perf.trade.totalTrades} trades, ${(perf.trade.winRate * 100).toFixed(0)}% WR, $${perf.trade.totalPnl.toFixed(2)} PnL`);
  console.log();

  // Decision history
  const history = agent.getDecisionHistory();
  console.log(`📜 Decision History: ${history.length} entries`);
  if (history.length > 0) {
    console.log('  Last 3:');
    for (const d of history.slice(0, 3)) {
      console.log(`    ${d.timestamp.slice(11, 19)} | ${d.selectedStrategy.padEnd(5)} | ${d.direction.padEnd(5)} | regime=${d.regime} | size=${d.allocatedSize.toFixed(5)}`);
    }
  }
  console.log();

  // ── Step 6: Test adaptive learning ────────────────────────────────────────
  console.log('🔄 [Step 6] Simulating trade results (adaptive learning)...');
  agent.recordTradeResult('farm', true, 0.15, 200);
  agent.recordTradeResult('farm', true, 0.08, 180);
  agent.recordTradeResult('trade', false, -0.50, 300);
  agent.recordTradeResult('farm', true, 0.22, 210);
  console.log('  Recorded: 3 farm wins, 1 trade loss');
  
  const perfAfter = agent.getPerformanceSummary();
  console.log(`  Farm WR: ${(perfAfter.farm.winRate * 100).toFixed(0)}% | Trade WR: ${(perfAfter.trade.winRate * 100).toFixed(0)}%`);
  console.log();

  // ── Step 7: Test config update ────────────────────────────────────────────
  console.log('⚙️  [Step 7] Testing runtime config update...');
  const updateResult = agent.updateConfig({ exposureCapUsd: 1000, farmCapitalRatio: 0.7 });
  console.log(`  Update result: ${updateResult.success ? '✅ Success' : '❌ Failed: ' + updateResult.errors.join(', ')}`);
  console.log(`  New exposure cap: $${agent.getConfig().exposureCapUsd}`);
  console.log(`  New farm ratio: ${agent.getConfig().farmCapitalRatio}`);

  // Test invalid config
  const badUpdate = agent.updateConfig({ cycleIntervalSecs: 2 });
  console.log(`  Invalid update (interval=2): ${badUpdate.success ? '✅' : '❌ ' + badUpdate.errors[0]}`);
  console.log();

  // ── Step 8: Pause and stop ────────────────────────────────────────────────
  console.log('⏸️  [Step 8] Pausing...');
  agent.pause();
  console.log(`  State: ${agent.getState().lifecycleState}`);

  console.log('🛑 [Step 9] Stopping...');
  await agent.stop();
  console.log(`  State: ${agent.getState().lifecycleState}`);
  console.log();

  // ── Step 9: Verify state was persisted ────────────────────────────────────
  const fs = await import('fs');
  if (fs.existsSync('./agent-state-test.json')) {
    const persisted = JSON.parse(fs.readFileSync('./agent-state-test.json', 'utf-8'));
    console.log('💾 State persisted to disk:');
    console.log(`  Cycles: ${persisted.cycleCount}`);
    console.log(`  Decisions: ${persisted.decisionHistory?.length ?? 0}`);
    console.log(`  File: ./agent-state-test.json`);
    // Cleanup
    fs.unlinkSync('./agent-state-test.json');
    console.log('  (cleaned up test file)');
  }
  console.log();

  // ── Notifications ─────────────────────────────────────────────────────────
  console.log(`📱 Telegram notifications sent: ${notifications.length}`);
  for (const n of notifications) {
    console.log(`  → ${n.replace(/\n/g, ' | ').slice(0, 80)}`);
  }

  console.log();
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  ✅ AgentLayer test complete');
  console.log('═══════════════════════════════════════════════════════════════');
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
