# Walkthrough — DRIFT

Hướng dẫn chi tiết về logic hoạt động của từng thành phần trong DRIFT trading bot.

---

## 1. State Machine (Watcher)

### Sơ đồ trạng thái

```
IDLE ──[place order]──► PENDING ──[fill detected]──► IN_POSITION
  ▲                         │                              │
  │                    [cancel only]               [exit trigger fired]
  │                     (tick N+1)                         │
  │                         │                          EXITING
  │                       IDLE                   [cancel, then place exit]
  │                    (tick N+2)                         │
  │                                               [exit fill confirmed]
  └──────────────── COOLDOWN ◄────────────────────────────┘
```

**Tick isolation (STRICT)**:
- Mỗi tick = một atomic execution unit
- Chỉ một action: place OR cancel OR wait — sau đó RETURN
- Per-tick mutex (`_tickLock`): nếu tick trước chưa xong thì skip tick mới
- Không bao giờ cancel + place trong cùng một tick

**Dynamic scheduler**:

| State | Tick interval |
|---|---|
| `IN_POSITION` + `heldSecs > FARM_EARLY_EXIT_SECS` | **FIXED 5s** |
| `IN_POSITION` normal | Random 5–10s |
| `EXITING` / `PENDING` | Random 3–8s |
| `COOLDOWN` / `IDLE` | Weighted random 2s–90s |

---

### State: COOLDOWN

Tick bị short-circuit ngay lập tức — không có API call, không có signal evaluation, không có order placement. Chỉ check timer:

```
if Date.now() < cooldownUntil → log remaining → RETURN
else → cooldownUntil = null → botState = IDLE → RETURN
```

Transition vào COOLDOWN:
- Cả farm và trade mode: random trong `[COOLDOWN_MIN_MINS, COOLDOWN_MAX_MINS]` (2–5 phút)
- External close / dust: cũng dùng random cooldown

---

### State: IDLE

**Farm Mode** (luôn execute):

1. Sync check: nếu có position → transition thẳng sang `IN_POSITION`
2. Hour blocking (`FARM_BLOCKED_HOURS`)
3. Stale orders check → cancel nếu có → RETURN (1 action)
4. `_retryEntry` check → nếu có (từ cancelled PENDING) → place lại ngay, không re-evaluate signal
5. `AISignalEngine.getSignal()` (cached 60s)
6. MM bias: ping-pong + inventory → adjust direction
7. Direction resolution (NEVER skip): pricePosition → adjustedScore → last trade fallback
8. `PositionSizer.computeSize()` → size
9. `farmHoldUntil`, SL, dynamic TP setup
10. `executor.placeEntryOrder()` → `botState = PENDING` → RETURN

**Trade Mode** (full filtering):

1–4. Giống farm
5. Signal + regime config
6. Regime gate → skip nếu `skipEntry`
7. ChopDetector → skip nếu `chopScore ≥ 0.55`
8. FakeBreakoutFilter → skip nếu breakout thiếu volume/OB
9. Confidence ≥ `MIN_CONFIDENCE`
10. 2-tick confirmation (60s window)
11. Sizing, hold time, SL với regime multipliers
12. `executor.placeEntryOrder()` → `botState = PENDING` → RETURN

---

### State: PENDING

Tick N đã place order. Tick N+1 kiểm tra fill:

```
PENDING tick:
  if position exists → _onEntryFilled() → IN_POSITION → RETURN
  if waitedMs < fillTimeout → log waiting → RETURN
  if cancelledOnTick = false:
    → cancel_all_orders() → cancelledOnTick = true → RETURN (ACTION: cancel)
  if cancelledOnTick = true:
    → check open orders để confirm cancel
    → nếu chưa confirm → RETURN (wait)
    → nếu confirmed → check position (race condition guard)
      → nếu có position → _onEntryFilled() → IN_POSITION
      → nếu không → save retry context → _transitionToIdle() → IDLE
```

- **Partial fill = filled**: bất kỳ position size > 0 đều xem là filled
- `_retryEntry` lưu direction/meta/size để tick IDLE sau có thể re-place mà không cần re-evaluate signal
- Farm: max 3 lần retry. Trade: max 10 lần.

---

### State: IN_POSITION

Exit conditions (theo thứ tự ưu tiên):

