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
      {
        type: "fill",
        at: 1_000,
        clOrdID: id("vm:1:ask"),
        price: "100010",
        quantity: "0.005",
        fee: "0",
      },
      // Lần đọc ngay sau đó: SoDEX chưa kịp có fill → 0 (lệch, bắt đầu đếm).
      {
        type: "positionSync",
        at: 1_200,
        readAt: 1_100,
        historyAt: 1_100,
        market: "BTC-USD",
        size: "0",
        entryPrice: "0",
      },
      // 14:50:13 báo giá lại, lệnh đóng mua khớp → 0.
      { type: "timer", at: 3_000 },
      {
        type: "fill",
        at: 5_000,
        clOrdID: id("vm:2:rc"),
        price: "100000",
        quantity: "0.005",
        fee: "0",
      },
      // 14:50:38.705 bid khớp → +0.005.
      { type: "timer", at: 8_000 },
      {
        type: "fill",
        at: 31_000,
        clOrdID: id("vm:3:bid"),
        price: "99990",
        quantity: "0.005",
        fee: "0",
      },
      // 14:50:38.992 lần đọc 30 s sau trả số cũ của SoDEX (−0.005, của lúc 14:50:09–13).
      {
        type: "positionSync",
        at: 31_300,
        readAt: 31_200,
        historyAt: 30_000,
        market: "BTC-USD",
        size: "-0.005",
        entryPrice: "100010",
      },
    ]);
    expect(resynced(all)).toBe(false);
    expect(s.ledger.position).toBe("0.005");
  });

  it("ignores a SoDEX number that is ~50 s old: the ledger went flat and two stale reads show the old short (PM comment)", () => {
    const c = cfg();
    const { s, all } = run(c, [
      { type: "tick", at: 0, market: "BTC-USD", price: "100000" },
      // 14:41:39 short mở; 14:45:40 lệnh đóng khớp → phẳng.
      {
        type: "fill",
        at: 1_000,
        clOrdID: id("vm:1:ask"),
        price: "100010",
        quantity: "0.005",
        fee: "0",
      },
      { type: "timer", at: 3_000 },
      {
        type: "fill",
        at: 10_000,
        clOrdID: id("vm:2:rc"),
        price: "100000",
        quantity: "0.005",
        fee: "0",
      },
      // Hai lần đọc 30 s một, SoDEX vẫn trả short cũ (−0.005), không fill nào xen giữa, lịch sử khớp đã bắt kịp.
      {
        type: "positionSync",
        at: 30_100,
        readAt: 30_000,
        historyAt: 25_000,
        market: "BTC-USD",
        size: "-0.005",
        entryPrice: "100010",
      },
      {
        type: "positionSync",
        at: 60_100,
        readAt: 60_000,
        historyAt: 55_000,
        market: "BTC-USD",
        size: "-0.005",
        entryPrice: "100010",
      },
      // SoDEX bắt kịp: phẳng.
      {
        type: "positionSync",
        at: 90_100,
        readAt: 90_000,
        historyAt: 85_000,
        market: "BTC-USD",
        size: "0",
        entryPrice: "0",
      },
    ]);
    expect(resynced(all)).toBe(false);
    expect(s.ledger.position).toBe("0");
    expect(s.drift).toBeNull();
  });
});

/** Bot idle sau một fill lúc 1 s (short −0.005); các lần đọc sau đó. */
const idleShort = (): StrategyEvent[] => [
  { type: "tick", at: 0, market: "BTC-USD", price: "100000" },
  {
    type: "fill",
    at: 1_000,
    clOrdID: id("vm:1:ask"),
    price: "100010",
    quantity: "0.005",
    fee: "0",
  },
];
const sync = (
  readAt: number,
  size: string,
  over: { at?: number; historyAt?: number | null } = {},
): StrategyEvent => ({
  type: "positionSync",
  at: over.at ?? readAt + 100,
  readAt,
  historyAt: over.historyAt === undefined ? readAt - 1_000 : over.historyAt,
  market: "BTC-USD",
  size,
  entryPrice: size === "0" ? "0" : "100010",
});

