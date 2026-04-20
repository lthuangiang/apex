import type { ExchangeAdapter } from '../adapters/ExchangeAdapter.js';
import type { TelegramManager } from '../modules/TelegramManager.js';
import { BotInstance } from './BotInstance.js';
import { HedgeBot } from './HedgeBot.js';
import type { BotConfig, HedgeBotConfig, AggregatedStats } from './types.js';

/**
 * BotManager - Registry for managing multiple bot instances
 * 
 * Responsibilities:
 * - Create and remove bot instances
 * - Start/stop bots by ID
 * - Provide aggregated statistics
 * - Maintain bot registry (Map<botId, BotInstance | HedgeBot>)
 */
export class BotManager {
  private registry = new Map<string, BotInstance | HedgeBot>();

  /**
   * Create a new bot instance and add to registry
   * @throws Error if bot with same ID already exists
   */
  createBot(config: BotConfig, adapter: ExchangeAdapter, telegram: TelegramManager): BotInstance {
    if (this.registry.has(config.id)) {
      throw new Error(`Bot with id "${config.id}" already exists`);
    }
    
    const instance = new BotInstance(config, adapter, telegram);
    this.registry.set(config.id, instance);
    
    console.log(`[BotManager] Created bot: ${config.id} (${config.name})`);
    return instance;
  }

  /**
   * Remove a bot from registry
   * @throws Error if bot is currently running
   */
  removeBot(id: string): void {
    const bot = this.registry.get(id);
    if (!bot) {
      console.warn(`[BotManager] Bot "${id}" not found for removal`);
      return;
    }
    
    if (bot.state.botStatus === 'RUNNING') {
      throw new Error(`Cannot remove running bot "${id}". Stop it first.`);
    }
    
    this.registry.delete(id);
    console.log(`[BotManager] Removed bot: ${id}`);
  }

  /**
   * Create a new HedgeBot instance and add to registry
   * @throws Error if bot with same ID already exists
   */
  createHedgeBot(config: HedgeBotConfig, adapter: ExchangeAdapter, telegram: TelegramManager): HedgeBot {
    if (this.registry.has(config.id)) {
      throw new Error(`Bot with id "${config.id}" already exists`);
    }

    const instance = new HedgeBot(config, adapter, telegram);
    this.registry.set(config.id, instance);

    console.log(`[BotManager] Created HedgeBot: ${config.id} (${config.name})`);
    return instance;
  }

  /**
   * Get a bot instance by ID
   */
  getBot(id: string): BotInstance | HedgeBot | undefined {
    return this.registry.get(id);
  }

  /**
   * Get all bot instances
   */
  getAllBots(): (BotInstance | HedgeBot)[] {
    return Array.from(this.registry.values());
  }

  /**
   * Start a bot by ID
   * @throws Error if bot not found
   */
  async startBot(id: string): Promise<boolean> {
    const bot = this.getBot(id);
    if (!bot) {
      throw new Error(`Bot "${id}" not found`);
    }
    return bot.start();
  }

  /**
   * Stop a bot by ID
   * @throws Error if bot not found
   */
  async stopBot(id: string): Promise<void> {
    const bot = this.getBot(id);
    if (!bot) {
      throw new Error(`Bot "${id}" not found`);
    }
    await bot.stop();
  }

  /**
   * Get aggregated statistics across all bots
   */
  getAggregatedStats(): AggregatedStats {
    let totalVolume = 0;
    let activeBotCount = 0;
    let totalFees = 0;
    let totalPnl = 0;

    for (const bot of this.registry.values()) {
      totalVolume += bot.state.sessionVolume;
      totalFees += bot.state.sessionFees;
      totalPnl += bot.state.sessionPnl;
      
      if (bot.state.botStatus === 'RUNNING') {
        activeBotCount++;
      }
    }

    return {
      totalVolume,
      activeBotCount,
      totalFees,
      totalPnl,
    };
  }

  /**
   * Get total number of bots in registry
   */
  getBotCount(): number {
    return this.registry.size;
  }
}
