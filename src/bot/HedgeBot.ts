import { randomUUID } from 'crypto';
import type { ExchangeAdapter } from '../adapters/ExchangeAdapter.js';
import type { TelegramManager } from '../modules/TelegramManager.js';
import { TradeLogger } from '../ai/TradeLogger.js';
import { AISignalEngine } from '../ai/AISignalEngine.js';
import { VolumeMonitor } from './VolumeMonitor.js';
import { createBotSharedState, logEvent } from './BotSharedState.js';
import type { HedgeBotConfig } from './types.js';
import type { HedgeBotSharedState, HedgeBotStatus, ActiveLegPair } from './HedgeBotSharedState.js';
import {
  assignDirections,
  evaluateExitConditions,
  computeCombinedPnl,
  computeLegSize,
  checkLegImbalance,
  buildHedgeTradeRecord,
} from './hedgeBotHelpers.js';
import type { CompletedTrade, ExitReason } from './hedgeBotHelpers.js';

/**
 * HedgeBot — Correlation Hedging Bot
 *
 * Trades two correlated assets (e.g. BTC and ETH) simultaneously on the same
 * exchange in opposite directions. One leg goes long while the other goes short,
 * with equal USD notional value on each side.
 *
 * Implements the same duck-typed lifecycle interface as BotInstance so that
 * BotManager can manage it without modification.
 *
 * Requirements: 2.1, 2.2, 2.3, 2.5
 */
export class HedgeBot {
  readonly id: string;
  readonly config: HedgeBotConfig;
  readonly state: HedgeBotSharedState;

  private adapter: ExchangeAdapter;
  private telegram: TelegramManager;
  private tradeLogger: TradeLogger;
  private volumeMonitor: VolumeMonitor;
  private signalEngineA: AISignalEngine;
  private signalEngineB: AISignalEngine;

  /** Controls the tick loop — set to false by stop() */
  private _running: boolean = false;

  /** Tracks the start time for uptime calculation */
  private _startTime: number | null = null;

  /**
   * Rolling window of BTC/ETH price ratio samples for equilibrium spread.
   * Maintained during IN_PAIR state.
   */
  private _ratioWindow: number[] = [];

  /**
   * Context captured during OPENING state — direction assignment and signal scores.
   * Cleared when transitioning away from OPENING.
   */
  private _openingContext: {
    longSymbol: string;
    shortSymbol: string;
    scoreA: number;
    scoreB: number;
    entryTimestamp: string;
    orderIdA: string | null;
    orderIdB: string | null;
    /** Timestamp (ms) when WAITING_FILL state was entered — used for fill timeout */
    waitingFillStartMs: number | null;
  } | null = null;

  /**
   * Timestamp when COOLDOWN state was entered (ms since epoch).
   */
  private _cooldownStartMs: number | null = null;

  constructor(
    config: HedgeBotConfig,
    adapter: ExchangeAdapter,
    telegram: TelegramManager,
  ) {
    this.id = config.id;
    this.config = config;
    this.adapter = adapter;
    this.telegram = telegram;

    // Initialize base shared state via factory, then extend with hedge-specific fields
    const baseState = createBotSharedState(config.id);
    this.state = {
      ...baseState,
      symbol: `${config.symbolA}/${config.symbolB}`,
      walletAddress: config.credentialKey || 'N/A',
      hedgeBotState: 'IDLE',
      hedgePosition: null,
    };

    // Initialize TradeLogger
    this.tradeLogger = new TradeLogger(
      config.tradeLogBackend,
      config.tradeLogPath,
    );

    // Initialize VolumeMonitor for dual-symbol spike detection
    this.volumeMonitor = new VolumeMonitor(
      adapter,
      config.symbolA,
      config.symbolB,
      config.volumeRollingWindow,
      config.volumeSpikeMultiplier,
    );

    // Initialize one AISignalEngine per symbol — each has its own cache
    this.signalEngineA = new AISignalEngine(adapter, this.tradeLogger);
    this.signalEngineB = new AISignalEngine(adapter, this.tradeLogger);
  }

  /**
   * Start the HedgeBot.
   * Sets botStatus to RUNNING and launches the tick loop in the background.
   * Returns true if started successfully, false if already running.
   *
   * Requirements: 2.1
   */
  async start(): Promise<boolean> {
    if (this.state.botStatus === 'RUNNING') {
      console.log(`[HedgeBot:${this.id}] Already running`);
      return false;
    }

    this.state.botStatus = 'RUNNING';
    this.state.updatedAt = new Date().toISOString();
    this._running = true;
    this._startTime = Date.now();

    console.log(`✅ [HedgeBot:${this.id}] Started`);

    // Launch tick loop in background — do not await
    this._runTickLoop().catch((err) => {
      console.error(`[HedgeBot:${this.id}] Tick loop crashed:`, err);
      this.state.botStatus = 'STOPPED';
      this.state.updatedAt = new Date().toISOString();
      this._running = false;
    });

    return true;
  }

  /**
   * Stop the HedgeBot.
   * Sets botStatus to STOPPED and stops the tick loop.
   * Logs a warning if a hedge position is still open.
   *
   * Requirements: 2.1, 2.3
   */
  async stop(): Promise<void> {
    console.log(`[HedgeBot:${this.id}] Stopping...`);

    this._running = false;
    this.state.botStatus = 'STOPPED';
    this.state.updatedAt = new Date().toISOString();

    // Requirement 2.3: warn if positions remain open — do NOT close them
    if (this.state.hedgePosition !== null) {
      const { legA, legB } = this.state.hedgePosition;
      console.warn(
        `[HedgeBot:${this.id}] WARNING: Stopped with active LegPair. ` +
          `Positions remain open: ${legA.symbol} ${legA.side}, ${legB.symbol} ${legB.side}`,
      );
    }

    console.log(`✅ [HedgeBot:${this.id}] Stopped`);
  }

