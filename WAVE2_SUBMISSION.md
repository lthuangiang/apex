# DRIFT — Wave 2 Submission
## SoSoValue Buildathon 2026

---

## 1. Project Overview

### Project Name
**DRIFT — Dynamic Risk-Informed Futures Trading**

### Short Description
DRIFT is an AI-powered multi-bot perpetual futures trading system that integrates **SoSoValue's macro intelligence ecosystem** (Fear & Greed Index, BTC ETF Flow, Macro Events Calendar) to dynamically adjust trading behavior in real time. It runs multiple bots in parallel across **4 exchanges** (SoDEX, Dango, Decibel, Hibachi) with **3 distinct strategies**: Farm Mode (maximize volume/SoPoints), Trade Mode (maximize win rate), and Hedge Bot (correlation divergence). The system is built as a **multi-wallet SaaS platform** where each wallet address gets isolated bot instances, encrypted credentials, and independent configuration.

### Target Users

**Primary:**
- Individual traders and small teams who want automated perpetual futures execution without managing infrastructure manually
- SoDEX power users farming SoPoints and volume rebates
- Crypto-native operators who want a self-hosted, wallet-scoped trading system they fully control

**Secondary:**
- Builders exploring agentic finance — DRIFT demonstrates the "one-person business empire" model: one operator running multiple bots across multiple exchanges with AI-driven macro intelligence
- Developers researching adaptive trading systems with feedback loops and macro sentiment overlays

---

## 2. Core Logic, APIs, and Data Sources

### SoSoValue API Integration (Primary Intelligence Layer)

**Three signals combined via geometric mean:**

**1. Fear & Greed Index**
- Endpoint: `GET /analyses` + `GET /analyses/{chart_name}`
- Cache: 15 minutes
- Fallback: alternative.me
- Output: 0-100 sentiment score

**2. BTC ETF Flow**
- Endpoint: `GET /etfs/summary-history?symbol=BTC&limit=3`
- Cache: 4 hours
- Tracks: Daily net inflow + 3-day cumulative
- Classification: `strong_bull` (>$500M) → `strong_bear` (<-$300M)

**3. Macro Events Calendar**
- Endpoint: `GET /macro/events`
- Cache: 1 hour
- Impact levels: HIGH (FOMC, CPI, NFP), MEDIUM (PMI, jobless claims), LOW
- Triggers hard size caps: 30% if high-impact event today, 60% if tomorrow

**Strategy Table:**

```
Fear & Greed < 25  → aggressive_farm: conf×0.85, size×1.15 (buy the dip)
Fear & Greed 25–45 → normal_farm:     conf×0.95, size×1.0
Fear & Greed 45–55 → balanced:        conf×1.0,  size×1.0
Fear & Greed 55–75 → cautious_trade:  conf×1.1,  size×0.9  (avoid FOMO)
Fear & Greed > 75  → defensive:       conf×1.2,  size×0.8

ETF + F&G combined → geometricMean(fgMult, etfMult)
Macro guard        → hard cap overrides all multipliers
```

---

### Exchange APIs Integrated

**SoDEX** (primary execution venue)
- Full order lifecycle: place, cancel, query positions, balance
- EIP-712 typed data signing
- Post-Only orders, 0.012% maker fee
- Orderbook (20 levels), recent trades (100), OHLCV klines (30 candles, 5m)

**Dango**
- Secp256k1 signing + GraphQL API
- USD notional sizing
- Per-order price precision handling

**Decibel**
- Ed25519 (Aptos SDK)
- Gas Station for transaction fee management
- Per-order cancel support

**Hibachi** (Wave 2 addition)
- Dual signing modes: ECDSA (trustless) + HMAC-SHA256 (exchange-managed)
- Private key never stored as class field
- Monotonic nonce (millisecond precision)

---

### AI Signal Engine Architecture

**Data sources fetched in parallel:**
- Orderbook (20 levels) from exchange adapter
- Recent trades (100) from exchange adapter
- OHLCV klines (30 candles, 5m interval) from SoDEX/Hibachi API, fallback to Binance futures
- Built-in sentiment composite: trade pressure (40%) + OB imbalance (40%) + volume spike (20%)

**Momentum calculation with adaptive weights:**
```
EMA9 vs EMA21: ~40% weight (0.65 if bullish, 0.35 if bearish)
RSI(14):       ~25% weight (0.75 if oversold, 0.25 if overbought)
3-candle mom:  ~20% weight ((currentPrice - closes[-4]) / closes[-4] × 50 + 0.5)
OB imbalance:  ~15% weight ((bidVol/askVol - 1) × 0.5 + 0.5)
```

Weights auto-adjust every 10 trades via feedback loop tracking win rate per component.

