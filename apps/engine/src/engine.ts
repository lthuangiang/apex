import {
  apiKeys,
  botEvents,
  botRuntime,
  bots,
  botVersions,
  candles1m,
  equitySnapshots,
  fills,
  fundingRates,
  orders,
  outbox,
  riskLimits,
  shardEpochs,
  sodexAccounts,
  userBuilderFees,
  users,
  type Db,
} from "@drift/db";
import { Lease, type LeaseRedis } from "@drift/runtime";
import {
  applyEngineEvent,
  applyReason,
  assetOf,
  BotState,
  builderFeeRateFor,
  builderFeeRateOf,
  type BuilderFeeOverrides,
  isBuilderAccount,
  oneWayFeeFraction,
  oneWayTakerFeeFraction,
  dec,
  ENGINE_ACTIVE_STATES,
  EngineEvent,
  EXPERIMENTAL_STRATEGIES,
  type LeaderFillMessage,
  type LeaderPositionMessage,
  leverageSpecOf,
  type MmGuardMessage,
  leverageSpecsOf,
  type LeverageSpec,
  REASON_CODE_META,
  ReasonCode,
  type ReasonCode as Reason,
  Strategy,
  sub,
  VOLUME_STRATEGIES,
  exceedsPerTrade,
} from "@drift/shared";
import {
  applyFill,
  botCapitalOf,
  clOrdId,
  copyMarkets,
  copyPositions,
  fnv1a64,
  isMultiMarketCopyState,
  normalizeCopyState,
  STRATEGIES,
  type CopyTradeConfig,
  type Ledger,
  type BookTop,
  type MarketRules,
  type MarketSnapshot,
  type StepContext,
  type StrategyAction,
  type StrategyEvent,
  type StrategyModule,
  type OrderIntent,
} from "@drift/strategies";
import { and, desc, eq, gt, inArray, isNull, lt, lte, sql } from "drizzle-orm";
import type { Logger } from "pino";

import { openedAlerts, SkipGate, skipMarket, skippedAlert, skipReason } from "./copy-alerts";
import type { AccountRef, Gateway, LookupResult, NotSentCode } from "./gateway";
import type { PaperGateway } from "./paper-gateway";

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
/** Mỗi lệnh `open` không còn ai theo dõi được đối chiếu với SoDEX tối đa một lần trong khoảng này. */
export const OPEN_CHECK_MS = 15_000;
/** Số lệnh đối chiếu tối đa mỗi vòng của một shard, để không tiêu hết hạn mức REST. */
const OPEN_CHECK_BATCH = 10;
/** Sau khi user stream đứt, đối soát lệnh Volume Farm trong khoảng này (đủ cho lệnh đang chờ khớp lúc đứt). */
export const STREAM_GAP_MS = 120_000;
/** Lệnh đã huỷ trong khoảng này mới cần xác nhận: lệnh Volume Farm chỉ sống vài chục giây. */
const UNCONFIRMED_CANCEL_MS = 600_000;
/**
 * Market Making (DEC-100): mỗi account + market đọc lịch sử khớp của SoDEX một lần mỗi chừng này ms, để bắt fill
 * của lệnh đã huỷ / thay mà tin khớp chưa tới (một REST call).
 */
export const MAKER_BACKFILL_MS = 10_000;
/** Chỉ đối soát lệnh gửi trong khoảng này (khớp `VM_KEEP_DONE_MS` của chiến lược). */
const MAKER_BACKFILL_WINDOW_MS = 600_000;
/** Market Making: đọc vị thế thật trên SoDEX mỗi chừng này ms để phát hiện lệch sổ (DEC-100). */
export const MAKER_POSITION_MS = 30_000;
/**
 * Huỷ chưa xong (request không rời DRIFT vì signer lỗi, hoặc SoDEX không trả kết quả rõ): thử lại sau mỗi chừng này
 * ms cho tới khi SoDEX xác nhận. Không thử lại thì lệnh còn sống trên sổ và còn "open" trong DRIFT, chặn mọi lệnh
 * ngược chiều bằng kiểm tra self-trade (sự cố 2026-11-04, DEC-111).
 */
export const CANCEL_RETRY_MS = 5_000;
/** Market Making: lệnh còn "open" lâu hơn mức này mà chiến lược không còn theo dõi thì engine huỷ (DEC-111). */
export const MAKER_ORPHAN_MS = 15_000;
/** Bot paper: ghi số dư giả mỗi phút (biểu đồ theo ngày ở trang Fake-money test, DEC-105). */
export const PAPER_SNAPSHOT_MS = 60_000;

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
  /** Ghi đè phí một chiều cho mọi bot (chỉ dùng trong test); bình thường mỗi bot tự tính (DEC-112). */
  feeRate?: string;
  /** Account SoDEX của builder (DEC-47): bot của account này không chịu builder fee khi tính TP / hoà vốn. */
  builderId?: bigint;
  /** Account builder được miễn builder fee (DEC-47); false = tính builder fee như mọi account (DEC-124). */
  builderExempt?: boolean;
  /** Chu kỳ kiểm tra approval phí của mỗi account. */
  feeCheckMs?: number;
  /**
   * Đỉnh sổ lệnh (REST orderbook) cho Volume Farm / Market Making (Perps) và Rebalancing (Spot); null khi không đọc
   * được. Không truyền thì Volume Farm chỉ dùng nến (tín hiệu chạy chế độ chỉ-nến như apex).
   */
  orderbook?: (market: string, engine?: "spot" | "perps") => Promise<BookTop | null>;
  /** Cổng mô phỏng cho bot paper (DEC-105). Không truyền thì engine không nạp bot paper nào. */
  paper?: PaperGateway;
}

/** Engine (Spot / Perps) mà bot giao dịch, theo chiến lược và cấu hình. */
function engineOfBot(strategy: string, config: unknown): "spot" | "perps" {
  if (
    strategy.startsWith("futures") ||
    VOLUME.has(strategy) ||
    strategy === Strategy.adaptiveDca ||
    strategy === Strategy.copyTrade
  )
    return "perps";
  if (strategy === Strategy.twap)
    return (config as { engine?: string }).engine === "perps" ? "perps" : "spot";
  return "spot";
}

/**
 * `StepContext.feeRate` của một bot (DEC-112): nửa phí khứ hồi maker = SoDEX maker của market (`/symbols`, thiếu thì
 * mức cơ bản) + builder fee của chiến lược (Spot chỉ chiều bán). `builderAccount`: account của builder, không chịu
 * builder fee (DEC-47).
 */
export function botFeeRate(
  strategy: string,
  config: unknown,
  rules: MarketRules | undefined,
  builderAccount: boolean,
  builderRate = builderFeeRateOf(strategy),
): string {
  return oneWayFeeFraction({
    engine: engineOfBot(strategy, config),
    makerPct: rules?.makerFee === undefined ? null : dec(rules.makerFee).mul(100),
    builderRate: builderAccount ? 0 : builderRate,
  }).toString();
}

/** Như `botFeeRate` nhưng cho lệnh taker: SoDEX taker của market + builder fee (DEC-117). */
export function botTakerFeeRate(
  strategy: string,
  config: unknown,
  rules: MarketRules | undefined,
  builderAccount: boolean,
  builderRate = builderFeeRateOf(strategy),
): string {
  return oneWayTakerFeeFraction({
    engine: engineOfBot(strategy, config),
    takerPct: rules?.takerFee === undefined ? null : dec(rules.takerFee).mul(100),
    builderRate: builderAccount ? 0 : builderRate,
  }).toString();
}

/** Volume Farm nhận nến + sổ lệnh tối đa mỗi ngần này ms (một lần đọc REST mỗi market, weight 2). */
export const FARM_SNAPSHOT_MS = 3_000;
/** Số nến 1 phút gửi cho Volume Farm: đủ 5 phút × 15 cho regime (FarmMicro cần ≥ 15 nến 5 phút). */
export const FARM_CANDLES = 120;

interface Runner {
  botId: string;
  /** Đang xử lý tín hiệu Binance guard: giờ Binance của tín hiệu, để ghi Decisions khi SoDEX xác nhận huỷ. */
  guardAt?: number | undefined;
  account: AccountRef;
  /** Bot paper: mọi lệnh qua `PaperGateway`, không bao giờ tới SoDEX (DEC-105). */
  paper: boolean;
  /** Cổng đặt lệnh của runner, chọn một lần ở `#gatewayFor` khi nạp bot. */
  gateway: Gateway;
  shard: number;
  epoch: number;
  versionId: string;
  version: number;
  strategy: string;
  /** Builder fee gắn vào lệnh (phần mười bp): mức riêng của user nếu team đặt (DEC-159), không thì mặc định. */
  builderRate: number;
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
  /** Số lệnh market reduce-only bị SoDEX từ chối liên tiếp (vị thế trong sổ bot có thể lệch SoDEX). */
  reduceRejects: number;
  /** Tương tự cho lệnh limit / post-only: bị từ chối thường chỉ vì giá chạy, nên có ngưỡng riêng cao hơn. */
  makerReduceRejects: number;
  /** Giới hạn tin `copy_bot_skipped` của bot copy (DEC-212), trong bộ nhớ. */
  skipGate: SkipGate;
}

/**
 * Lệnh market reduce-only bị từ chối liên tiếp chừng này lần thì pause bot, không gửi lại mãi (quy tắc 1.7).
 * Chỉ đếm market: post-only bị từ chối là bình thường khi giá chạy nhanh, pause lúc đó bỏ mặc vị thế đang mở
 * đúng lúc cần thoát, trước cả khi chiến lược kịp chuyển sang market (DEC-89).
 */