  /**
   * Get current bot status for API/dashboard.
   * Returns a HedgeBotStatus object compatible with BotStatus plus hedgePosition.
   *
   * Requirements: 2.2
   */
  getStatus(): HedgeBotStatus {
    const uptime = this._startTime
      ? Math.floor((Date.now() - this._startTime) / 60000)
      : 0;

    const efficiencyBps =
      this.state.sessionVolume > 0
        ? (this.state.sessionPnl / this.state.sessionVolume) * 10000
        : 0;

    // progress: 0-100, based on max loss exposure (mirrors BotInstance pattern)
    const progress = 0;

    return {
      id: this.id,
      name: this.config.name,
      exchange: this.config.exchange,
      status: this.state.botStatus === 'RUNNING' ? 'active' : 'inactive',
      symbol: `${this.config.symbolA}/${this.config.symbolB}`,
      tags: this.config.tags,
      sessionPnl: this.state.sessionPnl,
      sessionVolume: this.state.sessionVolume,
      sessionFees: this.state.sessionFees,
      efficiencyBps,
      walletAddress: this.state.walletAddress,
      uptime,
      hasPosition: this.state.hedgePosition !== null,
      openPosition: null,   // hedge uses hedgePosition instead
      progress,
      hedgePosition: this.state.hedgePosition,
    };
  }

  // ---------------------------------------------------------------------------
  // Internal tick loop (placeholder — full state machine implemented in tasks 8.x)
  // ---------------------------------------------------------------------------

  /**
   * Runs the tick loop until _running is set to false.
   * Checks botStatus on each iteration and calls _tick() every 5 seconds.
   * IDLE state uses a longer interval (15s) to reduce API rate pressure.
   */
  private async _runTickLoop(): Promise<void> {
    while (this._running && this.state.botStatus === 'RUNNING') {
      await this._tick();
      // Use longer sleep in IDLE to reduce rate limit pressure from volume sampling.
      // WAITING_FILL uses short interval to detect fills quickly.
      const sleepMs = this.state.hedgeBotState === 'IDLE' ? 15_000 : 5_000;
      await this._sleep(sleepMs);
    }
  }

  /**
   * Single tick — dispatches to the appropriate state handler.
   * IDLE → OPENING → WAITING_FILL → IN_PAIR → CLOSING → COOLDOWN
   */
  private async _tick(): Promise<void> {
    switch (this.state.hedgeBotState) {
      case 'IDLE':
        await this._tickIdle();
        break;
      case 'OPENING':
        await this._tickOpening();
        break;
      case 'WAITING_FILL':
        await this._tickWaitingFill();
        break;
      case 'IN_PAIR':
        await this._tickInPair();
        break;
      case 'CLOSING':
        await this._tickClosing();
        break;
      case 'COOLDOWN':
        await this._tickCooldown();
        break;
    }
  }

  // ---------------------------------------------------------------------------
  // Task 8.1 — IDLE state: volume sampling and entry evaluation
  // Requirements: 3.4, 3.5, 4.1, 4.4, 4.5
  // ---------------------------------------------------------------------------

  private async _tickIdle(): Promise<void> {
    // Sample volume — skip tick on error (Requirement 3.6, 4.5)
    try {
      await this.volumeMonitor.sample();
    } catch (err) {
      console.warn(`[HedgeBot:${this.id}] Volume sample failed — skipping tick:`, err);
      return;
    }

    // Only proceed when both windows show a spike (Requirements 3.4, 3.5)
    if (!this.volumeMonitor.shouldEnter()) {
      return;
    }

    logEvent(this.id, this.state, 'info', 'Volume spike detected — evaluating entry');

    // Fetch signals for both symbols in parallel (Requirement 4.1)
    let signalA: Awaited<ReturnType<AISignalEngine['getSignal']>>;
    let signalB: Awaited<ReturnType<AISignalEngine['getSignal']>>;
    try {
      [signalA, signalB] = await Promise.all([
        this.signalEngineA.getSignal(this.config.symbolA),
        this.signalEngineB.getSignal(this.config.symbolB),
      ]);
    } catch (err) {
      // Requirement 4.5: skip entry on signal engine error
      console.error(`[HedgeBot:${this.id}] Signal engine error — skipping entry:`, err);
      logEvent(this.id, this.state, 'error', `Signal engine error: ${String(err)}`);
      return;
    }

    // Assign directions (Requirements 4.2, 4.3, 4.4)
    const directions = assignDirections(
      this.config.symbolA,
      signalA.score,
      this.config.symbolB,
      signalB.score,
    );

    if (directions === null) {
      // Requirement 4.4: skip when both skip or scores are equal
      console.log(`[HedgeBot:${this.id}] Direction assignment returned null — skipping entry (scores: A=${signalA.score.toFixed(4)}, B=${signalB.score.toFixed(4)})`);
      logEvent(this.id, this.state, 'info', `Entry skipped: scores too close (A=${signalA.score.toFixed(4)}, B=${signalB.score.toFixed(4)})`);
      return;
    }

    logEvent(
      this.id,
      this.state,
      'info',
      `Entry triggered: long=${directions.longSymbol}, short=${directions.shortSymbol}`,
    );

    // Store opening context and transition to OPENING
    this._openingContext = {
      longSymbol: directions.longSymbol,
      shortSymbol: directions.shortSymbol,
      scoreA: signalA.score,
      scoreB: signalB.score,
      entryTimestamp: new Date().toISOString(),
      orderIdA: null,
      orderIdB: null,
      waitingFillStartMs: null,
    };
    this.state.hedgeBotState = 'OPENING';
  }

