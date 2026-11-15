import { describe, expect, it } from "vitest";

import { clOrdId } from "../core/ids";
import type { StepContext, StrategyAction, StrategyEvent } from "../core/types";
import { requirementOf } from "../requirements";
import {
  costPerMillion,
  VM_KEEP_DONE_MS,
  volumeMaker,
  type VolumeMakerState,
} from "../volume-maker";
import { vmMaxInventory, volumeMakerSchema, type VolumeMakerConfig } from "../volume-maker/schema";

const ctx: StepContext = {
  botId: "vm-bot",
  version: 1,
  rules: {
    "BTC-USD": { tickSize: "0.1", stepSize: "0.0001", minQuantity: "0.0001", minNotional: "5" },
  },
  feeRate: "0.00065",
};
const cfg = (over: Partial<VolumeMakerConfig> = {}): VolumeMakerConfig =>
  volumeMakerSchema.parse({
    market: "BTC-USD",
    leverage: 1,
    volumeTarget: "100000",
    orderSize: "500",
    distanceBp: "1",
    maxInventory: "2000",
    refreshSeconds: 3,
    runUntil: "target_or_budget",
    costBudget: "300",
    inventoryLossStop: "60",
    onStop: "close_inventory",
    ...over,
  });
/** clOrdID tất định cho một tag (giống engine tính). */
const id = (tag: string) => clOrdId(ctx.botId, ctx.version, tag);

function run(c: VolumeMakerConfig, events: StrategyEvent[]) {
  let s: VolumeMakerState = volumeMaker.initialState(c);
  const all: StrategyAction[] = [];
  for (const e of events) {
    const r = volumeMaker.step(c, s, e, ctx);
    s = r.state;
    all.push(...r.actions);
  }
  return { s, all };
}
const places = (a: StrategyAction[]) => a.flatMap((x) => (x.type === "place" ? [x.order] : []));
/** Lần tick đầu tiên luôn báo giá chu kỳ 1: bid `vm:1:bid`, ask `vm:1:ask`. */
const firstQuote = () => [{ type: "tick", at: 0, market: "BTC-USD", price: "100000" }] as const;

describe("volume maker schema", () => {
  it("validates the documented field rules", () => {
    const msgs = (v: unknown) =>
      volumeMakerSchema.safeParse(v).error?.issues.map((i) => i.message) ?? [];
    expect(msgs({ ...cfg(), leverage: 41, refreshSeconds: 1 })).toEqual(
      expect.arrayContaining(["Allowed 1–40×.", "Allowed 2–60 s."]),
    );
    expect(msgs({ ...cfg(), leverage: 0 })).toEqual(["Allowed 1–40×."]);
    expect(msgs({ ...cfg(), leverage: 40 })).toEqual([]);
    expect(msgs({ ...cfg(), maxInventory: "400", inventoryLossStop: "400" })).toEqual(
      expect.arrayContaining(["Must be above the order size.", "Must be below the budget."]),
    );
  });

  it("fills the simple form's omitted fields with documented defaults (DEC-99/100)", () => {
    const c = volumeMakerSchema.parse({ market: "ETH-USD", orderSize: "500", costBudget: "300" });
    expect(c).toMatchObject({
      leverage: 5,
      distanceBp: "1",
      refreshSeconds: 3,
      runUntil: "target_or_budget",
      onStop: "close_inventory",
    });
    expect(c.volumeTarget).toBeUndefined();
    // DEC-100: Max open position mặc định 2 × order size.
    expect(vmMaxInventory(c)).toBe("1000");
    expect(requirementOf("volume_maker", c).capital).toBe("200");
    expect(requirementOf("volume_maker", { ...c, maxInventory: "1000", leverage: 3 }).capital).toBe(
      "333.34",
    );
  });
});

describe("volume maker quoting", () => {
  it("quotes both sides post-only around the price and refreshes only after the interval", () => {
    const c = cfg();
    const { all } = run(c, [
      { type: "tick", at: 0, market: "BTC-USD", price: "100000" },
      { type: "timer", at: 1000 },
      { type: "timer", at: 3000 },
    ]);
    const o = places(all);
    expect(o.map((x) => `${x.side}@${x.price ?? ""}:${x.timeInForce}`)).toEqual([
      "buy@99990:GTX",
      "sell@100010:GTX",
      "buy@99990:GTX",
      "sell@100010:GTX",
    ]);
    expect(o.every((x) => x.type === "limit" && !x.reduceOnly)).toBe(true);
    // Lần làm mới huỷ hai báo giá cũ trước.
    expect(all.filter((x) => x.type === "cancel")).toHaveLength(2);
  });

  it("warns at 80% of the cost budget and stops at 100%, closing inventory reduce-only", () => {
    const c = cfg({ costBudget: "10", inventoryLossStop: "5" });
    let { s } = run(c, [...firstQuote()]);
    const askId = id("vm:1:ask");
    let r = volumeMaker.step(
      c,
      s,
      {
        type: "fill",
        at: 1,
        clOrdID: id("vm:1:bid"),
        price: "99990",
        quantity: "0.005",
        fee: "8.2",
      },
      ctx,
    );
    expect(r.actions).toEqual(expect.arrayContaining([{ type: "flag", needsAttention: true }]));
    s = r.state;
    r = volumeMaker.step(
      c,
      s,
      { type: "fill", at: 2, clOrdID: askId, price: "100010", quantity: "0.001", fee: "2" },
      ctx,
    );
    const stop = r.actions.find((x) => x.type === "stop");
    expect(stop).toEqual({ type: "stop", reason: "BUDGET_DONE", close: false });
    const close = places(r.actions)[0];
    expect(close).toMatchObject({ side: "sell", type: "market", reduceOnly: true });
    expect(costPerMillion(r.state)).not.toBeNull();
  });

  it("stops at the inventory loss limit and when the volume target is reached", () => {
    const c = cfg({ inventoryLossStop: "5", onStop: "keep_position" });
    let { s } = run(c, [...firstQuote()]);
    s = volumeMaker.step(
      c,
      s,
      { type: "fill", at: 1, clOrdID: id("vm:1:bid"), price: "99990", quantity: "0.005", fee: "0" },
      ctx,
    ).state;
    const r = volumeMaker.step(
      c,
      s,
      { type: "tick", at: 2, market: "BTC-USD", price: "98000" },
      ctx,
    );
    expect(r.actions.find((x) => x.type === "stop")).toMatchObject({ reason: "STOP_LOSS" });
    expect(places(r.actions)).toHaveLength(0);

    const t = cfg({ volumeTarget: "400" });
    const s2 = run(t, [...firstQuote()]).s;
    const r2 = volumeMaker.step(
      t,
      s2,
      {
        type: "fill",
        at: 1,
        clOrdID: id("vm:1:ask"),
        price: "100010",
        quantity: "0.005",
        fee: "0",
      },
      ctx,
    );
    expect(r2.actions.find((x) => x.type === "stop")).toMatchObject({ reason: "MAX_CYCLES" });
  });

  it("counts quotes the engine blocked as self-trades", () => {
    const c = cfg();
    const { s } = run(c, [...firstQuote()]);
    const r = volumeMaker.step(
      c,
      s,
      { type: "orderReject", at: 1, clOrdID: id("vm:1:bid"), code: "SELF_TRADE_BLOCKED" },
      ctx,
    );
    expect(r.state.selfTradeBlocked).toBe(1);
    expect(r.state.orders[id("vm:1:bid")]?.status).toBe("done");
  });
});

