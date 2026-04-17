# APEX — Adaptive Perpetual Execution

APEX là trading bot tự động cho BTC perpetual futures, tích hợp AI signal engine, adaptive learning, và pseudo market-making để tối đa hóa cả **volume** lẫn **win rate**. Hỗ trợ 3 sàn: **SoDEX**, **Dango Exchange**, và **Decibel**.

---

## Hai chế độ hoạt động

### Farm Mode (`MODE=farm`) — Tối đa hóa volume
Mục tiêu: **luôn luôn trade**, không bao giờ skip.

- Signal `long`/`short` → dùng ngay
- Signal `skip` → fallback alternating direction (long ↔ short)
- Không có confidence gate, chop check, hay fake breakout filter
- Confidence chỉ dùng để scale size, không để gate
- MM bias (ping-pong + inventory) điều chỉnh direction
- Dynamic TP dựa trên spread thực tế
- Exit: SL 5% → Dynamic TP → Early profit → Time limit (1–3 phút)
- Cooldown cố định 30s sau mỗi trade

### Trade Mode (`MODE=trade`) — Tối đa hóa win rate
Mục tiêu: **chỉ vào khi có edge rõ ràng**.

- Regime check → skip nếu HIGH_VOL skip enabled
- Chop detection → skip nếu `chopScore ≥ 0.55`
- Fake breakout filter → skip nếu thiếu OB confirmation
- Confidence ≥ 0.65 (calibrated)
- 2-tick confirmation trong 60s
- Exit: SL 5% hoặc TP 5% — không có time exit
- Cooldown random trong `[COOLDOWN_MIN_MINS, COOLDOWN_MAX_MINS]` (2–4 phút)

---

## Kiến trúc tổng quan

```
bot.ts (SHIELD-BOT)
  └── Watcher                 # 5-state machine: IDLE → PENDING → IN_POSITION → EXITING → COOLDOWN
        ├── AISignalEngine     # Signal: EMA9/21, RSI, momentum, OB + LLM (adaptive weights)
        │     ├── RegimeDetector       # ATR + BB width + volume → 4-state regime
        │     ├── WeightStore          # Adaptive signal weights (tự điều chỉnh mỗi 10 trades)
        │     └── ConfidenceCalibrator # Historical win rate calibration
        ├── PositionSizer      # Dynamic sizing: confidence × performance × volatility
        ├── RiskManager        # TP/SL check, runtime SL override
        ├── MarketMaker        # Ping-pong bias + inventory control + dynamic TP (farm only)
        ├── ChopDetector       # Chop score (trade mode only)
        ├── FakeBreakoutFilter # Breakout validation (trade mode only)
        ├── ExecutionEdge      # Dynamic price offset + spread guard
        ├── FillTracker        # Fill rate tracking, feedback vào offset
        └── Executor           # Đặt/hủy lệnh Post-Only (maker)

  └── FeedbackLoop/            # Adaptive signal weights
        ├── ComponentPerformanceTracker
        ├── AdaptiveWeightAdjuster
        ├── WeightStore
        └── ConfidenceCalibrator

  └── TelegramManager          # Bot Telegram: commands + inline buttons
  └── TradeLogger              # Ghi trade record (JSON hoặc SQLite)
  └── DashboardServer          # Express dashboard + SSE real-time
  └── ConfigStore              # Runtime config override (70+ params)
  └── SessionManager           # Max loss, session state
```

---

## State Machine

```
IDLE ──[place order]──► PENDING ──[fill detected]──► IN_POSITION
  ▲                         │                              │
  │                    [cancel only]               [exit trigger]
  │                         │                              │
  │                       IDLE                         EXITING
  │                                                        │
  └──────────────── COOLDOWN ◄──────────────────────[exit filled]
```

**Strict tick isolation**: mỗi tick chỉ thực hiện đúng **một** action (place OR cancel OR wait) rồi return. Không bao giờ cancel + place trong cùng một tick.

**Dynamic scheduler**:
- `IN_POSITION` + `time_in_position > FARM_EARLY_EXIT_SECS` → **fixed 5s**
- `IN_POSITION` normal → random 5–10s
- `EXITING` / `PENDING` → random 3–8s
- `COOLDOWN` / `IDLE` → weighted random 2s–90s

---

## Farm Mode — Chi tiết

**Entry**: luôn execute, không skip.
- Signal direction → dùng trực tiếp
- Signal skip → dùng điểm số momentum đã điều chỉnh hoặc luân phiên từ last trade
- MM inventory hard block → force opposite direction

**Exit** (theo thứ tự ưu tiên):
1. SL: `FARM_SL_PERCENT = 5%`
2. Dynamic TP (MM): `max(spreadBps/10000 × price × 1.5, feeFloor)`, capped $2.0
3. Farm TP: `FARM_TP_USD = $0.5`
4. Early profit: hold ≥ 60s AND pnl ≥ $0.3
5. Time exit: sau hold time (1–3 phút), chờ thêm 15s nếu đang phục hồi

**Cooldown**: cố định 30s (`FARM_COOLDOWN_SECS`).

---

## Trade Mode — Chi tiết

**Entry pipeline** (fail-fast):
1. Regime check → skip nếu `REGIME_HIGH_VOL_SKIP_ENTRY = true`
2. Chop detection → skip nếu `chopScore ≥ 0.55`
3. Fake breakout filter → skip nếu breakout thiếu OB confirmation
4. Confidence ≥ 0.65
5. 2-tick confirmation trong 60s

