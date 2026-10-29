import { describe, expect, it } from "vitest";

import { analyzeAccount, holdingBucket, type AccountAnalysisInput } from "../account";

const H = 3_600_000;
const T0 = 1_790_000_000_000;

// Fixture tính tay (DEC-34):
// Perps
//   P1 BTC LONG 10×  60000 → 61000, size 0.1, phí 3, giữ 2h  → gross +100, net +97
//   P2 BTC SHORT 20× 61000 → 62000, size 0.05, phí 2, giữ 10m → gross −50,  net −52
//   P3 ETH LONG 2×   3000 → 2900,  size 1,   phí 1, giữ 3d  → gross −100, net −101
//   Funding: BTC trả 4, ETH nhận 1 → netFunding = 3
// Spot (vBTC_vUSDC)
//   BUY 0.2 @ 50000 phí 10 (t0), BUY 0.2 @ 52000 phí 10 (t0+1h)
//   SELL 0.3 @ 55000 phí 16.5 (t0+5h): FIFO 0.2@50000 + 0.1@52000
//     gross = 0.2×5000 + 0.1×3000 = 1300; phí mua phân bổ = 10 + 5 = 15; net = 1300 − 15 − 16.5 = 1268.5
//     giữ = (0.2×5h + 0.1×4h)/0.3 = 4h40m → bucket 4h–1d
//   SELL 0.2 @ 54000 phí 10.8 (t0+6h): còn 0.1 lô 52000 → ghép 0.1, 0.1 không ghép được
//     gross = 0.1×2000 = 200; phí = 5 (mua) + 10.8×0.5 = 10.4; net = 189.6; giữ 5h
// Tổng: gross = 100 − 50 − 100 + 1300 + 200 = 1450
//       phí   = 3 + 2 + 1 + 31.5 + 10.4 = 47.9
//       net   = 1450 − 47.9 − 3 = 1399.1
//       thắng 3/5 (P1, S1, S2)
const input: AccountAnalysisInput = {
  perpsPositions: [
    {
      market: "BTC-USD",
      side: "LONG",
      entryPrice: "60000",
      closePrice: "61000",
      closedSize: "0.1",
      fees: "3",
      leverage: 10,
      openedAt: T0,
      closedAt: T0 + 2 * H,
    },
    {
      market: "BTC-USD",
      side: "SHORT",
      entryPrice: "61000",
      closePrice: "62000",
      closedSize: "0.05",
      fees: "2",
      leverage: 20,
      openedAt: T0 + 3 * H,
      closedAt: T0 + 3 * H + 600_000,
    },
    {
      market: "ETH-USD",
      side: "LONG",
      entryPrice: "3000",
      closePrice: "2900",
      closedSize: "1",
      fees: "1",
      leverage: 2,
      openedAt: T0,
      closedAt: T0 + 72 * H,
    },
  ],
  perpsFundings: [
    { market: "BTC-USD", amount: "4", at: T0 + H },
    { market: "ETH-USD", amount: "-1", at: T0 + 8 * H },
  ],
  perpsFills: [
    {
      market: "BTC-USD",
      side: "BUY",
      price: "60000",
      quantity: "0.1",
      feeQuote: "1.5",
      isMaker: true,
      at: T0,
    },
    {
      market: "BTC-USD",
      side: "SELL",
      price: "61000",
      quantity: "0.1",
      feeQuote: "1.5",
      isMaker: false,
      at: T0 + 2 * H,
    },
  ],
  spotFills: [
    {
      market: "vBTC_vUSDC",
      side: "BUY",
      price: "50000",
      quantity: "0.2",
      feeQuote: "10",
      isMaker: true,
      at: T0,
    },
    {
      market: "vBTC_vUSDC",
      side: "BUY",
      price: "52000",
      quantity: "0.2",
      feeQuote: "10",
      isMaker: true,
      at: T0 + H,
    },
    {
      market: "vBTC_vUSDC",
      side: "SELL",
      price: "55000",
      quantity: "0.3",
      feeQuote: "16.5",
      isMaker: false,
      at: T0 + 5 * H,
    },
    {
      market: "vBTC_vUSDC",
      side: "SELL",
      price: "54000",
      quantity: "0.2",
      feeQuote: "10.8",
      isMaker: null,
      at: T0 + 6 * H,
    },
  ],
  equity: "10000",
};

