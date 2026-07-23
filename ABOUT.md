# DRIFT — Dynamic Risk-Informed Futures Trading

*Autonomous perpetual futures platform with 8-signal SoSoValue intelligence, Agent Layer orchestration, Kelly sizing, and 6-exchange execution*

## What it does

DRIFT is an autonomous multi-bot trading system for perpetual futures. An Agent Layer runs every 30 seconds, fetches 8 SoSoValue signals, classifies 1 of 8 market regimes, and selects the optimal strategy — no manual intervention.

- **Agent Layer** — orchestration brain: Observe → Classify → Select → Allocate → RiskGate → Emit
- **Farm Mode** — maximizes volume incentives, never skips, mean-reversion fallback
- **Trade Mode** — strict edge: regime + chop + breakout filter + confidence gate
- **Hedge Mode** — long/short paired positions (BTC/ETH) for correlation divergence
- **Daily Budget Reset** — max loss OR volume target stops bot, auto-restarts at 0:00 UTC

Runs across 6 DEXes (SoDEX, Dango, Decibel, Hibachi, OndoPerps, Perpl) with multi-wallet SaaS and real-time dashboard.

## The problem it solves

1. **Shallow data** — most bots use price only. DRIFT fuses 8 SoSoValue signals into conviction scoring.
2. **No auto strategy** — traders pick manually. Agent classifies regimes and switches every 30s.
3. **Unsafe execution** — one-action-per-tick with mutex prevents ghost positions.
4. **No portfolio risk** — RiskGate: max loss halt, exposure cap, consecutive loss cooldown.
5. **Single-exchange** — 6 DEXes, one unified adapter interface.

## How it works — Full Workflow

**Step 1: Signal Collection (every 30 seconds)**

The Intelligence Engine fetches 8 signals from SoSoValue in parallel:
- Fear & Greed Index → market-wide sentiment (0-100)
- BTC ETF Net Flows → institutional money moving in/out ($M/day)
- Futures Open Interest → leverage build-up across exchanges ($B)
- Funding Rate → retail bias (positive = longs paying shorts)
- Stablecoin Inflows → new capital entering or leaving crypto ($B)
- Macro Events → FOMC/CPI/NFP calendar with impact classification
- SSI Index → composite sector health score
- Sector Rotation → which crypto sectors lead vs lag (risk-on/off)

**Step 2: Conviction Scoring**

Signals are scored 0-100 per dimension, then blended with calibrated weights:
`conviction = sentiment×0.20 + institutional×0.25 + retail×0.15 + macro×0.12 + technical×0.10 + sector×0.18`

This produces a single conviction number that represents how strongly the market is leaning bullish, bearish, or neutral — based purely on SoSoValue data.

**Step 3: Regime Classification**

The engine classifies the current market into one of 8 regimes:
- bull_momentum (ETF inflows + positive funding + greed) → TRADE long
- bear_momentum (ETF outflows + negative funding + fear) → TRADE short
- accumulation (extreme fear + institutional buying) → contrarian long
- distribution (extreme greed + institutional selling) → contrarian short
- choppy_neutral (low conviction, balanced) → FARM volume
- pre_breakout (OI building, low vol) → FARM and wait
- overheated (funding > 1.5%) → STANDBY, protect capital
- capitulation (panic selling) → TRADE if institutional support

**Step 4: Strategy Selection + Kelly Sizing**

StrategySelector picks FARM, TRADE, BOTH, or HOLD based on regime scores and rolling 10-trade win rate. CapitalAllocator computes position size:
`size = base × confidence × performance × regimeFactor × drawdownGuard`

All clamped to [ORDER_SIZE_MIN, SIZING_MAX_BTC] with exposure cap enforcement.

**Step 5: Risk Gate**

Before any decision reaches the bots, RiskGate checks:
- Session PnL > -MAX_LOSS? (otherwise HALT)
- Total exposure < ExposureCap? (otherwise BLOCK)
- No 3 consecutive losses? (otherwise COOLDOWN 10min)
- Exit orders always pass — only entries are gated.

**Step 6: Execution**

The AgentDecision (strategy + direction + size) is emitted to idle bots. Each bot then independently manages entry timing, Post-Only order placement, SL/TP, and exit logic using its own Watcher state machine.

**Step 7: Adaptive Learning (feedback loop)**

When a trade closes, the result feeds back into the Agent:
- Win/loss recorded per strategy (Farm or Trade) → updates rolling 10-trade win rate
- RiskGate tracks consecutive losses → triggers cooldown if needed
- StrategySelector adjusts: if a strategy drops below 30% win rate over 10 trades, it enters 3-cycle cooldown
- Signal weights recalibrate every 10 trades via AdaptiveWeightAdjuster
- The system genuinely learns — poor-performing strategies get less capital, recovering strategies get re-enabled

This creates a closed loop: SoSoValue data → Agent decision → bot execution → trade result → Agent recalibrates → better next decision.

## Technologies

- **SoSoValue API** — 8 signals driving conviction scoring and regime classification
- **Agent Layer** — StrategySelector, CapitalAllocator (Kelly), RiskGate
- **6 Adapters** — SoDEX (EIP-712), Decibel (Ed25519), Dango (Secp256k1), Hibachi (ECDSA/HMAC), OndoPerps (HMAC-SHA256), Perpl (Ed25519/WebSocket)
- **TypeScript/Node.js, Express + SSE + Chart.js** — dashboard with live Agent panel
- **Multi-wallet SaaS** — AES-256-GCM credentials, SIWE auth, tenant isolation
- **Docker, Vitest + fast-check** — deployment and property-based testing

## What's next

- Delta Neutral cross-exchange funding rate arbitrage
- Social copy-trading (share Agent strategies as templates)
- On-chain strategy vault (tokenized AUM)
