// Add Bot Modal - OndoPerps Integration

function openAddBotModal() {
  const modal = document.getElementById('add-bot-modal');
  if (modal) {
    modal.style.display = 'flex';
    document.getElementById('bot-exchange').value = 'sodex';
    updateCredentialForm();
  }
}

function closeAddBotModal() {
  const modal = document.getElementById('add-bot-modal');
  if (modal) modal.style.display = 'none';
}

function updateCredentialForm() {
  const exchange = document.getElementById('bot-exchange').value;
  const credForm = document.getElementById('credential-form');

  let html = '';

  switch(exchange) {
    case 'ondoperps':
      html = `
        <div class="form-group">
          <label>API Key ID *</label>
          <input type="text" id="ondoperps-api-key-id" placeholder="your_api_key_id" required />
        </div>
        <div class="form-group">
          <label>API Key Secret *</label>
          <input type="password" id="ondoperps-api-key-secret" placeholder="your_api_key_secret" required />
        </div>
        <div class="form-group">
          <label>Base URL (optional)</label>
          <input type="text" id="ondoperps-base-url" placeholder="https://api.ondoperps.xyz/v1" />
          <small style="color: var(--text-tertiary); font-size: 0.7rem; margin-top: 0.25rem; display: block;">Leave empty for default</small>
        </div>
      `;
      updateSymbolDropdown(['XAU-PERP', 'AAPL-PERP', 'TSLA-PERP', 'GOOGL-PERP', 'MSFT-PERP', 'AMZN-PERP']);
      break;

    case 'sodex':
      html = `
        <div class="form-group">
          <label>API Key *</label>
          <input type="text" id="sodex-api-key" placeholder="your_api_key" required />
        </div>
        <div class="form-group">
          <label>API Secret *</label>
          <input type="password" id="sodex-api-secret" placeholder="0x..." required />
        </div>
        <div class="form-group">
          <label>Subaccount *</label>
          <input type="text" id="sodex-subaccount" placeholder="0x..." required />
        </div>
      `;
      updateSymbolDropdown(['BTC-USD', 'ETH-USD', 'SOL-USD', 'AVAX-USD']);
      break;

    case 'dango':
      html = `
        <div class="form-group">
          <label>Private Key *</label>
          <input type="password" id="dango-private-key" placeholder="private_key_without_0x" required />
        </div>
        <div class="form-group">
          <label>User Address *</label>
          <input type="text" id="dango-user-address" placeholder="0x..." required />
        </div>
      `;
      updateSymbolDropdown(['BTC-PERP', 'ETH-PERP', 'SOL-PERP']);
      break;

    case 'decibel':
      html = `
        <div class="form-group">
          <label>Private Key *</label>
          <input type="password" id="decibel-private-key" placeholder="ed25519-priv-0x..." required />
        </div>
        <div class="form-group">
          <label>Node API Key</label>
          <input type="text" id="decibel-node-api-key" placeholder="aptoslabs_..." />
        </div>
      `;
      updateSymbolDropdown(['BTC-USD', 'ETH-USD', 'APT-USD']);
      break;

    case 'hibachi':
      html = `
        <div class="form-group">
          <label>API Key *</label>
          <input type="text" id="hibachi-api-key" placeholder="your_api_key" required />
        </div>
        <div class="form-group">
          <label>Account ID *</label>
          <input type="text" id="hibachi-account-id" placeholder="12345" required />
        </div>
        <div class="form-group">
          <label>Account Type *</label>
          <select id="hibachi-account-type" required>
            <option value="trustless">Trustless (ECDSA)</option>
            <option value="exchange_managed">Exchange Managed (HMAC)</option>
          </select>
        </div>
        <div class="form-group" id="hibachi-private-key-group">
          <label>Private Key (for trustless)</label>
          <input type="password" id="hibachi-private-key" placeholder="0x..." />
        </div>
        <div class="form-group" id="hibachi-secret-key-group" style="display:none">
          <label>Secret Key (for exchange_managed)</label>
          <input type="password" id="hibachi-secret-key" placeholder="secret_key" />
        </div>
      `;
      updateSymbolDropdown(['BTC-PERP', 'ETH-PERP', 'SOL-PERP']);
      break;
  }

  credForm.innerHTML = html;

  // Hibachi account type toggle
  if (exchange === 'hibachi') {
    document.getElementById('hibachi-account-type')?.addEventListener('change', (e) => {
      const isTrustless = e.target.value === 'trustless';
      document.getElementById('hibachi-private-key-group').style.display = isTrustless ? 'block' : 'none';
      document.getElementById('hibachi-secret-key-group').style.display = isTrustless ? 'none' : 'block';
    });
  }
}

