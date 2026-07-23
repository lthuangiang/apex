// Manager Dashboard — modern redesign

let currentFilter = 'all';
let botsData = [];
const sparklineCharts = {}; // botId → Chart instance

// ── Formatting helpers ────────────────────────────────────────────────────────

function fmtUsd(n) {
  if (n == null || isNaN(n)) return '0.00';
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
  if (abs >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return n.toFixed(2);
}

function fmtSign(n) {
  return n > 0 ? '+' : n < 0 ? '-' : '';
}

// ── AI Signal Strip Renderer ──────────────────────────────────────────────────

function renderAIStrip(botId, state) {
  const card = document.querySelector(`[data-bot-id="${botId}"]`);
  if (!card) return;

  // Pills
  const regimeColors = { SIDEWAY: '#BA7517', TREND: '#1D9E75', HIGH_VOL: '#E24B4A' };
  const regimeEl = card.querySelector('.ai-pill-val');
  if (regimeEl) {
    regimeEl.style.color = regimeColors[state.regime] || '';
    regimeEl.textContent = state.regime;
  }

  const fg = state.fearGreedIndex;
  const macroEl = card.querySelectorAll('.ai-pill-val')[1];
  if (macroEl) {
    macroEl.textContent = fg < 35 ? `Fear ${fg}` : fg > 55 ? `Greed ${fg}` : `Neutral ${fg}`;
    macroEl.style.color = fg < 35 ? '#E24B4A' : fg > 55 ? '#1D9E75' : '#888780';
  }

  const mx = state.macroSentimentMultiplier;
  const mxEl = card.querySelectorAll('.ai-pill-val')[2];
  if (mxEl && mx != null) {
    mxEl.textContent = mx.toFixed(2) + '×';
    mxEl.style.color = mx > 1 ? '#1D9E75' : mx < 1 ? '#E24B4A' : '#888780';
  }

  const dirEl = card.querySelectorAll('.ai-pill-val')[3];
  if (dirEl) {
    dirEl.textContent = state.lastSignalDirection === 'LONG' ? 'LONG ↑' : state.lastSignalDirection === 'SHORT' ? 'SHORT ↓' : '—';
  }

  // Confidence bar
  const conf = state.effectiveConfidence;
  if (conf != null) {
    const fillColor = conf < 0.4 ? '#E24B4A' : conf < 0.65 ? '#BA7517' : '#1D9E75';
    const fill = card.querySelector('.conf-fill');
    if (fill) {
      fill.style.width = (conf * 100).toFixed(1) + '%';
      fill.style.background = fillColor;
    }
    const pctEl = card.querySelector('.conf-pct');
    if (pctEl) {
      pctEl.textContent = conf.toFixed(2);
      pctEl.style.color = fillColor;
    }
  }

  // Pipeline log - only update if we have new pipeline data
  const logBody = card.querySelector('.decision-log');
  if (logBody && state.signalPipeline && state.signalPipeline.length > 0) {
    const existing = logBody.querySelectorAll('.log-row');
    existing.forEach(r => r.remove());
    const ts = card.querySelector('.log-timestamp');
    if (ts) ts.textContent = 'last tick just now';

    state.signalPipeline.forEach(({ gate, result, reason }) => {
      const row = document.createElement('div');
      row.className = 'log-row';
      const cls = result === 'pass' ? 'log-pass' : result === 'skip' ? 'log-fail' : 'log-skip';
      const label = result === 'pass' ? `pass · ${reason}` : result === 'skip' ? `skip · ${reason}` : 'not reached';
      row.innerHTML = `<span class="log-gate">${gate}</span><span class="${cls}">${label}</span>`;
      logBody.appendChild(row);
    });
  }

  // Wave 3: Intelligence Engine panel — proof the engine is deciding
  renderIntelPanel(card, botId, state.intelligence);
}

function renderIntelPanel(card, botId, intel) {
  const panel = card.querySelector(`#intel-panel-${botId}`) || card.querySelector('.intel-panel');
  if (!panel) return;
  if (!intel) { panel.style.display = 'none'; return; }
  panel.style.display = 'block';

  const set = (sel, txt) => { const el = panel.querySelector(sel); if (el) el.textContent = txt; };
  const bar = (sel, pct) => { const el = panel.querySelector(sel); if (el) el.style.width = Math.max(0, Math.min(100, pct)).toFixed(0) + '%'; };

  set('.intel-regime', `${(intel.regime || '—').toUpperCase()} · ${Math.round((intel.regimeConfidence || 0) * 100)}%`);

  bar('.intel-bull-fill', intel.bullConviction || 0);
  bar('.intel-bear-fill', intel.bearConviction || 0);
  bar('.intel-neutral-fill', intel.neutralConviction || 0);
  set('.intel-bull-val', Math.round(intel.bullConviction || 0));
  set('.intel-bear-val', Math.round(intel.bearConviction || 0));
  set('.intel-neutral-val', Math.round(intel.neutralConviction || 0));

  const strat = (intel.recommendedStrategy || '—').toUpperCase();
  const stratColors = { TRADE: '#1D9E75', FARM: '#BA7517', HEDGE: '#3b82f6', STANDBY: '#E24B4A' };
  const stratEl = panel.querySelector('.intel-strategy');
  if (stratEl) { stratEl.textContent = strat; stratEl.style.color = stratColors[strat] || '#e5e5e5'; }
  set('.intel-reason', intel.strategyReason || '');

  const riskColors = { low: '#1D9E75', medium: '#BA7517', high: '#E24B4A', extreme: '#E24B4A' };
  const riskEl = panel.querySelector('.intel-risk');
  if (riskEl) {
    riskEl.textContent = `RISK ${(intel.riskLevel || '—').toUpperCase()}`;
    riskEl.style.background = (riskColors[intel.riskLevel] || '#888780') + '33';
    riskEl.style.color = riskColors[intel.riskLevel] || '#888780';
  }

  set('.intel-size', intel.baseSize != null ? (intel.baseSize * 100).toFixed(0) + '%' : '—');
  set('.intel-lev', intel.maxLeverage != null ? intel.maxLeverage.toFixed(1) + '×' : '—');
  set('.intel-confmult', intel.confidenceMultiplier != null ? intel.confidenceMultiplier.toFixed(2) + '×' : '—');

  const warnEl = panel.querySelector('.intel-warnings');
  if (warnEl) {
    if (intel.warnings && intel.warnings.length) {
      warnEl.style.display = 'block';
      warnEl.textContent = '⚠ ' + intel.warnings.join(' · ');
    } else {
      warnEl.style.display = 'none';
    }
  }

  // Apply button: only when recommendation differs from current mode and is actionable
  const bot = (window.botsData || botsData || []).find(b => b.id === botId);
  const currentMode = bot?.mode || 'farm';
  const rec = intel.recommendedStrategy;
  const btn = panel.querySelector('.intel-apply-btn');
  if (btn) {
    if ((rec === 'farm' || rec === 'trade') && rec !== currentMode) {
      btn.style.display = 'block';
      btn.textContent = `Áp dụng: ${currentMode.toUpperCase()} → ${rec.toUpperCase()}`;
      btn.onclick = () => applyIntelRecommendation(botId, rec, btn);
    } else {
      btn.style.display = 'none';
    }
  }
}

async function applyIntelRecommendation(botId, mode, btn) {
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Đang áp dụng...';
  try {
    const res = await fetch(`/api/bots/${botId}/control/set_mode`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const bot = (window.botsData || botsData || []).find(b => b.id === botId);
    if (bot) bot.mode = mode;
    btn.textContent = '✓ Đã đổi mode';
    btn.style.background = '#1D9E75';
  } catch (err) {
    console.error('[Intel] apply failed:', err);
    btn.disabled = false;
    btn.textContent = original;
    alert('Đổi mode thất bại: ' + err.message);
  }
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

    // PnL delta
    const deltaEl = document.getElementById('pnl-delta');
    if (deltaEl && stats.previousSessionPnl !== undefined) {
      const delta = stats.totalPnl - stats.previousSessionPnl;
      const deltaSign = delta > 0 ? '▲ +' : delta < 0 ? '▼ ' : '';
      deltaEl.textContent = deltaSign + '$' + fmtUsd(Math.abs(delta)) + ' vs yesterday';
      deltaEl.className = delta > 0 ? 'delta-positive' : delta < 0 ? 'delta-negative' : 'delta-neutral';
    }

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
    const res = await fetch('/api/bots');
    if (!res.ok) {
      // Server returned error (503 = manager not ready, etc.)
      const err = await res.json().catch(() => ({ error: res.statusText }));
      if (res.status === 503) {
        // Manager not ready yet — show empty state, don't error
        botsData = [];
        renderBots();
        return;
      }
      throw new Error(err.error || res.statusText);
    }
    const newData = await res.json();

    // Ensure we got an array (not error object)
    if (!Array.isArray(newData)) {
      botsData = [];
      renderBots();
      return;
    }

    // Check if bot list changed (added/removed)
    const listChanged = !botsData || botsData.length !== newData.length ||
      botsData.some((b, i) => b.id !== newData[i].id);

    botsData = newData;

    // Only re-render if bot list changed, otherwise just update data
    if (listChanged) {
      renderBots();
    } else {
      updateBotCards();
    }
  } catch (err) {
    document.getElementById('bot-cards').innerHTML =
      '<div class="state-error">⚠ Failed to load bots: ' + err.message + '</div>';
  }
}

function updateBotCards() {
  // Update existing bot cards without re-rendering
  botsData.forEach(bot => {
    const card = document.querySelector(`[data-bot-id="${bot.id}"]`);
    if (!card) return;

    // Update card class (active/paused/inactive)
    const cardClass = bot.status === 'active' ? 'active' : bot.status === 'paused' ? 'paused' : 'inactive';
    card.className = `bot-card ${cardClass}`;
    card.dataset.status = bot.status;

    // Update status
    const statusPill = card.querySelector('.status-pill');
    if (statusPill) {
      statusPill.className = `status-pill ${bot.status}`;
      statusPill.querySelector('.status-dot');
      const statusText = bot.status === 'active' ? '● LIVE' : bot.status === 'paused' ? '⏸ PAUSED' : '○ IDLE';
      const textNode = Array.from(statusPill.childNodes).find(n => n.nodeType === 3);
      if (textNode) textNode.textContent = statusText;
    }

    // Update PnL
    const pnlValue = card.querySelector('.pnl-value');
    if (pnlValue) {
      const pnl = bot.sessionPnl ?? 0;
      const pnlClass = pnl > 0 ? 'pos' : pnl < 0 ? 'neg' : '';
      pnlValue.className = `pnl-value ${pnlClass}`;
      const sign = pnl > 0 ? '+' : pnl < 0 ? '-' : '';
      pnlValue.textContent = sign + '$' + fmtUsd(Math.abs(pnl));
    }

    // Update stats — different layout for DN vs standard cards
    const isDeltaNeutral = card.querySelector('[class*="delta-neutral"]') || card.innerHTML.includes('DELTA-NEUTRAL') || bot.botType === 'hedge' || bot.botType === 'pair' || bot.botType === 'delta-neutral' || bot.botType === 'oi-farmer';
    const statValues = card.querySelectorAll('.stat-item-value');

    if (isDeltaNeutral) {
      // DN card stats: OI-Hours, Volume, Funding, Cycles
      const oiHoursRaw = bot.totalOiHours || 0;
      const oiHours = oiHoursRaw > 1000 ? (oiHoursRaw / 1000).toFixed(1) + 'K' : oiHoursRaw.toFixed(0);
      const dnVolume = bot.sessionVolume ? fmtUsd(bot.sessionVolume) : '0';
      const fundingNet = ((bot.totalFundingReceived || 0) - (bot.totalFundingPaid || 0));
      const fundingStr = (fundingNet >= 0 ? '+' : '') + '$' + Math.abs(fundingNet).toFixed(3);

      if (statValues[0]) statValues[0].textContent = oiHours;
      if (statValues[1]) statValues[1].textContent = '$' + dnVolume;
      if (statValues[2]) statValues[2].textContent = fundingStr;
      if (statValues[3]) statValues[3].textContent = String(bot.completedCycles || 0);
    } else {
      // Standard bot stats: Balance, Balance, Volume, Cost/$1M, Uptime
      if (statValues[0]) statValues[0].textContent = '$' + fmtUsd(bot.startBalance);
      if (statValues[1]) statValues[1].textContent = '$' + fmtUsd(bot.currentBalance);
      if (statValues[2]) statValues[2].textContent = '$' + fmtUsd(bot.sessionVolume);
      if (statValues[3]) {
        const cpm = bot.costPerMillion ?? 0;
        statValues[3].className = `stat-item-value ${cpm > 0 ? 'neg' : cpm < 0 ? 'pos' : ''}`;
        statValues[3].textContent = '$' + (cpm != null ? cpm.toFixed(2) : '0.00');
      }
      if (statValues[4]) statValues[4].textContent = bot.uptime + 'm';
    }

    // Update action button visibility based on status
    const isActive = bot.status === 'active';
    const isPaused = bot.status === 'paused';

    // Update DN card position data if available
    if (isDeltaNeutral && bot.position) {
      const legA = bot.position.primaryLeg;
      const legB = bot.position.hedgeLeg;
      const posRows = card.querySelectorAll('[style*="border-radius:6px"][style*="border:1px"]');
      if (posRows[0] && legA) {
        const rightDiv = posRows[0].querySelector('[style*="text-align:right"]');
        if (rightDiv) {
          const sizeEl = rightDiv.querySelector('div:first-child');
          const pnlEl = rightDiv.querySelector('div:last-child');
          if (sizeEl) sizeEl.textContent = legA.size.toFixed(6) + ' @ $' + legA.entryPrice.toFixed(2);
          if (pnlEl) {
            pnlEl.textContent = (legA.unrealizedPnl >= 0 ? '+' : '') + '$' + legA.unrealizedPnl.toFixed(3);
            pnlEl.style.color = legA.unrealizedPnl >= 0 ? 'var(--green)' : 'var(--red)';
          }
        }
      }
      if (posRows[1] && legB) {
        const rightDiv = posRows[1].querySelector('[style*="text-align:right"]');
        if (rightDiv) {
          const sizeEl = rightDiv.querySelector('div:first-child');
          const pnlEl = rightDiv.querySelector('div:last-child');
          if (sizeEl) sizeEl.textContent = legB.size.toFixed(6) + ' @ $' + legB.entryPrice.toFixed(2);
          if (pnlEl) {
            pnlEl.textContent = (legB.unrealizedPnl >= 0 ? '+' : '') + '$' + legB.unrealizedPnl.toFixed(3);
            pnlEl.style.color = legB.unrealizedPnl >= 0 ? 'var(--green)' : 'var(--red)';
          }
        }
      }
    }

    const startBtn = card.querySelector('.btn-start-bot');
    const stopBtn = card.querySelector('.btn-stop-bot');
    const pauseBtn = card.querySelector('.btn-pause-bot');
    const resumeBtn = card.querySelector('.btn-resume-bot');
    if (startBtn) startBtn.style.display = (isActive || isPaused) ? 'none' : 'flex';
    if (stopBtn) stopBtn.style.display = (isActive || isPaused) ? 'flex' : 'none';
    if (pauseBtn) pauseBtn.style.display = isActive ? 'flex' : 'none';
    if (resumeBtn) resumeBtn.style.display = isPaused ? 'flex' : 'none';

    // Update sparkline/position widget
    drawSparkline(bot);
  });
}

async function updateAISignals() {
  const activeBots = botsData.filter(b => b.status === 'active');
  await Promise.all(activeBots.map(async bot => {
    try {
      const signal = await fetch(`/api/bots/${bot.id}/ai-signal`).then(r => r.json());
      const state = {
        regime: signal.regime || 'unknown',
        fearGreedIndex: signal.macro?.fearGreedIndex || 50,
        macroSentimentMultiplier: signal.macro?.sizeMultiplier || 1,
        lastSignalDirection: signal.lastSignal?.direction?.toUpperCase() || null,
        effectiveConfidence: signal.lastSignal?.confidence || 0,
        signalPipeline: signal.signalPipeline || [],
        intelligence: signal.intelligence || null,
      };
      renderAIStrip(bot.id, state);
    } catch (err) {
      console.error(`[AI Signal] Update failed for bot ${bot.id}:`, err);
    }
  }));
}

function renderBots() {
  const container = document.getElementById('bot-cards');
  const tmpl = document.getElementById('bot-card-template').innerHTML;
  const oiFarmerTmpl = document.getElementById('delta-neutral-card-template');
  const oiTmpl = oiFarmerTmpl ? oiFarmerTmpl.innerHTML : tmpl;

  let filtered = botsData;
  if (currentFilter === 'active')   filtered = botsData.filter(b => b.status === 'active');
  if (currentFilter === 'inactive') filtered = botsData.filter(b => b.status === 'inactive');

  const label = document.getElementById('bot-count-label');
  if (label) label.textContent = filtered.length + ' bot' + (filtered.length !== 1 ? 's' : '');

  if (!filtered.length) {
    // Different empty states based on context
    if (botsData.length === 0) {
      // No bots at all - show onboarding CTA
      container.innerHTML = `
        <div class="empty-state-hero">
          <div class="empty-state-icon">🤖</div>
          <h2 class="empty-state-title">No bots yet</h2>
          <p class="empty-state-desc">
            Create your first bot to start trading with <strong>SoSoValue Intelligence</strong> 🧠<br>
            <span style="opacity:0.7;font-size:0.9em">Auto-switching strategy based on market regime</span>
          </p>
          <div class="empty-state-features">
            <div class="empty-feature">
              <div class="empty-feature-icon">🧠</div>
              <div class="empty-feature-text">
                <strong>Auto Strategy</strong>
                <span>Engine picks Farm/Trade based on market</span>
              </div>
            </div>
            <div class="empty-feature">
              <div class="empty-feature-icon">📊</div>
              <div class="empty-feature-text">
                <strong>Kelly Sizing</strong>
                <span>Conviction-based position sizing</span>
              </div>
            </div>
            <div class="empty-feature">
              <div class="empty-feature-icon">🛡️</div>
              <div class="empty-feature-text">
                <strong>Risk Aware</strong>
                <span>Stops trading in extreme conditions</span>
              </div>
            </div>
          </div>
          <button class="empty-state-cta" onclick="document.getElementById('btn-create-bot')?.click()">
            <span style="font-size:1.2em">🚀</span> Launch Your First Bot
          </button>
        </div>
      `;
    } else {
      // Has bots but filter shows nothing
      container.innerHTML = `
        <div class="empty-state-filter">
          <div class="empty-state-icon" style="font-size:2.5em">🔍</div>
          <h3 style="margin:0.5rem 0;color:#cbd5e1">No bots match this filter</h3>
          <p style="color:#94a3b8;margin:0.5rem 0">You have ${botsData.length} bot${botsData.length !== 1 ? 's' : ''} total. Try a different filter.</p>
        </div>
      `;
    }
    return;
  }

  // Destroy old sparkline charts before re-render
  Object.values(sparklineCharts).forEach(c => c.destroy());
  Object.keys(sparklineCharts).forEach(k => delete sparklineCharts[k]);

  container.innerHTML = filtered.map(bot => {
    if (bot.botType === 'oi-farmer' || bot.botType === 'delta-neutral' || bot.botType === 'hedge' || bot.botType === 'pair' || bot.oiFarmerState) {
      return buildDeltaNeutralCard(oiTmpl, bot);
    }
    return buildCard(tmpl, bot);
  }).join('');

  // Attach listeners
  container.querySelectorAll('.btn-start-bot').forEach(btn =>
    btn.addEventListener('click', () => startBot(btn.dataset.botId)));
  container.querySelectorAll('.btn-stop-bot').forEach(btn =>
    btn.addEventListener('click', () => stopBot(btn.dataset.botId)));
  container.querySelectorAll('.btn-pause-bot').forEach(btn =>
    btn.addEventListener('click', () => pauseBot(btn.dataset.botId)));
  container.querySelectorAll('.btn-resume-bot').forEach(btn =>
    btn.addEventListener('click', () => resumeBot(btn.dataset.botId)));
  container.querySelectorAll('.btn-delete-bot').forEach(btn =>
    btn.addEventListener('click', () => deleteBot(btn.dataset.botId, btn.dataset.botName)));

  // Draw sparklines after DOM is ready
  requestAnimationFrame(() => filtered.forEach(bot => drawSparkline(bot)));
}

function buildCard(tmpl, bot) {
  const isActive = bot.status === 'active';
  const isPaused = bot.status === 'paused';
  const pnl = bot.sessionPnl ?? 0;
  const vol = bot.sessionVolume ?? 0;
  const costPM = bot.costPerMillion ?? 0;
  const startBalance = bot.sessionStartBalance ?? null;
  const currentBalance = bot.currentBalance ?? null;

  // Wave 3: Mode and Intelligence Mode badges
  const mode = bot.mode || 'farm';
  const intelligenceMode = bot.intelligenceMode || 'manual';
  const modeIcon = mode === 'farm' ? '🚜' : mode === 'trade' ? '📈' : '⚖️';
  const modeLabel = mode.toUpperCase();
  const intelIcon = intelligenceMode === 'auto' ? '🧠' : '🔧';
  const intelLabel = intelligenceMode === 'auto' ? 'AUTO INTELLIGENCE' : 'MANUAL';

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
    .replace(/{statusText}/g,  isActive ? '● LIVE' : isPaused ? '⏸ PAUSED' : '○ IDLE')
    .replace(/{cardClass}/g,   isActive ? 'active' : isPaused ? 'paused' : 'inactive')
    .replace(/{pnlClass}/g,    pnl > 0 ? 'positive' : pnl < 0 ? 'negative' : 'neutral')
    .replace(/{pnlSign}/g,     pnl > 0 ? '+' : pnl < 0 ? '-' : '')
    .replace(/{pnl}/g,         fmtUsd(Math.abs(pnl)))
    .replace(/{volume}/g,      fmtUsd(vol))
    .replace(/{costClass}/g,    costPM > 0 ? 'negative' : costPM < 0 ? 'positive' : '')
    .replace(/{costPerMillion}/g, (costPM != null ? costPM.toFixed(2) : '0.00'))
    .replace(/{uptime}/g,      bot.uptime ?? 0)
    .replace(/{startBalance}/g, startBalance !== null ? fmtUsd(startBalance) : 'N/A')
    .replace(/{currentBalance}/g, currentBalance !== null ? fmtUsd(currentBalance) : 'N/A')
    .replace(/{startDisplay}/g, isActive || isPaused ? 'none' : 'flex')
    .replace(/{stopDisplay}/g,  isActive || isPaused ? 'flex' : 'none')
    .replace(/{pauseDisplay}/g, isActive ? 'flex' : 'none')
    .replace(/{resumeDisplay}/g, isPaused ? 'flex' : 'none')
    // Wave 3: Mode + Intelligence badges
    .replace(/{mode}/g, mode)
    .replace(/{modeIcon}/g, modeIcon)
    .replace(/{modeLabel}/g, modeLabel)
    .replace(/{intelligenceMode}/g, intelligenceMode)
    .replace(/{intelIcon}/g, intelIcon)
    .replace(/{intelLabel}/g, intelLabel)
    .replace(/{regime}/g, '—')
    .replace(/{macro}/g, '—')
    .replace(/{sizeMult}/g, '—')
    .replace(/{direction}/g, '—')
    .replace(/{directionClass}/g, '')
    .replace(/{confidence}/g, '0')
    .replace(/{confidenceText}/g, '—')
    .replace(/{signalAge}/g, 'No signal data');
}

// ── Delta-Neutral Card Builder ────────────────────────────────────────────────────

function buildDeltaNeutralCard(tmpl, bot) {
  const isActive = bot.status === 'active';
  const isPaused = bot.status === 'paused';
  const pnl = bot.sessionPnl ?? 0;
  const pos = bot.position || null;
  const oiState = bot.oiFarmerState || 'IDLE';

  // Badge label: show PAIR TRADING for same-exchange, DELTA-NEUTRAL for cross-exchange
  const isSameExchange = bot.exchangeA && bot.exchangeB && bot.exchangeA === bot.exchangeB;
  const dnBadgeLabel = isSameExchange ? '⚖️ PAIR TRADING' : '🌾 DELTA-NEUTRAL';

  // Leg data
  const legA = pos ? pos.primaryLeg : null;
  const legB = pos ? pos.hedgeLeg : null;
  const deltaExposure = pos ? (pos.deltaExposureUsd || 0).toFixed(2) : '0.00';

  // Hold progress
  let holdElapsed = '0.0';
  let holdProgress = 0;
  const maxHoldHrs = (bot.maxHoldSecs || 172800) / 3600;
  if (pos && pos.entryTimestamp) {
    const elapsedMs = Date.now() - new Date(pos.entryTimestamp).getTime();
    const elapsedHrs = elapsedMs / 3_600_000;
    holdElapsed = elapsedHrs.toFixed(1);
    holdProgress = Math.min(100, (elapsedHrs / maxHoldHrs) * 100);
  }

  // OI metrics
  const oiHoursRaw = bot.totalOiHours || 0;
  const oiHours = oiHoursRaw > 1000 ? (oiHoursRaw / 1000).toFixed(1) + 'K' : oiHoursRaw.toFixed(0);
  const cpm = bot.cpmUsd ? bot.cpmUsd.toFixed(2) : '0.00';
  const dnVolume = bot.sessionVolume ? fmtUsd(bot.sessionVolume) : '0';
  const fundingNet = ((bot.totalFundingReceived || 0) - (bot.totalFundingPaid || 0));
  const fundingStr = (fundingNet >= 0 ? '+' : '') + '$' + Math.abs(fundingNet).toFixed(3);
  const fundingColor = fundingNet >= 0 ? 'var(--green)' : 'var(--red)';

  return tmpl
    .replace(/{id}/g, bot.id)
    .replace(/{name}/g, bot.name)
    .replace(/{exchangeA}/g, (bot.exchangeA || bot.exchange || '').toUpperCase())
    .replace(/{exchangeB}/g, (bot.exchangeB || '').toUpperCase())
    .replace(/{status}/g, bot.status)
    .replace(/{statusText}/g, isActive ? '● LIVE' : isPaused ? '⏸ PAUSED' : '○ IDLE')
    .replace(/{cardClass}/g, isActive ? 'active' : isPaused ? 'paused' : 'inactive')
    .replace(/{dnBadgeLabel}/g, dnBadgeLabel)
    .replace(/{oiState}/g, oiState)
    .replace(/{deltaExposure}/g, deltaExposure)
    // Leg A
    .replace(/{legASide}/g, legA ? legA.side.toUpperCase() : '--')
    .replace(/{legASymbol}/g, legA ? legA.symbol : (bot.symbol || '--'))
    .replace(/{legASize}/g, legA ? legA.size.toFixed(6) : '0')
    .replace(/{legAEntry}/g, legA ? legA.entryPrice.toFixed(2) : '0.00')
    .replace(/{legAPnl}/g, legA ? ((legA.unrealizedPnl >= 0 ? '+' : '') + '$' + legA.unrealizedPnl.toFixed(3)) : '$0.000')
    .replace(/{legAPnlColor}/g, legA && legA.unrealizedPnl >= 0 ? 'var(--green)' : 'var(--red)')
    .replace(/{legAColor}/g, legA && legA.side === 'long' ? '#1db954' : '#e8404a')
    // Leg B
    .replace(/{legBSide}/g, legB ? legB.side.toUpperCase() : '--')
    .replace(/{legBSymbol}/g, legB ? legB.symbol : '--')
    .replace(/{legBSize}/g, legB ? legB.size.toFixed(6) : '0')
    .replace(/{legBEntry}/g, legB ? legB.entryPrice.toFixed(2) : '0.00')
    .replace(/{legBPnl}/g, legB ? ((legB.unrealizedPnl >= 0 ? '+' : '') + '$' + legB.unrealizedPnl.toFixed(3)) : '$0.000')
    .replace(/{legBPnlColor}/g, legB && legB.unrealizedPnl >= 0 ? 'var(--green)' : 'var(--red)')
    .replace(/{legBColor}/g, legB && legB.side === 'long' ? '#1db954' : '#e8404a')
    // Hold progress
    .replace(/{holdElapsed}/g, holdElapsed)
    .replace(/{holdTarget}/g, maxHoldHrs.toFixed(0))
    .replace(/{holdProgress}/g, holdProgress.toFixed(1))
    // PnL
    .replace(/{pnlClass}/g, pnl > 0 ? 'positive' : pnl < 0 ? 'negative' : 'neutral')
    .replace(/{pnlSign}/g, pnl > 0 ? '+' : pnl < 0 ? '-' : '')
    .replace(/{pnl}/g, fmtUsd(Math.abs(pnl)))
    // OI Metrics
    .replace(/{oiHours}/g, oiHours)
    .replace(/{cpm}/g, cpm)
    .replace(/{dnVolume}/g, dnVolume)
    .replace(/{fundingNet}/g, fundingStr)
    .replace(/{fundingColor}/g, fundingColor)
    .replace(/{cycles}/g, String(bot.completedCycles || 0))
    // Actions
    .replace(/{startDisplay}/g, isActive || isPaused ? 'none' : 'flex')
    .replace(/{stopDisplay}/g, isActive || isPaused ? 'flex' : 'none')
    .replace(/{pauseDisplay}/g, isActive ? 'flex' : 'none')
    .replace(/{resumeDisplay}/g, isPaused ? 'flex' : 'none');
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
  const isLight = document.body.classList.contains('light');
  const gridCol   = isLight ? 'rgba(0,0,0,0.06)'   : 'rgba(255,255,255,0.04)';
  const borderCol = isLight ? '#dde2ee'             : '#1e2535';

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

async function pauseBot(botId) {
  const btn = document.querySelector(`.btn-pause-bot[data-bot-id="${botId}"]`);
  if (btn) { btn.disabled = true; btn.textContent = 'Pausing…'; }
  try {
    const r = await fetch(`/api/bots/${botId}/pause`, { method: 'POST' });
    if (!r.ok) { const d = await r.json(); throw new Error(d.error || 'Failed'); }
    await refresh();
  } catch (err) {
    alert('Failed to pause bot: ' + err.message);
    if (btn) { btn.disabled = false; btn.textContent = '⏸ Pause'; }
  }
}

async function resumeBot(botId) {
  const btn = document.querySelector(`.btn-resume-bot[data-bot-id="${botId}"]`);
  if (btn) { btn.disabled = true; btn.textContent = 'Resuming…'; }
  try {
    const r = await fetch(`/api/bots/${botId}/resume`, { method: 'POST' });
    if (!r.ok) { const d = await r.json(); throw new Error(d.error || 'Failed'); }
    await refresh();
  } catch (err) {
    alert('Failed to resume bot: ' + err.message);
    if (btn) { btn.disabled = false; btn.textContent = '▶ Resume'; }
  }
}

async function deleteBot(botId, botName) {
  if (!confirm(`Delete "${botName}"?\n\nThis removes the bot from the manager. Trade history files are kept on disk.`)) return;
  const btn = document.querySelector(`.btn-delete-bot[data-bot-id="${botId}"]`);
  if (btn) { btn.disabled = true; }
  try {
    const r = await fetch(`/api/bots/${botId}`, { method: 'DELETE' });
    if (!r.ok) { const d = await r.json(); throw new Error(d.error || 'Failed'); }
    await refresh();
  } catch (err) {
    alert('Failed to delete bot: ' + err.message);
    if (btn) { btn.disabled = false; }
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
  await updateAISignals();
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