describe("Market Making re-sync only applies a fresh, settled, reconciled SoDEX position (#497)", () => {
  it("adopts a real outside change once it has held for 30 s, read ≥ 60 s after the last fill", () => {
    const c = cfg();
    // Vị thế bị đóng ngoài bot (thanh lý / lệnh tay): SoDEX phẳng ở mọi lần đọc từ 61 s.
    const early = run(c, [...idleShort(), sync(31_000, "0")]);
    // Lần đọc 30 s sau fill chưa được tính làm mốc.
    expect(resynced(early.all)).toBe(false);
    const { s, all } = run(c, [
      ...idleShort(),
      sync(31_000, "0"),
      sync(61_000, "0"),
      sync(91_000, "0"),
    ]);
    expect(resynced(all)).toBe(true);
    expect(s.ledger.position).toBe("0");
    expect(all).toEqual(expect.arrayContaining([{ type: "flag", needsAttention: true }]));
  });

  it("(a) waits when the reading is not fresh at the moment it would be applied", () => {
    const c = cfg();
    const stale = run(c, [...idleShort(), sync(61_000, "0"), sync(91_000, "0", { at: 97_000 })]);
    expect(resynced(stale.all)).toBe(false);
    expect(stale.s.ledger.position).toBe("-0.005");
    // Kiểm ngược: cùng chuỗi nhưng số vừa đọc → áp.
    const fresh = run(c, [...idleShort(), sync(61_000, "0"), sync(91_000, "0", { at: 92_000 })]);
    expect(resynced(fresh.all)).toBe(true);
  });

  it("(b) waits when the ledger had a fill between the read and the apply, and restarts the count", () => {
    const c = cfg();
    const { s, all } = run(c, [
      ...idleShort(),
      sync(61_000, "0"),
      // Báo giá lại, lệnh đóng khớp sau lần đọc 91 s nhưng trước lúc áp.
      { type: "timer", at: 90_000 },
      {
        type: "fill",
        at: 91_050,
        clOrdID: id("vm:2:rc"),
        price: "100000",
        quantity: "0.002",
        fee: "0",
      },
      sync(91_000, "0", { at: 91_100 }),
    ]);
    expect(resynced(all)).toBe(false);
    expect(s.ledger.position).toBe("-0.003");
    // Độ lệch đếm lại từ lần đọc này (không nối với lần đọc 61 s).
    expect(s.drift?.since).toBe(91_000);
  });

  it("(c) waits until the fill history has been reconciled after the last fill", () => {
    const c = cfg();
    for (const historyAt of [null, 1_000, 500]) {
      const r = run(c, [...idleShort(), sync(61_000, "0"), sync(91_000, "0", { historyAt })]);
      expect(resynced(r.all), String(historyAt)).toBe(false);
    }
    // Kiểm ngược: lịch sử khớp đọc sau fill → áp.
    const ok = run(c, [...idleShort(), sync(61_000, "0"), sync(91_000, "0", { historyAt: 1_001 })]);
    expect(resynced(ok.all)).toBe(true);
  });

  it("(c) waits while an order is being cancelled (it may still have filled)", () => {
    const c = cfg();
    let s: VolumeMakerState = run(c, [...idleShort(), sync(61_000, "0")]).s;
    // Một lệnh đang huỷ chưa có xác nhận.
    const anyId = Object.keys(s.orders)[0] ?? "";
    s = {
      ...s,
      orders: {
        ...s.orders,
        [anyId]: {
          ...(s.orders[anyId] ?? {
            side: "buy",
            role: "open",
            price: "1",
            qty: "1",
            filled: "0",
            status: "live",
            since: 0,
          }),
          status: "cancelling",
        },
      },
    };
    const r = volumeMaker.step(c, s, sync(91_000, "0"), ctx);
    expect(resynced(r.actions)).toBe(false);
  });
});

