// dashboard.js — extracted from server.ts _buildHtml()

// Bot context — injected by server for bot detail pages (null = single-bot mode)
// Only set to null if not already injected by the server via layout.ejs
if (typeof window.BOT_CONTEXT === 'undefined') {
  window.BOT_CONTEXT = null;
}

// API routing — resolves correct endpoint based on BOT_CONTEXT
function api(path) {
  const ctx = window.BOT_CONTEXT;
  if (!ctx) return path;
  const map = {
    '/api/pnl': '/api/bots/'+ctx.botId+'/pnl',
    '/api/trades': '/api/bots/'+ctx.botId+'/trades',
    '/api/events': '/api/bots/'+ctx.botId+'/events',
    '/api/events/stream': '/api/bots/'+ctx.botId+'/events/stream',
    '/api/position': '/api/bots/'+ctx.botId+'/position',
    '/api/analytics/summary': '/api/bots/'+ctx.botId+'/analytics',
    '/api/config': '/api/bots/'+ctx.botId+'/config',
    '/api/control/status': '/api/bots/'+ctx.botId+'/control/status',
    '/api/control/start': '/api/bots/'+ctx.botId+'/control/start',
    '/api/control/stop': '/api/bots/'+ctx.botId+'/control/stop',
    '/api/control/close_position': '/api/bots/'+ctx.botId+'/control/close_position',
    '/api/control/set_mode': '/api/bots/'+ctx.botId+'/control/set_mode',
    '/api/control/set_max_loss': '/api/bots/'+ctx.botId+'/control/set_max_loss',
  };
  return map[path] || path;
}

const PAGE_SIZE = 10;
let allTrades = [], allEvents = [], tradePg = 1, eventPg = 1;
let pnlChart, volChart;

function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function fmt(iso) { const d=new Date(iso); return d.toLocaleDateString('en-US',{month:'short',day:'numeric'})+', '+d.toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit',hour12:false}); }
function fmtS(iso) { return new Date(iso).toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}); }

function initCharts() {
  // Replace skeleton placeholders with real canvases
  const pnlWrap = document.getElementById('pnl-chart-wrap');
  const volWrap = document.getElementById('vol-chart-wrap');
  if (pnlWrap) pnlWrap.innerHTML = '<canvas id="pnl-chart"></canvas>';
  if (volWrap) volWrap.innerHTML = '<canvas id="vol-chart"></canvas>';

  const opts = (label, color, fillColor) => ({
    type: 'line',
    data: { labels: [], datasets: [{ label, data: [], borderColor: color, backgroundColor: fillColor, borderWidth: 2, pointRadius: 0, fill: true, tension: 0.4 }] },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      plugins: { legend:{display:false}, tooltip:{ mode:'index', intersect:false, backgroundColor:'#fff', titleColor:'#0d1117', bodyColor:'#4b5563', borderColor:'#e8eaed', borderWidth:1, padding:10 } },
      scales: {
        x: { ticks:{color:'#9ca3af',font:{size:10},maxTicksLimit:6}, grid:{color:'#f4f6f9'}, border:{color:'#e8eaed'} },
        y: { ticks:{color:'#9ca3af',font:{size:10}}, grid:{color:'#f4f6f9'}, border:{color:'#e8eaed'} }
      }
    }
  });
  pnlChart = new Chart(document.getElementById('pnl-chart'), opts('PnL','#15803d','rgba(21,128,61,0.07)'));
  volChart = new Chart(document.getElementById('vol-chart'), opts('Volume','#4361ee','rgba(67,97,238,0.07)'));
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
  if (!total) { tbody.innerHTML='<tr><td colspan="5" style="text-align:center;padding:1.5rem;color:var(--text-3);">No trades yet.</td></tr>'; return; }
  tbody.innerHTML = allTrades.slice((tradePg-1)*PAGE_SIZE,tradePg*PAGE_SIZE).map(t => {
    const side = t.direction==='long'?'<span class="td-buy">BUY</span>':'<span class="td-sell">SELL</span>';
    const pc = t.pnl>=0?'td-pos':'td-neg';
    const id = t.id?t.id.slice(0,8)+'...'+t.id.slice(-4):'—';
    const price = t.exitPrice?'$'+Number(t.exitPrice).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}):'—';
    const pnlv = (t.pnl>=0?'+':'')+'$'+Number(t.pnl).toFixed(4);
    return '<tr><td style="font-family:monospace;font-size:.7rem;">'+esc(id)+'</td><td>'+fmt(t.timestamp)+'</td><td>'+side+'</td><td>'+price+'</td><td class="'+pc+'">'+pnlv+'</td></tr>';
  }).join('');
}

