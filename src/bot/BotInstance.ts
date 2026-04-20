import type { ExchangeAdapter } from '../adapters/ExchangeAdapter.js';
import type { TelegramManager } from '../modules/TelegramManager.js';
import { SessionManager } from '../modules/SessionManager.js';
import { Watcher } from '../modules/Watcher.js';
import { TradeLogger } from '../ai/TradeLogger.js';
import type { BotConfig, BotStatus } from './types.js';
import { createBotSharedState, type BotSharedState } from './BotSharedState.js';
import { ConfigStore, type ConfigStoreInterface } from '../config/ConfigStore.js';

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
  }

  private async _initWalletAddress(): Promise<void> {
    // Wallet address is set from config or environment
    // For now, use a placeholder - can be enhanced later
    this.state.walletAddress = this.config.credentialKey || 'N/A';
  }

  /**
   * Start the bot
   * @returns true if started successfully, false if already running
   */
  async start(): Promise<boolean> {
    if (this.state.botStatus === 'RUNNING') {
      console.log(`[BotInstance:${this.id}] Already running`);
      return false;
    }

    // Reset max-loss flag so a previously emergency-stopped bot can restart
    this.sessionManager.resetMaxLoss();

    const success = this.sessionManager.startSession();
    if (!success) {
      console.error(`[BotInstance:${this.id}] SessionManager failed to start`);
      return false;
    }
    
    this.watcher.resetSession();
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
   */
  async stop(): Promise<void> {
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
      efficiencyBps,
      walletAddress: this.state.walletAddress,
      uptime,
      hasPosition: this.state.openPosition !== null,
      openPosition: this.state.openPosition,
      progress,
    };
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
}