**Farm Mode**:
1. `RiskManager.shouldClose()` (SL 5%)
2. `pnl >= dynamicTP` (MM mode, khi enabled) hoặc `pnl >= FARM_TP_USD`
3. Early exit: `duration >= FARM_EARLY_EXIT_SECS` (60s) AND `pnl >= FARM_EARLY_EXIT_PNL` ($0.4)
   - Suppress nếu regime là TREND (`suppressEarlyExit = true`)
4. Hold expired + extra wait: nếu profitable và đang phục hồi → wait thêm `FARM_EXTRA_WAIT_SECS` (30s)
5. Time exit: hết extra wait → exit

**Trade Mode**: chỉ SL 5% hoặc TP 5%. **Không có time exit**.

Khi exit trigger:
- `botState = EXITING` (ngay lập tức, trước bất kỳ async op nào)
- `cancel_all_orders()` → RETURN (ACTION: cancel)
- Tick tiếp theo: `_handleExiting()` sẽ place exit order

**Nếu position đóng từ bên ngoài** (external close): detect → apply cooldown → RETURN.

---

### State: EXITING

**Case A** — chưa có `pendingExit` (tick đầu tiên sau cancel từ IN_POSITION):

```
→ confirm open orders = 0
→ re-verify position vẫn còn (race condition check)
→ dust check: value < MIN_POSITION_VALUE_USD → skip close → COOLDOWN
→ placeExitOrder() → pendingExit = { order, ... } → RETURN (ACTION: place)
```

**Case B** — đã có `pendingExit`, check fill:

```
→ nếu position gone → _onExitFilled() → COOLDOWN → RETURN
→ nếu waitedMs < 15s → log waiting → RETURN
→ nếu timeout:
   → cancel_all_orders() → pendingExit = null → RETURN (ACTION: cancel)
   → tick tiếp: quay về Case A và place lại
```

**Strict**: cancel và place exit KHÔNG bao giờ trong cùng tick.

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

**SIDEWAY range logic** (Farm Mode):
- `pricePosition > 0.65` → `direction = 'short'` (mean reversion từ đỉnh)
- `pricePosition < 0.35` → `direction = 'long'` (mean reversion từ đáy)
- Mid-range (0.35–0.65) → dùng adjusted momentum score hoặc alternate

Khi LLM null trong SIDEWAY:
- Farm mode: dùng price position logic trên
- Trade mode: dùng momentum score với bias

**Cache**: 60s TTL. Invalidate sau khi place entry order.

---

## 3. Feedback Loop

Mỗi 10 trades, tính win rate của từng component trên 50 trades gần nhất:

```
if EMA_winRate > 60%  → EMA weight += 0.05
if RSI_lossStreak > 3 → RSI weight -= 0.05
```

Clamp [0.05, 0.60], normalize sum = 1.0. Persist → `signal-weights.json`.

**Confidence calibration**: `adjusted = rawConf × (historicalWinRate / 0.5)`, clamp [0.10, 1.00].

---

## 4. Dynamic Position Sizing

```
size = baseSize × clamp(confMult × 0.6 + perfMult × 0.4) × volatilityFactor
```

- `confMult`: farm = dampened; trade = full scale
- `perfMult`: win rate × drawdown × profile (SCALP/NORMAL/RUNNER/DEGEN)
- `volatilityFactor`: từ regime (farm = 1.0 luôn)

Hard cap: `SIZING_MAX_BTC = 0.008`. Soft cap: `SIZING_MAX_BALANCE_PCT = 2%`.

---

## 5. Regime-Adaptive Strategy (Trade Mode Only)

| Regime | Score edge | Size | Hold | SL mult | Suppress early exit |
|---|---|---|---|---|---|
| TREND | 0.02 | 1.0× | 1.5× | 1.0× | true |
| SIDEWAY | 0.05 | 0.85× | 0.8× | 1.0× | false |
| HIGH_VOL | 0.08 | 0.5× | 0.7× | 1.5× | false |

Farm mode không dùng regime multipliers.

---

## 6. Anti-Chop & Trade Filtering (Trade Mode Only)

**ChopDetector**:
```
chopScore = flipRate × 0.40 + momNeutrality × 0.35 + bbCompression × 0.25
```

Score ≥ 0.55 → skip entry.

