import { Decimal } from "@drift/shared";
import { describe, expect, it } from "vitest";

import {
  capTarget,
  COPY,
  copyTrade,
  freshSize,
  leaderMove,
  type CopyTradeState,
} from "../copy-trade";
import { copyTradeSchema, type CopyTradeConfig } from "../copy-trade/schema";
import type { OrderIntent, StepContext, StrategyAction, StrategyEvent } from "../core/types";

// S12 Copy Trade (DEC-161): vị thế mục tiêu suy ra từ leader, mỗi lúc một lệnh, chỉ bù chiều giảm rủi ro.

const LEADER = "0x1111111111111111111111111111111111111111";
const ctx: StepContext = {
  botId: "copy-bot",
  version: 1,
  rules: {
    "BTC-USD": { tickSize: "1", stepSize: "0.0001", minQuantity: "0.0001", minNotional: "10" },
  },
  feeRate: "0.0002",
};
const T0 = Date.parse("2026-11-11T00:00:00Z");

const cfg = (over: Partial<Record<string, unknown>> = {}): CopyTradeConfig =>
  copyTradeSchema.parse({
    leaderAddress: LEADER,
    market: "BTC-USD",
    leverage: 2,
    fixedNotional: "1000",
    maxNotionalPerTrade: "2000",
    maxExposure: "5000",
    maxLoss: "500",
    ...over,
  });

const leaderFill = (
  side: "buy" | "sell",
  quantity: string,
  positionAfter: string,
  price = "100000",
  lagMs = 300,
  at = T0,
): StrategyEvent => ({
  type: "leaderFill",
  at: at + lagMs,
  leaderAt: at,
  market: "BTC-USD",
  side,
  price,
  quantity,
  positionAfter,
});

/** Phần state của market BTC-USD (DEC-163: state theo từng market). */
const btc = (s: CopyTradeState) => {
  const m = s.markets["BTC-USD"];
  if (m === undefined) throw new Error("no BTC-USD state");
  return m;
};
/** Đặt giá gần nhất của BTC-USD qua một tick. */
const withPrice = (s: CopyTradeState, price = "100000") =>
  copyTrade.step(cfg(), s, { type: "tick", at: T0 - 1000, market: "BTC-USD", price }, ctx).state;

function run(c: CopyTradeConfig, s: CopyTradeState, e: StrategyEvent) {
  return copyTrade.step(c, s, e, ctx);
}
const places = (a: readonly StrategyAction[]): OrderIntent[] =>
  a.flatMap((x) => (x.type === "place" ? [x.order] : []));
const onlyPlace = (a: readonly StrategyAction[]): OrderIntent => {
  const p = places(a);
  expect(p).toHaveLength(1);
  const [o] = p;
  if (o === undefined) throw new Error("no order");
  return o;
};
/** Khớp đủ lệnh đang chờ rồi báo `orderDone`. */
function fillAll(c: CopyTradeConfig, s: CopyTradeState, o: OrderIntent, price = "100000") {
  const f = run(c, s, {
    type: "fill",
    at: T0 + 500,
    clOrdID: o.clOrdID,
    price,
    quantity: o.quantity,
    fee: "0.1",
  });
  const d = run(c, f.state, { type: "orderDone", at: T0 + 600, clOrdID: o.clOrdID });
  return { actions: [...f.actions, ...d.actions], state: d.state };
}
/** Bot đang copy long 0.01 BTC (1.000 USD) của leader đang long 1 BTC. */
function following(c = cfg()) {
  const s0 = copyTrade.initialState(c);
  const r = run(c, withPrice(s0), leaderFill("buy", "1", "1"));
  return fillAll(c, r.state, onlyPlace(r.actions));
}

describe("leaderMove", () => {
  const d = (v: string) => new Decimal(v);
  it.each([
    ["0", "1", "open"],
    ["1", "2", "increase"],
    ["2", "1", "decrease"],
    ["1", "0", "close"],
    ["1", "-1", "flip"],
    ["-1", "-3", "increase"],
    ["1", "1", "none"],
  ])("%s → %s là %s", (a, b, m) => {
    expect(leaderMove(d(a), d(b))).toBe(m);
  });
});

