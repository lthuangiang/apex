import {
  botSummarySchema,
  copyPreviewSchema,
  errorResponseSchema,
  followingSchema,
  meSchema,
  traderListSchema,
  traderProfileSchema,
  type LeaderStats,
} from "@drift/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { signIn, startTestEnv, TestClient, type TestEnv } from "./helpers";

// Copy Trading v1 (DEC-163): danh sách trader, hồ sơ, theo dõi, Following, preview Budget and safety.

let env: TestEnv;
const ADDRESS = "0x9e5C8b7a1F2D3C4B5A69788766554433221100Ff";
const T1 = "0xaaa0000000000000000000000000000000000001";
const T2 = "0xbbb0000000000000000000000000000000000002";
const errorOf = (body: unknown) => errorResponseSchema.parse(body).error;

const stats = (over: Partial<LeaderStats> = {}): LeaderStats => ({
  profit: "84120",
  worstDip: "9800",
  typicalHoldMs: 5 * 3_600_000,
  winRate: "0.62",
  wins: 73,
  closedEpisodes: 118,
  topTradeShare: "0.18",
  coverage: "1",
  liquidations: 0,
  medianEntryNotional: "40000",
  markets: ["BTC-USD"],
  unlistedCoins: [],
  dailyCurve: [[Date.UTC(2026, 9, 27), "100"]],
  historyIncomplete: false,
  fills: 412,
  ...over,
});

async function seedTrader(address: string, s: LeaderStats, tabs: string[], hidden: string[] = []) {
  await env.pool.query(
    "insert into leader_wallets (source, address) values ('hyperliquid', $1) on conflict do nothing",
    [address],
  );
  await env.pool.query(
    `insert into leader_stats_daily (source, address, date, stats, hidden, tabs, steady_score, profit, typical_hold_ms, computed_at)
     values ('hyperliquid', $1, '2026-10-27', $2, $3, $4, $5, $6, $7, now())`,
    [
      address,
      JSON.stringify(s),
      hidden,
      tabs,
      tabs.includes("steady") ? 8.5 : null,
      s.profit,
      s.typicalHoldMs,
    ],
  );
}

async function user(email: string, desk = true) {
  const client = new TestClient(env.app);
  const me = meSchema.parse((await signIn(env, client, email)).json());
  // AI Desk mặc định bật cho mọi tài khoản (DEC-TBD-desk-for-all): ca "tắt" phải tắt rõ ràng.
  await env.pool.query("update users set ai_desk = $2 where id = $1", [me.id, desk]);
  return { client, userId: me.id };
}

beforeAll(async () => {
  env = await startTestEnv();
  env.prices.set("BTC-USD", { price: "100000", at: env.clock.now.getTime() });
});
afterAll(async () => {
  await env.close();
});

