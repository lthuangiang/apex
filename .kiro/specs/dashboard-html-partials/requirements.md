# Requirements Document

## Introduction

Hiện tại dashboard SoDEX có một file `index.html` duy nhất (~400 dòng) chứa toàn bộ UI: header, tab navigation, overview tab (tier/week/position cards, control panel, config modal, stats/charts, realtime log, trade/event tables) và analytics tab. File này ngày càng khó maintain và khó mở rộng khi thêm features mới.

Feature này refactor `index.html` thành các partial template nhỏ theo từng section/tab, sử dụng server-side template engine (EJS hoặc Handlebars) để compose lại thành trang hoàn chỉnh. Mục tiêu là mỗi section có thể được chỉnh sửa, test và mở rộng độc lập mà không ảnh hưởng đến các phần còn lại.

## Glossary

- **Template_Engine**: EJS hoặc Handlebars — thư viện render server-side template trên Express
- **Partial**: File template nhỏ đại diện cho một section/component của UI
- **Dashboard_Server**: Express/TypeScript server tại `src/dashboard/server.ts`
- **Views_Directory**: Thư mục chứa các partial template, đề xuất `src/dashboard/views/`
- **Layout**: Template gốc (base layout) bao gồm `<head>`, `<body>` wrapper và include các partial
- **Overview_Tab**: Tab đầu tiên của dashboard chứa tier/week/position, control panel, config modal, stats/charts, realtime log, tables
- **Analytics_Tab**: Tab thứ hai chứa summary cards, mode/signal metrics, charts, best/worst trade

---

## Requirements

### Requirement 1: Tích hợp Template Engine vào Dashboard Server

**User Story:** As a developer, I want the Dashboard Server to use a server-side template engine, so that I can compose HTML from multiple partial files instead of building it as a string in TypeScript.

#### Acceptance Criteria

1. THE Dashboard_Server SHALL support EJS as the default template engine, configurable via a constant at the top of `server.ts`
2. WHEN the Dashboard_Server starts, THE Dashboard_Server SHALL register the Views_Directory with the template engine so partials can be resolved by relative path
3. WHEN a request arrives at `GET /`, THE Dashboard_Server SHALL render the layout template using the template engine instead of calling `_buildHtml()`
4. THE Dashboard_Server SHALL serve static assets (CSS, JS) from `src/dashboard/public/` at the same paths as before (`/css/main.css`, `/js/dashboard.js`)
5. IF the template engine fails to render a template, THEN THE Dashboard_Server SHALL return HTTP 500 with a descriptive error message

---

### Requirement 2: Cấu trúc thư mục Views và Layout

**User Story:** As a developer, I want a clear directory structure for all partial files, so that I can find and edit any section of the dashboard quickly.

#### Acceptance Criteria

1. THE Views_Directory SHALL contain the following structure:
   - `layout.ejs` — base layout (head, body wrapper, script tags)
   - `partials/header.ejs` — header section
   - `partials/tab-nav.ejs` — tab navigation bar
   - `partials/overview/tier-week-position.ejs` — tier card, week volume card, open position card
   - `partials/overview/ctrl-panel.ejs` — bot control panel
   - `partials/overview/cfg-modal.ejs` — config settings modal
   - `partials/overview/stats-charts.ejs` — session PnL/volume cards và charts
   - `partials/overview/realtime-log.ejs` — realtime log section
   - `partials/overview/tables.ejs` — trade history và event log tables
   - `partials/analytics/summary-cards.ejs` — overall win rate, avg PnL, total trades, fees cards
   - `partials/analytics/mode-signal.ejs` — win rate by mode và signal quality metrics
   - `partials/analytics/charts.ejs` — direction/regime/confidence/hour charts
   - `partials/analytics/best-worst-holding.ejs` — best trade, worst trade, holding time chart
2. THE Layout SHALL include all partials in the correct render order matching the current `index.html` structure
3. THE Layout SHALL include the `<head>` section with Chart.js CDN link và CSS link, identical to the current `index.html`

---

### Requirement 3: Nội dung Partial Tương đương với index.html Hiện tại

**User Story:** As a developer, I want each partial to contain exactly the HTML that was previously in the corresponding section of index.html, so that the rendered output is functionally identical to the current dashboard.

#### Acceptance Criteria

