import express, { Request, Response, NextFunction } from 'express';
import { createHash, randomBytes } from 'crypto';
import { TradeLogger } from '../ai/TradeLogger.js';
import { AnalyticsEngine, AnalyticsSummary } from '../ai/AnalyticsEngine.js';
import { sharedState, addSseClient, removeSseClient, addConsoleSseClient, removeConsoleSseClient } from '../ai/sharedState.js';
import { memoryRouter } from '../ai/TradingMemory/routes.js';
import { SessionManager } from '../modules/SessionManager.js';
import { Watcher } from '../modules/Watcher.js';
import { config } from '../config.js';
import type { ConfigStoreInterface, OverridableConfig } from '../config/ConfigStore.js';
import { validateOverrides } from '../config/validateOverrides.js';

const validTokens = new Map<string, number>();
const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

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
      else { res.setHeader('Content-Type', 'text/html'); res.send(this._buildLoginHtml()); }
      return;
    }
    next();
  };

  private _setupRoutes(): void {
    this.app.use(this._authMiddleware);

    this.app.post('/api/login', (req: Request, res: Response) => {
      const { passcode } = req.body as { passcode?: string };
      if (!passcode || hashPasscode(passcode) !== this.passcodeHash) { res.status(401).json({ error: 'Invalid passcode' }); return; }
      const token = generateToken();
      validTokens.set(token, Date.now() + TOKEN_TTL_MS);
      res.setHeader('Set-Cookie', `dash_token=${token}; Path=/; HttpOnly; Max-Age=${TOKEN_TTL_MS / 1000}`);
      res.json({ ok: true });
    });

    this.app.get('/', (_req, res) => { res.setHeader('Content-Type', 'text/html'); res.send(this._buildHtml()); });

    this.app.get('/api/trades', async (_req, res) => {
      try { res.json(await this.tradeLogger.readAll()); } catch (err) { res.status(500).json({ error: String(err) }); }
    });

    this.app.get('/api/pnl', (_req, res) => {
      res.json({ sessionPnl: sharedState.sessionPnl, sessionVolume: sharedState.sessionVolume, updatedAt: sharedState.updatedAt, botStatus: sharedState.botStatus, symbol: sharedState.symbol, walletAddress: sharedState.walletAddress, pnlHistory: sharedState.pnlHistory, volumeHistory: sharedState.volumeHistory });
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

    // ── Config Override Routes ────────────────────────────────────────────────

    const OVERRIDABLE_KEYS: (keyof OverridableConfig)[] = [
      'ORDER_SIZE_MIN', 'ORDER_SIZE_MAX', 'STOP_LOSS_PERCENT', 'TAKE_PROFIT_PERCENT',
      'POSITION_SL_PERCENT', 'FARM_MIN_HOLD_SECS', 'FARM_MAX_HOLD_SECS', 'FARM_TP_USD',
      'FARM_SL_PERCENT', 'FARM_SCORE_EDGE', 'FARM_MIN_CONFIDENCE', 'FARM_EARLY_EXIT_SECS',
      'FARM_EARLY_EXIT_PNL', 'FARM_EXTRA_WAIT_SECS', 'FARM_BLOCKED_HOURS',
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
  }

  start(): void {
    this.app.listen(this.port, () => console.log(`[DashboardServer] Listening on http://localhost:${this.port}`));
  }

  private _buildLoginHtml(): string {
    return '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"/><title>SoDEX Dashboard</title><style>' +
      '*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}' +
      'body{font-family:-apple-system,sans-serif;background:#0a0a0a;color:#e0e0e0;display:flex;align-items:center;justify-content:center;min-height:100vh}' +
      '.card{background:#111;border:1px solid #1e1e1e;border-radius:12px;padding:2rem 2.5rem;width:100%;max-width:360px}' +
      'h1{font-size:1.1rem;font-weight:600;color:#fff;margin-bottom:0.25rem}.sub{font-size:0.75rem;color:#555;margin-bottom:1.5rem}' +
      'label{font-size:0.72rem;color:#666;text-transform:uppercase;letter-spacing:0.08em;display:block;margin-bottom:0.4rem}' +
      'input{width:100%;background:#0a0a0a;border:1px solid #2a2a2a;border-radius:7px;padding:0.65rem 0.85rem;color:#e0e0e0;font-size:0.9rem;outline:none}' +
      'input:focus{border-color:#00d464}' +
      'button{width:100%;margin-top:1rem;background:#00d464;color:#000;border:none;border-radius:7px;padding:0.7rem;font-size:0.9rem;font-weight:700;cursor:pointer}' +
      '.error{color:#ff4d4d;font-size:0.75rem;margin-top:0.75rem;display:none}' +
      '</style></head><body><div class="card"><h1>SoDEX Dashboard</h1><p class="sub">Enter passcode to continue</p>' +
      '<label for="pc">Passcode</label><input type="password" id="pc" placeholder="••••••••" autofocus/>' +
      '<button onclick="login()">Unlock</button><p class="error" id="err">Incorrect passcode.</p></div>' +
      '<script>document.getElementById("pc").addEventListener("keydown",e=>{if(e.key==="Enter")login()});' +
      'async function login(){const p=document.getElementById("pc").value,err=document.getElementById("err");err.style.display="none";' +
      'try{const r=await fetch("/api/login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({passcode:p})});' +
      'if(r.ok)window.location.href="/";else{err.style.display="block";document.getElementById("pc").value="";}}catch{err.style.display="block";}}<\/script>' +
      '</body></html>';
  }

  private _buildHtml(): string {
    const css = `
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#0a0a0a;color:#e0e0e0;min-height:100vh}
.header{padding:1.25rem 1.5rem 0.5rem;border-bottom:1px solid #1e1e1e}
.header-top{display:flex;align-items:center;justify-content:space-between}
.header-title{display:flex;align-items:center;gap:0.5rem}
.header-title h1{font-size:1.25rem;font-weight:600;color:#fff}
.status-badge{display:inline-flex;align-items:center;gap:0.35rem;padding:0.2rem 0.6rem;border-radius:999px;font-size:0.7rem;font-weight:600;letter-spacing:0.05em}
.status-running{background:rgba(0,212,100,0.15);color:#00d464;border:1px solid rgba(0,212,100,0.3)}
.status-stopped{background:rgba(255,77,77,0.15);color:#ff4d4d;border:1px solid rgba(255,77,77,0.3)}
.dot{width:6px;height:6px;border-radius:50%;background:currentColor}
.header-meta{font-size:0.72rem;color:#555;margin-top:0.3rem}
.wallet{font-size:0.72rem;color:#555;background:#161616;border:1px solid #1e1e1e;border-radius:6px;padding:0.5rem 0.75rem;margin-top:0.5rem}
.wallet span{color:#888}
.main{padding:1.25rem 1.5rem;display:flex;flex-direction:column;gap:1rem}
.cards-row{display:grid;grid-template-columns:1fr 1fr;gap:1rem}
.card{background:#111;border:1px solid #1e1e1e;border-radius:10px;padding:1rem 1.25rem}
.card-label{font-size:0.68rem;color:#666;text-transform:uppercase;letter-spacing:0.08em;margin-bottom:0.4rem;display:flex;justify-content:space-between}
.card-value{font-size:1.6rem;font-weight:700}
.card-sub{font-size:0.72rem;color:#555;margin-top:0.25rem}
.progress-bar{height:3px;background:#1e1e1e;border-radius:2px;margin-top:0.5rem;overflow:hidden}
.progress-fill{height:100%;border-radius:2px;transition:width 0.4s}
.positive{color:#00d464}.negative{color:#ff4d4d}.neutral{color:#888}
.charts-row{display:grid;grid-template-columns:1fr 1fr;gap:1rem}
.three-col{display:grid;grid-template-columns:1fr 1fr 1fr;gap:1rem;align-items:stretch}
.chart-card{background:#111;border:1px solid #1e1e1e;border-radius:10px;padding:1rem 1.25rem}
.chart-card h3{font-size:0.85rem;font-weight:600;color:#ccc;margin-bottom:0.75rem}
.chart-wrap{position:relative;height:180px}
.tables-row{display:grid;grid-template-columns:1fr 1fr;gap:1rem}
.table-card{background:#111;border:1px solid #1e1e1e;border-radius:10px;padding:1rem 1.25rem}
.table-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:0.75rem}
.table-header h3{font-size:0.85rem;font-weight:600;color:#ccc}
.table-count{font-size:0.7rem;color:#555}
table{width:100%;border-collapse:collapse;font-size:0.75rem}
th{color:#555;font-weight:500;text-align:left;padding:0.4rem 0.5rem;border-bottom:1px solid #1a1a1a}
td{padding:0.45rem 0.5rem;border-bottom:1px solid #141414;color:#ccc}
tr:last-child td{border-bottom:none}
.side-badge{display:inline-block;padding:0.15rem 0.45rem;border-radius:4px;font-size:0.68rem;font-weight:700}
.side-buy{background:rgba(0,212,100,0.15);color:#00d464}
.side-sell{background:rgba(255,77,77,0.15);color:#ff4d4d}
.event-badge{display:inline-block;padding:0.15rem 0.45rem;border-radius:4px;font-size:0.65rem;font-weight:600}
.ev-info,.ev-order_placed{background:rgba(100,150,255,0.15);color:#6496ff}
.ev-order_filled{background:rgba(0,212,100,0.15);color:#00d464}
.ev-error{background:rgba(255,77,77,0.15);color:#ff4d4d}
.ev-warn{background:rgba(255,180,0,0.15);color:#ffb400}
.pagination{display:flex;justify-content:space-between;align-items:center;margin-top:0.75rem;font-size:0.72rem;color:#555}
.pagination button{background:#1a1a1a;border:1px solid #2a2a2a;color:#aaa;padding:0.25rem 0.65rem;border-radius:5px;cursor:pointer;font-size:0.72rem}
.pagination button:hover{background:#222}
.pagination button:disabled{opacity:0.3;cursor:default}
.pos-card{background:#111;border:1px solid #1e1e1e;border-radius:10px;padding:1rem 1.25rem}
.pos-empty{font-size:0.78rem;color:#444;text-align:center;padding:1rem 0}
.pos-side-long{color:#00d464;font-weight:700}.pos-side-short{color:#ff4d4d;font-weight:700}
.pos-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:0.75rem;margin-top:0.75rem}
.pos-item label{font-size:0.65rem;color:#555;text-transform:uppercase;letter-spacing:0.06em;display:block;margin-bottom:0.2rem}
.pos-item span{font-size:0.9rem;font-weight:600;color:#ccc}
.log-card{background:#111;border:1px solid #1e1e1e;border-radius:10px;padding:1rem 1.25rem}
.log-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:0.5rem}
.log-header h3{font-size:0.85rem;font-weight:600;color:#ccc}
.log-live{display:inline-flex;align-items:center;gap:0.3rem;font-size:0.65rem;color:#00d464;background:rgba(0,212,100,0.1);border:1px solid rgba(0,212,100,0.25);border-radius:999px;padding:0.15rem 0.5rem}
.log-live .dot{width:5px;height:5px;border-radius:50%;background:#00d464;animation:pulse 1.5s infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:0.3}}
.log-tabs{display:flex;gap:0.5rem;margin-bottom:0.5rem}
.log-tab{font-size:0.72rem;padding:0.25rem 0.65rem;border-radius:5px;border:1px solid #2a2a2a;background:#161616;color:#666;cursor:pointer}
.log-tab.active{background:rgba(100,150,255,0.12);border-color:rgba(100,150,255,0.3);color:#6496ff}
.log-body{height:260px;overflow-y:auto;font-size:0.7rem;font-family:monospace}
.log-body::-webkit-scrollbar{width:4px}
.log-body::-webkit-scrollbar-thumb{background:#2a2a2a;border-radius:2px}
.log-line{padding:0.18rem 0;border-bottom:1px solid #141414;display:flex;gap:0.5rem;align-items:baseline}
.log-time{color:#444;white-space:nowrap;flex-shrink:0}
.log-type{flex-shrink:0;padding:0.05rem 0.35rem;border-radius:3px;font-size:0.62rem;font-weight:600}
.log-msg{color:#aaa;word-break:break-all}
.con-line{padding:0.15rem 0;border-bottom:1px solid #0f0f0f;color:#7a9e7a;white-space:pre-wrap;word-break:break-all}
.con-line.err{color:#c97070}
.tier-card{border-radius:14px;padding:1.25rem 1.5rem;display:flex;flex-direction:column;justify-content:space-between;height:100%}
.tier-gold{background:linear-gradient(135deg,#8a6000,#d4a017,#f0c040)}
.tier-silver{background:linear-gradient(135deg,#5a5a6e,#9a9ab0)}
.tier-bronze{background:linear-gradient(135deg,#7c4a1e,#c47a3a)}
.tier-diamond{background:linear-gradient(135deg,#1a4a7a,#3a8ad4,#7ac0f0)}
.tier-name{font-size:1.1rem;font-weight:800;color:#fff;letter-spacing:0.08em}
.tier-points{font-size:2.2rem;font-weight:800;color:#fff;line-height:1}
.tier-points-label{display:inline-block;background:rgba(0,0,0,0.25);color:#ffe066;font-size:0.65rem;font-weight:700;letter-spacing:0.1em;padding:0.15rem 0.5rem;border-radius:5px;margin-left:0.5rem;vertical-align:middle}
.tier-next{font-size:0.72rem;color:rgba(255,255,255,0.75);margin-bottom:0.3rem;display:flex;justify-content:space-between}
.tier-bar-bg{height:6px;background:rgba(0,0,0,0.3);border-radius:3px;overflow:hidden}
.tier-bar-fill{height:100%;background:rgba(255,220,50,0.9);border-radius:3px;transition:width 0.5s}
.tier-rank{font-size:0.72rem;color:rgba(255,255,255,0.85);margin-top:0.5rem}
.tier-empty{font-size:0.78rem;color:#444;text-align:center;padding:2rem 0}
.week-card{background:#111;border:1px solid #1e1e1e;border-radius:10px;padding:1.25rem 1.5rem;display:flex;flex-direction:column;justify-content:space-between;height:100%}
.week-label{font-size:0.72rem;color:#666;text-transform:uppercase;letter-spacing:0.08em;margin-bottom:0.5rem}
.week-vol{font-size:2rem;font-weight:700;color:#fff;margin-bottom:0.25rem}
.week-vol-sub{font-size:0.72rem;color:#555;margin-bottom:1rem}
.week-countdown{background:#161616;border:1px solid #1e1e1e;border-radius:8px;padding:0.65rem 1rem;display:flex;align-items:center;gap:0.4rem;font-size:0.78rem;color:#888;flex-wrap:wrap}
.cd-label{color:#aaa;font-weight:500;margin-right:0.25rem}
.cd-num{color:#fff;font-weight:700;font-size:0.9rem}
.cd-sep{color:#555}
.cd-sec{color:#f97316;font-weight:700;font-size:0.9rem}
.cd-unit{font-size:0.6rem;color:#555;margin-left:1px}
.ctrl-panel{background:#111;border:1px solid #1e1e1e;border-radius:10px;padding:1rem 1.25rem;margin:1rem 1.5rem 0}
.ctrl-title{font-size:0.72rem;color:#555;text-transform:uppercase;letter-spacing:0.08em;margin-bottom:0.85rem}
.ctrl-row{display:flex;flex-wrap:wrap;gap:0.6rem;align-items:center}
.cb{display:inline-flex;align-items:center;gap:0.35rem;padding:0.45rem 0.9rem;border-radius:7px;border:1px solid #2a2a2a;background:#161616;color:#ccc;font-size:0.78rem;font-weight:500;cursor:pointer;transition:background 0.15s}
.cb:hover:not(:disabled){background:#1e1e1e;border-color:#3a3a3a}
.cb:disabled{opacity:0.35;cursor:default}
.cb.g{background:rgba(0,212,100,0.12);border-color:rgba(0,212,100,0.3);color:#00d464}
.cb.g:hover:not(:disabled){background:rgba(0,212,100,0.2)}
.cb.r{background:rgba(255,77,77,0.12);border-color:rgba(255,77,77,0.3);color:#ff4d4d}
.cb.r:hover:not(:disabled){background:rgba(255,77,77,0.2)}
.cb.o{background:rgba(255,180,0,0.12);border-color:rgba(255,180,0,0.3);color:#ffb400}
.cb.o:hover:not(:disabled){background:rgba(255,180,0,0.2)}
.cdiv{width:1px;height:24px;background:#2a2a2a;margin:0 0.2rem}
.ci{background:#0a0a0a;border:1px solid #2a2a2a;border-radius:6px;padding:0.4rem 0.65rem;color:#e0e0e0;font-size:0.78rem;width:80px;outline:none}
.ci:focus{border-color:#444}
.clabel{font-size:0.72rem;color:#555}
.ctoast{font-size:0.72rem;margin-left:0.5rem;opacity:0;transition:opacity 0.3s}
@media(max-width:768px){.cards-row,.charts-row,.tables-row,.three-col{grid-template-columns:1fr}.ctrl-panel{margin:1rem 1rem 0}}
.gear-btn{background:none;border:1px solid #2a2a2a;border-radius:7px;padding:0.35rem 0.5rem;color:#666;cursor:pointer;display:inline-flex;align-items:center;transition:color 0.15s,border-color 0.15s}
.gear-btn:hover{color:#ccc;border-color:#444}
.cfg-overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:1000;align-items:center;justify-content:center;padding:1rem}
.cfg-overlay.open{display:flex}
.cfg-modal{background:#111;border:1px solid #1e1e1e;border-radius:12px;width:100%;max-width:560px;max-height:90vh;overflow-y:auto;padding:1.25rem 1.5rem}
.cfg-modal-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:1rem}
.cfg-modal-header h2{font-size:0.95rem;font-weight:600;color:#fff}
.cfg-close{background:none;border:none;color:#555;font-size:1.2rem;cursor:pointer;padding:0.2rem 0.4rem;border-radius:5px}
.cfg-close:hover{color:#ccc;background:#1e1e1e}
.cfg-sections{display:flex;flex-direction:column;gap:1rem}
.cfg-section{background:#0d0d0d;border:1px solid #1a1a1a;border-radius:8px;padding:0.75rem 1rem}
.cfg-section-title{font-size:0.7rem;color:#666;text-transform:uppercase;letter-spacing:0.08em;margin-bottom:0.6rem;font-weight:600}
.cfg-fields{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:0.75rem}
.cfg-field{display:flex;flex-direction:column;gap:0.3rem}
.cfg-field label{font-size:0.75rem;color:#ccc;font-weight:500}
.cfg-field .cfg-hint{font-size:0.65rem;color:#555;margin-top:-0.1rem}
.cfg-field input{background:#0a0a0a;border:1px solid #2a2a2a;border-radius:6px;padding:0.4rem 0.65rem;color:#e0e0e0;font-size:0.82rem;outline:none;width:100%}
.cfg-field input:focus{border-color:#444}
.cfg-actions{display:flex;align-items:center;gap:0.6rem;margin-top:1rem;flex-wrap:wrap}
.cfg-toast{font-size:0.72rem;margin-left:0.25rem;opacity:0;transition:opacity 0.3s}
@media(max-width:480px){.cfg-fields{grid-template-columns:1fr}}

/* ── Tab Navigation ─────────────────────────────────────────────────────── */
.tab-nav{display:flex;gap:0;border-bottom:1px solid #1e1e1e;padding:0 1.5rem;margin-top:0.5rem}
.tab-btn{padding:0.6rem 1.1rem;font-size:0.8rem;font-weight:600;color:#555;background:none;border:none;border-bottom:2px solid transparent;cursor:pointer;transition:color 0.15s,border-color 0.15s;letter-spacing:0.04em}
.tab-btn:hover{color:#aaa}
.tab-btn.active{color:#fff;border-bottom-color:#00d464}
.tab-panel{display:none}
.tab-panel.active{display:block}

/* ── Analytics Panel ────────────────────────────────────────────────────── */
.an-section{padding:1.25rem 1.5rem;display:flex;flex-direction:column;gap:1rem}
.an-cards-row{display:grid;grid-template-columns:repeat(4,1fr);gap:1rem}
.an-charts-row{display:grid;grid-template-columns:1fr 1fr;gap:1rem}
.an-three-col{display:grid;grid-template-columns:1fr 1fr 1fr;gap:1rem}
.an-card{background:#111;border:1px solid #1e1e1e;border-radius:10px;padding:1rem 1.25rem}
.an-card-label{font-size:0.68rem;color:#666;text-transform:uppercase;letter-spacing:0.08em;margin-bottom:0.4rem}
.an-card-value{font-size:1.5rem;font-weight:700;color:#fff}
.an-card-sub{font-size:0.72rem;color:#555;margin-top:0.2rem}
.an-chart-card{background:#111;border:1px solid #1e1e1e;border-radius:10px;padding:1rem 1.25rem}
.an-chart-card h3{font-size:0.82rem;font-weight:600;color:#ccc;margin-bottom:0.75rem}
.an-chart-wrap{position:relative;height:160px}
.an-section-title{font-size:0.72rem;color:#555;text-transform:uppercase;letter-spacing:0.08em;margin-bottom:0.75rem;font-weight:600}
.an-metric-row{display:flex;justify-content:space-between;align-items:center;padding:0.45rem 0;border-bottom:1px solid #141414;font-size:0.78rem}
.an-metric-row:last-child{border-bottom:none}
.an-metric-label{color:#666}
.an-metric-value{color:#ccc;font-weight:600}
.an-trade-card{background:#0d0d0d;border:1px solid #1a1a1a;border-radius:8px;padding:0.75rem 1rem}
.an-trade-card-title{font-size:0.68rem;color:#555;text-transform:uppercase;letter-spacing:0.08em;margin-bottom:0.5rem}
.an-trade-pnl{font-size:1.2rem;font-weight:700;margin-bottom:0.25rem}
.an-trade-meta{font-size:0.7rem;color:#555}
@media(max-width:900px){.an-cards-row{grid-template-columns:1fr 1fr}}
@media(max-width:600px){.an-cards-row,.an-charts-row,.an-three-col{grid-template-columns:1fr}}
`;

    const body = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>SoDEX Dashboard</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"><\/script>
<style>${css}</style>
</head>
<body>

<div class="header">
  <div class="header-top">
    <div class="header-title">
      <h1>SoDEX AGENT Dashboard</h1>
      <span id="status-badge" class="status-badge status-stopped"><span class="dot"></span><span id="status-text">STOPPED</span></span>
    </div>
    <div style="display:flex;align-items:center;gap:0.75rem">
      <div style="font-size:0.72rem;color:#555;" id="updated-at"></div>
      <button class="gear-btn" onclick="openCfgModal()" title="Bot Settings">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
      </button>
    </div>
  </div>
  <div class="header-meta"><span id="symbol-label">BTC-USD</span></div>
  <div class="wallet">WALLET: <span id="wallet-addr">—</span></div>
</div>

<nav class="tab-nav">
  <button class="tab-btn active" id="tabnav-overview" onclick="switchMainTab('overview')">Overview</button>
  <button class="tab-btn" id="tabnav-analytics" onclick="switchMainTab('analytics')">Analytics</button>
</nav>

<div class="tab-panel active" id="tabpanel-overview">
<div class="main" style="padding-bottom:0">
  <div class="three-col">
    <div id="tier-card-wrap"><div class="tier-empty">Loading SoPoints...</div></div>
    <div class="week-card">
      <div class="week-label" id="week-label">Current Week</div>
      <div class="week-vol" id="week-vol">—</div>
      <div class="week-vol-sub">Futures Volume</div>
      <div class="week-countdown"><span class="cd-label">Next Distribution</span><span id="week-cd">—</span></div>
    </div>
    <div class="pos-card">
      <div class="table-header"><h3>Open Position</h3><span id="pos-badge"></span></div>
      <div id="pos-body"><div class="pos-empty">No open position</div></div>
    </div>
  </div>
</div>

<div class="ctrl-panel">
  <div class="ctrl-title">Bot Controls</div>
  <div class="ctrl-row">
    <button class="cb g" id="btn-start" onclick="ctrlStart()">
      <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor"><polygon points="2,1 11,6 2,11"/></svg> Start
    </button>
    <button class="cb r" id="btn-stop" onclick="ctrlStop()" disabled>
      <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor"><rect x="2" y="2" width="8" height="8" rx="1"/></svg> Stop
    </button>
    <div class="cdiv"></div>
    <span class="clabel">Mode:</span>
    <button class="cb" id="btn-farm" onclick="ctrlSetMode('farm')">🚜 Farm</button>
    <button class="cb" id="btn-trade" onclick="ctrlSetMode('trade')">📈 Trade</button>
    <div class="cdiv"></div>
    <span class="clabel">Max Loss $</span>
    <input class="ci" id="input-maxloss" type="number" min="1" step="1" value="5"/>
    <button class="cb" onclick="ctrlSetMaxLoss()">Set</button>
    <div class="cdiv"></div>
    <button class="cb o" onclick="ctrlClosePosition()">
      <svg width="12" height="12" viewBox="0 0 12 12" stroke="currentColor" stroke-width="2" fill="none"><line x1="2" y1="2" x2="10" y2="10"/><line x1="10" y1="2" x2="2" y2="10"/></svg> Close Position
    </button>
    <span class="ctoast" id="ctrl-toast"></span>
  </div>
  <div style="margin-top:0.65rem;font-size:0.72rem;color:#444;" id="ctrl-status-line">—</div>
</div>

<!-- Config Settings Modal -->
<div class="cfg-overlay" id="cfg-overlay" onclick="if(event.target===this)closeCfgModal()">
  <div class="cfg-modal">
    <div class="cfg-modal-header">
      <h2>⚙️ Bot Settings</h2>
      <button class="cfg-close" onclick="closeCfgModal()">✕</button>
    </div>
    <div class="cfg-sections">
      <div class="cfg-section">
        <div class="cfg-section-title">📦 Order Sizing</div>
        <div class="cfg-fields">
          <div class="cfg-field">
            <label>Min Order Size (BTC)</label>
            <div class="cfg-hint">Lệnh nhỏ nhất mỗi lần vào</div>
            <input type="number" id="cfg-ORDER_SIZE_MIN" step="any" min="0" placeholder="e.g. 0.003"/>
          </div>
          <div class="cfg-field">
            <label>Max Order Size (BTC)</label>
            <div class="cfg-hint">Lệnh lớn nhất mỗi lần vào</div>
            <input type="number" id="cfg-ORDER_SIZE_MAX" step="any" min="0" placeholder="e.g. 0.005"/>
          </div>
        </div>
      </div>
      <div class="cfg-section">
        <div class="cfg-section-title">🛡️ Risk Management</div>
        <div class="cfg-fields">
          <div class="cfg-field">
            <label>Stop Loss % (order)</label>
            <div class="cfg-hint">Cắt lỗ theo lệnh (0.05 = 5%)</div>
            <input type="number" id="cfg-STOP_LOSS_PERCENT" step="any" min="0" max="1" placeholder="e.g. 0.05"/>
          </div>
          <div class="cfg-field">
            <label>Take Profit % (order)</label>
            <div class="cfg-hint">Chốt lời theo lệnh (0.05 = 5%)</div>
            <input type="number" id="cfg-TAKE_PROFIT_PERCENT" step="any" min="0" max="1" placeholder="e.g. 0.05"/>
          </div>
          <div class="cfg-field">
            <label>Position Stop Loss %</label>
            <div class="cfg-hint">Cắt lỗ toàn bộ vị thế</div>
            <input type="number" id="cfg-POSITION_SL_PERCENT" step="any" min="0" max="1" placeholder="e.g. 0.05"/>
          </div>
        </div>
      </div>
      <div class="cfg-section">
        <div class="cfg-section-title">🚜 Farm Mode — Exit Rules</div>
        <div class="cfg-fields">
          <div class="cfg-field">
            <label>Min Hold Time (secs)</label>
            <div class="cfg-hint">Giữ lệnh tối thiểu bao lâu</div>
            <input type="number" id="cfg-FARM_MIN_HOLD_SECS" step="1" min="0" placeholder="e.g. 120"/>
          </div>
          <div class="cfg-field">
            <label>Max Hold Time (secs)</label>
            <div class="cfg-hint">Giữ lệnh tối đa bao lâu</div>
            <input type="number" id="cfg-FARM_MAX_HOLD_SECS" step="1" min="0" placeholder="e.g. 300"/>
          </div>
          <div class="cfg-field">
            <label>Take Profit ($)</label>
            <div class="cfg-hint">Chốt lời khi lãi đủ số USD này</div>
            <input type="number" id="cfg-FARM_TP_USD" step="any" min="0" placeholder="e.g. 5.0"/>
          </div>
          <div class="cfg-field">
            <label>Stop Loss %</label>
            <div class="cfg-hint">Cắt lỗ farm mode (0.003 = 0.3%)</div>
            <input type="number" id="cfg-FARM_SL_PERCENT" step="any" min="0" max="1" placeholder="e.g. 0.003"/>
          </div>
          <div class="cfg-field">
            <label>Score Edge</label>
            <div class="cfg-hint">Min edge để vào lệnh (0.03 = 3%)</div>
            <input type="number" id="cfg-FARM_SCORE_EDGE" step="any" min="0" max="0.5" placeholder="e.g. 0.03"/>
          </div>
          <div class="cfg-field">
            <label>Min Confidence</label>
            <div class="cfg-hint">Confidence tối thiểu khi fallback</div>
            <input type="number" id="cfg-FARM_MIN_CONFIDENCE" step="any" min="0" max="1" placeholder="e.g. 0.50"/>
          </div>
          <div class="cfg-field">
            <label>Early Exit After (secs)</label>
            <div class="cfg-hint">Thoát sớm nếu giữ đủ lâu và có lời</div>
            <input type="number" id="cfg-FARM_EARLY_EXIT_SECS" step="1" min="0" placeholder="e.g. 120"/>
          </div>
          <div class="cfg-field">
            <label>Early Exit PnL ($)</label>
            <div class="cfg-hint">PnL tối thiểu để thoát sớm</div>
            <input type="number" id="cfg-FARM_EARLY_EXIT_PNL" step="any" min="0" placeholder="e.g. 2.0"/>
          </div>
          <div class="cfg-field">
            <label>Extra Wait (secs)</label>
            <div class="cfg-hint">Chờ thêm sau hold time nếu đang lời</div>
            <input type="number" id="cfg-FARM_EXTRA_WAIT_SECS" step="1" min="0" placeholder="e.g. 30"/>
          </div>
          <div class="cfg-field" style="grid-column:1/-1">
            <label>Blocked Hours UTC (farm)</label>
            <div class="cfg-hint">Giờ UTC không vào lệnh, cách nhau bằng dấu phẩy. Để trống = không block. Ví dụ: 7,8,9,10,11,18,19,20,21,22,23</div>
            <input type="text" id="cfg-FARM_BLOCKED_HOURS" placeholder="e.g. 7,8,9,10,11 (để trống = không block)"/>
          </div>
        </div>
      </div>
      <div class="cfg-section">
        <div class="cfg-section-title">📈 Trade Mode — Exit Rules</div>
        <div class="cfg-fields">
          <div class="cfg-field">
            <label>Take Profit %</label>
            <div class="cfg-hint">Chốt lời trade mode (0.10 = 10%)</div>
            <input type="number" id="cfg-TRADE_TP_PERCENT" step="any" min="0" max="1" placeholder="e.g. 0.10"/>
          </div>
          <div class="cfg-field">
            <label>Stop Loss %</label>
            <div class="cfg-hint">Cắt lỗ trade mode (0.10 = 10%)</div>
            <input type="number" id="cfg-TRADE_SL_PERCENT" step="any" min="0" max="1" placeholder="e.g. 0.10"/>
          </div>
        </div>
      </div>
      <div class="cfg-section">
        <div class="cfg-section-title">⏸️ Cooldown (nghỉ giữa lệnh)</div>
        <div class="cfg-fields">
          <div class="cfg-field">
            <label>Min Cooldown (mins)</label>
            <div class="cfg-hint">Nghỉ tối thiểu sau mỗi lệnh</div>
            <input type="number" id="cfg-COOLDOWN_MIN_MINS" step="1" min="0" placeholder="e.g. 2"/>
          </div>
          <div class="cfg-field">
            <label>Max Cooldown (mins)</label>
            <div class="cfg-hint">Nghỉ tối đa sau mỗi lệnh</div>
            <input type="number" id="cfg-COOLDOWN_MAX_MINS" step="1" min="0" placeholder="e.g. 10"/>
          </div>
        </div>
      </div>
      <div class="cfg-section">
        <div class="cfg-section-title">🧹 Dust Position</div>
        <div class="cfg-fields">
          <div class="cfg-field">
            <label>Min Position Value ($)</label>
            <div class="cfg-hint">Bỏ qua đóng lệnh nếu giá trị vị thế nhỏ hơn mức này (tránh lỗi API)</div>
            <input type="number" id="cfg-MIN_POSITION_VALUE_USD" step="1" min="1" placeholder="e.g. 20"/>
          </div>
        </div>
      </div>
      <div class="cfg-section">
        <div class="cfg-section-title">🔑 SoDex SoPoints Token</div>
        <div class="cfg-fields" style="grid-template-columns:1fr;">
          <div class="cfg-field">
            <label>API Token</label>
            <div class="cfg-hint">Paste token mới khi hết hạn — không cần restart bot</div>
            <input type="password" id="sopoints-token-input" placeholder="Paste new token..."/>
          </div>
        </div>
        <div style="margin-top:0.75rem;display:flex;align-items:center;gap:0.6rem;">
          <button class="cb g" onclick="updateSoPointsToken()">✓ Update Token</button>
          <span id="sopoints-token-toast" style="font-size:0.72rem;opacity:0;transition:opacity 0.3s;"></span>
        </div>
      </div>
    </div>
    <div class="cfg-actions">
      <button class="cb g" id="cfg-apply-btn" onclick="applyConfig()">✓ Apply</button>
      <button class="cb" id="cfg-reset-btn" onclick="resetConfig()">↺ Reset to Defaults</button>
      <span class="cfg-toast" id="cfg-toast"></span>
    </div>
  </div>
</div>

<div class="main">
  <div class="cards-row">
    <div class="card">
      <div class="card-label">SESSION PnL</div>
      <div class="card-value" id="pnl-value">+$0.00</div>
      <div class="progress-bar"><div class="progress-fill" id="pnl-bar" style="width:0%;background:#00d464;"></div></div>
      <div class="card-sub">Session running</div>
    </div>
    <div class="card">
      <div class="card-label">TRADING VOLUME</div>
      <div class="card-value" id="vol-value">$0.00</div>
      <div class="progress-bar"><div class="progress-fill" id="vol-bar" style="width:0%;background:#6496ff;"></div></div>
      <div class="card-sub">Cumulative session volume</div>
    </div>
  </div>
  <div class="charts-row">
    <div class="chart-card"><h3>Session PnL</h3><div class="chart-wrap"><canvas id="pnl-chart"></canvas></div></div>
    <div class="chart-card"><h3>Trading Volume</h3><div class="chart-wrap"><canvas id="vol-chart"></canvas></div></div>
  </div>
  <div class="charts-row">
    <div class="log-card" style="grid-column:1/-1">
      <div class="log-header">
        <h3>Realtime Log</h3>
        <span class="log-live"><span class="dot"></span>LIVE</span>
      </div>
      <div class="log-tabs">
        <button class="log-tab" id="tab-events" onclick="switchTab('events')">Events</button>
        <button class="log-tab active" id="tab-console" onclick="switchTab('console')">Console</button>
      </div>
      <div class="log-body" id="log-events" style="display:none"></div>
      <div class="log-body" id="log-console"></div>
    </div>
  </div>
  <div class="tables-row">
    <div class="table-card">
      <div class="table-header"><h3>Trade History</h3><span class="table-count" id="trade-count"></span></div>
      <table><thead><tr><th>Order ID</th><th>Date</th><th>Side</th><th>Price</th><th>PnL</th></tr></thead>
      <tbody id="trades-body"><tr><td colspan="5" style="color:#444;text-align:center;padding:1rem;">No trades yet.</td></tr></tbody></table>
      <div class="pagination">
        <span id="trade-page-info">Page 1</span>
        <div style="display:flex;gap:0.5rem;">
          <button id="trade-prev" onclick="tradePage(-1)" disabled>&#8249; Prev</button>
          <button id="trade-next" onclick="tradePage(1)">Next &#8250;</button>
        </div>
      </div>
    </div>
    <div class="table-card">
      <div class="table-header"><h3>Event Log</h3><span class="table-count" id="event-count"></span></div>
      <table><thead><tr><th>Time</th><th>Type</th><th>Message</th></tr></thead>
      <tbody id="events-body"><tr><td colspan="3" style="color:#444;text-align:center;padding:1rem;">No events yet.</td></tr></tbody></table>
      <div class="pagination">
        <span id="event-page-info">Page 1</span>
        <div style="display:flex;gap:0.5rem;">
          <button id="event-prev" onclick="eventPage(-1)" disabled>&#8249; Prev</button>
          <button id="event-next" onclick="eventPage(1)">Next &#8250;</button>
        </div>
      </div>
    </div>
  </div>
</div>

</div><!-- /tabpanel-overview -->

<!-- ── Analytics Tab Panel ─────────────────────────────────────────────── -->
<div class="tab-panel" id="tabpanel-analytics">
  <div class="an-section">

    <!-- Stat Cards Row -->
    <div class="an-cards-row">
      <div class="an-card">
        <div class="an-card-label">Overall Win Rate</div>
        <div class="an-card-value" id="an-winrate">—</div>
        <div class="an-card-sub" id="an-winrate-sub">— trades</div>
      </div>
      <div class="an-card">
        <div class="an-card-label">Avg PnL / Trade</div>
        <div class="an-card-value" id="an-avgpnl">—</div>
        <div class="an-card-sub" id="an-streak">—</div>
      </div>
      <div class="an-card">
        <div class="an-card-label">Total Trades</div>
        <div class="an-card-value" id="an-total">—</div>
        <div class="an-card-sub" id="an-wl">— W / — L</div>
      </div>
      <div class="an-card">
        <div class="an-card-label">Total Fees Paid</div>
        <div class="an-card-value" id="an-fees">—</div>
        <div class="an-card-sub" id="an-feelosers">— fee-losers</div>
      </div>
    </div>

    <!-- Mode Win Rate Cards -->
    <div class="an-charts-row">
      <div class="an-card">
        <div class="an-section-title">Win Rate by Mode</div>
        <div id="an-bymode-content">
          <div class="an-metric-row"><span class="an-metric-label">🚜 Farm</span><span class="an-metric-value" id="an-mode-farm">—</span></div>
          <div class="an-metric-row"><span class="an-metric-label">📈 Trade</span><span class="an-metric-value" id="an-mode-trade">—</span></div>
        </div>
      </div>
      <div class="an-card">
        <div class="an-section-title">Signal Quality</div>
        <div class="an-metric-row"><span class="an-metric-label">LLM Match Rate</span><span class="an-metric-value" id="an-llm-match">—</span></div>
        <div class="an-metric-row"><span class="an-metric-label">Fallback Rate</span><span class="an-metric-value" id="an-fallback">—</span></div>
        <div class="an-metric-row"><span class="an-metric-label">Avg Confidence</span><span class="an-metric-value" id="an-avg-conf">—</span></div>
      </div>
    </div>

    <!-- Bar Charts Row 1 -->
    <div class="an-charts-row">
      <div class="an-chart-card">
        <h3>Win Rate by Direction</h3>
        <div class="an-chart-wrap"><canvas id="an-chart-direction"></canvas></div>
      </div>
      <div class="an-chart-card">
        <h3>Win Rate by Regime</h3>
        <div class="an-chart-wrap"><canvas id="an-chart-regime"></canvas></div>
      </div>
    </div>

    <!-- Bar Charts Row 2 -->
    <div class="an-charts-row">
      <div class="an-chart-card">
        <h3>Win Rate by Confidence Band</h3>
        <div class="an-chart-wrap"><canvas id="an-chart-confidence"></canvas></div>
      </div>
      <div class="an-chart-card">
        <h3>Win Rate by Hour (UTC)</h3>
        <div class="an-chart-wrap"><canvas id="an-chart-hour"></canvas></div>
      </div>
    </div>

    <!-- Best / Worst Trade + Holding Time -->
    <div class="an-three-col">
      <div class="an-card">
        <div class="an-section-title">Best Trade</div>
        <div class="an-trade-card">
          <div class="an-trade-pnl positive" id="an-best-pnl">—</div>
          <div class="an-trade-meta" id="an-best-meta">—</div>
        </div>
      </div>
      <div class="an-card">
        <div class="an-section-title">Worst Trade</div>
        <div class="an-trade-card">
          <div class="an-trade-pnl negative" id="an-worst-pnl">—</div>
          <div class="an-trade-meta" id="an-worst-meta">—</div>
        </div>
      </div>
      <div class="an-chart-card">
        <h3>Holding Time (Farm)</h3>
        <div class="an-chart-wrap"><canvas id="an-chart-holding"></canvas></div>
      </div>
    </div>

  </div>
</div><!-- /tabpanel-analytics -->

<script>
const PAGE_SIZE = 10;
let allTrades = [], allEvents = [], tradePg = 1, eventPg = 1;
let pnlChart, volChart;

function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function fmt(iso) { const d=new Date(iso); return d.toLocaleDateString('en-US',{month:'short',day:'numeric'})+', '+d.toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit',hour12:false}); }
function fmtS(iso) { return new Date(iso).toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}); }

function initCharts() {
  const opts = (label, color) => ({
    type: 'line',
    data: { labels: [], datasets: [{ label, data: [], borderColor: color, backgroundColor: color+'18', borderWidth: 1.5, pointRadius: 0, fill: true, tension: 0.3 }] },
    options: { responsive: true, maintainAspectRatio: false, animation: false, plugins: { legend: { display: false } },
      scales: { x: { ticks: { color:'#444', font:{size:10}, maxTicksLimit:6 }, grid:{color:'#1a1a1a'} }, y: { ticks:{color:'#444',font:{size:10}}, grid:{color:'#1a1a1a'} } } }
  });
  pnlChart = new Chart(document.getElementById('pnl-chart'), opts('PnL','#00d464'));
  volChart = new Chart(document.getElementById('vol-chart'), opts('Volume','#6496ff'));
}

function updateCharts(ph, vh) {
  const upd = (c,h) => { c.data.labels=h.map(p=>fmtS(p.time)); c.data.datasets[0].data=h.map(p=>p.value); c.update('none'); };
  if (ph.length) upd(pnlChart, ph);
  if (vh.length) upd(volChart, vh);
}

function renderTrades() {
  const tbody = document.getElementById('trades-body'), total = allTrades.length;
  document.getElementById('trade-count').textContent = total ? 'Showing '+Math.min((tradePg-1)*PAGE_SIZE+1,total)+'-'+Math.min(tradePg*PAGE_SIZE,total)+' of '+total : '';
  document.getElementById('trade-page-info').textContent = 'Page '+tradePg+' of '+Math.max(1,Math.ceil(total/PAGE_SIZE));
  document.getElementById('trade-prev').disabled = tradePg<=1;
  document.getElementById('trade-next').disabled = tradePg>=Math.ceil(total/PAGE_SIZE);
  if (!total) { tbody.innerHTML='<tr><td colspan="5" style="color:#444;text-align:center;padding:1rem;">No trades yet.</td></tr>'; return; }
  tbody.innerHTML = allTrades.slice((tradePg-1)*PAGE_SIZE,tradePg*PAGE_SIZE).map(t => {
    const side = t.direction==='long'?'<span class="side-badge side-buy">BUY</span>':'<span class="side-badge side-sell">SELL</span>';
    const pc = t.pnl>=0?'positive':'negative';
    const id = t.id?t.id.slice(0,8)+'...'+t.id.slice(-4):'—';
    const price = t.exitPrice?'$'+Number(t.exitPrice).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}):'—';
    const pnlv = (t.pnl>=0?'+':'')+'$'+Number(t.pnl).toFixed(4);
    return '<tr><td style="font-family:monospace;font-size:0.7rem;">'+esc(id)+'</td><td>'+fmt(t.timestamp)+'</td><td>'+side+'</td><td>'+price+'</td><td class="'+pc+'">'+pnlv+'</td></tr>';
  }).join('');
}

function renderEvents() {
  const tbody = document.getElementById('events-body'), total = allEvents.length;
  document.getElementById('event-count').textContent = total ? 'Showing '+Math.min((eventPg-1)*PAGE_SIZE+1,total)+'-'+Math.min(eventPg*PAGE_SIZE,total)+' of '+total : '';
  document.getElementById('event-page-info').textContent = 'Page '+eventPg+' of '+Math.max(1,Math.ceil(total/PAGE_SIZE));
  document.getElementById('event-prev').disabled = eventPg<=1;
  document.getElementById('event-next').disabled = eventPg>=Math.ceil(total/PAGE_SIZE);
  if (!total) { tbody.innerHTML='<tr><td colspan="3" style="color:#444;text-align:center;padding:1rem;">No events yet.</td></tr>'; return; }
  tbody.innerHTML = allEvents.slice((eventPg-1)*PAGE_SIZE,eventPg*PAGE_SIZE).map(e => {
    const cls='ev-'+e.type.toLowerCase().replace(/_/g,'-');
    return '<tr><td style="white-space:nowrap;color:#666;">'+fmtS(e.time)+'</td><td><span class="event-badge '+cls+'">'+esc(e.type.replace(/_/g,' '))+'</span></td><td style="color:#aaa;">'+esc(e.message)+'</td></tr>';
  }).join('');
}

function tradePage(d) { tradePg+=d; renderTrades(); }
function eventPage(d) { eventPg+=d; renderEvents(); }

async function refresh() {
  try {
    const [pnlData, trades, events] = await Promise.all([
      fetch('/api/pnl').then(r=>r.json()),
      fetch('/api/trades').then(r=>r.json()),
      fetch('/api/events').then(r=>r.json()),
    ]);
    const badge = document.getElementById('status-badge');
    badge.className = 'status-badge '+(pnlData.botStatus==='RUNNING'?'status-running':'status-stopped');
    document.getElementById('status-text').textContent = pnlData.botStatus||'STOPPED';
    document.getElementById('updated-at').textContent = 'Updated: '+fmtS(pnlData.updatedAt);
    document.getElementById('symbol-label').textContent = pnlData.symbol||'BTC-USD';
    const wa = pnlData.walletAddress||'';
    document.getElementById('wallet-addr').textContent = wa?'****'+wa.slice(-6):'—';
    const pnl = pnlData.sessionPnl||0;
    const pnlEl = document.getElementById('pnl-value');
    pnlEl.textContent = (pnl>=0?'+':'')+'\$'+Math.abs(pnl).toFixed(4);
    pnlEl.className = 'card-value '+(pnl>=0?'positive':'negative');
    document.getElementById('pnl-bar').style.width = Math.min(Math.abs(pnl)/10*100,100)+'%';
    document.getElementById('pnl-bar').style.background = pnl>=0?'#00d464':'#ff4d4d';
    const vol = pnlData.sessionVolume||0;
    document.getElementById('vol-value').textContent = '\$'+vol.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
    document.getElementById('vol-bar').style.width = Math.min(vol/10000*100,100)+'%';
    updateCharts(pnlData.pnlHistory||[], pnlData.volumeHistory||[]);
    allTrades = Array.isArray(trades)?trades:[];
    allEvents = Array.isArray(events)?events:[];
    renderTrades(); renderEvents();
  } catch(e) { console.error('Refresh error:',e); }
}

// ── Open Position ─────────────────────────────────────────────────────────
async function refreshPosition() {
  try {
    const [pos, status] = await Promise.all([
      fetch('/api/position').then(r=>r.json()),
      fetch('/api/status').then(r=>r.json()).catch(()=>null),
    ]);
    const body = document.getElementById('pos-body'), badge = document.getElementById('pos-badge');
    if (!pos) {
      const cd = status && status.cooldown;
      body.innerHTML = cd
        ? '<div class="pos-empty" style="color:#f97316;">⏸ Cooldown active for '+cd+'s</div>'
        : '<div class="pos-empty">No open position</div>';
      badge.textContent=''; return;
    }
    const sc = pos.side==='long'?'pos-side-long':'pos-side-short';
    const pc = pos.unrealizedPnl>=0?'positive':'negative';
    const holdSecs = pos.holdRemainingMs != null ? Math.ceil(pos.holdRemainingMs/1000) : null;
    const holdHtml = holdSecs != null && holdSecs > 0
      ? '<div class="pos-item" style="grid-column:1/-1"><label>Holding</label><span style="color:#f97316;">'+holdSecs+'s remaining</span></div>'
      : '';
    const pnlStr = (pos.unrealizedPnl>=0?'+':'')+'\$'+pos.unrealizedPnl.toFixed(4);
    badge.innerHTML = '<span class="'+sc+'">'+pos.side.toUpperCase()+'</span>';
    body.innerHTML = '<div class="pos-grid">'+
      '<div class="pos-item"><label>Entry Price</label><span>\$'+pos.entryPrice.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})+'</span></div>'+
      '<div class="pos-item"><label>Mark Price</label><span>\$'+pos.markPrice.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})+'</span></div>'+
      '<div class="pos-item"><label>Unrealized PnL</label><span class="'+pc+'">'+pnlStr+'</span></div>'+
      '<div class="pos-item"><label>Size</label><span>'+pos.size+'</span></div>'+
      '<div class="pos-item"><label>Symbol</label><span>'+pos.symbol+'</span></div>'+
      '<div class="pos-item"><label>Duration</label><span>'+pos.durationSecs+'s</span></div>'+
      holdHtml+
      '</div>'+
      '<div style="margin-top:0.75rem">'+
      '<button class="cb r" style="width:100%;justify-content:center;" onclick="ctrlClosePosition()">'+
      '<svg width="12" height="12" viewBox="0 0 12 12" stroke="currentColor" stroke-width="2" fill="none"><line x1="2" y1="2" x2="10" y2="10"/><line x1="10" y1="2" x2="2" y2="10"/></svg>'+
      ' Close Position</button></div>';
  } catch {}
}

