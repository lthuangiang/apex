import type { ExchangeAdapter } from '../adapters/ExchangeAdapter.js';
import type { TelegramManager } from '../modules/TelegramManager.js';
import { SessionManager } from '../modules/SessionManager.js';
import { Watcher } from '../modules/Watcher.js';
import { TradeLogger } from '../ai/TradeLogger.js';
import type { BotConfig, BotStatus } from './types.js';
import { createBotSharedState, type BotSharedState } from './BotSharedState.js';
import { ConfigStore, type ConfigStoreInterface } from '../config/ConfigStore.js';
import { DailyResetScheduler } from './DailyResetScheduler.js';

/**
 * BotInstance - Wrapper managing lifecycle of a single bot
 * 
 * Each instance has:
 * - Isolated state (BotSharedState)
 * - Own Watcher, SessionManager, TradeLogger
 * - Independent lifecycle (start/stop)
 */
export class BotInstance {
  readonly id: string;
  readonly config: BotConfig;
  readonly state: BotSharedState;
  
  private adapter: ExchangeAdapter;
  private watcher: Watcher;
  private sessionManager: SessionManager;
  private tradeLogger: TradeLogger;
  private telegram: TelegramManager;
  private configStore: ConfigStoreInterface;
  private watcherPromise: Promise<void> | null = null;
  private dailyResetScheduler: DailyResetScheduler | null = null;

