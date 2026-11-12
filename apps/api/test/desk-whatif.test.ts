import {
  botSummarySchema,
  deskHomeViewSchema,
  errorResponseSchema,
  meSchema,
  needsYouViewSchema,
  whatIfApplyViewSchema,
  whatIfViewSchema,
} from "@drift/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { signIn, startTestEnv, TestClient, type TestEnv } from "./helpers";

// AI Desk B+ M2 (DEC-166): so sánh phương án và Apply thành version "AI suggested". Worker `backtest` không chạy trong
// test: kết quả được ghi thẳng vào `desk_whatifs` như worker sẽ ghi.

let env: TestEnv;
const ADDRESS = "0x5b3C8b7a1F2D3C4B5A69788766554433221100Cd";
const errorOf = (body: unknown) => errorResponseSchema.parse(body).error;
const farm = {
  market: "BTC-USD",
  leverage: 5,
  marginMode: "cross",
  orderSizeMinUsd: "100",
  orderSizeMaxUsd: "200",
  minHoldSecs: 120,
  maxHoldSecs: 180,
  tpUsd: "0.5",
  slPct: "5",
  earlyProfitUsd: "0.15",
  maxLoss: "20",
};
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
const best = {
  earlyProfitFees: 3,
  earlyExitSecs: 60,
  minHoldSecs: 180,
  maxHoldSecs: 300,
  slMarginPct: 50,
};
const review = {
  status: "done",
  trades: 120,
  from: 0,
  to: 1,
  volume: 50000,
  actual: {
    costPerMillion: 320,
    feesPerMillion: 300,
    builderPerMillion: 10,
    pricePerMillion: 20,
    winRatePct: 40,
  },
  current: { params: { ...best, slMarginPct: 25 }, costPerMillion: 320, winRatePct: 40 },
  best: {
    params: best,
    costPerMillion: 250,
    winRatePct: 45,
    deltaPerMillion: -70,
    ciLow: -90,
    ciHigh: -10,
    inSample: 255,
    outOfSample: 248,
    currentInSample: 318,
    currentOutOfSample: 322,
  },
  recommended: true,
  suggestion: "strong",
  tested: 135,
  takerShare: { trades: 10, takerCostPerMillion: 400, makerCostPerMillion: 300 },
};

beforeAll(async () => {
  env = await startTestEnv();
});
afterAll(async () => {
  await env.close();
});

async function deskUser(email: string) {
  const client = new TestClient(env.app);
  const me = meSchema.parse((await signIn(env, client, email)).json());
  await env.pool.query("update users set ai_desk = true where id = $1", [me.id]);
  const accountID = Math.floor(Math.random() * 1e9);
  env.sodex.addUser(ADDRESS, accountID);
  await env.pool.query(
    "insert into sodex_accounts (id, user_id, address, sodex_account_id, network, status) values (gen_random_uuid(), $1, $2, $3, 'mainnet', 'connected')",
    [me.id, ADDRESS, accountID],
  );
  return { client, userId: me.id };
}

async function bot(
  client: TestClient,
  strategy: string,
  config: Record<string, unknown>,
  name: string,
) {
  const made = await client.request("POST", "/api/v1/bots", {
    body: { strategy, name, paramSource: "manual", config },
  });
  return botSummarySchema.parse(made.json()).id;
}

const items = async (client: TestClient) =>
  needsYouViewSchema.parse((await client.request("GET", "/api/v1/desk/needs-you")).json()).items;

/** Ghi kết quả như worker `backtest` sẽ ghi sau khi replay. */
async function finishWhatif(id: string, nets: Record<string, string | null>) {
  const { rows } = await env.pool.query<{ options: { key: string; patch: unknown }[] }>(
    "select options from desk_whatifs where id = $1",
    [id],
  );
  const options = (rows[0]?.options ?? []).map((o) => {
    const net = nets[o.key] ?? null;
    return {
      ...o,
      outcome:
        net === null
          ? null
          : { trades: 120, net, closedBySodex: 0, worstTrade: "-1.2", marginPerTrade: "40" },
      unavailable: net === null ? "not_enough_trades" : null,
    };
  });
  await env.pool.query(
    "update desk_whatifs set status = 'done', source = 'replay', options = $2, finished_at = now() where id = $1",
    [id, JSON.stringify(options)],
  );
}