function renderEvents() {
  const tbody = document.getElementById('events-body'), total = allEvents.length;
  document.getElementById('event-count').textContent = total ? 'Showing '+Math.min((eventPg-1)*PAGE_SIZE+1,total)+'-'+Math.min(eventPg*PAGE_SIZE,total)+' of '+total : '';
  document.getElementById('event-page-info').textContent = 'Page '+eventPg+' of '+Math.max(1,Math.ceil(total/PAGE_SIZE));
  document.getElementById('event-prev').disabled = eventPg<=1;
  document.getElementById('event-next').disabled = eventPg>=Math.ceil(total/PAGE_SIZE);
  if (!total) { tbody.innerHTML='<tr><td colspan="3" style="text-align:center;padding:1.5rem;color:var(--text-3);">No events yet.</td></tr>'; return; }
  tbody.innerHTML = allEvents.slice((eventPg-1)*PAGE_SIZE,eventPg*PAGE_SIZE).map(e => {
    return '<tr><td style="white-space:nowrap;font-size:.72rem;color:var(--text-3);">'+fmtS(e.time)+'</td><td style="font-size:.72rem;font-weight:600;color:var(--text-2);">'+esc(e.type.replace(/_/g,' '))+'</td><td style="font-size:.75rem;color:var(--text-2);">'+esc(e.message)+'</td></tr>';
  }).join('');
}

function tradePage(d) { tradePg+=d; renderTrades(); }
function eventPage(d) { eventPg+=d; renderEvents(); }

// ── Mode-aware KPI layout ─────────────────────────────────────────────────
// farm mode: Volume is primary hero, PnL is secondary
// trade mode: PnL is primary hero, Volume is secondary
let _lastKpiMode = null;
let _lastKpiPnl = null;
let _lastKpiVol = null;

function updateKpiLayout(mode, pnl, vol) {
  _lastKpiMode = mode;
  _lastKpiPnl = pnl;
  _lastKpiVol = vol;

  const isFarm = mode === 'farm';
  const setEl = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };

  const pnlSign = pnl >= 0 ? '+' : '';
  const pnlClass = pnl > 0 ? 'pos' : pnl < 0 ? 'neg' : 'neu';
  const volFmt = '$' + vol.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const pnlFmt = pnlSign + '$' + Math.abs(pnl).toFixed(4);

  const primaryValEl = document.getElementById('kpi-primary-val');
  const pnlEl = document.getElementById('pnl-value');

  if (isFarm) {
    // Primary = Volume
    setEl('kpi-primary-lbl', '🚜 Volume');
    if (primaryValEl) { primaryValEl.textContent = volFmt; primaryValEl.className = 'kpi-val'; }
    setEl('kpi-primary-sub', 'Session farming');
    // Secondary = PnL
    setEl('kpi-secondary-lbl', 'PnL');
    if (pnlEl) {
      const prev = pnlEl.textContent;
      if (prev !== pnlFmt) {
        pnlEl.textContent = pnlFmt;
        pnlEl.className = 'pnl-hero-value ' + pnlClass + ' pnl-flash';
        setTimeout(() => { if (pnlEl) pnlEl.className = 'pnl-hero-value ' + pnlClass; }, 400);
      }
    }
  } else {
    // Primary = PnL
    setEl('kpi-primary-lbl', '📈 PnL');
    if (primaryValEl) {
      const prev = primaryValEl.textContent;
      if (prev !== pnlFmt) {
        primaryValEl.textContent = pnlFmt;
        primaryValEl.className = 'kpi-val ' + pnlClass + ' pnl-flash';
        setTimeout(() => { if (primaryValEl) primaryValEl.className = 'kpi-val ' + pnlClass; }, 400);
      }
    }
    setEl('kpi-primary-sub', pnl !== 0 ? (pnl > 0 ? '▲ Profitable' : '▼ In loss') : 'Waiting for trades');
    // Secondary = Volume
    setEl('kpi-secondary-lbl', 'Volume');
    if (pnlEl) { pnlEl.textContent = volFmt; pnlEl.className = 'pnl-hero-value'; }
  }

  // pnl-sub always reflects PnL state
  setEl('pnl-sub', pnl !== 0 ? (pnl > 0 ? '▲ Profitable session' : '▼ Session in loss') : 'Waiting for trades');
}

