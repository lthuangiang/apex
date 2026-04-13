# Walkthrough — APEX

Hướng dẫn chi tiết về logic hoạt động của từng thành phần.

---

## 1. State Machine (Watcher)

Watcher chạy vòng lặp với delay ngẫu nhiên (2s–90s, phân phối lệch về phía ngắn để simulate human behavior và tránh pattern detection). Mỗi tick đi qua state machine:

```
IDLE ──► PENDING_ENTRY ──► IN_POSITION ──► PENDING_EXIT ──► IDLE
           │                                    │
      (5s farm / 15s trade)              (15s timeout)
      cancel + re-place                  cancel + re-place
      (max 3 lần farm / 10 lần trade)
```

### IDLE
1. Check cooldown — nếu đang cooldown → log và return
2. Fetch position, mark price, balance song song
3. Sync `sharedState.openPosition` cho dashboard
4. Check max loss — nếu hit → force close (IOC) + stop bot
5. Nếu có stale open orders → cancel hết, đợi tick sau
6. Lấy signal từ `AISignalEngine`
7. **Farm mode**: enter ngay nếu `scoreEdge > FARM_SCORE_EDGE` và direction hợp lệ; fallback dùng confidence nếu signal yếu
8. **Trade mode**: lưu vào `_lastSignal` — tick tiếp theo nếu cùng direction trong 60s → confirm → place entry
9. Chuyển sang `PENDING_ENTRY`

### PENDING_ENTRY
- Chờ position xuất hiện (fill confirmation)
- **Farm mode**: timeout 5s → cancel + re-place, tối đa 3 lần
- **Trade mode**: timeout 15s → cancel + re-place, tối đa 10 lần
- Race condition guard: check position sau cancel trước khi re-place
- Khi position xuất hiện → set `farmHoldUntil` (farm mode), notify Telegram → `IN_POSITION`

### IN_POSITION
- Mỗi tick: check `RiskManager.shouldClose()` trước (SL/TP)
- **Farm mode** (theo thứ tự ưu tiên):
  1. SL: `RiskManager` phát hiện giá chạm `entry × (1 ± FARM_SL_PERCENT)` → exit ngay
  2. TP: `pnl >= max(FARM_TP_USD, fee_round_trip × 1.5)` → exit ngay
  3. Early profit: hold ≥ `FARM_EARLY_EXIT_SECS` (120s) và PnL ≥ `FARM_EARLY_EXIT_PNL` ($0.4) → exit
  4. Dynamic hold: hết `FARM_MAX_HOLD_SECS` nhưng giá đang phục hồi → chờ thêm tối đa `FARM_EXTRA_WAIT_SECS` (30s)
  5. Time exit: hết thời gian chờ thêm → đóng bất kể PnL
- **Trade mode**: chỉ check TP/SL từ `RiskManager` — không có time exit
- Khi trigger → place exit order → `PENDING_EXIT`

### PENDING_EXIT
- Dust position check: nếu `position_value < MIN_POSITION_VALUE_USD` ($20) → skip close, reset IDLE với cooldown ngắn
- Chờ position biến mất (fill confirmation)
- Sau 15s không fill → cancel + re-place tại giá mới
- Khi position biến mất → log trade record → cooldown ngẫu nhiên `[COOLDOWN_MIN_MINS, COOLDOWN_MAX_MINS]` → `IDLE`

---

## 2. AI Signal Engine

`AISignalEngine` fetch song song 4 nguồn data:
- Orderbook depth (20 levels)
- Recent trades (100 trades)
- Binance 5m klines (30 candles = 2.5h)
- Binance top L/S position ratio (5m)

Tính **momentum score** [0, 1]:

```
momentumScore = (EMA trend    × 0.40)   # EMA9 vs EMA21 (emaAbove ? 0.65 : 0.35)
              + (RSI score    × 0.25)   # < 35 oversold=0.75, > 65 overbought=0.25, linear otherwise
              + (3-candle mom × 0.20)   # price change last 3 candles, clamped [0,1]
              + (OB imbalance × 0.15)   # bid/ask volume ratio (direct, không contrarian)
              + candle pattern bonus    # ±5% (EMA cross, hammer, shooting star)
```

