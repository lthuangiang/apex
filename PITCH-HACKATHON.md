# DRIFT — Dynamic Risk-Informed Futures Trading

*AI-powered perpetual futures trading with adaptive learning, intelligent execution, correlation hedging, and automated daily budget management*

## What it does

DRIFT is a multi-bot trading system for perpetual futures running three strategies simultaneously across SoDEX, Dango, and Decibel.

- **Farm Mode** — trades continuously to maximize volume incentives (SoPoints, rebates). Never skips — falls back to price position or mean reversion when signal is weak.
- **Trade Mode** — only enters on a clear edge: regime check → chop detection → fake breakout filter → confidence gate → 2-tick confirmation.
- **Hedge Mode** — simultaneously opens long on one asset and short on the other (BTC/ETH) with equal USD notional, profiting from temporary correlation divergence.
- **Daily Budget Reset** — two stop conditions per bot, whichever hits first: **max loss** and **volume target**. Set `dailyMaxLossUsd: 5` and `dailyTargetVolumeUsd: 5000` — bot stops at $5 loss or $5k volume, restarts fresh at 7 AM Vietnam (0:00 UTC). Configurable live from the dashboard.

Controlled via a real-time web dashboard and Telegram bot, with 70+ parameters tunable at runtime.

## The problem it solves

**1. Unsafe execution.** Bots place duplicate orders, create ghost positions, or cancel and place in the same tick. DRIFT enforces one-action-per-tick across all state machines.

**2. Single-strategy rigidity.** One bot does one thing. DRIFT runs Farm, Trade, and Hedge in parallel within one system.

**3. No learning from results.** Signal weights are static. DRIFT's feedback loop recalibrates weights every 10 trades based on per-component win rates.

**4. Manual daily management.** When a bot hits its loss limit, someone has to restart it the next day. `DailyResetScheduler` automates the full stop → reset → restart cycle.

## How the daily budget reset works

```
Bot: dailyMaxLossUsd=5, dailyTargetVolumeUsd=5000, dailyResetHourUTC=0
  │
  ├── sessionPnL hits -$5  → IOC close + stop  [MAX LOSS]
  ├── sessionVolume hits $5k → IOC close + stop  [VOLUME TARGET]
  │
  └── At 0:00 UTC (7:00 AM Vietnam):
        1. bot.stop()              — save state
        2. resetMaxLoss()          — clear flag
        3. resetVolumeTarget()     — clear flag
        4. setMaxLoss($5)          — fresh budget
        5. setTargetVolume($5k)    — fresh target
        6. bot.start()             — new session
        7. Telegram notify
```

Both stop checks run every tick, fire only once per session. The scheduler seeds `lastResetDate` on startup to avoid firing immediately. Each bot has its own independent scheduler.

## Challenges I ran into

**Hedge bot fill management.** Two simultaneous orders produce three states: both pending, one filled + one pending, one filled + one rejected — each with different 30s timeout and retry logic, all while enforcing one-action-per-tick.

**Exchange quirks.** SoDEX returns all positions regardless of `?symbol=` — filtered client-side; negative size = short. Decibel uses Ed25519 on Aptos. Dango uses GraphQL + Secp256k1. Same interface, completely different mechanics.

**Fee-aware Farm Mode.** Short holds mean fees eat the profit. Dynamic minimum hold time from live ATR and round-trip fee rate keeps net PnL positive.

**Live dashboard config for daily reset.** `PATCH /api/bots/:id/daily-reset` updates `bot.config`, calls `sm.setMaxLoss()` + `sm.setTargetVolume()` immediately, then swaps the running scheduler atomically via `bot.syncDailyResetScheduler()` — all before persisting to `bot-configs.json`.

## Technologies I used

- **SoDEX API** — orderbook, trades, perpetual klines, Post-Only orders, EIP-712 signing
- **SoSoValue API** — Fear & Greed Index as macro signal overlay
- **TypeScript / Node.js** — all core logic
- **Express + SSE** — real-time dashboard
- **Telegram Bot API** — remote control and alerts
- **@aptos-labs/ts-sdk + Ed25519** — Decibel (Aptos) signing
- **Secp256k1 + GraphQL** — Dango signing and queries
- **Docker + Docker Compose** — deployment
- **Vitest** — unit and property-based testing

## How we built it

**Adapter layer** — each exchange implements `ExchangeAdapter`. Bot logic is exchange-agnostic. SoDEX klines, orderbook, and trades feed every signal computation directly.

**State machine core** — `Watcher` (Farm/Trade) and `HedgeBot` enforce one-action-per-tick with a per-tick mutex. Each tick performs exactly one action then returns.

**AI Signal Engine** — parallel fetch: orderbook depth, recent trades, 5m klines (EMA9/21, RSI14, momentum), plus SoSoValue Fear & Greed. All price data from SoDEX.

**Feedback Loop** — tracks win rate per signal component, adjusts weights every 10 trades. Bounds: [0.05, 0.60], sum to 1.0.

**DailyResetScheduler** — `setInterval`-based, checks once per minute, fires once per day at the configured UTC hour, handles the full stop → reset → restart cycle.

## What we learned

**One-action-per-tick is non-negotiable.** Every serious bug traced back to doing two things in one tick.

**Never trust cached exchange state.** Query the exchange before closing or placing. Stale state causes ghost positions and duplicate orders.

**Fee impact matters more than win rate in Farm Mode.** A 70% win rate still loses money if hold time is too short. Dynamic minimum hold time from ATR and fee rate is mandatory.

**Operational automation scales, manual restarts don't.** Daily budget reset turns a multi-bot system into something that genuinely runs hands-free.

## What's next for DRIFT

**Funding fee arbitrage** — capture funding rate divergence across exchanges with a hedged position.

**Expanded correlation hedging** — extend beyond BTC/ETH to SOL/ETH, BTC/SOL with dynamic correlation tracking.

**Cross-exchange arbitrage** — detect and execute on price discrepancies between SoDEX, Dango, and Decibel.

**LLM-enhanced signal reasoning** — auditable per-trade reasoning from market context analysis.
