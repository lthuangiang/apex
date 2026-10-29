import {
  apiKeys,
  botRuntime,
  botVersions,
  bots,
  createDb,
  equitySnapshots,
  fills,
  fundingRates,
  orders,
  riskLimits,
  runMigrations,
  shardEpochs,
  sodexAccounts,
  users,
  type Db,
} from "@drift/db";
import { ReasonCode } from "@drift/shared";
import { runBacktest, spotGrid, spotGridSchema, type OrderIntent } from "@drift/strategies";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Redis } from "ioredis";
import { GenericContainer, type StartedTestContainer } from "testcontainers";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { Engine, FencedError, shardOf } from "../src/engine";
import type {
  AccountRef,
  Fence,
  Gateway,
  LeverageResult,
  LeverageSetting,
  LookupResult,
  NotSentCode,
  SubmitResult,
} from "../src/gateway";

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

  submit(_a: AccountRef, list: readonly OrderIntent[], fence: Fence): Promise<SubmitResult[]> {
    // Signer từ chối ký với epoch cũ (fencing ở signer).
    if (fence.epoch < this.rejectEpochBelow) return Promise.reject(new Error("stale epoch"));
    const code = this.notSent;
    if (code !== null)
      return Promise.resolve(
        list.map((o): SubmitResult => ({ clOrdID: o.clOrdID, outcome: "not_sent", code })),
      );
    this.fences.push(fence);
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
  cancel(): Promise<void> {
    return Promise.resolve();
  }
  lookup(_a: AccountRef, o: { clOrdID: string }): Promise<LookupResult> {
    return Promise.resolve(this.book.get(o.clOrdID) ?? { status: "not_found" });
  }
  builderApproved(): Promise<boolean> {
    return Promise.resolve(this.approved);
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

  it("does not run Volume Maker bots while VOLUME_MAKER_ENABLED is off", async () => {
    const gw = new FakeGateway();
    await seedBot("running", {
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
    const e = makeEngine(gw, "w1");
    await e.tick();
    await e.onPrice("BTC-USD", "100000", clock);
    expect(gw.received).toHaveLength(0);
    await e.stop();
  });
});
