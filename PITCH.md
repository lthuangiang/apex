# APEX — Adaptive Perpetual Execution on SoDEX

---

## What is APEX?

APEX is an AI-powered BTC perpetual futures trading bot built **natively for SoDEX**. It combines a hybrid signal engine, adaptive learning, and a pseudo market-making strategy to maximize both **SoPoints accumulation** (Farm Mode) and **trading performance** (Trade Mode) — the two core incentives of the SoDEX ecosystem.

---

## Why SoDEX?

SoDEX's maker fee model (0.012% per side) and SoPoints reward system create a unique opportunity: a bot that trades frequently with Post-Only orders can accumulate SoPoints while staying profitable. APEX is designed around this exact mechanic.

**SoDEX-specific integrations:**
- Full **EIP-712 typed data signing** for all write operations
- **Post-Only orders** on every entry and exit — 0.012% per side, never taker
- **Spread-aware entry**: skip if spread > 10 bps to protect maker status
- **SoPoints dashboard**: real-time tier, weekly volume, countdown, runtime token refresh
- **Dynamic TP** tied to live spread — always covers round-trip fees

---

## Two Modes, One Bot

### Farm Mode — Maximum Volume for SoPoints

The core insight: SoDEX rewards volume. Farm Mode is designed to **always trade** — no signal can block execution.

```
signal = long/short → use it
signal = skip       → alternate direction (long ↔ short)
```

No confidence gate. No chop filter. No fake breakout check. The bot is always active.

**Exit logic:**
- SL: 5% hard stop
- TP: dynamic, tied to live spread (`spreadBps/10000 × price × 1.5`, min fee floor, max $2)
- Time exit: 2–5 minute hold, then exit regardless of PnL

**Pseudo Market Making:**
- Ping-pong: after LONG exit → bias SHORT; after SHORT exit → bias LONG
- Inventory control: soft bias when net exposure > $50, force rebalance when > $150
- Result: bot alternates sides, capturing spread on each leg

### Trade Mode — Signal-Filtered Execution

When the goal is win rate over volume, Trade Mode applies full filtering:

1. Regime check (HIGH_VOLATILITY → skip)
2. Chop detection (chopScore ≥ 0.55 → skip)
3. Fake breakout filter (OB imbalance contradiction → skip)
4. Confidence ≥ 0.65 (calibrated against historical win rates)
5. 2-tick confirmation (60s window)

Exit: SL 5% or TP 5% — no time pressure.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        APEX on SoDEX                            │
│                                                                 │
│  Watcher (State Machine)                                        │
│  IDLE → PENDING_ENTRY → IN_POSITION → PENDING_EXIT → IDLE      │
│                                                                 │
│  ┌──────────────────┐  ┌──────────────┐  ┌─────────────────┐  │
│  │  AISignalEngine  │  │PositionSizer │  │ ExecutionEdge   │  │
│  │  EMA+RSI+LLM     │  │ conf×perf×   │  │ spread guard +  │  │
│  │  adaptive wts    │  │ volatility   │  │ dynamic offset  │  │
│  └──────────────────┘  └──────────────┘  └─────────────────┘  │
│                                                                 │
│  ┌──────────────────┐  ┌──────────────┐  ┌─────────────────┐  │
│  │  FeedbackLoop    │  │RegimeDetect  │  │  MarketMaker    │  │
│  │  adaptive wts    │  │ ATR+BB+Vol   │  │ ping-pong +     │  │
│  │  per component   │  │ 4-state      │  │ inventory ctrl  │  │
│  └──────────────────┘  └──────────────┘  └─────────────────┘  │
│                                                                 │
│  ┌──────────────────┐  ┌──────────────┐                        │
│  │  ChopDetector    │  │  Analytics   │                        │
│  │  FakeBreakout    │  │  30+ dims    │                        │
│  │  AdaptiveCool    │  │              │                        │
│  └──────────────────┘  └──────────────┘                        │
└─────────────────────────────────────────────────────────────────┘
              │                        │
         SoDEX API               Telegram + Dashboard
    (EIP-712, Post-Only)        (real-time control)
