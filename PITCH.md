<div align="center">

# 🌊 DRIFT
## Dynamic Risk-Informed Futures Trading

*Intelligent execution meets adaptive learning — now with correlation hedging*

</div>

---

## What is DRIFT?

DRIFT is a multi-bot AI trading system for perpetual futures on **SoDEX**, **Dango**, and **Decibel**. It runs multiple strategies simultaneously: single-asset Farm/Trade bots and a dual-asset Hedge bot that exploits correlation divergence between BTC and ETH.

---

## Three Strategies, One System

### Farm Mode — Maximum Volume

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
4. Early profit: hold ≥ 60s AND pnl ≥ $0.4
5. Time exit: 2–8 minute hold with 30s grace period

### Trade Mode — Signal-Filtered Execution

When win rate matters more than volume:

1. Regime check (HIGH_VOLATILITY → skip if enabled)
2. Chop detection (chopScore ≥ 0.55 → skip)
3. Fake breakout filter (OB imbalance contradiction → skip)
4. Confidence ≥ 0.65 (calibrated against historical win rates)
5. 2-tick confirmation (60s window)

Exit: SL 5% or TP 5% — **no time pressure**.

### Hedge Mode — Correlation Divergence

The newest strategy. DRIFT simultaneously opens **long on one asset, short on the other** with equal USD notional. Profit comes from temporary divergence between correlated assets (BTC/ETH).

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
┌─────────────────────────────────────────────────────────────────────────┐
│                           DRIFT Multi-Bot System                        │
│                                                                         │
│  BotManager                                                             │
│  ├── BotInstance (Farm/Trade) × N                                       │
│  │   └── Watcher (5-state machine)                                      │
│  │       ├── AISignalEngine  ├── PositionSizer  ├── ExecutionEdge       │
│  │       ├── RegimeDetector  ├── MarketMaker    ├── FeedbackLoop        │
│  │       └── ChopDetector / FakeBreakoutFilter (trade only)             │
│  │                                                                       │
│  └── HedgeBot × N                                                       │
│      └── State Machine (6 states)                                       │
│          ├── VolumeMonitor (dual-symbol spike detection)                │
│          ├── AISignalEngine × 2 (one per symbol)                        │
│          └── Fill management (3 cases, 30s timeout)                    │
│                                                                         │
│  DashboardServer (Express + SSE)                                        │
│  TelegramManager (commands + alerts)                                    │
│  ConfigStore (70+ runtime params)                                       │
└─────────────────────────────────────────────────────────────────────────┘
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

**Zero-Downtime Config**: 70+ parameters tunable at runtime via dashboard. All changes validated before applying.

**Telegram Control**: start/stop bots, set max loss, switch modes, force close, real-time alerts.

**Graceful Shutdown**: SIGTERM/SIGINT handlers close open positions before exiting.

**Rate Limit Handling**: automatic backoff when exchange returns 429, respects `retryAfter` header.

**Docker**: `docker build -f Dockerfile -t drift:latest . && docker compose up -d`

---

## Summary

| Feature | DRIFT | Typical Bot |
|---|---|---|
| Strategies | Farm + Trade + Hedge | Single strategy |
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
🛡️ Execution engine — one action per tick, always safe

*Built for the future of decentralized perpetual trading*

</div>
