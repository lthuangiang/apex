import { dec } from "@drift/shared";
import { describe, expect, it } from "vitest";

import { adaptiveDca, type AdaptiveDcaState } from "../adaptive-dca";
import { adaptiveDcaSchema } from "../adaptive-dca/schema";
import { copyTrade, normalizeCopyState, type CopyMarketState } from "../copy-trade";
import { copyTradeSchema } from "../copy-trade/schema";
import { applyFill, emptyLedger } from "../core/ledger";
import type {
  OrderIntent,
  StepContext,
  StrategyAction,
  StrategyEvent,
  StrategyModule,
} from "../core/types";
import { fundingArb, type FundingArbState } from "../funding-arb";
import { fundingArbSchema } from "../funding-arb/schema";
import { futuresDca } from "../futures-dca";
import { futuresDcaSchema } from "../futures-dca/schema";
import { futuresGrid } from "../futures-grid";
import { futuresGridSchema } from "../futures-grid/schema";
import { runSim } from "../sim/exchange";
import { spotDca } from "../spot-dca";
import { spotDcaSchema } from "../spot-dca/schema";
import { spotGrid } from "../spot-grid";
import { spotGridSchema } from "../spot-grid/schema";
import { twap, type TwapState } from "../twap";
import { twapSchema } from "../twap/schema";

// #223 (DEC-TBD-version-apply-position): áp version mới khi bot còn vị thế giữ vị thế trong sổ cái, không đặt lệnh
// market mở lại vị thế ban đầu, không tự đóng, và các bước sau không nhân đôi hay bỏ quên vị thế.

const fees = { makerFee: "0", takerFee: "0" };
const places = (actions: readonly StrategyAction[]): OrderIntent[] =>
  actions.flatMap((a) => (a.type === "place" ? [a.order] : []));
const apply = <C, S>(mod: StrategyModule<C, S>, c: C, s: S, ctx: StepContext): S | null => {
  if (mod.applyVersion === undefined) throw new Error("module must define applyVersion");
  return mod.applyVersion(c, s, ctx);
};
const must = <S>(s: S | null): S => {
  if (s === null) throw new Error("expected the version to apply");
  return s;
};
const tick = (market: string, price: string, at = 100_000): StrategyEvent => ({
  type: "tick",
  at,
  market,
  price,
});
const fill = (clOrdID: string, price: string, quantity: string, at = 100_500): StrategyEvent => ({
  type: "fill",
  at,
  clOrdID,
  price,
  quantity,
  fee: "0",
});
const sumQty = (orders: readonly OrderIntent[], side: "buy" | "sell") =>
  orders.filter((o) => o.side === side).reduce((a, o) => a.add(o.quantity), dec("0"));

