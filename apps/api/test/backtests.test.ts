import { backtestViewSchema, errorResponseSchema } from "@drift/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { signIn, startTestEnv, TestClient, type TestEnv } from "./helpers";

let env: TestEnv;
const grid = {
  market: "vBTC_vUSDC",
  lowerPrice: "90",
  upperPrice: "110",
  gridLevels: 5,
  spacing: "arithmetic",
  investment: "500",
  maxLoss: "100",
  onStop: "keep_base",
};

beforeAll(async () => {
  env = await startTestEnv();
});
afterAll(async () => {
  await env.close();
});

describe("backtests API", () => {
  it("queues a run through the outbox and reuses a finished result for the same inputs", async () => {
    const client = new TestClient(env.app);
    await signIn(env, client, "bt1@example.com");
    const first = backtestViewSchema.parse(
      (
        await client.request("POST", "/api/v1/backtests", {
          body: { strategy: "spot_grid", config: grid, periodDays: 90 },
        })
      ).json(),
    );
    expect(first.status).toBe("queued");
    const { rows } = await env.pool.query<{ payload: { runId: string } }>(
      "select payload from outbox where topic = 'backtest.run'",
    );
    expect(rows.map((r) => r.payload.runId)).toContain(first.id);
    const { rows: run } = await env.pool.query<{ data_version: string }>(
      "select data_version from backtest_runs where id = $1",
      [first.id],
    );
    expect(run[0]?.data_version).toMatch(/^15m:\d{4}-\d{2}-\d{2}$/);

    const result = {
      interval: "15m",
      candles: 1,
      from: 0,
      to: 1,
      capital: "500",
      net: "1",
      netPct: "0.2",
      fees: "0.1",
      funding: "0",
      maxDrawdown: "0",
      maxDrawdownPct: "0",
      equity: [],
      metrics: [],
      halted: null,
      perps: false,
    };
    await env.pool.query("update backtest_runs set status = 'done', result = $2 where id = $1", [
      first.id,
      JSON.stringify(result),
    ]);
    // Cùng config (khác thứ tự khoá) → dùng lại kết quả, không xếp job mới.
    const reordered = Object.fromEntries(Object.entries(grid).reverse());
    const other = new TestClient(env.app);
    await signIn(env, other, "bt2@example.com");
    const second = backtestViewSchema.parse(
      (
        await other.request("POST", "/api/v1/backtests", {
          body: { strategy: "spot_grid", config: reordered, periodDays: 90 },
        })
      ).json(),
    );
    expect(second).toMatchObject({ status: "done", result: { net: "1" } });
    expect(second.id).not.toBe(first.id);
    expect((await other.request("GET", `/api/v1/backtests/${first.id}`)).statusCode).toBe(404);
    expect(
      backtestViewSchema.parse(
        (await client.request("GET", `/api/v1/backtests/${first.id}`)).json(),
      ).status,
    ).toBe("done");
  });

  it("validates the bot settings before queueing", async () => {
    const client = new TestClient(env.app);
    await signIn(env, client, "bt3@example.com");
    const res = await client.request("POST", "/api/v1/backtests", {
      body: { strategy: "spot_grid", config: { ...grid, lowerPrice: "120" }, periodDays: 30 },
    });
    expect(errorResponseSchema.parse(res.json()).error.code).toBe("VALIDATION_FAILED");
  });
});
