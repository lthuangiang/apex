# DRIFT Walkthrough — Hướng Dẫn Đầy Đủ

Tài liệu này hướng dẫn chi tiết toàn bộ hệ thống DRIFT từ setup đến vận hành, bao gồm cả 3 chiến lược (Farm, Trade, Hedge) và các khái niệm quan trọng.

---

## Mục Lục

1. [Bắt Đầu Nhanh](#bắt-đầu-nhanh)
2. [Kiến Trúc Hệ Thống](#kiến-trúc-hệ-thống)
3. [Cấu Hình](#cấu-hình)
4. [Ba Chiến Lược Trading](#ba-chiến-lược-trading)
5. [AI Signal Engine](#ai-signal-engine)
6. [Execution Safety](#execution-safety)
7. [Dashboard & Giám Sát](#dashboard--giám-sát)
8. [Điều Khiển Telegram](#điều-khiển-telegram)
9. [Quản Lý Multi-Bot](#quản-lý-multi-bot)
10. [Xử Lý Sự Cố](#xử-lý-sự-cố)

---

## Bắt Đầu Nhanh

### Prerequisites

- Node.js 18+ or Docker
- API keys for at least one exchange (SoDEX, Dango, or Decibel)
- Telegram bot token (optional but recommended)
- OpenAI API key (for LLM-enhanced signals)

### Installation

```bash
# Clone and install
git clone <repo-url>
cd drift
npm install

# Configure environment
cp .env.example .env
# Edit .env with your API keys

# Start the bot
npm start
```

### Docker Setup

```bash
cp .env.example .env
# Edit .env with your credentials

docker build -f Dockerfile -t drift:latest .
docker compose up -d
```

Dashboard will be available at `http://localhost:3000`

---

## System Architecture

DRIFT uses a **multi-bot architecture** with two operational modes:

### Single-Bot Mode (Legacy)
One `Watcher` instance managing one symbol on one exchange. Configured via `.env` file.

### Multi-Bot Mode (Recommended)
`BotManager` orchestrates multiple `BotInstance` objects, each with its own:
- Exchange adapter
- Symbol
- ConfigStore (isolated config overrides)
- State tracking (PnL, volume, trades)

**Key Components:**

```
BotManager
├── BotInstance (Farm/Trade) × N
│   ├── Watcher (5-state machine)
│   │   ├── AISignalEngine
│   │   ├── PositionSizer
│   │   ├── ExecutionEdge
│   │   ├── MarketMaker
│   │   ├── RegimeDetector
│   │   ├── ChopDetector (trade mode)
│   │   └── FakeBreakoutFilter (trade mode)
│   ├── ConfigStore (per-bot overrides)
│   └── SessionManager
│
├── HedgeBot × N
│   ├── VolumeMonitor (dual-symbol spike detection)
│   ├── AISignalEngine × 2 (one per symbol)
│   └── State Machine (6 states)
│
├── DashboardServer (Express + SSE)
├── TelegramManager
└── TradeLogger (JSON or SQLite)
```

---

## Configuration

### Environment Variables

**Exchange Selection:**
```env
EXCHANGE=sodex          # sodex | dango | decibel
SYMBOL=BTC-USD
```

**SoDEX:**
```env
SODEX_API_KEY=your_api_key
SODEX_API_SECRET=0x...
SODEX_SUBACCOUNT=0x...
```

**Decibel (Aptos):**
```env
DECIBELS_PRIVATE_KEY=0x...
DECIBELS_NODE_API_KEY=...
DECIBELS_SUBACCOUNT=0x...
DECIBELS_BUILDER_ADDRESS=0x...
DECIBELS_GAS_STATION_API_KEY=...
```

**Dango:**
```env
DANGO_PRIVATE_KEY=0x...
DANGO_USER_ADDRESS=0x...
DANGO_NETWORK=mainnet
```

**Telegram:**
```env
TELEGRAM_BOT_TOKEN=...
TELEGRAM_CHAT_ID=...
```

**LLM (Optional):**
```env
LLM_PROVIDER=openai
OPENAI_API_KEY=sk-...
```

### Runtime Config (Dashboard)

70+ parameters can be adjusted at runtime via the dashboard without restarting:

**Farm Mode:**
- `FARM_SIDEWAY_MIN_CONFIDENCE` (0.01–0.60)
- `FARM_TREND_MIN_CONFIDENCE` (0.01–0.60)
- `FARM_MIN_HOLD_SECS` (60–600)
- `FARM_MAX_HOLD_SECS` (120–900)
- `FARM_TP_USD` (0.1–5.0)
- `FARM_COOLDOWN_SECS` (10–120)

**Trade Mode:**
- `MIN_CONFIDENCE` (0.50–0.90)
- `COOLDOWN_MIN_MINS` (1–30)
- `COOLDOWN_MAX_MINS` (2–60)

**Market Making:**
- `MM_ENABLED` (true/false)
- `MM_INVENTORY_SOFT_LIMIT_USD` (10–500)
- `MM_INVENTORY_HARD_LIMIT_USD` (50–1000)

**Risk:**
- `SL_PERCENT` (1–10)
- `TP_PERCENT` (1–20)
- `MAX_POSITION_SIZE_USD` (10–10000)

All changes are validated and persisted to `config-overrides.json`.

---

## Three Trading Strategies

### 1. Farm Mode — Maximum Volume

**Goal:** Generate maximum trading volume for SoPoints/rebates on volume-incentive DEXes.

**Philosophy:** Always trade. Never skip an opportunity.

**Entry Logic:**

```
1. Get signal from AISignalEngine
2. Run filter pipeline:
   [1] RegimeConfidenceThreshold — SIDEWAY ≥ threshold, TREND ≥ threshold
   [2] TradePressureGate — skip if pressure=0 AND confidence too low
   [3] FallbackQualityGate — skip if fallback signal with very low confidence
   [4] FeeAwareEntryFilter — skip if expected edge < fee cost
   [5] LLMMomentumAdjuster — boost/penalty based on LLM alignment
   [6] MinHoldTimeEnforcer — compute dynamic hold time from ATR

3. Direction resolution (NEVER skip):
   - pricePosition > 0.65 → SHORT (price near range top)
   - pricePosition < 0.35 → LONG (price near range bottom)
   - Mid-range → use adjustedMomentumScore
   - Fallback → alternate with previous trade (long ↔ short)

4. Market Maker bias (if MM_ENABLED):
   - Ping-pong: after LONG → bias SHORT next
   - Inventory control: soft/hard limits on net exposure

5. Place limit order (Post-Only for maker fee)
```

**Exit Logic (priority order):**

1. **SL 5%** — hard stop loss
2. **Dynamic TP** (MM enabled) — based on live spread: `max(spreadBps/10000 × price × 1.5, feeFloor)`, capped $2.0
3. **Farm TP $0.5** — fixed floor target
4. **Early profit** — hold ≥ 60s AND pnl ≥ fee × 1.2 (suppressed in TREND regime)
5. **Time exit** — after `dynamicMinHold` (120–480s), wait extra 30s if profitable

**Cooldown:** Fixed 30s

**Best for:** SoDEX (0.012% maker fee + SoPoints), any DEX with volume incentives

---

### 2. Trade Mode — Maximum Win Rate

**Goal:** Only enter when edge is clear. Maximize win rate over volume.

**Philosophy:** Quality over quantity. Let winners run.

**Entry Logic:**

```
1. Get signal from AISignalEngine
2. Run filter pipeline:
   [1] Regime check — HIGH_VOLATILITY → skip if REGIME_HIGH_VOL_SKIP_ENTRY=true
   [2] ChopDetector — chopScore ≥ 0.55 → skip (market is choppy)
   [3] FakeBreakoutFilter — OB imbalance contradicts direction → skip
   [4] Confidence gate — confidence < MIN_CONFIDENCE (0.65) → skip
   [5] 2-tick confirmation — signal must persist for 60s window

3. If all filters pass → place limit order
```

**Exit Logic:**

- **SL 5%** or **TP 5%**
- **No time exit** — let trade run to target

**Cooldown:** Random `[COOLDOWN_MIN_MINS, COOLDOWN_MAX_MINS]` (default 2–5 minutes)

**Best for:** Trending markets, when you want to avoid overtrading

---

### 3. Hedge Mode — Correlation Divergence

**Goal:** Profit from temporary divergence between correlated assets (BTC/ETH).

**Philosophy:** Market neutral. No directional bet.

**Entry Logic:**

```
1. VolumeMonitor samples volume every 15s for both symbols
2. shouldEnter() checks:
   - currentVolumeA > avgA × 1.21 (spike threshold)
   - currentVolumeB > avgB × 1.21
   - Both windows have ≥ 10 samples
   - Both symbols spike simultaneously

3. Get AI signals for both symbols in parallel
4. Assign directions:
   - scoreA > scoreB → long A, short B (A has stronger momentum)
   - scoreB > scoreA → long B, short A (B has stronger momentum)
   - scoreA == scoreB → skip entry

5. Place limit orders for both legs simultaneously
```

**State Machine:**

```
IDLE → OPENING → WAITING_FILL → IN_PAIR → CLOSING → COOLDOWN
```

**Fill Management (one-action-per-tick):**

- **Case 1:** 1 filled + 1 rejected → re-place rejected leg immediately (tick N+1)
- **Case 2:** 1 filled + 1 pending → wait up to 30s; timeout → cancel pending → OPENING
- **Case 3:** 2 pending → wait up to 30s; timeout → cancel both → OPENING

**Exit Conditions:**

1. **PROFIT_TARGET:** combinedPnl ≥ profitTargetUsd
2. **MAX_LOSS:** combinedPnl ≤ -maxLossUsd
3. **MEAN_REVERSION:** ratio returns to equilibrium spread
4. **TIME_EXPIRY:** elapsedSecs ≥ holdingPeriodSecs

**Best for:** Low-volatility periods, when BTC/ETH correlation is high but temporary divergence occurs

---

## AI Signal Engine

### Data Sources (fetched in parallel)

1. **Binance 5m klines** (30 candles) — EMA9, EMA21, RSI(14), 3-candle momentum
2. **Orderbook depth** (20 levels) — bid/ask imbalance
3. **Recent trades** (100 trades) — trade pressure (buy vs sell volume)
4. **Binance L/S position ratio** (5m) — sentiment indicator

### Momentum Score Calculation

```
momentumScore = Σ (component_i × weight_i)
```

**Components (default weights):**

| Component | Logic | Weight |
|---|---|---|
| EMA9 vs EMA21 | EMA9 > EMA21 → 0.65, else 0.35 | ~40% |
| RSI(14) | < 35 oversold (0.75), > 65 overbought (0.25), linear between | ~25% |
| 3-candle momentum | `(currentPrice - closes[-4]) / closes[-4] × 50 + 0.5` | ~20% |
| Orderbook imbalance | `(bidVol/askVol - 1) × 0.5 + 0.5` | ~15% |

**Bonuses:**
- EMA crossover or hammer/shooting star → ±0.05
- SIDEWAY regime: price position in 10-candle range → ±0.08

### Adaptive Weight Adjustment

After every 10 trades, weights self-adjust based on per-component win rates:

```
if EMA_winRate > 60% → EMA weight += 0.05
if RSI_lossStreak > 3 → RSI weight -= 0.05
```

Bounds: [0.05, 0.60], always sum to 1.0. Persisted to disk.

### Regime Detection

**Regimes:**
- **TREND_UP / TREND_DOWN** — ATR high + price outside Bollinger Bands
- **SIDEWAY** — ATR low + price inside Bollinger Bands
- **HIGH_VOLATILITY** — ATR > threshold × 1.5

**Impact:**
- Farm Mode: SIDEWAY requires higher confidence threshold
- Trade Mode: HIGH_VOLATILITY can auto-skip entry

### Fallback Mode

If Binance API fails → use basic SignalEngine (orderbook + trades only). Signal marked as `fallback: true`.

### Cache

60s TTL. Invalidated after placing entry order to force fresh data.

---

## Execution Safety

### Core Principle: One Action Per Tick

Every bot follows strict rules to prevent race conditions and duplicate orders:

**Rules:**
1. **Per-tick mutex** (`_tickLock`) — only one tick executes at a time
2. **ONE action per tick** — place OR cancel OR wait, then RETURN immediately
3. **No cancel + place in same tick**
4. **No exit + re-entry in same tick**
5. **COOLDOWN blocks ALL signal evaluation**
6. **Always query actual exchange positions** before close (not cached state)

### Farm/Trade Bot State Machine

```
IDLE → PENDING → IN_POSITION → EXITING → COOLDOWN → IDLE
```

**IDLE:**
- Dust check (ignore position < MIN_POS_USD)
- Hour blocking (FARM_BLOCKED_HOURS)
- Cancel stale orders → RETURN
- Retry entry if `_retryEntry` flag set
- Signal pipeline → PositionSizer → placeOrder → PENDING

**PENDING:**
- Position detected → IN_POSITION
- Timeout (10s farm, 15s trade) → cancel (tick N) → check (tick N+1)
- Confirmed cancel → save `_retryEntry` → IDLE

**IN_POSITION:**
- Check exit triggers (SL, TP, time, early profit)
- Exit trigger fired → EXITING

**EXITING:**
- Case A: no pendingExit → cancel open orders → verify position → placeExitOrder
- Case B: pendingExit exists → position gone → `_onExitFilled` → COOLDOWN
- Timeout 15s → cancel → retry Case A

**COOLDOWN:**
- Farm: fixed 30s
- Trade: random [COOLDOWN_MIN, COOLDOWN_MAX] mins
- Cooldown expired → IDLE

### Hedge Bot State Machine

```
IDLE → OPENING → WAITING_FILL → IN_PAIR → CLOSING → COOLDOWN → IDLE
```

**IDLE:**
- VolumeMonitor samples every 15s
- shouldEnter() checks dual-symbol spike
- Get signals for both symbols
- Assign directions → OPENING

**OPENING:**
- Tick A: cancel open orders → RETURN
- Tick B: check existing positions (anti-double-trade)
- Place limit orders for both legs
- 1 leg fails → cancel successful leg → IDLE

**WAITING_FILL:**
- Both filled → IN_PAIR
- Case 1: filled A + rejected B → re-place B (tick N+1)
- Case 2: filled A + pending B → wait 30s → cancel B → OPENING
- Case 3: pending A + pending B → wait 30s → cancel both → OPENING

**IN_PAIR:**
- Update PnL every 5s
- Check exit conditions (profit target, max loss, mean reversion, time expiry)
- Exit condition met → CLOSING

**CLOSING:**
- Tick A: cancel open orders → RETURN
- Tick B: query ACTUAL positions → close only open legs
- Poll flat confirmation (5 times, 1s interval)
- Both legs closed → COOLDOWN

**COOLDOWN:**
- Wait cooldownSecs → IDLE

---

## Dashboard & Monitoring

### Access

`http://localhost:3000` (default port, configurable via `DASHBOARD_PORT`)

### Features

**Manager View:**
- All bots overview
- Total PnL, volume, win rate
- Start/stop individual bots
- Create new bot instances

**Bot Detail View:**
- Real-time console (SSE streaming)
- Session PnL, volume, trade count
- Trade history table
- Current position (if any)

**Hedge Bot View:**
- Both legs displayed: symbol, side, entry price, unrealized PnL
- Combined PnL
- State machine status

**Analytics Tab:**
- Win rate by regime
- Signal quality metrics
- Fee impact analysis
- Filter skip stats (farm mode)
- Effective confidence distribution
- Dynamic min hold distribution

**Bot Settings:**
- 70+ config params
- Real-time validation
- Apply without restart
- Reset to defaults

### Real-Time Updates

Dashboard uses **Server-Sent Events (SSE)** for live console streaming. No polling, no WebSocket complexity.

---

## Telegram Control

### Setup

1. Create bot via [@BotFather](https://t.me/BotFather)
2. Get bot token
3. Get your chat ID (send `/start` to bot, check logs)
4. Add to `.env`:
   ```env
   TELEGRAM_BOT_TOKEN=...
   TELEGRAM_CHAT_ID=...
   ```

### Commands

**Single-Bot Mode:**
- `/start_bot` — Start trading session
- `/stop_bot` — Stop trading (closes position if open)
- `/status` — Bot state, uptime, PnL
- `/check` — Current position details
- `/set_mode farm|trade` — Switch strategy
- `/set_max_loss <usd>` — Set session max loss limit
- `/force_close` — Emergency position close

**Multi-Bot Mode:**
- `/status` — All bots summary
- `/status <botId>` — Specific bot details
- `/start <botId>` — Start specific bot
- `/stop <botId>` — Stop specific bot

### Alerts

Automatic notifications for:
- Session start/stop
- Trade entry/exit
- Max loss hit
- Error conditions
- Daily summary (if enabled)

---

## Multi-Bot Management

### Configuration File

`bot-configs.json` (default path, configurable via `BOT_CONFIGS_PATH`):

```json
{
  "bots": [
    {
      "id": "sodex-btc-farm",
      "exchange": "sodex",
      "symbol": "BTC-USD",
      "mode": "farm",
      "enabled": true
    },
    {
      "id": "sodex-eth-trade",
      "exchange": "sodex",
      "symbol": "ETH-USD",
      "mode": "trade",
      "enabled": true
    }
  ],
  "hedgeBots": [
    {
      "id": "btc-eth-hedge",
      "exchange": "sodex",
      "symbolA": "BTC-USD",
      "symbolB": "ETH-USD",
      "enabled": true,
      "notionalUsd": 100,
      "profitTargetUsd": 5,
      "maxLossUsd": 10,
      "holdingPeriodSecs": 3600,
      "cooldownSecs": 300
    }
  ]
}
```

### Per-Bot Config Isolation

Each `BotInstance` has its own `ConfigStore` — runtime config changes apply only to that bot.

**Example:** Bot A can have `FARM_SIDEWAY_MIN_CONFIDENCE: 0.10` while Bot B has `0.45`.

Overrides saved to `config-overrides-<botId>.json`.

### Adding Bots at Runtime

Via dashboard:
1. Navigate to Manager view
2. Click "Add Bot"
3. Fill form (exchange, symbol, mode)
4. Click "Create"

Bot starts immediately if `enabled: true`.

### Removing Bots

Via dashboard:
1. Stop bot
2. Click "Remove"
3. Confirm

Config file updated automatically.

---

## Troubleshooting

### Bot Not Trading (Farm Mode)

**Symptom:** `[SignalFilter] SKIP: [RegimeGate] SKIP: regime=SIDEWAY, confidence=0.09 < 0.45`

**Cause:** `FARM_SIDEWAY_MIN_CONFIDENCE` too high for current market conditions.

**Fix:**
1. Open dashboard → Bot Settings
2. Lower `FARM_SIDEWAY_MIN_CONFIDENCE` to `0.01` or `0.05`
3. Click "Apply Changes"

**Note:** If using Single-Bot Mode, ensure `configStore` is passed to `Watcher` constructor (fixed in latest version).

---

### Orders Not Filling

**Symptom:** `[PENDING] Timeout — cancelling order`

**Possible causes:**
1. **Price too aggressive** — ExecutionEdge offset too large
2. **Low liquidity** — spread > 10 bps triggers spread guard
3. **Post-Only rejection** — price crosses spread

**Fix:**
1. Check `EXECUTION_EDGE_SPREAD_MULT` (default 0.3) — lower to 0.1 for tighter pricing
2. Disable Post-Only: set `timeInForce = 0` (GTC) instead of `4` (Post-Only) in adapter
3. Check exchange orderbook depth — if < $50k top-5, consider different symbol

---

### Hedge Bot Stuck in WAITING_FILL

**Symptom:** One leg filled, other leg pending for > 30s

**Cause:** Fill management timeout not triggering cancel.

**Debug:**
1. Check dashboard console for `[WAITING_FILL]` logs
2. Verify timeout logic: `elapsedSecs >= 30`
3. Check if `cancelAllOrders()` is being called

**Fix:** Restart bot — state machine will reset to IDLE and cancel stale orders.

---

### Config Changes Not Applied

**Symptom:** Changed `FARM_SIDEWAY_MIN_CONFIDENCE` on dashboard but bot still uses old value.

**Cause (Single-Bot Mode):** `configStore` not passed to `Watcher` constructor.

**Fix:** Update `src/bot.ts` line 198:
```ts
// BEFORE:
const watcher = new Watcher(adapter, symbol, telegram, sessionManager);

// AFTER:
const watcher = new Watcher(adapter, symbol, telegram, sessionManager, undefined, configStore);
```

**Cause (Multi-Bot Mode):** Config override file not loaded on startup.

**Fix:** Check `config-overrides-<botId>.json` exists and is valid JSON.

---

### High Fee Impact

**Symptom:** `grossPnl > 0` but `netPnl < 0` (fee ate all profit)

**Cause:** Holding time too short — exiting before price moves enough to cover fees.

**Fix:**
1. Increase `FARM_MIN_HOLD_SECS` to 180 or 240
2. Increase `FARM_MIN_PROFIT_FEE_MULT` to 1.5 or 2.0 (early exit threshold)
3. Enable Market Maker (`MM_ENABLED: true`) for dynamic TP based on spread

---

### Rate Limiting (SoDEX)

**Symptom:** `[SoDEX] Rate limited — backing off 5s`

**Cause:** Too many API requests in short time.

**Behavior:** Adapter automatically backs off for `retryAfter` seconds (from API response).

**Fix:** No action needed — bot will resume after backoff. If persistent:
1. Increase tick interval (not recommended — breaks timing)
2. Reduce number of bots on same exchange
3. Contact exchange for higher rate limit tier

---

### LLM API Errors

**Symptom:** `[LLMClient] OpenAI API error: 429 Too Many Requests`

**Cause:** OpenAI rate limit hit.

**Behavior:** Signal engine falls back to basic mode (no LLM adjustment).

**Fix:**
1. Upgrade OpenAI plan for higher rate limits
2. Increase `LLM_CACHE_TTL` to reduce API calls
3. Disable LLM: remove `OPENAI_API_KEY` from `.env`

---

### Docker Container Exits

**Symptom:** `docker ps` shows container stopped.

**Debug:**
```bash
docker logs drift-bot
```

**Common causes:**
1. **Missing .env** — copy `.env.example` to `.env`
2. **Invalid API keys** — check credentials
3. **Port conflict** — change `DASHBOARD_PORT` if 3000 is taken
4. **Out of memory** — increase Docker memory limit

---

### Position Sync Issues After Restart

**Symptom:** Bot thinks position is open but exchange shows flat.

**Cause:** Stale state from `bot_state.json`.

**Fix:**
1. Stop bot
2. Delete `bot_state.json`
3. Restart bot — will sync from exchange

**Prevention:** Bot automatically queries exchange position on startup (IDLE state).

---

## Advanced Topics

### Custom Signal Components

Add new signal components in `src/ai/AISignalEngine.ts`:

```ts
// Example: Add MACD component
const macd = calculateMACD(closes);
const macdScore = macd > 0 ? 0.7 : 0.3;

// Add to weighted sum
const momentumScore = 
  emaScore * weights.ema +
  rsiScore * weights.rsi +
  momentumScore * weights.momentum +
  obScore * weights.orderbook +
  macdScore * weights.macd; // new component
```

Update `WeightStore` to include new component.

### Custom Exit Conditions

Add new exit logic in `src/modules/Watcher.ts` → `_checkExitConditions()`:

```ts
// Example: Exit on volume spike
const recentVolume = await this.adapter.getRecentTrades(this.symbol, 20);
const avgVolume = recentVolume.reduce((sum, t) => sum + t.size, 0) / 20;
if (recentVolume[0].size > avgVolume * 3) {
  return { shouldExit: true, exitTrigger: 'VOLUME_SPIKE' };
}
```

### Custom Filters (Farm Mode)

Add new filter in `src/modules/FarmSignalFilters.ts`:

```ts
export function myCustomFilter(input: FilterInput): { pass: boolean; reason?: string } {
  if (input.mode !== 'farm') return { pass: true };
  
  // Your logic here
  if (someCondition) {
    return { pass: false, reason: '[MyFilter] SKIP: reason' };
  }
  
  return { pass: true };
}
```

Add to pipeline in `evaluateFarmEntryFilters()`.

---

## Performance Tuning

### Farm Mode Optimization

**Goal:** Maximum volume with minimal fee impact.

**Key params:**
- `FARM_SIDEWAY_MIN_CONFIDENCE: 0.01` — very permissive
- `FARM_MIN_HOLD_SECS: 120` — minimum 2 minutes
- `FARM_COOLDOWN_SECS: 30` — fast re-entry
- `MM_ENABLED: true` — dynamic TP based on spread
- `EXECUTION_EDGE_SPREAD_MULT: 0.2` — tight pricing

**Expected:** 20–40 trades/hour, 60–70% win rate, net positive after fees.

### Trade Mode Optimization

**Goal:** High win rate, low trade frequency.

**Key params:**
- `MIN_CONFIDENCE: 0.70` — strict entry
- `COOLDOWN_MIN_MINS: 5` — avoid overtrading
- `REGIME_HIGH_VOL_SKIP_ENTRY: true` — skip volatile periods
- `CHOP_THRESHOLD: 0.55` — skip choppy markets

**Expected:** 2–5 trades/hour, 75–85% win rate.

### Hedge Mode Optimization

**Goal:** Capture divergence with minimal directional risk.

**Key params:**
- `notionalUsd: 100` — equal size both legs
- `profitTargetUsd: 3` — 3% of notional
- `maxLossUsd: 5` — 5% of notional
- `holdingPeriodSecs: 1800` — 30 minutes max hold
- `volumeSpikeThreshold: 1.21` — 21% above average

**Expected:** 1–3 pairs/hour, 60–70% win rate, low correlation to market direction.

---

## Conclusion

DRIFT is a production-grade trading system with:
- **Three strategies** for different market conditions
- **Adaptive learning** via self-adjusting signal weights
- **Execution safety** via strict state machines
- **Real-time config** via dashboard
- **Multi-bot management** for portfolio diversification

For questions or issues, check logs first, then dashboard analytics, then this walkthrough.

Happy trading. 🚀