// ── Realtime Log (SSE) ────────────────────────────────────────────────────
const LOG_COLORS = { INFO:'background:rgba(100,150,255,0.15);color:#6496ff', ORDER_PLACED:'background:rgba(100,150,255,0.15);color:#6496ff', ORDER_FILLED:'background:rgba(0,212,100,0.15);color:#00d464', ERROR:'background:rgba(255,77,77,0.15);color:#ff4d4d', WARN:'background:rgba(255,180,0,0.15);color:#ffb400' };
let activeTab = 'console';

function switchTab(tab) {
  activeTab = tab;
  document.getElementById('log-events').style.display = tab==='events'?'':'none';
  document.getElementById('log-console').style.display = tab==='console'?'':'none';
  document.getElementById('tab-events').className = 'log-tab'+(tab==='events'?' active':'');
  document.getElementById('tab-console').className = 'log-tab'+(tab==='console'?' active':'');
}

function appendEventLog(entry) {
  const body = document.getElementById('log-events');
  const line = document.createElement('div'); line.className='log-line';
  const style = LOG_COLORS[entry.type]||LOG_COLORS.INFO;
  line.innerHTML = '<span class="log-time">'+fmtS(entry.time)+'</span><span class="log-type" style="'+style+'">'+entry.type.replace(/_/g,' ')+'</span><span class="log-msg">'+esc(entry.message)+'</span>';
  body.appendChild(line); body.scrollTop=body.scrollHeight;
  while(body.children.length>300) body.removeChild(body.firstChild);
}

