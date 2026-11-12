import { describe, expect, it } from "vitest";

import { backtest, type Candle } from "../backtest";
import { initialDcaState, type DcaBotState } from "../common/dca-bot";
import { entryReady } from "../common/entry";
import type { StepContext, StrategyAction } from "../core/types";
import { futuresDca } from "../futures-dca";
import { futuresDcaSchema } from "../futures-dca/schema";
import { futuresGrid } from "../futures-grid";
import { futuresGridSchema } from "../futures-grid/schema";
import { runSim } from "../sim/exchange";
import { spotDca } from "../spot-dca";
import { spotDcaSchema } from "../spot-dca/schema";
import { spotGrid } from "../spot-grid";
import { spotGridSchema } from "../spot-grid/schema";

// IMP-01 First entry và IMP-02 Next cycle (DEC-91).

const rules = { tickSize: "0.01", stepSize: "0.0001", minQuantity: "0.0001", minNotional: "5" };
const ctx: StepContext = {
  botId: "bot-entry",
  version: 1,
  feeRate: "0.0005",
  rules: { "ETH-USD": rules, vETH_vUSDC: rules },
};
const fees = { makerFee: "0", takerFee: "0" };
const ticks = (market: string, prices: number[]) =>
  prices.map((p, i) => ({ at: i * 60_000, price: String(p), market }));
const placed = (actions: StrategyAction[]) =>
  actions.flatMap((a) => (a.type === "place" ? [a.order] : []));
const bases = (actions: StrategyAction[]) => placed(actions).filter((o) => o.tag.endsWith(":base"));

const fdca = (extra: Record<string, unknown> = {}) =>
  futuresDcaSchema.parse({
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
    stopLossPct: "20",
    ...extra,
  });

describe("entryReady", () => {
  it("At price: long ≤ P, short ≥ P, neutral crosses P", () => {
    const at = { type: "at_price" as const, price: "100" };
    expect(entryReady(at, "long", null, "100")).toBe(true);
    expect(entryReady(at, "long", null, "101")).toBe(false);
    expect(entryReady(at, "short", null, "99")).toBe(false);
    expect(entryReady(at, "short", null, "100.5")).toBe(true);
    expect(entryReady(at, "neutral", null, "100")).toBe(false);
    expect(entryReady(at, "neutral", "102", "101")).toBe(false);
    expect(entryReady(at, "neutral", "102", "99")).toBe(true);
  });

  it("In a range: long ≤ H and short ≥ L even when price jumps past the range; neutral only inside", () => {
    const r = { type: "in_range" as const, low: "90", high: "100" };
    expect(entryReady(r, "long", null, "101")).toBe(false);
    expect(entryReady(r, "long", null, "95")).toBe(true);
    expect(entryReady(r, "long", null, "80")).toBe(true);
    expect(entryReady(r, "short", null, "89")).toBe(false);
    expect(entryReady(r, "short", null, "120")).toBe(true);
    expect(entryReady(r, "neutral", null, "80")).toBe(false);
    expect(entryReady(r, "neutral", null, "101")).toBe(false);
    expect(entryReady(r, "neutral", null, "90")).toBe(true);
  });
});

describe("DCA first entry", () => {
  it("places nothing while waiting, then enters exactly once (long, At price)", () => {
    const c = fdca({ entry: "at_price", entryPrice: "95" });
    const waiting = runSim(futuresDca, c, ctx, ticks("ETH-USD", [100, 98, 96]), fees);
    expect(waiting.actions.filter((a) => a.type === "place")).toHaveLength(0);
    expect(waiting.state.phase).toBe("waiting_entry");
    expect(futuresDca.waiting?.(c, waiting.state)).toEqual({
      kind: "entry",
      condition: { type: "at_price", price: "95" },
    });

    const entered = runSim(futuresDca, c, ctx, ticks("ETH-USD", [100, 94, 93, 94]), fees);
    const b = bases(entered.actions);
    expect(b).toHaveLength(1);
    expect(b[0]).toMatchObject({ type: "market", timeInForce: "IOC", side: "buy" });
    expect(futuresDca.waiting?.(c, entered.state)).toBeNull();
  });

  it("short In a range enters when price jumps above the range", () => {
    const c = fdca({ direction: "short", entry: "in_range", entryLow: "105", entryHigh: "110" });
    expect(
      bases(runSim(futuresDca, c, ctx, ticks("ETH-USD", [100, 104]), fees).actions),
    ).toHaveLength(0);
    const jumped = runSim(futuresDca, c, ctx, ticks("ETH-USD", [100, 115]), fees);
    expect(bases(jumped.actions)).toEqual([expect.objectContaining({ side: "sell" })]);
  });

  it("keeps the clOrdID of the base order unchanged", () => {
    const now = runSim(futuresDca, fdca(), ctx, ticks("ETH-USD", [100]), fees);
    const later = runSim(
      futuresDca,
      fdca({ entry: "at_price", entryPrice: "95" }),
      ctx,
      ticks("ETH-USD", [100, 95]),
      fees,
    );
    expect(bases(later.actions)[0]?.clOrdID).toBe(bases(now.actions)[0]?.clOrdID);
  });

  it("config without entry runs as Now", () => {
    const r = runSim(futuresDca, fdca(), ctx, ticks("ETH-USD", [100]), fees);
    expect(bases(r.actions)).toHaveLength(1);
  });
});

