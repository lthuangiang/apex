# Requirements Document

## Overview

Implement TreadFi-style UX improvements across the DRIFT dashboard, inspired by their account management, bot setup UI, and portfolio analytics patterns.

## Feature 1: Account Registry

**Goal:** Connect exchange accounts ONCE, reuse across multiple bots.

### Requirements
1. New `AccountRegistry` class stores encrypted exchange credentials per-tenant
2. Dashboard UI: "Accounts" sidebar section with connected exchanges + live balances
3. Three connect buttons: Connect CEX / Connect DEX Wallet / Connect Perp DEX
4. When creating a bot → "Select Account" dropdown instead of re-entering credentials
5. Per-account: exchange name, truncated address/key, balance, last sync time
6. Stored at `./data/{wallet}/accounts.json` (encrypted)
7. API endpoints: GET /api/accounts, POST /api/accounts, DELETE /api/accounts/:id

## Feature 2: Delta-Neutral Dual-Pane Setup

**Goal:** Side-by-side Long/Short leg configuration (like TreadFi Screenshot 5).

### Requirements
1. When bot type = "delta-neutral": show dual-pane layout instead of single form
2. Left pane (green border): "Long Leg" — Select Account → Select Pair → Leverage
3. Right pane (red border): "Short Leg" — Select Account → Select Pair → Leverage
4. Swap button (↔) between legs
5. Shared config below: Notional, Position Duration, Stop Loss
6. Accounts dropdown populated from Account Registry (Feature 1)
7. Show estimated funding rate per leg (if available from exchange)

## Feature 3: Portfolio Page

**Goal:** Aggregate view of all accounts + positions with charts.

### Requirements
1. New route: GET /portfolio → renders portfolio.ejs
2. Hero stats: Total Equity, Directional Bias (net exposure), Unrealized PnL, Liquidation Risk
3. Charts (Chart.js): Total Equity over time, Notional Exposure, Unrealized PnL
4. Per-account table: exchange, balance, positions count, PnL
5. Liquidation risk panel: margin ratio, buffer, average leverage
6. Polls every 10s for updates

## Feature 4: Pre-Trade Analytics Panel

**Goal:** Show estimated costs/risks BEFORE starting a bot.

### Requirements
1. Panel shown on DN setup page (right sidebar)
2. Per-leg: Available Margin, Target Amount, Estimated Fees, Funding Rate/1h
3. Net Position: Net Sided Funding Rate
4. Updates live as user changes config inputs
5. Also show on MM/Farm bot setup: estimated fee per round-trip, break-even hold time

## Feature 5: UI Improvements (Sliders + Pause)

### Sliders
1. Stop Loss slider (25% — 50% — 75% — 100%) instead of text input
2. Spread/offset slider for MM bot
3. Take Profit slider (or "Uncapped" option)
4. Visual feedback: red zone, yellow zone, green zone

### Pause Button
1. All bot types support PAUSE state (in addition to START/STOP)
2. PAUSE = stop entering new positions, but keep existing positions open (don't close)
3. Dashboard shows "Paused" state with yellow indicator
4. Resume → back to normal operation

## Implementation Order
1. Account Registry (backend + API + basic UI)
2. Pause button (simple state addition)
3. Pre-Trade Analytics panel
4. DN Dual-Pane Setup (depends on Account Registry)
5. Portfolio Page (largest, standalone)
6. Sliders (pure UI, can do anytime)

## Notes
- All UI must support light/dark mode (CSS variables)
- Backward compatible: existing bots with inline credentials still work
- Account Registry is optional — users can still input creds inline if no accounts saved