describe("volume maker fill reconciliation (DEC-100)", () => {
  it("counts a fill that arrives for a cancelling (replaced) quote", () => {
    // firstQuote → cycle 1; timer at 3 s → cycle 2 (vm:1:bid now cancelling)
    // Fill on the old, cancelling vm:1:bid must still update the ledger.
    const c = cfg();
    const { s } = run(c, [...firstQuote(), { type: "timer", at: 3000 }]);
    expect(s.orders[id("vm:1:bid")]?.status).toBe("cancelling");
    const r = volumeMaker.step(
      c,
      s,
      {
        type: "fill",
        at: 3500,
        clOrdID: id("vm:1:bid"),
        price: "99990",
        quantity: "0.005",
        fee: "1",
      },
      ctx,
    );
    expect(r.state.ledger.position).toBe("0.005");
    expect(r.state.orders[id("vm:1:bid")]?.status).toBe("done");
    expect(r.state.requoteDue).toBe(true);
  });

  it("fill after cancel counted; next requote sizes close order to the full position", () => {
    const c = cfg();
    let { s } = run(c, [...firstQuote(), { type: "timer", at: 3000 }]);
    // Fill the old (cancelling) bid to build a long position.
    s = volumeMaker.step(
      c,
      s,
      {
        type: "fill",
        at: 3500,
        clOrdID: id("vm:1:bid"),
        price: "99990",
        quantity: "0.005",
        fee: "0",
      },
      ctx,
    ).state;
    expect(s.ledger.position).toBe("0.005");
    // Timer at 5 s: elapsed from lastRefresh(3 s) = 2 s ≥ VM_MIN_REQUOTE_MS → quote.
    const r = volumeMaker.step(c, s, { type: "timer", at: 5000 }, ctx);
    const p = places(r.actions);
    const close = p.find((o) => o.reduceOnly);
    expect(close?.side).toBe("sell");
    expect(close?.quantity).toBe("0.005");
  });

  it("caps over-fills and duplicate fills to the order's remaining quantity", () => {
    const c = cfg();
    let { s } = run(c, [...firstQuote()]);
    // Partial fill: 0.003 of 0.005.
    s = volumeMaker.step(
      c,
      s,
      { type: "fill", at: 1, clOrdID: id("vm:1:bid"), price: "99990", quantity: "0.003", fee: "0" },
      ctx,
    ).state;
    expect(s.ledger.position).toBe("0.003");
    expect(s.orders[id("vm:1:bid")]?.status).toBe("live"); // still open
    // Over-fill: engine sends 0.005 but only 0.002 remains.
    s = volumeMaker.step(
      c,
      s,
      { type: "fill", at: 2, clOrdID: id("vm:1:bid"), price: "99990", quantity: "0.005", fee: "0" },
      ctx,
    ).state;
    expect(s.ledger.position).toBe("0.005"); // capped to remaining 0.002
    expect(s.orders[id("vm:1:bid")]?.status).toBe("done");
  });
});

