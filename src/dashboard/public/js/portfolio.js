// Portfolio Page — polls /api/portfolio every 10s, updates stats + charts

(function () {
  'use strict';

  // ── Config ────────────────────────────────────────────────────────────────
  const POLL_INTERVAL = 10000; // 10 seconds
  const MAX_HISTORY = 60;     // 10 minutes of data at 10s intervals

  // ── Time-Series Data ──────────────────────────────────────────────────────
  const historyLabels = [];
  const equityHistory = [];
  const pnlHistory = [];

  // ── Chart Instances ───────────────────────────────────────────────────────
  let chartEquity = null;
  let chartExposure = null;
  let chartPnl = null;

  // ── Helpers ───────────────────────────────────────────────────────────────

  function formatUSD(value) {
    if (value == null || isNaN(value)) return '$0.00';
    return '$' + Number(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function formatPnl(value) {
    if (value == null || isNaN(value)) return '$0.00';
    const sign = value >= 0 ? '+' : '';
    return sign + formatUSD(value).replace('$', '$');
  }

  function formatPnlSigned(value) {
    if (value == null || isNaN(value)) return '$0.00';
    const num = Number(value);
    const sign = num >= 0 ? '+' : '-';
    return sign + '$' + Math.abs(num).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function formatPercent(value) {
    if (value == null || isNaN(value)) return '0%';
    return (Number(value) * 100).toFixed(1) + '%';
  }

  function timeLabel() {
    const now = new Date();
    return now.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  function getChartColors() {
    const style = getComputedStyle(document.documentElement);
    return {
      green: style.getPropertyValue('--green').trim() || '#10b981',
      red: style.getPropertyValue('--red').trim() || '#ef4444',
      blue: style.getPropertyValue('--blue').trim() || '#3b82f6',
      textSecondary: style.getPropertyValue('--text-secondary').trim() || '#94a3b8',
      border: style.getPropertyValue('--border').trim() || '#1e293b',
    };
  }

  // ── Chart Initialization ──────────────────────────────────────────────────

  function initCharts() {
    const colors = getChartColors();

    const commonOptions = {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 300 },
      plugins: { legend: { display: false } },
      scales: {
        x: {
          ticks: { color: colors.textSecondary, maxTicksLimit: 8, font: { size: 10 } },
          grid: { color: colors.border + '40' },
        },
        y: {
          ticks: { color: colors.textSecondary, font: { size: 10 } },
          grid: { color: colors.border + '40' },
        },
      },
    };

    // Equity chart
    const equityCtx = document.getElementById('chart-equity');
    if (equityCtx) {
      chartEquity = new Chart(equityCtx, {
        type: 'line',
        data: {
          labels: historyLabels,
          datasets: [{
            data: equityHistory,
            borderColor: colors.blue,
            backgroundColor: colors.blue + '20',
            fill: true,
            borderWidth: 2,
            pointRadius: 0,
            tension: 0.3,
          }],
        },
        options: {
          ...commonOptions,
          scales: {
            ...commonOptions.scales,
            y: {
              ...commonOptions.scales.y,
              ticks: { ...commonOptions.scales.y.ticks, callback: function (v) { return '$' + v.toLocaleString(); } },
            },
          },
        },
      });
    }

    // Exposure bar chart
    const exposureCtx = document.getElementById('chart-exposure');
    if (exposureCtx) {
      chartExposure = new Chart(exposureCtx, {
        type: 'bar',
        data: {
          labels: ['Long', 'Short'],
          datasets: [{
            data: [0, 0],
            backgroundColor: [colors.green, colors.red],
            borderRadius: 4,
            barThickness: 40,
          }],
        },
        options: {
          ...commonOptions,
          scales: {
            ...commonOptions.scales,
            y: {
              ...commonOptions.scales.y,
              beginAtZero: true,
              ticks: { ...commonOptions.scales.y.ticks, callback: function (v) { return '$' + v.toLocaleString(); } },
            },
          },
        },
      });
    }

    // PnL line chart
    const pnlCtx = document.getElementById('chart-pnl');
    if (pnlCtx) {
      chartPnl = new Chart(pnlCtx, {
        type: 'line',
        data: {
          labels: historyLabels,
          datasets: [{
            data: pnlHistory,
            borderColor: colors.green,
            backgroundColor: colors.green + '20',
            fill: true,
            borderWidth: 2,
            pointRadius: 0,
            tension: 0.3,
          }],
        },
        options: {
          ...commonOptions,
          scales: {
            ...commonOptions.scales,
            y: {
              ...commonOptions.scales.y,
              ticks: { ...commonOptions.scales.y.ticks, callback: function (v) { return '$' + v.toLocaleString(); } },
            },
          },
        },
      });
    }
  }

  // ── Update Hero Stats ─────────────────────────────────────────────────────

  function updateHeroStats(data) {
    // Total Equity
    var eqEl = document.getElementById('portfolio-total-equity');
    if (eqEl) eqEl.textContent = formatUSD(data.totalEquity);

    // Directional Bias
    var biasEl = document.getElementById('portfolio-directional-bias');
    if (biasEl) {
      var bias = data.directionalBias || 0;
      var biasText = 'Neutral';
      if (bias > 0.01) biasText = 'Net Long ' + formatPercent(bias);
      else if (bias < -0.01) biasText = 'Net Short ' + formatPercent(Math.abs(bias));
      biasEl.textContent = biasText;
    }

    // Unrealized PnL
    var pnlEl = document.getElementById('portfolio-unrealized-pnl');
    if (pnlEl) {
      var pnl = data.unrealizedPnl || 0;
      pnlEl.textContent = formatPnlSigned(pnl);
      pnlEl.className = 'hero-stat-value ' + (pnl >= 0 ? 'pnl-positive' : 'pnl-negative');
    }

    // Liquidation Risk
    var riskEl = document.getElementById('portfolio-liq-risk');
    if (riskEl) {
      var risk = (data.liquidationRisk || 'low').toLowerCase();
      var riskLabel = risk.charAt(0).toUpperCase() + risk.slice(1);
      riskEl.textContent = riskLabel;
      var riskColorClass = risk === 'high' ? 'danger' : risk === 'medium' ? 'warning' : 'safe';
      riskEl.className = 'hero-stat-value ' + riskColorClass;
    }
  }

  // ── Update Charts ─────────────────────────────────────────────────────────

  function updateCharts(data) {
    var label = timeLabel();

    // Append to history arrays (cap at MAX_HISTORY)
    historyLabels.push(label);
    equityHistory.push(data.totalEquity || 0);
    pnlHistory.push(data.unrealizedPnl || 0);

    if (historyLabels.length > MAX_HISTORY) {
      historyLabels.shift();
      equityHistory.shift();
      pnlHistory.shift();
    }

    // Update equity chart
    if (chartEquity) {
      chartEquity.data.labels = historyLabels;
      chartEquity.data.datasets[0].data = equityHistory;
      chartEquity.update('none');
    }

    // Update PnL chart
    if (chartPnl) {
      var colors = getChartColors();
      var lastPnl = pnlHistory[pnlHistory.length - 1] || 0;
      chartPnl.data.labels = historyLabels;
      chartPnl.data.datasets[0].data = pnlHistory;
      chartPnl.data.datasets[0].borderColor = lastPnl >= 0 ? colors.green : colors.red;
      chartPnl.data.datasets[0].backgroundColor = (lastPnl >= 0 ? colors.green : colors.red) + '20';
      chartPnl.update('none');
    }

    // Update exposure bar chart
    if (chartExposure) {
      var longExposure = 0;
      var shortExposure = 0;

      if (data.accounts && Array.isArray(data.accounts)) {
        data.accounts.forEach(function (acc) {
          var pnl = acc.pnl || 0;
          if (pnl >= 0) longExposure += Math.abs(acc.balance || 0);
          else shortExposure += Math.abs(acc.balance || 0);
        });
      }

      // If directionalBias is available, approximate from totalEquity
      if (data.directionalBias != null && data.totalEquity) {
        var totalEquity = data.totalEquity || 0;
        var bias = data.directionalBias || 0;
        if (bias > 0) {
          longExposure = totalEquity * (0.5 + bias / 2);
          shortExposure = totalEquity * (0.5 - bias / 2);
        } else {
          longExposure = totalEquity * (0.5 + bias / 2);
          shortExposure = totalEquity * (0.5 - bias / 2);
        }
      }

      chartExposure.data.datasets[0].data = [longExposure, shortExposure];
      chartExposure.update('none');
    }
  }

  // ── Update Account Table ──────────────────────────────────────────────────

  function updateAccountTable(data) {
    var tbody = document.getElementById('portfolio-accounts-tbody');
    var countEl = document.getElementById('portfolio-account-count');
    if (!tbody) return;

    var accounts = data.accounts || [];
    if (countEl) countEl.textContent = accounts.length + ' account' + (accounts.length !== 1 ? 's' : '');

    if (accounts.length === 0) {
      tbody.innerHTML = '<tr><td colspan="5" class="table-empty">No accounts connected</td></tr>';
      return;
    }

    tbody.innerHTML = accounts.map(function (acc) {
      var pnl = acc.pnl || 0;
      var pnlClass = pnl >= 0 ? 'pnl-positive' : 'pnl-negative';
      return '<tr>' +
        '<td>' + (acc.exchange || '—') + '</td>' +
        '<td>' + (acc.label || acc.id || '—') + '</td>' +
        '<td>' + formatUSD(acc.balance) + '</td>' +
        '<td>' + (acc.openPositions || 0) + '</td>' +
        '<td class="' + pnlClass + '">' + formatPnlSigned(pnl) + '</td>' +
        '</tr>';
    }).join('');
  }

  // ── Update Risk Panel ─────────────────────────────────────────────────────

  function updateRiskPanel(data) {
    var risk = data.risk || {};

    // At Risk %
    var atRiskEl = document.getElementById('risk-at-risk-pct');
    if (atRiskEl) {
      var atRisk = risk.atRiskPct || 0;
      atRiskEl.textContent = formatPercent(atRisk);
      atRiskEl.className = 'risk-cell-value ' + (atRisk > 0.5 ? 'danger' : atRisk > 0.25 ? 'warning' : 'safe');
    }

    // Liquidation Buffer
    var bufferEl = document.getElementById('risk-liq-buffer');
    if (bufferEl) {
      var buffer = risk.liquidationBuffer;
      bufferEl.textContent = buffer != null ? formatPercent(buffer) : '—';
      bufferEl.className = 'risk-cell-value ' + (buffer != null && buffer < 0.1 ? 'danger' : buffer != null && buffer < 0.25 ? 'warning' : 'safe');
    }

    // Maintenance Margin
    var marginEl = document.getElementById('risk-maintenance-margin');
    if (marginEl) {
      marginEl.textContent = formatUSD(risk.maintenanceMargin);
    }

    // Average Leverage
    var levEl = document.getElementById('risk-avg-leverage');
    if (levEl) {
      var lev = risk.averageLeverage || 0;
      levEl.textContent = lev.toFixed(1) + 'x';
      levEl.className = 'risk-cell-value ' + (lev > 10 ? 'danger' : lev > 5 ? 'warning' : '');
    }
  }

  // ── Update Timestamp ──────────────────────────────────────────────────────

  function updateTimestamp(data) {
    var el = document.getElementById('portfolio-last-updated');
    if (!el) return;

    if (data.timestamp) {
      var d = new Date(data.timestamp);
      el.textContent = 'Updated ' + d.toLocaleTimeString('en-US', { hour12: true, hour: 'numeric', minute: '2-digit', second: '2-digit' });
    } else {
      el.textContent = 'Updated ' + new Date().toLocaleTimeString('en-US', { hour12: true, hour: 'numeric', minute: '2-digit', second: '2-digit' });
    }
  }

  // ── Poll API ──────────────────────────────────────────────────────────────

  async function fetchPortfolio() {
    try {
      var res = await fetch('/api/portfolio');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      var data = await res.json();

      updateHeroStats(data);
      updateCharts(data);
      updateAccountTable(data);
      updateRiskPanel(data);
      updateTimestamp(data);
    } catch (err) {
      console.error('[Portfolio] fetch error:', err);
      var el = document.getElementById('portfolio-last-updated');
      if (el) el.textContent = 'Connection error — retrying...';
    }
  }

  // ── Init ──────────────────────────────────────────────────────────────────

  function init() {
    initCharts();
    fetchPortfolio();
    setInterval(fetchPortfolio, POLL_INTERVAL);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
