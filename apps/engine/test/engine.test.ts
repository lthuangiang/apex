import {
  apiKeys,
  botRuntime,
  botVersions,
  bots,
  candles1m,
  createDb,
  equitySnapshots,
  botEvents,
  fills,
  fundingRates,
  orders,
  outbox,
  paperAccounts,
  paperFills,
  paperSnapshots,
  riskLimits,
  runMigrations,
  shardEpochs,
  sodexAccounts,
  userBuilderFees,
  users,
  type Db,
} from "@drift/db";
import { ReasonCode } from "@drift/shared";
import {
  clOrdId,
  runBacktest,
  spotGrid,
  spotGridSchema,
  type OrderIntent,
} from "@drift/strategies";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Redis } from "ioredis";
import { GenericContainer, type StartedTestContainer } from "testcontainers";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { Engine, FencedError, shardOf } from "../src/engine";
import type {
  AccountRef,
  CancelResult,
  Fence,
  Gateway,
  LeverageResult,
  LeverageSetting,
  LookupResult,
  ModifyStopResult,
  NotSentCode,
  OrderTrade,
  SubmitResult,
} from "../src/gateway";
import { PaperGateway } from "../src/paper-gateway";

// Tiêu chí P6 (ROADMAP.md): kill một worker → shard chuyển chủ không trùng lệnh; revoke phí → mọi bot
// pause; timeout → unknown → đối soát. Postgres + Redis thật; SoDEX là gateway giả.

const SHARDS = 4;
const rules = { tickSize: "1", stepSize: "0.0001", minQuantity: "0.0001", minNotional: "5" };
const log = { info: () => undefined, warn: () => undefined, error: () => undefined };

/** Gateway giả: nhớ mọi lệnh đã nhận; có thể cài timeout (đã áp dụng hoặc chưa) và revoke phí. */
class FakeGateway implements Gateway {
  readonly received: OrderIntent[] = [];
  readonly fences: Fence[] = [];
  readonly book = new Map<string, LookupResult>();
  approved = true;
  timeoutNext: "applied" | "lost" | null = null;
  rejectEpochBelow = 0;
  /** Mọi lần đặt đòn bẩy + thời điểm so với lệnh (index trong `received`). */
  readonly leverage: { market: string; leverage: number; marginMode: string; before: number }[] =
    [];
  leverageOutcome: LeverageResult = { outcome: "ok" };
  /** Thiết lập trên "SoDEX" theo market (đọc lại bằng readLeverage). */
  readonly settings = new Map<string, LeverageSetting>();
  /** Signer lỗi: mọi submit trả not_sent với mã này. */
  notSent: NotSentCode | null = null;
  /** SoDEX từ chối mọi lệnh với mã + câu lỗi này. */
  reject: { code: string; message: string | null } | null = null;
  #id = 1n;

  setLeverage(
    _a: AccountRef,
    input: { market: string; leverage: number; marginMode: "cross" | "isolated" },
  ): Promise<LeverageResult> {
    this.leverage.push({ ...input, before: this.received.length });
    if (this.leverageOutcome.outcome === "ok")
      this.settings.set(input.market, { leverage: input.leverage, marginMode: input.marginMode });
    return Promise.resolve(this.leverageOutcome);
  }
  /** Vị thế đang mở theo market (đọc lại bằng readLeverage). */
  readonly positions = new Map<string, LeverageSetting>();
  readLeverage(
    _a: AccountRef,
    market: string,
  ): Promise<{ setting: LeverageSetting | null; position: LeverageSetting | null }> {
    return Promise.resolve({
      setting: this.settings.get(market) ?? null,
      position: this.positions.get(market) ?? null,
    });
  }

  /** Builder fee engine gắn vào mỗi lần submit (DEC-159). */
  readonly builderRates: (number | undefined)[] = [];
  submit(
    _a: AccountRef,
    list: readonly OrderIntent[],
    fence: Fence,
    builderFeeRate?: number,
  ): Promise<SubmitResult[]> {
    this.builderRates.push(builderFeeRate);
    // Signer từ chối ký với epoch cũ (fencing ở signer).
    if (fence.epoch < this.rejectEpochBelow) return Promise.reject(new Error("stale epoch"));
    const code = this.notSent;
    if (code !== null)
      return Promise.resolve(
        list.map((o): SubmitResult => ({ clOrdID: o.clOrdID, outcome: "not_sent", code })),
      );
    this.fences.push(fence);
    const reject = this.reject;
    if (reject !== null) {
      this.received.push(...list);
      return Promise.resolve(
        list.map((o): SubmitResult => ({ clOrdID: o.clOrdID, outcome: "rejected", ...reject })),
      );
    }
    return Promise.resolve(
      list.map((o): SubmitResult => {
        const timeout = this.timeoutNext;
        this.timeoutNext = null;
        if (timeout !== "lost") {
          this.received.push(o);
          this.book.set(o.clOrdID, {
            status: "open",
            filledQty: "0",
            avgPrice: null,
            orderId: this.#id++,
          });
        }
        return timeout === null
          ? { clOrdID: o.clOrdID, outcome: "ok", orderId: this.#id }
          : { clOrdID: o.clOrdID, outcome: "unknown" };
      }),
    );
  }
  /** Mọi lệnh đã nhận lệnh huỷ; `cancelOutcome` là kết quả SoDEX trả cho mỗi lần huỷ. */
  readonly cancelled: string[] = [];
  cancelOutcome: "ok" | "unknown" = "ok";
  /** Số lần huỷ kế tiếp sẽ không rời DRIFT (signer lỗi), như sự cố 2026-11-04 (DEC-111). */
  cancelNotSent = 0;
  /** Mọi lần dời stop loss gốc (DEC-118). */
  readonly stopModifies: { clOrdID: string; stopPrice: string }[] = [];
  modifyStopOutcome: ModifyStopResult = { outcome: "ok" };
  modifyStop(
    _a: AccountRef,
    o: { clOrdID: string; market: string; stopPrice: string },
  ): Promise<ModifyStopResult> {
    this.stopModifies.push({ clOrdID: o.clOrdID, stopPrice: o.stopPrice });
    return Promise.resolve(this.modifyStopOutcome);
  }
  cancel(_a: AccountRef, list: readonly { clOrdID: string }[]): Promise<CancelResult[]> {
    if (this.cancelNotSent > 0) {
      this.cancelNotSent -= 1;
      return Promise.reject(new Error("not sent: signer_unavailable"));
    }
    this.cancelled.push(...list.map((o) => o.clOrdID));
    const outcome = this.cancelOutcome;
    return Promise.resolve(list.map((o) => ({ clOrdID: o.clOrdID, outcome })));
  }
  /** Vị thế Perps trên "SoDEX" theo market (readPosition); đếm số lần đọc. */
  readonly perpsPositions = new Map<string, { size: string; entryPrice: string }>();
  positionReads = 0;
  readPosition(
    _a: AccountRef,
    market: string,
  ): Promise<{ size: string; entryPrice: string } | null> {
    this.positionReads += 1;
    return Promise.resolve(this.perpsPositions.get(market) ?? null);
  }
  recentTradesCalls = 0;
  recentTrades(): Promise<(OrderTrade & { clOrdID: string })[]> {
    this.recentTradesCalls += 1;
    return Promise.resolve(
      [...this.trades].flatMap(([clOrdID, list]) => list.map((t) => ({ ...t, clOrdID }))),
    );
  }
  lookup(_a: AccountRef, o: { clOrdID: string }): Promise<LookupResult> {
    return Promise.resolve(this.book.get(o.clOrdID) ?? { status: "not_found" });
  }
  readonly trades = new Map<string, OrderTrade[]>();
  tradesOf(_a: AccountRef, o: { clOrdID: string }): Promise<OrderTrade[]> {
    return Promise.resolve(this.trades.get(o.clOrdID) ?? []);
  }
  /** Giả SoDEX lỗi khi đọc approval (ví dụ "user not found"). */
  approvedError: Error | null = null;
  builderApproved(): Promise<boolean> {
    return this.approvedError === null
      ? Promise.resolve(this.approved)
      : Promise.reject(this.approvedError);
  }
}

let pg: StartedPostgreSqlContainer;
let redisC: StartedTestContainer;
let db: Db;
let pool: ReturnType<typeof createDb>["pool"];
const redises: Redis[] = [];
const newRedis = () => {
  const r = new Redis(`redis://${redisC.getHost()}:${String(redisC.getMappedPort(6379))}`);
  redises.push(r);
  return r;
};

beforeAll(async () => {
  pg = await new PostgreSqlContainer("timescale/timescaledb:2.16.1-pg16").start();
  redisC = await new GenericContainer("redis:7.4-alpine").withExposedPorts(6379).start();
  await runMigrations(pg.getConnectionUri());
  ({ db, pool } = createDb(pg.getConnectionUri()));
});
afterAll(async () => {
  for (const r of redises) r.disconnect();
  await pool.end();
  await Promise.all([pg.stop(), redisC.stop()]);
});
beforeEach(async () => {
  await newRedis().flushall();
});

let clock = 1_790_000_000_000;
const now = () => clock;

async function seedBot(
  state: "starting" | "running" = "starting",
  spec: {
    strategy: string;
    market: string;
    engine: "spot" | "perps" | "spot+perps";
    config: Record<string, unknown>;
  } = {
    strategy: "spot_grid",
    market: "vBTC_vUSDC",
    engine: "spot",
    config: {
      market: "vBTC_vUSDC",
      lowerPrice: "90",
      upperPrice: "110",
      gridLevels: 5,
      spacing: "arithmetic",
      investment: "500",
      maxLoss: "100",
      onStop: "keep_base",
    },
  },
) {
  const [user] = await db
    .insert(users)
    .values({ email: `${String(Math.random())}@x.test` })
    .returning();
  const [account] = await db
    .insert(sodexAccounts)
    .values({
      userId: user?.id ?? "",
      address: "0x4E1e4796c10C637EDAB56461450BD8D02EFb29Db",
      sodexAccountId: BigInt(Math.floor(Math.random() * 1e9)),
      network: "mainnet",
      status: "connected",
    })
    .returning();
  await db.insert(apiKeys).values({
    sodexAccountId: account?.id ?? "",
    name: "DRIFT",
    publicKey: "0x1563915e194D8CfBA1943570603F7606A3115508",
    ciphertext: "vault:v1:test",
    kmsKeyRef: "test",
    last4: "5508",
    permissionsMask: 14,
    expiresAt: new Date(clock + 1e10),
    status: "active",
  });
  const [bot] = await db
    .insert(bots)
    .values({
      userId: user?.id ?? "",
      sodexAccountId: account?.id ?? "",
      strategy: spec.strategy,
      market: spec.market,
      engine: spec.engine,
      name: "Grid",
      state,
    })
    .returning();
  const [version] = await db
    .insert(botVersions)
    .values({
      botId: bot?.id ?? "",
      version: 1,
      paramSource: "manual",
      status: "active",
      config: spec.config,
    })
    .returning();
  await db
    .update(bots)
    .set({ activeVersionId: version?.id ?? "" })
    .where((await import("drizzle-orm")).eq(bots.id, bot?.id ?? ""));
  return { botId: bot?.id ?? "", accountId: account?.id ?? "" };
}

const makeEngine = (gateway: Gateway, workerId: string) =>
  new Engine({
    db,
    redis: newRedis(),
    gateway,
    workerId,
    log,
    now,
    leaseTtlMs: 300,
    shards: SHARDS,
    rules: () => Promise.resolve(rules),
    feeCheckMs: 0,
  });

const botState = async (botId: string) => {
  const { eq } = await import("drizzle-orm");
  const [b] = await db.select().from(bots).where(eq(bots.id, botId));
  return b;
};

describe("engine", () => {
  it("starts a bot and moves it to running only after SoDEX acks the first orders", async () => {
    const gw = new FakeGateway();
    const { botId } = await seedBot();
    const e = makeEngine(gw, "w1");
    await e.tick();
    expect((await botState(botId))?.state).toBe("starting");
    await e.onPrice("vBTC_vUSDC", "100", clock);
    expect(gw.received.map((o) => o.tag)).toEqual(
      ["grid:init", "grid:0:buy", "grid:1:buy", "grid:3:sell", "grid:4:sell"].filter(
        (t) => t !== "grid:3:sell" && t !== "grid:4:sell",
      ),
    );
    expect((await botState(botId))?.state).toBe("running");
    await e.stop();
  });

  it("tells the team once when a real-money bot starts, never for a paper bot (DEC-191)", async () => {
    const { eq, inArray, sql } = await import("drizzle-orm");
    const teamOps = async (id: string) =>
      (
        await db
          .select()
          .from(outbox)
          .where(sql`${outbox.topic} = 'jobs.team_ops' and ${outbox.payload}->>'botId' = ${id}`)
      ).map((r) => r.payload);
    const live = await seedBot();
    const paper = await seedBot();
    await db.update(bots).set({ mode: "paper" }).where(eq(bots.id, paper.botId));
    await db.insert(paperAccounts).values({
      botId: paper.botId,
      capital: "1000",
      cash: "1000",
      positions: {},
      peakEquity: "1000",
      startedAt: new Date(clock),
    });
    // Một engine chạy cả hai: bot thật qua cổng giả, bot paper qua PaperGateway.
    const e = new Engine({
      db,
      redis: newRedis(),
      gateway: new FakeGateway(),
      paper: new PaperGateway({ db, now }),
      workerId: "team-ops",
      log,
      now,
      leaseTtlMs: 30_000,
      shards: SHARDS,
      rules: () => Promise.resolve(rules),
      feeCheckMs: 0,
    });
    await e.tick();
    await e.onPrice("vBTC_vUSDC", "100", clock);
    expect((await botState(live.botId))?.state).toBe("running");
    expect((await botState(paper.botId))?.state).toBe("running");
    const events = await teamOps(live.botId);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "team_bot_started",
      botId: live.botId,
      capitalAsset: "USDC",
    });
    expect(Number((events[0] as { capital: string }).capital)).toBeGreaterThan(0);
    expect(await teamOps(paper.botId)).toEqual([]);
    await e.onPrice("vBTC_vUSDC", "101", clock + 1000);
    expect(await teamOps(live.botId)).toHaveLength(1);
    await e.stop();
    await db
      .update(bots)
      .set({ state: "stopped" })
      .where(inArray(bots.id, [live.botId, paper.botId]));
  });

