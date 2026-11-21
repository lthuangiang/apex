import {
  bots,
  createDb,
  insertNewsSignal,
  insertNewsSignalDelivery,
  newsSignalCommands,
  newsSignalDeliveries,
  newsSignals,
  newsSignalTrades,
  runMigrations,
  signalBotVersions,
  sodexAccounts,
  unexpiredNewsSignals,
  users,
  type Db,
  type NewNewsSignal,
} from "@drift/db";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Schema bot `news_signal` mainnet (#419 PR 2, migration 0059) trên Postgres thật: tín hiệu bất biến và idempotent,
// delivery một lần mỗi bot, một lệnh open / closing mỗi account × market, command unique theo seq, FK
// `bots.signal_version_id`. Không có SoDEX, không có logic giao dịch.

const T0 = Date.parse("2026-11-22T10:00:00Z");

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

/** Lỗi Postgres gốc (drizzle bọc lỗi của `pg` trong `cause`). */
async function pgError(p: Promise<unknown>): Promise<{ code?: string; constraint?: string }> {
  try {
    await p;
  } catch (e) {
    const err = e as { cause?: unknown };
    return (err.cause ?? e) as { code?: string; constraint?: string };
  }
  throw new Error("expected the query to fail");
}

let n = 0;
function signal(over: Partial<NewNewsSignal> = {}): NewNewsSignal {
  n += 1;
  const decidedAt = new Date(T0);
  return {
    storyKey: `SOL-USD:listing:${String(n)}`,
    cycleAt: new Date(T0),
    articleId: `a${String(n)}`,
    market: "SOL-USD",
    kind: "crypto",
    catalyst: "listing",
    side: "long",
    level: "high",
    firstPublishedAt: new Date(T0 - 60_000),
    collectedAt: new Date(T0 - 30_000),
    decidedAt,
    expiresAt: new Date(T0 + 120_000),
    quoteBid: "100.1",
    quoteAsk: "100.3",
    quoteMid: "100.2",
    quoteAt: new Date(T0 - 1_000),
    typicalByHoldHours: { "24": "1.8", "48": null },
    classifierVersion: "classifier-v1",
    assetMapVersion: "assets-v1",
    ruleVersion: "news-v3",
    ...over,
  };
}

async function account(): Promise<{ userId: string; accountId: string }> {
  const [u] = await db
    .insert(users)
    .values({ email: `${String(Math.random())}@x.test` })
    .returning();
  const [a] = await db
    .insert(sodexAccounts)
    .values({
      userId: u?.id ?? "",
      address: "0x4E1e4796c10C637EDAB56461450BD8D02EFb29Db",
      sodexAccountId: BigInt(Math.floor(Math.random() * 1e9)),
      network: "mainnet",
      status: "connected",
    })
    .returning();
  return { userId: u?.id ?? "", accountId: a?.id ?? "" };
}

async function bot(
  acc: { userId: string; accountId: string },
  signalVersionId: string | null = null,
): Promise<string> {
  const [b] = await db
    .insert(bots)
    .values({
      userId: acc.userId,
      sodexAccountId: acc.accountId,
      strategy: "news_signal",
      market: "SOL-USD",
      engine: "perps",
      name: "News",
      state: "running",
      signalVersionId,
    })
    .returning();
  return b?.id ?? "";
}

async function baselineId(): Promise<string> {
  const [v] = await db
    .select({ id: signalBotVersions.id })
    .from(signalBotVersions)
    .where(eq(signalBotVersions.isBaseline, true));
  return v?.id ?? "";
}

function trade(
  over: Partial<typeof newsSignalTrades.$inferInsert> &
    Pick<typeof newsSignalTrades.$inferInsert, "botId" | "sodexAccountId" | "signalId" | "seq">,
): typeof newsSignalTrades.$inferInsert {
  return {
    market: "SOL-USD",
    side: "long",
    status: "open",
    sizeUsdc: "200",
    entryLimitPrice: "100.5",
    maxHoldUntil: new Date(T0 + 24 * 3_600_000),
    openedAt: new Date(T0),
    ...over,
  };
}

describe("news_signals", () => {
  it("inserts idempotently on (story_key, cycle_at) and never overwrites", async () => {
    const s = signal();
    const first = await insertNewsSignal(db, s);
    expect(first.created).toBe(true);
    expect(first.signal.typicalByHoldHours).toEqual({ "24": "1.8", "48": null });

    const again = await insertNewsSignal(db, { ...s, level: "low", quoteMid: "1" });
    expect(again.created).toBe(false);
    expect(again.signal.id).toBe(first.signal.id);
    expect(again.signal.level).toBe("high");
    expect(again.signal.quoteMid).toBe(first.signal.quoteMid);

    const rows = await db.select().from(newsSignals).where(eq(newsSignals.storyKey, s.storyKey));
    expect(rows).toHaveLength(1);

    // Cùng câu chuyện ở chu kỳ khác là một tín hiệu mới.
    const next = await insertNewsSignal(db, { ...s, cycleAt: new Date(T0 + 60_000) });
    expect(next.created).toBe(true);
    expect(next.signal.id).not.toBe(first.signal.id);
  });

  it("rejects a plain duplicate insert with the unique index", async () => {
    const s = signal();
    await insertNewsSignal(db, s);
    const err = await pgError(db.insert(newsSignals).values(s));
    expect(err).toMatchObject({ code: "23505", constraint: "news_signals_story_cycle_uq" });
  });

  it("is immutable: the trigger blocks UPDATE and DELETE", async () => {
    const { signal: s } = await insertNewsSignal(db, signal());
    await expect(
      pool.query("update news_signals set level = 'low' where id = $1", [s.id]),
    ).rejects.toThrow(/news signal is immutable/);
    await expect(pool.query("delete from news_signals where id = $1", [s.id])).rejects.toThrow(
      /news signal is immutable/,
    );
    const [row] = await db.select().from(newsSignals).where(eq(newsSignals.id, s.id));
    expect(row?.level).toBe("high");
  });

  it("checks side, kind, level and expiry", async () => {
    expect(await pgError(db.insert(newsSignals).values(signal({ side: "flip" })))).toMatchObject({
      code: "23514",
      constraint: "news_signals_side_ck",
    });
    expect(await pgError(db.insert(newsSignals).values(signal({ kind: "fx" })))).toMatchObject({
      constraint: "news_signals_kind_ck",
    });
    expect(await pgError(db.insert(newsSignals).values(signal({ level: "x" })))).toMatchObject({
      constraint: "news_signals_level_ck",
    });
    expect(
      await pgError(db.insert(newsSignals).values(signal({ expiresAt: new Date(T0) }))),
    ).toMatchObject({ constraint: "news_signals_expiry_ck" });
  });

  it("reads signals until expires_at inclusive, oldest first", async () => {
    const base = Date.parse("2030-01-01T00:00:00Z");
    const live1 = await insertNewsSignal(
      db,
      signal({ decidedAt: new Date(base), expiresAt: new Date(base + 120_000) }),
    );
    const live2 = await insertNewsSignal(
      db,
      signal({ decidedAt: new Date(base + 10_000), expiresAt: new Date(base + 130_000) }),
    );
    await insertNewsSignal(
      db,
      signal({ decidedAt: new Date(base - 200_000), expiresAt: new Date(base - 80_000) }),
    );
    const now = new Date(base + 60_000);
    const rows = await unexpiredNewsSignals(db, now);
    expect(rows.map((r) => r.id)).toEqual([live1.signal.id, live2.signal.id]);
    // Đúng mốc `expires_at` vẫn còn hạn (khớp `newsSignalStale`); sau mốc 1 ms thì hết.
    const atExpiry = await unexpiredNewsSignals(db, new Date(base + 120_000));
    expect(atExpiry.map((r) => r.id)).toEqual([live1.signal.id, live2.signal.id]);
    const afterExpiry = await unexpiredNewsSignals(db, new Date(base + 120_001));
    expect(afterExpiry.map((r) => r.id)).toEqual([live2.signal.id]);
    expect(await unexpiredNewsSignals(db, now, 1)).toHaveLength(1);
  });
});

describe("news_signal_deliveries", () => {
  it("records one delivery per (signal, bot); a repeat is a no-op", async () => {
    const acc = await account();
    const b1 = await bot(acc);
    const b2 = await bot(acc);
    const { signal: s } = await insertNewsSignal(db, signal());

    expect(
      await insertNewsSignalDelivery(db, {
        signalId: s.id,
        botId: b1,
        outcome: "accepted",
        epoch: 7,
      }),
    ).toBe(true);
    expect(
      await insertNewsSignalDelivery(db, {
        signalId: s.id,
        botId: b1,
        outcome: "dropped",
        reason: "SIGNAL_STALE",
        epoch: 8,
      }),
    ).toBe(false);
    expect(
      await insertNewsSignalDelivery(db, {
        signalId: s.id,
        botId: b2,
        outcome: "dropped",
        reason: "ASSET_NOT_IN_BOT",
        detail: { market: "SOL-USD" },
        epoch: 7,
      }),
    ).toBe(true);

    const rows = await db
      .select()
      .from(newsSignalDeliveries)
      .where(eq(newsSignalDeliveries.signalId, s.id));
    expect(rows).toHaveLength(2);
    const first = rows.find((r) => r.botId === b1);
    expect(first).toMatchObject({ outcome: "accepted", reason: null, epoch: 7 });

    const dup = await pgError(
      db
        .insert(newsSignalDeliveries)
        .values({ signalId: s.id, botId: b1, outcome: "accepted", epoch: 9 }),
    );
    expect(dup).toMatchObject({
      code: "23505",
      constraint: "news_signal_deliveries_signal_id_bot_id_pk",
    });
  });

  it("requires a reason exactly when dropped, and real signal / bot rows", async () => {
    const acc = await account();
    const b = await bot(acc);
    const { signal: s } = await insertNewsSignal(db, signal());
    expect(
      await pgError(
        db
          .insert(newsSignalDeliveries)
          .values({ signalId: s.id, botId: b, outcome: "dropped", epoch: 1 }),
      ),
    ).toMatchObject({ constraint: "news_signal_deliveries_reason_ck" });
    expect(
      await pgError(
        db.insert(newsSignalDeliveries).values({
          signalId: s.id,
          botId: b,
          outcome: "accepted",
          reason: "SIGNAL_STALE",
          epoch: 1,
        }),
      ),
    ).toMatchObject({ constraint: "news_signal_deliveries_reason_ck" });
    expect(
      await pgError(
        db.insert(newsSignalDeliveries).values({
          signalId: "00000000-0000-7000-8000-000000000000",
          botId: b,
          outcome: "accepted",
          epoch: 1,
        }),
      ),
    ).toMatchObject({ code: "23503" });
  });
});

describe("news_signal_trades", () => {
  it("allows one open / closing trade per account × market", async () => {
    const acc = await account();
    const b1 = await bot(acc);
    const b2 = await bot(acc);
    const { signal: s1 } = await insertNewsSignal(db, signal());
    const { signal: s2 } = await insertNewsSignal(db, signal());

    const [t1] = await db
      .insert(newsSignalTrades)
      .values(trade({ botId: b1, sodexAccountId: acc.accountId, signalId: s1.id, seq: 1 }))
      .returning();

    // Bot khác cùng account, cùng market: bị chặn.
    expect(
      await pgError(
        db
          .insert(newsSignalTrades)
          .values(trade({ botId: b2, sodexAccountId: acc.accountId, signalId: s2.id, seq: 1 })),
      ),
    ).toMatchObject({ code: "23505", constraint: "news_signal_trades_account_market_open_uq" });

    // `closing` vẫn giữ chỗ.
    await db
      .update(newsSignalTrades)
      .set({ status: "closing" })
      .where(eq(newsSignalTrades.id, t1?.id ?? ""));
    expect(
      await pgError(
        db.insert(newsSignalTrades).values(
          trade({
            botId: b2,
            sodexAccountId: acc.accountId,
            signalId: s2.id,
            seq: 1,
            status: "closing",
          }),
        ),
      ),
    ).toMatchObject({ constraint: "news_signal_trades_account_market_open_uq" });

    // Market khác, hoặc account khác: được.
    await db.insert(newsSignalTrades).values(
      trade({
        botId: b2,
        sodexAccountId: acc.accountId,
        signalId: s2.id,
        seq: 1,
        market: "ETH-USD",
      }),
    );
    const other = await account();
    const b3 = await bot(other);
    await db
      .insert(newsSignalTrades)
      .values(trade({ botId: b3, sodexAccountId: other.accountId, signalId: s1.id, seq: 1 }));

    // Đóng xong thì mở lệnh mới được.
    await db
      .update(newsSignalTrades)
      .set({ status: "closed", closedAt: new Date(T0 + 60_000), closeReason: "tp" })
      .where(eq(newsSignalTrades.id, t1?.id ?? ""));
    await db
      .insert(newsSignalTrades)
      .values(trade({ botId: b1, sodexAccountId: acc.accountId, signalId: s2.id, seq: 2 }));
  });

  it("keeps seq and signal unique per bot, and checks status / closed_at", async () => {
    const acc = await account();
    const b = await bot(acc);
    const { signal: s1 } = await insertNewsSignal(db, signal());
    const { signal: s2 } = await insertNewsSignal(db, signal());
    await db.insert(newsSignalTrades).values(
      trade({
        botId: b,
        sodexAccountId: acc.accountId,
        signalId: s1.id,
        seq: 1,
        status: "closed",
        qty: "0",
        closedAt: new Date(T0),
        closeReason: "ENTRY_NOT_FILLED",
      }),
    );
    expect(
      await pgError(
        db.insert(newsSignalTrades).values(
          trade({
            botId: b,
            sodexAccountId: acc.accountId,
            signalId: s2.id,
            seq: 1,
            market: "ETH-USD",
          }),
        ),
      ),
    ).toMatchObject({ constraint: "news_signal_trades_bot_seq_uq" });
    expect(
      await pgError(
        db.insert(newsSignalTrades).values(
          trade({
            botId: b,
            sodexAccountId: acc.accountId,
            signalId: s1.id,
            seq: 2,
            market: "ETH-USD",
          }),
        ),
      ),
    ).toMatchObject({ constraint: "news_signal_trades_bot_signal_uq" });
    expect(
      await pgError(
        db.insert(newsSignalTrades).values(
          trade({
            botId: b,
            sodexAccountId: acc.accountId,
            signalId: s2.id,
            seq: 3,
            status: "paper",
          }),
        ),
      ),
    ).toMatchObject({ constraint: "news_signal_trades_status_ck" });
    expect(
      await pgError(
        db.insert(newsSignalTrades).values(
          trade({
            botId: b,
            sodexAccountId: acc.accountId,
            signalId: s2.id,
            seq: 3,
            status: "closed",
          }),
        ),
      ),
    ).toMatchObject({ constraint: "news_signal_trades_closed_ck" });
  });
});

describe("news_signal_commands", () => {
  it("is unique per (trade_id, seq) and checks kind / prices / status", async () => {
    const acc = await account();
    const b = await bot(acc);
    const { signal: s } = await insertNewsSignal(db, signal());
    const [t] = await db
      .insert(newsSignalTrades)
      .values(trade({ botId: b, sodexAccountId: acc.accountId, signalId: s.id, seq: 1 }))
      .returning();
    const tradeId = t?.id ?? "";

    const [c] = await db
      .insert(newsSignalCommands)
      .values({ tradeId, kind: "edit_tpsl", seq: 1, tp: "110", createdBy: acc.userId })
      .returning();
    expect(c).toMatchObject({ status: "queued", sl: null, result: null });

    expect(
      await pgError(
        db
          .insert(newsSignalCommands)
          .values({ tradeId, kind: "close", seq: 1, createdBy: acc.userId }),
      ),
    ).toMatchObject({ code: "23505", constraint: "news_signal_commands_trade_seq_uq" });
    await db
      .insert(newsSignalCommands)
      .values({ tradeId, kind: "close", seq: 2, createdBy: acc.userId });

    expect(
      await pgError(
        db
          .insert(newsSignalCommands)
          .values({ tradeId, kind: "edit_tpsl", seq: 3, createdBy: acc.userId }),
      ),
    ).toMatchObject({ constraint: "news_signal_commands_prices_ck" });
    expect(
      await pgError(
        db
          .insert(newsSignalCommands)
          .values({ tradeId, kind: "close", seq: 3, sl: "90", createdBy: acc.userId }),
      ),
    ).toMatchObject({ constraint: "news_signal_commands_prices_ck" });
    expect(
      await pgError(
        db
          .insert(newsSignalCommands)
          .values({ tradeId, kind: "flip", seq: 3, createdBy: acc.userId }),
      ),
    ).toMatchObject({ constraint: "news_signal_commands_kind_ck" });
    expect(
      await pgError(
        db.insert(newsSignalCommands).values({
          tradeId,
          kind: "close",
          seq: 3,
          status: "done",
          createdBy: acc.userId,
        }),
      ),
    ).toMatchObject({ constraint: "news_signal_commands_status_ck" });
  });
});

describe("bots.signal_version_id", () => {
  it("is nullable and must point at a real signal bot version", async () => {
    const acc = await account();
    const plain = await bot(acc);
    const [p] = await db.select().from(bots).where(eq(bots.id, plain));
    expect(p?.signalVersionId).toBeNull();

    const versionId = await baselineId();
    expect(versionId).not.toBe("");
    const withVersion = await bot(acc, versionId);
    const [w] = await db.select().from(bots).where(eq(bots.id, withVersion));
    expect(w?.signalVersionId).toBe(versionId);

    expect(await pgError(bot(acc, "00000000-0000-7000-8000-000000000000"))).toMatchObject({
      code: "23503",
      constraint: "bots_signal_version_id_signal_bot_versions_id_fk",
    });
  });
});