async function refresh() {
  try {
    const [pnlData, trades, events] = await Promise.all([
      fetch(api('/api/pnl')).then(r=>r.json()),
      fetch(api('/api/trades')).then(r=>r.json()),
      fetch(api('/api/events')).then(r=>r.json()),
    ]);

    // Status badge
    const badge = document.getElementById('status-badge');
    if (badge) badge.className = 'hero-st '+(pnlData.botStatus==='RUNNING'?'running':'stopped');
    const statusTextEl = document.getElementById('status-text');
    if (statusTextEl) statusTextEl.textContent = pnlData.botStatus||'STOPPED';
    const updatedAtEl = document.getElementById('updated-at');
    if (updatedAtEl) updatedAtEl.textContent = fmtS(pnlData.updatedAt);

    // Live dot
    const liveDot = document.getElementById('live-dot');
    if (liveDot) liveDot.className = 'live-dot'+(pnlData.botStatus==='RUNNING'?' active':'');

    // Symbol + wallet
    const setEl = (id, val) => { const el=document.getElementById(id); if(el) el.textContent=val; };
    setEl('symbol-label', pnlData.symbol||'BTC-USD');
    const wa = pnlData.walletAddress||'';
    setEl('wallet-addr', wa?wa.slice(0,6)+'…'+wa.slice(-4):'—');

    // PnL HERO — with flash animation on change
    const pnl = pnlData.sessionPnl||0;
    const pnlSign = pnl>=0?'+':'';
    const pnlClass = pnl>0?'pos':pnl<0?'neg':'neu';
    const pnlEl = document.getElementById('pnl-value');
    if (pnlEl) {
      const prev = pnlEl.textContent;
      const next = pnlSign+'$'+Math.abs(pnl).toFixed(4);
      if (prev !== next) {
        pnlEl.textContent = next;
        pnlEl.className = 'pnl-hero-value '+pnlClass+' pnl-flash';
        setTimeout(() => { if(pnlEl) pnlEl.className='pnl-hero-value '+pnlClass; }, 400);
      }
    }
    setEl('pnl-sub', pnl!==0 ? (pnl>0?'▲ Profitable session':'▼ Session in loss') : 'Waiting for trades');

    // Volume
    const vol = pnlData.sessionVolume||0;
    setEl('vol-value', '$'+vol.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}));

    // Mode-aware primary KPI: use last known mode from ctrl status, fallback to farm
    const currentMode = _lastKpiMode || 'farm';
    updateKpiLayout(currentMode, pnl, vol);

    // Fees + efficiency
    const fees = pnlData.sessionFees||0;
    setEl('side-fees', '$'+fees.toFixed(2));
    const eff = vol>0 ? (pnl/vol)*10000 : 0;
    setEl('side-eff', eff.toFixed(1)+' bps');

    // Recent activity from trades — always update Last Trade header
    if (Array.isArray(trades) && trades.length) {
      const recent = trades.slice(-5).reverse();
      const actEl = document.getElementById('recent-activity');
      if (actEl && actEl.style.display !== 'none') {
        actEl.innerHTML = recent.map(t => {
          const isBuy = t.direction==='long';
          const pnlv = t.pnl!=null?(t.pnl>=0?'+':'')+'$'+Number(t.pnl).toFixed(4):'';
          const dotCls = isBuy?'buy':'sell';
          return '<div class="activity-item">'+
            '<div class="activity-dot '+dotCls+'"></div>'+
            '<div class="activity-content">'+
              '<div class="activity-msg">'+(isBuy?'BUY':'SELL')+' · '+esc(t.symbol||'')+(pnlv?' · <span style="color:'+(t.pnl>=0?'var(--green)':'var(--red)')+'">'+pnlv+'</span>':'')+'</div>'+
              '<div class="activity-time">'+fmt(t.timestamp)+'</div>'+
            '</div>'+
          '</div>';
        }).join('');
        // Update last action in header
        const last = recent[0];
        if (last) {
          setEl('hdr-last-action', last.direction==='long'?'BUY':'SELL');
          setEl('hdr-last-time', fmt(last.timestamp));
        }
      }
      // Always update Last Trade KPI regardless of actEl visibility
      const last = recent[0];
      if (last) {
        setEl('hdr-last-action', last.direction==='long'?'▲ BUY':'▼ SELL');
        setEl('hdr-last-time', fmt(last.timestamp));
      }
    }

    updateCharts(pnlData.pnlHistory||[], pnlData.volumeHistory||[]);
    allTrades = Array.isArray(trades)?trades:[];
    allEvents = Array.isArray(events)?events:[];
    renderTrades(); renderEvents();
  } catch(e) { console.error('Refresh error:',e); }
}

