import { errorResponseSchema, meSchema, mmMarketCostsSchema, mmMarkoutSchema } from "@drift/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { signIn, startTestEnv, TestClient, type TestEnv } from "./helpers";

// Market Making · chi phí / $1M (DEC-227): bảng xếp hạng market (D1) và markout fill thật của bot (D2).

let env: TestEnv;
const ADDRESS = "0x4E1e4796c10C637EDAB56461450BD8D02EFb29Db";
const errorOf = (body: string) => errorResponseSchema.parse(JSON.parse(body)).error;
const vmConfig = {
  market: "BTC-USD",
  leverage: 1,
  volumeTarget: "100000",
  orderSize: "500",
  distanceBp: "1",
  maxInventory: "2000",
  refreshSeconds: 3,
  runUntil: "target_or_budget",
  costBudget: "300",
  inventoryLossStop: "60",
  onStop: "close_inventory",
};

beforeAll(async () => {
  env = await startTestEnv();
  env.sodex.addPerpSymbol("ETH-USD", { maxLeverage: 10 });
});
afterAll(async () => {
  await env.close();
});

async function connectedUser(email: string) {
  const client = new TestClient(env.app);
  const me = meSchema.parse((await signIn(env, client, email)).json());
  const accountID = Math.floor(Math.random() * 1e9);
  env.sodex.addUser(ADDRESS, accountID);
  await env.pool.query(
    "insert into sodex_accounts (id, user_id, address, sodex_account_id, network, status) values (gen_random_uuid(), $1, $2, $3, 'mainnet', 'connected')",
    [me.id, ADDRESS, accountID],
  );
  return client;
}

const at = (offsetMs: number) => new Date(env.clock.now.getTime() + offsetMs).toISOString();

describe("GET /api/v1/markets/mm-cost (DEC-228)", () => {
  it("estimates the cost for your own bot from the model, blends in your bot, and ranks with suggestions", async () => {
    const client = await connectedUser("mm-rank@example.com");
    // BTC-USD: 800 nến 1m có volume, giá đổi 100 ↔ 100,05 → bước ≈ 1 bps, dao động ≈ 5 bps.
    const values = Array.from(
      { length: 800 },
      (_, i) =>
        `('BTC-USD', '${at((i - 800) * 60_000)}', 100, 100, 100, ${i % 2 ? "100.05" : "100"}, 30)`,
    );
    await env.pool.query(
      `insert into candles_1m (market, ts, open, high, low, close, volume) values ${values.join(",")}`,
    );
    // ETH-USD: đủ 800 nến và phút nào cũng có giao dịch, nhưng chỉ ~$1 / phút → không tính là phút có volume (≥ $50),
    // nên không đủ dữ liệu để tính dao động / chi phí (DEC-228).
    const thin = Array.from(
      { length: 800 },
      (_, i) => `('ETH-USD', '${at((i - 800) * 60_000)}', 1, 1, 1, ${i % 2 ? "1.01" : "1"}, 1)`,
    );
    await env.pool.query(
      `insert into candles_1m (market, ts, open, high, low, close, volume) values ${thin.join(",")}`,
    );
    // Markout công khai chỉ để đối chiếu; một giờ cũ hơn 24 giờ không được cộng.
    for (const [hour, notional, markout] of [
      [-2, "600", "-300"],
      [-1, "400", "-200"],
      [-30, "1000", "-99999"],
    ] as const)
      await env.pool.query(
        "insert into mm_market_hourly (market, hour, notional, markout_notional, trades, spread_ticks) values ('BTC-USD', $1, $2, $3, 10, $4)",
        [at(hour * 3_600_000), notional, markout, JSON.stringify({ "1": 30, "2": 10 })],
      );
    const res = mmMarketCostsSchema.parse(
      (await client.request("GET", "/api/v1/markets/mm-cost")).json(),
    );
    expect(res).toMatchObject({
      makerFeePerMillion: "120",
      builderFeePerMillion: "30",
      modelVersion: 0,
      model: { a: "0.25", k: "0.095" },
      suggested: ["BTC-USD"],
    });
    expect(res.markets.map((m) => m.market)).toEqual(["BTC-USD", "ETH-USD"]);
    const btc = res.markets[0];
    expect(btc).toMatchObject({
      market: "BTC-USD",
      spreadTicks: 1,
      candleMinutes24h: 800,
      activeMinutes24h: 800,
      hoursWithData: 2,
      trades24h: 20,
      notional24h: "1000",
      publicPricePnlPerMillion: "-50",
      source: "model",
      yourRoundTrips: 0,
      tooLittleVolume: false,
      yourBot: false,
    });
    // PnL giá mô hình = 0,25 × ~1 − 0,095 × ~5 ≈ −0,225 bps → −22,5 / $1M; chi phí ≈ 120 + 30 + 22,5.
    expect(Number(btc?.pricePnlPerMillion)).toBeCloseTo(-22.5, 0);
    expect(Number(btc?.totalCostPerMillion)).toBeCloseTo(172.5, 0);
    // Đầu dưới của khoảng: chỉ phí (maker 120 + builder 30).
    expect(btc?.feesPerMillion).toBe("150");
    // Sức chứa = 5% volume 24h (≈ 2,4 triệu).
    expect(Number(btc?.capacityPerDay)).toBeCloseTo(0.05 * Number(btc?.volume24h), -1);
    expect(res.markets[1]).toMatchObject({
      market: "ETH-USD",
      swingBps: null,
      pricePnlPerMillion: null,
      source: null,
      totalCostPerMillion: null,
      candleMinutes24h: 800,
      activeMinutes24h: 0,
      tooLittleVolume: true,
    });

    // Bot của chính người xem: 50 vòng lỗ ~0,5 bps → trộn đều với mô hình, nguồn "yours".
    const made = await client.request("POST", "/api/v1/bots", {
      body: { strategy: "volume_maker", name: "MM", paramSource: "manual", config: vmConfig },
    });
    const id = made.json<{ id: string }>().id;
    for (let k = 0; k < 50; k += 1)
      for (const [side, price, dt] of [
        ["buy", "100", 0],
        ["sell", "99.99", 10_000],
      ] as const) {
        await env.pool.query(
          "with o as (insert into orders (id, bot_id, sodex_account_id, cl_ord_id, market, engine, side, type, time_in_force, size, status, reduce_only, tag, epoch) select gen_random_uuid(), id, sodex_account_id, $2, 'BTC-USD', 'perps', $3, 'limit', 'GTX', 1, 'filled', false, 'x', 1 from bots where id = $1 returning id) insert into fills (id, order_id, sodex_trade_id, price, size, fee, is_maker, filled_at) select gen_random_uuid(), id, $4, $5, '1', '0', true, $6 from o",
          [
            id,
            `rank-${String(k)}-${side}`,
            side,
            770_000 + k * 2 + (side === "buy" ? 0 : 1),
            price,
            at(-3_600_000 + k * 30_000 + dt),
          ],
        );
      }
    const mine = mmMarketCostsSchema.parse(
      (await client.request("GET", "/api/v1/markets/mm-cost")).json(),
    );
    const own = mine.markets.find((m) => m.market === "BTC-USD");
    expect(own).toMatchObject({ source: "yours", yourRoundTrips: 50 });
    // (50 × −0,50 + 50 × −0,225) / 100 ≈ −0,36 bps → −36 / $1M.
    expect(Number(own?.pricePnlPerMillion)).toBeCloseTo(-36.25, 0);
    // Người khác không thấy số của bot này.
    const other = await connectedUser("mm-rank-other@example.com");
    const theirs = mmMarketCostsSchema.parse(
      (await other.request("GET", "/api/v1/markets/mm-cost")).json(),
    );
    expect(theirs.markets.find((m) => m.market === "BTC-USD")?.source).toBe("model");
  });

  it("needs a session", async () => {
    const res = await new TestClient(env.app).request("GET", "/api/v1/markets/mm-cost");
    expect(res.statusCode).toBe(401);
  });
});

