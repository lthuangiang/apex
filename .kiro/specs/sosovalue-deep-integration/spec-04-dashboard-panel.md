# Spec 04 — SoSoValue Dashboard Panel

## Mục tiêu

Thêm panel "Market Intelligence" vào dashboard manager hiển thị live data từ
SoSoValue API. Panel này là bằng chứng trực quan nhất cho judges thấy genuine integration.

## Layout

```
┌─────────────────────────────────────────────────────────────┐
│  SOSOVALUE MARKET INTELLIGENCE              [source: live]  │
├──────────────┬──────────────┬──────────────┬────────────────┤
│  FEAR & GREED│  BTC ETF     │  MACRO RISK  │  HOT NEWS      │
│              │  FLOW        │              │                │
│    [gauge]   │  +$1.2B      │  ● NONE      │ • Headline 1   │
│   72 GREED   │  today       │              │ • Headline 2   │
│              │  3d: +$2.8B  │  Next: CPI   │ • Headline 3   │
│  source:     │  signal:     │  in 3 days   │                │
│  sosovalue   │  strong_bull │              │                │
└──────────────┴──────────────┴──────────────┴────────────────┘
```

## Files thay đổi

- `src/dashboard/server.ts` — thêm `GET /api/sosovalue/snapshot`
- `src/dashboard/views/manager.ejs` — thêm panel widget + JS polling

## API endpoint mới

```
GET /api/sosovalue/snapshot
→ {
    fearGreed: { index: number, label: string, source: string },
    etfFlow: { netInflowToday: number, signal: string } | null,
    macroRisk: { riskLevel: string, events: MacroEvent[] } | null,
    hotNews: { title: string, url: string }[] | null,
    fetchedAt: string  // ISO timestamp
  }
```

Server-side cache 5 phút để tránh rate limit (20 req/min).

## News endpoint

```
GET /news/hot?page=1&page_size=5&language=en
→ Lấy 5 tin hot nhất
→ Chỉ dùng cho display, không ảnh hưởng trading logic
```

## Dashboard widget spec

### Màu sắc Fear & Greed gauge

```
< 25  → đỏ đậm  (#e8404a)  "Extreme Fear"
25-45 → cam     (#f5a623)  "Fear"
45-55 → vàng    (#f5d623)  "Neutral"
55-75 → xanh lá (#1db954)  "Greed"
> 75  → xanh đậm (#0d9e3e) "Extreme Greed"
```

### ETF Flow display

```
> 0   → xanh + prefix "+"
< 0   → đỏ + prefix "-"
Format: "$1.2B" (billions), "$450M" (millions)
```

### Macro Risk indicator

```
none     → ● xanh  "No major events"
elevated → ● vàng  "CPI in 2 days"
high     → ● đỏ    "FOMC TODAY — reduced exposure"
```

### Polling

```javascript
// Refresh mỗi 5 phút (match server cache TTL)
setInterval(refreshSoSoPanel, 5 * 60 * 1000);
// Refresh ngay khi load trang
refreshSoSoPanel();
```

## Acceptance criteria

- [ ] Panel hiển thị trong manager view (không phải bot detail)
- [ ] Tất cả 4 sections hiển thị đúng data
- [ ] Source badge hiển thị "sosovalue" hoặc "alternative.me"
- [ ] Màu sắc đúng theo trạng thái
- [ ] Graceful loading state khi đang fetch
- [ ] Graceful error state khi API lỗi (không crash trang)
- [ ] Responsive trên mobile
- [ ] Không block render trang (async fetch)

## Demo value

Panel này là điểm nhấn trong demo video:
1. Mở dashboard → thấy ngay SoSoValue data live
2. Giải thích: "Bot đang ở Greed mode, ETF inflow +$1.2B → strategy cautious"
3. Judges thấy complete flow: data → insight → action
