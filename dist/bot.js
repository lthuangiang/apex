"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const dotenv = __importStar(require("dotenv"));
dotenv.config();
const sharedState_js_1 = require("./ai/sharedState.js");
(0, sharedState_js_1.interceptConsole)();
const config_js_1 = require("./config.js");
const sodex_adapter_js_1 = require("./adapters/sodex_adapter.js");
const decibel_adapter_js_1 = require("./adapters/decibel_adapter.js");
const TelegramManager_js_1 = require("./modules/TelegramManager.js");
const Watcher_js_1 = require("./modules/Watcher.js");
const SessionManager_js_1 = require("./modules/SessionManager.js");
const TradeLogger_js_1 = require("./ai/TradeLogger.js");
const server_js_1 = require("./dashboard/server.js");
const sharedState_js_2 = require("./ai/sharedState.js");
const { TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, DECIBELS_PRIVATE_KEY, DECIBELS_SUBACCOUNT, DECIBELS_NODE_API_KEY, SODEX_API_KEY, SODEX_API_SECRET, SODEX_SUBACCOUNT, TRADE_LOG_BACKEND, TRADE_LOG_PATH, DASHBOARD_PORT, } = process.env;
async function bootstrap() {
    console.log(`\n🚀 SHIELD-BOT: Farming + Trading Agent starting...`);
    const sessionManager = new SessionManager_js_1.SessionManager();
    const telegramEnabled = process.env.TELEGRAM_ENABLED !== 'false';
    const telegram = new TelegramManager_js_1.TelegramManager(telegramEnabled ? TELEGRAM_BOT_TOKEN : undefined, telegramEnabled ? TELEGRAM_CHAT_ID : undefined);
    let adapter;
    const symbol = config_js_1.config.EXCHANGE === 'sodex' ? config_js_1.config.SYMBOL : config_js_1.config.MARKET;
    if (config_js_1.config.EXCHANGE === 'sodex') {
        if (!SODEX_API_KEY || !SODEX_API_SECRET || !SODEX_SUBACCOUNT) {
            throw new Error("Missing SoDex settings in .env");
        }
        adapter = new sodex_adapter_js_1.SodexAdapter(SODEX_API_KEY, SODEX_API_SECRET, SODEX_SUBACCOUNT);
    }
    else {
        if (!DECIBELS_PRIVATE_KEY || !DECIBELS_SUBACCOUNT) {
            throw new Error("Missing Decibel settings in .env");
        }
        adapter = new decibel_adapter_js_1.DecibelAdapter(DECIBELS_PRIVATE_KEY, DECIBELS_NODE_API_KEY || "0x0", DECIBELS_SUBACCOUNT);
    }
    const watcher = new Watcher_js_1.Watcher(adapter, symbol, telegram, sessionManager);
    // ── Dashboard & Trade Logger ──────────────────────────────────────────────
    const tradeLogger = new TradeLogger_js_1.TradeLogger(TRADE_LOG_BACKEND || 'json', TRADE_LOG_PATH || './trades.json');
    const dashboardPort = parseInt(DASHBOARD_PORT || '3000', 10);
    const dashboardServer = new server_js_1.DashboardServer(tradeLogger, dashboardPort);
    dashboardServer.setBotControls(sessionManager, watcher, () => {
        watcher.run().catch(err => {
            console.error("Watcher crashed:", err);
            sessionManager.stopSession();
        });
    });
    dashboardServer.start();
    // Set shared state metadata
    sharedState_js_2.sharedState.symbol = symbol;
    if (config_js_1.config.EXCHANGE === 'sodex' && SODEX_SUBACCOUNT)
        sharedState_js_2.sharedState.walletAddress = SODEX_SUBACCOUNT;
    await telegram.setupMenu();
    // ── Bot control ───────────────────────────────────────────────────────────
    telegram.onCommand('start_bot', async () => {
        if (sessionManager.getState().isRunning) {
            await telegram.sendMessage("⚠️ Bot is already running.");
            return;
        }
        const balance = await adapter.get_balance();
        const success = sessionManager.startSession();
        if (success) {
            watcher.resetSession();
            const { maxLoss } = sessionManager.getState();
            const startTime = new Date().toLocaleString();
            await telegram.sendMessage(`🚀 *Bot started.*\n💰 Balance: \`${balance}\`\n🛡️ Max Loss: \`${maxLoss}\`\n⚙️ Mode: \`${config_js_1.config.MODE}\`\n📈 Symbol: \`${symbol}\`\n🕐 Start: \`${startTime}\``, true);
            watcher.run().catch(err => {
                console.error("Watcher crashed:", err);
                sessionManager.stopSession();
            });
        }
    });
    telegram.onCommand('stop_bot', async () => {
        if (!sessionManager.getState().isRunning) {
            await telegram.sendMessage("ℹ️ Bot is not running.");
            return;
        }
        sessionManager.stopSession();
        watcher.stop();
        const cooldownSecs = watcher.getCooldownInfo();
        const cooldownText = cooldownSecs !== null
            ? `\n⏳ Cooldown: \`${cooldownSecs}s\` remaining.`
            : '';
        await telegram.sendMessage("🛑 *Bot stopped.* Session terminated." + cooldownText, true);
    });
    telegram.onCommand('set_mode', async (args) => {
        const mode = args[0]?.toLowerCase();
        if (mode !== 'farm' && mode !== 'trade') {
            await telegram.sendMessage(`⚙️ *Current mode: \`${config_js_1.config.MODE}\`*\n\nUsage: \`/set_mode farm\` or \`/set_mode trade\`\n\n🚜 *farm* — always enter, TP $${config_js_1.config.FARM_TP_USD}, SL ${config_js_1.config.FARM_SL_PERCENT * 100}%, hold 2-10 min\n📈 *trade* — signal-filtered, TP/SL ${config_js_1.config.TRADE_TP_PERCENT * 100}%`);
            return;
        }
        config_js_1.config.MODE = mode;
        await telegram.sendMessage(`✅ *Mode switched to \`${mode}\`*`, true);
    });
    // ── Session settings ──────────────────────────────────────────────────────
    telegram.onCommand('set_max_loss', async (args) => {
        const amount = parseFloat(args[0]);
        if (isNaN(amount)) {
            await telegram.sendMessage("❌ Usage: `/set_max_loss 10` (USD)");
            return;
        }
        sessionManager.setMaxLoss(amount);
        await telegram.sendMessage(`✅ *Max loss set to $${amount}*`, true);
    });
    // ── Status & monitoring ───────────────────────────────────────────────────
    telegram.onCommand('status', async () => {
        const state = sessionManager.getState();
        const statusText = state.isRunning ? "RUNNING" : "STOPPED";
        const uptime = state.startTime ? Math.floor((Date.now() - state.startTime) / 60000) : 0;
        await telegram.sendMessage(`📊 *Bot Status*: \`${statusText}\`\n⚙️ Mode: \`${config_js_1.config.MODE}\`\n⏱️ Uptime: \`${uptime} mins\`\n📉 PnL: \`$${state.currentPnL.toFixed(2)}\`\n🛡️ Max Loss: \`$${state.maxLoss}\``, true);
    });
    telegram.onCommand('check', async () => {
        const status = await watcher.getDetailedStatus();
        if (status.hasPosition) {
            await telegram.sendMessageWithInlineButtons(status.text, [
                [{ text: '🛑 Close Position', callback_data: 'close_position' }]
            ]);
        }
        else {
            await telegram.sendMessage(status.text, true);
        }
    });
    // ── Manual trading (bot must be stopped) ─────────────────────────────────
    telegram.onCommand('long', async (args) => {
        if (sessionManager.getState().isRunning) {
            await telegram.sendMessage("⚠️ Stop bot first before placing manual orders.");
            return;
        }
        try {
            const ob = await adapter.get_orderbook(symbol);
            const price = ob.best_bid; // Post-Only: join bid side as maker
            const size = args[0] ? parseFloat(args[0]) : config_js_1.config.ORDER_SIZE_MIN;
            if (isNaN(size) || size <= 0) {
                await telegram.sendMessage("❌ Usage: `/long 0.008` (size in BTC, optional)");
                return;
            }
            await telegram.sendMessage(`📋 *Manual LONG placing...*\n• Price: \`${price}\` (best bid, Post-Only)\n• Size: \`${size}\``);
            const orderId = await adapter.place_limit_order(symbol, 'buy', price, size);
            await telegram.sendMessage(`✅ *Manual LONG placed*\n• Order ID: \`${orderId}\`\n• Price: \`${price}\`\n• Size: \`${size}\``);
        }
        catch (err) {
            await telegram.sendMessage(`❌ *LONG failed*: ${err.message}`);
        }
    });
    telegram.onCommand('short', async (args) => {
        if (sessionManager.getState().isRunning) {
            await telegram.sendMessage("⚠️ Stop bot first before placing manual orders.");
            return;
        }
        try {
            const ob = await adapter.get_orderbook(symbol);
            const price = ob.best_ask; // Post-Only: join ask side as maker
            const size = args[0] ? parseFloat(args[0]) : config_js_1.config.ORDER_SIZE_MIN;
            if (isNaN(size) || size <= 0) {
                await telegram.sendMessage("❌ Usage: `/short 0.008` (size in BTC, optional)");
                return;
            }
            await telegram.sendMessage(`📋 *Manual SHORT placing...*\n• Price: \`${price}\` (best ask, Post-Only)\n• Size: \`${size}\``);
            const orderId = await adapter.place_limit_order(symbol, 'sell', price, size);
            await telegram.sendMessage(`✅ *Manual SHORT placed*\n• Order ID: \`${orderId}\`\n• Price: \`${price}\`\n• Size: \`${size}\``);
        }
        catch (err) {
            await telegram.sendMessage(`❌ *SHORT failed*: ${err.message}`);
        }
    });
    // ── Callbacks ─────────────────────────────────────────────────────────────
    telegram.onCallback('close_position', async () => {
        await telegram.sendMessage("🔄 *Manual Close Requested...* Sending exit order.");
        const success = await watcher.forceClosePosition();
        if (success) {
            await telegram.sendMessage("✅ *Position Closed Successfully.*");
        }
        else {
            await telegram.sendMessage("❌ *Failed to Close Position.* Check logs or dashboard.");
        }
    });
    // ── Graceful shutdown ─────────────────────────────────────────────────────
    const shutdown = async (signal) => {
        console.log(`\n🛑 [System] ${signal} received. Shutting down...`);
        if (sessionManager.getState().isRunning) {
            sessionManager.stopSession();
            watcher.stop();
        }
        await telegram.sendMessage(`⚠️ *Bot Shutting Down* (${signal}). Operations suspended.`);
        process.exit(0);
    };
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
    console.log('📡 [System] Waiting for Telegram commands...');
    await telegram.sendMessage("🤖 *SHIELD-BOT Online*\nControl via menu, buttons, or commands.", true);
}
bootstrap().catch(error => {
    console.error("FATAL: Bot failed to start:", error);
    process.exit(1);
});