// ── Open Position ─────────────────────────────────────────────────────────
async function refreshPosition() {
  try {
    const pos = await fetch(api('/api/position')).then(r=>r.json());
    const body = document.getElementById('pos-body');
    const badge = document.getElementById('pos-badge');
    if (!pos) {
      body.innerHTML = '<div class="pos-empty-st"><div class="pos-empty-icon">◎</div><div class="pos-empty-txt">No open position</div></div>';
      if (badge) badge.innerHTML = '';
      return;
    }
    const isLong = pos.side === 'long';
    const pc = (pos.unrealizedPnl || 0) >= 0 ? 'pos' : 'neg';
    const holdSecs = pos.holdRemainingMs != null ? Math.ceil(pos.holdRemainingMs / 1000) : null;
    const pnl = pos.unrealizedPnl || 0;
    const pnlStr = (pnl >= 0 ? '+' : '') + '$' + Math.abs(pnl).toFixed(4);
    const entryFmt = (pos.entryPrice || 0).toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2});
    const markFmt = (pos.markPrice || 0).toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2});
    if (badge) badge.innerHTML = '<span class="pos-side ' + (isLong ? 'long' : 'short') + '">' + (pos.side || '').toUpperCase() + '</span>';
    body.innerHTML =
      '<div class="pos-row"><span class="pos-key">Entry Price</span><span class="pos-val">$' + entryFmt + '</span></div>' +
      '<div class="pos-row"><span class="pos-key">Mark Price</span><span class="pos-val">$' + markFmt + '</span></div>' +
      '<div class="pos-row"><span class="pos-key">Unrealized PnL</span><span class="pos-val ' + pc + '">' + pnlStr + '</span></div>' +
      '<div class="pos-row"><span class="pos-key">Size</span><span class="pos-val">' + (pos.size || '—') + '</span></div>' +
      '<div class="pos-row"><span class="pos-key">Duration</span><span class="pos-val">' + (pos.durationSecs || 0) + 's</span></div>' +
      (holdSecs != null && holdSecs > 0 ? '<div class="pos-row"><span class="pos-key">Hold remaining</span><span class="pos-val" style="color:var(--orange);">' + holdSecs + 's</span></div>' : '') +
      '<div style="margin-top:.75rem"><button class="btn btn-emg" style="width:100%" onclick="ctrlClosePosition()">✕ Close Position</button></div>';
    const hdrPos = document.getElementById('hdr-position');
    if (hdrPos) hdrPos.textContent = (isLong ? '▲ LONG' : '▼ SHORT') + ' ' + (pos.size || '');
  } catch(e) { console.error('refreshPosition error:', e); }
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
  const evtEs = new EventSource(api('/api/events/stream'));
  evtEs.onmessage = e => { try { appendEventLog(JSON.parse(e.data)); } catch {} };
  const conEs = new EventSource('/api/console/stream');
  conEs.onmessage = e => { try { appendConsoleLine(JSON.parse(e.data)); } catch {} };
}

// ── SoPoints Tier Card ────────────────────────────────────────────────────
const TIER_CLASS = { BRONZE:'tier-bronze', SILVER:'tier-silver', GOLD:'tier-gold', DIAMOND:'tier-diamond' };

async function refreshTier() {
  const exchange = (window.BOT_CONTEXT?.exchange || 'sodex').toLowerCase();
  if (exchange === 'decibel') {
    await refreshDecibelPoints();
  } else {
    await refreshSoPoints();
  }
}

async function refreshSoPoints() {
  try {
    const d = await fetch('/api/sopoints').then(r=>r.json());
    if (d.error) { document.getElementById('tier-card-wrap').innerHTML='<div class="sopoints-card sopoints-unavail">'+esc(d.error)+'</div>'; return; }
    const tier = (d.currentTier||'GOLD').toUpperCase();
    const cls = 'sopoints-' + tier.toLowerCase();
    const pct = d.nextTierPoints ? Math.min(d.totalPoints / d.nextTierPoints * 100, 100) : 100;
    const staleTag = d.stale ? '<span class="sopoints-stale">⚠ Expired</span>' : '';
    document.getElementById('tier-card-wrap').innerHTML =
      '<div class="sopoints-card ' + cls + '">' +
        '<div class="sopoints-top">' +
          '<div class="sopoints-tier">' + esc(tier) + staleTag + '</div>' +
        '</div>' +
        '<div class="sopoints-hero">' +
          '<span class="sopoints-num">' + Number(d.totalPoints).toLocaleString() + '</span>' +
          '<span class="sopoints-badge">SOPOINTS</span>' +
        '</div>' +
        (d.nextTier ?
          '<div class="sopoints-next-row">' +
            '<span class="sopoints-next-lbl">NEXT: ' + esc(d.nextTier) + '</span>' +
            '<span class="sopoints-next-val">' + Number(d.nextTierPoints).toLocaleString() + '</span>' +
          '</div>' +
          '<div class="sopoints-bar-bg"><div class="sopoints-bar-fill" style="width:' + pct.toFixed(1) + '%"></div></div>'
        : '') +
        '<div class="sopoints-rank">★ Rank ' + Number(d.rank).toLocaleString() + ' of ' + Number(d.totalUser).toLocaleString() + ' users</div>' +
      '</div>';
  } catch { document.getElementById('tier-card-wrap').innerHTML='<div class="sopoints-card sopoints-unavail">SoPoints unavailable</div>'; }
}