describe("analyzeAccount", () => {
  const m = analyzeAccount(input);

  it("matches the hand-computed totals", () => {
    expect(m.closedPositions).toBe(5);
    expect(m.grossRealizedPnl).toBe("1450");
    expect(m.fees).toBe("47.9");
    expect(m.netFunding).toBe("3");
    expect(m.netPnl).toBe("1399.1");
    expect(m.winRate).toBe("0.6");
    expect(m.isNewTrader).toBe(true);
    expect(m.hasPerpsHistory).toBe(true);
  });

  it("reports average win/loss and leverage", () => {
    // thắng: 97, 1268.5, 189.6 → 1555.1/3; thua: −52, −101 → −76.5 (P3 −101 là ETH, gross −100 phí 1)
    expect(Number(m.avgWin)).toBeCloseTo(1555.1 / 3, 10);
    expect(m.avgLoss).toBe("-76.5");
    expect(m.medianLeverage).toBe(10);
    expect(m.maxLeverage).toBe(20);
    expect(m.byMarket.find((x) => x.market === "BTC-USD")?.fees).toBe("5");
  });

  it("splits by market and holding time", () => {
    const btc = m.byMarket.find((x) => x.market === "BTC-USD");
    // 97 − 52 − funding 4 = 41
    expect(btc).toMatchObject({ closed: 2, netPnl: "41", winRate: "0.5" });
    expect(m.byMarket.find((x) => x.market === "ETH-USD")).toMatchObject({
      netPnl: "-100",
      winRate: "0",
    });
    expect(m.pnlByHolding["<15m"]).toEqual({ netPnl: "-52", closed: 1 });
    expect(m.pnlByHolding["15m–4h"]).toEqual({ netPnl: "97", closed: 1 });
    expect(m.pnlByHolding["4h–1d"]).toEqual({ netPnl: "1458.1", closed: 2 });
    expect(m.pnlByHolding["1–7d"]).toEqual({ netPnl: "-101", closed: 1 });
  });

  it("computes loss share by leverage on perps losses only", () => {
    // Lỗ: 52 (20×) + 101 (2×) = 153
    expect(Number(m.lossShareByLeverage?.["≥8x"])).toBeCloseTo(52 / 153, 12);
    expect(Number(m.lossShareByLeverage?.["<3x"])).toBeCloseTo(101 / 153, 12);
    expect(m.lossShareByLeverage?.["3–8x"]).toBe("0");
  });

  it("computes taker ratio only over fills with known maker flag", () => {
    // taker: 6100 (perps sell) + 16500 (spot sell 1) = 22600; known: 6000 + 6100 + 10000 + 10400 + 16500 = 49000
    expect(Number(m.takerRatio)).toBeCloseTo(22600 / 49000, 12);
  });

  it("reports unmatched spot sells instead of inventing a cost basis", () => {
    expect(m.unmatchedSpotSells).toEqual({ vBTC_vUSDC: "0.1" });
  });

  it("measures drawdown on the realized net curve against equity", () => {
    // Theo thời gian: +97 (2h)… chuỗi: −4 (1h), +97 (2h), −52 (3h10m), +1268.5 (5h), +189.6 (6h), +1 (8h), −101 (72h)
    // luỹ kế: −4, 93, 41, 1309.5, 1499.1, 1500.1 (đỉnh), 1399.1 → drawdown 101 (lớn hơn 52)
    expect(m.maxDrawdown).toBe("101");
    // Đỉnh tại 8h (funding nhận), đáy khi ETH đóng ở 72h.
    expect(m.drawdownFrom).toBe(T0 + 8 * H);
    expect(m.drawdownTo).toBe(T0 + 72 * H);
    expect(m.curve.at(-1)).toEqual({ at: T0 + 72 * H, cumulative: "1399.1" });
    // equity dựng lại: đầu kỳ 10000 − 1399.1 = 8600.9; đỉnh 8600.9 + 1500.1 = 10101; đáy sau đó 10000
    expect(Number(m.maxDrawdownPct)).toBeCloseTo(101 / 10101, 15);
  });

  it("returns no rates instead of zero when there is no history", () => {
    const empty = analyzeAccount({
      perpsPositions: [],
      perpsFundings: [],
      perpsFills: [],
      spotFills: [],
      equity: null,
    });
    expect(empty.winRate).toBeNull();
    expect(empty.takerRatio).toBeNull();
    expect(empty.maxDrawdownPct).toBeNull();
    expect(empty.periodStart).toBeNull();
    expect(empty.lossShareByLeverage).toBeNull();
  });

  it("buckets holding times at the documented edges", () => {
    expect(holdingBucket(15 * 60_000 - 1)).toBe("<15m");
    expect(holdingBucket(15 * 60_000)).toBe("15m–4h");
    expect(holdingBucket(7 * 24 * H)).toBe(">7d");
  });
});
