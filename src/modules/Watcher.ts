import { config } from '../config.js';
import { ExchangeAdapter } from '../adapters/ExchangeAdapter.js';
import { AISignalEngine } from '../ai/AISignalEngine.js';
import { TradeLogger, TradeRecord } from '../ai/TradeLogger.js';
import { sharedState, logEvent } from '../ai/sharedState.js';
import { saveState } from '../ai/StateStore.js';
import { RiskManager } from './RiskManager.js';
import { PositionManager } from './PositionManager.js';
import { Executor, PendingOrder } from './Executor.js';
import { TelegramManager } from './TelegramManager.js';
import { SessionManager } from './SessionManager.js';

type BotState = 'IDLE' | 'PENDING_ENTRY' | 'IN_POSITION' | 'PENDING_EXIT';

interface PendingEntryState {
    order: PendingOrder;
    direction: 'long' | 'short';
    meta: { baseScore: number; bias: number; regime: string; finalScore: number };
    signalMeta: { reasoning: string; confidence: number; fallback: boolean; entryPrice: number };
    placedAt: number;
    replaceCount: number; // số lần đã re-place
}

interface PendingExitState {
    order: PendingOrder;
    positionSide: 'long' | 'short';
    pnl: number;
    forceClose: boolean;
    placedAt: number;
}

export class Watcher {
    private signalEngine: AISignalEngine;
    private riskManager: RiskManager;
    private positionManager: PositionManager;
    private executor: Executor;
    private tradeLogger: TradeLogger;
    private symbol: string;
    private isRunning: boolean = false;
    private cooldownUntil: number | null = null;
    private lastTradeContext: { side: 'long' | 'short', exitPrice: number, pnl: number } | null = null;
    private sessionStartBalance: number | null = null;
    private sessionCurrentPnl: number = 0;
    private sessionVolume: number = 0;

    // State machine
    private botState: BotState = 'IDLE';
    private pendingEntry: PendingEntryState | null = null;
    private pendingExit: PendingExitState | null = null;
    private entryFilledAt: number | null = null;
    private farmHoldUntil: number | null = null;

    // Memory and Chaos state
    private recentPnLs: number[] = [];
    private currentProfile: 'SCALP' | 'NORMAL' | 'RUNNER' | 'DEGEN' = 'NORMAL';

    constructor(
        private adapter: ExchangeAdapter,
        symbol: string,
        private telegram: TelegramManager,
        private sessionManager: SessionManager
    ) {
        this.symbol = symbol;
        this.signalEngine = new AISignalEngine(adapter);
        this.riskManager = new RiskManager();
        this.positionManager = new PositionManager();
        this.executor = new Executor(adapter, telegram);
        const tradeLogBackend = (process.env.TRADE_LOG_BACKEND ?? 'json') as 'json' | 'sqlite';
        const tradeLogPath = process.env.TRADE_LOG_PATH ?? './trades.json';
        this.tradeLogger = new TradeLogger(tradeLogBackend, tradeLogPath);
    }

    async run() {
        if (this.isRunning) return;
        this.isRunning = true;
        sharedState.botStatus = 'RUNNING';
        logEvent('INFO', 'Bot started');
        console.log(`\n🚀 [Watcher] Monitoring ${this.symbol} loop started.`);

        while (this.isRunning) {
            try {
                await this.tick();
            } catch (error) {
                console.error('‼️ [Watcher] Global error in loop:', error);
            }

            const delayRoll = Math.random();
            let delay = 0;
            if (delayRoll < 0.5) delay = Math.random() * (10000 - 2000) + 2000;
            else if (delayRoll < 0.8) delay = Math.random() * (30000 - 10000) + 10000;
            else delay = Math.random() * (90000 - 30000) + 30000;

            await new Promise(res => setTimeout(res, delay));
        }
    }

