import { describe, expect, it } from "vitest";

import {
  collapseMassStale,
  commit,
  decide,
  findingsOf,
  MASS_STALE_KEY,
  type BotSnapshot,
  type Finding,
  type InvariantStore,
  PROD_INVARIANTS,
  stopTimeOf,
} from "../src/invariants";

// Bất biến tiền thật trên prod (DEC-273): hàm thuần cho P1–P5, P7 và quyết định gửi (sai 2 lần liền,
// 1 tin / 30 phút, "resolved" khi đúng trở lại hoặc bot không còn được xét). Không cần DB.

const NOW = Date.parse("2026-11-16T10:00:00Z");
const BOT = "01a1d823-0000-7000-8000-00000000d50d";

const mm = (over: Partial<BotSnapshot> = {}): BotSnapshot => ({
  id: BOT,
  strategy: "volume_maker",
  market: "BTC-USD",
  state: "running",
  mode: "live",
  stopAt: null,
  config: { orderSize: "500", maxOrders: 1, refreshSeconds: 3 },
  runtime: {
    phase: "running",
    mid: "100000",
    lastRefresh: NOW - 2_000,
    ledger: { position: "0.005" },
  },
  openingAfterStop: 0,
  stillOpen: 0,
  filledNet: "0.005",
  resynced: false,
  stepSize: "0.0001",
  ...over,
});
const ids = (b: BotSnapshot) => findingsOf(b, NOW).map((f) => f.invariant);

describe("prod invariants P1–P5, P7", () => {
  it("passes a healthy Market Making bot", () => {
    expect(ids(mm())).toEqual([]);
  });

  it("P1: flags a position above (max + one order) × 1.05, not at it", () => {
    // max 500 + một lệnh 500 = 1000; × 1.05 = 1050.
    const at = (pos: string) =>
      mm({ runtime: { ...mm().runtime, ledger: { position: pos } }, filledNet: pos });
    expect(ids(at("0.0105"))).not.toContain("P1");
    expect(ids(at("0.0106"))).toContain("P1");
  });

  it("P1, P4, P5 skip paper bots, whose fills are not in the fills table (DEC-105)", () => {
    const paper = mm({
      mode: "paper",
      runtime: { ...mm().runtime, ledger: { position: "0.02" }, lastRefresh: NOW - 60_000 },
      filledNet: "0",
    });
    expect(ids(paper)).toEqual([]);
  });

  it("P2: flags opening orders placed after Stop, paper bots too", () => {
    expect(ids(mm({ state: "stopping", openingAfterStop: 2 }))).toContain("P2");
    expect(ids(mm({ state: "stopping", mode: "paper", openingAfterStop: 1 }))).toContain("P2");
    expect(ids(mm({ state: "stopping" }))).not.toContain("P2");
  });

  it("P3: flags orders still open more than 60 s after the bot stopped, from the stop time", () => {
    const stopped = (ago: number, n: number) =>
      mm({ state: "stopped", stopAt: NOW - ago, stillOpen: n });
    expect(ids(stopped(PROD_INVARIANTS.openAfterStopMs + 1, 1))).toContain("P3");
    expect(ids(stopped(PROD_INVARIANTS.openAfterStopMs - 1, 1))).not.toContain("P3");
    expect(ids(stopped(PROD_INVARIANTS.openAfterStopMs + 1, 0))).not.toContain("P3");
    // Không biết lúc dừng: không đoán.
    expect(ids(mm({ state: "stopped", stopAt: null, stillOpen: 1 }))).not.toContain("P3");
  });

  it("P4: flags a ledger that differs from the fills by more than the tolerance", () => {
    expect(ids(mm({ filledNet: "0.0052" }))).toContain("P4");
    expect(ids(mm({ filledNet: "0.0051" }))).not.toContain("P4");
    expect(ids(mm({ filledNet: "0.01", stepSize: null }))).not.toContain("P4");
  });

  it("P5: flags a running bot with no quote past refresh + 30 s, unless it waits on purpose", () => {
    const gap = (ms: number, extra: Record<string, unknown> = {}) =>
      mm({ runtime: { ...mm().runtime, lastRefresh: NOW - ms, ...extra } });
    expect(ids(gap(34_000))).toContain("P5");
    expect(ids(gap(32_000))).not.toContain("P5");
    expect(ids(gap(60_000, { phase: "halted" }))).not.toContain("P5");
    expect(ids(gap(60_000, { fastPauseUntil: NOW + 10_000 }))).not.toContain("P5");
    expect(ids(gap(60_000, { cutAt: NOW - 20_000 }))).not.toContain("P5");
    expect(ids({ ...gap(60_000), state: "paused" })).not.toContain("P5");
  });

  it("P7: flags a bot stopping for more than 5 minutes", () => {
    const stopping = (ago: number) => mm({ state: "stopping", stopAt: NOW - ago });
    expect(ids(stopping(PROD_INVARIANTS.stoppingMaxMs + 1))).toContain("P7");
    expect(ids(stopping(PROD_INVARIANTS.stoppingMaxMs - 1))).not.toContain("P7");
  });

  it("P5: collapses many stale bots into one alert (SoDEX or engine down)", () => {
    const p5 = (i: number): Finding => ({ invariant: "P5", botId: `b${String(i)}`, detail: "x" });
    const p1: Finding = { invariant: "P1", botId: "b9", detail: "y" };
    const out = collapseMassStale([p5(1), p5(2), p5(3), p1], 4);
    const loud = out.filter((f) => f.invariant === "P5" && f.quiet !== true);
    expect(loud).toHaveLength(1);
    expect(loud[0]?.key).toBe(MASS_STALE_KEY);
    // Từng bot vẫn giữ trạng thái "đang sai", không gửi tin riêng.
    expect(out.filter((f) => f.quiet === true).map((f) => f.botId)).toEqual(["b1", "b2", "b3"]);
    expect(loud[0]?.detail).toBe(
      "3 of 4 Market Making bots not quoting (possible SoDEX or engine issue)",
    );
    expect(out.some((f) => f.invariant === "P1")).toBe(true);
    // Ít bot đứng so với số đang chạy: báo từng bot như thường.
    expect(collapseMassStale([p5(1), p5(2), p5(3)], 10)).toHaveLength(3);
  });
});