  // ---------------------------------------------------------------------------
  // Task 8.2 — OPENING state: atomic leg placement
  // Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6
  // ---------------------------------------------------------------------------

  private async _tickOpening(): Promise<void> {
    if (!this._openingContext) {
      console.error(`[HedgeBot:${this.id}] OPENING state with no context — returning to IDLE`);
      this.state.hedgeBotState = 'IDLE';
      return;
    }

    const ctx = this._openingContext;

    // Step 1: Check for stale open orders — if any exist, cancel them this tick and return.
    // Next tick will proceed to place fresh orders.
    let openOrdersA: Awaited<ReturnType<typeof this.adapter.get_open_orders>> = [];
    let openOrdersB: Awaited<ReturnType<typeof this.adapter.get_open_orders>> = [];
    try {
      [openOrdersA, openOrdersB] = await Promise.all([
        this.adapter.get_open_orders(this.config.symbolA),
        this.adapter.get_open_orders(this.config.symbolB),
      ]);
    } catch (err) {
      console.warn(`[HedgeBot:${this.id}] Failed to check open orders in OPENING — skipping tick:`, err);
      return;
    }

    if (openOrdersA.length > 0 || openOrdersB.length > 0) {
      console.log(`[HedgeBot:${this.id}] OPENING: found stale open orders (A=${openOrdersA.length}, B=${openOrdersB.length}) — cancelling this tick`);
      try {
        await Promise.all([
          openOrdersA.length > 0 ? this.adapter.cancel_all_orders(this.config.symbolA) : Promise.resolve(true),
          openOrdersB.length > 0 ? this.adapter.cancel_all_orders(this.config.symbolB) : Promise.resolve(true),
        ]);
      } catch (err) {
        console.warn(`[HedgeBot:${this.id}] Failed to cancel stale orders in OPENING:`, err);
      }
      return; // next tick will place fresh orders
    }

    // Step 2: No open orders — fetch mark prices and place entry orders
    let markPriceA: number;
    let markPriceB: number;
    try {
      [markPriceA, markPriceB] = await Promise.all([
        this.adapter.get_mark_price(this.config.symbolA),
        this.adapter.get_mark_price(this.config.symbolB),
      ]);
    } catch (err) {
      console.error(`[HedgeBot:${this.id}] Failed to fetch mark prices — returning to IDLE:`, err);
      logEvent(this.id, this.state, 'error', `Mark price fetch failed: ${String(err)}`);
      this._openingContext = null;
      this.state.hedgeBotState = 'IDLE';
      return;
    }

    // Compute leg sizes (Requirement 5.1)
    const sizeA = computeLegSize(this.config.legValueUsd, markPriceA);
    const sizeB = computeLegSize(this.config.legValueUsd, markPriceB);

    // Determine sides: long symbol buys, short symbol sells
    const sideA = ctx.longSymbol === this.config.symbolA ? 'buy' : 'sell';
    const sideB = ctx.longSymbol === this.config.symbolB ? 'buy' : 'sell';

    // Place both leg orders atomically (Requirement 5.2, 5.6)
    let orderIdA: string | null = null;
    let orderIdB: string | null = null;
    let errorA: unknown = null;
    let errorB: unknown = null;

    try {
      const results = await Promise.allSettled([
        this.adapter.place_limit_order(this.config.symbolA, sideA, markPriceA, sizeA),
        this.adapter.place_limit_order(this.config.symbolB, sideB, markPriceB, sizeB),
      ]);

      if (results[0].status === 'fulfilled') {
        orderIdA = results[0].value;
      } else {
        errorA = results[0].reason;
      }

      if (results[1].status === 'fulfilled') {
        orderIdB = results[1].value;
      } else {
        errorB = results[1].reason;
      }
    } catch (err) {
      console.error(`[HedgeBot:${this.id}] Unexpected error during leg placement:`, err);
      this._openingContext = null;
      this.state.hedgeBotState = 'IDLE';
      return;
    }

    // Requirement 5.4: if one leg failed, cancel the successful one
    if (errorA !== null || errorB !== null) {
      const failedLegs = [errorA, errorB].filter(Boolean);
      console.error(`[HedgeBot:${this.id}] Leg placement failed (${failedLegs.length} leg(s)):`, errorA ?? errorB);
      logEvent(this.id, this.state, 'error', `Leg placement failed — cancelling and returning to IDLE`);

      // Cancel whichever leg succeeded
      if (orderIdA !== null) {
        try {
          await this.adapter.cancel_order(orderIdA, this.config.symbolA);
          console.log(`[HedgeBot:${this.id}] Cancelled leg A order ${orderIdA}`);
        } catch (cancelErr) {
          console.error(`[HedgeBot:${this.id}] Failed to cancel leg A order ${orderIdA}:`, cancelErr);
        }
      }
      if (orderIdB !== null) {
        try {
          await this.adapter.cancel_order(orderIdB, this.config.symbolB);
          console.log(`[HedgeBot:${this.id}] Cancelled leg B order ${orderIdB}`);
        } catch (cancelErr) {
          console.error(`[HedgeBot:${this.id}] Failed to cancel leg B order ${orderIdB}:`, cancelErr);
        }
      }

      this._openingContext = null;
      this.state.hedgeBotState = 'IDLE';
      return;
    }

    // Both orders placed successfully — transition to WAITING_FILL.
    // Fill confirmation happens in the next tick (_tickWaitingFill).
    // This follows the one-action-per-tick principle: place orders this tick,
    // check fills next tick.
    logEvent(
      this.id,
      this.state,
      'info',
      `Orders placed: A=${this.config.symbolA} ${sideA} orderID=${orderIdA}, B=${this.config.symbolB} ${sideB} orderID=${orderIdB}`,
    );
    console.log(`[HedgeBot:${this.id}] Orders placed — waiting for fill`);
    this._openingContext.waitingFillStartMs = Date.now();
    this.state.hedgeBotState = 'WAITING_FILL';
  }

