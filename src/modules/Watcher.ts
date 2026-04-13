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
import { weightStore } from '../ai/FeedbackLoop/WeightStore.js';
import { componentPerformanceTracker } from '../ai/FeedbackLoop/ComponentPerformanceTracker.js';
import { PositionSizer } from './PositionSizer.js';
import { getRegimeStrategyConfig, Regime } from '../ai/RegimeDetector.js';
import { ChopDetector, SignalHistoryEntry } from '../ai/ChopDetector.js';
import { FakeBreakoutFilter } from '../ai/FakeBreakoutFilter.js';
import { computeAdaptiveCooldown } from '../ai/AdaptiveCooldown.js';
import { FillTracker } from './FillTracker.js';
import { ExecutionEdge } from './ExecutionEdge.js';
import { MarketMaker, MMEntryBias } from './MarketMaker.js';

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
    private positionSizer: PositionSizer;
    private symbol: string;
    private isRunning: boolean = false;
    private cooldownUntil: number | null = null;
    private lastTradeContext: { side: 'long' | 'short', exitPrice: number, pnl: number } | null = null;
    private sessionStartBalance: number | null = null;
    private sessionCurrentPnl: number = 0;
    private sessionVolume: number = 0;
    private fillTracker = new FillTracker();

    // Market Maker
    private readonly marketMaker = new MarketMaker();
    private _pendingDynamicTP: number | null = null;
    private _pendingEntrySpreadBps: number | null = null;
    private _pendingMMBias: MMEntryBias | null = null;

    // State machine
    private botState: BotState = 'IDLE';
    private pendingEntry: PendingEntryState | null = null;
    private pendingExit: PendingExitState | null = null;
    private entryFilledAt: number | null = null;
    private farmHoldUntil: number | null = null;

    // Memory and Chaos state
    private recentPnLs: number[] = [];
    private currentProfile: 'SCALP' | 'NORMAL' | 'RUNNER' | 'DEGEN' = 'NORMAL';

    // Anti-chop filter state
    private _signalHistory: SignalHistoryEntry[] = [];
    private _lastChopScore: number = 0;
    private readonly chopDetector = new ChopDetector();
    private readonly fakeBreakoutFilter = new FakeBreakoutFilter();

    constructor(
        private adapter: ExchangeAdapter,
        symbol: string,
        private telegram: TelegramManager,
        private sessionManager: SessionManager
    ) {
        this.symbol = symbol;
        this.riskManager = new RiskManager();
        this.positionManager = new PositionManager();
        const executionEdge = new ExecutionEdge(adapter, this.fillTracker);
        this.executor = new Executor(adapter, telegram, executionEdge);
        this.positionSizer = new PositionSizer();
        const tradeLogBackend = (process.env.TRADE_LOG_BACKEND ?? 'json') as 'json' | 'sqlite';
        const tradeLogPath = process.env.TRADE_LOG_PATH ?? './trades.json';
        this.tradeLogger = new TradeLogger(tradeLogBackend, tradeLogPath);

        // Task 6.1: load persisted weights at startup
        weightStore.loadFromDisk();

        // Task 6.2: wire tradeLogger.onTradeLogged to componentPerformanceTracker
        const _existingOnTradeLogged = this.tradeLogger.onTradeLogged;
        this.tradeLogger.onTradeLogged = () => {
            _existingOnTradeLogged?.();
            componentPerformanceTracker.onTradeLogged();
        };

        // Task 6.3: pass tradeLogger to AISignalEngine
        this.signalEngine = new AISignalEngine(adapter, this.tradeLogger);
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

                const fillMs = Date.now() - this.pendingEntry.placedAt;
                this.fillTracker.recordFill('entry', fillMs);

                if (config.MODE === 'farm') {
                    console.log(`🚜 [FARM] Hold until: ${this.farmHoldUntil ? new Date(this.farmHoldUntil).toLocaleTimeString() : 'N/A'}`);
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
                this.fillTracker.recordCancel('entry');

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

                    const fillMs = Date.now() - this.pendingEntry.placedAt;
                    this.fillTracker.recordFill('entry', fillMs);

                    if (config.MODE === 'farm') {
                        // farmHoldUntil already set in IDLE block with regime multiplier
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

                const exitFillMs = Date.now() - this.pendingExit.placedAt;
                this.fillTracker.recordFill('exit', exitFillMs);

                this.lastTradeContext = {
                    side: this.pendingExit.positionSide,
                    exitPrice: this.pendingExit.order.price,
                    pnl: this.pendingExit.pnl
                };

                // Task 7.3: Record trade in MarketMaker for inventory tracking
                if (config.MODE === 'farm' && config.MM_ENABLED) {
                  const volumeUsd = filledSize * this.pendingExit.order.price;
                  this.marketMaker.recordTrade(this.pendingExit.positionSide, volumeUsd);
                }

                this.recentPnLs.push(this.pendingExit.pnl);
                if (this.recentPnLs.length > 5) this.recentPnLs.shift();
                this.updateProfile();

                const cooldownResult = computeAdaptiveCooldown({
                  recentPnLs: this.recentPnLs,
                  lastChopScore: this._lastChopScore,
                });
                this.cooldownUntil = Date.now() + cooldownResult.cooldownMs;
                console.log(
                  `⏱️ Adaptive cooldown: ${(cooldownResult.cooldownMs / 60000).toFixed(1)} mins` +
                  ` (base: ${cooldownResult.baseMins.toFixed(1)}, streak×${cooldownResult.streakMult.toFixed(2)}, chop×${cooldownResult.chopMult.toFixed(2)})` +
                  ` | Profile: ${this.currentProfile}`
                );

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
                    sizingConfMult: this._pendingSizingResult?.confidenceMultiplier,
                    sizingPerfMult: this._pendingSizingResult?.performanceMultiplier,
                    sizingCombinedMult: this._pendingSizingResult?.combinedMultiplier,
                    sizingCappedBy: this._pendingSizingResult?.cappedBy,
                    // MM metadata (Task 8.2)
                    mmPingPongBias: (config.MM_ENABLED && this._pendingMMBias) ? this._pendingMMBias.pingPongBias : undefined,
                    mmInventoryBias: (config.MM_ENABLED && this._pendingMMBias) ? this._pendingMMBias.inventoryBias : undefined,
                    mmDynamicTP: (config.MM_ENABLED && this._pendingDynamicTP !== null) ? this._pendingDynamicTP : undefined,
                    mmNetExposure: (config.MM_ENABLED && this._pendingMMBias) ? this._pendingMMBias.netExposureUsd : undefined,
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
                this._pendingSizingResult = null;
                this._pendingMMBias = null;

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
                this.fillTracker.recordCancel('exit');
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
            const cooldownResult = computeAdaptiveCooldown({
              recentPnLs: this.recentPnLs,
              lastChopScore: this._lastChopScore,
            });
            this.cooldownUntil = Date.now() + cooldownResult.cooldownMs;
            console.log(
              `⏱️ Adaptive cooldown (external close): ${(cooldownResult.cooldownMs / 60000).toFixed(1)} mins` +
              ` (base: ${cooldownResult.baseMins.toFixed(1)}, streak×${cooldownResult.streakMult.toFixed(2)}, chop×${cooldownResult.chopMult.toFixed(2)})`
            );
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
                const dynamicTP = (config.MM_ENABLED && this._pendingDynamicTP !== null)
                  ? this._pendingDynamicTP
                  : Math.max(config.FARM_TP_USD, feeRoundTrip * 1.5);
                const exitTriggerLabel = (config.MM_ENABLED && this._pendingDynamicTP !== null) ? 'FARM_MM_TP' : 'FARM_TP';

                if (pnl >= dynamicTP) {
                    shouldExit = true;
                    exitTrigger = `${exitTriggerLabel} (${pnl.toFixed(2)} >= ${dynamicTP.toFixed(2)})`;
                } else {
                    const holdDone = !this.farmHoldUntil || Date.now() >= this.farmHoldUntil;
                    if (!holdDone) {
                        const remainSecs = Math.floor((this.farmHoldUntil! - Date.now()) / 1000);
                        // Early exit: held >= FARM_EARLY_EXIT_SECS and PnL >= FARM_EARLY_EXIT_PNL
                        if (duration >= config.FARM_EARLY_EXIT_SECS && pnl >= config.FARM_EARLY_EXIT_PNL) {
                            const entryRegime = this._pendingEntrySignalMeta?.signalSnapshot?.regime;
                            const exitRegimeConfig = entryRegime ? getRegimeStrategyConfig(entryRegime as Regime) : null;
                            if (exitRegimeConfig?.suppressEarlyExit) {
                                console.log(`🚜 [REGIME] Suppressing early exit in ${entryRegime} — letting trend run`);
                            } else {
                                shouldExit = true;
                                exitTrigger = `FARM EARLY PROFIT (${pnl.toFixed(2)} after ${duration}s)`;
                            }
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
                else if (exitTrigger.startsWith('FARM_MM_TP')) mappedTrigger = 'FARM_MM_TP';
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

            if (config.MODE === 'farm') {
                // ── FARM MODE: Maximum Volume Execution ──────────────────────────────
                // Goal: always execute, never skip. Signal = direction hint only.
                // No chop check, no confidence gate, no fake breakout filter.
                // If signal says skip → use alternating direction (ping-pong).

                // Use cached signal (no LLM in farm mode — use momentum fallback only)
                const signal = await this.signalEngine.getSignal(this.symbol);

                // MM bias (inventory control only — no hard block in pure farm mode)
                let mmBias = null;
                if (config.MM_ENABLED) {
                    mmBias = this.marketMaker.computeEntryBias(
                        this.lastTradeContext,
                        this.marketMaker.getState()
                    );
                    this._pendingMMBias = mmBias;
                    if (mmBias.blocked) {
                        // Inventory too one-sided — still enter but flip direction
                        console.log(`🔄 [MM] Inventory rebalance: ${mmBias.blockReason} | net: ${mmBias.netExposureUsd.toFixed(0)} USD → forcing opposite side`);
                        // Don't return — use forced direction below
                    } else {
                        console.log(
                            `🔄 [MM] pingPong: ${mmBias.pingPongBias > 0 ? '+' : ''}${mmBias.pingPongBias.toFixed(2)}` +
                            ` | inventory: ${mmBias.inventoryBias > 0 ? '+' : ''}${mmBias.inventoryBias.toFixed(2)}` +
                            ` | net: ${mmBias.netExposureUsd.toFixed(0)} USD`
                        );
                    }
                }

                // Determine direction — ALWAYS produce long or short, never skip
                let finalDirection: 'long' | 'short';

                if (mmBias?.blocked) {
                    // Inventory hard block → force opposite of last trade to rebalance
                    finalDirection = (this.lastTradeContext?.side === 'long') ? 'short' : 'long';
                    console.log(`🚜 [FARM] Inventory rebalance → ${finalDirection.toUpperCase()}`);
                } else {
                    // Apply MM bias to score
                    const adjustedScore = mmBias && !mmBias.blocked
                        ? signal.score + mmBias.pingPongBias + mmBias.inventoryBias
                        : signal.score;

                    if (signal.direction !== 'skip') {
                        // Signal has a direction — use it (adjusted by MM bias)
                        // If MM bias strongly opposes signal, let adjusted score decide
                        const mmStronglyOpposes = mmBias && Math.abs(mmBias.pingPongBias + mmBias.inventoryBias) >= 0.1;
                        if (mmStronglyOpposes) {
                            finalDirection = adjustedScore >= 0.5 ? 'long' : 'short';
                        } else {
                            finalDirection = signal.direction;
                        }
                    } else {
                        // Signal says skip → use adjusted score or alternate
                        if (Math.abs(adjustedScore - 0.5) > 0.02) {
                            finalDirection = adjustedScore >= 0.5 ? 'long' : 'short';
                        } else {
                            // Truly neutral → alternate from last trade (ping-pong)
                            finalDirection = (this.lastTradeContext?.side === 'long') ? 'short' : 'long';
                        }
                    }
                    console.log(`🚜 [FARM] Score: ${signal.score.toFixed(2)} AdjScore: ${adjustedScore.toFixed(2)} Dir: ${signal.direction} → ${finalDirection.toUpperCase()}`);
                }

                // Size: use confidence to scale (not to gate)
                const sizingResult = this.positionSizer.computeSize({
                    confidence: signal.confidence,
                    recentPnLs: this.recentPnLs,
                    sessionPnl: this.sessionCurrentPnl,
                    balance,
                    mode: 'farm',
                    profile: this.currentProfile,
                    volatilityFactor: 1.0, // no regime penalty in pure farm mode
                });
                this._pendingSizingResult = sizingResult;
                let size = sizingResult.size;
                const maxSizeFromBalance = (balance * config.SIZING_MAX_BALANCE_PCT) / markPrice;
                if (size > maxSizeFromBalance) size = Math.max(config.ORDER_SIZE_MIN, maxSizeFromBalance);

                console.log(`📐 [FARM] Size: ${size.toFixed(5)} BTC | conf: ${signal.confidence.toFixed(2)}`);

                // Hold time: fixed range, no regime multiplier
                const holdSecs = Math.floor(Math.random() * (config.FARM_MAX_HOLD_SECS - config.FARM_MIN_HOLD_SECS + 1)) + config.FARM_MIN_HOLD_SECS;
                this.farmHoldUntil = Date.now() + holdSecs * 1000;

                // SL: base farm SL, no regime adjustment
                this.riskManager.setSlPercent(config.FARM_SL_PERCENT);

                // Dynamic TP from spread
                if (config.MM_ENABLED) {
                    const spreadBps = this._pendingEntrySpreadBps ?? 2;
                    this._pendingDynamicTP = this.marketMaker.computeDynamicTP(markPrice, spreadBps);
                    console.log(`🎯 [MM] Dynamic TP: ${this._pendingDynamicTP.toFixed(3)} USD (spread: ${spreadBps.toFixed(1)}bps)`);
                } else {
                    this._pendingDynamicTP = null;
                }

                const order = await this.executor.placeEntryOrder(this.symbol, finalDirection, size);
                if (order) {
                    this.signalEngine.invalidateCache();
                    logEvent('ORDER_PLACED', `[FARM] Order placed: ${finalDirection.toUpperCase()} ${size.toFixed(3)} @ ${order.price}`);
                    this.botState = 'PENDING_ENTRY';
                    this._pendingEntrySignalMeta = {
                        reasoning: signal.reasoning,
                        confidence: signal.confidence,
                        fallback: signal.fallback,
                        entryPrice: 0,
                        signalSnapshot: {
                            regime: signal.regime,
                            momentumScore: signal.score,
                            imbalance: signal.imbalance,
                            tradePressure: signal.tradePressure,
                            atrPct: signal.atrPct,
                            bbWidth: signal.bbWidth,
                            volRatio: signal.volRatio,
                        },
                    };
                    this.pendingEntry = {
                        order,
                        direction: finalDirection,
                        meta: { baseScore: signal.base_score, bias: 0, regime: signal.regime, finalScore: signal.score },
                        signalMeta: this._pendingEntrySignalMeta,
                        placedAt: Date.now(),
                        replaceCount: 0,
                    };
                }
                return;
            }

            // ── TRADE MODE: Signal-filtered execution ────────────────────────────
            const signal = await this.signalEngine.getSignal(this.symbol);
            const regimeConfig = getRegimeStrategyConfig(signal.regime as Regime);
            let bias = 0;
            let finalDirection: 'long' | 'short' | 'skip' = 'skip';
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

            if (finalDirection !== 'skip') {
                // Regime strategy config — skipEntry check (trade mode)
                if (regimeConfig.skipEntry) {
                  console.log(`⚠️ [REGIME] Skipping entry: HIGH_VOLATILITY skip enabled`);
                  return;
                }

                // Phase 4a: chop detection (trade mode)
                const chopResult = this.chopDetector.evaluate(
                  { score: signal.score, bbWidth: signal.bbWidth ?? 0 },
                  this._signalHistory
                );
                this._lastChopScore = chopResult.chopScore;

                this._signalHistory.push({ direction: finalDirection, score: signal.score, ts: Date.now() });
                if (this._signalHistory.length > config.CHOP_FLIP_WINDOW) {
                  this._signalHistory.shift();
                }

                if (chopResult.isChoppy) {
                  console.log(
                    `🌀 [CHOP] Skipping entry — chop score: ${chopResult.chopScore.toFixed(2)}` +
                    ` (flip: ${chopResult.flipRate.toFixed(2)}, mom: ${chopResult.momNeutrality.toFixed(2)}, bb: ${chopResult.bbCompression.toFixed(2)})`
                  );
                  return;
                }

                // Phase 4b: fake breakout filter (trade mode)
                {
                  const fakeResult = this.fakeBreakoutFilter.check(
                    {
                      score: signal.score,
                      volRatio: signal.volRatio ?? 1,
                      imbalance: signal.imbalance ?? 0,
                    },
                    finalDirection
                  );
                  if (fakeResult.isFakeBreakout) {
                    console.log(
                      `🚫 [CHOP] Fake breakout detected (${fakeResult.reason})` +
                      ` | volRatio: ${(signal.volRatio ?? 1).toFixed(2)}, imbalance: ${(signal.imbalance ?? 0).toFixed(2)}`
                    );
                    return;
                  }
                }

                // Confidence filter (trade mode)
                if (signal.confidence < config.MIN_CONFIDENCE) {
                    console.log(`😴 Signal too weak (confidence: ${signal.confidence.toFixed(2)} < ${config.MIN_CONFIDENCE}). Skipping.`);
                    return;
                }

                // Signal confirmation: require same direction on 2 consecutive ticks (within 60s)
                {
                    const now = Date.now();
                    const prevSig = this._lastSignal;
                    this._lastSignal = { direction: finalDirection, score: signal.score, ts: now };

                    if (!prevSig || prevSig.direction !== finalDirection || (now - prevSig.ts) > 60000) {
                        console.log(`[Watcher] Signal ${finalDirection.toUpperCase()} — waiting for confirmation on next tick...`);
                        return;
                    }
                    this._lastSignal = null;
                }

                if (balance < 15) {
                    console.log(`🚨 FATAL: Insufficient balance (${balance.toFixed(2)}). Stopping bot!`);
                    await this.telegram.sendMessage(
                        `🚨 *CRITICAL STOP*\nBalance below $15 (Current: \`${balance.toFixed(2)}\`). Shutting down.`
                    );
                    process.exit(1);
                }

                // Sizing (trade mode)
                const sizingResult = this.positionSizer.computeSize({
                  confidence: signal.confidence,
                  recentPnLs: this.recentPnLs,
                  sessionPnl: this.sessionCurrentPnl,
                  balance,
                  mode: 'trade',
                  profile: this.currentProfile,
                  volatilityFactor: regimeConfig.volatilitySizingFactor,
                });
                this._pendingSizingResult = sizingResult;
                let size = sizingResult.size;

                const maxSizeFromBalance = (balance * config.SIZING_MAX_BALANCE_PCT) / markPrice;
                if (size > maxSizeFromBalance) {
                  size = Math.max(config.ORDER_SIZE_MIN, maxSizeFromBalance);
                }

                console.log(`📐 Order size: ${size.toFixed(5)} BTC | confMult: ${sizingResult.confidenceMultiplier.toFixed(2)}x | perfMult: ${sizingResult.performanceMultiplier.toFixed(2)}x | combined: ${sizingResult.combinedMultiplier.toFixed(2)}x | cappedBy: ${sizingResult.cappedBy}`);

                // Hold time with regime multiplier
                const baseHoldSecs = Math.floor(Math.random() * (config.FARM_MAX_HOLD_SECS - config.FARM_MIN_HOLD_SECS + 1)) + config.FARM_MIN_HOLD_SECS;
                const holdSecs = Math.min(
                  config.FARM_MAX_HOLD_SECS * 2,
                  Math.max(config.FARM_MIN_HOLD_SECS, Math.round(baseHoldSecs * regimeConfig.holdMultiplier))
                );
                this.farmHoldUntil = Date.now() + holdSecs * 1000;

                const effectiveSlPercent = config.FARM_SL_PERCENT * regimeConfig.slBufferMultiplier;
                this.riskManager.setSlPercent(effectiveSlPercent);

                console.log(`🎯 [REGIME] ${signal.regime} | ATR: ${(((signal as any).atrPct ?? 0)*100).toFixed(3)}% | BB: ${(((signal as any).bbWidth ?? 0)*100).toFixed(2)}% | Vol: ${((signal as any).volRatio ?? 1).toFixed(2)}x | Hold: ${holdSecs}s | SL: ${(effectiveSlPercent*100).toFixed(2)}%`);

                this._pendingDynamicTP = null;

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
                            atrPct: signal.atrPct,
                            bbWidth: signal.bbWidth,
                            volRatio: signal.volRatio,
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
    private _pendingSizingResult: import('./PositionSizer.js').SizingResult | null = null;

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
        this._pendingSizingResult = null;
        this._signalHistory = [];
        this._lastChopScore = 0;
        this.fillTracker.reset();
        // Task 7.4: Reset MM state
        this.marketMaker.reset();
        this._pendingDynamicTP = null;
        this._pendingEntrySpreadBps = null;
        this._pendingMMBias = null;
    }
}
