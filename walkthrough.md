# Walkthrough — APEX

Hướng dẫn chi tiết về logic hoạt động của từng thành phần.

---

## 1. State Machine (Watcher)

Watcher chạy vòng lặp với delay ngẫu nhiên (2s–90s). Mỗi tick:

```
IDLE ──► PENDING_ENTRY ──► IN_POSITION ──► PENDING_EXIT ──► IDLE
           │                                    │
      (5s farm / 15s trade)              (15s timeout)
      cancel + re-place                  cancel + re-place
      (max 3 lần farm / 10 lần trade)
```

### IDLE — Farm Mode (luôn execute)

1. Cooldown check — return ngay nếu còn cooldown
2. Fetch `position + markPrice + balance` song song
3. Max loss check → force close + stop nếu hit
4. Hour blocking (nếu `FARM_BLOCKED_HOURS` được set)
5. Cancel stale open orders
6. `AISignalEngine.getSignal()` (cached 60s)
7. MM bias: `computeEntryBias()` — ping-pong + inventory
8. **Determine direction — NEVER skip:**
   - `signal.direction = 'long'/'short'` → dùng ngay (có thể override bởi MM bias mạnh)
   - `signal.direction = 'skip'` → dùng adjusted score, nếu vẫn neutral → alternate từ last trade
   - MM hard block → force opposite direction
9. Balance guard: stop nếu < $15
10. `PositionSizer.computeSize()` — confidence scale size, không gate
11. Balance-% soft cap
12. Hold time: random `[FARM_MIN_HOLD_SECS, FARM_MAX_HOLD_SECS]` × regime multiplier
13. SL: `config.FARM_SL_PERCENT` × regime SL multiplier
14. Dynamic TP từ spread (MM mode)
15. `executor.placeEntryOrder()` → `PENDING_ENTRY`

### IDLE — Trade Mode (full filtering)

1–5. Giống farm mode
6. `AISignalEngine.getSignal()` (có LLM)
7. Regime check → skip nếu `regimeConfig.skipEntry`
8. Chop detection → skip nếu `chopScore ≥ CHOP_SCORE_THRESHOLD`
9. Fake breakout filter → skip nếu breakout thiếu OB confirmation
10. Confidence ≥ `MIN_CONFIDENCE (0.65)`
11. 2-tick confirmation trong 60s
12. Balance guard
13. `PositionSizer.computeSize()` với `volatilityFactor` từ regime
14. Regime-adaptive hold time, SL buffer
15. `executor.placeEntryOrder()` → `PENDING_ENTRY`

### PENDING_ENTRY

- Chờ position xuất hiện (fill confirmation)
- Farm: timeout 5s, max 3 lần re-place
- Trade: timeout 15s, max 10 lần re-place
- Race condition guard: check position sau cancel
- Khi fill: `fillTracker.recordFill('entry', fillMs)` → `IN_POSITION`
- Khi cancel: `fillTracker.recordCancel('entry')`

### IN_POSITION — Farm Mode Exit

Thứ tự ưu tiên:

1. **SL**: `RiskManager.shouldClose()` với `FARM_SL_PERCENT × slBufferMultiplier`
2. **Dynamic TP** (MM mode): `pnl >= _pendingDynamicTP`
3. **Farm TP**: `pnl >= max(FARM_TP_USD, feeRoundTrip × 1.5)`
4. **Early profit**: hold ≥ `FARM_EARLY_EXIT_SECS (60s)` AND pnl ≥ `FARM_EARLY_EXIT_PNL ($0.3)`
   - Bị suppress nếu regime là TREND (để trend chạy tiếp)
5. **Dynamic hold**: hết hold time nhưng giá đang phục hồi → chờ thêm `FARM_EXTRA_WAIT_SECS (15s)`
6. **Time exit**: hết thời gian chờ thêm

### IN_POSITION — Trade Mode Exit

1. **SL**: `TRADE_SL_PERCENT = 5%`
2. **TP**: `TRADE_TP_PERCENT = 5%`
3. **Không có time exit**

### PENDING_EXIT

- Dust position check: skip close nếu value < `MIN_POSITION_VALUE_USD ($20)`
- Timeout 15s → cancel + re-place
- Khi fill: `fillTracker.recordFill('exit', fillMs)` → adaptive cooldown → `IDLE`
- MM: `marketMaker.recordTrade(side, volumeUsd)`

---

## 2. AI Signal Engine

Fetch song song 4 nguồn:
- Orderbook depth (20 levels)
- Recent trades (100 trades)
- Binance 5m klines (30 candles)
- Binance top L/S position ratio (5m)

**Momentum score** với adaptive weights từ `WeightStore`:

```
momentumScore = emaTrend × w.ema
              + rsiScore × w.rsi
              + momScore × w.momentum
              + imbScore × w.imbalance
              + candle pattern bonus (±0.05)
```