describe("sizing", () => {
  it("fixed: fixedNotional / giá", () => {
    expect(freshSize(cfg(), new Decimal(5), new Decimal(100000)).toString()).toBe("0.01");
  });
  it("ratio: % khối lượng của leader", () => {
    const c = cfg({ sizing: "ratio", ratioPct: "2", fixedNotional: undefined });
    expect(freshSize(c, new Decimal(5), new Decimal(100000)).toString()).toBe("0.1");
  });
  it("cắt theo maxNotionalPerTrade và maxExposure, không cắt chiều giảm", () => {
    const c = cfg();
    const px = new Decimal(100000);
    expect(capTarget(c, new Decimal(0), new Decimal(1), px).toString()).toBe("0.02");
    expect(capTarget(c, new Decimal(0.04), new Decimal(1), px).toString()).toBe("0.05");
    expect(capTarget(c, new Decimal(-0.01), new Decimal(-1), px).toString()).toBe("-0.03");
    expect(capTarget(c, new Decimal(0.04), new Decimal(0.01), px).toString()).toBe("0.01");
  });
  it("schema: thiếu cỡ thì báo lỗi, địa chỉ chuẩn hoá chữ thường", () => {
    expect(() => cfg({ fixedNotional: undefined })).toThrow();
    expect(() => cfg({ sizing: "ratio", fixedNotional: undefined })).toThrow();
    expect(() => cfg({ fixedNotional: "3000" })).toThrow();
    expect(cfg({ leaderAddress: LEADER.toUpperCase().replace("0X", "0x") }).leaderAddress).toBe(
      LEADER,
    );
  });
});