1. WHEN the Dashboard_Server renders `GET /`, THE Template_Engine SHALL produce HTML output that is functionally equivalent to the current `index.html` content
2. THE `partials/header.ejs` SHALL contain the `.header` div with title, status badge, gear button, symbol label, và wallet address elements
3. THE `partials/tab-nav.ejs` SHALL contain the `<nav class="tab-nav">` element with Overview và Analytics tab buttons
4. THE `partials/overview/cfg-modal.ejs` SHALL contain the full config modal with all config sections (Order Sizing, Risk Management, Farm Mode, Trade Mode, Cooldown, Dust Position, SoPoints Token)
5. THE `partials/analytics/charts.ejs` SHALL contain all four analytics chart canvases: `an-chart-direction`, `an-chart-regime`, `an-chart-confidence`, `an-chart-hour`
6. IF a partial file is missing or unreadable at server startup, THEN THE Dashboard_Server SHALL log an error and exit with a non-zero code

---

### Requirement 4: CSS được giữ nguyên trong file riêng

**User Story:** As a developer, I want all CSS to remain in `public/css/main.css`, so that styles are not duplicated across partial files.

#### Acceptance Criteria

1. THE Dashboard_Server SHALL NOT inline CSS styles inside any partial template file
2. THE Layout SHALL reference `/css/main.css` via a `<link>` tag in the `<head>` section
3. WHEN the Dashboard_Server renders the layout, THE Template_Engine SHALL produce a `<link rel="stylesheet" href="/css/main.css"/>` tag in the `<head>`
4. THE `public/css/main.css` file SHALL contain all styles currently defined in the `_buildHtml()` method's CSS string in `server.ts`, migrated verbatim

---

### Requirement 5: JavaScript giữ nguyên trong file riêng

**User Story:** As a developer, I want all client-side JavaScript to remain in `public/js/dashboard.js`, so that JS logic is not scattered across partial files.

#### Acceptance Criteria

1. THE Layout SHALL reference `/js/dashboard.js` via a `<script src>` tag at the bottom of `<body>`, identical to the current `index.html`
2. THE Dashboard_Server SHALL NOT inline `<script>` blocks with application logic inside any partial template file
3. WHEN the Dashboard_Server renders the layout, THE Template_Engine SHALL produce a `<script src="/js/dashboard.js"></script>` tag before `</body>`

---

### Requirement 6: Backward Compatibility — API và Client JS không thay đổi

**User Story:** As a developer, I want all existing API endpoints and client-side JS to continue working without modification, so that the refactor does not break any runtime functionality.

#### Acceptance Criteria

1. THE Dashboard_Server SHALL preserve all existing API routes (`/api/trades`, `/api/pnl`, `/api/events`, `/api/control/*`, `/api/config`, `/api/analytics/*`, etc.) without modification
2. WHEN the rendered HTML is loaded in a browser, THE `dashboard.js` SHALL be able to find all DOM element IDs that it currently references (e.g., `pnl-value`, `vol-value`, `log-console`, `trades-body`, etc.)
3. THE Dashboard_Server SHALL preserve the authentication middleware (`_authMiddleware`) behavior — unauthenticated requests to `GET /` SHALL still receive the login page
4. WHEN `dashboard.js` calls `switchMainTab('overview')` or `switchMainTab('analytics')`, THE rendered HTML SHALL contain elements with IDs `tabpanel-overview` và `tabpanel-analytics`

---

### Requirement 7: Build và TypeScript Compilation

**User Story:** As a developer, I want the template files to be copied to the `dist/` output directory during build, so that the compiled server can find them at runtime.

#### Acceptance Criteria

1. THE build process SHALL copy all files in `src/dashboard/views/` to `dist/dashboard/views/` preserving the directory structure
2. WHEN `tsc` compiles the project, THE Dashboard_Server compiled output SHALL reference the views directory using a path relative to the compiled file location (`dist/dashboard/views/`)
3. THE `package.json` build script SHALL include a step to copy view templates to `dist/` after TypeScript compilation
4. IF the `dist/dashboard/views/` directory does not exist at server startup, THEN THE Dashboard_Server SHALL log a clear error indicating the views directory is missing

---

### Requirement 8: Không thay đổi login.html

**User Story:** As a developer, I want the login page to remain as a standalone HTML file, so that the authentication flow is not affected by the template engine refactor.

#### Acceptance Criteria

1. THE `public/login.html` file SHALL remain unchanged as a standalone HTML file
2. THE Dashboard_Server SHALL continue to serve the login page by reading `public/login.html` OR by keeping the `_buildLoginHtml()` inline method — either approach is acceptable
3. WHEN an unauthenticated user accesses `GET /`, THE Dashboard_Server SHALL respond with the login page HTML with HTTP 200 status