Score > 0.5 = bullish, < 0.5 = bearish.

**Regime detection** dựa trên khoảng cách giá vs EMA21:
- `TREND_UP`: price > EMA21 × 1.002
- `TREND_DOWN`: price < EMA21 × 0.998
- `SIDEWAY`: otherwise

**Price position in range**: tính vị trí giá trong range 10 nến gần nhất (0 = đáy, 1 = đỉnh). Trong SIDEWAY: penalize ±0.08 khi giá ở đỉnh (>75%) hoặc đáy (<25%).

Sau đó gọi **LLM** với full context để lấy `direction` + `confidence` + `reasoning`. Nếu LLM trả về null → fallback dùng momentum score trực tiếp (threshold 0.58/0.42).

**Fallback SignalEngine** (contrarian): dùng khi `AISignalEngine` throw exception. Logic ngược lại — giá trên SMA → SHORT signal, crowd long nhiều → SHORT signal.

---

## 3. LLM Client

Hỗ trợ hai provider:
- **OpenAI**: với model `gpt-4o`
- **Anthropic**: với model `claude-sonnet-4-6`

Prompt bao gồm: EMA9/21, RSI, 3-candle momentum, volume spike, EMA cross, regime, price position in range (0%=đáy, 100%=đỉnh), L/S ratio, orderbook imbalance, trade pressure, round-trip fee.

Strategy instruction: momentum scalping, follow EMA trend, avoid entering against range, fee-aware (0.024% round-trip). Trong SIDEWAY: prefer LONG khi giá <30% range, prefer SHORT khi >70%.

Response format: `{"direction": "long"|"short"|"skip", "confidence": 0.0-1.0, "reasoning": "one sentence"}`.

Timeout: 15s. Nếu fail → return `null` → Watcher dùng momentum fallback.

---

## 4. Farm Mode — chi tiết

**Entry conditions:**
- Signal direction từ LLM (hoặc momentum fallback)
- Score edge > `FARM_SCORE_EDGE` (3%): `|score - 0.5| > 0.03`
- Nếu signal yếu (edge không đủ hoặc direction=skip): dùng confidence ≥ `FARM_MIN_CONFIDENCE` (0.50) làm tiebreaker
- **Không cần 2-tick confirmation** — enter ngay trên tick đầu tiên

**Exit conditions (theo thứ tự ưu tiên):**
1. SL: `RiskManager` phát hiện giá chạm `entry × (1 ± FARM_SL_PERCENT)` → exit ngay
2. TP: `pnl >= max(FARM_TP_USD, fee_round_trip × 1.5)` → exit ngay
3. Early profit: hold ≥ `FARM_EARLY_EXIT_SECS` (120s) và PnL ≥ `FARM_EARLY_EXIT_PNL` ($0.4) → exit
4. Dynamic hold: hết `FARM_MAX_HOLD_SECS` (300s) nhưng giá đang phục hồi → chờ thêm tối đa `FARM_EXTRA_WAIT_SECS` (30s)
5. Time exit: hết thời gian chờ thêm → đóng bất kể PnL

**Hour blocking**: `FARM_BLOCKED_HOURS` (UTC) — skip entry trong các giờ cấu hình.

**Sau exit:** cooldown ngẫu nhiên `[COOLDOWN_MIN_MINS, COOLDOWN_MAX_MINS]` phút.

---

## 5. Trade Mode — chi tiết

**Entry conditions (strict):**
- Signal direction từ LLM
- Final score > 0.65 (threshold cứng)
- **Cần confirmation**: cùng direction trên 2 tick liên tiếp trong vòng 60s
- Regime bias: signal ngược chiều trend bị giảm 50% weight
- Last trade context bias: điều chỉnh score ±0.1 dựa trên kết quả trade trước (side + price movement)
- Confidence filter: confidence ≥ `MIN_CONFIDENCE` (0.65)

