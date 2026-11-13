import {
  botSummarySchema,
  copyPreviewSchema,
  errorResponseSchema,
  followingEventsSchema,
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
  // AI Desk mặc định bật cho mọi tài khoản (DEC-192): ca "tắt" phải tắt rõ ràng.
  await env.pool.query("update users set ai_desk = $2 where id = $1", [me.id, desk]);
  return { client, userId: me.id };
}

const T3 = "0xccc0000000000000000000000000000000000003";
const TIERS = [
  {
    maxNotionalValue: "1000000",
    maintenanceMarginRate: "0.01",
    maxLeverage: 20,
    maintenanceDeduction: "0",
  },
];

beforeAll(async () => {
  env = await startTestEnv();
  env.prices.set("BTC-USD", { price: "100000", at: env.clock.now.getTime() });
  // Chọn market và đòn bẩy theo market (DEC-226): ETH cho tới 10×, FIL chỉ 1×.
  env.sodex.addPerpSymbol("ETH-USD", { maxLeverage: 10, marginTiers: TIERS });
  env.sodex.addPerpSymbol("FIL-USD", { maxLeverage: 1 });
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
    // Snapshot cũ còn gắn Steady cho trader bị thanh lý: API vẫn loại khỏi Steady, giữ ở All.
    const LIQ = "0xeee0000000000000000000000000000000000005";
    await seedTrader(LIQ, stats({ liquidations: 7 }), ["steady", "top", "long", "all"]);
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
      candidates: 3,
      hidden: 1,
      hiddenBy: { fast: 1, few_trades: 1, vault: 0 },
    });
    const all = traderListSchema.parse(
      (await client.request("GET", "/api/v1/traders?tab=all")).json(),
    );
    expect(all.items.map((i) => i.address)).toContain(LIQ);
    expect(all.items.find((i) => i.address === LIQ)?.tags).toContain("liquidated");
    await env.pool.query("delete from leader_stats_daily where address = $1", [LIQ]);
    await env.pool.query("delete from leader_wallets where address = $1", [LIQ]);
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

  it("shows the profile from the same snapshot as the list, and warns when recent trades can't be copied", async () => {
    const T6 = "0xfff0000000000000000000000000000000000006";
    await seedTrader(T6, stats({ profit: "94598" }), ["top", "long", "all"]);
    await env.pool.query(
      "insert into leaderboard_runs (date, status) values ('2026-10-27', 'ok') on conflict do nothing",
    );
    // Lượt đêm sau đang chạy đã tính số mới hơn: hồ sơ vẫn theo snapshot của danh sách (2026-10-27).
    await env.pool.query(
      `insert into leader_stats_daily (source, address, date, stats, hidden, tabs, steady_score, profit, typical_hold_ms, computed_at)
       values ('hyperliquid', $1, '2026-10-28', $2, '{}', '{top,long,all}', null, '154981', 18000000, now())`,
      [T6, JSON.stringify(stats({ profit: "154981" }))],
    );
    // 7 ngày qua: 90% notional ở GRAM (SoDEX không có).
    await env.pool.query(
      `insert into leader_events (id, source, address, coin, market, kind, position_before, position_after, notional, price, at, seen_at, last_tid)
       values (gen_random_uuid(), 'hyperliquid', $1, 'GRAM', null, 'open', '0', '100', '9000', '90', now(), now(), 'g1'),
              (gen_random_uuid(), 'hyperliquid', $1, 'BTC', 'BTC-USD', 'open', '0', '0.01', '1000', '100000', now(), now(), 'g2')`,
      [T6],
    );
    const { client } = await user("copy-snapshot@example.com");
    const p = traderProfileSchema.parse(
      (await client.request("GET", `/api/v1/traders/${T6}`)).json(),
    );
    expect(p.updatedOn).toBe("2026-10-27");
    expect(p.card.stats.profit).toBe("94598");
    expect(p.fit.find((f) => f.item === "recent_unlisted")).toEqual({
      item: "recent_unlisted",
      ok: false,
      data: { share: "0.9", coins: "GRAM" },
    });
    await env.pool.query("delete from leader_events where address = $1", [T6]);
    await env.pool.query("delete from leader_stats_daily where address = $1", [T6]);
    await env.pool.query("delete from leader_wallets where address = $1", [T6]);
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

  it("keeps one alert level per followed trader: Big moves by default, changeable, NOT_FOUND when not following", async () => {
    const { client } = await user("copy-alerts@example.com");
    expect((await client.request("POST", `/api/v1/traders/${T1}/follow`)).statusCode).toBe(200);
    const before = followingSchema.parse((await client.request("GET", "/api/v1/following")).json());
    expect(before.traders.map((t) => t.alertLevel)).toEqual(["big_moves"]);
    const set = await client.request("PUT", `/api/v1/traders/${T1}/follow/alerts`, {
      body: { level: "positions" },
    });
    expect(set.statusCode).toBe(200);
    expect(set.json()).toEqual({ address: T1, alertLevel: "positions" });
    const after = followingSchema.parse((await client.request("GET", "/api/v1/following")).json());
    expect(after.traders.map((t) => t.alertLevel)).toEqual(["positions"]);
    const profile = (await client.request("GET", `/api/v1/traders/${T1}`)).json<{
      followAlertLevel: string | null;
    }>();
    expect(profile.followAlertLevel).toBe("positions");
    const bad = await client.request("PUT", `/api/v1/traders/${T1}/follow/alerts`, {
      body: { level: "everything" },
    });
    expect(errorOf(bad.json()).code).toBe("VALIDATION_FAILED");
    await client.request("DELETE", `/api/v1/traders/${T1}/follow`);
    const gone = await client.request("PUT", `/api/v1/traders/${T1}/follow/alerts`, {
      body: { level: "off" },
    });
    expect(errorOf(gone.json())).toMatchObject({
      code: "NOT_FOUND",
      details: { reason: "not_following" },
    });
  });

  it("pages Recent changes 50 at a time with a cursor and filters by one followed trader (W4)", async () => {
    const T7 = "0xfff0000000000000000000000000000000000007";
    await seedTrader(T7, stats(), ["all"]);
    // 55 sự kiện, hai cặp cùng thời điểm để kiểm tra con trỏ không trùng / sót dòng.
    await env.pool.query(
      `insert into leader_events (id, source, address, coin, market, kind, position_before, position_after, notional, price, at, seen_at, last_tid)
       select gen_random_uuid(), 'hyperliquid', $1, 'ETH', 'ETH-USD', 'open', '0', '1', '1000', '3000',
              now() - (i / 2) * interval '1 minute', now(), 'p' || i
       from generate_series(1, 55) as i`,
      [T7],
    );
    const { client } = await user("copy-pages@example.com");
    for (const a of [T1, T7])
      expect((await client.request("POST", `/api/v1/traders/${a}/follow`)).statusCode).toBe(200);
    const all: { address: string; at: string }[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const qs: string = cursor === null ? "" : `?cursor=${encodeURIComponent(cursor)}`;
      const page = followingEventsSchema.parse(
        (await client.request("GET", `/api/v1/following/events${qs}`)).json(),
      );
      expect(page.events.length).toBeLessThanOrEqual(50);
      all.push(...page.events);
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor !== null && pages < 5);
    expect(pages).toBe(2);
    // 55 của T7 + các sự kiện của T1 (test hồ sơ ở trên): hơn một trang.
    expect(all.length).toBeGreaterThan(50);
    // Đúng từng dòng của DB theo (at, id) giảm dần: không trùng, không sót qua ranh giới trang.
    const { rows: db } = await env.pool.query<{ address: string; at: Date }>(
      "select address, at from leader_events where address = any($1) order by at desc, id desc",
      [[T1, T7]],
    );
    // API ghi thời điểm tới giây; so theo giây.
    const sec = (ms: number) => Math.floor(ms / 1000);
    expect(all.map((e) => [e.address, sec(Date.parse(e.at))])).toEqual(
      db.map((r) => [r.address, sec(r.at.getTime())]),
    );
    const only = followingEventsSchema.parse(
      (await client.request("GET", `/api/v1/following/events?trader=${T1}`)).json(),
    );
    expect(only.events.map((e) => e.address)).toEqual([T1, T1]);
    expect(only.nextCursor).toBeNull();
    const other = await client.request(
      "GET",
      `/api/v1/following/events?trader=0x${"9".repeat(40)}`,
    );
    expect(errorOf(other.json())).toMatchObject({
      code: "NOT_FOUND",
      details: { reason: "not_following" },
    });
    const bad = await client.request("GET", "/api/v1/following/events?cursor=nope");
    expect(errorOf(bad.json()).code).toBe("VALIDATION_FAILED");
    for (const a of [T1, T7]) await client.request("DELETE", `/api/v1/traders/${a}/follow`);
    await env.pool.query("delete from leader_events where address = $1", [T7]);
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
    // SoDEX mock: volume 24h vài nghìn USD (< 50,000) → Review cảnh báo market mỏng (DEC-207).
    expect(p.thinMarkets).toEqual(["BTC-USD"]);

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

  it("lets the user pick markets and leverage per market; the server checks and caps everything (DEC-226)", async () => {
    const { client, userId } = await user("copy-pick@example.com");
    const accountID = Math.floor(Math.random() * 1e9);
    env.sodex.addUser(ADDRESS, accountID);
    const acct = (
      await env.pool.query<{ id: string }>(
        "insert into sodex_accounts (id, user_id, address, sodex_account_id, network, status) values (gen_random_uuid(), $1, $2, $3, 'mainnet', 'connected') returning id",
        [userId, ADDRESS, accountID],
      )
    ).rows[0]?.id;
    await seedTrader(
      T3,
      stats({ markets: ["BTC-USD", "ETH-USD", "FIL-USD"], episodesByMarket: { "BTC-USD": 5 } }),
      ["steady"],
    );
    const post = (body: Record<string, unknown>) =>
      client.request("POST", "/api/v1/copy/preview", {
        body: { address: T3, budget: "500", preset: "balanced", ...body },
      });
    const preview = async (body: Record<string, unknown> = {}) =>
      copyPreviewSchema.parse((await post(body)).json());

    // Mặc định: mọi market; FIL hạ về 1× (không bỏ), trần tổng = 500 × 1× (ký quỹ không vượt budget).
    const all = await preview();
    expect(all.markets).toEqual(["BTC-USD", "ETH-USD", "FIL-USD"]);
    expect(all.dropped).toEqual([]);
    expect(all.rows.map((r) => [r.market, r.leverage, r.maxLeverage, r.trades30d])).toEqual([
      ["BTC-USD", 2, 5, 5],
      ["ETH-USD", 2, 5, 0],
      ["FIL-USD", 1, 1, 0],
    ]);
    expect(all.lowestLeverage).toBe(1);
    expect(all.mixedLeverage).toBe(true);
    expect(all.config).toMatchObject({
      leverage: 2,
      leverageByMarket: { "BTC-USD": 2, "ETH-USD": 2, "FIL-USD": 1 },
      fixedNotional: "250",
      maxExposure: "500",
    });
    // Isolated + có bậc margin (ETH): khoảng thanh lý; BTC / FIL không có bậc → null ("Not available").
    expect(all.rows.map((r) => r.liquidationPct)).toEqual([null, "48.5", null]);

    // Bỏ FIL: trần về như cũ (500 × 2×), không cần leverageByMarket.
    const two = await preview({ markets: ["BTC-USD", "ETH-USD"] });
    expect(two.markets).toEqual(["BTC-USD", "ETH-USD"]);
    expect(two.config.maxExposure).toBe("1000");
    expect(two.config.leverageByMarket).toBeUndefined();

    // Per-market, có trần Risk Center 4×: BTC 5 → 4, ETH 3.
    await env.pool.query(
      "insert into risk_limits (sodex_account_id, max_leverage, enforced) values ($1, 4, '{}')",
      [acct],
    );
    const per = await preview({
      markets: ["BTC-USD", "ETH-USD"],
      leverageByMarket: { "BTC-USD": 5, "ETH-USD": 3 },
    });
    expect(
      per.rows.filter((r) => r.selected).map((r) => [r.market, r.leverage, r.maxLeverage]),
    ).toEqual([
      ["BTC-USD", 4, 4],
      ["ETH-USD", 3, 4],
    ]);
    expect(per.config).toMatchObject({
      leverageByMarket: { "BTC-USD": 4, "ETH-USD": 3 },
      maxExposure: "1500",
    });

    // Market không thuộc trader, hay đòn bẩy > 5×: 400.
    expect((await post({ markets: ["DOGE-USD"] })).statusCode).toBe(400);
    expect((await post({ leverageByMarket: { "BTC-USD": 6 } })).statusCode).toBe(400);
    expect((await post({ markets: [] })).statusCode).toBe(400);

    // Bot tạo từ preview: sửa không gửi leverageByMarket thì giữ; đổi thì báo "locked".
    const made = await client.request("POST", "/api/v1/bots", {
      body: { strategy: "copy_trade", name: "Pick", paramSource: "manual", config: per.config },
    });
    expect(made.statusCode).toBe(201);
    const botId = botSummarySchema.parse(made.json()).id;
    const noPer = Object.fromEntries(
      Object.entries(per.config).filter(([k]) => k !== "leverageByMarket"),
    );
    const keep = await client.request("POST", `/api/v1/bots/${botId}/versions`, {
      body: { paramSource: "manual", config: { ...noPer, maxLoss: "90" } },
    });
    expect(keep.statusCode).toBe(202);
    const v = await env.pool.query<{ config: Record<string, unknown> }>(
      "select config from bot_versions where bot_id = $1 order by version desc limit 1",
      [botId],
    );
    expect(v.rows[0]?.config.leverageByMarket).toEqual({ "BTC-USD": 4, "ETH-USD": 3 });
    const change = await client.request("POST", `/api/v1/bots/${botId}/versions`, {
      body: {
        paramSource: "manual",
        config: { ...per.config, leverageByMarket: { "BTC-USD": 1, "ETH-USD": 3 } },
      },
    });
    expect(errorOf(change.json()).details.fieldErrors).toMatchObject({
      leverageByMarket: ["locked"],
    });
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