async function refreshDecibelPoints() {
  try {
    const d = await fetch('/api/decibel-points').then(r=>r.json());
    if (d.error) {
      document.getElementById('tier-card-wrap').innerHTML='<div class="decibel-card decibel-unavail">'+esc(d.error)+'</div>';
      return;
    }
    // Actual API fields: total_amps, rank, current_tier, tiers[]
    const amps = d.total_amps ?? d.points ?? 0;
    const rank = d.rank ?? '—';
    const tier = d.current_tier ?? d.tier ?? '';
    const tierDisplay = tier.replace(/([A-Z])/g, ' $1').replace(/^./, s => s.toUpperCase()).trim() || 'Unknown';

    // Progress toward next tier
    const tiers = Array.isArray(d.tiers) ? d.tiers : [];
    const nextTier = tiers.find(t => (t.progress ?? 100) < 100);
    const progressPct = nextTier ? Math.min(nextTier.progress ?? 0, 100) : 100;
    const nextTierName = nextTier ? nextTier.name.replace(/([A-Z])/g, ' $1').replace(/^./, s => s.toUpperCase()).trim() : null;

    // Format amps: 3135 → 3.14K
    const fmtAmps = amps >= 1000 ? (amps/1000).toFixed(2)+'K' : Number(amps).toFixed(0);

    // Tier → CSS class
    const tierLower = tier.toLowerCase();
    let tierCls = 'decibel-tier-default';
    if (tierLower.includes('diamond')) tierCls = 'decibel-tier-diamond';
    else if (tierLower.includes('platinum')) tierCls = 'decibel-tier-platinum';
    else if (tierLower.includes('gold')) tierCls = 'decibel-tier-gold';
    else if (tierLower.includes('silver')) tierCls = 'decibel-tier-silver';

    document.getElementById('tier-card-wrap').innerHTML =
      '<div class="decibel-card ' + tierCls + '">' +
        '<div class="decibel-header">' +
          '<span class="decibel-label">Decibel Points</span>' +
          '<span class="decibel-logo">🎵 Decibel</span>' +
        '</div>' +
        '<div class="decibel-pts-lbl">AMPS</div>' +
        '<div class="decibel-pts-num">' + fmtAmps + '</div>' +
        '<div class="decibel-meta">' +
          '<div class="decibel-meta-row"><span class="decibel-meta-lbl">RANK</span><span class="decibel-meta-val">#' + rank + '</span></div>' +
          '<div class="decibel-meta-row"><span class="decibel-meta-lbl">TIER</span><span class="decibel-meta-val">' + esc(tierDisplay) + '</span></div>' +
        '</div>' +
        (nextTierName ?
          '<div class="decibel-progress-wrap">' +
            '<div class="decibel-progress-row"><span>' + esc(nextTierName) + '</span><span>' + progressPct.toFixed(0) + '%</span></div>' +
            '<div class="decibel-bar-bg"><div class="decibel-bar-fill" style="width:' + progressPct.toFixed(1) + '%"></div></div>' +
          '</div>'
        : '') +
      '</div>';
  } catch(e) {
    document.getElementById('tier-card-wrap').innerHTML='<div class="decibel-card decibel-unavail">Decibel Points unavailable</div>';
  }
}