  it("tags orders with the user's own builder fee, picked up on the next tick (DEC-159)", async () => {
    const gw = new FakeGateway();
    const { botId } = await seedBot();
    const userId = (await botState(botId))?.userId ?? "";
    const e = makeEngine(gw, "w1");
    await e.tick();
    // Runner đã nạp với mức mặc định; team đặt mức riêng sau đó.
    await db
      .insert(userBuilderFees)
      .values({ userId, strategy: "spot_grid", rate: 7, updatedBy: userId });
    await e.tick();
    await e.onPrice("vBTC_vUSDC", "100", clock);
    expect(gw.received.length).toBeGreaterThan(0);
    expect(new Set(gw.builderRates)).toEqual(new Set([7]));
    await e.stop();
  });

  it("hands a shard to another worker after a crash without duplicating orders, and fences the zombie", async () => {
    const gw = new FakeGateway();
    const { botId, accountId } = await seedBot();
    const shard = shardOf(accountId, SHARDS);
    const a = makeEngine(gw, "A");
    await a.tick();
    await a.onPrice("vBTC_vUSDC", "100", clock);
    const epochA = a.epochOf(shard);
    const sentByA = gw.received.length;
    expect(sentByA).toBeGreaterThan(0);

    a.kill();
    // Mô phỏng A chết trước khi kịp lưu state: B phải chạy lại chiến lược từ đầu.
    await db.delete(botRuntime);
    await new Promise((r) => setTimeout(r, 400)); // lease 300 ms hết hạn
    const b = makeEngine(gw, "B");
    await b.tick();
    expect(b.ownedShards).toContain(shard);
    const epochB = b.epochOf(shard);
    expect(epochB).toBe((epochA ?? 0) + 1);

    // B chạy lại cùng giá từ state ban đầu: sinh lại đúng các clOrdID cũ, unique chặn → không gửi lại.
    await b.onPrice("vBTC_vUSDC", "100", clock);
    const ids = gw.received.map((o) => o.clOrdID);
    expect(new Set(ids).size).toBe(ids.length);
    expect(gw.received).toHaveLength(sentByA);
    const rows = await db.select().from(orders);
    expect(rows.filter((o) => o.botId === botId)).toHaveLength(
      new Set(rows.filter((o) => o.botId === botId).map((o) => o.clOrdId)).size,
    );

    // Zombie A: mọi lần ghi bị fencing từ chối.
    const [row] = await db
      .select()
      .from(shardEpochs)
      .where((await import("drizzle-orm")).eq(shardEpochs.shard, shard));
    expect(row?.owner).toBe("B");
    await expect(a.onPrice("vBTC_vUSDC", "95", clock)).rejects.toBeInstanceOf(FencedError);
    await b.stop();
  });

  it("keeps the shard running when the builder fee can't be read (DEC-113)", async () => {
    const gw = new FakeGateway();
    const first = await seedBot("running");
    const e = makeEngine(gw, "w1");
    await e.tick();
    gw.approvedError = new Error("user not found");
    clock += 1;
    await expect(e.tick()).resolves.not.toThrow();
    const bot = await botState(first.botId);
    expect(bot?.state).toBe("running");
    await e.stop();
  });

  it("pauses every bot of the account when the builder fee is revoked, keeping open orders", async () => {
    const gw = new FakeGateway();
    const first = await seedBot("running");
    const e = makeEngine(gw, "w1");
    await e.tick();
    await e.onPrice("vBTC_vUSDC", "100", clock);
    const openBefore = (await db.select().from(orders)).filter(
      (o) => o.botId === first.botId && o.status === "open",
    ).length;
    gw.approved = false;
    clock += 1;
    await e.tick();
    const bot = await botState(first.botId);
    expect(bot?.state).toBe("paused");
    expect(bot?.reasonCode).toBe(ReasonCode.builderFeeRevoked);
    expect(
      (await db.select().from(orders)).filter(
        (o) => o.botId === first.botId && o.status === "open",
      ),
    ).toHaveLength(openBefore);
    await e.stop();
  });

  it("marks a timed-out order unknown, never resends it, and reconciles it", async () => {
    const gw = new FakeGateway();
    gw.timeoutNext = "applied";
    const { botId } = await seedBot();
    const e = makeEngine(gw, "w1");
    await e.tick();
    await e.onPrice("vBTC_vUSDC", "100", clock);
    const init = (await db.select().from(orders)).find(
      (o) => o.botId === botId && o.tag === "grid:init",
    );
    expect(init?.status).toBe("unknown");
    const sends = gw.received.filter((o) => o.tag === "grid:init").length;

    clock += 6_000;
    await e.tick();
    const after = (await db.select().from(orders)).find(
      (o) => o.botId === botId && o.tag === "grid:init",
    );
    expect(after?.status).toBe("open");
    expect(after?.reconciledAt).not.toBeNull();
    expect(gw.received.filter((o) => o.tag === "grid:init")).toHaveLength(sends);
    await e.stop();
  });

  it("marks a lost order not_placed after the grace period and pauses the bot", async () => {
    const gw = new FakeGateway();
    gw.timeoutNext = "lost";
    const { botId } = await seedBot();
    const e = makeEngine(gw, "w1");
    await e.tick();
    await e.onPrice("vBTC_vUSDC", "100", clock);
    clock += 31_000;
    await e.tick();
    const init = (await db.select().from(orders)).find(
      (o) => o.botId === botId && o.tag === "grid:init",
    );
    expect(init?.status).toBe("not_placed");
    const bot = await botState(botId);
    expect(bot?.state).toBe("paused");
    expect(bot?.reasonCode).toBe(ReasonCode.orderRejected);
    await e.stop();
  });

  it("applies an edited version: cancels old orders, activates v2 and re-places from the new config", async () => {
    const { eq } = await import("drizzle-orm");
    const gw = new FakeGateway();
    const { botId } = await seedBot("running");
    const e = makeEngine(gw, "w1");
    await e.tick();
    await e.onPrice("vBTC_vUSDC", "100", clock);
    const before = gw.received.length;
    await db.insert(botVersions).values({
      botId,
      version: 2,
      paramSource: "manual",
      status: "pending",
      config: {
        market: "vBTC_vUSDC",
        lowerPrice: "80",
        upperPrice: "120",
        gridLevels: 3,
        spacing: "arithmetic",
        investment: "300",
        maxLoss: "50",
        onStop: "keep_base",
      },
    });
    await e.tick();
    const versions = await db.select().from(botVersions).where(eq(botVersions.botId, botId));
    expect(versions.map((v) => `${String(v.version)}:${v.status}`).sort()).toEqual([
      "1:superseded",
      "2:active",
    ]);
    expect(
      (await db.select().from(orders)).filter((o) => o.botId === botId && o.status === "cancelled")
        .length,
    ).toBeGreaterThan(0);
    await e.onPrice("vBTC_vUSDC", "100", clock + 1);
    const fresh = gw.received.slice(before);
    // v2: mức 80, 100, 120 → mua ở 80 (giá 100), lệnh market cho mức bán 120.
    expect(fresh.map((o) => o.tag)).toEqual(["grid:init", "grid:0:buy"]);
    expect(new Set(gw.received.map((o) => o.clOrdID)).size).toBe(gw.received.length);
    await e.stop();
  });

  it("feeds settled funding to funding arb bots in percent, with the 7-day average", async () => {
    const gw = new FakeGateway();
    const { botId } = await seedBot("running", {
      strategy: "funding_arb",
      market: "BTC-USD",
      engine: "spot+perps",
      config: {
        asset: "BTC",
        spotMarket: "vBTC_vUSDC",
        perpMarket: "BTC-USD",
        leverage: 1,
        investment: "1000",
        enterFundingPct: "0.005",
        exitFundingPct: "0",
        maxGapPct: "0.5",
        minMarginRatioPct: "30",
        maxLoss: "100",
      },
    });
    // Ba kỳ gần nhất 0.0001 (= 0.01%/kỳ) ≥ ngưỡng 0.005%.
    await db.insert(fundingRates).values(
      [1, 2, 3].map((h) => ({
        market: "BTC-USD",
        fundingTime: new Date(clock - h * 8 * 3_600_000),
        rate: "0.0001",
      })),
    );
    const e = makeEngine(gw, "w1");
    await e.tick();
    await e.onPrice("vBTC_vUSDC", "100", clock);
    await e.onPrice("BTC-USD", "100", clock);
    const before = gw.received.length;
    await e.onFunding("BTC-USD", "0.0001", clock);
    const placed = gw.received.slice(before).map((o) => o.tag);
    expect(placed).toEqual(["arb:1:open:spot", "arb:1:open:perp"]);
    expect(gw.leverage.map((l) => [l.market, l.leverage, l.marginMode])).toEqual([
      ["BTC-USD", 1, "cross"],
    ]);
    expect((await botState(botId))?.state).toBe("running");
    await e.stop();
  });

  const futuresGrid = {
    strategy: "futures_grid",
    market: "BTC-USD",
    engine: "perps" as const,
    config: {
      market: "BTC-USD",
      leverage: 20,
      marginMode: "isolated",
      direction: "short",
      lowerPrice: "90",
      upperPrice: "110",
      gridLevels: 4,
      spacing: "arithmetic",
      margin: "20",
      stopBelow: "80",
      maxLoss: "2",
      onStop: "close_at_market",
    },
  };

  it("sets the bot's leverage and margin mode on SoDEX before the first perps order", async () => {
    const gw = new FakeGateway();
    const { botId } = await seedBot("starting", futuresGrid);
    const e = makeEngine(gw, "w1");
    await e.tick();
    await e.onPrice("BTC-USD", "100", clock);
    // Bot của test khác (cùng DB) cũng có thể đặt đòn bẩy: chỉ xét bot 20× isolated của test này.
    const mine = () => gw.leverage.filter((l) => l.leverage === 20);
    expect(mine()).toEqual([
      { market: "BTC-USD", leverage: 20, marginMode: "isolated", before: 0 },
    ]);
    expect(gw.received.length).toBeGreaterThan(0);
    expect((await botState(botId))?.state).toBe("running");
    // Đã xác nhận thì không gửi lại ở mỗi giá.
    await e.onPrice("BTC-USD", "101", clock);
    expect(mine()).toHaveLength(1);
    await e.stop();
  });

