/**
 * Unit tests for GET /api/admin/stats endpoint.
 *
 * Tests admin authentication middleware and platform stats response shape.
 *
 * Requirements: 9.1, 9.2, 9.3, 9.4
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

// ── Imports after mocks ───────────────────────────────────────────────────────

import request from 'supertest';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { DashboardServer } from '../server.js';
import { TenantRegistry, type PlatformStats } from '../../bot/TenantRegistry.js';
import { TradeLogger } from '../../ai/TradeLogger.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

const ADMIN_TOKEN = 'test-admin-secret-token';

/** Build a DashboardServer wired with a TenantRegistry backed by a temp dir. */
function buildServer(tmpDir: string): { server: DashboardServer; registry: TenantRegistry } {
  const tradeLogger = new TradeLogger('json', path.join(tmpDir, 'trades.json'));
  const server = new DashboardServer(tradeLogger, 0);
  const registry = new TenantRegistry(tmpDir);
  server.registerTenantRegistry(registry);
  return { server, registry };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('GET /api/admin/stats — authentication', () => {
  let tmpDir: string;
  let server: DashboardServer;

  beforeEach(() => {
    // Disable passcode auth so only token-based auth matters
    process.env.DASHBOARD_PASSCODE = '';
    process.env.ADMIN_TOKEN = ADMIN_TOKEN;

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-admin-test-'));
    ({ server } = buildServer(tmpDir));
  });

  afterEach(() => {
    delete process.env.ADMIN_TOKEN;
    vi.restoreAllMocks();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  // ── Requirement 9.2: 401 with no token ─────────────────────────────────────

  it('returns 401 when no Authorization header is present (Requirement 9.2)', async () => {
    const res = await request(server.app)
      .get('/api/admin/stats')
      // No Authorization header, no cookie
      .expect(401);

    expect(res.body).toMatchObject({ error: expect.any(String) });
  });

  // ── Requirement 9.4: 401 when only siwe_token cookie is present ────────────

  it('returns 401 when only siwe_token cookie is present — wallet sessions must not grant admin access (Requirement 9.4)', async () => {
    // Use a plausible-looking siwe_token (64 hex chars) — not a real admin token
    const fakeSiweToken = 'a'.repeat(64);

    const res = await request(server.app)
      .get('/api/admin/stats')
      .set('Cookie', `siwe_token=${fakeSiweToken}`)
      // No Authorization: Bearer header
      .expect(401);

    expect(res.body).toMatchObject({ error: expect.any(String) });
  });

  it('returns 401 when Authorization header has wrong token (Requirement 9.2)', async () => {
    const res = await request(server.app)
      .get('/api/admin/stats')
      .set('Authorization', 'Bearer wrong-token')
      .expect(401);

    expect(res.body).toMatchObject({ error: expect.any(String) });
  });

  // ── Requirement 9.3: 200 with correct Bearer token ─────────────────────────

  it('returns 200 with correct Authorization: Bearer header (Requirement 9.3)', async () => {
    const res = await request(server.app)
      .get('/api/admin/stats')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .expect(200);

    expect(res.headers['content-type']).toMatch(/json/);
  });

  // ── Requirement 9.3: siwe_token + valid Bearer still works ─────────────────

  it('returns 200 when both siwe_token cookie and valid Bearer header are present (Requirement 9.3)', async () => {
    // The admin token takes precedence; siwe_token presence should not block access
    const fakeSiweToken = 'b'.repeat(64);

    const res = await request(server.app)
      .get('/api/admin/stats')
      .set('Cookie', `siwe_token=${fakeSiweToken}`)
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .expect(200);

    expect(res.headers['content-type']).toMatch(/json/);
  });

  // ── Requirement 9.1: returned stats shape matches PlatformStats ────────────

  it('returned stats shape matches PlatformStats interface (Requirement 9.1)', async () => {
    const res = await request(server.app)
      .get('/api/admin/stats')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .expect(200);

    const body = res.body as PlatformStats;

    // All required fields must be present and be numbers
    expect(typeof body.totalTenants).toBe('number');
    expect(typeof body.activeTenants).toBe('number');
    expect(typeof body.totalBots).toBe('number');
    expect(typeof body.activeBots).toBe('number');
    expect(typeof body.totalVolumeUsd).toBe('number');
    expect(typeof body.totalPnlUsd).toBe('number');
  });

  it('returns zero stats when no tenants are registered (Requirement 9.1)', async () => {
    const res = await request(server.app)
      .get('/api/admin/stats')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .expect(200);

    const body = res.body as PlatformStats;

    expect(body.totalTenants).toBe(0);
    expect(body.activeTenants).toBe(0);
    expect(body.totalBots).toBe(0);
    expect(body.activeBots).toBe(0);
    expect(body.totalVolumeUsd).toBe(0);
    expect(body.totalPnlUsd).toBe(0);
  });

  // ── Requirement 9.5: activeTenants counts only tenants with ≥1 RUNNING bot ─

  it('activeTenants reflects only tenants with at least one RUNNING bot (Requirement 9.5)', async () => {
    const { registry } = buildServer(tmpDir);

    // Create a mock adapter
    const mockAdapter = {
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

    const mockTelegram = { sendMessage: vi.fn() } as any;

    // Tenant A: has a RUNNING bot
    const tenantA = registry.ensureTenant('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    const botConfigA = {
      id: 'bot-a',
      name: 'Bot A',
      exchange: 'sodex',
      symbol: 'BTC-USD',
      credentialKey: 'TEST_KEY',
      tradeLogBackend: 'json' as const,
      tradeLogPath: path.join(tmpDir, 'trades-bot-a.json'),
      autoStart: false,
      mode: 'farm' as const,
      orderSizeMin: 0.003,
      orderSizeMax: 0.005,
      tags: [],
    };
    const botA = tenantA.botManager.createBot(botConfigA, mockAdapter, mockTelegram);
    botA.state.botStatus = 'RUNNING'; // simulate running

    // Tenant B: has only a STOPPED bot
    const tenantB = registry.ensureTenant('0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
    const botConfigB = { ...botConfigA, id: 'bot-b', name: 'Bot B', tradeLogPath: path.join(tmpDir, 'trades-bot-b.json') };
    const botB = tenantB.botManager.createBot(botConfigB, mockAdapter, mockTelegram);
    botB.state.botStatus = 'STOPPED';

    const stats = registry.getPlatformStats();

    expect(stats.totalTenants).toBe(2);
    expect(stats.activeTenants).toBe(1); // only tenant A has a running bot
    expect(stats.totalBots).toBe(2);
    expect(stats.activeBots).toBe(1);
  });

  // ── 503 when ADMIN_TOKEN is not configured ──────────────────────────────────

  it('returns 503 when ADMIN_TOKEN env var is not set', async () => {
    delete process.env.ADMIN_TOKEN;

    const tradeLogger = new TradeLogger('json', path.join(tmpDir, 'trades2.json'));
    const serverNoToken = new DashboardServer(tradeLogger, 0);
    const registry2 = new TenantRegistry(tmpDir);
    serverNoToken.registerTenantRegistry(registry2);

    const res = await request(serverNoToken.app)
      .get('/api/admin/stats')
      .set('Authorization', 'Bearer anything')
      .expect(503);

    expect(res.body).toMatchObject({ error: expect.any(String) });
  });
});
