# Requirements: Multi-Bot Manager

## Introduction

Feature này mở rộng kiến trúc single-bot hiện tại thành multi-bot, cho phép chạy nhiều bot trading song song trên các sàn khác nhau (SoDEX, Dango, Decibel), quản lý tập trung qua một Manager Dashboard mới. Thiết kế tập trung vào **tối thiểu hóa thay đổi** và **tái sử dụng tối đa** code hiện có.

**Nguyên tắc:**
- Giữ nguyên `src/bot.ts` entry point
- Thêm `BotManager` class đơn giản - chỉ là registry
- `BotInstance` là wrapper nhẹ quanh Watcher + SessionManager
- Mỗi bot có state riêng, TradeLogger riêng
- Dashboard mở rộng thêm routes `/api/bots/*`

---

## Requirements

### 1. Multi-Bot Registry

**User Story**: Là một trader, tôi muốn chạy nhiều bot cùng lúc trên các sàn khác nhau để tối đa hóa volume farming.

#### Acceptance Criteria

1. GIVEN `bot-configs.json` với nhiều bot configs, WHEN hệ thống khởi động, THEN mỗi config tạo ra một `BotInstance` riêng biệt trong `BotManager` registry.

2. GIVEN một `BotInstance` đang chạy, WHEN bot đó gặp lỗi hoặc bị stop, THEN các bot khác trong registry không bị ảnh hưởng và tiếp tục chạy bình thường.

3. GIVEN `BotManager` registry, WHEN `createBot()` được gọi với một `id` đã tồn tại, THEN hệ thống throw error và bot mới không được thêm vào registry.

4. GIVEN một `BotInstance`, WHEN `start()` được gọi khi bot đã ở trạng thái `RUNNING`, THEN hệ thống trả về `false` và không tạo thêm Watcher loop.

5. GIVEN một `BotInstance`, WHEN `stop()` được gọi, THEN `sessionManager.stopSession()` và `watcher.stop()` được gọi, `state.botStatus` chuyển thành `'STOPPED'`.

6. GIVEN nhiều `BotInstance` đang chạy, WHEN mỗi bot update `BotSharedState` của mình, THEN state của bot A không bao giờ ghi đè hoặc ảnh hưởng state của bot B.

---

### 2. Manager Dashboard — Tổng quan

**User Story**: Là một trader, tôi muốn xem tổng quan tất cả bot đang chạy trên một màn hình duy nhất.

#### Acceptance Criteria

1. GIVEN Manager Dashboard được mở tại `/`, WHEN có ít nhất một bot trong registry, THEN dashboard hiển thị: Total Volume, Active Bots count, Total Fees, và Total PnL.

2. GIVEN `GET /api/bots/stats`, WHEN được gọi, THEN response chứa `{ totalVolume, activeBotCount, totalFees, totalPnl }`.

3. GIVEN Manager Dashboard, WHEN filter được chọn là `Active`, THEN chỉ hiển thị các bot có `status === 'active'`; tương tự cho `Inactive`.

4. GIVEN filter `All` được chọn, WHEN có N bots trong registry, THEN tất cả N bot cards được hiển thị.

5. GIVEN `GET /api/bots`, WHEN được gọi, THEN response là array `BotStatus[]` với đầy đủ fields: `id`, `name`, `exchange`, `status`, `tags`, `sessionPnl`, `sessionVolume`, `sessionFees`, `efficiencyBps`, `walletAddress`, `uptime`, `hasPosition`, `progress`.

---

### 3. Bot Card

**User Story**: Là một trader, tôi muốn xem thông tin tóm tắt của từng bot trên một card.

#### Acceptance Criteria

1. GIVEN một bot card, WHEN bot đang `RUNNING`, THEN card hiển thị: tên bot, exchange, badge `ACTIVE` (màu xanh), ID, tags, volume, fees, PnL, efficiency (bps), wallet address (truncated), progress bar, nút `Stop`, và nút `View details →`.

2. GIVEN một bot card, WHEN bot đang `STOPPED`, THEN card hiển thị badge `INACTIVE` (màu xám) và nút `Start` thay vì `Stop`.

3. GIVEN `efficiencyBps` trên bot card, WHEN `sessionVolume > 0`, THEN `efficiencyBps = (sessionPnl / sessionVolume) * 10000`; WHEN `sessionVolume === 0`, THEN `efficiencyBps = 0`.

