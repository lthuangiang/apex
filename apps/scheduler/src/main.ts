import { randomUUID } from "node:crypto";

import {
  builderBalanceSnapshots,
  createDb,
  createSodexCallSink,
  ensureResearchWalletSet,
  leaderboardRuns,
  marketStatsDaily,
  RESEARCH_WALLETS_MAX_K,
} from "@drift/db";
import { HyperliquidClient } from "@drift/hyperliquid";
import { Lease, runAsLeader } from "@drift/runtime";
import {
  AppError,
  ErrorCode,
  SR_BOOK_REQUEST_SUBJECT,
  SR_BOOK_REQUEST_TIMEOUT_MS,
  SR_MARKETS_KEY,
  srMarketsSnapshot,
} from "@drift/shared";
import {
  createSodexCallRecorder,
  loadSodexConfig,
  RedisRateLimitStore,
  SodexRestClient,
} from "@drift/sodex";
import { connect, RequestError, TimeoutError, type NatsConnection } from "@nats-io/transport-node";
import { count, eq } from "drizzle-orm";
import { Redis } from "ioredis";
import pino from "pino";
import { getAddress } from "viem";
import { z } from "zod";

import { reconcileDay, snapshotBuilderBalances } from "./builder-revenue";
import { purgeOldDeskAiChats, queueDueRecords, sweepStaleDeskJobs } from "./desk-record";
import { FEE_TIER_REFRESH_MS, refreshFeeTiers } from "./fee-tiers";
import { checkProdInvariants, redisInvariantStore } from "./invariants";
import { leaderboardDue, noteMinHoldChanges, runLeaderboard } from "./leaderboard";
import { computeDailyStats, utcDate } from "./market-stats";
import { checkMcpAlerts, redisAlertStore } from "./mcp-alerts";
import { purgeMcp } from "./mcp-purge";
import { fitMmModelDaily } from "./mm-model";
import { snapshotAndCheck } from "./risk";
import {
  createSignalResearch,
  disabledReason,
  monthlyLimitWarning,
  scheduleNewsCycle,
  parseSignalEnv,
  type PerpsSymbolInfo,
} from "./signal-research";
import { NEWS_SIGNAL_SUBJECT } from "./signal-research/news-signals";
import { requestRestBook } from "./signal-research/prices";
import { runSnapshotRetention } from "./snapshot-retention";
import { checkNewMarkets, outboxEmitter, redisSeenStore } from "./sr-new-markets";
import { redisIncidentReadStore, teamIncidentRunner } from "./team-incidents";

// scheduler: một bản active (leader lease). Hiện có job market stats hằng ngày; các job lịch khác
// (recurring buy, reset daily loss, nhắc key hết hạn) thêm ở phase của chúng.

const env = z
  .object({
    DATABASE_URL: z.string().min(1),
    REDIS_URL: z.string().min(1),
    LOG_LEVEL: z.string().default("info"),
    SODEX_EGRESS_KEY: z.string().default("default"),
    /** Copy Trading T2 (DEC-163): bật thì tính lại leaderboard Hyperliquid mỗi đêm. */
    COPY_LEADERBOARD_ENABLED: z
      .enum(["true", "false"])
      .default("false")
      .transform((v) => v === "true"),
    /** Giờ UTC bắt đầu lượt hằng ngày (rải ban đêm). */
    COPY_LEADERBOARD_HOUR_UTC: z.coerce.number().int().min(0).max(23).default(1),
    /**
     * Signal research H1 (#353): số ví nghiên cứu (top-K tab Top của leaderboard) marketdata poll, dùng chung trần poll T1
     * (≤ 40). 30 × 1 lần đọc `userFillsByTime` (weight 20) / 2 phút ≈ 300 weight / phút trên 1.200 / phút của IP. 0 = tắt.
     */
    // Sai giá trị thì dùng mặc định, không bao giờ làm scheduler dừng (như các biến SIGNAL_* khác, DEC-322).
    SIGNAL_RESEARCH_WALLETS_K: z.coerce
      .number()
      .int()
      .min(0)
      .max(RESEARCH_WALLETS_MAX_K)
      .default(30)
      .catch(30),
    /** Ví builder của DRIFT (đối soát builder revenue); trống thì bỏ qua đối soát. */
    DRIFT_BUILDER_ADDRESS: z
      .string()
      .regex(/^0x[0-9a-fA-F]{40}$/)
      .optional()
      .or(z.literal("").transform(() => undefined)),
    /** NATS cho giá tốt nhất SoDEX (`md.*.book`) của Signal research; trống = chỉ dùng Redis / DB. */
    NATS_URL: z.string().default(""),
  })
  .parse(process.env);
