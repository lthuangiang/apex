# DRIFT — Dynamic Risk-Informed Futures Trading

*An AI-powered perpetual futures trading system with adaptive learning, intelligent execution, correlation hedging, and automated daily budget management*

## What it does

DRIFT is a multi-bot trading system for perpetual futures running three strategies simultaneously across SoDEX, Dango, and Decibel.

- **Farm Mode** — trades continuously to maximize volume incentives (SoPoints, rebates). Never skips — falls back to price position and mean reversion when the signal is weak.
- **Trade Mode** — only enters on a clear edge, passing through five filters: regime check, chop detection, fake breakout filter, confidence gate, and 2-tick confirmation.
- **Hedge Mode** — simultaneously opens long on one asset and short on the other (BTC/ETH) with equal USD notional, profiting from temporary correlation divergence.
- **Daily Budget Reset** — each bot automatically resets its max loss budget and restarts at a configured UTC time every day. Set `dailyMaxLossUsd: 5` and the bot trades all day, stops when it hits $5 loss, then comes back fresh at 7 AM Vietnam time (0:00 UTC) without any manual intervention.

The system is controlled via a real-time web dashboard and Telegram bot, with 70+ parameters tunable at runtime without a restart.

## The problem it solves

Most trading bots share four problems:

**1. Unsafe execution.** Bots place duplicate orders, create ghost positions, or cancel and place in the same tick — leading to uncontrolled losses.

**2. Single-strategy rigidity.** One bot does one thing. You can't farm volume and trade signals simultaneously. Hedging requires a separate system.

**3. No learning from results.** Signal weights are static and never adjust to actual win rates. A bot that works today can quietly degrade next week.

**4. Manual daily management.** When a bot hits its loss limit and stops, someone has to manually restart it the next day with a fresh budget. At scale across multiple bots, this becomes a daily operational burden.

DRIFT addresses all four: a strict one-action-per-tick state machine eliminates race conditions, three strategies run in parallel within one system, an adaptive feedback loop recalibrates signal weights every 10 trades, and the `DailyResetScheduler` automates the daily restart cycle entirely.

## How the daily budget reset works

```
Bot running with dailyBudgetReset: true, dailyMaxLossUsd: 5, dailyResetHourUTC: 0
  │
  ├── Bot trades normally during the day
  ├── If sessionPnL hits -$5 → bot stops (max loss protection)
  │
  └── At 0:00 UTC (7:00 AM Vietnam):
        DailyResetScheduler fires (once per day, first minute only):
          1. bot.stop()           — clean shutdown, state saved to disk
          2. resetMaxLoss()       — clears the max-loss-triggered flag
          3. setMaxLoss($5)       — fresh $5 budget for the new day
          4. bot.start()          — new session begins automatically
          5. Telegram notification — "🔄 Daily Budget Reset — $5 budget, bot restarted"
```

The scheduler seeds `lastResetDate` on startup to avoid firing immediately on boot. Each bot has its own independent scheduler — different bots can reset at different hours.

## Challenges I ran into

**Hedge bot fill management.** Placing two orders simultaneously produces three possible states: both pending, one filled and one pending, or one filled and one rejected. Each requires different handling with a 30-second timeout and retry logic — all while enforcing one-action-per-tick.

**Exchange quirks.** SoDEX returns all positions regardless of the `?symbol=` query, so filtering happens client-side; negative size means short. Decibel uses Ed25519 on Aptos with Gas Station. Dango uses GraphQL with Secp256k1. Same interface, completely different mechanics underneath.

**Fee-aware trading in Farm Mode.** Farm Mode needs high frequency for volume, but holding too briefly means fees eat the profit. A dynamic minimum hold time derived from live ATR and the actual round-trip fee rate was required to keep net PnL positive.

**Daily reset without disrupting the scheduler.** The `stop()` method is called both during daily reset (temporary) and during full system shutdown (permanent). These need different behavior — daily reset must not kill the scheduler, but SIGTERM must. Solved by adding a `stopScheduler` parameter: `bot.stop()` for daily reset, `bot.stop(true)` for full shutdown.

## Technologies I used

- **SoDEX API** — primary venue and data source: orderbook, recent trades, mark price, perpetual klines (OHLCV), Post-Only orders with EIP-712 signing
- **SoSoValue API** — macro sentiment layer: Fear & Greed Index fed into signal confidence scoring
- **TypeScript / Node.js** — all core logic
- **Express + SSE** — real-time dashboard
- **Telegram Bot API** — remote control and alerts
- **@aptos-labs/ts-sdk + Ed25519** — Decibel (Aptos) signing
- **Secp256k1 + GraphQL** — Dango signing and queries
- **Docker + Docker Compose** — deployment
- **Vitest** — unit and property-based testing

## How we built it

Started with a single SoDEX bot, then refactored into a modular architecture:

**Adapter layer** — each exchange implements a shared `ExchangeAdapter` interface. Bot logic is exchange-agnostic. SoDEX is the primary venue — its klines, orderbook, and trades feed every signal computation directly.

**State machine core** — `Watcher` (Farm/Trade) and `HedgeBot` are strict state machines. Each tick performs exactly one action then returns. A per-tick mutex prevents overlap.

**AI Signal Engine** — fetches in parallel: SoDEX orderbook depth, SoDEX recent trades, SoDEX perpetual klines (5m, 30 candles) for EMA9/21, RSI14, and momentum, plus SoSoValue Fear & Greed as a macro overlay. All price data comes from SoDEX — no external price feed needed.

**Feedback Loop** — tracks win rate per signal component, adjusts weights every 10 trades, and calibrates confidence against actual outcomes.

**DailyResetScheduler** — a lightweight `setInterval`-based scheduler that checks once per minute, fires exactly once per day at the configured UTC hour, and handles the full stop → reset → restart cycle. Integrated into `BotInstance` constructor when `dailyBudgetReset: true`.

## What we learned

**One-action-per-tick is non-negotiable.** Every serious bug traced back to doing two things in one tick. Enforcing strict separation eliminated an entire class of race conditions.

**Never trust cached exchange state.** Before closing a position, query the exchange again. Before placing an order, check open orders. Stale state causes ghost positions and duplicate orders.

**In Farm Mode, fee impact matters more than win rate.** A 70% win rate still loses money if hold time is too short. Dynamic minimum hold time derived from ATR and fee rate is mandatory. Trade Mode is the opposite — fees are secondary since positions run to a 5% TP or SL.

**Adaptive weights need hard bounds.** Without constraints, one component dominates and kills signal diversity. Bounding to `[0.05, 0.60]` with sum-to-1.0 keeps the system stable.

**Operational automation is as important as trading logic.** A bot that requires daily manual restarts doesn't scale. The daily budget reset feature turns a multi-bot system into something that genuinely runs hands-free.

## What's next for DRIFT

**Funding fee arbitrage** — detect funding rate divergence across exchanges and capture it with a hedged position.

**Expanded correlation hedging** — extend beyond BTC/ETH to SOL/ETH, BTC/SOL with dynamic correlation tracking.

**Cross-exchange arbitrage** — detect and execute on price discrepancies between SoDEX, Dango, and Decibel automatically.

**LLM-enhanced signal reasoning** — use LLM to analyze market context and produce auditable reasoning per trade decision.

**Dashboard daily reset controls** — expose `forceReset()` and reset schedule configuration directly in the bot settings UI.
