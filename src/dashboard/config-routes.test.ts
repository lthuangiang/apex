import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import * as os from 'os';
import * as path from 'path';
import { TradeLogger } from '../ai/TradeLogger.js';
import { DashboardServer } from './server.js';
import type { ConfigStoreInterface, OverridableConfig } from '../config/ConfigStore.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeTempPath(ext: string): string {
  return path.join(os.tmpdir(), `cfg-routes-test-${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`);
}

const BASE_EFFECTIVE: OverridableConfig = {
  ORDER_SIZE_MIN: 0.003,
  ORDER_SIZE_MAX: 0.005,
  STOP_LOSS_PERCENT: 0.05,
  TAKE_PROFIT_PERCENT: 0.05,
  POSITION_SL_PERCENT: 0.05,
  FARM_MIN_HOLD_SECS: 120,
  FARM_MAX_HOLD_SECS: 600,
  FARM_TP_USD: 1.0,
  FARM_SL_PERCENT: 0.05,
  TRADE_TP_PERCENT: 0.10,
  TRADE_SL_PERCENT: 0.10,
  COOLDOWN_MIN_MINS: 2,
  COOLDOWN_MAX_MINS: 10,
};

function makeMockStore(overrides?: Partial<OverridableConfig>): ConfigStoreInterface & {
  getEffective: ReturnType<typeof vi.fn>;
  applyOverrides: ReturnType<typeof vi.fn>;
  resetToDefaults: ReturnType<typeof vi.fn>;
  loadFromDisk: ReturnType<typeof vi.fn>;
} {
  const effective = { ...BASE_EFFECTIVE, ...overrides };
  return {
    getEffective: vi.fn(() => ({ ...effective })),
    applyOverrides: vi.fn(),
    resetToDefaults: vi.fn(),
    loadFromDisk: vi.fn(),
  };
}

function makeServer(passcode?: string): { server: DashboardServer; logPath: string } {
  const logPath = makeTempPath('json');
  const logger = new TradeLogger('json', logPath);
  if (passcode !== undefined) {
    process.env.DASHBOARD_PASSCODE = passcode;
  } else {
    delete process.env.DASHBOARD_PASSCODE;
  }
  const server = new DashboardServer(logger, 0);
  return { server, logPath };
}

