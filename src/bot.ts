import * as dotenv from 'dotenv';
dotenv.config();

import { interceptConsole } from './ai/sharedState.js';
interceptConsole();

import { config } from './config.js';
import { ExchangeAdapter } from './adapters/ExchangeAdapter.js';
import { DecibelAdapter } from './adapters/decibel_adapter.js';
import { SodexAdapter } from './adapters/sodex_adapter.js';
import { DangoAdapter } from './adapters/dango_adapter.js';
import { TelegramManager } from './modules/TelegramManager.js';
import { SessionManager } from './modules/SessionManager.js';
import { Watcher } from './modules/Watcher.js';
import { TradeLogger } from './ai/TradeLogger.js';
import { DashboardServer } from './dashboard/server.js';
import { sharedState } from './ai/sharedState.js';
import { configStore } from './config/ConfigStore.js';
import { loadState, saveStateSync } from './ai/StateStore.js';

const {
    // Exchange selector
    EXCHANGE,
    SYMBOL,
    // Decibel
    DECIBELS_PRIVATE_KEY,
    DECIBELS_NODE_API_KEY,
    DECIBELS_SUBACCOUNT,
    DECIBELS_BUILDER_ADDRESS,
    DECIBELS_GAS_STATION_API_KEY,
    // SoDEX
    SODEX_API_KEY,
    SODEX_API_SECRET,
    SODEX_SUBACCOUNT,
    // Dango
    DANGO_PRIVATE_KEY,
    DANGO_USER_ADDRESS,
    DANGO_NETWORK,
    // Shared
    TELEGRAM_BOT_TOKEN,
    TELEGRAM_CHAT_ID,
    TRADE_LOG_BACKEND,
    TRADE_LOG_PATH,
    DASHBOARD_PORT,
} = process.env;

function createAdapter(exchange: string, symbol: string): ExchangeAdapter {
    switch (exchange.toLowerCase()) {
        case 'sodex': {
            if (!SODEX_API_KEY || !SODEX_API_SECRET || !SODEX_SUBACCOUNT) {
                console.error('FATAL: SODEX_API_KEY, SODEX_API_SECRET, SODEX_SUBACCOUNT are required for exchange=sodex');
                process.exit(1);
            }
            console.log(`🔌 Using SoDEX adapter`);
            return new SodexAdapter(SODEX_API_KEY, SODEX_API_SECRET, SODEX_SUBACCOUNT);
        }
        case 'dango': {
            if (!DANGO_PRIVATE_KEY || !DANGO_USER_ADDRESS) {
                console.error('FATAL: DANGO_PRIVATE_KEY, DANGO_USER_ADDRESS are required for exchange=dango');
                process.exit(1);
            }
            console.log(`🔌 Using Dango adapter`);
            return new DangoAdapter(DANGO_PRIVATE_KEY, DANGO_USER_ADDRESS, (DANGO_NETWORK ?? 'mainnet') as 'mainnet' | 'testnet');
        }
        case 'decibel':
        default: {
            if (!DECIBELS_PRIVATE_KEY) {
                console.error('FATAL: DECIBELS_PRIVATE_KEY is required for exchange=decibel');
                process.exit(1);
            }
            console.log(`🔌 Using Decibel adapter`);
            return new DecibelAdapter(
                DECIBELS_PRIVATE_KEY,
                DECIBELS_NODE_API_KEY ?? '',
                DECIBELS_SUBACCOUNT ?? '',
                DECIBELS_BUILDER_ADDRESS?.trim() ?? '',
                10,
                DECIBELS_GAS_STATION_API_KEY,
            );
        }
    }
}

