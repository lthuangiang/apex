<div align="center">

# 🌊 DRIFT
## Dynamic Risk-Informed Futures Trading

*Intelligent execution meets adaptive learning — with correlation hedging and daily budget automation*

</div>

---

## What is DRIFT?

DRIFT is a multi-bot AI trading system for perpetual futures on **SoDEX**, **Dango**, and **Decibel**. It runs multiple strategies simultaneously: single-asset Farm/Trade bots and a dual-asset Hedge bot that exploits correlation divergence between BTC and ETH. Each bot can be configured with a **daily budget reset** — automatically resetting max loss and restarting at a fixed UTC time every day, no manual intervention required.

---

## Four Core Capabilities

### 1. Farm Mode — Maximum Volume

Volume-incentive DEXes reward activity. Farm Mode is designed to **always trade** — no signal can block execution.

```
signal = long/short → use it
signal = skip       → use price position in range (mean reversion)
                      or alternate direction (long ↔ short)
```

No confidence gate. No chop filter. No fake breakout check. Always active.

**Exit logic (priority order):**
1. SL: 5% hard stop
2. Dynamic TP: tied to live spread when MM enabled
3. Farm TP: $0.5 fixed floor
4. Early profit: hold ≥ 60s AND pnl ≥ fee × 1.2
5. Time exit: 2–8 minute hold with 30s grace period

### 2. Trade Mode — Signal-Filtered Execution

When win rate matters more than volume:

1. Regime check (HIGH_VOLATILITY → skip if enabled)
2. Chop detection (chopScore ≥ 0.55 → skip)
3. Fake breakout filter (OB imbalance contradiction → skip)
4. Confidence ≥ 0.65 (calibrated against historical win rates)
5. 2-tick confirmation (60s window)

Exit: SL 5% or TP 5% — **no time pressure**.

### 3. Hedge Mode — Correlation Divergence

DRIFT simultaneously opens **long on one asset, short on the other** with equal USD notional. Profit comes from temporary divergence between correlated assets (BTC/ETH).

**Entry**: volume spike on both symbols simultaneously + AI signal divergence.

**State machine**:
```
IDLE → OPENING → WAITING_FILL → IN_PAIR → CLOSING → COOLDOWN
```

**Fill management** (one-action-per-tick):
- Case 1: 1 filled + 1 rejected → re-place the rejected leg immediately
- Case 2: 1 filled + 1 pending → wait up to 30s; timeout → cancel → retry
- Case 3: 2 pending → wait up to 30s; timeout → cancel both → retry

**Exit**: profit target, max loss, mean reversion, or time expiry.

### 4. Daily Budget Reset — Automated Risk Management

Each bot can be configured with **two daily stop conditions** — whichever is hit first stops the bot for the day:

1. **Max Loss**: session PnL ≤ `-dailyMaxLossUsd`
2. **Volume Target**: session volume ≥ `dailyTargetVolumeUsd` (when > 0)

At the configured UTC reset hour, the scheduler automatically restarts the bot with a fresh budget.

```
Watcher._tick() every ~5s:
  │
  ├── Section 2: updatePnL(sessionCurrentPnl)
  │     → sessionPnl ≤ -maxLossUsd?
  │       → Yes: IOC close + bot.stop()  [MAX LOSS]
  │
  └── Section 2.5: updateVolume(sessionVolume)
        → sessionVolume ≥ targetVolumeUsd AND targetVolumeUsd > 0?
          → Yes: IOC close + bot.stop()  [VOLUME TARGET]

Both checks fire only once per session (flag-guarded).

Every minute: DailyResetScheduler checks current UTC hour
  │
  ├── Not reset hour yet → wait
  │
  └── Reset hour reached (first minute only, once per day):
        Step 1: bot.stop()                    — clean shutdown, save state
        Step 2: resetMaxLoss()                — clear max-loss-triggered flag
        Step 3: resetVolumeTarget()           — clear volume-target-triggered flag
        Step 4: setMaxLoss($N)                — apply fresh daily budget
        Step 5: setTargetVolume($V)           — apply fresh volume target
        Step 6: bot.start()                   — new session begins
        Step 7: Telegram notify               — "🔄 Daily Budget Reset — $5 budget, $5k target, bot restarted"
```