describe("futures grid: version apply keeps the position", () => {
  const rules = { tickSize: "1", stepSize: "0.0001", minQuantity: "0.0001", minNotional: "5" };
  const v1: StepContext = { botId: "g", version: 1, feeRate: "0", rules: { "BTC-USD": rules } };
  const v2: StepContext = { ...v1, version: 2 };
  // Mức 90, 95, 100, 105, 110; mỗi mức 1 BTC (margin 250 × 2 = 500 / 5 / 100).
  const long = futuresGridSchema.parse({
    market: "BTC-USD",
    leverage: 2,
    marginMode: "cross",
    direction: "long",
    lowerPrice: "90",
    upperPrice: "110",
    gridLevels: 5,
    spacing: "arithmetic",
    margin: "250",
    stopBelow: "50",
    maxLoss: "100",
    onStop: "close_at_market",
  });
  // v1 long ở 100: lệnh market mua 2 (cho bán 105, 110), mua chờ ở 90, 95.
  const running = () =>
    runSim(futuresGrid, long, v1, [{ at: 0, price: "100", market: "BTC-USD" }], fees);

  it("keeps the position, never re-buys the starting position, and sells only what it holds", () => {
    const r = running();
    expect(r.state.ledger.position).toBe("2");
    const old = Object.keys(r.state.open);
    const applied = must(apply(futuresGrid, { ...long, maxLoss: "150" }, r.state, v2));
    expect(applied.ledger).toMatchObject({ position: "2", avgCost: "100", realized: "0" });
    expect(Object.keys(applied.cancelled ?? {}).sort()).toEqual(old.sort());
    const out = futuresGrid.step({ ...long, maxLoss: "150" }, applied, tick("BTC-USD", "100"), v2);
    const placed = places(out.actions);
    expect(placed.some((o) => o.type === "market")).toBe(false);
    expect(placed.map((o) => `${o.side}@${o.price ?? ""}`)).toEqual([
      "sell@105",
      "sell@110",
      "buy@95",
      "buy@90",
    ]);
    // Vị thế xấu nhất không vượt grid mới khởi động từ phẳng (5 mức × 1).
    expect(dec(out.state.ledger.position).add(sumQty(placed, "buy")).lte(5)).toBe(true);
    // Lệnh mới mang version 2 trong clOrdID, không trùng lệnh v1 vừa huỷ.
    expect(placed.every((o) => o.clOrdID.split("-")[1] === "2")).toBe(true);
    expect(out.state.phase).toBe("running");
    expect(out.actions.at(-1)).toMatchObject({ type: "log", decision: "Grid started" });
  });

  it("books a late fill of a v1 order cancelled by the apply, without an extra order", () => {
    const r = running();
    const sell105 = Object.entries(r.state.open).find(([, o]) => o.side === "sell")?.[0] ?? "";
    const applied = must(apply(futuresGrid, long, r.state, v2));
    const started = futuresGrid.step(long, applied, tick("BTC-USD", "100"), v2);
    const late = futuresGrid.step(long, started.state, fill(sell105, "105", "1"), v2);
    expect(late.actions).toEqual([]);
    expect(late.state.ledger.position).toBe("1");
    // Lệnh bán mới ở 105 khớp: vị thế về 0, đặt mua lại ở 100, không bán quá vị thế.
    const newSell = Object.entries(late.state.open).find(([, o]) => o.level === 3)?.[0] ?? "";
    const next = futuresGrid.step(long, late.state, fill(newSell, "105", "1", 101_000), v2);
    expect(next.state.ledger.position).toBe("0");
    expect(places(next.actions).map((o) => `${o.side}@${o.price ?? ""}`)).toEqual(["buy@100"]);
  });

  it("never opens more of the old side when the new grid points the other way", () => {
    const r = running();
    const short = { ...long, direction: "short" as const };
    const applied = must(apply(futuresGrid, short, r.state, v2));
    const out = futuresGrid.step(short, applied, tick("BTC-USD", "100"), v2);
    const placed = places(out.actions);
    expect(placed.some((o) => o.type === "market")).toBe(false);
    expect(placed.filter((o) => o.side === "buy")).toEqual([]);
    expect(placed.map((o) => `${o.side}@${o.price ?? ""}`)).toEqual(["sell@105", "sell@110"]);
    expect(out.state.ledger.position).toBe("2");
  });

  it("waits while the starting market order is still in flight, and applies once SoDEX ends it", () => {
    const r = running();
    const inFlight = { ...r.state, phase: "starting" as const, initClOrdID: "init" };
    expect(apply(futuresGrid, long, inFlight, v2)).toBeNull();
    const ended = futuresGrid.step(
      long,
      inFlight,
      { type: "orderDone", at: 1, clOrdID: "init" },
      v1,
    );
    expect(ended.state).toMatchObject({ initClOrdID: null, phase: "running" });
    expect(apply(futuresGrid, long, ended.state, v2)).not.toBeNull();
  });

  it("starts like a new bot when the old grid was flat", () => {
    const neutral = { ...long, direction: "neutral" as const };
    const r = runSim(futuresGrid, neutral, v1, [{ at: 0, price: "100", market: "BTC-USD" }], fees);
    expect(r.state.ledger.position).toBe("0");
    const applied = must(apply(futuresGrid, long, r.state, v2));
    const out = futuresGrid.step(long, applied, tick("BTC-USD", "100"), v2);
    expect(places(out.actions)[0]).toMatchObject({ type: "market", side: "buy", quantity: "2" });
  });
});

