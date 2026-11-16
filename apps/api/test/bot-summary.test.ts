import { randomBytes } from "node:crypto";

import { botListSchema, meSchema } from "@drift/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { botSummaryLine } from "../src/modules/bots/summary-line";

import { signIn, startTestEnv, TestClient, type TestEnv } from "./helpers";

// Tóm tắt cấu hình một dòng trên danh sách bot (bộ chọn bot của Trading Agent, DEC-TBD-agent-selector): server tạo
// từ config đang chạy, theo chiến lược; không tạo được thì null (UI chỉ hiện capital).

const mm = (over: Record<string, unknown> = {}) => ({
  market: "BTC-USD",
  orderSize: "50",
  leverage: 5,
  costBudget: "10",
  maxOrders: 1,
  refreshSeconds: 3,
  runUntil: "target_or_budget",
  onStop: "close_inventory",
  ...over,
});
const farm = (over: Record<string, unknown> = {}) => ({
  market: "BTC-USD",
  leverage: 20,
  marginMode: "isolated",
  orderSizeMinUsd: "100",
  orderSizeMaxUsd: "200",
  minHoldSecs: 120,
  maxHoldSecs: 180,
  maxLoss: "20",
  ...over,
});
const grid = {
  market: "vBTC_vUSDC",
  lowerPrice: "90",
  upperPrice: "110",
  gridLevels: 5,
  spacing: "arithmetic",
  investment: "1000",
  maxLoss: "100",
  onStop: "keep_base",
};

describe("botSummaryLine", () => {
  it("Market Making: order size · distance · Smart quoting when on", () => {
    expect(botSummaryLine("volume_maker", mm({ distanceBp: "1", smartQuoting: true }))).toBe(
      "$50 · 1 bp · Smart quoting",
    );
    expect(botSummaryLine("volume_maker", mm({ distanceBp: "2.5" }))).toBe("$50 · 2.5 bp");
    // distanceBp thiếu: mặc định 1 bp như engine.
    expect(botSummaryLine("volume_maker", mm())).toBe("$50 · 1 bp");
  });

  it("Market Making quoting on the order book shows steps back instead of bp", () => {
    expect(botSummaryLine("volume_maker", mm({ quoteLevel: 0, smartQuoting: true }))).toBe(
      "$50 · At best price · Smart quoting",
    );
    expect(botSummaryLine("volume_maker", mm({ quoteLevel: 1 }))).toBe("$50 · 1 step back");
    expect(botSummaryLine("volume_maker", mm({ quoteLevel: 3, orderSize: "1250.456" }))).toBe(
      "$1,250.46 · 3 steps back",
    );
  });

  it("Volume Builder: order size range · leverage", () => {
    expect(botSummaryLine("volume_farm", farm())).toBe("$100–$200 · 20×");
    expect(botSummaryLine("volume_farm", farm({ orderSizeMaxUsd: "100", leverage: 3 }))).toBe(
      "$100 · 3×",
    );
  });

  it("other strategies: capital in quote", () => {
    expect(botSummaryLine("spot_grid", grid)).toBe("$1,000");
  });

  it("null when it cannot be built", () => {
    expect(botSummaryLine("volume_maker", null)).toBeNull();
    expect(botSummaryLine("volume_maker", { market: "BTC-USD" })).toBeNull();
    expect(botSummaryLine("volume_farm", farm({ orderSizeMinUsd: undefined }))).toBeNull();
    expect(botSummaryLine("spot_grid", { market: "vBTC_vUSDC" })).toBeNull();
    // TWAP: vốn theo base, UI hiện capital như cũ.
    expect(
      botSummaryLine("twap", {
        market: "vBTC_vUSDC",
        side: "buy",
        totalSize: "0.5",
        durationMinutes: 60,
        slices: 6,
      }),
    ).toBeNull();
  });

  it("is deterministic", () => {
    const c = mm({ distanceBp: "1", smartQuoting: true });
    expect(botSummaryLine("volume_maker", c)).toBe(botSummaryLine("volume_maker", c));
  });
});

describe("summary on GET /api/v1/bots", () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await startTestEnv();
  });
  afterAll(async () => {
    await env.close();
  });

  it("comes from the active version of each bot", async () => {
    const client = new TestClient(env.app);
    const me = meSchema.parse((await signIn(env, client, "bot-summary@example.test")).json());
    const acc =
      (
        await env.pool.query<{ id: string }>(
          "insert into sodex_accounts (id, user_id, address, sodex_account_id, network, status) values (gen_random_uuid(), $1, $2, $3, 'mainnet', 'disconnected') returning id",
          [me.id, `0x${randomBytes(20).toString("hex")}`, Math.floor(Math.random() * 1e9)],
        )
      ).rows[0]?.id ?? "";
    const seed = async (
      name: string,
      strategy: string,
      market: string,
      engine: string,
      versions: Record<string, unknown>[],
    ) => {
      const bot =
        (
          await env.pool.query<{ id: string }>(
            "insert into bots (id, user_id, sodex_account_id, strategy, market, engine, name, state) values (gen_random_uuid(), $1, $2, $3, $4, $5, $6, 'stopped') returning id",
            [me.id, acc, strategy, market, engine, name],
          )
        ).rows[0]?.id ?? "";
      let active = "";
      for (const [i, config] of versions.entries())
        active =
          (
            await env.pool.query<{ id: string }>(
              "insert into bot_versions (id, bot_id, version, config, param_source, status, applied_at) values (gen_random_uuid(), $1, $2, $3, 'manual', $4, now()) returning id",
              [
                bot,
                i + 1,
                JSON.stringify(config),
                i === versions.length - 1 ? "active" : "superseded",
              ],
            )
          ).rows[0]?.id ?? "";
      await env.pool.query("update bots set active_version_id = $2 where id = $1", [bot, active]);
      return bot;
    };
    // Version cũ 3 bp, version đang chạy 1 bp + Smart quoting: dùng version đang chạy.
    const mmBot = await seed("MM", "volume_maker", "BTC-USD", "perps", [
      mm({ distanceBp: "3" }),
      mm({ distanceBp: "1", smartQuoting: true }),
    ]);
    const farmBot = await seed("Farm", "volume_farm", "BTC-USD", "perps", [farm()]);
    const gridBot = await seed("Grid", "spot_grid", "vBTC_vUSDC", "spot", [grid]);
    const badBot = await seed("Bad", "volume_maker", "BTC-USD", "perps", [{ market: "BTC-USD" }]);

    const res = await client.request("GET", "/api/v1/bots");
    expect(res.statusCode).toBe(200);
    const items = botListSchema.parse(res.json()).items;
    const by = (id: string) => items.find((b) => b.id === id)?.summary;
    expect(by(mmBot)).toBe("$50 · 1 bp · Smart quoting");
    expect(by(farmBot)).toBe("$100–$200 · 20×");
    expect(by(gridBot)).toBe("$1,000");
    expect(by(badBot)).toBeNull();
  });
});