**SoSoValue overlay applied post-calculation:**
```
finalConfidence = baseConfidence × sentimentMultiplier × macroGuard
```

---

## 3. Public GitHub Repository

**Repository:** https://github.com/junxnone/apex

**README Features:**
- Full English + Vietnamese bilingual documentation
- Architecture diagrams (system design, dashboard screenshots)
- Strategy explanations (Farm, Trade, Hedge)
- Configuration reference (70+ runtime parameters)
- Docker setup with docker-compose.yml

**Setup Instructions:**
```bash
git clone https://github.com/junxnone/apex
cd apex
cp .env.example .env
# Edit .env: add SOSOVALUE_API_KEY, exchange credentials
npm install
npm start              # development mode
# or
docker-compose up -d   # production deployment
```

---

## 4. Live Demo

**URL:** https://drift.junxcrypto.xyz/landing

**Dashboard Features:**
- **Multi-bot manager view** — real-time PnL, volume, win rate per bot
- **Bot detail page** — AI Signal Engine panel showing:
  - Current regime (SIDEWAY/TREND/HIGH_VOL)
  - Fear & Greed macro pill with live index value
  - Size multiplier from SoSoValue strategy
  - Signal direction (LONG/SHORT)
  - Chop score (trade mode filter)
  - Confidence bar with color-coded threshold
  - Full signal pipeline gate trace (7 gates for Farm, 6 gates for Trade)
- **Analytics tab** — win rate by regime, signal quality metrics, fee impact analysis, confidence distribution histogram, hold time distribution
- **Bot settings modal** — 70+ runtime parameters adjustable without restart, with live validation
- **Daily budget reset** — max loss and volume target configuration per bot
- **Wallet login** — WalletConnect/AppKit for tenant isolation

**Demo accessible without wallet login** — read-only guest mode available for judges to review dashboard.

---

## 5. Video Introduction

**Video URL:** https://www.awesomescreenshot.com/video/53125121?key=7a348b7e94bdf641f692b65025049bdf

**Video walkthrough covers:**
- System overview and architecture
- SoSoValue macro intelligence integration in action — Fear & Greed driving confidence/size multipliers
- Live bot dashboard — manager view and bot detail page
- AI Signal Engine panel — regime detection, macro sentiment pills, confidence bar, pipeline flow
- Farm Mode signal pipeline execution with 7-gate filtering
- Trade Mode high win-rate strategy with chop detection
- Daily budget reset configuration and Telegram notifications
- Multi-wallet SaaS tenant flow — wallet connect, credential encryption, bot isolation

---

## 6. Team Information

**Team:** Solo developer

**Contact:**
- GitHub: @junxnone
- Email: [your email]
- Discord: [your discord handle]
- Telegram: [your telegram handle]

---

## 7. Wave 2 Progress Update

### What Was Built in Wave 2

**📺 Live Demo:** https://drift.junxcrypto.xyz/landing
**🎥 Video Walkthrough:** https://www.awesomescreenshot.com/video/53125121?key=7a348b7e94bdf641f692b65025049bdf

---

**A. SoSoValue Integration — From Overlay to Ecosystem Core**

Wave 1 used Fear & Greed as basic multiplier. Wave 2 implements **3-signal combination**:

**Three signals combined via geometric mean:**
- Fear & Greed Index (sentiment baseline) — 15min cache, fallback to alternative.me
- BTC ETF Flow (institutional money) — tracks $500M bull / -$300M bear thresholds
- Macro Events (risk guard) — FOMC/CPI/NFP trigger 30% hard size cap

**Applied to two points:**
- AISignalEngine → confidence multiplier
- PositionSizer → size multiplier

**5-tier strategy table:**
```
F&G < 25  → aggressive (conf×0.85, size×1.15) — buy dip
F&G 25-45 → normal    (conf×0.95, size×1.0)
F&G 45-55 → balanced  (conf×1.0,  size×1.0)
F&G 55-75 → cautious  (conf×1.1,  size×0.9)  — avoid FOMO
F&G > 75  → defensive (conf×1.2,  size×0.8)
```

**Impact:** Addresses Wave 1 judge feedback "SoSoValue integration seems light" — now central to every trade decision.

---

**B. Hibachi Exchange Adapter — Fourth Exchange Complete**

`src/adapters/hibachi_adapter.ts` (478 lines)

- Dual signing: ECDSA (trustless) + HMAC-SHA256 (managed)
- Private key never stored as class field
- 3 test files: unit, signing verification, integration
- Completes 4-exchange matrix (SoDEX, Dango, Decibel, Hibachi)

---

**C. Multi-Wallet SaaS — From Single-Bot to Platform**

