/**
 * Integration test for full tenant lifecycle.
 *
 * Task 11.2: Tests the complete flow from wallet authentication through bot
 * creation and data isolation between two wallets with the same bot ID.
 *
 * Test scenario:
 *   1. Wallet A authenticates → ensureTenant creates context
 *   2. Wallet A calls POST /api/bots → bot created in wallet A's manager
 *   3. Wallet A calls GET /api/bots → returns only wallet A's bots
 *   4. Wallet B authenticates → separate TenantContext created
 *   5. Wallet B creates a bot with the SAME ID as wallet A's bot
 *   6. Each wallet sees only their own bot (data isolation)
 *
 * Property: Data isolation — two wallets with the same bot ID never see
 * each other's bots.
 *
 * Validates: Requirements 1.4, 1.5
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { DashboardServer } from '../server.js';
import { TenantRegistry } from '../../bot/TenantRegistry.js';
import { TradeLogger } from '../../ai/TradeLogger.js';
import type { ExchangeAdapter } from '../../adapters/ExchangeAdapter.js';
import type { TelegramManager } from '../../modules/TelegramManager.js';

// ── Mock broken SDK dependencies ──────────────────────────────────────────────
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

// ── Mock SiweAuth so we don't need real wallet signatures ─────────────────────
vi.mock('../../auth/SiweAuth.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../auth/SiweAuth.js')>();
  return {
    ...original,
    generateNonce: original.generateNonce,
    verifySiweMessage: vi.fn(),
  };
});

// ── Mock adapterFactory so we don't need real exchange credentials ────────────
vi.mock('../../bot/adapterFactory.js', () => ({
  createAdapter: vi.fn(),
}));

import { verifySiweMessage } from '../../auth/SiweAuth.js';
import { createAdapter } from '../../bot/adapterFactory.js';

// ── Constants ─────────────────────────────────────────────────────────────────

const WALLET_A = '0xaaaa1111bbbb2222cccc3333dddd4444eeee5555';
const WALLET_B = '0xbbbb2222cccc3333dddd4444eeee5555ffff6666';

/** Bot ID used by BOTH wallets — the key to testing data isolation */
const SHARED_BOT_ID = 'my-trading-bot';

// ── Helpers ───────────────────────────────────────────────────────────────────

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
 * Authenticate a wallet by mocking verifySiweMessage and calling
 * POST /api/auth/verify. Returns the siwe_token cookie value.
 */
async function authenticateWallet(
  app: Express.Application,
  walletAddress: string,
): Promise<string> {
  vi.mocked(verifySiweMessage).mockReturnValueOnce({
    ok: true,
    address: walletAddress,
  });

  const res = await request(app)
    .post('/api/auth/verify')
    .send({ message: 'test-message', signature: '0xsig' });

  expect(res.status).toBe(200);
  expect(res.body.ok).toBe(true);
  expect(res.body.address).toBe(walletAddress);

  // Extract siwe_token from Set-Cookie header
  const setCookie = res.headers['set-cookie'] as string[] | string | undefined;
  const cookieStr = Array.isArray(setCookie) ? setCookie.join('; ') : (setCookie ?? '');
  const match = cookieStr.match(/siwe_token=([a-f0-9]+)/);
  expect(match).not.toBeNull();
  return match![1];
}

/**
 * Build a minimal bot config for POST /api/bots.
 * Uses a mock exchange so no real credentials are needed.
 */
function makeBotConfig(botId: string, name: string) {
  return {
    id: botId,
    name,
    exchange: 'sodex',
    symbol: 'BTC-USD',
    credentialKey: 'TEST_KEY',
    tradeLogBackend: 'json',
    tradeLogPath: './trades.json', // will be overridden by server to tenant dataDir
    autoStart: false,
    mode: 'farm',
    orderSizeMin: 0.003,
    orderSizeMax: 0.005,
    tags: [],
  };
}

// ── Test Setup ────────────────────────────────────────────────────────────────

