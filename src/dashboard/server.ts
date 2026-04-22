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
import { validateBotConfig, validateHedgeBotConfig } from '../bot/loadBotConfigs.js';
import { createAdapter as createBotAdapter } from '../bot/adapterFactory.js';
import type { HedgeBotConfig } from '../bot/types.js';
import type { TelegramManager } from '../modules/TelegramManager.js';


const validTokens = new Map<string, number>();
const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

const TEMPLATE_ENGINE = 'ejs' as const;
const VIEWS_DIR = path.join(__dirname, 'views');

function generateToken(): string { return randomBytes(32).toString('hex'); }
function hashPasscode(p: string): string { return createHash('sha256').update(p).digest('hex'); }

export class DashboardServer {
  private tradeLogger: TradeLogger;
  private port: number;
  private passcodeHash: string | null;
  private sessionManager: SessionManager | null = null;
  private watcher: Watcher | null = null;
  private watcherRunner: (() => void) | null = null;
  private configStore: ConfigStoreInterface | null = null;
  private botManager: BotManager | null = null;
  private _telegram: TelegramManager | null = null;
  private _sopointsCache: { summary: any; week: any } = { summary: null, week: null };
  private _analyticsCache: { summary: AnalyticsSummary | null; cachedAt: number } = { summary: null, cachedAt: 0 };
  private _analyticsEngine = new AnalyticsEngine();
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

  setBotControls(sessionManager: SessionManager, watcher: Watcher, runWatcher: () => void) {
    this.sessionManager = sessionManager;
    this.watcher = watcher;
    this.watcherRunner = runWatcher;
  }

  setConfigStore(store: ConfigStoreInterface): void {
    this.configStore = store;
  }

  /**
   * Register BotManager for multi-bot support
   */
  registerBotManager(manager: BotManager, telegram?: TelegramManager): void {
    this.botManager = manager;
    if (telegram) this._telegram = telegram;
    console.log('[DashboardServer] BotManager registered');
    this._setupManagerRoutes();
  }

  private _isAuthenticated(req: Request): boolean {
    if (!this.passcodeHash) return true;
    const match = (req.headers.cookie || '').match(/dash_token=([a-f0-9]+)/);
    if (!match) return false;
    const expiry = validTokens.get(match[1]);
    if (!expiry || Date.now() > expiry) { validTokens.delete(match[1]); return false; }
    return true;
  }

  private _authMiddleware = (req: Request, res: Response, next: NextFunction): void => {
    if (req.path === '/login' || req.path === '/api/login') { next(); return; }
    if (!this._isAuthenticated(req)) {
      if (req.path.startsWith('/api/')) { res.status(401).json({ error: 'Unauthorized' }); }
      else { res.sendFile(path.join(__dirname, 'public', 'login.html')); }
      return;
    }
    next();
  };

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
    this.app.use(this._authMiddleware);

    this.app.post('/api/login', (req: Request, res: Response) => {
      const { passcode } = req.body as { passcode?: string };
      if (!passcode || hashPasscode(passcode) !== this.passcodeHash) { res.status(401).json({ error: 'Invalid passcode' }); return; }
      const token = generateToken();
      validTokens.set(token, Date.now() + TOKEN_TTL_MS);
      res.setHeader('Set-Cookie', `dash_token=${token}; Path=/; HttpOnly; Max-Age=${TOKEN_TTL_MS / 1000}`);
      res.json({ ok: true });
    });

    this.app.get('/', (_req, res) => {
      // Serve Manager Dashboard if BotManager is registered
      if (this.botManager) {
        res.render('manager', (err: Error | null, html: string) => {
          if (err) {
            console.error('[DashboardServer] Manager template render error:', err);
            res.status(500).send(`Template render error: ${err.message}`);
            return;
          }
          res.setHeader('Content-Type', 'text/html');
          res.send(html);
        });
      } else {
        // Fallback to single-bot dashboard (existing behavior)
        res.render('layout', (err: Error | null, html: string) => {
          if (err) {
            console.error('[DashboardServer] Template render error:', err);
            res.status(500).send(`Template render error: ${err.message}`);
            return;
          }
          res.setHeader('Content-Type', 'text/html');
          res.send(html);
        });
      }
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
      if (!this.sessionManager || !this.watcher || !this.watcherRunner) { res.status(503).json({ error: 'Not available' }); return; }
      if (this.sessionManager.getState().isRunning) { res.status(400).json({ error: 'Already running' }); return; }
      this.sessionManager.resetMaxLoss(); // allow restart after emergency stop
      if (this.sessionManager.startSession()) { this.watcher.resetSession(); this.watcherRunner(); res.json({ ok: true }); }
      else res.status(500).json({ error: 'Failed' });
    });

