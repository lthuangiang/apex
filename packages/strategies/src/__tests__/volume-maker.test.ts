import {
  MM_ORDER_CONTEXT_MAX_BYTES,
  MM_QUOTE_SNAPSHOT_MAX_BYTES,
  mmOrderContextSchema,
  mmQuoteSnapshotSchema,
} from "@drift/shared/mm-quote";
import { describe, expect, it } from "vitest";

import { clOrdId } from "../core/ids";
import type { StepContext, StrategyAction, StrategyEvent } from "../core/types";
import { requirementOf } from "../requirements";
import {
  costPerMillion,
  VM_KEEP_DONE_MS,
  VM_RC_KEEP_MAX_MS,
  VM_STALE_CANCEL_MS,
  VOLUME_MAKER_STOPPED,
  volumeMaker,
  volumeMakerStopCause,
  type VolumeMakerState,
} from "../volume-maker";
import { vmMaxInventory, volumeMakerSchema, type VolumeMakerConfig } from "../volume-maker/schema";
import { quoteSnapshot, withQuoteSnapshots } from "../volume-maker/snapshot";

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

/**
 * Chạy chuỗi sự kiện. Mặc định SoDEX xác nhận ngay mọi lệnh huỷ (engine gửi `orderDone` liền sau), như thường thấy;
 * từ DEC-257 lệnh mở mới của một phía chỉ được đặt sau xác nhận đó. `confirm: false` để giữ lệnh huỷ
 * chưa xác nhận (test DEC-253).
 */
function run(c: VolumeMakerConfig, events: StrategyEvent[], opts: { confirm?: boolean } = {}) {
  let s: VolumeMakerState = volumeMaker.initialState(c);
  const all: StrategyAction[] = [];
  const feed = (e: StrategyEvent) => {
    const r = volumeMaker.step(c, s, e, ctx);
    s = r.state;
    all.push(...r.actions);
    if (opts.confirm === false) return;
    for (const a of r.actions)
      if (a.type === "cancel" && s.orders[a.clOrdID]?.status === "cancelling")
        feed({ type: "orderDone", at: e.at, clOrdID: a.clOrdID });
  };
  for (const e of events) feed(e);
  return { s, all };
}
const places = (a: StrategyAction[]) => a.flatMap((x) => (x.type === "place" ? [x.order] : []));
/** SoDEX xác nhận mọi lệnh đang huỷ (engine gửi `orderDone`). */
function confirmed(c: VolumeMakerConfig, s: VolumeMakerState, at: number): VolumeMakerState {
  let st = s;
  for (const [id, o] of Object.entries(s.orders))
    if (o.status === "cancelling")
      st = volumeMaker.step(c, st, { type: "orderDone", at, clOrdID: id }, ctx).state;
  return st;
}
/**
 * Một bước rồi SoDEX xác nhận ngay các lệnh huỷ của bước đó (engine gửi `orderDone`): lệnh mở mới của phía bị huỷ chỉ
 * được đặt sau xác nhận (DEC-257). Trả mọi hành động của bước và các lần xác nhận.
 */
