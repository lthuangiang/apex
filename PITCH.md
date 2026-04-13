# APEX — AI-Powered BTC Trading Bot
### Competition Pitch Document

---

## Problem Statement

Retail traders on perpetual futures exchanges face three compounding challenges:

1. **Signal noise** — technical indicators alone produce too many false signals, especially in sideways markets
2. **Fee erosion** — maker/taker fees (0.024% round-trip) silently kill profitability on high-frequency strategies
3. **No learning loop** — bots repeat the same mistakes because they have no memory of past trades

Existing solutions are either black-box (no transparency) or require expensive infrastructure. APEX solves all three with a fully open, self-improving architecture.

---

## Solution Overview

APEX is a production-grade BTC perpetual futures trading bot that combines:

- **Hybrid AI signal engine**: technical momentum scoring + cloud LLM reasoning
- **Self-improving memory**: local vector database learns from every trade
- **Fee-aware execution**: Post-Only maker orders, fee-adjusted TP targets
- **Real-time analytics**: win rate breakdown across regime, direction, confidence, and time-of-day
- **Zero-downtime config**: all parameters tunable at runtime via web dashboard

---

## Technical Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        APEX Core                            │
│                                                             │
│  Watcher (State Machine)                                    │
│  IDLE → PENDING_ENTRY → IN_POSITION → PENDING_EXIT → IDLE  │
│                                                             │
│  ┌──────────────────┐  ┌──────────────┐  ┌─────────────┐  │
│  │  AISignalEngine  │  │ RiskManager  │  │  Executor   │  │
│  │  EMA9/21 + RSI   │  │  TP/SL check │  │ Post-Only   │  │
│  │  + LLM decision  │  │  per tick    │  │ maker orders│  │
│  └──────────────────┘  └──────────────┘  └─────────────┘  │
│           │                                                 │
│  ┌──────────────────┐  ┌──────────────┐                    │
│  │  TradingMemory   │  │  Analytics   │                    │
│  │  ChromaDB+Ollama │  │  Engine      │                    │
│  │  (local, free)   │  │  (30+ dims)  │                    │
│  └──────────────────┘  └──────────────┘                    │
└─────────────────────────────────────────────────────────────┘
         │                          │
   SoDEX / Decibel            Telegram + Dashboard
   (BTC perpetuals)           (real-time control)
```

---

## Key Innovations

### 1. Hybrid Signal Engine

Most bots use either pure technical analysis OR pure AI. APEX uses both in a layered approach:

**Layer 1 — Momentum Score** (deterministic, fast):
```
score = (EMA9/21 trend × 0.40)
      + (RSI(14)       × 0.25)
      + (3-candle mom  × 0.20)
      + (OB imbalance  × 0.15)
      + candle pattern bonus (±5%)