**Regime detection** (ATR + BB width + volume ratio):
- `HIGH_VOLATILITY`: ATR/price > 0.5%
- `TREND_UP/DOWN`: price vs EMA21 ± 0.2% AND bbWidth > 0.01
- `SIDEWAY`: default

**SIDEWAY range logic**: `pricePositionInRange` tính vị trí giá trong range 10 nến (0 = đáy, 1 = đỉnh):
- `pricePosition > 0.75` → `momentumScore -= 0.08`
- `pricePosition < 0.25` → `momentumScore += 0.08`

Khi LLM null trong SIDEWAY, price position là primary signal:
- `< 30%` → LONG (mean reversion từ đáy)
- `> 70%` → SHORT (mean reversion từ đỉnh)
- Mid-range → dùng momentum score

**LLM**: GPT-4o hoặc Claude → `direction + confidence + reasoning`. Null → fallback momentum + price position.

**Cache**: 60s TTL. Invalidate sau khi place entry.

---

## 3. Feedback Loop

Mỗi 10 trades, tính win rate của từng component trên 50 trades gần nhất:

```
if EMA_winRate > 60%  → EMA weight += 0.05
if RSI_lossStreak > 3 → RSI weight -= 0.05
```

Clamp [0.05, 0.60], normalize sum = 1.0. Persist → `signal-weights.json`.

**Confidence calibration**: `adjusted = rawConf × (historicalWinRate / 0.5)`, clamp [0.10, 1.00].
- Chỉ áp dụng khi bucket có ≥ 5 trades (tránh overfitting sparse data)

**Component attribution**:
- EMA: `ema9 > ema21` → predicted long
- RSI: `rsi < 35` → predicted long, `rsi > 65` → predicted short
- Momentum: `momentum3candles > 0` → predicted long
- Imbalance: `imbalance > 1` → predicted long

---

## 4. Dynamic Position Sizing

```
size = baseSize × clamp(confMult × 0.6 + perfMult × 0.4) × volatilityFactor
```

- `confMult`: farm = dampened `1.0 + (conf - 0.5) × 0.6`; trade = full scale
- `perfMult`: win rate × drawdown × profile bias (SCALP/NORMAL/RUNNER/DEGEN)
  - Win rate 0% → 0.7×, 50% → 1.0×, 100% → 1.3×
  - Drawdown < -$3 → scale down đến floor 0.5×
- `volatilityFactor`: từ regime (farm mode = 1.0 luôn)

Hard cap: `SIZING_MAX_BTC = 0.008`. Soft cap: `SIZING_MAX_BALANCE_PCT = 2%`.

---

## 5. Regime-Adaptive Strategy

| Regime | Score edge | Size | Hold | SL mult | Suppress early exit |
|---|---|---|---|---|---|
| TREND | 0.02 | 1.0× | 1.5× | 1.0× | true |
| SIDEWAY | 0.05 | 0.85× | 0.8× | 1.0× | false |
| HIGH_VOL | 0.08 | 0.5× | 0.7× | 1.5× | false |

Chỉ áp dụng cho **trade mode**. Farm mode không dùng regime multipliers.

**Regime detection algorithm**:
1. `atrPct > 0.5%` → HIGH_VOLATILITY
2. `price > ema21 × 1.002` AND `bbWidth > 0.01` → TREND_UP
3. `price < ema21 × 0.998` AND `bbWidth > 0.01` → TREND_DOWN
4. Default → SIDEWAY

---

## 6. Anti-Chop & Trade Filtering (Trade Mode Only)

**ChopDetector**:
```
chopScore = flipRate × 0.40 + momNeutrality × 0.35 + bbCompression × 0.25
```
- `flipRate`: tỷ lệ direction flip trong 5 signals gần nhất
- `momNeutrality`: `1 - |score - 0.5| / 0.5` (score gần 0.5 = neutral = chop)
- `bbCompression`: `1 - bbWidth / CHOP_BB_COMPRESS_MAX` (BB hẹp = chop)

Score ≥ 0.55 → skip entry.

**FakeBreakoutFilter**: chỉ kích hoạt khi `|score - 0.5| > 0.15`. Check:
- `volRatio < 0.4` → low volume
- `imbalance` contradicts direction → OB opposes move

**AdaptiveCooldown**:
```
finalMins = clamp(baseMins × (1 + losingStreak × 0.5) × (1 + chopScore × 1.0), MIN, 30)
```

---

## 7. Execution Edge

```
offset = clamp(spreadBps × 0.3 + depthPenalty + fillRatePenalty, 0, 5)
```

- Spread guard: skip entry nếu spread > 10 bps
- Depth penalty: +$0.5 nếu top-5 book depth < $50k
- Fill rate penalty: +$1.0 nếu fill rate < 60% (ring buffer 20 orders)

**Order placement**:

| Lệnh | Giá đặt |
|---|---|
| Entry LONG | `best_bid - dynamicOffset` |
| Entry SHORT | `best_ask + dynamicOffset` |
| Exit LONG | `best_ask` |
| Exit SHORT | `best_bid` |
| Force close | cross spread (IOC) |

---

## 8. Farm Market Making

**Ping-Pong**: sau LONG exit → bias SHORT; sau SHORT exit → bias LONG.
- `pingPongBias = ±MM_PINGPONG_BIAS_STRENGTH (0.08)`

**Inventory Control**:
- Net exposure > $50 → soft bias rebalancing (`inventoryBias = ±0.12`)
- Net exposure > $150 → hard block entry

**Direction resolution**:
```
adjustedScore = signal.score + pingPongBias + inventoryBias
finalDirection = adjustedScore >= 0.5 ? 'long' : 'short'
```

**Dynamic TP**:
```
dynamicTP = min(max(spreadBps/10000 × price × 1.5, feeFloor), $2.0)
```

---

## 9. SoDEX Adapter — EIP-712 Signing

1. Build canonical JSON payload (field order khớp Go struct)
2. Hash với `keccak256`
3. Sign `ExchangeAction { payloadHash, nonce }` với EIP-712
4. Normalize `v` từ 27/28 → 0/1
5. Prefix `0x01`

Nonce: timestamp ms, tăng dần. Account ID và Symbol ID được cache.

---

## 10. Trade Analytics

**TradeRecord** lưu đầy đủ metadata:
- Signal snapshot: regime, momentumScore, ema9/21, rsi, imbalance, tradePressure
- Timing: entryTime, exitTime, holdingTimeSecs
- Fee analysis: grossPnl, feePaid, wonBeforeFee
- Sizing: sizingConfMult, sizingPerfMult, sizingCombinedMult
- MM metadata: mmPingPongBias, mmInventoryBias, mmDynamicTP, mmNetExposure
- Exit trigger: FARM_TP, FARM_MM_TP, FARM_TIME, FARM_EARLY_PROFIT, SL, FORCE

**AnalyticsEngine** compute:
- Win rate by mode, direction, regime, confidence bucket, UTC hour
- Signal quality: LLM match rate, fallback rate, avg confidence
- Fee impact: total fee paid, fee-loser rate
- Holding time distribution (farm mode)
- Streak tracking: max consecutive wins/losses

---

## 11. Cấu trúc thư mục

```
src/
├── bot.ts                    # Bootstrap, Telegram commands, graceful shutdown
├── config.ts                 # Tất cả tham số mặc định (70+ keys)
├── adapters/
│   ├── ExchangeAdapter.ts    # Interface chung (9 methods)
│   ├── sodex_adapter.ts      # SoDEX (EIP-712 signing)
│   ├── decibel_adapter.ts    # Decibel (Aptos Ed25519)
│   └── dango_adapter.ts      # Dango (Secp256k1 + GraphQL)
├── modules/
│   ├── Watcher.ts            # State machine chính
│   ├── Executor.ts           # Đặt/hủy lệnh
│   ├── ExecutionEdge.ts      # Dynamic offset + spread guard
│   ├── FillTracker.ts        # Fill rate ring buffer
│   ├── PositionSizer.ts      # Dynamic sizing
│   ├── MarketMaker.ts        # Ping-pong + inventory + dynamic TP
│   ├── RiskManager.ts        # TP/SL check + runtime SL override
│   ├── PositionManager.ts    # Duration tracking
│   ├── SessionManager.ts     # Max loss, session state
│   ├── SignalEngine.ts       # Fallback signal (contrarian)
│   └── TelegramManager.ts    # Telegram bot wrapper
├── ai/
│   ├── AISignalEngine.ts     # Signal engine chính
│   ├── RegimeDetector.ts     # ATR + BB + volume regime
│   ├── ChopDetector.ts       # Chop score
│   ├── FakeBreakoutFilter.ts # Breakout validation
│   ├── AdaptiveCooldown.ts   # Adaptive cooldown formula
│   ├── LLMClient.ts          # OpenAI / Anthropic client
│   ├── AnalyticsEngine.ts    # Win rate & performance analytics
│   ├── TradeLogger.ts        # Log trade (JSON / SQLite)
│   ├── sharedState.ts        # Shared state + SSE broadcast
│   ├── StateStore.ts         # Persist state to disk
│   └── FeedbackLoop/
│       ├── WeightStore.ts
│       ├── ComponentPerformanceTracker.ts
│       ├── AdaptiveWeightAdjuster.ts
│       └── ConfidenceCalibrator.ts
├── config/
│   ├── ConfigStore.ts        # Runtime config override
│   └── validateOverrides.ts  # 41+ validation rules
└── dashboard/
    └── server.ts             # Express dashboard (inline HTML + SSE)
```