4. GIVEN progress bar trên bot card, WHEN `sessionPnl` và `maxLoss` đã biết, THEN `progress = Math.min(100, Math.abs(sessionPnl) / maxLoss * 100)`.

---

### 4. Bot Detail Navigation

**User Story**: Là một trader, tôi muốn xem chi tiết của từng bot.

#### Acceptance Criteria

1. GIVEN Manager Dashboard, WHEN user click "View details →" trên một bot card, THEN browser navigate đến `/bots/:id`.

2. GIVEN `GET /bots/:id`, WHEN `id` tồn tại trong registry, THEN server trả về Bot Detail HTML page (giống UI dashboard hiện tại, scoped cho bot đó).

3. GIVEN `GET /bots/:id`, WHEN `id` không tồn tại, THEN server trả về 404.

4. GIVEN Bot Detail page, WHEN tất cả API calls được thực hiện, THEN tất cả data trả về là của bot có `id` tương ứng.

5. GIVEN Bot Detail page, WHEN user muốn quay lại, THEN có link "← Back to Manager" navigate về `/`.

---

### 5. Per-Bot Start/Stop Control

**User Story**: Là một trader, tôi muốn start và stop từng bot độc lập từ dashboard.

#### Acceptance Criteria

1. GIVEN `POST /api/bots/:id/start`, WHEN bot đang `STOPPED`, THEN bot được start, `state.botStatus` chuyển thành `'RUNNING'`, response là `{ ok: true }`.

2. GIVEN `POST /api/bots/:id/start`, WHEN bot đã đang `RUNNING`, THEN response là `400 { error: 'Already running' }`.

3. GIVEN `POST /api/bots/:id/stop`, WHEN bot đang `RUNNING`, THEN bot được stop, `state.botStatus` chuyển thành `'STOPPED'`, response là `{ ok: true }`.

4. GIVEN `POST /api/bots/:id/stop`, WHEN bot đã `STOPPED`, THEN response là `400 { error: 'Not running' }`.

5. GIVEN `POST /api/bots/:id/close`, WHEN bot đang `RUNNING` và có open position, THEN `watcher.forceClosePosition()` được gọi, response là `{ ok: true/false }`.

6. GIVEN bất kỳ `/api/bots/:id/*` route nào, WHEN `id` không tồn tại trong registry, THEN response là `404 { error: 'Bot not found' }`.

---

### 6. Per-Bot Data Isolation

**User Story**: Là một trader, tôi muốn trade log và analytics của từng bot được tách biệt.

#### Acceptance Criteria

1. GIVEN hai bot instances, WHEN mỗi bot được tạo, THEN mỗi bot có `TradeLogger` riêng với `tradeLogPath` khác nhau (e.g., `trades-sodex.json`, `trades-dango.json`).

2. GIVEN `GET /api/bots/:id/trades`, WHEN được gọi, THEN chỉ trả về trades của bot có `id` tương ứng.

3. GIVEN `GET /api/bots/:id/pnl`, WHEN được gọi, THEN trả về `BotSharedState` của bot đó.

---

### 7. Authentication & Security

**User Story**: Là một trader, tôi muốn dashboard được bảo vệ bởi passcode.

#### Acceptance Criteria

1. GIVEN authentication middleware hiện tại, WHEN request đến bất kỳ `/api/bots/*` route nào mà không có valid `dash_token` cookie, THEN response là `401 { error: 'Unauthorized' }`.

2. GIVEN `GET /api/bots`, WHEN được gọi, THEN `walletAddress` trong response là địa chỉ ví (public), không phải private key.

---

### 8. Default Bot Configs

**User Story**: Là một trader, tôi muốn hệ thống có sẵn 3 bot configs mặc định khi khởi động lần đầu.

#### Acceptance Criteria

1. GIVEN `bot-configs.json` không tồn tại, WHEN hệ thống khởi động lần đầu, THEN file được tạo với 3 bot configs: `sodex-bot`, `decibel-bot`, `dango-bot`.

2. GIVEN `bot-configs.json` đã tồn tại, WHEN hệ thống khởi động, THEN file không bị overwrite, configs hiện tại được giữ nguyên.

