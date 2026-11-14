import { ReasonCode } from "@drift/shared";
import { describe, expect, it } from "vitest";

import { ARB_PENDING_TIMEOUT_MS, fundingArb, totalPnl, type FundingArbState } from "../funding-arb";
import { fundingArbSchema } from "../funding-arb/schema";
import { runSim } from "../sim/exchange";

const rules = { tickSize: "0.1", stepSize: "0.001", minQuantity: "0.001", minNotional: "5" };
const ctx = {
  botId: "bot-arb",
  version: 1,
  feeRate: "0",
  rules: { vBTC_vUSDC: rules, "BTC-USD": rules },
};
const fees = { makerFee: "0", takerFee: "0" };
const base = fundingArbSchema.parse({
  asset: "BTC",
  spotMarket: "vBTC_vUSDC",
  perpMarket: "BTC-USD",
  leverage: 1,
  investment: "2000",
  enterFundingPct: "0.005",
  exitFundingPct: "0",
  maxGapPct: "0.5",
  minMarginRatioPct: "30",
  maxLoss: "40",
});
const ticks = (n: number, price = 100) =>
  Array.from({ length: n }, (_, i) => [
    { at: i * 10, market: "vBTC_vUSDC", price: String(price) },
    { at: i * 10 + 1, market: "BTC-USD", price: String(price) },
  ]).flat();
const rates = (list: [number, string, string | null][]) => (at: number) =>
  list
    .filter(([t]) => t === at)
    .map(([t, current, avg7d]) => ({
      type: "fundingRate" as const,
      at: t,
      market: "BTC-USD",
      current,
      avg7d,
    }));

describe("funding arbitrage", () => {
  it("waits, then buys spot and shorts the perp with the same size", () => {
    const r = runSim(
      fundingArb,
      base,
      ctx,
      ticks(3),
      fees,
      rates([
        [11, "0.004", "0.004"],
        [21, "0.006", "0.006"],
      ]),
    );
    const fills = r.exchange.fills;
    expect(
      fills.map((f) => `${f.tag.split(":").slice(2).join(":")}:${f.side}:${f.quantity}`),
    ).toEqual(["open:spot:buy:10", "open:perp:sell:10"]);
    expect(r.state.phase).toBe("in_position");
    expect(r.state.cycle).toBe(1);
  });

  it("records funding received and exits after three low periods", () => {
    const r = runSim(fundingArb, base, ctx, ticks(6), fees, (at) => [
      ...rates([
        [1, "0.006", "0.006"],
        [21, "0", "0.004"],
        [31, "-0.001", "0.003"],
        [41, "0", "0.002"],
      ])(at),
      ...(at === 11
        ? [{ type: "fundingPaid" as const, at, market: "BTC-USD", amount: "-1.2" }]
        : []),
    ]);
    expect(r.state.perp.funding).toBe("-1.2");
    expect(r.state.phase).toBe("waiting");
    expect(r.exchange.fills.filter((f) => f.tag.includes(":close:"))).toHaveLength(2);
    expect(r.halted).toBeNull();
  });

  it("closes the filled leg and pauses when the other leg is rejected", () => {
    const r = runSim(
      fundingArb,
      base,
      ctx,
      ticks(2),
      { ...fees, rejectTags: (o) => o.tag.endsWith("open:spot") },
      rates([[1, "0.006", "0.006"]]),
    );
    expect(r.halted).toEqual({ type: "pause", reason: ReasonCode.orderRejected });
    // Chân perp đã khớp được đóng lại bằng lệnh reduce-only: không còn vị thế.
    expect(r.state.perp.position).toBe("0");
  });

  it("closes both legs and pauses when the margin ratio is too low", () => {
    const r = runSim(fundingArb, base, ctx, ticks(3), fees, (at) => [
      ...rates([[1, "0.006", "0.006"]])(at),
      ...(at === 21 ? [{ type: "marginRatio" as const, at, ratio: "0.2" }] : []),
    ]);
    expect(r.halted).toEqual({ type: "pause", reason: ReasonCode.insufficientBalance });
    expect(r.state.spot.position).toBe("0");
  });

  it("closes both legs and stops at max loss", () => {
    const r = runSim(fundingArb, base, ctx, ticks(2), fees, (at) => [
      ...rates([[1, "0.006", "0.006"]])(at),
      ...(at === 11 ? [{ type: "fundingPaid" as const, at, market: "BTC-USD", amount: "45" }] : []),
    ]);
    expect(r.halted).toEqual({ type: "stop", reason: ReasonCode.stopLoss, close: true });
  });

  it("requires the exit level below the entry level", () => {
    const r = fundingArbSchema.safeParse({ ...base, exitFundingPct: "0.01" });
    expect(r.success ? [] : r.error.issues.map((i) => i.message)).toEqual([
      "Must be below the entry level.",
    ]);
  });
});