  // ---------------------------------------------------------------------------
  // WAITING_FILL state: poll positions until both legs are filled
  //
  // Case 1: 1 filled + 1 rejected → place the rejected leg again this tick
  // Case 2: 1 filled + 1 pending  → wait; if timeout → cancel pending, back to OPENING
  // Case 3: 2 pending              → wait; if timeout → cancel both, back to OPENING
  // ---------------------------------------------------------------------------

  /** Max time (ms) to wait for a limit order to fill before cancelling */
  private static readonly FILL_TIMEOUT_MS = 30_000; // 30 seconds

  private async _tickWaitingFill(): Promise<void> {
    if (!this._openingContext) {
      console.error(`[HedgeBot:${this.id}] WAITING_FILL state with no context — cancelling and returning to IDLE`);
      try {
        await Promise.all([
          this.adapter.cancel_all_orders(this.config.symbolA),
          this.adapter.cancel_all_orders(this.config.symbolB),
        ]);
      } catch {}
      this.state.hedgeBotState = 'IDLE';
      return;
    }

    const ctx = this._openingContext;
    const elapsedMs = ctx.waitingFillStartMs !== null ? Date.now() - ctx.waitingFillStartMs : 0;

    // Fetch mark prices for PnL computation and re-ordering
    let markPriceA: number;
    let markPriceB: number;
    try {
      [markPriceA, markPriceB] = await Promise.all([
        this.adapter.get_mark_price(this.config.symbolA),
        this.adapter.get_mark_price(this.config.symbolB),
      ]);
    } catch (err) {
      console.warn(`[HedgeBot:${this.id}] WAITING_FILL: failed to fetch mark prices — retrying next tick:`, err);
      return;
    }

    // Check current positions (filled legs)
    let posA: Awaited<ReturnType<ExchangeAdapter['get_position']>>;
    let posB: Awaited<ReturnType<ExchangeAdapter['get_position']>>;
    try {
      [posA, posB] = await Promise.all([
        this.adapter.get_position(this.config.symbolA, markPriceA),
        this.adapter.get_position(this.config.symbolB, markPriceB),
      ]);
    } catch (err) {
      console.warn(`[HedgeBot:${this.id}] WAITING_FILL: failed to query positions — retrying next tick:`, err);
      return;
    }

    // Check open orders (pending legs)
    let openOrdersA: Awaited<ReturnType<typeof this.adapter.get_open_orders>> = [];
    let openOrdersB: Awaited<ReturnType<typeof this.adapter.get_open_orders>> = [];
    try {
      [openOrdersA, openOrdersB] = await Promise.all([
        this.adapter.get_open_orders(this.config.symbolA),
        this.adapter.get_open_orders(this.config.symbolB),
      ]);
    } catch (err) {
      console.warn(`[HedgeBot:${this.id}] WAITING_FILL: failed to query open orders — retrying next tick:`, err);
      return;
    }

    const filledA = posA !== null && posA.size > 0;
    const filledB = posB !== null && posB.size > 0;
    const pendingA = openOrdersA.length > 0;
    const pendingB = openOrdersB.length > 0;

    // ── Both filled → success ─────────────────────────────────────────────────
    if (filledA && filledB) {
      const sideA = ctx.longSymbol === this.config.symbolA ? 'buy' : 'sell';
      const sideB = ctx.longSymbol === this.config.symbolB ? 'buy' : 'sell';

      const legA: import('./HedgeBotSharedState.js').LegState = {
        symbol: this.config.symbolA,
        side: sideA === 'buy' ? 'long' : 'short',
        size: posA!.size,
        entryPrice: posA!.entryPrice,
        unrealizedPnl: posA!.unrealizedPnl,
      };
      const legB: import('./HedgeBotSharedState.js').LegState = {
        symbol: this.config.symbolB,
        side: sideB === 'buy' ? 'long' : 'short',
        size: posB!.size,
        entryPrice: posB!.entryPrice,
        unrealizedPnl: posB!.unrealizedPnl,
      };

      this.state.hedgePosition = {
        legA,
        legB,
        entryTimestamp: ctx.entryTimestamp,
        combinedPnl: computeCombinedPnl(posA!.unrealizedPnl, posB!.unrealizedPnl),
      };

      checkLegImbalance(posA!.size * posA!.entryPrice, posB!.size * posB!.entryPrice, this.config.legValueUsd);

      logEvent(this.id, this.state, 'info',
        `Both legs filled: A=${this.config.symbolA} ${sideA} ${posA!.size}@${posA!.entryPrice}, B=${this.config.symbolB} ${sideB} ${posB!.size}@${posB!.entryPrice}`);
      console.log(`✅ [HedgeBot:${this.id}] Both legs filled — entering IN_PAIR`);
      this.state.hedgeBotState = 'IN_PAIR';
      return;
    }

    // ── Case 1: one filled, one rejected (not filled AND not pending) ─────────
    // The rejected leg needs to be re-placed this tick.
    if (filledA && !filledB && !pendingB) {
      console.log(`[HedgeBot:${this.id}] WAITING_FILL Case 1: A filled, B rejected — re-placing B`);
      const sideB = ctx.longSymbol === this.config.symbolB ? 'buy' : 'sell';
      const sizeB = computeLegSize(this.config.legValueUsd, markPriceB);
      try {
        await this.adapter.place_limit_order(this.config.symbolB, sideB, markPriceB, sizeB);
        console.log(`[HedgeBot:${this.id}] Re-placed leg B: ${sideB} ${sizeB} @ ${markPriceB}`);
      } catch (err) {
        console.error(`[HedgeBot:${this.id}] Failed to re-place leg B:`, err);
      }
      return;
    }

    if (filledB && !filledA && !pendingA) {
      console.log(`[HedgeBot:${this.id}] WAITING_FILL Case 1: B filled, A rejected — re-placing A`);
      const sideA = ctx.longSymbol === this.config.symbolA ? 'buy' : 'sell';
      const sizeA = computeLegSize(this.config.legValueUsd, markPriceA);
      try {
        await this.adapter.place_limit_order(this.config.symbolA, sideA, markPriceA, sizeA);
        console.log(`[HedgeBot:${this.id}] Re-placed leg A: ${sideA} ${sizeA} @ ${markPriceA}`);
      } catch (err) {
        console.error(`[HedgeBot:${this.id}] Failed to re-place leg A:`, err);
      }
      return;
    }

    // ── Case 2 & 3: pending orders — check timeout ────────────────────────────
    const timedOut = elapsedMs >= HedgeBot.FILL_TIMEOUT_MS;

    if (!timedOut) {
      // Still within timeout — keep waiting
      const remaining = Math.ceil((HedgeBot.FILL_TIMEOUT_MS - elapsedMs) / 1000);
      if (filledA && pendingB) {
        console.log(`[HedgeBot:${this.id}] WAITING_FILL Case 2: A filled, B pending — waiting (${remaining}s left)`);
      } else if (filledB && pendingA) {
        console.log(`[HedgeBot:${this.id}] WAITING_FILL Case 2: B filled, A pending — waiting (${remaining}s left)`);
      } else {
        console.log(`[HedgeBot:${this.id}] WAITING_FILL Case 3: both pending — waiting (${remaining}s left)`);
      }
      return;
    }

    // Timeout reached — cancel all pending orders, go back to OPENING for retry
    console.warn(`[HedgeBot:${this.id}] WAITING_FILL: fill timeout (${HedgeBot.FILL_TIMEOUT_MS / 1000}s) — cancelling pending orders`);
    logEvent(this.id, this.state, 'warn', `Fill timeout — cancelling pending orders and retrying`);

    try {
      await Promise.all([
        pendingA ? this.adapter.cancel_all_orders(this.config.symbolA) : Promise.resolve(true),
        pendingB ? this.adapter.cancel_all_orders(this.config.symbolB) : Promise.resolve(true),
      ]);
    } catch (err) {
      console.warn(`[HedgeBot:${this.id}] Failed to cancel pending orders on timeout:`, err);
    }

    // Reset waitingFillStartMs so next OPENING tick starts fresh
    this._openingContext.waitingFillStartMs = null;
    // Go back to OPENING — next tick will check for open orders (should be none now),
    // then place fresh orders at current market price
    this.state.hedgeBotState = 'OPENING';
  }