describe("what-if and Apply", () => {
  it("compares keep against the review's settings, reuses a fresh job, and applies as an AI version", async () => {
    const { client } = await deskUser("whatif-review@example.com");
    const botId = await bot(client, "volume_farm", farm, "BTC Farm");
    await env.pool.query("update bots set state = 'running' where id = $1", [botId]);
    await env.pool.query(
      "insert into bot_reviews (id, bot_id, user_id, status, result, finished_at) select gen_random_uuid(), $1, user_id, 'done', $2, now() from bots where id = $1",
      [botId, JSON.stringify(review)],
    );
    const [item] = await items(client);
    expect(item?.rule).toBe("better_review");

    const started = whatIfViewSchema.parse(
      (await client.request("POST", `/api/v1/desk/needs-you/${item?.id ?? ""}/whatif`)).json(),
    );
    expect(started).toMatchObject({ status: "queued", rule: "better_review", pick: null });
    expect(started.options.map((o) => o.key)).toEqual(["keep", "review_settings"]);
    const { rows: queued } = await env.pool.query<{ n: number }>(
      "select count(*)::int as n from outbox where topic = 'backtest.run' and payload->>'whatifId' = $1",
      [started.id],
    );
    expect(queued[0]?.n).toBe(1);
    // Bấm Compare lần nữa: dùng lại job, không xếp thêm.
    const again = whatIfViewSchema.parse(
      (await client.request("POST", `/api/v1/desk/needs-you/${item?.id ?? ""}/whatif`)).json(),
    );
    expect(again.id).toBe(started.id);

    // Chưa xong thì không Apply được.
    const early = await client.request("POST", `/api/v1/desk/whatifs/${started.id}/apply`, {
      body: { option: "review_settings" },
    });
    expect(errorOf(early.json()).details).toMatchObject({ reason: "not_done" });

    await finishWhatif(started.id, { keep: "-4.95", review_settings: "-3.10" });
    const done = whatIfViewSchema.parse(
      (await client.request("GET", `/api/v1/desk/whatifs/${started.id}`)).json(),
    );
    expect(done.pick).toEqual({ key: "review_settings", reason: "better_result" });
    expect(done.options.find((o) => o.key === "review_settings")?.outcome?.net).toBe("-3.10");

    const applied = await client.request("POST", `/api/v1/desk/whatifs/${started.id}/apply`, {
      body: { option: "review_settings" },
    });
    expect(applied.statusCode).toBe(201);
    const a = whatIfApplyViewSchema.parse(applied.json());
    expect(a).toMatchObject({ botId, version: 2, status: "pending", option: "review_settings" });
    const { rows: versions } = await env.pool.query<{
      config: Record<string, unknown>;
      param_source: string;
    }>("select config, param_source from bot_versions where bot_id = $1 and version = 2", [botId]);
    expect(versions[0]?.param_source).toBe("ai");
    expect(versions[0]?.config).toMatchObject({
      slMarginPct: "50",
      earlyExitSecs: 60,
      maxHoldSecs: 300,
    });
    expect(versions[0]?.config).not.toHaveProperty("slPct");
    const { rows: applies } = await env.pool.query<{
      from_version: number;
      to_version: number;
      option: string;
    }>("select from_version, to_version, option from desk_applies where whatif_id = $1", [
      started.id,
    ]);
    expect(applies).toEqual([{ from_version: 1, to_version: 2, option: "review_settings" }]);

    // Apply lần hai cho cùng so sánh: chặn.
    const twice = await client.request("POST", `/api/v1/desk/whatifs/${started.id}/apply`, {
      body: { option: "review_settings" },
    });
    expect(errorOf(twice.json()).details).toMatchObject({ reason: "applied" });
  });

  it("does not queue a job when there is no concrete fix, and refuses options without a result", async () => {
    const { client } = await deskUser("whatif-nofix@example.com");
    const botId = await bot(client, "futures_grid", grid, "ETH Grid");
    await env.pool.query(
      "update bots set state = 'paused', reason_code = 'BOT_MAX_LOSS' where id = $1",
      [botId],
    );
    const [item] = await items(client);
    const w = whatIfViewSchema.parse(
      (await client.request("POST", `/api/v1/desk/needs-you/${item?.id ?? ""}/whatif`)).json(),
    );
    expect(w).toMatchObject({ status: "unavailable", error: "no_fix" });
    expect(w.options.map((o) => o.key)).toEqual(["keep"]);
    const { rows } = await env.pool.query<{ n: number }>(
      "select count(*)::int as n from outbox where payload->>'whatifId' = $1",
      [w.id],
    );
    expect(rows[0]?.n).toBe(0);
  });

  it("refuses to apply after the bot's settings changed, or an option with no result", async () => {
    const { client } = await deskUser("whatif-changed@example.com");
    const botId = await bot(client, "volume_farm", farm, "SOL Farm");
    await env.pool.query("update bots set state = 'running' where id = $1", [botId]);
    await env.pool.query(
      "insert into bot_reviews (id, bot_id, user_id, status, result, finished_at) select gen_random_uuid(), $1, user_id, 'done', $2, now() from bots where id = $1",
      [botId, JSON.stringify(review)],
    );
    const [item] = await items(client);
    const w = whatIfViewSchema.parse(
      (await client.request("POST", `/api/v1/desk/needs-you/${item?.id ?? ""}/whatif`)).json(),
    );
    await finishWhatif(w.id, { keep: "-4", review_settings: null });
    const none = await client.request("POST", `/api/v1/desk/whatifs/${w.id}/apply`, {
      body: { option: "review_settings" },
    });
    expect(errorOf(none.json()).details).toMatchObject({ reason: "no_result" });

    await finishWhatif(w.id, { keep: "-4", review_settings: "-2" });
    // User tự sửa bot (version 2 thành version đang dùng) sau khi so sánh.
    const { rows } = await env.pool.query<{ id: string }>(
      "insert into bot_versions (id, bot_id, version, config, param_source, status, applied_at) values (gen_random_uuid(), $1, 2, $2, 'manual', 'active', now()) returning id",
      [botId, JSON.stringify(farm)],
    );
    await env.pool.query("update bots set active_version_id = $2 where id = $1", [
      botId,
      rows[0]?.id,
    ]);
    const changed = await client.request("POST", `/api/v1/desk/whatifs/${w.id}/apply`, {
      body: { option: "review_settings" },
    });
    expect(errorOf(changed.json()).details).toMatchObject({ reason: "version_changed" });
  });

  it("applies once when Apply is pressed twice at the same time, and frees the slot when the version fails", async () => {
    const { client } = await deskUser("whatif-race@example.com");
    const botId = await bot(client, "volume_farm", farm, "ETH Farm");
    await env.pool.query("update bots set state = 'running' where id = $1", [botId]);
    await env.pool.query(
      "insert into bot_reviews (id, bot_id, user_id, status, result, finished_at) select gen_random_uuid(), $1, user_id, 'done', $2, now() from bots where id = $1",
      [botId, JSON.stringify(review)],
    );
    const [item] = await items(client);
    const w = whatIfViewSchema.parse(
      (await client.request("POST", `/api/v1/desk/needs-you/${item?.id ?? ""}/whatif`)).json(),
    );
    await finishWhatif(w.id, { keep: "-4", review_settings: "-2" });
    const applyCount = async () =>
      (
        await env.pool.query<{ n: number }>(
          "select count(*)::int as n from desk_applies where whatif_id = $1",
          [w.id],
        )
      ).rows[0]?.n;

    // Phương án có patch không hợp lệ: version mới bị từ chối, chỗ giữ được xoá.
    const { rows } = await env.pool.query<{ options: { key: string; patch: unknown }[] }>(
      "select options from desk_whatifs where id = $1",
      [w.id],
    );
    const good = rows[0]?.options ?? [];
    await env.pool.query("update desk_whatifs set options = $2 where id = $1", [
      w.id,
      JSON.stringify(
        good.map((o) => (o.key === "review_settings" ? { ...o, patch: { leverage: 0 } } : o)),
      ),
    ]);
    const bad = await client.request("POST", `/api/v1/desk/whatifs/${w.id}/apply`, {
      body: { option: "review_settings" },
    });
    expect(bad.statusCode).toBeGreaterThanOrEqual(400);
    expect(await applyCount()).toBe(0);
    await env.pool.query("update desk_whatifs set options = $2 where id = $1", [
      w.id,
      JSON.stringify(good),
    ]);

    // Lần bấm kia đã giữ chỗ nhưng chưa commit: lần này phải chờ ở unique index rồi dừng, không tạo version thứ hai.
    const other = await env.pool.connect();
    try {
      await other.query("begin");
      await other.query(
        "insert into desk_applies (id, whatif_id, user_id, bot_id, rule, option, from_version, baseline_config, applied_at) select gen_random_uuid(), id, user_id, bot_id, 'better_review', 'review_settings', 1, '{}', now() from desk_whatifs where id = $1",
        [w.id],
      );
      const pending = client.request("POST", `/api/v1/desk/whatifs/${w.id}/apply`, {
        body: { option: "review_settings" },
      });
      // Chờ tới khi request bị chặn bởi khoá của transaction kia.
      for (let i = 0; i < 100; i += 1) {
        const { rows: waiting } = await env.pool.query<{ n: number }>(
          "select count(*)::int as n from pg_locks where not granted",
        );
        if ((waiting[0]?.n ?? 0) > 0) break;
        await new Promise((r) => setTimeout(r, 20));
      }
      await other.query("commit");
      const second = await pending;
      expect(second.statusCode).toBe(409);
      expect(errorOf(second.json()).details).toMatchObject({ reason: "applied" });
    } finally {
      other.release();
    }
    const { rows: versions } = await env.pool.query<{ version: number }>(
      "select version from bot_versions where bot_id = $1 order by version",
      [botId],
    );
    expect(versions.map((r) => r.version)).toEqual([1]);
    expect(await applyCount()).toBe(1);
  });

  it("shows the latest comparison of each item on the home page, with each option in words", async () => {
    const { client } = await deskUser("whatif-home@example.com");
    const botId = await bot(client, "volume_farm", farm, "BTC Home Farm");
    await env.pool.query("update bots set state = 'running' where id = $1", [botId]);
    await env.pool.query(
      "insert into bot_reviews (id, bot_id, user_id, status, result, finished_at) select gen_random_uuid(), $1, user_id, 'done', $2, now() from bots where id = $1",
      [botId, JSON.stringify(review)],
    );
    const home = async () =>
      deskHomeViewSchema.parse((await client.request("GET", "/api/v1/desk/home")).json());
    const first = await home();
    expect(first.items).toHaveLength(1);
    expect(first.items[0]?.whatif).toBeNull();
    expect(first.bots.map((b) => b.health)).toEqual(["needs_you"]);

    const started = whatIfViewSchema.parse(
      (
        await client.request("POST", `/api/v1/desk/needs-you/${first.items[0]?.id ?? ""}/whatif`)
      ).json(),
    );
    expect(started.bot).toMatchObject({ name: "BTC Home Farm", strategy: "volume_farm" });
    expect(started.options.map((o) => o.display?.leverage)).toEqual([5, 5]);
    await finishWhatif(started.id, { keep: "-4.95", review_settings: "-3.10" });
    const after = await home();
    expect(after.items[0]?.whatif).toMatchObject({
      id: started.id,
      status: "done",
      pick: { key: "review_settings", reason: "better_result" },
    });

    // Bot đổi version: so sánh cũ không còn đúng, trang chủ không hiện nữa.
    const { rows } = await env.pool.query<{ id: string }>(
      "insert into bot_versions (id, bot_id, version, config, param_source, status, applied_at) values (gen_random_uuid(), $1, 2, $2, 'manual', 'active', now()) returning id",
      [botId, JSON.stringify(farm)],
    );
    await env.pool.query("update bots set active_version_id = $2 where id = $1", [
      botId,
      rows[0]?.id,
    ]);
    expect((await home()).items[0]?.whatif ?? null).toBeNull();
  });

  it("never applies keep and hides comparisons of other users", async () => {
    const { client } = await deskUser("whatif-other@example.com");
    const keep = await client.request(
      "POST",
      "/api/v1/desk/whatifs/00000000-0000-4000-8000-000000000000/apply",
      {
        body: { option: "keep" },
      },
    );
    expect(errorOf(keep.json()).code).toBe("VALIDATION_FAILED");
    const other = await client.request(
      "GET",
      "/api/v1/desk/whatifs/00000000-0000-4000-8000-000000000000",
    );
    expect(errorOf(other.json()).code).toBe("NOT_FOUND");
  });
});
