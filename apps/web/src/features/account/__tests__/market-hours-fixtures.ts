import type { MarketHoursView } from "@drift/shared";

// Một view Market hours đầy đủ cho test component và test bố cục (layout-tests/market-hours.layout.ts).
export function view(over: Partial<MarketHoursView> = {}): MarketHoursView {
  return {
    market: "BTC-USD",
    markets: ["BTC-USD", "ETH-USD"],
    days: 30,
    strategy: "both",
    tz: "Asia/Kolkata",
    hours: Array.from({ length: 24 }, (_, h) => ({
      hour: h,
      volatility: {
        medianBp: h === 3 ? null : "4.25",
        p90Bp: h === 3 ? null : "9.1",
        ratio: h === 3 ? null : h === 20 ? "2.4" : "1",
        hotPct: h === 3 ? null : h === 20 ? 60 : 0,
        fiveMin: Array.from({ length: 12 }, () => "4.2"),
        swingBp: h === 3 ? null : h === 21 ? "12.43" : "4.1",
        estCostPerMillion: h === 3 ? null : h === 21 ? "214.37" : "88.5",
        // "incl. shock days": giờ 21 có 9 / 30 ngày sốc → trung bình cao hơn ngày điển hình.
        estShockCostPerMillion: h === 3 ? null : h === 21 ? "336.1" : "95.25",
        // "calibrated" = "incl. shock days" × 1.42.
        estCalibratedCostPerMillion: h === 3 ? null : h === 21 ? "477.26" : "135.26",
        estDays: h === 3 ? null : 30,
        shockDays: h === 3 ? null : h === 21 ? 9 : 1,
        // Giờ 08 (Kolkata): một phút 133 bp và chuỗi 15 phút 276 bp (bắt đầu 08:57 Kolkata = 03:27 UTC).
        maxRangeBp: h === 3 ? null : h === 8 ? "133.24" : "8.5",
        maxRangeAt:
          h === 3 ? null : h === 8 ? "2026-11-15T03:31:00.000Z" : "2026-11-14T00:00:00.000Z",
        maxMove15Bp: h === 3 ? null : h === 8 ? "276.43" : "30.2",
        maxMove15At:
          h === 3 ? null : h === 8 ? "2026-11-15T03:27:00.000Z" : "2026-11-14T00:00:00.000Z",
      },
      cost: { markoutBp: h === 3 ? null : "-1.2", spreadTicks: h === 3 ? null : 1.5 },
      bots:
        h === 3
          ? { costPerMillion: null, volume: null, fees: null, botHours: 0, thin: false }
          : {
              costPerMillion: "150",
              volume: "73000",
              fees: h === 5 ? "0.3125" : "10.2",
              botHours: h === 4 ? 2 : 8,
              thin: h === 4,
            },
    })),
    heatmap: [
      {
        date: "2026-11-15",
        cells: Array.from({ length: 24 }, (_, h) => ({
          ratio: h === 3 ? null : "1",
          medianBp: h === 3 ? null : "4.2",
        })),
      },
    ],
    candlesSince: "2026-10-02T00:00:00.000Z",
    markoutSince: "2026-11-12T00:00:00.000Z",
    markoutDays: 4,
    fillsSince: "2026-10-20T00:00:00.000Z",
    estimate: {
      feesBp: "0.7",
      stepBp: "1.02",
      modelVersion: 3,
      unavailable: null,
      shockBp: 15,
      cutTakerBp: "4",
      cutSlippageBp: null,
      cutCostBp: "4",
      cuts: 2,
      cutNotional: null,
      // Chưa đủ lệnh cắt thật: cỡ cắt = R (2×) × order size, volume một bot-hour = 34.9× order size → 5.7%.
      positionRatio: "2.04",
      positionRatioSource: "market",
      fillsPerBotHour: "34.9",
      cutShare: "0.0573",
      cutScope: { source: "market", botHours: 37, marketBotHours: 37, markets: [] },
      calibration: "1.42",
      calibrationScope: { source: "market", botHours: 37, marketBotHours: 37, markets: [] },
      calibrationHours: 18,
    },
    ...over,
  };
}