  it("sends no order and pauses the bot when SoDEX rejects the leverage update", async () => {
    const gw = new FakeGateway();
    gw.leverageOutcome = { outcome: "rejected", code: "-1" };
    const { botId } = await seedBot("starting", futuresGrid);
    const e = makeEngine(gw, "w1");
    await e.tick();
    await e.onPrice("BTC-USD", "100", clock);
    expect(gw.received).toEqual([]);
    const b = await botState(botId);
    expect(b?.state).toBe("paused");
    expect(b?.reasonCode).toBe(ReasonCode.orderRejected);
    await e.stop();
  });

  it("sends no order while the leverage result is unknown, then proceeds once confirmed", async () => {
    const gw = new FakeGateway();
    gw.leverageOutcome = { outcome: "unknown" };
    const { botId } = await seedBot("starting", futuresGrid);
    const e = makeEngine(gw, "w1");
    await e.tick();
    await e.onPrice("BTC-USD", "100", clock);
    expect(gw.received).toEqual([]);
    expect((await botState(botId))?.state).toBe("starting");
    gw.leverageOutcome = { outcome: "ok" };
    await e.onPrice("BTC-USD", "100", clock);
    expect(gw.received.length).toBeGreaterThan(0);
    expect(gw.leverage.filter((l) => l.leverage === 20).at(-1)?.before).toBe(0);
    await e.stop();
  });

  it("does not resend an unknown leverage update once SoDEX shows it applied", async () => {
    const gw = new FakeGateway();
    gw.leverageOutcome = { outcome: "unknown" };
    await seedBot("starting", futuresGrid);
    const e = makeEngine(gw, "w1");
    await e.tick();
    await e.onPrice("BTC-USD", "100", clock);
    expect(gw.received).toEqual([]);
    // Lệnh trước thực ra đã áp dụng: SoDEX trả đúng 20× isolated → không gửi lại, đặt lệnh luôn.
    gw.settings.set("BTC-USD", { leverage: 20, marginMode: "isolated" });
    const sent = gw.leverage.filter((l) => l.leverage === 20).length;
    await e.onPrice("BTC-USD", "100", clock);
    expect(gw.leverage.filter((l) => l.leverage === 20)).toHaveLength(sent);
    expect(gw.received.length).toBeGreaterThan(0);
    await e.stop();
  });

  it("pauses every bot of the account with API_KEY_UNUSABLE when the key can't be decrypted", async () => {
    const gw = new FakeGateway();
    gw.notSent = "key_unusable";
    const { botId } = await seedBot();
    const e = makeEngine(gw, "w1");
    await e.tick();
    await e.onPrice("vBTC_vUSDC", "100", clock);
    expect(gw.received).toEqual([]);
    const b = await botState(botId);
    expect(b?.state).toBe("paused");
    expect(b?.reasonCode).toBe(ReasonCode.apiKeyUnusable);
    // Lệnh chưa rời DRIFT: không để lại dòng `unknown` cần đối soát.
    const { eq } = await import("drizzle-orm");
    const left = await db.select().from(orders).where(eq(orders.botId, botId));
    expect(left.filter((o) => o.status === "unknown")).toEqual([]);
    await e.stop();
  });

  it("backs off while the signer is down, then sends the same orders once it recovers", async () => {
    const gw = new FakeGateway();
    gw.notSent = "signer_unavailable";
    const { botId } = await seedBot();
    const e = makeEngine(gw, "w1");
    await e.tick();
    await e.onPrice("vBTC_vUSDC", "100", clock);
    expect(gw.received).toEqual([]);
    expect((await botState(botId))?.state).toBe("starting");
    gw.notSent = null;
    // Trong thời gian backoff (2 s) không thử lại.
    await e.onPrice("vBTC_vUSDC", "100", clock + 1_000);
    expect(gw.received).toEqual([]);
    await e.onPrice("vBTC_vUSDC", "100", clock + 2_500);
    expect(gw.received.map((o) => o.tag)).toEqual(["grid:init", "grid:0:buy", "grid:1:buy"]);
    expect((await botState(botId))?.state).toBe("running");
    await e.stop();
  });

  it("pauses the bot after 5 attempts that never left DRIFT", async () => {
    const gw = new FakeGateway();
    gw.notSent = "signer_unavailable";
    const { botId } = await seedBot();
    const e = makeEngine(gw, "w1");
    await e.tick();
    let t = clock;
    for (let i = 0; i < 6; i += 1) {
      await e.onPrice("vBTC_vUSDC", "100", t);
      t += 61_000;
    }
    expect(gw.received).toEqual([]);
    const b = await botState(botId);
    expect(b?.state).toBe("paused");
    expect(b?.reasonCode).toBe(ReasonCode.orderRejected);
    await e.stop();
  });

  it("does not change leverage over an open position with another setting, and pauses the bot (DEC-58)", async () => {
    const gw = new FakeGateway();
    gw.settings.set("BTC-USD", { leverage: 40, marginMode: "cross" });
    gw.positions.set("BTC-USD", { leverage: 40, marginMode: "cross" });
    const { botId } = await seedBot("starting", futuresGrid);
    const e = makeEngine(gw, "w1");
    await e.tick();
    await e.onPrice("BTC-USD", "100", clock);
    expect(gw.leverage.filter((l) => l.leverage === 20)).toEqual([]);
    expect(gw.received).toEqual([]);
    const b = await botState(botId);
    expect(b?.state).toBe("paused");
    expect(b?.reasonCode).toBe(ReasonCode.orderRejected);
    await e.stop();
  });

  it("never sets leverage for spot bots", async () => {
    const gw = new FakeGateway();
    await seedBot();
    const e = makeEngine(gw, "w1");
    await e.tick();
    await e.onPrice("vBTC_vUSDC", "100", clock);
    expect(gw.leverage.filter((l) => l.market === "vBTC_vUSDC")).toEqual([]);
    expect(gw.received.length).toBeGreaterThan(0);
    await e.stop();
  });

  it("produces the same order sequence as the backtest on the same candles (BACKTEST.md 11.2)", async () => {
    const MIN = 60_000;
    const candles = Array.from({ length: 160 }, (_, i) => {
      const p = 100 + 9 * Math.sin(i / 9);
      return {
        t: clock + i * MIN,
        o: p.toFixed(2),
        h: (p + 0.8).toFixed(2),
        l: (p - 0.8).toFixed(2),
        c: (p + 0.2).toFixed(2),
      };
    });
    const config = {
      market: "vBTC_vUSDC",
      lowerPrice: "90",
      upperPrice: "110",
      gridLevels: 5,
      spacing: "arithmetic",
      investment: "500",
      maxLoss: "100",
      onStop: "keep_base",
    };
    const bt = runBacktest({
      module: spotGrid,
      config: spotGridSchema.parse(config),
      markets: { vBTC_vUSDC: { engine: "spot", candles, rules } },
      funding: {},
      fees: { spot: { maker: "0", taker: "0" }, perps: { maker: "0", taker: "0" }, builder: "0" },
      slippage: "0",
      intervalMs: MIN,
      capital: "500",
      recordEvents: true,
    });
    const btOrders = bt.actions.flatMap((a) =>
      a.type === "place"
        ? [`${a.order.tag} ${a.order.side} ${a.order.price ?? "mkt"} ${a.order.quantity}`]
        : [],
    );
    expect(bt.fills.length).toBeGreaterThan(4);

    // Engine chạy cùng chuỗi event: tick → onPrice, fill → onFill (theo tag của lệnh engine đã gửi).
    const gw = new FakeGateway();
    const { accountId } = await seedBot("running");
    const e = makeEngine(gw, "w1");
    await e.tick();
    const tagOf = new Map(
      bt.actions.flatMap((a) =>
        a.type === "place" ? [[a.order.clOrdID, a.order.tag] as const] : [],
      ),
    );
    for (const ev of bt.events) {
      if (ev.type === "tick") await e.onPrice(ev.market, ev.price, ev.at);
      if (ev.type === "fill") {
        const tag = tagOf.get(ev.clOrdID);
        const mine = [...gw.received].reverse().find((o) => o.tag === tag);
        if (mine !== undefined)
          await e.onFill(accountId, mine.clOrdID, ev.quantity, ev.price, ev.fee, ev.at);
      }
    }
    const engineOrders = gw.received.map(
      (o) => `${o.tag} ${o.side} ${o.price ?? "mkt"} ${o.quantity}`,
    );
    expect(engineOrders).toEqual(btOrders);
    await e.stop();
  });

  it("blocks orders above the per-trade risk limit before they reach SoDEX", async () => {
    const { eq } = await import("drizzle-orm");
    const gw = new FakeGateway();
    const { botId, accountId } = await seedBot("running");
    await db
      .insert(riskLimits)
      .values({ sodexAccountId: accountId, perTradePct: "1", enforced: {} });
    await db
      .insert(equitySnapshots)
      .values({ sodexAccountId: accountId, at: new Date(clock - 60_000), equity: "1000" });
    const e = makeEngine(gw, "w1");
    await e.tick();
    await e.onPrice("vBTC_vUSDC", "100", clock);
    // Mỗi lệnh grid ≈ 100 USDC = 10% equity > 1%: không lệnh nào được gửi.
    expect(gw.received).toHaveLength(0);
    const rejected = (await db.select().from(orders).where(eq(orders.botId, botId))).filter(
      (o) => o.rejectCode === "RISK_PER_TRADE",
    );
    expect(rejected.length).toBeGreaterThan(0);
    await e.stop();
  });

