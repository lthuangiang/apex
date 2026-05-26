/**
 * Unit tests for TenantRegistry.restoreAll() — startup tenant restoration.
 *
 * Requirements: 3.3, 3.4, 3.5, 7.4, 11.5
 *
 * Scenarios covered:
 * 1. Wallets with bot-configs.json are restored (Req 3.3)
 * 2. Directories not matching /^0x[a-f0-9]{40}$/ are skipped (Req 7.4)
 * 3. A bot failing autoStart does not block other tenants from restoring (Req 3.5, 11.5)
 * 4. A malformed bot-configs.json is skipped without crashing (Req 11.5)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ── Mock broken SDK dependencies before any imports ───────────────────────────
// @decibeltrade/sdk has a broken ./admin sub-path import in this environment.
// Mock it at the top level so the module graph resolves cleanly.
vi.mock('@decibeltrade/sdk', () => ({
  DecibelReadDex: vi.fn(function () { return {}; }),
  DecibelWriteDex: vi.fn(function () { return {}; }),
  GasPriceManager: vi.fn(function () { return { initialize: vi.fn().mockResolvedValue(undefined) }; }),
  MAINNET_CONFIG: { network: 'mainnet' },
  NETNA_CONFIG: undefined,
  TimeInForce: { PostOnly: 'PostOnly' },
}));

vi.mock('@aptos-labs/ts-sdk', () => ({
  Ed25519Account: vi.fn(function () { return {}; }),
  Ed25519PrivateKey: vi.fn(function () { return {}; }),
  AccountAddress: vi.fn(function () { return {}; }),
  createObjectAddress: vi.fn(),
}));

import fs from 'fs';
import os from 'os';
import path from 'path';
import { TenantRegistry } from '../TenantRegistry.js';
import type { TelegramManager } from '../../modules/TelegramManager.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a unique temp directory for each test run */
function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tenant-registry-startup-test-'));
}

/** Minimal mock TelegramManager — restoreAll passes it to loadConfigs */
function makeMockTelegram(): TelegramManager {
  return {
    sendMessage: vi.fn(),
    bot: null,
  } as unknown as TelegramManager;
}

/**
 * Write a valid bot-configs.json into a wallet directory.
 * Uses a minimal BotConfig that passes validateBotConfig.
 */
function writeValidBotConfigs(
  walletDir: string,
  bots: Array<{ id: string; autoStart?: boolean }> = [{ id: 'bot-1', autoStart: false }]
): void {
  const configs = bots.map(b => ({
    id: b.id,
    name: `Bot ${b.id}`,
    exchange: 'sodex',
    symbol: 'BTC-USD',
    tags: [],
    autoStart: b.autoStart ?? false,
    mode: 'farm',
    orderSizeMin: 10,
    orderSizeMax: 100,
    credentialKey: 'TEST',
    tradeLogBackend: 'json',
    tradeLogPath: `./trades-${b.id}.json`,
  }));

  const data = { version: 1, bots: configs };
  fs.writeFileSync(path.join(walletDir, 'bot-configs.json'), JSON.stringify(data, null, 2), 'utf-8');
}

