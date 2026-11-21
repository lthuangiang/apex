import { dec, ReasonCode } from "@drift/shared";
import { describe, expect, it } from "vitest";

import { GRID_KEEP_ENDED, type GridBotState } from "../common/grid-bot";
import type {
  OrderIntent,
  StepResult,
  StrategyAction,
  StrategyEvent,
  StrategyModule,
} from "../core/types";
import { futuresGrid } from "../futures-grid";
import { futuresGridSchema, type FuturesGridConfig } from "../futures-grid/schema";
import { spotGrid } from "../spot-grid";
import { spotGridSchema, type SpotGridConfig } from "../spot-grid/schema";

// #261 (DEC-359): lệnh của một mức grid khớp một phần nhiều lần. Mỗi lần khớp vào sổ cái, lệnh vẫn được
// theo dõi tới khi khớp hết hoặc kết thúc trên sàn; chỉ khi khớp hết mới đặt MỘT lệnh đối ứng bằng tổng đã khớp.

const rules = { tickSize: "1", stepSize: "0.001", minQuantity: "0.001", minNotional: "5" };
const ctx = {
  botId: "bot-fg",
  version: 1,
  feeRate: "0.0005",
  rules: { "BTC-USD": rules, vBTC_vUSDC: rules },
};
// Mức 90, 95, 100, 105, 110; khối lượng mỗi mức 1 (danh nghĩa 500 / 5 mức / giá TB 100).
const perps = (o: Partial<FuturesGridConfig> = {}): FuturesGridConfig =>
  futuresGridSchema.parse({
    market: "BTC-USD",
    leverage: 2,
    marginMode: "cross",
    direction: "neutral",
    lowerPrice: "90",
    upperPrice: "110",
    gridLevels: 5,
    spacing: "arithmetic",
    margin: "250",
    stopBelow: "50",
    stopAbove: "150",
    maxLoss: "100",
    onStop: "close_at_market",
    ...o,
  });
const spot: SpotGridConfig = spotGridSchema.parse({
  market: "vBTC_vUSDC",
  lowerPrice: "90",
  upperPrice: "110",
  gridLevels: 5,
  spacing: "arithmetic",
  investment: "500",
  maxLoss: "100",
  onStop: "keep_base",
});

const placed = (a: StrategyAction[]): OrderIntent[] =>
  a.flatMap((x) => (x.type === "place" ? [x.order] : []));
const cancels = (a: StrategyAction[]) => a.filter((x) => x.type === "cancel");
const show = (o: OrderIntent) => `${o.side}@${o.price ?? "mkt"}x${o.quantity}`;

/** Chạy bot từng bước; `restart` nạp lại state qua JSON như engine đọc từ DB sau khi khởi động lại. */
interface Runner {
  s: GridBotState;
  tick: (price: string) => StepResult<GridBotState>;
  fill: (o: OrderIntent | string, quantity: string, price?: string) => StepResult<GridBotState>;
  done: (o: OrderIntent) => StepResult<GridBotState>;
  restart: () => void;
}
function bot<C extends { market: string }>(mod: StrategyModule<C, GridBotState>, cfg: C): Runner {
  let s = mod.initialState(cfg);
  let at = 0;
  const step = (e: StrategyEvent): StepResult<GridBotState> => {
    const r = mod.step(cfg, s, e, ctx);
    s = r.state;
    return r;
  };
  const market = cfg.market;
  return {
    get s() {
      return s;
    },
    set s(v: GridBotState) {
      s = v;
    },
    tick: (price: string) => step({ type: "tick", at: (at += 1000), market, price }),
    fill: (o: OrderIntent | string, quantity: string, price?: string) =>
      step({
        type: "fill",
        at: (at += 1),
        clOrdID: typeof o === "string" ? o : o.clOrdID,
        price: price ?? (typeof o === "string" ? "100" : (o.price ?? "100")),
        quantity,
        fee: "0",
      }),
    done: (o: OrderIntent) => step({ type: "orderDone", at: (at += 1), clOrdID: o.clOrdID }),
    restart: () => {
      s = JSON.parse(JSON.stringify(s)) as GridBotState;
    },
  };
}

