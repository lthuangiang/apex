import { ReasonCode } from "@drift/shared";
import { describe, expect, it } from "vitest";

import { runSim, type SimOptions } from "../sim/exchange";
import { sliceIntervalMs, twap } from "../twap";
import { twapSchema } from "../twap/schema";

const ctx = {
  botId: "bot-twap",
  version: 1,
  feeRate: "0",
  rules: {
    "BTC-USD": { tickSize: "0.1", stepSize: "0.001", minQuantity: "0.001", minNotional: "5" },
  },
};
const fees = { makerFee: "0", takerFee: "0" };
const base = twapSchema.parse({
  market: "BTC-USD",
  engine: "perps",
  side: "buy",
  totalSize: "1",
  durationMinutes: 20,
  slices: 4,
  reduceOnly: false,
  maxSlippagePct: "0.3",
  onSkip: "add_to_end",
});
const every = sliceIntervalMs(base);
const run = (prices: number[], config = base, options: SimOptions = fees) =>
  runSim(
    twap,
    config,
    ctx,
    prices.map((p, i) => ({ at: i * every, market: "BTC-USD", price: String(p) })),
    options,
    (at) => (at > 0 ? [{ type: "timer" as const, at }] : []),
  );

describe("twap", () => {
  it("splits the size into equal IOC slices capped by max slippage", () => {
    const r = run([100, 100, 100, 100, 100, 100]);
    const orders = r.actions.flatMap((a) => (a.type === "place" ? [a.order] : []));
    expect(orders.map((o) => `${o.quantity}@${o.price ?? ""}:${o.timeInForce}`)).toEqual([
      "0.25@100.3:IOC",
      "0.25@100.3:IOC",
      "0.25@100.3:IOC",
      "0.25@100.3:IOC",
    ]);
    expect(r.state.filled).toBe("1");
    expect(r.halted).toEqual({ type: "stop", reason: ReasonCode.budgetDone, close: false });
  });

  it("skips slices above the price limit and adds them to the end", () => {
    const r = run([100, 120, 100, 100, 100, 100], { ...base, priceLimit: "110" });
    expect(r.state.skipped).toBe(1);
    const sizes = r.exchange.fills.map((f) => f.quantity);
    expect(sizes).toEqual(["0.5", "0.25", "0.25"]);
    expect(r.state.filled).toBe("1");
  });

  it("leaves skipped slices unfilled when configured", () => {
    const r = run([100, 120, 100, 100, 100, 100], {
      ...base,
      priceLimit: "110",
      onSkip: "leave_unfilled",
    });
    expect(r.state.filled).toBe("0.75");
  });

  it("pauses when a slice is rejected", () => {
    const r = run([100, 100], base, { ...fees, rejectTags: () => true });
    expect(r.halted).toEqual({ type: "pause", reason: ReasonCode.orderRejected });
  });

  it("places one slice per interval when timers arrive every second", () => {
    const seconds = (at: number) =>
      Array.from({ length: Math.floor(every / 1000) }, (_, i) => ({
        type: "timer" as const,
        at: at + (i + 1) * 1000,
      }));
    const r = runSim(
      twap,
      base,
      ctx,
      [0, 1, 2, 3, 4].map((i) => ({ at: i * every, market: "BTC-USD", price: "100" })),
      fees,
      seconds,
    );
    const placed = r.actions.flatMap((a) => (a.type === "place" ? [a.order] : []));
    expect(placed).toHaveLength(4);
    expect(r.state.filled).toBe("1");
  });

  it("validates duration", () => {
    expect(twapSchema.safeParse({ ...base, durationMinutes: 2 }).success).toBe(false);
  });
});

describe("twap schema", () => {
  it("accepts a spot TWAP without reduceOnly (the form hides it for Spot)", () => {
    const spot = twapSchema.parse({
      market: "vETH_vUSDC",
      engine: "spot",
      side: "buy",
      totalSize: "0.005",
      durationMinutes: 60,
      slices: 4,
      maxSlippagePct: "0.3",
      onSkip: "add_to_end",
    });
    expect(spot.reduceOnly).toBe(false);
  });
});

describe("twap Start at (IMP-03, DEC-91)", () => {
  // 2026-11-01 09:00 tại Asia/Ho_Chi_Minh (UTC+7) = 02:00 UTC.
  const at = Date.UTC(2026, 10, 1, 2, 0);
  const later = twapSchema.parse({
    ...base,
    start: "at",
    startDate: Date.UTC(2026, 10, 1),
    startTime: "09:00",
    timeZone: "Asia/Ho_Chi_Minh",
  });
  const tick = (t: number, price = "100") =>
    ({ type: "tick", at: t, market: "BTC-USD", price }) as const;

  it("waits without orders until the start time in the Settings time zone", () => {
    let s = twap.initialState(later);
    for (const t of [at - 3_600_000, at - 1]) {
      const r = twap.step(later, s, tick(t), ctx);
      expect(r.actions).toEqual([]);
      s = r.state;
      expect(twap.waiting?.(later, s)).toEqual({ kind: "start_at", at });
      const timer = twap.step(later, s, { type: "timer", at: t }, ctx);
      expect(timer.actions).toEqual([]);
    }
    s = twap.step(later, s, tick(at, "101"), ctx).state;
    expect(s.phase).toBe("running");
    expect(s.startedAt).toBe(at);
    expect(s.arrivalPrice).toBe("101");
    expect(twap.waiting?.(later, s)).toBeNull();
    const first = twap.step(later, s, { type: "timer", at }, ctx);
    expect(first.actions.some((a) => a.type === "place")).toBe(true);
  });

  it("starts at once when the time has passed", () => {
    const s = twap.step(later, twap.initialState(later), tick(at + 60_000), ctx).state;
    expect(s.phase).toBe("running");
  });

  it("keeps old configs and old state starting now", () => {
    expect(twap.waiting?.(base, twap.initialState(base))).toBeNull();
    const old = { ...twap.initialState(base) };
    const s = twap.step(base, old, tick(5), ctx).state;
    expect(s.phase).toBe("running");
  });

  it("requires a date, a time and a time zone for At", () => {
    const r = twapSchema.safeParse({ ...base, start: "at" });
    expect(r.success).toBe(false);
    expect(r.error?.issues.map((i) => i.path.join("."))).toEqual([
      "startDate",
      "startTime",
      "startTime",
    ]);
  });
});