/** Redis giả: khoá có hạn theo đồng hồ giả, và tập các bất biến đang báo. */
function memStore(clock: { now: number }): InvariantStore {
  const until = new Map<string, number>();
  const set = new Set<string>();
  const values = new Map<string, string>();
  const live = (k: string) => (until.get(k) ?? 0) > clock.now;
  return {
    has: (k) => Promise.resolve(live(k)),
    mark: (k, ms) => {
      until.set(k, clock.now + ms);
      return Promise.resolve();
    },
    drop: (k) => {
      until.delete(k);
      return Promise.resolve();
    },
    active: () => Promise.resolve([...set]),
    addActive: (m) => {
      set.add(m);
      return Promise.resolve();
    },
    removeActive: (m) => Promise.resolve(set.delete(m)),
    get: (k) => Promise.resolve(live(k) ? (values.get(k) ?? null) : null),
    put: (k, v, ms) => {
      values.set(k, v);
      until.set(k, clock.now + ms);
      return Promise.resolve();
    },
  };
}

describe("prod invariants: when to send", () => {
  const f: Finding = { invariant: "P5", botId: BOT, detail: "no quote for 40 s" };
  // Như checkProdInvariants: ghi outbox (ở đây: trả tin) rồi mới commit vào Redis.
  const events = async (store: InvariantStore, botIds: string[], fs: Finding[]) => {
    const ds = await decide(store, botIds, fs);
    for (const d of ds) await commit(store, d);
    return ds.map((d) => d.event);
  };

  it("alerts only after two failing checks in a row, then at most once per 30 minutes", async () => {
    const clock = { now: NOW };
    const store = memStore(clock);
    expect(await events(store, [BOT], [f])).toEqual([]);
    clock.now += 60_000;
    expect(await events(store, [BOT], [f])).toEqual([
      { type: "team_invariant", ...f, status: "failing" },
    ]);
    // Vẫn sai mỗi phút: không gửi lại trong 30 phút, gửi lại đúng một lần khi hết 30 phút.
    let sent = 0;
    for (let i = 0; i < 30; i += 1) {
      clock.now += 60_000;
      sent += (await events(store, [BOT], [f])).length;
    }
    expect(sent).toBe(1);
  });

  it("does not alert when one failing check is followed by a passing one", async () => {
    const clock = { now: NOW };
    const store = memStore(clock);
    await events(store, [BOT], [f]);
    clock.now += 60_000;
    expect(await events(store, [BOT], [])).toEqual([]);
    clock.now += 60_000;
    expect(await events(store, [BOT], [f])).toEqual([]);
  });

  it("sends one resolved message when an alerted invariant passes again", async () => {
    const clock = { now: NOW };
    const store = memStore(clock);
    await events(store, [BOT], [f]);
    clock.now += 60_000;
    await events(store, [BOT], [f]);
    clock.now += 60_000;
    expect(await events(store, [BOT], [])).toEqual([
      { type: "team_invariant", invariant: "P5", botId: BOT, status: "resolved", detail: "" },
    ]);
    clock.now += 60_000;
    expect(await events(store, [BOT], [])).toEqual([]);
  });

  it("resolves an alert whose bot is no longer checked, and never resolves what was not alerted", async () => {
    const clock = { now: NOW };
    const store = memStore(clock);
    await events(store, [BOT], [f]);
    clock.now += 60_000;
    await events(store, [BOT], [f]);
    clock.now += 60_000;
    expect(await events(store, [], [])).toEqual([
      {
        type: "team_invariant",
        invariant: "P5",
        botId: BOT,
        status: "resolved",
        detail: "no longer checked",
      },
    ]);
    // Một lần sai rồi hết (chưa từng báo): không có "resolved".
    const other = memStore({ now: NOW });
    await events(other, [BOT], [f]);
    expect(await events(other, [BOT], [])).toEqual([]);
  });
});