```

**Layer 2 — LLM Reasoning** (contextual, adaptive):
- Receives full market context: indicators, regime, price position in range, L/S ratio, fee
- Returns `direction` + `confidence` + `reasoning` in structured JSON
- Supports OpenAI (gpt-4o) and Anthropic (claude-sonnet) interchangeably
- Graceful fallback to Layer 1 if LLM is unavailable

**Layer 3 — Signal Confirmation** (noise filter):
- Requires same direction on 2 consecutive ticks within 60 seconds
- Eliminates single-tick false signals without adding latency

### 2. Fee-Aware Strategy

Fee erosion is the silent killer of high-frequency strategies. APEX accounts for fees at every decision point:

- All orders are **Post-Only (maker)** — 0.012% per side vs 0.06% taker
- Farm mode TP target: `max(FARM_TP_USD, fee_round_trip × 1.5)` — never exit at a loss to fees
- Analytics tracks "fee losers" — trades that won gross but lost net after fees
- LLM prompt explicitly includes round-trip fee: "need clear momentum to profit above 0.024%"

### 3. Self-Improving Trading Memory

APEX includes a local AI memory system that learns from every completed trade:

- **Signal embedding**: converts market state to a 6-dimensional vector `[price, sma50, ls_ratio, ob_imbalance, buy_pressure, rsi]`
- **ChromaDB**: stores all trade vectors for cosine similarity search
- **Prediction**: for any new signal, retrieves 10 most similar past trades → computes historical win rate → feeds context to local Ollama (llama3) for decision
- **Fully local**: no API costs, no data leaving the server

This creates a feedback loop: the bot gets better at recognizing market conditions it has seen before.

### 4. Dual Operating Modes

**Farm Mode** — optimized for volume accumulation (SoPoints):
- High frequency, 2–5 minute holds
- Lower confidence threshold (0.55)
- Dynamic hold: waits for price recovery before exiting at a loss
- Targets SoDEX SoPoints tier progression

**Trade Mode** — optimized for win rate:
- Strict signal filtering (confidence ≥ 0.65)
- Pure TP/SL exits, no time pressure
- R:R = 1.5:1 (TP 0.3% / SL 0.2%)
- Regime-aware: reduces position bias against the trend

### 5. Multi-Dimensional Analytics

The analytics engine computes win rate across 30+ dimensions:

| Dimension | Purpose |
|---|---|
| By regime (TREND/SIDEWAY) | Identify which market conditions work |
| By confidence bucket | Validate LLM confidence calibration |
| By hour UTC | Find optimal trading windows |
| By direction (long/short) | Detect directional bias |
| Signal quality metrics | LLM vs momentum agreement rate |
| Fee impact analysis | Quantify fee erosion |
| Holding time distribution | Optimize farm mode timing |

---

## Exchange Integration

### SoDEX
- REST API with EIP-712 typed data signing (Ethereum-compatible)
- Full order lifecycle: place, cancel, position, balance
- SoPoints integration: tier tracking, weekly volume, countdown

### Decibel
- Aptos blockchain-based DEX
- Ed25519 signing via `@aptos-labs/ts-sdk`
- Post-Only order support

Both exchanges share a common `ExchangeAdapter` interface — adding new exchanges requires only implementing 9 methods.

---

## Operational Features

### Zero-Downtime Config
All trading parameters are tunable at runtime via the web dashboard without restarting the bot:
- Order sizes, TP/SL percentages, hold times, cooldowns
- Changes validated before applying, persisted to disk
- Rollback to defaults with one click

### Telegram Control
Full bot control via Telegram commands and inline buttons:
- Start/stop sessions, set max loss, switch modes
- Real-time position monitoring with one-tap close
- Automatic alerts on fills, stops, and errors

### Graceful Shutdown
- SIGTERM/SIGINT handlers close open positions before exiting
- State persisted to disk on every trade and on shutdown
- Dashboard shows last known state immediately on restart

---

## Correctness & Testing

APEX uses **Property-Based Testing (PBT)** with `fast-check` to verify formal correctness properties:

```typescript
// P1: Win rate always in [0, 1]
∀ trades: compute(trades).overall.winRate ∈ [0, 1]

// P2: wins + losses = total
∀ trades: breakdown.wins + breakdown.losses === breakdown.total

// P3: Analytics is pure (same input → same output)
compute(trades) deepEquals compute([...trades])

// P4: Fee relationship
∀ trade: trade.grossPnl ≈ trade.pnl + trade.feePaid

// P5: Signal embedding is deterministic
signalToEmbedding(s) deepEquals signalToEmbedding(s)

// P6: Embedding values in [0, 1]
∀ signal: signalToEmbedding(signal).every(v => v >= 0 && v <= 1)
```

Test coverage spans: signal engine, analytics computation, config validation, trading memory, and exchange adapter behavior.

---

## Roadmap (Planned Features)

### Signal Win Rate Optimizer
A filtering layer that wraps `AISignalEngine` with four independent gates:
- **Regime gate**: block trend signals unless confidence > threshold (addresses ~0% win rate in trending markets)
- **Hour filter**: block historically low-performing UTC hours
- **Confidence gate**: stricter threshold for fallback signals
- **LLM hint injection**: feed historical win rates back into the LLM prompt for self-calibration

### AI Alpha Execution Engine
Upgrade the execution layer with:
- Dynamic position sizing based on signal quality score
- Multi-symbol support (BTC + ETH + SOL)
- Cross-symbol correlation filtering

### Trade Analytics Reporting (in progress)
Extended analytics dashboard with:
- Interactive charts (win rate over time, regime heatmap)
- Signal quality trends
- Export to CSV/JSON

---

## Why APEX Wins

| Criterion | APEX | Typical Bot |
|---|---|---|
| Signal quality | Hybrid: TA + LLM + confirmation | TA only |
| Fee awareness | Built into every decision | Ignored |
| Learning | Self-improving memory (ChromaDB) | Stateless |
| Transparency | Full reasoning logged per trade | Black box |
| Adaptability | Runtime config, dual mode | Restart required |
| Exchange support | SoDEX + Decibel (pluggable) | Single exchange |
| Analytics | 30+ dimensions, PBT-verified | Basic PnL |

---

## Team & Stack

**Stack**: TypeScript / Node.js, Express, SQLite, ChromaDB, Ollama, Docker

**AI**: OpenAI gpt-4o / Anthropic claude-sonnet (cloud) + llama3 (local)

**Exchanges**: SoDEX (EVM), Decibel (Aptos)

**Testing**: Vitest + fast-check (property-based testing)

---

> APEX is not just a trading bot — it's a learning system that gets smarter with every trade.
