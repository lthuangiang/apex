# Walkthrough — DRIFT

Hướng dẫn chi tiết về logic hoạt động của từng thành phần trong DRIFT trading system.

---

## 1. Multi-Bot Architecture

DRIFT chạy nhiều bot song song qua `BotManager`. Mỗi bot có state riêng biệt, adapter riêng, và trade log riêng.

**Hai loại bot:**
- `BotInstance` — Farm/Trade bot, giao dịch single asset
- `HedgeBot` — Correlation hedging bot, giao dịch 2 assets đồng thời

Bot configs được load từ `bot-configs.json`. Mỗi config có `botType: "hedge"` hoặc không có (mặc định là Farm/Trade).

---

## 2. Farm/Trade Bot — State Machine (Watcher)

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

### State: IDLE

**Farm Mode** (luôn execute):

1. Sync check: nếu có position → transition thẳng sang `IN_POSITION`
2. Hour blocking (`FARM_BLOCKED_HOURS`)
3. Stale orders check → cancel nếu có → RETURN (1 action)
4. `_retryEntry` check → nếu có → place lại ngay, không re-evaluate signal
5. `AISignalEngine.getSignal()` (cached 60s)
6. MM bias: ping-pong + inventory → adjust direction
7. Direction resolution (NEVER skip): pricePosition → adjustedScore → last trade fallback
8. `PositionSizer.computeSize()` → size
9. `executor.placeEntryOrder()` → `botState = PENDING` → RETURN

**Trade Mode** (full filtering):

1–4. Giống farm
5. Signal + regime config
6. Regime gate → skip nếu `skipEntry`
7. ChopDetector → skip nếu `chopScore ≥ 0.55`
8. FakeBreakoutFilter → skip nếu breakout thiếu volume/OB
9. Confidence ≥ `MIN_CONFIDENCE`
10. 2-tick confirmation (60s window)
11. `executor.placeEntryOrder()` → `botState = PENDING` → RETURN

---

### State: PENDING

```
PENDING tick:
  if position exists → _onEntryFilled() → IN_POSITION → RETURN
  if waitedMs < fillTimeout → log waiting → RETURN
  if cancelledOnTick = false:
    → cancel_all_orders() → cancelledOnTick = true → RETURN (ACTION: cancel)
  if cancelledOnTick = true:
    → check open orders để confirm cancel
    → nếu confirmed → check position (race condition guard)
      → nếu có position → _onEntryFilled() → IN_POSITION
      → nếu không → save retry context → _transitionToIdle() → IDLE
```

- **Partial fill = filled**: bất kỳ position size > 0 đều xem là filled
- `_retryEntry` lưu direction/meta/size để tick IDLE sau có thể re-place
- Farm: max 3 lần retry. Trade: max 10 lần.

---

### State: IN_POSITION

Exit conditions (theo thứ tự ưu tiên):

**Farm Mode**:
1. SL: `FARM_SL_PERCENT = 5%`
2. Dynamic TP (MM enabled): `max(spreadBps/10000 × price × 1.5, feeFloor)`, capped $2.0
3. Farm TP: `FARM_TP_USD = $0.5`
4. Early profit: hold ≥ 60s AND pnl ≥ $0.4 (suppressed trong TREND regime)
5. Time exit: sau hold time (2–8 phút), chờ thêm 30s nếu profitable và đang phục hồi

**Trade Mode**: chỉ SL 5% hoặc TP 5%. **Không có time exit**.

---

### State: EXITING

**Case A** — chưa có `pendingExit`:
```
→ confirm open orders = 0
→ re-verify position vẫn còn
→ dust check: value < MIN_POSITION_VALUE_USD → skip close → COOLDOWN
→ placeExitOrder() → pendingExit = { order, ... } → RETURN
```

**Case B** — đã có `pendingExit`, check fill:
```
→ nếu position gone → _onExitFilled() → COOLDOWN → RETURN
→ nếu waitedMs < 15s → log waiting → RETURN
→ nếu timeout → cancel_all_orders() → pendingExit = null → RETURN
→ tick tiếp: quay về Case A và place lại
```

---

## 3. Hedge Bot — State Machine

### Sơ đồ trạng thái

