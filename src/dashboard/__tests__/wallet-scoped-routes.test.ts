/**
 * Unit tests for wallet-scoped bot routes.
 *
 * Tests the walletScopedMiddleware and bot route behavior when the server
 * is configured with a TenantRegistry.
 *
 * Requirements: 4.1, 4.2, 5.3, 5.6, 5.9
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

// Mock verifySiweMessage to always succeed with TEST_WALLET.
// NOTE: vi.mock is hoisted to the top of the file, so we cannot reference
// the TEST_WALLET constant here — use the literal string instead.
vi.mock('../../auth/SiweAuth.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../auth/SiweAuth.js')>();
  return {
    ...original,
    verifySiweMessage: vi.fn().mockReturnValue({
      ok: true,
      address: '0xabcdef1234567890abcdef1234567890abcdef12',
    }),
  };
});

import request from 'supertest';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { DashboardServer } from '../server.js';
import { TenantRegistry } from '../../bot/TenantRegistry.js';
import { TradeLogger } from '../../ai/TradeLogger.js';
import type { ExchangeAdapter } from '../../adapters/ExchangeAdapter.js';
import type { TelegramManager } from '../../modules/TelegramManager.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

const TEST_WALLET = '0xabcdef1234567890abcdef1234567890abcdef12';

/** Create a minimal mock exchange adapter */
function createMockAdapter(): ExchangeAdapter {
  return {
    getBalance: vi.fn().mockResolvedValue({ free: 1000, used: 0, total: 1000 }),
    getPrice: vi.fn().mockResolvedValue(50000),
    get_mark_price: vi.fn().mockResolvedValue(50000),
    placeOrder: vi.fn().mockResolvedValue({ id: 'order-1', status: 'filled' }),
    cancelOrder: vi.fn().mockResolvedValue(true),
    getOpenOrders: vi.fn().mockResolvedValue([]),
    getOrderStatus: vi.fn().mockResolvedValue({ id: 'order-1', status: 'filled' }),
    getPositions: vi.fn().mockResolvedValue([]),
    closePosition: vi.fn().mockResolvedValue(true),
  } as any;
}

/** Create a minimal mock TelegramManager */
function createMockTelegram(): TelegramManager {
  return { sendMessage: vi.fn() } as any;
}

/**
 * Authenticate with the server by mocking verifySiweMessage and calling
 * POST /api/auth/verify. Returns the siwe_token cookie value.
 */
async function authenticateAndGetToken(
  app: Express.Application,
  walletAddress: string,
): Promise<string> {
  const res = await request(app)
    .post('/api/auth/verify')
    .send({ message: 'test-message', signature: '0xsig' });

  expect(res.status).toBe(200);

  // Extract siwe_token from Set-Cookie header
  const setCookie = res.headers['set-cookie'] as string[] | string | undefined;
  const cookieStr = Array.isArray(setCookie) ? setCookie.join('; ') : (setCookie ?? '');
  const match = cookieStr.match(/siwe_token=([a-f0-9]+)/);
  expect(match).not.toBeNull();
  return match![1];
}

// ── Test setup ────────────────────────────────────────────────────────────────