describe("DCA next cycle", () => {
  // Giá 100 → base khớp; 101 khớp take profit; Cycle sau tuỳ Next cycle.
  it("Immediately (default) opens the next cycle on the next tick", () => {
    const r = runSim(futuresDca, fdca(), ctx, ticks("ETH-USD", [100, 101.5, 101.5]), fees);
    expect(bases(r.actions)).toHaveLength(2);
  });

  it("After pullback waits until price is x% below the take-profit price (long)", () => {
    const c = fdca({ nextCycle: "after_pullback", pullbackPct: "2" });
    const r = runSim(futuresDca, c, ctx, ticks("ETH-USD", [100, 101.5, 100, 99.6]), fees);
    expect(bases(r.actions)).toHaveLength(1);
    expect(r.state.phase).toBe("waiting_entry");
    const exit = r.state.lastExitPrice ?? "";
    expect(futuresDca.waiting?.(c, r.state)).toEqual({
      kind: "pullback",
      price: String(Number(exit) * 0.98),
    });
    const after = runSim(futuresDca, c, ctx, ticks("ETH-USD", [100, 101.5, 100, 98.9]), fees);
    expect(bases(after.actions)).toHaveLength(2);
  });

  it("After pullback for short waits until price is x% above the take-profit price", () => {
    const c = fdca({ direction: "short", nextCycle: "after_pullback", pullbackPct: "2" });
    const r = runSim(futuresDca, c, ctx, ticks("ETH-USD", [100, 98.5, 100, 100.5]), fees);
    expect(bases(r.actions)).toHaveLength(1);
    const after = runSim(futuresDca, c, ctx, ticks("ETH-USD", [100, 98.5, 100, 101.1]), fees);
    expect(bases(after.actions)).toHaveLength(2);
  });

  it("Cooldown waits the fixed number of minutes chosen", () => {
    const c = fdca({ nextCycle: "cooldown", cooldownMinutes: 3 });
    // tick mỗi phút; take profit khớp ở phút 1 → mở lại từ phút 4.
    const r = runSim(futuresDca, c, ctx, ticks("ETH-USD", [100, 101.5, 101, 101, 101]), fees);
    const b = bases(r.actions);
    expect(b).toHaveLength(2);
    const second = r.actions.findIndex((a) => a.type === "place" && a.order.tag === "dca:2:base");
    expect(second).toBeGreaterThan(0);
    const early = runSim(futuresDca, c, ctx, ticks("ETH-USD", [100, 101.5, 101, 101]), fees);
    expect(bases(early.actions)).toHaveLength(1);
    expect(futuresDca.waiting?.(c, early.state)).toEqual({
      kind: "cooldown",
      until: 60_000 + 180_000,
    });
  });

  it("Same as first entry gates every cycle", () => {
    const c = fdca({ entry: "at_price", entryPrice: "100", nextCycle: "same_as_entry" });
    const r = runSim(futuresDca, c, ctx, ticks("ETH-USD", [100, 101.5, 101, 100.5]), fees);
    expect(bases(r.actions)).toHaveLength(1);
    const again = runSim(futuresDca, c, ctx, ticks("ETH-USD", [100, 101.5, 101, 99.9]), fees);
    expect(bases(again.actions)).toHaveLength(2);
  });
});