const log = pino({ level: env.LOG_LEVEL, base: { service: "scheduler" } });
// SoDEX Debugger (DEC-309): ghi mọi lời gọi SoDEX (hàng đợi trong bộ nhớ, pool DB riêng, không chặn).
const sodexCalls = createSodexCallRecorder({
  service: "scheduler",
  env: process.env,
  log,
  sink: () => createSodexCallSink(env.DATABASE_URL),
});
const recorder = sodexCalls === undefined ? {} : { recorder: sodexCalls };
const { db, pool } = createDb(env.DATABASE_URL);
const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 2 });
const mcpAlertStore = redisAlertStore(redis);
const invariantStore = redisInvariantStore(redis);
const newMarkets = { store: redisSeenStore(redis), emit: outboxEmitter(db) };
const teamIncidents = teamIncidentRunner(db, redisIncidentReadStore(redis), (msg, data) => {
  log.warn(data, msg);
});

/** Bất biến tiền thật (DEC-274): chỉ đọc DB, không gọi SoDEX; hai lượt không chạy chồng nhau. */
let invariantRunning = false;
async function invariantTick() {
  if (invariantRunning) return;
  invariantRunning = true;
  try {
    const r = await checkProdInvariants(db, invariantStore);
    // Chỉ log info khi có tin hoặc chạy chậm (> 2 s); còn lại debug.
    if (r.queued > 0 || r.ms > 2_000) log.info(r, "prod invariants checked");
    else log.debug(r, "prod invariants checked");
  } finally {
    invariantRunning = false;
  }
}
const rest = new SodexRestClient({
  ...recorder,
  config: loadSodexConfig(process.env),
  rateLimit: new RedisRateLimitStore(redis),
  egressKey: env.SODEX_EGRESS_KEY,
  priority: "background",
});
// Risk engine và đối soát: mức tương tác (an toàn tiền của người dùng), không bị job thống kê chặn.
const riskRest = new SodexRestClient({
  ...recorder,
  config: loadSodexConfig(process.env),
  rateLimit: new RedisRateLimitStore(redis),
  egressKey: env.SODEX_EGRESS_KEY,
});

// Hyperliquid chỉ đọc; bucket chung theo IP với marketdata (DEC-163 mục 10).
const hl = new HyperliquidClient({
  limiter: new RedisRateLimitStore(redis),
  bucketKey: `hl:ip:${env.SODEX_EGRESS_KEY}`,
});

async function wait<T>(read: () => Promise<T>): Promise<T> {
  for (let i = 0; ; i += 1) {
    try {
      return await read();
    } catch (error) {
      if (!(error instanceof AppError) || error.code !== ErrorCode.rateLimited || i >= 10)
        throw error;
      await new Promise((r) => setTimeout(r, Number(error.details.retryAfterMs ?? 1000)));
    }
  }
}

async function prices(markets: readonly string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const keys = [...new Set(markets)];
  if (keys.length === 0) return out;
  const raw = await redis.mget(...keys.map((m) => `md:last:${m}`));
  keys.forEach((m, i) => {
    const v = raw[i];
    if (v == null) return;
    const parsed = z.object({ price: z.string() }).safeParse(JSON.parse(v));
    if (parsed.success) out[m] = parsed.data.price;
  });
  return out;
}

