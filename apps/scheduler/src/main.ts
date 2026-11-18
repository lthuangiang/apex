import {
  builderBalanceSnapshots,
  createDb,
  createSodexCallSink,
  leaderboardRuns,
  marketStatsDaily,
} from "@drift/db";
import { HyperliquidClient } from "@drift/hyperliquid";
import { Lease, runAsLeader } from "@drift/runtime";
import { AppError, ErrorCode } from "@drift/shared";
import {
  createSodexCallRecorder,
  loadSodexConfig,
  RedisRateLimitStore,
  SodexRestClient,
} from "@drift/sodex";
import { connect, type NatsConnection } from "@nats-io/transport-node";
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
  signalResearchEnvSchema,
  type PerpsSymbolInfo,
} from "./signal-research";
import { runSnapshotRetention } from "./snapshot-retention";
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
    /** Ví builder của DRIFT (đối soát builder revenue); trống thì bỏ qua đối soát. */
    DRIFT_BUILDER_ADDRESS: z
      .string()
      .regex(/^0x[0-9a-fA-F]{40}$/)
      .optional()
      .or(z.literal("").transform(() => undefined)),
    /** NATS cho giá tốt nhất SoDEX (`md.*.book`) của Signal research; trống = chỉ dùng Redis / DB. */
    NATS_URL: z.string().default(""),
  })
  .extend(signalResearchEnvSchema.shape)
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

let leaderboardBusy = false;
async function leaderboardTick() {
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
    if (r.status === "ok") await noteMinHoldChanges(db, utcDate(now), Date.now());
  } finally {
    leaderboardBusy = false;
  }
}

/** Fit hệ số mô hình chi phí Market Making cho ngày hôm qua (DEC-228); tự bỏ qua nếu đã fit. */
/** Danh sách perps đọc ở vòng 10 phút (mmModelTick); Signal research dùng lại, không gọi thêm REST. */
let perpsCache: PerpsSymbolInfo[] | null = null;
async function mmModelTick() {
  const symbols = await wait(() => rest.getPerpsSymbols());
  perpsCache = symbols.map((m) => ({
    name: m.name,
    status: m.status,
    tickSize: m.tickSize,
    takerFee: m.takerFee,
  }));
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

/** Retention snapshot (#229): một lượt mỗi lần, lượt trước chưa xong thì bỏ qua. */
let snapshotRetentionRunning = false;
async function snapshotRetentionTick() {
  if (snapshotRetentionRunning) return;
  snapshotRetentionRunning = true;
  try {
    // Index của job tạo bằng CONCURRENTLY ở đây, không trong migration (review PR #257).
    const { indexes, ...r } = await runSnapshotRetention(db, Date.now());
    if (indexes.created.length > 0)
      log.info({ created: indexes.created }, "signal snapshot index created");
    if (indexes.dropped.length > 0)
      log.warn(
        { dropped: indexes.dropped },
        "invalid signal snapshot index dropped, rebuilt next run",
      );
    if (r.signals + r.contexts > 0) log.info(r, "old signal snapshots stripped");
  } finally {
    snapshotRetentionRunning = false;
  }
}

// Signal research, lane tin tức (#271, DEC-TBD-news-paper-trading): paper trading của team, mặc định tắt. Không gửi gì tới
// SoDEX; giá chỉ từ marketdata (Redis md:last, NATS md.*.book, mm_market_hourly).
const signalOff = disabledReason(env);
const signals =
  signalOff === null
    ? createSignalResearch({ db, redis, log, env, perps: () => perpsCache })
    : null;
if (signalOff === null) log.info("signal research enabled");
else if (env.SIGNAL_RESEARCH_ENABLED)
  log.warn({ reason: signalOff }, "signal research not started");
let nats: NatsConnection | null = null;
if (signals !== null && env.NATS_URL !== "") {
  try {
    nats = await connect({ servers: env.NATS_URL });
    const sub = nats.subscribe("md.*.book");
    void (async () => {
      for await (const m of sub) signals.books.onMessage(m.string(), Date.now());
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
      void signals.runCycle();
      signalTimer = setInterval(() => void signals.runCycle(), 5 * 60_000);
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
