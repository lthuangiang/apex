import { config } from '../config.js';
import { ExchangeAdapter } from '../adapters/ExchangeAdapter.js';
import { AISignalEngine } from '../ai/AISignalEngine.js';
import { TradeLogger, TradeRecord } from '../ai/TradeLogger.js';
import { sharedState, logEvent, addTodayVolume, type EventLogEntry } from '../ai/sharedState.js';
import { saveState } from '../ai/StateStore.js';
import type { BotSharedState } from '../bot/BotSharedState.js';
import { logEvent as logBotEvent } from '../bot/BotSharedState.js';
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
import { FillTracker } from './FillTracker.js';
import { ExecutionEdge } from './ExecutionEdge.js';
import { MarketMaker, MMEntryBias } from './MarketMaker.js';
import type { ConfigStoreInterface } from '../config/ConfigStore.js';
import { evaluateFarmEntryFilters, type FilterInput } from './FarmSignalFilters.js';

// ─────────────────────────────────────────────────────────────────────────────
// STATE MACHINE
//
//   IDLE ──place──► PENDING ──filled──► IN_POSITION ──exit trigger──► EXITING
//     ▲                │                     │                            │
//     │             cancel                   │ (external close)           │ filled
//     │                │                     ▼                            ▼
//     └────────────────┘              COOLDOWN ◄──────────────────── COOLDOWN
//
// Transitions:
//   IDLE        → PENDING      : entry order placed (one per tick, then RETURN)
//   PENDING     → IN_POSITION  : position detected on next tick
//   PENDING     → IDLE         : cancel confirmed (one cancel per tick, then RETURN)
//   IN_POSITION → EXITING      : exit trigger fired (cancel stale + place exit, then RETURN)
//   EXITING     → COOLDOWN     : exit fill confirmed
//   COOLDOWN    → IDLE         : cooldown timer expired
//
// STRICT RULES enforced here:
//   1. Per-tick mutex (_tickLock): only one tick executes at a time
//   2. ONE action per tick: place OR cancel OR wait — then RETURN immediately
//   3. No cancel+place in same tick
//   4. No exit+re-entry in same tick
//   5. COOLDOWN blocks ALL signal evaluation and order placement
//   6. Dynamic scheduler: IN_POSITION early-exit → FIXED 5 s; otherwise RANDOM 5–10 s
// ─────────────────────────────────────────────────────────────────────────────

// Five-state machine (replaces old four-state BotState)
type BotState = 'IDLE' | 'PENDING' | 'IN_POSITION' | 'EXITING' | 'COOLDOWN';

interface PendingEntryState {
    order: PendingOrder;
    direction: 'long' | 'short';
    meta: { baseScore: number; bias: number; regime: string; finalScore: number };
    signalMeta: { reasoning: string; confidence: number; fallback: boolean; entryPrice: number };
    placedAt: number;
    replaceCount: number;
    // Tick N placed the order. Tick N+1 may cancel. Tick N+2 may re-evaluate.
    // cancelledOnTick tracks whether we already issued a cancel this cycle.
    cancelledOnTick: boolean;
}

interface PendingExitState {
    order: PendingOrder;
    positionSide: 'long' | 'short';
    pnl: number;
    forceClose: boolean;
    placedAt: number;
}

export class Watcher {
    // ── Core modules ──────────────────────────────────────────────────────────
    private signalEngine: AISignalEngine;
    private riskManager: RiskManager;
    private positionManager: PositionManager;
    private executor: Executor;
    private tradeLogger: TradeLogger;
    private positionSizer: PositionSizer;
    private symbol: string;
    private fillTracker = new FillTracker();
    private readonly marketMaker = new MarketMaker();
    private readonly chopDetector = new ChopDetector();
    private readonly fakeBreakoutFilter = new FakeBreakoutFilter();

    // ── Loop control ──────────────────────────────────────────────────────────
    private isRunning = false;

    // ── STRICT per-tick mutex ─────────────────────────────────────────────────
    // Prevents re-entrant tick execution if an async tick takes longer than the
    // scheduled interval (e.g. slow network). Only one tick body runs at a time.
    private _tickLock = false;

    // ── State machine ─────────────────────────────────────────────────────────
    private botState: BotState = 'IDLE';
    private pendingEntry: PendingEntryState | null = null;
    private pendingExit: PendingExitState | null = null;
    private entryFilledAt: number | null = null;
    private farmHoldUntil: number | null = null;

    // COOLDOWN: set when transitioning out of EXITING or IN_POSITION (external close)
    private cooldownUntil: number | null = null;

    // ── Session / analytics ───────────────────────────────────────────────────
    private sessionStartBalance: number | null = null;
    private sessionCurrentPnl = 0;
    private sessionVolume = 0;
    private lastTradeContext: { side: 'long' | 'short'; exitPrice: number; pnl: number } | null = null;
    private recentPnLs: number[] = [];
    private currentProfile: 'SCALP' | 'NORMAL' | 'RUNNER' | 'DEGEN' = 'NORMAL';

    // ── Anti-chop ─────────────────────────────────────────────────────────────
    private _signalHistory: SignalHistoryEntry[] = [];
    private _lastChopScore = 0;

    // ── Trade metadata (survives pendingEntry being cleared at fill) ──────────
    private _pendingEntrySignalMeta: {
        reasoning: string; confidence: number; fallback: boolean; entryPrice: number;
        signalSnapshot?: import('../ai/TradeLogger.js').SignalSnapshot;
        entryTime?: number;
    } | null = null;
    private _pendingExitTrigger: TradeRecord['exitTrigger'] | null = null;
    private _pendingSizingResult: import('./PositionSizer.js').SizingResult | null = null;
    private _pendingDynamicTP: number | null = null;
    private _pendingEntrySpreadBps: number | null = null;
    private _pendingMMBias: MMEntryBias | null = null;

    // ── Trade-mode signal confirmation ────────────────────────────────────────
    private _lastSignal: { direction: 'long' | 'short'; score: number; ts: number } | null = null;

    // ── Volume reconciliation ─────────────────────────────────────────────────
    private _lastVolumeReconcileAt: number = 0;

    constructor(
        private adapter: ExchangeAdapter,
        symbol: string,
        private telegram: TelegramManager,
        private sessionManager: SessionManager,
        private _botSharedState?: BotSharedState,
        private _configStore?: ConfigStoreInterface,
        tradeLogger?: TradeLogger,
    ) {
        this.symbol = symbol;
        this.riskManager = new RiskManager();
        this.positionManager = new PositionManager();
        const executionEdge = new ExecutionEdge(adapter, this.fillTracker);
        this.executor = new Executor(adapter, telegram, executionEdge);
        this.positionSizer = new PositionSizer();
        if (tradeLogger) {
            this.tradeLogger = tradeLogger;
        } else {
            const tradeLogBackend = (process.env.TRADE_LOG_BACKEND ?? 'json') as 'json' | 'sqlite';
            const tradeLogPath = process.env.TRADE_LOG_PATH ?? './trades.json';
            this.tradeLogger = new TradeLogger(tradeLogBackend, tradeLogPath);
        }

        weightStore.loadFromDisk();

        const _existingOnTradeLogged = this.tradeLogger.onTradeLogged;
        this.tradeLogger.onTradeLogged = () => {
            _existingOnTradeLogged?.();
            componentPerformanceTracker.onTradeLogged();
        };

        this.signalEngine = new AISignalEngine(adapter, this.tradeLogger);
    }

    // ── State helpers: write to botState (multi-bot) or global sharedState ────

    private get _cfg(): typeof config {
        return this._configStore ? this._configStore.getEffective() as unknown as typeof config : config;
    }

