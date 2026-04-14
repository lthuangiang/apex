# APEX — Adaptive Perpetual Execution

---

## What is APEX?

APEX is an AI-powered BTC perpetual futures trading bot built for **SoDEX**, **Dango**, and **Decibel**. It combines a hybrid signal engine, adaptive learning, and a pseudo market-making strategy to maximize both **volume accumulation** (Farm Mode) and **trading performance** (Trade Mode).

---

## Two Modes, One Bot

### Farm Mode — Maximum Volume

The core insight: SoDEX rewards volume. Farm Mode is designed to **always trade** — no signal can block execution.

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

**Cooldown**: adaptive — scales with losing streak and chop score, capped at 30 minutes.

---

## Full System Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           APEX Bot                                      │
│                                                                         │
│  bot.ts (SHIELD-BOT)                                                    │
│  ├── Watcher (State Machine)                                            │
│  │   IDLE → PENDING_ENTRY → IN_POSITION → PENDING_EXIT → IDLE          │
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
│  │   │  AdaptiveCool    │  │  fill rate   │  │  win rate data  │      │
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
              │
    Telegram + Dashboard
    (real-time control)
```

---

## Signal & Decision Flow

```
┌─────────────────────────────────────────────────────────────────────────┐
│                     Signal Decision Pipeline                            │
│                                                                         │
│  Binance 5m candles ──► EMA9/21, RSI, Momentum, OB Imbalance           │
│                              │                                          │
│                         WeightStore ──► adaptive weights (per 10 trades)│
│                              │                                          │
│                        momentumScore (0–1)                              │
│                              │                                          │
│                     RegimeDetector ──► ATR + BB + Volume                │
│                              │                                          │
│                    SIDEWAY range logic ──► pricePositionInRange         │
│                              │                                          │
│                         LLMClient ──► GPT-4o / Claude                  │
│                              │                                          │
│                    ConfidenceCalibrator ──► historical win rate         │
│                              │                                          │
│                         Signal output                                   │
│                    { direction, confidence, regime, score }             │
│                              │                                          │
│              ┌───────────────┴───────────────┐                         │
│         Farm Mode                       Trade Mode                      │
│              │                               │                          │
│    MM Bias (ping-pong +             Regime Gate                         │
│    inventory control)               ChopDetector                        │
│              │                      FakeBreakoutFilter                  │
│    ALWAYS ENTER                     Confidence Gate                     │
│              │                               │                          │
│              └───────────────┬───────────────┘                         │
│                              │                                          │
│                    PositionSizer                                        │
│                    conf × perf × volatility                             │
│                              │                                          │
│                    ExecutionEdge                                        │
│                    spread guard + dynamic offset                        │
│                              │                                          │
│                    Executor (Post-Only maker)                           │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Intelligence Stack

### 1. Adaptive Signal Weights

Signal weights are not static — they adjust every 10 trades based on per-component win rates:

```
if EMA_winRate > 60%  → EMA weight += 0.05
if RSI_lossStreak > 3 → RSI weight -= 0.05
```

Each component (EMA, RSI, momentum, orderbook imbalance) is tracked independently. Weights persist across restarts in `signal-weights.json`. Bounds: [0.05, 0.60] per component, always sum to 1.0.

### 2. SIDEWAY Range Intelligence

In SIDEWAY regime, the bot uses **price position in range** (0 = bottom, 1 = top of last 10 candles) internal to the signal engine:

```
pricePosition > 75% → momentumScore -= 0.08  (penalize long at range top)
pricePosition < 25% → momentumScore += 0.08  (penalize short at range bottom)
```

When LLM is unavailable in SIDEWAY, price position becomes the primary driver for signal direction:
- Price at range bottom (< 30%) → LONG (mean reversion)
- Price at range top (> 70%) → SHORT (mean reversion)

### 3. Dynamic Position Sizing

```
size = baseSize × clamp(confMult × 0.6 + perfMult × 0.4) × volatilityFactor
```

Scales up on winning streaks, scales down during drawdowns. Hard BTC cap + soft balance-% cap.

| Factor | Farm | Trade |
|---|---|---|
| confMult | dampened (0.5→1.0, 1.0→1.3) | full scale (MIN_CONF→1.0, 1.0→2.0) |
| perfMult | win rate × drawdown × profile | same |
| volatilityFactor | always 1.0 | from regime (0.5–1.0) |

### 4. Regime Detection

4 market states from ATR + Bollinger Band width + volume ratio:

| Regime | Entry edge | Size | Hold | SL buffer |
|---|---|---|---|---|
| TREND | 0.02 | 1.0× | 1.5× | 1.0× |
| SIDEWAY | 0.05 | 0.85× | 0.8× | 1.0× |
| HIGH_VOL | 0.08 | 0.5× | 0.7× | 1.5× |

Applied in Trade Mode only. Farm Mode always executes.

### 5. Anti-Chop Filtering (Trade Mode)

Three-component chop score:
```
chopScore = flipRate × 0.40 + momNeutrality × 0.35 + bbCompression × 0.25
```