describe("copy_trade step", () => {
  it("leader mở long: IOC giới hạn tại giá leader + trượt giá tối đa", () => {
    const c = cfg();
    const s0 = withPrice(copyTrade.initialState(c), "100000");
    const r = run(c, s0, leaderFill("buy", "1", "1"));
    const o = onlyPlace(r.actions);
    expect(o).toMatchObject({
      side: "buy",
      type: "limit",
      timeInForce: "IOC",
      reduceOnly: false,
      quantity: "0.01",
      price: "100300",
      engine: "perps",
    });
    expect(btc(r.state).tracking).toBe(true);
    const f = fillAll(c, r.state, o);
    expect(btc(f.state).ledger.position).toBe("0.01");
    expect(btc(f.state).inflight).toBeNull();
    expect(f.state.copied).toBe(1);
  });

  it("inverse: leader mở long thì bot mở short", () => {
    const c = cfg({ direction: "inverse" });
    const s0 = withPrice(copyTrade.initialState(c), "100000");
    const o = onlyPlace(run(c, s0, leaderFill("buy", "1", "1")).actions);
    expect(o).toMatchObject({ side: "sell", price: "99700", quantity: "0.01" });
  });

  it("không copy vị thế leader có từ trước khi start", () => {
    const c = cfg();
    const s0 = withPrice(copyTrade.initialState(c), "100000");
    const a = run(c, s0, { type: "leaderPosition", at: T0, market: "BTC-USD", size: "3" });
    const b = run(c, a.state, leaderFill("buy", "1", "4"));
    expect(places(b.actions)).toHaveLength(0);
    const close = run(c, b.state, leaderFill("sell", "4", "0"));
    expect(places(close.actions)).toHaveLength(0);
    // Vị thế mới sau đó thì copy.
    const open = run(c, close.state, leaderFill("buy", "1", "1"));
    expect(onlyPlace(open.actions).side).toBe("buy");
  });

  it("leader tăng gấp đôi: bot tăng theo tỷ lệ, có trần mỗi lệnh", () => {
    const c = cfg();
    const f = following(c);
    const r = run(c, f.state, leaderFill("buy", "1", "2"));
    expect(onlyPlace(r.actions)).toMatchObject({
      side: "buy",
      quantity: "0.01",
      reduceOnly: false,
    });
    const big = run(c, f.state, leaderFill("buy", "9", "10"));
    // 0.01 × 10 = 0.1 BTC, nhưng phần tăng tối đa 2.000 USD = 0.02 BTC.
    expect(onlyPlace(big.actions).quantity).toBe("0.02");
  });

  it("leader giảm 40%: bot giảm 40% bằng market reduce-only", () => {
    const c = cfg();
    const f = following(c);
    const r = run(c, f.state, leaderFill("sell", "0.4", "0.6"));
    expect(onlyPlace(r.actions)).toMatchObject({
      side: "sell",
      type: "market",
      reduceOnly: true,
      quantity: "0.004",
    });
  });

  it("leader đóng: bot đóng hết và ngừng theo vị thế đó", () => {
    const c = cfg();
    const f = following(c);
    const r = run(c, f.state, leaderFill("sell", "1", "0"));
    const o = onlyPlace(r.actions);
    expect(o).toMatchObject({ side: "sell", type: "market", reduceOnly: true, quantity: "0.01" });
    const done = fillAll(c, r.state, o);
    expect(btc(done.state).ledger.position).toBe("0");
    expect(btc(done.state).tracking).toBe(false);
  });

  it("leader đảo chiều: đóng long trước rồi mở short", () => {
    const c = cfg();
    const f = following(c);
    const r = run(c, f.state, leaderFill("sell", "2", "-1"));
    const close = onlyPlace(r.actions);
    expect(close).toMatchObject({ side: "sell", reduceOnly: true, quantity: "0.01" });
    const after = fillAll(c, r.state, close);
    const open = onlyPlace(after.actions);
    expect(open).toMatchObject({
      side: "sell",
      type: "limit",
      reduceOnly: false,
      quantity: "0.01",
    });
  });

  it("giá đã chạy quá ngưỡng trượt giá: bỏ qua, không đặt lệnh", () => {
    const c = cfg();
    const s0 = withPrice(copyTrade.initialState(c), "100500");
    const r = run(c, s0, leaderFill("buy", "1", "1"));
    expect(places(r.actions)).toHaveLength(0);
    expect(r.state.skipped).toBe(1);
    expect(btc(r.state).tracking).toBe(false);
  });

  it("IOC không khớp: bỏ qua, không đuổi theo", () => {
    const c = cfg();
    const s0 = withPrice(copyTrade.initialState(c), "100000");
    const r = run(c, s0, leaderFill("buy", "1", "1"));
    const o = onlyPlace(r.actions);
    const d = run(c, r.state, { type: "orderDone", at: T0 + 600, clOrdID: o.clOrdID });
    expect(places(d.actions)).toHaveLength(0);
    expect(btc(d.state).target).toBe("0");
    expect(btc(d.state).tracking).toBe(false);
    expect(d.state.skipped).toBe(1);
  });

  it("tín hiệu mở đến trễ thì bỏ; tín hiệu đóng đến trễ vẫn đóng", () => {
    const c = cfg();
    const s0 = withPrice(copyTrade.initialState(c), "100000");
    const late = run(c, s0, leaderFill("buy", "1", "1", "100000", COPY.maxSignalAgeMs + 1));
    expect(places(late.actions)).toHaveLength(0);
    const f = following(c);
    const closeLate = run(c, f.state, leaderFill("sell", "1", "0", "100000", 60_000));
    expect(onlyPlace(closeLate.actions).reduceOnly).toBe(true);
  });

  it("stream rớt: leaderPosition bù tín hiệu đóng / giảm, không bù tín hiệu tăng", () => {
    const c = cfg();
    const f = following(c);
    const up = run(c, f.state, {
      type: "leaderPosition",
      at: T0 + 9e5,
      market: "BTC-USD",
      size: "3",
    });
    expect(places(up.actions)).toHaveLength(0);
    const cut = run(c, f.state, {
      type: "leaderPosition",
      at: T0 + 9e5,
      market: "BTC-USD",
      size: "0.5",
    });
    expect(onlyPlace(cut.actions)).toMatchObject({ reduceOnly: true, quantity: "0.005" });
    const gone = run(c, f.state, {
      type: "leaderPosition",
      at: T0 + 9e5,
      market: "BTC-USD",
      size: "0",
    });
    expect(onlyPlace(gone.actions)).toMatchObject({ reduceOnly: true, quantity: "0.01" });
  });

  it("lệnh giảm khớp thiếu thì thử lại; 3 lần thì pause", () => {
    const c = cfg();
    const f = following(c);
    let r = run(c, f.state, leaderFill("sell", "1", "0"));
    for (let i = 1; i < COPY.maxReduceAttempts; i += 1) {
      const o = onlyPlace(r.actions);
      r = run(c, r.state, { type: "orderDone", at: T0 + 1000 * i, clOrdID: o.clOrdID });
    }
    const o = onlyPlace(r.actions);
    const last = run(c, r.state, { type: "orderDone", at: T0 + 9000, clOrdID: o.clOrdID });
    expect(last.actions).toContainEqual({ type: "pause", reason: "ORDER_REJECTED" });
    expect(last.state.phase).toBe("halted");
  });

  it("chỉ một lệnh tại một thời điểm: tín hiệu mới chờ lệnh đang chạy xong", () => {
    const c = cfg();
    const s0 = withPrice(copyTrade.initialState(c), "100000");
    const a = run(c, s0, leaderFill("buy", "1", "1"));
    const o = onlyPlace(a.actions);
    const b = run(c, a.state, leaderFill("sell", "1", "0"));
    expect(places(b.actions)).toHaveLength(0);
    expect(btc(b.state).target).toBe("0");
    // Lệnh mở khớp rồi: giờ mới đóng.
    const done = fillAll(c, b.state, o);
    expect(onlyPlace(done.actions)).toMatchObject({ reduceOnly: true, quantity: "0.01" });
  });

  it("stop loss của bot: đóng và chờ vị thế mới của leader", () => {
    const c = cfg({ stopLossPct: "5" });
    const f = following(c);
    const r = run(c, f.state, { type: "tick", at: T0 + 1e6, market: "BTC-USD", price: "94000" });
    expect(onlyPlace(r.actions)).toMatchObject({ reduceOnly: true, quantity: "0.01" });
    expect(btc(r.state).tracking).toBe(false);
    // Leader tăng tiếp: không mở lại.
    const done = fillAll(c, r.state, onlyPlace(r.actions), "94000");
    const add = run(c, done.state, leaderFill("buy", "1", "2"));
    expect(places(add.actions)).toHaveLength(0);
  });

  it("max loss: dừng bot và đóng vị thế", () => {
    const c = cfg({ maxLoss: "50" });
    const f = following(c);
    const r = run(c, f.state, { type: "tick", at: T0 + 1e6, market: "BTC-USD", price: "94000" });
    expect(r.actions).toContainEqual({ type: "stop", reason: "BOT_MAX_LOSS", close: true });
    expect(r.state.phase).toBe("halted");
  });

  it("clOrdID tất định: cùng chuỗi event cho cùng lệnh", () => {
    const c = cfg();
    const s0 = withPrice(copyTrade.initialState(c), "100000");
    const a = onlyPlace(run(c, s0, leaderFill("buy", "1", "1")).actions);
    const b = onlyPlace(run(c, s0, leaderFill("buy", "1", "1")).actions);
    expect(a.clOrdID).toBe(b.clOrdID);
  });
});