function stepConfirmed(c: VolumeMakerConfig, s: VolumeMakerState, e: StrategyEvent) {
  const r = volumeMaker.step(c, s, e, ctx);
  let state = r.state;
  const actions = [...r.actions];
  for (const a of r.actions)
    if (a.type === "cancel" && state.orders[a.clOrdID]?.status === "cancelling") {
      const x = volumeMaker.step(
        c,
        state,
        { type: "orderDone", at: e.at, clOrdID: a.clOrdID },
        ctx,
      );
      state = x.state;
      actions.push(...x.actions);
    }
  return { state, actions };
}
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
    // Nhật ký lúc dừng cho biết lý do MAX_CYCLES (API đọc để hiện "volume target reached").
    const log = r2.actions.find((x) => x.type === "log" && x.decision === VOLUME_MAKER_STOPPED);
    expect(log?.type === "log" ? volumeMakerStopCause(log.why) : null).toBe("volume_target");
    // Tên sản phẩm (#463), không còn "Volume Maker stopped".
    expect(VOLUME_MAKER_STOPPED).toBe("Market Making stopped");
  });

  it("reads the MAX_CYCLES cause back from the stop log", () => {
    expect(volumeMakerStopCause("Volume target 100000 reached.")).toBe("volume_target");
    expect(volumeMakerStopCause("Volume target 2500.5 reached.")).toBe("volume_target");
    expect(volumeMakerStopCause("Run time ended.")).toBe("end_time");
    expect(volumeMakerStopCause("Cost 10 reached the budget of 10.")).toBeNull();
    expect(volumeMakerStopCause("Inventory loss reached 0.5.")).toBeNull();
    expect(volumeMakerStopCause(null)).toBeNull();
  });

  it("logs “Run time ended.” when the end time passes", () => {
    const t = cfg({ runUntil: "date", untilAt: 5 });
    const s2 = run(t, [...firstQuote()]).s;
    const r = volumeMaker.step(
      t,
      s2,
      { type: "tick", at: 10, market: "BTC-USD", price: "100000" },
      ctx,
    );
    expect(r.actions.find((x) => x.type === "stop")).toMatchObject({ reason: "MAX_CYCLES" });
    const log = r.actions.find((x) => x.type === "log" && x.decision === VOLUME_MAKER_STOPPED);
    expect(log?.type === "log" ? volumeMakerStopCause(log.why) : null).toBe("end_time");
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
    const { s } = run(c, [...firstQuote(), { type: "timer", at: 3000 }], { confirm: false });
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
    const r = stepConfirmed(c, s, { type: "timer", at: 2000 });
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
    const r = stepConfirmed(c, s, { type: "timer", at: 2000 });
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

    // Cycle 3 (t=5 s): giá chạy nên giá đích của lệnh đóng đổi (DEC-390: cùng giá thì giữ nguyên) → vm:2:rc → cancelling;
    // pendingClose covers remaining → no new close.
    s = volumeMaker.step(
      c,
      s,
      { type: "tick", at: 4900, market: "BTC-USD", price: "100050" },
      ctx,
    ).state;
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
    s = confirmed(c, s, 3000);
    // Cycle sau: flat → two-sided symmetric quoting (no reduce-only). Mỗi phía đặt lại sau khi SoDEX xác nhận huỷ lệnh
    // cũ (DEC-257). Lần đặt lại phía bán lúc 3 s không làm lùi lần báo giá đầy đủ: 4.5 s vẫn huỷ cả hai.
    const t = volumeMaker.step(c, s, { type: "timer", at: 4500 }, ctx);
    expect(t.actions.filter((a) => a.type === "cancel")).toHaveLength(2);
    // SoDEX xác nhận sau một vòng (0.5 s): mỗi phía đặt lại một lần.
    let st = t.state;
    const all = [...t.actions];
    for (const [cid, o] of Object.entries(t.state.orders))
      if (o.status === "cancelling") {
        const x = volumeMaker.step(c, st, { type: "orderDone", at: 5000, clOrdID: cid }, ctx);
        st = x.state;
        all.push(...x.actions);
      }
    const p = places(all);
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
    const r = stepConfirmed(c, s, { type: "timer", at: 2000 });
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
    const r = stepConfirmed(c, s, { type: "timer", at: 2000 });
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
    const r = stepConfirmed(c, s, { type: "timer", at: 2000 });
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
      {
        type: "positionSync",
        at: 1000,
        readAt: 1000,
        historyAt: 0,
        market: "BTC-USD",
        size: "0.005",
        entryPrice: "99990",
      },
      ctx,
    );
    expect(r1.state.drift).toEqual({ size: "0.005", since: 1000, ledger: "0" });
    expect(r1.actions).toHaveLength(0);
    s = r1.state;
    // Second sync before 30 s: still not adopted.
    const r2 = volumeMaker.step(
      c,
      s,
      {
        type: "positionSync",
        at: 15000,
        readAt: 15000,
        historyAt: 0,
        market: "BTC-USD",
        size: "0.005",
        entryPrice: "99990",
      },
      ctx,
    );
    expect(r2.state.drift).not.toBeNull();
    expect(r2.actions).toHaveLength(0);
    s = r2.state;
    // Third sync ≥ 30 s after the first → adopt SoDEX position and flag the bot.
    const r3 = volumeMaker.step(
      c,
      s,
      {
        type: "positionSync",
        at: 31000,
        readAt: 31000,
        historyAt: 0,
        market: "BTC-USD",
        size: "0.005",
        entryPrice: "99990",
      },
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
    // Lần báo giá thứ hai: mỗi phía đặt lại sau khi SoDEX xác nhận huỷ lệnh cũ (DEC-257).
    const p = places(r.all).slice(2);
    return {
      bid: p.findLast((o) => o.side === "buy")?.price,
      ask: p.findLast((o) => o.side === "sell")?.price,
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
  const snap2 = (at: number, bid: string, ask: string) =>
    ({
      type: "timer",
      at,
      market: {
        market: "BTC-USD",
        candles: [],
        book: { bid, ask, bidNotional: "100000", askNotional: "100000" },
      },
    }) as const;
  const last = (a: StrategyAction[], side: "bid" | "ask") =>
    places(a)
      .filter((o) => o.tag.endsWith(`:${side}`))
      .at(-1)?.price;
  const logsOf = (a: StrategyAction[]) => a.flatMap((x) => (x.type === "log" ? [x] : []));
  const on = cfg({ quoteLevel: 0, smartQuoting: true });
  /** Chạy tiếp từ state `s`, trả về action của riêng đợt này. */
  /** Như `run`: mặc định SoDEX xác nhận ngay mọi lệnh huỷ (DEC-257); `confirm: false` để giữ lại. */
  const more = (s: VolumeMakerState, events: StrategyEvent[], opts: { confirm?: boolean } = {}) => {
    let st = s;
    const out: StrategyAction[] = [];
    const feed = (e: StrategyEvent) => {
      const x = volumeMaker.step(on, st, e, ctx);
      st = x.state;
      out.push(...x.actions);
      if (opts.confirm === false) return;
      for (const a of x.actions)
        if (a.type === "cancel" && st.orders[a.clOrdID]?.status === "cancelling")
          feed({ type: "orderDone", at: e.at, clOrdID: a.clOrdID });
    };
    for (const e of events) feed(e);
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
    r = more(r.s, [fairAt(8100, "99839.9")], { confirm: false });
    const cut = places(r.all);
    expect(cut).toEqual([
      expect.objectContaining({
        side: "sell",
        type: "market",
        timeInForce: "IOC",
        reduceOnly: true,
        quantity: "0.005",
        tag: expect.stringMatching(/^vm:[0-9]+:cut:close$/) as string,
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

  it("keeps only the market close when SoDEX confirms the cut cancels of the closing side right away (DEC-257)", () => {
    const r = more(longAt(), [fairAt(8100, "99839.9")]);
    expect(places(r.all)).toEqual([
      expect.objectContaining({ type: "market", reduceOnly: true, quantity: "0.005" }),
    ]);
  });

  describe("holds the side that grows the position while a cut is in flight (DEC-260)", () => {
    /** Đang long, còn một bid mở đang nằm; Binance chạy 16 bp ngược: cắt (lệnh cắt chưa có kết quả). */
    const cutWithBid = () => {
      const long = longAt();
      const s0: VolumeMakerState = {
        ...long,
        orders: {
          ...long.orders,
          "live-bid": {
            side: "buy",
            role: "open",
            price: "99990",
            qty: "0.005",
            filled: "0",
            status: "live",
            since: 7100,
          },
        },
      };
      const r = more(s0, [fairAt(8100, "99839.9")], { confirm: false });
      const cut = places(r.all).find((o) => o.type === "market");
      expect(r.all).toContainEqual({ type: "cancel", clOrdID: "live-bid" });
      return { s: r.s, cutId: cut?.clOrdID ?? "" };
    };

    it("places no bid when SoDEX confirms the bid cancel or the timer comes while the cut is in flight", () => {
      const { s } = cutWithBid();
      let r = more(s, [{ type: "orderDone", at: 8300, clOrdID: "live-bid" }], { confirm: false });
      expect(opens(r.all, "buy")).toHaveLength(0);
      r = more(r.s, [snap(12_000)]);
      expect(opens(r.all, "buy")).toHaveLength(0);
    });

    it("quotes as usual once the cut has filled", () => {
      const { s, cutId } = cutWithBid();
      let r = more(
        s,
        [
          { type: "orderDone", at: 8300, clOrdID: "live-bid" },
          {
            type: "fill",
            at: 8400,
            clOrdID: cutId,
            price: "99839.9",
            quantity: "0.005",
            fee: "0",
          },
        ],
        { confirm: false },
      );
      expect(r.s.ledger.position).toBe("0");
      r = more(r.s, [snap(12_000)]);
      expect(opens(r.all, "buy")).toHaveLength(1);
    });

    it("lets the side quote again when SoDEX rejects the cut", () => {
      const { s, cutId } = cutWithBid();
      let r = more(
        s,
        [
          { type: "orderDone", at: 8300, clOrdID: "live-bid" },
          { type: "orderReject", at: 8400, clOrdID: cutId, code: "REJECTED" },
        ],
        { confirm: false },
      );
      r = more(r.s, [snap(12_000)]);
      expect(opens(r.all, "buy")).toHaveLength(1);
    });

    it("keeps holding after a partial fill of the cut, until SoDEX reports it done", () => {
      const { s, cutId } = cutWithBid();
      let r = more(
        s,
        [
          { type: "orderDone", at: 8300, clOrdID: "live-bid" },
          {
            type: "fill",
            at: 8400,
            clOrdID: cutId,
            price: "99839.9",
            quantity: "0.002",
            fee: "0",
          },
        ],
        { confirm: false },
      );
      r = more(r.s, [snap(12_000)], { confirm: false });
      expect(opens(r.all, "buy")).toHaveLength(0);
      r = more(r.s, [{ type: "orderDone", at: 12_500, clOrdID: cutId }, snap(15_000)]);
      expect(opens(r.all, "buy")).toHaveLength(1);
    });

    it("holds the book requote path too", () => {
      const { s } = cutWithBid();
      let r = more(s, [{ type: "orderDone", at: 8300, clOrdID: "live-bid" }], { confirm: false });
      r = more(r.s, [bookAt(10_000, "99840", "99840.1"), bookAt(11_600, "99845", "99845.1")]);
      expect(opens(r.all, "buy")).toHaveLength(0);
    });

    it("does not cut again while the first cut has no result", () => {
      const { s } = cutWithBid();
      // 6 s sau (quá 5 s nghỉ), giá chạy ngược thêm: lệnh cắt đầu chưa có kết quả, không gửi lệnh market thứ hai.
      const r = more(s, [fairAt(14_200, "99800")], { confirm: false });
      expect(places(r.all).filter((o) => o.type === "market")).toHaveLength(0);
    });

    it("quotes the side again about 60 s later when the cut never gets a result", () => {
      const { s } = cutWithBid();
      let r = more(s, [{ type: "orderDone", at: 8300, clOrdID: "live-bid" }], { confirm: false });
      r = more(r.s, [snap(8100 + VM_STALE_CANCEL_MS - 1000)], { confirm: false });
      expect(opens(r.all, "buy")).toHaveLength(0);
      r = more(r.s, [snap(8100 + VM_STALE_CANCEL_MS + 3000)]);
      expect(opens(r.all, "buy")).toHaveLength(1);
    });

    it("holds the sell side while cutting a short", () => {
      const r0 = quotedAt7s();
      const ask = places(r0.all)
        .filter((o) => o.side === "sell")
        .at(-1);
      const short = more(r0.s, [
        {
          type: "fill",
          at: 7100,
          clOrdID: ask?.clOrdID ?? "",
          price: ask?.price ?? "0",
          quantity: ask?.quantity ?? "0",
          fee: "0",
        },
      ]).s;
      expect(short.ledger.position).toBe("-0.005");
      const s0: VolumeMakerState = {
        ...short,
        orders: {
          ...short.orders,
          "live-ask": {
            side: "sell",
            role: "open",
            price: "100010",
            qty: "0.005",
            filled: "0",
            status: "live",
            since: 7100,
          },
        },
      };
      let r = more(s0, [fairAt(8100, "100160.1")], { confirm: false });
      expect(places(r.all).find((o) => o.type === "market")?.side).toBe("buy");
      r = more(r.s, [{ type: "orderDone", at: 8300, clOrdID: "live-ask" }, snap(12_000)], {
        confirm: false,
      });
      expect(opens(r.all, "sell")).toHaveLength(0);
    });
  });

  it("leaves the close order to the normal cycle when the live price moves (DEC-248)", () => {
    // Đang long, lệnh đóng (bán) nằm ở 100000; ask tốt nhất xuống 99990 → không huỷ lệnh đóng.
    const r1 = more(longAt(), [snap(10100)]);
    const close = places(r1.all).find((o) => o.reduceOnly);
    expect(close?.side).toBe("sell");
    const r = more(r1.s, [bookAt(12000, "99989", "99990")]);
    expect(r.all.some((x) => x.type === "cancel" && x.clOrdID === close?.clOrdID)).toBe(false);
  });

  it("re-places the close soon after SoDEX confirms its cancel while a position is held (DEC-248)", () => {
    const r1 = more(longAt(), [snap(10100)]);
    const closeId = places(r1.all).find((o) => o.reduceOnly)?.clOrdID ?? "";
    // Chu kỳ kế tiếp, ask tốt nhất đã đổi nên giá đích của lệnh đóng đổi: huỷ lệnh đóng (không đặt lại vì lệnh cũ còn
    // đang huỷ). Cùng giá thì lệnh đóng được giữ nguyên (DEC-390).
    let r = more(r1.s, [snap2(13200, "100000", "100000.1")], { confirm: false });
    expect(r.s.orders[closeId]?.status).toBe("cancelling");
    r = more(r.s, [{ type: "orderDone", at: 13500, clOrdID: closeId }], { confirm: false });
    expect(r.s.requoteDue).toBe(true);
  });

  it("DEC-390: with Smart quoting on, the close stays live when the book keeps its price", () => {
    const r1 = more(longAt(), [snap(10100)]);
    const closeId = places(r1.all).find((o) => o.reduceOnly)?.clOrdID ?? "";
    expect(closeId).not.toBe("");
    const r = more(r1.s, [snap(13200)], { confirm: false });
    expect(r.all.some((a) => a.type === "cancel" && a.clOrdID === closeId)).toBe(false);
    expect(places(r.all).filter((o) => o.reduceOnly)).toEqual([]);
    expect(r.s.orders[closeId]?.status).toBe("live");
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

  /** Báo giá lúc 7 s, mọi lệnh huỷ trước đó đã được SoDEX xác nhận. */
  const clean = () => confirmed(on, quotedAt7s().s, 7200);
  const opens = (a: StrategyAction[], side: "buy" | "sell") =>
    places(a).filter((o) => o.side === side && !o.reduceOnly);

  it("adds no opening quote on a side whose cancel SoDEX has not confirmed, until it does (DEC-253)", () => {
    // Bid bị rút lúc 7.5 s (Binance chạy qua), SoDEX chưa xác nhận huỷ; ask không bị rút.
    const keep = { confirm: false };
    let r = more(clean(), [fairAt(7500, "99999")], keep);
    const pulled = r.all.find((x) => x.type === "cancel");
    const pulledId = pulled?.type === "cancel" ? pulled.clOrdID : "";
    expect(r.s.orders[pulledId]?.side).toBe("buy");
    // Sổ lệnh đổi để cả hai phía cần đặt lại: phía mua không đặt (bid cũ có thể vẫn khớp); phía bán cũng chờ, vì ask đang
    // nằm bị huỷ ngay trong lần này (DEC-257).
    r = more(r.s, [snap2(10_600, "100000.9", "100001")], keep);
    expect(opens(r.all, "buy")).toHaveLength(0);
    expect(opens(r.all, "sell")).toHaveLength(0);
    // SoDEX xác nhận huỷ bid bị rút → bid quay lại ngay, không chờ nhịp đồng hồ.
    r = more(r.s, [{ type: "orderDone", at: 11_000, clOrdID: pulledId }], keep);
    expect(opens(r.all, "buy")).toHaveLength(1);
  });

  it("blocks a side even when the pull happened just before the next requote (DEC-253)", () => {
    // Rút bid lúc 8.6 s, báo giá lại lúc 9 s (0.4 s sau): chưa có xác nhận thì không đặt bid mới.
    let r = more(clean(), [fairAt(8600, "99999")], { confirm: false });
    r = more(r.s, [snap2(9000, "99999.5", "100000")], { confirm: false });
    expect(opens(r.all, "buy")).toHaveLength(0);
  });

  it("still cancels a resting opening order on a blocked side, so the position cannot grow past the limit (DEC-253)", () => {
    // Đang long; phía bán còn ask mở cũ đang huỷ chưa xác nhận và một ask mở đang nằm: lệnh đóng được đặt, ask mở đang
    // nằm bị huỷ (không giữ lại để cộng với lệnh mồ côi thành short gấp đôi).
    const long = longAt();
    const liveAsk = Object.entries(long.orders).find(
      ([, o]) => o.status === "live" && o.side === "sell" && o.role === "open",
    )?.[0];
    expect(liveAsk).toBeDefined();
    // Một ask mở cũ SoDEX chưa xác nhận huỷ (lệnh huỷ tới trước khi lệnh vào sổ).
    const s0: VolumeMakerState = {
      ...long,
      orders: {
        ...long.orders,
        "old-ask": {
          side: "sell",
          role: "open",
          price: "100001",
          qty: "0.005",
          filled: "0",
          status: "cancelling",
          since: 7000,
        },
      },
    };
    const r = more(s0, [snap(10_100)], { confirm: false });
    expect(r.all).toContainEqual({ type: "cancel", clOrdID: liveAsk });
    expect(places(r.all).find((o) => o.reduceOnly)?.side).toBe("sell");
    expect(opens(r.all, "sell")).toHaveLength(0);
  });

  it("cancels first and quotes the side again only once SoDEX confirms the old order is gone (DEC-257)", () => {
    // Chu kỳ thường: huỷ bid cũ, chưa đặt bid mới (bid cũ có thể khớp trong lúc lệnh huỷ đang đi).
    const r1 = more(clean(), [snap2(10_100, "99999.8", "100000")], { confirm: false });
    const cancelled = r1.all.find(
      (x) => x.type === "cancel" && r1.s.orders[x.clOrdID]?.side === "buy",
    );
    expect(opens(r1.all, "buy")).toHaveLength(0);
    const id = cancelled?.type === "cancel" ? cancelled.clOrdID : "";
    // SoDEX xác nhận: bid mới đặt ngay, chỉ phía mua; không thêm lần báo giá đầy đủ.
    const r = more(r1.s, [{ type: "orderDone", at: 10_500, clOrdID: id }], { confirm: false });
    expect(opens(r.all, "buy")).toHaveLength(1);
    expect(opens(r.all, "sell")).toHaveLength(0);
    expect(r.s.requoteDue).toBe(false);
  });

  /** Số request gửi SoDEX (lệnh mới và lệnh huỷ). */
  const requests = (a: StrategyAction[]) =>
    a.filter((x) => x.type === "place" || x.type === "cancel").length;
  /** clOrdID của lệnh mua vừa bị huỷ trong đợt `r`. */
  const pulledBid = (r: { s: VolumeMakerState; all: StrategyAction[] }) => {
    const x = r.all.find((a) => a.type === "cancel" && r.s.orders[a.clOrdID]?.side === "buy");
    return x?.type === "cancel" ? x.clOrdID : "";
  };

  it("quotes a side again on confirmation at most once every 2 s, leaving the rest to the timer (DEC-257)", () => {
    // Binance chạy liên tục: rút → xác nhận → đặt → rút → xác nhận. Lần đặt lại thứ hai trong 2 s chờ nhịp đồng hồ.
    const keep = { confirm: false };
    let n = 0;
    let r = more(clean(), [fairAt(7500, "99999")], keep);
    n += requests(r.all);
    r = more(r.s, [{ type: "orderDone", at: 7600, clOrdID: pulledBid(r) }], keep);
    n += requests(r.all);
    expect(opens(r.all, "buy")).toHaveLength(1);
    r = more(r.s, [fairAt(7700, "99980")], keep);
    n += requests(r.all);
    const second = pulledBid(r);
    expect(second).not.toBe("");
    r = more(r.s, [{ type: "orderDone", at: 7800, clOrdID: second }], keep);
    n += requests(r.all);
    expect(opens(r.all, "buy")).toHaveLength(0);
    expect(r.s.requoteDue).toBe(true);
    // Rút, đặt, rút; lần xác nhận thứ hai không gửi gì.
    expect(n).toBe(3);
  });

  it("keeps a full requote that was already due when it quotes one side again (DEC-257)", () => {
    const keep = { confirm: false };
    let r = more({ ...clean(), requoteDue: true }, [fairAt(7500, "99999")], keep);
    r = more(r.s, [{ type: "orderDone", at: 7600, clOrdID: pulledBid(r) }], keep);
    expect(opens(r.all, "buy")).toHaveLength(1);
    expect(r.s.requoteDue).toBe(true);
  });

  it("does not quote again when SoDEX reports a live order gone that the bot never cancelled (DEC-257)", () => {
    const s0 = clean();
    const liveAsk = Object.entries(s0.orders).find(
      ([, o]) => o.status === "live" && o.side === "sell" && o.role === "open",
    )?.[0];
    expect(liveAsk).toBeDefined();
    const r = more(s0, [{ type: "orderDone", at: 7600, clOrdID: liveAsk ?? "" }], {
      confirm: false,
    });
    expect(requests(r.all)).toBe(0);
    // Phía đó để nhịp đồng hồ báo giá lại.
    expect(r.s.requoteDue).toBe(true);
  });

  it("does not quote again for a cancelled order that filled before the cancel landed (DEC-257)", () => {
    const keep = { confirm: false };
    let r = more(clean(), [fairAt(7500, "99999")], keep);
    const id = pulledBid(r);
    const bid = r.s.orders[id];
    r = more(
      r.s,
      [
        {
          type: "fill",
          at: 7550,
          clOrdID: id,
          price: bid?.price ?? "0",
          quantity: bid?.qty ?? "0",
          fee: "0",
        },
        { type: "orderDone", at: 7600, clOrdID: id },
      ],
      keep,
    );
    expect(r.s.ledger.position).toBe("0.005");
    expect(opens(r.all, "buy")).toHaveLength(0);
    expect(r.s.requoteDue).toBe(true);
  });

  it("stops waiting for a cancel confirmation after 60 s (DEC-253)", () => {
    const keep = { confirm: false };
    let r = more(clean(), [fairAt(7500, "99999")], keep);
    r = more(r.s, [snap2(10_600, "99999.5", "100000")], keep);
    expect(opens(r.all, "buy")).toHaveLength(0);
    // Không bao giờ có xác nhận: hết VM_STALE_CANCEL_MS thì coi như xong, bid quay lại (đối soát vị thế bù phần lỡ).
    r = more(r.s, [snap2(7500 + VM_STALE_CANCEL_MS + 3000, "99999.5", "100000")], keep);
    expect(opens(r.all, "buy")).toHaveLength(1);
  });

  it("does not cut without Smart quoting (DEC-249)", () => {
    const off = cfg({ quoteLevel: 0 });
    const x = volumeMaker.step(off, longAt(), fairAt(8100, "99000"), ctx);
    expect(places(x.actions)).toHaveLength(0);
  });

  it("logs the number of order requests sent to SoDEX each minute (DEC-248)", () => {
    const r = run(on, [...firstQuote(), tickAt(7000, "100000"), snap(7000), snap(61000)]);
    const line = logsOf(r.all).find((l) => l.decision === "Order requests");
    expect(line?.why).toMatch(
      /^Last 61 s: \d+ requests to SoDEX \(new orders and cancels\)\. Longest gap between quotes: \d+\.\d s\.$/,
    );
    // Xét báo giá lúc 0 s, 7 s, 61 s: khoảng dài nhất 54 s (DEC-267).
    expect(line?.why).toContain("Longest gap between quotes: 54.0 s.");
  });

  it("still logs the line when a stuck bot sent nothing for the whole window (review #157)", () => {
    // Bot đã tự dừng báo giá từ lúc 0 s (halted), cửa sổ đếm bắt đầu lúc 0 s với 0 request.
    const s0 = {
      ...run(on, [...firstQuote()]).s,
      phase: "halted" as const,
      reqWin: { since: 0, n: 0, gap: 0 },
    };
    const r = volumeMaker.step(on, s0, tickAt(61_000, "100000"), ctx);
    const line = logsOf(r.actions).find((l) => l.decision === "Order requests");
    expect(line?.why).toBe(
      "Last 61 s: 0 requests to SoDEX (new orders and cancels). Longest gap between quotes: 61.0 s.",
    );
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
      // SoDEX xác nhận ngay lệnh huỷ: phía đó mới đặt lại (DEC-257).
      for (const a of r.actions)
        if (a.type === "cancel" && s.orders[a.clOrdID]?.status === "cancelling") {
          const x = volumeMaker.step(
            c,
            s,
            { type: "orderDone", at: e.at, clOrdID: a.clOrdID },
            alt,
          );
          s = x.state;
          all.push(...x.actions);
        }
    }
    // Lần báo giá thứ hai (sau hai lệnh của lần đầu).
    return places(all).slice(2);
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
    s = confirmed(c, hit.state, 1500);
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
    const r = stepConfirmed(c, s, { type: "timer", at: 2000 });
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
    const r = stepConfirmed(c, s, { type: "timer", at: 2000 });
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
    // SoDEX xác nhận các lệnh vừa rút: phía đó đặt lại ngay lúc xác nhận (DEC-253, DEC-257).
    const out: StrategyAction[] = [];
    for (const [id, o] of Object.entries(b.s.orders))
      if (o.status === "cancelling")
        out.push(...b.step({ type: "orderDone", at: 6900, clOrdID: id }));
    out.push(...b.step(snap(7000)));
    expect(priceOf(out, "ask")).toBe("100015.1");
    // Bid đã thấp hơn giá Binance − 0.5 bp: giữ nguyên ở giá tốt nhất (lệnh cũ nằm yên).
    expect(
      Object.values(b.s.orders).find((o) => o.status === "live" && o.side === "buy")?.price,
    ).toBe("99999.9");
  });

  it("ignores a Binance price older than 1.5 s by its Binance time", () => {
    const b = runFrom(on, run(on, [...firstQuote()]).s);
    b.step(fair(1000, "100010"));
    for (const [id, o] of Object.entries(b.s.orders))
      if (o.status === "cancelling") b.step({ type: "orderDone", at: 1500, clOrdID: id });
    // Lúc 7 s giá Binance đã cũ: báo giá lại (huỷ, SoDEX xác nhận, đặt lại) ở giá tốt nhất, không theo Binance.
    const out = b.step(snap(7000));
    for (const a of out)
      if (a.type === "cancel" && b.s.orders[a.clOrdID]?.status === "cancelling")
        out.push(...b.step({ type: "orderDone", at: 7000, clOrdID: a.clOrdID }));
    expect(priceOf(out, "ask")).toBe("100000");
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

// Export prod 2026-11-15 (ETH-USD, orderSize 20, Smart quoting): bot giữ long 0.0031 ETH (≈ 5.7 USD, dưới mức tối thiểu
// 10 USD của SoDEX) từ 09:12 tới 23:33 UTC. Không đặt được lệnh đóng reduce-only, nên bot báo giá như phẳng: lệnh bán
// 0.011 không reduce-only, cần margin mới, bị từ chối "insufficient margin" hàng nghìn lần
// (DEC-291).
describe("volume maker — dust position and margin rejects (DEC-291)", () => {
  const ethCtx: StepContext = {
    botId: "vm-dust",
    version: 1,
    rules: {
      "ETH-USD": { tickSize: "0.1", stepSize: "0.0001", minQuantity: "0.0001", minNotional: "10" },
    },
    feeRate: "0.00065",
  };
  const c = volumeMakerSchema.parse({
    market: "ETH-USD",
    leverage: 20,
    orderSize: "20",
    distanceBp: "1",
    maxOrders: 1,
    refreshSeconds: 3,
    runUntil: "target_or_budget",
    costBudget: "4",
    onStop: "close_inventory",
  });
  const eid = (tag: string) => clOrdId(ethCtx.botId, ethCtx.version, tag);
  const MARGIN = { code: "-1", insufficientMargin: true } as const;

  /** Một bước, SoDEX xác nhận ngay mọi lệnh huỷ; trả các lệnh đặt của bước. */
  function stepAll(s: VolumeMakerState, e: StrategyEvent) {
    const r = volumeMaker.step(c, s, e, ethCtx);
    let state = r.state;
    const actions = [...r.actions];
    for (const a of r.actions)
      if (a.type === "cancel" && state.orders[a.clOrdID]?.status === "cancelling") {
        const x = volumeMaker.step(
          c,
          state,
          { type: "orderDone", at: e.at, clOrdID: a.clOrdID },
          ethCtx,
        );
        state = x.state;
        actions.push(...x.actions);
      }
    return { state, placed: places(actions) };
  }

  /** Bot đang giữ long 0.0031 ETH (lệnh mua chu kỳ 1 khớp một phần) ở giá 1840. */
  function dustLong() {
    let s = volumeMaker.initialState(c);
    const q = stepAll(s, { type: "tick", at: 0, market: "ETH-USD", price: "1840" });
    expect(q.placed.map((o) => o.tag)).toEqual(["vm:1:bid", "vm:1:ask"]);
    s = q.state;
    s = volumeMaker.step(
      c,
      s,
      {
        type: "fill",
        at: 100,
        clOrdID: eid("vm:1:bid"),
        price: "1839.8",
        quantity: "0.0031",
        fee: "0",
      },
      ethCtx,
    ).state;
    expect(s.ledger.position).toBe("0.0031");
    return s;
  }

  it("quotes a dust long like flat (full non-reduce-only sell) while margin is fine, as the docs say", () => {
    const s = dustLong();
    const { placed } = stepAll(s, { type: "timer", at: 3_000 });
    const ask = placed.find((o) => o.side === "sell");
    expect(ask?.quantity).toBe("0.0108");
    expect(ask?.reduceOnly).toBe(false);
  });

  it("closes the dust with one market IOC reduce-only order after the margin reject, then quotes both sides", () => {
    let s = dustLong();
    const q = stepAll(s, { type: "timer", at: 3_000 });
    const ask = q.placed.find((o) => o.side === "sell");
    if (ask === undefined) throw new Error("no ask");
    expect(ask.quantity).toBe("0.0108");
    const all: StrategyAction[] = [];
    const r = volumeMaker.step(
      c,
      q.state,
      { type: "orderReject", at: 3_000, clOrdID: ask.clOrdID, ...MARGIN },
      ethCtx,
    );
    s = r.state;
    all.push(...r.actions);
    // Đúng một lệnh: market IOC reduce-only, bán đúng bằng vị thế; lệnh đang sống (bid) bị huỷ trước.
    const close = places(r.actions);
    expect(close).toHaveLength(1);
    expect(close[0]).toMatchObject({
      side: "sell",
      type: "market",
      timeInForce: "IOC",
      reduceOnly: true,
      quantity: "0.0031",
      tag: `vm:${String(s.cycle)}:dust:close`,
    });
    expect(close[0]?.price).toBeUndefined();
    const cancels = r.actions.flatMap((a) => (a.type === "cancel" ? [a.clOrdID] : []));
    const bid = q.placed.find((o) => o.side === "buy");
    if (bid === undefined) throw new Error("no bid");
    expect(cancels).toEqual([bid.clOrdID]);
    expect(s.dustHold).toEqual({ side: "sell", position: "0.0031" });
    // SoDEX xác nhận huỷ bid.
    s = volumeMaker.step(
      c,
      s,
      { type: "orderDone", at: 3_000, clOrdID: bid.clOrdID },
      ethCtx,
    ).state;

    // Còn chờ kết quả: các nhịp làm mới và lần từ chối trùng không gửi lệnh đóng thứ hai, không đặt lệnh mở nào.
    let at = 6_100;
    for (let i = 0; i < 5; i += 1) {
      const t = volumeMaker.step(c, s, { type: "timer", at }, ethCtx);
      s = t.state;
      all.push(...t.actions);
      const dup = volumeMaker.step(
        c,
        s,
        { type: "orderReject", at, clOrdID: ask.clOrdID, ...MARGIN },
        ethCtx,
      );
      s = dup.state;
      all.push(...dup.actions);
      at += 3_100;
    }
    expect(places(all)).toHaveLength(1);

    // Khớp hết: ghi Decisions, bỏ giữ phía bán, lần báo giá sau đủ hai phía như phẳng.
    const id = close[0]?.clOrdID ?? "";
    const f = volumeMaker.step(
      c,
      s,
      { type: "fill", at, clOrdID: id, price: "1839.5", quantity: "0.0031", fee: "0" },
      ethCtx,
    );
    s = f.state;
    expect(s.ledger.position).toBe("0");
    expect(s.dustHold ?? null).toBeNull();
    expect(f.actions).toEqual([
      {
        type: "log",
        decision:
          "Closed a small leftover position of 0.0031 ETH at market (below the SoDEX minimum), so quoting can continue.",
        why: "Market IOC reduce-only sell 0.0031 ETH-USD.",
      },
    ]);
    const after = stepAll(s, { type: "timer", at: at + 3_100 });
    expect(after.placed.map((o) => [o.side, o.quantity, o.reduceOnly])).toEqual([
      ["buy", "0.0108", false],
      ["sell", "0.0108", false],
    ]);
  });

  it("holds the sell and does not loop when SoDEX rejects the dust close, until the position changes", () => {
    let s = dustLong();
    let at = 3_000;
    const sells: string[] = [];
    const closes: string[] = [];
    // 30 nhịp làm mới như export: SoDEX từ chối mọi lệnh bán vì thiếu margin, và từ chối cả lệnh đóng vị thế lẻ.
    for (let i = 0; i < 30; i += 1) {
      const r = stepAll(s, { type: "timer", at });
      s = r.state;
      for (const o of r.placed) {
        if (o.side !== "sell") continue;
        sells.push(o.clOrdID);
        const x = volumeMaker.step(
          c,
          s,
          { type: "orderReject", at, clOrdID: o.clOrdID, ...MARGIN },
          ethCtx,
        );
        s = x.state;
        for (const p of places(x.actions)) {
          closes.push(p.clOrdID);
          const y = volumeMaker.step(
            c,
            s,
            { type: "orderReject", at, clOrdID: p.clOrdID, code: "-1" },
            ethCtx,
          );
          expect(y.actions).toEqual([]);
          s = y.state;
        }
      }
      at += 3_100;
    }
    // Chỉ lệnh bán đầu tiên và một lệnh đóng vị thế lẻ được gửi; sau đó không gửi lại gì ở phía bán.
    expect(sells).toHaveLength(1);
    expect(closes).toHaveLength(1);
    expect(s.dustHold).toEqual({ side: "sell", position: "0.0031" });
    // Lệnh đóng lẻ bị từ chối không làm lệnh đóng chuyển sang không reduce-only.
    expect(s.closeReduceOnly).toBe(true);
    // Phía mua vẫn báo giá (lệnh mua làm vị thế đủ lớn để có lệnh đóng reduce-only).
    const r = stepAll(s, { type: "timer", at });
    expect(r.placed.map((o) => o.side)).toEqual(["buy"]);
    s = r.state;
    at += 3_100;

    // Vị thế đổi (mua thêm 0.0001, vẫn dưới mức tối thiểu): thử lại phía bán như bình thường.
    const bid = r.placed[0];
    if (bid === undefined) throw new Error("no bid");
    s = volumeMaker.step(
      c,
      s,
      {
        type: "fill",
        at,
        clOrdID: bid.clOrdID,
        price: bid.price ?? "0",
        quantity: "0.0001",
        fee: "0",
      },
      ethCtx,
    ).state;
    const again = stepAll(s, { type: "timer", at: at + 3_100 });
    expect(again.placed.some((o) => o.side === "sell")).toBe(true);
    expect(again.state.dustHold ?? null).toBeNull();
  });

  it("keeps quoting the sell after a reject that is not about margin", () => {
    let s = dustLong();
    const r = stepAll(s, { type: "timer", at: 3_000 });
    const ask = r.placed.find((o) => o.side === "sell");
    if (ask === undefined) throw new Error("no ask");
    s = volumeMaker.step(
      c,
      r.state,
      { type: "orderReject", at: 3_000, clOrdID: ask.clOrdID, code: "PostOnly" },
      ethCtx,
    ).state;
    expect(s.dustHold ?? null).toBeNull();
    expect(stepAll(s, { type: "timer", at: 6_100 }).placed.some((o) => o.side === "sell")).toBe(
      true,
    );
  });

  it("quotes the sell again after the user resumes", () => {
    let s = dustLong();
    const r = stepAll(s, { type: "timer", at: 3_000 });
    const ask = r.placed.find((o) => o.side === "sell");
    if (ask === undefined) throw new Error("no ask");
    const x = volumeMaker.step(
      c,
      r.state,
      { type: "orderReject", at: 3_000, clOrdID: ask.clOrdID, ...MARGIN },
      ethCtx,
    );
    const close = places(x.actions)[0];
    if (close === undefined) throw new Error("no dust close");
    s = volumeMaker.step(
      c,
      x.state,
      { type: "orderReject", at: 3_000, clOrdID: close.clOrdID, code: "-1" },
      ethCtx,
    ).state;
    expect(stepAll(s, { type: "timer", at: 6_100 }).placed.some((o) => o.side === "sell")).toBe(
      false,
    );
    s = volumeMaker.step(c, s, { type: "resumed", at: 7_000, prices: {} }, ethCtx).state;
    const again = stepAll(s, { type: "timer", at: 9_200 });
    const ask2 = again.placed.find((o) => o.side === "sell");
    if (ask2 === undefined) throw new Error("no ask after resume");
    // Resume mở đợt mới: lần từ chối vì thiếu margin kế tiếp gửi lại đúng một lệnh đóng vị thế lẻ.
    const y = volumeMaker.step(
      c,
      again.state,
      { type: "orderReject", at: 9_200, clOrdID: ask2.clOrdID, ...MARGIN },
      ethCtx,
    );
    expect(places(y.actions).map((o) => [o.tag, o.quantity, o.reduceOnly])).toEqual([
      [`vm:${String(y.state.cycle)}:dust:close`, "0.0031", true],
    ]);
  });

  it("does not hold a side when a full-size (not dust) position is margin-rejected", () => {
    let s = volumeMaker.initialState(c);
    const q = stepAll(s, { type: "tick", at: 0, market: "ETH-USD", price: "1840" });
    s = q.state;
    // Phẳng hoàn toàn: phía bán bị từ chối vì thiếu margin là việc của engine (pause, DEC-290), không giữ phía nào.
    s = volumeMaker.step(
      c,
      s,
      { type: "orderReject", at: 10, clOrdID: eid("vm:1:ask"), ...MARGIN },
      ethCtx,
    ).state;
    expect(s.dustHold ?? null).toBeNull();
  });
});

describe("volume maker — quote snapshot on quoting decisions (#230)", () => {
  const snapCtx: StepContext = { ...ctx, decisionPayload: true };
  const on = cfg({ quoteLevel: 0, smartQuoting: true });
  type Log = Extract<StrategyAction, { type: "log" }>;
  const logsOf = (a: StrategyAction[]) => a.flatMap((x) => (x.type === "log" ? [x] : []));
  const quoteOf = (a: StrategyAction[], decision: string) => {
    const l = logsOf(a).find((x) => x.decision === decision);
    expect(l).toBeDefined();
    const q = mmQuoteSnapshotSchema.parse(l?.payload?.quote);
    expect(JSON.stringify(q).length).toBeLessThan(MM_QUOTE_SNAPSHOT_MAX_BYTES);
    return q;
  };
  /** Như `run` (SoDEX xác nhận ngay mọi lệnh huỷ), với ngữ cảnh và state đầu chọn được. */
  const runWith = (
    c: VolumeMakerConfig,
    events: readonly StrategyEvent[],
    context: StepContext = snapCtx,
    start?: VolumeMakerState,
    confirm = true,
  ) => {
    let s: VolumeMakerState = start ?? volumeMaker.initialState(c);
    const all: StrategyAction[] = [];
    const feed = (e: StrategyEvent) => {
      const r = volumeMaker.step(c, s, e, context);
      s = r.state;
      all.push(...r.actions);
      if (!confirm) return;
      for (const a of r.actions)
        if (a.type === "cancel" && s.orders[a.clOrdID]?.status === "cancelling")
          feed({ type: "orderDone", at: e.at, clOrdID: a.clOrdID });
    };
    for (const e of events) feed(e);
    return { s, all };
  };
  const tickAt = (at: number, price: string) =>
    ({ type: "tick", at, market: "BTC-USD", price }) as const;
  const snap = (at: number, bid = "99999.9", ask = "100000", bidN = "100000", askN = "100000") =>
    ({
      type: "timer",
      at,
      market: {
        market: "BTC-USD",
        candles: [],
        book: { bid, ask, bidNotional: bidN, askNotional: askN },
      },
    }) as const;
  const bookAt = (at: number, bid: string, ask: string) =>
    ({ type: "book", at, market: "BTC-USD", bid, ask }) as const;
  const fairAt = (at: number, fair: string, age = 50) =>
    ({ type: "fair", at, market: "BTC-USD", fair, binanceAt: at - age }) as const;
  const quoted7s = (c = on) => runWith(c, [...firstQuote(), tickAt(7000, "100000"), snap(7000)]);
  /** Bỏ `payload` (Decisions) và `context` (lệnh): phần còn lại phải y hệt khi không dựng snapshot. */
  const strip = (a: StrategyAction[]) =>
    a.map((x) =>
      x.type === "log"
        ? { type: x.type, decision: x.decision, why: x.why }
        : x.type === "place"
          ? { type: x.type, order: x.order }
          : x,
    );
  const ctxOf = (a: StrategyAction[]) =>
    a.flatMap((x) => (x.type === "place" ? [{ order: x.order, context: x.context }] : []));

  it("records the pulled ask, the Binance price and how far past it the ask was", () => {
    const r = runWith(on, [fairAt(7500, "100003")], snapCtx, quoted7s().s, false);
    const ask = Object.entries(quoted7s().s.orders).find(
      ([, o]) => o.status === "live" && o.side === "sell",
    );
    const q = quoteOf(r.all, "Ask pulled");
    expect(q).toMatchObject({
      v: 1,
      reason: "pulled",
      sides: ["sell"],
      fair: { price: "100003", ageMs: 50, used: true, clampBp: 0.5 },
      book: { bid: "99999.9", ask: "100000", mid: "99999.95", ageMs: 500, last: "100000" },
      quote: { level: 0, distanceBp: null },
      inv: { position: "0", entry: null, notional: "0.00", maxUsd: "2000", maxOrders: null },
      smart: { on: true, fastPause: false },
      orders: [
        { id: ask?.[0], side: "sell", role: "open", st: "pulled", price: "100000", size: "0.005" },
      ],
    });
    // Ask 100000 dưới giá Binance 100003 khoảng 0.3 bp; trên mid SoDEX 0.005 bp.
    expect(q.orders[0]?.fairBp).toBe(-0.3);
    expect(q.orders[0]?.bp).toBe(0.01);
  });

  it("records the new quotes and the Smart quoting state when Smart quoting adjusts", () => {
    const r = runWith(on, [...firstQuote(), snap(3000)]);
    const q = quoteOf(r.all, "Smart quoting adjusted");
    expect(q).toMatchObject({
      reason: "refresh",
      sides: ["buy", "sell"],
      fair: { price: null, ageMs: null, used: false, clampBp: null, clamps: 0 },
      smart: { on: true, sig: expect.stringMatching(/^buy:\d+\|sell:\d+$/) as string },
    });
    // Huỷ rồi mới đặt (DEC-257): bước này huỷ hai lệnh cũ; lệnh mới được đặt khi SoDEX xác nhận huỷ.
    expect(q.orders.map((o) => [o.side, o.st, o.price])).toEqual([
      ["buy", "cancel", "99999.9"],
      ["sell", "cancel", "100000.1"],
    ]);
    expect(
      places(r.all)
        .slice(-2)
        .map((o) => o.price),
    ).toEqual(["99979.9", "100020"]);
  });

  it("counts quotes clamped to the Binance price", () => {
    const s0 = runWith(on, [fairAt(6500, "100010")], snapCtx, runWith(on, [...firstQuote()]).s).s;
    // Sổ lệch để chữ ký Smart quoting đổi (có dòng Decisions trong cùng bước báo giá).
    const r = runWith(on, [snap(7000, "99999.9", "100000", "300000", "100000")], snapCtx, s0);
    const q = quoteOf(r.all, "Smart quoting adjusted");
    expect(q.fair).toMatchObject({ price: "100010", used: true, clampBp: 0.5 });
    expect(q.fair.clamps).toBeGreaterThan(0);
    const ask = q.orders.find((o) => o.side === "sell");
    expect(ask?.price).toBe("100015.1");
    expect(ask?.fairBp).toBe(0.51);
  });

  it("records the market close and the inventory on a position cut", () => {
    const r0 = quoted7s();
    const bid = places(r0.all)
      .filter((o) => o.side === "buy")
      .at(-1);
    const long = runWith(
      on,
      [
        {
          type: "fill",
          at: 7100,
          clOrdID: bid?.clOrdID ?? "",
          price: bid?.price ?? "0",
          quantity: bid?.quantity ?? "0",
          fee: "0",
        },
      ],
      snapCtx,
      r0.s,
    ).s;
    const r = runWith(on, [fairAt(8100, "99839.9", 0)], snapCtx, long, false);
    const q = quoteOf(r.all, "Position cut");
    expect(q).toMatchObject({
      reason: "cut",
      sides: ["sell"],
      inv: { position: "0.005", entry: "99999.9", notional: "500.00", maxUsd: "2000" },
    });
    // Lệnh market đóng vị thế trước, rồi các lệnh bị huỷ cùng lúc.
    expect(q.orders[0]).toMatchObject({
      side: "sell",
      role: "close",
      st: "new",
      price: null,
      bp: null,
    });
    expect(q.orders[0]?.id).toBe(places(r.all)[0]?.clOrdID);
    expect(q.orders.slice(1).every((o) => o.st === "cancel")).toBe(true);
  });

  it("samples the resting quotes on the minute line when the step did not quote", () => {
    // Giá Binance giữa bid và ask: không rút gì; tới phút thì ghi "Order requests".
    const r = runWith(on, [fairAt(61_000, "99999.95")], snapCtx, quoted7s().s);
    expect(places(r.all)).toEqual([]);
    const q = quoteOf(r.all, "Order requests");
    expect(q).toMatchObject({ reason: "sample", sides: [] });
    expect(q.orders.map((o) => [o.side, o.st])).toEqual([
      ["buy", "live"],
      ["sell", "live"],
    ]);
  });

  it("names a requote after the best price left a quote behind (DEC-248)", () => {
    const r = runWith(on, [bookAt(61_000, "100000.9", "100001")], snapCtx, quoted7s().s);
    const q = quoteOf(r.all, "Order requests");
    expect(q.reason).toBe("book_moved");
    expect(q.sides).toEqual(["buy"]);
    expect(q.orders.map((o) => [o.side, o.st])).toEqual([
      ["buy", "cancel"],
      ["sell", "live"],
    ]);
  });

  it("names a pause on a fast move, and records it without Smart quoting", () => {
    const c = cfg({ pauseOnFastMoves: true });
    const { s } = runWith(c, [...firstQuote()]);
    const hit = volumeMaker.step(c, s, tickAt(1000, "100021"), snapCtx);
    const q = quoteOf(hit.actions, "Quotes paused on a fast move");
    expect(q).toMatchObject({
      reason: "fast_pause",
      sides: ["buy", "sell"],
      quote: { level: null, distanceBp: "1" },
      smart: { on: false, sig: null, fastPause: true },
      inv: { maxOrders: null },
    });
    expect(q.orders.map((o) => [o.side, o.st])).toEqual([
      ["buy", "cancel"],
      ["sell", "cancel"],
    ]);
  });

  it("does not change orders, Decisions text or state (same result with and without snapshot)", () => {
    const configs = [
      cfg(),
      cfg({ quoteLevel: 0 }),
      on,
      cfg({ quoteLevel: 1, smartQuoting: true, pauseOnFastMoves: true, closeAtEntry: true }),
      cfg({ quoteLevel: 0, smartQuoting: true, maxInventory: undefined, maxOrders: 1 }),
    ];
    const events: StrategyEvent[] = [
      ...firstQuote(),
      snap(3000),
      tickAt(7000, "100000"),
      snap(7000, "99999.9", "100000", "300000", "100000"),
      fairAt(7500, "100003"),
      {
        type: "fill",
        at: 7600,
        clOrdID: id("vm:3:bid"),
        price: "99999.9",
        quantity: "0.005",
        fee: "0",
      },
      bookAt(9200, "100000.9", "100001"),
      snap(10_000),
      tickAt(11_000, "100030"),
      fairAt(12_000, "99800", 0),
      snap(14_000),
      fairAt(61_000, "100000"),
      snap(62_000),
      bookAt(64_000, "100003", "100003.1"),
      snap(121_000),
    ];
    let quoteLogs = 0;
    for (const c of configs) {
      const plain = runWith(c, events, ctx);
      const withSnap = runWith(c, events, snapCtx);
      expect(places(withSnap.all).length).toBeGreaterThan(0);
      expect(strip(withSnap.all)).toEqual(plain.all);
      expect(withSnap.s).toEqual(plain.s);
      expect(plain.all.some((a) => a.type === "log" && a.payload !== undefined)).toBe(false);
      expect(plain.all.some((a) => a.type === "place" && a.context !== undefined)).toBe(false);
      // Mọi lệnh có bối cảnh hợp lệ, gọn (#233).
      for (const p of ctxOf(withSnap.all)) {
        const x = mmOrderContextSchema.parse(p.context);
        expect(JSON.stringify(x).length).toBeLessThan(MM_ORDER_CONTEXT_MAX_BYTES);
      }
      for (const l of logsOf(withSnap.all))
        if (l.payload?.quote !== undefined) {
          quoteLogs += 1;
          expect(mmQuoteSnapshotSchema.safeParse(l.payload.quote).success).toBe(true);
          expect(JSON.stringify(l.payload.quote).length).toBeLessThan(MM_QUOTE_SNAPSHOT_MAX_BYTES);
        }
    }
    // Có dòng được gắn snapshot thật (không so sánh rỗng).
    expect(quoteLogs).toBeGreaterThan(5);
  });

  it("puts a placement context on every order, opening and closing, without Smart quoting (#233)", () => {
    const c = cfg(); // theo khoảng cách bp, tắt Smart quoting
    let r = runWith(c, [...firstQuote(), snap(3000)]);
    // Lệnh mở đặt lại ở bước SoDEX xác nhận huỷ (không có dòng Decisions) vẫn có bối cảnh.
    const opens = ctxOf(r.all);
    expect(opens.length).toBeGreaterThanOrEqual(4);
    for (const p of opens) expect(p.context).toBeDefined();
    const first = mmOrderContextSchema.parse(opens[0]?.context);
    expect(first).toMatchObject({
      v: 2,
      reason: "first",
      mid: "100000",
      bid: null,
      ask: null,
      bookAgeMs: null,
      fair: null,
      level: null,
      pos: "0",
      smart: false,
      sig: null,
      fastPause: false,
    });
    expect(first.bp).toBe(-1);
    const later = opens.slice(2).map((p) => mmOrderContextSchema.parse(p.context));
    // Đặt ở bước SoDEX xác nhận huỷ của lần báo giá 3 s (DEC-257): `requote`, theo sổ REST lúc đó.
    expect(later.map((x) => [x.reason, x.mid])).toEqual([
      ["requote", "99999.95"],
      ["requote", "99999.95"],
    ]);
    // Khớp bid → vị thế long; lần báo giá sau có lệnh đóng reduce-only với bối cảnh có vị thế.
    const bid = opens.filter((p) => p.order.side === "buy").at(-1)?.order;
    r = runWith(
      c,
      [
        {
          type: "fill",
          at: 3100,
          clOrdID: bid?.clOrdID ?? "",
          price: bid?.price ?? "0",
          quantity: bid?.quantity ?? "0",
          fee: "0",
        },
        snap(6100),
      ],
      snapCtx,
      r.s,
    );
    const close = ctxOf(r.all).find((p) => p.order.reduceOnly);
    expect(close).toBeDefined();
    expect(mmOrderContextSchema.parse(close?.context)).toMatchObject({
      reason: "refresh",
      pos: "0.005",
    });
  });

  it("names cut, stop and Binance distance in the placement context (#233)", () => {
    const r0 = quoted7s();
    const ctxs = ctxOf(r0.all).map((p) => mmOrderContextSchema.parse(p.context));
    expect(ctxs.every((x) => x.smart && x.level === 0)).toBe(true);
    // v2 (#229): tuổi sổ có khi bối cảnh theo sổ, null khi không.
    expect(ctxs.every((x) => x.v === 2)).toBe(true);
    for (const x of ctxs)
      if (x.bid === null) expect(x.bookAgeMs).toBeNull();
      else expect(x.bookAgeMs).toBeGreaterThanOrEqual(0);
    expect(ctxs.some((x) => x.bid !== null)).toBe(true);
    const bid = places(r0.all)
      .filter((o) => o.side === "buy")
      .at(-1);
    const long = runWith(
      on,
      [
        {
          type: "fill",
          at: 7100,
          clOrdID: bid?.clOrdID ?? "",
          price: bid?.price ?? "0",
          quantity: bid?.quantity ?? "0",
          fee: "0",
        },
      ],
      snapCtx,
      r0.s,
    ).s;
    const cut = ctxOf(runWith(on, [fairAt(8100, "99839.9", 0)], snapCtx, long, false).all);
    expect(cut).toHaveLength(1);
    expect(mmOrderContextSchema.parse(cut[0]?.context)).toMatchObject({
      reason: "cut",
      fair: "99839.9",
      fairAgeMs: 0,
      bp: null,
      fairBp: null,
      pos: "0.005",
    });
    // Bot tự dừng (Stop when costs reach) kèm đóng vị thế: lệnh đóng market có lý do `stop`.
    const tight = cfg({
      quoteLevel: 0,
      smartQuoting: true,
      costBudget: "1",
      inventoryLossStop: "0.5",
    });
    const stop = ctxOf(runWith(tight, [tickAt(7200, "99000")], snapCtx, long).all);
    expect(stop.map((p) => p.context?.reason)).toEqual(["stop"]);
  });

  it("attaches nothing to decisions that are not about quoting", () => {
    const c = cfg({ costBudget: "10", inventoryLossStop: "5" });
    let { s } = runWith(c, [...firstQuote()]);
    s = volumeMaker.step(
      c,
      s,
      { type: "fill", at: 1, clOrdID: id("vm:1:bid"), price: "99990", quantity: "0.005", fee: "0" },
      snapCtx,
    ).state;
    const r = volumeMaker.step(c, s, tickAt(2000, "98000"), snapCtx);
    const stop = logsOf(r.actions).find((l) => l.decision === VOLUME_MAKER_STOPPED);
    expect(stop).toBeDefined();
    expect(stop?.payload).toBeUndefined();
  });

  it("stays under 1 KB with the most orders and the longest values", () => {
    const base = quoted7s().s;
    const long = "1234567.123456789";
    const orders = Object.fromEntries(
      ["a", "b", "c", "d", "e", "f"].map((k, i) => [
        `dzzzzzz-10-${k.repeat(13)}-0`,
        {
          side: i % 2 === 0 ? ("buy" as const) : ("sell" as const),
          role: i < 2 ? ("close" as const) : ("open" as const),
          price: long,
          qty: "123.456789",
          filled: "0",
          status: "live" as const,
          since: 0,
        },
      ]),
    );
    const after: VolumeMakerState = {
      ...base,
      orders,
      book: { bid: long, ask: "1234567.223456789", bidNotional: "1", askNotional: "1" },
      fair: long,
      fairBinanceAt: 7000,
      smartSig: "buy:pull|sell:pull",
      ledger: { ...base.ledger, position: "-123.456789", avgCost: long },
    };
    const e = { type: "timer", at: 7000 } as const;
    const args = {
      c: on,
      before: base,
      after,
      e,
      actions: [],
      oracle: { marginBp: 0.5, maxAgeMs: 1500 },
    };
    const raw = quoteSnapshot({ ...args, reason: "sample" });
    expect(raw.orders).toHaveLength(4);
    const step = withQuoteSnapshots(
      on,
      base,
      { actions: [{ type: "log", decision: "Order requests", why: "x" }], state: after },
      e,
      args.oracle,
      VOLUME_MAKER_STOPPED,
    );
    const q = mmQuoteSnapshotSchema.parse((step.actions[0] as Log).payload?.quote);
    expect(JSON.stringify(q).length).toBeLessThan(MM_QUOTE_SNAPSHOT_MAX_BYTES);
    expect(q.orders.length).toBeGreaterThan(0);
  });

  it("returns the step unchanged instead of throwing on malformed state", () => {
    const base = quoted7s().s;
    const book = base.book ?? { bid: "1", ask: "2", bidNotional: "0", askNotional: "0" };
    const bad: VolumeMakerState = { ...base, book: { ...book, bid: "not-a-number" } };
    const r = {
      actions: [{ type: "log", decision: "Order requests", why: "x" }] as StrategyAction[],
      state: bad,
    };
    const out = withQuoteSnapshots(
      on,
      base,
      r,
      { type: "timer", at: 7000 },
      { marginBp: 0.5, maxAgeMs: 1500 },
      VOLUME_MAKER_STOPPED,
    );
    expect(out).toBe(r);
  });
});

// DEC-390 (#517 PR B): lệnh đóng rc giữ nguyên khi giá đích không đổi; giá đổi thì huỷ rồi mới đặt (DEC-257).
describe("volume maker keeps the reduce-only close when its price does not change (DEC-390)", () => {
  const T = (s: number) => s * 1000;
  const tick = (at: number, price: string) =>
    ({ type: "tick", at, market: "BTC-USD", price }) as const;
  const timer = (at: number) => ({ type: "timer", at }) as const;
  /** Long 0.005 BTC sau chu kỳ 1, rồi chu kỳ 2 đặt `vm:2:rc` (bán đóng 0.005). */
  function longWithClose(c: VolumeMakerConfig) {
    let s = run(c, [...firstQuote()]).s;
    s = volumeMaker.step(
      c,
      s,
      { type: "fill", at: 1, clOrdID: id("vm:1:bid"), price: "99990", quantity: "0.005", fee: "0" },
      ctx,
    ).state;
    const r = stepConfirmed(c, s, timer(T(2)));
    const rc = places(r.actions).find((o) => o.tag.endsWith(":rc"));
    expect(rc).toMatchObject({ side: "sell", quantity: "0.005", reduceOnly: true });
    return { s: r.state, rc: rc?.clOrdID ?? "", price: rc?.price ?? "" };
  }
  const rcActions = (a: StrategyAction[], rcId: string) => ({
    cancels: a.filter((x) => x.type === "cancel" && x.clOrdID === rcId),
    closes: places(a).filter((o) => o.reduceOnly),
  });

  it("keeps the close live with no cancel and no new close while the target price is the same", () => {
    const c = cfg();
    const base = longWithClose(c);
    const { rc, price } = base;
    let s = base.s;
    for (const at of [T(5), T(8), T(11)]) {
      const r = stepConfirmed(c, s, timer(at));
      const x = rcActions(r.actions, rc);
      expect(x.cancels).toEqual([]);
      expect(x.closes).toEqual([]);
      expect(r.state.orders[rc]).toMatchObject({ status: "live", price, qty: "0.005" });
      s = r.state;
    }
    // Phía làm tăng vị thế (mua) vẫn được huỷ và đặt lại mỗi nhịp như cũ.
    const r = stepConfirmed(c, s, timer(T(14)));
    expect(r.actions.some((a) => a.type === "cancel" && a.clOrdID !== rc)).toBe(true);
    expect(places(r.actions).some((o) => o.side === "buy" && !o.reduceOnly)).toBe(true);
  });

  it("stops keeping the close once it is VM_RC_KEEP_MAX_MS old: cancels, then re-places after SoDEX confirms", () => {
    // Lệnh được giữ không bị huỷ nên engine không tra nó; nếu nó đã chết trên SoDEX mà tin WS trễ, chỉ lần huỷ mới mở
    // đường đối soát. Quá tuổi thì quay về cách cũ.
    expect(VM_RC_KEEP_MAX_MS).toBe(10_000);
    const c = cfg();
    const base = longWithClose(c);
    const placedAt = base.s.orders[base.rc]?.since ?? 0;
    // Còn dưới 10 s: giữ.
    const young = stepConfirmed(c, base.s, timer(placedAt + VM_RC_KEEP_MAX_MS - 1));
    expect(rcActions(young.actions, base.rc)).toEqual({ cancels: [], closes: [] });
    // Đủ 10 s: huỷ, chưa đặt lệnh đóng mới tới khi SoDEX xác nhận.
    const old = volumeMaker.step(c, base.s, timer(placedAt + VM_RC_KEEP_MAX_MS), ctx);
    expect(rcActions(old.actions, base.rc).cancels).toHaveLength(1);
    expect(rcActions(old.actions, base.rc).closes).toEqual([]);
    const done = volumeMaker.step(
      c,
      old.state,
      { type: "orderDone", at: placedAt + VM_RC_KEEP_MAX_MS + 100, clOrdID: base.rc },
      ctx,
    ).state;
    const again = stepConfirmed(c, done, timer(placedAt + VM_RC_KEEP_MAX_MS + 3000));
    const close = places(again.actions).find((o) => o.reduceOnly);
    expect(close).toMatchObject({ side: "sell", quantity: "0.005", reduceOnly: true });
    // Lệnh đóng mới lại được giữ ở nhịp sau (tuổi tính lại từ lúc đặt).
    const next = stepConfirmed(c, again.state, timer(placedAt + VM_RC_KEEP_MAX_MS + 6000));
    expect(rcActions(next.actions, close?.clOrdID ?? "")).toEqual({ cancels: [], closes: [] });
  });

  it("a partial fill does not reset the close's age", () => {
    const c = bookCfg();
    const base = bookLongWithClose(c);
    const placedAt = base.s.orders[base.rc]?.since ?? 0;
    const s = volumeMaker.step(
      c,
      base.s,
      {
        type: "fill",
        at: placedAt + 8000,
        clOrdID: base.rc,
        price: "100000",
        quantity: "0.002",
        fee: "0",
      },
      ctx,
    ).state;
    expect(s.orders[base.rc]?.since).toBe(placedAt);
    const r = volumeMaker.step(c, s, book(placedAt + VM_RC_KEEP_MAX_MS), ctx);
    expect(rcActions(r.actions, base.rc).cancels).toHaveLength(1);
  });

  it("cancels first and places the new close only after SoDEX confirms when the price moves (DEC-257)", () => {
    const c = cfg();
    const base = longWithClose(c);
    const { rc } = base;
    let s = base.s;
    s = volumeMaker.step(c, s, tick(T(4), "100050"), ctx).state;
    const r = volumeMaker.step(c, s, timer(T(5)), ctx);
    expect(rcActions(r.actions, rc).cancels).toHaveLength(1);
    expect(rcActions(r.actions, rc).closes).toEqual([]);
    expect(r.state.orders[rc]?.status).toBe("cancelling");
    // SoDEX xác nhận huỷ, nhịp sau đặt lệnh đóng mới ở giá mới, đủ khối lượng.
    s = volumeMaker.step(c, r.state, { type: "orderDone", at: T(5) + 100, clOrdID: rc }, ctx).state;
    const r2 = stepConfirmed(c, s, timer(T(8)));
    const close = places(r2.actions).find((o) => o.reduceOnly);
    expect(close).toMatchObject({ side: "sell", quantity: "0.005", reduceOnly: true });
    expect(close?.price).not.toBe(r.state.orders[rc]?.price);
  });

  /** Chế độ sổ lệnh (Smart quoting tắt): lệnh đóng đứng ở giá tốt nhất phía đóng, không phụ thuộc khối lượng vị thế. */
  const bookCfg = () => cfg({ quoteLevel: 0 });
  const book = (at: number, bid = "99999.9", ask = "100000") =>
    ({
      type: "timer",
      at,
      market: {
        market: "BTC-USD",
        candles: [],
        book: { bid, ask, bidNotional: "100000", askNotional: "100000" },
      },
    }) as const;
  function bookLongWithClose(c: VolumeMakerConfig) {
    let s = volumeMaker.step(c, volumeMaker.initialState(c), tick(0, "100000"), ctx).state;
    let r = stepConfirmed(c, s, book(T(1)));
    const bid = Object.entries(r.state.orders).find(
      ([, o]) => o.status === "live" && o.side === "buy",
    );
    expect(bid).toBeDefined();
    s = volumeMaker.step(
      c,
      r.state,
      {
        type: "fill",
        at: T(1) + 100,
        clOrdID: bid?.[0] ?? "",
        price: bid?.[1].price ?? "0",
        quantity: "0.005",
        fee: "0",
      },
      ctx,
    ).state;
    s = confirmed(c, s, T(1) + 200);
    r = stepConfirmed(c, s, book(T(4)));
    const rc = places(r.actions).find((o) => o.reduceOnly);
    expect(rc).toMatchObject({ side: "sell", price: "100000", quantity: "0.005" });
    return { s: r.state, rc: rc?.clOrdID ?? "" };
  }

  it("keeps the close after a partial fill: its rest still equals the position", () => {
    const c = bookCfg();
    const base = bookLongWithClose(c);
    const { rc } = base;
    let s = base.s;
    s = volumeMaker.step(
      c,
      s,
      { type: "fill", at: T(5), clOrdID: rc, price: "100000", quantity: "0.002", fee: "0" },
      ctx,
    ).state;
    expect(s.ledger.position).toBe("0.003");
    const r = stepConfirmed(c, s, book(T(7)));
    expect(rcActions(r.actions, rc)).toEqual({ cancels: [], closes: [] });
    expect(r.state.orders[rc]).toMatchObject({ status: "live", qty: "0.005", filled: "0.002" });
  });

  it("keeps the close and adds only the missing part when the position grows", () => {
    const c = bookCfg();
    const base = bookLongWithClose(c);
    const { rc } = base;
    let s = base.s;
    // Phía mua làm tăng vị thế khớp thêm 0.003: vị thế 0.008. Lệnh đóng 0.005 cùng giá được giữ, chỉ đặt thêm 0.003.
    const buy = Object.entries(s.orders).find(
      ([, o]) => o.status === "live" && o.role === "open" && o.side === "buy",
    )?.[0];
    expect(buy).toBeDefined();
    s = volumeMaker.step(
      c,
      s,
      { type: "fill", at: T(5), clOrdID: buy ?? "", price: "99999.7", quantity: "0.003", fee: "0" },
      ctx,
    ).state;
    expect(s.ledger.position).toBe("0.008");
    const r = stepConfirmed(c, s, book(T(7)));
    expect(rcActions(r.actions, rc).cancels).toEqual([]);
    expect(rcActions(r.actions, rc).closes.map((o) => o.quantity)).toEqual(["0.003"]);
    const live = () =>
      Object.entries(r.state.orders).filter(([, o]) => o.role === "close" && o.status === "live");
    expect(live().reduce((n, [, o]) => n + Number(o.qty) - Number(o.filled), 0)).toBeCloseTo(
      0.008,
      9,
    );
    // Nhịp sau, cùng giá: cả hai lệnh đóng được giữ, không huỷ, không đặt thêm.
    const r2 = stepConfirmed(c, r.state, book(T(10)));
    const ids = live().map(([id]) => id);
    expect(r2.actions.filter((a) => a.type === "cancel" && ids.includes(a.clOrdID))).toEqual([]);
    expect(places(r2.actions).filter((o) => o.reduceOnly)).toEqual([]);
  });

  it("cancels then re-sizes the close when the position shrank for another reason (rest above the position)", () => {
    const c = bookCfg();
    const { s, rc } = bookLongWithClose(c);
    // Sổ cái lấy vị thế SoDEX làm chuẩn (DEC-380) và vị thế giảm còn 0.002: lệnh đóng 0.005 vượt vị thế → huỷ rồi mới đặt.
    const shrunk: VolumeMakerState = {
      ...s,
      ledger: { ...s.ledger, position: "0.002" },
    };
    const r = volumeMaker.step(c, shrunk, book(T(7)), ctx);
    expect(rcActions(r.actions, rc).cancels).toHaveLength(1);
    expect(rcActions(r.actions, rc).closes).toEqual([]);
    const done = volumeMaker.step(
      c,
      r.state,
      { type: "orderDone", at: T(7) + 100, clOrdID: rc },
      ctx,
    ).state;
    const close = places(stepConfirmed(c, done, book(T(10))).actions).find((o) => o.reduceOnly);
    expect(close?.quantity).toBe("0.002");
  });

  it("never keeps a close that is not reduce-only, an old close without the flag, or while orders are held (#497)", () => {
    const c = cfg();
    const base = longWithClose(c);
    // Lệnh đóng chỉ post-only (SoDEX từ chối reduce-only): huỷ rồi đặt lại như cũ.
    const notRo = volumeMaker.step(c, { ...base.s, closeReduceOnly: false }, timer(T(5)), ctx);
    expect(rcActions(notRo.actions, base.rc).cancels).toHaveLength(1);
    // State cũ không có cờ reduceOnly trên lệnh.
    const legacy = {
      ...base.s,
      orders: Object.fromEntries(
        Object.entries(base.s.orders).map(([k, o]) => {
          const copy = { ...o };
          delete copy.reduceOnly;
          return [k, copy];
        }),
      ),
    };
    const old = volumeMaker.step(c, legacy, timer(T(5)), ctx);
    expect(rcActions(old.actions, base.rc).cancels).toHaveLength(1);
    // Đang giữ lệnh (Needs attention): lệnh đang nằm vẫn bị huỷ, không đặt gì.
    const stuck = volumeMaker.step(c, { ...base.s, positionStuck: true }, timer(T(5)), ctx);
    expect(rcActions(stuck.actions, base.rc).cancels).toHaveLength(1);
    expect(places(stuck.actions)).toEqual([]);
  });

  it("still applies the SoDEX Max open position cap (DEC-380) to the growing side while the close is kept", () => {
    const c = cfg();
    const base = longWithClose(c);
    // Vị thế SoDEX đọc mới đã chạm Max open position (2000 USDC): không đặt lệnh mua; lệnh đóng reduce-only vẫn nằm.
    const s: VolumeMakerState = { ...base.s, sodexPosition: { size: "0.03", at: T(4) } };
    const r = stepConfirmed(c, s, timer(T(5)));
    expect(places(r.actions).filter((o) => o.side === "buy")).toEqual([]);
    expect(rcActions(r.actions, base.rc).cancels).toEqual([]);
    expect(r.state.orders[base.rc]?.status).toBe("live");
  });
});
