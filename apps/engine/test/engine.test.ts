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
  seededRandom,
  spotGrid,
  spotGridSchema,
  type OrderIntent,
} from "@drift/strategies";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Redis } from "ioredis";
import { GenericContainer, type StartedTestContainer } from "testcontainers";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { Engine as RealEngine, FencedError, shardOf, type EngineDeps } from "../src/engine";
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
  /** Giữ lần đặt đòn bẩy kế tiếp tới khi promise này xong (đang đặt). */
  holdLeverage: Promise<void> | null = null;
  /** Thiết lập trên "SoDEX" theo market (đọc lại bằng readLeverage). */
  readonly settings = new Map<string, LeverageSetting>();
  /** Signer lỗi: mọi submit trả not_sent với mã này. */
  notSent: NotSentCode | null = null;
  /** SoDEX từ chối mọi lệnh với mã + câu lỗi này. */
  reject: { code: string; message: string | null } | null = null;
  /** Giữ lần submit kế tiếp tới khi promise này xong (lệnh "đang gửi"). */
  hold: Promise<void> | null = null;
  /** Giữ lần huỷ kế tiếp tới khi promise này xong; `cancelHeld` = đang bị giữ. */
  holdCancel: Promise<void> | null = null;
  cancelHeld = false;
  #id = 1n;

  setLeverage(
    _a: AccountRef,
    input: { market: string; leverage: number; marginMode: "cross" | "isolated" },
  ): Promise<LeverageResult> {
    this.leverage.push({ ...input, before: this.received.length });
    const outcome = this.leverageOutcome;
    const apply = () => {
      if (outcome.outcome === "ok")
        this.settings.set(input.market, { leverage: input.leverage, marginMode: input.marginMode });
      return outcome;
    };
    const held = this.holdLeverage;
    if (held === null) return Promise.resolve(apply());
    this.holdLeverage = null;
    return held.then(apply);
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
    const held = this.hold;
    if (held !== null) {
      this.hold = null;
      return held.then(() => this.submit(_a, list, fence, builderFeeRate));
    }
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
    const held = this.holdCancel;
    if (held !== null) {
      this.holdCancel = null;
      this.cancelHeld = true;
      return held.then(() => {
        this.cancelHeld = false;
        return this.cancel(_a, list);
      });
    }
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
  /** Giả SoDEX / mạng lỗi khi tra lệnh (HttpGateway.lookup ném lỗi). */
  lookupError: Error | null = null;
  lookup(_a: AccountRef, o: { clOrdID: string }): Promise<LookupResult> {
    if (this.lookupError !== null) return Promise.reject(this.lookupError);
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

// Lease được gia hạn bằng timer riêng (DEC-TBD-engine-lease-renew): engine của test trước mà quên `stop()` sẽ tiếp tục
// giữ shard qua test sau. Cuối mỗi test dừng timer của mọi engine (như worker chết).
const engines: RealEngine[] = [];
class Engine extends RealEngine {
  constructor(deps: EngineDeps) {
    super(deps);
    engines.push(this);
  }
}
afterEach(() => {
  for (const e of engines.splice(0)) e.kill();
});

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

  it("logs Paused and Running when the user pauses and resumes, so Runtime ends at the pause (BD-06)", async () => {
    const { eq } = await import("drizzle-orm");
    const gw = new FakeGateway();
    const { botId } = await seedBot("running");
    const e = makeEngine(gw, "w-pause-runtime");
    await e.tick();
    await e.onPrice("vBTC_vUSDC", "100", clock);
    const step = async (state: "pausing" | "resuming" | "stopping", until: string) => {
      await db.update(bots).set({ state }).where(eq(bots.id, botId));
      for (let i = 0; i < 4 && (await botState(botId))?.state !== until; i += 1) {
        clock += 1_000;
        await e.tick();
      }
      expect((await botState(botId))?.state).toBe(until);
    };
    await step("pausing", "paused");
    const pausedAt = clock;
    clock += 3 * 86_400_000;
    await step("resuming", "running");
    const resumedAt = clock;
    clock += 3_600_000;
    await e.onPrice("vBTC_vUSDC", "100", clock);
    await step("stopping", "stopped");
    const states = (await db.select().from(botEvents).where(eq(botEvents.botId, botId)))
      .filter((x) => x.type === "state")
      .sort((x, y) => x.occurredAt.getTime() - y.occurredAt.getTime())
      .map((x) => [x.decision, x.occurredAt.getTime()] as const);
    // Mỗi lần đổi trạng thái đúng một event, đúng lúc engine xác nhận.
    expect(states.map(([d]) => d)).toEqual(["Paused", "Running", "Stopped"]);
    expect(states[0]?.[1]).toBe(pausedAt);
    expect(states[1]?.[1]).toBe(resumedAt);
    await e.stop();
  });

  it("clears Needs attention when a planned stop finishes through stopping (MM-01)", async () => {
    const { eq } = await import("drizzle-orm");
    const gw = new FakeGateway();
    const { botId } = await seedBot("running");
    const e = makeEngine(gw, "w-planned");
    await e.tick();
    await e.onPrice("vBTC_vUSDC", "100", clock);
    // Như chiến lược dừng vì hết budget khi còn lệnh unknown: bot ở stopping, reason_code BUDGET_DONE, cờ còn bật từ
    // cảnh báo 80% budget.
    await db
      .update(bots)
      .set({ state: "stopping", reasonCode: ReasonCode.budgetDone, needsAttention: true })
      .where(eq(bots.id, botId));
    for (let i = 0; i < 3 && (await botState(botId))?.state !== "stopped"; i += 1) {
      clock += 1_000;
      await e.tick();
    }
    const b = await botState(botId);
    expect(b?.state).toBe("stopped");
    expect(b?.needsAttention).toBe(false);
    await e.stop();
  });

  it("logs a Stopped event saying who stopped the bot (BD-06)", async () => {
    const { eq } = await import("drizzle-orm");
    const gw = new FakeGateway();
    const { botId } = await seedBot("running");
    const e = makeEngine(gw, "w-stopped");
    await e.tick();
    await e.onPrice("vBTC_vUSDC", "100", clock);
    await db.update(bots).set({ state: "stopping" }).where(eq(bots.id, botId));
    for (let i = 0; i < 3 && (await botState(botId))?.state !== "stopped"; i += 1) {
      clock += 1_000;
      await e.tick();
    }
    expect((await botState(botId))?.state).toBe("stopped");
    const stopped = (await db.select().from(botEvents).where(eq(botEvents.botId, botId))).filter(
      (x) => x.type === "state" && x.decision === "Stopped",
    );
    expect(stopped.map((x) => x.why)).toEqual(["STOPPED_BY_USER"]);
    // Đúng một lần: các nhịp sau không ghi thêm.
    for (let i = 0; i < 3; i += 1) {
      clock += 1_000;
      await e.tick();
    }
    const again = (await db.select().from(botEvents).where(eq(botEvents.botId, botId))).filter(
      (x) => x.type === "state" && x.decision === "Stopped",
    );
    expect(again).toHaveLength(1);
    await e.stop();
  });

  it("writes the strategy's reason in the Stopped event when the strategy stops the bot (BD-06)", async () => {
    const { eq } = await import("drizzle-orm");
    const gw = new FakeGateway();
    const { botId } = await seedBot("running", {
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
        stopPrice: "85",
        onStop: "keep_base",
      },
    });
    const e = makeEngine(gw, "w-stopped-reason");
    await e.tick();
    await e.onPrice("vBTC_vUSDC", "100", clock);
    clock += 1_000;
    await e.onPrice("vBTC_vUSDC", "80", clock);
    expect((await botState(botId))?.state).toBe("stopped");
    const stopped = (await db.select().from(botEvents).where(eq(botEvents.botId, botId))).filter(
      (x) => x.type === "state" && x.decision === "Stopped",
    );
    expect(stopped.map((x) => x.why)).toEqual([ReasonCode.stopLoss]);
    await e.stop();
  });

  it("writes EMERGENCY_HALT, not STOPPED_BY_USER, after an emergency halt (BD-06)", async () => {
    const { eq } = await import("drizzle-orm");
    const gw = new FakeGateway();
    const { botId } = await seedBot("running");
    const e = makeEngine(gw, "w-stopped-halt");
    await e.tick();
    await e.onPrice("vBTC_vUSDC", "100", clock);
    // Như API emergency halt: stopping kèm reason code trong cùng lần ghi.
    await db
      .update(bots)
      .set({ state: "stopping", reasonCode: ReasonCode.emergencyHalt })
      .where(eq(bots.id, botId));
    for (let i = 0; i < 3 && (await botState(botId))?.state !== "stopped"; i += 1) {
      clock += 1_000;
      await e.tick();
    }
    expect((await botState(botId))?.state).toBe("stopped");
    const stopped = (await db.select().from(botEvents).where(eq(botEvents.botId, botId))).filter(
      (x) => x.type === "state" && x.decision === "Stopped",
    );
    expect(stopped.map((x) => x.why)).toEqual([ReasonCode.emergencyHalt]);
    await e.stop();
  });

  it("sets leverage once and logs one line when events arrive together (CP-01)", async () => {
    const { eq } = await import("drizzle-orm");
    const gw = new FakeGateway();
    const { botId } = await seedBot("running", {
      strategy: "volume_maker",
      market: "BTC-USD",
      engine: "perps",
      config: {
        market: "BTC-USD",
        leverage: 1,
        orderSize: "500",
        distanceBp: "1",
        maxOrders: 1,
        refreshSeconds: 3,
        runUntil: "target_or_budget",
        costBudget: "100000",
        onStop: "close_inventory",
      },
    });
    const e = makeEngine(gw, "w-lev");
    await e.tick();
    await Promise.all(
      [0, 1, 2, 3, 4].map((i) => e.onPrice("BTC-USD", String(100_000 + i), clock + i)),
    );
    expect(gw.leverage.filter((l) => l.market === "BTC-USD")).toHaveLength(1);
    const logged = (await db.select().from(botEvents).where(eq(botEvents.botId, botId))).filter(
      (x) => x.decision === "Leverage set",
    );
    expect(logged).toHaveLength(1);
    expect(logged[0]?.why).toMatch(/^SoDEX confirmed 1× (cross|isolated) on BTC-USD.$/);
    await e.stop();
  });

  it("links a decision to the orders it placed, for the Result column (BD-02)", async () => {
    const { eq } = await import("drizzle-orm");
    const gw = new FakeGateway();
    const { botId, accountId } = await seedBot("running");
    const e = makeEngine(gw, "w-result");
    await e.tick();
    await e.onPrice("vBTC_vUSDC", "100", clock);
    // Lệnh market mở vị thế ban đầu khớp trước: grid chạy hẳn rồi mới đặt lệnh đối ứng sau mỗi fill.
    const init = gw.received.find((o) => o.tag === "grid:init");
    expect(init).toBeDefined();
    await e.onFill(accountId, init?.clOrdID ?? "", init?.quantity ?? "0", "100", "0", clock);
    // Lệnh mua mức 95 (grid:1): lệnh bán đối ứng ở 100 không đụng lệnh nào của chính bot. Mua ở 90 thì lệnh bán 95
    // sẽ đụng lệnh mua 95 của bot (SELF_TRADE_BLOCKED) và không có lệnh nào được đặt.
    const buy = gw.received.find((o) => o.tag === "grid:1:buy");
    expect(buy).toBeDefined();
    const before = gw.received.length;
    await e.onFill(
      accountId,
      buy?.clOrdID ?? "",
      buy?.quantity ?? "0",
      buy?.price ?? "0",
      "0",
      clock + 1,
    );
    const placed = gw.received.slice(before).map((o) => o.clOrdID);
    expect(placed.length).toBeGreaterThan(0);
    const bought = (await db.select().from(botEvents).where(eq(botEvents.botId, botId))).find(
      (x) => x.type === "decision" && (x.decision ?? "").startsWith("Bought at level"),
    );
    expect(bought?.payload).toEqual({ orders: placed });
    await e.stop();
  });

  it("sets the new version's leverage when the version changes while leverage is being set (#159)", async () => {
    const gw = new FakeGateway();
    const vm = (leverage: number) => ({
      market: "BTC-USD",
      leverage,
      orderSize: "500",
      distanceBp: "1",
      maxOrders: 1,
      refreshSeconds: 3,
      runUntil: "target_or_budget",
      costBudget: "100000",
      onStop: "close_inventory",
    });
    const { botId } = await seedBot("running", {
      strategy: "volume_maker",
      market: "BTC-USD",
      engine: "perps",
      config: vm(1),
    });
    const { eq } = await import("drizzle-orm");
    const e = makeEngine(gw, "w-lev-race");
    try {
      await e.tick();
      let release: () => void = () => undefined;
      gw.holdLeverage = new Promise<void>((res) => {
        release = res;
      });
      // Đang đặt 1× (SoDEX chưa trả lời) thì người dùng lưu version mới 2×.
      const first = e.onPrice("BTC-USD", "100000", clock);
      await db.insert(botVersions).values({
        botId,
        version: 2,
        paramSource: "manual",
        status: "pending",
        config: vm(2),
      });
      release();
      await first;
      // Áp version ở nhịp sau (không chạy tick chồng lên lần ghi có fence đang dở).
      await e.tick();
      clock += 1_000;
      await e.onPrice("BTC-USD", "100001", clock);
      // 1× đã xác nhận của version cũ không được tính là xong cho version mới: 2× được đặt, SoDEX ở 2×.
      expect(gw.leverage.map((l) => l.leverage)).toEqual([1, 2]);
      expect(gw.settings.get("BTC-USD")?.leverage).toBe(2);
    } finally {
      await e.stop();
      // Bot nằm lại trong DB dùng chung: dừng hẳn để engine của test sau không chạy bot BTC-USD này.
      await db.update(bots).set({ state: "stopped" }).where(eq(bots.id, botId));
    }
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

  it("keeps the tick going when looking up one unknown order fails, and reconciles it later (#154 follow-up)", async () => {
    const gw = new FakeGateway();
    gw.timeoutNext = "applied";
    const { botId } = await seedBot();
    const e = makeEngine(gw, "w1");
    await e.tick();
    await e.onPrice("vBTC_vUSDC", "100", clock);
    gw.lookupError = new Error("network down");
    clock += 6_000;
    // Tra lệnh lỗi: nhịp không ném lỗi, lệnh vẫn unknown.
    await expect(e.tick()).resolves.toBeUndefined();
    const still = (await db.select().from(orders)).find(
      (o) => o.botId === botId && o.status === "unknown",
    );
    expect(still).toBeDefined();
    gw.lookupError = null;
    clock += 1_000;
    await e.tick();
    const after = (await db.select().from(orders)).find((o) => o.id === still?.id);
    expect(after?.status).toBe("open");
    await e.stop();
  });

  it("stops a bot whose unknown order was never placed: not_found → not_placed → stopped (#154 follow-up)", async () => {
    const { eq } = await import("drizzle-orm");
    const gw = new FakeGateway();
    gw.timeoutNext = "lost";
    const { botId } = await seedBot();
    const e = makeEngine(gw, "w1");
    await e.tick();
    await e.onPrice("vBTC_vUSDC", "100", clock);
    const lost = (await db.select().from(orders)).find(
      (o) => o.botId === botId && o.status === "unknown",
    );
    expect(lost).toBeDefined();
    await db.update(bots).set({ state: "stopping" }).where(eq(bots.id, botId));
    await e.tick();
    expect((await botState(botId))?.state).toBe("stopping");
    for (let i = 0; i < 4 && (await botState(botId))?.state !== "stopped"; i += 1) {
      clock += 31_000;
      await e.tick();
    }
    expect((await botState(botId))?.state).toBe("stopped");
    expect((await db.select().from(orders)).find((o) => o.id === lost?.id)?.status).toBe(
      "not_placed",
    );
    await e.stop();
  });

  it("waits for reconciling before closing the position on Stop, and survives a restart while stopping (#154 follow-up)", async () => {
    const { eq } = await import("drizzle-orm");
    const gw = new FakeGateway();
    gw.timeoutNext = "applied";
    const { botId, accountId } = await seedBot();
    const a = makeEngine(gw, "w-restart");
    await a.tick();
    await a.onPrice("vBTC_vUSDC", "100", clock);
    const unknown = (await db.select().from(orders)).find(
      (o) => o.botId === botId && o.status === "unknown",
    );
    expect(unknown).toBeDefined();
    await db.update(bots).set({ state: "stopping", closeOnStop: true }).where(eq(bots.id, botId));
    await a.tick();
    expect((await botState(botId))?.state).toBe("stopping");
    // Chưa đối soát: chưa có lệnh đóng vị thế.
    expect(
      (await db.select().from(orders)).filter((o) => o.botId === botId && o.tag === "close"),
    ).toEqual([]);
    // Engine khởi động lại giữa lúc stopping (cùng workerId, sở hữu shard của bot).
    await a.stop();
    const b = makeEngine(gw, "w-restart");
    await b.tick();
    expect(b.ownedShards).toContain(shardOf(accountId, SHARDS));
    for (let i = 0; i < 4 && (await botState(botId))?.state !== "stopped"; i += 1) {
      clock += 6_000;
      await b.tick();
    }
    expect((await botState(botId))?.state).toBe("stopped");
    expect(gw.cancelled).toContain(unknown?.clOrdId);
    await b.stop();
  });

  it("keeps a stopping bot in stopping until its unknown order is reconciled, then cancels it (rule 1.7)", async () => {
    const { eq } = await import("drizzle-orm");
    const gw = new FakeGateway();
    gw.timeoutNext = "applied";
    const { botId } = await seedBot();
    const e = makeEngine(gw, "w1");
    await e.tick();
    await e.onPrice("vBTC_vUSDC", "100", clock);
    const unknown = (await db.select().from(orders)).find(
      (o) => o.botId === botId && o.status === "unknown",
    );
    expect(unknown).toBeDefined();
    // Người dùng bấm Stop khi lệnh còn unknown (SoDEX thật ra đã nhận lệnh).
    await db.update(bots).set({ state: "stopping" }).where(eq(bots.id, botId));
    await e.tick();
    expect((await botState(botId))?.state).toBe("stopping");
    // Đối soát thấy lệnh đang mở → lượt Stop sau huỷ rồi mới dừng.
    for (let i = 0; i < 3 && (await botState(botId))?.state !== "stopped"; i += 1) {
      clock += 6_000;
      await e.tick();
    }
    expect((await botState(botId))?.state).toBe("stopped");
    expect(gw.cancelled).toContain(unknown?.clOrdId);
    await e.stop();
  });

  it("keeps the user's Close position when the strategy stops during the user's Stop (keep_base)", async () => {
    const { eq } = await import("drizzle-orm");
    const gw = new FakeGateway();
    const { botId, accountId } = await seedBot("running", {
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
        stopPrice: "85",
        onStop: "keep_base",
      },
    });
    const e = makeEngine(gw, "w1");
    await e.tick();
    await e.onPrice("vBTC_vUSDC", "100", clock);
    const init = gw.received.find((o) => o.tag === "grid:init");
    const buy = gw.received.find((o) => o.side === "buy" && o.type === "limit");
    expect(init).toBeDefined();
    expect(buy).toBeDefined();
    await e.onFill(accountId, init?.clOrdID ?? "", init?.quantity ?? "0", "100", "0", clock + 1);
    // Người dùng bấm Stop kèm Close position (engine chưa tới nhịp xử lý).
    await db.update(bots).set({ state: "stopping", closeOnStop: true }).where(eq(bots.id, botId));
    // Lệnh mua khớp ở 84, dưới Stop price 85: chiến lược dừng (STOP_LOSS) với keep_base.
    await e.onFill(accountId, buy?.clOrdID ?? "", buy?.quantity ?? "0", "84", "0", clock + 2);
    const b = await botState(botId);
    expect(b?.state).toBe("stopped");
    expect(b?.reasonCode).toBe(ReasonCode.stopLoss);
    const close = gw.received.filter((o) => o.tag === "close");
    expect(close).toHaveLength(1);
    expect(close[0]?.side).toBe("sell");
    expect(close[0]?.quantity).toBe(
      String(Number(init?.quantity ?? "0") + Number(buy?.quantity ?? "0")),
    );
    await e.stop();
  });

  it("does not reuse an old Close position choice when the bot was started again", async () => {
    const { eq } = await import("drizzle-orm");
    const gw = new FakeGateway();
    const { botId, accountId } = await seedBot("running", {
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
        stopPrice: "85",
        onStop: "keep_base",
      },
    });
    // closeOnStop còn từ lần Stop trước (Start không reset): bot đang running thì không phải lựa chọn hiện tại.
    await db.update(bots).set({ closeOnStop: true }).where(eq(bots.id, botId));
    const e = makeEngine(gw, "w1");
    await e.tick();
    await e.onPrice("vBTC_vUSDC", "100", clock);
    const init = gw.received.find((o) => o.tag === "grid:init");
    await e.onFill(accountId, init?.clOrdID ?? "", init?.quantity ?? "0", "100", "0", clock + 1);
    clock += 1_000;
    await e.onPrice("vBTC_vUSDC", "84", clock);
    expect((await botState(botId))?.state).toBe("stopped");
    expect(gw.received.filter((o) => o.tag === "close")).toEqual([]);
    await e.stop();
  });

  it("keeps the user's Close position when their Stop commits while the strategy stop is cancelling on SoDEX", async () => {
    const { eq } = await import("drizzle-orm");
    const gw = new FakeGateway();
    const { botId, accountId } = await seedBot("running", {
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
        stopPrice: "85",
        onStop: "keep_base",
      },
    });
    const e = makeEngine(gw, "w1");
    await e.tick();
    await e.onPrice("vBTC_vUSDC", "100", clock);
    const init = gw.received.find((o) => o.tag === "grid:init");
    await e.onFill(accountId, init?.clOrdID ?? "", init?.quantity ?? "0", "100", "0", clock + 1);
    // Lệnh huỷ của chiến lược trả unknown: lệnh còn `open`, nên Stop của chiến lược huỷ lại lần hai. Giữ lần huỷ thứ hai
    // (sau khi Stop đã đọc closeOnStop) để Stop của người dùng commit đúng lúc đó.
    gw.cancelOutcome = "unknown";
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const cancel = gw.cancel.bind(gw);
    let calls = 0;
    gw.cancel = (a, list) => {
      calls += 1;
      if (calls === 2) gw.holdCancel = held;
      return cancel(a, list);
    };
    clock += 1_000;
    const halting = e.onPrice("vBTC_vUSDC", "84", clock);
    for (let i = 0; i < 100 && !gw.cancelHeld; i += 1) await new Promise((r) => setTimeout(r, 10));
    expect(gw.cancelHeld).toBe(true);
    // Người dùng bấm Stop kèm Close position (API: running → stopping, closeOnStop = true).
    await db.update(bots).set({ state: "stopping", closeOnStop: true }).where(eq(bots.id, botId));
    release();
    await halting;
    gw.cancelOutcome = "ok";
    for (let i = 0; i < 4 && (await botState(botId))?.state !== "stopped"; i += 1) {
      clock += 6_000;
      await e.tick();
    }
    const b = await botState(botId);
    expect(b?.state).toBe("stopped");
    expect(b?.reasonCode).toBe(ReasonCode.stopLoss);
    const close = gw.received.filter((o) => o.tag === "close");
    expect(close).toHaveLength(1);
    expect(close[0]?.side).toBe("sell");
    expect(close[0]?.quantity).toBe(init?.quantity);
    await e.stop();
  });

  it("keeps a strategy stop waiting until its unknown order is reconciled, and keeps its reason (rule 1.7)", async () => {
    const gw = new FakeGateway();
    gw.timeoutNext = "applied";
    const { botId } = await seedBot("running", {
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
        stopPrice: "85",
        onStop: "keep_base",
      },
    });
    const e = makeEngine(gw, "w1");
    await e.tick();
    await e.onPrice("vBTC_vUSDC", "100", clock);
    const unknown = (await db.select().from(orders)).find(
      (o) => o.botId === botId && o.status === "unknown",
    );
    expect(unknown).toBeDefined();
    // Giá xuống dưới Stop price: chiến lược dừng, nhưng còn lệnh unknown (SoDEX thật ra đã nhận).
    clock += 1_000;
    await e.onPrice("vBTC_vUSDC", "80", clock);
    // Ghi xuống DB: bot ở `stopping` kèm lý do (bền qua restart / đổi shard, quy tắc 1.6).
    expect((await botState(botId))?.state).toBe("stopping");
    expect((await botState(botId))?.reasonCode).not.toBeNull();
    for (let i = 0; i < 4 && (await botState(botId))?.state !== "stopped"; i += 1) {
      clock += 6_000;
      await e.tick();
    }
    const b = await botState(botId);
    expect(b?.state).toBe("stopped");
    expect(b?.reasonCode).not.toBeNull();
    expect(gw.cancelled).toContain(unknown?.clOrdId);
    // Tin trạng thái cuối cho UI mang lý do của lần dừng (không phải null).
    const last = (await db.select().from(outbox))
      .filter((x) => x.topic.endsWith(".bot"))
      .map((x) => x.payload as { botId: string; state: string; reasonCode: string | null })
      .filter((x) => x.botId === botId && x.state === "stopped");
    expect(last.at(-1)?.reasonCode).toBe(b?.reasonCode);
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

  it("rebuilds a grid paused by a rejected order from the latest price on Resume, keeping its ledger (DEC-240)", async () => {
    const { eq } = await import("drizzle-orm");
    const gw = new FakeGateway();
    gw.reject = { code: "-1", message: "insufficient balance" };
    const { botId } = await seedBot("running");
    const e = makeEngine(gw, "w1");
    await e.tick();
    await e.onPrice("vBTC_vUSDC", "100", clock);
    clock += 1;
    await e.tick();
    expect((await botState(botId))?.state).toBe("paused");
    expect((await botState(botId))?.reasonCode).toBe(ReasonCode.orderRejected);
    gw.reject = null;
    const before = gw.received.length;
    // Lúc pause engine không đưa giá cho chiến lược, chỉ nhớ giá mới nhất.
    await e.onPrice("vBTC_vUSDC", "102", clock);
    expect(gw.received).toHaveLength(before);
    await db.update(bots).set({ state: "resuming", reasonCode: null }).where(eq(bots.id, botId));
    clock += 1;
    await e.tick();
    expect((await botState(botId))?.state).toBe("running");
    // Mọi lệnh trước đều bị từ chối nên vị thế 0: chỉ đặt lệnh mua ở các mức dưới giá 102, không bán.
    const placed = gw.received.slice(before);
    expect(placed.map((o) => `${o.side}@${o.price ?? ""}`).sort()).toEqual(
      ["buy@100", "buy@95", "buy@90"].sort(),
    );
    const ids = gw.received.map((o) => o.clOrdID);
    expect(new Set(ids).size).toBe(ids.length);
    // Resume lần nữa khi đang chạy (không halted) không đặt thêm gì.
    await e.tick();
    expect(gw.received).toHaveLength(before + 3);
    await e.stop();
  });

  const mmSmart = (smartQuoting: boolean) => ({
    strategy: "volume_maker",
    market: "BTC-USD",
    engine: "perps" as const,
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
      smartQuoting,
    },
  });

  for (const smartQuoting of [true, false])
    it(`${smartQuoting ? "pulls" : "leaves"} a Market Making ask the Binance price moved through when Smart quoting is ${smartQuoting ? "on" : "off"}`, async () => {
      const { eq } = await import("drizzle-orm");
      const gw = new FakeGateway();
      const { botId } = await seedBot("running", mmSmart(smartQuoting));
      const e = makeEngine(gw, `w-fair-${String(smartQuoting)}`);
      await e.tick();
      await e.onPrice("BTC-USD", "100000", clock);
      const askOrder = gw.received.filter((o) => o.side === "sell").at(-1);
      expect(askOrder).toBeDefined();
      const before = gw.cancelled.length;
      // Giá Binance quy đổi vượt qua ask: rút ngay (không chờ chu kỳ báo giá), không đụng bid.
      await e.onMmFair(
        { s: "BTC-USD", fair: String(Number(askOrder?.price) + 5), T: clock - 150, at: clock - 20 },
        clock,
      );
      expect(gw.cancelled.slice(before)).toEqual(smartQuoting ? [askOrder?.clOrdID] : []);
      const decisions = (await db.select().from(botEvents).where(eq(botEvents.botId, botId))).map(
        (x) => `${x.decision ?? ""} | ${x.why ?? ""}`,
      );
      if (smartQuoting) {
        expect(decisions.some((d) => d.startsWith("Ask pulled | At "))).toBe(true);
        expect(decisions).toContain(
          `Ask cancelled | SoDEX confirmed the cancel at ${new Date(clock).toISOString().slice(11, 23)} UTC, 150 ms after the move on Binance.`,
        );
      } else expect(decisions.some((d) => d.startsWith("Ask pulled"))).toBe(false);
      await e.stop();
    });

  it("logs Paused only when the pause changes the bot's state (DEC-256)", async () => {
    const { eq } = await import("drizzle-orm");
    const paused = async (botId: string) =>
      (await db.select().from(botEvents).where(eq(botEvents.botId, botId))).filter(
        (x) => x.decision === "Paused",
      ).length;
    const gw = new FakeGateway();
    const running = await seedBot("running");
    const stopping = await seedBot("running");
    const e = makeEngine(gw, "w-paused-log");
    // Chờ engine nạp cả hai bot (nhận shard có thể mất vài nhịp).
    const loaded = async () => {
      const ids = (await e.activeAccounts()).map((a) => a.id);
      return ids.includes(running.accountId) && ids.includes(stopping.accountId);
    };
    for (let i = 0; i < 20 && !(await loaded()); i += 1) await e.tick();
    expect(await loaded()).toBe(true);
    // Bot đang Stop: pause không đổi gì (applyReason trả null), nên không có dòng "Paused" trong Decisions.
    await db.update(bots).set({ state: "stopping" }).where(eq(bots.id, stopping.botId));
    await e.pauseAccount(stopping.accountId, ReasonCode.builderFeeRevoked);
    expect((await botState(stopping.botId))?.state).toBe("stopping");
    expect(await paused(stopping.botId)).toBe(0);
    // Bot đang chạy: pause thật, có đúng một dòng "Paused"; pause lần nữa (đã paused) không thêm dòng.
    await e.pauseAccount(running.accountId, ReasonCode.builderFeeRevoked);
    expect((await botState(running.botId))?.state).toBe("paused");
    expect(await paused(running.botId)).toBe(1);
    await e.pauseAccount(running.accountId, ReasonCode.builderFeeRevoked);
    expect(await paused(running.botId)).toBe(1);
    await e.stop();
  });

  it("cancels a quote pulled while it was still being sent, as soon as SoDEX takes it (DEC-254)", async () => {
    const { and, eq } = await import("drizzle-orm");
    const gw = new FakeGateway();
    const { botId } = await seedBot("running", mmSmart(true));
    const e = makeEngine(gw, "w-inflight");
    await e.tick();
    let release: () => void = () => undefined;
    gw.hold = new Promise<void>((r) => {
      release = r;
    });
    const placing = e.onPrice("BTC-USD", "100000", clock);
    // Lệnh đã ghi (unknown) và đang chờ SoDEX trả lời.
    let ask: { clOrdId: string; price: string | null } | undefined;
    for (let i = 0; i < 50 && ask === undefined; i += 1) {
      [ask] = await db
        .select({ clOrdId: orders.clOrdId, price: orders.price })
        .from(orders)
        .where(and(eq(orders.botId, botId), eq(orders.side, "sell"), eq(orders.status, "unknown")));
      if (ask === undefined) await new Promise((r) => setTimeout(r, 20));
    }
    expect(ask).toBeDefined();
    // Binance chạy xuyên ask khi lệnh còn đang gửi: lệnh huỷ không bị bỏ.
    await e.onMmFair(
      { s: "BTC-USD", fair: String(Number(ask?.price) + 5), T: clock - 100, at: clock - 20 },
      clock,
    );
    expect(gw.cancelled).not.toContain(ask?.clOrdId);
    release();
    await placing;
    expect(gw.cancelled).toContain(ask?.clOrdId);
    await e.stop();
  });

  it("sends no opening order when the bot is stopped while an event is being handled (DEC-255)", async () => {
    const { eq } = await import("drizzle-orm");
    const gw = new FakeGateway();
    // Báo giá theo sổ lệnh (quoteLevel 0) để sổ lệnh thời gian thực đặt lại được bid (DEC-248).
    const base = mmSmart(true);
    const { botId } = await seedBot("running", {
      ...base,
      config: { ...base.config, quoteLevel: 0 },
    });
    const e = makeEngine(gw, "w-stop-race");
    await e.tick();
    await e.onPrice("BTC-USD", "100000", clock);
    const bid = gw.received.filter((o) => o.side === "buy").at(-1);
    expect(bid).toBeDefined();
    const placed = gw.received.length;
    // Sổ lệnh chạy lên: bot huỷ bid cũ rồi đặt bid mới. Lệnh huỷ bị giữ; trong lúc đó người dùng bấm Stop.
    let release: () => void = () => undefined;
    gw.holdCancel = new Promise<void>((r) => {
      release = r;
    });
    const up = String(Number(bid?.price) + 3);
    const moving = e.onMmBook(
      { s: "BTC-USD", b: up, a: String(Number(up) + 0.1), E: clock + 2000, at: clock + 2000 },
      clock + 2000,
    );
    for (let i = 0; i < 50 && !gw.cancelHeld; i += 1) await new Promise((r) => setTimeout(r, 20));
    expect(gw.cancelHeld).toBe(true);
    await db.update(bots).set({ state: "stopping" }).where(eq(bots.id, botId));
    release();
    await moving;
    // Lệnh huỷ vẫn đi, nhưng không có lệnh mở mới nào tới SoDEX sau lúc Stop.
    expect(gw.received.slice(placed).filter((o) => !o.reduceOnly)).toEqual([]);
    await e.stop();
  });

  it("sends Market Making no refresh messages, and a bot without Smart quoting no live price (DEC-298)", async () => {
    const { eq } = await import("drizzle-orm");
    // Bot MM của test trước không được phản ứng thay bot của test này.
    await db.update(bots).set({ state: "stopped" }).where(eq(bots.strategy, "volume_maker"));
    for (const smart of [true, false]) {
      const gw = new FakeGateway();
      const base = mmSmart(smart);
      const { botId } = await seedBot("running", {
        ...base,
        config: { ...base.config, quoteLevel: 0 },
      });
      const e = makeEngine(gw, `w-refresh-${String(smart)}`);
      // Worker của test khác chết (`kill`) vẫn còn key tới hết `leaseTtlMs`: chờ tới khi engine này giữ shard của bot.
      const quoted = () => gw.received.some((o) => o.side === "buy");
      for (let i = 0; i < 40 && !quoted(); i += 1) {
        await e.tick();
        await e.onPrice("BTC-USD", "100000", clock);
        if (!quoted()) await new Promise((r) => setTimeout(r, 50));
      }
      const bid = gw.received.filter((o) => o.side === "buy").at(-1);
      expect(bid).toBeDefined();
      const placed = gw.received.length;
      const cancelled = gw.cancelled.length;
      const up = String(Number(bid?.price) + 3);
      const msg = {
        s: "BTC-USD",
        b: up,
        a: String(Number(up) + 0.1),
        E: clock + 2000,
        at: clock + 2000,
      };
      // Smart quoting: tin `refresh` bị bỏ qua (không đặt lại); không Smart quoting: không tin nào tới.
      await e.onMmBook(smart ? { ...msg, refresh: true } : msg, clock + 2000);
      expect(gw.received.length).toBe(placed);
      expect(gw.cancelled.length).toBe(cancelled);
      await db.update(bots).set({ state: "stopped" }).where(eq(bots.id, botId));
      await e.stop();
    }
  });

  it("keeps the open orders of a paused Market Making bot when the Binance price moves (DOMAIN 7.2)", async () => {
    const { eq } = await import("drizzle-orm");
    const gw = new FakeGateway();
    const { botId } = await seedBot("running", mmSmart(true));
    const e = makeEngine(gw, "w-fair-paused");
    await e.tick();
    await e.onPrice("BTC-USD", "100000", clock);
    const askOrder = gw.received.filter((o) => o.side === "sell").at(-1);
    expect(askOrder).toBeDefined();
    await db.update(bots).set({ state: "paused" }).where(eq(bots.id, botId));
    const before = gw.cancelled.length;
    await e.onMmFair(
      { s: "BTC-USD", fair: String(Number(askOrder?.price) + 5), T: clock, at: clock },
      clock,
    );
    expect(gw.cancelled.slice(before)).toEqual([]);
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

  it("does not set or log leverage again when the bot is reloaded on the same version, but does for a new version", async () => {
    const { eq, and } = await import("drizzle-orm");
    const gw = new FakeGateway();
    const { botId, accountId } = await seedBot("starting", {
      ...futuresGrid,
      config: { ...futuresGrid.config, leverage: 17 },
    });
    const mine = () => gw.leverage.filter((l) => l.leverage === 17 || l.leverage === 13);
    const logged = async () =>
      (
        await db
          .select()
          .from(botEvents)
          .where(and(eq(botEvents.botId, botId), eq(botEvents.decision, "Leverage set")))
      ).length;
    const a = makeEngine(gw, "lev-a");
    await a.tick();
    await a.onPrice("BTC-USD", "100", clock);
    expect(mine()).toHaveLength(1);
    expect(await logged()).toBe(1);
    await a.stop();
    // SoDEX không cho đọc lại thiết lập (giả lỗi đọc) và runner được nạp lại (chuyển shard / khởi động lại).
    gw.settings.clear();
    const b = makeEngine(gw, "lev-b");
    await b.tick();
    expect(b.ownedShards).toContain(shardOf(accountId, SHARDS));
    await b.onPrice("BTC-USD", "101", clock);
    expect(mine()).toHaveLength(1);
    expect(await logged()).toBe(1);
    // Version mới (đòn bẩy khác) vẫn đặt lại như trước.
    const [v2] = await db
      .insert(botVersions)
      .values({
        botId,
        version: 2,
        paramSource: "manual",
        status: "pending",
        config: { ...futuresGrid.config, leverage: 13 },
      })
      .returning();
    expect(v2).toBeDefined();
    clock += 1;
    await b.tick();
    await b.onPrice("BTC-USD", "100", clock);
    expect(mine().map((l) => l.leverage)).toEqual([17, 13]);
    expect(await logged()).toBe(2);
    await b.stop();
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
  it("still finishes Pause and Stop after the team turns a strategy off, without placing orders (review #71)", async () => {
    const { eq, inArray } = await import("drizzle-orm");
    const gw = new FakeGateway();
    const volume = {
      strategy: "volume_maker",
      market: "BTC-USD",
      engine: "perps" as const,
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
    };
    const adca = {
      strategy: "adaptive_dca",
      market: "ETH-USD",
      engine: "perps" as const,
      config: {
        market: "ETH-USD",
        leverage: 2,
        baseOrder: "100",
        safetyOrder: "100",
        maxExposure: "1000",
        maxLoss: "150",
      },
    };
    // Admin tắt cờ thì api đưa bot đang chạy sang Pausing; engine phải nạp để hoàn tất.
    const v = await seedBot("running", volume);
    const a = await seedBot("running", adca);
    const s = await seedBot("running", adca);
    await db
      .update(bots)
      .set({ state: "pausing" })
      .where(inArray(bots.id, [v.botId, a.botId]));
    await db.update(bots).set({ state: "stopping" }).where(eq(bots.id, s.botId));
    for (const id of [v.botId, a.botId, s.botId]) {
      const [b] = await db.select().from(bots).where(eq(bots.id, id));
      await db
        .update(users)
        .set({ volumeBots: false, adaptiveDca: false })
        .where(eq(users.id, b?.userId ?? ""));
    }
    const e = makeEngine(gw, "w-flag-off");
    for (let i = 0; i < 20; i += 1) {
      await e.tick();
      const states = await db
        .select({ state: bots.state })
        .from(bots)
        .where(inArray(bots.id, [v.botId, a.botId, s.botId]));
      if (states.every((x) => x.state === "paused" || x.state === "stopped")) break;
    }
    expect((await botState(v.botId))?.state).toBe("paused");
    expect((await botState(a.botId))?.state).toBe("paused");
    expect((await botState(s.botId))?.state).toBe("stopped");
    // Cờ tắt: không lệnh mới nào được gửi (Pause giữ lệnh đang mở, DOMAIN.md mục 7.2).
    await e.onPrice("BTC-USD", "100000", clock);
    await e.onPrice("ETH-USD", "100", clock);
    expect(gw.received.filter((o) => !o.reduceOnly)).toEqual([]);
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

  it("still sends the Spot close on Stop, which is not reduce-only (DEC-81, DEC-255)", async () => {
    const { eq } = await import("drizzle-orm");
    const gw = new FakeGateway();
    const { botId } = await seedBot("running");
    const e = makeEngine(gw, "w-spot-close");
    let rt: typeof botRuntime.$inferSelect | undefined;
    for (let i = 0; i < 20 && rt === undefined; i += 1) {
      await e.tick();
      await e.onPrice("vBTC_vUSDC", "100", clock);
      [rt] = await db.select().from(botRuntime).where(eq(botRuntime.botId, botId));
      if (rt === undefined) await new Promise((r) => setTimeout(r, 100));
    }
    // Bot đang giữ 2 BTC (sổ cái) rồi người dùng bấm Stop và chọn đóng vị thế.
    const st = rt?.state as { ledger: Record<string, string> };
    await db
      .update(botRuntime)
      .set({ state: { ...st, ledger: { ...st.ledger, position: "2", avgCost: "100" } } })
      .where(eq(botRuntime.botId, botId));
    await e.stop();
    await db.update(bots).set({ state: "stopping", closeOnStop: true }).where(eq(bots.id, botId));
    gw.received.length = 0;
    const e2 = makeEngine(gw, "w2-spot-close");
    for (let i = 0; i < 10 && (await botState(botId))?.state !== "stopped"; i += 1) {
      await e2.tick();
      if ((await botState(botId))?.state !== "stopped")
        await new Promise((r) => setTimeout(r, 100));
    }
    expect(gw.received.filter((o) => o.tag === "close")).toEqual([
      expect.objectContaining({ side: "sell", reduceOnly: false, quantity: "2" }),
    ]);
    expect((await botState(botId))?.state).toBe("stopped");
    await e2.stop();
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

  it("enters Volume Farm at the live SoDEX price, but never treats an old message as fresh (DEC-298)", async () => {
    // REST: 100 / 100.05 → mua 100, bán 101. WS: 99 / 99.02 → mua 99, bán 100 (tick 1).
    const gw = new FakeGateway();
    for (const m of ["AVAX-USD", "ADA-USD"]) {
      await seedCandles(m);
      await seedFarm(m);
    }
    const e = farmEngine(gw, "live-book");
    e.onFarmBook({ s: "AVAX-USD", b: "99", a: "99.02", E: clock, at: clock }, clock);
    // Tin nhận 3 s trước (vd. phải chờ trong hàng đợi): không coi là mới, bot dùng bản REST vừa đọc.
    e.onFarmBook({ s: "ADA-USD", b: "99", a: "99.02", E: clock, at: clock }, clock - 3_000);
    const entryOf = (m: string) =>
      gw.received.find((o) => o.tag.startsWith("vf:") && o.market === m);
    await tickUntil(e, () => entryOf("AVAX-USD") !== undefined && entryOf("ADA-USD") !== undefined);
    const fresh = entryOf("AVAX-USD");
    expect(fresh).toMatchObject({ type: "limit", price: fresh?.side === "buy" ? "99" : "100" });
    const old = entryOf("ADA-USD");
    expect(old).toMatchObject({ type: "limit", price: old?.side === "buy" ? "100" : "101" });
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

  it("fills a paper bot's close at the last price on Stop, so no paper order stays open (PB-01)", async () => {
    const { eq } = await import("drizzle-orm");
    const gw = new FakeGateway();
    const p = await seedPaper();
    const e = paperEngine(gw, "paper-stop");
    await e.tick();
    await e.onPrice("vBTC_vUSDC", "100", clock);
    // Giá xuống qua mức mua 95: lệnh mua giả khớp, bot giữ BTC giả.
    clock += 1_000;
    await e.onPrice("vBTC_vUSDC", "94", clock);
    const bought = await db.select().from(paperFills).where(eq(paperFills.botId, p.botId));
    expect(bought.length).toBeGreaterThan(0);
    await db.update(bots).set({ state: "stopping", closeOnStop: true }).where(eq(bots.id, p.botId));
    for (let i = 0; i < 3; i += 1) {
      clock += 1_000;
      await e.tick();
    }
    expect((await botState(p.botId))?.state).toBe("stopped");
    const rows = await db.select().from(orders).where(eq(orders.botId, p.botId));
    expect(rows.filter((o) => o.status === "open" || o.status === "partially_filled")).toEqual([]);
    expect(rows.find((o) => o.tag === "close")?.status).toBe("filled");
    // Bot paper không bao giờ gửi gì qua cổng thật (quy tắc 2, DEC-105).
    expect(gw.received).toEqual([]);
    await e.stop();
  });

  it("keeps a paper Stop in stopping until there is a price, so the fake position is closed (PB-01 review)", async () => {
    const { eq } = await import("drizzle-orm");
    const gw = new FakeGateway();
    const p = await seedPaper();
    const a = paperEngine(gw, "paper-noprice");
    await a.tick();
    await a.onPrice("vBTC_vUSDC", "100", clock);
    clock += 1_000;
    await a.onPrice("vBTC_vUSDC", "94", clock);
    expect(
      (await db.select().from(paperFills).where(eq(paperFills.botId, p.botId))).length,
    ).toBeGreaterThan(0);
    await a.stop();
    // Engine mới (khởi động lại / đổi shard): chưa có giá nào. Người dùng bấm Stop kèm đóng vị thế.
    await db.update(bots).set({ state: "stopping", closeOnStop: true }).where(eq(bots.id, p.botId));
    const b = paperEngine(gw, "paper-noprice");
    await b.tick();
    await b.tick();
    // Engine mới (cùng workerId) phải sở hữu shard của bot, không thì "vẫn stopping" không chứng minh gì.
    expect(b.ownedShards).toContain(shardOf(p.accountId, SHARDS));
    expect((await botState(p.botId))?.state).toBe("stopping");
    // Không gửi lệnh đóng khi chưa có giá (không có lệnh close bị reject NO_PRICE).
    const before = await db.select().from(orders).where(eq(orders.botId, p.botId));
    expect(before.filter((o) => o.tag === "close")).toEqual([]);
    clock += 1_000;
    await b.onPrice("vBTC_vUSDC", "95", clock);
    for (let i = 0; i < 3 && (await botState(p.botId))?.state !== "stopped"; i += 1) {
      clock += 1_000;
      await b.tick();
    }
    expect((await botState(p.botId))?.state).toBe("stopped");
    const rows = await db.select().from(orders).where(eq(orders.botId, p.botId));
    expect(rows.find((o) => o.tag === "close")?.status).toBe("filled");
    expect(gw.received).toEqual([]);
    await b.stop();
  });

  it("never fills the open paper order of a bot the engine no longer runs (PB-01)", async () => {
    const { eq } = await import("drizzle-orm");
    const gw = new FakeGateway();
    const stopped = await seedPaper();
    await db.update(bots).set({ state: "stopped" }).where(eq(bots.id, stopped.botId));
    // Lệnh đóng cũ còn "open" (như trước bản sửa): không bot nào chạy nó nên engine không ghi được fill vào dòng lệnh.
    await db.insert(orders).values({
      botId: stopped.botId,
      sodexAccountId: stopped.accountId,
      clOrdId: "stuck-paper-close",
      market: "vBTC_vUSDC",
      engine: "spot",
      side: "sell",
      type: "market",
      timeInForce: "IOC",
      size: "1",
      status: "open",
      reduceOnly: false,
      tag: "close",
      epoch: 1,
    });
    const running = await seedPaper();
    const e = paperEngine(gw, "paper-other");
    await e.tick();
    await e.onPrice("vBTC_vUSDC", "100", clock);
    clock += 1_000;
    await e.onPrice("vBTC_vUSDC", "101", clock);
    expect(await db.select().from(paperFills).where(eq(paperFills.botId, stopped.botId))).toEqual(
      [],
    );
    await e.stop();
    await db.update(bots).set({ state: "stopped" }).where(eq(bots.id, running.botId));
  });

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

  it("feeds 1-minute candles to AI Adaptive DCA bots, only while the account's Adaptive DCA flag is on (DEC-107)", async () => {
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
    // Một engine cho cả hai giai đoạn: team tắt cờ Adaptive DCA thì không nạp bot; bật lại thì vòng sau nạp và gửi nến
    // (cờ riêng, không theo AI Desk: DEC-192; mặc định bật cho mọi tài khoản: DEC-218).
    const [b] = await db.select().from(bots).where(eq(bots.id, botId));
    const [owner] = await db
      .select()
      .from(users)
      .where(eq(users.id, b?.userId ?? ""));
    expect(owner?.adaptiveDca).toBe(true);
    await db
      .update(users)
      .set({ adaptiveDca: false })
      .where(eq(users.id, b?.userId ?? ""));
    const e = farmEngine(gw, "adca");
    await e.tick();
    await e.onPrice("ETH-USD", "100", clock);
    await e.tick();
    expect(await state()).toBeUndefined();
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

  it("ends a copy order that filled part of the way and then expired, after its fill and only once (P0.1)", async () => {
    const { eq } = await import("drizzle-orm");
    const gw = new FakeGateway();
    const leader = "0x6666666666666666666666666666666666666666";
    const { botId, accountId } = await seedBot("running", copySpec(leader));
    const e = farmEngine(gw, "copy-partial-done");
    await e.tick();
    await e.onPrice("BTC-USD", "100000", clock);
    await e.onLeaderFill(leaderFill(leader, "1", clock), clock + 200);
    const id = gw.received.find((o) => o.tag.startsWith("copy:"))?.clOrdID ?? "";
    const slot = async () => {
      const [rt] = await db.select().from(botRuntime).where(eq(botRuntime.botId, botId));
      const st = rt?.state as {
        markets: Record<string, { inflight: unknown; ledger: { position: string } }>;
      };
      return st.markets["BTC-USD"];
    };
    const row = async () => (await db.select().from(orders).where(eq(orders.clOrdId, id)))[0];
    // IOC khớp một nửa rồi hết hạn: trước đây engine không báo gì, lệnh "đang chờ" kẹt mãi.
    await e.onFill(accountId, id, "0.0005", "100100", "0.01", clock + 300);
    expect((await slot())?.inflight).not.toBeNull();
    await e.onOrderClosed(accountId, id, "cancelled", clock + 400);
    expect(await slot()).toMatchObject({ inflight: null, ledger: { position: "0.0005" } });
    const done = await row();
    expect(done?.status).toBe("cancelled");
    expect(Number(done?.filledSize)).toBe(0.0005);
    expect(done?.doneFedAt).not.toBeNull();
    // Phát lại (reconnect / đối soát): không báo lần hai, không cộng trùng.
    await e.onFill(accountId, id, "0.0005", "100100", "0.01", clock + 500);
    await e.onOrderClosed(accountId, id, "cancelled", clock + 600);
    expect((await row())?.doneFedAt).toEqual(done?.doneFedAt);
    expect((await slot())?.ledger.position).toBe("0.0005");
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

  it("sets leverage per market and only logs a trade on a market the copy bot doesn't have (DEC-226)", async () => {
    const { and, eq } = await import("drizzle-orm");
    const gw = new FakeGateway();
    const leader = "0x5555555555555555555555555555555555555555";
    const { botId } = await seedBot("running", {
      strategy: "copy_trade",
      market: "BTC-USD",
      engine: "perps",
      config: {
        leaderSource: "hyperliquid",
        leaderAddress: leader,
        markets: ["BTC-USD", "ETH-USD"],
        leverage: 2,
        leverageByMarket: { "BTC-USD": 1, "ETH-USD": 3 },
        marginMode: "isolated",
        fixedNotional: "100",
        maxNotionalPerTrade: "100",
        maxExposure: "500",
        maxLoss: "150",
      },
    });
    await enableDesk(botId);
    const e = farmEngine(gw, "copy-pick");
    await e.tick();
    await e.onPrice("BTC-USD", "100000", clock);
    await e.onPrice("ETH-USD", "2000", clock);
    await e.onPrice("SOL-USD", "150", clock);
    const fill = (market: string, price: string) =>
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
        },
        clock + 200,
      );
    await fill("BTC-USD", "100000");
    await fill("ETH-USD", "2000");
    // Đòn bẩy đặt theo từng market trên SoDEX.
    const set = new Map(gw.leverage.map((l) => [l.market, l.leverage]));
    expect(set.get("BTC-USD")).toBe(1);
    expect(set.get("ETH-USD")).toBe(3);
    // Trader mở ở SOL (không có trong bot): không lệnh, không đặt đòn bẩy, chỉ ghi "Skipped", không gửi tin.
    const before = gw.received.length;
    await fill("SOL-USD", "150");
    expect(gw.received.length).toBe(before);
    expect(gw.leverage.some((l) => l.market === "SOL-USD")).toBe(false);
    const events = await db
      .select()
      .from(botEvents)
      .where(and(eq(botEvents.botId, botId), eq(botEvents.decision, "Skipped")));
    expect(events.map((x) => x.why)).toEqual(["Not copied: this market isn't in your copy bot."]);
    expect(await copyAlertRows(botId, "copy_bot_skipped")).toEqual([]);
    await e.stop();
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

  it("tells the strategy once that an order ended when reconciliation finds it, even if the user stream says so too (P0.1)", async () => {
    const { eq } = await import("drizzle-orm");
    const gw = new FakeGateway();
    gw.cancelOutcome = "unknown";
    const { accountId } = await seedMaker();
    const e = farmEngine(gw, "vm-done-once");
    await e.tick();
    await e.onPrice("BTC-USD", "100000", clock);
    const bid = gw.received.find((o) => o.tag.endsWith(":bid"))?.clOrdID ?? "";
    const row = async () => (await db.select().from(orders).where(eq(orders.clOrdId, bid)))[0];
    clock += 4_000;
    await e.tick();
    expect((await row())?.doneFedAt).toBeNull();
    // SoDEX đã huỷ lệnh: đối soát đọc được và báo chiến lược.
    const live = gw.book.get(bid);
    if (live !== undefined && live.status !== "not_found")
      gw.book.set(bid, { ...live, status: "cancelled" });
    clock += 20_000;
    await e.tick();
    const after = await row();
    expect(after?.status).toBe("cancelled");
    expect(after?.doneFedAt).not.toBeNull();
    // User stream báo CANCELED muộn: không báo lần hai.
    await e.onOrderClosed(accountId, bid, "cancelled", clock);
    expect((await row())?.doneFedAt).toEqual(after?.doneFedAt);
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

describe("Rebalancing order books (IOC at ask / bid)", () => {
  it("feeds the spot order book of every basket market with the timer, at most once a minute", async () => {
    const { eq } = await import("drizzle-orm");
    const calls: string[] = [];
    const gw = new FakeGateway();
    const { botId } = await seedBot("running", {
      strategy: "rebalancing",
      market: "vBTC_vUSDC",
      engine: "spot",
      config: {
        quoteAsset: "USDC",
        assets: [
          { asset: "BTC", market: "vBTC_vUSDC", weightPct: "50" },
          { asset: "ETH", market: "vETH_vUSDC", weightPct: "30" },
          { asset: "USDC", weightPct: "20" },
        ],
        rebalanceWhen: "threshold",
        thresholdPct: "5",
        investment: "1000",
        maxTradePct: "100",
      },
    });
    const e = new Engine({
      db,
      redis: newRedis(),
      gateway: gw,
      workerId: "rebal-books",
      log,
      now,
      leaseTtlMs: 30_000,
      shards: SHARDS,
      rules: () => Promise.resolve(rules),
      feeCheckMs: 0,
      orderbook: (market, engine) => {
        calls.push(`${engine ?? "perps"}:${market}`);
        return Promise.resolve({ bid: "99", ask: "101", bidNotional: "1", askNotional: "1" });
      },
    });
    await e.tick();
    await e.tick();
    expect(calls.sort()).toEqual(["spot:vBTC_vUSDC", "spot:vETH_vUSDC"]);
    clock += 61_000;
    await e.tick();
    expect(calls).toHaveLength(4);
    // Có giá và sổ lệnh: lần mua đầu đặt IOC theo ask + 0,3% (101 × 1,003 = 101,303 → 101 theo tick 1).
    await e.onPrice("vBTC_vUSDC", "100", clock);
    await e.onPrice("vETH_vUSDC", "10", clock);
    const placed = gw.received.filter((o) => o.tag.startsWith("rebal:"));
    expect(placed.map((o) => o.timeInForce)).toEqual(["IOC", "IOC"]);
    expect(placed.every((o) => o.price === "101")).toBe(true);
    await e.stop();
    await db.update(bots).set({ state: "stopped" }).where(eq(bots.id, botId));
  });
});

/**
 * SoDEX giả cho harness tranh chấp của engine (DEC-270): độ trễ ngẫu nhiên thật (ms) ở chiều đi và chiều
 * về, lệnh vào sổ lúc tới SoDEX, lệnh huỷ tới trước lúc vào sổ trả OrderNotFound (lệnh vẫn vào sổ sau đó), khớp khi giá
 * chạy qua. Ghi vi phạm bất biến 2 ngay lúc nhận lệnh: lệnh mở tới khi bot đã stopping / stopped.
 */
class RaceGateway extends FakeGateway {
  /** Lệnh đang nằm trên "SoDEX". */
  readonly open = new Map<string, OrderIntent>();
  /** Lệnh đã gửi, chưa tới SoDEX. */
  readonly arriving = new Set<string>();
  /** Lệnh khớp chờ harness báo cho engine (`onFill`). */
  readonly fills: { clOrdID: string; qty: string; price: string }[] = [];
  readonly violations: string[] = [];
  position = "0";
  price = "0";
  /** Trạng thái bot trong DB lúc nhận lệnh (bất biến 2). */
  botState: () => Promise<string | undefined> = () => Promise.resolve(undefined);
  /** Gọi khi engine đọc đòn bẩy (sau lần kiểm tra trạng thái đầu sự kiện, trước lần đọc lại của DEC-255). */
  beforeReadLeverage: (() => Promise<void>) | null = null;
  constructor(
    private readonly rnd: () => number,
    private readonly maxDelayMs = 12,
    /** Tỉ lệ lệnh limit vào sổ mà phản hồi submit là `unknown` (timeout): đường huỷ lệnh chưa được nhận của DEC-254. */
    private readonly unknownProb = 0,
  ) {
    super();
  }
  override async readLeverage(a: AccountRef, market: string) {
    const hook = this.beforeReadLeverage;
    this.beforeReadLeverage = null;
    if (hook !== null) await hook();
    return super.readLeverage(a, market);
  }
  #wait() {
    return new Promise((r) => setTimeout(r, Math.floor(this.rnd() * this.maxDelayMs)));
  }
  #crosses(o: OrderIntent, price: string) {
    const p = Number(o.price ?? price);
    return o.side === "buy" ? Number(price) <= p : Number(price) >= p;
  }
  #fill(o: OrderIntent, price: string) {
    this.open.delete(o.clOrdID);
    const q = Number(o.quantity);
    this.position = String(Number(this.position) + (o.side === "buy" ? q : -q));
    this.book.set(o.clOrdID, {
      status: "filled",
      filledQty: o.quantity,
      avgPrice: price,
      orderId: BigInt(this.received.length),
    });
    this.fills.push({ clOrdID: o.clOrdID, qty: o.quantity, price });
  }
  /** Giá mới: lệnh limit bị giá chạy qua thì khớp ở giá đặt. */
  move(price: string) {
    this.price = price;
    for (const o of [...this.open.values()])
      if (this.#crosses(o, price)) this.#fill(o, o.price ?? price);
  }
  override async submit(_a: AccountRef, list: readonly OrderIntent[]): Promise<SubmitResult[]> {
    const st = await this.botState();
    if (st === "stopping" || st === "stopped")
      for (const o of list)
        // Lệnh đóng engine dựng khi Stop (tag `close`; Spot không có reduce-only) luôn được đi (DEC-255).
        if (!o.reduceOnly && o.tag !== "close")
          this.violations.push(
            `invariant 2: opening order ${o.tag} reached SoDEX while the bot was ${st}`,
          );
    for (const o of list) this.arriving.add(o.clOrdID);
    await this.#wait();
    const out: SubmitResult[] = [];
    for (const o of list) {
      this.arriving.delete(o.clOrdID);
      this.received.push(o);
      const id = BigInt(this.received.length);
      if (o.type === "market") this.#fill(o, this.price);
      else if (o.timeInForce === "GTX" && this.#crosses(o, this.price)) {
        out.push({
          clOrdID: o.clOrdID,
          outcome: "rejected",
          code: "POST_ONLY_WOULD_TRADE",
          message: null,
        });
        continue;
      } else {
        this.open.set(o.clOrdID, o);
        this.book.set(o.clOrdID, { status: "open", filledQty: "0", avgPrice: null, orderId: id });
        if (this.#crosses(o, this.price)) this.#fill(o, o.price ?? this.price);
        if (this.rnd() < this.unknownProb) {
          out.push({ clOrdID: o.clOrdID, outcome: "unknown" });
          continue;
        }
      }
      out.push({ clOrdID: o.clOrdID, outcome: "ok", orderId: id });
    }
    await this.#wait();
    return out;
  }
  override async cancel(
    _a: AccountRef,
    list: readonly { clOrdID: string }[],
  ): Promise<CancelResult[]> {
    await this.#wait();
    const out = list.map((x): CancelResult => {
      if (this.open.has(x.clOrdID)) {
        this.open.delete(x.clOrdID);
        this.cancelled.push(x.clOrdID);
        const b = this.book.get(x.clOrdID);
        if (b !== undefined && b.status !== "not_found")
          this.book.set(x.clOrdID, { ...b, status: "cancelled" });
        return { clOrdID: x.clOrdID, outcome: "ok" };
      }
      if (this.arriving.has(x.clOrdID))
        return { clOrdID: x.clOrdID, outcome: "unknown", detail: "OrderNotFound" };
      return { clOrdID: x.clOrdID, outcome: "rejected", code: "ORDER_NOT_OPEN" };
    });
    await this.#wait();
    return out;
  }
}

describe("engine race harness (DEC-270)", () => {
  const SEEDS = Number(process.env.RACE_ENGINE_SEEDS ?? "2");
  const STEPS = Number(process.env.RACE_ENGINE_STEPS ?? "120");
  const mm = (smartQuoting: boolean) => ({
    strategy: "volume_maker",
    market: "BTC-USD",
    engine: "perps" as const,
    config: {
      market: "BTC-USD",
      leverage: 1,
      orderSize: "500",
      distanceBp: "1",
      maxOrders: 1,
      refreshSeconds: 3,
      runUntil: "target_or_budget",
      costBudget: "100000",
      onStop: "close_inventory",
      smartQuoting,
    },
  });
  const grid = {
    strategy: "spot_grid",
    market: "vBTC_vUSDC",
    engine: "spot" as const,
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
  };

  /**
   * Một kịch bản: giá đi ngẫu nhiên; mỗi bước bắn song song tin giá, nhịp engine, giá Binance (MM) và tin khớp, theo thứ
   * tự ngẫu nhiên; Stop chen giữa ở `stopAt`. Sau đó để engine dọn (vài nhịp, đồng hồ +1,5 s) rồi kiểm bất biến.
   */
  async function race(
    kind: "mm" | "mm-smart" | "grid",
    seed: number,
    stopAt: number | null,
  ): Promise<string[]> {
    const { eq } = await import("drizzle-orm");
    const rnd = seededRandom(seed);
    // MM: 15% lệnh limit có phản hồi `unknown` (lệnh vẫn vào sổ), để có lệnh huỷ tới khi lệnh chưa được nhận (DEC-254).
    const gw = new RaceGateway(rnd, 12, kind === "grid" ? 0 : 0.15);
    const spec = kind === "grid" ? grid : mm(kind === "mm-smart");
    const market = spec.market;
    const { botId, accountId } = await seedBot("running", spec);
    gw.botState = async () => (await botState(botId))?.state;
    const e = new Engine({
      db,
      redis: newRedis(),
      gateway: gw,
      workerId: `race-${kind}-${String(seed)}`,
      log,
      now,
      leaseTtlMs: 30_000,
      shards: SHARDS,
      rules: () => Promise.resolve(rules),
      feeCheckMs: 0,
    });
    for (let i = 0; i < 20 && !(await e.activeAccounts()).some((a) => a.id === accountId); i += 1)
      await e.tick();
    let price = kind === "grid" ? 100 : 100_000;
    const tick = kind === "grid" ? 1 : 3;
    gw.move(String(price));
    const fills = async () => {
      for (const f of gw.fills.splice(0))
        await e.onFill(accountId, f.clOrdID, f.qty, f.price, "0", clock);
    };
    // "Holds up to 1" × 500 USDC, cộng 5% cho giá chạy giữa hai lần khớp.
    const limit = kind === "grid" ? null : 500 * 1.05;
    const violations: string[] = [];
    // Bất biến 3 theo thời gian: lệnh nằm trên SoDEX mà bot không theo dõi là "live" quá UNTRACKED_MS (đồng hồ giả). Dưới
    // mức quét lệnh mồ côi của engine (MAKER_ORPHAN_MS 15 s) để lưới an toàn đó không che lỗi.
    const UNTRACKED_MS = 12_000;
    /** Chẩn đoán: trạng thái dòng lệnh của engine (status, đã ack chưa, đã báo orderDone chưa). */
    const rowOf = async (id: string) => {
      const [o] = await db.select().from(orders).where(eq(orders.clOrdId, id));
      return o === undefined
        ? "no order row"
        : `row ${o.status}${o.ackedAt === null ? " unacked" : ""}${o.doneFedAt === null ? "" : " done fed"}`;
    };
    const untrackedSince = new Map<string, number>();
    const flagged = new Set<string>();
    const checkUntracked = async () => {
      const [row] = await db.select().from(botRuntime).where(eq(botRuntime.botId, botId));
      const cur = (row?.state ?? {}) as {
        orders?: Record<string, { status: string }>;
        open?: Record<string, unknown>;
      };
      for (const [id, o] of gw.open) {
        const tracked =
          kind === "grid" ? cur.open?.[id] !== undefined : cur.orders?.[id]?.status === "live";
        if (tracked || o.reduceOnly || o.tag === "close") {
          untrackedSince.delete(id);
          continue;
        }
        const since = untrackedSince.get(id) ?? clock;
        untrackedSince.set(id, since);
        if (clock - since > UNTRACKED_MS && !flagged.has(id)) {
          flagged.add(id);
          violations.push(
            `invariant 3: ${o.tag} open on SoDEX for ${String(clock - since)} ms while the bot does not track it as live (strategy ${cur.orders?.[id]?.status ?? "none"}, ${await rowOf(id)})`,
          );
        }
      }
      for (const id of [...untrackedSince.keys()]) if (!gw.open.has(id)) untrackedSince.delete(id);
    };
    for (let s = 0; s < STEPS; s += 1) {
      clock += 250;
      price += Math.round((rnd() * 2 - 1) * (rnd() < 0.05 ? 4 : 1)) * tick;
      gw.move(String(price));
      if (limit !== null && Math.abs(Number(gw.position)) * price > limit)
        violations.push(`invariant 1: position ${gw.position} above the bot's limit`);
      const at = clock;
      const jobs: (() => Promise<unknown>)[] = [() => e.onPrice(market, String(price), at), fills];
      if (s % 4 === 0) jobs.push(() => e.tick());
      if (kind !== "grid" && rnd() < 0.4) {
        const fair = String(price + Math.round((rnd() * 2 - 1) * 8));
        jobs.push(() => e.onMmFair({ s: market, fair, T: at - 50, at: at - 10 }, at));
      }
      if (s === stopAt)
        jobs.push(async () => {
          await new Promise((r) => setTimeout(r, Math.floor(rnd() * 15)));
          await db
            .update(bots)
            .set({ state: "stopping", closeOnStop: true })
            .where(eq(bots.id, botId));
        });
      jobs.sort(() => rnd() - 0.5);
      await Promise.all(
        jobs.map(async (j) => {
          await new Promise((r) => setTimeout(r, Math.floor(rnd() * 8)));
          await j();
        }),
      );
      await checkUntracked();
    }
    // Dọn: không còn tin giá mới; engine thử huỷ lại, đối soát, hoàn tất Stop.
    // 20 nhịp × 1,5 s: đủ cho đối soát lệnh `unknown` (RECONCILE_AFTER_MS 5 s) và các lần huỷ lại.
    for (let k = 0; k < 20; k += 1) {
      clock += 1_500;
      await e.tick();
      await fills();
      await new Promise((r) => setTimeout(r, 30));
      await checkUntracked();
    }
    await fills();
    const [rt] = await db.select().from(botRuntime).where(eq(botRuntime.botId, botId));
    const st = (rt?.state ?? {}) as {
      orders?: Record<string, { status: string }>;
      open?: Record<string, unknown>;
      ledger?: { position: string };
    };
    const stopped = (await botState(botId))?.state === "stopped";
    // Bất biến 3: lệnh còn nằm trên SoDEX phải là lệnh bot đang theo dõi; bot đã dừng thì không còn lệnh mở.
    for (const [id, o] of gw.open) {
      const tracked =
        kind === "grid" ? st.open?.[id] !== undefined : st.orders?.[id]?.status === "live";
      if (stopped ? !o.reduceOnly : !tracked)
        violations.push(
          `invariant 3: ${o.tag} still open on SoDEX but not tracked as live (${stopped ? "bot stopped" : `strategy ${st.orders?.[id]?.status ?? "none"}`}, ${await rowOf(id)})`,
        );
    }
    // Bất biến 4: mỗi fill vào sổ cái đúng một lần.
    const ours = Number(st.ledger?.position ?? "0");
    if (Math.abs(ours - Number(gw.position)) > 1e-9)
      violations.push(
        `invariant 4: bot ledger position ${String(ours)} differs from SoDEX ${gw.position}`,
      );
    await e.stop();
    await db.update(bots).set({ state: "stopped" }).where(eq(bots.id, botId));
    return [...gw.violations, ...violations];
  }

  for (const kind of ["mm", "mm-smart", "grid"] as const)
    for (let seed = 1; seed <= SEEDS; seed += 1)
      it(
        `keeps the money invariants: ${kind}, seed ${String(seed)}, Stop half way`,
        { timeout: 180_000 },
        async () => {
          expect(await race(kind, seed * 101, Math.floor(STEPS / 2))).toEqual([]);
        },
      );
  it("sends no opening order when Stop lands while the first quote is being worked out (DEC-255)", async () => {
    // Lần đọc đòn bẩy của sự kiện giá đầu tiên nằm giữa lần kiểm tra trạng thái đầu sự kiện và lần đọc lại ngay trước khi
    // gửi (DEC-255): Stop chen đúng chỗ đó. Lúc kích hoạt, đặt đòn bẩy "not_sent" để chưa coi là đã đặt.
    const { eq } = await import("drizzle-orm");
    const gw = new RaceGateway(seededRandom(7), 0);
    gw.leverageOutcome = { outcome: "not_sent", code: "signer_unavailable" };
    const { botId, accountId } = await seedBot("running", mm(false));
    gw.botState = async () => (await botState(botId))?.state;
    const e = new Engine({
      db,
      redis: newRedis(),
      gateway: gw,
      workerId: "race-stop-gate",
      log,
      now,
      leaseTtlMs: 30_000,
      shards: SHARDS,
      rules: () => Promise.resolve(rules),
      feeCheckMs: 0,
    });
    for (let i = 0; i < 20 && !(await e.activeAccounts()).some((a) => a.id === accountId); i += 1)
      await e.tick();
    gw.leverageOutcome = { outcome: "ok" };
    // "not_sent" lúc kích hoạt đặt bot vào backoff: chờ qua backoff để sự kiện giá kế tiếp đọc lại đòn bẩy.
    clock += 10 * 60_000;
    gw.beforeReadLeverage = async () => {
      await db.update(bots).set({ state: "stopping", closeOnStop: true }).where(eq(bots.id, botId));
    };
    gw.move("100000");
    clock += 250;
    await e.onPrice("BTC-USD", "100000", clock);
    expect(gw.beforeReadLeverage).toBeNull();
    await e.stop();
    await db.update(bots).set({ state: "stopped" }).where(eq(bots.id, botId));
    expect(gw.violations).toEqual([]);
  });
  for (let seed = 1; seed <= SEEDS; seed += 1)
    it(
      `keeps the money invariants: mm-smart, seed ${String(seed)}, no Stop`,
      { timeout: 180_000 },
      async () => {
        expect(await race("mm-smart", seed * 211, null)).toEqual([]);
      },
    );
});

// Sự cố 2026-11-15: bot Market Making bị SoDEX từ chối "insufficient margin" (code -1) 21 438 lần trong 15 giờ mà không
// pause. Engine phải pause ORDER_REJECTED sau 3 lần liên tiếp hoặc 5 lần trong 60 s; post-only bị từ chối không tính.
describe("insufficient margin rejects (margin guard)", () => {
  const MARGIN = { code: "-1", message: "insufficient margin" };
  const mm = {
    strategy: "volume_maker",
    market: "BTC-USD",
    engine: "perps" as const,
    config: {
      market: "BTC-USD",
      leverage: 20,
      orderSize: "500",
      distanceBp: "1",
      maxOrders: 1,
      refreshSeconds: 3,
      runUntil: "target_or_budget",
      costBudget: "4000",
      onStop: "close_inventory",
      smartQuoting: true,
    },
  };

  /** Gateway theo kịch bản từng lệnh: hết kịch bản thì dùng `fallback` (null = SoDEX nhận lệnh). */
  class ScriptGateway extends FakeGateway {
    plan: ({ code: string; message: string | null } | null)[] = [];
    fallback: { code: string; message: string | null } | null = null;
    override async submit(
      a: AccountRef,
      list: readonly OrderIntent[],
      fence: Fence,
      rate?: number,
    ): Promise<SubmitResult[]> {
      const out: SubmitResult[] = [];
      for (const o of list) {
        const step = this.plan.length > 0 ? this.plan.shift() : this.fallback;
        if (step !== null && step !== undefined) {
          this.received.push(o);
          out.push({ clOrdID: o.clOrdID, outcome: "rejected", ...step });
        } else out.push(...(await super.submit(a, [o], fence, rate)));
      }
      return out;
    }
  }

  const engineFor = (gw: Gateway, id: string) =>
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
    });

  /** Một nhịp làm mới báo giá: đồng hồ +4 s (refresh 3 s), nhịp engine và một tin giá (giá đổi để báo giá lại). */
  let px = 0;
  async function step(e: Engine, n = 1) {
    for (let i = 0; i < n; i += 1) {
      clock += 4_000;
      px += 1;
      await e.tick();
      await e.onPrice("BTC-USD", String(100_000 + (px % 2) * 50), clock);
    }
  }
  const pausedNotices = async (botId: string) => {
    const { sql } = await import("drizzle-orm");
    return db
      .select({ payload: outbox.payload })
      .from(outbox)
      .where(
        sql`${outbox.topic} = 'jobs.notify' and ${outbox.payload}->>'type' = 'bot_paused' and ${outbox.payload}->'data'->>'botId' = ${botId}`,
      );
  };
  const stopAll = async () => {
    const { eq } = await import("drizzle-orm");
    await db.update(bots).set({ state: "stopped" }).where(eq(bots.strategy, "volume_maker"));
  };

  it("pauses a Market Making bot after 3 margin rejects in a row, notifies once and sends nothing more", async () => {
    const { eq } = await import("drizzle-orm");
    await stopAll();
    const gw = new FakeGateway();
    gw.reject = MARGIN;
    const { botId } = await seedBot("running", mm);
    const e = engineFor(gw, "w-margin-1");
    await e.tick();
    await e.onPrice("BTC-USD", "100000", clock);
    await step(e, 5);
    const b = await botState(botId);
    expect(b?.state).toBe("paused");
    expect(b?.reasonCode).toBe(ReasonCode.orderRejected);
    // Pause ngay khi tới lần thứ 3 (một lô bid + ask = 2 lệnh, nên tối đa 4 lệnh rời DRIFT).
    expect(gw.received.length).toBeGreaterThanOrEqual(3);
    expect(gw.received.length).toBeLessThanOrEqual(4);
    const sent = gw.received.length;
    const notices = await pausedNotices(botId);
    expect(notices).toHaveLength(1);
    expect((notices[0]?.payload as { data: { reasonCode: string } }).data.reasonCode).toBe(
      ReasonCode.orderRejected,
    );
    const events = await db.select().from(botEvents).where(eq(botEvents.botId, botId));
    expect(
      events.filter(
        (x) =>
          x.decision ===
          "Paused: not enough margin on SoDEX. Add funds or lower the order size or leverage, then resume.",
      ),
    ).toHaveLength(1);
    // Đang pause: không gửi thêm lệnh nào dù giá và đồng hồ chạy.
    await step(e, 10);
    expect(gw.received).toHaveLength(sent);
    expect(await pausedNotices(botId)).toHaveLength(1);

    // Resume (người dùng đã nạp thêm tiền): báo giá lại.
    gw.reject = null;
    await db.update(bots).set({ state: "resuming", reasonCode: null }).where(eq(bots.id, botId));
    await step(e, 2);
    expect((await botState(botId))?.state).toBe("running");
    expect(gw.received.length).toBeGreaterThan(sent);
    await e.stop();
    await stopAll();
  });

  it("resets the count when SoDEX accepts an order in between", async () => {
    await stopAll();
    const gw = new ScriptGateway();
    // 2 bị từ chối, 1 được nhận, 2 bị từ chối: chưa lần nào đủ 3 liên tiếp, và chưa đủ 5 trong 60 s.
    gw.plan = [MARGIN, MARGIN, null, MARGIN, MARGIN];
    const { botId } = await seedBot("running", mm);
    const e = engineFor(gw, "w-margin-2");
    await e.tick();
    await e.onPrice("BTC-USD", "100000", clock);
    for (let i = 0; i < 10 && gw.plan.length > 0; i += 1) await step(e);
    expect(gw.plan).toHaveLength(0);
    expect((await botState(botId))?.state).toBe("running");
    expect(await pausedNotices(botId)).toHaveLength(0);
    await e.stop();
    await stopAll();
  });

  it("pauses on 5 margin rejects within 60 s even when other orders are accepted in between", async () => {
    await stopAll();
    const gw = new ScriptGateway();
    gw.plan = [MARGIN, null, MARGIN, null, MARGIN, null, MARGIN, null, MARGIN];
    gw.fallback = null;
    const { botId } = await seedBot("running", mm);
    const e = engineFor(gw, "w-margin-3");
    await e.tick();
    await e.onPrice("BTC-USD", "100000", clock);
    for (let i = 0; i < 12 && gw.plan.length > 0; i += 1) await step(e);
    expect(gw.plan).toHaveLength(0);
    const b = await botState(botId);
    expect(b?.state).toBe("paused");
    expect(b?.reasonCode).toBe(ReasonCode.orderRejected);
    expect(await pausedNotices(botId)).toHaveLength(1);
    await e.stop();
    await stopAll();
  });

  it("does not count post-only rejects", async () => {
    await stopAll();
    const gw = new FakeGateway();
    gw.reject = { code: "PostOnly", message: null };
    const { botId } = await seedBot("running", mm);
    const e = engineFor(gw, "w-margin-4");
    await e.tick();
    await e.onPrice("BTC-USD", "100000", clock);
    await step(e, 8);
    expect(gw.received.length).toBeGreaterThanOrEqual(6);
    expect((await botState(botId))?.state).toBe("running");
    expect(await pausedNotices(botId)).toHaveLength(0);
    // Post-only bị từ chối là bình thường (NORMAL_REJECT_CODES): không ghi Decisions.
    expect(await refusedLines(botId)).toHaveLength(0);
    await e.stop();
    await stopAll();
  });

  // DEC-291: lệnh bị SoDEX từ chối vì lý do thật phải hiện trong Decisions, tối đa một dòng mỗi
  // lý do mỗi phút, kèm số lần.
  const refusedLines = async (botId: string) => {
    const { eq } = await import("drizzle-orm");
    const events = await db.select().from(botEvents).where(eq(botEvents.botId, botId));
    return events
      .filter((x) => x.decision?.startsWith("Order refused by SoDEX: ") === true)
      .sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
  };

  it("writes one Decisions line per reject reason per minute, with the count", async () => {
    await stopAll();
    const gw = new FakeGateway();
    gw.reject = { code: "-1", message: "order price out of range" };
    const { botId } = await seedBot("running", mm);
    const e = engineFor(gw, "w-refused-1");
    await e.tick();
    await e.onPrice("BTC-USD", "100000", clock);
    // ~32 s của từ chối liên tục: chỉ một dòng, ghi ngay ở lần đầu.
    await step(e, 8);
    const first = await refusedLines(botId);
    expect(gw.received.length).toBeGreaterThanOrEqual(8);
    expect(first).toHaveLength(1);
    expect(first[0]?.type).toBe("error");
    expect(first[0]?.decision).toBe(
      "Order refused by SoDEX: order price out of range (1 in the last minute).",
    );
    expect(first[0]?.why).toMatch(/^SoDEX code -1\. Last: (buy|sell) /);
    // Qua mốc 60 s: thêm đúng một dòng, đếm các lần trong phút vừa qua.
    await step(e, 8);
    const lines = await refusedLines(botId);
    expect(lines).toHaveLength(2);
    const n = Number(/\((\d+) in the last minute\)\.$/.exec(lines[1]?.decision ?? "")?.[1]);
    expect(n).toBeGreaterThan(1);
    expect(n).toBeLessThanOrEqual(gw.received.length);
    // Không phải thiếu margin: không pause.
    expect((await botState(botId))?.state).toBe("running");
    await e.stop();
    await stopAll();
  });

  it("shows the margin reject reason in Decisions before the margin pause", async () => {
    await stopAll();
    const gw = new FakeGateway();
    gw.reject = MARGIN;
    const { botId } = await seedBot("running", mm);
    const e = engineFor(gw, "w-refused-2");
    await e.tick();
    await e.onPrice("BTC-USD", "100000", clock);
    await step(e, 5);
    expect((await botState(botId))?.state).toBe("paused");
    const lines = await refusedLines(botId);
    expect(lines.map((x) => x.decision)).toEqual([
      "Order refused by SoDEX: insufficient margin (1 in the last minute).",
    ]);
    await e.stop();
    await stopAll();
  });

  // DEC-292: export prod 2026-11-15, ETH-USD giữ long 0.0031 (≈ 5.7 USD, dưới minNotional 10) và lệnh bán
  // không reduce-only bị từ chối vì thiếu margin. Bot đóng phần lẻ bằng đúng một lệnh market IOC reduce-only.
  describe("dust close (DEC-292)", () => {
    const ethRules = {
      tickSize: "0.1",
      stepSize: "0.0001",
      minQuantity: "0.0001",
      minNotional: "10",
    };
    const eth = {
      strategy: "volume_maker",
      market: "ETH-USD",
      engine: "perps" as const,
      config: {
        market: "ETH-USD",
        leverage: 20,
        orderSize: "20",
        distanceBp: "1",
        maxOrders: 1,
        refreshSeconds: 3,
        runUntil: "target_or_budget",
        costBudget: "4",
        onStop: "close_inventory",
      },
    };
    const ethEngine = (gw: Gateway, id: string) =>
      new Engine({
        db,
        redis: newRedis(),
        gateway: gw,
        workerId: id,
        log,
        now,
        leaseTtlMs: 30_000,
        shards: SHARDS,
        rules: () => Promise.resolve(ethRules),
        feeCheckMs: 0,
      });
    let ep = 0;
    async function ethStep(e: Engine, n = 1) {
      for (let i = 0; i < n; i += 1) {
        clock += 4_000;
        ep += 1;
        await e.tick();
        await e.onPrice("ETH-USD", String(1840 + (ep % 2) * 0.1), clock);
      }
    }
    /** Kịch bản chỉ cho lệnh bán (ask, lệnh đóng lẻ), theo thứ tự gửi; lệnh mua và lệnh bán ngoài kịch bản được nhận. */
    class SellScriptGateway extends FakeGateway {
      sells: ({ code: string; message: string | null } | null)[] = [];
      override async submit(
        a: AccountRef,
        list: readonly OrderIntent[],
        fence: Fence,
        rate?: number,
      ): Promise<SubmitResult[]> {
        const out: SubmitResult[] = [];
        for (const o of list) {
          const step = o.side === "sell" ? this.sells.shift() : undefined;
          if (step !== null && step !== undefined) {
            this.received.push(o);
            out.push({ clOrdID: o.clOrdID, outcome: "rejected", ...step });
          } else out.push(...(await super.submit(a, [o], fence, rate)));
        }
        return out;
      }
    }
    const dustCloses = (gw: FakeGateway) =>
      gw.received.filter((o) => o.tag.endsWith(":dust:close"));
    const closedLines = async (botId: string) => {
      const { eq } = await import("drizzle-orm");
      const events = await db.select().from(botEvents).where(eq(botEvents.botId, botId));
      return events.filter((x) => x.decision?.startsWith("Closed a small leftover") === true);
    };

    /** Bot đang giữ long 0.0031 ETH (bid đầu khớp một phần); trả lệnh bán kế tiếp đã gửi. */
    async function dustLong(gw: SellScriptGateway, id: string) {
      const { botId, accountId } = await seedBot("running", eth);
      const e = ethEngine(gw, id);
      await e.tick();
      await e.onPrice("ETH-USD", "1840", clock);
      const bid = gw.received.find((o) => o.side === "buy");
      expect(bid?.quantity).toBe("0.0108");
      clock += 100;
      await e.onFill(accountId, bid?.clOrdID ?? "", "0.0031", "1839.8", "0", clock);
      gw.perpsPositions.set("ETH-USD", { size: "0.0031", entryPrice: "1839.8" });
      return { botId, accountId, e };
    }

    it("closes 0.0031 ETH with one reduce-only market IOC after a margin reject, then quotes both sides", async () => {
      await stopAll();
      const gw = new SellScriptGateway();
      const { botId, accountId, e } = await dustLong(gw, "w-dust-1");
      const before = gw.received.length;
      // Lần làm mới kế tiếp: ask (0.0108, không reduce-only) bị từ chối vì thiếu margin; lệnh đóng lẻ được nhận.
      gw.sells = [MARGIN];
      await ethStep(e);
      const sent = gw.received.slice(before);
      const ask = sent.find((o) => o.side === "sell" && o.tag.endsWith(":ask"));
      expect(ask).toMatchObject({ quantity: "0.0108", reduceOnly: false });
      const closes = dustCloses(gw);
      expect(closes).toHaveLength(1);
      expect(closes[0]).toMatchObject({
        side: "sell",
        type: "market",
        timeInForce: "IOC",
        reduceOnly: true,
        quantity: "0.0031",
        market: "ETH-USD",
      });
      // Còn chờ kết quả: không gửi lệnh đóng thứ hai, không đặt lệnh bán nào.
      const pending = gw.received.length;
      await ethStep(e, 3);
      expect(dustCloses(gw)).toHaveLength(1);
      expect(gw.received.slice(pending).filter((o) => o.side === "sell")).toHaveLength(0);

      // SoDEX khớp lệnh đóng: vị thế về 0, ghi Decisions, rồi báo giá hai phía như bình thường.
      clock += 100;
      await e.onFill(accountId, closes[0]?.clOrdID ?? "", "0.0031", "1839.5", "0", clock);
      gw.perpsPositions.delete("ETH-USD");
      const lines = await closedLines(botId);
      expect(lines.map((x) => x.decision)).toEqual([
        "Closed a small leftover position of 0.0031 ETH at market (below the SoDEX minimum), so quoting can continue.",
      ]);
      const filled = gw.received.length;
      await ethStep(e, 2);
      const next = gw.received.slice(filled);
      expect(next.some((o) => o.side === "buy" && o.quantity === "0.0108")).toBe(true);
      expect(next.some((o) => o.side === "sell" && o.quantity === "0.0108" && !o.reduceOnly)).toBe(
        true,
      );
      expect(dustCloses(gw)).toHaveLength(1);
      expect((await botState(botId))?.state).toBe("running");
      await e.stop();
      await stopAll();
    });

    it("holds the sell and does not loop when SoDEX rejects the dust close", async () => {
      await stopAll();
      const gw = new SellScriptGateway();
      const { botId, e } = await dustLong(gw, "w-dust-2");
      const before = gw.received.length;
      // ask bị từ chối vì thiếu margin, lệnh đóng lẻ bị từ chối; các lệnh bán sau (nếu có) cũng bị từ chối.
      gw.sells = [MARGIN, { code: "-1", message: "position not found" }, MARGIN, MARGIN, MARGIN];
      await ethStep(e);
      expect(dustCloses(gw)).toHaveLength(1);
      await ethStep(e, 10);
      const sells = gw.received.slice(before).filter((o) => o.side === "sell");
      // Chỉ ask đầu và một lệnh đóng lẻ; sau đó không gửi lại gì ở phía bán, bid vẫn báo giá.
      expect(sells).toHaveLength(2);
      expect(dustCloses(gw)).toHaveLength(1);
      expect(gw.received.slice(before).filter((o) => o.side === "buy").length).toBeGreaterThan(1);
      expect(await closedLines(botId)).toHaveLength(0);
      // Hai lần từ chối không đủ ngưỡng pause margin / reduce-only: bot vẫn chạy.
      expect((await botState(botId))?.state).toBe("running");
      await e.stop();
      await stopAll();
    });
  });
});

describe("shard leases renew on their own timer (DEC-TBD-engine-lease-renew)", () => {
  /** Gateway giả có `builderApproved` chậm (giả một vòng tick chậm hơn TTL của lease). */
  class SlowFeeGateway extends FakeGateway {
    slowOnceMs = 0;
    override builderApproved(): Promise<boolean> {
      const ms = this.slowOnceMs;
      this.slowOnceMs = 0;
      return new Promise((r) => {
        setTimeout(() => {
          r(this.approved);
        }, ms);
      });
    }
  }
  const lines: { msg: string; obj: Record<string, unknown> }[] = [];
  const capture = {
    info: (obj: unknown, msg?: string) => lines.push({ msg: msg ?? "", obj: obj as never }),
    warn: (obj: unknown, msg?: string) => lines.push({ msg: msg ?? "", obj: obj as never }),
    error: (obj: unknown, msg?: string) => lines.push({ msg: msg ?? "", obj: obj as never }),
  };
  const setup = (gw: Gateway, workerId: string) => {
    let loads = 0;
    const redis = newRedis();
    const e = new Engine({
      db,
      redis,
      gateway: gw,
      workerId,
      log: capture as never,
      now,
      leaseTtlMs: 300,
      shards: SHARDS,
      // `rules` chỉ được gọi khi nạp runner: đếm số lần nạp lại bot.
      rules: () => {
        loads += 1;
        return Promise.resolve(rules);
      },
      feeCheckMs: 0,
    });
    return { e, redis, loads: () => loads };
  };
  const epochInDb = async (shard: number) => {
    const { eq } = await import("drizzle-orm");
    const [row] = await db.select().from(shardEpochs).where(eq(shardEpochs.shard, shard));
    return row?.epoch;
  };
  const until = async (done: () => boolean, ms = 3_000) => {
    for (let t = 0; t < ms && !done(); t += 20) await new Promise((r) => setTimeout(r, 20));
    expect(done()).toBe(true);
  };
  beforeEach(() => {
    lines.length = 0;
  });

  it("keeps every shard, its epoch and its bots through a tick slower than the lease TTL", async () => {
    const gw = new SlowFeeGateway();
    const { accountId } = await seedBot("running");
    const shard = shardOf(accountId, SHARDS);
    const { e, loads } = setup(gw, "slow-tick");
    await e.tick();
    const owned = e.ownedShards;
    const epoch = e.epochOf(shard);
    const loaded = loads();
    expect(loaded).toBeGreaterThan(0);
    // Một vòng mất 0.8 s, gần 3 lần TTL 300 ms: trước đây lease hết hạn giữa vòng, vòng sau bỏ mọi shard, nhận lại với
    // epoch + 1 và nạp lại mọi bot.
    gw.slowOnceMs = 800;
    clock += 1;
    await e.tick();
    clock += 1;
    await e.tick();
    expect(e.ownedShards).toEqual(owned);
    expect(e.epochOf(shard)).toBe(epoch);
    expect(await epochInDb(shard)).toBe(epoch);
    expect(loads()).toBe(loaded);
    expect(lines.filter((l) => l.msg === "shard lost")).toEqual([]);
    const slow = lines.find((l) => l.msg === "tick slow");
    expect(typeof (slow?.obj.phases as Record<string, unknown> | undefined)?.checkFees).toBe(
      "number",
    );
    await e.stop();
  });

  it("takes back its own expired lease without a new epoch or reloading bots when no one else took the shard", async () => {
    const gw = new FakeGateway();
    const { accountId } = await seedBot("running");
    const shard = shardOf(accountId, SHARDS);
    const { e, redis, loads } = setup(gw, "self-reacquire");
    await e.tick();
    const epoch = e.epochOf(shard);
    const loaded = loads();
    // Key lease biến mất trên Redis (hết hạn khi timer bị trễ, Redis khởi động lại…).
    await redis.del(`lease:shard:${String(shard)}`);
    await until(() => lines.some((l) => l.msg === "shard lease re-acquired; epoch and bots kept"));
    expect(await redis.get(`lease:shard:${String(shard)}`)).not.toBeNull();
    clock += 1;
    await e.tick();
    expect(e.ownedShards).toContain(shard);
    expect(e.epochOf(shard)).toBe(epoch);
    expect(await epochInDb(shard)).toBe(epoch);
    expect(loads()).toBe(loaded);
    expect(lines.filter((l) => l.msg === "shard lost")).toEqual([]);
    await e.stop();
  });

  it("drops the shard and reloads its bots with a new epoch when another worker had it in between", async () => {
    const { eq } = await import("drizzle-orm");
    const gw = new FakeGateway();
    const { accountId } = await seedBot("running");
    const shard = shardOf(accountId, SHARDS);
    const { e, redis, loads } = setup(gw, "epoch-moved");
    await e.tick();
    const epoch = e.epochOf(shard) ?? 0;
    const loaded = loads();
    // Worker khác đã nhận shard (epoch + 1) rồi trả, trong lúc lease của mình hết hạn.
    await db
      .update(shardEpochs)
      .set({ epoch: epoch + 1, owner: "other" })
      .where(eq(shardEpochs.shard, shard));
    await redis.del(`lease:shard:${String(shard)}`);
    await until(() => lines.some((l) => l.msg === "shard lost"));
    expect(lines.find((l) => l.msg === "shard lost")?.obj).toMatchObject({
      shard,
      reason: "epoch_moved",
    });
    expect(e.ownedShards).not.toContain(shard);
    // Như trước: vòng sau nhận lại shard với epoch mới và nạp lại bot.
    clock += 1;
    await e.tick();
    expect(e.epochOf(shard)).toBe(epoch + 2);
    expect(loads()).toBeGreaterThan(loaded);
    await e.stop();
  });

  it("drops the shard when another worker holds the lease, and sends nothing for it", async () => {
    const gw = new FakeGateway();
    const { botId, accountId } = await seedBot("running");
    const shard = shardOf(accountId, SHARDS);
    const { e, redis } = setup(gw, "taken");
    await e.tick();
    await redis.set(`lease:shard:${String(shard)}`, "another-worker", "PX", 30_000);
    await until(() => lines.some((l) => l.msg === "shard lost"));
    expect(lines.find((l) => l.msg === "shard lost")?.obj).toMatchObject({
      shard,
      reason: "taken",
    });
    expect(e.ownedShards).not.toContain(shard);
    await e.onPrice("vBTC_vUSDC", "100", clock);
    const { eq } = await import("drizzle-orm");
    expect(await db.select().from(orders).where(eq(orders.botId, botId))).toHaveLength(0);
    await e.stop();
  });

  it("sends no order while the shard's lease can't be confirmed", async () => {
    const gw = new FakeGateway();
    const { botId, accountId } = await seedBot("running");
    const shard = shardOf(accountId, SHARDS);
    let mono = 0;
    const redis = newRedis();
    const e = new Engine({
      db,
      redis,
      gateway: gw,
      workerId: "expired",
      log: capture as never,
      now,
      leaseTtlMs: 60_000,
      shards: SHARDS,
      rules: () => Promise.resolve(rules),
      feeCheckMs: 0,
      monotonic: () => mono,
    });
    await e.tick();
    // Đồng hồ đơn điệu vượt hạn lease, Redis không trả lời: không được ghi / gửi lệnh nào.
    mono = 120_000;
    redis.disconnect();
    await e.onPrice("vBTC_vUSDC", "100", clock);
    expect(gw.received).toHaveLength(0);
    const { eq } = await import("drizzle-orm");
    expect(await db.select().from(orders).where(eq(orders.botId, botId))).toHaveLength(0);
    expect(e.ownedShards).toContain(shard);
    e.kill();
  });
});
