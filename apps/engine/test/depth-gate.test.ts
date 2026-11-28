import type { BookTop, OrderIntent, StrategyAction } from "@drift/strategies";
import { describe, expect, it } from "vitest";

import { depthNeeds, depthWaitDecision, planDepth, type DepthRead } from "../src/depth-gate";
import { opensPosition } from "../src/engine";

// Cổng độ sâu của engine (DEC-402 mục 5, #590), phần thuần: không cần Postgres / Redis.

const rules = { tickSize: "0.01", stepSize: "0.01", minQuantity: "0.01", minNotional: "5" };
const thin: BookTop = { bid: "99", ask: "100", bidNotional: "2000", askNotional: "3000" };
const deep: BookTop = { bid: "99", ask: "100", bidNotional: "50000", askNotional: "50000" };

const o = (x: Partial<OrderIntent> = {}): OrderIntent => ({
  clOrdID: x.tag ?? "entry",
  market: "ANT-USD",
  engine: "perps",
  side: "buy",
  type: "market",
  quantity: "10",
  timeInForce: "IOC",
  reduceOnly: false,
  tag: "entry",
  ...x,
});
const place = (order: OrderIntent): StrategyAction => ({ type: "place", order });
const all = () => true;
const first = <T>(xs: readonly T[]): T => {
  const [x] = xs;
  if (x === undefined) throw new Error("empty");
  return x;
};

function plan(
  actions: StrategyAction[],
  opts: {
    position?: string | null;
    books?: Record<string, DepthRead>;
    accounting?: boolean;
  } = {},
) {
  const position = opts.position === undefined ? "0" : opts.position;
  return planDepth({
    actions,
    positionOf: () => position,
    opens: opensPosition,
    books: new Map(Object.entries(opts.books ?? { "perps:ANT-USD": thin })),
    rules: { "ANT-USD": rules, vANT_vUSDC: rules },
    inScope: () => true,
    accounting: opts.accounting ?? false,
  });
}

describe("which orders need the book", () => {
  it("only entries that fill at once", () => {
    const actions = [
      place(o()),
      place(o({ tag: "grid:1:buy", type: "limit", price: "95", timeInForce: "GTC" })),
      place(o({ tag: "tp", reduceOnly: true, side: "sell" })),
    ];
    expect(depthNeeds(actions, () => "0", opensPosition, all)).toEqual([
      { market: "ANT-USD", engine: "perps" },
    ]);
  });

  it("not an opposite-side order that only reduces the position", () => {
    // Long 20: a 10 sell (not reduce-only) only reduces.
    expect(depthNeeds([place(o({ side: "sell" }))], () => "20", opensPosition, all)).toEqual([]);
    // Flat: the same sell opens a short.
    expect(depthNeeds([place(o({ side: "sell" }))], () => "0", opensPosition, all)).toHaveLength(1);
  });
});

describe("DEPTH_CAP_MARKETS", () => {
  it("never reads the book or caps a market outside the list", () => {
    const onlyAnt = (m: string) => m === "ANT-USD";
    const btc = [place(o({ market: "BTC-USD", quantity: "1000" }))];
    expect(depthNeeds(btc, () => "0", opensPosition, onlyAnt)).toEqual([]);
    expect(
      planDepth({
        actions: btc,
        positionOf: () => "0",
        opens: opensPosition,
        books: new Map(),
        rules: { "BTC-USD": rules },
        inScope: onlyAnt,
        accounting: false,
      }),
    ).toEqual({ kind: "pass", clear: [] });
    // Turned off (empty list): nothing is in scope.
    expect(
      depthNeeds(
        [place(o())],
        () => "0",
        opensPosition,
        () => false,
      ),
    ).toEqual([]);
  });
});

