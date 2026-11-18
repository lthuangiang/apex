import { dec, ReasonCode } from "@drift/shared";
import { describe, expect, it } from "vitest";

import { adaptiveDca, type AdaptiveDcaState } from "../adaptive-dca";
import { adaptiveDcaSchema } from "../adaptive-dca/schema";
import type { GridBotState } from "../common/grid-bot";
import { RETIRE_RETRY_MS } from "../common/retire";
import {
  copyTrade,
  type CopyTradeState,
  normalizeCopyState,
  VERSION_PENDING_SKIP,
  type CopyMarketState,
} from "../copy-trade";
import { copyTradeSchema } from "../copy-trade/schema";
import { applyFill, emptyLedger, type Ledger } from "../core/ledger";
import type {
  OrderIntent,
  StepContext,
  StepResult,
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

// #223 (DEC-TBD-version-apply-position): áp version mới giữ sổ cái (cả đã chốt / phí, PM chốt B2), chờ mọi lệnh version
// cũ kết thúc trước khi dựng lệnh mới (B1), ghi fill muộn theo chiều của chính lệnh (M4), không đặt lệnh market mở lại vị
// thế ban đầu, không tự đóng, và không bao giờ giữ lệnh vượt giới hạn sau một fill.

const fees = { makerFee: "0", takerFee: "0" };
const places = (actions: readonly StrategyAction[]): OrderIntent[] =>
  actions.flatMap((a) => (a.type === "place" ? [a.order] : []));
const cancels = (actions: readonly StrategyAction[]): string[] =>
  actions.flatMap((a) => (a.type === "cancel" ? [a.clOrdID] : []));
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
const fill = (
  clOrdID: string,
  price: string,
  quantity: string,
  at = 100_500,
  side?: "buy" | "sell",
): StrategyEvent => ({
  type: "fill",
  at,
  clOrdID,
  price,
  quantity,
  fee: "0",
  ...(side === undefined ? {} : { side }),
});
const done = (clOrdID: string, at = 100_600): StrategyEvent => ({ type: "orderDone", at, clOrdID });
const sumQty = (orders: readonly OrderIntent[], side: "buy" | "sell") =>
  orders.filter((o) => o.side === side).reduce((a, o) => a.add(o.quantity), dec("0"));
/** SoDEX báo kết thúc mọi lệnh version cũ đang chờ. */
function endAll<C, S extends { retiring?: Record<string, unknown> | undefined }>(
  mod: StrategyModule<C, S>,
  c: C,
  s: S,
  ctx: StepContext,
): S {
  let state = s;
  for (const id of Object.keys(s.retiring ?? {})) state = mod.step(c, state, done(id), ctx).state;
  expect(state.retiring).toBeUndefined();
  return state;
}
const gridOpen = (s: GridBotState, side: "buy" | "sell") =>
  dec(s.qty).mul(Object.values(s.open).filter((o) => o.side === side).length);
const ledger = (position: string, avgCost: string, realized = "0"): Ledger => ({
  ...emptyLedger(),
  position,
  avgCost,
  realized,
  invested: dec(position).abs().mul(avgCost).toString(),
});

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
  const short = { ...long, direction: "short" as const };
  // v1 ở 100: lệnh market 2 (long: cho bán 105, 110; short: cho mua 95, 90).
  const running = (c = long) =>
    runSim(futuresGrid, c, v1, [{ at: 0, price: "100", market: "BTC-USD" }], fees);
  const idOf = (s: GridBotState, side: "buy" | "sell", level: number) =>
    Object.entries(s.open).find(([, o]) => o.side === side && o.level === level)?.[0] ?? "";

  it("keeps the whole ledger, waits for every v1 order to end (cancelling on the first tick, then every 10 s), then builds around the position", () => {
    const r = running();
    expect(r.state.ledger.position).toBe("2");
    const old = Object.keys(r.state.open).sort();
    const c2 = { ...long, maxLoss: "150" };
    const applied = must(apply(futuresGrid, c2, r.state, v2));
    expect(applied.ledger).toEqual(r.state.ledger);
    expect(Object.keys(applied.retiring ?? {}).sort()).toEqual(old);
    // v1 chưa kết thúc: không dựng gì; nhịp đầu gửi huỷ ngay (lệnh cũ mà dòng lệnh tới sau lần quét của engine), rồi
    // không gửi lại trước 10 s.
    const first = futuresGrid.step(c2, applied, tick("BTC-USD", "100", 100_000), v2);
    expect(places(first.actions)).toEqual([]);
    expect(cancels(first.actions).sort()).toEqual(old);
    const quiet = futuresGrid.step(c2, first.state, tick("BTC-USD", "100", 105_000), v2);
    expect(quiet.actions).toEqual([]);
    const again = futuresGrid.step(
      c2,
      first.state,
      tick("BTC-USD", "100", 100_000 + RETIRE_RETRY_MS),
      v2,
    );
    expect(places(again.actions)).toEqual([]);
    expect(cancels(again.actions).sort()).toEqual(old);
    const ended = endAll(futuresGrid, c2, again.state, v2);
    const out = futuresGrid.step(c2, ended, tick("BTC-USD", "100", 120_000), v2);
    const placed = places(out.actions);
    expect(placed.some((o) => o.type === "market")).toBe(false);
    expect(placed.map((o) => `${o.side}@${o.price ?? ""}`)).toEqual([
      "sell@105",
      "sell@110",
      "buy@95",
      "buy@90",
    ]);
    // Lệnh mới mang version 2 trong clOrdID, không trùng lệnh v1 vừa huỷ.
    expect(placed.every((o) => o.clOrdID.split("-")[1] === "2")).toBe(true);
    expect(out.state.phase).toBe("running");
    expect(out.actions.at(-1)).toMatchObject({ type: "log", decision: "Grid started" });
  });

  it("B1: a v1 sell that fills while v1 orders end is in the layout, so v2 never sells more than it holds", () => {
    const r = running();
    const sell105 = idOf(r.state, "sell", 3);
    const applied = must(apply(futuresGrid, long, r.state, v2));
    const late = futuresGrid.step(long, applied, fill(sell105, "105", "1"), v2);
    expect(late.actions).toEqual([]);
    expect(late.state.ledger.position).toBe("1");
    const out = futuresGrid.step(
      long,
      endAll(futuresGrid, long, late.state, v2),
      tick("BTC-USD", "100"),
      v2,
    );
    const placed = places(out.actions);
    expect(sumQty(placed, "sell").lte(out.state.ledger.position)).toBe(true);
    expect(placed.map((o) => `${o.side}@${o.price ?? ""}`)).toEqual([
      "sell@105",
      "buy@95",
      "buy@90",
    ]);
  });

  it("B1: a v1 buy that fills while v1 orders end keeps the long within a fresh grid's worst case", () => {
    const r = running();
    const buy95 = idOf(r.state, "buy", 1);
    const applied = must(apply(futuresGrid, long, r.state, v2));
    const late = futuresGrid.step(long, applied, fill(buy95, "95", "1"), v2);
    expect(late.state.ledger.position).toBe("3");
    const out = futuresGrid.step(
      long,
      endAll(futuresGrid, long, late.state, v2),
      tick("BTC-USD", "100"),
      v2,
    );
    const placed = places(out.actions);
    // 3 + mua ≤ 5 mức × 1; bán ≤ 3.
    expect(dec(out.state.ledger.position).add(sumQty(placed, "buy")).lte(5)).toBe(true);
    expect(sumQty(placed, "sell").lte(3)).toBe(true);
  });

  it("B1 defence: a late fill after the grid started cancels open orders beyond the position (long and short)", () => {
    for (const c of [long, short]) {
      const r = running(c);
      const applied = endAll(futuresGrid, c, must(apply(futuresGrid, c, r.state, v2)), v2);
      const started = futuresGrid.step(c, applied, tick("BTC-USD", "100"), v2).state;
      // Một lệnh cũ không còn được chờ (ví dụ đã báo kết thúc rồi fill đến muộn) khớp ở phía giảm vị thế.
      const reduce = c.direction === "long" ? "sell" : "buy";
      const s0: GridBotState = {
        ...started,
        cancelled: { ghost: { level: c.direction === "long" ? 3 : 1, side: reduce } },
      };
      const out = futuresGrid.step(
        c,
        s0,
        fill("ghost", c.direction === "long" ? "105" : "95", "1"),
        v2,
      );
      expect(dec(out.state.ledger.position).abs().toString()).toBe("1");
      // Lệnh giảm vị thế không bao giờ lớn hơn vị thế; huỷ mức xa giá trước.
      expect(gridOpen(out.state, reduce).lte(1)).toBe(true);
      expect(cancels(out.actions)).toEqual([idOf(started, reduce, c.direction === "long" ? 4 : 0)]);
      // Lệnh giảm còn lại khớp: vị thế về 0, không bao giờ sang phía ngược.
      const left =
        Object.keys(out.state.open).find((id) => out.state.open[id]?.side === reduce) ?? "";
      const flat = futuresGrid.step(
        c,
        out.state,
        fill(left, c.direction === "long" ? "105" : "95", "1", 101_000),
        v2,
      );
      expect(flat.state.ledger.position).toBe("0");
      expect(gridOpen(flat.state, reduce).toString()).toBe("0");
      const add = c.direction === "long" ? "buy" : "sell";
      expect(gridOpen(flat.state, add).lte(5)).toBe(true);
    }
  });

  it("B1 flat apply: a v1 fill while v1 orders end makes v2 build around it, with no starting market order", () => {
    const neutral = { ...long, direction: "neutral" as const };
    const r = running(neutral);
    expect(r.state.ledger.position).toBe("0");
    const buy95 = idOf(r.state, "buy", 1);
    const applied = must(apply(futuresGrid, long, r.state, v2));
    const late = futuresGrid.step(long, applied, fill(buy95, "95", "1"), v2);
    const out = futuresGrid.step(
      long,
      endAll(futuresGrid, long, late.state, v2),
      tick("BTC-USD", "100"),
      v2,
    );
    const placed = places(out.actions);
    expect(placed.some((o) => o.type === "market")).toBe(false);
    expect(sumQty(placed, "sell").toString()).toBe("1");
  });

  it("never opens more of the old side when the new grid points the other way", () => {
    const r = running();
    const applied = endAll(futuresGrid, short, must(apply(futuresGrid, short, r.state, v2)), v2);
    const out = futuresGrid.step(short, applied, tick("BTC-USD", "100"), v2);
    const placed = places(out.actions);
    expect(placed.some((o) => o.type === "market")).toBe(false);
    expect(placed.filter((o) => o.side === "buy")).toEqual([]);
    expect(placed.map((o) => `${o.side}@${o.price ?? ""}`)).toEqual(["sell@105", "sell@110"]);
    expect(out.state.ledger.position).toBe("2");
  });

  it("N1: a flat apply whose carried loss already reaches max loss pauses with no orders (realized −120, max loss 100)", () => {
    const neutral = { ...long, direction: "neutral" as const };
    const flat: GridBotState = {
      ...futuresGrid.initialState(neutral),
      lastPrice: "100",
      ledger: { ...emptyLedger(), realized: "-120" },
    };
    const applied = must(apply(futuresGrid, long, flat, v2));
    const out = futuresGrid.step(long, applied, tick("BTC-USD", "100"), v2);
    expect(places(out.actions)).toEqual([]);
    expect(out.actions).toEqual([{ type: "pause", reason: ReasonCode.botMaxLoss }]);
    expect(out.state.phase).toBe("halted");
    // Resume vẫn chạm max loss: lại pause, không lệnh nào.
    const resumed = futuresGrid.step(
      long,
      out.state,
      { type: "resumed", at: 1, prices: { "BTC-USD": "100" } },
      v2,
    );
    const again = futuresGrid.step(long, resumed.state, tick("BTC-USD", "100", 101_000), v2);
    expect(places(again.actions)).toEqual([]);
    expect(again.actions).toContainEqual({ type: "pause", reason: ReasonCode.botMaxLoss });
  });

  it("starts like a new bot when the old grid was flat", () => {
    const neutral = { ...long, direction: "neutral" as const };
    const r = running(neutral);
    const applied = endAll(futuresGrid, long, must(apply(futuresGrid, long, r.state, v2)), v2);
    const out = futuresGrid.step(long, applied, tick("BTC-USD", "100"), v2);
    expect(places(out.actions)[0]).toMatchObject({ type: "market", side: "buy", quantity: "2" });
  });

  describe("B2: max loss keeps its baseline across an edit", () => {
    // Mức 70, 80, 90, 100, 110; mỗi mức 1 (450 / 5 / 90).
    const wide = { ...long, lowerPrice: "70", upperPrice: "110", margin: "225" };
    const holding = (realized: string): GridBotState => ({
      ...futuresGrid.initialState(wide),
      phase: "running",
      levels: ["70", "80", "90", "100", "110"],
      qty: "1",
      lastPrice: "79",
      ledger: ledger("5", "100", realized),
    });

    it("realized +60, holding 5 @ 100, price 79, max loss 100: still running after the edit, sells rebuilt", () => {
      const s = holding("60");
      const applied = must(apply(futuresGrid, wide, s, v2));
      expect(applied.ledger.realized).toBe("60");
      const out = futuresGrid.step(wide, applied, tick("BTC-USD", "79"), v2);
      expect(out.actions.some((a) => a.type === "pause" || a.type === "stop")).toBe(false);
      expect(out.state.phase).toBe("running");
      expect(places(out.actions).map((o) => `${o.side}@${o.price ?? ""}`)).toEqual([
        "sell@80",
        "sell@90",
        "sell@100",
        "sell@110",
      ]);
    });

    it("an edit can't escape a max-loss pause: the rebuilt grid pauses again without placing orders", () => {
      // Đã chốt −20 + 5 × (79 − 100) = −125 ≤ −100.
      const s = { ...holding("-20"), phase: "halted" as const };
      const applied = must(apply(futuresGrid, wide, s, v2));
      const out = futuresGrid.step(wide, applied, tick("BTC-USD", "79"), v2);
      expect(places(out.actions)).toEqual([]);
      expect(out.actions).toContainEqual({ type: "pause", reason: ReasonCode.botMaxLoss });
      // Người dùng nâng max loss: version mới chạy tiếp.
      const raised = { ...wide, maxLoss: "200" };
      const ok = futuresGrid.step(
        raised,
        must(apply(futuresGrid, raised, s, v2)),
        tick("BTC-USD", "79"),
        v2,
      );
      expect(ok.state.phase).toBe("running");
      expect(places(ok.actions).length).toBe(4);
    });
  });

  describe("init market order (M2, #255)", () => {
    const started = () => {
      const out = futuresGrid.step(
        long,
        futuresGrid.initialState(long),
        tick("BTC-USD", "100", 0),
        v1,
      );
      const init = places(out.actions).find((o) => o.tag === "grid:init");
      if (init === undefined) throw new Error("expected the starting market order");
      return { state: out.state, init: init.clOrdID };
    };

    it("books both partial fills of the starting IOC and places the sells once it has filled", () => {
      const { state, init } = started();
      const a = futuresGrid.step(long, state, fill(init, "100", "1", 10), v1);
      expect(places(a.actions)).toEqual([]);
      expect(a.state.initClOrdID).toBe(init);
      // Lệnh khởi tạo còn chạy: chưa áp version.
      expect(apply(futuresGrid, long, a.state, v2)).toBeNull();
      const b = futuresGrid.step(long, a.state, fill(init, "100", "1", 20), v1);
      expect(b.state.ledger.position).toBe("2");
      expect(places(b.actions).map((o) => `${o.side}@${o.price ?? ""}`)).toEqual([
        "sell@105",
        "sell@110",
      ]);
      expect(b.state.initClOrdID).toBeNull();
    });

    it("orderDone before the fill: the order is still tracked, and the late fill is booked with its sell placed", () => {
      const { state, init } = started();
      const ended = futuresGrid.step(long, state, done(init, 10), v1);
      expect(ended.state.initClOrdID).toBeNull();
      expect(ended.state.phase).toBe("running");
      expect(places(ended.actions)).toEqual([]);
      expect(ended.state.cancelled?.[init]).toMatchObject({ level: -1, side: "buy" });
      const late = futuresGrid.step(long, ended.state, fill(init, "100", "1", 20), v1);
      expect(late.state.ledger.position).toBe("1");
      expect(places(late.actions).map((o) => `${o.side}@${o.price ?? ""}`)).toEqual(["sell@105"]);
      // Version mới áp được (lệnh khởi tạo đã kết thúc).
      expect(apply(futuresGrid, long, late.state, v2)).not.toBeNull();
    });

    it("partial fill then orderDone: sells only what it filled", () => {
      const { state, init } = started();
      const a = futuresGrid.step(long, state, fill(init, "100", "1", 10), v1);
      const b = futuresGrid.step(long, a.state, done(init, 20), v1);
      expect(places(b.actions).map((o) => `${o.side}@${o.price ?? ""}`)).toEqual(["sell@105"]);
    });
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

  it("does not buy the starting coins again and never sells more coins than the ledger holds", () => {
    const r = runSim(spotGrid, grid, v1, [{ at: 0, price: "100", market: "vBTC_vUSDC" }], fees);
    expect(r.state.ledger.position).toBe("2");
    const wider = { ...grid, upperPrice: "120", gridLevels: 6 };
    const applied = endAll(spotGrid, wider, must(apply(spotGrid, wider, r.state, v2)), v2);
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

  it("waits for v1 orders to end, then places the new take profit for the kept position and no base order", () => {
    const r = running();
    expect(r.state.ledger.position).toBe("1");
    const live = [...Object.keys(r.state.safeties), r.state.tpClOrdID ?? ""].sort();
    const wider = { ...dca, takeProfitPct: "2" };
    const applied = must(apply(spotDca, wider, r.state, v2));
    expect(applied.ledger).toEqual(r.state.ledger);
    expect(Object.keys(applied.retiring ?? {}).sort()).toEqual(live);
    const waiting = spotDca.step(wider, applied, tick("vETH_vUSDC", "100"), v2);
    expect(places(waiting.actions)).toEqual([]);
    const out = spotDca.step(
      wider,
      endAll(spotDca, wider, waiting.state, v2),
      tick("vETH_vUSDC", "100"),
      v2,
    );
    const placed = places(out.actions);
    expect(placed.some((o) => o.type === "market")).toBe(false);
    expect(placed.find((o) => o.side === "sell")).toMatchObject({ price: "102", quantity: "1" });
    expect(placed.filter((o) => o.side === "buy").map((o) => o.price)).toEqual([
      "98",
      "95",
      "90.5",
    ]);
    expect(out.state.phase).toBe("in_cycle");
  });

  it("never holds more than one full cycle of the new settings", () => {
    const r = running();
    // v2: base 50 + 3 safety 50 = 200; vị thế 1 @ 100 = 100 → còn chỗ cho 2 safety.
    const small = { ...dca, baseOrder: "50", safetyOrder: "50", sizeMultiplier: "1" };
    const applied = endAll(spotDca, small, must(apply(spotDca, small, r.state, v2)), v2);
    const out = spotDca.step(small, applied, tick("vETH_vUSDC", "100"), v2);
    const buys = places(out.actions).filter((o) => o.side === "buy");
    expect(buys).toHaveLength(2);
    const held = dec(out.state.ledger.position).mul(out.state.ledger.avgCost);
    const added = buys.reduce((a, o) => a.add(dec(o.quantity).mul(o.price ?? "0")), dec("0"));
    expect(held.add(added).lte(200)).toBe(true);
  });

  it("books a late fill of a v1 safety while waiting, then sizes the take profit to the bigger position", () => {
    const r = running();
    const so1 = Object.entries(r.state.safeties).find(([, k]) => k === 1)?.[0] ?? "";
    const applied = must(apply(spotDca, dca, r.state, v2));
    const late = spotDca.step(dca, applied, fill(so1, "98", "1.0204"), v2);
    expect(late.state.ledger.position).toBe("2.0204");
    // Lệnh đã khớp đủ thì không còn chờ.
    expect(late.state.retiring?.[so1]).toBeUndefined();
    const out = spotDca.step(
      dca,
      endAll(spotDca, dca, late.state, v2),
      tick("vETH_vUSDC", "98.5"),
      v2,
    );
    expect(places(out.actions).find((o) => o.side === "sell")).toMatchObject({
      quantity: "2.0204",
    });
  });

  it("M4: after a flat direction flip, a late v1 fill is booked on its own side and the bot places nothing for it", () => {
    const fut = futuresDcaSchema.parse({
      market: "ETH-USD",
      leverage: 2,
      marginMode: "cross",
      direction: "long",
      baseOrder: "50",
      safetyOrder: "50",
      maxSafetyOrders: 2,
      firstStepPct: "2",
      stepMultiplier: "1",
      sizeMultiplier: "1",
      takeProfitPct: "1",
      stopLossPct: "10",
    });
    const ctx1: StepContext = { ...v1, rules: { "ETH-USD": rules } };
    const ctx2: StepContext = { ...ctx1, version: 2 };
    const r = runSim(futuresDca, fut, ctx1, [{ at: 0, price: "100", market: "ETH-USD" }], fees);
    const so1 = Object.entries(r.state.safeties).find(([, k]) => k === 1)?.[0] ?? "";
    // Cycle vừa chốt lời: phẳng, safety v1 đã gửi huỷ nhưng chưa kết thúc.
    const flat = {
      ...r.state,
      phase: "idle" as const,
      ledger: { ...r.state.ledger, position: "0" },
      safeties: {},
      tpClOrdID: null,
    };
    const toShort = { ...fut, direction: "short" as const };
    const applied = must(apply(futuresDca, toShort, flat, ctx2));
    expect(applied.retiring?.[so1]).toMatchObject({ side: "buy" });
    // Sim không gửi chiều: dùng chiều đã nhớ (mua), không phải chiều vào của cấu hình mới (bán).
    const late = futuresDca.step(toShort, applied, fill(so1, "98", "1"), ctx2);
    expect(late.state.ledger.position).toBe("1");
    const out = futuresDca.step(
      toShort,
      endAll(futuresDca, toShort, late.state, ctx2),
      tick("ETH-USD", "99"),
      ctx2,
    );
    expect(places(out.actions)).toEqual([]);
    expect(out.actions).toContainEqual({ type: "flag", needsAttention: true });
    expect(out.actions).toContainEqual(
      expect.objectContaining({ type: "log", decision: "Waiting" }),
    );
    // Engine gửi kèm chiều: chiều đó thắng.
    const sold = futuresDca.step(toShort, applied, fill(so1, "98", "1", 100_500, "sell"), ctx2);
    expect(sold.state.ledger.position).toBe("-1");
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

  it("N1: a flat apply with realized −60 and max loss 50 places no base order and pauses", () => {
    const c = { ...dca, maxLoss: "50" };
    const idle = {
      ...spotDca.initialState(c),
      lastPrice: "100",
      ledger: { ...emptyLedger(), realized: "-60" },
    };
    const applied = must(apply(spotDca, c, idle, v2));
    const out = spotDca.step(c, applied, tick("vETH_vUSDC", "100"), v2);
    expect(places(out.actions)).toEqual([]);
    expect(out.actions).toEqual([{ type: "pause", reason: ReasonCode.botMaxLoss }]);
    expect(out.state.phase).toBe("halted");
  });

  it("N2: stop loss and max loss still guard the kept position while v1 orders end", () => {
    const r = running();
    // Long 1 @ 100. Stop loss 10%: giá 89 chạm trong lúc chờ lệnh cũ.
    const sl = { ...dca, stopLossPct: "10" };
    const waiting = must(apply(spotDca, sl, r.state, v2));
    expect(waiting.retiring).toBeDefined();
    const hit = spotDca.step(sl, waiting, tick("vETH_vUSDC", "89"), v2);
    expect(places(hit.actions)).toEqual([]);
    expect(hit.actions).toContainEqual({ type: "stop", reason: ReasonCode.stopLoss, close: true });
    const ml = { ...dca, maxLoss: "5" };
    const paused = spotDca.step(
      ml,
      must(apply(spotDca, ml, r.state, v2)),
      tick("vETH_vUSDC", "94"),
      v2,
    );
    expect(places(paused.actions)).toEqual([]);
    expect(paused.actions).toContainEqual({ type: "pause", reason: ReasonCode.botMaxLoss });
    // Không chạm: chỉ gửi huỷ lại lệnh cũ, chưa dựng gì.
    const calm = spotDca.step(
      dca,
      must(apply(spotDca, dca, r.state, v2)),
      tick("vETH_vUSDC", "99"),
      v2,
    );
    expect(places(calm.actions)).toEqual([]);
    expect(calm.actions.every((a) => a.type === "cancel")).toBe(true);
  });

  it("starts like a new bot when no cycle holds a position, keeping the session ledger", () => {
    const idle = {
      ...spotDca.initialState(dca),
      lastPrice: "100",
      completedCycles: 3,
      ledger: { ...emptyLedger(), realized: "12" },
    };
    const applied = must(apply(spotDca, dca, idle, v2));
    expect(applied).toMatchObject({ phase: "idle", completedCycles: 3 });
    expect(applied.ledger.realized).toBe("12");
    const out = spotDca.step(dca, applied, tick("vETH_vUSDC", "100"), v2);
    expect(places(out.actions)[0]).toMatchObject({ type: "market" });
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
    const c2 = { ...fut, takeProfitPct: "2" };
    const applied = endAll(futuresDca, c2, must(apply(futuresDca, c2, r.state, v2)), v2);
    const out = futuresDca.step(c2, applied, tick("ETH-USD", "100"), v2);
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

  it("resumes a bot paused for max loss into a new version without escaping the limit", () => {
    const c = { ...fut, maxLoss: "5" };
    const s = { ...running().state, phase: "halted" as const };
    // Short 1 @ 100, giá 106: −6 ≤ −5.
    const applied = endAll(futuresDca, c, must(apply(futuresDca, c, s, v2)), v2);
    const resumed = futuresDca.step(
      c,
      applied,
      { type: "resumed", at: 1, prices: { "ETH-USD": "106" } },
      v2,
    );
    expect(places(resumed.actions)).toEqual([]);
    expect(resumed.actions).toContainEqual({ type: "pause", reason: ReasonCode.botMaxLoss });
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

  it("keeps the ledger and cycle baseline, waits for v1 orders to end, then places the take profit and next order", () => {
    const applied = must(apply(adaptiveDca, c, inCycle(), ctx));
    expect(applied.ledger).toEqual(inCycle().ledger);
    expect(applied.cycleFeesStart).toBe("0.3");
    expect(applied.retiring).toEqual({
      "v1-tp": { side: "sell", qty: "0.00125", filled: "0", cancelAt: null },
      "v1-so1": { side: "buy", qty: "0.00126", filled: "0", cancelAt: null },
    });
    const waiting = adaptiveDca.step(c, applied, tick("BTC-USD", "79900"), ctx);
    expect(places(waiting.actions)).toEqual([]);
    const out = adaptiveDca.step(
      c,
      endAll(adaptiveDca, c, waiting.state, ctx),
      tick("BTC-USD", "79900"),
      ctx,
    );
    const placed = places(out.actions);
    expect(placed.some((o) => o.type === "market")).toBe(false);
    expect(placed.map((o) => [o.side, o.reduceOnly])).toEqual([
      ["sell", true],
      ["buy", false],
    ]);
    expect(placed[0]?.quantity).toBe("0.00125");
    expect(out.state.phase).toBe("in_cycle");
  });

  it("books a late fill of the v1 order while waiting, and sizes the take profit to it", () => {
    const applied = must(apply(adaptiveDca, c, inCycle(), ctx));
    const late = adaptiveDca.step(c, applied, fill("v1-so1", "79600", "0.00126"), ctx);
    expect(late.state.ledger.position).toBe("0.00251");
    const out = adaptiveDca.step(
      c,
      endAll(adaptiveDca, c, late.state, ctx),
      tick("BTC-USD", "79900"),
      ctx,
    );
    expect(places(out.actions)[0]).toMatchObject({ side: "sell", quantity: "0.00251" });
  });

  it("M4: after a flat flip to short, a late v1 buy is booked as a buy", () => {
    const flat: AdaptiveDcaState = {
      ...adaptiveDca.initialState(c),
      lastPrice: "80000",
      cancelled: { "v1-so2": "entry" },
      orders: { "v1-so2": { kind: "entry", side: "buy", qty: "0.001", filled: "0", cost: "0" } },
    };
    const toShort = { ...c, direction: "short" as const };
    const applied = must(apply(adaptiveDca, toShort, flat, ctx));
    const late = adaptiveDca.step(toShort, applied, fill("v1-so2", "79000", "0.001"), ctx);
    expect(late.state.ledger.position).toBe("0.001");
    // State cũ không nhớ chiều: chiều engine gửi kèm thắng.
    const legacy = must(
      apply(
        adaptiveDca,
        toShort,
        { ...flat, orders: { "v1-so2": { kind: "entry", qty: "0.001", filled: "0", cost: "0" } } },
        ctx,
      ),
    );
    const sent = adaptiveDca.step(
      toShort,
      legacy,
      fill("v1-so2", "79000", "0.001", 100_500, "buy"),
      ctx,
    );
    expect(sent.state.ledger.position).toBe("0.001");
  });

  it("N2: max loss and the hard stop still guard the kept position while v1 orders end", () => {
    const waiting = must(apply(adaptiveDca, c, inCycle(), ctx));
    // Hard stop (mặc định của schema) chạm: lệnh đóng market reduce-only, không dựng lệnh mới.
    const drop = String(80000 * (1 - Number(c.hardStopLossPct) / 100) - 100);
    const hard = adaptiveDca.step(c, waiting, tick("BTC-USD", drop), ctx);
    const placed = places(hard.actions);
    expect(placed).toEqual([
      expect.objectContaining({ type: "market", side: "sell", reduceOnly: true }),
    ]);
    const small = { ...c, maxLoss: "1" };
    const stopped = adaptiveDca.step(
      small,
      must(apply(adaptiveDca, small, inCycle(), ctx)),
      tick("BTC-USD", "79000"),
      ctx,
    );
    expect(places(stopped.actions)).toEqual([]);
    expect(stopped.actions).toContainEqual({
      type: "stop",
      reason: ReasonCode.botMaxLoss,
      close: true,
    });
  });

  it("N1: a flat apply past max loss never starts a cycle", () => {
    const small = { ...c, maxLoss: "1" };
    const flat: AdaptiveDcaState = {
      ...adaptiveDca.initialState(small),
      lastPrice: "80000",
      atr: "400",
      rsi: 10,
      regime: "SIDEWAY",
      ledger: { ...emptyLedger(), realized: "-2" },
    };
    const applied = must(apply(adaptiveDca, small, flat, ctx));
    const out = adaptiveDca.step(small, applied, { type: "timer", at: 1 }, ctx);
    expect(places(out.actions)).toEqual([]);
    expect(out.actions).toContainEqual(
      expect.objectContaining({ type: "stop", reason: ReasonCode.botMaxLoss }),
    );
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

  it("waits while a slice is in flight; once it ends, no new slice goes out before the apply", () => {
    const busy = {
      ...half(),
      pending: "v1-twap-3",
      pendingAt: 1,
      orders: { ...half().orders, "v1-twap-3": { qty: "0.25", filled: "0" } },
    };
    expect(apply(twap, c, busy, ctx)).toBeNull();
    // Lát xong; `versionPending` còn tới vòng áp kế tiếp: nhịp đồng hồ trong khoảng đó không đặt lát mới.
    const ended = twap.step(c, busy, done("v1-twap-3", 2), { ...ctx, versionPending: 3 });
    const out = twap.step(c, ended.state, timer(30 * 60_000), { ...ctx, versionPending: 3 });
    expect(places(out.actions)).toEqual([]);
    expect(apply(twap, c, out.state, ctx)).not.toBeNull();
  });

  it("M4: after a Buy → Sell flip, a late v1 slice fill is booked as a buy and does not count toward the sell", () => {
    const s = {
      ...half(),
      orders: { ...half().orders, "v1-twap-3": { qty: "0.25", filled: "0" } },
    };
    const sell = { ...c, side: "sell" as const };
    const applied = must(apply(twap, sell, s, ctx));
    expect(applied.filled).toBe("0");
    expect(applied.orders?.["v1-twap-3"]?.side).toBe("buy");
    // Các lát bán mới không đẩy lát cũ chưa kết thúc khỏi bộ nhớ.
    let st: TwapState = { ...applied, phase: "running", startedAt: 0, lastPrice: "50000" };
    for (let i = 0; i < 4; i += 1) {
      const out = twap.step(sell, st, timer(i * 15 * 60_000), ctx);
      st = out.state;
      const id = places(out.actions)[0]?.clOrdID;
      if (id !== undefined) st = twap.step(sell, st, done(id, i * 15 * 60_000 + 1), ctx).state;
    }
    expect(st.orders?.["v1-twap-3"]).toBeDefined();
    const late = twap.step(sell, st, fill("v1-twap-3", "50000", "0.25"), ctx);
    expect(late.state.ledger.position).toBe("0.75");
    expect(late.state.filled).toBe(st.filled);
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
  const held = (perp = "0.02"): FundingArbState => ({
    ...fundingArb.initialState(c),
    phase: "in_position",
    cycle: 1,
    spot: applyFill(emptyLedger(), "buy", "50000", "0.02", "0"),
    perp: applyFill(emptyLedger(), "sell", "50000", perp, "0"),
    prices: { vBTC_vUSDC: "50000", "BTC-USD": "50000" },
  });
  const funding = (current: string, at = 1): StrategyEvent => ({
    type: "fundingRate",
    at,
    market: "BTC-USD",
    current,
    avg7d: current,
  });

  it("keeps watching the open legs and never enters again on top of them", () => {
    const applied = must(apply(fundingArb, c, held(), ctx));
    expect(applied.phase).toBe("in_position");
    expect([applied.spot.position, applied.perp.position]).toEqual(["0.02", "-0.02"]);
    expect(places(fundingArb.step(c, applied, funding("0.05"), ctx).actions)).toEqual([]);
  });

  it("an unbalanced carried pair places nothing on apply and closes both legs at their own sizes on exit", () => {
    const applied = must(apply(fundingArb, c, held("0.01"), ctx));
    expect(applied.phase).toBe("in_position");
    let s = applied;
    let last: StepResult<FundingArbState> = { actions: [], state: s };
    for (let i = 0; i < 3; i += 1) {
      last = fundingArb.step(c, s, funding("-0.01", i + 1), ctx);
      s = last.state;
    }
    expect(
      places(last.actions).map(
        (o) => `${o.market} ${o.side} ${o.quantity} ${String(o.reduceOnly)}`,
      ),
    ).toEqual(["vBTC_vUSDC sell 0.02 false", "BTC-USD buy 0.01 true"]);
  });

  it("N1: a flat apply past max loss never enters, and pauses", () => {
    const flat = {
      ...fundingArb.initialState(c),
      prices: held().prices,
      spot: { ...emptyLedger(), realized: "-150" },
    };
    const applied = must(apply(fundingArb, c, flat, ctx));
    const out = fundingArb.step(c, applied, funding("0.05"), ctx);
    expect(places(out.actions)).toEqual([]);
    expect(out.actions).toEqual([{ type: "pause", reason: ReasonCode.botMaxLoss }]);
  });

  it("waits while orders are in flight, and does not enter while a version waits", () => {
    expect(
      apply(fundingArb, c, { ...held(), phase: "opening", pending: { a: "spot" } }, ctx),
    ).toBeNull();
    const out = fundingArb.step(
      c,
      { ...fundingArb.initialState(c), prices: held().prices },
      funding("0.05"),
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
  const leader = (
    side: "buy" | "sell",
    quantity: string,
    positionAfter: string,
    at = 1000,
  ): StrategyEvent => ({
    type: "leaderFill",
    at,
    leaderAt: at - 100,
    market: "BTC-USD",
    side,
    price: "50000",
    quantity,
    positionAfter,
  });

  it("closes the kept position when the leader closes, and does not open it again", () => {
    const applied = must(apply(copyTrade, c, copying(), ctx));
    expect(applied.markets["BTC-USD"]).toMatchObject({
      tracking: true,
      target: "0.02",
      leaderPos: "1",
    });
    expect(applied.markets["BTC-USD"]?.ledger).toEqual(btc.ledger);
    const out = copyTrade.step(c, applied, leader("sell", "1", "0"), ctx);
    expect(places(out.actions)).toEqual([
      expect.objectContaining({ side: "sell", quantity: "0.02", reduceOnly: true }),
    ]);
  });

  it("places nothing on its own right after the apply", () => {
    const applied = must(apply(copyTrade, c, copying(), ctx));
    expect(places(copyTrade.step(c, applied, { type: "timer", at: 1000 }, ctx).actions)).toEqual(
      [],
    );
  });

  it("M5: while a version waits, new opens are skipped but cuts still go out, so the apply can complete", () => {
    const pending = { ...ctx, version: 1, versionPending: 2 };
    let s: CopyTradeState = {
      ...copying(),
      markets: {
        "BTC-USD": { ...btc, leaderPos: "0", tracking: false, target: "0", ledger: emptyLedger() },
      },
    };
    // Trader mở liên tục: không lệnh mở nào được gửi.
    for (let i = 0; i < 5; i += 1) {
      const out = copyTrade.step(c, s, leader("buy", "1", String(i + 1), 1000 + i * 1000), pending);
      expect(places(out.actions)).toEqual([]);
      s = out.state;
    }
    expect(copyTrade.step(c, copying(), leader("buy", "1", "2"), pending).actions).toContainEqual(
      expect.objectContaining({ type: "log", decision: "Skipped", why: VERSION_PENDING_SKIP }),
    );
    expect(apply(copyTrade, c, s, ctx)).not.toBeNull();
    // Trader cắt vị thế đang copy: lệnh giảm vẫn đi.
    const cut = copyTrade.step(c, copying(), leader("sell", "0.5", "0.5"), pending);
    expect(places(cut.actions)).toEqual([
      expect.objectContaining({ side: "sell", quantity: "0.01", reduceOnly: true }),
    ]);
  });

  it("N1: a carried loss past max loss never opens a copy, and pauses", () => {
    const flat = {
      ...copying(),
      markets: {
        "BTC-USD": {
          ...btc,
          ledger: { ...emptyLedger(), realized: "-150" },
          leaderPos: "0",
          tracking: false,
          target: "0",
        },
      },
    };
    const applied = must(apply(copyTrade, c, flat, ctx));
    const out = copyTrade.step(c, applied, leader("buy", "1", "1"), ctx);
    expect(places(out.actions)).toEqual([]);
    expect(out.actions).toContainEqual({ type: "pause", reason: ReasonCode.botMaxLoss });
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