describe("spot grid: version apply keeps the coins it bought", () => {
  const rules = { tickSize: "1", stepSize: "0.0001", minQuantity: "0.0001", minNotional: "5" };
  const v1: StepContext = { botId: "sg", version: 1, feeRate: "0", rules: { vBTC_vUSDC: rules } };
  const v2: StepContext = { ...v1, version: 2 };
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

  it("does not buy the starting coins again and sells only the coins it holds", () => {
    const r = runSim(spotGrid, grid, v1, [{ at: 0, price: "100", market: "vBTC_vUSDC" }], fees);
    expect(r.state.ledger.position).toBe("2");
    const wider = { ...grid, upperPrice: "120", gridLevels: 6 };
    const applied = must(apply(spotGrid, wider, r.state, v2));
    const out = spotGrid.step(wider, applied, tick("vBTC_vUSDC", "100"), v2);
    const placed = places(out.actions);
    expect(placed.some((o) => o.type === "market")).toBe(false);
    expect(sumQty(placed, "sell").lte(out.state.ledger.position)).toBe(true);
    expect(out.state.ledger.position).toBe("2");
  });
});

describe("DCA: version apply keeps the cycle's position", () => {
  const rules = { tickSize: "0.01", stepSize: "0.0001", minQuantity: "0.0001", minNotional: "5" };
  const v1: StepContext = { botId: "d", version: 1, feeRate: "0", rules: { vETH_vUSDC: rules } };
  const v2: StepContext = { ...v1, version: 2 };
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
  const running = () =>
    runSim(spotDca, dca, v1, [{ at: 0, price: "100", market: "vETH_vUSDC" }], fees);

  it("places the take profit of the new settings for the kept position and no new base order", () => {
    const r = running();
    expect(r.state.ledger.position).toBe("1");
    const wider = { ...dca, takeProfitPct: "2" };
    const applied = must(apply(spotDca, wider, r.state, v2));
    expect(applied.ledger).toMatchObject({ position: "1", avgCost: "100" });
    const out = spotDca.step(wider, applied, tick("vETH_vUSDC", "100"), v2);
    const placed = places(out.actions);
    expect(placed.some((o) => o.type === "market")).toBe(false);
    expect(placed.find((o) => o.side === "sell")).toMatchObject({ price: "102", quantity: "1" });
    expect(placed.filter((o) => o.side === "buy").map((o) => o.price)).toEqual([
      "98",
      "95",
      "90.5",
    ]);
    expect(out.state.phase).toBe("in_cycle");
    expect(out.state.ledger.position).toBe("1");
  });

  it("books a late fill of a v1 safety and moves the take profit to the bigger position", () => {
    const r = running();
    const so1 = Object.entries(r.state.safeties).find(([, k]) => k === 1)?.[0] ?? "";
    const applied = must(apply(spotDca, dca, r.state, v2));
    const started = spotDca.step(dca, applied, tick("vETH_vUSDC", "100"), v2);
    const late = spotDca.step(dca, started.state, fill(so1, "98", "1.0204"), v2);
    expect(late.state.ledger.position).toBe("2.0204");
    const tp = places(late.actions).find((o) => o.side === "sell");
    expect(tp).toMatchObject({ quantity: "2.0204" });
  });

  it("waits while the base order is in flight, and does not start a new cycle meanwhile", () => {
    const r = running();
    expect(
      apply(spotDca, dca, { ...r.state, phase: "waiting_base", baseClOrdID: "b" }, v2),
    ).toBeNull();
    const blocked = spotDca.step(dca, spotDca.initialState(dca), tick("vETH_vUSDC", "100"), {
      ...v1,
      versionPending: 2,
    });
    expect(places(blocked.actions)).toEqual([]);
  });

  it("starts like a new bot when no cycle holds a position", () => {
    const idle = { ...spotDca.initialState(dca), lastPrice: "100" };
    const applied = must(apply(spotDca, dca, idle, v2));
    expect(applied.phase).toBe("idle");
    const out = spotDca.step(dca, applied, tick("vETH_vUSDC", "100"), v2);
    expect(places(out.actions)[0]).toMatchObject({ type: "market", tag: "dca:1:base" });
  });
});