function appendConsoleLine(entry) {
  const body = document.getElementById('log-console');
  const line = document.createElement('div');
  const isErr = entry.line&&(entry.line.includes('ERROR')||entry.line.includes('error')||entry.line.includes('❌'));
  line.className = 'con-line'+(isErr?' err':'');
  line.textContent = fmtS(entry.time)+'  '+entry.line;
  body.appendChild(line); body.scrollTop=body.scrollHeight;
  while(body.children.length>500) body.removeChild(body.firstChild);
}

function initSSE() {
  const evtEs = new EventSource('/api/events/stream');
  evtEs.onmessage = e => { try { appendEventLog(JSON.parse(e.data)); } catch {} };
  const conEs = new EventSource('/api/console/stream');
  conEs.onmessage = e => { try { appendConsoleLine(JSON.parse(e.data)); } catch {} };
}

// ── SoPoints Tier Card ────────────────────────────────────────────────────
const TIER_CLASS = { BRONZE:'tier-bronze', SILVER:'tier-silver', GOLD:'tier-gold', DIAMOND:'tier-diamond' };

async function refreshTier() {
  try {
    const d = await fetch('/api/sopoints').then(r=>r.json());
    if (d.error) { document.getElementById('tier-card-wrap').innerHTML='<div class="tier-empty">'+esc(d.error)+'</div>'; return; }
    const tier = (d.currentTier||'GOLD').toUpperCase();
    const cls = TIER_CLASS[tier]||'tier-gold';
    const pct = d.nextTierPoints?Math.min(d.totalPoints/d.nextTierPoints*100,100).toFixed(1):100;
    const staleBadge = d.stale ? '<span style="font-size:0.6rem;background:rgba(255,180,0,0.25);color:#ffb400;border-radius:4px;padding:0.1rem 0.4rem;margin-left:0.4rem;">⚠ Expired</span>' : '';
    document.getElementById('tier-card-wrap').innerHTML =
      '<div class="tier-card '+cls+'">'+
        '<div><div class="tier-name">'+esc(tier)+staleBadge+'</div>'+
        '<div style="margin-top:0.5rem"><span class="tier-points">'+Number(d.totalPoints).toLocaleString()+'</span>'+
        '<span class="tier-points-label">SOPOINTS</span></div></div>'+
        '<div>'+(d.nextTier?'<div class="tier-next"><span>NEXT: '+esc(d.nextTier)+'</span><span>'+Number(d.nextTierPoints).toLocaleString()+'</span></div>'+
        '<div class="tier-bar-bg"><div class="tier-bar-fill" style="width:'+pct+'%"></div></div>':'')+
        '<div class="tier-rank">⭐ Rank '+d.rank+' of '+Number(d.totalUser).toLocaleString()+' users</div></div>'+
      '</div>';
  } catch { document.getElementById('tier-card-wrap').innerHTML='<div class="tier-empty">SoPoints unavailable</div>'; }
}

