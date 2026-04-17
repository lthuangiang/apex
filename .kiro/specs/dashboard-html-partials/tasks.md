# Implementation Plan: Dashboard HTML Partials

## Overview

Refactor `src/dashboard/public/index.html` (~400 lines) thành các EJS partial templates được compose server-side bởi Express. Mỗi section của dashboard sẽ là một file riêng biệt trong `src/dashboard/views/`, giữ nguyên toàn bộ API routes, client JS, và CSS hiện có.

## Tasks

- [x] 1. Cài đặt EJS và cập nhật DashboardServer để dùng template engine
  - [x] 1.1 Cài đặt package `ejs` và `@types/ejs`
    - Chạy `npm install ejs` và `npm install --save-dev @types/ejs`
    - _Requirements: 1.1_
  - [x] 1.2 Cập nhật `src/dashboard/server.ts` để đăng ký EJS engine
    - Thêm `import path from 'path'` và `import { fileURLToPath } from 'url'` nếu chưa có
    - Thêm constant `TEMPLATE_ENGINE = 'ejs'` và `VIEWS_DIR = path.join(__dirname, 'views')` ở top of file
    - Trong constructor, sau `this.app = express()`, thêm `this.app.set('view engine', TEMPLATE_ENGINE)` và `this.app.set('views', VIEWS_DIR)`
    - Thêm `import fs from 'fs'` và implement `_validateViewsDir()` method gọi `process.exit(1)` nếu VIEWS_DIR không tồn tại
    - Gọi `this._validateViewsDir()` trong constructor
    - _Requirements: 1.1, 1.2, 7.2, 7.4_
  - [x] 1.3 Thay thế `GET /` route để dùng `res.render('layout', ...)`
    - Thay `res.send(this._buildHtml())` bằng `res.render('layout', (err, html) => { ... })` với error handling trả về HTTP 500
    - Giữ nguyên `_buildLoginHtml()` và `_authMiddleware` không thay đổi
    - _Requirements: 1.3, 1.5, 6.3_

- [x] 2. Tạo cấu trúc thư mục views và layout.ejs
  - [x] 2.1 Tạo thư mục `src/dashboard/views/partials/overview/` và `src/dashboard/views/partials/analytics/`
    - Tạo đúng cấu trúc thư mục theo design: `views/`, `views/partials/`, `views/partials/overview/`, `views/partials/analytics/`
    - _Requirements: 2.1_
  - [x] 2.2 Tạo `src/dashboard/views/layout.ejs`
    - Chứa `<!DOCTYPE html>`, `<html>`, `<head>` với Chart.js CDN link và `<link rel="stylesheet" href="/css/main.css"/>`
    - Chứa `<body>` với tất cả `<%- include('partials/...') %>` theo đúng thứ tự trong design
    - Kết thúc với `<script src="/js/dashboard.js"></script>` trước `</body>`
    - _Requirements: 2.2, 2.3, 4.2, 4.3, 5.1, 5.3_

- [x] 3. Tạo các partial files cho Overview Tab
  - [x] 3.1 Tạo `src/dashboard/views/partials/header.ejs`
    - Extract phần `<div class="header">` từ `index.html` — chứa `#page-title`, `#status-badge`, `#status-text`, gear button, `#symbol-label`, `#wallet-addr`
    - _Requirements: 3.2_
  - [x] 3.2 Tạo `src/dashboard/views/partials/tab-nav.ejs`
    - Extract phần `<nav class="tab-nav">` — chứa `#tabnav-overview` và `#tabnav-analytics`
    - _Requirements: 3.3, 6.4_
  - [x] 3.3 Tạo `src/dashboard/views/partials/overview/tier-week-position.ejs`
    - Extract phần `.three-col` chứa tier card wrap, week volume card, và open position card
    - _Requirements: 2.1, 3.1_
  - [x] 3.4 Tạo `src/dashboard/views/partials/overview/ctrl-panel.ejs`
    - Extract phần `<div class="ctrl-panel">` với tất cả bot control buttons
    - _Requirements: 2.1, 3.1_
  - [x] 3.5 Tạo `src/dashboard/views/partials/overview/cfg-modal.ejs`
    - Extract phần `<div class="cfg-overlay" id="cfg-overlay">` với toàn bộ config modal
    - Phải chứa tất cả config sections: Order Sizing, Risk Management, Farm Mode, Trade Mode, Cooldown, Dust Position, SoPoints Token
    - Phải chứa `#cfg-ORDER_SIZE_MIN` và `#cfg-FARM_TP_USD`
    - _Requirements: 3.4_
  - [x] 3.6 Tạo `src/dashboard/views/partials/overview/stats-charts.ejs`
    - Extract phần `.cards-row` (PnL + Volume cards) và `.charts-row` đầu tiên (PnL chart + Volume chart)
    - Phải chứa `#pnl-value`, `#vol-value`
    - _Requirements: 2.1, 3.1_
  - [x] 3.7 Tạo `src/dashboard/views/partials/overview/realtime-log.ejs`
    - Extract phần `.log-card` với log tabs và `#log-console`
    - _Requirements: 2.1, 3.1_
  - [x] 3.8 Tạo `src/dashboard/views/partials/overview/tables.ejs`
    - Extract phần `.tables-row` với trade history table (`#trades-body`) và event log table (`#events-body`)
    - _Requirements: 2.1, 3.1, 6.2_