/** Đọc SoDEX cho risk / revenue: chạm giới hạn tốc độ thì chờ rồi đọc lại (chỉ đọc, an toàn khi lặp). */
const patient = {
  getSpotBalances: (...a: Parameters<SodexRestClient["getSpotBalances"]>) =>
    wait(() => riskRest.getSpotBalances(...a)),
  getPerpsAccountState: (...a: Parameters<SodexRestClient["getPerpsAccountState"]>) =>
    wait(() => riskRest.getPerpsAccountState(...a)),
};

async function riskTick() {
  const r = await snapshotAndCheck({ db, rest: patient, prices, now: () => Date.now() });
  if (r.paused > 0) log.warn(r, "risk limits paused bots");
}

async function revenueTick() {
  if (env.DRIFT_BUILDER_ADDRESS === undefined) return;
  const today = utcDate(Date.now());
  const [{ n } = { n: 0 }] = await db
    .select({ n: count() })
    .from(builderBalanceSnapshots)
    .where(eq(builderBalanceSnapshots.date, today));
  if (n > 0) return;
  await snapshotBuilderBalances({
    db,
    rest: patient,
    builderAddress: getAddress(env.DRIFT_BUILDER_ADDRESS),
    now: () => Date.now(),
  });
  await reconcileDay(db, utcDate(Date.now() - 86_400_000));
  log.info({ date: today }, "builder balances snapshotted, yesterday reconciled");
}

/** #353: tập ví nghiên cứu theo lần xếp hạng `ok` gần nhất; chỉ tạo version mới khi có leaderboard mới hoặc đổi K. */
async function researchWalletsTick() {
  const set = await ensureResearchWalletSet(db, env.SIGNAL_RESEARCH_WALLETS_K, Date.now());
  if (set?.created === true)
    log.info(
      { version: set.version, runDate: set.runDate, k: set.k, size: set.size },
      "signal research: research wallet set updated",
    );
}

let leaderboardBusy = false;
async function leaderboardTick() {
  // Kể cả khi tắt lượt leaderboard (dữ liệu xếp hạng có sẵn vẫn dùng được).
  await researchWalletsTick().catch((error: unknown) => {
    log.warn({ err: error }, "signal research: research wallet set failed");
  });
  if (!env.COPY_LEADERBOARD_ENABLED || leaderboardBusy) return;
  const now = Date.now();
  if (new Date(now).getUTCHours() < env.COPY_LEADERBOARD_HOUR_UTC) return;
  const [run] = await db
    .select({ status: leaderboardRuns.status, updatedAt: leaderboardRuns.updatedAt })
    .from(leaderboardRuns)
    .where(eq(leaderboardRuns.date, utcDate(now)));
  if (!leaderboardDue(run, now)) return;
  leaderboardBusy = true;
  try {
    const r = await runLeaderboard({
      db,
      hl,
      sodexMarkets: async () =>
        (await wait(() => rest.getPerpsSymbols()))
          .filter((m) => m.status === "TRADING")
          .map((m) => m.name),
      now: () => Date.now(),
    });
    log.info(
      { status: r.status, candidates: r.candidates, computed: r.computed, failed: r.failed.length },
      "leaderboard computed",
    );
    if (r.status === "ok") {
      await noteMinHoldChanges(db, utcDate(now), Date.now());
      await researchWalletsTick();
    }
  } finally {
    leaderboardBusy = false;
  }
}

/**
 * Danh sách perps của SoDEX, dùng chung cho `mmModelTick` (vòng 10 phút) và Signal research. Đi qua cache TTL của cùng
 * `rest` (`MARKET_INFO_TTL_MS`), nên lần đọc khi nhận lease và `mmModelTick` ngay sau đó là một lời gọi REST.
 * #305: mỗi lần đọc được thì ghi bản chụp vào Redis `sr:markets` cho picker / kiểm tài sản của API Signal research (API
 * không chạm SoDEX, DEC-322 / DEC-327). Ghi lỗi chỉ log: API thấy bản chụp cũ (`stale`) hoặc thiếu.
 * #311: cùng danh sách đó, market mới chưa có trong asset map → báo team một lần (không thêm lời gọi SoDEX). Chỉ chạy
 * trên tiến trình giữ lease (loadPerps chỉ được gọi từ onLead / timer của leader); lỗi chỉ log, không chặn caller.
 */