  // ---------------------------------------------------------------------------
  // Task 8.3 — IN_PAIR state: exit condition monitoring
  // Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 8.3, 10.4
  // ---------------------------------------------------------------------------

  private async _tickInPair(): Promise<void> {
    if (!this.state.hedgePosition) {
      console.error(`[HedgeBot:${this.id}] IN_PAIR state with no hedgePosition — returning to IDLE`);
      this.state.hedgeBotState = 'IDLE';
      return;
    }

    // Requirement 10.4: track available balance once per tick
    try {
      await this.adapter.get_balance();
    } catch (err) {
      console.warn(`[HedgeBot:${this.id}] get_balance failed:`, err);
    }

    // Fetch current positions for both symbols (Requirement 6.1, 8.3)
    let markPriceA: number;
    let markPriceB: number;
    try {
      [markPriceA, markPriceB] = await Promise.all([
        this.adapter.get_mark_price(this.config.symbolA),
        this.adapter.get_mark_price(this.config.symbolB),
      ]);
    } catch (err) {
      console.warn(`[HedgeBot:${this.id}] Failed to fetch mark prices in IN_PAIR:`, err);
      return;
    }

    let posA: Awaited<ReturnType<ExchangeAdapter['get_position']>>;
    let posB: Awaited<ReturnType<ExchangeAdapter['get_position']>>;
    try {
      [posA, posB] = await Promise.all([
        this.adapter.get_position(this.config.symbolA, markPriceA),
        this.adapter.get_position(this.config.symbolB, markPriceB),
      ]);
    } catch (err) {
      console.warn(`[HedgeBot:${this.id}] Failed to fetch positions in IN_PAIR:`, err);
      return;
    }

    // Compute combinedPnl and update hedgePosition (Requirement 8.3)
    const pnlA = posA?.unrealizedPnl ?? 0;
    const pnlB = posB?.unrealizedPnl ?? 0;
    const combinedPnl = computeCombinedPnl(pnlA, pnlB);

    this.state.hedgePosition = {
      ...this.state.hedgePosition,
      legA: {
        ...this.state.hedgePosition.legA,
        unrealizedPnl: pnlA,
      },
      legB: {
        ...this.state.hedgePosition.legB,
        unrealizedPnl: pnlB,
      },
      combinedPnl,
    };

    // Update equilibrium spread rolling window (Requirement 6.5)
    const currentRatio = markPriceA / markPriceB;
    if (this._ratioWindow.length >= this.config.volumeRollingWindow) {
      this._ratioWindow.shift();
    }
    this._ratioWindow.push(currentRatio);

    const equilibriumSpread =
      this._ratioWindow.length > 0
        ? this._ratioWindow.reduce((sum, v) => sum + v, 0) / this._ratioWindow.length
        : currentRatio;

    // Compute elapsed time
    const entryMs = new Date(this.state.hedgePosition.entryTimestamp).getTime();
    const elapsedSecs = (Date.now() - entryMs) / 1000;

    // Evaluate exit conditions (Requirement 6.1, 6.6)
    const exitResult = evaluateExitConditions({
      combinedPnl,
      profitTargetUsd: this.config.profitTargetUsd,
      maxLossUsd: this.config.maxLossUsd,
      elapsedSecs,
      holdingPeriodSecs: this.config.holdingPeriodSecs,
      currentRatio,
      equilibriumSpread,
    });

    if (exitResult.shouldExit) {
      logEvent(
        this.id,
        this.state,
        'info',
        `Exit triggered: reason=${exitResult.reason}, combinedPnl=${combinedPnl.toFixed(4)}`,
      );
      console.log(`[HedgeBot:${this.id}] Exit triggered: ${exitResult.reason} (pnl=${combinedPnl.toFixed(4)})`);
      this.state.hedgeBotState = 'CLOSING';
    }
  }