describe("Copy Trading v1", () => {
  it("is only for accounts with AI Desk", async () => {
    const { client } = await user("copy-nodesk@example.com", false);
    const r = await client.request("GET", "/api/v1/traders");
    expect(errorOf(r.json()).code).toBe("FORBIDDEN");
  });

  it("shows an empty list with no update date before the first nightly run", async () => {
    const { client } = await user("copy-empty@example.com");
    const list = traderListSchema.parse((await client.request("GET", "/api/v1/traders")).json());
    expect(list).toMatchObject({ updatedOn: null, items: [], hidden: 0 });
  });

  it("shows traders as they are checked while the very first run is still going", async () => {
    const T9 = "0x9990000000000000000000000000000000000009";
    await env.pool.query(
      "insert into leaderboard_runs (date, status, candidates, computed) values ('2026-10-20', 'running', 300, 40)",
    );
    await env.pool.query(
      "insert into leader_wallets (source, address) values ('hyperliquid', $1) on conflict do nothing",
      [T9],
    );
    await env.pool.query(
      `insert into leader_stats_daily (source, address, date, stats, hidden, tabs, steady_score, profit, typical_hold_ms, computed_at)
       values ('hyperliquid', $1, '2026-10-20', $2, '{}', '{steady,top,long,all}', 8.5, '84120', 18000000, now())`,
      [T9, JSON.stringify(stats())],
    );
    const { client } = await user("copy-first-run@example.com");
    const list = traderListSchema.parse(
      (await client.request("GET", "/api/v1/traders?tab=steady")).json(),
    );
    expect(list).toMatchObject({ updatedOn: null, checking: { done: 40, total: 300 } });
    expect(list.items.map((i) => i.address)).toEqual([T9]);
    await env.pool.query("delete from leader_stats_daily where address = $1", [T9]);
    await env.pool.query("delete from leader_wallets where address = $1", [T9]);
    await env.pool.query("delete from leaderboard_runs where date = '2026-10-20'");
  });

  it("lists Steady traders from the last good run and counts hidden ones by reason", async () => {
    await seedTrader(T1, stats(), ["steady", "top", "long", "all"]);
    await seedTrader(
      T2,
      stats({ typicalHoldMs: 5 * 60_000, closedEpisodes: 12 }),
      [],
      ["few_trades", "fast"],
    );
    await env.pool.query("insert into leaderboard_runs (date, status) values ('2026-10-27', 'ok')");
    const { client } = await user("copy-list@example.com");
    const list = traderListSchema.parse(
      (await client.request("GET", "/api/v1/traders?tab=steady")).json(),
    );
    expect(list.updatedOn).toBe("2026-10-27");
    expect(list.checking).toBeNull();
    expect(list.items.map((i) => i.address)).toEqual([T1]);
    expect(list.items[0]).toMatchObject({ slot: "open", following: false });
    expect(list.items[0]?.tags).toEqual(
      expect.arrayContaining(["easy_to_copy", "holds_hours", "all_on_sodex"]),
    );
    expect(list).toMatchObject({
      candidates: 2,
      hidden: 1,
      hiddenBy: { fast: 1, few_trades: 1, vault: 0 },
    });
  });

  it("keeps a trader the last run couldn't read, using stats from the past 7 days", async () => {
    const T3 = "0xccc0000000000000000000000000000000000003";
    const T4 = "0xddd0000000000000000000000000000000000004";
    for (const [address, date] of [
      [T3, "2026-10-24"],
      [T4, "2026-10-10"],
    ] as const) {
      await env.pool.query(
        "insert into leader_wallets (source, address, last_on_leaderboard_at) values ('hyperliquid', $1, '2026-10-27T01:00:00Z')",
        [address],
      );
      await env.pool.query(
        `insert into leader_stats_daily (source, address, date, stats, hidden, tabs, steady_score, profit, typical_hold_ms, computed_at)
         values ('hyperliquid', $1, $2, $3, '{}', '{top,long,all}', null, '84120', 18000000, now())`,
        [address, date, JSON.stringify(stats())],
      );
    }
    const { client } = await user("copy-stale@example.com");
    const list = traderListSchema.parse(
      (await client.request("GET", "/api/v1/traders?tab=all")).json(),
    );
    const shown = list.items.map((i) => i.address);
    expect(shown).toContain(T3);
    expect(shown).not.toContain(T4);
    await env.pool.query("delete from leader_stats_daily where address = any($1)", [[T3, T4]]);
    await env.pool.query("delete from leader_wallets where address = any($1)", [[T3, T4]]);
  });

  it("shows a trader profile with fit checks, recent changes and the position that won't be copied", async () => {
    await env.pool.query(
      `insert into leader_events (id, source, address, coin, market, kind, position_before, position_after, notional, price, at, seen_at, last_tid)
       values (gen_random_uuid(), 'hyperliquid', $1, 'BTC', 'BTC-USD', 'open', '0', '4.2', '420000', '100000', now() - interval '1 hour', now() - interval '1 hour' + interval '30 seconds', 't1'),
              (gen_random_uuid(), 'hyperliquid', $1, 'HYPE', null, 'close', '-5', '0', '200', '40', now() - interval '2 hours', now(), 't2')`,
      [T1],
    );
    const { client } = await user("copy-profile@example.com");
    const p = traderProfileSchema.parse(
      (await client.request("GET", `/api/v1/traders/${T1}`)).json(),
    );
    expect(p.copyable).toEqual({ ok: true, reason: null });
    expect(p.fit.map((f) => [f.item, f.ok])).toEqual([
      ["holds_long", true],
      ["all_listed", true],
      ["spread_profit", true],
      ["no_liquidations", true],
    ]);
    expect(p.events.map((e) => [e.kind, e.market, e.seenAfterMs])).toEqual([
      ["open", "BTC-USD", 30_000],
      ["close", null, null],
    ]);
    expect(p.openPositions).toEqual([{ market: "BTC-USD", coin: "BTC", side: "long" }]);
    const r = await client.request("GET", `/api/v1/traders/0x${"1".repeat(40)}`);
    expect(errorOf(r.json()).code).toBe("NOT_FOUND");
  });

  it("follows up to 5 traders and shows their changes in Following", async () => {
    const { client } = await user("copy-follow@example.com");
    expect((await client.request("POST", `/api/v1/traders/${T1}/follow`)).statusCode).toBe(200);
    const f = followingSchema.parse((await client.request("GET", "/api/v1/following")).json());
    expect(f).toMatchObject({ limit: 5, checkedEveryMs: 120_000, bigMoveAlerts: false });
    expect(f.traders.map((t) => [t.address, t.copying])).toEqual([[T1, false]]);
    expect(f.events.map((e) => e.kind)).toEqual(["open", "close"]);
    for (let i = 0; i < 4; i += 1) {
      const a = `0x${String(i).repeat(40)}`;
      await seedTrader(a, stats(), ["all"]);
      expect((await client.request("POST", `/api/v1/traders/${a}/follow`)).statusCode).toBe(200);
    }
    await seedTrader(`0x${"9".repeat(40)}`, stats(), ["all"]);
    const sixth = await client.request("POST", `/api/v1/traders/0x${"9".repeat(40)}/follow`);
    expect(errorOf(sixth.json()).details).toMatchObject({ reason: "follow_limit" });
    expect((await client.request("DELETE", `/api/v1/traders/${T1}/follow`)).statusCode).toBe(200);
  });

  it("turns budget and safety level into S12 fields on the server, and leaves out taken markets", async () => {
    const { client, userId } = await user("copy-preview@example.com");
    const accountID = Math.floor(Math.random() * 1e9);
    env.sodex.addUser(ADDRESS, accountID);
    const { rows } = await env.pool.query<{ id: string }>(
      "insert into sodex_accounts (id, user_id, address, sodex_account_id, network, status) values (gen_random_uuid(), $1, $2, $3, 'mainnet', 'connected') returning id",
      [userId, ADDRESS, accountID],
    );
    const preview = async () =>
      copyPreviewSchema.parse(
        (
          await client.request("POST", "/api/v1/copy/preview", {
            body: { address: T1, budget: "500", preset: "balanced" },
          })
        ).json(),
      );
    const p = await preview();
    expect(p.config).toMatchObject({
      leaderSource: "hyperliquid",
      leaderAddress: T1,
      markets: ["BTC-USD"],
      leverage: 2,
      sizing: "fixed",
      fixedNotional: "250",
      maxNotionalPerTrade: "250",
      maxExposure: "1000",
      stopLossPct: "10",
      maxLoss: "100",
    });
    expect(p).toMatchObject({
      slot: "open",
      copyable: { ok: true },
      builderFeeMax: "0.01",
      dropped: [],
    });

    // Một bot thật khác đã chạy BTC-USD trên account này: Review báo BTC bị bỏ (SoDEX gộp vị thế theo symbol).
    const made = await client.request("POST", "/api/v1/bots", {
      body: {
        strategy: "copy_trade",
        name: "Other copy",
        paramSource: "manual",
        config: { ...p.config, leaderAddress: T2 },
      },
    });
    const otherId = botSummarySchema.parse(made.json()).id;
    await env.pool.query("update bots set state = 'running' where id = $1", [otherId]);
    const q = await preview();
    expect(q.markets).toEqual([]);
    expect(q.dropped).toEqual([
      { market: "BTC-USD", reason: "bot", botId: otherId, botName: "Other copy" },
    ]);
    expect(q.copyable).toEqual({ ok: false, reason: "no_markets" });
    await env.pool.query("update bots set state = 'stopped' where id = $1", [otherId]);
    expect(rows).toHaveLength(1);
  });

  it("offers Follow · copy later once 8 traders are copied live, and refuses a ninth copy", async () => {
    const { client, userId } = await user("copy-slots@example.com");
    const accountID = Math.floor(Math.random() * 1e9);
    env.sodex.addUser(ADDRESS, accountID);
    await env.pool.query(
      "insert into sodex_accounts (id, user_id, address, sodex_account_id, network, status) values (gen_random_uuid(), $1, $2, $3, 'mainnet', 'connected')",
      [userId, ADDRESS, accountID],
    );
    const base = {
      leaderSource: "hyperliquid",
      markets: ["BTC-USD"],
      leverage: 2,
      fixedNotional: "100",
      maxNotionalPerTrade: "100",
      maxExposure: "1000",
      maxLoss: "100",
    };
    const ids: string[] = [];
    for (let i = 0; i < 8; i += 1) {
      const r = await client.request("POST", "/api/v1/bots", {
        body: {
          strategy: "copy_trade",
          name: `Slot ${String(i)}`,
          paramSource: "manual",
          config: { ...base, leaderAddress: `0xc${String(i).repeat(39)}` },
        },
      });
      ids.push(botSummarySchema.parse(r.json()).id);
    }
    await env.pool.query("update bots set state = 'running' where id = any($1)", [ids]);
    const list = traderListSchema.parse((await client.request("GET", "/api/v1/traders")).json());
    expect(list.items.find((i) => i.address === T1)?.slot).toBe("full");
    const start = await client.request("POST", "/api/v1/copy", {
      body: { address: T1, budget: "500", preset: "balanced", acknowledged: true },
    });
    expect(errorOf(start.json()).details).toMatchObject({ reason: "slots_full" });
    await env.pool.query("update bots set state = 'stopped' where id = any($1)", [ids]);
  });

  it("reuses the draft copy bot when Start fails and the user tries again", async () => {
    const { client, userId } = await user("copy-retry@example.com");
    const accountID = Math.floor(Math.random() * 1e9);
    env.sodex.addUser(ADDRESS, accountID);
    await env.pool.query(
      "insert into sodex_accounts (id, user_id, address, sodex_account_id, network, status) values (gen_random_uuid(), $1, $2, $3, 'mainnet', 'connected')",
      [userId, ADDRESS, accountID],
    );
    const body = { address: T1, budget: "500", preset: "balanced", acknowledged: true };
    // Builder fee chưa approve trên account mới: Start bị từ chối, bot ở lại draft.
    const first = await client.request("POST", "/api/v1/copy", { body });
    const second = await client.request("POST", "/api/v1/copy", { body });
    expect(first.statusCode).toBeGreaterThanOrEqual(400);
    expect(second.statusCode).toBeGreaterThanOrEqual(400);
    const { rows } = await env.pool.query<{ n: number }>(
      "select count(*)::int as n from bots where user_id = $1 and strategy = 'copy_trade'",
      [userId],
    );
    expect(rows[0]?.n).toBe(1);
  });
});
