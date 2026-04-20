// Manager Dashboard — modern redesign

let currentFilter = 'all';
let botsData = [];
const sparklineCharts = {}; // botId → Chart instance

// ── Formatting helpers ────────────────────────────────────────────────────────

function fmtUsd(n) {
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
  if (abs >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return n.toFixed(2);
}

function fmtSign(n) {
  return n > 0 ? '+' : n < 0 ? '-' : '';
}

// ── Stats ─────────────────────────────────────────────────────────────────────

async function fetchStats() {
  try {
    const stats = await fetch('/api/bots/stats').then(r => r.json());

    // PnL — primary hero
    const pnlEl = document.getElementById('total-pnl');
    const sign = fmtSign(stats.totalPnl);
    pnlEl.textContent = sign + '$' + fmtUsd(Math.abs(stats.totalPnl));
    pnlEl.className = 'stat-value ' + (stats.totalPnl > 0 ? 'positive' : stats.totalPnl < 0 ? 'negative' : '');

    document.getElementById('total-volume').textContent = '$' + fmtUsd(stats.totalVolume);
    document.getElementById('active-bots').textContent = stats.activeBotCount;
    document.getElementById('active-bots-sub').textContent = 'of ' + botsData.length + ' running';
    document.getElementById('total-fees').textContent = '$' + fmtUsd(stats.totalFees);
  } catch (err) {
    console.error('fetchStats error:', err);
  }
}

// ── Bots ──────────────────────────────────────────────────────────────────────

async function fetchBots() {
  try {
    botsData = await fetch('/api/bots').then(r => r.json());
    renderBots();
  } catch (err) {
    document.getElementById('bot-cards').innerHTML =
      '<div class="state-error">⚠ Failed to load bots: ' + err.message + '</div>';
  }
}

function renderBots() {
  const container = document.getElementById('bot-cards');
  const tmpl = document.getElementById('bot-card-template').innerHTML;

  let filtered = botsData;
  if (currentFilter === 'active')   filtered = botsData.filter(b => b.status === 'active');
  if (currentFilter === 'inactive') filtered = botsData.filter(b => b.status === 'inactive');

  const label = document.getElementById('bot-count-label');
  if (label) label.textContent = filtered.length + ' bot' + (filtered.length !== 1 ? 's' : '');

  if (!filtered.length) {
    container.innerHTML = '<div class="state-empty">No bots match this filter</div>';
    return;
  }

  // Destroy old sparkline charts before re-render
  Object.values(sparklineCharts).forEach(c => c.destroy());
  Object.keys(sparklineCharts).forEach(k => delete sparklineCharts[k]);

  container.innerHTML = filtered.map(bot => buildCard(tmpl, bot)).join('');

  // Attach listeners
  container.querySelectorAll('.btn-start-bot').forEach(btn =>
    btn.addEventListener('click', () => startBot(btn.dataset.botId)));
  container.querySelectorAll('.btn-stop-bot').forEach(btn =>
    btn.addEventListener('click', () => stopBot(btn.dataset.botId)));

  // Draw sparklines after DOM is ready
  requestAnimationFrame(() => filtered.forEach(bot => drawSparkline(bot)));
}

function buildCard(tmpl, bot) {
  const isActive = bot.status === 'active';
  const pnl = bot.sessionPnl ?? 0;
  const vol = bot.sessionVolume ?? 0;
  const eff = bot.efficiencyBps ?? 0;

  const strategyTags = (bot.tags || [])
    .slice(0, 2)
    .map(t => `<span class="strategy-tag">${t}</span>`)
    .join('');

  return tmpl
    .replace(/{id}/g,          bot.id)
    .replace(/{name}/g,        bot.name)
    .replace(/{exchange}/g,    (bot.exchange || '').toUpperCase())
    .replace(/{strategyTags}/g, strategyTags)
    .replace(/{status}/g,      bot.status)
    .replace(/{statusText}/g,  isActive ? '● LIVE' : '○ IDLE')
    .replace(/{cardClass}/g,   isActive ? 'active' : 'inactive')
    .replace(/{pnlClass}/g,    pnl > 0 ? 'positive' : pnl < 0 ? 'negative' : 'neutral')
    .replace(/{pnlSign}/g,     pnl > 0 ? '+' : pnl < 0 ? '-' : '')
    .replace(/{pnl}/g,         fmtUsd(Math.abs(pnl)))
    .replace(/{volume}/g,      fmtUsd(vol))
    .replace(/{effClass}/g,    eff > 0 ? 'positive' : eff < 0 ? 'negative' : '')
    .replace(/{efficiency}/g,  eff.toFixed(1))
    .replace(/{uptime}/g,      bot.uptime ?? 0)
    .replace(/{startDisplay}/g, isActive ? 'none' : 'flex')
    .replace(/{stopDisplay}/g,  isActive ? 'flex' : 'none');
}

// ── Sparklines ────────────────────────────────────────────────────────────────

function drawSparkline(bot) {
  const wrap = document.getElementById('sparkline-' + bot.id);
  if (!wrap) return;

  const history = bot.pnlHistory || [];

  // If no trade history but there's an open position — show live position widget
  if (!history.length) {
    if (bot.hedgePosition) {
      // HedgeBot: show both legs
      const hp = bot.hedgePosition;
      const legA = hp.legA;
      const legB = hp.legB;
      const combinedPnl = hp.combinedPnl ?? 0;
      const pnlSign = combinedPnl >= 0 ? '+' : '';
      const pnlCls = combinedPnl > 0 ? 'positive' : combinedPnl < 0 ? 'negative' : '';
      const fmtPrice = p => (p || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      wrap.innerHTML =
        '<div class="live-pos-widget">' +
          '<div class="live-pos-header">' +
            '<span class="live-pos-side pos-hedge">⇄ HEDGE</span>' +
            '<span class="live-pos-pnl ' + pnlCls + '">' + pnlSign + '$' + Math.abs(combinedPnl).toFixed(4) + '</span>' +
          '</div>' +
          '<div class="live-pos-rows">' +
            '<div class="live-pos-row"><span>' + (legA.symbol || 'Leg A') + '</span><span class="' + (legA.side === 'long' ? 'pos-long' : 'pos-short') + '">' + (legA.side || '').toUpperCase() + ' ' + (legA.size || '') + ' @ $' + fmtPrice(legA.entryPrice) + '</span></div>' +
            '<div class="live-pos-row"><span>' + (legB.symbol || 'Leg B') + '</span><span class="' + (legB.side === 'long' ? 'pos-long' : 'pos-short') + '">' + (legB.side || '').toUpperCase() + ' ' + (legB.size || '') + ' @ $' + fmtPrice(legB.entryPrice) + '</span></div>' +
          '</div>' +
        '</div>';
    } else if (bot.openPosition) {
      const pos = bot.openPosition;
      const isLong = pos.side === 'long';
      const pnl = pos.unrealizedPnl ?? 0;
      const pnlSign = pnl >= 0 ? '+' : '';
      const pnlCls = pnl > 0 ? 'positive' : pnl < 0 ? 'negative' : '';
      const sideCls = isLong ? 'pos-long' : 'pos-short';
      const entryFmt = (pos.entryPrice || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      const markFmt = (pos.markPrice || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      const dur = pos.durationSecs ? pos.durationSecs + 's' : '—';
      wrap.innerHTML =
        '<div class="live-pos-widget">' +
          '<div class="live-pos-header">' +
            '<span class="live-pos-side ' + sideCls + '">' + (isLong ? '▲ LONG' : '▼ SHORT') + '</span>' +
            '<span class="live-pos-pnl ' + pnlCls + '">' + pnlSign + '$' + Math.abs(pnl).toFixed(4) + '</span>' +
          '</div>' +
          '<div class="live-pos-rows">' +
            '<div class="live-pos-row"><span>Entry</span><span>$' + entryFmt + '</span></div>' +
            '<div class="live-pos-row"><span>Mark</span><span>$' + markFmt + '</span></div>' +
            '<div class="live-pos-row"><span>Size</span><span>' + (pos.size || '—') + '</span></div>' +
            '<div class="live-pos-row"><span>Duration</span><span>' + dur + '</span></div>' +
          '</div>' +
        '</div>';
    }
    return; // no history to chart
  }

  // Build canvas
  wrap.innerHTML = '<canvas></canvas>';
  const canvas = wrap.querySelector('canvas');
  const ctx = canvas.getContext('2d');

  const values = history.map(p => p.value);
  const isPositive = values[values.length - 1] >= values[0];
  const lineColor = isPositive ? '#16a34a' : '#dc2626';
  const fillColor = isPositive ? 'rgba(22,163,74,0.08)' : 'rgba(220,38,38,0.08)';

  sparklineCharts[bot.id] = new Chart(ctx, {
    type: 'line',
    data: {
      labels: history.map(p => p.time),
      datasets: [{
        data: values,
        borderColor: lineColor,
        backgroundColor: fillColor,
        borderWidth: 1.5,
        pointRadius: 0,
        fill: true,
        tension: 0.4,
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      plugins: { legend: { display: false }, tooltip: { enabled: false } },
      scales: {
        x: { display: false },
        y: { display: false },
      },
      elements: { line: { borderCapStyle: 'round' } },
    }
  });
}

// ── Bot Controls ──────────────────────────────────────────────────────────────

async function startBot(botId) {
  const btn = document.querySelector(`.btn-start-bot[data-bot-id="${botId}"]`);
  if (btn) { btn.disabled = true; btn.textContent = 'Starting…'; }
  try {
    const r = await fetch(`/api/bots/${botId}/start`, { method: 'POST' });
    if (!r.ok) { const d = await r.json(); throw new Error(d.error || 'Failed'); }
    await refresh();
  } catch (err) {
    alert('Failed to start bot: ' + err.message);
    if (btn) { btn.disabled = false; btn.textContent = '▶ Start Bot'; }
  }
}

async function stopBot(botId) {
  const btn = document.querySelector(`.btn-stop-bot[data-bot-id="${botId}"]`);
  if (btn) { btn.disabled = true; btn.textContent = 'Stopping…'; }
  try {
    const r = await fetch(`/api/bots/${botId}/stop`, { method: 'POST' });
    if (!r.ok) { const d = await r.json(); throw new Error(d.error || 'Failed'); }
    await refresh();
  } catch (err) {
    alert('Failed to stop bot: ' + err.message);
    if (btn) { btn.disabled = false; btn.textContent = '■ Stop'; }
  }
}

// ── Filter Tabs ───────────────────────────────────────────────────────────────

function setupFilters() {
  document.querySelectorAll('.filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentFilter = btn.dataset.filter;
      renderBots();
    });
  });
}

// ── Init ──────────────────────────────────────────────────────────────────────

async function refresh() {
  await fetchBots();
  await fetchStats();
}

async function init() {
  setupFilters();
  await refresh();
  setInterval(refresh, 5000);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
