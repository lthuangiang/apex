<div align="center">

<p align="center">
  <img src="drift.png" alt="DRIFT logo" width="480"/>
</p>

### Dynamic Risk-Informed Futures Trading

*AI-powered perpetual futures bot với adaptive learning, SoSoValue macro intelligence, multi-exchange execution, và multi-wallet SaaS architecture*

[![TypeScript](https://img.shields.io/badge/TypeScript-007ACC?style=flat&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-339933?style=flat&logo=node.js&logoColor=white)](https://nodejs.org/)
[![Docker](https://img.shields.io/badge/Docker-2496ED?style=flat&logo=docker&logoColor=white)](https://www.docker.com/)
[![Live](https://img.shields.io/badge/🚀_Live_Demo-drift.junxcrypto.xyz-f5a623?style=flat)](https://drift.junxcrypto.xyz/)

</div>

---

> English documentation: [README.md](README.md)

## Hackathon Timeline

| Wave | Build Phase | Evaluation Phase | Focus | Allocation | Status |
|------|-------------|-----------------|-------|------------|--------|
| **Wave 1** — Concept / Early Prototype | 1/5 – 12/5/2026 | 13/5 – 22/5/2026 | Định hướng ý tưởng, xác định người dùng mục tiêu, use case, kế hoạch API, thiết kế workflow, prototype ban đầu | 3,000 USDC | ✅ **Hoàn thành** |
| **Wave 2** — Build Phase I | 23/5 – 3/6/2026 | 4/6 – 13/6/2026 | Phát triển tính năng cốt lõi, tích hợp SoSoValue API, Hibachi exchange adapter, multi-wallet SaaS, interactive prototype | 3,000 USDC | ✅ **Hoàn thành** |
| **Wave 3** — Build Phase II | 14/6 – 8/7/2026 | 9/7 – 22/7/2026 | Agent Layer tự động, 8 signal SoSoValue, Kelly sizing, RiskGate, Performance Analytics dashboard, stress testing | 4,000 USDC | ✅ **Hoàn thành** |

---

## 🧠 Wave 3 — Agent Layer + SoSoValue Intelligence Core

Wave 2 feedback: "SoSoValue integration is shallow — mostly Fear & Greed overlay." **Wave 3 trực tiếp giải quyết vấn đề này** bằng cách biến SoSoValue từ "overlay" thành "bộ não ra quyết định".

### So sánh Wave 2 vs Wave 3

| Khía cạnh | Wave 2 ❌ | Wave 3 ✅ |
|-----------|----------|----------|
| **Signals** | 3 (F&G, ETF, Macro) | **8** (+ OI, Funding, Stablecoin, SSI Index, Sector Rotation) |
| **Chọn chiến lược** | Thủ công (user chọn Farm/Trade) | **Tự động** (Agent Layer chọn mỗi 30s dựa trên regime) |
| **Market Regimes** | Không có | **8 regimes** phân loại với confidence score |
| **Position Sizing** | Multiplier tùy ý (0.85x–1.2x) | **Kelly criterion** (conviction × performance × regime) |
| **Risk Control** | Không có | **RiskGate** (max loss halt, exposure cap, cooldown) |
| **Orchestration** | Không có | **Agent Layer** — bộ não tự động điều phối tất cả bot |
| **Vai trò SoSoValue** | Overlay multiplier | **Core decision engine** 🧠 |

### Agent Layer — Bộ não điều phối tự động

Agent Layer **không phải là bot mới** — nó là **tầng quyết định chiến lược** ngồi trên tất cả bot hiện có. Nó không đặt lệnh trực tiếp lên exchange, mà ra lệnh cho các bot phải làm gì.

```
┌─────────────────────────────────────────────────────────────────────┐
│                     AGENT LAYER (bộ não)                            │
│                                                                     │
│  Intelligence Engine → StrategySelector → CapitalAllocator → RiskGate
│  (8 tín hiệu)         (FARM/TRADE/HOLD)   (Kelly sizing)    (halt/allow)
└──────────────────────────────────┬──────────────────────────────────┘
                                   │ AgentDecision
                                   ▼
┌─────────────────────────────────────────────────────────────────────┐
│                     BOT MANAGER (bàn tay)                           │
│                                                                     │
│  Farm Bot (SoDEX)    Trade Bot (SoDEX)    Hedge Bot (Hibachi)      │
│  → đặt lệnh          → đặt lệnh           → đặt cặp lệnh         │
└─────────────────────────────────────────────────────────────────────┘
```

**Mỗi 30 giây, Agent chạy 1 chu kỳ:**

| Bước | Hành động | Kết quả |
|------|-----------|---------|
| 1. Observe | Fetch 8 signal SoSoValue | Market context snapshot |
| 2. Classify | Phân loại regime | 1 trong 8 regimes + confidence |
| 3. Select | Chọn chiến lược | FARM / TRADE / BOTH / HOLD |
| 4. Allocate | Tính size (Kelly) | BTC position size |
| 5. Gate | Kiểm tra rủi ro | ALLOW hoặc BLOCK |
| 6. Emit | Ra lệnh cho bot | Bot chuyển mode + size |

**Ví dụ thực tế:**

| Tình huống | Regime | Agent quyết định | Lý do |
|------------|--------|-------------------|--------|
| Thị trường sideway | `choppy_neutral` | **FARM** short | Không có edge → farm volume an toàn |
| ETF inflows mạnh + funding dương | `bull_momentum` | **TRADE** long | Edge hướng rõ → trích xuất alpha |
| Funding > 1.5% + greed cực đoan | `overheated` | **HOLD** | Rủi ro đảo chiều → bảo toàn vốn |
| 3 lệnh thua liên tiếp | Any | **COOLDOWN 10 phút** | RiskGate → tránh tilt |
| Session PnL dưới -$5 | Any | **HALTED** | Max loss → không mở vị thế mới |

### 8 Tín hiệu SoSoValue

| # | Signal | Nguồn | Cho biết gì |
|---|--------|-------|-------------|
| 1 | Fear & Greed Index | `/analyses/fgi` | Tâm lý thị trường (0-100) |
| 2 | BTC ETF Net Flows | `/etfs/summary-history` | Dòng tiền tổ chức ($M) |
| 3 | Futures Open Interest | `/analyses/futures_open_interest` | Đòn bẩy tích lũy ($B) |
| 4 | Funding Rate | `/analyses/funding_rate` | Xu hướng retail (%) |
| 5 | Stablecoin Inflows | `/analyses/stablecoins_mcap` | Vốn mới vào/ra ($B) |
| 6 | Macro Events | `/macro/events` | Lịch rủi ro FOMC/CPI/NFP |
| 7 | SSI Index | `/analyses/ssi_index` | Sức khỏe tổng thể sector (0-100) |
| 8 | Sector Rotation | Multi-sector charts | Sector nào dẫn/lag (risk-on/off) |

**Công thức Conviction Scoring:**
```
conviction = sentiment×0.20 + institutional×0.25 + retail×0.15 + macro×0.12 + technical×0.10 + sectorMomentum×0.18
```

### Dashboard — Judges có thể thấy

1. **Trang chính (`/dashboard`)** — Agent Brain panel hiển thị:
   - Regime hiện tại + confidence + strategy
   - 8 signal pills với giá trị real-time (cập nhật mỗi 5s)
   - Risk Gate status (OPEN / HALTED / COOLDOWN)
   - Lịch sử 10 decisions gần nhất
   - Nút Start / Pause / Stop

2. **Trang Performance (`/performance`)** — Analytics dashboard:
   - KPI cards (Total Trades, Win Rate, PnL, Sharpe Ratio)
   - Equity curve chart
   - So sánh alpha WITH vs WITHOUT SoSoValue
   - Win rate theo regime (bar chart)
   - Farm vs Trade performance breakdown
   - Monthly returns table

### Test Scripts

```bash
# Demo Agent Layer (dry-run, không cần exchange credentials)
npx tsx src/scripts/test-agent-layer.ts

# Stress test (flash crash, funding spike, consecutive losses)
npx tsx src/scripts/stress-test-agent.ts
```

---

## Tổng quan

DRIFT là multi-bot trading system cho perpetual futures, hỗ trợ **4 sàn giao dịch**: **SoDEX**, **Dango**, **Decibel**, và **Hibachi**. Hệ thống chạy nhiều bot song song với 3 chiến lược: **Farm Mode** (tối đa volume), **Trade Mode** (tối đa win rate), và **Hedge Bot** (correlation divergence).

**Tính năng chính:**
- **Agent Layer** — bộ não tự động điều phối tất cả bot dựa trên 8 tín hiệu SoSoValue (Wave 3)
- **8 Signal Intelligence Engine** — Fear&Greed, ETF flows, OI, Funding, Stablecoin, Macro, SSI, Sector
- **Kelly-optimized sizing** — position size dựa trên conviction score, không phải arbitrary multiplier
- **RiskGate** — portfolio-level risk: max loss halt, exposure cap, consecutive loss cooldown
- **Multi-wallet SaaS** — tenant isolation theo wallet, encrypted credential storage (AES-256-GCM)
- **Daily budget reset** — tự động reset max loss và volume target lúc 0h UTC mỗi ngày
- **Performance Analytics** — Sharpe, Sortino, drawdown, equity curve, SoSoValue alpha comparison
- **Backtesting Engine** — replay lịch sử với simulated fills, speed control, abort/progress

---

## Dashboard

<p align="center">
  <img src="dashboard.png" alt="DRIFT Dashboard" width="800"/>
</p>

## Kiến trúc hệ thống

<p align="center">
  <img src="design.png" alt="DRIFT Architecture" width="800"/>
</p>

---

## Ba chiến lược

### 1. Farm Mode — Tối đa hóa Volume

Thiết kế cho các DEX có volume incentive (SoPoints, rebate). Mục tiêu là **luôn luôn trade**, không bao giờ bỏ qua cơ hội.

**Signal pipeline (farm mode)**:
```
Signal từ AISignalEngine
  │
  ▼
[1] SoSoValue macro filter    — sentiment multiplier áp vào confidence
  │
  ▼
[2] RegimeConfidenceThreshold — SIDEWAY ≥ 0.45, TREND ≥ 0.35
  │
  ▼
[3] TradePressureGate         — skip nếu pressure=0 AND confidence < 0.55
  │
  ▼
[4] FallbackQualityGate       — skip nếu fallback=true AND confidence < 0.25
  │
  ▼
[5] FeeAwareEntryFilter       — skip nếu expectedEdge ≤ minRequiredMove × 1.5
  │
  ▼
[6] LLMMomentumAdjuster       — điều chỉnh effectiveConfidence (±10–20%)
  │
  ▼
[7] MinHoldTimeEnforcer       — tính dynamicMinHold từ ATR và fee
  │
  ▼
PositionSizer (+ macroSentimentMultiplier) → placeEntryOrder
```

**Direction resolution** (không bao giờ skip):
- `pricePosition > 0.65` → SHORT (giá gần đỉnh range)
- `pricePosition < 0.35` → LONG (giá gần đáy range)
- Mid-range → dùng adjustedMomentumScore
- Fallback → alternate với lệnh trước (long ↔ short)

**Exit conditions** (theo thứ tự ưu tiên):
1. SL: `FARM_SL_PERCENT = 5%`
2. Dynamic TP (MM enabled): `max(spreadBps/10000 × price × 1.5, feeFloor)`, capped $2.0
3. Farm TP: `FARM_TP_USD = $0.5`
4. Early profit: hold ≥ 60s AND pnl ≥ fee × 1.2 (suppressed trong TREND regime)
5. Time exit: sau `dynamicMinHold` (120–480s), chờ thêm 30s nếu profitable

**Cooldown**: fixed 30s (`FARM_COOLDOWN_SECS`)

---

### 2. Trade Mode — Tối đa hóa Win Rate

Chỉ vào khi có edge rõ ràng. Không có time exit — để trade chạy đến TP hoặc SL.

**Signal pipeline (trade mode)**:
```
Signal từ AISignalEngine
  │
  ▼
[1] SoSoValue macro filter — Extreme Greed (>75): tăng ngưỡng confidence
  │
  ▼
[2] Regime check       — HIGH_VOLATILITY → skip nếu REGIME_HIGH_VOL_SKIP_ENTRY=true
  │
  ▼
[3] ChopDetector       — chopScore ≥ 0.55 → skip
  │
  ▼
[4] FakeBreakoutFilter — OB imbalance contradicts direction → skip
  │
  ▼
[5] Confidence gate    — confidence < MIN_CONFIDENCE (0.65) → skip
  │
  ▼
[6] 2-tick confirmation — phải confirm trong 60s window
  │
  ▼
PositionSizer → placeEntryOrder
```

**Exit**: SL 5% hoặc TP 5%. **Không có time exit**.

**Cooldown**: random `[COOLDOWN_MIN_MINS, COOLDOWN_MAX_MINS]` (mặc định 2–5 phút)

---

### 3. Hedge Bot — Correlation Divergence

Giao dịch **đồng thời 2 tài sản tương quan** (BTC + ETH) theo hướng ngược nhau. Một leg long, một leg short với cùng USD notional. Lợi nhuận đến từ sự phân kỳ tạm thời.

**State machine**:
```
IDLE → OPENING → WAITING_FILL → IN_PAIR → CLOSING → COOLDOWN
```

**Entry trigger**: Volume spike đồng thời trên cả 2 symbol + AI signal phân kỳ.

**Fill management** (one-action-per-tick):
- Case 1: 1 filled + 1 rejected → re-place lệnh bị reject ngay tick tiếp theo
- Case 2: 1 filled + 1 pending → chờ fill; timeout 30s → cancel pending → OPENING
- Case 3: 2 pending → chờ fill; timeout 30s → cancel cả 2 → OPENING

**Exit conditions**: profit target, max loss, mean reversion, hoặc holding period hết hạn.

---

## Tích hợp SoSoValue (Wave 3 — 8 Signals)

DRIFT tích hợp **8 tín hiệu SoSoValue** để tạo thành lớp intelligence cốt lõi — không chỉ là overlay mà là **bộ não ra quyết định**.

### Cách hoạt động (Wave 3)

```
Mỗi 30 giây, Agent Layer chạy chu kỳ:
  │
  ▼
Fetch song song 8 tín hiệu:
  ├── Fear & Greed Index (tâm lý thị trường)
  ├── BTC ETF Net Flows (dòng tiền tổ chức)
  ├── Futures Open Interest (leverage build-up)
  ├── Funding Rate (xu hướng retail)
  ├── Stablecoin Inflows (vốn mới vào/ra)
  ├── Macro Events (lịch FOMC/CPI/NFP)
  ├── SSI Index (sức khỏe sector)
  └── Sector Rotation (risk-on/risk-off)
  │
  ▼
Conviction Scoring (0-100):
  sentiment×0.20 + institutional×0.25 + retail×0.15
  + macro×0.12 + technical×0.10 + sector×0.18
  │
  ▼
Phân loại 1 trong 8 Regimes → Chọn chiến lược → Kelly sizing → RiskGate
  │
  ▼
AgentDecision → Bot chuyển mode (Farm/Trade/Standby) + size
```

---

## Multi-Wallet SaaS Architecture (Wave 2)

DRIFT hỗ trợ **tenant isolation** theo wallet — mỗi địa chỉ ví có bot instances, credentials, và config riêng biệt lưu trong `./data/<wallet>/`.

### Tenant Lifecycle

```
Người dùng kết nối ví (WalletConnect / AppKit)
  │
  ▼
Dashboard xác thực địa chỉ ví
  │
  ▼
TenantRegistry.getOrCreate(walletAddress)
  ├── Tenant mới: tạo thư mục ./data/<wallet>/
  │     ├── TenantConfigStore  — bot configs theo ví
  │     ├── CredentialStore    — credentials mã hóa
  │     └── TenantContext      — bot instances đang chạy
  │
  └── Tenant đã có: khôi phục từ disk
        ├── Load bot configs
        ├── Giải mã credentials
        └── Khởi động lại bots có autoStart=true
  │
  ▼
Khi shutdown: TenantRegistry.shutdownAll()
  → Dừng tất cả tenant bots + lưu state
```

### Cấu trúc dữ liệu

```
./data/
└── <wallet_address>/
    ├── bot-configs.json      # Bot configs theo ví
    ├── credentials.enc       # Exchange API keys đã mã hóa
    └── bot_state_*.json      # Runtime state của từng bot
```

---

## Daily Budget Reset

Mỗi bot có thể bật tính năng **tự động reset budget hàng ngày** và **auto-start** lại sau khi reset. Có **hai điều kiện dừng** — cái nào đến trước thì dừng:

1. **Max Loss**: session PnL ≤ `-dailyMaxLossUsd`
2. **Volume Target**: session volume ≥ `dailyTargetVolumeUsd` (nếu > 0)

### Cách hoạt động

```
Watcher._tick() mỗi ~5s:
  │
  ├── Section 2: updatePnL(sessionCurrentPnl)
  │     → nếu sessionPnl ≤ -maxLossUsd → IOC close + dừng bot (MAX LOSS)
  │
  └── Section 2.5: updateVolume(sessionVolume)
        → nếu sessionVolume ≥ targetVolumeUsd VÀ targetVolumeUsd > 0
          → IOC close + dừng bot (VOLUME TARGET)

Cả hai check chỉ fire 1 lần/session (_maxLossTriggered / _volumeTargetTriggered flags).

Mỗi phút: DailyResetScheduler kiểm tra giờ UTC hiện tại
  │
  ▼
Đến giờ reset (mặc định 0h UTC = 7h sáng Vietnam)?
  │
  ├── Không → tiếp tục chờ
  │
  └── Có → thực hiện reset:
        1. Stop bot (nếu đang chạy)
        2. Reset cả hai flags: resetMaxLoss() + resetVolumeTarget()
        3. Áp dụng lại: setMaxLoss(dailyMaxLossUsd) + setTargetVolume(dailyTargetVolumeUsd)
        4. Auto-start bot với budget mới
        5. Gửi Telegram notification
```

### Cấu hình trong `bot-configs.json`

```json
{
  "id": "sodex-bot",
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
| `dailyResetHourUTC` | Giờ reset (UTC 0–23) | `0` (= 7h VN) |

### Telegram notifications

- Max loss hit: `⚠️ Max Loss Reached | Limit: $5 | Actual: -$5.12 | Bot stopped — will reset at next daily cycle`
- Volume target hit: `🎯 Volume Target Reached | Target: $5,000 | Actual: $5,023 | PnL: +2.40 | Bot stopped — will reset at next daily cycle`
- Daily reset: `🔄 Daily Budget Reset — Bot sodex-bot | Budget: $5 max loss | Volume target: $5,000 | 0:00 UTC (7:00 Vietnam) | Bot auto-restarted`

---

## Kiến trúc tổng quan

```
bot.ts (Multi-Bot Manager)
  ├── BotManager                    # Quản lý nhiều bot song song
  │     ├── BotInstance (Farm/Trade)
  │     │     ├── DailyResetScheduler   # Reset budget (max loss + volume target) + auto-start hàng ngày
  │     │     └── Watcher           # 5-state: IDLE→PENDING→IN_POSITION→EXITING→COOLDOWN
  │     │           ├── AISignalEngine      # EMA9/21, RSI, momentum, OB + regime + SoSoValue
  │     │           ├── FarmSignalFilters   # 4-gate pipeline + LLM adjuster + MinHold
  │     │           ├── PositionSizer       # Dynamic sizing (confidence × performance × sentiment)
  │     │           ├── MarketMaker         # Ping-pong + inventory + dynamic TP
  │     │           ├── ExecutionEdge       # Dynamic offset + spread guard + fill rate
  │     │           ├── ChopDetector        # Trade mode only
  │     │           ├── FakeBreakoutFilter  # Trade mode only
  │     │           └── Executor            # Post-Only maker orders
  │     │
  │     └── HedgeBot                # Correlation hedging bot
  │           ├── VolumeMonitor     # Dual-symbol volume spike detection
  │           ├── AISignalEngine ×2 # Một engine per symbol
  │           └── State Machine     # IDLE→OPENING→WAITING_FILL→IN_PAIR→CLOSING→COOLDOWN
  │
  ├── TenantRegistry                # Multi-wallet SaaS tenant isolation
  │     ├── TenantContext           # Bot instances đang chạy theo ví
  │     ├── TenantConfigStore       # Bot configs theo ví
  │     └── CredentialStore         # Credentials mã hóa
  │
  ├── SoSoValueClient               # Fear & Greed Index API
  ├── SoSoValueStrategy             # Sentiment → confidence/size multipliers
  ├── LLMReasoningAgent             # LLM-based momentum adjustment
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
  └── SessionManager                # Max loss, volume target, session state
```

---

## Quy trình vận hành

```
1. Cài đặt
   ├── Copy .env.example → .env, điền credentials
   ├── Cấu hình bot-configs.json (exchange, symbol, mode, budget)
   └── npm install

2. Khởi động
   ├── npm start (dev) hoặc npm run start:prod (production)
   ├── Bot load .env → khôi phục state → đọc bot-configs.json
   ├── Multi-bot mode: BotManager tạo tất cả bots đã cấu hình
   └── TenantRegistry khôi phục tenant wallets từ ./data/

3. Vận hành
   ├── Dashboard: http://localhost:3000
   │     ├── Manager view: tất cả bots, PnL tổng hợp, start/stop
   │     ├── Bot detail: session PnL, volume, real-time console (SSE)
   │     ├── Analytics tab: win rate, signal quality, fee impact
   │     └── Bot Settings: 70+ config params, daily budget reset
   │
   ├── Telegram: /start_bot, /stop_bot, /status, /check, /set_mode, /set_max_loss
   │
   └── Mỗi tick bot (~5s):
         ├── Fetch SoSoValue Fear & Greed Index
         ├── Chạy signal pipeline (AISignalEngine + filters)
         ├── Kiểm tra PnL vs max loss / volume vs target
         ├── Thực thi state machine (IDLE→PENDING→IN_POSITION→EXITING→COOLDOWN)
         └── Log trade + cập nhật analytics

4. Daily Reset (nếu bật)
   ├── 0h UTC: DailyResetScheduler kích hoạt
   ├── Stop bot → reset flags → áp lại budget → auto-start
   └── Gửi Telegram notification

5. Shutdown
   ├── Nhận SIGINT/SIGTERM
   ├── Tất cả bots dừng gracefully
   ├── TenantRegistry.shutdownAll() — lưu state tất cả tenants
   └── State lưu xuống disk
```

---

## Farm/Trade Bot — State Machine Chi Tiết

```
                    ┌─────────────────────────────────────────────────────┐
                    │                    IDLE                             │
                    │  1. Dust check (ignore position < MIN_POS_USD)      │
                    │  2. Hour blocking (FARM_BLOCKED_HOURS)              │
                    │  3. Cancel stale orders → RETURN                    │
                    │  4. _retryEntry? → re-place → PENDING               │
                    │  5. Signal pipeline → PositionSizer → placeOrder    │
                    └──────────────────────┬──────────────────────────────┘
                                           │ order placed
                                           ▼
                    ┌─────────────────────────────────────────────────────┐
                    │                   PENDING                           │
                    │  • position detected → IN_POSITION                  │
                    │  • timeout → cancel (tick N) → check (tick N+1)     │
                    │  • confirmed cancel → save _retryEntry → IDLE       │
                    └──────────────────────┬──────────────────────────────┘
                                           │ fill confirmed
                                           ▼
                    ┌─────────────────────────────────────────────────────┐
                    │                 IN_POSITION                         │
                    │  Exit triggers (priority order):                    │
                    │  1. SL 5%                                           │
                    │  2. Dynamic TP (MM spread-based)                    │
                    │  3. Farm TP $0.5                                    │
                    │  4. Early profit (≥60s + fee×1.2)                  │
                    │  5. Time exit (dynamicMinHold + 30s grace)          │
                    └──────────────────────┬──────────────────────────────┘
                                           │ exit trigger fired
                                           ▼
                    ┌─────────────────────────────────────────────────────┐
                    │                   EXITING                           │
                    │  Case A: no pendingExit                             │
                    │    → cancel open orders → re-verify position        │
                    │    → dust check → skip if < MIN_POS_USD             │
                    │    → placeExitOrder → pendingExit                   │
                    │  Case B: pendingExit exists                         │
                    │    → position gone → _onExitFilled → COOLDOWN       │
                    │    → timeout 15s → cancel → retry Case A            │
                    └──────────────────────┬──────────────────────────────┘
                                           │ exit filled
                                           ▼
                    ┌─────────────────────────────────────────────────────┐
                    │                  COOLDOWN                           │
                    │  Farm: fixed 30s                                    │
                    │  Trade: random [COOLDOWN_MIN, COOLDOWN_MAX] mins    │
                    └──────────────────────┬──────────────────────────────┘
                                           │ cooldown expired
                                           └──────────────────► IDLE
```

**Strict tick isolation**: mỗi tick chỉ thực hiện đúng **một** action (place OR cancel OR wait) rồi return. Per-tick mutex (`_tickLock`) ngăn tick mới chạy khi tick cũ chưa xong.

---

## AI Signal Engine

Fetch song song 4 nguồn dữ liệu:
- Orderbook depth (20 levels) — từ exchange adapter
- Recent trades (100 trades) — từ exchange adapter
- OHLCV klines (30 nến, 5m interval) — từ exchange adapter (SoDEX, Hibachi) hoặc Binance fallback
- Built-in sentiment indicator — điểm tổng hợp từ trade pressure, orderbook imbalance, và volume activity

**Momentum score** với adaptive weights (tự điều chỉnh mỗi 10 trades):

| Nguồn | Logic | Default weight |
|---|---|---|
| EMA9 vs EMA21 | EMA9 > EMA21 → bullish (0.65), ngược lại (0.35) | ~40% |
| RSI(14) | < 35 oversold (0.75), > 65 overbought (0.25), linear giữa | ~25% |
| 3-candle momentum | `(currentPrice - closes[-4]) / closes[-4] × 50 + 0.5` | ~20% |
| Orderbook imbalance | `(bidVol/askVol - 1) × 0.5 + 0.5` | ~15% |

**Built-in sentiment indicator:**
- Trade pressure (40%): `buyVol / (buyVol + sellVol)`
- Orderbook imbalance (40%): `bidVol / askVol`
- Volume activity (20%): phát hiện volume spike

**SoSoValue overlay**: confidence × sentimentMultiplier (0.85× đến 1.2×) áp sau tất cả indicators.

**Cache**: 60s TTL. Invalidate sau khi place entry order.

**Fallback**: nếu exchange klines không có → Binance futures klines; nếu tất cả lỗi → SignalEngine cơ bản (OB + trades only)

---

## Exchange Integration

| Sàn | Signing | Đặc điểm |
|---|---|---|
| SoDEX | EIP-712 typed data | Post-Only, 0.012% maker fee, SoPoints |
| Decibel | Ed25519 (Aptos) | Gas Station, per-order cancel |
| Dango | Secp256k1 + GraphQL | USD notional sizing |
| **Hibachi** | ECDSA (trustless) / HMAC-SHA256 (managed) | Hai account mode, contract-based sizing |

**Hibachi account modes:**
- `trustless` — cần `HIBACHI_PRIVATE_KEY` (0x-prefixed 32-byte hex); ký lệnh client-side
- `exchange_managed` — cần `HIBACHI_SECRET_KEY`; HMAC-SHA256 request signing

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
# Exchange selector (single-bot mode)
EXCHANGE=sodex
SYMBOL=BTC-PERP

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

# Hibachi
HIBACHI_API_KEY=...
HIBACHI_ACCOUNT_ID=...
HIBACHI_ACCOUNT_TYPE=trustless
HIBACHI_PRIVATE_KEY=0x...

# SoSoValue
SOSOVALUE_API_KEY=...

# Telegram
TELEGRAM_BOT_TOKEN=...
TELEGRAM_CHAT_ID=...

# LLM
LLM_PROVIDER=openai
OPENAI_API_KEY=sk-...

# Logging & Dashboard
TRADE_LOG_BACKEND=json
TRADE_LOG_PATH=/app/data/trades.json
DASHBOARD_PORT=3000
```

---

## Dashboard

Truy cập `http://localhost:3000`

- **Manager view**: tất cả bots, PnL tổng hợp, start/stop từng bot
- **Bot detail**: session PnL, volume, real-time console (SSE), trade history
- **Hedge bot**: hiển thị 2 legs đang mở (symbol, side, entry price, unrealized PnL, combined PnL)
- **Analytics tab**: win rate, signal quality, fee impact, regime performance, filter skip stats, effective confidence stats, dynamic min hold stats
- **Bot Settings**: chỉnh 70+ config params runtime không cần restart; section **📅 Daily Budget Reset** (chỉ hiển thị trên bot detail page) cho phép cấu hình Enable toggle, Max Loss/day, Target Volume/day, Reset Hour UTC — save ngay không cần reload trang
- **Wallet login**: WalletConnect / AppKit — mỗi ví có tenant storage riêng biệt

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

## Cấu trúc thư mục

```
src/
├── bot.ts                    # Bootstrap, multi-bot manager, graceful shutdown
├── config.ts                 # 70+ tham số mặc định
├── adapters/
│   ├── ExchangeAdapter.ts    # Interface chung
│   ├── sodex_adapter.ts      # SoDEX (EIP-712 signing)
│   ├── decibel_adapter.ts    # Decibel (Aptos Ed25519)
│   ├── dango_adapter.ts      # Dango (Secp256k1 + GraphQL)
│   └── hibachi_adapter.ts    # Hibachi (ECDSA / HMAC-SHA256)
├── bot/
│   ├── BotManager.ts         # Quản lý nhiều bot
│   ├── BotInstance.ts        # Farm/Trade bot wrapper
│   ├── DailyResetScheduler.ts # Daily budget reset + auto-start
│   ├── HedgeBot.ts           # Correlation hedging bot (6-state machine)
│   ├── VolumeMonitor.ts      # Dual-symbol volume spike detection
│   ├── TenantRegistry.ts     # Multi-wallet SaaS tenant management
│   ├── TenantContext.ts      # Bot instances đang chạy theo ví
│   ├── TenantConfigStore.ts  # Bot configs theo ví
│   ├── CredentialStore.ts    # Credentials mã hóa
│   └── hedgeBotHelpers.ts    # assignDirections, evaluateExitConditions
├── modules/
│   ├── Watcher.ts            # 5-state machine chính
│   ├── FarmSignalFilters.ts  # 4-gate pipeline + LLM adjuster + MinHold
│   ├── Executor.ts           # Đặt/hủy lệnh (Post-Only + IOC)
│   ├── ExecutionEdge.ts      # Dynamic offset + spread guard
│   ├── FillTracker.ts        # Fill rate ring buffer (20 orders)
│   ├── PositionSizer.ts      # Dynamic sizing + macro sentiment multiplier
│   ├── MarketMaker.ts        # Ping-pong + inventory + dynamic TP
│   ├── RiskManager.ts        # TP/SL check
│   └── SessionManager.ts     # Max loss, volume target, session state
├── ai/
│   ├── AISignalEngine.ts     # Signal engine chính (EMA/RSI/momentum/OB + SoSoValue)
│   ├── SoSoValueClient.ts    # Fear & Greed Index API client
│   ├── SoSoValueStrategy.ts  # Sentiment → confidence/size multipliers
│   ├── SoSoValueAnalytics.ts # Sentiment analytics và reporting
│   ├── LLMReasoningAgent.ts  # LLM-based momentum adjustment
│   ├── RegimeDetector.ts     # ATR + BB + volume → SIDEWAY/TREND/HIGH_VOL
│   ├── ChopDetector.ts       # Flip rate + momentum neutrality + BB compression
│   ├── FakeBreakoutFilter.ts # Volume + OB imbalance contradiction check
│   ├── AnalyticsEngine.ts    # 30+ dimensions per trade
│   ├── TradeLogger.ts        # JSON hoặc SQLite
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

> **Cảnh báo**: Phần mềm này chỉ dành cho mục đích nghiên cứu và giáo dục. Trading cryptocurrency có rủi ro cao. Không commit file `.env` lên git.

---

<div align="center">

**Made with ❤️ for the DeFi community**

*DRIFT — Where intelligent execution meets adaptive learning*

</div>