describe("futures DCA: version apply", () => {
  const rules = { tickSize: "0.01", stepSize: "0.0001", minQuantity: "0.0001", minNotional: "5" };
  const v1: StepContext = { botId: "fd", version: 1, feeRate: "0", rules: { "ETH-USD": rules } };
  const v2: StepContext = { ...v1, version: 2 };
  const fut = futuresDcaSchema.parse({
    market: "ETH-USD",
    leverage: 2,
    marginMode: "cross",
    direction: "short",
    baseOrder: "50",
    safetyOrder: "50",
    maxSafetyOrders: 2,
    firstStepPct: "2",
    stepMultiplier: "1",
    sizeMultiplier: "1",
    takeProfitPct: "1",
    stopLossPct: "10",
  });
  const running = () =>
    runSim(futuresDca, fut, v1, [{ at: 0, price: "100", market: "ETH-USD" }], fees);

  it("keeps the short and places a reduce-only take profit for it", () => {
    const r = running();
    expect(r.state.ledger.position).toBe("-1");
    const applied = must(apply(futuresDca, { ...fut, takeProfitPct: "2" }, r.state, v2));
    const out = futuresDca.step(
      { ...fut, takeProfitPct: "2" },
      applied,
      tick("ETH-USD", "100"),
      v2,
    );
    const placed = places(out.actions);
    expect(placed.some((o) => o.type === "market")).toBe(false);
    expect(placed.find((o) => o.side === "buy")).toMatchObject({
      price: "98",
      quantity: "1",
      reduceOnly: true,
    });
    expect(out.state.ledger.position).toBe("-1");
  });

  it("waits for the cycle to close when the new version flips the direction", () => {
    const r = running();
    expect(apply(futuresDca, { ...fut, direction: "long" }, r.state, v2)).toBeNull();
  });
});