describe("Market Making Max open position check from the SoDEX position (#497)", () => {
  const quoteAt = (s: VolumeMakerState, at: number) => {
    const r = run(cfg(), [{ type: "timer", at }], s);
    return r.all.flatMap((a) => (a.type === "place" ? [a.order] : []));
  };

  it("does not place orders that grow a fresh SoDEX position already at the limit, whatever the ledger says", () => {
    // Sổ cái phẳng (sai), SoDEX đọc 1 s trước: long 0.005 = 500 USDC = Max open position.
    const base = run(cfg(), [{ type: "tick", at: 0, market: "BTC-USD", price: "100000" }]).s;
    const s: VolumeMakerState = { ...base, sodexPosition: { size: "0.005", at: 2_000 } };
    const placed = quoteAt(s, 3_000);
    expect(placed.some((o) => o.side === "buy")).toBe(false);
    expect(placed.some((o) => o.side === "sell")).toBe(true);
    // Kiểm ngược: số SoDEX đã cũ (> 45 s) thì không dùng; số dưới giới hạn cũng không chặn.
    expect(
      quoteAt({ ...base, sodexPosition: { size: "0.005", at: -50_000 } }, 3_000).some(
        (o) => o.side === "buy",
      ),
    ).toBe(true);
    expect(
      quoteAt({ ...base, sodexPosition: { size: "0.002", at: 2_000 } }, 3_000).some(
        (o) => o.side === "buy",
      ),
    ).toBe(true);
  });

  it("blocks a ledger 'close' that is not reduce-only when it would grow the real position (prod: rc buy on a real long)", () => {
    // Sổ cái short (sai) → lệnh đóng là MUA; SoDEX long ở giới hạn; lệnh đóng không reduce-only (đường dự phòng cũ).
    const base = run(cfg(), [...idleShort()]).s;
    const s: VolumeMakerState = {
      ...base,
      closeReduceOnly: false,
      sodexPosition: { size: "0.005", at: 2_000 },
    };
    expect(quoteAt(s, 3_000).some((o) => o.side === "buy")).toBe(false);
    // Kiểm ngược: lệnh đóng reduce-only vẫn được gửi (SoDEX tự chặn nếu nó làm tăng vị thế).
    const ro = quoteAt({ ...s, closeReduceOnly: true }, 3_000).filter((o) => o.side === "buy");
    expect(ro).toHaveLength(1);
    expect(ro[0]?.reduceOnly).toBe(true);
  });
});

describe("Market Making 'position not found' on a reduce-only close (#497, PM comment)", () => {
  const rejects = (positionNotFound: boolean): StrategyEvent[] =>
    [3_000, 6_000, 9_000].flatMap((t, i) => [
      { type: "timer", at: t } as const,
      {
        type: "orderReject",
        at: t + 100,
        clOrdID: id(`vm:${String(i + 2)}:rc`),
        code: "-1",
        message: "position not found: 2",
        ...(positionNotFound ? { positionNotFound: true } : {}),
      } as const,
    ]);

  it("never falls back to close orders without reduce-only, and a fresh flat read fixes the ledger at once", () => {
    const c = cfg();
    const r = run(c, [...idleShort(), ...rejects(true)]);
    expect(r.s.closeReduceOnly).toBe(true);
    expect(
      r.all.some((a) => a.type === "log" && a.decision === "Close orders sent post-only"),
    ).toBe(false);
    expect(
      r.all.filter((a) => a.type === "log" && a.decision === "Checking the position on SoDEX"),
    ).toHaveLength(1);
    // Mọi lệnh đóng đã gửi đều reduce-only.
    const rcIds = new Set([2, 3, 4].map((n) => id(`vm:${String(n)}:rc`)));
    const closes = r.all.flatMap((a) =>
      a.type === "place" && rcIds.has(a.order.clOrdID) ? [a.order] : [],
    );
    expect(closes.length).toBeGreaterThan(0);
    for (const o of closes) expect(o.reduceOnly).toBe(true);
    // Engine đọc lại ngay: SoDEX phẳng → sửa sổ cái, không chờ 30 s.
    const fixed = run(c, [sync(9_500, "0", { historyAt: 9_200 })], r.s);
    console.log("DBG", JSON.stringify({ suspect: r.s.positionSuspectAt, last: r.s.lastFillAt, orders: Object.values(r.s.orders).map((o) => o.status), pos: r.s.ledger.position, acts: fixed.all }));
    expect(resynced(fixed.all)).toBe(true);
    expect(fixed.s.ledger.position).toBe("0");
    expect(fixed.s.positionSuspectAt).toBeNull();
  });

  it("kiểm ngược: other reduce-only rejects still use the old fallback; a non-flat read after the reject waits", () => {
    const c = cfg();
    const old = run(c, [...idleShort(), ...rejects(false)]);
    expect(old.s.closeReduceOnly).toBe(false);
    const r = run(c, [...idleShort(), ...rejects(true)]);
    const notFlat = run(c, [sync(9_500, "0.002", { historyAt: 9_200 })], r.s);
    expect(resynced(notFlat.all)).toBe(false);
  });
});