describe("volume maker inventory-aware quoting (DEC-100)", () => {
  // Mid=100000, distanceBp=1 (d=0.0001), orderSize=500 (qty=0.005 BTC), maxInventory=2000 USD.
  // After 1 full bid fill: pos=0.005 BTC, inv=500 USD, maxInv=2000, u=0.25.
  //   close price (sell): mid*(1 + d*(1−u)) = 100000*(1+0.000075) = 100007.5
  //   risk  price (buy):  mid*(1 − d*(2+2u)) = 100000*(1−0.00025) = 99975

  it("BUY fill: places a reduce-only SELL close and a BUY risk order at 2× distance", () => {
    const c = cfg();
    let { s } = run(c, [...firstQuote()]);
    s = volumeMaker.step(
      c,
      s,
      { type: "fill", at: 1, clOrdID: id("vm:1:bid"), price: "99990", quantity: "0.005", fee: "0" },
      ctx,
    ).state;
    const r = volumeMaker.step(c, s, { type: "timer", at: 2000 }, ctx);
    const p = places(r.actions);
    const close = p.find((o) => o.reduceOnly);
    const risk = p.find((o) => !o.reduceOnly);
    expect(close?.side).toBe("sell");
    expect(close?.price).toBe("100007.5");
    expect(close?.quantity).toBe("0.005");
    expect(risk?.side).toBe("buy");
    expect(risk?.price).toBe("99975");
  });

  it("SELL fill: places a reduce-only BUY close and a SELL risk order at 2× distance", () => {
    // pos=−0.005 (short), u=0.25.
    //   close price (buy):  mid*(1 − d*(1−u)) = 100000*(1−0.000075) = 99992.5
    //   risk  price (sell): mid*(1 + d*(2+2u)) = 100000*(1+0.00025) = 100025
    const c = cfg();
    let { s } = run(c, [...firstQuote()]);
    s = volumeMaker.step(
      c,
      s,
      {
        type: "fill",
        at: 1,
        clOrdID: id("vm:1:ask"),
        price: "100010",
        quantity: "0.005",
        fee: "0",
      },
      ctx,
    ).state;
    const r = volumeMaker.step(c, s, { type: "timer", at: 2000 }, ctx);
    const p = places(r.actions);
    const close = p.find((o) => o.reduceOnly);
    const risk = p.find((o) => !o.reduceOnly);
    expect(close?.side).toBe("buy");
    expect(close?.price).toBe("99992.5");
    expect(risk?.side).toBe("sell");
    expect(risk?.price).toBe("100025");
  });

  it("close size subtracts pending cancelling closes; restores to full after orderDone", () => {
    const c = cfg();
    let s = run(c, [...firstQuote()]).s;
    // Build long 0.005 BTC.
    s = volumeMaker.step(
      c,
      s,
      { type: "fill", at: 1, clOrdID: id("vm:1:bid"), price: "99990", quantity: "0.005", fee: "0" },
      ctx,
    ).state;
    // Cycle 2: vm:2:rc (sell close 0.005) placed.
    s = volumeMaker.step(c, s, { type: "timer", at: 2000 }, ctx).state;
    const rcId = id("vm:2:rc");
    expect(s.orders[rcId]?.qty).toBe("0.005");

    // Cycle 3 (t=5 s): vm:2:rc → cancelling; pendingClose covers remaining → no new close.
    const r3 = volumeMaker.step(c, s, { type: "timer", at: 5000 }, ctx);
    s = r3.state;
    expect(s.orders[rcId]?.status).toBe("cancelling");
    expect(places(r3.actions).filter((o) => o.reduceOnly)).toHaveLength(0);

    // orderDone confirms the cancel: vm:2:rc → done.
    s = volumeMaker.step(c, s, { type: "orderDone", at: 5100, clOrdID: rcId }, ctx).state;
    expect(s.orders[rcId]?.status).toBe("done");

    // Cycle 4 (t=8 s): pendingClose=0 → full close placed again.
    const r4 = volumeMaker.step(c, s, { type: "timer", at: 8000 }, ctx);
    const newClose = places(r4.actions).find((o) => o.reduceOnly);
    expect(newClose?.quantity).toBe("0.005");
  });

  it("closing back to flat reverts to symmetric two-sided quoting", () => {
    const c = cfg();
    let s = run(c, [...firstQuote()]).s;
    s = volumeMaker.step(
      c,
      s,
      { type: "fill", at: 1, clOrdID: id("vm:1:bid"), price: "99990", quantity: "0.005", fee: "0" },
      ctx,
    ).state;
    // Cycle 2: position-aware (close + risk).
    s = volumeMaker.step(c, s, { type: "timer", at: 2000 }, ctx).state;
    // Fill close order entirely → position returns to 0.
    s = volumeMaker.step(
      c,
      s,
      {
        type: "fill",
        at: 2500,
        clOrdID: id("vm:2:rc"),
        price: "100007.5",
        quantity: "0.005",
        fee: "0",
      },
      ctx,
    ).state;
    expect(s.ledger.position).toBe("0");
    // Cycle 3: flat → two-sided symmetric quoting (no reduce-only).
    const r = volumeMaker.step(c, s, { type: "timer", at: 4500 }, ctx);
    const p = places(r.actions);
    expect(p).toHaveLength(2);
    expect(p.every((o) => !o.reduceOnly)).toBe(true);
    expect(p.map((o) => o.side).sort()).toEqual(["buy", "sell"]);
  });

  it("dust position below SoDEX step size is treated as flat", () => {
    // Fill 0.00004 BTC (< stepSize 0.0001) → roundQty → "0" → isFlat=true → two-sided.
    const c = cfg();
    let { s } = run(c, [...firstQuote()]);
    s = volumeMaker.step(
      c,
      s,
      {
        type: "fill",
        at: 1,
        clOrdID: id("vm:1:bid"),
        price: "99990",
        quantity: "0.00004",
        fee: "0",
      },
      ctx,
    ).state;
    const r = volumeMaker.step(c, s, { type: "timer", at: 2000 }, ctx);
    const p = places(r.actions);
    expect(p.every((o) => !o.reduceOnly)).toBe(true);
    expect(p.some((o) => o.side === "buy") && p.some((o) => o.side === "sell")).toBe(true);
  });

  it("at the inventory limit: risk side is dropped, close side is still quoted", () => {
    // orderSize=100 → qty=0.001 BTC; maxInventory=101 USD → room after fill ≈ 0.00001 BTC → below minQty.
    const c = cfg({ orderSize: "100", maxInventory: "101" });
    let { s } = run(c, [...firstQuote()]);
    s = volumeMaker.step(
      c,
      s,
      { type: "fill", at: 1, clOrdID: id("vm:1:bid"), price: "99990", quantity: "0.001", fee: "0" },
      ctx,
    ).state;
    const r = volumeMaker.step(c, s, { type: "timer", at: 2000 }, ctx);
    const p = places(r.actions);
    expect(p.filter((o) => o.reduceOnly)).toHaveLength(1); // close order present
    expect(p.filter((o) => !o.reduceOnly)).toHaveLength(0); // no risk order
  });

  it("with a partial position: quotes both a close order and a risk order (not a one-sided bot)", () => {
    // u=0.25 (<1) → both close and risk sides are placed.
    const c = cfg();
    let { s } = run(c, [...firstQuote()]);
    s = volumeMaker.step(
      c,
      s,
      { type: "fill", at: 1, clOrdID: id("vm:1:bid"), price: "99990", quantity: "0.005", fee: "0" },
      ctx,
    ).state;
    const r = volumeMaker.step(c, s, { type: "timer", at: 2000 }, ctx);
    const p = places(r.actions);
    expect(p.find((o) => o.reduceOnly)?.side).toBe("sell"); // close
    expect(p.find((o) => !o.reduceOnly)?.side).toBe("buy"); // risk (still active)
  });

  it("default 2× maxInventory drives quoting prices; explicit override changes them (DEC-100)", () => {
    // Default: maxInventory=undefined → 2×500=1000; u=500/1000=0.5.
    //   close: mid*(1+d*0.5) = 100005; risk: mid*(1-d*3) = 99970.
    const cDef = volumeMakerSchema.parse({
      market: "BTC-USD",
      orderSize: "500",
      costBudget: "300",
    });
    let sDef = run(cDef, [...firstQuote()]).s;
    sDef = volumeMaker.step(
      cDef,
      sDef,
      { type: "fill", at: 1, clOrdID: id("vm:1:bid"), price: "99990", quantity: "0.005", fee: "0" },
      ctx,
    ).state;
    const pDef = places(volumeMaker.step(cDef, sDef, { type: "timer", at: 2000 }, ctx).actions);
    expect(pDef.find((o) => o.reduceOnly)?.price).toBe("100005");
    expect(pDef.find((o) => !o.reduceOnly)?.price).toBe("99970");
  });
});

