import { describe, expect, it } from "vitest";

import type { StepContext, StrategyEvent } from "../core/types";
import { volumeMaker } from "../volume-maker";
import { volumeMakerSchema } from "../volume-maker/schema";

// Số request gửi SoDEX mỗi phút của Market Making khi giá Binance đi một chiều (DEC-270, bất biến 6; kịch bản
// của reviewer #133 / DEC-257). Thuần strategies, không engine: mỗi `cancel` được SoDEX xác nhận (`orderDone`) sau RTT,
// `place` nhận ngay, không mô phỏng fill. Request = mỗi action place hoặc cancel. Bắt lỗi vòng rút → xác nhận → đặt → rút
// của bản đầu #133 (122–372 request/phút, tăng theo RTT ngắn).

const ctx: StepContext = {
  botId: "rate-bot",
  version: 1,
  rules: {
    "BTC-USD": { tickSize: "0.1", stepSize: "0.0001", minQuantity: "0.0001", minNotional: "5" },
  },
  feeRate: "0.00065",
};

const config = volumeMakerSchema.parse({
  market: "BTC-USD",
  leverage: 1,
  orderSize: "500",
  distanceBp: "1",
  maxInventory: "2000",
  refreshSeconds: 3,
  quoteLevel: 0,
  smartQuoting: true,
  runUntil: "target_or_budget",
  volumeTarget: "100000000",
  costBudget: "300000",
  onStop: "close_inventory",
});

interface RateReport {
  total: number;
  maxPerSecond: number;
  buy: number;
  sell: number;
}

/** 60 s: mỗi `everyMs` gửi `fair` rồi `book`, giá giảm `dropBp`; timer mỗi 1 s; huỷ được xác nhận sau `rttMs`. */
function simulate(dropBp: number, everyMs: number, rttMs: number): RateReport {
  const queue: { at: number; seq: number; e: StrategyEvent }[] = [];
  let seq = 0;
  const push = (e: StrategyEvent) => {
    const item = { at: e.at, seq: (seq += 1), e };
    let i = queue.length;
    while (i > 0 && (queue[i - 1]?.at ?? 0) > item.at) i -= 1;
    queue.splice(i, 0, item);
  };
  let px = 100_000;
  for (let t = 0; t < 60_000; t += everyMs) {
    const p = px.toFixed(1);
    push({ type: "fair", at: t, market: "BTC-USD", fair: p, binanceAt: t - 50 });
    push({
      type: "book",
      at: t + 1,
      market: "BTC-USD",
      bid: (Number(p) - 0.1).toFixed(1),
      ask: p,
    });
    px *= 1 - dropBp / 10_000;
  }
  for (let t = 0; t < 60_000; t += 1_000) push({ type: "timer", at: t + 2 });

  let s = volumeMaker.initialState(config);
  s = volumeMaker.step(
    config,
    s,
    { type: "tick", at: -1, market: "BTC-USD", price: "100000" },
    ctx,
  ).state;
  const report: RateReport = { total: 0, maxPerSecond: 0, buy: 0, sell: 0 };
  const perSecond = new Map<number, number>();
  const count = (at: number, side: "buy" | "sell" | undefined) => {
    report.total += 1;
    if (side !== undefined) report[side] += 1;
    const sec = Math.floor(at / 1000);
    const n = (perSecond.get(sec) ?? 0) + 1;
    perSecond.set(sec, n);
    report.maxPerSecond = Math.max(report.maxPerSecond, n);
  };
  while (queue.length > 0) {
    const item = queue.shift();
    if (item === undefined) break;
    const r = volumeMaker.step(config, s, item.e, ctx);
    s = r.state;
    for (const a of r.actions) {
      if (a.type === "place") count(item.at, a.order.side);
      else if (a.type === "cancel") {
        count(item.at, s.orders[a.clOrdID]?.side);
        push({ type: "orderDone", at: item.at + rttMs, clOrdID: a.clOrdID });
      }
    }
  }
  return report;
}

// Trần mỗi kịch bản = số đo trên `main` trước #133 (59 / 75 / 79, hai RTT như nhau) + 10 %, làm tròn lên. Bản đầu #133
// đo 118–188 (RTT 400 ms) và 118–368 (RTT 150 ms); bản DEC-257 đo 61 / 78 / 83. Hạn mức ví khoảng 55 / phút: cả `main`
// cũng vượt trong kịch bản giá giảm đều này (bot thật đo 26–48 / phút lúc thường).
const scenarios = [
  { name: "0.6 bp/s", dropBp: 0.6, everyMs: 1_000, cap: 65 },
  { name: "1.5 bp/s", dropBp: 0.3, everyMs: 200, cap: 83 },
  { name: "2 bp/s", dropBp: 0.6, everyMs: 300, cap: 87 },
] as const;

const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env;
/** In số liệu khi RACE_LOG=1 (package này không có kiểu Node / DOM cho `console`). */
const say = (line: string) =>
  (globalThis as { console?: { log: (s: string) => void } }).console?.log(line);

describe("Market Making request rate on a Binance trend (DEC-270, DEC-257)", () => {
  for (const sc of scenarios)
    it(`stays near the main baseline and does not grow with a shorter RTT: ${sc.name}`, () => {
      const slow = simulate(sc.dropBp, sc.everyMs, 400);
      const fast = simulate(sc.dropBp, sc.everyMs, 150);
      if (env?.RACE_LOG === "1") say(JSON.stringify({ sc: sc.name, slow, fast }));
      expect(slow.total).toBeLessThanOrEqual(sc.cap);
      expect(fast.total).toBeLessThanOrEqual(sc.cap);
      // RTT ngắn hơn không được làm tăng số request (vòng rút → xác nhận → đặt).
      expect(fast.total).toBeLessThanOrEqual(Math.ceil(slow.total * 1.1));
    });
});
