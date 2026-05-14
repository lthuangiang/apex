<div align="center">

<p align="center">
  <img src="drift.png" alt="DRIFT logo" width="480"/>
</p>

### Dynamic Risk-Informed Futures Trading

*AI-powered perpetual futures bot with adaptive learning, intelligent execution, correlation hedging, and daily budget reset*

[![TypeScript](https://img.shields.io/badge/TypeScript-007ACC?style=flat&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-339933?style=flat&logo=node.js&logoColor=white)](https://nodejs.org/)
[![Docker](https://img.shields.io/badge/Docker-2496ED?style=flat&logo=docker&logoColor=white)](https://www.docker.com/)
[![Live](https://img.shields.io/badge/🚀_Live_Demo-drift.junxcrypto.xyz-f5a623?style=flat)](https://drift.junxcrypto.xyz/)

</div>

---

DRIFT is a multi-bot trading system for perpetual futures, supporting 3 exchanges: **SoDEX**, **Dango Exchange**, and **Decibel**. The system runs multiple bots in parallel with 3 strategies: **Farm Mode** (maximize volume), **Trade Mode** (maximize win rate), and **Hedge Bot** (correlation divergence). Each bot can be configured with **daily budget reset** — automatically resets max loss and volume target, restarts at 0:00 UTC (7:00 AM Vietnam) every day. The bot stops when it hits max loss **or** when it reaches the volume target — whichever comes first.

> Vietnamese documentation: [README_vi.md](README_vi.md)

## Dashboard

<p align="center">
  <img src="dashboard.png" alt="DRIFT Dashboard" width="800"/>
</p>

## System Architecture

<p align="center">
  <img src="design.png" alt="DRIFT Architecture" width="800"/>
</p>

---

## Three Strategies

### 1. Farm Mode — Maximize Volume

Designed for DEXes with volume incentives (SoPoints, AMPs, rebates). The goal is to **always be trading**, never miss an opportunity.

**Signal pipeline (farm mode)**:
```
Signal from AISignalEngine
  │
  ▼
[1] RegimeConfidenceThreshold  — SIDEWAY ≥ 0.45, TREND ≥ 0.35
  │
  ▼
[2] TradePressureGate          — skip if pressure=0 AND confidence < 0.55
  │
  ▼
[3] FallbackQualityGate        — skip if fallback=true AND confidence < 0.25
  │
  ▼
[4] FeeAwareEntryFilter        — skip if expectedEdge ≤ minRequiredMove × 1.5
  │
  ▼
[5] LLMMomentumAdjuster        — adjust effectiveConfidence (±10–20%)
  │
  ▼
[6] MinHoldTimeEnforcer        — compute dynamicMinHold from ATR and fee
  │
  ▼
PositionSizer → placeEntryOrder
```

**Direction resolution** (never skips):
- `pricePosition > 0.65` → SHORT (price near top of range)
- `pricePosition < 0.35` → LONG (price near bottom of range)
- Mid-range → use adjustedMomentumScore
- Fallback → alternate with previous order (long ↔ short)

**Exit conditions** (priority order):
1. SL: `FARM_SL_PERCENT = 5%`
2. Dynamic TP (MM enabled): `max(spreadBps/10000 × price × 1.5, feeFloor)`, capped $2.0
3. Farm TP: `FARM_TP_USD = $0.5`
4. Early profit: hold ≥ 60s AND pnl ≥ fee × 1.2 (suppressed in TREND regime)
5. Time exit: after `dynamicMinHold` (120–480s), wait extra 30s if profitable

**Cooldown**: fixed 30s (`FARM_COOLDOWN_SECS`)

---

### 2. Trade Mode — Maximize Win Rate

Only enters when there is a clear edge. No time exit — lets the trade run to TP or SL.

**Signal pipeline (trade mode)**:
```
Signal from AISignalEngine
  │
  ▼
[1] Regime check       — HIGH_VOLATILITY → skip if REGIME_HIGH_VOL_SKIP_ENTRY=true
  │
  ▼
[2] ChopDetector       — chopScore ≥ 0.55 → skip
  │
  ▼
[3] FakeBreakoutFilter — OB imbalance contradicts direction → skip
  │
  ▼
[4] Confidence gate    — confidence < MIN_CONFIDENCE (0.65) → skip
  │
  ▼
[5] 2-tick confirmation — must confirm within 60s window
  │
  ▼
PositionSizer → placeEntryOrder
```

**Exit**: SL 5% or TP 5%. **No time exit**.

**Cooldown**: random `[COOLDOWN_MIN_MINS, COOLDOWN_MAX_MINS]` (default 2–5 minutes)

---

### 3. Hedge Bot — Correlation Divergence

Trades **two correlated assets simultaneously** (BTC + ETH) in opposite directions. One leg long, one leg short with equal USD notional. Profit comes from temporary divergence.

**State machine**:
```
IDLE → OPENING → WAITING_FILL → IN_PAIR → CLOSING → COOLDOWN
```

**Entry trigger**: Simultaneous volume spike on both symbols + diverging AI signals.

**Fill management** (one-action-per-tick):
- Case 1: 1 filled + 1 rejected → re-place the rejected leg on the next tick
- Case 2: 1 filled + 1 pending → wait for fill; timeout 30s → cancel pending → OPENING
- Case 3: 2 pending → wait for fill; timeout 30s → cancel both → OPENING

**Exit conditions**: profit target, max loss, mean reversion, or holding period expired.

---

## Daily Budget Reset

Each bot can enable **automatic daily budget reset** and **auto-start** after reset. There are **two stop conditions** — whichever comes first:

1. **Max Loss**: session PnL ≤ `-dailyMaxLossUsd`
2. **Volume Target**: session volume ≥ `dailyTargetVolumeUsd` (if > 0)

### How it works

```
Watcher._tick() every ~5s:
  │
  ├── Section 2: updatePnL(sessionCurrentPnl)
  │     → if sessionPnl ≤ -maxLossUsd → IOC close + stop bot (MAX LOSS)
  │
  └── Section 2.5: updateVolume(sessionVolume)
        → if sessionVolume ≥ targetVolumeUsd AND targetVolumeUsd > 0
          → IOC close + stop bot (VOLUME TARGET)

Both checks fire only once per session (_maxLossTriggered / _volumeTargetTriggered flags).

Every minute: DailyResetScheduler checks current UTC hour
  │
  ▼
Is it reset time (default 0:00 UTC = 7:00 AM Vietnam)?
  │
  ├── No → keep waiting
  │
  └── Yes → perform reset:
        1. Stop bot (if running)
        2. Reset both flags: resetMaxLoss() + resetVolumeTarget()
        3. Re-apply: setMaxLoss(dailyMaxLossUsd) + setTargetVolume(dailyTargetVolumeUsd)
        4. Auto-start bot with fresh budget
        5. Send Telegram notification
```

### Telegram notifications

- Max loss hit: `⚠️ Max Loss Reached | Limit: $5 | Actual: -$5.12 | Bot stopped — will reset at next daily cycle`
- Volume target hit: `🎯 Volume Target Reached | Target: $5,000 | Actual: $5,023 | PnL: +2.40 | Bot stopped — will reset at next daily cycle`
- Daily reset: `🔄 Daily Budget Reset — Bot sodex-bot | Budget: $5 max loss | Volume target: $5,000 | 0:00 UTC (7:00 Vietnam) | Bot auto-restarted`

### Configuration in `bot-configs.json`

```json
{
  "id": "sodex-bot",
  "autoStart": true,
  "dailyBudgetReset": true,
  "dailyMaxLossUsd": 5,
  "dailyTargetVolumeUsd": 5000,
  "dailyResetHourUTC": 0
}
```

| Field | Description | Default |
|---|---|---|
| `dailyBudgetReset` | Enable/disable the feature | `false` |
| `dailyMaxLossUsd` | Max loss per day (USD) | `5` |
| `dailyTargetVolumeUsd` | Volume target per day (USD). `0` = disabled | `0` |
| `dailyResetHourUTC` | Reset hour (UTC 0–23) | `0` (= 7:00 AM VN) |

### Configuration from Dashboard (Bot Settings popup)

In addition to editing `bot-configs.json` directly, you can configure from the web interface:

```
Open bot detail page → click ⚙️ Bot Settings
  │
  ▼
Popup opens → scroll to "📅 Daily Budget Reset" section
  │
  ├── Enable toggle: turn feature on/off
  ├── Max Loss/day ($): daily loss limit
  ├── Target Volume/day ($): volume target (0 = disabled)
  └── Reset Hour UTC: reset hour (hint auto-shows Vietnam time)
  │
  ▼
Click "✓ Save"
  │
  ▼
Server:
  1. Validate all fields
  2. Update bot.config (live, no restart needed)
  3. Call sm.setMaxLoss() + sm.setTargetVolume() (takes effect immediately)
  4. Call bot.syncDailyResetScheduler() — restart scheduler with new config
  5. Persist to bot-configs.json
  6. Return updated config
  │
  ▼
Toast "Saved ✓" (green) or error message (red)
```

**Note:** The "📅 Daily Budget Reset" section only appears on the bot detail page (multi-bot mode), not on the overview page.

### Practical example

- Set `dailyMaxLossUsd: 5`, `dailyTargetVolumeUsd: 5000` → bot trades all day
- If loss reaches $5 → stop immediately (max loss)
- If volume reaches $5,000 → stop immediately (volume target) — even if not at a loss
- At 0:00 UTC (7:00 AM VN): reset both flags, bot auto-restarts with fresh budget

---

## Architecture Overview

```
bot.ts (Multi-Bot Manager)
  ├── BotManager                    # Manages multiple bots in parallel
  │     ├── BotInstance (Farm/Trade)
  │     │     ├── DailyResetScheduler   # Reset budget (max loss + volume target) + daily auto-start
  │     │     └── Watcher           # 5-state: IDLE→PENDING→IN_POSITION→EXITING→COOLDOWN
  │     │           ├── AISignalEngine      # EMA9/21, RSI, momentum, OB + regime
  │     │           ├── FarmSignalFilters   # 4-gate pipeline + LLM adjuster + MinHold
  │     │           ├── PositionSizer       # Dynamic sizing (confidence × performance)
  │     │           ├── MarketMaker         # Ping-pong + inventory + dynamic TP
  │     │           ├── ExecutionEdge       # Dynamic offset + spread guard + fill rate
  │     │           ├── ChopDetector        # Trade mode only
  │     │           ├── FakeBreakoutFilter  # Trade mode only
  │     │           └── Executor            # Post-Only maker orders
  │     │
  │     └── HedgeBot                # Correlation hedging bot
  │           ├── VolumeMonitor     # Dual-symbol volume spike detection
  │           ├── AISignalEngine ×2 # One engine per symbol
  │           └── State Machine     # IDLE→OPENING→WAITING_FILL→IN_PAIR→CLOSING→COOLDOWN
  │
  ├── FeedbackLoop/                 # Adaptive signal weights
  │     ├── ComponentPerformanceTracker
  │     ├── AdaptiveWeightAdjuster
  │     ├── WeightStore
  │     └── ConfidenceCalibrator
  │
  ├── TelegramManager               # Commands + inline buttons
  ├── TradeLogger                   # JSON or SQLite
  ├── DashboardServer               # Express + SSE real-time
  ├── ConfigStore                   # Runtime config override (70+ params)
  └── SessionManager                # Max loss, volume target, session state
```

---

## Farm/Trade Bot — Detailed State Machine

```
                    ┌─────────────────────────────────────────────────────┐
                    │                    IDLE                             │
                    │  1. Dust check (ignore position < MIN_POS_USD)      │
                    │  2. Hour blocking (FARM_BLOCKED_HOURS)              │
                    │  3. Cancel stale orders → RETURN                    │
                    │  4. _retryEntry? → re-place → PENDING               │
                    │  5. Signal pipeline → PositionSizer → placeOrder    │
                    └──────────────────────┬──────────────────────────────┘
                                           │ order placed
                                           ▼
                    ┌─────────────────────────────────────────────────────┐
                    │                   PENDING                           │
                    │  • position detected → IN_POSITION                  │
                    │  • timeout → cancel (tick N) → check (tick N+1)     │
                    │  • confirmed cancel → save _retryEntry → IDLE       │
                    └──────────────────────┬──────────────────────────────┘
                                           │ fill confirmed
                                           ▼
                    ┌─────────────────────────────────────────────────────┐
                    │                 IN_POSITION                         │
                    │  Exit triggers (priority order):                    │
                    │  1. SL 5%                                           │
                    │  2. Dynamic TP (MM spread-based)                    │
                    │  3. Farm TP $0.5                                    │
                    │  4. Early profit (≥60s + fee×1.2)                  │
                    │  5. Time exit (dynamicMinHold + 30s grace)          │
                    └──────────────────────┬──────────────────────────────┘
                                           │ exit trigger fired
                                           ▼
                    ┌─────────────────────────────────────────────────────┐
                    │                   EXITING                           │
                    │  Case A: no pendingExit                             │
                    │    → cancel open orders → re-verify position        │
                    │    → dust check → skip if < MIN_POS_USD             │
                    │    → placeExitOrder → pendingExit                   │
                    │  Case B: pendingExit exists                         │
                    │    → position gone → _onExitFilled → COOLDOWN       │
                    │    → timeout 15s → cancel → retry Case A            │
                    └──────────────────────┬──────────────────────────────┘
                                           │ exit filled
                                           ▼
                    ┌─────────────────────────────────────────────────────┐
                    │                  COOLDOWN                           │
                    │  Farm: fixed 30s                                    │
                    │  Trade: random [COOLDOWN_MIN, COOLDOWN_MAX] mins    │
                    └──────────────────────┬──────────────────────────────┘
                                           │ cooldown expired
                                           └──────────────────► IDLE
```

**Strict tick isolation**: each tick performs exactly **one** action (place OR cancel OR wait) then returns. Per-tick mutex (`_tickLock`) prevents a new tick from running while the previous one is still executing.

---

## Hedge Bot — Detailed State Machine

```
                    ┌─────────────────────────────────────────────────────┐
                    │                    IDLE                             │
                    │  • VolumeMonitor.sample() every 15s                 │
                    │  • shouldEnter(): both symbols spiking at once?     │
                    │  • getSignal(A) + getSignal(B) in parallel          │
                    │  • assignDirections(scoreA, scoreB)                 │
                    │    → scoreA > scoreB: long A, short B               │
                    │    → scoreB > scoreA: long B, short A               │
                    │    → equal: skip                                    │
                    └──────────────────────┬──────────────────────────────┘
                                           │ entry triggered
                                           ▼
                    ┌─────────────────────────────────────────────────────┐
                    │                  OPENING                            │
                    │  Tick A: check open orders → cancel if any → RETURN │
                    │  Tick B: check existing positions (anti-double-trade)│
                    │    → legA filled? skip order A                      │
                    │    → legB filled? skip order B                      │
                    │    → place_limit_order(A) + place_limit_order(B)    │
                    │    → 1 leg fails → cancel successful leg → IDLE     │
                    └──────────────────────┬──────────────────────────────┘
                                           │ orders placed
                                           ▼
                    ┌─────────────────────────────────────────────────────┐
                    │               WAITING_FILL                          │
                    │  Each tick: query positions + open orders           │
                    │                                                     │
                    │  ✅ Both filled → IN_PAIR                           │
                    │                                                     │
                    │  Case 1: filled A + rejected B (no pending)         │
                    │    → re-place B this tick                           │
                    │                                                     │
                    │  Case 2: filled A + pending B                       │
                    │    → wait; timeout 30s → cancel B → OPENING         │
                    │                                                     │
                    │  Case 3: pending A + pending B                      │
                    │    → wait; timeout 30s → cancel A+B → OPENING       │
                    └──────────────────────┬──────────────────────────────┘
                                           │ both legs filled
                                           ▼
                    ┌─────────────────────────────────────────────────────┐
                    │                  IN_PAIR                            │
                    │  Each tick (5s): update PnL, check exit conditions  │
                    │  Exit triggers:                                     │
                    │  • PROFIT_TARGET: combinedPnl ≥ profitTargetUsd     │
                    │  • MAX_LOSS: combinedPnl ≤ -maxLossUsd              │
                    │  • MEAN_REVERSION: ratio returns to equilibrium     │
                    │  • TIME_EXPIRY: elapsedSecs ≥ holdingPeriodSecs     │
                    └──────────────────────┬──────────────────────────────┘
                                           │ exit condition met
                                           ▼
                    ┌─────────────────────────────────────────────────────┐
                    │                  CLOSING                            │
                    │  Tick A: cancel open orders → RETURN                │
                    │  Tick B: query ACTUAL positions from exchange        │
                    │    → close only open legs (avoid ghost close)       │
                    │    → poll flat confirmation (5 times, 1s interval)  │
                    └──────────────────────┬──────────────────────────────┘
                                           │ both legs closed
                                           ▼
                    ┌─────────────────────────────────────────────────────┐
                    │                 COOLDOWN                            │
                    │  Wait cooldownSecs → IDLE                           │
                    └─────────────────────────────────────────────────────┘
```

---

## Daily Budget Reset — Detailed Workflow

```
Bot starts
  │
  ├── dailyBudgetReset: false → nothing extra
  │
  └── dailyBudgetReset: true
        │
        ▼
  DailyResetScheduler.start()
  Seed lastResetDate = today@resetHour (prevents firing immediately on startup)
        │
        ▼
  setInterval(60s) — check every minute:
        │
        ├── currentUTCHour ≠ resetHourUTC → skip
        ├── currentMinute ≠ 0 → skip
        └── todayKey === lastResetDate → skip (already reset today)
              │
              ▼ (fires once per day, on the first minute of the reset hour)
        lastResetDate = todayKey
              │
              ▼
        _doReset():
          1. bot.stop()                        — stop watcher, save state
          2. sm.resetMaxLoss()                 — clear max-loss-triggered flag
          3. sm.resetVolumeTarget()            — clear volume-target-triggered flag
          4. sm.setMaxLoss(dailyMaxLossUsd)    — re-apply max loss budget
          5. sm.setTargetVolume(dailyTargetVolumeUsd) — re-apply volume target
          6. bot.start()                       — start new session
          7. onReset(botId)                    — send Telegram notification
```

---

## AI Signal Engine

Fetches 4 data sources in parallel:
- Orderbook depth (20 levels) — from exchange adapter
- Recent trades (100 trades) — from exchange adapter
- Binance 5m klines (30 candles) — EMA, RSI, momentum
- Binance top L/S position ratio (5m) — sentiment

**Momentum score** with adaptive weights (auto-adjusts every 10 trades):

| Source | Logic | Default weight |
|---|---|---|
| EMA9 vs EMA21 | EMA9 > EMA21 → bullish (0.65), otherwise (0.35) | ~40% |
| RSI(14) | < 35 oversold (0.75), > 65 overbought (0.25), linear between | ~25% |
| 3-candle momentum | `(currentPrice - closes[-4]) / closes[-4] × 50 + 0.5` | ~20% |
| Orderbook imbalance | `(bidVol/askVol - 1) × 0.5 + 0.5` | ~15% |

**Candle pattern bonus**: EMA crossover or hammer/shooting star → ±0.05

**SIDEWAY regime**: price position within 10-candle range adjusts score by ±0.08

**Cache**: 60s TTL. Invalidated after placing an entry order.

**Fallback**: if Binance API fails → use basic SignalEngine (OB + trades only)

---

## Farm Signal Cost Optimizer

6 filters/adjusters to reduce trades with negative cost (fee > gross PnL):

| Filter | Reject condition | Config key |
|---|---|---|
| RegimeConfidenceThreshold | SIDEWAY: conf < 0.45; TREND: conf < 0.35 | `FARM_SIDEWAY_MIN_CONFIDENCE`, `FARM_TREND_MIN_CONFIDENCE` |
| TradePressureGate | tradePressure=0 AND conf < 0.55 | `FARM_MIN_CONFIDENCE_PRESSURE_GATE` |
| FallbackQualityGate | fallback=true AND conf < 0.25 | `FARM_MIN_FALLBACK_CONFIDENCE` |
| FeeAwareEntryFilter | `\|score-0.5\|×2×atrPct ≤ FEE_RATE×2×1.5` | `FEE_RATE_MAKER` |
| LLMMomentumAdjuster | (no reject) boost ×1.1 or penalty ×0.8 | — |
| MinHoldTimeEnforcer | (no reject) `feeBreakEvenSecs = (FEE×2/atrPct)×300` | `FARM_MIN_HOLD_SECS`, `FARM_MAX_HOLD_SECS` |

---

## Exchange Integration

| Exchange | Signing | Notes |
|---|---|---|
| SoDEX | EIP-712 typed data | Post-Only, 0.012% maker fee, SoPoints |
| Decibel | Ed25519 (Aptos) | Gas Station, per-order cancel |
| Dango | Secp256k1 + GraphQL | USD notional sizing |

**SoDEX quirks**: API returns all positions regardless of `?symbol=` query → filter client-side. Negative size = short → normalize with `Math.abs()`.

---

## Installation

```bash
npm install
cp .env.example .env
npm start
```

### Docker

```bash
cp .env.example .env
docker build -f Dockerfile -t drift:latest .
docker compose up -d
```

---

## `.env` Configuration

```env
# SoDEX
SODEX_API_KEY=...
SODEX_API_SECRET=0x...
SODEX_SUBACCOUNT=0x...

# Decibel
DECIBELS_PRIVATE_KEY=0x...
DECIBELS_NODE_API_KEY=...
DECIBELS_SUBACCOUNT=0x...

# Dango
DANGO_PRIVATE_KEY=0x...
DANGO_USER_ADDRESS=0x...

TELEGRAM_BOT_TOKEN=...
TELEGRAM_CHAT_ID=...

LLM_PROVIDER=openai
OPENAI_API_KEY=sk-...

TRADE_LOG_BACKEND=json
TRADE_LOG_PATH=/app/data/trades.json
DASHBOARD_PORT=3000
```

---

## Dashboard

Access at `http://localhost:3000`

- **Manager view**: all bots, aggregated PnL, start/stop each bot
- **Bot detail**: session PnL, volume, real-time console (SSE), trade history
- **Hedge bot**: shows 2 open legs (symbol, side, entry price, unrealized PnL, combined PnL)
- **Analytics tab**: win rate, signal quality, fee impact, regime performance, filter skip stats, effective confidence stats, dynamic min hold stats
- **Bot Settings**: adjust 70+ config params at runtime without restart; **📅 Daily Budget Reset** section (only on bot detail page) lets you configure Enable toggle, Max Loss/day, Target Volume/day, Reset Hour UTC — saves immediately without page reload

---

## Telegram Commands

| Command | Description |
|---|---|
| `/start_bot` | Start session |
| `/stop_bot` | Stop bot |
| `/status` | Status, uptime, PnL |
| `/check` | Current open position |
| `/set_mode farm\|trade` | Switch mode |
| `/set_max_loss <usd>` | Set session loss limit |

---

## Directory Structure

```
src/
├── bot.ts                    # Bootstrap, multi-bot manager, graceful shutdown
├── config.ts                 # 70+ default parameters
├── adapters/
│   ├── ExchangeAdapter.ts    # Common interface
│   ├── sodex_adapter.ts      # SoDEX (EIP-712 signing)
│   ├── decibel_adapter.ts    # Decibel (Aptos Ed25519)
│   └── dango_adapter.ts      # Dango (Secp256k1 + GraphQL)
├── bot/
│   ├── BotManager.ts         # Manages multiple bots
│   ├── BotInstance.ts        # Farm/Trade bot wrapper
│   ├── DailyResetScheduler.ts # Daily budget reset + auto-start
│   ├── HedgeBot.ts           # Correlation hedging bot (6-state machine)
│   ├── VolumeMonitor.ts      # Dual-symbol volume spike detection
│   └── hedgeBotHelpers.ts    # assignDirections, evaluateExitConditions
├── modules/
│   ├── Watcher.ts            # Main 5-state machine
│   ├── FarmSignalFilters.ts  # 4-gate pipeline + LLM adjuster + MinHold
│   ├── Executor.ts           # Place/cancel orders (Post-Only + IOC)
│   ├── ExecutionEdge.ts      # Dynamic offset + spread guard
│   ├── FillTracker.ts        # Fill rate ring buffer (20 orders)
│   ├── PositionSizer.ts      # Dynamic sizing
│   ├── MarketMaker.ts        # Ping-pong + inventory + dynamic TP
│   ├── RiskManager.ts        # TP/SL check
│   └── SessionManager.ts     # Max loss, volume target, session state
├── ai/
│   ├── AISignalEngine.ts     # Main signal engine (EMA/RSI/momentum/OB)
│   ├── RegimeDetector.ts     # ATR + BB + volume → SIDEWAY/TREND/HIGH_VOL
│   ├── ChopDetector.ts       # Flip rate + momentum neutrality + BB compression
│   ├── FakeBreakoutFilter.ts # Volume + OB imbalance contradiction check
│   ├── AnalyticsEngine.ts    # 30+ dimensions per trade
│   ├── TradeLogger.ts        # JSON or SQLite
│   └── FeedbackLoop/
│       ├── WeightStore.ts
│       ├── ComponentPerformanceTracker.ts
│       ├── AdaptiveWeightAdjuster.ts
│       └── ConfidenceCalibrator.ts
├── config/
│   ├── ConfigStore.ts        # Runtime config override
│   └── validateOverrides.ts  # 41+ validation rules
└── dashboard/
    ├── server.ts             # Express dashboard + SSE
    └── views/                # EJS templates
```

---

> **Warning**: This software is for research and educational purposes only. Cryptocurrency trading carries significant risk. Do not commit your `.env` file to git.

---

<div align="center">

**Made with ❤️ for the DeFi community**

*DRIFT — Where intelligent execution meets adaptive learning*

</div>