describe("compatibility", () => {
  it("old Spot DCA `price_at_or_below` still gates every cycle", () => {
    const c = spotDcaSchema.parse({
      market: "vETH_vUSDC",
      baseOrder: "100",
      safetyOrder: "100",
      maxSafetyOrders: 1,
      firstStepPct: "2",
      stepMultiplier: "1",
      sizeMultiplier: "1",
      takeProfitPct: "1",
      start: "price_at_or_below",
      startLevel: "100",
    });
    const r = runSim(spotDca, c, ctx, ticks("vETH_vUSDC", [102, 100, 101.5, 101, 100.5]), fees);
    expect(bases(r.actions)).toHaveLength(1);
    expect(r.state.phase).toBe("waiting_entry");
    const again = runSim(spotDca, c, ctx, ticks("vETH_vUSDC", [102, 100, 101.5, 101, 99]), fees);
    expect(bases(again.actions)).toHaveLength(2);
  });

  it("old Spot DCA `immediately` and a config without `start` both parse", () => {
    const base = {
      market: "vETH_vUSDC",
      baseOrder: "100",
      safetyOrder: "100",
      maxSafetyOrders: 1,
      firstStepPct: "2",
      stepMultiplier: "1",
      sizeMultiplier: "1",
      takeProfitPct: "1",
    };
    expect(spotDcaSchema.safeParse({ ...base, start: "immediately" }).success).toBe(true);
    expect(spotDcaSchema.safeParse(base).success).toBe(true);
  });

  it("old state without the new fields keeps running (phase idle, no lastExitPrice / cooldownUntil)", () => {
    const old = initialDcaState() as Partial<DcaBotState>;
    delete old.lastExitPrice;
    delete old.cooldownUntil;
    const state = { ...old, cycle: 3, completedCycles: 3 } as DcaBotState;
    const c = fdca({ nextCycle: "after_pullback", pullbackPct: "2" });
    const r = futuresDca.step(
      c,
      state,
      { type: "tick", at: 0, market: "ETH-USD", price: "100" },
      ctx,
    );
    expect(bases(r.actions)).toHaveLength(1);
  });

  it("old grid `triggerPrice` keeps the cross behaviour", () => {
    const g = futuresGridSchema.parse({
      market: "ETH-USD",
      leverage: 2,
      marginMode: "cross",
      direction: "long",
      lowerPrice: "90",
      upperPrice: "110",
      gridLevels: 5,
      spacing: "arithmetic",
      margin: "250",
      triggerPrice: "100",
      stopBelow: "50",
      maxLoss: "100",
      onStop: "close_at_market",
    });
    // Long + At price sẽ vào ngay ở 99; `triggerPrice` cũ phải chờ cắt qua 100.
    const first = runSim(futuresGrid, g, ctx, ticks("ETH-USD", [99]), fees);
    expect(placed(first.actions)).toHaveLength(0);
    expect(first.state.phase).toBe("waiting_trigger");
    const below = runSim(futuresGrid, g, ctx, ticks("ETH-USD", [99, 98]), fees);
    expect(placed(below.actions)).toHaveLength(0);
    const crossed = runSim(futuresGrid, g, ctx, ticks("ETH-USD", [99, 101]), fees);
    expect(placed(crossed.actions).length).toBeGreaterThan(0);
  });
});

describe("grid first entry", () => {
  const fgrid = (extra: Record<string, unknown>) =>
    futuresGridSchema.parse({
      market: "ETH-USD",
      leverage: 2,
      marginMode: "cross",
      direction: "neutral",
      lowerPrice: "90",
      upperPrice: "110",
      gridLevels: 5,
      spacing: "arithmetic",
      margin: "250",
      stopBelow: "50",
      maxLoss: "100",
      onStop: "close_at_market",
      ...extra,
    });

  it("Neutral In a range does not start outside the range", () => {
    const c = fgrid({ entry: "in_range", entryLow: "95", entryHigh: "100" });
    const out = runSim(futuresGrid, c, ctx, ticks("ETH-USD", [108, 105, 101]), fees);
    expect(placed(out.actions)).toHaveLength(0);
    expect(futuresGrid.waiting?.(c, out.state)).toEqual({
      kind: "entry",
      condition: { type: "in_range", low: "95", high: "100" },
    });
    const inside = runSim(futuresGrid, c, ctx, ticks("ETH-USD", [108, 97]), fees);
    expect(placed(inside.actions).length).toBeGreaterThan(0);
    expect(futuresGrid.waiting?.(c, inside.state)).toBeNull();
  });

  it("Neutral At price starts when price crosses the level", () => {
    const c = fgrid({ entry: "at_price", entryPrice: "100" });
    expect(
      placed(runSim(futuresGrid, c, ctx, ticks("ETH-USD", [105, 102]), fees).actions),
    ).toHaveLength(0);
    expect(
      placed(runSim(futuresGrid, c, ctx, ticks("ETH-USD", [105, 99]), fees).actions).length,
    ).toBeGreaterThan(0);
  });

  it("Short At price starts at or above the level", () => {
    const c = fgrid({ direction: "short", entry: "at_price", entryPrice: "104" });
    expect(
      placed(runSim(futuresGrid, c, ctx, ticks("ETH-USD", [100, 103]), fees).actions),
    ).toHaveLength(0);
    const r = runSim(futuresGrid, c, ctx, ticks("ETH-USD", [100, 105]), fees);
    expect(placed(r.actions).find((o) => o.type === "market")?.side).toBe("sell");
  });

  it("Spot grid counts as long", () => {
    const c = spotGridSchema.parse({
      market: "vETH_vUSDC",
      lowerPrice: "90",
      upperPrice: "110",
      gridLevels: 5,
      spacing: "arithmetic",
      investment: "1000",
      maxLoss: "500",
      onStop: "keep_base",
      entry: "at_price",
      entryPrice: "95",
    });
    expect(placed(runSim(spotGrid, c, ctx, ticks("vETH_vUSDC", [100]), fees).actions)).toHaveLength(
      0,
    );
    expect(
      placed(runSim(spotGrid, c, ctx, ticks("vETH_vUSDC", [100, 93]), fees).actions).length,
    ).toBeGreaterThan(0);
  });
});

