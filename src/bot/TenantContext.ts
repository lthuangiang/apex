import path from 'path';
import type { TelegramManager } from '../modules/TelegramManager.js';
import { BotManager } from './BotManager.js';
import { TenantConfigStore } from './TenantConfigStore.js';
import { CredentialStore } from './CredentialStore.js';
import { createAdapterFromCredentials, createAdapter } from './adapterFactory.js';
import type { BotConfig, HedgeBotConfig } from './types.js';

/**
 * TenantContext — encapsulates all resources owned by a single wallet tenant.
 *
 * Owns the BotManager, config persistence, credential storage, and data
 * directory for one wallet. All file paths are scoped to `./data/{walletAddress}/`.
 *
 * Requirements: 3.1, 3.7, 5.2, 5.8
 */
export class TenantContext {
  /** Normalized lowercase wallet address */
  readonly walletAddress: string;

  /** Absolute path to the tenant's data directory: `./data/{walletAddress}/` */
  readonly dataDir: string;

  /** Bot registry for this tenant — never shared with other tenants */
  readonly botManager: BotManager;

  /** Config persistence for this tenant */
  readonly configStore: TenantConfigStore;

  /** Encrypted credential storage for this tenant */
  readonly credentialStore: CredentialStore;

  constructor({
    walletAddress,
    dataDir,
    botManager,
    configStore,
    credentialStore,
  }: {
    walletAddress: string;
    dataDir: string;
    botManager: BotManager;
    configStore: TenantConfigStore;
    credentialStore?: CredentialStore;
  }) {
    // Requirement 2.9: normalize wallet address to lowercase
    this.walletAddress = walletAddress.toLowerCase();
    this.dataDir = dataDir;
    this.botManager = botManager;
    this.configStore = configStore;
    this.credentialStore = credentialStore ?? new CredentialStore(dataDir);
  }

  /**
   * Persist current bot configs to disk.
   *
   * Collects configs from all bots in the BotManager and writes them via
   * TenantConfigStore (which handles atomic write + path sanitization).
   * Credentials are NOT included in bot-configs.json — they live in
   * the separate encrypted credentials store.
   *
   * Requirement 5.8, 6.1, 6.2
   */
  persistConfigs(): void {
    const configs = this.botManager.getAllBots().map(b => b.config);
    this.configStore.save(configs);
  }

  /**
   * Load bot configs from disk and recreate bot instances.
   *
   * For each config:
   * - Rewrites `tradeLogPath` to be scoped within this tenant's `dataDir`
   * - Loads credentials from CredentialStore (encrypted) if available,
   *   otherwise falls back to credentialKey env var (legacy / single-op mode)
   * - Creates a `BotInstance` (standard) or `HedgeBot` (hedge) via BotManager
   * - Skips configs that fail adapter creation (missing credentials) with a logged error
   *
   * Requirement 3.3, 3.4, 3.5, 5.2
   */
  async loadConfigs(telegram: TelegramManager): Promise<void> {
    const configs = this.configStore.load();

    for (const config of configs) {
      // Scope tradeLogPath to this tenant's dataDir (Requirement 5.2)
      const scopedConfig = {
        ...config,
        tradeLogPath: path.join(this.dataDir, path.basename(config.tradeLogPath)),
      };

      try {
        // Prefer stored credentials; fall back to env var prefix for legacy configs
        const storedCreds = this.credentialStore.load(config.id);
        const adapter = storedCreds
          ? createAdapterFromCredentials(scopedConfig.exchange, storedCreds)
          : createAdapter(scopedConfig.exchange, scopedConfig.credentialKey);

        if ((scopedConfig as HedgeBotConfig).botType === 'hedge') {
          this.botManager.createHedgeBot(scopedConfig as HedgeBotConfig, adapter, telegram);
        } else {
          this.botManager.createBot(scopedConfig as BotConfig, adapter, telegram);
        }
      } catch (err) {
        // Requirement 3.5: log error but continue loading other bots
        console.error(
          `[TenantContext:${this.walletAddress}] Failed to load bot "${config.id}": ${err}`
        );
      }
    }
  }

  /**
   * Stop all running bots for this tenant, then persist configs.
   *
   * Requirement 3.7: stops all RUNNING bots and calls persistConfigs() before returning.
   */
  async shutdown(): Promise<void> {
    const runningBots = this.botManager
      .getAllBots()
      .filter(bot => bot.state.botStatus === 'RUNNING');

    await Promise.all(runningBots.map(bot => bot.stop()));

    this.persistConfigs();
  }
}