/** Khởi động ở giá 100; long / short: lệnh market mở vị thế ban đầu khớp đủ. Trả về mọi lệnh limit đã đặt. */
function started(b: Runner): OrderIntent[] {
  const r = b.tick("100");
  const orders = placed(r.actions);
  const init = orders.find((o) => o.type === "market");
  if (init === undefined) return orders;
  return [...orders, ...placed(b.fill(init, init.quantity, "100").actions)].filter(
    (o) => o.type === "limit",
  );
}
const at = (orders: OrderIntent[], side: "buy" | "sell", price: string) => {
  const o = orders.find((x) => x.side === side && x.price === price);
  if (o === undefined) throw new Error(`no ${side}@${price}`);
  return o;
};

describe("grid partial fills (#261)", () => {
  it("books every partial fill and places ONE counter order for the total once fully filled", () => {
    const b = bot(futuresGrid, perps());
    const buy95 = at(started(b), "buy", "95");
    const r1 = b.fill(buy95, "0.3");
    expect(placed(r1.actions)).toEqual([]);
    expect(b.s.open[buy95.clOrdID]).toEqual({ level: 1, side: "buy", filled: "0.3" });
    expect(b.s.ledger.position).toBe("0.3");
    const r2 = b.fill(buy95, "0.3");
    expect(placed(r2.actions)).toEqual([]);
    expect(b.s.ledger.position).toBe("0.6");
    const r3 = b.fill(buy95, "0.4");
    expect(placed(r3.actions).map(show)).toEqual(["sell@100x1"]);
    expect(b.s.open[buy95.clOrdID]).toBeUndefined();
    expect(b.s.ledger.position).toBe("1");

    // Cùng lệnh đối ứng (cả clOrdID) như khi khớp đủ một lần.
    const once = bot(futuresGrid, perps());
    const ro = once.fill(at(started(once), "buy", "95"), "1");
    expect(placed(r3.actions)).toEqual(placed(ro.actions));
    expect(b.s.open).toEqual(once.s.open);
  });

  it("keeps a single full fill exactly as before", () => {
    const b = bot(futuresGrid, perps());
    const buy95 = at(started(b), "buy", "95");
    const r = b.fill(buy95, "1");
    const sell = placed(r.actions);
    expect(sell.map(show)).toEqual(["sell@100x1"]);
    expect(sell[0]?.tag).toBe("grid:2:sell");
    // Lệnh đủ một mức giữ dạng cũ trong state.
    expect(b.s.open[sell[0]?.clOrdID ?? ""]).toEqual({ level: 2, side: "sell" });
    expect(r.actions.find((a) => a.type === "log")).toEqual({
      type: "log",
      decision: "Bought at level 2",
      why: "Placed sell at 100.",
    });
  });

  it("survives an engine restart between two partial fills (state reloaded)", () => {
    const b = bot(futuresGrid, perps());
    const buy95 = at(started(b), "buy", "95");
    b.fill(buy95, "0.4");
    b.restart();
    expect(b.s.open[buy95.clOrdID]).toEqual({ level: 1, side: "buy", filled: "0.4" });
    const r = b.fill(buy95, "0.6");
    expect(placed(r.actions).map(show)).toEqual(["sell@100x1"]);
    expect(b.s.ledger.position).toBe("1");
    // Khởi động lại sau khi đã đặt: lệnh đối ứng không được tạo lại, clOrdID kế tiếp không trùng.
    b.restart();
    expect(placed(b.fill(buy95, "0.1").actions)).toEqual([]);
  });

  it("partial fill then orderDone: counter for the filled part at or above SoDEX min size", () => {
    const b = bot(futuresGrid, perps());
    const buy95 = at(started(b), "buy", "95");
    b.fill(buy95, "0.4");
    const r = b.done(buy95);
    const counter = placed(r.actions);
    expect(counter.map(show)).toEqual(["sell@100x0.4"]);
    expect(b.s.open[buy95.clOrdID]).toBeUndefined();
    expect(b.s.open[counter[0]?.clOrdID ?? ""]).toEqual({ level: 2, side: "sell", qty: "0.4" });
    // Lệnh đối ứng nhỏ đó khớp hết: đối ứng tiếp theo cũng chỉ 0.4.
    expect(placed(b.fill(counter[0] ?? "", "0.4").actions).map(show)).toEqual(["buy@95x0.4"]);
    expect(b.s.ledger.position).toBe("0");
  });

  it("partial fill then orderDone below SoDEX min size: no counter, the fill stays in the ledger", () => {
    const b = bot(futuresGrid, perps());
    const buy95 = at(started(b), "buy", "95");
    // 0.04 × 100 = 4 < min notional 5.
    b.fill(buy95, "0.04");
    const r = b.done(buy95);
    expect(placed(r.actions)).toEqual([]);
    expect(b.s.open[buy95.clOrdID]).toBeUndefined();
    expect(b.s.ledger.position).toBe("0.04");
  });

  it("an unfilled order that ends keeps the old handling", () => {
    const b = bot(futuresGrid, perps());
    const buy95 = at(started(b), "buy", "95");
    const before = b.s;
    const r = b.done(buy95);
    expect(r.actions).toEqual([]);
    expect(b.s).toBe(before);
  });

  it("counts only the unfilled part of open orders against the cap", () => {
    // Long: bán ≤ vị thế. Vị thế 2, hai lệnh bán 105 và 110. Bán 105 khớp 0.5 → vị thế 1.5; phần chưa khớp 0.5 + 1 = 1.5:
    // vừa đủ, không huỷ gì (đếm đủ khối lượng mỗi lệnh sẽ là 2 > 1.5 và huỷ nhầm lệnh 110).
    const b = bot(futuresGrid, perps({ direction: "long" }));
    const orders = started(b);
    expect(b.s.ledger.position).toBe("2");
    const sell105 = at(orders, "sell", "105");
    const r = b.fill(sell105, "0.5");
    expect(cancels(r.actions)).toEqual([]);
    expect(placed(r.actions)).toEqual([]);
    expect(b.s.ledger.position).toBe("1.5");
    expect(Object.values(b.s.open).filter((o) => o.side === "sell")).toHaveLength(2);
  });

  it("cap cancels a partially filled order: counter for its filled part", () => {
    const b = bot(futuresGrid, perps());
    const orders = started(b);
    const buy95 = at(orders, "buy", "95");
    b.fill(buy95, "0.4");
    // Một lệnh đã huỷ trước đó khớp trễ 4.4 → vị thế 4.8; neutral: mua ≤ 5 − 4.8 = 0.2. Phần mua chưa khớp 1 (90) + 0.6
    // (95) vượt: huỷ 90 (xa giá) rồi 95; 95 đã khớp 0.4 nên đặt bán 0.4 ở 100.
    b.s = { ...b.s, cancelled: { late: { level: -2, side: "buy" } } };
    const r = b.fill("late", "4.4", "100");
    expect(b.s.ledger.position).toBe("4.8");
    expect(cancels(r.actions)).toEqual([
      { type: "cancel", clOrdID: at(orders, "buy", "90").clOrdID },
      { type: "cancel", clOrdID: buy95.clOrdID },
    ]);
    expect(placed(r.actions).map(show)).toEqual(["sell@100x0.4"]);
    // Phần còn lại khớp trước khi huỷ xong (#426): vào sổ cái, và grid đang chạy nên đặt thêm đối ứng cho đúng phần
    // khớp thêm (tổng đối ứng 0.4 + 0.6 = tổng đã khớp 1).
    const late = b.fill(buy95, "0.6");
    expect(placed(late.actions).map(show)).toEqual(["sell@100x0.6"]);
    expect(b.s.ledger.position).toBe("5.4");
  });

  it("halted (max loss pause): a kept reducing order filled in parts is booked every time", () => {
    const b = bot(futuresGrid, perps({ maxLoss: "3" }));
    const buy95 = at(started(b), "buy", "95");
    const sell100 = placed(b.fill(buy95, "1").actions)[0];
    if (sell100 === undefined) throw new Error("no counter");
    // Giá 91: lỗ 4 ≥ max loss 3 → pause, giữ lệnh bán (giảm vị thế).
    const p = b.tick("91");
    expect(p.actions.at(-1)).toEqual({ type: "pause", reason: ReasonCode.botMaxLoss });
    expect(b.s.open[sell100.clOrdID]).toBeDefined();
    expect(placed(b.fill(sell100, "0.4").actions)).toEqual([]);
    expect(b.s.open[sell100.clOrdID]).toEqual({ level: 2, side: "sell", filled: "0.4" });
    expect(b.s.ledger.position).toBe("0.6");
    expect(placed(b.fill(sell100, "0.6").actions)).toEqual([]);
    expect(b.s.open[sell100.clOrdID]).toBeUndefined();
    expect(b.s.ledger.position).toBe("0");
  });

  it("halt with a partially filled order: no new order while halted, later fills still booked", () => {
    const b = bot(futuresGrid, perps({ stopBelow: "80" }));
    const buy95 = at(started(b), "buy", "95");
    b.fill(buy95, "0.4");
    const r = b.tick("79");
    expect(r.actions.at(-1)).toEqual({ type: "stop", reason: ReasonCode.stopLoss, close: true });
    expect(placed(r.actions)).toEqual([]);
    expect(b.s.cancelled?.[buy95.clOrdID]).toEqual({ level: 1, side: "buy", filled: "0.4" });
    expect(placed(b.fill(buy95, "0.6").actions)).toEqual([]);
    expect(b.s.ledger.position).toBe("1");
  });

  it("partial fill then a version change: the old order is only awaited for its unfilled part", () => {
    const b = bot(futuresGrid, perps());
    const buy95 = at(started(b), "buy", "95");
    b.fill(buy95, "0.4");
    const next = futuresGrid.applyVersion?.(perps(), b.s, ctx);
    expect(next?.retiring?.[buy95.clOrdID]).toEqual({
      side: "buy",
      qty: "1",
      filled: "0.4",
      cancelAt: null,
    });
  });

  const cases: {
    name: string;
    run: () => Runner;
    side: "buy" | "sell";
    price: string;
    counter: string;
  }[] = [
    {
      name: "perps neutral",
      run: () => bot(futuresGrid, perps()),
      side: "sell",
      price: "105",
      counter: "buy@100x1",
    },
    {
      name: "perps long",
      run: () => bot(futuresGrid, perps({ direction: "long" })),
      side: "buy",
      price: "95",
      counter: "sell@100x1",
    },
    {
      name: "perps short",
      run: () => bot(futuresGrid, perps({ direction: "short" })),
      side: "sell",
      price: "105",
      counter: "buy@100x1",
    },
    {
      name: "spot (long)",
      run: () => bot(spotGrid, spot),
      side: "sell",
      price: "110",
      counter: "buy@105x1",
    },
  ];
  it.each(cases)(
    "$name: three partial fills, one counter for the total",
    ({ run, side, price, counter }) => {
      const b = run();
      const o = at(started(b), side, price);
      const pos0 = b.s.ledger.position;
      expect(placed(b.fill(o, "0.2").actions)).toEqual([]);
      expect(placed(b.fill(o, "0.5").actions)).toEqual([]);
      expect(placed(b.fill(o, "0.3").actions).map(show)).toEqual([counter]);
      expect(dec(b.s.ledger.position).sub(pos0).toString()).toBe(side === "buy" ? "1" : "-1");
    },
  );
});

