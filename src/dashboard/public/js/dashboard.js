// dashboard.js — extracted from server.ts _buildHtml()

// Bot context — injected by server for bot detail pages (null = single-bot mode)
window.BOT_CONTEXT = null;

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
      fetch(api('/api/pnl')).then(r=>r.json()),
      fetch(api('/api/trades')).then(r=>r.json()),
      fetch(api('/api/events')).then(r=>r.json()),
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
    pnlEl.textContent = (pnl>=0?'+':'')+'$'+Math.abs(pnl).toFixed(4);
    pnlEl.className = 'card-value '+(pnl>=0?'positive':'negative');
    document.getElementById('pnl-bar').style.width = Math.min(Math.abs(pnl)/10*100,100)+'%';
    document.getElementById('pnl-bar').style.background = pnl>=0?'#00d464':'#ff4d4d';
    const vol = pnlData.sessionVolume||0;
    document.getElementById('vol-value').textContent = '$'+vol.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
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
      fetch(api('/api/position')).then(r=>r.json()),
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
    const pnlStr = (pos.unrealizedPnl>=0?'+':'')+'$'+pos.unrealizedPnl.toFixed(4);
    badge.innerHTML = '<span class="'+sc+'">'+pos.side.toUpperCase()+'</span>';
    body.innerHTML = '<div class="pos-grid">'+
      '<div class="pos-item"><label>Entry Price</label><span>$'+pos.entryPrice.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})+'</span></div>'+
      '<div class="pos-item"><label>Mark Price</label><span>$'+pos.markPrice.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})+'</span></div>'+
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
  const evtEs = new EventSource(api('/api/events/stream'));
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
    const uptime=d.uptime?d.uptime+'m uptime':'';
    const pnl=d.currentPnL!==undefined?' · PnL: '+(d.currentPnL>=0?'+':'')+'$'+d.currentPnL.toFixed(4):'';
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