describe("volume maker lifecycle (DEC-100)", () => {
  it("requote after a fill waits at least VM_MIN_REQUOTE_MS = 2000 ms", () => {
    const c = cfg();
    let { s } = run(c, [...firstQuote()]); // lastRefresh=0
    s = volumeMaker.step(
      c,
      s,
      { type: "fill", at: 1, clOrdID: id("vm:1:bid"), price: "99990", quantity: "0.005", fee: "0" },
      ctx,
    ).state;
    expect(s.requoteDue).toBe(true);
    // 1999 ms elapsed: too soon.
    expect(places(volumeMaker.step(c, s, { type: "timer", at: 1999 }, ctx).actions)).toHaveLength(
      0,
    );
    // 2000 ms elapsed: exactly at threshold → fires.
    expect(
      places(volumeMaker.step(c, s, { type: "timer", at: 2000 }, ctx).actions).length,
    ).toBeGreaterThan(0);
  });

  it("positionSync: first gap records drift; after VM_DRIFT_ADOPT_MS adopts SoDEX and flags", () => {
    const c = cfg();
    let { s } = run(c, [...firstQuote()]);
    // First sync: SoDEX has 0.005 BTC, bot has 0 → gap recorded, not yet adopted.
    const r1 = volumeMaker.step(
      c,
      s,
      { type: "positionSync", at: 1000, market: "BTC-USD", size: "0.005", entryPrice: "99990" },
      ctx,
    );
    expect(r1.state.drift).toEqual({ size: "0.005", since: 1000 });
    expect(r1.actions).toHaveLength(0);
    s = r1.state;
    // Second sync before 30 s: still not adopted.
    const r2 = volumeMaker.step(
      c,
      s,
      { type: "positionSync", at: 15000, market: "BTC-USD", size: "0.005", entryPrice: "99990" },
      ctx,
    );
    expect(r2.state.drift).not.toBeNull();
    expect(r2.actions).toHaveLength(0);
    s = r2.state;
    // Third sync ≥ 30 s after the first → adopt SoDEX position and flag the bot.
    const r3 = volumeMaker.step(
      c,
      s,
      { type: "positionSync", at: 31000, market: "BTC-USD", size: "0.005", entryPrice: "99990" },
      ctx,
    );
    expect(r3.state.ledger.position).toBe("0.005");
    expect(r3.state.drift).toBeNull();
    expect(r3.actions).toEqual(expect.arrayContaining([{ type: "flag", needsAttention: true }]));
  });
});

describe("volume maker — quotes by order book level (DEC-135)", () => {
  const book = (bid: string, ask: string) =>
    ({
      type: "timer",
      at: 3000,
      market: {
        market: "BTC-USD",
        candles: [],
        book: { bid, ask, bidNotional: "100000", askNotional: "100000" },
      },
    }) as const;
  const quoted = (c: VolumeMakerConfig, bid: string, ask: string) => {
    const r = run(c, [...firstQuote(), book(bid, ask)]);
    const p = places(r.all);
    return {
      bid: p.find((o) => o.clOrdID === id("vm:2:bid"))?.price,
      ask: p.find((o) => o.clOrdID === id("vm:2:ask"))?.price,
    };
  };

  it("joins the best bid and ask at level 0 when the spread is one tick", () => {
    expect(quoted(cfg({ quoteLevel: 0 }), "99999.9", "100000")).toEqual({
      bid: "99999.9",
      ask: "100000",
    });
  });

  it("steps one tick inside a wide spread so thin markets still fill", () => {
    expect(quoted(cfg({ quoteLevel: 0 }), "99990", "100010")).toEqual({
      bid: "99990.1",
      ask: "100009.9",
    });
  });

  it("stands n ticks behind the best price at level n", () => {
    expect(quoted(cfg({ quoteLevel: 2 }), "99999.9", "100000")).toEqual({
      bid: "99999.7",
      ask: "100000.2",
    });
  });

  it("keeps the old distance in bp for configs without a quote level", () => {
    const q = quoted(cfg(), "99999.9", "100000");
    expect(q.bid).toBe("99990");
    expect(q.ask).toBe("100010");
  });

  it("never lets its own bid reach its own ask", () => {
    for (const [b, a] of [
      ["99999.9", "100000"],
      ["99990", "100010"],
      ["99999.8", "100000"],
    ] as const) {
      const q = quoted(cfg({ quoteLevel: 0 }), b, a);
      expect(Number(q.bid)).toBeLessThan(Number(q.ask));
    }
  });
});

