import {
  botSummarySchema,
  errorResponseSchema,
  meSchema,
  needsYouViewSchema,
  snoozeViewSchema,
  type MarginTier,
} from "@drift/shared";
import type { ReviewFill } from "@drift/strategies";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { stopCheckOf, takerStats } from "../src/modules/desk/needs-you";

import { signIn, startTestEnv, TestClient, type TestEnv } from "./helpers";

// AI Desk B+ M1 (DEC-164, DEC-166): việc "Needs you", hoãn 7 ngày, sức khoẻ bot.

let env: TestEnv;
const ADDRESS = "0x7a3C8b7a1F2D3C4B5A69788766554433221100Ab";
const errorOf = (body: unknown) => errorResponseSchema.parse(body).error;
const TIERS: MarginTier[] = [
  {
    maxNotionalValue: "4000000",
    maintenanceMarginRate: "0.0125",
    maxLeverage: 40,
    maintenanceDeduction: "0",
  },
];
const grid = {
  market: "BTC-USD",
  leverage: 10,
  marginMode: "isolated",
  direction: "long",
  lowerPrice: "90",
  upperPrice: "110",
  gridLevels: 4,
  spacing: "arithmetic",
  margin: "20",
  stopBelow: "80",
  maxLoss: "2",
  onStop: "close_at_market",
};

beforeAll(async () => {
  env = await startTestEnv();
});
afterAll(async () => {
  await env.close();
});

async function deskUser(email: string, desk = true) {
  const client = new TestClient(env.app);
  const me = meSchema.parse((await signIn(env, client, email)).json());
  if (desk) await env.pool.query("update users set ai_desk = true where id = $1", [me.id]);
  const accountID = Math.floor(Math.random() * 1e9);
  env.sodex.addUser(ADDRESS, accountID);
  const { rows } = await env.pool.query<{ id: string }>(
    "insert into sodex_accounts (id, user_id, address, sodex_account_id, network, status) values (gen_random_uuid(), $1, $2, $3, 'mainnet', 'connected') returning id",
    [me.id, ADDRESS, accountID],
  );
  return { client, userId: me.id, accountId: rows[0]?.id ?? "" };
}

const view = async (client: TestClient) =>
  needsYouViewSchema.parse((await client.request("GET", "/api/v1/desk/needs-you")).json());