// ── Today Volume (Decibel) ────────────────────────────────────────────────
async function refreshTodayVolume() {
  try {
    const d = await fetch(api('/api/pnl')).then(r=>r.json());
    const vol = d.todayVolume || 0;
    const today = new Date().toISOString().slice(0, 10);
    document.getElementById('week-label').textContent = 'Today Volume (UTC)';
    document.getElementById('week-vol').textContent = '$'+vol.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
    const subEl = document.getElementById('week-vol-sub');
    if (subEl) subEl.textContent = today;
    const cdEl = document.getElementById('week-countdown');
    if (cdEl) cdEl.style.display = 'none';
  } catch {}
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
  const exchange = (window.BOT_CONTEXT?.exchange || 'sodex').toLowerCase();
  if (exchange === 'decibel') {
    await refreshTodayVolume();
    return;
  }
  try {
    const d = await fetch('/api/sopoints/week').then(r=>r.json());
    if (!d||d.error) return;
    const totalVol = (d.futuresVolume||0)+(d.spotVolume||0);
    const staleTag = d.stale ? ' <span style="font-size:0.6rem;background:rgba(255,180,0,0.25);color:#ffb400;border-radius:4px;padding:0.1rem 0.4rem;">⚠ Expired</span>' : '';
    document.getElementById('week-label').innerHTML = esc(d.weekLabel||d.weekName||'Current Week')+staleTag;
    document.getElementById('week-vol').textContent = '$'+totalVol.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
    weekDistributionTime = d.distributionTime||0;
    const el = document.getElementById('week-cd');
    if (el) el.innerHTML = formatCountdown(Math.max(0, weekDistributionTime - Math.floor(Date.now()/1000)));
  } catch {}
}

// ── Control Panel ─────────────────────────────────────────────────────────
let ctrlRunning = false;

function showToast(msg, isErr) {
  const t = document.getElementById('ctrl-toast');
  if (!t) return;
  t.textContent=msg;
  t.className = 'ctrl-toast '+(isErr?'err':'ok');
  t.style.opacity='1';
  setTimeout(()=>{t.style.opacity='0';},2500);
}

function updateCtrlButtons(isRunning, mode) {
  ctrlRunning=isRunning;
  document.getElementById('btn-start').disabled=isRunning;
  document.getElementById('btn-stop').disabled=!isRunning;

  const farmBtn = document.getElementById('btn-farm');
  const tradeBtn = document.getElementById('btn-trade');
  if (farmBtn) farmBtn.className = 'mode-btn'+(mode==='farm'?' active':'');
  if (tradeBtn) tradeBtn.className = 'mode-btn'+(mode==='trade'?' active':'');

  // Hero status badge
  const badge = document.getElementById('status-badge');
  if (badge) badge.className = 'hero-st '+(isRunning?'running':'stopped');
  const stEl = document.getElementById('status-text');
  if (stEl) stEl.textContent = isRunning ? 'RUNNING' : 'STOPPED';

  // Live dot
  const liveDot = document.getElementById('live-dot');
  if (liveDot) liveDot.className = 'ldot on'+(isRunning?'':' off');

  // Re-render KPI layout for new mode (use last known values)
  if (_lastKpiPnl !== null && _lastKpiVol !== null) {
    _lastKpiMode = mode; // update mode first
    updateKpiLayout(mode, _lastKpiPnl, _lastKpiVol);
  }
}

async function ctrlStart() {
  try { const r=await fetch(api('/api/control/start'),{method:'POST'}),d=await r.json(); if(r.ok){showToast('Bot started',false);refreshCtrlStatus();}else showToast(d.error||'Error',true); } catch{showToast('Failed',true);}
}
async function ctrlStop() {
  try { const r=await fetch(api('/api/control/stop'),{method:'POST'}),d=await r.json(); if(r.ok){showToast('Bot stopped',false);refreshCtrlStatus();}else showToast(d.error||'Error',true); } catch{showToast('Failed',true);}
}
async function ctrlSetMode(mode) {
  try { const r=await fetch(api('/api/control/set_mode'),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({mode})}),d=await r.json(); if(r.ok){showToast('Mode: '+mode,false);updateCtrlButtons(ctrlRunning,mode);}else showToast(d.error||'Error',true); } catch{showToast('Failed',true);}
}
async function ctrlSetMaxLoss() {
  const amount=parseFloat(document.getElementById('input-maxloss').value);
  if(!amount||amount<=0){showToast('Invalid amount',true);return;}
  try { const r=await fetch(api('/api/control/set_max_loss'),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({amount})}),d=await r.json(); if(r.ok)showToast('Max loss: $'+amount,false);else showToast(d.error||'Error',true); } catch{showToast('Failed',true);}
}
async function ctrlClosePosition() {
  if(!confirm('Force close current position?'))return;
  try { const r=await fetch(api('/api/control/close_position'),{method:'POST'}),d=await r.json(); if(r.ok&&d.ok)showToast('Position closed',false);else showToast('Close failed',true); } catch{showToast('Failed',true);}
}

