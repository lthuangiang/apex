# Backtest UI Specification

> Feature: Interactive backtest session trong SoDEX Bot Details
> Wave: 2
> Priority: HIGH (showcase SoDEX API integration)

---

## 1. Overview

### 1.1 Purpose

Thêm Backtest UI vào Bot Details page cho phép users:
- Chọn date range (start/end time)
- Run historical simulation với bot's current config
- Xem results: metrics, equity curve, trade breakdown
- **Chỉ available cho SoDEX perpetual futures bots**

### 1.2 User Flow

```
User → Bot Details → Backtest Tab → Select Dates → Run Backtest → View Results
```

### 1.3 Technical Stack

- **Frontend**: EJS templates + vanilla JavaScript + Chart.js
- **Backend**: Express API endpoint + BacktestEngine
- **Data Source**: SoDEX API (klines) + bot's current config

---

## 2. Requirements

### 2.1 Functional Requirements

| ID | Requirement | Priority |
|----|-------------|----------|
| F1 | Backtest tab chỉ hiện với SoDEX perp bots | MUST |
| F2 | Date range picker (start/end datetime) | MUST |
| F3 | Initial balance input (default 1000 USD) | MUST |
| F4 | Run backtest button | MUST |
| F5 | Progress indicator during backtest | MUST |
| F6 | Results display: metrics cards | MUST |
| F7 | Equity curve chart | MUST |
| F8 | Performance by regime table | MUST |
| F9 | Trade history table | SHOULD |
| F10 | Max backtest period: 30 days | MUST |

### 2.2 Non-Functional Requirements

| ID | Requirement | Target |
|----|-------------|--------|
| NF1 | Backtest execution time | < 30s for 10 days |
| NF2 | UI responsiveness | No blocking |
| NF3 | Data accuracy | ≥95% vs actual trades |
| NF4 | Error handling | Graceful with user feedback |

---

## 3. Architecture

### 3.1 Component Diagram

```
┌─────────────────────────────────────────┐
│         Dashboard Frontend              │
│  ┌───────────────────────────────────┐  │
│  │   Bot Details Page                │  │
│  │  ┌─────────────────────────────┐  │  │
│  │  │  Backtest Tab (NEW)         │  │  │
│  │  │  - Date pickers             │  │  │
│  │  │  - Run button               │  │  │
│  │  │  - Results display          │  │  │
│  │  └─────────────────────────────┘  │  │
│  └───────────────────────────────────┘  │
└─────────────────────────────────────────┘
                    │
                    │ POST /api/bots/:id/backtest
                    ▼
┌─────────────────────────────────────────┐
│         Backend API                     │
│  ┌───────────────────────────────────┐  │
│  │   backtest-routes.ts              │  │
│  │   - Validate request              │  │
│  │   - Call BacktestEngine           │  │
│  │   - Return results                │  │
│  └───────────────────────────────────┘  │
└─────────────────────────────────────────┘
                    │
                    ▼
┌─────────────────────────────────────────┐
│         BacktestEngine                  │
│  - Fetch SoDEX klines                   │
│  - Replay strategy tick-by-tick         │
│  - Calculate metrics                    │
└─────────────────────────────────────────┘
```

### 3.2 Data Flow

```
1. User selects dates → Frontend
2. POST /api/bots/:id/backtest → Backend
3. Fetch historical klines → SoDEX API
4. For each candle:
   - Generate signal (AISignalEngine)
   - Apply filters (FarmSignalFilters)
   - Simulate trade execution
   - Update equity
5. Calculate metrics → Return to Frontend
6. Display results → User
```

---

## 4. API Specification

### 4.1 Endpoint

```
POST /api/bots/:botId/backtest
```

### 4.2 Request Body

```json
{
  "startDate": "2026-04-10T00:00:00.000Z",
  "endDate": "2026-04-20T23:59:59.999Z",
  "initialBalance": 1000
}
```

### 4.3 Response

```json
{
  "totalTrades": 1000,
  "winRate": 0.413,
  "totalPnl": -28.10,
  "sharpeRatio": 0.85,
  "maxDrawdown": 0.152,
  "equityCurve": [
    { "timestamp": "2026-04-10T00:00:00Z", "equity": 1000 },
    { "timestamp": "2026-04-10T00:05:00Z", "equity": 999.8 }
  ],
  "byRegime": {
    "SIDEWAY": { "trades": 771, "winRate": 0.418, "pnl": -14.27 },
    "TREND_UP": { "trades": 101, "winRate": 0.426, "pnl": -1.65 }
  },
  "trades": [
    {
      "timestamp": "2026-04-10T00:15:00Z",
      "direction": "long",
      "entryPrice": 76500,
      "exitPrice": 76520,
      "pnl": 0.15,
      "regime": "SIDEWAY"
    }
  ]
}
```

