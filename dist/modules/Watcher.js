"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Watcher = void 0;
const config_js_1 = require("../config.js");
const AISignalEngine_js_1 = require("../ai/AISignalEngine.js");
const TradeLogger_js_1 = require("../ai/TradeLogger.js");
const sharedState_js_1 = require("../ai/sharedState.js");
const RiskManager_js_1 = require("./RiskManager.js");
const PositionManager_js_1 = require("./PositionManager.js");
const Executor_js_1 = require("./Executor.js");
class Watcher {
    adapter;
    telegram;
    sessionManager;
    signalEngine;
    riskManager;
    positionManager;
    executor;
    tradeLogger;
    symbol;
    isRunning = false;
    cooldownUntil = null;
    lastTradeContext = null;
    sessionStartBalance = null;
    sessionCurrentPnl = 0;
    sessionVolume = 0;
    // State machine
    botState = 'IDLE';
    pendingEntry = null;
    pendingExit = null;
    entryFilledAt = null;
    farmHoldUntil = null;
    // Memory and Chaos state
    recentPnLs = [];
    currentProfile = 'NORMAL';
    constructor(adapter, symbol, telegram, sessionManager) {
        this.adapter = adapter;
        this.telegram = telegram;
        this.sessionManager = sessionManager;
        this.symbol = symbol;
        this.signalEngine = new AISignalEngine_js_1.AISignalEngine(adapter);
        this.riskManager = new RiskManager_js_1.RiskManager();
        this.positionManager = new PositionManager_js_1.PositionManager();
        this.executor = new Executor_js_1.Executor(adapter, telegram);
        const tradeLogBackend = (process.env.TRADE_LOG_BACKEND ?? 'json');
        const tradeLogPath = process.env.TRADE_LOG_PATH ?? './trades.json';
        this.tradeLogger = new TradeLogger_js_1.TradeLogger(tradeLogBackend, tradeLogPath);
    }
    async run() {
        if (this.isRunning)
            return;
        this.isRunning = true;
        sharedState_js_1.sharedState.botStatus = 'RUNNING';
        (0, sharedState_js_1.logEvent)('INFO', 'Bot started');
        console.log(`\n🚀 [Watcher] Monitoring ${this.symbol} loop started.`);
        while (this.isRunning) {
            try {
                await this.tick();
            }
            catch (error) {
                console.error('‼️ [Watcher] Global error in loop:', error);
            }
            const delayRoll = Math.random();
            let delay = 0;
            if (delayRoll < 0.5)
                delay = Math.random() * (10000 - 2000) + 2000;
            else if (delayRoll < 0.8)
                delay = Math.random() * (30000 - 10000) + 10000;
            else
                delay = Math.random() * (90000 - 30000) + 30000;
            await new Promise(res => setTimeout(res, delay));
        }
    }
    async tick() {
        // 0. Cooldown check
        if (this.cooldownUntil && Date.now() < this.cooldownUntil) {
            const remainingSecs = Math.floor((this.cooldownUntil - Date.now()) / 1000);
            console.log(`\n--- ${new Date().toLocaleTimeString()} Update ---`);
            console.log(`Cooldown active for ${remainingSecs}s.`);
            return;
        }
        else if (this.cooldownUntil && Date.now() >= this.cooldownUntil) {
            this.cooldownUntil = null;
            console.log(`\n✅ Cooldown finished. Resuming normal operations.`);
        }
        // 1. Fetch current state
        const [position, markPrice, balance] = await Promise.all([
            this.adapter.get_position(this.symbol),
            this.adapter.get_mark_price(this.symbol),
            this.adapter.get_balance()
        ]);
        this.positionManager.updateTick(markPrice);
        console.log(`\n--- ${new Date().toLocaleTimeString()} Update --- [State: ${this.botState}]`);
        console.log(`Balance: ${balance.toFixed(2)} | Price: ${markPrice.toFixed(2)}`);
        if (this.sessionStartBalance === null) {
            this.sessionStartBalance = balance;
        }
        this.sessionCurrentPnl = balance - this.sessionStartBalance;
        // Sync open position to sharedState
        if (position && Math.abs(position.size) > 0) {
            sharedState_js_1.sharedState.openPosition = {
                symbol: this.symbol,
                side: position.side,
                size: Math.abs(position.size),
                entryPrice: position.entryPrice,
                markPrice,
                unrealizedPnl: position.unrealizedPnl,
                durationSecs: this.positionManager.getDurationSeconds(),
            };
        }
        else {
            sharedState_js_1.sharedState.openPosition = null;
        }
        // Max loss check — close open position before stopping
        const isMaxLossHit = this.sessionManager.updatePnL(this.sessionCurrentPnl);
        if (isMaxLossHit) {
            console.log(`🛑 [Watcher] Emergency Stop! Max loss limit reached.`);
            await this.telegram.sendMessage(`⚠️ *Bot Auto-Stopped*\nMax loss limit hit: \`-${this.sessionManager.getState().maxLoss}\`.\nFinal Session PnL: \`${this.sessionCurrentPnl.toFixed(2)}\``);
            // Close any open position with IOC before stopping
            if (position && Math.abs(position.size) > 0) {
                console.log(`🛑 [Watcher] Force-closing open position before emergency stop...`);
                await this.executor.placeExitOrder(this.symbol, position, true /* IOC */);
                await this.telegram.sendMessage(`🔄 *Emergency close order sent* for open ${position.side.toUpperCase()} position.`);
            }
            this.stop();
            return;
        }
        // ── State Machine ──────────────────────────────────────────────────────
        // 2. PENDING_ENTRY: check if entry order was filled
        if (this.botState === 'PENDING_ENTRY' && this.pendingEntry) {
            if (position && Math.abs(position.size) > 0) {
                // Position exists → order filled
                const filledSize = Math.abs(position.size);
                const filledVol = filledSize * position.entryPrice;
                this.sessionVolume += filledVol;
                this.botState = 'IN_POSITION';
                this.entryFilledAt = Date.now();
                // Capture actual entry price in signalMeta
                this.pendingEntry.signalMeta.entryPrice = position.entryPrice;
                if (config_js_1.config.MODE === 'farm') {
                    const holdSecs = Math.floor(Math.random() * (config_js_1.config.FARM_MAX_HOLD_SECS - config_js_1.config.FARM_MIN_HOLD_SECS + 1)) + config_js_1.config.FARM_MIN_HOLD_SECS;
                    this.farmHoldUntil = Date.now() + holdSecs * 1000;
                    console.log(`🚜 [FARM] Min hold time: ${holdSecs}s (until ${new Date(this.farmHoldUntil).toLocaleTimeString()})`);
                }
                console.log(`✅ [Watcher] Entry filled: ${filledSize} ${this.symbol} @ ${position.entryPrice}`);
                (0, sharedState_js_1.logEvent)('ORDER_FILLED', `Entry filled: ${this.pendingEntry.direction.toUpperCase()} ${filledSize} @ ${position.entryPrice}`);
                await this.executor.notifyEntryFilled(this.symbol, this.pendingEntry.direction, filledSize, position.entryPrice, { ...this.pendingEntry.meta, sessionPnl: this.sessionCurrentPnl, sessionVolume: this.sessionVolume, reasoning: this._pendingEntrySignalMeta?.reasoning ?? '', fallback: this._pendingEntrySignalMeta?.fallback ?? false });
                this.pendingEntry = null;
            }
            else {
                // No position → order still pending or expired
                const waitedMs = Date.now() - this.pendingEntry.placedAt;
                if (waitedMs < 15000) {
                    console.log(`[Watcher] Entry order pending, waiting... (${Math.floor(waitedMs / 1000)}s / 15s)`);
                    return;
                }
                console.log(`[Watcher] Entry order not filled after 15s. Cancelling and re-placing...`);
                await this.adapter.cancel_all_orders(this.symbol);
                // Re-check position after cancel to avoid double-entry race condition
                const positionAfterCancel = await this.adapter.get_position(this.symbol);
                if (positionAfterCancel && Math.abs(positionAfterCancel.size) > 0) {
                    const filledSize = Math.abs(positionAfterCancel.size);
                    const filledVol = filledSize * positionAfterCancel.entryPrice;
                    this.sessionVolume += filledVol;
                    this.botState = 'IN_POSITION';
                    this.entryFilledAt = Date.now();
                    // Capture actual entry price in signalMeta
                    this.pendingEntry.signalMeta.entryPrice = positionAfterCancel.entryPrice;
                    if (config_js_1.config.MODE === 'farm') {
                        const holdSecs = Math.floor(Math.random() * (config_js_1.config.FARM_MAX_HOLD_SECS - config_js_1.config.FARM_MIN_HOLD_SECS + 1)) + config_js_1.config.FARM_MIN_HOLD_SECS;
                        this.farmHoldUntil = Date.now() + holdSecs * 1000;
                    }
                    console.log(`✅ [Watcher] Entry filled (detected after cancel): ${filledSize} ${this.symbol} @ ${positionAfterCancel.entryPrice}`);
                    await this.executor.notifyEntryFilled(this.symbol, this.pendingEntry.direction, filledSize, positionAfterCancel.entryPrice, { ...this.pendingEntry.meta, sessionPnl: this.sessionCurrentPnl, sessionVolume: this.sessionVolume, reasoning: this._pendingEntrySignalMeta?.reasoning ?? '', fallback: this._pendingEntrySignalMeta?.fallback ?? false });
                    this.pendingEntry = null;
                    return;
                }
                const { direction, meta, signalMeta } = this.pendingEntry;
                const size = this.pendingEntry.order.size;
                const newOrder = await this.executor.placeEntryOrder(this.symbol, direction, size, 1);
                if (newOrder) {
                    this.pendingEntry = { order: newOrder, direction, meta, signalMeta, placedAt: Date.now() };
                }
                else {
                    this.botState = 'IDLE';
                    this.pendingEntry = null;
                }
            }
            return;
        }
        // 3. PENDING_EXIT: check if exit order was filled
        if (this.botState === 'PENDING_EXIT' && this.pendingExit) {
            if (!position || Math.abs(position.size) === 0) {
                // Position gone → exit filled
                const filledSize = this.pendingExit.order.size;
                const filledVol = filledSize * this.pendingExit.order.price;
                this.sessionVolume += filledVol;
                this.lastTradeContext = {
                    side: this.pendingExit.positionSide,
                    exitPrice: this.pendingExit.order.price,
                    pnl: this.pendingExit.pnl
                };
                this.recentPnLs.push(this.pendingExit.pnl);
                if (this.recentPnLs.length > 5)
                    this.recentPnLs.shift();
                this.updateProfile();
                const delayMins = Math.floor(Math.random() * (config_js_1.config.COOLDOWN_MAX_MINS - config_js_1.config.COOLDOWN_MIN_MINS + 1)) + config_js_1.config.COOLDOWN_MIN_MINS;
                this.cooldownUntil = Date.now() + delayMins * 60 * 1000;
                console.log(`⏱️ Post-trade cooldown: ${delayMins} mins. (Profile: ${this.currentProfile})`);
                console.log(`✅ [Watcher] Exit filled: ${filledSize} ${this.symbol} @ ${this.pendingExit.order.price}`);
                await this.executor.notifyExitFilled(this.symbol, this.pendingExit.positionSide, filledSize, this.pendingExit.order.price, this.pendingExit.pnl, { sessionPnl: this.sessionCurrentPnl, sessionVolume: this.sessionVolume, reasoning: this._pendingEntrySignalMeta?.reasoning ?? '', fallback: this._pendingEntrySignalMeta?.fallback ?? false });
                // Log trade record (fire-and-forget)
                const tradeRecord = {
                    id: crypto.randomUUID(),
                    timestamp: new Date().toISOString(),
                    symbol: this.symbol,
                    direction: this.pendingExit.positionSide,
                    confidence: this._pendingEntrySignalMeta?.confidence ?? 0,
                    reasoning: this._pendingEntrySignalMeta?.reasoning ?? '',
                    fallback: this._pendingEntrySignalMeta?.fallback ?? false,
                    entryPrice: this._pendingEntrySignalMeta?.entryPrice ?? 0,
                    exitPrice: this.pendingExit.order.price,
                    pnl: this.pendingExit.pnl,
                    sessionPnl: this.sessionCurrentPnl,
                };
                this.tradeLogger.log(tradeRecord);
                sharedState_js_1.sharedState.sessionPnl = this.sessionCurrentPnl;
                sharedState_js_1.sharedState.sessionVolume = this.sessionVolume;
                sharedState_js_1.sharedState.updatedAt = new Date().toISOString();
                const now = new Date().toISOString();
                sharedState_js_1.sharedState.pnlHistory.push({ time: now, value: this.sessionCurrentPnl });
                sharedState_js_1.sharedState.volumeHistory.push({ time: now, value: this.sessionVolume });
                (0, sharedState_js_1.logEvent)('ORDER_FILLED', `Exit filled: ${this.pendingExit.positionSide.toUpperCase()} ${tradeRecord.exitPrice} | PnL: ${this.pendingExit.pnl.toFixed(4)}`);
                this._pendingEntrySignalMeta = null;
                this.positionManager.onPositionClosed();
                this.botState = 'IDLE';
                this.pendingExit = null;
                this.entryFilledAt = null;
                this.farmHoldUntil = null;
            }
            else {
                // Position still open → wait 15s before cancelling and re-placing exit
                const waitedMs = Date.now() - this.pendingExit.placedAt;
                if (waitedMs < 15000) {
                    console.log(`[Watcher] Exit order pending, waiting... (${Math.floor(waitedMs / 1000)}s / 15s)`);
                    return;
                }
                console.log(`[Watcher] Exit order not filled after 15s. Cancelling and re-placing at current price...`);
                await this.adapter.cancel_all_orders(this.symbol);
                const newOrder = await this.executor.placeExitOrder(this.symbol, position, this.pendingExit.forceClose);
                if (newOrder) {
                    this.pendingExit = { ...this.pendingExit, order: newOrder, placedAt: Date.now() };
                }
                else {
                    console.error(`[Watcher] Failed to re-place exit order. Will retry next tick.`);
                }
            }
            return;
        }
        // 4. IN_POSITION: check exit conditions
        if (this.botState === 'IN_POSITION' && (!position || Math.abs(position.size) === 0)) {
            // Position closed externally
            console.log(`[Watcher] Position closed externally. Syncing state to IDLE.`);
            await this.telegram.sendMessage(`ℹ️ *Position closed externally*\n• Symbol: \`${this.symbol}\`\n• Detected on tick.`);
            this.positionManager.onPositionClosed();
            const delayMins = Math.floor(Math.random() * (config_js_1.config.COOLDOWN_MAX_MINS - config_js_1.config.COOLDOWN_MIN_MINS + 1)) + config_js_1.config.COOLDOWN_MIN_MINS;
            this.cooldownUntil = Date.now() + delayMins * 60 * 1000;
            this.botState = 'IDLE';
            this.entryFilledAt = null;
            this.farmHoldUntil = null;
            return;
        }
        if (this.botState === 'IN_POSITION' && position && Math.abs(position.size) > 0) {
            this.positionManager.onPositionOpened(position, this.currentProfile);
            const duration = this.positionManager.getDurationSeconds();
            const pnl = position.unrealizedPnl;
            console.log(`📍 ACTIVE ${position.side.toUpperCase()}: ${position.size} ${position.symbol}`);
            console.log(`   Entry: ${position.entryPrice.toFixed(2)} | PnL: ${pnl.toFixed(2)} | Time: ${duration}s`);
            const shouldRiskExit = this.riskManager.shouldClose(markPrice, position);
            let shouldExit = false;
            let exitTrigger = '';
            if (shouldRiskExit) {
                shouldExit = true;
                exitTrigger = 'SL/TP (RiskManager)';
            }
            else if (config_js_1.config.MODE === 'farm') {
                // Farm mode: TP at $1 immediately (no need to wait hold time)
                if (pnl >= config_js_1.config.FARM_TP_USD) {
                    shouldExit = true;
                    exitTrigger = `FARM TP (${pnl.toFixed(2)} >= ${config_js_1.config.FARM_TP_USD})`;
                }
                else {
                    const holdDone = !this.farmHoldUntil || Date.now() >= this.farmHoldUntil;
                    if (!holdDone) {
                        const remainSecs = Math.floor((this.farmHoldUntil - Date.now()) / 1000);
                        // Early exit: held > 2 mins and PnL > $0.4
                        if (duration >= 120 && pnl >= 0.4) {
                            shouldExit = true;
                            exitTrigger = `FARM EARLY PROFIT (${pnl.toFixed(2)} after ${duration}s)`;
                        }
                        else {
                            console.log(`🚜 [FARM] Holding... ${remainSecs}s remaining | PnL: ${pnl.toFixed(2)}`);
                        }
                    }
                    else {
                        // Hold time expired → close regardless of PnL
                        shouldExit = true;
                        exitTrigger = `FARM TIME EXIT (PnL: ${pnl.toFixed(2)})`;
                    }
                }
            }
            else {
                // Trade mode: behavior engine handles time/trailing exits
                const behaviorTrigger = this.positionManager.shouldBehaviorExit(position, markPrice, this.currentProfile);
                if (behaviorTrigger) {
                    shouldExit = true;
                    exitTrigger = behaviorTrigger;
                }
            }
            if (shouldExit) {
                console.log(`🚨 EXIT TRIGGER: ${exitTrigger}`);
                const order = await this.executor.placeExitOrder(this.symbol, position);
                if (order) {
                    this.botState = 'PENDING_EXIT';
                    this.pendingExit = {
                        order,
                        positionSide: position.side,
                        pnl,
                        forceClose: false,
                        placedAt: Date.now()
                    };
                }
            }
            else {
                console.log(`ℹ️ Holding... (Next check in 10-20s)`);
            }
            return;
        }
        // 5. IDLE: search for entry signal
        if (this.botState === 'IDLE') {
            // If position exists but state is IDLE (e.g. after restart), sync state
            if (position && Math.abs(position.size) > 0) {
                console.log(`[Watcher] Detected existing position on IDLE state — syncing to IN_POSITION.`);
                this.botState = 'IN_POSITION';
                return;
            }
            this.positionManager.onPositionClosed();
            const signal = await this.signalEngine.getSignal(this.symbol);
            let bias = 0;
            let finalDirection = 'skip';
            if (config_js_1.config.MODE === 'farm') {
                // Farm mode: always enter, direction = contrarian signal score
                finalDirection = signal.score >= 0.5 ? 'long' : 'short';
                console.log(`🚜 [FARM] Score: ${signal.score.toFixed(2)} → ${finalDirection.toUpperCase()}`);
            }
            else {
                // Trade mode: strict filtering
                if (this.lastTradeContext) {
                    const { side: lastSide, exitPrice, pnl } = this.lastTradeContext;
                    const isLoss = pnl < 0;
                    if (lastSide === 'short') {
                        if (isLoss && markPrice > exitPrice)
                            bias -= 0.1;
                        else if (!isLoss && markPrice < exitPrice)
                            bias += 0.1;
                    }
                    else if (lastSide === 'long') {
                        if (isLoss && markPrice < exitPrice)
                            bias += 0.1;
                        else if (!isLoss && markPrice > exitPrice)
                            bias -= 0.1;
                    }
                }
                let final_score = signal.base_score + bias;
                if (signal.regime === 'TREND_UP' && final_score < 0)
                    final_score *= 0.5;
                if (signal.regime === 'TREND_DOWN' && final_score > 0)
                    final_score *= 0.5;
                const threshold = 0.65;
                if (final_score > threshold)
                    finalDirection = 'long';
                else if (final_score < -threshold)
                    finalDirection = 'short';
                console.log(`🧠 [TRADE] Base: ${signal.base_score.toFixed(2)} | Bias: ${bias.toFixed(2)} | Regime: ${signal.regime}`);
                console.log(`   => Final Score: ${final_score.toFixed(2)} | Direction: ${finalDirection.toUpperCase()}`);
            }
            if (finalDirection !== 'skip') {
                // Confidence filter — trade mode only
                if (config_js_1.config.MODE !== 'farm' && signal.confidence < config_js_1.config.MIN_CONFIDENCE) {
                    console.log(`😴 Signal too weak (confidence: ${signal.confidence.toFixed(2)} < ${config_js_1.config.MIN_CONFIDENCE}). Skipping.`);
                    return;
                }
                if (balance < 15) {
                    console.log(`🚨 FATAL: Insufficient balance (${balance.toFixed(2)}). Stopping bot!`);
                    await this.telegram.sendMessage(`🚨 *CRITICAL STOP*\nBalance below $15 (Current: \`${balance.toFixed(2)}\`). Shutting down.`);
                    process.exit(1);
                }
                // Scale order size with confidence: stronger signal → larger size
                const confidenceScale = Math.min(signal.confidence / config_js_1.config.MIN_CONFIDENCE, 1.5);
                const baseSize = config_js_1.config.ORDER_SIZE_MIN + Math.random() * (config_js_1.config.ORDER_SIZE_MAX - config_js_1.config.ORDER_SIZE_MIN);
                const size = Math.max(config_js_1.config.ORDER_SIZE_MIN, Math.min(baseSize * confidenceScale, config_js_1.config.ORDER_SIZE_MAX * 1.5));
                console.log(`📐 Order size: ${size.toFixed(5)} (confidence scale: ${confidenceScale.toFixed(2)}x)`);
                const order = await this.executor.placeEntryOrder(this.symbol, finalDirection, size);
                if (order) {
                    (0, sharedState_js_1.logEvent)('ORDER_PLACED', `Order placed: ${finalDirection.toUpperCase()} ${size.toFixed(3)} @ ${order.price}`);
                    this.botState = 'PENDING_ENTRY';
                    this._pendingEntrySignalMeta = {
                        reasoning: signal.reasoning,
                        confidence: signal.confidence,
                        fallback: signal.fallback,
                        entryPrice: 0,
                    };
                    this.pendingEntry = {
                        order,
                        direction: finalDirection,
                        meta: {
                            baseScore: signal.base_score,
                            bias,
                            regime: signal.regime,
                            finalScore: signal.score
                        },
                        signalMeta: this._pendingEntrySignalMeta,
                        placedAt: Date.now()
                    };
                }
            }
            else {
                console.log(`😴 Market neutral. Skipping trade...`);
            }
        }
    }
    // Stored separately so it survives pendingEntry being cleared at fill
    _pendingEntrySignalMeta = null;
    updateProfile() {
        let winStreak = 0;
        let lossStreak = 0;
        for (let i = this.recentPnLs.length - 1; i >= 0; i--) {
            if (this.recentPnLs[i] > 0 && lossStreak === 0)
                winStreak++;
            else if (this.recentPnLs[i] < 0 && winStreak === 0)
                lossStreak++;
            else
                break;
        }
        if (winStreak >= 3)
            this.currentProfile = Math.random() > 0.5 ? 'RUNNER' : 'DEGEN';
        else if (lossStreak >= 3)
            this.currentProfile = Math.random() > 0.5 ? 'SCALP' : 'DEGEN';
        else
            this.currentProfile = 'NORMAL';
    }
    async forceClosePosition() {
        const position = await this.adapter.get_position(this.symbol);
        if (!position || position.size === 0) {
            console.log(`⚠️ [Watcher] Force close failed: No active position found.`);
            return false;
        }
        console.log(`🛑 [Watcher] Manual force close requested.`);
        const order = await this.executor.placeExitOrder(this.symbol, position, true /* IOC */);
        if (!order)
            return false;
        this.botState = 'PENDING_EXIT';
        this.pendingExit = {
            order,
            positionSide: position.side,
            pnl: position.unrealizedPnl,
            forceClose: true,
            placedAt: Date.now()
        };
        this.cooldownUntil = Date.now() + 60000;
        return true;
    }
    async getDetailedStatus() {
        const [position, markPrice, balance] = await Promise.all([
            this.adapter.get_position(this.symbol),
            this.adapter.get_mark_price(this.symbol),
            this.adapter.get_balance()
        ]);
        let statusText = `Balance: *${balance.toFixed(2)}* | Price: *${markPrice.toFixed(2)}*\n`;
        statusText += `State: *${this.botState}* | Profile: *${this.currentProfile}*\n`;
        if (position && position.size !== 0) {
            const duration = this.positionManager.getDurationSeconds();
            const pnl = position.unrealizedPnl;
            statusText += `📍 *ACTIVE ${position.side.toUpperCase()}*: \`${position.size} ${position.symbol}\`\n`;
            statusText += `   Entry: \`${position.entryPrice.toFixed(2)}\` | PnL: \`${pnl.toFixed(2)}\` | Time: \`${duration}s\`\n`;
            statusText += `ℹ️ *Holding...* (Next check in 10-20s)`;
            return { text: statusText, hasPosition: true };
        }
        else {
            statusText += `💤 No active position for ${this.symbol}.\n`;
            statusText += `🔍 Searching for signals...`;
            return { text: statusText, hasPosition: false };
        }
    }
    stop() {
        this.isRunning = false;
        sharedState_js_1.sharedState.botStatus = 'STOPPED';
        (0, sharedState_js_1.logEvent)('INFO', 'Bot stopped');
    }
    getCooldownInfo() {
        if (this.cooldownUntil === null || Date.now() >= this.cooldownUntil)
            return null;
        return Math.floor((this.cooldownUntil - Date.now()) / 1000);
    }
    resetSession() {
        this.sessionStartBalance = null;
        this.sessionCurrentPnl = 0;
        this.sessionVolume = 0;
        this.recentPnLs = [];
        this.currentProfile = 'NORMAL';
        this.cooldownUntil = null;
        this.lastTradeContext = null;
        this.botState = 'IDLE';
        this.pendingEntry = null;
        this.pendingExit = null;
        this.entryFilledAt = null;
        this.farmHoldUntil = null;
        this._pendingEntrySignalMeta = null;
    }
}
exports.Watcher = Watcher;
