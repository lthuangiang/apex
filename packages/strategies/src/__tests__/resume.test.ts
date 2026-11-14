import { ReasonCode } from "@drift/shared";
import { describe, expect, it } from "vitest";

import { adaptiveDca, type AdaptiveDcaState } from "../adaptive-dca";
import { adaptiveDcaSchema } from "../adaptive-dca/schema";
import { copyTrade, normalizeCopyState, type CopyMarketState } from "../copy-trade";
import { copyTradeSchema } from "../copy-trade/schema";
import { applyFill, emptyLedger } from "../core/ledger";
import type { OrderIntent, StepContext, StrategyAction, StrategyEvent } from "../core/types";
import { fundingArb } from "../funding-arb";
import { fundingArbSchema } from "../funding-arb/schema";
import { rebalancing } from "../rebalancing";
import { rebalancingSchema } from "../rebalancing/schema";
import { recurringBuy } from "../recurring-buy";
import { recurringBuySchema } from "../recurring-buy/schema";
import { runSim } from "../sim/exchange";
import { spotDca } from "../spot-dca";
import { spotDcaSchema } from "../spot-dca/schema";
import { spotGrid } from "../spot-grid";
import { spotGridSchema } from "../spot-grid/schema";
import { twap } from "../twap";
import { twapSchema } from "../twap/schema";

// Resume sau khi bot tự pause (DEC-240): giữ sổ cái và vị thế, dựng lại lệnh từ vị thế thật.

const fees = { makerFee: "0", takerFee: "0" };
const places = (actions: readonly StrategyAction[]): OrderIntent[] =>
  actions.flatMap((a) => (a.type === "place" ? [a.order] : []));
const resumed = (prices: Record<string, string>, at = 100_000): StrategyEvent => ({
  type: "resumed",
  at,
  prices,
});

describe("grid resume", () => {
  const ctx = {
    botId: "bot-grid",
    version: 1,
    feeRate: "0.0005",
    rules: {
      vBTC_vUSDC: { tickSize: "1", stepSize: "0.0001", minQuantity: "0.0001", minNotional: "5" },
    },
  };
  // Mức 90, 95, 100, 105, 110; khối lượng mỗi mức 1.
  const grid = spotGridSchema.parse({
    market: "vBTC_vUSDC",
    lowerPrice: "90",
    upperPrice: "110",
    gridLevels: 5,
    spacing: "arithmetic",
    investment: "500",
    maxLoss: "100",
    onStop: "keep_base",
  });
  const ticks = (prices: number[]) =>
    prices.map((p, i) => ({ at: i * 1000, price: String(p), market: "vBTC_vUSDC" }));
  // Lệnh bán ở 105 bị từ chối: bot pause, các lệnh khác còn trên sàn.
  const paused = () =>
    runSim(spotGrid, grid, ctx, ticks([100]), {
      ...fees,
      rejectTags: (o) => o.tag === "grid:3:sell",
    });

  it("places the missing level again from the current position, with a new client order id", () => {
    const r = paused();
    expect(r.halted).toEqual({ type: "pause", reason: ReasonCode.orderRejected });
    const rejected = places(r.actions).find((o) => o.tag === "grid:3:sell");
    const out = spotGrid.step(grid, r.state, resumed({ vBTC_vUSDC: "100" }), ctx);
    const placed = places(out.actions);
    // Vị thế 2 (lệnh mua lúc khởi động), bán 110 còn mở: còn chỗ cho đúng một lệnh bán ở 105.
    expect(placed.map((o) => `${o.side}@${o.price ?? ""}`)).toEqual(["sell@105"]);
    expect(placed[0]?.clOrdID).not.toBe(rejected?.clOrdID);
    expect(out.state.phase).toBe("running");
    expect(out.state.ledger).toEqual(r.state.ledger);
    expect(out.actions.at(-1)).toMatchObject({ type: "log", decision: "Grid resumed" });
  });

  it("waits for the first price when the engine has none, then rebuilds", () => {
    const r = paused();
    const waiting = spotGrid.step(grid, r.state, resumed({}), ctx);
    expect(waiting.actions).toEqual([]);
    const out = spotGrid.step(
      grid,
      waiting.state,
      { type: "tick", at: 101_000, market: "vBTC_vUSDC", price: "100" },
      ctx,
    );
    expect(places(out.actions).map((o) => `${o.side}@${o.price ?? ""}`)).toEqual(["sell@105"]);
    expect(out.state.phase).toBe("running");
    expect(out.state.resumeOnTick).toBe(false);
  });

  it("uses the price from the resume event, not the price at the pause", () => {
    const r = paused();
    // Giá đã lên 107 trong lúc pause: 105 nằm dưới giá nên thành lệnh mua, không đặt bán dưới giá.
    const out = spotGrid.step(grid, r.state, resumed({ vBTC_vUSDC: "107" }), ctx);
    const placed = places(out.actions);
    expect(placed.every((o) => o.side === "buy" || Number(o.price) > 107)).toBe(true);
    expect(placed.map((o) => `${o.side}@${o.price ?? ""}`)).toContain("buy@105");
  });

  it("pauses again without placing orders when max loss is still reached", () => {
    const r = runSim(spotGrid, { ...grid, maxLoss: "10" }, ctx, ticks([100, 95, 91, 89]), fees);
    expect(r.halted).toEqual({ type: "pause", reason: ReasonCode.botMaxLoss });
    const out = spotGrid.step(
      { ...grid, maxLoss: "10" },
      r.state,
      resumed({ vBTC_vUSDC: "89" }),
      ctx,
    );
    expect(places(out.actions)).toEqual([]);
    expect(out.actions).toContainEqual({ type: "pause", reason: ReasonCode.botMaxLoss });
    expect(out.state.phase).toBe("halted");
  });

  it("ignores resume when the bot was not halted (user pause keeps its orders)", () => {
    const r = runSim(spotGrid, grid, ctx, ticks([100]), fees);
    const out = spotGrid.step(grid, r.state, resumed({ vBTC_vUSDC: "100" }), ctx);
    expect(out.actions).toEqual([]);
    expect(out.state).toEqual(r.state);
  });
});

