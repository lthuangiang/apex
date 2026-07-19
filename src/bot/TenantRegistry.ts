import fs from 'fs';
import path from 'path';
import { BotManager } from './BotManager.js';
import { TenantConfigStore } from './TenantConfigStore.js';
import { CredentialStore } from './CredentialStore.js';
import { TenantContext } from './TenantContext.js';
import type { TelegramManager } from '../modules/TelegramManager.js';

/**
 * Platform-wide aggregate statistics across all tenants.
 *
 * Requirements: 9.1, 9.5
 */
export interface PlatformStats {
  /** Total number of registered tenants */
  totalTenants: number;
  /** Tenants with at least one bot in RUNNING status */
  activeTenants: number;
  /** Total number of bots across all tenants */
  totalBots: number;
  /** Total number of RUNNING bots across all tenants */
  activeBots: number;
  /** Sum of sessionVolume across all bots (USD) */
  totalVolumeUsd: number;
  /** Sum of sessionPnl across all bots (USD) */
  totalPnlUsd: number;
}

/**
 * TenantRegistry — central registry mapping wallet addresses to TenantContext instances.
 *
 * Acts as the multi-tenancy boundary: all wallet-scoped operations go through here.
 * Wallet addresses are normalized to lowercase for consistent keying.
 *
 * Requirements: 1.1, 1.2, 3.1, 3.2, 3.6, 9.1, 9.5
 */
export class TenantRegistry {
  /** Internal map from lowercase wallet address → TenantContext */
  private registry = new Map<string, TenantContext>();

  /**
   * @param dataBaseDir - Root directory for all tenant data (e.g. `'./data'`)
   */
  constructor(private readonly dataBaseDir: string) {}

  /**
   * Get or create a TenantContext for a wallet address. Idempotent.
   *
   * - Normalizes `walletAddress` to lowercase
   * - Returns the existing context if already registered (same object reference)
   * - Otherwise: creates `{dataBaseDir}/{walletAddress}/`, instantiates BotManager,
   *   TenantConfigStore, and TenantContext, stores in registry, and returns it
   *
   * Requirements: 1.1, 3.1, 3.2
   */
  ensureTenant(walletAddress: string): TenantContext {
    const key = walletAddress.toLowerCase();

    const existing = this.registry.get(key);
    if (existing) {
      return existing;
    }

    const dataDir = path.join(this.dataBaseDir, key);
    fs.mkdirSync(dataDir, { recursive: true });

    const botManager = new BotManager();
    const configStore = new TenantConfigStore(dataDir);
    const credentialStore = new CredentialStore(dataDir);

    const tenant = new TenantContext({
      walletAddress: key,
      dataDir,
      botManager,
      configStore,
      credentialStore,
    });

    this.registry.set(key, tenant);
    console.log(`[TenantRegistry] Created tenant: ${key}`);

    return tenant;
  }

  /**
   * Get an existing TenantContext by wallet address.
   *
   * Returns `undefined` if the wallet has never logged in (no context created yet).
   *
   * Requirement: 1.1
   */
  getTenant(walletAddress: string): TenantContext | undefined {
    return this.registry.get(walletAddress.toLowerCase());
  }

  /**
   * List all registered tenant wallet addresses (lowercase).
   *
   * Requirement: 9.1
   */
  listTenants(): string[] {
    return Array.from(this.registry.keys());
  }

  /**
   * Get all TenantContext instances. Used by AgentLayer for portfolio-wide observation.
   */
  getAllTenants(): TenantContext[] {
    return Array.from(this.registry.values());
  }

  /**
   * Gracefully shut down all registered tenants.
   *
   * Calls `tenant.shutdown()` on every entry, which stops all running bots
   * and persists configs. Errors from individual tenants are logged but do
   * not prevent other tenants from shutting down.
   *
   * Requirement: 3.6
   */
  async shutdownAll(): Promise<void> {
    const entries = Array.from(this.registry.entries());

    await Promise.all(
      entries.map(async ([key, tenant]) => {
        try {
          await tenant.shutdown();
        } catch (err) {
          console.error(`[TenantRegistry] Error shutting down tenant ${key}:`, err);
        }
      })
    );
  }