**Exit**: SL 5% hoặc TP 5% — không có time exit.

**Cooldown**: random giữa `COOLDOWN_MIN_MINS` và `COOLDOWN_MAX_MINS` (mặc định 2–4 phút).

---

## AI Signal Engine

Momentum score từ 5m candles với **adaptive weights** (tự điều chỉnh mỗi 10 trades):

| Nguồn | Logic | Default weight |
|---|---|---|
| EMA9 vs EMA21 | EMA9 > EMA21 → bullish | ~40% |
| RSI(14) | < 35 oversold, > 65 overbought | ~25% |
| 3-candle momentum | Price change 3 nến gần nhất | ~20% |
| Orderbook imbalance | bid/ask volume ratio | ~15% |

**SIDEWAY range logic**: vị trí giá trong range 10 nến (0 = đáy, 1 = đỉnh) điều chỉnh `momentumScore`:
- Giá ở đỉnh range (> 75%) → `momentumScore -= 0.08`
- Giá ở đáy range (< 25%) → `momentumScore += 0.08`

LLM (GPT-4o / Claude) nhận full context → `direction + confidence + reasoning`. Cache 60s.

---

## Exchange Integration

APEX hỗ trợ 3 sàn qua interface chung `ExchangeAdapter`. `cancel_all_orders` luôn cancel theo **order ID cụ thể** (không dùng bulk cancel không có ID) để tránh `EORDER_NOT_FOUND` trên Aptos.

### Decibel (`EXCHANGE=decibel`)
- Aptos blockchain-based DEX
- **Ed25519 signing** via `@aptos-labs/ts-sdk`
- `get_open_orders` đọc field `items` từ response `{ items, total_count }`
- Cancel từng order bằng `cancelOrder({ orderId, marketName, subaccountAddr })`

### SoDEX (`EXCHANGE=sodex`)
- REST API với **EIP-712 typed data signing**
- Post-Only orders: `timeInForce = 4` — 0.012% maker fee
- SoPoints integration: tier tracking, weekly volume, countdown

### Dango Exchange (`EXCHANGE=dango`)
- GraphQL endpoint
- **Secp256k1 signing**: SHA-256 hash của canonical SignDoc JSON
- Size là USD notional

---

## Cài đặt

```bash
npm install
cp .env.example .env
npm start
```

### Docker

```bash
cp .env.example .env
docker build -f Dockerfile -t apex:latest .
docker compose up -d
```

---

## Cấu hình `.env`

```env
# Exchange — chọn 1 trong 3
EXCHANGE=decibel

# Decibel
DECIBELS_PRIVATE_KEY=0x...
DECIBELS_NODE_API_KEY=...
DECIBELS_SUBACCOUNT=0x...
DECIBELS_BUILDER_ADDRESS=0x...
DECIBELS_GAS_STATION_API_KEY=...

# SoDEX (nếu dùng EXCHANGE=sodex)
SODEX_API_KEY=...
SODEX_API_SECRET=0x...
SODEX_SUBACCOUNT=0x...

# Dango (nếu dùng EXCHANGE=dango)
DANGO_PRIVATE_KEY=0x...
DANGO_USER_ADDRESS=0x...

TELEGRAM_BOT_TOKEN=...
TELEGRAM_CHAT_ID=...

LLM_PROVIDER=openai
OPENAI_API_KEY=sk-...

TRADE_LOG_BACKEND=json
TRADE_LOG_PATH=/app/data/trades.json
DASHBOARD_PORT=3000
```

---

## Telegram commands

| Command | Mô tả |
|---|---|
| `/start_bot` | Bắt đầu session |
| `/stop_bot` | Dừng bot |
| `/status` | Trạng thái, uptime, PnL |
| `/check` | Position đang mở (có nút Close) |
| `/set_mode farm\|trade` | Đổi mode |
| `/set_max_loss <usd>` | Giới hạn lỗ session |
| `/long [size]` | Lệnh long thủ công |
| `/short [size]` | Lệnh short thủ công |

---

## Dashboard

Truy cập `http://localhost:3000`

- Session PnL, volume, real-time console stream (SSE)
- Trade history, event log
- Bot controls: start/stop, mode, max loss, force close
- **Bot Settings**: chỉnh tất cả config runtime không cần restart
- **Analytics tab**: win rate breakdown, signal quality, fee impact, regime performance

---

## Config runtime

70+ tham số thay đổi trực tiếp trên dashboard:

| Group | Keys |
|---|---|
| Order sizing | `ORDER_SIZE_MIN/MAX`, `SIZING_*` |
| Farm mode | `FARM_TP_USD`, `FARM_SL_PERCENT`, `FARM_MIN/MAX_HOLD_SECS`, `FARM_COOLDOWN_SECS` |
| Trade mode | `TRADE_TP_PERCENT`, `TRADE_SL_PERCENT`, `COOLDOWN_MIN_MINS`, `COOLDOWN_MAX_MINS` |
| Regime | `REGIME_HIGH_VOL_THRESHOLD`, `REGIME_*_HOLD_MULT` |
| Anti-chop | `CHOP_SCORE_THRESHOLD` |
| Execution | `EXEC_MAX_SPREAD_BPS`, `EXEC_OFFSET_MAX` |
| Market making | `MM_ENABLED`, `MM_INVENTORY_HARD_BLOCK`, `MM_TP_MAX_USD` |

---

> **Cảnh báo**: Phần mềm này chỉ dành cho mục đích nghiên cứu. Không commit file `.env` lên git.