/** A valid lowercase wallet address (40 hex chars after 0x) */
const WALLET_A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const WALLET_B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const WALLET_C = '0xcccccccccccccccccccccccccccccccccccccccc';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TenantRegistry.restoreAll() — startup restoration', () => {
  let tempDir: string;
  let telegram: TelegramManager;

  beforeEach(() => {
    tempDir = makeTempDir();
    telegram = makeMockTelegram();
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // Scenario 1: Wallets with bot-configs.json are restored (Requirement 3.3)
  // -------------------------------------------------------------------------
  describe('Scenario 1: wallets with bot-configs.json are restored', () => {
    it('returns 0 when the data directory is empty', async () => {
      const registry = new TenantRegistry(tempDir);
      const count = await registry.restoreAll(telegram);
      expect(count).toBe(0);
    });

    it('returns 0 when the data directory does not exist yet', async () => {
      const nonExistentDir = path.join(tempDir, 'does-not-exist');
      const registry = new TenantRegistry(nonExistentDir);
      const count = await registry.restoreAll(telegram);
      expect(count).toBe(0);
      // The directory should have been created
      expect(fs.existsSync(nonExistentDir)).toBe(true);
    });

    it('restores a single wallet that has bot-configs.json', async () => {
      // Arrange: create a valid wallet directory with a config file
      const walletDir = path.join(tempDir, WALLET_A);
      fs.mkdirSync(walletDir, { recursive: true });
      writeValidBotConfigs(walletDir);

      const registry = new TenantRegistry(tempDir);

      // Act
      const count = await registry.restoreAll(telegram);

      // Assert: one tenant was restored and is now in the registry
      expect(count).toBe(1);
      expect(registry.listTenants()).toContain(WALLET_A);
    });

    it('restores multiple wallets that each have bot-configs.json', async () => {
      // Arrange: two valid wallet directories
      for (const addr of [WALLET_A, WALLET_B]) {
        const walletDir = path.join(tempDir, addr);
        fs.mkdirSync(walletDir, { recursive: true });
        writeValidBotConfigs(walletDir);
      }

      const registry = new TenantRegistry(tempDir);
      const count = await registry.restoreAll(telegram);

      expect(count).toBe(2);
      expect(registry.listTenants()).toContain(WALLET_A);
      expect(registry.listTenants()).toContain(WALLET_B);
    });

    it('skips a valid wallet directory that has no bot-configs.json', async () => {
      // Arrange: wallet dir exists but no config file
      const walletDir = path.join(tempDir, WALLET_A);
      fs.mkdirSync(walletDir, { recursive: true });
      // Intentionally do NOT write bot-configs.json

      const registry = new TenantRegistry(tempDir);
      const count = await registry.restoreAll(telegram);

      // No config file → not restored
      expect(count).toBe(0);
      expect(registry.listTenants()).not.toContain(WALLET_A);
    });

    it('restores only wallets that have bot-configs.json when some do not', async () => {
      // WALLET_A has config, WALLET_B does not
      const dirA = path.join(tempDir, WALLET_A);
      const dirB = path.join(tempDir, WALLET_B);
      fs.mkdirSync(dirA, { recursive: true });
      fs.mkdirSync(dirB, { recursive: true });
      writeValidBotConfigs(dirA);
      // WALLET_B has no bot-configs.json

      const registry = new TenantRegistry(tempDir);
      const count = await registry.restoreAll(telegram);

      expect(count).toBe(1);
      expect(registry.listTenants()).toContain(WALLET_A);
      expect(registry.listTenants()).not.toContain(WALLET_B);
    });
  });

  // -------------------------------------------------------------------------
  // Scenario 2: Directories not matching /^0x[a-f0-9]{40}$/ are skipped
  // (Requirement 7.4)
  // -------------------------------------------------------------------------
  describe('Scenario 2: invalid directory names are skipped', () => {
    const invalidNames = [
      'not-a-wallet',
      '.DS_Store',
      'tmp',
      'logs',
      '0xinvalid',                                      // too short
      '0xGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGG',   // invalid hex chars (uppercase G)
      '0xabcdef',                                       // too short (6 chars after 0x)
      '0xabcdef1234567890abcdef1234567890abcdef1234',   // too long (42 chars after 0x)
      '0xABCDEF1234567890ABCDEF1234567890ABCDEF12',     // uppercase — not valid (regex requires lowercase)
      '',
    ];

    it('does not restore any tenant from directories with invalid names', async () => {
      // Create invalid directories, each with a bot-configs.json
      for (const name of invalidNames.filter(n => n.length > 0)) {
        const dir = path.join(tempDir, name);
        fs.mkdirSync(dir, { recursive: true });
        // Write a config file so the only reason to skip is the invalid name
        const data = { version: 1, bots: [] };
        fs.writeFileSync(path.join(dir, 'bot-configs.json'), JSON.stringify(data), 'utf-8');
      }

      const registry = new TenantRegistry(tempDir);
      const count = await registry.restoreAll(telegram);

      expect(count).toBe(0);
      expect(registry.listTenants()).toHaveLength(0);
    });

    it('restores valid wallets while ignoring invalid directory names alongside them', async () => {
      // One valid wallet
      const validDir = path.join(tempDir, WALLET_A);
      fs.mkdirSync(validDir, { recursive: true });
      writeValidBotConfigs(validDir);

      // Several invalid directories with config files
      for (const name of ['not-a-wallet', '.DS_Store', '0xinvalid']) {
        const dir = path.join(tempDir, name);
        fs.mkdirSync(dir, { recursive: true });
        const data = { version: 1, bots: [] };
        fs.writeFileSync(path.join(dir, 'bot-configs.json'), JSON.stringify(data), 'utf-8');
      }

      const registry = new TenantRegistry(tempDir);
      const count = await registry.restoreAll(telegram);

      // Only the valid wallet is restored
      expect(count).toBe(1);
      expect(registry.listTenants()).toEqual([WALLET_A]);
    });

    it('correctly identifies valid wallet addresses via the /^0x[a-f0-9]{40}$/ pattern', () => {
      const pattern = /^0x[a-f0-9]{40}$/;

      const valid = [
        '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        '0x0000000000000000000000000000000000000000',
        '0xffffffffffffffffffffffffffffffffffffffff',
        '0xabcdef1234567890abcdef1234567890abcdef12',
      ];

      const invalid = [
        'not-a-wallet',
        '.DS_Store',
        '0xinvalid',
        '0xABCDEF1234567890ABCDEF1234567890ABCDEF12', // uppercase
        '0xabcdef',                                    // too short
        '0xabcdef1234567890abcdef1234567890abcdef1234', // too long
        '',
        '0x',
      ];

      for (const addr of valid) {
        expect(pattern.test(addr), `"${addr}" should be valid`).toBe(true);
      }
      for (const addr of invalid) {
        expect(pattern.test(addr), `"${addr}" should be invalid`).toBe(false);
      }
    });
  });

  // -------------------------------------------------------------------------
  // Scenario 3: A bot failing autoStart does not block other tenants
  // (Requirements 3.5, 11.5)
  // -------------------------------------------------------------------------
  describe('Scenario 3: failing autoStart does not block other tenants', () => {
    it('continues restoring remaining tenants when one tenant has a bot that fails autoStart', async () => {
      // Arrange: two wallets, each with one autoStart bot
      for (const addr of [WALLET_A, WALLET_B]) {
        const dir = path.join(tempDir, addr);
        fs.mkdirSync(dir, { recursive: true });
        writeValidBotConfigs(dir, [{ id: 'bot-1', autoStart: true }]);
      }

      const registry = new TenantRegistry(tempDir);

      // Spy on ensureTenant to intercept the tenant for WALLET_A and make its bot fail start()
      const originalEnsure = registry.ensureTenant.bind(registry);
      let walletABotStartCalled = false;

      vi.spyOn(registry, 'ensureTenant').mockImplementation((addr: string) => {
        const tenant = originalEnsure(addr);

        if (addr === WALLET_A) {
          // After loadConfigs runs, override getAllBots to return a bot whose start() throws
          const originalLoadConfigs = tenant.loadConfigs.bind(tenant);
          vi.spyOn(tenant, 'loadConfigs').mockImplementation(async (tg) => {
            await originalLoadConfigs(tg);
            // Replace all bots with a mock that throws on start()
            vi.spyOn(tenant.botManager, 'getAllBots').mockReturnValue([
              {
                config: { autoStart: true, id: 'bot-1' },
                state: { botStatus: 'STOPPED' },
                start: vi.fn().mockImplementation(() => {
                  walletABotStartCalled = true;
                  throw new Error('Exchange connection failed');
                }),
                stop: vi.fn(),
              } as any,
            ]);
          });
        }

        return tenant;
      });

      // Act — should not throw
      const count = await registry.restoreAll(telegram);

      // Both tenants are counted as restored (autoStart failure doesn't prevent restoration)
      expect(count).toBe(2);
      // WALLET_A's bot start was attempted
      expect(walletABotStartCalled).toBe(true);
      // Both wallets are in the registry
      expect(registry.listTenants()).toContain(WALLET_A);
      expect(registry.listTenants()).toContain(WALLET_B);
    });

    it('does not throw when every bot in a tenant fails autoStart', async () => {
      const dir = path.join(tempDir, WALLET_A);
      fs.mkdirSync(dir, { recursive: true });
      writeValidBotConfigs(dir, [
        { id: 'bot-1', autoStart: true },
        { id: 'bot-2', autoStart: true },
      ]);

      const registry = new TenantRegistry(tempDir);

      // Make all bots throw on start()
      const originalEnsure = registry.ensureTenant.bind(registry);
      vi.spyOn(registry, 'ensureTenant').mockImplementation((addr: string) => {
        const tenant = originalEnsure(addr);
        const originalLoad = tenant.loadConfigs.bind(tenant);
        vi.spyOn(tenant, 'loadConfigs').mockImplementation(async (tg) => {
          await originalLoad(tg);
          vi.spyOn(tenant.botManager, 'getAllBots').mockReturnValue([
            {
              config: { autoStart: true, id: 'bot-1' },
              state: { botStatus: 'STOPPED' },
              start: vi.fn().mockRejectedValue(new Error('fail')),
              stop: vi.fn(),
            } as any,
            {
              config: { autoStart: true, id: 'bot-2' },
              state: { botStatus: 'STOPPED' },
              start: vi.fn().mockRejectedValue(new Error('fail')),
              stop: vi.fn(),
            } as any,
          ]);
        });
        return tenant;
      });

      await expect(registry.restoreAll(telegram)).resolves.toBe(1);
    });

    it('only auto-starts bots with autoStart: true, not those with autoStart: false', async () => {
      const dir = path.join(tempDir, WALLET_A);
      fs.mkdirSync(dir, { recursive: true });
      writeValidBotConfigs(dir, [
        { id: 'bot-auto', autoStart: true },
        { id: 'bot-manual', autoStart: false },
      ]);

      const registry = new TenantRegistry(tempDir);

      const autoStartSpy = vi.fn().mockResolvedValue(true);
      const manualStartSpy = vi.fn().mockResolvedValue(true);

      const originalEnsure = registry.ensureTenant.bind(registry);
      vi.spyOn(registry, 'ensureTenant').mockImplementation((addr: string) => {
        const tenant = originalEnsure(addr);
        const originalLoad = tenant.loadConfigs.bind(tenant);
        vi.spyOn(tenant, 'loadConfigs').mockImplementation(async (tg) => {
          await originalLoad(tg);
          vi.spyOn(tenant.botManager, 'getAllBots').mockReturnValue([
            {
              config: { autoStart: true, id: 'bot-auto' },
              state: { botStatus: 'STOPPED' },
              start: autoStartSpy,
              stop: vi.fn(),
            } as any,
            {
              config: { autoStart: false, id: 'bot-manual' },
              state: { botStatus: 'STOPPED' },
              start: manualStartSpy,
              stop: vi.fn(),
            } as any,
          ]);
        });
        return tenant;
      });

      await registry.restoreAll(telegram);

      expect(autoStartSpy).toHaveBeenCalledOnce();
      expect(manualStartSpy).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Scenario 4: Malformed bot-configs.json is skipped without crashing
  // (Requirement 11.5)
  // -------------------------------------------------------------------------
  describe('Scenario 4: malformed bot-configs.json is skipped without crashing', () => {
    it('does not crash when bot-configs.json contains invalid JSON', async () => {
      const dir = path.join(tempDir, WALLET_A);
      fs.mkdirSync(dir, { recursive: true });
      // Write syntactically invalid JSON
      fs.writeFileSync(path.join(dir, 'bot-configs.json'), '{ this is not valid json !!!', 'utf-8');

      const registry = new TenantRegistry(tempDir);

      // Should not throw — malformed config is handled gracefully
      await expect(registry.restoreAll(telegram)).resolves.not.toThrow();
    });

    it('returns 1 for a wallet with malformed bot-configs.json (tenant is created, 0 bots loaded)', async () => {
      const dir = path.join(tempDir, WALLET_A);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'bot-configs.json'), '{ this is not valid json !!!', 'utf-8');

      const registry = new TenantRegistry(tempDir);
      const count = await registry.restoreAll(telegram);

      // The tenant is still counted as restored (ensureTenant succeeded),
      // but loadConfigs returns [] for malformed JSON — no bots are created.
      expect(count).toBe(1);
      expect(registry.listTenants()).toContain(WALLET_A);

      const tenant = registry.getTenant(WALLET_A);
      expect(tenant).toBeDefined();
      expect(tenant!.botManager.getAllBots()).toHaveLength(0);
    });

    it('does not crash when bot-configs.json is an empty file', async () => {
      const dir = path.join(tempDir, WALLET_A);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'bot-configs.json'), '', 'utf-8');

      const registry = new TenantRegistry(tempDir);
      await expect(registry.restoreAll(telegram)).resolves.not.toThrow();
    });

    it('does not crash when bot-configs.json has wrong structure (missing "bots" array)', async () => {
      const dir = path.join(tempDir, WALLET_A);
      fs.mkdirSync(dir, { recursive: true });
      // Valid JSON but wrong shape
      fs.writeFileSync(
        path.join(dir, 'bot-configs.json'),
        JSON.stringify({ version: 1, configs: [] }), // "configs" instead of "bots"
        'utf-8'
      );

      const registry = new TenantRegistry(tempDir);
      await expect(registry.restoreAll(telegram)).resolves.not.toThrow();

      const tenant = registry.getTenant(WALLET_A);
      expect(tenant!.botManager.getAllBots()).toHaveLength(0);
    });

    it('does not crash when bot-configs.json is null JSON', async () => {
      const dir = path.join(tempDir, WALLET_A);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'bot-configs.json'), 'null', 'utf-8');

      const registry = new TenantRegistry(tempDir);
      await expect(registry.restoreAll(telegram)).resolves.not.toThrow();
    });

    it('restores other valid wallets even when one has a malformed config', async () => {
      // WALLET_A: malformed config
      const dirA = path.join(tempDir, WALLET_A);
      fs.mkdirSync(dirA, { recursive: true });
      fs.writeFileSync(path.join(dirA, 'bot-configs.json'), '{ bad json', 'utf-8');

      // WALLET_B: valid config
      const dirB = path.join(tempDir, WALLET_B);
      fs.mkdirSync(dirB, { recursive: true });
      writeValidBotConfigs(dirB);

      // WALLET_C: valid config
      const dirC = path.join(tempDir, WALLET_C);
      fs.mkdirSync(dirC, { recursive: true });
      writeValidBotConfigs(dirC);

      const registry = new TenantRegistry(tempDir);
      const count = await registry.restoreAll(telegram);

      // All three wallets are counted (malformed config still creates the tenant)
      expect(count).toBe(3);
      expect(registry.listTenants()).toContain(WALLET_A);
      expect(registry.listTenants()).toContain(WALLET_B);
      expect(registry.listTenants()).toContain(WALLET_C);
    });
  });

  // -------------------------------------------------------------------------
  // Edge cases
  // -------------------------------------------------------------------------
  describe('Edge cases', () => {
    it('is idempotent — calling restoreAll twice does not duplicate tenants', async () => {
      const dir = path.join(tempDir, WALLET_A);
      fs.mkdirSync(dir, { recursive: true });
      writeValidBotConfigs(dir);

      const registry = new TenantRegistry(tempDir);

      await registry.restoreAll(telegram);
      await registry.restoreAll(telegram);

      // Should still have exactly one tenant
      expect(registry.listTenants()).toHaveLength(1);
      expect(registry.listTenants()).toContain(WALLET_A);
    });

    it('returns the count of tenants restored in the current call', async () => {
      const dir = path.join(tempDir, WALLET_A);
      fs.mkdirSync(dir, { recursive: true });
      writeValidBotConfigs(dir);

      const registry = new TenantRegistry(tempDir);

      const firstCount = await registry.restoreAll(telegram);
      expect(firstCount).toBe(1);

      // Second call: WALLET_A already in registry, ensureTenant is idempotent
      // but restoreAll still counts it as processed
      const secondCount = await registry.restoreAll(telegram);
      expect(secondCount).toBe(1);
    });
  });
});