  // ---------------------------------------------------------------------------
  // Task 8.4 — CLOSING state: atomic close with retry
  // Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 9.1, 9.2, 9.3, 9.4
  // ---------------------------------------------------------------------------

  private async _tickClosing(): Promise<void> {
    if (!this.state.hedgePosition) {
      console.error(`[HedgeBot:${this.id}] CLOSING state with no hedgePosition — returning to IDLE`);
      this.state.hedgeBotState = 'IDLE';
      return;
    }

    const pair = this.state.hedgePosition;

    // Fetch current mark prices for close orders
    let markPriceA: number;
    let markPriceB: number;
    try {
      [markPriceA, markPriceB] = await Promise.all([
        this.adapter.get_mark_price(this.config.symbolA),
        this.adapter.get_mark_price(this.config.symbolB),
      ]);
    } catch (err) {
      console.error(`[HedgeBot:${this.id}] Failed to fetch mark prices for close — retrying next tick:`, err);
      return;
    }

    // Query ACTUAL current positions before placing close orders.
    // This handles partial fills, leg imbalances, and stale state from previous ticks.
    let currentPosA: Awaited<ReturnType<typeof this.adapter.get_position>>;
    let currentPosB: Awaited<ReturnType<typeof this.adapter.get_position>>;
    try {
      [currentPosA, currentPosB] = await Promise.all([
        this.adapter.get_position(this.config.symbolA, markPriceA),
        this.adapter.get_position(this.config.symbolB, markPriceB),
      ]);
    } catch (err) {
      console.warn(`[HedgeBot:${this.id}] Failed to query current positions for close — retrying next tick:`, err);
      return;
    }

    const flatA = currentPosA === null || currentPosA.size === 0;
    const flatB = currentPosB === null || currentPosB.size === 0;

    if (flatA && flatB) {
      console.log(`[HedgeBot:${this.id}] Both positions already flat — completing close`);
      await this._completeClose(pair, markPriceA, markPriceB);
      return;
    }

    // Step 3: Check for stale open orders — if any exist, cancel them this tick and return.
    // Next tick will place fresh close orders against the actual current position.
    let openOrdersA: Awaited<ReturnType<typeof this.adapter.get_open_orders>> = [];
    let openOrdersB: Awaited<ReturnType<typeof this.adapter.get_open_orders>> = [];
    try {
      [openOrdersA, openOrdersB] = await Promise.all([
        this.adapter.get_open_orders(this.config.symbolA),
        this.adapter.get_open_orders(this.config.symbolB),
      ]);
    } catch (err) {
      console.warn(`[HedgeBot:${this.id}] Failed to check open orders in CLOSING — skipping tick:`, err);
      return;
    }

    if (openOrdersA.length > 0 || openOrdersB.length > 0) {
      console.log(`[HedgeBot:${this.id}] CLOSING: found stale open orders (A=${openOrdersA.length}, B=${openOrdersB.length}) — cancelling this tick`);
      try {
        await Promise.all([
          openOrdersA.length > 0 ? this.adapter.cancel_all_orders(this.config.symbolA) : Promise.resolve(true),
          openOrdersB.length > 0 ? this.adapter.cancel_all_orders(this.config.symbolB) : Promise.resolve(true),
        ]);
      } catch (err) {
        console.warn(`[HedgeBot:${this.id}] Failed to cancel stale orders in CLOSING:`, err);
      }
      return; // next tick will place fresh close orders
    }

    // Requirement 7.1, 7.2: place close orders only for legs that still have position
    const placeCloseOrder = async (
      symbol: string,
      side: 'buy' | 'sell',
      size: number,
      price: number,
    ): Promise<string> => {
      const backoffMs = [1000, 2000, 4000];
      let lastErr: unknown;
      for (let attempt = 0; attempt <= 3; attempt++) {
        try {
          const orderId = await this.adapter.place_limit_order(symbol, side, price, size, true);
          return orderId;
        } catch (err) {
          lastErr = err;
          if (attempt < 3) {
            // Requirement 7.3: exponential backoff (1s, 2s, 4s)
            await this._sleep(backoffMs[attempt]);
          }
        }
      }
      throw lastErr;
    };

    /** Minimum notional value (USD) for a close order — below this, treat as dust and skip */
    const MIN_CLOSE_NOTIONAL_USD = 5;

    // Build close tasks only for legs that still have open positions
    const closeTasks: Promise<string>[] = [];
    if (!flatA && currentPosA) {
      const closeSideA: 'buy' | 'sell' = currentPosA.side === 'long' ? 'sell' : 'buy';
      const notionalA = currentPosA.size * markPriceA;
      if (notionalA < MIN_CLOSE_NOTIONAL_USD) {
        console.warn(`[HedgeBot:${this.id}] Leg A notional too small ($${notionalA.toFixed(2)}) — treating as dust, skipping close`);
        // Treat as flat — dust position, not worth closing
      } else {
        console.log(`[HedgeBot:${this.id}] Closing leg A: ${this.config.symbolA} ${closeSideA} ${currentPosA.size} (notional $${notionalA.toFixed(2)})`);
        closeTasks.push(placeCloseOrder(this.config.symbolA, closeSideA, currentPosA.size, markPriceA));
      }
    } else if (flatA) {
      console.log(`[HedgeBot:${this.id}] Leg A (${this.config.symbolA}) already flat — skipping`);
    }

    if (!flatB && currentPosB) {
      const closeSideB: 'buy' | 'sell' = currentPosB.side === 'long' ? 'sell' : 'buy';
      const notionalB = currentPosB.size * markPriceB;
      if (notionalB < MIN_CLOSE_NOTIONAL_USD) {
        console.warn(`[HedgeBot:${this.id}] Leg B notional too small ($${notionalB.toFixed(2)}) — treating as dust, skipping close`);
        // Treat as flat — dust position, not worth closing
      } else {
        console.log(`[HedgeBot:${this.id}] Closing leg B: ${this.config.symbolB} ${closeSideB} ${currentPosB.size} (notional $${notionalB.toFixed(2)})`);
        closeTasks.push(placeCloseOrder(this.config.symbolB, closeSideB, currentPosB.size, markPriceB));
      }
    } else if (flatB) {
      console.log(`[HedgeBot:${this.id}] Leg B (${this.config.symbolB}) already flat — skipping`);
    }

    if (closeTasks.length === 0) {
      // Both flat — shouldn't reach here but handle defensively
      await this._completeClose(pair, markPriceA, markPriceB);
      return;
    }

    try {
      await Promise.all(closeTasks);
    } catch (err) {
      // Requirement 7.3, 9.4: persistent failure — log critical, alert via Telegram, remain in CLOSING
      console.error(`[HedgeBot:${this.id}] CRITICAL: Failed to close positions after retries:`, err);
      logEvent(this.id, this.state, 'error', `CRITICAL: Close orders failed after retries: ${String(err)}`);

      // Alert via Telegram if enabled
      if (this.telegram.isEnabled()) {
        try {
          await this.telegram.sendMessage(
            `🚨 [HedgeBot:${this.id}] CRITICAL: Failed to close positions after retries. Manual intervention required!`,
          );
        } catch (tgErr) {
          console.error(`[HedgeBot:${this.id}] Telegram alert failed:`, tgErr);
        }
      }

      // Remain in CLOSING state — will retry on next tick
      return;
    }

    // Requirement 7.4: poll get_position up to 5 times (1s interval) to confirm flat
    let confirmedFlatA = flatA; // already flat legs count as confirmed
    let confirmedFlatB = flatB;
    for (let poll = 0; poll < 5; poll++) {
      try {
        const [posA, posB] = await Promise.all([
          confirmedFlatA ? Promise.resolve(null) : this.adapter.get_position(this.config.symbolA, markPriceA),
          confirmedFlatB ? Promise.resolve(null) : this.adapter.get_position(this.config.symbolB, markPriceB),
        ]);
        if (!confirmedFlatA) confirmedFlatA = posA === null || posA.size === 0;
        if (!confirmedFlatB) confirmedFlatB = posB === null || posB.size === 0;
        if (confirmedFlatA && confirmedFlatB) break;
      } catch (err) {
        console.warn(`[HedgeBot:${this.id}] Position poll ${poll + 1}/5 failed:`, err);
      }
      if (poll < 4) await this._sleep(1000);
    }

    if (!confirmedFlatA || !confirmedFlatB) {
      console.warn(`[HedgeBot:${this.id}] Positions not confirmed flat after 5 polls (flatA=${confirmedFlatA}, flatB=${confirmedFlatB})`);
      logEvent(this.id, this.state, 'warn', `Positions not confirmed flat after 5 polls`);
      // Remain in CLOSING — will retry on next tick with fresh position query
      return;
    }

    await this._completeClose(pair, markPriceA, markPriceB);
  }

