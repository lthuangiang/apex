# Requirements: Multi-Bot Manager

## Introduction

Feature này mở rộng kiến trúc single-bot hiện tại thành multi-bot, cho phép chạy nhiều bot trading song song trên các sàn khác nhau (SoDEX, Dango, Decibel), quản lý tập trung qua một Manager Dashboard mới. Mỗi bot hoạt động hoàn toàn độc lập với state, config, và trade log riêng.

---

## Requirements

### 1. Multi-Bot Registry

**User Story**: Là một trader, tôi muốn chạy nhiều bot cùng lúc trên các sàn khác nhau để tối đa hóa volume farming, vì vậy tôi cần một hệ thống quản lý nhiều bot instances độc lập.

#### Acceptance Criteria

1. GIVEN hệ thống khởi động, WHEN có nhiều `BotConfig` được cung cấp, THEN mỗi config tạo ra một `BotInstance` riêng biệt trong `BotManager` registry.

2. GIVEN một `BotInstance` đang chạy, WHEN bot đó gặp lỗi hoặc bị stop, THEN các bot khác trong registry không bị ảnh hưởng và tiếp tục chạy bình thường.

3. GIVEN `BotManager` registry, WHEN `createBot()` được gọi với một `id` đã tồn tại, THEN hệ thống throw `DuplicateBotError` và bot mới không được thêm vào registry.

4. GIVEN một `BotInstance`, WHEN `start()` được gọi khi bot đã ở trạng thái `RUNNING`, THEN hệ thống trả về `false` và không tạo thêm Watcher loop.

5. GIVEN một `BotInstance`, WHEN `stop()` được gọi, THEN `sessionManager.stopSession()` và `watcher.stop()` được gọi, `state.botStatus` chuyển thành `'STOPPED'`, và open position KHÔNG bị force-close.

6. GIVEN nhiều `BotInstance` đang chạy, WHEN mỗi bot update `BotSharedState` của mình, THEN state của bot A không bao giờ ghi đè hoặc ảnh hưởng state của bot B.

---

### 2. Manager Dashboard — Tổng quan

**User Story**: Là một trader, tôi muốn xem tổng quan tất cả bot đang chạy trên một màn hình duy nhất, vì vậy tôi cần một Manager Dashboard với aggregated stats và danh sách bot cards.

#### Acceptance Criteria

1. GIVEN Manager Dashboard được mở tại `/`, WHEN có ít nhất một bot trong registry, THEN dashboard hiển thị: Total Volume (tổng `sessionVolume` của tất cả bots), Active Bots count (số bot đang `RUNNING`), Total Fees (tổng `sessionFees`), và Total PnL (tổng `sessionPnl`).

2. GIVEN `GET /api/bots/stats`, WHEN được gọi, THEN response chứa `{ totalVolume, activeBotCount, totalFees, totalPnl }` với `totalVolume = Σ bot.state.sessionVolume` và `activeBotCount = count(bots where status === 'RUNNING')`.

3. GIVEN Manager Dashboard, WHEN filter được chọn là `Active`, THEN chỉ hiển thị các bot có `status === 'active'`; tương tự cho `Inactive` và `Completed`.

4. GIVEN filter `All` được chọn, WHEN có N bots trong registry, THEN tất cả N bot cards được hiển thị.

5. GIVEN `GET /api/bots`, WHEN được gọi, THEN response là array `BotStatus[]` với đầy đủ fields: `id`, `name`, `exchange`, `status`, `tags`, `sessionPnl`, `sessionVolume`, `sessionFees`, `efficiencyBps`, `walletAddress`, `uptime`, `hasPosition`, `progress`.

---

### 3. Bot Card

**User Story**: Là một trader, tôi muốn xem thông tin tóm tắt của từng bot trên một card, vì vậy tôi cần bot card hiển thị đầy đủ thông tin và có nút điều khiển.

#### Acceptance Criteria

1. GIVEN một bot card, WHEN bot đang `RUNNING`, THEN card hiển thị: tên bot, exchange, badge `ACTIVE` (màu xanh), ID, tags, volume, fees, PnL, efficiency (bps), wallet address (truncated), progress bar, nút `Stop`, và nút `View details →`.

2. GIVEN một bot card, WHEN bot đang `STOPPED`, THEN card hiển thị badge `INACTIVE` (màu xám) và nút `Start` thay vì `Stop`.

3. GIVEN `efficiencyBps` trên bot card, WHEN `sessionVolume > 0`, THEN `efficiencyBps = (sessionPnl / sessionVolume) * 10000`; WHEN `sessionVolume === 0`, THEN `efficiencyBps = 0`.

4. GIVEN progress bar trên bot card, WHEN `sessionPnl` và `maxLoss` đã biết, THEN `progress = Math.min(100, Math.abs(sessionPnl) / maxLoss * 100)`.

---

### 4. Bot Detail Navigation

**User Story**: Là một trader, tôi muốn xem chi tiết của từng bot, vì vậy tôi cần click "View details" để vào Bot Detail Dashboard với đầy đủ UI hiện tại.

#### Acceptance Criteria

1. GIVEN Manager Dashboard, WHEN user click "View details →" trên một bot card, THEN browser navigate đến `/bots/:id`.

2. GIVEN `GET /bots/:id`, WHEN `id` tồn tại trong registry, THEN server trả về Bot Detail HTML page (tương đương UI dashboard hiện tại, scoped cho bot đó).

3. GIVEN `GET /bots/:id`, WHEN `id` không tồn tại, THEN server trả về 404.

4. GIVEN Bot Detail page, WHEN tất cả API calls được thực hiện (pnl, trades, status, events, position), THEN tất cả data trả về là của bot có `id` tương ứng, không phải data của bot khác.