async function refreshCtrlStatus() {
  try {
    const d=await fetch(api('/api/control/status')).then(r=>r.json());
    updateCtrlButtons(d.isRunning,d.mode);
    document.getElementById('input-maxloss').value=d.maxLoss;

    const setEl = (id, val) => { const el=document.getElementById(id); if(el) el.textContent=val; };
    setEl('side-mode', d.mode||'—');
    setEl('side-maxloss', '$'+(d.maxLoss||5));
    setEl('side-uptime', (d.uptime||0)+'m');
    setEl('hdr-uptime', 'Uptime: '+(d.uptime||0)+'m');
    setEl('hdr-position', d.hasPosition ? '● OPEN' : '—');

    const riskEl = document.getElementById('risk-state');
    if (riskEl && d.currentPnL !== undefined && d.maxLoss) {
      const ratio = Math.abs(d.currentPnL) / d.maxLoss;
      if (ratio > 0.75) { riskEl.textContent='DANGER'; riskEl.className='risk-state danger'; }
      else if (ratio > 0.4) { riskEl.textContent='WARN'; riskEl.className='risk-state warn'; }
      else { riskEl.textContent='SAFE'; riskEl.className='risk-state safe'; }
    }

    const cdPanel = document.getElementById('cooldown-panel');
    const cdVal = document.getElementById('cooldown-val');
    if (cdPanel && cdVal) {
      if (d.cooldown) { cdPanel.style.display=''; cdVal.textContent=d.cooldown+'s'; }
      else { cdPanel.style.display='none'; }
    }
  } catch {}
}


// ── Config Panel ──────────────────────────────────────────────────────────
const CFG_KEYS = ['ORDER_SIZE_MIN','ORDER_SIZE_MAX','STOP_LOSS_PERCENT','TAKE_PROFIT_PERCENT','POSITION_SL_PERCENT','FARM_MIN_HOLD_SECS','FARM_MAX_HOLD_SECS','FARM_TP_USD','FARM_SL_PERCENT','FARM_SCORE_EDGE','FARM_MIN_CONFIDENCE','FARM_EARLY_EXIT_SECS','FARM_EARLY_EXIT_PNL','FARM_EXTRA_WAIT_SECS','FARM_BLOCKED_HOURS','TRADE_TP_PERCENT','TRADE_SL_PERCENT','COOLDOWN_MIN_MINS','COOLDOWN_MAX_MINS','MIN_POSITION_VALUE_USD'];

function openCfgModal() {
  loadConfigPanel();
  // Refresh identity fields with current live values
  if (window.BOT_CONTEXT?.botId) {
    const nameInput = document.getElementById('cfg-bot-name');
    const symInput = document.getElementById('cfg-bot-symbol');
    if (nameInput) nameInput.value = document.getElementById('hero-bot-name')?.textContent || window.BOT_CONTEXT.botName || '';
    if (symInput) symInput.value = document.getElementById('symbol-label')?.textContent || '';
  }
  document.getElementById('cfg-overlay').classList.add('open');
}
function closeCfgModal() {
  document.getElementById('cfg-overlay').classList.remove('open');
}

function populateConfigFields(cfg) {
  for (const k of CFG_KEYS) {
    const el = document.getElementById('cfg-'+k);
    if (el && cfg[k] !== undefined) {
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
    const cfg = await fetch(api('/api/config')).then(r => r.json());
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
        const raw = el.value.trim();
        patch[k] = raw === '' ? [] : raw.split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n));
      } else {
        patch[k] = parseFloat(el.value);
      }
    }
    const r = await fetch(api('/api/config'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) });
    const d = await r.json();
    if (r.ok) { populateConfigFields(d); showCfgToast('Config applied ✓', false); setTimeout(closeCfgModal, 1200); }
    else { const msg = d.errors ? d.errors.map(e => e.field+': '+e.message).join('; ') : (d.error||'Error'); showCfgToast(msg, true); }
  } catch(e) { showCfgToast('Request failed', true); }
  finally { setCfgBusy(false); }
}

async function resetConfig() {
  setCfgBusy(true);
  try {
    const r = await fetch(api('/api/config'), { method: 'DELETE' });
    const d = await r.json();
    if (r.ok) { populateConfigFields(d); showCfgToast('Reset to defaults', false); }
    else showCfgToast(d.error||'Error', true);
  } catch(e) { showCfgToast('Request failed', true); }
  finally { setCfgBusy(false); }
}

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

// ── Analytics ─────────────────────────────────────────────────────────────
function pct(v) { return (v !== undefined && v !== null) ? (v*100).toFixed(1)+'%' : '—'; }
function usdFmt(v) { return (v !== undefined && v !== null) ? (v>=0?'+':'') + '$' + Number(v).toFixed(4) : '—'; }

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
    var s = await fetch(api('/api/analytics/summary')).then(function(r){return r.json();});
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

