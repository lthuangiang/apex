import fs from 'fs';
import path from 'path';
import type { BotConfig, HedgeBotConfig } from './types.js';
import { validateBotConfig, validateHedgeBotConfig } from './loadBotConfigs.js';

/**
 * Per-tenant config persistence.
 *
 * Stores bot configurations at `{dataDir}/bot-configs.json`.
 * Atomic writes (write to .tmp, then rename) prevent partial-write corruption.
 * Path sanitization ensures all tradeLogPath values stay within the tenant's dataDir.
 *
 * Requirements: 6.1, 6.2, 6.3, 6.4, 6.5
 */
export class TenantConfigStore {
  /** Absolute path to the config file: `{dataDir}/bot-configs.json` */
  readonly configPath: string;

  /** Absolute resolved path to the tenant data directory */
  private readonly resolvedDataDir: string;

  constructor(private readonly dataDir: string) {
    // Ensure the data directory exists (Requirement 7.1)
    fs.mkdirSync(dataDir, { recursive: true });

    this.resolvedDataDir = path.resolve(dataDir);
    this.configPath = path.join(this.resolvedDataDir, 'bot-configs.json');
  }

  /**
   * Load bot configurations from `{dataDir}/bot-configs.json`.
   *
   * Returns an empty array if the file does not exist (new tenant).
   * Uses the same JSON parse + validate loop as `loadBotConfigs`.
   *
   * Requirement 6.3
   */
  load(): (BotConfig | HedgeBotConfig)[] {
    if (!fs.existsSync(this.configPath)) {
      return [];
    }

    try {
      const fileContent = fs.readFileSync(this.configPath, 'utf-8');
      const data = JSON.parse(fileContent);

      if (!data.bots || !Array.isArray(data.bots)) {
        console.error(`[TenantConfigStore] Invalid config format at ${this.configPath}: missing "bots" array`);
        return [];
      }

      const validConfigs: (BotConfig | HedgeBotConfig)[] = [];

      for (const config of data.bots) {
        if (config.botType === 'hedge') {
          try {
            validateHedgeBotConfig(config);
            validConfigs.push(config as HedgeBotConfig);
          } catch (err) {
            console.warn(`[TenantConfigStore] Invalid hedge config skipped: ${config.id ?? 'unknown'} — ${err}`);
          }
        } else if (validateBotConfig(config)) {
          validConfigs.push(config);
        } else {
          console.warn(`[TenantConfigStore] Invalid config skipped: ${config.id ?? 'unknown'}`);
        }
      }

      console.log(`[TenantConfigStore] Loaded ${validConfigs.length} config(s) from ${this.configPath}`);
      return validConfigs;
    } catch (err) {
      console.error(`[TenantConfigStore] Failed to read config file: ${err}`);
      return [];
    }
  }

  /**
   * Save bot configurations to `{dataDir}/bot-configs.json` atomically.
   *
   * - Sanitizes `tradeLogPath` on each config so it always resolves within `dataDir`.
   * - Guards the configPath and each tradeLogPath with `assertWithinDataDir` before any I/O.
   * - Writes to `configPath + '.tmp'` first, then renames to the final path.
   *
   * Requirements: 6.2, 6.4, 6.5, 7.2, 7.3
   */
  save(configs: (BotConfig | HedgeBotConfig)[]): void {
    // Guard: ensure the config file itself is within dataDir (Requirement 7.2, 7.3)
    assertWithinDataDir(this.configPath, this.resolvedDataDir);

    const sanitized = configs.map(config => ({
      ...config,
      tradeLogPath: this.sanitizeTradeLogPath(config.tradeLogPath),
    }));

    // Guard: verify every tradeLogPath resolves within dataDir after sanitization (Requirement 7.2, 7.3)
    for (const config of sanitized) {
      assertWithinDataDir(config.tradeLogPath, this.resolvedDataDir);
    }

    const data = {
      version: 1,
      bots: sanitized,
    };

    const tmpPath = this.configPath + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
    fs.renameSync(tmpPath, this.configPath);

    console.log(`[TenantConfigStore] Saved ${sanitized.length} config(s) to ${this.configPath}`);
  }

  /**
   * Ensure a tradeLogPath resolves within the tenant's dataDir.
   *
   * If the resolved path escapes dataDir (e.g. path traversal like `../../evil.json`),
   * rewrite it to use only the basename within dataDir.
   *
   * Requirement 6.4, 6.5
   */
  private sanitizeTradeLogPath(tradeLogPath: string): string {
    const resolved = path.resolve(this.resolvedDataDir, tradeLogPath);

    if (resolved.startsWith(this.resolvedDataDir + path.sep) || resolved === this.resolvedDataDir) {
      // Path is already within dataDir — keep it as-is
      return resolved;
    }

    // Path escapes dataDir — rewrite to basename within dataDir
    const basename = path.basename(tradeLogPath);
    return path.join(this.resolvedDataDir, basename);
  }
}

/**
 * Validate that a file path resolves within the given dataDir.
 * Throws if the path escapes the directory.
 *
 * Requirement 7.2, 7.3
 */
export function assertWithinDataDir(filePath: string, dataDir: string): void {
  const resolvedDir = path.resolve(dataDir);
  const resolvedFile = path.resolve(filePath);

  if (!resolvedFile.startsWith(resolvedDir + path.sep) && resolvedFile !== resolvedDir) {
    throw new Error(
      `Path traversal detected: "${filePath}" resolves to "${resolvedFile}" which is outside dataDir "${resolvedDir}"`
    );
  }
}