// Obtain a valid auth cookie by logging in
async function getAuthCookie(app: Express.Application, passcode: string): Promise<string> {
  const res = await request(app)
    .post('/api/login')
    .send({ passcode });
  const setCookie = res.headers['set-cookie'];
  if (!setCookie) throw new Error('No set-cookie header in login response');
  const cookies = Array.isArray(setCookie) ? setCookie : [setCookie];
  return cookies.map((c: string) => c.split(';')[0]).join('; ');
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('GET /api/config', () => {
  afterEach(() => {
    delete process.env.DASHBOARD_PASSCODE;
  });

  it('returns 200 with effective config when authenticated (no passcode)', async () => {
    const { server } = makeServer();
    const mockStore = makeMockStore();
    server.setConfigStore(mockStore);

    const res = await request(server.app).get('/api/config');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject(BASE_EFFECTIVE);
    expect(mockStore.getEffective).toHaveBeenCalledOnce();
  });

  it('returns 401 when unauthenticated and DASHBOARD_PASSCODE is set', async () => {
    const { server } = makeServer('secret123');
    const mockStore = makeMockStore();
    server.setConfigStore(mockStore);

    const res = await request(server.app).get('/api/config');

    expect(res.status).toBe(401);
    expect(res.body).toHaveProperty('error');
    expect(mockStore.getEffective).not.toHaveBeenCalled();
  });

  it('returns 200 with effective config when authenticated via cookie', async () => {
    const passcode = 'mypassword';
    const { server } = makeServer(passcode);
    const mockStore = makeMockStore();
    server.setConfigStore(mockStore);

    const cookie = await getAuthCookie(server.app, passcode);
    const res = await request(server.app)
      .get('/api/config')
      .set('Cookie', cookie);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject(BASE_EFFECTIVE);
  });
});

describe('POST /api/config', () => {
  afterEach(() => {
    delete process.env.DASHBOARD_PASSCODE;
  });

  it('returns 200 with updated effective config for a valid patch', async () => {
    const { server } = makeServer();
    const updatedEffective = { ...BASE_EFFECTIVE, ORDER_SIZE_MIN: 0.001, ORDER_SIZE_MAX: 0.01 };
    const mockStore = makeMockStore();
    // After applyOverrides, getEffective returns updated values
    mockStore.getEffective
      .mockReturnValueOnce({ ...BASE_EFFECTIVE }) // called inside POST for cross-field validation
      .mockReturnValueOnce({ ...updatedEffective }); // called for response
    server.setConfigStore(mockStore);

    const res = await request(server.app)
      .post('/api/config')
      .send({ ORDER_SIZE_MIN: 0.001, ORDER_SIZE_MAX: 0.01 });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ORDER_SIZE_MIN: 0.001, ORDER_SIZE_MAX: 0.01 });
    expect(mockStore.applyOverrides).toHaveBeenCalledOnce();
  });

  it('returns 400 with errors for invalid values', async () => {
    const { server } = makeServer();
    const mockStore = makeMockStore();
    server.setConfigStore(mockStore);

    const res = await request(server.app)
      .post('/api/config')
      .send({ ORDER_SIZE_MIN: -1 }); // negative — invalid

    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('errors');
    expect(Array.isArray(res.body.errors)).toBe(true);
    expect(res.body.errors.length).toBeGreaterThan(0);
    expect(mockStore.applyOverrides).not.toHaveBeenCalled();
  });

  it('returns 400 when body has no recognised keys', async () => {
    const { server } = makeServer();
    const mockStore = makeMockStore();
    server.setConfigStore(mockStore);

    const res = await request(server.app)
      .post('/api/config')
      .send({ UNKNOWN_KEY: 42 });

    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('errors');
    expect(mockStore.applyOverrides).not.toHaveBeenCalled();
  });

  it('returns 400 when body is empty', async () => {
    const { server } = makeServer();
    const mockStore = makeMockStore();
    server.setConfigStore(mockStore);

    const res = await request(server.app)
      .post('/api/config')
      .send({});

    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('errors');
    expect(mockStore.applyOverrides).not.toHaveBeenCalled();
  });

  it('returns 401 when unauthenticated and DASHBOARD_PASSCODE is set', async () => {
    const { server } = makeServer('secret123');
    const mockStore = makeMockStore();
    server.setConfigStore(mockStore);

    const res = await request(server.app)
      .post('/api/config')
      .send({ ORDER_SIZE_MIN: 0.001 });

    expect(res.status).toBe(401);
    expect(res.body).toHaveProperty('error');
    expect(mockStore.applyOverrides).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/config', () => {
  afterEach(() => {
    delete process.env.DASHBOARD_PASSCODE;
  });

  it('returns 200 with base config after reset', async () => {
    const { server } = makeServer();
    const mockStore = makeMockStore();
    server.setConfigStore(mockStore);

    const res = await request(server.app).delete('/api/config');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject(BASE_EFFECTIVE);
    expect(mockStore.resetToDefaults).toHaveBeenCalledOnce();
    expect(mockStore.getEffective).toHaveBeenCalled();
  });

  it('returns 401 when unauthenticated and DASHBOARD_PASSCODE is set', async () => {
    const { server } = makeServer('secret123');
    const mockStore = makeMockStore();
    server.setConfigStore(mockStore);

    const res = await request(server.app).delete('/api/config');

    expect(res.status).toBe(401);
    expect(res.body).toHaveProperty('error');
    expect(mockStore.resetToDefaults).not.toHaveBeenCalled();
  });

  it('returns 200 with base config when authenticated via cookie', async () => {
    const passcode = 'mypassword';
    const { server } = makeServer(passcode);
    const mockStore = makeMockStore();
    server.setConfigStore(mockStore);

    const cookie = await getAuthCookie(server.app, passcode);
    const res = await request(server.app)
      .delete('/api/config')
      .set('Cookie', cookie);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject(BASE_EFFECTIVE);
    expect(mockStore.resetToDefaults).toHaveBeenCalledOnce();
  });
});