describe("prod invariants: review fixes", () => {
  const f: Finding = { invariant: "P5", botId: BOT, detail: "no quote for 40 s" };

  it("changes nothing in Redis until the message is in the outbox, so a failed write is sent again", async () => {
    const clock = { now: NOW };
    const store = memStore(clock);
    await decide(store, [BOT], [f]);
    clock.now += 60_000;
    // Lần ghi outbox lỗi: không commit.
    expect(await decide(store, [BOT], [f])).toHaveLength(1);
    clock.now += 60_000;
    const again = await decide(store, [BOT], [f]);
    expect(again.map((d) => d.event)).toEqual([
      { type: "team_invariant", ...f, status: "failing" },
    ]);
    for (const d of again) await commit(store, d);
    clock.now += 60_000;
    expect(await decide(store, [BOT], [f])).toEqual([]);
  });

  it("keeps one grouped P5 alert when the first stale bot changes, and resolves it once", async () => {
    const clock = { now: NOW };
    const store = memStore(clock);
    const bots = ["a", "b", "c", "d"].map((x) => `${BOT.slice(0, -1)}${x}`);
    const stale = (list: string[]) =>
      collapseMassStale(
        list.map((botId) => ({ invariant: "P5" as const, botId, detail: "no quote for 40 s" })),
        4,
      );
    const run = async (fs: Finding[]) => {
      const ds = await decide(store, bots, fs);
      for (const d of ds) await commit(store, d);
      return ds.map((d) => d.event);
    };
    await run(stale(bots.slice(0, 3)));
    clock.now += 60_000;
    const first = await run(stale(bots.slice(0, 3)));
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ status: "failing", botId: bots[0] });
    // Bot đầu tiên báo giá lại, ba bot khác vẫn đứng: cùng một tin gộp, không "resolved", không tin mới.
    clock.now += 60_000;
    expect(await run(stale(bots.slice(1, 4)))).toEqual([]);
    // Hết đứng: một tin "resolved" cho tin gộp.
    clock.now += 60_000;
    expect(await run([])).toEqual([
      { type: "team_invariant", invariant: "P5", botId: bots[0], status: "resolved", detail: "" },
    ]);
  });

  it("P4: skips a bot whose position was re-synced from SoDEX in this version", () => {
    expect(ids(mm({ filledNet: "0.004" }))).toEqual(["P4"]);
    expect(ids(mm({ filledNet: "0.004", resynced: true }))).toEqual([]);
  });

  it("takes the stop time from the first stop after the latest Start", () => {
    expect(stopTimeOf([])).toBeNull();
    expect(stopTimeOf([{ state: "starting", at: 1 }])).toBeNull();
    // Stop cũ trước lần Start lại: không còn là mốc.
    expect(
      stopTimeOf([
        { state: "stopping", at: 5 },
        { state: "stopped", at: 6 },
        { state: "starting", at: 10 },
      ]),
    ).toBeNull();
    expect(
      stopTimeOf([
        { state: "starting", at: 10 },
        { state: "stopping", at: 20 },
        { state: "stopped", at: 30 },
      ]),
    ).toBe(20);
    // Dừng thẳng sang stopped (không qua stopping).
    expect(
      stopTimeOf([
        { state: "starting", at: 10 },
        { state: "stopped", at: 25 },
      ]),
    ).toBe(25);
  });
});
