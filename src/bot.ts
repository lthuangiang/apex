import * as dotenv from 'dotenv';
dotenv.config();

import { interceptConsole } from './ai/sharedState.js';
interceptConsole();

import { TelegramManager } from './modules/TelegramManager.js';
import { TradeLogger } from './ai/TradeLogger.js';
import { DashboardServer } from './dashboard/server.js';
import { loadState, saveStateSync } from './ai/StateStore.js';
import { loadBotConfigs } from './bot/loadBotConfigs.js';
import { TenantRegistry } from './bot/TenantRegistry.js';
import { AgentLayer } from './bot/AgentLayer.js';
import { closeDb } from './db/Database.js';
import { startDailySnapshotScheduler, stopDailySnapshotScheduler } from './db/DailySnapshotScheduler.js';

const {
    TELEGRAM_BOT_TOKEN,
    TELEGRAM_CHAT_ID,
    DASHBOARD_PORT,
} = process.env;

async function bootstrap() {
    console.log(`\n🚀 SHIELD-BOT starting (SaaS Mode)...`);

    // Load persisted bot state (PnL, logs, history)
    loadState();

    // ── Check for deprecated root bot-configs.json ───────────────────────────
    const configPath = process.env.BOT_CONFIGS_PATH ?? './bot-configs.json';
    const botConfigs = loadBotConfigs(configPath);

    const telegramEnabled = process.env.TELEGRAM_ENABLED !== 'false';
    const telegram = new TelegramManager(
        telegramEnabled ? TELEGRAM_BOT_TOKEN : undefined,
        telegramEnabled ? TELEGRAM_CHAT_ID : undefined,
    );

    // ── Dashboard ─────────────────────────────────────────────────────────────
    const dashboardPort = parseInt(DASHBOARD_PORT || '3000', 10);
    
    // ── SaaS Mode: Tenant-only architecture (no root bots) ───────────────────
    if (botConfigs.length > 0) {
        console.log(`⚠️ [DEPRECATED] Root bot-configs.json detected with ${botConfigs.length} bot(s)`);
        console.log(`⚠️ Please migrate to tenant-based configs under ./data/{wallet}/bot-configs.json`);
    }

    console.log(`📦 [SaaS Mode] Tenant-only architecture — root configs ignored`);

    // Create dashboard without root BotManager (tenant bots only)
    const dummyLogger = new TradeLogger('json', './trades-dummy.json');
    const dashboardServer = new DashboardServer(dummyLogger, dashboardPort);

    // ── Multi-Wallet SaaS: wire TenantRegistry ────────────────────────────
    // Requirements: 3.3, 3.4, 3.6
    const tenantRegistry = new TenantRegistry('./data');
    dashboardServer.registerTenantRegistry(tenantRegistry, telegram);
    const restoredCount = await tenantRegistry.restoreAll(telegram);
    console.log(`✅ [TenantRegistry] Restored ${restoredCount} tenant(s) from ./data`);

    // ── Daily Balance Snapshot Scheduler (0h UTC) ─────────────────────────────
    startDailySnapshotScheduler(tenantRegistry);

    // ── Agent Layer: Autonomous Orchestration Brain (Wave 3) ─────────────────
    const agentLayer = new AgentLayer({
      cycleIntervalSecs: parseInt(process.env.AGENT_CYCLE_INTERVAL_SECS || '30', 10),
      exposureCapUsd: parseFloat(process.env.AGENT_EXPOSURE_CAP_USD || '500'),
      consecutiveLossHalt: parseInt(process.env.AGENT_CONSECUTIVE_LOSS_HALT || '3', 10),
      lossCooldownMins: parseInt(process.env.AGENT_LOSS_COOLDOWN_MINS || '10', 10),
      farmCapitalRatio: parseFloat(process.env.AGENT_FARM_CAPITAL_RATIO || '0.6'),
      tradeMinConfidence: parseFloat(process.env.TRADE_MIN_CONFIDENCE || '0.65'),
      tradeMaxChopScore: parseFloat(process.env.TRADE_MAX_CHOP_SCORE || '0.6'),
      dryRun: process.env.AGENT_DRY_RUN === 'true',
      maxLossUsd: parseFloat(process.env.AGENT_MAX_LOSS_USD || '5'),
      statePath: process.env.AGENT_STATE_PATH || './data/agent-state.json',
    });

    // Initialize Agent with a composite BotManager from all tenants (or first tenant)
    // The Agent observes all tenant bots for portfolio-level decisions
    const agentTelegramNotify = async (msg: string) => {
      await telegram.sendMessage(msg, true).catch(() => {});
    };

    // Use first tenant's BotManager if available, or create a placeholder
    const allTenants = tenantRegistry.getAllTenants();
    const primaryBotManager = allTenants.length > 0
      ? allTenants[0].botManager
      : new (await import('./bot/BotManager.js')).BotManager();

    await agentLayer.initialize(primaryBotManager, agentTelegramNotify);

    // Auto-start Agent if not in dry-run or if explicitly enabled
    if (process.env.AGENT_ENABLED !== 'false') {
      agentLayer.start();
      console.log(`🧠 [AgentLayer] Autonomous orchestration started (cycle: ${agentLayer.getConfig().cycleIntervalSecs}s)`);
    }

    // Register Agent with dashboard for API endpoints
    dashboardServer.registerAgentLayer(agentLayer);

    dashboardServer.start();

    console.log(`✅ [SaaS Mode] Dashboard started on port ${dashboardPort}`);
    console.log(`   Tenants: ${restoredCount} | Bots: ${tenantRegistry.getPlatformStats().totalBots}`);

    // Graceful shutdown for tenant-only mode
    const shutdown = async (signal: string) => {
        console.log(`\n🛑 [System] ${signal} received. Shutting down all tenants...`);
        await agentLayer.stop();
        stopDailySnapshotScheduler();
        await tenantRegistry.shutdownAll();
        saveStateSync();
        closeDb();
        await telegram.sendMessage(`⚠️ *Bot Shutting Down* (${signal}). All operations suspended.`);
        process.exit(0);
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));

    console.log('📡 [System] SaaS Mode ready. Access dashboard to manage tenants.');
    await telegram.sendMessage('🤖 *SHIELD-BOT Online* (SaaS Mode)\nTenant-based bot management.', true);
}

bootstrap().catch(error => {
    console.error('FATAL: Bot failed to start:', error);
    process.exit(1);
});
