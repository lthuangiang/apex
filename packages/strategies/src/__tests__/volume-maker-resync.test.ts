import { describe, expect, it } from "vitest";

import { clOrdId } from "../core/ids";
import type { StepContext, StrategyAction, StrategyEvent } from "../core/types";
import { volumeMaker, type VolumeMakerState } from "../volume-maker";
import { volumeMakerSchema, type VolumeMakerConfig } from "../volume-maker/schema";

// #497 (tiền thật): "Position re-synced from SoDEX" ghi đè sổ cái bằng vị thế SoDEX đã cũ khi fill đến dày. Tái hiện bảng
// thời gian prod (bot ETH-USD đuôi b5c77a2b, maxOrders 1): fill làm vị thế đổi chiều giữa hai lần đọc, lần đọc sau trả số
// cũ của SoDEX → bot tin vị thế ngược chiều, đặt lệnh đóng phía làm TĂNG vị thế.

const ctx: StepContext = {
  botId: "vm-bot",
  version: 1,
  rules: {
    "BTC-USD": { tickSize: "0.1", stepSize: "0.0001", minQuantity: "0.0001", minNotional: "5" },
  },
  feeRate: "0.00065",
};
// maxOrders 1: Max open position = 1 × order size (500 USDC = 0.005 BTC ở giá 100000).
const cfg = (): VolumeMakerConfig =>
  volumeMakerSchema.parse({
    market: "BTC-USD",
    leverage: 20,
    volumeTarget: "100000",
    orderSize: "500",
    maxOrders: 1,
    distanceBp: "1",
    refreshSeconds: 3,
    runUntil: "target_or_budget",
    costBudget: "300",
    onStop: "close_inventory",
  });
const id = (tag: string) => clOrdId(ctx.botId, ctx.version, tag);

/** Chạy chuỗi sự kiện; SoDEX xác nhận ngay mọi lệnh huỷ (engine gửi `orderDone`). */
function run(c: VolumeMakerConfig, events: StrategyEvent[], from?: VolumeMakerState) {
  let s: VolumeMakerState = from ?? volumeMaker.initialState(c);
  const all: StrategyAction[] = [];
  const feed = (e: StrategyEvent) => {
    const r = volumeMaker.step(c, s, e, ctx);
    s = r.state;
    all.push(...r.actions);
    for (const a of r.actions)
      if (a.type === "cancel" && s.orders[a.clOrdID]?.status === "cancelling")
        feed({ type: "orderDone", at: e.at, clOrdID: a.clOrdID });
  };
  for (const e of events) feed(e);
  return { s, all };
}
const resynced = (a: StrategyAction[]) =>
  a.some((x) => x.type === "log" && x.decision === "Position re-synced from SoDEX");

describe("Market Making re-sync with a stale SoDEX position (#497)", () => {
  it("does not overwrite the ledger with a SoDEX reading older than the latest fills (prod timeline)", () => {
    const c = cfg();
    const { s, all } = run(c, [
      { type: "tick", at: 0, market: "BTC-USD", price: "100000" },
      // 14:50:09 ask khớp → −0.005.
      { type: "fill", at: 1_000, clOrdID: id("vm:1:ask"), price: "100010", quantity: "0.005", fee: "0" },
      // Lần đọc ngay sau đó: SoDEX chưa kịp có fill → 0 (lệch, bắt đầu đếm).
      { type: "positionSync", at: 1_200, readAt: 1_100, historyAt: 1_100, market: "BTC-USD", size: "0", entryPrice: "0" },
      // 14:50:13 báo giá lại, lệnh đóng mua khớp → 0.
      { type: "timer", at: 3_000 },
      { type: "fill", at: 5_000, clOrdID: id("vm:2:rc"), price: "100000", quantity: "0.005", fee: "0" },
      // 14:50:38.705 bid khớp → +0.005.
      { type: "timer", at: 8_000 },
      { type: "fill", at: 31_000, clOrdID: id("vm:3:bid"), price: "99990", quantity: "0.005", fee: "0" },
      // 14:50:38.992 lần đọc 30 s sau trả số cũ của SoDEX (−0.005, của lúc 14:50:09–13).
      { type: "positionSync", at: 31_300, readAt: 31_200, historyAt: 30_000, market: "BTC-USD", size: "-0.005", entryPrice: "100010" },
    ]);
    expect(resynced(all)).toBe(false);
    expect(s.ledger.position).toBe("0.005");
  });
});
