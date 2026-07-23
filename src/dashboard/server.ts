import express, { Request, Response, NextFunction } from 'express';
import { createHash, randomBytes } from 'crypto';
import path from 'path';
import fs from 'fs';
import { TradeLogger } from '../ai/TradeLogger.js';
import { AnalyticsEngine, AnalyticsSummary } from '../ai/AnalyticsEngine.js';
import { sharedState, addSseClient, removeSseClient, addConsoleSseClient, removeConsoleSseClient } from '../ai/sharedState.js';
import { memoryRouter } from '../ai/TradingMemory/routes.js';
import { SessionManager } from '../modules/SessionManager.js';
import { Watcher } from '../modules/Watcher.js';
import { config } from '../config.js';
import type { ConfigStoreInterface, OverridableConfig } from '../config/ConfigStore.js';
import { validateOverrides } from '../config/validateOverrides.js';
import { weightStore } from '../ai/FeedbackLoop/WeightStore.js';
import { componentPerformanceTracker } from '../ai/FeedbackLoop/ComponentPerformanceTracker.js';
import { confidenceCalibrator } from '../ai/FeedbackLoop/ConfidenceCalibrator.js';
import type { BotManager } from '../bot/BotManager.js';
import { BotInstance } from '../bot/BotInstance.js';
import { saveBotConfigsToFile } from '../bot/persistBotConfigs.js';
import { validateBotConfig, validatePairBotConfig, validateDeltaNeutralConfig } from '../bot/loadBotConfigs.js';
import { createAdapter as createBotAdapter, createAdapterFromCredentials } from '../bot/adapterFactory.js';
import type { TenantRegistry } from '../bot/TenantRegistry.js';
import type { TenantContext } from '../bot/TenantContext.js';
import type { BotCredentials } from '../bot/CredentialStore.js';
import type { AgentLayer } from '../bot/AgentLayer.js';

/**
 * Extended Express Request that carries wallet identity and tenant context.
 * Attached by `walletScopedMiddleware` after successful token validation.
 *
 * Requirements: 4.3, 4.5
 */
export interface WalletScopedRequest extends Request {
  walletAddress: string;
  tenant: TenantContext;
}
import type { PairBotConfig } from '../bot/types.js';
import type { TelegramManager } from '../modules/TelegramManager.js';
import { generateNonce, verifySiweMessage } from '../auth/SiweAuth.js';
import { createBacktestRouter } from './routes/backtestRoutes.js';
import { HistoricalDataFeed } from '../backtest/HistoricalDataFeed.js';


const validTokens = new Map<string, number>();
const validTokenAddresses = new Map<string, string>(); // siwe_token → wallet address
const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

const TEMPLATE_ENGINE = 'ejs' as const;
const VIEWS_DIR = path.join(__dirname, 'views');

function generateToken(): string { return randomBytes(32).toString('hex'); }
function hashPasscode(p: string): string { return createHash('sha256').update(p).digest('hex'); }

export class DashboardServer {
  private tradeLogger: TradeLogger;
  private port: number;
  private passcodeHash: string | null;
  private configStore: ConfigStoreInterface | null = null;
  private botManager: BotManager | null = null;
  private tenantRegistry: TenantRegistry | null = null;
  private _telegram: TelegramManager | null = null;
  private _agentLayer: AgentLayer | null = null;
  private _sopointsCache: { summary: any; week: any } = { summary: null, week: null };
  private _analyticsCache: { summary: AnalyticsSummary | null; cachedAt: number } = { summary: null, cachedAt: 0 };
  private _analyticsEngine = new AnalyticsEngine();
  private _sosoSnapshotCache: { data: unknown; fetchedAt: number } | null = null;
  readonly app: express.Application;

  constructor(tradeLogger: TradeLogger, port: number) {
    this.tradeLogger = tradeLogger;
    this.port = port;
    const passcode = process.env.DASHBOARD_PASSCODE;
    this.passcodeHash = passcode ? hashPasscode(passcode) : null;
    this.app = express();
    this.app.set('view engine', TEMPLATE_ENGINE);
    this.app.set('views', VIEWS_DIR);
    this._validateViewsDir();
    this.app.use(express.json());
    this.tradeLogger.onTradeLogged = () => { this._analyticsCache.cachedAt = 0; };
    this._setupRoutes();
  }

  setConfigStore(store: ConfigStoreInterface): void {
    this.configStore = store;
  }

  /**
   * Register BotManager for multi-bot support (used by tenant routes)
   */
  registerBotManager(manager: BotManager, telegram?: TelegramManager): void {
    this.botManager = manager;
    if (telegram) this._telegram = telegram;
    console.log('[DashboardServer] BotManager registered');
    this._setupManagerRoutes();
  }

  /**
   * Resolve the correct BotManager for a request.
   * In multi-wallet SaaS mode, returns the tenant's BotManager.
   * Falls back to the global botManager for backward compat.
   */
  private _resolveManager(req: Request): BotManager | null {
    return (req as WalletScopedRequest).tenant?.botManager ?? this.botManager;
  }

  /**
   * Register TenantRegistry for multi-wallet SaaS support.
   * Must be called before the server starts listening.
   */
  registerTenantRegistry(registry: TenantRegistry, telegram?: TelegramManager): void {
    this.tenantRegistry = registry;
    if (telegram) this._telegram = telegram;
    console.log('[DashboardServer] TenantRegistry registered');
    this._setupManagerRoutes();
  }

  /**
   * Register the AgentLayer for autonomous orchestration API endpoints.
   * Exposes /agent/status, /agent/history, /agent/config
   */
  registerAgentLayer(agent: AgentLayer): void {
    this._agentLayer = agent;
    this._setupAgentRoutes();
    console.log('[DashboardServer] AgentLayer registered');
  }

  private _isAuthenticated(req: Request): boolean {
    // If no passcode is configured, allow all (local dev)
    if (!this.passcodeHash) return true;
    // Check both dash_token (passcode auth) and siwe_token (wallet auth)
    const cookies = req.headers.cookie || '';
    // Match either token — try siwe_token first, then dash_token
    const siweMatch = cookies.match(/siwe_token=([a-f0-9]+)/);
    const dashMatch = cookies.match(/dash_token=([a-f0-9]+)/);
    const token = (siweMatch && siweMatch[1]) || (dashMatch && dashMatch[1]);
    if (!token) {
      console.log('[Auth] no token in cookies:', cookies.slice(0, 80));
      return false;
    }
    const expiry = validTokens.get(token);
    if (!expiry || Date.now() > expiry) {
      validTokens.delete(token);
      console.log('[Auth] token expired or not found:', token.slice(0, 8));
      return false;
    }
    return true;
  }

  private _authMiddleware = (req: Request, res: Response, next: NextFunction): void => {
    if (
      req.path === '/login' ||
      req.path === '/wallet-login' ||
      req.path === '/api/login' ||
      req.path === '/api/auth/nonce' ||
      req.path === '/api/auth/verify' ||
      req.path === '/api/auth/logout'
    ) { next(); return; }
    if (!this._isAuthenticated(req)) {
      if (req.path.startsWith('/api/')) { res.status(401).json({ error: 'Unauthorized' }); }
      else { res.redirect('/wallet-login'); }
      return;
    }
    // Attach tenant context from SIWE token wallet address
    this._attachTenantContext(req);
    next();
  };

  private _attachTenantContext(req: Request): void {
    if (!this.tenantRegistry) return;
    const cookies = req.headers.cookie || '';
    const siweMatch = cookies.match(/siwe_token=([a-f0-9]+)/);
    if (!siweMatch) return;
    const walletAddress = validTokenAddresses.get(siweMatch[1]);
    if (!walletAddress) return;
    const tenant = this.tenantRegistry.ensureTenant(walletAddress);
    (req as any).walletAddress = walletAddress;
    (req as any).tenant = tenant;
  }

  private _validateViewsDir(): void {
    if (!fs.existsSync(VIEWS_DIR)) {
      console.error(`[DashboardServer] FATAL: Views directory not found: ${VIEWS_DIR}`);
      process.exit(1);
    }
  }

