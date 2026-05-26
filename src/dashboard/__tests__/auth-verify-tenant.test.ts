/**
 * Unit tests for POST /api/auth/verify — tenant creation on first login.
 *
 * Task 6.2: Verify that a successful SIWE verify triggers `ensureTenant` on
 * the TenantRegistry and that the tenant's data directory is created.
 *
 * Requirements: 3.1, 7.1
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

// ── Mock SiweAuth so we don't need real wallet signatures ─────────────────────
vi.mock('../../auth/SiweAuth.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../auth/SiweAuth.js')>();
  return {
    ...original,
    generateNonce: original.generateNonce,
    verifySiweMessage: vi.fn(),
  };
});

import { verifySiweMessage } from '../../auth/SiweAuth.js';

// ── Imports after mocks ───────────────────────────────────────────────────────

import request from 'supertest';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { DashboardServer } from '../server.js';
import { TradeLogger } from '../../ai/TradeLogger.js';
import { TenantRegistry } from '../../bot/TenantRegistry.js';

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'apex-auth-test-'));
}

function makeServer(): DashboardServer {
  // Disable passcode auth so the auth middleware doesn't block /api/auth/verify
  process.env.DASHBOARD_PASSCODE = '';
  const logger = new TradeLogger('json', path.join(os.tmpdir(), `test-trades-${Date.now()}.json`));
  return new DashboardServer(logger, 0);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('POST /api/auth/verify — tenant creation (Requirements 3.1, 7.1)', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir();
    vi.clearAllMocks();
  });

  afterEach(() => {
    // Clean up temp directory
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  // ── Test 1: ensureTenant is called on successful SIWE verify ─────────────

  it('calls ensureTenant on the registry when SIWE verify succeeds', async () => {
    const walletAddress = '0xabcdef1234567890abcdef1234567890abcdef12';

    // Arrange: mock verifySiweMessage to return success
    vi.mocked(verifySiweMessage).mockReturnValue({
      ok: true,
      address: walletAddress,
    });

    const server = makeServer();

    // Create a real TenantRegistry backed by a temp dir and spy on ensureTenant
    const registry = new TenantRegistry(tempDir);
    const ensureTenantSpy = vi.spyOn(registry, 'ensureTenant');

    server.registerTenantRegistry(registry);

    // Act
    const res = await request(server.app)
      .post('/api/auth/verify')
      .send({ message: 'test-message', signature: '0xsig' });

    // Assert: HTTP 200 and ensureTenant was called with the wallet address
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(ensureTenantSpy).toHaveBeenCalledOnce();
    expect(ensureTenantSpy).toHaveBeenCalledWith(walletAddress);
  });

  // ── Test 2: ensureTenant is NOT called when SIWE verify fails ────────────

  it('does NOT call ensureTenant when SIWE verify fails', async () => {
    // Arrange: mock verifySiweMessage to return failure
    vi.mocked(verifySiweMessage).mockReturnValue({
      ok: false,
      error: 'Invalid signature',
    });

    const server = makeServer();
    const registry = new TenantRegistry(tempDir);
    const ensureTenantSpy = vi.spyOn(registry, 'ensureTenant');

    server.registerTenantRegistry(registry);

    // Act
    const res = await request(server.app)
      .post('/api/auth/verify')
      .send({ message: 'bad-message', signature: '0xbadsig' });

    // Assert: HTTP 401 and ensureTenant was never called
    expect(res.status).toBe(401);
    expect(ensureTenantSpy).not.toHaveBeenCalled();
  });

  // ── Test 3: data directory is created on first login ─────────────────────

  it("creates the tenant's data directory on first login (Requirement 7.1)", async () => {
    const walletAddress = '0x1111222233334444555566667777888899990000';

    vi.mocked(verifySiweMessage).mockReturnValue({
      ok: true,
      address: walletAddress,
    });

    const server = makeServer();
    const registry = new TenantRegistry(tempDir);
    server.registerTenantRegistry(registry);

    // The directory should not exist yet
    const expectedDir = path.join(tempDir, walletAddress.toLowerCase());
    expect(fs.existsSync(expectedDir)).toBe(false);

    // Act
    const res = await request(server.app)
      .post('/api/auth/verify')
      .send({ message: 'test-message', signature: '0xsig' });

    // Assert: HTTP 200 and the data directory now exists
    expect(res.status).toBe(200);
    expect(fs.existsSync(expectedDir)).toBe(true);
    expect(fs.statSync(expectedDir).isDirectory()).toBe(true);
  });

  // ── Test 4: data directory is NOT created when SIWE verify fails ─────────

  it('does NOT create a data directory when SIWE verify fails', async () => {
    const walletAddress = '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef';

    vi.mocked(verifySiweMessage).mockReturnValue({
      ok: false,
      error: 'Signature mismatch',
    });

    const server = makeServer();
    const registry = new TenantRegistry(tempDir);
    server.registerTenantRegistry(registry);

    // Act
    const res = await request(server.app)
      .post('/api/auth/verify')
      .send({ message: 'bad-message', signature: '0xbadsig' });

    // Assert: HTTP 401 and no directory was created
    expect(res.status).toBe(401);
    const expectedDir = path.join(tempDir, walletAddress.toLowerCase());
    expect(fs.existsSync(expectedDir)).toBe(false);
  });

  // ── Test 5: ensureTenant is idempotent — second login reuses context ──────

  it('returns the same TenantContext on repeated logins (idempotent)', async () => {
    const walletAddress = '0xaaaa0000bbbb1111cccc2222dddd3333eeee4444';

    vi.mocked(verifySiweMessage).mockReturnValue({
      ok: true,
      address: walletAddress,
    });

    const server = makeServer();
    const registry = new TenantRegistry(tempDir);
    const ensureTenantSpy = vi.spyOn(registry, 'ensureTenant');
    server.registerTenantRegistry(registry);

    // First login
    await request(server.app)
      .post('/api/auth/verify')
      .send({ message: 'msg1', signature: '0xsig1' });

    // Second login
    await request(server.app)
      .post('/api/auth/verify')
      .send({ message: 'msg2', signature: '0xsig2' });

    // ensureTenant called twice but returns the same context (idempotent)
    expect(ensureTenantSpy).toHaveBeenCalledTimes(2);

    const firstContext = ensureTenantSpy.mock.results[0].value;
    const secondContext = ensureTenantSpy.mock.results[1].value;
    expect(firstContext).toBe(secondContext); // same object reference

    // Directory still exists and was not recreated
    const expectedDir = path.join(tempDir, walletAddress.toLowerCase());
    expect(fs.existsSync(expectedDir)).toBe(true);
  });

  // ── Test 6: works gracefully when no TenantRegistry is registered ─────────

  it('succeeds and issues a cookie even when no TenantRegistry is registered', async () => {
    const walletAddress = '0x9999888877776666555544443333222211110000';

    vi.mocked(verifySiweMessage).mockReturnValue({
      ok: true,
      address: walletAddress,
    });

    // Server with no registry registered
    const server = makeServer();

    const res = await request(server.app)
      .post('/api/auth/verify')
      .send({ message: 'test-message', signature: '0xsig' });

    // Should still succeed — tenantRegistry?.ensureTenant uses optional chaining
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.address).toBe(walletAddress);
    // siwe_token cookie should be set
    const setCookie = res.headers['set-cookie'] as string[] | string | undefined;
    const cookieStr = Array.isArray(setCookie) ? setCookie.join('; ') : (setCookie ?? '');
    expect(cookieStr).toMatch(/siwe_token=/);
  });

  // ── Test 7: wallet address is normalized to lowercase ────────────────────

  it('normalizes the wallet address to lowercase when creating the tenant', async () => {
    // verifySiweMessage returns a checksummed (mixed-case) address
    const checksummedAddress = '0xAbCdEf1234567890AbCdEf1234567890AbCdEf12';
    const lowercaseAddress = checksummedAddress.toLowerCase();

    vi.mocked(verifySiweMessage).mockReturnValue({
      ok: true,
      address: checksummedAddress,
    });

    const server = makeServer();
    const registry = new TenantRegistry(tempDir);
    server.registerTenantRegistry(registry);

    await request(server.app)
      .post('/api/auth/verify')
      .send({ message: 'test-message', signature: '0xsig' });

    // The data directory should use the lowercase address
    const expectedDir = path.join(tempDir, lowercaseAddress);
    expect(fs.existsSync(expectedDir)).toBe(true);

    // The TenantContext should store the lowercase address
    const tenant = registry.getTenant(lowercaseAddress);
    expect(tenant).toBeDefined();
    expect(tenant!.walletAddress).toBe(lowercaseAddress);
  });

  // ── Test 8: missing message/signature returns 400 without calling ensureTenant

  it('returns 400 and does not call ensureTenant when message or signature is missing', async () => {
    const server = makeServer();
    const registry = new TenantRegistry(tempDir);
    const ensureTenantSpy = vi.spyOn(registry, 'ensureTenant');
    server.registerTenantRegistry(registry);

    // Missing signature
    const res = await request(server.app)
      .post('/api/auth/verify')
      .send({ message: 'test-message' });

    expect(res.status).toBe(400);
    expect(ensureTenantSpy).not.toHaveBeenCalled();
  });
});
