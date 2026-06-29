# Phase 2 - Frontend Dashboard Integration Plan

## Tổng quan

Dashboard DRIFT có 2 mode:
- **Single-bot mode**: Dashboard đơn bot (legacy)
- **Multi-bot mode**: Manager dashboard với bot cards, sử dụng EJS templates

OndoPerps cần được integrate vào cả 2 modes với credential management và exchange-specific UI.

---

## Architecture Overview

```
Frontend Flow:
┌─────────────────────────────────────────────────────────┐
│ Landing Page (wallet-login.html)                        │
│ - Wallet connect với SIWE                              │
│ - Auth token generation                                 │
└─────────────────┬───────────────────────────────────────┘
                  │
                  ▼
┌─────────────────────────────────────────────────────────┐
│ Manager Dashboard (manager.ejs)                         │
│ - Bot cards grid                                        │
│ - Add bot modal → Exchange selection                    │
│   - SoDEX, Dango, Decibel, Hibachi, **OndoPerps**     │
└─────────────────┬───────────────────────────────────────┘
                  │
                  ▼
┌─────────────────────────────────────────────────────────┐
│ Add Bot Modal                                           │
│ - Exchange-specific credential forms                    │
│ - **OndoPerps form**: API Key ID + Secret              │
│ - Symbol selection (XAU-PERP, AAPL-PERP, etc)          │
└─────────────────┬───────────────────────────────────────┘
                  │
                  ▼
┌─────────────────────────────────────────────────────────┐
│ Backend: POST /api/bots                                 │
│ - Validate credentials                                  │
│ - Test connection via adapter.connect()                 │
│ - Store encrypted credentials                           │
│ - Create bot instance                                   │
└─────────────────┬───────────────────────────────────────┘
                  │
                  ▼
┌─────────────────────────────────────────────────────────┐
│ Bot Card (bot-cards.ejs)                                │
│ - Exchange badge: "ondoperps"                           │
│ - Symbol display: XAU-PERP                              │
│ - PnL, stats, controls                                  │
└─────────────────────────────────────────────────────────┘
```

---

## Phase 2.1: Backend API Routes (Server-side)

### Files cần sửa:

#### 1. `src/dashboard/server.ts`

**Vị trí**: Manager routes section (~line 400+)

**Thêm validation cho OndoPerps credentials**:

```typescript
// Trong POST /api/bots route
case 'ondoperps': {
  const { apiKeyId, apiKeySecret, baseUrl } = credentials;
  if (!apiKeyId || !apiKeySecret) {
    return res.status(400).json({ 
      error: 'Missing OndoPerps credentials. Required: apiKeyId, apiKeySecret' 
    });
  }
  // Test connection
  try {
    const testAdapter = new OndoPerpsAdapter({ apiKeyId, apiKeySecret, baseUrl });
    await testAdapter.connect();
    console.log('[Dashboard] OndoPerps connection test passed');
  } catch (err: any) {
    return res.status(400).json({ 
      error: 'OndoPerps connection failed: ' + err.message 
    });
  }
  break;
}
```

**Thời gian**: 30 phút

---

## Phase 2.2: Frontend - Add Bot Modal

### Files cần sửa:

#### 2. `src/dashboard/public/manager-dashboard.js`

**Vị trí**: Exchange dropdown và credential form logic

**A. Thêm OndoPerps vào exchange dropdown**:

```javascript
// Trong buildAddBotModal() hoặc tương tự
const exchangeOptions = `
  <option value="sodex">SoDEX</option>
  <option value="dango">Dango</option>
  <option value="decibel">Decibel</option>
  <option value="hibachi">Hibachi</option>
  <option value="ondoperps">OndoPerps</option>
`;
```

**B. Thêm credential form cho OndoPerps**:

```javascript
// Trong renderCredentialForm(exchange) hoặc tương tự
case 'ondoperps':
  return `
    <div class="form-group">
      <label>API Key ID</label>
      <input type="text" id="ondoperps-api-key-id" 
             placeholder="your_api_key_id" required />
    </div>
    <div class="form-group">
      <label>API Key Secret</label>
      <input type="password" id="ondoperps-api-key-secret" 
             placeholder="your_api_key_secret" required />
    </div>
    <div class="form-group">
      <label>Base URL (optional)</label>
      <input type="text" id="ondoperps-base-url" 
             placeholder="https://api.ondoperps.xyz/v1" />
      <small>Leave empty for default</small>
    </div>
  `;
```

**C. Collect credentials khi submit**:

```javascript
// Trong submitAddBot() hoặc tương tự
case 'ondoperps':
  credentials = {
    apiKeyId: document.getElementById('ondoperps-api-key-id').value.trim(),
    apiKeySecret: document.getElementById('ondoperps-api-key-secret').value.trim(),
    baseUrl: document.getElementById('ondoperps-base-url').value.trim() || undefined
  };
  break;
```

**D. Symbol dropdown cho OndoPerps**:

```javascript
// Trong renderSymbolDropdown(exchange) hoặc fetchSymbols(exchange)
case 'ondoperps':
  // OndoPerps supports RWA assets
  return `
    <option value="XAU-PERP">XAU-PERP (Gold)</option>
    <option value="AAPL-PERP">AAPL-PERP (Apple Stock)</option>
    <option value="TSLA-PERP">TSLA-PERP (Tesla Stock)</option>
    <option value="GOOGL-PERP">GOOGL-PERP (Google Stock)</option>
  `;
  // Or fetch dynamically via GET /api/exchanges/ondoperps/symbols
```

**Thời gian**: 1-2 giờ

---

## Phase 2.3: Bot Card Display

### Files cần sửa:

#### 3. `src/dashboard/views/partials/bot-cards.ejs`

**Không cần sửa** - Template đã generic, chỉ cần ensure:

- Exchange badge hiển thị "ondoperps"
- Symbol hiển thị đúng (XAU-PERP, etc)

#### 4. `src/dashboard/public/css/manager.css` (nếu có)

**Thêm styling cho OndoPerps badge**:

```css
.exchange-badge.ondoperps {
  background: linear-gradient(135deg, #6B46C1 0%, #9333EA 100%);
  color: white;
  text-transform: uppercase;
  font-size: 0.65rem;
  font-weight: 600;
  padding: 0.25rem 0.5rem;
  border-radius: 4px;
}
```

**Thời gian**: 15 phút

---

## Phase 2.4: Symbol/Market Fetching API

### Files cần tạo/sửa:

#### 5. `src/dashboard/server.ts`

**Thêm route mới**:

```typescript
// GET /api/exchanges/:exchange/symbols
this.app.get('/api/exchanges/:exchange/symbols', 
  this._authMiddleware, 
  async (req, res) => {
    const { exchange } = req.params;
    
    if (exchange === 'ondoperps') {
      // Return cached or fetch from adapter
      try {
        const adapter = new OndoPerpsAdapter({
          apiKeyId: 'temp', // Or use credentials from request
          apiKeySecret: 'temp'
        });
        await adapter.fetchMarkets();
        const symbols = adapter.supportedSymbols;
        res.json({ symbols });
      } catch (err) {
        res.status(500).json({ error: 'Failed to fetch symbols' });
      }
    } else {
      res.status(404).json({ error: 'Exchange not supported' });
    }
});
```

**Hoặc hardcode symbols**:

```typescript
if (exchange === 'ondoperps') {
  res.json({ 
    symbols: ['XAU-PERP', 'AAPL-PERP', 'TSLA-PERP', 'GOOGL-PERP'] 
  });
}
```

**Thời gian**: 30 phút

---

## Phase 2.5: Credential Store Updates

### Files cần sửa:

#### 6. `src/bot/CredentialStore.ts`

**Ensure BotCredentials interface hỗ trợ OndoPerps**:

```typescript
export interface BotCredentials {
  // Existing fields...
  
  // OndoPerps
  apiKeyId?: string;
  apiKeySecret?: string;
  baseUrl?: string;
}
```

**Không cần sửa nếu interface đã flexible** (check file hiện tại).

**Thời gian**: 10 phút

---

## Phase 2.6: Landing Page Updates (Optional)

### Files cần sửa:

#### 7. `src/dashboard/public/landing.html`

**Thêm OndoPerps vào danh sách exchanges được hỗ trợ**:

```html
<div class="exchange-logos">
  <img src="/assets/sodex.png" alt="SoDEX" />
  <img src="/assets/dango.png" alt="Dango" />
  <img src="/assets/decibel.png" alt="Decibel" />
  <img src="/assets/hibachi.png" alt="Hibachi" />
  <img src="/assets/ondoperps.png" alt="OndoPerps" />
</div>
```

**Thêm RWA mention vào features**:

```html
<li>✅ Trade RWA (Gold, Stocks) on OndoPerps</li>
```

**Thời gian**: 15 phút

---

## Phase 2.7: Bot Config Validation

### Files đã có validation:

#### 8. `src/bot/loadBotConfigs.ts`