  private _setupRoutes(): void {
    const PUBLIC_DIR = path.join(__dirname, 'public');
    // Only serve static assets (css, js) — NOT index.html directly
    // index.html is served via EJS render after auth check
    this.app.use('/css', express.static(path.join(PUBLIC_DIR, 'css')));
    this.app.use('/js', express.static(path.join(PUBLIC_DIR, 'js')));
    this.app.use('/images', express.static(path.join(PUBLIC_DIR, 'images')));
    // Public routes — no auth required
    this.app.get('/', (_req, res) => { res.redirect('/landing'); });
    this.app.get('/landing', (_req, res) => {
      res.sendFile(path.join(__dirname, 'public', 'landing.html'));
    });
    // /login redirects to wallet-login — passcode auth is hidden (wallet-only mode)
    this.app.get('/login', (_req, res) => { res.redirect('/wallet-login'); });
    this.app.get('/wallet-login', (_req, res) => {
      res.sendFile(path.join(__dirname, 'public', 'wallet-login.html'));
    });
    this.app.use(this._authMiddleware);

    this.app.post('/api/login', (req: Request, res: Response) => {
      const { passcode } = req.body as { passcode?: string };
      if (!passcode || hashPasscode(passcode) !== this.passcodeHash) { res.status(401).json({ error: 'Invalid passcode' }); return; }
      const token = generateToken();
      validTokens.set(token, Date.now() + TOKEN_TTL_MS);
      res.setHeader('Set-Cookie', `dash_token=${token}; Path=/; HttpOnly; Max-Age=${TOKEN_TTL_MS / 1000}`);
      res.json({ ok: true });
    });

    // ── SIWE (Sign-In with Ethereum) Routes ───────────────────────────────────

    // GET /api/auth/nonce — issue a one-time nonce for the client to include in the SIWE message
    this.app.get('/api/auth/nonce', (_req, res) => {
      const nonce = generateNonce();
      res.json({ nonce });
    });

    // POST /api/auth/verify — verify a signed SIWE message and issue a session token
    this.app.post('/api/auth/verify', (req: Request, res: Response) => {
      const { message, signature } = req.body as { message?: string; signature?: string };
      if (!message || !signature) {
        res.status(400).json({ error: 'message and signature are required' });
        return;
      }
      console.log('[SIWE] verify request — message length:', message.length, '| sig prefix:', signature.slice(0, 10));
      const result = verifySiweMessage(message, signature);
      console.log('[SIWE] verify result:', result.ok ? `OK addr=${result.address}` : `FAIL: ${result.error}`);
      if (!result.ok) {
        res.status(401).json({ error: result.error ?? 'Verification failed' });
        return;
      }
      const token = generateToken();
      validTokens.set(token, Date.now() + TOKEN_TTL_MS);
      validTokenAddresses.set(token, result.address!);
      res.setHeader('Set-Cookie', `siwe_token=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${TOKEN_TTL_MS / 1000}`);
      res.json({ ok: true, address: result.address });
    });

    // GET /api/auth/me — return the wallet address for the current session
    this.app.get('/api/auth/me', (req: Request, res: Response) => {
      const cookies = req.headers.cookie || '';
      const siweMatch = cookies.match(/siwe_token=([a-f0-9]+)/);
      const dashMatch = cookies.match(/dash_token=([a-f0-9]+)/);
      const token = (siweMatch && siweMatch[1]) || (dashMatch && dashMatch[1]);
      if (!token || !validTokens.get(token)) {
        res.status(401).json({ error: 'Not authenticated' });
        return;
      }
      // siwe_token carries the address; dash_token is passcode-only (no address)
      const address = siweMatch ? (validTokenAddresses.get(siweMatch[1]) ?? null) : null;
      res.json({ ok: true, address, authType: siweMatch ? 'wallet' : 'passcode' });
    });

    // POST /api/auth/logout — clear the wallet session cookie
    this.app.post('/api/auth/logout', (req: Request, res: Response) => {
      const cookies = req.headers.cookie || '';
      const siweMatch = cookies.match(/siwe_token=([a-f0-9]+)/);
      const dashMatch = cookies.match(/dash_token=([a-f0-9]+)/);
      const token = (siweMatch && siweMatch[1]) || (dashMatch && dashMatch[1]);
      if (token) {
        validTokens.delete(token);
        validTokenAddresses.delete(token);
      }
      res.setHeader('Set-Cookie', [
        'siwe_token=; Path=/; HttpOnly; Max-Age=0',
        'dash_token=; Path=/; HttpOnly; Max-Age=0',
      ]);
      res.json({ ok: true });
    });

    this.app.get('/dashboard', (_req, res) => {
      console.log('[DEBUG] /dashboard hit, tenantRegistry:', !!this.tenantRegistry);
      // SaaS Mode: Always render tenant manager view
      res.render('manager', (err: Error | null, html: string) => {
        if (err) {
          console.error('[DashboardServer] Manager template render error:', err);
          res.status(500).send(`Template render error: ${err.message}`);
          return;
        }
        res.setHeader('Content-Type', 'text/html');
        res.send(html);
      });
    });

    // Performance Analytics page — standalone HTML with charts
    this.app.get('/performance', (_req, res) => {
      res.sendFile(path.join(__dirname, 'public', 'performance.html'));
    });

    // Portfolio page — aggregated view of all accounts and positions
    this.app.get('/portfolio', (_req, res) => {
      res.render('portfolio', (err: Error | null, html: string) => {
        if (err) {
          console.error('[DashboardServer] Portfolio template render error:', err);
          res.status(500).send(`Template render error: ${err.message}`);
          return;
        }
        res.setHeader('Content-Type', 'text/html');
        res.send(html);
      });
    });

    // Reports page — trade analytics, volume, PnL breakdowns
    this.app.get('/reports', (_req, res) => {
      res.render('reports', (err: Error | null, html: string) => {
        if (err) {
          console.error('[DashboardServer] Reports template render error:', err);
          res.status(500).send(`Template render error: ${err.message}`);
          return;
        }
        res.setHeader('Content-Type', 'text/html');
        res.send(html);
      });
    });

    this.app.get('/api/trades', async (_req, res) => {
      try { res.json(await this.tradeLogger.readAll()); } catch (err) { res.status(500).json({ error: String(err) }); }
    });

    this.app.get('/api/pnl', (_req, res) => {
      res.json({ sessionPnl: sharedState.sessionPnl, sessionVolume: sharedState.sessionVolume, todayVolume: sharedState.todayVolume, updatedAt: sharedState.updatedAt, botStatus: sharedState.botStatus, symbol: sharedState.symbol, walletAddress: sharedState.walletAddress, pnlHistory: sharedState.pnlHistory, volumeHistory: sharedState.volumeHistory });
    });

    this.app.get('/api/events', (_req, res) => res.json(sharedState.eventLog));

    this.app.get('/api/events/stream', (req, res) => {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders();
      const send = (d: string) => res.write(`data: ${d}\n\n`);
      addSseClient(send);
      sharedState.eventLog.slice(0, 20).reverse().forEach(e => send(JSON.stringify(e)));
      req.on('close', () => removeSseClient(send));
    });

    this.app.get('/api/console/stream', (req, res) => {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders();
      const send = (d: string) => res.write(`data: ${d}\n\n`);
      addConsoleSseClient(send);
      req.on('close', () => removeConsoleSseClient(send));
    });

    this.app.get('/api/position', (_req, res) => res.json(sharedState.openPosition));

    this.app.use('/api/memory', memoryRouter);

    this.app.post('/api/control/start', async (_req, res) => {
      res.status(410).json({ error: 'Single-bot control removed. Use tenant bot API: POST /api/bots/:id/start' });
    });

    this.app.post('/api/control/stop', (_req, res) => {
      res.status(410).json({ error: 'Single-bot control removed. Use tenant bot API: POST /api/bots/:id/stop' });
    });

    this.app.post('/api/control/set_mode', (_req, res) => {
      res.status(410).json({ error: 'Single-bot control removed. Use tenant bot API: PATCH /api/bots/:id/config' });
    });

    this.app.post('/api/control/set_max_loss', (_req, res) => {
      res.status(410).json({ error: 'Single-bot control removed. Use tenant bot API: PATCH /api/bots/:id/config' });
    });

    this.app.get('/api/control/status', async (_req, res) => {
      res.status(410).json({ error: 'Single-bot control removed. Use tenant bot API: GET /api/bots/:id/status' });
    });

    this.app.post('/api/control/close_position', async (_req, res) => {
      res.status(410).json({ error: 'Single-bot control removed. Use tenant bot API: POST /api/bots/:id/close' });
    });

    this.app.get('/api/sopoints', async (_req, res) => {
      const token = process.env.SODEX_SOPOINTS_TOKEN;
      if (!token) {
        if (this._sopointsCache.summary) return res.json({ ...this._sopointsCache.summary, stale: true });
        res.status(503).json({ error: 'SODEX_SOPOINTS_TOKEN not set' }); return;
      }
      try {
        const r = await (await import('axios')).default.get('https://alpha-biz.sodex.dev/biz/sopoints/summary', { headers: { Authorization: `Bearer ${token}` }, timeout: 8000 });
        const data = r.data?.data ?? r.data;
        this._sopointsCache.summary = data;
        res.json(data);
      } catch (err: any) {
        if (this._sopointsCache.summary) { res.json({ ...this._sopointsCache.summary, stale: true }); return; }
        res.status(502).json({ error: err?.message });
      }
    });

    this.app.get('/api/sopoints/week', async (_req, res) => {
      const token = process.env.SODEX_SOPOINTS_TOKEN;
      if (!token) {
        if (this._sopointsCache.week) return res.json({ ...this._sopointsCache.week, stale: true });
        res.status(503).json({ error: 'SODEX_SOPOINTS_TOKEN not set' }); return;
      }
      try {
        const r = await (await import('axios')).default.get('https://alpha-biz.sodex.dev/biz/sopoints/week/list', { headers: { Authorization: `Bearer ${token}` }, timeout: 8000 });
        const list: any[] = r.data?.data ?? [];
        const week = list.find((w: any) => w.isLive === true) ?? null;
        if (week) this._sopointsCache.week = week;
        res.json(week ?? (this._sopointsCache.week ? { ...this._sopointsCache.week, stale: true } : null));
      } catch (err: any) {
        if (this._sopointsCache.week) { res.json({ ...this._sopointsCache.week, stale: true }); return; }
        res.status(502).json({ error: err?.message });
      }
    });

    this.app.post('/api/sopoints/token', (req, res) => {
      const { token } = req.body as { token?: string };
      if (!token || typeof token !== 'string' || token.trim().length < 10) {
        res.status(400).json({ error: 'Invalid token' }); return;
      }
      process.env.SODEX_SOPOINTS_TOKEN = token.trim();
      console.log('[Dashboard] SODEX_SOPOINTS_TOKEN updated at runtime');
      res.json({ ok: true });
    });

    // ── Decibel Points API ────────────────────────────────────────────────────
    // GET /api/decibel-points — fetch tier/points/rank from Decibel Points API
    this.app.get('/api/decibel-points', async (_req, res) => {
      const token = process.env.DECIBEL_POINTS_API_KEY;
      const owner = process.env.DECIBEL_POINTS_OWNER ?? process.env.DECIBELS_SUBACCOUNT;
      if (!token || !owner) {
        res.status(503).json({ error: 'DECIBEL_POINTS_API_KEY or owner address not set' }); return;
      }
      try {
        const r = await (await import('axios')).default.get(
          `https://api.mainnet.aptoslabs.com/decibel/api/v1/points/tier?owner=${owner}`,
          {
            headers: {
              Authorization: `Bearer ${token}`,
              origin: 'https://app.decibel.trade',
            },
            timeout: 8000,
          }
        );
        res.json(r.data);
      } catch (err: any) {
        res.status(502).json({ error: err?.message ?? 'Failed to fetch Decibel points' });
      }
    });

    // POST /api/decibel-points/config — update token/owner at runtime
    this.app.post('/api/decibel-points/config', (req, res) => {
      const { token, owner } = req.body as { token?: string; owner?: string };
      if (token && token.trim().length > 5) {
        process.env.DECIBEL_POINTS_API_KEY = token.trim();
      }
      if (owner && owner.trim().startsWith('0x')) {
        process.env.DECIBEL_POINTS_OWNER = owner.trim();
      }
      res.json({ ok: true });
    });

    // ── Config Override Routes ────────────────────────────────────────────────

    const OVERRIDABLE_KEYS: (keyof OverridableConfig)[] = [
      'ORDER_SIZE_MIN', 'ORDER_SIZE_MAX',
      'FARM_MIN_HOLD_SECS', 'FARM_MAX_HOLD_SECS', 'FARM_TP_USD',
      'FARM_SL_PERCENT', 'FARM_SCORE_EDGE', 'FARM_MIN_CONFIDENCE', 'FARM_EARLY_EXIT_SECS',
      'FARM_EARLY_EXIT_PNL', 'FARM_MIN_PROFIT_FEE_MULT', 'FARM_EXTRA_WAIT_SECS', 'FARM_BLOCKED_HOURS', 'FARM_COOLDOWN_SECS',
      'FARM_MIN_CONFIDENCE_PRESSURE_GATE', 'FARM_MIN_FALLBACK_CONFIDENCE',
      'FARM_SIDEWAY_MIN_CONFIDENCE', 'FARM_TREND_MIN_CONFIDENCE',
      'FARM_REVERSE_SIGNAL_ENABLED', 'FARM_USE_DYNAMIC_SIZING',
      'TRADE_TP_PERCENT', 'TRADE_SL_PERCENT',
      'COOLDOWN_MIN_MINS', 'COOLDOWN_MAX_MINS', 'MIN_POSITION_VALUE_USD',
    ];

    this.app.get('/api/config', (_req, res) => {
      if (!this.configStore) { res.status(503).json({ error: 'Config store not available' }); return; }
      try {
        res.json(this.configStore.getEffective());
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    this.app.post('/api/config', (req, res) => {
      if (!this.configStore) { res.status(503).json({ error: 'Config store not available' }); return; }
      try {
        const body = req.body as Record<string, unknown>;
        const hasRecognisedKey = OVERRIDABLE_KEYS.some(k => k in body);
        if (!body || !hasRecognisedKey) {
          res.status(400).json({ errors: [{ field: '*', message: 'No recognised config keys in request body' }] });
          return;
        }
        const patch: Partial<OverridableConfig> = {};
        for (const key of OVERRIDABLE_KEYS) {
          if (key in body) (patch as Record<string, unknown>)[key] = body[key];
        }
        const errors = validateOverrides(patch, this.configStore.getEffective());
        if (errors.length > 0) { res.status(400).json({ errors }); return; }
        this.configStore.applyOverrides(patch);
        res.json(this.configStore.getEffective());
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    this.app.delete('/api/config', (_req, res) => {
      if (!this.configStore) { res.status(503).json({ error: 'Config store not available' }); return; }
      try {
        this.configStore.resetToDefaults();
        res.json(this.configStore.getEffective());
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    // ── Analytics Routes ──────────────────────────────────────────────────────

    this.app.get('/api/analytics/summary', async (_req, res) => {
      try {
        const now = Date.now();
        if (this._analyticsCache.summary && now - this._analyticsCache.cachedAt < 30_000) {
          res.json(this._analyticsCache.summary);
          return;
        }
        const trades = await this.tradeLogger.readAll();
        const summary = this._analyticsEngine.compute(trades);
        this._analyticsCache.summary = summary;
        this._analyticsCache.cachedAt = Date.now();
        res.json(summary);
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    // Wave 3: Performance Analytics endpoint
    this.app.get('/api/performance', async (_req, res) => {
      try {
        const { PerformanceAnalytics } = await import('../ai/PerformanceAnalytics.js');
        const analytics = new PerformanceAnalytics();

        // Collect trades from all bots
        let allTrades: any[] = [];

        // Try tenant trades first
        try {
          const trades = await this.tradeLogger.readAll();
          if (trades && trades.length > 0) allTrades = trades;
        } catch (e) {
          // No trades in default logger
        }

        // Also include trades from disk files (existing trade history)
        try {
          const fs = await import('fs');
          const path = await import('path');
          const tradeFiles = [
            'trades-sodex-spacex.json',
            'trades-sodex-brave.json',
            'trades-sodex.json',
          ];
          for (const file of tradeFiles) {
            const fullPath = path.join(process.cwd(), file);
            if (fs.existsSync(fullPath)) {
              const content = fs.readFileSync(fullPath, 'utf-8').trim();
              if (content) {
                const lines = content.split('\n').filter(l => l.trim());
                const trades = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
                allTrades = allTrades.concat(trades);
              }
            }
          }
        } catch (e) {
          // Ignore file read errors
        }

        if (allTrades.length === 0) {
          res.json({ summary: null, sosoAlpha: null, longestWinStreak: 0, longestLoseStreak: 0 });
          return;
        }

        const report = analytics.generateReport(allTrades);
        res.json(report);
      } catch (err) {
        console.error('[performance] error:', err);
        res.status(500).json({ error: String(err) });
      }
    });

    this.app.get('/api/analytics/trades', async (req, res) => {
      try {
        const { mode, direction, regime, limit: limitStr, offset: offsetStr } = req.query as Record<string, string | undefined>;
        const limit = limitStr !== undefined ? parseInt(limitStr, 10) : 100;
        const offset = offsetStr !== undefined ? parseInt(offsetStr, 10) : 0;
        let trades = await this.tradeLogger.readAll();
        if (mode) trades = trades.filter(t => t.mode === mode);
        if (direction) trades = trades.filter(t => t.direction === direction);
        if (regime) trades = trades.filter(t => t.regime === regime);
        const total = trades.length;
        const page = trades.slice(offset, offset + limit);
        res.json({ trades: page, total });
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    this.app.get('/api/analytics/signal-quality', async (_req, res) => {
      try {
        const now = Date.now();
        if (!this._analyticsCache.summary || now - this._analyticsCache.cachedAt >= 30_000) {
          const trades = await this.tradeLogger.readAll();
          const summary = this._analyticsEngine.compute(trades);
          this._analyticsCache.summary = summary;
          this._analyticsCache.cachedAt = Date.now();
        }
        res.json(this._analyticsCache.summary!.signalQuality);
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    this.app.get('/api/analytics/fee-impact', async (_req, res) => {
      try {
        const now = Date.now();
        if (!this._analyticsCache.summary || now - this._analyticsCache.cachedAt >= 30_000) {
          const trades = await this.tradeLogger.readAll();
          const summary = this._analyticsEngine.compute(trades);
          this._analyticsCache.summary = summary;
          this._analyticsCache.cachedAt = Date.now();
        }
        res.json(this._analyticsCache.summary!.feeImpact);
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    // ── Feedback Loop Stats Route ─────────────────────────────────────────────

    this.app.get('/api/feedback-loop/stats', async (_req, res) => {
      try {
        const backend = (process.env.TRADE_LOG_BACKEND ?? 'json') as 'json' | 'sqlite';
        const logPath = process.env.TRADE_LOG_PATH ?? './data/trades.json';
        const logger = new TradeLogger(backend, logPath);
        const recentTrades = await logger.readAll();
        res.json({
          weights: weightStore.getWeights(),
          componentStats: componentPerformanceTracker.getStats(),
          confidenceBuckets: confidenceCalibrator.computeBuckets(recentTrades),
        });
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });
  }

  /**
   * Setup multi-bot manager routes
   * Called after TenantRegistry is registered
   */
  private _setupManagerRoutes(): void {
    if (!this.tenantRegistry) {
      console.warn('[DashboardServer] _setupManagerRoutes called but tenantRegistry is null');
      return;
    }

    // ── Backtest Routes ───────────────────────────────────────────────────────
    const dataFeed = new HistoricalDataFeed();
    const backtestRouter = createBacktestRouter(dataFeed);
    this.app.use('/api/backtest', backtestRouter);

    // ── Bot Detail Page Route ─────────────────────────────────────────────────

    // GET /bots/:id - Bot detail page
    this.app.get('/bots/:id', (req, res) => {
      const manager = this._resolveManager(req);
      if (!manager) {
        res.status(503).send('Bot manager not available. Please login with wallet first.');
        return;
      }

      const bot = manager.getBot(req.params.id);
      if (!bot) {
        res.status(404).send('Bot not found');
        return;
      }
      
      // Delta-Neutral gets its own dedicated detail page
      const isDeltaNeutral = (bot.config as any).botType === 'oi-farmer' || (bot.config as any).botType === 'delta-neutral' || (bot.config as any).botType === 'hedge' || (bot.config as any).botType === 'pair';
      const template = isDeltaNeutral ? 'delta-neutral-detail' : 'layout';
      const exchangeLabel = 'exchange' in bot.config ? (bot.config as any).exchange : `${(bot.config as any).exchangeA}+${(bot.config as any).exchangeB}`;
      res.render(template, { botId: req.params.id, exchange: exchangeLabel, botName: bot.config.name }, (err: Error | null, html: string) => {
        if (err) {
          console.error('[DashboardServer] Bot detail template render error:', err);
          res.status(500).send(`Template render error: ${err.message}`);
          return;
        }
        res.setHeader('Content-Type', 'text/html');
        res.send(html);
      });
    });

    // ── Manager API Routes ────────────────────────────────────────────────────

    // GET /api/bots - List all bots
    this.app.get('/api/bots', (req, res) => {
      const manager = this._resolveManager(req);
      if (!manager) {
        res.status(503).json({ error: 'Bot manager not available' });
        return;
      }

      try {
        const bots = manager.getAllBots();
        const statuses = bots.map(bot => bot.getStatus());
        res.json(statuses);
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    // GET /api/bots/stats - Aggregated lifetime stats from persisted trade logs.
    // Reads trade log files (mounted at /app/data/) so stats survive Docker restarts/updates.
    // PnL and Fees are computed from historical trade records.
    // Volume is estimated from feePaid (feePaid = notional * FEE_RATE_MAKER * 2).
    this.app.get('/api/bots/stats', async (req, res) => {
      const manager = this._resolveManager(req);
      if (!manager) {
        res.status(503).json({ error: 'Bot manager not available' });
        return;
      }

      try {
        const bots = manager.getAllBots();
        let totalPnl = 0;
        let totalVolume = 0;
        let totalFees = 0;
        let activeBotCount = 0;

        bots.forEach((bot) => {
          if (bot.state.botStatus === 'RUNNING') activeBotCount++;
          // Use session state directly — consistent with per-bot card display,
          // resets on each restart so numbers always reflect the current session.
          totalPnl    += bot.state.sessionPnl    ?? 0;
          totalFees   += bot.state.sessionFees   ?? 0;
          totalVolume += bot.state.sessionVolume ?? 0;
        });

        res.json({
          totalPnl,
          totalVolume,
          totalFees,
          activeBotCount,
        });
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    // ── Account Registry Routes ───────────────────────────────────────────────

    // GET /api/accounts — list all connected exchange accounts for this tenant
    this.app.get('/api/accounts', (req, res) => {
      const tenant = (req as unknown as WalletScopedRequest).tenant;
      if (!tenant) {
        res.status(401).json({ error: 'Wallet login required to manage accounts' });
        return;
      }

      try {
        const accounts = tenant.accountRegistry.list();

        // Enrich with start-of-day balance from balance_snapshots
        const { getDb } = require('../db/Database.js');
        const db = getDb();
        const today = new Date().toISOString().slice(0, 10);

        const enriched = accounts.map((acct: any) => {
          // Get earliest snapshot today (the daily capture at 0h UTC or account connect)
          const sodRow = db.prepare(`
            SELECT equity FROM balance_snapshots
            WHERE date(timestamp) = ? AND account_id = ?
            ORDER BY timestamp ASC LIMIT 1
          `).get(today, acct.id) as { equity: number } | undefined;

          const sodBalance = sodRow?.equity ?? null;
          const currentBalance = acct.balanceUsd ?? null;
          const todayChange = (currentBalance != null && sodBalance != null)
            ? currentBalance - sodBalance
            : null;

          return { ...acct, sodBalance, todayChange };
        });

        res.json({ accounts: enriched });
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    // POST /api/accounts — connect a new exchange account
    this.app.post('/api/accounts', async (req, res) => {
      const tenant = (req as unknown as WalletScopedRequest).tenant;
      if (!tenant) {
        res.status(401).json({ error: 'Wallet login required to manage accounts' });
        return;
      }

      const { label, type, credentials } = req.body as {
        label?: string;
        type?: string;
        credentials?: any;
      };

      if (!label || !type || !credentials) {
        res.status(400).json({ error: 'Missing required fields: label, type, credentials' });
        return;
      }

      const validTypes = ['cex', 'dex-wallet', 'perp-dex'];
      if (!validTypes.includes(type)) {
        res.status(400).json({ error: `Invalid type. Must be one of: ${validTypes.join(', ')}` });
        return;
      }

      const validExchanges = ['sodex', 'dango', 'decibel', 'hibachi', 'ondoperps', 'perpl'];
      if (!credentials.exchange || !validExchanges.includes(credentials.exchange)) {
        res.status(400).json({ error: `Invalid exchange. Must be one of: ${validExchanges.join(', ')}` });
        return;
      }

      // ── Validate credentials by calling the exchange API ────────────────────
      let balance: number;
      try {
        const adapter = createAdapterFromCredentials(credentials.exchange, credentials);
        balance = await adapter.get_balance();
        if (typeof balance !== 'number' || isNaN(balance)) {
          res.status(400).json({ error: 'Credentials validation failed: could not retrieve balance (invalid response)' });
          return;
        }
      } catch (err: any) {
        const msg = err?.message || String(err);
        console.warn(`[POST /api/accounts] Credential validation failed for ${credentials.exchange}:`, msg);
        res.status(400).json({ error: `Credentials validation failed: ${msg}` });
        return;
      }

      // ── Save account + capture initial balance snapshot ─────────────────────
      try {
        const account = tenant.accountRegistry.add(label, type as any, credentials);

        // Update the account's balance immediately
        tenant.accountRegistry.updateBalance(account.id, balance);

        // Capture initial balance snapshot for reporting
        const { captureBalance } = await import('../db/ReportingCollector.js');
        captureBalance({
          exchange: credentials.exchange,
          equity: balance,
          trigger: 'daily',
          walletAddress: tenant.walletAddress,
          accountId: account.id,
        });

        res.status(201).json({ ok: true, account: { ...account, balanceUsd: balance, lastSyncAt: new Date().toISOString() } });
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    // DELETE /api/accounts/:id — disconnect an exchange account
    this.app.delete('/api/accounts/:id', (req, res) => {
      const tenant = (req as unknown as WalletScopedRequest).tenant;
      if (!tenant) {
        res.status(401).json({ error: 'Wallet login required to manage accounts' });
        return;
      }

      try {
        const deleted = tenant.accountRegistry.delete(req.params.id);
        if (!deleted) {
          res.status(404).json({ error: 'Account not found' });
          return;
        }
        res.json({ ok: true });
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    // POST /api/accounts/:id/refresh-balance — fetch live balance from exchange, update + capture snapshot
    this.app.post('/api/accounts/:id/refresh-balance', async (req, res) => {
      const tenant = (req as unknown as WalletScopedRequest).tenant;
      if (!tenant) {
        res.status(401).json({ error: 'Wallet login required' });
        return;
      }

      const accountId = req.params.id;
      const creds = tenant.accountRegistry.getCredentials(accountId);
      if (!creds) {
        res.status(404).json({ error: 'Account not found' });
        return;
      }

      try {
        const adapter = createAdapterFromCredentials(creds.exchange, creds);
        const balance = await adapter.get_balance();

        if (typeof balance !== 'number' || isNaN(balance)) {
          res.status(502).json({ error: 'Exchange returned invalid balance' });
          return;
        }

        // Update AccountRegistry
        tenant.accountRegistry.updateBalance(accountId, balance);

        // Capture balance snapshot
        const { captureBalance } = await import('../db/ReportingCollector.js');
        captureBalance({
          exchange: creds.exchange,
          equity: balance,
          trigger: 'daily',
          walletAddress: tenant.walletAddress,
          accountId,
        });

        res.json({ ok: true, balanceUsd: balance, lastSyncAt: new Date().toISOString() });
      } catch (err: any) {
        res.status(502).json({ error: `Failed to fetch balance: ${err?.message || String(err)}` });
      }
    });

    // GET /api/accounts/:id/credentials — get decrypted credentials (internal use for bot creation)
    this.app.get('/api/accounts/:id/credentials', (req, res) => {
      const tenant = (req as unknown as WalletScopedRequest).tenant;
      if (!tenant) {
        res.status(401).json({ error: 'Wallet login required' });
        return;
      }

      try {
        const creds = tenant.accountRegistry.getCredentials(req.params.id);
        if (!creds) {
          res.status(404).json({ error: 'Account not found' });
          return;
        }
        res.json({ credentials: creds });
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    // GET /api/exchanges/:exchange/symbols — list supported symbols for an exchange
    this.app.get('/api/exchanges/:exchange/symbols', async (req, res) => {
      const exchange = (req.params.exchange as string).toLowerCase();

      // SoDEX: fetch live from public API (includes market metadata for leverage)
      if (exchange === 'sodex') {
        try {
          const { default: axios } = await import('axios');
          const resp = await axios.get('https://mainnet-gw.sodex.dev/api/v1/perps/markets/symbols', { timeout: 5000 });
          const data = resp.data?.data ?? [];
          const symbols = data
            .map((s: any) => s.name as string)
            .filter(Boolean)
            .sort();
          // Build market metadata map for frontend (leverage, sizing, fees)
          const markets: Record<string, { maxLeverage: number; initLeverage: number; minNotional: number; minQuantity: number; stepSize: string; makerFee: number; takerFee: number }> = {};
          for (const m of data) {
            if (!m.name) continue;
            markets[m.name] = {
              maxLeverage: Number(m.maxLeverage ?? m.initLeverage ?? 20),
              initLeverage: Number(m.initLeverage ?? m.maxLeverage ?? 20),
              minNotional: Number(m.minNotional ?? 10),
              minQuantity: Number(m.minQuantity ?? 1),
              stepSize: String(m.stepSize ?? '1'),
              makerFee: Number(m.makerFee ?? 0.00012),
              takerFee: Number(m.takerFee ?? 0.0004),
            };
          }
          res.json({ symbols: symbols.length ? symbols : null, markets });
          return;
        } catch (err) {
          console.warn('[GET /api/exchanges/sodex/symbols] live fetch failed:', err);
          res.json({ symbols: null, markets: {} }); // frontend will fall back
          return;
        }
      }

      // Other exchanges: static lists or live fetch
      if (exchange === 'ondoperps') {
        // Live fetch from OndoPerps public contracts API (no auth needed)
        try {
          const resp = await fetch('https://api.ondoperps.xyz/v1/perps/contracts', {
            headers: { 'Content-Type': 'application/json' },
            signal: AbortSignal.timeout(6000),
          });
          if (resp.ok) {
            const json = await resp.json() as { success: boolean; result: any[] };
            if (json.success && Array.isArray(json.result)) {
              const markets: Record<string, { maxLeverage: number; initLeverage: number; minNotional: number }> = {};
              const symbols = json.result
                .filter((c: any) => c.market && c.status !== 'inactive')
                .map((c: any) => {
                  const sym = (c.market as string).replace(/-USD\.P$/, '-PERP');
                  markets[sym] = {
                    maxLeverage: Number(c.maxLeverage ?? c.max_leverage ?? 10),
                    initLeverage: Number(c.initLeverage ?? c.init_leverage ?? c.maxLeverage ?? 10),
                    minNotional: Number(c.minNotional ?? c.min_notional ?? 10),
                  };
                  return sym;
                })
                .sort();
              if (symbols.length > 0) {
                res.json({ symbols, markets });
                return;
              }
            }
          }
        } catch (err) {
          console.warn('[GET /api/exchanges/ondoperps/symbols] live fetch failed:', err);
        }
        // Fallback static list if live fetch fails
        res.json({ symbols: null, markets: {} });
        return;
      }

      const supported: Record<string, string[]> = {
        decibel:   ['BTC/USD','ETH/USD','SOL/USD','AVAX/USD','MATIC/USD'],
        dango:     ['BTC-USD','ETH-USD','SOL-USD'],
        hibachi:   ['BTC/USDT-P','ETH/USDT-P','SOL/USDT-P','BNB/USDT-P','XRP/USDT-P','DOGE/USDT-P'],
        perpl:     ['BTC-PERP','ETH-PERP','SOL-PERP','MON-PERP','HYPE-PERP','ZEC-PERP'],
      };
      const symbols = supported[exchange];
      if (!symbols) { res.json({ symbols: [] }); return; }
      res.json({ symbols });
    });

    // GET /api/exchanges/:exchange/funding-rate?symbol=X — current funding rate (or null)
    this.app.get('/api/exchanges/:exchange/funding-rate', async (req, res) => {
      const exchange = (req.params.exchange as string).toLowerCase();
      const symbol = (req.query.symbol as string | undefined) || '';

      if (!symbol) {
        res.json({ fundingRate: null });
        return;
      }

      try {
        // Try to get funding rate from a running bot's adapter first
        const manager = this._resolveManager(req);
        if (manager) {
          const bots = manager.getAllBots();
          for (const bot of bots) {
            const cfg = bot.config as any;
            const botExchange = (cfg.exchange || cfg.exchangeA || '').toLowerCase();
            if (botExchange === exchange) {
              const adapter = (bot as any).adapter || (bot as any).adapterA;
              if (adapter && typeof adapter.get_funding_rate === 'function') {
                const rate = await adapter.get_funding_rate(symbol);
                res.json({ fundingRate: rate ?? null });
                return;
              }
            }
          }
        }

        // Fallback: public API fetch for known exchanges
        if (exchange === 'sodex') {
          const { default: axios } = await import('axios');
          const resp = await axios.get(
            `https://mainnet-gw.sodex.dev/api/v1/perps/markets/funding-rates`,
            { timeout: 5000 }
          );
          const rates = resp.data?.data ?? [];
          const match = rates.find((r: any) => r.name === symbol || r.symbol === symbol);
          res.json({ fundingRate: match ? Number(match.fundingRate ?? match.funding_rate ?? 0) : null });
          return;
        }

        if (exchange === 'perpl') {
          const resp = await fetch(
            `https://api.perpl.exchange/v1/markets/${encodeURIComponent(symbol)}/funding`,
            { signal: AbortSignal.timeout(5000) }
          );
          if (resp.ok) {
            const json = await resp.json() as any;
            res.json({ fundingRate: json.fundingRate ?? json.funding_rate ?? null });
            return;
          }
        }

        if (exchange === 'ondoperps') {
          const resp = await fetch(
            `https://api.ondoperps.xyz/v1/perps/funding-rate?symbol=${encodeURIComponent(symbol)}`,
            { signal: AbortSignal.timeout(5000) }
          );
          if (resp.ok) {
            const json = await resp.json() as any;
            res.json({ fundingRate: json.fundingRate ?? json.funding_rate ?? null });
            return;
          }
        }

        // Exchange not supported or no data available
        res.json({ fundingRate: null });
      } catch (err) {
        console.warn(`[GET /api/exchanges/${exchange}/funding-rate] error:`, err);
        res.json({ fundingRate: null });
      }
    });

    // POST /api/bots - Create a new bot at runtime
    this.app.post('/api/bots', async (req, res) => {
      const manager = this._resolveManager(req);
      if (!manager) {
        res.status(503).json({ error: 'Bot manager not available. Please login with wallet first.' });
        return;
      }

      const body = req.body as Record<string, unknown>;

      // ── Account Registry credential resolution ─────────────────────────────
      // If accountId is present, load credentials from AccountRegistry instead
      // of expecting inline credentials in the request body.
      const tenant = (req as unknown as WalletScopedRequest).tenant;
      if (body.accountId && tenant) {
        const creds = tenant.accountRegistry.getCredentials(body.accountId as string);
        if (!creds) {
          res.status(404).json({ error: `Account not found: ${body.accountId}` });
          return;
        }
        // Merge credentials into body — exchange + all credential fields
        if (!body.exchange) body.exchange = creds.exchange;
        Object.assign(body, creds);
      }

      // For DN/OI-farmer bots: resolve hedge leg credentials from hedgeAccountId
      if (body.hedgeAccountId && tenant) {
        const hedgeCreds = tenant.accountRegistry.getCredentials(body.hedgeAccountId as string);
        if (!hedgeCreds) {
          res.status(404).json({ error: `Hedge account not found: ${body.hedgeAccountId}` });
          return;
        }
        // Map hedge credentials to the hedgeXxx fields expected by DN bot creation
        if (!body.exchangeB) body.exchangeB = hedgeCreds.exchange;
        if (hedgeCreds.apiKeyId) body.hedgeApiKeyId = hedgeCreds.apiKeyId;
        if (hedgeCreds.apiKeySecret) body.hedgeApiKeySecret = hedgeCreds.apiKeySecret;
        if (hedgeCreds.apiKey) body.hedgeApiKey = hedgeCreds.apiKey;
        if (hedgeCreds.apiSecret) body.hedgeApiSecret = hedgeCreds.apiSecret;
        if (hedgeCreds.subaccount) body.hedgeSubaccount = hedgeCreds.subaccount;
        if (hedgeCreds.hibachiApiKey) body.hedgeHibachiApiKey = hedgeCreds.hibachiApiKey;
        if (hedgeCreds.hibachiAccountId) body.hedgeHibachiAccountId = hedgeCreds.hibachiAccountId;
        if (hedgeCreds.hibachiPrivateKey) body.hedgeHibachiPrivateKey = hedgeCreds.hibachiPrivateKey;
        if (hedgeCreds.hibachiAccountType) body.hedgeHibachiAccountType = hedgeCreds.hibachiAccountType;
        if (hedgeCreds.privateKey) body.hedgePrivateKey = hedgeCreds.privateKey;
        if (hedgeCreds.perplApiKey) body.hedgePerplApiKey = hedgeCreds.perplApiKey;
        if (hedgeCreds.perplApiKeySecret) body.hedgePerplApiKeySecret = hedgeCreds.perplApiKeySecret;
      }

      try {
        const isHedge = body.botType === 'hedge' || body.botType === 'pair';

        // ── USD-to-asset conversion (Wave 3 UX improvement) ──────────────────
        // If client sends orderSizeMinUsd / orderSizeMaxUsd, convert to asset units
        // using a rough price estimate. The Watcher will refine dynamically at runtime.
        if (!isHedge && body.orderSizeMinUsd !== undefined) {
          const minUsd = Number(body.orderSizeMinUsd) || 100;
          const maxUsd = Number(body.orderSizeMaxUsd) || 200;
          // Default price estimates per symbol prefix (rough — refined at runtime)
          const symbol = String(body.symbol || '').toUpperCase();
          let priceEstimate = 100000; // BTC default
          if (symbol.startsWith('ETH')) priceEstimate = 3500;
          else if (symbol.startsWith('SOL')) priceEstimate = 150;
          else if (symbol.startsWith('XAU') || symbol.startsWith('GOLD')) priceEstimate = 2500;
          else if (symbol.startsWith('AAPL') || symbol.startsWith('TSLA') || symbol.startsWith('NVDA')) priceEstimate = 200;
          else if (symbol.startsWith('MON')) priceEstimate = 2;

          body.orderSizeMin = Math.max(0.001, minUsd / priceEstimate);
          body.orderSizeMax = Math.max(0.002, maxUsd / priceEstimate);
          // Store USD values for display and runtime recalculation
          body.orderSizeMinUsd = minUsd;
          body.orderSizeMaxUsd = maxUsd;
        }

        // Store leverage + margin mode in config (passed through to adapter)
        if (body.leverage !== undefined) {
          body.leverage = Number(body.leverage) || 5;
        }
        if (!body.marginMode) {
          body.marginMode = 'cross';
        }

        if (isHedge) {
          // Hedge/Pair bots now use DeltaNeutralBot in same-exchange mode.
          // Build a complete DeltaNeutralConfig with sensible defaults for missing fields.
          const exchange = body.exchange as string;
          const symbolA = body.symbol || body.symbolA || '';
          const symbolB = body.symbolB || symbolA;
          const id = body.id || `hedge-${exchange}-${symbolA}-${Date.now().toString(36)}`.toLowerCase().replace(/[^a-z0-9-]/g, '');
          const oiConfig: any = {
            id,
            name: body.name || `${exchange.charAt(0).toUpperCase() + exchange.slice(1)} ${symbolA}`,
            botType: 'delta-neutral',
            tags: body.tags ? (Array.isArray(body.tags) ? body.tags : String(body.tags).split(',').map((s: string) => s.trim()).filter(Boolean)) : ['hedge'],
            autoStart: body.autoStart ?? false,
            tradeLogBackend: 'json',
            tradeLogPath: `./trades-${id}.json`,
            // Exchange
            exchangeA: exchange,
            exchangeB: exchange,
            credentialKeyA: body.credentialKey || body.credentialKeyA || 'inline',
            credentialKeyB: body.credentialKey || body.credentialKeyB || 'inline',
            // Position
            symbol: symbolA,
            symbolA,
            symbolB,
            legValueUsd: Number(body.orderSizeMinUsd || body.legValueUsd) || 100,
            orderSizeMinUsd: Number(body.orderSizeMinUsd || body.legValueUsd) || 100,
            orderSizeMaxUsd: Number(body.orderSizeMaxUsd || body.legValueUsd) || 200,
            primaryDirection: body.direction || body.primaryDirection || 'long',
            direction: body.direction || body.primaryDirection || 'long',
            // Hold & exit
            minHoldSecs: Number(body.minHoldSecs) || 120,
            maxHoldSecs: Number(body.maxHoldSecs || body.holdPeriodSecs) || 1800,
            maxLossUsd: Number(body.maxLossUsd) || 15,
            takeProfitUsd: Number(body.takeProfitUsd) || 0,
            maxDeltaDivergenceUsd: Number(body.maxDeltaUsd || body.maxDeltaDivergenceUsd) || 30,
            // Funding
            maxFundingRateThreshold: Number(body.maxFundingRateThreshold) || 0.01,
            autoFlipOnFunding: body.autoFlipOnFunding ?? false,
            // Timing
            tickIntervalSecs: Number(body.tickIntervalSecs) || 60,
            cooldownSecs: Number(body.cooldownSecs) || 30,
            // Entry mode
            entryMode: body.entryMode || 'taker',
            chunkSizeUsd: Number(body.chunkSizeUsd) || 100,
            chunkTimeoutSecs: Number(body.chunkTimeoutSecs) || 30,
            maxMakerAttempts: Number(body.maxMakerAttempts) || 3,
            maxTotalEntryTimeSecs: Number(body.maxTotalEntryTimeSecs) || 300,
          };
          // Pass inline credentials through
          Object.assign(oiConfig, body); // merge all body fields (creds etc.)
          // Re-set the computed fields (override body's original botType etc.)
          oiConfig.botType = 'delta-neutral';
          oiConfig.exchangeA = exchange;
          oiConfig.exchangeB = exchange;
          oiConfig.symbol = symbolA;
          oiConfig.symbolA = symbolA;
          oiConfig.symbolB = symbolB;
          oiConfig.primaryDirection = oiConfig.direction || body.direction || 'long';
          oiConfig.tags = Array.isArray(body.tags) ? body.tags : (body.tags ? String(body.tags).split(',').map((s: string) => s.trim()).filter(Boolean) : ['hedge']);
          oiConfig.autoStart = body.autoStart ?? false;
          oiConfig.tradeLogBackend = 'json';
          oiConfig.tradeLogPath = `./trades-${id}.json`;
          // Force correct sizing (body.legValueUsd from hidden field can override)
          oiConfig.legValueUsd = Number(body.orderSizeMinUsd || body.oiSizeMinUsd) || Number(body.legValueUsd) || 100;
          oiConfig.orderSizeMinUsd = Number(body.orderSizeMinUsd || body.oiSizeMinUsd) || Number(body.legValueUsd) || 100;
          oiConfig.orderSizeMaxUsd = Number(body.orderSizeMaxUsd || body.oiSizeMaxUsd) || Number(body.orderSizeMinUsd || body.oiSizeMinUsd) || 200;
          oiConfig.credentialKeyA = body.credentialKey || body.credentialKeyA || 'inline';
          oiConfig.credentialKeyB = body.credentialKey || body.credentialKeyB || 'inline';

          validateDeltaNeutralConfig(oiConfig);
          const adapter = (body.apiKey || body.privateKey || body.dangoPrivateKey || body.hibachiApiKey || body.apiKeyId || body.perplApiKey)
            ? createAdapterFromCredentials(exchange, body as any)
            : createBotAdapter(exchange, body.credentialKey as string);
          // Same-exchange: use same adapter for both legs
          const bot = manager.createDeltaNeutralBot(oiConfig, adapter, adapter, this._telegram as any);
          if (body.autoStart) await bot.start();
        } else if (body.botType === 'oi-farmer' || body.botType === 'delta-neutral') {
          validateDeltaNeutralConfig(body);
          const oiConfig = body as any;
          // Create adapter for primary leg (exchangeA) — credentials come inline from wizard
          const adapterA = (body.perplApiKey || body.apiKey || body.privateKey || body.dangoPrivateKey || body.hibachiApiKey || body.apiKeyId)
            ? createAdapterFromCredentials(oiConfig.exchangeA, body as any)
            : createBotAdapter(oiConfig.exchangeA, oiConfig.credentialKeyA);
          // Create adapter for hedge leg (exchangeB) — inline credentials from wizard
          let adapterB: any;
          const hedgeCredsMap: Record<string, any> = {
            ondoperps: { apiKeyId: body.hedgeApiKeyId, apiKeySecret: body.hedgeApiKeySecret },
            sodex: { apiKey: body.hedgeApiKey, apiSecret: body.hedgeApiSecret, subaccount: body.hedgeSubaccount },
            hibachi: { hibachiApiKey: body.hedgeHibachiApiKey, hibachiAccountId: body.hedgeHibachiAccountId, hibachiPrivateKey: body.hedgeHibachiPrivateKey, hibachiAccountType: body.hedgeHibachiAccountType || 'trustless' },
            decibel: { privateKey: body.hedgePrivateKey },
            perpl: { perplApiKey: body.hedgePerplApiKey, perplApiKeySecret: body.hedgePerplApiKeySecret },
          };
          const hedgeCreds = hedgeCredsMap[oiConfig.exchangeB];
          const hasHedgeCreds = hedgeCreds && Object.values(hedgeCreds).some((v: any) => v);
          if (oiConfig.exchangeA === oiConfig.exchangeB && !hasHedgeCreds) {
            // Same-exchange DN (hedge mode): reuse primary adapter for both legs
            adapterB = adapterA;
          } else if (hasHedgeCreds) {
            adapterB = createAdapterFromCredentials(oiConfig.exchangeB, hedgeCreds);
          } else {
            adapterB = createBotAdapter(oiConfig.exchangeB, oiConfig.credentialKeyB);
          }
          const bot = manager.createDeltaNeutralBot(oiConfig, adapterA, adapterB, this._telegram as any);
          if (body.autoStart) await bot.start();
        } else {
          if (!validateBotConfig(body)) {
            res.status(400).json({ error: 'Invalid bot config — check all required fields' });
            return;
          }
          const adapter = (body.apiKey || body.privateKey || body.dangoPrivateKey || body.hibachiApiKey || body.apiKeyId || body.perplApiKey)
            ? createAdapterFromCredentials(body.exchange as string, body as any)
            : createBotAdapter(body.exchange as string, body.credentialKey as string);
          const bot = manager.createBot(body, adapter, this._telegram as any);
          if (body.autoStart) await bot.start();
        }

        // Persist updated config list to disk (tenant-scoped)
        if (tenant) {
          tenant.persistConfigs();
        }

        res.status(201).json({ ok: true, id: body.id });
      } catch (err) {
        res.status(400).json({ error: String(err) });
      }
    });

    // GET /api/sosovalue/snapshot — aggregated SoSoValue market intelligence
    // Server-side cache 5 min to avoid rate limit (20 req/min)
    this.app.get('/api/sosovalue/snapshot', async (_req, res) => {
      const now = Date.now();
      if (this._sosoSnapshotCache && now - this._sosoSnapshotCache.fetchedAt < 5 * 60 * 1000) {
        res.json(this._sosoSnapshotCache.data);
        return;
      }

      try {
        const { SoSoValueClient } = await import('../ai/SoSoValueClient.js');
        const client = new SoSoValueClient();

        const [fearGreed, etfFlow, macroRisk, hotNews] = await Promise.allSettled([
          client.fetch(),
          client.fetchEtfFlow(),
          client.fetchMacroEvents(),
          (async () => {
            const API_KEY = process.env.SOSOVALUE_API_KEY;
            if (!API_KEY) return null;
            const { default: axios } = await import('axios');
            const r = await axios.get('https://openapi.sosovalue.com/openapi/v1/news/hot', {
              headers: { 'x-soso-api-key': API_KEY },
              params: { page: 1, page_size: 5, language: 'en' },
              timeout: 6000,
            });
            const items: any[] = r.data?.data?.list ?? r.data?.data ?? [];
            return items.slice(0, 5).map((n: any) => ({ title: String(n.title ?? ''), url: String(n.url ?? n.link ?? '') }));
          })(),
        ]);

        const snapshot = {
          fearGreed: fearGreed.status === 'fulfilled' ? fearGreed.value : null,
          etfFlow: etfFlow.status === 'fulfilled' ? etfFlow.value : null,
          macroRisk: macroRisk.status === 'fulfilled' ? macroRisk.value : null,
          hotNews: hotNews.status === 'fulfilled' ? hotNews.value : null,
          fetchedAt: new Date().toISOString(),
        };

        this._sosoSnapshotCache = { data: snapshot, fetchedAt: now };
        res.json(snapshot);
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    // GET /api/exchanges/:exchange/symbols - Fetch supported symbols for an exchange (duplicate route for tenant-scoped requests)
    this.app.get('/api/exchanges/:exchange/symbols', async (req, res) => {
      const { exchange } = req.params;

      try {
        if (exchange === 'ondoperps') {
          // Live fetch from OndoPerps public contracts API (no auth needed)
          try {
            const resp = await fetch('https://api.ondoperps.xyz/v1/perps/contracts', {
              headers: { 'Content-Type': 'application/json' },
              signal: AbortSignal.timeout(6000),
            });
            if (resp.ok) {
              const json = await resp.json() as { success: boolean; result: any[] };
              if (json.success && Array.isArray(json.result)) {
                const symbols = json.result
                  .filter((c: any) => c.market && c.status !== 'inactive')
                  .map((c: any) => (c.market as string).replace(/-USD\.P$/, '-PERP'))
                  .sort();
                if (symbols.length > 0) {
                  res.json({ symbols });
                  return;
                }
              }
            }
          } catch (err) {
            console.warn('[GET /api/exchanges/ondoperps/symbols] live fetch failed:', err);
          }
          res.json({ symbols: null });
        } else if (exchange === 'perpl') {
          res.json({
            symbols: [
              'BTC-PERP',
              'ETH-PERP',
              'SOL-PERP',
              'MON-PERP',
              'HYPE-PERP',
              'ZEC-PERP'
            ]
          });
        } else {
          res.status(404).json({ error: 'Exchange not supported for symbol fetching' });
        }
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    // DELETE /api/bots/:id - Remove a bot from the registry
    this.app.delete('/api/bots/:id', async (req, res) => {
      const manager = this._resolveManager(req);
      if (!manager) {
        res.status(503).json({ error: 'Bot manager not available' });
        return;
      }

      const bot = manager.getBot(req.params.id);
      if (!bot) {
        res.status(404).json({ error: 'Bot not found' });
        return;
      }

      try {
        if (bot.state.botStatus === 'RUNNING') {
          await bot.stop();
        }
        manager.removeBot(req.params.id);

        // Persist (tenant-scoped)
        const tenant = (req as unknown as WalletScopedRequest).tenant;
        if (tenant) {
          tenant.persistConfigs();
        }

        res.json({ ok: true });
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    // ── Per-Bot Control Routes ────────────────────────────────────────────────

    // POST /api/bots/:id/start - Start a bot
    this.app.post('/api/bots/:id/start', async (req, res) => {
      const manager = this._resolveManager(req);
      if (!manager) {
        res.status(503).json({ error: 'Bot manager not available' });
        return;
      }

      const bot = manager.getBot(req.params.id);
      if (!bot) {
        res.status(404).json({ error: 'Bot not found' });
        return;
      }

      if (bot.state.botStatus === 'RUNNING') {
        res.status(400).json({ error: 'Already running' });
        return;
      }

      try {
        const success = await manager.startBot(req.params.id);
        res.json({ ok: success });
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    // POST /api/bots/:id/stop - Stop a bot
    this.app.post('/api/bots/:id/stop', async (req, res) => {
      const manager = this._resolveManager(req);
      if (!manager) {
        res.status(503).json({ error: 'Bot manager not available' });
        return;
      }

      const bot = manager.getBot(req.params.id);
      if (!bot) {
        res.status(404).json({ error: 'Bot not found' });
        return;
      }

      if (bot.state.botStatus === 'STOPPED') {
        res.status(400).json({ error: 'Not running' });
        return;
      }

      try {
        await manager.stopBot(req.params.id);
        res.json({ ok: true });
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    // POST /api/bots/:id/pause - Pause a bot (stop new entries, keep positions open)
    this.app.post('/api/bots/:id/pause', async (req, res) => {
      const manager = this._resolveManager(req);
      if (!manager) {
        res.status(503).json({ error: 'Bot manager not available' });
        return;
      }

      const bot = manager.getBot(req.params.id);
      if (!bot) {
        res.status(404).json({ error: 'Bot not found' });
        return;
      }

      if (bot.state.botStatus !== 'RUNNING') {
        res.status(400).json({ error: 'Bot is not running' });
        return;
      }

      try {
        await bot.pause();
        res.json({ ok: true });
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    // POST /api/bots/:id/resume - Resume a paused bot
    this.app.post('/api/bots/:id/resume', async (req, res) => {
      const manager = this._resolveManager(req);
      if (!manager) {
        res.status(503).json({ error: 'Bot manager not available' });
        return;
      }

      const bot = manager.getBot(req.params.id);
      if (!bot) {
        res.status(404).json({ error: 'Bot not found' });
        return;
      }

      if (bot.state.botStatus !== 'PAUSED') {
        res.status(400).json({ error: 'Bot is not paused' });
        return;
      }

      try {
        await bot.resume();
        res.json({ ok: true });
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    // POST /api/bots/:id/close - Force close position
    this.app.post('/api/bots/:id/close', async (req, res) => {
      const manager = this._resolveManager(req);
      if (!manager) {
        res.status(503).json({ error: 'Bot manager not available' });
        return;
      }

      const bot = manager.getBot(req.params.id);
      if (!bot) {
        res.status(404).json({ error: 'Bot not found' });
        return;
      }

      try {
        if (!(bot instanceof BotInstance)) {
          res.status(400).json({ error: 'Force-close is not supported for this bot type' });
          return;
        }
        const success = await bot.forceClosePosition();
        res.json({ ok: success });
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    // GET /api/bots/:id/status - Full bot status (used by Delta-Neutral detail page)
    this.app.get('/api/bots/:id/status', (req, res) => {
      const manager = this._resolveManager(req);
      if (!manager) { res.status(503).json({ error: 'Bot manager not available' }); return; }
      const bot = manager.getBot(req.params.id);
      if (!bot) { res.status(404).json({ error: 'Bot not found' }); return; }
      try {
        const status = bot.getStatus();
        // Also include eventLog for Delta-Neutral detail page
        const eventLog = (bot.state as any).eventLog || [];
        res.json({ ...status, eventLog });
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    // ── Per-Bot Control Status & Actions ──────────────────────────────────────

    // GET /api/bots/:id/control/status - Get bot control status
    this.app.get('/api/bots/:id/control/status', async (req, res) => {
      const manager = this._resolveManager(req); if (!manager) {
        res.status(503).json({ error: 'Bot manager not available' });
        return;
      }
      
      const bot = manager.getBot(req.params.id);
      if (!bot) {
        res.status(404).json({ error: 'Bot not found' });
        return;
      }
      
      try {
        // PairBot doesn't have a SessionManager/Watcher — return simplified status
        if (!(bot instanceof BotInstance)) {
          const hasPos = 'hedgePosition' in bot.state
            ? (bot.state as any).hedgePosition !== null
            : ('position' in bot.state ? (bot.state as any).position !== null : false);
          res.json({
            isRunning: bot.state.botStatus === 'RUNNING',
            mode: null,
            maxLoss: null,
            currentPnL: bot.state.sessionPnl,
            uptime: 0,
            hasPosition: hasPos,
            positionText: '',
            cooldown: null,
          });
          return;
        }

        const sessionManager = bot.getSessionManager();
        const watcher = bot.getWatcher();
        const state = sessionManager.getState();
        const uptime = state.startTime ? Math.floor((Date.now() - state.startTime) / 60000) : 0;
        
        let hasPosition = false, positionText = '', cooldown: number | null = null;
        if (state.isRunning) {
          const detail = await watcher.getDetailedStatus();
          hasPosition = detail.hasPosition;
          positionText = detail.text;
          cooldown = watcher.getCooldownInfo();
        }
        
        res.json({
          isRunning: state.isRunning,
          mode: bot.config.mode,
          intelligenceMode: (bot.config as any).intelligenceMode ?? 'manual',  // Wave 3
          maxLoss: state.maxLoss,
          currentPnL: state.currentPnL,
          uptime,
          hasPosition,
          positionText,
          cooldown,
        });
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    // POST /api/bots/:id/control/start - Start bot (alias for /api/bots/:id/start)
    this.app.post('/api/bots/:id/control/start', async (req, res) => {
      const manager = this._resolveManager(req); if (!manager) {
        res.status(503).json({ error: 'Bot manager not available' });
        return;
      }
      
      const bot = manager.getBot(req.params.id);
      if (!bot) {
        res.status(404).json({ error: 'Bot not found' });
        return;
      }
      
      if (bot.state.botStatus === 'RUNNING') {
        res.status(400).json({ error: 'Already running' });
        return;
      }
      
      try {
        const success = await manager.startBot(req.params.id);
        res.json({ ok: success });
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    // POST /api/bots/:id/control/stop - Stop bot (alias for /api/bots/:id/stop)
    this.app.post('/api/bots/:id/control/stop', async (req, res) => {
      const manager = this._resolveManager(req); if (!manager) {
        res.status(503).json({ error: 'Bot manager not available' });
        return;
      }
      
      const bot = manager.getBot(req.params.id);
      if (!bot) {
        res.status(404).json({ error: 'Bot not found' });
        return;
      }
      
      if (bot.state.botStatus === 'STOPPED') {
        res.status(400).json({ error: 'Not running' });
        return;
      }
      
      try {
        await manager.stopBot(req.params.id);
        res.json({ ok: true });
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    // POST /api/bots/:id/control/close_position - Force close position (alias)
    this.app.post('/api/bots/:id/control/close_position', async (req, res) => {
      const manager = this._resolveManager(req); if (!manager) {
        res.status(503).json({ error: 'Bot manager not available' });
        return;
      }
      
      const bot = manager.getBot(req.params.id);
      if (!bot) {
        res.status(404).json({ error: 'Bot not found' });
        return;
      }
      
      try {
        if (!(bot instanceof BotInstance)) {
          res.status(400).json({ error: 'Force-close is not supported for this bot type' });
          return;
        }
        const success = await bot.forceClosePosition();
        res.json({ ok: success });
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    // POST /api/bots/:id/control/set_mode - Set bot mode
    this.app.post('/api/bots/:id/control/set_mode', (req, res) => {
      const manager = this._resolveManager(req); if (!manager) {
        res.status(503).json({ error: 'Bot manager not available' });
        return;
      }
      
      const bot = manager.getBot(req.params.id);
      if (!bot) {
        res.status(404).json({ error: 'Bot not found' });
        return;
      }
      
      const { mode } = req.body as { mode?: string };
      if (mode !== 'farm' && mode !== 'trade') {
        res.status(400).json({ error: 'Invalid mode' });
        return;
      }
      
      try {
        (bot.config as any).mode = mode as 'farm' | 'trade';
        res.json({ ok: true, mode });
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    // POST /api/bots/:id/control/set_max_loss - Set bot max loss
    this.app.post('/api/bots/:id/control/set_max_loss', (req, res) => {
      const manager = this._resolveManager(req); if (!manager) {
        res.status(503).json({ error: 'Bot manager not available' });
        return;
      }
      
      const bot = manager.getBot(req.params.id);
      if (!bot) {
        res.status(404).json({ error: 'Bot not found' });
        return;
      }
      
      const { amount } = req.body as { amount?: number };
      if (!amount || isNaN(amount) || amount <= 0) {
        res.status(400).json({ error: 'Invalid amount' });
        return;
      }
      
      try {
        if (!(bot instanceof BotInstance)) {
          res.status(400).json({ error: 'set_max_loss is not supported for this bot type' });
          return;
        }
        bot.getSessionManager().setMaxLoss(amount);
        res.json({ ok: true, maxLoss: amount });
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    // ── Per-Bot SSE Stream ────────────────────────────────────────────────────

    // GET /api/bots/:id/events/stream - SSE stream for bot events
    this.app.get('/api/bots/:id/events/stream', (req, res) => {
      const manager = this._resolveManager(req); if (!manager) {
        res.status(503).json({ error: 'Bot manager not available' });
        return;
      }
      
      const bot = manager.getBot(req.params.id);
      if (!bot) {
        res.status(404).json({ error: 'Bot not found' });
        return;
      }
      
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders();
      
      const send = (d: string) => res.write(`data: ${d}\n\n`);
      
      // Send recent events
      bot.state.eventLog.slice(0, 20).reverse().forEach(e => send(JSON.stringify(e)));
      
      // Note: For real-time updates, would need to add SSE client management to BotSharedState
      // For now, client will poll via regular /api/bots/:id/events
      
      req.on('close', () => {
        // Cleanup if needed
      });
    });

    // ── Per-Bot Analytics ─────────────────────────────────────────────────────

    // GET /api/bots/:id/analytics - Bot analytics summary
    this.app.get('/api/bots/:id/analytics', async (req, res) => {
      const manager = this._resolveManager(req); if (!manager) {
        res.status(503).json({ error: 'Bot manager not available' });
        return;
      }
      
      const bot = manager.getBot(req.params.id);
      if (!bot) {
        res.status(404).json({ error: 'Bot not found' });
        return;
      }
      
      try {
        const trades = await (bot as any).getTradeLogger().readAll();
        const summary = this._analyticsEngine.compute(trades);
        res.json(summary);
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    // ── Per-Bot Data Routes ───────────────────────────────────────────────────

    // GET /api/bots/:id/pnl - Bot PnL data
    this.app.get('/api/bots/:id/pnl', (req, res) => {
      const manager = this._resolveManager(req); if (!manager) {
        res.status(503).json({ error: 'Bot manager not available' });
        return;
      }
      
      const bot = manager.getBot(req.params.id);
      if (!bot) {
        res.status(404).json({ error: 'Bot not found' });
        return;
      }
      
      res.json({
        sessionPnl: bot.state.sessionPnl,
        sessionGrossPnl: bot.state.sessionGrossPnl,
        sessionVolume: bot.state.sessionVolume,
        sessionFees: bot.state.sessionFees,
        todayVolume: bot.state.todayVolume ?? 0,
        updatedAt: bot.state.updatedAt,
        botStatus: bot.state.botStatus,
        symbol: bot.state.symbol,
        walletAddress: bot.state.walletAddress,
        pnlHistory: bot.state.pnlHistory,
        volumeHistory: bot.state.volumeHistory,
      });
    });

    // GET /api/bots/:id/today-volume - Fetch today's volume directly from exchange API
    // This bypasses the in-memory cache and queries the authoritative source,
    // so it always returns accurate data even when the bot is stopped or just started.
    this.app.get('/api/bots/:id/today-volume', async (req, res) => {
      const manager = this._resolveManager(req); if (!manager) {
        res.status(503).json({ error: 'Bot manager not available' });
        return;
      }

      const bot = manager.getBot(req.params.id);
      if (!bot) {
        res.status(404).json({ error: 'Bot not found' });
        return;
      }

      // Only BotInstance has access to the adapter
      if (!(bot instanceof BotInstance)) {
        res.json({ todayVolume: bot.state.todayVolume ?? 0, source: 'cache' });
        return;
      }

      const adapter = (bot as any).adapter;
      if (typeof adapter?.getTodayVolumeFromAPI !== 'function') {
        // Non-Decibel adapter — return cached value
        res.json({ todayVolume: bot.state.todayVolume ?? 0, source: 'cache' });
        return;
      }

      try {
        const volume: number = await adapter.getTodayVolumeFromAPI();
        // Update the bot state so subsequent /pnl calls also reflect this
        bot.state.todayVolume = volume;
        res.json({ todayVolume: volume, source: 'api' });
      } catch (err: any) {
        // API failed — return last known cached value
        console.warn(`[DashboardServer] today-volume fetch failed for bot ${req.params.id}:`, err?.message ?? err);
        res.json({ todayVolume: bot.state.todayVolume ?? 0, source: 'cache', error: err?.message });
      }
    });

    // GET /api/bots/:id/ai-signal - Bot AI signal state
    this.app.get('/api/bots/:id/ai-signal', (req, res) => {
      const manager = this._resolveManager(req); if (!manager) {
        res.status(503).json({ error: 'Bot manager not available' });
        return;
      }

      const bot = manager.getBot(req.params.id);
      if (!bot) {
        res.status(404).json({ error: 'Bot not found' });
        return;
      }

      if ('getAISignalState' in bot) {
        res.json(bot.getAISignalState());
      } else {
        res.json({ regime: 'unknown', lastSignal: null, macro: null, signalPipeline: [] });
      }
    });

    // GET /api/bots/:id/trades - Bot trades
    this.app.get('/api/bots/:id/trades', async (req, res) => {
      const manager = this._resolveManager(req); if (!manager) {
        res.status(503).json({ error: 'Bot manager not available' });
        return;
      }
      
      const bot = manager.getBot(req.params.id);
      if (!bot) {
        res.status(404).json({ error: 'Bot not found' });
        return;
      }
      
      try {
        const trades = await (bot as any).getTradeLogger().readAll();
        res.json(trades);
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    // GET /api/bots/:id/events - Bot event log
    this.app.get('/api/bots/:id/events', (req, res) => {
      const manager = this._resolveManager(req); if (!manager) {
        res.status(503).json({ error: 'Bot manager not available' });
        return;
      }
      
      const bot = manager.getBot(req.params.id);
      if (!bot) {
        res.status(404).json({ error: 'Bot not found' });
        return;
      }
      
      res.json(bot.state.eventLog);
    });

    // GET /api/bots/:id/position - Bot open position
    this.app.get('/api/bots/:id/position', (req, res) => {
      const manager = this._resolveManager(req); if (!manager) {
        res.status(503).json({ error: 'Bot manager not available' });
        return;
      }
      
      const bot = manager.getBot(req.params.id);
      if (!bot) {
        res.status(404).json({ error: 'Bot not found' });
        return;
      }
      
      // PairBot uses hedgePosition instead of openPosition
      const hedgePos = (bot.state as any).hedgePosition;
      if (hedgePos) {
        res.json({ type: 'hedge', hedgePosition: hedgePos });
        return;
      }
      res.json(bot.state.openPosition);
    });

    // ── Per-Bot Config Routes ─────────────────────────────────────────────────

    const OVERRIDABLE_KEYS: (keyof OverridableConfig)[] = [
      'ORDER_SIZE_MIN', 'ORDER_SIZE_MAX',
      'FARM_MIN_HOLD_SECS', 'FARM_MAX_HOLD_SECS', 'FARM_TP_USD',
      'FARM_SL_PERCENT', 'FARM_SCORE_EDGE', 'FARM_MIN_CONFIDENCE', 'FARM_EARLY_EXIT_SECS',
      'FARM_EARLY_EXIT_PNL', 'FARM_MIN_PROFIT_FEE_MULT', 'FARM_EXTRA_WAIT_SECS', 'FARM_BLOCKED_HOURS', 'FARM_COOLDOWN_SECS',
      'FARM_MIN_CONFIDENCE_PRESSURE_GATE', 'FARM_MIN_FALLBACK_CONFIDENCE',
      'FARM_SIDEWAY_MIN_CONFIDENCE', 'FARM_TREND_MIN_CONFIDENCE',
      'FARM_REVERSE_SIGNAL_ENABLED', 'FARM_USE_DYNAMIC_SIZING',
      'TRADE_TP_PERCENT', 'TRADE_SL_PERCENT',
      'COOLDOWN_MIN_MINS', 'COOLDOWN_MAX_MINS', 'MIN_POSITION_VALUE_USD',
    ];

    // GET /api/bots/:id/config - Get bot config
    this.app.get('/api/bots/:id/config', (req, res) => {
      const manager = this._resolveManager(req); if (!manager) {
        res.status(503).json({ error: 'Bot manager not available' });
        return;
      }
      
      const bot = manager.getBot(req.params.id);
      if (!bot) {
        res.status(404).json({ error: 'Bot not found' });
        return;
      }
      
      try {
        if (!(bot instanceof BotInstance)) {
          // PairBot: return raw config (no ConfigStore)
          res.json(bot.config);
          return;
        }
        res.json(bot.getConfigStore().getEffective());
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    // POST /api/bots/:id/config - Update bot config
    this.app.post('/api/bots/:id/config', (req, res) => {
      const manager = this._resolveManager(req); if (!manager) {
        res.status(503).json({ error: 'Bot manager not available' });
        return;
      }
      
      const bot = manager.getBot(req.params.id);
      if (!bot) {
        res.status(404).json({ error: 'Bot not found' });
        return;
      }

      if (!(bot instanceof BotInstance)) {
        res.status(400).json({ error: 'Config overrides are not supported for this bot type' });
        return;
      }
      
      try {
        const body = req.body as Record<string, unknown>;
        const hasRecognisedKey = OVERRIDABLE_KEYS.some(k => k in body);
        if (!body || !hasRecognisedKey) {
          res.status(400).json({ errors: [{ field: '*', message: 'No recognised config keys in request body' }] });
          return;
        }
        
        const patch: Partial<OverridableConfig> = {};
        for (const key of OVERRIDABLE_KEYS) {
          if (key in body) (patch as Record<string, unknown>)[key] = body[key];
        }
        
        const errors = validateOverrides(patch, bot.getConfigStore().getEffective());
        if (errors.length > 0) {
          res.status(400).json({ errors });
          return;
        }
        
        // Apply overrides to bot's ConfigStore
        bot.getConfigStore().applyOverrides(patch);
        
        // Persist to file
        const configPath = process.env.BOT_CONFIGS_PATH ?? './bot-configs.json';
        saveBotConfigsToFile(manager, configPath);
        
        res.json(bot.getConfigStore().getEffective());
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    // DELETE /api/bots/:id/config - Reset bot config to defaults
    this.app.delete('/api/bots/:id/config', (req, res) => {
      const manager = this._resolveManager(req); if (!manager) {
        res.status(503).json({ error: 'Bot manager not available' });
        return;
      }
      
      const bot = manager.getBot(req.params.id);
      if (!bot) {
        res.status(404).json({ error: 'Bot not found' });
        return;
      }

      if (!(bot instanceof BotInstance)) {
        res.status(400).json({ error: 'Config reset is not supported for this bot type' });
        return;
      }
      
      try {
        bot.getConfigStore().resetToDefaults();
        
        // Persist to file
        const configPath = process.env.BOT_CONFIGS_PATH ?? './bot-configs.json';
        saveBotConfigsToFile(manager, configPath);
        
        res.json(bot.getConfigStore().getEffective());
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    // PATCH /api/bots/:id/identity - Update bot name and/or symbol live
    this.app.patch('/api/bots/:id/identity', (req, res) => {
      const manager = this._resolveManager(req); if (!manager) { res.status(503).json({ error: 'Bot manager not available' }); return; }
      const bot = manager.getBot(req.params.id);
      if (!bot) { res.status(404).json({ error: 'Bot not found' }); return; }
      const { name, symbol } = req.body as { name?: string; symbol?: string };
      if (!name && !symbol) { res.status(400).json({ error: 'Provide at least one of: name, symbol' }); return; }
      try {
        if (name && typeof name === 'string' && name.trim()) (bot.config as any).name = name.trim();
        if (symbol && typeof symbol === 'string' && symbol.trim()) {
          if (!(bot instanceof BotInstance)) {
            res.status(400).json({ error: 'Symbol change is not supported for hedge bots' });
            return;
          }
          const sym = symbol.trim().toUpperCase();
          (bot.config as any).symbol = sym;
          bot.state.symbol = sym;
          bot.getWatcher().setSymbol(sym);
        }
        const configPath = process.env.BOT_CONFIGS_PATH ?? './bot-configs.json';
        saveBotConfigsToFile(manager, configPath);
        res.json({ ok: true, name: bot.config.name });
      } catch (err) { res.status(500).json({ error: String(err) }); }
    });

    // GET /api/bots/:id/daily-reset - Get daily budget reset config
    this.app.get('/api/bots/:id/daily-reset', (req, res) => {
      const manager = this._resolveManager(req); if (!manager) { res.status(503).json({ error: 'Bot manager not available' }); return; }
      const bot = manager.getBot(req.params.id);
      if (!bot) { res.status(404).json({ error: 'Bot not found' }); return; }
      if (!(bot instanceof BotInstance)) {
        res.status(400).json({ error: 'Daily reset is not supported for this bot type' }); return;
      }
      res.json({
        dailyBudgetReset: bot.config.dailyBudgetReset ?? false,
        dailyMaxLossUsd: bot.config.dailyMaxLossUsd ?? 5,
        dailyResetHourUTC: bot.config.dailyResetHourUTC ?? 0,
        dailyTargetVolumeUsd: bot.config.dailyTargetVolumeUsd ?? 0,
      });
    });

    // PATCH /api/bots/:id/daily-reset - Update daily budget reset config live
    this.app.patch('/api/bots/:id/daily-reset', (req, res) => {
      const manager = this._resolveManager(req); if (!manager) { res.status(503).json({ error: 'Bot manager not available' }); return; }
      const bot = manager.getBot(req.params.id);
      if (!bot) { res.status(404).json({ error: 'Bot not found' }); return; }
      if (!(bot instanceof BotInstance)) {
        res.status(400).json({ error: 'Daily reset is not supported for this bot type' }); return;
      }

      const body = req.body as {
        dailyBudgetReset?: boolean;
        dailyMaxLossUsd?: number;
        dailyResetHourUTC?: number;
        dailyTargetVolumeUsd?: number;
      };

      // Validate
      if (body.dailyMaxLossUsd !== undefined && (typeof body.dailyMaxLossUsd !== 'number' || body.dailyMaxLossUsd <= 0)) {
        res.status(400).json({ error: 'dailyMaxLossUsd must be a positive number' }); return;
      }
      if (body.dailyResetHourUTC !== undefined && (typeof body.dailyResetHourUTC !== 'number' || body.dailyResetHourUTC < 0 || body.dailyResetHourUTC > 23)) {
        res.status(400).json({ error: 'dailyResetHourUTC must be 0–23' }); return;
      }
      if (body.dailyTargetVolumeUsd !== undefined && (typeof body.dailyTargetVolumeUsd !== 'number' || body.dailyTargetVolumeUsd < 0)) {
        res.status(400).json({ error: 'dailyTargetVolumeUsd must be >= 0' }); return;
      }

      try {
        // Apply to live bot config
        if (body.dailyBudgetReset !== undefined) (bot.config as any).dailyBudgetReset = body.dailyBudgetReset;
        if (body.dailyMaxLossUsd !== undefined) (bot.config as any).dailyMaxLossUsd = body.dailyMaxLossUsd;
        if (body.dailyResetHourUTC !== undefined) (bot.config as any).dailyResetHourUTC = body.dailyResetHourUTC;
        if (body.dailyTargetVolumeUsd !== undefined) (bot.config as any).dailyTargetVolumeUsd = body.dailyTargetVolumeUsd;

        // Apply live to SessionManager (takes effect immediately for current session)
        const sm = bot.getSessionManager();
        if (body.dailyMaxLossUsd !== undefined) sm.setMaxLoss(body.dailyMaxLossUsd);
        if (body.dailyTargetVolumeUsd !== undefined) sm.setTargetVolume(body.dailyTargetVolumeUsd);

        // Sync scheduler: restart it with new config if enabled, stop if disabled
        bot.syncDailyResetScheduler();

        // Persist to file
        const configPath = process.env.BOT_CONFIGS_PATH ?? './bot-configs.json';
        saveBotConfigsToFile(manager, configPath);

        res.json({
          ok: true,
          dailyBudgetReset: bot.config.dailyBudgetReset,
          dailyMaxLossUsd: bot.config.dailyMaxLossUsd,
          dailyResetHourUTC: bot.config.dailyResetHourUTC,
          dailyTargetVolumeUsd: bot.config.dailyTargetVolumeUsd,
        });
      } catch (err) { res.status(500).json({ error: String(err) }); }
    });

    // ── Portfolio Aggregation Route ───────────────────────────────────────────

    // GET /api/portfolio — aggregates account balances and bot positions into a
    // single portfolio snapshot: total equity, directional bias, unrealized PnL,
    // liquidation risk, per-account breakdown, and risk metrics.
    this.app.get('/api/portfolio', async (req, res) => {
      const manager = this._resolveManager(req);
      const tenant = (req as unknown as WalletScopedRequest).tenant;

      try {
        // ── 1. Collect account data from AccountRegistry ──────────────────────
        interface AccountSummary {
          id: string;
          exchange: string;
          label: string;
          balance: number;
          openPositions: number;
          pnl: number;
        }

        const accountSummaries: AccountSummary[] = [];
        let totalAccountBalance = 0;

        if (tenant) {
          try {
            const accounts = tenant.accountRegistry.list();
            for (const acct of accounts) {
              const balance = acct.balanceUsd ?? 0;
              totalAccountBalance += balance;
              accountSummaries.push({
                id: acct.id,
                exchange: acct.exchange,
                label: acct.label,
                balance,
                openPositions: 0, // will be incremented below from bot data
                pnl: 0,           // will be summed from bot state below
              });
            }
          } catch (acctErr) {
            console.warn('[/api/portfolio] Failed to load accounts:', acctErr);
          }
        }

        // ── 2. Collect position + PnL data from all bots ─────────────────────
        let totalUnrealizedPnl = 0;
        let totalSessionPnl = 0;
        let totalLongNotional = 0;
        let totalShortNotional = 0;
        let totalNotional = 0;
        let totalLeverage = 0;
        let leverageSamples = 0;
        let totalMaintenanceMargin = 0;
        let totalPositionCount = 0;

        if (manager) {
          const bots = manager.getAllBots();

          for (const bot of bots) {
            const state = bot.state;
            totalSessionPnl += state.sessionPnl ?? 0;

            // Unrealized PnL from open position (BotInstance)
            const pos = state.openPosition;
            if (pos) {
              totalUnrealizedPnl += pos.unrealizedPnl ?? 0;
              totalPositionCount++;

              // Compute notional for directional bias
              const notional = pos.size * pos.markPrice;
              totalNotional += notional;
              if (pos.side === 'long') {
                totalLongNotional += notional;
              } else {
                totalShortNotional += notional;
              }

              // Estimate maintenance margin (rough: 2.5% of notional is typical)
              totalMaintenanceMargin += notional * 0.025;
            }

            // Hedge position (PairBot / DeltaNeutralBot store in hedgePosition)
            const hedgePos = (state as any).hedgePosition;
            if (hedgePos) {
              totalUnrealizedPnl += hedgePos.unrealizedPnl ?? 0;
              totalPositionCount++;

              // DN positions often are net-zero by design — count the absolute notional
              const notionalA = (hedgePos.sizeA ?? hedgePos.size ?? 0) * (hedgePos.markPriceA ?? hedgePos.markPrice ?? 0);
              const notionalB = (hedgePos.sizeB ?? 0) * (hedgePos.markPriceB ?? 0);
              totalNotional += notionalA + notionalB;
              // For DN: long on A, short on B — add to respective buckets
              totalLongNotional += notionalA;
              totalShortNotional += notionalB;
              totalMaintenanceMargin += (notionalA + notionalB) * 0.025;
            }

            // Leverage contribution
            const cfg = bot.config as any;
            const leverage = cfg.leverage ?? cfg.leverageA ?? 0;
            if (leverage > 0) {
              totalLeverage += leverage;
              leverageSamples++;
            }

            // Map bot PnL back to accounts by exchange (best-effort match)
            const botExchange = (cfg.exchange ?? cfg.exchangeA ?? '').toLowerCase();
            if (botExchange) {
              const matchingAccount = accountSummaries.find(a => a.exchange.toLowerCase() === botExchange);
              if (matchingAccount) {
                matchingAccount.pnl += state.sessionPnl ?? 0;
                if (state.openPosition || (state as any).hedgePosition) {
                  matchingAccount.openPositions++;
                }
              }
            }
          }
        }

        // ── 3. Compute aggregate metrics ──────────────────────────────────────
        // Total equity = sum of account balances + unrealized PnL
        const totalEquity = totalAccountBalance + totalUnrealizedPnl;

        // Directional bias: +1 = fully long, -1 = fully short, 0 = neutral
        let directionalBias = 0;
        if (totalNotional > 0) {
          directionalBias = (totalLongNotional - totalShortNotional) / totalNotional;
          // Clamp to [-1, 1]
          directionalBias = Math.max(-1, Math.min(1, directionalBias));
        }

        // Average leverage
        const averageLeverage = leverageSamples > 0 ? totalLeverage / leverageSamples : 0;

        // At-risk percentage: ratio of position notional to account equity
        const atRiskPct = totalEquity > 0 ? (totalNotional / totalEquity) * 100 : 0;

        // Liquidation buffer: how much equity remains above maintenance margin
        const availableAboveMaintenance = totalEquity - totalMaintenanceMargin;
        const liquidationBufferPct = totalEquity > 0
          ? Math.max(0, (availableAboveMaintenance / totalEquity) * 100)
          : 100;

        // Liquidation risk tier
        let liquidationRisk: 'low' | 'medium' | 'high';
        if (liquidationBufferPct >= 70 || totalNotional === 0) {
          liquidationRisk = 'low';
        } else if (liquidationBufferPct >= 30) {
          liquidationRisk = 'medium';
        } else {
          liquidationRisk = 'high';
        }

        // ── 4. Build response ─────────────────────────────────────────────────
        res.json({
          totalEquity: Math.round(totalEquity * 100) / 100,
          directionalBias: Math.round(directionalBias * 10000) / 10000,
          unrealizedPnl: Math.round(totalUnrealizedPnl * 100) / 100,
          liquidationRisk,
          accounts: accountSummaries.map(a => ({
            ...a,
            balance: Math.round(a.balance * 100) / 100,
            pnl: Math.round(a.pnl * 100) / 100,
          })),
          risk: {
            atRiskPct: Math.round(atRiskPct * 100) / 100,
            liquidationBuffer: `${Math.round(liquidationBufferPct)}%`,
            maintenanceMargin: Math.round(totalMaintenanceMargin * 100) / 100,
            averageLeverage: Math.round(averageLeverage * 10) / 10,
          },
          timestamp: new Date().toISOString(),
        });
      } catch (err) {
        console.error('[/api/portfolio] Error aggregating portfolio:', err);
        // Return a safe partial response rather than a 500
        res.json({
          totalEquity: 0,
          directionalBias: 0,
          unrealizedPnl: 0,
          liquidationRisk: 'low' as const,
          accounts: [],
          risk: {
            atRiskPct: 0,
            liquidationBuffer: '100%',
            maintenanceMargin: 0,
            averageLeverage: 0,
          },
          timestamp: new Date().toISOString(),
          error: String(err),
        });
      }
    });

    console.log('[DashboardServer] Manager routes registered');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // AGENT LAYER ROUTES (Req 11.2, 11.3, 12.4, 12.5)
  // ═══════════════════════════════════════════════════════════════════════════

  private _setupAgentRoutes(): void {
    if (!this._agentLayer) return;
    const agent = this._agentLayer;

    // GET /agent/status — Req 11.2
    this.app.get('/agent/status', (req, res) => {
      const state = agent.getState();
      const portfolio = agent.getPortfolioState();
      const risk = agent.getRiskStatus();
      const latency = agent.getCycleLatencyStats();
      const dualObjective = agent.getDualObjectiveMetrics();

      res.json({
        lifecycleState: state.lifecycleState,
        cycleCount: state.cycleCount,
        lastDecision: state.lastDecision,
        lastMarketContext: state.lastMarketContext,
        portfolio,
        riskGate: risk,
        latency,
        dualObjective,
        performance: agent.getPerformanceSummary(),
        startedAt: state.startedAt,
        updatedAt: state.updatedAt,
      });
    });

    // GET /agent/history — Req 11.3
    this.app.get('/agent/history', (req, res) => {
      const history = agent.getDecisionHistory();
      res.json({ decisions: history, count: history.length });
    });

    // GET /agent/config — Req 12.4
    this.app.get('/agent/config', (req, res) => {
      res.json(agent.getConfig());
    });

    // PATCH /agent/config — Req 12.5
    this.app.patch('/agent/config', (req, res) => {
      const patch = req.body;
      if (!patch || typeof patch !== 'object') {
        res.status(400).json({ error: 'Request body must be a JSON object' });
        return;
      }
      const result = agent.updateConfig(patch);
      if (!result.success) {
        res.status(400).json({ error: 'Validation failed', errors: result.errors });
        return;
      }
      res.json({ ok: true, config: agent.getConfig() });
    });

    // POST /agent/start
    this.app.post('/agent/start', (req, res) => {
      agent.start();
      res.json({ ok: true, state: agent.getState().lifecycleState });
    });

    // POST /agent/pause
    this.app.post('/agent/pause', (req, res) => {
      agent.pause();
      res.json({ ok: true, state: agent.getState().lifecycleState });
    });

    // POST /agent/stop
    this.app.post('/agent/stop', async (req, res) => {
      await agent.stop();
      res.json({ ok: true, state: agent.getState().lifecycleState });
    });

    // GET /agent/performance — comprehensive analytics for dashboard
    this.app.get('/agent/performance', async (req, res) => {
      try {
        const { PerformanceAnalytics } = await import('../ai/PerformanceAnalytics.js');
        const analytics = new PerformanceAnalytics();

        // Try to load trades from any available trade logger
        let trades: any[] = [];
        try { trades = await this.tradeLogger.readAll(); } catch { /* empty */ }

        // If no trades from primary logger, check tenant loggers
        if (trades.length === 0 && this.tenantRegistry) {
          for (const tenant of this.tenantRegistry.getAllTenants()) {
            const bots = tenant.botManager.getAllBots();
            for (const bot of bots) {
              if ('getTradeLogger' in bot) {
                try {
                  const botTrades = await (bot as any).getTradeLogger().readAll();
                  trades = trades.concat(botTrades);
                } catch { /* skip */ }
              }
            }
          }
        }

        const report = analytics.generateReport(trades);
        const agentState = agent.getState();
        const perf = agent.getPerformanceSummary();
        const latency = agent.getCycleLatencyStats();

        res.json({
          // Agent metrics
          agent: {
            cycleCount: agentState.cycleCount,
            lifecycleState: agentState.lifecycleState,
            latency,
            farmWinRate: perf.farm.winRate,
            farmTrades: perf.farm.totalTrades,
            farmPnl: perf.farm.totalPnl,
            tradeWinRate: perf.trade.winRate,
            tradeTrades: perf.trade.totalTrades,
            tradePnl: perf.trade.totalPnl,
          },
          // Trade analytics
          summary: report.summary,
          sosoAlpha: report.sosoAlpha,
          monthlyReturns: report.monthlyReturns,
          bestTrade: report.bestTrade,
          worstTrade: report.worstTrade,
          longestWinStreak: report.longestWinStreak,
          longestLoseStreak: report.longestLoseStreak,
          farmPerformance: report.farmPerformance,
          tradePerformance: report.tradePerformance,
          // Metadata
          totalTrades: trades.length,
          generatedAt: new Date().toISOString(),
        });
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    console.log('[DashboardServer] Agent routes registered: /agent/status, /agent/history, /agent/config, /agent/performance, /agent/start, /agent/pause, /agent/stop');
  }

  start(): void {
    this._setupReportingRoutes();
    this.app.listen(this.port, () => console.log(`[DashboardServer] Listening on http://localhost:${this.port}`));
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // REPORTING & ANALYTICS API
  // ═══════════════════════════════════════════════════════════════════════════

  private _setupReportingRoutes(): void {
    // GET /api/reports/today — Today's summary: volume, PnL, fees, trades (filterable)
    this.app.get('/api/reports/today', (req, res) => {
      try {
        const { getTodaySummary, getTodayByExchange, getTodayByBot } = require('../db/TradeEventRepository.js');
        const filter: any = {};
        if (req.query.date) filter.date = req.query.date;
        if (req.query.botId) filter.botId = req.query.botId;
        if (req.query.exchange) filter.exchange = req.query.exchange;
        if (req.query.walletAddress) filter.walletAddress = req.query.walletAddress;

        const summary = getTodaySummary(filter);
        const byExchange = getTodayByExchange(filter);
        const byBot = getTodayByBot(filter);

        res.json({ summary, byExchange, byBot });
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    // GET /api/reports/volume — Today's volume counters (fast, pre-aggregated)
    this.app.get('/api/reports/volume', (req, res) => {
      try {
        const { getTodayVolume, getTodayVolumeByExchange, getTodayVolumeByBot } = require('../db/VolumeCounterRepository.js');
        const filter: any = {};
        if (req.query.date) filter.date = req.query.date;
        if (req.query.botId) filter.botId = req.query.botId;
        if (req.query.exchange) filter.exchange = req.query.exchange;
        if (req.query.walletAddress) filter.walletAddress = req.query.walletAddress;

        const total = getTodayVolume(filter);
        const byExchange = getTodayVolumeByExchange(filter);
        const byBot = getTodayVolumeByBot(filter);

        res.json({ total, byExchange, byBot });
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    // GET /api/reports/history — Daily aggregates over a date range (for charts)
    this.app.get('/api/reports/history', (req, res) => {
      try {
        const { getDailyAggregates } = require('../db/TradeEventRepository.js');
        const { getVolumeHistory } = require('../db/VolumeCounterRepository.js');

        const range = (req.query.range as string) || '7d';
        const days = range === '30d' ? 30 : range === 'all' ? 365 : 7;
        const endDate = new Date().toISOString().slice(0, 10);
        const startDate = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);

        const filter: any = {};
        if (req.query.botId) filter.botId = req.query.botId;
        if (req.query.exchange) filter.exchange = req.query.exchange;
        if (req.query.walletAddress) filter.walletAddress = req.query.walletAddress;

        const dailyPnl = getDailyAggregates(startDate, endDate, filter);
        const dailyVolume = getVolumeHistory(startDate, endDate, filter);

        res.json({ dailyPnl, dailyVolume, startDate, endDate });
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    // GET /api/reports/balance-history — Balance snapshots over time
    this.app.get('/api/reports/balance-history', (req, res) => {
      try {
        const { getEquityHistory, getAllLatestSnapshots, getTotalAum } = require('../db/BalanceSnapshotRepository.js');

        const range = (req.query.range as string) || '7d';
        const days = range === '30d' ? 30 : range === 'all' ? 365 : 7;
        const endDate = new Date().toISOString().slice(0, 10);
        const startDate = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
        const walletAddress = req.query.walletAddress as string | undefined;

        const equityHistory = getEquityHistory(startDate, endDate, walletAddress);
        const latestSnapshots = getAllLatestSnapshots(walletAddress);
        const totalAum = getTotalAum(walletAddress);

        res.json({ equityHistory, latestSnapshots, totalAum });
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    // GET /api/reports/analytics — Deep analytics: win rate, expectancy, regime breakdown
    this.app.get('/api/reports/analytics', (req, res) => {
      try {
        const { getAnalytics } = require('../db/TradeEventRepository.js');
        const filter: any = {};
        if (req.query.date) filter.date = req.query.date;
        if (req.query.botId) filter.botId = req.query.botId;
        if (req.query.exchange) filter.exchange = req.query.exchange;
        if (req.query.walletAddress) filter.walletAddress = req.query.walletAddress;

        const analytics = getAnalytics(filter);
        res.json(analytics);
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    // GET /api/reports/trades — Recent trade events (paginated, filterable)
    this.app.get('/api/reports/trades', (req, res) => {
      try {
        const { getRecentTrades } = require('../db/TradeEventRepository.js');
        const limit = parseInt(req.query.limit as string) || 50;
        const offset = parseInt(req.query.offset as string) || 0;
        const filter: any = {};
        if (req.query.date) filter.date = req.query.date;
        if (req.query.botId) filter.botId = req.query.botId;
        if (req.query.exchange) filter.exchange = req.query.exchange;
        if (req.query.walletAddress) filter.walletAddress = req.query.walletAddress;
        if (req.query.symbol) filter.symbol = req.query.symbol;

        const trades = getRecentTrades(limit, offset, filter);
        res.json({ trades, limit, offset });
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    console.log('[DashboardServer] Reporting routes registered: /api/reports/today, /api/reports/volume, /api/reports/history, /api/reports/balance-history, /api/reports/analytics, /api/reports/trades');
  }

}