  /**
   * Finalize a completed close: log trade record, update session stats, transition to COOLDOWN.
   */
  private async _completeClose(
    pair: import('./HedgeBotSharedState.js').ActiveLegPair,
    markPriceA: number,
    markPriceB: number,
  ): Promise<void> {
    const exitTimestamp = new Date().toISOString();
    const entryMs = new Date(pair.entryTimestamp).getTime();
    const holdDurationSecs = Math.round((Date.now() - entryMs) / 1000);

    // Determine exit reason from the last evaluated exit conditions
    // Re-evaluate to get the reason (or use TIME_EXPIRY as fallback)
    const exitReasonResult = evaluateExitConditions({
      combinedPnl: pair.combinedPnl,
      profitTargetUsd: this.config.profitTargetUsd,
      maxLossUsd: this.config.maxLossUsd,
      elapsedSecs: holdDurationSecs,
      holdingPeriodSecs: this.config.holdingPeriodSecs,
      currentRatio: this._ratioWindow.length > 0 ? this._ratioWindow[this._ratioWindow.length - 1] : 1,
      equilibriumSpread:
        this._ratioWindow.length > 0
          ? this._ratioWindow.reduce((s, v) => s + v, 0) / this._ratioWindow.length
          : 1,
    });
    const exitReason: ExitReason = exitReasonResult.reason ?? 'TIME_EXPIRY';

    const completedTrade: CompletedTrade = {
      id: randomUUID(),
      botId: this.id,
      exchange: this.config.exchange,
      symbolA: this.config.symbolA,
      symbolB: this.config.symbolB,
      legValueUsd: this.config.legValueUsd,
      entryPriceA: pair.legA.entryPrice,
      entryPriceB: pair.legB.entryPrice,
      exitPriceA: markPriceA,
      exitPriceB: markPriceB,
      sizeA: pair.legA.size,
      sizeB: pair.legB.size,
      pnlA: pair.legA.unrealizedPnl,
      pnlB: pair.legB.unrealizedPnl,
      exitReason,
      entryTimestamp: pair.entryTimestamp,
      exitTimestamp,
      signalScoreA: this._openingContext?.scoreA ?? 0,
      signalScoreB: this._openingContext?.scoreB ?? 0,
      longSymbol: this._openingContext?.longSymbol ?? this.config.symbolA,
      shortSymbol: this._openingContext?.shortSymbol ?? this.config.symbolB,
    };

    const tradeRecord = buildHedgeTradeRecord(completedTrade);

    // Log via TradeLogger (Requirement 9.1)
    // TradeLogger.log() expects a TradeRecord — we write the hedge record as JSON directly
    try {
      const fs = await import('fs');
      await fs.promises.appendFile(
        this.config.tradeLogPath,
        JSON.stringify(tradeRecord) + '\n',
      );
    } catch (err) {
      console.error(`[HedgeBot:${this.id}] Failed to write trade log:`, err);
    }

    // Requirement 9.4: update sessionPnl and sessionVolume
    this.state.sessionPnl += pair.combinedPnl;
    this.state.sessionVolume += this.config.legValueUsd * 2; // both legs
    this.state.updatedAt = new Date().toISOString();

    logEvent(
      this.id,
      this.state,
      'info',
      `AtomicClose confirmed: reason=${exitReason}, combinedPnl=${pair.combinedPnl.toFixed(4)}, holdDuration=${holdDurationSecs}s`,
    );
    console.log(`✅ [HedgeBot:${this.id}] AtomicClose confirmed: ${exitReason} pnl=${pair.combinedPnl.toFixed(4)}`);

    // Clear position and opening context
    this.state.hedgePosition = null;
    this._openingContext = null;
    this._ratioWindow = [];

    // Transition to COOLDOWN
    this._cooldownStartMs = Date.now();
    this.state.hedgeBotState = 'COOLDOWN';
  }

