import { Decimal } from "@drift/shared";
import type { MmOrderContext } from "@drift/shared/mm-quote";
import type { VbSignalSnapshot } from "@drift/shared/vb-signal";
import { describe, expect, it } from "vitest";

import type { BotInfo } from "./common";
import { localClock, quantileOf } from "./common";
import type { FillRow } from "./data";
import { clampOf, walkInventory, type MmX } from "./mm";
import { exitReasonOf, leadOf, scoreOf } from "./vb";

// Hàm thuần của Signal Analysis (#233): lý do thoát, phần dẫn điểm, Binance clamp, đi lại tồn kho, giờ địa phương.

const ctx = (over: Partial<MmOrderContext>): MmOrderContext => ({
  v: 1,
  reason: "refresh",
  mid: "100",
  bid: "99.99",
  ask: "100.01",
  fair: "100",
  fairAgeMs: 100,
  level: 0,
  bp: -1,
  fairBp: -0.5,
  pos: "0",
  smart: true,
  sig: null,
  fastPause: false,
  ...over,
});

describe("signal analysis helpers", () => {
  it("reads the exit reason from the bot's Closed line", () => {
    expect(exitReasonOf("Hold time 62 s ended (PnL −0.20)", false)).toBe("hold");
    expect(exitReasonOf("Take profit: 0.02 ≥ 0.01", false)).toBe("takeProfit");
    expect(exitReasonOf("Stop loss on SoDEX at 100", false)).toBe("stopOnSodex");
    expect(exitReasonOf("Stop loss 2% of margin at 99", false)).toBe("stopLoss");
    expect(exitReasonOf("Exit filled", false)).toBe("other");
    expect(exitReasonOf(null, true)).toBe("stopOnSodex");
    expect(exitReasonOf(null, false)).toBeNull();
  });

  it("finds the part that added the most in the signal's direction", () => {
    const s = (direction: "long" | "short", c: Partial<VbSignalSnapshot["components"]>) =>
      ({
        direction,
        score: direction === "long" ? 0.62 : 0.38,
        components: {
          candleMomentum: 0.5,
          wickRejection: 0.5,
          volumeAcceleration: 0.5,
          tradePressure: 0.5,
          orderbookImbalance: 0.5,
          ...c,
        },
      }) as VbSignalSnapshot;
    expect(leadOf(s("long", { wickRejection: 0.9, candleMomentum: 0.6 }))).toBe("wick");
    expect(leadOf(s("short", { candleMomentum: 0.1, volumeAcceleration: 0.2 }))).toBe("momentum");
    expect(leadOf(s("long", {}))).toBeNull();
    expect(scoreOf(s("short", {}))).toBeCloseTo(62);
  });

  it("marks a Binance clamp only when an open quote sits at the limit", () => {
    expect(clampOf("buy", ctx({ fairBp: -0.5 }), false)).toBe("hit");
    expect(clampOf("sell", ctx({ fairBp: 0.6 }), false)).toBe("hit");
    expect(clampOf("buy", ctx({ fairBp: -2 }), false)).toBe("normal");
    // Giá Binance cũ (> 1,5 s) không kẹp.
    expect(clampOf("buy", ctx({ fairBp: -0.5, fairAgeMs: 5_000 }), false)).toBe("normal");
    expect(clampOf("buy", ctx({ smart: false }), false)).toBeNull();
    expect(clampOf("buy", ctx({}), true)).toBeNull();
    expect(clampOf("buy", null, false)).toBeNull();
  });

  it("walks inventory: time flat, average position in orders and the result of a cut", () => {
    const bot: BotInfo = {
      id: "b",
      name: "BTC maker",
      market: "BTC-USD",
      strategy: "volume_maker",
      userId: "u",
      config: { orderSize: "100" },
    };
    const x = (
      at: number,
      side: "buy" | "sell",
      price: string,
      tag = "vm:1:open",
      fee = "0.01",
    ): MmX =>
      ({
        f: {
          id: `f${String(at)}`,
          orderId: `o${String(at)}`,
          at,
          createdAt: at,
          side,
          price,
          size: "1",
          fee,
          tag,
        } as FillRow,
        bot,
        dir: side === "buy" ? 1 : -1,
        kind: tag.includes(":cut:") ? "cut" : "quote",
      }) as MmX;
    // Phẳng 0–10 s, giữ 1 lệnh (100 USDC ÷ order size 100) 10–40 s, cắt lúc 40 s ở 98.5 (lỗ 1.5 + phí 0.2).
    const r = walkInventory(
      [
        x(0, "buy", "100"),
        x(0, "sell", "100"),
        x(10_000, "buy", "100"),
        x(40_000, "sell", "98.5", "vm:1:cut:close", "0.2"),
      ],
      new Map([["b", new Decimal(0)]]),
    );
    expect(r.timeFlatPct).toBeCloseTo(25);
    expect(r.avgPositionOrders).toBeCloseTo(1);
    expect(r.cuts).toHaveLength(1);
    expect(r.cuts[0]?.result?.toString()).toBe("-1.7");
    expect(r.cuts[0]?.heldSecs).toBe(30);
    expect(r.cuts[0]?.position).toBe("long");
  });

  it("uses the viewer's local hour, including half-hour zones", () => {
    const at = Date.parse("2026-11-18T10:00:00Z");
    expect(localClock("UTC")(at).hour).toBe(10);
    expect(localClock("Asia/Kolkata")(at)).toMatchObject({ hour: 15, day: "2026-11-18" });
    expect(localClock("America/New_York")(Date.parse("2026-11-18T03:00:00Z")).day).toBe(
      "2026-11-17",
    );
  });

  it("interpolates quantiles and ignores missing values", () => {
    expect(quantileOf([1, null, 3, 2], 0.5)).toBe(2);
    expect(quantileOf([null], 0.5)).toBeNull();
  });
});
