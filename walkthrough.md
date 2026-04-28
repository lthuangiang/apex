# DRIFT — Hướng Dẫn Đầy Đủ

Tài liệu này hướng dẫn chi tiết từ setup đến vận hành DRIFT trading bot, bao gồm 3 chiến lược (Farm, Trade, Hedge).

---

## Mục Lục

1. [Bắt Đầu Nhanh](#bắt-đầu-nhanh)
2. [Setup Chi Tiết Cho Người Mới](#setup-chi-tiết-cho-người-mới)
3. [Workflow Hàng Ngày](#workflow-hàng-ngày)
4. [Ba Chiến Lược Trading](#ba-chiến-lược-trading)
5. [Cấu Hình Nâng Cao](#cấu-hình-nâng-cao)
6. [Dashboard & Giám Sát](#dashboard--giám-sát)
7. [Xử Lý Sự Cố](#xử-lý-sự-cố)

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
4. Lưu lại:
   - `API_KEY`
   - `API_SECRET`
   - `SUBACCOUNT` (địa chỉ ví con)

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
# Clone repo
git clone <repo-url>
cd drift

# Cài dependencies
npm install

# Nếu lỗi, thử:
npm install --legacy-peer-deps
```

### Bước 5: Cấu Hình .env

```bash
cp .env.example .env
nano .env  # hoặc code .env
```

**Template cho SoDEX:**

```env
# Exchange
EXCHANGE=sodex
SYMBOL=BTC-USD

# SoDEX
SODEX_API_KEY=your_key
SODEX_API_SECRET=0x...
SODEX_SUBACCOUNT=0x...

# Telegram
TELEGRAM_BOT_TOKEN=123456:ABC...
TELEGRAM_CHAT_ID=123456789

# LLM (tùy chọn)
LLM_PROVIDER=openai
OPENAI_API_KEY=sk-...

# Log
TRADE_LOG_BACKEND=json
TRADE_LOG_PATH=./trades.json

# Dashboard
DASHBOARD_PORT=3000
```

### Bước 6: Build & Chạy

```bash
# Build TypeScript
npm run build

# Chạy bot
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

### Bước 8: Trade Đầu Tiên

**Cấu hình Farm Mode (khuyến nghị cho người mới):**

1. Dashboard → Bot Settings
2. Điều chỉnh:
   ```
   MODE: farm
   FARM_SIDEWAY_MIN_CONFIDENCE: 0.01
   FARM_MIN_HOLD_SECS: 120
   MAX_POSITION_SIZE_USD: 50
   ```
3. Click "Apply Changes"
4. Click "Start Bot"

**Theo dõi:**
- Console log sẽ hiện signal mỗi 5-10s
- Trade đầu tiên trong 5-10 phút
- Xem Analytics tab sau 1 giờ

---

## Workflow Hàng Ngày

### Sáng (Khởi Động Bot)

```bash
# 1. Kiểm tra bot status
docker ps  # nếu dùng Docker
# hoặc
pm2 status  # nếu dùng PM2

# 2. Xem logs
docker logs -f drift-bot --tail 50

# 3. Kiểm tra balance
# Dashboard → Bot Detail → Balance

# 4. Set max loss cho session
# Telegram: /set_max_loss 100
# hoặc Dashboard → Bot Settings → SESSION_MAX_LOSS_USD
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

### Tối (Tổng Kết & Dừng)

```bash
# 1. Xem tổng kết ngày
# Dashboard → Analytics → Today's Stats

# 2. Backup state
cp bot_state.json bot_state_backup_$(date +%Y%m%d).json
cp config-overrides.json config_backup_$(date +%Y%m%d).json

# 3. Dừng bot (nếu muốn)
# Telegram: /stop_bot
# hoặc Dashboard → Stop Bot

# 4. Xem trade log
cat trades.json | jq '.[-10:]'  # 10 trades cuối
```

---

## Ba Chiến Lược Trading

### 1. Farm Mode — Tối Đa Hóa Volume

**Mục tiêu:** Trade liên tục để farm SoPoints/rebate.

**Khi nào dùng:**
- Sàn có volume incentive (SoDEX, Dango)
- Maker fee thấp (< 0.02%)
- Muốn tích điểm/airdrop

**Logic vào lệnh:**

```
1. Lấy signal từ AI
2. Chạy 4 bộ lọc:
   - RegimeGate: SIDEWAY ≥ 0.01, TREND ≥ 0.01
   - PressureGate: skip nếu pressure=0 và confidence thấp
   - FallbackGate: skip nếu fallback signal yếu
   - FeeFilter: skip nếu edge < fee cost

3. Quyết định hướng (KHÔNG BAO GIỜ SKIP):
   - Giá gần đỉnh range (> 65%) → SHORT
   - Giá gần đáy range (< 35%) → LONG
   - Giữa range → dùng momentum score
   - Không rõ → alternate với lệnh trước

4. Đặt lệnh limit (Post-Only)
```

**Logic thoát lệnh (ưu tiên từ trên xuống):**

1. **SL 5%** — cắt lỗ cứng
2. **Dynamic TP** — dựa vào spread thực tế (nếu bật MM)
3. **Farm TP $0.5** — target tối thiểu
4. **Early profit** — giữ ≥ 60s và lời ≥ fee × 1.2
5. **Time exit** — sau 2-8 phút, chờ thêm 30s nếu đang lời

**Cooldown:** 30s cố định

**Config khuyến nghị:**

```env
MODE=farm
FARM_SIDEWAY_MIN_CONFIDENCE=0.01
FARM_TREND_MIN_CONFIDENCE=0.01
FARM_MIN_HOLD_SECS=120
FARM_MAX_HOLD_SECS=480
FARM_TP_USD=0.5
FARM_COOLDOWN_SECS=30
MM_ENABLED=true
```

**Kết quả mong đợi:**
- 20-40 trades/giờ
- Win rate 60-70%
- Net positive sau fee

---

### 2. Trade Mode — Tối Đa Hóa Win Rate

**Mục tiêu:** Chỉ vào khi có edge rõ ràng.

**Khi nào dùng:**
- Thị trường trending
- Không quan tâm volume
- Muốn win rate cao

**Logic vào lệnh:**

```
1. Lấy signal từ AI
2. Chạy 5 bộ lọc:
   - Regime: HIGH_VOL → skip
   - ChopDetector: chopScore ≥ 0.55 → skip
   - FakeBreakout: OB mâu thuẫn → skip
   - Confidence: < 0.65 → skip
   - 2-tick confirm: phải confirm trong 60s

3. Nếu pass hết → đặt lệnh
```

**Logic thoát:**
- SL 5% hoặc TP 5%
- **Không có time exit** — để lệnh chạy

**Cooldown:** Random 2-5 phút

**Config khuyến nghị:**

```env
MODE=trade
MIN_CONFIDENCE=0.70
COOLDOWN_MIN_MINS=5
COOLDOWN_MAX_MINS=10
REGIME_HIGH_VOL_SKIP_ENTRY=true
```

**Kết quả mong đợi:**
- 2-5 trades/giờ
- Win rate 75-85%

---

### 3. Hedge Mode — Correlation Divergence

**Mục tiêu:** Lợi nhuận từ phân kỳ tạm thời BTC/ETH.

**Khi nào dùng:**
- Thị trường sideway
- BTC/ETH correlation cao
- Muốn market neutral

**Logic vào lệnh:**

```
1. VolumeMonitor theo dõi volume 2 symbol
2. Điều kiện vào:
   - Volume BTC spike > 21%
   - Volume ETH spike > 21%
   - Cả 2 spike đồng thời

3. Lấy AI signal cho cả 2
4. Phân hướng:
   - BTC momentum > ETH → long BTC, short ETH
   - ETH momentum > BTC → long ETH, short BTC

5. Đặt 2 lệnh cùng lúc (cùng USD notional)
```

**Fill management:**
- 1 filled + 1 rejected → đặt lại lệnh bị reject
- 1 filled + 1 pending → chờ 30s → cancel → retry
- 2 pending → chờ 30s → cancel cả 2 → retry

**Logic thoát:**
1. Profit target: combined PnL ≥ $5
2. Max loss: combined PnL ≤ -$10
3. Mean reversion: ratio về equilibrium
4. Time expiry: giữ quá 1 giờ

**Config trong bot-configs.json:**

```json
{
  "hedgeBots": [{
    "id": "btc-eth-hedge",
    "exchange": "sodex",
    "symbolA": "BTC-USD",
    "symbolB": "ETH-USD",
    "notionalUsd": 100,
    "profitTargetUsd": 5,
    "maxLossUsd": 10,
    "holdingPeriodSecs": 3600,
    "cooldownSecs": 300
  }]
}
```

**Kết quả mong đợi:**
- 1-3 pairs/giờ
- Win rate 60-70%
- Low correlation với market direction

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
MM_INVENTORY_SOFT_LIMIT_USD: 10-500
MM_INVENTORY_HARD_LIMIT_USD: 50-1000
```

**Risk:**
```
SL_PERCENT: 1-10
TP_PERCENT: 1-20
MAX_POSITION_SIZE_USD: 10-10000
SESSION_MAX_LOSS_USD: 10-1000
```

### Multi-Bot Config

File `bot-configs.json`:

```json
{
  "bots": [
    {
      "id": "sodex-btc-farm",
      "exchange": "sodex",
      "symbol": "BTC-USD",
      "mode": "farm",
      "enabled": true
    },
    {
      "id": "sodex-eth-trade",
      "exchange": "sodex",
      "symbol": "ETH-USD",
      "mode": "trade",
      "enabled": true
    }
  ]
}
```

Mỗi bot có ConfigStore riêng → config độc lập.

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

**Nguyên nhân:** `FARM_SIDEWAY_MIN_CONFIDENCE` quá cao.

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

**Nguyên nhân:**
- Giá quá aggressive
- Spread quá rộng
- Post-Only bị reject

**Giải pháp:**
1. Hạ `EXECUTION_EDGE_SPREAD_MULT` xuống 0.1
2. Kiểm tra orderbook depth
3. Thử symbol khác nếu liquidity thấp

---

### Config Không Áp Dụng

**Triệu chứng:** Đổi config trên dashboard nhưng bot vẫn dùng giá trị cũ.

**Nguyên nhân:** `configStore` không được pass vào `Watcher` (đã fix).

**Giải pháp:**
1. Pull code mới nhất
2. Rebuild: `npm run build`
3. Restart bot

---

### Fee Ăn Hết Lời

**Triệu chứng:** `grossPnl > 0` nhưng `netPnl < 0`

**Nguyên nhân:** Giữ lệnh quá ngắn.

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

**Hành vi:** Bot tự động chờ, không cần can thiệp.

**Nếu thường xuyên:**
- Giảm số bot trên cùng exchange
- Liên hệ SoDEX xin tăng limit

---

## Checklist Production

Trước khi chạy với số tiền lớn:

- [ ] Test với < $50 ít nhất 1 ngày
- [ ] Xem ≥ 20 trades hoàn chỉnh
- [ ] Win rate > 55%
- [ ] Fee impact < 30%
- [ ] Set `MAX_POSITION_SIZE_USD` hợp lý
- [ ] Set `SESSION_MAX_LOSS_USD`
- [ ] Telegram alerts hoạt động
- [ ] Backup `bot_state.json` hàng ngày
- [ ] Monitor dashboard ít nhất 2 lần/ngày

---

## Kết Luận

DRIFT là hệ thống trading production-grade với:

- **3 chiến lược** cho các điều kiện thị trường khác nhau
- **Adaptive learning** qua self-adjusting weights
- **Execution safety** qua strict state machines
- **Real-time config** qua dashboard
- **Multi-bot management** cho đa dạng hóa

Bắt đầu với Farm Mode, số tiền nhỏ, theo dõi kỹ 1-2 ngày đầu. Sau khi hiểu rõ workflow, scale dần.

Chúc trade thành công! 🚀
