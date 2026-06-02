// Backtest UI Controller
(function() {
  let currentRunId = null;
  let eventSource = null;

  const btn = document.getElementById('run-backtest-btn');
  const progress = document.getElementById('backtest-progress');
  const results = document.getElementById('backtest-results');
  const progressFill = document.getElementById('progress-fill');
  const progressText = document.getElementById('progress-text');

  if (!btn) return;

  btn.addEventListener('click', runBacktest);

  async function runBacktest() {
    const start = document.getElementById('backtest-start').value;
    const end = document.getElementById('backtest-end').value;
    const balance = Number(document.getElementById('backtest-balance').value);

    if (!start || !end) {
      alert('Please select start and end dates');
      return;
    }

    // Convert datetime-local to ISO date (YYYY-MM-DD)
    const startDate = new Date(start).toISOString().split('T')[0];
    const endDate = new Date(end).toISOString().split('T')[0];

    console.log('[Backtest] Date range:', startDate, 'to', endDate);

    const botId = window.location.pathname.split('/').pop();

    btn.disabled = true;
    progress.style.display = 'block';
    results.style.display = 'none';

    try {
      // Fetch bot list to get symbol
      const botsRes = await fetch('/api/bots');
      if (!botsRes.ok) throw new Error('Failed to fetch bots');
      const bots = await botsRes.json();
      const bot = bots.find(b => b.id === botId);
      if (!bot) throw new Error('Bot not found in list');

      // Fetch bot config
      const configRes = await fetch(`/api/bots/${botId}/config`);
      if (!configRes.ok) throw new Error('Failed to fetch bot config');
      const configData = await configRes.json();

      console.log('[Backtest] Bot:', bot);
      console.log('[Backtest] Config:', configData);

      const res = await fetch('/api/backtest/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          botId,
          botConfig: {
            ...configData.config,
            symbol: bot.symbol,
            exchange: bot.exchange
          },
          from: startDate,
          to: endDate,
          interval: '5m',
          initialBalance: balance,
          makerFeeBps: 2,
          takerFeeBps: 5,
          slippageBps: 2,
          dataSource: 'exchange_api',
          fillMode: 'realistic'
        })
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.errors?.[0]?.message || data.error || 'Backtest failed');
      }

      currentRunId = data.runId;
      streamProgress(currentRunId);
    } catch (err) {
      alert('Error: ' + err.message);
      btn.disabled = false;
      progress.style.display = 'none';
    }
  }

  function streamProgress(runId) {
    eventSource = new EventSource(`/api/backtest/stream/${runId}`);

    eventSource.addEventListener('message', (e) => {
      console.log('[Backtest] SSE event:', e.data);
      const data = JSON.parse(e.data);

      if (data.type === 'progress') {
        const pct = data.percentComplete || 0;
        progressFill.style.width = pct + '%';
        progressText.textContent = `Processing: ${pct.toFixed(0)}%`;
      } else if (data.type === 'complete') {
        console.log('[Backtest] Complete, result:', data.result);
        eventSource.close();
        displayResults(data.result);
      } else if (data.type === 'error') {
        console.error('[Backtest] Error:', data.message);
        eventSource.close();
        alert('Backtest error: ' + data.message);
        btn.disabled = false;
        progress.style.display = 'none';
      }
    });

    eventSource.onerror = (err) => {
      console.error('[Backtest] SSE error:', err);
      eventSource.close();
      btn.disabled = false;
      progress.style.display = 'none';
    };
  }

  function displayResults(result) {
    btn.disabled = false;
    progress.style.display = 'none';
    results.style.display = 'block';

    const totalTrades = result.metrics.totalTrades;
    document.getElementById('result-trades').textContent = totalTrades;
    document.getElementById('result-winrate').textContent = (result.metrics.winRate * 100).toFixed(1) + '%';
    document.getElementById('result-pnl').textContent = '$' + result.metrics.totalPnl.toFixed(2);
    document.getElementById('result-sharpe').textContent = result.metrics.sharpeRatio.toFixed(2);

    // Show warning if no trades
    if (totalTrades === 0) {
      const warning = document.createElement('div');
      warning.style.cssText = 'background:var(--obg);border:1px solid var(--orange);border-radius:var(--rx);padding:1rem;margin-bottom:1rem;color:var(--text1);font-size:.75rem';
      warning.innerHTML = '<strong>⚠️ No trades executed</strong><br>The strategy did not generate any signals during this period. Try:<br>• Extending the date range<br>• Checking if market data is available for this period<br>• Reviewing bot configuration';
      results.insertBefore(warning, results.firstChild);
    }

    renderChart(result.equityCurve);
  }

  function renderChart(curve) {
    const canvas = document.getElementById('equity-chart');
    const ctx = canvas.getContext('2d');

    if (window.backtestChart) {
      window.backtestChart.destroy();
    }

    window.backtestChart = new Chart(ctx, {
      type: 'line',
      data: {
        labels: curve.map(p => new Date(p.timestamp).toLocaleString()),
        datasets: [{
          label: 'Equity',
          data: curve.map(p => p.equity),
          borderColor: '#4CAF50',
          backgroundColor: 'rgba(76, 175, 80, 0.1)',
          tension: 0.1
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } }
      }
    });
  }
})();