export const MAX_REDUCE_ONLY_REJECTS = 3;
/** Ngưỡng cho bot không dùng market (tắt `allowTaker`): không có bước leo thang thì vẫn phải có điểm dừng. */
export const MAX_MAKER_REDUCE_REJECTS = 30;

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
  Strategy.volumeFarm,
  Strategy.adaptiveDca,
  // Copy Trade: đặt lại lệnh giảm vị thế còn thiếu ở nhịp đồng hồ (DEC-161).
  Strategy.copyTrade,
]);

/**
 * Chiến lược nhận kèm nến 1 phút với `timer` và chu kỳ gửi: Volume Farm mỗi 3 s; AI Adaptive DCA dùng nến 5 phút nên
 * mỗi phút là đủ (DEC-107), đỡ một lần đọc sổ lệnh REST mỗi 3 s.
 */
const SNAPSHOT_EVERY_MS: Readonly<Record<string, number>> = {
  [Strategy.volumeFarm]: 3_000,
  // Market Making báo giá theo sổ lệnh (DEC-135); dùng chung bản đọc với Volume Farm cùng market.
  [Strategy.volumeMaker]: 3_000,
  [Strategy.adaptiveDca]: 60_000,
};

/** Chiến lược nhận kèm đỉnh sổ lệnh của mọi market nó dùng với `timer`, và chu kỳ gửi (Rebalancing: IOC theo ask / bid). */
const BOOKS_EVERY_MS: Readonly<Record<string, number>> = {
  [Strategy.rebalancing]: 60_000,
};
/** Đỉnh sổ lệnh đọc gần đây được dùng chung cho mọi bot cùng market trong chừng này. */
const BOOK_CACHE_MS = 3_000;

const VOLUME: ReadonlySet<string> = new Set(VOLUME_STRATEGIES);
/** Trạng thái mà cờ theo tài khoản (volume bots, Adaptive DCA, AI Desk) chặn nạp: bot đang muốn chạy. */
const FLAG_GATED_STATES: ReadonlySet<string> = new Set<string>([
  BotState.starting,
  BotState.running,
  BotState.resuming,
]);

/** Giờ UTC tới mili giây (HH:MM:SS.mmm) cho Decisions của Binance guard. */
export const clockTime = (ms: number): string => new Date(ms).toISOString().slice(11, 23);

export function shardOf(accountId: string, shards = ENGINE_SHARDS): number {
  return Number(fnv1a64(accountId) % BigInt(shards));
}

