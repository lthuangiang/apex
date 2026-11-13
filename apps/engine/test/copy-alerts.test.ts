import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  copyTrade,
  copyTradeSchema,
  type CopyTradeConfig,
  type CopyTradeState,
  type StepContext,
  type StrategyEvent,
} from "@drift/strategies";
import { MARKET_OFF_SKIP } from "@drift/strategies";
import { describe, expect, it } from "vitest";

import { openedAlerts, SkipGate, skipMarket, skipReason } from "../src/copy-alerts";

// Cảnh báo bot copy (DEC-212): hàm thuần, chạy với đúng chiến lược copy-trade.

const LEADER = "0x6666666666666666666666666666666666666666";
const config: CopyTradeConfig = copyTradeSchema.parse({
  leaderSource: "sodex",
  leaderAddress: LEADER,
  market: "BTC-USD",
  leverage: 2,
  fixedNotional: "100",
  maxNotionalPerTrade: "200",
  maxExposure: "1000",
  maxLoss: "150",
});
const ctx: StepContext = {
  botId: "b1",
  version: 1,
  rules: {
    "BTC-USD": { tickSize: "1", stepSize: "0.0001", minQuantity: "0.0001", minNotional: "10" },
  },
  feeRate: "0.0005",
};
const T = 1_800_000_000_000;

function run(s: CopyTradeState, e: StrategyEvent) {
  return copyTrade.step(config, s, e, ctx);
}
const leaderFill = (positionAfter: string, leaderAt: number, at: number): StrategyEvent => ({
  type: "leaderFill",
  at,
  leaderAt,
  market: "BTC-USD",
  side: "buy",
  price: "100000",
  quantity: "1",
  positionAfter,
});

/** Bot copy với một lệnh mở đang chờ (đã gửi, chưa khớp). */
function withOpenOrder(): { s: CopyTradeState; id: string } {
  let s = copyTrade.initialState(config);
  s = run(s, { type: "tick", at: T, market: "BTC-USD", price: "100000" }).state;
  const r = run(s, leaderFill("1", T, T + 200));
  const place = r.actions.find((a) => a.type === "place");
  if (place?.type !== "place") throw new Error("expected an open order");
  return { s: r.state, id: place.order.clOrdID };
}

describe("openedAlerts", () => {
  it("one alert when an open order fills, none when the same fill or orderDone is replayed", () => {
    const { s, id } = withOpenOrder();
    const fill: StrategyEvent = {
      type: "fill",
      at: T + 300,
      clOrdID: id,
      price: "100100",
      quantity: "0.001",
      fee: "0.01",
    };
    const after = run(s, fill).state;
    expect(openedAlerts("b1", config, s, after, fill)).toEqual([
      {
        botId: "b1",
        clOrdID: id,
        market: "BTC-USD",
        move: "opened",
        side: "long",
        size: "0.001",
        avgEntry: after.markets["BTC-USD"]?.ledger.avgCost,
        at: T + 300,
      },
    ]);
    // Phát lại (engine vốn đã bỏ delta ≤ 0; đây là lớp thứ hai ở phía chiến lược).
    const again = run(after, fill).state;
    expect(openedAlerts("b1", config, after, again, fill)).toEqual([]);
    const done: StrategyEvent = { type: "orderDone", at: T + 400, clOrdID: id };
    expect(openedAlerts("b1", config, after, run(after, done).state, done)).toEqual([]);
  });

  it("partial fills give one alert with the total size when the order completes", () => {
    const { s, id } = withOpenOrder();
    const part = (q: string, at: number): StrategyEvent => ({
      type: "fill",
      at,
      clOrdID: id,
      price: "100000",
      quantity: q,
      fee: "0",
    });
    const s1 = run(s, part("0.0005", T + 300)).state;
    expect(openedAlerts("b1", config, s, s1, part("0.0005", T + 300))).toEqual([]);
    const done: StrategyEvent = { type: "orderDone", at: T + 400, clOrdID: id };
    const s2 = run(s1, done).state;
    expect(openedAlerts("b1", config, s1, s2, done)).toMatchObject([
      { clOrdID: id, size: "0.0005", move: "opened", side: "long" },
    ]);
  });

  it("no alert when the open order didn't fill or SoDEX rejected it", () => {
    const { s, id } = withOpenOrder();
    const done: StrategyEvent = { type: "orderDone", at: T + 300, clOrdID: id };
    expect(openedAlerts("b1", config, s, run(s, done).state, done)).toEqual([]);
    const rej: StrategyEvent = { type: "orderReject", at: T + 300, clOrdID: id, code: "X" };
    expect(openedAlerts("b1", config, s, run(s, rej).state, rej)).toEqual([]);
  });

  it("says added to when the bot already held the same side", () => {
    const { s, id } = withOpenOrder();
    const fill: StrategyEvent = {
      type: "fill",
      at: T + 300,
      clOrdID: id,
      price: "100000",
      quantity: "0.001",
      fee: "0",
    };
    const held = run(s, fill).state;
    const r = run(held, leaderFill("2", T + 1_000, T + 1_100));
    const place = r.actions.find((a) => a.type === "place");
    if (place?.type !== "place") throw new Error("expected an increase order");
    const fill2: StrategyEvent = {
      ...fill,
      at: T + 1_200,
      clOrdID: place.order.clOrdID,
      quantity: place.order.quantity,
    };
    expect(openedAlerts("b1", config, r.state, run(r.state, fill2).state, fill2)).toMatchObject([
      { move: "added", side: "long" },
    ]);
  });

  it("never throws on odd state: drops the alert instead", () => {
    const fill: StrategyEvent = {
      type: "fill",
      at: T,
      clOrdID: "x",
      price: "1",
      quantity: "1",
      fee: "0",
    };
    const bad = {
      markets: { "BTC-USD": { inflight: { kind: "open", id: "x", filled: "abc" } } },
      copied: 0,
    };
    expect(openedAlerts("b1", config, bad, { ...bad, copied: 1 }, fill)).toEqual([]);
    expect(openedAlerts("b1", null, 42, "x", fill)).toEqual([]);
  });
});