3. GIVEN 3 bot configs mặc định, WHEN được load, THEN mỗi bot có: `id`, `name`, `exchange`, `symbol`, `credentialKey`, `tradeLogPath` riêng biệt, `autoStart: false`, `mode: 'farm'`.

4. GIVEN `sodex-bot` config, WHEN được load, THEN `exchange === 'sodex'`, `credentialKey === 'SODEX'`, `tradeLogPath === './trades-sodex.json'`, `tags === ['TWAP', 'Farm']`.

5. GIVEN `decibel-bot` config, WHEN được load, THEN `exchange === 'decibel'`, `credentialKey === 'DECIBELS'`, `tradeLogPath === './trades-decibel.json'`, `tags === ['Market Making', 'Farm']`.

6. GIVEN `dango-bot` config, WHEN được load, THEN `exchange === 'dango'`, `credentialKey === 'DANGO'`, `tradeLogPath === './trades-dango.json'`, `tags === ['Scalping', 'Farm']`.

---

### 9. Config Persistence

**User Story**: Là một trader, tôi muốn config changes của bot được lưu vào file để survive qua docker restart.

#### Acceptance Criteria

1. GIVEN `POST /api/bots/:id/config` với valid overrides, WHEN request thành công, THEN bot's `ConfigStore` được update VÀ changes được persist vào `bot-configs.json`.

2. GIVEN `bot-configs.json` đã được update, WHEN docker container restart (down → build → up), THEN bot configs được load lại với changes đã lưu.

3. GIVEN `DELETE /api/bots/:id/config`, WHEN được gọi, THEN bot's config reset về defaults VÀ changes được persist vào `bot-configs.json`.

4. GIVEN `GET /api/bots/:id/config`, WHEN được gọi, THEN response chứa effective config (base + overrides) của bot đó.

5. GIVEN `POST /api/bots/:id/config` với invalid overrides, WHEN validation fails, THEN response là `400` với `errors` array VÀ `bot-configs.json` không bị thay đổi.

6. GIVEN mỗi `BotInstance`, WHEN được tạo, THEN bot có `ConfigStore` riêng với `botId` unique.

---

### 10. HTML Partials Structure

**User Story**: Là một developer, tôi muốn Manager Dashboard dùng EJS partials để dễ maintain.

#### Acceptance Criteria

1. GIVEN Manager Dashboard, WHEN `GET /` được gọi, THEN server render `manager.ejs` template.

2. GIVEN `manager.ejs`, WHEN render, THEN template include `partials/bot-cards.ejs` partial.

3. GIVEN `partials/bot-cards.ejs`, WHEN render, THEN container `#bot-cards` được tạo với `<template id="bot-card-template">` bên trong.

4. GIVEN `bot-card-template`, WHEN JavaScript fetch `/api/bots`, THEN template được dùng để render dynamic bot cards với placeholders `{id}`, `{name}`, `{status}`, etc.

5. GIVEN file structure, WHEN kiểm tra, THEN tồn tại: `views/manager.ejs`, `views/partials/bot-cards.ejs`, `views/partials/bot-card.ejs`.

6. GIVEN Bot Detail page, WHEN `GET /bots/:id` được gọi, THEN server render `layout.ejs` (existing template) với `botId` parameter.

---

## Correctness Properties

Các properties sau được verify bằng fast-check property-based tests:

**P1 — State Isolation**: Với mọi tập hợp N bot instances (N ≥ 2), khi bot i update `state.sessionPnl`, `state.sessionPnl` của tất cả bot j ≠ i không thay đổi.

**P2 — Aggregation Consistency**: Với mọi tập hợp bot instances, `getAggregatedStats().totalVolume = Σ bot.state.sessionVolume`.

**P3 — Active Count Range**: Với mọi tập hợp bot instances, `getAggregatedStats().activeBotCount ∈ [0, registry.size]`.

**P4 — Stop Idempotency**: Sau khi `stop()` được gọi, `state.botStatus` luôn là `'STOPPED'` bất kể trạng thái trước đó.

**P5 — Efficiency Calculation**: Với mọi bot có `sessionVolume > 0`, `efficiencyBps = (sessionPnl / sessionVolume) * 10000` (trong phạm vi floating point precision).
