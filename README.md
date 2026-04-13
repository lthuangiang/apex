# APEX — AI-Powered BTC Perpetual Trading Bot

APEX là trading bot tự động cho BTC perpetual futures, tích hợp **AI signal engine** (LLM + technical indicators), **local trading memory** (ChromaDB + Ollama), **analytics engine**, và **web dashboard** real-time. Hỗ trợ hai sàn: **SoDEX** và **Decibel**.

---

## Hai chế độ hoạt động

### Farm Mode (`MODE=farm`)
Mục tiêu: **tối đa hóa volume** để tích lũy SoPoints.

- Vào lệnh thường xuyên, giữ 2–5 phút
- **Không cần confirmation** — enter ngay trên tick đầu tiên khi signal hợp lệ
- Điều kiện entry: score edge > 3% (`|score - 0.5| > FARM_SCORE_EDGE`) và confidence ≥ 0.50
- Exit theo thứ tự ưu tiên: SL 5% → TP ($) → Early profit (≥2 phút, PnL ≥ $0.4) → Time limit (5 phút)
- TP tính cả fee: `max(FARM_TP_USD, fee_round_trip × 1.5)`
- Dynamic hold: nếu hết hold time nhưng giá đang phục hồi → chờ thêm tối đa `FARM_EXTRA_WAIT_SECS` (30s)

### Trade Mode (`MODE=trade`)
Mục tiêu: **tối đa hóa win rate**.

- Chỉ vào khi signal mạnh: confidence ≥ 0.65, score edge > 6.5%
- **Cần confirmation**: cùng direction trên 2 tick liên tiếp trong vòng 60s
- Regime bias: signal ngược chiều trend bị giảm 50% weight
- Last trade context bias: điều chỉnh score dựa trên kết quả trade trước
- Exit **chỉ** khi hit TP 0.3% hoặc SL 0.2% — không có time exit
- R:R = 1.5:1 → cần win rate > 40% để profitable

---

## Kiến trúc

```
bot.ts
  └── SessionManager          # Session state, max loss guard
  └── Watcher                 # State machine chính (IDLE → PENDING_ENTRY → IN_POSITION → PENDING_EXIT)
        ├── AISignalEngine     # Signal chính: EMA9/21, RSI, momentum, OB imbalance + LLM
        │     └── LLMClient   # OpenAI / Anthropic — quyết định direction + confidence
        ├── SignalEngine       # Fallback signal (contrarian, dùng khi AISignalEngine throw)
        ├── RiskManager        # TP/SL check mỗi tick
        ├── PositionManager    # Duration tracking
        └── Executor           # Đặt/hủy lệnh Post-Only (maker)

  └── TelegramManager          # Bot Telegram: commands + inline buttons
  └── TradeLogger              # Ghi trade record (JSON hoặc SQLite)
  └── DashboardServer          # Express dashboard + SSE real-time

src/ai/TradingMemory/          # Local AI memory (ChromaDB + Ollama)
  └── TradingMemoryService     # saveTrade() + predict() — học từ lịch sử
  └── VectorStore              # ChromaDB similarity search
  └── TradeDB                  # SQLite persistence
  └── OllamaClient             # Local LLM (llama3)

src/config/
  └── ConfigStore              # Runtime config override (không cần restart)
  └── validateOverrides        # Validation rules cho config
```

**State machine**: `IDLE → PENDING_ENTRY → IN_POSITION → PENDING_EXIT → IDLE`

---

## AI Signal Engine

`AISignalEngine` tính **momentum score** từ 5m candles + market data, sau đó gọi LLM để ra quyết định:

| Nguồn | Logic | Trọng số |
|---|---|---|
| EMA9 vs EMA21 | EMA9 > EMA21 → bullish momentum | 40% |
| RSI(14) | < 35 oversold → long, > 65 overbought → short | 25% |
| 3-candle momentum | Price change 3 nến gần nhất | 20% |
| Orderbook imbalance | bid/ask volume ratio (direct, không contrarian) | 15% |
| Candle pattern | EMA cross, hammer, shooting star | ±5% bonus |

Regime detection: `TREND_UP` / `TREND_DOWN` / `SIDEWAY` dựa trên khoảng cách giá vs EMA21 (±0.2%).

Trong SIDEWAY: penalize long khi giá ở đỉnh range (>75%), penalize short khi ở đáy (<25%).

LLM nhận full context (EMA, RSI, momentum, volume spike, L/S ratio, orderbook, fee) và trả về `direction` + `confidence` + `reasoning`. Nếu LLM fail → fallback dùng momentum score trực tiếp.

**Fallback SignalEngine** (contrarian): dùng khi `AISignalEngine` throw exception. Logic ngược lại — giá trên SMA → SHORT signal, crowd long nhiều → SHORT signal.

---

## Local Trading Memory