// ── Week Volume Card ──────────────────────────────────────────────────────
let weekDistributionTime = 0;

function formatCountdown(secs) {
  if (secs<=0) return '<span class="cd-num">—</span>';
  const d=Math.floor(secs/86400), h=Math.floor((secs%86400)/3600), m=Math.floor((secs%3600)/60), s=secs%60;
  return (d>0?'<span class="cd-num">'+String(d).padStart(2,'0')+'</span><span class="cd-unit">D</span> <span class="cd-sep">:</span> ':'')+
    '<span class="cd-num">'+String(h).padStart(2,'0')+'</span><span class="cd-unit">H</span> <span class="cd-sep">:</span> '+
    '<span class="cd-num">'+String(m).padStart(2,'0')+'</span><span class="cd-unit">M</span> <span class="cd-sep">:</span> '+
    '<span class="cd-sec">'+String(s).padStart(2,'0')+'</span><span class="cd-unit">S</span>';
}

setInterval(() => {
  if (!weekDistributionTime) return;
  const el = document.getElementById('week-cd');
  if (el) el.innerHTML = formatCountdown(Math.max(0, weekDistributionTime - Math.floor(Date.now()/1000)));
}, 1000);

async function refreshWeek() {
  try {
    const d = await fetch('/api/sopoints/week').then(r=>r.json());
    if (!d||d.error) return;
    const totalVol = (d.futuresVolume||0)+(d.spotVolume||0);
    const staleTag = d.stale ? ' <span style="font-size:0.6rem;background:rgba(255,180,0,0.25);color:#ffb400;border-radius:4px;padding:0.1rem 0.4rem;">⚠ Expired</span>' : '';
    document.getElementById('week-label').innerHTML = esc(d.weekLabel||d.weekName||'Current Week')+staleTag;
    document.getElementById('week-vol').textContent = '\$'+totalVol.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
    weekDistributionTime = d.distributionTime||0;
    const el = document.getElementById('week-cd');
    if (el) el.innerHTML = formatCountdown(Math.max(0, weekDistributionTime - Math.floor(Date.now()/1000)));
  } catch {}
}