**Config:**
```json
{
  "dailyBudgetReset": true,
  "dailyMaxLossUsd": 5,
  "dailyTargetVolumeUsd": 5000,
  "dailyResetHourUTC": 0
}
```

`dailyResetHourUTC: 0` = midnight UTC = **7:00 AM Vietnam time**.
`dailyTargetVolumeUsd: 0` = volume target disabled (max loss only).

**Dashboard UI**: the Bot Settings popup (⚙️ on any bot detail page) includes a **📅 Daily Budget Reset** section with Enable toggle, Max Loss/day, Target Volume/day, and Reset Hour UTC fields. Changes apply live via `PATCH /api/bots/:id/daily-reset` — no page reload, no restart needed. `BotInstance.syncDailyResetScheduler()` stops the old scheduler and starts a new one with the updated config immediately.

The scheduler seeds `lastResetDate` on startup to avoid firing immediately. Each bot has its own independent scheduler — different bots can reset at different hours.

---

## Execution Safety — The Core Guarantee

Every bot in DRIFT follows the same principle: **one action per tick**.

```
Farm/Trade Bot:   IDLE → PENDING → IN_POSITION → EXITING → COOLDOWN
Hedge Bot:        IDLE → OPENING → WAITING_FILL → IN_PAIR → CLOSING → COOLDOWN
```

**Rules enforced on every tick:**
- ONE action: place OR cancel OR wait — then RETURN immediately
- Cancel and place never in the same tick
- Open orders always checked before placing new orders
- Actual exchange positions queried before close orders (not stale state)

This prevents the most common bot failure modes: duplicate orders, ghost positions, and race conditions.

---

## Full System Architecture

```
┌──────────────────────────────────────────────────────────────────────────┐
│                           DRIFT Multi-Bot System                         │
│                                                                          │
│  BotManager                                                              │
│  ├── BotInstance (Farm/Trade) × N                                        │
│  │   ├── DailyResetScheduler  ← reset budget + auto-start every day     │
│  │   └── Watcher (5-state machine)                                       │
│  │       ├── AISignalEngine  ├── PositionSizer  ├── ExecutionEdge        │
│  │       ├── RegimeDetector  ├── MarketMaker    ├── FeedbackLoop         │
│  │       └── ChopDetector / FakeBreakoutFilter (trade only)              │
│  │                                                                        │
│  └── HedgeBot × N                                                        │
│      └── State Machine (6 states)                                        │
│          ├── VolumeMonitor (dual-symbol spike detection)                 │
│          ├── AISignalEngine × 2 (one per symbol)                         │
│          └── Fill management (3 cases, 30s timeout)                     │
│                                                                          │
│  DashboardServer (Express + SSE)                                         │
│  TelegramManager (commands + alerts)                                     │
│  ConfigStore (70+ runtime params)                                        │
└──────────────────────────────────────────────────────────────────────────┘
              │                        │                    │
         SoDEX API               Dango GraphQL        Decibel (Aptos)
    (EIP-712, Post-Only)    (Secp256k1 signing)    (Ed25519 signing)
```

---

## Intelligence Stack

### 1. Adaptive Signal Weights

Signal weights adjust every 10 trades based on per-component win rates:

```
if EMA_winRate > 60%  → EMA weight += 0.05
if RSI_lossStreak > 3 → RSI weight -= 0.05
```

Bounds: [0.05, 0.60], always sum to 1.0. Persisted to disk.

### 2. Hedge Direction Assignment

```
scoreA > scoreB → long A, short B  (A has stronger momentum)
scoreB > scoreA → long B, short A  (B has stronger momentum)
scoreA == scoreB → skip entry
```

The asset with stronger momentum goes long. The weaker one goes short. Profit when they converge.

### 3. Volume Spike Detection

