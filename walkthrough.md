# DRIFT — Hướng Dẫn Đầy Đủ

Tài liệu này hướng dẫn chi tiết từ setup đến vận hành DRIFT trading bot, bao gồm 3 chiến lược (Farm, Trade, Hedge) và tính năng Daily Budget Reset.

---

## Mục Lục

1. [Bắt Đầu Nhanh](#bắt-đầu-nhanh)
2. [Setup Chi Tiết Cho Người Mới](#setup-chi-tiết-cho-người-mới)
3. [Workflow Hàng Ngày](#workflow-hàng-ngày)
4. [Ba Chiến Lược Trading](#ba-chiến-lược-trading)
5. [Daily Budget Reset](#daily-budget-reset)
6. [Cấu Hình Nâng Cao](#cấu-hình-nâng-cao)
7. [Dashboard & Giám Sát](#dashboard--giám-sát)
8. [Xử Lý Sự Cố](#xử-lý-sự-cố)

---

## Bắt Đầu Nhanh

### Yêu Cầu

- Node.js 18+ hoặc Docker
- API keys từ SoDEX/Dango/Decibel
- Telegram bot token (tùy chọn)

### Cài Đặt 3 Bước

```bash
# 1. Clone & install
git clone <repo-url> && cd drift && npm install

# 2. Cấu hình
cp .env.example .env
# Điền API keys vào .env

# 3. Chạy
npm start
```

Dashboard: `http://localhost:3000`

---

## Setup Chi Tiết Cho Người Mới

### Bước 1: Chuẩn Bị Môi Trường

**Cài Node.js:**

```bash
# macOS
brew install node

# Ubuntu/Debian
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs

# Kiểm tra
node --version  # >= 18.0.0
```

**Hoặc dùng Docker:**

```bash
# Cài Docker Desktop (macOS/Windows)
# https://www.docker.com/products/docker-desktop

# Hoặc Docker Engine (Linux)
curl -fsSL https://get.docker.com | sh
```

### Bước 2: Lấy API Keys

#### SoDEX (Khuyến nghị cho Farm Mode)

1. Truy cập https://sodex.dev
2. Đăng ký/đăng nhập
3. Settings → API Keys → Create New
4. Lưu lại: `API_KEY`, `API_SECRET`, `SUBACCOUNT` (địa chỉ ví con)

**Lưu ý:** SoDEX có maker fee 0.012% — rất thấp, phù hợp farm volume.

#### Decibel (Aptos)

1. Cài Petra Wallet: https://petra.app
2. Tạo ví mới hoặc import existing
3. Settings → Export Private Key
4. Lấy Node API key từ https://decibel.finance/api
5. (Tùy chọn) Gas Station API key để sponsor gas

#### Dango

1. Cài MetaMask: https://metamask.io
2. Tạo ví hoặc import
3. Account Details → Export Private Key
4. Copy địa chỉ ví (0x...)

### Bước 3: Tạo Telegram Bot

```
1. Mở Telegram, tìm @BotFather
2. Gửi: /newbot
3. Đặt tên: MyTradingBot
4. Đặt username: my_trading_bot
5. Lưu token: 123456:ABC-DEF...

6. Lấy Chat ID:
   - Gửi tin nhắn cho bot
   - Truy cập: https://api.telegram.org/bot<TOKEN>/getUpdates
   - Tìm "chat":{"id": 123456789}
```

### Bước 4: Clone & Cài Đặt

```bash
git clone <repo-url>
cd drift
npm install
```

### Bước 5: Cấu Hình .env

```bash
cp .env.example .env
nano .env
```

**Template cho SoDEX:**

```env
EXCHANGE=sodex
SYMBOL=BTC-USD

SODEX_API_KEY=your_key
SODEX_API_SECRET=0x...
SODEX_SUBACCOUNT=0x...

TELEGRAM_BOT_TOKEN=123456:ABC...
TELEGRAM_CHAT_ID=123456789

LLM_PROVIDER=openai
OPENAI_API_KEY=sk-...

TRADE_LOG_BACKEND=json
TRADE_LOG_PATH=./trades.json
DASHBOARD_PORT=3000
```

### Bước 6: Build & Chạy

```bash
npm run build
npm start
```

**Output mong đợi:**

```
🚀 SHIELD-BOT starting...
🔌 Using SoDEX adapter
📡 [System] Multi-Bot Manager ready
🤖 Dashboard running on http://localhost:3000
```

### Bước 7: Truy Cập Dashboard

1. Mở browser: `http://localhost:3000`
2. Xem bot status
3. Click "Bot Settings" → điều chỉnh config
4. Click "Start Bot"

---

## Workflow Hàng Ngày

### Sáng (Khởi Động Bot)

```bash
# 1. Kiểm tra bot status
docker ps  # nếu dùng Docker

# 2. Xem logs
docker logs -f drift-bot --tail 50

# 3. Kiểm tra balance
# Dashboard → Bot Detail → Balance

# 4. Set max loss cho session (nếu không dùng daily reset)
# Telegram: /set_max_loss 5
```

### Trong Ngày (Giám Sát)

**Qua Dashboard:**
- Xem real-time console
- Kiểm tra PnL mỗi 1-2 giờ
- Analytics tab: win rate, fee impact

**Qua Telegram:**
```
/status          # Tổng quan
/check           # Position hiện tại
```

**Điều chỉnh nếu cần:**
- Win rate < 50% → tăng confidence threshold
- Không trade → hạ confidence threshold
- Fee impact cao → tăng min hold time

### Tối (Tổng Kết)

```bash
# Xem tổng kết ngày
# Dashboard → Analytics → Today's Stats

# Backup state
cp bot_state.json bot_state_backup_$(date +%Y%m%d).json

# Nếu dùng daily reset: bot tự restart lúc 0h UTC — không cần làm gì
# Nếu không dùng daily reset: dừng thủ công
# Telegram: /stop_bot
```

---

## Ba Chiến Lược Trading

### 1. Farm Mode — Tối Đa Hóa Volume

**Mục tiêu:** Trade liên tục để farm SoPoints/rebate.

**Khi nào dùng:**
- Sàn có volume incentive (SoDEX, Dango)
- Maker fee thấp (< 0.02%)
- Muốn tích điểm/airdrop

**Workflow vào lệnh:**

```
AISignalEngine lấy signal
  │
  ▼
[1] RegimeGate: SIDEWAY ≥ 0.01, TREND ≥ 0.01
  │
  ▼
[2] PressureGate: skip nếu pressure=0 và confidence thấp
  │
  ▼
[3] FallbackGate: skip nếu fallback signal yếu
  │
  ▼
[4] FeeFilter: skip nếu edge < fee cost
  │
  ▼
Quyết định hướng (KHÔNG BAO GIỜ SKIP):
  ├── pricePosition > 65% → SHORT
  ├── pricePosition < 35% → LONG
  ├── giữa range → dùng momentum score
  └── không rõ → alternate với lệnh trước
  │
  ▼
Đặt lệnh limit (Post-Only)
```

**Workflow thoát lệnh (ưu tiên từ trên xuống):**

```
Mỗi tick khi IN_POSITION:
  │
  ├── pnl ≤ -SL_PERCENT → EXIT (SL 5%)
  ├── MM enabled AND pnl ≥ dynamicTP → EXIT
  ├── pnl ≥ FARM_TP_USD ($0.5) → EXIT
  ├── held ≥ 60s AND pnl ≥ fee×1.2 → EXIT (early profit)
  └── held ≥ dynamicMinHold → wait 30s grace → EXIT (time exit)
```

**Cooldown:** 30s cố định

**Config khuyến nghị:**

```json
{
  "mode": "farm",
  "farmMinHoldSecs": 120,
  "farmMaxHoldSecs": 480,
  "farmTpUsd": 0.5,
  "farmCooldownSecs": 30
}
```

---

### 2. Trade Mode — Tối Đa Hóa Win Rate

**Mục tiêu:** Chỉ vào khi có edge rõ ràng.

**Workflow vào lệnh:**

```
AISignalEngine lấy signal
  │
  ▼
[1] Regime: HIGH_VOL → skip
  │
  ▼
[2] ChopDetector: chopScore ≥ 0.55 → skip
  │
  ▼
[3] FakeBreakout: OB mâu thuẫn → skip
  │
  ▼
[4] Confidence: < 0.65 → skip
  │
  ▼
[5] 2-tick confirm: phải confirm trong 60s
  │
  ▼
Đặt lệnh
```

**Workflow thoát:**
```
IN_POSITION:
  ├── pnl ≤ -5% → EXIT (SL)
  └── pnl ≥ +5% → EXIT (TP)
  (không có time exit)
```

**Cooldown:** Random 2-5 phút

---

### 3. Hedge Mode — Correlation Divergence

**Mục tiêu:** Lợi nhuận từ phân kỳ tạm thời BTC/ETH.

**Workflow vào lệnh:**

```
VolumeMonitor.sample() mỗi 15s
  │
  ▼
shouldEnter():
  ├── volumeBTC > avgBTC × 1.21? ✓
  ├── volumeETH > avgETH × 1.21? ✓
  └── cả 2 spike đồng thời? → tiếp tục
  │
  ▼
getSignal(BTC) + getSignal(ETH) song song
  │
  ▼
assignDirections(scoreA, scoreB):
  ├── scoreA > scoreB → long BTC, short ETH
  ├── scoreB > scoreA → long ETH, short BTC
  └── equal → skip
  │
  ▼
Đặt 2 lệnh cùng lúc (cùng USD notional)
```

**Fill management:**

```
WAITING_FILL:
  ├── cả 2 filled → IN_PAIR ✓
  ├── A filled + B rejected → re-place B ngay
  ├── A filled + B pending → chờ 30s → cancel B → OPENING
  └── cả 2 pending → chờ 30s → cancel cả 2 → OPENING
```

**Workflow thoát:**

```
IN_PAIR (check mỗi 5s):
  ├── combinedPnl ≥ profitTargetUsd → EXIT (profit)
  ├── combinedPnl ≤ -maxLossUsd → EXIT (max loss)
  ├── ratio về equilibrium → EXIT (mean reversion)
  └── elapsed ≥ holdingPeriodSecs → EXIT (time expiry)
```

---

## Daily Budget Reset

Tính năng cho phép mỗi bot **tự động reset budget và restart** vào một giờ cố định mỗi ngày. Có **hai điều kiện dừng** — cái nào đến trước thì dừng:

1. **Max Loss**: session PnL ≤ `-dailyMaxLossUsd`
2. **Volume Target**: session volume ≥ `dailyTargetVolumeUsd` (nếu > 0)

### Tại sao cần tính năng này?

Khi bot bị dừng do chạm max loss hoặc đạt volume target trong ngày, không cần can thiệp thủ công — bot sẽ tự reset và chạy lại vào sáng hôm sau với budget mới.

### Hai điều kiện dừng

```
Watcher._tick() mỗi ~5s:
  │
  ├── Section 2: updatePnL(sessionCurrentPnl)
  │     → sessionPnl ≤ -maxLossUsd?
  │       → Có: IOC close all positions + bot.stop() [MAX LOSS]
  │       → Telegram: "⚠️ Max Loss Reached | Limit: $5 | Actual: -$5.12 | Bot stopped"
  │
  └── Section 2.5: updateVolume(sessionVolume)
        → sessionVolume ≥ targetVolumeUsd AND targetVolumeUsd > 0?
          → Có: IOC close all positions + bot.stop() [VOLUME TARGET]
          → Telegram: "🎯 Volume Target Reached | Target: $5,000 | Actual: $5,023 | PnL: +2.40"

Cả hai check chỉ fire 1 lần/session.
DailyResetScheduler._doReset() reset cả hai flags lúc giờ reset.
```

### Workflow đầy đủ

```
Bot khởi động với dailyBudgetReset: true
  │
  ▼
DailyResetScheduler.start()
  ├── Ghi nhớ lastResetDate = hôm nay (tránh fire ngay khi khởi động)
  └── setInterval(60s) — check mỗi phút
        │
        ▼
  Mỗi phút: kiểm tra điều kiện
        ├── currentUTCHour ≠ resetHourUTC → skip
        ├── currentMinute ≠ 0 → skip
        └── todayKey === lastResetDate → skip (đã reset hôm nay)
              │
              ▼ (chỉ fire 1 lần/ngày, đúng phút đầu của giờ reset)
        lastResetDate = todayKey
              │
              ▼
        _doReset():
          Step 1: bot.stop()
                  → sessionManager.stopSession()
                  → watcher.stop()
                  → saveStateSync()
          Step 2: sessionManager.resetMaxLoss()
                  → xóa flag _maxLossTriggered
          Step 3: sessionManager.resetVolumeTarget()
                  → xóa flag _volumeTargetTriggered
          Step 4: sessionManager.setMaxLoss(dailyMaxLossUsd)
                  → áp lại max loss budget mới
          Step 5: sessionManager.setTargetVolume(dailyTargetVolumeUsd)
                  → áp lại volume target mới
          Step 6: bot.start()
                  → sessionManager.startSession()
                  → watcher.resetSession()
                  → watcher.run() (background)
          Step 7: telegram.sendMessage(...)
                  → "🔄 Daily Budget Reset — Bot sodex-bot
                     💰 Budget: $5 max loss | Volume target: $5,000
                     🕐 0:00 UTC (7:00 Vietnam)
                     🚀 Bot auto-restarted"
```

### Cấu hình trong `bot-configs.json`

```json
{
  "id": "sodex-bot",
  "name": "SoDEX Bot",
  "exchange": "sodex",
  "symbol": "BTC-USD",
  "autoStart": true,
  "dailyBudgetReset": true,
  "dailyMaxLossUsd": 5,
  "dailyTargetVolumeUsd": 5000,
  "dailyResetHourUTC": 0
}
```

| Field | Mô tả | Mặc định |
|---|---|---|
| `dailyBudgetReset` | Bật/tắt tính năng | `false` |
| `dailyMaxLossUsd` | Max loss mỗi ngày (USD) | `5` |
| `dailyTargetVolumeUsd` | Volume target mỗi ngày (USD). `0` = tắt | `0` |
| `dailyResetHourUTC` | Giờ reset UTC (0–23) | `0` = 7h VN |

### Cấu hình từ Dashboard (khuyến nghị)

Thay vì sửa file `bot-configs.json` trực tiếp, có thể cấu hình từ giao diện web — thay đổi có hiệu lực ngay, không cần restart:

**Bước 1:** Mở trang bot detail (click vào tên bot từ manager view)

**Bước 2:** Click nút ⚙️ **Bot Settings** (góc trên phải)

**Bước 3:** Trong popup, cuộn xuống section **📅 Daily Budget Reset**

> Lưu ý: Section này chỉ hiển thị trên trang bot detail (multi-bot mode), không hiển thị trên trang overview.

**Bước 4:** Điền các trường:
- **Enable**: toggle bật/tắt tính năng
- **Max Loss/day ($)**: giới hạn lỗ mỗi ngày (ví dụ: `5`)
- **Target Volume/day ($)**: mục tiêu volume (ví dụ: `5000`; để `0` để tắt)
- **Reset Hour UTC**: giờ reset theo UTC (ví dụ: `0` = 7h sáng Vietnam; hint tự động cập nhật khi gõ)

**Bước 5:** Click **✓ Save**

```
saveDailyReset() validate client-side → PATCH /api/bots/:id/daily-reset
  │
  ▼
Server:
  1. Validate tất cả fields
  2. Cập nhật bot.config (dailyBudgetReset, dailyMaxLossUsd, dailyResetHourUTC, dailyTargetVolumeUsd)
  3. sm.setMaxLoss() + sm.setTargetVolume() — có hiệu lực ngay
  4. bot.syncDailyResetScheduler() — dừng scheduler cũ, tạo mới, start ngay
  5. Persist vào bot-configs.json
  6. Trả về config đã cập nhật
  │
  ▼
Toast "Saved ✓" (xanh) hoặc thông báo lỗi (đỏ)
```

### Múi giờ tham chiếu

| UTC | Vietnam (UTC+7) |
|---|---|
| 0:00 | 7:00 sáng |
| 1:00 | 8:00 sáng |
| 17:00 | 0:00 đêm |

### Lưu ý quan trọng

- `bot.stop()` trong daily reset **không** dừng scheduler. Chỉ khi process shutdown (`SIGTERM`/`SIGINT`) mới gọi `bot.stop(true)` để dừng scheduler.
- Nếu bot đang STOPPED (đã bị dừng do max loss hoặc volume target), scheduler vẫn restart được bình thường.
- `forceReset()` có thể được gọi thủ công từ dashboard để trigger reset ngay lập tức.
- Mỗi bot có scheduler riêng — các bot có thể reset ở các giờ khác nhau.
- `dailyTargetVolumeUsd: 0` = tắt volume target, chỉ dùng max loss.

---

## Cấu Hình Nâng Cao

### Runtime Config (Dashboard)

70+ tham số có thể điều chỉnh không cần restart:

**Farm Mode:**
```
FARM_SIDEWAY_MIN_CONFIDENCE: 0.01-0.60
FARM_TREND_MIN_CONFIDENCE: 0.01-0.60
FARM_MIN_HOLD_SECS: 60-600
FARM_MAX_HOLD_SECS: 120-900
FARM_TP_USD: 0.1-5.0
FARM_COOLDOWN_SECS: 10-120
```

**Trade Mode:**
```
MIN_CONFIDENCE: 0.50-0.90
COOLDOWN_MIN_MINS: 1-30
COOLDOWN_MAX_MINS: 2-60
```

**Market Making:**
```
MM_ENABLED: true/false
MM_INVENTORY_SOFT_BIAS: 50
MM_INVENTORY_HARD_BLOCK: 150
```

**Risk:**
```
FARM_SL_PERCENT: 0.01-0.10
FARM_TP_USD: 0.1-5.0
MIN_POSITION_VALUE_USD: 10-100
```

### Multi-Bot Config (`bot-configs.json`)

Mỗi bot trong mảng `bots` có config độc lập:

```json
{
  "version": 1,
  "bots": [
    {
      "id": "sodex-bot",
      "name": "SoDEX Bot",
      "exchange": "sodex",
      "symbol": "BTC-USD",
      "credentialKey": "SODEX",
      "tradeLogBackend": "json",
      "tradeLogPath": "./trades-sodex.json",
      "autoStart": true,
      "mode": "farm",
      "orderSizeMin": 0.002,
      "orderSizeMax": 0.005,
      "tags": ["Farm", "Market Making"],
      "dailyBudgetReset": true,
      "dailyMaxLossUsd": 5,
      "dailyResetHourUTC": 0
    }
  ]
}
```

Mỗi bot có `ConfigStore` riêng → config hoàn toàn độc lập.

---

## Dashboard & Giám Sát

### Manager View

- Tổng quan tất cả bots
- Total PnL, volume, win rate
- Start/stop từng bot
- Tạo bot mới

### Bot Detail View

- Real-time console (SSE streaming)
- Session PnL, volume, trade count
- Trade history table
- Current position

### Analytics Tab

- Win rate theo regime
- Signal quality metrics
- Fee impact analysis
- Filter skip stats
- Confidence distribution
- Hold time distribution

### Bot Settings

- 70+ params
- Real-time validation
- Apply không cần restart
- Reset về defaults

---

## Xử Lý Sự Cố

### Bot Không Trade (Farm Mode)

**Triệu chứng:**
```
[SignalFilter] SKIP: [RegimeGate] confidence=0.09 < 0.45
```

**Giải pháp:**
1. Dashboard → Bot Settings
2. `FARM_SIDEWAY_MIN_CONFIDENCE: 0.01`
3. Apply Changes

---

### Lệnh Không Fill

**Triệu chứng:**
```
[PENDING] Timeout — cancelling order
```

**Giải pháp:**
1. Hạ `EXEC_SPREAD_OFFSET_MULT` xuống 0.1
2. Kiểm tra orderbook depth
3. Thử symbol khác nếu liquidity thấp

---

### Daily Reset Không Chạy

**Triệu chứng:** Đến 0h UTC nhưng bot không restart.

**Kiểm tra:**
1. `dailyBudgetReset: true` trong `bot-configs.json`?
2. Bot có đang chạy không? (scheduler chỉ active khi `BotInstance` được tạo)
3. Xem logs: `[DailyResetScheduler:sodex-bot] Started — resets daily at 0:00 UTC`

**Lưu ý:** Scheduler seed `lastResetDate` khi khởi động — nếu khởi động đúng lúc 0h UTC thì sẽ không fire ngay, phải chờ đến 0h UTC ngày hôm sau.

---

### Bot Dừng Sớm Hơn Dự Kiến (Volume Target)

**Triệu chứng:** Bot dừng giữa ngày dù chưa lỗ, Telegram báo `🎯 Volume Target Reached`.

**Giải thích:** `dailyTargetVolumeUsd` đã được đặt và session volume đã đạt ngưỡng đó. Đây là hành vi đúng — bot dừng để bảo toàn lợi nhuận sau khi đạt mục tiêu volume.

**Nếu muốn tắt volume target:**
1. Dashboard → Bot Settings → Daily Budget Reset
2. Đặt **Target Volume/day** = `0`
3. Click Save

Hoặc sửa `bot-configs.json`: `"dailyTargetVolumeUsd": 0`

---

### Fee Ăn Hết Lời

**Triệu chứng:** `grossPnl > 0` nhưng `netPnl < 0`

**Giải pháp:**
1. Tăng `FARM_MIN_HOLD_SECS: 180`
2. Tăng `FARM_MIN_PROFIT_FEE_MULT: 1.5`
3. Bật MM: `MM_ENABLED: true`

---

### Rate Limit (SoDEX)

**Triệu chứng:**
```
[SoDEX] Rate limited — backing off 5s
```

Bot tự động chờ, không cần can thiệp. Nếu thường xuyên: giảm số bot trên cùng exchange.

---

## Checklist Production

Trước khi chạy với số tiền lớn:

- [ ] Test với < $50 ít nhất 1 ngày
- [ ] Xem ≥ 20 trades hoàn chỉnh
- [ ] Win rate > 55%
- [ ] Fee impact < 30%
- [ ] Set `dailyMaxLossUsd` hợp lý
- [ ] Set `dailyTargetVolumeUsd` nếu muốn dừng sau khi đạt volume mục tiêu
- [ ] Bật `dailyBudgetReset: true` nếu muốn tự động
- [ ] Telegram alerts hoạt động
- [ ] Backup `bot_state.json` hàng ngày
- [ ] Monitor dashboard ít nhất 2 lần/ngày

---

## Kết Luận

DRIFT là hệ thống trading production-grade với:

- **3 chiến lược** cho các điều kiện thị trường khác nhau
- **Daily budget reset** — tự động reset và restart mỗi ngày
- **Adaptive learning** qua self-adjusting weights
- **Execution safety** qua strict state machines
- **Real-time config** qua dashboard
- **Multi-bot management** cho đa dạng hóa

Bắt đầu với Farm Mode, số tiền nhỏ, bật `dailyBudgetReset` để không cần can thiệp thủ công. Theo dõi kỹ 1-2 ngày đầu rồi scale dần.

Chúc trade thành công! 🚀