describe("copy_trade khớp trễ", () => {
  it("lệnh mở khớp nhiều lần rồi hết hạn: cộng đủ các lần khớp, xong khi orderDone (P0.1)", () => {
    const c = cfg();
    const s0 = withPrice(copyTrade.initialState(c), "100000");
    const r = run(c, s0, leaderFill("buy", "1", "1"));
    const o = onlyPlace(r.actions);
    const fill = (st: CopyTradeState, q: string, at: number) =>
      run(c, st, { type: "fill", at, clOrdID: o.clOrdID, price: "100000", quantity: q, fee: "0" });
    const a = fill(r.state, "0.003", T0 + 400);
    const b = fill(a.state, "0.004", T0 + 450);
    // Chưa đủ 0.01: còn chờ.
    expect(btc(b.state).inflight?.filled).toBe("0.007");
    const d = run(c, b.state, { type: "orderDone", at: T0 + 500, clOrdID: o.clOrdID });
    expect(btc(d.state).inflight).toBeNull();
    expect(btc(d.state).ledger.position).toBe("0.007");
    expect(btc(d.state).target).toBe("0.007");
    expect(places(d.actions)).toHaveLength(0);
  });

  it("lệnh đang chờ không có orderDone quá 60 s: coi như xong với phần đã khớp (P0.1)", () => {
    const c = cfg();
    const s0 = withPrice(copyTrade.initialState(c), "100000");
    const r = run(c, s0, leaderFill("buy", "1", "1"));
    const o = onlyPlace(r.actions);
    const part = run(c, r.state, {
      type: "fill",
      at: T0 + 400,
      clOrdID: o.clOrdID,
      price: "100000",
      quantity: "0.005",
      fee: "0",
    });
    const early = run(c, part.state, { type: "timer", at: T0 + 300 + COPY.inflightTimeoutMs - 1 });
    expect(btc(early.state).inflight).not.toBeNull();
    const late = run(c, early.state, { type: "timer", at: T0 + 300 + COPY.inflightTimeoutMs });
    expect(btc(late.state).inflight).toBeNull();
    expect(btc(late.state).target).toBe("0.005");
    // Fill tới sau hạn vẫn vào sổ cái như fill trễ.
    const after = run(c, late.state, {
      type: "fill",
      at: T0 + 70_000,
      clOrdID: o.clOrdID,
      price: "100000",
      quantity: "0.005",
      fee: "0",
    });
    expect(btc(after.state).ledger.position).toBe("0.01");
  });

  it("lệnh mở khớp sau orderDone, chưa có tín hiệu mới: giữ phần đã khớp", () => {
    const c = cfg();
    const f = following(c);
    const r = run(c, f.state, leaderFill("buy", "1", "2"));
    const o = onlyPlace(r.actions);
    const d = run(c, r.state, { type: "orderDone", at: T0 + 600, clOrdID: o.clOrdID });
    // orderDone tới trước fill: lệnh bị coi là không khớp.
    expect(btc(d.state).target).toBe("0.01");
    const late = run(c, d.state, {
      type: "fill",
      at: T0 + 700,
      clOrdID: o.clOrdID,
      price: "100000",
      quantity: o.quantity,
      fee: "0.1",
    });
    expect(btc(late.state).ledger.position).toBe("0.02");
    expect(btc(late.state).target).toBe("0.02");
    expect(places(late.actions)).toHaveLength(0);
  });
});
