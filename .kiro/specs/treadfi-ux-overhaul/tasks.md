# Implementation Tasks: TreadFi UX Overhaul

## Task 1: Pause State (Foundation)
- [x] 1.1. Update `BotSharedState.botStatus` type to `'RUNNING' | 'STOPPED' | 'PAUSED'`
- [x] 1.2. Add `pause()` and `resume()` methods to `BotInstance` class
- [x] 1.3. Add `pause()` and `resume()` methods to `PairBot` class
- [x] 1.4. Add `pause()` and `resume()` methods to `DeltaNeutralBot` class
- [x] 1.5. In `BotInstance` Watcher: skip entry logic when PAUSED (keep exit/monitoring active)
- [x] 1.6. In `PairBot._tickIdle()`: return early when PAUSED
- [x] 1.7. In `DeltaNeutralBot._tickIdle()`: return early when PAUSED
- [x] 1.8. Add API routes: `POST /api/bots/:id/pause` and `POST /api/bots/:id/resume` in server.ts
- [x] 1.9. Update manager-dashboard.js: show Pause/Resume buttons based on bot state (Start visible when STOPPED, Pause visible when RUNNING, Resume visible when PAUSED, Stop visible when RUNNING or PAUSED)
- [x] 1.10. Update bot card template: yellow "PAUSED" status pill
- [x] 1.11. Update delta-neutral-detail.ejs: add Pause/Resume button with correct state logic
- [x] 1.12. Verify: `npx tsc --noEmit` passes with zero errors

## Task 2: Account Registry UI
- [x] 2.1. Create `src/dashboard/views/partials/accounts-sidebar.ejs` — sidebar panel showing connected accounts (exchange icon, label, truncated key, balance)
- [x] 2.2. Include accounts-sidebar partial in `manager.ejs` above the bot-cards section
- [x] 2.3. Create `src/dashboard/public/js/accounts.js` — client-side logic: fetch accounts, render sidebar, open connect modal
- [x] 2.4. Create "Connect Account" modal in manager.ejs — exchange selector, credential inputs per exchange (reuse patterns from bot wizard), label field, type selector (CEX/DEX/Perp DEX)
- [x] 2.5. Wire modal submit to `POST /api/accounts` and refresh sidebar on success
- [x] 2.6. Add delete button per account (calls `DELETE /api/accounts/:id`)
- [x] 2.7. Update bot creation wizard Step 1 (credentials): if accounts exist, show "Select Account" dropdown at top. When selected, auto-fill exchange + skip manual credential entry. Keep "Or enter manually" fallback.
- [x] 2.8. Update `buildPayload()` in wizard: if account selected, include `accountId` in payload (server resolves credentials from registry)
- [x] 2.9. Update `POST /api/bots` handler in server.ts: if `body.accountId` present, load credentials from AccountRegistry instead of expecting inline credentials
- [x] 2.10. Verify: accounts can be connected, listed, deleted; bots can be created from saved accounts

## Task 3: Pre-Trade Analytics Panel
- [x] 3.1. Create `src/dashboard/views/partials/pre-trade-analytics.ejs` — right sidebar panel
- [x] 3.2. Add new API route: `GET /api/exchanges/:exchange/funding-rate?symbol=X` — returns funding rate from adapter (or null if not supported)
- [x] 3.3. Add `get_funding_rate?(symbol: string): Promise<number | null>` optional method to ExchangeAdapter interface
- [x] 3.4. Implement `get_funding_rate` in PerplAdapter (from market state or REST)
- [x] 3.5. Implement `get_funding_rate` in OndoPerpsAdapter (from positions API response)
- [x] 3.6. Include pre-trade-analytics partial in DN setup pane (right sidebar)
- [x] 3.7. Client-side JS: when user changes notional/account/pair → recalculate estimated fees, fetch funding rate, update panel live
- [x] 3.8. Simplified version for Farm/Standard bot config step: show estimated fee per round-trip

## Task 4: Delta-Neutral Dual-Pane Setup
- [x] 4.1. Create `src/dashboard/views/partials/dn-setup-pane.ejs` — dual-pane layout with Long (green) / Short (red) sections
- [x] 4.2. Each pane: Account dropdown (from /api/accounts), Pair dropdown (loads symbols from selected account's exchange), Leverage selector
- [x] 4.3. Swap button (↔) between panes: swaps account + pair assignments
- [x] 4.4. Shared config section below panes: Notional ($), Position Duration (min), Stop Loss (slider)
- [x] 4.5. Replace current flat Delta-Neutral config in wizard Step 3 with the dual-pane partial
- [x] 4.6. Wire "Start Trading" button to build the correct DeltaNeutralConfig payload from both panes
- [x] 4.7. Include pre-trade-analytics panel (from Task 3) as right sidebar in the dual-pane view
- [x] 4.8. Test: create a DN bot using dual-pane UI with two different accounts, verify both legs open correctly

## Task 5: Portfolio Page
- [x] 5.1. Create `src/dashboard/views/portfolio.ejs` — full page with hero stats, charts, account table, risk panel
- [x] 5.2. Add route `GET /portfolio` in server.ts → renders portfolio.ejs
- [x] 5.3. Create `GET /api/portfolio` endpoint — aggregates: account balances, all bot positions, computes total equity/exposure/PnL/liquidation risk
- [x] 5.4. Create `src/dashboard/public/js/portfolio.js` — polls /api/portfolio every 10s, updates stats + charts
- [x] 5.5. Hero stats: Total Equity (sum of all account balances + unrealized PnL), Directional Bias (net long/short ratio), Total Unrealized PnL, Liquidation Risk indicator
- [x] 5.6. Charts (Chart.js): Total Equity over time (append to array on each poll), Notional Exposure bar chart, Unrealized PnL line chart
- [x] 5.7. Per-account table: exchange, label, balance, open positions count, PnL contribution
- [x] 5.8. Liquidation risk panel: At Risk %, Liquidation Buffer, Maintenance Margin, Average Leverage
- [x] 5.9. Add navigation link to Portfolio page in manager.ejs topnav
- [x] 5.10. Support light/dark mode using existing CSS variables

## Task 6: Sliders UI
- [x] 6.1. Create `src/dashboard/public/css/sliders.css` — custom range input styling with color zones (red/yellow/green), thumb, track, value label
- [x] 6.2. Implement Stop Loss slider component: replaces text input in DN config + bot wizard Step 3. Range 25%→100%, shows percentage + approximate USD value
- [x] 6.3. Implement Take Profit slider: range with "Uncapped" toggle at maximum position
- [x] 6.4. Implement Spread slider: 0→20 bps for market making config
- [x] 6.5. Each slider updates a hidden form input (for existing form submission flow)
- [x] 6.6. Visual feedback: color zones on track (red=high risk, green=conservative), numeric display updates in realtime
- [x] 6.7. Apply sliders to: DN dual-pane stop loss, bot wizard config step, delta-neutral-detail.ejs config panel
- [x] 6.8. Ensure dark/light mode compatibility via CSS variables