    private _logEvent(type: EventLogEntry['type'], message: string): void {
        if (this._botSharedState) {
            logBotEvent(this._botSharedState.botId, this._botSharedState, type, message);
        } else {
            logEvent(type, message);
        }
    }

    private _setState(patch: Partial<typeof sharedState>): void {
        if (this._botSharedState) {
            Object.assign(this._botSharedState, patch);
        } else {
            Object.assign(sharedState, patch);
        }
    }

    private _getState(): typeof sharedState {
        return (this._botSharedState as unknown as typeof sharedState) ?? sharedState;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // VOLUME RECONCILIATION
    //
    // Queries the Decibel trade history API (if adapter supports it) to get the
    // authoritative today's volume. Called on startup and every 5 minutes.
    // Duck-typed: non-Decibel adapters are silently skipped.
    // ─────────────────────────────────────────────────────────────────────────

    async reconcileTodayVolume(): Promise<void> {
        if (typeof (this.adapter as any).getTodayVolumeFromAPI !== 'function') {
            return; // Non-Decibel adapter — no-op
        }
        try {
            const apiVolume: number = await (this.adapter as any).getTodayVolumeFromAPI();
            this._setState({ todayVolume: apiVolume } as any);
            this._lastVolumeReconcileAt = Date.now();
            this._logEvent('INFO', `Today volume reconciled from API: $${apiVolume.toFixed(2)}`);
        } catch (err: any) {
            // API error: keep existing value, do not reset
            console.warn(`[Watcher] reconcileTodayVolume failed — keeping existing value:`, err?.message ?? err);
            this._logEvent('WARN', `Today volume reconciliation failed: ${err?.message ?? err}`);
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // PUBLIC: run loop
    // ─────────────────────────────────────────────────────────────────────────

    async run() {
        if (this.isRunning) return;
        this.isRunning = true;
        this._setState({ botStatus: 'RUNNING' });
        this._logEvent('INFO', 'Bot started');
        console.log(`\n🚀 [Watcher] Monitoring ${this.symbol} loop started.`);

        // Reconcile today's volume from API on startup to recover from restarts
        // or missed fill events. Non-Decibel adapters are silently skipped.
        await this.reconcileTodayVolume();

        while (this.isRunning) {
            // Per-tick mutex: skip if previous tick is still executing
            if (!this._tickLock) {
                this._tickLock = true;
                this._tick().catch(err => {
                    console.error('‼️ [Watcher] Tick error:', err);
                }).finally(() => {
                    this._tickLock = false;
                });
            } else {
                console.log(`[Watcher] Tick skipped — previous tick still running`);
            }

            const delay = this._computeLoopDelay();
            await new Promise(res => setTimeout(res, delay));
        }
    }

    stop() {
        this.isRunning = false;
        this._setState({ botStatus: 'STOPPED' });
        this._logEvent('INFO', 'Bot stopped');
    }

    // ─────────────────────────────────────────────────────────────────────────
    // DYNAMIC TICK SCHEDULER
    //
    // Rule (STRICT):
    //   IN_POSITION + time_in_position > FARM_EARLY_EXIT_SECS → FIXED 5 000 ms
    //   IN_POSITION (normal)                                  → RANDOM 5 000–10 000 ms
    //   EXITING / PENDING                                     → RANDOM 3 000–8 000 ms
    //   COOLDOWN / IDLE                                       → weighted random 2 s–90 s
    // ─────────────────────────────────────────────────────────────────────────

    private _computeLoopDelay(): number {
        if (this.botState === 'IN_POSITION' && this.entryFilledAt !== null) {
            const heldSecs = (Date.now() - this.entryFilledAt) / 1000;
            if (heldSecs > this._cfg.FARM_EARLY_EXIT_SECS) {
                // STRICT: FIXED 5 seconds — no randomness
                return 5_000;
            }
            // Normal IN_POSITION: RANDOM 5–10 s
            return Math.random() * 5_000 + 5_000;
        }

        if (this.botState === 'EXITING' || this.botState === 'PENDING') {
            return Math.random() * 5_000 + 3_000; // 3–8 s
        }

        // COOLDOWN / IDLE — weighted random (shorter waits more likely)
        const roll = Math.random();
        if (roll < 0.5) return Math.random() * 8_000 + 2_000;   // 2–10 s
        if (roll < 0.8) return Math.random() * 20_000 + 10_000; // 10–30 s
        return Math.random() * 60_000 + 30_000;                  // 30–90 s
    }

    // ─────────────────────────────────────────────────────────────────────────
    // CORE TICK — atomic execution unit
    //
    // INVARIANT: exactly ONE action (place | cancel | wait) per invocation.
    // Every branch that performs an action ends with `return`.
    // ─────────────────────────────────────────────────────────────────────────

    private async _tick() {
        const ts = new Date().toLocaleTimeString();
        console.log(`\n--- ${ts} Tick --- [State: ${this.botState}]`);

        // ── 0. COOLDOWN: block everything ─────────────────────────────────────
        if (this.botState === 'COOLDOWN') {
            if (this.cooldownUntil && Date.now() < this.cooldownUntil) {
                const remainSecs = Math.floor((this.cooldownUntil - Date.now()) / 1000);
                console.log(`⏳ Cooldown active — ${remainSecs}s remaining. No action.`);
                return; // ACTION: wait — RETURN
            }
            // Cooldown expired → transition to IDLE
            this.cooldownUntil = null;
            this.botState = 'IDLE';
            console.log(`✅ Cooldown finished. Resuming.`);
            return; // One state transition per tick — RETURN
        }

        // ── 1. Fetch market data ───────────────────────────────────────────────
        const [markPrice, balance] = await Promise.all([
            this.adapter.get_mark_price(this.symbol),
            this.adapter.get_balance(),
        ]);
        const position = await this.adapter.get_position(this.symbol, markPrice);

        this.positionManager.updateTick(markPrice);
        console.log(`Balance: ${balance.toFixed(2)} | Price: ${markPrice.toFixed(2)}`);

        if (this.sessionStartBalance === null) this.sessionStartBalance = balance;
        this.sessionCurrentPnl = balance - this.sessionStartBalance;

        // Sync live session PnL + volume to shared state every tick
        this._setState({
            sessionPnl: this.sessionCurrentPnl,
            sessionVolume: this.sessionVolume,
            updatedAt: new Date().toISOString(),
        });

        // Sync shared state
        if (position && Math.abs(position.size) > 0) {
            this._setState({ openPosition: {
                symbol: this.symbol,
                side: position.side as 'long' | 'short',
                size: Math.abs(position.size),
                entryPrice: position.entryPrice,
                markPrice,
                unrealizedPnl: position.unrealizedPnl,
                durationSecs: this.positionManager.getDurationSeconds(),
                holdRemainingMs: (this.farmHoldUntil && Date.now() < this.farmHoldUntil)
                    ? this.farmHoldUntil - Date.now() : null,
            }});
        } else {
            this._setState({ openPosition: null });
        }

        // ── 1.5. Periodic volume reconciliation (every 5 minutes) ─────────────
        if (Date.now() - this._lastVolumeReconcileAt > 5 * 60 * 1000) {
            // Fire-and-forget: don't block the tick on API call
            this.reconcileTodayVolume().catch(() => {});
        }

        // ── 2. Emergency max-loss stop ─────────────────────────────────────────
        const isMaxLossHit = this.sessionManager.updatePnL(this.sessionCurrentPnl);
        if (isMaxLossHit) {
            console.log(`🛑 [Watcher] Emergency Stop — max loss reached.`);
            await this.telegram.sendMessage(
                `⚠️ *Bot Auto-Stopped*\nMax loss: \`-${this.sessionManager.getState().maxLoss}\`\nPnL: \`${this.sessionCurrentPnl.toFixed(2)}\``
            );

            // Step 1: Cancel all open orders
            try { await this.adapter.cancel_all_orders(this.symbol); } catch {}

            // Step 2: Close open position and wait for confirmation (up to 10s)
            if (position && Math.abs(position.size) > 0) {
                await this.executor.placeExitOrder(this.symbol, position, true /* IOC */);
                await this.telegram.sendMessage(`🔄 *Emergency IOC close sent.*`);

                // Poll until position is gone or timeout
                const deadline = Date.now() + 10_000;
                while (Date.now() < deadline) {
                    await new Promise(r => setTimeout(r, 1000));
                    try {
                        const mp = await this.adapter.get_mark_price(this.symbol);
                        const pos = await this.adapter.get_position(this.symbol, mp);
                        if (!pos || Math.abs(pos.size) === 0) {
                            console.log(`✅ [Watcher] Position confirmed closed after max-loss stop.`);
                            break;
                        }
                    } catch { break; }
                }
            }

            // Step 3: Stop the bot — session is now fully closed
            this.sessionManager.stopSession(); // sync SessionManager state so isRunning = false
            this.stop();
            this._setState({ openPosition: null });
            return; // RETURN
        }

        // ── 3. Route to correct state handler ─────────────────────────────────
        switch (this.botState) {
            case 'PENDING':     return await this._handlePending(position, markPrice);
            case 'IN_POSITION': return await this._handleInPosition(position, markPrice, balance);
            case 'EXITING':     return await this._handleExiting(position, markPrice);
            case 'IDLE':        return await this._handleIdle(position, markPrice, balance);
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // STATE: PENDING
    //
    // Tick N   placed the order → state = PENDING → returned.
    // Tick N+1 checks fill:
    //   • Filled  → IN_POSITION → RETURN
    //   • Timeout → CANCEL only → RETURN  (NO re-place in same tick)
    // Tick N+2 (state back to IDLE) → allowed to evaluate again.
    // ─────────────────────────────────────────────────────────────────────────

    private async _handlePending(position: any, markPrice: number) {
        if (!this.pendingEntry) {
            // Defensive: no pending entry recorded — reset
            console.warn(`[PENDING] No pendingEntry recorded — resetting to IDLE`);
            this._transitionToIdle();
            return; // RETURN
        }

        // Check fill: any position (even partial) → treat as IN_POSITION
        if (position && Math.abs(position.size) > 0) {
            this._onEntryFilled(position);
            return; // ACTION: state transition — RETURN
        }

        // No fill yet — check timeout
        const waitedMs = Date.now() - this.pendingEntry.placedAt;
        const fillTimeout = this._cfg.MODE === 'farm' ? 10_000 : 15_000;

        if (waitedMs < fillTimeout) {
            console.log(`[PENDING] Waiting for fill... (${Math.floor(waitedMs / 1000)}s / ${fillTimeout / 1000}s)`);
            return; // ACTION: wait — RETURN
        }

        // Timeout reached. Check if we already cancelled this tick.
        if (this.pendingEntry.cancelledOnTick) {
            // Cancel was issued last tick. Now confirm and reset.
            const openOrders = await this.adapter.get_open_orders(this.symbol);
            if (openOrders.length > 0) {
                console.log(`[PENDING] Cancel not yet confirmed — waiting one more tick`);
                return; // ACTION: wait — RETURN
            }

            // Re-check position after cancel (race: may have filled during cancel)
            const posAfterCancel = await this.adapter.get_position(this.symbol, markPrice);
            if (posAfterCancel && Math.abs(posAfterCancel.size) > 0) {
                console.log(`[PENDING] Position detected after cancel — treating as filled`);
                this._onEntryFilled(posAfterCancel);
                return; // ACTION: state transition — RETURN
            }

            // Truly cancelled. Decide: retry or give up.
            const maxReplace = this._cfg.MODE === 'farm' ? 3 : 10;
            if (this.pendingEntry.replaceCount >= maxReplace) {
                console.log(`[PENDING] Max replace attempts (${maxReplace}) reached — giving up`);
                this._transitionToIdle();
                return; // RETURN
            }

            // Reset to IDLE so next tick can re-evaluate and place fresh order.
            // STRICT: we do NOT place a new order here — that is the next tick's job.
            console.log(`[PENDING] Cancel confirmed. Resetting to IDLE for re-evaluation next tick.`);
            const savedReplaceCount = this.pendingEntry.replaceCount + 1;
            const savedDirection = this.pendingEntry.direction;
            const savedMeta = this.pendingEntry.meta;
            const savedSignalMeta = this.pendingEntry.signalMeta;
            const savedSize = this.pendingEntry.order.size;
            this._transitionToIdle();
            // Store retry context so IDLE handler can re-use it without re-running signal
            this._retryEntry = { direction: savedDirection, meta: savedMeta, signalMeta: savedSignalMeta, size: savedSize, replaceCount: savedReplaceCount };
            return; // RETURN
        }

        // First timeout: issue cancel — ONE action this tick
        console.log(`[PENDING] Fill timeout (${fillTimeout / 1000}s). Cancelling order.`);
        
        // DEBUG: Check open orders BEFORE cancel to detect race condition
        const openOrdersBeforeCancel = await this.adapter.get_open_orders(this.symbol);
        console.log(`[PENDING] DEBUG: Open orders before cancel: ${openOrdersBeforeCancel.length}`);
        if (openOrdersBeforeCancel.length > 0) {
            console.log(`[PENDING] DEBUG: Order IDs: ${openOrdersBeforeCancel.map(o => o.id).join(', ')}`);
        }
        
        await this.adapter.cancel_all_orders(this.symbol);
        this.fillTracker.recordCancel('entry');
        
        // DEBUG: Check again AFTER cancel
        const openOrdersAfterCancel = await this.adapter.get_open_orders(this.symbol);
        console.log(`[PENDING] DEBUG: Open orders after cancel: ${openOrdersAfterCancel.length}`);
        
        this.pendingEntry.cancelledOnTick = true;
        return; // ACTION: cancel — RETURN (no place in same tick)
    }

    // Retry context set by _handlePending after cancel confirmed
    private _retryEntry: {
        direction: 'long' | 'short';
        meta: PendingEntryState['meta'];
        signalMeta: PendingEntryState['signalMeta'];
        size: number;
        replaceCount: number;
    } | null = null;

    private _onEntryFilled(position: any) {
        const filledSize = Math.abs(position.size);
        this.sessionVolume += filledSize * position.entryPrice;
        addTodayVolume(filledSize * position.entryPrice);
        this.botState = 'IN_POSITION';
        this.entryFilledAt = Date.now();

        if (this._pendingEntrySignalMeta) {
            this._pendingEntrySignalMeta.entryTime = this.entryFilledAt;
            this._pendingEntrySignalMeta.entryPrice = position.entryPrice;
        }
        if (this.pendingEntry) {
            this.pendingEntry.signalMeta.entryPrice = position.entryPrice;
            const fillMs = Date.now() - this.pendingEntry.placedAt;
            this.fillTracker.recordFill('entry', fillMs);
        }

        console.log(`✅ [PENDING→IN_POSITION] Entry filled: ${filledSize} @ ${position.entryPrice}`);
        this._logEvent('ORDER_FILLED', `Entry filled: ${filledSize} @ ${position.entryPrice}`);

        this.executor.notifyEntryFilled(
            this.symbol,
            this.pendingEntry?.direction ?? 'long',
            filledSize,
            position.entryPrice,
            {
                ...(this.pendingEntry?.meta ?? { baseScore: 0, bias: 0, regime: '', finalScore: 0 }),
                sessionPnl: this.sessionCurrentPnl,
                sessionVolume: this.sessionVolume,
                reasoning: this._pendingEntrySignalMeta?.reasoning ?? '',
                fallback: this._pendingEntrySignalMeta?.fallback ?? false,
            }
        ).catch(() => {});

        this.pendingEntry = null;
        this._retryEntry = null;

        if (this._cfg.MODE === 'farm') {
            console.log(`🚜 [FARM] Hold until: ${this.farmHoldUntil ? new Date(this.farmHoldUntil).toLocaleTimeString() : 'N/A'}`);
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // STATE: IN_POSITION
    //
    // Dynamic scheduler enforced here:
    //   time_in_position > FARM_EARLY_EXIT_SECS → _computeLoopDelay returns FIXED 5 s
    //   otherwise                               → RANDOM 5–10 s
    //
    // On exit trigger:
    //   1. Cancel all open orders (ONE action)
    //   2. Transition to EXITING
    //   3. RETURN — exit order placed on NEXT tick by _handleExiting
    //
    // STRICT: no cancel+place in same tick.
    // ─────────────────────────────────────────────────────────────────────────

    private async _handleInPosition(position: any, markPrice: number, balance: number) {
        // External close detection
        if (!position || Math.abs(position.size) === 0) {
            console.log(`[IN_POSITION] Position closed externally — applying cooldown`);
            await this.telegram.sendMessage(
                `ℹ️ *Position closed externally*\n• Symbol: \`${this.symbol}\``
            );
            this.positionManager.onPositionClosed();
            this._transitionToCooldown('random');
            return; // RETURN
        }

        this.positionManager.onPositionOpened(position, this.currentProfile);
        const duration = this.positionManager.getDurationSeconds();
        const pnl = position.unrealizedPnl;

        console.log(`📍 ACTIVE ${position.side.toUpperCase()}: ${position.size} @ ${position.entryPrice.toFixed(2)} | PnL: ${pnl.toFixed(4)} | ${duration}s`);

        // Evaluate exit conditions
        const { shouldExit, exitTrigger } = this._evaluateExitConditions(position, markPrice, pnl, duration);

        if (!shouldExit) {
            const earlyExitMode = duration > this._cfg.FARM_EARLY_EXIT_SECS;
            console.log(`ℹ️ Holding... [${earlyExitMode ? 'EARLY-EXIT mode, 5s fixed' : 'normal, 5–10s random'}]`);
            return; // ACTION: wait — RETURN
        }

        // Exit triggered — cancel all open orders first (ONE action this tick)
        console.log(`🚨 EXIT TRIGGER: ${exitTrigger}`);
        this._logEvent('INFO', `EXIT_TRIGGER: ${exitTrigger}`);

        // Map trigger label to typed union
        let mappedTrigger: TradeRecord['exitTrigger'];
        if (exitTrigger.startsWith('SL/TP'))             mappedTrigger = 'SL';
        else if (exitTrigger.startsWith('FARM_MM_TP'))   mappedTrigger = 'FARM_MM_TP';
        else if (exitTrigger.startsWith('FARM TP'))      mappedTrigger = 'FARM_TP';
        else if (exitTrigger.startsWith('FARM TIME'))    mappedTrigger = 'FARM_TIME';
        else if (exitTrigger.startsWith('FARM EARLY'))   mappedTrigger = 'FARM_EARLY_PROFIT';
        else                                              mappedTrigger = 'FORCE';
        this._pendingExitTrigger = mappedTrigger;

        // Transition to EXITING and cancel — exit order placed next tick
        this.botState = 'EXITING';
        this.pendingExit = null; // will be set by _handleExiting after cancel confirms

        console.log(`[IN_POSITION→EXITING] Cancelling all open orders before exit...`);
        await this.adapter.cancel_all_orders(this.symbol);
        // Store pnl snapshot for exit record
        this._exitPnlSnapshot = pnl;
        return; // ACTION: cancel — RETURN (exit order placed next tick)
    }

    // Snapshot of pnl at exit trigger time (used by _handleExiting)
    private _exitPnlSnapshot: number = 0;

    private _evaluateExitConditions(
        position: any,
        markPrice: number,
        pnl: number,
        duration: number,
    ): { shouldExit: boolean; exitTrigger: string } {
        // Risk manager (SL/TP) — highest priority
        if (this.riskManager.shouldClose(markPrice, position)) {
            return { shouldExit: true, exitTrigger: 'SL/TP (RiskManager)' };
        }

        if (this._cfg.MODE === 'farm') {
            const positionValue = Math.abs(position.size) * position.entryPrice;
            const feeRoundTrip = positionValue * this._cfg.FEE_RATE_MAKER * 2;
            const dynamicTP = (this._cfg.MM_ENABLED && this._pendingDynamicTP !== null)
                ? this._pendingDynamicTP
                : Math.max(this._cfg.FARM_TP_USD, feeRoundTrip * 1.5);
            const tpLabel = (this._cfg.MM_ENABLED && this._pendingDynamicTP !== null) ? 'FARM_MM_TP' : 'FARM TP';

            if (pnl >= dynamicTP) {
                return { shouldExit: true, exitTrigger: `${tpLabel} (${pnl.toFixed(2)} >= ${dynamicTP.toFixed(2)})` };
            }

            const holdDone = !this.farmHoldUntil || Date.now() >= this.farmHoldUntil;

            if (!holdDone) {
                // Early exit: held >= FARM_EARLY_EXIT_SECS AND pnl covers round-trip fee
                if (duration >= this._cfg.FARM_EARLY_EXIT_SECS) {
                    // Dynamic threshold: must cover round-trip fee × multiplier
                    // e.g. 0.002 BTC @ $74,500 → posValue=$149 → fee=$0.036 → threshold=$0.043
                    const positionValue = Math.abs(position.size) * position.entryPrice;
                    const feeRoundTripCost = positionValue * this._cfg.FEE_RATE_MAKER * 2;
                    const minProfitThreshold = Math.max(
                        feeRoundTripCost * this._cfg.FARM_MIN_PROFIT_FEE_MULT,
                        this._cfg.FARM_EARLY_EXIT_PNL, // fallback floor
                    );

                    if (pnl >= minProfitThreshold) {
                        const entryRegime = this._pendingEntrySignalMeta?.signalSnapshot?.regime;
                        const regimeCfg = entryRegime ? getRegimeStrategyConfig(entryRegime as Regime) : null;
                        if (regimeCfg?.suppressEarlyExit) {
                            console.log(`🚜 [REGIME] Suppressing early exit in ${entryRegime}`);
                            return { shouldExit: false, exitTrigger: '' };
                        }
                        console.log(`🚜 [FARM] Early profit exit: pnl=${pnl.toFixed(4)} >= threshold=${minProfitThreshold.toFixed(4)} (fee=${feeRoundTripCost.toFixed(4)} × ${this._cfg.FARM_MIN_PROFIT_FEE_MULT})`);
                        return { shouldExit: true, exitTrigger: `FARM EARLY PROFIT (${pnl.toFixed(2)} >= fee×${this._cfg.FARM_MIN_PROFIT_FEE_MULT} after ${duration}s)` };
                    }
                }
                const remainSecs = Math.floor((this.farmHoldUntil! - Date.now()) / 1000);
                console.log(`🚜 [FARM] Holding... ${remainSecs}s remaining | PnL: ${pnl.toFixed(2)}`);
                return { shouldExit: false, exitTrigger: '' };
            }

            // Hold expired — extra wait if profitable and moving toward profit
            const isLong = position.side === 'long';
            const movingTowardProfit = isLong ? markPrice > position.entryPrice : markPrice < position.entryPrice;
            const extraWaitExpired = Date.now() > (this.farmHoldUntil! + this._cfg.FARM_EXTRA_WAIT_SECS * 1000);

            if (pnl > 0 && movingTowardProfit && !extraWaitExpired) {
                console.log(`🚜 [FARM] Hold expired but profitable — waiting up to ${this._cfg.FARM_EXTRA_WAIT_SECS}s more`);
                return { shouldExit: false, exitTrigger: '' };
            }

            return { shouldExit: true, exitTrigger: `FARM TIME EXIT (PnL: ${pnl.toFixed(2)})` };
        }

        // Trade mode: TP/SL only (RiskManager handles above)
        console.log(`📈 [TRADE] Holding for TP/SL... | PnL: ${pnl.toFixed(4)} | ${duration}s`);
        return { shouldExit: false, exitTrigger: '' };
    }

    // ─────────────────────────────────────────────────────────────────────────
    // STATE: EXITING
    //
    // Entered from IN_POSITION after cancel was issued.
    // Tick N+1 (first EXITING tick):
    //   • Confirm cancel → place exit order → pendingExit set → RETURN
    // Subsequent ticks:
    //   • If position gone → COOLDOWN → RETURN
    //   • If exit order timeout → cancel only → RETURN (re-place next tick)
    //
    // STRICT: cancel and place are NEVER in the same tick.
    // ─────────────────────────────────────────────────────────────────────────

    private async _handleExiting(position: any, markPrice: number) {
        // ── Case A: No exit order placed yet (first EXITING tick after cancel) ──
        if (!this.pendingExit) {
            // Confirm cancel completed
            const openOrders = await this.adapter.get_open_orders(this.symbol);
            if (openOrders.length > 0) {
                console.log(`[EXITING] Cancel not yet confirmed — waiting`);
                return; // ACTION: wait — RETURN
            }

            // Re-verify position still exists
            const posNow = await this.adapter.get_position(this.symbol, markPrice);
            if (!posNow || Math.abs(posNow.size) === 0) {
                console.log(`[EXITING] Position already gone — transitioning to COOLDOWN`);
                this.positionManager.onPositionClosed();
                this._transitionToCooldown('farm');
                return; // RETURN
            }

            // Dust check
            const posValueUsd = Math.abs(posNow.size) * markPrice;
            if (posValueUsd < this._cfg.MIN_POSITION_VALUE_USD) {
                console.log(`[EXITING] Dust position (${posValueUsd.toFixed(2)} USD) — skipping close`);
                this._logEvent('WARN', `Dust position skipped (${posValueUsd.toFixed(2)})`);
                await this.adapter.cancel_all_orders(this.symbol);
                this.positionManager.onPositionClosed();
                this._transitionToCooldown('random');
                return; // RETURN
            }

            // Place exit order — ONE action this tick
            const order = await this.executor.placeExitOrder(this.symbol, posNow, false);
            if (order) {
                this.pendingExit = {
                    order,
                    positionSide: posNow.side as 'long' | 'short',
                    pnl: this._exitPnlSnapshot,
                    forceClose: false,
                    placedAt: Date.now(),
                };
                console.log(`[EXITING] Exit order placed: ${order.orderId} @ ${order.price}`);
            } else {
                console.warn(`[EXITING] placeExitOrder returned null — will retry next tick`);
            }
            return; // ACTION: place — RETURN
        }

        // ── Case B: Exit order placed, check fill ─────────────────────────────
        if (!position || Math.abs(position.size) === 0) {
            // Position gone → exit filled
            await this._onExitFilled();
            return; // ACTION: state transition — RETURN
        }

        // Position still open — check timeout
        const waitedMs = Date.now() - this.pendingExit.placedAt;
        if (waitedMs < 15_000) {
            console.log(`[EXITING] Exit order pending... (${Math.floor(waitedMs / 1000)}s / 15s)`);
            return; // ACTION: wait — RETURN
        }

        // Exit order timed out — cancel only this tick, re-place next tick
        console.log(`[EXITING] Exit order timeout — cancelling (will re-place next tick)`);
        await this.adapter.cancel_all_orders(this.symbol);
        this.fillTracker.recordCancel('exit');
        this.pendingExit = null; // cleared so next tick re-enters Case A
        return; // ACTION: cancel — RETURN (no re-place in same tick)
    }

    private async _onExitFilled() {
        if (!this.pendingExit) return;

        const filledSize = this.pendingExit.order.size;
        const filledVol = filledSize * this.pendingExit.order.price;
        this.sessionVolume += filledVol;
        addTodayVolume(filledVol);

        const exitFillMs = Date.now() - this.pendingExit.placedAt;
        this.fillTracker.recordFill('exit', exitFillMs);

        this.lastTradeContext = {
            side: this.pendingExit.positionSide,
            exitPrice: this.pendingExit.order.price,
            pnl: this.pendingExit.pnl,
        };

        if (this._cfg.MODE === 'farm' && this._cfg.MM_ENABLED) {
            this.marketMaker.recordTrade(this.pendingExit.positionSide, filledSize * this.pendingExit.order.price);
        }

        this.recentPnLs.push(this.pendingExit.pnl);
        if (this.recentPnLs.length > 5) this.recentPnLs.shift();
        this.updateProfile();

        console.log(`✅ [EXITING→COOLDOWN] Exit filled: ${filledSize} @ ${this.pendingExit.order.price} | PnL: ${this.pendingExit.pnl.toFixed(4)}`);

        await this.executor.notifyExitFilled(
            this.symbol,
            this.pendingExit.positionSide,
            filledSize,
            this.pendingExit.order.price,
            this.pendingExit.pnl,
            {
                sessionPnl: this.sessionCurrentPnl,
                sessionVolume: this.sessionVolume,
                reasoning: this._pendingEntrySignalMeta?.reasoning ?? '',
                fallback: this._pendingEntrySignalMeta?.fallback ?? false,
            }
        );

        // Log trade record
        const exitTime = new Date().toISOString();
        const entryTimeMs = this._pendingEntrySignalMeta?.entryTime ?? this.entryFilledAt ?? Date.now();
        const entryPrice = this._pendingEntrySignalMeta?.entryPrice ?? 0;
        const positionValue = Math.abs(filledSize) * entryPrice;
        const feePaid = positionValue * this._cfg.FEE_RATE_MAKER * 2;
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
            mode: this._cfg.MODE as 'farm' | 'trade',
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
            mmPingPongBias: (this._cfg.MM_ENABLED && this._pendingMMBias) ? this._pendingMMBias.pingPongBias : undefined,
            mmInventoryBias: (this._cfg.MM_ENABLED && this._pendingMMBias) ? this._pendingMMBias.inventoryBias : undefined,
            mmDynamicTP: (this._cfg.MM_ENABLED && this._pendingDynamicTP !== null) ? this._pendingDynamicTP : undefined,
            mmNetExposure: (this._cfg.MM_ENABLED && this._pendingMMBias) ? this._pendingMMBias.netExposureUsd : undefined,
            ...this._pendingEntrySignalMeta?.signalSnapshot,
        };

        this.tradeLogger.log(tradeRecord);
        this._logEvent('ORDER_FILLED', `Exit filled: ${this.pendingExit.positionSide.toUpperCase()} @ ${tradeRecord.exitPrice} | PnL: ${pnlNet.toFixed(4)}`);

        const now = new Date().toISOString();
        const state = this._getState();
        state.sessionPnl = this.sessionCurrentPnl;
        state.sessionVolume = this.sessionVolume;
        state.updatedAt = now;
        state.pnlHistory.push({ time: now, value: this.sessionCurrentPnl });
        state.volumeHistory.push({ time: now, value: this.sessionVolume });
        if (!this._botSharedState) saveState();

        // Clear trade metadata
        this._pendingEntrySignalMeta = null;
        this._pendingExitTrigger = null;
        this._pendingSizingResult = null;
        this._pendingMMBias = null;
        this._exitPnlSnapshot = 0;

        this.positionManager.onPositionClosed();

        // STRICT: transition to COOLDOWN immediately — no re-entry possible this tick
        this._transitionToCooldown('farm');
    }

    // ─────────────────────────────────────────────────────────────────────────
    // STATE: IDLE
    //
    // Evaluates signal and places ONE entry order, then transitions to PENDING.
    // If _retryEntry is set (from a cancelled PENDING), re-uses saved context.
    // ─────────────────────────────────────────────────────────────────────────

    private async _handleIdle(position: any, markPrice: number, balance: number) {
        // Sync: position exists but state is IDLE (e.g. after restart)
        if (position && Math.abs(position.size) > 0) {
            // Dust check: if position value is below threshold, treat as no position
            // and cancel any stale orders so we can enter a fresh trade next tick.
            const posValueUsd = Math.abs(position.size) * markPrice;
            if (posValueUsd < this._cfg.MIN_POSITION_VALUE_USD) {
                console.log(`[IDLE] Dust position detected (${posValueUsd.toFixed(2)} USD < ${this._cfg.MIN_POSITION_VALUE_USD} USD) — ignoring, proceeding to new entry`);
                this._logEvent('WARN', `Dust position ignored in IDLE (${posValueUsd.toFixed(2)} USD)`);
                await this.adapter.cancel_all_orders(this.symbol);
                this.positionManager.onPositionClosed();
                // Fall through to signal evaluation below
            } else {
                console.log(`[IDLE] Detected existing position — syncing to IN_POSITION`);
                this.botState = 'IN_POSITION';
                if (this.entryFilledAt === null) {
                    this.entryFilledAt = Date.now();
                    this.positionManager.onPositionOpened(position, this.currentProfile);
                }
                return; // RETURN
            }
        }

        // Hour blocking (farm mode)
        if (this._cfg.MODE === 'farm' && (this._cfg.FARM_BLOCKED_HOURS as number[]).length > 0) {
            const utcHour = new Date().getUTCHours();
            if ((this._cfg.FARM_BLOCKED_HOURS as number[]).includes(utcHour)) {
                console.log(`⏸️ [FARM] Hour ${utcHour}:00 UTC blocked — skipping`);
                return; // ACTION: wait — RETURN
            }
        }

        // Guard: cancel stale open orders — ONE action this tick
        const openOrders = await this.adapter.get_open_orders(this.symbol);
        if (openOrders.length > 0) {
            console.log(`[IDLE] Found ${openOrders.length} stale order(s) — cancelling`);
            await this.adapter.cancel_all_orders(this.symbol);
            return; // ACTION: cancel — RETURN (evaluate next tick)
        }

        this.positionManager.onPositionClosed();

        // ── Retry path (cancelled PENDING → IDLE) ─────────────────────────────
        if (this._retryEntry) {
            const { direction, meta, signalMeta, size, replaceCount } = this._retryEntry;
            this._retryEntry = null;
            console.log(`[IDLE] Retrying entry (attempt ${replaceCount}) → ${direction.toUpperCase()}`);

            // Refresh farmHoldUntil if it has already expired (or was never set).
            // Without this, a retry fill would see holdDone=true and exit immediately.
            if (!this.farmHoldUntil || Date.now() >= this.farmHoldUntil) {
                const holdSecs = Math.floor(Math.random() * (this._cfg.FARM_MAX_HOLD_SECS - this._cfg.FARM_MIN_HOLD_SECS + 1)) + this._cfg.FARM_MIN_HOLD_SECS;
                this.farmHoldUntil = Date.now() + holdSecs * 1000;
                console.log(`[IDLE] Retry: refreshed farmHoldUntil → ${holdSecs}s`);
            }

            const order = await this.executor.placeEntryOrder(this.symbol, direction, size);
            if (order) {
                this.signalEngine.invalidateCache();
                this._logEvent('ORDER_PLACED', `[RETRY] ${direction.toUpperCase()} ${size.toFixed(3)} @ ${order.price}`);
                this.botState = 'PENDING';
                this.pendingEntry = { order, direction, meta, signalMeta, placedAt: Date.now(), replaceCount, cancelledOnTick: false };
            }
            return; // ACTION: place — RETURN
        }

        // ── Fresh signal evaluation ────────────────────────────────────────────
        if (this._cfg.MODE === 'farm') {
            return await this._handleIdleFarm(markPrice, balance);
        } else {
            return await this._handleIdleTrade(markPrice, balance);
        }
    }

    // ── FARM MODE entry ───────────────────────────────────────────────────────

    private async _handleIdleFarm(markPrice: number, balance: number) {
        const signal = await this.signalEngine.getSignal(this.symbol);

        // ── Signal filter pipeline ─────────────────────────────────────────────
        const filterResult = evaluateFarmEntryFilters({
            regime: signal.regime as FilterInput['regime'],
            confidence: signal.confidence,
            momentumScore: signal.score,
            tradePressure: signal.tradePressure,
            fallback: signal.fallback,
            llmMatchesMomentum: (signal as any).llmMatchesMomentum,
            atrPct: signal.atrPct,
            mode: this._cfg.MODE as 'farm' | 'trade',
            FEE_RATE_MAKER: this._cfg.FEE_RATE_MAKER,
            FARM_MIN_CONFIDENCE_PRESSURE_GATE: this._cfg.FARM_MIN_CONFIDENCE_PRESSURE_GATE,
            FARM_MIN_FALLBACK_CONFIDENCE: this._cfg.FARM_MIN_FALLBACK_CONFIDENCE,
            FARM_SIDEWAY_MIN_CONFIDENCE: this._cfg.FARM_SIDEWAY_MIN_CONFIDENCE,
            FARM_TREND_MIN_CONFIDENCE: this._cfg.FARM_TREND_MIN_CONFIDENCE,
            FARM_MIN_HOLD_SECS: this._cfg.FARM_MIN_HOLD_SECS,
            FARM_MAX_HOLD_SECS: this._cfg.FARM_MAX_HOLD_SECS,
        });

        if (!filterResult.pass) {
            console.log(`[SignalFilter] SKIP: ${filterResult.reason}`);
            return; // ACTION: wait — RETURN
        }

        console.log(`[SignalFilter] PASS: regime=${signal.regime}, confidence=${signal.confidence.toFixed(2)}, pressure=${signal.tradePressure.toFixed(2)}, fallback=${signal.fallback}, effectiveConf=${filterResult.effectiveConfidence.toFixed(2)}`);

        let mmBias = null;
        if (this._cfg.MM_ENABLED) {
            mmBias = this.marketMaker.computeEntryBias(this.lastTradeContext, this.marketMaker.getState());
            this._pendingMMBias = mmBias;
            if (mmBias.blocked) {
                console.log(`🔄 [MM] Inventory block: ${mmBias.blockReason}`);
            } else {
                console.log(`🔄 [MM] pingPong: ${mmBias.pingPongBias.toFixed(2)} | inventory: ${mmBias.inventoryBias.toFixed(2)}`);
            }
        }

        let finalDirection: 'long' | 'short';

        if (mmBias?.blocked) {
            finalDirection = (this.lastTradeContext?.side === 'long') ? 'short' : 'long';
            console.log(`🚜 [FARM] Inventory rebalance → ${finalDirection.toUpperCase()}`);
        } else {
            const pricePos = (signal as any).pricePositionInRange as number | undefined;
            const adjustedScore = mmBias
                ? signal.score + mmBias.pingPongBias + mmBias.inventoryBias
                : signal.score;

            if (pricePos !== undefined) {
                if (pricePos > 0.65)      finalDirection = 'short';
                else if (pricePos < 0.35) finalDirection = 'long';
                else if (Math.abs(adjustedScore - 0.5) > 0.05) finalDirection = adjustedScore >= 0.5 ? 'long' : 'short';
                else finalDirection = (this.lastTradeContext?.side === 'long') ? 'short' : 'long';
                console.log(`🚜 [FARM] PricePos: ${(pricePos * 100).toFixed(0)}% AdjScore: ${adjustedScore.toFixed(2)} → ${finalDirection.toUpperCase()}`);
            } else {
                if (signal.direction !== 'skip') {
                    const mmOpposes = mmBias && Math.abs(mmBias.pingPongBias + mmBias.inventoryBias) >= 0.1;
                    finalDirection = mmOpposes ? (adjustedScore >= 0.5 ? 'long' : 'short') : signal.direction;
                } else {
                    finalDirection = Math.abs(adjustedScore - 0.5) > 0.02
                        ? (adjustedScore >= 0.5 ? 'long' : 'short')
                        : (this.lastTradeContext?.side === 'long') ? 'short' : 'long';
                }
                console.log(`🚜 [FARM] Score: ${signal.score.toFixed(2)} → ${finalDirection.toUpperCase()}`);
            }
        }

        const sizingResult = this.positionSizer.computeSize({
            confidence: filterResult.effectiveConfidence,
            recentPnLs: this.recentPnLs,
            sessionPnl: this.sessionCurrentPnl,
            balance,
            mode: 'farm',
            profile: this.currentProfile,
            volatilityFactor: 1.0,
        });
        this._pendingSizingResult = sizingResult;
        let size = sizingResult.size;
        const maxSizeFromBalance = (balance * this._cfg.SIZING_MAX_BALANCE_PCT) / markPrice;
        if (size > maxSizeFromBalance) size = Math.max(this._cfg.ORDER_SIZE_MIN, maxSizeFromBalance);

        const holdSecs = filterResult.dynamicMinHold;
        this.farmHoldUntil = Date.now() + holdSecs * 1000;
        console.log(`[MinHold] dynamicMinHold=${holdSecs}s (feeBreakEven computed, FARM_MIN=${this._cfg.FARM_MIN_HOLD_SECS}s, FARM_MAX=${this._cfg.FARM_MAX_HOLD_SECS}s)`);
        this.riskManager.setSlPercent(this._cfg.FARM_SL_PERCENT);

        if (this._cfg.MM_ENABLED) {
            const spreadBps = this._pendingEntrySpreadBps ?? 2;
            this._pendingDynamicTP = this.marketMaker.computeDynamicTP(markPrice, spreadBps);
            console.log(`🎯 [MM] Dynamic TP: ${this._pendingDynamicTP.toFixed(3)} USD`);
        } else {
            this._pendingDynamicTP = null;
        }

        console.log(`📐 [FARM] Size: ${size.toFixed(5)} BTC | conf: ${signal.confidence.toFixed(2)}`);

        const order = await this.executor.placeEntryOrder(this.symbol, finalDirection, size);
        if (order) {
            this.signalEngine.invalidateCache();
            this._logEvent('ORDER_PLACED', `[FARM] ${finalDirection.toUpperCase()} ${size.toFixed(3)} @ ${order.price}`);
            this.botState = 'PENDING';
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
                    filterResult: filterResult.pass ? 'pass' : filterResult.reason,
                    effectiveConfidence: filterResult.effectiveConfidence,
                    dynamicMinHold: filterResult.dynamicMinHold,
                },
            };
            this.pendingEntry = {
                order,
                direction: finalDirection,
                meta: { baseScore: signal.base_score, bias: 0, regime: signal.regime, finalScore: signal.score },
                signalMeta: this._pendingEntrySignalMeta,
                placedAt: Date.now(),
                replaceCount: 0,
                cancelledOnTick: false,
            };
        }
        return; // ACTION: place — RETURN
    }

    // ── TRADE MODE entry ──────────────────────────────────────────────────────

    private async _handleIdleTrade(markPrice: number, balance: number) {
        const signal = await this.signalEngine.getSignal(this.symbol);
        const regimeConfig = getRegimeStrategyConfig(signal.regime as Regime);

        let bias = 0;
        if (this.lastTradeContext) {
            const { side: lastSide, exitPrice, pnl } = this.lastTradeContext;
            const isLoss = pnl < 0;
            if (lastSide === 'short') {
                if (isLoss && markPrice > exitPrice) bias -= 0.1;
                else if (!isLoss && markPrice < exitPrice) bias += 0.1;
            } else {
                if (isLoss && markPrice < exitPrice) bias += 0.1;
                else if (!isLoss && markPrice > exitPrice) bias -= 0.1;
            }
        }

        let final_score = signal.base_score + bias;
        if (signal.regime === 'TREND_UP' && final_score < 0) final_score *= 0.5;
        if (signal.regime === 'TREND_DOWN' && final_score > 0) final_score *= 0.5;

        const threshold = 0.65;
        let finalDirection: 'long' | 'short' | 'skip' = 'skip';
        if (final_score > threshold) finalDirection = 'long';
        else if (final_score < -threshold) finalDirection = 'short';

        console.log(`🧠 [TRADE] Base: ${signal.base_score.toFixed(2)} | Bias: ${bias.toFixed(2)} | Score: ${final_score.toFixed(2)} | Dir: ${finalDirection.toUpperCase()}`);

        if (finalDirection === 'skip') {
            console.log(`😴 Market neutral — skipping`);
            this._lastSignal = null;
            return; // ACTION: wait — RETURN
        }

        if (regimeConfig.skipEntry) {
            console.log(`⚠️ [REGIME] skipEntry active — skipping`);
            return; // RETURN
        }

        // Chop detection
        const chopResult = this.chopDetector.evaluate({ score: signal.score, bbWidth: signal.bbWidth ?? 0 }, this._signalHistory);
        this._lastChopScore = chopResult.chopScore;
        this._signalHistory.push({ direction: finalDirection, score: signal.score, ts: Date.now() });
        if (this._signalHistory.length > this._cfg.CHOP_FLIP_WINDOW) this._signalHistory.shift();

        if (chopResult.isChoppy) {
            console.log(`🌀 [CHOP] Skipping — chop score: ${chopResult.chopScore.toFixed(2)}`);
            return; // RETURN
        }

        // Fake breakout filter
        const fakeResult = this.fakeBreakoutFilter.check(
            { score: signal.score, volRatio: signal.volRatio ?? 1, imbalance: signal.imbalance ?? 0 },
            finalDirection
        );
        if (fakeResult.isFakeBreakout) {
            console.log(`🚫 [CHOP] Fake breakout: ${fakeResult.reason}`);
            return; // RETURN
        }

        if (signal.confidence < this._cfg.MIN_CONFIDENCE) {
            console.log(`😴 Confidence too low (${signal.confidence.toFixed(2)} < ${this._cfg.MIN_CONFIDENCE})`);
            return; // RETURN
        }

        // Signal confirmation: require same direction on 2 consecutive ticks within 60s
        const now = Date.now();
        const prevSig = this._lastSignal;
        this._lastSignal = { direction: finalDirection, score: signal.score, ts: now };
        if (!prevSig || prevSig.direction !== finalDirection || (now - prevSig.ts) > 60_000) {
            console.log(`[TRADE] Signal ${finalDirection.toUpperCase()} — waiting for confirmation next tick`);
            return; // ACTION: wait — RETURN
        }
        this._lastSignal = null;

        if (balance < 15) {
            console.log(`🚨 Balance below $15 (${balance.toFixed(2)}) — stopping`);
            await this.telegram.sendMessage(`🚨 *CRITICAL STOP*\nBalance: \`${balance.toFixed(2)}\``);
            process.exit(1);
        }

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
        const maxSizeFromBalance = (balance * this._cfg.SIZING_MAX_BALANCE_PCT) / markPrice;
        if (size > maxSizeFromBalance) size = Math.max(this._cfg.ORDER_SIZE_MIN, maxSizeFromBalance);

        const baseHoldSecs = Math.floor(Math.random() * (this._cfg.FARM_MAX_HOLD_SECS - this._cfg.FARM_MIN_HOLD_SECS + 1)) + this._cfg.FARM_MIN_HOLD_SECS;
        const holdSecs = Math.min(this._cfg.FARM_MAX_HOLD_SECS * 2, Math.max(this._cfg.FARM_MIN_HOLD_SECS, Math.round(baseHoldSecs * regimeConfig.holdMultiplier)));
        this.farmHoldUntil = Date.now() + holdSecs * 1000;
        this.riskManager.setSlPercent(this._cfg.FARM_SL_PERCENT * regimeConfig.slBufferMultiplier);
        this._pendingDynamicTP = null;

        console.log(`📐 [TRADE] Size: ${size.toFixed(5)} | Hold: ${holdSecs}s | Regime: ${signal.regime}`);

        const order = await this.executor.placeEntryOrder(this.symbol, finalDirection, size);
        if (order) {
            this.signalEngine.invalidateCache();
            this._logEvent('ORDER_PLACED', `[TRADE] ${finalDirection.toUpperCase()} ${size.toFixed(3)} @ ${order.price}`);
            this.botState = 'PENDING';
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
                meta: { baseScore: signal.base_score, bias, regime: signal.regime, finalScore: signal.score },
                signalMeta: this._pendingEntrySignalMeta,
                placedAt: Date.now(),
                replaceCount: 0,
                cancelledOnTick: false,
            };
        }
        return; // ACTION: place — RETURN
    }

    // ─────────────────────────────────────────────────────────────────────────
    // COOLDOWN TRANSITIONS
    //
    // 'farm'   → FARM_COOLDOWN_SECS (fixed short cooldown for farm mode)
    // 'random' → random between [COOLDOWN_MIN_MINS, COOLDOWN_MAX_MINS]
    //
    // STRICT: after calling _transitionToCooldown the caller MUST return.
    // ─────────────────────────────────────────────────────────────────────────

    private _transitionToCooldown(mode: 'farm' | 'random') {
        let cooldownMs: number;

        if (mode === 'farm') {
            // Farm mode: fixed short cooldown (FARM_COOLDOWN_SECS, default 30s)
            cooldownMs = this._cfg.FARM_COOLDOWN_SECS * 1_000;
            console.log(`⏱️ FARM cooldown: ${this._cfg.FARM_COOLDOWN_SECS}s`);
        } else {
            // Random between COOLDOWN_MIN_MINS and COOLDOWN_MAX_MINS
            const minMs = this._cfg.COOLDOWN_MIN_MINS * 60_000;
            const maxMs = this._cfg.COOLDOWN_MAX_MINS * 60_000;
            cooldownMs = Math.random() * (maxMs - minMs) + minMs;
            console.log(`⏱️ Random cooldown: ${(cooldownMs / 60_000).toFixed(1)} mins [${this._cfg.COOLDOWN_MIN_MINS}–${this._cfg.COOLDOWN_MAX_MINS} mins]`);
        }

        this.cooldownUntil = Date.now() + cooldownMs;
        this.botState = 'COOLDOWN';
        this.pendingExit = null;
        this.entryFilledAt = null;
        this.farmHoldUntil = null;
    }

    private _transitionToIdle() {
        this.botState = 'IDLE';
        this.pendingEntry = null;
        this.pendingExit = null;
        this.entryFilledAt = null;
        this.farmHoldUntil = null;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // PUBLIC: force close (Telegram button / dashboard)
    // ─────────────────────────────────────────────────────────────────────────

    async forceClosePosition(): Promise<boolean> {
        const position = await this.adapter.get_position(this.symbol);
        if (!position || position.size === 0) {
            console.log(`⚠️ [Watcher] Force close: no active position`);
            return false;
        }

        console.log(`🛑 [Watcher] Manual force close requested`);

        // Cancel any open orders first
        await this.adapter.cancel_all_orders(this.symbol);

        const order = await this.executor.placeExitOrder(this.symbol, position, true /* IOC */);
        if (!order) return false;

        this._pendingExitTrigger = 'FORCE';
        this._exitPnlSnapshot = position.unrealizedPnl;
        this.botState = 'EXITING';
        this.pendingExit = {
            order,
            positionSide: position.side as 'long' | 'short',
            pnl: position.unrealizedPnl,
            forceClose: true,
            placedAt: Date.now(),
        };
        return true;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // PUBLIC: status / session helpers
    // ─────────────────────────────────────────────────────────────────────────

    async getDetailedStatus(): Promise<{ text: string; hasPosition: boolean }> {
        const [position, markPrice, balance] = await Promise.all([
            this.adapter.get_position(this.symbol),
            this.adapter.get_mark_price(this.symbol),
            this.adapter.get_balance(),
        ]);

        let text = `Balance: *${balance.toFixed(2)}* | Price: *${markPrice.toFixed(2)}*\n`;
        text += `State: *${this.botState}* | Profile: *${this.currentProfile}*\n`;

        if (position && position.size !== 0) {
            const duration = this.positionManager.getDurationSeconds();
            text += `📍 *ACTIVE ${position.side.toUpperCase()}*: \`${position.size} ${position.symbol}\`\n`;
            text += `   Entry: \`${position.entryPrice.toFixed(2)}\` | PnL: \`${position.unrealizedPnl.toFixed(2)}\` | Time: \`${duration}s\``;
            return { text, hasPosition: true };
        }

        text += `💤 No active position.\n🔍 Searching for signals...`;
        return { text, hasPosition: false };
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
        this._pendingMMBias = null;
        this._pendingDynamicTP = null;
        this._pendingEntrySpreadBps = null;
        this._retryEntry = null;
        this._exitPnlSnapshot = 0;
        this._tickLock = false;
        this.marketMaker.reset();
    }

    /** Update the trading symbol at runtime — takes effect on next tick */
    setSymbol(symbol: string): void {
        this.symbol = symbol;
        this.signalEngine.invalidateCache();
    }

    // ─────────────────────────────────────────────────────────────────────────
    // PRIVATE: profile updater
    // ─────────────────────────────────────────────────────────────────────────

    private updateProfile() {
        let winStreak = 0;
        let lossStreak = 0;
        for (let i = this.recentPnLs.length - 1; i >= 0; i--) {
            if (this.recentPnLs[i] > 0 && lossStreak === 0) winStreak++;
            else if (this.recentPnLs[i] < 0 && winStreak === 0) lossStreak++;
            else break;
        }
        if (winStreak >= 3)  this.currentProfile = Math.random() > 0.5 ? 'RUNNER' : 'DEGEN';
        else if (lossStreak >= 3) this.currentProfile = Math.random() > 0.5 ? 'SCALP' : 'DEGEN';
        else this.currentProfile = 'NORMAL';
    }
}