Both symbols must spike simultaneously:
```
shouldEnter() = currentVolumeA > avgA × 1.21
             AND currentVolumeB > avgB × 1.21
             AND windowA.length >= 10
             AND windowB.length >= 10
```

Single-symbol spike → no entry. Both must confirm.

### 4. Dynamic Position Sizing (Farm/Trade)

```
size = baseSize × clamp(confMult × 0.6 + perfMult × 0.4) × volatilityFactor
```

| Factor | Farm | Trade |
|---|---|---|
| confMult | dampened | full scale |
| perfMult | win rate × drawdown × profile | same |
| volatilityFactor | always 1.0 | from regime (0.5–1.0) |

### 5. Execution Edge (Farm/Trade)

Smart order placement with self-correction:
```
offset = clamp(spreadBps × 0.3 + depthPenalty + fillRatePenalty, 0, 5)
```

- Spread guard: skip if spread > 10 bps
- Depth penalty: +$0.5 if top-5 book depth < $50k
- Fill rate feedback: +$1.0 if recent fill rate < 60%

### 6. Farm Market Making

**Ping-Pong**: after LONG → bias SHORT; after SHORT → bias LONG.

**Inventory control**: soft bias when net exposure > $50, hard block when > $150.

**Dynamic TP**: `min(max(spreadBps/10000 × price × 1.5, feeFloor), $2.0)` — always covers fees.

---

## Exchange Integrations

### SoDEX
- EIP-712 typed data signing, Post-Only orders, 0.012% maker fee
- SoPoints tier tracking + weekly volume countdown
- Position API returns all positions regardless of symbol query — filtered client-side
- Negative size = short position — normalized to absolute value

### Decibel (Aptos)
- Ed25519 signing via `@aptos-labs/ts-sdk`
- Gas Station for sponsored transactions
- Per-order cancel by ID (no bulk cancel without IDs)

### Dango Exchange
- GraphQL endpoint, Secp256k1 signing, USD notional sizing

---

## Operational Features

**Daily Budget Reset**: each bot resets its max loss and auto-restarts at a configured UTC hour. No manual intervention needed — the bot runs, hits its daily limit, stops, then comes back fresh the next morning.

**Zero-Downtime Config**: 70+ parameters tunable at runtime via dashboard. All changes validated before applying.

**Telegram Control**: start/stop bots, set max loss, switch modes, force close, real-time alerts including daily reset notifications.

**Graceful Shutdown**: SIGTERM/SIGINT handlers stop all bots (including their schedulers) before exiting.

**Rate Limit Handling**: automatic backoff when exchange returns 429, respects `retryAfter` header.

**Docker**: `docker build -f Dockerfile -t drift:latest . && docker compose up -d`

---

## Summary

| Feature | DRIFT | Typical Bot |
|---|---|---|
| Strategies | Farm + Trade + Hedge | Single strategy |
| Daily budget reset | Automatic, per-bot, configurable hour, max loss + volume target | Manual restart |
| Execution model | Strict one-action-per-tick | Loose loop |
| Hedge fill handling | 3 cases with 30s timeout | None |
| Cancel safety | Check open orders before placing | Blind cancel |
| Position query | Always from exchange (not stale state) | Cached state |
| Farm mode | Always executes, never skips | Signal-gated |
| Rate limiting | Auto-backoff with retryAfter | Crash or retry loop |
| Learning | Self-adjusting weights per component | Stateless |
| Config | 70+ runtime params, no restart | Restart required |
| Analytics | 30+ dimensions per trade | Basic PnL only |
| Multi-exchange | SoDEX + Dango + Decibel | Single exchange |

---

<div align="center">

## 🎯 The DRIFT Advantage

**Three strategies. One system. Zero compromises on execution safety.**

🌾 Farm Mode — always active, always accumulating volume  
🧠 Trade Mode — signal-filtered, win-rate optimized  
⇄ Hedge Mode — correlation divergence, market-neutral  
🔄 Daily Reset — max loss + volume target, automated budget management, no babysitting  
🛡️ Execution engine — one action per tick, always safe

*Built for the future of decentralized perpetual trading*

</div>
