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

    dashboardServer.start();

    console.log(`✅ [SaaS Mode] Dashboard started on port ${dashboardPort}`);
    console.log(`   Tenants: ${restoredCount} | Bots: ${tenantRegistry.getPlatformStats().totalBots}`);

    // Graceful shutdown for tenant-only mode
    const shutdown = async (signal: string) => {
        console.log(`\n🛑 [System] ${signal} received. Shutting down all tenants...`);
        await tenantRegistry.shutdownAll();
        saveStateSync();
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
