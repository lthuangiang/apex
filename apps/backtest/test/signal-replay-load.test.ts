import { createDb, readOnlyTx, runMigrations, type Db } from "@drift/db";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  listPerpMarkets,
  loadCandles,
  loadFunding,
  loadMidAfter,
  loadMmFills,
  loadVbRoundTrips,
  loadWallets,
  loadWhaleEvents,
  whaleCoverage,
} from "../src/signal-replay/load";
import { runSignalReplay } from "../src/signal-replay/run";
import { snapshotAsOf, walletKey } from "../src/signal-replay/whales";

// Bộ nạp replay tín hiệu (#274): chỉ đọc (`readOnlyTx`), chống survivorship theo giờ xong của lần xếp hạng, sự kiện ứng
// viên, funding, ledger thật của bot VB / MM tiền thật (bot paper không bao giờ được tính). Testcontainers (chạy trên CI).

let container: StartedPostgreSqlContainer;
let db: Db;
let pool: ReturnType<typeof createDb>["pool"];
const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const START = Date.parse("2026-11-01T00:00:00Z");
const EVENT = START + 8 * DAY + 30 * MIN;
const M = "SRT-USD";

beforeAll(async () => {
  container = await new PostgreSqlContainer("timescale/timescaledb:2.16.1-pg16").start();
  await runMigrations(container.getConnectionUri());
  ({ db, pool } = createDb(container.getConnectionUri()));
  // 10 ngày nến 1 phút dao động 100–106 (chu kỳ 7 phút), và một market Spot không được tính.
  await pool.query(
    `insert into candles_1m (market, ts, open, high, low, close, volume)
     select $1, ts, p, p + 0.05, p - 0.05, p, 1
       from (select ts, 100 + ((extract(epoch from ts)::bigint / 60) % 7) * 1 as p
               from generate_series($2::timestamptz, $3::timestamptz, interval '1 minute') ts) x`,
    [M, new Date(START), new Date(START + 10 * DAY)],
  );
  await pool.query(
    "insert into candles_1m (market, ts, open, high, low, close, volume) values ('vX_vUSDC', $1, 1, 1, 1, 1, 1)",
    [new Date(START)],
  );
  // Lần xếp hạng ngày 8 xong TRƯỚC sự kiện, ngày 9 xong SAU.
  await pool.query(
    `insert into leaderboard_runs (date, status, candidates, computed, finished_at) values
       ('2026-11-08', 'ok', 1, 1, $1), ('2026-11-09', 'ok', 1, 1, $2)`,
    [new Date(START + 7 * DAY + HOUR), new Date(START + 8 * DAY + HOUR)],
  );
  const stats = (median: string) =>
    JSON.stringify({ winRate: "0.6", medianEntryNotional: median, profit: "1000" });
  await pool.query(
    `insert into leader_stats_daily (source, address, date, stats, hidden, tabs, profit, computed_at) values
       ('hyperliquid', '0xold', '2026-11-08', $1, '{}', '{}', 1000, now()),
       ('hyperliquid', '0xnew', '2026-11-09', $2, '{}', '{}', 1000, now())`,
    [stats("10000"), stats("10000")],
  );
  const ev = (
    addr: string,
    kind: string,
    market: string | null,
    at: number,
    seen: number,
    tid: string,
  ) =>
    pool.query(
      `insert into leader_events (id, source, address, coin, market, kind, position_before, position_after,
         notional, price, at, seen_at, last_tid)
       values (gen_random_uuid(), 'hyperliquid', $1, 'SRT', $2, $3, 0, 10, 50000, 100, $4, $5, $6)`,
      [addr, market, kind, new Date(at), new Date(seen), tid],
    );
  await ev("0xold", "open", M, EVENT - 20_000, EVENT, "1");
  await ev("0xnew", "open", M, EVENT - 20_000, EVENT + MIN, "2");
  await ev("0xold", "reduce", M, EVENT, EVENT + 2 * MIN, "3");
  await ev("0xold", "open", null, EVENT, EVENT + 3 * MIN, "4");
  await ev("0xold", "open", M, EVENT - DAY, EVENT + 4 * MIN, "5");
  await pool.query("insert into mid_1s (market, ts, mid) values ($1, $2, 100.42)", [
    M,
    new Date(EVENT + 2_000),
  ]);
  for (let i = 0; i < 24 * 9; i++)
    await pool.query("insert into funding_rates (market, funding_time, rate) values ($1, $2, $3)", [
      M,
      new Date(START + i * HOUR),
      i === 24 * 8 + 5 ? "0.01" : String((i % 5) / 1e6),
    ]);
});
afterAll(async () => {
  await pool.end();
  await container.stop();
});

