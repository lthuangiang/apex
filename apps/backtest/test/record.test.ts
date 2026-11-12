import { createDb, runMigrations, type Db } from "@drift/db";
import type { Kline, PerpsSymbol, SpotSymbol } from "@drift/sodex";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runRecord } from "../src/record";
import type { RunDeps } from "../src/run";

// AI Desk B+ M4 (DEC-177): đo thành tích Volume Builder = lượt thật sau khi sửa so với replay cấu hình
// cũ trên đúng các lượt vào đó; ít lượt → không đo (không ghi 0). Nhãn (kể cả Made it worse) test ở `verdictOf`.

const APPLIED = Date.parse("2026-11-01T00:00:00Z");
const NOW = Date.parse("2026-11-12T00:00:00Z");
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
const farm = (slMarginPct: string) => ({
  market: "BTC-USD",
  leverage: 25,
  marginMode: "isolated",
  orderSizeMinUsd: "100",
  orderSizeMaxUsd: "100",
  minHoldSecs: 180,
  maxHoldSecs: 300,
  slMarginPct,
  maxLoss: "50",
});

/**
 * Bot Volume Farm: version 1 = `baseline`, version 2 (AI) áp lúc APPLIED; `trades` lượt long 100 USDC vào 100 ra 100
 * sau 200 s (phí maker 0.018 mỗi chiều) trong 7 ngày; `nextAfterDays` = version 3 áp sau chừng đó ngày.
 */
async function seed(
  trades: number,
  baseline: Record<string, unknown>,
  nextAfterDays: number | null = null,
): Promise<string> {
  const q = async (sql: string, p: unknown[]) =>
    (await pool.query<{ id: string }>(sql, p)).rows[0]?.id ?? "";
  const user = await q(
    "insert into users (id, email) values (gen_random_uuid(), $1) returning id",
    [`m${String(Math.random())}@x.test`],
  );
  const acct = await q(
    "insert into sodex_accounts (id, user_id, address, sodex_account_id, network, status) values (gen_random_uuid(), $1, '0xabc', $2, 'mainnet', 'connected') returning id",
    [user, Math.floor(Math.random() * 1e9)],
  );
  const bot = await q(
    "insert into bots (id, user_id, sodex_account_id, strategy, market, engine, name, state, mode) values (gen_random_uuid(), $1, $2, 'volume_farm', 'BTC-USD', 'perps', 'Farm', 'running', 'live') returning id",
    [user, acct],
  );
  const versions: [number, Record<string, unknown>, number][] = [
    [1, baseline, APPLIED - 86_400_000],
    [2, farm("80"), APPLIED],
  ];
  if (nextAfterDays !== null) versions.push([3, farm("80"), APPLIED + nextAfterDays * 86_400_000]);
  for (const [version, config, at] of versions)
    await pool.query(
      "insert into bot_versions (id, bot_id, version, config, param_source, status, applied_at) values (gen_random_uuid(), $1, $2, $3, 'manual', 'active', $4)",
      [bot, version, JSON.stringify(config), new Date(at)],
    );
  for (let i = 0; i < trades; i += 1) {
    const at = APPLIED + 86_400_000 + i * 6 * 3_600_000;
    for (const [leg, side, t] of [
      ["in", "buy", at],
      ["out", "sell", at + 200_000],
    ] as const) {
      const order = await q(
        "insert into orders (id, bot_id, sodex_account_id, cl_ord_id, market, engine, side, type, time_in_force, size, status, tag, epoch) values (gen_random_uuid(), $1, $2, $3, 'BTC-USD', 'perps', $4, 'limit', 'GTX', '1', 'filled', $5, 1) returning id",
        [
          bot,
          acct,
          `r${String(i)}${leg}${String(Math.random())}`,
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
  const whatif = await q(
    "insert into desk_whatifs (id, item_id, user_id, bot_id, bot_version, item_fingerprint, status, options, window_from, window_to) values (gen_random_uuid(), $1, $2, $3, 1, 'f', 'done', '[]', now(), now()) returning id",
    [item, user, bot],
  );
  return q(
    "insert into desk_applies (id, whatif_id, user_id, bot_id, rule, option, from_version, to_version, baseline_config, applied_at, record_status) values (gen_random_uuid(), $1, $2, $3, 'liquidation_before_stop', 'tighter_stop', 1, 2, $4, $5, 'queued') returning id",
    [whatif, user, bot, JSON.stringify(baseline), new Date(APPLIED)],
  );
}

const load = async (id: string) =>
  (
    await pool.query<{
      record_status: string;
      verdict: string | null;
      record: {
        source: string;
        after: string;
        old: string;
        trades: number | null;
        to: string;
      } | null;
      record_error: string | null;
    }>("select record_status, verdict, record, record_error from desk_applies where id = $1", [id])
  ).rows[0];
const deps = { db: undefined as unknown as Db, rest, now: () => new Date(NOW) };

describe("track record worker", () => {
  it("compares the real trades with the old settings replayed on the same entries", async () => {
    // Cấu hình cũ: SL 25% margin ở 25× = 1% giá, chạm stop mỗi lượt khi giá rơi 2%. Sau khi sửa: lượt thật hoà giá.
    const id = await seed(6, farm("25"));
    await runRecord({ ...deps, db }, id);
    const r = await load(id);
    expect(r).toMatchObject({ record_status: "done", verdict: "helped", record_error: null });
    expect(r?.record).toMatchObject({ source: "replay", trades: 6, after: "-0.22" });
    expect(Number(r?.record?.old)).toBeLessThan(-0.5);
  });

  it("does not measure with too few trades, and never writes a zero", async () => {
    const id = await seed(2, farm("25"));
    await runRecord({ ...deps, db }, id);
    expect(await load(id)).toMatchObject({
      record_status: "unavailable",
      record_error: "not_enough_trades",
      record: null,
      verdict: null,
    });
  });

  it("only measures the days the AI version ran", async () => {
    // 6 lượt cách nhau 6 giờ từ ngày 2; version 3 áp sau 1.5 ngày → chỉ 2 lượt trong cửa sổ.
    const id = await seed(6, farm("25"), 1.5);
    await runRecord({ ...deps, db }, id);
    expect(await load(id)).toMatchObject({
      record_status: "unavailable",
      record_error: "not_enough_trades",
    });
  });
});