let perpsCache: PerpsSymbolInfo[] | null = null;
async function loadPerps() {
  const symbols = await wait(() => rest.getPerpsSymbols());
  perpsCache = symbols.map((m) => ({
    name: m.name,
    status: m.status,
    tickSize: m.tickSize,
    takerFee: m.takerFee,
    stepSize: m.stepSize,
    minQuantity: m.minQuantity,
    minNotional: m.minNotional,
  }));
  try {
    await redis.set(SR_MARKETS_KEY, JSON.stringify(srMarketsSnapshot(symbols, new Date())));
  } catch (error: unknown) {
    log.warn({ err: error }, "signal research: could not write the SoDEX market list to Redis");
  }
  void checkNewMarkets(
    newMarkets,
    symbols.map((m) => m.name),
  )
    .then((r) => {
      if (r.status === "seeded") log.info(r, "signal research: SoDEX market baseline recorded");
      else if (r.status === "checked" && r.alerted.length > 0)
        log.info(r, "signal research: new SoDEX markets queued for the team");
    })
    .catch((error: unknown) => {
      log.warn({ err: error }, "signal research: new market check failed");
    });
  return symbols;
}

/** Fit hệ số mô hình chi phí Market Making cho ngày hôm qua (DEC-228); tự bỏ qua nếu đã fit. */
async function mmModelTick() {
  const symbols = await loadPerps();
  const ticks = new Map(symbols.map((m) => [m.name, m.tickSize] as const));
  const r = await fitMmModelDaily(db, ticks, Date.now());
  if (r.status !== "skipped") log.info(r, "mm cost model fitted");
}

/** Builder fee theo bậc volume (DEC-258): mỗi giờ một lần. */
let feeTiersAt = 0;
async function feeTierTick() {
  const now = Date.now();
  if (now - feeTiersAt < FEE_TIER_REFRESH_MS) return;
  const r = await refreshFeeTiers(db, now, (err, at) => {
    log.error({ err, ...at }, "builder fee tier failed");
  });
  // Lượt lỗi toàn bộ (ném lỗi) thì thử lại ở vòng 10 phút sau, không chờ cả giờ.
  feeTiersAt = now;
  if (r.changed > 0 || r.failed > 0) log.info(r, "builder fee tiers changed");
}

/** Retention snapshot (#229, #259): một lượt mỗi lần, lượt trước chưa xong thì bỏ qua. Mỗi lượt một `traceId`. */
let snapshotRetentionRunning = false;
async function snapshotRetentionTick() {
  if (snapshotRetentionRunning) return;
  snapshotRetentionRunning = true;
  const rlog = log.child({ traceId: randomUUID(), job: "snapshot-retention" });
  try {
    // Index của job tạo bằng CONCURRENTLY ở đây, không trong migration (review PR #257).
    const { indexes, ...r } = await runSnapshotRetention(db, Date.now());
    if (indexes.created.length > 0)
      rlog.info({ created: indexes.created }, "signal snapshot index created");
    if (indexes.dropped.length > 0)
      rlog.warn(
        { dropped: indexes.dropped },
        "invalid signal snapshot index dropped, rebuilt next run",
      );
    if (r.signals + r.quotes + r.contexts > 0) rlog.info(r, "old signal snapshots stripped");
  } catch (error: unknown) {
    rlog.error({ err: error }, "signal snapshot retention failed");
  } finally {
    snapshotRetentionRunning = false;
  }
}

// Signal research, lane tin tức (#271, DEC-322): paper trading của team, mặc định tắt. Không gửi gì tới
// SoDEX; giá chỉ từ marketdata (Redis md:last, NATS md.*.book, mm_market_hourly).
// Env của lane parse riêng: giá trị `SIGNAL_*` sai không bao giờ làm scheduler dừng.
const signalEnv = parseSignalEnv(process.env);
const signalOff =
  signalEnv.env === null
    ? `invalid env: ${signalEnv.warning ?? ""}`
    : disabledReason(signalEnv.env);
