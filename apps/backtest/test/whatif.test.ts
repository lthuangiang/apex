import { createDb, runMigrations, type Db } from "@drift/db";
import type { WhatIfOptionResult } from "@drift/shared";
import type { Kline, PerpsSymbol, SpotSymbol } from "@drift/sodex";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { RunDeps } from "../src/run";
import { runWhatif } from "../src/whatif";

// AI Desk B+ M2 (DEC-166): job what-if replay lượt vào thật của Volume Builder trong cửa sổ 7 ngày.

const NOW = Date.parse("2026-11-12T00:00:00Z");
const FROM = NOW - 7 * 86_400_000;
const MIN = 60_000;

let container: StartedPostgreSqlContainer;
let db: Db;
let pool: ReturnType<typeof createDb>["pool"];

beforeAll(async () => {
  container = await new PostgreSqlContainer("timescale/timescaledb:2.16.1-pg16").start();
  await runMigrations(container.getConnectionUri());
  ({ db, pool } = createDb(container.getConnectionUri()));
});
afterAll(async () => {
  await pool.end();
  await container.stop();
});

const symbol = {
  name: "BTC-USD",
  status: "TRADING",
  tickSize: "0.01",
  stepSize: "0.0001",
  minQuantity: "0.0001",
  minNotional: "5",
} as unknown as PerpsSymbol;
/** Nến 1 phút: giá 100, mỗi phút rơi về 98 (−2%). */
const rest: RunDeps["rest"] = {
  getSpotSymbols: () => Promise.resolve([] as SpotSymbol[]),
  getPerpsSymbols: () => Promise.resolve([symbol]),
  getKlines: (_e, _m, q) => {
    const out: Kline[] = [];
    for (let t = q.startTime ?? 0; t <= (q.endTime ?? 0) && out.length < q.limit; t += MIN)
      out.push({ t, o: "100", h: "100", l: "98", c: "98", v: "1", q: "1", n: 1 });
    return Promise.resolve(out.reverse());
  },
};
const farm = {
  market: "BTC-USD",
  leverage: 25,
  marginMode: "isolated",
  orderSizeMinUsd: "100",
  orderSizeMaxUsd: "100",
  minHoldSecs: 180,
  maxHoldSecs: 300,
  slMarginPct: "80",
  maxLoss: "50",
};

/** Bot Volume Farm + `trades` lượt long 100 USDC (vào 100, ra 100 sau 200 s) trong cửa sổ + một việc + một what-if. */
async function seed(trades: number, options: WhatIfOptionResult[]): Promise<string> {
  const q = async (sql: string, p: unknown[]) =>
    (await pool.query<{ id: string }>(sql, p)).rows[0]?.id ?? "";
  const user = await q(
    "insert into users (id, email) values (gen_random_uuid(), $1) returning id",
    [`w${String(Math.random())}@x.test`],
  );
  const acct = await q(
    "insert into sodex_accounts (id, user_id, address, sodex_account_id, network, status) values (gen_random_uuid(), $1, '0xabc', $2, 'mainnet', 'connected') returning id",
    [user, Math.floor(Math.random() * 1e9)],
  );
  const bot = await q(
    "insert into bots (id, user_id, sodex_account_id, strategy, market, engine, name, state, mode) values (gen_random_uuid(), $1, $2, 'volume_farm', 'BTC-USD', 'perps', 'Farm', 'running', 'live') returning id",
    [user, acct],
  );
  const version = await q(
    "insert into bot_versions (id, bot_id, version, config, param_source, status, applied_at) values (gen_random_uuid(), $1, 1, $2, 'manual', 'active', now()) returning id",
    [bot, JSON.stringify(farm)],
  );
  await pool.query("update bots set active_version_id = $2 where id = $1", [bot, version]);
  for (let i = 0; i < trades; i += 1) {
    const at = FROM + 86_400_000 + i * 30 * MIN;
    for (const [leg, side, t] of [
      ["in", "buy", at],
      ["out", "sell", at + 200_000],
    ] as const) {
      const order = await q(
        "insert into orders (id, bot_id, sodex_account_id, cl_ord_id, market, engine, side, type, time_in_force, size, status, tag, epoch) values (gen_random_uuid(), $1, $2, $3, 'BTC-USD', 'perps', $4, 'limit', 'GTX', '1', 'filled', $5, 1) returning id",
        [
          bot,
          acct,
          `c${String(i)}${leg}${String(Math.random())}`,
          side,
          `vf:${String(i)}:${leg}:0`,
        ],
      );
      await pool.query(
        "insert into fills (id, order_id, sodex_trade_id, price, size, fee, is_maker, filled_at) values (gen_random_uuid(), $1, $2, '100', '1', '0.018', true, $3)",
        [order, Math.floor(Math.random() * 1e12), new Date(t)],
      );
    }
  }
  const item = await q(
    "insert into desk_items (id, user_id, bot_id, rule, severity, facts, fingerprint, badness, last_seen_at) values (gen_random_uuid(), $1, $2, 'liquidation_before_stop', 3, '[]', 'f', '0', now()) returning id",
    [user, bot],
  );
  return q(
    "insert into desk_whatifs (id, item_id, user_id, bot_id, bot_version, item_fingerprint, status, options, window_from, window_to) values (gen_random_uuid(), $1, $2, $3, 1, 'f', 'queued', $4, $5, $6) returning id",
    [item, user, bot, JSON.stringify(options), new Date(FROM), new Date(NOW)],
  );
}

