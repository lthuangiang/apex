import { createDb, marketStatsDaily, runMigrations, type Db } from "@drift/db";
import { AppError, ErrorCode, planViewSchema } from "@drift/shared";
import type { Kline, PerpsSymbol, SpotSymbol } from "@drift/sodex";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildRecoApp } from "../src/app";
import { marketLoader } from "../src/markets";

const DAY = 86_400_000;
const NOW = Date.parse("2026-10-27T12:00:00Z");
const TODAY = NOW - (NOW % DAY);

let container: StartedPostgreSqlContainer;
let db: Db;
let pool: ReturnType<typeof createDb>["pool"];
let app: FastifyInstance;
let klineCalls = 0;

const symbol = (name: string, extra: Record<string, unknown> = {}) =>
  ({
    name,
    status: "TRADING",
    tickSize: "0.01",
    stepSize: "0.0001",
    minQuantity: "0.0001",
    minNotional: "10",
    quoteCoin: "vUSDC",
    maxLeverage: 20,
    ...extra,
  }) as unknown as SpotSymbol & PerpsSymbol;
// 32 nến ngày, mới nhất trước; nến hôm nay (chưa đóng) có giá vô lý và phải bị bỏ.
const klines: Kline[] = Array.from({ length: 32 }, (_, i) => ({
  t: TODAY - (31 - i) * DAY,
  o: "1",
  h: "1",
  l: "1",
  c: i === 31 ? "999999" : String(66000 + 1500 * Math.sin(i / 2)),
  v: "1",
  q: "1",
  n: 1,
})).reverse();

beforeAll(async () => {
  container = await new PostgreSqlContainer("timescale/timescaledb:2.16.1-pg16").start();
  await runMigrations(container.getConnectionUri());
  ({ db, pool } = createDb(container.getConnectionUri()));
  const date = new Date(TODAY).toISOString().slice(0, 10);
  await db.insert(marketStatsDaily).values([
    {
      market: "vBTC_vUSDC",
      engine: "spot",
      date,
      sigma30: 0.025,
      p5: "62000",
      p50: "67000",
      p95: "72000",
      lastPrice: "67000",
      trend: 0.1,
      rangeScore: 0.7,
    },
    {
      market: "BTC-USD",
      engine: "perps",
      date,
      sigma30: 0.025,
      p5: "62000",
      p50: "67000",
      p95: "72000",
      lastPrice: "67000",
      trend: 0.1,
      rangeScore: 0.7,
      fundingAvg7d: "0.00008",
      fundingPos21: 0.8,
    },
  ]);
  const markets = marketLoader({
    db,
    now: () => NOW,
    rest: {
      getSpotSymbols: () => Promise.resolve([symbol("vBTC_vUSDC")]),
      getPerpsSymbols: () => Promise.resolve([symbol("BTC-USD")]),
      getKlines: () => {
        klineCalls += 1;
        return Promise.resolve(klines);
      },
    },
  });
  app = buildRecoApp({ markets, logLevel: "silent" });
});
afterAll(async () => {
  await app.close();
  await pool.end();
  await container.stop();
});

const body = (goal: string) => ({
  account: null,
  accountLeverageCap: null,
  timeZone: "UTC",
  now: NOW,
  goals: { goal, capital: "8000", maxDrop: "10", assets: ["BTC"] },
});

describe("reco service", () => {
  it("builds a plan from stored stats and SoDEX daily closes", async () => {
    const res = await app.inject({ method: "POST", url: "/v1/plan", payload: body("range") });
    expect(res.statusCode).toBe(200);
    const plan = planViewSchema.omit({ best: true, addOns: true }).parse(res.json());
    expect(plan.empty).toBeNull();
    const best = res.json<{ best: { strategy: string; values: Record<string, unknown> } }>().best;
    expect(best.strategy).toBe("spot_grid");
    expect(best.values).toMatchObject({ lowerPrice: "62000", upperPrice: "72000" });
    // Nến hôm nay (999999) không lọt vào: chặn dưới của DCA không vượt quá vài %.
    expect(JSON.stringify(res.json())).not.toContain("999");
  });

  it("caches market inputs between requests", async () => {
    const before = klineCalls;
    await app.inject({ method: "POST", url: "/v1/plan", payload: body("automate") });
    expect(klineCalls).toBe(before);
  });

  it("only loads daily closes for the assets asked about, waiting out the rate limit", async () => {
    const calls: string[] = [];
    let limited = true;
    const load = marketLoader({
      db,
      now: () => NOW,
      rest: {
        getSpotSymbols: () => Promise.resolve([symbol("vBTC_vUSDC")]),
        getPerpsSymbols: () => Promise.resolve([symbol("BTC-USD")]),
        getKlines: (_e, market) => {
          if (limited) {
            limited = false;
            return Promise.reject(
              new AppError(ErrorCode.rateLimited, "limited", { retryAfterMs: 10 }),
            );
          }
          calls.push(market);
          return Promise.resolve(klines);
        },
      },
    });
    expect(await load(["ETH"])).toEqual([]);
    expect(calls).toEqual([]);
    expect((await load(["BTC"])).map((m) => m.market).sort()).toEqual(["BTC-USD", "vBTC_vUSDC"]);
    expect(calls.sort()).toEqual(["BTC-USD", "vBTC_vUSDC"]);
  });

  it("returns AI parameters for one strategy and market", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/params",
      payload: {
        account: null,
        accountLeverageCap: null,
        timeZone: "UTC",
        now: NOW,
        strategy: "futures_grid",
        market: "BTC-USD",
        capital: "5000",
        maxDrop: "20",
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ values: Record<string, unknown> }>().values).toMatchObject({
      market: "BTC-USD",
      leverage: 2,
      marginMode: "isolated",
    });
  });

  it("rejects unknown markets and bad bodies", async () => {
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/v1/params",
          payload: {
            ...body("range"),
            strategy: "spot_grid",
            market: "NOPE",
            capital: "1",
            maxDrop: "5",
          },
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (await app.inject({ method: "POST", url: "/v1/plan", payload: { goals: {} } })).statusCode,
    ).toBe(400);
  });
});