### 4.4 Error Responses

| Code | Error | Message |
|------|-------|---------|
| 400 | Invalid date | "End date must be after start date" |
| 400 | Period too long | "Max backtest period is 30 days" |
| 400 | Wrong bot type | "Backtest only available for SoDEX perpetual futures" |
| 404 | Bot not found | "Bot not found" |
| 500 | Execution error | "Backtest failed: {reason}" |

---

## 5. UI Specification

### 5.1 Backtest Tab Layout

```
┌─────────────────────────────────────────────────────┐
│ 📊 Backtest Session                                 │
│                                                     │
│ Run historical simulation using bot's current      │
│ config and SoDEX market data                       │
│                                                     │
│ ┌─────────────┐ ┌─────────────┐ ┌──────────────┐  │
│ │ Start Date  │ │ End Date    │ │ Init Balance │  │
│ │ [datetime]  │ │ [datetime]  │ │ [1000 USD]   │  │
│ └─────────────┘ └─────────────┘ └──────────────┘  │
│                                                     │
│ [🚀 Run Backtest]                                   │
│                                                     │
│ ┌─────────────────────────────────────────────┐   │
│ │ ████████████░░░░░░░░░░░░░░░░░░░░░░░░░ 45%  │   │
│ │ Simulating trades...                        │   │
│ └─────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────┘
```

### 5.2 Results Display

```
┌─────────────────────────────────────────────────────┐
│ Results                                             │
│                                                     │
│ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌────────┐ │
│ │  1,000   │ │  41.3%   │ │ -$28.10  │ │  0.85  │ │
│ │  Trades  │ │ Win Rate │ │   PnL    │ │ Sharpe │ │
│ └──────────┘ └──────────┘ └──────────┘ └────────┘ │
│                                                     │
│ Equity Curve                                        │
│ ┌─────────────────────────────────────────────┐   │
│ │        /\      /\                           │   │
│ │       /  \    /  \    /\                    │   │
│ │      /    \  /    \  /  \                   │   │
│ │     /      \/      \/    \                  │   │
│ └─────────────────────────────────────────────┘   │
│                                                     │
│ Performance by Regime                               │
│ ┌─────────────────────────────────────────────┐   │
│ │ Regime     │ Trades │ Win Rate │ PnL       │   │
│ │ SIDEWAY    │ 771    │ 41.8%    │ -$14.27   │   │
│ │ TREND_UP   │ 101    │ 42.6%    │ -$1.65    │   │
│ └─────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────┘
```

---

## 6. Implementation Plan

### 6.1 Phase 1: Frontend UI (2-3h)

**Files to create/modify:**
- `src/dashboard/views/partials/bot-detail-tabs.ejs` — add Backtest tab
- `src/dashboard/views/partials/backtest-tab.ejs` — NEW
- `src/dashboard/public/js/backtest.js` — NEW
- `src/dashboard/public/css/backtest.css` — NEW

### 6.2 Phase 2: Backend API (3-4h)

**Files to create:**
- `src/dashboard/backtest-routes.ts` — NEW
- `src/backtest/BacktestEngine.ts` — NEW
- `src/backtest/types.ts` — NEW

**Files to modify:**
- `src/dashboard/server.ts` — register backtest routes

### 6.3 Phase 3: Testing (1-2h)

**Test cases:**
- Backtest tab only shows for SoDEX perp bots
- Date validation works
- Backtest executes and returns results
- Results display correctly
- Error handling works

---

## 7. Success Criteria

| Metric | Target | Verification |
|--------|--------|--------------|
| Feature availability | SoDEX perp only | Manual test |
| Backtest accuracy | ≥95% vs actual | Compare with trades.txt |
| Execution time | <30s for 10 days | Performance test |
| UI responsiveness | No blocking | Manual test |
| Error handling | Graceful | Error injection test |

---

## 8. Future Enhancements (Wave 3)

- [ ] Export backtest results as CSV
- [ ] Compare multiple backtest runs
- [ ] Parameter optimization (grid search)
- [ ] Walk-forward analysis
- [ ] Monte Carlo simulation
- [ ] Strategy comparison (Farm vs Trade mode)

---

## 9. Notes

- Backtest uses bot's **current config** — any config changes affect backtest
- Historical SoSoValue data not available → backtest runs without SoSoValue filters
- Assumes perfect fills (maker orders always fill)
- No slippage model (can add in Wave 3)
- Fee calculation: 0.012% maker × 2 (entry + exit)