describe("volume maker — smart quoting v2 (DEC-144, DEC-152)", () => {
  // Tick 0.1 ở giá 100 000: 1 bp = 10 = 100 tick. Bản thường (tắt) báo bid 99999.9 / ask 100000.
  const snap = (at: number, bidN = "100000", askN = "100000") =>
    ({
      type: "timer",
      at,
      market: {
        market: "BTC-USD",
        candles: [],
        book: { bid: "99999.9", ask: "100000", bidNotional: bidN, askNotional: askN },
      },
    }) as const;
  const tickAt = (at: number, price: string) =>
    ({ type: "tick", at, market: "BTC-USD", price }) as const;
  const last = (a: StrategyAction[], side: "bid" | "ask") =>
    places(a)
      .filter((o) => o.tag.endsWith(`:${side}`))
      .at(-1)?.price;
  const logsOf = (a: StrategyAction[]) => a.flatMap((x) => (x.type === "log" ? [x] : []));
  const on = cfg({ quoteLevel: 0, smartQuoting: true });
  /** Chạy tiếp từ state `s`, trả về action của riêng đợt này. */
  const more = (s: VolumeMakerState, events: StrategyEvent[]) => {
    let st = s;
    const out: StrategyAction[] = [];
    for (const e of events) {
      const x = volumeMaker.step(on, st, e, ctx);
      st = x.state;
      out.push(...x.actions);
    }
    return { s: st, all: out };
  };

  it("changes nothing when switched off, even with a lopsided book", () => {
    const r = run(cfg({ quoteLevel: 0 }), [...firstQuote(), snap(3000, "300000", "100000")]);
    expect(last(r.all, "bid")).toBe("99999.9");
    expect(last(r.all, "ask")).toBe("100000");
    expect(logsOf(r.all).some((l) => l.decision.startsWith("Smart"))).toBe(false);
  });

  it("backs both sides off 2 bp while it warms up price data", () => {
    const r = run(on, [...firstQuote(), snap(3000)]);
    expect(last(r.all, "bid")).toBe("99979.9");
    expect(last(r.all, "ask")).toBe("100020");
    expect(logsOf(r.all).find((l) => l.decision === "Smart quoting adjusted")?.why).toContain(
      "warming up",
    );
  });

  it("backs the thin side off 1 bp when the book is lopsided", () => {
    const r = run(on, [...firstQuote(), tickAt(7000, "100000"), snap(7000, "300000", "100000")]);
    expect(last(r.all, "bid")).toBe("99999.9");
    expect(last(r.all, "ask")).toBe("100010");
    expect(logsOf(r.all).at(-1)?.why).toContain("bid depth 3× ask depth");
  });

  it("no longer backs off on a fast move or pulls on a trend (DEC-247)", () => {
    // +3 bp trong 1.5 s rồi +6 bp trong 30 s: trước DEC-247 ask lùi 2 bp rồi bị rút; giờ giữ nguyên ở giá tốt nhất.
    let r = run(on, [...firstQuote(), tickAt(6500, "100000"), tickAt(8000, "100030"), snap(8000)]);
    expect(last(r.all, "ask")).toBe("100000");
    expect(last(r.all, "bid")).toBe("99999.9");
    r = more(r.s, [tickAt(20000, "100060"), snap(20000)]);
    expect(logsOf(r.all).filter((l) => l.decision === "Smart quoting adjusted")).toHaveLength(0);
  });

  const bookAt = (at: number, bid: string, ask: string) =>
    ({ type: "book", at, market: "BTC-USD", bid, ask }) as const;
  const quotedAt7s = () => run(on, [...firstQuote(), tickAt(7000, "100000"), snap(7000)]);

  it("moves only the side the best price left behind, at most every 1.5 s (DEC-248)", () => {
    const r0 = quotedAt7s();
    expect(last(r0.all, "ask")).toBe("100000");
    // 1 s sau lần báo giá trước: chỉ lưu giá, chưa gửi gì.
    let r = more(r0.s, [bookAt(8000, "100000.9", "100001")]);
    expect(r.all).toHaveLength(0);
    // 1.6 s: bid tốt nhất lên trên bid của mình → đặt lại bid; ask vẫn nằm (giá chạy về phía nó).
    r = more(r.s, [bookAt(8600, "100000.9", "100001")]);
    expect(last(r.all, "bid")).toBe("100000.9");
    expect(last(r.all, "ask")).toBeUndefined();
    expect(r.all.filter((x) => x.type === "cancel")).toHaveLength(1);
  });

  it("keeps both quotes when the price moves into them, and leaves a filled side to the timer (DEC-248)", () => {
    // Bid tốt nhất xuống dưới bid của mình (bid đã bị khớp / sắp khớp), ask không đổi: không gửi gì.
    const r = more(quotedAt7s().s, [bookAt(8600, "99999.5", "100000")]);
    expect(r.all).toHaveLength(0);
  });

  it("sends nothing when the live price still matches the resting quotes (DEC-248)", () => {
    const r = more(quotedAt7s().s, [bookAt(8600, "99999.9", "100000")]);
    expect(r.all).toHaveLength(0);
  });

  it("keeps the live price when the 3 s REST book is older, taking only its depth (DEC-248)", () => {
    const r = more(quotedAt7s().s, [bookAt(8100, "100000.9", "100001"), snap(9000, "5", "7")]);
    expect(r.s.book).toEqual({
      bid: "100000.9",
      ask: "100001",
      bidNotional: "5",
      askNotional: "7",
    });
  });

  it("ignores the live book when Smart quoting is off (DEC-248)", () => {
    const off = cfg({ quoteLevel: 0 });
    let st = run(off, [...firstQuote(), snap(7000)]).s;
    const x = volumeMaker.step(off, st, bookAt(8100, "100000.9", "100001"), ctx);
    st = x.state;
    expect(x.actions).toHaveLength(0);
    expect(st.book?.bid).toBe("99999.9");
  });

  const fairAt = (at: number, fair: string) =>
    ({ type: "fair", at, market: "BTC-USD", fair, binanceAt: at }) as const;
  const longAt = () => {
    const r0 = quotedAt7s();
    const bid = places(r0.all)
      .filter((o) => o.side === "buy")
      .at(-1);
    return more(r0.s, [
      {
        type: "fill",
        at: 7100,
        clOrdID: bid?.clOrdID ?? "",
        price: bid?.price ?? "0",
        quantity: bid?.quantity ?? "0",
        fee: "0",
      },
    ]).s;
  };

  it("cuts the position at market when Binance runs 15 bp against the entry (DEC-249)", () => {
    const s0 = longAt();
    expect(s0.ledger.position).toBe("0.005");
    // −10 bp: chưa cắt.
    let r = more(s0, [fairAt(8000, "99899.9")]);
    expect(places(r.all)).toHaveLength(0);
    // −16 bp: huỷ mọi lệnh, bán cả vị thế bằng market IOC reduce-only.
    r = more(r.s, [fairAt(8100, "99839.9")]);
    const cut = places(r.all);
    expect(cut).toEqual([
      expect.objectContaining({
        side: "sell",
        type: "market",
        timeInForce: "IOC",
        reduceOnly: true,
        quantity: "0.005",
        tag: "vm:2:cut:close",
      }),
    ]);
    expect(r.all.some((x) => x.type === "cancel")).toBe(true);
    expect(logsOf(r.all).find((l) => l.decision === "Position cut")?.why).toBe(
      "At 00:00:08.100 UTC the Binance price (99839.9) was 16 bp against your long entry at 99999.9. Closed 0.005 at market.",
    );
    // Trong 5 s sau: không cắt lần nữa.
    r = more(r.s, [fairAt(9000, "99800")]);
    expect(places(r.all)).toHaveLength(0);
  });

  it("leaves the close order to the normal cycle when the live price moves (DEC-248)", () => {
    // Đang long, lệnh đóng (bán) nằm ở 100000; ask tốt nhất xuống 99990 → không huỷ lệnh đóng.
    const r1 = more(longAt(), [snap(10100)]);
    const close = places(r1.all).find((o) => o.reduceOnly);
    expect(close?.side).toBe("sell");
    const r = more(r1.s, [bookAt(12000, "99989", "99990")]);
    expect(r.all.filter((x) => x.type === "cancel")).toHaveLength(0);
  });

  it("re-places the close soon after SoDEX confirms its cancel while a position is held (DEC-248)", () => {
    const r1 = more(longAt(), [snap(10100)]);
    const closeId = places(r1.all).find((o) => o.reduceOnly)?.clOrdID ?? "";
    // Chu kỳ kế tiếp huỷ lệnh đóng (không đặt lại vì lệnh cũ còn đang huỷ).
    let r = more(r1.s, [snap(13200)]);
    expect(r.s.orders[closeId]?.status).toBe("cancelling");
    r = more(r.s, [{ type: "orderDone", at: 13500, clOrdID: closeId }]);
    expect(r.s.requoteDue).toBe(true);
  });

  it("keeps quoting on a tick that also drops orders older than 10 minutes (DEC-251)", () => {
    // Lệnh xong từ đầu phiên quá hạn giữ đúng lúc fill cần báo giá lại: vẫn phải đặt lệnh trong cùng nhịp.
    const r0 = quotedAt7s();
    const bid = places(r0.all)
      .filter((o) => o.side === "buy")
      .at(-1);
    const old = Object.fromEntries(
      Object.entries(r0.s.orders).map(([id, o]) => [
        id,
        { ...o, status: "done" as const, since: 0 },
      ]),
    );
    const at = VM_KEEP_DONE_MS + 1;
    let st: VolumeMakerState = { ...r0.s, orders: old, lastRefresh: at - 5000 };
    st = more(st, [
      {
        type: "fill",
        at: at - 3000,
        clOrdID: bid?.clOrdID ?? "",
        price: "99999.9",
        quantity: "0.005",
        fee: "0",
      },
    ]).s;
    const r = more(st, [snap(at)]);
    expect(places(r.all).length).toBeGreaterThan(0);
  });

  it("does not cut without Smart quoting (DEC-249)", () => {
    const off = cfg({ quoteLevel: 0 });
    const x = volumeMaker.step(off, longAt(), fairAt(8100, "99000"), ctx);
    expect(places(x.actions)).toHaveLength(0);
  });

  it("logs the number of order requests sent to SoDEX each minute (DEC-248)", () => {
    const r = run(on, [...firstQuote(), tickAt(7000, "100000"), snap(7000), snap(61000)]);
    const line = logsOf(r.all).find((l) => l.decision === "Order requests");
    expect(line?.why).toMatch(/^Last 61 s: \d+ requests to SoDEX \(new orders and cancels\)\.$/);
  });
});