    this.app.post('/api/control/stop', (_req, res) => {
      if (!this.sessionManager || !this.watcher) { res.status(503).json({ error: 'Not available' }); return; }
      if (!this.sessionManager.getState().isRunning) { res.status(400).json({ error: 'Not running' }); return; }
      this.sessionManager.stopSession(); this.watcher.stop(); res.json({ ok: true });
    });

    this.app.post('/api/control/set_mode', (req, res) => {
      const { mode } = req.body as { mode?: string };
      if (mode !== 'farm' && mode !== 'trade') { res.status(400).json({ error: 'Invalid mode' }); return; }
      (config as any).MODE = mode; res.json({ ok: true, mode });
    });

    this.app.post('/api/control/set_max_loss', (req, res) => {
      if (!this.sessionManager) { res.status(503).json({ error: 'Not available' }); return; }
      const { amount } = req.body as { amount?: number };
      if (!amount || isNaN(amount) || amount <= 0) { res.status(400).json({ error: 'Invalid amount' }); return; }
      this.sessionManager.setMaxLoss(amount); res.json({ ok: true, maxLoss: amount });
    });

    this.app.get('/api/control/status', async (_req, res) => {
      if (!this.sessionManager || !this.watcher) { res.json({ isRunning: false, mode: config.MODE, maxLoss: 5, currentPnL: 0, uptime: 0, hasPosition: false }); return; }
      const state = this.sessionManager.getState();
      const uptime = state.startTime ? Math.floor((Date.now() - state.startTime) / 60000) : 0;
      let hasPosition = false, positionText = '', cooldown: number | null = null;
      if (state.isRunning) {
        const detail = await this.watcher.getDetailedStatus();
        hasPosition = detail.hasPosition; positionText = detail.text; cooldown = this.watcher.getCooldownInfo();
      }
      res.json({ isRunning: state.isRunning, mode: config.MODE, maxLoss: state.maxLoss, currentPnL: state.currentPnL, uptime, hasPosition, positionText, cooldown });
    });