// ── Control Panel ─────────────────────────────────────────────────────────
let ctrlRunning = false;

function showToast(msg, isErr) {
  const t = document.getElementById('ctrl-toast');
  t.textContent=msg; t.style.color=isErr?'#ff4d4d':'#00d464'; t.style.opacity='1';
  setTimeout(()=>{t.style.opacity='0';},2500);
}

function updateCtrlButtons(isRunning, mode) {
  ctrlRunning=isRunning;
  document.getElementById('btn-start').disabled=isRunning;
  document.getElementById('btn-stop').disabled=!isRunning;
  document.getElementById('btn-farm').className='cb'+(mode==='farm'?' g':'');
  document.getElementById('btn-trade').className='cb'+(mode==='trade'?' g':'');
}

async function ctrlStart() {
  try { const r=await fetch('/api/control/start',{method:'POST'}),d=await r.json(); if(r.ok){showToast('Bot started',false);refreshCtrlStatus();}else showToast(d.error||'Error',true); } catch{showToast('Failed',true);}
}
async function ctrlStop() {
  try { const r=await fetch('/api/control/stop',{method:'POST'}),d=await r.json(); if(r.ok){showToast('Bot stopped',false);refreshCtrlStatus();}else showToast(d.error||'Error',true); } catch{showToast('Failed',true);}
}
async function ctrlSetMode(mode) {
  try { const r=await fetch('/api/control/set_mode',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({mode})}),d=await r.json(); if(r.ok){showToast('Mode: '+mode,false);updateCtrlButtons(ctrlRunning,mode);}else showToast(d.error||'Error',true); } catch{showToast('Failed',true);}
}
async function ctrlSetMaxLoss() {
  const amount=parseFloat(document.getElementById('input-maxloss').value);
  if(!amount||amount<=0){showToast('Invalid amount',true);return;}
  try { const r=await fetch('/api/control/set_max_loss',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({amount})}),d=await r.json(); if(r.ok)showToast('Max loss: \$'+amount,false);else showToast(d.error||'Error',true); } catch{showToast('Failed',true);}
}
async function ctrlClosePosition() {
  if(!confirm('Force close current position?'))return;
  try { const r=await fetch('/api/control/close_position',{method:'POST'}),d=await r.json(); if(r.ok&&d.ok)showToast('Position closed',false);else showToast('Close failed',true); } catch{showToast('Failed',true);}
}
async function refreshCtrlStatus() {
  try {
    const d=await fetch('/api/control/status').then(r=>r.json());
    updateCtrlButtons(d.isRunning,d.mode);
    document.getElementById('input-maxloss').value=d.maxLoss;
    const uptime=d.uptime?d.uptime+'m uptime':'';
    const pnl=d.currentPnL!==undefined?' · PnL: '+(d.currentPnL>=0?'+':'')+'\$'+d.currentPnL.toFixed(4):'';
    const cd=d.cooldown?' · Cooldown: '+d.cooldown+'s':'';
    const pos=d.hasPosition?' · Position OPEN':'';
    document.getElementById('ctrl-status-line').textContent=(d.isRunning?'🟢 Running':'⚫ Stopped')+(uptime?' · '+uptime:'')+pnl+cd+pos;
  } catch {}
}