export class Engine {
  readonly #d: Required<Omit<EngineDeps, "feeRate" | "paper" | "builderId">> & {
    feeRate: string | undefined;
    builderId: bigint | undefined;
    paper: PaperGateway | undefined;
  };
  readonly #leases = new Map<number, { lease: Lease; epoch: number }>();
  readonly #runners = new Map<string, Runner>();
  readonly #lastFeeCheck = new Map<string, number>();
  readonly #snapshots = new Map<string, { at: number; snap: MarketSnapshot }>();
  readonly #snapshotFed = new Map<string, number>();
  /** Lần gần nhất gửi đỉnh sổ lệnh cho bot (`BOOKS_EVERY_MS`). */
  readonly #booksFed = new Map<string, number>();
  readonly #books = new Map<string, { at: number; book: BookTop | null }>();
  readonly #openChecks = new Map<string, number>();
  /** Lần cuối user stream của account có thể đã mất tin (đứt kết nối, engine vừa nạp bot). */
  readonly #streamGaps = new Map<string, number>();
  readonly #fillQueues = new Map<string, Promise<void>>();
  /** Lần cuối đọc trade / vị thế cho Market Making, theo `account:market` (DEC-100). */
  readonly #makerBackfill = new Map<string, number>();
  readonly #makerPosition = new Map<string, number>();
  /** Lệnh đang chờ huỷ lại theo bot (huỷ trước đó chưa được SoDEX xác nhận), và lần thử gần nhất. */
  readonly #pendingCancels = new Map<string, Set<string>>();
  readonly #cancelRetryAt = new Map<string, number>();
  /** Lần cuối ghi số dư giả của bot paper. */
  readonly #paperSnapAt = new Map<string, number>();
  #stopped = false;

  constructor(deps: EngineDeps) {
    this.#d = {
      now: () => Date.now(),
      leaseTtlMs: 15_000,
      shards: ENGINE_SHARDS,
      feeCheckMs: 60_000,
      orderbook: () => Promise.resolve(null),
      ...deps,
      builderExempt: deps.builderExempt ?? true,
      feeRate: deps.feeRate,
      builderId: deps.builderId,
      paper: deps.paper,
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
        await this.#reconcileOpen(shard);
        await this.#retryCancels(shard);
        await this.#reconcileMaker(shard);
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
    const paper = this.#d.paper;
    if (paper !== undefined)
      for (const r of [...this.#runners.values()].filter((x) => x.shard === shard && x.paper)) {
        if (at - (this.#paperSnapAt.get(r.botId) ?? 0) < PAPER_SNAPSHOT_MS) continue;
        this.#paperSnapAt.set(r.botId, at);
        await paper.snapshot(r.botId, at);
      }
    for (const r of [...this.#runners.values()].filter(
      (x) => x.shard === shard && CLOCKED.has(x.strategy),
    )) {
      const every = SNAPSHOT_EVERY_MS[r.strategy];
      if (every !== undefined) {
        // Nhịp dữ liệu tính theo từng bot: nhiều bot (kể cả của khách khác) cùng market đều nhận được.
        const due = at - (this.#snapshotFed.get(r.botId) ?? 0) >= every;
        const market = due ? await this.#snapshot(r.market, at) : null;
        if (due) this.#snapshotFed.set(r.botId, at);
        await this.#feed(
          r,
          market === null ? { type: "timer", at } : { type: "timer", at, market },
        );
      } else {
        const booksEvery = BOOKS_EVERY_MS[r.strategy];
        const due =
          booksEvery !== undefined && at - (this.#booksFed.get(r.botId) ?? 0) >= booksEvery;
        if (!due) {
          await this.#feed(r, { type: "timer", at });
          continue;
        }
        this.#booksFed.set(r.botId, at);
        const books: Record<string, BookTop | null> = {};
        // Rebalancing chỉ có market Spot.
        for (const m of this.#marketsOf(r.market, r.config))
          books[m] = await this.#bookTop(m, at, "spot");
        await this.#feed(r, { type: "timer", at, books });
      }
    }
  }

  /** Đỉnh sổ lệnh của một market, dùng chung giữa các bot trong `BOOK_CACHE_MS`; đọc lỗi → null. */
  async #bookTop(market: string, at: number, engine: "spot" | "perps"): Promise<BookTop | null> {
    const key = `${engine}:${market}`;
    const hit = this.#books.get(key);
    if (hit !== undefined && at - hit.at < BOOK_CACHE_MS) return hit.book;
    const book = await this.#d.orderbook(market, engine).catch(() => null);
    this.#books.set(key, { at, book });
    return book;
  }

  /**
   * Nến 1 phút đã đóng (`candles_1m`, marketdata ghi) + đỉnh sổ lệnh cho Volume Farm. Mỗi market đọc SoDEX tối đa
   * mỗi `FARM_SNAPSHOT_MS`; các bot khác cùng market dùng chung bản đã đọc.
   */
  async #snapshot(market: string, at: number): Promise<MarketSnapshot> {
    const hit = this.#snapshots.get(market);
    if (hit !== undefined && at - hit.at < FARM_SNAPSHOT_MS) return hit.snap;
    const rows = await this.#d.db
      .select()
      .from(candles1m)
      .where(eq(candles1m.market, market))
      .orderBy(desc(candles1m.ts))
      .limit(FARM_CANDLES);
    const book = await this.#d.orderbook(market).catch(() => null);
    const snap: MarketSnapshot = {
      market,
      candles: rows.reverse().map((k) => ({
        t: k.ts.getTime(),
        o: k.open,
        h: k.high,
        l: k.low,
        c: k.close,
        v: k.volume,
      })),
      book,
    };
    this.#snapshots.set(market, { at, snap });
    return snap;
  }

  /** Giá mới từ marketdata (NATS `md.<market>.price`). */
  readonly #lastPrice = new Map<string, string>();

  /**
   * Binance guard (`md.<market>.guard`): báo giá phía nào đang cũ. Đưa ngay cho bot Market Making bật Smart quoting
   * trên market đó (bot huỷ lệnh mở thêm vị thế của phía cũ). Ghi log các mốc thời gian để đo độ trễ thật.
   */
  async onMmGuard(msg: MmGuardMessage, recvAt: number): Promise<void> {
    for (const r of [...this.#runners.values()].filter(
      (x) =>
        x.strategy === Strategy.volumeMaker &&
        x.market === msg.s &&
        (x.config as { smartQuoting?: boolean }).smartQuoting === true,
    )) {
      r.guardAt = msg.T;
      try {
        await this.#feed(r, {
          type: "guard",
          at: recvAt,
          market: msg.s,
          ask: msg.ask,
          bid: msg.bid,
          gapBp: msg.gapBp,
          binanceAt: msg.T,
        });
      } finally {
        r.guardAt = undefined;
      }
      this.#d.log.info(
        {
          botId: r.botId,
          market: msg.s,
          ask: msg.ask,
          bid: msg.bid,
          gapBp: msg.gapBp,
          binanceAt: msg.T,
          marketdataAt: msg.at,
          engineAt: recvAt,
          doneAt: this.#d.now(),
        },
        "mm guard",
      );
    }
  }

  async onPrice(market: string, price: string, at: number): Promise<void> {
    this.#lastPrice.set(market, price);
    // Bot paper: giá thật đi xuyên qua lệnh giả → fill mô phỏng, đưa vào sổ cái như fill thật (DEC-105).
    const paper = this.#d.paper;
    if (paper !== undefined) {
      paper.setPrice(market, price);
      if (
        [...this.#runners.values()].some(
          (x) => x.paper && (x.market === market || this.#watches(x, market)),
        )
      ) {
        for (const f of await paper.onPrice(market, price, at))
          await this.onFill(f.accountId, f.clOrdID, f.totalFilled, f.avgPrice, f.fee, at);
      }
    }
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
    for (const r of targets) {
      await this.#feed(r, { type: "fundingRate", at, market, current, avg7d });
      // Bot paper: trả / nhận funding trên vị thế giả; bot thật nhận `fundingPaid` từ SoDEX.
      if (r.paper && this.#d.paper !== undefined) {
        const amount = await this.#d.paper.applyFunding(r.botId, market, rate, at);
        if (!dec(amount).isZero()) await this.#feed(r, { type: "fundingPaid", at, market, amount });
      }
    }
  }

  /** Bot copy đang theo ví leader này (Copy Trade, DEC-161). */
  #copiers(source: string, address: string): Runner[] {
    const addr = address.toLowerCase();
    return [...this.#runners.values()].filter((r) => {
      if (r.strategy !== Strategy.copyTrade) return false;
      const c = r.config as { leaderSource?: string; leaderAddress?: string };
      return c.leaderSource === source && c.leaderAddress === addr;
    });
  }

  /** Fill của ví leader (NATS `leader.<source>.<address>.fill`). `receivedAt` = lúc engine nhận. */
  async onLeaderFill(m: LeaderFillMessage, receivedAt: number): Promise<void> {
    // Mọi bot theo ví này, kể cả bot không có market của fill: chiến lược ghi "Skipped · market_off" và không bao giờ mở
    // lệnh ở market đó (DEC-226).
    for (const r of this.#copiers(m.source, m.address)) {
      // Hạn mức do marketdata phân bổ (DEC-163 mục 9); có map mà thiếu bot này thì 0.
      const allowance = m.allowances === undefined ? undefined : (m.allowances[r.botId] ?? "0");
      await this.#feed(r, {
        type: "leaderFill",
        at: receivedAt,
        leaderAt: m.at,
        market: m.market,
        side: m.side,
        price: m.price,
        quantity: m.quantity,
        positionAfter: m.positionAfter,
        ...(allowance === undefined ? {} : { allowance }),
        ...(m.allowanceReason === undefined ? {} : { allowanceReason: m.allowanceReason }),
      });
    }
  }

  /** Vị thế ví leader đọc lại định kỳ (NATS `leader.<source>.<address>.position`). */
  async onLeaderPosition(m: LeaderPositionMessage, receivedAt: number): Promise<void> {
    for (const r of this.#copiers(m.source, m.address))
      for (const market of copyMarkets(r.config as Record<string, unknown>))
        await this.#feed(r, {
          type: "leaderPosition",
          at: receivedAt,
          market,
          size: m.positions[market] ?? "0",
        });
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
      .select({ id: orders.id, mode: bots.mode })
      .from(orders)
      .innerJoin(bots, eq(bots.id, orders.botId))
      .where(and(eq(orders.sodexAccountId, accountId), eq(orders.clOrdId, t.clOrdID)))
      .limit(1);
    // Lệnh paper không bao giờ có trade thật; không ghi vào `fills` dù dữ liệu tới từ đâu (DEC-105).
    if (o?.mode !== "live") return;
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

  /**
   * Fill từ user stream hoặc từ đối soát; chỉ phần khối lượng mới được báo cho chiến lược. Các update của cùng một
   * lệnh chạy lần lượt: chạy song song thì cùng đọc `filledSize` cũ và cộng trùng khối lượng (DEC-87).
   */
  async onFill(
    accountId: string,
    clOrdID: string,
    totalFilled: string,
    avgPrice: string,
    fee: string,
    at: number,
  ): Promise<void> {
    await this.#inOrderQueue(accountId, clOrdID, () =>
      this.#applyOrderFill(accountId, clOrdID, totalFilled, avgPrice, fee, at),
    );
  }

  /**
   * Lệnh đã kết thúc trên SoDEX (FILLED / CANCELED / EXPIRED / REJECTED), từ user stream hoặc đối soát. Báo chiến lược
   * đúng một lần mỗi lệnh (`orders.done_fed_at`): `orderReject` khi bị từ chối mà chưa khớp gì, còn lại `orderDone`,
   * kể cả khi đã khớp một phần rồi hết hạn / bị huỷ (trước đây chỉ báo khi chưa khớp gì nên chiến lược đợi mãi phần
   * còn lại). Chạy chung hàng đợi với fill của lệnh đó nên fill luôn tới chiến lược trước. Lệnh chưa khớp gì thì cập
   * nhật trạng thái luôn, không để kẹt "open" (DEC-122).
   */
  async onOrderClosed(
    accountId: string,
    clOrdID: string,
    state: "rejected" | "cancelled" | "filled",
    at: number,
    reason: string | null = null,
  ): Promise<void> {
    await this.#inOrderQueue(accountId, clOrdID, () =>
      this.#finishOrder(accountId, clOrdID, state, at, reason),
    );
  }

  async #finishOrder(
    accountId: string,
    clOrdID: string,
    state: "rejected" | "cancelled" | "filled",
    at: number,
    reason: string | null,
  ): Promise<void> {
    const [o] = await this.#d.db
      .select()
      .from(orders)
      .where(and(eq(orders.sodexAccountId, accountId), eq(orders.clOrdId, clOrdID)))
      .limit(1);
    if (o?.doneFedAt !== null) return;
    const r = this.#runners.get(o.botId);
    if (r === undefined || r.paper) return;
    const nothing = !dec(o.filledSize).gt(0);
    const open = ["open", "partially_filled", "unknown"].includes(o.status);
    const rejected = state === "rejected" && nothing;
    const status = rejected
      ? "rejected"
      : dec(o.filledSize).gte(o.size)
        ? "filled"
        : open
          ? "cancelled"
          : o.status;
    const fed = await this.#markDone(r, o.id, {
      ...(open ? { status, reconciledAt: new Date(at) } : {}),
      ...(rejected && open ? { rejectCode: reason ?? "REJECTED" } : {}),
    });
    if (!fed) return;
    this.#pendingCancels.get(o.botId)?.delete(clOrdID);
    this.#openChecks.delete(o.id);
    await this.#feed(
      r,
      rejected
        ? { type: "orderReject", at, clOrdID, code: o.rejectCode ?? reason ?? "REJECTED" }
        : { type: "orderDone", at, clOrdID },
    );
  }

  /** Đánh dấu đã báo kết thúc (chỉ lần đầu thắng); `true` khi lần gọi này là lần đánh dấu. */
  async #markDone(
    fence: { shard: number; epoch: number },
    orderId: string,
    set: Partial<typeof orders.$inferInsert> = {},
  ): Promise<boolean> {
    const rows = await this.#fenced(fence, (tx) =>
      tx
        .update(orders)
        .set({ ...set, doneFedAt: new Date(this.#d.now()) })
        .where(and(eq(orders.id, orderId), isNull(orders.doneFedAt)))
        .returning({ id: orders.id }),
    );
    return rows.length > 0;
  }

  /** Các việc của cùng một lệnh (fill, kết thúc) chạy lần lượt theo thứ tự tới. */
  async #inOrderQueue(accountId: string, clOrdID: string, run: () => Promise<void>): Promise<void> {
    const key = `${accountId}:${clOrdID}`;
    const next = (this.#fillQueues.get(key) ?? Promise.resolve()).catch(() => undefined).then(run);
    this.#fillQueues.set(key, next);
    try {
      await next;
    } finally {
      if (this.#fillQueues.get(key) === next) this.#fillQueues.delete(key);
    }
  }

  /** User stream có thể đã mất tin: đối soát lệnh Volume Farm của account trong ít phút tới (DEC-87). */
  onStreamGap(accountId: string): void {
    this.#streamGaps.set(accountId, this.#d.now());
  }

  async #applyOrderFill(
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
    // Lệnh đã huỷ mà khớp một phần trước lúc huỷ vẫn là `cancelled`, không quay về trạng thái đang mở.
    const status = dec(totalFilled).gte(o.size)
      ? "filled"
      : o.status === "cancelled"
        ? "cancelled"
        : "partially_filled";
    await this.#fenced(r, async (tx) => {
      await tx
        .update(orders)
        .set({ filledSize: totalFilled, avgPrice, status })
        .where(eq(orders.id, o.id));
    });
    // SoDEX báo giá trung bình luỹ kế; phần mới khớp có giá riêng.
    const before = dec(o.avgPrice ?? "0").mul(o.filledSize);
    const price = dec(avgPrice).mul(totalFilled).sub(before).div(delta);
    await this.#feed(r, {
      type: "fill",
      at,
      clOrdID,
      price: (price.gt(0) ? price : dec(avgPrice)).toString(),
      quantity: delta.toString(),
      fee,
    });
  }

  /** Account có bot đang chạy trong các shard của worker này (để mở user stream). */
  activeAccounts(): Promise<AccountRef[]> {
    const seen = new Map<string, AccountRef>();
    // Bot paper không cần user stream của SoDEX.
    for (const r of this.#runners.values()) if (!r.paper) seen.set(r.account.id, r.account);
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
    const fees = await this.#builderFeesOf(list.map((x) => x.bot.userId));
    for (const { bot, version } of list) {
      const account = accounts.find((a) => a.id === bot.sodexAccountId);
      if (account === undefined) continue;
      let r = this.#runners.get(bot.id);
      if (r === undefined) {
        r = await this.#load(bot, version, account, shard, held.epoch);
        if (r === undefined) continue;
        this.#runners.set(bot.id, r);
      }
      // Team đổi builder fee của user (DEC-159): lệnh mới dùng mức mới ngay, chiến lược tính phí theo mức mới.
      const rate = builderFeeRateFor(bot.strategy, fees.get(bot.userId));
      if (rate !== r.builderRate) {
        r.builderRate = rate;
        if (this.#d.feeRate === undefined) {
          const route = { account: r.account, paper: r.paper };
          r.ctx = {
            ...r.ctx,
            feeRate: this.#feeRateOf(bot, r.config, r.ctx.rules, route, rate),
            takerFeeRate: this.#feeRateOf(bot, r.config, r.ctx.rules, route, rate, true),
          };
        }
      }
      // Key `active` mới nhất của account (Renew key, DEC-59): runner dùng key mới ngay, không cần nạp lại bot.
      r.account = r.paper ? { ...account, paper: true } : account;
      await this.#applyPendingVersion(r);
      if (bot.state === BotState.pausing)
        await this.#transition(r, EngineEvent.confirmedPaused, null);
      else if (bot.state === BotState.resuming) {
        await this.#transition(r, EngineEvent.confirmedRunning, null);
        // Chiến lược tự pause (halted) chạy tiếp từ sổ cái và vị thế thật, dựng lại lệnh (DEC-240).
        const prices = Object.fromEntries(
          this.#marketsOf(r.market, r.config).flatMap((m) => {
            const p = this.#lastPrice.get(m);
            return p === undefined ? [] : [[m, p] as const];
          }),
        );
        await this.#feed(r, { type: "resumed", at: this.#d.now(), prices });
      }
      // Stop của người dùng: đóng vị thế của bot nếu họ chọn ở hộp thoại Stop (DEC-81).
      else if (bot.state === BotState.stopping) await this.#stopBot(r, null, bot.closeOnStop);
    }
  }

  /**
   * Chỗ DUY NHẤT chọn cổng đặt lệnh theo `mode` của bot (DEC-105). Bot paper nhận PaperGateway và account có cờ
   * `paper`, nên kể cả khi bị gọi nhầm, HttpGateway cũng từ chối. Thiếu PaperGateway thì không chạy bot paper.
   */
  #gatewayFor(
    mode: string,
    account: AccountRef,
  ): { gateway: Gateway; account: AccountRef; paper: boolean } | null {
    if (mode === "live") return { gateway: this.#d.gateway, account, paper: false };
    if (mode === "paper" && this.#d.paper !== undefined)
      return { gateway: this.#d.paper, account: { ...account, paper: true }, paper: true };
    return null;
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
    const route = this.#gatewayFor(bot.mode, account);
    if (route === null) {
      this.#d.log.warn({ botId: bot.id, mode: bot.mode }, "no gateway for bot mode");
      return undefined;
    }
    // Cờ theo tài khoản chỉ chặn bot đang muốn CHẠY (starting / running / resuming). Bot đang pausing / stopping vẫn
    // nạp để runner hoàn tất Pause / Stop như thường (Pause giữ lệnh đang mở, DOMAIN.md mục 7.2); không thì bot kẹt
    // Pausing mãi (review #71, DEC-218). Paused / stopped không có trong ENGINE_ACTIVE_STATES.
    const wantsToRun = FLAG_GATED_STATES.has(bot.state);
    // Bot khối lượng chỉ chạy khi admin bật cho chủ tài khoản (DEC-80).
    if (wantsToRun && VOLUME.has(bot.strategy) && !(await this.#volumeBotsOn(bot.userId))) {
      this.#d.log.warn({ botId: bot.id }, "volume bots are not enabled for this user");
      return undefined;
    }
    // Chiến lược thử nghiệm: AI Adaptive DCA (DEC-107) theo cờ riêng; Copy Trade (DEC-161) theo cờ AI Desk
    // (DEC-192).
    if (
      wantsToRun &&
      (EXPERIMENTAL_STRATEGIES as readonly string[]).includes(bot.strategy) &&
      !(await (bot.strategy === Strategy.adaptiveDca
        ? this.#flagOn(bot.userId, "adaptiveDca")
        : this.#flagOn(bot.userId, "aiDesk")))
    ) {
      this.#d.log.warn({ botId: bot.id }, "experimental strategies are not enabled for this user");
      return undefined;
    }
    const config = entry.schema.parse(version.config);
    // Engine vừa nạp bot (khởi động lại, chuyển shard): tin khớp lúc không có stream đã mất.
    if (bot.strategy === Strategy.volumeFarm) this.onStreamGap(account.id);
    const [saved] = await this.#d.db
      .select()
      .from(botRuntime)
      .where(eq(botRuntime.botId, bot.id))
      .limit(1);
    const builderRate = builderFeeRateFor(bot.strategy, await this.#builderFees(bot.userId));
    const markets = this.#marketsOf(bot.market, config);
    const rules: Record<string, MarketRules> = {};
    for (const m of markets) {
      const rr = await this.#d.rules(m);
      if (rr !== undefined) rules[m] = rr;
    }
    return {
      botId: bot.id,
      account: route.account,
      paper: route.paper,
      gateway: route.gateway,
      shard,
      epoch,
      versionId: version.id,
      version: version.version,
      strategy: bot.strategy,
      builderRate,
      market: bot.market,
      config,
      state: saved?.versionId === version.id ? saved.state : entry.module.initialState(config),
      module: entry.module,
      ctx: {
        botId: bot.id,
        version: version.version,
        rules,
        feeRate: this.#d.feeRate ?? this.#feeRateOf(bot, config, rules, route, builderRate),
        ...(this.#d.feeRate === undefined
          ? { takerFeeRate: this.#feeRateOf(bot, config, rules, route, builderRate, true) }
          : {}),
      },
      awaitingFirstAck: bot.state === BotState.starting,
      leverageSet: false,
      leverageUnknown: false,
      blocked: null,
      reduceRejects: 0,
      makerReduceRejects: 0,
      skipGate: new SkipGate(),
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
    // Copy Trade nhiều market (DEC-163).
    for (const m of copyMarkets(config as Record<string, unknown>)) out.add(m);
    if (c.spotMarket !== undefined) out.add(c.spotMarket);
    if (c.perpMarket !== undefined) out.add(c.perpMarket);
    for (const a of c.assets ?? []) if (a.market !== undefined) out.add(a.market);
    return [...out];
  }

  #watches(r: Runner, market: string): boolean {
    return Object.prototype.hasOwnProperty.call(r.ctx.rules, market);
  }

  async #flagOn(userId: string, flag: "aiDesk" | "adaptiveDca"): Promise<boolean> {
    const [u] = await this.#d.db
      .select({ on: flag === "aiDesk" ? users.aiDesk : users.adaptiveDca })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    return u?.on === true;
  }

  async #volumeBotsOn(userId: string): Promise<boolean> {
    const [u] = await this.#d.db
      .select({ on: users.volumeBots })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    return u?.on === true;
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
    // Tín hiệu leader cũng vậy: bot copy chạy lại thì `leaderPosition` kế tiếp bù phần đã đóng / giảm (DEC-161).
    if (
      !live &&
      (event.type === "tick" ||
        event.type === "timer" ||
        event.type === "leaderFill" ||
        event.type === "leaderPosition")
    )
      return;
    // Bot Perps: đặt đòn bẩy + margin mode trên SoDEX trước khi chiến lược phản ứng với thị trường. Fill / ack /
    // reject vẫn đi qua để sổ cái đúng; nếu chúng sinh lệnh mới thì #execute chặn lần nữa.
    const accounting =
      event.type === "fill" ||
      event.type === "orderAck" ||
      event.type === "orderReject" ||
      event.type === "orderDone" ||
      event.type === "positionSync";
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
    // Bot copy tiền thật: lệnh mở vừa khớp → thêm outbox trong CÙNG transaction (DEC-212).
    const opened = this.#copyAlerts(r, () =>
      openedAlerts(r.botId, r.config, prev, result.state, event),
    );
    await this.#fenced(r, async (tx) => {
      for (const data of opened)
        await tx.insert(outbox).values({
          topic: "jobs.notify",
          payload: {
            sodexAccountId: r.account.id,
            type: "copy_bot_opened",
            data,
            dedupeKey: `copy_bot_opened:${data.botId}:${data.clOrdID}`,
          },
        });
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
    await this.#execute(r, result.actions, event.at, accounting ? null : prev, { event, prev });
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
    // Copy Trade đặt cùng đòn bẩy cho mọi market (DEC-163); chiến lược khác có tối đa một symbol.
    const specs = leverageSpecsOf(r.strategy, r.market, r.config);
    for (const spec of specs) {
      const res = await this.#ensureLeverageOne(r, spec, at);
      if (res !== "ok") {
        r.leverageSet = false;
        return res;
      }
    }
    r.leverageSet = true;
    return "ok";
  }

  async #ensureLeverageOne(
    r: Runner,
    spec: LeverageSpec,
    at: number,
  ): Promise<"ok" | "rejected" | "unknown" | "not_sent"> {
    const what = `${String(spec.leverage)}× ${spec.marginMode} on ${spec.market}`;
    let current: { leverage: number; marginMode: string } | null | undefined;
    let position: { leverage: number; marginMode: string } | null = null;
    try {
      const read = await r.gateway.readLeverage(r.account, spec.market);
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
    const res = await r.gateway.setLeverage(r.account, spec, {
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
        `DeskLabs can't sign with your API key (${code}). Nothing was sent to SoDEX. Renew it in Settings › SoDEX access.`,
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
    /** Sự kiện và state trước bước chiến lược (để biết market của tin `copy_bot_skipped`). */
    source: { event: StrategyEvent; prev: unknown } | null = null,
  ): Promise<void> {
    const places = actions.flatMap((a) => (a.type === "place" ? [a.order] : []));
    const cancels = actions.flatMap((a) => (a.type === "cancel" ? [a.clOrdID] : []));
    for (const a of actions) {
      if (a.type === "log") {
        // Bot copy tiền thật bỏ qua tín hiệu: thêm outbox trong CÙNG transaction ghi bot_events
        // (DEC-212). Tối đa 1 tin / bot / market / 10 phút.
        // market_off (trader giao dịch ở market không có trong bot): chỉ ghi nhật ký, không gửi tin (PM chốt 4b).
        const skipped =
          a.decision === "Skipped" && source !== null && skipReason(a.why) !== "market_off"
            ? this.#copyAlerts(r, () => {
                const market = skipMarket(r.config, source.prev, source.event);
                return r.skipGate.allow(market, at)
                  ? [skippedAlert(r.botId, market, a.why, at)]
                  : [];
              })
            : [];
        await this.#event(r, "decision", a.decision, a.why, at, async (tx) => {
          for (const data of skipped)
            await tx.insert(outbox).values({
              topic: "jobs.notify",
              payload: {
                sodexAccountId: r.account.id,
                type: "copy_bot_skipped",
                data,
                dedupeKey: `copy_bot_skipped:${data.botId}:${data.market ?? "*"}:${String(data.at)}`,
              },
            });
        });
      }
      if (a.type === "flag")
        await this.#fenced(r, (tx) =>
          tx.update(bots).set({ needsAttention: a.needsAttention }).where(eq(bots.id, r.botId)),
        );
    }
    if (cancels.length > 0) await this.#cancel(r, cancels);
    for (const a of actions) if (a.type === "modifyStop") await this.#modifyStop(r, a, at);
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
        const results = await r.gateway.submit(
          r.account,
          toSend,
          { shard: r.shard, epoch: r.epoch },
          r.builderRate,
        );
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
        let reduceRejected: {
          o: OrderIntent;
          res: { code: string; message: string | null };
        } | null = null;
        for (const res of results) {
          if (res.outcome === "ok") {
            const sentOk = toSend.find((o) => o.clOrdID === res.clOrdID);
            if (sentOk?.reduceOnly === true && sentOk.stop === undefined) {
              r.reduceRejects = 0;
              r.makerReduceRejects = 0;
            }
            await this.#fenced(r, async (tx) => {
              const where = and(
                eq(orders.sodexAccountId, r.account.id),
                eq(orders.clOrdId, res.clOrdID),
              );
              await tx
                .update(orders)
                .set({ sodexOrderId: res.orderId, ackedAt: new Date(at) })
                .where(where);
              // User stream có thể đã báo khớp / bị từ chối trước response này: không ghi đè về "open" (DEC-122).
              await tx
                .update(orders)
                .set({ status: "open" })
                .where(and(where, eq(orders.status, "unknown")));
            });
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
                .set({ status: "rejected", rejectCode: res.code, rejectMessage: res.message })
                .where(
                  and(eq(orders.sodexAccountId, r.account.id), eq(orders.clOrdId, res.clOrdID)),
                ),
            );
            const sent = toSend.find((o) => o.clOrdID === res.clOrdID);
            this.#d.log.warn(
              { botId: r.botId, clOrdID: res.clOrdID, code: res.code, message: res.message },
              "order rejected by SoDEX",
            );
            await this.#feed(r, { type: "orderReject", at, clOrdID: res.clOrdID, code: res.code });
            // Stop loss gốc bị từ chối (DEC-118) không phải lệnh đóng thật: chiến lược tự giữ SL, không pause.
            if (sent?.reduceOnly === true && sent.stop === undefined)
              reduceRejected = { o: sent, res };
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
        if (
          reduceRejected !== null &&
          (await this.#reduceOnlyRejected(r, reduceRejected.o, reduceRejected.res, at))
        )
          return;
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
        .innerJoin(bots, eq(bots.id, orders.botId))
        .where(
          and(
            eq(orders.sodexAccountId, r.account.id),
            // Lệnh paper không nằm trên sổ SoDEX: bot thật chỉ so với lệnh thật, bot paper chỉ so với lệnh của chính nó.
            r.paper ? eq(orders.botId, r.botId) : eq(bots.mode, "live"),
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

  /**
   * Lệnh reduce-only bị từ chối: thường do vị thế trên SoDEX đã đóng hoặc nhỏ hơn sổ của bot. Quá
   * `MAX_REDUCE_ONLY_REJECTS` lần liên tiếp thì pause `ORDER_REJECTED` kèm câu lỗi SoDEX. Trả true khi đã pause.
   */
  async #reduceOnlyRejected(
    r: Runner,
    o: OrderIntent,
    res: { code: string; message: string | null },
    at: number,
  ): Promise<boolean> {
    // Lệnh đóng khi Stop chỉ gửi một lần và bot đang dừng: không pause, câu lỗi đã lưu trên dòng lệnh.
    if (o.tag === "close") return false;
    const market = o.type === "market";
    if (market) r.reduceRejects += 1;
    else r.makerReduceRejects += 1;
    const limit = market ? MAX_REDUCE_ONLY_REJECTS : MAX_MAKER_REDUCE_REJECTS;
    if ((market ? r.reduceRejects : r.makerReduceRejects) < limit) return false;
    r.reduceRejects = 0;
    r.makerReduceRejects = 0;
    const sodex =
      res.message === null ? `SoDEX code ${res.code}` : `SoDEX code ${res.code}: ${res.message}`;
    await this.#event(
      r,
      "error",
      `Paused: SoDEX rejected ${String(limit)} reduce-only orders in a row`,
      `Last: ${o.side} ${o.quantity} ${o.market} (${sodex}). Your ${o.market} position on SoDEX may already be closed or smaller than the bot expects. Check Positions on SoDEX before you resume.`,
      at,
    );
    await this.#pauseBot(r, ReasonCode.orderRejected);
    return true;
  }

  async #ack(r: Runner, at: number): Promise<void> {
    if (!r.awaitingFirstAck) return;
    r.awaitingFirstAck = false;
    await this.#transition(r, EngineEvent.confirmedRunning, null);
    await this.#event(
      r,
      "state",
      "Running",
      // Bot paper không gửi gì lên SoDEX: không được ghi là SoDEX đã xác nhận (DEC-105).
      r.paper
        ? "Simulated orders placed. Nothing was sent to SoDEX."
        : "SoDEX acknowledged the first orders.",
      at,
    );
  }

  /**
   * Dời giá kích hoạt của stop loss gốc trên SoDEX (DEC-118). Chỉ gửi khi lệnh còn mở trong sổ của DRIFT. SoDEX từ
   * chối thì báo `orderReject` để chiến lược bỏ stop đó và tự giữ SL; không rõ kết quả thì để lần dời sau gửi lại.
   */
  async #modifyStop(
    r: Runner,
    a: Extract<StrategyAction, { type: "modifyStop" }>,
    at: number,
  ): Promise<void> {
    const [row] = await this.#d.db
      .select()
      .from(orders)
      .where(and(eq(orders.sodexAccountId, r.account.id), eq(orders.clOrdId, a.clOrdID)))
      .limit(1);
    if (row?.status !== "open") return;
    const res = await r.gateway.modifyStop(
      r.account,
      { clOrdID: a.clOrdID, market: row.market, stopPrice: a.stopPrice },
      { shard: r.shard, epoch: r.epoch },
    );
    if (res.outcome === "rejected") {
      this.#d.log.warn(
        { botId: r.botId, clOrdID: a.clOrdID, code: res.code },
        "stop modify rejected by SoDEX",
      );
      await this.#feed(r, { type: "orderReject", at, clOrdID: a.clOrdID, code: res.code });
    }
  }

  async #cancel(r: Runner, clOrdIDs: readonly string[]): Promise<void> {
    const rows = await this.#d.db
      .select()
      .from(orders)
      .where(and(eq(orders.sodexAccountId, r.account.id), inArray(orders.clOrdId, [...clOrdIDs])));
    const open = rows.filter((o) => o.status === "open" || o.status === "partially_filled");
    const pending = this.#pendingCancels.get(r.botId) ?? new Set<string>();
    // Không còn gì mở: bỏ khỏi danh sách chờ huỷ lại.
    for (const id of clOrdIDs) if (!open.some((o) => o.clOrdId === id)) pending.delete(id);
    if (open.length === 0) {
      if (pending.size === 0) this.#pendingCancels.delete(r.botId);
      return;
    }
    let results: Awaited<ReturnType<Gateway["cancel"]>>;
    try {
      results = await r.gateway.cancel(
        r.account,
        open.map((o) => ({ clOrdID: o.clOrdId, market: o.market, engine: o.engine })),
        { shard: r.shard, epoch: r.epoch },
      );
    } catch (error) {
      // Request huỷ không rời DRIFT (signer lỗi…): lệnh vẫn sống trên SoDEX, giữ "open" và thử lại ở vòng sau.
      for (const o of open) pending.add(o.clOrdId);
      this.#pendingCancels.set(r.botId, pending);
      throw error;
    }
    // Huỷ không thành (SoDEX từ chối hoặc không rõ): ghi log để lần ra vì sao lệnh còn sống trên sàn.
    for (const x of results)
      if (x.outcome !== "ok")
        this.#d.log.warn(
          {
            botId: r.botId,
            clOrdID: x.clOrdID,
            outcome: x.outcome,
            code: x.outcome === "rejected" ? x.code : undefined,
            detail: x.outcome === "unknown" ? x.detail : undefined,
          },
          "cancel not confirmed",
        );
    // Binance guard: ghi Decisions lúc SoDEX xác nhận huỷ, kèm khoảng cách từ lúc Binance chạy.
    const guardAt = r.guardAt;
    if (guardAt !== undefined) {
      const done = this.#d.now();
      for (const x of results) {
        if (x.outcome !== "ok") continue;
        const o = open.find((y) => y.clOrdId === x.clOrdID);
        if (o === undefined) continue;
        await this.#event(
          r,
          "decision",
          `${o.side === "sell" ? "Ask" : "Bid"} cancelled`,
          `SoDEX confirmed the cancel at ${clockTime(done)} UTC, ${String(done - guardAt)} ms after the move on Binance.`,
          done,
        );
      }
    }
    // Chỉ coi là đã huỷ khi SoDEX trả lời rõ: ok, hoặc từ chối (lệnh đã khớp / đã huỷ). Không rõ thì thử lại.
    const settled = new Set(results.filter((x) => x.outcome !== "unknown").map((x) => x.clOrdID));
    const done = open.filter((o) => settled.has(o.clOrdId));
    for (const o of open) {
      if (settled.has(o.clOrdId)) pending.delete(o.clOrdId);
      else pending.add(o.clOrdId);
    }
    if (pending.size === 0) this.#pendingCancels.delete(r.botId);
    else this.#pendingCancels.set(r.botId, pending);
    if (done.length > 0)
      await this.#fenced(r, (tx) =>
        tx
          .update(orders)
          .set({ status: "cancelled" })
          .where(
            inArray(
              orders.id,
              done.map((o) => o.id),
            ),
          ),
      );
    // Market Making tính khối lượng còn treo của lệnh đóng cho tới khi SoDEX xác nhận đã gỡ (DEC-100).
    if (r.strategy !== Strategy.volumeMaker) return;
    const at = this.#d.now();
    for (const res of results) {
      const o = open.find((x) => x.clOrdId === res.clOrdID);
      // Đánh dấu đã báo: tin CANCELED tới sau từ user stream không báo lần hai.
      if (res.outcome === "ok" && o !== undefined && (await this.#markDone(r, o.id)))
        await this.#feed(r, { type: "orderDone", at, clOrdID: res.clOrdID });
    }
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
      // Báo team (DEC-184): bot tiền thật vào running sau một lần Start (starting → running; resume không báo).
      // Vốn tính sẵn ở đây (cùng hàm với Strategy Lab); jobs chỉ hiển thị.
      if (!r.paper && b.state === BotState.starting && next === BotState.running) {
        const cap = botCapitalOf(r.strategy, r.config);
        await tx.insert(outbox).values({
          topic: "jobs.team_ops",
          payload: {
            type: "team_bot_started",
            botId: r.botId,
            capital: cap.capital,
            capitalAsset:
              cap.capital === null ? null : cap.capitalUnit === "base" ? assetOf(r.market) : "USDC",
          },
        });
      }
      if (reason !== null)
        await tx.insert(outbox).values({
          topic: "jobs.notify",
          payload: {
            sodexAccountId: r.account.id,
            type: next === "stopped" ? "bot_stopped" : "bot_paused",
            data: { botId: r.botId, reasonCode: reason, ...(r.paper ? { paper: true } : {}) },
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
          data: { botId: r.botId, reasonCode: reason, ...(r.paper ? { paper: true } : {}) },
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
    if (r.strategy === Strategy.copyTrade) {
      // Copy Trade nhiều market (DEC-163): đóng từng market bằng market reduce-only; clOrdID tất định theo thứ tự
      // market trong config, băm từ botId đầy đủ.
      if (close) {
        const positions = copyPositions(normalizeCopyState(r.config as CopyTradeConfig, r.state));
        const markets = copyMarkets(r.config as Record<string, unknown>);
        const closes: StrategyAction[] = markets.flatMap((market, i) => {
          const size = positions[market];
          if (size === undefined || dec(size).isZero()) return [];
          return [
            {
              type: "place" as const,
              order: {
                clOrdID: clOrdId(r.botId, r.version, `close:${String(i)}`),
                market,
                engine: "perps" as const,
                side: dec(size).isPositive() ? ("sell" as const) : ("buy" as const),
                type: "market" as const,
                quantity: dec(size).abs().toString(),
                timeInForce: "IOC" as const,
                reduceOnly: true,
                tag: "close",
              },
            },
          ];
        });
        if (closes.length > 0) await this.#execute(r, closes, this.#d.now());
      }
      close = false;
    }
    // Funding Arb giữ hai sổ cái: chỉ đóng chân perp (rủi ro đòn bẩy); tài sản Spot vẫn ở trong account.
    const st = r.state as { ledger?: { position: string }; perp?: { position: string } };
    const arb = r.strategy === Strategy.fundingArb;
    const ledger = arb ? st.perp : st.ledger;
    if (close && ledger !== undefined && !dec(ledger.position).isZero()) {
      const qty = dec(ledger.position).abs().toString();
      const engine = arb ? "perps" : this.#engineOf(r);
      // Băm botId đầy đủ (DEC-186): 8 ký tự đầu của uuidv7 là thời gian, nên bot tạo trong cùng ~65 s
      // từng có chung mã "<8 ký tự>-close-1" và lệnh đóng của bot thứ hai bị bỏ qua (unique theo account + clOrdID).
      const id = clOrdId(r.botId, r.version, "close");
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
      // Báo team (DEC-184): bot tiền thật vào running sau một lần Start (starting → running; resume không báo).
      // Vốn tính sẵn ở đây (cùng hàm với Strategy Lab); jobs chỉ hiển thị.
      if (!r.paper && b.state === BotState.starting && next === BotState.running) {
        const cap = botCapitalOf(r.strategy, r.config);
        await tx.insert(outbox).values({
          topic: "jobs.team_ops",
          payload: {
            type: "team_bot_started",
            botId: r.botId,
            capital: cap.capital,
            capitalAsset:
              cap.capital === null ? null : cap.capitalUnit === "base" ? assetOf(r.market) : "USDC",
          },
        });
      }
      if (reason !== null)
        await tx.insert(outbox).values({
          topic: "jobs.notify",
          payload: {
            sodexAccountId: r.account.id,
            type: next === "stopped" ? "bot_stopped" : "bot_paused",
            data: { botId: r.botId, reasonCode: reason, ...(r.paper ? { paper: true } : {}) },
          },
        });
    });
    this.#runners.delete(r.botId);
  }

  /** Engine của lệnh đóng khi Stop: Futures Grid / DCA, Volume Maker / Farm và TWAP chạy Perps đều là Perps. */
  #engineOf(r: Runner): "spot" | "perps" {
    return engineOfBot(r.strategy, r.config);
  }

  /** Phí một chiều của bot (DEC-112); account builder chạy live không chịu builder fee. */
  #feeRateOf(
    bot: typeof bots.$inferSelect,
    config: unknown,
    rules: Record<string, MarketRules>,
    route: { account: AccountRef; paper: boolean },
    builderRate: number,
    taker = false,
  ): string {
    const own =
      !route.paper &&
      this.#d.builderId !== undefined &&
      isBuilderAccount(route.account.sodexAccountId, this.#d.builderId, this.#d.builderExempt);
    return (taker ? botTakerFeeRate : botFeeRate)(
      bot.strategy,
      config,
      rules[bot.market],
      own,
      builderRate,
    );
  }

  /** Builder fee riêng team đặt cho user (DEC-159). */
  async #builderFees(userId: string): Promise<BuilderFeeOverrides> {
    return (await this.#builderFeesOf([userId])).get(userId) ?? {};
  }

  /** Như `#builderFees` cho nhiều user trong một truy vấn (mỗi vòng `#syncBots`). */
  async #builderFeesOf(userIds: readonly string[]): Promise<Map<string, BuilderFeeOverrides>> {
    const out = new Map<string, Record<string, number>>();
    if (userIds.length === 0) return out;
    const rows = await this.#d.db
      .select()
      .from(userBuilderFees)
      .where(inArray(userBuilderFees.userId, [...new Set(userIds)]));
    for (const r of rows) out.set(r.userId, { ...out.get(r.userId), [r.strategy]: r.rate });
    return out;
  }

  async #event(
    r: Runner,
    type: string,
    decision: string,
    why: string,
    at: number,
    /** Ghi thêm trong cùng transaction (outbox cảnh báo bot copy, DEC-212). */
    also?: (tx: Db) => Promise<void>,
  ): Promise<void> {
    await this.#fenced(r, async (tx) => {
      await tx
        .insert(botEvents)
        .values({ botId: r.botId, type, decision, why, occurredAt: new Date(at) });
      if (also !== undefined) await also(tx);
    });
  }

  /**
   * Dựng dữ liệu cảnh báo bot copy (DEC-212): chỉ bot copy tiền thật; bot paper không bao giờ có tin.
   * Không bao giờ ném lỗi ra transaction đang ghi: lỗi thì log warn (không dữ liệu nhạy cảm) và bỏ tin (PM điều kiện ii).
   */
  #copyAlerts<T>(r: Runner, build: () => T[]): T[] {
    if (r.paper || r.strategy !== Strategy.copyTrade) return [];
    try {
      return build();
    } catch (err) {
      this.#d.log.warn(
        { botId: r.botId, err: err instanceof Error ? err.name : "unknown" },
        "copy bot alert dropped",
      );
      return [];
    }
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
      const found = await r.gateway.lookup(r.account, {
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

  /**
   * Lệnh còn `open` trong DRIFT mà không ai cập nhật được (DEC-85): bot đã dừng (không còn runner, user stream có
   * thể đã đóng ngay sau lệnh đóng vị thế của Stop), hoặc lệnh market (IOC không thể nằm trên sổ, SoDEX không báo
   * khi hết hạn mà chưa khớp). Đọc trạng thái thật từ SoDEX, ghi fill, cập nhật sổ cái và PnL của bot.
   */
  async #reconcileOpen(shard: number): Promise<void> {
    const held = this.#leases.get(shard);
    if (held === undefined) return;
    const now = this.#d.now();
    // Chỉ lệnh của bot thật: lệnh paper không bao giờ được đối soát với SoDEX (DEC-105).
    const rows = (
      await this.#d.db
        .select({ order: orders })
        .from(orders)
        .innerJoin(bots, eq(bots.id, orders.botId))
        .where(
          and(
            eq(bots.mode, "live"),
            inArray(orders.status, ["open", "partially_filled"]),
            lt(orders.submittedAt, new Date(now - RECONCILE_AFTER_MS)),
          ),
        )
        .orderBy(orders.submittedAt)
    ).map((x) => x.order);
    const gap = (accountId: string) =>
      now - (this.#streamGaps.get(accountId) ?? Number.NEGATIVE_INFINITY) < STREAM_GAP_MS;
    // Lệnh bot đã gửi huỷ mà SoDEX chưa xác nhận (kết quả "unknown"): đọc trạng thái thật thay vì huỷ lại mãi.
    // Không thì lệnh kẹt "open" trong DRIFT và chặn lệnh ngược chiều như self-trade (DEC-121).
    const cancelling = (o: { botId: string; clOrdId: string }) =>
      this.#pendingCancels.get(o.botId)?.has(o.clOrdId) === true;
    const open = rows.filter((o) => {
      const r = this.#runners.get(o.botId);
      return (
        o.type === "market" ||
        r === undefined ||
        cancelling(o) ||
        (r.strategy === Strategy.volumeFarm && gap(o.sodexAccountId))
      );
    });
    // Lệnh Volume Farm DRIFT tự huỷ nhưng chưa xác nhận: có thể đã khớp ngay trước lúc huỷ.
    const unconfirmed = (
      await this.#d.db
        .select({ order: orders })
        .from(orders)
        .innerJoin(bots, eq(bots.id, orders.botId))
        .where(
          and(
            eq(orders.status, "cancelled"),
            eq(bots.mode, "live"),
            eq(bots.strategy, Strategy.volumeFarm),
            isNull(orders.reconciledAt),
            gt(orders.submittedAt, new Date(now - UNCONFIRMED_CANCEL_MS)),
          ),
        )
    )
      .map((x) => x.order)
      .filter((o) => gap(o.sodexAccountId));
    // Lệnh kiểm lâu nhất trước (chưa kiểm = 0), rồi lệnh cũ nhất (DEC-185). Xếp theo `submittedAt`
    // không thôi thì ≥ OPEN_CHECK_BATCH lệnh vẫn treo trên SoDEX (bot đang pause giữ lệnh) chiếm hết suất mỗi vòng, và
    // lệnh mới hơn (ví dụ lệnh đóng vị thế của bot vừa Stop) không bao giờ được đối soát: fill thật không được ghi.
    const lastCheck = (o: { id: string }) => this.#openChecks.get(o.id) ?? 0;
    const due = [...open, ...unconfirmed]
      .filter((o) => now - lastCheck(o) >= OPEN_CHECK_MS)
      .sort(
        (a, b) =>
          lastCheck(a) - lastCheck(b) ||
          (a.submittedAt?.getTime() ?? 0) - (b.submittedAt?.getTime() ?? 0),
      );
    if (due.length === 0) return;
    const accounts = new Map((await this.#accountsInShard(shard)).map((a) => [a.id, a]));
    let checked = 0;
    for (const o of due) {
      const account = accounts.get(o.sodexAccountId);
      if (account === undefined) continue;
      if (checked >= OPEN_CHECK_BATCH) break;
      checked += 1;
      this.#openChecks.set(o.id, now);
      const ref = { clOrdID: o.clOrdId, market: o.market, engine: o.engine };
      const found = await this.#d.gateway.lookup(account, ref);
      if (found.status === "open") continue;
      if (found.status === "not_found") {
        // Stop loss gốc đã được SoDEX nhận (DEC-118) mà không còn: SoDEX huỷ nó khi vị thế đóng. Lệnh market
        // khác không bao giờ treo "open", nên lệnh market còn open trong sổ chỉ có thể là stop.
        if (o.type === "market" && o.status === "open" && o.sodexOrderId !== null) {
          await this.#fenced({ shard, epoch: held.epoch }, (tx) =>
            tx
              .update(orders)
              .set({ status: "cancelled", reconciledAt: new Date(now) })
              .where(eq(orders.id, o.id)),
          );
          this.#openChecks.delete(o.id);
          await this.onOrderClosed(o.sodexAccountId, o.clOrdId, "cancelled", now);
          continue;
        }
        // Ngoài 500 lệnh lịch sử gần nhất: không suy đoán kết quả, chuyển sang Failed & unknown để người dùng thấy.
        // Lệnh bot đã gửi huỷ: không còn trong lệnh mở của SoDEX nên không thể khớp nữa, ghi là đã huỷ.
        if (now - (o.submittedAt?.getTime() ?? now) < NOT_FOUND_AFTER_MS) continue;
        const wasCancelling = cancelling(o);
        await this.#fenced({ shard, epoch: held.epoch }, (tx) =>
          tx
            .update(orders)
            .set({
              status: o.status === "cancelled" || wasCancelling ? "cancelled" : "unknown",
              reconciledAt: new Date(now),
            })
            .where(eq(orders.id, o.id)),
        );
        if (wasCancelling) this.#pendingCancels.get(o.botId)?.delete(o.clOrdId);
        continue;
      }
      const expected = cancelling(o);
      await this.#settleOrder(shard, held.epoch, account, o, found, now, expected);
      this.#pendingCancels.get(o.botId)?.delete(o.clOrdId);
      this.#openChecks.delete(o.id);
    }
  }

  /**
   * Market Making (DEC-100). (1) Fill của mọi lệnh bot đã gửi trong 10 phút, kể cả lệnh đã huỷ / thay: đọc lịch sử
   * khớp của SoDEX, phần chưa ghi đi qua `onFill` (tính theo `filledSize` nên mỗi phần chỉ được tính một lần).
   * (2) Vị thế thật trên SoDEX gửi cho chiến lược bằng `positionSync`, chỉ khi đây là bot duy nhất của account
   * trên market đó; nếu không thì không chia được vị thế giữa các bot.
   */
  /** Thử huỷ lại các lệnh mà lần huỷ trước chưa được SoDEX xác nhận (DEC-111). */
  async #retryCancels(shard: number): Promise<void> {
    const now = this.#d.now();
    for (const r of [...this.#runners.values()].filter((x) => x.shard === shard)) {
      const pending = this.#pendingCancels.get(r.botId);
      if (pending === undefined || pending.size === 0) continue;
      if (now - (this.#cancelRetryAt.get(r.botId) ?? 0) < CANCEL_RETRY_MS) continue;
      this.#cancelRetryAt.set(r.botId, now);
      try {
        await this.#cancel(r, [...pending]);
      } catch (error) {
        if (error instanceof FencedError) throw error;
        this.#d.log.warn({ err: error, botId: r.botId }, "cancel retry failed");
      }
    }
  }

  /**
   * Market Making: lệnh còn "open" trong DRIFT quá `MAKER_ORPHAN_MS` mà chiến lược không còn coi là đang sống (ví dụ
   * lần huỷ trước không gửi được rồi chiến lược đã bỏ theo dõi) thì huỷ. Lệnh mồ côi như vậy làm kiểm tra self-trade
   * chặn mọi báo giá ngược chiều (DEC-111). Lưới an toàn bền qua khởi động lại vì đọc từ DB và state đã lưu.
   */
  async #sweepMakerOrphans(r: Runner, now: number): Promise<void> {
    const tracked = (r.state as { orders?: Record<string, { status?: string }> }).orders ?? {};
    const open = await this.#d.db
      .select({ clOrdId: orders.clOrdId })
      .from(orders)
      .where(
        and(
          eq(orders.botId, r.botId),
          inArray(orders.status, ["open", "partially_filled"]),
          lt(orders.submittedAt, new Date(now - MAKER_ORPHAN_MS)),
        ),
      );
    const orphans = open.map((o) => o.clOrdId).filter((id) => tracked[id]?.status !== "live");
    if (orphans.length === 0) return;
    await this.#event(
      r,
      "reconcile",
      `Cancelled ${String(orphans.length)} untracked order${orphans.length === 1 ? "" : "s"}`,
      "An earlier cancel did not go through; the order was still open, so the bot cancelled it.",
      now,
    );
    await this.#cancel(r, orphans);
  }

  async #reconcileMaker(shard: number): Promise<void> {
    const now = this.#d.now();
    const makers = [...this.#runners.values()].filter(
      (r) => r.shard === shard && r.strategy === Strategy.volumeMaker && !r.paper,
    );
    for (const r of makers) {
      const key = `${r.account.id}:${r.market}`;
      if (now - (this.#makerBackfill.get(key) ?? 0) >= MAKER_BACKFILL_MS) {
        this.#makerBackfill.set(key, now);
        await this.#backfillMaker(r, now);
        await this.#sweepMakerOrphans(r, now).catch((error: unknown) => {
          if (error instanceof FencedError) throw error;
          this.#d.log.warn({ err: error, botId: r.botId }, "orphan sweep failed");
        });
      }
      if (now - (this.#makerPosition.get(key) ?? 0) >= MAKER_POSITION_MS) {
        this.#makerPosition.set(key, now);
        await this.#syncMakerPosition(r, now);
      }
    }
  }

  async #backfillMaker(r: Runner, now: number): Promise<void> {
    const sent = await this.#d.db
      .select()
      .from(orders)
      .where(
        and(
          eq(orders.sodexAccountId, r.account.id),
          eq(orders.market, r.market),
          gt(orders.submittedAt, new Date(now - MAKER_BACKFILL_WINDOW_MS)),
        ),
      );
    if (sent.length === 0) return;
    const byId = new Map(sent.map((o) => [o.clOrdId, o]));
    const trades = (
      await r.gateway.recentTrades(r.account, { market: r.market, engine: "perps" })
    ).filter((t) => byId.has(t.clOrdID));
    if (trades.length === 0) return;
    const recorded = new Set(
      (
        await this.#d.db
          .select({ tradeId: fills.sodexTradeId })
          .from(fills)
          .where(
            inArray(
              fills.orderId,
              sent.map((o) => o.id),
            ),
          )
      ).map((f) => String(f.tradeId)),
    );
    const byOrder = new Map<string, typeof trades>();
    for (const t of trades) byOrder.set(t.clOrdID, [...(byOrder.get(t.clOrdID) ?? []), t]);
    for (const [clOrdID, list] of byOrder) {
      const o = byId.get(clOrdID);
      if (o === undefined) continue;
      const total = list.reduce((a, t) => a.add(t.quantity), dec("0"));
      if (!total.gt(o.filledSize)) continue;
      const value = list.reduce((a, t) => a.add(dec(t.price).mul(t.quantity)), dec("0"));
      const fresh = list.filter((t) => !recorded.has(String(t.tradeId)));
      for (const t of fresh) await this.onTrade(r.account.id, t);
      const fee = fresh.reduce((a, t) => a.add(t.fee), dec("0"));
      await this.onFill(
        r.account.id,
        clOrdID,
        total.toString(),
        value.div(total).toString(),
        fee.toString(),
        now,
      );
    }
  }

  async #syncMakerPosition(r: Runner, now: number): Promise<void> {
    const others = await this.#d.db
      .select({ id: bots.id })
      .from(bots)
      .where(
        and(
          eq(bots.sodexAccountId, r.account.id),
          eq(bots.market, r.market),
          eq(bots.mode, "live"),
          inArray(bots.state, [
            BotState.starting,
            BotState.running,
            BotState.pausing,
            BotState.paused,
            BotState.resuming,
            BotState.stopping,
          ]),
        ),
      );
    if (others.some((b) => b.id !== r.botId)) return;
    const pos = await r.gateway.readPosition(r.account, r.market);
    await this.#feed(r, {
      type: "positionSync",
      at: now,
      market: r.market,
      size: pos?.size ?? "0",
      entryPrice: pos?.entryPrice ?? "0",
    });
  }

  async #settleOrder(
    shard: number,
    epoch: number,
    account: AccountRef,
    o: typeof orders.$inferSelect,
    found: Extract<LookupResult, { filledQty: string }>,
    now: number,
    /** Bot đã gửi huỷ lệnh này: SoDEX huỷ đúng như vậy thì không ghi Decisions. */
    cancelRequested = false,
  ): Promise<void> {
    const delta = sub(found.filledQty, o.filledSize);
    let fee = dec("0");
    if (delta.gt(0)) {
      const trades = await this.#d.gateway.tradesOf(account, {
        clOrdID: o.clOrdId,
        market: o.market,
        engine: o.engine,
      });
      for (const t of trades) {
        await this.onTrade(account.id, { ...t, clOrdID: o.clOrdId });
        fee = fee.add(t.fee);
      }
    }
    const avg = found.avgPrice ?? o.avgPrice;
    const r = this.#runners.get(o.botId);
    if (r !== undefined && delta.gt(0) && avg !== null) {
      await this.onFill(account.id, o.clOrdId, found.filledQty, avg, fee.toString(), now);
    }
    await this.#fenced({ shard, epoch }, async (tx) => {
      await tx
        .update(orders)
        .set({
          status: found.status,
          filledSize: found.filledQty,
          avgPrice: avg,
          reconciledAt: new Date(now),
        })
        .where(eq(orders.id, o.id));
      // Huỷ đúng như dự kiến thì không ghi Decisions, nếu không mỗi lượt Volume Farm thêm một dòng. Stop loss gốc
      // SoDEX tự huỷ khi vị thế đóng (DEC-119) cũng là bình thường.
      const stopGone = o.type === "market" && found.status === "cancelled" && !delta.gt(0);
      const asked = cancelRequested && found.status === "cancelled" && !delta.gt(0);
      if (!stopGone && !asked && (delta.gt(0) || o.status !== "cancelled")) {
        await tx.insert(botEvents).values({
          botId: o.botId,
          type: "reconcile",
          decision: `Order ${found.status}`,
          why: `${o.clOrdId}: confirmed from SoDEX (${found.filledQty} filled).`,
          occurredAt: new Date(now),
        });
      }
      if (r !== undefined || !delta.gt(0) || avg === null) return;
      // Bot đã dừng: không còn chiến lược để nhận fill, ghi thẳng vào sổ cái để PnL đúng.
      const [rt] = await tx
        .select({ state: botRuntime.state })
        .from(botRuntime)
        .where(eq(botRuntime.botId, o.botId))
        .limit(1);
      const state = rt?.state as
        (Record<string, unknown> & { ledger?: Ledger; perp?: Ledger; spot?: Ledger }) | undefined;
      if (state === undefined) return;
      if (isMultiMarketCopyState(state)) {
        // Copy Trade nhiều market (DEC-163): sổ cái nằm trong `markets[market]`.
        const slot = state.markets[o.market];
        if (slot === undefined) return;
        await tx
          .update(botRuntime)
          .set({
            state: {
              ...state,
              markets: {
                ...state.markets,
                [o.market]: { ...slot, ledger: applyFill(slot.ledger, o.side, avg, delta, fee) },
              },
            },
            updatedAt: new Date(now),
          })
          .where(eq(botRuntime.botId, o.botId));
        return;
      }
      const key = state.ledger !== undefined ? "ledger" : o.engine === "perps" ? "perp" : "spot";
      const ledger = state[key];
      if (ledger === undefined) return;
      await tx
        .update(botRuntime)
        .set({
          state: {
            ...state,
            [key]: applyFill(ledger, o.side, avg, delta, fee),
            // Khối lượng tính cả lệnh mở và lệnh đóng: lệnh đóng khi Stop cũng vào volume của phiên.
            ...(typeof state.volume === "string"
              ? { volume: dec(state.volume).add(delta.mul(avg)).toString() }
              : {}),
          },
          updatedAt: new Date(now),
        })
        .where(eq(botRuntime.botId, o.botId));
    });
    // Lệnh đã kết thúc trên SoDEX: báo chiến lược một lần (sau fill ở trên, cùng hàng đợi của lệnh).
    if (
      r !== undefined &&
      (found.status === "filled" || found.status === "cancelled" || found.status === "rejected")
    )
      await this.onOrderClosed(account.id, o.clOrdId, found.status, now);
  }

  /** Approval phí khác 50 → pause mọi bot của account (quy tắc 1.5), xử lý ở engine. */
  async #checkFees(shard: number): Promise<void> {
    const now = this.#d.now();
    const accounts = await this.#accountsInShard(shard);
    for (const account of accounts) {
      if (now - (this.#lastFeeCheck.get(account.id) ?? 0) < this.#d.feeCheckMs) continue;
      this.#lastFeeCheck.set(account.id, now);
      // Một account đọc lỗi (SoDEX lỗi, account không còn) không được làm hỏng cả vòng của shard: các bot khác cùng
      // shard vẫn phải chạy. Không đọc được thì chưa pause, thử lại ở lần kiểm tra sau (DEC-113).
      const approved = await this.#d.gateway.builderApproved(account).catch((error: unknown) => {
        this.#d.log.warn({ err: error, accountId: account.id }, "builder fee check failed");
        return null;
      });
      if (approved !== false) continue;
      await this.pauseAccount(account.id, ReasonCode.builderFeeRevoked);
    }
  }

  /** Pause mọi bot đang chạy của account theo reason phạm vi account. Lệnh đang mở được giữ. */
  async pauseAccount(accountId: string, reason: Reason): Promise<number> {
    if (REASON_CODE_META[reason].scope !== "account")
      throw new RangeError("Not an account-scoped reason");
    let count = 0;
    // Lý do phạm vi account (builder fee, API key, giới hạn rủi ro của tiền thật) không áp cho bot paper (DEC-105).
    for (const r of [...this.#runners.values()].filter(
      (x) => x.account.id === accountId && !x.paper,
    )) {
      await this.#pauseBot(r, reason);
      count += 1;
    }
    return count;
  }
}