Score ≥ 0.55 → skip entry. FakeBreakoutFilter additionally checks volume confirmation and orderbook imbalance for breakout-strength signals.

### 6. Execution Edge

Smart order placement:
```
offset = clamp(spreadBps × 0.3 + depthPenalty + fillRatePenalty, 0, 5)
```

- Spread guard: skip if spread > 10 bps
- Depth penalty: +$0.5 if top-5 book depth < $50k
- Fill rate feedback: +$1.0 if recent fill rate < 60% (ring buffer of 20 orders)

The bot self-corrects placement when orders aren't filling.

### 7. Farm Market Making

**Ping-pong**: after LONG exit → bias SHORT; after SHORT exit → bias LONG.

**Inventory control**: soft bias when net exposure > $50, hard block when > $150.

**Dynamic TP**: `min(max(spreadBps/10000 × price × 1.5, feeFloor), $2.0)` — always covers round-trip fees, adapts to live spread.

---

## Exchange Integrations

### SoDEX (Primary)

Every write operation uses EIP-712 typed data signing:
- Canonical JSON payload with strict field ordering (matching Go struct layout)
- `keccak256` hash → sign `ExchangeAction { payloadHash, nonce }`
- Normalize `v` from 27/28 → 0/1 (Go backend requirement)
- Monotonically increasing nonce prevents replay attacks
- All orders use `timeInForce = 4` (Post-Only) — 0.012% maker fee

**SoPoints Dashboard**: current tier, weekly volume, countdown, runtime token refresh.

### Dango Exchange

- GraphQL endpoint (not REST)
- Secp256k1 signing: SHA-256 hash of canonical SignDoc JSON
- Size in USD notional (auto-converted from BTC quantity)

### Decibel

- Aptos blockchain-based DEX
- Ed25519 signing via `@aptos-labs/ts-sdk`
- Post-Only order support

---

## Trade Analytics

Every trade is logged with 30+ dimensions:

```typescript
{
  // Signal context
  regime, momentumScore, ema9, ema21, rsi, imbalance,
  llmDirection, llmConfidence, llmMatchesMomentum,
  
  // Execution
  entryPrice, exitPrice, holdingTimeSecs, exitTrigger,
  
  // Economics
  pnl, grossPnl, feePaid, wonBeforeFee,
  
  // Sizing
  sizingConfMult, sizingPerfMult, sizingCombinedMult,
  
  // Market making
  mmPingPongBias, mmInventoryBias, mmDynamicTP, mmNetExposure
}
```

Analytics dashboard shows win rate by regime, confidence bucket, UTC hour, direction, and mode.

---

## Operational Features

**Zero-Downtime Config**: 70+ parameters tunable at runtime via dashboard. All changes validated before applying (41+ validation rules).

**Telegram Control**: start/stop, set max loss, switch modes, force close, real-time alerts.

**Graceful Shutdown**: SIGTERM/SIGINT handlers close open positions before exiting.

**Docker**: `docker compose up -d` for production deployment.

---

## Correctness & Testing

Property-Based Testing with `fast-check` across all phases:

```typescript
// Adaptive weights always sum to 1.0
∀ stats: adjustWeights(stats, w).sum ∈ [0.999, 1.001]

// Position size always within bounds
∀ input: computeSize(input).size ∈ [ORDER_SIZE_MIN, SIZING_MAX_BTC]

// Dynamic TP always covers fees
∀ price, spread: computeDynamicTP(price, spread) >= feeRoundTrip × 1.5

// Chop score always in [0, 1]
∀ signal, history: evaluate(signal, history).chopScore ∈ [0, 1]

// Adaptive cooldown always within bounds
∀ input: computeAdaptiveCooldown(input).cooldownMs ∈ [MIN_MINS × 60000, MAX_MINS × 60000]

// Regime never amplifies position size
∀ regime: getRegimeStrategyConfig(regime).volatilitySizingFactor ∈ (0, 1]

// SL never tightens from regime
∀ regime: getRegimeStrategyConfig(regime).slBufferMultiplier >= 1.0
```

---

## Stack

TypeScript / Node.js · Express · SQLite · Docker

OpenAI gpt-4o / Anthropic claude-sonnet · Vitest + fast-check

SoDEX REST API (EIP-712) · Dango GraphQL (Secp256k1) · Decibel Aptos (Ed25519)

---

## Summary

| Feature | APEX | Typical Bot |
|---|---|---|
| Farm mode | Always executes, never skips | Signal-gated |
| Fee awareness | Dynamic TP tied to live spread | Fixed target |
| SoPoints | Built-in tier tracking + token refresh | None |
| Execution | Dynamic offset + spread guard + fill feedback | Static best-bid/ask |
| Learning | Self-adjusting weights per component | Stateless |
| Config | 70+ runtime params, no restart | Restart required |
| Analytics | 30+ dimensions per trade | Basic PnL only |
| Multi-exchange | SoDEX + Dango + Decibel | Single exchange |

---

> APEX turns maker fee models and volume incentives into a systematic edge.
> Farm Mode ensures the bot is always active. Trade Mode ensures it's always smart.
