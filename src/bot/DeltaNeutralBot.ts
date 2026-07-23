import { randomUUID } from 'crypto';
import type { ExchangeAdapter } from '../adapters/ExchangeAdapter.js';
import type { TelegramManager } from '../modules/TelegramManager.js';
import { TradeLogger } from '../ai/TradeLogger.js';
import { createBotSharedState, logEvent } from './BotSharedState.js';
import { recordTrade } from '../db/ReportingCollector.js';
import { ChunkedEntryExecutor } from './ChunkedEntryExecutor.js';
import type {
  DeltaNeutralConfig,
  DeltaNeutralSharedState,
  DeltaNeutralBotState,
  DeltaNeutralPosition,
  DeltaNeutralLegState,
  DeltaNeutralTradeRecord,
  DeltaNeutralExitReason,
  DeltaNeutralStatus,
} from './DeltaNeutralTypes.js';

/**
 * Dust position threshold (BTC). Positions smaller than this are considered
 * residuals from partial fills / rounding and treated as flat.
 * 0.0001 BTC ≈ $6.40 at $64k — safely below any meaningful trade size.
 */
const DUST_THRESHOLD = 0.0001;

/**
 * DeltaNeutralBot -- Cross-Exchange Delta-Neutral OI Farming Bot
 *
 * Opens a delta-neutral position across two exchanges (e.g. Long on Perpl,
 * Short on Ondo) and holds it for extended periods (4h-72h+) to maximize
 * Open Interest contribution on the primary exchange for points farming.
 *
 * Key differences from PairBot:
 * - Cross-exchange (two separate adapters)
 * - Optimizes for HOLD DURATION, not PnL
 * - Exits only on max hold time, funding flip, or emergency conditions
 * - Tracks OI-hours and CPM (Cost Per Million) metrics
 */
export class DeltaNeutralBot {
  readonly id: string;
  readonly config: DeltaNeutralConfig;
  readonly state: DeltaNeutralSharedState;

  private adapterA: ExchangeAdapter;  // Primary exchange (earns points)
  private adapterB: ExchangeAdapter;  // Hedge exchange
  private telegram: TelegramManager;
  private tradeLogger: TradeLogger;

  private _running = false;
  private _startTime: number | null = null;
  private _cooldownStartMs: number | null = null;
  private _lastOiUpdate: number | null = null;
  private _lastFundingSnapshot: number | undefined = undefined;
  private _waitingFillStartMs: number | null = null;
  /** Number of consecutive CLOSING ticks attempted — used for escalation */
  private _closeAttempts = 0;
  /** Max close attempts before escalating to aggressive price offset */
  private readonly MAX_CLOSE_ATTEMPTS_BEFORE_ESCALATION = 6; // ~30s at 5s tick
  /** Recent completed trade records (in-memory, last 20) for dashboard display */
  private _recentTrades: Array<{
    time: string;
    holdMins: number;
    pnlA: number;
    pnlB: number;
    combined: number;
    reason: string;
  }> = [];
  /** Max time to wait for fills before retrying with market order (ms) */
  private readonly FILL_TIMEOUT_MS = 30_000;

  constructor(
    config: DeltaNeutralConfig,
    adapterA: ExchangeAdapter,
    adapterB: ExchangeAdapter,
    telegram: TelegramManager,
  ) {
    this.id = config.id;
    this.config = config;
    this.adapterA = adapterA;
    this.adapterB = adapterB;
    this.telegram = telegram;

    // Initialize base shared state
    const baseState = createBotSharedState(config.id);
    this.state = {
      ...baseState,
      symbol: config.symbol,
      walletAddress: `${config.credentialKeyA}+${config.credentialKeyB}`,
      oiFarmerState: 'IDLE',
      position: null,
      totalOiHours: 0,
      totalFundingReceived: 0,
      totalFundingPaid: 0,
      completedCycles: 0,
      avgHoldDurationSecs: 0,
      cpmUsd: 0,
    };

    this.tradeLogger = new TradeLogger(config.tradeLogBackend, config.tradeLogPath);
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  async start(): Promise<boolean> {
    if (this.state.botStatus === 'RUNNING') {
      console.log(`[DeltaNeutral:${this.id}] Already running`);
      return false;
    }

    this.state.botStatus = 'RUNNING';
    this.state.updatedAt = new Date().toISOString();
    this._running = true;
    this._startTime = Date.now();

    console.log(`✅ [DeltaNeutral:${this.id}] Started -- ${this.config.exchangeA}(primary) + ${this.config.exchangeB}(hedge)`);
    logEvent(this.id, this.state, 'INFO', `Delta-Neutral started: ${this.config.exchangeA} + ${this.config.exchangeB}`);

    // Launch tick loop in background
    this._runTickLoop().catch((err) => {
      console.error(`[DeltaNeutral:${this.id}] Tick loop crashed:`, err);
      this.state.botStatus = 'STOPPED';
      this._running = false;
    });

    return true;
  }

  async stop(): Promise<void> {
    if (!this._running) return;
    this._running = false;

    // Close open positions before stopping
    if (this.state.position) {
      console.log(`[DeltaNeutral:${this.id}] Closing positions before stop...`);
      logEvent(this.id, this.state, 'INFO', 'Closing positions on stop');
      await this._initiateClose('MANUAL');
      // Execute close immediately (don't wait for tick loop)
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          await this._tickClosing();
        } catch (err) {
          console.error(`[DeltaNeutral:${this.id}] Close attempt ${attempt + 1} threw:`, err);
        }
        // Check if positions are closed
        const symbolA = this.config.symbolA || this.config.symbol;
        const symbolB = this.config.symbolB || this.config.symbol;
        const posA = await this.adapterA.get_position(symbolA).catch(() => null);
        const posB = await this.adapterB.get_position(symbolB).catch(() => null);
        const flatA = !posA || Math.abs(posA.size) <= DUST_THRESHOLD;
        const flatB = !posB || Math.abs(posB.size) <= DUST_THRESHOLD;
        if (flatA && flatB) {
          console.log(`[DeltaNeutral:${this.id}] Both positions closed successfully (dust threshold: ${DUST_THRESHOLD})`);
          // If _completeClose wasn't triggered (e.g. positions closed between ticks),
          // send close notification now and update state
          if (this.state.position) {
            const pos = this.state.position;
            const holdDurationSecs = (Date.now() - new Date(pos.entryTimestamp).getTime()) / 1000;
            const primarySide = pos.primaryLeg.side.charAt(0).toUpperCase() + pos.primaryLeg.side.slice(1);
            const hedgeSide = pos.hedgeLeg.side.charAt(0).toUpperCase() + pos.hedgeLeg.side.slice(1);
            const fmtPnl = (v: number) => (v >= 0 ? '+' : '-') + '$' + Math.abs(v).toFixed(3);
            const closeMsg = `🌾 *DELTA-NEUTRAL* ${this.config.name}\n\n` +
              `PRIMARY ${this.config.exchangeA.toUpperCase()}: Closed ${primarySide} ${fmtPnl(pos.primaryLeg.unrealizedPnl)}\n` +
              `HEDGE ${this.config.exchangeB.toUpperCase()}: Closed ${hedgeSide} ${fmtPnl(pos.hedgeLeg.unrealizedPnl)}\n\n` +
              `Combined: ${fmtPnl(pos.combinedPnl)} | Hold: ${(holdDurationSecs / 60).toFixed(0)}m | Exit: MANUAL`;
            await this.telegram.sendMessage(closeMsg).catch((err: any) => {
              console.error(`[DeltaNeutral:${this.id}] Telegram stop-close notification failed:`, err?.message ?? err);
            });
            this.state.sessionPnl += pos.combinedPnl;
            this.state.completedCycles++;
            this.state.position = null;
          }
          break;
        }
        // Wait before retry
        await this._sleep(3000);
      }
    }