describe("validation", () => {
  it("rejects a range with low ≥ high and an entry outside the grid range", () => {
    const r = futuresDcaSchema.safeParse({
      ...fdca(),
      entry: "in_range",
      entryLow: "100",
      entryHigh: "90",
    });
    expect(r.success).toBe(false);
    const g = spotGridSchema.safeParse({
      market: "vETH_vUSDC",
      lowerPrice: "90",
      upperPrice: "110",
      gridLevels: 5,
      spacing: "arithmetic",
      investment: "1000",
      maxLoss: "500",
      onStop: "keep_base",
      entry: "at_price",
      entryPrice: "120",
    });
    expect(g.success).toBe(false);
    if (!g.success) expect(g.error.issues[0]?.message).toBe("Must be inside the grid range.");
  });

  it("requires the price fields of the chosen option", () => {
    expect(futuresDcaSchema.safeParse({ ...fdca(), entry: "at_price" }).success).toBe(false);
    expect(futuresDcaSchema.safeParse({ ...fdca(), nextCycle: "cooldown" }).success).toBe(false);
    expect(futuresDcaSchema.safeParse({ ...fdca(), nextCycle: "same_as_entry" }).success).toBe(
      false,
    );
  });
});

describe("backtest", () => {
  it("uses the same entry condition (DCA waits for the price in the backtest)", () => {
    const T0 = Date.UTC(2026, 6, 1);
    const k = (i: number, p: number): Candle => ({
      t: T0 + i * 60_000,
      o: p.toFixed(2),
      h: p.toFixed(2),
      l: p.toFixed(2),
      c: p.toFixed(2),
    });
    const data = {
      markets: {
        "ETH-USD": {
          engine: "perps" as const,
          candles: [k(0, 100), k(1, 99), k(2, 97), k(3, 94), k(4, 94)],
          rules,
        },
      },
      funding: {},
      fees: { spot: { maker: "0", taker: "0" }, perps: { maker: "0", taker: "0" }, builder: "0" },
      slippage: "0",
      intervalMs: 60_000,
    };
    const r = backtest("futures_dca", { ...fdca({ entry: "at_price", entryPrice: "95" }) }, data);
    const base = r.output.fills.find((f) => f.tag === "dca:1:base");
    expect(base).toBeDefined();
    expect(Number(base?.price)).toBeLessThanOrEqual(95);
  });
});

describe("waitingOf", () => {
  it("reads the waiting condition from a saved config and state, and ignores bad input", async () => {
    const { waitingOf } = await import("../registry");
    const c = fdca({ entry: "at_price", entryPrice: "95" });
    const r = runSim(futuresDca, c, ctx, ticks("ETH-USD", [100]), fees);
    expect(waitingOf("futures_dca", c, r.state)).toEqual({
      kind: "entry",
      condition: { type: "at_price", price: "95" },
    });
    expect(waitingOf("futures_dca", { broken: true }, r.state)).toBeNull();
    expect(waitingOf("futures_dca", c, null)).toBeNull();
    expect(waitingOf("twap", {}, {})).toBeNull();
  });
});