// #426 (DEC-TBD-grid-late-fills): fill của chính lệnh đó tới SAU khi SoDEX đã báo lệnh kết thúc (`orderDone` / xác nhận
// huỷ). Lịch sử lệnh REST của SoDEX trễ hơn trade (DEC-303), nên đối soát có thể ghi trade sau khi lệnh đã kết thúc.
describe("grid late fills after the order ended (#426)", () => {
  it("partial fill → orderDone → late fill: booked, and one more counter for just the late part", () => {
    const b = bot(futuresGrid, perps());
    const buy95 = at(started(b), "buy", "95");
    b.fill(buy95, "0.4");
    expect(placed(b.done(buy95).actions).map(show)).toEqual(["sell@100x0.4"]);
    const r = b.fill(buy95, "0.2");
    expect(b.s.ledger.position).toBe("0.6");
    expect(placed(r.actions).map(show)).toEqual(["sell@100x0.2"]);
    expect(b.s.cancelled?.[buy95.clOrdID]).toEqual({
      level: 1,
      side: "buy",
      filled: "0.6",
      ended: true,
      countered: "0.6",
    });
  });

  it("late parts below SoDEX min size add up until they reach it", () => {
    const b = bot(futuresGrid, perps());
    const buy95 = at(started(b), "buy", "95");
    // 0.03 × 100 = 3 < min notional 5: không đặt đối ứng lúc kết thúc.
    b.fill(buy95, "0.03");
    expect(placed(b.done(buy95).actions)).toEqual([]);
    expect(placed(b.fill(buy95, "0.01").actions)).toEqual([]);
    // 0.03 + 0.01 + 0.02 = 0.06 → 6 ≥ 5: một lệnh đối ứng cho cả 0.06.
    expect(placed(b.fill(buy95, "0.02").actions).map(show)).toEqual(["sell@100x0.06"]);
    expect(b.s.ledger.position).toBe("0.06");
  });

  it("cap cancel → cancel ack (orderDone) → late fill: booked, counter for the late part", () => {
    const b = bot(futuresGrid, perps());
    const orders = started(b);
    const buy95 = at(orders, "buy", "95");
    b.fill(buy95, "0.4");
    b.s = { ...b.s, cancelled: { ...b.s.cancelled, late: { level: -2, side: "buy" } } };
    b.fill("late", "4.4", "100");
    expect(b.s.cancelled?.[buy95.clOrdID]).toMatchObject({ countered: "0.4" });
    b.done(buy95);
    expect(b.s.cancelled?.[buy95.clOrdID]).toMatchObject({ ended: true });
    const r = b.fill(buy95, "0.2");
    expect(b.s.ledger.position).toBe("5");
    expect(placed(r.actions).map(show)).toEqual(["sell@100x0.2"]);
  });

  it("a replayed late fill is not booked twice (never past the order size)", () => {
    const b = bot(futuresGrid, perps());
    const buy95 = at(started(b), "buy", "95");
    b.fill(buy95, "0.4");
    b.done(buy95);
    b.fill(buy95, "0.6");
    const before = b.s;
    const r = b.fill(buy95, "0.6");
    expect(r.actions).toEqual([]);
    expect(b.s).toBe(before);
    expect(b.s.ledger.position).toBe("1");
  });

  it("survives an engine restart between orderDone and the late fill", () => {
    const b = bot(futuresGrid, perps());
    const buy95 = at(started(b), "buy", "95");
    b.fill(buy95, "0.4");
    b.done(buy95);
    b.restart();
    const r = b.fill(buy95, "0.2");
    expect(b.s.ledger.position).toBe("0.6");
    expect(placed(r.actions).map(show)).toEqual(["sell@100x0.2"]);
  });

  it("halted: a kept order ends, then a late fill: booked, no new order", () => {
    const b = bot(futuresGrid, perps({ maxLoss: "3" }));
    const buy95 = at(started(b), "buy", "95");
    const sell100 = placed(b.fill(buy95, "1").actions)[0];
    if (sell100 === undefined) throw new Error("no counter");
    b.tick("91");
    b.fill(sell100, "0.4");
    b.done(sell100);
    const r = b.fill(sell100, "0.1");
    expect(placed(r.actions)).toEqual([]);
    expect(b.s.ledger.position).toBe("0.5");
  });

  it("halt cancel → cancel ack → late fill: booked, no counter even after resume", () => {
    const b = bot(futuresGrid, perps({ stopBelow: "80" }));
    const buy95 = at(started(b), "buy", "95");
    b.fill(buy95, "0.4");
    b.tick("79");
    b.done(buy95);
    const r = b.fill(buy95, "0.3");
    expect(placed(r.actions)).toEqual([]);
    expect(b.s.ledger.position).toBe("0.7");
  });

  it("old-version order ends, then a late fill: booked on its own side", () => {
    const b = bot(futuresGrid, perps());
    const buy95 = at(started(b), "buy", "95");
    b.fill(buy95, "0.4");
    const next = futuresGrid.applyVersion?.(perps(), b.s, ctx);
    if (next === null || next === undefined) throw new Error("not applied");
    b.s = next;
    b.done(buy95);
    expect(b.s.retiring?.[buy95.clOrdID]).toBeUndefined();
    expect(b.s.cancelled?.[buy95.clOrdID]).toMatchObject({ level: -2, ended: true });
    const r = b.fill(buy95, "0.5");
    expect(placed(r.actions)).toEqual([]);
    expect(b.s.ledger.position).toBe("0.9");
    // Không bao giờ quá khối lượng đặt của lệnh cũ.
    b.fill(buy95, "0.5");
    expect(b.s.ledger.position).toBe("1");
  });

  it("keeps at most GRID_KEEP_ENDED ended level orders, never the initial order", () => {
    const b = bot(futuresGrid, perps());
    started(b);
    const many = Object.fromEntries(
      Array.from({ length: GRID_KEEP_ENDED + 5 }, (_, i) => [
        `old-${String(i)}`,
        { level: 1, side: "buy" as const, ended: true },
      ]),
    );
    b.s = { ...b.s, cancelled: { init: { level: -1, side: "buy", ended: true }, ...many } };
    b.s = { ...b.s, cancelled: { ...b.s.cancelled, x: { level: 1, side: "buy" } } };
    b.done({ clOrdID: "x" } as OrderIntent);
    const left = Object.keys(b.s.cancelled ?? {});
    expect(left).toContain("init");
    expect(left).toContain("x");
    expect(left).not.toContain("old-0");
    expect(left.filter((k) => k !== "init")).toHaveLength(GRID_KEEP_ENDED);
  });

  it("a version change carries ended orders without their counter rule", () => {
    const b = bot(futuresGrid, perps());
    const buy95 = at(started(b), "buy", "95");
    b.fill(buy95, "0.4");
    b.done(buy95);
    const next = futuresGrid.applyVersion?.(perps(), b.s, ctx);
    expect(next?.cancelled?.[buy95.clOrdID]).toEqual({
      level: 1,
      side: "buy",
      qty: "1",
      filled: "0.4",
      ended: true,
    });
  });

  const lateCases: {
    name: string;
    run: () => Runner;
    side: "buy" | "sell";
    price: string;
    counter: string;
  }[] = [
    {
      name: "perps neutral",
      run: () => bot(futuresGrid, perps()),
      side: "sell",
      price: "105",
      counter: "buy@100x0.2",
    },
    {
      name: "perps long",
      run: () => bot(futuresGrid, perps({ direction: "long" })),
      side: "buy",
      price: "95",
      counter: "sell@100x0.2",
    },
    {
      name: "perps short",
      run: () => bot(futuresGrid, perps({ direction: "short" })),
      side: "sell",
      price: "105",
      counter: "buy@100x0.2",
    },
    {
      name: "spot (long)",
      run: () => bot(spotGrid, spot),
      side: "sell",
      price: "110",
      counter: "buy@105x0.2",
    },
  ];
  it.each(lateCases)(
    "$name: late fill after orderDone is booked like SoDEX's position",
    ({ run, side, price, counter }) => {
      const b = run();
      const o = at(started(b), side, price);
      const pos0 = b.s.ledger.position;
      b.fill(o, "0.5");
      b.done(o);
      const r = b.fill(o, "0.2");
      expect(placed(r.actions).map(show)).toEqual([counter]);
      // Vị thế SoDEX giả lập = vị thế trước + mọi phần đã khớp (0.5 + 0.2).
      expect(dec(b.s.ledger.position).sub(pos0).toString()).toBe(side === "buy" ? "0.7" : "-0.7");
    },
  );
});