describe("DCA resume", () => {
  const rules = { tickSize: "0.01", stepSize: "0.0001", minQuantity: "0.0001", minNotional: "5" };
  const ctx = { botId: "bot-dca", version: 1, feeRate: "0.0005", rules: { vETH_vUSDC: rules } };
  const dca = spotDcaSchema.parse({
    market: "vETH_vUSDC",
    baseOrder: "100",
    safetyOrder: "100",
    maxSafetyOrders: 3,
    firstStepPct: "2",
    stepMultiplier: "1.5",
    sizeMultiplier: "2",
    takeProfitPct: "1",
    start: "immediately",
  });
  const ticks = (prices: number[]) =>
    prices.map((p, i) => ({ at: i * 1000, price: String(p), market: "vETH_vUSDC" }));

  it("continues the cycle: places the rejected safety again and a new take profit", () => {
    const r = runSim(spotDca, dca, ctx, ticks([100]), {
      ...fees,
      rejectTags: (o) => o.tag.endsWith(":so2"),
    });
    expect(r.halted).toEqual({ type: "pause", reason: ReasonCode.orderRejected });
    const out = spotDca.step(dca, r.state, resumed({ vETH_vUSDC: "100" }), ctx);
    const placed = places(out.actions);
    // Safety 1 và 3 còn mở; safety 2 (95, 200 USDC) đặt lại với tag mới.
    expect(placed.filter((o) => o.side === "buy")).toEqual([
      expect.objectContaining({ tag: "dca:1:so2:r1", price: "95", quantity: "2.1052" }),
    ]);
    const tp = placed.find((o) => o.side === "sell");
    expect(tp).toMatchObject({ type: "limit", price: "101", quantity: "1" });
    expect(out.state.phase).toBe("in_cycle");
    expect(Object.values(out.state.safeties).sort()).toEqual([1, 2, 3]);
    expect(out.state.ledger).toEqual(r.state.ledger);
  });

  it("waits for a new cycle when there is no position", () => {
    const r = runSim(spotDca, dca, ctx, ticks([100]), {
      ...fees,
      rejectTags: (o) => o.tag.endsWith(":base"),
    });
    expect(r.halted).toEqual({ type: "pause", reason: ReasonCode.orderRejected });
    const out = spotDca.step(dca, r.state, resumed({ vETH_vUSDC: "100" }), ctx);
    expect(places(out.actions)).toEqual([]);
    expect(out.state.phase).toBe("idle");
    const next = spotDca.step(
      dca,
      out.state,
      { type: "tick", at: 101_000, market: "vETH_vUSDC", price: "100" },
      ctx,
    );
    expect(places(next.actions)[0]).toMatchObject({ type: "market", tag: "dca:2:base" });
  });

  it("pauses again without placing orders when max loss is still reached", () => {
    const c = { ...dca, maxLoss: "5" };
    const r = runSim(spotDca, c, ctx, ticks([100, 99, 94]), fees);
    expect(r.halted).toEqual({ type: "pause", reason: ReasonCode.botMaxLoss });
    const out = spotDca.step(c, r.state, resumed({ vETH_vUSDC: "94" }), ctx);
    expect(places(out.actions)).toEqual([]);
    expect(out.actions).toContainEqual({ type: "pause", reason: ReasonCode.botMaxLoss });
    expect(out.state.phase).toBe("halted");
  });
});

