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
  schema,
  shardEpochs,
  sodexAccounts,
  userBuilderFees,
  users,
  insertNewsSignal,
  newsSignalDeliveries,
  newsSignalTrades,
  signalBotVersions,
  type Db,
} from "@drift/db";
import { AppError, baselineVersionConfig, dec, ErrorCode, ReasonCode } from "@drift/shared";
import type { MmOrderContext } from "@drift/shared/mm-quote";
import type { SignedWriteClient, SodexRestClient } from "@drift/sodex";
import {
  clOrdId,
  runBacktest,
  seededRandom,
  spotGrid,
  spotGridSchema,
  STRATEGIES,
  type OrderIntent,
} from "@drift/strategies";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { drizzle } from "drizzle-orm/node-postgres";
import { Redis } from "ioredis";
import { GenericContainer, type StartedTestContainer } from "testcontainers";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  Engine as RealEngine,
  CANCEL_REQUEST_BACKOFF_MS,
  CLOSE_RETRY,
  LOOKUP_BUDGET,
  LOOKUP_WEIGHT,
  STREAM_HOLD_MS,
  TRADES_WEIGHT,
  FencedError,
  GAVE_UP_RETRY_MS,
  LeaseExpiredError,
  effectiveReal,
  opensPosition,
  shardOf,
  unknownGaveUpWhy,
  type EngineDeps,
} from "../src/engine";
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
  ReadOptions,
  SubmitResult,
} from "../src/gateway";
import { HttpGateway } from "../src/http-gateway";
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
  cancelOutcome: "ok" | "unknown" | "not_found" | "rejected" = "ok";
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
    return Promise.resolve(
      list.map((o): CancelResult =>
        outcome === "rejected"
          ? { clOrdID: o.clOrdID, outcome, code: "-2" }
          : { clOrdID: o.clOrdID, outcome },
      ),
    );
  }
  /** Vị thế Perps trên "SoDEX" theo market (readPositions). */
  readonly perpsPositions = new Map<string, { size: string; entryPrice: string }>();
  /** Account (id trong DB) của mỗi lần đọc account state. */
  readonly readsBy: string[] = [];
  /** Giả SoDEX lỗi khi đọc account state (ví dụ hết rate limit). */
  positionError: Error | null = null;
  /** Mỗi lần đọc account state: có phải lần đọc khẩn (mức thường, không bị phần dự trữ chặn) hay không. */
  readonly positionReadsUrgent: boolean[] = [];
  /** Số lần đọc account state kế tiếp sẽ lỗi `positionError` (null = mọi lần, khi `positionError` có). */
  positionErrorTimes: number | null = null;
  readPositions(
    a: AccountRef,
    opts?: ReadOptions,
  ): Promise<Map<string, { size: string; entryPrice: string }>> {
    this.readsBy.push(a.id);
    this.positionReadsUrgent.push(opts?.urgent === true);
    if (this.positionError !== null && this.positionErrorTimes !== 0) {
      if (this.positionErrorTimes !== null) this.positionErrorTimes -= 1;
      return Promise.reject(this.positionError);
    }
    return Promise.resolve(new Map(this.perpsPositions));
  }
  recentTradesCalls = 0;
  /** Account (id trong DB) của mỗi lần đọc lịch sử khớp. */
  readonly recentTradesBy: string[] = [];
  recentTrades(a: AccountRef): Promise<(OrderTrade & { clOrdID: string })[]> {
    this.recentTradesCalls += 1;
    this.recentTradesBy.push(a.id);
    return Promise.resolve(
      [...this.trades].flatMap(([clOrdID, list]) => list.map((t) => ({ ...t, clOrdID }))),
    );
  }
  /** Giả SoDEX / mạng lỗi khi tra lệnh (HttpGateway.lookup ném lỗi). */
  lookupError: Error | null = null;
  /** Gọi mỗi lần tra một lệnh (mô phỏng việc xảy ra trên SoDEX đúng lúc tra). */
  onLookup: ((clOrdID: string) => void) | null = null;
  /** Mỗi lần tra: clOrdID và có phải lần tra khẩn (lệnh đã gửi huỷ chưa được xác nhận) hay không. */
  readonly lookups: { clOrdID: string; urgent: boolean }[] = [];
  lookup(_a: AccountRef, o: { clOrdID: string }, opts?: ReadOptions): Promise<LookupResult> {
    this.lookups.push({ clOrdID: o.clOrdID, urgent: opts?.urgent === true });
    this.onLookup?.(o.clOrdID);
    if (this.lookupError !== null) return Promise.reject(this.lookupError);
    return Promise.resolve(this.book.get(o.clOrdID) ?? { status: "not_found" });
  }
  readonly trades = new Map<string, OrderTrade[]>();
  /** clOrdID của mọi lần đọc trade theo lệnh. */
  readonly tradesOfCalls: string[] = [];
  tradesOf(_a: AccountRef, o: { clOrdID: string }): Promise<OrderTrade[]> {
    this.tradesOfCalls.push(o.clOrdID);
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

// Lease được gia hạn bằng timer riêng (DEC-302): engine của test trước mà quên `stop()` sẽ tiếp tục
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
/** Sự cố báo team của một bot (outbox `jobs.team_ops`, type team_incident, #241), cũ nhất trước. */
const teamIncidents = async (botId: string) => {
  const { sql, asc } = await import("drizzle-orm");
  return (
    await db
      .select({ payload: outbox.payload })
      .from(outbox)
      .where(
        sql`${outbox.topic} = 'jobs.team_ops' and ${outbox.payload}->>'type' = 'team_incident' and ${outbox.payload}->>'botId' = ${botId}`,
      )
      .orderBy(asc(outbox.createdAt), asc(outbox.id))
  ).map((r) => r.payload as { kind: string; market?: string; detail: string });
};
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
  await Promise.all(cleanPools.map((p) => p.end()));
  await pool.end();
  await Promise.all([pg.stop(), redisC.stop()]);
});
beforeEach(async () => {
  await newRedis().flushall();
});

let clock = 1_790_000_000_000;
const now = () => clock;

const cleanPools: ReturnType<typeof createDb>["pool"][] = [];
/**
 * Database riêng, sạch, cùng container (#225). DB chung của file giữ bot / lệnh của mọi test trước: engine của một test nạp
 * lại mọi bot còn `running` của shard nó giữ và cho chúng ăn từng giá, nên test nặng chậm dần theo vị trí trong file.
 */
async function cleanDb(name: string): Promise<Db> {
  const admin = createDb(pg.getConnectionUri());
  await admin.pool.query(`CREATE DATABASE ${name}`);
  await admin.pool.end();
  const url = pg.getConnectionUri().replace(/\/[^/?]+(\?|$)/, `/${name}$1`);
  await runMigrations(url);
  const clean = createDb(url);
  cleanPools.push(clean.pool);
  return clean.db;
}
/**
 * Cho cả describe chạy trên một DB sạch riêng (#225): mọi helper (`seedBot`, `makeEngine`, `botState`…) đọc `db` lúc được
 * gọi nên dùng DB này; hết describe thì trả lại DB chung. Test trong file chạy tuần tự nên đổi `db` là an toàn. Migration
 * chạy trong hook, không tính vào thời gian của test.
 */
