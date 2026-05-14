/**
 * BacktestRunner — Backtest Orchestration Engine
 *
 * Drives the full backtest lifecycle:
 *   1. Load klines via HistoricalDataFeed
 *   2. Instantiate BacktestAdapter
 *   3. Instantiate and start the bot (HedgeBot or BotInstance)
 *   4. Tick loop: advance clock → bot.tickOnce() → record metrics
 *   5. Emit progress via onProgress callback
 *   6. Respect speedMultiplier for paced replay
 *   7. Handle abort, data gaps, and per-tick errors gracefully
 *   8. Finalize metrics and return BacktestResult
 *
 * Requirements: 4.1–4.11, 9.1–9.6, 10.1–10.5
 */

import { randomUUID } from 'crypto';
import type { Kline } from '../adapters/ExchangeAdapter.js';
import type {
  BacktestRunConfig,
  BacktestResult,
  BacktestProgress,
  BalanceSnapshot,
} from './types.js';
import { NoDataError } from './types.js';
import { BacktestAdapter } from './BacktestAdapter.js';
import { BacktestMetricsCollector } from './BacktestMetricsCollector.js';
import { HistoricalDataFeed } from './HistoricalDataFeed.js';

// ---------------------------------------------------------------------------
// Interval → milliseconds mapping (Requirement 4.6)
// ---------------------------------------------------------------------------

const INTERVAL_MS: Record<string, number> = {
  '1m':  60_000,
  '5m':  300_000,
  '15m': 900_000,
  '1h':  3_600_000,
  '4h':  14_400_000,
  '1d':  86_400_000,
};

// ---------------------------------------------------------------------------
// Duck-typed interface for bot instances (HedgeBot or BotInstance)
// tickOnce() will be added by tasks 6.1 and 6.2.
// ---------------------------------------------------------------------------

interface BotLike {
  start(...args: unknown[]): Promise<unknown>;
  stop(...args: unknown[]): Promise<void>;
  tickOnce(): Promise<void>;
}

// ---------------------------------------------------------------------------
// BacktestRunner
// ---------------------------------------------------------------------------

export class BacktestRunner {
  private readonly runId: string;
  private readonly config: BacktestRunConfig;
  private readonly dataFeed: HistoricalDataFeed;
  private readonly onProgress?: (p: BacktestProgress) => void;

  /** Set to true by abort() — loop exits after the current candle. */
  private _aborted: boolean = false;

  /** Tracks the final result status for the abort case. */
  private _status: 'completed' | 'aborted' | 'error' = 'completed';

  constructor(
    config: BacktestRunConfig,
    dataFeed: HistoricalDataFeed,
    onProgress?: (p: BacktestProgress) => void,
  ) {
    this.runId = randomUUID();
    this.config = config;
    this.dataFeed = dataFeed;
    this.onProgress = onProgress;
  }

  // =========================================================================
  // Public API
  // =========================================================================