  /**
   * Restore all tenants from disk on server startup.
   *
   * - Creates `dataBaseDir` if it does not exist; returns 0 if empty
   * - Scans subdirectories matching `/^0x[a-f0-9]{40}$/` (valid wallet addresses)
   * - Skips directories without a `bot-configs.json` file
   * - For each valid tenant: calls `ensureTenant`, then `loadConfigs` to recreate bots
   * - Auto-starts bots with `autoStart: true`; errors are logged but do not block others
   * - Returns the count of successfully restored tenants
   *
   * Requirements: 3.3, 3.4, 3.5, 7.4, 11.5
   */
  async restoreAll(telegram: TelegramManager): Promise<number> {
    // Create the data directory if it doesn't exist
    if (!fs.existsSync(this.dataBaseDir)) {
      fs.mkdirSync(this.dataBaseDir, { recursive: true });
      return 0;
    }

    // Read all entries in the data directory
    let entries: string[];
    try {
      entries = fs.readdirSync(this.dataBaseDir);
    } catch (err) {
      console.error(`[TenantRegistry] Failed to read data directory "${this.dataBaseDir}":`, err);
      return 0;
    }

    // Filter to valid lowercase wallet address directory names
    const walletAddressPattern = /^0x[a-f0-9]{40}$/;
    const validWalletDirs = entries.filter(entry => walletAddressPattern.test(entry));

    if (validWalletDirs.length === 0) {
      return 0;
    }

    let restoredCount = 0;

    for (const walletDir of validWalletDirs) {
      const configPath = path.join(this.dataBaseDir, walletDir, 'bot-configs.json');

      // Skip wallets without a config file (Requirement 3.3)
      if (!fs.existsSync(configPath)) {
        continue;
      }

      try {
        // Get or create the tenant context
        const tenant = this.ensureTenant(walletDir);

        // Load configs — creates bot instances from persisted config
        await tenant.loadConfigs(telegram);

        // Auto-start bots with autoStart: true (Requirements 3.4, 3.5)
        const bots = tenant.botManager.getAllBots();
        for (const bot of bots) {
          if (bot.config.autoStart) {
            try {
              await bot.start();
              console.log(
                `[TenantRegistry] Auto-started bot "${bot.config.id}" for wallet ${walletDir}`
              );
            } catch (err) {
              // Requirement 3.5: log error but continue restoring other bots
              console.error(
                `[TenantRegistry] Failed to auto-start bot "${bot.config.id}" for wallet ${walletDir}:`,
                err
              );
            }
          }
        }

        restoredCount++;
        console.log(`[TenantRegistry] Restored tenant: ${walletDir}`);
      } catch (err) {
        // Requirement 11.5: log error and skip this tenant without crashing
        console.error(`[TenantRegistry] Failed to restore tenant "${walletDir}":`, err);
      }
    }

    return restoredCount;
  }

  /**
   * Compute platform-wide aggregate statistics across all tenants.
   *
   * - `activeTenants`: tenants with ≥1 bot in RUNNING status
   * - `totalVolumeUsd` / `totalPnlUsd`: summed from bot session stats (0 if unavailable)
   *
   * Requirements: 9.1, 9.5
   */
  getPlatformStats(): PlatformStats {
    let totalBots = 0;
    let activeBots = 0;
    let activeTenants = 0;
    let totalVolumeUsd = 0;
    let totalPnlUsd = 0;

    for (const tenant of this.registry.values()) {
      const bots = tenant.botManager.getAllBots();
      totalBots += bots.length;

      let tenantHasRunningBot = false;

      for (const bot of bots) {
        if (bot.state.botStatus === 'RUNNING') {
          activeBots++;
          tenantHasRunningBot = true;
        }

        // Aggregate volume and PnL from session stats (default to 0 if missing)
        totalVolumeUsd += bot.state.sessionVolume ?? 0;
        totalPnlUsd += bot.state.sessionPnl ?? 0;
      }

      if (tenantHasRunningBot) {
        activeTenants++;
      }
    }

    return {
      totalTenants: this.registry.size,
      activeTenants,
      totalBots,
      activeBots,
      totalVolumeUsd,
      totalPnlUsd,
    };
  }
}