describe("AI DCA resume", () => {
  const ctx: StepContext = {
    botId: "adca-bot",
    version: 1,
    rules: {
      "BTC-USD": { tickSize: "1", stepSize: "0.00001", minQuantity: "0.00001", minNotional: "10" },
    },
    feeRate: "0.0002",
  };
  const c = adaptiveDcaSchema.parse({
    market: "BTC-USD",
    leverage: 2,
    baseOrder: "100",
    safetyOrder: "100",
    maxExposure: "1000",
    maxLoss: "150",
  });
  const halted = (position: string): AdaptiveDcaState => ({
    ...adaptiveDca.initialState(c),
    phase: "halted",
    cycle: 1,
    ledger:
      position === "0" ? emptyLedger() : applyFill(emptyLedger(), "buy", "80000", position, "0"),
    lastPrice: "80000",
    lastFillPrice: "80000",
    atr: "400",
    tpId: "old-tp",
    tpAttempt: 1,
  });

  it("places the take profit and the next order again from the position", () => {
    const out = adaptiveDca.step(c, halted("0.00125"), resumed({ "BTC-USD": "79900" }), ctx);
    expect(out.actions[0]).toEqual({ type: "cancel", clOrdID: "old-tp" });
    const placed = places(out.actions);
    expect(placed.map((o) => [o.side, o.reduceOnly])).toEqual([
      ["sell", true],
      ["buy", false],
    ]);
    expect(placed[1]?.tag).toBe("adca:1:so1:r1");
    expect(out.state.phase).toBe("in_cycle");
    expect(out.state.lastPrice).toBe("79900");
  });

  it("waits for a new cycle when there is no position", () => {
    const out = adaptiveDca.step(c, halted("0"), resumed({ "BTC-USD": "79900" }), ctx);
    expect(places(out.actions)).toEqual([]);
    expect(out.state).toMatchObject({ phase: "idle", tpId: null, baseRejects: 0 });
  });
});

describe("copy trade resume", () => {
  const rules = { tickSize: "0.01", stepSize: "0.0001", minQuantity: "0.0001", minNotional: "10" };
  const ctx: StepContext = {
    botId: "copy-bot",
    version: 1,
    rules: { "BTC-USD": rules, "ETH-USD": rules },
    feeRate: "0.0002",
  };
  const c = copyTradeSchema.parse({
    leaderSource: "hyperliquid",
    leaderAddress: "0x2222222222222222222222222222222222222222",
    markets: ["BTC-USD", "ETH-USD"],
    leverage: 2,
    fixedNotional: "1000",
    maxNotionalPerTrade: "1000",
    maxExposure: "1500",
    maxLoss: "100",
  });

  it("finishes the cut that failed before the pause, on every market", () => {
    const ledger = applyFill(emptyLedger(), "buy", "50000", "0.01", "0");
    // Trader đã đóng; lệnh giảm của bot thất bại đủ số lần nên bot pause.
    const btc: CopyMarketState = {
      ledger,
      lastPrice: "50000",
      leaderPos: "0",
      tracking: false,
      target: "0",
      refPrice: null,
      refAt: 0,
      inflight: { id: "old", kind: "reduce", side: "sell", qty: "0.01", filled: "0", aim: "0" },
      reduceAttempts: 3,
      openRejects: 0,
    };
    const s = {
      ...normalizeCopyState(c, {}),
      phase: "halted" as const,
      markets: { "BTC-USD": btc },
    };
    const out = copyTrade.step(c, s, resumed({ "BTC-USD": "50100" }), ctx);
    expect(places(out.actions)).toEqual([
      expect.objectContaining({ side: "sell", quantity: "0.01", reduceOnly: true }),
    ]);
    expect(out.state.phase).toBe("following");
    expect(out.state.markets["BTC-USD"]).toMatchObject({ reduceAttempts: 0, lastPrice: "50100" });
  });

  it("does nothing when the bot was not halted", () => {
    const s = normalizeCopyState(c, {});
    const out = copyTrade.step(c, s, resumed({}), ctx);
    expect(out).toEqual({ actions: [], state: s });
  });
});