  constructor(config: BotConfig, adapter: ExchangeAdapter, telegram: TelegramManager) {
    this.id = config.id;
    this.config = config;
    this.state = createBotSharedState(config.id);
    this.adapter = adapter;
    this.telegram = telegram;
    
    // Initialize ConfigStore (no parameters needed)
    this.configStore = new ConfigStore();
    
    // Apply initial config values as overrides if they exist
    const initialOverrides: any = {};
    if (config.mode !== undefined) initialOverrides.MODE = config.mode;
    if (config.orderSizeMin !== undefined) initialOverrides.ORDER_SIZE_MIN = config.orderSizeMin;
    if (config.orderSizeMax !== undefined) initialOverrides.ORDER_SIZE_MAX = config.orderSizeMax;
    if (config.farmMinHoldSecs !== undefined) initialOverrides.FARM_MIN_HOLD_SECS = config.farmMinHoldSecs;
    if (config.farmMaxHoldSecs !== undefined) initialOverrides.FARM_MAX_HOLD_SECS = config.farmMaxHoldSecs;
    if (config.farmTpUsd !== undefined) initialOverrides.FARM_TP_USD = config.farmTpUsd;
    if (config.farmSlPercent !== undefined) initialOverrides.FARM_SL_PERCENT = config.farmSlPercent;
    if (config.farmScoreEdge !== undefined) initialOverrides.FARM_SCORE_EDGE = config.farmScoreEdge;
    if (config.farmMinConfidence !== undefined) initialOverrides.FARM_MIN_CONFIDENCE = config.farmMinConfidence;
    if (config.farmEarlyExitSecs !== undefined) initialOverrides.FARM_EARLY_EXIT_SECS = config.farmEarlyExitSecs;
    if (config.farmEarlyExitPnl !== undefined) initialOverrides.FARM_EARLY_EXIT_PNL = config.farmEarlyExitPnl;
    if (config.farmExtraWaitSecs !== undefined) initialOverrides.FARM_EXTRA_WAIT_SECS = config.farmExtraWaitSecs;
    if (config.farmBlockedHours !== undefined) {
      // farmBlockedHours is stored as a JSON string in BotConfig — parse it to number[]
      try {
        const parsed = typeof config.farmBlockedHours === 'string'
          ? JSON.parse(config.farmBlockedHours)
          : config.farmBlockedHours;
        if (Array.isArray(parsed)) initialOverrides.FARM_BLOCKED_HOURS = parsed;
      } catch { /* ignore malformed value */ }
    }
    if (config.farmCooldownSecs !== undefined) initialOverrides.FARM_COOLDOWN_SECS = config.farmCooldownSecs;
    if (config.tradeTpPercent !== undefined) initialOverrides.TRADE_TP_PERCENT = config.tradeTpPercent;
    if (config.tradeSlPercent !== undefined) initialOverrides.TRADE_SL_PERCENT = config.tradeSlPercent;
    if (config.cooldownMinMins !== undefined) initialOverrides.COOLDOWN_MIN_MINS = config.cooldownMinMins;
    if (config.cooldownMaxMins !== undefined) initialOverrides.COOLDOWN_MAX_MINS = config.cooldownMaxMins;
    if (config.minPositionValueUsd !== undefined) initialOverrides.MIN_POSITION_VALUE_USD = config.minPositionValueUsd;
    
    if (Object.keys(initialOverrides).length > 0) {
      this.configStore.applyOverrides(initialOverrides);
    }
    
    // Initialize components with bot-specific config
    this.sessionManager = new SessionManager();
    this.tradeLogger = new TradeLogger(config.tradeLogBackend, config.tradeLogPath);
    this.watcher = new Watcher(adapter, this.config.symbol, telegram, this.sessionManager, this.state, this.configStore, this.tradeLogger);
    
    // Set symbol in state
    this.state.symbol = config.symbol;
    
    // Get wallet address from adapter
    this._initWalletAddress().catch(err => {
      console.error(`[BotInstance:${this.id}] Failed to get wallet address:`, err);
    });

    // ── Daily Budget Reset Scheduler ─────────────────────────────────────────
    if (config.dailyBudgetReset) {
      const maxLossUsd = config.dailyMaxLossUsd ?? 5;
      const resetHourUTC = config.dailyResetHourUTC ?? 0;
      const targetVolumeUsd = config.dailyTargetVolumeUsd ?? 0;

      // Apply initial limits from daily budget config
      this.sessionManager.setMaxLoss(maxLossUsd);
      this.sessionManager.setTargetVolume(targetVolumeUsd);

      this.dailyResetScheduler = new DailyResetScheduler(
        this,
        { resetHourUTC, maxLossUsd, targetVolumeUsd },
        async (botId) => {
          const vietnamHour = (resetHourUTC + 7) % 24;
          const lines = [
            `🔄 *Daily Budget Reset* — Bot \`${botId}\``,
            `💰 Max Loss: \`$${maxLossUsd}\``,
          ];
          if (targetVolumeUsd > 0) {
            lines.push(`📊 Volume Target: \`$${targetVolumeUsd.toLocaleString()}\``);
          }
          lines.push(
            `🕐 Reset at: \`${resetHourUTC}:00 UTC\` (${vietnamHour}:00 Vietnam)`,
            `🚀 Bot auto-restarted with fresh budget`,
          );
          await telegram.sendMessage(lines.join('\n'), true)
            .catch(() => {/* ignore telegram errors */});
        },
      );
      this.dailyResetScheduler.start();
    }
  }

  private async _initWalletAddress(): Promise<void> {
    // Wallet address is set from config or environment
    // For now, use a placeholder - can be enhanced later
    this.state.walletAddress = this.config.credentialKey || 'N/A';
  }