  /**
   * Run the full backtest.
   *
   * Returns a BacktestResult with:
   *   - status: 'completed' on normal finish
   *   - status: 'aborted'   when abort() was called
   *   - status: 'error'     on fatal init failure (no data, bot init failure)
   *
   * Requirements: 4.1–4.11, 9.1–9.6, 10.1–10.5
   */
  async run(): Promise<BacktestResult> {
    const startedAt = new Date().toISOString();
    const startMs = Date.now();

    // ---- Step 1: Load klines (Req 4.1, 4.2, 9.1) --------------------------
    let klines: Kline[];
    try {
      klines = await this.dataFeed.loadKlines(
        this._getSymbol(),
        this.config.interval,
        new Date(this.config.from),
        new Date(this.config.to),
      );
    } catch (err) {
      const message =
        err instanceof NoDataError
          ? err.message
          : `Failed to load historical data: ${String(err)}`;
      return this._errorResult(startedAt, startMs, message);
    }

    // Req 4.2, 9.1 — empty array → error result
    if (klines.length === 0) {
      return this._errorResult(
        startedAt,
        startMs,
        'No historical data for the requested symbol and date range',
      );
    }

    // ---- Step 2: Instantiate BacktestAdapter (Req 4.1) --------------------
    const adapterConfig = {
      makerFeeBps: this.config.makerFeeBps,
      takerFeeBps: this.config.takerFeeBps,
      slippageBps: this.config.slippageBps,
      fillMode: this.config.fillMode ?? 'realistic',
    };

    const klinesMap = new Map<string, Kline[]>([[this._getSymbol(), klines]]);
    let adapter: BacktestAdapter;
    try {
      adapter = new BacktestAdapter(klinesMap, this.config.initialBalance, adapterConfig);
    } catch (err) {
      return this._errorResult(
        startedAt,
        startMs,
        `BacktestAdapter initialization failed: ${String(err)}`,
      );
    }

    // ---- Step 3: Instantiate bot (Req 4.1, 9.6) ---------------------------
    let bot: BotLike;
    try {
      bot = await this._createBot(adapter);
    } catch (err) {
      return this._errorResult(
        startedAt,
        startMs,
        `Bot instantiation failed: ${String(err)}`,
      );
    }

    // ---- Step 4: Start bot (Req 4.1) --------------------------------------
    try {
      await bot.start();
    } catch (err) {
      return this._errorResult(
        startedAt,
        startMs,
        `Bot start() failed: ${String(err)}`,
      );
    }

    // ---- Step 5–11: Tick loop ---------------------------------------------
    const metrics = new BacktestMetricsCollector(this.runId, this.config);
    const errors: Array<{ candleTimestamp: string; message: string }> = [];
    const intervalMs = INTERVAL_MS[this.config.interval] ?? INTERVAL_MS['1h'];
    const speedMultiplier = this.config.speedMultiplier ?? 0;
    const symbol = this._getSymbol();
    const total = klines.length;

    // Data gap detection state (Req 9.2, 9.3)
    let gapCount = 0;
    let prevCandleTimestamp: number | null = null;

    // Peak equity tracking for drawdown in snapshots (Req 4.4)
    let peakEquity = this.config.initialBalance;

    for (let i = 0; i < klines.length; i++) {
      // Abort check (Req 4.7)
      if (this._aborted) {
        this._status = 'aborted';
        break;
      }

      const candle = klines[i];

      // ---- Req 9.2: Detect data gaps ------------------------------------
      if (prevCandleTimestamp !== null) {
        const diff = candle.t - prevCandleTimestamp;
        const gapThreshold = intervalMs * 1.5;
        if (diff > gapThreshold) {
          gapCount++;
          const gapStart = new Date(prevCandleTimestamp).toISOString();
          const gapEnd = new Date(candle.t).toISOString();
          console.warn(
            `[BacktestRunner:${this.runId}] Data gap detected between ${gapStart} and ${gapEnd} ` +
            `(diff=${diff}ms, expected≤${gapThreshold}ms) — skipping gap`,
          );
        }
      }
      prevCandleTimestamp = candle.t;

      // ---- Req 4.3: Advance adapter clock --------------------------------
      adapter.advanceTo(candle, symbol);

      // ---- Req 4.3: Bot tick (Req 4.9 — catch errors, skip candle) -------
      try {
        await bot.tickOnce();
      } catch (err) {
        const candleTimestamp = new Date(candle.t).toISOString();
        const message = err instanceof Error ? err.message : String(err);
        console.error(
          `[BacktestRunner:${this.runId}] Bot tick error at ${candleTimestamp}: ${message}`,
        );
        errors.push({ candleTimestamp, message });
        // Continue loop — do not abort (Req 4.9)
      }

      // ---- Req 4.4: Record BalanceSnapshot --------------------------------
      const balance = await adapter.get_balance();
      const position = await adapter.get_position(symbol);
      const unrealizedPnl = position?.unrealizedPnl ?? 0;
      const equity = balance + unrealizedPnl;

      if (equity > peakEquity) {
        peakEquity = equity;
      }
      const drawdown = Math.max(0, peakEquity - equity);

      const snapshot: BalanceSnapshot = {
        timestamp: new Date(candle.t).toISOString(),
        balance,
        equity,
        drawdown,
      };
      metrics.recordTick(snapshot);

      // ---- Req 4.5, 4.6: Speed control -----------------------------------
      // speedMultiplier === 0 → no delay (max speed)
      // speedMultiplier > 0  → delay = candleIntervalMs / speedMultiplier
      if (speedMultiplier > 0) {
        const delayMs = intervalMs / speedMultiplier;
        await this._sleep(delayMs);
      }

      // ---- Req 4.5, 6.7: Emit progress -----------------------------------
      if (this.onProgress) {
        const progress: BacktestProgress = {
          runId: this.runId,
          processed: i + 1,
          total,
          currentBalance: balance,
          currentEquity: equity,
          percentComplete: ((i + 1) / total) * 100,
        };
        this.onProgress(progress);
      }
    }

    // ---- Step 11: Stop bot (Req 4.8) -------------------------------------
    try {
      await bot.stop();
    } catch (err) {
      console.warn(`[BacktestRunner:${this.runId}] bot.stop() threw:`, err);
    }

    // ---- Finalize metrics (Req 4.8, 4.10, 4.11) -------------------------
    const result = metrics.finalize();
    const completedAt = new Date().toISOString();
    const durationMs = Date.now() - startMs;

    // Determine final status
    const finalStatus = this._aborted ? 'aborted' : 'completed';

    // Req 9.3 — include dataQuality if gap count is significant
    const totalExpectedCandles = Math.ceil(
      (new Date(this.config.to).getTime() - new Date(this.config.from).getTime()) / intervalMs,
    );
    const gapThresholdCount = totalExpectedCandles * 0.1;
    const dataQuality =
      gapCount > gapThresholdCount ? { gapCount } : undefined;

    return {
      ...result,
      runId: this.runId,
      status: finalStatus,
      config: this.config,
      startedAt,
      completedAt,
      candlesProcessed: result.equityCurve.length,
      durationMs,
      ...(errors.length > 0 ? { errors } : {}),
      ...(dataQuality ? { dataQuality } : {}),
    };
  }

