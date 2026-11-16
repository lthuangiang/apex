import { randomUUID } from "node:crypto";

import { errorResponseSchema, meSchema, teamOpsViewSchema } from "@drift/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { signIn, startTestEnv, TestClient, type TestEnv } from "./helpers";

// Trang Bot Monitor (tên cũ Ops; docs/mockups/ops, DEC-TBD-ops-redesign): phạm vi Active / All bots, nhãn, Cost / $1M
// 24 giờ (công thức Market hours) và quyền team. Mỗi test tạo user riêng và chỉ xét bot của user đó (DB dùng chung).

let env: TestEnv;
beforeAll(async () => {
  env = await startTestEnv();
});
afterAll(async () => {
  await env.close();
});

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const errorOf = (body: string) => errorResponseSchema.parse(JSON.parse(body)).error;

async function teamUser() {
  const client = new TestClient(env.app);
  const me = meSchema.parse((await signIn(env, client, `bm-${randomUUID()}@drift.test`)).json());
  await env.pool.query("update users set role = 'team' where id = $1", [me.id]);
  const { rows } = await env.pool.query<{ id: string }>(
    "insert into sodex_accounts (id, user_id, address, sodex_account_id, network, status) values (gen_random_uuid(), $1, $2, $3, 'mainnet', 'connected') returning id",
    [me.id, "0x4E1e4796c10C637EDAB56461450BD8D02EFb29Db", Math.floor(Math.random() * 1e9)],
  );
  return { client, userId: me.id, accountId: rows[0]?.id ?? "" };
}

const at = (ago: number) => new Date(env.clock.now.getTime() - ago);

async function view(client: TestClient, query = "") {
  const res = await client.request("GET", `/api/v1/admin/ops${query}`);
  expect(res.statusCode).toBe(200);
  return teamOpsViewSchema.parse(res.json());
}