  /**
   * Start the bot
   * @param freshSession - If true (default), clears session PnL/volume/balance so the
   *   new session starts from zero.  Pass false only when recovering from a crash where
   *   you want to continue the previous session's accumulated stats.
   * @returns true if started successfully, false if already running
   */
  async start(freshSession = true): Promise<boolean> {
    if (this.state.botStatus === 'RUNNING') {
      console.log(`[BotInstance:${this.id}] Already running`);
      return false;
    }

    // Reset max-loss flag so a previously emergency-stopped bot can restart
    this.sessionManager.resetMaxLoss();
    // Also reset volume-target flag so a volume-stopped bot can restart
    this.sessionManager.resetVolumeTarget();

    const success = this.sessionManager.startSession();
    if (!success) {
      console.error(`[BotInstance:${this.id}] SessionManager failed to start`);
      return false;
    }

    if (freshSession) {
      // Fresh start: wipe session PnL, volume, fees and start balance so the
      // new session is not poisoned by the previous session's losses.
      this.state.sessionPnl = 0;
      this.state.sessionGrossPnl = 0;
      this.state.sessionVolume = 0;
      this.state.sessionFees = 0;
      this.state.sessionStartBalance = null;

      // Persist the zeroed state immediately so that any debounced saveState()
      // calls from the previous session don't overwrite the fresh zeros, and so
      // restoreSessionFromPersistence() below reads zeros from disk.
      const { saveStateSync } = await import('../ai/StateStore.js');
      saveStateSync(this.state);
    } else {
      // Crash-recovery: load persisted state so accumulated stats are preserved.
      const { loadState } = await import('../ai/StateStore.js');
      loadState(this.state);
    }

    // Reset session state machine and sync Watcher's in-memory fields from state.
    // For a fresh session sessionStartBalance is null so Watcher will capture the
    // current balance on the very first tick — giving a correct PnL baseline.
    this.watcher.resetSession();
    this.watcher.restoreSessionFromPersistence();

    this.state.botStatus = 'RUNNING';
    this.state.updatedAt = new Date().toISOString();
    
    console.log(`✅ [BotInstance:${this.id}] Started`);
    
    // Run watcher in background, catch crash
    this.watcherPromise = this.watcher.run().catch(err => {
      console.error(`[BotInstance:${this.id}] Watcher crashed:`, err);
      this.sessionManager.stopSession();
      this.state.botStatus = 'STOPPED';
      this.state.updatedAt = new Date().toISOString();
    });
    
    return true;
  }

  /**
   * Stop the bot
   * Does not force-close open positions
   * @param stopScheduler - If true, also stops the daily reset scheduler (default: false)
   */
  async stop(stopScheduler = false): Promise<void> {
    console.log(`[BotInstance:${this.id}] Stopping...`);
    
    this.sessionManager.stopSession();
    this.watcher.stop();
    this.state.botStatus = 'STOPPED';
    this.state.updatedAt = new Date().toISOString();
    
    // Wait for watcher to finish if it's running
    if (this.watcherPromise) {
      await this.watcherPromise.catch(() => {
        // Ignore errors - already handled in start()
      });
      this.watcherPromise = null;
    }
    
    // Save state to disk before shutdown (multi-bot mode)
    const { saveStateSync } = await import('../ai/StateStore.js');
    saveStateSync(this.state);

    // Stop daily reset scheduler only if explicitly requested (e.g. full shutdown)
    if (stopScheduler && this.dailyResetScheduler) {
      this.dailyResetScheduler.stop();
    }
    
    console.log(`✅ [BotInstance:${this.id}] Stopped`);
  }

  /**
   * Get current bot status for API/dashboard
   */
  getStatus(): BotStatus {
    const session = this.sessionManager.getState();
    const uptime = session.startTime ? Math.floor((Date.now() - session.startTime) / 60000) : 0;
    
    const efficiencyBps = this.state.sessionVolume > 0 
      ? (this.state.sessionPnl / this.state.sessionVolume) * 10000 
      : 0;
    
    const progress = session.maxLoss > 0
      ? Math.min(100, Math.abs(this.state.sessionPnl) / session.maxLoss * 100)
      : 0;

    return {
      id: this.id,
      name: this.config.name,
      exchange: this.config.exchange,
      status: this.state.botStatus === 'RUNNING' ? 'active' : 'inactive',
      symbol: this.config.symbol,
      tags: this.config.tags,
      sessionPnl: this.state.sessionPnl,
      sessionVolume: this.state.sessionVolume,
      sessionFees: this.state.sessionFees,
      sessionStartBalance: this.state.sessionStartBalance,
      currentBalance: this.state.currentBalance,
      efficiencyBps,
      walletAddress: this.state.walletAddress,
      uptime,
      hasPosition: this.state.openPosition !== null,
      openPosition: this.state.openPosition,
      progress,
    };
  }