describe("funding arb resume", () => {
  const ctx: StepContext = { botId: "arb", version: 1, rules: {}, feeRate: "0" };
  const c = fundingArbSchema.parse({
    asset: "BTC",
    spotMarket: "vBTC_vUSDC",
    perpMarket: "BTC-USD",
    leverage: 1,
    investment: "2000",
    enterFundingPct: "0.01",
    exitFundingPct: "0",
    maxGapPct: "0.5",
    minMarginRatioPct: "20",
    maxLoss: "100",
  });

  it("goes back to waiting when both legs are closed, and keeps watching open legs", () => {
    const halted = { ...fundingArb.initialState(c), phase: "halted" as const };
    const flat = fundingArb.step(c, halted, resumed({ "BTC-USD": "50000" }), ctx);
    expect(flat.state.phase).toBe("waiting");
    expect(flat.state.prices["BTC-USD"]).toBe("50000");
    const open = fundingArb.step(
      c,
      { ...halted, perp: applyFill(emptyLedger(), "sell", "50000", "0.01", "0") },
      resumed({}),
      ctx,
    );
    expect(open.state.phase).toBe("in_position");
    expect(open.actions).toEqual([]);
  });
});

describe("rebalancing resume", () => {
  const ctx = { botId: "bot-rebal", version: 1, feeRate: "0", rules: {} };
  const c = rebalancingSchema.parse({
    quoteAsset: "USDC",
    assets: [
      { asset: "BTC", market: "vBTC_vUSDC", weightPct: "50" },
      { asset: "USDC", weightPct: "50" },
    ],
    rebalanceWhen: "threshold",
    thresholdPct: "5",
    investment: "1000",
    maxTradePct: "100",
  });

  it("treats waiting IOC orders as done and keeps running", () => {
    const s = {
      ...rebalancing.initialState(c),
      phase: "halted" as const,
      holdings: { BTC: "0.01" },
      pending: { a: { asset: "BTC", side: "buy" as const, qty: "0.01", filled: "0" } },
    };
    const out = rebalancing.step(c, s, resumed({ vBTC_vUSDC: "50000" }), ctx);
    expect(out.state).toMatchObject({ phase: "running", pending: {}, resumes: 1 });
    expect(out.state.recent?.a).toBeDefined();
    expect(out.state.prices.vBTC_vUSDC).toBe("50000");
  });

  it("starts the first buy again when nothing was bought", () => {
    const s = { ...rebalancing.initialState(c), phase: "halted" as const };
    const out = rebalancing.step(c, s, resumed({}), ctx);
    expect(out.state.phase).toBe("waiting_prices");
  });

  it("books a fill that arrives while paused", () => {
    const s = {
      ...rebalancing.initialState(c),
      phase: "halted" as const,
      pending: { a: { asset: "BTC", side: "buy" as const, qty: "0.01", filled: "0" } },
    };
    const out = rebalancing.step(
      c,
      s,
      {
        type: "fill",
        at: 1,
        clOrdID: "a",
        price: "50000",
        quantity: "0.01",
        fee: "0",
        market: "vBTC_vUSDC",
        side: "buy",
      } as StrategyEvent,
      ctx,
    );
    expect(out.state.holdings.BTC).toBe("0.01");
    expect(out.actions).toEqual([]);
  });
});

describe("recurring buy resume", () => {
  const ctx = { botId: "rb", version: 1, feeRate: "0", rules: {} };
  const c = recurringBuySchema.parse({
    market: "vBTC_vUSDC",
    amountPerBuy: "10",
    frequency: "daily",
    time: "00:00",
    timeZone: "UTC",
    ends: "never",
    onLowBalance: "skip_and_notify",
  });

  it("does not make up a missed buy, after a user pause or a halt", () => {
    const at = Date.parse("2026-11-14T12:00:00Z");
    const past = Date.parse("2026-11-12T00:00:00Z");
    for (const phase of ["running", "halted"] as const) {
      const s = { ...recurringBuy.initialState(c), phase, nextAt: past };
      const out = recurringBuy.step(c, s, resumed({ vBTC_vUSDC: "50000" }, at), ctx);
      expect(out.actions).toEqual([]);
      expect(out.state.phase).toBe("running");
      expect(out.state.nextAt).toBe(Date.parse("2026-11-15T00:00:00Z"));
    }
  });
});

describe("TWAP resume", () => {
  const ctx = { botId: "tw", version: 1, feeRate: "0", rules: {} };
  const c = twapSchema.parse({
    market: "vBTC_vUSDC",
    engine: "spot",
    side: "buy",
    totalSize: "1",
    durationMinutes: 60,
    slices: 6,
    reduceOnly: false,
    maxSlippagePct: "0.3",
    onSkip: "add_to_end",
  });

  it("continues from the next slice", () => {
    const s = {
      ...twap.initialState(c),
      phase: "halted" as const,
      startedAt: 1,
      sliceIndex: 2,
      pending: "x",
    };
    const out = twap.step(c, s, resumed({ vBTC_vUSDC: "50000" }), ctx);
    expect(out.state).toMatchObject({ phase: "running", pending: null, sliceIndex: 2 });
    expect(out.state.lastPrice).toBe("50000");
  });
});