describe("funding arbitrage — legs that fill in parts, end part-filled or fill late (P0.1)", () => {
  type Ev = Parameters<typeof fundingArb.step>[2];
  const step = (st: FundingArbState, e: Ev) => fundingArb.step(base, st, e, ctx);
  const placesOf = (a: ReturnType<typeof step>["actions"]) =>
    a.flatMap((x) => (x.type === "place" ? [x.order] : []));
  /** Giá 100 cả hai market, funding đủ: đặt hai chân 10 BTC. */
  const opening = () => {
    let st = fundingArb.initialState(base);
    st = step(st, { type: "tick", at: 0, market: "vBTC_vUSDC", price: "100" }).state;
    st = step(st, { type: "tick", at: 1, market: "BTC-USD", price: "100" }).state;
    const r = step(st, {
      type: "fundingRate",
      at: 2,
      market: "BTC-USD",
      current: "0.006",
      avg7d: "0.006",
    });
    const [spot, perp] = placesOf(r.actions);
    if (spot === undefined || perp === undefined) throw new Error("no legs");
    return { st: r.state, spot, perp };
  };
  const fill = (id: string, q: string, at: number): Ev => ({
    type: "fill",
    at,
    clOrdID: id,
    price: "100",
    quantity: q,
    fee: "0",
  });

  it("adds up a leg that fills in parts and balances a leg that ended short with a new clOrdID each time", () => {
    const { st, spot, perp } = opening();
    let s1 = step(st, fill(spot.clOrdID, "10", 3)).state;
    s1 = step(s1, fill(perp.clOrdID, "6", 4)).state;
    s1 = step(s1, fill(perp.clOrdID, "2", 5)).state;
    expect(s1.perp.position).toBe("-8");
    expect(s1.phase).toBe("opening");
    const done = step(s1, { type: "orderDone", at: 6, clOrdID: perp.clOrdID });
    const bal = placesOf(done.actions)[0];
    expect(bal).toMatchObject({ side: "sell", quantity: "2" });
    // Lệnh cân chân cũng khớp thiếu rồi hết hạn: lần cân sau dùng clOrdID khác (không bị engine bỏ qua).
    let s2 = step(done.state, fill(bal?.clOrdID ?? "", "1", 7)).state;
    const again = step(s2, { type: "orderDone", at: 8, clOrdID: bal?.clOrdID ?? "" });
    const bal2 = placesOf(again.actions)[0];
    expect(bal2?.quantity).toBe("1");
    expect(bal2?.clOrdID).not.toBe(bal?.clOrdID);
    s2 = step(again.state, fill(bal2?.clOrdID ?? "", "1", 9)).state;
    expect(s2.phase).toBe("in_position");
    expect(s2.perp.position).toBe("-10");
  });

  it("closes the filled leg and pauses when the other leg did not fill at all", () => {
    const { st, spot, perp } = opening();
    let s1 = step(st, fill(spot.clOrdID, "10", 3)).state;
    const r = step(s1, { type: "orderDone", at: 4, clOrdID: perp.clOrdID });
    expect(placesOf(r.actions)).toMatchObject([{ side: "sell", quantity: "10" }]);
    expect(r.state.phase).toBe("closing");
    s1 = step(r.state, fill(placesOf(r.actions)[0]?.clOrdID ?? "", "10", 5)).state;
    expect(s1.phase).toBe("halted");
  });

  it("closes the rest when a closing order ends part-filled", () => {
    const { st, spot, perp } = opening();
    let s1 = step(st, fill(spot.clOrdID, "10", 3)).state;
    s1 = step(s1, fill(perp.clOrdID, "10", 4)).state;
    expect(s1.phase).toBe("in_position");
    // Lỗ chạm max loss → đóng hai chân.
    const loss = step(s1, { type: "tick", at: 5, market: "vBTC_vUSDC", price: "95" });
    const [cs, cp] = placesOf(loss.actions);
    let s2 = step(loss.state, fill(cs?.clOrdID ?? "", "10", 6)).state;
    s2 = step(s2, fill(cp?.clOrdID ?? "", "4", 7)).state;
    const r = step(s2, { type: "orderDone", at: 8, clOrdID: cp?.clOrdID ?? "" });
    const rest = placesOf(r.actions)[0];
    expect(rest).toMatchObject({ side: "buy", quantity: "6", reduceOnly: true });
    expect(rest?.clOrdID).not.toBe(cp?.clOrdID);
  });

  it("books a late fill and does not count a replayed fill twice", () => {
    const { st, spot, perp } = opening();
    let s1 = step(st, fill(spot.clOrdID, "10", 3)).state;
    s1 = step(s1, fill(spot.clOrdID, "10", 4)).state;
    expect(s1.spot.position).toBe("10");
    s1 = step(s1, fill(perp.clOrdID, "10", 5)).state;
    expect(s1.perp.position).toBe("-10");
  });

  it("treats legs with no orderDone for 60 s as ended", () => {
    const { st, spot, perp } = opening();
    let s1 = step(st, fill(spot.clOrdID, "10", 3)).state;
    s1 = step(s1, fill(perp.clOrdID, "10", 3)).state;
    expect(s1.phase).toBe("in_position");
    const o2 = opening();
    const half = step(o2.st, fill(o2.spot.clOrdID, "10", 3)).state;
    const early = step(half, { type: "timer", at: 2 + ARB_PENDING_TIMEOUT_MS - 1 });
    expect(early.state.phase).toBe("opening");
    const late = step(early.state, { type: "timer", at: 2 + ARB_PENDING_TIMEOUT_MS });
    // Chân perp không khớp gì sau hạn chờ: đóng chân spot.
    expect(late.state.phase).toBe("closing");
    expect(perp.clOrdID).toBeTruthy();
  });
});