if (signalEnv.env !== null && signalEnv.warning !== null)
  log.warn({ warning: signalEnv.warning }, "signal research env");
const signals =
  signalOff === null && signalEnv.env !== null
    ? createSignalResearch({
        db,
        redis,
        log,
        env: signalEnv.env,
        perps: () => perpsCache,
        // #419: chuông `sr.signal.new` sau khi ghi `news_signals`; NATS chưa nối / lỗi thì engine vẫn đọc bảng mỗi nhịp.
        notifySignal: (id) => {
          if (nats === null) return;
          try {
            nats.publish(NEWS_SIGNAL_SUBJECT, JSON.stringify({ id }));
          } catch (error) {
            log.warn({ err: error, signalId: id }, "news signal: NATS publish failed");
          }
        },
        // #507: sổ lệnh REST một lần qua marketdata (lane không gọi SoDEX, DEC-322).
        requestBook: (market) =>
          requestRestBook(market, async (payload) => {
            if (nats === null) return "unavailable";
            try {
              const m = await nats.request(SR_BOOK_REQUEST_SUBJECT, payload, {
                timeout: SR_BOOK_REQUEST_TIMEOUT_MS,
              });
              return { reply: m.string() };
            } catch (error) {
              if (
                error instanceof TimeoutError ||
                (error instanceof Error && error.cause instanceof TimeoutError)
              )
                return "timeout";
              if (error instanceof RequestError && error.isNoResponders()) return "unavailable";
              throw error;
            }
          }),
      })
    : null;
if (signals !== null && signalEnv.env !== null) {
  log.info({ cycleMinutes: signalEnv.env.SIGNAL_NEWS_CYCLE_MINUTES }, "signal research enabled");
  const quota = monthlyLimitWarning(signalEnv.env);
  if (quota !== null) log.warn({ warning: quota }, "signal research env");
} else if (signalEnv.env === null || signalEnv.env.SIGNAL_RESEARCH_ENABLED)
  log.warn({ reason: signalOff }, "signal research not started");
let nats: NatsConnection | null = null;
if (signals !== null && env.NATS_URL !== "") {
  try {
    nats = await connect({ servers: env.NATS_URL });
    const sub = nats.subscribe("md.*.book");
    void (async () => {
      for await (const m of sub) signals.books.onMessage(m.subject, m.string(), Date.now());
    })();
  } catch (error) {
    log.warn({ err: error }, "signal research: NATS unavailable, using Redis prices only");
  }
}
let signalTimer: ReturnType<typeof setInterval> | null = null;
let watchTimer: ReturnType<typeof setInterval> | null = null;

let timer: ReturnType<typeof setInterval> | null = null;
let riskTimer: ReturnType<typeof setInterval> | null = null;
async function tick() {
  const today = utcDate(Date.now());
  const [{ n } = { n: 0 }] = await db
    .select({ n: count() })
    .from(marketStatsDaily)
    .where(eq(marketStatsDaily.date, today));
  if (n > 0) return;
  const result = await computeDailyStats({ db, rest, now: () => new Date(), wait });
  log.info({ date: today, ...result }, "market stats computed");
}

