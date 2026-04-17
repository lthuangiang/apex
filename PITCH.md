# APEX — Adaptive Perpetual Execution

---

## What is APEX?

APEX is an AI-powered BTC perpetual futures trading bot built for **SoDEX**, **Dango**, and **Decibel**. It combines a hybrid signal engine, adaptive learning, and a pseudo market-making strategy to maximize both **volume accumulation** (Farm Mode) and **trading performance** (Trade Mode).

---

## Two Modes, One Bot

### Farm Mode — Maximum Volume

The core insight: volume-incentive DEXes reward activity. Farm Mode is designed to **always trade** — no signal can block execution.

```
signal = long/short → use it
signal = skip       → alternate direction (long ↔ short)
```

No confidence gate. No chop filter. No fake breakout check. The bot is always active.

**Exit logic (priority order):**
1. SL: 5% hard stop
2. Dynamic TP: tied to live spread (`spreadBps/10000 × price × 1.5`, min fee floor, max $2)
3. Farm TP: $0.5 fixed floor
4. Early profit: hold ≥ 60s AND pnl ≥ $0.3
5. Time exit: 1–3 minute hold, then exit regardless of PnL

**Cooldown**: fixed 30s after each trade.

### Trade Mode — Signal-Filtered Execution

When the goal is win rate over volume, Trade Mode applies full filtering:

1. Regime check (HIGH_VOLATILITY → skip if enabled)
2. Chop detection (chopScore ≥ 0.55 → skip)
3. Fake breakout filter (OB imbalance contradiction → skip)
4. Confidence ≥ 0.65 (calibrated against historical win rates)
5. 2-tick confirmation (60s window)

Exit: SL 5% or TP 5% — no time pressure.

**Cooldown**: random between `COOLDOWN_MIN_MINS` and `COOLDOWN_MAX_MINS` (default 2–4 minutes).

---

## Deterministic Execution Engine

The core execution safety guarantee is a **5-state machine with strict tick isolation**:

```
IDLE → PENDING → IN_POSITION → EXITING → COOLDOWN → IDLE
```

**Rules enforced on every tick:**
- ONE action per tick: place OR cancel OR wait — then RETURN immediately
- `_tickLock` mutex: no concurrent tick execution
- Cancel + place never in the same tick
- Exit + re-entry never in the same tick
- COOLDOWN blocks all signal evaluation and order placement

**Dynamic tick scheduler:**

| State | Interval |
|---|---|
| IN_POSITION + early exit mode | FIXED 5s |
| IN_POSITION normal | Random 5–10s |
| EXITING / PENDING | Random 3–8s |
| COOLDOWN / IDLE | Weighted random 2s–90s |

---

## Full System Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           APEX Bot                                      │
│                                                                         │
│  bot.ts (SHIELD-BOT)                                                    │
│  ├── Watcher (5-State Machine)                                          │
│  │   IDLE → PENDING → IN_POSITION → EXITING → COOLDOWN                 │
│  │                                                                      │
│  │   ┌──────────────────┐  ┌──────────────┐  ┌─────────────────┐      │
│  │   │  AISignalEngine  │  │PositionSizer │  │ ExecutionEdge   │      │
│  │   │  EMA9/21+RSI+LLM │  │ conf×perf×   │  │ spread guard +  │      │
│  │   │  adaptive wts    │  │ volatility   │  │ dynamic offset  │      │
│  │   └──────────────────┘  └──────────────┘  └─────────────────┘      │
│  │                                                                      │
│  │   ┌──────────────────┐  ┌──────────────┐  ┌─────────────────┐      │
│  │   │  RegimeDetector  │  │  MarketMaker │  │  FeedbackLoop   │      │
│  │   │  ATR+BB+Vol      │  │  ping-pong + │  │  adaptive wts   │      │
│  │   │  4-state regime  │  │  inventory   │  │  per component  │      │
│  │   └──────────────────┘  └──────────────┘  └─────────────────┘      │
│  │                                                                      │
│  │   ┌──────────────────┐  ┌──────────────┐  ┌─────────────────┐      │
│  │   │  ChopDetector    │  │  FillTracker │  │ AnalyticsEngine │      │
│  │   │  FakeBreakout    │  │  ring buffer │  │  30+ dimensions │      │
│  │   │  (trade only)    │  │  fill rate   │  │  win rate data  │      │
│  │   └──────────────────┘  └──────────────┘  └─────────────────┘      │
│  │                                                                      │
│  ├── TelegramManager (commands + inline buttons)                        │
│  ├── DashboardServer (Express + SSE real-time)                          │
│  ├── ConfigStore (70+ runtime params)                                   │
│  └── SessionManager (max loss, session state)                           │
└─────────────────────────────────────────────────────────────────────────┘
              │                        │                    │
         SoDEX API               Dango GraphQL        Decibel (Aptos)
    (EIP-712, Post-Only)    (Secp256k1 signing)    (Ed25519 signing)
```

---

## Signal & Decision Flow

```
Binance 5m candles ──► EMA9/21, RSI, Momentum, OB Imbalance
                            │
                       WeightStore ──► adaptive weights (per 10 trades)
                            │
                      momentumScore (0–1)
                            │
                  SIDEWAY range logic ──► pricePositionInRange
                            │
                       LLMClient ──► GPT-4o / Claude (cached 60s)
                            │
                 ConfidenceCalibrator ──► historical win rate
                            │
                      Signal output
               { direction, confidence, regime, score }
                            │
         ┌──────────────────┴──────────────────┐
    Farm Mode                             Trade Mode
         │                                     │