  it("records SoDEX trades of DRIFT orders as fills, once per trade id", async () => {
    const { eq } = await import("drizzle-orm");
    const gw = new FakeGateway();
    const { accountId } = await seedBot("running");
    const e = makeEngine(gw, "w1");
    await e.tick();
    await e.onPrice("vBTC_vUSDC", "100", clock);
    const o = gw.received[0];
    expect(o).toBeDefined();
    const trade = {
      tradeId: 9_000_001n,
      clOrdID: o?.clOrdID ?? "",
      price: "100",
      quantity: "1",
      fee: "0.09",
      builderFee: "0.05",
      isMaker: true,
      at: clock,
    };
    await e.onTrade(accountId, trade);
    await e.onTrade(accountId, trade);
    await e.onTrade(accountId, { ...trade, tradeId: 9_000_002n, clOrdID: "not-ours" });
    const rows = await db.select().from(fills).where(eq(fills.sodexTradeId, 9_000_001n));
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]?.builderFee)).toBe(0.05);
    expect(Number(rows[0]?.fee)).toBe(0.09);
    expect(await db.select().from(fills).where(eq(fills.sodexTradeId, 9_000_002n))).toHaveLength(0);
    await e.stop();
  });

  it("blocks a limit order that would trade with the account's own open order (SELF_TRADE_BLOCKED)", async () => {
    const { eq } = await import("drizzle-orm");
    const gw = new FakeGateway();
    const { botId, accountId } = await seedBot("running");
    // Lệnh bán đang mở của account (ví dụ từ bot khác) ở 92: mua của grid ở 95 sẽ khớp với chính nó.
    await db.insert(orders).values({
      botId,
      sodexAccountId: accountId,
      clOrdId: "other-bot-sell-92",
      market: "vBTC_vUSDC",
      engine: "spot",
      side: "sell",
      type: "limit",
      timeInForce: "GTC",
      price: "92",
      size: "1",
      status: "open",
      reduceOnly: false,
      tag: "other",
      epoch: 1,
    });
    const e = makeEngine(gw, "w1");
    await e.tick();
    await e.onPrice("vBTC_vUSDC", "100", clock);
    const sent = gw.received.map((o) => `${o.side}@${o.price ?? "mkt"}`);
    expect(sent).not.toContain("buy@95");
    expect(sent).toContain("buy@90");
    const rejected = (await db.select().from(orders).where(eq(orders.botId, botId))).filter(
      (o) => o.rejectCode === "SELF_TRADE_BLOCKED",
    );
    expect(rejected.map((o) => `${o.side}@${String(Number(o.price))}`)).toEqual(["buy@95"]);
    await e.stop();
  });

  it("does not run Volume Maker bots for users the team turned off (DEC-80, DEC-94)", async () => {
    const { eq } = await import("drizzle-orm");
    const gw = new FakeGateway();
    const { botId } = await seedBot("running", {
      strategy: "volume_maker",
      market: "BTC-USD",
      engine: "perps",
      config: {
        market: "BTC-USD",
        leverage: 1,
        volumeTarget: "100000",
        orderSize: "500",
        distanceBp: "1",
        maxInventory: "2000",
        refreshSeconds: 3,
        runUntil: "target_or_budget",
        costBudget: "300",
        inventoryLossStop: "60",
        onStop: "close_inventory",
      },
    });
    const [b] = await db.select().from(bots).where(eq(bots.id, botId));
    await db
      .update(users)
      .set({ volumeBots: false })
      .where(eq(users.id, b?.userId ?? ""));
    const e = makeEngine(gw, "w1");
    await e.tick();
    await e.onPrice("BTC-USD", "100000", clock);
    expect(gw.received).toHaveLength(0);
    await e.stop();
  });
  it("closes the bot's perps position on Stop only when the user chose to (DEC-81)", async () => {
    const { eq } = await import("drizzle-orm");
    const futures = {
      strategy: "futures_grid",
      market: "BTC-USD",
      engine: "perps" as const,
      config: {
        market: "BTC-USD",
        direction: "long",
        leverage: 2,
        marginMode: "cross",
        lowerPrice: "90",
        upperPrice: "110",
        gridLevels: 5,
        spacing: "arithmetic",
        margin: "250",
        maxLoss: "100",
        stopBelow: "80",
        onStop: "keep_position",
      },
    };
    for (const close of [true, false]) {
      const gw = new FakeGateway();
      const { botId } = await seedBot("running", futures);
      const e = makeEngine(gw, `w-${String(close)}`);
      // Shard có thể chưa nhận được ở nhịp đầu: lặp tới khi bot đã có state, như vòng 1 s của engine thật.
      let rt: typeof botRuntime.$inferSelect | undefined;
      for (let i = 0; i < 20 && rt === undefined; i += 1) {
        await e.tick();
        await e.onPrice("BTC-USD", "100", clock);
        [rt] = await db.select().from(botRuntime).where(eq(botRuntime.botId, botId));
        if (rt === undefined) await new Promise((r) => setTimeout(r, 100));
      }
      // Giả lập vị thế long 2 BTC trong sổ cái của bot rồi người dùng bấm Stop.
      const st = rt?.state as { ledger: Record<string, string> };
      await db
        .update(botRuntime)
        .set({ state: { ...st, ledger: { ...st.ledger, position: "2", avgCost: "100" } } })
        .where(eq(botRuntime.botId, botId));
      await e.stop();
      await db
        .update(bots)
        .set({ state: "stopping", closeOnStop: close })
        .where(eq(bots.id, botId));
      gw.received.length = 0;
      const e2 = makeEngine(gw, `w2-${String(close)}`);
      // Lease của shard có thể chưa nhả kịp: thử vài nhịp tới khi bot dừng.
      for (let i = 0; i < 10 && (await botState(botId))?.state !== "stopped"; i += 1) {
        await e2.tick();
        if ((await botState(botId))?.state !== "stopped")
          await new Promise((r) => setTimeout(r, 100));
      }
      const closes = gw.received.filter((o) => o.tag === "close");
      if (close)
        expect(closes).toEqual([
          expect.objectContaining({
            type: "market",
            side: "sell",
            reduceOnly: true,
            quantity: "2",
          }),
        ]);
      else expect(closes).toHaveLength(0);
      expect((await botState(botId))?.state).toBe("stopped");
      await e2.stop();
    }
  });

  it("pauses and stops a bot waiting for its entry price without sending orders (IMP-01, DEC-91)", async () => {
    const { eq } = await import("drizzle-orm");
    const waiting = {
      strategy: "futures_dca",
      market: "BTC-USD",
      engine: "perps" as const,
      config: {
        market: "BTC-USD",
        leverage: 2,
        marginMode: "cross",
        direction: "long",
        baseOrder: "50",
        safetyOrder: "50",
        maxSafetyOrders: 2,
        firstStepPct: "2",
        stepMultiplier: "1",
        sizeMultiplier: "1",
        takeProfitPct: "1",
        stopLossPct: "20",
        entry: "at_price",
        entryPrice: "90",
      },
    };
    for (const action of ["pausing", "stopping"] as const) {
      const gw = new FakeGateway();
      const { botId } = await seedBot("running", waiting);
      const e = makeEngine(gw, `wait-${action}`);
      let rt: typeof botRuntime.$inferSelect | undefined;
      for (let i = 0; i < 20 && rt === undefined; i += 1) {
        await e.tick();
        await e.onPrice("BTC-USD", "100", clock);
        [rt] = await db.select().from(botRuntime).where(eq(botRuntime.botId, botId));
        if (rt === undefined) await new Promise((r) => setTimeout(r, 100));
      }
      await e.onPrice("BTC-USD", "95", clock);
      expect((rt?.state as { phase?: string } | undefined)?.phase).toBe("waiting_entry");
      expect(gw.received.filter((o) => o.market === "BTC-USD")).toHaveLength(0);
      await db.update(bots).set({ state: action }).where(eq(bots.id, botId));
      const done = action === "pausing" ? "paused" : "stopped";
      for (let i = 0; i < 10 && (await botState(botId))?.state !== done; i += 1) {
        await e.tick();
        if ((await botState(botId))?.state !== done) await new Promise((r) => setTimeout(r, 100));
      }
      expect((await botState(botId))?.state).toBe(done);
      // Giá về mức chờ sau khi đã dừng: không có lệnh nào được gửi.
      await e.onPrice("BTC-USD", "89", clock);
      expect(gw.received).toHaveLength(0);
      await e.stop();
    }
  });

  it("records the close fill of a stopped bot from SoDEX, once (DEC-85)", async () => {
    const { eq } = await import("drizzle-orm");
    const gw = new FakeGateway();
    const { botId } = await seedBot("running", {
      strategy: "futures_grid",
      market: "BTC-USD",
      engine: "perps",
      config: {
        market: "BTC-USD",
        direction: "long",
        leverage: 2,
        marginMode: "cross",
        lowerPrice: "90",
        upperPrice: "110",
        gridLevels: 5,
        spacing: "arithmetic",
        margin: "250",
        maxLoss: "100",
        stopBelow: "80",
        onStop: "keep_position",
      },
    });
    const e = makeEngine(gw, "settle");
    let rt: typeof botRuntime.$inferSelect | undefined;
    for (let i = 0; i < 20 && rt === undefined; i += 1) {
      await e.tick();
      await e.onPrice("BTC-USD", "100", clock);
      [rt] = await db.select().from(botRuntime).where(eq(botRuntime.botId, botId));
      if (rt === undefined) await new Promise((r) => setTimeout(r, 100));
    }
    const st = rt?.state as { ledger: Record<string, string> };
    await db
      .update(botRuntime)
      .set({
        state: { ...st, volume: "200", ledger: { ...st.ledger, position: "2", avgCost: "100" } },
      })
      .where(eq(botRuntime.botId, botId));
    await e.stop();
    await db.update(bots).set({ state: "stopping", closeOnStop: true }).where(eq(bots.id, botId));
    const e2 = makeEngine(gw, "settle2");
    for (let i = 0; i < 10 && (await botState(botId))?.state !== "stopped"; i += 1) {
      await e2.tick();
      if ((await botState(botId))?.state !== "stopped")
        await new Promise((r) => setTimeout(r, 100));
    }
    const close = gw.received.find((o) => o.tag === "close");
    expect(close).toBeDefined();
    const id = close?.clOrdID ?? "";
    const row = async () => (await db.select().from(orders).where(eq(orders.clOrdId, id)))[0];
    expect((await row())?.status).toBe("open");

    // Lệnh đã khớp trên SoDEX trong lúc bot dừng và user stream đóng.
    gw.book.set(id, { status: "filled", filledQty: "2", avgPrice: "110", orderId: 77n });
    gw.trades.set(id, [
      {
        tradeId: 9_001n + BigInt(Math.floor(Math.random() * 1e9)),
        price: "110",
        quantity: "2",
        fee: "0.5",
        builderFee: null,
        isMaker: false,
        at: clock,
      },
    ]);
    clock += 20_000;
    await e2.tick();
    clock += 20_000;
    await e2.tick();

    expect((await row())?.status).toBe("filled");
    expect(Number((await row())?.filledSize)).toBe(2);
    const o = await row();
    const recorded = await db
      .select()
      .from(fills)
      .where(eq(fills.orderId, o?.id ?? ""));
    expect(recorded).toHaveLength(1);
    const [after] = await db.select().from(botRuntime).where(eq(botRuntime.botId, botId));
    const ledger = (after?.state as { ledger: Record<string, string> }).ledger;
    expect(ledger).toMatchObject({ position: "0", realized: "20" });
    expect(Number(ledger.fees)).toBe(0.5);
    // Vào 200 + đóng 2 × 110: volume tính cả mở và đóng lệnh.
    expect(Number((after?.state as { volume: string }).volume)).toBe(420);
    const events = await db.select().from(botEvents).where(eq(botEvents.botId, botId));
    expect(events.filter((x) => x.decision === "Order filled")).toHaveLength(1);
    await e2.stop();
  });

  it("still records that close fill when 10+ older orders of the shard stay open on SoDEX (DEC-185)", async () => {
    const { eq } = await import("drizzle-orm");
    const gw = new FakeGateway();
    const { botId } = await seedBot("running", {
      strategy: "futures_grid",
      market: "BTC-USD",
      engine: "perps",
      config: {
        market: "BTC-USD",
        direction: "long",
        leverage: 2,
        marginMode: "cross",
        lowerPrice: "90",
        upperPrice: "110",
        gridLevels: 5,
        spacing: "arithmetic",
        margin: "250",
        maxLoss: "100",
        stopBelow: "80",
        onStop: "keep_position",
      },
    });
    const e = makeEngine(gw, "fair");
    let rt: typeof botRuntime.$inferSelect | undefined;
    for (let i = 0; i < 20 && rt === undefined; i += 1) {
      await e.tick();
      await e.onPrice("BTC-USD", "100", clock);
      [rt] = await db.select().from(botRuntime).where(eq(botRuntime.botId, botId));
      if (rt === undefined) await new Promise((r) => setTimeout(r, 100));
    }
    const st = rt?.state as { ledger: Record<string, string> };
    await db
      .update(botRuntime)
      .set({ state: { ...st, ledger: { ...st.ledger, position: "2", avgCost: "100" } } })
      .where(eq(botRuntime.botId, botId));
    await e.stop();
    await db.update(bots).set({ state: "stopping", closeOnStop: true }).where(eq(bots.id, botId));
    const e2 = makeEngine(gw, "fair2");
    for (let i = 0; i < 10 && (await botState(botId))?.state !== "stopped"; i += 1) {
      await e2.tick();
      if ((await botState(botId))?.state !== "stopped")
        await new Promise((r) => setTimeout(r, 100));
    }
    const id = gw.received.find((o) => o.tag === "close")?.clOrdID ?? "";
    const { and } = await import("drizzle-orm");
    // clOrdID tất định có thể trùng với lệnh đóng của test trước: lọc thêm theo bot.
    const row = async () =>
      (
        await db
          .select()
          .from(orders)
          .where(and(eq(orders.clOrdId, id), eq(orders.botId, botId)))
      )[0];
    expect((await row())?.status).toBe("open");

    // 12 lệnh cũ hơn của cùng account (cùng shard) vẫn "open" trong DRIFT; SoDEX chưa thấy chúng (not_found < 30 s)
    // nên mỗi vòng chúng vẫn tới hạn kiểm mà không được giải quyết. Trước bản sửa, chúng chiếm hết 10 suất mỗi vòng.
    const closeRow = await row();
    for (let i = 0; i < 12; i += 1)
      await db.insert(orders).values({
        botId,
        sodexAccountId: closeRow?.sodexAccountId ?? "",
        clOrdId: `stale-${String(i)}-${String(Math.random())}`,
        market: "BTC-USD",
        engine: "perps",
        side: "buy",
        type: "limit",
        timeInForce: "GTC",
        size: "1",
        status: "open",
        tag: "grid",
        epoch: 1,
        submittedAt: new Date(clock - 1_000 - i),
      });

    gw.book.set(id, { status: "filled", filledQty: "2", avgPrice: "110", orderId: 78n });
    gw.trades.set(id, [
      {
        tradeId: 19_001n + BigInt(Math.floor(Math.random() * 1e9)),
        price: "110",
        quantity: "2",
        fee: "0.5",
        builderFee: null,
        isMaker: false,
        at: clock,
      },
    ]);
    clock += 20_000;
    await e2.tick();
    clock += 20_000;
    await e2.tick();

    expect((await row())?.status).toBe("filled");
    const recorded = await db
      .select()
      .from(fills)
      .where(eq(fills.orderId, (await row())?.id ?? ""));
    expect(recorded).toHaveLength(1);
    await e2.stop();
  });

  it("sends a separate close for each bot of an account stopped together, once (DEC-186)", async () => {
    const { eq, inArray } = await import("drizzle-orm");
    const config = {
      market: "BTC-USD",
      direction: "long",
      leverage: 2,
      marginMode: "cross",
      lowerPrice: "90",
      upperPrice: "110",
      gridLevels: 5,
      spacing: "arithmetic",
      margin: "250",
      maxLoss: "100",
      stopBelow: "80",
      onStop: "keep_position",
    };
    const gw = new FakeGateway();
    const a = await seedBot("running", {
      strategy: "futures_grid",
      market: "BTC-USD",
      engine: "perps",
      config,
    });
    // Bot thứ hai cùng account, tạo ngay sau: uuidv7 cùng 8 ký tự đầu như bot thứ nhất.
    const [owner] = await db.select().from(bots).where(eq(bots.id, a.botId));
    const [b] = await db
      .insert(bots)
      .values({
        userId: owner?.userId ?? "",
        sodexAccountId: a.accountId,
        strategy: "futures_grid",
        market: "BTC-USD",
        engine: "perps",
        name: "Grid 2",
        state: "running",
      })
      .returning();
    const botB = b?.id ?? "";
    const [vb] = await db
      .insert(botVersions)
      .values({ botId: botB, version: 1, paramSource: "manual", status: "active", config })
      .returning();
    await db
      .update(bots)
      .set({ activeVersionId: vb?.id ?? "" })
      .where(eq(bots.id, botB));
    expect(botB.slice(0, 8)).toBe(a.botId.slice(0, 8));
    const ids = [a.botId, botB];

    const e = makeEngine(gw, "pair");
    let rts: (typeof botRuntime.$inferSelect)[] = [];
    for (let i = 0; i < 20 && rts.length < 2; i += 1) {
      await e.tick();
      await e.onPrice("BTC-USD", "100", clock);
      rts = await db.select().from(botRuntime).where(inArray(botRuntime.botId, ids));
      if (rts.length < 2) await new Promise((r) => setTimeout(r, 100));
    }
    for (const rt of rts) {
      const st = rt.state as { ledger: Record<string, string> };
      await db
        .update(botRuntime)
        .set({ state: { ...st, ledger: { ...st.ledger, position: "1", avgCost: "100" } } })
        .where(eq(botRuntime.botId, rt.botId));
    }
    await e.stop();
    await db
      .update(bots)
      .set({ state: "stopping", closeOnStop: true })
      .where(inArray(bots.id, ids));
    const e2 = makeEngine(gw, "pair2");
    const stopped = async () =>
      (await db.select().from(bots).where(inArray(bots.id, ids))).every(
        (x) => x.state === "stopped",
      );
    for (let i = 0; i < 10 && !(await stopped()); i += 1) {
      await e2.tick();
      if (!(await stopped())) await new Promise((r) => setTimeout(r, 100));
    }
    const closes = () => gw.received.filter((o) => o.tag === "close");
    expect(closes()).toHaveLength(2);
    expect(new Set(closes().map((o) => o.clOrdID)).size).toBe(2);
    const sent = await db
      .select()
      .from(orders)
      .where(
        inArray(
          orders.clOrdId,
          closes().map((o) => o.clOrdID),
        ),
      );
    expect(new Set(sent.map((o) => o.botId))).toEqual(new Set(ids));

    // Engine khởi động lại: mã tất định, không gửi lại lệnh đóng đã gửi.
    await e2.stop();
    const e3 = makeEngine(gw, "pair3");
    for (let i = 0; i < 3; i += 1) await e3.tick();
    expect(closes()).toHaveLength(2);
    await e3.stop();
  });

  const farmConfig = (market: string) => ({
    market,
    leverage: 5,
    marginMode: "cross",
    orderSizeMinUsd: "100",
    orderSizeMaxUsd: "200",
    minHoldSecs: 120,
    maxHoldSecs: 180,
    tpUsd: "0.5",
    slPct: "5",
    earlyProfitUsd: "0.15",
    maxLoss: "20",
  });
  async function seedFarm(market: string) {
    const { eq } = await import("drizzle-orm");
    const { botId, accountId } = await seedBot("running", {
      strategy: "volume_farm",
      market,
      engine: "perps",
      config: farmConfig(market),
    });
    const [b] = await db.select().from(bots).where(eq(bots.id, botId));
    await db
      .update(users)
      .set({ volumeBots: true })
      .where(eq(users.id, b?.userId ?? ""));
    return { botId, accountId };
  }
  async function seedCandles(market: string) {
    const end = clock - (clock % 60_000);
    await db
      .insert(candles1m)
      .values(
        Array.from({ length: 30 }, (_, i) => {
          const o = 100 * (1 + 0.0001 * i);
          const c = 100 * (1 + 0.0001 * (i + 1));
          return {
            market,
            ts: new Date(end - (30 - i) * 60_000),
            open: o.toFixed(4),
            high: (c * 1.0002).toFixed(4),
            low: (o * 0.9998).toFixed(4),
            close: c.toFixed(4),
            volume: String(10 + i),
          };
        }),
      )
      .onConflictDoNothing();
  }
  const farmEngine = (gw: FakeGateway, id: string) =>
    new Engine({
      db,
      redis: newRedis(),
      gateway: gw,
      workerId: id,
      log,
      now,
      leaseTtlMs: 30_000,
      shards: SHARDS,
      rules: () => Promise.resolve(rules),
      feeCheckMs: 0,
      orderbook: () =>
        Promise.resolve({ bid: "100", ask: "100.05", bidNotional: "50000", askNotional: "40000" }),
    });
  /** DB dùng chung cả file: bot còn running sẽ chạy tiếp trong test sau. */
  async function stopFarmBots() {
    const { eq } = await import("drizzle-orm");
    await db.update(bots).set({ state: "stopped" }).where(eq(bots.strategy, "volume_farm"));
  }
  async function tickUntil(e: Engine, done: () => boolean | Promise<boolean>) {
    for (let i = 0; i < 20 && !(await done()); i += 1) {
      await e.tick();
      if (!(await done())) await new Promise((r) => setTimeout(r, 100));
    }
  }

  it("feeds every Volume Farm bot on the same market, across customers (DEC-87)", async () => {
    const gw = new FakeGateway();
    await seedCandles("SOL-USD");
    await seedFarm("SOL-USD");
    await seedFarm("SOL-USD");
    const e = farmEngine(gw, "two-bots");
    await tickUntil(e, () => gw.received.filter((o) => o.tag.startsWith("vf:")).length >= 2);
    expect(gw.received.filter((o) => o.tag.startsWith("vf:"))).toHaveLength(2);
    await e.stop();
    await stopFarmBots();
  });

  it("counts a partly filled order once when its updates arrive together (DEC-87)", async () => {
    const { eq } = await import("drizzle-orm");
    const gw = new FakeGateway();
    await seedCandles("XRP-USD");
    const { botId, accountId } = await seedFarm("XRP-USD");
    const e = farmEngine(gw, "partial");
    await tickUntil(e, () => gw.received.some((o) => o.tag.startsWith("vf:")));
    const order = gw.received.find((o) => o.tag.startsWith("vf:"));
    const id = order?.clOrdID ?? "";
    await Promise.all([
      e.onFill(accountId, id, "0.4", "100", "0.01", clock),
      e.onFill(accountId, id, "1", "101", "0.02", clock),
    ]);
    const [rt] = await db.select().from(botRuntime).where(eq(botRuntime.botId, botId));
    const st = rt?.state as { volume: string; ledger: { position: string; fees: string } };
    expect(Number(st.ledger.position)).toBe(1);
    // 0.4 × 100 + 0.6 × ((1 × 101 − 40) / 0.6) = 101: đúng tổng giá trị SoDEX báo.
    expect(Number(st.volume)).toBeCloseTo(101, 8);
    await e.stop();
    await stopFarmBots();
  });

  it("finds a fill behind a cancelled order after a stream gap (DEC-87)", async () => {
    const { eq } = await import("drizzle-orm");
    const gw = new FakeGateway();
    await seedCandles("LTC-USD");
    const { botId, accountId } = await seedFarm("LTC-USD");
    const e = farmEngine(gw, "gap");
    await tickUntil(e, () => gw.received.some((o) => o.tag.startsWith("vf:")));
    const id = gw.received.find((o) => o.tag.startsWith("vf:"))?.clOrdID ?? "";
    // Hết 10 s chưa nhận tin khớp: bot huỷ và tưởng chưa có vị thế.
    clock += 11_000;
    await e.tick();
    const row = async () => (await db.select().from(orders).where(eq(orders.clOrdId, id)))[0];
    expect((await row())?.status).toBe("cancelled");
    // Thật ra lệnh đã khớp trước lúc huỷ, tin khớp mất vì kết nối đứt.
    gw.book.set(id, { status: "filled", filledQty: "1.5", avgPrice: "100", orderId: 5n });
    gw.trades.set(id, [
      {
        tradeId: 7_000n + BigInt(Math.floor(Math.random() * 1e9)),
        price: "100",
        quantity: "1.5",
        fee: "0.03",
        builderFee: null,
        isMaker: true,
        at: clock,
      },
    ]);
    // Chưa báo đứt kết nối: không tốn REST đối soát.
    await e.tick();
    expect((await row())?.status).toBe("cancelled");
    e.onStreamGap(accountId);
    clock += 20_000;
    await e.tick();
    expect((await row())?.status).toBe("filled");
    const [rt] = await db.select().from(botRuntime).where(eq(botRuntime.botId, botId));
    const st = rt?.state as { phase: string; ledger: { position: string } };
    expect(Number(st.ledger.position)).toBe(1.5);
    expect(st.phase).toBe("open");
    await e.stop();
    await stopFarmBots();
  });

  it("feeds Volume Farm candles and the order book, and enters post-only at the best bid", async () => {
    const gw = new FakeGateway();
    const { botId } = await seedBot("running", {
      strategy: "volume_farm",
      market: "BTC-USD",
      engine: "perps",
      config: {
        market: "BTC-USD",
        leverage: 5,
        marginMode: "cross",
        orderSizeMinUsd: "100",
        orderSizeMaxUsd: "200",
        minHoldSecs: 120,
        maxHoldSecs: 180,
        tpUsd: "0.5",
        slPct: "5",
        earlyProfitUsd: "0.15",
        maxLoss: "20",
      },
    });
    const { eq } = await import("drizzle-orm");
    const [b] = await db.select().from(bots).where(eq(bots.id, botId));
    // Team tắt bot khối lượng cho user này: engine chưa được chạy bot.
    await db
      .update(users)
      .set({ volumeBots: false })
      .where(eq(users.id, b?.userId ?? ""));
    // Nến tăng nhẹ 30 phút, nến cuối đóng ngay trước `clock`.
    const end = clock - (clock % 60_000);
    await db.insert(candles1m).values(
      Array.from({ length: 30 }, (_, i) => {
        const o = 100 * (1 + 0.0001 * i);
        const c = 100 * (1 + 0.0001 * (i + 1));
        return {
          market: "BTC-USD",
          ts: new Date(end - (30 - i) * 60_000),
          open: o.toFixed(4),
          high: (c * 1.0002).toFixed(4),
          low: (o * 0.9998).toFixed(4),
          close: c.toFixed(4),
          volume: String(10 + i),
        };
      }),
    );
    const book = { bid: "100", ask: "100.1", bidNotional: "50000", askNotional: "40000" };
    const make = () =>
      new Engine({
        db,
        redis: newRedis(),
        gateway: gw,
        workerId: "w1",
        log,
        now,
        leaseTtlMs: 300,
        shards: SHARDS,
        rules: () => Promise.resolve(rules),
        feeCheckMs: 0,
        orderbook: () => Promise.resolve(book),
      });
    const off = make();
    await off.tick();
    expect(gw.received).toHaveLength(0);
    await off.stop();
    await db
      .update(users)
      .set({ volumeBots: true })
      .where(eq(users.id, b?.userId ?? ""));
    const e = make();
    await e.tick();
    const sent = gw.received.filter((o) => o.tag.startsWith("vf:"));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      side: "buy",
      timeInForce: "GTX",
      price: "100",
      reduceOnly: false,
    });
    await e.stop();
  });

  it("stores SoDEX's reject message on the order row (rejected TWAP slice)", async () => {
    const gw = new FakeGateway();
    gw.reject = { code: "-1", message: "reduce only order would increase position" };
    const { botId } = await seedBot("running", {
      strategy: "twap",
      market: "BTC-USD",
      engine: "perps",
      config: {
        market: "BTC-USD",
        engine: "perps",
        side: "sell",
        totalSize: "1",
        durationMinutes: 10,
        slices: 10,
        reduceOnly: true,
        maxSlippagePct: "1",
        onSkip: "leave_unfilled",
      },
    });
    const { eq } = await import("drizzle-orm");
    const e = makeEngine(gw, "w1");
    const rows = () => db.select().from(orders).where(eq(orders.botId, botId));
    for (let i = 0; i < 6 && (await rows()).length === 0; i += 1) {
      clock += 61_000;
      await e.tick();
      await e.onPrice("BTC-USD", "100", clock);
    }
    const [o] = await rows();
    expect(o).toMatchObject({
      status: "rejected",
      rejectCode: "-1",
      rejectMessage: "reduce only order would increase position",
    });
    await e.stop();
  });

  /** Bot Volume Farm có sổ cái ghi vị thế mà SoDEX từ chối mọi lệnh thoát; chạy tới khi bot pause. */
  async function exitsRejected(extra: Record<string, unknown>) {
    const gw = new FakeGateway();
    const { botId } = await seedBot("running", {
      strategy: "volume_farm",
      market: "BTC-USD",
      engine: "perps",
      config: {
        market: "BTC-USD",
        leverage: 5,
        marginMode: "cross",
        orderSizeMinUsd: "100",
        orderSizeMaxUsd: "200",
        minHoldSecs: 120,
        maxHoldSecs: 180,
        tpUsd: "0.5",
        slPct: "5",
        earlyProfitUsd: "0.15",
        maxLoss: "20",
        ...extra,
      },
    });
    const { eq } = await import("drizzle-orm");
    const [b0] = await db.select().from(bots).where(eq(bots.id, botId));
    await db
      .update(users)
      .set({ volumeBots: true })
      .where(eq(users.id, b0?.userId ?? ""));
    const book = { bid: "100", ask: "100.1", bidNotional: "50000", askNotional: "40000" };
    const make = (id: string) =>
      new Engine({
        db,
        redis: newRedis(),
        gateway: gw,
        workerId: id,
        log,
        now,
        leaseTtlMs: 30_000, // tick chậm hơn lease thì mất shard, runner nạp lại và reduceRejects về 0
        shards: SHARDS,
        rules: () => Promise.resolve(rules),
        feeCheckMs: 0,
        orderbook: () => Promise.resolve(book),
      });
    const e = make("w1");
    let rt: typeof botRuntime.$inferSelect | undefined;
    for (let i = 0; i < 90 && rt === undefined; i += 1) {
      await e.tick();
      [rt] = await db.select().from(botRuntime).where(eq(botRuntime.botId, botId));
      if (rt === undefined) await new Promise((r) => setTimeout(r, 100));
    }
    await e.stop();
    // Sổ của bot ghi long 0.002 BTC mở từ lâu (quá max hold) nhưng SoDEX không còn vị thế: mọi lệnh đóng bị từ chối.
    const st = rt?.state as Record<string, unknown> & { ledger: Record<string, string> };
    await db
      .update(botRuntime)
      .set({
        state: {
          ...st,
          phase: "open",
          entry: null,
          exit: null,
          openedAt: clock - 3_600_000,
          ledger: { ...st.ledger, position: "0.002", avgCost: "100" },
        },
      })
      .where(eq(botRuntime.botId, botId));
    gw.received.length = 0;
    gw.reject = { code: "-1", message: "no position to reduce" };
    // Cùng workerId: key `engine:worker:w1` còn sống (lease dài) thì "w2" chỉ nhận một nửa số shard.
    const e2 = make("w1");
    for (let i = 0; i < 90 && (await botState(botId))?.state !== "paused"; i += 1) {
      clock += 3_000;
      await e2.tick();
      if ((await botState(botId))?.state !== "paused") await new Promise((r) => setTimeout(r, 50));
    }
    await e2.stop();
    // Stop loss gốc trên SoDEX (DEC-118) không phải lệnh thoát của bot.
    return { exits: gw.received.filter((o) => o.reduceOnly && o.stop === undefined), botId };
  }

  it("tries market before pausing when reduce-only exits are rejected (DEC-89)", async () => {
    const { exits, botId } = await exitsRejected({ allowTaker: true });
    // Post-only bị từ chối không pause; sau `takerAfter` chuyển market, market bị từ chối 3 lần mới pause.
    expect(exits.map((o) => o.type)).toEqual([
      "limit",
      "limit",
      "limit",
      "market",
      "market",
      "market",
    ]);
    const b = await botState(botId);
    expect(b?.state).toBe("paused");
    expect(b?.reasonCode).toBe(ReasonCode.orderRejected);
    const { eq } = await import("drizzle-orm");
    const events = await db.select().from(botEvents).where(eq(botEvents.botId, botId));
    const paused = events.find((x) => x.decision?.startsWith("Paused: SoDEX rejected 3") === true);
    expect(paused?.why).toContain("SoDEX code -1: no position to reduce");
  });

  it("still stops resending post-only exits when taker is off (DEC-89)", async () => {
    const { exits, botId } = await exitsRejected({ allowTaker: false });
    expect(exits).toHaveLength(30);
    expect(exits.every((o) => o.type === "limit")).toBe(true);
    expect((await botState(botId))?.state).toBe("paused");
  });

  // ---------- Market Making: đối soát fill + vị thế (DEC-100) ----------

  const makerConfig = {
    market: "BTC-USD",
    leverage: 5,
    orderSize: "500",
    costBudget: "300",
  };
  async function seedMaker() {
    const { eq } = await import("drizzle-orm");
    const seeded = await seedBot("running", {
      strategy: "volume_maker",
      market: "BTC-USD",
      engine: "perps",
      config: makerConfig,
    });
    const [b] = await db.select().from(bots).where(eq(bots.id, seeded.botId));
    await db
      .update(users)
      .set({ volumeBots: true })
      .where(eq(users.id, b?.userId ?? ""));
    return { ...seeded, userId: b?.userId ?? "" };
  }
  async function stopMakerBots() {
    const { eq } = await import("drizzle-orm");
    await db.update(bots).set({ state: "stopped" }).where(eq(bots.strategy, "volume_maker"));
  }
  interface MakerState {
    ledger: { position: string };
    orders: Record<string, { status: string; filled: string }>;
    drift: { size: string } | null;
  }
  const makerState = async (botId: string) => {
    const { eq } = await import("drizzle-orm");
    const [rt] = await db.select().from(botRuntime).where(eq(botRuntime.botId, botId));
    return rt?.state as MakerState;
  };

  it("counts a missed fill on a cancelled Market Making quote exactly once (DEC-100)", async () => {
    const { eq } = await import("drizzle-orm");
    const gw = new FakeGateway();
    const { botId } = await seedMaker();
    const e = farmEngine(gw, "vm-backfill");
    await e.tick();
    await e.onPrice("BTC-USD", "100000", clock);
    const bid = gw.received.find((o) => o.tag.endsWith(":bid"));
    expect(bid?.timeInForce).toBe("GTX");
    const id = bid?.clOrdID ?? "";
    // Hết chu kỳ refresh: bot huỷ báo giá cũ và đặt báo giá mới.
    clock += 4_000;
    await e.tick();
    expect(gw.cancelled).toContain(id);
    expect((await makerState(botId)).orders[id]?.status).toBe("done");
    // Thật ra báo giá cũ đã khớp 0.002 ngay trước lúc huỷ; tin khớp không tới qua user stream.
    gw.trades.set(id, [
      {
        tradeId: 9_000n + BigInt(Math.floor(Math.random() * 1e9)),
        price: "99990",
        quantity: "0.002",
        fee: "0.02",
        builderFee: null,
        isMaker: true,
        at: clock,
      },
    ]);
    for (let i = 0; i < 3; i += 1) {
      clock += 10_000;
      await e.tick();
    }
    const st = await makerState(botId);
    expect(st.ledger.position).toBe("0.002");
    expect(st.orders[id]?.filled).toBe("0.002");
    const [row] = await db.select().from(orders).where(eq(orders.clOrdId, id));
    expect(row?.status).toBe("cancelled");
    expect(Number(row?.filledSize)).toBe(0.002);
    const recorded = await db
      .select()
      .from(fills)
      .where(eq(fills.orderId, row?.id ?? ""));
    expect(recorded).toHaveLength(1);
    // Bot đặt lệnh đóng reduce-only theo đúng vị thế đã đối soát.
    const close = gw.received.filter((o) => o.reduceOnly && o.side === "sell");
    expect(close.at(-1)?.quantity).toBe("0.002");
    await e.stop();
    await stopMakerBots();
  });

  it("marks a quote done only when SoDEX confirms the cancel, and syncs position only for a sole bot (DEC-100)", async () => {
    const { eq } = await import("drizzle-orm");
    const gw = new FakeGateway();
    gw.cancelOutcome = "unknown";
    const { botId, accountId, userId } = await seedMaker();
    const e = farmEngine(gw, "vm-sync");
    await e.tick();
    await e.onPrice("BTC-USD", "100000", clock);
    const id = gw.received.find((o) => o.tag.endsWith(":bid"))?.clOrdID ?? "";
    clock += 4_000;
    await e.tick();
    // Huỷ chưa rõ kết quả: lệnh vẫn có thể khớp, chưa được coi là xong.
    expect(gw.cancelled).toContain(id);
    expect((await makerState(botId)).orders[id]?.status).toBe("cancelling");
    // Bot duy nhất trên BTC-USD của account: vị thế SoDEX lệch thì ghi nhận lần đầu.
    expect(gw.positionReads).toBeGreaterThan(0);
    gw.perpsPositions.set("BTC-USD", { size: "-0.003", entryPrice: "100010" });
    clock += 30_000;
    await e.tick();
    expect((await makerState(botId)).drift?.size).toBe("-0.003");
    // Thêm một bot khác của cùng account trên BTC-USD: không chia được vị thế, không đọc nữa.
    await db.insert(bots).values({
      userId,
      sodexAccountId: accountId,
      strategy: "futures_grid",
      market: "BTC-USD",
      engine: "perps",
      name: "Grid",
      state: "paused",
    });
    const reads = gw.positionReads;
    clock += 30_000;
    await e.tick();
    expect(gw.positionReads).toBe(reads);
    expect((await makerState(botId)).ledger.position).toBe("0");
    await e.stop();
    await stopMakerBots();
    await db.update(bots).set({ state: "stopped" }).where(eq(bots.sodexAccountId, accountId));
  });

  // ---------- Paper mode (DEC-105) ----------

  /** Ghi lại mọi lời gọi tới cổng thật (để chứng minh bot paper không bao giờ đi qua đây). */
  function spyGateway(gw: FakeGateway) {
    const calls: { method: string; paper: boolean; payload: string }[] = [];
    const proxy = new Proxy(gw, {
      get(target, prop, receiver) {
        const v = Reflect.get(target, prop, receiver) as unknown;
        if (typeof v !== "function") return v;
        return (...args: unknown[]) => {
          const a = args[0] as { paper?: boolean } | undefined;
          calls.push({
            method: String(prop),
            paper: a?.paper === true,
            payload: JSON.stringify(args, (_k, x: unknown) =>
              typeof x === "bigint" ? x.toString() : x,
            ),
          });
          return (v as (...x: unknown[]) => unknown).apply(target, args);
        };
      },
    });
    return { proxy: proxy as Gateway, calls };
  }
  async function seedPaper(capital = "1000") {
    const { eq } = await import("drizzle-orm");
    const seeded = await seedBot("running");
    await db.update(bots).set({ mode: "paper" }).where(eq(bots.id, seeded.botId));
    await db.insert(paperAccounts).values({
      botId: seeded.botId,
      capital,
      cash: capital,
      positions: {},
      peakEquity: capital,
      startedAt: new Date(clock),
    });
    return seeded;
  }
  const paperEngine = (gw: Gateway, id: string) =>
    new Engine({
      db,
      redis: newRedis(),
      gateway: gw,
      paper: new PaperGateway({ db, now }),
      workerId: id,
      log,
      now,
      leaseTtlMs: 30_000,
      shards: SHARDS,
      rules: () => Promise.resolve(rules),
      feeCheckMs: 0,
    });
  async function stopPaperBots() {
    const { eq } = await import("drizzle-orm");
    await db.update(bots).set({ state: "stopped" }).where(eq(bots.mode, "paper"));
  }

  it("runs a paper bot without ever calling the real gateway or the signer, even with an API key", async () => {
    const { eq } = await import("drizzle-orm");
    const real = new FakeGateway();
    const { proxy, calls } = spyGateway(real);
    const { botId } = await seedPaper();
    const e = paperEngine(proxy, "paper-1");
    await e.tick();
    await e.onPrice("vBTC_vUSDC", "100", clock);
    const placed = await db.select().from(orders).where(eq(orders.botId, botId));
    expect(placed.length).toBeGreaterThan(0);
    expect(real.received.filter((o) => placed.some((p) => p.clOrdId === o.clOrdID))).toEqual([]);
    // Giá chỉ chạm mức mua 95: không khớp. Đi xuyên qua (94.9): khớp.
    const buy95 = placed.find((o) => o.side === "buy" && Number(o.price) === 95);
    expect(buy95).toBeDefined();
    const fillsOf95 = async () =>
      db
        .select()
        .from(paperFills)
        .where(eq(paperFills.orderId, buy95?.id ?? ""));
    await e.onPrice("vBTC_vUSDC", "95", clock + 1000);
    expect(await fillsOf95()).toHaveLength(0);
    // Lệnh market khởi tạo của grid (mua coin cho các mức bán) khớp ở giá kế tiếp, có trượt giá.
    const init = (await db.select().from(paperFills).where(eq(paperFills.botId, botId))).find(
      (f) => !f.isMaker,
    );
    expect(Number(init?.price)).toBeCloseTo(95 * 1.0005, 6);
    await e.onPrice("vBTC_vUSDC", "94.9", clock + 2000);
    expect((await fillsOf95()).map((f) => Number(f.price))).toEqual([95]);
    // Không có gì trong `fills` thật; sổ cái của bot đã nhận fill.
    const realFills = await db
      .select()
      .from(fills)
      .where(
        (await import("drizzle-orm")).inArray(
          fills.orderId,
          placed.map((o) => o.id),
        ),
      );
    expect(realFills).toHaveLength(0);
    const [rt] = await db.select().from(botRuntime).where(eq(botRuntime.botId, botId));
    expect(JSON.stringify(rt?.state)).toContain("95");
    // Đối soát, kiểm tra phí, stream: không lời gọi nào của cổng thật mang account paper, không lệnh nào gửi đi.
    clock += 30_000;
    await e.tick();
    // DB dùng chung cả file: cổng thật vẫn phục vụ bot thật của test khác, nhưng không lời gọi nào mang account
    // paper hay lệnh của bot paper, và không lệnh paper nào tới SoDEX.
    const paperIds = (await db.select().from(orders).where(eq(orders.botId, botId))).map(
      (o) => o.clOrdId,
    );
    expect(calls.filter((c) => c.paper)).toEqual([]);
    expect(calls.filter((c) => paperIds.some((id) => c.payload.includes(id)))).toEqual([]);
    expect(real.received.filter((o) => paperIds.includes(o.clOrdID))).toEqual([]);
    expect((await e.activeAccounts()).some((x) => x.paper === true)).toBe(false);
    // Số dư giả được ghi theo phút.
    const snaps = await db.select().from(paperSnapshots).where(eq(paperSnapshots.botId, botId));
    expect(snaps.length).toBeGreaterThan(0);
    await e.stop();
    await stopPaperBots();
  });

  it("keeps paper bots running when the real account's builder fee is revoked", async () => {
    const real = new FakeGateway();
    const { botId } = await seedPaper();
    const e = paperEngine(real, "paper-2");
    await e.tick();
    await e.onPrice("vBTC_vUSDC", "100", clock);
    real.approved = false;
    clock += 1000;
    await e.tick();
    expect((await botState(botId))?.state).toBe("running");
    expect(real.received).toHaveLength(0);
    await e.stop();
    await stopPaperBots();
  });

  it("rejects a paper order the fake balance can't pay for", async () => {
    const { eq } = await import("drizzle-orm");
    const real = new FakeGateway();
    // Vốn giả 10 USDC, grid cần 500: lệnh mua bị từ chối như SoDEX thiếu số dư.
    const { botId } = await seedPaper("10");
    const e = paperEngine(real, "paper-3");
    await e.tick();
    await e.onPrice("vBTC_vUSDC", "100", clock);
    const rows = await db.select().from(orders).where(eq(orders.botId, botId));
    expect(
      rows.some((o) => o.status === "rejected" && o.rejectCode === "INSUFFICIENT_BALANCE"),
    ).toBe(true);
    expect(real.received).toHaveLength(0);
    await e.stop();
    await stopPaperBots();
  });

  it("feeds 1-minute candles to AI Adaptive DCA bots, only for accounts with AI Desk on (DEC-107)", async () => {
    const { eq } = await import("drizzle-orm");
    const gw = new FakeGateway();
    await seedCandles("ETH-USD");
    const { botId } = await seedBot("running", {
      strategy: "adaptive_dca",
      market: "ETH-USD",
      engine: "perps",
      config: {
        market: "ETH-USD",
        leverage: 2,
        baseOrder: "100",
        safetyOrder: "100",
        maxExposure: "1000",
        maxLoss: "150",
      },
    });
    const state = async () =>
      (await db.select().from(botRuntime).where(eq(botRuntime.botId, botId)))[0]?.state as
        { regime?: string } | undefined;
    // Một engine cho cả hai giai đoạn: chưa bật cờ Adaptive DCA thì không nạp bot; bật rồi thì vòng sau nạp và gửi nến
    // (cờ riêng, không theo AI Desk: DEC-192).
    const e = farmEngine(gw, "adca");
    await e.tick();
    await e.onPrice("ETH-USD", "100", clock);
    await e.tick();
    expect(await state()).toBeUndefined();
    const [b] = await db.select().from(bots).where(eq(bots.id, botId));
    await db
      .update(users)
      .set({ adaptiveDca: true })
      .where(eq(users.id, b?.userId ?? ""));
    await tickUntil(e, async () => (await state())?.regime !== undefined);
    expect((await state())?.regime).toBeDefined();
    await e.stop();
    await db.update(bots).set({ state: "stopped" }).where(eq(bots.id, botId));
  });

  it("routes a leader's fill to the copy bots following that wallet, as an IOC order (DEC-161)", async () => {
    const { eq } = await import("drizzle-orm");
    const gw = new FakeGateway();
    const leader = "0x1111111111111111111111111111111111111111";
    const copyConfig = (leaderAddress: string) => ({
      leaderSource: "sodex",
      leaderAddress,
      market: "BTC-USD",
      leverage: 2,
      fixedNotional: "100",
      maxNotionalPerTrade: "200",
      maxExposure: "1000",
      maxLoss: "150",
    });
    const spec = (address: string) => ({
      strategy: "copy_trade",
      market: "BTC-USD",
      engine: "perps" as const,
      config: copyConfig(address),
    });
    const follower = await seedBot("running", spec(leader));
    const other = await seedBot("running", spec("0x2222222222222222222222222222222222222222"));
    for (const id of [follower.botId, other.botId]) {
      const [b] = await db.select().from(bots).where(eq(bots.id, id));
      await db
        .update(users)
        .set({ aiDesk: true })
        .where(eq(users.id, b?.userId ?? ""));
    }
    const e = farmEngine(gw, "copy");
    await e.tick();
    await e.onPrice("BTC-USD", "100000", clock);
    await e.onLeaderFill(
      {
        source: "sodex",
        address: leader,
        market: "BTC-USD",
        side: "buy",
        price: "100000",
        quantity: "1",
        positionAfter: "1",
        at: clock,
      },
      clock + 200,
    );
    const sent = gw.received.filter((o) => o.tag.startsWith("copy:"));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      side: "buy",
      type: "limit",
      timeInForce: "IOC",
      reduceOnly: false,
      quantity: "0.001",
      price: "100300",
    });
    await e.stop();
    await db.update(bots).set({ state: "stopped" }).where(eq(bots.strategy, "copy_trade"));
  });

  // Cảnh báo bot copy (DEC-212): chỉ thêm outbox trong transaction đang có.
  const copyAlertRows = async (botId: string, type: string) => {
    const { and, eq, sql } = await import("drizzle-orm");
    const rows = await db
      .select({ payload: outbox.payload })
      .from(outbox)
      .where(
        and(
          eq(outbox.topic, "jobs.notify"),
          sql`${outbox.payload}->>'type' = ${type}`,
          sql`${outbox.payload}->'data'->>'botId' = ${botId}`,
        ),
      );
    return rows.map((r) => r.payload as { data: Record<string, unknown>; dedupeKey?: string });
  };
  const copySpec = (leaderAddress: string) => ({
    strategy: "copy_trade",
    market: "BTC-USD",
    engine: "perps" as const,
    config: {
      leaderSource: "sodex",
      leaderAddress,
      market: "BTC-USD",
      leverage: 2,
      fixedNotional: "100",
      maxNotionalPerTrade: "200",
      maxExposure: "1000",
      maxLoss: "150",
    },
  });
  const leaderFill = (address: string, positionAfter: string, at: number) => ({
    source: "sodex" as const,
    address,
    market: "BTC-USD",
    side: "buy" as const,
    price: "100000",
    quantity: "1",
    positionAfter,
    at,
  });
  const enableDesk = async (botId: string) => {
    const { eq } = await import("drizzle-orm");
    const [b] = await db.select().from(bots).where(eq(bots.id, botId));
    await db
      .update(users)
      .set({ aiDesk: true })
      .where(eq(users.id, b?.userId ?? ""));
  };

  it("writes exactly one copy_bot_opened per filled open, even when the fill is replayed (DEC-212)", async () => {
    const { eq } = await import("drizzle-orm");
    const gw = new FakeGateway();
    const leader = "0x3333333333333333333333333333333333333333";
    const { botId, accountId } = await seedBot("running", copySpec(leader));
    await enableDesk(botId);
    const e = farmEngine(gw, "copy-alerts");
    await e.tick();
    await e.onPrice("BTC-USD", "100000", clock);
    await e.onLeaderFill(leaderFill(leader, "1", clock), clock + 200);
    const sent = gw.received.filter((o) => o.tag.startsWith("copy:"));
    expect(sent).toHaveLength(1);
    const id = sent[0]?.clOrdID ?? "";
    await e.onFill(accountId, id, "0.001", "100100", "0.01", clock + 300);
    // Phát lại cùng fill (reconnect / đối soát / restart) và lệnh xong phát lại: không có tin thứ hai.
    await e.onFill(accountId, id, "0.001", "100100", "0.01", clock + 400);
    await e.onOrderClosed(accountId, id, "cancelled", clock + 500);
    const opened = await copyAlertRows(botId, "copy_bot_opened");
    expect(opened).toHaveLength(1);
    expect(opened[0]?.data).toMatchObject({
      botId,
      clOrdID: id,
      market: "BTC-USD",
      move: "opened",
      side: "long",
      size: "0.001",
    });
    expect(opened[0]?.dedupeKey).toBe(`copy_bot_opened:${botId}:${id}`);
    // Không có địa chỉ ví hay số dư trong tin.
    expect(JSON.stringify(opened[0])).not.toContain(leader.slice(2, 10));
    await e.stop();
    await db.update(bots).set({ state: "stopped" }).where(eq(bots.id, botId));
  });

  it("writes one copy_bot_skipped per bot and market within 10 minutes, with the reason (DEC-212)", async () => {
    const { eq } = await import("drizzle-orm");
    const gw = new FakeGateway();
    const leader = "0x4444444444444444444444444444444444444444";
    const { botId } = await seedBot("running", copySpec(leader));
    await enableDesk(botId);
    const e = farmEngine(gw, "copy-skips");
    await e.tick();
    await e.onPrice("BTC-USD", "100000", clock);
    // Tín hiệu mở tới trễ 6 s (> 5 s): chiến lược ghi "Skipped".
    await e.onLeaderFill(leaderFill(leader, "1", clock), clock + 6_000);
    await e.onLeaderFill(leaderFill(leader, "0", clock + 7_000), clock + 7_100);
    await e.onLeaderFill(leaderFill(leader, "2", clock + 8_000), clock + 14_000);
    const skipped = await copyAlertRows(botId, "copy_bot_skipped");
    expect(skipped).toHaveLength(1);
    expect(skipped[0]?.data).toMatchObject({ botId, market: "BTC-USD", reason: "signal_late" });
    expect(gw.received.filter((o) => o.tag.startsWith("copy:"))).toEqual([]);
    await e.stop();
    await db.update(bots).set({ state: "stopped" }).where(eq(bots.id, botId));
  });

  it("never writes copy bot alerts for a paper copy bot (DEC-212)", async () => {
    const { eq } = await import("drizzle-orm");
    const gw = new FakeGateway();
    const leader = "0x5555555555555555555555555555555555555555";
    const { botId } = await seedBot("running", copySpec(leader));
    await enableDesk(botId);
    await db.update(bots).set({ mode: "paper" }).where(eq(bots.id, botId));
    await db.insert(paperAccounts).values({
      botId,
      capital: "1000",
      cash: "1000",
      positions: {},
      peakEquity: "1000",
      startedAt: new Date(clock),
    });
    const e = new Engine({
      db,
      redis: newRedis(),
      gateway: gw,
      paper: new PaperGateway({ db, now }),
      workerId: "copy-paper",
      log,
      now,
      leaseTtlMs: 30_000,
      shards: SHARDS,
      rules: () => Promise.resolve(rules),
      feeCheckMs: 0,
    });
    await e.tick();
    await e.onPrice("BTC-USD", "100000", clock);
    await e.onLeaderFill(leaderFill(leader, "1", clock), clock + 6_000);
    await e.onLeaderFill(leaderFill(leader, "0", clock + 7_000), clock + 7_100);
    await e.onLeaderFill(leaderFill(leader, "1", clock + 8_000), clock + 8_100);
    expect(await copyAlertRows(botId, "copy_bot_skipped")).toEqual([]);
    expect(await copyAlertRows(botId, "copy_bot_opened")).toEqual([]);
    expect(gw.received).toEqual([]);
    await e.stop();
    await db.update(bots).set({ state: "stopped" }).where(eq(bots.id, botId));
  });

  it("copies one trader across markets, honours the liquidity allowance, and closes every market on stop (DEC-163)", async () => {
    const { eq } = await import("drizzle-orm");
    const gw = new FakeGateway();
    const leader = "0x3333333333333333333333333333333333333333";
    const { botId } = await seedBot("running", {
      strategy: "copy_trade",
      market: "BTC-USD",
      engine: "perps",
      config: {
        leaderSource: "hyperliquid",
        leaderAddress: leader,
        markets: ["BTC-USD", "ETH-USD"],
        leverage: 2,
        fixedNotional: "100",
        maxNotionalPerTrade: "100",
        maxExposure: "1000",
        maxLoss: "150",
      },
    });
    const [b] = await db.select().from(bots).where(eq(bots.id, botId));
    await db
      .update(users)
      .set({ aiDesk: true })
      .where(eq(users.id, b?.userId ?? ""));
    const e = farmEngine(gw, "copy-multi");
    await e.tick();
    await e.onPrice("BTC-USD", "100000", clock);
    await e.onPrice("ETH-USD", "2000", clock);
    const fill = (market: string, price: string, allowances?: Record<string, string>) =>
      e.onLeaderFill(
        {
          source: "hyperliquid",
          address: leader,
          market,
          side: "buy",
          price,
          quantity: "1",
          positionAfter: "1",
          at: clock,
          ...(allowances === undefined
            ? {}
            : { allowances, allowanceReason: "liquidity" as const }),
        },
        clock + 200,
      );
    await fill("BTC-USD", "100000");
    // Hạn mức 60 USD: lệnh ETH cắt từ 100 xuống 60 (0,03 ETH).
    await fill("ETH-USD", "2000", { [botId]: "60" });
    const copies = gw.received.filter((o) => o.tag.startsWith("copy:"));
    expect(copies.map((o) => [o.market, o.quantity])).toEqual([
      ["BTC-USD", "0.001"],
      ["ETH-USD", "0.03"],
    ]);
    await e.stop();

    // Giả lập đã khớp cả hai lệnh rồi Stop có đóng vị thế: đóng từng market, reduce-only.
    const [rt] = await db.select().from(botRuntime).where(eq(botRuntime.botId, botId));
    const st = rt?.state as { markets: Record<string, { ledger: Record<string, string> }> };
    const withPos = (m: string, position: string, avgCost: string) => ({
      ...st.markets[m],
      ledger: { ...st.markets[m]?.ledger, position, avgCost },
    });
    await db
      .update(botRuntime)
      .set({
        state: {
          ...st,
          markets: {
            "BTC-USD": withPos("BTC-USD", "0.001", "100000"),
            "ETH-USD": withPos("ETH-USD", "-0.03", "2000"),
          },
        },
      })
      .where(eq(botRuntime.botId, botId));
    await db.update(bots).set({ state: "stopping", closeOnStop: true }).where(eq(bots.id, botId));
    // Cùng worker id: nhận lại shard ngay, không chờ worker cũ hết hạn trong bảng chia shard.
    const e2 = farmEngine(gw, "copy-multi");
    for (let i = 0; i < 10 && (await botState(botId))?.state !== "stopped"; i += 1) {
      await e2.tick();
      if ((await botState(botId))?.state !== "stopped")
        await new Promise((r) => setTimeout(r, 100));
    }
    // Mã lệnh đóng băm từ botId đầy đủ (DEC-186), theo thứ tự market trong config.
    const mine = new Set([0, 1].map((i) => clOrdId(botId, 1, `close:${String(i)}`)));
    const closes = gw.received.filter((o) => o.tag === "close" && mine.has(o.clOrdID));
    expect(closes.map((o) => [o.market, o.side, o.quantity, o.reduceOnly])).toEqual([
      ["BTC-USD", "sell", "0.001", true],
      ["ETH-USD", "buy", "0.03", true],
    ]);
    await e2.stop();
    await db.update(bots).set({ state: "stopped" }).where(eq(bots.id, botId));
  });

  it("retries a cancel that never left DRIFT, so a stale quote can't block the bot (DEC-111)", async () => {
    const { eq } = await import("drizzle-orm");
    const gw = new FakeGateway();
    await seedMaker();
    const e = farmEngine(gw, "vm-retry");
    await e.tick();
    await e.onPrice("BTC-USD", "100000", clock);
    const bid = gw.received.find((o) => o.tag.endsWith(":bid"))?.clOrdID ?? "";
    const status = async () =>
      (await db.select().from(orders).where(eq(orders.clOrdId, bid)))[0]?.status;
    // Lúc làm mới báo giá, signer lỗi: lệnh huỷ không gửi được, lệnh cũ vẫn "open".
    gw.cancelNotSent = 1;
    clock += 4_000;
    await e.tick();
    expect(await status()).toBe("open");
    expect(gw.cancelled).not.toContain(bid);
    // Signer hồi: engine tự huỷ lại, không cần chiến lược nhớ tới lệnh đó.
    clock += 6_000;
    await e.tick();
    expect(gw.cancelled).toContain(bid);
    expect(await status()).toBe("cancelled");
    await e.stop();
    await stopMakerBots();
  });

  it("closes an order the user stream reports rejected or cancelled before anything filled (DEC-122)", async () => {
    const { eq } = await import("drizzle-orm");
    const gw = new FakeGateway();
    const { accountId } = await seedMaker();
    const e = farmEngine(gw, "vm-ws-closed");
    await e.tick();
    await e.onPrice("BTC-USD", "100000", clock);
    const bid = gw.received.find((o) => o.tag.endsWith(":bid"))?.clOrdID ?? "";
    const ask = gw.received.find((o) => o.tag.endsWith(":ask"))?.clOrdID ?? "";
    const row = async (id: string) =>
      (await db.select().from(orders).where(eq(orders.clOrdId, id)))[0];
    expect((await row(bid))?.status).toBe("open");
    // Post-only bị bộ khớp lệnh từ chối sau khi SoDEX đã nhận request.
    await e.onOrderClosed(accountId, bid, "rejected", clock, "post only");
    expect(await row(bid)).toMatchObject({ status: "rejected", rejectCode: "post only" });
    await e.onOrderClosed(accountId, ask, "cancelled", clock);
    expect((await row(ask))?.status).toBe("cancelled");
    // Đã chốt rồi thì tin đến sau không đổi gì.
    await e.onOrderClosed(accountId, bid, "cancelled", clock);
    expect((await row(bid))?.status).toBe("rejected");
    await e.stop();
    await stopMakerBots();
  });

  it("reads the real status of an order whose cancel keeps coming back unknown, instead of leaving it open (DEC-121)", async () => {
    const { eq } = await import("drizzle-orm");
    const gw = new FakeGateway();
    gw.cancelOutcome = "unknown";
    const { botId } = await seedMaker();
    const e = farmEngine(gw, "vm-unknown-cancel");
    await e.tick();
    await e.onPrice("BTC-USD", "100000", clock);
    const bid = gw.received.find((o) => o.tag.endsWith(":bid"))?.clOrdID ?? "";
    const status = async () =>
      (await db.select().from(orders).where(eq(orders.clOrdId, bid)))[0]?.status;
    clock += 4_000;
    await e.tick();
    expect(gw.cancelled).toContain(bid);
    expect(await status()).toBe("open");
    // SoDEX thật ra đã huỷ lệnh: engine đọc lại trạng thái thay vì huỷ lại mãi.
    const live = gw.book.get(bid);
    if (live !== undefined && live.status !== "not_found")
      gw.book.set(bid, { ...live, status: "cancelled" });
    clock += 20_000;
    await e.tick();
    expect(await status()).toBe("cancelled");
    const tries = gw.cancelled.filter((x) => x === bid).length;
    clock += 20_000;
    await e.tick();
    expect(gw.cancelled.filter((x) => x === bid)).toHaveLength(tries);
    // Huỷ đúng như bot yêu cầu: không thêm dòng "Order cancelled" vào Decisions.
    const events = await db.select().from(botEvents).where(eq(botEvents.botId, botId));
    expect(events.some((x) => x.why?.startsWith(`${bid}:`) === true)).toBe(false);
    await e.stop();
    await stopMakerBots();
  });

  it("cancels a Market Making order the strategy no longer tracks (DEC-111)", async () => {
    const { eq } = await import("drizzle-orm");
    const gw = new FakeGateway();
    const { botId, accountId } = await seedMaker();
    const e = farmEngine(gw, "vm-orphan");
    await e.tick();
    await e.onPrice("BTC-USD", "100000", clock);
    // Một lệnh còn "open" trong DRIFT mà state của bot không theo dõi (như sau một lần huỷ thất bại).
    await db.insert(orders).values({
      botId,
      sodexAccountId: accountId,
      clOrdId: "orphan-vm-1",
      market: "BTC-USD",
      engine: "perps",
      side: "sell",
      type: "limit",
      timeInForce: "GTX",
      price: "99000",
      size: "0.001",
      status: "open",
      tag: "vm:1:rc",
      epoch: 1,
      submittedAt: new Date(clock - 60_000),
    });
    clock += 11_000;
    await e.tick();
    expect(gw.cancelled).toContain("orphan-vm-1");
    const [row] = await db.select().from(orders).where(eq(orders.clOrdId, "orphan-vm-1"));
    expect(row?.status).toBe("cancelled");
    await e.stop();
    await stopMakerBots();
  });
});