describe("volume maker — any SoDEX perp (DEC-157)", () => {
  // Alt giá thấp: tick 0.00001, lot 1 (khác hẳn BTC), nên báo giá và khối lượng phải theo đúng rules của market.
  const alt: StepContext = {
    ...ctx,
    rules: {
      "DOGE-USD": { tickSize: "0.00001", stepSize: "1", minQuantity: "1", minNotional: "5" },
    },
  };
  const c = cfg({ market: "DOGE-USD", orderSize: "20", maxInventory: "40", quoteLevel: 0 });
  const quote = (bid: string, ask: string) => {
    let s = volumeMaker.initialState(c);
    const all: StrategyAction[] = [];
    for (const e of [
      { type: "tick", at: 0, market: "DOGE-USD", price: "0.15" },
      {
        type: "timer",
        at: 3000,
        market: {
          market: "DOGE-USD",
          candles: [],
          book: { bid, ask, bidNotional: "100000", askNotional: "100000" },
        },
      },
    ] as const) {
      const r = volumeMaker.step(c, s, e, alt);
      s = r.state;
      all.push(...r.actions);
    }
    return places(all).filter((o) => o.tag.startsWith("vm:2:"));
  };

  it("accepts any market name, not only BTC / ETH", () => {
    expect(volumeMakerSchema.safeParse({ ...c, market: "SOL-USD" }).success).toBe(true);
    expect(volumeMakerSchema.safeParse({ ...c, market: "" }).error?.issues[0]?.message).toBe(
      "Required.",
    );
  });

  it("quotes on the market's own tick and lot size", () => {
    const [tight, wide] = [quote("0.14999", "0.15000"), quote("0.14990", "0.15010")].map((p) => ({
      bid: p.find((o) => o.side === "buy"),
      ask: p.find((o) => o.side === "sell"),
    }));
    expect(tight).toMatchObject({ bid: { price: "0.14999" }, ask: { price: "0.15" } });
    expect(wide).toMatchObject({ bid: { price: "0.14991" }, ask: { price: "0.15009" } });
    for (const o of [tight?.bid, tight?.ask]) expect(o?.quantity).toMatch(/^\d+$/);
  });
});

describe("volume maker — close only at your entry price or better (DEC-227)", () => {
  const timer = (at: number) =>
    ({
      type: "timer",
      at,
      market: {
        market: "BTC-USD",
        candles: [],
        book: { bid: "99999.9", ask: "100000", bidNotional: "1", askNotional: "1" },
      },
    }) as const;
  const fill = (side: "bid" | "ask", price: string) =>
    ({
      type: "fill",
      at: 1,
      clOrdID: id(`vm:1:${side}`),
      price,
      quantity: "0.005",
      fee: "0",
    }) as const;
  const close = (a: StrategyAction[]) => places(a).find((o) => o.reduceOnly);
  const logs = (a: StrategyAction[]) => a.flatMap((x) => (x.type === "log" ? [x.decision] : []));

  it("is off by default and closes at the best price", () => {
    const c = cfg({ quoteLevel: 0 });
    expect(c.closeAtEntry).toBe(false);
    const { all } = run(c, [...firstQuote(), fill("bid", "100005"), timer(3000)]);
    expect(close(all)?.price).toBe("100000");
  });

  it("sells a long no lower than the entry price and buys back a short no higher, post-only reduce-only", () => {
    const c = cfg({ quoteLevel: 0, closeAtEntry: true });
    const long = close(run(c, [...firstQuote(), fill("bid", "100005"), timer(3000)]).all);
    expect(long).toMatchObject({
      side: "sell",
      price: "100005",
      timeInForce: "GTX",
      reduceOnly: true,
    });
    const short = close(run(c, [...firstQuote(), fill("ask", "99995.05"), timer(3000)]).all);
    // Giá vào làm tròn về phía có lợi (mua: xuống tick).
    expect(short).toMatchObject({ side: "buy", price: "99995" });
    // Giá tốt nhất đã tốt hơn giá vào thì dùng giá tốt nhất.
    const better = close(run(c, [...firstQuote(), fill("bid", "99990"), timer(3000)]).all);
    expect(better?.price).toBe("100000");
  });

  it("falls back to the normal close after 30 minutes, logging it once", () => {
    const c = cfg({ quoteLevel: 0, closeAtEntry: true });
    const { s } = run(c, [...firstQuote(), fill("bid", "100005"), timer(3000)]);
    const T = 30 * 60_000;
    // Nhịp đầu dọn lệnh cũ rồi báo giá luôn (DEC-251): lệnh đóng ở giá tốt nhất, ghi một lần.
    const late1 = volumeMaker.step(c, s, timer(T + 3000), ctx);
    expect(logs(late1.actions)).toEqual(["Closing at the best price"]);
    // Lệnh đóng cũ đang huỷ vẫn chiếm khối lượng tới khi SoDEX xác nhận xong.
    expect(close(late1.actions)).toBeUndefined();
    const done = volumeMaker.step(
      c,
      late1.state,
      { type: "orderDone", at: T + 3003, clOrdID: id("vm:2:rc") },
      ctx,
    ).state;
    const late = volumeMaker.step(c, done, timer(T + 6002), ctx);
    expect(close(late.actions)?.price).toBe("100000");
    expect(logs(late.actions)).toEqual([]);
  });
});

