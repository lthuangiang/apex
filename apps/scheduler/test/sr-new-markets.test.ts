import { SR_NEW_MARKET_ALERT_MAX, teamOpsEventSchema, type TeamOpsEvent } from "@drift/shared";
import { Redis } from "ioredis";
import { GenericContainer, type StartedTestContainer } from "testcontainers";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  checkNewMarkets,
  newMarketEvents,
  redisSeenStore,
  unclassifiedMarkets,
  type NewMarketDeps,
} from "../src/sr-new-markets";

// #311: market SoDEX mới chưa có trong asset map Signal research → báo team một lần cho mỗi market (kể cả sau khi
// scheduler khởi động lại), quá 10 market cùng lúc thì một tin tổng hợp. Không có lời gọi SoDEX / Telegram nào: sự kiện
// chỉ được ghi vào mảng thay cho outbox.

const STOCKS = new Set(["AAPL-USD", "NVDA-USD"]);
const VERSION = "assets-2026-11-19a";
const BASE = ["BTC-USD", "ETH-USD", "AAPL-USD", "NVDA-USD"];

describe("detection (pure)", () => {
  it("keeps new markets outside the stock set, without duplicates, sorted", () => {
    expect(unclassifiedMarkets(["XYZ-USD", "AAPL-USD", "ABC-USD", "XYZ-USD"], STOCKS)).toEqual([
      "ABC-USD",
      "XYZ-USD",
    ]);
    expect(unclassifiedMarkets(["NVDA-USD"], STOCKS)).toEqual([]);
  });

  it("sends one alert per market up to 10, then one summary with the first 10 names and the total", () => {
    const names = (n: number) => Array.from({ length: n }, (_, i) => `M${String(i)}-USD`);
    expect(newMarketEvents([], VERSION)).toEqual([]);
    const ten = newMarketEvents(names(SR_NEW_MARKET_ALERT_MAX), VERSION);
    expect(ten).toHaveLength(10);
    expect(ten[0]).toEqual({
      type: "team_sr_new_market",
      markets: ["M0-USD"],
      total: 1,
      assetMapVersion: VERSION,
    });
    const many = newMarketEvents(names(13), VERSION);
    expect(many).toEqual([
      {
        type: "team_sr_new_market",
        markets: names(10),
        total: 13,
        assetMapVersion: VERSION,
      },
    ]);
    for (const e of [...ten, ...many]) expect(teamOpsEventSchema.safeParse(e).success).toBe(true);
  });
});

describe("once per market across restarts (Redis)", () => {
  let container: StartedTestContainer;
  const clients: Redis[] = [];
  /** Một "tiến trình scheduler": client Redis mới, store mới (không có trạng thái trong bộ nhớ). */
  const boot = (sent: TeamOpsEvent[], fail = false): NewMarketDeps => {
    const r = new Redis(container.getMappedPort(6379), container.getHost());
    clients.push(r);
    return {
      store: redisSeenStore(r),
      emit: (events) => {
        if (fail) return Promise.reject(new Error("outbox down"));
        sent.push(...events);
        return Promise.resolve();
      },
      stocks: STOCKS,
      version: VERSION,
    };
  };

  beforeAll(async () => {
    container = await new GenericContainer("redis:7.4-alpine").withExposedPorts(6379).start();
  });
  afterAll(async () => {
    for (const c of clients) c.disconnect();
    await container.stop();
  });
  beforeEach(async () => {
    const r = new Redis(container.getMappedPort(6379), container.getHost());
    await r.flushall();
    r.disconnect();
  });

  it("records the first list as a baseline without alerting, then alerts a new market once ever", async () => {
    const sent: TeamOpsEvent[] = [];
    const first = boot(sent);
    expect(await checkNewMarkets(first, [])).toEqual({ status: "skipped" });
    expect(await checkNewMarkets(first, BASE)).toEqual({ status: "seeded", count: 4 });
    expect(sent).toEqual([]);

    expect(await checkNewMarkets(first, [...BASE, "XYZ-USD"])).toEqual({
      status: "checked",
      alerted: ["XYZ-USD"],
    });
    expect(await checkNewMarkets(first, [...BASE, "XYZ-USD"])).toEqual({
      status: "checked",
      alerted: [],
    });

    // Khởi động lại: tiến trình mới, cùng Redis → không báo lại XYZ-USD. TSLA chưa có trong tập cổ phiếu → báo;
    // META đã được phân loại (có trong tập) → không báo.
    const second = boot(sent);
    expect(await checkNewMarkets(second, [...BASE, "XYZ-USD", "TSLA-USD"])).toEqual({
      status: "checked",
      alerted: ["TSLA-USD"],
    });
    const stocks = new Set([...STOCKS, "META-USD"]);
    expect(await checkNewMarkets({ ...second, stocks }, [...BASE, "META-USD"])).toEqual({
      status: "checked",
      alerted: [],
    });
    // Market biến mất rồi quay lại không báo lại.
    expect(await checkNewMarkets(second, [...BASE, "XYZ-USD"])).toEqual({
      status: "checked",
      alerted: [],
    });
    expect(sent.map((e) => (e.type === "team_sr_new_market" ? e.markets : []))).toEqual([
      ["XYZ-USD"],
      ["TSLA-USD"],
    ]);
  });

  it("two overlapping checks never alert the same market twice", async () => {
    const sent: TeamOpsEvent[] = [];
    const a = boot(sent);
    const b = boot(sent);
    await checkNewMarkets(a, BASE);
    await Promise.all([
      checkNewMarkets(a, [...BASE, "NEW1-USD", "NEW2-USD"]),
      checkNewMarkets(b, [...BASE, "NEW1-USD", "NEW2-USD"]),
    ]);
    expect(sent.flatMap((e) => (e.type === "team_sr_new_market" ? e.markets : [])).sort()).toEqual([
      "NEW1-USD",
      "NEW2-USD",
    ]);
  });

  it("sends one summary when more than 10 markets appear at once", async () => {
    const sent: TeamOpsEvent[] = [];
    const deps = boot(sent);
    await checkNewMarkets(deps, BASE);
    const fresh = Array.from({ length: 12 }, (_, i) => `N${String(i).padStart(2, "0")}-USD`);
    const r = await checkNewMarkets(deps, [...BASE, ...fresh]);
    expect(r).toEqual({ status: "checked", alerted: fresh });
    expect(sent).toEqual([
      {
        type: "team_sr_new_market",
        markets: fresh.slice(0, 10),
        total: 12,
        assetMapVersion: VERSION,
      },
    ]);
  });

  it("forgets a market when the alert could not be queued, so the next run alerts it", async () => {
    const sent: TeamOpsEvent[] = [];
    await checkNewMarkets(boot(sent), BASE);
    await expect(checkNewMarkets(boot(sent, true), [...BASE, "XYZ-USD"])).rejects.toThrow(
      "outbox down",
    );
    expect(sent).toEqual([]);
    expect(await checkNewMarkets(boot(sent), [...BASE, "XYZ-USD"])).toEqual({
      status: "checked",
      alerted: ["XYZ-USD"],
    });
  });
});