    private async tick() {
        // 0. Cooldown check — BEFORE any API calls to avoid wasting requests
        if (this.cooldownUntil && Date.now() < this.cooldownUntil) {
            const remainingSecs = Math.floor((this.cooldownUntil - Date.now()) / 1000);
            console.log(`\n--- ${new Date().toLocaleTimeString()} Update ---`);
            console.log(`Cooldown active for ${remainingSecs}s.`);
            return;
        } else if (this.cooldownUntil && Date.now() >= this.cooldownUntil) {
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
            const holdRemainingMs = (this.farmHoldUntil && Date.now() < this.farmHoldUntil)
                ? this.farmHoldUntil - Date.now()
                : null;
            sharedState.openPosition = {
                symbol: this.symbol,
                side: position.side as 'long' | 'short',
                size: Math.abs(position.size),
                entryPrice: position.entryPrice,
                markPrice,
                unrealizedPnl: position.unrealizedPnl,
                durationSecs: this.positionManager.getDurationSeconds(),
                holdRemainingMs,
            };
        } else {
            sharedState.openPosition = null;
        }

        // Max loss check — close open position before stopping
        const isMaxLossHit = this.sessionManager.updatePnL(this.sessionCurrentPnl);
        if (isMaxLossHit) {
            console.log(`🛑 [Watcher] Emergency Stop! Max loss limit reached.`);
            await this.telegram.sendMessage(
                `⚠️ *Bot Auto-Stopped*\nMax loss limit hit: \`-${this.sessionManager.getState().maxLoss}\`.\nFinal Session PnL: \`${this.sessionCurrentPnl.toFixed(2)}\``
            );
            // Close any open position with IOC before stopping
            if (position && Math.abs(position.size) > 0) {
                console.log(`🛑 [Watcher] Force-closing open position before emergency stop...`);
                await this.executor.placeExitOrder(this.symbol, position, true /* IOC */);
                await this.telegram.sendMessage(
                    `🔄 *Emergency close order sent* for open ${position.side.toUpperCase()} position.`
                );
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
                // Store entryTime in signalMeta for trade record
                if (this._pendingEntrySignalMeta) this._pendingEntrySignalMeta.entryTime = this.entryFilledAt;

                // Capture actual entry price in signalMeta
                this.pendingEntry.signalMeta.entryPrice = position.entryPrice;

                if (config.MODE === 'farm') {
                    const holdSecs = Math.floor(Math.random() * (config.FARM_MAX_HOLD_SECS - config.FARM_MIN_HOLD_SECS + 1)) + config.FARM_MIN_HOLD_SECS;
                    this.farmHoldUntil = Date.now() + holdSecs * 1000;
                    console.log(`🚜 [FARM] Min hold time: ${holdSecs}s (until ${new Date(this.farmHoldUntil).toLocaleTimeString()})`);
                }

                console.log(`✅ [Watcher] Entry filled: ${filledSize} ${this.symbol} @ ${position.entryPrice}`);
                logEvent('ORDER_FILLED', `Entry filled: ${this.pendingEntry.direction.toUpperCase()} ${filledSize} @ ${position.entryPrice}`);
                await this.executor.notifyEntryFilled(
                    this.symbol,
                    this.pendingEntry.direction,
                    filledSize,
                    position.entryPrice,
                    { ...this.pendingEntry.meta, sessionPnl: this.sessionCurrentPnl, sessionVolume: this.sessionVolume, reasoning: this._pendingEntrySignalMeta?.reasoning ?? '', fallback: this._pendingEntrySignalMeta?.fallback ?? false }
                );
                this.pendingEntry = null;
            } else {
                // No position → order still pending or expired
                const waitedMs = Date.now() - this.pendingEntry.placedAt;
                // Farm mode: re-place nhanh hơn (5s) để không mất thời gian hold
                const fillTimeout = config.MODE === 'farm' ? 5000 : 15000;
                if (waitedMs < fillTimeout) {
                    console.log(`[Watcher] Entry order pending, waiting... (${Math.floor(waitedMs / 1000)}s / ${fillTimeout/1000}s)`);
                    return;
                }

                console.log(`[Watcher] Entry order not filled after ${fillTimeout/1000}s. Cancelling and re-placing...`);
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

                    if (config.MODE === 'farm') {
                        const holdSecs = Math.floor(Math.random() * (config.FARM_MAX_HOLD_SECS - config.FARM_MIN_HOLD_SECS + 1)) + config.FARM_MIN_HOLD_SECS;
                        this.farmHoldUntil = Date.now() + holdSecs * 1000;
                    }

                    console.log(`✅ [Watcher] Entry filled (detected after cancel): ${filledSize} ${this.symbol} @ ${positionAfterCancel.entryPrice}`);
                    await this.executor.notifyEntryFilled(
                        this.symbol,
                        this.pendingEntry.direction,
                        filledSize,
                        positionAfterCancel.entryPrice,
                        { ...this.pendingEntry.meta, sessionPnl: this.sessionCurrentPnl, sessionVolume: this.sessionVolume, reasoning: this._pendingEntrySignalMeta?.reasoning ?? '', fallback: this._pendingEntrySignalMeta?.fallback ?? false }
                    );
                    this.pendingEntry = null;
                    return;
                }

                const { direction, meta, signalMeta } = this.pendingEntry;
                const size = this.pendingEntry.order.size;

                // Farm mode: giới hạn 3 lần re-place, nếu vẫn không fill thì bỏ qua
                const maxReplace = config.MODE === 'farm' ? 3 : 10;
                if (this.pendingEntry.replaceCount >= maxReplace) {
                    console.log(`[Watcher] Entry order failed to fill after ${maxReplace} attempts. Giving up.`);
                    this.botState = 'IDLE';
                    this.pendingEntry = null;
                    return;
                }

                const newOrder = await this.executor.placeEntryOrder(this.symbol, direction, size, 1);
                if (newOrder) {
                    this.pendingEntry = { order: newOrder, direction, meta, signalMeta, placedAt: Date.now(), replaceCount: this.pendingEntry.replaceCount + 1 };
                } else {
                    this.botState = 'IDLE';
                    this.pendingEntry = null;
                }
            }
            return;
        }