describe("volume maker — pause on fast moves (DEC-227)", () => {
  const tick = (at: number, price: string) =>
    ({ type: "tick", at, market: "BTC-USD", price }) as const;
  const logs = (a: StrategyAction[]) => a.flatMap((x) => (x.type === "log" ? [x.decision] : []));

  it("pulls opening quotes when the price moves 2 bp in 6 s (more than 3 ticks here) and quotes again after 15 s", () => {
    const c = cfg({ pauseOnFastMoves: true });
    let { s } = run(c, [...firstQuote()]);
    const hit = volumeMaker.step(c, s, tick(1000, "100021"), ctx);
    expect(hit.actions.filter((a) => a.type === "cancel")).toHaveLength(2);
    expect(places(hit.actions)).toEqual([]);
    expect(logs(hit.actions)).toEqual(["Quotes paused on a fast move"]);
    s = hit.state;
    const during = volumeMaker.step(c, s, { type: "timer", at: 4000 }, ctx);
    expect(places(during.actions)).toEqual([]);
    const back = volumeMaker.step(c, during.state, { type: "timer", at: 16_000 }, ctx);
    expect(places(back.actions).map((o) => o.side)).toEqual(["buy", "sell"]);
    expect(logs(back.actions)).toEqual(["Quoting again after a fast move"]);
  });

  it("keeps the reduce-only close while paused", () => {
    const c = cfg({ pauseOnFastMoves: true });
    let { s } = run(c, [...firstQuote()]);
    s = volumeMaker.step(
      c,
      s,
      { type: "fill", at: 1, clOrdID: id("vm:1:bid"), price: "99990", quantity: "0.005", fee: "0" },
      ctx,
    ).state;
    const hit = volumeMaker.step(c, s, tick(2000, "99980"), ctx);
    const p = places(hit.actions);
    expect(p).toHaveLength(1);
    expect(p[0]).toMatchObject({ side: "sell", reduceOnly: true });
  });

  it("does nothing on small moves or when switched off", () => {
    const on = cfg({ pauseOnFastMoves: true });
    // 3 tick (0.3) nhỏ hơn 2 bp (20) ở giá 100.000: không kích hoạt.
    const small = run(on, [...firstQuote(), tick(1000, "100019.9")]);
    expect(logs(small.all)).toEqual([]);
    expect(small.s.fastPauseUntil ?? null).toBeNull();
    const off = run(cfg(), [...firstQuote(), tick(1000, "100100")]);
    expect(off.all.filter((a) => a.type === "cancel")).toHaveLength(0);
  });
});

describe("volume maker — orders that end, and the close at stop (P0.1)", () => {
  const stopWithInventory = () => {
    const c = cfg({ costBudget: "10", inventoryLossStop: "5" });
    const { s } = run(c, [...firstQuote()]);
    const a = volumeMaker.step(
      c,
      s,
      {
        type: "fill",
        at: 1,
        clOrdID: id("vm:1:bid"),
        price: "99990",
        quantity: "0.005",
        fee: "8.2",
      },
      ctx,
    );
    const b = volumeMaker.step(
      c,
      a.state,
      {
        type: "fill",
        at: 2,
        clOrdID: id("vm:1:ask"),
        price: "100010",
        quantity: "0.001",
        fee: "2",
      },
      ctx,
    );
    return { c, r: b };
  };

  it("books the market close sent at stop, in parts, without sending another close", () => {
    const { c, r } = stopWithInventory();
    const close = places(r.actions)[0];
    if (close === undefined) throw new Error("no close");
    expect(r.state.orders[close.clOrdID]).toMatchObject({ role: "close", status: "live" });
    const p1 = volumeMaker.step(
      c,
      r.state,
      {
        type: "fill",
        at: 3,
        clOrdID: close.clOrdID,
        price: "99900",
        quantity: "0.002",
        fee: "0.1",
      },
      ctx,
    );
    expect(p1.actions).toEqual([]);
    expect(p1.state.ledger.position).toBe("0.002");
    const p2 = volumeMaker.step(
      c,
      p1.state,
      {
        type: "fill",
        at: 4,
        clOrdID: close.clOrdID,
        price: "99900",
        quantity: "0.002",
        fee: "0.1",
      },
      ctx,
    );
    expect(p2.actions).toEqual([]);
    expect(p2.state.ledger.position).toBe("0");
    expect(p2.state.orders[close.clOrdID]?.status).toBe("done");
    // Phí taker của lệnh đóng đã vào chi phí.
    expect(Number(p2.state.ledger.fees)).toBeCloseTo(10.4, 6);
  });

  it("keeps a close order as a close after switching to plain post-only closes", () => {
    const c = cfg();
    let { s } = run(c, [...firstQuote()]);
    s = volumeMaker.step(
      c,
      s,
      { type: "fill", at: 1, clOrdID: id("vm:1:bid"), price: "99990", quantity: "0.005", fee: "0" },
      ctx,
    ).state;
    s = { ...s, closeReduceOnly: false };
    const r = volumeMaker.step(c, s, { type: "timer", at: 2000 }, ctx);
    const rc = places(r.actions).find((o) => o.tag.endsWith(":rc"));
    expect(rc?.reduceOnly).toBe(false);
    expect(r.state.orders[rc?.clOrdID ?? ""]?.role).toBe("close");
    // Lệnh đóng đang huỷ vẫn chiếm phần khối lượng: lần báo giá sau không đặt lệnh đóng trùng.
    const again = volumeMaker.step(c, r.state, { type: "timer", at: 5000 }, ctx);
    expect(places(again.actions).filter((o) => o.tag.endsWith(":rc"))).toEqual([]);
  });

  it("counts a close that filled part of the way and then expired, and a fill that arrives after orderDone", () => {
    const c = cfg();
    let { s } = run(c, [...firstQuote()]);
    s = volumeMaker.step(
      c,
      s,
      { type: "fill", at: 1, clOrdID: id("vm:1:bid"), price: "99990", quantity: "0.005", fee: "0" },
      ctx,
    ).state;
    const r = volumeMaker.step(c, s, { type: "timer", at: 2000 }, ctx);
    const rc = places(r.actions).find((o) => o.tag.endsWith(":rc"));
    const rcId = rc?.clOrdID ?? "";
    let st = volumeMaker.step(
      c,
      r.state,
      { type: "fill", at: 2100, clOrdID: rcId, price: "100000", quantity: "0.002", fee: "0" },
      ctx,
    ).state;
    st = volumeMaker.step(c, st, { type: "orderDone", at: 2200, clOrdID: rcId }, ctx).state;
    expect(st.orders[rcId]?.status).toBe("done");
    expect(st.ledger.position).toBe("0.003");
    // Fill tới trễ sau orderDone vẫn được tính, tối đa phần chưa khớp.
    st = volumeMaker.step(
      c,
      st,
      { type: "fill", at: 2300, clOrdID: rcId, price: "100000", quantity: "0.001", fee: "0" },
      ctx,
    ).state;
    expect(st.ledger.position).toBe("0.002");
    // Khớp trễ quá phần chưa khớp (0.005 − 0.003) thì chỉ tính tới đủ khối lượng lệnh.
    st = volumeMaker.step(
      c,
      st,
      { type: "fill", at: 2400, clOrdID: rcId, price: "100000", quantity: "0.004", fee: "0" },
      ctx,
    ).state;
    expect(st.ledger.position).toBe("0");
  });
});

