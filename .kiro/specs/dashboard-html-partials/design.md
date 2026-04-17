# Design Document: Dashboard HTML Partials

## Overview

Refactor `src/dashboard/public/index.html` (~400 lines, monolithic) thành các partial EJS template nhỏ, được compose server-side bởi Express. Mục tiêu là mỗi section của dashboard có thể được chỉnh sửa độc lập mà không ảnh hưởng đến phần còn lại, đồng thời giữ nguyên toàn bộ API routes, client JS, và CSS hiện có.

**Approach được chọn**: EJS (Embedded JavaScript Templates) — đã có sẵn trong ecosystem Node.js, không cần dependency mới ngoài package `ejs`, cú pháp `<%- include('partials/header') %>` đơn giản và trực tiếp.

---

## Architecture

```
GET /
  └─► _authMiddleware
        ├─ unauthenticated → _buildLoginHtml() (giữ nguyên)
        └─ authenticated   → res.render('layout', data)
                                └─► EJS engine
                                      ├─ layout.ejs
                                      │    ├─ <%- include('partials/header') %>
                                      │    ├─ <%- include('partials/tab-nav') %>
                                      │    ├─ <%- include('partials/overview/tier-week-position') %>
                                      │    ├─ <%- include('partials/overview/ctrl-panel') %>
                                      │    ├─ <%- include('partials/overview/cfg-modal') %>
                                      │    ├─ <%- include('partials/overview/stats-charts') %>
                                      │    ├─ <%- include('partials/overview/realtime-log') %>
                                      │    ├─ <%- include('partials/overview/tables') %>
                                      │    ├─ <%- include('partials/analytics/summary-cards') %>
                                      │    ├─ <%- include('partials/analytics/mode-signal') %>
                                      │    ├─ <%- include('partials/analytics/charts') %>
                                      │    └─ <%- include('partials/analytics/best-worst-holding') %>
                                      └─► HTML response
```

### Luồng dữ liệu

- `DashboardServer` đăng ký EJS engine và views directory khi khởi tạo
- `GET /` gọi `res.render('layout')` — không truyền data động (tất cả data được fetch bởi `dashboard.js` qua API calls)
- Static assets (`/css/main.css`, `/js/dashboard.js`) tiếp tục được serve từ `public/` như cũ
- Tất cả API routes (`/api/*`) không thay đổi

---

## Components and Interfaces

### 1. DashboardServer (modified)

**Thay đổi trong `src/dashboard/server.ts`**:

```typescript
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Constant tại top of file — dễ thay đổi engine sau này
const TEMPLATE_ENGINE = 'ejs' as const;
const VIEWS_DIR = path.join(__dirname, 'views');
```

Trong constructor, sau `this.app = express()`:
```typescript
this.app.set('view engine', TEMPLATE_ENGINE);
this.app.set('views', VIEWS_DIR);
```

Route `GET /` thay đổi từ:
```typescript
res.send(this._buildHtml());
```
thành:
```typescript
res.render('layout', (err, html) => {
  if (err) {
    console.error('[DashboardServer] Template render error:', err);
    res.status(500).send(`Template render error: ${err.message}`);
    return;
  }
  res.setHeader('Content-Type', 'text/html');
  res.send(html);
});
```

Startup validation — kiểm tra views directory tồn tại:
```typescript
private _validateViewsDir(): void {
  if (!fs.existsSync(VIEWS_DIR)) {
    console.error(`[DashboardServer] FATAL: Views directory not found: ${VIEWS_DIR}`);
    process.exit(1);
  }
}
```

### 2. Views Directory Structure

```
src/dashboard/views/
├── layout.ejs
└── partials/
    ├── header.ejs
    ├── tab-nav.ejs
    ├── overview/
    │   ├── tier-week-position.ejs
    │   ├── ctrl-panel.ejs
    │   ├── cfg-modal.ejs
    │   ├── stats-charts.ejs
    │   ├── realtime-log.ejs
    │   └── tables.ejs
    └── analytics/
        ├── summary-cards.ejs
        ├── mode-signal.ejs
        ├── charts.ejs
        └── best-worst-holding.ejs
```

### 3. Build Process

`package.json` build script được cập nhật để copy views sau khi `tsc` compile:

```json
"build": "tsc && cp -r src/dashboard/views dist/dashboard/views"
```