  /**
   * Signal the runner to abort after the current candle completes.
   * The result will have `status: 'aborted'` with partial metrics.
   *
   * Requirement 4.7, 4.10
   */
  abort(): void {
    this._aborted = true;
  }

  // =========================================================================
  // Private helpers
  // =========================================================================

  /**
   * Determine the primary symbol for this backtest run.
   *
   * Looks up the bot config by `botId` to find the symbol.
   * Falls back to a symbol in `botConfig` if provided inline.
   * If neither is available, defaults to 'BTC-USD'.
   */
  private _getSymbol(): string {
    // If botConfig has a symbol field, use it
    if (this.config.botConfig) {
      const bc = this.config.botConfig as Record<string, unknown>;
      if (typeof bc['symbol'] === 'string') return bc['symbol'];
      if (typeof bc['symbolA'] === 'string') return bc['symbolA'];
    }

    // Try to load from bot-configs.json at runtime
    try {
      // Dynamic require to avoid circular deps and keep this file self-contained
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const fs = require('fs') as typeof import('fs');
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const path = require('path') as typeof import('path');
      const configPath = path.resolve(process.cwd(), 'bot-configs.json');
      if (fs.existsSync(configPath)) {
        const raw = fs.readFileSync(configPath, 'utf-8');
        const parsed = JSON.parse(raw) as { bots: Array<Record<string, unknown>> };
        const found = parsed.bots.find((b) => b['id'] === this.config.botId);
        if (found) {
          if (typeof found['symbol'] === 'string') return found['symbol'];
          if (typeof found['symbolA'] === 'string') return found['symbolA'];
        }
      }
    } catch {
      // Non-fatal — fall through to default
    }

    return 'BTC-USD';
  }

