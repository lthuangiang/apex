import {
  errorResponseSchema,
  goalsViewSchema,
  planViewSchema,
  suggestionViewSchema,
  type RecoMarket,
} from "@drift/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { signIn, startTestEnv, TestClient, type TestEnv } from "./helpers";

let env: TestEnv;
const errorOf = (body: string) => errorResponseSchema.parse(JSON.parse(body)).error;
const closes = Array.from({ length: 31 }, (_, i) =>
  (66000 * (1 + 0.04 * Math.sin(i / 2))).toFixed(2),
);
const MARKET: RecoMarket = {
  market: "vBTC_vUSDC",
  engine: "spot",
  asset: "BTC",
  quote: "vUSDC",
  lastPrice: "67000",
  sigma30: 0.025,
  p5: "62000",
  p95: "72000",
  trend: 0.1,
  rangeScore: 0.7,
  fundingAvg7d: null,
  fundingPos21: null,
  closes,
  rules: { tickSize: "0.01", stepSize: "0.0001", minQuantity: "0.0001", minNotional: "10" },
  maxLeverage: null,
};

beforeAll(async () => {
  env = await startTestEnv();
  env.reco.markets = [MARKET];
});
afterAll(async () => {
  await env.close();
});

describe("goals and AI parameters", () => {
  it("saves goals and returns a stored plan", async () => {
    const client = new TestClient(env.app);
    await signIn(env, client, "reco1@example.com");
    expect((await client.request("GET", "/api/v1/goals")).json()).toEqual({ goals: null });
    const saved = await client.request("PUT", "/api/v1/goals", {
      body: { goal: "range", capital: "8000", maxDrop: "10", assets: ["BTC", "BTC"] },
    });
    expect(goalsViewSchema.parse(saved.json())).toMatchObject({
      goal: "range",
      capital: "8000",
      assets: ["BTC"],
    });

    const plan = planViewSchema.parse((await client.request("POST", "/api/v1/reco/plan")).json());
    expect(plan.best?.strategy).toBe("spot_grid");
    expect(plan.notes[0]).toContain("fewer than 30 closed positions");
    const { rows } = await env.pool.query<{ n: number }>(
      "select count(*)::int as n from ai_suggestions where id = $1 and context = 'onboarding'",
      [plan.best?.id],
    );
    expect(rows[0]?.n).toBe(1);
    const again = suggestionViewSchema.parse(
      (await client.request("GET", `/api/v1/reco/suggestions/${plan.best?.id ?? ""}`)).json(),
    );
    expect(again.values).toEqual(plan.best?.values);
    const other = new TestClient(env.app);
    await signIn(env, other, "reco1b@example.com");
    expect(
      (await other.request("GET", `/api/v1/reco/suggestions/${plan.best?.id ?? ""}`)).statusCode,
    ).toBe(404);
  });

  it("returns AI parameters for the create screen and lets bots reference them", async () => {
    const client = new TestClient(env.app);
    await signIn(env, client, "reco2@example.com");
    const res = await client.request("POST", "/api/v1/reco/params", {
      body: { strategy: "spot_dca", market: "vBTC_vUSDC", capital: "1000", context: "create" },
    });
    const { suggestion } = z
      .object({ suggestion: suggestionViewSchema.nullable() })
      .parse(res.json());
    expect(suggestion?.values).toMatchObject({
      market: "vBTC_vUSDC",
      stepMultiplier: "1.2",
      sizeMultiplier: "1.5",
    });
    expect(suggestion?.reasons).toHaveLength(3);

    const none = await client.request("POST", "/api/v1/reco/params", {
      body: { strategy: "spot_grid", market: "vETH_vUSDC", capital: "1000", context: "create" },
    });
    expect(none.json()).toEqual({ suggestion: null });
  });

  it("reports RECO_UNAVAILABLE when the engine is down", async () => {
    const client = new TestClient(env.app);
    await signIn(env, client, "reco3@example.com");
    env.reco.down = true;
    try {
      const res = await client.request("POST", "/api/v1/reco/params", {
        body: { strategy: "spot_grid", market: "vBTC_vUSDC", capital: "1000", context: "create" },
      });
      expect(res.statusCode).toBe(503);
      expect(errorOf(res.body).code).toBe("RECO_UNAVAILABLE");
    } finally {
      env.reco.down = false;
    }
  });
});