function updateSymbolDropdown(symbols) {
  const select = document.getElementById('bot-symbol');
  if (!select) return;

  select.innerHTML = symbols.map(s => `<option value="${s}">${s}</option>`).join('');
}

async function submitAddBot() {
  const exchange = document.getElementById('bot-exchange').value;
  const symbol = document.getElementById('bot-symbol').value;
  const name = document.getElementById('bot-name').value.trim();
  const mode = document.getElementById('bot-mode').value;

  if (!name) {
    alert('Bot name is required');
    return;
  }

  let credentials = {};

  // Collect credentials based on exchange
  switch(exchange) {
    case 'ondoperps':
      credentials = {
        apiKeyId: document.getElementById('ondoperps-api-key-id').value.trim(),
        apiKeySecret: document.getElementById('ondoperps-api-key-secret').value.trim(),
        baseUrl: document.getElementById('ondoperps-base-url').value.trim() || undefined
      };
      if (!credentials.apiKeyId || !credentials.apiKeySecret) {
        alert('API Key ID and Secret are required for OndoPerps');
        return;
      }
      break;

    case 'sodex':
      credentials = {
        apiKey: document.getElementById('sodex-api-key').value.trim(),
        apiSecret: document.getElementById('sodex-api-secret').value.trim(),
        subaccount: document.getElementById('sodex-subaccount').value.trim()
      };
      break;

    case 'dango':
      credentials = {
        dangoPrivateKey: document.getElementById('dango-private-key').value.trim(),
        userAddress: document.getElementById('dango-user-address').value.trim()
      };
      break;

    case 'decibel':
      credentials = {
        privateKey: document.getElementById('decibel-private-key').value.trim(),
        nodeApiKey: document.getElementById('decibel-node-api-key')?.value.trim() || ''
      };
      break;

    case 'hibachi':
      const accountType = document.getElementById('hibachi-account-type').value;
      credentials = {
        hibachiApiKey: document.getElementById('hibachi-api-key').value.trim(),
        hibachiAccountId: document.getElementById('hibachi-account-id').value.trim(),
        hibachiAccountType: accountType
      };
      if (accountType === 'trustless') {
        credentials.hibachiPrivateKey = document.getElementById('hibachi-private-key')?.value.trim();
      } else {
        credentials.hibachiSecretKey = document.getElementById('hibachi-secret-key')?.value.trim();
      }
      break;
  }

  const botConfig = {
    id: 'bot-' + Date.now(),
    name,
    exchange,
    symbol,
    mode,
    leverage: parseInt(document.getElementById('bot-leverage').value) || 10,
    orderSizeMin: 10,
    orderSizeMax: 100,
    tradeLogBackend: 'json',
    tradeLogPath: `./data/trades-${Date.now()}.json`,
    autoStart: false,
    tags: [exchange, mode],
    ...credentials
  };

  const submitBtn = document.getElementById('submit-add-bot');
  submitBtn.disabled = true;
  submitBtn.textContent = 'Creating...';

  try {
    const res = await fetch('/api/bots', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(botConfig)
    });

    if (!res.ok) {
      const data = await res.json();
      throw new Error(data.error || 'Failed to create bot');
    }

    closeAddBotModal();
    await refresh();
    alert(`Bot "${name}" created successfully!`);
  } catch (err) {
    alert('Failed to create bot: ' + err.message);
    submitBtn.disabled = false;
    submitBtn.textContent = 'Create Bot';
  }
}

// Setup event listeners
document.addEventListener('DOMContentLoaded', () => {
  // Exchange change
  const exchangeSelect = document.getElementById('bot-exchange');
  if (exchangeSelect) {
    exchangeSelect.addEventListener('change', updateCredentialForm);
  }

  // Close modal on overlay click
  const modal = document.getElementById('add-bot-modal');
  if (modal) {
    modal.addEventListener('click', (e) => {
      if (e.target === modal) closeAddBotModal();
    });
  }

  // Close button
  const closeBtn = document.getElementById('close-add-bot-modal');
  if (closeBtn) {
    closeBtn.addEventListener('click', closeAddBotModal);
  }

  // Submit button
  const submitBtn = document.getElementById('submit-add-bot');
  if (submitBtn) {
    submitBtn.addEventListener('click', submitAddBot);
  }
});
