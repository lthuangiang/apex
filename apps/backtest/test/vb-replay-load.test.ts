import { createDb, DeadlineExceededError, readOnlyTx, runMigrations, type Db } from "@drift/db";
import { Decimal } from "@drift/shared";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { guardIdleKill, isIdleKill } from "../src/replay/abort";
import { loadEntries } from "../src/replay/load";

// Bộ nạp replay VB (#235): chỉ đọc (READ ONLY), ghép snapshot vào lượt đã đóng qua clOrdID của lệnh vào, bỏ lượt vào
// không khớp, giá 10 s từ mid_1s khi có, không thì nến 1 phút. Testcontainers (chạy trên CI).

let container: StartedPostgreSqlContainer;
let db: Db;
let pool: ReturnType<typeof createDb>["pool"];
const T0 = Date.parse("2026-11-12T10:00:00Z");

beforeAll(async () => {
  container = await new PostgreSqlContainer("timescale/timescaledb:2.16.1-pg16").start();
  await runMigrations(container.getConnectionUri());
  ({ db, pool } = createDb(container.getConnectionUri()));
});
afterAll(async () => {
  await pool.end();
  await container.stop();
});

const signal = (clOrdID: string) => ({
  v: 1,
  direction: "long",
  side: "long",
  score: 0.7,
  confidence: 0.6,
  regime: "SIDEWAY",
  components: {
    candleMomentum: 0.7,
    wickRejection: 0.5,
    volumeAcceleration: 0.6,
    tradePressure: 0.5,
    orderbookImbalance: 0.5,
  },
  spreadBps: 1,
  reason: "test",
  reversed: false,
  balanced: false,
  price: {
    bid: "99.99",
    ask: "100.01",
    mid: "100",
    last: "100",
    mark: null,
    bookAgeMs: 100,
    chg1mBps: 1,
    chg3mBps: 4,
    chg5mBps: null,
  },
  order: { clOrdID, price: "100", size: "1", usd: "100", holdSecs: 60, entryTry: 0, taker: false },
});

async function one(text: string, p: unknown[]): Promise<string> {
  return (await pool.query<{ id: string }>(text, p)).rows[0]?.id ?? "";
}

async function seed(market: string) {
  const user = await one(
    "insert into users (id, email) values (gen_random_uuid(), $1) returning id",
    [`r${String(Math.random())}@x.test`],
  );
  const acct = await one(
    "insert into sodex_accounts (id, user_id, address, sodex_account_id, network, status) values (gen_random_uuid(), $1, '0xabc', $2, 'mainnet', 'connected') returning id",
    [user, Math.floor(Math.random() * 1e9)],
  );
  const bot = await one(
    "insert into bots (id, user_id, sodex_account_id, strategy, market, engine, name, state, mode) values (gen_random_uuid(), $1, $2, 'volume_farm', $3, 'perps', 'Farm', 'running', 'live') returning id",
    [user, acct, market],
  );
  let n = 0;
  const fill = async (tag: string, side: string, price: string, at: number, clOrdId: string) => {
    n += 1;
    const order = await one(
      "insert into orders (id, bot_id, sodex_account_id, cl_ord_id, market, engine, side, type, time_in_force, size, filled_size, status, tag, epoch, created_at) values (gen_random_uuid(), $1, $2, $3, $4, 'perps', $5, 'limit', 'GTX', 1, 1, 'filled', $6, 1, $7) returning id",
      [bot, acct, clOrdId, market, side, tag, new Date(at - 1000)],
    );
    await pool.query(
      "insert into fills (id, order_id, sodex_trade_id, price, size, fee, builder_fee, is_maker, filled_at) values (gen_random_uuid(), $1, $2, $3, 1, '0.02', '0.005', true, $4)",
      [order, String(Date.now() * 1000 + n), price, new Date(at)],
    );
  };
  // Lượt 1: vào 100 lúc T0 + 2 s, ra 100.03 lúc T0 + 60 s. Lượt 2: lệnh vào không khớp (chỉ có event).
  await fill("vf:1:in:0", "buy", "100", T0 + 2000, "in-1");
  await fill("vf:1:out:0", "sell", "100.03", T0 + 60_000, "out-1");
  for (const [clOrdId, at] of [
    ["in-1", T0],
    ["in-2", T0 + 120_000],
  ] as const)
    await pool.query(
      "insert into bot_events (id, bot_id, type, decision, payload, occurred_at) values (gen_random_uuid(), $1, 'decision', 'Enter long', $2, $3)",
      [bot, JSON.stringify({ signal: signal(clOrdId) }), new Date(at)],
    );
  // Event có snapshot hỏng: bị bỏ, đếm vào `invalid`.
  await pool.query(
    "insert into bot_events (id, bot_id, type, decision, payload, occurred_at) values (gen_random_uuid(), $1, 'decision', 'Enter long', $2, $3)",
    [bot, JSON.stringify({ signal: { v: 2 } }), new Date(T0 + 180_000)],
  );
  return bot;
}