// ── Config Panel ──────────────────────────────────────────────────────────
const CFG_KEYS = ['ORDER_SIZE_MIN','ORDER_SIZE_MAX','STOP_LOSS_PERCENT','TAKE_PROFIT_PERCENT','POSITION_SL_PERCENT','FARM_MIN_HOLD_SECS','FARM_MAX_HOLD_SECS','FARM_TP_USD','FARM_SL_PERCENT','FARM_SCORE_EDGE','FARM_MIN_CONFIDENCE','FARM_EARLY_EXIT_SECS','FARM_EARLY_EXIT_PNL','FARM_EXTRA_WAIT_SECS','FARM_BLOCKED_HOURS','TRADE_TP_PERCENT','TRADE_SL_PERCENT','COOLDOWN_MIN_MINS','COOLDOWN_MAX_MINS','MIN_POSITION_VALUE_USD'];

function openCfgModal() {
  loadConfigPanel();
  document.getElementById('cfg-overlay').classList.add('open');
}
function closeCfgModal() {
  document.getElementById('cfg-overlay').classList.remove('open');
}

function populateConfigFields(cfg) {
  for (const k of CFG_KEYS) {
    const el = document.getElementById('cfg-'+k);
    if (el && cfg[k] !== undefined) {
      // FARM_BLOCKED_HOURS is an array — render as comma-separated string
      if (k === 'FARM_BLOCKED_HOURS') {
        el.value = Array.isArray(cfg[k]) ? cfg[k].join(',') : '';
      } else {
        el.value = cfg[k];
      }
    }
  }
}

