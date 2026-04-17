# Tasks: Multi-Bot Manager

## Implementation Plan

### Phase 1: Core Infrastructure

- [x] 1.1 Tạo `BotSharedState` interface và factory function trong `src/ai/botSharedState.ts`
  - Define `BotSharedState` interface (tương đương `sharedState` singleton nhưng per-bot)
  - Export `createBotSharedState(botId: string): BotSharedState`
  - Include SSE client sets per-bot (addSseClient, removeSseClient, logEvent)
  - _Requirements: 1.6, 7.1_

- [x] 1.2 Tạo `BotConfig` và `BotInstance` types trong `src/types/bot.ts`
  - Define `BotConfig` interface với tất cả fields (id, name, exchange, symbol, tags, autoStart, mode, credentialKey, tradeLogBackend, tradeLogPath)
  - Define `BotStatus` interface (data trả về cho API)
  - Define `AggregatedStats` interface
  - _Requirements: 1.1, 2.2_

- [x] 1.3 Implement `BotInstance` class trong `src/bot/BotInstance.ts`
  - Constructor nhận `BotConfig` và `ExchangeAdapter`
  - Khởi tạo `SessionManager`, `Watcher`, `TradeLogger`, `ConfigStore` riêng cho bot
  - Implement `start()`, `stop()`, `getStatus()`, `getDetailedStatus()`, `forceClosePosition()`
  - Handle watcher crash: catch error, set `state.botStatus = 'STOPPED'`, log event
  - _Requirements: 1.1, 1.2, 1.4, 1.5, 1.14_

- [x] 1.4 Implement `BotManager` class trong `src/bot/BotManager.ts`
  - Registry: `Map<string, BotInstance>`
  - Implement `createBot(config)`, `removeBot(id)`, `getBot(id)`, `getAllBots()`
  - Implement `startBot(id)`, `stopBot(id)`
  - Implement `getAggregatedStats()`: sum volume/fees/pnl, count active bots
  - Throw `DuplicateBotError` khi id đã tồn tại
  - _Requirements: 1.1, 1.3, 2.2, 6.3_

- [x] 1.5 Tạo adapter factory function trong `src/bot/adapterFactory.ts`
  - `createAdapter(exchange, credentialKey)`: đọc env vars theo prefix, tạo đúng adapter
  - Validate credentials, throw `BotConfigError` nếu thiếu
  - Support: `sodex` → `SodexAdapter`, `dango` → `DangoAdapter`, `decibel` → `DecibelAdapter`
  - _Requirements: 6.1, 6.2_

### Phase 2: Dashboard Manager Routes

- [x] 2.1 Thêm `registerBotManager(manager: BotManager)` vào `DashboardServer`
  - Store reference đến `BotManager`
  - Gọi `_setupManagerRoutes()` sau khi manager được register
  - _Requirements: 2.1, 5.1_

- [x] 2.2 Implement Manager API routes trong `DashboardServer`
  - `GET /api/bots` → `manager.getAllBots().map(b => b.getStatus())`
  - `GET /api/bots/stats` → `manager.getAggregatedStats()`
  - `POST /api/bots` → `manager.createBot(config)`, trả về `BotStatus`
  - `DELETE /api/bots/:id` → validate stopped, `manager.removeBot(id)`
  - _Requirements: 2.2, 2.5, 6.1, 6.4, 6.5_

- [x] 2.3 Implement Per-bot control routes trong `DashboardServer`
  - `POST /api/bots/:id/start` → `manager.startBot(id)`
  - `POST /api/bots/:id/stop` → `manager.stopBot(id)`
  - `POST /api/bots/:id/close` → `bot.forceClosePosition()`
  - Handle 404 khi bot không tìm thấy, 400 khi state không hợp lệ
  - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6_

- [x] 2.4 Implement Per-bot data routes trong `DashboardServer`
  - `GET /api/bots/:id/pnl` → bot's `BotSharedState`
  - `GET /api/bots/:id/trades` → bot's `tradeLogger.readAll()`
  - `GET /api/bots/:id/status` → `bot.getDetailedStatus()`
  - `GET /api/bots/:id/events` → bot's `state.eventLog`
  - `GET /api/bots/:id/events/stream` → SSE stream từ bot's SSE clients
  - `GET /api/bots/:id/position` → bot's `state.openPosition`
  - `GET /api/bots/:id/analytics` → analytics từ bot's trades
  - `GET /api/bots/:id/config` → bot's `configStore.getEffective()` (no credentials)
  - `POST /api/bots/:id/config` → bot's `configStore.applyOverrides(patch)`
  - _Requirements: 4.4, 7.2, 7.3, 7.4, 7.5, 8.2_