function useCleanDb(name: string): void {
  let shared: Db;
  beforeAll(async () => {
    shared = db;
    db = await cleanDb(name);
  });
  afterAll(() => {
    db = shared;
  });
}

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
  /** Database (mặc định DB chung của file test). */
  into: Db = db,
) {
  const [user] = await into
    .insert(users)
    .values({ email: `${String(Math.random())}@x.test` })
    .returning();
  const [account] = await into
    .insert(sodexAccounts)
    .values({
      userId: user?.id ?? "",
      address: "0x4E1e4796c10C637EDAB56461450BD8D02EFb29Db",
      sodexAccountId: BigInt(Math.floor(Math.random() * 1e9)),
      network: "mainnet",
      status: "connected",
    })
    .returning();
  await into.insert(apiKeys).values({
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
  const [bot] = await into
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
  const [version] = await into
    .insert(botVersions)
    .values({
      botId: bot?.id ?? "",
      version: 1,
      paramSource: "manual",
      status: "active",
      config: spec.config,
    })
    .returning();
  await into
    .update(bots)
    .set({ activeVersionId: version?.id ?? "" })
    .where((await import("drizzle-orm")).eq(bots.id, bot?.id ?? ""));
  return { botId: bot?.id ?? "", accountId: account?.id ?? "" };
}

// Lease dài (#225): trước đây 300 ms, nên khi máy bận (event loop / Redis trễ quá ~240 ms) lease không xác nhận lại kịp và
// engine bỏ lượt ("Shard N lease is not confirmed", không gửi lệnh). Test cần lease hết hạn thì điều khiển `monotonic`.
const makeEngine = (gateway: Gateway, workerId: string, monotonic?: () => number) =>
  new Engine({
    db,
    redis: newRedis(),
    gateway,
    workerId,
    log,
    now,
    leaseTtlMs: 30_000,
    shards: SHARDS,
    rules: () => Promise.resolve(rules),
    feeCheckMs: 0,
    ...(monotonic === undefined ? {} : { monotonic }),
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
    let monoA = 0;
    const a = makeEngine(gw, "A", () => monoA);
    await a.tick();
    await a.onPrice("vBTC_vUSDC", "100", clock);
    const epochA = a.epochOf(shard);
    const sentByA = gw.received.length;
    expect(sentByA).toBeGreaterThan(0);

    a.kill();
    // Mô phỏng A chết trước khi kịp lưu state: B phải chạy lại chiến lược từ đầu.
    await db.delete(botRuntime);
    // Lease của A hết hạn (không chờ timer thật, #225): key trên Redis mất, và đồng hồ đơn điệu của A đã qua hạn xác nhận.
    await newRedis().flushall();
    monoA += 1e9;
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
    // Zombie không phản ứng với thị trường nữa (shard không còn xác nhận được, DEC-302)…
    const before = gw.received.length;
    await a.onPrice("vBTC_vUSDC", "95", clock);
    expect(gw.received).toHaveLength(before);
    // …và ghi sổ (fill) của nó bị fencing ở DB từ chối.
    const first = gw.received[0];
    await expect(
      a.onFill(accountId, first?.clOrdID ?? "", "0.0001", "100", "0", clock),
    ).rejects.toBeInstanceOf(FencedError);
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

  it("stores a quote snapshot on a Market Making ask pulled by the Binance price (#230)", async () => {
    const { eq } = await import("drizzle-orm");
    const { mmQuoteSnapshotSchema } = await import("@drift/shared/mm-quote");
    const gw = new FakeGateway();
    const { botId } = await seedBot("running", mmSmart(true));
    const e = makeEngine(gw, "w-mm-quote-snap");
    await e.tick();
    await e.onPrice("BTC-USD", "100000", clock);
    const askOrder = gw.received.filter((o) => o.side === "sell").at(-1);
    expect(askOrder).toBeDefined();
    const fair = String(Number(askOrder?.price) + 5);
    await e.onMmFair({ s: "BTC-USD", fair, T: clock - 150, at: clock - 20 }, clock);
    const ev = (await db.select().from(botEvents).where(eq(botEvents.botId, botId))).find(
      (x) => x.type === "decision" && x.decision === "Ask pulled",
    );
    const payload = ev?.payload as { orders?: string[]; quote: unknown };
    // Bước rút lệnh không đặt lệnh nào: không có `orders`, chỉ snapshot.
    expect(payload.orders).toBeUndefined();
    const q = mmQuoteSnapshotSchema.parse(payload.quote);
    expect(q).toMatchObject({
      v: 1,
      reason: "pulled",
      sides: ["sell"],
      fair: { price: fair, ageMs: 150, used: true, clampBp: 0.5 },
      smart: { on: true },
      orders: [
        {
          id: askOrder?.clOrdID,
          side: "sell",
          role: "open",
          st: "pulled",
          price: askOrder?.price ?? null,
          size: askOrder?.quantity,
        },
      ],
    });
    expect(JSON.stringify(payload.quote).length).toBeLessThan(1024);
    await e.stop();
  });

  for (const smartQuoting of [true, false])
    it(`stores a placement context on every Market Making order with Smart quoting ${smartQuoting ? "on" : "off"} (#233)`, async () => {
      const { eq } = await import("drizzle-orm");
      const { mmOrderContextSchema } = await import("@drift/shared/mm-quote");
      const gw = new FakeGateway();
      const { botId } = await seedBot("running", mmSmart(smartQuoting));
      const e = makeEngine(gw, `w-mm-ctx-${String(smartQuoting)}`);
      await e.tick();
      await e.onPrice("BTC-USD", "100000", clock);
      const sent = gw.received.filter((o) => o.market === "BTC-USD");
      expect(sent.length).toBeGreaterThanOrEqual(2);
      // Gateway (SoDEX) không bao giờ nhận bối cảnh.
      for (const o of sent) expect(o).not.toHaveProperty("context");
      const rows = await db.select().from(orders).where(eq(orders.botId, botId));
      expect(rows.length).toBeGreaterThanOrEqual(2);
      for (const row of rows) {
        const ctx = mmOrderContextSchema.parse(row.context);
        expect(ctx).toMatchObject({ v: 2, reason: "first", smart: smartQuoting, pos: "0" });
        expect(ctx.bp).not.toBeNull();
        expect(JSON.stringify(row.context).length).toBeLessThan(320);
      }
      await e.stop();
    });

  it("stores a null context when the strategy's context is malformed, and still sends the order (#229)", async () => {
    const { eq } = await import("drizzle-orm");
    const mod = STRATEGIES.volume_maker.module;
    const real = mod.step.bind(mod);
    // Chiến lược trả bối cảnh sai schema (v lạ, thiếu field) trên mọi lệnh đặt. Cố ý ép kiểu: mô phỏng chiến lược lỗi.
    const malformed = { v: 99, reason: "nope", pos: 1 } as unknown as MmOrderContext;
    const spy = vi.spyOn(mod, "step").mockImplementation((config, state, event, ctx) => {
      const r = real(config, state, event, ctx);
      return {
        ...r,
        actions: r.actions.map((a) => (a.type === "place" ? { ...a, context: malformed } : a)),
      };
    });
    try {
      const gw = new FakeGateway();
      const { botId } = await seedBot("running", mmSmart(true));
      const e = makeEngine(gw, "w-mm-ctx-bad");
      await e.tick();
      await e.onPrice("BTC-USD", "100000", clock);
      expect(spy).toHaveBeenCalled();
      const sent = gw.received.filter((o) => o.market === "BTC-USD");
      expect(sent.length).toBeGreaterThanOrEqual(2);
      for (const o of sent) expect(o).not.toHaveProperty("context");
      const rows = await db.select().from(orders).where(eq(orders.botId, botId));
      expect(rows.length).toBe(sent.length);
      for (const row of rows) expect(row.context).toBeNull();
      await e.stop();
    } finally {
      spy.mockRestore();
    }
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
    const { botId, accountId } = await seedBot("running");
    const e = makeEngine(gw, "w1");
    await e.tick();
    await e.onPrice("vBTC_vUSDC", "100", clock);
    // Lệnh market khởi tạo hết hạn không khớp: v1 phẳng. Còn đang chạy thì version mới chờ nó (#223).
    const init = gw.received.find((o) => o.tag === "grid:init")?.clOrdID ?? "";
    await e.onOrderClosed(accountId, init, "cancelled", clock + 1);
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

  it("reads leverage back on reload and only re-sets / re-logs it when SoDEX differs or the version changes", async () => {
    const { eq, and } = await import("drizzle-orm");
    const gw = new FakeGateway();
    // Market riêng: bot của test khác cùng DB không đổi thiết lập đòn bẩy giả của market này.
    const { botId, accountId } = await seedBot("starting", {
      ...futuresGrid,
      market: "LEV-USD",
      config: { ...futuresGrid.config, market: "LEV-USD", leverage: 17 },
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
    await a.onPrice("LEV-USD", "100", clock);
    expect(mine()).toHaveLength(1);
    expect(await logged()).toBe(1);
    await a.stop();
    // Runner được nạp lại (chuyển shard / khởi động lại); SoDEX vẫn 17×: đọc lại, không gửi, không ghi thêm dòng.
    const b = makeEngine(gw, "lev-b");
    await b.tick();
    expect(b.ownedShards).toContain(shardOf(accountId, SHARDS));
    await b.onPrice("LEV-USD", "101", clock);
    expect(mine()).toHaveLength(1);
    expect(await logged()).toBe(1);
    // Lệnh market khởi tạo hết hạn không khớp, để version mới không phải chờ nó (#223).
    const init = gw.received.find((o) => o.tag === "grid:init" && o.market === "LEV-USD");
    await b.onOrderClosed(accountId, init?.clOrdID ?? "", "cancelled", clock);
    // Version mới (đòn bẩy khác) vẫn đặt lại như trước.
    const [v2] = await db
      .insert(botVersions)
      .values({
        botId,
        version: 2,
        paramSource: "manual",
        status: "pending",
        config: { ...futuresGrid.config, market: "LEV-USD", leverage: 13 },
      })
      .returning();
    expect(v2).toBeDefined();
    clock += 1;
    await b.tick();
    await b.onPrice("LEV-USD", "100", clock);
    expect(mine().map((l) => l.leverage)).toEqual([17, 13]);
    expect(await logged()).toBe(2);
    await b.stop();
    // Ai đó đổi đòn bẩy trên SoDEX trong lúc chuyển shard: nạp lại phải đọc thấy và đặt lại (không tin bản đã lưu).
    gw.settings.set("LEV-USD", { leverage: 5, marginMode: "cross" });
    const c = makeEngine(gw, "lev-c");
    await c.tick();
    clock += 1;
    await c.onPrice("LEV-USD", "100", clock);
    expect(mine().map((l) => l.leverage)).toEqual([17, 13, 13]);
    expect(await logged()).toBe(3);
    await c.stop();
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
    // Báo team một lần qua pauseAccount (#241).
    expect(await teamIncidents(botId)).toEqual([
      {
        type: "team_incident",
        kind: "paused_errors",
        botId,
        market: "vBTC_vUSDC",
        detail: "API_KEY_UNUSABLE",
      },
    ]);
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

  describe("backtest parity", () => {
    // DB sạch (#225): ở DB chung, mọi bot spot grid còn `running` của test trước cũng nhận từng giá của test này (cả file
    // quá 30 s, chạy riêng ~7–10 s).
    useCleanDb("backtest_parity");

    const MIN = 60_000;
    /** Spot grid chạy backtest trên 56 nến; trả về kết quả và chuỗi lệnh dạng "tag side price qty". */
    const gridBacktest = () => {
      // 56 nến, sóng chu kỳ ~19 nến: đúng 16 lệnh như bản cũ 160 nến chu kỳ ~57 nến (mỗi mức giữa khớp hai chiều nhiều
      // vòng), nhưng ~230 event thay vì ~650 (#225). Mỗi nến giá đi tối đa ~3 < khoảng lưới 5, nên vẫn qua từng mức một.
      const candles = Array.from({ length: 56 }, (_, i) => {
        const p = 100 + 9 * Math.sin(i / 3);
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
      return { bt, btOrders };
    };

    it("produces the same order sequence as the backtest on the same candles (BACKTEST.md 11.2)", async () => {
      const { bt, btOrders } = gridBacktest();
      expect(bt.fills.length).toBeGreaterThan(4);
      expect(btOrders).toHaveLength(16);

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

    it("gives the same orders when SoDEX fills each grid order in 3 trades (#261)", async () => {
      // Chuỗi fill dựng tay: mỗi fill của backtest tách thành 3 trade (30%, 30%, phần còn lại), SoDEX báo khối lượng luỹ
      // kế. Lệnh đối ứng chỉ đặt khi khớp hết và bằng tổng: chuỗi lệnh của engine phải y như backtest khớp một lần.
      const { bt, btOrders } = gridBacktest();
      expect(btOrders).toHaveLength(16);
      const { eq } = await import("drizzle-orm");
      const gw = new FakeGateway();
      const { botId, accountId } = await seedBot("running");
      const e = makeEngine(gw, "w1");
      await e.tick();
      const tagOf = new Map(
        bt.actions.flatMap((a) =>
          a.type === "place" ? [[a.order.clOrdID, a.order.tag] as const] : [],
        ),
      );
      let trades = 0;
      let early = 0;
      for (const ev of bt.events) {
        if (ev.type === "tick") await e.onPrice(ev.market, ev.price, ev.at);
        if (ev.type === "fill") {
          const tag = tagOf.get(ev.clOrdID);
          const mine = [...gw.received].reverse().find((o) => o.tag === tag);
          if (mine === undefined) continue;
          const q = dec(ev.quantity);
          // Lệnh market mở vị thế ban đầu khớp một lần như cũ; lệnh mức khớp 3 lần.
          const totals =
            mine.type === "market"
              ? [q]
              : [q.mul("0.3").toDecimalPlaces(4), q.mul("0.6").toDecimalPlaces(4), q];
          for (const total of totals) {
            const sent = gw.received.length;
            await e.onFill(accountId, mine.clOrdID, total.toString(), ev.price, "0", ev.at);
            trades += 1;
            // Trade chưa khớp hết: chưa có lệnh đối ứng nào.
            if (!total.eq(q) && gw.received.length !== sent) early += 1;
          }
        }
      }
      expect(trades).toBeGreaterThan(bt.fills.length);
      expect(early).toBe(0);
      const engineOrders = gw.received.map(
        (o) => `${o.tag} ${o.side} ${o.price ?? "mkt"} ${o.quantity}`,
      );
      expect(engineOrders).toEqual(btOrders);
      // Mọi trade vào sổ cái: vị thế của engine bằng vị thế của backtest.
      const [rt] = await db.select().from(botRuntime).where(eq(botRuntime.botId, botId));
      expect((rt?.state as { ledger: { position: string } }).ledger.position).toBe(
        (bt.state as { ledger: { position: string } }).ledger.position,
      );
      await e.stop();
    });

    it("books both partial fills of a grid order across an engine restart, then places one counter order (#261)", async () => {
      const { eq } = await import("drizzle-orm");
      const gw = new FakeGateway();
      const { botId, accountId } = await seedBot("running");
      const a = makeEngine(gw, "w-261");
      await a.tick();
      await a.onPrice("vBTC_vUSDC", "100", clock);
      const buy95 = gw.received.find((o) => o.side === "buy" && o.price === "95");
      expect(buy95?.quantity).toBe("1");
      const id = buy95?.clOrdID ?? "";
      await a.onFill(accountId, id, "0.4", "95", "0", clock);
      const sent = gw.received.length;
      // Engine khởi động lại giữa hai lần khớp: chiến lược nạp lại state từ DB.
      await a.stop();
      const b = makeEngine(gw, "w-261");
      await b.tick();
      await b.onFill(accountId, id, "1", "95", "0", clock + 1);
      const after = gw.received.slice(sent);
      expect(after.map((o) => `${o.tag} ${o.side} ${o.price ?? "mkt"} ${o.quantity}`)).toEqual([
        "grid:2:sell sell 100 1",
      ]);
      const [rt] = await db.select().from(botRuntime).where(eq(botRuntime.botId, botId));
      const state = rt?.state as { ledger: { position: string }; open: Record<string, unknown> };
      expect(state.ledger.position).toBe("1");
      expect(state.open[id]).toBeUndefined();
      await b.stop();
    });

    it("books a trade that arrives after SoDEX ended a partly filled grid order, across a restart, once (#426)", async () => {
      const { eq } = await import("drizzle-orm");
      const gw = new FakeGateway();
      const { botId, accountId } = await seedBot("running");
      const a = makeEngine(gw, "w-426");
      await a.tick();
      await a.onPrice("vBTC_vUSDC", "100", clock);
      const buy95 = gw.received.find((o) => o.side === "buy" && o.price === "95");
      const id = buy95?.clOrdID ?? "";
      // Khớp 0.4 rồi SoDEX báo lệnh đã huỷ (xác nhận huỷ): đối ứng cho 0.4.
      await a.onFill(accountId, id, "0.4", "95", "0", clock);
      let sent = gw.received.length;
      await a.onOrderClosed(accountId, id, "cancelled", clock + 1);
      const show = (o: OrderIntent) => `${o.tag} ${o.side} ${o.price ?? "mkt"} ${o.quantity}`;
      expect(gw.received.slice(sent).map(show)).toEqual(["grid:2:sell sell 100 0.4"]);
      // Engine khởi động lại giữa lúc lệnh kết thúc và trade tới muộn.
      await a.stop();
      const b = makeEngine(gw, "w-426");
      await b.tick();
      sent = gw.received.length;
      // Trade tới muộn (đối soát, DEC-303): SoDEX báo khối lượng luỹ kế 0.6.
      await b.onFill(accountId, id, "0.6", "95", "0", clock + 2);
      expect(gw.received.slice(sent).map(show)).toEqual(["grid:2:sell sell 100 0.2"]);
      // Báo lại cùng trade: không ghi trùng, không đặt thêm lệnh.
      sent = gw.received.length;
      await b.onFill(accountId, id, "0.6", "95", "0", clock + 3);
      expect(gw.received.length).toBe(sent);
      const [rt] = await db.select().from(botRuntime).where(eq(botRuntime.botId, botId));
      // Vị thế sổ cái = vị thế SoDEX giả lập (0.4 + 0.2 đã mua; lệnh khởi tạo chưa khớp).
      expect((rt?.state as { ledger: { position: string } }).ledger.position).toBe("0.6");
      await b.stop();
    });
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

  it("stores a signal snapshot next to the orders of a Volume Farm entry (#221)", async () => {
    const { eq } = await import("drizzle-orm");
    const { vbSignalSnapshotSchema } = await import("@drift/shared/vb-signal");
    const gw = new FakeGateway();
    await seedCandles("ADA-USD");
    const { botId } = await seedFarm("ADA-USD");
    const e = farmEngine(gw, "snapshot");
    await tickUntil(e, () => gw.received.some((o) => o.tag.startsWith("vf:")));
    const entry = gw.received.find((o) => o.tag.startsWith("vf:"));
    expect(entry).toBeDefined();
    const ev = (await db.select().from(botEvents).where(eq(botEvents.botId, botId))).find(
      (x) => x.type === "decision" && /^Enter (long|short)$/.test(x.decision ?? ""),
    );
    const payload = ev?.payload as { orders: string[]; signal: unknown };
    expect(payload.orders).toEqual([entry?.clOrdID]);
    const snap = vbSignalSnapshotSchema.parse(payload.signal);
    expect(snap).toMatchObject({
      v: 1,
      side: ev?.decision === "Enter long" ? "long" : "short",
      reversed: false,
      balanced: false,
      price: { bid: "100", ask: "100.05", mid: "100.025", mark: null },
      order: {
        clOrdID: entry?.clOrdID,
        price: entry?.price ?? null,
        size: entry?.quantity,
        entryTry: 0,
      },
    });
    expect(JSON.stringify(payload.signal).length).toBeLessThan(1024);
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
    const entry = gw.received.find((o) => o.tag.startsWith("vf:"));
    const id = entry?.clOrdID ?? "";
    // Khối lượng lệnh vào ngẫu nhiên theo bot (order size 100–200 USDC): fill giả phải đúng khối lượng đó. Trước đây cố định
    // 1.5, nên khi lệnh lớn hơn 1.5 thì đó là khớp một phần và `cancelled` mới là kết quả đúng.
    const qty = entry?.quantity ?? "0";
    // Hết 10 s chưa nhận tin khớp: bot huỷ và tưởng chưa có vị thế.
    clock += 11_000;
    await e.tick();
    const row = async () => (await db.select().from(orders).where(eq(orders.clOrdId, id)))[0];
    expect((await row())?.status).toBe("cancelled");
    // Thật ra lệnh đã khớp trước lúc huỷ, tin khớp mất vì kết nối đứt.
    gw.book.set(id, { status: "filled", filledQty: qty, avgPrice: "100", orderId: 5n });
    gw.trades.set(id, [
      {
        tradeId: 7_000n + BigInt(Math.floor(Math.random() * 1e9)),
        price: "100",
        quantity: qty,
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
    expect(Number(st.ledger.position)).toBe(Number(qty));
    expect(st.phase).toBe("open");
    await e.stop();
    await stopFarmBots();
  });

  it("looks up a gap-suspect cancelled entry on time even when another account in the shard has many open orders (DEC-87, CI #216)", async () => {
    const { eq } = await import("drizzle-orm");
    const gw = new FakeGateway();
    await seedCandles("LTD-USD");
    const { accountId } = await seedFarm("LTD-USD");
    // Account khác cùng shard có nhiều lệnh còn mở chưa kiểm lần nào (bot đã dừng giữ lệnh), cũ hơn lệnh vào của bot này.
    const shard = shardOf(accountId, SHARDS);
    let other = await seedBot();
    while (shardOf(other.accountId, SHARDS) !== shard) {
      await db.update(bots).set({ state: "stopped" }).where(eq(bots.id, other.botId));
      other = await seedBot();
    }
    await db.update(bots).set({ state: "stopped" }).where(eq(bots.id, other.botId));
    await db.insert(orders).values(
      Array.from({ length: 60 }, (_, i) => ({
        botId: other.botId,
        sodexAccountId: other.accountId,
        clOrdId: `pad-${String(i)}-${String(Math.random())}`,
        market: "PAD-USD",
        engine: "perps" as const,
        side: "buy" as const,
        type: "limit" as const,
        price: "90",
        timeInForce: "GTC",
        size: "1",
        status: "open" as const,
        reduceOnly: false,
        epoch: 1,
        tag: "pad",
        submittedAt: new Date(clock - 60_000 - i),
      })),
    );
    const e = farmEngine(gw, "gap-busy");
    const mine = () => gw.received.find((o) => o.market === "LTD-USD" && o.tag.startsWith("vf:"));
    await tickUntil(e, () => mine() !== undefined);
    const entry = mine();
    const id = entry?.clOrdID ?? "";
    clock += 11_000;
    await e.tick();
    const row = async () => (await db.select().from(orders).where(eq(orders.clOrdId, id)))[0];
    expect((await row())?.status).toBe("cancelled");
    // Lịch sử lệnh của SoDEX có lệnh đã khớp; lịch sử khớp chưa có (trễ): chỉ đường tra lệnh tìm thấy được.
    gw.book.set(id, {
      status: "filled",
      filledQty: entry?.quantity ?? "0",
      avgPrice: "100",
      orderId: 5n,
    });
    e.onStreamGap(accountId);
    clock += 20_000;
    await e.tick();
    const after = await row();
    expect(after?.status).toBe("filled");
    expect(Number(after?.filledSize)).toBe(Number(entry?.quantity));
    await e.stop();
    await stopFarmBots();
    await db.update(orders).set({ status: "cancelled" }).where(eq(orders.botId, other.botId));
  });

  // ---------- #239: lệnh vào Volume Farm bị quên khi còn nằm trên sổ (DEC-317) ----------

  const farmState = async (botId: string) => {
    const { eq } = await import("drizzle-orm");
    const [rt] = await db.select().from(botRuntime).where(eq(botRuntime.botId, botId));
    return rt?.state as
      | {
          phase: string;
          ledger: { position: string };
          entry: { id: string } | null;
          orders: Record<string, { cancelAt?: number; done?: boolean }>;
        }
      | undefined;
  };
  const entriesOf = (gw: FakeGateway, market: string) =>
    gw.received.filter((o) => o.market === market && /^vf:\d+:in:/.test(o.tag));

  it("#239: a timed-out entry whose cancel never reached SoDEX stays tracked across a restart; no new entry; its late fill is booked", async () => {
    const gw = new FakeGateway();
    await seedCandles("ETC-USD");
    const { botId, accountId } = await seedFarm("ETC-USD");
    const e = farmEngine(gw, "orphan-a");
    await tickUntil(e, () => entriesOf(gw, "ETC-USD").length > 0);
    const entry = entriesOf(gw, "ETC-USD")[0];
    const id = entry?.clOrdID ?? "";
    // Mọi lệnh huỷ không rời DeskLabs (signer lỗi); lệnh vẫn nằm trên "SoDEX".
    gw.cancelNotSent = 1_000_000;
    clock += 11_000;
    await e.tick();
    expect((await farmState(botId))?.orders[id]?.cancelAt).toBeDefined();
    // Engine khởi động lại: danh sách chờ huỷ trong bộ nhớ mất (trước đây lệnh thành mồ côi ở đây).
    await e.stop();
    const e2 = farmEngine(gw, "orphan-a2");
    for (let i = 0; i < 12; i += 1) {
      clock += 5_000;
      await e2.tick();
    }
    // Không vào lượt mới trong lúc lệnh cũ chưa được xác nhận kết thúc; chiến lược vẫn huỷ lại nó.
    expect(entriesOf(gw, "ETC-USD").map((o) => o.clOrdID)).toEqual([id]);
    expect(1_000_000 - gw.cancelNotSent).toBeGreaterThanOrEqual(5);
    expect((await teamIncidents(botId)).map((x) => x.kind)).not.toContain("cancel_unconfirmed");
    // Quá 10 phút chưa xác nhận: báo team (critical) một lần, cùng Decisions + Needs attention.
    for (let i = 0; i < 20; i += 1) {
      clock += 30_000;
      await e2.tick();
    }
    const stuck = (await teamIncidents(botId)).filter((x) => x.kind === "cancel_unconfirmed");
    expect(stuck).toHaveLength(1);
    expect(stuck[0]?.detail).toContain(id);
    expect((await botState(botId))?.needsAttention).toBe(true);
    expect(entriesOf(gw, "ETC-USD")).toHaveLength(1);
    // Lệnh khớp muộn (prod: 10,5 phút sau): vào sổ cái, bot có vị thế và đặt stop trên SoDEX.
    gw.cancelNotSent = 0;
    await e2.onFill(accountId, id, entry?.quantity ?? "0", "100", "0.01", clock);
    const st = await farmState(botId);
    expect(Math.abs(Number(st?.ledger.position))).toBe(Number(entry?.quantity));
    expect(st?.phase).toBe("open");
    expect(gw.received.some((o) => o.market === "ETC-USD" && o.stop !== undefined)).toBe(true);
    expect(entriesOf(gw, "ETC-USD")).toHaveLength(1);
    await e2.stop();
    await stopFarmBots();
  });

  it("#239: enters again only after the cancel is confirmed, even without a CANCELED message from the stream", async () => {
    const { eq } = await import("drizzle-orm");
    const gw = new FakeGateway();
    await seedCandles("FIL-USD");
    const { botId } = await seedFarm("FIL-USD");
    const e = farmEngine(gw, "orphan-b");
    await tickUntil(e, () => entriesOf(gw, "FIL-USD").length > 0);
    const id = entriesOf(gw, "FIL-USD")[0]?.clOrdID ?? "";
    clock += 11_000;
    await e.tick();
    const row = async () => (await db.select().from(orders).where(eq(orders.clOrdId, id)))[0];
    // SoDEX trả ok cho lệnh huỷ, nhưng tin CANCELED của user stream không tới.
    expect((await row())?.status).toBe("cancelled");
    clock += 3_000;
    await e.tick();
    expect(entriesOf(gw, "FIL-USD")).toHaveLength(1);
    // Lần huỷ lại của chiến lược gặp dòng đã huỷ: engine báo kết thúc một lần, chiến lược vào lượt mới.
    for (let i = 0; i < 6 && entriesOf(gw, "FIL-USD").length < 2; i += 1) {
      clock += 3_000;
      await e.tick();
    }
    expect(entriesOf(gw, "FIL-USD")).toHaveLength(2);
    expect((await row())?.doneFedAt).not.toBeNull();
    expect((await farmState(botId))?.orders[id]?.done).toBe(true);
    await e.stop();
    await stopFarmBots();
  });

  it("looks up a cancel-pending order at write priority even when the lookup budget is used up (DEC-310 → DEC-317)", async () => {
    const gw = new FakeGateway();
    await seedCandles("UNI-USD");
    await seedFarm("UNI-USD");
    const e = new Engine({
      db,
      redis: newRedis(),
      gateway: gw,
      workerId: "orphan-c",
      log,
      now,
      leaseTtlMs: 30_000,
      shards: SHARDS,
      rules: () => Promise.resolve(rules),
      feeCheckMs: 0,
      orderbook: () =>
        Promise.resolve({ bid: "100", ask: "100.05", bidNotional: "50000", askNotional: "40000" }),
      // Ngân sách tra lệnh thường đã hết.
      lookupBudget: 0,
    });
    await tickUntil(e, () => entriesOf(gw, "UNI-USD").length > 0);
    const id = entriesOf(gw, "UNI-USD")[0]?.clOrdID ?? "";
    gw.cancelOutcome = "unknown";
    try {
      clock += 11_000;
      await e.tick();
      for (let i = 0; i < 4; i += 1) {
        clock += 5_000;
        await e.tick();
      }
      expect(gw.lookups.filter((l) => l.clOrdID === id)).toContainEqual({
        clOrdID: id,
        urgent: true,
      });
      expect(gw.lookups.filter((l) => l.clOrdID === id && !l.urgent)).toEqual([]);
    } finally {
      gw.cancelOutcome = "ok";
      await e.stop();
      await stopFarmBots();
    }
  });

  it("does not record a cancel SoDEX refused for that one order as cancelled; reads the order's real status (DEC-317)", async () => {
    const { eq } = await import("drizzle-orm");
    const gw = new FakeGateway();
    await seedCandles("SUI-USD");
    const { botId } = await seedFarm("SUI-USD");
    const e = farmEngine(gw, "orphan-f");
    await tickUntil(e, () => entriesOf(gw, "SUI-USD").length > 0);
    const entry = entriesOf(gw, "SUI-USD")[0];
    const id = entry?.clOrdID ?? "";
    gw.cancelOutcome = "rejected";
    try {
      clock += 11_000;
      await e.tick();
      const row = async () => (await db.select().from(orders).where(eq(orders.clOrdId, id)))[0];
      // Trước đây: `cancelled` ngay, không ai tra lại, lệnh còn sống trên sổ.
      expect((await row())?.status).toBe("open");
      // Lệnh thật ra vẫn nằm sổ rồi khớp: lần tra kế tiếp ghi fill thật, bot có vị thế, không vào thêm.
      gw.book.set(id, {
        status: "filled",
        filledQty: entry?.quantity ?? "0",
        avgPrice: "100",
        orderId: 9n,
      });
      for (let i = 0; i < 4 && (await row())?.status !== "filled"; i += 1) {
        clock += 5_000;
        await e.tick();
      }
      expect((await row())?.status).toBe("filled");
      expect(gw.lookups.some((l) => l.clOrdID === id)).toBe(true);
      const st = await farmState(botId);
      expect(Math.abs(Number(st?.ledger.position))).toBe(Number(entry?.quantity));
      expect(entriesOf(gw, "SUI-USD")).toHaveLength(1);
    } finally {
      gw.cancelOutcome = "ok";
      await e.stop();
      await stopFarmBots();
    }
  });

  /** Lệnh vào cũ đã khớp (fill có trong DB) mà state chiến lược không còn nhớ, như #239 trước bản sửa. */
  async function droppedFill(
    botId: string,
    accountId: string,
    market: string,
    size: string,
    /** Bot đã gửi một lệnh vào mới hơn trước khi lệnh này khớp (dấu hiệu bị bỏ qua của #239). */
    movedOn = true,
  ) {
    if (movedOn)
      await db.insert(orders).values({
        botId,
        sodexAccountId: accountId,
        clOrdId: `later-${String(Math.random())}`,
        market,
        engine: "perps",
        side: "buy",
        type: "limit",
        price: "100",
        timeInForce: "GTX",
        size: "1",
        status: "cancelled",
        reduceOnly: false,
        epoch: 1,
        tag: "vf:104:in:1",
        submittedAt: new Date(clock - 110_000),
        doneFedAt: new Date(clock - 105_000),
      });
    const [o] = await db
      .insert(orders)
      .values({
        botId,
        sodexAccountId: accountId,
        clOrdId: `dropped-${String(Math.random())}`,
        market,
        engine: "perps",
        side: "sell",
        type: "limit",
        price: "100",
        timeInForce: "GTX",
        size,
        filledSize: size,
        avgPrice: "100",
        status: "filled",
        reduceOnly: false,
        epoch: 1,
        tag: "vf:103:in:0",
        submittedAt: new Date(clock - 120_000),
        ackedAt: new Date(clock - 120_000),
        doneFedAt: new Date(clock - 100_000),
      })
      .returning();
    await db.insert(fills).values({
      orderId: o?.id ?? "",
      sodexTradeId: 90_000_000n + BigInt(Math.floor(Math.random() * 1e9)),
      price: "100",
      size,
      fee: "0.0115",
      isMaker: true,
      filledAt: new Date(clock - 100_000),
    });
    return o?.clOrdId ?? "";
  }
  const flagFarm = async (botId: string, market: string, real: string) => {
    const { eq } = await import("drizzle-orm");
    await db
      .update(bots)
      .set({
        positionMismatch: {
          [market]: { real, ledger: "0", since: new Date(clock).toISOString(), cause: "trades" },
        },
      })
      .where(eq(bots.id, botId));
  };

  it("repairs a flagged Volume Farm ledger on load from a dropped fill of its own order and manages it (#239, user approved 2026-11-18)", async () => {
    const gw = new FakeGateway();
    const { botId, accountId } = await seedFarm("APT-USD");
    const id = await droppedFill(botId, accountId, "APT-USD", "0.957");
    gw.perpsPositions.set("APT-USD", { size: "-0.957", entryPrice: "100" });
    await flagFarm(botId, "APT-USD", "-0.957");
    const e = farmEngine(gw, "orphan-d");
    for (let i = 0; i < 3 && (await farmState(botId))?.ledger.position !== "-0.957"; i += 1) {
      await e.tick();
      clock += 1_000;
    }
    const st = await farmState(botId);
    expect(st?.ledger.position).toBe("-0.957");
    expect(st?.phase).toBe("open");
    expect(st?.orders[id]).toMatchObject({ kind: "entry", side: "sell" });
    // Stop trên SoDEX cho vị thế nhận vào (lệnh mua reduce-only).
    expect(
      gw.received.some(
        (o) => o.market === "APT-USD" && o.stop !== undefined && o.side === "buy" && o.reduceOnly,
      ),
    ).toBe(true);
    const { eq } = await import("drizzle-orm");
    const events = await db.select().from(botEvents).where(eq(botEvents.botId, botId));
    expect(events.some((x) => x.decision === "Late fill added to the position")).toBe(true);
    // Báo team: nhận fill vào vị thế (critical) và sửa sổ cái (info, có clOrdID + khối lượng).
    const team = await teamIncidents(botId);
    expect(team.find((x) => x.kind === "late_fill_adopted")).toMatchObject({ market: "APT-USD" });
    expect(team.find((x) => x.kind === "ledger_repaired")?.detail).toContain(`${id} · sell 0.957`);
    // Hai lần kiểm tra khớp: cờ được bỏ như thường.
    for (let i = 0; i < 3; i += 1) {
      clock += 30_000;
      await e.tick();
    }
    expect((await botState(botId))?.positionMismatch).toBeNull();
    await e.stop();
    await stopFarmBots();
  });

  it("never adopts a mismatch that no single own order explains (manual trades stay alert-only, DEC-306)", async () => {
    const gw = new FakeGateway();
    const { botId, accountId } = await seedFarm("ARB-USD");
    await droppedFill(botId, accountId, "ARB-USD", "0.957");
    // SoDEX có thêm 0.5 không do lệnh nào của bot: không giải thích được bằng fill của bot.
    gw.perpsPositions.set("ARB-USD", { size: "-1.457", entryPrice: "100" });
    await flagFarm(botId, "ARB-USD", "-1.457");
    const e = farmEngine(gw, "orphan-e");
    for (let i = 0; i < 3; i += 1) {
      await e.tick();
      clock += 30_000;
    }
    expect(Number((await farmState(botId))?.ledger.position ?? "0")).toBe(0);
    expect((await botState(botId))?.positionMismatch?.["ARB-USD"]).toBeDefined();
    await e.stop();
    await stopFarmBots();
  });

  it("never adopts a booked own order that only happens to match a manual trade (review #239 B1)", async () => {
    const gw = new FakeGateway();
    const { botId, accountId } = await seedFarm("OP-USD");
    // Lệnh vào cũ đã khớp và được ghi bình thường (khớp trước mọi lệnh vào sau nó), đã rời bộ nhớ chiến lược; người dùng
    // bán tay đúng khối lượng đó trên SoDEX.
    await droppedFill(botId, accountId, "OP-USD", "0.957", false);
    gw.perpsPositions.set("OP-USD", { size: "-0.957", entryPrice: "100" });
    await flagFarm(botId, "OP-USD", "-0.957");
    const e = farmEngine(gw, "orphan-g");
    for (let i = 0; i < 3; i += 1) {
      await e.tick();
      clock += 30_000;
    }
    expect(Number((await farmState(botId))?.ledger.position ?? "0")).toBe(0);
    expect((await botState(botId))?.positionMismatch?.["OP-USD"]).toBeDefined();
    expect(gw.received.filter((o) => o.market === "OP-USD")).toHaveLength(0);
    await e.stop();
    await stopFarmBots();
  });

  it("#239 05:31: cancels the round's SoDEX stop at exit; if it still fires while flat, no position is opened and nothing is sent", async () => {
    const { eq } = await import("drizzle-orm");
    const gw = new FakeGateway();
    await seedCandles("INJ-USD");
    const { botId, accountId } = await seedFarm("INJ-USD");
    const e = farmEngine(gw, "orphan-h");
    await tickUntil(e, () => entriesOf(gw, "INJ-USD").length > 0);
    const entry = entriesOf(gw, "INJ-USD")[0];
    const qty = entry?.quantity ?? "0";
    clock += 500;
    await e.onFill(accountId, entry?.clOrdID ?? "", qty, "100", "0.01", clock);
    const stop = gw.received.find((o) => o.market === "INJ-USD" && o.stop !== undefined);
    expect(stop).toBeDefined();
    // Lệnh huỷ không tới SoDEX (stop còn sống, như prod), hết thời gian giữ tối đa: lệnh thoát.
    gw.cancelNotSent = 1_000_000;
    for (let i = 0; i < 4 && !gw.received.some((o) => o.tag.includes(":out:")); i += 1) {
      clock += 100_000;
      await e.tick();
    }
    const exit = gw.received.find((o) => o.market === "INJ-USD" && o.tag.includes(":out:"));
    expect(exit).toBeDefined();
    clock += 500;
    const attempts = gw.cancelNotSent;
    // Lần huỷ stop trong bước này không rời DeskLabs (signer lỗi): lỗi đi lên như mọi lần huỷ không gửi được.
    await e
      .onFill(accountId, exit?.clOrdID ?? "", exit?.quantity ?? "0", "100", "0.01", clock)
      .catch(() => undefined);
    expect(Number((await farmState(botId))?.ledger.position)).toBe(0);
    // Đóng lượt: bot gửi huỷ stop ngay (không để SoDEX tự huỷ) và theo dõi nó.
    expect(gw.cancelNotSent).toBeLessThan(attempts);
    expect((await farmState(botId))?.orders[stop?.clOrdID ?? ""]?.cancelAt).toBeDefined();
    // Stop kích hoạt khi bot đã phẳng (đóng vị thế mồ côi trên SoDEX).
    const before = gw.received.length;
    clock += 1_000;
    await e.onFill(accountId, stop?.clOrdID ?? "", qty, "99", "0.02", clock);
    for (let i = 0; i < 3; i += 1) {
      clock += 5_000;
      await e.tick();
    }
    const st = await farmState(botId);
    expect(Number(st?.ledger.position)).toBe(0);
    expect(gw.received.slice(before).filter((o) => o.reduceOnly)).toHaveLength(0);
    expect((await botState(botId))?.state).toBe("running");
    const events = await db.select().from(botEvents).where(eq(botEvents.botId, botId));
    expect(events.some((x) => x.decision === "Closing fill beyond the bot's position")).toBe(true);
    // Báo team: stop / lệnh thoát đóng một vị thế bot không theo dõi (critical).
    expect((await teamIncidents(botId)).map((x) => x.kind)).toContain("closing_fill_beyond");
    gw.cancelNotSent = 0;
    await e.stop();
    await stopFarmBots();
  });

  it("treats OrderNotFound on the cancel of a closed round's SoDEX stop as ended, without any lookup (PM #248)", async () => {
    const { eq } = await import("drizzle-orm");
    const gw = new FakeGateway();
    await seedCandles("LDO-USD");
    const { botId, accountId } = await seedFarm("LDO-USD");
    const e = farmEngine(gw, "orphan-k");
    await tickUntil(e, () => entriesOf(gw, "LDO-USD").length > 0);
    const entry = entriesOf(gw, "LDO-USD")[0];
    clock += 500;
    await e.onFill(accountId, entry?.clOrdID ?? "", entry?.quantity ?? "0", "100", "0.01", clock);
    const stop = gw.received.find((o) => o.market === "LDO-USD" && o.stop !== undefined);
    const stopId = stop?.clOrdID ?? "";
    for (let i = 0; i < 4 && !gw.received.some((o) => o.tag.includes(":out:")); i += 1) {
      clock += 100_000;
      await e.tick();
    }
    const exit = gw.received.find((o) => o.market === "LDO-USD" && o.tag.includes(":out:"));
    // SoDEX đã tự huỷ stop khi vị thế về 0: lệnh huỷ của bot gặp OrderNotFound.
    gw.cancelOutcome = "not_found";
    // Lần tra trước đó (đối soát khoảng trống stream lúc nạp bot, DEC-87) không tính.
    const lookedBefore = gw.lookups.filter((l) => l.clOrdID === stopId).length;
    try {
      clock += 500;
      await e.onFill(accountId, exit?.clOrdID ?? "", exit?.quantity ?? "0", "100", "0.01", clock);
      const row = (await db.select().from(orders).where(eq(orders.clOrdId, stopId)))[0];
      expect(row?.status).toBe("cancelled");
      expect(row?.doneFedAt).not.toBeNull();
      expect((await farmState(botId))?.orders[stopId]?.done).toBe(true);
      for (let i = 0; i < 3; i += 1) {
        clock += 16_000;
        await e.tick();
      }
      // Không tra lại stop (không tốn ngân sách khẩn), không huỷ lại.
      expect(gw.lookups.filter((l) => l.clOrdID === stopId)).toHaveLength(lookedBefore);
      expect(gw.cancelled.filter((id) => id === stopId)).toHaveLength(1);
    } finally {
      gw.cancelOutcome = "ok";
      await e.stop();
      await stopFarmBots();
    }
  });

  it("cancels an untracked open Volume Farm order and warns the team (DEC-313, warning)", async () => {
    const gw = new FakeGateway();
    const { botId, accountId } = await seedFarm("RUNE-USD");
    const id = `lost-${String(Math.random())}`;
    await db.insert(orders).values({
      botId,
      sodexAccountId: accountId,
      clOrdId: id,
      market: "RUNE-USD",
      engine: "perps",
      side: "sell",
      type: "limit",
      price: "101",
      timeInForce: "GTX",
      size: "1",
      status: "open",
      reduceOnly: true,
      epoch: 1,
      tag: "vf:9:out:0",
      submittedAt: new Date(clock - 60_000),
      ackedAt: new Date(clock - 60_000),
    });
    const e = farmEngine(gw, "orphan-l");
    for (let i = 0; i < 3 && !gw.cancelled.includes(id); i += 1) {
      await e.tick();
      clock += 16_000;
    }
    expect(gw.cancelled).toContain(id);
    const warn = (await teamIncidents(botId)).find((x) => x.kind === "orphan_cancelled");
    expect(warn?.detail).toContain(id);
    await e.stop();
    await stopFarmBots();
  });

  // ---------- #250: bot paper không bao giờ báo team các sự cố tiền thật mới (DEC-105, DEC-313, review #248 minor 2) ----------

  const NEW_TEAM_KINDS = [
    "late_fill_adopted",
    "closing_fill_beyond",
    "cancel_unconfirmed",
    "ledger_repaired",
    "orphan_cancelled",
  ];
  /** Mọi dòng `jobs.team_ops` của bot thuộc các loại mới (bất kể `type`). */
  const newTeamOps = async (botId: string) => {
    const { sql } = await import("drizzle-orm");
    return (
      await db
        .select({ payload: outbox.payload })
        .from(outbox)
        .where(sql`${outbox.topic} = 'jobs.team_ops' and ${outbox.payload}->>'botId' = ${botId}`)
    )
      .map((r) => (r.payload as { kind?: string }).kind ?? "")
      .filter((k) => NEW_TEAM_KINDS.includes(k));
  };
  /**
   * Cổng paper cho test: vẫn là PaperGateway (account `paper`, không bao giờ tới SoDEX), nhưng nhận / huỷ lệnh và đọc vị thế
   * theo cổng giả để dựng lại đúng các tình huống của bot thật (huỷ không gửi được, fill muộn, vị thế lệch sổ cái) và không
   * tự khớp lệnh theo giá.
   */
  class ScriptedPaper extends PaperGateway {
    constructor(readonly fake: FakeGateway) {
      super({ db, now });
    }
    override submit(
      ...args: Parameters<PaperGateway["submit"]>
    ): ReturnType<PaperGateway["submit"]> {
      return this.fake.submit(...args);
    }
    override cancel(
      ...args: Parameters<PaperGateway["cancel"]>
    ): ReturnType<PaperGateway["cancel"]> {
      return this.fake.cancel(...args);
    }
    override readPositions(
      ...args: Parameters<PaperGateway["readPositions"]>
    ): ReturnType<PaperGateway["readPositions"]> {
      return this.fake.readPositions(...args);
    }
    override onPrice(): ReturnType<PaperGateway["onPrice"]> {
      return Promise.resolve([]);
    }
  }
  async function seedPaperFarm(market: string) {
    const { eq } = await import("drizzle-orm");
    const seeded = await seedFarm(market);
    await db.update(bots).set({ mode: "paper" }).where(eq(bots.id, seeded.botId));
    await db.insert(paperAccounts).values({
      botId: seeded.botId,
      capital: "1000",
      cash: "1000",
      positions: {},
      peakEquity: "1000",
      startedAt: new Date(clock),
    });
    return seeded;
  }
  /** Engine có cổng thật giả (`live`, phải không nhận gì) và cổng paper theo kịch bản. */
  const paperFarmEngine = (live: FakeGateway, paper: FakeGateway, id: string) =>
    new Engine({
      db,
      redis: newRedis(),
      gateway: live,
      paper: new ScriptedPaper(paper),
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
  const decisionsOf = async (botId: string) => {
    const { eq } = await import("drizzle-orm");
    return (await db.select().from(botEvents).where(eq(botEvents.botId, botId))).map(
      (x) => x.decision,
    );
  };

  describe("a paper Volume Farm bot never raises a team alert (#250)", () => {
    it("cancel_unconfirmed: a cancel that never leaves DeskLabs for 10 minutes", async () => {
      const live = new FakeGateway();
      const paper = new FakeGateway();
      await seedCandles("KAS-USD");
      const { botId } = await seedPaperFarm("KAS-USD");
      const e = paperFarmEngine(live, paper, "paper-team-a");
      await tickUntil(e, () => entriesOf(paper, "KAS-USD").length > 0);
      expect(entriesOf(paper, "KAS-USD")).toHaveLength(1);
      paper.cancelNotSent = 1_000_000;
      clock += 11_000;
      await e.tick();
      for (let i = 0; i < 25; i += 1) {
        clock += 30_000;
        await e.tick();
      }
      // Chiến lược đã đi tới đúng chỗ báo team (Decisions + Needs attention), nhưng không có dòng cho team.
      expect(await decisionsOf(botId)).toContain("Waiting for SoDEX to confirm a cancel");
      expect((await botState(botId))?.needsAttention).toBe(true);
      expect(await newTeamOps(botId)).toEqual([]);
      expect(live.received).toEqual([]);
      paper.cancelNotSent = 0;
      await e.stop();
      await stopFarmBots();
    });

    it("late_fill_adopted: a fill of an entry the bot no longer remembers", async () => {
      const live = new FakeGateway();
      const paper = new FakeGateway();
      const { botId, accountId } = await seedPaperFarm("WLD-USD");
      // Lệnh vào cũ của chính bot mà state đã quên (như sau khi khởi động lại, #239), còn mở trong DeskLabs.
      const id = `forgotten-${String(Math.random())}`;
      await db.insert(orders).values({
        botId,
        sodexAccountId: accountId,
        clOrdId: id,
        market: "WLD-USD",
        engine: "perps",
        side: "buy",
        type: "limit",
        price: "100",
        timeInForce: "GTX",
        size: "1",
        status: "open",
        reduceOnly: false,
        epoch: 1,
        tag: "vf:77:in:0",
        submittedAt: new Date(clock - 30_000),
        ackedAt: new Date(clock - 30_000),
      });
      const e = paperFarmEngine(live, paper, "paper-team-b");
      await e.tick();
      clock += 1_000;
      await e.onFill(accountId, id, "1", "100", "0.01", clock);
      expect(Number((await farmState(botId))?.ledger.position)).toBe(1);
      expect(await decisionsOf(botId)).toContain("Late fill added to the position");
      expect(await newTeamOps(botId)).toEqual([]);
      expect(live.received).toEqual([]);
      await e.stop();
      await stopFarmBots();
    });

    it("closing_fill_beyond: an exit fill larger than the position", async () => {
      const live = new FakeGateway();
      const paper = new FakeGateway();
      await seedCandles("PYTH-USD");
      const { botId, accountId } = await seedPaperFarm("PYTH-USD");
      const e = paperFarmEngine(live, paper, "paper-team-c");
      await tickUntil(e, () => entriesOf(paper, "PYTH-USD").length > 0);
      const entry = entriesOf(paper, "PYTH-USD")[0];
      const qty = entry?.quantity ?? "0";
      clock += 500;
      await e.onFill(accountId, entry?.clOrdID ?? "", qty, "100", "0.01", clock);
      const exitOf = () =>
        paper.received.find((o) => o.market === "PYTH-USD" && o.tag.includes(":out:"));
      for (let i = 0; i < 4 && exitOf() === undefined; i += 1) {
        clock += 100_000;
        await e.tick();
      }
      const exit = exitOf();
      expect(exit).toBeDefined();
      // Lệnh đóng khớp gấp đôi vị thế bot theo dõi (như stop của lượt cũ đóng vị thế mồ côi, #239 05:31).
      clock += 500;
      await e.onFill(
        accountId,
        exit?.clOrdID ?? "",
        dec(qty).mul(2).toString(),
        "100",
        "0.01",
        clock,
      );
      expect(await decisionsOf(botId)).toContain("Closing fill beyond the bot's position");
      expect(await newTeamOps(botId)).toEqual([]);
      expect(live.received).toEqual([]);
      await e.stop();
      await stopFarmBots();
    });

    it("ledger_repaired / late_fill_adopted: a flagged ledger with a dropped fill of its own entry", async () => {
      const live = new FakeGateway();
      const paper = new FakeGateway();
      const { botId, accountId } = await seedPaperFarm("ICP-USD");
      await droppedFill(botId, accountId, "ICP-USD", "0.957");
      paper.perpsPositions.set("ICP-USD", { size: "-0.957", entryPrice: "100" });
      await flagFarm(botId, "ICP-USD", "-0.957");
      const e = paperFarmEngine(live, paper, "paper-team-d");
      for (let i = 0; i < 3; i += 1) {
        await e.tick();
        clock += 30_000;
      }
      // Sửa sổ cái chỉ dành cho bot thật (nạp lại, kiểm tra vị thế và `#adoptOwnFills` đều bỏ qua bot paper): bot paper
      // không nhận fill đó và không báo team.
      expect(Number((await farmState(botId))?.ledger.position ?? "0")).toBe(0);
      expect(await decisionsOf(botId)).not.toContain("Late fill added to the position");
      expect(await newTeamOps(botId)).toEqual([]);
      expect(live.received).toEqual([]);
      await e.stop();
      await stopFarmBots();
    });

    it("orphan_cancelled: an untracked open order", async () => {
      const live = new FakeGateway();
      const paper = new FakeGateway();
      const { botId, accountId } = await seedPaperFarm("HBAR-USD");
      await db.insert(orders).values({
        botId,
        sodexAccountId: accountId,
        clOrdId: `lost-${String(Math.random())}`,
        market: "HBAR-USD",
        engine: "perps",
        side: "sell",
        type: "limit",
        price: "101",
        timeInForce: "GTX",
        size: "1",
        status: "open",
        reduceOnly: true,
        epoch: 1,
        tag: "vf:9:out:0",
        submittedAt: new Date(clock - 60_000),
        ackedAt: new Date(clock - 60_000),
      });
      const e = paperFarmEngine(live, paper, "paper-team-e");
      for (let i = 0; i < 3; i += 1) {
        await e.tick();
        clock += 16_000;
      }
      // Quét lệnh mồ côi chỉ chạy cho bot thật.
      expect(await decisionsOf(botId)).not.toContain("Cancelled 1 untracked order");
      expect(await newTeamOps(botId)).toEqual([]);
      expect(live.received).toEqual([]);
      await e.stop();
      await stopFarmBots();
    });
  });

  it("never places an order for a paused Volume Farm bot while repairing; the repair happens on Resume (review #248 minor 2)", async () => {
    const { eq } = await import("drizzle-orm");
    const gw = new FakeGateway();
    const { botId, accountId } = await seedFarm("JUP-USD");
    const e = farmEngine(gw, "orphan-m");
    await e.tick();
    // Bot đang chạy được pause (runner còn): rồi phát hiện fill bị bỏ qua.
    await db.update(bots).set({ state: "pausing" }).where(eq(bots.id, botId));
    for (let i = 0; i < 3 && (await botState(botId))?.state !== "paused"; i += 1) {
      clock += 1_000;
      await e.tick();
    }
    expect((await botState(botId))?.state).toBe("paused");
    await droppedFill(botId, accountId, "JUP-USD", "0.957");
    gw.perpsPositions.set("JUP-USD", { size: "-0.957", entryPrice: "100" });
    await flagFarm(botId, "JUP-USD", "-0.957");
    const before = gw.received.length;
    for (let i = 0; i < 4; i += 1) {
      clock += 30_000;
      await e.tick();
    }
    expect(gw.received.slice(before)).toEqual([]);
    expect(Number((await farmState(botId))?.ledger.position ?? "0")).toBe(0);
    // Resume: sổ cái được sửa khi bot chạy lại (lúc nạp lại runner, hoặc lần kiểm tra vị thế kế tiếp).
    await db.update(bots).set({ state: "resuming" }).where(eq(bots.id, botId));
    for (let i = 0; i < 6 && (await farmState(botId))?.ledger.position !== "-0.957"; i += 1) {
      await e.tick();
      clock += 30_000;
    }
    expect((await botState(botId))?.state).toBe("running");
    expect((await farmState(botId))?.ledger.position).toBe("-0.957");
    await e.stop();
    await stopFarmBots();
  });

  it("#239 repair: a bot paused ORDER_REJECTED with ledger long vs SoDEX flat is repaired on load from the dropped sell and resumes safely", async () => {
    const { eq } = await import("drizzle-orm");
    const gw = new FakeGateway();
    const { botId, accountId } = await seedFarm("TIA-USD");
    // State như prod sau 05:31: stop của vf:107 bị ghi thành long 0.957, bot đang thoát rồi bị pause.
    const [b] = await db.select().from(bots).where(eq(bots.id, botId));
    await db.insert(botRuntime).values({
      botId,
      versionId: b?.activeVersionId ?? "",
      epoch: 1,
      state: {
        phase: "exiting",
        cycle: 107,
        ledger: {
          position: "0.957",
          avgCost: "99",
          realized: "0",
          fees: "0",
          funding: "0",
          invested: "94.743",
        },
        lastPrice: "100",
        book: null,
        bookAt: null,
        orders: {},
        entry: null,
        exit: null,
        exitReason: "Hold time ended",
        exitForce: false,
        openedAt: clock - 60_000,
        holdUntil: clock - 30_000,
        holdSecs: 120,
        cooldownUntil: 0,
        unfilled: 0,
        exitUnfilled: 30,
        lastSide: "short",
        netExposure: "0",
        openRealized: "0",
        openFees: "0",
        volume: "0",
        trades: 3,
        wins: 1,
        lastSkip: null,
        lastSignal: null,
      },
    });
    await db
      .update(bots)
      .set({ state: "paused", reasonCode: "ORDER_REJECTED" })
      .where(eq(bots.id, botId));
    await droppedFill(botId, accountId, "TIA-USD", "0.957");
    await db
      .update(bots)
      .set({
        positionMismatch: {
          "TIA-USD": {
            real: "0",
            ledger: "0.957",
            since: new Date(clock).toISOString(),
            cause: "trades",
          },
        },
      })
      .where(eq(bots.id, botId));
    const e = farmEngine(gw, "orphan-i");
    // Bot pause không có runner; người dùng bấm Resume: runner nạp lại và sổ cái được sửa trước bước đầu tiên.
    await e.tick();
    expect((await botState(botId))?.state).toBe("paused");
    await db.update(bots).set({ state: "resuming", reasonCode: null }).where(eq(bots.id, botId));
    for (let i = 0; i < 4 && (await botState(botId))?.state !== "running"; i += 1) {
      await e.tick();
      clock += 1_000;
    }
    const st = await farmState(botId);
    expect(Number(st?.ledger.position)).toBe(0);
    expect(st?.phase).toBe("idle");
    expect((await botState(botId))?.state).toBe("running");
    // Chạy tiếp: không gửi lệnh bán reduce-only nào; hai lần kiểm tra khớp thì bỏ cảnh báo.
    for (let i = 0; i < 4; i += 1) {
      clock += 30_000;
      await e.tick();
    }
    expect(gw.received.filter((o) => o.market === "TIA-USD" && o.reduceOnly)).toHaveLength(0);
    expect((await botState(botId))?.positionMismatch).toBeNull();
    expect((await botState(botId))?.state).toBe("running");
    await e.stop();
    await stopFarmBots();
  });

  /**
   * Dữ liệu prod #239 của bot 01a1ebcb (ETH-USD): lệnh, fill, state của bản cũ (sổ cái +0.0957), cờ lệch đã lưu
   * (`since` 04:14:57.736Z), bot pause ORDER_REJECTED. SoDEX bây giờ phẳng.
   */
  async function seedProd239() {
    const { eq } = await import("drizzle-orm");
    // Resume lúc 06:00Z, sau sự cố (05:31) và sau khi cờ được ghi (04:14:57).
    clock = Math.max(clock, Date.parse("2026-11-18T06:00:00.000Z"));
    const t = (iso: string) => new Date(`2026-11-18T${iso}Z`);
    const { botId, accountId } = await seedFarm("ETH-USD");
    const row = async (v: {
      clOrdId: string;
      tag: string;
      side: "buy" | "sell";
      type?: "limit" | "market";
      size: string;
      filled: string;
      status: "filled" | "cancelled" | "rejected";
      reduceOnly?: boolean;
      at: string;
      fillAt?: string;
    }) => {
      const [o] = await db
        .insert(orders)
        .values({
          botId,
          sodexAccountId: accountId,
          clOrdId: v.clOrdId,
          market: "ETH-USD",
          engine: "perps",
          side: v.side,
          type: v.type ?? "limit",
          ...(v.type === "market" ? {} : { price: "1830" }),
          timeInForce: v.type === "market" ? "IOC" : "GTX",
          size: v.size,
          filledSize: v.filled,
          ...(dec(v.filled).gt(0) ? { avgPrice: v.tag.endsWith(":sl") ? "1816.1" : "1830" } : {}),
          status: v.status,
          reduceOnly: v.reduceOnly ?? false,
          epoch: 1,
          tag: v.tag,
          submittedAt: t(v.at),
          ackedAt: t(v.at),
          doneFedAt: t(v.fillAt ?? v.at),
        })
        .returning();
      if (v.fillAt !== undefined && o !== undefined)
        await db.insert(fills).values({
          orderId: o.id,
          sodexTradeId: 95_000_000n + BigInt(Math.floor(Math.random() * 1e9)),
          price: o.avgPrice ?? "1830",
          size: v.filled,
          fee: "0.0175",
          isMaker: !v.tag.endsWith(":sl"),
          filledAt: t(v.fillAt),
        });
    };
    const orphan = "d212zms-1-2opslj5e78t6a-0";
    const stopId = "d212zms-1-2vdmfgtmcnl54-0";
    // vf:103 (lệnh mồ côi): gửi 04:02:34, khớp muộn 04:13:00.324 sau khi vf:104–106 đã gửi.
    await row({
      clOrdId: orphan,
      tag: "vf:103:in:0",
      side: "sell",
      size: "0.0957",
      filled: "0.0957",
      status: "filled",
      at: "04:02:34.562",
      fillAt: "04:13:00.324",
    });
    for (const [n, at, side, size] of [
      [104, "04:04:17.000", "buy", "0.1101"],
      [105, "04:07:02.000", "sell", "0.1189"],
      [106, "04:09:40.000", "buy", "0.1023"],
    ] as const) {
      await row({
        clOrdId: `vf-${String(n)}-in-${String(Math.random())}`,
        tag: `vf:${String(n)}:in:${n === 104 ? "1" : "0"}`,
        side,
        size,
        filled: size,
        status: "filled",
        at,
        fillAt: at.replace(/\.000$/, ".900"),
      });
    }
    await row({
      clOrdId: `vf-107-in-${String(Math.random())}`,
      tag: "vf:107:in:0",
      side: "sell",
      size: "0.1052",
      filled: "0.1052",
      status: "filled",
      at: "04:13:00.840",
      fillAt: "04:13:05.000",
    });
    // Stop của vf:107: đặt khi lệnh vào mới khớp một phần (0.0104), SoDEX khớp 0.0957 lúc 05:31:08 (filled > size).
    await row({
      clOrdId: stopId,
      tag: "vf:107:sl",
      side: "buy",
      type: "market",
      size: "0.0104",
      filled: "0.0957",
      status: "filled",
      reduceOnly: true,
      at: "04:13:03.860",
      fillAt: "05:31:08.000",
    });
    await row({
      clOrdId: `vf-107-out-${String(Math.random())}`,
      tag: "vf:107:out:0",
      side: "buy",
      size: "0.1052",
      filled: "0.1052",
      status: "filled",
      reduceOnly: true,
      at: "04:17:50.000",
      fillAt: "04:18:06.000",
    });
    for (let i = 1; i <= 30; i += 1)
      await row({
        clOrdId: `vf-107-out-${String(i)}-${String(Math.random())}`,
        tag: `vf:107:out:${String(i)}`,
        side: "sell",
        size: "0.0957",
        filled: "0",
        status: "rejected",
        reduceOnly: true,
        at: `05:31:${String(10 + i).padStart(2, "0")}.000`,
      });
    // State của bản cũ: stop 05:31 bị ghi thành long 0.0957; bot đang thoát rồi bị pause ORDER_REJECTED.
    const [b] = await db.select().from(bots).where(eq(bots.id, botId));
    await db.insert(botRuntime).values({
      botId,
      versionId: b?.activeVersionId ?? "",
      epoch: 1,
      state: {
        phase: "exiting",
        cycle: 107,
        ledger: {
          position: "0.0957",
          avgCost: "1816.1",
          realized: "0",
          fees: "0",
          funding: "0",
          invested: "173.80077",
        },
        lastPrice: "1816",
        book: null,
        bookAt: null,
        orders: { [stopId]: { kind: "stop", side: "buy" } },
        entry: null,
        exit: null,
        exitReason: null,
        exitForce: false,
        openedAt: Date.parse("2026-11-18T05:31:08.000Z"),
        holdUntil: Date.parse("2026-11-18T05:31:08.000Z"),
        holdSecs: null,
        cooldownUntil: 0,
        unfilled: 0,
        exitUnfilled: 30,
        lastSide: "short",
        netExposure: "0",
        openRealized: "0",
        openFees: "0",
        volume: "0",
        trades: 6,
        wins: 3,
        lastSkip: null,
        lastSignal: null,
        xstop: null,
        staleXstop: null,
      },
    });
    // Cờ đã lưu, không cập nhật sau 04:14.
    await db
      .update(bots)
      .set({
        state: "paused",
        reasonCode: "ORDER_REJECTED",
        positionMismatch: {
          "ETH-USD": {
            real: "-0.2009",
            cause: "trades",
            since: "2026-11-18T04:14:57.736Z",
            ledger: "-0.1052",
          },
        },
      })
      .where(eq(bots.id, botId));
    return { botId, accountId, orphan };
  }

  it("#239 prod replay (bot 01a1ebcb, ETH-USD): resuming repairs ledger +0.0957 vs SoDEX 0 from vf:103 using the stored since, places nothing, clears the flag", async () => {
    const { eq } = await import("drizzle-orm");
    const gw = new FakeGateway();
    const { botId, orphan } = await seedProd239();
    // SoDEX bây giờ: phẳng.
    const e = farmEngine(gw, "prod-239");
    await e.tick();
    const before = gw.received.length;
    await db.update(bots).set({ state: "resuming", reasonCode: null }).where(eq(bots.id, botId));
    for (let i = 0; i < 4 && (await botState(botId))?.state !== "running"; i += 1) {
      await e.tick();
      clock += 1_000;
    }
    // Lần đọc vị thế để sửa sổ cái đi đường khẩn (không bị phần dự trữ chặn, v2.12.1).
    expect(gw.positionReadsUrgent).toContain(true);
    const st = await farmState(botId);
    expect((await botState(botId))?.state).toBe("running");
    // Nhận vf:103 (bán 0.0957) theo `since` đã lưu (04:14:57), không theo giờ Resume (06:00): sổ cái về 0.
    expect(dec(st?.ledger.position ?? "1").isZero()).toBe(true);
    expect(st?.orders[orphan]).toMatchObject({ kind: "exit", side: "sell" });
    expect(st?.phase).toBe("idle");
    const team = await teamIncidents(botId);
    expect(team.find((x) => x.kind === "ledger_repaired")?.detail).toContain(
      `${orphan} · sell 0.0957`,
    );
    for (let i = 0; i < 4; i += 1) {
      clock += 30_000;
      await e.tick();
    }
    // Không đặt lệnh nào (không còn 30 lệnh bán reduce-only), cờ được bỏ.
    expect(gw.received.slice(before).filter((o) => o.market === "ETH-USD")).toEqual([]);
    expect((await botState(botId))?.positionMismatch).toBeNull();
    expect((await botState(botId))?.state).toBe("running");
    await e.stop();
    await stopFarmBots();
  });

  const rateLimited = () =>
    new AppError(ErrorCode.rateLimited, "SoDEX rate limit reached", { retryAfterMs: 174 });

  it("#239 v2.12.1 prod replay: the repair read is RATE_LIMITED on Resume, so the bot stays resuming and sends nothing; the next sync repairs it", async () => {
    const { eq } = await import("drizzle-orm");
    const gw = new FakeGateway();
    const { botId, orphan } = await seedProd239();
    const e = farmEngine(gw, "prod-239-rl");
    await e.tick();
    const before = gw.received.length;
    // Prod 2026-11-18: readPositions ném RATE_LIMITED (retryAfterMs 174) ở #repairOnLoad.
    gw.positionError = rateLimited();
    gw.positionErrorTimes = null;
    await db.update(bots).set({ state: "resuming", reasonCode: null }).where(eq(bots.id, botId));
    const urgentReads = () => gw.positionReadsUrgent.filter((x) => x).length;
    const stillWaiting = async () => {
      // Còn `resuming`, sổ cái chưa sửa, không lệnh nào (trước đây: Running + 30 lệnh bán reduce-only).
      expect((await botState(botId))?.state).toBe("resuming");
      expect((await farmState(botId))?.ledger.position).toBe("0.0957");
      expect(gw.received.slice(before)).toEqual([]);
    };
    await e.tick();
    await stillWaiting();
    expect(urgentReads()).toBe(1);
    // Không ngủ, không đọc lại ngay: lần sau sau 10 s (nấc đầu, dài hơn retryAfterMs 174 ms).
    clock += 5_000;
    await e.tick();
    await stillWaiting();
    expect(urgentReads()).toBe(1);
    clock += 6_000;
    await e.tick();
    await stillWaiting();
    expect(urgentReads()).toBe(2);
    // Nấc thứ hai 20 s; lần đó đọc được: nhận vf:103, sổ cái 0, Running, không gửi gì.
    gw.positionError = null;
    clock += 21_000;
    for (let i = 0; i < 3 && (await botState(botId))?.state !== "running"; i += 1) {
      await e.tick();
      clock += 1_000;
    }
    expect((await botState(botId))?.state).toBe("running");
    expect(dec((await farmState(botId))?.ledger.position ?? "1").isZero()).toBe(true);
    expect((await farmState(botId))?.orders[orphan]).toMatchObject({ kind: "exit", side: "sell" });
    for (let i = 0; i < 4; i += 1) {
      clock += 30_000;
      await e.tick();
    }
    expect(gw.received.slice(before).filter((o) => o.market === "ETH-USD")).toEqual([]);
    expect((await botState(botId))?.positionMismatch).toBeNull();
    gw.positionError = null;
    await e.stop();
    await stopFarmBots();
  });

  it("v2.12.1: after an engine restart a running Volume Farm bot with a mismatch takes no market step until the repair read succeeds, and says so after 5 minutes", async () => {
    const { eq } = await import("drizzle-orm");
    const gw = new FakeGateway();
    const { botId } = await seedProd239();
    // Bot đang chạy khi engine khởi động lại (state cũ: đang thoát, sổ cái +0.0957, SoDEX phẳng).
    await db.update(bots).set({ state: "running", reasonCode: null }).where(eq(bots.id, botId));
    gw.positionError = rateLimited();
    gw.positionErrorTimes = null;
    const e = farmEngine(gw, "prod-239-restart");
    const before = gw.received.length;
    for (let i = 0; i < 12; i += 1) {
      await e.tick();
      clock += 30_000;
    }
    // Đọc lỗi suốt 6 phút: không bước nào theo thị trường, không lệnh nào; một dòng Decisions + Needs attention.
    expect(gw.received.slice(before)).toEqual([]);
    expect((await farmState(botId))?.ledger.position).toBe("0.0957");
    const waits = (await db.select().from(botEvents).where(eq(botEvents.botId, botId))).filter(
      (x) => x.decision === "Waiting to check the position on SoDEX",
    );
    expect(waits).toHaveLength(1);
    expect((await botState(botId))?.needsAttention).toBe(true);
    // Báo team (warning, DEC-313) một lần.
    expect((await teamIncidents(botId)).filter((x) => x.kind === "repair_waiting")).toHaveLength(1);
    // Đọc theo nhịp 10 / 20 / 30 s, không mỗi vòng: tối đa ~6 lần / phút (6 phút → ≤ 14 lần đọc khẩn).
    expect(gw.positionReadsUrgent.filter((x) => x).length).toBeLessThanOrEqual(14);
    // Đọc được: sửa sổ cái, vẫn không gửi gì; ghi "Position checked on SoDEX" và bỏ Needs attention của lần chờ.
    gw.positionError = null;
    for (let i = 0; i < 4; i += 1) {
      await e.tick();
      clock += 30_000;
    }
    expect(dec((await farmState(botId))?.ledger.position ?? "1").isZero()).toBe(true);
    expect(gw.received.slice(before).filter((o) => o.market === "ETH-USD")).toEqual([]);
    const checked = (await db.select().from(botEvents).where(eq(botEvents.botId, botId))).filter(
      (x) => x.decision === "Position checked on SoDEX",
    );
    expect(checked).toHaveLength(1);
    expect(checked[0]?.why).toBe(
      "DeskLabs read this bot's position on SoDEX and checked its ledger.",
    );
    // Needs attention giữ nguyên (người dùng tự bỏ, PM chốt #253).
    expect((await botState(botId))?.needsAttention).toBe(true);
    await e.stop();
    await stopFarmBots();
  });

  it("v2.12.1: never sends a reduce-only order on a mismatched Volume Farm market whose real position is 0", async () => {
    const { eq, and } = await import("drizzle-orm");
    const gw = new FakeGateway();
    const { botId, accountId } = await seedProd239();
    // Không có lệnh nào giải thích được độ lệch: bỏ lệnh vf:103 khỏi DB như một sổ cái sai không sửa được.
    await db.delete(fills).where(
      eq(
        fills.orderId,
        (
          await db
            .select({ id: orders.id })
            .from(orders)
            .where(and(eq(orders.sodexAccountId, accountId), eq(orders.tag, "vf:103:in:0")))
        )[0]?.id ?? "",
      ),
    );
    await db
      .delete(orders)
      .where(and(eq(orders.sodexAccountId, accountId), eq(orders.tag, "vf:103:in:0")));
    const e = farmEngine(gw, "prod-239-zero");
    await e.tick();
    const before = gw.received.length;
    await db.update(bots).set({ state: "resuming", reasonCode: null }).where(eq(bots.id, botId));
    for (let i = 0; i < 8; i += 1) {
      await e.tick();
      clock += 20_000;
    }
    // Sổ cái vẫn +0.0957 (không sửa được) nhưng SoDEX = 0: không gửi lệnh bán reduce-only nào, không pause.
    expect((await botState(botId))?.state).toBe("running");
    expect((await farmState(botId))?.ledger.position).toBe("0.0957");
    expect(gw.received.slice(before).filter((o) => o.market === "ETH-USD" && o.reduceOnly)).toEqual(
      [],
    );
    await e.stop();
    await stopFarmBots();
  });

  /** Bot Volume Farm đang chạy, sổ cái +0.5 BTC-like, cờ lệch đã lưu (`real` cho trước): như sau khi engine khởi động lại. */
  async function seedWaitingFarm(
    market: string,
    storedReal: string,
    extra: Record<string, unknown> = {},
  ) {
    const { eq } = await import("drizzle-orm");
    const { botId, accountId } = await seedFarm(market);
    const [b] = await db.select().from(bots).where(eq(bots.id, botId));
    await db.insert(botRuntime).values({
      botId,
      versionId: b?.activeVersionId ?? "",
      epoch: 1,
      state: {
        phase: "open",
        cycle: 3,
        ledger: {
          position: "0.5",
          avgCost: "100",
          realized: "0",
          fees: "0",
          funding: "0",
          invested: "50",
        },
        lastPrice: "100",
        book: null,
        bookAt: null,
        orders: {},
        entry: null,
        exit: null,
        exitReason: null,
        exitForce: false,
        openedAt: clock - 600_000,
        holdUntil: clock - 300_000,
        holdSecs: 120,
        cooldownUntil: 0,
        unfilled: 0,
        exitUnfilled: 0,
        lastSide: null,
        netExposure: "0",
        openRealized: "0",
        openFees: "0",
        volume: "0",
        trades: 0,
        wins: 0,
        lastSkip: null,
        lastSignal: null,
        xstop: null,
        xstopOff: true,
        ...extra,
      },
    });
    await db
      .update(bots)
      .set({
        positionMismatch: {
          [market]: {
            real: storedReal,
            ledger: "0.5",
            since: new Date(clock - 3_600_000).toISOString(),
            cause: "trades",
          },
        },
      })
      .where(eq(bots.id, botId));
    return { botId, accountId };
  }

  it("v2.12.1 (review #253): waiting bots never sleep in the sync, read at most about 6 times a minute each, and stay inside the urgent budget", async () => {
    const gw = new FakeGateway();
    const ids: string[] = [];
    for (const m of ["W1-USD", "W2-USD", "W3-USD", "W4-USD", "W5-USD"])
      ids.push((await seedWaitingFarm(m, "0.5")).accountId);
    gw.positionError = rateLimited();
    gw.positionErrorTimes = null;
    const e = farmEngine(gw, "repair-pace");
    let slowest = 0;
    for (let i = 0; i < 60; i += 1) {
      const t0 = Date.now();
      await e.tick();
      slowest = Math.max(slowest, Date.now() - t0);
      clock += 1_000;
    }
    // Không có `setTimeout` trong vòng: 5 bot chờ không cộng thêm 5 s vào một vòng.
    expect(slowest).toBeLessThan(3_000);
    // Mỗi bot: lần đầu + 10 s + 20 s + 30 s … → ≤ 6 lần đọc khẩn / phút.
    for (const a of ids) {
      const urgent = gw.readsBy.filter((x, i) => x === a && gw.positionReadsUrgent[i] === true);
      expect(urgent.length).toBeGreaterThanOrEqual(2);
      expect(urgent.length).toBeLessThanOrEqual(6);
    }
    gw.positionError = null;
    await e.stop();
    await stopFarmBots();
  });

  it("v2.12.1 (review #253): an entry awaiting cancel confirmation is cancelled again while the bot waits for the repair read", async () => {
    const gw = new FakeGateway();
    const id = `chased-${String(Math.random())}`;
    const { botId, accountId } = await seedWaitingFarm("CHS-USD", "0.5", {
      orders: { [id]: { kind: "entry", side: "buy", qty: "1", cancelAt: clock - 30_000 } },
    });
    await db.insert(orders).values({
      botId,
      sodexAccountId: accountId,
      clOrdId: id,
      market: "CHS-USD",
      engine: "perps",
      side: "buy",
      type: "limit",
      price: "99",
      timeInForce: "GTX",
      size: "1",
      status: "open",
      reduceOnly: false,
      epoch: 1,
      tag: "vf:4:in:0",
      submittedAt: new Date(clock - 60_000),
      ackedAt: new Date(clock - 60_000),
    });
    gw.positionError = rateLimited();
    gw.positionErrorTimes = null;
    gw.cancelOutcome = "unknown";
    const e = farmEngine(gw, "repair-chase");
    try {
      for (let i = 0; i < 16 && !gw.cancelled.includes(id); i += 1) {
        await e.tick();
        clock += 1_000;
      }
      expect(gw.cancelled).toContain(id);
    } finally {
      gw.positionError = null;
      gw.cancelOutcome = "ok";
      await e.stop();
      await stopFarmBots();
    }
  });

  it("v2.12.1 (review #253): a stale stored real of 0 never blocks an exit once the repair read shows the position", async () => {
    const gw = new FakeGateway();
    await seedCandles("STL-USD");
    await seedWaitingFarm("STL-USD", "0");
    // SoDEX có đúng vị thế bot theo dõi: lần kiểm tra sửa sổ cái cập nhật `real` dù đã khớp.
    gw.perpsPositions.set("STL-USD", { size: "0.5", entryPrice: "100" });
    const e = farmEngine(gw, "repair-stale");
    for (
      let i = 0;
      i < 6 && !gw.received.some((o) => o.market === "STL-USD" && o.reduceOnly && !o.stop);
      i += 1
    ) {
      await e.tick();
      clock += 3_000;
    }
    // Hết thời gian giữ: lệnh thoát reduce-only được gửi (trước đây `real` 0 cũ bỏ nó).
    expect(
      gw.received.some(
        (o) => o.market === "STL-USD" && o.reduceOnly && o.stop === undefined && o.side === "sell",
      ),
    ).toBe(true);
    await e.stop();
    await stopFarmBots();
  });

  it("v2.12.1 (review #253): a reduce-only stop stripped because the real position is 0 is reported to the strategy as not placed", async () => {
    const gw = new FakeGateway();
    // Cờ lệch với `real` 0 đã lưu, SoDEX vẫn 0, sổ cái long 0.5 không sửa được; lượt đang mở chưa có stop trên SoDEX.
    const { botId } = await seedWaitingFarm("PHT-USD", "0", {
      xstopOff: false,
      holdUntil: clock + 3_600_000,
    });
    const e = farmEngine(gw, "repair-phantom");
    for (let i = 0; i < 6; i += 1) {
      await e.tick();
      clock += 3_000;
    }
    // Không lệnh reduce-only nào tới SoDEX; chiến lược biết stop không được đặt (không có lệnh "ma").
    expect(gw.received.filter((o) => o.market === "PHT-USD" && o.reduceOnly)).toEqual([]);
    const st = (await farmState(botId)) as
      { xstop?: { id: string } | null; xstopOff?: boolean; exit: unknown } | undefined;
    expect(st?.xstop ?? null).toBeNull();
    expect(st?.xstopOff).toBe(true);
    expect(st?.exit ?? null).toBeNull();
    await e.stop();
    await stopFarmBots();
  });

  it("v2.12.1 (review #253): a bot loaded as starting never waits for a repair read", async () => {
    const { eq } = await import("drizzle-orm");
    const gw = new FakeGateway();
    const { botId } = await seedWaitingFarm("STA-USD", "0.5");
    await db.update(bots).set({ state: "starting" }).where(eq(bots.id, botId));
    const e = farmEngine(gw, "repair-starting");
    for (let i = 0; i < 3; i += 1) {
      await e.tick();
      clock += 1_000;
    }
    expect(gw.positionReadsUrgent).not.toContain(true);
    await e.stop();
    await stopFarmBots();
  });

  it("moves on when a timed-out entry's unknown result is given up and SoDEX has no trades for it (review #239 M2)", async () => {
    const { eq } = await import("drizzle-orm");
    const gw = new FakeGateway();
    await seedCandles("SEI-USD");
    const { botId } = await seedFarm("SEI-USD");
    const e = farmEngine(gw, "orphan-j");
    // Lệnh vào gửi đi không rõ kết quả (đã tới SoDEX), rồi không còn ở đâu.
    gw.timeoutNext = "lost";
    await tickUntil(e, () =>
      db
        .select()
        .from(orders)
        .where(eq(orders.botId, botId))
        .then((x) => x.length > 0),
    );
    const [row] = await db.select().from(orders).where(eq(orders.botId, botId));
    const id = row?.clOrdId ?? "";
    // Như đã được SoDEX nhận (có orderID) và lần tra đầu đã xác nhận không thấy từ lâu.
    await db
      .update(orders)
      .set({ sodexOrderId: 77n, missingConfirmedAt: new Date(clock - 11 * 60_000) })
      .where(eq(orders.clOrdId, id));
    clock += 11_000;
    await e.tick();
    expect((await farmState(botId))?.orders[id]?.cancelAt).toBeDefined();
    for (let i = 0; i < 6 && (await farmState(botId))?.orders[id]?.done !== true; i += 1) {
      clock += 60_000;
      await e.tick();
    }
    const after = (await db.select().from(orders).where(eq(orders.clOrdId, id)))[0];
    expect(after?.unknownGaveUpAt).not.toBeNull();
    expect((await farmState(botId))?.orders[id]?.done).toBe(true);
    expect((await botState(botId))?.needsAttention).toBe(true);
    const alerts = await db.select().from(outbox).where(eq(outbox.topic, "jobs.notify"));
    expect(
      alerts.some(
        (x) => (x.payload as { type?: string; data?: { clOrdID?: string } }).data?.clOrdID === id,
      ),
    ).toBe(true);
    await e.stop();
    await stopFarmBots();
  });

  it("books the trades of a given-up unknown entry before moving on (#250, review #248 minor 1)", async () => {
    const { eq } = await import("drizzle-orm");
    const gw = new FakeGateway();
    const warned: string[] = [];
    await seedCandles("STX-USD");
    const { botId } = await seedFarm("STX-USD");
    // Mỗi trade được ghi: chiến lược đã nhận `orderDone` của lệnh đó chưa (state đã lưu ngay trước lúc ghi trade).
    const doneBeforeTrade: boolean[] = [];
    class TradeOrder extends Engine {
      override async onTrade(
        ...args: Parameters<Engine["onTrade"]>
      ): ReturnType<Engine["onTrade"]> {
        const st = await farmState(botId);
        doneBeforeTrade.push(st?.orders[args[1].clOrdID]?.done === true);
        return super.onTrade(...args);
      }
    }
    const e = new TradeOrder({
      db,
      redis: newRedis(),
      gateway: gw,
      workerId: "orphan-j2",
      log: {
        ...log,
        warn: (...args: unknown[]) => {
          if (typeof args[1] === "string") warned.push(args[1]);
        },
      },
      now,
      leaseTtlMs: 30_000,
      shards: SHARDS,
      rules: () => Promise.resolve(rules),
      feeCheckMs: 0,
      orderbook: () =>
        Promise.resolve({ bid: "100", ask: "100.05", bidNotional: "50000", askNotional: "40000" }),
    });
    // Lệnh vào gửi đi không rõ kết quả (đã tới SoDEX), rồi không còn trên sổ.
    gw.timeoutNext = "lost";
    await tickUntil(e, () =>
      db
        .select()
        .from(orders)
        .where(eq(orders.botId, botId))
        .then((x) => x.length > 0),
    );
    const [row] = await db.select().from(orders).where(eq(orders.botId, botId));
    const id = row?.clOrdId ?? "";
    const qty = row?.size ?? "0";
    expect(row?.status).toBe("unknown");
    // Hết thời gian chờ khớp: chiến lược huỷ lệnh vào và chờ SoDEX xác nhận. Chưa có trade nào ở đâu.
    clock += 11_000;
    await e.tick();
    expect((await farmState(botId))?.orders[id]?.cancelAt).toBeDefined();
    expect((await farmState(botId))?.orders[id]?.done).not.toBe(true);
    // Như đã được SoDEX nhận (có orderID) và lần tra đầu đã xác nhận không thấy từ lâu. Trade của lệnh chỉ xuất hiện trong
    // lịch sử khớp ngay trước vòng bỏ cuộc: bước `reconcile` chạy trước lưới an toàn fill trong vòng, nên chỉ đường bỏ
    // cuộc của Volume Farm (`#farmGaveUp`) ghi được trade này.
    await db
      .update(orders)
      .set({ sodexOrderId: 78n, missingConfirmedAt: new Date(clock - 11 * 60_000) })
      .where(eq(orders.clOrdId, id));
    const t = {
      tradeId: 60_000n + BigInt(Math.floor(Math.random() * 1e12)),
      price: "100",
      quantity: qty,
      fee: "0.02",
      builderFee: null,
      isMaker: true,
      at: clock,
    };
    gw.trades.set(id, [t]);
    clock += 1_000;
    await e.tick();
    const after = (await db.select().from(orders).where(eq(orders.clOrdId, id)))[0];
    expect(after?.unknownGaveUpAt).not.toBeNull();
    // Trade được ghi đúng một lần (fill thật, đủ khối lượng của lệnh).
    const booked = await db
      .select()
      .from(fills)
      .where(eq(fills.orderId, after?.id ?? ""));
    expect(booked.map((f) => [f.sodexTradeId, Number(f.size)])).toEqual([[t.tradeId, Number(qty)]]);
    expect(Number(after?.filledSize)).toBe(Number(qty));
    expect(warned).toContain(
      "given-up order is confirmed missing on SoDEX; its trades are booked and the bot moves on",
    );
    // Trade được ghi TRƯỚC `orderDone`; lệnh vào kết thúc với đủ khối lượng, bot có vị thế và đặt stop trên SoDEX.
    expect(doneBeforeTrade).toEqual([false]);
    const st = (await farmState(botId)) as
      | {
          phase: string;
          ledger: { position: string };
          orders: Record<string, { done?: boolean; filled?: string }>;
        }
      | undefined;
    expect(st?.orders[id]?.done).toBe(true);
    expect(Number(st?.orders[id]?.filled)).toBe(Number(qty));
    expect(st?.phase).toBe("open");
    expect(Math.abs(Number(st?.ledger.position))).toBe(Number(qty));
    expect(gw.received.some((o) => o.market === "STX-USD" && o.stop !== undefined)).toBe(true);
    const events = await db.select().from(botEvents).where(eq(botEvents.botId, botId));
    expect(events.map((x) => x.decision)).not.toContain("Late fill added to the position");
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

  // ---------- Volume Farm: version mới khi đang có lượt mở (DEC-304) ----------

  it("waits to apply a Volume Farm version until the open trade closes, never cancelling its stop on SoDEX", async () => {
    // Prod 2026-11-17: lệnh vào khớp, stop gốc đặt; người dùng sửa bot → "Applied v2 — Cancelled 1 orders" huỷ stop
    // và v2 quên vị thế. Nay v2 chờ tới khi lượt đóng.
    const { eq } = await import("drizzle-orm");
    const gw = new FakeGateway();
    await seedCandles("ETH-USD");
    const { botId, accountId } = await seedFarm("ETH-USD");
    let e = farmEngine(gw, "vf-version");
    const vf = () => gw.received.filter((o) => o.market === "ETH-USD" && o.tag.startsWith("vf:"));
    await tickUntil(e, () => vf().length > 0);
    const entry = vf()[0];
    if (entry === undefined) throw new Error("expected an entry");
    await e.onFill(accountId, entry.clOrdID, entry.quantity, "100", "0.01", clock);
    const stop = vf().find((o) => o.stop !== undefined);
    expect(stop).toMatchObject({ reduceOnly: true, side: entry.side === "buy" ? "sell" : "buy" });
    await db.insert(botVersions).values({
      botId,
      version: 2,
      paramSource: "manual",
      status: "pending",
      config: { ...farmConfig("ETH-USD"), allowTaker: true },
    });
    const statuses = async () =>
      (await db.select().from(botVersions).where(eq(botVersions.botId, botId)))
        .map((v) => `${String(v.version)}:${v.status}`)
        .sort();
    const events = async () =>
      (await db.select().from(botEvents).where(eq(botEvents.botId, botId))).map((x) => x.decision);
    const runtime = async () =>
      (await db.select().from(botRuntime).where(eq(botRuntime.botId, botId)))[0]?.state as {
        phase: string;
        ledger: { position: string };
      };
    clock += 1_000;
    await e.tick();
    await e.tick();
    // Còn vị thế: v2 chờ, không huỷ lệnh nào (stop trên SoDEX còn nguyên), sổ cái giữ vị thế.
    expect(await statuses()).toEqual(["1:active", "2:pending"]);
    expect(gw.cancelled).not.toContain(stop?.clOrdID);
    expect((await events()).filter((d) => d === "Applying v2")).toHaveLength(1);
    expect(Number((await runtime()).ledger.position)).not.toBe(0);
    // Engine nạp lại bot (khởi động lại / đổi shard): không ghi lại "Applying v2".
    await e.stop();
    e = farmEngine(gw, "vf-version");
    await e.tick();
    expect((await events()).filter((d) => d === "Applying v2")).toHaveLength(1);
    // Hết thời gian giữ: v1 thoát bằng lệnh reduce-only.
    clock += 200_000;
    await tickUntil(e, () => vf().some((o) => o.reduceOnly && o.stop === undefined));
    const exit = vf().find((o) => o.reduceOnly && o.stop === undefined);
    if (exit === undefined) throw new Error("expected an exit");
    expect(await statuses()).toEqual(["1:active", "2:pending"]);
    await e.onFill(accountId, exit.clOrdID, exit.quantity, "100", "0.01", clock);
    expect((await runtime()).phase).toBe("idle");
    // Lượt đóng: stop trên SoDEX được huỷ ngay (#239 05:31, thay DEC-119); v2 chờ SoDEX xác nhận huỷ.
    expect(gw.cancelled).toContain(stop?.clOrdID);
    for (let i = 0; i < 6 && (await statuses())[1] !== "2:active"; i += 1) {
      clock += 5_000;
      await e.tick();
    }
    // Phẳng, stop đã xác nhận huỷ: v2 được áp.
    expect(await statuses()).toEqual(["1:superseded", "2:active"]);
    expect(await events()).toContain("Applied v2");
    await e.stop();
    await stopFarmBots();
  });

  it("marks a Volume Farm version still waiting as superseded when the bot stops (DEC-304)", async () => {
    const { eq } = await import("drizzle-orm");
    const gw = new FakeGateway();
    await seedCandles("DOT-USD");
    const { botId, accountId } = await seedFarm("DOT-USD");
    const e = farmEngine(gw, "vf-version-stop");
    const vf = () => gw.received.filter((o) => o.market === "DOT-USD" && o.tag.startsWith("vf:"));
    await tickUntil(e, () => vf().length > 0);
    const entry = vf()[0];
    if (entry === undefined) throw new Error("expected an entry");
    await e.onFill(accountId, entry.clOrdID, entry.quantity, "100", "0.01", clock);
    await db.insert(botVersions).values({
      botId,
      version: 2,
      paramSource: "manual",
      status: "pending",
      config: { ...farmConfig("DOT-USD"), allowTaker: true },
    });
    clock += 1_000;
    await e.tick();
    await db.update(bots).set({ state: "stopping" }).where(eq(bots.id, botId));
    for (let i = 0; i < 10 && (await botState(botId))?.state !== "stopped"; i += 1) {
      clock += 3_000;
      await e.tick();
    }
    expect((await botState(botId))?.state).toBe("stopped");
    const statuses = (await db.select().from(botVersions).where(eq(botVersions.botId, botId)))
      .map((v) => `${String(v.version)}:${v.status}`)
      .sort();
    expect(statuses).toEqual(["1:active", "2:superseded"]);
    await e.stop();
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
    expect(gw.readsBy).toContain(accountId);
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
    // Đếm theo account của bot này: bot Perps của test khác (account khác) cũng được kiểm tra vị thế.
    const reads = gw.readsBy.filter((a) => a === accountId).length;
    clock += 30_000;
    await e.tick();
    expect(gw.readsBy.filter((a) => a === accountId).length).toBe(reads);
    expect((await makerState(botId)).ledger.position).toBe("0");
    await e.stop();
    await stopMakerBots();
    await db.update(bots).set({ state: "stopped" }).where(eq(bots.sodexAccountId, accountId));
  });

  /** Market Making: báo giá đầu tiên, rồi một nhịp refresh huỷ nó (SoDEX trả `cancelOutcome`). */
  async function makerCancelled(gw: FakeGateway, worker: string) {
    const { eq } = await import("drizzle-orm");
    const seeded = await seedMaker();
    const e = farmEngine(gw, worker);
    await e.tick();
    await e.onPrice("BTC-USD", "100000", clock);
    const id = gw.received.find((o) => o.tag.endsWith(":bid"))?.clOrdID ?? "";
    const row = async () => (await db.select().from(orders).where(eq(orders.clOrdId, id)))[0];
    // Quá CANCEL_NOT_BOOKED.windowMs sau khi SoDEX nhận: OrderNotFound nghĩa là lệnh không còn trên sổ.
    clock += 6_000;
    await e.tick();
    expect(gw.cancelled.filter((x) => x === id)).toHaveLength(1);
    return { ...seeded, e, id, row };
  }

  it("treats OrderNotFound on a cancel as off the book: no cancel retries, no unknown, the fill SoDEX has (DEC-308)", async () => {
    const gw = new FakeGateway();
    gw.cancelOutcome = "not_found";
    const { e, id, row } = await makerCancelled(gw, "vm-gone-filled");
    // Lệnh đã khớp hết trên SoDEX trước khi lệnh huỷ tới.
    const size = (await row())?.size ?? "0";
    gw.book.set(id, { status: "filled", filledQty: size, avgPrice: "100000", orderId: 77n });
    expect((await row())?.status).toBe("open");
    for (let i = 0; i < 3; i += 1) {
      clock += 6_000;
      await e.tick();
    }
    // Không huỷ lại; đối soát ghi đúng trạng thái cuối của SoDEX, không qua `unknown`.
    expect(gw.cancelled.filter((x) => x === id)).toHaveLength(1);
    const after = await row();
    expect(after?.status).toBe("filled");
    expect(Number(after?.filledSize)).toBe(Number(size));
    await e.stop();
    await stopMakerBots();
  });

  it("records a cancel that met OrderNotFound as cancelled when SoDEX has no trades, never unknown (DEC-308)", async () => {
    const gw = new FakeGateway();
    gw.cancelOutcome = "not_found";
    const { e, id, row } = await makerCancelled(gw, "vm-gone-none");
    gw.book.delete(id);
    const seen = new Set<string>();
    for (let i = 0; i < 6; i += 1) {
      clock += 8_000;
      await e.tick();
      seen.add((await row())?.status ?? "");
    }
    expect(seen.has("unknown")).toBe(false);
    expect((await row())?.status).toBe("cancelled");
    // Không huỷ lại mỗi 5 s: chỉ huỷ lại chậm (mỗi 15 s) và một lần huỷ thật ngay trước khi ghi `cancelled`.
    const sent = gw.cancelled.filter((x) => x === id).length;
    expect(sent).toBeGreaterThanOrEqual(2);
    expect(sent).toBeLessThanOrEqual(5);
    await e.stop();
    await stopMakerBots();
  });

  it("sends a real cancel before recording cancelled, and waits while that cancel is not confirmed (rule 1.7, review #216 M3)", async () => {
    const gw = new FakeGateway();
    gw.cancelOutcome = "not_found";
    const { e, id, row } = await makerCancelled(gw, "vm-gone-late");
    // REST không bao giờ thấy lệnh (lịch sử trễ), còn lệnh thật thì vào sổ muộn: lệnh huỷ sau đó chưa rõ kết quả.
    gw.book.delete(id);
    gw.cancelOutcome = "unknown";
    for (let i = 0; i < 6; i += 1) {
      clock += 8_000;
      await e.tick();
    }
    // Quá NOT_FOUND_AFTER_MS mà lần huỷ cuối chưa được xác nhận: chưa ghi là đã huỷ.
    expect((await row())?.status).toBe("open");
    const before = gw.cancelled.filter((x) => x === id).length;
    // Sàn xác nhận lệnh huỷ (lệnh còn sống và vừa được gỡ khỏi sổ): giờ mới ghi `cancelled`.
    gw.cancelOutcome = "ok";
    for (let i = 0; i < 4 && (await row())?.status !== "cancelled"; i += 1) {
      clock += 8_000;
      await e.tick();
    }
    expect(gw.cancelled.filter((x) => x === id).length).toBeGreaterThan(before);
    expect((await row())?.status).toBe("cancelled");
    await e.stop();
    await stopMakerBots();
  });

  it("does not record cancelled when the final cancel is refused as a whole request (429) (review #216 F1)", async () => {
    const gw = new FakeGateway();
    gw.cancelOutcome = "not_found";
    const { e, id, row } = await makerCancelled(gw, "vm-gone-429");
    gw.book.delete(id);
    const base = gw.cancel.bind(gw);
    let limited = true;
    gw.cancel = (a, list) =>
      limited
        ? Promise.resolve(
            list.map((x): CancelResult => ({
              clOrdID: x.clOrdID,
              outcome: "rejected",
              code: "-429",
              scope: "request",
            })),
          )
        : base(a, list);
    for (let i = 0; i < 6; i += 1) {
      clock += 8_000;
      await e.tick();
    }
    // SoDEX chưa xử lý lệnh huỷ nào: lệnh có thể còn sống, chưa ghi là đã huỷ.
    expect((await row())?.status).toBe("open");
    limited = false;
    // Huỷ bị từ chối cả request lặp lại thì chờ tới 60 s mới huỷ lại (DEC-310).
    for (let i = 0; i < 14 && (await row())?.status !== "cancelled"; i += 1) {
      clock += 8_000;
      await e.tick();
    }
    expect((await row())?.status).toBe("cancelled");
    await e.stop();
    await stopMakerBots();
  });

  it("lets the next lookup record the final status when the final cancel finds the order still live (review #216 F1)", async () => {
    const gw = new FakeGateway();
    gw.cancelOutcome = "not_found";
    const { e, id, row } = await makerCancelled(gw, "vm-gone-live");
    gw.book.delete(id);
    const start = clock;
    const base = gw.cancel.bind(gw);
    const sodex = { live: false };
    // Lần huỷ đầu tiên sau ~38 s là lần huỷ cuối của đối soát: SoDEX gỡ lệnh còn sống khỏi sổ.
    gw.cancel = (a, list) => {
      if (!sodex.live && clock - start >= 38_000) {
        sodex.live = true;
        gw.cancelled.push(...list.map((x) => x.clOrdID));
        return Promise.resolve(
          list.map((x): CancelResult => ({ clOrdID: x.clOrdID, outcome: "ok" })),
        );
      }
      return base(a, list);
    };
    for (let i = 0; i < 8 && !sodex.live; i += 1) {
      clock += 8_000;
      await e.tick();
    }
    expect(sodex.live).toBe(true);
    // Không ghi `cancelled` ngay: lệnh có thể đã khớp một phần ngay trước lúc bị gỡ.
    expect((await row())?.status).toBe("open");
    const size = (await row())?.size ?? "0";
    const part = (Number(size) / 2).toString();
    gw.book.set(id, { status: "cancelled", filledQty: part, avgPrice: "100000", orderId: 78n });
    clock += 8_000;
    await e.tick();
    const after = await row();
    expect(after?.status).toBe("cancelled");
    expect(Number(after?.filledSize)).toBe(Number(part));
    await e.stop();
    await stopMakerBots();
  });

  it("backs off cancels SoDEX refuses as a whole request: 5 s, 15 s, then 60 s, one warning per step (DEC-310)", async () => {
    const gw = new FakeGateway();
    const warnings: string[] = [];
    const calls: number[] = [];
    gw.cancel = (_a, list) => {
      calls.push(clock);
      return Promise.resolve(
        list.map((x): CancelResult => ({
          clOrdID: x.clOrdID,
          outcome: "rejected",
          code: "-1",
          scope: "request",
        })),
      );
    };
    const { accountId } = await seedMaker();
    const e = new Engine({
      db,
      redis: newRedis(),
      gateway: gw,
      workerId: "vm-cancel-backoff",
      log: {
        ...log,
        warn: (_o: unknown, msg?: string) => {
          warnings.push(msg ?? "");
        },
      },
      now,
      leaseTtlMs: 30_000,
      shards: SHARDS,
      rules: () => Promise.resolve(rules),
      feeCheckMs: 0,
      orderbook: () =>
        Promise.resolve({ bid: "100", ask: "100.05", bidNotional: "50000", askNotional: "40000" }),
    });
    await e.tick();
    await e.onPrice("BTC-USD", "100000", clock);
    for (let i = 0; i < 120; i += 1) {
      clock += 1_000;
      await e.tick();
    }
    // Nhịp gửi huỷ của account: nấc chờ 5 s, 15 s, rồi 60 s (giữ 60 s); không có lần huỷ nào trong lúc chờ.
    const times = [...new Set(calls)];
    const gaps = times.slice(1).map((t, i) => t - (times[i] ?? t));
    expect(gaps.length).toBeGreaterThanOrEqual(3);
    expect(gaps[0]).toBeGreaterThanOrEqual(CANCEL_REQUEST_BACKOFF_MS[0]);
    expect(gaps[1]).toBeGreaterThanOrEqual(CANCEL_REQUEST_BACKOFF_MS[1]);
    for (const g of gaps.slice(2)) expect(g).toBeGreaterThanOrEqual(CANCEL_REQUEST_BACKOFF_MS[2]);
    // Một dòng warn mỗi nấc, không mỗi lần bị từ chối; không có warn "cancel not confirmed" cho từng lệnh.
    expect(
      warnings.filter(
        (w) => w === "SoDEX refused the cancel request; cancelling again after a backoff",
      ),
    ).toHaveLength(3);
    expect(warnings.filter((w) => w === "cancel not confirmed")).toHaveLength(0);
    // Người dùng cấp key mới (Renew key): nấc chờ của key cũ bỏ ngay, vòng kế tiếp huỷ lại luôn.
    const { eq } = await import("drizzle-orm");
    const before = calls.length;
    const [k] = await db.select().from(apiKeys).where(eq(apiKeys.sodexAccountId, accountId));
    await db
      .update(apiKeys)
      .set({ status: "deleted" })
      .where(eq(apiKeys.sodexAccountId, accountId));
    await db.insert(apiKeys).values({
      sodexAccountId: accountId,
      name: "DRIFT2",
      publicKey: k?.publicKey ?? "0x1563915e194D8CfBA1943570603F7606A3115508",
      ciphertext: "vault:v1:test2",
      kmsKeyRef: "test",
      last4: "5509",
      permissionsMask: 14,
      expiresAt: new Date(clock + 1e10),
      status: "active",
    });
    clock += 1_000;
    await e.tick();
    expect(calls.length).toBeGreaterThan(before);
    await e.stop();
    await stopMakerBots();
  });

  it("cancels again when an order SoDEX called not found is on the book after all (DEC-250, DEC-308)", async () => {
    const gw = new FakeGateway();
    gw.cancelOutcome = "not_found";
    const { e, id, row } = await makerCancelled(gw, "vm-gone-booked");
    // SoDEX vẫn có lệnh trên sổ (vào sổ muộn): đối soát thấy `open` thì huỷ lại.
    gw.cancelOutcome = "ok";
    for (let i = 0; i < 3 && gw.cancelled.filter((x) => x === id).length < 2; i += 1) {
      clock += 6_000;
      await e.tick();
    }
    expect(gw.cancelled.filter((x) => x === id)).toHaveLength(2);
    expect((await row())?.status).toBe("cancelled");
    await e.stop();
    await stopMakerBots();
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
    // Bot paper không bao giờ báo team (#241), kể cả khi lệnh bị từ chối làm bot pause.
    expect(await botState(botId)).toMatchObject({
      state: "paused",
      reasonCode: ReasonCode.orderRejected,
    });
    expect(await teamIncidents(botId)).toEqual([]);
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
      // Như HttpGateway: SoDEX trả OrderNotFound khi lệnh chưa vào sổ.
      if (this.arriving.has(x.clOrdID)) return { clOrdID: x.clOrdID, outcome: "not_found" };
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
    // Báo team một lần (#241): bot id, market, lý do; không email / ví / key.
    const incidents = await teamIncidents(botId);
    expect(incidents).toHaveLength(1);
    expect(incidents[0]).toMatchObject({ kind: "paused_errors", market: "BTC-USD" });
    expect(incidents[0]?.detail).toMatch(/^ORDER_REJECTED · insufficient margin \(\d rejects\)$/);
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

describe("one read per tick, not per shard (DEC-301)", () => {
  // Database riêng, sạch: số truy vấn chỉ phụ thuộc dữ liệu của test này.
  let clean: Db;
  let counted = 0;
  let cleanPool: ReturnType<typeof createDb>["pool"];
  beforeAll(async () => {
    const admin = createDb(pg.getConnectionUri());
    await admin.pool.query("CREATE DATABASE tick_batch");
    await admin.pool.end();
    const url = pg.getConnectionUri().replace(/\/[^/?]+(\?|$)/, "/tick_batch$1");
    await runMigrations(url);
    ({ pool: cleanPool } = createDb(url));
    clean = drizzle(cleanPool, {
      schema,
      logger: {
        logQuery: () => {
          counted += 1;
        },
      },
    });
  });
  afterAll(async () => {
    await cleanPool.end();
  });
  afterEach(() => {
    counted = 0;
  });

  /** Số truy vấn của một vòng `tick` ổn định (vòng thứ 3: bot đã nạp, shard đã nhận) với `shards` shard. */
  async function queriesPerTick(shards: number, gw: Gateway): Promise<number> {
    await newRedis().flushall();
    const e = new Engine({
      db: clean,
      redis: newRedis(),
      gateway: gw,
      paper: new PaperGateway({ db: clean, now }),
      workerId: `count-${String(shards)}`,
      log,
      now,
      leaseTtlMs: 30_000,
      shards,
      rules: () => Promise.resolve(rules),
      feeCheckMs: 0,
    });
    await e.tick();
    await e.tick();
    counted = 0;
    await e.tick();
    const n = counted;
    await e.stop();
    return n;
  }

  it("runs the same number of queries per tick with 4 or 64 shards, and never reads the builder fee of a paper-only account", async () => {
    const { eq } = await import("drizzle-orm");
    const live = await seedBot("running", undefined, clean);
    await seedBot("running", undefined, clean);
    await seedBot("running", undefined, clean);
    const paper = await seedBot("running", undefined, clean);
    await clean.update(bots).set({ mode: "paper" }).where(eq(bots.id, paper.botId));
    await clean.insert(paperAccounts).values({
      botId: paper.botId,
      capital: "1000",
      cash: "1000",
      positions: {},
      peakEquity: "1000",
      startedAt: new Date(clock),
    });
    const gw = new (class extends FakeGateway {
      readonly feeChecks: string[] = [];
      override builderApproved(account?: AccountRef): Promise<boolean> {
        this.feeChecks.push(account?.id ?? "");
        return super.builderApproved();
      }
    })();
    const few = await queriesPerTick(4, gw);
    const many = await queriesPerTick(64, gw);
    expect(few).toBeGreaterThan(0);
    // Trước đây mỗi shard tự đọc account (2 lần), lệnh `unknown`, lệnh đang mở: 64 shard ≈ 16 lần 4 shard.
    expect(many).toBe(few);
    expect(gw.feeChecks).toContain(live.accountId);
    expect(gw.feeChecks).not.toContain(paper.accountId);
  });

  it("logs a failed snapshot read and returns normally, skipping shard work for that tick", async () => {
    await seedBot("running", undefined, clean);
    await newRedis().flushall();
    let failing = false;
    // Db giả: mọi `select` ném lỗi khi `failing` (DB mất kết nối giữa chừng).
    const flaky = new Proxy(clean, {
      get(target, prop) {
        if (prop === "select" && failing)
          return () => {
            throw new Error("db down");
          };
        const v: unknown = Reflect.get(target, prop);
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    });
    const errors: string[] = [];
    const gw = new (class extends FakeGateway {
      feeChecks = 0;
      override builderApproved(): Promise<boolean> {
        this.feeChecks += 1;
        return super.builderApproved();
      }
    })();
    const e = new Engine({
      db: flaky,
      redis: newRedis(),
      gateway: gw,
      workerId: "snapshot-fails",
      log: {
        info: () => undefined,
        warn: () => undefined,
        error: (_obj: unknown, msg?: string) => {
          errors.push(msg ?? "");
        },
      },
      now,
      leaseTtlMs: 30_000,
      shards: SHARDS,
      rules: () => Promise.resolve(rules),
      feeCheckMs: 0,
    });
    await e.tick();
    const checks = gw.feeChecks;
    expect(checks).toBeGreaterThan(0);
    failing = true;
    clock += 1;
    await expect(e.tick()).resolves.toBeUndefined();
    expect(errors).toContain("tick snapshot failed; skipping shard work this tick");
    expect(gw.feeChecks).toBe(checks);
    // DB trở lại: vòng sau chạy bình thường.
    failing = false;
    clock += 1;
    await e.tick();
    expect(gw.feeChecks).toBeGreaterThan(checks);
    await e.stop();
  });
});

describe("shard leases renew on their own timer (DEC-302)", () => {
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

describe("lease checks keep saved state and orders in step (DEC-302 review)", () => {
  // DB sạch (#225): các test Stop ở đây chạy hàng trăm vòng `tick`; ở DB chung mỗi vòng còn đối soát lệnh mở và nạp bot
  // còn chạy của mọi test trước, nên "backs off and gives up on a close…" quá 30 s khi máy bận (chạy riêng ~9 s).
  useCleanDb("lease_checks");
  /** Lease "mất xác nhận": đồng hồ đơn điệu vượt hạn và script gia hạn của Redis lỗi. */
  interface LeaseCtl {
    lose: () => void;
    restore: () => void;
    /** Lần gọi Redis gia hạn kế tiếp treo tới khi `release()` (rồi lỗi); `started` xong khi nó bắt đầu. */
    hold: () => { started: Promise<void>; release: () => void };
  }
  const flaky = (
    gw: Gateway,
    workerId: string,
    opts: { db?: Db; logs?: string[] } = {},
  ): { e: RealEngine; ctl: LeaseCtl } => {
    let mono = 0;
    let down = false;
    let held: { start: () => void; gate: Promise<void> } | null = null;
    const real = newRedis();
    const redis = new Proxy(real, {
      get(target, prop) {
        if (prop === "eval" && held !== null) {
          const h = held;
          held = null;
          return () => {
            h.start();
            return h.gate.then(() => Promise.reject(new Error("redis down")));
          };
        }
        if (prop === "eval" && down) return () => Promise.reject(new Error("redis down"));
        const v: unknown = Reflect.get(target, prop);
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    });
    const logs = opts.logs;
    const e = new Engine({
      db: opts.db ?? db,
      redis,
      gateway: gw,
      workerId,
      log: {
        info: () => undefined,
        warn: (_o: unknown, msg?: string) => logs?.push(msg ?? ""),
        error: () => undefined,
      },
      now,
      leaseTtlMs: 60_000,
      shards: SHARDS,
      rules: () => Promise.resolve(rules),
      feeCheckMs: 0,
      monotonic: () => mono,
    });
    return {
      e,
      ctl: {
        lose: () => {
          mono += 1e9;
          down = true;
        },
        hold: () => {
          let start: () => void = () => undefined;
          let release: () => void = () => undefined;
          const started = new Promise<void>((r) => {
            start = r;
          });
          const gate = new Promise<void>((r) => {
            release = r;
          });
          held = { start, gate };
          return { started, release };
        },
        // Redis trở lại và thời gian trôi qua (quá chu kỳ gia hạn, nên lần gia hạn kế tiếp được thử ngay).
        restore: () => {
          down = false;
          mono += 60_000;
        },
      },
    };
  };
  const ordersOf = async (botId: string) => {
    const { eq } = await import("drizzle-orm");
    return db.select().from(orders).where(eq(orders.botId, botId));
  };
  const runtimeOf = async (botId: string) => {
    const { eq } = await import("drizzle-orm");
    const [rt] = await db.select().from(botRuntime).where(eq(botRuntime.botId, botId));
    return rt;
  };
  const longGrid = (market: string) => ({
    strategy: "futures_grid",
    market,
    engine: "perps" as const,
    config: {
      market,
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
  const spotGridOn = (market: string) => ({
    strategy: "spot_grid",
    market,
    engine: "spot" as const,
    config: {
      market,
      lowerPrice: "90",
      upperPrice: "110",
      gridLevels: 5,
      spacing: "arithmetic",
      investment: "500",
      maxLoss: "100",
      onStop: "keep_base",
    },
  });
  // Bot của các test trước không chạy trong các test này (đếm lệnh / giao dịch chỉ của bot đang xét).
  beforeEach(async () => {
    const { inArray } = await import("drizzle-orm");
    await db
      .update(bots)
      .set({ state: "paused" })
      .where(inArray(bots.state, ["starting", "running", "pausing", "resuming", "stopping"]));
  });

  it("rolls a market step back when the lease is lost after the step, and re-places the same orders later", async () => {
    let ctl: LeaseCtl | null = null;
    const gw = new (class extends FakeGateway {
      // Lease mất đúng lúc chiến lược đang tính (sau kiểm tra đầu `#feed`, trước `#execute`).
      override readLeverage(a: AccountRef, market: string) {
        ctl?.lose();
        ctl = null;
        return super.readLeverage(a, market);
      }
    })();
    const { botId } = await seedBot("running", longGrid("RB-USD"));
    const f = flaky(gw, "rollback");
    await f.e.tick();
    ctl = f.ctl;
    await expect(f.e.onPrice("RB-USD", "100", clock)).rejects.toBeInstanceOf(LeaseExpiredError);
    expect(gw.received).toHaveLength(0);
    expect(await ordersOf(botId)).toHaveLength(0);
    // Lease xác nhận lại: bước chạy lại từ state cũ và gửi đúng các lệnh đó, kể cả lệnh mở vị thế đầu tiên.
    f.ctl.restore();
    await f.e.onPrice("RB-USD", "100", clock);
    expect(gw.received.map((o) => o.tag)).toContain("grid:init");
    expect(await ordersOf(botId)).toHaveLength(gw.received.length);
    await f.e.stop();
  });

  it("still writes and sends the orders a fill produces while the lease can't be confirmed, so the saved state never claims orders that don't exist", async () => {
    const gw = new FakeGateway();
    const { botId, accountId } = await seedBot("running", spotGridOn("vFILL_vUSDC"));
    const f = flaky(gw, "fill");
    await f.e.tick();
    await f.e.onPrice("vFILL_vUSDC", "100", clock);
    const init = gw.received.find((o) => o.tag === "grid:init");
    expect(init).toBeDefined();
    f.ctl.lose();
    // Fill (sự kiện sổ cái) không bị chặn: fencing epoch ở DB bảo vệ.
    await f.e.onFill(accountId, init?.clOrdID ?? "", init?.quantity ?? "0", "100", "0", clock);
    const rows = await ordersOf(botId);
    const ids = new Set(rows.map((o) => o.clOrdId));
    const st = (await runtimeOf(botId))?.state as { open?: Record<string, unknown> };
    const claimed = Object.keys(st.open ?? {});
    expect(claimed.length).toBeGreaterThan(0);
    for (const id of claimed) expect(ids.has(id)).toBe(true);
    expect(gw.received.some((o) => o.side === "sell")).toBe(true);
    f.ctl.restore();
    await f.e.stop();
  });

  /** Bot Perps đang chạy có vị thế long 2 trong sổ cái, người dùng bấm Stop kèm Close position. */
  async function stoppingWithPosition(gw: FakeGateway, market: string, workerId: string) {
    const { eq } = await import("drizzle-orm");
    const { botId } = await seedBot("running", longGrid(market));
    const f = flaky(gw, workerId);
    await f.e.tick();
    await f.e.onPrice(market, "100", clock);
    const st = (await runtimeOf(botId))?.state as { ledger: Record<string, string> };
    await db
      .update(botRuntime)
      .set({ state: { ...st, ledger: { ...st.ledger, position: "2", avgCost: "100" } } })
      .where(eq(botRuntime.botId, botId));
    // Nạp lại runner với sổ cái mới: engine mới cùng worker sau khi engine cũ dừng.
    await f.e.stop();
    await db.update(bots).set({ state: "stopping", closeOnStop: true }).where(eq(bots.id, botId));
    const g = flaky(gw, `${workerId}-2`);
    return { botId, ...g };
  }

  it("keeps the bot stopping and sends the close later when the lease is lost during Stop", async () => {
    let lose: (() => void) | null = null;
    const gw = new (class extends FakeGateway {
      // Lease mất trong lúc Stop đang huỷ lệnh mở (trước khi gửi lệnh đóng).
      override cancel(a: AccountRef, list: readonly { clOrdID: string }[]) {
        lose?.();
        lose = null;
        return super.cancel(a, list);
      }
    })();
    const { botId, e, ctl } = await stoppingWithPosition(gw, "STOPL-USD", "stop-lease");
    gw.received.length = 0;
    lose = ctl.lose;
    clock += 1;
    await e.tick();
    expect((await botState(botId))?.state).toBe("stopping");
    // Không ghi dòng lệnh đóng nào: lần sau gửi mới, không bị unique chặn.
    expect((await ordersOf(botId)).filter((o) => o.tag === "close")).toHaveLength(0);
    ctl.restore();
    clock += 1;
    await e.tick();
    expect(gw.received.filter((o) => o.tag === "close")).toEqual([
      expect.objectContaining({ side: "sell", quantity: "2", reduceOnly: true }),
    ]);
    expect((await botState(botId))?.state).toBe("stopped");
    await e.stop();
  });

  it("after a restart with no symbol list and the IP bucket under the read reserve, the Stop close is not left unknown and goes out once symbols can be read (DEC-310)", async () => {
    const fake = new FakeGateway();
    const market = "STOPC-USD";
    // Cổng thật cho `submit` (đọc id symbol rồi ký và gửi), cổng giả cho mọi thứ khác.
    let cold = false;
    const writes: string[] = [];
    const rest = {
      getSpotSymbols: () => Promise.resolve([]),
      getPerpsSymbols: () =>
        cold
          ? Promise.reject(new AppError(ErrorCode.rateLimited, "SoDEX rate limit reached"))
          : Promise.resolve([
              {
                id: 7n,
                name: market,
                tickSize: "1",
                stepSize: "0.0001",
                minQuantity: "0.0001",
                minNotional: "5",
                status: "TRADING",
              },
            ]),
    } as unknown as SodexRestClient;
    const writer = {
      write: (req: { body: string }) => {
        const ids = [...req.body.matchAll(/"clOrdID":"([^"]+)"/g)].map((m) => m[1] ?? "");
        writes.push(...ids);
        return Promise.resolve({
          outcome: "ok",
          data: ids.map((clOrdID, i) => ({ code: 0, clOrdID, orderID: 900 + i })),
        });
      },
    } as unknown as SignedWriteClient;
    const signer = { sign: () => Promise.resolve(`0x01${"ab".repeat(65)}` as `0x${string}`) };
    let http = new HttpGateway(rest, writer, signer, 1645n);
    const gw: Gateway = new Proxy(fake, {
      get(target, prop) {
        if (prop === "submit") return http.submit.bind(http);
        const v: unknown = Reflect.get(target, prop);
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    });
    const { botId, e } = await stoppingWithPosition(gw as FakeGateway, market, "stop-cold");
    // Khởi động lại: cổng mới (chưa biết market nào), bucket IP dưới mức dự trữ nên đọc danh sách symbol bị bỏ.
    http = new HttpGateway(rest, writer, signer, 1645n);
    cold = true;
    writes.length = 0;
    clock += 1;
    await e.tick();
    // Lệnh đóng chưa rời DeskLabs: không có dòng `unknown`, bot vẫn `stopping` và chờ thử lại.
    expect(
      (await ordersOf(botId)).filter((o) => o.tag === "close" && o.status === "unknown"),
    ).toHaveLength(0);
    expect((await botState(botId))?.state).toBe("stopping");
    expect(writes).toHaveLength(0);
    cold = false;
    for (let i = 0; i < 4 && (await botState(botId))?.state !== "stopped"; i += 1) {
      clock += CLOSE_RETRY.backoffMs[0];
      await e.tick();
    }
    const close = (await ordersOf(botId)).filter((o) => o.tag === "close");
    expect(close).toHaveLength(1);
    expect(close[0]?.status).not.toBe("unknown");
    expect(writes).toContain(close[0]?.clOrdId);
    expect((await botState(botId))?.state).toBe("stopped");
    await e.stop();
  });

  it("retries a close the signer could not send instead of stopping with the position open", async () => {
    const gw = new FakeGateway();
    const { botId, e } = await stoppingWithPosition(gw, "STOPS-USD", "stop-signer");
    gw.received.length = 0;
    gw.notSent = "signer_unavailable";
    clock += 1;
    await e.tick();
    expect((await botState(botId))?.state).toBe("stopping");
    gw.notSent = null;
    // Lần thử lại theo nấc: 5 s sau lần đầu.
    clock += CLOSE_RETRY.backoffMs[0];
    await e.tick();
    expect(gw.received.filter((o) => o.tag === "close")).toEqual([
      expect.objectContaining({ side: "sell", quantity: "2", reduceOnly: true }),
    ]);
    expect((await botState(botId))?.state).toBe("stopped");
    await e.stop();
  });

  it("feeds Resume to the strategy even when the lease is lost right after the bot moved to running", async () => {
    const { eq } = await import("drizzle-orm");
    // Bot ở shard 0 (shard xử lý đầu tiên mỗi vòng): transaction đầu tiên của vòng là lần chuyển sang running.
    let seeded = await seedBot("running");
    while (shardOf(seeded.accountId, SHARDS) !== 0) {
      await db.update(bots).set({ state: "paused" }).where(eq(bots.id, seeded.botId));
      seeded = await seedBot("running");
    }
    const { botId } = seeded;
    let armed: (() => void) | null = null;
    const hooked = new Proxy(db, {
      get(target, prop) {
        const v: unknown = Reflect.get(target, prop);
        if (prop === "transaction" && typeof v === "function")
          return async (...args: unknown[]) => {
            const out: unknown = await (v as (...a: unknown[]) => Promise<unknown>).apply(
              target,
              args,
            );
            armed?.();
            armed = null;
            return out;
          };
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    });
    const gw = new FakeGateway();
    gw.reject = { code: "-1", message: "insufficient balance" };
    const f = flaky(gw, "resume", { db: hooked });
    await f.e.tick();
    await f.e.onPrice("vBTC_vUSDC", "100", clock);
    clock += 1;
    await f.e.tick();
    expect((await botState(botId))?.state).toBe("paused");
    gw.reject = null;
    const before = gw.received.length;
    await f.e.onPrice("vBTC_vUSDC", "102", clock);
    await db.update(bots).set({ state: "resuming", reasonCode: null }).where(eq(bots.id, botId));
    armed = f.ctl.lose;
    clock += 1;
    await f.e.tick();
    expect((await botState(botId))?.state).toBe("running");
    // `resumed` không bị bỏ sau khi trạng thái đã commit: lưới được dựng lại.
    expect(gw.received.length).toBeGreaterThan(before);
    f.ctl.restore();
    await f.e.stop();
  });

  const eventsOf = async (botId: string, decision: string) => {
    const { and, eq } = await import("drizzle-orm");
    return db
      .select()
      .from(botEvents)
      .where(and(eq(botEvents.botId, botId), eq(botEvents.decision, decision)));
  };

  it("sends the close again when its first send timed out and SoDEX never got it (reconciled not_placed)", async () => {
    const gw = new FakeGateway();
    const { botId, e } = await stoppingWithPosition(gw, "STOPT-USD", "stop-timeout");
    gw.received.length = 0;
    gw.timeoutNext = "lost";
    clock += 1;
    await e.tick();
    expect((await botState(botId))?.state).toBe("stopping");
    expect((await ordersOf(botId)).find((o) => o.tag === "close")?.status).toBe("unknown");
    // Không thấy trên SoDEX sau thời gian chờ: đối soát ghi not_placed (không có mã), Stop gửi lại cùng clOrdID sau nấc
    // chờ đầu tiên.
    clock += 31_000;
    await e.tick();
    clock += 1;
    await e.tick();
    expect(gw.received.filter((o) => o.tag === "close")).toHaveLength(0);
    clock += CLOSE_RETRY.backoffMs[0];
    await e.tick();
    expect(gw.received.filter((o) => o.tag === "close")).toEqual([
      expect.objectContaining({ side: "sell", quantity: "2", reduceOnly: true }),
    ]);
    expect((await botState(botId))?.state).toBe("stopped");
    await e.stop();
  });

  it("sends the close again after a shard handover left it unknown (stale_epoch at the signer)", async () => {
    const { eq } = await import("drizzle-orm");
    let handover: (() => Promise<void>) | null = null;
    const gw = new (class extends FakeGateway {
      // Worker khác nhận shard đúng lúc lệnh đóng đang ký: signer từ chối epoch cũ (stale_epoch).
      override async submit(
        a: AccountRef,
        list: readonly OrderIntent[],
        fence: Fence,
        rate?: number,
      ): Promise<SubmitResult[]> {
        const h = handover;
        if (h !== null && list.some((o) => o.tag === "close")) {
          handover = null;
          await h();
          return list.map((o) => ({
            clOrdID: o.clOrdID,
            outcome: "not_sent" as const,
            code: "stale_epoch" as const,
          }));
        }
        return super.submit(a, list, fence, rate);
      }
    })();
    const { botId, accountId, e } = await (async () => {
      const x = await stoppingWithPosition(gw, "STOPE-USD", "stop-handover");
      const [b] = await db.select().from(bots).where(eq(bots.id, x.botId));
      return { ...x, accountId: b?.sodexAccountId ?? "" };
    })();
    const shard = shardOf(accountId, SHARDS);
    handover = async () => {
      await db
        .update(shardEpochs)
        .set({ epoch: (e.epochOf(shard) ?? 0) + 1, owner: "other" })
        .where(eq(shardEpochs.shard, shard));
    };
    gw.received.length = 0;
    clock += 1;
    await e.tick();
    // Worker cũ không ghi được not_placed (fencing): dòng lệnh đóng ở lại `unknown` cho chủ mới.
    expect((await ordersOf(botId)).find((o) => o.tag === "close")?.status).toBe("unknown");
    e.kill();
    await newRedis().del(`lease:shard:${String(shard)}`);
    const b = flaky(gw, "stop-handover-new");
    await b.e.tick();
    expect(b.e.ownedShards).toContain(shard);
    expect((await botState(botId))?.state).toBe("stopping");
    clock += 31_000;
    await b.e.tick();
    clock += 1;
    await b.e.tick();
    clock += CLOSE_RETRY.backoffMs[0];
    await b.e.tick();
    expect(gw.received.filter((o) => o.tag === "close")).toEqual([
      expect.objectContaining({ side: "sell", quantity: "2", reduceOnly: true }),
    ]);
    expect((await botState(botId))?.state).toBe("stopped");
    await b.e.stop();
  });

  it("finishes the Stop with the position open and one clear line when the API key can't sign the close", async () => {
    const gw = new FakeGateway();
    const { botId, e } = await stoppingWithPosition(gw, "STOPK-USD", "stop-key");
    gw.received.length = 0;
    gw.notSent = "key_unusable";
    clock += 1;
    await e.tick();
    clock += 1;
    await e.tick();
    const bot = await botState(botId);
    expect(bot?.state).toBe("stopped");
    expect(bot?.needsAttention).toBe(true);
    const lines = await eventsOf(botId, "Couldn't close your position");
    expect(lines.map((l) => l.why)).toEqual([
      "SoDEX didn't receive the close order (key_unusable). Your STOPK-USD position is still open — close it on SoDEX.",
    ]);
    expect(await teamIncidents(botId)).toEqual([
      {
        type: "team_incident",
        kind: "close_failed",
        botId,
        detail: "STOPK-USD position still open · close order not sent (key_unusable)",
      },
    ]);
    expect(await eventsOf(botId, "Can't sign with your API key")).toHaveLength(0);
    gw.notSent = null;
    await e.stop();
  });

  it("retries a close the signer keeps refusing on 5 s → 15 s → 60 s steps, logs it once, and gives up after 10 minutes", async () => {
    let submits = 0;
    const gw = new (class extends FakeGateway {
      override submit(
        a: AccountRef,
        list: readonly OrderIntent[],
        fence: Fence,
        rate?: number,
      ): Promise<SubmitResult[]> {
        if (list.some((o) => o.tag === "close")) submits += 1;
        return super.submit(a, list, fence, rate);
      }
    })();
    const { botId, e } = await stoppingWithPosition(gw, "STOPR-USD", "stop-retry");
    gw.notSent = "signer_unavailable";
    // 90 nhịp 1 s: thử ở 0 s, 5 s, 20 s, 80 s.
    for (let i = 0; i < 90; i += 1) {
      clock += 1_000;
      await e.tick();
    }
    expect(submits).toBe(4);
    expect((await botState(botId))?.state).toBe("stopping");
    expect(await eventsOf(botId, "Close order not sent")).toHaveLength(1);
    expect(await eventsOf(botId, "Paused: could not reach the signer")).toHaveLength(0);
    // Quá 10 phút vẫn chưa gửi được: kết thúc Stop, vị thế còn mở, báo một lần.
    clock += CLOSE_RETRY.giveUpMs;
    await e.tick();
    const bot = await botState(botId);
    expect(bot?.state).toBe("stopped");
    expect(bot?.needsAttention).toBe(true);
    expect(await eventsOf(botId, "Couldn't close your position")).toHaveLength(1);
    gw.notSent = null;
    await e.stop();
  });

  // Trần 90 s (#225): mô phỏng ~15 phút bằng ~160 vòng `tick` thật trên Postgres + Redis, ~10 s khi máy rảnh nhưng 23–45 s
  // khi máy dev chạy song song nhiều worktree (tải 1 phút 100–270 trên 16 luồng).
  it("backs off and gives up on a close whose sends keep timing out without reaching SoDEX", async () => {
    let submits = 0;
    const gw = new (class extends FakeGateway {
      override submit(
        a: AccountRef,
        list: readonly OrderIntent[],
        fence: Fence,
        rate?: number,
      ): Promise<SubmitResult[]> {
        if (list.some((o) => o.tag === "close")) {
          submits += 1;
          this.timeoutNext = "lost";
        }
        return super.submit(a, list, fence, rate);
      }
    })();
    const { botId, e } = await stoppingWithPosition(gw, "STOPW-USD", "stop-timeouts");
    // 4 phút nhịp 2 s (nấc nhỏ nhất của lịch là 5 s; nhịp 1 s gấp đôi số vòng mà không kiểm thêm gì, quá 30 s khi máy
    // bận, #225). Mỗi lần: gửi, ~30 s sau đối soát không thấy, chờ 5 s → 15 s → 60 s rồi gửi lại.
    for (let i = 0; i < 120; i += 1) {
      clock += 2_000;
      await e.tick();
    }
    expect(submits).toBe(4);
    expect((await botState(botId))?.state).toBe("stopping");
    expect((await eventsOf(botId, "Close order not sent")).map((l) => l.why)).toEqual([
      "SoDEX didn't receive the close order (NOT_PLACED). DeskLabs will try again.",
    ]);
    clock += CLOSE_RETRY.giveUpMs;
    for (let i = 0; i < 40 && (await botState(botId))?.state !== "stopped"; i += 1) {
      clock += 1_000;
      await e.tick();
    }
    const bot = await botState(botId);
    expect(bot?.state).toBe("stopped");
    expect(bot?.needsAttention).toBe(true);
    expect((await eventsOf(botId, "Couldn't close your position")).map((l) => l.why)).toEqual([
      "SoDEX didn't receive the close order (NOT_PLACED). Your STOPW-USD position is still open — close it on SoDEX.",
    ]);
    await e.stop();
  }, 90_000);

  it("does not undo a step over a fill that landed while the lease was being confirmed", async () => {
    const { eq } = await import("drizzle-orm");
    let armed: (() => void) | null = null;
    const hooked = new Proxy(db, {
      get(target, prop) {
        const v: unknown = Reflect.get(target, prop);
        if (prop === "transaction" && typeof v === "function")
          return async (...args: unknown[]) => {
            const out: unknown = await (v as (...a: unknown[]) => Promise<unknown>).apply(
              target,
              args,
            );
            armed?.();
            armed = null;
            return out;
          };
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    });
    const gw = new FakeGateway();
    const { botId, accountId } = await seedBot("running", longGrid("GAP-USD"));
    const f = flaky(gw, "gap", { db: hooked });
    await f.e.tick();
    await f.e.onPrice("GAP-USD", "100", clock);
    const init = gw.received.find((o) => o.tag === "grid:init");
    await f.e.onFill(accountId, init?.clOrdID ?? "", init?.quantity ?? "0", "100", "0", clock);
    const buy = gw.received.find((o) => o.side === "buy" && o.tag !== "grid:init");
    expect(buy).toBeDefined();
    const position = async () => {
      const [rt] = await db.select().from(botRuntime).where(eq(botRuntime.botId, botId));
      return (rt?.state as { ledger: { position: string } }).ledger.position;
    };
    const before = await position();
    // Giá thủng mức stop: bước chiến lược lưu state (transaction đầu tiên), rồi lease mất và lần gia hạn ở đầu `#execute`
    // treo. Trong lúc đó một fill tới và được ghi.
    const holder: { h: { started: Promise<void>; release: () => void } | null } = { h: null };
    armed = () => {
      f.ctl.lose();
      holder.h = f.ctl.hold();
    };
    const step = f.e.onPrice("GAP-USD", "79", clock).catch(() => undefined);
    for (let i = 0; i < 100 && holder.h === null; i += 1)
      await new Promise((r) => setTimeout(r, 10));
    const h = holder.h;
    expect(h).not.toBeNull();
    await h?.started;
    await f.e.onFill(
      accountId,
      buy?.clOrdID ?? "",
      buy?.quantity ?? "0",
      buy?.price ?? "0",
      "0",
      clock,
    );
    const afterFill = await position();
    expect(afterFill).not.toBe(before);
    h?.release();
    await step;
    // Fill vẫn còn trong sổ cái: bước không bị hoàn tác đè lên nó.
    expect(await position()).toBe(afterFill);
    f.ctl.restore();
    await f.e.stop();
  });
});

describe("lost fills (DEC-303)", () => {
  // DB sạch (#225): các test ở đây kiểm việc tra lệnh trong MỘT vòng; lệnh còn mở của test trước không được chen vào.
  useCleanDb("lost_fills");
  /** User stream giả: ghi account được mở, sẵn sàng khi test cho phép. */
  class FakeStreams {
    readonly opened: string[] = [];
    /** `account:engine` đã mở. */
    readonly openedKinds: string[] = [];
    /** `account:engine` đã subscribe xong. */
    readonly ready = new Set<string>();
    /** Không null: chỉ trả "sẵn sàng" cho chừng này lần hỏi nữa (stream đứt ngay sau đó). */
    budget: number | null = null;
    open(a: AccountRef, engine: "spot" | "perps"): void {
      if (!this.opened.includes(a.id)) this.opened.push(a.id);
      if (!this.openedKinds.includes(`${a.id}:${engine}`))
        this.openedKinds.push(`${a.id}:${engine}`);
    }
    isReady(id: string, engine: "spot" | "perps"): boolean {
      if (this.budget !== null) {
        if (this.budget <= 0) return false;
        this.budget -= 1;
        return true;
      }
      return this.ready.has(`${id}:${engine}`);
    }
    allow(id: string, ...engines: ("spot" | "perps")[]): void {
      for (const x of engines) this.ready.add(`${id}:${x}`);
    }
  }
  const streamEngine = (
    gw: Gateway,
    workerId: string,
    streams?: FakeStreams,
    ruleOf: () => Promise<typeof rules> = () => Promise.resolve(rules),
    dbOf: Db = db,
  ) =>
    new Engine({
      db: dbOf,
      redis: newRedis(),
      gateway: gw,
      workerId,
      log,
      now,
      leaseTtlMs: 30_000,
      shards: SHARDS,
      rules: ruleOf,
      feeCheckMs: 0,
      ...(streams === undefined
        ? {}
        : {
            userStreams: {
              open: (a: AccountRef, engine: "spot" | "perps") => {
                streams.open(a, engine);
              },
              ready: (id: string, engine: "spot" | "perps") => streams.isReady(id, engine),
            },
          }),
    });
  const orderOf = async (clOrdID: string) => {
    const { eq } = await import("drizzle-orm");
    return (await db.select().from(orders).where(eq(orders.clOrdId, clOrdID)))[0];
  };
  const fillsOf = async (orderId: string) => {
    const { eq } = await import("drizzle-orm");
    return db.select().from(fills).where(eq(fills.orderId, orderId));
  };
  const stopBot = async (botId: string) => {
    const { eq } = await import("drizzle-orm");
    await db.update(bots).set({ state: "stopped" }).where(eq(bots.id, botId));
  };
  const trade = (quantity: string, price = "100"): OrderTrade => ({
    tradeId: 50_000n + BigInt(Math.floor(Math.random() * 1e12)),
    price,
    quantity,
    fee: "0.02",
    builderFee: "0.001",
    isMaker: false,
    at: clock,
  });

  it("waits for the account's user stream, then records an entry IOC that filled while SoDEX history lagged", async () => {
    const { eq } = await import("drizzle-orm");
    const gw = new FakeGateway();
    const streams = new FakeStreams();
    const { botId, accountId } = await seedBot();
    const e = streamEngine(gw, "lost-first", streams);
    await e.tick();
    // Stream mở ngay trong vòng nạp bot, nhưng chưa subscribe xong: bot chưa đặt gì.
    expect(streams.opened).toContain(accountId);
    await e.onPrice("vBTC_vUSDC", "100", clock);
    expect(gw.received.filter((o) => o.tag.startsWith("grid:"))).toHaveLength(0);
    expect((await botState(botId))?.state).toBe("starting");

    streams.allow(accountId, "spot");
    await e.onPrice("vBTC_vUSDC", "100", clock);
    const init = gw.received.find((o) => o.tag === "grid:init");
    expect(init?.type).toBe("market");
    expect(init?.timeInForce).toBe("IOC");
    const id = init?.clOrdID ?? "";
    // Lệnh khớp ngay trên SoDEX, tin khớp không tới; REST lịch sử lệnh chưa có lệnh (trễ), lịch sử khớp thì có.
    gw.book.delete(id);
    const t = trade(init?.quantity ?? "0");
    gw.trades.set(id, [t]);
    clock += 6_000;
    await e.tick();

    const row = await orderOf(id);
    expect(row?.status).toBe("filled");
    expect(Number(row?.filledSize)).toBe(Number(init?.quantity));
    expect(row?.doneFedAt).not.toBeNull();
    const rows = await fillsOf(row?.id ?? "");
    expect(rows.map((f) => f.sodexTradeId)).toEqual([t.tradeId]);
    // Chiến lược nhận fill: đặt các mức bán chờ vị thế ban đầu.
    expect(gw.received.map((o) => o.tag)).toEqual(
      expect.arrayContaining(["grid:3:sell", "grid:4:sell"]),
    );
    const [rt] = await db.select().from(botRuntime).where(eq(botRuntime.botId, botId));
    const st = rt?.state as { ledger: { position: string } };
    expect(Number(st.ledger.position)).toBe(Number(init?.quantity));
    await e.stop();
    await stopBot(botId);
  });

  it("keeps the account's user stream open until the Stop's close order is done (DEC-308)", async () => {
    const { eq } = await import("drizzle-orm");
    const gw = new FakeGateway();
    const streams = new FakeStreams();
    const { botId, accountId } = await seedBot();
    streams.allow(accountId, "spot");
    const e = streamEngine(gw, "stream-hold", streams);
    const streamed = async () =>
      (await e.activeStreams()).some((x) => x.account.id === accountId && x.engines.has("spot"));
    await e.tick();
    await e.onPrice("vBTC_vUSDC", "100", clock);
    const init = gw.received.find((o) => o.tag === "grid:init");
    await e.onFill(accountId, init?.clOrdID ?? "", init?.quantity ?? "0", "100", "0", clock + 1);
    expect(await streamed()).toBe(true);
    // Người dùng Stop kèm Close position: lệnh đóng IOC được gửi rồi bot dừng ngay trong vòng này.
    await db.update(bots).set({ state: "stopping", closeOnStop: true }).where(eq(bots.id, botId));
    clock += 1_000;
    await e.tick();
    expect((await botState(botId))?.state).toBe("stopped");
    const close = gw.received.find((o) => o.tag === "close");
    expect(close).toBeDefined();
    // Bot không còn runner, nhưng tin khớp của lệnh đóng vẫn phải tới qua stream.
    expect(await streamed()).toBe(true);
    // Hết thời gian giữ mà lệnh đóng vẫn mở trên SoDEX: stream vẫn mở.
    clock += STREAM_HOLD_MS + 1_000;
    await e.tick();
    expect(await streamed()).toBe(true);
    // Lệnh đóng khớp (tin stream): không còn lệnh mở, stream được đóng ở vòng sau.
    await e.onFill(accountId, close?.clOrdID ?? "", close?.quantity ?? "0", "100", "0", clock);
    await e.onOrderClosed(accountId, close?.clOrdID ?? "", "filled", clock);
    clock += 6_000;
    await e.tick();
    expect(await streamed()).toBe(false);
    await e.stop();
  });

  it("keeps a market order SoDEX cannot find and has no trades for as unknown, not cancelled, then records it when trades appear", async () => {
    const gw = new FakeGateway();
    const { botId } = await seedBot();
    const e = streamEngine(gw, "lost-unknown");
    await e.tick();
    await e.onPrice("vBTC_vUSDC", "100", clock);
    const init = gw.received.find((o) => o.tag === "grid:init");
    const id = init?.clOrdID ?? "";
    gw.book.delete(id);
    clock += 6_000;
    await e.tick();
    // Trong thời gian chờ: vẫn open, đã hỏi trade.
    expect((await orderOf(id))?.status).toBe("open");
    expect(gw.recentTradesCalls).toBeGreaterThan(0);
    clock += 31_000;
    await e.tick();
    const row = await orderOf(id);
    expect(row?.status).toBe("unknown");
    expect(row?.doneFedAt).toBeNull();
    // SoDEX đã nhận lệnh: không thành not_placed dù vẫn không thấy.
    clock += 16_000;
    await e.tick();
    expect((await orderOf(id))?.status).toBe("unknown");
    const { eq } = await import("drizzle-orm");
    const events = await db.select().from(botEvents).where(eq(botEvents.botId, botId));
    expect(events.map((x) => x.decision)).toContain("Order result unknown");
    // Trade xuất hiện: lần tra sau ghi fill thật và kết thúc lệnh.
    gw.trades.set(id, [trade(init?.quantity ?? "0")]);
    clock += 16_000;
    await e.tick();
    const after = await orderOf(id);
    expect(after?.status).toBe("filled");
    expect(after?.doneFedAt).not.toBeNull();
    expect(gw.received.map((o) => o.tag)).toEqual(expect.arrayContaining(["grid:3:sell"]));
    await e.stop();
    await stopBot(botId);
  });

  it("records a native stop SoDEX no longer has as cancelled only when it has no trades (DEC-118, M3)", async () => {
    const gw = new FakeGateway();
    const { botId, accountId } = await seedBot("running");
    const e = streamEngine(gw, "lost-stop");
    await e.tick();
    const base = {
      botId,
      sodexAccountId: accountId,
      market: "BTC-USD",
      engine: "perps" as const,
      side: "sell" as const,
      type: "market" as const,
      timeInForce: "IOC",
      size: "1",
      status: "open" as const,
      reduceOnly: true,
      epoch: 1,
      submittedAt: new Date(clock - 10_000),
    };
    const stopId = `stop-${String(Math.random())}`;
    const firedId = `fired-${String(Math.random())}`;
    const exitId = `exit-${String(Math.random())}`;
    await db.insert(orders).values([
      { ...base, clOrdId: stopId, tag: "vf:1:sl", sodexOrderId: 901n },
      { ...base, clOrdId: firedId, tag: "vf:2:sl", sodexOrderId: 903n },
      { ...base, clOrdId: exitId, tag: "vf:1:out:0", sodexOrderId: 902n },
    ]);
    // Stop đã kích hoạt và khớp, lịch sử lệnh chưa có: phải ghi khớp, không phải huỷ.
    gw.trades.set(firedId, [trade("1")]);
    await e.tick();
    expect((await orderOf(stopId))?.status).toBe("cancelled");
    expect((await orderOf(firedId))?.status).toBe("filled");
    // Lệnh market khác không bị coi là stop: còn open trong thời gian chờ.
    expect((await orderOf(exitId))?.status).toBe("open");
    await e.stop();
    await stopBot(botId);
  });

  it("checks the trades before trusting a CANCELED IOC with no fill", async () => {
    const gw = new FakeGateway();
    const { botId } = await seedBot();
    const e = streamEngine(gw, "lost-canceled");
    await e.tick();
    await e.onPrice("vBTC_vUSDC", "100", clock);
    const init = gw.received.find((o) => o.tag === "grid:init");
    const id = init?.clOrdID ?? "";
    gw.book.set(id, { status: "cancelled", filledQty: "0", avgPrice: null, orderId: 31n });
    gw.trades.set(id, [trade(init?.quantity ?? "0")]);
    clock += 6_000;
    await e.tick();
    const row = await orderOf(id);
    expect(row?.status).toBe("filled");
    expect(Number(row?.filledSize)).toBe(Number(init?.quantity));
    expect(gw.received.map((o) => o.tag)).toEqual(expect.arrayContaining(["grid:3:sell"]));
    await e.stop();
    await stopBot(botId);
  });

  it("backfills a trade the stream missed, and flags an order the strategy was already told ended", async () => {
    const { eq } = await import("drizzle-orm");
    const gw = new FakeGateway();
    const { botId, accountId } = await seedBot();
    const e = streamEngine(gw, "lost-backfill");
    await e.tick();
    await e.onPrice("vBTC_vUSDC", "100", clock);
    const init = gw.received.find((o) => o.tag === "grid:init");
    const id = init?.clOrdID ?? "";
    // Lệnh đã kết thúc, chiến lược đã nhận orderDone với 0 khớp, nhưng thật ra đã khớp.
    const lateId = `late-${String(Math.random())}`;
    await db.insert(orders).values({
      botId,
      sodexAccountId: accountId,
      clOrdId: lateId,
      market: "vBTC_vUSDC",
      engine: "spot",
      side: "buy",
      type: "market",
      timeInForce: "IOC",
      size: "0.5",
      status: "cancelled",
      reduceOnly: false,
      tag: "late",
      epoch: 1,
      submittedAt: new Date(clock - 20_000),
      doneFedAt: new Date(clock - 19_000),
    });
    const t = trade(init?.quantity ?? "0");
    const late = trade("0.5");
    gw.trades.set(id, [t]);
    gw.trades.set(lateId, [late]);
    // Stream vừa subscribe: có thể đã mất tin. Lưới an toàn đọc một lần, sau thời gian chờ tin stream (M4, M5).
    e.onStreamGap(accountId);
    const readsOf = () => gw.recentTradesBy.filter((x) => x === accountId).length;
    await e.tick();
    expect(readsOf()).toBe(0);
    clock += 16_000;
    await e.tick();
    const reads = readsOf();
    expect(reads).toBeGreaterThan(0);
    clock += 11_000;
    await e.tick();
    expect(readsOf()).toBe(reads);
    const row = await orderOf(id);
    expect(row?.status).toBe("filled");
    expect((await fillsOf(row?.id ?? "")).map((f) => f.sodexTradeId)).toEqual([t.tradeId]);
    expect(gw.received.map((o) => o.tag)).toEqual(expect.arrayContaining(["grid:3:sell"]));
    // Lệnh đã báo kết thúc: ghi số thật và fill, gắn Needs attention, không báo lại chiến lược.
    const lateRow = await orderOf(lateId);
    expect(Number(lateRow?.filledSize)).toBe(0.5);
    expect((await fillsOf(lateRow?.id ?? "")).map((f) => f.sodexTradeId)).toEqual([late.tradeId]);
    expect((await botState(botId))?.needsAttention).toBe(true);
    const events = await db.select().from(botEvents).where(eq(botEvents.botId, botId));
    expect(events.map((x) => x.decision)).toContain("Fill found after the order ended");
    const late1 = (await teamIncidents(botId)).filter((x) => x.kind === "late_fill");
    expect(late1).toHaveLength(1);
    expect(late1[0]?.detail).toBe(`${lateId} · SoDEX filled 0.5, bot counted 0`);
    await e.stop();
    await stopBot(botId);
  });

  it("records a fill of a bot with no runner in the order and its saved ledger, once (no double count on reconcile)", async () => {
    const { eq } = await import("drizzle-orm");
    const gw = new FakeGateway();
    const { botId, accountId } = await seedBot("running");
    const config = spotGridSchema.parse(
      (await db.select().from(botVersions).where(eq(botVersions.botId, botId)))[0]?.config,
    );
    const [version] = await db.select().from(botVersions).where(eq(botVersions.botId, botId));
    await db.update(bots).set({ state: "paused" }).where(eq(bots.id, botId));
    await db.insert(botRuntime).values({
      botId,
      versionId: version?.id ?? "",
      state: spotGrid.initialState(config),
      epoch: 1,
    });
    const id = `norunner-${String(Math.random())}`;
    await db.insert(orders).values({
      botId,
      sodexAccountId: accountId,
      clOrdId: id,
      market: "vBTC_vUSDC",
      engine: "spot",
      side: "buy",
      type: "limit",
      timeInForce: "GTC",
      price: "100",
      size: "1",
      status: "open",
      reduceOnly: false,
      tag: "grid:0:buy",
      epoch: 1,
      submittedAt: new Date(clock - 10_000),
      sodexOrderId: 77n,
    });
    const e = streamEngine(gw, "lost-norunner");
    await e.tick();
    await e.onFill(accountId, id, "0.5", "100", "0.01", clock);
    expect(Number((await orderOf(id))?.filledSize)).toBe(0.5);
    const ledger = async () => {
      const [rt] = await db.select().from(botRuntime).where(eq(botRuntime.botId, botId));
      return (rt?.state as { ledger: { position: string } }).ledger.position;
    };
    expect(Number(await ledger())).toBe(0.5);
    // Đối soát sau đó thấy cùng số: không cộng lại vào sổ cái.
    gw.book.set(id, {
      status: "partially_filled",
      filledQty: "0.5",
      avgPrice: "100",
      orderId: 77n,
    });
    gw.trades.set(id, [trade("0.5")]);
    clock += 16_000;
    await e.tick();
    expect(Number(await ledger())).toBe(0.5);
    await e.stop();
    await stopBot(botId);
  });

  const futuresGrid = {
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

  it("waits only for the stream of the engine the bot trades (B1)", async () => {
    const gw = new FakeGateway();
    const streams = new FakeStreams();
    const { botId, accountId } = await seedBot("starting", futuresGrid);
    const e = streamEngine(gw, "lost-b1", streams);
    await e.tick();
    // Spot của account bị từ chối ("user not found"), Perps đã subscribe: bot Perps vẫn giao dịch.
    streams.allow(accountId, "perps");
    const sent = () => gw.received.length;
    for (let i = 0; i < 5 && sent() === 0; i += 1) {
      await e.onPrice("BTC-USD", "100", clock);
      if (sent() === 0) await new Promise((r) => setTimeout(r, 50));
    }
    expect(gw.received.some((o) => o.market === "BTC-USD" && !o.reduceOnly)).toBe(true);
    // Account chỉ chạy Perps: không mở stream Spot (N2).
    expect(streams.openedKinds).toEqual([`${accountId}:perps`]);
    await e.stop();
    await stopBot(botId);
  });

  it("lets closing orders and the user's Stop through while the stream is not ready, never opening ones (M6)", async () => {
    const o = (engine: "spot" | "perps", side: "buy" | "sell", reduceOnly = false) => ({
      engine,
      side,
      reduceOnly,
      quantity: "1",
    });
    expect(opensPosition(o("perps", "buy"), "0")).toBe(true);
    expect(opensPosition(o("perps", "sell", true), null)).toBe(false);
    expect(opensPosition(o("spot", "buy"), "3")).toBe(true);
    expect(opensPosition(o("spot", "sell"), null)).toBe(false);
    // Lệnh bán của grid long (không reduce-only) chỉ giảm vị thế: không bị giữ.
    expect(opensPosition(o("perps", "sell"), "2")).toBe(false);
    expect(opensPosition(o("perps", "sell"), "2", "1")).toBe(false);
    // Cộng với lệnh giảm đang chờ thì vượt |vị thế|: thành mở vị thế ngược lại.
    expect(opensPosition(o("perps", "sell"), "2", "1.5")).toBe(true);
    expect(opensPosition(o("perps", "buy"), "-2")).toBe(false);
    expect(opensPosition(o("perps", "sell"), null)).toBe(true);

    const { eq } = await import("drizzle-orm");
    const gw = new FakeGateway();
    const streams = new FakeStreams();
    const { botId, accountId } = await seedBot("running", futuresGrid);
    const e = streamEngine(gw, "lost-m6", streams);
    await e.tick();
    await e.onPrice("BTC-USD", "100", clock);
    // Stream chưa sẵn sàng: không lệnh mở vị thế nào.
    expect(gw.received.filter((o) => !o.reduceOnly)).toHaveLength(0);
    await db
      .insert(botRuntime)
      .values({
        botId,
        versionId:
          (await db.select().from(botVersions).where(eq(botVersions.botId, botId)))[0]?.id ?? "",
        state: {
          phase: "running",
          ledger: { position: "2", avgCost: "100", realized: "0", fees: "0", funding: "0" },
        },
        epoch: 1,
      })
      .onConflictDoNothing();
    const [rt] = await db.select().from(botRuntime).where(eq(botRuntime.botId, botId));
    const st = rt?.state as { ledger: Record<string, string> };
    await db
      .update(botRuntime)
      .set({ state: { ...st, ledger: { ...st.ledger, position: "2", avgCost: "100" } } })
      .where(eq(botRuntime.botId, botId));
    await e.stop();
    // Người dùng Stop + đóng vị thế khi stream vẫn chưa sẵn sàng: lệnh đóng vẫn đi.
    await db.update(bots).set({ state: "stopping", closeOnStop: true }).where(eq(bots.id, botId));
    const e2 = streamEngine(gw, "lost-m6b", streams);
    for (let i = 0; i < 10 && !gw.received.some((o) => o.tag === "close"); i += 1) {
      await e2.tick();
      if (!gw.received.some((o) => o.tag === "close")) await new Promise((r) => setTimeout(r, 50));
    }
    const close = gw.received.find((o) => o.tag === "close");
    expect(close?.reduceOnly).toBe(true);
    expect(gw.received.filter((o) => !o.reduceOnly)).toHaveLength(0);
    expect(streams.opened).toContain(accountId);
    await e2.stop();
    await stopBot(botId);
  });

  it("does not lose a fill that arrives while the bot is being loaded (B2)", async () => {
    const { eq } = await import("drizzle-orm");
    const gw = new FakeGateway();
    const { botId, accountId } = await seedBot();
    const e = streamEngine(gw, "lost-b2a");
    await e.tick();
    await e.onPrice("vBTC_vUSDC", "100", clock);
    const init = gw.received.find((o) => o.tag === "grid:init");
    const id = init?.clOrdID ?? "";
    await e.stop();
    // Engine mới nạp bot; trong lúc #load còn chờ (đọc rules), tin khớp của lệnh vào tới.
    let release: () => void = () => undefined;
    const held = new Promise<void>((res) => {
      release = res;
    });
    let calls = 0;
    let entered: () => void = () => undefined;
    const loading = new Promise<void>((res) => {
      entered = res;
    });
    const e2 = streamEngine(gw, "lost-b2b", undefined, async () => {
      calls += 1;
      if (calls === 1) {
        entered();
        await held;
      }
      return rules;
    });
    const ticking = e2.tick();
    await loading;
    const filling = e2.onFill(accountId, id, init?.quantity ?? "0", "100", "0.01", clock);
    await new Promise((r) => setTimeout(r, 50));
    release();
    await ticking;
    await filling;
    const [rt] = await db.select().from(botRuntime).where(eq(botRuntime.botId, botId));
    const st = rt?.state as { ledger: { position: string } };
    expect(Number(st.ledger.position)).toBe(Number(init?.quantity));
    expect(Number((await orderOf(id))?.filledSize)).toBe(Number(init?.quantity));
    // Chiến lược đã nhận fill: các mức bán được đặt.
    expect(gw.received.map((o) => o.tag)).toEqual(expect.arrayContaining(["grid:3:sell"]));
    await e2.stop();
    await stopBot(botId);
  });

  it("records partial trades of a resting limit order SoDEX cannot find, but keeps it open (M1)", async () => {
    const { eq } = await import("drizzle-orm");
    const gw = new FakeGateway();
    const { botId, accountId } = await seedBot("running");
    await db.update(bots).set({ state: "paused" }).where(eq(bots.id, botId));
    const id = `partial-${String(Math.random())}`;
    await db.insert(orders).values({
      botId,
      sodexAccountId: accountId,
      clOrdId: id,
      market: "vBTC_vUSDC",
      engine: "spot",
      side: "buy",
      type: "limit",
      timeInForce: "GTC",
      price: "100",
      size: "1",
      status: "open",
      reduceOnly: false,
      tag: "grid:0:buy",
      epoch: 1,
      submittedAt: new Date(clock - 10_000),
      sodexOrderId: 78n,
    });
    gw.trades.set(id, [trade("0.4")]);
    const e = streamEngine(gw, "lost-m1");
    await e.tick();
    const row = await orderOf(id);
    expect(row?.status).toBe("partially_filled");
    expect(Number(row?.filledSize)).toBe(0.4);
    expect(row?.doneFedAt).toBeNull();
    expect((await fillsOf(row?.id ?? "")).length).toBe(1);
    await e.stop();
    await stopBot(botId);
  });

  it("waits from when an old order went missing, and remembers the confirmed miss across restarts (M2, N3)", async () => {
    const { eq } = await import("drizzle-orm");
    const gw = new FakeGateway();
    const { botId, accountId } = await seedBot("running");
    await db.update(bots).set({ state: "paused" }).where(eq(bots.id, botId));
    const id = `old-${String(Math.random())}`;
    await db.insert(orders).values({
      botId,
      sodexAccountId: accountId,
      clOrdId: id,
      market: "vBTC_vUSDC",
      engine: "spot",
      side: "buy",
      type: "limit",
      timeInForce: "GTC",
      price: "100",
      size: "1",
      status: "open",
      reduceOnly: false,
      tag: "grid:0:buy",
      epoch: 1,
      submittedAt: new Date(clock - 20 * 60_000),
      sodexOrderId: 79n,
    });
    const e = streamEngine(gw, "lost-m2");
    await e.tick();
    // Lệnh nằm sổ 20 phút, lần đầu không thấy: chưa thành unknown.
    expect((await orderOf(id))?.status).toBe("open");
    clock += 16_000;
    await e.tick();
    expect((await orderOf(id))?.status).toBe("open");
    clock += 16_000;
    await e.tick();
    expect((await orderOf(id))?.status).toBe("unknown");
    await e.stop();
    await stopBot(botId);

    // Bot đang chạy: lệnh thành unknown sau một lần tra thành công (Decisions "not found" bền). Sau đó mọi lần tra đều lỗi
    // và engine khởi động lại: lần xác nhận đó vẫn được nhớ, quá 10 phút thì ghi cho người dùng đúng một lần (N3).
    const gw2 = new FakeGateway();
    const run = await seedBot();
    const e2 = streamEngine(gw2, "lost-m2b");
    await e2.tick();
    await e2.onPrice("vBTC_vUSDC", "100", clock);
    const init = gw2.received.find((o) => o.tag === "grid:init")?.clOrdID ?? "";
    gw2.book.delete(init);
    clock += 6_000;
    await e2.tick();
    clock += 31_000;
    await e2.tick();
    expect((await orderOf(init))?.status).toBe("unknown");
    gw2.lookupError = new Error("network down");
    await e2.stop();
    const flagged = async () =>
      (await db.select().from(botEvents).where(eq(botEvents.botId, run.botId))).filter((x) =>
        (x.why ?? "").includes("SoDEX accepted it"),
      ).length;
    // Stop chưa thôi chờ trong 10 phút đầu.
    await db.update(bots).set({ state: "stopping" }).where(eq(bots.id, run.botId));
    const e3 = streamEngine(gw2, "lost-m2c");
    await e3.tick();
    expect((await botState(run.botId))?.state).toBe("stopping");
    await e3.stop();
    await db.update(bots).set({ state: "running" }).where(eq(bots.id, run.botId));
    clock += 25 * 60_000;
    const e4 = streamEngine(gw2, "lost-m2d");
    await e4.tick();
    clock += 61_000;
    await e4.tick();
    expect(await flagged()).toBe(1);
    expect((await botState(run.botId))?.needsAttention).toBe(true);
    await e4.stop();
    // Khởi động lại lần nữa: không ghi lần nữa.
    const e5 = streamEngine(gw2, "lost-m2e");
    await e5.tick();
    clock += 61_000;
    await e5.tick();
    expect(await flagged()).toBe(1);
    await e5.stop();
    await stopBot(run.botId);
  });

  it("keeps Stop waiting for an accepted unknown order that SoDEX never confirmed missing (N3)", async () => {
    const { eq } = await import("drizzle-orm");
    const gw = new FakeGateway();
    gw.lookupError = new Error("network down");
    const { botId, accountId } = await seedBot("running");
    const id = `unconfirmed-${String(Math.random())}`;
    await db.insert(orders).values({
      botId,
      sodexAccountId: accountId,
      clOrdId: id,
      market: "vBTC_vUSDC",
      engine: "spot",
      side: "buy",
      type: "market",
      timeInForce: "IOC",
      size: "1",
      status: "unknown",
      reduceOnly: false,
      tag: "x",
      epoch: 1,
      submittedAt: new Date(clock - 60 * 60_000),
      reconciledAt: new Date(clock - 50 * 60_000),
      sodexOrderId: 81n,
    });
    await db.update(bots).set({ state: "stopping" }).where(eq(bots.id, botId));
    const e = streamEngine(gw, "lost-n3");
    await e.tick();
    clock += 61_000;
    await e.tick();
    expect((await botState(botId))?.state).toBe("stopping");
    const events = await db.select().from(botEvents).where(eq(botEvents.botId, botId));
    expect(events.some((x) => (x.why ?? "").includes("SoDEX accepted it"))).toBe(false);
    expect(
      (await db.select().from(orders).where(eq(orders.clOrdId, id)))[0]?.missingConfirmedAt,
    ).toBeNull();
    await e.stop();
    await stopBot(botId);
  });

  it("re-reads trades for a native stop when the shared trade history was read before its lookup", async () => {
    const gw = new FakeGateway();
    const { botId, accountId } = await seedBot("running");
    const e = streamEngine(gw, "lost-stop-cache");
    await e.tick();
    const base = {
      botId,
      sodexAccountId: accountId,
      market: "BTC-USD",
      engine: "perps" as const,
      side: "sell" as const,
      type: "market" as const,
      timeInForce: "IOC",
      size: "1",
      status: "open" as const,
      reduceOnly: true,
      epoch: 1,
    };
    const exitId = `exit-${String(Math.random())}`;
    const stopId = `stop-${String(Math.random())}`;
    await db.insert(orders).values([
      // Tra trước: đọc lịch sử khớp dùng chung của account × market.
      {
        ...base,
        clOrdId: exitId,
        tag: "vf:3:out:0",
        sodexOrderId: 911n,
        submittedAt: new Date(clock - 20_000),
      },
      {
        ...base,
        clOrdId: stopId,
        tag: "vf:3:sl",
        sodexOrderId: 912n,
        submittedAt: new Date(clock - 10_000),
      },
    ]);
    // Stop kích hoạt và khớp đúng lúc engine tra nó, sau khi lịch sử khớp đã được đọc cho lệnh trước.
    gw.onLookup = (id) => {
      if (id === stopId) gw.trades.set(stopId, [trade("1")]);
    };
    await e.tick();
    expect((await orderOf(stopId))?.status).toBe("filled");
    gw.onLookup = null;
    await e.stop();
    await stopBot(botId);
  });

  it("charges the ledger only the fee of the part the stream had not recorded", async () => {
    const { eq } = await import("drizzle-orm");
    const gw = new FakeGateway();
    const { botId, accountId } = await seedBot("running");
    const [version] = await db.select().from(botVersions).where(eq(botVersions.botId, botId));
    await db.update(bots).set({ state: "paused" }).where(eq(bots.id, botId));
    await db.insert(botRuntime).values({
      botId,
      versionId: version?.id ?? "",
      state: spotGrid.initialState(spotGridSchema.parse(version?.config)),
      epoch: 1,
    });
    const id = `fee-${String(Math.random())}`;
    await db.insert(orders).values({
      botId,
      sodexAccountId: accountId,
      clOrdId: id,
      market: "vBTC_vUSDC",
      engine: "spot",
      side: "buy",
      type: "limit",
      timeInForce: "GTC",
      price: "100",
      size: "3",
      status: "open",
      reduceOnly: false,
      tag: "grid:0:buy",
      epoch: 1,
      submittedAt: new Date(clock - 10_000),
      sodexOrderId: 83n,
    });
    const e = streamEngine(gw, "lost-fee");
    await e.tick();
    // Stream ghi phần đầu (phí 0.02).
    await e.onFill(accountId, id, "1", "100", "0.02", clock);
    const fees = async () => {
      const [rt] = await db.select().from(botRuntime).where(eq(botRuntime.botId, botId));
      return Number((rt?.state as { ledger: { fees: string } }).ledger.fees);
    };
    expect(await fees()).toBeCloseTo(0.02, 10);
    // Lệnh không còn trong lịch sử REST; trade: phần đã ghi (0.02) + phần mới (0.03), còn nằm trên sổ một phần.
    const t1 = { ...trade("1"), fee: "0.02" };
    const t2 = { ...trade("1"), fee: "0.03", tradeId: t1.tradeId + 1n };
    gw.trades.set(id, [t1, t2]);
    clock += 16_000;
    await e.tick();
    expect(Number((await orderOf(id))?.filledSize)).toBe(2);
    expect(await fees()).toBeCloseTo(0.05, 10);
    await e.stop();
    await stopBot(botId);
  });

  it("feeds resumed even if the stream drops right after Resume was allowed (DEC-240)", async () => {
    const { eq } = await import("drizzle-orm");
    const gw = new FakeGateway();
    const streams = new FakeStreams();
    const { botId, accountId } = await seedBot("running");
    streams.allow(accountId, "spot");
    const e = streamEngine(gw, "lost-resume", streams);
    gw.reject = { code: "-1", message: "insufficient balance" };
    await e.tick();
    await e.onPrice("vBTC_vUSDC", "100", clock);
    clock += 1;
    await e.tick();
    expect((await botState(botId))?.state).toBe("paused");
    gw.reject = null;
    await e.onPrice("vBTC_vUSDC", "102", clock);
    const before = gw.received.length;
    await db.update(bots).set({ state: "resuming", reasonCode: null }).where(eq(bots.id, botId));
    // Kiểm tra Resume thấy stream sẵn sàng, rồi stream đứt ngay sau đó.
    streams.budget = 1;
    clock += 1;
    await e.tick();
    expect((await botState(botId))?.state).toBe("running");
    expect(gw.received.length).toBeGreaterThan(before);
    await e.stop();
    await stopBot(botId);
  });

  it("keys stream gaps by engine: a Spot gap does not read Perps trades", async () => {
    const gw = new FakeGateway();
    const { botId, accountId } = await seedBot("running", futuresGrid);
    const e = streamEngine(gw, "lost-gap-engine");
    for (let i = 0; i < 5 && gw.received.length === 0; i += 1) {
      await e.tick();
      await e.onPrice("BTC-USD", "100", clock);
    }
    const readsOf = () => gw.recentTradesBy.filter((x) => x === accountId).length;
    e.onStreamGap(accountId, "spot");
    clock += 16_000;
    await e.tick();
    expect(readsOf()).toBe(0);
    e.onStreamGap(accountId, "perps");
    clock += 16_000;
    await e.tick();
    expect(readsOf()).toBe(1);
    await e.stop();
    await stopBot(botId);
  });

  it("does not lose a fill that arrives while the stream gate reads pending orders (#208 R1)", async () => {
    const { eq } = await import("drizzle-orm");
    // Giữ truy vấn `orders` kế tiếp (lần đọc lệnh giảm đang chờ của cổng stream) tới khi test thả.
    let armed = false;
    let captured: () => void = () => undefined;
    const caught = new Promise<void>((res) => {
      captured = res;
    });
    let release: () => void = () => undefined;
    const held = new Promise<void>((res) => {
      release = res;
    });
    const delay = <T extends object>(q: T): T =>
      new Proxy(q, {
        get(t, prop) {
          const v: unknown = Reflect.get(t, prop);
          if (typeof v !== "function") return v;
          if (prop === "then")
            return (ok: (x: unknown) => unknown, bad: (e: unknown) => unknown) =>
              held.then(() => (v as (a: unknown, b: unknown) => unknown).call(t, ok, bad));
          return (...args: unknown[]) => {
            const out: unknown = (v as (...a: unknown[]) => unknown).apply(t, args);
            return typeof out === "object" && out !== null ? delay(out) : out;
          };
        },
      });
    const hooked = new Proxy(db, {
      get(target, prop) {
        const v: unknown = Reflect.get(target, prop);
        if (prop === "select" && typeof v === "function")
          return (...args: unknown[]) => {
            const b = (v as (...a: unknown[]) => { from: (t: unknown) => object }).apply(
              target,
              args,
            );
            return new Proxy(b, {
              get(bt, bp) {
                const bv: unknown = Reflect.get(bt, bp);
                if (bp === "from" && typeof bv === "function")
                  return (tbl: unknown) => {
                    const q = (bv as (t: unknown) => object).call(bt, tbl);
                    if (!armed || tbl !== orders) return q;
                    armed = false;
                    captured();
                    return delay(q);
                  };
                return typeof bv === "function"
                  ? (bv as (...a: unknown[]) => unknown).bind(bt)
                  : bv;
              },
            });
          };
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    });
    const gw = new FakeGateway();
    const streams = new FakeStreams();
    const { botId, accountId } = await seedBot();
    streams.allow(accountId, "spot");
    const e = streamEngine(gw, "lost-r1", streams, undefined, hooked);
    await e.tick();
    await e.onPrice("vBTC_vUSDC", "100", clock);
    const init = gw.received.find((o) => o.tag === "grid:init");
    await e.onFill(accountId, init?.clOrdID ?? "", init?.quantity ?? "0", "100", "0", clock);
    const level = gw.received.find((o) => o.tag === "grid:0:buy");
    expect(level).toBeDefined();
    const position = async () => {
      const [rt] = await db.select().from(botRuntime).where(eq(botRuntime.botId, botId));
      return Number((rt?.state as { ledger: { position: string } }).ledger.position);
    };
    const before = await position();
    // Stream đứt; một nhịp giá chạy tới cổng stream và đang đọc lệnh chờ thì fill của lệnh mức 0 tới.
    streams.ready.clear();
    armed = true;
    const ticking = e.onPrice("vBTC_vUSDC", "101", clock);
    await caught;
    await e.onFill(accountId, level?.clOrdID ?? "", level?.quantity ?? "0", "90", "0", clock);
    release();
    await ticking;
    expect(await position()).toBeCloseTo(before + Number(level?.quantity), 10);
    await e.stop();
    await stopBot(botId);
  });

  it("marks the first confirmed miss on an old unknown order, then gives up and lets Stop finish (#208 R2)", async () => {
    const { eq } = await import("drizzle-orm");
    const gw = new FakeGateway();
    const { botId, accountId } = await seedBot("running");
    const id = `legacy-${String(Math.random())}`;
    // Dòng `unknown` cũ chưa có dấu xác nhận (ví dụ từ bản trước).
    await db.insert(orders).values({
      botId,
      sodexAccountId: accountId,
      clOrdId: id,
      market: "vBTC_vUSDC",
      engine: "spot",
      side: "buy",
      type: "market",
      timeInForce: "IOC",
      size: "1",
      status: "unknown",
      reduceOnly: false,
      tag: "x",
      epoch: 1,
      submittedAt: new Date(clock - 60 * 60_000),
      reconciledAt: new Date(clock - 50 * 60_000),
      sodexOrderId: 84n,
    });
    const e = streamEngine(gw, "lost-r2");
    await e.tick();
    const row = async () => (await db.select().from(orders).where(eq(orders.clOrdId, id)))[0];
    expect((await row())?.missingConfirmedAt).not.toBeNull();
    expect((await row())?.unknownGaveUpAt).toBeNull();
    // Stop chờ trong 10 phút sau lần xác nhận.
    await db.update(bots).set({ state: "stopping" }).where(eq(bots.id, botId));
    clock += 1;
    await e.tick();
    expect((await botState(botId))?.state).toBe("stopping");
    clock += 11 * 60_000;
    await e.tick();
    await e.tick();
    expect((await row())?.unknownGaveUpAt).not.toBeNull();
    expect((await botState(botId))?.needsAttention).toBe(true);
    expect((await botState(botId))?.state).toBe("stopped");
    // Báo team một lần (#241).
    expect(await teamIncidents(botId)).toEqual([
      {
        type: "team_incident",
        kind: "unknown_gave_up",
        botId,
        market: "vBTC_vUSDC",
        detail: `buy 1 · ${id} · not on SoDEX after 10 min, fills unknown`,
      },
    ]);
    await e.stop();
  });
});

describe("position check: real SoDEX position vs the bot ledger (DEC-306)", () => {
  const grid = {
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
  /** Gateway giả (đếm số lần đọc account state / lịch sử khớp theo account: bot của test khác có thể còn chạy). */
  class PosGateway extends FakeGateway {}
  const posEngine = (gw: Gateway, workerId: string, paper?: PaperGateway) =>
    new Engine({
      db,
      redis: newRedis(),
      gateway: gw,
      workerId,
      log,
      now,
      leaseTtlMs: 30_000,
      shards: SHARDS,
      rules: () => Promise.resolve(rules),
      feeCheckMs: 0,
      ...(paper === undefined ? {} : { paper }),
    });
  const eventsOf = async (botId: string) => {
    const { eq } = await import("drizzle-orm");
    return (await db.select().from(botEvents).where(eq(botEvents.botId, botId))).filter(
      (x) => x.decision === "Position doesn't match" || x.decision === "Position matches again",
    );
  };
  const ledgerOf = async (botId: string) => {
    const { eq } = await import("drizzle-orm");
    const [rt] = await db.select().from(botRuntime).where(eq(botRuntime.botId, botId));
    return (rt?.state as { ledger: { position: string } } | undefined)?.ledger.position ?? null;
  };
  const step = async (e: RealEngine, ms = 30_000) => {
    clock += ms;
    await e.tick();
  };
  const finish = async (e: RealEngine, botId: string) => {
    const { eq } = await import("drizzle-orm");
    await e.stop();
    await db.update(bots).set({ state: "stopped" }).where(eq(bots.id, botId));
  };

  /** Bot grid Perps đang chạy, lệnh vào 2 BTC đã khớp: sổ cái 2, SoDEX 2. */
  async function running(gw: PosGateway, id: string) {
    const { botId, accountId } = await seedBot("running", grid);
    const e = posEngine(gw, id);
    await e.tick();
    await e.onPrice("BTC-USD", "100", clock);
    const init = gw.received.find((o) => o.tag === "grid:init")?.clOrdID ?? "";
    clock += 100;
    await e.onFill(accountId, init, "2", "100", "0", clock);
    gw.perpsPositions.set("BTC-USD", { size: "2", entryPrice: "100" });
    expect(await ledgerOf(botId)).toBe("2");
    const tag = (t: string) => gw.received.find((o) => o.tag === t)?.clOrdID ?? "";
    return { botId, accountId, e, tag };
  }

  it("tier 0: a mismatch seen once does nothing", async () => {
    const gw = new PosGateway();
    const { botId, accountId, e } = await running(gw, "pos-t0");
    await step(e);
    gw.perpsPositions.set("BTC-USD", { size: "2.5", entryPrice: "100" });
    await step(e);
    gw.perpsPositions.set("BTC-USD", { size: "2", entryPrice: "100" });
    for (let i = 0; i < 4; i += 1) await step(e);
    expect(gw.readsBy.filter((a) => a === accountId).length).toBeGreaterThanOrEqual(5);
    expect(gw.recentTradesBy).not.toContain(accountId);
    expect(await eventsOf(botId)).toEqual([]);
    expect((await botState(botId))?.needsAttention).toBe(false);
    expect((await botState(botId))?.positionMismatch).toBeNull();
    await finish(e, botId);
  });

  it("tier 1: a persistent mismatch reads SoDEX trades once; a lost fill found there fixes it without an alert", async () => {
    const gw = new PosGateway();
    const { botId, accountId, e, tag } = await running(gw, "pos-t1");
    // Lệnh mua ở 95 đã khớp trên SoDEX nhưng tin khớp không tới: SoDEX 3, sổ cái 2.
    const buy = tag("grid:1:buy");
    gw.trades.set(buy, [
      {
        tradeId: 70_000n + BigInt(Math.floor(Math.random() * 1e9)),
        price: "95",
        quantity: "1",
        fee: "0.02",
        builderFee: null,
        isMaker: true,
        at: clock,
      },
    ]);
    gw.perpsPositions.set("BTC-USD", { size: "3", entryPrice: "98" });
    await step(e);
    await step(e);
    expect(gw.recentTradesBy).not.toContain(accountId);
    await step(e);
    expect(gw.recentTradesBy.filter((a) => a === accountId)).toHaveLength(1);
    expect(await ledgerOf(botId)).toBe("3");
    await step(e);
    await step(e);
    expect(gw.recentTradesBy.filter((a) => a === accountId)).toHaveLength(1);
    expect(await eventsOf(botId)).toEqual([]);
    expect((await botState(botId))?.positionMismatch).toBeNull();
    await finish(e, botId);
  });

  /** Cảnh báo lệch vị thế đã ghi từ trước (như sau khi engine khởi động lại). */
  const flag = async (botId: string, market: string, real: string, ledger: string) => {
    const { eq } = await import("drizzle-orm");
    await db
      .update(bots)
      .set({
        positionMismatch: {
          [market]: { real, ledger, since: new Date(clock).toISOString(), cause: "trades" },
        },
      })
      .where(eq(bots.id, botId));
  };
  const allEvents = async (botId: string) => {
    const { eq } = await import("drizzle-orm");
    return db.select().from(botEvents).where(eq(botEvents.botId, botId));
  };

  it("tier 2: alerts once without touching needs_attention, survives a restart, lets fills through, clears after two matching checks, and leaves nothing phantom", async () => {
    const { eq, inArray, and } = await import("drizzle-orm");
    const gw = new PosGateway();
    const { botId, accountId, e, tag } = await running(gw, "pos-t2");
    gw.perpsPositions.set("BTC-USD", { size: "5", entryPrice: "100" });
    await step(e); // bậc 0
    await step(e); // mới 30 s
    await step(e); // bậc 1: đọc trade, không có gì
    expect(gw.recentTradesBy.filter((a) => a === accountId)).toHaveLength(1);
    expect(await eventsOf(botId)).toEqual([]);
    await step(e); // bậc 2
    const alerts = await eventsOf(botId);
    expect(alerts.map((x) => [x.decision, x.why])).toEqual([
      [
        "Position doesn't match",
        "Your BTC-USD position on SoDEX is 5; the bot tracked 2. The bot won't start new trades that add to it until this is fixed. Check Positions on SoDEX.",
      ],
    ]);
    const flagged = await botState(botId);
    // Cờ riêng: không ghi đè needs_attention (api gộp hai cờ).
    expect(flagged?.needsAttention).toBe(false);
    expect(flagged?.state).toBe("running");
    expect(flagged?.positionMismatch?.["BTC-USD"]).toMatchObject({
      real: "5",
      ledger: "2",
      cause: "trades",
    });
    expect(await teamIncidents(botId)).toEqual([
      {
        type: "team_incident",
        kind: "position_mismatch",
        botId,
        market: "BTC-USD",
        detail: "real 5 vs ledger 2 · cause trades",
      },
    ]);
    await step(e);
    // Khởi động lại engine: không ghi lại cảnh báo.
    await e.stop();
    const e2 = posEngine(gw, "pos-t2b");
    await e2.tick();
    await step(e2);
    expect(await eventsOf(botId)).toHaveLength(1);

    // Fill luôn được ghi và bước của nó đi trọn (lệnh mua lại mức vừa bán).
    const sell = tag("grid:3:sell");
    const before = gw.received.length;
    clock += 100;
    await e2.onFill(accountId, sell, "1", "105", "0", clock);
    expect(await ledgerOf(botId)).toBe("1");
    expect(gw.received.slice(before).some((o) => o.side === "buy")).toBe(true);
    expect((await botState(botId))?.state).toBe("running");

    // SoDEX khớp lại với sổ cái (1): một lần khớp chưa đủ, hai lần thì bỏ cảnh báo.
    gw.perpsPositions.set("BTC-USD", { size: "1", entryPrice: "100" });
    await step(e2);
    expect(await eventsOf(botId)).toHaveLength(1);
    await step(e2);
    expect((await eventsOf(botId)).map((x) => [x.decision, x.why])).toEqual([
      alerts.map((x) => [x.decision, x.why])[0],
      [
        "Position matches again",
        "Your BTC-USD position on SoDEX (1) matches the bot again. The bot trades normally.",
      ],
    ]);
    expect((await botState(botId))?.positionMismatch).toBeNull();
    expect((await teamIncidents(botId)).map((x) => [x.kind, x.detail])).toEqual([
      ["position_mismatch", "real 5 vs ledger 2 · cause trades"],
      ["position_matched", "real 1 matches the ledger"],
    ]);
    // Không có lệnh "ma": mọi lệnh grid coi là đang mở đều có dòng lệnh đang mở thật.
    const [rt] = await db.select().from(botRuntime).where(eq(botRuntime.botId, botId));
    const open = Object.keys((rt?.state as { open: Record<string, unknown> }).open);
    const rows = await db
      .select({ id: orders.clOrdId })
      .from(orders)
      .where(and(eq(orders.botId, botId), inArray(orders.status, ["open", "partially_filled"])));
    expect(open.length).toBeGreaterThan(0);
    expect(open.every((id) => rows.some((x) => x.id === id))).toBe(true);
    await finish(e2, botId);
  });

  it("holds a Futures DCA cycle start while flagged: no orders, no repeated Decisions, no cycle loop; starts once it matches (B1)", async () => {
    const { eq } = await import("drizzle-orm");
    const gw = new PosGateway();
    const { botId } = await seedBot("running", {
      strategy: "futures_dca",
      market: "BTC-USD",
      engine: "perps",
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
        entry: "now",
        nextCycle: "immediately",
      },
    });
    await flag(botId, "BTC-USD", "5", "0");
    gw.perpsPositions.set("BTC-USD", { size: "5", entryPrice: "100" });
    const e = posEngine(gw, "pos-dca");
    await e.tick();
    await e.onPrice("BTC-USD", "100", clock);
    const after1 = (await allEvents(botId)).length;
    for (let i = 0; i < 5; i += 1) {
      clock += 1_000;
      await e.onPrice("BTC-USD", String(100 + i), clock);
    }
    expect(gw.received.filter((o) => o.market === "BTC-USD")).toEqual([]);
    expect((await allEvents(botId)).length).toBe(after1);
    expect((await allEvents(botId)).some((x) => (x.decision ?? "").startsWith("Cycle"))).toBe(
      false,
    );
    expect((await botState(botId))?.state).toBe("running");
    // Người dùng đóng vị thế trên SoDEX: hai lần khớp thì bỏ cảnh báo, bot vào cycle 1 một lần.
    gw.perpsPositions.delete("BTC-USD");
    await step(e);
    await step(e);
    expect((await botState(botId))?.positionMismatch).toBeNull();
    clock += 1_000;
    await e.onPrice("BTC-USD", "100", clock);
    const base = gw.received.filter((o) => o.market === "BTC-USD" && o.side === "buy");
    expect(base).toHaveLength(1);
    expect(
      (await allEvents(botId)).filter((x) => (x.decision ?? "").startsWith("Cycle 1")).length,
    ).toBe(1);
    await e.stop();
    await db.update(bots).set({ state: "stopped" }).where(eq(bots.id, botId));
  });

  it("never sends one leg of a Funding Arb entry while the perp market is flagged, and never pauses (B3)", async () => {
    const gw = new PosGateway();
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
    await db.insert(fundingRates).values(
      [1, 2, 3].map((h) => ({
        market: "BTC-USD",
        fundingTime: new Date(clock - h * 8 * 3_600_000 - 1),
        rate: "0.0001",
      })),
    );
    // Short 1 BTC-USD trên SoDEX mà bot không theo dõi: lệnh bán chân perp làm tăng |vị thế|.
    await flag(botId, "BTC-USD", "-1", "0");
    gw.perpsPositions.set("BTC-USD", { size: "-1", entryPrice: "100" });
    const e = posEngine(gw, "pos-arb");
    await e.tick();
    await e.onPrice("vBTC_vUSDC", "100", clock);
    await e.onPrice("BTC-USD", "100", clock);
    for (let i = 0; i < 3; i += 1) {
      clock += 1_000;
      await e.onFunding("BTC-USD", "0.0001", clock);
    }
    // Không chân nào được gửi (không bao giờ một chân), bot không pause.
    expect(gw.received.filter((o) => o.tag.startsWith("arb:"))).toEqual([]);
    const b = await botState(botId);
    expect(b?.state).toBe("running");
    expect(b?.reasonCode).toBeNull();
    await finish(e, botId);
  });

  it("keeps the grid position across a settings change: no second starting buy, no alert (#223, replaces B2)", async () => {
    const { eq } = await import("drizzle-orm");
    const gw = new PosGateway();
    const { botId, e } = await running(gw, "pos-ver");
    const [v1] = await db.select().from(botVersions).where(eq(botVersions.botId, botId));
    await db.insert(botVersions).values({
      botId,
      version: 2,
      paramSource: "manual",
      status: "pending",
      config: { ...(v1?.config as Record<string, unknown>), maxLoss: "150" },
    });
    await step(e); // áp v2: sổ cái giữ long 2, khớp SoDEX
    expect(
      (await db.select().from(botVersions).where(eq(botVersions.botId, botId))).find(
        (v) => v.status === "active",
      )?.version,
    ).toBe(2);
    expect(await ledgerOf(botId)).toBe("2");
    const applied = (await allEvents(botId)).find((x) => x.decision === "Applied v2");
    expect(applied?.why).toMatch(
      /^Cancelled \d+ orders and kept the open position; new orders for it follow on the next price\.$/,
    );
    // Giá đầu tiên: grid v2 dựng lệnh quanh vị thế, không mua lại vị thế ban đầu, chỉ bán phần đang giữ.
    const sent = gw.received.length;
    clock += 1_000;
    await e.onPrice("BTC-USD", "100", clock);
    const placed = gw.received.slice(sent);
    expect(placed.some((o) => o.type === "market" || o.tag === "grid:init")).toBe(false);
    expect(placed.map((o) => `${o.side}@${o.price ?? ""}`).sort()).toEqual(
      ["buy@90", "buy@95", "sell@105", "sell@110"].sort(),
    );
    expect(placed.every((o) => o.clOrdID.split("-")[1] === "2")).toBe(true);
    for (let i = 0; i < 4; i += 1) await step(e);
    const lines = await allEvents(botId);
    expect(lines.some((x) => x.decision === "Position not tracked")).toBe(false);
    expect(await eventsOf(botId)).toEqual([]);
    expect((await botState(botId))?.positionMismatch).toBeNull();
    expect(await ledgerOf(botId)).toBe("2");
    await finish(e, botId);
  });

  const pendingV2 = async (botId: string, patch: Record<string, unknown>) => {
    const { eq } = await import("drizzle-orm");
    const [v1] = await db.select().from(botVersions).where(eq(botVersions.botId, botId));
    await db.insert(botVersions).values({
      botId,
      version: 2,
      paramSource: "manual",
      status: "pending",
      config: { ...(v1?.config as Record<string, unknown>), ...patch },
    });
  };
  const activeVersion = async (botId: string) => {
    const { eq } = await import("drizzle-orm");
    return (await db.select().from(botVersions).where(eq(botVersions.botId, botId))).find(
      (v) => v.status === "active",
    )?.version;
  };

  it("cancels a v1 order that a fill placed while the apply was cancelling, and builds v2 only around the real position (#223 M1)", async () => {
    const gw = new PosGateway();
    const { botId, accountId, e, tag } = await running(gw, "pos-m1");
    await pendingV2(botId, { maxLoss: "150" });
    let release: () => void = () => undefined;
    gw.holdCancel = new Promise<void>((r) => {
      release = r;
    });
    const applying = step(e);
    for (let i = 0; i < 200 && !gw.cancelHeld; i += 1) await new Promise((r) => setTimeout(r, 10));
    expect(gw.cancelHeld).toBe(true);
    // Mua 95 của v1 khớp đúng lúc engine đang huỷ: bước của v1 đặt lệnh bán đối ứng.
    const before = gw.received.length;
    await e.onFill(accountId, tag("grid:1:buy"), "1", "95", "0", clock);
    gw.perpsPositions.set("BTC-USD", { size: "3", entryPrice: "98" });
    const counter = gw.received.slice(before).find((o) => o.side === "sell");
    expect(counter?.clOrdID.split("-")[1]).toBe("1");
    release();
    await applying;
    expect(await activeVersion(botId)).toBe(2);
    expect(gw.cancelled).toContain(counter?.clOrdID);
    expect(await ledgerOf(botId)).toBe("3");
    const sent = gw.received.length;
    clock += 1_000;
    await e.onPrice("BTC-USD", "100", clock);
    const placed = gw.received.slice(sent);
    const qty = (side: string) =>
      placed.filter((o) => o.side === side).reduce((a, o) => a.add(o.quantity), dec("0"));
    expect(placed.length).toBeGreaterThan(0);
    expect(placed.every((o) => o.clOrdID.split("-")[1] === "2" && o.type !== "market")).toBe(true);
    expect(qty("sell").lte(3)).toBe(true);
    expect(qty("buy").add(3).lte(5)).toBe(true);
    await finish(e, botId);
  });

  it("applies a waiting version once the engine gives up an unknown starting order and reports it done (#223 M3)", async () => {
    const { eq } = await import("drizzle-orm");
    const gw = new PosGateway();
    const { botId } = await seedBot("running", grid);
    const e = posEngine(gw, "pos-m3");
    await e.tick();
    gw.timeoutNext = "lost";
    await e.onPrice("BTC-USD", "100", clock);
    const [row] = (await db.select().from(orders).where(eq(orders.botId, botId))).filter(
      (o) => o.tag === "grid:init",
    );
    const init = row?.clOrdId ?? "";
    expect(row?.status).toBe("unknown");
    await pendingV2(botId, { maxLoss: "150" });
    await step(e, 1_000);
    expect(await activeVersion(botId)).toBe(1);
    expect((await allEvents(botId)).find((x) => x.decision === "Applying v2")?.why).toBe(
      "Waits for an order in flight to finish or the open position to close; v1 keeps managing the bot until then. No orders were cancelled.",
    );
    await db
      .update(orders)
      .set({ sodexOrderId: 78n, missingConfirmedAt: new Date(clock - 11 * 60_000) })
      .where(eq(orders.clOrdId, init));
    for (let i = 0; i < 8 && (await activeVersion(botId)) !== 2; i += 1) await step(e, 60_000);
    expect(
      (await db.select().from(orders).where(eq(orders.clOrdId, init)))[0]?.unknownGaveUpAt,
    ).not.toBeNull();
    expect(await activeVersion(botId)).toBe(2);
    await finish(e, botId);
  });

  it("retries the given-up booking when the trades read failed, so a waiting version still applies (#223 re-review minor 2)", async () => {
    const { eq } = await import("drizzle-orm");
    let failTrades = true;
    const gw = new (class extends PosGateway {
      override recentTrades(a: AccountRef): Promise<(OrderTrade & { clOrdID: string })[]> {
        return failTrades ? Promise.reject(new Error("SoDEX down")) : super.recentTrades(a);
      }
    })();
    const { botId } = await seedBot("running", grid);
    const e = posEngine(gw, "pos-m3-retry");
    await e.tick();
    gw.timeoutNext = "lost";
    await e.onPrice("BTC-USD", "100", clock);
    const [row] = (await db.select().from(orders).where(eq(orders.botId, botId))).filter(
      (o) => o.tag === "grid:init",
    );
    const init = row?.clOrdId ?? "";
    await pendingV2(botId, { maxLoss: "150" });
    await db
      .update(orders)
      .set({ sodexOrderId: 79n, missingConfirmedAt: new Date(clock - 11 * 60_000) })
      .where(eq(orders.clOrdId, init));
    for (let i = 0; i < 4; i += 1) await step(e, 60_000);
    const gaveUp = (await db.select().from(orders).where(eq(orders.clOrdId, init)))[0];
    expect(gaveUp?.unknownGaveUpAt).not.toBeNull();
    expect(gaveUp?.doneFedAt).toBeNull();
    expect(await activeVersion(botId)).toBe(1);
    failTrades = false;
    for (let i = 0; i < 4 && (await activeVersion(botId)) !== 2; i += 1) await step(e, 60_000);
    expect(
      (await db.select().from(orders).where(eq(orders.clOrdId, init)))[0]?.doneFedAt,
    ).not.toBeNull();
    expect(await activeVersion(botId)).toBe(2);
    await finish(e, botId);
  });

  /**
   * Engine ghi lại log warn: đếm lượt đọc / ghi của đường bỏ cuộc theo log, vì lưới an toàn fill cũng đọc lịch sử khớp
   * trong cùng vòng nên không đếm lời gọi cổng được.
   */
  const GAVE_UP_READ_FAILED = "could not read trades for a given-up order; the bot keeps waiting";
  const GAVE_UP_DONE =
    "given-up order is confirmed missing on SoDEX; its trades are booked and the bot moves on";
  const gaveUpEngine = (gw: Gateway, workerId: string) => {
    const warned: string[] = [];
    const e = new Engine({
      db,
      redis: newRedis(),
      gateway: gw,
      workerId,
      log: {
        ...log,
        warn: (...args: unknown[]) => {
          if (typeof args[1] === "string") warned.push(args[1]);
        },
      },
      now,
      leaseTtlMs: 30_000,
      shards: SHARDS,
      rules: () => Promise.resolve(rules),
      feeCheckMs: 0,
    });
    return { e, count: (m: string) => warned.filter((x) => x === m).length };
  };
  /** Lệnh khởi tạo của grid gửi đi không rõ kết quả, rồi được xác nhận không còn trên SoDEX từ 11 phút trước. */
  const lostInit = async (e: RealEngine, gw: FakeGateway, botId: string, sodexOrderId: bigint) => {
    const { eq } = await import("drizzle-orm");
    await e.tick();
    gw.timeoutNext = "lost";
    await e.onPrice("BTC-USD", "100", clock);
    const row = async () =>
      (await db.select().from(orders).where(eq(orders.botId, botId))).find(
        (o) => o.tag === "grid:init",
      );
    const init = (await row())?.clOrdId ?? "";
    expect((await row())?.status).toBe("unknown");
    await db
      .update(orders)
      .set({ sodexOrderId, missingConfirmedAt: new Date(clock - 11 * 60_000) })
      .where(eq(orders.clOrdId, init));
    return { init, qty: (await row())?.size ?? "0", row };
  };

  it("retries a given-up order with trades: books them once, feeds orderDone once, at most once per GAVE_UP_RETRY_MS (#250, review #254)", async () => {
    const { eq } = await import("drizzle-orm");
    let failTrades = true;
    const gw = new (class extends PosGateway {
      override recentTrades(a: AccountRef): Promise<(OrderTrade & { clOrdID: string })[]> {
        if (!failTrades) return super.recentTrades(a);
        return Promise.reject(new Error("SoDEX down"));
      }
    })();
    const { botId } = await seedBot("running", grid);
    const { e, count } = gaveUpEngine(gw, "pos-gaveup-trades");
    const { init, qty, row } = await lostInit(e, gw, botId, 81n);
    const sentBefore = gw.received.length;

    // Bỏ cuộc: ghi Decisions một lần, đọc trade ngay lúc đó nhưng SoDEX lỗi nên chưa báo kết thúc.
    for (let i = 0; i < 4 && (await row())?.unknownGaveUpAt == null; i += 1) await step(e, 60_000);
    expect((await row())?.unknownGaveUpAt).not.toBeNull();
    expect((await row())?.doneFedAt).toBeNull();
    expect(count(GAVE_UP_READ_FAILED)).toBe(1);
    // Vòng sau thử lại một lần (lỗi), rồi chờ đủ GAVE_UP_RETRY_MS mới thử tiếp.
    await step(e, 1_000);
    expect(count(GAVE_UP_READ_FAILED)).toBe(2);
    await step(e, GAVE_UP_RETRY_MS / 3);
    await step(e, GAVE_UP_RETRY_MS / 3);
    expect(count(GAVE_UP_READ_FAILED)).toBe(2);
    await step(e, GAVE_UP_RETRY_MS / 3);
    expect(count(GAVE_UP_READ_FAILED)).toBe(3);

    // SoDEX đọc được trở lại và lệnh đã khớp đủ: lần thử sau ghi trade (dòng thành `filled`) rồi báo kết thúc.
    const t = {
      tradeId: 81_000n + BigInt(Math.floor(Math.random() * 1e9)),
      price: "100",
      quantity: qty,
      fee: "0.02",
      builderFee: null,
      isMaker: false,
      at: clock,
    };
    gw.trades.set(init, [t]);
    gw.perpsPositions.set("BTC-USD", { size: qty, entryPrice: "100" });
    failTrades = false;
    await step(e, GAVE_UP_RETRY_MS);
    const done = await row();
    expect(done?.doneFedAt).not.toBeNull();
    expect(done?.status).toBe("filled");
    expect(Number(done?.filledSize)).toBe(Number(qty));
    const booked = async () =>
      (
        await db
          .select()
          .from(fills)
          .where(eq(fills.orderId, done?.id ?? ""))
      ).map((f) => [f.sodexTradeId, Number(f.size)]);
    expect(await booked()).toEqual([[t.tradeId, Number(qty)]]);
    expect(await ledgerOf(botId)).toBe(dec(qty).toString());
    expect(count(GAVE_UP_DONE)).toBe(1);
    expect(count(GAVE_UP_READ_FAILED)).toBe(3);

    // Sau lần thử thành công: không thử lại, không ghi trade lần hai, không báo kết thúc lần hai.
    for (let i = 0; i < 3; i += 1) await step(e, GAVE_UP_RETRY_MS);
    expect((await row())?.doneFedAt).toEqual(done?.doneFedAt);
    expect(await booked()).toEqual([[t.tradeId, Number(qty)]]);
    expect(await ledgerOf(botId)).toBe(dec(qty).toString());
    expect(count(GAVE_UP_DONE)).toBe(1);
    expect(count(GAVE_UP_READ_FAILED)).toBe(3);
    // Không gửi lại lệnh khởi tạo (quy tắc 1.7); Decisions "Order result unknown" chỉ một dòng.
    expect(gw.received.slice(sentBefore).filter((o) => o.tag === "grid:init")).toEqual([]);
    const unknownEvents = (await allEvents(botId)).filter(
      (x) => x.decision === "Order result unknown",
    );
    expect(unknownEvents.map((x) => x.why)).toEqual([unknownGaveUpWhy(init)]);
    await finish(e, botId);
  });

  it("feeds orderDone once after a successful retry of a given-up order with no trades (#250, review #254)", async () => {
    let failTrades = true;
    const gw = new (class extends PosGateway {
      override recentTrades(a: AccountRef): Promise<(OrderTrade & { clOrdID: string })[]> {
        return failTrades ? Promise.reject(new Error("SoDEX down")) : super.recentTrades(a);
      }
    })();
    const { botId } = await seedBot("running", grid);
    const { e, count } = gaveUpEngine(gw, "pos-gaveup-once");
    const { row } = await lostInit(e, gw, botId, 82n);
    for (let i = 0; i < 4 && (await row())?.unknownGaveUpAt == null; i += 1) await step(e, 60_000);
    expect(count(GAVE_UP_READ_FAILED)).toBe(1);
    // SoDEX không có trade nào của lệnh: dòng vẫn `unknown`, chỉ `done_fed_at` giữ cho lần thử không lặp lại.
    failTrades = false;
    await step(e, GAVE_UP_RETRY_MS);
    const done = await row();
    expect(done?.status).toBe("unknown");
    expect(done?.doneFedAt).not.toBeNull();
    expect(count(GAVE_UP_DONE)).toBe(1);
    for (let i = 0; i < 3; i += 1) await step(e, GAVE_UP_RETRY_MS);
    expect(count(GAVE_UP_DONE)).toBe(1);
    expect((await row())?.doneFedAt).toEqual(done?.doneFedAt);
    expect(Number((await row())?.filledSize)).toBe(0);
    await finish(e, botId);
  });

  const dca = {
    strategy: "futures_dca",
    market: "BTC-USD",
    engine: "perps" as const,
    config: {
      market: "BTC-USD",
      leverage: 2,
      marginMode: "cross",
      direction: "long",
      baseOrder: "100",
      safetyOrder: "100",
      maxSafetyOrders: 2,
      firstStepPct: "2",
      stepMultiplier: "1",
      sizeMultiplier: "1",
      takeProfitPct: "1",
      stopLossPct: "10",
    },
  };
  /** Bot Futures DCA đang chạy: base 2 BTC đã khớp ở 100, safety + take profit trên sổ. */
  async function dcaRunning(gw: PosGateway, id: string) {
    const { botId, accountId } = await seedBot("running", dca);
    const e = posEngine(gw, id);
    await e.tick();
    await e.onPrice("BTC-USD", "100", clock);
    const base = gw.received.find((o) => o.tag === "dca:1:base")?.clOrdID ?? "";
    clock += 100;
    await e.onFill(accountId, base, "2", "100", "0", clock);
    await e.onOrderClosed(accountId, base, "filled", clock);
    gw.perpsPositions.set("BTC-USD", { size: "2", entryPrice: "100" });
    expect(await ledgerOf(botId)).toBe("2");
    return { botId, accountId, e };
  }

  it("Futures DCA end to end: the new version keeps the position, waits for v1 orders, then rebuilds a reduce-only take profit (#223)", async () => {
    const gw = new PosGateway();
    const { botId, e } = await dcaRunning(gw, "pos-dca");
    expect(gw.received.some((o) => o.tag.startsWith("dca:1:tp"))).toBe(true);
    await pendingV2(botId, { takeProfitPct: "2" });
    await step(e, 1_000);
    expect(await activeVersion(botId)).toBe(2);
    expect(await ledgerOf(botId)).toBe("2");
    expect((await allEvents(botId)).find((x) => x.decision === "Applied v2")?.why).toMatch(
      /kept the open position/,
    );
    const sent = gw.received.length;
    clock += 1_000;
    await e.onPrice("BTC-USD", "100", clock);
    const placed = gw.received.slice(sent);
    expect(placed.some((o) => o.type === "market")).toBe(false);
    expect(placed.find((o) => o.side === "sell")).toMatchObject({
      price: "102",
      quantity: "2",
      reduceOnly: true,
    });
    expect(placed.every((o) => o.clOrdID.split("-")[1] === "2")).toBe(true);
    await finish(e, botId);
  });

  it("Stop while a DCA direction flip waits: the bot stops on v1 and v2 never runs (#223)", async () => {
    const { eq } = await import("drizzle-orm");
    const gw = new PosGateway();
    const { botId, e } = await dcaRunning(gw, "pos-dca-stop");
    await pendingV2(botId, { direction: "short" });
    await step(e, 1_000);
    expect(await activeVersion(botId)).toBe(1);
    expect((await allEvents(botId)).some((x) => x.decision === "Applying v2")).toBe(true);
    const sent = gw.received.length;
    await db.update(bots).set({ state: "stopping" }).where(eq(bots.id, botId));
    for (let i = 0; i < 4 && (await botState(botId))?.state !== "stopped"; i += 1)
      await step(e, 1_000);
    expect((await botState(botId))?.state).toBe("stopped");
    expect(gw.received.slice(sent).filter((o) => o.clOrdID.split("-")[1] === "2")).toEqual([]);
    expect(await activeVersion(botId)).toBe(1);
    await e.stop();
  });

  it("uses the normal tiers (with a trades read) when the replaced ledger was flat (N2)", async () => {
    const { eq } = await import("drizzle-orm");
    const gw = new PosGateway();
    const { botId, accountId } = await seedBot("running", grid);
    const e = posEngine(gw, "pos-ver-flat");
    await e.tick();
    await e.onPrice("BTC-USD", "100", clock);
    expect(await ledgerOf(botId)).toBe("0");
    const [v1] = await db.select().from(botVersions).where(eq(botVersions.botId, botId));
    await db.insert(botVersions).values({
      botId,
      version: 2,
      paramSource: "manual",
      status: "pending",
      config: v1?.config ?? {},
    });
    gw.perpsPositions.set("BTC-USD", { size: "2", entryPrice: "100" });
    for (let i = 0; i < 4; i += 1) await step(e);
    expect(gw.recentTradesBy).toContain(accountId);
    expect((await allEvents(botId)).some((x) => x.decision === "Position not tracked")).toBe(false);
    expect((await botState(botId))?.positionMismatch?.["BTC-USD"]?.cause).toBe("trades");
    await finish(e, botId);
  });

  it("replays resumed after a restart for a running, flagged bot whose strategy is still halted (N1)", async () => {
    const { eq } = await import("drizzle-orm");
    const gw = new PosGateway();
    const { botId, e } = await running(gw, "pos-n1");
    await e.stop();
    // Engine chết sau khi `resumed` bị giữ: bot đang chạy, chiến lược còn halted, cảnh báo còn đó.
    const [rt] = await db.select().from(botRuntime).where(eq(botRuntime.botId, botId));
    await db
      .update(botRuntime)
      .set({ state: { ...(rt?.state as Record<string, unknown>), phase: "halted" } })
      .where(eq(botRuntime.botId, botId));
    await flag(botId, "BTC-USD", "5", "2");
    gw.perpsPositions.set("BTC-USD", { size: "5", entryPrice: "100" });
    const e2 = posEngine(gw, "pos-n1b");
    await e2.tick();
    clock += 1_000;
    await e2.onPrice("BTC-USD", "100", clock);
    const phase = async () => {
      const [x] = await db.select().from(botRuntime).where(eq(botRuntime.botId, botId));
      return (x?.state as { phase?: string }).phase;
    };
    // Mọi mức grid còn lệnh trên sổ: bước `resumed` không thêm gì vào vị thế nên đi ngay (không có N1 thì grid halted bỏ
    // qua giá mãi).
    expect(await phase()).not.toBe("halted");
    expect((await botState(botId))?.state).toBe("running");
    await finish(e2, botId);
  });

  it("uses the real position at read plus ledger moves since then (M2)", () => {
    expect(effectiveReal("5", "2", "1")).toBe("4");
    expect(effectiveReal("5", "2", null)).toBe("5");
    expect(effectiveReal("-1", "0", "0.5")).toBe("-0.5");
  });

  it("drops the flag when the bot stops (M6)", async () => {
    const gw = new PosGateway();
    const { botId, e } = await running(gw, "pos-stop");
    await flag(botId, "BTC-USD", "5", "2");
    const { eq } = await import("drizzle-orm");
    await db.update(bots).set({ state: "stopping" }).where(eq(bots.id, botId));
    for (let i = 0; i < 5 && (await botState(botId))?.state !== "stopped"; i += 1)
      await step(e, 1_000);
    expect((await botState(botId))?.state).toBe("stopped");
    expect((await botState(botId))?.positionMismatch).toBeNull();
    await e.stop();
  });

  it("skips a market with two live bots of the same account (and drops its flag), a paper bot, and a failed read", async () => {
    const { eq } = await import("drizzle-orm");
    // Hai bot thật cùng account × market (một bot paused): không đọc, không so, bỏ cảnh báo đã ghi (M6).
    const gw = new PosGateway();
    const { botId, accountId, e } = await running(gw, "pos-two");
    await flag(botId, "BTC-USD", "9", "2");
    const [b] = await db.select().from(bots).where(eq(bots.id, botId));
    await db.insert(bots).values({
      userId: b?.userId ?? "",
      sodexAccountId: accountId,
      strategy: "futures_grid",
      market: "BTC-USD",
      engine: "perps",
      name: "Other",
      state: "paused",
    });
    gw.perpsPositions.set("BTC-USD", { size: "9", entryPrice: "100" });
    const reads = gw.readsBy.filter((a) => a === accountId).length;
    for (let i = 0; i < 5; i += 1) await step(e);
    expect(gw.readsBy.filter((a) => a === accountId).length).toBe(reads);
    expect(await eventsOf(botId)).toEqual([]);
    expect((await botState(botId))?.positionMismatch).toBeNull();
    await finish(e, botId);
    await db.update(bots).set({ state: "stopped" }).where(eq(bots.sodexAccountId, accountId));

    // Bot paper: không bao giờ đọc SoDEX.
    const pgw = new PosGateway();
    const paper = await seedBot("running", grid);
    await db.update(bots).set({ mode: "paper" }).where(eq(bots.id, paper.botId));
    await db.insert(paperAccounts).values({
      botId: paper.botId,
      capital: "1000",
      cash: "1000",
      positions: {},
      peakEquity: "1000",
      startedAt: new Date(clock),
    });
    const pe = posEngine(pgw, "pos-paper", new PaperGateway({ db, now }));
    await pe.tick();
    await pe.onPrice("BTC-USD", "100", clock);
    for (let i = 0; i < 5; i += 1) await step(pe);
    expect(pgw.readsBy).not.toContain(paper.accountId);
    await finish(pe, paper.botId);

    // Đọc lỗi (hết rate limit): bỏ lượt, không đọc trade, không cảnh báo.
    const rgw = new PosGateway();
    const limited = await running(rgw, "pos-rate");
    rgw.positionError = new Error("SoDEX rate limit reached");
    rgw.perpsPositions.set("BTC-USD", { size: "7", entryPrice: "100" });
    for (let i = 0; i < 6; i += 1) await step(limited.e);
    expect(rgw.readsBy.filter((a) => a === limited.accountId).length).toBeGreaterThanOrEqual(6);
    expect(rgw.recentTradesBy).not.toContain(limited.accountId);
    expect(await eventsOf(limited.botId)).toEqual([]);
    expect((await botState(limited.botId))?.needsAttention).toBe(false);
    await finish(limited.e, limited.botId);
  });
});

describe("slow SoDEX reads stay with their own account (DEC-308)", () => {
  /** SoDEX chậm cho một số account: mọi lần đọc (tra lệnh, lịch sử khớp, vị thế) của chúng chờ tới khi test thả ra. */
  class SlowGateway extends FakeGateway {
    readonly slow = new Set<string>();
    /** Account (id trong DB) của mỗi lần tra lệnh. */
    readonly lookupsBy: string[] = [];
    release: () => void = () => undefined;
    readonly #gate = new Promise<void>((resolve) => {
      this.release = resolve;
    });
    #wait(a: AccountRef): Promise<void> {
      return this.slow.has(a.id) ? this.#gate : Promise.resolve();
    }
    override lookup(a: AccountRef, o: { clOrdID: string }): Promise<LookupResult> {
      this.lookupsBy.push(a.id);
      return this.#wait(a).then(() => super.lookup(a, o));
    }
    override readPositions(
      a: AccountRef,
    ): Promise<Map<string, { size: string; entryPrice: string }>> {
      return this.#wait(a).then(() => super.readPositions(a));
    }
    override recentTrades(a: AccountRef): Promise<(OrderTrade & { clOrdID: string })[]> {
      return this.#wait(a).then(() => super.recentTrades(a));
    }
    /** Account của mỗi lần đọc approval builder fee (bước `checkFees`, sau các bước đọc). */
    readonly approvedBy: string[] = [];
    override builderApproved(a?: AccountRef): Promise<boolean> {
      if (a !== undefined) this.approvedBy.push(a.id);
      return super.builderApproved();
    }
  }
  const twap = {
    strategy: "twap",
    market: "BTC-USD",
    engine: "perps" as const,
    config: {
      market: "BTC-USD",
      engine: "perps",
      side: "buy",
      totalSize: "1",
      durationMinutes: 10,
      slices: 10,
      reduceOnly: false,
      maxSlippagePct: "1",
      onSkip: "leave_unfilled",
    },
  };
  const slowEngine = (gw: Gateway, workerId: string) =>
    new Engine({
      db,
      redis: newRedis(),
      gateway: gw,
      workerId,
      log,
      now,
      leaseTtlMs: 30_000,
      shards: SHARDS,
      rules: () => Promise.resolve(rules),
      feeCheckMs: 0,
      tickWaitMs: 200,
    });
  /** Lệnh `unknown` đủ cũ để `#reconcile` tra SoDEX ở vòng tới. */
  async function unknownOrder(botId: string, accountId: string) {
    const clOrdID = `slow-${String(Math.random())}`;
    await db.insert(orders).values({
      botId,
      sodexAccountId: accountId,
      clOrdId: clOrdID,
      market: "vBTC_vUSDC",
      engine: "spot",
      side: "buy",
      type: "limit",
      price: "90",
      timeInForce: "GTC",
      size: "1",
      status: "unknown",
      reduceOnly: false,
      epoch: 1,
      tag: "grid:0:buy",
      submittedAt: new Date(clock - 10_000),
    });
    return clOrdID;
  }
  async function cleanup(botIds: string[], clOrdIDs: string[]) {
    const { inArray } = await import("drizzle-orm");
    await db.update(bots).set({ state: "stopped" }).where(inArray(bots.id, botIds));
    await db.update(orders).set({ status: "cancelled" }).where(inArray(orders.clOrdId, clOrdIDs));
  }

  it("keeps ticking, and runs the clock of an account in another shard, while one account waits on SoDEX", async () => {
    const gw = new SlowGateway();
    const slow = await seedBot("running");
    let fast = await seedBot("running", twap);
    const extra: string[] = [];
    while (shardOf(fast.accountId, SHARDS) === shardOf(slow.accountId, SHARDS)) {
      extra.push(fast.botId);
      await cleanup([fast.botId], []);
      fast = await seedBot("running", twap);
    }
    gw.slow.add(slow.accountId);
    const stuck = await unknownOrder(slow.botId, slow.accountId);
    const e = slowEngine(gw, "slow-sodex");
    const slices = () => gw.received.filter((o) => o.market === "BTC-USD");
    const tickTimes: number[] = [];
    const timedTick = async () => {
      const at = performance.now();
      await e.tick();
      tickTimes.push(performance.now() - at);
    };
    await timedTick();
    // Tra lệnh của account chậm đang treo; account kia vẫn nạp bot và nhận giá.
    expect(gw.lookupsBy.filter((a) => a === slow.accountId)).toHaveLength(1);
    await e.onPrice("BTC-USD", "100", clock);
    for (let i = 0; i < 6 && slices().length === 0; i += 1) {
      clock += 61_000;
      await timedTick();
      await e.onPrice("BTC-USD", "100", clock);
    }
    // Đồng hồ TWAP của account kia chạy (đặt lát) trong lúc account chậm vẫn chờ SoDEX.
    expect(slices().length).toBeGreaterThan(0);
    // Mỗi vòng chỉ chờ tối đa tickWaitMs; shard của account chậm không bị chạy chồng (không tra lại khi còn treo).
    expect(Math.max(...tickTimes)).toBeLessThan(1_000);
    expect(gw.lookupsBy.filter((a) => a === slow.accountId)).toHaveLength(1);
    // SoDEX trả lời: shard của account chậm chạy lại từ vòng sau.
    gw.release();
    for (let i = 0; i < 20 && gw.lookupsBy.filter((a) => a === slow.accountId).length < 2; i += 1) {
      clock += 16_000;
      await timedTick();
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(gw.lookupsBy.filter((a) => a === slow.accountId).length).toBeGreaterThanOrEqual(2);
    await e.stop();
    await cleanup([slow.botId, fast.botId, ...extra], [stuck]);
  });

  it("reads SoDEX for other accounts of the same shard while one account's read hangs", async () => {
    const gw = new SlowGateway();
    const slow = await seedBot("running");
    const others: { botId: string; accountId: string }[] = [];
    let same: { botId: string; accountId: string } | undefined;
    while (same === undefined) {
      const b = await seedBot("running");
      if (shardOf(b.accountId, SHARDS) === shardOf(slow.accountId, SHARDS)) same = b;
      else others.push(b);
    }
    gw.slow.add(slow.accountId);
    const ids = [
      await unknownOrder(slow.botId, slow.accountId),
      await unknownOrder(same.botId, same.accountId),
    ];
    const e = slowEngine(gw, "slow-shard");
    await e.tick();
    // Hai account cùng shard: lần tra của account kia không xếp hàng sau lần tra đang treo.
    expect(gw.lookupsBy).toContain(slow.accountId);
    expect(gw.lookupsBy).toContain(same.accountId);
    gw.release();
    await e.stop();
    await cleanup([slow.botId, same.botId, ...others.map((x) => x.botId)], ids);
  });

  it("stop() ends a slow lane at its next step: nothing more runs after (review #216 M2)", async () => {
    const gw = new SlowGateway();
    const slow = await seedBot("running");
    gw.slow.add(slow.accountId);
    const stuck = await unknownOrder(slow.botId, slow.accountId);
    const e = slowEngine(gw, "slow-stop");
    await e.tick();
    // Làn đang treo ở `reconcile`, chưa tới `checkFees`.
    expect(gw.lookupsBy).toContain(slow.accountId);
    expect(gw.approvedBy).not.toContain(slow.accountId);
    const stopping = e.stop();
    gw.release();
    const at = performance.now();
    await stopping;
    expect(performance.now() - at).toBeLessThan(5_000);
    // Sau khi dừng, làn không chạy thêm bước nào (checkFees, clock…).
    expect(gw.approvedBy).not.toContain(slow.accountId);
    await cleanup([slow.botId], [stuck]);
  });

  it("an old lane stops when its shard's lease is lost and taken again: no stale runner, the new lease is kept (review #216 M1)", async () => {
    const { eq } = await import("drizzle-orm");
    const market = "vM1_vUSDC";
    let open: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const gw = new FakeGateway();
    const { botId, accountId } = await seedBot("starting", {
      strategy: "spot_grid",
      market,
      engine: "spot",
      config: {
        market,
        lowerPrice: "90",
        upperPrice: "110",
        gridLevels: 5,
        spacing: "arithmetic",
        investment: "500",
        maxLoss: "100",
        onStop: "keep_base",
      },
    });
    const shard = shardOf(accountId, SHARDS);
    const e = new Engine({
      db,
      redis: newRedis(),
      gateway: gw,
      workerId: "lane-epoch",
      log,
      now,
      leaseTtlMs: 600,
      shards: SHARDS,
      // Nạp bot của market này treo: làn của shard dừng giữa `syncBots`.
      rules: (m) => (m === market ? gate.then(() => rules) : Promise.resolve(rules)),
      feeCheckMs: 0,
      tickWaitMs: 100,
    });
    await e.tick();
    const first = e.epochOf(shard) ?? 0;
    expect(first).toBeGreaterThan(0);
    // Worker khác nhận shard: key lease mất, epoch trong DB đổi. Timer gia hạn phát hiện và bỏ shard.
    await newRedis().del(`lease:shard:${String(shard)}`);
    await db
      .update(shardEpochs)
      .set({ epoch: first + 1, owner: "someone-else" })
      .where(eq(shardEpochs.shard, shard));
    for (let i = 0; i < 60 && e.ownedShards.includes(shard); i += 1)
      await new Promise((r) => setTimeout(r, 50));
    expect(e.ownedShards).not.toContain(shard);
    // Làn cũ còn chạy: không nhận lại shard ở vòng này.
    await e.tick();
    expect(e.ownedShards).not.toContain(shard);
    // Làn cũ nạp xong bot: không được thêm runner mang epoch cũ; vòng sau nhận lại shard với epoch mới.
    open();
    for (let i = 0; i < 40 && !e.ownedShards.includes(shard); i += 1) {
      await new Promise((r) => setTimeout(r, 50));
      await e.tick();
    }
    expect(e.ownedShards).toContain(shard);
    expect(e.epochOf(shard)).toBeGreaterThan(first + 1);
    for (let i = 0; i < 20 && (await botState(botId))?.state !== "starting"; i += 1) await e.tick();
    // Runner nạp lại dưới epoch mới: lệnh đi và ghi được (không bị fencing), bot chạy; lease mới vẫn giữ.
    await e.tick();
    await e.onPrice(market, "100", clock);
    expect(gw.received.some((o) => o.market === market)).toBe(true);
    expect((await botState(botId))?.state).toBe("running");
    expect(e.ownedShards).toContain(shard);
    await e.stop();
    await cleanup([botId], []);
  });

  it("runs the normal start flow when every lane outlives the tick", async () => {
    const gw = new FakeGateway();
    const { botId, accountId } = await seedBot();
    const e = new Engine({
      db,
      redis: newRedis(),
      gateway: gw,
      workerId: "lane-outlives",
      log,
      now,
      leaseTtlMs: 30_000,
      shards: SHARDS,
      rules: () => Promise.resolve(rules),
      feeCheckMs: 0,
      tickWaitMs: 1,
    });
    const loaded = async () => (await e.activeStreams()).some((x) => x.account.id === accountId);
    for (let i = 0; i < 40 && !(await loaded()); i += 1) {
      await e.tick();
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(await loaded()).toBe(true);
    await e.onPrice("vBTC_vUSDC", "100", clock);
    expect(gw.received.some((o) => o.tag === "grid:init")).toBe(true);
    expect((await botState(botId))?.state).toBe("running");
    await e.stop();
    await cleanup([botId], []);
  });

  it("says DeskLabs did not send an order for a market SoDEX does not list, without a SoDEX code", async () => {
    const { eq } = await import("drizzle-orm");
    const gw = new FakeGateway();
    gw.reject = { code: "MARKET_NOT_FOUND", message: "Market is not listed on SoDEX." };
    const { botId } = await seedBot();
    const e = slowEngine(gw, "local-refusal");
    await e.tick();
    await e.onPrice("vBTC_vUSDC", "100", clock);
    const events = await db.select().from(botEvents).where(eq(botEvents.botId, botId));
    const line = events.find((x) => x.decision?.startsWith("DeskLabs didn't send") === true);
    expect(line?.decision).toBe(
      "DeskLabs didn't send the order: vBTC_vUSDC is not listed on SoDEX.",
    );
    expect(line?.why ?? "").not.toContain("SoDEX code");
    expect(events.some((x) => x.decision?.startsWith("Order refused by SoDEX") === true)).toBe(
      false,
    );
    await e.stop();
    await cleanup([botId], []);
  });
});

describe("worker-wide REST budget for order lookups (DEC-310)", () => {
  it("looks up at most ~50% of the IP bucket per minute, suspect orders first, one account at a time", async () => {
    const { eq, inArray } = await import("drizzle-orm");
    // Lệnh mở còn sót của các test trước không được tính vào ngân sách của test này.
    await db
      .update(orders)
      .set({ status: "cancelled" })
      .where(inArray(orders.status, ["open", "partially_filled", "unknown"]));
    const gw = new FakeGateway();
    const looked: string[] = [];
    const lookup = gw.lookup.bind(gw);
    gw.lookup = (a, o) => {
      looked.push(o.clOrdID);
      return lookup(a, o);
    };
    // 30 account có bot đã dừng còn 2 lệnh limit nằm sổ (tra định kỳ), 1 account có 2 lệnh market (nghi ngờ).
    const row = (botId: string, accountId: string, type: "limit" | "market", i: number) => ({
      botId,
      sodexAccountId: accountId,
      clOrdId: `${type}-${String(i)}-${String(Math.random())}`,
      market: "BUD-USD",
      engine: "perps" as const,
      side: "buy" as const,
      type,
      price: type === "limit" ? "90" : null,
      timeInForce: type === "limit" ? "GTC" : "IOC",
      size: "1",
      status: "open" as const,
      reduceOnly: false,
      epoch: 1,
      tag: "bud",
      submittedAt: new Date(clock - 60_000 - i),
    });
    const owners = new Map<string, string>();
    const botIds: string[] = [];
    for (let a = 0; a < 30; a += 1) {
      const b = await seedBot();
      botIds.push(b.botId);
      const list = [
        row(b.botId, b.accountId, "limit", a * 2),
        row(b.botId, b.accountId, "limit", a * 2 + 1),
      ];
      for (const x of list) owners.set(x.clOrdId, b.accountId);
      await db.insert(orders).values(list);
    }
    const s = await seedBot();
    botIds.push(s.botId);
    const suspects = [
      row(s.botId, s.accountId, "market", 1000),
      row(s.botId, s.accountId, "market", 1001),
    ];
    await db.insert(orders).values(suspects);
    await db.update(bots).set({ state: "stopped" }).where(inArray(bots.id, botIds));
    const e = new Engine({
      db,
      redis: newRedis(),
      gateway: gw,
      workerId: "budget",
      log,
      now,
      leaseTtlMs: 30_000,
      shards: SHARDS,
      rules: () => Promise.resolve(rules),
      feeCheckMs: 0,
      lookupBudget: LOOKUP_BUDGET.weight,
    });
    await e.tick();
    // Mỗi lần tra tính tối đa tra lệnh + đọc lịch sử khớp (lệnh không thấy thì đọc trade).
    const max = Math.floor(LOOKUP_BUDGET.weight / (LOOKUP_WEIGHT + TRADES_WEIGHT));
    expect(looked.length).toBe(max);
    // Lệnh nghi ngờ trước; rồi luân phiên: không account nào được tra 2 lệnh khi account khác chưa được tra lệnh nào.
    for (const x of suspects) expect(looked).toContain(x.clOrdId);
    const perAccount = new Map<string, number>();
    for (const id of looked) {
      const acc = owners.get(id);
      if (acc !== undefined) perAccount.set(acc, (perAccount.get(acc) ?? 0) + 1);
    }
    expect(Math.max(...perAccount.values())).toBe(1);
    expect(perAccount.size).toBe(max - suspects.length);
    // Hết ngân sách trong 60 s: vòng sau không tra thêm; qua cửa sổ 60 s thì tra tiếp.
    clock += 1_000;
    await e.tick();
    expect(looked.length).toBe(max);
    clock += LOOKUP_BUDGET.windowMs;
    await e.tick();
    expect(looked.length).toBeGreaterThan(max);
    expect(looked.length).toBeLessThanOrEqual(2 * max);
    await e.stop();
    await db.update(orders).set({ status: "cancelled" }).where(eq(orders.market, "BUD-USD"));
  });
});

// ---------- #224: bước clock chạy song song theo account, có giới hạn ----------
describe("clock runs accounts in parallel, bounded (#224)", { timeout: 120_000 }, () => {
  let url = "";
  let clockPool: ReturnType<typeof createDb>["pool"];
  let clockDb: Db;
  beforeAll(async () => {
    const admin = createDb(pg.getConnectionUri());
    await admin.pool.query("CREATE DATABASE clock_parallel");
    await admin.pool.end();
    url = pg.getConnectionUri().replace(/\/[^/?]+(\?|$)/, "/clock_parallel$1");
    await runMigrations(url);
    // Pool như engine thật (createDb: max 10), để đo hàng chờ kết nối.
    ({ db: clockDb, pool: clockPool } = createDb(url));
    cleanPools.push(clockPool);
  });
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  /** Cổng giả có độ trễ: đếm lời gọi gửi lệnh đang chạy cùng lúc (cả worker và theo account). */
  class ClockGateway extends FakeGateway {
    submitDelayMs = 0;
    inFlight = 0;
    maxInFlight = 0;
    /** Account mà lần gửi lệnh kế tiếp của nó ném lỗi (signer / mạng), một lần. */
    readonly failNext = new Set<string>();
    readonly calls: { account: string; clOrdIDs: string[]; start: number; end: number }[] = [];
    override async submit(
      a: AccountRef,
      list: readonly OrderIntent[],
      fence: Fence,
      builderFeeRate?: number,
    ): Promise<SubmitResult[]> {
      this.inFlight += 1;
      this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
      const start = performance.now();
      try {
        await sleep(this.submitDelayMs);
        if (this.failNext.delete(a.id)) throw new Error("signer unreachable");
        return await super.submit(a, list, fence, builderFeeRate);
      } finally {
        this.inFlight -= 1;
        this.calls.push({
          account: a.id,
          clOrdIDs: list.map((o) => o.clOrdID),
          start,
          end: performance.now(),
        });
      }
    }
  }

  /** DB của engine có độ trễ trong mỗi transaction (giữ kết nối như ghi thật) và đếm transaction đang mở cùng lúc. */
  const tx = { delayMs: 0, open: 0, maxOpen: 0, maxWaiting: 0, maxClients: 0 };
  const slowDb = new Proxy(
    {},
    {
      get(_t, key) {
        if (key === "transaction")
          return async (work: (t: Db) => Promise<unknown>) =>
            clockDb.transaction(async (t) => {
              tx.open += 1;
              tx.maxOpen = Math.max(tx.maxOpen, tx.open);
              try {
                await sleep(tx.delayMs);
                return await work(t);
              } finally {
                tx.open -= 1;
              }
            });
        const v: unknown = Reflect.get(clockDb, key, clockDb);
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(clockDb) : v;
      },
    },
  ) as Db;

  const warned: string[] = [];
  const clockEngine = (gw: Gateway, workerId: string, clockConcurrency?: number) =>
    new Engine({
      db: slowDb,
      redis: newRedis(),
      gateway: gw,
      workerId,
      log: {
        ...log,
        warn: (...args: unknown[]) => {
          if (typeof args[1] === "string") warned.push(args[1]);
        },
      },
      now,
      leaseTtlMs: 30_000,
      // Một shard: mọi account nằm chung một làn, nên song song đo được là song song TRONG shard.
      shards: 1,
      rules: () => Promise.resolve(rules),
      feeCheckMs: 0,
      ...(clockConcurrency === undefined ? {} : { clockConcurrency }),
    });

  const twapSpec = {
    strategy: "twap",
    market: "BTC-USD",
    engine: "perps" as const,
    config: {
      market: "BTC-USD",
      engine: "perps",
      side: "buy",
      totalSize: "1",
      durationMinutes: 10,
      slices: 10,
      reduceOnly: false,
      maxSlippagePct: "1",
      onSkip: "leave_unfilled",
    },
  };
  /** Thêm một bot TWAP vào account đã có. */
  async function addTwap(accountId: string): Promise<string> {
    const { eq } = await import("drizzle-orm");
    const [a] = await clockDb.select().from(sodexAccounts).where(eq(sodexAccounts.id, accountId));
    const [bot] = await clockDb
      .insert(bots)
      .values({
        userId: a?.userId ?? "",
        sodexAccountId: accountId,
        strategy: twapSpec.strategy,
        market: twapSpec.market,
        engine: twapSpec.engine,
        name: "TWAP",
        state: "running",
      })
      .returning();
    const [v] = await clockDb
      .insert(botVersions)
      .values({
        botId: bot?.id ?? "",
        version: 1,
        paramSource: "manual",
        status: "active",
        config: twapSpec.config,
      })
      .returning();
    await clockDb
      .update(bots)
      .set({ activeVersionId: v?.id ?? "" })
      .where(eq(bots.id, bot?.id ?? ""));
    return bot?.id ?? "";
  }
  /** `sizes[i]` bot TWAP trên account thứ i (mỗi account một user). */
  async function seedAccounts(sizes: number[]) {
    const out: { accountId: string; botIds: string[] }[] = [];
    for (const n of sizes) {
      const first = await seedBot("running", twapSpec, clockDb);
      const botIds = [first.botId];
      for (let i = 1; i < n; i += 1) botIds.push(await addTwap(first.accountId));
      out.push({ accountId: first.accountId, botIds });
    }
    return out;
  }
  async function stopAll() {
    const { ne } = await import("drizzle-orm");
    await clockDb.update(bots).set({ state: "stopped" }).where(ne(bots.state, "stopped"));
  }
  /** Nạp bot, cho giá để TWAP bắt đầu (lát đầu chờ nhịp đồng hồ kế tiếp). */
  async function start(e: RealEngine) {
    await e.tick();
    await e.onPrice("BTC-USD", "100", clock);
  }
  /** Một vòng: đồng hồ tới hạn lát kế tiếp, mọi bot đặt lát qua `clock`; trả thời gian của vòng (ms). */
  async function round(e: RealEngine, gw: ClockGateway): Promise<number> {
    const before = gw.received.length;
    clock += 61_000;
    const at = performance.now();
    await e.tick();
    const ms = performance.now() - at;
    // Lát vừa đặt khớp đủ rồi kết thúc, như tin của user stream; lát sau đặt được ở vòng kế tiếp.
    for (const call of gw.calls.filter((c) => c.end >= at))
      for (const id of call.clOrdIDs) {
        const o = gw.received.slice(before).find((x) => x.clOrdID === id);
        if (o === undefined) continue;
        await e.onFill(call.account, id, o.quantity, o.price ?? "100", "0", clock);
        await e.onOrderClosed(call.account, id, "filled", clock);
      }
    return ms;
  }
  /** Lịch sử của một bot, không phụ thuộc id: lệnh (nhãn, khối lượng, trạng thái) và Decisions theo thứ tự ghi. */
  async function historyOf(botId: string) {
    const { eq, asc } = await import("drizzle-orm");
    const os = await clockDb
      .select()
      .from(orders)
      .where(eq(orders.botId, botId))
      .orderBy(asc(orders.createdAt), asc(orders.tag));
    const evs = await clockDb
      .select()
      .from(botEvents)
      .where(eq(botEvents.botId, botId))
      .orderBy(asc(botEvents.occurredAt), asc(botEvents.id));
    const [rt] = await clockDb.select().from(botRuntime).where(eq(botRuntime.botId, botId));
    const st = rt?.state as { ledger?: unknown; filled?: string; sliceIndex?: number } | undefined;
    return {
      orders: os.map((o) => [
        o.tag,
        dec(o.size).toString(),
        o.status,
        dec(o.filledSize).toString(),
      ]),
      events: evs.map((x) => x.decision),
      ledger: st?.ledger,
      filled: st?.filled,
      sliceIndex: st?.sliceIndex,
    };
  }

  it("runs accounts in parallel up to the limit, never two bots of one account at once, and the same history as one at a time", async () => {
    const run = async (concurrency: number) => {
      const gw = new ClockGateway();
      gw.submitDelayMs = 40;
      const accounts = await seedAccounts([3, 1, 1, 1, 1, 1]);
      const e = clockEngine(gw, `par-${String(concurrency)}`, concurrency);
      await start(e);
      gw.maxInFlight = 0;
      for (let i = 0; i < 3; i += 1) await round(e, gw);
      const histories = [];
      for (const a of accounts) for (const id of a.botIds) histories.push(await historyOf(id));
      await e.stop();
      await stopAll();
      return { gw, accounts, histories };
    };
    const one = await run(1);
    const four = await run(4);
    expect(one.gw.maxInFlight).toBe(1);
    expect(four.gw.maxInFlight).toBeGreaterThan(1);
    expect(four.gw.maxInFlight).toBeLessThanOrEqual(4);
    // Bot cùng account không bao giờ gửi lệnh chồng nhau.
    const shared = four.accounts[0]?.accountId ?? "";
    const calls = four.gw.calls
      .filter((c) => c.account === shared)
      .sort((x, y) => x.start - y.start);
    expect(calls).toHaveLength(9);
    for (let i = 1; i < calls.length; i += 1)
      expect(calls[i]?.start).toBeGreaterThanOrEqual(calls[i - 1]?.end ?? Infinity);
    // Mỗi bot đặt đúng 3 lát; lịch sử (lệnh, Decisions, sổ cái) của từng bot y như khi chạy tuần tự.
    expect(four.histories.every((h) => h.orders.length === 3)).toBe(true);
    expect(four.histories.every((h) => h.sliceIndex === 3 && h.filled === "0.3")).toBe(true);
    expect(four.histories).toEqual(one.histories);
  });

  it("an error of one bot skips only that bot, even next to a bot of the same account", async () => {
    const gw = new ClockGateway();
    const [shared, other] = await seedAccounts([2, 1]);
    const e = clockEngine(gw, "par-error", 4);
    await start(e);
    warned.length = 0;
    // Lần gửi lệnh đầu của account chung ném lỗi (signer không tới được): một bot của account đó lỗi ở vòng này.
    gw.failNext.add(shared?.accountId ?? "");
    await round(e, gw);
    expect(
      warned.filter((m) => m === "clock step failed for one bot; retrying next tick"),
    ).toHaveLength(1);
    // Bot còn lại của cùng account và bot của account khác vẫn đặt lát trong cùng vòng.
    const sent = gw.calls.filter((c) => c.clOrdIDs.length > 0);
    expect(sent.filter((c) => c.account === shared?.accountId)).toHaveLength(2);
    expect(
      gw.received.filter((o) =>
        sent.some((c) => c.account === shared?.accountId && c.clOrdIDs.includes(o.clOrdID)),
      ),
    ).toHaveLength(1);
    expect(sent.filter((c) => c.account === other?.accountId)).toHaveLength(1);
    expect(warned).not.toContain("shard lost");
    await e.stop();
    await stopAll();
  });

  it("a fencing error still drops the shard", async () => {
    const { eq, sql } = await import("drizzle-orm");
    const gw = new ClockGateway();
    await seedAccounts([1, 1, 1]);
    const e = clockEngine(gw, "par-fenced", 4);
    await start(e);
    warned.length = 0;
    // Worker khác đã nhận shard (epoch mới trong DB): mọi lần ghi của engine này bị từ chối.
    await clockDb
      .update(shardEpochs)
      .set({ epoch: sql`${shardEpochs.epoch} + 1` })
      .where(eq(shardEpochs.shard, 0));
    await round(e, gw);
    expect(warned).toContain("shard lost");
    expect(warned).not.toContain("clock step failed for one bot; retrying next tick");
    expect(e.ownedShards).not.toContain(0);
    await e.stop();
    await stopAll();
  });

  it("stays under the DB pool: open transactions never exceed the limit and nothing waits for a connection", async () => {
    const gw = new ClockGateway();
    await seedAccounts(Array.from({ length: 12 }, () => 1));
    const e = clockEngine(gw, "par-pool", 4);
    await start(e);
    tx.delayMs = 30;
    tx.maxOpen = 0;
    tx.maxWaiting = 0;
    tx.maxClients = 0;
    const probe = setInterval(() => {
      tx.maxWaiting = Math.max(tx.maxWaiting, clockPool.waitingCount);
      tx.maxClients = Math.max(tx.maxClients, clockPool.totalCount);
    }, 2);
    try {
      await round(e, gw);
    } finally {
      clearInterval(probe);
      tx.delayMs = 0;
    }
    expect(gw.received.length).toBeGreaterThanOrEqual(12);
    expect(tx.maxOpen).toBeGreaterThan(1);
    expect(tx.maxOpen).toBeLessThanOrEqual(4);
    expect(tx.maxClients).toBeLessThanOrEqual(10);
    expect(tx.maxWaiting).toBe(0);
    await e.stop();
    await stopAll();
  });

  it("reads the order book of a market once for parallel Volume Farm bots of that market", async () => {
    const { eq } = await import("drizzle-orm");
    const market = "ARB-USD";
    const end = clock - (clock % 60_000);
    await clockDb
      .insert(candles1m)
      .values(
        Array.from({ length: 30 }, (_, i) => ({
          market,
          ts: new Date(end - (30 - i) * 60_000),
          open: "100",
          high: "100.02",
          low: "99.98",
          close: "100.01",
          volume: "10",
        })),
      )
      .onConflictDoNothing();
    for (let i = 0; i < 4; i += 1) {
      const { botId } = await seedBot(
        "running",
        {
          strategy: "volume_farm",
          market,
          engine: "perps",
          config: {
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
          },
        },
        clockDb,
      );
      const [b] = await clockDb.select().from(bots).where(eq(bots.id, botId));
      await clockDb
        .update(users)
        .set({ volumeBots: true })
        .where(eq(users.id, b?.userId ?? ""));
    }
    let reads = 0;
    const e = new Engine({
      db: slowDb,
      redis: newRedis(),
      gateway: new ClockGateway(),
      workerId: "par-book",
      log,
      now,
      leaseTtlMs: 30_000,
      shards: 1,
      rules: () => Promise.resolve(rules),
      feeCheckMs: 0,
      clockConcurrency: 4,
      orderbook: async (m) => {
        if (m === market) reads += 1;
        await sleep(30);
        return { bid: "100", ask: "100.05", bidNotional: "50000", askNotional: "40000" };
      },
    });
    await e.tick();
    expect(reads).toBe(1);
    // Hết hạn cache (FARM_SNAPSHOT_MS) thì đọc lại đúng một lần nữa.
    clock += 3_000;
    await e.tick();
    expect(reads).toBe(2);
    await e.stop();
    await stopAll();
  });

  it("bench: a slice round of 24 bots on 24 accounts, one at a time vs 4 at once", async () => {
    const bench = async (concurrency: number) => {
      const gw = new ClockGateway();
      gw.submitDelayMs = 40;
      await seedAccounts(Array.from({ length: 24 }, () => 1));
      const e = clockEngine(gw, `bench-${String(concurrency)}`, concurrency);
      await start(e);
      tx.delayMs = 10;
      const ms: number[] = [];
      try {
        for (let i = 0; i < 2; i += 1) ms.push(await round(e, gw));
      } finally {
        tx.delayMs = 0;
      }
      await e.stop();
      await stopAll();
      return Math.min(...ms);
    };
    const one = await bench(1);
    const four = await bench(4);
    if (process.env.CLOCK_BENCH === "1")
      process.stderr.write(
        `clock bench (24 bots, submit 40 ms, tx 10 ms): 1 at a time ${String(Math.round(one))} ms, 4 at once ${String(Math.round(four))} ms\n`,
      );
    expect(four).toBeLessThan(one * 0.6);
  });
});

// ---------- #419 engine A: đường tín hiệu của bot news_signal mainnet ----------
describe("news_signal engine A: signal path (#419)", { timeout: 120_000 }, () => {
  useCleanDb("news_engine_a");
  const SOL = "SOL-USD";
  const newsRules = { tickSize: "0.01", stepSize: "0.01", minQuantity: "0.01", minNotional: "5" };
  let book: { bid: string; ask: string } | null = { bid: "100", ask: "100.1" };
  let bookReads = 0;
  const warned: string[] = [];
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  beforeEach(async () => {
    // Tín hiệu của test trước hết hạn (TTL 120 s); bot của test trước dừng hẳn.
    clock += 600_000;
    book = { bid: "100", ask: "100.1" };
    bookReads = 0;
    warned.length = 0;
    const { ne } = await import("drizzle-orm");
    await db.update(bots).set({ state: "stopped" }).where(ne(bots.state, "stopped"));
  });

  const newsEngine = (gw: Gateway, workerId: string, enabled = true) =>
    new Engine({
      db,
      redis: newRedis(),
      gateway: gw,
      workerId,
      log: {
        ...log,
        warn: (...args: unknown[]) => {
          if (typeof args[1] === "string") warned.push(args[1]);
        },
      },
      now,
      leaseTtlMs: 30_000,
      shards: SHARDS,
      rules: () => Promise.resolve(newsRules),
      feeCheckMs: 0,
      newsSignalBots: enabled,
      orderbook: () => {
        bookReads += 1;
        return Promise.resolve(
          book === null ? null : { ...book, bidNotional: "50000", askNotional: "50000" },
        );
      },
    });

  let versionNo = 1_000 + Math.floor(Math.random() * 1e6);
  /** Bot `news_signal` mainnet tạo từ một version Signal research (như API #420). */
  async function seedNews(
    opts: {
      role?: "team" | "user";
      flag?: boolean;
      state?: "starting" | "running" | "stopped";
      mode?: "live" | "paper";
      bot?: Record<string, unknown>;
      version?: Record<string, unknown>;
      /** Bot thêm trên account đã có. */
      on?: { accountId: string; userId: string };
    } = {},
  ) {
    const { eq } = await import("drizzle-orm");
    let userId = opts.on?.userId ?? "";
    let accountId = opts.on?.accountId ?? "";
    if (opts.on === undefined) {
      const seeded = await seedBot("running", undefined, db);
      accountId = seeded.accountId;
      const [b] = await db.select().from(bots).where(eq(bots.id, seeded.botId));
      userId = b?.userId ?? "";
      await db.update(bots).set({ state: "stopped" }).where(eq(bots.id, seeded.botId));
      await db
        .update(users)
        .set({ role: opts.role ?? "team", signalResearch: opts.flag ?? false })
        .where(eq(users.id, userId));
    }
    versionNo += 1;
    const [v] = await db
      .insert(signalBotVersions)
      .values({
        number: versionNo,
        name: `v${String(versionNo)}`,
        config: { ...baselineVersionConfig(), ...opts.version },
        // Tối đa 3 version chạy cùng lúc (trigger của #423); bot tạo được từ version đã dừng.
        status: "stopped",
      })
      .returning();
    const [bot] = await db
      .insert(bots)
      .values({
        userId,
        sodexAccountId: accountId,
        strategy: "news_signal",
        market: "",
        engine: "perps",
        name: "News",
        state: opts.state ?? "running",
        mode: opts.mode ?? "live",
        signalVersionId: v?.id ?? null,
      })
      .returning();
    const [bv] = await db
      .insert(botVersions)
      .values({
        botId: bot?.id ?? "",
        version: 1,
        paramSource: "manual",
        status: "active",
        config: { ...baselineVersionConfig(), sizeUsdc: "200", leverage: 1, ...opts.bot },
      })
      .returning();
    await db
      .update(bots)
      .set({ activeVersionId: bv?.id ?? "" })
      .where(eq(bots.id, bot?.id ?? ""));
    return { botId: bot?.id ?? "", accountId, userId };
  }

  /** Một tín hiệu dùng chung (scheduler #441 ghi), quyết định ngay lúc này. */
  async function signal(over: Record<string, unknown> = {}) {
    const { signal: row } = await insertNewsSignal(db, {
      storyKey: `story-${String(Math.random())}`,
      cycleAt: new Date(clock),
      articleId: `a-${String(Math.random())}`,
      market: SOL,
      kind: "crypto",
      catalyst: "listing",
      side: "long",
      level: "high",
      firstPublishedAt: new Date(clock - 60_000),
      collectedAt: new Date(clock - 30_000),
      decidedAt: new Date(clock),
      expiresAt: new Date(clock + 120_000),
      quoteBid: "100",
      quoteAsk: "100.1",
      quoteMid: "100.05",
      quoteAt: new Date(clock),
      typicalByHoldHours: { "24": "3", "48": "4", "72": "5" },
      classifierVersion: "c1",
      assetMapVersion: "m1",
      ruleVersion: "r1",
      ...over,
    });
    return row.id;
  }
  const deliveries = async (botId: string) => {
    const { eq } = await import("drizzle-orm");
    return db.select().from(newsSignalDeliveries).where(eq(newsSignalDeliveries.botId, botId));
  };
  const trades = async (botId: string) => {
    const { eq } = await import("drizzle-orm");
    return db.select().from(newsSignalTrades).where(eq(newsSignalTrades.botId, botId));
  };
  const entries = (gw: FakeGateway) => gw.received.filter((o) => o.tag.endsWith(":entry"));
  async function ticks(e: RealEngine, n = 2) {
    for (let i = 0; i < n; i += 1) {
      clock += 1_000;
      await e.tick();
    }
  }

  it("delivers a signal: 1× isolated first, one limit IOC entry at the cap from the latest book, builder fee 10, then TP / SL", async () => {
    const gw = new FakeGateway();
    const { botId, accountId } = await seedNews();
    const e = newsEngine(gw, "ns-main");
    await ticks(e, 1);
    expect(bookReads).toBe(0);
    // Sổ lệnh đổi sau lần nạp: giá trần theo sổ đọc lúc giao tín hiệu.
    book = { bid: "100", ask: "100.1" };
    const id = await signal();
    await ticks(e, 1);
    expect(bookReads).toBe(1);
    const [entry] = entries(gw);
    expect(entries(gw)).toHaveLength(1);
    expect(entry).toMatchObject({
      market: SOL,
      side: "buy",
      type: "limit",
      timeInForce: "IOC",
      reduceOnly: false,
      price: "100.3",
      quantity: "1.99",
      tag: `ns:${id}:entry`,
    });
    expect(
      dec(entry?.price ?? "0")
        .mul(entry?.quantity ?? "0")
        .lte(200),
    ).toBe(true);
    // Đòn bẩy 1× isolated của đúng market được đặt TRƯỚC lệnh vào.
    expect(gw.leverage).toEqual([{ market: SOL, leverage: 1, marginMode: "isolated", before: 0 }]);
    expect(gw.builderRates.at(-1)).toBe(10);
    expect((await deliveries(botId)).map((d) => [d.signalId, d.outcome, d.reason])).toEqual([
      [id, "accepted", null],
    ]);
    expect(await trades(botId)).toMatchObject([
      { signalId: id, market: SOL, side: "long", status: "open" },
    ]);
    expect(dec((await trades(botId))[0]?.qty ?? "1").toString()).toBe("0");
    expect(dec((await trades(botId))[0]?.entryLimitPrice ?? "0").toString()).toBe("100.3");
    // Khớp đủ: TP (limit reduce-only) và SL (stop gốc reduce-only) được đặt; dòng lệnh news cập nhật.
    await e.onFill(accountId, entry?.clOrdID ?? "", "1.99", "100.2", "0.1", clock);
    await e.onOrderClosed(accountId, entry?.clOrdID ?? "", "filled", clock);
    const tp = gw.received.find((o) => o.tag.endsWith(":tp"));
    const sl = gw.received.find((o) => o.tag.endsWith(":sl"));
    expect(tp).toMatchObject({ reduceOnly: true, type: "limit", side: "sell" });
    expect(sl).toMatchObject({ reduceOnly: true, type: "market", side: "sell" });
    const [row] = await trades(botId);
    expect(dec(row?.qty ?? "0").toString()).toBe("1.99");
    expect(dec(row?.entryAvgPrice ?? "0").toString()).toBe("100.2");
    expect(row?.tpPrice).not.toBeNull();
    expect(row?.slPrice).not.toBeNull();
    await e.stop();
  });

  it("drops with NO_BOOK_DATA when the book cannot be read, and sends nothing", async () => {
    const gw = new FakeGateway();
    const { botId } = await seedNews();
    const e = newsEngine(gw, "ns-nobook");
    book = null;
    const id = await signal();
    await ticks(e);
    expect((await deliveries(botId)).map((d) => [d.signalId, d.outcome, d.reason])).toEqual([
      [id, "dropped", "NO_BOOK_DATA"],
    ]);
    expect(gw.received).toEqual([]);
    expect(gw.leverage).toEqual([]);
    await e.stop();
  });

  it("never loads a news bot when SIGNAL_NEWS_BOTS_ENABLED is off, for a paper bot, without Signal Research access, or when the bot widens its version", async () => {
    const gw = new FakeGateway();
    const off = await seedNews();
    const e0 = newsEngine(gw, "ns-off", false);
    await signal();
    await ticks(e0);
    await e0.stop();
    expect(await deliveries(off.botId)).toEqual([]);
    expect(warned).toContain("news_signal bot not loaded");
    await stopNews();

    const cases = [
      await seedNews({ mode: "paper" }),
      await seedNews({ role: "user", flag: false }),
      await seedNews({
        version: { assets: { mode: "only", markets: ["ETH-USD"], crypto: true, stocks: false } },
      }),
    ];
    const e = newsEngine(gw, "ns-gates");
    await signal();
    await ticks(e);
    for (const c of cases) expect(await deliveries(c.botId)).toEqual([]);
    expect(gw.received).toEqual([]);
    expect(gw.leverage).toEqual([]);
    await e.stop();
    await stopNews();
    // Người dùng có cờ Signal Research (không phải team) thì được nạp.
    const tester = await seedNews({ role: "user", flag: true });
    const e2 = newsEngine(gw, "ns-tester");
    const id = await signal();
    await ticks(e2);
    expect((await deliveries(tester.botId)).map((d) => [d.signalId, d.outcome])).toEqual([
      [id, "accepted"],
    ]);
    await e2.stop();
  });
  async function stopNews() {
    const { ne } = await import("drizzle-orm");
    await db.update(bots).set({ state: "stopped" }).where(ne(bots.state, "stopped"));
    clock += 600_000;
  }

  it("a bot that is not running gets BOT_PAUSED and its strategy is never asked", async () => {
    const gw = new FakeGateway();
    const { botId } = await seedNews({ state: "starting" });
    const e = newsEngine(gw, "ns-starting");
    const id = await signal();
    await ticks(e);
    expect((await deliveries(botId)).map((d) => [d.signalId, d.outcome, d.reason])).toEqual([
      [id, "dropped", "BOT_PAUSED"],
    ]);
    expect(gw.received).toEqual([]);
    expect(gw.leverage).toEqual([]);
    expect(await trades(botId)).toEqual([]);
    await e.stop();
  });

  it("does not send the entry when the bot leaves running between the strategy step and the send (BOT_NOT_RUNNING)", async () => {
    const { eq } = await import("drizzle-orm");
    const gw = new FakeGateway();
    const { botId } = await seedNews();
    const e = newsEngine(gw, "ns-race");
    await ticks(e, 1);
    let release: () => void = () => undefined;
    gw.holdLeverage = new Promise<void>((r) => {
      release = r;
    });
    const id = await signal();
    clock += 1_000;
    const tick = e.tick();
    for (let i = 0; i < 200 && gw.leverage.length === 0; i += 1) await sleep(10);
    expect(gw.leverage).toHaveLength(1);
    // Người dùng bấm Pause trong lúc đang đặt đòn bẩy cho lệnh vào.
    await db.update(bots).set({ state: "pausing" }).where(eq(bots.id, botId));
    release();
    await tick;
    expect(entries(gw)).toEqual([]);
    expect(warned).toContain("news signal opening order not sent");
    expect(await trades(botId)).toMatchObject([
      { signalId: id, status: "closed", closeReason: "ENTRY_NOT_FILLED" },
    ]);
    const { orders: o } = { orders };
    expect(await db.select().from(o).where(eq(o.botId, botId))).toEqual([]);
    await e.stop();
  });

  it("drops with LEVERAGE_NOT_SET, without pausing, when SoDEX rejects 1× isolated or a position holds other settings", async () => {
    const gw = new FakeGateway();
    const { botId } = await seedNews();
    const e = newsEngine(gw, "ns-lev");
    gw.leverageOutcome = { outcome: "rejected", code: "INVALID_LEVERAGE" };
    const id = await signal();
    await ticks(e);
    expect((await deliveries(botId)).map((d) => [d.signalId, d.outcome, d.reason])).toEqual([
      [id, "dropped", "LEVERAGE_NOT_SET"],
    ]);
    expect(entries(gw)).toEqual([]);
    expect((await botState(botId))?.state).toBe("running");
    expect(await trades(botId)).toEqual([]);
    // Vị thế sẵn có trên market với thiết lập khác (DEC-58): không đổi thiết lập, không vào lệnh.
    gw.leverageOutcome = { outcome: "ok" };
    gw.positions.set(SOL, { leverage: 5, marginMode: "cross" });
    gw.settings.set(SOL, { leverage: 5, marginMode: "cross" });
    const before = gw.leverage.length;
    const id2 = await signal();
    await ticks(e);
    expect((await deliveries(botId)).find((d) => d.signalId === id2)).toMatchObject({
      outcome: "dropped",
      reason: "LEVERAGE_NOT_SET",
    });
    expect(gw.leverage).toHaveLength(before);
    expect(entries(gw)).toEqual([]);
    await e.stop();
  });

  it("gives one effect per signal and bot: bell and tick together, a restart, and a delivery already in the DB", async () => {
    const gw = new FakeGateway();
    const a = await seedNews();
    const e = newsEngine(gw, "ns-dup");
    await ticks(e, 1);
    const id = await signal();
    clock += 1_000;
    await Promise.all([e.tick(), e.onNewsSignalBell(), e.onNewsSignalBell()]);
    await ticks(e);
    expect(entries(gw)).toHaveLength(1);
    await e.stop();
    // Engine khác nhận shard (restart / đổi shard): không giao lại.
    const e2 = newsEngine(gw, "ns-dup-2");
    await ticks(e2, 3);
    expect(entries(gw)).toHaveLength(1);
    expect((await deliveries(a.botId)).map((d) => d.signalId)).toEqual([id]);
    await e2.stop();
    // Delivery đã có từ trước (ví dụ engine cũ ghi rồi chết trước khi lưu state): chiến lược không được hỏi lại.
    await stopNews();
    const b = await seedNews();
    const id2 = await signal({ market: "ETH-USD", storyKey: `eth-${String(Math.random())}` });
    await db.insert(newsSignalDeliveries).values({
      signalId: id2,
      botId: b.botId,
      outcome: "dropped",
      reason: "BOT_PAUSED",
      epoch: 1,
    });
    const e3 = newsEngine(gw, "ns-dup-3");
    await ticks(e3);
    const { eq } = await import("drizzle-orm");
    expect(await db.select().from(orders).where(eq(orders.botId, b.botId))).toEqual([]);
    expect((await deliveries(b.botId)).map((d) => [d.signalId, d.reason])).toEqual([
      [id2, "BOT_PAUSED"],
    ]);
    await e3.stop();
  });

  it("ACCOUNT_MARKET_BUSY: a second news bot of the account, another live bot of the account on that market, and a racing open trade", async () => {
    const { eq } = await import("drizzle-orm");
    const gw = new FakeGateway();
    const first = await seedNews();
    const second = await seedNews({ on: first });
    const e = newsEngine(gw, "ns-busy");
    const id = await signal();
    await ticks(e);
    expect(entries(gw)).toHaveLength(1);
    const outcomes = [...(await deliveries(first.botId)), ...(await deliveries(second.botId))]
      .map((d) => [d.outcome, d.reason])
      .sort();
    expect(outcomes).toEqual([
      ["accepted", null],
      ["dropped", "ACCOUNT_MARKET_BUSY"],
    ]);
    await e.stop();
    await stopNews();

    // Bot thật khác (paused) của cùng account dùng market đó: busy, không vào lệnh.
    const news = await seedNews();
    const [grid] = await db
      .insert(bots)
      .values({
        userId: news.userId,
        sodexAccountId: news.accountId,
        strategy: "futures_grid",
        market: "ETH-USD",
        engine: "perps",
        name: "Grid",
        state: "paused",
      })
      .returning();
    const e2 = newsEngine(gw, "ns-busy-2");
    const sent = gw.received.length;
    const id2 = await signal({ market: "ETH-USD" });
    await ticks(e2);
    expect(gw.received.slice(sent)).toEqual([]);
    expect((await deliveries(news.botId)).find((d) => d.signalId === id2)?.reason).toBe(
      "ACCOUNT_MARKET_BUSY",
    );
    await db
      .update(bots)
      .set({ state: "stopped" })
      .where(eq(bots.id, grid?.id ?? ""));

    await e2.stop();
    // Lệnh news của bot khác được ghi đúng lúc này (race với kiểm tra busy): partial unique chặn, không gửi gì. Cổng mới để
    // SOL-USD chưa có 1× isolated: giữ lần đặt đòn bẩy, chèn dòng lệnh trong lúc đó (sau khi đã tính busy).
    const gw3 = new FakeGateway();
    const e3 = newsEngine(gw3, "ns-busy-3");
    let release: () => void = () => undefined;
    gw3.holdLeverage = new Promise<void>((r) => {
      release = r;
    });
    const other = await seedNews({ on: news, state: "stopped" });
    const otherSignal = await signal({ storyKey: `other-${String(Math.random())}` });
    const id3 = await signal({ storyKey: `race-${String(Math.random())}` });
    clock += 1_000;
    const tick = e3.tick();
    for (let i = 0; i < 200 && !gw3.leverage.some((l) => l.market === SOL); i += 1) await sleep(10);
    await db.insert(newsSignalTrades).values({
      botId: other.botId,
      sodexAccountId: news.accountId,
      signalId: otherSignal,
      seq: 1,
      market: SOL,
      side: "long",
      status: "open",
      sizeUsdc: "100",
      entryLimitPrice: "100",
      maxHoldUntil: new Date(clock + 3_600_000),
      openedAt: new Date(clock),
    });
    release();
    await tick;
    expect(gw3.received).toEqual([]);
    // Không phải lỗi của bot: không có warn "delivery failed".
    expect(warned).not.toContain("news signal delivery failed for one bot; retrying next tick");
    expect((await deliveries(news.botId)).find((d) => d.signalId === id3)?.reason).toBe(
      "ACCOUNT_MARKET_BUSY",
    );
    expect((await trades(news.botId)).filter((t) => t.signalId === id3)).toEqual([]);
    expect(id).not.toBe(id3);
    await e3.stop();
  });

  it("signer down: the step is undone with its delivery and trade, then the same entry goes once it recovers", async () => {
    const gw = new FakeGateway();
    const { botId } = await seedNews();
    const e = newsEngine(gw, "ns-notsent");
    gw.notSent = "signer_unavailable";
    const id = await signal();
    await ticks(e, 1);
    expect(gw.received).toEqual([]);
    expect(await deliveries(botId)).toEqual([]);
    expect(await trades(botId)).toEqual([]);
    gw.notSent = null;
    await ticks(e, 3);
    expect(entries(gw)).toHaveLength(1);
    expect(entries(gw)[0]?.tag).toBe(`ns:${id}:entry`);
    expect((await deliveries(botId)).map((d) => [d.signalId, d.outcome])).toEqual([
      [id, "accepted"],
    ]);
    expect(await trades(botId)).toHaveLength(1);
    await e.stop();
  });

  it("an entry with an unknown result keeps its slot and is never resent", async () => {
    const { eq } = await import("drizzle-orm");
    const gw = new FakeGateway();
    const { botId } = await seedNews();
    const e = newsEngine(gw, "ns-unknown");
    gw.timeoutNext = "lost";
    const id = await signal();
    await ticks(e, 1);
    await ticks(e, 4);
    const rows = await db.select().from(orders).where(eq(orders.botId, botId));
    expect(rows.map((o) => [o.tag, o.status])).toEqual([[`ns:${id}:entry`, "unknown"]]);
    expect(gw.received.filter((o) => o.tag === `ns:${id}:entry`)).toEqual([]);
    expect(await trades(botId)).toMatchObject([{ signalId: id, status: "open" }]);
    await e.stop();
  });

  it("an error of one bot only skips that bot's delivery; another account still trades", async () => {
    const gw = new (class extends FakeGateway {
      failAccount = "";
      override submit(
        a: AccountRef,
        list: readonly OrderIntent[],
        fence: Fence,
        rate?: number,
      ): Promise<SubmitResult[]> {
        if (a.id === this.failAccount) return Promise.reject(new Error("socket hang up"));
        return super.submit(a, list, fence, rate);
      }
    })();
    const bad = await seedNews();
    const good = await seedNews();
    gw.failAccount = bad.accountId;
    const e = newsEngine(gw, "ns-isolated");
    await signal();
    await ticks(e, 1);
    expect(warned).toContain("news signal delivery failed for one bot; retrying next tick");
    expect((await deliveries(good.botId)).map((d) => d.outcome)).toEqual(["accepted"]);
    expect(entries(gw)).toHaveLength(1);
    await e.stop();
  });

  it("an open news trade makes its market shared: the position check does not alert another bot of the account on that market", async () => {
    const { eq } = await import("drizzle-orm");
    const gw = new FakeGateway();
    const news = await seedNews();
    // Bot futures grid đang chạy trên SOL-USD cùng account, sổ cái 0.
    const [grid] = await db
      .insert(bots)
      .values({
        userId: news.userId,
        sodexAccountId: news.accountId,
        strategy: "futures_grid",
        market: SOL,
        engine: "perps",
        name: "Grid",
        state: "running",
      })
      .returning();
    const [gv] = await db
      .insert(botVersions)
      .values({
        botId: grid?.id ?? "",
        version: 1,
        paramSource: "manual",
        status: "active",
        config: {
          market: SOL,
          leverage: 1,
          marginMode: "isolated",
          direction: "long",
          lowerPrice: "90",
          upperPrice: "110",
          gridLevels: 4,
          spacing: "arithmetic",
          margin: "200",
          stopBelow: "80",
          maxLoss: "2",
          onStop: "close_at_market",
        },
      })
      .returning();
    await db
      .update(bots)
      .set({ activeVersionId: gv?.id ?? "" })
      .where(eq(bots.id, grid?.id ?? ""));
    const otherSignal = await signal({ storyKey: `held-${String(Math.random())}` });
    // Lệnh news đang mở trên SOL-USD của account; SoDEX có vị thế 1.99 (của lệnh news, không phải của grid).
    await db.insert(newsSignalTrades).values({
      botId: news.botId,
      sodexAccountId: news.accountId,
      signalId: otherSignal,
      seq: 99,
      market: SOL,
      side: "long",
      status: "open",
      sizeUsdc: "200",
      entryLimitPrice: "100.3",
      qty: "1.99",
      maxHoldUntil: new Date(clock + 3_600_000),
      openedAt: new Date(clock),
    });
    gw.perpsPositions.set(SOL, { size: "1.99", entryPrice: "100.2" });
    const e = newsEngine(gw, "ns-holders");
    await e.tick();
    await e.onPrice(SOL, "100", clock);
    for (let i = 0; i < 6; i += 1) {
      clock += 31_000;
      await e.tick();
    }
    // Grid đã chạy. Market SOL-USD có hai bên giữ vị thế (grid + lệnh news) nên không được so: không đọc, không cảnh báo.
    // Bỏ phần đếm lệnh news trong #checkPositions thì grid bị cảnh báo lệch (sổ cái 0, SoDEX 1.99).
    expect(gw.received.some((o) => o.tag.startsWith("grid:"))).toBe(true);
    expect(gw.readsBy.filter((a) => a === news.accountId)).toEqual([]);
    const alerts = (
      await db
        .select()
        .from(botEvents)
        .where(eq(botEvents.botId, grid?.id ?? ""))
    )
      .map((x) => x.decision)
      .filter((d) => d === "Position doesn't match" || d === "Position not tracked");
    expect(alerts).toEqual([]);
    expect((await botState(grid?.id ?? ""))?.positionMismatch ?? null).toBeNull();
    await e.stop();
    await db
      .update(bots)
      .set({ state: "stopped" })
      .where(eq(bots.id, grid?.id ?? ""));
  });
});
