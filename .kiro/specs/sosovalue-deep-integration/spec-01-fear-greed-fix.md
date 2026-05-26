# Spec 01 — Fear & Greed Fix (Genuine SoSoValue API)

## Vấn đề

`SoSoValueClient.ts` hiện gọi endpoint `/analysis/fear-greed` → trả 404 → fallback
sang `alternative.me`. Đây **không phải** genuine SoSoValue integration.

Endpoint đúng theo docs:
- `GET /analyses` → list tất cả chart names + field definitions
- `GET /analyses/{chart_name}?limit=1` → time-series data của chart đó

## Mục tiêu

- Fetch Fear & Greed Index từ SoSoValue API thật
- Tự động discover chart name (không hardcode, phòng API thay đổi)
- Cache chart name để tránh gọi `/analyses` mỗi lần
- Giữ alternative.me làm fallback khi không có API key hoặc API lỗi
- Expose thêm `fetchRawCharts()` để các spec sau dùng

## Files thay đổi

- `src/ai/SoSoValueClient.ts` — rewrite hoàn toàn

## Interface sau khi xong

```typescript
export interface SoSoValueData {
  sectorIndex: number;
  fearGreedIndex: number;
  fearGreedLabel: string;
  source: 'sosovalue' | 'alternative.me';  // NEW: track nguồn data
}

export interface SoSoChartMeta {
  name: string;
  fields: string[];
}

export class SoSoValueClient {
  // Existing — giữ nguyên signature
  async fetch(): Promise<SoSoValueData | null>

  // NEW — list available charts (dùng cho spec-02, spec-03)
  async listCharts(): Promise<SoSoChartMeta[]>

  // NEW — fetch bất kỳ chart nào theo name
  async fetchChart(chartName: string, limit?: number): Promise<Record<string, unknown>[] | null>
}
```

## Logic chi tiết

### Bước 1: Discover chart name (cached)

```
GET /analyses
→ Array<{ name: string, time_field: string, fields: [...] }>
→ Tìm entry có name chứa "fear" hoặc "greed" (case-insensitive)
→ Cache tên chart vào _fearGreedChartName (in-memory, reset khi restart)
```

### Bước 2: Fetch data

```
GET /analyses/{_fearGreedChartName}?limit=1
→ Array<{ [time_field]: number, value?: number, index?: number, ... }>
→ Parse field đầu tiên không phải time field làm fearGreedIndex
→ Map sang label: <25 Extreme Fear, 25-45 Fear, 45-55 Neutral, 55-75 Greed, >75 Extreme Greed
```

### Bước 3: Fallback chain

```
1. Nếu không có SOSOVALUE_API_KEY → alternative.me (log warning)
2. Nếu /analyses trả lỗi → alternative.me (log error)
3. Nếu không tìm thấy fear/greed chart → alternative.me (log warning)
4. Nếu /analyses/{name} trả lỗi → alternative.me (log error)
5. Nếu alternative.me lỗi → return null
```

### Bước 4: source field

Thêm `source: 'sosovalue' | 'alternative.me'` vào `SoSoValueData` để:
- Log rõ nguồn data trong console
- Hiển thị trong dashboard panel (spec-04)
- Judges có thể verify genuine integration

## Acceptance criteria

- [ ] Khi có `SOSOVALUE_API_KEY` hợp lệ: `source === 'sosovalue'`
- [ ] Khi không có API key: `source === 'alternative.me'` + log warning
- [ ] Chart name được cache sau lần gọi đầu tiên
- [ ] `listCharts()` trả về array chart names
- [ ] `fetchChart(name)` trả về raw time-series data
- [ ] Không break existing callers (Watcher.ts, AISignalEngine.ts)
- [ ] TypeScript compile không lỗi

## Test thủ công

```bash
# Set API key rồi chạy
SOSOVALUE_API_KEY=xxx npx tsx -e "
import { SoSoValueClient } from './src/ai/SoSoValueClient.js';
const c = new SoSoValueClient();
console.log(await c.fetch());
console.log(await c.listCharts());
"
```
