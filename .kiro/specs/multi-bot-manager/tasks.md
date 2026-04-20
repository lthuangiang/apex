# Tasks: Multi-Bot Manager

## Implementation Plan

### Phase 1: Core Infrastructure

- [x] 1.1 Tạo `BotSharedState` interface và factory function
  - File: `src/bot/BotSharedState.ts`
  - Define `BotSharedState` interface (tương đương structure của `sharedState` singleton)
  - Export `createBotSharedState(botId: string): BotSharedState`
  - Include SSE client sets per-bot (addSseClient, removeSseClient, logEvent)
  - _Requirements: 1.6, 6.1_

- [x] 1.2 Tạo `BotConfig` và `BotStatus` types
  - File: `src/bot/types.ts`
  - Define `BotConfig` interface với tất cả fields (id, name, exchange, symbol, tags, autoStart, mode, credentialKey, tradeLogBackend, tradeLogPath, orderSizeMin, orderSizeMax)
  - Define `BotStatus` interface (data trả về cho API)
  - Define `AggregatedStats` interface
  - _Requirements: 1.1, 2.2_

- [x] 1.3 Implement `BotInstance` class
  - File: `src/bot/BotInstance.ts`
  - Constructor nhận `BotConfig`, `ExchangeAdapter`, `TelegramManager`
  - Khởi tạo `SessionManager`, `Watcher`, `TradeLogger` riêng cho bot
  - Implement `start()`, `stop()`, `getStatus()`, `forceClosePosition()`
  - Handle watcher crash: catch error trong promise, set `state.botStatus = 'STOPPED'`, log error
  - _Requirements: 1.1, 1.2, 1.4, 1.5_

- [x] 1.4 Implement `BotManager` class
  - File: `src/bot/BotManager.ts`
  - Registry: `Map<string, BotInstance>`
  - Implement `createBot(config, adapter, telegram)`, `removeBot(id)`, `getBot(id)`, `getAllBots()`
  - Implement `startBot(id)`, `stopBot(id)`
  - Implement `getAggregatedStats()`: sum volume/fees/pnl, count active bots
  - Throw error khi id đã tồn tại
  - _Requirements: 1.1, 1.3, 2.2_

- [x] 1.5 Tạo adapter factory function
  - File: `src/bot/adapterFactory.ts`
  - `createAdapter(exchange, credentialKey)`: đọc env vars theo prefix, tạo đúng adapter
  - Validate credentials, throw error nếu thiếu
  - Support: `sodex` → `SodexAdapter`, `dango` → `DangoAdapter`, `decibel` → `DecibelAdapter`
  - _Requirements: 1.1_

- [x] 1.6 Tạo default bot-configs.json với 3 bots
  - File: `bot-configs.json` (root directory)
  - Nếu file không tồn tại, tạo với 3 configs: `sodex-bot`, `decibel-bot`, `dango-bot`
  - Mỗi bot có: unique `id`, `name`, `exchange`, `credentialKey`, `tradeLogPath`, `tags`, `autoStart: false`, `mode: 'farm'`
  - Nếu file đã tồn tại, không overwrite
  - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.6_

### Phase 2: Dashboard Manager Routes

- [x] 2.1 Thêm `registerBotManager(manager: BotManager)` vào `DashboardServer`
  - File: `src/dashboard/server.ts`
  - Store reference đến `BotManager`
  - Gọi `_setupManagerRoutes()` sau khi manager được register
  - _Requirements: 2.1, 5.1_

- [x] 2.2 Implement Manager API routes trong `DashboardServer`
  - File: `src/dashboard/server.ts`
  - `GET /api/bots` → `manager.getAllBots().map(b => b.getStatus())`
  - `GET /api/bots/stats` → `manager.getAggregatedStats()`
  - _Requirements: 2.2, 2.5_

- [x] 2.3 Implement Per-bot control routes trong `DashboardServer`
  - File: `src/dashboard/server.ts`
  - `POST /api/bots/:id/start` → `manager.startBot(id)`
  - `POST /api/bots/:id/stop` → `manager.stopBot(id)`
  - `POST /api/bots/:id/close` → `bot.forceClosePosition()`
  - Handle 404 khi bot không tìm thấy, 400 khi state không hợp lệ
  - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6_

- [x] 2.4 Implement Per-bot data routes trong `DashboardServer`
  - File: `src/dashboard/server.ts`
  - `GET /api/bots/:id/pnl` → bot's `BotSharedState`
  - `GET /api/bots/:id/trades` → bot's `tradeLogger.readAll()`
  - `GET /api/bots/:id/events` → bot's `state.eventLog`
  - `GET /api/bots/:id/position` → bot's `state.openPosition`
  - _Requirements: 4.4, 6.2, 6.3_

- [x] 2.5 Implement config persistence routes trong `DashboardServer`
  - File: `src/dashboard/server.ts`
  - `GET /api/bots/:id/config` → bot's `configStore.getEffective()`
  - `POST /api/bots/:id/config` → apply overrides + persist to file
  - `DELETE /api/bots/:id/config` → reset to defaults + persist to file
  - Tạo `src/bot/persistBotConfigs.ts` với `saveBotConfigsToFile(manager, filePath)`
  - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 9.6_

### Phase 3: Manager Dashboard HTML

- [x] 3.1 Implement Manager Dashboard HTML template
  - File: `src/dashboard/views/manager.ejs` (hoặc inline trong server.ts)
  - `GET /` trả về Manager Dashboard HTML
  - Stats row: Total Volume, Active Bots, Total Fees & PnL
  - Filter tabs: All / Active / Inactive
  - Bot cards list với đầy đủ thông tin
  - Dark theme, consistent với UI hiện tại
  - _Requirements: 2.1, 2.3, 2.4_

