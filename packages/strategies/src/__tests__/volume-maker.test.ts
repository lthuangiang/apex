import { describe, expect, it } from "vitest";

import { clOrdId } from "../core/ids";
import type { StepContext, StrategyAction, StrategyEvent } from "../core/types";
import { requirementOf } from "../requirements";
import { costPerMillion, volumeMaker, type VolumeMakerState } from "../volume-maker";
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

  it("backs off in bp on a fast move, holds it 15 s, logs once, then returns to normal", () => {
    let r = run(on, [...firstQuote(), tickAt(6500, "100000"), tickAt(8000, "100030"), snap(8000)]);
    // +3 bp trong 1.5 s: ask lùi 2 bp ở giá 100030 = 201 tick.
    expect(last(r.all, "ask")).toBe("100020.1");
    expect(last(r.all, "bid")).toBe("99999.9");
    const adjusted = logsOf(r.all).filter((l) => l.decision === "Smart quoting adjusted");
    expect(adjusted).toHaveLength(1);
    expect(adjusted[0]?.why).toContain("Ask back 201 ticks (price up 3 bp in 6 s)");
    // Giá nhích thêm: cùng hành động (ask lùi 201 tick) → không ghi thêm dòng.
    r = more(r.s, [tickAt(8500, "100035"), snap(11000)]);
    expect(logsOf(r.all)).toHaveLength(0);
    // 10 s sau, thị trường yên nhưng còn trong 15 s giữ: vẫn lùi.
    r = more(r.s, [snap(18000)]);
    expect(last(r.all, "ask")).toBe("100020.1");
    expect(logsOf(r.all)).toHaveLength(0);
    // Lần kích hoạt cuối ở 11 s (còn +3.5 bp trong 6 s) → giữ tới 26 s; 27 s: về bình thường, một dòng.
    r = more(r.s, [snap(27000)]);
    expect(last(r.all, "ask")).toBe("100000");
    expect(logsOf(r.all).map((l) => l.decision)).toEqual(["Smart quoting back to normal"]);
  });

  it("pulls the side a 30 s trend runs into", () => {
    const r = run(on, [
      ...firstQuote(),
      tickAt(7000, "100030"),
      tickAt(20000, "100060"),
      snap(20000),
    ]);
    const lastQuote =
      places(r.all)
        .filter((o) => o.tag.startsWith("vm:"))
        .at(-1)?.tag ?? "";
    const cycle = lastQuote.split(":")[1];
    const thisCycle = places(r.all).filter((o) => o.tag.split(":")[1] === cycle);
    expect(thisCycle.some((o) => o.tag.endsWith(":ask"))).toBe(false);
    expect(thisCycle.some((o) => o.tag.endsWith(":bid"))).toBe(true);
    expect(logsOf(r.all).at(-1)?.why).toContain("Ask pulled (trend up 6 bp in 30 s)");
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
    // Hai nhịp đầu chỉ dọn lệnh cũ (huỷ quá hạn → done → xoá), nhịp thứ ba báo giá.
    let st = s;
    for (const at of [3000, 3001]) st = volumeMaker.step(c, st, timer(T + at), ctx).state;
    const late1 = volumeMaker.step(c, st, timer(T + 3002), ctx);
    // Lệnh đóng cũ đang huỷ vẫn chiếm khối lượng tới khi SoDEX xác nhận xong.
    expect(close(late1.actions)).toBeUndefined();
    expect(logs(late1.actions)).toEqual(["Closing at the best price"]);
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

  it("pulls opening quotes when the price moves 3 ticks in 6 s and quotes again after 15 s", () => {
    const c = cfg({ pauseOnFastMoves: true });
    let { s } = run(c, [...firstQuote()]);
    const hit = volumeMaker.step(c, s, tick(1000, "100000.3"), ctx);
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
    const hit = volumeMaker.step(c, s, tick(2000, "99999.7"), ctx);
    const p = places(hit.actions);
    expect(p).toHaveLength(1);
    expect(p[0]).toMatchObject({ side: "sell", reduceOnly: true });
  });

  it("does nothing on small moves or when switched off", () => {
    const on = cfg({ pauseOnFastMoves: true });
    const small = run(on, [...firstQuote(), tick(1000, "100000.2")]);
    expect(logs(small.all)).toEqual([]);
    expect(small.s.fastPauseUntil ?? null).toBeNull();
    const off = run(cfg(), [...firstQuote(), tick(1000, "100001")]);
    expect(off.all.filter((a) => a.type === "cancel")).toHaveLength(0);
  });
});
