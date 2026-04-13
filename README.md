# APEX — Adaptive Perpetual Execution

APEX là trading bot tự động cho BTC perpetual futures, tích hợp AI signal engine, adaptive learning, và pseudo market-making để tối đa hóa cả **volume** lẫn **win rate**. Hỗ trợ nhiều sàn: **SoDEX**, **Dango Exchange**, và **Decibel**.

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
- Exit: SL 5% → Dynamic TP → Early profit → Time limit (2–5 phút)

### Trade Mode (`MODE=trade`) — Tối đa hóa win rate
Mục tiêu: **chỉ vào khi có edge rõ ràng**.

- Regime check → skip nếu HIGH_VOL
- Chop detection → skip nếu choppy
- Fake breakout filter → skip nếu thiếu OB confirmation
- Confidence ≥ 0.65 (calibrated)
- 2-tick confirmation trong 60s
- Exit: SL 5% hoặc TP 5% — không có time exit

---

## Kiến trúc

```
bot.ts
  └── Watcher                 # State machine: IDLE → PENDING_ENTRY → IN_POSITION → PENDING_EXIT
        ├── AISignalEngine     # Signal: EMA9/21, RSI, momentum, OB + LLM (adaptive weights)
        │     ├── WeightStore          # Adaptive signal weights (Phase 1)
        │     ├── ConfidenceCalibrator # Historical win rate calibration (Phase 1)
        │     └── RegimeDetector       # ATR + BB width + volume → 4-state regime (Phase 3)
        ├── PositionSizer      # Dynamic sizing: confidence × performance × volatility (Phase 2)
        ├── RiskManager        # TP/SL check, runtime SL override (Phase 3)
        ├── MarketMaker        # Ping-pong bias + inventory control + dynamic TP (Phase 6)
        ├── ChopDetector       # Chop score (Phase 4) — trade mode only
        ├── FakeBreakoutFilter # Breakout validation (Phase 4) — trade mode only
        ├── ExecutionEdge      # Dynamic price offset + spread guard (Phase 5)
        ├── FillTracker        # Fill rate tracking, feedback vào offset (Phase 5)
        └── Executor           # Đặt/hủy lệnh Post-Only (maker)

  └── FeedbackLoop/            # Adaptive signal weights (Phase 1)
        ├── ComponentPerformanceTracker
        ├── AdaptiveWeightAdjuster
        └── WeightStore

  └── TelegramManager          # Bot Telegram: commands + inline buttons
  └── TradeLogger              # Ghi trade record (JSON hoặc SQLite)
  └── DashboardServer          # Express dashboard + SSE real-time
```

---

## Farm Mode — Chi tiết

**Entry**: luôn execute, không skip.
- Signal direction → dùng trực tiếp
- Signal skip → alternate từ last trade
- MM inventory hard block → force opposite direction (không return)

**Exit** (theo thứ tự ưu tiên):
1. SL: `FARM_SL_PERCENT = 5%`
2. Dynamic TP: `max(spreadBps/10000 × price × 1.5, feeFloor)`, capped $2.0
3. Early profit: hold ≥ 120s AND pnl ≥ $0.4
4. Time exit: sau hold time (120–300s), chờ thêm 30s nếu đang phục hồi

**Cooldown**: adaptive — tăng khi losing streak hoặc choppy (trade mode only).

---

## Trade Mode — Chi tiết

**Entry pipeline** (fail-fast):
1. Regime check → skip nếu HIGH_VOL skip enabled
2. Chop detection → skip nếu `chopScore ≥ 0.55`
3. Fake breakout filter → skip nếu breakout thiếu OB confirmation
4. Confidence ≥ 0.65
5. 2-tick confirmation trong 60s

**Exit**: SL 5% hoặc TP 5% — không có time exit.

---

## AI Signal Engine

Momentum score từ 5m candles với **adaptive weights** (tự điều chỉnh mỗi 10 trades):

| Nguồn | Logic | Default weight |
|---|---|---|
| EMA9 vs EMA21 | EMA9 > EMA21 → bullish | ~40% |
| RSI(14) | < 35 oversold, > 65 overbought | ~25% |
| 3-candle momentum | Price change 3 nến gần nhất | ~20% |
| Orderbook imbalance | bid/ask volume ratio | ~15% |

**SIDEWAY range logic**: trong SIDEWAY regime, `pricePositionInRange` tính vị trí giá trong range 10 nến gần nhất (0 = đáy, 1 = đỉnh):
- Giá ở đỉnh range (> 75%) → `momentumScore -= 0.08` (penalize long, favor short)
- Giá ở đáy range (< 25%) → `momentumScore += 0.08` (penalize short, favor long)