- [x] 3.2 Implement bot card component trong Manager Dashboard
  - Hiển thị: tên, exchange badge, status badge, ID, tags, volume, fees, PnL, efficiency bps, wallet (truncated), progress bar
  - Nút Start/Stop tùy theo status
  - Nút "View details →" link đến `/bots/:id`
  - _Requirements: 3.1, 3.2, 3.3, 3.4_

- [x] 3.3 Implement `GET /bots/:id` route — Bot Detail page
  - File: `src/dashboard/server.ts`
  - Trả về Bot Detail HTML (tương đương UI hiện tại)
  - Tất cả API calls trong page dùng `/api/bots/:id/*` prefix
  - Thêm "← Back to Manager" link
  - _Requirements: 4.1, 4.2, 4.3, 4.5_

- [x] 3.4 Cập nhật `GET /` để trả về Manager Dashboard
  - File: `src/dashboard/server.ts`
  - Nếu chỉ có 1 bot, vẫn hiển thị Manager Dashboard (không auto-redirect)
  - _Requirements: 2.1_

- [x] 3.5 Tạo EJS partials cho Manager Dashboard
  - File: `src/dashboard/views/manager.ejs` - Manager Dashboard layout
  - File: `src/dashboard/views/partials/bot-cards.ejs` - Bot cards container
  - File: `src/dashboard/views/partials/bot-card.ejs` - Bot card template
  - `manager.ejs` include `partials/bot-cards.ejs`
  - `bot-card.ejs` chứa `<template id="bot-card-template">` với placeholders
  - JavaScript render dynamic cards từ `/api/bots` data
  - _Requirements: 10.1, 10.2, 10.3, 10.4, 10.5, 10.6_

### Phase 4: Entry Point Integration

- [x] 4.1 Tạo `loadBotConfigs()` function
  - File: `src/bot/loadBotConfigs.ts`
  - Đọc `BOT_CONFIGS_PATH` env var (default: `./bot-configs.json`)
  - Nếu file không tồn tại, fallback về single-bot config từ env vars hiện tại
  - Validate mỗi config, log warning cho configs không hợp lệ
  - _Requirements: 1.1_

- [x] 4.2 Refactor `src/bot.ts` để dùng `BotManager`
  - File: `src/bot.ts`
  - Thay thế single-bot bootstrap bằng `BotManager` + `loadBotConfigs()`
  - `DashboardServer` nhận `BotManager` thay vì single bot controls
  - Giữ backward compat: nếu chỉ có 1 bot config, behavior giống hệt hiện tại
  - Telegram commands (`/start_bot`, `/stop_bot`, etc.) hoạt động với bot đầu tiên
  - _Requirements: 1.1, 1.2_

### Phase 5: Tests

- [x] 5.1 Unit tests cho `BotManager`
  - File: `src/bot/__tests__/BotManager.test.ts`
  - Test `createBot`, `removeBot`, `getBot`, `getAllBots`
  - Test error khi id trùng
  - Test `getAggregatedStats()` với mock instances
  - _Requirements: 1.2, 1.3, 2.2_

- [ ] 5.2 Unit tests cho `BotInstance`
  - File: `src/bot/__tests__/BotInstance.test.ts`
  - Test start/stop state transitions
  - Test crash handling (watcher throw → status STOPPED)
  - Test `start()` khi đã running trả về false
  - _Requirements: 1.4, 1.5_

- [ ] 5.3 Unit tests cho Manager Routes
  - File: `src/dashboard/__tests__/manager-routes.test.ts`
  - Test tất cả `/api/bots/*` endpoints với supertest + mock BotManager
  - Test 404 khi bot không tìm thấy
  - Test 401 khi không authenticated
  - _Requirements: 5.6, 7.1_

- [ ] 5.4 Unit tests cho Config Persistence
  - File: `src/bot/__tests__/persistBotConfigs.test.ts`
  - Test `saveBotConfigsToFile()` với mock BotManager
  - Test config overrides được merge đúng vào BotConfig
  - Test file được write với format đúng
  - _Requirements: 9.1, 9.2, 9.3_

- [ ] 5.5 Unit tests cho HTML Partials
  - File: `src/dashboard/__tests__/partials-structure.test.ts`
  - Test `manager.ejs` render thành công
  - Test `partials/bot-cards.ejs` được include đúng
  - Test `bot-card-template` tồn tại trong rendered HTML
  - _Requirements: 10.1, 10.2, 10.3_

- [ ] 5.6 Property-based tests
  - File: `src/bot/__tests__/BotManager.properties.test.ts`
  - P1: State isolation — update bot i không ảnh hưởng bot j
  - P2: Aggregation consistency — totalVolume = Σ sessionVolume
  - P3: Active count range — activeBotCount ∈ [0, registry.size]
  - P4: Stop idempotency — sau stop(), status luôn STOPPED
  - P5: Efficiency calculation — efficiencyBps = (pnl/volume)*10000
  - _Requirements: Correctness Properties P1-P5_

- [ ] 5.7 Integration test
  - File: `src/bot/__tests__/multi-bot.integration.test.ts`
  - Tạo 2 bot instances với mock adapters
  - Start/stop qua API, verify aggregated stats
  - Verify trade logs tách biệt
  - _Requirements: 1.6, 6.1, 6.2_