describe("GET /api/v1/admin/ops · Bot Monitor", () => {
  it("is for the team only: 401 signed out, 403 for users, 200 for the team", async () => {
    expect((await new TestClient(env.app).request("GET", "/api/v1/admin/ops")).statusCode).toBe(
      401,
    );
    const client = new TestClient(env.app);
    const me = meSchema.parse((await signIn(env, client, `bm-${randomUUID()}@drift.test`)).json());
    const denied = await client.request("GET", "/api/v1/admin/ops");
    expect(denied.statusCode).toBe(403);
    expect(errorOf(denied.body)).toMatchObject({
      code: "FORBIDDEN",
      message: "Bot Monitor is for the DeskLabs team only.",
    });
    // Kiểm quyền trước khi parse: tham số sai vẫn là 403 với người ngoài team.
    expect((await client.request("GET", "/api/v1/admin/ops?show=bogus")).statusCode).toBe(403);
    await env.pool.query("update users set role = 'team' where id = $1", [me.id]);
    expect((await client.request("GET", "/api/v1/admin/ops?show=bogus")).statusCode).toBe(400);
    const v = await view(client);
    expect(v.show).toBe("active");
    expect(v.page).toBeNull();
  });

  it("Active: running / paused / stopping plus stopped or archived in 7 days (outbox), never paper or draft; All bots shows the rest, paged", async () => {
    const { client, userId, accountId } = await teamUser();
    const bot = async (
      name: string,
      state: string,
      opts: { strategy?: string; mode?: string; updatedAgo?: number } = {},
    ) => {
      const { rows } = await env.pool.query<{ id: string }>(
        `insert into bots (id, user_id, sodex_account_id, strategy, market, engine, name, state, mode, updated_at)
         values (gen_random_uuid(), $1, $2, $3, 'BTC-USD', 'perps', $4, $5, $6, coalesce($7, now())) returning id`,
        [
          userId,
          accountId,
          opts.strategy ?? "volume_maker",
          name,
          state,
          opts.mode ?? "live",
          opts.updatedAgo === undefined ? null : at(opts.updatedAgo),
        ],
      );
      return rows[0]?.id ?? "";
    };
    const stop = (botId: string, ago: number, state = "stopped") =>
      env.pool.query(
        "insert into outbox (id, topic, payload, created_at) values (gen_random_uuid(), $1, $2, $3)",
        [`user.${accountId}.bot`, JSON.stringify({ botId, state }), at(ago)],
      );
    await bot("BM running", "running");
    await bot("BM paused vb", "paused", { strategy: "volume_farm" });
    const stopping = await bot("BM stopping", "stopping");
    await stop(stopping, 9 * 60_000, "stopping");
    const recent = await bot("BM stopped 2h", "stopped");
    await stop(recent, 2 * HOUR);
    const weekOld = await bot("BM stopped 8d", "stopped");
    await stop(weekOld, 8 * DAY);
    const archivedIn = await bot("BM archived 3d", "archived");
    await stop(archivedIn, 3 * DAY);
    const archivedOut = await bot("BM archived 10d", "archived", { updatedAgo: 9 * DAY });
    await stop(archivedOut, 10 * DAY);
    await bot("BM stopped no stop row", "stopped", { updatedAgo: 30 * DAY });
    await bot("BM paper", "running", { mode: "paper" });
    await bot("BM draft", "draft");

    const active = await view(client);
    const mine = active.bots.filter((b) => b.userId === userId);
    expect(mine.map((b) => b.name).sort()).toEqual([
      "BM archived 3d",
      "BM paused vb",
      "BM running",
      "BM stopped 2h",
      "BM stopping",
    ]);
    expect(mine.find((b) => b.name === "BM stopping")?.stopAt).toBe(at(9 * 60_000).toISOString());
    // Bot không chạy ở cuối: Not running rồi Archived.
    expect(mine.find((b) => b.name === "BM stopped 2h")?.health).toBe("not_running");
    expect(mine.find((b) => b.name === "BM archived 3d")?.health).toBe("archived");
    expect(active.summary.total.stoppedDay).toBeGreaterThanOrEqual(1);

    const all = await view(client, `?show=all&strategy=volume_maker&q=${userId}`);
    expect(all.page).toEqual({ strategy: "volume_maker", page: 1, pageSize: 50, total: 7 });
    expect(all.counts).toEqual({ volume_maker: 7, volume_farm: 1 });
    expect(all.bots.map((b) => b.name).sort()).toEqual([
      "BM archived 10d",
      "BM archived 3d",
      "BM running",
      "BM stopped 2h",
      "BM stopped 8d",
      "BM stopped no stop row",
      "BM stopping",
    ]);
    // Bot không chạy ở All bots: Cost / $1M cả đợt chạy (bot_runtime), không phải 24 giờ.
    expect(all.bots.find((b) => b.name === "BM stopped 8d")?.costScope).toBe("lifetime");
    expect(all.bots.find((b) => b.name === "BM running")?.costScope).toBe("day");
    // Tìm theo tên.
    const named = await view(client, `?show=all&q=${encodeURIComponent("BM archived 10")}`);
    expect(named.bots.filter((b) => b.userId === userId).map((b) => b.name)).toEqual([
      "BM archived 10d",
    ]);
  });

  it("pages All bots by 50 in SQL", async () => {
    const { client, userId, accountId } = await teamUser();
    await env.pool.query(
      `insert into bots (id, user_id, sodex_account_id, strategy, market, engine, name, state)
       select gen_random_uuid(), $1, $2, 'volume_farm', 'ETH-USD', 'perps', 'BM page ' || i, 'stopped'
         from generate_series(1, 51) i`,
      [userId, accountId],
    );
    const p1 = await view(client, `?show=all&strategy=volume_farm&q=${userId}`);
    expect(p1.bots).toHaveLength(50);
    expect(p1.page?.total).toBe(51);
    const p2 = await view(client, `?show=all&strategy=volume_farm&q=${userId}&page=2`);
    expect(p2.bots).toHaveLength(1);
    expect(new Set([...p1.bots, ...p2.bots].map((b) => b.botId)).size).toBe(51);
  });

  it("labels Problem / Check / Healthy / Not running / Archived by the rules", async () => {
    const { client, userId, accountId } = await teamUser();
    const bot = async (name: string, state: string, strategy = "volume_maker", reason?: string) => {
      const { rows } = await env.pool.query<{ id: string }>(
        `insert into bots (id, user_id, sodex_account_id, strategy, market, engine, name, state, reason_code)
         values (gen_random_uuid(), $1, $2, $3, 'BTC-USD', 'perps', $4, $5, $6) returning id`,
        [userId, accountId, strategy, name, state, reason ?? null],
      );
      return rows[0]?.id ?? "";
    };
    const outbox = (topic: string, payload: object, ago: number) =>
      env.pool.query(
        "insert into outbox (id, topic, payload, created_at) values (gen_random_uuid(), $1, $2, $3)",
        [topic, JSON.stringify(payload), at(ago)],
      );
    const alert = (botId: string, invariant: string, status: string, ago: number, detail = "") =>
      outbox("jobs.team_ops", { type: "team_invariant", invariant, status, botId, detail }, ago);
    const event = (botId: string, decision: string, why: string | null, ago: number) =>
      env.pool.query(
        "insert into bot_events (id, bot_id, type, decision, why, occurred_at) values (gen_random_uuid(), $1, 'log', $2, $3, $4)",
        [botId, decision, why, at(ago)],
      );

    const p1 = await bot("BM P1", "running");
    // Gửi lại mỗi 30 phút: mốc "since" là lần sai đầu của đợt.
    await alert(p1, "P1", "failing", 2 * HOUR, "position 1,180 USDC over limit 1,050 USDC");
    await alert(p1, "P1", "failing", 90 * 60_000, "position 1,180 USDC over limit 1,050 USDC");
    const rejected = await bot("BM rejected", "paused", "volume_farm", "ORDER_REJECTED");
    await event(
      rejected,
      "Market entries rejected",
      "SoDEX rejected 3 market entries in a row.",
      HOUR,
    );
    const busy = await bot("BM busy", "running");
    await event(
      busy,
      "Order requests",
      "Last 60 s: 62 requests to SoDEX (new orders and cancels). Longest gap between quotes: 74.0 s.",
      60_000,
    );
    await event(busy, "Cancelled 1 untracked order", null, 3 * HOUR);
    const resolved = await bot("BM resolved", "running");
    await alert(resolved, "P5", "failing", 6 * HOUR, "no quote for 40 s");
    await alert(resolved, "P5", "resolved", 5 * HOUR);
    const healthy = await bot("BM healthy", "running");
    await event(
      healthy,
      "Order requests",
      "Last 60 s: 48 requests to SoDEX. Longest gap between quotes: 3.1 s.",
      60_000,
    );
    await alert(healthy, "P5", "failing", 3 * DAY);
    await alert(healthy, "P5", "resolved", 2 * DAY);
    const stopped = await bot("BM stopped", "stopped");
    await outbox(`user.${accountId}.bot`, { botId: stopped, state: "stopped" }, HOUR);
    await event(stopped, "Cancelled 2 untracked orders", null, 2 * HOUR);
    const stoppedAlert = await bot("BM stopped P3", "stopped");
    await outbox(`user.${accountId}.bot`, { botId: stoppedAlert, state: "stopped" }, HOUR);
    await alert(
      stoppedAlert,
      "P3",
      "failing",
      30 * 60_000,
      "1 order(s) still open after the bot stopped",
    );
    const archived = await bot("BM archived", "archived");
    await outbox(`user.${accountId}.bot`, { botId: archived, state: "stopped" }, 2 * DAY);

    const v = await view(client);
    const mine = v.bots.filter((b) => b.userId === userId);
    const of = (id: string) => {
      const b = mine.find((x) => x.botId === id);
      if (b === undefined) throw new Error(`bot ${id} missing`);
      return b;
    };
    expect(of(p1)).toMatchObject({
      health: "problem",
      alert: { invariant: "P1", status: "active", at: at(2 * HOUR).toISOString() },
    });
    expect(of(p1).reasons[0]).toMatchObject({ code: "alert_active", invariant: "P1" });
    expect(of(rejected).health).toBe("problem");
    expect(of(rejected).reasons[0]).toMatchObject({
      code: "rejected_pause",
      at: at(HOUR).toISOString(),
    });
    expect(of(busy)).toMatchObject({
      health: "check",
      requestsPerMinute: "62",
      maxQuoteGapSec: "74",
    });
    expect(of(busy).reasons.map((r) => r.code)).toEqual(["requests_high", "gap_long", "untracked"]);
    expect(of(resolved)).toMatchObject({
      health: "check",
      alert: { invariant: "P5", status: "resolved", at: at(5 * HOUR).toISOString() },
    });
    expect(of(resolved).reasons[0]).toMatchObject({
      code: "alert_resolved",
      at: at(6 * HOUR).toISOString(),
      until: at(5 * HOUR).toISOString(),
    });
    // Hết sai hơn 24 giờ trước: vẫn hiện ở Latest alert nhưng không làm bot thành Check.
    expect(of(healthy)).toMatchObject({
      health: "healthy",
      reasons: [],
      alert: { status: "resolved" },
    });
    expect(of(stopped)).toMatchObject({ health: "not_running", reasons: [] });
    expect(of(stoppedAlert).health).toBe("problem");
    expect(of(archived).health).toBe("archived");
    // Thứ tự: Problem → Check → Healthy → Not running → Archived.
    const order = ["problem", "check", "healthy", "not_running", "archived"];
    const ranks = mine.map((b) => order.indexOf(b.health));
    expect([...ranks].sort((a, b) => a - b)).toEqual(ranks);
    // Look at these first: chỉ Problem và Check.
    const attn = v.attention.filter((b) => b.userId === userId).map((b) => b.health);
    expect(new Set(attn)).toEqual(new Set(["problem", "check"]));
    expect(v.summary.alerts.filter((a) => a.botId === p1)).toEqual([
      { botId: p1, name: "BM P1", invariant: "P1" },
    ]);
    // Phần chi tiết: cảnh báo tính một lần mỗi đợt; không có dòng "Order requests".
    expect(of(p1).log).toEqual([
      {
        at: at(2 * HOUR).toISOString(),
        name: "P1",
        why: "position 1,180 USDC over limit 1,050 USDC",
        alert: "failing",
      },
    ]);
    expect(of(busy).log.map((l) => l.name)).toEqual(["Cancelled 1 untracked order"]);
  });

  it("computes cost per $1M over 24 h of fills with the Market hours formula, never 0 when there is nothing", async () => {
    const { client, userId, accountId } = await teamUser();
    const market = `BM${randomUUID().slice(0, 6)}-USD`;
    const { rows } = await env.pool.query<{ id: string }>(
      `insert into bots (id, user_id, sodex_account_id, strategy, market, engine, name, state)
       values (gen_random_uuid(), $1, $2, 'volume_maker', $3, 'perps', 'BM cost', 'running') returning id`,
      [userId, accountId, market],
    );
    const botId = rows[0]?.id ?? "";
    const { rows: idle } = await env.pool.query<{ id: string }>(
      `insert into bots (id, user_id, sodex_account_id, strategy, market, engine, name, state)
       values (gen_random_uuid(), $1, $2, 'volume_maker', $3, 'perps', 'BM idle', 'running') returning id`,
      [userId, accountId, market],
    );
    let n = 0;
    const fill = async (
      side: string,
      size: string,
      fee: string,
      isMaker: boolean | null,
      ago: number,
    ) => {
      n += 1;
      const { rows: o } = await env.pool.query<{ id: string }>(
        "insert into orders (id, bot_id, sodex_account_id, cl_ord_id, market, engine, side, type, time_in_force, size, status, tag, epoch, created_at) values (gen_random_uuid(), $1, $2, $3, $4, 'perps', $5, 'limit', 'GTX', $6, 'filled', 'vm', 1, $7) returning id",
        [
          botId,
          accountId,
          `bm-${String(n)}-${randomUUID().slice(0, 8)}`,
          market,
          side,
          size,
          at(ago),
        ],
      );
      await env.pool.query(
        "insert into fills (id, order_id, sodex_trade_id, price, size, fee, is_maker, filled_at) values (gen_random_uuid(), $1, $2, 100, $3, $4, $5, $6)",
        [o[0]?.id, Math.floor(Math.random() * 1e12), size, fee, isMaker, at(ago)],
      );
      // Giá tham chiếu: close của nến chứa fill + 60 s = 99.
      await env.pool.query(
        "insert into candles_1m (market, ts, open, high, low, close, volume) values ($1, date_trunc('minute', $2::timestamptz + interval '60 seconds'), 99, 99, 99, 99, 1) on conflict do nothing",
        [market, at(ago)],
      );
    };
    // Mua 10 @ 100, giá sau 1 phút 99: price PnL −10. Bán 10 @ 100: +10. Phí 0.5 + 0.5. Volume 2,000.
    // Cost = (1 − 0) ÷ 2,000 × 1e6 = 500. Fill cũ hơn 24 giờ không tính.
    await fill("buy", "10", "0.5", true, 30 * 60_000);
    await fill("sell", "10", "0.5", false, 3 * HOUR);
    await fill("buy", "10", "9", true, 25 * HOUR);

    const v = await view(client);
    const b = v.bots.find((x) => x.botId === botId);
    expect(b).toMatchObject({
      costPerMillion: "500",
      costScope: "day",
      volumeHour: "1000",
      volumeDay: "2000",
      makerSharePct: "50",
    });
    expect(v.bots.find((x) => x.botId === idle[0]?.id)).toMatchObject({
      costPerMillion: null,
      volumeHour: null,
      volumeDay: null,
      makerSharePct: null,
      requestsPerMinute: null,
      maxQuoteGapSec: null,
      positionPct: null,
      alert: null,
    });
    expect(v.bots.filter((x) => x.userId === userId)).toHaveLength(2);
  });
});