    // Always reset state to IDLE on stop — even if positions couldn't be closed.
    // This prevents the bot from appearing "stuck in CLOSING" on the dashboard.
    // If positions remain open, they're orphaned and must be closed manually or
    // by another mechanism (the standard bot will NOT pick them up thanks to dust threshold).
    if (this.state.oiFarmerState !== 'IDLE') {
      const hadPositions = !!this.state.position;
      this.state.oiFarmerState = 'IDLE';
      this.state.position = null;
      if (hadPositions) {
        console.warn(`⚠️ [DeltaNeutral:${this.id}] Stop completed but positions may still be open on-exchange. State forced to IDLE.`);
        logEvent(this.id, this.state, 'WARN', 'Stopped with potentially open positions — manual close may be needed');
        // Send telegram notification that positions were force-closed
        const stopMsg = `⚠️ *DELTA-NEUTRAL* ${this.config.name}\n\nPositions force-closed on stop. Check exchange for residuals.`;
        await this.telegram.sendMessage(stopMsg).catch(() => {});
      }
    }

    this.state.botStatus = 'STOPPED';
    this.state.updatedAt = new Date().toISOString();
    console.log(`🛑 [DeltaNeutral:${this.id}] Stopped`);
    logEvent(this.id, this.state, 'INFO', 'Delta-Neutral stopped');
  }

  /**
   * Pause the DeltaNeutralBot — stop entering new positions but keep existing
   * positions open. The tick loop continues running (monitoring, rebalancing,
   * closing) but _tickIdle() returns early while PAUSED.
   */
  async pause(): Promise<void> {
    if (this.state.botStatus !== 'RUNNING') {
      console.log(`[DeltaNeutral:${this.id}] Cannot pause — not running (status: ${this.state.botStatus})`);
      return;
    }

    this.state.botStatus = 'PAUSED';
    this.state.updatedAt = new Date().toISOString();
    console.log(`⏸ [DeltaNeutral:${this.id}] Paused — no new entries, positions remain open`);
    logEvent(this.id, this.state, 'INFO', 'Delta-Neutral paused');
  }

  /**
   * Resume the DeltaNeutralBot from PAUSED state — return to normal RUNNING operation.
   */
  async resume(): Promise<void> {
    if (this.state.botStatus !== 'PAUSED') {
      console.log(`[DeltaNeutral:${this.id}] Cannot resume — not paused (status: ${this.state.botStatus})`);
      return;
    }

    this.state.botStatus = 'RUNNING';
    this.state.updatedAt = new Date().toISOString();
    console.log(`▶ [DeltaNeutral:${this.id}] Resumed — normal operation`);
    logEvent(this.id, this.state, 'INFO', 'Delta-Neutral resumed');
  }

  // ── Status & Dashboard ────────────────────────────────────────────────────

  getStatus(): DeltaNeutralStatus {
    const uptime = this._startTime ? Math.floor((Date.now() - this._startTime) / 60_000) : 0;
    const progress = this.state.position
      ? Math.min(100, Math.floor(
          ((Date.now() - new Date(this.state.position.entryTimestamp).getTime()) / 1000)
          / this.config.maxHoldSecs * 100
        ))
      : 0;

    return {
      id: this.id,
      name: this.config.name,
      botType: 'delta-neutral',
      exchangeA: this.config.exchangeA,
      exchangeB: this.config.exchangeB,
      maxHoldSecs: this.config.maxHoldSecs,
      status: this.state.botStatus === 'RUNNING' ? 'active' : this.state.botStatus === 'PAUSED' ? 'paused' : 'inactive',
      symbol: this.config.symbol,
      tags: this.config.tags,
      sessionPnl: this.state.sessionPnl + (this.state.position?.combinedPnl ?? 0),
      sessionVolume: this.state.sessionVolume,
      sessionFees: this.state.sessionFees,
      efficiencyBps: this.state.sessionVolume > 0
        ? (this.state.sessionPnl / this.state.sessionVolume) * 10_000
        : 0,
      costPerMillion: this.state.sessionVolume > 0
        ? ((this.state.sessionFees - this.state.sessionPnl) / this.state.sessionVolume) * 1_000_000
        : 0,
      walletAddress: this.state.walletAddress,
      uptime,
      hasPosition: this.state.position !== null,
      openPosition: null,
      progress,
      oiFarmerState: this.state.oiFarmerState,
      position: this.state.position,
      totalOiHours: this.state.totalOiHours,
      cpmUsd: this.state.cpmUsd,
      totalFundingReceived: this.state.totalFundingReceived,
      totalFundingPaid: this.state.totalFundingPaid,
      completedCycles: this.state.completedCycles,
      recentTrades: this._recentTrades,
    };
  }

  // ── Tick Loop ─────────────────────────────────────────────────────────────

  private async _runTickLoop(): Promise<void> {
    while (this._running && (this.state.botStatus === 'RUNNING' || this.state.botStatus === 'PAUSED')) {
      await this._tick();
      const sleepMs = this.state.oiFarmerState === 'ACTIVE'
        ? this.config.tickIntervalSecs * 1000
        : 5_000;
      await this._sleep(sleepMs);
    }
  }

  /** Single tick -- dispatches to state handler */
  private async _tick(): Promise<void> {
    switch (this.state.oiFarmerState) {
      case 'IDLE':
        await this._tickIdle();
        break;
      case 'OPENING':
        await this._tickOpening();
        break;
      case 'WAITING_FILL':
        await this._tickWaitingFill();
        break;
      case 'ACTIVE':
        await this._tickActive();
        break;
      case 'REBALANCING':
        await this._tickRebalancing();
        break;
      case 'CLOSING':
        await this._tickClosing();
        break;
      case 'COOLDOWN':
        await this._tickCooldown();
        break;
    }
  }

  private _sleep(ms: number): Promise<void> {
    return new Promise(r => setTimeout(r, ms));
  }

  /**
   * Get estimated taker fee rate for an exchange (as decimal, e.g., 0.00024 = 0.024%).
   * Perpl charges open only (0.069%), close is free → average = 0.069/2 = 0.0345%.
   */
  private _getExchangeFeeRate(exchange: string): number {
    switch (exchange.toLowerCase()) {
      case 'ondoperps': return 0.0002375; // 0.02375% taker
      case 'sodex':     return 0.00036;   // 0.036% taker
      case 'perpl':     return 0.000345;  // 0.069% open only / 2 (amortized over entry+exit)
      case 'hibachi':   return 0.0003;    // 0.03% taker (estimated)
      case 'decibel':   return 0.0003;    // 0.03% taker (estimated)
      case 'dango':     return 0.0003;    // 0.03% taker (estimated)
      default:          return 0.0003;    // conservative default
    }
  }

  // ── IDLE: Ready to open a new delta-neutral position ──────────────────────

  private async _tickIdle(): Promise<void> {
    // PAUSED: skip new entry evaluation — keep tick loop running for monitoring/closing
    if (this.state.botStatus === 'PAUSED') {
      return;
    }

    // CRITICAL SAFETY: Verify both legs are ACTUALLY flat before opening a new cycle.
    // This prevents opening new positions while orphaned positions from a previous
    // cycle remain open (e.g. due to close failures or API glitches).
    const symbolA = this.config.symbolA || this.config.symbol;
    const symbolB = this.config.symbolB || this.config.symbol;

    let existingPosA: Awaited<ReturnType<ExchangeAdapter['get_position']>> | null = null;
    let existingPosB: Awaited<ReturnType<ExchangeAdapter['get_position']>> | null = null;
    try {
      [existingPosA, existingPosB] = await Promise.all([
        this.adapterA.get_position(symbolA).catch(() => null),
        this.adapterB.get_position(symbolB).catch(() => null),
      ]);
    } catch {
      // If we can't even check, skip this tick
      return;
    }

    const hasOrphanA = existingPosA && Math.abs(existingPosA.size) > DUST_THRESHOLD;
    const hasOrphanB = existingPosB && Math.abs(existingPosB.size) > DUST_THRESHOLD;

    if (hasOrphanA || hasOrphanB) {
      const orphanLegs = [];
      if (hasOrphanA) orphanLegs.push(`A(${this.config.exchangeA}: ${existingPosA!.side} ${existingPosA!.size})`);
      if (hasOrphanB) orphanLegs.push(`B(${this.config.exchangeB}: ${existingPosB!.side} ${existingPosB!.size})`);
      console.warn(`⚠️ [DeltaNeutral:${this.id}] IDLE but orphaned position detected: ${orphanLegs.join(', ')} — closing before re-entry`);
      logEvent(this.id, this.state, 'WARN', `Orphaned position in IDLE: ${orphanLegs.join(', ')} — auto-closing`);
      // Transition to CLOSING to clean up the orphaned positions
      await this._initiateClose('MANUAL');
      return;
    }

    // Determine direction for primary leg
    const direction = await this._resolveDirection();
    if (!direction) {
      return; // Could not determine direction (e.g. funding fetch failed)
    }

    // Fetch mark prices on both exchanges
    let priceA: number;
    let priceB: number;
    try {
      [priceA, priceB] = await Promise.all([
        this.adapterA.get_mark_price(symbolA),
        this.adapterB.get_mark_price(symbolB),
      ]);
    } catch (err) {
      console.warn(`[DeltaNeutral:${this.id}] Price fetch failed -- skipping tick:`, err);
      return;
    }

    // Check price divergence between exchanges (> 1% = risky for same-asset DN)
    // Skip check when: same exchange (hedge mode) OR different symbols (pair trading)
    const isSameExchange = this.config.exchangeA === this.config.exchangeB;
    const isDifferentSymbols = (this.config.symbolA || this.config.symbol) !== (this.config.symbolB || this.config.symbol);
    if (!isSameExchange && !isDifferentSymbols) {
      const priceDivergence = Math.abs(priceA - priceB) / Math.max(priceA, priceB);
      if (priceDivergence > 0.01) {
        console.warn(`[DeltaNeutral:${this.id}] Price divergence too high: ${(priceDivergence * 100).toFixed(2)}% -- skipping entry`);
        return;
      }
    }

    logEvent(this.id, this.state, 'INFO', `Entry triggered: primary=${direction} on ${this.config.exchangeA}`);
    this.state.oiFarmerState = 'OPENING';
  }

  // ── OPENING: Place orders on both exchanges ───────────────────────────────

  private async _tickOpening(): Promise<void> {
    const symbolA = this.config.symbolA || this.config.symbol;
    const symbolB = this.config.symbolB || this.config.symbol;
    const direction = await this._resolveDirection();
    if (!direction) {
      this.state.oiFarmerState = 'IDLE';
      return;
    }

    // Fetch prices
    let priceA: number;
    let priceB: number;
    try {
      [priceA, priceB] = await Promise.all([
        this.adapterA.get_mark_price(symbolA),
        this.adapterB.get_mark_price(symbolB),
      ]);
    } catch (err) {
      console.error(`[DeltaNeutral:${this.id}] Price fetch failed in OPENING:`, err);
      this.state.oiFarmerState = 'IDLE';
      return;
    }

    // Compute size: random notional for leg A between min-max, leg B matches exactly
    const minUsd = this.config.orderSizeMinUsd || this.config.legValueUsd || 100;
    const maxUsd = this.config.orderSizeMaxUsd || this.config.legValueUsd || 200;
    const legNotionalUsd = minUsd + Math.random() * (maxUsd - minUsd);
    const sizeA = legNotionalUsd / priceA;
    const sizeB = sizeA;  // same asset qty ensures true delta neutrality across exchanges

    const sideA: 'buy' | 'sell' = direction === 'long' ? 'buy' : 'sell';
    const sideB: 'buy' | 'sell' = direction === 'long' ? 'sell' : 'buy';

    // ── SAFETY: Balance check before entry ────────────────────────────────────
    // Ensure both accounts have enough margin to cover the position.
    // Required margin ≈ notional / leverage. Use conservative estimate (10x max leverage).
    const estimatedLeverage = 10; // conservative — most perp DEXes allow 10-20x
    const requiredMarginPerLeg = legNotionalUsd / estimatedLeverage;
    const minRequiredBalance = requiredMarginPerLeg * 1.2; // 20% safety buffer

    try {
      const isSameExchange = this.config.exchangeA === this.config.exchangeB;
      const [balanceA, balanceB] = await Promise.all([
        this.adapterA.get_balance(),
        isSameExchange ? Promise.resolve(0) : this.adapterB.get_balance(),
      ]);

      let insufficientA = false;
      let insufficientB = false;

      if (isSameExchange) {
        // Same exchange: shared margin pool — need balance to cover BOTH legs
        const totalRequired = minRequiredBalance * 2;
        insufficientA = balanceA < totalRequired;
        if (insufficientA) {
          const details = [`${this.config.exchangeA}: $${balanceA.toFixed(2)} < $${totalRequired.toFixed(2)} required (both legs)`];
          const msg = `🚨 *DELTA-NEUTRAL* ${this.config.name}\n\n` +
            `⛔ INSUFFICIENT MARGIN — bot stopped\n\n` +
            details.join('\n') + `\n\n` +
            `Wanted: $${legNotionalUsd.toFixed(0)}/leg × 2 (need ~$${totalRequired.toFixed(0)} total margin)`;

          console.error(`[DeltaNeutral:${this.id}] INSUFFICIENT MARGIN: ${details.join('; ')}`);
          logEvent(this.id, this.state, 'ERROR', `Insufficient margin: ${details.join('; ')}`);
          await this.telegram.sendMessage(msg).catch(() => {});
          this._running = false;
          this.state.botStatus = 'STOPPED';
          this.state.oiFarmerState = 'IDLE';
          this.state.updatedAt = new Date().toISOString();
          return;
        }
        console.log(`[DeltaNeutral:${this.id}] Balance check OK (same-exchange): $${balanceA.toFixed(2)} (need $${totalRequired.toFixed(2)} for $${legNotionalUsd.toFixed(0)}/leg × 2)`);
      } else {
        // Cross-exchange: separate margin pools
        insufficientA = balanceA < minRequiredBalance;
        insufficientB = balanceB < minRequiredBalance;

        if (insufficientA || insufficientB) {
          const details = [];
          if (insufficientA) details.push(`${this.config.exchangeA}: $${balanceA.toFixed(2)} < $${minRequiredBalance.toFixed(2)} required`);
          if (insufficientB) details.push(`${this.config.exchangeB}: $${balanceB.toFixed(2)} < $${minRequiredBalance.toFixed(2)} required`);
          const msg = `🚨 *DELTA-NEUTRAL* ${this.config.name}\n\n` +
            `⛔ INSUFFICIENT MARGIN — bot stopped\n\n` +
            details.join('\n') + `\n\n` +
            `Wanted: $${legNotionalUsd.toFixed(0)}/leg (need ~$${minRequiredBalance.toFixed(0)} margin each)`;

          console.error(`[DeltaNeutral:${this.id}] INSUFFICIENT MARGIN: ${details.join('; ')}`);
          logEvent(this.id, this.state, 'ERROR', `Insufficient margin: ${details.join('; ')}`);
          await this.telegram.sendMessage(msg).catch(() => {});
          this._running = false;
          this.state.botStatus = 'STOPPED';
          this.state.oiFarmerState = 'IDLE';
          this.state.updatedAt = new Date().toISOString();
          return;
        }
        console.log(`[DeltaNeutral:${this.id}] Balance check OK: A=$${balanceA.toFixed(2)} B=$${balanceB.toFixed(2)} (need $${minRequiredBalance.toFixed(2)}/leg for $${legNotionalUsd.toFixed(0)} entry)`);
      }
    } catch (err) {
      // Cannot verify balance — skip this tick rather than risk unhedged entry
      console.warn(`[DeltaNeutral:${this.id}] Balance check failed — skipping entry:`, err);
      this.state.oiFarmerState = 'IDLE';
      return;
    }

    // ── Maker-Chunked Entry Mode ──────────────────────────────────────────────
    if (this.config.entryMode === 'maker-chunked') {
      const executor = new ChunkedEntryExecutor(this.adapterA, this.adapterB, {
        chunkSizeUsd: this.config.chunkSizeUsd || 100,
        chunkTimeoutSecs: this.config.chunkTimeoutSecs || 30,
        maxMakerAttempts: this.config.maxMakerAttempts || 3,
        maxTotalEntryTimeSecs: this.config.maxTotalEntryTimeSecs || 300,
      });

      try {
        console.log(`[DeltaNeutral:${this.id}] Maker-chunked entry: $${legNotionalUsd.toFixed(0)}/leg, chunks=$${this.config.chunkSizeUsd || 100}`);
        const result = await executor.execute(symbolA, symbolB, sizeA, sizeB, sideA, sideB);
        console.log(`[DeltaNeutral:${this.id}] Chunked entry complete: maker=${result.makerFills} taker=${result.takerFills} elapsed=${(result.elapsedMs / 1000).toFixed(0)}s`);

        // Verify positions filled
        const posA = await this.adapterA.get_position(symbolA, priceA).catch(() => null);
        const posB = await this.adapterB.get_position(symbolB, priceB).catch(() => null);
        if (posA && posA.size > 0 && posB && posB.size > 0) {
          await this._buildActivePosition(posA, posB, priceA, priceB);
        } else {
          console.warn(`[DeltaNeutral:${this.id}] Chunked entry did not result in positions — retrying next tick`);
          this.state.oiFarmerState = 'WAITING_FILL';
          this._waitingFillStartMs = Date.now();
        }
      } catch (err) {
        console.error(`[DeltaNeutral:${this.id}] Chunked entry failed:`, err);
        logEvent(this.id, this.state, 'ERROR', `Chunked entry failed: ${String(err)}`);
        await this._cancelAll();
        this.state.oiFarmerState = 'IDLE';
      }
      return;
    }

    // ── Default Taker Entry Mode ──────────────────────────────────────────────
    let orderIdA: string;
    let orderIdB: string;
    try {
      // Use mark price as limit (IOC-like for immediate fill)
      [orderIdA, orderIdB] = await Promise.all([
        this.adapterA.place_limit_order(symbolA, sideA, priceA, sizeA, false, 1),
        this.adapterB.place_limit_order(symbolB, sideB, priceB, sizeB, false, 1),
      ]);
    } catch (err) {
      console.error(`[DeltaNeutral:${this.id}] Order placement failed:`, err);
      logEvent(this.id, this.state, 'ERROR', `Entry failed: ${String(err)}`);
      // Try to cancel any that went through
      await this._cancelAll();
      this.state.oiFarmerState = 'IDLE';
      return;
    }

    console.log(`[DeltaNeutral:${this.id}] Orders placed: A=${orderIdA}, B=${orderIdB}`);
    this._waitingFillStartMs = Date.now();
    this.state.oiFarmerState = 'WAITING_FILL';
  }

  // ── WAITING_FILL: Verify both legs are filled, retry on timeout ─────────

  private async _tickWaitingFill(): Promise<void> {
    const symbolA = this.config.symbolA || this.config.symbol;
    const symbolB = this.config.symbolB || this.config.symbol;

    let priceA: number;
    let priceB: number;
    try {
      [priceA, priceB] = await Promise.all([
        this.adapterA.get_mark_price(symbolA),
        this.adapterB.get_mark_price(symbolB),
      ]);
    } catch (err) {
      console.warn(`[DeltaNeutral:${this.id}] Price fetch failed in WAITING_FILL:`, err);
      return;
    }

    // Check positions on both exchanges
    const posA = await this.adapterA.get_position(symbolA, priceA).catch(() => null);
    const posB = await this.adapterB.get_position(symbolB, priceB).catch(() => null);

    const filledA = posA && posA.size > 0;
    const filledB = posB && posB.size > 0;

    // Both have positions — but check they MATCH in size before declaring success.
    // If one leg is much larger than the other, chunked entry is still in progress.
    if (filledA && filledB) {
      const sizeA = Math.abs(posA!.size);
      const sizeB = Math.abs(posB!.size);
      const maxSize = Math.max(sizeA, sizeB);
      const imbalanceRatio = maxSize > 0 ? Math.abs(sizeA - sizeB) / maxSize : 0;

      if (imbalanceRatio > 0.20) {
        // Legs don't match yet (>20% difference) — wait for more fills
        const elapsed = this._waitingFillStartMs ? Date.now() - this._waitingFillStartMs : 0;
        console.log(`[DeltaNeutral:${this.id}] Legs imbalanced: A=${sizeA.toFixed(6)} B=${sizeB.toFixed(6)} (${(imbalanceRatio*100).toFixed(0)}% diff) — waiting for sync (${(elapsed/1000).toFixed(0)}s)`);

        // If waiting too long with imbalance, accept what we have (fallback)
        if (elapsed > 120_000) { // 2 minutes max wait for sync
          console.warn(`[DeltaNeutral:${this.id}] Imbalance persists after 2min — accepting current sizes`);
          this._waitingFillStartMs = null;
          await this._buildActivePosition(posA!, posB!, priceA, priceB);
        }
        return;
      }

      // Sizes match — declare success
      this._waitingFillStartMs = null;
      await this._buildActivePosition(posA!, posB!, priceA, priceB);
      return;
    }

    // Check timeout
    const elapsed = this._waitingFillStartMs ? Date.now() - this._waitingFillStartMs : 0;

    if (elapsed < this.FILL_TIMEOUT_MS) {
      // Still within timeout -- keep waiting
      console.log(`[DeltaNeutral:${this.id}] Waiting for fills (${(elapsed / 1000).toFixed(0)}s)... A=${posA?.size ?? 0}, B=${posB?.size ?? 0}`);
      return;
    }

    // Timeout reached -- take action
    console.warn(`[DeltaNeutral:${this.id}] Fill timeout (${(elapsed / 1000).toFixed(0)}s) -- taking action`);

    // Case 1: Neither filled -- cancel all and retry with market orders
    if (!filledA && !filledB) {
      console.log(`[DeltaNeutral:${this.id}] Neither leg filled -- cancelling and retrying with market orders`);
      await this._cancelAll();
      await this._retryWithMarketOrders(priceA, priceB);
      return;
    }

    // Case 2: One leg filled, other not -- retry unfilled leg with market order
    if (filledA && !filledB) {
      console.log(`[DeltaNeutral:${this.id}] Leg A filled but B not -- retrying B with market order`);
      await this.adapterB.cancel_all_orders(symbolB).catch(() => {});
      const direction = await this._resolveDirection();
      const sideB: 'buy' | 'sell' = direction === 'long' ? 'sell' : 'buy';
      // Match leg A's notional exactly
      const legANotional = posA!.size * priceA;
      const sizeB = legANotional / priceB;
      try {
        // Use aggressive price (cross spread) for immediate fill
        const ob = await this.adapterB.get_orderbook(symbolB);
        const aggressivePrice = sideB === 'buy' ? ob.best_ask : ob.best_bid;
        await this.adapterB.place_limit_order(symbolB, sideB, aggressivePrice, sizeB, false, 1);
        // Reset timeout for next check
        this._waitingFillStartMs = Date.now();
      } catch (err) {
        console.error(`[DeltaNeutral:${this.id}] Market retry B failed -- closing A and aborting:`, err);
        await this._closeOneLeg('A', posA!, priceA);
        this._waitingFillStartMs = null;
        this.state.oiFarmerState = 'COOLDOWN';
        this._cooldownStartMs = Date.now();
      }
      return;
    }

    if (!filledA && filledB) {
      console.log(`[DeltaNeutral:${this.id}] Leg B filled but A not -- retrying A with market order`);
      await this.adapterA.cancel_all_orders(symbolA).catch(() => {});
      const direction = await this._resolveDirection();
      const sideA: 'buy' | 'sell' = direction === 'long' ? 'buy' : 'sell';
      // Match leg B's notional exactly
      const legBNotional = posB!.size * priceB;
      const sizeA = legBNotional / priceA;
      try {
        const ob = await this.adapterA.get_orderbook(symbolA);
        const aggressivePrice = sideA === 'buy' ? ob.best_ask : ob.best_bid;
        await this.adapterA.place_limit_order(symbolA, sideA, aggressivePrice, sizeA, false, 1);
        this._waitingFillStartMs = Date.now();
      } catch (err) {
        console.error(`[DeltaNeutral:${this.id}] Market retry A failed -- closing B and aborting:`, err);
        await this._closeOneLeg('B', posB!, priceB);
        this._waitingFillStartMs = null;
        this.state.oiFarmerState = 'COOLDOWN';
        this._cooldownStartMs = Date.now();
      }
      return;
    }
  }

  /** Retry both legs with aggressive market-crossing prices */
  private async _retryWithMarketOrders(priceA: number, priceB: number): Promise<void> {
    const symbolA = this.config.symbolA || this.config.symbol;
    const symbolB = this.config.symbolB || this.config.symbol;
    const direction = await this._resolveDirection();
    if (!direction) { this.state.oiFarmerState = 'IDLE'; return; }

    const sideA: 'buy' | 'sell' = direction === 'long' ? 'buy' : 'sell';
    const sideB: 'buy' | 'sell' = direction === 'long' ? 'sell' : 'buy';
    // Random notional same as initial entry
    const minUsd = this.config.orderSizeMinUsd || this.config.legValueUsd || 100;
    const maxUsd = this.config.orderSizeMaxUsd || this.config.legValueUsd || 200;
    const legNotionalUsd = minUsd + Math.random() * (maxUsd - minUsd);
    const sizeA = legNotionalUsd / priceA;
    const sizeB = legNotionalUsd / priceB;

    try {
      // Get orderbooks for aggressive pricing
      const [obA, obB] = await Promise.all([
        this.adapterA.get_orderbook(symbolA),
        this.adapterB.get_orderbook(symbolB),
      ]);
      const aggressivePriceA = sideA === 'buy' ? obA.best_ask : obA.best_bid;
      const aggressivePriceB = sideB === 'buy' ? obB.best_ask : obB.best_bid;

      console.log(`[DeltaNeutral:${this.id}] Retrying with market: A=${sideA}@${aggressivePriceA}, B=${sideB}@${aggressivePriceB}`);

      await Promise.all([
        this.adapterA.place_limit_order(symbolA, sideA, aggressivePriceA, sizeA, false, 1),
        this.adapterB.place_limit_order(symbolB, sideB, aggressivePriceB, sizeB, false, 1),
      ]);
      // Reset timeout for next fill check
      this._waitingFillStartMs = Date.now();
    } catch (err) {
      console.error(`[DeltaNeutral:${this.id}] Market retry failed -- aborting to IDLE:`, err);
      await this._cancelAll();
      this._waitingFillStartMs = null;
      this.state.oiFarmerState = 'IDLE';
    }
  }

  /** Close a single filled leg (used when the other leg fails to fill) */
  private async _closeOneLeg(leg: 'A' | 'B', pos: { side: string; size: number }, price: number): Promise<void> {
    const symbol = leg === 'A'
      ? (this.config.symbolA || this.config.symbol)
      : (this.config.symbolB || this.config.symbol);
    const adapter = leg === 'A' ? this.adapterA : this.adapterB;
    const closeSide: 'buy' | 'sell' = pos.side === 'long' ? 'sell' : 'buy';
    try {
      await adapter.place_limit_order(symbol, closeSide, price, pos.size, true, 1);
      console.log(`[DeltaNeutral:${this.id}] Closed orphan leg ${leg}`);
    } catch (err) {
      console.error(`[DeltaNeutral:${this.id}] Failed to close orphan leg ${leg}:`, err);
    }
  }

  /** Build the active position state after both legs are confirmed filled */
  private async _buildActivePosition(
    posA: { size: number; entryPrice: number; unrealizedPnl: number; side: string },
    posB: { size: number; entryPrice: number; unrealizedPnl: number; side: string },
    priceA: number,
    priceB: number,
  ): Promise<void> {
    const symbolA = this.config.symbolA || this.config.symbol;
    const symbolB = this.config.symbolB || this.config.symbol;

    // Both legs filled -- build position state
    const direction = await this._resolveDirection();
    const primarySide: 'long' | 'short' = direction === 'long' ? 'long' : 'short';
    const hedgeSide: 'long' | 'short' = direction === 'long' ? 'short' : 'long';

    const position: DeltaNeutralPosition = {
      primaryLeg: {
        exchange: this.config.exchangeA,
        symbol: symbolA,
        side: primarySide,
        size: posA.size,
        entryPrice: posA.entryPrice,
        currentPrice: priceA,
        unrealizedPnl: posA.unrealizedPnl,
        notionalUsd: posA.size * priceA,
      },
      hedgeLeg: {
        exchange: this.config.exchangeB,
        symbol: symbolB,
        side: hedgeSide,
        size: posB.size,
        entryPrice: posB.entryPrice,
        currentPrice: priceB,
        unrealizedPnl: posB.unrealizedPnl,
        notionalUsd: posB.size * priceB,
      },
      entryTimestamp: new Date().toISOString(),
      combinedPnl: posA.unrealizedPnl + posB.unrealizedPnl,
      deltaExposureUsd: Math.abs((posA.size * priceA) - (posB.size * priceB)),
      oiHoursAccumulated: 0,
      netFundingUsd: 0,
    };

    this.state.position = position;
    this.state.oiFarmerState = 'ACTIVE';
    this._lastOiUpdate = Date.now();

    // Track volume (entry notional both legs)
    const entryVolume = (posA.size * posA.entryPrice) + (posB.size * posB.entryPrice);
    this.state.sessionVolume += entryVolume;

    // Estimate entry fees using exchange-specific taker rates
    const feeRateA = this._getExchangeFeeRate(this.config.exchangeA);
    const feeRateB = this._getExchangeFeeRate(this.config.exchangeB);
    const entryFees = (posA.size * posA.entryPrice * feeRateA) + (posB.size * posB.entryPrice * feeRateB);
    this.state.sessionFees += entryFees;

    const totalNotional = (posA.size * posA.entryPrice) + (posB.size * posB.entryPrice);
    const holdTarget = this.config.maxHoldSecs >= 3600
      ? (this.config.maxHoldSecs / 3600).toFixed(0) + 'h'
      : (this.config.maxHoldSecs / 60).toFixed(0) + 'm';

    const msg = `🌾 *DELTA-NEUTRAL* ${this.config.name}\n\n` +
      `PRIMARY ${this.config.exchangeA.toUpperCase()}: Open ${primarySide.charAt(0).toUpperCase() + primarySide.slice(1)} ${posA.size.toFixed(6)} @ $${posA.entryPrice.toFixed(2)}\n` +
      `HEDGE ${this.config.exchangeB.toUpperCase()}: Open ${hedgeSide.charAt(0).toUpperCase() + hedgeSide.slice(1)} ${posB.size.toFixed(6)} @ $${posB.entryPrice.toFixed(2)}\n\n` +
      `Notional: $${totalNotional.toFixed(0)}\n` +
      `Target hold: ${holdTarget}`;

    console.log(`[DeltaNeutral:${this.id}] Position active -- holding for OI points`);
    logEvent(this.id, this.state, 'INFO', `Position active: ${primarySide} ${symbolA} + ${hedgeSide} ${symbolB}`);
    await this.telegram.sendMessage(msg).catch((err: any) => {
      console.error(`[DeltaNeutral:${this.id}] Telegram open notification failed:`, err?.message ?? err);
    });
  }  // ── ACTIVE: Monitor position health, accumulate OI-hours ──────────────────

  private async _tickActive(): Promise<void> {
    if (!this.state.position) {
      this.state.oiFarmerState = 'IDLE';
      return;
    }

    const symbolA = this.config.symbolA || this.config.symbol;
    const symbolB = this.config.symbolB || this.config.symbol;
    const pos = this.state.position;

    // Fetch current prices
    let priceA: number;
    let priceB: number;
    try {
      [priceA, priceB] = await Promise.all([
        this.adapterA.get_mark_price(symbolA),
        this.adapterB.get_mark_price(symbolB),
      ]);
    } catch (err) {
      console.warn(`[DeltaNeutral:${this.id}] Price fetch failed in ACTIVE -- skipping tick`);
      return;
    }

    // Update position state — pass markPrice directly to avoid double-fetch and stale values
    const posA = await this.adapterA.get_position(symbolA, priceA).catch(() => null);
    const posB = await this.adapterB.get_position(symbolB, priceB).catch(() => null);

    if (posA) {
      pos.primaryLeg.currentPrice = priceA;
      pos.primaryLeg.unrealizedPnl = posA.unrealizedPnl;
      pos.primaryLeg.notionalUsd = posA.size * priceA;
      // Sync size from exchange (may differ from initial fill if retried/partial)
      if (posA.size > 0) pos.primaryLeg.size = posA.size;
    }
    if (posB) {
      pos.hedgeLeg.currentPrice = priceB;
      pos.hedgeLeg.unrealizedPnl = posB.unrealizedPnl;
      pos.hedgeLeg.notionalUsd = posB.size * priceB;
      // Sync size from exchange (may differ from initial fill if retried/partial)
      if (posB.size > 0) pos.hedgeLeg.size = posB.size;
    }

    // Track funding from both legs (positive = received, negative = paid)
    // Use DELTA since last update — exchange returns cumulative funding for position lifetime
    const fundingA = posA?.funding ?? 0;
    const fundingB = posB?.funding ?? 0;
    const currentTotalFunding = fundingA + fundingB;

    // On first read, store baseline. On subsequent reads, accumulate delta.
    if (this._lastFundingSnapshot === undefined) {
      this._lastFundingSnapshot = currentTotalFunding;
    } else {
      const delta = currentTotalFunding - this._lastFundingSnapshot;
      if (delta > 0) {
        this.state.totalFundingReceived += delta;
      } else if (delta < 0) {
        this.state.totalFundingPaid += Math.abs(delta);
      }
      this._lastFundingSnapshot = currentTotalFunding;
    }
    pos.netFundingUsd = this.state.totalFundingReceived - this.state.totalFundingPaid;

    pos.combinedPnl = pos.primaryLeg.unrealizedPnl + pos.hedgeLeg.unrealizedPnl;
    pos.deltaExposureUsd = Math.abs(pos.primaryLeg.notionalUsd - pos.hedgeLeg.notionalUsd);

    // Accumulate OI-hours since last update
    if (this._lastOiUpdate) {
      const hoursSinceUpdate = (Date.now() - this._lastOiUpdate) / 3_600_000;
      const oiIncrement = pos.primaryLeg.notionalUsd * hoursSinceUpdate;
      pos.oiHoursAccumulated += oiIncrement;
      this.state.totalOiHours += oiIncrement;
      this._lastOiUpdate = Date.now();
    }

    // Update CPM: totalCost / (totalOiHours / 1_000)
    // Using $/K (cost per thousand OI-hours) instead of $/M for human-readable values
    // Only meaningful after sufficient OI accumulation (>100 OI-hours)
    const totalCost = this.state.sessionFees + this.state.totalFundingPaid - this.state.totalFundingReceived;
    this.state.cpmUsd = this.state.totalOiHours > 100
      ? totalCost / (this.state.totalOiHours / 1_000)
      : 0;

    // ── Exit Condition Checks ─────────────────────────────────────────────

    const entryMs = new Date(pos.entryTimestamp).getTime();
    const elapsedSecs = (Date.now() - entryMs) / 1000;

    // 1. Max hold time reached -- normal rotation
    if (elapsedSecs >= this.config.maxHoldSecs) {
      console.log(`[DeltaNeutral:${this.id}] Max hold time reached (${(elapsedSecs / 3600).toFixed(1)}h) -- closing`);
      await this._initiateClose('MAX_HOLD');
      return;
    }

    // 2. Max loss breached -- emergency exit
    if (pos.combinedPnl <= -this.config.maxLossUsd) {
      console.log(`[DeltaNeutral:${this.id}] Max loss breached: $${pos.combinedPnl.toFixed(2)} -- emergency exit`);
      await this._initiateClose('MAX_LOSS');
      return;
    }

    // 3. Take profit -- close if combined PnL >= target AND past minimum hold time
    const takeProfitUsd = this.config.takeProfitUsd || 0;
    if (takeProfitUsd > 0 && pos.combinedPnl >= takeProfitUsd && elapsedSecs >= this.config.minHoldSecs) {
      console.log(`[DeltaNeutral:${this.id}] Take profit hit: $${pos.combinedPnl.toFixed(2)} >= $${takeProfitUsd} (held ${(elapsedSecs / 3600).toFixed(1)}h > min ${(this.config.minHoldSecs / 3600).toFixed(1)}h) -- closing`);
      await this._initiateClose('TAKE_PROFIT');
      return;
    }

    // 4. Delta divergence too large -- rebalance needed
    if (pos.deltaExposureUsd > this.config.maxDeltaDivergenceUsd) {
      console.log(`[DeltaNeutral:${this.id}] Delta diverged: $${pos.deltaExposureUsd.toFixed(2)} > $${this.config.maxDeltaDivergenceUsd} -- rebalancing`);
      this.state.oiFarmerState = 'REBALANCING';
      return;
    }

    // Log periodic status (every 10 ticks ~ every 10 minutes)
    if (Math.floor(elapsedSecs / 600) !== Math.floor((elapsedSecs - this.config.tickIntervalSecs) / 600)) {
      console.log(
        `[DeltaNeutral:${this.id}] ACTIVE ${(elapsedSecs / 3600).toFixed(1)}h | ` +
        `PnL: $${pos.combinedPnl.toFixed(3)} | Delta: $${pos.deltaExposureUsd.toFixed(2)} | ` +
        `OI-hrs: ${pos.oiHoursAccumulated.toFixed(0)} | CPM: $${this.state.cpmUsd.toFixed(2)}`
      );
    }
  }

  // ── REBALANCING: Adjust leg sizes to restore delta neutrality ──────────────

  private async _tickRebalancing(): Promise<void> {
    if (!this.state.position) {
      this.state.oiFarmerState = 'IDLE';
      return;
    }

    const pos = this.state.position;
    const symbolA = this.config.symbolA || this.config.symbol;
    const symbolB = this.config.symbolB || this.config.symbol;

    // Determine which leg is larger and reduce it
    const notionalDiff = pos.primaryLeg.notionalUsd - pos.hedgeLeg.notionalUsd;

    if (Math.abs(notionalDiff) <= this.config.maxDeltaDivergenceUsd * 0.5) {
      // Already rebalanced enough (within 50% of threshold)
      console.log(`[DeltaNeutral:${this.id}] Rebalance complete -- delta within tolerance`);
      this.state.oiFarmerState = 'ACTIVE';
      return;
    }

    // Strategy: partially close the larger leg to match the smaller
    // This is simpler than adding to the smaller leg (requires more margin)
    try {
      if (notionalDiff > 0) {
        // Primary leg is larger -- reduce it slightly
        const reduceUsd = Math.abs(notionalDiff) * 0.5;
        const reduceSize = reduceUsd / pos.primaryLeg.currentPrice;
        const reduceSide: 'buy' | 'sell' = pos.primaryLeg.side === 'long' ? 'sell' : 'buy';
        await this.adapterA.place_limit_order(
          symbolA, reduceSide, pos.primaryLeg.currentPrice, reduceSize, true, 1
        );
        console.log(`[DeltaNeutral:${this.id}] Reduced primary leg by ${reduceSize.toFixed(6)}`);
      } else {
        // Hedge leg is larger -- reduce it slightly
        const reduceUsd = Math.abs(notionalDiff) * 0.5;
        const reduceSize = reduceUsd / pos.hedgeLeg.currentPrice;
        const reduceSide: 'buy' | 'sell' = pos.hedgeLeg.side === 'long' ? 'sell' : 'buy';
        await this.adapterB.place_limit_order(
          symbolB, reduceSide, pos.hedgeLeg.currentPrice, reduceSize, true, 1
        );
        console.log(`[DeltaNeutral:${this.id}] Reduced hedge leg by ${reduceSize.toFixed(6)}`);
      }
    } catch (err) {
      console.error(`[DeltaNeutral:${this.id}] Rebalance failed:`, err);
      // If rebalance fails and delta is critical, close everything
      if (Math.abs(notionalDiff) > this.config.maxDeltaDivergenceUsd * 2) {
        await this._initiateClose('DELTA_DIVERGE');
        return;
      }
    }

    this.state.oiFarmerState = 'ACTIVE';
  }

  // ── CLOSING: Close both legs ──────────────────────────────────────────────

  private _exitReason: DeltaNeutralExitReason = 'MANUAL';

  private async _initiateClose(reason: DeltaNeutralExitReason): Promise<void> {
    this._exitReason = reason;
    this._closeAttempts = 0;
    this.state.oiFarmerState = 'CLOSING';
    logEvent(this.id, this.state, 'INFO', `Closing position: reason=${reason}`);
  }

  private async _tickClosing(): Promise<void> {
    const symbolA = this.config.symbolA || this.config.symbol;
    const symbolB = this.config.symbolB || this.config.symbol;

    // Get current prices
    let priceA: number;
    let priceB: number;
    try {
      [priceA, priceB] = await Promise.all([
        this.adapterA.get_mark_price(symbolA),
        this.adapterB.get_mark_price(symbolB),
      ]);
    } catch (err) {
      console.error(`[DeltaNeutral:${this.id}] Price fetch failed in CLOSING -- retrying`);
      return;
    }

    // CRITICAL FIX: Distinguish API errors from genuine flat positions.
    // Previously .catch(() => null) treated network errors as "no position" which
    // caused orphaned positions when one exchange API was temporarily unreachable.
    let posA: Awaited<ReturnType<ExchangeAdapter['get_position']>> | undefined;
    let posB: Awaited<ReturnType<ExchangeAdapter['get_position']>> | undefined;
    let fetchErrorA = false;
    let fetchErrorB = false;

    try {
      posA = await this.adapterA.get_position(symbolA, priceA);
    } catch (err) {
      fetchErrorA = true;
      console.warn(`[DeltaNeutral:${this.id}] CLOSING: get_position(A) failed — NOT treating as flat:`, err);
    }

    try {
      posB = await this.adapterB.get_position(symbolB, priceB);
    } catch (err) {
      fetchErrorB = true;
      console.warn(`[DeltaNeutral:${this.id}] CLOSING: get_position(B) failed — NOT treating as flat:`, err);
    }

    // If BOTH position fetches failed, skip this tick entirely — cannot make decisions
    if (fetchErrorA && fetchErrorB) {
      console.error(`[DeltaNeutral:${this.id}] CLOSING: Both position fetches failed — retrying next tick`);
      return;
    }

    // Only treat a leg as flat if we SUCCESSFULLY fetched and confirmed no position
    const flatA = !fetchErrorA && (!posA || Math.abs(posA.size) <= DUST_THRESHOLD);
    const flatB = !fetchErrorB && (!posB || Math.abs(posB.size) <= DUST_THRESHOLD);

    // If one leg's fetch failed, we can only close the leg we have data for.
    // Do NOT declare completion unless BOTH legs are confirmed flat with successful fetches.
    if (flatA && flatB) {
      this._closeAttempts = 0;
      await this._completeClose(priceA, priceB);
      return;
    }

    this._closeAttempts++;

    // Log warning when close is taking too long
    if (this._closeAttempts % 6 === 0) {
      const stuckLegs = [];
      if (!flatA) stuckLegs.push(`A(${this.config.exchangeA})`);
      if (!flatB) stuckLegs.push(`B(${this.config.exchangeB})`);
      console.warn(`⚠️ [DeltaNeutral:${this.id}] CLOSING stuck: ${this._closeAttempts} attempts, legs still open: ${stuckLegs.join(', ')}`);
      logEvent(this.id, this.state, 'WARN', `Close stuck: ${this._closeAttempts} attempts, open: ${stuckLegs.join(', ')}`);
    }

    // If a fetch errored, skip closing that leg this tick (don't cancel orders or place new ones blindly)
    // Only act on legs we have confirmed position data for.

    // Cancel any existing orders on legs we know are still open
    try {
      await Promise.all([
        (!flatA && !fetchErrorA) ? this.adapterA.cancel_all_orders(symbolA) : Promise.resolve(true),
        (!flatB && !fetchErrorB) ? this.adapterB.cancel_all_orders(symbolB) : Promise.resolve(true),
      ]);
    } catch {}

    // Escalation: after MAX_CLOSE_ATTEMPTS_BEFORE_ESCALATION, use aggressive price offset
    // to ensure IOC fills even in a wide-spread market (e.g. SoDEX)
    const isEscalated = this._closeAttempts >= this.MAX_CLOSE_ATTEMPTS_BEFORE_ESCALATION;
    const slippageMult = isEscalated ? 0.005 : 0; // 0.5% slippage when escalated

    if (isEscalated && this._closeAttempts === this.MAX_CLOSE_ATTEMPTS_BEFORE_ESCALATION) {
      console.warn(`🚨 [DeltaNeutral:${this.id}] Escalating close: using ${(slippageMult * 100).toFixed(1)}% price offset for IOC fills`);
      logEvent(this.id, this.state, 'WARN', 'Close escalated: aggressive pricing enabled');
    }

    // Place close orders (IOC with optional slippage for stuck cases)
    try {
      const closeTasks: Promise<string>[] = [];
      if (!flatA && !fetchErrorA && posA) {
        const closeSide: 'buy' | 'sell' = posA.side === 'long' ? 'sell' : 'buy';
        // For sells, use lower price; for buys, use higher price (to ensure fill)
        const closePrice = closeSide === 'sell'
          ? priceA * (1 - slippageMult)
          : priceA * (1 + slippageMult);
        closeTasks.push(this.adapterA.place_limit_order(symbolA, closeSide, closePrice, posA.size, true, 1));
      }
      if (!flatB && !fetchErrorB && posB) {
        const closeSide: 'buy' | 'sell' = posB.side === 'long' ? 'sell' : 'buy';
        const closePrice = closeSide === 'sell'
          ? priceB * (1 - slippageMult)
          : priceB * (1 + slippageMult);
        closeTasks.push(this.adapterB.place_limit_order(symbolB, closeSide, closePrice, posB.size, true, 1));
      }
      await Promise.all(closeTasks);
    } catch (err) {
      console.error(`[DeltaNeutral:${this.id}] Close orders failed -- retrying next tick:`, err);
    }
  }

  private async _completeClose(priceA: number, priceB: number): Promise<void> {
    const pos = this.state.position;
    if (!pos) {
      this.state.oiFarmerState = 'COOLDOWN';
      this._cooldownStartMs = Date.now();
      return;
    }

    // Calculate final PnL
    const holdDurationSecs = (Date.now() - new Date(pos.entryTimestamp).getTime()) / 1000;
    const combinedPnl = pos.combinedPnl;

    // Track close volume (both legs) — total volume = entry + exit
    const closeVolume = (pos.primaryLeg.size * priceA) + (pos.hedgeLeg.size * priceB);
    this.state.sessionVolume += closeVolume;

    // Estimate close fees using exchange-specific rates
    const closeFeeRateA = this._getExchangeFeeRate(this.config.exchangeA);
    const closeFeeRateB = this._getExchangeFeeRate(this.config.exchangeB);
    this.state.sessionFees += (pos.primaryLeg.size * priceA * closeFeeRateA) + (pos.hedgeLeg.size * priceB * closeFeeRateB);

    // Update session stats
    this.state.sessionPnl += combinedPnl;
    this.state.completedCycles++;

    // Update average hold duration
    const prevTotal = this.state.avgHoldDurationSecs * (this.state.completedCycles - 1);
    this.state.avgHoldDurationSecs = (prevTotal + holdDurationSecs) / this.state.completedCycles;

    // Build trade record
    const record: DeltaNeutralTradeRecord = {
      id: randomUUID(),
      botId: this.id,
      timestamp: new Date().toISOString(),
      exchangeA: this.config.exchangeA,
      exchangeB: this.config.exchangeB,
      symbol: this.config.symbol,
      legValueUsd: this.config.legValueUsd,
      primarySide: pos.primaryLeg.side,
      entryPriceA: pos.primaryLeg.entryPrice,
      entryPriceB: pos.hedgeLeg.entryPrice,
      sizeA: pos.primaryLeg.size,
      sizeB: pos.hedgeLeg.size,
      entryTimestamp: pos.entryTimestamp,
      exitPriceA: priceA,
      exitPriceB: priceB,
      exitTimestamp: new Date().toISOString(),
      exitReason: this._exitReason,
      pnlA: pos.primaryLeg.unrealizedPnl,
      pnlB: pos.hedgeLeg.unrealizedPnl,
      combinedPnl,
      netFundingUsd: pos.netFundingUsd,
      totalFeesUsd: 0, // TODO: track fees per cycle
      holdDurationSecs,
      oiHours: pos.oiHoursAccumulated,
      cpmUsd: pos.oiHoursAccumulated > 0
        ? (this.state.sessionFees / (pos.oiHoursAccumulated / 1_000_000))
        : 0,
    };

    // Log trade
    await this.tradeLogger.log(record as any);

    // ── Reporting: record DN trade event ──────────────────────────────────────
    recordTrade({
      botId: this.id,
      botType: 'delta-neutral',
      exchange: this.config.exchangeA,
      symbol: this.config.symbol,
      direction: pos.primaryLeg.side as 'long' | 'short',
      entryPrice: pos.primaryLeg.entryPrice,
      exitPrice: priceA,
      size: pos.primaryLeg.size,
      pnl: combinedPnl,
      fees: (pos.primaryLeg.size * priceA * closeFeeRateA) + (pos.hedgeLeg.size * priceB * closeFeeRateB),
      holdDurationSecs,
      exitReason: this._exitReason,
      exchangeB: this.config.exchangeB,
      pnlA: pos.primaryLeg.unrealizedPnl,
      pnlB: pos.hedgeLeg.unrealizedPnl,
      fundingNet: pos.netFundingUsd,
      oiHours: pos.oiHoursAccumulated,
      walletAddress: this.state.walletAddress || undefined,
    });

    // Store in memory for dashboard PnL History table (keep last 20)
    this._recentTrades.unshift({
      time: new Date().toISOString(),
      holdMins: Math.round(holdDurationSecs / 60),
      pnlA: pos.primaryLeg.unrealizedPnl,
      pnlB: pos.hedgeLeg.unrealizedPnl,
      combined: combinedPnl,
      reason: this._exitReason,
    });
    if (this._recentTrades.length > 20) this._recentTrades.pop();

    // Telegram notification
    const primarySide = pos.primaryLeg.side.charAt(0).toUpperCase() + pos.primaryLeg.side.slice(1);
    const hedgeSide = pos.hedgeLeg.side.charAt(0).toUpperCase() + pos.hedgeLeg.side.slice(1);
    const fmtPnl = (v: number) => (v >= 0 ? '+' : '-') + '$' + Math.abs(v).toFixed(3);
    const msg = `🌾 *DELTA-NEUTRAL* ${this.config.name}\n\n` +
      `PRIMARY ${this.config.exchangeA.toUpperCase()}: Closed ${primarySide} ${fmtPnl(pos.primaryLeg.unrealizedPnl)}\n` +
      `HEDGE ${this.config.exchangeB.toUpperCase()}: Closed ${hedgeSide} ${fmtPnl(pos.hedgeLeg.unrealizedPnl)}\n\n` +
      `Combined: ${fmtPnl(combinedPnl)} | Hold: ${(holdDurationSecs / 60).toFixed(0)}m | Cycles: ${this.state.completedCycles}`;
    await this.telegram.sendMessage(msg).catch((err: any) => {
      console.error(`[DeltaNeutral:${this.id}] Telegram close notification failed:`, err?.message ?? err);
    });

    console.log(`[DeltaNeutral:${this.id}] Cycle complete: held ${(holdDurationSecs / 3600).toFixed(1)}h, PnL=$${combinedPnl.toFixed(3)}, OI-hrs=${pos.oiHoursAccumulated.toFixed(0)}`);
    logEvent(this.id, this.state, 'INFO', `Cycle complete: ${this._exitReason}, PnL=$${combinedPnl.toFixed(3)}`);

    // Clear position and enter cooldown
    this.state.position = null;
    this.state.oiFarmerState = 'COOLDOWN';
    this._cooldownStartMs = Date.now();
    this._lastFundingSnapshot = undefined; // reset for next cycle
  }

  // ── COOLDOWN: Wait before re-entering ─────────────────────────────────────

  private async _tickCooldown(): Promise<void> {
    if (!this._cooldownStartMs) {
      this._cooldownStartMs = Date.now();
    }

    const elapsed = (Date.now() - this._cooldownStartMs) / 1000;
    if (elapsed >= this.config.cooldownSecs) {
      console.log(`[DeltaNeutral:${this.id}] Cooldown complete -- ready for next cycle`);
      this.state.oiFarmerState = 'IDLE';
      this._cooldownStartMs = null;
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  /** Expose trade logger for dashboard trade history endpoints */
  getTradeLogger(): TradeLogger {
    return this.tradeLogger;
  }

  /**
   * Resolve which direction to take on the primary exchange.
   * If config says 'auto', uses funding rate to decide based on net funding optimization.
   *
   * When auto: retries funding rate fetch every 5s up to `fundingFetchTimeoutSecs`
   * (default 30s). Only falls back to 'long' after the timeout is exhausted.
   */
  private async _resolveDirection(): Promise<'long' | 'short' | null> {
    if (this.config.primaryDirection !== 'auto') {
      return this.config.primaryDirection;
    }

    // Auto mode: compare funding rates on both exchanges.
    // Strategy: go LONG on the exchange where shorts pay longs (positive funding = shorts pay).
    // Net: choose direction where we RECEIVE the most (or pay the least) net funding.
    const symbolA = this.config.symbolA || this.config.symbol;
    const symbolB = this.config.symbolB || this.config.symbol;

    const timeoutSecs = this.config.fundingFetchTimeoutSecs ?? 30;
    const retryIntervalMs = 5_000;
    const maxAttempts = Math.max(1, Math.ceil((timeoutSecs * 1000) / retryIntervalMs));

    let fundingA: number | null = null;
    let fundingB: number | null = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const [rateA, rateB] = await Promise.all([
          this.adapterA.get_funding_rate ? this.adapterA.get_funding_rate(symbolA) : Promise.resolve(null),
          this.adapterB.get_funding_rate ? this.adapterB.get_funding_rate(symbolB) : Promise.resolve(null),
        ]);
        fundingA = rateA;
        fundingB = rateB;
      } catch (err) {
        console.warn(`[DeltaNeutral:${this.id}] Auto direction: funding fetch attempt ${attempt}/${maxAttempts} failed:`, err);
      }

      // At least one side has data — we can make a decision
      if (fundingA !== null || fundingB !== null) {
        break;
      }

      // No data yet — retry unless we've exhausted attempts
      if (attempt < maxAttempts) {
        console.log(`[DeltaNeutral:${this.id}] Auto direction: no funding data yet (attempt ${attempt}/${maxAttempts}), retrying in ${retryIntervalMs / 1000}s...`);
        await new Promise((resolve) => setTimeout(resolve, retryIntervalMs));
      }
    }

    // Timeout exhausted — fallback to 'long' with clear warning
    if (fundingA === null && fundingB === null) {
      console.warn(
        `[DeltaNeutral:${this.id}] Auto direction: no funding data after ${maxAttempts} attempts (${timeoutSecs}s timeout). ` +
        `Defaulting to 'long'. Check adapter get_funding_rate() endpoints.`
      );
      return 'long';
    }

    // Funding rate convention: positive = longs pay shorts, negative = shorts pay longs
    // We want to be on the RECEIVING side.
    //
    // For primary exchange A:
    //   - If we go LONG on A: we pay fundingA (if positive) or receive (if negative)
    //   - If we go SHORT on A: we receive fundingA (if positive) or pay (if negative)
    //
    // For hedge exchange B (opposite direction):
    //   - If primary is LONG (A=long, B=short): net funding = -fundingA + fundingB
    //   - If primary is SHORT (A=short, B=long): net funding = fundingA - fundingB
    //
    // Choose direction that maximizes net funding received:
    //   netIfLong = -fundingA + fundingB  (long A, short B)
    //   netIfShort = fundingA - fundingB  (short A, long B)
    //   Note: netIfShort = -netIfLong, so we just check sign of netIfLong

    const fA = fundingA ?? 0;
    const fB = fundingB ?? 0;
    const netIfLong = -fA + fB;  // net funding if we go LONG on primary (A)

    const direction: 'long' | 'short' = netIfLong >= 0 ? 'long' : 'short';
    console.log(`[DeltaNeutral:${this.id}] Auto direction: fundingA=${fA.toFixed(6)}, fundingB=${fB.toFixed(6)}, netIfLong=${netIfLong.toFixed(6)} → ${direction}`);

    return direction;
  }

  /** Cancel all open orders on both exchanges */
  private async _cancelAll(): Promise<void> {
    const symbolA = this.config.symbolA || this.config.symbol;
    const symbolB = this.config.symbolB || this.config.symbol;
    try {
      await Promise.all([
        this.adapterA.cancel_all_orders(symbolA),
        this.adapterB.cancel_all_orders(symbolB),
      ]);
    } catch (err) {
      console.warn(`[DeltaNeutral:${this.id}] Cancel all failed:`, err);
    }
  }
}