async function one(text: string, p: unknown[]): Promise<string> {
  return (await pool.query<{ id: string }>(text, p)).rows[0]?.id ?? "";
}

async function bot(strategy: string, mode: "live" | "paper") {
  const user = await one(
    "insert into users (id, email) values (gen_random_uuid(), $1) returning id",
    [`s${String(Math.random())}@x.test`],
  );
  const acct = await one(
    "insert into sodex_accounts (id, user_id, address, sodex_account_id, network, status) values (gen_random_uuid(), $1, '0xabc', $2, 'mainnet', 'connected') returning id",
    [user, Math.floor(Math.random() * 1e9)],
  );
  const id = await one(
    "insert into bots (id, user_id, sodex_account_id, strategy, market, engine, name, state, mode) values (gen_random_uuid(), $1, $2, $3, $4, 'perps', 'B', 'running', $5) returning id",
    [user, acct, strategy, M, mode],
  );
  let n = 0;
  const fill = async (tag: string, side: string, price: string, size: string, at: number) => {
    n += 1;
    const order = await one(
      "insert into orders (id, bot_id, sodex_account_id, cl_ord_id, market, engine, side, type, time_in_force, size, filled_size, status, tag, epoch, created_at) values (gen_random_uuid(), $1, $2, $3, $4, 'perps', $5, 'limit', 'GTX', $6, $6, 'filled', $7, 1, $8) returning id",
      [id, acct, `${id}-${String(n)}`, M, side, size, tag, new Date(at - 1000)],
    );
    await pool.query(
      "insert into fills (id, order_id, sodex_trade_id, price, size, fee, builder_fee, is_maker, filled_at) values (gen_random_uuid(), $1, $2, $3, $4, '0.01', '0.001', true, $5)",
      [
        order,
        String(Date.now() * 1000 + Math.floor(Math.random() * 1000)),
        price,
        size,
        new Date(at),
      ],
    );
  };
  return { id, fill };
}

const ro = <T>(fn: Parameters<typeof readOnlyTx<T>>[2]) =>
  readOnlyTx(db, { statementTimeoutMs: 30_000, deadlineMs: 120_000 }, fn);