- [x] 4. Tạo các partial files cho Analytics Tab
  - [x] 4.1 Tạo `src/dashboard/views/partials/analytics/summary-cards.ejs`
    - Extract phần `.an-cards-row` — chứa `#an-winrate`, `#an-avgpnl`, `#an-total`, `#an-fees`
    - _Requirements: 2.1, 3.1_
  - [x] 4.2 Tạo `src/dashboard/views/partials/analytics/mode-signal.ejs`
    - Extract phần `.an-charts-row` đầu tiên với Win Rate by Mode và Signal Quality cards
    - _Requirements: 2.1, 3.1_
  - [x] 4.3 Tạo `src/dashboard/views/partials/analytics/charts.ejs`
    - Extract hai `.an-charts-row` chứa 4 chart canvases: `#an-chart-direction`, `#an-chart-regime`, `#an-chart-confidence`, `#an-chart-hour`
    - _Requirements: 3.5_
  - [x] 4.4 Tạo `src/dashboard/views/partials/analytics/best-worst-holding.ejs`
    - Extract phần `.an-three-col` với best trade, worst trade, và holding time chart
    - _Requirements: 2.1, 3.1_

- [x] 5. Wrap các partials trong tab panel containers trong layout.ejs
  - Đảm bảo `layout.ejs` wrap overview partials trong `<div class="tab-panel active" id="tabpanel-overview">` và analytics partials trong `<div class="tab-panel" id="tabpanel-analytics">`
  - Đảm bảo `<div class="main">` wrappers được đặt đúng vị trí trong layout hoặc trong partials tương ứng
  - _Requirements: 2.2, 6.2, 6.4_

- [x] 6. Cập nhật build script để copy views sang dist/
  - Cập nhật `package.json` build script thêm step copy: `"build": "tsc && node -e \"require('fs').cpSync('src/dashboard/views','dist/dashboard/views',{recursive:true})\""`
  - _Requirements: 7.1, 7.3_

- [x] 7. Checkpoint — Kiểm tra server khởi động và render đúng
  - Đảm bảo tất cả 13 partial files + `layout.ejs` tồn tại
  - Đảm bảo không có `<style>` tags trong partial files
  - Đảm bảo không có `<script>` blocks với application logic trong partial files
  - Ensure all tests pass, ask the user if questions arise.

- [x] 8. Viết tests cho partials structure và render
  - [x] 8.1 Tạo `src/dashboard/__tests__/partials-structure.test.ts` — smoke tests
    - Test `app.get('view engine')` === `'ejs'`
    - Test `app.get('views')` trỏ đến đúng directory
    - Test tất cả 13 partial files + `layout.ejs` tồn tại trên disk
    - Test `GET /css/main.css` và `GET /js/dashboard.js` trả về 200
    - Test không có `<style>` tags trong partial files
    - Test không có `<script>` blocks với application logic trong partial files
    - _Requirements: 1.1, 1.2, 2.1, 4.1, 5.2_
  - [ ]* 8.2 Tạo `src/dashboard/__tests__/partials-render.test.ts` — example-based tests
    - Test `GET /` (authenticated) → 200, HTML chứa tất cả required DOM element IDs: `#page-title`, `#status-badge`, `#tabnav-overview`, `#tabnav-analytics`, `#tabpanel-overview`, `#tabpanel-analytics`, `#pnl-value`, `#vol-value`, `#log-console`, `#trades-body`, `#events-body`, `#an-winrate`, `#an-avgpnl`, `#an-total`, `#an-fees`, `#an-chart-direction`, `#an-chart-regime`, `#an-chart-confidence`, `#an-chart-hour`, `#cfg-overlay`, `#cfg-ORDER_SIZE_MIN`, `#cfg-FARM_TP_USD`
    - Test `GET /` (authenticated) → HTML chứa `<link rel="stylesheet" href="/css/main.css"/>`
    - Test `GET /` (authenticated) → HTML chứa `<script src="https://cdn.jsdelivr.net/npm/chart.js`
    - Test `GET /` (authenticated) → HTML chứa `<script src="/js/dashboard.js"></script>` trước `</body>`
    - Test `GET /` (unauthenticated) → 200, HTML chứa login form (`#pc`, `#err`)
    - Test render error → HTTP 500 với error message
    - _Requirements: 1.3, 1.5, 2.2, 2.3, 3.1, 3.2, 3.3, 3.4, 3.5, 4.3, 5.1, 5.3, 6.2, 6.3, 6.4_

- [x] 9. Final checkpoint — Đảm bảo existing tests không bị break
  - Chạy `npm test` để verify `src/dashboard/server.test.ts` và `src/dashboard/config-routes.test.ts` vẫn pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Không có property-based tests vì đây là UI rendering refactor — example-based tests phù hợp hơn
- `_buildLoginHtml()` và `_buildHtml()` trong `server.ts` có thể xóa sau khi EJS render hoạt động đúng
- Tất cả CSS giữ nguyên trong `public/css/main.css` — không inline vào partials
- Tất cả client JS giữ nguyên trong `public/js/dashboard.js` — không inline vào partials
