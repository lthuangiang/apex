import fs from 'fs';
import type { BotManager } from './BotManager.js';
import type { BotConfig, HedgeBotConfig } from './types.js';
import { BotInstance } from './BotInstance.js';

/**
 * Save all bot configs (including runtime overrides) back to bot-configs.json.
 * Handles both BotInstance (standard) and HedgeBot entries in the registry.
 *
 * @param manager - BotManager instance
 * @param filePath - Path to bot-configs.json
 */
export function saveBotConfigsToFile(manager: BotManager, filePath: string): void {
  const configs: (BotConfig | HedgeBotConfig)[] = manager.getAllBots().map(bot => {
    // HedgeBot: no ConfigStore, persist the config as-is
    if (!(bot instanceof BotInstance)) {
      return bot.config as HedgeBotConfig;
    }

    // Standard BotInstance: merge effective ConfigStore values back in
    const baseConfig = bot.config;
    const configStore = bot.getConfigStore();

    if (!configStore) {
      return baseConfig;
    }

    const effective = configStore.getEffective();

    return {
      ...baseConfig,
      orderSizeMin: effective.ORDER_SIZE_MIN,
      orderSizeMax: effective.ORDER_SIZE_MAX,
      farmMinHoldSecs: effective.FARM_MIN_HOLD_SECS,
      farmMaxHoldSecs: effective.FARM_MAX_HOLD_SECS,
      farmTpUsd: effective.FARM_TP_USD,
      farmSlPercent: effective.FARM_SL_PERCENT,
      farmScoreEdge: effective.FARM_SCORE_EDGE,
      farmMinConfidence: effective.FARM_MIN_CONFIDENCE,
      farmEarlyExitSecs: effective.FARM_EARLY_EXIT_SECS,
      farmEarlyExitPnl: effective.FARM_EARLY_EXIT_PNL,
      farmExtraWaitSecs: effective.FARM_EXTRA_WAIT_SECS,
      farmBlockedHours: typeof effective.FARM_BLOCKED_HOURS === 'string'
        ? effective.FARM_BLOCKED_HOURS
        : JSON.stringify(effective.FARM_BLOCKED_HOURS),
      farmCooldownSecs: effective.FARM_COOLDOWN_SECS,
      tradeTpPercent: effective.TRADE_TP_PERCENT,
      tradeSlPercent: effective.TRADE_SL_PERCENT,
      cooldownMinMins: effective.COOLDOWN_MIN_MINS,
      cooldownMaxMins: effective.COOLDOWN_MAX_MINS,
      minPositionValueUsd: effective.MIN_POSITION_VALUE_USD,
    } as BotConfig;
  });

  const data = {
    version: 1,
    bots: configs,
  };

  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
  console.log(`[BotManager] Saved ${configs.length} bot config(s) to ${filePath}`);
}