5. GIVEN Bot Detail page, WHEN user muốn quay lại, THEN có link "← Back to Manager" navigate về `/`.

---

### 5. Per-Bot Start/Stop Control

**User Story**: Là một trader, tôi muốn start và stop từng bot độc lập từ dashboard, vì vậy tôi cần các nút điều khiển trên bot card và API tương ứng.

#### Acceptance Criteria

1. GIVEN `POST /api/bots/:id/start`, WHEN bot đang `STOPPED` hoặc `INACTIVE`, THEN bot được start, `state.botStatus` chuyển thành `'RUNNING'`, response là `{ ok: true }`.

2. GIVEN `POST /api/bots/:id/start`, WHEN bot đã đang `RUNNING`, THEN response là `400 { error: 'Already running' }`.

3. GIVEN `POST /api/bots/:id/stop`, WHEN bot đang `RUNNING`, THEN bot được stop, `state.botStatus` chuyển thành `'STOPPED'`, response là `{ ok: true }`.

4. GIVEN `POST /api/bots/:id/stop`, WHEN bot đã `STOPPED`, THEN response là `400 { error: 'Not running' }`.

5. GIVEN `POST /api/bots/:id/close`, WHEN bot đang `RUNNING` và có open position, THEN `watcher.forceClosePosition()` được gọi, response là `{ ok: true/false }`.

6. GIVEN bất kỳ `/api/bots/:id/*` route nào, WHEN `id` không tồn tại trong registry, THEN response là `404 { error: 'Bot not found' }`.

---

### 6. Create Bot

**User Story**: Là một trader, tôi muốn tạo bot mới từ dashboard mà không cần restart server, vì vậy tôi cần nút "+ Create Bot" và API tương ứng.

#### Acceptance Criteria

1. GIVEN `POST /api/bots` với valid `BotConfig`, WHEN credentials tương ứng có trong `process.env`, THEN bot mới được tạo, thêm vào registry, và response là `BotStatus` của bot mới với `status: 'inactive'`.

2. GIVEN `POST /api/bots` với `BotConfig` thiếu credentials, WHEN credentials không có trong `process.env`, THEN response là `400 { error: 'Missing credentials for exchange ...' }`.

3. GIVEN `POST /api/bots` với `id` đã tồn tại, THEN response là `409 { error: 'Bot ID already exists' }`.

4. GIVEN `DELETE /api/bots/:id`, WHEN bot đang `RUNNING`, THEN response là `400 { error: 'Stop bot before deleting' }`.

5. GIVEN `DELETE /api/bots/:id`, WHEN bot đang `STOPPED`, THEN bot bị xóa khỏi registry, response là `{ ok: true }`.

---

### 7. Per-Bot Data Isolation

**User Story**: Là một trader, tôi muốn trade log và analytics của từng bot được tách biệt, vì vậy mỗi bot cần có TradeLogger và analytics riêng.

#### Acceptance Criteria

1. GIVEN hai bot instances, WHEN mỗi bot được tạo, THEN mỗi bot có `TradeLogger` riêng với `tradeLogPath` khác nhau (e.g., `trades-sodex.json`, `trades-dango.json`).

2. GIVEN `GET /api/bots/:id/trades`, WHEN được gọi, THEN chỉ trả về trades của bot có `id` tương ứng.

3. GIVEN `GET /api/bots/:id/analytics`, WHEN được gọi, THEN analytics được tính từ trades của bot đó, không phải tổng hợp từ tất cả bots.

4. GIVEN `GET /api/bots/:id/config`, WHEN được gọi, THEN trả về config hiệu lực của bot đó (base config + overrides của bot đó).

5. GIVEN `POST /api/bots/:id/config` với valid patch, WHEN được gọi, THEN chỉ config của bot đó bị thay đổi, các bot khác không bị ảnh hưởng.

---

### 8. Authentication & Security

**User Story**: Là một trader, tôi muốn dashboard được bảo vệ bởi passcode, vì vậy tất cả routes kể cả manager routes phải yêu cầu authentication.

#### Acceptance Criteria

1. GIVEN authentication middleware hiện tại, WHEN request đến bất kỳ `/api/bots/*` route nào mà không có valid `dash_token` cookie, THEN response là `401 { error: 'Unauthorized' }`.

2. GIVEN `GET /api/bots/:id/config`, WHEN được gọi bởi authenticated user, THEN response KHÔNG chứa private keys, API secrets, hoặc bất kỳ credentials nào.

3. GIVEN `GET /api/bots`, WHEN được gọi, THEN `walletAddress` trong response là địa chỉ ví (public), không phải private key.

---

## Correctness Properties

Các properties sau được verify bằng fast-check property-based tests:

**P1 — State Isolation**: Với mọi tập hợp N bot instances (N ≥ 2), khi bot i update `state.sessionPnl`, `state.sessionPnl` của tất cả bot j ≠ i không thay đổi.

**P2 — Aggregation Consistency**: Với mọi tập hợp bot instances, `getAggregatedStats().totalVolume = Σ bot.state.sessionVolume` và `getAggregatedStats().activeBotCount ∈ [0, registry.size]`.

**P3 — Filter Completeness**: Với mọi danh sách bots và filter `'all'`, `filterBotCards(bots, 'all').length === bots.length`.

**P4 — Filter Correctness**: Với mọi danh sách bots và filter `f ∈ {'active', 'inactive', 'completed'}`, tất cả phần tử trong kết quả có `status === f`.

**P5 — Stop Idempotency**: Sau khi `stop()` được gọi, `state.botStatus` luôn là `'STOPPED'` bất kể trạng thái trước đó.

**P6 — Efficiency Calculation**: Với mọi bot có `sessionVolume > 0`, `efficiencyBps = (sessionPnl / sessionVolume) * 10000` (trong phạm vi floating point precision).