describe("VB replay loader", () => {
  it("matches snapshots to closed trades read-only, with the 10 s price from mid_1s or the candle", async () => {
    const withMid = `RM${String(Math.floor(Math.random() * 1e6))}-USD`;
    const candleOnly = `RC${String(Math.floor(Math.random() * 1e6))}-USD`;
    await seed(withMid);
    await seed(candleOnly);
    for (let s = 0; s <= 10; s++)
      await pool.query("insert into mid_1s (market, ts, mid) values ($1, $2, $3)", [
        withMid,
        new Date(T0 + s * 1000),
        s === 4 ? "99.97" : "100",
      ]);
    for (const m of [withMid, candleOnly])
      await pool.query(
        "insert into candles_1m (market, ts, open, high, low, close, volume) values ($1, $2, 100, 100.05, 99.9, 100, 1)",
        [m, new Date(T0)],
      );
    // Đúng đường của CLI: `readOnlyTx` + trần thời gian.
    const result = await readOnlyTx(
      db,
      { statementTimeoutMs: 30_000, deadlineMs: 60_000 },
      (q, checkDeadline) =>
        loadEntries(q, {
          from: new Date(T0 - 60_000),
          to: new Date(T0 + 3_600_000),
          now: T0 + 86_400_000,
          ticks: new Map([[withMid, new Decimal("0.01")]]),
          checkDeadline,
        }),
    );
    expect(result.invalid).toBe(2);
    expect(result.unmatched).toBe(2);
    expect(result.entries).toHaveLength(2);
    expect(result.reach).toEqual({ mid1s: 1, candle: 1, none: 0 });
    const mid = result.entries.find((e) => e.market === withMid);
    expect(mid?.entryPrice.toString()).toBe("100");
    expect(mid?.exitPrice.toString()).toBe("100.03");
    expect(mid?.fees.toString()).toBe("0.04");
    expect(mid?.chgBps).toEqual({ m1: 1, m3: 4, m5: null });
    expect(mid?.reach?.source).toBe("mid_1s");
    expect(mid?.reach?.low.toString()).toBe("99.97");
    expect(mid?.tick?.toString()).toBe("0.01");
    const candle = result.entries.find((e) => e.market === candleOnly);
    expect(candle?.reach?.source).toBe("candle");
    expect(candle?.reach?.low.toString()).toBe("99.9");
    expect(candle?.tick).toBeNull();
  });
});

/** SQLSTATE của lỗi pg, kể cả khi drizzle bọc trong `cause`. */
const code = (e: unknown): unknown =>
  typeof e === "object" && e !== null
    ? "code" in e
      ? e.code
      : "cause" in e
        ? code(e.cause)
        : undefined
    : undefined;

describe("readOnlyTx", () => {
  it("rejects writes inside the transaction (SQLSTATE 25006)", async () => {
    const err = await readOnlyTx(db, { statementTimeoutMs: 5_000 }, (q) =>
      q.execute(sql`insert into users (id, email) values (gen_random_uuid(), 'ro@x.test')`),
    ).catch((e: unknown) => e);
    expect(code(err)).toBe("25006");
    const n = await pool.query("select count(*)::int as n from users where email = 'ro@x.test'");
    expect(n.rows[0]).toEqual({ n: 0 });
  });

  it("sets per-statement and idle limits, and stops at the overall deadline", async () => {
    const limits = await readOnlyTx(
      db,
      { statementTimeoutMs: 1_234, idleTimeoutMs: 5_678 },
      async (q) => {
        const r = await q.execute(
          sql`select current_setting('statement_timeout') as st, current_setting('idle_in_transaction_session_timeout') as idle, current_setting('transaction_read_only') as ro`,
        );
        return (r as unknown as { rows: unknown[] }).rows[0];
      },
    );
    expect(limits).toEqual({ st: "1234ms", idle: "5678ms", ro: "on" });
    // Idle timeout chỉ đặt khi truyền `idleTimeoutMs` (opt-in).
    const idle = await readOnlyTx(db, { statementTimeoutMs: 1_000 }, async (q) => {
      const r = await q.execute(
        sql`select current_setting('idle_in_transaction_session_timeout') as idle`,
      );
      return (r as unknown as { rows: unknown[] }).rows[0];
    });
    expect(idle).toEqual({ idle: "0" });
    await expect(
      readOnlyTx(db, { statementTimeoutMs: 5_000, deadlineMs: 1 }, async (q, checkDeadline) => {
        await q.execute(sql`select pg_sleep(0.05)`);
        checkDeadline();
      }),
    ).rejects.toBeInstanceOf(DeadlineExceededError);
  });

  it("cancels a query that runs past the statement timeout (SQLSTATE 57014)", async () => {
    const err = await readOnlyTx(db, { statementTimeoutMs: 100 }, (q) =>
      q.execute(sql`select pg_sleep(2)`),
    ).catch((e: unknown) => e);
    expect(code(err)).toBe("57014");
  });

  it("reports an idle-in-transaction kill (FATAL 25P03) to the handler instead of crashing", async () => {
    // Pool riêng, như CLI: handler gắn cho client mới của pool.
    const own = createDb(container.getConnectionUri());
    const onKill = vi.fn();
    const onOther = vi.fn();
    const remove = guardIdleKill(own.pool, onKill, onOther);
    try {
      const err = await readOnlyTx(
        own.db,
        { statementTimeoutMs: 5_000, idleTimeoutMs: 200 },
        async (q) => {
          // Ngồi im lâu hơn idle timeout: Postgres cắt phiên.
          await new Promise((r) => setTimeout(r, 1_500));
          return q.execute(sql`select 1`);
        },
      ).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      expect(onKill).toHaveBeenCalled();
      expect(onOther).not.toHaveBeenCalled();
      expect(isIdleKill({ code: "25P03" })).toBe(true);
    } finally {
      remove();
      await own.pool.end();
    }
  });
});
