import { candles1m, createDb, runMigrations, signalPaperTrades, type Db } from "@drift/db";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { fillRandomBaselines, randomReplayFrom } from "../src/signal-research/baseline";

// #405 (DEC-354): random baseline phát lại nến từ phút sau lúc vào lệnh THẬT (`opened_clock_at`),
// không từ đầu chu kỳ (`opened_at`). Lệnh cũ chưa có `opened_clock_at` vẫn chạy như trước. Postgres thật (testcontainers),
// lệnh giấy chèn thẳng như scheduler ghi.

const MIN = 60_000;
const HOUR = 60 * MIN;
/** Đầu chu kỳ (`opened_at`). */
const T0 = Date.parse("2026-11-18T12:00:00Z");
/** Lúc vào lệnh thật: 3 phút 20 giây sau đầu chu kỳ. */
const CLOCK = T0 + 3 * MIN + 20_000;
const HOLD_END = T0 + 3 * HOUR;

let container: StartedPostgreSqlContainer;
let db: Db;
let pool: ReturnType<typeof createDb>["pool"];

beforeAll(async () => {
  container = await new PostgreSqlContainer("timescale/timescaledb:2.16.1-pg16").start();
  await runMigrations(container.getConnectionUri());
  ({ db, pool } = createDb(container.getConnectionUri()));
  // Nến 1 phút ETH-USD: phút 12:01 vọt lên 102 (trước lúc vào lệnh thật, chạm TP long 101.6 và SL short 100.8); 12:02 và
  // 12:03 đi ngang 100; từ 12:04 (phút sau lúc vào) đi ngang 100.5 tới hết giữ tối đa, không chạm TP / SL nào.
  const rows = [];
  for (let ts = T0 + MIN; ts < HOLD_END; ts += MIN) {
    const spike = ts === T0 + MIN;
    const px = ts < T0 + 4 * MIN ? "100" : "100.5";
    rows.push({
      market: "ETH-USD",
      ts: new Date(ts),
      open: px,
      high: spike ? "102" : px,
      low: px,
      close: px,
      volume: "1",
    });
  }
  await db.insert(candles1m).values(rows);
});
afterAll(async () => {
  await pool.end();
  await container.stop();
});
beforeEach(async () => {
  await db.execute(sql`truncate signal_paper_trades`);
});

/** Một lệnh news long đã đóng, entry 100, TP 1.6 %, SL 0.8 %, phí 0.05 % mỗi chiều + spread 0.01 %. */
async function trade(id: string, openedClockAt: Date | null) {
  await pool.query(
    `insert into signal_paper_trades (id, lane, label, story_id, article_id, market, token, catalyst, direction, size_usdc,
       qty, entry_price, entry_mid, spread_at_entry_pct, fee_pct, entry_fee, typical_move_pct, tp_pct, sl_pct, tp_price, sl_price,
       max_hold_until, event_at, seen_at, opened_at, opened_clock_at, level_at_entry, sources_at_entry, outside_market_hours,
       price_source, status, exit_price, exit_reason, exited_at, exit_fee, result_usdc, result_pct, rule_version)
     values ($1::uuid, 'news', 'live', gen_random_uuid(), 'a-' || $1::text, 'ETH-USD', 'ETH', 'etf_approved', 'long', 500, 5, 100, 100,
       0.01, 0.05, 0.25, 1, 1.6, 0.8, 101.6, 99.2, $2, $3, $3, $3, $4, 'medium', '[]', false, 'book', 'closed', 100.5,
       'max_hold', $2, 0.25, 2.5, 0.5, 'news-v4')`,
    [
      id,
      new Date(HOLD_END).toISOString(),
      new Date(T0).toISOString(),
      openedClockAt?.toISOString() ?? null,
    ],
  );
}

async function random(id: string) {
  const [t] = await db.select().from(signalPaperTrades).where(eq(signalPaperTrades.id, id));
  return t;
}

describe("random baseline replays from the real entry clock (#405)", () => {
  it("randomReplayFrom: the minute after opened_clock_at; without it, the minute after opened_at", () => {
    expect(randomReplayFrom({ openedAt: new Date(T0), openedClockAt: new Date(CLOCK) })).toBe(
      T0 + 4 * MIN,
    );
    expect(randomReplayFrom({ openedAt: new Date(T0 + 20_000), openedClockAt: null })).toBe(
      T0 + MIN,
    );
  });

  it("a move between the cycle start and the real entry does not count: no TP / SL from the 12:01 spike", async () => {
    await trade("00000000-0000-4000-8000-000000000001", new Date(CLOCK));
    expect(await fillRandomBaselines(db, HOLD_END + HOUR)).toBe(1);
    const t = await random("00000000-0000-4000-8000-000000000001");
    // Long: không chạm gì, đóng ở 100.5 → +0.5 % − 0.11 % chi phí. Short: −0.5 % − 0.11 %.
    expect(t?.randomLongPct).toBe("0.390000000000000000");
    expect(t?.randomShortPct).toBe("-0.610000000000000000");
    expect(t?.randomDoneAt).not.toBeNull();
  });

  it("an old trade without opened_clock_at still replays from opened_at, as before", async () => {
    await trade("00000000-0000-4000-8000-000000000002", null);
    expect(await fillRandomBaselines(db, HOLD_END + HOUR)).toBe(1);
    const t = await random("00000000-0000-4000-8000-000000000002");
    // Từ 12:01: long chạm TP 1.6 %, short chạm SL 0.8 % ở cây nến vọt lên.
    expect(t?.randomLongPct).toBe("1.490000000000000000");
    expect(t?.randomShortPct).toBe("-0.910000000000000000");
  });

  it("a baseline already stored is not computed again", async () => {
    await trade("00000000-0000-4000-8000-000000000003", new Date(CLOCK));
    await db
      .update(signalPaperTrades)
      .set({ randomLongPct: "1.49", randomShortPct: "-0.91", randomDoneAt: new Date(HOLD_END) })
      .where(eq(signalPaperTrades.id, "00000000-0000-4000-8000-000000000003"));
    expect(await fillRandomBaselines(db, HOLD_END + HOUR)).toBe(0);
    const t = await random("00000000-0000-4000-8000-000000000003");
    expect(t?.randomLongPct).toBe("1.490000000000000000");
  });
});
