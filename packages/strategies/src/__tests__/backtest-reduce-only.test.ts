import { dec, Decimal } from "@drift/shared";
import { describe, expect, it } from "vitest";

import { runBacktest, type Candle } from "../backtest";
import type { OrderIntent, StrategyEvent, StrategyModule } from "../core/types";

// #284: lệnh reduce-only trong backtest không bao giờ làm tăng vị thế hay đảo chiều. Như SoDEX, phần khớp bị giới hạn ở
// |vị thế| còn lại (phần dư không khớp, lệnh kết thúc); vị thế đã về 0 thì lệnh kết thúc mà không khớp gì.

const RULES = { tickSize: "0.01", stepSize: "0.0001", minQuantity: "0.0001", minNotional: "1" };
const FEES = {
  spot: { maker: "0.0004", taker: "0.0007" },
  perps: { maker: "0.00015", taker: "0.00045" },
  builder: "0.0001",
};
const MIN = 60_000;
const T0 = Date.UTC(2026, 6, 1);
const M = "BTC-USD";

const candle = (i: number, o: number, h: number, l: number, c: number): Candle => ({
  t: T0 + i * MIN,
  o: o.toFixed(2),
  h: h.toFixed(2),
  l: l.toFixed(2),
  c: c.toFixed(2),
});

type Spec = Omit<OrderIntent, "clOrdID" | "market" | "engine" | "tag" | "timeInForce"> &
  Partial<Pick<OrderIntent, "timeInForce">> & { id: string };

interface Script {
  /** Đặt ở timer của nến 0 (vào lệnh: market, khớp ở open nến 1). */
  open: Spec[];
  /** Đặt ở timer của nến 1 (thoát), sau khi đã có vị thế. */
  exits: Spec[];
}

const order = (s: Spec): OrderIntent => ({
  clOrdID: s.id,
  market: M,
  engine: "perps",
  side: s.side,
  type: s.type,
  ...(s.price === undefined ? {} : { price: s.price }),
  quantity: s.quantity,
  timeInForce: s.timeInForce ?? (s.type === "market" ? "IOC" : "GTC"),
  reduceOnly: s.reduceOnly,
  tag: s.id,
  ...(s.stop === undefined ? {} : { stop: s.stop }),
});

/** Chiến lược giả: đặt đúng các lệnh của kịch bản ở timer nến 0 và nến 1, không làm gì khác. */
const scripted: StrategyModule<Script, { timers: number }> = {
  initialState: () => ({ timers: 0 }),
  step: (config, state, event) => {
    if (event.type !== "timer") return { state, actions: [] };
    const list = state.timers === 0 ? config.open : state.timers === 1 ? config.exits : [];
    return {
      state: { timers: state.timers + 1 },
      actions: list.map((s) => ({ type: "place" as const, order: order(s) })),
    };
  },
};

function run(script: Script, candles: Candle[]) {
  return runBacktest({
    module: scripted,
    config: script,
    markets: { [M]: { engine: "perps", candles, rules: RULES } },
    funding: {},
    fees: FEES,
    slippage: "0",
    intervalMs: MIN,
    capital: "10000",
    recordEvents: true,
  });
}

const filled = (r: ReturnType<typeof run>, id: string) =>
  r.fills.filter((f) => f.clOrdID === id).reduce((s, f) => s.add(f.quantity), new Decimal(0));
const ended = (r: ReturnType<typeof run>, id: string) =>
  r.events.some((e: StrategyEvent) => e.type === "orderDone" && e.clOrdID === id);

// Nến 0, 1 phẳng ở 100 (vào lệnh ở open nến 1, đặt lệnh thoát ở timer nến 1). Nến 2: chạm stop rồi chạm lệnh thoát.
const flat = [candle(0, 100, 100, 100, 100), candle(1, 100, 100, 100, 100)];
/** Nến tăng: O → L (94) → H (106) → C. */
const upBar = candle(2, 100, 106, 94, 105);
/** Nến giảm: O → H (106) → L (94) → C. */
const downBar = candle(2, 100, 106, 94, 95);