describe("AI DCA: version apply", () => {
  const ctx: StepContext = {
    botId: "adca",
    version: 2,
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
  const inCycle = (): AdaptiveDcaState => ({
    ...adaptiveDca.initialState(c),
    phase: "in_cycle",
    cycle: 3,
    ledger: { ...applyFill(emptyLedger(), "buy", "80000", "0.00125", "0.02"), fees: "0.5" },
    cycleFeesStart: "0.3",
    cycleFundingStart: "0",
    lastPrice: "80000",
    lastFillPrice: "80000",
    atr: "400",
    tpId: "v1-tp",
    safetyId: "v1-so1",
    nextSafety: 1,
    orders: {
      "v1-tp": { kind: "exit", qty: "0.00125", filled: "0", cost: "0" },
      "v1-so1": { kind: "entry", qty: "0.00126", filled: "0", cost: "0" },
    },
  });

  it("keeps the position, then places the take profit and next order from it", () => {
    const applied = must(apply(adaptiveDca, c, inCycle(), ctx));
    expect(applied.ledger).toMatchObject({ position: "0.00125", avgCost: "80000", fees: "0" });
    // Phí đã trả của chu kỳ (0.2) vẫn tính vào giá hoà vốn.
    expect(applied.cycleFeesStart).toBe("-0.2");
    expect(applied.cancelled).toEqual({ "v1-tp": "exit", "v1-so1": "entry" });
    const out = adaptiveDca.step(c, applied, tick("BTC-USD", "79900"), ctx);
    const placed = places(out.actions);
    expect(placed.some((o) => o.type === "market")).toBe(false);
    expect(placed.map((o) => [o.side, o.reduceOnly])).toEqual([
      ["sell", true],
      ["buy", false],
    ]);
    expect(placed[0]?.quantity).toBe("0.00125");
    expect(out.state.phase).toBe("in_cycle");
    expect(out.state.ledger.position).toBe("0.00125");
  });

  it("books a late fill of the v1 order cancelled by the apply", () => {
    const applied = must(apply(adaptiveDca, c, inCycle(), ctx));
    const started = adaptiveDca.step(c, applied, tick("BTC-USD", "79900"), ctx);
    const late = adaptiveDca.step(c, started.state, fill("v1-so1", "79600", "0.00126"), ctx);
    expect(late.state.ledger.position).toBe("0.00251");
    expect(places(late.actions)[0]).toMatchObject({ side: "sell", quantity: "0.00251" });
  });

  it("waits while an entry or exit order is in flight, or the direction flips", () => {
    expect(apply(adaptiveDca, c, { ...inCycle(), phase: "entering", baseId: "b" }, ctx)).toBeNull();
    expect(apply(adaptiveDca, c, { ...inCycle(), phase: "exiting", exitId: "x" }, ctx)).toBeNull();
    expect(apply(adaptiveDca, { ...c, direction: "short" }, inCycle(), ctx)).toBeNull();
  });
});

describe("TWAP: version apply keeps what was already filled", () => {
  const ctx: StepContext = {
    botId: "tw",
    version: 2,
    feeRate: "0",
    rules: {
      vBTC_vUSDC: { tickSize: "1", stepSize: "0.01", minQuantity: "0.01", minNotional: "1" },
    },
  };
  const c = twapSchema.parse({
    market: "vBTC_vUSDC",
    engine: "spot",
    side: "buy",
    totalSize: "1",
    durationMinutes: 60,
    slices: 4,
    reduceOnly: false,
    maxSlippagePct: "0.3",
    onSkip: "add_to_end",
  });
  const half = (): TwapState => ({
    ...twap.initialState(c),
    phase: "running",
    startedAt: 0,
    arrivalPrice: "50000",
    lastPrice: "50000",
    sliceIndex: 2,
    filled: "0.5",
    ledger: applyFill(emptyLedger(), "buy", "50000", "0.5", "0"),
    orders: { "v1-twap-2": { qty: "0.25", filled: "0.25" } },
  });
  const timer = (at: number): StrategyEvent => ({ type: "timer", at });

  it("buys only the rest of the total, never the whole size again", () => {
    const applied = must(apply(twap, c, half(), ctx));
    expect(applied).toMatchObject({ filled: "0.5", sliceIndex: 2 });
    expect(applied.ledger.position).toBe("0.5");
    let s = applied;
    const bought: OrderIntent[] = [];
    for (const at of [30 * 60_000, 45 * 60_000, 60 * 60_000]) {
      const out = twap.step(c, s, timer(at), ctx);
      const placed = places(out.actions);
      bought.push(...placed);
      s = out.state;
      for (const o of placed)
        s = twap.step(c, s, fill(o.clOrdID, "50000", o.quantity, at), ctx).state;
    }
    expect(sumQty(bought, "buy").toString()).toBe("0.5");
    expect(s.filled).toBe("1");
  });

  it("finishes without an order when the new total is already filled", () => {
    const smaller = { ...c, totalSize: "0.4" };
    const applied = must(apply(twap, smaller, half(), ctx));
    const out = twap.step(smaller, applied, timer(30 * 60_000), ctx);
    expect(places(out.actions)).toEqual([]);
    expect(out.actions).toContainEqual(expect.objectContaining({ type: "stop" }));
  });

  it("waits while a slice is in flight, and places no new slice while a version waits", () => {
    expect(apply(twap, c, { ...half(), pending: "v1-twap-3", pendingAt: 1 }, ctx)).toBeNull();
    const out = twap.step(c, half(), timer(30 * 60_000), { ...ctx, versionPending: 3 });
    expect(places(out.actions)).toEqual([]);
  });
});

describe("funding arb: version apply keeps both legs", () => {
  const ctx: StepContext = { botId: "arb", version: 2, rules: {}, feeRate: "0" };
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
  const held = (): FundingArbState => ({
    ...fundingArb.initialState(c),
    phase: "in_position",
    cycle: 1,
    spot: applyFill(emptyLedger(), "buy", "50000", "0.02", "0"),
    perp: applyFill(emptyLedger(), "sell", "50000", "0.02", "0"),
    prices: { vBTC_vUSDC: "50000", "BTC-USD": "50000" },
  });

  it("keeps watching the open legs and never enters again on top of them", () => {
    const applied = must(apply(fundingArb, c, held(), ctx));
    expect(applied.phase).toBe("in_position");
    expect([applied.spot.position, applied.perp.position]).toEqual(["0.02", "-0.02"]);
    const out = fundingArb.step(
      c,
      applied,
      { type: "fundingRate", at: 1, market: "BTC-USD", current: "0.05", avg7d: "0.05" },
      ctx,
    );
    expect(places(out.actions)).toEqual([]);
  });

  it("waits while orders are in flight, and does not enter while a version waits", () => {
    expect(
      apply(fundingArb, c, { ...held(), phase: "opening", pending: { a: "spot" } }, ctx),
    ).toBeNull();
    const out = fundingArb.step(
      c,
      { ...fundingArb.initialState(c), prices: held().prices },
      { type: "fundingRate", at: 1, market: "BTC-USD", current: "0.05", avg7d: "0.05" },
      { ...ctx, versionPending: 3 },
    );
    expect(places(out.actions)).toEqual([]);
  });
});

describe("copy trade: version apply keeps the copied position", () => {
  const rules = { tickSize: "0.01", stepSize: "0.0001", minQuantity: "0.0001", minNotional: "10" };
  const ctx: StepContext = { botId: "copy", version: 2, rules: { "BTC-USD": rules }, feeRate: "0" };
  const c = copyTradeSchema.parse({
    leaderSource: "hyperliquid",
    leaderAddress: "0x2222222222222222222222222222222222222222",
    markets: ["BTC-USD"],
    leverage: 2,
    fixedNotional: "1000",
    maxNotionalPerTrade: "1000",
    maxExposure: "1500",
    maxLoss: "100",
  });
  const btc: CopyMarketState = {
    ledger: applyFill(emptyLedger(), "buy", "50000", "0.02", "0"),
    lastPrice: "50000",
    leaderPos: "1",
    tracking: true,
    target: "0.02",
    refPrice: "50000",
    refAt: 0,
    inflight: null,
    reduceAttempts: 0,
    openRejects: 0,
  };
  const copying = () => ({ ...normalizeCopyState(c, {}), markets: { "BTC-USD": btc }, seq: 4 });

  it("closes the kept position when the leader closes, and does not open it again", () => {
    const applied = must(apply(copyTrade, c, copying(), ctx));
    expect(applied.markets["BTC-USD"]).toMatchObject({
      tracking: true,
      target: "0.02",
      leaderPos: "1",
    });
    expect(applied.markets["BTC-USD"]?.ledger.position).toBe("0.02");
    const out = copyTrade.step(
      c,
      applied,
      {
        type: "leaderFill",
        at: 1000,
        leaderAt: 900,
        market: "BTC-USD",
        side: "sell",
        price: "50000",
        quantity: "1",
        positionAfter: "0",
      },
      ctx,
    );
    expect(places(out.actions)).toEqual([
      expect.objectContaining({ side: "sell", quantity: "0.02", reduceOnly: true }),
    ]);
  });

  it("places nothing on its own right after the apply", () => {
    const applied = must(apply(copyTrade, c, copying(), ctx));
    const out = copyTrade.step(c, applied, { type: "timer", at: 1000 }, ctx);
    expect(places(out.actions)).toEqual([]);
  });

  it("waits while a copy order is in flight", () => {
    const busy = {
      ...copying(),
      markets: {
        "BTC-USD": {
          ...btc,
          inflight: {
            id: "x",
            kind: "open" as const,
            side: "buy" as const,
            qty: "0.01",
            filled: "0",
            aim: "0.03",
          },
        },
      },
    };
    expect(apply(copyTrade, c, busy, ctx)).toBeNull();
  });
});