function showCfgToast(msg, isErr) {
  const t = document.getElementById('cfg-toast');
  t.textContent = msg; t.style.color = isErr ? '#ff4d4d' : '#00d464'; t.style.opacity = '1';
  setTimeout(() => { t.style.opacity = '0'; }, 3000);
}

function setCfgBusy(busy) {
  document.getElementById('cfg-apply-btn').disabled = busy;
  document.getElementById('cfg-reset-btn').disabled = busy;
}

async function loadConfigPanel() {
  try {
    const cfg = await fetch('/api/config').then(r => r.json());
    populateConfigFields(cfg);
  } catch(e) { console.error('loadConfigPanel error:', e); }
}

async function applyConfig() {
  setCfgBusy(true);
  try {
    const patch = {};
    for (const k of CFG_KEYS) {
      const el = document.getElementById('cfg-'+k);
      if (!el || el.value === '') continue;
      if (k === 'FARM_BLOCKED_HOURS') {
        // Parse comma-separated string to array of integers
        const raw = el.value.trim();
        patch[k] = raw === '' ? [] : raw.split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n));
      } else {
        patch[k] = parseFloat(el.value);
      }
    }
    const r = await fetch('/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) });
    const d = await r.json();
    if (r.ok) { populateConfigFields(d); showCfgToast('Config applied ✓', false); setTimeout(closeCfgModal, 1200); }
    else { const msg = d.errors ? d.errors.map(e => e.field+': '+e.message).join('; ') : (d.error||'Error'); showCfgToast(msg, true); }
  } catch(e) { showCfgToast('Request failed', true); }
  finally { setCfgBusy(false); }
}