    this.app.post('/api/control/close_position', async (_req, res) => {
      if (!this.watcher) { res.status(503).json({ error: 'Not available' }); return; }
      if (!this.sessionManager?.getState().isRunning) { res.status(400).json({ error: 'Not running' }); return; }
      res.json({ ok: await this.watcher.forceClosePosition() });
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
        const logPath = process.env.TRADE_LOG_PATH ?? './trades.json';
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
   * Called after BotManager is registered
   */
  private _setupManagerRoutes(): void {
    if (!this.botManager) {
      console.warn('[DashboardServer] _setupManagerRoutes called but botManager is null');
      return;
    }

    // ── Bot Detail Page Route ─────────────────────────────────────────────────

    // GET /bots/:id - Bot detail page
    this.app.get('/bots/:id', (req, res) => {
      if (!this.botManager) {
        res.status(503).send('Bot manager not available');
        return;
      }
      
      const bot = this.botManager.getBot(req.params.id);
      if (!bot) {
        res.status(404).send('Bot not found');
        return;
      }
      
      // Render Bot Detail Dashboard (existing layout.ejs)
      res.render('layout', { botId: req.params.id, exchange: bot.config.exchange, botName: bot.config.name }, (err: Error | null, html: string) => {
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
    this.app.get('/api/bots', (_req, res) => {
      if (!this.botManager) {
        res.status(503).json({ error: 'Bot manager not available' });
        return;
      }
      
      try {
        const bots = this.botManager.getAllBots();
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
    this.app.get('/api/bots/stats', async (_req, res) => {
      if (!this.botManager) {
        res.status(503).json({ error: 'Bot manager not available' });
        return;
      }

      try {
        const bots = this.botManager.getAllBots();
        let totalPnl = 0;
        let totalVolume = 0;
        let totalFees = 0;
        let activeBotCount = 0;
        // feePaid = notional * FEE_RATE_MAKER * 2 → notional = feePaid / (FEE_RATE_MAKER * 2)
        const FEE_RATE_ROUND_TRIP = 0.00024;

        await Promise.all(bots.map(async (bot) => {
          if (bot.state.botStatus === 'RUNNING') activeBotCount++;

          try {
            const trades = await bot.getTradeLogger().readAll();

            // Lifetime PnL from all persisted trade records
            totalPnl += trades.reduce((s, t) => s + (t.pnl ?? 0), 0);

            // Lifetime fees from feePaid field (persisted since trade-analytics-reporting)
            totalFees += trades.reduce((s, t) => s + (t.feePaid ?? 0), 0);

            // Volume: derive from feePaid when available (feePaid = notional * FEE_RATE * 2)
            // For old records without feePaid, fall back to session volume
            const tradesWithFee = trades.filter(t => t.feePaid != null && t.feePaid > 0);
            if (tradesWithFee.length > 0) {
              totalVolume += tradesWithFee.reduce((s, t) => s + (t.feePaid! / FEE_RATE_ROUND_TRIP), 0);
            } else {
              // No fee data — use session volume as best available estimate
              totalVolume += bot.state.sessionVolume;
            }
          } catch {
            // Trade log unreadable — fall back to session state only
            totalPnl += bot.state.sessionPnl;
            totalFees += bot.state.sessionFees;
            totalVolume += bot.state.sessionVolume;
          }
        }));

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

    // POST /api/bots - Create a new bot at runtime
    this.app.post('/api/bots', async (req, res) => {
      if (!this.botManager) {
        res.status(503).json({ error: 'Bot manager not available' });
        return;
      }

      const body = req.body as Record<string, unknown>;

      try {
        const isHedge = body.botType === 'hedge';

        if (isHedge) {
          validateHedgeBotConfig(body);
          const adapter = createBotAdapter(body.exchange as string, body.credentialKey as string);
          const bot = this.botManager.createHedgeBot(body as unknown as HedgeBotConfig, adapter, this._telegram as any);
          if (body.autoStart) await bot.start();
        } else {
          if (!validateBotConfig(body)) {
            res.status(400).json({ error: 'Invalid bot config — check all required fields' });
            return;
          }
          const adapter = createBotAdapter(body.exchange as string, body.credentialKey as string);
          const bot = this.botManager.createBot(body, adapter, this._telegram as any);
          if (body.autoStart) await bot.start();
        }

        // Persist updated config list to disk
        const configPath = process.env.BOT_CONFIGS_PATH ?? './bot-configs.json';
        saveBotConfigsToFile(this.botManager, configPath);

        res.status(201).json({ ok: true, id: body.id });
      } catch (err) {
        res.status(400).json({ error: String(err) });
      }
    });

    // DELETE /api/bots/:id - Remove a bot from the registry
    this.app.delete('/api/bots/:id', async (req, res) => {
      if (!this.botManager) {
        res.status(503).json({ error: 'Bot manager not available' });
        return;
      }

      const bot = this.botManager.getBot(req.params.id);
      if (!bot) {
        res.status(404).json({ error: 'Bot not found' });
        return;
      }

      try {
        // Stop first if running
        if (bot.state.botStatus === 'RUNNING') {
          await bot.stop();
        }
        this.botManager.removeBot(req.params.id);

        // Persist
        const configPath = process.env.BOT_CONFIGS_PATH ?? './bot-configs.json';
        saveBotConfigsToFile(this.botManager, configPath);

        res.json({ ok: true });
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    // ── Per-Bot Control Routes ────────────────────────────────────────────────

    // POST /api/bots/:id/start - Start a bot
    this.app.post('/api/bots/:id/start', async (req, res) => {
      if (!this.botManager) {
        res.status(503).json({ error: 'Bot manager not available' });
        return;
      }
      
      const bot = this.botManager.getBot(req.params.id);
      if (!bot) {
        res.status(404).json({ error: 'Bot not found' });
        return;
      }
      
      if (bot.state.botStatus === 'RUNNING') {
        res.status(400).json({ error: 'Already running' });
        return;
      }
      
      try {
        const success = await this.botManager.startBot(req.params.id);
        res.json({ ok: success });
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    // POST /api/bots/:id/stop - Stop a bot
    this.app.post('/api/bots/:id/stop', async (req, res) => {
      if (!this.botManager) {
        res.status(503).json({ error: 'Bot manager not available' });
        return;
      }
      
      const bot = this.botManager.getBot(req.params.id);
      if (!bot) {
        res.status(404).json({ error: 'Bot not found' });
        return;
      }
      
      if (bot.state.botStatus === 'STOPPED') {
        res.status(400).json({ error: 'Not running' });
        return;
      }
      
      try {
        await this.botManager.stopBot(req.params.id);
        res.json({ ok: true });
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    // POST /api/bots/:id/close - Force close position
    this.app.post('/api/bots/:id/close', async (req, res) => {
      if (!this.botManager) {
        res.status(503).json({ error: 'Bot manager not available' });
        return;
      }
      
      const bot = this.botManager.getBot(req.params.id);
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

    // ── Per-Bot Control Status & Actions ──────────────────────────────────────

    // GET /api/bots/:id/control/status - Get bot control status
    this.app.get('/api/bots/:id/control/status', async (req, res) => {
      if (!this.botManager) {
        res.status(503).json({ error: 'Bot manager not available' });
        return;
      }
      
      const bot = this.botManager.getBot(req.params.id);
      if (!bot) {
        res.status(404).json({ error: 'Bot not found' });
        return;
      }
      
      try {
        // HedgeBot doesn't have a SessionManager/Watcher — return simplified status
        if (!(bot instanceof BotInstance)) {
          res.json({
            isRunning: bot.state.botStatus === 'RUNNING',
            mode: null,
            maxLoss: null,
            currentPnL: bot.state.sessionPnl,
            uptime: 0,
            hasPosition: bot.state.hedgePosition !== null,
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
      if (!this.botManager) {
        res.status(503).json({ error: 'Bot manager not available' });
        return;
      }
      
      const bot = this.botManager.getBot(req.params.id);
      if (!bot) {
        res.status(404).json({ error: 'Bot not found' });
        return;
      }
      
      if (bot.state.botStatus === 'RUNNING') {
        res.status(400).json({ error: 'Already running' });
        return;
      }
      
      try {
        const success = await this.botManager.startBot(req.params.id);
        res.json({ ok: success });
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    // POST /api/bots/:id/control/stop - Stop bot (alias for /api/bots/:id/stop)
    this.app.post('/api/bots/:id/control/stop', async (req, res) => {
      if (!this.botManager) {
        res.status(503).json({ error: 'Bot manager not available' });
        return;
      }
      
      const bot = this.botManager.getBot(req.params.id);
      if (!bot) {
        res.status(404).json({ error: 'Bot not found' });
        return;
      }
      
      if (bot.state.botStatus === 'STOPPED') {
        res.status(400).json({ error: 'Not running' });
        return;
      }
      
      try {
        await this.botManager.stopBot(req.params.id);
        res.json({ ok: true });
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    // POST /api/bots/:id/control/close_position - Force close position (alias)
    this.app.post('/api/bots/:id/control/close_position', async (req, res) => {
      if (!this.botManager) {
        res.status(503).json({ error: 'Bot manager not available' });
        return;
      }
      
      const bot = this.botManager.getBot(req.params.id);
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
      if (!this.botManager) {
        res.status(503).json({ error: 'Bot manager not available' });
        return;
      }
      
      const bot = this.botManager.getBot(req.params.id);
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
      if (!this.botManager) {
        res.status(503).json({ error: 'Bot manager not available' });
        return;
      }
      
      const bot = this.botManager.getBot(req.params.id);
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
      if (!this.botManager) {
        res.status(503).json({ error: 'Bot manager not available' });
        return;
      }
      
      const bot = this.botManager.getBot(req.params.id);
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
      if (!this.botManager) {
        res.status(503).json({ error: 'Bot manager not available' });
        return;
      }
      
      const bot = this.botManager.getBot(req.params.id);
      if (!bot) {
        res.status(404).json({ error: 'Bot not found' });
        return;
      }
      
      try {
        const trades = await bot.getTradeLogger().readAll();
        const summary = this._analyticsEngine.compute(trades);
        res.json(summary);
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    // ── Per-Bot Data Routes ───────────────────────────────────────────────────

    // GET /api/bots/:id/pnl - Bot PnL data
    this.app.get('/api/bots/:id/pnl', (req, res) => {
      if (!this.botManager) {
        res.status(503).json({ error: 'Bot manager not available' });
        return;
      }
      
      const bot = this.botManager.getBot(req.params.id);
      if (!bot) {
        res.status(404).json({ error: 'Bot not found' });
        return;
      }
      
      res.json({
        sessionPnl: bot.state.sessionPnl,
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
      if (!this.botManager) {
        res.status(503).json({ error: 'Bot manager not available' });
        return;
      }

      const bot = this.botManager.getBot(req.params.id);
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

    // GET /api/bots/:id/trades - Bot trades
    this.app.get('/api/bots/:id/trades', async (req, res) => {
      if (!this.botManager) {
        res.status(503).json({ error: 'Bot manager not available' });
        return;
      }
      
      const bot = this.botManager.getBot(req.params.id);
      if (!bot) {
        res.status(404).json({ error: 'Bot not found' });
        return;
      }
      
      try {
        const trades = await bot.getTradeLogger().readAll();
        res.json(trades);
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    // GET /api/bots/:id/events - Bot event log
    this.app.get('/api/bots/:id/events', (req, res) => {
      if (!this.botManager) {
        res.status(503).json({ error: 'Bot manager not available' });
        return;
      }
      
      const bot = this.botManager.getBot(req.params.id);
      if (!bot) {
        res.status(404).json({ error: 'Bot not found' });
        return;
      }
      
      res.json(bot.state.eventLog);
    });

    // GET /api/bots/:id/position - Bot open position
    this.app.get('/api/bots/:id/position', (req, res) => {
      if (!this.botManager) {
        res.status(503).json({ error: 'Bot manager not available' });
        return;
      }
      
      const bot = this.botManager.getBot(req.params.id);
      if (!bot) {
        res.status(404).json({ error: 'Bot not found' });
        return;
      }
      
      // HedgeBot uses hedgePosition instead of openPosition
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
      'TRADE_TP_PERCENT', 'TRADE_SL_PERCENT',
      'COOLDOWN_MIN_MINS', 'COOLDOWN_MAX_MINS', 'MIN_POSITION_VALUE_USD',
    ];

    // GET /api/bots/:id/config - Get bot config
    this.app.get('/api/bots/:id/config', (req, res) => {
      if (!this.botManager) {
        res.status(503).json({ error: 'Bot manager not available' });
        return;
      }
      
      const bot = this.botManager.getBot(req.params.id);
      if (!bot) {
        res.status(404).json({ error: 'Bot not found' });
        return;
      }
      
      try {
        if (!(bot instanceof BotInstance)) {
          // HedgeBot: return raw config (no ConfigStore)
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
      if (!this.botManager) {
        res.status(503).json({ error: 'Bot manager not available' });
        return;
      }
      
      const bot = this.botManager.getBot(req.params.id);
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
        saveBotConfigsToFile(this.botManager, configPath);
        
        res.json(bot.getConfigStore().getEffective());
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    // DELETE /api/bots/:id/config - Reset bot config to defaults
    this.app.delete('/api/bots/:id/config', (req, res) => {
      if (!this.botManager) {
        res.status(503).json({ error: 'Bot manager not available' });
        return;
      }
      
      const bot = this.botManager.getBot(req.params.id);
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
        saveBotConfigsToFile(this.botManager, configPath);
        
        res.json(bot.getConfigStore().getEffective());
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    // PATCH /api/bots/:id/identity - Update bot name and/or symbol live
    this.app.patch('/api/bots/:id/identity', (req, res) => {
      if (!this.botManager) { res.status(503).json({ error: 'Bot manager not available' }); return; }
      const bot = this.botManager.getBot(req.params.id);
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
        saveBotConfigsToFile(this.botManager, configPath);
        res.json({ ok: true, name: bot.config.name });
      } catch (err) { res.status(500).json({ error: String(err) }); }
    });

    console.log('[DashboardServer] Manager routes registered');
  }

  start(): void {
    this.app.listen(this.port, () => console.log(`[DashboardServer] Listening on http://localhost:${this.port}`));
  }

}