```

---

## Intelligence Stack

### 1. Adaptive Signal Weights

Signal weights are not static — they adjust every 10 trades:

```
if EMA_winRate > 60%  → EMA weight += 0.05
if RSI_lossStreak > 3 → RSI weight -= 0.05
```

Each component (EMA, RSI, momentum, orderbook imbalance) is tracked independently. Weights persist across restarts in `signal-weights.json`.

### 2. SIDEWAY Range Intelligence

In SIDEWAY regime, the bot uses **price position in range** (0 = bottom, 1 = top of last 10 candles):

```
pricePosition > 75% → momentumScore -= 0.08  (penalize long at range top)
pricePosition < 25% → momentumScore += 0.08  (penalize short at range bottom)
```

When LLM is unavailable in SIDEWAY, price position becomes the primary signal:
- Price at range bottom (< 30%) → LONG (mean reversion)
- Price at range top (> 70%) → SHORT (mean reversion)

This prevents the bot from longing at the top or shorting at the bottom of a range — a common mistake in sideways markets.

### 2. Dynamic Position Sizing

```
size = baseSize × clamp(confMult × 0.6 + perfMult × 0.4) × volatilityFactor
```

Scales up on winning streaks, scales down during drawdowns. Hard BTC cap + soft balance-% cap.

### 3. Regime Detection

4 market states from ATR + Bollinger Band width + volume ratio:

| Regime | Entry edge | Size | Hold | SL buffer |
|---|---|---|---|---|
| TREND | 0.02 | 1.0× | 1.5× | 1.0× |
| SIDEWAY | 0.05 | 0.85× | 0.8× | 1.0× |
| HIGH_VOL | 0.08 | 0.5× | 0.7× | 1.5× |

Applied in Trade Mode only. Farm Mode always executes.

### 4. Execution Edge

Smart order placement for SoDEX's maker model:

```
offset = clamp(spreadBps × 0.3 + depthPenalty + fillRatePenalty, 0, 5)
```

- Spread guard: skip if spread > 10 bps
- Depth penalty: +$0.5 if top-5 book depth < $50k
- Fill rate feedback: +$1.0 if recent fill rate < 60% (ring buffer of 20 orders)

The bot self-corrects placement when orders aren't filling.

### 5. Signal Cache

LLM calls cached for 60 seconds. Cache invalidated after each entry. Result: LLM called at most once per minute — reduces cost and 429 errors.

---

## SoDEX Integration Details

### EIP-712 Signing

Every write operation uses EIP-712 typed data signing:
- Canonical JSON payload with strict field ordering (matching Go struct layout)
- `keccak256` hash → sign `ExchangeAction { payloadHash, nonce }`
- Normalize `v` from 27/28 → 0/1 (Go backend requirement)
- Monotonically increasing nonce prevents replay attacks

### Post-Only Execution

All orders use `timeInForce = 4` (Post-Only):
- Entry: `best_bid - dynamicOffset` (long) or `best_ask + dynamicOffset` (short)
- Exit: `best_ask` (long exit) or `best_bid` (short exit)
- Force close only: IOC for emergency exits

### SoPoints Dashboard

Built into the web dashboard:
- Current tier (Bronze/Silver/Gold/Diamond) with progress bar
- Weekly trading volume vs tier requirements
- Countdown to next distribution
- Token refresh at runtime — no restart needed

---

## Operational Features

**Zero-Downtime Config**: 70+ parameters tunable at runtime via dashboard. All changes validated before applying.

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
```

---

## Stack

TypeScript / Node.js · Express · SQLite · Docker

OpenAI gpt-4o / Anthropic claude-sonnet · Vitest + fast-check

SoDEX REST API (EIP-712) · Decibel (Aptos, secondary)

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

---

> APEX turns SoDEX's maker fee model and SoPoints incentives into a systematic edge.
> Farm Mode ensures the bot is always active. Trade Mode ensures it's always smart.
