import {
  apiKeys,
  botEvents,
  botRuntime,
  bots,
  botVersions,
  equitySnapshots,
  fills,
  fundingRates,
  orders,
  outbox,
  riskLimits,
  shardEpochs,
  sodexAccounts,
  type Db,
} from "@drift/db";
import { Lease, type LeaseRedis } from "@drift/runtime";
import {
  applyEngineEvent,
  applyReason,
  BotState,
  dec,
  ENGINE_ACTIVE_STATES,
  EngineEvent,
  exceedsPerTrade,
  REASON_CODE_META,
  ReasonCode,
  leverageSpecOf,
  Strategy,
  sub,
  type ReasonCode as Reason,
} from "@drift/shared";
import {
  fnv1a64,
  STRATEGIES,
  type MarketRules,
  type StepContext,
  type StrategyAction,
  type StrategyEvent,
  type StrategyModule,
  type OrderIntent,
} from "@drift/strategies";
import { and, desc, eq, gt, inArray, lt, lte, sql } from "drizzle-orm";
import type { Logger } from "pino";

import type { AccountRef, Gateway, NotSentCode } from "./gateway";

// Engine (ARCHITECTURE.md mục 3.3–3.4, DEC-37). Mỗi account thuộc một shard ảo (64); mỗi shard có đúng
// một worker giữ lease Redis. Khi nhận shard, `epoch` của shard trong Postgres tăng 1; mọi lần ghi lệnh /
// state đều kiểm tra epoch trong cùng transaction (fencing), nên worker "zombie" không ghi được.
// Lệnh được ghi trước (status unknown) rồi mới gửi; clOrdID tất định + unique (account, clOrdID) nên chạy lại
// sau khi chuyển shard không tạo lệnh trùng.

export const ENGINE_SHARDS = 64;
/** Lệnh `unknown` lâu hơn mức này thì đối soát với SoDEX. */
export const RECONCILE_AFTER_MS = 5_000;
/** Không tìm thấy trên SoDEX sau mức này thì coi là chưa đặt (not_placed). */
export const NOT_FOUND_AFTER_MS = 30_000;

export class FencedError extends Error {
  constructor(readonly shard: number) {
    super(`Shard ${String(shard)} is owned by another worker`);
  }
}

export interface EngineRedis extends LeaseRedis {
  set(key: string, value: string, px: "PX", ttl: number, nx?: "NX"): Promise<string | null>;
  keys(pattern: string): Promise<string[]>;
}

export interface EngineDeps {
  db: Db;
  redis: EngineRedis;
  gateway: Gateway;
  workerId: string;
  log: Pick<Logger, "info" | "warn" | "error">;
  now?: () => number;
  leaseTtlMs?: number;
  shards?: number;
  rules: (market: string) => Promise<MarketRules | undefined>;
  feeRate?: string;
  /** Chu kỳ kiểm tra approval phí của mỗi account. */
  feeCheckMs?: number;
  /** VOLUME_MAKER_ENABLED (VOLUME_MAKER.md mục 17.5): tắt thì engine không chạy bot Volume Maker. */
  volumeMakerEnabled?: boolean;
}

interface Runner {
  botId: string;
  account: AccountRef;
  shard: number;
  epoch: number;
  versionId: string;
  version: number;
  strategy: string;
  market: string;
  config: unknown;
  state: unknown;
  module: StrategyModule<unknown, unknown>;
  ctx: StepContext;
  /** Lệnh đầu tiên đã được ack (để xác nhận Running). */
  awaitingFirstAck: boolean;
  /** Đòn bẩy + margin mode của version đang chạy đã được SoDEX xác nhận (bot Perps). */
  leverageSet: boolean;
  /** Lần `updateLeverage` trước không rõ kết quả: phải đọc lại SoDEX trước khi gửi lại (quy tắc 1.7). */
  leverageUnknown: boolean;
  /** Request chưa rời DRIFT (signer lỗi): chờ backoff tới `nextAt`; quá hạn thì pause (UI_REVIEW H1). */
  blocked: { since: number; attempts: number; nextAt: number; code: NotSentCode } | null;
}

/** Backoff khi request chưa rời DRIFT: 2 s → 4 s → … tối đa 60 s; quá 5 lần hoặc 5 phút thì pause bot. */
export const NOT_SENT_BACKOFF = {
  firstMs: 2_000,
  maxMs: 60_000,
  maxAttempts: 5,
  maxMs_total: 300_000,
};

/** Đòn bẩy + margin mode bot Perps cần trên SoDEX (dùng chung với check của api, DEC-58). */
export const leverageSpec = leverageSpecOf;

/** Chiến lược cần `timer` để hành động (các chiến lược còn lại chỉ phản ứng với giá / funding). */
const CLOCKED: ReadonlySet<string> = new Set([
  Strategy.recurringBuy,
  Strategy.twap,
  Strategy.rebalancing,
  Strategy.volumeMaker,
]);

export function shardOf(accountId: string, shards = ENGINE_SHARDS): number {
  return Number(fnv1a64(accountId) % BigInt(shards));
}

export class Engine {
  readonly #d: Required<Omit<EngineDeps, "feeRate">> & { feeRate: string };
  readonly #leases = new Map<number, { lease: Lease; epoch: number }>();
  readonly #runners = new Map<string, Runner>();
  readonly #lastFeeCheck = new Map<string, number>();
  #stopped = false;