  /**
   * Instantiate the appropriate bot class based on `config.botId` / `config.botConfig`.
   *
   * Supports:
   *   - `botType: 'hedge'` → HedgeBot
   *   - everything else   → BotInstance
   *
   * Both classes will have `tickOnce()` added by tasks 6.1 and 6.2.
   * We cast to `BotLike` to avoid compile-time errors until those tasks are done.
   *
   * Requirements: 4.1, 9.6
   */
  private async _createBot(adapter: BacktestAdapter): Promise<BotLike> {
    // Resolve the raw bot config record
    let rawConfig: Record<string, unknown> | null = null;

    if (this.config.botConfig) {
      rawConfig = this.config.botConfig as Record<string, unknown>;
    } else {
      // Load from bot-configs.json
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const fs = require('fs') as typeof import('fs');
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const path = require('path') as typeof import('path');
        const configPath = path.resolve(process.cwd(), 'bot-configs.json');
        if (fs.existsSync(configPath)) {
          const raw = fs.readFileSync(configPath, 'utf-8');
          const parsed = JSON.parse(raw) as { bots: Array<Record<string, unknown>> };
          const found = parsed.bots.find((b) => b['id'] === this.config.botId);
          if (found) {
            rawConfig = found;
          }
        }
      } catch (err) {
        throw new Error(`Failed to load bot-configs.json: ${String(err)}`);
      }
    }

    if (!rawConfig) {
      throw new Error(
        `Bot config not found for botId="${this.config.botId}". ` +
        `Ensure the bot exists in bot-configs.json or provide botConfig inline.`,
      );
    }

    const isHedgeBot = rawConfig['botType'] === 'hedge';

    // Create a no-op Telegram stub so bots don't need real credentials in backtest
    const telegramStub = this._createTelegramStub();

    if (isHedgeBot) {
      // Dynamically import HedgeBot to avoid circular dependency issues
      const { HedgeBot } = await import('../bot/HedgeBot.js');
      const hedgeConfig = rawConfig as unknown as import('../bot/types.js').HedgeBotConfig;
      return new HedgeBot(hedgeConfig, adapter, telegramStub) as unknown as BotLike;
    } else {
      // BotInstance (farm / trade mode)
      const { BotInstance } = await import('../bot/BotInstance.js');
      const botConfig = rawConfig as unknown as import('../bot/types.js').BotConfig;
      return new BotInstance(botConfig, adapter, telegramStub) as unknown as BotLike;
    }
  }

  /**
   * Create a no-op TelegramManager stub for backtest mode.
   * Bots call telegram.sendMessage() internally — we silence those in backtest.
   */
  private _createTelegramStub(): import('../modules/TelegramManager.js').TelegramManager {
    return {
      sendMessage: async () => {},
      sendAlert: async () => {},
      isEnabled: () => false,
    } as unknown as import('../modules/TelegramManager.js').TelegramManager;
  }

  /**
   * Build an error BacktestResult for fatal initialization failures.
   *
   * Requirements: 4.2, 9.1, 9.6
   */
  private _errorResult(
    startedAt: string,
    startMs: number,
    error: string,
  ): BacktestResult {
    const completedAt = new Date().toISOString();
    const durationMs = Date.now() - startMs;

    const zeroMetrics = {
      totalPnl: 0,
      totalPnlPercent: 0,
      winRate: 0,
      totalTrades: 0,
      winningTrades: 0,
      losingTrades: 0,
      maxDrawdown: 0,
      maxDrawdownPercent: 0,
      sharpeRatio: 0,
      profitFactor: 0,
      avgTradeReturn: 0,
      avgHoldingPeriodSecs: 0,
      totalFeesPaid: 0,
      totalVolume: 0,
    };

    return {
      runId: this.runId,
      status: 'error',
      config: this.config,
      metrics: zeroMetrics,
      equityCurve: [],
      trades: [],
      startedAt,
      completedAt,
      candlesProcessed: 0,
      durationMs,
      error,
    };
  }

  /**
   * Promise-based sleep helper.
   * Used for speed-controlled replay (Req 4.6).
   */
  private _sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