describe("skipReason", () => {
  it("maps every Skipped line the copy-trade strategy writes (changing a line breaks this test)", () => {
    const src = readFileSync(
      fileURLToPath(
        new URL("../../../packages/strategies/src/copy-trade/index.ts", import.meta.url),
      ),
      "utf8",
    );
    const lines = [...src.matchAll(/log\(\s*"Skipped",\s*([`"])([\s\S]*?)\1,?\s*\)/g)].map((m) =>
      (m[2] ?? "").replace(/\$\{[^}]*\}/g, "1"),
    );
    expect(lines.length).toBeGreaterThanOrEqual(6);
    for (const line of lines) expect([line, skipReason(line)]).not.toEqual([line, "other"]);
    expect(
      skipReason("This trader now trades too fast to copy (typical hold under 15 minutes)."),
    ).toBe("min_hold");
    expect(skipReason("Not enough SoDEX liquidity near the price to copy this trade.")).toBe(
      "low_liquidity",
    );
    expect(skipReason(MARKET_OFF_SKIP)).toBe("market_off");
    expect(skipReason("Something new.")).toBe("other");
  });

  it("the strategy's late-signal skip maps to signal_late", () => {
    let s = copyTrade.initialState(config);
    s = run(s, { type: "tick", at: T, market: "BTC-USD", price: "100000" }).state;
    const r = run(s, leaderFill("1", T, T + 6_000));
    const log = r.actions.find((a) => a.type === "log" && a.decision === "Skipped");
    expect(log?.type === "log" ? skipReason(log.why) : null).toBe("signal_late");
  });
});

describe("skipMarket and SkipGate", () => {
  it("finds the market from the event, the order, or the only market", () => {
    const s = copyTrade.initialState(config);
    expect(skipMarket(config, s, leaderFill("1", T, T))).toBe("BTC-USD");
    expect(skipMarket(config, s, { type: "timer", at: T })).toBe("BTC-USD");
    expect(skipMarket({ markets: ["BTC-USD", "ETH-USD"] }, s, { type: "timer", at: T })).toBeNull();
  });

  it("allows one Skipped alert per market every 10 minutes", () => {
    const g = new SkipGate();
    expect(g.allow("BTC-USD", T)).toBe(true);
    expect(g.allow("BTC-USD", T + 60_000)).toBe(false);
    expect(g.allow("ETH-USD", T + 60_000)).toBe(true);
    expect(g.allow("BTC-USD", T + 10 * 60_000)).toBe(true);
  });
});
