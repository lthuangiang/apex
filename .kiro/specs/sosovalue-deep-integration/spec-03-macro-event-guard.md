# Spec 03 — Macro Event Guard

## Mục tiêu

Tự động phát hiện các sự kiện macro lớn (FOMC, CPI, NFP, PCE) sắp diễn ra và
giảm risk exposure của bot trước/trong thời điểm đó.

## Tại sao cần Macro Guard

- FOMC, CPI, NFP thường gây biến động đột ngột ±3-5% trong vài phút
- Bot farm/trade mode không có edge trong môi trường này — chỉ có rủi ro
- Đây là điểm **"Risk control, confirmation mechanisms"** trong bonus criteria

## Endpoint dùng

```
GET /macro/events
→ Array<{ date: string, events: string[] }>
→ Lọc events hôm nay và ngày mai
→ Detect keywords: FOMC, CPI, NFP, PCE, GDP, PPI, Payroll
```

## Files thay đổi

- `src/ai/SoSoValueClient.ts` — thêm `fetchMacroEvents()`
- `src/ai/SoSoValueStrategy.ts` — thêm `MacroRisk` type + logic
- `src/ai/TradeLogger.ts` — thêm field `macroGuard`
- `src/modules/Watcher.ts` — fetch macro parallel, apply guard

## Interface mới

```typescript
export interface MacroEvent {
  date: string;       // YYYY-MM-DD
  name: string;       // "FOMC Meeting", "CPI Release", etc.
  impact: 'high' | 'medium' | 'low';
}

export interface MacroRisk {
  hasHighImpactToday: boolean;
  hasHighImpactTomorrow: boolean;
  events: MacroEvent[];
  riskLevel: 'none' | 'elevated' | 'high';
  sizeMultiplier: number;      // 0.3 - 1.0
  confidenceMultiplier: number; // 1.0 - 2.0
  reason: string;
}

// Trong SoSoValueClient:
async fetchMacroEvents(): Promise<MacroRisk>
```

## Logic phân loại risk

```
HIGH IMPACT keywords: FOMC, Federal Reserve, CPI, NFP, Non-Farm, PCE, GDP, PPI
MEDIUM IMPACT keywords: Jobless Claims, Retail Sales, PMI, ISM

Nếu HIGH IMPACT hôm nay:
  → sizeMultiplier = 0.3, confidenceMultiplier = 2.0
  → riskLevel = 'high'
  → Log: "[MacroGuard] HIGH RISK: FOMC today — size reduced to 30%"

Nếu HIGH IMPACT ngày mai:
  → sizeMultiplier = 0.6, confidenceMultiplier = 1.5
  → riskLevel = 'elevated'
  → Log: "[MacroGuard] ELEVATED: CPI tomorrow — size reduced to 60%"

Nếu không có event quan trọng:
  → sizeMultiplier = 1.0, confidenceMultiplier = 1.0
  → riskLevel = 'none'
```

## Kết hợp 3 signals trong strategy

```typescript
// SoSoValueStrategy.ts — final combined adjustment
export function computeStrategyAdjustment(
  fearGreedIndex: number,
  etfFlow?: EtfFlowData,
  macroRisk?: MacroRisk,
): StrategyAdjustment {
  const fg = computeFGAdjustment(fearGreedIndex);
  const etf = etfFlow ? computeEtfAdjustment(etfFlow) : { size: 1.0, conf: 1.0 };
  const macro = macroRisk ?? { sizeMultiplier: 1.0, confidenceMultiplier: 1.0 };

  // Macro guard là hard cap — override F&G và ETF nếu risk cao
  const finalSize = macro.riskLevel === 'high'
    ? macro.sizeMultiplier  // Hard cap: macro wins
    : Math.sqrt(fg.sizeMultiplier * etf.size) * macro.sizeMultiplier;

  const finalConf = macro.riskLevel === 'high'
    ? macro.confidenceMultiplier  // Hard cap
    : Math.sqrt(fg.confidenceMultiplier * etf.conf) * macro.confidenceMultiplier;

  return {
    sizeMultiplier: Math.max(0.2, Math.min(1.3, finalSize)),
    confidenceMultiplier: Math.max(0.8, Math.min(2.5, finalConf)),
    mode: fg.mode,
    macroRiskLevel: macro.riskLevel,
    description: `F&G:${fearGreedIndex} | ETF:${etfFlow?.signal ?? 'n/a'} | Macro:${macro.riskLevel}`,
  };
}
```

## TradeRecord field mới

```typescript
macroGuard?: string;  // 'none' | 'elevated:CPI_TOMORROW' | 'high:FOMC_TODAY'
```

## Acceptance criteria

- [ ] `fetchMacroEvents()` gọi SoSoValue API thật
- [ ] Detect đúng HIGH/MEDIUM impact events
- [ ] Macro guard là hard cap — không bị F&G hay ETF override khi `riskLevel === 'high'`
- [ ] Log rõ ràng khi guard kích hoạt
- [ ] Graceful fallback khi API lỗi: `riskLevel = 'none'` (không crash bot)
- [ ] `macroGuard` được log vào TradeRecord

## Cache strategy

Macro events thay đổi theo ngày, không theo phút. Cache 1 giờ là đủ:
```typescript
private _macroCache: { data: MacroRisk; fetchedAt: number } | null = null;
private MACRO_CACHE_TTL = 60 * 60 * 1000; // 1 hour
```
