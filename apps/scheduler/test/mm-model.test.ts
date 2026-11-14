import { createDb, mmModelCoefs, runMigrations, type Db } from "@drift/db";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { fitMmModelDaily } from "../src/mm-model";

// Fit hệ số mô hình chi phí Market Making mỗi ngày (DEC-TBD-mm-cost-v1).

const DAY = 86_400_000;
const NOW = Date.parse("2026-11-15T03:00:00Z");
const START = Date.parse("2026-11-14T00:00:00Z");

let container: StartedPostgreSqlContainer;
let db: Db;
let pool: ReturnType<typeof createDb>["pool"];

beforeAll(async () => {
  container = await new PostgreSqlContainer("timescale/timescaledb:2.16.1-pg16").start();
  await runMigrations(container.getConnectionUri());
  ({ db, pool } = createDb(container.getConnectionUri()));
}, 120_000);
afterAll(async () => {
  await pool.end();
  await container.stop();
});

const q = (text: string, values: unknown[] = []) => pool.query(text, values);

/** Một bot MM live ở BTC-USD với 60 vòng lỗ 0,01 mỗi vòng trong ngày 14. */
async function botWithRounds(
  email: string,
  role: "team" | "user",
  quoteLevel: number,
  trade0: number,
) {
  const user = (
    await q("insert into users (id, email, role) values (gen_random_uuid(), $1, $2) returning id", [
      email,
      role,
    ])
  ).rows[0] as { id: string };
  const acct = (
    await q(
      "insert into sodex_accounts (id, user_id, address, sodex_account_id, network, status) values (gen_random_uuid(), $1, $2, $3, 'mainnet', 'connected') returning id",
      [user.id, `0x${trade0.toString(16).padStart(40, "0")}`, trade0],
    )
  ).rows[0] as { id: string };
  const bot = (
    await q(
      "insert into bots (id, user_id, sodex_account_id, strategy, market, engine, name, state) values (gen_random_uuid(), $1, $2, 'volume_maker', 'BTC-USD', 'perps', 'MM', 'running') returning id",
      [user.id, acct.id],
    )
  ).rows[0] as { id: string };
  const ver = (
    await q(
      "insert into bot_versions (id, bot_id, version, config, param_source, status) values (gen_random_uuid(), $1, 1, $2, 'manual', 'active') returning id",
      [bot.id, JSON.stringify({ market: "BTC-USD", quoteLevel })],
    )
  ).rows[0] as { id: string };
  await q("update bots set active_version_id = $1 where id = $2", [ver.id, bot.id]);
  for (let i = 0; i < 60; i += 1) {
    for (const [side, price, dt] of [
      ["buy", "100", 0],
      ["sell", "99.99", 20_000],
    ] as const) {
      const o = (
        await q(
          "insert into orders (id, bot_id, sodex_account_id, cl_ord_id, market, engine, side, type, time_in_force, size, status, tag, epoch) values (gen_random_uuid(), $1, $2, $3, 'BTC-USD', 'perps', $4, 'limit', 'GTX', 1, 'filled', 'x', 1) returning id",
          [bot.id, acct.id, `${bot.id}-${String(i)}-${side}`, side],
        )
      ).rows[0] as { id: string };
      await q(
        "insert into fills (id, order_id, sodex_trade_id, price, size, fee, is_maker, filled_at) values (gen_random_uuid(), $1, $2, $3, 1, 0, true, $4)",
        [
          o.id,
          trade0 + i * 2 + (side === "buy" ? 0 : 1),
          price,
          new Date(START + 3_600_000 + i * 60_000 + dt),
        ],
      );
    }
  }
}

describe("daily Market Making model fit", () => {
  it("fits k from team bots at quote level 0, leaves out a lone user's bot, and runs once a day", async () => {
    // 1440 nến 1m có volume, giá đổi 100 ↔ 100,02.
    const values = Array.from(
      { length: 1440 },
      (_, i) =>
        `('BTC-USD', to_timestamp(${String((START + i * 60_000) / 1000)}), 100, 100, 100, ${i % 2 ? "100.02" : "100"}, 1)`,
    );
    await q(
      `insert into candles_1m (market, ts, open, high, low, close, volume) values ${values.join(",")}`,
    );
    await botWithRounds("team@x.test", "team", 0, 1_000);
    await botWithRounds("team-back@x.test", "team", 1, 2_000); // quoteLevel 1: bỏ
    await botWithRounds("user@x.test", "user", 0, 3_000); // 1 tài khoản user: chưa đủ 3, bỏ
    const ticks = new Map([["BTC-USD", "0.01"]]);
    const r = await fitMmModelDaily(db, ticks, NOW);
    expect(r).toMatchObject({ status: "done", day: "2026-11-14", points: 1, a: "0.25" });
    // Mỗi vòng lỗ 0,01 trên volume 199,99 ≈ −0,5 bps; bước ≈ 1 bps; lợi nhuận 1 phút đổi dấu ±2 bps → dao động ≈ 2 bps
    // → k ≈ (0,25 × 1 + 0,5) / 2 = 0,375.
    expect(Number(r.k)).toBeCloseTo(0.375, 2);
    expect(await fitMmModelDaily(db, ticks, NOW + 3_600_000)).toMatchObject({ status: "skipped" });
    expect(await db.select().from(mmModelCoefs)).toHaveLength(1);
    // Ngày không có bot nào: không ghi gì.
    expect(await fitMmModelDaily(db, ticks, NOW + DAY)).toMatchObject({ status: "no-points" });
  });
});
