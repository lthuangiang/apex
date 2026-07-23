// Accounts Sidebar — fetch, render, connect, delete

const EXCHANGE_ABBREVS = {
  sodex: 'SOD',
  decibel: 'DEC',
  dango: 'DAN',
  hibachi: 'HIB',
  ondoperps: 'OND',
  perpl: 'PER',
};

let accountsData = [];

// ── Helpers ───────────────────────────────────────────────────────────────────

function truncateKey(key) {
  if (!key || key.length <= 10) return key || '';
  return key.slice(0, 6) + '...' + key.slice(-4);
}

function getExchangeClass(exchange) {
  const ex = (exchange || '').toLowerCase();
  return `exchange-${ex}`;
}

function getExchangeAbbrev(exchange) {
  const ex = (exchange || '').toLowerCase();
  return EXCHANGE_ABBREVS[ex] || ex.slice(0, 3).toUpperCase();
}

// ── Fetch Accounts ────────────────────────────────────────────────────────────

async function fetchAccounts() {
  try {
    const res = await fetch('/api/accounts');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    accountsData = data.accounts || [];
  } catch (err) {
    console.error('[Accounts] fetch error:', err);
    accountsData = [];
  }
  renderAccountsSidebar();
}

// ── Render Sidebar ────────────────────────────────────────────────────────────

function renderAccountsSidebar() {
  const loadingEl = document.getElementById('accounts-sidebar-loading');
  const listEl = document.getElementById('accounts-sidebar-list');
  const emptyEl = document.getElementById('accounts-sidebar-empty');
  const countEl = document.getElementById('accounts-sidebar-count');

  if (!listEl) return; // sidebar not in DOM

  // Hide loading
  if (loadingEl) loadingEl.style.display = 'none';

  if (accountsData.length === 0) {
    listEl.style.display = 'none';
    if (emptyEl) emptyEl.style.display = 'block';
    if (countEl) countEl.textContent = '';
  } else {
    if (emptyEl) emptyEl.style.display = 'none';
    listEl.style.display = 'flex';
    if (countEl) countEl.textContent = accountsData.length + ' connected';

    listEl.innerHTML = accountsData.map(account => {
      const abbrev = getExchangeAbbrev(account.exchange);
      const colorClass = getExchangeClass(account.exchange);
      const key = truncateKey(account.truncatedKey || account.address || account.apiKey || '');
      const balance = account.balanceUsd != null ? '$' + Number(account.balanceUsd).toFixed(2) : (account.balance != null ? '$' + Number(account.balance).toFixed(2) : '');
      const label = account.label || account.exchange || 'Account';

      // Daily change: SOD vs current
      let changeHtml = '';
      if (account.todayChange != null && account.todayChange !== 0) {
        const sign = account.todayChange >= 0 ? '+' : '';
        const cls = account.todayChange >= 0 ? 'positive' : 'negative';
        changeHtml = `<div class="accounts-sidebar-change ${cls}">${sign}$${Math.abs(account.todayChange).toFixed(2)}</div>`;
      } else if (account.sodBalance != null) {
        changeHtml = `<div class="accounts-sidebar-change" style="color:var(--text-tertiary)">$0.00</div>`;
      }

      return `
        <div class="accounts-sidebar-item" data-account-id="${account.id}">
          <div class="accounts-sidebar-icon ${colorClass}">${abbrev}</div>
          <div class="accounts-sidebar-info">
            <div class="accounts-sidebar-label">${label}</div>
            <div class="accounts-sidebar-key">${key}</div>
          </div>
          <div class="accounts-sidebar-balance-group">
            ${balance ? `<div class="accounts-sidebar-balance">${balance}</div>` : ''}
            ${changeHtml}
          </div>
          <button class="accounts-sidebar-delete-btn" onclick="event.stopPropagation(); deleteAccount('${account.id}')" title="Disconnect account">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <line x1="18" y1="6" x2="6" y2="18"></line>
              <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>
          </button>
        </div>
      `;
    }).join('');
  }
}

// ── Connect Modal ─────────────────────────────────────────────────────────────

function openConnectModal(type) {
  const modal = document.getElementById('connect-account-modal');
  if (modal) {
    // Set default type if provided
    const typeSelector = modal.querySelector('[name="accountType"]') || modal.querySelector('#account-type-selector');
    if (typeSelector && type) {
      typeSelector.value = type;
    }
    modal.style.display = 'flex';
    modal.classList.add('active');
  }
}

function closeConnectModal() {
  const modal = document.getElementById('connect-account-modal');
  if (modal) {
    modal.style.display = 'none';
    modal.classList.remove('active');
  }
}

// ── Delete Account ────────────────────────────────────────────────────────────

async function deleteAccount(accountId) {
  const account = accountsData.find(a => a.id === accountId);
  const label = account ? account.label || account.exchange : 'this account';

  if (!confirm(`Disconnect "${label}"?\n\nBots using this account will need credentials re-entered.`)) return;

  try {
    const res = await fetch(`/api/accounts/${accountId}`, { method: 'DELETE' });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `HTTP ${res.status}`);
    }
    await refreshAccounts();
  } catch (err) {
    console.error('[Accounts] delete error:', err);
    alert('Failed to disconnect account: ' + err.message);
  }
}

// ── Refresh ───────────────────────────────────────────────────────────────────

async function refreshAccounts() {
  await fetchAccounts();
}

// ── Init ──────────────────────────────────────────────────────────────────────

function initAccounts() {
  // Fetch accounts on page load
  fetchAccounts();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initAccounts);
} else {
  initAccounts();
}