**Exit conditions:**
1. SL: giá chạm `entry × (1 ± TRADE_SL_PERCENT)` (0.2%) → exit
2. TP: giá chạm `entry × (1 ± TRADE_TP_PERCENT)` (0.3%) → exit
3. **Không có time exit** — trade chạy đến khi hit TP hoặc SL

**Default TP/SL:**
- TP: 0.3% (~$210 tại $70k BTC)
- SL: 0.2% (~$140 tại $70k BTC)
- R:R = 1.5:1

---

## 6. Order Execution (Executor)

Tất cả lệnh **Post-Only (maker)** để tránh taker fee:

| Lệnh | Giá đặt | TimeInForce |
|---|---|---|
| Entry LONG | `best_bid - offset` | Post-Only (4) |
| Entry SHORT | `best_ask + offset` | Post-Only (4) |
| Exit LONG (sell) | `best_ask` | Post-Only (4) |
| Exit SHORT (buy) | `best_bid` | Post-Only (4) |
| Force close | cross spread (bid/ask) | IOC (3) |

Nếu không fill sau timeout → cancel + re-place tại giá mới.

Executor không chờ fill — chỉ place order và return `PendingOrder`. Watcher check fill status trên tick tiếp theo bằng cách poll `get_position()`.

---

## 7. Risk Management

**Session max loss**: cấu hình qua `/set_max_loss <usd>` (default $5). Khi session PnL chạm giới hạn → force close (IOC) → dừng bot.

**Dust position**: nếu `position_value < MIN_POSITION_VALUE_USD` ($20 mặc định) → skip close, reset IDLE với cooldown ngắn. Tránh lỗi API "quantity invalid".

**Order sizing**: fixed trong `[ORDER_SIZE_MIN, ORDER_SIZE_MAX]` BTC. Watcher dùng `ORDER_SIZE_MIN` cho tất cả lệnh (không scale theo confidence).

---

## 8. Analytics Engine

`AnalyticsEngine.compute(trades)` tính toàn bộ metrics từ `TradeRecord[]`:

- **Overall**: total, wins, losses, win rate, avg PnL, total PnL
- **By mode**: farm vs trade
- **By direction**: long vs short
- **By regime**: TREND_UP, TREND_DOWN, SIDEWAY
- **By confidence bucket**: 0.5–0.6, 0.6–0.7, 0.7–0.8, 0.8–1.0
- **By hour UTC**: performance theo giờ trong ngày
- **Signal quality**: LLM vs momentum agreement rate, fallback rate, avg confidence
- **Fee impact**: total fee paid, trades won before fee but lost after (fee losers)
- **Holding time**: avg, median, distribution theo bucket (farm mode)
- **Streaks**: max consecutive wins/losses, current streak

Cache 30s trên endpoint `/api/analytics/summary`. Invalidate khi có trade mới (`onTradeLogged` callback).

---

## 9. Local Trading Memory

Module `TradingMemory` cho phép bot học từ lịch sử:

**Signal embedding** (6 chiều, normalized [0,1]):
```
[priceNorm, sma50Norm, ls_ratio, orderbook_imbalance, buy_pressure, rsiNorm]
```

**saveTrade flow:**
1. Insert vào SQLite (sync)
2. Compute embedding → upsert vào ChromaDB (async)

**predict flow:**
1. Compute embedding cho signal hiện tại
2. Query ChromaDB → 10 trade tương tự nhất (cosine similarity)
3. Tính win rate từ 10 trade đó
4. Build prompt với context → gọi Ollama (llama3)
5. Parse response → return `PredictionResult`

Fallback khi Ollama unreachable: `{ direction: 'skip', confidence: 0, reasoning: 'llm_unavailable' }`.

---

## 10. State Persistence