**Architecture:**
- TenantRegistry — wallet → isolated bot instances
- AES-256-GCM credential encryption (96-bit IV, 128-bit auth tag)
- SIWE authentication (24h JWT token)
- Per-wallet data: `./data/{wallet}/bot-configs.json` + `credentials.enc`

**Flow:** Connect wallet → auto-create tenant → decrypt credentials → start bots → persist on shutdown

**Test coverage:** 7 files including property-based testing

**Impact:** Makes DRIFT accessible to anyone with wallet — no manual config required.

---

**D. Backtest Infrastructure — Strategy Validation**

**Components:**
- HistoricalDataFeed — loads OHLCV from cache/API (1m to 1d intervals)
- BacktestAdapter — simulates exchange with maker fees
- BacktestRunner — drives tick loop with historical candles
- MetricsCollector — Sharpe, drawdown, win rate, equity curve
- API endpoint: `POST /api/bots/:id/backtest` (max 30 days)
- Frontend UI — date picker, metrics cards, equity chart

**Limitation:** No historical SoSoValue data — backtest runs without F&G filter (noted as Wave 3 enhancement).

---

### Wave 1 → Wave 2 Key Improvements

| Aspect | Wave 1 | Wave 2 |
|--------|--------|--------|
| SoSoValue | 1 signal | 3 signals (F&G + ETF + Macro) |
| Exchanges | 3 | 4 (+ Hibachi) |
| Architecture | Single-bot | Multi-wallet SaaS |
| Security | Env vars | AES-256-GCM encryption |
| Live demo | None | drift.junxcrypto.xyz |
| Docs | Vietnamese | Bilingual (EN + VI) |
| Testing | Basic | 18+ files, property-based |
| Validation | None | Full backtest system |

---

### Wave 3 Targets — Validation & Transparency

**SoSoValue Impact Verification:** Impact Report dashboard showing win rate with/without SoSoValue filters, drawdown reduction from macro guard, size multiplier correlation with F&G index. A/B backtest engine running parallel backtests (baseline vs enhanced) with side-by-side equity curves.

**Public Verification:** Trade export API (`GET /api/public/trades/{wallet}`) returning CSV/JSON with timestamps, PnL, regime, F&G index. 1-week paper trading on testnet with daily published results and public dashboard at `/paper-trading`.

**Historical Data Integration:** Implement historical F&G index cache for accurate backtests. Replay with actual macro events from past dates. Validate performance during 2024 Q4 rally and 2025 Q1 correction.

**Multi-Strategy Portfolio:** Run Farm + Trade + Hedge in coordinated mode with platform-wide risk limits and correlation-aware sizing across symbols.

---

### Wave 4 Targets — Scale & Production

**Multi-Chain Expansion:** Deploy on Base L2 and Arbitrum for lower fees. Cross-chain position aggregation with unified PnL view. Chain-specific strategy optimization based on gas costs and liquidity.

**Advanced AI:** RL-based position sizing trained on historical data. Multi-symbol portfolio optimization with correlation hedging across BTC/ETH/SOL. Adaptive regime detection ML model. Self-improving feedback loop adjusting weights based on 30-day performance.

**Community Features:** Public leaderboard ranked by Sharpe/win rate (opt-in). Strategy marketplace for monetizing custom signal engines. Signal sharing API for macro sentiment reads. Discord/Telegram alerts for high-confidence setups.

**Production Hardening:** Auto-recovery for stuck orders and connection loss. Circuit breakers for rapid drawdown (>5% in 10min) or API errors. Multi-region deployment (US/EU/Asia) for 99.9% uptime.

**Business Model:** Tiered subscription (Free/Pro $49/Enterprise). White-label API for institutions. Revenue share with top strategists. SoSoValue partnership for co-marketing.

---

## Submission Checklist

✅ **Required:**
- ✅ Genuinely integrated SoSoValue API (3 endpoints, 3 signals)
- ✅ Clear use case (automated perpetual futures with macro intelligence)
- ✅ Complete flow from data input to output (signal → filter → size → execute → track)
- ✅ Verifiable demo (live URL + video)
- ✅ Documentation (bilingual README, architecture diagrams)

⭐ **Bonus:**
- ✅ SoDEX API integration (primary execution venue)
- ✅ AI-enhanced functionality (adaptive weights, sentiment overlay, chop detection)
- ✅ Opportunity discovery (regime detection, volume spike monitoring)
- ✅ Risk control (daily budget reset, macro guard, SL/TP logic)
- ✅ Complete flow from insight to action (SoSoValue → AI signal → execution → P&L tracking)
- ✅ Better product experience (dashboard, Telegram bot, wallet login, multi-bot manager)

---

**End of Wave 2 Submission**