async function updateDecibelToken() {
  const tokenInput = document.getElementById('decibel-token-input');
  const ownerInput = document.getElementById('decibel-owner-input');
  const toast = document.getElementById('decibel-token-toast');
  const token = tokenInput?.value.trim();
  const owner = ownerInput?.value.trim();
  if (!token && !owner) return;
  try {
    const r = await fetch('/api/decibel-points/config', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ token, owner }) });
    const d = await r.json();
    if (d.ok) {
      toast.textContent = '✓ Updated'; toast.style.color = '#00d464';
      if (token) tokenInput.value = '';
      refreshTier();
    } else {
      toast.textContent = '✗ ' + (d.error||'Failed'); toast.style.color = '#ff4d4d';
    }
  } catch { toast.textContent = '✗ Error'; toast.style.color = '#ff4d4d'; }
  toast.style.opacity = '1';
  setTimeout(() => { toast.style.opacity = '0'; }, 3000);
}

// ── Exchange-aware init ───────────────────────────────────────────────────
function initExchangeUI() {
  const exchange = (window.BOT_CONTEXT?.exchange || 'sodex').toLowerCase();
  const isDecibel = exchange === 'decibel';
  const isBotContext = !!window.BOT_CONTEXT?.botId;

  // Set bot name from context
  const nameEl = document.getElementById('hero-bot-name');
  if (nameEl && window.BOT_CONTEXT?.botName) {
    nameEl.textContent = window.BOT_CONTEXT.botName;
  } else if (nameEl && window.BOT_CONTEXT?.exchange) {
    const ex = window.BOT_CONTEXT.exchange;
    nameEl.textContent = ex.charAt(0).toUpperCase() + ex.slice(1) + ' Bot';
  }

  // Show bot identity section only in multi-bot mode
  const identitySection = document.getElementById('bot-identity-section');
  if (identitySection) identitySection.style.display = isBotContext ? '' : 'none';

  // Pre-fill identity fields
  if (isBotContext) {
    const nameInput = document.getElementById('cfg-bot-name');
    const symInput = document.getElementById('cfg-bot-symbol');
    if (nameInput && window.BOT_CONTEXT?.botName) nameInput.value = window.BOT_CONTEXT.botName;
    if (symInput) {
      const symEl = document.getElementById('symbol-label');
      if (symEl) symInput.value = symEl.textContent || '';
    }
  }

  // Settings modal: show correct token section
  const sopointsSection = document.getElementById('sopoints-cfg-section');
  const decibelSection = document.getElementById('decibel-cfg-section');
  if (sopointsSection) sopointsSection.style.display = isDecibel ? 'none' : '';
  if (decibelSection) decibelSection.style.display = isDecibel ? '' : 'none';

  // Week card: hide countdown for Decibel (uses Today Volume instead)
  if (isDecibel) {
    const cdEl = document.getElementById('week-countdown');
    if (cdEl) cdEl.style.display = 'none';
    const labelEl = document.getElementById('week-label');
    if (labelEl) labelEl.textContent = 'Today Volume (UTC)';
    const subEl = document.getElementById('week-vol-sub');
    if (subEl) subEl.textContent = new Date().toISOString().slice(0, 10);
  }
}

async function updateBotIdentity() {
  const nameInput = document.getElementById('cfg-bot-name');
  const symInput = document.getElementById('cfg-bot-symbol');
  const toast = document.getElementById('identity-toast');
  const name = nameInput?.value.trim();
  const symbol = symInput?.value.trim();
  if (!name && !symbol) return;
  if (!window.BOT_CONTEXT?.botId) return;
  try {
    const r = await fetch('/api/bots/' + window.BOT_CONTEXT.botId + '/identity', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, symbol }),
    });
    const d = await r.json();
    if (d.ok) {
      toast.textContent = '✓ Saved';
      toast.style.color = 'var(--green)';
      // Update live UI
      const nameEl = document.getElementById('hero-bot-name');
      if (nameEl && d.name) { nameEl.textContent = d.name; window.BOT_CONTEXT.botName = d.name; }
      const symEl = document.getElementById('symbol-label');
      if (symEl && d.symbol) symEl.textContent = d.symbol;
    } else {
      toast.textContent = '✗ ' + (d.error || 'Failed');
      toast.style.color = 'var(--red)';
    }
  } catch {
    toast.textContent = '✗ Error';
    toast.style.color = 'var(--red)';
  }
  toast.style.opacity = '1';
  setTimeout(() => { toast.style.opacity = '0'; }, 3000);
}

// ── Init ──────────────────────────────────────────────────────────────────
initCharts();
initExchangeUI();
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
// ── Config Panel ──────────────────────────────────────────────────────────