const stopLeader = runAsLeader(new Lease(redis, "lease:scheduler"), {
  onLead: () => {
    if (signals !== null) {
      // Danh sách market trước chu kỳ đầu (một lời gọi, dùng chung cache với mmModelTick); lỗi thì chu kỳ chỉ Collect.
      void loadPerps()
        .catch((error: unknown) => {
          log.warn({ err: error }, "signal research: SoDEX market list unavailable, collect only");
        })
        .then(() => signals.runCycle())
        .then(() => signals.runContextBackfill());
      // #394: chu kỳ từ `SIGNAL_NEWS_CYCLE_MINUTES` (1–5, mặc định 5; sai → 5 kèm cảnh báo lúc khởi động).
      signalTimer = scheduleNewsCycle(() => void signals.runCycle(), signals.cycleMinutes);
      watchTimer = setInterval(() => {
        void signals.watcher.tick().catch((error: unknown) => {
          log.error({ err: error }, "signal research watcher failed");
        });
      }, 1_500);
    }
    void tick().catch((error: unknown) => {
      log.error({ err: error }, "tick failed");
    });
    // Không đợi 10 phút đầu: tiến trình vừa nhận lease chạy (hoặc chạy tiếp) lượt leaderboard ngay nếu tới hạn.
    void leaderboardTick().catch((error: unknown) => {
      log.error({ err: error }, "leaderboard tick failed");
    });
    void feeTierTick().catch((error: unknown) => {
      log.error({ err: error }, "builder fee tiers failed");
    });
    riskTimer = setInterval(() => {
      // Theo dõi MCP (DEC-225): mỗi phút, cửa sổ 5 phút.
      void checkMcpAlerts(db, mcpAlertStore, Date.now())
        .then((sent) => {
          if (sent.length > 0) log.info({ sent }, "mcp alerts queued");
        })
        .catch((error: unknown) => {
          log.error({ err: error }, "mcp alerts failed");
        });
      // Sức khoẻ engine / SoDEX và tin tổng hợp ngày cho team (#241).
      void teamIncidents(Date.now())
        .then((sent) => {
          if (sent === null) log.warn("team incidents skipped: previous run still going");
          else if (sent.length > 0) log.info({ sent }, "team incidents queued");
        })
        .catch((error: unknown) => {
          log.error({ err: error }, "team incidents failed");
        });
      void invariantTick().catch((error: unknown) => {
        log.error({ err: error }, "prod invariants failed");
      });
      void riskTick()
        .then(revenueTick)
        .catch((error: unknown) => {
          log.error({ err: error }, "risk/revenue tick failed");
        });
    }, 60_000);
    timer = setInterval(() => {
      // Backfill ngữ cảnh tín hiệu cũ (#333): tự giới hạn một lượt mỗi ngày UTC.
      if (signals !== null) void signals.runContextBackfill();
      void tick().catch((error: unknown) => {
        log.error({ err: error }, "tick failed");
      });
      void purgeMcp(db, Date.now())
        .then((r) => {
          if (r.codes + r.clients + r.calls > 0) log.info(r, "old oauth / mcp rows deleted");
        })
        .catch((error: unknown) => {
          log.error({ err: error }, "mcp purge failed");
        });
      void purgeOldDeskAiChats(db, Date.now())
        .then((n) => {
          if (n > 0) log.info({ deleted: n }, "old desk ai chats deleted");
        })
        .catch((error: unknown) => {
          log.error({ err: error }, "desk ai purge failed");
        });
      void sweepStaleDeskJobs(db, Date.now())
        .then((r) => {
          if (r.whatifs + r.records > 0) log.warn(r, "stale desk jobs reset");
          return queueDueRecords(db, Date.now());
        })
        .then((n) => {
          if (n > 0) log.info({ queued: n }, "desk records queued");
        })
        .catch((error: unknown) => {
          log.error({ err: error }, "desk record tick failed");
        });
      void leaderboardTick().catch((error: unknown) => {
        log.error({ err: error }, "leaderboard tick failed");
      });
      void mmModelTick().catch((error: unknown) => {
        log.error({ err: error }, "mm cost model fit failed");
      });
      void snapshotRetentionTick().catch((error: unknown) => {
        log.error({ err: error }, "signal snapshot retention failed");
      });
      void feeTierTick().catch((error: unknown) => {
        log.error({ err: error }, "builder fee tiers failed");
      });
    }, 10 * 60_000);
  },
  onLose: () => {
    if (signalTimer !== null) clearInterval(signalTimer);
    if (watchTimer !== null) clearInterval(watchTimer);
    signalTimer = null;
    watchTimer = null;
    if (timer !== null) clearInterval(timer);
    if (riskTimer !== null) clearInterval(riskTimer);
    timer = null;
    riskTimer = null;
  },
});

async function shutdown() {
  await stopLeader();
  await nats?.drain().catch(() => undefined);
  await sodexCalls?.close();
  await pool.end();
  redis.disconnect();
}
process.once("SIGTERM", () => void shutdown());
process.once("SIGINT", () => void shutdown());