describe("backtest reduce-only (#284)", () => {
  it("long: the exchange stop and a reduce-only exit filling in the same candle leave the position at 0, never short", () => {
    const r = run(
      {
        open: [{ id: "in", side: "buy", type: "market", quantity: "1", reduceOnly: false }],
        exits: [
          {
            id: "sl",
            side: "sell",
            type: "market",
            quantity: "1",
            reduceOnly: true,
            stop: { price: "95" },
          },
          { id: "tp", side: "sell", type: "limit", price: "105", quantity: "1", reduceOnly: true },
        ],
      },
      [...flat, upBar],
    );
    expect(filled(r, "sl").toString()).toBe("1");
    // Stop đã đóng hết: lệnh thoát reduce-only không khớp gì và kết thúc.
    expect(filled(r, "tp").toString()).toBe("0");
    expect(ended(r, "tp")).toBe(true);
    expect(r.positions[M]).toBe("0");
  });

  it("short: the same candle never flips the position to long", () => {
    const r = run(
      {
        open: [{ id: "in", side: "sell", type: "market", quantity: "1", reduceOnly: false }],
        exits: [
          {
            id: "sl",
            side: "buy",
            type: "market",
            quantity: "1",
            reduceOnly: true,
            stop: { price: "105" },
          },
          { id: "tp", side: "buy", type: "limit", price: "95", quantity: "1", reduceOnly: true },
        ],
      },
      [...flat, downBar],
    );
    expect(filled(r, "sl").toString()).toBe("1");
    expect(filled(r, "tp").toString()).toBe("0");
    expect(ended(r, "tp")).toBe(true);
    expect(r.positions[M]).toBe("0");
  });

  it("fills a reduce-only order only up to what is left of the position, the rest does not fill", () => {
    // Long 1: hai lệnh thoát reduce-only 0.6 cùng khớp ở đỉnh nến; lệnh sau chỉ còn 0.4 để đóng.
    const r = run(
      {
        open: [{ id: "in", side: "buy", type: "market", quantity: "1", reduceOnly: false }],
        exits: [
          {
            id: "tp1",
            side: "sell",
            type: "limit",
            price: "104",
            quantity: "0.6",
            reduceOnly: true,
          },
          {
            id: "tp2",
            side: "sell",
            type: "limit",
            price: "105",
            quantity: "0.6",
            reduceOnly: true,
          },
        ],
      },
      [...flat, upBar],
    );
    expect(filled(r, "tp1").toString()).toBe("0.6");
    expect(filled(r, "tp2").toString()).toBe("0.4");
    expect(ended(r, "tp2")).toBe(true);
    expect(r.positions[M]).toBe("0");
    // Tiền tính theo phần thật sự khớp (0.4 ở 105), không theo 0.6.
    const fill = r.fills.find((f) => f.clOrdID === "tp2");
    expect(fill?.quantity).toBe("0.4");
    expect(fill?.fee).toBe(dec("105").mul("0.4").mul(dec("0.00015").add("0.0001")).toString());
  });

  it("a reduce-only market order larger than the position closes it and stops there", () => {
    const r = run(
      {
        open: [{ id: "in", side: "sell", type: "market", quantity: "1", reduceOnly: false }],
        exits: [{ id: "out", side: "buy", type: "market", quantity: "1.5", reduceOnly: true }],
      },
      [...flat, candle(2, 100, 100, 100, 100)],
    );
    expect(filled(r, "out").toString()).toBe("1");
    expect(ended(r, "out")).toBe(true);
    expect(r.positions[M]).toBe("0");
  });

  it("a reduce-only IOC with no position fills nothing", () => {
    const r = run(
      {
        open: [],
        exits: [
          {
            id: "ioc",
            side: "sell",
            type: "limit",
            price: "99",
            quantity: "1",
            reduceOnly: true,
            timeInForce: "IOC",
          },
        ],
      },
      [...flat, candle(2, 100, 100, 100, 100)],
    );
    expect(filled(r, "ioc").toString()).toBe("0");
    expect(ended(r, "ioc")).toBe(true);
    expect(r.positions[M] ?? "0").toBe("0");
  });

  it("an order that is not reduce-only still opens the other side as before", () => {
    const r = run(
      {
        open: [{ id: "in", side: "buy", type: "market", quantity: "1", reduceOnly: false }],
        exits: [
          {
            id: "sl",
            side: "sell",
            type: "market",
            quantity: "1",
            reduceOnly: true,
            stop: { price: "95" },
          },
          {
            id: "sell",
            side: "sell",
            type: "limit",
            price: "105",
            quantity: "1",
            reduceOnly: false,
          },
        ],
      },
      [...flat, upBar],
    );
    expect(filled(r, "sl").toString()).toBe("1");
    expect(filled(r, "sell").toString()).toBe("1");
    expect(ended(r, "sell")).toBe(false);
    expect(r.positions[M]).toBe("-1");
  });
});