```
IDLE
  │  shouldEnter(): volume spike cả 2 symbol + AI signal phân kỳ
  ▼
OPENING
  │  Tick A: get_open_orders → nếu có → cancel_all → RETURN
  │  Tick B: place_limit_order(A) + place_limit_order(B) → WAITING_FILL
  ▼
WAITING_FILL
  │  Mỗi tick: query positions + open orders
  │  → Both filled → IN_PAIR
  │  → Case 1: filled A + rejected B → re-place B → RETURN
  │  → Case 2: filled A + pending B → chờ; timeout → cancel B → OPENING
  │  → Case 3: pending A + pending B → chờ; timeout → cancel cả 2 → OPENING
  ▼
IN_PAIR
  │  Mỗi tick: update PnL, check exit conditions
  │  Exit: PROFIT_TARGET | MAX_LOSS | MEAN_REVERSION | TIME_EXPIRY
  ▼
CLOSING
  │  Tick A: get_open_orders → nếu có → cancel_all → RETURN
  │  Tick B: query actual positions → close chỉ legs còn mở
  │  Poll flat confirmation (5 lần, 1s interval)
  ▼
COOLDOWN
  │  Chờ cooldownSecs → IDLE
```

### Tick interval

- `IDLE`: 15 giây (giảm rate limit pressure từ volume sampling)
- Các state khác: 5 giây

### WAITING_FILL — Chi tiết 3 cases

**Case 1: 1 filled + 1 rejected** (không có position, không có pending order)

Leg bị reject không có pending order trên exchange. Bot re-place ngay tick này với giá mark price hiện tại.

```
filledA = true, filledB = false, pendingB = false
→ place_limit_order(B, sideB, markPriceB, sizeB)
→ RETURN (tick tiếp check lại)
```

**Case 2: 1 filled + 1 pending**

Leg đã fill, leg kia đang chờ. Chờ trong vòng 30s. Nếu timeout → cancel pending → về OPENING để đặt lại cả 2.

```
filledA = true, filledB = false, pendingB = true
→ if elapsed < 30s → log "waiting" → RETURN
→ if elapsed >= 30s → cancel_all_orders(B) → OPENING
```

**Case 3: 2 pending**

Cả 2 đang chờ fill. Chờ trong vòng 30s. Nếu timeout → cancel cả 2 → về OPENING.

```
filledA = false, filledB = false, pendingA = true, pendingB = true
→ if elapsed < 30s → log "waiting" → RETURN
→ if elapsed >= 30s → cancel_all_orders(A+B) → OPENING
```

### CLOSING — Chi tiết

Trước khi đặt close order, bot query **actual current positions** từ exchange (không dùng state cũ). Điều này xử lý:
- Partial fills từ trước
- Leg đã flat từ bên ngoài
- Size thực tế khác với size lúc entry

Close side được tính từ position thực tế: `side === 'long' ? 'sell' : 'buy'`.

---

## 4. Volume Monitor (Hedge Bot)

`VolumeMonitor` track volume rolling window cho 2 symbols. Mỗi sample fetch 20 recent trades, tính tổng volume trong 30 giây gần nhất.

```
shouldEnter() = true khi:
  - windowA.length >= windowSize (10 samples)
  - windowB.length >= windowSize
  - currentVolumeA > avgA × spikeMultiplier (1.21)
  - currentVolumeB > avgB × spikeMultiplier
```

Cả 2 symbol phải spike đồng thời. Nếu chỉ 1 spike → không enter.

---

## 5. AI Signal Engine

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
- `pricePosition > 0.65` → `direction = 'short'`
- `pricePosition < 0.35` → `direction = 'long'`
- Mid-range → dùng adjusted momentum score hoặc alternate

**Cache**: 60s TTL. Invalidate sau khi place entry order.

---

## 6. Hedge Bot — Direction Assignment

Sau khi có signal cho cả 2 symbols:

```
assignDirections(symbolA, scoreA, symbolB, scoreB):
  if scoreA > scoreB → longSymbol = A, shortSymbol = B
  if scoreB > scoreA → longSymbol = B, shortSymbol = A
  if scoreA == scoreB → return null (skip entry)
```

Symbol có score cao hơn → long (momentum mạnh hơn).
Symbol có score thấp hơn → short (momentum yếu hơn).

---

## 7. Feedback Loop

Mỗi 10 trades, tính win rate của từng component trên 50 trades gần nhất:

```
if EMA_winRate > 60%  → EMA weight += 0.05
if RSI_lossStreak > 3 → RSI weight -= 0.05
```

Clamp [0.05, 0.60], normalize sum = 1.0. Persist → `signal-weights.json`.

**Confidence calibration**: `adjusted = rawConf × (historicalWinRate / 0.5)`, clamp [0.10, 1.00].

---

## 8. Dynamic Position Sizing (Farm/Trade Bot)

```
size = baseSize × clamp(confMult × 0.6 + perfMult × 0.4) × volatilityFactor
```

- `confMult`: farm = dampened; trade = full scale
- `perfMult`: win rate × drawdown × profile (SCALP/NORMAL/RUNNER/DEGEN)
- `volatilityFactor`: từ regime (farm = 1.0 luôn)