Module `TradingMemory` cho phép bot **học từ lịch sử giao dịch** của chính nó:

- Mỗi trade được lưu vào SQLite + ChromaDB dưới dạng vector embedding 6 chiều
- Khi cần predict, tìm 10 trade tương tự nhất (cosine similarity) → gọi Ollama (llama3) để ra quyết định
- Endpoint HTTP: `POST /api/memory/save`, `POST /api/memory/predict`, `GET /api/memory/health`

---

## Analytics Engine

`AnalyticsEngine` tính win rate và performance metrics đa chiều từ trade history:

- Overall, by mode (farm/trade), by direction (long/short), by regime, by confidence bucket, by hour UTC
- Signal quality: LLM vs momentum agreement rate, fallback rate, avg confidence
- Fee impact: total fee paid, trades won before fee but lost after
- Holding time distribution (farm mode)
- Streak tracking: max consecutive wins/losses, current streak

---

## Cài đặt

### Local

```bash
npm install
cp .env.example .env
# Điền API keys
npm start
```

### Docker (production)

```bash
cp .env.example .env
mkdir -p data
chown -R 1000:1000 data
docker compose up -d
```

---

## Cấu hình `.env`

```env
# Exchange (chọn 1)
EXCHANGE=sodex

# SoDEX
SODEX_API_KEY=...
SODEX_API_SECRET=0x...
SODEX_SUBACCOUNT=0x...

# Decibel (nếu dùng)
DECIBELS_PRIVATE_KEY=...
DECIBELS_NODE_API_KEY=...
DECIBELS_SUBACCOUNT=0x...

# Telegram
TELEGRAM_BOT_TOKEN=...
TELEGRAM_CHAT_ID=...
TELEGRAM_ENABLED=true

# AI (cloud LLM)
LLM_PROVIDER=openai          # hoặc anthropic
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...

# SoDex SoPoints
SODEX_SOPOINTS_TOKEN=...     # Update runtime qua Bot Settings

# Trade Logger
TRADE_LOG_BACKEND=json       # json hoặc sqlite
TRADE_LOG_PATH=/app/data/trades.json

# State persistence
STATE_STORE_PATH=/app/data/bot_state.json

# Dashboard
DASHBOARD_PORT=3000
DASHBOARD_PASSCODE=          # để trống = không cần mật khẩu
```

---

## Telegram commands

| Command | Mô tả |
|---|---|
| `/start_bot` | Bắt đầu session |
| `/stop_bot` | Dừng bot |
| `/status` | Xem trạng thái, uptime, PnL |
| `/check` | Xem position đang mở (có nút Close) |
| `/set_mode farm\|trade` | Đổi mode |
| `/set_max_loss <usd>` | Giới hạn lỗ session |
| `/long [size]` | Lệnh long thủ công (bot phải dừng) |
| `/short [size]` | Lệnh short thủ công (bot phải dừng) |

---

## Dashboard

Truy cập `http://localhost:3000`

- Session PnL, volume, SoPoints tier + countdown
- Trade history, event log, real-time console stream (SSE)
- Bot controls: start/stop, mode, max loss, force close position
- **Bot Settings popup**: chỉnh tất cả config runtime không cần restart
- **Analytics tab**: win rate breakdown, signal quality, fee impact, holding time
- SoDex SoPoints token: update runtime khi expired

---

## Config runtime (Bot Settings)

Tất cả tham số sau có thể thay đổi trực tiếp trên dashboard:

| Tham số | Mô tả |
|---|---|
| `ORDER_SIZE_MIN/MAX` | Size lệnh (BTC) |
| `FARM_TP_USD` | Farm TP ($) |
| `FARM_SL_PERCENT` | Farm SL (%) |
| `FARM_MIN/MAX_HOLD_SECS` | Farm hold time |
| `FARM_SCORE_EDGE` | Min score edge để vào lệnh farm |
| `FARM_MIN_CONFIDENCE` | Min confidence fallback farm |
| `FARM_EARLY_EXIT_SECS/PNL` | Early exit threshold |
| `FARM_EXTRA_WAIT_SECS` | Extra wait sau hold time |
| `FARM_BLOCKED_HOURS` | Block giờ UTC (array) |
| `TRADE_TP_PERCENT` | Trade TP (%) |
| `TRADE_SL_PERCENT` | Trade SL (%) |
| `COOLDOWN_MIN/MAX_MINS` | Cooldown giữa lệnh |
| `MIN_POSITION_VALUE_USD` | Bỏ qua đóng dust position |

---

## Scripts debug

```bash
npm run test:balance    # Xem raw balance API response
npm run test:signal     # Test AI signal engine
npm run test:llm        # Test LLM connection
```

---

> **Cảnh báo**: Phần mềm này chỉ dành cho mục đích nghiên cứu. Giao dịch perpetual futures có rủi ro thanh lý cao. Không commit file `.env` lên git.
