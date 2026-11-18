import { Decimal } from "@drift/shared";
import type { MmOrderContext } from "@drift/shared/mm-quote";
import type { VbSignalSnapshot } from "@drift/shared/vb-signal";
import { describe, expect, it } from "vitest";

import { botFacets } from "./all";
import {
  costBasisOf,
  ledgerStep,
  localClock,
  quantileOf,
  type BotInfo,
  type Ledger,
} from "./common";
import { costOf } from "./data";
import { clampOf, inventoryOf, mmSuggestions, walkLedger } from "./mm";
import { exitReasonOf, leadOf, oppositeOf, scoreOf, vbSuggestions, type Trade } from "./vb";

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
    // Trade pressure (15%) có thể dẫn điểm.
    expect(leadOf(s("long", { tradePressure: 0.9, orderbookImbalance: 0.9 }))).toBe("trade");
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

  it("finds the cost basis and open time of a position carried in from before the period", () => {
    // Mới nhất trước: trước kỳ bot mua 1 @ 100 (mở, phẳng trước đó), mua 1 @ 102, bán 1 @ 105 (giảm, giữ giá vào).
    const desc = [
      { at: 3_000, side: "sell" as const, price: "105", size: "1" },
      { at: 2_000, side: "buy" as const, price: "102", size: "1" },
      { at: 1_000, side: "buy" as const, price: "100", size: "1" },
      { at: 500, side: "sell" as const, price: "90", size: "1" },
      { at: 400, side: "buy" as const, price: "90", size: "1" },
    ];
    const b = costBasisOf(desc, new Decimal(1));
    expect(b?.entry.toString()).toBe("101");
    expect(b?.openedAt).toBe(1_000);
    // Đổi chiều: short 1 @ 110 từ long 1 → giá vào = giá khớp, mở lúc đổi chiều.
    const flip = costBasisOf(
      [{ at: 5_000, side: "sell" as const, price: "110", size: "2" }, ...desc.slice(2)],
      new Decimal(-1),
    );
    expect(flip).toMatchObject({ openedAt: 5_000 });
    expect(flip?.entry.toString()).toBe("110");
    // Không thấy lúc mở trong phần lịch sử đọc được → Not available (không lấy giá fill đầu kỳ).
    expect(costBasisOf(desc.slice(0, 2), new Decimal(1))).toBeNull();
  });

  it("average-cost ledger: a partial close keeps the entry; the next add averages against what is left", () => {
    const l = (steps: ["buy" | "sell", string, string][]) =>
      steps.reduce<Ledger>(
        (x, [side, size, price], i) =>
          ledgerStep(x, side, new Decimal(size), new Decimal(price), i),
        { pos: new Decimal(0), entry: null, openedAt: null },
      );
    // buy 1 @ 100, sell 0.5, buy 1 @ 110 → (0.5 × 100 + 1 × 110) ÷ 1.5 = 106.67.
    const a = l([
      ["buy", "1", "100"],
      ["sell", "0.5", "105"],
      ["buy", "1", "110"],
    ]);
    expect(a.entry?.toDecimalPlaces(2).toString()).toBe("106.67");
    expect(a.openedAt).toBe(0);
    // Partial close, then through zero: the flip opens a new position at the fill price, at the flip time.
    const b = l([
      ["buy", "1", "100"],
      ["sell", "0.5", "105"],
      ["sell", "1.5", "98"],
    ]);
    expect(b.pos.toString()).toBe("-1");
    expect(b.entry?.toString()).toBe("98");
    expect(b.openedAt).toBe(2);
  });

  it("walks one ledger per bot: time flat, average position, and cut results", () => {
    const bot: BotInfo = {
      id: "b",
      name: "BTC maker",
      market: "BTC-USD",
      strategy: "volume_maker",
      userId: "u",
      createdAt: 0,
      config: { orderSize: "100" },
    };
    const f = (
      at: number,
      side: "buy" | "sell",
      size: string,
      price: string,
      cut = false,
      fee = "0",
    ) => ({
      bot: "b",
      id: `f${String(at)}`,
      at,
      createdAt: at,
      side,
      size,
      price,
      fee,
      cut,
    });
    // Flat 0–10 s; buy 1 @ 100 (100 USDC = 1 order) 10–40 s; sell 0.5; buy 1 @ 110; cut 1.5 @ 104.
    const { walk, cuts } = walkLedger(
      [
        f(0, "buy", "1", "100"),
        f(0, "sell", "1", "100"),
        f(10_000, "buy", "1", "100"),
        f(40_000, "sell", "0.5", "105"),
        f(50_000, "buy", "1", "110"),
        f(60_000, "sell", "1.5", "104", true, "0.1"),
      ],
      new Map(),
    );
    expect(cuts[0]?.entry?.toDecimalPlaces(2).toString()).toBe("106.67");
    // (104 − 106.666…) × 1.5 − 0.1 = −4.1
    expect(cuts[0]?.result?.toDecimalPlaces(4).toString()).toBe("-4.1");
    expect(cuts[0]?.heldSecs).toBe(50);
    const inv = inventoryOf(walk, new Map([["b", bot]]));
    expect(inv.timeFlatPct).toBeCloseTo((10 / 60) * 100);
    expect(
      inventoryOf(walk, new Map([["b", { ...bot, config: {} }]])).avgPositionOrders,
    ).toBeNull();
    // Vị thế mang sang không có giá vốn → kết quả cắt "Not available".
    const unknown = walkLedger(
      [f(1_000, "sell", "1", "99", true)],
      new Map([["b", { pos: new Decimal(1), entry: null, openedAt: null }]]),
    );
    expect(unknown.cuts[0]).toMatchObject({ entry: null, result: null, heldSecs: null });
  });

  it("splits cost on the priced volume, nulls markout past 20% unpriced and the builder split when unrecorded", () => {
    const base = {
      n: 10,
      vol: new Decimal(1000),
      fees: new Decimal(1),
      builder: new Decimal(0.2),
      bNull: 0,
      end: new Decimal(-0.5),
      noMark: 0,
      pVol: new Decimal(900),
      pFees: new Decimal(0.9),
      pBuilder: new Decimal(0.18),
      pBNull: 0,
      pEnd: new Decimal(-0.45),
      pNoMark: 0,
      mk: new Decimal(-0.27),
    };
    const c = costOf(base, new Decimal(0));
    // Mẫu số = 900: phí 1000, markout 300, net (0.9 + 0.45) / 900 = 1500, tồn kho = 200.
    expect(c.fees?.toString()).toBe("1000");
    expect(c.markout?.toString()).toBe("300");
    expect(c.net?.toString()).toBe("1500");
    expect(c.inventory?.toString()).toBe("200");
    expect(c.netUsd?.toString()).toBe("1.5");
    const thin = costOf({ ...base, pVol: new Decimal(700) }, new Decimal(0));
    expect(thin).toMatchObject({ markout: null, inventory: null, priced: false });
    expect(thin.fees?.toString()).toBe("1000");
    expect(costOf({ ...base, pBNull: 1 }, new Decimal(0))).toMatchObject({
      sodexFees: null,
      builderFees: null,
    });
    expect(costOf(base, null).net).toBeNull();
  });

  it("opposite side: one spread per maker leg; a taker or stop exit adds none", () => {
    const t = {
      qty: new Decimal(1),
      entryPrice: new Decimal(100),
      exitPrice: new Decimal(99),
      long: true,
      entryMaker: true,
      exitMaker: true,
      spread: 10,
    };
    // Short ở 100.1, mua lại ở 98.901: +1.199.
    expect(oppositeOf(t)?.pricePnl.toString()).toBe("1.199");
    expect(oppositeOf({ ...t, exitMaker: false })?.pricePnl.toString()).toBe("1.1");
    expect(oppositeOf({ ...t, spread: null })).toBeNull();
  });

  it("VB suggestions never print a missing number as 0", () => {
    const trade = (beforeFees: number, move: number, over: Partial<Trade> = {}): Trade =>
      ({
        beforeFees,
        feesBp: -4,
        net: beforeFees - 4,
        move: [null, move, null],
        markouts: [null, null, 0.5, null, null],
        entryType: null,
        lead: null,
        opposite: null,
        oppositeNet: null,
        ...over,
      }) as unknown as Trade;
    // Mọi lượt "chạy nhanh" lỗ nhưng tổng các lượt khác có lời: vế "x% of the timing loss" vẫn ≤ 100.
    const ts = [
      ...Array.from({ length: 40 }, () => trade(-3, 6)),
      ...Array.from({ length: 40 }, () => trade(2, 1)),
    ];
    const s = vbSuggestions(ts).suggestions.find((x) => x.key.startsWith("fastMove"));
    expect(s?.key).toBe("fastMove");
    expect(s?.values.timing).toBe(100);
    // Không có giá 5 phút → không có gợi ý "pullback" (không in 0).
    expect(vbSuggestions(ts).suggestions.some((x) => x.key.startsWith("pullback"))).toBe(false);
    // Nhóm còn lại có lời → "earned", không "lost −x".
    const sig = [
      ...Array.from({ length: 35 }, () => trade(-3, 0, { entryType: "signal", lead: "momentum" })),
      ...Array.from({ length: 35 }, () => trade(1, 0, { entryType: "signal", lead: "wick" })),
    ];
    const m = vbSuggestions(sig).suggestions.find((x) => x.key === "momentum");
    expect(m?.values).toMatchObject({ otherVerb: "earned", other: 1 });
  });

  it("MM suggestions drop a clause whose number is missing", () => {
    const stats = (n: number, against: number | null, m60: number | null) =>
      ({
        sums: {
          n,
          vol: new Decimal(n),
          fees: new Decimal(0),
          builder: new Decimal(0),
          bNull: 0,
          end: new Decimal(0),
          noMark: 0,
          pVol: new Decimal(0),
          pFees: new Decimal(0),
          pBuilder: new Decimal(0),
          pBNull: 0,
          pEnd: new Decimal(0),
          pNoMark: 0,
          mk: new Decimal(0),
        },
        avg: [null, null, null, m60, null, null],
        cnt: [0, 0, 0, 0, 0, 0],
        against: [null, null, null, against, null, null],
        againstBp: null,
        naf: null,
        feeBp: null,
        ctx: n,
        bots: [],
        sVol: new Decimal(0),
        sUsd: new Decimal(0),
      }) as unknown as Parameters<typeof mmSuggestions>[0] extends Map<string, infer S> ? S : never;
    const groups = new Map([
      ["level|0", stats(40, null, -1)],
      ["level|1", stats(40, null, -0.5)],
      ["smart|on", stats(40, null, 0.5)],
      ["smart|off", stats(40, null, -0.5)],
    ]);
    const levels = [
      {
        level: 0,
        n: 40,
        spread: 0.5,
        priceAgainst: -1,
        netAfterFees: -2,
        fillRatePct: null,
        thin: false,
      },
      {
        level: 1,
        n: 40,
        spread: 1,
        priceAgainst: -1,
        netAfterFees: -1,
        fillRatePct: null,
        thin: false,
      },
    ];
    const hours = {
      rows: [],
      total: {
        key: "all",
        n: 0,
        sharePct: null,
        spread: null,
        markout10s: null,
        markout1m: null,
        markout5m: null,
        againstPct: null,
        netAfterFees: null,
        netPerM: null,
        thin: true,
      },
    };
    const r = mmSuggestions(groups, levels, hours, 0, null);
    expect(r.suggestions.map((x) => x.key)).toEqual(["levelNoAgainstNoRate", "smartNoInventory"]);
    expect(r.suggestions[0]?.values).not.toHaveProperty("baseAgainst");
    expect(r.suggestions[1]?.values).not.toHaveProperty("invOn");
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

  it("bot picker options carry the created time and the account tail, never the email", () => {
    const mk = (id: string, userId: string, createdAt: number): BotInfo => ({
      id,
      name: "ETH Volume Builder",
      market: "ETH-USD",
      strategy: "volume_farm",
      userId,
      createdAt,
      config: null,
    });
    const ua = "00000000-0000-4000-8000-0000bbbbbbbb";
    const ub = "00000000-0000-4000-8000-0000aaaaaaaa";
    const bots = new Map(
      [
        mk("b1", ua, Date.UTC(2026, 10, 1)),
        mk("b2", ub, Date.UTC(2026, 10, 2)),
        mk("b3", ub, Date.UTC(2026, 10, 12)),
      ].map((b) => [b.id, b]),
    );
    const out = botFacets(["b1", "b2", "b3", "b1", "missing"], bots);
    // Theo đuôi account, rồi bot mới nhất trước.
    expect(out.map((b) => b.id)).toEqual(["b3", "b2", "b1"]);
    expect(out[0]).toEqual({
      id: "b3",
      name: "ETH Volume Builder",
      market: "ETH-USD",
      strategy: "volume_farm",
      createdAt: "2026-11-12T00:00:00.000Z",
      tail: "aaaaaaaa",
    });
    expect(out[2]?.tail).toBe("bbbbbbbb");
  });
});