describe('Wallet-Scoped Bot Routes', () => {
  let server: DashboardServer;
  let registry: TenantRegistry;
  let tmpDataDir: string;

  beforeEach(async () => {
    // Disable passcode auth so only siwe_token matters
    process.env.DASHBOARD_PASSCODE = '';

    // Create a temp data directory for the TenantRegistry
    tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-test-'));

    const tradeLogger = new TradeLogger('json', path.join(tmpDataDir, 'trades.json'));
    server = new DashboardServer(tradeLogger, 0);

    registry = new TenantRegistry(tmpDataDir);
    server.registerTenantRegistry(registry);

    // Register a BotManager so the manager routes are set up
    // We use a real BotManager from the registry's tenant
    const { BotManager } = await import('../../bot/BotManager.js');
    const globalBotManager = new BotManager();
    server.registerBotManager(globalBotManager, createMockTelegram());
  });

  afterEach(() => {
    vi.restoreAllMocks();
    // Clean up temp directory
    try {
      fs.rmSync(tmpDataDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  // ── Requirement 4.1: 401 with no cookie ────────────────────────────────────

  describe('GET /api/bots — authentication', () => {
    it('returns 401 when no siwe_token cookie is present (Requirement 4.1)', async () => {
      const res = await request(server.app)
        .get('/api/bots')
        // No cookie sent
        .expect(401);

      expect(res.body).toMatchObject({ error: expect.any(String) });
    });

    // ── Requirement 4.2: 401 with expired token ─────────────────────────────

    it('returns 401 when siwe_token cookie is expired (Requirement 4.2)', async () => {
      // Send a token that was never registered (simulates expired/unknown token)
      const fakeExpiredToken = 'a'.repeat(64); // 64 hex chars but not in validTokens

      const res = await request(server.app)
        .get('/api/bots')
        .set('Cookie', `siwe_token=${fakeExpiredToken}`)
        .expect(401);

      expect(res.body).toMatchObject({ error: expect.any(String) });
    });
  });

  // ── Requirement 5.3: POST /api/bots creates bot in tenant's BotManager ─────

  describe('POST /api/bots — tenant isolation', () => {
    it('creates bot in the authenticated tenant BotManager, not a global one (Requirement 5.3)', async () => {
      // Get a valid token by authenticating
      const token = await authenticateAndGetToken(server.app, TEST_WALLET);

      // The tenant should now exist in the registry
      const tenant = registry.getTenant(TEST_WALLET);
      expect(tenant).toBeDefined();

      // Verify the tenant's BotManager starts empty
      expect(tenant!.botManager.getAllBots()).toHaveLength(0);

      // Mock the adapter factory so we don't need real credentials
      vi.mock('../../bot/adapterFactory.js', () => ({
        createAdapter: vi.fn().mockReturnValue(createMockAdapter()),
      }));

      const botConfig = {
        id: 'tenant-bot-1',
        name: 'Tenant Bot',
        exchange: 'sodex',
        symbol: 'BTC-USD',
        credentialKey: 'TEST_KEY',
        tradeLogBackend: 'json',
        tradeLogPath: './trades.json',
        autoStart: false,
        mode: 'farm',
        orderSizeMin: 0.003,
        orderSizeMax: 0.005,
        tags: ['test'],
      };

      const res = await request(server.app)
        .post('/api/bots')
        .set('Cookie', `siwe_token=${token}`)
        .send(botConfig)
        .expect(201);

      expect(res.body).toMatchObject({ ok: true, id: 'tenant-bot-1' });

      // The bot should be in the TENANT's BotManager
      const tenantBot = tenant!.botManager.getBot('tenant-bot-1');
      expect(tenantBot).toBeDefined();
    });
  });

  // ── Requirement 5.6: DELETE /api/bots/:id on running bot returns 409 ───────

  describe('DELETE /api/bots/:id — running bot protection', () => {
    it('returns 409 when attempting to delete a running bot (Requirement 5.6)', async () => {
      const token = await authenticateAndGetToken(server.app, TEST_WALLET);

      const tenant = registry.getTenant(TEST_WALLET);
      expect(tenant).toBeDefined();

      // Directly add a running bot to the tenant's BotManager
      const { BotManager } = await import('../../bot/BotManager.js');
      const { BotInstance } = await import('../../bot/BotInstance.js');

      const botConfig = {
        id: 'running-bot',
        name: 'Running Bot',
        exchange: 'sodex',
        symbol: 'BTC-USD',
        credentialKey: 'TEST_KEY',
        tradeLogBackend: 'json' as const,
        tradeLogPath: path.join(tmpDataDir, 'trades-running-bot.json'),
        autoStart: false,
        mode: 'farm' as const,
        orderSizeMin: 0.003,
        orderSizeMax: 0.005,
        tags: ['test'],
      };

      const bot = tenant!.botManager.createBot(botConfig, createMockAdapter(), createMockTelegram());
      // Manually set the bot to RUNNING state (without actually starting it)
      bot.state.botStatus = 'RUNNING';

      const res = await request(server.app)
        .delete('/api/bots/running-bot')
        .set('Cookie', `siwe_token=${token}`)
        .expect(409);

      expect(res.body).toMatchObject({ error: expect.any(String) });

      // Bot should still be in the registry
      expect(tenant!.botManager.getBot('running-bot')).toBeDefined();
    });
  });

  // ── Requirement 5.9: GET /api/bots/:id for non-existent bot returns 404 ────

  describe('GET /api/bots/:id — non-existent bot', () => {
    it('returns 404 for a bot ID that does not exist in the tenant BotManager (Requirement 5.9)', async () => {
      const token = await authenticateAndGetToken(server.app, TEST_WALLET);

      const res = await request(server.app)
        .get('/api/bots/does-not-exist')
        .set('Cookie', `siwe_token=${token}`)
        .expect(404);

      expect(res.body).toMatchObject({ error: expect.any(String) });
    });
  });
});