describe("signal replay loader", () => {
  it("reads markets, candles, funding and mid prices read-only", async () => {
    const r = await ro(async (q) => ({
      markets: await listPerpMarkets(q),
      candles: await loadCandles(q, M, new Date(START), new Date(START + HOUR)),
      funding: await loadFunding(q, M, new Date(START), new Date(START + DAY)),
      mid: await loadMidAfter(q, M, [EVENT, EVENT + MIN]),
    }));
    expect(r.markets).toEqual([M]);
    expect(r.candles).toHaveLength(60);
    expect(r.candles[0]?.ts).toBe(START);
    expect(r.candles[0]?.high.sub(r.candles[0].low).toString()).toBe("0.1");
    expect(r.funding).toHaveLength(24);
    expect(r.mid.get(EVENT)?.toString()).toBe("100.42");
    expect(r.mid.has(EVENT + MIN)).toBe(false);
  });

  it("keeps only open / add / flip events on SoDEX markets and ranks wallets by when the run finished", async () => {
    const r = await ro(async (q) => ({
      cov: await whaleCoverage(q, new Date(START), new Date(START + 10 * DAY)),
      events: await loadWhaleEvents(q, new Date(START + 8 * DAY), new Date(START + 9 * DAY)),
      wallets: await loadWallets(q, new Date(START + 10 * DAY)),
    }));
    expect(r.cov).toMatchObject({ eventsInRange: 5, notListedOnSodex: 1, notOpenOrAdd: 1 });
    expect(r.cov.delays).toEqual({ under1m: 1, under5m: 3, under1h: 0, over1h: 1 });
    expect(r.events.get(M)).toHaveLength(3);
    const old = r.wallets.get(walletKey("hyperliquid", "0xOLD"));
    expect(old?.[0]?.medianEntryNotional?.toString()).toBe("10000");
    // 0xnew chỉ có trong lần xếp hạng xong SAU sự kiện: không được tính (chống survivorship).
    expect(snapshotAsOf(r.wallets.get(walletKey("hyperliquid", "0xnew")), EVENT + MIN)).toBeNull();
    expect(snapshotAsOf(old, EVENT)?.date).toBe("2026-11-08");
  });

  it("replays real live VB / MM ledger fills only, never paper bots", async () => {
    const vb = await bot("volume_farm", "live");
    await vb.fill("vf:1:in:0", "buy", "100", "1", EVENT);
    await vb.fill("vf:1:out:0", "sell", "101", "1", EVENT + MIN);
    // Lượt 2 không bao giờ đóng: đếm ra, không bỏ im lặng.
    await vb.fill("vf:2:in:0", "buy", "100", "1", EVENT + 10 * MIN);
    const paper = await bot("volume_farm", "paper");
    await paper.fill("vf:1:in:0", "buy", "100", "1", EVENT);
    await paper.fill("vf:1:out:0", "sell", "101", "1", EVENT + MIN);
    const mm = await bot("volume_maker", "live");
    await mm.fill("mm:q", "buy", "100", "2", START + 7 * DAY);
    await mm.fill("mm:q", "sell", "100", "1", EVENT);
    await mm.fill("mm:q", "sell", "100", "3", EVENT + MIN);
    const r = await ro(async (q) => ({
      vb: await loadVbRoundTrips(q, new Date(START + 8 * DAY), new Date(START + 9 * DAY)),
      mm: await loadMmFills(q, new Date(START + 8 * DAY), new Date(START + 9 * DAY)),
    }));
    expect(r.vb.trades).toHaveLength(1);
    expect(r.vb.unclosed).toBe(1);
    // Giờ đặt lệnh vào (orders.created_at), không phải giờ khớp.
    expect(r.vb.trades[0]).toMatchObject({ botId: vb.id, side: "long", placedAt: EVENT - 1000 });
    expect(r.vb.trades[0]?.fees.toString()).toBe("0.02");
    // Vị thế đầu kỳ +2: bán 1 giảm (không mở), bán 3 thành −2 (mở).
    expect(r.mm.map((f) => f.opening)).toEqual([false, true]);
    expect(r.mm[0]?.markout).not.toBeNull();
  });

  it("runs the whole replay in one read-only transaction", async () => {
    const report = await ro((q, checkDeadline) =>
      runSignalReplay(q, {
        from: new Date(START + 8 * DAY),
        to: new Date(START + 9 * DAY),
        parts: ["whale", "funding", "price_structure", "risk_filter"],
        checkDeadline,
        log: () => undefined,
      }),
    );
    expect(report.funnels.whale).toMatchObject({
      events: 3,
      late: 1,
      notInLeaderboardBefore: 1,
      signals: 1,
    });
    const whale = report.groups.find((g) => g.type === "whale");
    const t = whale?.trades[0];
    expect(t).toMatchObject({ asset: M, direction: "long", label: "Replay", ruleVersion: "A-v1" });
    expect(t?.status === "entered" ? t.flags : [t?.skipReason]).toContain("entry_mid_1s");
    expect(t?.entry?.toString()).toBe("100.42");
    expect(report.funnels.funding?.signals).toBe(1);
    expect(report.coverage.funding?.perMarket[0]).toMatchObject({ market: M, points: 216 });
    expect(report.riskFilter?.volumeBuilder.baseline.n).toBe(1);
    expect(report.riskFilter?.volumeBuilder.unclosedRoundTrips).toBe(1);
    expect(report.coverage.whales?.limit).toMatch(/copy or follow/);
  });
});