Hard cap: `SIZING_MAX_BTC = 0.008`. Soft cap: `SIZING_MAX_BALANCE_PCT = 2%`.

---

## 9. Execution Edge (Farm/Trade Bot)

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

---

## 10. SoDEX Adapter — Đặc điểm

**Position query**: API trả về tất cả positions bất kể `?symbol=` query. Adapter filter theo symbol trước khi trả về.

**Size normalization**: SoDEX trả về size âm cho short positions. Adapter normalize: `size = Math.abs(rawSize)`, `side` từ sign.

**Quantity**: luôn dùng `Math.abs(qty)` trước khi round — tránh gửi quantity âm.

**Rate limiting**: khi nhận 429, lưu `_rateLimitUntil = now + retryAfterSecs × 1000`. Mọi request tiếp theo tự động chờ.

---

## 11. Cấu trúc thư mục

```
src/
├── bot.ts                    # Bootstrap, multi-bot manager, graceful shutdown
├── config.ts                 # Tất cả tham số mặc định (70+ keys)
├── adapters/
│   ├── ExchangeAdapter.ts    # Interface chung
│   ├── sodex_adapter.ts      # SoDEX (EIP-712 signing)
│   ├── decibel_adapter.ts    # Decibel (Aptos Ed25519)
│   └── dango_adapter.ts      # Dango (Secp256k1 + GraphQL)
├── bot/
│   ├── BotManager.ts         # Quản lý nhiều bot
│   ├── BotInstance.ts        # Farm/Trade bot wrapper
│   ├── HedgeBot.ts           # Correlation hedging bot
│   ├── HedgeBotSharedState.ts
│   ├── VolumeMonitor.ts      # Dual-symbol volume spike detection
│   ├── hedgeBotHelpers.ts    # assignDirections, evaluateExitConditions
│   └── types.ts
├── modules/
│   ├── Watcher.ts            # 5-state machine chính
│   ├── Executor.ts           # Đặt/hủy lệnh
│   ├── ExecutionEdge.ts      # Dynamic offset + spread guard
│   ├── FillTracker.ts        # Fill rate ring buffer
│   ├── PositionSizer.ts      # Dynamic sizing
│   ├── MarketMaker.ts        # Ping-pong + inventory + dynamic TP
│   ├── RiskManager.ts        # TP/SL check
│   ├── SessionManager.ts     # Max loss, session state
│   └── TelegramManager.ts
├── ai/
│   ├── AISignalEngine.ts     # Signal engine chính
│   ├── RegimeDetector.ts     # ATR + BB + volume regime
│   ├── ChopDetector.ts
│   ├── FakeBreakoutFilter.ts
│   ├── LLMClient.ts          # OpenAI / Anthropic client
│   ├── AnalyticsEngine.ts
│   ├── TradeLogger.ts
│   ├── sharedState.ts        # Shared state + SSE broadcast
│   └── FeedbackLoop/
│       ├── WeightStore.ts
│       ├── ComponentPerformanceTracker.ts
│       ├── AdaptiveWeightAdjuster.ts
│       └── ConfidenceCalibrator.ts
├── config/
│   ├── ConfigStore.ts        # Runtime config override
│   └── validateOverrides.ts  # 41+ validation rules
└── dashboard/
    ├── server.ts             # Express dashboard + SSE
    └── views/                # EJS templates
```

---

## 12. Dashboard — Hedge Bot Display

Khi bot là HedgeBot, `/api/bots/:id/position` trả về:

```json
{
  "type": "hedge",
  "hedgePosition": {
    "legA": { "symbol": "BTC-USD", "side": "short", "size": 0.00201, "entryPrice": 74398, "unrealizedPnl": -0.12 },
    "legB": { "symbol": "ETH-USD", "side": "long", "size": 0.0658, "entryPrice": 2278.9, "unrealizedPnl": 0.24 },
    "combinedPnl": 0.12,
    "entryTimestamp": "2026-04-20T09:55:17.000Z"
  }
}
```

Dashboard hiển thị cả 2 legs với combined PnL. Bot card hiển thị widget `⇄ HEDGE` thay vì sparkline khi có position.

---

## 13. Điểm khác biệt chính

1. **Hedge Bot**: state machine 6 states với WAITING_FILL xử lý 3 fill cases
2. **One-action-per-tick**: áp dụng cho cả Farm/Trade Bot và Hedge Bot
3. **Position query**: filter theo symbol (SoDEX trả về tất cả positions)
4. **Size normalization**: `Math.abs()` trước khi gửi quantity
5. **Rate limiting**: auto-backoff khi nhận 429
6. **Tick interval**: IDLE = 15s (hedge), active states = 5s
7. **Fill timeout**: 30s cho WAITING_FILL, sau đó cancel và retry
