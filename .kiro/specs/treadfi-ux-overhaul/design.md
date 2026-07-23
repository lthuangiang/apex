# Design Document: TreadFi-Inspired UX Overhaul

## Overview

This overhaul brings TreadFi-style UX patterns to the DRIFT dashboard: reusable exchange accounts, visual dual-pane Delta-Neutral setup, portfolio analytics, pre-trade cost estimation, slider controls, and a PAUSE bot state. The existing AccountRegistry backend class and API routes (already implemented in src/bot/AccountRegistry.ts and server.ts) serve as the foundation.

---

## Architecture

### System Context

```
Dashboard (Express + EJS)
├── Accounts UI (sidebar)
├── Bot Setup (DN dual-pane + standard wizard)
├── Portfolio (new page)
└── Bot Detail Pages (existing + pause state)

API Layer
├── /api/accounts (existing)
├── /api/bots (existing)
├── /api/portfolio (new)
├── /api/bots/:id/pause (new)
├── /api/bots/:id/resume (new)
└── /api/exchanges/:ex/funding-rate (new)

Backend Services
├── AccountRegistry (existing - src/bot/AccountRegistry.ts)
├── BotManager (existing)
├── Adapters (existing)
└── TenantContext (existing - has accountRegistry field)
```

---

## Feature 1: Account Registry UI

### Backend Status: ALREADY IMPLEMENTED
- `src/bot/AccountRegistry.ts` — encrypted AES-256-GCM storage, add/list/delete/getCredentials
- API routes at `/api/accounts` (GET, POST, DELETE) in `dashboard/server.ts`
- TenantContext already has `accountRegistry` field

### Frontend (New Work)
- **Accounts sidebar panel** in `manager.ejs` — shows connected accounts with balance
- **Connect Account modal** — exchange picker + credentials form, calls POST /api/accounts
- **Bot creation wizard update** — "Select Account" dropdown replaces manual credential entry when accounts exist. Fallback: inline credentials still work if no accounts saved.

### Data Flow
```
Connect: POST /api/accounts { label, type, credentials } → AccountRegistry.add() → encrypt+save
List:    GET /api/accounts → returns AccountEntry[] (id, exchange, truncatedKey, balance)
Bot:     User selects account → GET /api/accounts/:id/credentials → create adapter
```

---

## Feature 2: Delta-Neutral Dual-Pane Setup

### Layout (replaces current flat form for DN bots)
```
┌─────────────────────────────────────────────────────┐
│                 Accounts & Pairs                      │
│  ┌─────────────────┐   ↔   ┌─────────────────────┐ │
│  │ Long (green)    │       │ Short (red)          │ │
│  │ [Account ▼]     │       │ [Account ▼]          │ │
│  │ [Pair ▼]   1x   │       │ [Pair ▼]   1x       │ │
│  └─────────────────┘       └─────────────────────┘ │
│                                                      │
│  Notional: $___   Duration: __ min   Stop Loss: __% │
│                                                      │
│  [─────────── Start Trading ───────────]            │
├─────────────────────────────────────────────────────┤
│  Positions │ Orders │ History │ Analytics            │
└─────────────────────────────────────────────────────┘
```

### Implementation
- New EJS partial or section within the wizard Step 3 for botType = 'delta-neutral'
- Each pane loads accounts from /api/accounts, symbols from /api/exchanges/{exchange}/symbols
- Swap button (↔) switches Long/Short assignments
- Pre-Trade Analytics panel attached to right sidebar

---

## Feature 3: Portfolio Page

### Route: GET /portfolio → renders views/portfolio.ejs

### Layout
```
Hero Stats: Total Equity | Directional Bias | Unrealized PnL | Liquidation Risk
Charts: Total Equity over time | Notional Exposure | Unrealized PnL
Table: Per-account (exchange, balance, positions, PnL)
Risk Panel: Margin Ratio, Buffer, Average Leverage
```

### API: GET /api/portfolio
Aggregates from:
- AccountRegistry.list() (balances per account)
- BotManager.getAllBots() (positions from running bots)
- Computes: total equity, net exposure, directional bias, liquidation estimates

Frontend polls every 10s for updates.

---

## Feature 4: Pre-Trade Analytics Panel

### Shows on DN setup page (right sidebar)
```
Long Leg:
  - Available Margin (from account balance)
  - Target Amount (notional / price)
  - Estimated Fees (notional × feeRate × 2)
  - Funding Rate/1h

Short Leg:
  - Same fields mirrored

Net Position:
  - Net Sided Funding Rate / 1h
  - Estimated hourly cost
```

### New API: GET /api/exchanges/:exchange/funding-rate?symbol=X
Returns current funding rate if adapter supports it (otherwise null).

---

## Feature 5: Pause State

### State Machine
```
Current:  RUNNING ↔ STOPPED
New:      RUNNING → PAUSED → RUNNING (resume)
          RUNNING → STOPPED
          PAUSED → STOPPED
```

### Behavior
- PAUSED: tick loop runs but skips new entry logic. Existing positions monitored.
- BotSharedState.botStatus: 'RUNNING' | 'STOPPED' | 'PAUSED'
- All bot types support pause (BotInstance, PairBot, DeltaNeutralBot)
- API: POST /api/bots/:id/pause, POST /api/bots/:id/resume
- Dashboard: yellow "PAUSED" badge, contextual Pause/Resume buttons

### Per-Bot Implementation
- DeltaNeutralBot._tickIdle(): if PAUSED → return early (no new entries)
- DeltaNeutralBot._tickActive(): still runs (exit/rebalance still work)
- BotInstance/Watcher: if PAUSED → skip _handleIdleFarm/_handleIdleTrade

---

## Feature 6: Sliders

### CSS Component (pure CSS + vanilla JS, no library)
- Custom range input with color zones (red/yellow/green)
- Shows numeric value next to slider handle
- Updates hidden input for form submission
- Respects dark/light mode via CSS variables

### Applied To
- Stop Loss: 0-100% (red zone low, green high)
- Take Profit: with "Uncapped" toggle
- Spread/Offset: 0-20 bps for MM bot

---

## Files Changed / Created

### New Files
| File | Purpose |
|------|---------|
| src/dashboard/views/portfolio.ejs | Portfolio page |
| src/dashboard/views/partials/accounts-sidebar.ejs | Accounts panel |
| src/dashboard/views/partials/dn-setup-pane.ejs | DN dual-pane |
| src/dashboard/views/partials/pre-trade-analytics.ejs | Analytics panel |
| src/dashboard/public/css/sliders.css | Slider styles |
| src/dashboard/public/js/portfolio.js | Portfolio client logic |
| src/dashboard/public/js/accounts.js | Account management logic |

### Modified Files
| File | Changes |
|------|---------|
| src/bot/BotSharedState.ts | Add 'PAUSED' to botStatus |
| src/bot/BotInstance.ts | Pause support |
| src/bot/PairBot.ts | Pause support |
| src/bot/DeltaNeutralBot.ts | Pause support |
| src/dashboard/server.ts | /portfolio, /api/portfolio, pause/resume routes, funding-rate route |
| src/dashboard/views/manager.ejs | Accounts sidebar, pause buttons, sliders, DN pane |
| src/dashboard/public/js/manager-dashboard.js | Account dropdown, pause state |