**Check validateBotConfig()** - ensure exchange validation includes 'ondoperps':

```typescript
const validExchanges = ['sodex', 'dango', 'decibel', 'hibachi', 'ondoperps'];
if (!validExchanges.includes(config.exchange.toLowerCase())) {
  throw new Error(`Invalid exchange: ${config.exchange}`);
}
```

**Thời gian**: 10 phút

---

## Phase 2.8: Testing Flow

### Manual Test Checklist:

1. **Start dashboard**:
   ```bash
   npm start
   ```

2. **Login với wallet**:
   - Access `http://localhost:3000`
   - Connect wallet

3. **Add OndoPerps bot**:
   - Click "Add Bot"
   - Select "OndoPerps" exchange
   - Fill credentials (from `.env` or test account)
   - Select symbol: XAU-PERP
   - Set leverage, budget
   - Submit

4. **Verify bot card**:
   - Check exchange badge shows "ondoperps"
   - Check symbol shows "XAU-PERP"
   - Check connection status

5. **Start bot**:
   - Click "Start Bot"
   - Monitor logs for OndoPerps API calls

6. **Test bot controls**:
   - Stop bot
   - View details page
   - Delete bot

**Thời gian**: 1 giờ

---

## Summary: Files to Create/Modify

### Backend (Server):
1. ✅ `src/adapters/ondoperps_adapter.ts` - **Already done in Phase 1**
2. ✅ `src/bot/adapterFactory.ts` - **Already done in Phase 1**
3. ✏️ `src/dashboard/server.ts` - Add validation + symbols API (~50 lines)
4. ✏️ `src/bot/loadBotConfigs.ts` - Add 'ondoperps' to validation (~5 lines)
5. ✏️ `src/bot/CredentialStore.ts` - Ensure interface supports OndoPerps (check only)

### Frontend (UI):
6. ✏️ `src/dashboard/public/manager-dashboard.js` - Add exchange dropdown, credential form, submit logic (~100 lines)
7. ✏️ `src/dashboard/public/css/manager.css` - Add badge styling (~10 lines)
8. ✏️ `src/dashboard/public/landing.html` - Update features/logos (~20 lines)

### Assets (Optional):
9. 🆕 `src/dashboard/public/assets/ondoperps.png` - Exchange logo

### Total Implementation Time: **4-5 giờ**

---

## Detailed Step-by-Step Implementation Order

### Step 1: Backend Validation (30 min)
- Sửa `server.ts` - thêm OndoPerps case trong POST /api/bots
- Sửa `loadBotConfigs.ts` - thêm 'ondoperps' vào validExchanges

### Step 2: Symbols API (30 min)
- Sửa `server.ts` - thêm GET /api/exchanges/:exchange/symbols

### Step 3: Frontend Form (1.5 hrs)
- Sửa `manager-dashboard.js`:
  - Exchange dropdown
  - Credential form
  - Symbol dropdown
  - Submit logic

### Step 4: Styling (15 min)
- Sửa `manager.css` - badge styling

### Step 5: Landing Page (15 min)
- Sửa `landing.html` - features + logos

### Step 6: Manual Testing (1 hr)
- Test full flow: add bot → start → stop → delete

### Step 7: Edge Cases (30 min)
- Test invalid credentials
- Test connection failures
- Test with no markets available

---

## Implementation Notes

### Key Points:
1. **RWA symbols**: OndoPerps uses XAU, AAPL, not BTC/ETH
2. **Credential format**: API Key ID + Secret (different from other exchanges)
3. **No WebSocket**: OndoPerps adapter doesn't implement WS subscriptions
4. **Market cache**: Adapter caches market info on connect()

### Edge Cases to Handle:
- Invalid API Key ID/Secret → show clear error
- Connection timeout → retry with exponential backoff
- No supported symbols → disable bot creation
- Rate limiting → show warning in UI

### Security:
- Credentials are encrypted in `CredentialStore`
- Never log API secrets
- Use HTTPS in production

---

## Phase 3 Preview (Future)

After Phase 2 complete:
- [ ] Real-time position updates via polling
- [ ] OndoPerps-specific metrics (RWA spread, etc)
- [ ] Take Profit / Stop Loss UI
- [ ] PostOnly/ReduceOnly toggles
- [ ] Backtest support for RWA data

---

## Ready to Implement?

Files needed:
- ✅ Phase 1 (Core adapter) - **DONE**
- ⏳ Phase 2 (Frontend integration) - **READY TO START**

Confirm to proceed with implementation! 🚀
