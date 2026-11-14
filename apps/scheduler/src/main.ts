import { builderBalanceSnapshots, createDb, leaderboardRuns, marketStatsDaily } from "@drift/db";
import { HyperliquidClient } from "@drift/hyperliquid";
import { Lease, runAsLeader } from "@drift/runtime";
import { AppError, ErrorCode } from "@drift/shared";
import { loadSodexConfig, RedisRateLimitStore, SodexRestClient } from "@drift/sodex";
import { count, eq } from "drizzle-orm";
import { Redis } from "ioredis";
import pino from "pino";
import { getAddress } from "viem";
import { z } from "zod";

import { reconcileDay, snapshotBuilderBalances } from "./builder-revenue";
import { purgeOldDeskAiChats, queueDueRecords, sweepStaleDeskJobs } from "./desk-record";
import { leaderboardDue, noteMinHoldChanges, runLeaderboard } from "./leaderboard";
import { computeDailyStats, utcDate } from "./market-stats";
import { checkMcpAlerts, redisAlertStore } from "./mcp-alerts";
import { purgeMcp } from "./mcp-purge";
import { fitMmModelDaily } from "./mm-model";
import { snapshotAndCheck } from "./risk";

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
  })
  .parse(process.env);
const log = pino({ level: env.LOG_LEVEL, base: { service: "scheduler" } });
const { db, pool } = createDb(env.DATABASE_URL);
const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 2 });
const mcpAlertStore = redisAlertStore(redis);
const rest = new SodexRestClient({
  config: loadSodexConfig(process.env),
  rateLimit: new RedisRateLimitStore(redis),
  egressKey: env.SODEX_EGRESS_KEY,
  priority: "background",
});
// Risk engine và đối soát: mức tương tác (an toàn tiền của người dùng), không bị job thống kê chặn.
const riskRest = new SodexRestClient({
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
async function mmModelTick() {
  const ticks = new Map(
    (await wait(() => rest.getPerpsSymbols())).map((m) => [m.name, m.tickSize] as const),
  );
  const r = await fitMmModelDaily(db, ticks, Date.now());
  if (r.status !== "skipped") log.info(r, "mm cost model fitted");
}

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
    void tick().catch((error: unknown) => {
      log.error({ err: error }, "tick failed");
    });
    // Không đợi 10 phút đầu: tiến trình vừa nhận lease chạy (hoặc chạy tiếp) lượt leaderboard ngay nếu tới hạn.
    void leaderboardTick().catch((error: unknown) => {
      log.error({ err: error }, "leaderboard tick failed");
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
    }, 10 * 60_000);
  },
  onLose: () => {
    if (timer !== null) clearInterval(timer);
    if (riskTimer !== null) clearInterval(riskTimer);
    timer = null;
    riskTimer = null;
  },
});

async function shutdown() {
  await stopLeader();
  await pool.end();
  redis.disconnect();
}
process.once("SIGTERM", () => void shutdown());
process.once("SIGINT", () => void shutdown());
