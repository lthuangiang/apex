import { backtestRuns, createDb, runMigrations, users, type Db } from "@drift/db";
import { backtestResultSchema } from "@drift/shared";
import type { Kline, PerpsSymbol, SpotSymbol } from "@drift/sodex";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runJob, type RunDeps } from "../src/run";

const DAY = 86_400_000;
const NOW = Date.parse("2026-10-28T09:00:00Z");
const TODAY = NOW - (NOW % DAY);
const STEP = 900_000;

let container: StartedPostgreSqlContainer;
let db: Db;
let pool: ReturnType<typeof createDb>["pool"];
let userId: string;

beforeAll(async () => {
  container = await new PostgreSqlContainer("timescale/timescaledb:2.16.1-pg16").start();
  await runMigrations(container.getConnectionUri());
  ({ db, pool } = createDb(container.getConnectionUri()));
  const [u] = await db.insert(users).values({ email: "bt@x.test" }).returning();
  userId = u?.id ?? "";
});
afterAll(async () => {
  await pool.end();
  await container.stop();
});

const symbol = (name: string) =>
  ({
    name,
    status: "TRADING",
    tickSize: "0.01",
    stepSize: "0.0001",
    minQuantity: "0.0001",
    minNotional: "5",
  }) as unknown as SpotSymbol & PerpsSymbol;

/** Nến 15 phút quanh 100 trong khoảng được hỏi; `since` cắt bớt lịch sử để giả lập SoDEX không còn dữ liệu cũ. */
function rest(since = 0): RunDeps["rest"] & { pages: number } {
  const r = {
    pages: 0,
    getSpotSymbols: () => Promise.resolve([symbol("vBTC_vUSDC")]),
    getPerpsSymbols: () => Promise.resolve([symbol("BTC-USD")]),
    getKlines: (
      _e: "spot" | "perps",
      _m: string,
      q: { startTime?: number; endTime?: number; limit: number },
    ) => {
      r.pages += 1;
      const out: Kline[] = [];
      for (let t = q.startTime ?? 0; t <= (q.endTime ?? 0) && out.length < q.limit; t += STEP) {
        if (t < since) continue;
        const p = 100 + 8 * Math.sin(t / (6 * 3_600_000));
        out.push({
          t,
          o: p.toFixed(2),
          h: (p + 0.5).toFixed(2),
          l: (p - 0.5).toFixed(2),
          c: (p + 0.1).toFixed(2),
          v: "1",
          q: "1",
          n: 1,
        });
      }
      return Promise.resolve(out.reverse());
    },
  };
  return r;
}

const grid = {
  market: "vBTC_vUSDC",
  lowerPrice: "90",
  upperPrice: "110",
  gridLevels: 9,
  spacing: "arithmetic",
  investment: "1000",
  maxLoss: "500",
  onStop: "keep_base",
};

async function queue(strategy: string, market: string, config: Record<string, unknown>) {
  const [row] = await db
    .insert(backtestRuns)
    .values({
      userId,
      strategy,
      market,
      paramsHash: "h",
      config,
      periodDays: 90,
      dataVersion: `15m:${new Date(TODAY).toISOString().slice(0, 10)}`,
      status: "queued",
    })
    .returning();
  return row?.id ?? "";
}
const load = async (id: string) =>
  (await db.select().from(backtestRuns).where(eq(backtestRuns.id, id)))[0];

describe("backtest worker", () => {
  it("runs 90 days of 15-minute SoDEX candles through the shared strategy code", async () => {
    const id = await queue("spot_grid", "vBTC_vUSDC", grid);
    const r = rest();
    const started = Date.now();
    await runJob({ db, rest: r, now: () => new Date(NOW) }, id);
    const row = await load(id);
    expect(row?.status).toBe("done");
    const result = backtestResultSchema.parse(row?.result);
    expect(result.interval).toBe("15m");
    expect(result.candles).toBe(90 * 96);
    expect(result.from).toBe(TODAY - 90 * DAY);
    expect(Number(result.fees)).toBeGreaterThan(0);
    expect(result.metrics.map((m) => m.key)).toEqual(["fills", "timeInRange"]);
    expect(r.pages).toBe(Math.ceil((90 * 96) / 1000));
    expect(Date.now() - started).toBeLessThan(20_000);
  });

  it("reports unavailable when SoDEX history is shorter than the period", async () => {
    const id = await queue("spot_grid", "vBTC_vUSDC", grid);
    await runJob({ db, rest: rest(TODAY - 10 * DAY), now: () => new Date(NOW) }, id);
    expect(await load(id)).toMatchObject({ status: "unavailable", error: "history_short" });
  });

  it("refuses perps backtests without funding history for the period", async () => {
    const id = await queue("futures_grid", "BTC-USD", {
      ...grid,
      market: "BTC-USD",
      leverage: 1,
      marginMode: "isolated",
      direction: "neutral",
      margin: "1000",
      stopBelow: "1",
      onStop: "close_at_market",
    });
    await runJob({ db, rest: rest(), now: () => new Date(NOW) }, id);
    expect(await load(id)).toMatchObject({ status: "unavailable", error: "funding_short" });
  });
});
