# SoSoValue Deep Integration — Hackathon Specs

## Mục tiêu

Tích hợp toàn diện hệ sinh thái SoSoValue vào DRIFT để:
1. Đáp ứng yêu cầu bắt buộc: *"Must genuinely integrate SoSoValue API"*
2. Tối đa điểm bonus: ETF flows, AI-enhanced signals, risk control, complete flow
3. Tạo demo ấn tượng: dashboard panel hiển thị live data từ SoSoValue

## Vấn đề hiện tại

`SoSoValueClient.ts` gọi endpoint `/analysis/fear-greed` trả 404 → fallback sang
`alternative.me`. Judges từ SoSoValue sẽ nhận ra ngay đây không phải genuine integration.

## 4 Specs theo thứ tự ưu tiên

| # | Spec | Thời gian | Impact |
|---|------|-----------|--------|
| 01 | [Fear & Greed Fix](spec-01-fear-greed-fix.md) | 1-2h | Bắt buộc — genuine API |
| 02 | [ETF Flow Signal](spec-02-etf-flow-signal.md) | 2-3h | Cao nhất — unique data |
| 03 | [Macro Event Guard](spec-03-macro-event-guard.md) | 2h | Bonus — risk control |
| 04 | [Dashboard Panel](spec-04-dashboard-panel.md) | 3-4h | Bonus — UX + demo |

## Kiến trúc tổng thể sau khi hoàn thành

```
SoSoValue API
├── /analyses/{chart}     → Fear & Greed Index (real-time)
├── /etfs/summary-history → BTC ETF Net Inflow (daily)
├── /macro/events         → Macro Calendar (FOMC, CPI, NFP)
└── /news/hot             → Hot News Headlines (dashboard only)

SoSoValueClient (enhanced)
├── fetchFearGreed()      → F&G từ /analyses
├── fetchEtfFlow()        → ETF inflow từ /etfs
├── fetchMacroEvents()    → Events từ /macro
└── fetchHotNews()        → News từ /news/hot

SoSoValueStrategy (enhanced)
├── computeStrategyAdjustment(fearGreed, etfFlow, macroRisk)
└── → confidenceMultiplier, sizeMultiplier, macroGuard

Watcher (enhanced)
├── Fetch 3 signals parallel (F&G + ETF + Macro)
├── Apply combined strategy adjustment
└── Log all 3 dimensions vào TradeRecord

Dashboard Panel (new)
├── GET /api/sosovalue/snapshot → aggregated data
└── manager.ejs → SoSoValue panel widget
```

## Judging criteria mapping

| Criteria | Weight | Spec đáp ứng |
|----------|--------|--------------|
| User Value & Practical Impact | 30% | 01+02+03: bot thực sự thông minh hơn |
| Functionality & Working Demo | 25% | 04: panel live + bot chạy thật |
| Logic, Workflow & Product Design | 20% | 01+02+03: complete signal pipeline |
| Data / API Integration | 15% | 01+02+03+04: 4 endpoints thật |
| UX & Clarity | 10% | 04: dashboard panel rõ ràng |