async function bootstrap() {
    const exchange = EXCHANGE ?? config.EXCHANGE ?? 'decibel';
    const symbol = SYMBOL || config.SYMBOL;

    console.log(`\n🚀 SHIELD-BOT starting... [exchange: ${exchange.toUpperCase()} | symbol: ${symbol}]`);

    // Load persisted config overrides before any trading logic runs
    configStore.loadFromDisk();

    // Load persisted bot state (PnL, logs, history)
    loadState();

    // ── Adapter (selected by EXCHANGE env) ───────────────────────────────────
    const adapter = createAdapter(exchange, symbol);

    // ── Core modules ──────────────────────────────────────────────────────────
    const telegramEnabled = process.env.TELEGRAM_ENABLED !== 'false';    const telegram = new TelegramManager(
        telegramEnabled ? TELEGRAM_BOT_TOKEN : undefined,
        telegramEnabled ? TELEGRAM_CHAT_ID : undefined,
    );

    const sessionManager = new SessionManager();
    const watcher = new Watcher(adapter, symbol, telegram, sessionManager);

    const tradeLogger = new TradeLogger(
        (TRADE_LOG_BACKEND as 'json' | 'sqlite') || 'json',
        TRADE_LOG_PATH || './trades.json',
    );

    // ── Dashboard ─────────────────────────────────────────────────────────────
    const dashboardPort = parseInt(DASHBOARD_PORT || '3000', 10);
    const dashboardServer = new DashboardServer(tradeLogger, dashboardPort);

    dashboardServer.setBotControls(sessionManager, watcher, () => {
        watcher.run().catch(err => {
            console.error('Watcher crashed:', err);
            sessionManager.stopSession();
        });
    });

    dashboardServer.setConfigStore(configStore);

    // Set shared state metadata
    sharedState.symbol = symbol;
    if (DECIBELS_SUBACCOUNT) sharedState.walletAddress = DECIBELS_SUBACCOUNT;
    dashboardServer.start();

    // ── Telegram commands ─────────────────────────────────────────────────────
    await telegram.setupMenu();

    telegram.onCommand('start_bot', async () => {
        if (sessionManager.getState().isRunning) {
            await telegram.sendMessage('⚠️ Bot is already running.');
            return;
        }
        const balance = await adapter.get_balance().catch(() => 'N/A');
        const success = sessionManager.startSession();
        if (success) {
            watcher.resetSession();
            const { maxLoss } = sessionManager.getState();
            const startTime = new Date().toLocaleString();
            await telegram.sendMessage(
                `🚀 *Bot started.*\n💰 Balance: \`${balance}\`\n🛡️ Max Loss: \`${maxLoss}\`\n⚙️ Mode: \`${config.MODE}\`\n📈 Symbol: \`${symbol}\`\n🕐 Start: \`${startTime}\``,
                true,
            );
            watcher.run().catch(err => {
                console.error('Watcher crashed:', err);
                sessionManager.stopSession();
            });
        }
    });

    telegram.onCommand('stop_bot', async () => {
        if (!sessionManager.getState().isRunning) {
            await telegram.sendMessage('ℹ️ Bot is not running.');
            return;
        }
        sessionManager.stopSession();
        watcher.stop();
        const cooldownSecs = watcher.getCooldownInfo();
        const cooldownText = cooldownSecs !== null ? `\n⏳ Cooldown: \`${cooldownSecs}s\` remaining.` : '';
        await telegram.sendMessage(`🛑 *Bot stopped.* Session terminated.${cooldownText}`, true);
    });

    telegram.onCommand('set_mode', async (args) => {
        const mode = args[0]?.toLowerCase();
        if (mode !== 'farm' && mode !== 'trade') {
            await telegram.sendMessage(
                `⚙️ *Current mode: \`${config.MODE}\`*\n\nUsage: \`/set_mode farm\` or \`/set_mode trade\`\n\n🚜 *farm* — always enter, TP ${config.FARM_TP_USD}, SL ${config.FARM_SL_PERCENT * 100}%, hold 2-10 min\n📈 *trade* — signal-filtered, TP/SL ${config.TRADE_TP_PERCENT * 100}%`,
            );
            return;
        }
        (config as any).MODE = mode;
        await telegram.sendMessage(`✅ *Mode switched to \`${mode}\`*`, true);
    });

    telegram.onCommand('set_max_loss', async (args) => {
        const amount = parseFloat(args[0]);
        if (isNaN(amount)) {
            await telegram.sendMessage('❌ Usage: `/set_max_loss 10` (USD)');
            return;
        }
        sessionManager.setMaxLoss(amount);
        await telegram.sendMessage(`✅ *Max loss set to ${amount}*`, true);
    });

    telegram.onCommand('status', async () => {
        const state = sessionManager.getState();
        const statusText = state.isRunning ? 'RUNNING' : 'STOPPED';
        const uptime = state.startTime ? Math.floor((Date.now() - state.startTime) / 60000) : 0;
        await telegram.sendMessage(
            `📊 *Bot Status*: \`${statusText}\`\n⚙️ Mode: \`${config.MODE}\`\n⏱️ Uptime: \`${uptime} mins\`\n📉 PnL: \`${state.currentPnL.toFixed(2)}\`\n🛡️ Max Loss: \`${state.maxLoss}\``,
            true,
        );
    });

    telegram.onCommand('check', async () => {
        const status = await watcher.getDetailedStatus();
        if (status.hasPosition) {
            await telegram.sendMessageWithInlineButtons(status.text, [
                [{ text: '🛑 Close Position', callback_data: 'close_position' }],
            ]);
        } else {
            await telegram.sendMessage(status.text, true);
        }
    });

    telegram.onCommand('long', async (args) => {
        if (sessionManager.getState().isRunning) {
            await telegram.sendMessage('⚠️ Stop bot first before placing manual orders.');
            return;
        }
        try {
            const ob = await adapter.get_orderbook(symbol);
            const price = ob.best_bid;
            const size = args[0] ? parseFloat(args[0]) : config.ORDER_SIZE_MIN;
            if (isNaN(size) || size <= 0) {
                await telegram.sendMessage('❌ Usage: `/long 0.008` (size in BTC, optional)');
                return;
            }
            await telegram.sendMessage(`📋 *Manual LONG placing...*\n• Price: \`${price}\` (best bid, Post-Only)\n• Size: \`${size}\``);
            const orderId = await adapter.place_limit_order(symbol, 'buy', price, size);
            await telegram.sendMessage(`✅ *Manual LONG placed*\n• Order ID: \`${orderId}\`\n• Price: \`${price}\`\n• Size: \`${size}\``);
        } catch (err: any) {
            await telegram.sendMessage(`❌ *LONG failed*: ${err.message}`);
        }
    });

    telegram.onCommand('short', async (args) => {
        if (sessionManager.getState().isRunning) {
            await telegram.sendMessage('⚠️ Stop bot first before placing manual orders.');
            return;
        }
        try {
            const ob = await adapter.get_orderbook(symbol);
            const price = ob.best_ask;
            const size = args[0] ? parseFloat(args[0]) : config.ORDER_SIZE_MIN;
            if (isNaN(size) || size <= 0) {
                await telegram.sendMessage('❌ Usage: `/short 0.008` (size in BTC, optional)');
                return;
            }
            await telegram.sendMessage(`📋 *Manual SHORT placing...*\n• Price: \`${price}\` (best ask, Post-Only)\n• Size: \`${size}\``);
            const orderId = await adapter.place_limit_order(symbol, 'sell', price, size);
            await telegram.sendMessage(`✅ *Manual SHORT placed*\n• Order ID: \`${orderId}\`\n• Price: \`${price}\`\n• Size: \`${size}\``);
        } catch (err: any) {
            await telegram.sendMessage(`❌ *SHORT failed*: ${err.message}`);
        }
    });

    telegram.onCallback('close_position', async () => {
        await telegram.sendMessage('🔄 *Manual Close Requested...* Sending exit order.');
        const success = await watcher.forceClosePosition();
        if (success) {
            await telegram.sendMessage('✅ *Position Closed Successfully.*');
        } else {
            await telegram.sendMessage('❌ *Failed to Close Position.* Check logs or dashboard.');
        }
    });

    // ── Graceful shutdown ─────────────────────────────────────────────────────
    const shutdown = async (signal: string) => {
        console.log(`\n🛑 [System] ${signal} received. Shutting down...`);
        if (sessionManager.getState().isRunning) {
            sessionManager.stopSession();
            watcher.stop();
        }
        saveStateSync();
        await telegram.sendMessage(`⚠️ *Bot Shutting Down* (${signal}). Operations suspended.`);
        process.exit(0);
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));

    console.log('📡 [System] Waiting for Telegram commands...');
    await telegram.sendMessage('🤖 *SHIELD-BOT Online* (Decibel)\nControl via menu, buttons, or commands.', true);
}

bootstrap().catch(error => {
    console.error('FATAL: Bot failed to start:', error);
    process.exit(1);
});