describe('Full Tenant Lifecycle Integration (Requirements 1.4, 1.5)', () => {
  let server: DashboardServer;
  let registry: TenantRegistry;
  let tmpDataDir: string;

  beforeEach(async () => {
    // Disable passcode auth so only siwe_token matters
    process.env.DASHBOARD_PASSCODE = '';

    // Create a temp data directory for the TenantRegistry
    tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-lifecycle-test-'));

    const tradeLogger = new TradeLogger('json', path.join(tmpDataDir, 'trades.json'));
    server = new DashboardServer(tradeLogger, 0);

    registry = new TenantRegistry(tmpDataDir);
    server.registerTenantRegistry(registry);

    // Register a BotManager so the manager routes are set up
    const { BotManager } = await import('../../bot/BotManager.js');
    const globalBotManager = new BotManager();
    server.registerBotManager(globalBotManager, createMockTelegram());

    // Mock the adapter factory to return a mock adapter for all calls
    vi.mocked(createAdapter).mockReturnValue(createMockAdapter());
  });

  afterEach(() => {
    vi.clearAllMocks();
    try {
      fs.rmSync(tmpDataDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  // ── Step 1: New wallet authenticates → ensureTenant creates context ──────────

  it('Step 1: new wallet authentication creates a TenantContext', async () => {
    // Wallet A should not exist yet
    expect(registry.getTenant(WALLET_A)).toBeUndefined();

    const token = await authenticateWallet(server.app, WALLET_A);

    // After auth, tenant context should exist
    const tenant = registry.getTenant(WALLET_A);
    expect(tenant).toBeDefined();
    expect(tenant!.walletAddress).toBe(WALLET_A.toLowerCase());

    // Data directory should be created
    const expectedDir = path.join(tmpDataDir, WALLET_A.toLowerCase());
    expect(fs.existsSync(expectedDir)).toBe(true);

    // Token should be valid (GET /api/bots returns 200, not 401)
    const botsRes = await request(server.app)
      .get('/api/bots')
      .set('Cookie', `siwe_token=${token}`);
    expect(botsRes.status).toBe(200);
  });

  // ── Step 2: POST /api/bots creates bot in tenant's manager ──────────────────

  it('Step 2: POST /api/bots creates bot in the authenticated tenant BotManager', async () => {
    const token = await authenticateWallet(server.app, WALLET_A);
    const tenant = registry.getTenant(WALLET_A)!;

    // Tenant's BotManager should start empty
    expect(tenant.botManager.getAllBots()).toHaveLength(0);

    const res = await request(server.app)
      .post('/api/bots')
      .set('Cookie', `siwe_token=${token}`)
      .send(makeBotConfig(SHARED_BOT_ID, 'Wallet A Bot'));

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ ok: true, id: SHARED_BOT_ID });

    // Bot should be in the TENANT's BotManager
    const bot = tenant.botManager.getBot(SHARED_BOT_ID);
    expect(bot).toBeDefined();
    expect(bot!.config.id).toBe(SHARED_BOT_ID);

    // tradeLogPath should be scoped to the tenant's data directory (Requirement 5.2)
    expect(bot!.config.tradeLogPath).toContain(WALLET_A.toLowerCase());
    expect(bot!.config.tradeLogPath).toContain(SHARED_BOT_ID);
  });

  // ── Step 3: GET /api/bots returns only that wallet's bots ───────────────────

  it('Step 3: GET /api/bots returns only the authenticated wallet\'s bots', async () => {
    const token = await authenticateWallet(server.app, WALLET_A);

    // Create a bot for wallet A
    await request(server.app)
      .post('/api/bots')
      .set('Cookie', `siwe_token=${token}`)
      .send(makeBotConfig(SHARED_BOT_ID, 'Wallet A Bot'))
      .expect(201);

    // GET /api/bots should return exactly one bot
    const res = await request(server.app)
      .get('/api/bots')
      .set('Cookie', `siwe_token=${token}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].id).toBe(SHARED_BOT_ID);
  });

  // ── Step 4: New wallet gets empty bot list ───────────────────────────────────

  it('Step 4: new wallet starts with an empty bot list (Requirement 11.1)', async () => {
    // Wallet A creates a bot
    const tokenA = await authenticateWallet(server.app, WALLET_A);
    await request(server.app)
      .post('/api/bots')
      .set('Cookie', `siwe_token=${tokenA}`)
      .send(makeBotConfig(SHARED_BOT_ID, 'Wallet A Bot'))
      .expect(201);

    // Wallet B authenticates for the first time
    const tokenB = await authenticateWallet(server.app, WALLET_B);

    // Wallet B should see an empty bot list
    const res = await request(server.app)
      .get('/api/bots')
      .set('Cookie', `siwe_token=${tokenB}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(0);
  });

  // ── Step 5 & 6: Data isolation — two wallets with the same bot ID ────────────

  it('Data isolation: two wallets with the same bot ID never see each other\'s bots (Requirements 1.4, 1.5)', async () => {
    // Wallet A authenticates and creates a bot with SHARED_BOT_ID
    const tokenA = await authenticateWallet(server.app, WALLET_A);
    const resA = await request(server.app)
      .post('/api/bots')
      .set('Cookie', `siwe_token=${tokenA}`)
      .send(makeBotConfig(SHARED_BOT_ID, 'Wallet A Bot'));
    expect(resA.status).toBe(201);

    // Wallet B authenticates and creates a bot with the SAME SHARED_BOT_ID
    const tokenB = await authenticateWallet(server.app, WALLET_B);
    const resB = await request(server.app)
      .post('/api/bots')
      .set('Cookie', `siwe_token=${tokenB}`)
      .send(makeBotConfig(SHARED_BOT_ID, 'Wallet B Bot'));
    expect(resB.status).toBe(201);

    // Wallet A sees only its own bot
    const botsA = await request(server.app)
      .get('/api/bots')
      .set('Cookie', `siwe_token=${tokenA}`);
    expect(botsA.status).toBe(200);
    expect(botsA.body).toHaveLength(1);
    expect(botsA.body[0].id).toBe(SHARED_BOT_ID);
    expect(botsA.body[0].name).toBe('Wallet A Bot');

    // Wallet B sees only its own bot
    const botsB = await request(server.app)
      .get('/api/bots')
      .set('Cookie', `siwe_token=${tokenB}`);
    expect(botsB.status).toBe(200);
    expect(botsB.body).toHaveLength(1);
    expect(botsB.body[0].id).toBe(SHARED_BOT_ID);
    expect(botsB.body[0].name).toBe('Wallet B Bot');

    // Verify at the registry level: each tenant has its own BotManager
    const tenantA = registry.getTenant(WALLET_A)!;
    const tenantB = registry.getTenant(WALLET_B)!;
    expect(tenantA.botManager).not.toBe(tenantB.botManager);

    // Each tenant's BotManager has exactly one bot
    expect(tenantA.botManager.getAllBots()).toHaveLength(1);
    expect(tenantB.botManager.getAllBots()).toHaveLength(1);

    // The bots are different instances even though they share the same ID
    const botA = tenantA.botManager.getBot(SHARED_BOT_ID)!;
    const botB = tenantB.botManager.getBot(SHARED_BOT_ID)!;
    expect(botA).not.toBe(botB);
    expect(botA.config.name).toBe('Wallet A Bot');
    expect(botB.config.name).toBe('Wallet B Bot');
  });

  // ── Property: Data isolation across many wallet pairs ────────────────────────
  //
  // **Validates: Requirements 1.4, 1.5**
  //
  // For any two distinct wallet addresses, their GET /api/bots responses are
  // completely independent — a bot created by wallet A is never visible to
  // wallet B, even when both bots share the same ID.

  it('Property: data isolation — wallet A\'s bots are never in wallet B\'s GET /api/bots response', async () => {
    // Authenticate both wallets
    const tokenA = await authenticateWallet(server.app, WALLET_A);
    const tokenB = await authenticateWallet(server.app, WALLET_B);

    // Wallet A creates multiple bots
    const botIdsA = ['bot-alpha', 'bot-beta', 'bot-gamma'];
    for (const botId of botIdsA) {
      await request(server.app)
        .post('/api/bots')
        .set('Cookie', `siwe_token=${tokenA}`)
        .send(makeBotConfig(botId, `Wallet A - ${botId}`))
        .expect(201);
    }

    // Wallet B creates a bot with one of the same IDs
    await request(server.app)
      .post('/api/bots')
      .set('Cookie', `siwe_token=${tokenB}`)
      .send(makeBotConfig('bot-alpha', 'Wallet B - bot-alpha'))
      .expect(201);

    // Wallet A sees all 3 of its bots
    const botsA = await request(server.app)
      .get('/api/bots')
      .set('Cookie', `siwe_token=${tokenA}`);
    expect(botsA.status).toBe(200);
    expect(botsA.body).toHaveLength(3);
    const botIdsInA = botsA.body.map((b: { id: string }) => b.id).sort();
    expect(botIdsInA).toEqual(['bot-alpha', 'bot-beta', 'bot-gamma']);

    // Wallet B sees only its 1 bot
    const botsB = await request(server.app)
      .get('/api/bots')
      .set('Cookie', `siwe_token=${tokenB}`);
    expect(botsB.status).toBe(200);
    expect(botsB.body).toHaveLength(1);
    expect(botsB.body[0].id).toBe('bot-alpha');
    expect(botsB.body[0].name).toBe('Wallet B - bot-alpha');

    // Cross-check: none of wallet A's bot names appear in wallet B's response
    const namesInB = botsB.body.map((b: { name: string }) => b.name);
    for (const name of namesInB) {
      expect(name).not.toContain('Wallet A');
    }

    // Cross-check: wallet B's bot name does not appear in wallet A's response
    const namesInA = botsA.body.map((b: { name: string }) => b.name);
    for (const name of namesInA) {
      expect(name).not.toContain('Wallet B');
    }
  });

  // ── Trade log path isolation ──────────────────────────────────────────────────

  it('Trade log paths are scoped to each wallet\'s data directory (Requirement 5.2)', async () => {
    const tokenA = await authenticateWallet(server.app, WALLET_A);
    const tokenB = await authenticateWallet(server.app, WALLET_B);

    // Both wallets create a bot with the same ID
    await request(server.app)
      .post('/api/bots')
      .set('Cookie', `siwe_token=${tokenA}`)
      .send(makeBotConfig(SHARED_BOT_ID, 'Wallet A Bot'))
      .expect(201);

    await request(server.app)
      .post('/api/bots')
      .set('Cookie', `siwe_token=${tokenB}`)
      .send(makeBotConfig(SHARED_BOT_ID, 'Wallet B Bot'))
      .expect(201);

    const tenantA = registry.getTenant(WALLET_A)!;
    const tenantB = registry.getTenant(WALLET_B)!;

    const botA = tenantA.botManager.getBot(SHARED_BOT_ID)!;
    const botB = tenantB.botManager.getBot(SHARED_BOT_ID)!;

    // Each bot's tradeLogPath must be within its own tenant's dataDir
    const resolvedPathA = path.resolve(botA.config.tradeLogPath);
    const resolvedPathB = path.resolve(botB.config.tradeLogPath);
    const resolvedDirA = path.resolve(tenantA.dataDir);
    const resolvedDirB = path.resolve(tenantB.dataDir);

    expect(resolvedPathA.startsWith(resolvedDirA)).toBe(true);
    expect(resolvedPathB.startsWith(resolvedDirB)).toBe(true);

    // The two paths must be different (no cross-contamination)
    expect(resolvedPathA).not.toBe(resolvedPathB);

    // Wallet A's trade log must NOT be in wallet B's directory
    expect(resolvedPathA.startsWith(resolvedDirB)).toBe(false);

    // Wallet B's trade log must NOT be in wallet A's directory
    expect(resolvedPathB.startsWith(resolvedDirA)).toBe(false);
  });

  // ── Unauthenticated requests are rejected ────────────────────────────────────

  it('Unauthenticated requests to /api/bots are rejected with 401 (Requirement 4.1)', async () => {
    // No cookie
    const res = await request(server.app).get('/api/bots');
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ error: expect.any(String) });
  });

  // ── Session isolation: wallet A's token cannot access wallet B's bots ────────

  it('Session isolation: wallet A\'s token cannot be used to impersonate wallet B', async () => {
    const tokenA = await authenticateWallet(server.app, WALLET_A);
    const tokenB = await authenticateWallet(server.app, WALLET_B);

    // Wallet A creates a bot
    await request(server.app)
      .post('/api/bots')
      .set('Cookie', `siwe_token=${tokenA}`)
      .send(makeBotConfig('bot-a-only', 'Wallet A Exclusive Bot'))
      .expect(201);

    // Wallet B creates a bot
    await request(server.app)
      .post('/api/bots')
      .set('Cookie', `siwe_token=${tokenB}`)
      .send(makeBotConfig('bot-b-only', 'Wallet B Exclusive Bot'))
      .expect(201);

    // Using wallet A's token returns only wallet A's bots
    const resWithTokenA = await request(server.app)
      .get('/api/bots')
      .set('Cookie', `siwe_token=${tokenA}`);
    expect(resWithTokenA.status).toBe(200);
    const idsWithTokenA = resWithTokenA.body.map((b: { id: string }) => b.id);
    expect(idsWithTokenA).toContain('bot-a-only');
    expect(idsWithTokenA).not.toContain('bot-b-only');

    // Using wallet B's token returns only wallet B's bots
    const resWithTokenB = await request(server.app)
      .get('/api/bots')
      .set('Cookie', `siwe_token=${tokenB}`);
    expect(resWithTokenB.status).toBe(200);
    const idsWithTokenB = resWithTokenB.body.map((b: { id: string }) => b.id);
    expect(idsWithTokenB).toContain('bot-b-only');
    expect(idsWithTokenB).not.toContain('bot-a-only');
  });
});