### Phase 3: Manager Dashboard HTML

- [x] 3.1 Implement `_buildManagerHtml()` trong `DashboardServer`
  - `GET /` trả về Manager Dashboard HTML (thay vì Bot Detail HTML)
  - Stats row: Total Volume, Active Bots, Total Fees & PnL
  - Filter tabs: All / Active / Inactive / Completed
  - Bot cards list với đầy đủ thông tin
  - "+ Create Bot" button (modal hoặc form)
  - Dark theme, consistent với UI hiện tại
  - _Requirements: 2.1, 2.3, 2.4, 3.1, 3.2_

- [x] 3.2 Implement bot card component trong Manager Dashboard HTML
  - Hiển thị: tên, exchange badge, status badge, ID, tags, volume, fees, PnL, efficiency bps, wallet (truncated), progress bar
  - Nút Start/Stop tùy theo status
  - Nút "View details →" link đến `/bots/:id`
  - _Requirements: 3.1, 3.2, 3.3, 3.4_

- [x] 3.3 Implement `GET /bots/:id` route — Bot Detail page
  - Trả về Bot Detail HTML (tương đương `_buildHtml()` hiện tại)
  - Tất cả API calls trong page dùng `/api/bots/:id/*` prefix
  - Thêm "← Back to Manager" link
  - _Requirements: 4.1, 4.2, 4.3, 4.5_

- [x] 3.4 Cập nhật `GET /` để trả về Manager Dashboard thay vì Bot Detail
  - Nếu chỉ có 1 bot, vẫn hiển thị Manager Dashboard (không auto-redirect)
  - _Requirements: 2.1_

### Phase 4: Entry Point Refactor

- [x] 4.1 Tạo `src/bot/loadBotConfigs.ts` — load configs từ env hoặc file
  - Đọc `BOT_CONFIGS_PATH` env var (default: `./bot-configs.json`)
  - Nếu file không tồn tại, fallback về single-bot config từ env vars hiện tại
  - Validate mỗi config, log warning cho configs không hợp lệ
  - _Requirements: 1.1_

- [x] 4.2 Refactor `src/bot.ts` để dùng `BotManager`
  - Thay thế single-bot bootstrap bằng `BotManager` + `loadBotConfigs()`
  - `DashboardServer` nhận `BotManager` thay vì single bot controls
  - Giữ backward compat: nếu chỉ có 1 bot config, behavior giống hệt hiện tại
  - Telegram commands (`/start_bot`, `/stop_bot`, etc.) hoạt động với bot đầu tiên (hoặc bot được chỉ định)
  - _Requirements: 1.1, 1.2_

### Phase 5: Tests

- [x] 5.1 Unit tests cho `BotManager` trong `src/bot/__tests__/BotManager.test.ts`
  - Test `createBot`, `removeBot`, `getBot`, `getAllBots`
  - Test `DuplicateBotError` khi id trùng
  - Test `getAggregatedStats()` với mock instances
  - _Requirements: 1.2, 1.3, 2.2_

- [x] 5.2 Unit tests cho `BotInstance` trong `src/bot/__tests__/BotInstance.test.ts`
  - Test start/stop state transitions
  - Test crash handling (watcher throw → status STOPPED)
  - Test `start()` khi đã running trả về false
  - _Requirements: 1.4, 1.5, 1.14_

- [x] 5.3 Unit tests cho Manager Routes trong `src/dashboard/__tests__/manager-routes.test.ts`
  - Test tất cả `/api/bots/*` endpoints với supertest + mock BotManager
  - Test 404 khi bot không tìm thấy
  - Test 401 khi không authenticated
  - _Requirements: 5.6, 8.1_

- [x] 5.4 Property-based tests trong `src/bot/__tests__/BotManager.properties.test.ts`
  - P1: State isolation — update bot i không ảnh hưởng bot j
  - P2: Aggregation consistency — totalVolume = Σ sessionVolume
  - P3: Filter completeness — filter 'all' trả về toàn bộ
  - P4: Filter correctness — filter 'active' chỉ trả về active bots
  - P5: Stop idempotency — sau stop(), status luôn STOPPED
  - P6: Efficiency calculation — efficiencyBps = (pnl/volume)*10000
  - _Requirements: Correctness Properties P1-P6_

- [x] 5.5 Integration test trong `src/bot/__tests__/multi-bot.integration.test.ts`
  - Tạo 2 bot instances với mock adapters
  - Start/stop qua API, verify aggregated stats
  - Verify trade logs tách biệt
  - _Requirements: 1.6, 7.1, 7.2_