  constructor(deps: EngineDeps) {
    this.#d = {
      now: () => Date.now(),
      leaseTtlMs: 15_000,
      shards: ENGINE_SHARDS,
      feeRate: "0.0005",
      feeCheckMs: 60_000,
      volumeMakerEnabled: false,
      ...deps,
    };
  }

  get ownedShards(): number[] {
    return [...this.#leases.keys()].sort((a, b) => a - b);
  }

  epochOf(shard: number): number | undefined {
    return this.#leases.get(shard)?.epoch;
  }

  /** Một vòng: heartbeat, giữ / nhận shard, xử lý lệnh bot, đối soát, kiểm tra phí. */
  async tick(): Promise<void> {
    if (this.#stopped) return;
    await this.#manageShards();
    for (const shard of this.ownedShards) {
      try {
        await this.#syncBots(shard);
        await this.#reconcile(shard);
        await this.#checkFees(shard);
        await this.#clock(shard);
      } catch (error) {
        if (error instanceof FencedError) this.#dropShard(shard);
        else this.#d.log.error({ err: error, shard }, "shard loop failed");
      }
    }
  }

  /**
   * Nhịp đồng hồ cho chiến lược chạy theo thời gian (DEC-61): mỗi vòng engine gửi `timer`; chiến lược tự kiểm
   * tra đã tới hạn chưa (lịch Recurring Buy, lát TWAP, lịch / ngưỡng Rebalancing, refresh Volume Maker).
   */
  async #clock(shard: number): Promise<void> {
    const at = this.#d.now();
    for (const r of [...this.#runners.values()].filter(
      (x) => x.shard === shard && CLOCKED.has(x.strategy),
    )) {
      await this.#feed(r, { type: "timer", at });
    }
  }

  /** Giá mới từ marketdata (NATS `md.<market>.price`). */
  readonly #lastPrice = new Map<string, string>();

  async onPrice(market: string, price: string, at: number): Promise<void> {
    this.#lastPrice.set(market, price);
    for (const r of [...this.#runners.values()].filter(
      (x) => x.market === market || this.#watches(x, market),
    )) {
      await this.#feed(r, { type: "tick", at, market, price });
    }
  }

  /**
   * Một kỳ funding vừa chốt (NATS `md.<market>.funding`, tỷ lệ thô của SoDEX). Chiến lược nhận `fundingRate`
   * tính bằng % mỗi kỳ, kèm trung bình 7 ngày từ `funding_rates` (null khi chưa có dữ liệu).
   */
  async onFunding(market: string, rate: string, at: number): Promise<void> {
    const targets = [...this.#runners.values()].filter(
      (x) => x.market === market || this.#watches(x, market),
    );
    if (targets.length === 0) return;
    const [row] = await this.#d.db
      .select({ avg: sql<string | null>`avg(${fundingRates.rate})::text` })
      .from(fundingRates)
      .where(
        and(
          eq(fundingRates.market, market),
          gt(fundingRates.fundingTime, new Date(at - 7 * 86_400_000)),
          lte(fundingRates.fundingTime, new Date(at)),
        ),
      );
    const avg7d = row?.avg == null ? null : dec(row.avg).mul(100).toString();
    const current = dec(rate).mul(100).toString();
    for (const r of targets)
      await this.#feed(r, { type: "fundingRate", at, market, current, avg7d });
  }

  /**
   * Trade của SoDEX (user stream `accountTrade`): ghi `fills` cho lệnh của DRIFT, kèm builder fee (`bf`, đã nằm
   * trong `f`). Idempotent theo trade id. Dùng cho Orders, phí của bot và đối soát builder revenue.
   */
  async onTrade(
    accountId: string,
    t: {
      tradeId: bigint;
      clOrdID: string;
      price: string;
      quantity: string;
      fee: string;
      builderFee: string | null;
      isMaker: boolean;
      at: number;
    },
  ): Promise<void> {
    const [o] = await this.#d.db
      .select({ id: orders.id })
      .from(orders)
      .where(and(eq(orders.sodexAccountId, accountId), eq(orders.clOrdId, t.clOrdID)))
      .limit(1);
    if (o === undefined) return;
    await this.#d.db
      .insert(fills)
      .values({
        orderId: o.id,
        sodexTradeId: t.tradeId,
        price: t.price,
        size: t.quantity,
        fee: t.fee,
        builderFee: t.builderFee,
        isMaker: t.isMaker,
        filledAt: new Date(t.at),
      })
      .onConflictDoNothing();
  }

  /** Fill từ user stream (accountTrade) hoặc từ đối soát; chỉ phần khối lượng mới được báo cho chiến lược. */
  async onFill(
    accountId: string,
    clOrdID: string,
    totalFilled: string,
    avgPrice: string,
    fee: string,
    at: number,
  ): Promise<void> {
    const [o] = await this.#d.db
      .select()
      .from(orders)
      .where(and(eq(orders.sodexAccountId, accountId), eq(orders.clOrdId, clOrdID)))
      .limit(1);
    if (o === undefined) return;
    const r = this.#runners.get(o.botId);
    if (r === undefined) return;
    const delta = sub(totalFilled, o.filledSize);
    if (!delta.gt(0)) return;
    const status = dec(totalFilled).gte(o.size) ? "filled" : "partially_filled";
    await this.#fenced(r, async (tx) => {
      await tx
        .update(orders)
        .set({ filledSize: totalFilled, avgPrice, status })
        .where(eq(orders.id, o.id));
    });
    await this.#feed(r, {
      type: "fill",
      at,
      clOrdID,
      price: avgPrice,
      quantity: delta.toString(),
      fee,
    });
  }

  /** Account có bot đang chạy trong các shard của worker này (để mở user stream). */
  activeAccounts(): Promise<AccountRef[]> {
    const seen = new Map<string, AccountRef>();
    for (const r of this.#runners.values()) seen.set(r.account.id, r.account);
    return Promise.resolve([...seen.values()]);
  }

  /** Dừng có trật tự: trả lease (C10). */
  async stop(): Promise<void> {
    this.#stopped = true;
    for (const [shard, l] of this.#leases) {
      await l.lease.release();
      this.#dropShard(shard);
    }
  }

  /** Test: mô phỏng worker chết (không trả lease, không làm gì nữa). */
  kill(): void {
    this.#stopped = true;
  }

  // ---------- shards ----------

  async #manageShards(): Promise<void> {
    const { redis, workerId, leaseTtlMs, shards } = this.#d;
    await redis.set(`engine:worker:${workerId}`, String(this.#d.now()), "PX", leaseTtlMs);
    const workers = Math.max(1, (await redis.keys("engine:worker:*")).length);
    const target = Math.ceil(shards / workers);
    for (const [shard, l] of [...this.#leases]) {
      if (!(await l.lease.tick())) this.#dropShard(shard);
    }
    // Giữ quá phần của mình (sau khi có worker mới) thì trả bớt.
    while (this.#leases.size > target) {
      const shard = this.ownedShards.at(-1);
      if (shard === undefined) break;
      await this.#leases.get(shard)?.lease.release();
      this.#dropShard(shard);
    }
    for (let shard = 0; shard < shards && this.#leases.size < target; shard += 1) {
      if (this.#leases.has(shard)) continue;
      const lease = new Lease(redis, `lease:shard:${String(shard)}`, leaseTtlMs);
      if (!(await lease.tick())) continue;
      const [row] = await this.#d.db
        .insert(shardEpochs)
        .values({ shard, epoch: 1, owner: workerId, acquiredAt: new Date(this.#d.now()) })
        .onConflictDoUpdate({
          target: shardEpochs.shard,
          set: {
            epoch: sql`${shardEpochs.epoch} + 1`,
            owner: workerId,
            acquiredAt: new Date(this.#d.now()),
          },
        })
        .returning({ epoch: shardEpochs.epoch });
      this.#leases.set(shard, { lease, epoch: row?.epoch ?? 0 });
      this.#d.log.info({ shard, epoch: row?.epoch, worker: workerId }, "shard acquired");
    }
  }

  #dropShard(shard: number): void {
    this.#leases.delete(shard);
    for (const [id, r] of this.#runners) if (r.shard === shard) this.#runners.delete(id);
  }

  /** Transaction có fencing: epoch trong DB phải đúng epoch mình giữ. */
  async #fenced<T>(f: Pick<Runner, "shard" | "epoch">, work: (tx: Db) => Promise<T>): Promise<T> {
    return this.#d.db.transaction(async (tx) => {
      const [row] = await tx
        .select({ epoch: shardEpochs.epoch })
        .from(shardEpochs)
        .where(eq(shardEpochs.shard, f.shard))
        .for("share");
      if (row?.epoch !== f.epoch) throw new FencedError(f.shard);
      return work(tx);
    });
  }

  // ---------- bots ----------

  async #accountsInShard(shard: number) {
    const rows = await this.#d.db
      .select({ account: sodexAccounts, key: apiKeys })
      .from(sodexAccounts)
      .innerJoin(
        apiKeys,
        and(eq(apiKeys.sodexAccountId, sodexAccounts.id), eq(apiKeys.status, "active")),
      )
      .where(eq(sodexAccounts.status, "connected"));
    return rows
      .filter((r) => shardOf(r.account.id, this.#d.shards) === shard)
      .map((r): AccountRef => ({
        id: r.account.id,
        address: r.account.address as `0x${string}`,
        sodexAccountId: r.account.sodexAccountId,
        apiKeyId: r.key.id,
        apiKeyName: r.key.name,
      }));
  }

  async #syncBots(shard: number): Promise<void> {
    const held = this.#leases.get(shard);
    if (held === undefined) return;
    const accounts = await this.#accountsInShard(shard);
    if (accounts.length === 0) return;
    const list = await this.#d.db
      .select({ bot: bots, version: botVersions })
      .from(bots)
      .innerJoin(botVersions, eq(botVersions.id, bots.activeVersionId))
      .where(
        and(
          inArray(
            bots.sodexAccountId,
            accounts.map((a) => a.id),
          ),
          inArray(bots.state, [...ENGINE_ACTIVE_STATES]),
        ),
      );
    for (const { bot, version } of list) {
      const account = accounts.find((a) => a.id === bot.sodexAccountId);
      if (account === undefined) continue;
      let r = this.#runners.get(bot.id);
      if (r === undefined) {
        r = await this.#load(bot, version, account, shard, held.epoch);
        if (r === undefined) continue;
        this.#runners.set(bot.id, r);
      }
      // Key `active` mới nhất của account (Renew key, DEC-59): runner dùng key mới ngay, không cần nạp lại bot.
      r.account = account;
      await this.#applyPendingVersion(r);
      if (bot.state === BotState.pausing)
        await this.#transition(r, EngineEvent.confirmedPaused, null);
      else if (bot.state === BotState.resuming)
        await this.#transition(r, EngineEvent.confirmedRunning, null);
      else if (bot.state === BotState.stopping) await this.#stopBot(r, null, false);
    }
  }

  async #load(
    bot: typeof bots.$inferSelect,
    version: typeof botVersions.$inferSelect,
    account: AccountRef,
    shard: number,
    epoch: number,
  ): Promise<Runner | undefined> {
    const entry = (
      STRATEGIES as Record<
        string,
        | { schema: { parse: (v: unknown) => unknown }; module: StrategyModule<unknown, unknown> }
        | undefined
      >
    )[bot.strategy];
    if (entry === undefined) {
      this.#d.log.warn({ botId: bot.id, strategy: bot.strategy }, "unknown strategy");
      return undefined;
    }
    if (bot.strategy === Strategy.volumeMaker && !this.#d.volumeMakerEnabled) {
      this.#d.log.warn({ botId: bot.id }, "volume maker is disabled (VOLUME_MAKER_ENABLED=false)");
      return undefined;
    }
    const config = entry.schema.parse(version.config);
    const [saved] = await this.#d.db
      .select()
      .from(botRuntime)
      .where(eq(botRuntime.botId, bot.id))
      .limit(1);
    const markets = this.#marketsOf(bot.market, config);
    const rules: Record<string, MarketRules> = {};
    for (const m of markets) {
      const rr = await this.#d.rules(m);
      if (rr !== undefined) rules[m] = rr;
    }
    return {
      botId: bot.id,
      account,
      shard,
      epoch,
      versionId: version.id,
      version: version.version,
      strategy: bot.strategy,
      market: bot.market,
      config,
      state: saved?.versionId === version.id ? saved.state : entry.module.initialState(config),
      module: entry.module,
      ctx: { botId: bot.id, version: version.version, rules, feeRate: this.#d.feeRate },
      awaitingFirstAck: bot.state === BotState.starting,
      leverageSet: false,
      leverageUnknown: false,
      blocked: null,
    };
  }

  /**
   * Version mới (`pending`, do api tạo khi sửa bot): huỷ lệnh đang mở, khởi tạo lại chiến lược với cấu hình
   * mới, đánh dấu version cũ superseded (DOMAIN.md mục 7.4, DEC-38). Lệnh mới đặt ở tick kế tiếp.
   */
  async #applyPendingVersion(r: Runner): Promise<void> {
    const [pending] = await this.#d.db
      .select()
      .from(botVersions)
      .where(and(eq(botVersions.botId, r.botId), eq(botVersions.status, "pending")))
      .orderBy(desc(botVersions.version))
      .limit(1);
    if (pending === undefined || pending.version <= r.version) return;
    const entry = (
      STRATEGIES as Record<
        string,
        | { schema: { parse: (v: unknown) => unknown }; module: StrategyModule<unknown, unknown> }
        | undefined
      >
    )[r.strategy];
    if (entry === undefined) return;
    const open = await this.#d.db
      .select({ clOrdId: orders.clOrdId })
      .from(orders)
      .where(and(eq(orders.botId, r.botId), inArray(orders.status, ["open", "partially_filled"])));
    await this.#cancel(
      r,
      open.map((o) => o.clOrdId),
    );
    const config = entry.schema.parse(pending.config);
    await this.#fenced(r, async (tx) => {
      await tx
        .update(botVersions)
        .set({ status: "superseded" })
        .where(and(eq(botVersions.botId, r.botId), eq(botVersions.status, "active")));
      await tx
        .update(botVersions)
        .set({ status: "active", appliedAt: new Date(this.#d.now()) })
        .where(eq(botVersions.id, pending.id));
      await tx.update(bots).set({ activeVersionId: pending.id }).where(eq(bots.id, r.botId));
      await tx.insert(outbox).values({
        topic: `user.${r.account.id}.bot`,
        payload: { botId: r.botId, version: pending.version },
      });
    });
    r.versionId = pending.id;
    r.version = pending.version;
    r.config = config;
    r.state = entry.module.initialState(config);
    r.ctx = { ...r.ctx, version: pending.version };
    r.leverageSet = false;
    await this.#event(
      r,
      "version",
      `Applied v${String(pending.version)}`,
      `Cancelled ${String(open.length)} orders; new orders follow on the next price.`,
      this.#d.now(),
    );
  }

  /** Market mà bot cần giá (Funding Arb / Rebalancing dùng nhiều market). */
  #marketsOf(market: string, config: unknown): string[] {
    const c = config as {
      spotMarket?: string;
      perpMarket?: string;
      assets?: { market?: string }[];
    };
    const out = new Set<string>([market]);
    if (c.spotMarket !== undefined) out.add(c.spotMarket);
    if (c.perpMarket !== undefined) out.add(c.perpMarket);
    for (const a of c.assets ?? []) if (a.market !== undefined) out.add(a.market);
    return [...out];
  }

  #watches(r: Runner, market: string): boolean {
    return Object.prototype.hasOwnProperty.call(r.ctx.rules, market);
  }

  async #currentState(botId: string): Promise<BotState | undefined> {
    const [b] = await this.#d.db
      .select({ state: bots.state })
      .from(bots)
      .where(eq(bots.id, botId))
      .limit(1);
    return b?.state;
  }

  /** Đưa event cho chiến lược (chỉ khi bot đang chạy), lưu state, thực hiện hành động. */
  async #feed(r: Runner, event: StrategyEvent): Promise<void> {
    const state = await this.#currentState(r.botId);
    const live =
      state === BotState.starting || state === BotState.running || state === BotState.resuming;
    // Fill / ack vẫn được ghi khi đang pause để sổ cái đúng; giá mới và nhịp đồng hồ thì không xử lý.
    if (!live && (event.type === "tick" || event.type === "timer")) return;
    // Bot Perps: đặt đòn bẩy + margin mode trên SoDEX trước khi chiến lược phản ứng với thị trường. Fill / ack /
    // reject vẫn đi qua để sổ cái đúng; nếu chúng sinh lệnh mới thì #execute chặn lần nữa.
    const accounting =
      event.type === "fill" || event.type === "orderAck" || event.type === "orderReject";
    // Đang backoff vì request trước chưa rời DRIFT: chưa phản ứng với thị trường (fill / ack vẫn ghi).
    if (!accounting && r.blocked !== null && event.at < r.blocked.nextAt) return;
    if (live && !accounting && !r.leverageSet) {
      const lev = await this.#ensureLeverage(r, event.at);
      if (lev === "rejected") await this.#pauseBot(r, ReasonCode.orderRejected);
      if (lev !== "ok") return;
    }
    const prev = r.state;
    const result = r.module.step(r.config, r.state, event, r.ctx);
    // Nhịp đồng hồ chưa tới hạn: chiến lược trả lại đúng state cũ, không có gì để ghi.
    if (event.type === "timer" && result.state === prev && result.actions.length === 0) return;
    r.state = result.state;
    await this.#fenced(r, async (tx) => {
      await tx
        .insert(botRuntime)
        .values({
          botId: r.botId,
          versionId: r.versionId,
          state: r.state,
          epoch: r.epoch,
        })
        .onConflictDoUpdate({
          target: botRuntime.botId,
          set: {
            state: r.state,
            versionId: r.versionId,
            epoch: r.epoch,
            updatedAt: new Date(),
          },
        });
    });
    // Bot đang start mà tick đầu không đặt lệnh nào (ví dụ chờ trigger): không có gì để SoDEX ack.
    if (
      r.awaitingFirstAck &&
      event.type === "tick" &&
      !result.actions.some((x) => x.type === "place")
    ) {
      await this.#ack(r, event.at);
    }
    // Sự kiện thị trường: nếu lệnh chưa rời DRIFT thì hoàn tác bước này (state cũ, xoá dòng lệnh tạm) để thử lại.
    await this.#execute(r, result.actions, event.at, accounting ? null : prev);
  }

  /**
   * Bot Spot hoặc SoDEX đã xác nhận → "ok". Đọc thiết lập hiện tại trước (account state `S`): đã đúng thì
   * không ghi. Bị từ chối → "rejected" (caller pause `ORDER_REJECTED`). Lần ghi trước không rõ kết quả →
   * chỉ gửi lại khi đọc được SoDEX và thấy chưa áp dụng (quy tắc 1.7). Chưa rời DRIFT → "not_sent" + backoff.
   */
  async #ensureLeverage(
    r: Runner,
    at: number,
  ): Promise<"ok" | "rejected" | "unknown" | "not_sent"> {
    const spec = leverageSpec(r.strategy, r.market, r.config);
    if (spec === null) {
      r.leverageSet = true;
      return "ok";
    }
    const what = `${String(spec.leverage)}× ${spec.marginMode} on ${spec.market}`;
    let current: { leverage: number; marginMode: string } | null | undefined;
    let position: { leverage: number; marginMode: string } | null = null;
    try {
      const read = await this.#d.gateway.readLeverage(r.account, spec.market);
      current = read.setting;
      position = read.position;
    } catch {
      current = undefined;
    }
    if (current?.leverage === spec.leverage && current.marginMode === spec.marginMode) {
      r.leverageSet = true;
      r.leverageUnknown = false;
      await this.#event(r, "decision", "Leverage set", `SoDEX confirmed ${what}.`, at);
      return "ok";
    }
    // Vị thế đang mở trên symbol với thiết lập khác: không đổi đòn bẩy của cả account (DEC-58), không retry.
    if (
      position !== null &&
      (position.leverage !== spec.leverage || position.marginMode !== spec.marginMode)
    ) {
      await this.#event(
        r,
        "error",
        "Leverage not changed",
        `Open ${spec.market} position at ${String(position.leverage)}× ${position.marginMode}.`,
        at,
      );
      return "rejected";
    }
    if (r.leverageUnknown && current === undefined) {
      this.#d.log.warn({ botId: r.botId }, "leverage result unknown and SoDEX unreadable; waiting");
      return "unknown";
    }
    const res = await this.#d.gateway.setLeverage(r.account, spec, {
      shard: r.shard,
      epoch: r.epoch,
    });
    r.leverageUnknown = res.outcome === "unknown";
    if (res.outcome === "ok") {
      r.leverageSet = true;
      r.blocked = null;
      await this.#event(r, "decision", "Leverage set", `SoDEX confirmed ${what}.`, at);
    } else if (res.outcome === "rejected") {
      await this.#event(
        r,
        "error",
        "Leverage not set",
        `SoDEX rejected ${what} (code ${res.code}). No orders were sent.`,
        at,
      );
    } else if (res.outcome === "not_sent") {
      await this.#notSent(r, res.code, at);
    } else {
      this.#d.log.warn({ botId: r.botId }, "leverage update result unknown; reconciling next");
    }
    return res.outcome;
  }

  /**
   * Request chưa rời DRIFT. Key không dùng được → pause mọi bot của account (`API_KEY_UNUSABLE`). Lỗi tạm
   * (signer / Vault) → backoff; quá 5 lần hoặc 5 phút thì pause bot với event lỗi kèm mã.
   */
  async #notSent(r: Runner, code: NotSentCode, at: number): Promise<void> {
    if (code === "key_unusable" || code === "key_not_active") {
      r.blocked = null;
      await this.#event(
        r,
        "error",
        "Can't sign with your API key",
        `DRIFT can't sign with your API key (${code}). Nothing was sent to SoDEX. Renew it in Settings › SoDEX access.`,
        at,
      );
      await this.pauseAccount(r.account.id, ReasonCode.apiKeyUnusable);
      return;
    }
    const b = r.blocked ?? { since: at, attempts: 0, nextAt: at, code };
    const attempts = b.attempts + 1;
    if (attempts > NOT_SENT_BACKOFF.maxAttempts || at - b.since >= NOT_SENT_BACKOFF.maxMs_total) {
      r.blocked = null;
      await this.#event(
        r,
        "error",
        "Paused: could not reach the signer",
        `Nothing was sent to SoDEX after ${String(attempts)} attempts (${code}).`,
        at,
      );
      await this.#pauseBot(r, ReasonCode.orderRejected);
      return;
    }
    const wait = Math.min(NOT_SENT_BACKOFF.firstMs * 2 ** (attempts - 1), NOT_SENT_BACKOFF.maxMs);
    r.blocked = { since: b.since, attempts, nextAt: at + wait, code };
    this.#d.log.warn(
      { botId: r.botId, code, attempts, waitMs: wait },
      "request not sent; backing off",
    );
  }

  async #execute(
    r: Runner,
    actions: readonly StrategyAction[],
    at: number,
    /** State trước bước chiến lược, để hoàn tác khi lệnh chưa rời DRIFT (sự kiện thị trường); null = không hoàn tác. */
    rollback: unknown = null,
  ): Promise<void> {
    const places = actions.flatMap((a) => (a.type === "place" ? [a.order] : []));
    const cancels = actions.flatMap((a) => (a.type === "cancel" ? [a.clOrdID] : []));
    for (const a of actions) {
      if (a.type === "log") await this.#event(r, "decision", a.decision, a.why, at);
      if (a.type === "flag")
        await this.#fenced(r, (tx) =>
          tx.update(bots).set({ needsAttention: a.needsAttention }).where(eq(bots.id, r.botId)),
        );
    }
    if (cancels.length > 0) await this.#cancel(r, cancels);
    // Chốt cứng: lệnh Perps mở vị thế không bao giờ được gửi khi SoDEX chưa xác nhận đòn bẩy của bot.
    if (!r.leverageSet && places.some((o) => o.engine === "perps" && !o.reduceOnly)) {
      const lev = await this.#ensureLeverage(r, at);
      if (lev !== "ok") {
        if (lev !== "not_sent") await this.#pauseBot(r, ReasonCode.orderRejected);
        return;
      }
    }
    if (places.length > 0) {
      // Ghi trước (unknown) rồi mới gửi; đã có (chạy lại sau chuyển shard) thì không gửi lại.
      const fresh = await this.#fenced(r, async (tx) => {
        const inserted = await tx
          .insert(orders)
          .values(
            places.map((o) => ({
              botId: r.botId,
              sodexAccountId: r.account.id,
              clOrdId: o.clOrdID,
              market: o.market,
              engine: o.engine,
              side: o.side,
              type: o.type,
              timeInForce: o.timeInForce,
              price: o.price ?? null,
              size: o.quantity,
              status: "unknown" as const,
              reduceOnly: o.reduceOnly,
              tag: o.tag,
              epoch: r.epoch,
              submittedAt: new Date(at),
            })),
          )
          .onConflictDoNothing()
          .returning({ clOrdId: orders.clOrdId });
        return new Set(inserted.map((x) => x.clOrdId));
      });
      // Giới hạn per-trade (Risk Center, server chặn) và chống self-trade: bị chặn thì không tới SoDEX.
      const candidates = places.filter((o) => fresh.has(o.clOrdID));
      const perTrade = await this.#perTradeBlocked(r, candidates);
      const selfTrade = await this.#selfTradeBlocked(
        r,
        candidates.filter((o) => !perTrade.includes(o)),
      );
      const blocked = [...perTrade, ...selfTrade];
      for (const o of blocked) {
        const self = selfTrade.includes(o);
        const code = self ? "SELF_TRADE_BLOCKED" : "RISK_PER_TRADE";
        await this.#fenced(r, (tx) =>
          tx
            .update(orders)
            .set({ status: "rejected", rejectCode: code })
            .where(and(eq(orders.sodexAccountId, r.account.id), eq(orders.clOrdId, o.clOrdID))),
        );
        await this.#event(
          r,
          "risk",
          `Blocked ${o.side} ${o.quantity} ${o.market}`,
          self
            ? "It would have traded with your own open order (SELF_TRADE_BLOCKED)."
            : "Order is larger than the per-trade risk limit.",
          at,
        );
        await this.#feed(r, { type: "orderReject", at, clOrdID: o.clOrdID, code });
      }
      const toSend = places.filter((o) => fresh.has(o.clOrdID) && !blocked.includes(o));
      if (toSend.length > 0) {
        const results = await this.#d.gateway.submit(r.account, toSend, {
          shard: r.shard,
          epoch: r.epoch,
        });
        const notSent = results.filter(
          (x): x is Extract<typeof x, { outcome: "not_sent" }> => x.outcome === "not_sent",
        );
        const firstNotSent = notSent[0];
        if (firstNotSent !== undefined && rollback !== null && notSent.length === results.length) {
          // Không lệnh nào rời DRIFT (signer lỗi): hoàn tác bước chiến lược và xoá dòng lệnh tạm. clOrdID tất
          // định nên lần thử sau (sau backoff) sinh lại đúng các lệnh này.
          const ids = toSend.map((o) => o.clOrdID);
          r.state = rollback;
          await this.#fenced(r, async (tx) => {
            await tx
              .delete(orders)
              .where(
                and(
                  eq(orders.sodexAccountId, r.account.id),
                  inArray(orders.clOrdId, ids),
                  eq(orders.status, "unknown"),
                ),
              );
            await tx
              .update(botRuntime)
              .set({ state: r.state, updatedAt: new Date() })
              .where(eq(botRuntime.botId, r.botId));
          });
          await this.#notSent(r, firstNotSent.code, at);
          return;
        }
        if (notSent.length < results.length) r.blocked = null;
        // Báo lý do trước (vd `API_KEY_UNUSABLE` cho cả account), rồi mới đưa orderReject cho chiến lược.
        if (firstNotSent !== undefined) await this.#notSent(r, firstNotSent.code, at);
        for (const res of results) {
          if (res.outcome === "ok") {
            await this.#fenced(r, (tx) =>
              tx
                .update(orders)
                .set({ status: "open", sodexOrderId: res.orderId, ackedAt: new Date(at) })
                .where(
                  and(eq(orders.sodexAccountId, r.account.id), eq(orders.clOrdId, res.clOrdID)),
                ),
            );
            await this.#ack(r, at);
            await this.#feed(r, { type: "orderAck", at, clOrdID: res.clOrdID });
          } else if (res.outcome === "not_sent") {
            // Chưa rời DRIFT: không phải `unknown`, không cần đối soát. Ghi not_placed để sổ lệnh đúng.
            await this.#fenced(r, (tx) =>
              tx
                .update(orders)
                .set({ status: "not_placed", rejectCode: res.code })
                .where(
                  and(eq(orders.sodexAccountId, r.account.id), eq(orders.clOrdId, res.clOrdID)),
                ),
            );
            await this.#feed(r, { type: "orderReject", at, clOrdID: res.clOrdID, code: res.code });
          } else if (res.outcome === "rejected") {
            await this.#fenced(r, (tx) =>
              tx
                .update(orders)
                .set({ status: "rejected", rejectCode: res.code })
                .where(
                  and(eq(orders.sodexAccountId, r.account.id), eq(orders.clOrdId, res.clOrdID)),
                ),
            );
            await this.#feed(r, { type: "orderReject", at, clOrdID: res.clOrdID, code: res.code });
          } else
            await this.#fenced(r, (tx) =>
              tx.insert(outbox).values({
                topic: "jobs.notify",
                payload: {
                  sodexAccountId: r.account.id,
                  type: "unknown_order",
                  data: { botId: r.botId, clOrdID: res.clOrdID },
                },
              }),
            );
          // unknown: giữ nguyên, #reconcile sẽ đối soát; không gửi lại (quy tắc 1.7).
        }
      }
    }
    const halt = actions.find(
      (a): a is Extract<StrategyAction, { type: "pause" | "stop" }> =>
        a.type === "pause" || a.type === "stop",
    );
    if (halt?.type === "pause") await this.#pauseBot(r, halt.reason);
    if (halt?.type === "stop") await this.#stopBot(r, halt.reason, halt.close);
  }

  readonly #riskCache = new Map<
    string,
    { at: number; equity: string | null; perTradePct: string | null }
  >();

  /**
   * Chống self-trade (VOLUME_MAKER.md mục 17.3.1; SoDEX không có STP): lệnh limit mua phải thấp hơn ask thấp nhất,
   * lệnh bán phải cao hơn bid cao nhất trong các lệnh đang mở của **cả account** trên market đó (mọi bot) và của
   * chính batch này. Mỗi account chỉ có một writer (shard lease) nên không có race.
   */
  async #selfTradeBlocked(r: Runner, list: readonly OrderIntent[]): Promise<OrderIntent[]> {
    const limits = list.filter((o) => o.type === "limit" && o.price !== undefined);
    if (limits.length === 0) return [];
    const batch = new Set(list.map((o) => o.clOrdID));
    const markets = [...new Set(limits.map((o) => o.market))];
    const open = (
      await this.#d.db
        .select({
          clOrdId: orders.clOrdId,
          market: orders.market,
          side: orders.side,
          price: orders.price,
        })
        .from(orders)
        .where(
          and(
            eq(orders.sodexAccountId, r.account.id),
            inArray(orders.market, markets),
            inArray(orders.status, ["open", "partially_filled", "unknown"]),
          ),
        )
    ).filter((x) => !batch.has(x.clOrdId) && x.price !== null);
    const blocked: OrderIntent[] = [];
    for (const o of limits) {
      const price = dec(o.price ?? "0");
      const others = [
        ...open
          .filter((x) => x.market === o.market)
          .map((x) => ({ side: x.side, price: x.price ?? "0" })),
        ...limits
          .filter((x) => x !== o && x.market === o.market && !blocked.includes(x))
          .map((x) => ({ side: x.side, price: x.price ?? "0" })),
      ];
      const crosses = others.some((x) =>
        o.side === "buy"
          ? x.side === "sell" && price.gte(x.price)
          : x.side === "buy" && price.lte(x.price),
      );
      if (crosses) blocked.push(o);
    }
    return blocked;
  }

  async #perTradeBlocked(r: Runner, list: readonly OrderIntent[]): Promise<OrderIntent[]> {
    if (list.length === 0) return [];
    const now = this.#d.now();
    let c = this.#riskCache.get(r.account.id);
    if (c === undefined || now - c.at > 30_000) {
      const [limits] = await this.#d.db
        .select({ perTradePct: riskLimits.perTradePct })
        .from(riskLimits)
        .where(eq(riskLimits.sodexAccountId, r.account.id))
        .limit(1);
      const [snap] = await this.#d.db
        .select({ equity: equitySnapshots.equity })
        .from(equitySnapshots)
        .where(eq(equitySnapshots.sodexAccountId, r.account.id))
        .orderBy(desc(equitySnapshots.at))
        .limit(1);
      c = { at: now, equity: snap?.equity ?? null, perTradePct: limits?.perTradePct ?? null };
      this.#riskCache.set(r.account.id, c);
    }
    if (c.equity === null || c.perTradePct === null) return [];
    const { equity, perTradePct } = c;
    return list.filter((o) => {
      const price = o.price ?? this.#lastPrice.get(o.market);
      return (
        price !== undefined &&
        exceedsPerTrade(dec(price).mul(o.quantity).toString(), equity, perTradePct)
      );
    });
  }

  async #ack(r: Runner, at: number): Promise<void> {
    if (!r.awaitingFirstAck) return;
    r.awaitingFirstAck = false;
    await this.#transition(r, EngineEvent.confirmedRunning, null);
    await this.#event(r, "state", "Running", "SoDEX acknowledged the first orders.", at);
  }

  async #cancel(r: Runner, clOrdIDs: readonly string[]): Promise<void> {
    const rows = await this.#d.db
      .select()
      .from(orders)
      .where(and(eq(orders.sodexAccountId, r.account.id), inArray(orders.clOrdId, [...clOrdIDs])));
    const open = rows.filter((o) => o.status === "open" || o.status === "partially_filled");
    if (open.length === 0) return;
    await this.#d.gateway.cancel(
      r.account,
      open.map((o) => ({ clOrdID: o.clOrdId, market: o.market, engine: o.engine })),
      { shard: r.shard, epoch: r.epoch },
    );
    await this.#fenced(r, (tx) =>
      tx
        .update(orders)
        .set({ status: "cancelled" })
        .where(
          inArray(
            orders.id,
            open.map((o) => o.id),
          ),
        ),
    );
  }

  async #transition(r: Runner, event: EngineEvent, reason: Reason | null): Promise<void> {
    await this.#fenced(r, async (tx) => {
      const [b] = await tx
        .select({ state: bots.state })
        .from(bots)
        .where(eq(bots.id, r.botId))
        .for("update");
      if (b === undefined) return;
      const next = applyEngineEvent(b.state, event);
      if (next === null) return;
      await tx
        .update(bots)
        .set({ state: next, ...(reason === null ? {} : { reasonCode: reason }) })
        .where(eq(bots.id, r.botId));
      await tx.insert(outbox).values({
        topic: `user.${r.account.id}.bot`,
        payload: { botId: r.botId, state: next, reasonCode: reason },
      });
      if (reason !== null)
        await tx.insert(outbox).values({
          topic: "jobs.notify",
          payload: {
            sodexAccountId: r.account.id,
            type: next === "stopped" ? "bot_stopped" : "bot_paused",
            data: { botId: r.botId, reasonCode: reason },
          },
        });
    });
  }

  /** pause giữ lệnh đang mở (DOMAIN.md mục 7.2). */
  async #pauseBot(r: Runner, reason: Reason): Promise<void> {
    await this.#fenced(r, async (tx) => {
      const [b] = await tx
        .select({ state: bots.state })
        .from(bots)
        .where(eq(bots.id, r.botId))
        .for("update");
      const next = b === undefined ? null : applyReason(b.state, reason);
      if (next === null) return;
      await tx.update(bots).set({ state: next, reasonCode: reason }).where(eq(bots.id, r.botId));
      await tx.insert(outbox).values({
        topic: `user.${r.account.id}.bot`,
        payload: { botId: r.botId, state: next, reasonCode: reason },
      });
      await tx.insert(outbox).values({
        topic: "jobs.notify",
        payload: {
          sodexAccountId: r.account.id,
          type: next === "stopped" ? "bot_stopped" : "bot_paused",
          data: { botId: r.botId, reasonCode: reason },
        },
      });
    });
    await this.#event(r, "state", "Paused", reason, this.#d.now());
  }

  /** stop huỷ lệnh của bot rồi (nếu cấu hình) đóng vị thế bằng lệnh reduce-only (DOMAIN.md mục 7.2). */
  async #stopBot(r: Runner, reason: Reason | null, close: boolean): Promise<void> {
    const open = await this.#d.db
      .select({ clOrdId: orders.clOrdId })
      .from(orders)
      .where(and(eq(orders.botId, r.botId), inArray(orders.status, ["open", "partially_filled"])));
    await this.#cancel(
      r,
      open.map((o) => o.clOrdId),
    );
    const ledger = (r.state as { ledger?: { position: string } }).ledger;
    if (close && ledger !== undefined && !dec(ledger.position).isZero()) {
      const qty = dec(ledger.position).abs().toString();
      const engine = this.#engineOf(r);
      const id = `${r.botId.slice(0, 8)}-close-${String(r.version)}`;
      await this.#execute(
        r,
        [
          {
            type: "place",
            order: {
              clOrdID: id,
              market: r.market,
              engine,
              side: dec(ledger.position).isPositive() ? "sell" : "buy",
              type: "market",
              quantity: qty,
              timeInForce: "IOC",
              reduceOnly: engine === "perps",
              tag: "close",
            },
          },
        ],
        this.#d.now(),
      );
    }
    await this.#fenced(r, async (tx) => {
      const [b] = await tx
        .select({ state: bots.state })
        .from(bots)
        .where(eq(bots.id, r.botId))
        .for("update");
      if (b === undefined) return;
      const next =
        reason === null
          ? applyEngineEvent(b.state, EngineEvent.confirmedStopped)
          : applyReason(b.state, reason);
      if (next === null) return;
      await tx
        .update(bots)
        .set({ state: next, ...(reason === null ? {} : { reasonCode: reason }) })
        .where(eq(bots.id, r.botId));
      await tx.insert(outbox).values({
        topic: `user.${r.account.id}.bot`,
        payload: { botId: r.botId, state: next, reasonCode: reason },
      });
      if (reason !== null)
        await tx.insert(outbox).values({
          topic: "jobs.notify",
          payload: {
            sodexAccountId: r.account.id,
            type: next === "stopped" ? "bot_stopped" : "bot_paused",
            data: { botId: r.botId, reasonCode: reason },
          },
        });
    });
    this.#runners.delete(r.botId);
  }

  #engineOf(r: Runner): "spot" | "perps" {
    return r.strategy.startsWith("futures") ? "perps" : "spot";
  }

  async #event(r: Runner, type: string, decision: string, why: string, at: number): Promise<void> {
    await this.#fenced(r, (tx) =>
      tx
        .insert(botEvents)
        .values({ botId: r.botId, type, decision, why, occurredAt: new Date(at) }),
    );
  }

  // ---------- đối soát & phí ----------

  /** Lệnh `unknown`: hỏi SoDEX theo clOrdID rồi mới quyết định; không gửi lại (quy tắc 1.7). */
  async #reconcile(shard: number): Promise<void> {
    const now = this.#d.now();
    const pending = await this.#d.db
      .select()
      .from(orders)
      .where(
        and(
          eq(orders.status, "unknown"),
          lt(orders.submittedAt, new Date(now - RECONCILE_AFTER_MS)),
        ),
      );
    for (const o of pending) {
      const r = this.#runners.get(o.botId);
      if (r?.shard !== shard) continue;
      const found = await this.#d.gateway.lookup(r.account, {
        clOrdID: o.clOrdId,
        market: o.market,
        engine: o.engine,
      });
      if (found.status === "not_found") {
        if (now - (o.submittedAt?.getTime() ?? now) < NOT_FOUND_AFTER_MS) continue;
        await this.#fenced(r, (tx) =>
          tx
            .update(orders)
            .set({ status: "not_placed", reconciledAt: new Date(now) })
            .where(eq(orders.id, o.id)),
        );
        await this.#event(
          r,
          "reconcile",
          "Order not placed",
          `${o.clOrdId} was not found on SoDEX.`,
          now,
        );
        await this.#feed(r, {
          type: "orderReject",
          at: now,
          clOrdID: o.clOrdId,
          code: "NOT_PLACED",
        });
        continue;
      }
      await this.#fenced(r, (tx) =>
        tx
          .update(orders)
          .set({
            status:
              found.status === "partially_filled" || found.status === "filled"
                ? "open"
                : found.status,
            sodexOrderId: found.orderId,
            reconciledAt: new Date(now),
            ackedAt: o.ackedAt ?? new Date(now),
          })
          .where(eq(orders.id, o.id)),
      );
      await this.#event(
        r,
        "reconcile",
        "Order found on SoDEX",
        `${o.clOrdId} is ${found.status}.`,
        now,
      );
      if (found.status === "rejected") {
        await this.#feed(r, { type: "orderReject", at: now, clOrdID: o.clOrdId, code: "REJECTED" });
        continue;
      }
      await this.#ack(r, now);
      await this.#feed(r, { type: "orderAck", at: now, clOrdID: o.clOrdId });
      if (dec(found.filledQty).gt(0) && found.avgPrice !== null) {
        await this.onFill(r.account.id, o.clOrdId, found.filledQty, found.avgPrice, "0", now);
      }
    }
  }

  /** Approval phí khác 50 → pause mọi bot của account (quy tắc 1.5), xử lý ở engine. */
  async #checkFees(shard: number): Promise<void> {
    const now = this.#d.now();
    const accounts = await this.#accountsInShard(shard);
    for (const account of accounts) {
      if (now - (this.#lastFeeCheck.get(account.id) ?? 0) < this.#d.feeCheckMs) continue;
      this.#lastFeeCheck.set(account.id, now);
      if (await this.#d.gateway.builderApproved(account)) continue;
      await this.pauseAccount(account.id, ReasonCode.builderFeeRevoked);
    }
  }

  /** Pause mọi bot đang chạy của account theo reason phạm vi account. Lệnh đang mở được giữ. */
  async pauseAccount(accountId: string, reason: Reason): Promise<number> {
    if (REASON_CODE_META[reason].scope !== "account")
      throw new RangeError("Not an account-scoped reason");
    let count = 0;
    for (const r of [...this.#runners.values()].filter((x) => x.account.id === accountId)) {
      await this.#pauseBot(r, reason);
      count += 1;
    }
    return count;
  }
}
