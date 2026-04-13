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
6. `AISignalEngine.getSignal()` (cached 60s, không gọi LLM trong farm mode)
7. MM bias: `computeEntryBias()` — ping-pong + inventory
8. **Determine direction — NEVER skip:**
   - `signal.direction = 'long'/'short'` → dùng ngay (có thể override bởi MM bias mạnh)
   - `signal.direction = 'skip'` → dùng adjusted score, nếu vẫn neutral → alternate từ last trade
   - MM hard block → force opposite direction (không return)
9. Balance guard: stop nếu < $15
10. `PositionSizer.computeSize()` — confidence scale size, không gate
11. Balance-% soft cap
12. Hold time: random `[FARM_MIN_HOLD_SECS, FARM_MAX_HOLD_SECS]`
13. SL: `config.FARM_SL_PERCENT` (không có regime multiplier)
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

1. **SL**: `RiskManager.shouldClose()` với `FARM_SL_PERCENT = 5%`
2. **Dynamic TP** (MM mode): `pnl >= _pendingDynamicTP`
3. **Farm TP**: `pnl >= max(FARM_TP_USD, feeRoundTrip × 1.5)`
4. **Early profit**: hold ≥ 120s AND pnl ≥ $0.4
5. **Dynamic hold**: hết hold time nhưng giá đang phục hồi → chờ thêm `FARM_EXTRA_WAIT_SECS (30s)`
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
- `pricePosition > 0.75` → `momentumScore -= 0.08` (penalize long ở đỉnh range)
- `pricePosition < 0.25` → `momentumScore += 0.08` (penalize short ở đáy range)

Khi LLM null trong SIDEWAY, price position là primary signal:
- `< 30%` → LONG (mean reversion từ đáy)
- `> 70%` → SHORT (mean reversion từ đỉnh)
- Mid-range → dùng momentum score

**LLM**: GPT-4o hoặc Claude → `direction + confidence + reasoning`. Null → fallback momentum + price position in range.

**Cache**: 60s TTL. Invalidate sau khi place entry.

---

## 3. Feedback Loop (Phase 1)

Mỗi 10 trades, tính win rate của từng component trên 50 trades gần nhất:

```
if EMA_winRate > 60%  → EMA weight += 0.05
if RSI_lossStreak > 3 → RSI weight -= 0.05
```

Clamp [0.05, 0.60], normalize sum = 1.0. Persist → `signal-weights.json`.

Confidence calibration: `adjusted = rawConf × (historicalWinRate / 0.5)`, clamp [0.10, 1.00].

---

## 4. Dynamic Position Sizing (Phase 2)

```
size = baseSize × clamp(confMult × 0.6 + perfMult × 0.4) × volatilityFactor
```

- `confMult`: farm = dampened `1.0 + (conf - 0.5) × 0.6`; trade = full scale
- `perfMult`: win rate × drawdown × profile bias (SCALP/NORMAL/RUNNER/DEGEN)
- `volatilityFactor`: từ regime (farm mode = 1.0 luôn)

---

## 5. Regime-Adaptive Strategy (Phase 3)

| Regime | Score edge | Size | Hold | SL mult |
|---|---|---|---|---|
| TREND | 0.02 | 1.0× | 1.5× | 1.0× |
| SIDEWAY | 0.05 | 0.85× | 0.8× | 1.0× |
| HIGH_VOL | 0.08 | 0.5× | 0.7× | 1.5× |

Chỉ áp dụng cho **trade mode**. Farm mode không dùng regime multipliers.

---

## 6. Anti-Chop & Trade Filtering (Phase 4) — Trade Mode Only

**ChopDetector**:
```
chopScore = flipRate × 0.40 + momNeutrality × 0.35 + bbCompression × 0.25
```
Score ≥ 0.55 → skip entry.

**FakeBreakoutFilter**: chỉ kích hoạt khi `|score - 0.5| > 0.15`. Check OB imbalance contradiction.

**AdaptiveCooldown**:
```
finalMins = clamp(baseMins × (1 + losingStreak × 0.5) × (1 + chopScore × 1.0), MIN, 30)
```

---

## 7. Execution Edge (Phase 5)

```
offset = clamp(spreadBps × 0.3 + depthPenalty + fillRatePenalty, 0, 5)
```

- Spread guard: skip entry nếu spread > 10 bps
- Depth penalty: +$0.5 nếu top-5 book depth < $50k
- Fill rate penalty: +$1.0 nếu fill rate < 60%

---

## 8. Farm Market Making (Phase 6)

**Ping-Pong**: sau LONG exit → bias SHORT; sau SHORT exit → bias LONG.

**Inventory Control**:
- Net exposure > $50 → soft bias rebalancing
- Net exposure > $150 → force opposite direction (không block)

**Dynamic TP**:
```
dynamicTP = min(max(spreadBps/10000 × price × 1.5, feeFloor), $2.0)
```

---

## 9. Order Execution

Tất cả lệnh **Post-Only (maker)**:

| Lệnh | Giá đặt | TimeInForce |
|---|---|---|
| Entry LONG | `best_bid - dynamicOffset` | Post-Only (4) |
| Entry SHORT | `best_ask + dynamicOffset` | Post-Only (4) |
| Exit LONG | `best_ask` | Post-Only (4) |
| Exit SHORT | `best_bid` | Post-Only (4) |
| Force close | cross spread | IOC (3) |

---

## 10. SoDEX Adapter — EIP-712 Signing

1. Build canonical JSON payload (field order khớp Go struct)
2. Hash với `keccak256`
3. Sign `ExchangeAction { payloadHash, nonce }` với EIP-712
4. Normalize `v` từ 27/28 → 0/1
5. Prefix `0x01`

Nonce: timestamp ms, tăng dần. Account ID và Symbol ID được cache.

---

## 11. Cấu trúc thư mục

```
src/
├── bot.ts                    # Bootstrap, Telegram commands, graceful shutdown
├── config.ts                 # Tất cả tham số mặc định
├── adapters/
│   ├── ExchangeAdapter.ts    # Interface chung
│   ├── sodex_adapter.ts      # SoDEX (EIP-712 signing)
│   └── decibel_adapter.ts    # Decibel (Aptos SDK)
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
│   └── FeedbackLoop/         # Adaptive weights
│       ├── WeightStore.ts
│       ├── ComponentPerformanceTracker.ts
│       ├── AdaptiveWeightAdjuster.ts
│       └── ConfidenceCalibrator.ts
├── config/
│   ├── ConfigStore.ts        # Runtime config override
│   └── validateOverrides.ts  # 41 validation rules
└── dashboard/
    └── server.ts             # Express dashboard (inline HTML + SSE)
```