Khi LLM fail trong SIDEWAY, dùng price position làm primary signal:
- `pricePosition < 30%` → LONG (mean reversion từ đáy)
- `pricePosition > 70%` → SHORT (mean reversion từ đỉnh)
- Mid-range → dùng momentum score

LLM (GPT-4o / Claude) nhận full context → `direction + confidence + reasoning`. Nếu LLM fail → fallback momentum + price position in range. Cache 60s.

---

## Exchange Integration

APEX hỗ trợ 2 sàn qua interface chung `ExchangeAdapter` — thêm sàn mới chỉ cần implement 9 methods.

### SoDEX (`EXCHANGE=sodex`)
- REST API với **EIP-712 typed data signing** (Ethereum-compatible)
- Post-Only orders: `timeInForce = 4` — 0.012% maker fee
- Spread guard: skip entry nếu spread > 10 bps
- SoPoints integration: tier tracking, weekly volume, countdown, token refresh runtime

### Dango Exchange (`EXCHANGE=dango`)
- GraphQL endpoint (không phải REST)
- **Secp256k1 signing**: SHA-256 hash của canonical SignDoc JSON
- Market orders và limit orders (GTC/IOC/POST)
- Size là USD notional (tự động convert từ BTC quantity)
- Pair format: `perp/btcusd`
- Cấu hình: `DANGO_PRIVATE_KEY`, `DANGO_USER_ADDRESS`, `DANGO_NETWORK` (mainnet/testnet)

### Decibel (`EXCHANGE=decibel`)
- Aptos blockchain-based DEX
- **Ed25519 signing** via `@aptos-labs/ts-sdk`
- Post-Only order support
- Cấu hình: `DECIBELS_PRIVATE_KEY`, `DECIBELS_NODE_API_KEY`, `DECIBELS_SUBACCOUNT`
- Aptos blockchain-based DEX
- **Ed25519 signing** via `@aptos-labs/ts-sdk`
- Post-Only order support
- Cấu hình: `DECIBELS_PRIVATE_KEY`, `DECIBELS_NODE_API_KEY`, `DECIBELS_SUBACCOUNT`

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
docker compose up -d
```

---

## Cấu hình `.env`

```env
# Exchange — chọn 1 trong 2
EXCHANGE=sodex

# SoDEX
SODEX_API_KEY=...
SODEX_API_SECRET=0x...
SODEX_SUBACCOUNT=0x...

# Decibel (nếu dùng EXCHANGE=decibel)
DECIBELS_PRIVATE_KEY=0x...
DECIBELS_NODE_API_KEY=...
DECIBELS_SUBACCOUNT=0x...

# Dango (nếu dùng EXCHANGE=dango)
DANGO_PRIVATE_KEY=0x...
DANGO_USER_ADDRESS=0x...
DANGO_NETWORK=mainnet

TELEGRAM_BOT_TOKEN=...
TELEGRAM_CHAT_ID=...

LLM_PROVIDER=openai
OPENAI_API_KEY=sk-...

TRADE_LOG_BACKEND=json
TRADE_LOG_PATH=/app/data/trades.json
DASHBOARD_PORT=3000
DASHBOARD_PASSCODE=
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

- Session PnL, volume, SoPoints tier + countdown
- Trade history, event log, live console stream (SSE)
- Bot controls: start/stop, mode, max loss, force close
- **Bot Settings**: chỉnh tất cả config runtime không cần restart
- **Analytics tab**: win rate breakdown, signal quality, fee impact

---

## Config runtime

Tất cả tham số thay đổi trực tiếp trên dashboard:

| Group | Keys |
|---|---|
| Order sizing | `ORDER_SIZE_MIN/MAX`, `SIZING_*` |
| Farm mode | `FARM_TP_USD`, `FARM_SL_PERCENT`, `FARM_MIN/MAX_HOLD_SECS` |
| Trade mode | `TRADE_TP_PERCENT (5%)`, `TRADE_SL_PERCENT (5%)` |
| Regime | `REGIME_HIGH_VOL_THRESHOLD`, `REGIME_*_HOLD_MULT` |
| Anti-chop | `CHOP_SCORE_THRESHOLD`, `CHOP_COOLDOWN_MAX_MINS` |
| Execution | `EXEC_MAX_SPREAD_BPS`, `EXEC_OFFSET_MAX` |
| Market making | `MM_ENABLED`, `MM_INVENTORY_HARD_BLOCK`, `MM_TP_MAX_USD` |

---

> **Cảnh báo**: Phần mềm này chỉ dành cho mục đích nghiên cứu. Không commit file `.env` lên git.