MM Bias (ping-pong +               Regime Gate → ChopDetector
inventory control)                 FakeBreakoutFilter → Confidence
         │                                     │
   ALWAYS ENTER                        Conditional enter
         │                                     │
         └──────────────────┬──────────────────┘
                            │
                    PositionSizer
                    conf × perf × volatility
                            │
                    ExecutionEdge
                    spread guard + dynamic offset
                            │
                  Executor (Post-Only maker)
                            │
                  Watcher tick isolation
               ONE action → RETURN immediately
```

---

## Intelligence Stack

### 1. Adaptive Signal Weights

Signal weights adjust every 10 trades based on per-component win rates:

```
if EMA_winRate > 60%  → EMA weight += 0.05
if RSI_lossStreak > 3 → RSI weight -= 0.05
```

Each component tracked independently. Weights persist in `signal-weights.json`. Bounds: [0.05, 0.60], always sum to 1.0.

### 2. SIDEWAY Range Intelligence

Price position in last 10 candles range (0 = bottom, 1 = top):

```
pricePosition > 75% → momentumScore -= 0.08  (penalize long at top)
pricePosition < 25% → momentumScore += 0.08  (penalize short at bottom)
```

When LLM is unavailable in SIDEWAY, price position drives direction directly:
- Bottom of range (< 30%) → LONG (mean reversion)
- Top of range (> 70%) → SHORT (mean reversion)

### 3. Dynamic Position Sizing

```
size = baseSize × clamp(confMult × 0.6 + perfMult × 0.4) × volatilityFactor
```

| Factor | Farm | Trade |
|---|---|---|
| confMult | dampened (confidence scales mildly) | full scale |
| perfMult | win rate × drawdown × profile | same |
| volatilityFactor | always 1.0 | from regime (0.5–1.0) |

### 4. Regime Detection (Trade Mode Only)

| Regime | Entry edge | Size | Hold | SL buffer |
|---|---|---|---|---|
| TREND | 0.02 | 1.0× | 1.5× | 1.0× |
| SIDEWAY | 0.05 | 0.85× | 0.8× | 1.0× |
| HIGH_VOL | 0.08 | 0.5× | 0.7× | 1.5× |

Farm Mode ignores regime multipliers — always executes at full parameters.

### 5. Execution Edge

Smart order placement with self-correction:
```
offset = clamp(spreadBps × 0.3 + depthPenalty + fillRatePenalty, 0, 5)
```

- Spread guard: skip if spread > 10 bps
- Depth penalty: +$0.5 if top-5 book depth < $50k
- Fill rate feedback: +$1.0 if recent fill rate < 60% (ring buffer of 20 orders)

### 6. Farm Market Making

**Ping-pong**: after LONG → bias SHORT; after SHORT → bias LONG.

**Inventory control**: soft bias when net exposure > $50, hard block when > $150.

**Dynamic TP**: `min(max(spreadBps/10000 × price × 1.5, feeFloor), $2.0)` — always covers fees, adapts to live spread.

---

## Exchange Integrations

### Decibel (Active)

- Aptos blockchain-based DEX, Ed25519 signing
- `get_open_orders`: reads `{ items, total_count }` response format
- `cancel_all_orders`: cancels each order individually by ID via `cancelOrder({ orderId })` — avoids `EORDER_NOT_FOUND` from bulk cancel without IDs

### SoDEX

- EIP-712 typed data signing, Post-Only orders, 0.012% maker fee
- SoPoints tier tracking + runtime token refresh

### Dango Exchange

- GraphQL endpoint, Secp256k1 signing, USD notional sizing

---

## Operational Features

**Zero-Downtime Config**: 70+ parameters tunable at runtime. All changes validated before applying (41+ rules).

**Telegram Control**: start/stop, set max loss, switch modes, force close, real-time alerts.

**Graceful Shutdown**: SIGTERM/SIGINT handlers close open positions before exiting.

**Docker**: `docker build -f Dockerfile -t apex:latest . && docker compose up -d`

---

## Summary

| Feature | APEX | Typical Bot |
|---|---|---|
| Execution model | 5-state machine, strict tick isolation | Loose loop |
| Cancel safety | Per-order ID cancel, race condition guards | Bulk cancel |
| Farm mode | Always executes, never skips | Signal-gated |
| Tick timing | Dynamic: fixed 5s (early exit) / random 5–10s | Fixed interval |
| Cooldown | Random range \[MIN, MAX\] | Fixed or none |
| Fee awareness | Dynamic TP tied to live spread | Fixed target |
| Execution | Dynamic offset + spread guard + fill feedback | Static best-bid/ask |
| Learning | Self-adjusting weights per component | Stateless |
| Config | 70+ runtime params, no restart | Restart required |
| Analytics | 30+ dimensions per trade | Basic PnL only |
| Multi-exchange | SoDEX + Dango + Decibel | Single exchange |

---

> APEX turns maker fee models and volume incentives into a systematic edge.
> Farm Mode ensures the bot is always active. Trade Mode ensures it's always smart.
> The execution engine ensures it's always safe.