describe("GET /api/v1/bots/:id/mm-markout (D2)", () => {
  it("measures the bot's own fills against the mid after 5 / 30 / 60 s and counts losing round trips", async () => {
    const client = await connectedUser("mm-markout@example.com");
    const made = await client.request("POST", "/api/v1/bots", {
      body: { strategy: "volume_maker", name: "MM", paramSource: "manual", config: vmConfig },
    });
    const id = made.json<{ id: string }>().id;
    const order = async (side: "buy" | "sell") =>
      (
        await env.pool.query<{ id: string }>(
          "insert into orders (id, bot_id, sodex_account_id, cl_ord_id, market, engine, side, type, time_in_force, size, status, reduce_only, tag, epoch) select gen_random_uuid(), $1, sodex_account_id, 'mm-' || $2, 'BTC-USD', 'perps', $2, 'limit', 'GTX', 1, 'filled', false, 'x', 1 from bots where id = $1 returning id",
          [id, side],
        )
      ).rows[0]?.id;
    const buy = await order("buy");
    const sell = await order("sell");
    const t0 = -600_000;
    // Mua 100 rồi bán 99,99: một vòng đóng lỗ. Giá giữa đứng yên ở 100,01.
    await env.pool.query(
      "insert into fills (id, order_id, sodex_trade_id, price, size, fee, is_maker, filled_at) values (gen_random_uuid(), $1, 990001, '100', '1', '0.01', true, $2), (gen_random_uuid(), $3, 990002, '99.99', '1', '0.01', true, $4)",
      [buy, at(t0), sell, at(t0 + 10_000)],
    );
    for (let s = -2; s <= 90; s += 1)
      await env.pool.query(
        "insert into mid_1s (market, ts, mid) values ('BTC-USD', $1, '100.01')",
        [at(t0 + s * 1000)],
      );
    const res = mmMarkoutSchema.parse(
      (await client.request("GET", `/api/v1/bots/${id}/mm-markout`)).json(),
    );
    expect(res).toMatchObject({
      market: "BTC-USD",
      fills: 2,
      stepBps: "1",
      roundTrips: { losing: 1, total: 1 },
      inShort: false,
    });
    // Mua 100 → +1 bps; bán 99,99 → −2 bps (theo notional): trung bình ≈ −0,5.
    expect(res.markout.s30).toBe("-0.5");
    expect(res.markout.s5).toBe(res.markout.s30);
    expect(res.markout.s60).toBe(res.markout.s30);

    const other = await connectedUser("mm-markout-other@example.com");
    expect((await other.request("GET", `/api/v1/bots/${id}/mm-markout`)).statusCode).toBe(404);
  });

  it("is only for Market Making bots", async () => {
    const client = await connectedUser("mm-markout-grid@example.com");
    const made = await client.request("POST", "/api/v1/bots", {
      body: {
        strategy: "spot_grid",
        name: "Grid",
        paramSource: "manual",
        config: {
          market: "vBTC_vUSDC",
          lowerPrice: "90",
          upperPrice: "110",
          gridLevels: 5,
          spacing: "arithmetic",
          investment: "500",
          maxLoss: "100",
          onStop: "keep_base",
        },
      },
    });
    const res = await client.request(
      "GET",
      `/api/v1/bots/${made.json<{ id: string }>().id}/mm-markout`,
    );
    expect(errorOf(res.body).code).toBe("NOT_FOUND");
  });
});