        // 3. PENDING_EXIT: check if exit order was filled
        if (this.botState === 'PENDING_EXIT' && this.pendingExit) {
            // Dust position check: if position value is too small, API will reject close order
            // Skip closing and reset to IDLE to avoid getting stuck
            if (position && Math.abs(position.size) > 0) {
                const positionValueUsd = Math.abs(position.size) * markPrice;
                if (positionValueUsd < config.MIN_POSITION_VALUE_USD) {
                    console.log(`[Watcher] Dust position detected (value: $${positionValueUsd.toFixed(2)} < $${config.MIN_POSITION_VALUE_USD}). Skipping close, resetting to IDLE.`);
                    logEvent('WARN', `Dust position skipped ($${positionValueUsd.toFixed(2)}). Continuing to next trade.`);
                    await this.adapter.cancel_all_orders(this.symbol);
                    this.positionManager.onPositionClosed();
                    this.botState = 'IDLE';
                    this.pendingExit = null;
                    this.entryFilledAt = null;
                    this.farmHoldUntil = null;
                    const delayMins = config.COOLDOWN_MIN_MINS;
                    this.cooldownUntil = Date.now() + delayMins * 60 * 1000;
                    return;
                }
            }

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
                if (this.recentPnLs.length > 5) this.recentPnLs.shift();
                this.updateProfile();

                const delayMins = Math.floor(Math.random() * (config.COOLDOWN_MAX_MINS - config.COOLDOWN_MIN_MINS + 1)) + config.COOLDOWN_MIN_MINS;
                this.cooldownUntil = Date.now() + delayMins * 60 * 1000;
                console.log(`⏱️ Post-trade cooldown: ${delayMins} mins. (Profile: ${this.currentProfile})`);

                console.log(`✅ [Watcher] Exit filled: ${filledSize} ${this.symbol} @ ${this.pendingExit.order.price}`);
                await this.executor.notifyExitFilled(
                    this.symbol,
                    this.pendingExit.positionSide,
                    filledSize,
                    this.pendingExit.order.price,
                    this.pendingExit.pnl,
                    { sessionPnl: this.sessionCurrentPnl, sessionVolume: this.sessionVolume, reasoning: this._pendingEntrySignalMeta?.reasoning ?? '', fallback: this._pendingEntrySignalMeta?.fallback ?? false }
                );

                // Log trade record (fire-and-forget)
                const exitTime = new Date().toISOString();
                const entryTimeMs = this._pendingEntrySignalMeta?.entryTime ?? this.entryFilledAt ?? Date.now();
                const entryPrice = this._pendingEntrySignalMeta?.entryPrice ?? 0;
                const positionValue = Math.abs(filledSize) * entryPrice;
                const feePaid = positionValue * config.FEE_RATE_MAKER * 2;
                const pnlNet = this.pendingExit.pnl;
                const grossPnl = pnlNet + feePaid;
                const tradeRecord: TradeRecord = {
                    id: crypto.randomUUID(),
                    timestamp: exitTime,
                    symbol: this.symbol,
                    direction: this.pendingExit.positionSide,
                    confidence: this._pendingEntrySignalMeta?.confidence ?? 0,
                    reasoning: this._pendingEntrySignalMeta?.reasoning ?? '',
                    fallback: this._pendingEntrySignalMeta?.fallback ?? false,
                    entryPrice,
                    exitPrice: this.pendingExit.order.price,
                    pnl: pnlNet,
                    sessionPnl: this.sessionCurrentPnl,
                    // New enriched fields
                    mode: config.MODE as 'farm' | 'trade',
                    entryTime: new Date(entryTimeMs).toISOString(),
                    exitTime,
                    holdingTimeSecs: (Date.now() - entryTimeMs) / 1000,
                    exitTrigger: this._pendingExitTrigger ?? undefined,
                    feePaid,
                    grossPnl,
                    wonBeforeFee: grossPnl > 0 && pnlNet <= 0,
                    ...this._pendingEntrySignalMeta?.signalSnapshot,
                };
                this.tradeLogger.log(tradeRecord);
                sharedState.sessionPnl = this.sessionCurrentPnl;
                sharedState.sessionVolume = this.sessionVolume;
                sharedState.updatedAt = new Date().toISOString();
                const now = new Date().toISOString();
                sharedState.pnlHistory.push({ time: now, value: this.sessionCurrentPnl });
                sharedState.volumeHistory.push({ time: now, value: this.sessionVolume });
                saveState();
                logEvent('ORDER_FILLED', `Exit filled: ${this.pendingExit.positionSide.toUpperCase()} ${tradeRecord.exitPrice} | PnL: ${this.pendingExit.pnl.toFixed(4)}`);
                this._pendingEntrySignalMeta = null;
                this._pendingExitTrigger = null;

                this.positionManager.onPositionClosed();
                this.botState = 'IDLE';
                this.pendingExit = null;
                this.entryFilledAt = null;
                this.farmHoldUntil = null;
            } else {
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
                } else {
                    console.error(`[Watcher] Failed to re-place exit order. Will retry next tick.`);
                }
            }
            return;
        }

        // 4. IN_POSITION: check exit conditions
        if (this.botState === 'IN_POSITION' && (!position || Math.abs(position.size) === 0)) {
            // Position closed externally
            console.log(`[Watcher] Position closed externally. Syncing state to IDLE.`);
            await this.telegram.sendMessage(
                `ℹ️ *Position closed externally*\n• Symbol: \`${this.symbol}\`\n• Detected on tick.`
            );
            this.positionManager.onPositionClosed();
            const delayMins = Math.floor(Math.random() * (config.COOLDOWN_MAX_MINS - config.COOLDOWN_MIN_MINS + 1)) + config.COOLDOWN_MIN_MINS;
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
            } else if (config.MODE === 'farm') {
                // Farm mode: TP when profitable after fees
                const positionValue = Math.abs(position.size) * position.entryPrice;
                const feeRoundTrip = positionValue * config.FEE_RATE_MAKER * 2;
                const minProfitTarget = Math.max(config.FARM_TP_USD, feeRoundTrip * 1.5);

                if (pnl >= minProfitTarget) {
                    shouldExit = true;
                    exitTrigger = `FARM TP (${pnl.toFixed(2)} >= ${minProfitTarget.toFixed(2)})`;
                } else {
                    const holdDone = !this.farmHoldUntil || Date.now() >= this.farmHoldUntil;
                    if (!holdDone) {
                        const remainSecs = Math.floor((this.farmHoldUntil! - Date.now()) / 1000);
                        // Early exit: held >= FARM_EARLY_EXIT_SECS and PnL >= FARM_EARLY_EXIT_PNL
                        if (duration >= config.FARM_EARLY_EXIT_SECS && pnl >= config.FARM_EARLY_EXIT_PNL) {
                            shouldExit = true;
                            exitTrigger = `FARM EARLY PROFIT (${pnl.toFixed(2)} after ${duration}s)`;
                        } else {
                            console.log(`🚜 [FARM] Holding... ${remainSecs}s remaining | PnL: ${pnl.toFixed(2)}`);
                        }
                    } else {
                        // Hold time expired — chờ thêm FARM_EXTRA_WAIT_SECS nếu đang có lời
                        const isLong = position.side === 'long';
                        const priceDiff = markPrice - position.entryPrice;
                        const movingTowardProfit = isLong ? priceDiff > 0 : priceDiff < 0;
                        const maxExtraWaitMs = config.FARM_EXTRA_WAIT_SECS * 1000;
                        const extraWaitExpired = Date.now() > (this.farmHoldUntil! + maxExtraWaitMs);

                        if (pnl > 0 && movingTowardProfit && !extraWaitExpired) {
                            console.log(`🚜 [FARM] Hold expired but profitable (PnL: ${pnl.toFixed(2)}, moving toward profit). Waiting up to ${config.FARM_EXTRA_WAIT_SECS}s more...`);
                        } else {
                            shouldExit = true;
                            exitTrigger = `FARM TIME EXIT (PnL: ${pnl.toFixed(2)})`;
                        }
                    }
                }
            } else {
                // Trade mode: pure TP/SL only — RiskManager handles everything above
                // No time-based exit — let the trade run until TP or SL is hit
                const duration = this.positionManager.getDurationSeconds();
                console.log(`📈 [TRADE] Holding for TP/SL... | PnL: ${pnl.toFixed(4)} | Duration: ${duration}s`);
            }

            if (shouldExit) {
                console.log(`🚨 EXIT TRIGGER: ${exitTrigger}`);

                // Map raw exitTrigger string to the typed union
                let mappedTrigger: TradeRecord['exitTrigger'];
                if (exitTrigger.startsWith('SL/TP')) mappedTrigger = 'SL';
                else if (exitTrigger.startsWith('FARM TP')) mappedTrigger = 'FARM_TP';
                else if (exitTrigger.startsWith('FARM TIME EXIT')) mappedTrigger = 'FARM_TIME';
                else if (exitTrigger.startsWith('FARM EARLY PROFIT')) mappedTrigger = 'FARM_EARLY_PROFIT';
                else mappedTrigger = 'FORCE';
                this._pendingExitTrigger = mappedTrigger;

                const order = await this.executor.placeExitOrder(this.symbol, position);
                if (order) {
                    this.botState = 'PENDING_EXIT';
                    this.pendingExit = {
                        order,
                        positionSide: position.side as 'long' | 'short',
                        pnl,
                        forceClose: false,
                        placedAt: Date.now()
                    };
                }
            } else {
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

            // Hour blocking (farm mode) — skip entry during configured UTC hours
            if (config.MODE === 'farm' && (config.FARM_BLOCKED_HOURS as number[]).length > 0) {
                const currentHourUtc = new Date().getUTCHours();
                if ((config.FARM_BLOCKED_HOURS as number[]).includes(currentHourUtc)) {
                    console.log(`⏸️ [FARM] Hour ${currentHourUtc}:00 UTC is blocked. Skipping entry.`);
                    return;
                }
            }

            // Guard: cancel any stale open orders before placing a new one
            const openOrders = await this.adapter.get_open_orders(this.symbol);
            if (openOrders.length > 0) {
                console.log(`[Watcher] Found ${openOrders.length} stale open order(s). Cancelling before placing new entry...`);
                await this.adapter.cancel_all_orders(this.symbol);
                return; // Wait for next tick to confirm cancellation
            }

            this.positionManager.onPositionClosed();

            const signal = await this.signalEngine.getSignal(this.symbol);
            let bias = 0;
            let finalDirection: 'long' | 'short' | 'skip' = 'skip';

            if (config.MODE === 'farm') {
                // Farm mode: use LLM/signal direction directly, not just score threshold
                // Only skip if signal is genuinely neutral (score very close to 0.5)
                const signalDir = signal.direction; // from LLM or momentum fallback
                const scoreStrong = Math.abs(signal.score - 0.5) > config.FARM_SCORE_EDGE;

                if (signalDir !== 'skip' && scoreStrong) {
                    finalDirection = signalDir;
                } else if (signalDir === 'skip' || !scoreStrong) {
                    // Weak signal — use score as tiebreaker but require minimum confidence
                    if (signal.confidence >= config.FARM_MIN_CONFIDENCE) {
                        finalDirection = signal.score >= 0.5 ? 'long' : 'short';
                    } else {
                        finalDirection = 'skip';
                    }
                }
                console.log(`🚜 [FARM] Score: ${signal.score.toFixed(2)} Dir: ${signalDir} Conf: ${signal.confidence.toFixed(2)} → ${finalDirection.toUpperCase()}`);
            } else {
                // Trade mode: strict filtering
                if (this.lastTradeContext) {
                    const { side: lastSide, exitPrice, pnl } = this.lastTradeContext;
                    const isLoss = pnl < 0;
                    if (lastSide === 'short') {
                        if (isLoss && markPrice > exitPrice) bias -= 0.1;
                        else if (!isLoss && markPrice < exitPrice) bias += 0.1;
                    } else if (lastSide === 'long') {
                        if (isLoss && markPrice < exitPrice) bias += 0.1;
                        else if (!isLoss && markPrice > exitPrice) bias -= 0.1;
                    }
                }

                let final_score = signal.base_score + bias;
                if (signal.regime === 'TREND_UP' && final_score < 0) final_score *= 0.5;
                if (signal.regime === 'TREND_DOWN' && final_score > 0) final_score *= 0.5;

                const threshold = 0.65;
                if (final_score > threshold) finalDirection = 'long';
                else if (final_score < -threshold) finalDirection = 'short';

                console.log(`🧠 [TRADE] Base: ${signal.base_score.toFixed(2)} | Bias: ${bias.toFixed(2)} | Regime: ${signal.regime}`);
                console.log(`   => Final Score: ${final_score.toFixed(2)} | Direction: ${finalDirection.toUpperCase()}`);
            }

            if (finalDirection !== 'skip') {
                // Confidence filter — trade mode only
                if (config.MODE !== 'farm' && signal.confidence < config.MIN_CONFIDENCE) {
                    console.log(`😴 Signal too weak (confidence: ${signal.confidence.toFixed(2)} < ${config.MIN_CONFIDENCE}). Skipping.`);
                    return;
                }

                // Signal confirmation:
                // - Trade mode: require same direction on 2 consecutive ticks (within 60s)
                // - Farm mode: enter immediately on first valid signal (no confirmation delay)
                if (config.MODE !== 'farm') {
                    const now = Date.now();
                    const prevSig = this._lastSignal;
                    this._lastSignal = { direction: finalDirection, score: signal.score, ts: now };

                    if (!prevSig || prevSig.direction !== finalDirection || (now - prevSig.ts) > 60000) {
                        console.log(`[Watcher] Signal ${finalDirection.toUpperCase()} — waiting for confirmation on next tick...`);
                        return;
                    }
                    this._lastSignal = null;
                } else {
                    // Farm: clear any stale last signal, enter immediately
                    this._lastSignal = null;
                }

                if (balance < 15) {
                    console.log(`🚨 FATAL: Insufficient balance (${balance.toFixed(2)}). Stopping bot!`);
                    await this.telegram.sendMessage(
                        `🚨 *CRITICAL STOP*\nBalance below $15 (Current: \`${balance.toFixed(2)}\`). Shutting down.`
                    );
                    process.exit(1);
                }

                // Farm mode: pure random between min and max (no confidence scaling — farm confidence is naturally lower)
                // Trade mode: scale with confidence so stronger signals get larger size
                let size: number;
                let confidenceScale = 1;
                if (config.MODE === 'farm') {
                    size = config.ORDER_SIZE_MIN + Math.random() * (config.ORDER_SIZE_MAX - config.ORDER_SIZE_MIN);
                } else {
                    confidenceScale = Math.min(signal.confidence / config.MIN_CONFIDENCE, 1.5);
                    const baseSize = config.ORDER_SIZE_MIN + Math.random() * (config.ORDER_SIZE_MAX - config.ORDER_SIZE_MIN);
                    size = Math.max(config.ORDER_SIZE_MIN, Math.min(baseSize * confidenceScale, config.ORDER_SIZE_MAX * 1.5));
                }
                console.log(`📐 Order size: ${size.toFixed(5)} (confidence scale: ${confidenceScale.toFixed(2)}x)`);
                const order = await this.executor.placeEntryOrder(this.symbol, finalDirection, size);

                if (order) {
                    // Invalidate signal cache so next IDLE tick after this trade gets a fresh signal
                    this.signalEngine.invalidateCache();
                    logEvent('ORDER_PLACED', `Order placed: ${finalDirection.toUpperCase()} ${size.toFixed(3)} @ ${order.price}`);
                    this.botState = 'PENDING_ENTRY';
                    this._pendingEntrySignalMeta = {
                        reasoning: signal.reasoning,
                        confidence: signal.confidence,
                        fallback: signal.fallback,
                        entryPrice: 0,
                        signalSnapshot: {
                            regime: signal.regime,
                            momentumScore: signal.score,
                            ema9: (signal as any).ema9,
                            ema21: (signal as any).ema21,
                            rsi: (signal as any).rsi,
                            momentum3candles: (signal as any).momentum3candles,
                            volSpike: (signal as any).volSpike,
                            emaCrossUp: (signal as any).emaCrossUp,
                            emaCrossDown: (signal as any).emaCrossDown,
                            imbalance: signal.imbalance,
                            tradePressure: signal.tradePressure,
                            lsRatio: (signal as any).lsRatio,
                            llmDirection: signal.direction,
                            llmConfidence: signal.confidence,
                            llmMatchesMomentum: signal.direction === (signal.score > 0.5 ? 'long' : 'short'),
                        },
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
                        placedAt: Date.now(),
                        replaceCount: 0
                    };
                }
            } else {
                console.log(`😴 Market neutral. Skipping trade...`);
                this._lastSignal = null; // Reset confirmation on skip
            }
        }
    }

    // Stored separately so it survives pendingEntry being cleared at fill
    private _pendingEntrySignalMeta: {
        reasoning: string; confidence: number; fallback: boolean; entryPrice: number;
        signalSnapshot?: import('../ai/TradeLogger.js').SignalSnapshot;
        entryTime?: number; // Date.now() at fill
    } | null = null;

    private _pendingExitTrigger: TradeRecord['exitTrigger'] | null = null;
    private _lastSignal: { direction: 'long' | 'short'; score: number; ts: number } | null = null;

    private updateProfile() {
        let winStreak = 0; let lossStreak = 0;
        for (let i = this.recentPnLs.length - 1; i >= 0; i--) {
            if (this.recentPnLs[i] > 0 && lossStreak === 0) winStreak++;
            else if (this.recentPnLs[i] < 0 && winStreak === 0) lossStreak++;
            else break;
        }
        if (winStreak >= 3) this.currentProfile = Math.random() > 0.5 ? 'RUNNER' : 'DEGEN';
        else if (lossStreak >= 3) this.currentProfile = Math.random() > 0.5 ? 'SCALP' : 'DEGEN';
        else this.currentProfile = 'NORMAL';
    }

    async forceClosePosition(): Promise<boolean> {
        const position = await this.adapter.get_position(this.symbol);
        if (!position || position.size === 0) {
            console.log(`⚠️ [Watcher] Force close failed: No active position found.`);
            return false;
        }

        console.log(`🛑 [Watcher] Manual force close requested.`);
        const order = await this.executor.placeExitOrder(this.symbol, position, true /* IOC */);
        if (!order) return false;

        this._pendingExitTrigger = 'FORCE';
        this.botState = 'PENDING_EXIT';
        this.pendingExit = {
            order,
            positionSide: position.side as 'long' | 'short',
            pnl: position.unrealizedPnl,
            forceClose: true,
            placedAt: Date.now()
        };
        this.cooldownUntil = Date.now() + 60000;
        return true;
    }

    async getDetailedStatus(): Promise<{ text: string, hasPosition: boolean }> {
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
        } else {
            statusText += `💤 No active position for ${this.symbol}.\n`;
            statusText += `🔍 Searching for signals...`;
            return { text: statusText, hasPosition: false };
        }
    }

    stop() {
        this.isRunning = false;
        sharedState.botStatus = 'STOPPED';
        logEvent('INFO', 'Bot stopped');
    }

    getCooldownInfo(): number | null {
        if (this.cooldownUntil === null || Date.now() >= this.cooldownUntil) return null;
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
        this._pendingExitTrigger = null;
    }
}
