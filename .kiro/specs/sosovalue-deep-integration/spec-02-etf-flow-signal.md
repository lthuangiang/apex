# Spec 02 — ETF Flow Signal

## Mục tiêu

Tích hợp BTC ETF net inflow từ SoSoValue làm signal thứ 2 (bên cạnh Fear & Greed).
ETF inflow là data **độc quyền của SoSoValue** — không có trên alternative.me hay Binance.

## Tại sao ETF Flow quan trọng

- Inflow dương lớn (>500M USD/ngày) → tổ chức đang mua → bullish leading indicator
- Inflow âm liên tiếp 3 ngày → tổ chức rút tiền → bearish warning
- Correlation với BTC price cao hơn F&G vì phản ánh dòng tiền thực, không phải sentiment

## Endpoint dùng

```
GET /etfs/summary-history?symbol=BTC&limit=3
→ 3 ngày gần nhất: net_inflow (USD), total_assets, volume
```

## Files thay đổi

- `src/ai/SoSoValueClient.ts` — thêm `fetchEtfFlow()`
- `src/ai/SoSoValueStrategy.ts` — thêm dimension ETF vào `computeStrategyAdjustment()`
- `src/ai/TradeLogger.ts` — thêm fields `etfNetInflow`, `etfFlowSignal`
- `src/modules/Watcher.ts` — fetch ETF parallel với F&G

## Interface mới

```typescript
export interface EtfFlowData {
  btcNetInflow3d: number;    // Tổng net inflow 3 ngày (USD)
  btcNetInflowToday: number; // Net inflow hôm nay (USD)
  signal: 'strong_bull' | 'bull' | 'neutral' | 'bear' | 'strong_bear';
}

// Trong SoSoValueClient:
async fetchEtfFlow(): Promise<EtfFlowData | null>
```

## Logic phân loại ETF signal

```
btcNetInflowToday > 500M  → strong_bull  (+15% size, -10% threshold)
btcNetInflowToday > 100M  → bull         (+8% size, -5% threshold)
-100M < inflow < 100M     → neutral      (no change)
btcNetInflowToday < -100M → bear         (-10% size, +10% threshold)
btcNetInflowToday < -300M → strong_bear  (-20% size, +20% threshold)

Override: nếu 3 ngày liên tiếp âm → force bear bất kể hôm nay
```

## Kết hợp F&G + ETF trong strategy

```typescript
// SoSoValueStrategy.ts
export function computeStrategyAdjustment(
  fearGreedIndex: number,
  etfFlow?: EtfFlowData,
): StrategyAdjustment {
  const fgAdj = computeFGAdjustment(fearGreedIndex);
  const etfAdj = etfFlow ? computeEtfAdjustment(etfFlow) : { sizeMult: 1.0, confMult: 1.0 };

  // Combine: geometric mean để tránh extreme compounding
  return {
    sizeMultiplier: Math.sqrt(fgAdj.sizeMultiplier * etfAdj.sizeMult),
    confidenceMultiplier: Math.sqrt(fgAdj.confidenceMultiplier * etfAdj.confMult),
    mode: fgAdj.mode,
    description: `${fgAdj.description} | ETF: ${etfFlow?.signal ?? 'n/a'}`,
    etfSignal: etfFlow?.signal,
  };
}
```

## TradeRecord fields mới

```typescript
etfNetInflowUsd?: number;   // Net inflow hôm nay (USD)
etfFlowSignal?: string;     // 'strong_bull' | 'bull' | 'neutral' | 'bear' | 'strong_bear'
```

## Acceptance criteria

- [ ] `fetchEtfFlow()` trả về data từ SoSoValue API thật
- [ ] ETF signal được log vào mỗi TradeRecord
- [ ] `computeStrategyAdjustment()` nhận optional `etfFlow` param
- [ ] Khi ETF API lỗi: graceful fallback (chỉ dùng F&G, không crash)
- [ ] Console log rõ: `[SoSoValue] ETF BTC inflow today: +$1.2B → strong_bull`