describe("25% cap on entries that fill at once", () => {
  it("cuts the entry to 25% of the ask side and logs Order reduced with old → new", () => {
    const p = plan([place(o())]);
    expect(p.kind).toBe("apply");
    if (p.kind !== "apply") return;
    // 25% of 3000 = 750 → 7.5 at 100.
    expect(p.actions[0]).toMatchObject({ type: "place", order: { quantity: "7.5" } });
    expect(p.actions[1]).toEqual({
      type: "log",
      decision: "Order reduced",
      why: "ANT-USD: buy size cut from 10 to 7.5. An order that fills at once can take at most 25% of the top 10 ask levels (750 of 3000 USD).",
    });
    expect(p.stripped).toEqual([]);
  });

  it("does nothing on a deep market or under the cap", () => {
    expect(plan([place(o())], { books: { "perps:ANT-USD": deep } })).toEqual({
      kind: "pass",
      clear: ["ANT-USD"],
    });
    expect(plan([place(o({ quantity: "7" }))])).toEqual({ kind: "pass", clear: ["ANT-USD"] });
  });

  it("never cuts a close: reduce-only, stop loss, engine close, Spot sell", () => {
    const closes = [
      o({ tag: "tp", reduceOnly: true, side: "sell", quantity: "1000" }),
      o({ tag: "x:sl", reduceOnly: true, side: "sell", quantity: "1000", stop: { price: "90" } }),
      o({ tag: "close", side: "sell", quantity: "1000" }),
      o({ tag: "s", engine: "spot", market: "vANT_vUSDC", side: "sell", quantity: "1000" }),
    ];
    expect(plan(closes.map(place), { position: "1000" })).toEqual({ kind: "pass", clear: [] });
  });

  it("never cuts a resting maker order (grid)", () => {
    const grid = o({
      tag: "grid:1:buy",
      type: "limit",
      price: "95",
      timeInForce: "GTC",
      quantity: "1000",
    });
    expect(plan([place(grid)])).toEqual({ kind: "pass", clear: [] });
  });
});

describe("waiting", () => {
  it("holds the whole step when the side it takes is empty", () => {
    const p = plan([place(o())], { books: { "perps:ANT-USD": null } });
    expect(p.kind).toBe("hold");
    if (p.kind !== "hold") return;
    expect(depthWaitDecision(first(p.waits))).toEqual({
      decision: "Waiting: order book empty",
      why: "ANT-USD: no ask orders in the order book. The bot won't open or add until there are. Closing orders still go.",
    });
  });

  it("holds when 25% of the side is below SoDEX's minimum order", () => {
    const p = plan([place(o())], {
      books: { "perps:ANT-USD": { ...thin, askNotional: "16" } },
    });
    expect(p.kind).toBe("hold");
    if (p.kind !== "hold") return;
    expect(depthWaitDecision(first(p.waits))?.decision).toBe("Waiting: order book too thin");
  });

  it("an empty book still lets a close go: the entry is dropped, the close is sent", () => {
    const close = o({ tag: "close", side: "sell", quantity: "5" });
    const entry = o({ tag: "entry", market: "BTC-USD" });
    const p = plan([place(close), place(entry)], {
      position: "5",
      books: { "perps:BTC-USD": null },
    });
    expect(p.kind).toBe("apply");
    if (p.kind !== "apply") return;
    expect(p.actions).toEqual([place(close)]);
    expect(p.stripped.map((w) => w.order.clOrdID)).toEqual(["entry"]);
  });

  it("never holds a fill / ack step: drops only the entry", () => {
    const p = plan([place(o())], { books: { "perps:ANT-USD": null }, accounting: true });
    expect(p.kind).toBe("apply");
    if (p.kind !== "apply") return;
    expect(p.actions).toEqual([]);
    expect(p.stripped).toHaveLength(1);
  });

  it("holds without a Decisions line when the book can't be read", () => {
    const p = plan([place(o())], { books: { "perps:ANT-USD": "error" } });
    expect(p.kind).toBe("hold");
    if (p.kind !== "hold") return;
    expect(depthWaitDecision(first(p.waits))).toBeNull();
  });

  it("never sends two hedged legs of different size (Funding Arb)", () => {
    const spot = o({ tag: "spot", engine: "spot", market: "vANT_vUSDC" });
    const perp = o({ tag: "perp", side: "sell" });
    const p = plan([place(spot), place(perp)], {
      books: { "spot:vANT_vUSDC": deep, "perps:ANT-USD": thin },
    });
    expect(p.kind).toBe("hold");
    if (p.kind !== "hold") return;
    expect(p.waits.map((w) => w.order.clOrdID)).toEqual(["spot", "perp"]);
    expect(depthWaitDecision(first(p.waits))?.decision).toBe("Waiting: order book too thin");
  });
});
