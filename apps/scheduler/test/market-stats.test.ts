import { createDb, fundingRates, marketStatsDaily, runMigrations, type Db } from "@drift/db";
import type { Kline, PerpsSymbol, SpotSymbol } from "@drift/sodex";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { computeDailyStats, utcDate } from "../src/market-stats";

const DAY = 86_400_000;
const NOW = Date.parse("2026-10-27T12:00:00Z");
const TODAY = NOW - (NOW % DAY);

let container: StartedPostgreSqlContainer;
let db: Db;
let pool: ReturnType<typeof createDb>["pool"];

beforeAll(async () => {
  container = await new PostgreSqlContainer("timescale/timescaledb:2.16.1-pg16").start();
  await runMigrations(container.getConnectionUri());
  ({ db, pool } = createDb(container.getConnectionUri()));
});
afterAll(async () => {
  await pool.end();
  await container.stop();
});

const symbol = (name: string) =>
  ({ name, status: "TRADING" }) as unknown as SpotSymbol & PerpsSymbol;
// 40 ngày xen kẽ 100/110, mới nhất trước như API; thêm nến của hôm nay (chưa đóng) phải bị bỏ.
const klines: Kline[] = Array.from({ length: 41 }, (_, i) => {
  const t = TODAY - (40 - i) * DAY;
  return {
    t,
    o: "100",
    h: "110",
    l: "100",
    c: i === 40 ? "999" : i % 2 === 0 ? "100" : "110",
    v: "1",
    q: "1",
    n: 1,
  };
}).reverse();

describe("computeDailyStats", () => {
  it("stores one row per trading market for today, ignoring the open day", async () => {
    await db.insert(fundingRates).values(
      Array.from({ length: 21 }, (_, i) => ({
        market: "BTC-USD",
        fundingTime: new Date(NOW - (i + 1) * 8 * 3_600_000),
        rate: "0.0001",
      })),
    );
    const result = await computeDailyStats({
      db,
      now: () => new Date(NOW),
      rest: {
        getSpotSymbols: () => Promise.resolve([symbol("vBTC_vUSDC")]),
        getPerpsSymbols: () =>
          Promise.resolve([symbol("BTC-USD"), { ...symbol("OLD-USD"), status: "HALT" }]),
        getKlines: () => Promise.resolve(klines),
      },
    });
    expect(result).toEqual({ markets: 2, failed: [] });
    const rows = await db.select().from(marketStatsDaily);
    expect(rows.map((r) => r.market).sort()).toEqual(["BTC-USD", "vBTC_vUSDC"]);
    const btc = rows.find((r) => r.market === "BTC-USD");
    expect(btc?.date).toBe(utcDate(NOW));
    // Giá 999 của hôm nay không được tính: giá cuối là ngày hôm qua (i = 39 → 110).
    expect(Number(btc?.lastPrice)).toBe(110);
    expect(Number(btc?.p50)).toBe(105);
    expect(btc?.fundingPos21).toBe(1);
    expect(rows.find((r) => r.market === "vBTC_vUSDC")?.fundingPos21).toBeNull();

    // Chạy lại trong ngày: cập nhật, không tạo dòng mới.
    await computeDailyStats({
      db,
      now: () => new Date(NOW),
      rest: {
        getSpotSymbols: () => Promise.resolve([symbol("vBTC_vUSDC")]),
        getPerpsSymbols: () => Promise.resolve([symbol("BTC-USD")]),
        getKlines: () => Promise.resolve(klines),
      },
    });
    expect(await db.select().from(marketStatsDaily)).toHaveLength(2);
  });
});