  /**
   * Execute one tick of the bot's Watcher logic.
   * Used by BacktestRunner to drive the bot over historical candles.
   *
   * Safe to call regardless of botStatus — does NOT throw a state-guard error
   * when the bot is STOPPED. Timing control is delegated to the caller.
   *
   * Requirements: 11.2, 11.3, 11.4, 11.5
   */
  async tickOnce(): Promise<void> {
    await this.watcher.tickOnce();
  }

  /**
   * Force close any open position
   * @returns true if close order was placed successfully
   */
  async forceClosePosition(): Promise<boolean> {
    return this.watcher.forceClosePosition();
  }

  // Accessors for components (used by tests and advanced features)
  getTradeLogger(): TradeLogger {
    return this.tradeLogger;
  }

  getSessionManager(): SessionManager {
    return this.sessionManager;
  }

  getWatcher(): Watcher {
    return this.watcher;
  }

  getConfigStore(): ConfigStoreInterface {
    return this.configStore;
  }

  /**
   * Clear all session-level stats from the shared state and persist to disk.
   * Called by DailyResetScheduler before bot.start() so the new session
   * begins with zero volume, zero PnL, and a fresh start balance.
   */
  async clearSessionState(): Promise<void> {
    this.state.sessionPnl = 0;
    this.state.sessionGrossPnl = 0;
    this.state.sessionVolume = 0;
    this.state.sessionFees = 0;
    this.state.sessionStartBalance = null;
    // Keep pnlHistory / volumeHistory / eventLog — they are cumulative across sessions
    console.log(`[BotInstance:${this.id}] Session state cleared for daily reset`);

    // Persist the cleared state so loadState() in the subsequent start() picks up zeros.
    const { saveStateSync } = await import('../ai/StateStore.js');
    saveStateSync(this.state);
  }

  /**
   * Sync the DailyResetScheduler with the current bot.config.
   * Call this after updating dailyBudgetReset / dailyMaxLossUsd / dailyResetHourUTC / dailyTargetVolumeUsd
   * at runtime (e.g. from the dashboard PATCH endpoint).
   *
   * - If dailyBudgetReset is now true and no scheduler exists → create + start one
   * - If dailyBudgetReset is now true and scheduler exists → stop old, create + start new (picks up new config)
   * - If dailyBudgetReset is now false → stop and remove scheduler
   */
  syncDailyResetScheduler(): void {
    // Stop existing scheduler regardless
    if (this.dailyResetScheduler) {
      this.dailyResetScheduler.stop();
      this.dailyResetScheduler = null;
    }

    if (!this.config.dailyBudgetReset) return;

    const maxLossUsd = this.config.dailyMaxLossUsd ?? 5;
    const resetHourUTC = this.config.dailyResetHourUTC ?? 0;
    const targetVolumeUsd = this.config.dailyTargetVolumeUsd ?? 0;

    this.dailyResetScheduler = new DailyResetScheduler(
      this,
      { resetHourUTC, maxLossUsd, targetVolumeUsd },
      async (botId) => {
        const vietnamHour = (resetHourUTC + 7) % 24;
        const lines = [
          `🔄 *Daily Budget Reset* — Bot \`${botId}\``,
          `💰 Max Loss: \`$${maxLossUsd}\``,
        ];
        if (targetVolumeUsd > 0) {
          lines.push(`📊 Volume Target: \`$${targetVolumeUsd.toLocaleString()}\``);
        }
        lines.push(
          `🕐 Reset at: \`${resetHourUTC}:00 UTC\` (${vietnamHour}:00 Vietnam)`,
          `🚀 Bot auto-restarted with fresh budget`,
        );
        await this.telegram.sendMessage(lines.join('\n'), true)
          .catch(() => {/* ignore telegram errors */});
      },
    );
    this.dailyResetScheduler.start();
  }
}