Trên Windows (cross-platform alternative):
```json
"build": "tsc && node -e \"require('fs').cpSync('src/dashboard/views','dist/dashboard/views',{recursive:true})\""
```

---

## Data Models

Feature này không introduce data models mới. Tất cả data vẫn được fetch bởi `dashboard.js` qua các API endpoints hiện có. EJS templates chỉ render static HTML structure — không có server-side data binding.

**EJS template variables**: Không có (layout được render với empty data object `{}`).

---

## Correctness Properties

*A property is a characteristic or behavior that should hold true across all valid executions of a system — essentially, a formal statement about what the system should do. Properties serve as the bridge between human-readable specifications and machine-verifiable correctness guarantees.*

**PBT Applicability Assessment**: Feature này là UI rendering refactor — chuyển từ string concatenation sang EJS templates. Các acceptance criteria chủ yếu là:
- Configuration/setup checks (SMOKE)
- Specific content verification (EXAMPLE)
- Error handling for specific conditions (EXAMPLE)

Không có acceptance criteria nào có dạng "for all inputs X, property P(X) holds" với input space đủ lớn để benefit từ 100+ iterations. Đây là trường hợp điển hình của **UI rendering** và **configuration validation** — PBT không phù hợp.

**Kết luận**: Bỏ qua Correctness Properties section. Sử dụng example-based unit tests và smoke tests thay thế.

---

## Error Handling

| Tình huống | Hành vi |
|---|---|
| Views directory không tồn tại khi startup | Log error + `process.exit(1)` |
| Partial file bị thiếu/không đọc được | EJS throw error → caught bởi render callback → HTTP 500 với message |
| Template render error (syntax error trong EJS) | HTTP 500 với `err.message` |
| Unauthenticated request | Trả về login page HTML (giữ nguyên `_buildLoginHtml()`) |
| API route errors | Giữ nguyên error handling hiện tại |

---

## Testing Strategy

Feature này không phù hợp với property-based testing vì:
- Là UI rendering refactor — output là HTML string, không có universal properties qua input space lớn
- Các checks đều là "does this specific element exist?" — example-based tests phù hợp hơn

### Unit / Integration Tests

**Smoke tests** (kiểm tra setup một lần):
- `app.get('view engine')` === `'ejs'`
- `app.get('views')` trỏ đến đúng directory
- Tất cả 13 partial files + `layout.ejs` tồn tại trên disk
- `GET /css/main.css` và `GET /js/dashboard.js` trả về 200
- `package.json` build script chứa copy command
- Không có `<style>` tags trong partial files
- Không có `<script>` blocks với application logic trong partial files

**Example-based tests** (kiểm tra behavior cụ thể):
- `GET /` (authenticated) → 200, HTML chứa tất cả required DOM element IDs:
  - `#page-title`, `#status-badge`, `#status-text`, `#symbol-label`, `#wallet-addr`
  - `#tabnav-overview`, `#tabnav-analytics`
  - `#tabpanel-overview`, `#tabpanel-analytics`
  - `#pnl-value`, `#vol-value`, `#log-console`, `#trades-body`, `#events-body`
  - `#an-winrate`, `#an-avgpnl`, `#an-total`, `#an-fees`
  - `#an-chart-direction`, `#an-chart-regime`, `#an-chart-confidence`, `#an-chart-hour`
  - `#cfg-overlay`, `#cfg-ORDER_SIZE_MIN`, `#cfg-FARM_TP_USD`
- `GET /` (authenticated) → HTML chứa `<link rel="stylesheet" href="/css/main.css"/>`
- `GET /` (authenticated) → HTML chứa `<script src="https://cdn.jsdelivr.net/npm/chart.js`
- `GET /` (authenticated) → HTML chứa `<script src="/js/dashboard.js"></script>` trước `</body>`
- `GET /` (unauthenticated) → 200, HTML chứa login form (`#pc`, `#err`)
- Render error → HTTP 500 với error message
- Views directory missing → `process.exit(1)` được gọi

**Existing tests không bị break**:
- `src/dashboard/server.test.ts` và `src/dashboard/config-routes.test.ts` phải tiếp tục pass
- Tất cả API route tests giữ nguyên

### Test File Location

```
src/dashboard/__tests__/
├── partials-structure.test.ts   # smoke tests: file existence, no inline CSS/JS
└── partials-render.test.ts      # example tests: rendered HTML content
```