**FakeBreakoutFilter**: kích hoạt khi `|score - 0.5| > 0.15`. Check:
- `volRatio < 0.4` → low volume
- `imbalance` contradicts direction

---

## 7. Execution Edge

```
offset = clamp(spreadBps × 0.3 + depthPenalty + fillRatePenalty, 0, 5)
```

- Spread guard: skip entry nếu spread > 10 bps
- Depth penalty: +$0.5 nếu top-5 book depth < $50k
- Fill rate penalty: +$1.0 nếu fill rate < 60% (ring buffer 20 orders)

| Lệnh | Giá đặt |
|---|---|
| Entry LONG | `best_bid - dynamicOffset` |
| Entry SHORT | `best_ask + dynamicOffset` |
| Exit LONG | `best_bid` (Post-Only) |
| Exit SHORT | `best_ask` (Post-Only) |
| Force close | cross spread (IOC) |

---

## 8. Farm Market Making

**Ping-Pong**: sau LONG exit → bias SHORT; sau SHORT exit → bias LONG.
- `pingPongBias = ±MM_PINGPONG_BIAS_STRENGTH (0.08)`

**Inventory Control**:
- Net exposure > $50 → soft bias (`inventoryBias = ±0.12`)
- Net exposure > $150 → hard block entry → force opposite direction

**Dynamic TP**:
```
dynamicTP = min(max(spreadBps/10000 × price × 1.5, feeFloor), $2.0)
```

---

## 9. Decibel Adapter — Order Management

**`get_open_orders`**: response format `{ items: [...], total_count: N }` — đọc field `items`.

**`cancel_all_orders`**:
- Fetch open orders → lấy danh sách IDs
- Cancel từng order bằng `cancelOrder({ orderId, marketName, subaccountAddr })`
- Parallel cancel với `Promise.allSettled`
- Không dùng `cancelBulkOrder` không có IDs (gây `EORDER_NOT_FOUND` trên Aptos)

---

## 10. Trade Analytics

**TradeRecord** lưu 30+ fields:
- Signal: regime, momentumScore, ema9/21, rsi, imbalance, llmDirection
- Timing: entryTime, exitTime, holdingTimeSecs
- Economics: pnl, grossPnl, feePaid, wonBeforeFee
- Sizing: sizingConfMult, sizingPerfMult, sizingCombinedMult
- MM: mmPingPongBias, mmInventoryBias, mmDynamicTP, mmNetExposure
- Exit trigger: `FARM_TP` | `FARM_MM_TP` | `FARM_TIME` | `FARM_EARLY_PROFIT` | `SL` | `FORCE`

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
│   ├── Watcher.ts            # 5-state machine chính
│   ├── Executor.ts           # Đặt/hủy lệnh
│   ├── ExecutionEdge.ts      # Dynamic offset + spread guard
│   ├── FillTracker.ts        # Fill rate ring buffer
│   ├── PositionSizer.ts      # Dynamic sizing
│   ├── MarketMaker.ts        # Ping-pong + inventory + dynamic TP
│   ├── RiskManager.ts        # TP/SL check + runtime SL override
│   ├── PositionManager.ts    # Duration tracking
│   ├── SessionManager.ts     # Max loss, session state
│   └── TelegramManager.ts    # Telegram bot wrapper
├── ai/
│   ├── AISignalEngine.ts     # Signal engine chính
│   ├── RegimeDetector.ts     # ATR + BB + volume regime
│   ├── ChopDetector.ts       # Chop score
│   ├── FakeBreakoutFilter.ts # Breakout validation
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

---

## 12. Điểm khác biệt chính so với documentation cũ

1. **Cooldown**: Cả farm và trade mode đều dùng random cooldown `[2–5 mins]` - không còn fixed 30s cho farm
2. **Price Position Logic**: Farm mode dùng thresholds 35%/65% (không phải 25%/75%) cho mean reversion
3. **Early Exit**: Threshold là $0.4 (không phải $0.3), và hold time là 60s
4. **Hold Time**: Farm mode hold 2–8 phút (config: `FARM_MIN_HOLD_SECS=120`, `FARM_MAX_HOLD_SECS=480`)
5. **Trade Mode**: Không có time-based exit - chỉ TP/SL
6. **Extra Wait**: 30s grace period sau hold expired nếu profitable
