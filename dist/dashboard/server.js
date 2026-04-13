"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.DashboardServer = void 0;
const express_1 = __importDefault(require("express"));
const crypto_1 = require("crypto");
const sharedState_js_1 = require("../ai/sharedState.js");
const routes_js_1 = require("../ai/TradingMemory/routes.js");
const config_js_1 = require("../config.js");
const validTokens = new Map();
const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
function generateToken() {
    return (0, crypto_1.randomBytes)(32).toString('hex');
}
function hashPasscode(passcode) {
    return (0, crypto_1.createHash)('sha256').update(passcode).digest('hex');
}
class DashboardServer {
    tradeLogger;
    port;
    passcodeHash;
    sessionManager = null;
    watcher = null;
    watcherRunner = null;
    app;
    constructor(tradeLogger, port) {
        this.tradeLogger = tradeLogger;
        this.port = port;
        const passcode = process.env.DASHBOARD_PASSCODE;
        this.passcodeHash = passcode ? hashPasscode(passcode) : null;
        this.app = (0, express_1.default)();
        this.app.use(express_1.default.json());
        this._setupRoutes();
    }
    setBotControls(sessionManager, watcher, runWatcher) {
        this.sessionManager = sessionManager;
        this.watcher = watcher;
        this.watcherRunner = runWatcher;
    }
    _isAuthenticated(req) {
        if (!this.passcodeHash)
            return true;
        const cookie = req.headers.cookie || '';
        const match = cookie.match(/dash_token=([a-f0-9]+)/);
        if (!match)
            return false;
        const token = match[1];
        const expiry = validTokens.get(token);
        if (!expiry || Date.now() > expiry) {
            validTokens.delete(token);
            return false;
        }
        return true;
    }
    _authMiddleware = (req, res, next) => {
        if (req.path === '/login' || req.path === '/api/login') {
            next();
            return;
        }
        if (!this._isAuthenticated(req)) {
            if (req.path.startsWith('/api/')) {
                res.status(401).json({ error: 'Unauthorized' });
            }
            else {
                res.setHeader('Content-Type', 'text/html');
                res.send(this._buildLoginHtml());
            }
            return;
        }
        next();
    };
    _setupRoutes() {
        this.app.use(this._authMiddleware);
        this.app.post('/api/login', (req, res) => {
            const { passcode } = req.body;
            if (!passcode || hashPasscode(passcode) !== this.passcodeHash) {
                res.status(401).json({ error: 'Invalid passcode' });
                return;
            }
            const token = generateToken();
            validTokens.set(token, Date.now() + TOKEN_TTL_MS);
            res.setHeader('Set-Cookie', `dash_token=${token}; Path=/; HttpOnly; Max-Age=${TOKEN_TTL_MS / 1000}`);
            res.json({ ok: true });
        });
        this.app.get('/', (_req, res) => {
            res.setHeader('Content-Type', 'text/html');
            res.send(this._buildHtml());
        });
        this.app.get('/api/trades', async (_req, res) => {
            try {
                const records = await this.tradeLogger.readAll();
                res.json(records);
            }
            catch (err) {
                res.status(500).json({ error: 'Failed to read trades', details: String(err) });
            }
        });
        this.app.get('/api/pnl', (_req, res) => {
            res.json({
                sessionPnl: sharedState_js_1.sharedState.sessionPnl,
                sessionVolume: sharedState_js_1.sharedState.sessionVolume,
                updatedAt: sharedState_js_1.sharedState.updatedAt,
                botStatus: sharedState_js_1.sharedState.botStatus,
                symbol: sharedState_js_1.sharedState.symbol,
                walletAddress: sharedState_js_1.sharedState.walletAddress,
                pnlHistory: sharedState_js_1.sharedState.pnlHistory,
                volumeHistory: sharedState_js_1.sharedState.volumeHistory,
            });
        });
        this.app.get('/api/events', (_req, res) => {
            res.json(sharedState_js_1.sharedState.eventLog);
        });
        // SSE endpoint for realtime log streaming
        this.app.get('/api/events/stream', (req, res) => {
            res.setHeader('Content-Type', 'text/event-stream');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Connection', 'keep-alive');
            res.flushHeaders();
            const send = (data) => res.write(`data: ${data}\n\n`);
            (0, sharedState_js_1.addSseClient)(send);
            // Send last 20 events on connect so client has context
            const recent = sharedState_js_1.sharedState.eventLog.slice(0, 20).reverse();
            recent.forEach(e => send(JSON.stringify(e)));
            req.on('close', () => (0, sharedState_js_1.removeSseClient)(send));
        });
        this.app.get('/api/position', async (_req, res) => {
            res.json(sharedState_js_1.sharedState.openPosition);
        });
        // SSE endpoint for raw console/stdout stream
        this.app.get('/api/console/stream', (req, res) => {
            res.setHeader('Content-Type', 'text/event-stream');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Connection', 'keep-alive');
            res.flushHeaders();
            const send = (data) => res.write(`data: ${data}\n\n`);
            (0, sharedState_js_1.addConsoleSseClient)(send);
            req.on('close', () => (0, sharedState_js_1.removeConsoleSseClient)(send));
        });
        this.app.use('/api/memory', routes_js_1.memoryRouter);
        // ── Bot Control API ───────────────────────────────────────────────────────
        this.app.post('/api/control/start', async (_req, res) => {
            if (!this.sessionManager || !this.watcher || !this.watcherRunner) {
                res.status(503).json({ error: 'Bot controls not available' });
                return;
            }
            if (this.sessionManager.getState().isRunning) {
                res.status(400).json({ error: 'Bot is already running' });
                return;
            }
            const success = this.sessionManager.startSession();
            if (success) {
                this.watcher.resetSession();
                this.watcherRunner();
                res.json({ ok: true });
            }
            else {
                res.status(500).json({ error: 'Failed to start session' });
            }
        });
        this.app.post('/api/control/stop', (_req, res) => {
            if (!this.sessionManager || !this.watcher) {
                res.status(503).json({ error: 'Bot controls not available' });
                return;
            }
            if (!this.sessionManager.getState().isRunning) {
                res.status(400).json({ error: 'Bot is not running' });
                return;
            }
            this.sessionManager.stopSession();
            this.watcher.stop();
            res.json({ ok: true });
        });
        this.app.post('/api/control/set_mode', (req, res) => {
            const { mode } = req.body;
            if (mode !== 'farm' && mode !== 'trade') {
                res.status(400).json({ error: 'Mode must be "farm" or "trade"' });
                return;
            }
            config_js_1.config.MODE = mode;
            res.json({ ok: true, mode });
        });
        this.app.post('/api/control/set_max_loss', (req, res) => {
            if (!this.sessionManager) {
                res.status(503).json({ error: 'Bot controls not available' });
                return;
            }
            const { amount } = req.body;
            if (!amount || isNaN(amount) || amount <= 0) {
                res.status(400).json({ error: 'Invalid amount' });
                return;
            }
            this.sessionManager.setMaxLoss(amount);
            res.json({ ok: true, maxLoss: amount });
        });
        this.app.get('/api/control/status', async (_req, res) => {
            if (!this.sessionManager || !this.watcher) {
                res.json({ isRunning: false, mode: config_js_1.config.MODE, maxLoss: 5, currentPnL: 0, uptime: 0, hasPosition: false });
                return;
            }
            const state = this.sessionManager.getState();
            const uptime = state.startTime ? Math.floor((Date.now() - state.startTime) / 60000) : 0;
            // Only call getDetailedStatus (which hits exchange APIs) when bot is actually running
            let hasPosition = false;
            let positionText = '';
            let cooldown = null;
            if (state.isRunning) {
                const detail = await this.watcher.getDetailedStatus();
                hasPosition = detail.hasPosition;
                positionText = detail.text;
                cooldown = this.watcher.getCooldownInfo();
            }
            res.json({
                isRunning: state.isRunning,
                mode: config_js_1.config.MODE,
                maxLoss: state.maxLoss,
                currentPnL: state.currentPnL,
                uptime,
                hasPosition,
                positionText,
                cooldown,
            });
        });
        this.app.post('/api/control/close_position', async (_req, res) => {
            if (!this.watcher) {
                res.status(503).json({ error: 'Bot controls not available' });
                return;
            }
            if (!this.sessionManager?.getState().isRunning) {
                res.status(400).json({ error: 'Bot is not running' });
                return;
            }
            const success = await this.watcher.forceClosePosition();
            res.json({ ok: success });
        });
    }
    start() {
        this.app.listen(this.port, () => {
            console.log(`[DashboardServer] Listening on http://localhost:${this.port}`);
        });
    }
    _buildLoginHtml() {
        return [
            '<!DOCTYPE html>',
            '<html lang="en"><head>',
            '<meta charset="UTF-8"/>',
            '<meta name="viewport" content="width=device-width, initial-scale=1.0"/>',
            '<title>SoDEX AGENT — Login</title>',
            '<style>',
            '*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}',
            'body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#0a0a0a;color:#e0e0e0;display:flex;align-items:center;justify-content:center;min-height:100vh}',
            '.card{background:#111;border:1px solid #1e1e1e;border-radius:12px;padding:2rem 2.5rem;width:100%;max-width:360px}',
            'h1{font-size:1.1rem;font-weight:600;color:#fff;margin-bottom:0.25rem}',
            '.sub{font-size:0.75rem;color:#555;margin-bottom:1.5rem}',
            'label{font-size:0.72rem;color:#666;text-transform:uppercase;letter-spacing:0.08em;display:block;margin-bottom:0.4rem}',
            'input{width:100%;background:#0a0a0a;border:1px solid #2a2a2a;border-radius:7px;padding:0.65rem 0.85rem;color:#e0e0e0;font-size:0.9rem;outline:none;letter-spacing:0.15em}',
            'input:focus{border-color:#00d464}',
            'button{width:100%;margin-top:1rem;background:#00d464;color:#000;border:none;border-radius:7px;padding:0.7rem;font-size:0.9rem;font-weight:700;cursor:pointer}',
            'button:hover{background:#00b854}',
            '.error{color:#ff4d4d;font-size:0.75rem;margin-top:0.75rem;display:none}',
            '</style></head><body>',
            '<div class="card">',
            '<h1>SoDEX AGENT Dashboard</h1>',
            '<p class="sub">Enter passcode to continue</p>',
            '<label for="pc">Passcode</label>',
            '<input type="password" id="pc" placeholder="••••••••" autofocus/>',
            '<button onclick="login()">Unlock</button>',
            '<p class="error" id="err">Incorrect passcode. Try again.</p>',
            '</div>',
            '<script>',
            'document.getElementById("pc").addEventListener("keydown",e=>{if(e.key==="Enter")login()});',
            'async function login(){',
            '  const passcode=document.getElementById("pc").value;',
            '  const err=document.getElementById("err");',
            '  err.style.display="none";',
            '  try{',
            '    const res=await fetch("/api/login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({passcode})});',
            '    if(res.ok){window.location.href="/"}',
            '    else{err.style.display="block";document.getElementById("pc").value="";document.getElementById("pc").focus()}',
            '  }catch{err.style.display="block"}',
            '}',
            '<\/script>',
            '</body></html>',
        ].join('\n');
    }
    _buildHtml() {
        const css = [
            '*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}',
            'body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#0a0a0a;color:#e0e0e0;min-height:100vh}',
            '.header{padding:1.25rem 1.5rem 0.5rem;border-bottom:1px solid #1e1e1e}',
            '.header-top{display:flex;align-items:center;justify-content:space-between}',
            '.header-title{display:flex;align-items:center;gap:0.5rem}',
            '.header-title h1{font-size:1.25rem;font-weight:600;color:#fff}',
            '.status-badge{display:inline-flex;align-items:center;gap:0.35rem;padding:0.2rem 0.6rem;border-radius:999px;font-size:0.7rem;font-weight:600;letter-spacing:0.05em}',
            '.status-running{background:rgba(0,212,100,0.15);color:#00d464;border:1px solid rgba(0,212,100,0.3)}',
            '.status-stopped{background:rgba(255,77,77,0.15);color:#ff4d4d;border:1px solid rgba(255,77,77,0.3)}',
            '.dot{width:6px;height:6px;border-radius:50%;background:currentColor}',
            '.header-meta{font-size:0.72rem;color:#555;margin-top:0.3rem}',
            '.header-meta span{margin-right:1rem}',
            '.main{padding:1.25rem 1.5rem;display:flex;flex-direction:column;gap:1rem}',
            '.cards-row{display:grid;grid-template-columns:1fr 1fr;gap:1rem}',
            '.card{background:#111;border:1px solid #1e1e1e;border-radius:10px;padding:1rem 1.25rem}',
            '.card-label{font-size:0.68rem;color:#666;text-transform:uppercase;letter-spacing:0.08em;margin-bottom:0.4rem;display:flex;justify-content:space-between}',
            '.card-value{font-size:1.6rem;font-weight:700}',
            '.card-sub{font-size:0.72rem;color:#555;margin-top:0.25rem}',
            '.progress-bar{height:3px;background:#1e1e1e;border-radius:2px;margin-top:0.5rem;overflow:hidden}',
            '.progress-fill{height:100%;border-radius:2px;transition:width 0.4s}',
            '.positive{color:#00d464}.negative{color:#ff4d4d}.neutral{color:#888}',
            '.charts-row{display:grid;grid-template-columns:1fr 1fr;gap:1rem}',
            '.chart-card{background:#111;border:1px solid #1e1e1e;border-radius:10px;padding:1rem 1.25rem}',
            '.chart-card h3{font-size:0.85rem;font-weight:600;color:#ccc;margin-bottom:0.75rem}',
            '.chart-wrap{position:relative;height:180px}',
            '.tables-row{display:grid;grid-template-columns:1fr 1fr;gap:1rem}',
            '.table-card{background:#111;border:1px solid #1e1e1e;border-radius:10px;padding:1rem 1.25rem}',
            '.table-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:0.75rem}',
            '.table-header h3{font-size:0.85rem;font-weight:600;color:#ccc}',
            '.table-count{font-size:0.7rem;color:#555}',
            'table{width:100%;border-collapse:collapse;font-size:0.75rem}',
            'th{color:#555;font-weight:500;text-align:left;padding:0.4rem 0.5rem;border-bottom:1px solid #1a1a1a}',
            'td{padding:0.45rem 0.5rem;border-bottom:1px solid #141414;color:#ccc}',
            'tr:last-child td{border-bottom:none}',
            '.side-badge{display:inline-block;padding:0.15rem 0.45rem;border-radius:4px;font-size:0.68rem;font-weight:700;letter-spacing:0.04em}',
            '.side-buy{background:rgba(0,212,100,0.15);color:#00d464}',
            '.side-sell{background:rgba(255,77,77,0.15);color:#ff4d4d}',
            '.event-badge{display:inline-block;padding:0.15rem 0.45rem;border-radius:4px;font-size:0.65rem;font-weight:600}',
            '.ev-info{background:rgba(100,150,255,0.15);color:#6496ff}',
            '.ev-order_placed{background:rgba(100,150,255,0.15);color:#6496ff}',
            '.ev-order_filled{background:rgba(0,212,100,0.15);color:#00d464}',
            '.ev-error{background:rgba(255,77,77,0.15);color:#ff4d4d}',
            '.ev-warn{background:rgba(255,180,0,0.15);color:#ffb400}',
            '.pagination{display:flex;justify-content:space-between;align-items:center;margin-top:0.75rem;font-size:0.72rem;color:#555}',
            '.pagination button{background:#1a1a1a;border:1px solid #2a2a2a;color:#aaa;padding:0.25rem 0.65rem;border-radius:5px;cursor:pointer;font-size:0.72rem}',
            '.pagination button:hover{background:#222}',
            '.pagination button:disabled{opacity:0.3;cursor:default}',
            '.wallet{font-size:0.72rem;color:#555;background:#161616;border:1px solid #1e1e1e;border-radius:6px;padding:0.5rem 0.75rem;margin-top:0.5rem}',
            '.wallet span{color:#888}',
            '.pos-card{background:#111;border:1px solid #1e1e1e;border-radius:10px;padding:1rem 1.25rem}',
            '.pos-empty{font-size:0.78rem;color:#444;text-align:center;padding:1rem 0}',
            '.pos-side-long{color:#00d464;font-weight:700}',
            '.pos-side-short{color:#ff4d4d;font-weight:700}',
            '.pos-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:0.75rem;margin-top:0.75rem}',
            '.pos-item label{font-size:0.65rem;color:#555;text-transform:uppercase;letter-spacing:0.06em;display:block;margin-bottom:0.2rem}',
            '.pos-item span{font-size:0.9rem;font-weight:600;color:#ccc}',
            '.log-card{background:#111;border:1px solid #1e1e1e;border-radius:10px;padding:1rem 1.25rem}',
            '.log-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:0.75rem}',
            '.log-header h3{font-size:0.85rem;font-weight:600;color:#ccc}',
            '.log-live{display:inline-flex;align-items:center;gap:0.3rem;font-size:0.65rem;color:#00d464;background:rgba(0,212,100,0.1);border:1px solid rgba(0,212,100,0.25);border-radius:999px;padding:0.15rem 0.5rem}',
            '.log-live .dot{width:5px;height:5px;border-radius:50%;background:#00d464;animation:pulse 1.5s infinite}',
            '@keyframes pulse{0%,100%{opacity:1}50%{opacity:0.3}}',
            '.log-tabs{display:flex;gap:0.5rem;margin-bottom:0.75rem}',
            '.log-tab{font-size:0.72rem;padding:0.25rem 0.65rem;border-radius:5px;border:1px solid #2a2a2a;background:#161616;color:#666;cursor:pointer}',
            '.log-tab.active{background:rgba(100,150,255,0.12);border-color:rgba(100,150,255,0.3);color:#6496ff}',
            '.log-body{height:260px;overflow-y:auto;font-size:0.7rem;font-family:monospace}',
            '.log-body::-webkit-scrollbar{width:4px}',
            '.log-body::-webkit-scrollbar-track{background:#0a0a0a}',
            '.log-body::-webkit-scrollbar-thumb{background:#2a2a2a;border-radius:2px}',
            '.log-line{padding:0.18rem 0;border-bottom:1px solid #141414;display:flex;gap:0.5rem;align-items:baseline}',
            '.log-time{color:#444;white-space:nowrap;flex-shrink:0}',
            '.log-type{flex-shrink:0;padding:0.05rem 0.35rem;border-radius:3px;font-size:0.62rem;font-weight:600}',
            '.log-msg{color:#aaa;word-break:break-all}',
            '.con-line{padding:0.15rem 0;border-bottom:1px solid #0f0f0f;color:#7a9e7a;white-space:pre-wrap;word-break:break-all}',
            '.con-line.err{color:#c97070}', '.ctrl-panel{background:#111;border:1px solid #1e1e1e;border-radius:10px;padding:1rem 1.25rem;margin:1rem 1.5rem 0}',
            '.ctrl-title{font-size:0.72rem;color:#555;text-transform:uppercase;letter-spacing:0.08em;margin-bottom:0.85rem}',
            '.ctrl-row{display:flex;flex-wrap:wrap;gap:0.6rem;align-items:center}',
            '.cb{display:inline-flex;align-items:center;gap:0.35rem;padding:0.45rem 0.9rem;border-radius:7px;border:1px solid #2a2a2a;background:#161616;color:#ccc;font-size:0.78rem;font-weight:500;cursor:pointer;transition:background 0.15s,border-color 0.15s}',
            '.cb:hover:not(:disabled){background:#1e1e1e;border-color:#3a3a3a}',
            '.cb:disabled{opacity:0.35;cursor:default}',
            '.cb.g{background:rgba(0,212,100,0.12);border-color:rgba(0,212,100,0.3);color:#00d464}',
            '.cb.g:hover:not(:disabled){background:rgba(0,212,100,0.2)}',
            '.cb.r{background:rgba(255,77,77,0.12);border-color:rgba(255,77,77,0.3);color:#ff4d4d}',
            '.cb.r:hover:not(:disabled){background:rgba(255,77,77,0.2)}',
            '.cb.o{background:rgba(255,180,0,0.12);border-color:rgba(255,180,0,0.3);color:#ffb400}',
            '.cb.o:hover:not(:disabled){background:rgba(255,180,0,0.2)}',
            '.cdiv{width:1px;height:24px;background:#2a2a2a;margin:0 0.2rem}',
            '.ci{background:#0a0a0a;border:1px solid #2a2a2a;border-radius:6px;padding:0.4rem 0.65rem;color:#e0e0e0;font-size:0.78rem;width:80px;outline:none}',
            '.ci:focus{border-color:#444}',
            '.clabel{font-size:0.72rem;color:#555}',
            '.ctoast{font-size:0.72rem;margin-left:0.5rem;opacity:0;transition:opacity 0.3s}',
            '@media(max-width:768px){.cards-row,.charts-row,.tables-row{grid-template-columns:1fr}.ctrl-panel{margin:1rem 1rem 0}}',
        ].join('\n');
        const html = [
            '<!DOCTYPE html>',
            '<html lang="en"><head>',
            '<meta charset="UTF-8"/>',
            '<meta name="viewport" content="width=device-width, initial-scale=1.0"/>',
            '<title>SoDEX AGENT Dashboard</title>',
            '<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"><\/script>',
            '<style>' + css + '</style>',
            '</head><body>',
            // Header
            '<div class="header">',
            '  <div class="header-top">',
            '    <div class="header-title">',
            '      <h1>SoDEX AGENT Dashboard</h1>',
            '      <span id="status-badge" class="status-badge status-stopped"><span class="dot"></span><span id="status-text">STOPPED</span></span>',
            '    </div>',
            '    <div style="font-size:0.72rem;color:#555;" id="updated-at"></div>',
            '  </div>',
            '  <div class="header-meta"><span id="symbol-label">BTC-USD</span><span>·</span><span id="exchange-label"></span></div>',
            '  <div class="wallet">WALLET: <span id="wallet-addr">—</span></div>',
            '</div>',
            // Control Panel
            '<div class="ctrl-panel">',
            '  <div class="ctrl-title">Bot Controls</div>',
            '  <div class="ctrl-row">',
            '    <button class="cb g" id="btn-start" onclick="ctrlStart()">',
            '      <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor"><polygon points="2,1 11,6 2,11"/></svg> Start',
            '    </button>',
            '    <button class="cb r" id="btn-stop" onclick="ctrlStop()" disabled>',
            '      <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor"><rect x="2" y="2" width="8" height="8" rx="1"/></svg> Stop',
            '    </button>',
            '    <div class="cdiv"></div>',
            '    <span class="clabel">Mode:</span>',
            '    <button class="cb" id="btn-farm" onclick="ctrlSetMode(\'farm\')">🚜 Farm</button>',
            '    <button class="cb" id="btn-trade" onclick="ctrlSetMode(\'trade\')">📈 Trade</button>',
            '    <div class="cdiv"></div>',
            '    <span class="clabel">Max Loss $</span>',
            '    <input class="ci" id="input-maxloss" type="number" min="1" step="1" value="5"/>',
            '    <button class="cb" onclick="ctrlSetMaxLoss()">Set</button>',
            '    <div class="cdiv"></div>',
            '    <button class="cb o" onclick="ctrlClosePosition()">',
            '      <svg width="12" height="12" viewBox="0 0 12 12" stroke="currentColor" stroke-width="2" fill="none"><line x1="2" y1="2" x2="10" y2="10"/><line x1="10" y1="2" x2="2" y2="10"/></svg> Close Position',
            '    </button>',
            '    <span class="ctoast" id="ctrl-toast"></span>',
            '  </div>',
            '  <div style="margin-top:0.65rem;font-size:0.72rem;color:#444;" id="ctrl-status-line">—</div>',
            '</div>',
            // Main
            '<div class="main">',
            '  <div class="cards-row">',
            '    <div class="card">',
            '      <div class="card-label">SESSION PnL <span id="pnl-pct"></span></div>',
            '      <div class="card-value" id="pnl-value">+$0.00</div>',
            '      <div class="progress-bar"><div class="progress-fill" id="pnl-bar" style="width:0%;background:#00d464;"></div></div>',
            '      <div class="card-sub" id="pnl-sub">Session running</div>',
            '    </div>',
            '    <div class="card">',
            '      <div class="card-label">TRADING VOLUME</div>',
            '      <div class="card-value" id="vol-value">$0.00</div>',
            '      <div class="progress-bar"><div class="progress-fill" id="vol-bar" style="width:0%;background:#6496ff;"></div></div>',
            '      <div class="card-sub">Cumulative session volume</div>',
            '    </div>',
            '  </div>',
            '  <div class="charts-row">',
            '    <div class="chart-card"><h3>Session PnL</h3><div class="chart-wrap"><canvas id="pnl-chart"></canvas></div></div>',
            '    <div class="chart-card"><h3>Trading Volume</h3><div class="chart-wrap"><canvas id="vol-chart"></canvas></div></div>',
            '  </div>',
            // Open Position + Realtime Log row
            '  <div class="charts-row">',
            '    <div class="pos-card">',
            '      <div class="table-header"><h3>Open Position</h3><span id="pos-badge"></span></div>',
            '      <div id="pos-body"><div class="pos-empty">No open position</div></div>',
            '    </div>',
            '    <div class="log-card">',
            '      <div class="log-header">',
            '        <h3>Realtime Log</h3>',
            '        <span class="log-live"><span class="dot"></span>LIVE</span>',
            '      </div>',
            '      <div class="log-tabs">',
            '        <button class="log-tab" id="tab-events" onclick="switchTab(\'events\')">Events</button>',
            '        <button class="log-tab active" id="tab-console" onclick="switchTab(\'console\')">Console</button>',
            '      </div>',
            '      <div class="log-body" id="log-events" style="display:none"></div>',
            '      <div class="log-body" id="log-console"></div>',
            '    </div>',
            '  </div>',
            '  <div class="tables-row">',
            '    <div class="table-card">',
            '      <div class="table-header"><h3>Trade History</h3><span class="table-count" id="trade-count"></span></div>',
            '      <table><thead><tr><th>Order ID</th><th>Date</th><th>Side</th><th>Price</th><th>PnL</th></tr></thead>',
            '      <tbody id="trades-body"><tr><td colspan="5" style="color:#444;text-align:center;padding:1rem;">No trades yet.</td></tr></tbody></table>',
            '      <div class="pagination">',
            '        <span id="trade-page-info">Page 1</span>',
            '        <div style="display:flex;gap:0.5rem;">',
            '          <button id="trade-prev" onclick="tradePage(-1)" disabled>&#8249; Prev</button>',
            '          <button id="trade-next" onclick="tradePage(1)">Next &#8250;</button>',
            '        </div>',
            '      </div>',
            '    </div>',
            '    <div class="table-card">',
            '      <div class="table-header"><h3>Event Log</h3><span class="table-count" id="event-count"></span></div>',
            '      <table><thead><tr><th>Time</th><th>Type</th><th>Message</th></tr></thead>',
            '      <tbody id="events-body"><tr><td colspan="3" style="color:#444;text-align:center;padding:1rem;">No events yet.</td></tr></tbody></table>',
            '      <div class="pagination">',
            '        <span id="event-page-info">Page 1</span>',
            '        <div style="display:flex;gap:0.5rem;">',
            '          <button id="event-prev" onclick="eventPage(-1)" disabled>&#8249; Prev</button>',
            '          <button id="event-next" onclick="eventPage(1)">Next &#8250;</button>',
            '        </div>',
            '      </div>',
            '    </div>',
            '  </div>',
            '</div>',
        ].join('\n');
        const script = `
<script>
const PAGE_SIZE = 10;
let allTrades = [], allEvents = [];
let tradePg = 1, eventPg = 1;
let pnlChart, volChart;

function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function fmtTime(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString('en-US',{month:'short',day:'numeric'}) + ', ' + d.toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit',hour12:false});
}
function fmtShortTime(iso) {
  return new Date(iso).toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false});
}

function initCharts() {
  const opts = (label, color) => ({
    type: 'line',
    data: { labels: [], datasets: [{ label, data: [], borderColor: color, backgroundColor: color + '18', borderWidth: 1.5, pointRadius: 0, fill: true, tension: 0.3 }] },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { color: '#444', font: { size: 10 }, maxTicksLimit: 6 }, grid: { color: '#1a1a1a' } },
        y: { ticks: { color: '#444', font: { size: 10 } }, grid: { color: '#1a1a1a' } }
      }
    }
  });
  pnlChart = new Chart(document.getElementById('pnl-chart'), opts('PnL', '#00d464'));
  volChart = new Chart(document.getElementById('vol-chart'), opts('Volume', '#6496ff'));
}

function updateCharts(ph, vh) {
  const upd = (chart, h) => { chart.data.labels = h.map(p => fmtShortTime(p.time)); chart.data.datasets[0].data = h.map(p => p.value); chart.update('none'); };
  if (ph.length) upd(pnlChart, ph);
  if (vh.length) upd(volChart, vh);
}

function renderTrades() {
  const tbody = document.getElementById('trades-body');
  const total = allTrades.length;
  document.getElementById('trade-count').textContent = total ? 'Showing ' + Math.min((tradePg-1)*PAGE_SIZE+1,total) + '-' + Math.min(tradePg*PAGE_SIZE,total) + ' of ' + total : '';
  document.getElementById('trade-page-info').textContent = 'Page ' + tradePg + ' of ' + Math.max(1, Math.ceil(total/PAGE_SIZE));
  document.getElementById('trade-prev').disabled = tradePg <= 1;
  document.getElementById('trade-next').disabled = tradePg >= Math.ceil(total/PAGE_SIZE);
  if (!total) { tbody.innerHTML = '<tr><td colspan="5" style="color:#444;text-align:center;padding:1rem;">No trades yet.</td></tr>'; return; }
  const slice = allTrades.slice((tradePg-1)*PAGE_SIZE, tradePg*PAGE_SIZE);
  tbody.innerHTML = slice.map(t => {
    const side = t.direction === 'long' ? '<span class="side-badge side-buy">BUY</span>' : '<span class="side-badge side-sell">SELL</span>';
    const pnlCls = t.pnl >= 0 ? 'positive' : 'negative';
    const shortId = t.id ? t.id.slice(0,8) + '...' + t.id.slice(-4) : '—';
    const price = t.exitPrice ? '$' + Number(t.exitPrice).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}) : '—';
    const pnlVal = (t.pnl >= 0 ? '+' : '') + '$' + Number(t.pnl).toFixed(4);
    return '<tr>' +
      '<td style="font-family:monospace;font-size:0.7rem;">' + esc(shortId) + '</td>' +
      '<td>' + fmtTime(t.timestamp) + '</td>' +
      '<td>' + side + '</td>' +
      '<td>' + price + '</td>' +
      '<td class="' + pnlCls + '">' + pnlVal + '</td>' +
      '</tr>';
  }).join('');
}

function renderEvents() {
  const tbody = document.getElementById('events-body');
  const total = allEvents.length;
  document.getElementById('event-count').textContent = total ? 'Showing ' + Math.min((eventPg-1)*PAGE_SIZE+1,total) + '-' + Math.min(eventPg*PAGE_SIZE,total) + ' of ' + total : '';
  document.getElementById('event-page-info').textContent = 'Page ' + eventPg + ' of ' + Math.max(1, Math.ceil(total/PAGE_SIZE));
  document.getElementById('event-prev').disabled = eventPg <= 1;
  document.getElementById('event-next').disabled = eventPg >= Math.ceil(total/PAGE_SIZE);
  if (!total) { tbody.innerHTML = '<tr><td colspan="3" style="color:#444;text-align:center;padding:1rem;">No events yet.</td></tr>'; return; }
  const slice = allEvents.slice((eventPg-1)*PAGE_SIZE, eventPg*PAGE_SIZE);
  tbody.innerHTML = slice.map(e => {
    const cls = 'ev-' + e.type.toLowerCase().replace(/_/g,'-');
    return '<tr>' +
      '<td style="white-space:nowrap;color:#666;">' + fmtShortTime(e.time) + '</td>' +
      '<td><span class="event-badge ' + cls + '">' + esc(e.type.replace(/_/g,' ')) + '</span></td>' +
      '<td style="color:#aaa;">' + esc(e.message) + '</td>' +
      '</tr>';
  }).join('');
}

function tradePage(d) { tradePg += d; renderTrades(); }
function eventPage(d) { eventPg += d; renderEvents(); }

async function refresh() {
  try {
    const [pnlData, trades, events] = await Promise.all([
      fetch('/api/pnl').then(r => r.json()),
      fetch('/api/trades').then(r => r.json()),
      fetch('/api/events').then(r => r.json()),
    ]);
    const badge = document.getElementById('status-badge');
    const statusText = document.getElementById('status-text');
    badge.className = 'status-badge ' + (pnlData.botStatus === 'RUNNING' ? 'status-running' : 'status-stopped');
    statusText.textContent = pnlData.botStatus || 'STOPPED';
    document.getElementById('updated-at').textContent = 'Updated: ' + fmtShortTime(pnlData.updatedAt);
    document.getElementById('symbol-label').textContent = pnlData.symbol || 'BTC-USD';
    const wa = pnlData.walletAddress || '';
    document.getElementById('wallet-addr').textContent = wa ? '****' + wa.slice(-6) : '—';
    const pnl = pnlData.sessionPnl || 0;
    const pnlEl = document.getElementById('pnl-value');
    pnlEl.textContent = (pnl >= 0 ? '+' : '') + '$' + Math.abs(pnl).toFixed(4);
    pnlEl.className = 'card-value ' + (pnl >= 0 ? 'positive' : 'negative');
    document.getElementById('pnl-bar').style.width = Math.min(Math.abs(pnl)/10*100,100) + '%';
    document.getElementById('pnl-bar').style.background = pnl >= 0 ? '#00d464' : '#ff4d4d';
    const vol = pnlData.sessionVolume || 0;
    document.getElementById('vol-value').textContent = '$' + vol.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
    document.getElementById('vol-bar').style.width = Math.min(vol/10000*100,100) + '%';
    updateCharts(pnlData.pnlHistory || [], pnlData.volumeHistory || []);
    allTrades = Array.isArray(trades) ? trades : [];
    allEvents = Array.isArray(events) ? events : [];
    renderTrades();
    renderEvents();
  } catch(e) { console.error('Refresh error:', e); }
}

// ── Open Position ─────────────────────────────────────────────────────────
async function refreshPosition() {
  try {
    const pos = await fetch('/api/position').then(r => r.json());
    const body = document.getElementById('pos-body');
    const badge = document.getElementById('pos-badge');
    if (!pos) {
      body.innerHTML = '<div class="pos-empty">No open position</div>';
      badge.textContent = '';
      return;
    }
    const sideClass = pos.side === 'long' ? 'pos-side-long' : 'pos-side-short';
    const pnlCls = pos.unrealizedPnl >= 0 ? 'positive' : 'negative';
    const pnlStr = (pos.unrealizedPnl >= 0 ? '+' : '') + '$' + pos.unrealizedPnl.toFixed(4);
    badge.innerHTML = '<span class="' + sideClass + '">' + pos.side.toUpperCase() + '</span>';
    body.innerHTML =
      '<div class="pos-grid">' +
      '<div class="pos-item"><label>Entry Price</label><span>$' + pos.entryPrice.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}) + '</span></div>' +
      '<div class="pos-item"><label>Mark Price</label><span>$' + pos.markPrice.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}) + '</span></div>' +
      '<div class="pos-item"><label>Unrealized PnL</label><span class="' + pnlCls + '">' + pnlStr + '</span></div>' +
      '<div class="pos-item"><label>Size</label><span>' + pos.size + '</span></div>' +
      '<div class="pos-item"><label>Symbol</label><span>' + pos.symbol + '</span></div>' +
      '<div class="pos-item"><label>Duration</label><span>' + pos.durationSecs + 's</span></div>' +
      '</div>';
  } catch {}
}

// ── Realtime Log (SSE) ────────────────────────────────────────────────────
const LOG_TYPE_COLORS = {
  INFO: 'background:rgba(100,150,255,0.15);color:#6496ff',
  ORDER_PLACED: 'background:rgba(100,150,255,0.15);color:#6496ff',
  ORDER_FILLED: 'background:rgba(0,212,100,0.15);color:#00d464',
  ERROR: 'background:rgba(255,77,77,0.15);color:#ff4d4d',
  WARN: 'background:rgba(255,180,0,0.15);color:#ffb400',
};

let activeTab = 'console';

function switchTab(tab) {
  activeTab = tab;
  document.getElementById('log-events').style.display = tab === 'events' ? '' : 'none';
  document.getElementById('log-console').style.display = tab === 'console' ? '' : 'none';
  document.getElementById('tab-events').className = 'log-tab' + (tab === 'events' ? ' active' : '');
  document.getElementById('tab-console').className = 'log-tab' + (tab === 'console' ? ' active' : '');
}

function appendEventLog(entry) {
  const body = document.getElementById('log-events');
  const line = document.createElement('div');
  line.className = 'log-line';
  const style = LOG_TYPE_COLORS[entry.type] || LOG_TYPE_COLORS.INFO;
  line.innerHTML =
    '<span class="log-time">' + fmtShortTime(entry.time) + '</span>' +
    '<span class="log-type" style="' + style + '">' + entry.type.replace(/_/g,' ') + '</span>' +
    '<span class="log-msg">' + esc(entry.message) + '</span>';
  body.appendChild(line);
  body.scrollTop = body.scrollHeight;
  while (body.children.length > 300) body.removeChild(body.firstChild);
}

function appendConsoleLine(entry) {
  const body = document.getElementById('log-console');
  const line = document.createElement('div');
  const isErr = entry.line && (entry.line.includes('ERROR') || entry.line.includes('error') || entry.line.includes('❌'));
  line.className = 'con-line' + (isErr ? ' err' : '');
  line.textContent = fmtShortTime(entry.time) + '  ' + entry.line;
  body.appendChild(line);
  body.scrollTop = body.scrollHeight;
  while (body.children.length > 500) body.removeChild(body.firstChild);
}

function initSSE() {
  const evtEs = new EventSource('/api/events/stream');
  evtEs.onmessage = e => { try { appendEventLog(JSON.parse(e.data)); } catch {} };

  const conEs = new EventSource('/api/console/stream');
  conEs.onmessage = e => { try { appendConsoleLine(JSON.parse(e.data)); } catch {} };
}

initSSE();
refreshPosition();
setInterval(refreshPosition, 3000);


let ctrlRunning = false;

function showToast(msg, isErr) {
  const t = document.getElementById('ctrl-toast');
  t.textContent = msg;
  t.style.color = isErr ? '#ff4d4d' : '#00d464';
  t.style.opacity = '1';
  setTimeout(() => { t.style.opacity = '0'; }, 2500);
}

function updateCtrlButtons(isRunning, mode) {
  ctrlRunning = isRunning;
  document.getElementById('btn-start').disabled = isRunning;
  document.getElementById('btn-stop').disabled = !isRunning;
  document.getElementById('btn-farm').className = 'cb' + (mode === 'farm' ? ' g' : '');
  document.getElementById('btn-trade').className = 'cb' + (mode === 'trade' ? ' g' : '');
}

async function ctrlStart() {
  try {
    const r = await fetch('/api/control/start', { method: 'POST' });
    const d = await r.json();
    if (r.ok) { showToast('Bot started', false); refreshCtrlStatus(); }
    else showToast(d.error || 'Error', true);
  } catch { showToast('Request failed', true); }
}

async function ctrlStop() {
  try {
    const r = await fetch('/api/control/stop', { method: 'POST' });
    const d = await r.json();
    if (r.ok) { showToast('Bot stopped', false); refreshCtrlStatus(); }
    else showToast(d.error || 'Error', true);
  } catch { showToast('Request failed', true); }
}

async function ctrlSetMode(mode) {
  try {
    const r = await fetch('/api/control/set_mode', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ mode }) });
    const d = await r.json();
    if (r.ok) { showToast('Mode: ' + mode, false); updateCtrlButtons(ctrlRunning, mode); }
    else showToast(d.error || 'Error', true);
  } catch { showToast('Request failed', true); }
}

async function ctrlSetMaxLoss() {
  const amount = parseFloat(document.getElementById('input-maxloss').value);
  if (!amount || amount <= 0) { showToast('Invalid amount', true); return; }
  try {
    const r = await fetch('/api/control/set_max_loss', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ amount }) });
    const d = await r.json();
    if (r.ok) showToast('Max loss: $' + amount, false);
    else showToast(d.error || 'Error', true);
  } catch { showToast('Request failed', true); }
}

async function ctrlClosePosition() {
  if (!confirm('Force close current position?')) return;
  try {
    const r = await fetch('/api/control/close_position', { method: 'POST' });
    const d = await r.json();
    if (r.ok && d.ok) showToast('Position closed', false);
    else showToast('Close failed', true);
  } catch { showToast('Request failed', true); }
}

async function refreshCtrlStatus() {
  try {
    const d = await fetch('/api/control/status').then(r => r.json());
    updateCtrlButtons(d.isRunning, d.mode);
    document.getElementById('input-maxloss').value = d.maxLoss;
    const uptime = d.uptime ? d.uptime + 'm uptime' : '';
    const pnl = d.currentPnL !== undefined ? ' · PnL: ' + (d.currentPnL >= 0 ? '+' : '') + '$' + d.currentPnL.toFixed(4) : '';
    const cooldown = d.cooldown ? ' · Cooldown: ' + d.cooldown + 's' : '';
    const pos = d.hasPosition ? ' · Position OPEN' : '';
    document.getElementById('ctrl-status-line').textContent =
      (d.isRunning ? '🟢 Running' : '⚫ Stopped') + (uptime ? ' · ' + uptime : '') + pnl + cooldown + pos;
  } catch {}
}

initCharts();
refresh();
refreshCtrlStatus();
setInterval(refresh, 5000);
setInterval(refreshCtrlStatus, 5000);
<\/script>
</body></html>`;
        return html + script;
    }
}
exports.DashboardServer = DashboardServer;
