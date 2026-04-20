<div align="center">

<p align="center">
  <img src="drift.png" alt="DRIFT logo" width="480"/>
</p>

### Dynamic Risk-Informed Futures Trading

*AI-powered perpetual futures bot với adaptive learning, intelligent execution, và correlation hedging*

[![TypeScript](https://img.shields.io/badge/TypeScript-007ACC?style=flat&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-339933?style=flat&logo=node.js&logoColor=white)](https://nodejs.org/)
[![Docker](https://img.shields.io/badge/Docker-2496ED?style=flat&logo=docker&logoColor=white)](https://www.docker.com/)

</div>

---

DRIFT là multi-bot trading system cho perpetual futures, hỗ trợ 3 sàn: **SoDEX**, **Dango Exchange**, và **Decibel**. Hệ thống chạy nhiều bot song song với 2 loại chiến lược: **Farm/Trade Bot** (single-asset) và **Hedge Bot** (dual-asset correlation).

## Dashboard

<p align="center">
  <img src="dashboard.png" alt="DRIFT Dashboard" width="800"/>
</p>

## System Architecture

<p align="center">
  <img src="design.png" alt="DRIFT Architecture" width="800"/>
</p>

---

## Hai loại Bot

### Farm/Trade Bot — Single Asset

Bot giao dịch một cặp (BTC-USD, ETH-USD...) với 2 chế độ:

**Farm Mode** — Tối đa hóa volume
- Luôn luôn trade, không bao giờ skip
- Signal `skip` → fallback theo price position trong range (mean reversion)
- Không có confidence gate, chop check, hay fake breakout filter
- Exit: SL 5% → Dynamic TP (MM) → Farm TP $0.5 → Early profit (≥60s + $0.4) → Time exit (2–8 phút)
- Cooldown: random `[COOLDOWN_MIN_MINS, COOLDOWN_MAX_MINS]` (mặc định 2–5 phút)

**Trade Mode** — Tối đa hóa win rate
- Chỉ vào khi có edge rõ ràng
- Pipeline: Regime check → Chop detection → Fake breakout filter → Confidence ≥ 0.65 → 2-tick confirmation
- Exit: SL 5% hoặc TP 5% — không có time exit
- Cooldown: random `[COOLDOWN_MIN_MINS, COOLDOWN_MAX_MINS]` (mặc định 2–5 phút)

### Hedge Bot — Dual Asset Correlation

Bot giao dịch **đồng thời 2 tài sản tương quan** (BTC + ETH) theo hướng ngược nhau. Một leg long, một leg short với cùng USD notional. Lợi nhuận đến từ sự phân kỳ tạm thời giữa 2 tài sản.

**State machine**:
```
IDLE → OPENING → WAITING_FILL → IN_PAIR → CLOSING → COOLDOWN
```

**Entry trigger**: Volume spike đồng thời trên cả 2 symbol + AI signal phân kỳ.

**Fill management** (one-action-per-tick):
- Case 1: 1 filled + 1 rejected → re-place lệnh bị reject ngay tick tiếp theo
- Case 2: 1 filled + 1 pending → chờ fill; timeout 30s → cancel pending → OPENING
- Case 3: 2 pending → chờ fill; timeout 30s → cancel cả 2 → OPENING

**Exit conditions**: Profit target, max loss, mean reversion, hoặc holding period hết hạn.

---

## Kiến trúc tổng quan

```
bot.ts (Multi-Bot Manager)
  ├── BotManager                    # Quản lý nhiều bot song song
  │     ├── BotInstance (Farm/Trade)
  │     │     └── Watcher           # 5-state: IDLE→PENDING→IN_POSITION→EXITING→COOLDOWN
  │     │           ├── AISignalEngine    # EMA9/21, RSI, momentum, OB + LLM
  │     │           ├── PositionSizer     # Dynamic sizing
  │     │           ├── MarketMaker       # Ping-pong + inventory + dynamic TP
  │     │           ├── ChopDetector      # Trade mode only
  │     │           ├── FakeBreakoutFilter
  │     │           ├── ExecutionEdge     # Dynamic offset + spread guard
  │     │           └── Executor          # Post-Only maker orders
  │     │
  │     └── HedgeBot                # Correlation hedging bot
  │           ├── VolumeMonitor     # Dual-symbol volume spike detection
  │           ├── AISignalEngine ×2 # Một engine per symbol
  │           └── State Machine     # IDLE→OPENING→WAITING_FILL→IN_PAIR→CLOSING→COOLDOWN
  │
  ├── FeedbackLoop/                 # Adaptive signal weights
  │     ├── ComponentPerformanceTracker
  │     ├── AdaptiveWeightAdjuster
  │     ├── WeightStore
  │     └── ConfidenceCalibrator
  │
  ├── TelegramManager               # Commands + inline buttons
  ├── TradeLogger                   # JSON hoặc SQLite
  ├── DashboardServer               # Express + SSE real-time
  ├── ConfigStore                   # Runtime config override (70+ params)
  └── SessionManager                # Max loss, session state
```

---

## Hedge Bot — Chi tiết

### State Machine

```
IDLE
  │  Volume spike (cả 2 symbol) + AI signal phân kỳ
  ▼
OPENING
  │  Tick 1: Check open orders → cancel nếu có → return
  │  Tick 2: Đặt 2 lệnh (long A + short B) → chuyển WAITING_FILL
  ▼
WAITING_FILL
  │  Mỗi tick: query positions + open orders
  │  Case 1: 1 filled + 1 rejected → re-place lệnh bị reject
  │  Case 2/3: pending → chờ; timeout 30s → cancel → về OPENING
  ▼
IN_PAIR
  │  Mỗi tick: cập nhật PnL, kiểm tra exit conditions
  │  Exit: profit target | max loss | mean reversion | time expiry
  ▼
CLOSING
  │  Tick 1: Check open orders → cancel nếu có → return
  │  Tick 2: Query actual positions → đặt close orders chỉ cho legs còn mở
  │  Poll flat confirmation (5 lần, 1s interval)
  ▼
COOLDOWN
  │  Chờ cooldownSecs → về IDLE
```

### Cấu hình Hedge Bot

```json
{
  "botType": "hedge",
  "symbolA": "BTC-USD",
  "symbolB": "ETH-USD",
  "legValueUsd": 150,
  "holdingPeriodSecs": 120,
  "profitTargetUsd": 1.0,
  "maxLossUsd": 1.0,
  "volumeSpikeMultiplier": 1.21,
  "volumeRollingWindow": 10,
  "cooldownSecs": 30
}
```

---

## Farm/Trade Bot — State Machine

```
IDLE ──[place order]──► PENDING ──[fill detected]──► IN_POSITION
  ▲                         │                              │
  │                    [cancel only]               [exit trigger]
  │                     (tick N+1)                         │
  │                         │                          EXITING
  │                       IDLE                   [cancel, then place exit]
  │                    (tick N+2)                         │
  └──────────────── COOLDOWN ◄────────────────────────────┘
```

**Strict tick isolation**: mỗi tick chỉ thực hiện đúng **một** action (place OR cancel OR wait) rồi return.

---

## AI Signal Engine

Momentum score từ 5m candles với **adaptive weights** (tự điều chỉnh mỗi 10 trades):

| Nguồn | Logic | Default weight |
|---|---|---|
| EMA9 vs EMA21 | EMA9 > EMA21 → bullish | ~40% |
| RSI(14) | < 35 oversold, > 65 overbought | ~25% |
| 3-candle momentum | Price change 3 nến gần nhất | ~20% |
| Orderbook imbalance | bid/ask volume ratio | ~15% |

LLM (GPT-4o / Claude) nhận full context → `direction + confidence + reasoning`. Cache 60s.

---

## Exchange Integration

| Sàn | Signing | Đặc điểm |
|---|---|---|
| SoDEX | EIP-712 typed data | Post-Only, 0.012% maker fee, SoPoints |
| Decibel | Ed25519 (Aptos) | Gas Station, per-order cancel |
| Dango | Secp256k1 + GraphQL | USD notional sizing |

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
docker build -f Dockerfile -t drift:latest .
docker compose up -d
```

---

## Cấu hình `.env`

```env
# SoDEX
SODEX_API_KEY=...
SODEX_API_SECRET=0x...
SODEX_SUBACCOUNT=0x...

# Decibel
DECIBELS_PRIVATE_KEY=0x...
DECIBELS_NODE_API_KEY=...
DECIBELS_SUBACCOUNT=0x...

# Dango
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

## Dashboard

Truy cập `http://localhost:3000`

- **Manager view**: tất cả bots, PnL tổng hợp, start/stop từng bot
- **Bot detail**: session PnL, volume, real-time console (SSE), trade history
- **Hedge bot**: hiển thị 2 legs đang mở (symbol, side, entry price, unrealized PnL)
- **Analytics tab**: win rate, signal quality, fee impact, regime performance
- **Bot Settings**: chỉnh config runtime không cần restart

---

## Telegram commands

| Command | Mô tả |
|---|---|
| `/start_bot` | Bắt đầu session |
| `/stop_bot` | Dừng bot |
| `/status` | Trạng thái, uptime, PnL |
| `/check` | Position đang mở |
| `/set_mode farm\|trade` | Đổi mode |
| `/set_max_loss <usd>` | Giới hạn lỗ session |

---

> **Cảnh báo**: Phần mềm này chỉ dành cho mục đích nghiên cứu và giáo dục. Trading cryptocurrency có rủi ro cao. Không commit file `.env` lên git.

---

<div align="center">

**Made with ❤️ for the DeFi community**

*DRIFT — Where intelligent execution meets adaptive learning*

</div>