  // ---------------------------------------------------------------------------
  // Task 8.5 — COOLDOWN state
  // Requirements: 7.6
  // ---------------------------------------------------------------------------

  private async _tickCooldown(): Promise<void> {
    const cooldownSecs = this.config.cooldownSecs ?? 30;
    const elapsedMs = this._cooldownStartMs !== null ? Date.now() - this._cooldownStartMs : Infinity;

    if (elapsedMs >= cooldownSecs * 1000) {
      console.log(`[HedgeBot:${this.id}] Cooldown expired (${cooldownSecs}s) — returning to IDLE`);
      logEvent(this.id, this.state, 'info', `Cooldown expired — returning to IDLE`);
      this._cooldownStartMs = null;
      this.state.hedgeBotState = 'IDLE';
    }
  }

  /** Resolves after `ms` milliseconds. */
  private _sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // ---------------------------------------------------------------------------
  // Accessors for components (used by tests and advanced features)
  // ---------------------------------------------------------------------------

  getTradeLogger(): TradeLogger {
    return this.tradeLogger;
  }

  getVolumeMonitor(): VolumeMonitor {
    return this.volumeMonitor;
  }

  getSignalEngineA(): AISignalEngine {
    return this.signalEngineA;
  }

  getSignalEngineB(): AISignalEngine {
    return this.signalEngineB;
  }
}