describe("Needs you", () => {
  it("is only for accounts with AI Desk", async () => {
    const { client } = await deskUser("needs-off@example.com", false);
    expect(errorOf((await client.request("GET", "/api/v1/desk/needs-you")).json()).code).toBe(
      "FORBIDDEN",
    );
  });

  it("raises a review item when a bot stopped at its max loss, snoozes it, and brings it back on a new stop", async () => {
    const { client } = await deskUser("needs-maxloss@example.com");
    const made = await client.request("POST", "/api/v1/bots", {
      body: { strategy: "futures_grid", name: "ETH Grid", paramSource: "manual", config: grid },
    });
    const botId = botSummarySchema.parse(made.json()).id;
    await env.pool.query("update bots set state = 'running' where id = $1", [botId]);
    const healthy = await view(client);
    expect(healthy.items).toEqual([]);
    expect(healthy.bots).toEqual([
      expect.objectContaining({ botId, health: "healthy", state: "running" }),
    ]);

    await env.pool.query(
      "update bots set state = 'paused', reason_code = 'BOT_MAX_LOSS', updated_at = now() - interval '1 hour' where id = $1",
      [botId],
    );
    const stopped = await view(client);
    expect(stopped.items.map((i) => [i.botName, i.rule])).toEqual([["ETH Grid", "max_loss_hit"]]);
    expect(stopped.items[0]?.facts.find((f) => f.name === "maxLoss")).toMatchObject({
      value: "2",
      source: "config",
    });
    expect(stopped.bots[0]?.health).toBe("needs_you");

    const id = stopped.items[0]?.id ?? "";
    const later = snoozeViewSchema.parse(
      (await client.request("POST", `/api/v1/desk/needs-you/${id}/later`)).json(),
    );
    expect(later.rule).toBe("max_loss_hit");
    const snoozed = await view(client);
    expect(snoozed.items).toEqual([]);
    // Bot vẫn cần người dùng xem, dù việc đang hoãn.
    expect(snoozed.bots[0]?.health).toBe("needs_you");

    // Chạy lại rồi dừng lần nữa ở max loss: dữ liệu mới → hiện lại.
    await env.pool.query("update bots set updated_at = now() where id = $1", [botId]);
    expect((await view(client)).items.map((i) => i.rule)).toEqual(["max_loss_hit"]);

    // Bot chạy lại: việc không còn đúng → biến mất và được đánh dấu đã xong.
    await env.pool.query("update bots set state = 'running', reason_code = null where id = $1", [
      botId,
    ]);
    expect((await view(client)).items).toEqual([]);
    const { rows } = await env.pool.query<{ resolved_at: Date | null }>(
      "select resolved_at from desk_items where bot_id = $1",
      [botId],
    );
    expect(rows[0]?.resolved_at).not.toBeNull();
  });

  it("refuses to snooze an item of another user", async () => {
    const { client } = await deskUser("needs-other@example.com");
    const r = await client.request(
      "POST",
      "/api/v1/desk/needs-you/00000000-0000-4000-8000-000000000000/later",
    );
    expect(errorOf(r.json()).code).toBe("NOT_FOUND");
  });
});

describe("facts for the rules", () => {
  it("reads the stop distance from each strategy's config, and skips strategies without a price stop", () => {
    // Lệnh mua cao nhất 110, stop 80: 27.27%.
    expect(stopCheckOf("futures_grid", grid, TIERS)).toMatchObject({
      side: "long",
      leverage: 10,
      marginMode: "isolated",
      notional: "200",
    });
    expect(stopCheckOf("futures_grid", grid, TIERS)?.stopDistance.slice(0, 6)).toBe("0.2727");
    const farm = {
      market: "BTC-USD",
      leverage: 40,
      marginMode: "isolated",
      orderSizeMinUsd: "100",
      orderSizeMaxUsd: "200",
      minHoldSecs: 120,
      maxHoldSecs: 180,
      tpUsd: "0.5",
      slPct: "2.5",
      earlyProfitUsd: "0.15",
      maxLoss: "20",
    };
    expect(stopCheckOf("volume_farm", farm, TIERS)).toMatchObject({
      side: "both",
      stopDistance: "0.025",
    });
    expect(stopCheckOf("volume_farm", farm, undefined)).toBeNull();
    expect(stopCheckOf("spot_grid", { market: "vBTC_vUSDC" }, TIERS)).toBeNull();
  });

  it("splits Volume Farm turns into maker and taker groups like DEC-130", () => {
    const f = (
      tag: string,
      side: "buy" | "sell",
      price: number,
      isMaker: boolean,
      at: number,
    ): ReviewFill => ({
      tag,
      side,
      price,
      size: 1,
      fee: 0.02,
      builderFee: 0,
      isMaker,
      at,
    });
    const s = takerStats([
      f("vf:1:in:1", "buy", 100, true, 1),
      f("vf:1:out:1", "sell", 100, true, 2),
      f("vf:2:in:1", "buy", 100, false, 3),
      f("vf:2:out:1", "sell", 100, true, 4),
    ]);
    expect(s).toMatchObject({ trades: 2, takerTrades: 1 });
    // (0.04 phí − 0 lãi giá) ÷ 200 volume × 1e6 = 200 mỗi nhóm.
    expect(Math.round(s.takerCostPerMillion ?? 0)).toBe(200);
    expect(Math.round(s.makerCostPerMillion ?? 0)).toBe(200);
  });
});
