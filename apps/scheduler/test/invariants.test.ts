import { describe, expect, it } from "vitest";

import {
  decide,
  findingsOf,
  type BotSnapshot,
  type InvariantStore,
  PROD_INVARIANTS,
} from "../src/invariants";

// Bất biến tiền thật trên prod (DEC-TBD-prod-invariants): hàm thuần cho P1–P5 và quyết định gửi (sai 2 lần liền,
// 1 tin / 30 phút, "resolved" khi đúng trở lại). Không cần DB.

const NOW = Date.parse("2026-11-16T10:00:00Z");
const BOT = "01a1d823-0000-7000-8000-00000000d50d";

const mm = (over: Partial<BotSnapshot> = {}): BotSnapshot => ({
  id: BOT,
  strategy: "volume_maker",
  market: "BTC-USD",
  state: "running",
  updatedAt: NOW - 3_600_000,
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
  stepSize: "0.0001",
  ...over,
});
const ids = (b: BotSnapshot) => findingsOf(b, NOW).map((f) => f.invariant);

describe("prod invariants P1–P5", () => {
  it("passes a healthy Market Making bot", () => {
    expect(ids(mm())).toEqual([]);
  });

  it("P1: flags a position above (max + one order) × 1.05, not at it", () => {
    // max 500 + một lệnh 500 = 1000; × 1.05 = 1050.
    const at = (pos: string) => mm({ runtime: { ...mm().runtime, ledger: { position: pos } } });
    expect(ids(at("0.0105"))).not.toContain("P1");
    expect(ids({ ...at("0.0106"), filledNet: "0.0106" })).toContain("P1");
  });

  it("P2: flags opening orders placed after Stop, for live and paper bots", () => {
    expect(ids(mm({ state: "stopping", openingAfterStop: 2 }))).toContain("P2");
    expect(ids(mm({ state: "stopping" }))).not.toContain("P2");
  });

  it("P3: flags orders still open more than 60 s after the bot stopped", () => {
    const stopped = (ago: number, n: number) =>
      mm({ state: "stopped", updatedAt: NOW - ago, stillOpen: n });
    expect(ids(stopped(PROD_INVARIANTS.openAfterStopMs + 1, 1))).toContain("P3");
    expect(ids(stopped(PROD_INVARIANTS.openAfterStopMs - 1, 1))).not.toContain("P3");
    expect(ids(stopped(PROD_INVARIANTS.openAfterStopMs + 1, 0))).not.toContain("P3");
  });

  it("P4: flags a ledger that differs from the fills by more than one step size", () => {
    expect(ids(mm({ filledNet: "0.0052" }))).toContain("P4");
    expect(ids(mm({ filledNet: "0.0051" }))).not.toContain("P4");
    // Step size không biết: không xét (không đoán).
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
});

/** Redis giả: khoá có hạn theo đồng hồ giả. */
function memStore(clock: { now: number }): InvariantStore {
  const until = new Map<string, number>();
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
    claim: (k, ms) => {
      if (live(k)) return Promise.resolve(false);
      until.set(k, clock.now + ms);
      return Promise.resolve(true);
    },
  };
}

describe("prod invariants: when to send", () => {
  const f = { invariant: "P5" as const, botId: BOT, detail: "no quote for 40 s" };

  it("alerts only after two failing checks in a row, then at most once per 30 minutes", async () => {
    const clock = { now: NOW };
    const store = memStore(clock);
    expect(await decide(store, [BOT], [f])).toEqual([]);
    clock.now += 60_000;
    expect(await decide(store, [BOT], [f])).toEqual([
      { type: "team_invariant", ...f, status: "failing" },
    ]);
    // Vẫn sai mỗi phút: không gửi lại trong 30 phút, gửi lại đúng một lần khi hết 30 phút.
    let sent = 0;
    for (let i = 0; i < 30; i += 1) {
      clock.now += 60_000;
      sent += (await decide(store, [BOT], [f])).length;
    }
    expect(sent).toBe(1);
    expect(PROD_INVARIANTS.throttleMs).toBe(30 * 60_000);
  });

  it("does not alert when one failing check is followed by a passing one", async () => {
    const clock = { now: NOW };
    const store = memStore(clock);
    await decide(store, [BOT], [f]);
    clock.now += 60_000;
    expect(await decide(store, [BOT], [])).toEqual([]);
    clock.now += 60_000;
    expect(await decide(store, [BOT], [f])).toEqual([]);
  });

  it("sends one resolved message when an alerted invariant passes again", async () => {
    const clock = { now: NOW };
    const store = memStore(clock);
    await decide(store, [BOT], [f]);
    clock.now += 60_000;
    await decide(store, [BOT], [f]);
    clock.now += 60_000;
    expect(await decide(store, [BOT], [])).toEqual([
      { type: "team_invariant", invariant: "P5", botId: BOT, status: "resolved", detail: "" },
    ]);
    clock.now += 60_000;
    expect(await decide(store, [BOT], [])).toEqual([]);
  });
});