async function resetConfig() {
  setCfgBusy(true);
  try {
    const r = await fetch('/api/config', { method: 'DELETE' });
    const d = await r.json();
    if (r.ok) { populateConfigFields(d); showCfgToast('Reset to defaults', false); }
    else showCfgToast(d.error||'Error', true);
  } catch(e) { showCfgToast('Request failed', true); }
  finally { setCfgBusy(false); }
}

// ── Init ──────────────────────────────────────────────────────────────────
initCharts();
refresh();
refreshPosition();
refreshCtrlStatus();
refreshTier();
refreshWeek();
initSSE();
setInterval(refresh, 5000);
setInterval(refreshPosition, 3000);
setInterval(refreshCtrlStatus, 5000);
setInterval(refreshTier, 5*60*1000);
setInterval(refreshWeek, 5*60*1000);

// ── Main Tab Navigation ───────────────────────────────────────────────────
let activeMainTab = 'overview';
let analyticsInterval = null;
let analyticsCharts = {};

function switchMainTab(tab) {
  activeMainTab = tab;
  ['overview','analytics'].forEach(t => {
    document.getElementById('tabpanel-'+t).classList.toggle('active', t===tab);
    document.getElementById('tabnav-'+t).classList.toggle('active', t===tab);
  });
  if (tab === 'analytics') {
    refreshAnalytics();
    if (!analyticsInterval) analyticsInterval = setInterval(refreshAnalytics, 30000);
  } else {
    if (analyticsInterval) { clearInterval(analyticsInterval); analyticsInterval = null; }
  }
}

// ── Analytics Rendering ───────────────────────────────────────────────────
function pct(v) { return (v !== undefined && v !== null) ? (v*100).toFixed(1)+'%' : '—'; }
function usdFmt(v) { return (v !== undefined && v !== null) ? (v>=0?'+':'') + Number(v).toFixed(4) : '—'; }
function makeBarChart(canvasId, labels, data, color) {
  if (analyticsCharts[canvasId]) { analyticsCharts[canvasId].destroy(); }
  const ctx = document.getElementById(canvasId);
  if (!ctx) return;
  analyticsCharts[canvasId] = new Chart(ctx, {
    type: 'bar',
    data: { labels, datasets: [{ data, backgroundColor: color+'99', borderColor: color, borderWidth: 1 }] },
    options: { responsive: true, maintainAspectRatio: false, animation: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { color:'#555', font:{size:10} }, grid:{color:'#1a1a1a'} },
        y: { min:0, max:1, ticks:{ color:'#555', font:{size:10}, callback: function(v){ return (v*100).toFixed(0)+'%'; } }, grid:{color:'#1a1a1a'} }
      }
    }
  });
}
function makeCountChart(canvasId, labels, data, color) {
  if (analyticsCharts[canvasId]) { analyticsCharts[canvasId].destroy(); }
  const ctx = document.getElementById(canvasId);
  if (!ctx) return;
  analyticsCharts[canvasId] = new Chart(ctx, {
    type: 'bar',
    data: { labels, datasets: [{ data, backgroundColor: color+'99', borderColor: color, borderWidth: 1 }] },
    options: { responsive: true, maintainAspectRatio: false, animation: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { color:'#555', font:{size:10} }, grid:{color:'#1a1a1a'} },
        y: { ticks:{ color:'#555', font:{size:10} }, grid:{color:'#1a1a1a'} }
      }
    }
  });
}
function renderAnalytics(s) {
  var wr = s.overall.winRate;
  var wrEl = document.getElementById('an-winrate');
  wrEl.textContent = pct(wr);
  wrEl.className = 'an-card-value ' + (wr >= 0.5 ? 'positive' : 'negative');
  document.getElementById('an-winrate-sub').textContent = s.overall.total + ' trades';
  var ap = s.avgPnl;
  var apEl = document.getElementById('an-avgpnl');
  apEl.textContent = usdFmt(ap);
  apEl.className = 'an-card-value ' + (ap >= 0 ? 'positive' : 'negative');
  var streak = s.currentStreak;
  document.getElementById('an-streak').textContent = 'Streak: ' + streak.count + ' ' + streak.type + (streak.count !== 1 ? 's' : '');
  document.getElementById('an-total').textContent = s.overall.total;
  document.getElementById('an-wl').textContent = s.overall.wins + ' W / ' + s.overall.losses + ' L';
  var fi = s.feeImpact;
  var feesEl = document.getElementById('an-fees');
  feesEl.textContent = usdFmt(fi.totalFeePaid);
  feesEl.className = 'an-card-value negative';
  document.getElementById('an-feelosers').textContent = fi.tradesWonBeforeFee + ' fee-losers (' + pct(fi.feeLoserRate) + ')';
  var fm = s.byMode.farm, tr2 = s.byMode.trade;
  document.getElementById('an-mode-farm').textContent = pct(fm.winRate) + ' (' + fm.total + ' trades)';
  document.getElementById('an-mode-trade').textContent = pct(tr2.winRate) + ' (' + tr2.total + ' trades)';
  var sq = s.signalQuality;
  document.getElementById('an-llm-match').textContent = pct(sq.llmMatchesMomentumRate);
  document.getElementById('an-fallback').textContent = pct(sq.fallbackRate);
  document.getElementById('an-avg-conf').textContent = (sq.avgConfidence !== undefined) ? (sq.avgConfidence*100).toFixed(1)+'%' : '—';
  var dirs = s.byDirection;
  makeBarChart('an-chart-direction', ['Long','Short'], [dirs.long.winRate||0, dirs.short.winRate||0], '#00d464');
  var reg = s.byRegime;
  makeBarChart('an-chart-regime', ['Trend Up','Trend Down','Sideway'], [reg.TREND_UP.winRate||0, reg.TREND_DOWN.winRate||0, reg.SIDEWAY.winRate||0], '#6496ff');
  if (s.byConfidence && s.byConfidence.length) {
    makeBarChart('an-chart-confidence', s.byConfidence.map(function(b){return b.label;}), s.byConfidence.map(function(b){return b.winRate||0;}), '#ffb400');
  }
  if (s.byHour && s.byHour.length) {
    makeBarChart('an-chart-hour', s.byHour.map(function(b){return b.label||String(b.hour)+'h';}), s.byHour.map(function(b){return b.winRate||0;}), '#f97316');
  }
  if (s.bestTrade) {
    document.getElementById('an-best-pnl').textContent = usdFmt(s.bestTrade.pnl);
    document.getElementById('an-best-meta').textContent = s.bestTrade.direction + ' · ' + (s.bestTrade.regime||'—') + ' · ' + (s.bestTrade.timestamp ? new Date(s.bestTrade.timestamp).toLocaleDateString() : '—');
  }
  if (s.worstTrade) {
    document.getElementById('an-worst-pnl').textContent = usdFmt(s.worstTrade.pnl);
    document.getElementById('an-worst-meta').textContent = s.worstTrade.direction + ' · ' + (s.worstTrade.regime||'—') + ' · ' + (s.worstTrade.timestamp ? new Date(s.worstTrade.timestamp).toLocaleDateString() : '—');
  }
  if (s.holdingTime && s.holdingTime.distribution && s.holdingTime.distribution.length) {
    makeCountChart('an-chart-holding', s.holdingTime.distribution.map(function(b){return b.bucket;}), s.holdingTime.distribution.map(function(b){return b.count;}), '#00d464');
  }
}
async function refreshAnalytics() {
  try {
    var s = await fetch('/api/analytics/summary').then(function(r){return r.json();});
    if (s.error) return;
    renderAnalytics(s);
  } catch(e) { console.error('Analytics refresh error:', e); }
}

async function updateSoPointsToken() {
  const input = document.getElementById('sopoints-token-input');
  const toast = document.getElementById('sopoints-token-toast');
  const token = input.value.trim();
  if (!token) return;
  try {
    const r = await fetch('/api/sopoints/token', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ token }) });
    const d = await r.json();
    if (d.ok) {
      toast.textContent = '✓ Updated'; toast.style.color = '#00d464';
      input.value = '';
      refreshTier(); refreshWeek();
    } else {
      toast.textContent = '✗ ' + (d.error||'Failed'); toast.style.color = '#ff4d4d';
    }
  } catch { toast.textContent = '✗ Error'; toast.style.color = '#ff4d4d'; }
  toast.style.opacity = '1';
  setTimeout(() => { toast.style.opacity = '0'; }, 3000);
}
<\/script>
</body>
</html>`;

    return body;
  }
}