const opts: WhatIfOptionResult[] = [
  { key: "keep", patch: {}, outcome: null, unavailable: null },
  // SL 25% margin ở 25× = 1% giá: chạm stop khi giá rơi 2%.
  { key: "tighter_stop", patch: { slMarginPct: "25" }, outcome: null, unavailable: null },
  // Đòn bẩy 0 không hợp lệ: phương án không chạy được.
  { key: "lower_leverage", patch: { leverage: 0 }, outcome: null, unavailable: null },
];
const load = async (id: string) =>
  (
    await pool.query<{
      status: string;
      source: string | null;
      options: WhatIfOptionResult[];
      error: string | null;
    }>("select status, source, options, error from desk_whatifs where id = $1", [id])
  ).rows[0];

describe("what-if worker", () => {
  it("replays every option on the same real entries, counting stop exits, and marks invalid options", async () => {
    const id = await seed(6, opts);
    await runWhatif({ db, rest, now: () => new Date(NOW) }, id);
    const w = await load(id);
    expect(w).toMatchObject({ status: "done", source: "replay", error: null });
    const [keep, tight, bad] = w?.options ?? [];
    // Giữ nguyên: SL 80% margin ở 25× = 3.2% giá không chạm, ra theo giờ giữ ở 98.
    expect(keep?.outcome).toMatchObject({ trades: 6, closedBySodex: 0, marginPerTrade: "4" });
    expect(tight?.outcome).toMatchObject({ trades: 6, closedBySodex: 6 });
    expect(Number(tight?.outcome?.net)).toBeGreaterThan(Number(keep?.outcome?.net));
    expect(bad).toMatchObject({ outcome: null, unavailable: "invalid_config" });

    // Cùng dữ liệu → cùng kết quả.
    const again = await seed(6, opts);
    await runWhatif({ db, rest, now: () => new Date(NOW) }, again);
    expect((await load(again))?.options.map((o) => o.outcome)).toEqual(
      w?.options.map((o) => o.outcome),
    );
  });

  it("says not enough trades instead of showing zero", async () => {
    const id = await seed(2, opts);
    await runWhatif({ db, rest, now: () => new Date(NOW) }, id);
    const w = await load(id);
    expect(w?.status).toBe("done");
    expect(
      w?.options.every((o) => o.outcome === null && o.unavailable === "not_enough_trades"),
    ).toBe(true);
  });

  it("stops when the bot moved to another version", async () => {
    const id = await seed(6, opts);
    await pool.query("update desk_whatifs set bot_version = 9 where id = $1", [id]);
    await runWhatif({ db, rest, now: () => new Date(NOW) }, id);
    expect(await load(id)).toMatchObject({ status: "unavailable", error: "version_changed" });
  });
});