Bot lưu state vào `bot_state.json` (path cấu hình qua `STATE_STORE_PATH`):
- Session PnL, volume
- PnL history, volume history (cho charts)
- Event log

Load lại khi restart → dashboard hiển thị data cũ ngay lập tức.

Lưu debounced sau mỗi trade fill. Lưu sync khi shutdown (SIGTERM/SIGINT via `saveStateSync()`).

---

## 11. Config Runtime Override

`ConfigStore` cho phép thay đổi config mà không restart:

1. Dashboard gọi `POST /api/config` với patch object
2. `validateOverrides` kiểm tra constraints (size > 0, TP > SL, v.v.)
3. `ConfigStore.applyOverrides()` merge vào overrides, mutate live `config` object
4. Persist xuống `config-overrides.json`
5. Load lại khi restart (`configStore.loadFromDisk()` trong `bootstrap()`)

Reset về default: `DELETE /api/config`.

---

## 12. SoPoints Integration

Token `SODEX_SOPOINTS_TOKEN` có thể update runtime qua Bot Settings popup — không cần restart.

Dashboard fetch:
- `GET /api/sopoints` → summary (tier, total points, rank)
- `GET /api/sopoints/week` → current week volume + countdown

Khi token expired (401) → serve cached data với badge "⚠ Expired".

---

## 13. SoDEX Adapter — EIP-712 Signing

SoDEX dùng EIP-712 typed data signing cho mọi write request:

1. Build canonical JSON payload (field order phải khớp Go struct)
2. Hash payload với `keccak256`
3. Sign `ExchangeAction { payloadHash, nonce }` với EIP-712
4. Normalize `v` từ 27/28 → 0/1 (Go backend yêu cầu)
5. Prefix signature với `0x01`

Nonce: timestamp ms, tăng dần (tránh replay). Account ID và Symbol ID được cache sau lần fetch đầu.

---

## 14. Cấu trúc thư mục

```
src/
├── bot.ts                    # Bootstrap, Telegram commands, graceful shutdown
├── config.ts                 # Tất cả tham số mặc định
├── adapters/
│   ├── ExchangeAdapter.ts    # Interface chung
│   ├── sodex_adapter.ts      # SoDEX (EIP-712 signing, REST API)
│   └── decibel_adapter.ts    # Decibel (Aptos SDK)
├── modules/
│   ├── Watcher.ts            # State machine chính
│   ├── SignalEngine.ts       # Fallback signal (contrarian)
│   ├── Executor.ts           # Đặt/hủy lệnh, Telegram notifications
│   ├── RiskManager.ts        # TP/SL check
│   ├── PositionManager.ts    # Duration tracking
│   ├── SessionManager.ts     # Max loss, session state
│   └── TelegramManager.ts    # Telegram bot wrapper
├── ai/
│   ├── AISignalEngine.ts     # Signal engine chính (momentum + LLM)
│   ├── LLMClient.ts          # OpenAI / Anthropic client
│   ├── AnalyticsEngine.ts    # Win rate & performance analytics
│   ├── TradeLogger.ts        # Log trade (JSON / SQLite)
│   ├── sharedState.ts        # Shared state + SSE broadcast
│   ├── StateStore.ts         # Persist state to disk
│   └── TradingMemory/        # Local AI memory module
│       ├── types.ts
│       ├── signalEmbedding.ts
│       ├── TradeDB.ts
│       ├── VectorStore.ts
│       ├── OllamaClient.ts
│       ├── TradingMemoryService.ts
│       ├── routes.ts
│       └── index.ts
├── config/
│   ├── ConfigStore.ts        # Runtime config override
│   └── validateOverrides.ts  # Validation rules
├── dashboard/
│   └── server.ts             # Express dashboard (inline HTML + SSE)
└── scripts/
    ├── test-balance.ts       # Debug balance API
    ├── test-ai-signal.ts     # Debug signal engine
    ├── test-llm.ts           # Debug LLM connection
    └── approve-builder-fee.ts # One-time Decibel setup
```