describe("volume maker — fast-move threshold on a coarse-tick market", () => {
  it("uses 3 price steps when they are wider than 2 bp", () => {
    // Giá 100, bước 0.1: 3 bước = 0.3 = 30 bp > 2 bp.
    const coarse: StepContext = {
      ...ctx,
      rules: {
        "BTC-USD": { tickSize: "0.1", stepSize: "0.01", minQuantity: "0.01", minNotional: "5" },
      },
    };
    const c = cfg({ pauseOnFastMoves: true });
    let s = volumeMaker.initialState(c);
    s = volumeMaker.step(
      c,
      s,
      { type: "tick", at: 0, market: "BTC-USD", price: "100" },
      coarse,
    ).state;
    const small = volumeMaker.step(
      c,
      s,
      { type: "tick", at: 1000, market: "BTC-USD", price: "100.2" },
      coarse,
    );
    expect(small.state.fastPauseUntil ?? null).toBeNull();
    const hit = volumeMaker.step(
      c,
      s,
      { type: "tick", at: 1000, market: "BTC-USD", price: "100.3" },
      coarse,
    );
    expect(hit.state.fastPauseUntil).toBe(1000 + 15_000);
  });
});

describe("volume maker — Binance pricing and resting quotes in Smart quoting", () => {
  const on = cfg({ quoteLevel: 0, smartQuoting: true });
  const snap = (at: number) =>
    ({
      type: "timer",
      at,
      market: {
        market: "BTC-USD",
        candles: [],
        book: { bid: "99999.9", ask: "100000", bidNotional: "100000", askNotional: "100000" },
      },
    }) as const;
  // Giờ Binance đi trước lúc engine nhận 50 ms (như prod); `age` để mô phỏng giá Binance cũ.
  const fair = (at: number, price: string, age = 50) =>
    ({ type: "fair", at, market: "BTC-USD", fair: price, binanceAt: at - age }) as const;
  const priceOf = (a: StrategyAction[], side: "bid" | "ask") =>
    places(a).find((o) => o.tag.endsWith(`:${side}`))?.price;
  const runFrom = (c: VolumeMakerConfig, start: VolumeMakerState) => {
    let s = start;
    return {
      step: (e: StrategyEvent) => {
        const x = volumeMaker.step(c, s, e, ctx);
        s = x.state;
        return x.actions;
      },
      get s() {
        return s;
      },
    };
  };

  it("never quotes the opening side past the Binance price plus 0.5 bp", () => {
    const b = runFrom(on, run(on, [...firstQuote()]).s);
    // Binance quy đổi 100010: ask không thấp hơn 100010 × 1.00005 = 100015.0005 → 100015.1 (làm tròn lên tick 0.1).
    b.step(fair(6500, "100010"));
    const out = b.step(snap(7000));
    expect(priceOf(out, "ask")).toBe("100015.1");
    // Bid đã thấp hơn giá Binance − 0.5 bp: giữ nguyên ở giá tốt nhất (lệnh cũ nằm yên).
    expect(
      Object.values(b.s.orders).find((o) => o.status === "live" && o.side === "buy")?.price,
    ).toBe("99999.9");
  });

  it("ignores a Binance price older than 1.5 s by its Binance time", () => {
    const b = runFrom(on, run(on, [...firstQuote()]).s);
    b.step(fair(1000, "100010"));
    expect(priceOf(b.step(snap(7000)), "ask")).toBe("100000");
  });

  it("does not pull or price from a stale Binance price even when the engine just received it", () => {
    const b = runFrom(on, run(on, [...firstQuote(), snap(7000)]).s);
    // Luồng Binance khựng: tin tới lúc 7.5 s nhưng giờ Binance là 5 s trước.
    expect(b.step(fair(7500, "100003", 5000))).toEqual([]);
    expect(b.s.requoteDue).toBe(false);
    expect(
      Object.values(b.s.orders)
        .filter((o) => o.status === "live")
        .map((o) => o.side)
        .sort(),
    ).toEqual(["buy", "sell"]);
  });

  it("pulls a resting quote the Binance price moved through, logs it with the Binance time, and requotes soon", () => {
    const b = runFrom(on, run(on, [...firstQuote(), snap(7000)]).s);
    const out = b.step(fair(7500, "100003"));
    expect(out.filter((a) => a.type === "cancel")).toHaveLength(1);
    expect(out).toContainEqual({
      type: "log",
      decision: "Ask pulled",
      why: "At 00:00:07.450 UTC the Binance price (100003) moved through the ask at 100000.",
    });
    expect(b.s.requoteDue).toBe(true);
    expect(
      Object.values(b.s.orders)
        .filter((o) => o.status === "live")
        .map((o) => o.side),
    ).toEqual(["buy"]);
  });

  it("keeps a resting quote whose price and size did not change instead of cancelling and placing it again", () => {
    const b = runFrom(on, run(on, [...firstQuote(), snap(7000)]).s);
    const live = Object.entries(b.s.orders)
      .filter(([, o]) => o.status === "live")
      .map(([id]) => id)
      .sort();
    // Cùng sổ lệnh 3 s sau: không huỷ, không đặt gì.
    const out = b.step(snap(10_500));
    expect(out.filter((a) => a.type === "cancel" || a.type === "place")).toEqual([]);
    expect(
      Object.entries(b.s.orders)
        .filter(([, o]) => o.status === "live")
        .map(([id]) => id)
        .sort(),
    ).toEqual(live);
  });

  it("is ignored when Smart quoting is off", () => {
    const c = cfg({ quoteLevel: 0 });
    const r = run(c, [...firstQuote(), fair(1000, "100003")]);
    expect(r.s.fair).toBeUndefined();
  });
});