describe("funding arbitrage — price gap and missing prices", () => {
  type Ev = Parameters<typeof fundingArb.step>[2];
  const step = (st: FundingArbState, e: Ev, c = base) => fundingArb.step(c, st, e, ctx);
  const rate: Ev = {
    type: "fundingRate",
    at: 5,
    market: "BTC-USD",
    current: "0.006",
    avg7d: "0.006",
  };
  const withPrices = (spot: string, perp: string, c = base) => {
    let st = fundingArb.initialState(c);
    st = step(st, { type: "tick", at: 0, market: "vBTC_vUSDC", price: spot }, c).state;
    return step(st, { type: "tick", at: 1, market: "BTC-USD", price: perp }, c).state;
  };

  it("does not enter while the spot / perp price gap is above Max price gap between legs", () => {
    // 100 vs 101 = 1% > 0.5%.
    const r = step(withPrices("100", "101"), rate);
    expect(r.actions.some((a) => a.type === "place")).toBe(false);
    expect(r.actions).toContainEqual({
      type: "log",
      decision: "Not entering",
      why: "Price gap between legs is 1%, above 0.5%.",
    });
    expect(r.state.phase).toBe("waiting");
    // Trong ngưỡng: vào lệnh.
    expect(step(withPrices("100", "100.4"), rate).state.phase).toBe("opening");
    // Chưa có giá spot: chưa vào.
    let noSpot = fundingArb.initialState(base);
    noSpot = step(noSpot, { type: "tick", at: 1, market: "BTC-USD", price: "100" }).state;
    expect(step(noSpot, rate).actions).toEqual([]);
  });

  it("leaves the PnL not available when a leg with a position has no price, so max loss cannot fire on a 0 price", () => {
    const st: FundingArbState = {
      ...fundingArb.initialState(base),
      phase: "in_position",
      prices: { "BTC-USD": "100" },
      spot: {
        position: "10",
        avgCost: "100",
        realized: "0",
        fees: "0",
        funding: "0",
        invested: "1000",
      },
      perp: {
        position: "-10",
        avgCost: "100",
        realized: "0",
        fees: "0",
        funding: "0",
        invested: "1000",
      },
    };
    expect(totalPnl(base, st)).toBeNull();
    const r = step(st, { type: "tick", at: 2, market: "BTC-USD", price: "100" });
    expect(r.actions).toEqual([]);
    expect(totalPnl(base, { ...st, prices: { ...st.prices, vBTC_vUSDC: "100" } })?.toString()).toBe(
      "0",
    );
  });

  it("balances the legs on a fixed size gap, whatever Max price gap is set to", () => {
    const wide = { ...base, maxGapPct: "5" };
    let st = withPrices("100", "100", wide);
    const r = step(st, rate, wide);
    const [spot, perp] = r.actions.flatMap((a) => (a.type === "place" ? [a.order] : []));
    st = step(
      r.state,
      { type: "fill", at: 6, clOrdID: spot?.clOrdID ?? "", price: "100", quantity: "10", fee: "0" },
      wide,
    ).state;
    st = step(
      st,
      { type: "fill", at: 7, clOrdID: perp?.clOrdID ?? "", price: "100", quantity: "9", fee: "0" },
      wide,
    ).state;
    const done = step(st, { type: "orderDone", at: 8, clOrdID: perp?.clOrdID ?? "" }, wide);
    // Lệch 10% khối lượng > 0.5% cố định: cân lại dù maxGapPct = 5%.
    expect(done.actions.flatMap((a) => (a.type === "place" ? [a.order] : []))[0]).toMatchObject({
      side: "sell",
      quantity: "1",
    });
  });
});
